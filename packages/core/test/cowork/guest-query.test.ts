import { authorityFixtureSessions } from "./committed-sessions";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query, type ProtocolSdkMessage } from "@yanlinglabs/winter-agent-sdk";
import { ApprovalRequestedEvent, ApprovalResolvedEvent, type ApprovalPolicy, type SessionEvent } from "@yanlinglabs/winter-protocol";
import { ApprovalBroker } from "../../src/agent/approvals";
import { QuestionBroker } from "../../src/agent/questions";
import { PermissionGate } from "../../src/agent/gate";
import { canUseToolFor } from "../../src/runtime-sdk/approval-bridge";
import { REVIEWER_ESCALATION_REASON } from "../../src/runtime-sdk/bridge-common";
import { createProjector } from "../../src/projector";
import { ProjectionCheckpoints } from "../../src/runtime-state/checkpoints";
import { openRuntimeStateDb, type RuntimeStateDb } from "../../src/runtime-state/db";
import { CoworkRepository } from "../../src/cowork/repository";
import { CoworkAuthority } from "../../src/cowork/authority";
import { buildCoworkGuestQueryOptions, type CoworkGuestQueryCallbacks } from "../../src/cowork/guest-query";
import { CoworkGuestRuntimeSupervisor, GUEST_RUNTIME_TRANSPORT_LIMITS, type GuestRuntimeLaunch, type GuestRuntimeChannel, type GuestRuntimeTermination } from "../../src/cowork/guest-runtime";
import { assistantText, assistantToolUse, toolResult, result } from "../projector/harness";

