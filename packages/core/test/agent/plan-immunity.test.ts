import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { SessionEvent } from "@norma/protocol";
import { SessionStore } from "../../src/sessions/store";
import { SessionHub } from "../../src/sessions/hub";
import { ToolRegistry } from "../../src/agent/tools/registry";
import { registerReadTools } from "../../src/agent/tools/fs-read";
import { registerWriteTools } from "../../src/agent/tools/fs-write";
import { registerPlanTool } from "../../src/agent/tools/plan";
import { registerToolSearchTool } from "../../src/agent/tools/toolsearch";
import { registerAskQuestionTool } from "../../src/agent/tools/ask-question";
import { PermissionGate } from "../../src/agent/gate";
import { ApprovalBroker } from "../../src/agent/approvals";
import { AgentEngine } from "../../src/agent/engine";
import { FakeProvider } from "../../src/agent/fake-provider";
import { SessionDirectories } from "../../src/agent/dirs";
import { ContextAssembler } from "../../src/agent/context";
import { TrustStore } from "../../src/agent/trust";
import { SkillStore } from "../../src/agent/skills";
import { Compactor } from "../../src/agent/compactor";
import type { ProviderEvent } from "../../src/providers/types";

/**
 * Hands-Off Modes: Structural Plan-Policy Immunity (2026-07-28 design, USER-REVISED mid-
 * implementation) — engine-side coverage for the belt-and-braces guards plus the load-bearing
 * turn-time policy resolution:
 *
 *  - engine.ts's turn() resolves a CHAT session's effective approvalPolicy to the fixed "chat"
 *    value EVERY turn, regardless of what the stored row says — this is what kills the stale-row
 *    problem outright (a pre-fix chat row may carry "auto"; a synthetic/manually-poked one could
 *    carry anything, even "plan").
 *  - buildInstructionsFull's "# Plan mode" text and pinnedTools' exit_plan_mode pin are ALSO
 *    mode-gated (not just policy-gated) — doubly-dead for chat post turn-time-resolution, but the
 *    LIVE fix for dispatch (whose policy is real and settable, never turn-time-overridden).
 *  - gate.ts's PermissionGate.evaluate() treats "chat" as a DENY-not-ask policy for everything
 *    outside chat's own read-only/network tool classes.
 *
 * Harness mirrors chat-mode-allowlist.test.ts's production-shaped `toolSearch: { enabled: () =>
 * undefined }` (the REAL daemon.ts getter shape when a user never touches the setting) so these
 * tests exercise the actual deferral/pin/gate machinery end to end, not a trimmed stand-in.
 */
function setup(
  script: ProviderEvent[][],
  opts: { mode?: "code" | "dispatch" | "chat"; approvalPolicy?: string; registry?: ToolRegistry } = {},
) {
  const home = mkdtempSync(join(tmpdir(), "norma-plan-immunity-"));
  const cwd = mkdtempSync(join(tmpdir(), "norma-plan-immunity-cwd-"));
  const store = new SessionStore(home);
  const hub = new SessionHub(store);
  const registry = opts.registry ?? (() => {
    const r = new ToolRegistry();
    registerReadTools(r);
    registerWriteTools(r);
    // Production shape (daemon.ts:553): the plan tool IS registered deferred:true for real —
    // without this, exit_plan_mode would never be deferred in the first place and the PIN
    // assertions below would prove nothing.
    registerPlanTool(r, { deferred: true });
    registerToolSearchTool(r);
    registerAskQuestionTool(r);
    return r;
  })();

  const broker = new ApprovalBroker();
  const provider = new FakeProvider(script);
  const dirs = new SessionDirectories(() => [cwd]);
  const assemblerHome = mkdtempSync(join(tmpdir(), "norma-plan-immunity-actx-"));
  const assemblerTrust = new TrustStore(join(assemblerHome, "trust.json"));
  const skills = new SkillStore({ normaHome: assemblerHome, trust: assemblerTrust });
  const assembler = new ContextAssembler({ normaHome: assemblerHome, trust: assemblerTrust, skills });
  const compactor = new Compactor({ provider: { provider, model: "fake-1" }, store, hub });
  const engine = new AgentEngine({
    store, hub, registry, broker,
    gate: new PermissionGate(),
    provider: { provider, model: "fake-1" },
    dirs, assembler, compactor,
    // Production-shaped (chat-mode-allowlist.test.ts's own precedent): the CONFIG OBJECT is
    // present (deferral machinery active) but `enabled` resolves undefined — exactly what
    // daemon.ts's real getter does when the user has never touched toolSearch.enabled.
    toolSearch: { enabled: () => undefined },
  });
  const sessionId = store.createSession("global", { cwd, approvalPolicy: opts.approvalPolicy as any, mode: opts.mode });
  const events: SessionEvent[] = [];
  hub.attach({ clientName: "test-observer", deliver: (e) => { events.push(e); return true; } }, sessionId, 0);
  return { engine, store, sessionId, provider, cwd, events, registry };
}

const done = (reason: "end_turn" | "tool_calls"): ProviderEvent => ({ type: "done", stopReason: reason });
const text = (t: string): ProviderEvent[] => [{ type: "text_delta", delta: t }, { type: "usage", inputTokens: 10, outputTokens: 2 }, done("end_turn")];

describe("plan-immunity: code mode is unaffected (control — proves the guards are narrow)", () => {
  test("a code session created with approvalPolicy 'plan' still shows the '# Plan mode' text AND pins exit_plan_mode into round-0 specs — byte-identical to pre-fix behavior", async () => {
    const { engine, sessionId, provider } = setup([text("ok")], { mode: "code", approvalPolicy: "plan" });
    await engine.runTurn(sessionId);
    const req = provider.requests[0]!;
    expect(req.instructions).toContain("# Plan mode");
    const names = req.tools?.map((t) => t.name) ?? [];
    expect(names).toContain("exit_plan_mode"); // pinned visible even though never loaded (deferred:true)
  });
});

