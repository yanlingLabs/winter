import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEvent } from "@norma/protocol";
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
import { registerSkillTools } from "../../src/agent/tools/skill";
import { registerPushNotificationTool } from "../../src/agent/tools/push-notification";
import { registerAskUserTool } from "../../src/agent/tools/ask-user";
import { registerWebTools } from "../../src/agent/tools/web";
import { registerLspTools } from "../../src/agent/tools/lsp";
import { registerToolSearchTool } from "../../src/agent/tools/toolsearch";
import { LspManager } from "../../src/agent/lsp/manager";
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
 * CM (chat-mode) branch review, Important 1 + Important 2 — permanent regression coverage for two
 * real bugs the review's probes PROVED (not hypothesized) against a session shaped exactly like
 * production: `toolSearch.enabled` genuinely UNSET (the settings-getter itself resolves undefined,
 * matching daemon.ts's real `projectSettings.effective(...)?.toolSearch?.enabled` when the user
 * never touched the setting) — NOT the `toolSearch: { enabled: () => true }` shape most other
 * deferral tests use (workflow-gating.testkit.ts, engine-spawn.test.ts). See toolSearchEnabled()'s
 * own doc comment in engine.ts: `cfg.toolSearch !== undefined` (the config OBJECT is present) is
 * what flips deferral on; the `enabled` getter resolving undefined just means "not explicitly off".
 *
 * Important 1 (instructions leak): chat's assembled instructions advertised deferred tools
 * (push_notification/web_fetch/web_search/skill_write/lsp) and a "call the Skill tool" header even
 * though CHAT_ALLOW_TOOLS is just {AskQuestion} (B1-T3: was {ask_user} pre-rename) — directly contradicting the base prompt's own "no
 * access to this machine" claim.
 *
 * Important 2 (execution leak): `executeCall` applied the deferral check and the permission gate,
 * but never the thread's allowTools/excludeTools — an off-list `write` call from a real chat
 * session (`approvalPolicy: "auto"`, matching the app's own default) reached registry.execute() and
 * wrote a file to disk.
 *
 * Registers a near-full production tool surface (mirrors dispatch-toolset.test.ts's own "full
 * surface" registry, plus ToolSearch/lsp/a seeded skill, which that file's tests never needed) so
 * these assertions exercise the REAL deferred-index/allowlist machinery end to end, not a trimmed
 * stand-in that could pass for the wrong reason.
 */
function setup(script: ProviderEvent[][], opts: { mode?: "code" | "dispatch" | "chat" } = {}) {
  const home = mkdtempSync(join(tmpdir(), "norma-cm-allowlist-"));
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "norma-cm-allowlist-cwd-")));
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
  registerWebTools(registry);
  registerToolSearchTool(registry);

  const assemblerHome = mkdtempSync(join(tmpdir(), "norma-cm-allowlist-actx-"));
  const assemblerTrust = new TrustStore(join(assemblerHome, "trust.json"));
  const skills = new SkillStore({ normaHome: assemblerHome, trust: assemblerTrust });
  // Seed one real skill so `metas.length > 0` in ContextAssembler — the Skills-header-suppression
  // assertion below is only a REAL assertion (not vacuously true) when there's actually something
  // that would have been listed under "## Available capabilities" otherwise.
  mkdirSync(join(assemblerHome, "skills", "haiku"), { recursive: true });
  writeFileSync(join(assemblerHome, "skills", "haiku", "SKILL.md"), "---\nname: haiku\ndescription: write haikus\n---\nbody\n");
  registerSkillTools(registry, { skills });
  registerSkillWriteTool(registry, { skills });
  const lsp = new LspManager({ serverCommands: {} }); // no real server commands — a call that somehow
  // reached run() would fail on "unsupported file extension"/spawn, never silently succeed; the
  // tests below assert the call is refused BEFORE it gets anywhere near this manager at all.
  registerLspTools(registry, { lsp, cwdOf: () => cwd, rootsOf: () => [cwd] });

  const broker = new ApprovalBroker();
  const provider = new FakeProvider(script);
  const dirs = new SessionDirectories(() => [cwd]);
  const assembler = new ContextAssembler({ normaHome: assemblerHome, trust: assemblerTrust, skills });
  const compactor = new Compactor({ provider: { provider, model: "fake-1" }, store, hub });
  const engine = new AgentEngine({
    store, hub, registry, broker,
    gate: new PermissionGate(),
    provider: { provider, model: "fake-1" },
    dirs, assembler, compactor,
    // Production-shaped (the review's own repro condition): `toolSearch` the CONFIG OBJECT is
    // present (deferral machinery active) but its `enabled` getter resolves undefined — exactly
    // what daemon.ts's real getter does when the user has never touched `toolSearch.enabled` in
    // settings.json. Deliberately NOT `{ enabled: () => true }` (workflow-gating.testkit.ts's own
    // shape) — the review's bug reproduced specifically under the UNTOUCHED default, and a test
    // wired the other way would prove nothing about that default.
    toolSearch: { enabled: () => undefined },
  });
  const sessionId = store.createSession("global", { cwd, approvalPolicy: "auto", mode: opts.mode });
  const events: SessionEvent[] = [];
  hub.attach({ clientName: "test-observer", deliver: (e) => { events.push(e); return true; } }, sessionId, 0);
  return { engine, store, sessionId, provider, cwd, events, registry };
}

