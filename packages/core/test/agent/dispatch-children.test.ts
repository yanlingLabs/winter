// Dispatch's children on the Winter leg (`agent/dispatch-children.ts`) — the spec is the engine-era
// `DispatchChildren` and its tests (deleted with `agent/engine.ts` in 497d2112), re-seated on today's
// seams: a REAL SessionStore + SessionHub in a temp home, the creation transaction and the driver
// table as recording fakes that behave like the real ones (a `send` appends the `user_message` and,
// when idle, begins the turn with `turn_started`; a settle is the driver's `onTurnSettled`).
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEvent } from "@yanlinglabs/winter-protocol";
import type { WinterMcpServerInstance } from "@yanlinglabs/winter-agent-sdk";
import { SessionStore } from "../../src/sessions/store";
import { SessionHub } from "../../src/sessions/hub";
import {
  DispatchChildren, DISPATCH_CLIENT_NAME, DISPATCH_WAKE_CLIENT_NAME, RESTART_RESOLUTION_BY, childPolicyFor, type DispatchChildrenDeps,
} from "../../src/agent/dispatch-children";
import { WinterLegRefusal } from "../../src/runtime-sdk/session-driver";
import { ApprovalBroker } from "../../src/agent/approvals";
import { QuestionBroker } from "../../src/agent/questions";
import { PermissionGate, type SessionApprovalPolicy } from "../../src/agent/gate";
import { DISPATCH_CHILD_APPROVAL_TIMEOUT_MS, canUseToolFor } from "../../src/runtime-sdk/approval-bridge";
import { sessionsCapability } from "../../src/capabilities/sessions";
import { SessionMessaging } from "../../src/agent/session-messaging";
import { runningTurnOrigin } from "../../src/sessions/turn-origins";

class FakeDriver {
  turnRunning = false;
  readonly sends: Array<{ text: string; clientName?: string }> = [];
  failNext?: Error;
  constructor(private readonly hub: SessionHub, readonly sessionId: string) {}
  async send(text: string, clientName?: string): Promise<{ seq: number; queued: boolean }> {
    if (this.failNext) { const e = this.failNext; this.failNext = undefined; throw e; }
    this.sends.push({ text, ...(clientName === undefined ? {} : { clientName }) });
    const ev = this.hub.append(this.sessionId, { type: "user_message", sessionId: this.sessionId, threadId: "main", text, clientName: clientName ?? "session" });
    if (this.turnRunning) return { seq: ev.seq, queued: true };
    this.turnRunning = true;
    this.hub.append(this.sessionId, { type: "turn_started", sessionId: this.sessionId, threadId: "main" });
    return { seq: ev.seq, queued: false };
  }
  /** Agent SDK 0.0.44's folding child: a steer while running is pushed now and its `turn_started` held
   *  until the fold (`foldIn`) — the shape `WinterSession` + the projector produce. */
  foldsQueuedInput = false;
  async steer(text: string, clientName?: string): Promise<{ seq: number; injected: boolean }> {
    if (this.failNext) { const e = this.failNext; this.failNext = undefined; throw e; }
    this.sends.push({ text, ...(clientName === undefined ? {} : { clientName }) });
    const ev = this.hub.append(this.sessionId, { type: "user_message", sessionId: this.sessionId, threadId: "main", text, clientName: clientName ?? "steer" });
    if (this.turnRunning) return { seq: ev.seq, injected: true };
    this.turnRunning = true;
    this.hub.append(this.sessionId, { type: "turn_started", sessionId: this.sessionId, threadId: "main" });
    return { seq: ev.seq, injected: false };
  }
  /** One tool round, then the child folds what was steered in (`system/host_input_folded`): the
   *  folded message's `turn_started` lands after the round's `tool_result`, before the next model text. */
  foldIn(callId: string): void {
    this.hub.append(this.sessionId, { type: "tool_call", sessionId: this.sessionId, threadId: "main", callId, name: "bash", argsJson: "{}" });
    this.hub.append(this.sessionId, { type: "tool_result", sessionId: this.sessionId, threadId: "main", callId, output: "ok", isError: false });
    this.hub.append(this.sessionId, { type: "turn_started", sessionId: this.sessionId, threadId: "main" });
  }
}

type ChildUpdate = Extract<SessionEvent, { type: "child_update" }>;

function setup(opts: { models?: string[]; attached?: boolean; policy?: SessionApprovalPolicy } = {}) {
  // Canonical (macOS's tmpdir is a symlink): the spawn stores the canonical dir.
  const home = realpathSync(mkdtempSync(join(tmpdir(), "winter-dispatch-children-")));
  const store = new SessionStore(home);
  const hub = new SessionHub(store);
  const drivers = new Map<string, FakeDriver>();
  const driverFor = (id: string) => { let d = drivers.get(id); if (!d) { d = new FakeDriver(hub, id); drivers.set(id, d); } return d; };
  const created: Array<Record<string, unknown>> = [];
  const deleted: string[] = [];
  let refuseNext: Error | undefined;
  const deferred: Array<() => void> = [];
  const scheduled: Array<{ fn: () => void; ms: number }> = [];
  const notifications: Array<{ title: string; message: string }> = [];
  const dispatchId = store.createSession("global", { cwd: home, approvalPolicy: opts.policy ?? "auto", origin: "dispatch", mode: "dispatch" });
  driverFor(dispatchId);
  const workDir = join(home, "work");
  mkdirSync(workDir);
  const deps: DispatchChildrenDeps = {
    store, hub,
    createSession: () => async (input) => {
      if (refuseNext) { const e = refuseNext; refuseNext = undefined; throw e; }
      created.push(input);
      const sessionId = store.createSession(input.scope, { cwd: input.cwd, approvalPolicy: input.approvalPolicy, origin: input.origin, mode: input.mode, parentSessionId: input.parentSessionId, ...(input.model === undefined ? {} : { model: input.model }) });
      driverFor(sessionId);
      return { sessionId };
    },
    deleteSession: (sid) => { deleted.push(sid); store.deleteSession(sid); drivers.delete(sid); },
    sessions: { get: (id) => drivers.get(id), ensure: async (id) => driverFor(id) },
    ...(opts.models === undefined ? {} : { models: () => opts.models! }),
    notifyFallback: (title, message) => { notifications.push({ title, message }); },
    log: () => {},
    defer: (fn) => { deferred.push(fn); },
    schedule: (fn, ms) => { scheduled.push({ fn, ms }); },
    retryDelaysMs: [5, 10],
  };
  if (opts.attached) hub.attach({ clientName: "mac", deliver: () => true }, dispatchId, 0);
  const dc = new DispatchChildren(deps);
  dc.start();
  // THE door a coordinator's follow-up comes through: SendMessage → the daemon's `SessionMessaging`.
  const messaging = new SessionMessaging({
    store, derive: () => undefined, working: () => false,
    sessions: { get: (id) => drivers.get(id), ensure: async (id) => driverFor(id) },
    followUp: () => dc, log: () => {},
  });
  let msgCounter = 0;
  const sendMessage = (from: string, to: string, message: string) =>
    messaging.send(from, { to, message, messageId: `msg-${++msgCounter}` });
  /** Run every deferred flush, then let their async sends land. */
  const drain = async () => {
    for (let i = 0; i < 5; i++) {
      for (const fn of deferred.splice(0)) fn();
      await new Promise((r) => setTimeout(r, 0));
    }
  };
  /** A child (or the coordinator) ends its turn, the way the projector + driver do. */
  const finish = (id: string, o: { text?: string; error?: string; aborted?: boolean } = {}) => {
    if (o.text !== undefined) hub.append(id, { type: "assistant_message", sessionId: id, threadId: "main", text: o.text });
    if (o.error !== undefined) hub.append(id, { type: "agent_error", sessionId: id, threadId: "main", message: o.error });
    hub.append(id, { type: "turn_completed", sessionId: id, threadId: "main", stopReason: o.aborted ? "aborted" : o.error !== undefined ? "error" : "end_turn", inputTokens: 0, outputTokens: 0 });
    driverFor(id).turnRunning = false;
    dc.onTurnSettled(id);
  };
  const dispatchLog = () => store.read(dispatchId);
  const childUpdates = () => dispatchLog().filter((e): e is ChildUpdate => e.type === "child_update");
  const spawnOne = async (args: Partial<Parameters<DispatchChildren["spawn"]>[1]> = {}) => {
    await dc.spawn(dispatchId, { dir: workDir, prompt: "p", ...args });
    return store.childrenOf(dispatchId).at(-1)!.sessionId;
  };
  return {
    home, store, hub, drivers, driverFor, created, deleted, dispatchId, workDir, dc, deps, drain, finish, dispatchLog, childUpdates, notifications, scheduled, spawnOne, sendMessage,
    refuse: (e: Error) => { refuseNext = e; },
  };
}

const approval = (sid: string, callId: string, threadId = "main") =>
  ({ type: "approval_requested" as const, sessionId: sid, threadId, callId, toolName: "bash", summary: "rm x", issuedAt: 1, expiresAt: 2 });

