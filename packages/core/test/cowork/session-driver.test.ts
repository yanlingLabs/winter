// Session door D3: the Cowork driver table end to end against a SCRIPTED guest: the real host agent SDK `query()`, the
// real WinterSession, projector and approval bridge, the real supervisor and runtime channel, and a scripted native start
// that validates the conversation set on the native wire. The scripted guest checks every inbound frame with a copy of
// the host-query profile's own check, so a frame the real guest would refuse fails the test.
//
// These doubles prove host composition only. They are never native, Linux or image admission evidence (that is D5's
// real-host run after S7B lands).
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query as agentQuery, type Options, type ProtocolSdkMessage } from "@yanlinglabs/winter-agent-sdk";
import type { ApprovalPolicy, SessionEvent } from "@yanlinglabs/winter-protocol";
import { ApprovalBroker } from "../../src/agent/approvals";
import { PermissionGate } from "../../src/agent/gate";
import { QuestionBroker } from "../../src/agent/questions";
import { COWORK_GUEST_RUNTIME_MODES } from "../../src/cowork/conversation-set";
import { parseCoworkNativeMuxFrame, serializeCoworkNativeMuxFrame } from "../../src/cowork/native/protocol";
import { coworkApprovalPort } from "../../src/cowork/session-door";
import { coworkGuestPermissionAnswer, createCoworkSessionDrivers, type CoworkSessionDriverDeps } from "../../src/cowork/session-driver";
import type { CoworkApprovalPort, CoworkGuestConversationContext, CoworkGuestConversationSet, CoworkGuestRun, CoworkGuestRuntimeLink, CoworkGuestRuntimeOffer, CoworkGuestStarter, CoworkGuestStopOutcome } from "../../src/cowork/session-ports";
import { startWinterSession } from "../../src/runtime-sdk/winter-session";
import { ProjectionCheckpoints } from "../../src/runtime-state/checkpoints";
import { SessionHub } from "../../src/sessions/hub";
import { SessionStore } from "../../src/sessions/store";
import { assistantText, assistantToolUse, init as systemInit, result, toolResult } from "../projector/harness";
import { doorFixture, FIXTURE_MODEL, standinRoute, type DoorFixture } from "./session-door-fixture";

/** The guest supervisor's map, verbatim (agent SDK linux-supervisor.py `host_query_config`, main 80bca246fdaf). */
const SDK_HOST_QUERY_MODES: Readonly<Record<string, string>> = { auto: "default", ask: "default", plan: "plan", "accept-edits": "acceptEdits", "dont-ask": "dontAsk", bypass: "bypassPermissions" };

// ------------------------------------------------------------------------------------------------ the host-query profile's inbound check
// A COPY of agent SDK packages/runtime/src/guest/linux-host-query-profile.ts `checkLinuxHostQueryFrame` (main 80bca246fdaf).
// It returns the reason instead of throwing, so a test names what the real guest would have refused.
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const closed = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).every(key => keys.includes(key));
const requestId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
function hostQueryFrameRefusal(frame: unknown, ownsPermission: (id: string) => boolean): string | undefined {
  if (!object(frame) || Buffer.byteLength(JSON.stringify(frame)) > 1024 * 1024) return "not an object";
  if (frame.type === "user") return !closed(frame, ["type", "text"]) || typeof frame.text !== "string" || frame.text.trimStart().startsWith("/") ? "user frame" : undefined;
  if (!requestId(frame.requestId)) return "request id";
  if (frame.type === "control_request") {
    return !closed(frame, ["type", "requestId", "subtype", "payload"]) || !["end_input", "interrupt"].includes(String(frame.subtype)) || (frame.payload !== undefined && (!object(frame.payload) || Object.keys(frame.payload).length !== 0)) ? `control_request ${String(frame.subtype)}` : undefined;
  }
  if (frame.type !== "control_response" || !closed(frame, ["type", "requestId", "ok", "payload", "error"]) || typeof frame.ok !== "boolean") return "frame type";
  if (!ownsPermission(frame.requestId)) return undefined;
  if (!frame.ok) return frame.payload !== undefined || !object(frame.error) || !closed(frame.error, ["code", "message"]) || typeof frame.error.code !== "string" || frame.error.code.length > 128 || typeof frame.error.message !== "string" ? "error answer" : undefined;
  const answer = frame.payload;
  if (frame.error !== undefined || !object(answer)) return "answer";
  if (answer.behavior === "allow") return !closed(answer, ["behavior", "updatedInput"]) || (answer.updatedInput !== undefined && !object(answer.updatedInput)) ? `allow answer keys ${Object.keys(answer).join()}` : undefined;
  if (answer.behavior === "deny") return !closed(answer, ["behavior", "message", "interrupt"]) || typeof answer.message !== "string" || (answer.interrupt !== undefined && typeof answer.interrupt !== "boolean") ? `deny answer keys ${Object.keys(answer).join()}` : undefined;
  return "answer behavior";
}

