import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEvent } from "@norma/protocol";
import { SessionStore } from "../../src/sessions/store";
import { SessionHub, type HubClient } from "../../src/sessions/hub";
import { ToolRegistry } from "../../src/agent/tools/registry";
import { registerReadTools } from "../../src/agent/tools/fs-read";
import { registerWriteTools } from "../../src/agent/tools/fs-write";
import { registerComputerTool } from "../../src/agent/tools/computer";
import { registerBashTool } from "../../src/agent/tools/bash";
import { registerTaskStopTool } from "../../src/agent/tools/task-stop";
import { registerNotebookTool } from "../../src/agent/tools/notebook";
import { registerSpawnAgentTool } from "../../src/agent/tools/spawn";
import { registerSessionSpawnTool } from "../../src/agent/tools/session-spawn";
import { registerSkillWriteTool } from "../../src/agent/tools/skill-write";
import { registerPushNotificationTool } from "../../src/agent/tools/push-notification";
import { registerAskUserTool } from "../../src/agent/tools/ask-user";
import { registerAskQuestionTool } from "../../src/agent/tools/ask-question";
import { registerSearchTool } from "../../src/agent/tools/search";
import { registerWebTools } from "../../src/agent/tools/web";
import { registerLspTools } from "../../src/agent/tools/lsp";
import { LspManager } from "../../src/agent/lsp/manager";
import { registerToolSearchTool } from "../../src/agent/tools/toolsearch";
import { PermissionGate } from "../../src/agent/gate";
import { ApprovalBroker } from "../../src/agent/approvals";
import { QuestionBroker } from "../../src/agent/questions";
import { AgentEngine } from "../../src/agent/engine";
import { SessionDirectories } from "../../src/agent/dirs";
import { ContextAssembler } from "../../src/agent/context";
import { TrustStore } from "../../src/agent/trust";
import { SkillStore } from "../../src/agent/skills";
import { Compactor } from "../../src/agent/compactor";
import type { ModelInfo, Provider, ProviderEvent, TurnRequest } from "../../src/providers/types";

/**
 * D1-T3: ToolSearch must never advertise a tool the calling thread's mode can't call. Task 2 gave
 * dispatch SIX deferred tools of its own (bash, computer, task_stop, AskQuestion, send_message,
 * push_notification) and threaded `ctx.mode` into `deferredIndex` — but `deferredIndex` only
 * resolves an ARRAY-valued `deferred` against `mode`; a builtin registered bare `deferred: true`
 * (web_search, web_fetch, lsp's tools, skill_write, notebook_edit — every one of them CODE-only via
 * `modes: ["code"]`/absent-defaults-to-code) rides deferral in EVERY mode regardless of `mode`, so
 * it still lands in a dispatch session's deferred index even though `namesForMode("dispatch", ...)`
 * would never have offered it. This harness registers the FULL code-mode surface (mirrors
 * dispatch-toolset.test.ts's "full-surface registry" comment) so a dispatch/chat turn here is
 * actually exercising the allow/exclude filter, not a vacuous absence.
 */
function harness(opts: { mode: "code" | "dispatch" | "chat" }) {
  const home = mkdtempSync(join(tmpdir(), "norma-ts-mode-scope-"));
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "norma-ts-mode-scope-cwd-")));
  const store = new SessionStore(home);
  const hub = new SessionHub(store);
  const registry = new ToolRegistry();
  registerReadTools(registry);
  registerWriteTools(registry);
  registerComputerTool(registry, { deferred: ["dispatch"] });
  registerBashTool(registry);
  registerTaskStopTool(registry, { deferred: ["dispatch"] });
  registerNotebookTool(registry, { deferred: true }); // daemon.ts's real flag — code-only, deferred every mode
  registerSpawnAgentTool(registry);
  registerSessionSpawnTool(registry);
  registerPushNotificationTool(registry);
  registerAskUserTool(registry);
  registerAskQuestionTool(registry);
  registerSearchTool(registry);
  registerWebTools(registry); // web_search/web_fetch: modes:["code"], deferred:true
  registerToolSearchTool(registry);

  const assemblerHome = mkdtempSync(join(tmpdir(), "norma-ts-mode-scope-actx-"));
  const assemblerTrust = new TrustStore(join(assemblerHome, "trust.json"));
  const skills = new SkillStore({ normaHome: assemblerHome, trust: assemblerTrust });
  registerSkillWriteTool(registry, { skills }); // code-only (default modes), deferred:true
  const lsp = new LspManager({ serverCommands: {} });
  registerLspTools(registry, { lsp, cwdOf: () => cwd, rootsOf: () => [cwd] }); // code-only, deferred:true

  const broker = new ApprovalBroker();
  const provider = new ScriptedProvider();
  const dirs = new SessionDirectories(() => [cwd]);
  const assembler = new ContextAssembler({ normaHome: assemblerHome, trust: assemblerTrust, skills });
  const compactor = new Compactor({ provider: { provider, model: "fake-1" }, store, hub });
  const questions = new QuestionBroker();
  const engine = new AgentEngine({
    store, hub, registry, broker,
    gate: new PermissionGate(),
    provider: { provider, model: "fake-1" },
    dirs, assembler, compactor,
    questions,
    approvalTimeoutMs: 2_000,
    toolSearch: { enabled: () => undefined },
  });
  const sessionId = store.createSession("global", { cwd, approvalPolicy: "auto", mode: opts.mode });
  const events: SessionEvent[] = [];
  hub.attach({ clientName: "test-observer", deliver: (e) => { events.push(e); return true; } }, sessionId, 0);

  return {
    provider,
    events,
    turn: async (_message: string) => { await engine.runTurn(sessionId); },
    answerNextQuestion(answer: string): void {
      const watcher: HubClient = {
        clientName: "test-answerer",
        deliver(e) {
          if (e.type === "question_asked") {
            const q = e.questions[0]!;
            questions.respond(sessionId, e.callId, { [q.question]: answer }, "test");
          }
          return true;
        },
      };
      hub.attach(watcher, sessionId, 0);
    },
    toolResults(): Array<{ name: string; output: string; isError: boolean; callId: string }> {
      const names = new Map<string, string>();
      for (const e of events) if (e.type === "tool_call") names.set(e.callId, e.name);
      return events
        .filter((e): e is Extract<SessionEvent, { type: "tool_result" }> => e.type === "tool_result")
        .map((e) => ({ callId: e.callId, name: names.get(e.callId) ?? "unknown", output: e.output, isError: e.isError }));
    },
  };
}

