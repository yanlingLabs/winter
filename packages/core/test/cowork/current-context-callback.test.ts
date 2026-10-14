import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCoworkRuntimeContextHandler, type CoworkRuntimeContextRequest } from "../../src/cowork/current-context-callback";
import { COWORK_CONTEXT_MAX_BYTES, type CoworkContextRegistration } from "../../src/cowork/current-context";
import { COWORK_SHARED_INSTRUCTION_VIEW, type CoworkInstructionReadRequest, type CoworkInstructionReadResult, type CoworkProtectedInstructionReader } from "../../src/cowork/current-context-resolver";
import { coworkGuestSourceRoot } from "../../src/cowork/guest-paths";
import { CoworkRepository } from "../../src/cowork/repository";
import type { CapabilityCeiling } from "../../src/cowork/types";
import { openRuntimeStateDb, type RuntimeStateDb } from "../../src/runtime-state/db";
import { RuntimeSessionRecords } from "../../src/runtime-state/records";

const roots: string[] = [], databases: RuntimeStateDb[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const boot = "12345678-1234-1234-1234-123456789abc";
const caps: CapabilityCeiling = { toolClasses: ["read", "write", "execute"], hostServices: ["git.publish"], connectors: [], network: "internet" };
const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
function reply(request: CoworkInstructionReadRequest, sharedText = "shared guidance"): CoworkInstructionReadResult {
  const blocks = [
    { requestedPath: request.scopes.shared.path, admittedPath: `${COWORK_SHARED_INSTRUCTION_VIEW}/WINTER.md`, text: sharedText, sha256: sha(sharedText), tier: "workspace" as const },
    { requestedPath: `${request.scopes.source.root}/WINTER.md`, admittedPath: `${request.scopes.source.root}/WINTER.md`, text: "source guidance", sha256: sha("source guidance"), tier: "project" as const },
  ];
  return { request: structuredClone(request), tiers: "admitted-only", blocks, files: blocks.map(block => ({ ...block, depth: 0 })) };
}
/** Real canonical DB/repository/runtime records; only the protected reader and
 * live owner/grant ports are doubles. No guest filesystem/native admission proof. */
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "winter-context-callback-")); roots.push(home);
  const db = openRuntimeStateDb(home); databases.push(db);
  let mint = 0;
  const records = new CoworkRepository(db, () => "2026-10-14T00:00:00.000Z", prefix => `${prefix}_${++mint}`);
  const workspaceId = records.create({ principalId: "fixture", requestId: "create" }, {
    ownership: "project", title: "fixture", ceiling: caps,
    sources: [{ kind: "githubRepository", label: "fixture", access: "read-write", detail: { repositoryId: "repo-one", authorityRef: "private-authority", initialRef: "main" } }],
  }).workspaceId;
  const source = records.sources(workspaceId)[0]!, root = coworkGuestSourceRoot(source);
  const epoch = records.beginIncarnation(workspaceId, "incarnation", 1);
  records.acknowledgeSource(epoch, source.sourceId, source.revision, "ready");
  records.bindConversation({ principalId: "fixture", requestId: "bind", expectedRevision: 1 }, workspaceId, { sessionId: "logical-parent", sourceId: source.sourceId, relativeCwd: "directory" });
  const sessions = new RuntimeSessionRecords(db, () => "2026-10-14T00:00:00.000Z");
  sessions.create({ winterSessionId: "logical-parent", runtimeKind: "winter-agent", backendSessionId: "backend-current", providerId: "fixture", modelRef: "fixture",
    backendRoot: "/private/protected/backend", transcriptProjectKey: "private-key", memoryProjectKey: "private-key", tempProjectKey: "private-key",
    transcriptHealth: "clean", compatibilityLevel: "full-filesystem", conformanceCorpusVersion: "fixture", versionProvenance: "legacy-unknown", capabilities: [],
    selection: { runtimeKind: "winter-agent", providerId: "fixture", modelRef: "fixture", family: "openai", authFamily: "api-key", sdkVersion: "fixture", reason: "test", decidedAt: "2026-10-14T00:00:00.000Z" } });
  sessions.transition("logical-parent", "ready"); sessions.bumpGeneration("logical-parent", { runtimeKind: "winter-agent", backendSessionId: "backend-current" }); sessions.transition("logical-parent", "running");
  const registration: CoworkContextRegistration = {
    trustedQuerySessionId: "trusted-owning-query", sessionId: "logical-parent", workspaceId, backendSessionId: "backend-current", backendGeneration: 1,
    bootId: boot, incarnationId: "incarnation", leaseEpoch: epoch.leaseEpoch, state: "active", platform: "linux", executionPosture: "confined-guest", capabilities: structuredClone(caps),
    admittedSources: [{ sourceId: source.sourceId, revision: source.revision, root, access: "read-write" }],
  };
  let currentBoot = boot, active = true, authorityReads = 0;
  const grant = { readable: true, writable: true, revoked: false };
  const deps = { records, trustedQuerySessionId: "trusted-owning-query",
    grants: { folder() { return undefined; }, repository() { return { ...grant }; } },
    currentRegistration(query: string) { authorityReads++; expect(query).toBe("trusted-owning-query"); return active ? registration : undefined; },
    currentBootId() { return currentBoot; },
  };
  const request: CoworkRuntimeContextRequest = { bindingId: "correlation-one", sessionId: "backend-current", cwd: `${root}/live`, purpose: "generation", attempt: 1 };
  const options = { signal: new AbortController().signal, trustedQuerySessionId: "trusted-owning-query" };
  const handler = (read: CoworkProtectedInstructionReader["read"]) => createCoworkRuntimeContextHandler({ ...deps, reader: { read } });
  const changePolicy = () => records.updatePolicy({ principalId: "fixture", requestId: "manual", expectedRevision: records.get(workspaceId).configRevision }, workspaceId, { publication: "manual" });
  return { home, db, records, sessions, workspaceId, source, root, registration, grant, deps, request, options, handler, changePolicy,
    authorityReads: () => authorityReads, unregister: () => { active = false; }, setBoot: (value: string) => { currentBoot = value; } };
}
async function refused(pending: Promise<unknown>) {
  await expect(pending).rejects.toThrow(/^required_context_unavailable$/);
}

