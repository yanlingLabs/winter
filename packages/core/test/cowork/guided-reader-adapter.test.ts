import { authorityFixtureSessions } from "./committed-sessions";
import { afterEach, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { CoworkAuthority } from "../../src/cowork/authority";
import { createCoworkRuntimeContextHandler, type CoworkRuntimeContextRequest } from "../../src/cowork/current-context-callback";
import { COWORK_SHARED_INSTRUCTION_VIEW } from "../../src/cowork/current-context-resolver";
import { coworkGuestSourceRoot } from "../../src/cowork/guest-paths";
import { captureCoworkGuestOwner, COWORK_GUEST_OWNER_READER_LIMITS, CoworkGuestContextOwners, type CoworkGuestContextOwner, type CoworkGuestOwnerCapture,
  type CoworkGuestOwnerEvidence, type CoworkGuestOwnerEvidencePort, type CoworkGuestOwnerReaderPlan } from "../../src/cowork/guest-context-owner";
import { CoworkGuestRuntimeSupervisor, type GuestRuntimeLaunch } from "../../src/cowork/guest-runtime";
import * as adapter from "../../src/cowork/guided-reader-adapter";
import { COWORK_GUIDED_FRAME_KEYS, COWORK_GUIDED_FRAME_LIMITS, COWORK_GUIDED_FRAME_MAX_BYTES, COWORK_GUIDED_FRAME_MAX_DEPTH, COWORK_GUIDED_FRAME_OWNER_KEYS,
  COWORK_GUIDED_FRAME_SNAPSHOT_KEYS, COWORK_GUIDED_FRAME_VERSION, COWORK_GUIDED_FRAME_VIEW_KEYS, COWORK_GUIDED_READ_ID_CAPACITY, CoworkGuidedReadIdSet,
  createCoworkGuidedRuntimeContextHandler, parseCoworkGuidedReaderFrame, type CoworkGuidedFrameExpectation, type CoworkGuidedFramePort, type CoworkGuidedReaderCapture } from "../../src/cowork/guided-reader-adapter";
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
const SECOND = "logical-parent-two", SECOND_BACKEND = "backend-two";
const SHARED = `${COWORK_SHARED_INSTRUCTION_VIEW}/WINTER.md`;
const caps: CapabilityCeiling = { toolClasses: ["read", "write", "execute"], hostServices: ["git.publish"], connectors: [], network: "internet" };
const supervisorCapability = { protocolVersion: 1, capabilities: ["confined-guest-posture-v1"], supportsConfinedGuestExecution: true };
const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const REFUSED = /^required_context_unavailable$/;
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
function gate<T>() { let resolve!: (value: T) => void, reject!: (reason: unknown) => void; const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; }

/** The evidence port is a FAKE (see the Slice A test): positive results here prove this adapter's own logic,
 * never issuer authenticity, kernel facts or native admission. */
function fakeEvidence() {
  const fake = { calls: 0, override: undefined as undefined | ((evidence: Record<string, any>) => unknown) };
  const port: CoworkGuestOwnerEvidencePort = { evidence(capture) {
    fake.calls++;
    const evidence = { profile: "host-query-guided-v1", registrationId: REGISTRATION, launchId: capture.launchId, bindingId: BINDING, kernel: { pidfs: true, peerPidfd: true },
      owner: { workspaceId: capture.workspaceId, logicalSessionId: capture.sessionId, backendSessionId: capture.backendSessionId, incarnationId: capture.incarnationId, leaseEpoch: capture.leaseEpoch, bootId: capture.bootId, generation: capture.backendGeneration } };
    return (fake.override ? fake.override(evidence) : evidence) as CoworkGuestOwnerEvidence;
  } };
  return { fake, port };
}

/** Real canonical DB, repository and runtime rows; launches from the REAL supervisor with a port that is never opened. */
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "winter-guided-reader-")); roots.push(home);
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
  const backends = new Map<string, string>(), cwds = new Map<string, string>(), known = [PARENT];
  function conversation(sessionId: string, backendSessionId: string, relativeCwd: string) {
    if (sessionId !== PARENT) known.push(sessionId);
    records.bindConversation({ principalId: "fixture", requestId: `bind-${sessionId}`, expectedRevision: records.get(workspaceId).configRevision }, workspaceId, { sessionId, sourceId: source.sourceId, relativeCwd }, authorityFixtureSessions(...known));
    sessions.create({ winterSessionId: sessionId, runtimeKind: "winter-agent", backendSessionId, providerId: "fixture", modelRef: "fixture",
      backendRoot: "/private/protected/backend", transcriptProjectKey: "private-key", memoryProjectKey: "private-key", tempProjectKey: "private-key",
      transcriptHealth: "clean", compatibilityLevel: "full-filesystem", conformanceCorpusVersion: "fixture", versionProvenance: "legacy-unknown", capabilities: [],
      selection: { runtimeKind: "winter-agent", providerId: "fixture", modelRef: "fixture", family: "openai", authFamily: "api-key", sdkVersion: "fixture", reason: "test", decidedAt: "2026-10-16T00:00:00.000Z" } });
    sessions.transition(sessionId, "ready"); sessions.bumpGeneration(sessionId, { runtimeKind: "winter-agent", backendSessionId }); sessions.transition(sessionId, "running");
    backends.set(sessionId, backendSessionId); cwds.set(sessionId, `${root}/${relativeCwd}`);
  }
  conversation(PARENT, BACKEND, "directory");
  const grants = { folder() { return undefined; }, repository() { return { readable: true, writable: true, revoked: false }; } };
  const authority = new CoworkAuthority(records, grants);
  const supervisor = new CoworkGuestRuntimeSupervisor({ records, authority, identity: sessionId => ({ backendSessionId: backends.get(sessionId)!, model: "winter-test/echo", resume: false }), bootId: () => currentBoot,
    runtimeCapability: supervisorCapability, port: { open() { throw new Error("the fixture port is never opened"); } } });
  const deps = { records, bootId: () => currentBoot };
  const { fake, port } = fakeEvidence();
  const registry = new CoworkGuestContextOwners({ ...deps, evidence: port });
  const launch = (sessionId = PARENT): Readonly<GuestRuntimeLaunch> => supervisor.prepareQuery(sessionId).launch;
  const plan = (sessionId = PARENT): CoworkGuestOwnerReaderPlan => ({ registrationId: REGISTRATION,
    views: { sourceRoot: root, sourceCwd: cwds.get(sessionId)!, sharedRoot: COWORK_SHARED_INSTRUCTION_VIEW, sharedPath: SHARED }, limits: { ...COWORK_GUEST_OWNER_READER_LIMITS } });
  /** A plain Slice A capture with NO reader plan (the adapter must refuse it). */
  const plain = (sessionId = PARENT) => captureCoworkGuestOwner(deps, launch(sessionId));
  /** A capture WITH the reader plan the adapter requires. */
  const planned = (sessionId = PARENT) => captureCoworkGuestOwner(deps, launch(sessionId), plan(sessionId));
  /** Prepare + correlate + attach: the owner a host holds once its guest lifetime is held. */
  function ready(sessionId = PARENT) {
    const capture = planned(sessionId), owner = registry.prepare(capture); owner.bindCorrelation({ version: 1, bindingId: BINDING }); owner.attachLifetime({ held: () => held });
    return { owner, capture };
  }
  const trusted = (sessionId = PARENT) => backends.get(sessionId)!;
  const requestFor = (sessionId = PARENT): CoworkRuntimeContextRequest => ({ bindingId: BINDING, sessionId: trusted(sessionId), cwd: cwds.get(sessionId)!, purpose: "generation", attempt: 1 });
  const sql = (statement: string, ...args: (string | number)[]) => { db.db.run(statement, args); };
  return { home, db, records, sessions, workspaceId, source, root, epoch, registry, fake, port, deps, grants, launch, plan, plain, planned, ready, trusted, requestFor, sql, conversation,
    setBoot: (value: string) => { currentBoot = value; }, setHeld: (value: boolean) => { held = value; }, currentBoot: () => currentBoot };
}
type Fixture = ReturnType<typeof fixture>;

/** A FAKE of the SDK side: `readFrame` behaves like the SDK's `readGuidedQueryInstructions(preparation, callbackSignal)`:
 * it only answers for the exact signal installed for the exact preparation, once. */