// ------------------------------------------------------------------------------------------------ the scripted guest
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }

class ScriptedGuest {
  readonly frames: Record<string, unknown>[] = [];
  readonly refusals: string[] = [];
  readonly users: string[] = [];
  readonly stops: string[] = [];
  readonly answers = new Map<string, { resolve: (frame: Record<string, unknown>) => void }>();
  private handler: ((stream: "out" | "err", bytes: Uint8Array, end: boolean) => void) | undefined;
  private readonly decoder = new TextDecoder();
  private carry = "";
  private readonly endedOutcome = deferred<CoworkGuestStopOutcome>();
  private outEnded = false;
  onUser: (text: string, guest: ScriptedGuest) => void = () => {};
  readonly link: CoworkGuestRuntimeLink;
  readonly run: CoworkGuestRun;
  constructor(readonly context: CoworkGuestConversationContext, readonly set: CoworkGuestConversationSet, private readonly onStopped: () => void) {
    this.link = this.makeLink();
    this.run = {
      workspaceId: context.workspaceId, incarnationId: context.incarnationId, leaseEpoch: context.leaseEpoch, guestBootId: context.guestBootId,
      runtime: () => this.link,
      // A slow drain holds the outcome until the test settles it; otherwise the stop is orderly at once.
      stop: async reason => { this.stops.push(reason); return this.slowStop ? this.endedOutcome.promise : this.terminate({ released: true, evidence: "orderly-receipt" }); },
      ended: this.endedOutcome.promise,
    };
  }
  private makeLink(): CoworkGuestRuntimeLink { return {
    send: async (bytes, end = false) => { if (bytes.length > 0) this.feed(this.decoder.decode(bytes, { stream: !end })); },
    onData: handler => {
      this.handler = handler;
      // The runtime's first frame (the host SDK refuses anything else first).
      this.write({ type: "init", protocolVersion: "1.0", sessionId: this.set.conversations[0]!.authority.sessionId, cwd: this.set.conversations[0]!.roots[0]!.guestPath, model: FIXTURE_MODEL, permissionMode: SDK_HOST_QUERY_MODES[this.set.conversations[0]!.policy], tools: [] });
      return () => { this.handler = undefined; };
    },
    ended: this.endedOutcome.promise,
  }; }
  private feed(text: string): void {
    this.carry += text;
    let at: number;
    while ((at = this.carry.indexOf("\n")) >= 0) {
      const line = this.carry.slice(0, at); this.carry = this.carry.slice(at + 1);
      if (line.trim() === "") continue;
      const frame = JSON.parse(line) as Record<string, unknown>;
      this.frames.push(frame);
      const refusal = hostQueryFrameRefusal(frame, id => this.answers.has(id));
      // The real guest's check throws: its runtime dies, and with it the incarnation's runtime streams.
      if (refusal !== undefined) { this.refusals.push(refusal); this.endRuntime(); continue; }
      if (frame.type === "user") { this.users.push(String(frame.text)); this.onUser(String(frame.text), this); }
      else if (frame.type === "control_request") this.write({ type: "control_response", requestId: frame.requestId, ok: true });
      else if (frame.type === "control_response") { const pending = this.answers.get(String(frame.requestId)); this.answers.delete(String(frame.requestId)); pending?.resolve(frame); }
    }
  }
  write(frame: unknown): void { if (!this.outEnded) this.handler?.("out", new TextEncoder().encode(`${JSON.stringify(frame)}\n`), false); }
  data(message: ProtocolSdkMessage): void { this.write({ type: "data", message }); }
  permission(callId: string, toolName: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = `perm-${callId}`, answered = deferred<Record<string, unknown>>();
    this.answers.set(id, answered);
    this.write({ type: "control_request", requestId: id, subtype: "permission", payload: { toolName, input, toolUseID: callId, requestId: id, suggestions: [] } });
    return answered.promise;
  }
  /** The incarnation ends (the guest's side, or the host's stop). */
  slowStop = false;
  /** The runtime process exits: OUT and ERR end; the incarnation's stop outcome is not known yet. */
  endRuntime(): void { if (!this.outEnded) { this.outEnded = true; this.handler?.("out", new Uint8Array(0), true); this.handler?.("err", new Uint8Array(0), true); } }
  terminate(outcome: CoworkGuestStopOutcome): CoworkGuestStopOutcome {
    this.endRuntime();
    this.endedOutcome.resolve(outcome);
    this.onStopped();
    return outcome;
  }
}