// Scripted ports exercise HOST SDK parsing/approval/projection only. These flags
// describe the double; they are never native/Linux admission or activation proof.
const SCRIPTED_CHANNEL_CAPABILITY = { protocolVersion: 1, capabilities: ["confined-guest-posture-v1"], supportsConfinedGuestExecution: true };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
class Chunks implements AsyncIterable<string> {
  private queue: string[] = []; private closed = false; private wake?: () => void;
  write(value: string) { this.queue.push(value); this.wake?.(); }
  end() { this.closed = true; this.wake?.(); }
  async *[Symbol.asyncIterator]() { while (!this.closed || this.queue.length) { if (this.queue.length) yield this.queue.shift()!; else await new Promise<void>(r => { this.wake = r; }); } }
}
function scriptedChannel(launch: Readonly<GuestRuntimeLaunch>) {
  const stdout = new Chunks(), stderr = new Chunks(), exit = deferred<{ code: number | null; signal: string | null }>(), proof = deferred<GuestRuntimeTermination>();
  const inputs: string[] = [], stops: boolean[] = []; let ends = 0;
  const port: GuestRuntimeChannel = { protocolVersion: 1, scope: launch.scope, launchId: launch.launchId, stdout, stderr,
    async send(chunk) { inputs.push(chunk); }, async endInput() { ends++; }, stop(force) { stops.push(force); }, runtimeExited: exit.promise, termination: proof.promise };
  return { launch, port, stdout, stderr, exit, proof, inputs, stops, ends: () => ends,
    send(message: ProtocolSdkMessage) { stdout.write(JSON.stringify({ type: "data", message }) + "\n"); },
    init() { stdout.write(JSON.stringify({ type: "init", protocolVersion: "1.0", sessionId: launch.scope.backendSessionId, cwd: launch.runtime.cwd, model: launch.runtime.model, permissionMode: launch.runtime.permissionMode, tools: ["Read", "Write", "Edit", "Bash"] }) + "\n"); },
    permission(callId: string, requestId: string, extra: Record<string, unknown> = {}) { stdout.write(JSON.stringify({ type: "control_request", requestId, subtype: "permission", payload: { toolName: "Bash", input: { command: "printf fixture" }, toolUseID: callId, requestId, suggestions: [], ...extra } }) + "\n"); },
    finish() { stdout.end(); stderr.end(); exit.resolve({ code: 0, signal: null }); },
    release() { proof.resolve({ scope: launch.scope, launchId: launch.launchId, outcome: "confirmed-stopped", storeOwnerReleased: true }); },
  };
}
const roots: string[] = [], databases: RuntimeStateDb[] = [], cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); for (const db of databases.splice(0)) db.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(toolClasses = ["read", "write", "execute"], defaultPolicy: ApprovalPolicy = "ask") {
  const home = mkdtempSync(join(tmpdir(), "winter-guest-query-")); roots.push(home);
  const db = openRuntimeStateDb(home); databases.push(db); const records = new CoworkRepository(db);
  const created = records.create({ principalId: "fixture", requestId: "create" }, { ownership: "project", title: "fixture", defaultPolicy,
    ceiling: { toolClasses, hostServices: [], connectors: [], network: "none" },
    sources: [{ kind: "folder", access: "read-write", label: "fixture", detail: { grantRef: "grant", rootIdentity: "root" } }] });
  const source = records.sources(created.workspaceId)[0]!, epoch = records.beginIncarnation(created.workspaceId, "incarnation", 1);
  records.acknowledgeSource(epoch, source.sourceId, source.revision, "ready");
  records.bindConversation({ principalId: "fixture", requestId: "bind", expectedRevision: 1 }, created.workspaceId, { sessionId: "conversation", sourceId: source.sourceId, relativeCwd: "repo/subdir" }, authorityFixtureSessions("conversation"));
  let revoked = false, model = "winter-test/echo", resume = false;
  const authority = new CoworkAuthority(records, { folder: () => ({ rootIdentity: "root", writable: true, revoked }), repository: () => undefined });
  const deps = { records, authority, identity: () => ({ backendSessionId: "backend-stable", model, resume }), bootId: () => "12345678-1234-1234-1234-123456789abc" };
  const wires: ReturnType<typeof scriptedChannel>[] = [];
  const supervisor = new CoworkGuestRuntimeSupervisor({ ...deps, runtimeCapability: SCRIPTED_CHANNEL_CAPABILITY, port: { open(launch) { const wire = scriptedChannel(launch); wires.push(wire); return wire.port; } } });
  const controller = new AbortController();
  cleanup.push(() => { supervisor.stop(); controller.abort(); for (const wire of wires) { wire.finish(); wire.release(); } });
  const callbacks: CoworkGuestQueryCallbacks = { canUseTool: async () => ({ behavior: "deny", message: "fixture" }), abortController: controller };
  return { home, db, records, deps, supervisor, controller, callbacks, wires, workspaceId: created.workspaceId,
    revoke() { revoked = true; }, changeModel() { model = "winter-test/replaced"; }, resume() { resume = true; } };
}
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 1000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error("scripted host stream condition timed out"); await Bun.sleep(1); }
}
function compose(f: ReturnType<typeof fixture>) {
  const events: SessionEvent[] = [], transients: SessionEvent[] = [], approvals = new ApprovalBroker(), questions = new QuestionBroker();
  let seq = 0;
  // Existing host semantics remain Code for this harness; this is deliberately not
  // persisted/advertised as a supported Cowork mode in the product.
  const bridge = canUseToolFor({ sessionId: "conversation", mode: "code", policy: f.records.binding("conversation").policy, approvals, questions, gate: new PermissionGate(),
    emit: event => events.push({ ...event, seq: ++seq, ts: Date.parse("2026-10-12T00:00:00.000Z") } as SessionEvent), log: { info() {}, error() {} } });
  const projector = createProjector({ sessionId: "conversation", mode: "code", generation: 1, nextSeq: () => ++seq,
    checkpoint: new ProjectionCheckpoints(f.db), now: () => "2026-10-12T00:00:00.000Z", log: {},
    onToolResults: ids => { for (const id of ids) bridge.withdrawPending(id); } });
  events.push(...projector.beginTurn({ text: "fixture prompt" }).persist);
  const q = query({ prompt: "fixture prompt", options: buildCoworkGuestQueryOptions(f.supervisor, "conversation", { ...f.callbacks, canUseTool: bridge }) });
  const consume = (async () => { for await (const message of q) { const batch = projector.accept(message as ProtocolSdkMessage); events.push(...batch.persist); transients.push(...batch.broadcast); } })();
  void consume.catch(() => {});
  return { q, consume, events, transients, bridge, approvals, projector };
}