test("SDK callback uses actual Core resolver and fresh shared bytes after atomic host edit", async () => {
  const f = fixture(), shared = join(f.home, "WINTER.md"), reads: CoworkInstructionReadRequest[] = [];
  writeFileSync(shared, "FIRST_SHARED");
  const handler = f.handler(async request => { reads.push(request); return reply(request, readFileSync(shared, "utf8")); });
  const before = await handler(f.request, f.options);
  writeFileSync(`${shared}.next`, "SECOND_SHARED"); renameSync(`${shared}.next`, shared);
  const after = await handler({ ...f.request, bindingId: "different-correlation", purpose: "compaction", attempt: 2, cwd: `${f.root}/different` }, f.options);
  expect(before.instructions).toContain("FIRST_SHARED"); expect(after.instructions).toContain("SECOND_SHARED"); expect(after.instructions).not.toContain("FIRST_SHARED");
  expect(after.facts).toContain("Completion default: commit and push"); expect(after.revision).not.toBe(before.revision);
  expect(reads).toHaveLength(2); expect(reads[0]!.readId).not.toBe(reads[1]!.readId);
  expect(reads[1]!.scopes.source.cwd).toBe(`${f.root}/different`);
  expect(reads[1]!.registration.trustedQuerySessionId).toBe(f.options.trustedQuerySessionId);
  expect(Object.keys(after).sort()).toEqual(["facts", "instructions", "revision"]); expect(Object.isFrozen(after)).toBe(true);
  expect(Object.values(after).every(value => typeof value === "string")).toBe(true);
  expect(Buffer.byteLength(after.facts) + Buffer.byteLength(after.instructions)).toBeLessThanOrEqual(COWORK_CONTEXT_MAX_BYTES);
});

test("canonical policy changes refresh facts even when editable shared guidance is empty", async () => {
  const f = fixture(), handler = f.handler(async request => reply(request, ""));
  const before = await handler(f.request, f.options); f.changePolicy();
  const after = await handler(f.request, f.options);
  expect(before.facts).toContain("Completion default: commit and push");
  expect(after.facts).toContain("Completion default: manual publication"); expect(after.facts).not.toBe(before.facts);
});

for (const drift of ["source", "policy", "boot", "grant", "registration", "backend"] as const) {
  test(`canonical ${drift} revocation/drift during reader await refuses with no cached fallback`, async () => {
    const f = fixture(); let revoke = false, calls = 0;
    const handler = f.handler(async request => {
      calls++; const value = reply(request); await Promise.resolve();
      if (revoke) {
        if (drift === "source") f.db.db.run("UPDATE cowork_sources SET trust='revoked' WHERE source_id=?", [f.source.sourceId]);
        if (drift === "policy") f.changePolicy();
        if (drift === "boot") f.setBoot("12345678-1234-1234-1234-123456789abd");
        if (drift === "grant") f.grant.revoked = true;
        if (drift === "registration") f.unregister();
        if (drift === "backend") f.sessions.bumpGeneration("logical-parent", { runtimeKind: "winter-agent", backendSessionId: "backend-new" });
      }
      return value;
    });
    expect((await handler(f.request, f.options)).instructions).toContain("shared guidance");
    revoke = true; await refused(handler(f.request, f.options)); expect(calls).toBe(2);
  });
}

