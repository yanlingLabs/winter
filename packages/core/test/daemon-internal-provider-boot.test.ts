// WS-20 (review round 4): `settings.provider.model` is UNCONSTRAINED (any catalog provider, or
// `winter-test/*`) — a round-2 schema gate that narrowed it to `INTERNAL_PROVIDER_IDS`
// (codex-oauth/openai) broke a real "my default chat model is Claude" scenario, since a SESSION
// with no explicit override falls back to this SAME field (session-driver.ts's `create()`), not
// just the daemon's internal Provider's own binding.
//
// This file proves the REPLACEMENT enforcement point: `createProvider` (providers/manager.ts)
// answers `null` for a provider outside `INTERNAL_PROVIDER_IDS`, and `daemon.ts`'s own boot hook
// treats that as "no internal Provider" — the daemon boots normally (never a refusal), `registry`
// (the ONE externally-observable "did agentProvider end up null" signal — see `RunningDaemon`'s own
// doc comment) is `null`, and exactly one log line names what goes inert.
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

function tempHomeWithProviderModel(model: string): string {
  const home = mkdtempSync(join(tmpdir(), "winter-internal-provider-boot-"));
  writeFileSync(join(home, "settings.json"), JSON.stringify({ schemaVersion: 3, provider: { model } }, null, 2));
  return home;
}

function captureConsoleError(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  return { lines, restore: () => { console.error = original; } };
}

describe("daemon boot — settings.provider.model outside INTERNAL_PROVIDER_IDS", () => {
  test("a Claude primary boots normally (never a refusal); agentProvider ends up null (registry === null); one log line names what goes inert", async () => {
    const home = tempHomeWithProviderModel("anthropic/claude-sonnet-5");
    const cap = captureConsoleError();
    try {
      daemon = await startDaemon({ home, secrets: new FileSecretStore(join(home, "test-secrets")) });
    } finally {
      cap.restore();
    }
    // The daemon booted at all — never a typed refusal, never a thrown error out of startDaemon.
    expect(daemon).toBeDefined();
    expect(daemon!.socketPath).toBeTruthy();
    // registry is RunningDaemon's own externally-observable "agentProvider === null" signal.
    expect(daemon!.registry).toBeNull();
    // Exactly one line names the feature set that goes inert — never a boot refusal, never the
    // generic "agent disabled: <error>" line a genuine failure (e.g. a missing API key) uses.
    const providerLines = cap.lines.filter((l) => l.startsWith("provider:"));
    expect(providerLines.length).toBe(1);
    expect(providerLines[0]).toContain("anthropic");
    expect(providerLines[0]).toContain("titles");
    expect(providerLines[0]).toContain("reviewer");
    expect(providerLines[0]).toContain("dreamer");
    expect(providerLines[0]).toContain("cleaner");
    expect(providerLines[0]).toContain("research");
    expect(providerLines[0]).toContain("compaction");
    expect(cap.lines.some((l) => l.startsWith("agent disabled:"))).toBe(false);
  });

  test("a codex-oauth primary still builds the internal Provider (control): registry is non-null, no inert-provider log line", async () => {
    const home = tempHomeWithProviderModel("codex-oauth/gpt-5.6-sol");
    const cap = captureConsoleError();
    try {
      daemon = await startDaemon({ home, secrets: new FileSecretStore(join(home, "test-secrets")) });
    } finally {
      cap.restore();
    }
    expect(daemon!.registry).not.toBeNull();
    expect(cap.lines.some((l) => l.startsWith("provider:") && l.includes("inert"))).toBe(false);
  });
});
