import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authorityFixtureSessions } from "./committed-sessions";
import { openRuntimeStateDb, type RuntimeStateDb } from "../../src/runtime-state/db";
import { CoworkRepository } from "../../src/cowork/repository";
import { CoworkSchedules } from "../../src/cowork/schedules";
import { COWORK_SCHEDULE_DEFINITE_REFUSALS, createCoworkScheduleDoorPort } from "../../src/cowork/schedule-door-port";
import type { CoworkScheduleDoor } from "../../src/cowork/schedule-door-port";
import { CoworkError, type CoworkErrorCode } from "../../src/cowork/types";
import type { CoworkScheduleDefinition } from "@yanlinglabs/winter-protocol";

const homes: string[] = [], handles: RuntimeStateDb[] = [];
const caps = { toolClasses: ["read", "write"], hostServices: [], connectors: [], network: "internet" as const };
afterEach(() => { handles.splice(0).forEach(db => db.close()); homes.splice(0).forEach(home => rmSync(home, { recursive: true, force: true })); });

type Behavior = {
  create?: (input: Parameters<CoworkScheduleDoor["create"]>[0]) => Promise<{ sessionId: string }> | { sessionId: string };
  get?: (sessionId: string) => unknown; ensure?: (sessionId: string) => unknown; send?: (text: string, clientName?: string) => unknown;
};
/** A fake door that records every call in order and never runs anything. */
function fakeDoor(behavior: Behavior = {}) {
  const calls: { op: string; args: unknown[] }[] = [];
  const note = (op: string, ...args: unknown[]) => calls.push({ op, args });
  const session = { send: async (text: string, clientName?: string) => { note("send", text, clientName); return (behavior.send ? await behavior.send(text, clientName) : { seq: 1, queued: false }); } };
  const door = {
    async create(input: Parameters<CoworkScheduleDoor["create"]>[0], caller: unknown) { note("create", input, caller); return behavior.create ? await behavior.create(input) : { sessionId: "created-session" }; },
    drivers: {
      get(sessionId: string) { note("get", sessionId); return behavior.get ? behavior.get(sessionId) : undefined; },
      async ensure(sessionId: string) { note("ensure", sessionId); return behavior.ensure ? await behavior.ensure(sessionId) : session; },
    },
  } as unknown as CoworkScheduleDoor;
  return { door, calls, session, count: (op: string) => calls.filter(call => call.op === op).length };
}

function fixture(door: CoworkScheduleDoor, target: "project" | "conversation" = "project") {
  const home = mkdtempSync(join(tmpdir(), "winter-schedule-door-")); homes.push(home);
  const db = openRuntimeStateDb(home); handles.push(db); const records = new CoworkRepository(db);
  const made = records.create({ principalId: "fixture", requestId: "workspace" }, { ownership: "project", title: "Fixture", ceiling: caps, sources: [{ kind: "folder", label: "fixture", access: "read-write", detail: { grantRef: "fixture-grant", rootIdentity: "fixture-root" } }] });
  const grants = { folder: () => ({ rootIdentity: "fixture-root", writable: true, revoked: false }), repository: () => undefined };
  let time = 0; const sourceId = made.value.sources[0]!.sourceId;
  const port = createCoworkScheduleDoorPort({ door, scope: "fixture-scope", caller: { role: "harness", connectionId: 7 } });
  const schedules = new CoworkSchedules(records, grants, () => time, () => "branch", undefined, port);
  let definition: CoworkScheduleDefinition = { target: { kind: "project", projectId: made.value.workspace.ownerId }, sourceId, prompt: "fixture work", timing: { kind: "recurring", spec: "every 1s" }, timezone: "UTC", savedCeiling: caps, policy: "auto", overlap: "one-active-one-pending" };
  if (target === "conversation") {
    const epoch = records.beginIncarnation(made.workspaceId, "fixture-epoch", 1); records.acknowledgeSource(epoch, sourceId, 1, "ready");
    records.bindConversation({ principalId: "fixture", requestId: "binding", expectedRevision: 1 }, made.workspaceId, { sessionId: "fixture-conversation", sourceId }, authorityFixtureSessions("fixture-conversation"));
    definition = { ...definition, target: { kind: "conversation", sessionId: "fixture-conversation" } };
  }
  const a = schedules.create("fixture", made.workspaceId, "schedule", definition); time = 1000; schedules.tick();
  const row = schedules.status(a.workspaceId, a.scheduleId).occurrences[0]!;
  const durable = () => db.db.query("SELECT state,reason,claim_token FROM cowork_schedule_occurrences WHERE occurrence_id=?").get(row.occurrenceId) as { state: string; reason: string | null; claim_token: string | null };
  const claim = () => schedules.claim(a.workspaceId, a.scheduleId, row.occurrenceId)!;
  return { db, schedules, a, row, durable, claim, definition };
}

