// Dispatch's children on the Winter leg (`agent/dispatch-children.ts`) — the spec is the engine-era
// `DispatchChildren` and its tests (deleted with `agent/engine.ts` in 497d2112), re-seated on today's
// seams: a REAL SessionStore + SessionHub in a temp home, the creation transaction and the driver
// table as recording fakes that behave like the real ones (a `send` appends the `user_message` and,
// when idle, begins the turn with `turn_started`; a settle is the driver's `onTurnSettled`).
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEvent } from "@yanlinglabs/winter-protocol";
import { SessionStore } from "../../src/sessions/store";
import { SessionHub } from "../../src/sessions/hub";
import { DispatchChildren, DISPATCH_CLIENT_NAME, type DispatchChildrenDeps } from "../../src/agent/dispatch-children";
import { WinterLegRefusal } from "../../src/runtime-sdk/session-driver";
import { ApprovalBroker } from "../../src/agent/approvals";
import { QuestionBroker } from "../../src/agent/questions";
import { PermissionGate } from "../../src/agent/gate";
import { canUseToolFor } from "../../src/runtime-sdk/approval-bridge";
import { sessionsCapability } from "../../src/capabilities/sessions";
import type { WinterMcpServerInstance } from "@yanlinglabs/winter-agent-sdk";

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

function setup(opts: { models?: string[]; attached?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), "winter-dispatch-children-"));
  const store = new SessionStore(home);
  const hub = new SessionHub(store);
  const drivers = new Map<string, FakeDriver>();
  const driverFor = (id: string) => { let d = drivers.get(id); if (!d) { d = new FakeDriver(hub, id); drivers.set(id, d); } return d; };
  const created: Array<Record<string, unknown>> = [];
  let refuseNext: Error | undefined;
  const deferred: Array<() => void> = [];
  const notifications: Array<{ title: string; message: string }> = [];
  const dispatchId = store.createSession("global", { cwd: home, approvalPolicy: "auto", origin: "dispatch", mode: "dispatch" });
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
    sessions: { get: (id) => drivers.get(id), ensure: async (id) => driverFor(id) },
    ...(opts.models === undefined ? {} : { models: () => opts.models! }),
    notifyFallback: (title, message) => { notifications.push({ title, message }); },
    log: () => {},
    defer: (fn) => { deferred.push(fn); },
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
  const childUpdates = () => dispatchLog().filter((e): e is Extract<SessionEvent, { type: "child_update" }> => e.type === "child_update");
  return {
    home, store, hub, drivers, driverFor, created, dispatchId, workDir, dc, deps, drain, finish, dispatchLog, childUpdates, notifications,
    refuse: (e: Error) => { refuseNext = e; },
  };
}