test("guest query options derive only from canonical launch; no host config or pre-approval bag is accepted", () => {
  const f = fixture(), options = buildCoworkGuestQueryOptions(f.supervisor, "conversation", f.callbacks);
  expect(f.wires).toHaveLength(0);
  expect(options).toMatchObject({ executionPosture: "confined-guest", sessionId: "backend-stable", model: "winter-test/echo", cwd: "/workspace/folders/grant/repo/subdir",
    persistSession: true, permissionMode: "default", env: {}, settingSources: [], tools: ["Read", "Edit", "Write", "Bash"], allowedTools: [], mcpServers: {}, strictMcpConfig: true });
  for (const key of ["hooks", "onCredentialResolve", "onMcpOAuthRefresh", "hostMessaging", "additionalDirectories", "managedSettings", "runtime", "hostCodeProcessBroker", "systemPrompt", "connection"]) expect(key in options).toBe(false);
  expect(Object.isFrozen(options)).toBe(true); expect(Object.isFrozen(options.tools)).toBe(true); expect(Object.isFrozen(options.env)).toBe(true);
  expect(() => (options.tools as string[]).push("Agent")).toThrow();
  expect(() => buildCoworkGuestQueryOptions(f.supervisor, "conversation", { ...f.callbacks, env: { HOME: f.home } } as CoworkGuestQueryCallbacks)).toThrow("invalid_request");
  expect(() => buildCoworkGuestQueryOptions(f.supervisor, "conversation", { ...f.callbacks, canUseTool: undefined } as unknown as CoworkGuestQueryCallbacks)).toThrow("invalid_request");
  expect(JSON.stringify(options)).not.toContain(f.home);
});

test("read-only ceiling reaches the canonical port descriptor and query as exact Read visibility with no pre-approval", () => {
  const f = fixture(["read"]), options = buildCoworkGuestQueryOptions(f.supervisor, "conversation", f.callbacks);
  expect(options.tools).toEqual(["Read"]); expect(options.allowedTools).toEqual([]);
  options.spawnClaudeCodeProcess!({ command: "ignored", args: [], cwd: f.home, env: {} });
  const runtime = f.wires[0]!.launch.runtime;
  expect(runtime.tools).toEqual(["Read"]); expect(runtime.allowedTools).toEqual([]);
  expect(Object.isFrozen(runtime.tools)).toBe(true); expect(Object.isFrozen(runtime.allowedTools)).toBe(true);
  expect(() => (runtime.tools as string[]).push("Bash")).toThrow();
  expect(() => Reflect.apply(Array.prototype.push, runtime.allowedTools, ["Read"])).toThrow();
});

test("canonical auto policy maps to SDK default and keeps unresolved reviewer decisions in the host approval bridge", async () => {
  const f = fixture(["read", "write", "execute"], "auto");
  const options = buildCoworkGuestQueryOptions(f.supervisor, "conversation", f.callbacks);
  expect(options.permissionMode).toBe("default"); expect(options.allowedTools).toEqual([]);
  const h = compose(f), wire = f.wires[0]!;
  expect(wire.launch.runtime).toMatchObject({ permissionMode: "default", tools: ["Read", "Edit", "Write", "Bash"], allowedTools: [] });
  wire.init(); wire.permission("auto-reviewer", "auto-permission", { decisionReason: REVIEWER_ESCALATION_REASON });
  await until(() => h.approvals.list("conversation").length === 1);
  h.approvals.resolve("conversation", "auto-reviewer", false, "fixture-user", "deny");
  await until(() => wire.inputs.some(chunk => chunk.includes("auto-permission")));
  const response = wire.inputs.map(chunk => JSON.parse(chunk)).find(frame => frame.requestId === "auto-permission");
  expect(response).toMatchObject({ ok: true, payload: { behavior: "deny" } });
  wire.send(result()); wire.finish(); wire.release(); await h.consume;
});

test("plan policy reaches the canonical descriptor and SDK query as plan without granting a requested Bash call", async () => {
  const f = fixture(["read", "write", "execute"], "plan"), options = buildCoworkGuestQueryOptions(f.supervisor, "conversation", f.callbacks);
  expect(options.permissionMode).toBe("plan"); expect(options.allowedTools).toEqual([]);
  const h = compose(f), wire = f.wires[0]!;
  expect(wire.launch.runtime).toMatchObject({ permissionMode: "plan", tools: ["Read", "Edit", "Write", "Bash"], allowedTools: [] });
  wire.init(); wire.permission("plan-bash", "plan-permission");
  await until(() => wire.inputs.some(chunk => chunk.includes("plan-permission")));
  const response = wire.inputs.map(chunk => JSON.parse(chunk)).find(frame => frame.requestId === "plan-permission");
  expect(response).toMatchObject({ ok: true, payload: { behavior: "deny" } });
  expect(h.approvals.list("conversation")).toEqual([]); expect(h.events.some(event => event.type === "approval_requested")).toBe(false);
  wire.send(result()); wire.finish(); wire.release(); await h.consume;
});

