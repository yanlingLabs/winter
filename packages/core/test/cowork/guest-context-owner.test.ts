import { authorityFixtureSessions } from "./committed-sessions";
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { inspect } from "node:util";
import { CoworkAuthority } from "../../src/cowork/authority";
import { createCoworkRuntimeContextHandler, type CoworkRuntimeContextRequest } from "../../src/cowork/current-context-callback";
import type { CoworkContextRegistration } from "../../src/cowork/current-context";
import { COWORK_SHARED_INSTRUCTION_VIEW, type CoworkInstructionReadRequest, type CoworkInstructionReadResult, type CoworkProtectedInstructionReader } from "../../src/cowork/current-context-resolver";
import { coworkGuestSourceRoot } from "../../src/cowork/guest-paths";
import * as ownerModule from "../../src/cowork/guest-context-owner";
import { captureCoworkGuestOwner, COWORK_GUEST_OWNER_READER_LIMITS, CoworkGuestContextOwners, type CoworkGuestContextOwner, type CoworkGuestOwnerCapture, type CoworkGuestOwnerEvidence, type CoworkGuestOwnerEvidencePort } from "../../src/cowork/guest-context-owner";
import { CoworkGuestRuntimeSupervisor, type GuestRuntimeLaunch } from "../../src/cowork/guest-runtime";
import { CoworkRepository } from "../../src/cowork/repository";
import type { CapabilityCeiling } from "../../src/cowork/types";
import { openRuntimeStateDb, type RuntimeStateDb } from "../../src/runtime-state/db";
import { RuntimeSessionRecords } from "../../src/runtime-state/records";

const roots: string[] = [], databases: RuntimeStateDb[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) { try { db.close(); } catch { /* a test closed it deliberately */ } }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const boot = "12345678-1234-1234-1234-123456789abc", otherBoot = "12345678-1234-1234-1234-123456789abd";
const BACKEND = "backend-current", PARENT = "logical-parent", BINDING = "correlation-one", REGISTRATION = "reader-registration-one";
const caps: CapabilityCeiling = { toolClasses: ["read", "write", "execute"], hostServices: ["git.publish"], connectors: [], network: "internet" };
const sortedCaps: CapabilityCeiling = { ...caps, toolClasses: ["execute", "read", "write"] };
const supervisorCapability = { protocolVersion: 1, capabilities: ["confined-guest-posture-v1"], supportsConfinedGuestExecution: true };
const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
function reply(request: CoworkInstructionReadRequest): CoworkInstructionReadResult {
  const blocks = [
    { requestedPath: request.scopes.shared.path, admittedPath: `${COWORK_SHARED_INSTRUCTION_VIEW}/WINTER.md`, text: "shared guidance", sha256: sha("shared guidance"), tier: "workspace" as const },
    { requestedPath: `${request.scopes.source.root}/WINTER.md`, admittedPath: `${request.scopes.source.root}/WINTER.md`, text: "source guidance", sha256: sha("source guidance"), tier: "project" as const },
  ];
  return { request: structuredClone(request), tiers: "admitted-only", blocks, files: blocks.map(block => ({ ...block, depth: 0 })) };
}

/** The evidence port is a FAKE. A positive result in this file proves the slot's own logic (phases,
 * write-once attachments, registry currency, canonical agreement, closed shapes). It never proves
 * issuer authenticity, kernel facts or native admission: no production evidence port exists. */
function fakeEvidence() {
  const fake = { calls: 0, bindingId: BINDING, override: undefined as undefined | ((evidence: Record<string, any>, capture: CoworkGuestOwnerCapture) => unknown) };
  const port: CoworkGuestOwnerEvidencePort = { evidence(capture) {
    fake.calls++;
    const evidence = { profile: "host-query-guided-v1", registrationId: REGISTRATION, launchId: capture.launchId, bindingId: fake.bindingId, kernel: { pidfs: true, peerPidfd: true },
      owner: { workspaceId: capture.workspaceId, logicalSessionId: capture.sessionId, backendSessionId: capture.backendSessionId, incarnationId: capture.incarnationId, leaseEpoch: capture.leaseEpoch, bootId: capture.bootId, generation: capture.backendGeneration } };
    return (fake.override ? fake.override(evidence, capture) : evidence) as CoworkGuestOwnerEvidence;
  } };
  return { fake, port };
}

