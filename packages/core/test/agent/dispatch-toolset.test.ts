import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../../src/sessions/store";
import { SessionHub } from "../../src/sessions/hub";
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
import { registerWebTools } from "../../src/agent/tools/web";
import { registerLspTools } from "../../src/agent/tools/lsp";
import { LspManager } from "../../src/agent/lsp/manager";
import { PermissionGate } from "../../src/agent/gate";
import { ApprovalBroker } from "../../src/agent/approvals";
import { AgentEngine } from "../../src/agent/engine";
import { FakeProvider } from "../../src/agent/fake-provider";
import { SessionDirectories } from "../../src/agent/dirs";
import { ContextAssembler, BASE_PROMPT } from "../../src/agent/context";
import { TrustStore } from "../../src/agent/trust";
import { SkillStore } from "../../src/agent/skills";
import { Compactor } from "../../src/agent/compactor";
import { assistantMemoryDirFor } from "../../src/agent/memory-dir";
import type { ProviderEvent } from "../../src/providers/types";

// Full-surface registry: every tool a code session sees, INCLUDING the six that must never be
// dispatch-visible (write, edit, notebook_edit, spawn_agent, skill_write, lsp) PLUS session_spawn
// (Task 4), which flips the OTHER way — dispatch-visible, never code-visible (engine.ts's
// SESSION_SPAWN_TOOL exclusion) — so the "does NOT include"/"does include" assertions below in
// BOTH directions are actually exercising the allowTools/excludeTools filters, not a vacuous
// absence.
function setup(script: ProviderEvent[][], opts: { mode?: "code" | "dispatch" | "chat" } = {}) {
  const home = mkdtempSync(join(tmpdir(), "norma-dispatch-toolset-"));
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "norma-dispatch-toolset-cwd-")));
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
  // B1-T3: chat's own AskQuestion — chat's allowlist is now {AskQuestion}, not {ask_user}. Must be
  // registered here or a chat turn's offered toolset would be (wrongly) empty below.
  registerAskQuestionTool(registry);
  registerWebTools(registry);
  const assemblerHome = mkdtempSync(join(tmpdir(), "norma-dispatch-toolset-actx-"));
  const assemblerTrust = new TrustStore(join(assemblerHome, "trust.json"));
  const skills = new SkillStore({ normaHome: assemblerHome, trust: assemblerTrust });
  registerSkillWriteTool(registry, { skills });
  const lsp = new LspManager({ serverCommands: {} });
  registerLspTools(registry, { lsp, cwdOf: () => cwd, rootsOf: () => [cwd] });

  const broker = new ApprovalBroker();
  const provider = new FakeProvider(script);
  const dirs = new SessionDirectories(() => [cwd]);
  // Dreaming (Phase 7b, Task 1): wired unconditionally (not opt-in) so test 5 below can seed
  // `assemblerHome`'s `_assistant` bucket and exercise the engine's REAL memoryBucket threading —
  // this is inert for the other tests in this file (assemblerHome starts empty, so `dirFor`'s
  // project bucket has no MEMORY.md and the assistant bucket is untouched unless a test seeds it).
  const assembler = new ContextAssembler({
    normaHome: assemblerHome, trust: assemblerTrust, skills,
    memory: {
      enabled: () => true,
      dirFor: () => join(assemblerHome, "projects", "code-proj", "memory"),
      assistantDir: () => assistantMemoryDirFor({ normaHome: assemblerHome }),
    },
  });
  const compactor = new Compactor({ provider: { provider, model: "fake-1" }, store, hub });
  const engine = new AgentEngine({
    store, hub, registry, broker,
    gate: new PermissionGate(),
    provider: { provider, model: "fake-1" },
    dirs, assembler, compactor,
  });
  const sessionId = store.createSession("global", { cwd, approvalPolicy: "auto", mode: opts.mode });
  return { engine, store, sessionId, provider, cwd, assemblerHome };
}

const done = (reason: "end_turn" | "tool_calls"): ProviderEvent => ({ type: "done", stopReason: reason });
const text = (t: string): ProviderEvent[] => [{ type: "text_delta", delta: t }, { type: "usage", inputTokens: 10, outputTokens: 2 }, done("end_turn")];

