import { authorityFixtureSessions } from "./committed-sessions";
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as ts from "typescript";
import { openRuntimeStateDb, type RuntimeStateDb } from "../../src/runtime-state/db";
import { CoworkRepository } from "../../src/cowork/repository";
import { CoworkSchedules, nextCoworkScheduleTime } from "../../src/cowork/schedules";
import type { CoworkScheduleDispatchInput, CoworkScheduleDispatchOutcome, CoworkScheduleDispatchPort, CoworkScheduleStartResult } from "../../src/cowork/schedule-dispatch";
import type { CoworkScheduleDefinition } from "@yanlinglabs/winter-protocol";
const homes: string[] = [], handles: RuntimeStateDb[] = [];
const caps = { toolClasses: ["read", "write"], hostServices: [], connectors: [], network: "internet" as const };
afterEach(() => { handles.splice(0).forEach(db => db.close()); homes.splice(0).forEach(home => rmSync(home, { recursive: true, force: true })); });
type Fixture = ReturnType<typeof fixture>;
type Start = (input: CoworkScheduleDispatchInput, token: string) => CoworkScheduleStartResult | Promise<CoworkScheduleStartResult>;
const ack: Start = (input, token) => ({ kind: "started", receipt: { occurrenceId: input.occurrence.occurrenceId, token, runRef: "run-1" } });
const deferred = <T,>() => { let resolve!: (value: T) => void, reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
/** A counting fake port. It records what the DURABLE row looked like at the instant `start` ran, to prove dispatching is committed first and no transaction is open. */
function fakePort(db: RuntimeStateDb, start: Start = ack) {
  const calls: { token: string; inTransaction: boolean; state: string | undefined; claimToken: string | null | undefined; input: CoworkScheduleDispatchInput }[] = [];
  const port: CoworkScheduleDispatchPort = { start(input, token) {
    const row = db.db.query("SELECT state,claim_token FROM cowork_schedule_occurrences WHERE occurrence_id=?").get(input.occurrence.occurrenceId) as { state: string; claim_token: string | null } | null;
    calls.push({ token, inTransaction: db.db.inTransaction, state: row?.state, claimToken: row?.claim_token, input }); return start(input, token);
  } };
  return { port, calls };
}
const forgedReceipt = (occurrenceId: string) => ({ occurrenceId, runRef: "forged" });
const receiptOf = (out: CoworkScheduleDispatchOutcome) => { if (out.status !== "started") throw new Error(`expected started, got ${out.status}`); return out.receipt; };
/** One due occurrence (recurring `every 1s` unless a definition is given), materialized at t=1000. */
function due(f: Fixture, definition = f.definition) {
  const a = f.create(definition); f.time(1000); f.schedules.tick();
  return { a, row: f.schedules.status(a.workspaceId, a.scheduleId).occurrences[0]! };
}
const durable = (f: Fixture, occurrenceId: string) => f.db.db.query("SELECT state,reason,claim_token FROM cowork_schedule_occurrences WHERE occurrence_id=?").get(occurrenceId) as { state: string; reason: string | null; claim_token: string | null };
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "winter-schedules-")); homes.push(home);
  const db = openRuntimeStateDb(home); handles.push(db); const records = new CoworkRepository(db);
  const made = records.create({ principalId: "fixture", requestId: "workspace" }, { ownership: "project", title: "Fixture", ceiling: caps, sources: [{ kind: "folder", label: "fixture", access: "read-write", detail: { grantRef: "fixture-grant", rootIdentity: "fixture-root" } }] });
  let time = 0, revoked = false, branch = "feature/example";
  const grants = { folder: () => ({ rootIdentity: "fixture-root", writable: true, revoked }), repository: () => undefined };
  const schedules = new CoworkSchedules(records, grants, () => time, () => branch);
  const definition: CoworkScheduleDefinition = { target: { kind: "project", projectId: made.value.workspace.ownerId }, sourceId: made.value.sources[0]!.sourceId, prompt: "fixture work", timing: { kind: "recurring", spec: "every 1s" }, timezone: "UTC", savedCeiling: caps, policy: "auto", overlap: "one-active-one-pending" };
  const create = (input = definition, request = "schedule") => schedules.create("fixture", made.workspaceId, request, input);
  // A scheduler over the same file with an injected dispatch port: on this handle, or on an independent second handle.
  const open = (port?: CoworkScheduleDispatchPort, handle: RuntimeStateDb = db) => new CoworkSchedules(handle === db ? records : new CoworkRepository(handle), grants, () => time, () => branch, undefined, port);
  const peer = (port?: CoworkScheduleDispatchPort) => { const second = openRuntimeStateDb(home); handles.push(second); return { db: second, schedules: open(port, second) }; };
  return { home, db, records, schedules, grants, made, definition, create, open, peer, time: (value: number) => { time = value; }, revoke: () => { revoked = true; }, branch: (value: string) => { branch = value; } };
}
test("metadata acceptance is idempotent and rejects substituted content, foreign targets and escalations", () => {
  const f = fixture(), a = f.create(); expect(f.create()).toEqual(a);
  expect(() => f.create({ ...f.definition, prompt: "substituted" })).toThrow("request_conflict");
  expect(() => f.create({ ...f.definition, target: { kind: "project", projectId: "foreign" } }, "bad")).toThrow("authority_denied");
  expect(() => f.create({ ...f.definition, savedCeiling: { ...caps, toolClasses: ["admin"] } }, "broad")).toThrow("authority_denied");
  expect(() => f.create({ ...f.definition, policy: "bypass" }, "policy")).toThrow("authority_denied"); expect(f.db.integrity().ok).toBe(true);
});
test("SQLite duplicate claims from independent handles cannot launch twice", () => {
  const f = fixture(), a = f.create(); f.time(1000); f.schedules.tick(); const row = f.schedules.status(a.workspaceId, a.scheduleId).occurrences[0]!;
  const db = openRuntimeStateDb(f.home); handles.push(db); const second = new CoworkSchedules(new CoworkRepository(db), f.grants);
  expect(f.schedules.claim(a.workspaceId, a.scheduleId, row.occurrenceId)).toBeString(); expect(second.claim(a.workspaceId, a.scheduleId, row.occurrenceId)).toBeUndefined();
});
test("missed intervals retain one active and one coalesced pending with visible counts", () => {
  const f = fixture(), a = f.create(); f.time(1000); f.schedules.tick(); const row = f.schedules.status(a.workspaceId, a.scheduleId).occurrences[0]!;
  f.schedules.claim(a.workspaceId, a.scheduleId, row.occurrenceId); f.time(10000); f.schedules.tick(); f.time(12000); f.schedules.tick();
  const rows = f.schedules.status(a.workspaceId, a.scheduleId).occurrences; expect(rows).toHaveLength(2); const pending = rows.find(value => value.state === "pending")!;
  expect(pending.latestDueAt).toBe(12000); expect(pending.missedCount).toBe(10); expect(f.schedules.claim(a.workspaceId, a.scheduleId, pending.occurrenceId)).toBeUndefined();
});
test("restart recovers a pre-dispatch claim and never replays dispatched uncertainty", () => {
  const f = fixture(), a = f.create(); f.time(1000); f.schedules.tick(); const first = f.schedules.status(a.workspaceId, a.scheduleId).occurrences[0]!;
  f.schedules.claim(a.workspaceId, a.scheduleId, first.occurrenceId); f.time(3000); f.schedules.tick();
  const db = openRuntimeStateDb(f.home); handles.push(db); const restored = new CoworkSchedules(new CoworkRepository(db), f.grants, () => 3000); restored.recover();
  let rows = restored.status(a.workspaceId, a.scheduleId).occurrences; expect(rows).toHaveLength(1); expect(rows[0]!.state).toBe("pending"); expect(rows[0]!.missedCount).toBe(2);
  const token = restored.claim(a.workspaceId, a.scheduleId, first.occurrenceId)!; expect(() => restored.beginDispatch(first.occurrenceId, token)).toThrow("unsupported_topology");
  // The dispatch boundary now exists only behind an injected port: a port that never answers leaves `dispatching` durable.
  const hung = fakePort(db, () => new Promise<CoworkScheduleStartResult>(() => {})); void f.open(hung.port, db).beginDispatch(first.occurrenceId, token);
  expect(hung.calls).toHaveLength(1); expect(restored.status(a.workspaceId, a.scheduleId).occurrences[0]!.state).toBe("dispatching"); restored.recover();
  rows = restored.status(a.workspaceId, a.scheduleId).occurrences; expect(rows[0]!.state).toBe("uncertain"); expect(rows[0]!.reason).toBe("recovery_required"); expect(restored.claim(a.workspaceId, a.scheduleId, first.occurrenceId)).toBeUndefined();
});
test("one-shots remain pending after restart until a dispatched completion receipt", async () => {
  const f = fixture(), a = f.create({ ...f.definition, timing: { kind: "once", at: 1000 } }); f.time(5000); f.schedules.tick();
  const restored = new CoworkSchedules(f.records, f.grants, () => 10000); restored.recover(); restored.tick(); const row = restored.status(a.workspaceId, a.scheduleId).occurrences[0]!;
  expect(row.state).toBe("pending"); expect(row.reason).toBe("execution_unavailable"); expect(restored.get(a.workspaceId, a.scheduleId).state).toBe("enabled");
  const token = restored.claim(a.workspaceId, a.scheduleId, row.occurrenceId)!; expect(() => restored.handled(row.occurrenceId, token, forgedReceipt(row.occurrenceId))).toThrow("request_conflict");
  expect(() => restored.beginDispatch(row.occurrenceId, token)).toThrow("unsupported_topology");
  const dispatched = f.open(fakePort(f.db).port), out = await dispatched.beginDispatch(row.occurrenceId, token);
  expect(restored.get(a.workspaceId, a.scheduleId).state).toBe("enabled"); dispatched.handled(row.occurrenceId, token, receiptOf(out)); expect(restored.get(a.workspaceId, a.scheduleId).state).toBe("handled");
});
test("archive, grants, branch precondition and unavailable execution block without Code sessions", () => {
  const f = fixture(), a = f.create({ ...f.definition, branchPrecondition: "feature/example" }); f.time(1000); f.schedules.tick();
  const reason = () => f.schedules.status(a.workspaceId, a.scheduleId).occurrences[0]!.reason;
  expect(reason()).toBe("execution_unavailable"); f.branch("main"); f.schedules.tick(); expect(reason()).toBe("branch_mismatch");
  f.branch("feature/example"); f.db.db.run("UPDATE cowork_workspaces SET state='archived' WHERE workspace_id=?", [a.workspaceId]); f.schedules.tick(); expect(reason()).toBe("archived");
  f.db.db.run("UPDATE cowork_workspaces SET state='retained' WHERE workspace_id=?", [a.workspaceId]); f.revoke(); f.schedules.tick(); expect(reason()).toBe("authority_denied");
  expect(f.db.db.query("SELECT count(*) AS n FROM cowork_conversations").get()).toEqual({ n: 0 }); expect(() => f.create()).toThrow("authority_denied");
});
test("saved narrower ceiling intersects current grants and revoked source blocks", () => {
  const f = fixture(), a = f.create({ ...f.definition, savedCeiling: { ...caps, toolClasses: ["read"], network: "none" } }); expect(f.schedules.effective(a.workspaceId, a.scheduleId)).toEqual(a.definition.savedCeiling);
  f.records.updatePolicy({ principalId: "fixture", requestId: "narrow", expectedRevision: 1 }, a.workspaceId, { ceiling: { ...caps, toolClasses: [], network: "none" } }); expect(f.schedules.effective(a.workspaceId, a.scheduleId).toolClasses).toEqual([]);
  f.records.removeSource({ principalId: "fixture", requestId: "revoke", expectedRevision: 2 }, a.workspaceId, a.definition.sourceId, true); f.time(1000); f.schedules.tick(); expect(f.schedules.status(a.workspaceId, a.scheduleId).occurrences[0]!.reason).toBe("source_unavailable");
});
test("shutdown closes new occurrences and claims; cancellation persists", () => {
  const f = fixture(), a = f.create(); f.time(1000); f.schedules.tick(); const row = f.schedules.status(a.workspaceId, a.scheduleId).occurrences[0]!; f.schedules.beginShutdown();
  expect(f.schedules.claim(a.workspaceId, a.scheduleId, row.occurrenceId)).toBeUndefined(); f.time(100000); f.schedules.tick(); expect(f.schedules.status(a.workspaceId, a.scheduleId).occurrences[0]).toEqual(row);
  expect(() => f.create(f.definition, "later")).toThrow("authority_denied"); f.schedules.cancel(a.workspaceId, a.scheduleId, 1); expect(f.schedules.status(a.workspaceId, a.scheduleId).occurrences[0]!.state).toBe("cancelled");
});
test("saved timezone cron honors DST gaps and folds", () => {
  expect(nextCoworkScheduleTime("0 9 * * *", "Asia/Tokyo", Date.parse("2026-10-14T00:00:00Z"))).toBe(Date.parse("2026-10-15T00:00:00Z"));
  expect(nextCoworkScheduleTime("30 2 * * *", "America/New_York", Date.parse("2026-03-08T05:00:00Z"))).toBe(Date.parse("2026-03-09T06:30:00Z"));
  expect(nextCoworkScheduleTime("30 1 * * *", "America/New_York", Date.parse("2026-11-01T05:30:00Z"))).toBe(Date.parse("2026-11-02T06:30:00Z"));
});
test("conversation targets retain existing standalone identity and pause on archive or policy change", () => {
  const f = fixture();
  const epoch = f.records.beginIncarnation(f.made.workspaceId, "fixture-epoch", 1);
  f.records.acknowledgeSource(epoch, f.definition.sourceId, 1, "ready");
  f.records.bindConversation({ principalId: "fixture", requestId: "binding", expectedRevision: 1 }, f.made.workspaceId, { sessionId: "fixture-conversation", sourceId: f.definition.sourceId }, authorityFixtureSessions("fixture-conversation"));
  const a = f.create({ ...f.definition, target: { kind: "conversation", sessionId: "fixture-conversation" } });
  f.time(1000); f.schedules.tick(); const row = f.schedules.status(a.workspaceId, a.scheduleId).occurrences[0]!;
  f.db.db.run("UPDATE cowork_conversations SET state='archived' WHERE session_id='fixture-conversation'"); f.schedules.tick();
  expect(f.schedules.status(a.workspaceId, a.scheduleId).occurrences[0]!.reason).toBe("archived"); expect(f.schedules.claim(a.workspaceId, a.scheduleId, row.occurrenceId)).toBeUndefined();
  f.db.db.run("UPDATE cowork_conversations SET state='active',policy='plan' WHERE session_id='fixture-conversation'"); f.schedules.tick();
  expect(f.schedules.status(a.workspaceId, a.scheduleId).occurrences[0]!.reason).toBe("authority_denied");
  const standalone = f.records.create({ principalId: "fixture", requestId: "standalone" }, { ownership: "standalone", title: "Standalone", sources: [{ kind: "folder", label: "Fixture", access: "read-write", detail: { grantRef: "fixture-grant", rootIdentity: "fixture-root" } }], ceiling: caps });
  const source = standalone.value.sources[0]!; const own = f.records.beginIncarnation(standalone.workspaceId, "standalone-epoch", 1); f.records.acknowledgeSource(own, source.sourceId, 1, "ready");
  f.records.bindConversation({ principalId: "fixture", requestId: "own-binding", expectedRevision: 1 }, standalone.workspaceId, { sessionId: standalone.value.workspace.ownerId, sourceId: source.sourceId }, authorityFixtureSessions(standalone.value.workspace.ownerId));
  const created = f.schedules.create("fixture", standalone.workspaceId, "own-schedule", { ...f.definition, sourceId: source.sourceId, target: { kind: "conversation", sessionId: standalone.value.workspace.ownerId } });
  expect(created.definition.target).toEqual({ kind: "conversation", sessionId: standalone.value.workspace.ownerId });
  expect(() => f.schedules.create("fixture", standalone.workspaceId, "project-fresh", { ...created.definition, target: { kind: "project", projectId: standalone.value.workspace.ownerId } })).toThrow("authority_denied");
});
test("accepted bypass policy is saved unchanged and never invents prompts or warning modes", () => {
  const f = fixture(); f.records.updatePolicy({ principalId: "fixture", requestId: "bypass", expectedRevision: 1 }, f.made.workspaceId, { defaultPolicy: "bypass" });
  const a = f.create({ ...f.definition, policy: "bypass" }); f.time(1000); f.schedules.tick();
  expect(a.definition.policy).toBe("bypass"); expect(f.schedules.status(a.workspaceId, a.scheduleId).occurrences[0]!.reason).toBe("execution_unavailable");
});
test("schema11 upgrade adds empty schedule authority and preserves existing workspace identity", () => {
  const f = fixture(), identity = f.records.homeIdentity();
  f.db.db.run("DROP TABLE cowork_schedule_occurrences"); f.db.db.run("DROP TABLE cowork_schedules"); f.db.db.run("PRAGMA user_version=11");
  f.db.close(); handles.splice(handles.indexOf(f.db), 1);
  const db = openRuntimeStateDb(f.home); handles.push(db); const records = new CoworkRepository(db), schedules = new CoworkSchedules(records, f.grants);
  expect(records.homeIdentity()).toBe(identity); expect(records.get(f.made.workspaceId)).toEqual(f.made.value.workspace); expect(schedules.list(f.made.workspaceId).schedules).toEqual([]); expect(db.integrity().ok).toBe(true);
});
test("DST daily and minute patterns do not repeat a local date/hour/minute after fallback", () => {
  expect(nextCoworkScheduleTime("30 1 * * *", "America/New_York", Date.parse("2026-11-01T05:30:00Z"))).toBe(Date.parse("2026-11-02T06:30:00Z"));
  expect(nextCoworkScheduleTime("* * * * *", "America/New_York", Date.parse("2026-11-01T05:58:00Z"))).toBe(Date.parse("2026-11-01T05:59:00Z"));
  expect(nextCoworkScheduleTime("* * * * *", "America/New_York", Date.parse("2026-11-01T05:59:00Z"))).toBe(Date.parse("2026-11-01T07:00:00Z"));
  expect(nextCoworkScheduleTime("*/15 1 * * *", "America/New_York", Date.parse("2026-11-01T05:30:00Z"))).toBe(Date.parse("2026-11-01T05:45:00Z"));
  expect(nextCoworkScheduleTime("*/15 1 * * *", "America/New_York", Date.parse("2026-11-01T05:45:00Z"))).toBe(Date.parse("2026-11-02T06:00:00Z"));
});
test("sparse cron search stays bounded and impossible calendar/TZ specs fail cheaply", () => {
  let formats = 0;
  expect(nextCoworkScheduleTime("0 0 29 2 *", "America/New_York", Date.parse("2096-03-01T00:00:00Z"), () => { formats++; })).toBe(Date.parse("2104-02-29T05:00:00Z"));
  expect(formats).toBeLessThan(1000);
  let invalidFormats = 0;
  expect(() => nextCoworkScheduleTime("0 0 30 2 *", "UTC", 0, () => { invalidFormats++; })).toThrow("invalid_request"); expect(invalidFormats).toBe(0);
  expect(() => nextCoworkScheduleTime("0 0 * * *", "Invalid/Timezone", 0)).toThrow("invalid_request");
  expect(() => nextCoworkScheduleTime("every 999999999999999999999d", "UTC", 0)).toThrow("invalid_request");
});
test("poisoned JSON, spec and timezone are individually quarantined while healthy timers advance", () => {
  const f = fixture(), healthy = f.create();
  const poisoned = [f.create(f.definition, "json-poison"), f.create(f.definition, "spec-poison"), f.create(f.definition, "tz-poison")];
  const values = ["{bad-json", JSON.stringify({ ...f.definition, timing: { kind: "recurring", spec: "not a cron" } }), JSON.stringify({ ...f.definition, timezone: "Invalid/Timezone" })];
  poisoned.forEach((value, index) => f.db.db.run("UPDATE cowork_schedules SET definition_json=? WHERE schedule_id=?", [values[index]!, value.scheduleId]));
  f.time(5000); f.schedules.tick();
  const normal = f.schedules.status(healthy.workspaceId, healthy.scheduleId); expect(normal.occurrences).toHaveLength(1); expect(normal.occurrences[0]!.missedCount).toBe(4); expect(normal.schedule.nextDue).toBe(6000);
  poisoned.forEach((value, index) => {
    const result = f.schedules.status(value.workspaceId, value.scheduleId); expect(result.schedule).toMatchObject({ state: "quarantined", reason: "invalid_schedule", nextDue: null });
    expect("definition" in result.schedule).toBe(false); expect(f.db.db.query("SELECT definition_json FROM cowork_schedules WHERE schedule_id=?").get(value.scheduleId)).toEqual({ definition_json: values[index] });
    expect(f.schedules.claim(value.workspaceId, value.scheduleId, "unknown-occurrence")).toBeUndefined();
  });
  expect(f.schedules.list(healthy.workspaceId).schedules).toHaveLength(4);
  f.time(8000); f.schedules.tick(); expect(f.schedules.status(healthy.workspaceId, healthy.scheduleId).occurrences[0]!.missedCount).toBe(7);
  expect(f.db.db.query("SELECT count(*) AS n FROM cowork_schedule_quarantines").get()).toEqual({ n: 3 }); expect(f.db.integrity().ok).toBe(true);
});
test("restart merging retains both previously coalesced missed counts and one pending first occurrence", () => {
  const f = fixture(), a = f.create(); f.time(5000); f.schedules.tick(); const first = f.schedules.status(a.workspaceId, a.scheduleId).occurrences[0]!; expect(first.missedCount).toBe(4);
  f.schedules.claim(a.workspaceId, a.scheduleId, first.occurrenceId); f.time(9000); f.schedules.tick();
  expect(f.schedules.status(a.workspaceId, a.scheduleId).occurrences.find(value => value.state === "pending")!.missedCount).toBe(3);
  f.schedules.recover(); const merged = f.schedules.status(a.workspaceId, a.scheduleId).occurrences;
  expect(merged).toHaveLength(1); expect(merged[0]!.missedCount).toBe(8); expect(merged[0]!.latestDueAt).toBe(9000);
});
test("clock reversal, invalid timezone, oversized metadata and cursor fail without disturbing valid records", () => {
  const f = fixture(), a = f.create(); f.time(5000); f.schedules.tick(); const before = f.schedules.status(a.workspaceId, a.scheduleId);
  f.time(1000); f.schedules.tick(); expect(f.schedules.status(a.workspaceId, a.scheduleId)).toEqual(before);
  expect(() => f.create({ ...f.definition, timezone: "Invalid/Timezone" }, "tz")).toThrow("invalid_request");
  expect(() => f.create({ ...f.definition, savedCeiling: { ...caps, toolClasses: Array.from({ length: 256 }, (_v, i) => `${i}-` + "x".repeat(180)) } }, "large")).toThrow("response_too_large");
  expect(() => f.schedules.list(a.workspaceId, "not-a-cursor")).toThrow("not_found"); expect(f.schedules.list(a.workspaceId).schedules).toHaveLength(1);
});
test("workspace schedule count cap accepts exact replays but prevents an unbounded timer population", () => {
  const f = fixture(); let first: ReturnType<typeof f.create> | undefined;
  for (let i = 0; i < 100; i++) { const value = f.create(f.definition, `bounded-${i}`); if (i === 0) first = value; }
  expect(() => f.create(f.definition, "overflow")).toThrow("schedule_limit"); expect(f.create(f.definition, "bounded-0")).toEqual(first!);
  expect(f.schedules.list(f.made.workspaceId).schedules).toHaveLength(100);
});
test("cancel on a second handle after due snapshot cannot materialize the cancelled occurrence", () => {
  const f = fixture(), a = f.create(), db = openRuntimeStateDb(f.home); handles.push(db); const other = new CoworkSchedules(new CoworkRepository(db), f.grants);
  // Inject only the snapshot interleaving; use actual SQLite cancellation on the other handle.
  const originalQuery = f.db.db.query.bind(f.db.db); let cancelled = false;
  f.db.db.query = ((sql: string) => {
    const statement = originalQuery(sql);
    if (sql.startsWith("SELECT * FROM cowork_schedules s WHERE state='enabled'")) {
      const all = statement.all.bind(statement);
      statement.all = ((...values: any[]) => { const rows = all(...values); if (!cancelled) { cancelled = true; other.cancel(a.workspaceId, a.scheduleId, 1); } return rows; }) as any;
    }
    return statement;
  }) as any;
  f.time(1000); f.schedules.tick(); expect(f.schedules.status(a.workspaceId, a.scheduleId).occurrences).toEqual([]); expect(f.schedules.get(a.workspaceId, a.scheduleId).state).toBe("cancelled");
});
test("cancelled schedules free live capacity while terminal metadata stays readable", () => {
  const f = fixture(), live: ReturnType<typeof f.create>[] = [];
  for (let i = 0; i < 100; i++) live.push(f.create(f.definition, `live-${i}`));
  expect(() => f.create(f.definition, "full")).toThrow("schedule_limit");
  const first = live[0]!; f.schedules.cancel(first.workspaceId, first.scheduleId, 1);
  const replacement = f.create(f.definition, "replacement"); expect(replacement.state).toBe("enabled");
  expect(f.schedules.status(first.workspaceId, first.scheduleId).schedule.state).toBe("cancelled");
  expect(f.schedules.create("fixture", first.workspaceId, "live-0", f.definition).state).toBe("cancelled");
  expect(f.db.db.query("SELECT count(*) AS n FROM cowork_schedules WHERE workspace_id=?").get(first.workspaceId)).toEqual({ n: 101 });
  expect(() => f.create(f.definition, "full-again")).toThrow("schedule_limit");
});
test("one shared calendar budget bounds all jobs and planning never holds a write transaction", () => {
  const f = fixture(), a = f.create({ ...f.definition, timing: { kind: "recurring", spec: "* * * * *" } }, "cron-a"), b = f.create({ ...f.definition, timing: { kind: "recurring", spec: "* * * * *" } }, "cron-b");
  let formats = 0;
  const bounded = new CoworkSchedules(f.records, f.grants, () => 600000, undefined, { steps: 3, formats: 6, observeFormat: () => { formats++; expect(f.db.db.inTransaction).toBe(false); } });
  const total = () => [a, b].flatMap(value => bounded.status(value.workspaceId, value.scheduleId).occurrences).reduce((sum, value) => sum + value.missedCount + 1, 0);
  bounded.tick(); expect(formats).toBe(6); expect(total()).toBe(3); expect(f.db.db.query("SELECT count(*) AS n FROM cowork_schedule_quarantines").get()).toEqual({ n: 0 });
  formats = 0; bounded.tick(); expect(formats).toBe(6); expect(total()).toBe(6);
  // Oldest durable cursors naturally give the second job the next pass's admission.
  expect(bounded.get(a.workspaceId, a.scheduleId).nextDue).toBe(240000); expect(bounded.get(b.workspaceId, b.scheduleId).nextDue).toBe(240000);
});
test("calendar budget debt remains retryable and catch-up progress is durable without duplicate counts", () => {
  const f = fixture(), a = f.create({ ...f.definition, timing: { kind: "recurring", spec: "* * * * *" } });
  const tiny = new CoworkSchedules(f.records, f.grants, () => 60000000, undefined, { steps: 1, formats: 1 });
  tiny.tick(); expect(tiny.get(a.workspaceId, a.scheduleId).nextDue).toBe(60000); expect(tiny.status(a.workspaceId, a.scheduleId).occurrences).toEqual([]);
  expect(f.db.db.query("SELECT count(*) AS n FROM cowork_schedule_quarantines").get()).toEqual({ n: 0 });
  const normal = new CoworkSchedules(f.records, f.grants, () => 60000000);
  normal.tick(); expect(normal.status(a.workspaceId, a.scheduleId).occurrences[0]!.missedCount).toBe(255); expect(normal.get(a.workspaceId, a.scheduleId).nextDue).toBe(257 * 60000);
  const db = openRuntimeStateDb(f.home); handles.push(db); const restored = new CoworkSchedules(new CoworkRepository(db), f.grants, () => 60000000);
  restored.recover(); restored.tick(); expect(restored.status(a.workspaceId, a.scheduleId).occurrences[0]!.missedCount).toBe(511);
  restored.tick(); restored.tick(); const row = restored.status(a.workspaceId, a.scheduleId).occurrences[0]!;
  expect(row.missedCount).toBe(999); expect(row.latestDueAt).toBe(60000000); expect(restored.get(a.workspaceId, a.scheduleId).nextDue).toBe(60060000);
});
test("read-only inspection of an unknown poisoned row cannot claim durable quarantine", () => {
  const f = fixture(), a = f.create(); f.db.db.run("UPDATE cowork_schedules SET definition_json='{poison' WHERE schedule_id=?", [a.scheduleId]);
  const readonly = openRuntimeStateDb(f.home, { readonly: true }); handles.push(readonly); const audit = new CoworkSchedules(new CoworkRepository(readonly), f.grants);
  expect(() => audit.status(a.workspaceId, a.scheduleId)).toThrow();
  expect(f.db.db.query("SELECT count(*) AS n FROM cowork_schedule_quarantines").get()).toEqual({ n: 0 });
  expect(f.db.db.query("SELECT definition_json FROM cowork_schedules WHERE schedule_id=?").get(a.scheduleId)).toEqual({ definition_json: "{poison" });
});
test("overflowed persisted interval is invalid data and cannot starve healthy work", () => {
  const f = fixture(), healthy = f.create(), poison = f.create(f.definition, "overflow-poison");
  f.db.db.run("UPDATE cowork_schedules SET definition_json=? WHERE schedule_id=?", [JSON.stringify({ ...f.definition, timing: { kind: "recurring", spec: "every 999999999999999999999d" } }), poison.scheduleId]);
  f.time(5000); f.schedules.tick();
  expect(f.schedules.status(poison.workspaceId, poison.scheduleId).schedule.state).toBe("quarantined");
  expect(f.schedules.status(healthy.workspaceId, healthy.scheduleId).occurrences[0]!.missedCount).toBe(4);
});

