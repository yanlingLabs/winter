import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
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
import { registerPushNotificationTool } from "../../src/agent/tools/push-notification";
import { registerAskUserTool } from "../../src/agent/tools/ask-user";
import { registerAskQuestionTool } from "../../src/agent/tools/ask-question";
import { registerSearchTool } from "../../src/agent/tools/search";
import { registerWebTools } from "../../src/agent/tools/web";
import { registerToolSearchTool } from "../../src/agent/tools/toolsearch";
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
 * R-T2 (the flip): pins the EXACT offered toolset per mode ACROSS the derivation refactor. Chat
 * and code must not move at all; dispatch's three intended differences are Task 3's, not this
 * one. Modeled on chat-mode-allowlist.test.ts's own harness — full production tool surface,
 * production-shaped `toolSearch: { enabled: () => undefined }` (the config OBJECT present, its
 * `enabled` getter resolving undefined — daemon.ts's real shape when the user never touched the
 * setting), never the `{ enabled: () => true }` shorthand other, less careful tests use. Every
 * assertion reads a REAL turn's `provider.requests[...].tools`, never a constant — the constants
 * are exactly what this refactor deletes/stops trusting.
 */
function harness(opts: { mode: "code" | "dispatch" | "chat"; extraTool?: string }) {
  const home = mkdtempSync(join(tmpdir(), "norma-mode-toolset-eq-"));
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "norma-mode-toolset-eq-cwd-")));
  const store = new SessionStore(home);
  const hub = new SessionHub(store);
  const registry = new ToolRegistry();
  // Full production surface — every tool a code session would see, PLUS chat's own
  // AskQuestion/Search and the dispatch-eligible set, all in the SAME shared registry (matching
  // daemon.ts's real single-registry-per-daemon shape).
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
  registerSearchTool(registry);
  registerWebTools(registry);
  registerToolSearchTool(registry);
  if (opts.extraTool) {
    // A tool registered with NO `modes` field at all — the property this whole refactor exists to
    // get right: absent `modes` must mean code-only, without anyone having to enumerate it into an
    // exclusion list (the old CHAT_ONLY_TOOLS/DISPATCH_ALLOW_TOOLS shape this task deletes).
    registry.register({ name: opts.extraTool, description: "probe tool, no modes declared", args: z.object({}), run: () => "ok" });
  }

  const assemblerHome = mkdtempSync(join(tmpdir(), "norma-mode-toolset-eq-actx-"));
  const assemblerTrust = new TrustStore(join(assemblerHome, "trust.json"));
  const skills = new SkillStore({ normaHome: assemblerHome, trust: assemblerTrust });
  const broker = new ApprovalBroker();
  const provider = new FakeProvider([
    [{ type: "text_delta", delta: "hi" }, { type: "usage", inputTokens: 10, outputTokens: 2 }, { type: "done", stopReason: "end_turn" }],
  ] as ProviderEvent[][]);
  const dirs = new SessionDirectories(() => [cwd]);
  const assembler = new ContextAssembler({ normaHome: assemblerHome, trust: assemblerTrust, skills });
  const compactor = new Compactor({ provider: { provider, model: "fake-1" }, store, hub });
  const engine = new AgentEngine({
    store, hub, registry, broker,
    gate: new PermissionGate(),
    provider: { provider, model: "fake-1" },
    dirs, assembler, compactor,
    // Production-shaped, deliberately NOT `{ enabled: () => true }` — see this file's own doc
    // comment and chat-mode-allowlist.test.ts's identical rationale.
    toolSearch: { enabled: () => undefined },
  });
  const sessionId = store.createSession("global", { cwd, approvalPolicy: "auto", mode: opts.mode });

  return {
    turn: async (_message: string) => { await engine.runTurn(sessionId); },
    // "Offered" = the union of what THIS turn's provider request could act on: names in the
    // live `tools` spec list (directly callable, or already-loaded-if-deferred) PLUS names
    // advertised in the "# Deferred tools" instructions bullet (`- ${name} — ${description}`,
    // buildInstructionsFull's own format — mirrors chat-mode-allowlist.test.ts's `deferredBullet`
    // helper). A tool's toolAccess membership (what THIS test pins) is orthogonal to whether
    // ToolSearch deferral currently HIDES it from the live spec list — production-shaped
    // `toolSearch: { enabled: () => undefined }` above means web_fetch/web_search/push_notification
    // ARE deferred here, so checking specs() alone would wrongly read "excluded" for tools that
    // are actually mode-eligible but simply not yet loaded. Both fields come from the SAME real
    // `provider.requests[...]` entry — never a constant.
    offered: (): string[] => {
      const specNames = provider.requests.flatMap((r) => (r.tools ?? []).map((t) => t.name));
      // R-T3: negative lookahead excludes the "## Available capabilities" skills bullets
      // (`- **name** — description`, context.ts) — a code session's Skills listing shares the
      // same `- X — ` bullet shape as the "# Deferred tools" section but is a DIFFERENT list
      // (available skills, not deferred tools); without excluding the bold form here, this test's
      // new exact-toEqual pins below would spuriously fail the moment any built-in skill (e.g.
      // `writing-skills`) is present, for a reason that has nothing to do with mode eligibility.
      const deferredNames = provider.requests.flatMap((r) => [...(r.instructions ?? "").matchAll(/^- (?!\*\*)(\S+) —/gm)].map((m) => m[1]!));
      return [...new Set([...specNames, ...deferredNames])];
    },
  };
}

