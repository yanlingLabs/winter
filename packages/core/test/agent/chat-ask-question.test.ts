import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
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
import { registerSkillTools } from "../../src/agent/tools/skill";
import { registerPushNotificationTool } from "../../src/agent/tools/push-notification";
import { registerAskUserTool } from "../../src/agent/tools/ask-user";
import { registerAskQuestionTool } from "../../src/agent/tools/ask-question";
import { registerSearchTool } from "../../src/agent/tools/search";
import { registerWebTools } from "../../src/agent/tools/web";
import { registerLspTools } from "../../src/agent/tools/lsp";
import { registerToolSearchTool } from "../../src/agent/tools/toolsearch";
import { LspManager } from "../../src/agent/lsp/manager";
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
import { DISPATCH_ALLOW_TOOLS } from "../../src/agent/dispatch-prompt";
import type { ProviderEvent } from "../../src/providers/types";

/**
 * B1-T3: AskQuestion, chat's own simplified question tool (question + option labels + an
 * automatic "Other" free-text field — no header chip, no per-option description, no preview, no
 * notes, no multi-select). A SEPARATE tool rather than a mode-aware `ask_user` because
 * `ToolRegistry.register()` throws on duplicate names and the registry is built ONCE per daemon
 * (daemon.ts), not per session — per-session differentiation is purely name filtering
 * (CHAT_ALLOW_TOOLS).
 *
 * Harness mirrors chat-mode-allowlist.test.ts's own `setup()` — same near-full production tool
 * surface, and the SAME production-shaped `toolSearch: { enabled: () => undefined }` (the config
 * OBJECT present, `enabled` resolving undefined — exactly daemon.ts's real
 * `projectSettings.effective(...)?.toolSearch?.enabled` when the user never touched the setting).
 * Deliberately NOT `{ enabled: () => true }` — that shape is precisely why an earlier round of
 * chat-mode bugs hid from the suite. This file adds a wired QuestionBroker on top (that file never
 * needed ctx.ask to actually resolve — its ask_user probes only check refusal/instructions, never
 * a real answered round trip).
 */
function setup(script: ProviderEvent[][], opts: { mode?: "code" | "dispatch" | "chat" } = {}) {
  const home = mkdtempSync(join(tmpdir(), "norma-cm-askq-"));
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "norma-cm-askq-cwd-")));
  const store = new SessionStore(home);
  const hub = new SessionHub(store);
  const registry = new ToolRegistry();
  registerReadTools(registry);
  registerWriteTools(registry);
  registerComputerTool(registry);
  registerBashTool(registry);
  registerTaskStopTool(registry);
  registerNotebookTool(registry);
  registerSpawnAgentTool(registry);
  registerSessionSpawnTool(registry);
  registerPushNotificationTool(registry);
  registerAskUserTool(registry);
  registerAskQuestionTool(registry);
  registerSearchTool(registry); // B1-T5: CHAT_ALLOW_TOOLS now also lists "Search" — register it in
  // this file's full-surface harness too, or the "offered exactly AskQuestion" assertion below
  // would pass vacuously (nothing to prove Search rides along) rather than actually re-verifying
  // the updated allowlist.
  registerWebTools(registry);
  registerToolSearchTool(registry);

  const assemblerHome = mkdtempSync(join(tmpdir(), "norma-cm-askq-actx-"));
  const assemblerTrust = new TrustStore(join(assemblerHome, "trust.json"));
  const skills = new SkillStore({ normaHome: assemblerHome, trust: assemblerTrust });
  // Seed one real skill so the Skills-header-suppression machinery (context.ts) has something to
  // suppress — mirrors chat-mode-allowlist.test.ts's own rationale; not itself under test here.
  mkdirSync(join(assemblerHome, "skills", "haiku"), { recursive: true });
  writeFileSync(join(assemblerHome, "skills", "haiku", "SKILL.md"), "---\nname: haiku\ndescription: write haikus\n---\nbody\n");
  registerSkillTools(registry, { skills });
  registerSkillWriteTool(registry, { skills });
  const lsp = new LspManager({ serverCommands: {} });
  registerLspTools(registry, { lsp, cwdOf: () => cwd, rootsOf: () => [cwd] });

  const broker = new ApprovalBroker();
  const provider = new FakeProvider(script);
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
    approvalTimeoutMs: 500,
    toolSearch: { enabled: () => undefined },
  });
  const sessionId = store.createSession("global", { cwd, approvalPolicy: "auto", mode: opts.mode });
  const events: SessionEvent[] = [];
  hub.attach({ clientName: "test-observer", deliver: (e) => { events.push(e); return true; } }, sessionId, 0);
  return { engine, store, hub, questions, sessionId, provider, cwd, events };
}

