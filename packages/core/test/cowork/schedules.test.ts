import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRuntimeStateDb, type RuntimeStateDb } from "../../src/runtime-state/db";
import { CoworkRepository } from "../../src/cowork/repository";
import { CoworkSchedules, nextCoworkScheduleTime } from "../../src/cowork/schedules";
import type { CoworkScheduleDefinition } from "@yanlinglabs/winter-protocol";
const homes: string[] = [], handles: RuntimeStateDb[] = [];
const caps = { toolClasses: ["read", "write"], hostServices: [], connectors: [], network: "internet" as const };
afterEach(() => { handles.splice(0).forEach(db => db.close()); homes.splice(0).forEach(home => rmSync(home, { recursive: true, force: true })); });
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "winter-schedules-")); homes.push(home);
  const db = openRuntimeStateDb(home); handles.push(db); const records = new CoworkRepository(db);
  const made = records.create({ principalId: "fixture", requestId: "workspace" }, { ownership: "project", title: "Fixture", ceiling: caps, sources: [{ kind: "folder", label: "fixture", access: "read-write", detail: { grantRef: "fixture-grant", rootIdentity: "fixture-root" } }] });
  let time = 0, revoked = false, branch = "feature/example";
  const grants = { folder: () => ({ rootIdentity: "fixture-root", writable: true, revoked }), repository: () => undefined };
  const schedules = new CoworkSchedules(records, grants, () => time, () => branch);
  const definition: CoworkScheduleDefinition = { target: { kind: "project", projectId: made.value.workspace.ownerId }, sourceId: made.value.sources[0]!.sourceId, prompt: "fixture work", timing: { kind: "recurring", spec: "every 1s" }, timezone: "UTC", savedCeiling: caps, policy: "auto", overlap: "one-active-one-pending" };
  const create = (input = definition, request = "schedule") => schedules.create("fixture", made.workspaceId, request, input);
  return { home, db, records, schedules, grants, made, definition, create, time: (value: number) => { time = value; }, revoke: () => { revoked = true; }, branch: (value: string) => { branch = value; } };
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
  // Inject the future dispatch boundary to exercise crash recovery; no execution was performed.
  db.db.run("UPDATE cowork_schedule_occurrences SET state='dispatching' WHERE occurrence_id=?", [first.occurrenceId]); restored.recover();
  rows = restored.status(a.workspaceId, a.scheduleId).occurrences; expect(rows[0]!.state).toBe("uncertain"); expect(rows[0]!.reason).toBe("recovery_required"); expect(restored.claim(a.workspaceId, a.scheduleId, first.occurrenceId)).toBeUndefined();
});
test("one-shots remain pending after restart until a dispatched completion receipt", () => {
  const f = fixture(), a = f.create({ ...f.definition, timing: { kind: "once", at: 1000 } }); f.time(5000); f.schedules.tick();
  const restored = new CoworkSchedules(f.records, f.grants, () => 10000); restored.recover(); restored.tick(); const row = restored.status(a.workspaceId, a.scheduleId).occurrences[0]!;
  expect(row.state).toBe("pending"); expect(row.reason).toBe("execution_unavailable"); expect(restored.get(a.workspaceId, a.scheduleId).state).toBe("enabled");
  const token = restored.claim(a.workspaceId, a.scheduleId, row.occurrenceId)!; expect(() => restored.handled(row.occurrenceId, token)).toThrow("request_conflict");
  expect(() => restored.beginDispatch(row.occurrenceId, token)).toThrow("unsupported_topology");
  f.db.db.run("UPDATE cowork_schedule_occurrences SET state='dispatching' WHERE occurrence_id=?", [row.occurrenceId]); restored.handled(row.occurrenceId, token); expect(restored.get(a.workspaceId, a.scheduleId).state).toBe("handled");
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
  f.records.bindConversation({ principalId: "fixture", requestId: "binding", expectedRevision: 1 }, f.made.workspaceId, { sessionId: "fixture-conversation", sourceId: f.definition.sourceId });
  const a = f.create({ ...f.definition, target: { kind: "conversation", sessionId: "fixture-conversation" } });
  f.time(1000); f.schedules.tick(); const row = f.schedules.status(a.workspaceId, a.scheduleId).occurrences[0]!;
  f.db.db.run("UPDATE cowork_conversations SET state='archived' WHERE session_id='fixture-conversation'"); f.schedules.tick();
  expect(f.schedules.status(a.workspaceId, a.scheduleId).occurrences[0]!.reason).toBe("archived"); expect(f.schedules.claim(a.workspaceId, a.scheduleId, row.occurrenceId)).toBeUndefined();
  f.db.db.run("UPDATE cowork_conversations SET state='active',policy='plan' WHERE session_id='fixture-conversation'"); f.schedules.tick();
  expect(f.schedules.status(a.workspaceId, a.scheduleId).occurrences[0]!.reason).toBe("authority_denied");
  const standalone = f.records.create({ principalId: "fixture", requestId: "standalone" }, { ownership: "standalone", title: "Standalone", sources: [{ kind: "folder", label: "Fixture", access: "read-write", detail: { grantRef: "fixture-grant", rootIdentity: "fixture-root" } }], ceiling: caps });
  const source = standalone.value.sources[0]!; const own = f.records.beginIncarnation(standalone.workspaceId, "standalone-epoch", 1); f.records.acknowledgeSource(own, source.sourceId, 1, "ready");
  f.records.bindConversation({ principalId: "fixture", requestId: "own-binding", expectedRevision: 1 }, standalone.workspaceId, { sessionId: standalone.value.workspace.ownerId, sourceId: source.sourceId });
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