/** Real canonical DB, repository and runtime rows. Launches come from the REAL supervisor's prepareQuery
 * with a port that is never opened (no spawn, no native effect). Backend id equals the trusted query id. */
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "winter-guest-owner-")); roots.push(home);
  const db = openRuntimeStateDb(home); databases.push(db);
  let mint = 0, currentBoot = boot, held = true;
  const records = new CoworkRepository(db, () => "2026-10-16T00:00:00.000Z", prefix => `${prefix}_${++mint}`);
  const workspaceId = records.create({ principalId: "fixture", requestId: "create" }, {
    ownership: "project", title: "fixture", ceiling: caps,
    sources: [{ kind: "githubRepository", label: "fixture", access: "read-write", detail: { repositoryId: "repo-one", authorityRef: "private-authority", initialRef: "main" } }],
  }).workspaceId;
  const source = records.sources(workspaceId)[0]!, root = coworkGuestSourceRoot(source);
  const epoch = records.beginIncarnation(workspaceId, "incarnation", 1);
  records.acknowledgeSource(epoch, source.sourceId, source.revision, "ready");
  const sessions = new RuntimeSessionRecords(db, () => "2026-10-16T00:00:00.000Z");
  const backends = new Map<string, string>(), known = [PARENT];
  function conversation(sessionId: string, backendSessionId: string, relativeCwd: string, parent?: string) {
    if (sessionId !== PARENT) known.push(sessionId);
    records.bindConversation({ principalId: "fixture", requestId: `bind-${sessionId}`, expectedRevision: records.get(workspaceId).configRevision }, workspaceId, { sessionId, sourceId: source.sourceId, relativeCwd }, authorityFixtureSessions(...known));
    sessions.create({ winterSessionId: sessionId, runtimeKind: "winter-agent", backendSessionId, providerId: "fixture", modelRef: "fixture", ...(parent ? { parentWinterSessionId: parent } : {}),
      backendRoot: "/private/protected/backend", transcriptProjectKey: "private-key", memoryProjectKey: "private-key", tempProjectKey: "private-key",
      transcriptHealth: "clean", compatibilityLevel: "full-filesystem", conformanceCorpusVersion: "fixture", versionProvenance: "legacy-unknown", capabilities: [],
      selection: { runtimeKind: "winter-agent", providerId: "fixture", modelRef: "fixture", family: "openai", authFamily: "api-key", sdkVersion: "fixture", reason: "test", decidedAt: "2026-10-16T00:00:00.000Z" } });
    sessions.transition(sessionId, "ready"); sessions.bumpGeneration(sessionId, { runtimeKind: "winter-agent", backendSessionId }); sessions.transition(sessionId, "running");
    backends.set(sessionId, backendSessionId);
  }
  conversation(PARENT, BACKEND, "directory");
  const authority = new CoworkAuthority(records, { folder: () => undefined, repository: () => ({ readable: true, writable: true, revoked: false }) });
  const supervisor = new CoworkGuestRuntimeSupervisor({ records, authority, identity: sessionId => ({ backendSessionId: backends.get(sessionId)!, model: "winter-test/echo", resume: false }), bootId: () => currentBoot,
    runtimeCapability: supervisorCapability, port: { open() { throw new Error("the fixture port is never opened"); } } });
  const launch = (sessionId = PARENT): Readonly<GuestRuntimeLaunch> => supervisor.prepareQuery(sessionId).launch;
  const deps = { records, bootId: () => currentBoot };
  const { fake, port } = fakeEvidence();
  const registry = new CoworkGuestContextOwners({ ...deps, evidence: port });
  const capture = (sessionId = PARENT) => captureCoworkGuestOwner(deps, launch(sessionId));
  /** Prepare + correlate + attach: the owner a host would hold once its guest lifetime is held. */
  function ready(sessionId = PARENT, lifetime = { held: () => held }) {
    const owner = registry.prepare(capture(sessionId)); owner.bindCorrelation({ version: 1, bindingId: BINDING }); owner.attachLifetime(lifetime); return owner;
  }
  const trusted = (sessionId = PARENT) => backends.get(sessionId)!;
  const request: CoworkRuntimeContextRequest = { bindingId: BINDING, sessionId: BACKEND, cwd: `${root}/directory`, purpose: "generation", attempt: 1 };
  const options = { signal: new AbortController().signal, trustedQuerySessionId: BACKEND };
  const grants = { folder() { return undefined; }, repository() { return { readable: true, writable: true, revoked: false }; } };
  const handler = (owner: CoworkGuestContextOwner, read: CoworkProtectedInstructionReader["read"]) => createCoworkRuntimeContextHandler({
    records, grants, trustedQuerySessionId: BACKEND, currentRegistration: owner.registrationPort, currentBootId: () => currentBoot, reader: { read } });
  const sql = (statement: string, ...args: (string | number)[]) => { db.db.run(statement, args); };
  return { home, db, records, sessions, workspaceId, source, root, epoch, registry, fake, port, deps, launch, capture, ready, trusted, request, options, handler, sql, conversation,
    setBoot: (value: string) => { currentBoot = value; }, setHeld: (value: boolean) => { held = value; } };
}
type Fixture = ReturnType<typeof fixture>;
const refused = (pending: Promise<unknown>) => expect(pending).rejects.toThrow(/^required_context_unavailable$/);
const code = (run: () => unknown) => { try { run(); } catch (error) { return (error as { code?: string }).code ?? (error as Error).message; } return "no-throw"; };
const REGISTRATION_KEYS = ["admittedSources", "backendGeneration", "backendSessionId", "bootId", "capabilities", "executionPosture", "incarnationId", "leaseEpoch", "platform", "sessionId", "state", "trustedQuerySessionId", "workspaceId"];

test("capture binds canonical rows, the backend generation and the trusted query identity", () => {
  const f = fixture(), launch = f.launch(), capture = captureCoworkGuestOwner(f.deps, launch), row = f.sessions.get(PARENT)!;
  expect(capture).toEqual({ homeId: f.records.recordedHomeIdentity(), workspaceId: f.workspaceId, sessionId: PARENT, backendSessionId: BACKEND, trustedQuerySessionId: BACKEND, backendGeneration: row.generation,
    bootId: boot, incarnationId: "incarnation", leaseEpoch: f.epoch.leaseEpoch, launchId: launch.launchId,
    source: { sourceId: f.source.sourceId, revision: f.source.revision, root: f.root, access: "read-write" }, cwd: `${f.root}/directory`, capabilities: sortedCaps } as unknown as CoworkGuestOwnerCapture);
  expect(row.generation).toBeGreaterThanOrEqual(1);
  expect(capture.trustedQuerySessionId).toBe(capture.backendSessionId); expect(capture.sessionId).not.toBe(capture.backendSessionId);
  expect(Object.isFrozen(capture) && Object.isFrozen(capture.source) && Object.isFrozen(capture.capabilities) && Object.isFrozen(capture.capabilities.toolClasses)).toBe(true);
  expect(capture.readerRegistrationId).toBeUndefined(); expect(capture.views).toBeUndefined(); expect(capture.limits).toBeUndefined();
});