interface Scope { preparation: object; produce(): string | Promise<string>; used: boolean }
function fakeSdk() {
  const scopes = new WeakMap<AbortSignal, Scope>(), calls: AbortSignal[] = [];
  const port = (preparation: object): CoworkGuidedFramePort => ({ async readFrame(signal) {
    calls.push(signal);
    const scope = scopes.get(signal);
    if (!scope || scope.preparation !== preparation || scope.used) throw new Error("required_context_unavailable");
    scope.used = true;
    return scope.produce();
  } });
  const install = (signal: AbortSignal, preparation: object, produce: Scope["produce"]) => { scopes.set(signal, { preparation, produce, used: false }); return signal; };
  return { calls, port, install };
}

/** A mapper-valid structured snapshot (the SDK loader's shape): shared top plus one source top, no imports. */
function snapshotOf(root: string, sharedText = "shared guidance\n", sourceText = "source guidance\n"): Record<string, any> {
  const block = (requestedPath: string, text: string, tier: string) => ({ requestedPath, admittedPath: requestedPath, text, textSha256: sha(text), tier });
  const blocks = [block(SHARED, sharedText, "workspace"), block(`${root}/WINTER.md`, sourceText, "project")];
  const provenance = blocks.map(b => ({ ...b, depth: 0 }));
  const text = blocks.map(b => `# ${b.requestedPath}\n\n${b.text}`).join("\n");
  return { blocks, digest: sha(text), droppedImports: [], files: provenance.map(p => ({ path: p.admittedPath, tier: p.tier, sha256: p.textSha256, imported: false })), provenance, skippedLinks: [], text, tiers: "admitted-only" };
}
let counter = 0;
const nextId = () => `00000000-0000-4000-8000-${(++counter).toString(16).padStart(12, "0")}`;
/** The frame object the SDK-side reader would emit for this owner: the inner owner has SIX fields (no workspaceId). */
function frameObject(capture: CoworkGuestOwnerCapture, root: string, readId = nextId()): Record<string, any> {
  return { version: 1, readId, owner: { logicalSessionId: capture.sessionId, backendSessionId: capture.backendSessionId, incarnationId: capture.incarnationId, leaseEpoch: capture.leaseEpoch, bootId: capture.bootId, generation: capture.backendGeneration },
    views: { ...capture.views }, limits: { ...capture.limits }, snapshot: snapshotOf(root) };
}
const serialize = (value: unknown) => `${JSON.stringify(value)}\n`;

function harness(f: Fixture, session = PARENT, extra: Partial<Parameters<typeof createCoworkGuidedRuntimeContextHandler>[0]> = {}) {
  const { owner, capture } = f.ready(session);
  const sdk = fakeSdk(), preparation = {};
  const handler = createCoworkGuidedRuntimeContextHandler({ records: f.records, grants: f.grants, currentBootId: () => f.currentBoot(), registration: owner.registrationPort, capture, frames: sdk.port(preparation), ...extra });
  const trusted = f.trusted(session), request = f.requestFor(session);
  const options = (signal: AbortSignal) => ({ signal, trustedQuerySessionId: trusted });
  /** Run one SDK callback invocation: install a fresh signal for this preparation, then call the handler with it. */
  const call = (produce: Scope["produce"], signal = new AbortController().signal, forPreparation: object = preparation) => { sdk.install(signal, forPreparation, produce); return handler(request, options(signal)); };
  const obj = (change?: (frame: Record<string, any>) => void, readId?: string) => { const frame = frameObject(capture, f.root, readId); change?.(frame); return frame; };
  const text = (change?: (frame: Record<string, any>) => void, readId?: string) => serialize(obj(change, readId));
  return { owner, capture, sdk, preparation, handler, call, options, request, trusted, obj, text };
}
type Harness = ReturnType<typeof harness>;
async function allRefused(h: Harness, cases: [string, unknown][]) {
  const wrong: string[] = [];
  for (const [name, raw] of cases) {
    try { await h.call(() => raw as string); wrong.push(`${name}: ACCEPTED`); } catch (error) { if (!REFUSED.test((error as Error).message)) wrong.push(`${name}: ${(error as Error).message}`); }
  }
  expect(wrong).toEqual([]);
  expect(h.sdk.calls.length).toBe(cases.length);
  // Positive control: the same handler still answers a valid frame, so nothing above poisoned it.
  expect((await h.call(() => h.text())).instructions).toContain("shared guidance");
}
const nested = (depth: number, leaf: unknown, open = "[", close = "]") => `${open.repeat(depth)}${JSON.stringify(leaf)}${close.repeat(depth)}`;

// ---------------------------------------------------------------- happy path and port discipline

test("happy path: the original signal reaches the port once and the mapped context resolves", async () => {
  const f = fixture(), h = harness(f), signal = new AbortController().signal;
  const result = await h.call(() => h.text(), signal);
  expect(result.instructions).toContain("shared guidance"); expect(result.instructions).toContain("source guidance");
  expect(result.facts).toContain("Cowork current host context");
  expect(Object.keys(result).sort()).toEqual(["facts", "instructions", "revision"]); expect(Object.isFrozen(result)).toBe(true);
  expect(h.sdk.calls.length).toBe(1); expect(h.sdk.calls[0]).toBe(signal);
});

test("only the snapshot leaves the parser: owner, views, limits and read id are checked and dropped", () => {
  const f = fixture(), { capture } = f.ready(), frame = frameObject(capture, f.root, nextId());
  const expected: CoworkGuidedFrameExpectation = { canonicalReadId: nextId(), owner: frame.owner, views: frame.views, limits: frame.limits as CoworkGuidedFrameExpectation["limits"] };
  const claimed: string[] = [];
  const parsed = parseCoworkGuidedReaderFrame(serialize(frame), expected, id => { claimed.push(id); return true; });
  expect(Object.keys(parsed)).toEqual(["snapshot"]); expect(parsed.snapshot).toEqual(frame.snapshot); expect(Object.isFrozen(parsed)).toBe(true);
  expect(claimed).toEqual([frame.readId]);
  for (const dropped of ["version", "readId", "owner", "views", "limits"]) expect(parsed).not.toHaveProperty(dropped);
});

test("brackets, braces and escaped quotes inside guidance text are data, not nesting", async () => {
  const f = fixture(), h = harness(f), body = `[[[[[[[[[[[[ {{{{{{{{{{ \\" ] } "quoted" \\\\ end\n`;
  const frame = h.obj(value => { value.snapshot = snapshotOf(f.root, body); });
  expect((await h.call(() => serialize(frame))).instructions).toContain(body);
});

test("wrong preparation: a port bound to another preparation refuses, with no partial context", async () => {
  const f = fixture(), h = harness(f), foreign = {};
  await expect(h.call(() => h.text(), new AbortController().signal, foreign)).rejects.toThrow(REFUSED);
  expect(h.sdk.calls.length).toBe(1);
  expect((await h.call(() => h.text())).instructions).toContain("source guidance");
});

test("foreign signal: only the exact callback signal is handed on; copies, doubles and stale signals never reach the port", async () => {
  const f = fixture(), h = harness(f), mine = new AbortController().signal, installed = new AbortController().signal;
  h.sdk.install(installed, h.preparation, () => h.text());
  // The callback's own signal was never installed with the SDK: the port is asked with exactly that signal and refuses.
  await expect(h.handler(h.request, h.options(mine))).rejects.toThrow(REFUSED);
  expect(h.sdk.calls).toEqual([mine]); expect(h.sdk.calls[0]).toBe(mine); expect(h.sdk.calls[0]).not.toBe(installed);
  // Duck-typed, plain-object and aborted signals are refused before the port is touched.
  const aborted = new AbortController(); aborted.abort();
  for (const signal of [{ aborted: false } as unknown as AbortSignal, Object.create(AbortSignal.prototype) as AbortSignal, aborted.signal, undefined as unknown as AbortSignal, null as unknown as AbortSignal]) {
    await expect(h.handler(h.request, h.options(signal))).rejects.toThrow(REFUSED);
  }
  expect(h.sdk.calls.length).toBe(1);
  // A different trusted query id is refused with no port call either.
  const signal = new AbortController().signal; h.sdk.install(signal, h.preparation, () => h.text());
  await expect(h.handler(h.request, { signal, trustedQuerySessionId: PARENT })).rejects.toThrow(REFUSED);
  expect(h.sdk.calls.length).toBe(1);
  // The resolver's derived signal is not the callback signal: the happy path only works because the original is passed.
  expect((await h.call(() => h.text(), signal)).instructions).toContain("shared guidance");
  expect(h.sdk.calls[1]).toBe(signal);
});