/** Mirrors dispatch-deferred.test.ts's own ScriptedProvider (FIFO queue of enqueued tool calls,
 *  falling back to a plain end-of-turn text response once drained). */
class ScriptedProvider implements Provider {
  readonly id = "scripted";
  readonly requests: TurnRequest[] = [];
  private queue: ProviderEvent[][] = [];

  models(): ModelInfo[] { return [{ id: "fake-1", family: "fake", contextWindow: 100_000, supportsVision: false }]; }

  enqueueToolCall(name: string, args: unknown, callId?: string): string {
    const id = callId ?? `c${this.requests.length}_${this.queue.length}`;
    this.queue.push([{ type: "tool_call", callId: id, name, argsJson: JSON.stringify(args) }, { type: "done", stopReason: "tool_calls" }]);
    return id;
  }

  async *streamTurn(req: TurnRequest): AsyncIterable<ProviderEvent> {
    const { signal, ...cloneable } = req;
    this.requests.push({ ...structuredClone(cloneable), ...(signal ? { signal } : {}) });
    const events = this.queue.shift()
      ?? [{ type: "text_delta", delta: "ok" }, { type: "usage", inputTokens: 10, outputTokens: 2 }, { type: "done", stopReason: "end_turn" }];
    for (const e of events) yield e;
  }
}

describe("D1-T3: ToolSearch only offers tools the calling mode can call", () => {
  test("dispatch's ToolSearch lists only dispatch's own deferred tools", async () => {
    const h = harness({ mode: "dispatch" });
    h.provider.enqueueToolCall("ToolSearch", { query: "web search" });
    await h.turn("look something up");
    const out = h.toolResults().find((r) => r.name === "ToolSearch")!.output;
    for (const off of ["web_search", "web_fetch", "lsp", "skill_write", "notebook_edit"]) {
      expect(out).not.toContain(off); // pre-fix this "Loaded 4 tool(s)" including web_search
    }
  });

  test("the no-match branch does not enumerate off-mode tools either", async () => {
    const h = harness({ mode: "dispatch" });
    h.provider.enqueueToolCall("ToolSearch", { query: "zzzz-no-such-tool" });
    await h.turn("x");
    const out = h.toolResults().find((r) => r.name === "ToolSearch")!.output;
    expect(out).not.toContain("notebook_edit");
  });

  // select: naming an off-mode tool: CHOSEN BEHAVIOUR is a silent skip, not an explicit "not
  // available in this mode" note — see toolsearch.ts's own doc comment for why (mirrors how a
  // typo'd/unknown name in `select:` already silently drops out of `matches` today; ToolSearch's
  // job is to advertise what's loadable, and the enforcement seam (executeCall's off-list
  // rejection, engine.ts) is the ONE place that ever says "not available").
  test("dispatch select: naming an off-mode tool skips it silently rather than loading it", async () => {
    const h = harness({ mode: "dispatch" });
    h.provider.enqueueToolCall("ToolSearch", { query: "select:web_search,bash" });
    await h.turn("x");
    const out = h.toolResults().find((r) => r.name === "ToolSearch")!.output;
    expect(out).not.toContain("web_search");
    expect(out).toContain("bash"); // the in-mode name in the same select: list still loads
  });

  test("code's ToolSearch is unchanged — it still sees code's full deferred set", async () => {
    const h = harness({ mode: "code" });
    h.provider.enqueueToolCall("ToolSearch", { query: "select:lsp,web_search" });
    await h.turn("x");
    const out = h.toolResults().find((r) => r.name === "ToolSearch")!.output;
    expect(out).toContain("lsp");
    expect(out).toContain("web_search");
  });

  test("ToolSearch never appears in its own results", async () => {
    const h = harness({ mode: "code" });
    h.provider.enqueueToolCall("ToolSearch", { query: "tool search" });
    await h.turn("x");
    const out = h.toolResults().find((r) => r.name === "ToolSearch")!.output;
    expect(out).not.toContain("\"name\":\"ToolSearch\"");
  });

  // Chat is unaffected: chat's allowTools (registry.namesForMode("chat", ...)) never includes
  // ToolSearch unless something chat-eligible is itself deferred — nothing is, so chat has no
  // ToolSearch entry point at all (mirrors dispatch-deferred.test.ts's own "chat has no
  // ToolSearch" assertion). This must stay true after this fix.
  test("chat has no ToolSearch at all — unaffected by this fix", async () => {
    const h = harness({ mode: "chat" });
    await h.turn("hi");
    const names = new Set((h.provider.requests[0]?.tools ?? []).map((t) => t.name));
    expect(names.has("ToolSearch")).toBe(false);
  });
});
