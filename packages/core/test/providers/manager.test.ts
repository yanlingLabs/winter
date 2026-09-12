import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSecretStore } from "../../src/auth/secret-store";
import { createProvider, OPENAI_API_KEY_SECRET } from "../../src/providers/manager";
import { DEFAULT_CODEX_MODEL } from "../../src/providers/codex-config";
import type { Settings } from "../../src/settings";

function tmpSettingsFile(settings: Settings): string {
  const p = join(mkdtempSync(join(tmpdir(), "winter-manager-")), "settings.json");
  writeFileSync(p, JSON.stringify(settings));
  return p;
}

/** Deterministically bumps a file's mtime forward, so the liveModel resolver's mtime-cache key
 *  reliably changes even when two writes land in the same wall-clock millisecond (the same
 *  aliasing risk ipc/server.ts's livePlugins doc comment calls out for statSync's granularity). */
function bumpMtime(path: string, deltaMs: number): void {
  const now = new Date(Date.now() + deltaMs);
  utimesSync(path, now, now);
}

describe("createProvider", () => {
  test("codex-oauth settings yield the codex provider (quota-wrapped)", async () => {
    const p = await createProvider(
      { schemaVersion: 2, provider: { type: "codex-oauth", model: "gpt-5.2-codex" } },
      new FileSecretStore(mkdtempSync(join(tmpdir(), "s-"))),
    );
    expect(p.provider.id).toBe("codex-oauth");
    expect(p.model).toBe("gpt-5.2-codex");
    expect(p.quota.state().kind).toBe("ok");
  });

  test("openai-compatible requires an api key in the secret store", async () => {
    const store = new FileSecretStore(mkdtempSync(join(tmpdir(), "s-")));
    await expect(createProvider(
      { schemaVersion: 2, provider: { type: "openai-compatible", model: "gpt-5.2", baseUrl: "https://x" } },
      store,
    )).rejects.toThrow(/api key/i);
    await store.set(OPENAI_API_KEY_SECRET, "sk-test");
    const p = await createProvider(
      { schemaVersion: 2, provider: { type: "openai-compatible", model: "gpt-5.2", baseUrl: "https://x" } },
      store,
    );
    expect(p.provider.id).toBe("openai-compatible");
  });
});

