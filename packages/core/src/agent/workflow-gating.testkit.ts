import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../sessions/store";
import { SessionHub } from "../sessions/hub";
import { ToolRegistry } from "./tools/registry";
import { registerWorkflowTool } from "./tools/workflow";
import { PermissionGate } from "./gate";
import { ApprovalBroker } from "./approvals";
import { AgentEngine } from "./engine";
import { FakeProvider } from "./fake-provider";
import { SessionDirectories } from "./dirs";
import { ContextAssembler } from "./context";
import { TrustStore } from "./trust";
import { SkillStore } from "./skills";
import { Compactor } from "./compactor";

/**
 * Task B3: a small local testkit for the Workflow tool's per-session gating tests — mirrors
 * workflow-bridge.testkit.ts's own setup (real SessionStore, a FakeProvider standing in for the
 * model provider), trimmed to exactly what a deferred-index VISIBILITY check needs: no subagents/
 * agents/mcp wiring at all — these tests never spawn a subagent or call any tool, they only assert
 * what a turn's instructions OFFER. A plain end_turn round (no tool_calls) is the ONLY provider
 * call each `deferredIndexFor` makes.
 *
 * Registers the REAL Workflow tool (`registerWorkflowTool`, B2) with `deferred:true` — the exact
 * shape daemon.ts registers it with — so a passing assertion here is a genuine regression guard on
 * the actual tool, not a stand-in (mirrors workflow-agent.testkit.ts's own doc comment on why its
 * stub is named literally "Workflow"). `toolSearch.enabled` is always on: builtin ToolSearch
 * deferral (engine.ts's toolSearchEnabled) is the precondition for ANY `deferred:true` built-in —
 * Workflow included — to appear in "# Deferred tools" at all (registry.ts's isDeferred); without
 * it, Workflow would be absent from every case, enabled or not, and these tests would prove nothing.
 *
 * `workflowsEnabled` is fixed for the whole harness — these tests vary session `meta`, not
 * settings, per call. daemon.ts's own getter is `(cwd?: string) => boolean`; a constant closure
 * here is the correct test double for a fixed-per-test settings value.
 *
 * `deferredIndexFor` creates a FRESH session per call — SessionStore has no origin/mode setter
 * after creation, only createSession stamps either (sessions/store.ts) — runs one real turn, and
 * returns the exact `instructions` text the model would have seen for that turn: the SAME text
 * test/agent/engine-toolsearch.test.ts's own deferred-index assertions check
 * (`req.instructions).toContain(...)`), so this exercises the real end-to-end path (session meta +
 * EngineConfig → turn() → buildInstructionsFull), not a reflection/spy on any private method.
 */
export async function makeGatingHarness(opts: {
  workflowsEnabled: boolean;
}): Promise<{
  deferredIndexFor: (meta: { origin?: string; mode?: "code" | "dispatch" }) => Promise<string>;
}> {
  const home = mkdtempSync(join(tmpdir(), "norma-workflow-gating-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "norma-workflow-gating-cwd-"));
  const store = new SessionStore(home);
  const hub = new SessionHub(store);

  const registry = new ToolRegistry();
  registerWorkflowTool(registry, { deferred: true });

  const broker = new ApprovalBroker();
  const dirs = new SessionDirectories(() => [cwd]);

  const assemblerHome = mkdtempSync(join(tmpdir(), "norma-workflow-gating-actx-"));
  const assemblerTrust = new TrustStore(join(assemblerHome, "trust.json"));
  const assembler = new ContextAssembler({
    normaHome: assemblerHome,
    trust: assemblerTrust,
    skills: new SkillStore({ normaHome: assemblerHome, trust: assemblerTrust }),
  });

  const provider = new FakeProvider([
    [{ type: "text_delta", delta: "ok" }, { type: "done", stopReason: "end_turn" }],
  ]);
  const compactor = new Compactor({ provider: { provider, model: "fake-1" }, store, hub });

  const engine = new AgentEngine({
    store, hub, registry, broker,
    gate: new PermissionGate(),
    provider: { provider, model: "fake-1" },
    dirs, assembler, compactor,
    toolSearch: { enabled: () => true },
    workflowsEnabled: () => opts.workflowsEnabled,
  });

  const deferredIndexFor = async (meta: { origin?: string; mode?: "code" | "dispatch" }): Promise<string> => {
    const sessionId = store.createSession("global", { cwd, approvalPolicy: "auto", origin: meta.origin, mode: meta.mode });
    await engine.runTurn(sessionId);
    return provider.requests[provider.requests.length - 1]?.instructions ?? "";
  };

  return { deferredIndexFor };
}