describe("session_spawn: the spawn", () => {
  test("creates a first-class CODE child linked to its coordinator, titled, sends the prompt, and returns at once", async () => {
    const t = setup();
    const out = await t.dc.spawn(t.dispatchId, { dir: t.workDir, prompt: "  fix the build  ", title: "Build fix" });
    expect(t.created).toHaveLength(1);
    expect(t.created[0]).toMatchObject({ scope: "global", cwd: t.workDir, approvalPolicy: "auto", origin: "dispatch-child", mode: "code", parentSessionId: t.dispatchId });
    const childId = t.store.childrenOf(t.dispatchId)[0]!.sessionId;
    expect(out).toContain(`spawned session ${childId} ("Build fix") in ${t.workDir}`);
    expect(out).toContain("at your current approval policy (auto");
    expect(out).toContain("<child_update>");
    expect(t.store.meta(childId)).toMatchObject({ mode: "code", origin: "dispatch-child", parentSessionId: t.dispatchId, approvalPolicy: "auto" });
    // NOT backgrounded (user ruling 2026-10-02).
    expect(t.store.meta(childId).backgrounded).not.toBe(true);
    // The spawn's title is the session's own (the auto-titler skips a titled session).
    expect(t.store.getTitle(childId)).toBe("Build fix");
    // The prompt went in through the child's own driver, under the dispatch client name — and the
    // spawn did not wait for the child's turn (it is still running).
    expect(t.driverFor(childId).sends).toEqual([{ text: "fix the build", clientName: DISPATCH_CLIENT_NAME }]);
    expect(t.driverFor(childId).turnRunning).toBe(true);
    expect(t.childUpdates().map((e) => ({ child: e.childSessionId, status: e.status, title: e.title }))).toEqual([{ child: childId, status: "running", title: "Build fix" }]);
    expect(t.driverFor(t.dispatchId).sends).toEqual([]);
  });

  test("the child takes the coordinator's CURRENT policy, fixed at spawn", async () => {
    for (const policy of ["auto", "ask", "accept-edits", "dont-ask", "bypass"] as SessionApprovalPolicy[]) {
      const t = setup({ policy });
      const out = await t.dc.spawn(t.dispatchId, { dir: t.workDir, prompt: "p" });
      const childId = t.store.childrenOf(t.dispatchId)[0]!.sessionId;
      expect({ policy, child: t.store.meta(childId).approvalPolicy }).toEqual({ policy, child: policy });
      expect(t.created[0]!.approvalPolicy).toBe(policy);
      expect(out).toContain(`(${policy}; it keeps it even if yours changes later)`);
      // A later change of the coordinator's policy does not reach the running child.
      t.store.setApprovalPolicy(t.dispatchId, "ask");
      expect(t.store.meta(childId).approvalPolicy).toBe(policy);
    }
    // The map: every policy a dispatch session can hold is a code policy (identity); anything else is auto.
    expect(childPolicyFor("plan")).toBe("plan");
    expect(childPolicyFor("chat")).toBe("auto");
    expect(childPolicyFor(undefined)).toBe("auto");
  });

  test("the dir is canonicalised FIRST: a symlinked spelling lands on the real directory, and `/x/..` is `/`", async () => {
    const t = setup();
    const link = join(t.home, "link-to-work");
    symlinkSync(t.workDir, link);
    await t.dc.spawn(t.dispatchId, { dir: link, prompt: "p" });
    expect(t.created[0]!.cwd).toBe(t.workDir);
    // The OS tmp dir itself is a symlinked spelling on macOS (/var → /private/var).
    const viaTmp = mkdtempSync(join(tmpdir(), "winter-dc-tmp-"));
    await t.dc.spawn(t.dispatchId, { dir: viaTmp, prompt: "p" });
    expect(t.created[1]!.cwd).toBe(realpathSync(viaTmp));
    for (const dir of ["/nonexistent-x/..", "/tmp/..", "/"]) {
      const err = await t.dc.spawn(t.dispatchId, { dir, prompt: "p" }).then(() => undefined, (e: Error) => e);
      expect({ dir, message: err?.message }).toEqual({ dir, message: "dir must be an absolute directory path (not '/')." });
    }
    expect(t.created).toHaveLength(2);
  });

  test("a model is stamped at creation (no prompt trailer) and the title defaults to the prompt's head", async () => {
    const t = setup({ models: ["codex-oauth/gpt-5.6-terra", "anthropic/claude-sonnet-5"] });
    const prompt = "x".repeat(100);
    const out = await t.dc.spawn(t.dispatchId, { dir: t.workDir, prompt, model: "anthropic/claude-sonnet-5" });
    expect(t.created[0]).toMatchObject({ model: "anthropic/claude-sonnet-5" });
    const childId = t.store.childrenOf(t.dispatchId)[0]!.sessionId;
    expect(t.store.meta(childId).model).toBe("anthropic/claude-sonnet-5");
    expect(t.driverFor(childId).sends[0]!.text).toBe(prompt);
    expect(out).toContain(`("${"x".repeat(60)}")`);
    expect(out).toContain("on anthropic/claude-sonnet-5");
  });

  test("pre-flight refusals are typed tool errors and leave no trace", async () => {
    const t = setup({ models: ["codex-oauth/gpt-5.6-terra"] });
    const file = join(t.home, "a-file");
    writeFileSync(file, "x");
    const chat = t.store.createSession("global", { mode: "chat", approvalPolicy: "chat" });
    const cases: Array<[string, Parameters<DispatchChildren["spawn"]>, string]> = [
      ["not dispatch", [chat, { dir: t.workDir, prompt: "p" }], "only available in the dispatch session"],
      ["cowork", [t.dispatchId, { dir: t.workDir, prompt: "p", type: "cowork" }], "'cowork' is not yet available"],
      ["relative dir", [t.dispatchId, { dir: "work", prompt: "p" }], "absolute directory path"],
      ["root dir", [t.dispatchId, { dir: "/", prompt: "p" }], "absolute directory path"],
      ["missing dir", [t.dispatchId, { dir: join(t.home, "nope"), prompt: "p" }], "does not exist or is not a directory"],
      ["a file", [t.dispatchId, { dir: file, prompt: "p" }], "does not exist or is not a directory"],
      ["blank prompt", [t.dispatchId, { dir: t.workDir, prompt: "   " }], "prompt is required"],
      ["unknown model", [t.dispatchId, { dir: t.workDir, prompt: "p", model: "openai/gpt-nope" }], "unknown model 'openai/gpt-nope' — available models: codex-oauth/gpt-5.6-terra"],
    ];
    for (const [label, args, words] of cases) {
      const err = await t.dc.spawn(...args).then(() => undefined, (e: Error) => e);
      expect({ label, message: err?.message.includes(words) }).toEqual({ label, message: true });
    }
    expect(t.created).toEqual([]);
    expect(t.store.childrenOf(t.dispatchId)).toEqual([]);
    expect(t.childUpdates()).toEqual([]);
  });

  test("a refused creation transaction is the tool's error, naming the typed code", async () => {
    const t = setup();
    t.refuse(new WinterLegRefusal("winter_executable_unavailable", "no winter runtime executable resolves"));
    const err = await t.dc.spawn(t.dispatchId, { dir: t.workDir, prompt: "p" }).then(() => undefined, (e: Error) => e);
    expect(err?.message).toBe("could not start the child session: no winter runtime executable resolves (winter_executable_unavailable)");
    expect(t.childUpdates()).toEqual([]);
  });

  test("a first message that cannot be delivered rolls the child back: no row, no child_update, a plain tool error", async () => {
    const t = setup();
    const orig = t.deps.createSession()!;
    t.deps.createSession = () => async (input) => { const r = await orig(input); t.driverFor(r.sessionId).failNext = new Error("no credential"); return r; };
    const err = await t.dc.spawn(t.dispatchId, { dir: t.workDir, prompt: "p", title: "T" }).then(() => undefined, (e: Error) => e);
    expect(err?.message).toBe("could not start the child session: its first message could not be delivered: no credential");
    expect(t.deleted).toHaveLength(1);
    expect(t.store.childrenOf(t.dispatchId)).toEqual([]);
    expect(t.childUpdates()).toEqual([]);
    expect(t.dc.roster()).toEqual([]);
  });

  test("the sessions capability server runs the spawner for the calling dispatch session", async () => {
    const t = setup();
    const server = sessionsCapability(
      { sessionId: t.dispatchId, mode: "dispatch", cwd: t.home, roots: [t.home] },
      { spawn: (args, ctx) => t.dc.spawn(ctx.sessionId, args), sessions: { store: t.store, derive: () => undefined, turnStartedAt: () => undefined, isRunning: () => false, interrupt: () => {}, emit: () => {} } as never },
    );
    const res = await (server.instance as WinterMcpServerInstance).callTool("session_spawn", { dir: t.workDir, prompt: "go" }) as { content: Array<{ text: string }>; isError: boolean };
    expect(res.isError).toBe(false);
    expect(res.content[0]!.text).toContain("spawned session s_");
    const bad = await (server.instance as WinterMcpServerInstance).callTool("session_spawn", { dir: "rel", prompt: "go" }) as { content: Array<{ text: string }>; isError: boolean };
    expect(bad.isError).toBe(true);
    expect(bad.content[0]!.text).toContain("absolute directory path");
    const unwired = sessionsCapability({ sessionId: t.dispatchId, mode: "dispatch", cwd: t.home, roots: [t.home] }, { sessions: {} as never });
    const plain = await (unwired.instance as WinterMcpServerInstance).callTool("session_spawn", { dir: t.workDir, prompt: "go" }) as { content: Array<{ text: string }> };
    expect(plain.content[0]!.text).toBe("SpawnSession is only available in the dispatch session.");
  });
});

