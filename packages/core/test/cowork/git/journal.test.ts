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
  const workspaceId = made.workspaceId, journal = () => new CanonicalPublicationJournal(open(), workspaceId);
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