const done = (reason: "end_turn" | "tool_calls"): ProviderEvent => ({ type: "done", stopReason: reason });
const text = (t: string): ProviderEvent[] => [{ type: "text_delta", delta: t }, { type: "usage", inputTokens: 10, outputTokens: 2 }, done("end_turn")];
/** Matches buildInstructionsFull's own deferred-list bullet format (`- ${name} — ${description}`)
 *  — a stronger presence/absence check than a bare tool-name substring where a mode's OWN base
 *  prompt prose might also happen to mention the name (dispatch's routing doctrine literally says
 *  "web_search/web_fetch", which would make a plain `.toContain("web_fetch")` pass vacuously). */
const deferredBullet = (name: string) => `- ${name} —`;

function toolResultFor(events: SessionEvent[], callId: string): Extract<SessionEvent, { type: "tool_result" }> {
  const e = events.find((e) => e.type === "tool_result" && e.callId === callId);
  if (!e || e.type !== "tool_result") throw new Error(`expected a tool_result for ${callId}`);
  return e;
}

describe("CM branch review Important 1: chat's instructions never advertise machine-touching tools", () => {
  test("RED (reviewer's own repro): a chat turn's instructions list no deferred tool outside CHAT_ALLOW_TOOLS, and the 'no access to this machine' claim goes unchallenged", async () => {
    const { engine, sessionId, provider } = setup([text("ok")], { mode: "chat" });
    await engine.runTurn(sessionId);
    const instructions = provider.requests[0]?.instructions ?? "";

    expect(instructions).toContain("no access to this machine");
    // Before the fix this block, right after that sentence, listed exactly these five names.
    for (const name of ["lsp", "skill_write", "web_fetch", "web_search", "push_notification"]) {
      expect(instructions).not.toContain(name);
    }
    // CHAT_ALLOW_TOOLS is just {AskQuestion} (B1-T3), which is never deferred — the filtered deferred index
    // is empty, so buildInstructionsFull never emits the section header at all.
    expect(instructions).not.toContain("# Deferred tools");
  });

  test("context.ts fix: the Skills header ('call the Skill tool') is absent for chat — Skill isn't chat-eligible", async () => {
    const { engine, sessionId, provider, registry } = setup([text("ok")], { mode: "chat" });
    await engine.runTurn(sessionId);
    const instructions = provider.requests[0]?.instructions ?? "";
    expect(registry.namesForMode("chat").has("Skill")).toBe(false); // sanity: the premise this test exercises is real
    expect(instructions).not.toContain("call the `Skill` tool");
    expect(instructions).not.toContain("## Available capabilities");
  });
});