describe("child_update progression and the relay", () => {
  test("approval and question events are mirrored onto the coordinator with childSessionId, and the status follows", async () => {
    const t = setup();
    const child = await t.spawnOne({ title: "Kid" });
    t.hub.append(child, approval(child, "c1"));
    t.hub.append(child, { type: "approval_resolved", sessionId: child, threadId: "main", callId: "c1", approved: true, by: "mac" });
    t.hub.append(child, { type: "question_asked", sessionId: child, threadId: "main", callId: "q1", questions: [{ question: "Which?", header: "Pick", options: [{ label: "a", description: "" }, { label: "b", description: "" }], multiSelect: false }] });
    t.hub.append(child, { type: "question_resolved", sessionId: child, threadId: "main", callId: "q1", answers: { "Which?": "a" }, by: "mac" });
    const mirrored = t.dispatchLog().filter((e) => ["approval_requested", "approval_resolved", "question_asked", "question_resolved"].includes(e.type));
    expect(mirrored.map((e) => [e.type, e.sessionId, (e as { childSessionId?: string }).childSessionId, (e as { callId: string }).callId])).toEqual([
      ["approval_requested", t.dispatchId, child, "c1"],
      ["approval_resolved", t.dispatchId, child, "c1"],
      ["question_asked", t.dispatchId, child, "q1"],
      ["question_resolved", t.dispatchId, child, "q1"],
    ]);
    expect(t.childUpdates().map((e) => e.status)).toEqual(["running", "awaiting_approval", "running", "awaiting_input", "running"]);
  });

  test("a card raised on a SUBAGENT thread inside the child is mirrored on the coordinator's MAIN thread (the Mac shows only main-thread cards)", async () => {
    const t = setup();
    const child = await t.spawnOne();
    t.hub.append(child, approval(child, "c-sub", "agent-7"));
    t.hub.append(child, { type: "approval_resolved", sessionId: child, threadId: "agent-7", callId: "c-sub", approved: false, by: "mac" });
    const copies = t.dispatchLog().filter((e) => e.type === "approval_requested" || e.type === "approval_resolved");
    expect(copies.map((e) => [(e as { threadId: string }).threadId, (e as { childSessionId?: string }).childSessionId])).toEqual([["main", child], ["main", child]]);
  });

  test("a REAL bridge card from a dispatch child reaches the coordinator, and answering at the child's id resolves it", async () => {
    const t = setup();
    const child = await t.spawnOne();
    const approvals = new ApprovalBroker();
    const canUse = canUseToolFor({
      sessionId: child, mode: "code", policy: "auto", origin: "dispatch-child",
      approvals, questions: new QuestionBroker(), gate: new PermissionGate(),
      emit: (e) => { t.hub.append(e.sessionId, e); }, log: { info: () => {}, error: () => {} },
    });
    const pending = canUse("Workflow", { script: "x" }, { signal: new AbortController().signal, toolUseID: "tu-1", requestId: "r1" } as never);
    await new Promise((r) => setTimeout(r, 5));
    const card = t.dispatchLog().find((e) => e.type === "approval_requested") as { childSessionId?: string; callId: string; toolName: string } | undefined;
    expect(card).toMatchObject({ childSessionId: child, callId: "tu-1", toolName: "Workflow" });
    approvals.resolve(child, "tu-1", true, "mac");   // what `approval.respond {sessionId: child, callId}` does
    expect((await pending)?.behavior).toBe("allow");
    expect(t.dispatchLog().find((e) => e.type === "approval_resolved")).toMatchObject({ childSessionId: child, approved: true });
    expect(t.childUpdates().map((e) => e.status)).toEqual(["running", "awaiting_approval", "running"]);
  });

  test("a dispatch child's QUESTION is bounded like its approvals: it resolves unanswered after 10 minutes", async () => {
    const questions = new QuestionBroker();
    const seen: number[] = [];
    const original = questions.wait.bind(questions);
    questions.wait = (sid, cid, ms) => { seen.push(ms); return original(sid, cid, 5); };
    const events: SessionEvent[] = [];
    const canUse = canUseToolFor({
      sessionId: "s_child", mode: "code", policy: "auto", origin: "dispatch-child",
      approvals: new ApprovalBroker(), questions, gate: new PermissionGate(),
      emit: (e) => { events.push(e as SessionEvent); }, log: { info: () => {}, error: () => {} },
    });
    const input = { questions: [{ question: "Which?", header: "Pick", options: [{ label: "a", description: "" }, { label: "b", description: "" }], multiSelect: false }] };
    const res = await canUse("AskUserQuestion", input, { signal: new AbortController().signal, toolUseID: "q-1", requestId: "r" } as never);
    expect(seen).toEqual([DISPATCH_CHILD_APPROVAL_TIMEOUT_MS]);
    expect(res?.behavior).toBe("deny");
    expect(events.map((e) => e.type)).toEqual(["question_asked", "question_resolved"]);
    expect(events[1]).toMatchObject({ by: "timeout", answers: {} });
    // An ordinary code session's question still waits for its human.
    const plainSeen: number[] = [];
    const q2 = new QuestionBroker();
    q2.wait = (_sid, _cid, ms) => { plainSeen.push(ms); return new Promise(() => {}); };
    const plain = canUseToolFor({ sessionId: "s2", mode: "code", policy: "auto", approvals: new ApprovalBroker(), questions: q2, gate: new PermissionGate(), emit: () => {}, log: { info: () => {}, error: () => {} } });
    void plain("AskUserQuestion", input, { signal: new AbortController().signal, toolUseID: "q-2", requestId: "r" } as never);
    await new Promise((r) => setTimeout(r, 5));
    expect(plainSeen[0]).toBeGreaterThan(DISPATCH_CHILD_APPROVAL_TIMEOUT_MS);
  });

  test("a card from a turn the USER typed into a dispatch child waits for its human (no 10-minute bound), on the child AND relayed once — answering at the child resolves both", async () => {
    const t = setup();
    const child = await t.spawnOne({ title: "Kid" });
    t.finish(child, { text: "done" });
    // The user types into the child's own window (a human clientName), starting a new turn.
    await t.driverFor(child).send("now also bump the version", "winter-mac");
    const approvals = new ApprovalBroker();
    const seen: number[] = [];
    const original = approvals.wait.bind(approvals);
    approvals.wait = (sid, cid, ms, meta) => { seen.push(ms); return original(sid, cid, ms, meta); };
    const canUse = canUseToolFor({
      sessionId: child, mode: "code", policy: "auto", origin: "dispatch-child",
      turnOrigin: () => runningTurnOrigin(t.store.read(child)),
      approvals, questions: new QuestionBroker(), gate: new PermissionGate(),
      emit: (e) => { t.hub.append(e.sessionId, e); }, log: { info: () => {}, error: () => {} },
    });
    const pending = canUse("Workflow", { script: "x" }, { signal: new AbortController().signal, toolUseID: "tu-h", requestId: "r1" } as never);
    await new Promise((r) => setTimeout(r, 5));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeGreaterThan(DISPATCH_CHILD_APPROVAL_TIMEOUT_MS);
    // On the child's own log — what the child's window renders — with the ordinary (unbounded) expiry…
    const own = t.store.read(child).filter((e) => e.type === "approval_requested");
    expect(own).toHaveLength(1);
    const ownCard = own[0] as { issuedAt: number; expiresAt: number };
    expect(ownCard.expiresAt - ownCard.issuedAt).toBe(seen[0]!);
    // …and relayed to Dispatch exactly once, carrying the same expiry.
    const relayed = t.dispatchLog().filter((e) => e.type === "approval_requested");
    expect(relayed).toHaveLength(1);
    expect(relayed[0]).toMatchObject({ childSessionId: child, callId: "tu-h", expiresAt: ownCard.expiresAt });
    // Answered from the child's window (approval.respond at the child's id): one resolution, mirrored once.
    expect(approvals.resolve(child, "tu-h", true, "mac")).toMatchObject({ alreadyResolved: false });
    expect((await pending)?.behavior).toBe("allow");
    // A second answer (the copy in Dispatch, at the same child id) finds nothing pending.
    expect(approvals.resolve(child, "tu-h", false, "mac")).toMatchObject({ alreadyResolved: true });
    expect(t.store.read(child).filter((e) => e.type === "approval_resolved")).toHaveLength(1);
    expect(t.dispatchLog().filter((e) => e.type === "approval_resolved")).toEqual([
      expect.objectContaining({ childSessionId: child, callId: "tu-h", approved: true }),
    ]);
  });

  test("a card from an AUTOMATED turn of a dispatch child (Dispatch's prompt, a peer's message) stays bounded; an unknown origin too", async () => {
    for (const [clientName, bounded] of [["dispatch", true], ["messaging", true], ["winter-mac", false], ["session", false]] as const) {
      const seen: number[] = [];
      const approvals = new ApprovalBroker();
      approvals.wait = (_sid, _cid, ms) => { seen.push(ms); return new Promise(() => {}); };
      const questions = new QuestionBroker();
      questions.wait = (_sid, _cid, ms) => { seen.push(ms); return new Promise(() => {}); };
      const log: SessionEvent[] = [
        { type: "user_message", sessionId: "s_c", threadId: "main", text: "go", clientName, seq: 1, ts: 1 } as SessionEvent,
        { type: "turn_started", sessionId: "s_c", threadId: "main", seq: 2, ts: 2 } as SessionEvent,
      ];
      const canUse = canUseToolFor({
        sessionId: "s_c", mode: "code", policy: "auto", origin: "dispatch-child",
        turnOrigin: () => runningTurnOrigin(log),
        approvals, questions, gate: new PermissionGate(), emit: () => {}, log: { info: () => {}, error: () => {} },
      });
      void canUse("Workflow", { script: "x" }, { signal: new AbortController().signal, toolUseID: `a-${clientName}`, requestId: "r" } as never);
      const input = { questions: [{ question: "Which?", header: "Pick", options: [{ label: "a", description: "" }, { label: "b", description: "" }], multiSelect: false }] };
      void canUse("AskUserQuestion", input, { signal: new AbortController().signal, toolUseID: `q-${clientName}`, requestId: "r" } as never);
      await new Promise((r) => setTimeout(r, 5));
      expect(seen).toHaveLength(2);
      for (const ms of seen) {
        if (bounded) expect(ms).toBe(DISPATCH_CHILD_APPROVAL_TIMEOUT_MS);
        else expect(ms).toBeGreaterThan(DISPATCH_CHILD_APPROVAL_TIMEOUT_MS);
      }
    }
    // No paired message (a runtime-internal wake) or an unreadable log: bounded, today's behaviour.
    for (const turnOrigin of [() => undefined, () => { throw new Error("log gone"); }]) {
      const seen: number[] = [];
      const approvals = new ApprovalBroker();
      approvals.wait = (_sid, _cid, ms) => { seen.push(ms); return new Promise(() => {}); };
      const canUse = canUseToolFor({
        sessionId: "s_c", mode: "code", policy: "auto", origin: "dispatch-child", turnOrigin,
        approvals, questions: new QuestionBroker(), gate: new PermissionGate(), emit: () => {}, log: { info: () => {}, error: () => {} },
      });
      void canUse("Workflow", { script: "x" }, { signal: new AbortController().signal, toolUseID: "u", requestId: "r" } as never);
      await new Promise((r) => setTimeout(r, 5));
      expect(seen).toEqual([DISPATCH_CHILD_APPROVAL_TIMEOUT_MS]);
    }
  });

  test("an unattended coordinator gets a notification when a child needs input or finishes", async () => {
    const t = setup();
    const child = await t.spawnOne({ title: "Kid" });
    t.hub.append(child, approval(child, "c1"));
    t.finish(child, { text: "done" });
    expect(t.notifications).toEqual([{ title: "Kid", message: "needs your approval" }, { title: "Kid", message: "finished" }]);
    expect(t.dispatchLog().filter((e) => e.type === "notification_requested")).toHaveLength(2);
    const a = setup({ attached: true });
    a.finish(await a.spawnOne(), { text: "done" });
    expect(a.notifications).toEqual([]);
  });
});