describe("session_spawn: the spawn", () => {
  test("creates a first-class CODE child linked to its coordinator, sends the prompt, and returns at once", async () => {
    const t = setup();
    const out = await t.dc.spawn(t.dispatchId, { dir: t.workDir, prompt: "  fix the build  ", title: "Build fix" });
    expect(t.created).toHaveLength(1);
    expect(t.created[0]).toMatchObject({ scope: "global", cwd: t.workDir, approvalPolicy: "auto", origin: "dispatch-child", mode: "code", parentSessionId: t.dispatchId });
    const childId = t.store.childrenOf(t.dispatchId)[0]!.sessionId;
    expect(out).toContain(`spawned session ${childId} ("Build fix") in ${t.workDir}`);
    expect(out).toContain("<child_update>");
    const meta = t.store.meta(childId);
    expect(meta).toMatchObject({ mode: "code", origin: "dispatch-child", parentSessionId: t.dispatchId, approvalPolicy: "auto", backgrounded: true });
    // The prompt went in through the child's own driver, under the dispatch client name — and the
    // spawn did not wait for the child's turn (it is still running).
    expect(t.driverFor(childId).sends).toEqual([{ text: "fix the build", clientName: DISPATCH_CLIENT_NAME }]);
    expect(t.driverFor(childId).turnRunning).toBe(true);
    expect(t.childUpdates().map((e) => ({ child: e.childSessionId, status: e.status, title: e.title }))).toEqual([{ child: childId, status: "running", title: "Build fix" }]);
    // The coordinator was NOT woken by the spawn itself.
    expect(t.driverFor(t.dispatchId).sends).toEqual([]);
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

  test("a first message that cannot be delivered is an error update and a tool error naming the child", async () => {
    const t = setup();
    const orig = t.deps.createSession()!;
    t.deps.createSession = () => async (input) => { const r = await orig(input); t.driverFor(r.sessionId).failNext = new Error("no credential"); return r; };
    const err = await t.dc.spawn(t.dispatchId, { dir: t.workDir, prompt: "p", title: "T" }).then(() => undefined, (e: Error) => e);
    const childId = t.store.childrenOf(t.dispatchId)[0]!.sessionId;
    expect(err?.message).toContain(`spawned session ${childId} ("T")`);
    expect(err?.message).toContain("no credential");
    expect(t.childUpdates().map((e) => e.status)).toEqual(["running", "error"]);
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
    // Without a spawner the def keeps its fixed line (a door nobody wired).
    const unwired = sessionsCapability({ sessionId: t.dispatchId, mode: "dispatch", cwd: t.home, roots: [t.home] }, { sessions: {} as never });
    const plain = await (unwired.instance as WinterMcpServerInstance).callTool("session_spawn", { dir: t.workDir, prompt: "go" }) as { content: Array<{ text: string }> };
    expect(plain.content[0]!.text).toBe("session_spawn is only available in the dispatch session.");
  });
});

describe("child_update progression and the relay", () => {
  test("approval and question events are mirrored onto the coordinator with childSessionId, and the status follows", async () => {
    const t = setup();
    await t.dc.spawn(t.dispatchId, { dir: t.workDir, prompt: "p", title: "Kid" });
    const child = t.store.childrenOf(t.dispatchId)[0]!.sessionId;
    t.hub.append(child, { type: "approval_requested", sessionId: child, threadId: "main", callId: "c1", toolName: "bash", summary: "rm x", issuedAt: 1, expiresAt: 2 });
    t.hub.append(child, { type: "approval_resolved", sessionId: child, threadId: "main", callId: "c1", approved: true, by: "mac" });
    t.hub.append(child, { type: "question_asked", sessionId: child, threadId: "main", callId: "q1", questions: [{ question: "Which?", header: "Pick", options: [{ label: "a", description: "" }, { label: "b", description: "" }], multiSelect: false }] });
    t.hub.append(child, { type: "question_resolved", sessionId: child, threadId: "main", callId: "q1", answers: { "Which?": "a" }, by: "mac" });
    const log = t.dispatchLog();
    const mirrored = log.filter((e) => ["approval_requested", "approval_resolved", "question_asked", "question_resolved"].includes(e.type));
    expect(mirrored.map((e) => [e.type, e.sessionId, (e as { childSessionId?: string }).childSessionId, (e as { callId: string }).callId])).toEqual([
      ["approval_requested", t.dispatchId, child, "c1"],
      ["approval_resolved", t.dispatchId, child, "c1"],
      ["question_asked", t.dispatchId, child, "q1"],
      ["question_resolved", t.dispatchId, child, "q1"],
    ]);
    expect(t.childUpdates().map((e) => e.status)).toEqual(["running", "awaiting_approval", "running", "awaiting_input", "running"]);
    // The coordinator's own events are never re-mirrored (loop safety): exactly four copies.
    expect(mirrored).toHaveLength(4);
  });

  test("a REAL bridge card from a dispatch child reaches the coordinator, and answering at the child's id resolves it", async () => {
    const t = setup();
    await t.dc.spawn(t.dispatchId, { dir: t.workDir, prompt: "p" });
    const child = t.store.childrenOf(t.dispatchId)[0]!.sessionId;
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
    // What `approval.respond {sessionId: childSessionId, callId}` does.
    approvals.resolve(child, "tu-1", true, "mac");
    expect((await pending)?.behavior).toBe("allow");
    const resolved = t.dispatchLog().find((e) => e.type === "approval_resolved") as { childSessionId?: string; approved: boolean } | undefined;
    expect(resolved).toMatchObject({ childSessionId: child, approved: true });
    expect(t.childUpdates().map((e) => e.status)).toEqual(["running", "awaiting_approval", "running"]);
  });

  test("an unattended coordinator gets a notification when a child needs input or finishes", async () => {
    const t = setup();
    await t.dc.spawn(t.dispatchId, { dir: t.workDir, prompt: "p", title: "Kid" });
    const child = t.store.childrenOf(t.dispatchId)[0]!.sessionId;
    t.hub.append(child, { type: "approval_requested", sessionId: child, threadId: "main", callId: "c1", toolName: "bash", summary: "s", issuedAt: 1, expiresAt: 2 });
    t.finish(child, { text: "done" });
    expect(t.notifications).toEqual([{ title: "Kid", message: "needs your approval" }, { title: "Kid", message: "finished" }]);
    expect(t.dispatchLog().filter((e) => e.type === "notification_requested")).toHaveLength(2);
    // Attached: no notification.
    const a = setup({ attached: true });
    await a.dc.spawn(a.dispatchId, { dir: a.workDir, prompt: "p" });
    a.finish(a.store.childrenOf(a.dispatchId)[0]!.sessionId, { text: "done" });
    expect(a.notifications).toEqual([]);
  });
});

describe("the completion wake", () => {
  test("a finished child posts its result and wakes an idle coordinator with a <child_update>", async () => {
    const t = setup();
    await t.dc.spawn(t.dispatchId, { dir: t.workDir, prompt: "p", title: "Kid" });
    const child = t.store.childrenOf(t.dispatchId)[0]!.sessionId;
    t.finish(child, { text: "All green. See /tmp/report.md" });
    const done = t.childUpdates().at(-1)!;
    expect(done).toMatchObject({ childSessionId: child, status: "completed", title: "Kid", resultSummary: "All green. See /tmp/report.md" });
    expect(t.driverFor(t.dispatchId).sends).toEqual([]); // deferred to a macrotask
    await t.drain();
    const wake = t.driverFor(t.dispatchId).sends;
    expect(wake).toHaveLength(1);
    expect(wake[0]!.clientName).toBe(DISPATCH_CLIENT_NAME);
    expect(wake[0]!.text).toContain("<child_update>");
    expect(wake[0]!.text).toContain(`session: ${child}`);
    expect(wake[0]!.text).toContain("status: completed");
    expect(wake[0]!.text).toContain("All green. See /tmp/report.md");
    expect(wake[0]!.text).toContain("No other child sessions are working.");
  });

  test("an error turn is reported as error; a stopped turn as completed, saying it was stopped", async () => {
    const t = setup();
    await t.dc.spawn(t.dispatchId, { dir: t.workDir, prompt: "p1", title: "A" });
    await t.dc.spawn(t.dispatchId, { dir: t.workDir, prompt: "p2", title: "B" });
    const [a, b] = t.store.childrenOf(t.dispatchId).map((r) => r.sessionId);
    t.finish(a!, { error: "provider 500" });
    t.finish(b!, { text: "halfway", aborted: true });
    const ups = t.childUpdates();
    expect(ups.find((e) => e.childSessionId === a && e.status !== "running")).toMatchObject({ status: "error" });
    expect(ups.find((e) => e.childSessionId === b && e.status !== "running")).toMatchObject({ status: "completed", resultSummary: "Stopped before it finished. Its last message: halfway" });
  });

  test("COALESCING: children finishing while the coordinator works wake it ONCE, at its turn's end", async () => {
    const t = setup();
    await t.dc.spawn(t.dispatchId, { dir: t.workDir, prompt: "p1", title: "A" });
    await t.dc.spawn(t.dispatchId, { dir: t.workDir, prompt: "p2", title: "B" });
    await t.dc.spawn(t.dispatchId, { dir: t.workDir, prompt: "p3", title: "C" });
    const [a, b, c] = t.store.childrenOf(t.dispatchId).map((r) => r.sessionId);
    t.driverFor(t.dispatchId).turnRunning = true; // the coordinator is mid-turn
    t.finish(a!, { text: "A done" });
    t.finish(b!, { text: "B done" });
    await t.drain();
    expect(t.driverFor(t.dispatchId).sends).toEqual([]);
    t.finish(t.dispatchId, { text: "coordinator turn ends" });
    await t.drain();
    const sends = t.driverFor(t.dispatchId).sends;
    expect(sends).toHaveLength(1);
    expect(sends[0]!.text).toContain(`session: ${a}`);
    expect(sends[0]!.text).toContain(`session: ${b}`);
    expect(sends[0]!.text.match(/<child_update>/g)).toHaveLength(2);
    // The child still at work is listed as the roster.
    expect(sends[0]!.text).toContain(`Still working:\n- ${c} "C"`);
  });

  test("COALESCING: children finishing in the same tick while the coordinator is idle wake it once", async () => {
    const t = setup();
    await t.dc.spawn(t.dispatchId, { dir: t.workDir, prompt: "p1" });
    await t.dc.spawn(t.dispatchId, { dir: t.workDir, prompt: "p2" });
    const [a, b] = t.store.childrenOf(t.dispatchId).map((r) => r.sessionId);
    t.finish(a!, { text: "one" });
    t.finish(b!, { text: "two" });
    await t.drain();
    expect(t.driverFor(t.dispatchId).sends).toHaveLength(1);
    expect(t.driverFor(t.dispatchId).sends[0]!.text.match(/<child_update>/g)).toHaveLength(2);
  });

  test("a resumable coordinator is resumed for the wake (ensure), like any inbound message", async () => {
    const t = setup();
    await t.dc.spawn(t.dispatchId, { dir: t.workDir, prompt: "p" });
    const child = t.store.childrenOf(t.dispatchId)[0]!.sessionId;
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
    await t.dc.spawn(t.dispatchId, { dir: t.workDir, prompt: "p" });
    const child = t.store.childrenOf(t.dispatchId)[0]!.sessionId;
    t.finish(child, { text: "ok" });
    const before = t.childUpdates().length;
    t.dc.onTurnSettled(child); // the idle timer ended its child
    expect(t.childUpdates().length).toBe(before);
  });

  test("stop(): a draining child's last settle reports nothing and wakes nobody", async () => {
    const t = setup();
    await t.dc.spawn(t.dispatchId, { dir: t.workDir, prompt: "p" });
    const child = t.store.childrenOf(t.dispatchId)[0]!.sessionId;
    t.dc.stop();
    t.finish(child, { aborted: true });
    await t.drain();
    expect(t.childUpdates().map((e) => e.status)).toEqual(["running"]);
    expect(t.driverFor(t.dispatchId).sends).toEqual([]);
  });
});

describe("the bounded roster and restart recovery", () => {
  test("a reported child is forgotten when the coordinator's wake turn ends — and tracked again when it runs again", async () => {
    const t = setup();
    await t.dc.spawn(t.dispatchId, { dir: t.workDir, prompt: "p", title: "Kid" });
    const child = t.store.childrenOf(t.dispatchId)[0]!.sessionId;
    t.finish(child, { text: "first" });
    await t.drain();
    expect(t.dc.roster().map((r) => r.sessionId)).toEqual([child]);
    t.finish(t.dispatchId, { text: "reported it" }); // the wake turn ends
    expect(t.dc.roster()).toEqual([]);
    // The user sends the child another message; its next result still reaches Dispatch.
    await t.driverFor(child).send("more please", "mac");
    expect(t.dc.roster().map((r) => ({ id: r.sessionId, status: r.status }))).toEqual([{ id: child, status: "running" }]);
    t.finish(child, { text: "second" });
    await t.drain();
    expect(t.childUpdates().at(-1)).toMatchObject({ childSessionId: child, status: "completed", resultSummary: "second" });
    expect(t.driverFor(t.dispatchId).sends.at(-1)!.text).toContain("second");
  });

  test("restart: an in-flight child is closed on the coordinator's log; the session stays; its next run is reported", async () => {
    const t = setup();
    await t.dc.spawn(t.dispatchId, { dir: t.workDir, prompt: "p", title: "Long job" });
    const child = t.store.childrenOf(t.dispatchId)[0]!.sessionId;
    t.hub.append(child, { type: "approval_requested", sessionId: child, threadId: "main", callId: "c1", toolName: "bash", summary: "s", issuedAt: 1, expiresAt: 2 });
    // The daemon stops mid-turn.
    t.dc.stop();
    // A new process over the same store.
    const store2 = new SessionStore(t.home);
    const hub2 = new SessionHub(store2);
    const sends: string[] = [];
    const deferred: Array<() => void> = [];
    const fake = { turnRunning: false, send: async (text: string) => { sends.push(text); return { seq: 0, queued: false }; } };
    const dc2 = new DispatchChildren({
      store: store2, hub: hub2, createSession: () => undefined,
      sessions: { get: () => fake, ensure: async () => fake },
      log: () => {}, defer: (fn) => { deferred.push(fn); },
    });
    dc2.start();
    const ups = store2.read(t.dispatchId).filter((e) => e.type === "child_update") as Array<Extract<SessionEvent, { type: "child_update" }>>;
    expect(ups.at(-1)).toMatchObject({ childSessionId: child, status: "error", title: "Long job" });
    expect(ups.at(-1)!.resultSummary).toContain("Winter restarted while this session was working");
    // The child is still a first-class session of the coordinator.
    expect(store2.childrenOf(t.dispatchId).map((r) => r.sessionId)).toEqual([child]);
    // A second boot does not close it again.
    const again = new DispatchChildren({ store: store2, hub: hub2, createSession: () => undefined, sessions: { get: () => fake, ensure: async () => fake }, log: () => {} });
    again.start(); again.stop();
    expect((store2.read(t.dispatchId).filter((e) => e.type === "child_update")).length).toBe(ups.length);
    // The user resumes the child: it is picked up from its stored link and reported.
    hub2.append(child, { type: "turn_started", sessionId: child, threadId: "main" });
    hub2.append(child, { type: "assistant_message", sessionId: child, threadId: "main", text: "resumed and done" });
    dc2.onTurnSettled(child);
    for (const fn of deferred.splice(0)) fn();
    await new Promise((r) => setTimeout(r, 0));
    expect(sends).toHaveLength(1);
    expect(sends[0]).toContain("resumed and done");
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