test("overlapping invocations are isolated: each port read gets its own signal and aborting one leaves the other intact", async () => {
  const f = fixture(), h = harness(f), a = new AbortController(), b = new AbortController(), ga = gate<string>(), gb = gate<string>();
  const first = h.call(() => ga.promise, a.signal), second = h.call(() => gb.promise, b.signal);
  await tick();
  expect(h.sdk.calls.length).toBe(2); expect(h.sdk.calls[0]).toBe(a.signal); expect(h.sdk.calls[1]).toBe(b.signal);
  // Replies in the opposite order, one invocation aborted: the other still resolves with its own frame.
  const settled = first.then(() => "resolved", (error: Error) => error.message);
  a.abort(); gb.resolve(h.text()); ga.resolve(h.text());
  expect((await second).instructions).toContain("shared guidance"); expect(await settled).toBe("required_context_unavailable");
  const c = new AbortController(), d = new AbortController(), results = await Promise.all([h.call(() => h.text(), c.signal), h.call(() => h.text(), d.signal)]);
  expect(results.map(r => r.revision)).toHaveLength(2);
});

test("two same-workspace conversations are isolated: a frame for the sibling owner is refused", async () => {
  const f = fixture(); f.conversation(SECOND, SECOND_BACKEND, "other");
  const a = harness(f, PARENT), b = harness(f, SECOND);
  expect((await a.call(() => a.text())).instructions).toContain("shared guidance"); expect((await b.call(() => b.text())).instructions).toContain("shared guidance");
  await expect(a.call(() => b.text())).rejects.toThrow(REFUSED); await expect(b.call(() => a.text())).rejects.toThrow(REFUSED);
  // Another owner's port, signal and preparation are never interchangeable with this one.
  const foreign = new AbortController().signal; b.sdk.install(foreign, b.preparation, () => b.text());
  await expect(a.handler(a.request, a.options(foreign))).rejects.toThrow(REFUSED);
  expect(b.sdk.calls.length).toBe(2);
  // Closing one owner leaves the sibling answering.
  a.owner.close("runtime-exited"); await expect(a.call(() => a.text())).rejects.toThrow(REFUSED);
  expect((await b.call(() => b.text())).instructions).toContain("source guidance");
});

// ---------------------------------------------------------------- abort, timeout, late replies

test("abort before the reply refuses, and a late reply afterwards is ignored: it consumes no read id", async () => {
  const f = fixture(), h = harness(f), controller = new AbortController(), pending = gate<string>(), late = nextId(), unhandled: unknown[] = [];
  const watch = (reason: unknown) => { unhandled.push(reason); }; process.on("unhandledRejection", watch);
  try {
    const run = h.call(() => pending.promise, controller.signal), outcome = run.then(() => "resolved", (error: Error) => error.message);
    await tick(); expect(h.sdk.calls.length).toBe(1);
    controller.abort(); expect(await outcome).toBe("required_context_unavailable");
    pending.resolve(h.text(undefined, late)); await tick(); await tick();
    // The late frame was dropped before parsing: its read id is still unused, so a fresh invocation may carry it.
    expect((await h.call(() => h.text(undefined, late))).instructions).toContain("shared guidance");
    await expect(h.call(() => h.text(undefined, late))).rejects.toThrow(REFUSED);
    // A rejecting late port is also handled.
    const rejecting = gate<string>(), second = new AbortController(), run2 = h.call(() => rejecting.promise, second.signal), outcome2 = run2.then(() => "resolved", (error: Error) => error.message);
    await tick(); second.abort(); expect(await outcome2).toBe("required_context_unavailable");
    rejecting.reject(new Error("late port failure")); await tick(); await tick();
    expect(unhandled).toEqual([]);
  } finally { process.off("unhandledRejection", watch); }
});

test("an already-aborted invocation never reaches the port", async () => {
  const f = fixture(), h = harness(f), controller = new AbortController(); controller.abort();
  await expect(h.call(() => h.text(), controller.signal)).rejects.toThrow(REFUSED); expect(h.sdk.calls.length).toBe(0);
});

test("the resolver's timeout stops the wait without aborting the original; a late reply after it is ignored", async () => {
  const f = fixture(), h = harness(f, PARENT, { timeoutMs: 25 }), controller = new AbortController(), pending = gate<string>(), late = nextId();
  await expect(h.call(() => pending.promise, controller.signal)).rejects.toThrow(REFUSED);
  expect(controller.signal.aborted).toBe(false); expect(h.sdk.calls[0]).toBe(controller.signal);
  pending.resolve(h.text(undefined, late)); await tick(); await tick();
  expect((await h.call(() => h.text(undefined, late))).instructions).toContain("shared guidance");
});

// ---------------------------------------------------------------- parser refusal matrix

test("frame text refusals: non-strings, line framing, size, encoding and JSON shape", async () => {
  const f = fixture(), h = harness(f), good = h.text(), grown = (extra: number) => { const frame = h.obj(); frame.snapshot.text = ""; const base = Buffer.byteLength(serialize(frame), "utf8"); frame.snapshot.text = "a".repeat(COWORK_GUIDED_FRAME_MAX_BYTES - base + extra); return serialize(frame); };
  expect(Buffer.byteLength(grown(1), "utf8")).toBe(COWORK_GUIDED_FRAME_MAX_BYTES + 1);
  await allRefused(h, [
    ["undefined", undefined], ["null", null], ["number", 7], ["object", {}], ["array of lines", [good]], ["Buffer", Buffer.from(good)], ["Uint8Array", new TextEncoder().encode(good)],
    ["empty", ""], ["newline only", "\n"], ["no trailing newline", good.slice(0, -1)], ["two trailing newlines", `${good}\n`], ["CRLF", `${good.slice(0, -1)}\r\n`],
    ["pretty printed", `${JSON.stringify(h.obj(), null, 2)}\n`], ["leading space", ` ${good}`], ["trailing space", `${good.slice(0, -1)} \n`], ["leading BOM", `﻿${good}`],
    ["one byte over the cap", grown(1)], ["far over the cap", grown(COWORK_GUIDED_FRAME_MAX_BYTES)],
    ["multi-byte over the cap", (() => { const frame = h.obj(); frame.snapshot.text = "é".repeat(COWORK_GUIDED_FRAME_MAX_BYTES / 2); return serialize(frame); })()],
    ["lone surrogate", good.replace("shared guidance", "shared \uD800 guidance")], ["not JSON", "garbage\n"], ["truncated", `${good.slice(0, 40)}\n`],
    ["top-level array", "[]\n"], ["top-level null", "null\n"], ["top-level number", "7\n"], ["top-level string", '"frame"\n'], ["top-level boolean", "true\n"],
    ["alternate escape spelling", good.replace('"version"', '"\\u0076ersion"')], ["alternate number spelling", good.replace('"version":1', '"version":1.0')], ["exponent number", good.replace('"version":1', '"version":1e0')],
  ]);
});

