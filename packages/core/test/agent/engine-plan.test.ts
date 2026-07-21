import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../../src/sessions/store";
import { SessionHub, type HubClient } from "../../src/sessions/hub";
import { ToolRegistry } from "../../src/agent/tools/registry";
import { registerWriteTools } from "../../src/agent/tools/fs-write";
import { registerPlanTool } from "../../src/agent/tools/plan";
import { PermissionGate, type SessionApprovalPolicy } from "../../src/agent/gate";
import { ApprovalBroker } from "../../src/agent/approvals";
import { PlanBroker } from "../../src/agent/plans";
import { AgentEngine } from "../../src/agent/engine";
import { FakeProvider } from "../../src/agent/fake-provider";
import { SessionDirectories } from "../../src/agent/dirs";
import { ContextAssembler } from "../../src/agent/context";
import { TrustStore } from "../../src/agent/trust";
import { SkillStore } from "../../src/agent/skills";
import { Compactor } from "../../src/agent/compactor";
import type { ProviderEvent } from "../../src/providers/types";

function setup(
  script: ProviderEvent[][],
  opts: { plans?: boolean; approvalPolicy?: SessionApprovalPolicy } = {},
) {
  const withPlans = opts.plans !== false;
  const home = mkdtempSync(join(tmpdir(), "norma-engine-plan-"));
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "norma-engine-plan-cwd-")));
  const store = new SessionStore(home);
  const hub = new SessionHub(store);
  const registry = new ToolRegistry();
  registerWriteTools(registry);
  registerPlanTool(registry);
  const plans = withPlans ? new PlanBroker() : undefined;
  const setPolicyCalls: Array<{ sessionId: string; policy: SessionApprovalPolicy }> = [];
  const setPolicy = (sessionId: string, policy: SessionApprovalPolicy) => {
    setPolicyCalls.push({ sessionId, policy });
    store.setApprovalPolicy(sessionId, policy);
  };
  const broker = new ApprovalBroker();
  const provider = new FakeProvider(script);
  const dirs = new SessionDirectories(() => [cwd]);
  const assemblerHome = mkdtempSync(join(tmpdir(), "norma-engine-plan-actx-"));
  const assemblerTrust = new TrustStore(join(assemblerHome, "trust.json"));
  const assembler = new ContextAssembler({
    normaHome: assemblerHome,
    trust: assemblerTrust,
    skills: new SkillStore({ normaHome: assemblerHome, trust: assemblerTrust }),
  });
  const compactor = new Compactor({ provider: { provider, model: "fake-1" }, store, hub });
  const engine = new AgentEngine({
    store, hub, registry, broker,
    gate: new PermissionGate(),
    provider: { provider, model: "fake-1" },
    dirs,
    approvalTimeoutMs: 500,
    assembler,
    compactor,
    plans,
    setPolicy,
  });
  const sessionId = store.createSession("global", { cwd, approvalPolicy: opts.approvalPolicy ?? "plan" });
  return { engine, store, hub, broker, plans, setPolicyCalls, sessionId, cwd, provider };
}

const done = (reason: "end_turn" | "tool_calls"): ProviderEvent => ({ type: "done", stopReason: reason });
const text = (t: string): ProviderEvent[] => [{ type: "text_delta", delta: t }, { type: "usage", inputTokens: 10, outputTokens: 2 }, done("end_turn")];