test("production-style absent/false supervisor capability still refuses query preparation", () => {
  const f = fixture(); let opened = false;
  const unadmitted = new CoworkGuestRuntimeSupervisor({ ...f.deps, runtimeCapability: { ...SCRIPTED_CHANNEL_CAPABILITY, supportsConfinedGuestExecution: false },
    port: { open() { opened = true; throw new Error("unreachable"); } } });
  expect(() => buildCoworkGuestQueryOptions(unadmitted, "conversation", f.callbacks)).toThrow("unsupported_topology"); expect(opened).toBe(false);
  expect(() => buildCoworkGuestQueryOptions(new CoworkGuestRuntimeSupervisor(f.deps), "conversation", f.callbacks)).toThrow("unsupported_topology");
});

test.each(["model", "resume", "revocation", "instructions", "policy"] as const)("a prepared query rejects changed %s before opening the channel", change => {
  const f = fixture(), options = buildCoworkGuestQueryOptions(f.supervisor, "conversation", f.callbacks);
  if (change === "model") f.changeModel();
  if (change === "resume") f.resume();
  if (change === "revocation") f.revoke();
  if (change === "instructions") f.records.rs.db.exec("UPDATE cowork_workspaces SET instruction_revision=instruction_revision+1");
  if (change === "policy") f.records.rs.db.exec("UPDATE cowork_policies SET revision=revision+1");
  expect(() => options.spawnClaudeCodeProcess!({ command: "ignored", args: [], cwd: f.home, env: { HOME: f.home } })).toThrow();
  expect(f.wires).toHaveLength(0);
});

test("an abort after preparation refuses channel startup", () => {
  const f = fixture(), options = buildCoworkGuestQueryOptions(f.supervisor, "conversation", f.callbacks);
  f.controller.abort();
  expect(() => options.spawnClaudeCodeProcess!({ command: "ignored", args: [], cwd: f.home, env: {} })).toThrow("authority_denied");
  expect(f.wires).toHaveLength(0);
});

test("one-use guest spawn ignores SDK argv/env and cannot replay its prepared launch", () => {
  const f = fixture(); f.resume(); const options = buildCoworkGuestQueryOptions(f.supervisor, "conversation", f.callbacks);
  expect(options.resume).toBe("backend-stable");
  options.spawnClaudeCodeProcess!({ command: "/arbitrary/host-command", args: ["--arbitrary"], cwd: f.home, env: { SYNTHETIC_SECRET: "must-not-travel" } });
  expect(f.wires[0]!.launch.runtime).toMatchObject({ sessionId: "backend-stable", resume: "backend-stable", winterHome: "/run/winter/conversations/conversation", storeHome: "/workspace/.winter/conversations/conversation" });
  expect(JSON.stringify(f.wires[0]!.launch)).not.toContain(f.home); expect(JSON.stringify(f.wires[0]!.launch)).not.toContain("must-not-travel");
  expect(() => options.spawnClaudeCodeProcess!({ command: "ignored", args: [], cwd: f.home, env: {} })).toThrow("recovery_required"); expect(f.wires).toHaveLength(1);
});