// ------------------------------------------------------------------ dispatch boundary behind an injected port
test("without a port beginDispatch refuses before any write, handled cannot be forged and the RPC literal stays unavailable", () => {
  const f = fixture(), { a, row } = due(f), token = f.schedules.claim(a.workspaceId, a.scheduleId, row.occurrenceId)!;
  expect(() => f.schedules.beginDispatch(row.occurrenceId, token)).toThrow("unsupported_topology"); expect(() => f.schedules.beginDispatch("unknown", "garbage")).toThrow("unsupported_topology");
  expect(durable(f, row.occurrenceId)).toEqual({ state: "claimed", reason: null, claim_token: token });
  expect(() => f.schedules.handled(row.occurrenceId, token, forgedReceipt(row.occurrenceId))).toThrow("request_conflict"); expect(() => f.schedules.uncertain(row.occurrenceId, token)).toThrow("request_conflict");
  expect(durable(f, row.occurrenceId).state).toBe("claimed"); expect(f.schedules.status(a.workspaceId, a.scheduleId).execution).toBe("unavailable");
});
test("dispatching is durable before the port runs, no transaction is open across it, and the ack alone does not mark anything handled", async () => {
  const f = fixture(), p = fakePort(f.db), s = f.open(p.port), { a, row } = due(f), token = s.claim(a.workspaceId, a.scheduleId, row.occurrenceId)!;
  expect(durable(f, row.occurrenceId).state).toBe("claimed"); const out = await s.beginDispatch(row.occurrenceId, token);
  expect(p.calls).toHaveLength(1); const call = p.calls[0]!;
  expect(call).toMatchObject({ token, inTransaction: false, state: "dispatching", claimToken: token });
  expect(call.input.occurrence).toMatchObject({ occurrenceId: row.occurrenceId, scheduleId: a.scheduleId, state: "dispatching", reason: null, dueAt: row.dueAt, latestDueAt: row.latestDueAt, missedCount: row.missedCount });
  expect(call.input.schedule).toEqual(s.get(a.workspaceId, a.scheduleId)); expect(call.input.effective).toEqual(s.effective(a.workspaceId, a.scheduleId)); expect(call.input.schedule.definition.prompt).toBe("fixture work");
  expect(out.status).toBe("started"); expect(durable(f, row.occurrenceId)).toEqual({ state: "dispatching", reason: null, claim_token: token });
  // The claim slot stays held: a coalesced pending cannot be claimed while this one is active.
  f.time(5000); s.tick(); const pending = s.status(a.workspaceId, a.scheduleId).occurrences.find(value => value.state === "pending")!; expect(s.claim(a.workspaceId, a.scheduleId, pending.occurrenceId)).toBeUndefined();
  expect(s.status(a.workspaceId, a.scheduleId).execution).toBe("unavailable");
  s.handled(row.occurrenceId, token, receiptOf(out)); expect(durable(f, row.occurrenceId)).toEqual({ state: "handled", reason: null, claim_token: null }); expect(s.get(a.workspaceId, a.scheduleId).state).toBe("enabled");
  expect(s.claim(a.workspaceId, a.scheduleId, pending.occurrenceId)).toBeString();
});
test("crash window after claim: recovery returns the claim, the dead token is refused and a fresh claim dispatches exactly once", async () => {
  const f = fixture(), { a, row } = due(f), stale = f.schedules.claim(a.workspaceId, a.scheduleId, row.occurrenceId)!;
  const p = fakePort(f.db), restarted = f.peer(p.port); restarted.schedules.recover(); expect(durable(f, row.occurrenceId)).toEqual({ state: "pending", reason: null, claim_token: null }); expect(p.calls).toHaveLength(0);
  const fresh = restarted.schedules.claim(a.workspaceId, a.scheduleId, row.occurrenceId)!; expect(fresh).not.toBe(stale);
  expect(() => restarted.schedules.beginDispatch(row.occurrenceId, stale)).toThrow("request_conflict"); expect(p.calls).toHaveLength(0); expect(durable(f, row.occurrenceId).claim_token).toBe(fresh);
  expect((await restarted.schedules.beginDispatch(row.occurrenceId, fresh)).status).toBe("started"); expect(p.calls).toHaveLength(1);
});
test("crash window after begin: the in-flight launch becomes uncertain on recovery, a late ack changes nothing and nothing is replayed", async () => {
  const f = fixture(), gate = deferred<CoworkScheduleStartResult>(), hung = fakePort(f.db, () => gate.promise), s = f.open(hung.port), { a, row } = due(f), token = s.claim(a.workspaceId, a.scheduleId, row.occurrenceId)!;
  const inFlight = s.beginDispatch(row.occurrenceId, token); expect(durable(f, row.occurrenceId).state).toBe("dispatching"); expect(hung.calls).toHaveLength(1);
  const restarted = f.peer(fakePort(f.db).port); restarted.schedules.recover(); restarted.schedules.recover();
  expect(durable(f, row.occurrenceId)).toMatchObject({ state: "uncertain", reason: "recovery_required" });
  gate.resolve({ kind: "started", receipt: { occurrenceId: row.occurrenceId, token, runRef: "late" } }); expect(await inFlight).toEqual({ status: "uncertain" });
  expect(durable(f, row.occurrenceId)).toMatchObject({ state: "uncertain", reason: "recovery_required" });
  f.time(9000); restarted.schedules.tick(); s.tick(); expect(restarted.schedules.claim(a.workspaceId, a.scheduleId, row.occurrenceId)).toBeUndefined();
  const pending = s.status(a.workspaceId, a.scheduleId).occurrences.find(value => value.state === "pending")!; expect(s.claim(a.workspaceId, a.scheduleId, pending.occurrenceId)).toBeUndefined();
  expect(() => s.beginDispatch(row.occurrenceId, token)).toThrow("request_conflict"); expect(hung.calls).toHaveLength(1);
});
test("crash window after the port ack: the receipt cannot complete a recovered occurrence and a one-shot stays enabled", async () => {
  const f = fixture(), p = fakePort(f.db), s = f.open(p.port), { a, row } = due(f, { ...f.definition, timing: { kind: "once", at: 1000 } }), token = s.claim(a.workspaceId, a.scheduleId, row.occurrenceId)!;
  const receipt = receiptOf(await s.beginDispatch(row.occurrenceId, token)); f.peer().schedules.recover();
  expect(durable(f, row.occurrenceId)).toMatchObject({ state: "uncertain", reason: "recovery_required" });
  expect(() => s.handled(row.occurrenceId, token, receipt)).toThrow("request_conflict");
  expect(durable(f, row.occurrenceId).state).toBe("uncertain"); expect(s.get(a.workspaceId, a.scheduleId).state).toBe("enabled"); expect(p.calls).toHaveLength(1);
  expect(s.claim(a.workspaceId, a.scheduleId, row.occurrenceId)).toBeUndefined(); expect(() => s.uncertain(row.occurrenceId, token)).toThrow("request_conflict");
});
test("only a returned not-started answer returns the occurrence to pending/execution_unavailable, and a fresh claim may retry", async () => {
  const f = fixture(); let attempts = 0;
  const p = fakePort(f.db, (input, token) => (++attempts === 1 ? { kind: "not-started" } : ack(input, token))), s = f.open(p.port), { a, row } = due(f), first = s.claim(a.workspaceId, a.scheduleId, row.occurrenceId)!;
  expect(await s.beginDispatch(row.occurrenceId, first)).toEqual({ status: "not-started" });
  expect(durable(f, row.occurrenceId)).toEqual({ state: "pending", reason: "execution_unavailable", claim_token: null }); expect(s.get(a.workspaceId, a.scheduleId).state).toBe("enabled");
  expect(() => s.beginDispatch(row.occurrenceId, first)).toThrow("request_conflict"); expect(p.calls).toHaveLength(1);
  const second = s.claim(a.workspaceId, a.scheduleId, row.occurrenceId)!; expect(second).not.toBe(first); expect((await s.beginDispatch(row.occurrenceId, second)).status).toBe("started"); expect(p.calls).toHaveLength(2);
});
test("a port throw (sync or async) is never read as nothing launched: it is uncertain, recorded durably, leaks nothing and is never replayed", async () => {
  for (const failure of [() => { throw new Error("secret-bearing detail"); }, () => Promise.reject(new Error("secret-bearing detail"))] as Start[]) {
    const f = fixture(), p = fakePort(f.db, failure), s = f.open(p.port), { a, row } = due(f, { ...f.definition, timing: { kind: "once", at: 1000 } }), token = s.claim(a.workspaceId, a.scheduleId, row.occurrenceId)!;
    const out = await s.beginDispatch(row.occurrenceId, token); expect(out).toEqual({ status: "uncertain" }); expect(JSON.stringify(out)).not.toContain("secret");
    expect(durable(f, row.occurrenceId)).toMatchObject({ state: "uncertain", reason: "recovery_required" }); expect(s.get(a.workspaceId, a.scheduleId).state).toBe("enabled");
    // No replay by any route: the token is spent, the slot is held, recovery and ticks keep it uncertain.
    expect(() => s.beginDispatch(row.occurrenceId, token)).toThrow("request_conflict"); expect(s.claim(a.workspaceId, a.scheduleId, row.occurrenceId)).toBeUndefined();
    f.time(20000); s.tick(); f.peer(fakePort(f.db).port).schedules.recover(); s.recover(); expect(durable(f, row.occurrenceId)).toMatchObject({ state: "uncertain", reason: "recovery_required" });
    expect(s.claim(a.workspaceId, a.scheduleId, row.occurrenceId)).toBeUndefined(); expect(p.calls).toHaveLength(1);
    expect(() => s.handled(row.occurrenceId, token, forgedReceipt(row.occurrenceId))).toThrow("request_conflict");
  }
});
test("a not-started answer folds a pending interval materialized meanwhile instead of colliding, and no answer clobbers a recorded cancellation", async () => {
  const f = fixture(), gate = deferred<CoworkScheduleStartResult>(), p = fakePort(f.db, () => gate.promise), s = f.open(p.port), { a, row } = due(f), token = s.claim(a.workspaceId, a.scheduleId, row.occurrenceId)!;
  const inFlight = s.beginDispatch(row.occurrenceId, token); f.time(5000); s.tick(); expect(s.status(a.workspaceId, a.scheduleId).occurrences).toHaveLength(2);
  gate.resolve({ kind: "not-started" }); expect(await inFlight).toEqual({ status: "not-started" });
  const rows = s.status(a.workspaceId, a.scheduleId).occurrences; expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ occurrenceId: row.occurrenceId, state: "pending", reason: "execution_unavailable", latestDueAt: 5000, missedCount: 4 });
  // Cancellation lands while the launch is in flight; neither not-started, nor a throw, nor an ack may undo recovery_required.
  type Gate = ReturnType<typeof deferred<CoworkScheduleStartResult>>;
  const settles: ((g: Gate, occurrenceId: string, claim: string) => void)[] = [g => g.resolve({ kind: "not-started" }), g => g.reject(new Error("late")), (g, occurrenceId, claim) => g.resolve({ kind: "started", receipt: { occurrenceId, token: claim, runRef: "late" } })];
  for (const settle of settles) {
    const g = fixture(), gated = deferred<CoworkScheduleStartResult>(), q = fakePort(g.db, () => gated.promise), t = g.open(q.port), one = due(g), claim = t.claim(one.a.workspaceId, one.a.scheduleId, one.row.occurrenceId)!;
    const pendingOutcome = t.beginDispatch(one.row.occurrenceId, claim); t.cancel(one.a.workspaceId, one.a.scheduleId, 1); expect(durable(g, one.row.occurrenceId)).toMatchObject({ state: "uncertain", reason: "recovery_required" });
    settle(gated, one.row.occurrenceId, claim); expect(await pendingOutcome).toEqual({ status: "uncertain" }); expect(durable(g, one.row.occurrenceId)).toMatchObject({ state: "uncertain", reason: "recovery_required" });
  }
});
test("an uncertain, malformed or hostile port answer is uncertain, never pending, never rejects, leaks nothing and never handles a one-shot", async () => {
  const valid = (input: CoworkScheduleDispatchInput, token: string) => ({ occurrenceId: input.occurrence.occurrenceId, token, runRef: "r1" });
  const trap = (message: string) => new Proxy({}, { get() { throw new Error(message); }, has() { throw new Error(message); }, ownKeys() { throw new Error(message); } });
  const wrong: Start[] = [() => ({ kind: "uncertain" }), (input, token) => ({ kind: "started", receipt: { occurrenceId: "another", token, runRef: "r" } }), (input) => ({ kind: "started", receipt: { occurrenceId: input.occurrence.occurrenceId, token: "other-token", runRef: "r" } }),
    (input, token) => ({ kind: "started", receipt: { occurrenceId: input.occurrence.occurrenceId, token, runRef: "../escape" } }), (input, token) => ({ kind: "started", receipt: { occurrenceId: input.occurrence.occurrenceId, token } as any }),
    () => ({}) as any, () => undefined as any, () => ({ kind: "started" }) as any, () => ({ kind: "not_started" }) as any, () => ({ kind: "Not-Started" }) as any, () => ({ kind: "notstarted" }) as any, () => "not-started" as any, () => ({ status: "not-started" }) as any,
    // an `uncertain` answer is uncertain even when it carries an otherwise valid receipt; kinds are matched exactly
    (input, token) => ({ kind: "uncertain", receipt: valid(input, token) }) as any, (input, token) => ({ kind: "STARTED", receipt: valid(input, token) }) as any, (input, token) => ({ kind: "Started", receipt: valid(input, token) }) as any,
    (input, token) => ({ kind: "started ", receipt: valid(input, token) }) as any, (input, token) => ({ kind: ["started"], receipt: valid(input, token) }) as any, (input, token) => ({ kind: new String("started"), receipt: valid(input, token) }) as any,
    (input, token) => ({ kind: "started", receipt: { ...valid(input, token), runRef: new String("r1") } }) as any, (input, token) => ({ kind: "started", receipt: { ...valid(input, token), runRef: "x".repeat(129) } }) as any,
    (input, token) => ({ kind: "started", receipt: { ...valid(input, token), runRef: "bad\nref" } }) as any, (input, token) => ({ kind: "started", receipt: "receipt" }) as any,
    // hostile answers: a throwing getter must not escape the settle transaction, leave the row dispatching or leak its text
    () => ({ get kind(): never { throw new Error("secret-detail-kind"); } }) as any,
    (input, token) => ({ kind: "started", receipt: { occurrenceId: input.occurrence.occurrenceId, token, get runRef(): string { throw new Error("secret-detail-runref"); } } }) as any,
    (input, token) => ({ kind: "started", receipt: { get occurrenceId(): string { throw new Error("secret-detail-echo"); }, token, runRef: "r1" } }) as any,
    (input, token) => ({ kind: "started", get receipt(): never { throw new Error("secret-detail-receipt"); } }) as any,
    () => trap("secret-detail-proxy") as any, (input, token) => ({ kind: "started", receipt: trap("secret-detail-receipt-proxy") }) as any,
    () => ({ get then(): never { throw new Error("secret-detail-then"); } }) as any,
    // a getter that changes its answer between reads cannot split the decision: the first read is the only one
    (() => { let reads = 0; return (input: CoworkScheduleDispatchInput, token: string) => ({ get kind() { return ++reads === 1 ? "started" : "not-started"; }, receipt: { ...valid(input, token), get runRef() { return reads > 1 ? "../escape" : "r1"; } } }) as any; })(),
  ];
  // The flip-flopping getter is the last entry: its first read says `started`, which is honored exactly once and never re-read.
  const stable = wrong.pop()!;
  for (const answer of wrong) {
    const f = fixture(), p = fakePort(f.db, answer), s = f.open(p.port), { a, row } = due(f, { ...f.definition, timing: { kind: "once", at: 1000 } }), token = s.claim(a.workspaceId, a.scheduleId, row.occurrenceId)!;
    const out = await s.beginDispatch(row.occurrenceId, token); // must RESOLVE: a rejection here would leave the row dispatching holding the slot
    expect(out).toEqual({ status: "uncertain" }); expect(JSON.stringify(out)).not.toContain("secret");
    expect(durable(f, row.occurrenceId)).toMatchObject({ state: "uncertain", reason: "recovery_required" }); expect(s.get(a.workspaceId, a.scheduleId).state).toBe("enabled");
    expect(s.claim(a.workspaceId, a.scheduleId, row.occurrenceId)).toBeUndefined(); expect(p.calls).toHaveLength(1);
  }
  const f = fixture(), p = fakePort(f.db, stable), s = f.open(p.port), { a, row } = due(f), token = s.claim(a.workspaceId, a.scheduleId, row.occurrenceId)!;
  const out = await s.beginDispatch(row.occurrenceId, token); expect(out.status).toBe("started"); expect(durable(f, row.occurrenceId).state).toBe("dispatching"); expect(p.calls).toHaveLength(1);
});
test("a quarantine row inserted after the claim blocks the begin with invalid_schedule and never reaches the port", async () => {
  const f = fixture(), p = fakePort(f.db), s = f.open(p.port), { a, row } = due(f), token = s.claim(a.workspaceId, a.scheduleId, row.occurrenceId)!;
  f.db.db.run("INSERT INTO cowork_schedule_quarantines VALUES(?,'invalid_schedule',?)", [a.scheduleId, 5]); // the definition itself still parses
  expect(await s.beginDispatch(row.occurrenceId, token)).toEqual({ status: "blocked", reason: "invalid_schedule" });
  expect(p.calls).toHaveLength(0); expect(durable(f, row.occurrenceId)).toEqual({ state: "pending", reason: "invalid_schedule", claim_token: null });
});
test("two DB handles on one file yield exactly one dispatch", async () => {
  const f = fixture(), counted = { calls: 0 }, count: Start = (input, token) => { counted.calls++; return ack(input, token); };
  const a1 = fakePort(f.db, count), second = f.peer(); const b1 = fakePort(second.db, count), left = f.open(a1.port), right = second.schedules; const rightWithPort = f.open(b1.port, second.db);
  const { a, row } = due(f); const token = left.claim(a.workspaceId, a.scheduleId, row.occurrenceId)!;
  expect(rightWithPort.claim(a.workspaceId, a.scheduleId, row.occurrenceId)).toBeUndefined(); expect(right.claim(a.workspaceId, a.scheduleId, row.occurrenceId)).toBeUndefined();
  // Even holding the winner's token, the loser cannot start a second dispatch once the winner flipped the row.
  const winner = left.beginDispatch(row.occurrenceId, token); expect(() => rightWithPort.beginDispatch(row.occurrenceId, token)).toThrow("request_conflict"); expect((await winner).status).toBe("started");
  expect(() => rightWithPort.beginDispatch(row.occurrenceId, token)).toThrow("request_conflict"); expect(counted.calls).toBe(1);
  // Reverse interleaving on a second occurrence of another schedule: the other handle begins first.
  const g = fixture(), c = { calls: 0 }, once: Start = (input, tok) => { c.calls++; return ack(input, tok); }, o = g.peer(), x = g.open(fakePort(g.db, once).port), y = g.open(fakePort(o.db, once).port, o.db), two = due(g), t2 = x.claim(two.a.workspaceId, two.a.scheduleId, two.row.occurrenceId)!;
  const first = y.beginDispatch(two.row.occurrenceId, t2); expect(() => x.beginDispatch(two.row.occurrenceId, t2)).toThrow("request_conflict"); await first; expect(c.calls).toBe(1);
});
test("a wrong, unknown or reused token is refused and leaves the claim untouched", async () => {
  const f = fixture(), p = fakePort(f.db), s = f.open(p.port), { a, row } = due(f), token = s.claim(a.workspaceId, a.scheduleId, row.occurrenceId)!;
  expect(() => s.beginDispatch(row.occurrenceId, "wrong-token")).toThrow("request_conflict"); expect(() => s.beginDispatch(row.occurrenceId, "")).toThrow("request_conflict"); expect(() => s.beginDispatch("unknown-occurrence", token)).toThrow("request_conflict");
  expect(durable(f, row.occurrenceId)).toEqual({ state: "claimed", reason: null, claim_token: token }); expect(p.calls).toHaveLength(0);
  // A token from an earlier claim of the same occurrence is dead once the claim is released and taken again.
  s.recover(); const fresh = s.claim(a.workspaceId, a.scheduleId, row.occurrenceId)!; expect(fresh).not.toBe(token);
  expect(() => s.beginDispatch(row.occurrenceId, token)).toThrow("request_conflict"); expect(durable(f, row.occurrenceId).claim_token).toBe(fresh); expect(p.calls).toHaveLength(0);
  const out = await s.beginDispatch(row.occurrenceId, fresh); s.handled(row.occurrenceId, fresh, receiptOf(out));
  expect(() => s.beginDispatch(row.occurrenceId, fresh)).toThrow("request_conflict"); expect(() => s.beginDispatch(row.occurrenceId, token)).toThrow("request_conflict");
  expect(() => s.handled(row.occurrenceId, fresh, receiptOf(out))).toThrow("request_conflict"); expect(p.calls).toHaveLength(1);
});
test("blockedReason is re-run at begin: a claim does not outlive archive, revoked grants or source, branch drift, shutdown or a poisoned definition", async () => {
  const blocked = async (name: string, change: (f: Fixture, a: { workspaceId: string; scheduleId: string }, s: CoworkSchedules) => void, reason: string, definition?: (f: Fixture) => CoworkScheduleDefinition) => {
    const f = fixture(), p = fakePort(f.db), s = f.open(p.port), { a, row } = due(f, definition?.(f)), token = s.claim(a.workspaceId, a.scheduleId, row.occurrenceId)!;
    change(f, a, s); const out = await s.beginDispatch(row.occurrenceId, token);
    expect({ name, out } as unknown).toEqual({ name, out: { status: "blocked", reason } }); expect({ name, calls: p.calls.length }).toEqual({ name, calls: 0 });
    expect({ name, ...durable(f, row.occurrenceId) }).toEqual({ name, state: "pending", reason, claim_token: null });
    return { f, a, s, row, p };
  };
  await blocked("archived workspace", (f, a) => f.db.db.run("UPDATE cowork_workspaces SET state='archived' WHERE workspace_id=?", [a.workspaceId]), "archived");
  await blocked("revoked grant", f => f.revoke(), "authority_denied");
  await blocked("revoked source", (f, a) => f.records.removeSource({ principalId: "fixture", requestId: "revoke", expectedRevision: 1 }, a.workspaceId, f.definition.sourceId, true), "source_unavailable");
  await blocked("shutdown", (_f, _a, s) => s.beginShutdown(), "shutdown");
  const drift = await blocked("branch mismatch", f => f.branch("main"), "branch_mismatch", f => ({ ...f.definition, branchPrecondition: "feature/example" }));
  await blocked("poisoned definition", (f, a) => f.db.db.run("UPDATE cowork_schedules SET definition_json='{poison' WHERE schedule_id=?", [a.scheduleId]), "invalid_schedule");
  // The refusal is not terminal: once the world agrees again, a fresh claim dispatches.
  drift.f.branch("feature/example"); const again = drift.s.claim(drift.a.workspaceId, drift.a.scheduleId, drift.row.occurrenceId)!; expect(again).toBeString();
  expect((await drift.s.beginDispatch(drift.row.occurrenceId, again)).status).toBe("started"); expect(drift.p.calls).toHaveLength(1);
});
test("a blocked begin folds a pending interval materialized after the claim", async () => {
  const f = fixture(), p = fakePort(f.db), s = f.open(p.port), { a, row } = due(f), token = s.claim(a.workspaceId, a.scheduleId, row.occurrenceId)!;
  f.time(5000); s.tick(); f.branch("main"); f.db.db.run("UPDATE cowork_workspaces SET state='archived' WHERE workspace_id=?", [a.workspaceId]);
  expect(await s.beginDispatch(row.occurrenceId, token)).toEqual({ status: "blocked", reason: "archived" });
  const rows = s.status(a.workspaceId, a.scheduleId).occurrences; expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ state: "pending", reason: "archived", latestDueAt: 5000, missedCount: 4 }); expect(p.calls).toHaveLength(0);
});
test("recover() turns dispatching into uncertain and never replays, while a pre-dispatch claim is merely returned", async () => {
  const f = fixture(), p = fakePort(f.db), s = f.open(p.port), left = due(f), claimedToken = s.claim(left.a.workspaceId, left.a.scheduleId, left.row.occurrenceId)!;
  const out = await s.beginDispatch(left.row.occurrenceId, claimedToken); receiptOf(out);
  const owner = f.peer(fakePort(f.db).port); owner.schedules.recover(); owner.schedules.recover();
  expect(durable(f, left.row.occurrenceId)).toMatchObject({ state: "uncertain", reason: "recovery_required" }); expect(owner.schedules.claim(left.a.workspaceId, left.a.scheduleId, left.row.occurrenceId)).toBeUndefined();
  f.time(20000); owner.schedules.tick(); owner.schedules.recover(); const pending = owner.schedules.status(left.a.workspaceId, left.a.scheduleId).occurrences.find(value => value.state === "pending")!;
  expect(owner.schedules.claim(left.a.workspaceId, left.a.scheduleId, pending.occurrenceId)).toBeUndefined(); expect(durable(f, left.row.occurrenceId).state).toBe("uncertain"); expect(p.calls).toHaveLength(1);
});
test("a one-shot is never marked handled without the receipt its own port issued for its own claim", async () => {
  const f = fixture(), p = fakePort(f.db), s = f.open(p.port), other = f.peer(fakePort(f.db).port).schedules, { a, row } = due(f, { ...f.definition, timing: { kind: "once", at: 1000 } }), token = s.claim(a.workspaceId, a.scheduleId, row.occurrenceId)!;
  const out = await s.beginDispatch(row.occurrenceId, token), receipt = receiptOf(out); const dispatching = () => { expect(durable(f, row.occurrenceId).state).toBe("dispatching"); expect(s.get(a.workspaceId, a.scheduleId).state).toBe("enabled"); };
  expect(() => s.handled(row.occurrenceId, token, undefined as any)).toThrow("request_conflict"); dispatching();
  expect(() => s.handled(row.occurrenceId, token, forgedReceipt(row.occurrenceId))).toThrow("request_conflict"); dispatching();
  expect(() => s.handled(row.occurrenceId, token, { ...receipt })).toThrow("request_conflict"); dispatching();
  expect(() => s.handled(row.occurrenceId, "wrong-token", receipt)).toThrow("request_conflict"); dispatching();
  expect(() => s.handled("another-occurrence", token, receipt)).toThrow("request_conflict"); dispatching();
  expect(() => other.handled(row.occurrenceId, token, receipt)).toThrow("request_conflict"); dispatching();
  s.handled(row.occurrenceId, token, receipt); expect(durable(f, row.occurrenceId)).toEqual({ state: "handled", reason: null, claim_token: null }); expect(s.get(a.workspaceId, a.scheduleId)).toMatchObject({ state: "handled", revision: 2 });
  expect(() => s.handled(row.occurrenceId, token, receipt)).toThrow("request_conflict");
});
test("the execution owner can report dispatching work uncertain, with the claim token only, once", async () => {
  const f = fixture(), s = f.open(fakePort(f.db).port), { a, row } = due(f, { ...f.definition, timing: { kind: "once", at: 1000 } }), token = s.claim(a.workspaceId, a.scheduleId, row.occurrenceId)!;
  expect(() => s.uncertain(row.occurrenceId, token)).toThrow("request_conflict"); const receipt = receiptOf(await s.beginDispatch(row.occurrenceId, token));
  expect(() => s.uncertain(row.occurrenceId, "wrong-token")).toThrow("request_conflict"); expect(durable(f, row.occurrenceId).state).toBe("dispatching");
  s.uncertain(row.occurrenceId, token); expect(durable(f, row.occurrenceId)).toMatchObject({ state: "uncertain", reason: "recovery_required" });
  expect(() => s.handled(row.occurrenceId, token, receipt)).toThrow("request_conflict"); expect(() => s.uncertain(row.occurrenceId, token)).toThrow("request_conflict");
  expect(s.get(a.workspaceId, a.scheduleId).state).toBe("enabled"); expect(s.claim(a.workspaceId, a.scheduleId, row.occurrenceId)).toBeUndefined();
});
test("shutdown after dispatching still lets the in-flight dispatch settle but admits no new claim", async () => {
  const f = fixture(), gate = deferred<CoworkScheduleStartResult>(), s = f.open(fakePort(f.db, () => gate.promise).port), { a, row } = due(f), token = s.claim(a.workspaceId, a.scheduleId, row.occurrenceId)!;
  const inFlight = s.beginDispatch(row.occurrenceId, token); s.beginShutdown(); gate.resolve({ kind: "started", receipt: { occurrenceId: row.occurrenceId, token, runRef: "drain" } });
  const receipt = receiptOf(await inFlight); s.handled(row.occurrenceId, token, receipt); expect(durable(f, row.occurrenceId).state).toBe("handled");
  f.time(9000); s.tick(); const pending = s.status(a.workspaceId, a.scheduleId).occurrences.find(value => value.state === "pending"); expect(pending).toBeUndefined();
});