describe("AgentEngine: plan mode (deny + exit_plan_mode bridge)", () => {
  test("deny: a write in plan mode → block message, run NOT called", async () => {
    const { engine, store, sessionId, cwd } = setup([
      [{ type: "tool_call", callId: "w1", name: "write", argsJson: JSON.stringify({ path: "f.txt", content: "x" }) }, done("tool_calls")],
      text("ok"),
    ]);
    await engine.runTurn(sessionId);
    const events = store.read(sessionId);
    const result = events.find((e) => e.type === "tool_result" && e.callId === "w1");
    expect(result).toMatchObject({ isError: true });
    expect((result as any).output).toContain("Blocked in plan mode");
    expect(existsSync(join(cwd, "f.txt"))).toBe(false); // the write tool's run() was never called
  });

  test("exit_plan_mode approve (autoAccept) → plan_resolved + setPolicy('auto') + same-turn follow-up write allowed", async () => {
    const { engine, store, hub, sessionId, cwd, setPolicyCalls, plans } = setup([
      [{ type: "tool_call", callId: "e1", name: "exit_plan_mode", argsJson: JSON.stringify({ plan: "Step 1: do the thing" }) }, done("tool_calls")],
      [{ type: "tool_call", callId: "w1", name: "write", argsJson: JSON.stringify({ path: "f.txt", content: "x" }) }, done("tool_calls")],
      text("done"),
    ]);
    // Sync watcher responds as soon as it observes plan_presented — only succeeds (rather than
    // timing out) if PlanBroker.wait() was registered BEFORE the emit.
    const watcher: HubClient = {
      clientName: "planner",
      deliver(e) {
        if (e.type === "plan_presented") plans!.respond(sessionId, e.callId, { approved: true, autoAccept: true }, "test");
        return true;
      },
    };
    hub.attach(watcher, sessionId, 0);
    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    const presented = events.find((e) => e.type === "plan_presented");
    expect(presented).toMatchObject({ callId: "e1", plan: "Step 1: do the thing" });
    const resolved = events.find((e) => e.type === "plan_resolved");
    expect(resolved).toMatchObject({ callId: "e1", approved: true, autoAccept: true, by: "test" });

    expect(setPolicyCalls).toEqual([{ sessionId, policy: "auto" }]);

    const exitResult = events.find((e) => e.type === "tool_result" && e.callId === "e1");
    expect(exitResult).toMatchObject({ isError: false });
    expect((exitResult as any).output).toContain("approved");
    expect((exitResult as any).output).toContain("auto-accept edits: on");

    // Same-turn follow-up write must be ALLOWED (the local meta.approvalPolicy mutation), not denied.
    const writeResult = events.find((e) => e.type === "tool_result" && e.callId === "w1");
    expect(writeResult).toMatchObject({ isError: false });
    expect(existsSync(join(cwd, "f.txt"))).toBe(true);
  });

  test("reject with feedback → revise message (isError false), policy unchanged, follow-up write still denied", async () => {
    const { engine, store, hub, sessionId, cwd, setPolicyCalls, plans } = setup([
      [{ type: "tool_call", callId: "e1", name: "exit_plan_mode", argsJson: JSON.stringify({ plan: "Step 1: do the thing" }) }, done("tool_calls")],
      [{ type: "tool_call", callId: "w1", name: "write", argsJson: JSON.stringify({ path: "f.txt", content: "x" }) }, done("tool_calls")],
      text("ok"),
    ]);
    const watcher: HubClient = {
      clientName: "planner",
      deliver(e) {
        if (e.type === "plan_presented") plans!.respond(sessionId, e.callId, { approved: false, feedback: "not detailed enough", autoAccept: false }, "test");
        return true;
      },
    };
    hub.attach(watcher, sessionId, 0);
    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    const resolved = events.find((e) => e.type === "plan_resolved");
    expect(resolved).toMatchObject({ callId: "e1", approved: false, autoAccept: false, feedback: "not detailed enough", by: "test" });

    const exitResult = events.find((e) => e.type === "tool_result" && e.callId === "e1");
    expect(exitResult).toMatchObject({ isError: false });
    expect((exitResult as any).output).toContain("Plan rejected: not detailed enough");
    expect((exitResult as any).output).toContain("revise your plan");

    expect(setPolicyCalls).toEqual([]); // policy unchanged

    // Follow-up write in the same turn is still denied — the session is still in plan mode.
    const writeResult = events.find((e) => e.type === "tool_result" && e.callId === "w1");
    expect(writeResult).toMatchObject({ isError: true });
    expect((writeResult as any).output).toContain("Blocked in plan mode");
    expect(existsSync(join(cwd, "f.txt"))).toBe(false);
  });

  test("reject without feedback → 'without specific feedback' message (isError false), policy unchanged", async () => {
    const { engine, store, hub, sessionId, setPolicyCalls, plans } = setup([
      [{ type: "tool_call", callId: "e1", name: "exit_plan_mode", argsJson: JSON.stringify({ plan: "Step 1: do the thing" }) }, done("tool_calls")],
      text("ok"),
    ]);
    const watcher: HubClient = {
      clientName: "test-client",
      deliver(e) {
        if (e.type === "plan_presented") plans!.respond(sessionId, e.callId, { approved: false, autoAccept: false }, "test-client");
        return true;
      },
    };
    hub.attach(watcher, sessionId, 0);
    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    const resolved = events.find((e) => e.type === "plan_resolved");
    expect(resolved).toMatchObject({ callId: "e1", approved: false, autoAccept: false, by: "test-client" });

    const exitResult = events.find((e) => e.type === "tool_result" && e.callId === "e1");
    expect(exitResult).toMatchObject({ isError: false });
    expect((exitResult as any).output).toContain("Plan rejected: the user rejected the plan without specific feedback");
    expect((exitResult as any).output).toContain("revise your plan");

    expect(setPolicyCalls).toEqual([]); // policy unchanged
  });

  test("timeout → 'did not respond within the time limit' message (isError false)", async () => {
    const prev = process.env.NORMA_PLAN_TIMEOUT_MS;
    process.env.NORMA_PLAN_TIMEOUT_MS = "50";
    try {
      const { engine, store, sessionId, setPolicyCalls } = setup([
        [{ type: "tool_call", callId: "e1", name: "exit_plan_mode", argsJson: JSON.stringify({ plan: "Step 1: do the thing" }) }, done("tool_calls")],
        text("ok"),
      ]);
      // No watcher — the plan is left unanswered and must time out via the broker itself.
      await engine.runTurn(sessionId);
      const events = store.read(sessionId);
      const resolved = events.find((e) => e.type === "plan_resolved");
      expect(resolved).toMatchObject({ callId: "e1", approved: false, autoAccept: false, by: "timeout" });
      const exitResult = events.find((e) => e.type === "tool_result" && e.callId === "e1");
      expect(exitResult).toMatchObject({ isError: false });
      expect((exitResult as any).output).toContain("Plan rejected: no response — the user did not respond within the time limit");
      expect((exitResult as any).output).toContain("revise your plan");
      expect(setPolicyCalls).toEqual([]);
    } finally {
      if (prev === undefined) delete process.env.NORMA_PLAN_TIMEOUT_MS;
      else process.env.NORMA_PLAN_TIMEOUT_MS = prev;
    }
  });

  test("plan-mode reminder present in instructions iff policy plan", async () => {
    const { engine: enginePlan, sessionId: sidPlan, provider: providerPlan } = setup([text("ok")], { approvalPolicy: "plan" });
    await enginePlan.runTurn(sidPlan);
    expect(providerPlan.requests[0]?.instructions ?? "").toContain("# Plan mode");

    const { engine: engineAsk, sessionId: sidAsk, provider: providerAsk } = setup([text("ok")], { approvalPolicy: "ask" });
    await engineAsk.runTurn(sidAsk);
    expect(providerAsk.requests[0]?.instructions ?? "").not.toContain("# Plan mode");
  });

  test("cfg.plans absent → exit_plan_mode returns the placeholder (no bridge)", async () => {
    const { engine, store, sessionId } = setup(
      [
        [{ type: "tool_call", callId: "e1", name: "exit_plan_mode", argsJson: JSON.stringify({ plan: "Step 1: do the thing" }) }, done("tool_calls")],
        text("ok"),
      ],
      { plans: false },
    );
    await engine.runTurn(sessionId);
    const events = store.read(sessionId);
    expect(events.some((e) => e.type === "plan_presented")).toBe(false);
    expect(events.some((e) => e.type === "plan_resolved")).toBe(false);
    const exitResult = events.find((e) => e.type === "tool_result" && e.callId === "e1");
    expect(exitResult).toMatchObject({ isError: false });
    expect((exitResult as any).output).toContain("exit_plan_mode is only meaningful in plan mode");
  });

  test("exit_plan_mode in ask mode → policy guard prevents bridge, falls to placeholder", async () => {
    const prev = process.env.NORMA_PLAN_TIMEOUT_MS;
    process.env.NORMA_PLAN_TIMEOUT_MS = "50"; // short timeout so test doesn't hang if bridge fires
    try {
      const { engine, store, sessionId } = setup(
        [
          [{ type: "tool_call", callId: "e1", name: "exit_plan_mode", argsJson: JSON.stringify({ plan: "Step 1: do the thing" }) }, done("tool_calls")],
          text("ok"),
        ],
        { approvalPolicy: "ask" }, // not in plan mode
      );
      await engine.runTurn(sessionId);
      const events = store.read(sessionId);

      // Bridge must NOT fire — no plan_presented event emitted
      expect(events.some((e) => e.type === "plan_presented")).toBe(false);
      expect(events.some((e) => e.type === "plan_resolved")).toBe(false);

      // Tool must return placeholder text (executeCall path, not bridge)
      const exitResult = events.find((e) => e.type === "tool_result" && e.callId === "e1");
      expect(exitResult).toMatchObject({ isError: false });
      expect((exitResult as any).output).toContain("exit_plan_mode is only meaningful in plan mode");
    } finally {
      if (prev === undefined) delete process.env.NORMA_PLAN_TIMEOUT_MS;
      else process.env.NORMA_PLAN_TIMEOUT_MS = prev;
    }
  });
});