test("a capture takes the generation from the canonical runtime row, never from the launch", () => {
  const f = fixture(); const launch = f.launch(); f.sessions.bumpGeneration(PARENT, { runtimeKind: "winter-agent", backendSessionId: BACKEND });
  expect(captureCoworkGuestOwner(f.deps, launch).backendGeneration).toBe(f.sessions.get(PARENT)!.generation);
});

test("forged objects, clones and DTOs are refused by capture and by prepare", () => {
  const f = fixture(), launch = f.launch(), capture = f.capture();
  const frozen = <T>(value: T): T => { for (const child of Object.values(value as object)) if (child && typeof child === "object") Object.freeze(child); return Object.freeze(value); };
  const forged: unknown[] = [structuredClone(launch), JSON.parse(JSON.stringify(launch)), { ...launch }, null, "launch", [], {},
    frozen({ ...launch, limits: { ...launch.limits } }), frozen({ ...launch, scope: { ...launch.scope, homeId: "home_foreign" } }),
    frozen({ ...launch, scope: { ...launch.scope, backendSessionId: "backend-other" } }), frozen({ ...launch, runtime: { ...launch.runtime, sessionId: "trusted-other" } }),
    frozen({ ...launch, runtime: { ...launch.runtime, cwd: `${f.root}/elsewhere` } }), frozen({ ...launch, source: { ...launch.source, revision: launch.source.revision + 1 } }),
    frozen({ ...launch, capabilities: { ...launch.capabilities, hostServices: ["git.publish", "extra.service"] } }),
    frozen({ ...launch, scope: Object.defineProperty({ ...launch.scope }, "workspaceId", { get: () => f.workspaceId, enumerable: true }) })];
  for (const bad of forged) expect(code(() => captureCoworkGuestOwner(f.deps, bad as GuestRuntimeLaunch))).not.toBe("no-throw");
  expect(() => captureCoworkGuestOwner(f.deps, launch)).not.toThrow();
  for (const bad of [structuredClone(capture), JSON.parse(JSON.stringify(capture)), { ...capture }, Object.create(capture), null, undefined, "capture", 7, {}])
    expect(code(() => f.registry.prepare(bad as CoworkGuestOwnerCapture))).toBe("authority_denied");
  expect(f.fake.calls).toBe(0);
});

test("wrong parent or child: another logical session, a child row and a changed backend id cannot be captured", () => {
  const f = fixture(), launch = f.launch();
  f.conversation("child-one", "backend-child", "child", PARENT);
  expect(code(() => f.capture("child-one"))).toBe("stale_acknowledgment");
  const swapped = Object.freeze({ ...launch, scope: Object.freeze({ ...launch.scope, sessionId: "child-one" }) });
  expect(code(() => captureCoworkGuestOwner(f.deps, swapped))).not.toBe("no-throw");
  f.conversation("logical-two", "backend-two", "two");
  const mixed = Object.freeze({ ...launch, scope: Object.freeze({ ...launch.scope, sessionId: "logical-two" }) });
  expect(code(() => captureCoworkGuestOwner(f.deps, mixed))).not.toBe("no-throw");
  f.sql("UPDATE runtime_sessions SET backend_session_id=? WHERE winter_session_id=?", "backend-moved", PARENT);
  expect(code(() => captureCoworkGuestOwner(f.deps, launch))).toBe("stale_acknowledgment");
});

test("a lookup needs the trusted query id, which differs from the logical parent id", () => {
  const f = fixture(), owner = f.ready();
  expect(owner.registrationPort(BACKEND)?.sessionId).toBe(PARENT);
  for (const wrong of [PARENT, "foreign-query", "", " backend-current", undefined, null, 7, {}, [BACKEND], Symbol("x")]) expect(owner.registrationPort(wrong as string)).toBeUndefined();
});

const drift: [string, (f: Fixture) => void][] = [
  ["stale boot", f => f.setBoot(otherBoot)],
  ["stale incarnation", f => f.sql("UPDATE cowork_workspaces SET incarnation_id='incarnation-two' WHERE workspace_id=?", f.workspaceId)],
  ["stale lease epoch", f => f.sql("UPDATE cowork_workspaces SET lease_epoch=lease_epoch+1 WHERE workspace_id=?", f.workspaceId)],
  ["workspace stopped", f => f.sql("UPDATE cowork_workspaces SET power='stopped' WHERE workspace_id=?", f.workspaceId)],
  ["workspace draining", f => f.sql("UPDATE cowork_workspaces SET power='draining' WHERE workspace_id=?", f.workspaceId)],
  ["workspace archived", f => f.sql("UPDATE cowork_workspaces SET state='archived' WHERE workspace_id=?", f.workspaceId)],
  ["generation bumped", f => { f.sessions.bumpGeneration(PARENT, { runtimeKind: "winter-agent", backendSessionId: BACKEND }); }],
  ["backend id changed", f => f.sql("UPDATE runtime_sessions SET backend_session_id='backend-moved' WHERE winter_session_id=?", PARENT)],
  ["runtime row gone", f => { f.sql("PRAGMA foreign_keys=OFF"); f.sql("DELETE FROM runtime_sessions WHERE winter_session_id=?", PARENT); }],
  ["runtime state exited", f => { f.sessions.transition(PARENT, "exited"); }],
  ["runtime state idle is still live", () => {}],
  ["runtime row becomes a child", f => { f.conversation("child-one", "backend-child", "child"); f.sql("UPDATE runtime_sessions SET parent_winter_session_id='child-one' WHERE winter_session_id=?", PARENT); }],
  ["binding archived", f => f.sql("UPDATE cowork_conversations SET state='archived' WHERE session_id=?", PARENT)],
  ["binding removed", f => { f.sql("PRAGMA foreign_keys=OFF"); f.sql("DELETE FROM cowork_conversations WHERE session_id=?", PARENT); }],
  ["home identity replaced", f => f.sql("UPDATE cowork_home_identity SET home_id='home_other'")],
];
for (const [name, change] of drift) {
  test(`canonical drift (${name}) makes the lookup unavailable; the slot never revives`, () => {
    const f = fixture(), owner = f.ready();
    const before = owner.registrationPort(BACKEND); expect(before).toBeDefined();
    change(f);
    const after = owner.registrationPort(BACKEND);
    if (name.endsWith("still live")) { expect(after).toEqual(before); return; }
    expect(after).toBeUndefined(); expect(owner.phase).toBe("open");
  });
}
test("a stale boot returns once the canonical boot matches again, because only phases are one-way", () => {
  const f = fixture(), owner = f.ready(); f.setBoot(otherBoot);
  expect(owner.registrationPort(BACKEND)).toBeUndefined(); f.setBoot(boot); expect(owner.registrationPort(BACKEND)?.bootId).toBe(boot);
});