describe("dispatch mode: toolset + system prompt", () => {
  // R-T2 fix-round-1: dropped the `for (const n of names) expect(DISPATCH_ALLOW_TOOLS.has(n))
  // .toBe(true)` subset check this test used to open with — `names` (the offered set) is now
  // ITSELF filtered by `registry.namesForMode("dispatch", ...)` in production, so re-checking
  // membership against that same derivation would be tautological (always true by construction),
  // not an independent cross-check like it was against the old hand-maintained constant. The real
  // invariants — which names are present/absent — are pinned by the explicit checks below instead.
  test("dispatch session: provider-visible tools include session_spawn-eligible names, exclude write/edit/lsp/spawn_agent/skill_write/notebook_edit", async () => {
    const { engine, sessionId, provider } = setup([text("ok")], { mode: "dispatch" });
    await engine.runTurn(sessionId);
    const names = new Set((provider.requests[0]?.tools ?? []).map((t) => t.name));

    expect(names.has("bash")).toBe(true);
    // Task 4: session_spawn is now registered AND whitelisted — present for a dispatch session.
    expect(names.has("session_spawn")).toBe(true);

    // R-T3: web_fetch/web_search dropped from dispatch's modes — they were `deferred: true` and
    // dispatch (this harness) has no ToolSearch registered at all, so they were advertised here
    // but could never actually be called (bug #7). Dispatch now uses Search (search.ts) instead;
    // its own harness in mode-toolset-equivalence.test.ts / dispatch-search.test.ts pins that.
    for (const excluded of ["write", "edit", "lsp", "spawn_agent", "skill_write", "notebook_edit", "web_fetch", "web_search"]) {
      expect(names.has(excluded)).toBe(false);
    }
  });

  test("code session: same registry sees write/edit unchanged (regression), session_spawn excluded", async () => {
    const { engine, sessionId, provider } = setup([text("ok")], { mode: "code" });
    await engine.runTurn(sessionId);
    const names = new Set((provider.requests[0]?.tools ?? []).map((t) => t.name));

    for (const expected of ["write", "edit", "lsp", "spawn_agent", "skill_write", "notebook_edit", "bash", "read"]) {
      expect(names.has(expected)).toBe(true);
    }
    // Task 4: session_spawn is dispatch-only — a code session must never see it (engine.ts's
    // SESSION_SPAWN_TOOL exclusion, the mirror image of the six tools excluded above).
    expect(names.has("session_spawn")).toBe(false);
  });

  test("dispatch turn's instructions carry Dispatch-mode doctrine and NOT the code base prompt's file-paths sentence", async () => {
    const { engine, sessionId, provider } = setup([text("ok")], { mode: "dispatch" });
    await engine.runTurn(sessionId);
    const instructions = provider.requests[0]?.instructions ?? "";
    expect(instructions).toContain("Dispatch mode");
    expect(instructions).not.toContain("file tool paths are relative to it");
    expect(BASE_PROMPT).toContain("file tool paths are relative to it"); // sanity: the sentence we assert absent is real
  });

  test("code turn's instructions still carry the code base prompt (regression)", async () => {
    const { engine, sessionId, provider } = setup([text("ok")], { mode: "code" });
    await engine.runTurn(sessionId);
    const instructions = provider.requests[0]?.instructions ?? "";
    expect(instructions).toContain("file tool paths are relative to it");
    expect(instructions).not.toContain("Dispatch mode");
  });

  test("dispatch turn loads the _assistant memory index; a code turn (same harness) loads neither it nor its protocol", async () => {
    const dispatchHarness = setup([text("ok")], { mode: "dispatch" });
    mkdirSync(assistantMemoryDirFor({ normaHome: dispatchHarness.assemblerHome }), { recursive: true });
    writeFileSync(
      join(assistantMemoryDirFor({ normaHome: dispatchHarness.assemblerHome }), "MEMORY.md"),
      "- [alex](alex.md) — builds Norma\n",
    );
    await dispatchHarness.engine.runTurn(dispatchHarness.sessionId);
    const dispatchInstructions = dispatchHarness.provider.requests[0]?.instructions ?? "";
    expect(dispatchInstructions).toContain("Assistant memory index");
    expect(dispatchInstructions).toContain("alex");

    const codeHarness = setup([text("ok")], { mode: "code" });
    mkdirSync(assistantMemoryDirFor({ normaHome: codeHarness.assemblerHome }), { recursive: true });
    writeFileSync(
      join(assistantMemoryDirFor({ normaHome: codeHarness.assemblerHome }), "MEMORY.md"),
      "- [alex](alex.md) — builds Norma\n",
    );
    await codeHarness.engine.runTurn(codeHarness.sessionId);
    const codeInstructions = codeHarness.provider.requests[0]?.instructions ?? "";
    expect(codeInstructions).not.toContain("Assistant memory index");
    expect(codeInstructions).not.toContain("alex");
  });
});