// enter_plan_mode (4g Task 4): plan-mode symmetry — unlike exit_plan_mode, entering needs no
// PlanBroker wait (no human approval — entering is strictly restrictive), so the engine bridge
// fires unconditionally: guard on the CURRENT policy (already "plan" → typed isError), else
// `cfg.setPolicy` persists + a SAME-TURN local `meta.approvalPolicy` mutation, mirroring the exit
// bridge's mechanics exactly (see runPlanBridge's doc comment above).
describe("AgentEngine: enter_plan_mode bridge", () => {
  test("under ask policy → setPolicy('plan') + same-turn meta.approvalPolicy flips, so a follow-up write in the SAME turn is denied", async () => {
    const { engine, store, sessionId, cwd, setPolicyCalls } = setup(
      [
        [{ type: "tool_call", callId: "p1", name: "enter_plan_mode", argsJson: "{}" }, done("tool_calls")],
        [{ type: "tool_call", callId: "w1", name: "write", argsJson: JSON.stringify({ path: "f.txt", content: "x" }) }, done("tool_calls")],
        text("ok"),
      ],
      { approvalPolicy: "ask" },
    );
    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    const enterResult = events.find((e) => e.type === "tool_result" && e.callId === "p1");
    expect(enterResult).toMatchObject({ isError: false });
    expect((enterResult as any).output).toBe("Plan mode ON — read-only tools only; present your plan with exit_plan_mode when ready.");

    expect(setPolicyCalls).toEqual([{ sessionId, policy: "plan" }]);
    // Persisted to the store too (not just the in-memory `meta` mutation).
    expect(store.meta(sessionId).approvalPolicy).toBe("plan");

    // Same-turn follow-up write must be DENIED — the local `meta.approvalPolicy` mutation took
    // effect immediately, without waiting for the next turn's store.meta() re-read.
    const writeResult = events.find((e) => e.type === "tool_result" && e.callId === "w1");
    expect(writeResult).toMatchObject({ isError: true });
    expect((writeResult as any).output).toContain("Blocked in plan mode");
    expect(existsSync(join(cwd, "f.txt"))).toBe(false);
  });

  test("under auto policy → also switches to plan (entering is allowed from any non-plan policy)", async () => {
    const { engine, store, sessionId, setPolicyCalls } = setup(
      [[{ type: "tool_call", callId: "p1", name: "enter_plan_mode", argsJson: "{}" }, done("tool_calls")], text("ok")],
      { approvalPolicy: "auto" },
    );
    await engine.runTurn(sessionId);
    expect(setPolicyCalls).toEqual([{ sessionId, policy: "plan" }]);
    expect(store.meta(sessionId).approvalPolicy).toBe("plan");
  });

  test("already in plan mode → typed isError 'already in plan mode', policy unchanged, no setPolicy call", async () => {
    const { engine, store, sessionId, setPolicyCalls } = setup(
      [[{ type: "tool_call", callId: "p1", name: "enter_plan_mode", argsJson: "{}" }, done("tool_calls")], text("ok")],
      { approvalPolicy: "plan" },
    );
    await engine.runTurn(sessionId);
    const events = store.read(sessionId);
    const enterResult = events.find((e) => e.type === "tool_result" && e.callId === "p1");
    expect(enterResult).toMatchObject({ isError: true });
    expect((enterResult as any).output).toContain("already in plan mode");
    expect(setPolicyCalls).toEqual([]);
    expect(store.meta(sessionId).approvalPolicy).toBe("plan");
  });
});