test("frame key-set refusals: extra, missing, duplicate and wrongly typed keys at every level", async () => {
  const f = fixture(), h = harness(f);
  const cases: [string, unknown][] = [
    ["extra top-level key", h.text(frame => { frame.extra = 1; })], ["extra key named registrationId", h.text(frame => { frame.registrationId = REGISTRATION; })],
    ["snapshot hoisted beside the frame", h.text(frame => { frame.snapshot2 = frame.snapshot; })],
    ["duplicate version key", h.text().replace('"version":1', '"version":1,"version":1')], ["duplicate version key, last wins", h.text().replace('"version":1', '"version":2,"version":1')],
    ["duplicate readId key", (() => { const id = nextId(), text = h.text(undefined, id); return text.replace(`"readId":"${id}"`, `"readId":"${nextId()}","readId":"${id}"`); })()],
    ["duplicate owner key", h.text().replace('"owner":{', '"owner":{"leaseEpoch":1,')], ["duplicate snapshot key", h.text().replace('"tiers":"admitted-only"', '"tiers":"admitted-only","tiers":"admitted-only"')],
    ["duplicate limits key", h.text().replace('"limits":', '"limits":{},"limits":')],
  ];
  for (const key of COWORK_GUIDED_FRAME_KEYS) cases.push([`missing top-level ${key}`, h.text(frame => { delete frame[key]; })]);
  for (const key of COWORK_GUIDED_FRAME_OWNER_KEYS) cases.push([`missing owner.${key}`, h.text(frame => { delete frame.owner[key]; })]);
  for (const key of COWORK_GUIDED_FRAME_VIEW_KEYS) cases.push([`missing views.${key}`, h.text(frame => { delete frame.views[key]; })]);
  for (const key of Object.keys(COWORK_GUIDED_FRAME_LIMITS)) cases.push([`missing limits.${key}`, h.text(frame => { delete frame.limits[key]; })]);
  for (const key of COWORK_GUIDED_FRAME_SNAPSHOT_KEYS) cases.push([`missing snapshot.${key}`, h.text(frame => { delete frame.snapshot[key]; })]);
  cases.push(["owner carries workspaceId (the frame strips it)", h.text(frame => { frame.owner.workspaceId = f.workspaceId; })], ["extra owner key", h.text(frame => { frame.owner.extra = 1; })],
    ["extra views key", h.text(frame => { frame.views.extra = "/x"; })], ["extra limits key", h.text(frame => { frame.limits.extra = 1; })], ["extra snapshot key", h.text(frame => { frame.snapshot.extra = 1; })]);
  for (const key of ["owner", "views", "limits", "snapshot"]) for (const [label, value] of [["null", null], ["array", []], ["string", "x"], ["number", 7]] as const) cases.push([`${key} is ${label}`, h.text(frame => { frame[key] = value; })]);
  await allRefused(h, cases);
});

test("frame version refusals", async () => {
  const f = fixture(), h = harness(f);
  await allRefused(h, [0, 2, 1.5, -1, "1", true, null, [1], { v: 1 }].map(value => [`version ${JSON.stringify(value)}`, h.text(frame => { frame.version = value; })] as [string, unknown]));
});

test("owner mismatch refusals: every one of the six fields, compared with the capture", async () => {
  const f = fixture(), h = harness(f), cases: [string, unknown][] = [];
  for (const key of COWORK_GUIDED_FRAME_OWNER_KEYS) {
    cases.push([`owner.${key} changed`, h.text(frame => { const value = frame.owner[key]; frame.owner[key] = typeof value === "number" ? value + 1 : `${value}x`; })]);
    cases.push([`owner.${key} wrong type`, h.text(frame => { frame.owner[key] = typeof frame.owner[key] === "number" ? String(frame.owner[key]) : 7; })]);
    cases.push([`owner.${key} null`, h.text(frame => { frame.owner[key] = null; })]);
  }
  cases.push(["owner of the sibling backend", h.text(frame => { frame.owner.backendSessionId = SECOND_BACKEND; })], ["owner logical id is the backend id", h.text(frame => { frame.owner.logicalSessionId = BACKEND; })],
    ["owner bootId swapped", h.text(frame => { frame.owner.bootId = otherBoot; })]);
  await allRefused(h, cases);
});

test("view mismatch refusals: every one of the four fields, compared with the reader plan", async () => {
  const f = fixture(), h = harness(f), cases: [string, unknown][] = [];
  for (const key of COWORK_GUIDED_FRAME_VIEW_KEYS) {
    cases.push([`views.${key} foreign`, h.text(frame => { frame.views[key] = `${frame.views[key]}/elsewhere`; })]);
    cases.push([`views.${key} wrong type`, h.text(frame => { frame.views[key] = 7; })]);
    cases.push([`views.${key} empty`, h.text(frame => { frame.views[key] = ""; })]);
  }
  cases.push(["sourceCwd is the root", h.text(frame => { frame.views.sourceCwd = f.root; })], ["alternate branded shared path", h.text(frame => { frame.views.sharedPath = `${COWORK_SHARED_INSTRUCTION_VIEW}/CLAUDE.md`; })]);
  await allRefused(h, cases);
});

test("limit mismatch refusals: every one of the four fields, widened, narrowed or mistyped", async () => {
  const f = fixture(), h = harness(f), cases: [string, unknown][] = [];
  for (const key of Object.keys(COWORK_GUIDED_FRAME_LIMITS)) {
    cases.push([`limits.${key} widened`, h.text(frame => { frame.limits[key] *= 2; })], [`limits.${key} narrowed`, h.text(frame => { frame.limits[key] -= 1; })],
      [`limits.${key} string`, h.text(frame => { frame.limits[key] = String(frame.limits[key]); })], [`limits.${key} zero`, h.text(frame => { frame.limits[key] = 0; })]);
  }
  await allRefused(h, cases);
});

test("read id refusals: malformed, wrong version, canonical-id echo and reuse", async () => {
  const f = fixture(), h = harness(f);
  await allRefused(h, [
    ["number", 5], ["null", null], ["empty", ""], ["not a uuid", "not-a-uuid"], ["uuid v1", "00000000-0000-1000-8000-000000000001"], ["uuid bad variant", "00000000-0000-4000-c000-000000000001"],
    ["uppercase v4", randomUUID().toUpperCase()], ["padded", ` ${nextId()}`], ["trailing newline escape", `${nextId()}\n`], ["too long", `${nextId()}0`],
  ].map(([name, value]) => [`readId ${name}`, h.text(frame => { frame.readId = value; })] as [string, unknown]));
  // Freshness: the first use succeeds, any reuse is refused, even with every other field valid, and a new id works again.
  const reused = nextId();
  expect((await h.call(() => h.text(undefined, reused))).instructions).toContain("shared guidance");
  for (let attempt = 0; attempt < 3; attempt++) await expect(h.call(() => h.text(undefined, reused))).rejects.toThrow(REFUSED);
  expect((await h.call(() => h.text())).instructions).toContain("shared guidance");
});

test("a read id is single use across overlapping invocations of one owner, and a refused frame still consumes its id", async () => {
  const f = fixture(), h = harness(f), shared = nextId(), a = gate<string>(), b = gate<string>();
  const first = h.call(() => a.promise), second = h.call(() => b.promise);
  await tick(); a.resolve(h.text(undefined, shared)); b.resolve(h.text(undefined, shared));
  const outcomes = await Promise.allSettled([first, second]);
  expect(outcomes.map(o => o.status).sort()).toEqual(["fulfilled", "rejected"]);
  // A frame refused for another reason burns its id: replaying it with the defect fixed is refused.
  const burned = nextId();
  await expect(h.call(() => h.text(frame => { frame.owner.generation += 1; }, burned))).rejects.toThrow(REFUSED);
  await expect(h.call(() => h.text(undefined, burned))).rejects.toThrow(REFUSED);
  // Read ids are per owner/handler; they are not a cross-owner ledger.
  f.conversation(SECOND, SECOND_BACKEND, "other");
  const sibling = harness(f, SECOND), siblingId = nextId();
  expect((await sibling.call(() => sibling.text(undefined, siblingId))).instructions).toContain("shared guidance");
});

test("the parser itself: the canonical read id may never be echoed, and a claim that fails refuses", () => {
  const f = fixture(), { capture } = f.ready(), frame = frameObject(capture, f.root, nextId());
  const expected = (canonicalReadId: string): CoworkGuidedFrameExpectation => ({ canonicalReadId, owner: frame.owner, views: frame.views, limits: frame.limits as CoworkGuidedFrameExpectation["limits"] });
  expect(() => parseCoworkGuidedReaderFrame(serialize(frame), expected(frame.readId), () => true)).toThrow(REFUSED);
  expect(() => parseCoworkGuidedReaderFrame(serialize(frame), expected(nextId()), () => false)).toThrow(REFUSED);
  expect(() => parseCoworkGuidedReaderFrame(serialize(frame), expected(nextId()), () => true)).not.toThrow();
  expect(() => parseCoworkGuidedReaderFrame(serialize({ ...frame, readId: 5 }), expected(nextId()), () => { throw new Error("must not be reached"); })).toThrow(REFUSED);
  // A claim that throws is also a refusal, never an escape.
  expect(() => parseCoworkGuidedReaderFrame(serialize(frame), expected(nextId()), () => { throw new Error("claim exploded"); })).toThrow(REFUSED);
});

