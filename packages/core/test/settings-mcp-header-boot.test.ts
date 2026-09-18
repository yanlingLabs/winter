// Read-door correction (item 6 follow-up): the BUG this file exists to prove fixed. `refuseCredentialShapedHeaders`
// (settings.ts) refuses a credential-shaped MCP header at the SCHEMA level, and until this fix that
// refusal fired inside `loadSettings` too — `daemon.ts`'s boot hook treats ANY `loadSettings` throw
// as "settings unavailable, agent disabled", so ONE hand-edited `Authorization` header on ONE
// configured MCP server used to disable EVERY session on the machine, not just that server.
//
// This proves the corrected boundary end to end through the REAL boot path (`startDaemon`, the same
// seam `daemon-internal-provider-boot.test.ts` already uses for an analogous "narrow failure, not a
// boot refusal" claim — an in-process daemon over a real Unix socket, never a spawned `winter daemon
// run` subprocess): the daemon boots normally, the agent stays enabled (registry is built), and the
// only log line this scenario produces names the stripped header — never "settings unavailable,
// agent disabled", never the header's VALUE.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon, type RunningDaemon } from "../src/daemon";
import { FileSecretStore } from "../src/auth/secret-store";

let daemon: RunningDaemon | undefined;
afterEach(async () => {
  const stopping = daemon?.stop();
  daemon = undefined;
  await stopping;
});

const SENTINEL = "Bearer sk-SENTINEL-daemon-boot-leak-check";

function tempHomeWithCredentialShapedMcpHeader(): string {
  const home = mkdtempSync(join(tmpdir(), "winter-mcp-header-boot-"));
  // Hand-edited, never through `Settings.parse`/`saveSettings` (the write door, which still
  // refuses this shape unconditionally) — this IS what a human editing settings.json outside
  // Winter can produce, and it's the only way this shape reaches disk at all.
  writeFileSync(join(home, "settings.json"), JSON.stringify({
    schemaVersion: 3,
    // codex-oauth so the daemon's internal Provider actually builds (mirrors the "control" case in
    // daemon-internal-provider-boot.test.ts) — proving "the agent stays enabled" needs a signal
    // that ISN'T ALSO true for an unrelated reason (an anthropic/* primary makes `registry` null
    // regardless of settings validity — see that file's own header).
    provider: { model: "codex-oauth/gpt-5.6-sol" },
    mcpServers: {
      remote: { type: "http", url: "https://example.com/mcp", headers: { Authorization: SENTINEL, "X-Request-Id": "abc123" } },
    },
  }, null, 2));
  return home;
}

function captureConsole(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const originalError = console.error;
  const originalLog = console.log;
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  return { lines, restore: () => { console.error = originalError; console.log = originalLog; } };
}

describe("daemon boot — a hand-edited credential-shaped MCP header must not disable the agent", () => {
  test("RED FIRST (was disabled before the fix): the daemon boots normally, the agent stays ENABLED (registry is built), never \"settings unavailable, agent disabled\"; the header's value never appears in any log line", async () => {
    const home = tempHomeWithCredentialShapedMcpHeader();
    const cap = captureConsole();
    try {
      daemon = await startDaemon({ home, secrets: new FileSecretStore(join(home, "test-secrets")) });
    } finally {
      cap.restore();
    }
    // The daemon booted at all.
    expect(daemon).toBeDefined();
    expect(daemon!.socketPath).toBeTruthy();
    // THE bug this file guards against: before the fix, `settings === null` unconditionally forced
    // `agentProvider = null` — registry would be null here for the WRONG reason (settings failed to
    // load), indistinguishable at this assertion alone from the internal-provider-boot file's
    // legitimate "outside INTERNAL_PROVIDER_IDS" null. The "never agent disabled" line below is what
    // actually pins the fix; this is the corroborating positive signal.
    expect(daemon!.registry).not.toBeNull();
    expect(cap.lines.some((l) => l.startsWith("settings unavailable, agent disabled"))).toBe(false);
    expect(cap.lines.some((l) => l.startsWith("agent disabled:"))).toBe(false);
    // The one line this scenario DOES produce: it names the server and the header, never the value.
    const offending = cap.lines.filter((l) => l.includes('mcp server "remote"') && l.includes('header "Authorization"'));
    expect(offending.length).toBeGreaterThanOrEqual(1);
    expect(offending[0]).toContain("credential-shaped");
    expect(cap.lines.some((l) => l.includes(SENTINEL))).toBe(false); // the secret VALUE never reaches any log line
  });
});
