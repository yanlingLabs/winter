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
 * Task B4: a small local testkit for the `/ultracode` trigger + session-wide auto-orchestrate
 * toggle tests — mirrors workflow-gating.testkit.ts's own setup (B3: real SessionStore, a
 * FakeProvider standing in for the model provider, the REAL Workflow tool registered deferred),
 * but keeps ONE session alive across the whole harness (unlike workflow-gating's per-call FRESH
 * session) — the toggle-persistence test needs several turns of the SAME session in a row.
 *
 * `send`'s two flavors append a real `user_message` event with a specific `clientName` directly
 * via `hub.append` — the same direct-append idiom routines/runner.ts and dispatch-children.ts use
 * in production (and test/hub.test.ts uses in tests) — no attached HubClient needed: nothing here
 * asserts on delivered/broadcast events, only on what the provider received.
 *
 * `lastVisibleTools`/`lastInstructions` read the LAST request FakeProvider captured — the same
 * `provider.requests[...].tools`/`.instructions` shape workflow-gating.testkit.ts's own
 * `deferredIndexFor` and test/agent/engine-toolsearch.test.ts both already check.
 */
export async function makeUltracodeHarness(opts: {
  workflowsEnabled: boolean;
  keywordTrigger: boolean;
  /** Session-creation overrides for the human-origin gate's OTHER signal (meta.origin/meta.mode) —
   *  default undefined/undefined, a plain top-level code session. */
  origin?: string;
  mode?: "code" | "dispatch" | "chat";
}): Promise<{
  sendHuman: (text: string) => Promise<void>;
  sendNonHuman: (text: string, clientName?: string) => Promise<void>;
  lastVisibleTools: () => string[];
  lastInstructions: () => string;
}> {
  const home = mkdtempSync(join(tmpdir(), "norma-ultracode-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "norma-ultracode-cwd-"));
  const store = new SessionStore(home);
  const hub = new SessionHub(store);

  const registry = new ToolRegistry();
  registerWorkflowTool(registry, { deferred: true });

  const broker = new ApprovalBroker();
  const dirs = new SessionDirectories(() => [cwd]);

  const assemblerHome = mkdtempSync(join(tmpdir(), "norma-ultracode-actx-"));
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
    keywordTriggerEnabled: () => opts.keywordTrigger,
  });

  const sessionId = store.createSession("global", { cwd, approvalPolicy: "auto", origin: opts.origin, mode: opts.mode });

  const send = async (text: string, clientName: string): Promise<void> => {
    hub.append(sessionId, { type: "user_message", sessionId, threadId: "main", text, clientName });
    await engine.runTurn(sessionId);
  };

  return {
    sendHuman: (text: string) => send(text, "cli-chat"),
    sendNonHuman: (text: string, clientName = "cli-p") => send(text, clientName),
    lastVisibleTools: () => provider.requests[provider.requests.length - 1]?.tools?.map((t) => t.name) ?? [],
    lastInstructions: () => provider.requests[provider.requests.length - 1]?.instructions ?? "",
  };
}