test("a Project schedule mints a fresh conversation through the door, sends the prompt as 'schedule' and is handled only by its receipt", async () => {
  const d = fakeDoor(), f = fixture(d.door), token = f.claim();
  const out = await f.schedules.beginDispatch(f.row.occurrenceId, token); if (out.status !== "started") throw new Error(out.status);
  expect(out.receipt.runRef).toBe("created-session");
  expect(d.calls.map(call => call.op)).toEqual(["create", "get", "ensure", "send"]);
  expect(d.calls[0]!.args).toEqual([{ scope: "fixture-scope", workspaceId: f.a.workspaceId, requestId: `schedule:${f.row.occurrenceId}`, location: { kind: "source", sourceId: f.definition.sourceId } }, { role: "harness", connectionId: 7 }]);
  expect(d.calls[3]!.args).toEqual(["fixture work", "schedule"]);
  expect(f.durable()).toMatchObject({ state: "dispatching", claim_token: token }); // the port never waits for the turn
  f.schedules.handled(f.row.occurrenceId, token, out.receipt); expect(f.durable().state).toBe("handled");
});

test("a conversation schedule continues its own conversation: a live driver is reused, otherwise it is ensured, and no conversation is created", async () => {
  const live = fakeDoor({ get: () => ({ send: async () => ({ seq: 1, queued: true }) }) }), a = fixture(live.door, "conversation");
  expect((await a.schedules.beginDispatch(a.row.occurrenceId, a.claim())).status).toBe("started"); // queued: true is still accepted
  expect(live.calls.map(call => call.op)).toEqual(["get"]);
  const cold = fakeDoor(), b = fixture(cold.door, "conversation"), out = await b.schedules.beginDispatch(b.row.occurrenceId, b.claim());
  expect(out.status).toBe("started"); expect(cold.calls.map(call => call.op)).toEqual(["get", "ensure", "send"]); expect(cold.calls.map(call => call.args[0])).toEqual(["fixture-conversation", "fixture-conversation", "fixture work"]);
  if (out.status === "started") expect(out.receipt.runRef).toBe("fixture-conversation");
});

const definite: CoworkErrorCode[] = ["provider_unavailable", "conversation_limit", "cold_resume_unavailable", "unsupported_topology", "authority_denied", "source_unavailable", "not_found"];
const stages = ["create", "ensure", "send"] as const;
const failing = (stage: (typeof stages)[number], error: unknown): Behavior => ({ [stage]: () => { throw error; } } as Behavior);

test("every definite refusal, at create, ensure or send, is not-started: back to pending/execution_unavailable, and a retry reuses the same create request id", async () => {
  expect([...COWORK_SCHEDULE_DEFINITE_REFUSALS].sort()).toEqual([...definite].sort());
  for (const code of definite) for (const stage of stages) {
    let refuse = true; const base: Behavior = failing(stage, new CoworkError(code));
    const d = fakeDoor({ ...base, [stage]: (...args: unknown[]) => { if (refuse) return (base[stage] as (...a: unknown[]) => unknown)(...args); return stage === "create" ? { sessionId: "created-session" } : stage === "ensure" ? undefined : { seq: 1, queued: false }; } } as Behavior);
    // The retry path needs a real session from ensure; give the second attempt one.
    if (stage === "ensure") (d.door.drivers as any).ensure = async (id: string) => { d.calls.push({ op: "ensure", args: [id] }); if (refuse) throw new CoworkError(code); return d.session; };
    const f = fixture(d.door), first = f.claim(), out = await f.schedules.beginDispatch(f.row.occurrenceId, first);
    expect({ code, stage, out }).toEqual({ code, stage, out: { status: "not-started" } });
    expect({ code, stage, durable: f.durable() }).toEqual({ code, stage, durable: { state: "pending", reason: "execution_unavailable", claim_token: null } });
    if (stage !== "send") expect(d.count("send")).toBe(0);
    refuse = false; const second = f.claim(); expect(second).not.toBe(first);
    expect((await f.schedules.beginDispatch(f.row.occurrenceId, second)).status).toBe("started");
    const creates = d.calls.filter(call => call.op === "create").map(call => (call.args[0] as { requestId: string }).requestId);
    expect(new Set(creates).size).toBe(1); // one create request id per occurrence, however many attempts
  }
});