test("actual SDK stream composes approval denial and projector events without releasing store ownership at EOF", async () => {
  const f = fixture(), h = compose(f), wire = f.wires[0]!;
  wire.init(); await until(() => wire.inputs.some(chunk => chunk.includes("fixture prompt")));
  wire.send(assistantToolUse("call-denied", "Bash", { command: "printf fixture" })); wire.permission("call-denied", "permission-denied");
  await until(() => h.approvals.list("conversation").length === 1);
  const card = h.events.find(event => event.type === "approval_requested")!;
  expect(ApprovalRequestedEvent.parse(card)).toMatchObject({ sessionId: "conversation", callId: "call-denied", toolName: "bash" });
  h.approvals.resolve("conversation", "call-denied", false, "fixture-user", "deny");
  await until(() => wire.inputs.some(chunk => chunk.includes("permission-denied")));
  const response = wire.inputs.map(chunk => JSON.parse(chunk)).find(frame => frame.type === "control_response" && frame.requestId === "permission-denied");
  expect(response).toMatchObject({ ok: true, payload: { behavior: "deny" } });
  wire.send(toolResult("call-denied", "Denied by fixture user", { is_error: true })); wire.send(assistantText("guest reply after denial")); wire.send(result()); wire.finish();
  await h.consume;
  expect(h.events.map(event => event.type)).toEqual(["turn_started", "tool_call", "approval_requested", "approval_resolved", "tool_result", "assistant_message", "turn_completed"]);
  expect(ApprovalResolvedEvent.parse(h.events.find(event => event.type === "approval_resolved"))).toMatchObject({ callId: "call-denied", approved: false, by: "fixture-user" });
  expect(h.events.find(event => event.type === "assistant_message")).toMatchObject({ text: "guest reply after denial" });
  expect(h.events.find(event => event.type === "tool_result")).toMatchObject({ callId: "call-denied", isError: true });
  expect(h.approvals.list("conversation")).toEqual([]); expect(f.supervisor.retained()).toHaveLength(1);
  expect(() => buildCoworkGuestQueryOptions(f.supervisor, "conversation", f.callbacks).spawnClaudeCodeProcess!({ command: "ignored", args: [], cwd: f.home, env: {} })).toThrow("recovery_required");
  wire.release(); await until(() => f.supervisor.retained().length === 0);
});

test("projected interrupted tool result withdraws the pending real approval before its result event", async () => {
  const f = fixture(), h = compose(f), wire = f.wires[0]!;
  wire.init(); wire.send(assistantToolUse("call-abandoned", "Bash", { command: "printf fixture" })); wire.permission("call-abandoned", "permission-abandoned");
  await until(() => h.approvals.list("conversation").length === 1);
  wire.send(toolResult("call-abandoned", "[interrupted]", { is_error: true }));
  await until(() => wire.inputs.some(chunk => chunk.includes("permission-abandoned")));
  const resolutionIndex = h.events.findIndex(event => event.type === "approval_resolved"), resultIndex = h.events.findIndex(event => event.type === "tool_result");
  expect(resolutionIndex).toBeGreaterThan(0); expect(resultIndex).toBe(resolutionIndex + 1);
  expect(h.events[resolutionIndex]).toMatchObject({ approved: false, by: "aborted", callId: "call-abandoned" });
  expect(h.approvals.list("conversation")).toEqual([]); expect(h.bridge.withdrawPending("call-abandoned")).toBe(false);
  const response = wire.inputs.map(chunk => JSON.parse(chunk)).find(frame => frame.requestId === "permission-abandoned");
  expect(response.payload.behavior).toBe("deny"); expect(response.payload.message).toContain("the turn was aborted");
  wire.send(result()); wire.finish(); wire.release(); await h.consume;
  expect(h.events.filter(event => event.type === "approval_resolved")).toHaveLength(1);
});

test("revocation while a permission card is pending prevents its response reaching the guest", async () => {
  const f = fixture(), h = compose(f), wire = f.wires[0]!;
  wire.init(); wire.permission("call-revoked", "permission-revoked"); await until(() => h.approvals.list("conversation").length === 1);
  f.revoke(); h.approvals.resolve("conversation", "call-revoked", false, "fixture-user", "deny");
  await until(() => wire.stops.includes(true));
  expect(wire.inputs.some(chunk => chunk.includes("permission-revoked"))).toBe(false);
  wire.finish(); await expect(h.consume).rejects.toThrow(); expect(f.supervisor.retained()).toHaveLength(1);
  wire.release(); await until(() => f.supervisor.retained().length === 0);
});

test.each(["malformed-json", "missing-type", "oversized-chunk"] as const)("actual SDK composition fails closed on %s output", malformed => {
  return (async () => {
    const f = fixture(), h = compose(f), wire = f.wires[0]!; wire.init();
    wire.stdout.write(malformed === "malformed-json" ? "{bad-json}\n" : malformed === "missing-type" ? JSON.stringify({ message: "missing frame discriminator" }) + "\n" : "x".repeat(GUEST_RUNTIME_TRANSPORT_LIMITS.chunkBytes + 1));
    wire.finish(); await expect(h.consume).rejects.toThrow();
    expect(wire.stops.length).toBeGreaterThan(0); expect(f.supervisor.retained()).toHaveLength(1);
    wire.release(); await until(() => f.supervisor.retained().length === 0);
  })();
});