describe("the completion wake", () => {
  test("a finished child posts its result and wakes an idle coordinator with a <child_update> (a dispatch-wake message)", async () => {
    const t = setup();
    const child = await t.spawnOne({ title: "Kid" });
    t.finish(child, { text: "All green. See /tmp/report.md" });
    expect(t.childUpdates().at(-1)!).toMatchObject({ childSessionId: child, status: "completed", title: "Kid", resultSummary: "All green. See /tmp/report.md" });
    expect(t.driverFor(t.dispatchId).sends).toEqual([]); // deferred to a macrotask
    await t.drain();
    const wake = t.driverFor(t.dispatchId).sends;
    expect(wake).toHaveLength(1);
    // Not the user's words: clients render this clientName as a notice, never a user bubble.
    expect(wake[0]!.clientName).toBe(DISPATCH_WAKE_CLIENT_NAME);
    expect(DISPATCH_WAKE_CLIENT_NAME).toBe("dispatch-wake");
    expect(wake[0]!.text).toContain("<child_update>");
    expect(wake[0]!.text).toContain(`session: ${child}`);
    expect(wake[0]!.text).toContain("status: completed");
    expect(wake[0]!.text).toContain("All green. See /tmp/report.md");
    expect(wake[0]!.text).toContain("No other child sessions are working.");
  });

  test("an error turn is reported as error; a stopped turn as completed, saying it was stopped", async () => {
    const t = setup();
    const a = await t.spawnOne({ title: "A" });
    const b = await t.spawnOne({ title: "B" });
    t.finish(a, { error: "provider 500" });
    t.finish(b, { text: "halfway", aborted: true });
    const ups = t.childUpdates();
    expect(ups.find((e) => e.childSessionId === a && e.status !== "running")).toMatchObject({ status: "error", resultSummary: "It ended with an error: provider 500" });
    expect(ups.find((e) => e.childSessionId === b && e.status !== "running")).toMatchObject({ status: "completed", resultSummary: "Stopped before it finished. Its last message: halfway" });
  });

  test("a stopped turn says WHO stopped it (the live gate): the user, the coordinator's TaskStop, another session", async () => {
    const t = setup();
    const a = await t.spawnOne({ title: "A" });
    const b = await t.spawnOne({ title: "B" });
    const c = await t.spawnOne({ title: "C" });
    const d = await t.spawnOne({ title: "D" });
    t.dc.noteStop(a, { kind: "user" });
    t.finish(a, { text: "halfway", aborted: true });
    t.dc.noteStop(b, { kind: "session", sessionId: t.dispatchId });
    t.finish(b, { aborted: true });
    t.dc.noteStop(c, { kind: "session", sessionId: "s_peer0000001" });
    t.finish(c, { aborted: true });
    t.finish(d, { aborted: true });   // nobody said: the old sentence
    const report = (id: string) => t.childUpdates().find((e) => e.childSessionId === id && e.status !== "running");
    expect(report(a)).toMatchObject({ status: "completed", resultSummary: "Stopped by the user. Its last message: halfway" });
    expect(report(b)).toMatchObject({ status: "completed", resultSummary: "Stopped by you (TaskStop)." });
    expect(report(c)).toMatchObject({ status: "completed", resultSummary: "Stopped by session s_peer0000001 (TaskStop)." });
    expect(report(d)).toMatchObject({ status: "completed", resultSummary: "Stopped before it finished." });
  });

  test("a stop note does not outlive its turn: the next turn ending normally, or aborted for another reason, is reported as such", async () => {
    const t = setup();
    const a = await t.spawnOne({ title: "A" });
    t.dc.noteStop(a, { kind: "user" });
    t.finish(a, { text: "all done" });   // the stop found nothing to abort: a normal end
    expect(t.childUpdates().filter((e) => e.childSessionId === a && e.status !== "running").at(-1)).toMatchObject({ resultSummary: "all done" });
    // Dispatch follows it up; that turn is aborted by something else — no stale "by the user".
    const undo = t.dc.expectFollowUp(a, t.dispatchId, "next step");
    void undo;
    t.hub.append(a, { type: "user_message", sessionId: a, threadId: "main", text: "next step", clientName: "messaging" });
    t.hub.append(a, { type: "turn_started", sessionId: a, threadId: "main" });
    t.finish(a, { aborted: true });
    expect(t.childUpdates().filter((e) => e.childSessionId === a && e.status !== "running").at(-1)).toMatchObject({ resultSummary: "Stopped before it finished." });
  });

  test("\"its last message\" is the turn's LAST assistant text, and says how many tool calls came after it", async () => {
    const t = setup();
    const a = await t.spawnOne({ title: "A" });
    const call = (n: number) => t.hub.append(a, { type: "tool_call", sessionId: a, threadId: "main", callId: `c${n}`, name: "Bash", argsJson: "{}" });
    t.hub.append(a, { type: "assistant_message", sessionId: a, threadId: "main", text: "first words" });
    call(1);
    t.hub.append(a, { type: "assistant_message", sessionId: a, threadId: "main", text: "the latest words" });
    call(2); call(3);
    // a subagent's call is not the main thread's
    t.hub.append(a, { type: "tool_call", sessionId: a, threadId: "toolu_agent", callId: "c9", name: "Read", argsJson: "{}" });
    t.dc.noteStop(a, { kind: "user" });
    t.finish(a, { aborted: true });
    const report = t.childUpdates().find((e) => e.childSessionId === a && e.status !== "running")!;
    expect(report.resultSummary).toBe("Stopped by the user. Its last message, 2 tool calls before it stopped: the latest words");
    expect(report.resultSummary).not.toContain("first words");
  });

  test("agent SDK 0.0.49: an error turn's report carries the classed reason, so Dispatch can tell a refusal from a transient failure", async () => {
    const t = setup();
    const child = await t.spawnOne({ title: "Kid" });
    const ev = (e: Record<string, unknown>) => t.hub.append(child, { sessionId: child, threadId: "main", ...e } as never);
    ev({ type: "assistant_message", text: "Reading the files." });
    ev({ type: "agent_error", code: "bad_request", message: "the provider refused the request: Your credit balance is too low to access the Anthropic API." });
    ev({ type: "turn_completed", stopReason: "error", inputTokens: 0, outputTokens: 0 });
    t.driverFor(child).turnRunning = false;
    t.dc.onTurnSettled(child);
    await t.drain();
    const report = t.childUpdates().at(-1);
    expect(report).toMatchObject({ childSessionId: child, status: "error" });
    expect(report?.resultSummary).toBe("It ended with an error: the provider refused the request: Your credit balance is too low to access the Anthropic API.\nIts last message: Reading the files.");
  });

  test("an error turn followed back-to-back by a successful one reports no stale error", async () => {
    const t = setup();
    const child = await t.spawnOne({ title: "Kid" });
    const ev = (e: Record<string, unknown>) => t.hub.append(child, { sessionId: child, threadId: "main", ...e } as never);
    ev({ type: "agent_error", message: "the provider refused the request: nope" });
    ev({ type: "turn_completed", stopReason: "error", inputTokens: 0, outputTokens: 0 });
    ev({ type: "turn_started" });
    ev({ type: "assistant_message", text: "recovered" });
    t.finish(child);
    await t.drain();
    expect(t.childUpdates().at(-1)).toMatchObject({ status: "completed", resultSummary: "recovered" });
  });

  test("COALESCING: children finishing while the coordinator works wake it ONCE, at its turn's end", async () => {
    const t = setup();
    const a = await t.spawnOne({ title: "A" });
    const b = await t.spawnOne({ title: "B" });
    const c = await t.spawnOne({ title: "C" });
    t.driverFor(t.dispatchId).turnRunning = true; // the coordinator is mid-turn
    t.finish(a, { text: "A done" });
    t.finish(b, { text: "B done" });
    await t.drain();
    expect(t.driverFor(t.dispatchId).sends).toEqual([]);
    t.finish(t.dispatchId, { text: "coordinator turn ends" });
    await t.drain();
    const sends = t.driverFor(t.dispatchId).sends;
    expect(sends).toHaveLength(1);
    expect(sends[0]!.text).toContain(`session: ${a}`);
    expect(sends[0]!.text).toContain(`session: ${b}`);
    expect(sends[0]!.text.match(/<child_update>/g)).toHaveLength(2);
    expect(sends[0]!.text).toContain(`Still working:\n- ${c} "C"`);
  });

  test("COALESCING: children finishing in the same tick while the coordinator is idle wake it once", async () => {
    const t = setup();
    const a = await t.spawnOne();
    const b = await t.spawnOne();
    t.finish(a, { text: "one" });
    t.finish(b, { text: "two" });
    await t.drain();
    expect(t.driverFor(t.dispatchId).sends).toHaveLength(1);
    expect(t.driverFor(t.dispatchId).sends[0]!.text.match(/<child_update>/g)).toHaveLength(2);
  });

  test("a failed wake is retried (bounded), then waits for the coordinator's next settle", async () => {
    const t = setup();
    const child = await t.spawnOne();
    const coordinator = t.driverFor(t.dispatchId);
    coordinator.failNext = new Error("transient");
    t.finish(child, { text: "done" });
    await t.drain();
    expect(coordinator.sends).toEqual([]);
    expect(t.scheduled.map((s) => s.ms)).toEqual([5]);
    t.scheduled.shift()!.fn();
    await t.drain();
    expect(coordinator.sends).toHaveLength(1);
    expect(coordinator.sends[0]!.text).toContain("done");
    // Exhausted retries: no unbounded timer chain.
    const u = setup();
    const kid = await u.spawnOne();
    const dead = { turnRunning: false, send: async () => { throw new Error("down"); } };
    u.deps.sessions.get = (id) => (id === u.dispatchId ? dead : u.drivers.get(id));
    u.finish(kid, { text: "x" });
    for (let i = 0; i < 4; i++) { await u.drain(); u.scheduled.splice(0).forEach((s) => s.fn()); }
    await u.drain();
    expect(u.scheduled).toEqual([]);
  });

  test("a resumable coordinator is resumed for the wake (ensure), like any inbound message", async () => {
    const t = setup();
    const child = await t.spawnOne();
    const coordinator = t.drivers.get(t.dispatchId)!;
    t.drivers.delete(t.dispatchId); // no live driver: it idled out
    let ensured = 0;
    t.deps.sessions.ensure = async (id) => { ensured++; t.drivers.set(id, coordinator); return coordinator; };
    t.finish(child, { text: "ok" });
    await t.drain();
    expect(ensured).toBe(1);
    expect(coordinator.sends).toHaveLength(1);
  });

  test("a settle with no turn (an idle child ended) reports nothing", async () => {
    const t = setup();
    const child = await t.spawnOne();
    t.finish(child, { text: "ok" });
    const before = t.childUpdates().length;
    t.dc.onTurnSettled(child);
    expect(t.childUpdates().length).toBe(before);
  });
});