describe("mode toolsets are unchanged by the derivation refactor", () => {
  test("chat is offered exactly Search + AskQuestion", async () => {
    const h = harness({ mode: "chat" });
    await h.turn("hi");
    expect(h.offered().sort()).toEqual(["AskQuestion", "Search"]);
  });

  test("code's offered set is unchanged", async () => {
    const h = harness({ mode: "code" });
    await h.turn("hi");
    const offered = h.offered();
    for (const t of ["read", "write", "edit", "bash", "glob", "grep", "ls", "ask_user",
                     "web_fetch", "web_search", "spawn_agent", "computer", "notebook_edit"]) {
      expect(offered).toContain(t);
    }
    for (const t of ["Search", "AskQuestion", "session_spawn"]) expect(offered).not.toContain(t);
  });

  // R-T3 review finding 2: a reviewer proved by mutation that a tool wrongly declaring
  // `modes: ["code","dispatch"]` joins dispatch with the entire suite green — equally true before
  // this refactor, so not a regression, but the decision is now spread across a dozen tool files
  // instead of one reviewable literal (the old DISPATCH_ALLOW_TOOLS/CHAT_ALLOW_TOOLS constants).
  // These two pin the EXACT set this harness's full production surface resolves to, so a stray
  // `modes` entry on ANY tool file trips an exact-equality failure here, not just a subset check.
  // D1-T2: "ask_user" -> "AskQuestion" — ask-user.ts drops "dispatch" from its own `modes`;
  // ask-question.ts (previously chat-only) gains it, deferred there (immediate in chat). `offered()`
  // here is the union of specs()-visible names AND the deferred-bullet list, so AskQuestion (and
  // bash/task_stop/computer's own now-dispatch-deferred status) still counts as "offered" — this
  // pin is about ELIGIBILITY moving from ask_user to AskQuestion, not about anything dropping off
  // dispatch's toolset. push_notification's presence is unaffected (already deferred:true, untouched
  // by this task). (Fix round 1, optional: send_message was never registered in this file's own
  // `harness()` — this comment previously named it here in error. The census test
  // (mode-toolset-census.test.ts), which boots the real daemon/registry, is the one that actually
  // covers send_message's dispatch eligibility — by design, per this file's own R-T3 doc comment
  // above about not hand-mirroring every register* call.)
  test("dispatch is offered EXACTLY this set (R-T3: web_fetch/web_search dropped, Search kept; D1-T2: AskQuestion replaces ask_user)", async () => {
    const h = harness({ mode: "dispatch" });
    await h.turn("hi");
    expect(h.offered().sort()).toEqual([
      "Search", "ToolSearch", "AskQuestion", "bash", "computer", "glob", "grep", "ls",
      "push_notification", "read", "session_spawn", "task_stop",
    ].sort());
  });

  test("code is offered EXACTLY this set", async () => {
    const h = harness({ mode: "code" });
    await h.turn("hi");
    expect(h.offered().sort()).toEqual([
      "ToolSearch", "ask_user", "bash", "computer", "edit", "glob", "grep", "ls",
      "notebook_edit", "push_notification", "read", "spawn_agent", "task_stop",
      "web_fetch", "web_search", "write",
    ].sort());
  });

  test("a modes-less tool registered fresh reaches code but NOT chat or dispatch", async () => {
    // The property that replaces CHAT_ONLY_TOOLS. Drive real turns; do not read the constant.
    for (const [mode, want] of [["code", true], ["chat", false], ["dispatch", false]] as const) {
      const h = harness({ mode, extraTool: "ZZProbeDefault" }); // registered with no `modes`
      await h.turn("hi");
      expect(h.offered().includes("ZZProbeDefault")).toBe(want);
    }
  });
});