function parserFixture() {
  const f = fixture(), { capture } = f.ready(), frame = frameObject(capture, f.root);
  const expected = (): CoworkGuidedFrameExpectation => ({ canonicalReadId: nextId(), owner: frame.owner, views: frame.views, limits: frame.limits as CoworkGuidedFrameExpectation["limits"] });
  return { f, capture, frame, good: serialize(frame), expected };
}

test("the parser refuses oversize, deep, unframed and mis-encoded text before any JSON parse runs", () => {
  const { frame, good, expected } = parserFixture();
  const padded = (extra: number) => { const copy = structuredClone(frame); copy.snapshot.text = ""; const base = Buffer.byteLength(serialize(copy), "utf8"); copy.snapshot.text = "a".repeat(COWORK_GUIDED_FRAME_MAX_BYTES - base + extra); return serialize(copy); };
  const insert = (value: string) => good.replace('"blocks":[', `"blocks":[${value},`);
  const cases: [string, unknown][] = [
    ["not a string", { frame: good }], ["one byte over the cap", padded(1)], ["multi-byte over the cap", serialize({ ...frame, snapshot: { ...frame.snapshot, text: "é".repeat(COWORK_GUIDED_FRAME_MAX_BYTES / 2) } })],
    ["no newline", good.slice(0, -1)], ["interior newline", `${JSON.stringify(frame, null, 1)}\n`], ["lone surrogate", good.replace("shared guidance", "shared \uD800")],
    ["deep list", insert(nested(COWORK_GUIDED_FRAME_MAX_DEPTH + 4, 0))], ["deep object", insert(nested(COWORK_GUIDED_FRAME_MAX_DEPTH + 4, 0, '{"a":', "}"))],
    ["huge list nesting", insert(`${"[".repeat(100_000)}${"]".repeat(100_000)}`)], ["unbalanced", good.replace('"blocks":[', '"blocks":[[[[[[[[[')],
  ];
  const real = JSON.parse; let parses = 0;
  JSON.parse = ((text: string, reviver?: Parameters<typeof JSON.parse>[1]) => { parses++; return real(text, reviver); }) as typeof JSON.parse;
  try {
    const accepted = cases.filter(([, raw]) => { try { parseCoworkGuidedReaderFrame(raw, expected(), () => true); return true; } catch (error) { return !REFUSED.test((error as Error).message); } }).map(([name]) => name);
    expect(accepted).toEqual([]); expect(parses).toBe(0);
    parseCoworkGuidedReaderFrame(good, expected(), () => true); expect(parses).toBe(1);
  } finally { JSON.parse = real; }
});

test("a frame with a prototype-slot key anywhere is refused before its read id is consumed", () => {
  const { good, expected } = parserFixture();
  const cases: [string, string][] = [
    ["top-level", good.replace("{", '{"__proto__":{"polluted":true},')], ["owner", good.replace('"owner":{', '"owner":{"__proto__":{"polluted":true},')], ["views", good.replace('"views":{', '"views":{"constructor":1,')],
    ["snapshot", good.replace('"snapshot":{', '"snapshot":{"__proto__":{"polluted":true},')], ["block record", good.replace('"blocks":[{', '"blocks":[{"prototype":1,')],
    ["provenance record", good.replace('"provenance":[{', '"provenance":[{"__proto__":{"polluted":true},')],
  ];
  const before = Reflect.ownKeys(Object.prototype).length;
  for (const [name, raw] of cases) {
    let claims = 0;
    expect(() => parseCoworkGuidedReaderFrame(raw, expected(), () => { claims++; return true; })).toThrow(REFUSED);
    expect(`${name}:${claims}`).toBe(`${name}:0`);
  }
  expect(Reflect.ownKeys(Object.prototype).length).toBe(before); expect(({} as Record<string, unknown>).polluted).toBeUndefined();
});

test("the parser itself closes the snapshot's key set, so a drifted SDK snapshot is refused before the mapper", () => {
  const { frame, expected } = parserFixture(), refused: string[] = [];
  const attempt = (name: string, change: (copy: Record<string, any>) => void) => {
    const copy = structuredClone(frame); change(copy);
    try { parseCoworkGuidedReaderFrame(serialize(copy), expected(), () => true); refused.push(`${name}: ACCEPTED`); } catch (error) { if (!REFUSED.test((error as Error).message)) refused.push(`${name}: ${(error as Error).message}`); }
  };
  for (const key of COWORK_GUIDED_FRAME_SNAPSHOT_KEYS) attempt(`missing ${key}`, copy => { delete copy.snapshot[key]; });
  attempt("extra key", copy => { copy.snapshot.extra = 1; }); attempt("array", copy => { copy.snapshot = []; }); attempt("null", copy => { copy.snapshot = null; });
  expect(refused).toEqual([]);
});

test("the read id set is bounded, single use and fails closed when full", () => {
  const ids = new CoworkGuidedReadIdSet(3);
  expect([nextId(), nextId(), nextId()].map(id => ids.claim(id))).toEqual([true, true, true]);
  const again = nextId(); expect(ids.claim(again)).toBe(false);
  const reused = new CoworkGuidedReadIdSet(2), first = nextId(); expect(reused.claim(first)).toBe(true); expect(reused.claim(first)).toBe(false); expect(reused.claim(nextId())).toBe(true); expect(reused.claim(nextId())).toBe(false);
  expect(COWORK_GUIDED_READ_ID_CAPACITY).toBe(4096);
  for (const bad of [0, -1, 1.5, 4097, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => new CoworkGuidedReadIdSet(bad)).toThrow(REFUSED);
  expect(new CoworkGuidedReadIdSet().claim(nextId())).toBe(true);
});

test("deep nesting is refused from the raw text, before any parser or serializer can recurse", async () => {
  const f = fixture(), h = harness(f), good = h.text();
  const insert = (value: string) => good.replace('"blocks":[', `"blocks":[${value},`);
  const started = performance.now();
  await allRefused(h, [
    ["list nested past the bound", insert(nested(COWORK_GUIDED_FRAME_MAX_DEPTH + 4, 0))], ["object nested past the bound", insert(nested(COWORK_GUIDED_FRAME_MAX_DEPTH + 4, 0, '{"a":', "}"))],
    ["one level over the bound", insert(nested(COWORK_GUIDED_FRAME_MAX_DEPTH - 1, 0))],
    ["100000 levels of list", insert(`${"[".repeat(100_000)}${"]".repeat(100_000)}`)], ["100000 levels of object", insert(`${'{"a":'.repeat(50_000)}0${"}".repeat(50_000)}`)],
    ["unbalanced opening", good.replace('"blocks":[', '"blocks":[[[[[[[[[')], ["unbalanced closing", good.replace('"droppedImports":[]', '"droppedImports":[]]]]]')],
    ["string never closed", `{"version":1,"readId":"${nextId()}\n`],
  ]);
  expect(performance.now() - started).toBeLessThan(5000);
});

test("prototype pollution: __proto__ and constructor keys are refused at every level and pollute nothing", async () => {
  const before = Reflect.ownKeys(Object.prototype).sort().map(String);
  const f = fixture(), h = harness(f), good = h.text();
  await allRefused(h, [
    ["top-level __proto__", good.replace("{", '{"__proto__":{"polluted":true},')], ["top-level __proto__ at the end", good.replace(/}\n$/, ',"__proto__":{"polluted":true}}\n')],
    ["__proto__ replacing version", good.replace('"version":1', '"__proto__":1')], ["owner.__proto__", good.replace('"owner":{', '"owner":{"__proto__":{"polluted":true},')],
    ["views.__proto__", good.replace('"views":{', '"views":{"__proto__":{"polluted":true},')], ["limits.__proto__", good.replace('"limits":{', '"limits":{"__proto__":{"polluted":true},')],
    ["snapshot.__proto__", good.replace('"snapshot":{', '"snapshot":{"__proto__":{"polluted":true},')], ["block record __proto__", good.replace('"blocks":[{', '"blocks":[{"__proto__":{"polluted":true},')],
    ["provenance record __proto__", good.replace('"provenance":[{', '"provenance":[{"__proto__":{"polluted":true},')],
    ["constructor.prototype pollution", good.replace('"snapshot":{', '"snapshot":{"constructor":{"prototype":{"polluted":true}},')],
    ["prototype key", good.replace('"snapshot":{', '"snapshot":{"prototype":{"polluted":true},')], ["escaped __proto__ key", good.replace("{", '{"\\u005f\\u005fproto__":{"polluted":true},')],
  ]);
  expect(({} as Record<string, unknown>).polluted).toBeUndefined(); expect(Reflect.ownKeys(Object.prototype).sort().map(String)).toEqual(before);
  // A __proto__ spelling inside a string value is just text and is accepted.
  const frame = h.obj(value => { value.snapshot = snapshotOf(f.root, 'the key "__proto__" and constructor are words here\n'); });
  expect((await h.call(() => serialize(frame))).instructions).toContain("__proto__");
});