test("anything that is not a definite refusal is uncertain, durably, and is never replayed", async () => {
  const unknowns: unknown[] = [new CoworkError("recovery_required"), new CoworkError("revision_conflict"), new Error("transport reset secret-detail"), "a string", undefined, { code: "conversation_limit" }];
  for (const error of unknowns) for (const stage of stages) {
    const d = fakeDoor(failing(stage, error)), f = fixture(d.door), token = f.claim(), out = await f.schedules.beginDispatch(f.row.occurrenceId, token);
    expect({ stage, out }).toEqual({ stage, out: { status: "uncertain" } }); expect(JSON.stringify(out)).not.toContain("secret");
    expect(f.durable()).toMatchObject({ state: "uncertain", reason: "recovery_required" });
    expect(f.schedules.claim(f.a.workspaceId, f.a.scheduleId, f.row.occurrenceId)).toBeUndefined();
    expect(d.count("send")).toBeLessThanOrEqual(1);
    f.schedules.recover(); f.schedules.tick(); expect(d.count("send")).toBeLessThanOrEqual(1); expect(f.durable().state).toBe("uncertain");
  }
});

test("a session id the host cannot acknowledge is refused before anything is sent", async () => {
  const d = fakeDoor({ create: () => ({ sessionId: "not a valid run ref" }) }), f = fixture(d.door), out = await f.schedules.beginDispatch(f.row.occurrenceId, f.claim());
  expect(out).toEqual({ status: "not-started" }); expect(d.count("send")).toBe(0); expect(d.count("ensure")).toBe(0);
});

test("without a port nothing changes: beginDispatch refuses unsupported_topology and the door is never touched", () => {
  const d = fakeDoor(), f = fixture(d.door);
  const home = mkdtempSync(join(tmpdir(), "winter-schedule-door-")); homes.push(home);
  const db = openRuntimeStateDb(home); handles.push(db);
  const bare = new CoworkSchedules(new CoworkRepository(f.db as unknown as RuntimeStateDb), { folder: () => undefined, repository: () => undefined } as never);
  expect(() => bare.beginDispatch("occurrence", "token")).toThrow("unsupported_topology"); expect(d.calls).toEqual([]);
  expect(f.schedules.status(f.a.workspaceId, f.a.scheduleId).execution).toBe("unavailable");
});

test("anti-wiring: the door port is imported by no src file, takes only types from the ports and the error class from types", () => {
  const packages = join(import.meta.dir, "..", "..", ".."), module = join(packages, "core", "src", "cowork", "schedule-door-port.ts");
  expect(existsSync(module)).toBe(true);
  const files = readdirSync(packages, { withFileTypes: true }).filter(entry => entry.isDirectory() && existsSync(join(packages, entry.name, "src"))).flatMap(entry => readdirSync(join(packages, entry.name, "src"), { recursive: true, withFileTypes: true }).filter(e => e.isFile() && /\.(ts|tsx|js|mjs|cjs)$/.test(e.name)).map(e => join(e.parentPath, e.name)));
  expect(files.length).toBeGreaterThan(100);
  for (const file of files.filter(candidate => candidate !== module)) { const text = readFileSync(file, "utf8"); for (const needle of ["schedule-door-port", "createCoworkScheduleDoorPort", "COWORK_SCHEDULE_DEFINITE_REFUSALS"]) expect(`${file.slice(packages.length)}:${needle}:${text.includes(needle)}`).toBe(`${file.slice(packages.length)}:${needle}:false`); }
  const imports = [...readFileSync(module, "utf8").matchAll(/^import (type )?[^;]*from "([^"]+)";$/gm)].map(match => `${match[1] ? "type " : ""}${match[2]}`).sort();
  expect(imports).toEqual(["./types", "type ./schedule-dispatch", "type ./service", "type ./session-ports"]);
  const text = readFileSync(module, "utf8"); for (const forbidden of ["beginDispatch", ".handled(", ".uncertain(", "schedules\"", "Bun.", "node:", "process.env"]) expect([forbidden, text.includes(forbidden)]).toEqual([forbidden, false]);
});
