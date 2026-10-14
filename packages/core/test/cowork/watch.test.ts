import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { COWORK_RPC, COWORK_REMOTE_METHODS, CoworkWatchFrame, encodeLine, type CoworkWatchFrame as Frame } from "@yanlinglabs/winter-protocol";
import { openRuntimeStateDb, type RuntimeStateDb } from "../../src/runtime-state/db";
import { CoworkRepository } from "../../src/cowork/repository";
import { CoworkWorkspaceService, type CoworkHostPorts } from "../../src/cowork/service";
import { CoworkError } from "../../src/cowork/types";
const homes: string[] = [], dbs: RuntimeStateDb[] = [], services: CoworkWorkspaceService[] = [];
const ceiling = { toolClasses: ["read"], hostServices: [], connectors: [], network: "none" as const };
const selection = { kind: "githubRepository" as const, label: "Fixture", access: "read-write" as const, detail: { repositoryId: "PRIVATE_REPOSITORY", authorityRef: "PRIVATE_AUTHORITY", initialRef: "main" } };
const connection = { role: "harness", connectionId: 1 };
afterEach(() => { services.splice(0).forEach(s => s.close()); dbs.splice(0).forEach(db => db.close()); homes.splice(0).forEach(home => rmSync(home, { recursive: true, force: true })); });
function fixture(count = 1) {
  const home = mkdtempSync(join(tmpdir(), "winter-watch-store-")); homes.push(home);
  const db = openRuntimeStateDb(home); dbs.push(db); const records = new CoworkRepository(db);
  const ids = Array.from({ length: count }, (_, index) => records.create({ principalId: "local", requestId: `create-${index}` }, { ownership: "project", title: "Fixture", ceiling, sources: [selection] }).workspaceId);
  let principal: string | undefined = "local", mono = 0, wall = 10_000, blocked = false;
  const frames: Frame[] = [];
  const host: CoworkHostPorts = { principal: () => principal ? { kind: "local-user", id: principal } : undefined,
    grants: { folder: () => undefined, repository: () => ({ readable: true, writable: true, revoked: false }) },
    selection: () => selection, creationCeiling: () => ceiling, requireProvisioning: () => { throw new CoworkError("unsupported_topology"); } };
  const service = new CoworkWorkspaceService(records, host, undefined, undefined, undefined, { monotonicNow: () => mono, wallNow: () => wall, automaticMaintenance: false }); services.push(service);
  const sink = { send(frame: Frame): "sent" | "blocked" { if (blocked && frame.phase !== "ended") return "blocked"; frames.push(frame); return "sent"; } };
  const watch = (scope = ids, conn = connection) => service.watch(conn, { workspaceIds: scope }, sink);
  return { db, records, service, frames, host, ids, sink, watch, setPrincipal: (value?: string) => { principal = value; }, block: (value: boolean) => { blocked = value; }, clock: (value: number, date = wall) => { mono = value; wall = date; } };
}
const last = (frames: Frame[]) => frames.at(-1)!;
test("canonical safe snapshots, shared DB writers, concurrent Projects, no conversations or redaction leaks", () => {
  const f = fixture(2), lease = f.watch(); f.service.watches.flush();
  expect(lease.renewAfterMs).toBe(20_000); expect(lease.leaseExpiresAt).toBe(new Date(70_000).toISOString());
  expect(f.frames.map(frame => frame.phase)).toEqual(["snapshot", "snapshot"]);
  new CoworkRepository(f.db).updateTitle({ principalId: "local", requestId: "rename", expectedRevision: 1 }, f.ids[1]!, "Shared Project");
  f.service.watches.flush();
  expect(last(f.frames)).toMatchObject({ phase: "change", revisions: [{ workspaceId: f.ids[1], configRevision: 2, grantRevision: 1, instructionRevision: 1, leaseEpoch: 0 }] });
  expect(f.frames.map(frame => frame.seq)).toEqual([1, 2, 3]);
  for (const table of ["cowork_conversations", "cowork_outbox_deliveries"]) expect(f.db.db.query(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
  const wire = JSON.stringify(f.frames);
  for (const value of ["PRIVATE_REPOSITORY", "PRIVATE_AUTHORITY", "detail_json", "incarnationId", "$system", "sessionId"]) expect(wire).not.toContain(value);
});
test("source ACK/operation transitions hint even when configRevision is unchanged", () => {
  const f = fixture(); f.watch(); f.service.watches.flush(); f.frames.length = 0;
  const epoch = f.records.beginIncarnation(f.ids[0]!, "private-incarnation", 1); f.service.watches.flush();
  expect(last(f.frames).phase).toBe("change"); f.frames.length = 0;
  const source = f.records.sources(f.ids[0]!)[0]!;
  f.records.acknowledgeSource(epoch, source.sourceId, 1, "ready"); f.service.watches.flush();
  expect(last(f.frames)).toMatchObject({ phase: "change", revisions: [{ configRevision: 1 }] });
  expect(JSON.stringify(f.frames)).not.toContain("private-incarnation");
});
test("post-commit observer suppresses rollback/read and coalesces nested outer commit; listener cannot reject commit", () => {
  const f = fixture(); f.watch(); f.service.watches.flush(); f.frames.length = 0;
  let commits = 0; const off = f.db.onCommittedWrite(() => { commits++; });
  expect(() => f.db.transaction(() => { f.records.updateTitle({ principalId: "local", requestId: "rollback", expectedRevision: 1 }, f.ids[0]!, "Bad"); throw new Error("rollback"); })).toThrow("rollback");
  f.service.watches.flush(); expect(f.frames).toEqual([]); expect(commits).toBe(0); expect(f.records.get(f.ids[0]!).title).toBe("Fixture");
  f.db.transaction(() => f.records.get(f.ids[0]!)); expect(commits).toBe(0);
  f.db.transaction(() => f.records.updateTitle({ principalId: "local", requestId: "outer", expectedRevision: 1 }, f.ids[0]!, "Good"));
  expect(commits).toBe(1); f.service.watches.flush(); expect(last(f.frames).phase).toBe("change"); off();
  const throws = f.db.onCommittedWrite(() => { throw new Error("observer"); });
  expect(() => f.records.updateTitle({ principalId: "local", requestId: "observer", expectedRevision: 2 }, f.ids[0]!, "Committed")).not.toThrow();
  expect(f.records.get(f.ids[0]!).title).toBe("Committed"); throws();
});
test("every ID/current local principal is checked before enrollment; paired methods stay unavailable", () => {
  const f = fixture(); expect(() => f.watch([f.ids[0]!, "unknown"])).toThrow("not_found"); expect(f.service.watches.size).toBe(0);
  for (const role of ["remote", "plugin"]) expect(() => f.watch(f.ids, { role, connectionId: 2 })).toThrow("authority_denied");
  for (const method of ["workspace.watch", "workspace.watch.renew", "workspace.watch.detach"]) expect(COWORK_REMOTE_METHODS as readonly string[]).not.toContain(method);
  f.db.db.run("PRAGMA ignore_check_constraints=ON"); // corrupt legacy fixture only
  f.db.transaction(() => f.db.db.run("UPDATE cowork_workspaces SET ownership='unknown' WHERE workspace_id=?", f.ids));
  f.db.db.run("PRAGMA ignore_check_constraints=OFF");
  expect(() => f.watch()).toThrow("authority_denied"); expect(f.service.watches.size).toBe(0);
});
test("fixed32 IDs/four per connection, duplicate/forged input rejected; disconnect frees capacity", () => {
  const f = fixture(33); expect(() => f.watch()).toThrow(); expect(f.service.watches.size).toBe(0);
  expect(() => f.watch([f.ids[0]!, f.ids[0]!])).toThrow();
  expect(() => f.service.watch(connection, { workspaceIds: [f.ids[0]], principalId: "forged" }, f.sink)).toThrow();
  const accepted = Array.from({ length: 4 }, () => f.watch(f.ids.slice(0, 32)));
  expect(() => f.watch([f.ids[32]!])).toThrow("invalid_request");
  const other = f.watch([f.ids[32]!], { role: "admin", connectionId: 2 }); expect(other.subscriptionId).not.toBe(accepted[0]!.subscriptionId);
  f.service.closeConnection(1); expect(f.service.watches.size).toBe(1); f.watch([f.ids[32]!]); expect(f.service.watches.size).toBe(2);
});
test("monotonic60s lease, renewal20s, exact expiry cannot resurrect or move with wall clock", () => {
  const f = fixture(), lease = f.watch(); f.service.watches.flush(); f.clock(20_000, -100_000);
  const renewed = f.service.call(connection, "workspace.watch.renew", { subscriptionId: lease.subscriptionId });
  expect(renewed.renewAfterMs).toBe(20_000); expect(renewed.leaseExpiresAt).toBe(new Date(-40_000).toISOString());
  f.clock(79_999, -1_000_000); f.service.watches.maintain(); expect(f.service.watches.size).toBe(1);
  f.clock(80_000); f.service.watches.maintain(); expect(f.service.watches.size).toBe(0); expect(last(f.frames)).toMatchObject({ phase: "ended", reason: "expired" });
  expect(() => f.service.call(connection, "workspace.watch.renew", { subscriptionId: lease.subscriptionId })).toThrow("authority_denied");
});
test("connection/principal and reconnect generation binding; foreign renewal/detach leave original intact", () => {
  const f = fixture(), lease = f.watch(), next = { role: "harness", connectionId: 2 };
  for (const method of ["workspace.watch.renew", "workspace.watch.detach"] as const) expect(() => f.service.call(next, method, { subscriptionId: lease.subscriptionId })).toThrow("authority_denied");
  expect(f.service.watches.size).toBe(1);
  expect(() => f.service.call({ ...connection, role: "admin" }, "workspace.watch.renew", { subscriptionId: lease.subscriptionId })).toThrow("authority_denied");
  f.service.closeConnection(1); const fresh = f.watch(f.ids, next); expect(fresh.subscriptionId).not.toBe(lease.subscriptionId);
  expect(() => f.service.call(next, "workspace.watch.renew", { subscriptionId: lease.subscriptionId })).toThrow("authority_denied");
  f.service.watches.flush(); expect(last(f.frames)).toMatchObject({ phase: "snapshot", seq: 1 });
});
test("replacement/access revocation ends before delivery or renewal; same connection can still detach", () => {
  const f = fixture(); f.watch(); f.service.watches.flush(); f.frames.length = 0; f.setPrincipal("replacement");
  f.records.updateTitle({ principalId: "local", requestId: "private", expectedRevision: 1 }, f.ids[0]!, "Private Change"); f.service.watches.flush();
  expect(f.frames).toHaveLength(1); expect(last(f.frames)).toMatchObject({ phase: "ended", reason: "authority_revoked" }); expect(JSON.stringify(f.frames)).not.toContain("Private Change");
  f.setPrincipal("local"); const renewed = f.watch(); f.setPrincipal(undefined);
  expect(() => f.service.call(connection, "workspace.watch.renew", { subscriptionId: renewed.subscriptionId })).toThrow("authority_denied");
  expect(f.service.watches.size).toBe(0); expect(last(f.frames)).toMatchObject({ phase: "ended", reason: "authority_revoked" });
  f.setPrincipal("local"); const cleanup = f.watch(); f.setPrincipal(undefined);
  expect(f.service.call(connection, "workspace.watch.detach", { subscriptionId: cleanup.subscriptionId })).toEqual({ detached: true }); expect(last(f.frames)).toMatchObject({ phase: "ended", reason: "detached" });
});
test("one inaccessible workspace ends whole watch, never partial per-ID delivery", () => {
  const f = fixture(2); f.watch(); f.service.watches.flush(); f.frames.length = 0;
  f.db.transaction(() => f.db.db.run("UPDATE cowork_workspaces SET state='deleting' WHERE workspace_id=?", [f.ids[1]!])); f.service.watches.flush();
  expect(f.service.watches.size).toBe(0); expect(f.frames).toHaveLength(1); expect(last(f.frames)).toMatchObject({ phase: "ended", reason: "authority_revoked" });
});
test("blocked readers coalesce bounded hints, overflow requires refetch with current revisions", () => {
  const f = fixture(); f.watch(); f.service.watches.flush(); f.frames.length = 0; f.block(true);
  for (let index = 0; index < 129; index++) { f.records.updateTitle({ principalId: "local", requestId: `burst-${index}`, expectedRevision: index + 1 }, f.ids[0]!, `Title-${index}`); f.service.watches.flush(); }
  expect(f.frames).toEqual([]); f.block(false); f.service.watches.flush(); expect(f.frames).toHaveLength(1);
  expect(last(f.frames)).toMatchObject({ phase: "change", refetchRequired: true, revisions: [{ workspaceId: f.ids[0], configRevision: 130 }] });
  f.records.updateTitle({ principalId: "local", requestId: "after", expectedRevision: 130 }, f.ids[0]!, "After"); f.service.watches.flush(); expect(last(f.frames)).toMatchObject({ phase: "change", refetchRequired: false });
});
test("full encoded notification bound, valid schemas and shutdown cleanup", () => {
  const f = fixture(32); f.watch(); f.service.watches.flush();
  for (const frame of f.frames) { expect(CoworkWatchFrame.safeParse(frame).success).toBe(true); expect(encodeLine({ jsonrpc: "2.0", method: "workspace.watch", params: frame }).length).toBeLessThan(256 * 1024); }
  f.service.close(); expect(f.service.watches.size).toBe(0); expect(last(f.frames)).toMatchObject({ phase: "ended", reason: "shutdown" }); expect(() => f.watch()).toThrow("unsupported_topology");
  expect(COWORK_RPC["workspace.watch"].params.safeParse({ workspaceIds: [] }).success).toBe(false);
});
test("idle registry installs no commit observer and final release removes the observer", () => {
  const f = fixture();
  const original = f.db.onCommittedWrite.bind(f.db); let subscriptions = 0, releases = 0;
  f.db.onCommittedWrite = listener => { subscriptions++; const off = original(listener); return () => { releases++; off(); }; };
  expect(subscriptions).toBe(0);
  const one = f.watch(), two = f.watch(); expect(subscriptions).toBe(1);
  f.service.call(connection, "workspace.watch.detach", { subscriptionId: one.subscriptionId }); expect(releases).toBe(0);
  f.service.call(connection, "workspace.watch.detach", { subscriptionId: two.subscriptionId }); expect(releases).toBe(1);
  f.watch(); expect(subscriptions).toBe(2); f.service.close(); expect(releases).toBe(2);
});
test("legacy maximum JSON escaping/capabilities become explicit bounded snapshots", () => {
  const f = fixture(), workspaceId = f.ids[0]!;
  const names = Array.from({ length: 256 }, (_, index) => String(index).padStart(3, "0") + "\u0001".repeat(197));
  f.records.updatePolicy({ principalId: "local", requestId: "legacy-large", expectedRevision: 1 }, workspaceId,
    { ceiling: { toolClasses: names, hostServices: names, connectors: names, network: "none" } });
  f.records.updateTitle({ principalId: "local", requestId: "escaped", expectedRevision: 2 }, workspaceId, '"\\\u0001🦊'.repeat(39));
  f.watch(); f.service.watches.flush(); const frame = last(f.frames);
  expect(frame.phase).toBe("snapshot");
  if (frame.phase === "snapshot") {
    expect(frame.workspace.detailState).toBe("summary");
    if (frame.workspace.detailState === "summary") expect(frame.workspace.policySummary.capabilityCounts).toEqual({ toolClasses: 256, hostServices: 256, connectors: 256 });
  }
  expect(encodeLine({ jsonrpc: "2.0", method: "workspace.watch", params: frame }).length).toBeLessThan(256 * 1024);
});
