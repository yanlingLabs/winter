import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon, type RunningDaemon } from "../../src/daemon";
import { FileSecretStore } from "../../src/auth/secret-store";
import { FakeProvider } from "../../src/agent/fake-provider";

/**
 * R-T3 whole-branch review, Important 1 (FIX 1). mode-toolset-equivalence.test.ts pins the EXACT
 * offered set per mode — strong, but only for the ~14 register* calls its own harness function
 * mirrors. daemon.ts makes ~24 register*Tool(s) calls; the reviewer proved by mutation that a
 * stray `modes` entry on any tool NOT in that harness (schedule, send_message, bash_output,
 * agent_list, agent_output, exit_plan_mode, enter_plan_mode, task_create/_update/_list/_get,
 * list_mcp_resources/read_mcp_resource) sails through the full 2701-test suite untouched — the
 * exact scenario the deleted CHAT_ALLOW_TOOLS/DISPATCH_ALLOW_TOOLS parity test WOULD have caught
 * (adding "schedule" to CHAT_ALLOW_TOOLS alone used to fail it).
 *
 * Two ways to close this were on the table: (a) grow mode-toolset-equivalence.test.ts's harness to
 * mirror every one of daemon.ts's register* calls, or (b) stop mirroring daemon.ts's registration
 * and instead walk it directly. (a) is a second hand-maintained list — exactly the shape this
 * whole refactor deletes elsewhere, and it silently re-opens the same hole the day daemon.ts grows
 * a 25th register* call nobody remembers to mirror into the test file too. (b) has no such gap by
 * construction: it boots `startDaemon()` for real — the SAME precedent server.test.ts,
 * ipc/remote-allowlist-parity.test.ts, and routines/e2e.test.ts already use for "prove it against
 * the real daemon, not a stand-in" coverage — with a temp NORMA_HOME and an injected FakeProvider
 * (no network/creds/API calls), then reads `daemon.registry`: literally the SAME ToolRegistry
 * instance every one of daemon.ts's register* calls populates at boot (threaded out via
 * RunningDaemon.registry — daemon.ts). There is no second harness to fall out of sync, because
 * there is no second harness — this IS daemon.ts's own registration path.
 *
 * The trade-off the reviewer flagged for (b) — "not a brittle snapshot nobody updates thoughtfully"
 * — is why the expected sets below are hand-written literals (mirroring
 * mode-toolset-equivalence.test.ts's own pins), not machine-generated: adding a 25th tool means a
 * human deliberately decides which of these three literals it belongs in, same review-friction the
 * deleted CHAT_ALLOW_TOOLS constant used to force, not a snapshot file nobody reads before
 * accepting.
 *
 * `computerUse.enabled: true` is set in this test's settings.json so `computer` (off by default)
 * joins the census too — every other tool below registers unconditionally inside daemon.ts's
 * `if (agentProvider)` gate regardless of settings. No mcpServers/plugins are configured, so no
 * `mcp__`/`plugin__` dynamic names appear — those are runtime-discovered, not `modes`-declared, and
 * out of scope for a static per-tool-file census.
 */
function tempHomeWithSettings(): string {
  const home = mkdtempSync(join(tmpdir(), "norma-tool-census-"));
  writeFileSync(
    join(home, "settings.json"),
    JSON.stringify(
      {
        schemaVersion: 2,
        // Never actually used to create a live provider — startDaemon's injected `agentProvider`
        // below (a FakeProvider) short-circuits createProvider() entirely. Present only because
        // Settings.provider is a required field.
        provider: { type: "codex-oauth", model: "gpt-5.4" },
        computerUse: { enabled: true },
      },
      null,
      2,
    ),
  );
  return home;
}

describe("daemon tool census (R-T3 whole-branch review FIX 1): real registration path pins each mode's derived set", () => {
  let daemon: RunningDaemon | undefined;
  let home: string | undefined;

  afterEach(() => {
    daemon?.stop();
    daemon = undefined;
    if (home) rmSync(home, { recursive: true, force: true });
    home = undefined;
  });

  async function boot(): Promise<RunningDaemon> {
    home = tempHomeWithSettings();
    const secrets = new FileSecretStore(join(home, "test-secrets"));
    daemon = await startDaemon({
      home,
      secrets,
      agentProvider: { provider: new FakeProvider([]), model: "fake-1" },
    });
    return daemon;
  }

  test("code mode is offered EXACTLY the full daemon tool surface (35 tools)", async () => {
    const d = await boot();
    expect(d.registry).not.toBeNull();
    const offered = [...d.registry!.namesForMode("code", { builtinDeferral: true })];
    expect(offered.sort()).toEqual(
      [
        "read", "ls", "glob", "grep",
        "write", "edit",
        "bash", "bash_output",
        "Skill", "ToolSearch",
        "ask_user",
        "task_create", "task_update", "task_list", "task_get",
        "exit_plan_mode", "enter_plan_mode",
        "notebook_edit",
        "push_notification",
        "enter_worktree", "exit_worktree",
        "web_fetch", "web_search",
        "spawn_agent",
        "send_message",
        "task_stop",
        "agent_list", "agent_output",
        "skill_write",
        "computer",
        "schedule",
        "lsp",
        "list_mcp_resources", "read_mcp_resource",
        "Workflow",
      ].sort(),
    );
  });

  test("dispatch mode is offered EXACTLY this set (12 tools)", async () => {
    const d = await boot();
    const offered = [...d.registry!.namesForMode("dispatch", { builtinDeferral: true })];
    expect(offered.sort()).toEqual(
      [
        "Search", "ToolSearch", "ask_user", "bash", "computer", "glob", "grep", "ls",
        "push_notification", "read", "session_spawn", "task_stop",
      ].sort(),
    );
  });

  test("chat mode is offered EXACTLY Search + AskQuestion", async () => {
    const d = await boot();
    const offered = [...d.registry!.namesForMode("chat", { builtinDeferral: true })];
    expect(offered.sort()).toEqual(["AskQuestion", "Search"].sort());
  });
});