const sourceDirectory = (...parts: string[]) => join(import.meta.dir, "..", "..", "..", ...parts);
function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile() && /\.(ts|tsx|js|mjs|cjs)$/.test(entry.name)).map(entry => join(entry.parentPath, entry.name));
}
const parse = (file: string) => ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
type Wrapper = ts.ParenthesizedExpression | ts.AsExpression | ts.NonNullExpression | ts.TypeAssertion | ts.SatisfiesExpression;
const isWrapper = (node: ts.Node): node is Wrapper => ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node) || ts.isTypeAssertionExpression(node) || ts.isSatisfiesExpression(node);
const unwrap = (node: ts.Expression): ts.Expression => isWrapper(node) ? unwrap(node.expression) : node;
/** Everything the AST scan refuses in one `src/` file. Exported to the snippet test below so each rule has a failing and a passing case. */
function wiringProblems(tree: ts.SourceFile, name: string, portIndex: number): { problems: string[]; constructions: number } {
  const problems: string[] = []; let constructions = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isNewExpression(node)) {
      const callee = unwrap(node.expression);
      if (ts.isIdentifier(callee) && callee.text === "CoworkSchedules") {
        constructions++; const args = node.arguments ?? [];
        if (args.some(ts.isSpreadElement)) problems.push(`${name}: spread argument`);
        if (args.length > portIndex) problems.push(`${name}: ${args.length} arguments reach the port position ${portIndex}`);
      }
    } else if (ts.isIdentifier(node) && node.text === "CoworkSchedules") {
      let top: ts.Node = node; while (top.parent && isWrapper(top.parent)) top = top.parent;
      const parent = top.parent, aliased = ts.isImportSpecifier(parent) && parent.propertyName?.text === "CoworkSchedules"; // `import { CoworkSchedules as X }` would hide later constructions
      // `typeof CoworkSchedules` is a pure type-level use and cannot construct anything.
      const allowed = !aliased && (ts.isImportSpecifier(parent) || ts.isTypeReferenceNode(parent) || ts.isTypeQueryNode(parent) || (ts.isNewExpression(parent) && parent.expression === top));
      if (!allowed) problems.push(`${name}: CoworkSchedules used as ${ts.SyntaxKind[parent.kind]}`);
    } else if (ts.isStringLiteralLike(node) && node.text === "CoworkSchedules") {
      // `new (x as any)["CoworkSchedules"](...)` reaches the class by name without an identifier; only schedules.ts may spell the name as a string.
      problems.push(`${name}: the string literal "CoworkSchedules"`);
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return { problems, constructions };
}
/*
 * Anti-wiring pin for the schedule dispatch port.
 *
 * What this pin is and is not. The REAL backstop is the set of bans below: outside schedules.ts (and the types
 * module itself) no src file may mention the port types, the `schedule-dispatch` module, `beginDispatch`, `.handled(`
 * or `.uncertain(`. Without a driver that calls those, an injected port can never dispatch anything, whatever shape
 * the construction takes. The AST scan on top is a convenience that names the likeliest violation (a src
 * construction that fills the port position); it reads the REAL syntax tree, so comments, string and template
 * literals, apostrophes, line breaks and parentheses cannot fool it, and it cannot be defeated by a spread argument
 * because ANY spread argument is refused. It deliberately asserts nothing about where the port parameter sits in
 * the constructor: another lane may append or insert parameters without tripping it.
 */
