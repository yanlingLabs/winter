import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEvent } from "@norma/protocol";
import { SessionStore } from "../../src/sessions/store";
import { SessionHub } from "../../src/sessions/hub";
import { DispatchChildren } from "../../src/agent/dispatch-children";
import { ToolRegistry } from "../../src/agent/tools/registry";
import { registerWriteTools } from "../../src/agent/tools/fs-write";
import { registerAskUserTool } from "../../src/agent/tools/ask-user";
import { PermissionGate } from "../../src/agent/gate";
import { ApprovalBroker } from "../../src/agent/approvals";
import { QuestionBroker } from "../../src/agent/questions";
import { AgentEngine } from "../../src/agent/engine";
import { FakeProvider } from "../../src/agent/fake-provider";
import { SessionDirectories } from "../../src/agent/dirs";
import { ContextAssembler } from "../../src/agent/context";
import { TrustStore } from "../../src/agent/trust";
import { SkillStore } from "../../src/agent/skills";
import { Compactor } from "../../src/agent/compactor";
import type { ProviderEvent } from "../../src/providers/types";
import type { BashReviewer } from "../../src/agent/reviewer";
import { stubRegistry, bashTurn, stubReviewer } from "./engine-reviewer.test";

// Task 6 (Dispatch mode, Phase 7): approval/question relay — a dispatch child's approval_requested/
// approval_resolved/question_asked/question_resolved events mirror INTO the dispatch stream (so a
// client attached ONLY to the dispatch session still sees/answers a child's prompt), and a
// dispatch-child's approval window widens to 10 minutes (questions: effectively indefinite) since
// there's no live human necessarily watching the child directly. Two independent surfaces exercised
// here: (A) DispatchChildren.onEvent's new mirror() calls (real SessionStore+SessionHub, fake
// runTurn/interrupt — same harness as dispatch-children.test.ts); (B) AgentEngine's timeout
// computation for a session whose meta.origin === "dispatch-child" (real engine harness, spied
// broker/questions.wait — same shape as engine.test.ts's "approval timeout auto-denies").

// ---------------------------------------------------------------------------------------------
// Part A: DispatchChildren mirroring
// ---------------------------------------------------------------------------------------------

function setupRegistry() {
  const home = mkdtempSync(join(tmpdir(), "norma-dispatch-relay-home-"));
  const store = new SessionStore(home);
  const hub = new SessionHub(store);
  const registry = new DispatchChildren({
    store,
    hub,
    runTurn: async () => {},
    isRunning: () => false,
    interrupt: () => {},
  });
  return { store, hub, registry };
}

function readDispatch(store: SessionStore, dispatchId: string): SessionEvent[] {
  return store.read(dispatchId, 0);
}

describe("Task 6: dispatch relay — mirror-in", () => {
  test("approval_requested on a tracked child mirrors into the dispatch stream", () => {
    const { store, hub, registry } = setupRegistry();
    const dispatchId = store.createSession("global", { mode: "dispatch" });
    const childId = registry.spawnChild({ dispatchSessionId: dispatchId, dir: "/tmp/a", prompt: "do work", title: "Task A" });
    registry.start();

    hub.append(childId, {
      type: "approval_requested", sessionId: childId, threadId: "main",
      callId: "c1", toolName: "bash", summary: "rm -rf x", issuedAt: 1781270000000, expiresAt: 1781270300000,
    });

    const mirrored = readDispatch(store, dispatchId).find((e) => e.type === "approval_requested");
    expect(mirrored).toBeDefined();
    expect(mirrored).toMatchObject({
      sessionId: dispatchId, threadId: "main", callId: "c1", toolName: "bash", summary: "rm -rf x",
      childSessionId: childId,
    });
  });

  test("question_asked on a tracked child mirrors into the dispatch stream (questions array copied verbatim)", () => {
    const { store, hub, registry } = setupRegistry();
    const dispatchId = store.createSession("global", { mode: "dispatch" });
    const childId = registry.spawnChild({ dispatchSessionId: dispatchId, dir: "/tmp/a", prompt: "do work", title: "Task A" });
    registry.start();

    const questions = [{ question: "which?", header: "Choice", options: [{ label: "A" }, { label: "B" }], multiSelect: false }];
    hub.append(childId, { type: "question_asked", sessionId: childId, threadId: "main", callId: "q1", questions });

    const mirrored = readDispatch(store, dispatchId).find((e) => e.type === "question_asked");
    expect(mirrored).toBeDefined();
    expect(mirrored).toMatchObject({ sessionId: dispatchId, threadId: "main", callId: "q1", childSessionId: childId });
    expect((mirrored as unknown as { questions: unknown }).questions).toEqual(questions);
  });
});

