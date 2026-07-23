import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEvent } from "@norma/protocol";
import type { ProviderEvent } from "../providers/types";
import { SessionStore } from "../sessions/store";
import { SessionHub } from "../sessions/hub";
import { ToolRegistry } from "./tools/registry";
import { registerWorkflowTool } from "./tools/workflow";
import { PermissionGate, type SessionApprovalPolicy } from "./gate";
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
import { WorkflowRuntime } from "../workflows/runtime";

/**
 * Task B2: a small local testkit for the engine's Workflow bridge tests — mirrors
 * workflow-agent.testkit.ts's own setup (real SessionStore/SubagentManager/AgentStore, a
 * FakeProvider standing in for the model), but ALSO wires a REAL WorkflowRuntime (no
 * `workerCommand` override — same "the real sandboxed-subprocess default transport is cheap enough
 * for a test" precedent as workflows/runtime.test.ts) so a launched run genuinely completes and
 * genuinely drives onEvent → engine.notifyWorkflowCompletion. This is the EXACT production shape
 * daemon.ts wires: `spawnAgent` wraps `engine.runWorkflowAgent`, `onEvent` calls
 * `engine.notifyWorkflowCompletion` on completed/failed — see daemon.ts's own WorkflowRuntime
 * construction for the canonical wiring this mirrors.
 *
 * The FakeProvider's first scripted round emits ONE "Workflow" tool_call built from `opts`, then a
 * second round closes the turn with plain text — the same tool_calls-then-final-text two-round
 * shape engine-spawn.test.ts's own spawnCall/text helpers use.
 */
export async function makeWorkflowBridgeHarness(opts: {
  script: string;
  args?: unknown;
  name?: string;
  run_in_background?: boolean;
  approvalPolicy?: SessionApprovalPolicy;
}): Promise<{
  engine: AgentEngine;
  sessionId: string;
  store: SessionStore;
  broker: ApprovalBroker;
  toolResults: () => Array<Extract<SessionEvent, { type: "tool_result" }>>;
}> {
  const home = mkdtempSync(join(tmpdir(), "norma-workflow-bridge-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "norma-workflow-bridge-cwd-"));
  const store = new SessionStore(home);
  const hub = new SessionHub(store);

  const registry = new ToolRegistry();
  // deferred:false — this harness's sessions never enable ToolSearch, so deferral would be inert
  // either way (registry.ts's isDeferred requires builtin deferral active); false keeps the bridge
  // test focused on the LAUNCH/gate mechanics, not deferral (already covered by workflow.test.ts).
  registerWorkflowTool(registry, { deferred: false });

  const broker = new ApprovalBroker();
  const dirs = new SessionDirectories(() => [cwd]);

  const assemblerHome = mkdtempSync(join(tmpdir(), "norma-workflow-bridge-actx-"));
  const assemblerTrust = new TrustStore(join(assemblerHome, "trust.json"));
  const assembler = new ContextAssembler({
    normaHome: assemblerHome,
    trust: assemblerTrust,
    skills: new SkillStore({ normaHome: assemblerHome, trust: assemblerTrust }),
  });

  const workflowArgs: Record<string, unknown> = { script: opts.script };
  if (opts.args !== undefined) workflowArgs.args = opts.args;
  if (opts.name !== undefined) workflowArgs.name = opts.name;
  if (opts.run_in_background !== undefined) workflowArgs.run_in_background = opts.run_in_background;
  const script: ProviderEvent[][] = [
    [
      { type: "tool_call", callId: "wf1", name: "Workflow", argsJson: JSON.stringify(workflowArgs) },
      { type: "done", stopReason: "tool_calls" },
    ],
    [{ type: "text_delta", delta: "ok" }, { type: "done", stopReason: "end_turn" }],
  ];
  const provider = new FakeProvider(script);
  const compactor = new Compactor({ provider: { provider, model: "fake-1" }, store, hub });

  const agentsHome = mkdtempSync(join(tmpdir(), "norma-workflow-bridge-agents-"));
  const agentsTrust = new TrustStore(join(agentsHome, "trust.json"));
  const agents = new AgentStore({ normaHome: agentsHome, trust: agentsTrust });
  const subagents = new SubagentManager();

  const runsDir = mkdtempSync(join(tmpdir(), "norma-workflow-bridge-runs-"));
  // Late-binding closure over `engine` (assigned just below) — the EXACT precedent daemon.ts's own
  // WorkflowRuntime construction follows (see its doc comment): neither closure is ever INVOKED
  // until a real launch/completion happens, well after `engine` is assigned.
  let engine!: AgentEngine;
  const workflows = new WorkflowRuntime({
    onEvent: (sid, ev) => {
      if (ev.type === "completed" || ev.type === "failed") engine.notifyWorkflowCompletion(sid, ev.runId);
    },
    spawnAgent: (sid, prompt, o, signal) => engine.runWorkflowAgent(sid, prompt, o, signal),
    runsDir,
  });

  engine = new AgentEngine({
    store, hub, registry, broker,
    gate: new PermissionGate(),
    provider: { provider, model: "fake-1" },
    dirs, assembler, compactor, agents, subagents,
    workflows,
  });

  const sessionId = store.createSession("global", { cwd, approvalPolicy: opts.approvalPolicy ?? "auto" });

  const toolResults = () =>
    store.read(sessionId).filter((e): e is Extract<SessionEvent, { type: "tool_result" }> => e.type === "tool_result");

  return { engine, sessionId, store, broker, toolResults };
}
