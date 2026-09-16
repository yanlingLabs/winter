import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSecretStore } from "../../src/auth/secret-store";
import { createProvider, OPENAI_API_KEY_SECRET } from "../../src/providers/manager";
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
  test("codex-oauth settings (a codex-oauth/ tag) yield the codex provider (quota-wrapped)", async () => {
    const p = await createProvider(
      { schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.2-codex" } } as Settings,
      new FileSecretStore(mkdtempSync(join(tmpdir(), "s-"))),
    );
    expect(p.provider.id).toBe("codex-oauth");
    expect(p.model).toBe("gpt-5.2-codex"); // WS-20: the BARE modelId half, split from the tag
    expect(p.quota.state().kind).toBe("ok");
  });

  test("a non-codex-oauth tag (openai/) requires an api key in the secret store", async () => {
    const store = new FileSecretStore(mkdtempSync(join(tmpdir(), "s-")));
    await expect(createProvider(
      { schemaVersion: 3, provider: { model: "openai/gpt-5.2" }, providers: { openai: { baseUrl: "https://x" } } } as Settings,
      store,
    )).rejects.toThrow(/api key/i);
    await store.set(OPENAI_API_KEY_SECRET, "sk-test");
    const p = await createProvider(
      { schemaVersion: 3, provider: { model: "openai/gpt-5.2" }, providers: { openai: { baseUrl: "https://x" } } } as Settings,
      store,
    );
    // WS-20: the internal Provider abstraction has no more "openai-compatible" id of its own —
    // every non-codex-oauth tag goes through the SAME openai-compatible adapter, still reported
    // under its own runtime id.
    expect(p.provider.id).toBe("openai-compatible");
  });
});

describe("ActiveProvider.liveModel (no-restart model resolution)", () => {
  test("no settingsPath -> liveModel() just keeps returning the boot selection", async () => {
    const p = await createProvider(
      { schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.6-terra", reasoningEffort: "high" } } as Settings,
      new FileSecretStore(mkdtempSync(join(tmpdir(), "s-"))),
      // settingsPath omitted
    );
    expect(p.liveModel()).toEqual({ model: "gpt-5.6-terra", reasoningEffort: "high" });
    expect(p.liveModel()).toEqual({ model: "gpt-5.6-terra", reasoningEffort: "high" }); // stable across calls
  });

  test("a settings.json edit is picked up on the NEXT liveModel() call — no re-construction", async () => {
    const settingsPath = tmpSettingsFile({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.6-sol" } } as Settings);
    const p = await createProvider(
      { schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.6-sol" } } as Settings,
      new FileSecretStore(mkdtempSync(join(tmpdir(), "s-"))),
      settingsPath,
    );
    expect(p.liveModel()).toEqual({ model: "gpt-5.6-sol" });

    writeFileSync(settingsPath, JSON.stringify({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.6-luna", reasoningEffort: "max" } }));
    bumpMtime(settingsPath, 5_000);

    expect(p.liveModel()).toEqual({ model: "gpt-5.6-luna", reasoningEffort: "max" });
  });

  test("mtime-cached: an unchanged settingsPath does not re-parse (cache hit returns the same object)", async () => {
    const settingsPath = tmpSettingsFile({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.6-sol" } } as Settings);
    const p = await createProvider(
      { schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.6-sol" } } as Settings,
      new FileSecretStore(mkdtempSync(join(tmpdir(), "s-"))),
      settingsPath,
    );
    const first = p.liveModel();
    const second = p.liveModel();
    expect(second).toBe(first); // same cached object reference — no fresh parse happened
  });

  // WS-20: the CODEX_MODELS deprecated-slug fallback (and its DEFAULT_CODEX_MODEL target) is
  // DELETED — `settings.provider.model` is read verbatim (bare modelId split from the tag), no
  // rewrite. A "deprecated" slug like gpt-5.4 now passes through exactly like any other.
  test("an unlisted codex-oauth slug passes through verbatim — no deprecated-slug rewrite any more", async () => {
    const settingsPath = tmpSettingsFile({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.4" } } as Settings);
    const p = await createProvider(
      { schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.4" } } as Settings,
      new FileSecretStore(mkdtempSync(join(tmpdir(), "s-"))),
      settingsPath,
    );
    expect(p.liveModel()).toEqual({ model: "gpt-5.4" });
  });

  test("a non-codex-oauth tag's model passes the configured id through untouched (no allowlist)", async () => {
    const store = new FileSecretStore(mkdtempSync(join(tmpdir(), "s-")));
    await store.set(OPENAI_API_KEY_SECRET, "sk-test");
    const settingsPath = tmpSettingsFile({ schemaVersion: 3, provider: { model: "openai/some-arbitrary-model" }, providers: { openai: { baseUrl: "https://x" } } } as Settings);
    const p = await createProvider(
      { schemaVersion: 3, provider: { model: "openai/some-arbitrary-model" }, providers: { openai: { baseUrl: "https://x" } } } as Settings,
      store,
      settingsPath,
    );
    expect(p.liveModel()).toEqual({ model: "some-arbitrary-model" });
  });

  test("parse failure (corrupt JSON) on re-read falls back to the LAST GOOD value, never throws", async () => {
    const settingsPath = tmpSettingsFile({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.6-sol" } } as Settings);
    const p = await createProvider(
      { schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.6-sol" } } as Settings,
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
    writeFileSync(settingsPath, JSON.stringify({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.6-terra" } }));
    const p = await createProvider(
      { schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.6-terra" } } as Settings,
      new FileSecretStore(mkdtempSync(join(tmpdir(), "s-"))),
      settingsPath,
    );
    expect(p.liveModel()).toEqual({ model: "gpt-5.6-terra" });

    require("node:fs").rmSync(settingsPath);

    expect(() => p.liveModel()).not.toThrow();
    expect(p.liveModel()).toEqual({ model: "gpt-5.6-terra" }); // last good, unchanged
  });
});