const done = (reason: "end_turn" | "tool_calls"): ProviderEvent => ({ type: "done", stopReason: reason });
const text = (t: string): ProviderEvent[] => [{ type: "text_delta", delta: t }, { type: "usage", inputTokens: 10, outputTokens: 2 }, done("end_turn")];
const call = (callId: string, name: string, args: unknown): ProviderEvent[] =>
  [{ type: "tool_call", callId, name, argsJson: JSON.stringify(args) }, done("tool_calls")];

function toolResultFor(events: SessionEvent[], callId: string): Extract<SessionEvent, { type: "tool_result" }> {
  const e = events.find((e) => e.type === "tool_result" && e.callId === callId);
  if (!e || e.type !== "tool_result") throw new Error(`expected a tool_result for ${callId}`);
  return e;
}

/** Answers the FIRST question_asked observed with `answer`, keyed by whatever question text the
 *  tool emits — mirrors engine-ask-tasks.test.ts's watcher pattern. QuestionBroker.wait() is
 *  registered by the engine BEFORE the emit (broadcast is synchronous), so responding as soon as
 *  the watcher OBSERVES question_asked (rather than after some fixed delay) is what avoids racing
 *  the broker. */
function autoAnswer(hub: SessionHub, questions: QuestionBroker, sessionId: string, answer: string): void {
  const watcher: HubClient = {
    clientName: "answerer",
    deliver(e) {
      if (e.type === "question_asked") {
        const q = e.questions[0]!;
        questions.respond(sessionId, e.callId, { [q.question]: answer }, "test");
      }
      return true;
    },
  };
  hub.attach(watcher, sessionId, 0);
}

