// 2026-09-19: this file used to SPECIFY the bug. It asserted that a home whose
// `settings.provider.model` names a provider outside `INTERNAL_PROVIDER_IDS` (codex-oauth/openai)
// boots with `agentProvider === null`, `registry === null`, and one log line saying titles, the
// reviewer, the dreamer, the cleaner, research and turn compaction "are inert".
//
// Every part of that was a real defect, and two of them were worse than the reported symptom:
//
//  1. `registry === null` is not just "no tool registry" — the `if (agentProvider)` gate it signals
//     also built the plugin supervisor, the dreamer/cleaner AND THE SETTINGS WATCHER. So a
//     DeepSeek- or Claude-default home had NO hot settings at all: every setting was a boot
//     snapshot, in direct violation of CLAUDE.md's "no setting may ever require a daemon restart".
//  2. "research" and "turn compaction" were already false. `pins.research` moved inside the runtime
//     child (`WebFetch`'s digest model) with the 2026-09-18 web-tools ruling, and the internal
//     `Compactor` has NO production construction site at all — `agent/compactor.ts` is instantiated
//     only by its own test and by `scripts/capture-projector-goldens.ts`. The daemon was naming two
//     capabilities it does not have as casualties of a third thing.
//
// What this file pins now: the daemon's own background jobs are decided by the credential it holds,
// not by the session default's provider; the gate runs either way; and the boot line is accurate.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon, type RunningDaemon } from "../src/daemon";
import { FileSecretStore } from "../src/auth/secret-store";
import { CREDENTIAL_MATERIAL_NAMES, writeCredentialMaterial } from "../src/auth/credential-material";

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

async function boot(home: string, credentials: Array<[string, string]> = []): Promise<{ lines: string[] }> {
  const secrets = new FileSecretStore(join(home, "test-secrets"));
  for (const [name, key] of credentials) await writeCredentialMaterial(secrets, name, { kind: "api-key", key });
  const cap = captureConsoleError();
  try {
    daemon = await startDaemon({ home, secrets });
  } finally {
    cap.restore();
  }
  return { lines: cap.lines };
}

describe("daemon boot — Winter's own jobs vs settings.provider.model", () => {
  test("a DeepSeek primary with a DeepSeek key: the jobs run, and the gate (registry, plugins, THE SETTINGS WATCHER) is built", async () => {
    const home = tempHomeWithProviderModel("deepseek/deepseek-v4-flash");
    const { lines } = await boot(home, [["deepseek:default", "sk-deepseek-test"]]);
    expect(daemon).toBeDefined();
    expect(daemon!.socketPath).toBeTruthy();
    // The pre-2026-09-19 code answered `null` here, which is what took the settings watcher with it.
    expect(daemon!.registry).not.toBeNull();
    const summary = lines.filter((l) => l.startsWith("internal-provider:"));
    expect(summary.length).toBe(1);
    expect(summary[0]).toContain("can run on");
    expect(summary[0]).toContain("deepseek");
    expect(lines.some((l) => l.startsWith("agent disabled:"))).toBe(false);
  });

  test("a Claude primary with a Codex login: the jobs run on Codex, never on Anthropic", async () => {
    const home = tempHomeWithProviderModel("anthropic/claude-sonnet-5");
    const { lines } = await boot(home, [
      [CREDENTIAL_MATERIAL_NAMES.codexOauth, "codex-material"],
      ["anthropic:default", "sk-ant-test"],
    ]);
    expect(daemon!.registry).not.toBeNull();
    const summary = lines.filter((l) => l.startsWith("internal-provider:"));
    expect(summary.length).toBe(1);
    expect(summary[0]).toContain("codex-oauth");
    // The anthropic key is stored and must never be named as a provider for Winter's own jobs.
    expect(summary[0]).not.toContain("anthropic");
  });

  test("no credential at all: the jobs are inert, the line says exactly what would fix it, and the gate STILL runs", async () => {
    const home = tempHomeWithProviderModel("deepseek/deepseek-v4-flash");
    const { lines } = await boot(home);
    // The whole point of the fix: inert jobs no longer cost the daemon its tool registry, its
    // plugins or its settings watcher.
    expect(daemon!.registry).not.toBeNull();
    const summary = lines.filter((l) => l.startsWith("internal-provider:"));
    expect(summary.length).toBe(1);
    expect(summary[0]).toContain("no provider Winter's own jobs can run on holds a credential");
    expect(summary[0]).toContain("ChatGPT");
    expect(summary[0]).toContain("credentials set");
    // NEVER the two capabilities the old line invented: `pins.research` is the child's WebFetch digest
    // now, and the internal Compactor has no production consumer.
    expect(summary[0]).not.toContain("research");
    expect(summary[0]).not.toContain("compaction");
    // And never a value or a slot name.
    expect(summary[0]).not.toContain("default");
  });

  test("a codex-oauth primary with a Codex login (control): unchanged, one accurate line", async () => {
    const home = tempHomeWithProviderModel("codex-oauth/gpt-5.6-sol");
    const { lines } = await boot(home, [[CREDENTIAL_MATERIAL_NAMES.codexOauth, "codex-material"]]);
    expect(daemon!.registry).not.toBeNull();
    expect(lines.filter((l) => l.startsWith("internal-provider:")).length).toBe(1);
    expect(lines.some((l) => l.includes("inert"))).toBe(false);
  });

  test("an explicitly provider-less boot (agentProvider: null) still skips the gate", async () => {
    const home = tempHomeWithProviderModel("codex-oauth/gpt-5.6-sol");
    daemon = await startDaemon({ home, secrets: new FileSecretStore(join(home, "test-secrets")), agentProvider: null });
    // `runtime-state/probe.ts` and the tests that want a bare daemon depend on this staying available.
    expect(daemon!.registry).toBeNull();
  });
});