test("lookup needs the write-once correlation and lifetime, and checks cheap guards before the evidence port", () => {
  const f = fixture(), owner = f.registry.prepare(f.capture());
  expect(owner.phase).toBe("open"); expect(owner.registrationPort(BACKEND)).toBeUndefined();
  owner.attachLifetime({ held: () => true }); expect(owner.registrationPort(BACKEND)).toBeUndefined();
  const other = fixture(), second = other.registry.prepare(other.capture());
  second.bindCorrelation({ version: 1, bindingId: BINDING }); expect(second.registrationPort(BACKEND)).toBeUndefined();
  owner.bindCorrelation({ version: 1, bindingId: BINDING }); expect(owner.registrationPort(BACKEND)?.backendSessionId).toBe(BACKEND);
  expect(f.fake.calls).toBe(1); expect(other.fake.calls).toBe(0);
});

test("correlation and lifetime are write-once, plain data, and refused after a terminal phase", () => {
  const f = fixture(), owner = f.registry.prepare(f.capture());
  for (const bad of [null, undefined, "x", [], {}, { version: 1 }, { bindingId: BINDING }, { version: 2, bindingId: BINDING }, { version: "1", bindingId: BINDING }, { version: 1, bindingId: "" },
    { version: 1, bindingId: "x".repeat(129) }, { version: 1, bindingId: "has space" }, { version: 1, bindingId: 7 }, { version: 1, bindingId: BINDING, extra: true },
    Object.defineProperty({ version: 1 }, "bindingId", { get: () => BINDING, enumerable: true }), Object.assign(Object.create({ inherited: true }), { version: 1, bindingId: BINDING })])
    expect(code(() => owner.bindCorrelation(bad as never))).toBe("invalid_request");
  owner.bindCorrelation({ version: 1, bindingId: BINDING });
  expect(code(() => owner.bindCorrelation({ version: 1, bindingId: "correlation-two" }))).toBe("authority_denied");
  expect(code(() => owner.bindCorrelation({ version: 1, bindingId: BINDING }))).toBe("authority_denied");
  for (const bad of [null, undefined, {}, { held: true }, "held"]) expect(code(() => owner.attachLifetime(bad as never))).toBe("invalid_request");
  owner.attachLifetime({ held: () => true });
  expect(code(() => owner.attachLifetime({ held: () => true }))).toBe("authority_denied");
  expect(owner.registrationPort(BACKEND)).toBeDefined();
  f.fake.bindingId = "correlation-two"; expect(owner.registrationPort(BACKEND)).toBeUndefined();
  const closed = f.registry.prepare(f.capture()); closed.close("query-ended");
  expect(code(() => closed.bindCorrelation({ version: 1, bindingId: BINDING }))).toBe("authority_denied");
  expect(code(() => closed.attachLifetime({ held: () => true }))).toBe("authority_denied");
});

test("the lifetime holder is read once at attach, and a held() that is not exactly true makes the lookup unavailable", () => {
  const f = fixture(); let value: unknown = true;
  const owner = f.ready(PARENT, { held: () => value as boolean });
  expect(owner.registrationPort(BACKEND)).toBeDefined();
  for (const bad of [false, 1, "true", undefined, null, {}]) { value = bad; expect(owner.registrationPort(BACKEND)).toBeUndefined(); }
  value = true; expect(owner.registrationPort(BACKEND)).toBeDefined();
  const throwing = f.registry.prepare(f.capture()); throwing.bindCorrelation({ version: 1, bindingId: BINDING }); throwing.attachLifetime({ held: () => { throw new Error("native lifetime lost"); } });
  expect(throwing.registrationPort(BACKEND)).toBeUndefined();
  const late = { held: () => true }, fresh = f.registry.prepare(f.capture()); fresh.bindCorrelation({ version: 1, bindingId: BINDING }); fresh.attachLifetime(late);
  late.held = () => false; expect(fresh.registrationPort(BACKEND)).toBeDefined();
});