describe("plan-immunity: chat's turn-time policy resolution kills the stale-row problem", () => {
  test.each(["auto", "plan"] as const)(
    "a chat session whose STORED row carries '%s' (pre-fix / synthetic) resolves to the fixed 'chat' policy at turn-time: no plan text, no exit_plan_mode pin, the turn completes normally, and chat's own tool still works",
    async (storedPolicy) => {
      const { engine, store, sessionId, provider, events } = setup(
        [
          [{ type: "tool_call", callId: "q1", name: "AskQuestion", argsJson: JSON.stringify({ question: "Pick one", options: [{ label: "A" }, { label: "B" }] }) }, done("tool_calls")],
          text("done"),
        ],
        { mode: "chat" },
      );
      // Simulate a pre-fix persisted row directly via the store — bypassing BOTH RPC-seam guards
      // (session.create's chat coercion, session.setPolicy's chat rejection), exactly the
      // "existing chat row created before this fix shipped" scenario the design calls out.
      store.setApprovalPolicy(sessionId, storedPolicy);
      expect(store.meta(sessionId).approvalPolicy).toBe(storedPolicy); // sanity: the stale row is real

      await engine.runTurn(sessionId);

      const instructions = provider.requests[0]?.instructions ?? "";
      expect(instructions).not.toContain("# Plan mode");
      const names = provider.requests[0]?.tools?.map((t) => t.name) ?? [];
      expect(names).not.toContain("exit_plan_mode");

      // The turn completes normally — no crash, no swallowed turn.
      expect(events.some((e) => e.type === "turn_completed" && e.stopReason === "end_turn")).toBe(true);

      // Chat's own allowlisted tool still works — not rejected as unavailable.
      const qResult = events.find((e) => e.type === "tool_result" && e.callId === "q1");
      expect(qResult).toBeTruthy();
      expect((qResult as any).output).not.toContain("not available in this session");
    },
  );
});

describe("plan-immunity: dispatch's stale-row belt-and-brace (the LIVE fix — dispatch's policy is real, never turn-time-overridden)", () => {
  test("a dispatch session whose stored row carries 'plan' (pre-fix / synthetic) shows no plan text and no exit_plan_mode pin", async () => {
    const { engine, store, sessionId, provider } = setup([text("ok")], { mode: "dispatch" });
    store.setApprovalPolicy(sessionId, "plan");
    expect(store.meta(sessionId).approvalPolicy).toBe("plan"); // sanity: the stale row is real

    await engine.runTurn(sessionId);

    const instructions = provider.requests[0]?.instructions ?? "";
    expect(instructions).not.toContain("# Plan mode");
    const names = provider.requests[0]?.tools?.map((t) => t.name) ?? [];
    expect(names).not.toContain("exit_plan_mode");
  });
});

describe("plan-immunity: gate matrix for policy 'chat' — a real turn proves DENY, never ask", () => {
  // Parametrized over the STORED row's policy (not just the default "ask"): "auto" is the shipped
  // Mac app's own chat-creation value (AppDelegate.swift), "plan" is the stale-row scenario the
  // rest of this file covers. Without turn()'s turn-time resolution, gate.evaluate would be fed
  // the STORED value verbatim — "auto" grants MUTATING tools outright (gate.ts: `auto` → allow),
  // which is exactly the escape this test would catch if the override were ever removed or
  // scoped wrong; "plan" would hang the turn waiting on requestApproval's unanswered broker wait
  // (gate.ts: `plan` → deny is fine, but a REAL pre-fix row is not guaranteed to be "plan" at all —
  // this proves the resolution, not a lucky coincidence of what "plan" happens to already deny).
  test.each(["auto", "plan"] as const)(
    "a mutating tool artificially placed on chat's allowlist (modes:['chat'], simulating a future mistake), on a session whose STORED row carries '%s', is denied outright: isError true, an ACCURATE (non-plan-mode) message, zero approval_requested events, run() never called",
    async (storedPolicy) => {
      let ran = false;
      const registry = new ToolRegistry();
      registerToolSearchTool(registry);
      registerAskQuestionTool(registry);
      registry.register({
        name: "bash",
        description: "run a shell command",
        args: z.object({ command: z.string() }),
        modes: ["chat"], // deliberately mis-eligible — proves the GATE itself denies even if the allowlist didn't
        run: () => { ran = true; return "ran"; },
      });
      const { engine, store, sessionId, events } = setup(
        [
          [{ type: "tool_call", callId: "b1", name: "bash", argsJson: JSON.stringify({ command: "echo hi" }) }, done("tool_calls")],
          text("done"),
        ],
        { mode: "chat", registry },
      );
      store.setApprovalPolicy(sessionId, storedPolicy);
      expect(store.meta(sessionId).approvalPolicy).toBe(storedPolicy); // sanity: the stored row really carries it

      await engine.runTurn(sessionId);

      const result = events.find((e) => e.type === "tool_result" && e.callId === "b1");
      expect(result).toMatchObject({ isError: true });
      expect((result as any).output).not.toContain("Blocked in plan mode"); // accurate message — chat was never in plan mode
      expect((result as any).output.toLowerCase()).toContain("chat");
      expect(ran).toBe(false); // registry.execute()'s run() never fired
      expect(events.some((e) => e.type === "approval_requested")).toBe(false); // never carded — denied, not asked
    },
  );
});