test("canonical final guard includes reader cleanup callbacks before adapter returns", async () => {
  const f = fixture(); let cleanup = false;
  await refused(f.handler(async (request, options) => {
    options.signal.addEventListener("abort", () => { cleanup = true; f.changePolicy(); }, { once: true });
    return reply(request);
  })(f.request, f.options));
  expect(cleanup).toBe(true);
});

test("child, foreign query and malformed callback requests refuse before canonical ports/reader", async () => {
  const f = fixture(); let calls = 0, getters = 0;
  const handler = f.handler(async request => { calls++; return reply(request); });
  const getter = { ...f.request }; Object.defineProperty(getter, "cwd", { get() { getters++; return f.request.cwd; } });
  const extra = { ...f.request }; Object.defineProperty(extra, "authority", { value: true, enumerable: false });
  const bad: unknown[] = [null, [], { ...f.request, agentId: "child" }, { ...f.request, agentId: undefined },
    { ...f.request, attempt: 0 }, { ...f.request, attempt: 1_000_001 }, { ...f.request, attempt: 1.5 },
    { ...f.request, purpose: "other" }, { ...f.request, bindingId: "x".repeat(129) }, { ...f.request, sessionId: "foreign/value" },
    { ...f.request, cwd: "\0" }, { ...f.request, cwd: "é".repeat(2049) }, { ...f.request, [Symbol("extra")]: true }, getter, extra];
  for (const request of bad) await refused(handler(request as CoworkRuntimeContextRequest, f.options));
  await refused(handler(f.request, { ...f.options, trustedQuerySessionId: "foreign-query" }));
  const optionsGetter = { ...f.options }; Object.defineProperty(optionsGetter, "trustedQuerySessionId", { get() { getters++; return f.options.trustedQuerySessionId; } });
  await refused(handler(f.request, optionsGetter));
  await refused(handler(f.request, { ...f.options, signal: {} as AbortSignal }));
  expect(calls).toBe(0); expect(f.authorityReads()).toBe(0); expect(getters).toBe(0);
});

test("foreign backend, outside/noncanonical cwd and current revoked owner refuse before reader", async () => {
  const f = fixture(); let calls = 0;
  const handler = f.handler(async request => { calls++; return reply(request); });
  for (const request of [{ ...f.request, sessionId: "foreign-backend" }, { ...f.request, cwd: "/outside" }, { ...f.request, cwd: `${f.root}/../other` }]) await refused(handler(request, f.options));
  f.unregister(); await refused(handler(f.request, f.options));
  expect(calls).toBe(0); expect(f.authorityReads()).toBeGreaterThan(0);
});

test("fixed query identity cannot be retargeted by mutating construction deps", async () => {
  const f = fixture(); let calls = 0;
  const deps = { ...f.deps, reader: { read: async (request: CoworkInstructionReadRequest) => { calls++; return reply(request); } } };
  const handler = createCoworkRuntimeContextHandler(deps); deps.trustedQuerySessionId = "foreign-query";
  await refused(handler(f.request, { ...f.options, trustedQuerySessionId: "foreign-query" }));
  expect((await handler(f.request, f.options)).facts).toContain("Cowork current host context"); expect(calls).toBe(1);
});

test("abort is passed to actual resolver, cancels pending reader and never returns late snapshot", async () => {
  const f = fixture(), controller = new AbortController(); let calls = 0, signal!: AbortSignal;
  let started!: () => void, late!: (value: CoworkInstructionReadResult) => void, sent!: CoworkInstructionReadRequest;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const handler = f.handler((request, options) => {
    calls++; sent = request; signal = options.signal; started(); return new Promise(resolve => { late = resolve; });
  });
  const pending = handler(f.request, { ...f.options, signal: controller.signal }); await ready;
  controller.abort(); await refused(pending); expect(signal.aborted).toBe(true);
  late(reply(sent)); await Promise.resolve();
  await refused(handler(f.request, { ...f.options, signal: controller.signal })); expect(calls).toBe(1);
});

test("reader rejection and oversized result refuse after a prior valid callback", async () => {
  const f = fixture(); let mode = "ok";
  const handler = f.handler(async request => {
    if (mode === "throw") throw new Error("private /credential/reader failure");
    return reply(request, mode === "large" ? "x".repeat(COWORK_CONTEXT_MAX_BYTES) : "valid");
  });
  expect((await handler(f.request, f.options)).instructions).toContain("valid");
  mode = "throw"; await refused(handler(f.request, f.options));
  mode = "large"; await refused(handler(f.request, f.options));
});
