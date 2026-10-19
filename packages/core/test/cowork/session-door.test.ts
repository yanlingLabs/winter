// Session door D4 (docs/research/2026-10-18-cowork-session-door-d4.md): `createCoworkSessionDoor`'s `create`, against a real
// repository, a real session store and the real schedule service, in temp homes. Create is reserve -> store row -> binding,
// each step resumable; a retry never mints a second conversation; a definite bind refusal leaves nothing behind; the host's
// schedule caller is authorized by reference identity and scoped to a dispatching occurrence. Nothing here boots a guest.
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import type { CoworkScheduleDefinition, SessionEvent } from "@yanlinglabs/winter-protocol";
import { CoworkAuthority, type CoworkPrincipal } from "../../src/cowork/authority";
import { CoworkRepository } from "../../src/cowork/repository";
import { createCoworkScheduleDoorPort } from "../../src/cowork/schedule-door-port";
import { CoworkSchedules } from "../../src/cowork/schedules";
import type { CoworkConnection } from "../../src/cowork/service";
import { COWORK_SCHEDULE_CALLER, coworkScheduleDispatchView, createCoworkSessionDoor, type CoworkScheduleDispatchView, type CoworkSessionDoorDeps } from "../../src/cowork/session-door";
import type { CoworkApprovalPort, CoworkGuestRuntimeOffer, CoworkGuestStarter, CoworkSessionCreateInput } from "../../src/cowork/session-ports";
import { CoworkError, type CoworkErrorCode } from "../../src/cowork/types";
import { ProjectionCheckpoints } from "../../src/runtime-state/checkpoints";
import { openRuntimeStateDb, type RuntimeStateDb } from "../../src/runtime-state/db";
import { SessionHub } from "../../src/sessions/hub";
import { SessionStore } from "../../src/sessions/store";
import { FIXTURE_MODEL, standinRoute } from "./session-door-fixture";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

const CEILING = { toolClasses: ["read", "write"], hostServices: [], connectors: [], network: "none" as const };
const FOLDER = { kind: "folder" as const, access: "read-write" as const, label: "fixture", detail: { grantRef: "grant", rootIdentity: "root" } };
const HARNESS: CoworkConnection = { role: "harness", connectionId: 1 };
const LOCAL: CoworkPrincipal = { kind: "local-user", id: "local" };
/** Present, never called: create boots nothing. */
const NATIVE: CoworkGuestStarter = { start: () => { throw new Error("create must not start a guest"); } };
const OFFER: CoworkGuestRuntimeOffer = { profile: "host-query-v1", readiness: ["guest-compartment"], runtimeCapability: { protocolVersion: 1, capabilities: [], supportsConfinedGuestExecution: true } };
const APPROVALS: CoworkApprovalPort = { canUseToolFor: () => { throw new Error("create must not build a bridge"); } };

