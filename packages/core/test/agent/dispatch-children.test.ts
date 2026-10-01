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
    home, store, hub, drivers, driverFor, created, deleted, dispatchId, workDir, dc, deps, drain, finish, dispatchLog, childUpdates, notifications, scheduled, spawnOne,
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
    expect(t.store.meta(childId)).toMatchObject({ mode: "code", origin: "dispatch-child", parentSessionId: t.dispatchId, approvalPolicy: "auto", backgrounded: true });
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
    expect(plain.content[0]!.text).toBe("session_spawn is only available in the dispatch session.");
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
    expect(ups.find((e) => e.childSessionId === a && e.status !== "running")).toMatchObject({ status: "error" });
    expect(ups.find((e) => e.childSessionId === b && e.status !== "running")).toMatchObject({ status: "completed", resultSummary: "Stopped before it finished. Its last message: halfway" });
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
    expect(t.dispatchLog().some((e) => e.type === "approval_requested")).toBe(false);
    // The wake turn ends → the child is forgotten; a later direct turn is not picked back up.
    t.finish(t.dispatchId, { text: "reported" });
    expect(t.dc.roster()).toEqual([]);
    await t.driverFor(child).send("more", "mac");
    t.finish(child, { text: "later" });
    await t.drain();
    expect(t.dc.roster()).toEqual([]);
    expect(t.driverFor(t.dispatchId).sends).toHaveLength(1);
  });

  test("a follow-up the COORDINATOR delivers (send_message → messaging) is followed and reported", async () => {
    const t = setup();
    const child = await t.spawnOne();
    t.finish(child, { text: "first" });
    await t.drain();
    await t.driverFor(child).send("now also do X", "messaging");
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
    await t.driverFor(child).send("one more thing", "messaging");
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