test("snapshot refusals reach the existing mapper's closed semantics; nothing is repaired or skipped", async () => {
  const f = fixture(), h = harness(f), cases: [string, unknown][] = [];
  const mutate = (label: string, change: (snapshot: Record<string, any>) => void) => cases.push([label, h.text(frame => { change(frame.snapshot); })]);
  mutate("tiers other than admitted-only", s => { s.tiers = "all"; }); mutate("digest mismatch", s => { s.digest = "0".repeat(64); });
  mutate("text altered after the digest", s => { s.text += "x"; }); mutate("a skipped link", s => { s.skippedLinks = [{ path: "/x" }]; }); mutate("a dropped import", s => { s.droppedImports = ["/x"]; });
  mutate("no blocks", s => { s.blocks = []; }); mutate("no provenance", s => { s.provenance = []; }); mutate("legacy files longer than provenance", s => { s.files = [...s.files, s.files[0]]; });
  mutate("block text not newline terminated", s => { s.blocks[1].text = "source guidance"; });
  mutate("block hash mismatch", s => { s.blocks[1].textSha256 = "1".repeat(64); }); mutate("block with an extra key", s => { s.blocks[1].extra = 1; });
  mutate("source block outside the admitted root", s => { s.blocks[1].requestedPath = "/etc/WINTER.md"; s.blocks[1].admittedPath = "/etc/WINTER.md"; });
  mutate("shared top replaced", s => { s.blocks[0].requestedPath = `${COWORK_SHARED_INSTRUCTION_VIEW}/other.md`; });
  mutate("block with a parent traversal", s => { s.blocks[1].admittedPath = `${f.root}/../escape/WINTER.md`; });
  mutate("text is a number", s => { s.text = 7; }); mutate("blocks is an object", s => { s.blocks = {}; });
  await allRefused(h, cases);
});

// ---------------------------------------------------------------- owner and request gates

test("a closed, revoked, replaced or unvouched owner never reaches the port", async () => {
  const cases: [string, (f: Fixture, h: Harness) => void][] = [
    ["revoke", (_f, h) => h.owner.revoke()], ["close", (_f, h) => h.owner.close("host-stopping")], ["supersede", f => { f.registry.prepare(f.planned()); }],
    ["registry stop", f => f.registry.stop()], ["lifetime lost", f => f.setHeld(false)], ["evidence lost", f => { f.fake.override = e => ({ ...e, kernel: { pidfs: false, peerPidfd: true } }); }],
    ["evidence throws", f => { f.fake.override = () => { throw new Error("port down"); }; }], ["boot change", f => f.setBoot(otherBoot)],
    ["lease change", f => f.sql("UPDATE cowork_workspaces SET lease_epoch=lease_epoch+1 WHERE workspace_id=?", f.workspaceId)],
    ["backend generation change", f => { f.sessions.bumpGeneration(PARENT, { runtimeKind: "winter-agent", backendSessionId: BACKEND }); }],
  ];
  for (const [name, trigger] of cases) {
    const f = fixture(), h = harness(f); trigger(f, h);
    const outcome = await h.call(() => h.text()).then(() => "resolved", (error: Error) => error.message);
    expect(`${name}:${outcome}:${h.sdk.calls.length}`).toBe(`${name}:required_context_unavailable:0`);
  }
});

test("an owner that was never correlated, never given a lifetime or has no reader plan never reaches the port", async () => {
  for (const attach of [(_o: CoworkGuestContextOwner) => {}, (o: CoworkGuestContextOwner) => o.bindCorrelation({ version: 1, bindingId: BINDING }), (o: CoworkGuestContextOwner) => o.attachLifetime({ held: () => true })]) {
    const f = fixture(), capture = f.planned(), owner = f.registry.prepare(capture); attach(owner);
    const sdk = fakeSdk(), preparation = {}, signal = new AbortController().signal; sdk.install(signal, preparation, () => serialize(frameObject(capture, f.root)));
    const handler = createCoworkGuidedRuntimeContextHandler({ records: f.records, grants: f.grants, currentBootId: () => f.currentBoot(), registration: owner.registrationPort, capture, frames: sdk.port(preparation) });
    await expect(handler(f.requestFor(), { signal, trustedQuerySessionId: BACKEND })).rejects.toThrow(REFUSED); expect(sdk.calls.length).toBe(0);
  }
});

test("an owner that stops vouching during the read burns no read id: the frame is dropped before it is parsed", async () => {
  const f = fixture(), h = harness(f), id = nextId();
  await expect(h.call(async () => { const frame = h.text(undefined, id); f.setHeld(false); return frame; })).rejects.toThrow(REFUSED);
  f.setHeld(true);
  expect((await h.call(() => h.text(undefined, id))).instructions).toContain("shared guidance");
});

const duringRead: [string, (f: Fixture, h: Harness) => void][] = [
  ["revoke", (_f, h) => h.owner.revoke()], ["close", (_f, h) => h.owner.close("runtime-exited")], ["supersede", f => { f.registry.prepare(f.planned()); }],
  ["registry stop", f => f.registry.stop()], ["lifetime lost", f => f.setHeld(false)], ["evidence lost", f => { f.fake.override = e => ({ ...e, kernel: { pidfs: false, peerPidfd: true } }); }],
  ["boot change", f => f.setBoot(otherBoot)], ["lease change", f => f.sql("UPDATE cowork_workspaces SET lease_epoch=lease_epoch+1 WHERE workspace_id=?", f.workspaceId)],
];
for (const [name, trigger] of duringRead) {
  test(`${name} while the reader is awaiting refuses through the real resolver, with no cached fallback`, async () => {
    const f = fixture(), h = harness(f); let trip = false;
    const produce = async () => { const frame = h.text(); await Promise.resolve(); if (trip) trigger(f, h); return frame; };
    expect((await h.call(produce)).instructions).toContain("shared guidance");
    trip = true; await expect(h.call(produce)).rejects.toThrow(REFUSED); expect(h.sdk.calls.length).toBe(2);
    trip = false; await expect(h.call(produce)).rejects.toThrow(REFUSED);
  });
}

test("a request that is not a plain parent request is refused before the port is asked", async () => {
  const f = fixture(), h = harness(f), good = h.request, root = f.root;
  const requests: [string, unknown][] = [
    ["child agent id", { ...good, agentId: "agent-1" }], ["extra key", { ...good, extra: 1 }], ["missing cwd", { bindingId: good.bindingId, sessionId: good.sessionId, purpose: "generation", attempt: 1 }],
    ["bad purpose", { ...good, purpose: "other" }], ["attempt zero", { ...good, attempt: 0 }], ["attempt fraction", { ...good, attempt: 1.5 }], ["bad binding", { ...good, bindingId: "bad id!" }],
    ["foreign backend session", { ...good, sessionId: SECOND_BACKEND }], ["logical session id", { ...good, sessionId: PARENT }], ["cwd outside the source", { ...good, cwd: "/etc" }],
    ["cwd below the captured view", { ...good, cwd: `${root}/directory/nested` }], ["cwd above the captured view", { ...good, cwd: root }], ["cwd with a NUL", { ...good, cwd: `${root}/directory\0` }],
    ["null request", null], ["string request", "request"], ["array request", []],
    ["accessor request", Object.defineProperty({ ...good }, "cwd", { get: () => good.cwd, enumerable: true })],
  ];
  const wrong: string[] = [];
  for (const [name, request] of requests) {
    const signal = new AbortController().signal; h.sdk.install(signal, h.preparation, () => h.text());
    try { await h.handler(request as CoworkRuntimeContextRequest, h.options(signal)); wrong.push(`${name}: ACCEPTED`); } catch (error) { if (!REFUSED.test((error as Error).message)) wrong.push(`${name}: ${(error as Error).message}`); }
  }
  expect(wrong).toEqual([]); expect(h.sdk.calls.length).toBe(0);
  expect((await h.call(() => h.text())).instructions).toContain("shared guidance");
});

