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
import { registerPushNotificationTool } from "../../src/agent/tools/push-notification";
import { registerAskUserTool } from "../../src/agent/tools/ask-user";
import { registerAskQuestionTool } from "../../src/agent/tools/ask-question";
import { registerSearchTool } from "../../src/agent/tools/search";
import { registerWebTools } from "../../src/agent/tools/web";
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
 * D1-T2 (dispatch toolset): a BEHAVIOURAL harness (real turns through the real engine + registry,
 * never a registry unit test) — the acceptance tripwire the brief calls for. Task 1 widened
 * `deferred` to `boolean | Mode[]` but deliberately left EVERY real engine.ts call site resolving
 * `mode: undefined`, which the fail-closed rule in `isDeferred` treats as deferred. If this task
 * declared `deferred: ["dispatch"]` on bash/task_stop/computer/AskQuestion/send_message and forgot
 * to thread the real per-turn mode through specs()/deferredIndex()/execute()/isDeferredBuiltin(),
 * those tools would silently become deferred in EVERY mode — including code — while every registry
 * unit test (which passes `mode` explicitly) stayed green. Driving a real `code` turn and a real
 * `dispatch` turn through the SAME engine and asserting `bash` is immediate in one and deferred-but-
 * loadable in the other is the only thing that would have caught that.
 *
 * `offered()` is deliberately narrower than mode-toolset-equivalence.test.ts's own helper of the
 * same name: it reports ONLY specs()-visible names (what the provider can call THIS round), never
 * unioned with the deferred bullet list — `deferredBullets()` is the separate, explicit accessor for
 * that. The brief's own tests assert `not.toContain` on `offered()` and `toContain` on
 * `deferredBullets()` for the SAME tool name in the same test, so the two must stay distinct here.
 */
function harness(opts: { mode: "code" | "dispatch" | "chat" }) {
  const home = mkdtempSync(join(tmpdir(), "norma-dispatch-deferred-"));
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "norma-dispatch-deferred-cwd-")));
  const store = new SessionStore(home);
  const hub = new SessionHub(store);
  const registry = new ToolRegistry();
  registerReadTools(registry);
  registerWriteTools(registry);
  // `deferred: ["dispatch"]` on both — mirrors daemon.ts's OWN real registration for these two
  // (the reconciled registration-time constructor flag; see task-stop.ts's/computer.ts's own doc
  // comments), not just the bare `registerXTool(registry)` shape most other harnesses in this repo
  // use. Without this, this harness would understate production: computer/task_stop would read as
  // immediate in dispatch here even though the real daemon defers them.
  registerComputerTool(registry, { deferred: ["dispatch"] });
  registerBashTool(registry);
  registerTaskStopTool(registry, { deferred: ["dispatch"] });
  registerNotebookTool(registry);
  registerSpawnAgentTool(registry);
  registerSessionSpawnTool(registry);
  registerPushNotificationTool(registry);
  registerAskUserTool(registry);
  registerAskQuestionTool(registry);
  registerSearchTool(registry);
  registerWebTools(registry);
  registerToolSearchTool(registry);

  const assemblerHome = mkdtempSync(join(tmpdir(), "norma-dispatch-deferred-actx-"));
  const assemblerTrust = new TrustStore(join(assemblerHome, "trust.json"));
  const skills = new SkillStore({ normaHome: assemblerHome, trust: assemblerTrust });
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
    // Production-shaped (mirrors mode-toolset-equivalence.test.ts / chat-mode-allowlist.test.ts):
    // the config OBJECT present, `enabled` resolving undefined — daemon.ts's real shape when the
    // user never touched toolSearch.enabled. Deliberately NOT `{ enabled: () => true }`.
    toolSearch: { enabled: () => undefined },
  });
  const sessionId = store.createSession("global", { cwd, approvalPolicy: "auto", mode: opts.mode });
  const events: SessionEvent[] = [];
  hub.attach({ clientName: "test-observer", deliver: (e) => { events.push(e); return true; } }, sessionId, 0);

  return {
    provider,
    events,
    turn: async (_message: string) => { await engine.runTurn(sessionId); },
    // specs()-visible names ONLY (never unioned with the deferred bullet list — see this file's
    // own header comment for why that distinction is load-bearing for these exact assertions).
    offered(): string[] {
      return [...new Set(provider.requests.flatMap((r) => (r.tools ?? []).map((t) => t.name)))];
    },
    // Names advertised in the "# Deferred tools" bullet list (buildInstructionsFull's own
    // `- ${name} — ${description}` format) — loadable via ToolSearch, not yet callable.
    deferredBullets(): string[] {
      return [...new Set(
        provider.requests.flatMap((r) => [...(r.instructions ?? "").matchAll(/^- (?!\*\*)(\S+) —/gm)].map((m) => m[1]!)),
      )];
    },
    instructions(): string {
      return provider.requests.at(-1)?.instructions ?? "";
    },
    // Loads a deferred tool's schema for real, through the genuine ToolSearch mechanism — NOT a
    // cheat that reaches into the engine's private loadedTools map. Called synchronously (matching
    // the brief's own test, which never awaits it): it just enqueues a ToolSearch(select:name) call
    // ahead of whatever the caller enqueues next, so the FIRST round of the next turn() actually
    // loads it (registry.execute -> toolsearch.ts's run -> ctx.markToolLoaded) before the round that
    // calls the now-loaded tool for real.
    loadDeferred(name: string): void {
      provider.enqueueToolCall("ToolSearch", { query: `select:${name}` });
    },
    // Attaches a watcher (mirrors chat-ask-question.test.ts's own `autoAnswer` helper) that answers
    // the FIRST observed question_asked with `answer`. Must be called BEFORE turn() — QuestionBroker
    // .wait() is registered by the engine before the emit (synchronous broadcast), so answering as
    // soon as the watcher OBSERVES question_asked (rather than after a fixed delay) never races it.
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
    // Every tool_result this session saw, with its call's NAME resolved from the matching
    // (persisted) tool_call event — tool_result itself carries only callId/output/isError.
    toolResults(): Array<{ name: string; output: string; isError: boolean; callId: string }> {
      const names = new Map<string, string>();
      for (const e of events) if (e.type === "tool_call") names.set(e.callId, e.name);
      return events
        .filter((e): e is Extract<SessionEvent, { type: "tool_result" }> => e.type === "tool_result")
        .map((e) => ({ callId: e.callId, name: names.get(e.callId) ?? "unknown", output: e.output, isError: e.isError }));
    },
  };
}