describe("which turns are followed, the bounded roster, shutdown and restart", () => {
  test("a user working in a finished child directly wakes nobody — tracked or forgotten", async () => {
    const t = setup();
    const child = await t.spawnOne({ title: "Kid" });
    t.finish(child, { text: "first" });
    // Still tracked (Dispatch has not been told yet): the user's own turn in it is not followed.
    await t.driverFor(child).send("let me tweak this myself", "mac");
    t.hub.append(child, approval(child, "c-user"));
    t.finish(child, { text: "user turn result" });
    await t.drain();
    const wakes = t.driverFor(t.dispatchId).sends;
    expect(wakes).toHaveLength(1);
    expect(wakes[0]!.text).toContain("first");
    expect(wakes[0]!.text).not.toContain("user turn result");
    // Its CARD is still relayed to Dispatch (ruling 4: a Dispatch-spawned session's cards always go there),
    // but the unfollowed turn moves no status.
    expect(t.dispatchLog().some((e) => e.type === "approval_requested" && (e as { childSessionId?: string }).childSessionId === child)).toBe(true);
    expect(t.childUpdates().filter((u) => u.childSessionId === child).map((u) => u.status)).toEqual(["running", "completed"]);
    // Its resolution is relayed too; with nothing open, the wake turn's end forgets the child.
    t.hub.append(child, { type: "approval_resolved", sessionId: child, threadId: "main", callId: "c-user", approved: true, by: "mac" });
    expect(t.dispatchLog().some((e) => e.type === "approval_resolved" && (e as { childSessionId?: string }).childSessionId === child)).toBe(true);
    t.finish(t.dispatchId, { text: "reported" });
    expect(t.dc.roster()).toEqual([]);
    await t.driverFor(child).send("more", "mac");
    t.finish(child, { text: "later" });
    await t.drain();
    expect(t.dc.roster()).toEqual([]);
    expect(t.driverFor(t.dispatchId).sends).toHaveLength(1);
  });

  test("a follow-up the COORDINATOR delivers (SendMessage → messaging) is followed and reported", async () => {
    const t = setup();
    const child = await t.spawnOne();
    t.finish(child, { text: "first" });
    await t.drain();
    const answer = await t.sendMessage(t.dispatchId, child, "now also do X");
    expect(answer).toMatchObject({ status: "delivered" });
    expect(answer.note).toContain("<child_update>");
    // Dispatch is the child's delegate-user: its follow-up goes in as plain text, like the spawn's prompt.
    expect(t.driverFor(child).sends.at(-1)).toEqual({ text: "now also do X", clientName: "messaging" });
    expect(t.dc.roster()[0]!.status).toBe("running");
    t.finish(child, { text: "X done" });
    await t.drain();
    expect(t.childUpdates().at(-1)).toMatchObject({ childSessionId: child, status: "completed", resultSummary: "X done" });
  });

  test("a follow-up the coordinator delivers to a FORGOTTEN child is picked back up from its stored link, reported, and wakes it", async () => {
    const t = setup();
    const child = await t.spawnOne({ title: "Kid" });
    t.finish(child, { text: "first" });
    await t.drain();
    t.finish(t.dispatchId, { text: "reported it" });   // the wake turn ends → forgotten
    expect(t.dc.roster()).toEqual([]);
    const wakesBefore = t.driverFor(t.dispatchId).sends.length;
    // Finished and not live: resumed for the message (`ensure`), never cold-resumed by the router.
    t.drivers.delete(child);
    expect(await t.sendMessage(t.dispatchId, `session:${child}`, "one more thing")).toMatchObject({ status: "resumed_and_delivered" });
    expect(t.store.meta(child).backgrounded).not.toBe(true);
    expect(t.dc.roster().map((r) => ({ id: r.sessionId, status: r.status, title: r.title }))).toEqual([{ id: child, status: "running", title: "Kid" }]);
    t.finish(child, { text: "follow-up done" });
    await t.drain();
    expect(t.childUpdates().at(-1)).toMatchObject({ childSessionId: child, status: "completed", title: "Kid", resultSummary: "follow-up done" });
    expect(t.driverFor(t.dispatchId).sends.length).toBe(wakesBefore + 1);
    expect(t.driverFor(t.dispatchId).sends.at(-1)!.text).toContain("follow-up done");
    // The same message from a non-dispatch-child session is never picked up.
    const plain = t.store.createSession("global", { mode: "code", cwd: t.workDir });
    t.hub.append(plain, { type: "user_message", sessionId: plain, threadId: "main", text: "hi", clientName: "messaging" });
    t.hub.append(plain, { type: "turn_started", sessionId: plain, threadId: "main" });
    expect(t.dc.roster().some((r) => r.sessionId === plain)).toBe(false);
  });

  test("ANOTHER session's SendMessage to a dispatch child is delivered (attributed) but never followed — forgotten or tracked", async () => {
    const t = setup();
    const child = await t.spawnOne({ title: "Kid" });
    t.finish(child, { text: "first" });
    await t.drain();
    const peer = t.store.createSession("global", { mode: "code", cwd: t.workDir });
    // Still tracked (the coordinator has not ended the wake turn yet): a peer's message is not Dispatch's work.
    const tracked = await t.sendMessage(peer, child, "peer says hi");
    expect(tracked.status).toBe("delivered");
    expect(tracked.note).toContain("not one of your children");
    expect(t.driverFor(child).sends.at(-1)!.text).toStartWith(`<agent-message from="session:${peer}"`);
    const updatesBefore = t.childUpdates().length;
    t.finish(child, { text: "answered the peer" });
    await t.drain();
    expect(t.childUpdates().length).toBe(updatesBefore);
    // Forgotten: a peer's message does not pick it back up either.
    t.finish(t.dispatchId, { text: "reported it" });
    expect(t.dc.roster()).toEqual([]);
    await t.sendMessage(peer, child, "again");
    expect(t.dc.roster()).toEqual([]);
  });

  test("APPROVAL FORWARDING (ruling 4): a peer's message to a FORGOTTEN dispatch child still relays its cards to Dispatch — no status, no wake", async () => {
    const t = setup();
    const child = await t.spawnOne({ title: "Kid" });
    t.finish(child, { text: "first" });
    await t.drain();
    t.finish(t.dispatchId, { text: "reported" });
    expect(t.dc.roster()).toEqual([]);
    const peer = t.store.createSession("global", { mode: "code", cwd: t.workDir });
    const wakesBefore = t.driverFor(t.dispatchId).sends.length;
    const updatesBefore = t.childUpdates().length;
    expect((await t.sendMessage(peer, child, "peer asks for something risky")).status).toBe("delivered");
    t.hub.append(child, approval(child, "c-peer"));
    const mirrored = t.dispatchLog().find((e) => e.type === "approval_requested" && (e as { callId?: string }).callId === "c-peer") as { childSessionId?: string; threadId: string } | undefined;
    expect(mirrored).toMatchObject({ childSessionId: child, threadId: "main" });
    t.hub.append(child, { type: "approval_resolved", sessionId: child, threadId: "main", callId: "c-peer", approved: false, by: "mac" });
    expect(t.dispatchLog().some((e) => e.type === "approval_resolved" && (e as { callId?: string }).callId === "c-peer")).toBe(true);
    t.finish(child, { text: "did the peer's thing" });
    await t.drain();
    expect(t.childUpdates().length).toBe(updatesBefore);
    expect(t.driverFor(t.dispatchId).sends.length).toBe(wakesBefore);
    expect(t.dc.roster()).toEqual([]); // the relay-only entry left with its last card
  });

  test("APPROVAL FORWARDING (ruling 4): a top-level code session's cards are never forwarded anywhere", async () => {
    const t = setup();
    const a = t.store.createSession("global", { mode: "code", cwd: t.workDir });
    const b = t.store.createSession("global", { mode: "code", cwd: t.workDir });
    expect((await t.sendMessage(a, b, "do it")).status).toBe("resumed_and_delivered");
    t.hub.append(b, approval(b, "c-b"));
    expect(t.dispatchLog().some((e) => e.type === "approval_requested")).toBe(false);
    expect(t.store.read(a).some((e) => e.type === "approval_requested")).toBe(false);
    expect(t.dc.roster()).toEqual([]);
  });

  test("the follow-up expectation is keyed on the coordinator's exact text: a peer's message queued first is not mistaken for it", async () => {
    const t = setup();
    const child = await t.spawnOne({ title: "Kid" });
    t.finish(child, { text: "first" });
    await t.drain();
    t.finish(t.dispatchId, { text: "reported" });
    const peer = t.store.createSession("global", { mode: "code", cwd: t.workDir });
    // Set the coordinator's expectation, then let the PEER's message land first.
    const undo = t.dc.expectFollowUp(child, t.dispatchId, "coordinator's next step");
    await t.driverFor(child).send("<agent-message from=\"session:x\">peer</agent-message>", "messaging");
    expect(t.dc.roster()).toEqual([]); // not picked up by the peer's message
    t.finish(child, { text: "peer turn" });
    await t.driverFor(child).send("coordinator's next step", "messaging");
    expect(t.dc.roster().map((r) => r.status)).toEqual(["running"]);
    t.finish(child, { text: "followed turn" });
    await t.drain();
    expect(t.childUpdates().at(-1)).toMatchObject({ childSessionId: child, status: "completed", resultSummary: "followed turn" });
    undo(); // consumed already: a no-op
  });

  test("a follow-up QUEUED behind an unfollowed peer turn (with another message behind it) keeps its own tag — followed and woken", async () => {
    const t = setup();
    const child = await t.spawnOne({ title: "Kid" });
    t.finish(child, { text: "first" });
    await t.drain();
    t.finish(t.dispatchId, { text: "reported" });
    const peer = t.store.createSession("global", { mode: "code", cwd: t.workDir });
    const updatesBefore = t.childUpdates().length;
    // The peer's message starts a turn; Dispatch's follow-up and then another peer message queue behind it.
    await t.sendMessage(peer, child, "peer one");
    expect((await t.sendMessage(t.dispatchId, child, "dispatch follow-up")).status).toBe("queued");
    await t.sendMessage(peer, child, "peer two");
    const startNext = () => { t.driverFor(child).turnRunning = true; t.hub.append(child, { type: "turn_started", sessionId: child, threadId: "main" }); };
    t.finish(child, { text: "peer one done" });       // the peer's turn: not followed
    expect(t.childUpdates().length).toBe(updatesBefore);
    startNext();                                       // Dispatch's follow-up starts: followed
    expect(t.childUpdates().at(-1)).toMatchObject({ childSessionId: child, status: "running" });
    t.finish(child, { text: "follow-up done" });
    await t.drain();
    expect(t.childUpdates().at(-1)).toMatchObject({ childSessionId: child, status: "completed", resultSummary: "follow-up done" });
    expect(t.driverFor(t.dispatchId).sends.at(-1)!.text).toContain("follow-up done");
    const afterWake = t.childUpdates().length;
    startNext();                                       // the second peer message: not followed
    t.finish(child, { text: "peer two done" });
    await t.drain();
    expect(t.childUpdates().length).toBe(afterWake);
  });

  test("the open-main-turn set never keeps a session whose driver settled — even one whose last turn never got a turn_completed", async () => {
    const t = setup();
    const plain = t.store.createSession("global", { mode: "code", cwd: t.workDir });
    t.hub.append(plain, { type: "user_message", sessionId: plain, threadId: "main", text: "hi", clientName: "cli" });
    t.hub.append(plain, { type: "turn_started", sessionId: plain, threadId: "main" });   // its child dies: no terminal
    expect(t.dc.openMainTurnCount()).toBe(1);
    t.dc.onTurnSettled(plain);
    expect(t.dc.openMainTurnCount()).toBe(0);
  });

  test("BACK-TO-BACK (no settle between): an error turn, then a held send's turn that succeeds — reported completed with the second turn's result, never error", async () => {
    const t = setup();
    const child = await t.spawnOne({ title: "Kid" });
    const ev = (e: Record<string, unknown>) => t.hub.append(child, { sessionId: child, threadId: "main", ...e } as never);
    ev({ type: "agent_error", message: "provider 500" });
    ev({ type: "turn_completed", stopReason: "error", inputTokens: 0, outputTokens: 0 });
    ev({ type: "turn_started" });                      // the held send drained at the result: no settle yet
    ev({ type: "assistant_message", text: "recovered" });
    t.finish(child);
    await t.drain();
    expect(t.childUpdates().at(-1)).toMatchObject({ childSessionId: child, status: "completed", resultSummary: "recovered" });
  });

  test("BACK-TO-BACK: a stopped turn with a steer queued behind it, then that steer's turn succeeds — reported completed, never 'Stopped before it finished'", async () => {
    const t = setup();
    const child = await t.spawnOne({ title: "Kid" });
    const ev = (e: Record<string, unknown>) => t.hub.append(child, { sessionId: child, threadId: "main", ...e } as never);
    ev({ type: "turn_completed", stopReason: "aborted", inputTokens: 0, outputTokens: 0 });
    ev({ type: "turn_started" });                      // the queued steer starts right after (C2)
    ev({ type: "assistant_message", text: "did the steer" });
    t.finish(child);
    await t.drain();
    expect(t.childUpdates().at(-1)).toMatchObject({ status: "completed", resultSummary: "did the steer" });
  });

  test("FOLD with an older held send: Dispatch's folded follow-up keeps its OWN tag (adjacency) — followed and woken at the turn's end; the held send's later turn is not taken for it", async () => {
    const t = setup();
    const child = await t.spawnOne({ title: "Kid" });
    t.finish(child, { text: "first" });
    await t.drain();
    t.finish(t.dispatchId, { text: "reported" });             // forgotten
    const ev = (e: Record<string, unknown>) => t.hub.append(child, { sessionId: child, threadId: "main", ...e } as never);
    ev({ type: "user_message", text: "user's own task", clientName: "cli-chat" });
    ev({ type: "turn_started" });                              // the user's turn (unfollowed)
    ev({ type: "tool_call", callId: "c1", name: "bash", argsJson: "{}" });
    ev({ type: "user_message", text: "user's next one", clientName: "cli-chat" });   // held by the daemon
    t.dc.expectFollowUp(child, t.dispatchId, "dispatch adds this");
    ev({ type: "user_message", text: "dispatch adds this", clientName: "messaging" }); // steered
    ev({ type: "tool_result", callId: "c1", output: "ok", isError: false });
    const updatesBefore = t.childUpdates().length;
    ev({ type: "turn_started" });                              // the fold: Dispatch's message
    expect(t.childUpdates().slice(updatesBefore).map((e) => e.status)).toEqual(["running"]);
    t.finish(child, { text: "both done" });
    await t.drain();
    expect(t.childUpdates().at(-1)).toMatchObject({ status: "completed", resultSummary: "both done" });
    const afterWake = t.childUpdates().length;
    t.finish(t.dispatchId, { text: "noted" });                // forgotten again
    ev({ type: "turn_started" });                              // the user's held send runs: not Dispatch's
    t.finish(child, { text: "user's thing" });
    await t.drain();
    expect(t.childUpdates().length).toBe(afterWake);
  });

  test("FOLD (agent SDK 0.0.44): a follow-up steered into the child's own running turn is folded there — ONE completed, ONE wake, at that turn's end, with the turn's whole result", async () => {
    const t = setup();
    const child = await t.spawnOne({ title: "Kid" });
    const d = t.driverFor(child);
    d.foldsQueuedInput = true;
    t.hub.append(child, { type: "assistant_message", sessionId: child, threadId: "main", text: "halfway through the build" });
    const answer = await t.sendMessage(t.dispatchId, child, "also run the linter");
    expect(answer.status).toBe("delivered");
    expect(answer.note).toContain("after its current tool call");
    expect(d.sends.at(-1)).toEqual({ text: "also run the linter", clientName: "messaging" });
    d.foldIn("call_1");
    // the fold is not a new turn: nothing reset, nothing reported, still running
    expect(t.childUpdates().map((e) => e.status)).toEqual(["running"]);
    const wakesBefore = t.driverFor(t.dispatchId).sends.length;
    t.finish(child);                                   // the running turn's ONE end, no closing text
    await t.drain();
    expect(t.childUpdates().map((e) => e.status)).toEqual(["running", "completed"]);
    expect(t.childUpdates().at(-1)).toMatchObject({ childSessionId: child, resultSummary: "halfway through the build" });
    expect(t.driverFor(t.dispatchId).sends.length).toBe(wakesBefore + 1);
    expect(t.driverFor(t.dispatchId).sends.at(-1)).toMatchObject({ clientName: DISPATCH_WAKE_CLIENT_NAME });
  });

  test("FOLD (agent SDK 0.0.44): a follow-up folded into a PEER's running turn of a FORGOTTEN child is picked back up, reported completed and wakes Dispatch when that turn ends", async () => {
    const t = setup();
    const child = await t.spawnOne({ title: "Kid" });
    t.finish(child, { text: "first" });
    await t.drain();
    t.finish(t.dispatchId, { text: "reported" });
    expect(t.dc.roster()).toEqual([]);
    const peer = t.store.createSession("global", { mode: "code", cwd: t.workDir });
    await t.sendMessage(peer, child, "peer asks for a refactor");   // starts an unfollowed turn
    const d = t.driverFor(child);
    d.foldsQueuedInput = true;
    const updatesBefore = t.childUpdates().length;
    const wakesBefore = t.driverFor(t.dispatchId).sends.length;
    expect((await t.sendMessage(t.dispatchId, child, "and bump the version")).status).toBe("delivered");
    d.foldIn("call_9");                                 // Dispatch's message joins the running turn
    expect(t.childUpdates().slice(updatesBefore).map((e) => e.status)).toEqual(["running"]);
    t.finish(child, { text: "refactored and bumped" });
    await t.drain();
    expect(t.childUpdates().slice(updatesBefore).map((e) => e.status)).toEqual(["running", "completed"]);
    expect(t.childUpdates().at(-1)).toMatchObject({ childSessionId: child, title: "Kid", resultSummary: "refactored and bumped" });
    expect(t.driverFor(t.dispatchId).sends.length).toBe(wakesBefore + 1);
    expect(t.driverFor(t.dispatchId).sends.at(-1)!.text).toContain("refactored and bumped");
  });

  test("a card from a child the user has OPEN is still relayed, but raises no unattended notification", async () => {
    const t = setup();
    const child = await t.spawnOne({ title: "Kid" });
    t.hub.attach({ clientName: "orb", deliver: () => true }, child, 0);
    t.hub.append(child, approval(child, "c-open"));
    expect(t.dispatchLog().some((e) => e.type === "approval_requested" && (e as { callId?: string }).callId === "c-open")).toBe(true);
    expect(t.notifications).toEqual([]);
    expect(t.dispatchLog().some((e) => e.type === "notification_requested")).toBe(false);
  });

  test("shutdown: no report and no wake while the children drain — but a withdrawn card still closes on the coordinator's log", async () => {
    const t = setup();
    const child = await t.spawnOne();
    t.hub.append(child, approval(child, "c1"));
    t.dc.beginShutdown();
    // The child's turn is aborted by the drain: the bridge withdraws the card, then the turn settles.
    t.hub.append(child, { type: "approval_resolved", sessionId: child, threadId: "main", callId: "c1", approved: false, by: "aborted" });
    t.finish(child, { aborted: true });
    await t.drain();
    expect(t.dispatchLog().filter((e) => e.type === "approval_resolved")).toHaveLength(1);
    expect(t.childUpdates().map((e) => e.status)).toEqual(["running", "awaiting_approval"]);
    expect(t.driverFor(t.dispatchId).sends).toEqual([]);
    await expect(t.dc.spawn(t.dispatchId, { dir: t.workDir, prompt: "p" })).rejects.toThrow("shutting down");
    t.dc.stop();
    t.hub.append(child, { type: "approval_resolved", sessionId: child, threadId: "main", callId: "c2", approved: false, by: "aborted" });
    expect(t.dispatchLog().filter((e) => e.type === "approval_resolved")).toHaveLength(1);
  });

  test("restart: open mirrored cards are CLOSED, an in-flight child gets a closing update, and only it is re-tracked", async () => {
    const t = setup();
    const busy = await t.spawnOne({ title: "Long job" });
    const done = await t.spawnOne({ title: "Done job" });
    t.finish(done, { text: "finished before the restart" });
    t.hub.append(busy, approval(busy, "c1"));
    t.hub.append(busy, { type: "question_asked", sessionId: busy, threadId: "main", callId: "q1", questions: [{ question: "Which?", header: "Pick", options: [{ label: "a", description: "" }, { label: "b", description: "" }], multiSelect: false }] });
    // A crash: nothing resolves the cards, nothing reports the turn.
    t.dc.stop();
    const store2 = new SessionStore(t.home);
    const hub2 = new SessionHub(store2);
    const sends: string[] = [];
    const deferred: Array<() => void> = [];
    const fake = { turnRunning: false, send: async (text: string) => { sends.push(text); return { seq: 0, queued: false }; } };
    const mk = () => new DispatchChildren({
      store: store2, hub: hub2, createSession: () => undefined,
      sessions: { get: () => fake, ensure: async () => fake },
      log: () => {}, defer: (fn) => { deferred.push(fn); },
    });
    const dc2 = mk();
    dc2.start();
    const log = store2.read(t.dispatchId);
    const resolutions = log.filter((e) => e.type === "approval_resolved" || e.type === "question_resolved");
    expect(resolutions.map((e) => [e.type, (e as { callId: string }).callId, (e as { by: string }).by, (e as { childSessionId?: string }).childSessionId])).toEqual([
      ["approval_resolved", "c1", RESTART_RESOLUTION_BY, busy],
      ["question_resolved", "q1", RESTART_RESOLUTION_BY, busy],
    ]);
    expect(resolutions[0]).toMatchObject({ approved: false });
    expect(resolutions[1]).toMatchObject({ answers: {} });
    const ups = log.filter((e): e is ChildUpdate => e.type === "child_update");
    expect(ups.at(-1)).toMatchObject({ childSessionId: busy, status: "error", title: "Long job" });
    expect(ups.at(-1)!.resultSummary).toContain("Winter restarted while this session was working");
    expect(ups.filter((u) => u.childSessionId === done).map((u) => u.status)).toEqual(["running", "completed"]);
    expect(store2.childrenOf(t.dispatchId).map((r) => r.sessionId).sort()).toEqual([busy, done].sort());
    // A second boot closes nothing again.
    const again = mk(); again.start(); again.stop();
    expect(store2.read(t.dispatchId).length).toBe(log.length);
    // The child that was finished before the restart, resumed by the user, is NOT picked up…
    hub2.append(done, { type: "turn_started", sessionId: done, threadId: "main" });
    dc2.onTurnSettled(done);
    // …the interrupted one IS: its next turn is reported.
    hub2.append(busy, { type: "turn_started", sessionId: busy, threadId: "main" });
    hub2.append(busy, { type: "assistant_message", sessionId: busy, threadId: "main", text: "resumed and done" });
    dc2.onTurnSettled(busy);
    for (const fn of deferred.splice(0)) fn();
    await new Promise((r) => setTimeout(r, 0));
    expect(sends).toHaveLength(1);
    expect(sends[0]).toContain("resumed and done");
    expect(sends[0]).not.toContain(done);
    dc2.stop();
  });

  test("a session that is not a dispatch child is never tracked", async () => {
    const t = setup();
    const plain = t.store.createSession("global", { mode: "code", cwd: t.workDir });
    t.hub.append(plain, { type: "turn_started", sessionId: plain, threadId: "main" });
    t.dc.onTurnSettled(plain);
    await t.drain();
    expect(t.dc.roster()).toEqual([]);
    expect(t.childUpdates()).toEqual([]);
  });
});