describe("AskQuestion — the simplified chat card", () => {
  test("emits a question_asked with no header, labels only, single-select", async () => {
    const { engine, store, hub, questions, sessionId } = setup(
      [
        call("aq1", "AskQuestion", {
          question: "Which tier should I compare against?",
          options: [{ label: "Free" }, { label: "Pro" }],
        }),
        text("thanks"),
      ],
      { mode: "chat" },
    );
    autoAnswer(hub, questions, sessionId, "Pro");

    await engine.runTurn(sessionId);

    const events = store.read(sessionId);
    const asked = events.find((e) => e.type === "question_asked");
    expect(asked).toBeDefined();
    const q = (asked as Extract<SessionEvent, { type: "question_asked" }>).questions[0]!;
    expect(q.header).toBeUndefined();
    // Genuinely absent, not just undefined-valued — the whole point of the slice (Task 2's
    // optional header) is that a simplified card is a different SHAPE, not a rendering trick.
    expect(Object.prototype.hasOwnProperty.call(q, "header")).toBe(false);
    expect(q.multiSelect).toBe(false);
    expect(q.options).toEqual([{ label: "Free" }, { label: "Pro" }]);
    expect(q.options.every((o) => o.description === undefined)).toBe(true);
  });

  test("the user's answer reaches the model", async () => {
    const { engine, store, hub, questions, sessionId } = setup(
      [
        call("aq1", "AskQuestion", { question: "Which tier?", options: [{ label: "Free" }, { label: "Pro" }] }),
        text("thanks"),
      ],
      { mode: "chat" },
    );
    autoAnswer(hub, questions, sessionId, "Pro");

    await engine.runTurn(sessionId);

    const events = store.read(sessionId);
    const result = toolResultFor(events, "aq1");
    expect(result.isError).toBe(false);
    expect(result.output).toContain("Pro");
  });

  test("a chat turn is offered exactly AskQuestion and Search — ask_user is gone", async () => {
    const { engine, sessionId, provider } = setup([text("hello")], { mode: "chat" });
    await engine.runTurn(sessionId);
    const offered = (provider.requests[0]?.tools ?? []).map((t) => t.name).sort();
    expect(offered).toEqual(["AskQuestion", "Search"]);
  });

  test("off-list ask_user in a chat session is refused (Slice A's guard covers the rename)", async () => {
    const { engine, store, sessionId } = setup(
      [call("au1", "ask_user", { questions: [] }), text("ok")],
      { mode: "chat" },
    );
    await engine.runTurn(sessionId);
    const events = store.read(sessionId);
    const result = toolResultFor(events, "au1");
    expect(result.isError).toBe(true);
    expect(result.output).toContain("not available in this session");
  });

  test("code mode still has ask_user and NOT AskQuestion, and NOT Search either", async () => {
    const { engine, sessionId, provider } = setup([text("hello")], { mode: "code" });
    await engine.runTurn(sessionId);
    const offered = (provider.requests[0]?.tools ?? []).map((t) => t.name);
    expect(offered).toContain("ask_user");
    expect(offered).not.toContain("AskQuestion");
    // B1-T5: this file's harness now also registers Search (registerSearchTool above) — code mode
    // must still exclude it via CHAT_ONLY_TOOLS, same as AskQuestion (this harness's `toolSearch:
    // { enabled: () => undefined }` keeps built-in deferral active, which is why web_search itself
    // doesn't show up here either — deferred, not excluded; that's covered by web.test.ts, not
    // this file).
    expect(offered).not.toContain("Search");
  });

  // Fix round 1: the exclusion above must be SURGICAL — code's real toolset (read/write/bash/
  // ask_user at minimum) must be completely unaffected by CHAT_ONLY_TOOLS being folded into
  // engine.ts's code-mode excludeTools. Guards against a blanket exclusion that clips more than
  // just the chat-only names.
  test("code mode's offered toolset is otherwise unaffected — read/write/bash/ask_user all still present", async () => {
    const { engine, sessionId, provider } = setup([text("hello")], { mode: "code" });
    await engine.runTurn(sessionId);
    const offered = (provider.requests[0]?.tools ?? []).map((t) => t.name);
    for (const expected of ["read", "write", "bash", "ask_user"]) {
      expect(offered).toContain(expected);
    }
  });

  // Fix round 1: dispatch is unaffected by construction (DISPATCH_ALLOW_TOOLS is an allowlist that
  // simply never names AskQuestion) — asserted directly rather than assumed, per the coordinator's
  // instruction, and cross-checked against the live offered toolset too.
  test("dispatch is unaffected: DISPATCH_ALLOW_TOOLS never lists AskQuestion, and a dispatch turn is never offered it", async () => {
    expect(DISPATCH_ALLOW_TOOLS.has("AskQuestion")).toBe(false);
    const { engine, sessionId, provider } = setup([text("hello")], { mode: "dispatch" });
    await engine.runTurn(sessionId);
    const offered = (provider.requests[0]?.tools ?? []).map((t) => t.name);
    expect(offered).not.toContain("AskQuestion");
    // B1-T5: same story for Search — DISPATCH_ALLOW_TOOLS is an allowlist that never names it.
    expect(DISPATCH_ALLOW_TOOLS.has("Search")).toBe(false);
    expect(offered).not.toContain("Search");
  });
});
