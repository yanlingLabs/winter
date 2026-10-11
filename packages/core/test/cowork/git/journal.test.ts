import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CoworkRepository } from "../../../src/cowork/repository";
import { CanonicalPublicationJournal } from "../../../src/cowork/git/journal";
import { openRuntimeStateDb, type RuntimeStateDb } from "../../../src/runtime-state/db";
import type { PublicationReceipt } from "../../../src/cowork/git/types";
const homes: string[] = [], dbs: RuntimeStateDb[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); for (const home of homes.splice(0)) rmSync(home, {recursive:true,force:true}); });
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "winter-git-journal-")); homes.push(home);
  const open = () => { const db = openRuntimeStateDb(home); dbs.push(db); return new CoworkRepository(db); };
  const records = open();
  const made = records.create({principalId:"user",requestId:"create"}, {ownership:"project",title:"Fixture",sources:[{kind:"githubRepository",label:"Repo",access:"read-write",detail:{repositoryId:"repo",authorityRef:"grant",initialRef:"main"}}],ceiling:{toolClasses:[],hostServices:[],connectors:[],network:"none"}});
  const workspaceId = made.workspaceId, journal = (ownerId = "host-a") => new CanonicalPublicationJournal(open(), workspaceId, ownerId);
  const key = JSON.stringify(["user", workspaceId, "request"]);
  const receipt: PublicationReceipt = {operationId:randomUUID(),digest:"a".repeat(64),status:"prepared",repositoryId:"repo",ref:"refs/heads/feature/task",oldOid:null,newOid:"1".repeat(40)};
  return {records,workspaceId,journal,key,receipt};
}
test("canonical Git claims compete across DB handles and survive restart with uncertain evidence", async () => {
  const f = fixture(), a = f.journal(), b = f.journal();
  const claims = await Promise.all([a.claim(f.key,f.receipt),b.claim(f.key,{...f.receipt,operationId:randomUUID()})]);
  expect(claims.filter(value => value.created)).toHaveLength(1);
  expect(claims[0]!.receipt).toEqual(claims[1]!.receipt);
  await a.transition(f.key,"prepared","dispatched"); await b.transition(f.key,"dispatched","uncertain");
  const restored = await f.journal().claim(f.key,{...f.receipt,operationId:randomUUID()});
  expect(restored.created).toBe(false); expect(restored.receipt.status).toBe("uncertain");
  await expect(a.transition(f.key,"uncertain","prepared")).rejects.toMatchObject({code:"request_conflict"});
  expect(f.records.operation(f.workspaceId,f.receipt.operationId)).toMatchObject({status:"blocked",terminal:false});
});
test("publication status and outbox commit atomically, duplicate transitions emit no second event", async () => {
  const f=fixture(), journal=f.journal(); await journal.claim(f.key,f.receipt);
  await journal.transition(f.key,"prepared","dispatched"); await journal.transition(f.key,"dispatched","applied"); await journal.transition(f.key,"dispatched","applied");
  const rows=f.records.rs.db.query<{payload_json:string},[string]>("SELECT payload_json FROM cowork_outbox WHERE operation_id=? ORDER BY sequence").all(f.receipt.operationId);
  expect(rows.map(row=>JSON.parse(row.payload_json).publicationStatus)).toEqual(["prepared","dispatched","applied"]);
  expect(f.records.operation(f.workspaceId,f.receipt.operationId)).toMatchObject({status:"applied",terminal:true});
  await expect(journal.transition(f.key,"prepared","rejected")).rejects.toMatchObject({code:"request_conflict"});
  await expect(journal.claim(JSON.stringify(["user","foreign","request"]),f.receipt)).rejects.toMatchObject({code:"invalid_request"});
});
test("explicit dead-owner recovery retires only unsent preparations; opening another handle is harmless", async () => {
  const f = fixture(), before = f.journal(); await before.claim(f.key, f.receipt);
  expect((await before.claim(f.key, { ...f.receipt, operationId: randomUUID() })).receipt.status).toBe("prepared");
  const otherLiveHandle = f.journal();
  expect((await otherLiveHandle.claim(f.key, { ...f.receipt, operationId: randomUUID() })).receipt.status).toBe("prepared");
  expect(await otherLiveHandle.recoverPrepared(async () => { throw new Error("own live owner cannot be recovery candidate"); })).toBe(0);
  const reopened = f.journal("host-b");
  expect(await reopened.recoverPrepared(async () => false)).toBe(0);
  await expect(reopened.transition(f.key, "prepared", "dispatched")).rejects.toMatchObject({ code: "request_conflict" });
  expect(await reopened.recoverPrepared(async candidate => {
    expect(candidate).toEqual({ workspaceId: f.workspaceId, operationId: f.receipt.operationId, ownerId: "host-a" });
    return true;
  })).toBe(1);
  expect((await reopened.claim(f.key, { ...f.receipt, operationId: randomUUID() })).receipt.status).toBe("rejected");
  await expect(before.transition(f.key, "prepared", "dispatched")).rejects.toMatchObject({ code: "request_conflict" });
  expect(f.records.operation(f.workspaceId, f.receipt.operationId)).toMatchObject({ status: "failed", terminal: true });
  const statuses = f.records.rs.db.query<{ payload_json: string }, [string]>("SELECT payload_json FROM cowork_outbox WHERE operation_id=? ORDER BY sequence").all(f.receipt.operationId);
  expect(statuses.map(row => JSON.parse(row.payload_json).publicationStatus)).toEqual(["prepared", "rejected"]);
  f.journal();
  expect(f.records.rs.db.query<{ n: number }, [string]>("SELECT count(*) AS n FROM cowork_outbox WHERE operation_id=?").get(f.receipt.operationId)?.n).toBe(2);
});

test("owner proof cannot retire an operation that dispatched while recovery awaited", async () => {
  const f = fixture(), live = f.journal(), recovery = f.journal("host-b");
  await live.claim(f.key, f.receipt);
  expect(await recovery.recoverPrepared(async () => {
    await live.transition(f.key, "prepared", "dispatched");
    return true;
  })).toBe(0);
  expect((await recovery.claim(f.key, f.receipt)).receipt.status).toBe("dispatched");
});
test("legacy preparations without owner evidence remain pending", async () => {
  const f = fixture(); await f.journal().claim(f.key, f.receipt);
  const row = f.records.rs.db.query<{result_json:string},[string]>("SELECT result_json FROM cowork_operations WHERE operation_id=?").get(f.receipt.operationId)!;
  const envelope = JSON.parse(row.result_json); delete envelope.preparationOwner;
  f.records.rs.db.run("UPDATE cowork_operations SET result_json=? WHERE operation_id=?", [JSON.stringify(envelope), f.receipt.operationId]);
  expect(await f.journal("host-b").recoverPrepared(async () => { throw new Error("unknown ownership is not termination proof"); })).toBe(0);
  expect((await f.journal("host-b").claim(f.key, f.receipt)).receipt.status).toBe("prepared");
});