test("option shapes follow the existing handler's contract and refuse the same way", async () => {
  const f = fixture(), h = harness(f); let reads = 0;
  const existing = createCoworkRuntimeContextHandler({ records: f.records, grants: f.grants, trustedQuerySessionId: BACKEND, currentRegistration: h.owner.registrationPort, currentBootId: () => f.currentBoot(),
    reader: { read: async () => { reads++; throw new Error("never"); } } });
  const live = new AbortController().signal, aborted = new AbortController(); aborted.abort();
  const variants: [string, unknown][] = [
    ["extra option key", { signal: live, trustedQuerySessionId: BACKEND, extra: 1 }], ["missing signal", { trustedQuerySessionId: BACKEND }], ["missing trusted id", { signal: live }],
    ["aborted signal", { signal: aborted.signal, trustedQuerySessionId: BACKEND }], ["foreign trusted id", { signal: live, trustedQuerySessionId: SECOND_BACKEND }],
    ["accessor signal", Object.defineProperty({ trustedQuerySessionId: BACKEND }, "signal", { get: () => live, enumerable: true })], ["null options", null], ["undefined options", undefined],
    ["array options", []], ["string options", "options"],
  ];
  for (const [name, options] of variants) {
    const mine = await h.handler(h.request, options as never).then(() => "resolved", (error: Error) => error.message);
    const base = await existing(h.request, options as never).then(() => "resolved", (error: Error) => error.message);
    expect(`${name}:${mine}`).toBe(`${name}:required_context_unavailable`); expect(`${name}:${base}`).toBe(`${name}:required_context_unavailable`);
  }
  expect(reads).toBe(0); expect(h.sdk.calls.length).toBe(0);
});

// ---------------------------------------------------------------- capture and construction

test("construction refuses a capture with no reader plan, a self-contradicting plan, or a mistyped dependency", () => {
  const f = fixture(), { owner, capture } = f.ready(), sdk = fakeSdk(), frames = sdk.port({});
  const build = (change: Record<string, unknown> | undefined, extra: Record<string, unknown> = {}) => () => createCoworkGuidedRuntimeContextHandler({ records: f.records, grants: f.grants, currentBootId: () => f.currentBoot(),
    registration: owner.registrationPort, capture: (change ? { ...capture, ...change } : capture) as CoworkGuidedReaderCapture, frames, ...extra } as never);
  expect(build(undefined)).not.toThrow();
  const { views, limits, readerRegistrationId } = capture;
  expect(() => createCoworkGuidedRuntimeContextHandler({ records: f.records, grants: f.grants, currentBootId: () => f.currentBoot(), registration: owner.registrationPort, capture: f.plain() as never, frames })).toThrow(REFUSED);
  const refused: [string, ReturnType<typeof build>][] = [
    ["no views", build({ views: undefined })], ["no limits", build({ limits: undefined })], ["no registration id", build({ readerRegistrationId: undefined })], ["bad registration id", build({ readerRegistrationId: "bad id" })],
    ["views from another cwd", build({ views: { ...views!, sourceCwd: `${f.root}/elsewhere` } })], ["views from another root", build({ views: { ...views!, sourceRoot: "/workspace/folders/other" } })],
    ["views with a brand path", build({ views: { ...views!, sharedPath: `${COWORK_SHARED_INSTRUCTION_VIEW}/ACME.md` } })], ["extra view key", build({ views: { ...views!, extra: "/x" } })],
    ["widened limits", build({ limits: { ...limits!, maxReadBytes: limits!.maxReadBytes * 2 } })], ["extra limit key", build({ limits: { ...limits!, extra: 1 } })],
    ["trusted id is the logical id", build({ trustedQuerySessionId: PARENT })], ["trusted id differs from backend", build({ trustedQuerySessionId: "other-trusted" })],
    ["zero generation", build({ backendGeneration: 0 })], ["fractional epoch", build({ leaseEpoch: 1.5 })], ["bad boot id", build({ bootId: "not-a-boot-id" })], ["no source", build({ source: undefined })],
    ["source access invented", build({ source: { ...capture.source, access: "admin" } })],
    ["accessor field", () => createCoworkGuidedRuntimeContextHandler({ records: f.records, grants: f.grants, currentBootId: () => f.currentBoot(), registration: owner.registrationPort,
      capture: Object.defineProperty({ ...capture }, "sessionId", { get: () => PARENT, enumerable: true }) as never, frames })],
    ["no registration port", build(undefined, { registration: undefined })], ["port is not a function", build(undefined, { registration: {} })], ["no frame port", build(undefined, { frames: undefined })],
    ["frame port without readFrame", build(undefined, { frames: {} })], ["frame port null", build(undefined, { frames: null })],
  ];
  const wrong: string[] = [];
  for (const [name, run] of refused) { try { run(); wrong.push(`${name}: ACCEPTED`); } catch (error) { if (!REFUSED.test((error as Error).message)) wrong.push(`${name}: ${(error as Error).message}`); } }
  expect(wrong).toEqual([]); void readerRegistrationId;
});

test("the capture is copied at construction: later edits to a plain copy change nothing", async () => {
  const f = fixture(), { owner, capture } = f.ready(), plain = structuredClone({ ...capture }) as { backendGeneration: number }, sdk = fakeSdk(), preparation = {};
  const handler = createCoworkGuidedRuntimeContextHandler({ records: f.records, grants: f.grants, currentBootId: () => f.currentBoot(), registration: owner.registrationPort, capture: plain as unknown as CoworkGuidedReaderCapture, frames: sdk.port(preparation) });
  plain.backendGeneration = 99;
  const signal = new AbortController().signal; sdk.install(signal, preparation, () => serialize(frameObject(capture, f.root)));
  expect((await handler(f.requestFor(), { signal, trustedQuerySessionId: BACKEND })).instructions).toContain("shared guidance");
});

test("every call re-checks the live registration against the capture, field by field", async () => {
  const changes: [string, (c: CoworkGuestOwnerCapture) => Record<string, unknown>][] = [
    ["generation", c => ({ backendGeneration: c.backendGeneration + 1 })], ["incarnation", () => ({ incarnationId: "incarnation-other" })], ["lease epoch", c => ({ leaseEpoch: c.leaseEpoch + 1 })],
    ["boot", () => ({ bootId: otherBoot })], ["logical session", () => ({ sessionId: SECOND })], ["workspace", () => ({ workspaceId: "ws_other" })],
    ["source revision", c => ({ source: { ...c.source, revision: c.source.revision + 1 } })], ["source id", c => ({ source: { ...c.source, sourceId: "src_other" } })],
    ["source access", c => ({ source: { ...c.source, access: "read-only" } })],
  ];
  for (const [name, change] of changes) {
    const f = fixture(), { owner, capture } = f.ready(), sdk = fakeSdk(), preparation = {}, signal = new AbortController().signal;
    sdk.install(signal, preparation, () => serialize(frameObject(capture, f.root)));
    const handler = createCoworkGuidedRuntimeContextHandler({ records: f.records, grants: f.grants, currentBootId: () => f.currentBoot(), registration: owner.registrationPort, frames: sdk.port(preparation),
      capture: { ...capture, ...change(capture) } as unknown as CoworkGuidedReaderCapture });
    await expect(handler(f.requestFor(), { signal, trustedQuerySessionId: BACKEND })).rejects.toThrow(REFUSED);
    expect(`${name}:${sdk.calls.length}`).toBe(`${name}:0`);
  }
});

test("a capture whose cwd and view disagree with the canonical request is refused before the port", async () => {
  const f = fixture(), { owner, capture } = f.ready(), sdk = fakeSdk(), preparation = {}, signal = new AbortController().signal;
  const cwd = `${f.root}/directory/nested`, views = { ...capture.views!, sourceCwd: cwd };
  sdk.install(signal, preparation, () => serialize(frameObject(capture, f.root)));
  const handler = createCoworkGuidedRuntimeContextHandler({ records: f.records, grants: f.grants, currentBootId: () => f.currentBoot(), registration: owner.registrationPort, frames: sdk.port(preparation),
    capture: { ...capture, cwd, views } as unknown as CoworkGuidedReaderCapture });
  await expect(handler(f.requestFor(), { signal, trustedQuerySessionId: BACKEND })).rejects.toThrow(REFUSED); expect(sdk.calls.length).toBe(0);
});