// Agent SDK 0.0.41 (user ruling 2026-10-03): `SpawnSession` is concurrency-safe, so one coordinator round
// can run several spawns AT ONCE. The two steps a spawn awaits (the creation transaction, the child's first
// `send`) are gates here, released in an order the test picks.
describe("session_spawn: several spawns of one round at once", () => {
  function gate() {
    let open!: () => void;
    let fail!: (e: Error) => void;
    const p = new Promise<void>((res, rej) => { open = res; fail = rej; });
    return { p, open, fail };
  }
  /** `setup()` with each spawn's creation and its child's first `send` held until the test releases them. */
  function concurrentSetup() {
    const t = setup();
    const createGates = new Map<string, ReturnType<typeof gate>>();   // keyed by the spawn's key
    const sendGates = new Map<string, ReturnType<typeof gate>>();
    const createStarted: string[] = [];
    const pendingKeys: string[] = [];
    const childOf = new Map<string, string>();
    const realCreate = t.deps.createSession()!;
    t.deps.createSession = () => async (input) => {
      // The creation input carries no prompt: with no model check to await, a spawn reaches its creation
      // synchronously, so the creations start in call order.
      const key = pendingKeys.shift()!;
      createStarted.push(key);
      const g = gate(); createGates.set(key, g);
      await g.p;
      const out = await realCreate(input);
      childOf.set(key, out.sessionId);
      const sg = gate(); sendGates.set(key, sg);
      const d = t.driverFor(out.sessionId);
      const realSend = d.send.bind(d);
      d.send = async (text, clientName) => { await sg.p; return realSend(text, clientName); };
      return out;
    };
    const spawn = (key: string, extra: { signal?: AbortSignal } = {}) => {
      pendingKeys.push(key);
      return t.dc.spawn(t.dispatchId, { dir: t.workDir, prompt: `task ${key}`, title: `T-${key}` }, extra)
        .then((text) => ({ ok: true as const, text }), (err: Error) => ({ ok: false as const, text: err.message }));
    };
    const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); };
    return { ...t, createGates, sendGates, createStarted, childOf, spawn, settle };
  }

  test("three spawns in flight together, creations and prompts released out of order: three children, nothing cross-wired", async () => {
    const t = concurrentSetup();
    const results = [t.spawn("a"), t.spawn("b"), t.spawn("c")];
    await t.settle();
    // All three creations are under way before any of them has finished.
    expect(t.createStarted).toEqual(["a", "b", "c"]);
    t.createGates.get("c")!.open(); await t.settle();
    t.createGates.get("a")!.open(); await t.settle();
    t.sendGates.get("c")!.open(); await t.settle();
    t.createGates.get("b")!.open(); await t.settle();
    t.sendGates.get("b")!.open(); t.sendGates.get("a")!.open();
    const out = await Promise.all(results);
    expect(out.every((r) => r.ok)).toBe(true);
    const keys = ["a", "b", "c"];
    const ids = keys.map((k) => t.childOf.get(k)!);
    expect(new Set(ids).size).toBe(3);
    for (const [i, key] of keys.entries()) {
      const id = ids[i]!;
      // Each call's answer names ITS child; each child got ITS prompt and ITS title, once.
      expect(out[i]!.text).toContain(`spawned session ${id} ("T-${key}")`);
      expect(t.driverFor(id).sends).toEqual([{ text: `task ${key}`, clientName: DISPATCH_CLIENT_NAME }]);
      expect(t.store.getTitle(id)).toBe(`T-${key}`);
      expect(t.store.meta(id)).toMatchObject({ origin: "dispatch-child", parentSessionId: t.dispatchId, mode: "code" });
      // Exactly one `running` announcement each, with its own title.
      expect(t.childUpdates().filter((u) => u.childSessionId === id).map((u) => [u.status, u.title])).toEqual([["running", `T-${key}`]]);
    }
    expect(t.dc.roster().map((r) => r.sessionId).sort()).toEqual([...ids].sort());
    // Each finishes and reports on its own; ONE wake (the coordinator is idle) carries all three.
    for (const [i, id] of ids.entries()) t.finish(id, { text: `done ${i}` });
    await t.drain();
    const wakes = t.driverFor(t.dispatchId).sends;
    expect(wakes).toHaveLength(1);
    for (const [i, id] of ids.entries()) expect(wakes[0]!.text).toContain(`session: ${id}\ntitle: T-${keys[i]}`);
    for (const [i, id] of ids.entries()) {
      expect(t.childUpdates().filter((u) => u.childSessionId === id).map((u) => [u.status, u.resultSummary])).toEqual([["running", undefined], ["completed", `done ${i}`]]);
    }
  });

  test("one spawn's failed first message rolls back that child alone; a refused creation leaves nothing; the others stand", async () => {
    const t = concurrentSetup();
    const results = [t.spawn("a"), t.spawn("b"), t.spawn("c")];
    await t.settle();
    for (const k of ["a", "b", "c"]) t.createGates.get(k)!.open();
    await t.settle();
    const bId = t.childOf.get("b")!;
    t.sendGates.get("b")!.fail(new Error("pipe closed"));
    t.sendGates.get("a")!.open(); t.sendGates.get("c")!.open();
    const out = await Promise.all(results);
    expect(out.map((r) => r.ok)).toEqual([true, false, true]);
    expect(out[1]!.text).toContain("its first message could not be delivered: pipe closed");
    expect(t.deleted).toEqual([bId]);
    expect(t.childUpdates().some((u) => u.childSessionId === bId)).toBe(false);
    const kept = t.store.childrenOf(t.dispatchId).map((r) => r.sessionId).sort();
    expect(kept).toEqual([t.childOf.get("a")!, t.childOf.get("c")!].sort());
    expect(t.dc.roster().map((r) => r.sessionId).sort()).toEqual(kept);

    // A refused creation beside another spawn: that call fails, nothing of it exists, the other stands.
    const u = setup();
    const first = u.dc.spawn(u.dispatchId, { dir: u.workDir, prompt: "one" });
    u.refuse(new WinterLegRefusal("winter_executable_unavailable", "no winter binary"));
    const second = u.dc.spawn(u.dispatchId, { dir: u.workDir, prompt: "two" });
    const settled = await Promise.allSettled([first, second]);
    expect(settled.map((s) => s.status)).toEqual(["fulfilled", "rejected"]);
    expect(u.store.childrenOf(u.dispatchId)).toHaveLength(1);
    expect(u.childUpdates()).toHaveLength(1);
  });

  test("an interrupted coordinator turn cancels its in-flight spawns: before creation nothing, created but not yet prompted removed, prompt already going in kept", async () => {
    const t = concurrentSetup();
    // (1) Cancelled before the call starts: nothing is created.
    const pre = new AbortController();
    pre.abort();
    const early = await t.dc.spawn(t.dispatchId, { dir: t.workDir, prompt: "never" }, { signal: pre.signal }).then(() => "ok", (e: Error) => e.message);
    expect(early).toContain("cancelled — nothing was created");
    expect(t.created).toHaveLength(0);

    // (2) Three spawns in flight when the turn is interrupted: a is still being created, b's prompt is
    // already being delivered, c has finished.
    const ctl = new AbortController();
    const results = [t.spawn("a", { signal: ctl.signal }), t.spawn("b", { signal: ctl.signal }), t.spawn("c", { signal: ctl.signal })];
    await t.settle();
    t.createGates.get("b")!.open(); t.createGates.get("c")!.open();
    await t.settle();
    t.sendGates.get("c")!.open();
    expect((await results[2]!).ok).toBe(true);
    ctl.abort();
    t.createGates.get("a")!.open();
    t.sendGates.get("b")!.open();
    await t.settle();
    t.sendGates.get("a")?.open();
    const [a, b] = await Promise.all([results[0]!, results[1]!]);
    const aId = t.childOf.get("a")!;
    const bId = t.childOf.get("b")!;
    const cId = t.childOf.get("c")!;
    // a was created after the interrupt and removed before any prompt reached it.
    expect(a.ok).toBe(false);
    expect(a.text).toContain("cancelled before the child session got its prompt");
    expect(t.deleted).toEqual([aId]);
    expect(t.driverFor(aId).sends).toEqual([]);
    // b's prompt was already on its way: the child is working, so it stays (and reports like any other).
    expect(b.ok).toBe(true);
    for (const [id, key] of [[bId, "b"], [cId, "c"]] as const) {
      expect(t.driverFor(id).sends).toEqual([{ text: `task ${key}`, clientName: DISPATCH_CLIENT_NAME }]);
    }
    expect(t.store.childrenOf(t.dispatchId).map((r) => r.sessionId).sort()).toEqual([bId, cId].sort());
    expect(t.childUpdates().map((u) => u.childSessionId).sort()).toEqual([bId, cId].sort());
    expect(t.dc.roster().map((r) => r.sessionId).sort()).toEqual([bId, cId].sort());
  });
});
