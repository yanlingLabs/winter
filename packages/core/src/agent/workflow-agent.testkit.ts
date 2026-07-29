import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { spyOn } from "bun:test";
import { SessionStore } from "../sessions/store";
import { SessionHub } from "../sessions/hub";
import { ToolRegistry } from "./tools/registry";
import { registerAskQuestionTool } from "./tools/ask-question";
import { registerSearchTool } from "./tools/search";
import { PermissionGate } from "./gate";
import { ApprovalBroker } from "./approvals";
import { AgentEngine } from "./engine";
import { FakeProvider } from "./fake-provider";
import { SessionDirectories } from "./dirs";
import { ContextAssembler } from "./context";
import { TrustStore } from "./trust";
import { SkillStore } from "./skills";
import { Compactor } from "./compactor";
import { AgentStore } from "./agents";
import { SubagentManager } from "./subagents";

/**
 * Task A4: a small local testkit for runWorkflowAgent's tests — mirrors
 * test/agent/engine-spawn.test.ts's own `setup()` (real SessionStore/SubagentManager/AgentStore, a
 * FakeProvider standing in for the model provider), trimmed to exactly what a bare agent()-bridge
 * call needs. `runWorkflowAgent` never drives a parent turn (it calls runThread directly, bypassing
 * turn()/runTurn), so the child's own single scripted round is the ONLY provider call these tests
 * ever make — one script entry is enough.
 *
 * The registry carries exactly one stub tool, literally named "Workflow" (the real one is B2's,
 * not yet registered anywhere) — present here purely so the "does NOT have the Workflow tool"
 * assertion is a genuine regression guard: absent this stub, specs() would already have nothing
 * called "Workflow" to filter, and the exclusion could silently break without failing the test.
 *
 * The session is created at policy "ask" (never "accept-edits") — proves runWorkflowAgent's own
 * hardcoded override is what puts the child at accept-edits, not an already-permissive session.
 */
export async function makeWorkflowAgentHarness(opts: {
  childReply: string;
  recordChildTools?: boolean;
}): Promise<{
  engine: AgentEngine;
  sessionId: string;
  registry: ToolRegistry;
  toolsSeenByChild: (() => string[]) & { policy?: () => string | undefined };
  // I3 review fix (Chat Slice D task 1): exposed so a test can `store.setModel(sessionId, ...)`
  // and `provider.requests[...]` to prove `runWorkflowAgent` honors a per-session override —
  // additive, every pre-existing caller destructures only the fields it already used.
  store: SessionStore;
  provider: FakeProvider;
}> {
  const home = mkdtempSync(join(tmpdir(), "norma-workflow-agent-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "norma-workflow-agent-cwd-"));
  const store = new SessionStore(home);
  const hub = new SessionHub(store);

  const registry = new ToolRegistry();
  registry.register({
    name: "Workflow",
    description: "stub standing in for B2's real Workflow tool — see this file's own doc comment",
    args: z.object({}),
    run: async () => "unused in these tests",
  });
  // R-T2 fix-round-1: registered so this harness matches the real daemon (daemon.ts always
  // registers both AskQuestion and Search), which is what makes
  // `registry.namesNotForMode("code")` a REAL check in the "chat-only tools never reach a
  // workflow-spawned child" test (workflow-agent.test.ts) rather than one over an empty
  // complement — the old CHAT_ONLY_TOOLS constant this replaces is deleted.
  registerAskQuestionTool(registry);
  registerSearchTool(registry);

  const broker = new ApprovalBroker();
  const dirs = new SessionDirectories(() => [cwd]);

  const assemblerHome = mkdtempSync(join(tmpdir(), "norma-workflow-agent-actx-"));
  const assemblerTrust = new TrustStore(join(assemblerHome, "trust.json"));
  const assembler = new ContextAssembler({
    normaHome: assemblerHome,
    trust: assemblerTrust,
    skills: new SkillStore({ normaHome: assemblerHome, trust: assemblerTrust }),
  });

  const provider = new FakeProvider([
    [{ type: "text_delta", delta: opts.childReply }, { type: "done", stopReason: "end_turn" }],
  ]);
  const compactor = new Compactor({ provider: { provider, model: "fake-1" }, store, hub });

  const agentsHome = mkdtempSync(join(tmpdir(), "norma-workflow-agent-agents-"));
  const agentsTrust = new TrustStore(join(agentsHome, "trust.json"));
  const agents = new AgentStore({ normaHome: agentsHome, trust: agentsTrust });
  const subagents = new SubagentManager();

  const engine = new AgentEngine({
    store, hub, registry, broker,
    gate: new PermissionGate(),
    provider: { provider, model: "fake-1" },
    dirs, assembler, compactor, agents, subagents,
  });

  const sessionId = store.createSession("global", { cwd, approvalPolicy: "ask" });

  // recordChildTools: spies on the engine's own (TS-`private`, so a plain method at runtime)
  // runThread to capture the exact `meta.approvalPolicy` runWorkflowAgent built for the child —
  // the only place that value is visible as a literal argument anywhere on this path (childMeta is
  // a local object inside engine.ts, never round-tripped through the SessionStore — spying on
  // store.meta would only ever see the PARENT session's own "ask" policy, never the override).
  // bun's spyOn calls through to the real implementation by default (same pattern already used by
  // test/agent/engine-spawn.test.ts's `spyOn(subagents!, "run")`), so this purely observes — the
  // child still actually runs.
  const runThreadSpy = opts.recordChildTools
    ? spyOn(engine as unknown as { runThread: (...args: unknown[]) => unknown }, "runThread")
    : undefined;

  const toolsSeenByChild = (() => {
    const last = provider.requests[provider.requests.length - 1];
    return (last?.tools ?? []).map((t) => t.name);
  }) as (() => string[]) & { policy?: () => string | undefined };
  toolsSeenByChild.policy = () => {
    const call = runThreadSpy?.mock.calls[0] as [{ meta?: { approvalPolicy?: string } }] | undefined;
    return call?.[0]?.meta?.approvalPolicy;
  };

  return { engine, sessionId, registry, toolsSeenByChild, store, provider };
}