describe("ActiveProvider.liveModel (no-restart model resolution)", () => {
  test("no settingsPath -> liveModel() just keeps returning the boot selection", async () => {
    const p = await createProvider(
      { schemaVersion: 2, provider: { type: "codex-oauth", model: "gpt-5.6-terra", reasoningEffort: "high" } },
      new FileSecretStore(mkdtempSync(join(tmpdir(), "s-"))),
      // settingsPath omitted
    );
    expect(p.liveModel()).toEqual({ model: "gpt-5.6-terra", reasoningEffort: "high" });
    expect(p.liveModel()).toEqual({ model: "gpt-5.6-terra", reasoningEffort: "high" }); // stable across calls
  });

  test("a settings.json edit is picked up on the NEXT liveModel() call — no re-construction", async () => {
    const settingsPath = tmpSettingsFile({ schemaVersion: 2, provider: { type: "codex-oauth", model: "gpt-5.6-sol" } });
    const p = await createProvider(
      { schemaVersion: 2, provider: { type: "codex-oauth", model: "gpt-5.6-sol" } },
      new FileSecretStore(mkdtempSync(join(tmpdir(), "s-"))),
      settingsPath,
    );
    expect(p.liveModel()).toEqual({ model: "gpt-5.6-sol" });

    writeFileSync(settingsPath, JSON.stringify({ schemaVersion: 2, provider: { type: "codex-oauth", model: "gpt-5.6-luna", reasoningEffort: "max" } }));
    bumpMtime(settingsPath, 5_000);

    expect(p.liveModel()).toEqual({ model: "gpt-5.6-luna", reasoningEffort: "max" });
  });

  test("mtime-cached: an unchanged settingsPath does not re-parse (cache hit returns the same object)", async () => {
    const settingsPath = tmpSettingsFile({ schemaVersion: 2, provider: { type: "codex-oauth", model: "gpt-5.6-sol" } });
    const p = await createProvider(
      { schemaVersion: 2, provider: { type: "codex-oauth", model: "gpt-5.6-sol" } },
      new FileSecretStore(mkdtempSync(join(tmpdir(), "s-"))),
      settingsPath,
    );
    const first = p.liveModel();
    const second = p.liveModel();
    expect(second).toBe(first); // same cached object reference — no fresh parse happened
  });

  test("deprecated/unknown codex-oauth slug resolves to DEFAULT_CODEX_MODEL", async () => {
    const settingsPath = tmpSettingsFile({ schemaVersion: 2, provider: { type: "codex-oauth", model: "gpt-5.4" } });
    const p = await createProvider(
      { schemaVersion: 2, provider: { type: "codex-oauth", model: "gpt-5.4" } },
      new FileSecretStore(mkdtempSync(join(tmpdir(), "s-"))),
      settingsPath,
    );
    expect(p.liveModel()).toEqual({ model: DEFAULT_CODEX_MODEL });
  });

  test("deprecated slug warns exactly ONCE across construction + many liveModel() calls, not once per turn", async () => {
    const settingsPath = tmpSettingsFile({ schemaVersion: 2, provider: { type: "codex-oauth", model: "gpt-5.5" } });
    const errors: unknown[][] = [];
    const orig = console.error;
    console.error = (...args: unknown[]) => { errors.push(args); };
    try {
      // The FIRST warning fires during createProvider itself (buildLiveModelResolver resolves the
      // boot selection eagerly) — mock installed before construction so this call is captured too.
      const p = await createProvider(
        { schemaVersion: 2, provider: { type: "codex-oauth", model: "gpt-5.5" } },
        new FileSecretStore(mkdtempSync(join(tmpdir(), "s-"))),
        settingsPath,
      );
      p.liveModel();
      for (let i = 0; i < 5; i++) {
        bumpMtime(settingsPath, (i + 1) * 1_000); // force a cache miss each time — still the SAME deprecated slug
        p.liveModel();
      }
    } finally {
      console.error = orig;
    }
    const deprecationWarnings = errors.filter((a) => String(a[0]).includes("gpt-5.5"));
    expect(deprecationWarnings.length).toBe(1);
  });

  test("openai-compatible passes the configured model through untouched (no allowlist)", async () => {
    const store = new FileSecretStore(mkdtempSync(join(tmpdir(), "s-")));
    await store.set(OPENAI_API_KEY_SECRET, "sk-test");
    const settingsPath = tmpSettingsFile({ schemaVersion: 2, provider: { type: "openai-compatible", model: "some-arbitrary-model", baseUrl: "https://x" } });
    const p = await createProvider(
      { schemaVersion: 2, provider: { type: "openai-compatible", model: "some-arbitrary-model", baseUrl: "https://x" } },
      store,
      settingsPath,
    );
    expect(p.liveModel()).toEqual({ model: "some-arbitrary-model" });
  });

  test("parse failure (corrupt JSON) on re-read falls back to the LAST GOOD value, never throws", async () => {
    const settingsPath = tmpSettingsFile({ schemaVersion: 2, provider: { type: "codex-oauth", model: "gpt-5.6-sol" } });
    const p = await createProvider(
      { schemaVersion: 2, provider: { type: "codex-oauth", model: "gpt-5.6-sol" } },
      new FileSecretStore(mkdtempSync(join(tmpdir(), "s-"))),
      settingsPath,
    );
    expect(p.liveModel()).toEqual({ model: "gpt-5.6-sol" });

    writeFileSync(settingsPath, "{ not valid json");
    bumpMtime(settingsPath, 5_000);

    expect(() => p.liveModel()).not.toThrow();
    expect(p.liveModel()).toEqual({ model: "gpt-5.6-sol" }); // last good, unchanged
  });

  test("parse failure (missing file) on re-read falls back to the LAST GOOD value, never throws", async () => {
    const dir = mkdtempSync(join(tmpdir(), "winter-manager-missing-"));
    const settingsPath = join(dir, "settings.json");
    writeFileSync(settingsPath, JSON.stringify({ schemaVersion: 2, provider: { type: "codex-oauth", model: "gpt-5.6-terra" } }));
    const p = await createProvider(
      { schemaVersion: 2, provider: { type: "codex-oauth", model: "gpt-5.6-terra" } },
      new FileSecretStore(mkdtempSync(join(tmpdir(), "s-"))),
      settingsPath,
    );
    expect(p.liveModel()).toEqual({ model: "gpt-5.6-terra" });

    require("node:fs").rmSync(settingsPath);

    expect(() => p.liveModel()).not.toThrow();
    expect(p.liveModel()).toEqual({ model: "gpt-5.6-terra" }); // last good, unchanged
  });
});