describe("Task 6: dispatch relay — mirror-back", () => {
  test("approval_resolved on a tracked child mirrors back into the dispatch stream", () => {
    const { store, hub, registry } = setupRegistry();
    const dispatchId = store.createSession("global", { mode: "dispatch" });
    const childId = registry.spawnChild({ dispatchSessionId: dispatchId, dir: "/tmp/a", prompt: "do work", title: "Task A" });
    registry.start();

    hub.append(childId, {
      type: "approval_requested", sessionId: childId, threadId: "main",
      callId: "c1", toolName: "bash", summary: "rm -rf x", issuedAt: 1781270000000, expiresAt: 1781270300000,
    });
    hub.append(childId, { type: "approval_resolved", sessionId: childId, threadId: "main", callId: "c1", approved: true, by: "orb" });

    const mirrored = readDispatch(store, dispatchId).find((e) => e.type === "approval_resolved");
    expect(mirrored).toBeDefined();
    expect(mirrored).toMatchObject({
      sessionId: dispatchId, threadId: "main", callId: "c1", approved: true, by: "orb", childSessionId: childId,
    });
  });

  test("question_resolved on a tracked child mirrors back with answers/by/childSessionId", () => {
    const { store, hub, registry } = setupRegistry();
    const dispatchId = store.createSession("global", { mode: "dispatch" });
    const childId = registry.spawnChild({ dispatchSessionId: dispatchId, dir: "/tmp/a", prompt: "do work", title: "Task A" });
    registry.start();

    hub.append(childId, {
      type: "question_asked", sessionId: childId, threadId: "main", callId: "q1",
      questions: [{ question: "which?", header: "Choice", options: [{ label: "A" }, { label: "B" }], multiSelect: false }],
    });
    hub.append(childId, { type: "question_resolved", sessionId: childId, threadId: "main", callId: "q1", answers: { "which?": "A" }, by: "user" });

    const mirrored = readDispatch(store, dispatchId).find((e) => e.type === "question_resolved");
    expect(mirrored).toBeDefined();
    expect(mirrored).toMatchObject({
      sessionId: dispatchId, threadId: "main", callId: "q1", answers: { "which?": "A" }, by: "user", childSessionId: childId,
    });
  });
});

describe("Task 6: dispatch relay — no loops", () => {
  test("a mirrored event (lives in the dispatch stream, sessionId=dispatchId) is not re-mirrored", () => {
    const { store, hub, registry } = setupRegistry();
    const dispatchId = store.createSession("global", { mode: "dispatch" });
    const childId = registry.spawnChild({ dispatchSessionId: dispatchId, dir: "/tmp/a", prompt: "do work", title: "Task A" });
    registry.start();

    hub.append(childId, {
      type: "approval_requested", sessionId: childId, threadId: "main",
      callId: "c1", toolName: "bash", summary: "rm -rf x", issuedAt: 1781270000000, expiresAt: 1781270300000,
    });

    // Appending the mirror (sessionId=dispatchId) itself passes back through the SAME observer
    // (hub.append notifies observers for every appended event, mirrored copies included) — the
    // guard (`sessionId` not a tracked child) must stop it there. Exactly one copy, not two.
    const dispatchApprovals = readDispatch(store, dispatchId).filter((e) => e.type === "approval_requested");
    expect(dispatchApprovals.length).toBe(1);
  });

  test("the dispatch session's OWN approval_requested (not a tracked child's) is never mirrored", () => {
    const { store, hub, registry } = setupRegistry();
    const dispatchId = store.createSession("global", { mode: "dispatch" });
    registry.start(); // no children tracked at all

    hub.append(dispatchId, {
      type: "approval_requested", sessionId: dispatchId, threadId: "main",
      callId: "own1", toolName: "bash", summary: "dispatch session's own tool call", issuedAt: 1781270000000, expiresAt: 1781270300000,
    });

    const approvals = readDispatch(store, dispatchId).filter((e) => e.type === "approval_requested");
    expect(approvals.length).toBe(1); // the original append only — no mirrored duplicate
    expect(approvals[0]).not.toHaveProperty("childSessionId");
  });
});

// ---------------------------------------------------------------------------------------------
// Part B: Engine-level timeout windows — a dispatch-child session's approval/question waits get
// wider windows than an ordinary session's. bun:test has no fake-timer "advance" primitive (only
// setSystemTime, which fakes Date.now() but not real setTimeout scheduling), so rather than
// literally waiting out a 10-minute or ~24.8-day window, these spy on ApprovalBroker.wait /
// QuestionBroker.wait to capture the EXACT timeoutMs the engine computed and passed in — the same
// "injected clock/spy" technique the brief calls for, applied to a value too large to literally
// wait out (mirrors engine.test.ts's real-timeout approach for the SHORT, waitable defaults).
// ---------------------------------------------------------------------------------------------

