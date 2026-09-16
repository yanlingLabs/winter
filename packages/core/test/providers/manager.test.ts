import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSecretStore } from "../../src/auth/secret-store";
import { createProvider, internalModelFor, OPENAI_API_KEY_SECRET } from "../../src/providers/manager";
import type { Settings } from "../../src/settings";
import type { ModelTag } from "../../src/runtime-sdk/model-tag";

function tmpSettingsFile(settings: Settings): string {
  const p = join(mkdtempSync(join(tmpdir(), "winter-manager-")), "settings.json");
  writeFileSync(p, JSON.stringify(settings));
  return p;
}

// WS-20 (review round 4): `createProvider` now answers `null` for a provider outside
// `INTERNAL_PROVIDER_IDS` (codex-oauth/openai) — every fixture below configures one of those two,
// so a `null` here would itself be the bug the test should catch, never a case to silently paper
// over with `!`.
async function createInternalProvider(
  ...args: Parameters<typeof createProvider>
): Promise<Exclude<Awaited<ReturnType<typeof createProvider>>, null>> {
  const p = await createProvider(...args);
  if (p === null) throw new Error("test fixture expected the internal Provider to build (codex-oauth/openai), got null");
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
    const p = await createInternalProvider(
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
      { schemaVersion: 3, provider: { model: "openai/gpt-5.2" }, providers: { openai: { baseUrl: "https://x" } } } as unknown as Settings,
      store,
    )).rejects.toThrow(/api key/i);
    await store.set(OPENAI_API_KEY_SECRET, "sk-test");
    const p = await createInternalProvider(
      { schemaVersion: 3, provider: { model: "openai/gpt-5.2" }, providers: { openai: { baseUrl: "https://x" } } } as unknown as Settings,
      store,
    );
    // WS-20: the internal Provider abstraction has no more "openai-compatible" id of its own —
    // every non-codex-oauth tag goes through the SAME openai-compatible adapter, still reported
    // under its own runtime id.
    expect(p.provider.id).toBe("openai-compatible");
  });

  // WS-20 (review round 4): a provider outside `INTERNAL_PROVIDER_IDS` (codex-oauth/openai) answers
  // `null` — never mis-built as an OpenAI-compatible client pointed at a provider it was never
  // meant to speak to, and never a throw (`settings.provider.model` itself is unconstrained now;
  // this is the ONE place the codex-oauth/openai constraint is actually enforced).
  test("a provider outside INTERNAL_PROVIDER_IDS (e.g. anthropic) answers null, never a mis-built client", async () => {
    const p = await createProvider(
      { schemaVersion: 3, provider: { model: "anthropic/claude-sonnet-5" } } as Settings,
      new FileSecretStore(mkdtempSync(join(tmpdir(), "s-"))),
    );
    expect(p).toBeNull();
  });

  test("a winter-test/* primary also answers null (a provider-less double, not an internal provider)", async () => {
    const p = await createProvider(
      { schemaVersion: 3, provider: { model: "winter-test/echo" } } as unknown as Settings,
      new FileSecretStore(mkdtempSync(join(tmpdir(), "s-"))),
    );
    expect(p).toBeNull();
  });
});