describe("CM branch review: code/dispatch deferred blocks unchanged in kind (regression)", () => {
  test("a code session still advertises its deferred tools (lsp/skill_write/push_notification/web_fetch/web_search all present)", async () => {
    const { engine, sessionId, provider } = setup([text("ok")], { mode: "code" });
    await engine.runTurn(sessionId);
    const instructions = provider.requests[0]?.instructions ?? "";
    expect(instructions).toContain("# Deferred tools");
    for (const name of ["lsp", "skill_write", "push_notification", "web_fetch", "web_search"]) {
      expect(instructions).toContain(deferredBullet(name));
    }
    // A code session's own Skills header is unaffected — Skill is never excluded for code.
    expect(instructions).toContain("call the `Skill` tool");
  });

  test("a dispatch session's deferred block narrows to its own eligible tools: push_notification remains, web_fetch/web_search/lsp/skill_write all drop out (R-T3: web_fetch/web_search are no longer dispatch-eligible at all — see dispatch-search.test.ts for the replacement, Search)", async () => {
    const { engine, sessionId, provider, registry } = setup([text("ok")], { mode: "dispatch" });
    await engine.runTurn(sessionId);
    const instructions = provider.requests[0]?.instructions ?? "";
    expect(instructions).toContain("# Deferred tools");
    for (const name of ["push_notification"]) {
      expect(instructions).toContain(deferredBullet(name));
    }
    for (const name of ["lsp", "skill_write", "web_fetch", "web_search"]) {
      expect(instructions).not.toContain(deferredBullet(name));
    }
    // R-T2 fix-round-1: this was "Pre-existing, OUT OF SCOPE gap the review flagged (#7)... this
    // fix deliberately does not paper over" — pinning `DISPATCH_ALLOW_TOOLS.has("ToolSearch") ===
    // false` as the (undesired but accepted) status quo. R-T2's `namesForMode` DOES fix bug #7 for
    // real: a mode with any eligible `deferred:true` tool now always gets ToolSearch alongside it
    // (dispatch has one here now — push_notification; web_fetch/web_search dropped out of
    // dispatch's `modes` entirely in R-T3, they no longer contribute). So this now asserts the
    // FIX, not the gap — `true`, not `false`.
    //
    // R-T3 review finding 3: read what the engine ACTUALLY resolved for this real turn instead of
    // hand-feeding `builtinDeferral: true` into namesForMode directly — a literal here would keep
    // passing even if this harness's own toolSearch wiring stopped being active, describing
    // behavior a real turn no longer has. `provider.requests[...]` is the same real-resolution
    // source every other assertion in this file already reads off.
    expect((provider.requests[0]?.tools ?? []).some((t) => t.name === "ToolSearch")).toBe(true);
    // Dispatch's own Skills header ALSO drops — Skill was never dispatch-eligible either (a
    // same-shape, previously-latent instance of Important 1 this general fix closes for free).
    expect(registry.namesForMode("dispatch", { builtinDeferral: true }).has("Skill")).toBe(false);
    expect(instructions).not.toContain("call the `Skill` tool");
  });
});

describe("CM branch review Important 2: off-list execution is refused, with no side effect", () => {
  test("RED (reviewer's own probe, inverted): a chat session's off-list `write` call is rejected before touching disk", async () => {
    const { engine, sessionId, provider, cwd, events, registry } = setup(
      [
        [{ type: "tool_call", callId: "w1", name: "write", argsJson: JSON.stringify({ path: "pwned.txt", content: "not on my watch!" }) }, done("tool_calls")],
        text("ok"),
      ],
      { mode: "chat" },
    );

    await engine.runTurn(sessionId);

    expect(registry.namesForMode("chat").has("write")).toBe(false); // sanity: write really is off-list for chat
    const result = toolResultFor(events, "w1");
    expect(result.isError).toBe(true);
    expect(result.output).toBe("tool write is not available in this session");
    // The ground-truth check: no file landed, whatever the message says.
    expect(existsSync(join(cwd, "pwned.txt"))).toBe(false);
    // registry.execute() never ran at all — the outcome came back on round 0, not after a real fs op.
    expect(provider.requests.length).toBe(2); // round 0 (the write attempt) + round 1 (end_turn)
  });

  test("the ToolSearch -> lsp chain is refused at the FIRST off-list step: ToolSearch itself is rejected, so lsp is never marked loaded and stays permanently deferred", async () => {
    const { engine, sessionId, events, registry } = setup(
      [
        [{ type: "tool_call", callId: "ts1", name: "ToolSearch", argsJson: JSON.stringify({ query: "select:lsp" }) }, done("tool_calls")],
        [{ type: "tool_call", callId: "l1", name: "lsp", argsJson: JSON.stringify({ action: "diagnostics", file_path: "x.ts" }) }, done("tool_calls")],
        text("ok"),
      ],
      { mode: "chat" },
    );

    await engine.runTurn(sessionId);

    expect(registry.namesForMode("chat").has("ToolSearch")).toBe(false); // sanity
    // Step 1: ToolSearch itself is off chat's allowlist — refused by the NEW allowTools check in
    // executeCall (ToolSearch is not itself `deferred:true`, so it would otherwise have sailed
    // straight through the pre-existing deferral guard to registry.execute() and loaded lsp's
    // schema).
    const tsResult = toolResultFor(events, "ts1");
    expect(tsResult.isError).toBe(true);
    expect(tsResult.output).toBe("tool ToolSearch is not available in this session");

    // Step 2: lsp was NEVER loaded (ToolSearch never ran), so a follow-up call still hits the
    // PRE-EXISTING deferred-tool guard — belt-and-braces proof the chain never reaches the language
    // server at all, via either check.
    const lspResult = toolResultFor(events, "l1");
    expect(lspResult.isError).toBe(true);
    expect(lspResult.output).toBe("tool lsp is deferred — load its schema via ToolSearch first");
  });
});