function setupEngine(script: ProviderEvent[][], opts: {
  origin?: string; questions?: boolean; approvalTimeoutMs?: number;
  // whole-branch fix wave (reviewer-escalation window): opts.registry lets the reviewer-escalation
  // tests below supply a registry with a stub bash tool registered (stubRegistry(), same helper
  // engine-reviewer.test.ts's own bash-review tests use) on top of the write/ask-user tools this
  // helper always registers; opts.reviewer/opts.approvalPolicy thread straight into the engine/
  // session, same shape as engine-steer.test.ts's own setupEngine.
  registry?: ToolRegistry; reviewer?: BashReviewer; approvalPolicy?: "ask" | "auto" | "plan";
} = {}) {
  const home = mkdtempSync(join(tmpdir(), "norma-dispatch-relay-engine-"));
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "norma-dispatch-relay-engine-cwd-")));
  const store = new SessionStore(home);
  const hub = new SessionHub(store);
  const registry = opts.registry ?? new ToolRegistry();
  registerWriteTools(registry);
  if (opts.questions) registerAskUserTool(registry);
  const questions = opts.questions ? new QuestionBroker() : undefined;
  const broker = new ApprovalBroker();
  const provider = new FakeProvider(script);
  const dirs = new SessionDirectories(() => [cwd]);
  const assemblerHome = mkdtempSync(join(tmpdir(), "norma-dispatch-relay-actx-"));
  const assemblerTrust = new TrustStore(join(assemblerHome, "trust.json"));
  const assembler = new ContextAssembler({ normaHome: assemblerHome, trust: assemblerTrust, skills: new SkillStore({ normaHome: assemblerHome, trust: assemblerTrust }) });
  const compactor = new Compactor({ provider: { provider, model: "fake-1" }, store, hub });
  const engine = new AgentEngine({
    store, hub, registry, broker,
    gate: new PermissionGate(),
    provider: { provider, model: "fake-1" },
    dirs,
    approvalTimeoutMs: opts.approvalTimeoutMs,
    assembler,
    compactor,
    questions,
    reviewer: opts.reviewer,
  });
  const sessionId = store.createSession("global", { cwd, approvalPolicy: opts.approvalPolicy ?? "ask", origin: opts.origin });
  return { engine, store, hub, broker, questions, sessionId, cwd, provider };
}

const done = (reason: "end_turn" | "tool_calls"): ProviderEvent => ({ type: "done", stopReason: reason });
const text = (t: string): ProviderEvent[] => [{ type: "text_delta", delta: t }, { type: "usage", inputTokens: 10, outputTokens: 2 }, done("end_turn")];

const askArgs = {
  questions: [{
    question: "which?", header: "Choice",
    options: [{ label: "A", description: "Option A" }, { label: "B", description: "Option B" }], multiSelect: false,
  }],
};

describe("Task 6: engine timeout windows — approvals", () => {
  test("dispatch-child session: requestApproval waits 600_000ms regardless of cfg.approvalTimeoutMs", async () => {
    const { engine, broker, sessionId } = setupEngine([
      [{ type: "tool_call", callId: "c1", name: "write", argsJson: '{"path":"x.txt","content":"y"}' }, done("tool_calls")],
      text("ok"),
    ], { origin: "dispatch-child", approvalTimeoutMs: 45_000 });
    const waitSpy = spyOn(broker, "wait").mockResolvedValue({ approved: true, by: "test" });
    await engine.runTurn(sessionId);
    expect(waitSpy).toHaveBeenCalledWith(sessionId, "c1", 600_000, expect.anything());
  });

  test("non-child session: requestApproval waits cfg.approvalTimeoutMs when configured", async () => {
    const { engine, broker, sessionId } = setupEngine([
      [{ type: "tool_call", callId: "c1", name: "write", argsJson: '{"path":"x.txt","content":"y"}' }, done("tool_calls")],
      text("ok"),
    ], { approvalTimeoutMs: 45_000 });
    const waitSpy = spyOn(broker, "wait").mockResolvedValue({ approved: true, by: "test" });
    await engine.runTurn(sessionId);
    expect(waitSpy).toHaveBeenCalledWith(sessionId, "c1", 45_000, expect.anything());
  });

  test("non-child session: requestApproval falls back to the 5-minute default when cfg.approvalTimeoutMs is unset", async () => {
    const { engine, broker, sessionId } = setupEngine([
      [{ type: "tool_call", callId: "c1", name: "write", argsJson: '{"path":"x.txt","content":"y"}' }, done("tool_calls")],
      text("ok"),
    ]);
    const waitSpy = spyOn(broker, "wait").mockResolvedValue({ approved: true, by: "test" });
    await engine.runTurn(sessionId);
    expect(waitSpy).toHaveBeenCalledWith(sessionId, "c1", 300_000, expect.anything());
  });
});