describe("ActiveProvider.liveModel (no-restart model resolution)", () => {
  test("no settingsPath -> liveModel() just keeps returning the boot selection", async () => {
    const p = await createInternalProvider(
      { schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.6-terra", reasoningEffort: "high" } } as Settings,
      new FileSecretStore(mkdtempSync(join(tmpdir(), "s-"))),
      // settingsPath omitted
    );
    expect(p.liveModel()).toEqual({ model: "gpt-5.6-terra", reasoningEffort: "high", providerId: "codex-oauth" });
    expect(p.liveModel()).toEqual({ model: "gpt-5.6-terra", reasoningEffort: "high", providerId: "codex-oauth" }); // stable across calls
  });

  test("a settings.json edit is picked up on the NEXT liveModel() call — no re-construction", async () => {
    const settingsPath = tmpSettingsFile({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.6-sol" } } as Settings);
    const p = await createInternalProvider(
      { schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.6-sol" } } as Settings,
      new FileSecretStore(mkdtempSync(join(tmpdir(), "s-"))),
      settingsPath,
    );
    expect(p.liveModel()).toEqual({ model: "gpt-5.6-sol", providerId: "codex-oauth" });

    writeFileSync(settingsPath, JSON.stringify({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.6-luna", reasoningEffort: "max" } }));
    bumpMtime(settingsPath, 5_000);

    expect(p.liveModel()).toEqual({ model: "gpt-5.6-luna", reasoningEffort: "max", providerId: "codex-oauth" });
  });

  test("mtime-cached: an unchanged settingsPath does not re-parse (cache hit returns the same object)", async () => {
    const settingsPath = tmpSettingsFile({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.6-sol" } } as Settings);
    const p = await createInternalProvider(
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
    const p = await createInternalProvider(
      { schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.4" } } as Settings,
      new FileSecretStore(mkdtempSync(join(tmpdir(), "s-"))),
      settingsPath,
    );
    expect(p.liveModel()).toEqual({ model: "gpt-5.4", providerId: "codex-oauth" });
  });

  test("a non-codex-oauth tag's model passes the configured id through untouched (no allowlist)", async () => {
    const store = new FileSecretStore(mkdtempSync(join(tmpdir(), "s-")));
    await store.set(OPENAI_API_KEY_SECRET, "sk-test");
    const settingsPath = tmpSettingsFile({ schemaVersion: 3, provider: { model: "openai/some-arbitrary-model" }, providers: { openai: { baseUrl: "https://x" } } } as unknown as Settings);
    const p = await createInternalProvider(
      { schemaVersion: 3, provider: { model: "openai/some-arbitrary-model" }, providers: { openai: { baseUrl: "https://x" } } } as unknown as Settings,
      store,
      settingsPath,
    );
    expect(p.liveModel()).toEqual({ model: "some-arbitrary-model", providerId: "openai" });
  });

  test("parse failure (corrupt JSON) on re-read falls back to the LAST GOOD value, never throws", async () => {
    const settingsPath = tmpSettingsFile({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.6-sol" } } as Settings);
    const p = await createInternalProvider(
      { schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.6-sol" } } as Settings,
      new FileSecretStore(mkdtempSync(join(tmpdir(), "s-"))),
      settingsPath,
    );
    expect(p.liveModel()).toEqual({ model: "gpt-5.6-sol", providerId: "codex-oauth" });

    writeFileSync(settingsPath, "{ not valid json");
    bumpMtime(settingsPath, 5_000);

    expect(() => p.liveModel()).not.toThrow();
    expect(p.liveModel()).toEqual({ model: "gpt-5.6-sol", providerId: "codex-oauth" }); // last good, unchanged
  });

  test("parse failure (missing file) on re-read falls back to the LAST GOOD value, never throws", async () => {
    const dir = mkdtempSync(join(tmpdir(), "winter-manager-missing-"));
    const settingsPath = join(dir, "settings.json");
    writeFileSync(settingsPath, JSON.stringify({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.6-terra" } }));
    const p = await createInternalProvider(
      { schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.6-terra" } } as Settings,
      new FileSecretStore(mkdtempSync(join(tmpdir(), "s-"))),
      settingsPath,
    );
    expect(p.liveModel()).toEqual({ model: "gpt-5.6-terra", providerId: "codex-oauth" });

    require("node:fs").rmSync(settingsPath);

    expect(() => p.liveModel()).not.toThrow();
    expect(p.liveModel()).toEqual({ model: "gpt-5.6-terra", providerId: "codex-oauth" }); // last good, unchanged
  });
});

describe("internalModelFor (WS-20 review round 1, GUARD)", () => {
  test("a pin naming the SAME provider as the daemon's internal Provider returns the bare modelId", () => {
    expect(internalModelFor("codex-oauth/gpt-5.6-terra" as ModelTag, { providerId: "codex-oauth" }, "pins.dream")).toBe("gpt-5.6-terra");
  });

  test("a pin naming a DIFFERENT provider returns undefined and logs one line naming the field, never the tag or a secret", () => {
    const lines: string[] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
    try {
      const result = internalModelFor("openai/gpt-5.6-terra" as ModelTag, { providerId: "codex-oauth" }, "pins.dream");
      expect(result).toBeUndefined();
    } finally {
      console.error = realError;
    }
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("pins.dream");
    expect(lines[0]).toContain("openai");
    expect(lines[0]).toContain("codex-oauth");
  });
});