const evidenceCases: [string, (evidence: Record<string, any>) => unknown][] = [
  ["wrong profile", e => ({ ...e, profile: "host-query-v1" })], ["registration id malformed", e => ({ ...e, registrationId: "bad id" })], ["registration id missing", ({ registrationId: _r, ...e }) => e],
  ["launch id differs", e => ({ ...e, launchId: "launch-other" })], ["binding id differs", e => ({ ...e, bindingId: "correlation-two" })],
  ["owner workspace", e => ({ ...e, owner: { ...e.owner, workspaceId: "workspace-other" } })], ["owner logical session", e => ({ ...e, owner: { ...e.owner, logicalSessionId: "logical-other" } })],
  ["owner backend session", e => ({ ...e, owner: { ...e.owner, backendSessionId: "backend-other" } })], ["owner incarnation", e => ({ ...e, owner: { ...e.owner, incarnationId: "incarnation-other" } })],
  ["owner lease", e => ({ ...e, owner: { ...e.owner, leaseEpoch: e.owner.leaseEpoch + 1 } })], ["owner boot", e => ({ ...e, owner: { ...e.owner, bootId: otherBoot } })],
  ["owner generation", e => ({ ...e, owner: { ...e.owner, generation: e.owner.generation + 1 } })], ["owner extra field", e => ({ ...e, owner: { ...e.owner, extra: 1 } })],
  ["owner missing field", e => { const { generation: _g, ...owner } = e.owner; return { ...e, owner }; }], ["owner null", e => ({ ...e, owner: null })],
  ["pidfs false", e => ({ ...e, kernel: { ...e.kernel, pidfs: false } })], ["peer pidfd false", e => ({ ...e, kernel: { ...e.kernel, peerPidfd: false } })],
  ["pidfs truthy not true", e => ({ ...e, kernel: { ...e.kernel, pidfs: 1 } })], ["kernel missing", ({ kernel: _k, ...e }) => e], ["kernel extra field", e => ({ ...e, kernel: { ...e.kernel, other: true } })],
  ["kernel partial", e => ({ ...e, kernel: { pidfs: true } })], ["extra top-level field", e => ({ ...e, extra: true })],
  ["getter-bearing evidence", e => Object.defineProperty({ ...e }, "profile", { get: () => "host-query-guided-v1", enumerable: true })],
  ["non-plain prototype", e => Object.assign(Object.create({ inherited: 1 }), e)], ["evidence is a promise", e => Promise.resolve(e)], ["evidence is null", () => null],
  ["evidence is a string", () => "host-query-guided-v1"], ["evidence throws", () => { throw new Error("native check failed"); }],
];
test("any evidence mismatch, malformed shape or throwing port makes the lookup unavailable", () => {
  const f = fixture(), owner = f.ready();
  expect(owner.registrationPort(BACKEND)).toBeDefined();
  for (const [name, change] of evidenceCases) {
    f.fake.override = evidence => change(evidence);
    expect(`${name}:${owner.registrationPort(BACKEND) === undefined}`).toBe(`${name}:true`);
  }
  f.fake.override = undefined; expect(owner.registrationPort(BACKEND)).toBeDefined();
});
test("evidence is requested at every lookup and is never cached", () => {
  const f = fixture(), owner = f.ready(); f.fake.calls = 0;
  for (let i = 0; i < 5; i++) owner.registrationPort(BACKEND);
  expect(f.fake.calls).toBe(5);
  f.fake.override = evidence => ({ ...evidence, kernel: { pidfs: true, peerPidfd: false } }); expect(owner.registrationPort(BACKEND)).toBeUndefined();
  f.fake.override = undefined; expect(owner.registrationPort(BACKEND)).toBeDefined();
});
test("an optional reader plan is inert, checked against canonical views, and its registration id must match the evidence", () => {
  const f = fixture(), views = { sourceRoot: f.root, sourceCwd: `${f.root}/directory`, sharedRoot: COWORK_SHARED_INSTRUCTION_VIEW, sharedPath: `${COWORK_SHARED_INSTRUCTION_VIEW}/WINTER.md` } as const;
  const plan = { registrationId: REGISTRATION, views, limits: { ...COWORK_GUEST_OWNER_READER_LIMITS } };
  for (const bad of [{ ...plan, views: { ...views, sourceCwd: `${f.root}/other` } }, { ...plan, views: { ...views, sourceRoot: "/workspace/repos/other" } }, { ...plan, views: { ...views, sharedPath: "/run/winter/other.md" } },
    { ...plan, limits: { ...plan.limits, maxReadBytes: 1 } }, { ...plan, limits: { maxFileBytes: 1 } }, { ...plan, registrationId: "bad id" }, { ...plan, extra: 1 }, { registrationId: REGISTRATION }, "plan"])
    expect(code(() => captureCoworkGuestOwner(f.deps, f.launch(), bad as never))).toBe("invalid_request");
  const capture = captureCoworkGuestOwner(f.deps, f.launch(), plan);
  expect(capture.readerRegistrationId).toBe(REGISTRATION); expect(capture.views).toEqual(views); expect(capture.limits).toEqual(COWORK_GUEST_OWNER_READER_LIMITS); expect(Object.isFrozen(capture.views)).toBe(true);
  const owner = f.registry.prepare(capture); owner.bindCorrelation({ version: 1, bindingId: BINDING }); owner.attachLifetime({ held: () => true });
  const registration = owner.registrationPort(BACKEND)!; expect(Object.keys(registration).sort()).toEqual(REGISTRATION_KEYS);
  f.fake.override = evidence => ({ ...evidence, registrationId: "reader-registration-two" }); expect(owner.registrationPort(BACKEND)).toBeUndefined();
});