describe("Task 6: engine timeout windows — questions", () => {
  test("dispatch-child session: ask_user waits 2**31-1 ms (indefinite), not the 300s default", async () => {
    const { engine, questions, sessionId } = setupEngine([
      [{ type: "tool_call", callId: "q1", name: "ask_user", argsJson: JSON.stringify(askArgs) }, done("tool_calls")],
      text("ok"),
    ], { origin: "dispatch-child", questions: true });
    const waitSpy = spyOn(questions!, "wait").mockResolvedValue({ answers: { "which?": "A" }, by: "test" });
    await engine.runTurn(sessionId);
    expect(waitSpy).toHaveBeenCalledWith(sessionId, "q1", 2 ** 31 - 1);
  });

  test("non-child session: ask_user still waits NORMA_ASK_TIMEOUT_MS ?? 300_000", async () => {
    const { engine, questions, sessionId } = setupEngine([
      [{ type: "tool_call", callId: "q1", name: "ask_user", argsJson: JSON.stringify(askArgs) }, done("tool_calls")],
      text("ok"),
    ], { questions: true });
    const waitSpy = spyOn(questions!, "wait").mockResolvedValue({ answers: { "which?": "A" }, by: "test" });
    await engine.runTurn(sessionId);
    expect(waitSpy).toHaveBeenCalledWith(sessionId, "q1", 300_000);
  });
});

// ---------------------------------------------------------------------------------------------
// Whole-branch fix wave: reviewer-escalation approvals (engine.ts's reviewAndDispatch, the
// safety-reviewer's ask-a-human path for an "unsafe"/"error" verdict) previously hardcoded
// `NORMA_REVIEW_APPROVAL_TIMEOUT_MS ?? 60_000` for EVERY session, dispatch children included —
// meaning an unattended dispatch child got the SHORTEST approval window on the HIGHEST-risk path
// (reviewer flagged the call as unsafe), contradicting the 10-minute relay window every OTHER
// approval site (Part B above) already gives a dispatch child. Fixed the same way: for
// meta.origin === "dispatch-child", the window floors at 600_000ms (env can still widen beyond
// it, never narrow below it); the denial message must say the REAL window, not a hardcoded "60s".
// Same spy-on-wait technique as Part B (bun:test has no fake-timer advance primitive).
// ---------------------------------------------------------------------------------------------
describe("Task 6/whole-branch fix: reviewer-escalation timeout window", () => {
  test("dispatch-child session: reviewer-escalation approval waits 600_000ms (env unset)", async () => {
    const { registry } = stubRegistry();
    const reviewer = stubReviewer({ verdict: "unsafe", reason: "REASON_SENTINEL" });
    const { engine, broker, sessionId } = setupEngine(bashTurn("rm -rf x"), {
      origin: "dispatch-child", reviewer: reviewer as any, approvalPolicy: "auto", registry,
    });
    const waitSpy = spyOn(broker, "wait").mockResolvedValue({ approved: true, by: "test" });
    await engine.runTurn(sessionId);
    expect(waitSpy).toHaveBeenCalledWith(sessionId, "c1", 600_000, expect.anything());
  });

  test("non-child session: reviewer-escalation approval still waits 60_000ms (env unset) — unchanged behavior", async () => {
    const { registry } = stubRegistry();
    const reviewer = stubReviewer({ verdict: "unsafe", reason: "REASON_SENTINEL" });
    const { engine, broker, sessionId } = setupEngine(bashTurn("rm -rf x"), {
      reviewer: reviewer as any, approvalPolicy: "auto", registry,
    });
    const waitSpy = spyOn(broker, "wait").mockResolvedValue({ approved: true, by: "test" });
    await engine.runTurn(sessionId);
    expect(waitSpy).toHaveBeenCalledWith(sessionId, "c1", 60_000, expect.anything());
  });

  test("dispatch-child session: denial message states the REAL window (600s), not the hardcoded 60s", async () => {
    const { registry } = stubRegistry();
    const reviewer = stubReviewer({ verdict: "unsafe", reason: "REASON_SENTINEL" });
    const { engine, broker, store, sessionId } = setupEngine(bashTurn("rm -rf x"), {
      origin: "dispatch-child", reviewer: reviewer as any, approvalPolicy: "auto", registry,
    });
    spyOn(broker, "wait").mockResolvedValue({ approved: false, by: "timeout" });
    await engine.runTurn(sessionId);
    const result = store.read(sessionId).find((e) => e.type === "tool_result") as any;
    expect(result.output).toContain("No approval within 600s.");
    expect(result.output).not.toContain("No approval within 60s.");
  });
});