describe("chat mode (Slice A): toolset + system prompt + memory", () => {
  test("a chat turn offers ONLY AskQuestion — no hands", async () => {
    const { engine, sessionId, provider } = setup([text("ok")], { mode: "chat" });
    await engine.runTurn(sessionId);
    const names = new Set((provider.requests[0]?.tools ?? []).map((t) => t.name));

    expect(names).toEqual(new Set(["AskQuestion"])); // B1-T3: was {ask_user} pre-rename
    for (const forbidden of ["write", "edit", "bash", "read", "glob", "grep", "ls", "lsp", "session_spawn"]) {
      expect(names.has(forbidden)).toBe(false);
    }
  });

  test("a chat turn uses the chat base prompt, not Dispatch's or code's", async () => {
    const { engine, sessionId, provider } = setup([text("ok")], { mode: "chat" });
    await engine.runTurn(sessionId);
    const instructions = provider.requests[0]?.instructions ?? "";
    expect(instructions).toContain("Chat mode");
    expect(instructions).not.toContain("Dispatch mode");
    expect(instructions).not.toContain("file tool paths are relative to it");
  });

  test("a chat turn assembles the ASSISTANT memory bucket, not the project one (mirrors dispatch)", async () => {
    const chatHarness = setup([text("ok")], { mode: "chat" });
    mkdirSync(assistantMemoryDirFor({ normaHome: chatHarness.assemblerHome }), { recursive: true });
    writeFileSync(
      join(assistantMemoryDirFor({ normaHome: chatHarness.assemblerHome }), "MEMORY.md"),
      "- [alex](alex.md) — builds Norma\n",
    );
    await chatHarness.engine.runTurn(chatHarness.sessionId);
    const chatInstructions = chatHarness.provider.requests[0]?.instructions ?? "";
    expect(chatInstructions).toContain("Assistant memory index");
    expect(chatInstructions).toContain("alex");
    expect(chatInstructions).not.toContain("Project memory index");
  });

  test("code and dispatch turns are byte-unchanged by chat's arrival (regression)", async () => {
    const dispatchHarness = setup([text("ok")], { mode: "dispatch" });
    await dispatchHarness.engine.runTurn(dispatchHarness.sessionId);
    const dispatchNames = new Set((dispatchHarness.provider.requests[0]?.tools ?? []).map((t) => t.name));
    // R-T2 fix-round-1: same tautology as the test above — dropped the subset check against the
    // now-deleted DISPATCH_ALLOW_TOOLS constant; the explicit presence/absence checks below are
    // the real, non-circular invariants.
    expect(dispatchNames.has("bash")).toBe(true);
    expect(dispatchNames.has("session_spawn")).toBe(true);
    const dispatchInstructions = dispatchHarness.provider.requests[0]?.instructions ?? "";
    expect(dispatchInstructions).toContain("Dispatch mode");

    const codeHarness = setup([text("ok")], { mode: "code" });
    await codeHarness.engine.runTurn(codeHarness.sessionId);
    const codeNames = new Set((codeHarness.provider.requests[0]?.tools ?? []).map((t) => t.name));
    for (const expected of ["write", "edit", "lsp", "spawn_agent", "skill_write", "notebook_edit", "bash", "read"]) {
      expect(codeNames.has(expected)).toBe(true);
    }
    expect(codeNames.has("session_spawn")).toBe(false);
    const codeInstructions = codeHarness.provider.requests[0]?.instructions ?? "";
    expect(codeInstructions).toContain("file tool paths are relative to it");
    expect(codeInstructions).not.toContain("Dispatch mode");
    expect(codeInstructions).not.toContain("Chat mode");
  });
});