test("the lookup returns a fresh deep-frozen copy of exactly the closed 13 registration fields", () => {
  const f = fixture(), owner = f.ready(), a = owner.registrationPort(BACKEND)!, b = owner.registrationPort(BACKEND)!;
  expect(Object.keys(a).sort()).toEqual(REGISTRATION_KEYS);
  expect(a).toEqual({ trustedQuerySessionId: BACKEND, sessionId: PARENT, workspaceId: f.workspaceId, backendSessionId: BACKEND, backendGeneration: f.sessions.get(PARENT)!.generation,
    bootId: boot, incarnationId: "incarnation", leaseEpoch: f.epoch.leaseEpoch, state: "active", platform: "linux", executionPosture: "confined-guest", capabilities: sortedCaps,
    admittedSources: [{ sourceId: f.source.sourceId, revision: f.source.revision, root: f.root, access: "read-write" }] } satisfies CoworkContextRegistration);
  expect(a).not.toBe(b); expect(a.capabilities).not.toBe(b.capabilities); expect(a.admittedSources).not.toBe(b.admittedSources); expect(a.admittedSources[0]).not.toBe(b.admittedSources[0]);
  const frozen = (value: unknown): boolean => !value || typeof value !== "object" || (Object.isFrozen(value) && Object.values(value).every(frozen));
  expect(frozen(a)).toBe(true);
  expect(() => { (a as { state: string }).state = "other"; }).toThrow(); expect(() => { a.capabilities.toolClasses.push("x"); }).toThrow();
  expect(owner.registrationPort(BACKEND)).toEqual(a);
});

test("replacing an owner makes the prior one terminal and leaves no way back", () => {
  const f = fixture(), first = f.ready();
  expect(first.registrationPort(BACKEND)).toBeDefined();
  const second = f.registry.prepare(f.capture());
  expect(first.phase).toBe("replaced"); expect(first.registrationPort(BACKEND)).toBeUndefined();
  second.bindCorrelation({ version: 1, bindingId: BINDING }); second.attachLifetime({ held: () => true });
  expect(second.registrationPort(BACKEND)).toBeDefined();
  first.close("query-ended"); first.revoke(); expect(first.phase).toBe("replaced"); expect(first.closeReason).toBeUndefined();
  expect(second.phase).toBe("open"); expect(second.registrationPort(BACKEND)).toBeDefined();
  expect(code(() => first.bindCorrelation({ version: 1, bindingId: BINDING }))).toBe("authority_denied");
  expect(first.registrationPort(BACKEND)).toBeUndefined();
});
test("close and revoke are terminal, the first terminal transition wins, and a re-prepare is a new owner", () => {
  const f = fixture(), a = f.ready();
  a.close("runtime-exited"); expect(a.phase).toBe("closed"); expect(a.closeReason).toBe("runtime-exited"); expect(a.registrationPort(BACKEND)).toBeUndefined();
  a.revoke(); a.close("query-ended"); expect(a.phase).toBe("closed"); expect(a.closeReason).toBe("runtime-exited");
  const b = f.ready(); b.revoke(); expect(b.phase).toBe("revoked"); b.close("host-stopping"); expect(b.phase).toBe("revoked"); expect(b.registrationPort(BACKEND)).toBeUndefined();
  const c = f.ready(); expect(c.registrationPort(BACKEND)).toBeDefined(); expect(c).not.toBe(a);
  const d = f.registry.prepare(f.capture()); d.close("not-a-reason" as never); expect(d.closeReason).toBe("query-ended");
});
test("a stale capture cannot displace the current owner", () => {
  const f = fixture(), stale = f.capture(), owner = f.ready();
  f.sessions.bumpGeneration(PARENT, { runtimeKind: "winter-agent", backendSessionId: BACKEND });
  expect(code(() => f.registry.prepare(stale))).toBe("stale_acknowledgment");
  expect(owner.phase).toBe("open");
  const beforeBoot = f.capture(); f.setBoot(otherBoot);
  expect(code(() => f.registry.prepare(beforeBoot))).toBe("stale_acknowledgment");
  expect(code(() => captureCoworkGuestOwner(f.deps, f.launch()))).toBe("no-throw"); // a launch made under the new boot is a new, valid claim
});
test("registry stop ends vouching for every owner without touching phases, and refuses new owners", () => {
  const f = fixture(), owner = f.ready(); expect(owner.registrationPort(BACKEND)).toBeDefined();
  f.registry.stop();
  expect(owner.registrationPort(BACKEND)).toBeUndefined(); expect(owner.phase).toBe("open");
  expect(code(() => f.registry.prepare(f.capture()))).toBe("authority_denied");
  owner.close("host-stopping"); expect(owner.phase).toBe("closed");
});

test("two same-workspace owners stay isolated and closing one does not affect the other", () => {
  const f = fixture(); f.conversation("logical-two", "backend-two", "two");
  const one = f.ready(PARENT), two = f.ready("logical-two");
  const a = one.registrationPort(BACKEND)!, b = two.registrationPort("backend-two")!;
  expect(a.workspaceId).toBe(b.workspaceId); expect([a.sessionId, a.backendSessionId, a.trustedQuerySessionId]).toEqual([PARENT, BACKEND, BACKEND]);
  expect([b.sessionId, b.backendSessionId, b.trustedQuerySessionId]).toEqual(["logical-two", "backend-two", "backend-two"]);
  expect(one.registrationPort("backend-two")).toBeUndefined(); expect(two.registrationPort(BACKEND)).toBeUndefined();
  one.close("query-ended"); expect(one.registrationPort(BACKEND)).toBeUndefined(); expect(two.phase).toBe("open"); expect(two.registrationPort("backend-two")).toEqual(b);
  two.revoke(); expect(f.ready(PARENT).registrationPort(BACKEND)).toBeDefined();
  f.setHeld(false); expect(f.registry.prepare(f.capture(PARENT)).registrationPort(BACKEND)).toBeUndefined();
});
test("a held-false lifetime on one owner leaves a sibling owner untouched", () => {
  const f = fixture(); f.conversation("logical-two", "backend-two", "two"); let heldOne = true;
  const one = f.ready(PARENT, { held: () => heldOne }), two = f.ready("logical-two");
  heldOne = false; expect(one.registrationPort(BACKEND)).toBeUndefined(); expect(two.registrationPort("backend-two")).toBeDefined();
});