test("anti-wiring: the dispatch port is a type-only import of schedules.ts, has no implementation and no src construction passes one", () => {
  const packages = sourceDirectory(), module = join(packages, "core", "src", "cowork", "schedule-dispatch.ts"), doorPort = join(packages, "core", "src", "cowork", "schedule-door-port.ts"), owner = join(packages, "core", "src", "cowork", "schedules.ts"), service = join(packages, "core", "src", "cowork", "service.ts");
  expect(existsSync(module)).toBe(true);
  const sources = readdirSync(packages, { withFileTypes: true }).filter(entry => entry.isDirectory() && existsSync(join(packages, entry.name, "src"))).flatMap(entry => sourceFiles(join(packages, entry.name, "src")));
  expect(sources.length).toBeGreaterThan(100); expect(sources).toContain(module); expect(sources).toContain(owner); expect(sources).toContain(service);
  const relative = (file: string) => file.slice(packages.length);
  // 1. The bans (the real backstop). Boundary names: only the owner, the types module and the door port (the one implementation, itself imported by
  //    no src file and constructed by no production code, see schedule-door-port.test.ts) may name them. Driver verbs: only the owner.
  const needles = ["schedule-dispatch", "CoworkScheduleDispatchPort", "CoworkScheduleDispatchInput", "CoworkScheduleDispatchReceipt", "CoworkScheduleDispatchOutcome", "CoworkScheduleStartResult", "CoworkScheduleStartReceipt", "beginDispatch", ".handled(", ".uncertain("];
  const driverVerbs = ["beginDispatch", ".handled(", ".uncertain("], banned: string[] = [];
  expect(sources).toContain(doorPort);
  for (const file of sources.filter(candidate => candidate !== module && candidate !== owner)) { const text = readFileSync(file, "utf8"); for (const needle of needles) if (text.includes(needle) && !(file === doorPort && !driverVerbs.includes(needle))) banned.push(`${relative(file)}:${needle}`); }
  expect(banned).toEqual([]);
  // 2. The one reference is erased at runtime: schedules.ts imports the port types with `import type`, and the module has no runtime code at all.
  const ownTree = parse(owner), imports = ownTree.statements.filter((statement): statement is ts.ImportDeclaration => ts.isImportDeclaration(statement) && /schedule-dispatch/.test((statement.moduleSpecifier as ts.StringLiteral).text));
  expect(imports).toHaveLength(1); expect(imports[0]!.importClause?.isTypeOnly).toBe(true); expect((imports[0]!.moduleSpecifier as ts.StringLiteral).text).toBe("./schedule-dispatch");
  const typesTree = parse(module), kinds = typesTree.statements.map(statement => ts.SyntaxKind[statement.kind]);
  expect([...new Set(kinds)].sort()).toEqual(["ImportDeclaration", "InterfaceDeclaration", "TypeAliasDeclaration"]);
  expect(typesTree.statements.filter(ts.isImportDeclaration).every(statement => statement.importClause?.isTypeOnly === true)).toBe(true);
  expect(typesTree.statements.filter(ts.isImportDeclaration).map(statement => (statement.moduleSpecifier as ts.StringLiteral).text).sort()).toEqual(["./types", "@yanlinglabs/winter-protocol"]);
  // 3. No implementation of the port anywhere in src (a class implementing it, or a value annotated with it).
  // The door port is the single permitted implementation; it is a factory returning an object literal, so it matches neither pattern.
  const implementing = sources.filter(file => /implements\s+CoworkScheduleDispatchPort|:\s*CoworkScheduleDispatchPort\s*=/.test(readFileSync(file, "utf8"))).map(relative);
  expect(implementing).toEqual([]);
  // 4. AST scan: every `new CoworkSchedules(...)` in src (parenthesized or cast included) must leave the port position empty and spread nothing,
  //    and the class may not be used any other way (alias, `extends`, `Reflect.construct`) that could smuggle arguments past the count.
  const cls = ownTree.statements.find((statement): statement is ts.ClassDeclaration => ts.isClassDeclaration(statement) && statement.name?.text === "CoworkSchedules")!;
  const portIndex = cls.members.find(ts.isConstructorDeclaration)!.parameters.findIndex(parameter => parameter.type?.getText(ownTree).includes("CoworkScheduleDispatchPort"));
  expect(portIndex).toBeGreaterThan(2);
  const problems: string[] = []; let constructions = 0;
  for (const file of sources.filter(candidate => candidate !== module && candidate !== owner)) {
    const scanned = wiringProblems(parse(file), relative(file), portIndex); constructions += scanned.constructions; problems.push(...scanned.problems);
  }
  expect(problems).toEqual([]); expect(constructions).toBeGreaterThan(0);
  expect(existsSync(join(packages, "core", "src", "cowork", "index.ts"))).toBe(false); expect(readFileSync(join(packages, "core", "src", "index.ts"), "utf8")).not.toMatch(/schedule-dispatch|from "\.\/cowork/);
});
test("anti-wiring scan: each rule has a passing and a failing case", () => {
  const scan = (text: string) => wiringProblems(ts.createSourceFile("snippet.ts", text, ts.ScriptTarget.Latest, true), "snippet", 5);
  const imported = 'import { CoworkSchedules } from "./schedules";\n';
  // Passing: the production construction, an extra argument below the port position, and pure type-level uses.
  for (const ok of ["new CoworkSchedules(a, b, c);", "new CoworkSchedules(a, b, c, d, e);", "type T = typeof CoworkSchedules;", "let x: typeof CoworkSchedules; let y: CoworkSchedules;", "const x = null as unknown as CoworkSchedules; new CoworkSchedules(a);", "// \"CoworkSchedules\" and 'CoworkSchedules' in a comment, and `CoworkSchedules`\nnew CoworkSchedules(a, b, c);"])
    expect({ ok, problems: scan(imported + ok).problems }).toEqual({ ok, problems: [] });
  expect(scan(imported + "new CoworkSchedules(a, b, c);").constructions).toBe(1);
  // Failing: the port position filled, spreads, other ways to reach the class, and its name spelled as a string.
  for (const bad of ["new CoworkSchedules(a, b, c, d, e, port);", "new CoworkSchedules(...args);", "new CoworkSchedules(a, ...rest);", "new (CoworkSchedules as any)(a, b, c, d, e, port);", "const A = CoworkSchedules; new A(a);", "class W extends CoworkSchedules {}",
    "Reflect.construct(CoworkSchedules, []);", 'new (x as any)["CoworkSchedules"](a, b, c, d, e, port);', "new (x as any)['CoworkSchedules'](a);", "new (x as any)[`CoworkSchedules`](a);", 'const n = "CoworkSchedules";'])
    expect({ bad, rejected: scan(imported + bad).problems.length > 0 }).toEqual({ bad, rejected: true });
  expect(scan('import { CoworkSchedules as Hidden } from "./schedules"; new Hidden(a);').problems.length).toBeGreaterThan(0);
});