// ---------------------------------------------------------------- drift guard and anti-wiring

test("drift guard: the copied frame definition equals the pinned SDK literal", () => {
  // Pinned independently of the module. Update BOTH after re-reading, in yanlingLabs/winter-agent-sdk,
  // packages/runtime/src/guest/linux-guided-reader-protocol.ts and packages/sdk/src/guided-reader-protocol.ts.
  expect(COWORK_GUIDED_FRAME_VERSION).toBe(1);
  expect([...COWORK_GUIDED_FRAME_KEYS]).toEqual(["version", "readId", "owner", "views", "limits", "snapshot"]);
  expect([...COWORK_GUIDED_FRAME_OWNER_KEYS]).toEqual(["logicalSessionId", "backendSessionId", "incarnationId", "leaseEpoch", "bootId", "generation"]);
  expect([...COWORK_GUIDED_FRAME_VIEW_KEYS]).toEqual(["sourceRoot", "sourceCwd", "sharedRoot", "sharedPath"]);
  expect([...COWORK_GUIDED_FRAME_SNAPSHOT_KEYS]).toEqual(["blocks", "digest", "droppedImports", "files", "provenance", "skippedLinks", "text", "tiers"]);
  expect({ ...COWORK_GUIDED_FRAME_LIMITS }).toEqual({ maxFileBytes: 131072, maxReadBytes: 262144, maxReadOccurrences: 256, maxExpandedBytes: 131072 });
  expect(COWORK_GUIDED_FRAME_MAX_BYTES).toBe(327680); expect(COWORK_GUIDED_FRAME_MAX_DEPTH).toBe(6); expect(COWORK_GUIDED_READ_ID_CAPACITY).toBe(4096);
  // The two Core copies of the loader limits and the shared view agree.
  expect({ ...COWORK_GUIDED_FRAME_LIMITS }).toEqual({ ...COWORK_GUEST_OWNER_READER_LIMITS }); expect(COWORK_SHARED_INSTRUCTION_VIEW).toBe("/run/winter/shared-instructions");
  for (const frozen of [COWORK_GUIDED_FRAME_KEYS, COWORK_GUIDED_FRAME_OWNER_KEYS, COWORK_GUIDED_FRAME_VIEW_KEYS, COWORK_GUIDED_FRAME_SNAPSHOT_KEYS, COWORK_GUIDED_FRAME_LIMITS]) expect(Object.isFrozen(frozen)).toBe(true);
  expect(Object.keys(adapter).sort()).toEqual(["COWORK_GUIDED_FRAME_KEYS", "COWORK_GUIDED_FRAME_LIMITS", "COWORK_GUIDED_FRAME_MAX_BYTES", "COWORK_GUIDED_FRAME_MAX_DEPTH", "COWORK_GUIDED_FRAME_OWNER_KEYS",
    "COWORK_GUIDED_FRAME_SNAPSHOT_KEYS", "COWORK_GUIDED_FRAME_VERSION", "COWORK_GUIDED_FRAME_VIEW_KEYS", "COWORK_GUIDED_READ_ID_CAPACITY", "CoworkGuidedReadIdSet",
    "createCoworkGuidedRuntimeContextHandler", "parseCoworkGuidedReaderFrame"]);
});

/** Opt-in: when WINTER_AGENT_SDK_SOURCE_DIR points at a checkout of the SDK repository, read (never import) its
 * frame definition and compare the copied values with it. Skipped everywhere else, including CI. */
test.skipIf(!process.env.WINTER_AGENT_SDK_SOURCE_DIR)("drift guard (opt-in): the copied constants match the SDK source text", () => {
  const sdk = process.env.WINTER_AGENT_SDK_SOURCE_DIR!;
  const protocol = readFileSync(join(sdk, "packages/runtime/src/guest/linux-guided-reader-protocol.ts"), "utf8"), bridge = readFileSync(join(sdk, "packages/sdk/src/guided-reader-protocol.ts"), "utf8");
  const list = (source: string, anchor: string) => { const at = source.indexOf(anchor); expect(at).toBeGreaterThan(-1); const open = source.indexOf("[", at), close = source.indexOf("]", open); return [...source.slice(open, close).matchAll(/"([^"]+)"/g)].map(m => m[1]!); };
  expect(list(protocol, "closedLinuxGuidedData(inner,")).toEqual([...COWORK_GUIDED_FRAME_KEYS]);
  expect(list(protocol, "const ownerKeys =").filter(key => key !== "workspaceId")).toEqual([...COWORK_GUIDED_FRAME_OWNER_KEYS]);
  expect(list(protocol, "closedLinuxGuidedData(data.views,")).toEqual([...COWORK_GUIDED_FRAME_VIEW_KEYS]);
  expect(list(protocol, "closedLinuxGuidedData(echo.snapshot,")).toEqual([...COWORK_GUIDED_FRAME_SNAPSHOT_KEYS]);
  expect(protocol).toContain("echo.version !== 1");
  expect(protocol).toContain("maxFileBytes: 128 * 1024, maxReadBytes: 256 * 1024, maxReadOccurrences: 256, maxExpandedBytes: 128 * 1024");
  expect(protocol).toContain("Buffer.byteLength(data.frame, \"utf8\") > 320 * 1024");
  expect(protocol).toContain("`${JSON.stringify(inner)}\\n` !== data.frame");
  expect(bridge).toContain("GUIDED_READER_FRAME_BYTES = 1024 * 1024");
});

const sourceDirectory = (...parts: string[]) => join(import.meta.dir, "..", "..", "..", ...parts);
function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile() && /\.(ts|tsx|js|mjs|cjs)$/.test(entry.name)).map(entry => join(entry.parentPath, entry.name));
}
test("anti-wiring: no src file imports the adapter, it has no barrel export, the frame port has no implementation and no SDK is imported", () => {
  const packages = sourceDirectory(), module = join(packages, "core", "src", "cowork", "guided-reader-adapter.ts");
  expect(existsSync(module)).toBe(true);
  const sources = readdirSync(packages, { withFileTypes: true }).filter(entry => entry.isDirectory() && existsSync(join(packages, entry.name, "src"))).flatMap(entry => sourceFiles(join(packages, entry.name, "src")));
  expect(sources.length).toBeGreaterThan(100); expect(sources).toContain(module);
  for (const file of sources.filter(candidate => candidate !== module)) {
    const text = readFileSync(file, "utf8");
    for (const needle of ["guided-reader-adapter", "createCoworkGuidedRuntimeContextHandler", "CoworkGuidedFramePort", "parseCoworkGuidedReaderFrame", "CoworkGuidedReadIdSet", "CoworkGuidedReaderCapture", "readFrame"])
      expect(`${basename(file)}:${needle}:${text.includes(needle)}`).toBe(`${basename(file)}:${needle}:false`);
  }
  expect(existsSync(join(packages, "core", "src", "cowork", "index.ts"))).toBe(false);
  expect(readFileSync(join(packages, "core", "src", "index.ts"), "utf8")).not.toMatch(/guided-reader-adapter|from "\.\/cowork/);
  const own = readFileSync(module, "utf8");
  expect(own).not.toMatch(/implements\s+CoworkGuidedFramePort|:\s*CoworkGuidedFramePort\s*=\s*\{|class\s+\w+[^{]*CoworkGuidedFramePort|readFrame\s*\([^)]*\)\s*(:[^{\n]*)?\{/);
  // Only the four existing, reviewed modules are imported; neither the SDK nor the Slice A slot (whose own anti-wiring pin forbids src importers).
  const imports = [...own.matchAll(/from "([^"]+)"/g)].map(match => match[1]!).sort();
  expect(imports).toEqual(["./current-context", "./current-context-callback", "./current-context-resolver", "./structured-instruction-mapper"]);
  for (const forbidden of ["guest-context-owner", "CoworkGuestContextOwner", "CoworkGuestOwnerCapture", "CoworkGuestOwnerEvidencePort", "captureCoworkGuestOwner", "@yanlinglabs", "homeIdentity"]) expect(own.includes(forbidden)).toBe(false);
});