test("a lookup never throws, even for a closed database, hostile arguments or a hostile boot dep", () => {
  const f = fixture(); let hostile = false;
  const owner = f.ready();
  const evil = { toString() { throw new Error("hostile"); }, valueOf() { throw new Error("hostile"); } };
  for (const arg of [undefined, null, 0, NaN, {}, [], evil, Symbol("s"), () => BACKEND, "x".repeat(1e6), BACKEND]) expect(() => owner.registrationPort(arg as never)).not.toThrow();
  const registry = new CoworkGuestContextOwners({ records: f.records, evidence: f.port, bootId: () => { if (hostile) throw new Error("boot unavailable"); return boot; } });
  const other = registry.prepare(f.capture()); other.bindCorrelation({ version: 1, bindingId: BINDING }); other.attachLifetime({ held: () => true });
  expect(other.registrationPort(BACKEND)).toBeDefined(); hostile = true; expect(other.registrationPort(BACKEND)).toBeUndefined(); hostile = false;
  f.db.close(); expect(owner.registrationPort(BACKEND)).toBeUndefined(); expect(other.registrationPort(BACKEND)).toBeUndefined();
});
test("a home identity read inside a transaction neither throws nor mints", () => {
  const f = fixture(), owner = f.ready(), homes = () => f.db.db.query("SELECT count(*) AS n FROM cowork_home_identity").get();
  const durable = f.records.homeIdentity.bind(f.records); let durableCalls = 0;
  (f.records as { homeIdentity: () => string }).homeIdentity = () => { durableCalls++; return durable(); };
  f.db.transaction(() => {
    expect(code(() => f.records.homeIdentity())).toBe("authority_denied"); durableCalls = 0;
    expect(owner.registrationPort(BACKEND)?.backendSessionId).toBe(BACKEND);
    f.sql("DELETE FROM cowork_home_identity");
    expect(homes()).toEqual({ n: 0 }); expect(owner.registrationPort(BACKEND)).toBeUndefined(); expect(homes()).toEqual({ n: 0 });
  });
  expect(durableCalls).toBe(0); expect(homes()).toEqual({ n: 0 });
});

test("the owner is not serializable, exposes no register method and hides its capture", () => {
  const f = fixture(), owner = f.ready();
  expect(() => JSON.stringify(owner)).toThrow(); expect(() => JSON.stringify({ nested: [owner] })).toThrow(); expect(() => structuredClone(owner)).toThrow();
  expect(Object.keys(owner)).toEqual(["registrationPort"]);
  for (const text of [inspect(owner, { depth: 6, showHidden: true }), Bun.inspect(owner), String(Object.getOwnPropertyNames(owner))]) for (const secret of [BACKEND, f.workspaceId, "incarnation", f.source.sourceId, f.root]) expect(text).not.toContain(secret);
  const names = [...Object.getOwnPropertyNames(Object.getPrototypeOf(owner)), ...Object.getOwnPropertyNames(owner), ...Object.getOwnPropertyNames(CoworkGuestContextOwners.prototype), ...Object.getOwnPropertyNames(f.registry)];
  expect(names.filter(name => /^register(?!ation)/i.test(name) || /^(set|get)(Context|Registration)/i.test(name))).toEqual([]);
  expect(names.sort()).toEqual(["attachLifetime", "bindCorrelation", "close", "closeReason", "constructor", "constructor", "phase", "prepare", "registrationPort", "revoke", "stop", "toJSON"]);
  expect(owner.registrationPort).toBe(owner.registrationPort);
  expect(f.ready().registrationPort).not.toBe(owner.registrationPort);
});

const unavailable: [string, (f: Fixture, owner: CoworkGuestContextOwner) => void][] = [
  ["closed", (_f, owner) => owner.close("query-ended")], ["revoked", (_f, owner) => owner.revoke()], ["replaced", (f) => { f.registry.prepare(f.capture()); }], ["registry stopped", f => f.registry.stop()],
  ["lifetime no longer held", f => f.setHeld(false)], ["evidence profile", f => { f.fake.override = e => ({ ...e, profile: "other" }); }],
  ["evidence kernel", f => { f.fake.override = e => ({ ...e, kernel: { pidfs: true, peerPidfd: false } }); }], ["evidence binding", f => { f.fake.override = e => ({ ...e, bindingId: "other" }); }],
  ["evidence throws", f => { f.fake.override = () => { throw new Error("lost"); }; }], ["stale boot", f => f.setBoot(otherBoot)],
  ["stale incarnation", f => f.sql("UPDATE cowork_workspaces SET incarnation_id='incarnation-two' WHERE workspace_id=?", f.workspaceId)],
  ["stale lease", f => f.sql("UPDATE cowork_workspaces SET lease_epoch=lease_epoch+1 WHERE workspace_id=?", f.workspaceId)],
  ["stale generation", f => { f.sessions.bumpGeneration(PARENT, { runtimeKind: "winter-agent", backendSessionId: BACKEND }); }],
  ["child runtime row", f => { f.conversation("child-one", "backend-child", "child"); f.sql("UPDATE runtime_sessions SET parent_winter_session_id='child-one' WHERE winter_session_id=?", PARENT); }],
];
test("unavailable owners never reach the protected reader through the real callback handler", async () => {
  // Positive control first: with the trusted query id equal to the backend id, the real handler reads once.
  const control = fixture(); let controlReads = 0;
  const snapshot = await control.handler(control.ready(), async request => { controlReads++; return reply(request); })(control.request, control.options);
  expect(controlReads).toBe(1); expect(snapshot.facts).toContain("Cowork current host context"); expect(snapshot.instructions).toContain("shared guidance");
  for (const [name, arrange] of unavailable) {
    const f = fixture(); let reads = 0; const owner = f.ready(); arrange(f, owner);
    const pending = f.handler(owner, async request => { reads++; return reply(request); })(f.request, f.options);
    await expect(`${name}:${await pending.then(() => "resolved", (error: Error) => error.message)}`).toBe(`${name}:required_context_unavailable`);
    expect(`${name}:${reads}`).toBe(`${name}:0`);
  }
  for (const attach of [(_o: CoworkGuestContextOwner) => {}, (o: CoworkGuestContextOwner) => o.bindCorrelation({ version: 1, bindingId: BINDING }), (o: CoworkGuestContextOwner) => o.attachLifetime({ held: () => true })]) {
    const f = fixture(); let reads = 0; const owner = f.registry.prepare(f.capture()); attach(owner);
    await refused(f.handler(owner, async request => { reads++; return reply(request); })(f.request, f.options)); expect(reads).toBe(0); expect(f.fake.calls).toBe(0);
  }
  const f = fixture(); let reads = 0; const owner = f.ready();
  await refused(f.handler(owner, async request => { reads++; return reply(request); })(f.request, { ...f.options, trustedQuerySessionId: PARENT })); expect(reads).toBe(0);
});