/** The conversation set as the guest receives it: through the native wire's own validator. */
function onTheWire(set: CoworkGuestConversationSet, incarnationId: string): CoworkGuestConversationSet {
  const message = { t: "conversations", operationId: "operation", nonce: "cd".repeat(16), incarnationId, profile: set.profile, conversations: set.conversations } as const;
  const frame = parseCoworkNativeMuxFrame(serializeCoworkNativeMuxFrame({ class: "bootstrap", seq: 1, message }, "down"), "down");
  if (frame.class !== "bootstrap" || frame.message.t !== "conversations") throw new Error("shape");
  return { profile: frame.message.profile, conversations: frame.message.conversations };
}

// ------------------------------------------------------------------------------------------------ the harness
const OFFER: CoworkGuestRuntimeOffer = { profile: "host-query-v1", readiness: ["guest-compartment"], runtimeCapability: { protocolVersion: 1, capabilities: ["confined-guest-posture-v1"], supportsConfinedGuestExecution: true } };
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function harness(opts: { policy?: ApprovalPolicy; conversations?: number; production?: boolean; route?: ReturnType<typeof standinRoute>; script?: (text: string, guest: ScriptedGuest) => void; afterSet?: () => void; toolClasses?: string[]; location?: "source" | "outputs" } = {}) {
  const offer: CoworkGuestRuntimeOffer = { ...OFFER, readiness: [...OFFER.readiness] };
  const storeHome = mkdtempSync(join(tmpdir(), "winter-door-d3-store-")), store = new SessionStore(storeHome), hub = new SessionHub(store);
  const sessions = Array.from({ length: opts.conversations ?? 1 }, () => store.createSession("t", { mode: "code" }));
  const f: DoorFixture = doorFixture({ policy: opts.policy ?? "ask", sessions, ...(opts.toolClasses ? { toolClasses: opts.toolClasses } : {}), ...(opts.location ? { location: opts.location } : {}) });
  const guests: ScriptedGuest[] = [], launched: Options[] = [], approvals = new ApprovalBroker(), questions = new QuestionBroker();
  const native: CoworkGuestStarter = {
    async start(workspaceId, request) {
      expect(workspaceId).toBe(f.workspaceId);
      const context = f.begin(`incarnation-${guests.length + 1}`);
      let set: CoworkGuestConversationSet | null;
      // The host fails the start on a refused set (a bootstrap fault); the driver must still surface ITS typed refusal.
      try { set = request!.conversations(context); } catch { f.power("stopped"); throw new Error("bootstrap fault: bad_conversations"); }
      if (set === null) throw new Error("no set");
      opts.afterSet?.();
      f.power("running");
      const guest = new ScriptedGuest(context, onTheWire(set, context.incarnationId), () => f.power("stopped"));
      guest.onUser = opts.script ?? (() => {});
      guests.push(guest);
      return guest.run;
    },
  };
  // The APPROVALS lane's real bridge through the door's own adapter (`mode: "cowork"`, D4b).
  const port: CoworkApprovalPort = coworkApprovalPort({ approvals, questions, gate: new PermissionGate(), log: { info() {}, error() {} } });
  const deps: CoworkSessionDriverDeps = {
    records: f.records, authority: f.authority, store, hub, checkpoints: new ProjectionCheckpoints(f.db),
    ...(opts.production ? {} : { route: opts.route ?? standinRoute(), native, offer, approvals: port }),
    query: input => { launched.push(input.options as Options); return agentQuery(input); },
    endGraceMs: 200,
  };
  const drivers = createCoworkSessionDrivers(deps);
  cleanups.push(async () => { await drivers.beginShutdown(); store.close(); f.close(); rmSync(storeHome, { recursive: true, force: true }); });
  return { f, store, hub, sessions, sid: sessions[0]!, drivers, guests, launched, approvals, deps, offer };
}
async function until(predicate: () => boolean, what = "condition") {
  const deadline = Date.now() + 3000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`); await Bun.sleep(2); }
}
const types = (events: readonly SessionEvent[]): string[] => events.map(event => event.type);
/** A guest turn: system/init with the offered tools, one reply, a result. */
const reply = (text: string, tools = ["Read", "Edit", "Write", "Bash"]) => (_: string, guest: ScriptedGuest) => {
  guest.data(systemInit({ session_id: guest.set.conversations[0]!.authority.sessionId, model: FIXTURE_MODEL, tools, permissionMode: SDK_HOST_QUERY_MODES[guest.set.conversations[0]!.policy] }));
  guest.data(assistantText(text)); guest.data(result());
};

// ------------------------------------------------------------------------------------------------ tests
test("production shape: no route, starter, offer or approval port, so every verb refuses provider_unavailable and nothing is created", async () => {
  const h = harness({ production: true });
  await expect(h.drivers.ensure(h.sid)).rejects.toThrow("provider_unavailable");
  await expect(h.drivers.runTurn(h.sid, "hello", "cli")).rejects.toThrow("provider_unavailable");
  expect(h.drivers.get(h.sid)).toBeUndefined(); expect(h.drivers.list()).toEqual([]);
  expect(h.f.records.conversationBackend(h.sid)).toBeNull();
  expect(h.f.records.get(h.f.workspaceId).power).toBe("stopped");
  expect(types(h.store.read(h.sid))).toEqual(["session_created"]);
  // Any one of the four missing is enough.
  for (const missing of ["route", "native", "offer", "approvals"] as const) {
    const drivers = createCoworkSessionDrivers({ ...harness().deps, [missing]: undefined });
    await expect(drivers.ensure(h.sid)).rejects.toThrow("provider_unavailable");
  }
});

test("a full turn: the guest runs default for ask, its Bash call cards on the conversation's log, and the answer reaches the guest in the closed shape", async () => {
  const h = harness({ policy: "ask", script: (_, guest) => {
    guest.data(systemInit({ session_id: guest.set.conversations[0]!.authority.sessionId, model: FIXTURE_MODEL, tools: ["Read", "Edit", "Write", "Bash"], permissionMode: "default" }));
    guest.data(assistantToolUse("tu1", "Bash", { command: "ls" }));
    void guest.permission("tu1", "Bash", { command: "ls" }).then(answer => {
      expect(answer).toMatchObject({ ok: true, payload: { behavior: "allow", updatedInput: { command: "ls" } } });
      guest.data(toolResult("tu1", "a.txt")); guest.data(assistantText("done")); guest.data(result());
    });
  } });
  const session = await h.drivers.ensure(h.sid);
  expect(session.mode).toBe("cowork"); expect(session.coworkEpoch).toBeUndefined();
  await session.open();
  const guest = h.guests[0]!;
  expect(session.coworkEpoch).toEqual({ incarnationId: "incarnation-1", leaseEpoch: guest.context.leaseEpoch });
  // The backend identity was recorded when the guest received its set, and it is the launch's.
  expect(h.f.records.conversationBackend(h.sid)).toBe(session.backendSessionId);
  expect(guest.set.conversations[0]!.authority.sessionId).toBe(session.backendSessionId);
  // The host launch states the mode the guest runs, and never a self-resolving one.
  const launch = h.launched[0]!;
  expect(launch.permissionMode).toBe("default");
  expect(SDK_HOST_QUERY_MODES[guest.set.conversations[0]!.policy]).toBe("default");
  expect([launch.allowDangerouslySkipPermissions, launch.permissions?.disableBypassPermissionsMode]).toEqual([false, true]);
  expect(launch.cwd).toBe(guest.set.conversations[0]!.roots[0]!.guestPath);
  const sent = session.send("list the files", "cli");
  await until(() => h.approvals.list(h.sid).length === 1, "the card");
  h.approvals.resolve(h.sid, "tu1", true, "fixture-user", "allow");
  await sent; await until(() => !session.turnRunning && types(h.store.read(h.sid)).includes("turn_completed"), "the turn");
  const log = types(h.store.read(h.sid));
  for (const type of ["user_message", "approval_requested", "approval_resolved", "tool_call", "assistant_message", "turn_completed"]) expect([type, log.includes(type)]).toEqual([type, true]);
  expect(guest.users).toEqual(["list the files"]);
  expect(guest.refusals).toEqual([]);
  expect(guest.frames.filter(frame => frame.type === "control_request").map(frame => frame.subtype)).toEqual([]);
});

test("D3b: an outputs-located conversation (O1) runs a full turn with its source never acknowledged; its one root is its own outputs folder", async () => {
  let answers: Record<string, unknown>[] = [];
  const h = harness({ policy: "ask", location: "outputs", script: (_, guest) => {
    guest.data(systemInit({ session_id: guest.set.conversations[0]!.authority.sessionId, model: FIXTURE_MODEL, tools: ["Read", "Edit", "Write", "Bash"], permissionMode: "default" }));
    guest.data(assistantToolUse("tu1", "Write", { file_path: "report.md", content: "x" }));
    void (async () => {
      answers.push(await guest.permission("tu1", "Write", { file_path: "report.md", content: "x" }));
      // Another conversation's outputs folder is outside: denied without a card.
      answers.push(await guest.permission("tu2", "Write", { file_path: "/workspace/outputs/s_other/x", content: "x" }));
      guest.data(toolResult("tu1", "written")); guest.data(assistantText("done")); guest.data(result());
    })();
  } });
  expect(h.f.records.source(h.f.workspaceId, h.f.sourceId).state).toBe("preparing");
  expect(() => h.f.records.binding(h.sid)).toThrow("unsupported_topology"); // every other lane's reader still refuses it
  const session = await h.drivers.ensure(h.sid);
  await session.open();
  const guest = h.guests[0]!, root = `/workspace/outputs/${h.sid}`;
  expect(guest.set.conversations[0]!.roots).toEqual([{ id: "outputs", guestPath: root, source: root, readOnly: false }]);
  expect(h.launched[0]!.cwd).toBe(root);
  const sent = session.send("write the report", "cli");
  await until(() => h.approvals.list(h.sid).length === 1, "the card");
  h.approvals.resolve(h.sid, "tu1", true, "fixture-user", "allow");
  await sent; await until(() => types(h.store.read(h.sid)).includes("turn_completed"), "the turn");
  expect(answers[0]).toMatchObject({ ok: true, payload: { behavior: "allow" } });
  expect(answers[1]).toMatchObject({ ok: true, payload: { behavior: "deny" } });
  expect(h.store.read(h.sid).filter(event => event.type === "approval_requested")).toHaveLength(1);
  expect(guest.refusals).toEqual([]);
  // Still never acknowledged: the outputs conversation needed no source.
  expect(h.f.records.source(h.f.workspaceId, h.f.sourceId).state).toBe("preparing");
});

test("D3b: a conversation whose location changed between ensure and the set is refused stale, and nothing runs", async () => {
  const h = harness({ script: reply("never") });
  const session = await h.drivers.ensure(h.sid);
  h.f.db.db.run("UPDATE cowork_conversations SET location_kind='outputs', source_id=NULL, relative_cwd='.' WHERE session_id=?", [h.sid]);
  await expect(session.open()).rejects.toThrow("stale_acknowledgment");
  expect(h.launched).toEqual([]);
});

test("D3b: under plan the outputs root is read-only and the runtime runs plan", async () => {
  const h = harness({ policy: "plan", location: "outputs", script: reply("ok") });
  const session = await h.drivers.ensure(h.sid);
  await session.open();
  expect(h.guests[0]!.set.conversations[0]!.roots[0]).toMatchObject({ id: "outputs", readOnly: true });
  expect(h.launched[0]!.permissionMode).toBe("plan");
});

test("plan view: not expressible in host-query-v1 yet. The real validator refuses any .winter root, so planViewMounted is false by construction", async () => {
  const h = harness({ policy: "plan", script: reply("ok") });
  const session = await h.drivers.ensure(h.sid);
  await session.open();
  const item = h.guests[0]!.set.conversations[0]!, sid = h.sid;
  for (const guestPath of [`/workspace/.winter/scratch/${sid}`, "/workspace/.winter/memory"]) {
    // Read-only, so the refusal is the .winter rule itself, not plan's read-only rule.
    const extra = { ...item, roots: [...item.roots, { id: "plan-view", guestPath, source: guestPath, readOnly: true }] };
    expect(() => onTheWire({ profile: "host-query-v1", conversations: [extra] }, "incarnation-1")).toThrow();
  }
  // The control: the same set with a non-.winter extra root passes, so the throw above is the .winter rule.
  const control = { ...item, roots: [...item.roots, { id: "other", guestPath: "/workspace/folders/other", source: "/workspace/folders/other", readOnly: true }] };
  expect(() => onTheWire({ profile: "host-query-v1", conversations: [control] }, "incarnation-1")).not.toThrow();
  // The driver never asks for the view: the approvals bridge sees planViewInstalled false (a plan scratch write is refused).
  const text = readFileSync(join(import.meta.dir, "..", "..", "src", "cowork", "session-driver.ts"), "utf8");
  expect(text).not.toMatch(/planViewMounted/);
});

test("for every policy the host launch's mode equals the mode the guest's own map gives the set's policy: default or plan only", async () => {
  for (const policy of ["plan", "dont-ask", "ask", "accept-edits", "auto", "bypass"] as const) {
    const h = harness({ policy, script: reply("ok") });
    const session = await h.drivers.ensure(h.sid);
    await session.open();
    const sentPolicy = h.guests[0]!.set.conversations[0]!.policy, launch = h.launched[0]!;
    expect([policy, sentPolicy]).toEqual([policy, policy === "plan" ? "plan" : "ask"]);
    expect([policy, launch.permissionMode as string]).toEqual([policy, SDK_HOST_QUERY_MODES[sentPolicy]!]);
    expect([policy, launch.permissionMode as string]).toEqual([policy, COWORK_GUEST_RUNTIME_MODES[sentPolicy as "ask" | "plan"]]);
    await session.send("hi", "cli"); await session.idle();
    expect(h.guests[0]!.refusals).toEqual([]);
  }
});

test("verbs the host-query guest cannot carry refuse typed on the host, and nothing of them reaches the guest", async () => {
  const h = harness({ script: reply("ok") });
  const session = await h.drivers.ensure(h.sid);
  await session.open();
  const before = h.store.read(h.sid).length;
  await expect(session.interrupt()).rejects.toThrow("unsupported_topology");
  await expect(session.interrupt({ discardQueued: true })).rejects.toThrow("unsupported_topology");
  await expect(session.setModel("other/model")).rejects.toThrow("unsupported_topology");
  await expect(session.setPolicy("bypass")).rejects.toThrow("unsupported_topology");
  await expect(session.compact()).rejects.toThrow("unsupported_topology");
  await expect(session.send("/help", "cli")).rejects.toThrow("invalid_request");
  await expect(session.send("  /compact", "cli")).rejects.toThrow("invalid_request");
  await expect(session.steer("/x", "cli")).rejects.toThrow("invalid_request");
  await expect(session.send("see this", "cli", [{ path: "/tmp/a.png", mediaType: "image/png" } as never])).rejects.toThrow("invalid_request");
  expect(() => session.deliver("/x")).toThrow("invalid_request");
  expect(h.store.read(h.sid).length).toBe(before);
  expect(h.guests[0]!.frames).toEqual([]);
  // A plain message still runs.
  await session.send("fine", "cli"); await session.idle();
  expect(h.guests[0]!.users).toEqual(["fine"]);
  expect(h.guests[0]!.refusals).toEqual([]);
});

test("a permission answer is cut to the guest's closed shape: no saved rule, no classification", () => {
  const input = { command: "ls" };
  expect(coworkGuestPermissionAnswer({ behavior: "allow", updatedInput: input, updatedPermissions: [{ type: "addRules" }], decisionClassification: "user_permanent" } as never, input)).toEqual({ behavior: "allow", updatedInput: input });
  expect(coworkGuestPermissionAnswer({ behavior: "deny", message: "no", interrupt: true, decisionClassification: "user_reject" } as never, input)).toEqual({ behavior: "deny", message: "no", interrupt: true });
  expect(coworkGuestPermissionAnswer(null, input)).toEqual({ behavior: "deny", message: "This action was not approved." });
  expect(coworkGuestPermissionAnswer({ behavior: "ask" } as never, input)).toEqual({ behavior: "deny", message: "This action was not approved." });
  expect(coworkGuestPermissionAnswer({ behavior: "allow", updatedInput: [1] } as never, input)).toEqual({ behavior: "allow", updatedInput: input });
});

test("a human DENY of a card reaches the guest in the closed shape too", async () => {
  const answers: Record<string, unknown>[] = [];
  const h = harness({ policy: "ask", script: (_, guest) => {
    guest.data(systemInit({ session_id: guest.set.conversations[0]!.authority.sessionId, model: FIXTURE_MODEL, tools: ["Read", "Edit", "Write", "Bash"] }));
    guest.data(assistantToolUse("tu9", "Bash", { command: "rm -rf x" }));
    void guest.permission("tu9", "Bash", { command: "rm -rf x" }).then(answer => { answers.push(answer); guest.data(toolResult("tu9", "denied", { is_error: true })); guest.data(result()); });
  } });
  const session = await h.drivers.ensure(h.sid); await session.open();
  void session.send("clean up", "cli");
  await until(() => h.approvals.list(h.sid).length === 1, "the card");
  h.approvals.resolve(h.sid, "tu9", false, "fixture-user", "deny");
  await until(() => answers.length === 1, "the answer");
  expect(answers[0]).toMatchObject({ ok: true, payload: { behavior: "deny" } });
  expect(Object.keys(answers[0]!.payload as object).every(key => ["behavior", "message", "interrupt"].includes(key))).toBe(true);
  expect(h.guests[0]!.refusals).toEqual([]);
});

test("refusals before anything starts: recorded backend, uncertain workspace, a running guest, a second live conversation", async () => {
  // (D3 also refused an outputs row here; D3b runs it, see "an outputs-located conversation" below.)
  const h = harness({ conversations: 2, script: reply("ok") });
  const [first, second] = h.sessions as [string, string];
  h.f.power("uncertain");
  await expect(h.drivers.ensure(first)).rejects.toThrow("recovery_required");
  h.f.power("running");
  await expect(h.drivers.ensure(first)).rejects.toThrow("conversation_limit");
  h.f.power("stopped");
  const live = await h.drivers.ensure(first);
  expect(await h.drivers.ensure(first)).toBe(live);
  await expect(h.drivers.ensure(second)).rejects.toThrow("conversation_limit");
  // A recorded backend with no live driver: the guest store exists, cold resume is not built.
  h.f.db.db.run("UPDATE cowork_conversations SET backend_session_id=? WHERE session_id=?", ["0b6d7c4e-5a1f-4c2e-9d3b-7e8f9a0b1c2d", second]);
  await h.drivers.evict(first);
  await expect(h.drivers.ensure(second)).rejects.toThrow("cold_resume_unavailable");
  expect(h.guests).toEqual([]);
});

test("one incarnation per driver: when it ends the conversation closes, a send refuses before the log, and it never starts fresh", async () => {
  const h = harness({ script: reply("ok") });
  const session = await h.drivers.ensure(h.sid);
  await session.send("first", "cli"); await session.idle();
  const guest = h.guests[0]!, length = h.store.read(h.sid).length;
  guest.terminate({ released: true, evidence: "new-boot" });
  await until(() => h.drivers.get(h.sid) === undefined, "the close");
  expect(session.state).toBe("ended"); expect(session.coworkEpoch).toBeUndefined();
  await expect(session.send("again", "cli")).rejects.toThrow("cold_resume_unavailable");
  expect(() => session.deliver("again")).toThrow("cold_resume_unavailable");
  await expect(session.open()).rejects.toThrow("cold_resume_unavailable");
  expect(h.store.read(h.sid).length).toBe(length);
  await expect(h.drivers.ensure(h.sid)).rejects.toThrow("cold_resume_unavailable");
  await expect(h.drivers.runTurn(h.sid, "again", "cli")).rejects.toThrow("cold_resume_unavailable");
  expect(h.guests).toHaveLength(1);
});

test("a refused set surfaces its own typed refusal, records nothing, and leaves the conversation startable", async () => {
  const selection = { providerId: "standin", modelKey: "other/model", providerModelId: "x", family: "standin", protocol: "scripted", capabilities: [] };
  let wrong = true;
  const route = standinRoute({ plan: ({ scope }) => ({ model: FIXTURE_MODEL, provider: { scope, selection: wrong ? selection : { ...selection, modelKey: FIXTURE_MODEL } } }) });
  const h = harness({ route, script: reply("ok") });
  const session = await h.drivers.ensure(h.sid);
  await expect(session.open()).rejects.toThrow("invalid_request");
  expect(h.f.records.conversationBackend(h.sid)).toBeNull();
  expect(h.guests).toEqual([]);
  expect(h.drivers.get(h.sid)).toBeUndefined();
  wrong = false;
  const retry = await h.drivers.ensure(h.sid);
  expect(retry).not.toBe(session);
  await retry.open();
  expect(h.f.records.conversationBackend(h.sid)).toBe(retry.backendSessionId);
});

test("a guest whose init offers a tool the launch withheld is refused tool_surface_unenforced, and its incarnation is stopped", async () => {
  const h = harness({ script: reply("never", ["Read", "Edit", "Write", "Bash", "WebFetch"]) });
  const session = await h.drivers.ensure(h.sid);
  await session.send("hi", "cli");
  await until(() => h.store.read(h.sid).some(event => event.type === "agent_error"), "the refusal");
  expect(h.store.read(h.sid).find(event => event.type === "agent_error")).toMatchObject({ code: "tool_surface_unenforced" });
  await until(() => h.guests[0]!.stops.length > 0, "the stop");
  await until(() => h.drivers.get(h.sid) === undefined, "the close");
  expect(types(h.store.read(h.sid))).not.toContain("assistant_message");
});

test("evict and shutdown stop the incarnation through the native owner; after shutdown nothing starts", async () => {
  const h = harness({ conversations: 2, script: reply("ok") });
  const one = await h.drivers.ensure(h.sessions[0]!);
  await one.open();
  await h.drivers.evict(h.sessions[0]!);
  expect(h.guests[0]!.stops).toEqual(["user"]);
  expect(h.drivers.list()).toEqual([]);
  const two = await h.drivers.ensure(h.sessions[1]!);
  await two.open();
  await h.drivers.beginShutdown();
  expect(h.guests[1]!.stops).toEqual(["shutdown"]);
  await expect(h.drivers.ensure(h.sessions[1]!)).rejects.toMatchObject({ code: "daemon_shutting_down" });
  await expect(h.drivers.beginShutdown()).resolves.toBeUndefined();
});

test("runTurn runs one headless turn to its end", async () => {
  const h = harness({ script: reply("headless") });
  await h.drivers.runTurn(h.sid, "go", "cli");
  const log = h.store.read(h.sid);
  expect(types(log)).toContain("turn_completed");
  expect(log.some(event => event.type === "assistant_message" && JSON.stringify(event).includes("headless"))).toBe(true);
  expect(h.guests[0]!.refusals).toEqual([]);
});

test("the host launch must agree with the set the guest received, or the incarnation is stopped and nothing runs", async () => {
  // The image's declared readiness changes between the set and the launch: the launch would offer no tool, the guest all four.
  let h: ReturnType<typeof harness> | undefined;
  h = harness({ script: reply("never"), afterSet: () => { (h!.offer.readiness as string[]).length = 0; } });
  const session = await h.drivers.ensure(h.sid);
  await expect(session.open()).rejects.toThrow("stale_acknowledgment");
  expect(h.guests[0]!.stops).toEqual(["user"]);
  expect(h.launched).toEqual([]);
  // The guest received the set, so the conversation never starts fresh.
  await until(() => h!.drivers.get(h!.sid) === undefined, "the close");
  await expect(h.drivers.ensure(h.sid)).rejects.toThrow("cold_resume_unavailable");
});

test("the launch's permission mode must agree with the one the set's policy gives the guest, even when the tools agree", async () => {
  // A read-only ceiling offers the same tools under ask and plan, so only the mode diverges: the binding turns plan after the set.
  let h: ReturnType<typeof harness> | undefined;
  h = harness({ script: reply("never"), toolClasses: ["read"], afterSet: () => { h!.f.db.db.run("UPDATE cowork_conversations SET policy='plan' WHERE session_id=?", [h!.sid]); } });
  const session = await h.drivers.ensure(h.sid);
  await expect(session.open()).rejects.toThrow("stale_acknowledgment");
  expect(h.guests[0]!.stops).toEqual(["user"]);
  expect(h.launched).toEqual([]);
});

test("the router's messaging attach is required for every runnable mode; only a Cowork driver goes without it", () => {
  const h = harness();
  const base = { sessionId: h.sid, backendSessionId: "0b6d7c4e-5a1f-4c2e-9d3b-7e8f9a0b1c2d", runtime: {} as never, options: () => ({}), projector: () => ({}) as never,
    append: () => ({}) as never, broadcast: () => {}, hasTranscript: () => false, idleTimeoutMs: () => Number.POSITIVE_INFINITY };
  for (const mode of ["code", "dispatch", "chat"] as const) expect(() => startWinterSession({ ...base, mode })).toThrow("messaging attach");
  expect(() => startWinterSession({ ...base, mode: "cowork" })).not.toThrow();
});

test("between the runtime's exit and the incarnation's stop outcome, a send refuses before the log (the runtime is gone, cold resume is D10)", async () => {
  const h = harness({ script: reply("ok") });
  const session = await h.drivers.ensure(h.sid);
  await session.send("first", "cli"); await session.idle();
  const guest = h.guests[0]!, length = h.store.read(h.sid).length;
  guest.slowStop = true;
  guest.endRuntime();
  await until(() => session.state !== "live", "the runtime exit");
  expect(h.drivers.get(h.sid)).toBe(session); // the incarnation is still draining
  await expect(session.send("again", "cli")).rejects.toThrow("cold_resume_unavailable");
  await expect(session.steer("again", "cli")).rejects.toThrow("cold_resume_unavailable");
  expect(() => session.deliver("again")).toThrow("cold_resume_unavailable");
  expect(h.store.read(h.sid).length).toBe(length);
  guest.terminate({ released: true, evidence: "orderly-receipt" });
  await until(() => h.drivers.get(h.sid) === undefined, "the close");
});