function world(opts: { ownership?: "standalone" | "project"; production?: boolean; principal?: (connection: CoworkConnection) => CoworkPrincipal | undefined; schedules?: CoworkScheduleDispatchView; sources?: number } = {}) {
  const home = mkdtempSync(join(tmpdir(), "winter-door-d4-")), storeHome = mkdtempSync(join(tmpdir(), "winter-door-d4-store-"));
  const db: RuntimeStateDb = openRuntimeStateDb(home), records = new CoworkRepository(db), store = new SessionStore(storeHome), hub = new SessionHub(store);
  const made = records.create({ principalId: "fixture", requestId: "create" }, { ownership: opts.ownership ?? "project", title: "fixture", defaultPolicy: "ask", ceiling: CEILING, sources: Array.from({ length: opts.sources ?? 1 }, () => FOLDER) });
  const authority = new CoworkAuthority(records, { folder: () => ({ rootIdentity: "root", writable: true, revoked: false }), repository: () => undefined });
  const principalCalls: CoworkConnection[] = [];
  const deps: CoworkSessionDoorDeps = {
    records, authority, store, hub, checkpoints: new ProjectionCheckpoints(db),
    ...(opts.production ? {} : { route: standinRoute(), native: NATIVE, offer: OFFER, approvals: APPROVALS }),
    principal: connection => { principalCalls.push(connection); return (opts.principal ?? (() => LOCAL))(connection); },
    ...(opts.schedules ? { schedules: opts.schedules } : {}),
  };
  const door = createCoworkSessionDoor(deps);
  cleanups.push(() => { void door.drivers.beginShutdown(); store.close(); db.close(); rmSync(home, { recursive: true, force: true }); rmSync(storeHome, { recursive: true, force: true }); });
  const workspaceId = made.workspaceId, sourceId = made.value.sources[0]!.sourceId;
  const input = (over: Partial<CoworkSessionCreateInput> = {}): CoworkSessionCreateInput => ({ scope: "t", workspaceId, requestId: "req", location: { kind: "source", sourceId }, ...over });
  const count = (sql: string, ...args: unknown[]) => (db.db.query(sql).get(...(args as [])) as { n: number }).n;
  return {
    db, records, store, door, deps, made, workspaceId, sourceId, input, principalCalls,
    reservations: () => count("SELECT COUNT(*) AS n FROM cowork_session_reservations"),
    bindings: () => count("SELECT COUNT(*) AS n FROM cowork_conversations"),
    reservation: (sessionId: string) => db.db.query("SELECT principal_id,request_id,state,scope FROM cowork_session_reservations WHERE session_id=?").get(sessionId),
    rows: () => (store as unknown as { db: { query(sql: string): { all(): { session_id: string; mode: string | null; last_seq: number }[] } } }).db.query("SELECT session_id, mode, last_seq FROM sessions").all(),
  };
}
async function refused(promise: Promise<unknown>, code: CoworkErrorCode) {
  const error = await promise.then(() => undefined, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(CoworkError);
  expect((error as CoworkError).code).toBe(code);
}
const createdEvent = (events: readonly SessionEvent[]) => events.filter(event => event.type === "session_created");

// ------------------------------------------------------------------------------------------------ create
test("production shape: with no route (or any port) create refuses provider_unavailable and writes nothing", async () => {
  const w = world({ production: true });
  await refused(w.door.create(w.input(), HARNESS), "provider_unavailable");
  expect([w.reservations(), w.bindings(), w.rows().length]).toEqual([0, 0, 0]);
  expect(w.principalCalls).toEqual([]);
});

test("a Project create, before any boot: the store row, its session_created facts, the binding and the reservation all name one fresh s_ id", async () => {
  const w = world();
  expect(w.records.source(w.workspaceId, w.sourceId).state).toBe("preparing");
  const { sessionId } = await w.door.create(w.input({ location: { kind: "source", sourceId: w.sourceId, relativeCwd: "docs" } }), HARNESS);
  expect(sessionId).toMatch(/^s_[0-9a-f]{12}$/);
  expect(w.store.meta(sessionId)).toMatchObject({ scope: "t", cwd: null, mode: "cowork", model: FIXTURE_MODEL, approvalPolicy: "ask" });
  expect(w.store.dirs(sessionId)).toEqual([]);
  const log = w.store.read(sessionId);
  expect(log).toHaveLength(1);
  expect(log[0]).toMatchObject({ seq: 1, type: "session_created", mode: "cowork", cowork: { workspaceId: w.workspaceId, projectId: w.made.value.workspace.ownerId, location: "source", sourceId: w.sourceId, policyRevision: 1 } });
  expect(w.records.binding(sessionId)).toMatchObject({ workspaceId: w.workspaceId, sourceId: w.sourceId, relativeCwd: "docs", policy: "ask", state: "active" });
  expect(w.reservation(sessionId)).toEqual({ principal_id: "local", request_id: "req", state: "bound", scope: "t" });
  // Nothing booted: the workspace is stopped with no incarnation.
  expect(w.records.get(w.workspaceId)).toMatchObject({ power: "stopped", incarnationId: null });
});

test("a standalone create binds the workspace's own reserved id; any other request for it is conversation_limit", async () => {
  const w = world({ ownership: "standalone" });
  const ownerId = w.made.value.workspace.ownerId;
  expect((await w.door.create(w.input(), HARNESS)).sessionId).toBe(ownerId);
  expect(createdEvent(w.store.read(ownerId))[0]).toMatchObject({ cowork: { projectId: null } });
  await refused(w.door.create(w.input({ requestId: "other" }), HARNESS), "conversation_limit");
  expect([w.reservations(), w.bindings(), w.rows().length]).toEqual([1, 1, 1]);
});

test("idempotent on requestId: the same request answers the same conversation and writes nothing more; other content is request_conflict", async () => {
  const w = world();
  const first = await w.door.create(w.input(), HARNESS), again = await w.door.create(w.input(), HARNESS);
  expect(again).toEqual(first);
  expect([w.reservations(), w.bindings(), w.rows().length, w.store.read(first.sessionId).length]).toEqual([1, 1, 1, 1]);
  for (const changed of [w.input({ scope: "other-scope" }), w.input({ location: { kind: "source", sourceId: w.sourceId, relativeCwd: "elsewhere" } })])
    await refused(w.door.create(changed, HARNESS), "request_conflict");
  // A different request is a different conversation.
  const second = await w.door.create(w.input({ requestId: "req-2" }), HARNESS);
  expect(second.sessionId).not.toBe(first.sessionId);
  expect([w.reservations(), w.bindings(), w.rows().length]).toEqual([2, 2, 2]);
});

test("a concurrent race on one request mints one conversation", async () => {
  const w = world();
  const answers = await Promise.all(Array.from({ length: 6 }, () => w.door.create(w.input(), HARNESS)));
  expect(new Set(answers.map(answer => answer.sessionId)).size).toBe(1);
  expect([w.reservations(), w.bindings(), w.rows().length]).toEqual([1, 1, 1]);
});

// ------------------------------------------------------------------------------------------------ crash and resume
for (const ownership of ["project", "standalone"] as const) {
  test(`${ownership}: a crash after each step resumes at the missing one, with the same id and no second row`, async () => {
    // (a) reserved only: the retry creates the row and binds the reserved id.
    let w = world({ ownership });
    const reserveOnly = (target: ReturnType<typeof world>) => target.records.reserveConversation({ principalId: "local", workspaceId: target.workspaceId, requestId: "req", scope: "t", requestDigest: requestDigestFor(target) }, id => target.store.hasSession(id));
    const reserved = reserveOnly(w);
    expect(w.rows()).toEqual([]);
    expect((await w.door.create(w.input(), HARNESS)).sessionId).toBe(reserved.sessionId);
    expect([w.reservations(), w.bindings(), w.rows().length]).toEqual([1, 1, 1]);

    // (b) reserved and the store row committed, no binding.
    w = world({ ownership });
    const second = reserveOnly(w);
    w.store.ensureCoworkSession("t", second.sessionId, { approvalPolicy: "ask", model: FIXTURE_MODEL, cowork: { workspaceId: w.workspaceId, projectId: null, location: "source", sourceId: w.sourceId, policyRevision: 1 } }, id => w.records.isReservedSession(id));
    expect(w.bindings()).toBe(0);
    expect((await w.door.create(w.input(), HARNESS)).sessionId).toBe(second.sessionId);
    expect([w.reservations(), w.bindings(), w.rows().length, w.store.read(second.sessionId).length]).toEqual([1, 1, 1, 1]);

    // (c) the row INSERT landed but its session_created did not (last_seq 0, no log): the append runs once.
    w = world({ ownership });
    const third = reserveOnly(w);
    (w.store as unknown as { db: { run(sql: string, args: unknown[]): void } }).db.run("INSERT INTO sessions (session_id, scope, created_at, last_seq, mode, dirs) VALUES (?, 't', 0, 0, 'cowork', '[]')", [third.sessionId]);
    expect(w.store.hasCommittedSession(third.sessionId)).toBe(false);
    expect((await w.door.create(w.input(), HARNESS)).sessionId).toBe(third.sessionId);
    expect(createdEvent(w.store.read(third.sessionId))).toHaveLength(1);
    expect(w.store.read(third.sessionId).map(event => event.seq)).toEqual([1]);

    // (d) bound, but the reservation never marked bound: the retry finds the binding and never binds twice.
    w = world({ ownership });
    const fourth = reserveOnly(w);
    w.store.ensureCoworkSession("t", fourth.sessionId, { approvalPolicy: "ask", model: FIXTURE_MODEL, cowork: { workspaceId: w.workspaceId, projectId: null, location: "source", sourceId: w.sourceId, policyRevision: 1 } }, id => w.records.isReservedSession(id));
    w.records.bindConversation({ principalId: "local", requestId: "req", expectedRevision: w.records.get(w.workspaceId).configRevision }, w.workspaceId, { sessionId: fourth.sessionId, sourceId: w.sourceId }, w.store);
    const revision = w.records.get(w.workspaceId).configRevision;
    expect((await w.door.create(w.input(), HARNESS)).sessionId).toBe(fourth.sessionId);
    expect(w.reservation(fourth.sessionId)).toMatchObject({ state: "bound" });
    expect(w.records.get(w.workspaceId).configRevision).toBe(revision);
    expect([w.reservations(), w.bindings(), w.rows().length]).toEqual([1, 1, 1]);
  });
}
/** The door's request digest for `world().input()` (scope t, the first source, cwd "."), recomputed independently. */
function requestDigestFor(w: ReturnType<typeof world>): string {
  const { createHash } = require("node:crypto") as typeof import("node:crypto");
  const value = { location: { kind: "source", relativeCwd: ".", sourceId: w.sourceId }, scope: "t", workspaceId: w.workspaceId };
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

test("a definite bind refusal leaves nothing behind: no binding, no store row, no reservation; the request can start over", async () => {
  const w = world({ sources: 2 });
  const second = w.made.value.sources[1]!.sourceId;
  w.records.removeSource({ principalId: "fixture", requestId: "remove", expectedRevision: w.records.get(w.workspaceId).configRevision }, w.workspaceId, w.sourceId);
  await refused(w.door.create(w.input(), HARNESS), "source_unavailable");
  expect([w.reservations(), w.bindings(), w.rows().length]).toEqual([0, 0, 0]);
  await refused(w.door.create(w.input(), HARNESS), "source_unavailable");
  expect([w.reservations(), w.bindings(), w.rows().length]).toEqual([0, 0, 0]);
  const { sessionId } = await w.door.create(w.input({ requestId: "good", location: { kind: "source", sourceId: second } }), HARNESS);
  expect([w.reservations(), w.bindings(), w.rows().map(row => row.session_id)]).toEqual([1, 1, [sessionId]]);
});

test("refusals before anything is written: outputs location, bad scope or ids, a deleted workspace", async () => {
  const w = world();
  await refused(w.door.create(w.input({ location: { kind: "outputs" } }), HARNESS), "unsupported_topology");
  await refused(w.door.create(w.input({ requestId: "x".repeat(201) }), HARNESS), "invalid_request");
  await refused(w.door.create(w.input({ scope: "Bad Scope" }), HARNESS), "invalid_request");
  await refused(w.door.create(w.input({ location: { kind: "source", sourceId: w.sourceId, relativeCwd: "../up" } }), HARNESS), "invalid_request");
  await refused(w.door.create(w.input({ workspaceId: "missing" }), HARNESS), "not_found");
  expect([w.reservations(), w.bindings(), w.rows().length]).toEqual([0, 0, 0]);
});

// ------------------------------------------------------------------------------------------------ authority
test("only a local user over a harness or admin connection creates; remote, plugin, paired, runtime and unknown callers are refused", async () => {
  for (const [caller, principal] of [
    [{ role: "remote", connectionId: 2 }, LOCAL], [{ role: "plugin", connectionId: 3 }, LOCAL], [HARNESS, undefined],
    [HARNESS, { kind: "paired-user", id: "phone", workspaceIds: new Set<string>(), repositoryAuthorities: new Set<string>() }],
    [HARNESS, { kind: "runtime", id: "rt", sessionId: "s", workspaceId: "w" }],
  ] as [CoworkConnection, CoworkPrincipal | undefined][]) {
    const w = world({ principal: () => principal });
    await refused(w.door.create(w.input(), caller), "authority_denied");
    expect([w.reservations(), w.bindings(), w.rows().length]).toEqual([0, 0, 0]);
  }
  const w = world();
  expect((await w.door.create(w.input(), { role: "admin", connectionId: 9 })).sessionId).toMatch(/^s_/);
});

// ------------------------------------------------------------------------------------------------ the schedule caller
async function scheduled(opts: { target?: "project" | "conversation" } = {}) {
  let view: CoworkScheduleDispatchView | undefined;
  const w = world({ schedules: { dispatching: (workspaceId, occurrenceId) => view!.dispatching(workspaceId, occurrenceId) } });
  let time = 0;
  const sent: string[] = [];
  const port = createCoworkScheduleDoorPort({
    // The real create; drivers stand in (ensure would boot a guest), and record what the port sends.
    door: { create: w.door.create, drivers: { get: () => undefined, ensure: async (sessionId: string) => ({ send: async (text: string) => { sent.push(`${sessionId}:${text}`); return { seq: 1, queued: false }; } }) as never } },
    scope: "t", caller: COWORK_SCHEDULE_CALLER,
  });
  const schedules = new CoworkSchedules(w.records, { folder: () => ({ rootIdentity: "root", writable: true, revoked: false }), repository: () => undefined }, () => time, () => "branch", undefined, port);
  view = coworkScheduleDispatchView(schedules);
  let definition: CoworkScheduleDefinition = { target: { kind: "project", projectId: w.made.value.workspace.ownerId }, sourceId: w.sourceId, prompt: "scheduled work", timing: { kind: "recurring", spec: "every 1s" }, timezone: "UTC", savedCeiling: CEILING, policy: "ask", overlap: "one-active-one-pending" };
  // A conversation target names an existing bound conversation; a user creates it first.
  if (opts.target === "conversation") definition = { ...definition, target: { kind: "conversation", sessionId: (await w.door.create(w.input({ requestId: "existing" }), HARNESS)).sessionId } };
  const made = schedules.create("fixture", w.workspaceId, "schedule", definition); time = 1000; schedules.tick();
  const occurrence = () => schedules.status(made.workspaceId, made.scheduleId).occurrences[0]!;
  return { w, schedules, made, occurrence, sent, tick: (to: number) => { time = to; schedules.tick(); } };
}

test("the schedule caller creates a Project conversation for a dispatching occurrence, end to end through the dispatch port, never consulting host.principal", async () => {
  const s = await scheduled(), row = s.occurrence(), token = s.schedules.claim(s.made.workspaceId, s.made.scheduleId, row.occurrenceId)!;
  const out = await s.schedules.beginDispatch(row.occurrenceId, token);
  if (out.status !== "started") throw new Error(out.status);
  const sessionId = out.receipt.runRef;
  expect(sessionId).toMatch(/^s_[0-9a-f]{12}$/);
  expect(s.sent).toEqual([`${sessionId}:scheduled work`]);
  expect(s.w.reservation(sessionId)).toEqual({ principal_id: "host:schedule", request_id: `schedule:${row.occurrenceId}`, state: "bound", scope: "t" });
  expect(s.w.records.binding(sessionId)).toMatchObject({ workspaceId: s.w.workspaceId, sourceId: s.w.sourceId, relativeCwd: "." });
  expect(s.w.principalCalls).toEqual([]);
  // Replayed while still dispatching: the same conversation, nothing new.
  const input = s.w.input({ requestId: `schedule:${row.occurrenceId}` });
  expect(await s.w.door.create(input, COWORK_SCHEDULE_CALLER)).toEqual({ sessionId });
  expect([s.w.reservations(), s.w.bindings(), s.w.rows().length]).toEqual([1, 1, 1]);
  // Once handled, even a replay of the same request is refused: the authority is the dispatch window, not the reservation.
  s.schedules.handled(row.occurrenceId, token, out.receipt);
  await refused(s.w.door.create(input, COWORK_SCHEDULE_CALLER), "authority_denied");
  expect(s.w.principalCalls).toEqual([]);
});

test("the schedule caller's scope: only its own reference, a dispatching occurrence, a Project target, its own source at the root, a schedule: request id", async () => {
  const s = await scheduled(), row = s.occurrence();
  const input = (over: Partial<CoworkSessionCreateInput> = {}) => s.w.input({ requestId: `schedule:${row.occurrenceId}`, ...over });
  // Claimed but not yet dispatching: refused.
  const token = s.schedules.claim(s.made.workspaceId, s.made.scheduleId, row.occurrenceId)!;
  await refused(s.w.door.create(input(), COWORK_SCHEDULE_CALLER), "authority_denied");
  // A fresh object with the same fields is not the caller: it is an ordinary connection with a role no user has.
  const lookalike: CoworkConnection = { role: COWORK_SCHEDULE_CALLER.role, connectionId: COWORK_SCHEDULE_CALLER.connectionId };
  await refused(s.w.door.create(input(), lookalike), "authority_denied");
  expect(s.w.principalCalls).toEqual([]); // refused on its role before any principal lookup
  // Put the occurrence in `dispatching`, as beginDispatch does before it calls the port (the window the caller may act in).
  s.w.db.db.run("UPDATE cowork_schedule_occurrences SET state='dispatching' WHERE occurrence_id=? AND claim_token=?", [row.occurrenceId, token]);
  for (const [over, what] of [
    [{ requestId: "plain-request" }, "a non-schedule request id"],
    [{ requestId: "schedule:occurrence-unknown" }, "another occurrence"],
    [{ location: { kind: "source", sourceId: s.w.sourceId, relativeCwd: "docs" } }, "a cwd below the root"],
    [{ location: { kind: "source", sourceId: "source-other" } }, "another source"],
    [{ workspaceId: "w-other" }, "another workspace"],
  ] as [Partial<CoworkSessionCreateInput>, string][]) {
    const error = await s.w.door.create(input(over), COWORK_SCHEDULE_CALLER).then(() => undefined, (caught: unknown) => caught);
    expect([what, error instanceof CoworkError ? error.code : error]).toEqual([what, "authority_denied"]);
  }
  expect((await s.w.door.create(input(), COWORK_SCHEDULE_CALLER)).sessionId).toMatch(/^s_/);
  expect([s.w.reservations(), s.w.bindings()]).toEqual([1, 1]);
  expect(s.w.principalCalls).toEqual([]);
});

test("a conversation-target schedule never creates through the schedule caller; without a schedule view the caller is refused", async () => {
  const s = await scheduled({ target: "conversation" }), row = s.occurrence();
  s.w.db.db.run("UPDATE cowork_schedule_occurrences SET state='dispatching' WHERE occurrence_id=?", [row.occurrenceId]);
  await refused(s.w.door.create(s.w.input({ requestId: `schedule:${row.occurrenceId}` }), COWORK_SCHEDULE_CALLER), "authority_denied");
  const bare = world();
  await refused(bare.door.create(bare.input({ requestId: "schedule:occurrence-x" }), COWORK_SCHEDULE_CALLER), "authority_denied");
  expect([bare.reservations(), bare.principalCalls]).toEqual([0, []]);
});

test("the schedule caller is frozen, and its request id fits the repository's 200-character id grammar", () => {
  expect(Object.isFrozen(COWORK_SCHEDULE_CALLER)).toBe(true);
  expect(() => { (COWORK_SCHEDULE_CALLER as { role: string }).role = "harness"; }).toThrow();
  expect(`schedule:${"o".repeat(191)}`.length).toBe(200);
});

// ------------------------------------------------------------------------------------------------ the store's Cowork rows
test("the store: createSession still refuses cowork; ensureCoworkSession admits only a reserved id and never adopts a Code row; reaper, cleaner and delete leave a Cowork row alone", async () => {
  const w = world();
  expect(() => w.store.createSession("t", { mode: "cowork" as never })).toThrow("unsupported_topology");
  const facts = { workspaceId: w.workspaceId, projectId: null, location: "source" as const, sourceId: w.sourceId, policyRevision: 1 };
  expect(() => w.store.ensureCoworkSession("t", "s_0123456789ab", { approvalPolicy: "ask", model: FIXTURE_MODEL, cowork: facts }, () => false)).toThrow("authority_denied");
  const code = w.store.createSession("t", { mode: "code" });
  expect(() => w.store.ensureCoworkSession("t", code, { approvalPolicy: "ask", model: FIXTURE_MODEL, cowork: facts }, () => true)).toThrow("authority_denied");
  expect(w.store.meta(code).mode).toBe("code");
  const { sessionId } = await w.door.create(w.input(), HARNESS);
  expect(() => w.store.ensureCoworkSession("other", sessionId, { approvalPolicy: "ask", model: FIXTURE_MODEL, cowork: facts }, () => true)).toThrow("authority_denied");
  const later = Date.now() + 365 * 24 * 3600_000;
  // The control: the empty Code session IS a reaper and cleaner candidate; the Cowork row never is.
  expect(w.store.emptySessionIds(() => 0, later)).toEqual([code]);
  expect(w.store.cleanerCandidateIds(later)).toEqual([code]);
  expect(() => w.store.deleteSession(sessionId)).toThrow("unsupported_topology");
  expect(() => w.store.withdrawCoworkSession(sessionId, () => true)).toThrow("authority_denied");
  expect(() => w.store.withdrawCoworkSession(code, () => false)).toThrow("authority_denied");
  expect(w.store.hasSession(sessionId)).toBe(true);
});

// ------------------------------------------------------------------------------------------------ pins
const PACKAGES = join(import.meta.dir, "..", "..", "..");
const sourcesUnder = (dir: string): string[] => readdirSync(dir, { recursive: true }).map(String).map(name => join(dir, name)).filter(path => /\.(ts|tsx|js|mjs)$/.test(path) && statSync(path).isFile());
const allSources = () => readdirSync(PACKAGES).flatMap(name => { const src = join(PACKAGES, name, "src"); return existsSync(src) && statSync(src).isDirectory() ? sourcesUnder(src) : []; });
const shown = (path: string) => relative(PACKAGES, path).split(sep).join("/");
const code = (path: string) => readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

test("pins: the door module alone calls the reservation and Cowork-row writers and names the schedule caller; nothing in src builds a door", () => {
  const sources = allSources();
  expect(sources.length).toBeGreaterThan(100);
  const callers = (pattern: RegExp) => sources.filter(path => pattern.test(code(path))).map(shown).sort();
  for (const method of ["reserveConversation", "completeReservation", "withdrawReservation", "isReservedSession"])
    expect([method, callers(new RegExp(`\\.${method}\\(`))]).toEqual([method, ["core/src/cowork/session-door.ts"]]);
  for (const method of ["ensureCoworkSession", "withdrawCoworkSession"])
    expect([method, callers(new RegExp(`\\.${method}\\(`))]).toEqual([method, ["core/src/cowork/session-door.ts"]]);
  expect(callers(/\bCOWORK_SCHEDULE_CALLER\b/)).toEqual(["core/src/cowork/session-door.ts"]);
  expect(callers(/\bcreateCoworkSessionDoor\b/)).toEqual(["core/src/cowork/session-door.ts"]);
  // The authority check is by reference, and comes before any principal lookup.
  const door = code(join(PACKAGES, "core", "src", "cowork", "session-door.ts"));
  expect(door).toMatch(/caller === COWORK_SCHEDULE_CALLER \? scheduleAuthority\(input\) : userAuthority\(input, caller\)/);
  expect(door).not.toMatch(/caller\.role === "host-schedule"|role === COWORK_SCHEDULE_CALLER\.role/);
});