const duringRead: [string, (f: Fixture, owner: CoworkGuestContextOwner) => void][] = [
  ["revoke", (_f, owner) => owner.revoke()], ["close", (_f, owner) => owner.close("runtime-exited")], ["supersede", f => { f.registry.prepare(f.capture()); }],
  ["registry stop", f => f.registry.stop()], ["lifetime lost", f => f.setHeld(false)], ["evidence lost", f => { f.fake.override = e => ({ ...e, kernel: { pidfs: false, peerPidfd: true } }); }],
  ["boot change", f => f.setBoot(otherBoot)], ["lease change", f => f.sql("UPDATE cowork_workspaces SET lease_epoch=lease_epoch+1 WHERE workspace_id=?", f.workspaceId)],
];
for (const [name, trigger] of duringRead) {
  test(`${name} during the reader await refuses through the real resolver, with no cached fallback`, async () => {
    const f = fixture(), owner = f.ready(); let calls = 0, revoke = false;
    const handler = f.handler(owner, async request => { calls++; const value = reply(request); await Promise.resolve(); if (revoke) trigger(f, owner); return value; });
    expect((await handler(f.request, f.options)).instructions).toContain("shared guidance");
    revoke = true; await refused(handler(f.request, f.options)); expect(calls).toBe(2);
    revoke = false; await refused(handler(f.request, f.options)); expect(calls).toBe(2);
  });
}
test("revocation during the reader abort cleanup is caught by the resolver's final registration guard", async () => {
  const f = fixture(), owner = f.ready(); let cleanup = false;
  await refused(f.handler(owner, async (request, readerOptions) => { readerOptions.signal.addEventListener("abort", () => { cleanup = true; owner.revoke(); }, { once: true }); return reply(request); })(f.request, f.options));
  expect(cleanup).toBe(true);
});

const sourceDirectory = (...parts: string[]) => join(import.meta.dir, "..", "..", "..", ...parts);
function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile() && /\.(ts|tsx|js|mjs|cjs)$/.test(entry.name)).map(entry => join(entry.parentPath, entry.name));
}
test("anti-wiring: no src file imports the slot, it has no barrel export and the evidence port has no implementation", () => {
  const packages = sourceDirectory(), module = join(packages, "core", "src", "cowork", "guest-context-owner.ts");
  expect(existsSync(module)).toBe(true);
  const sources = readdirSync(packages, { withFileTypes: true }).filter(entry => entry.isDirectory() && existsSync(join(packages, entry.name, "src"))).flatMap(entry => sourceFiles(join(packages, entry.name, "src")));
  expect(sources.length).toBeGreaterThan(100); expect(sources).toContain(module);
  const others = sources.filter(file => file !== module);
  for (const file of others) {
    const text = readFileSync(file, "utf8");
    for (const needle of ["guest-context-owner", "CoworkGuestContextOwners", "CoworkGuestContextOwner", "CoworkGuestOwnerEvidencePort", "captureCoworkGuestOwner", "CoworkGuestOwnerCapture"])
      expect(`${basename(file)}:${needle}:${text.includes(needle)}`).toBe(`${basename(file)}:${needle}:false`);
  }
  expect(existsSync(join(packages, "core", "src", "cowork", "index.ts"))).toBe(false);
  expect(readFileSync(join(packages, "core", "src", "index.ts"), "utf8")).not.toMatch(/guest-context-owner|from "\.\/cowork/);
  const own = readFileSync(module, "utf8");
  expect(own).not.toMatch(/implements\s+CoworkGuestOwnerEvidencePort|:\s*CoworkGuestOwnerEvidencePort\s*=\s*\{|class\s+\w+[^{]*CoworkGuestOwnerEvidencePort/);
  expect(Object.keys(ownerModule).sort()).toEqual(["COWORK_GUEST_OWNER_READER_LIMITS", "CoworkGuestContextOwners", "captureCoworkGuestOwner"]);
  expect(own).not.toMatch(/from "@yanlinglabs\/winter-(agent|runtime)-sdk/);
  expect(own).not.toMatch(/\bhomeIdentity\(\)/);
});