/** A scripted Provider with a mutable FIFO queue, so a test can enqueue tool calls/text responses
 *  as it goes (`enqueueToolCall`) rather than pre-declaring a fixed script up front the way
 *  FakeProvider (fake-provider.ts) requires — needed here because `loadDeferred`/`answerNextQuestion`
 *  compose additional rounds onto a turn a test is still assembling. Falls back to a plain
 *  end-of-turn text response once the queue drains, so a caller that never enqueues anything (most
 *  of this file's tests) still gets a normal one-round turn. */
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

describe("D1-T2: dispatch's toolset slims to a deferred set + AskQuestion", () => {
  test("bash is immediate in code but deferred in dispatch", async () => {
    const code = await harness({ mode: "code" }); await code.turn("hi");
    const disp = await harness({ mode: "dispatch" }); await disp.turn("hi");
    expect(code.offered()).toContain("bash");
    expect(disp.offered()).not.toContain("bash");
    expect(disp.deferredBullets()).toContain("bash"); // advertised as loadable, not missing
  });

  // The case that proves the whole feature: same tool, opposite treatment, and chat has no ToolSearch.
  test("AskQuestion is immediate in chat and deferred in dispatch", async () => {
    const chat = await harness({ mode: "chat" }); await chat.turn("hi");
    const disp = await harness({ mode: "dispatch" }); await disp.turn("hi");
    expect(chat.offered()).toContain("AskQuestion");
    expect(chat.offered()).not.toContain("ToolSearch");
    expect(disp.offered()).not.toContain("AskQuestion");
    expect(disp.offered()).toContain("ToolSearch");
  });

  // Coverage for the other two of the "five tools deferred" — the brief's own Step 1 tests only
  // drive bash/AskQuestion through a real turn; this closes the gap for the two tools that reach
  // their dispatch-only deferral through the RECONCILED registration-time constructor flag
  // (task-stop.ts/computer.ts) rather than a hardcoded literal, so a regression in THAT plumbing
  // (e.g. daemon.ts's real call site reverting to `deferred: true`, or the widened type silently
  // discarding the array) would still be caught here.
  test("computer and task_stop are immediate in code but deferred in dispatch", async () => {
    const code = await harness({ mode: "code" }); await code.turn("hi");
    const disp = await harness({ mode: "dispatch" }); await disp.turn("hi");
    for (const name of ["computer", "task_stop"]) {
      expect(code.offered()).toContain(name);
      expect(disp.offered()).not.toContain(name);
      expect(disp.deferredBullets()).toContain(name);
    }
  });

  test("dispatch has AskQuestion, not ask_user", async () => {
    const h = await harness({ mode: "dispatch" }); await h.turn("hi");
    expect(h.offered()).not.toContain("ask_user");
    expect([...h.offered(), ...h.deferredBullets()]).toContain("AskQuestion");
    expect(h.instructions()).not.toContain("ask_user");
  });

  test("dispatch's question card carries no header and the answer round-trips", async () => {
    const h = await harness({ mode: "dispatch" });
    h.loadDeferred("AskQuestion");
    h.provider.enqueueToolCall("AskQuestion", { question: "Which?", options: [{ label: "A" }, { label: "B" }] });
    h.answerNextQuestion("A");
    await h.turn("ask me");
    const asked = h.events.find((e) => e.type === "question_asked") as Extract<SessionEvent, { type: "question_asked" }>;
    expect(asked).toBeDefined();
    expect(asked.questions[0]!.header).toBeUndefined();
    expect(h.toolResults().find((r) => r.name === "AskQuestion")?.output).toContain("A");
  });

  // Regression guard for the trap in the spec: push_notification is ALREADY deferred:true (every
  // mode, including dispatch) — narrowing it to ["dispatch"] would make it immediate in code, an
  // unrequested regression. It must stay exactly as it was.
  test("push_notification is unchanged — deferred in BOTH code and dispatch", async () => {
    for (const mode of ["code", "dispatch"] as const) {
      const h = await harness({ mode }); await h.turn("hi");
      expect(h.offered()).not.toContain("push_notification");
      expect(h.deferredBullets()).toContain("push_notification");
    }
  });
});
