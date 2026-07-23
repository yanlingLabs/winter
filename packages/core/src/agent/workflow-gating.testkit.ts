import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TurnRequest } from "../providers/types";
import { SessionStore } from "../sessions/store";
import { SessionHub } from "../sessions/hub";
import { ToolRegistry } from "./tools/registry";
import { registerWorkflowTool } from "./tools/workflow";
import { registerSpawnAgentTool } from "./tools/spawn";
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

/**
 * Task B-gatefix Part 3: a small local testkit proving a plain `spawn_agent` CHILD THREAD never
 * sees the `Workflow` tool, even inside a top-level, workflows-enabled CODE session where the MAIN
 * thread genuinely does (B3's own report flagged this as an open gap: `workflowToolAllowed` is a
 * SESSION-level predicate keyed on `meta`, which a spawn_agent child shares byte-for-byte with its
 * parent — re-checking it at the child's own call site would just repeat the parent's own verdict,
 * so it can't be what excludes the child; only a THREAD-identity-keyed exclusion can).
 *
 * Unlike `makeGatingHarness` above (which never spawns anything), this wires `agents`/`subagents`
 * too — required for the engine's spawn_agent BRIDGE to intercept the call at all (engine.ts's
 * `spawnCalls` gate: `this.cfg.subagents && this.cfg.agents && opts.depth < maxDepth`); without both,
 * the call would fall through to spawn.ts's own placeholder run() and never produce a child thread
 * to inspect. `cfg.bgAgents` is deliberately OMITTED (mirrors workflow-gating's sibling harness
 * above having no bg-agent wiring at all) so a depth-0 spawn defaults to SYNCHRONOUS regardless of
 * the tool's own `run_in_background` default (engine.ts: `bgDefault = opts.depth === 0 &&
 * !!this.cfg.bgAgents` — false here) — the scripted call ALSO passes `run_in_background:false`
 * explicitly, belt-and-braces, so the three-round script below is deterministic.
 *
 * FakeProvider plays its script in strict call order (fake-provider.ts's own single counter, shared
 * across every thread): [0] the MAIN thread's spawn_agent tool_call, [1] the CHILD thread's own
 * turn (ends immediately with no tool calls — THIS is the request under test), [2] the MAIN
 * thread's continuation after the child's tool_result (ends the turn). Returns the raw `TurnRequest`
 * each role saw so the test can assert on `.tools` (specs()) and/or `.instructions` (deferred-index
 * text) for either role, without this testkit prescribing which.
 *
 * `deferred` mirrors `registerWorkflowTool`'s own opt: `false` (like workflow-bridge.testkit.ts) puts
 * Workflow in specs() unconditionally whenever it isn't excludeTools-excluded — the most direct way
 * to prove `childExcludeTools` itself is doing the work, independent of ToolSearch/loaded-set
 * dynamics that could otherwise mask a missing exclusion (a deferred:true tool no thread has
 * "loaded" yet is ALSO absent from specs(), which would pass even without this task's fix). `true`
 * (+ `toolSearchEnabled`) instead exercises the REAL B2 registration shape, for asserting on the
 * deferred-index TEXT (`.instructions`) — the other half of this task's fix.
 */
export async function makeSpawnGatingHarness(opts: {
  workflowsEnabled: boolean;
  deferred: boolean;
  toolSearchEnabled?: boolean;
}): Promise<{ mainRequest: TurnRequest; childRequest: TurnRequest }> {
  const home = mkdtempSync(join(tmpdir(), "norma-spawn-gating-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "norma-spawn-gating-cwd-"));
  const store = new SessionStore(home);
  const hub = new SessionHub(store);

  const registry = new ToolRegistry();
  registerWorkflowTool(registry, { deferred: opts.deferred });
  registerSpawnAgentTool(registry);

  const broker = new ApprovalBroker();
  const dirs = new SessionDirectories(() => [cwd]);

  const assemblerHome = mkdtempSync(join(tmpdir(), "norma-spawn-gating-actx-"));
  const assemblerTrust = new TrustStore(join(assemblerHome, "trust.json"));
  const assembler = new ContextAssembler({
    normaHome: assemblerHome,
    trust: assemblerTrust,
    skills: new SkillStore({ normaHome: assemblerHome, trust: assemblerTrust }),
  });

  // Round 0: MAIN thread spawns a plain (non-workflow) child, synchronously. Round 1: the CHILD's
  // own turn — the request under test — ends immediately with plain text, no tool calls. Round 2:
  // MAIN's continuation after the child's tool_result closes the turn.
  const provider = new FakeProvider([
    [
      {
        type: "tool_call", callId: "sp1", name: "spawn_agent",
        argsJson: JSON.stringify({ prompt: "reply with any short text", description: "test child", run_in_background: false }),
      },
      { type: "done", stopReason: "tool_calls" },
    ],
    [{ type: "text_delta", delta: "child done" }, { type: "done", stopReason: "end_turn" }],
    [{ type: "text_delta", delta: "main done" }, { type: "done", stopReason: "end_turn" }],
  ]);
  const compactor = new Compactor({ provider: { provider, model: "fake-1" }, store, hub });

  const agentsHome = mkdtempSync(join(tmpdir(), "norma-spawn-gating-agents-"));
  const agentsTrust = new TrustStore(join(agentsHome, "trust.json"));
  const agents = new AgentStore({ normaHome: agentsHome, trust: agentsTrust });
  const subagents = new SubagentManager();

  const engine = new AgentEngine({
    store, hub, registry, broker,
    gate: new PermissionGate(),
    provider: { provider, model: "fake-1" },
    dirs, assembler, compactor, agents, subagents,
    toolSearch: { enabled: () => opts.toolSearchEnabled ?? false },
    workflowsEnabled: () => opts.workflowsEnabled,
  });

  // A top-level interactive CODE session — origin/mode both the "everything allowed" default —
  // the ONE scenario Part 3 cares about (a workflows-enabled top-level session whose MAIN thread
  // genuinely gets Workflow, but whose spawned CHILD thread must not).
  const sessionId = store.createSession("global", { cwd, approvalPolicy: "auto" });
  await engine.runTurn(sessionId);

  const mainRequest = provider.requests[0];
  const childRequest = provider.requests[1];
  if (!mainRequest || !childRequest) {
    throw new Error(`expected at least 2 provider requests (main + child), got ${provider.requests.length}`);
  }
  return { mainRequest, childRequest };
}
