import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSettings } from "../src/settings";
import type { ModelTag } from "../src/runtime-sdk/model-tag";

/** A plain test literal known to be tag-shaped, asserted as `ModelTag` against a branded field —
 *  a type assertion only, never a runtime validation. */
const tag = (s: string): ModelTag => s as ModelTag;

describe("WS-20 (spec §5): settings v2 -> v3 migration", () => {
  test("codex-oauth legacy settings become codex-oauth/ tags; pins derive; official.auth console → console/ for claude ids", () => {
    const home = mkdtempSync(join(tmpdir(), "ws20-"));
    writeFileSync(join(home, "settings.json"), JSON.stringify({ schemaVersion: 2, provider: { type: "codex-oauth", model: "gpt-5.6-terra", reasoningEffort: "high" }, runtimes: { advisorModel: "claude-opus-5", official: { auth: "console" } }, reviewer: { model: "gpt-5.6-luna" } }));
    // WS-20 (review round 2, M5): loadSettings's migration is in-memory-only by default now — the
    // backup + on-disk persistence this test asserts is the daemon-boot path (`persistMigration: true`).
    const s = loadSettings(join(home, "settings.json"), { persistMigration: true });
    expect(s.schemaVersion).toBe(3);
    expect(s.provider).toEqual({ model: tag("codex-oauth/gpt-5.6-terra"), reasoningEffort: "high" });
    expect(s.runtimes?.advisorModel).toBe("console/claude-opus-5");
    expect(s.reviewer?.model).toBe(tag("codex-oauth/gpt-5.6-luna"));
    expect((s.runtimes as any)?.official?.auth).toBeUndefined();
    expect(existsSync(join(home, "settings.json.bak-pre-ws20"))).toBe(true);
  });

  // WS-20 (review round 2, M5): rules 4/5's tie-break is now credential-presence-aware — this is
  // the coordinator's own scenario: an OpenAI-key-only home with a LEGACY codex-oauth type still
  // resolves `provider.model` to codex-oauth/… (rule 3, the explicit legacy `type` field, wins over
  // presence outright), but `reviewer.model` — which carries no legacy `type` to anchor it — falls
  // through to rule 5's presence-aware tie-break and becomes openai/…, the provider this home
  // actually holds a credential for.
  test("M5: an OpenAI-key-only home — provider.model keeps its legacy codex-oauth type (rule 3), reviewer.model follows presence (rule 5)", () => {
    const home = mkdtempSync(join(tmpdir(), "ws20-"));
    const path = join(home, "settings.json");
    writeFileSync(path, JSON.stringify({
      schemaVersion: 2,
      provider: { type: "codex-oauth", model: "gpt-5.6-terra" },
      reviewer: { model: "gpt-5.6-terra" }, // served by BOTH codex-oauth and openai — genuinely ambiguous
    }));
    const presentProviders = new Set(["openai"]);
    const s = loadSettings(path, { presentProviders, persistMigration: true });
    expect(s.provider.model).toBe(tag("codex-oauth/gpt-5.6-terra")); // rule 3 wins, unaffected by presence
    expect(s.reviewer?.model).toBe(tag("openai/gpt-5.6-terra")); // rule 5, presence-aware
  });

  // The SAME ambiguous reviewer.model, but through the CLI's own call shape (no `presentProviders`,
  // no `persistMigration`) — falls back to the OLD fixed codex-oauth>openai>anthropic order
  // unchanged, and the file on disk is left at schemaVersion 2 (never migrated-and-written).
  test("M5: without presentProviders (the CLI path), the same ambiguous reviewer.model uses the fixed order, and nothing is persisted", () => {
    const home = mkdtempSync(join(tmpdir(), "ws20-"));
    const path = join(home, "settings.json");
    writeFileSync(path, JSON.stringify({
      schemaVersion: 2,
      provider: { type: "codex-oauth", model: "gpt-5.6-terra" },
      reviewer: { model: "gpt-5.6-terra" },
    }));
    const s = loadSettings(path); // bare call — exactly what the CLI does
    expect(s.provider.model).toBe(tag("codex-oauth/gpt-5.6-terra"));
    expect(s.reviewer?.model).toBe(tag("codex-oauth/gpt-5.6-terra")); // fixed order: codex-oauth first
    expect(JSON.parse(readFileSync(path, "utf8")).schemaVersion).toBe(2); // left exactly as found
  });

  test("openai-compatible legacy settings become openai/ + providers.openai.baseUrl", () => {
    const home = mkdtempSync(join(tmpdir(), "ws20-"));
    writeFileSync(join(home, "settings.json"), JSON.stringify({ schemaVersion: 2, provider: { type: "openai-compatible", model: "gpt-5.6-sol", baseUrl: "http://127.0.0.1:9999/v1" } }));
    const s = loadSettings(join(home, "settings.json"));
    expect(s.provider).toEqual({ model: tag("openai/gpt-5.6-sol") });
    expect(s.providers?.openai?.baseUrl).toBe("http://127.0.0.1:9999/v1");
  });

  test("an id no catalog row serves falls back to the legacy provider's own default model, never an invented tag", () => {
    const home = mkdtempSync(join(tmpdir(), "ws20-"));
    writeFileSync(join(home, "settings.json"), JSON.stringify({ schemaVersion: 2, provider: { type: "openai-compatible", model: "my-finetune", baseUrl: "http://127.0.0.1:9999/v1" } }));
    const s = loadSettings(join(home, "settings.json"));
    expect(s.provider.model).toBe(tag("openai/gpt-5.6-sol")); // rule 2: S empty → the legacy provider (openai-compatible ⇒ openai) at its default model, one log line
    expect(s.providers?.openai?.baseUrl).toBe("http://127.0.0.1:9999/v1");
  });

  // WS-20 (review round 4): `provider.model` is UNCONSTRAINED again (any catalog provider) — a
  // round-2/round-3 fallback briefly steered a v2 `openai-compatible` BYO endpoint serving a
  // `claude-`-prefixed bare id AWAY from `anthropic/claude-*` for `provider.model` specifically,
  // because that used to fail the (now-removed) `ProviderSettings` schema gate. `migrateBareModelId`'s
  // Claude arm answer is now trusted verbatim for `provider.model`, same as `reviewer.model` always
  // was — the correct migration for a genuinely Claude-primary v2 home.
  test("R4: a v2 BYO endpoint serving a claude-prefixed id migrates provider.model AND reviewer.model to the SAME Claude tag", () => {
    const home = mkdtempSync(join(tmpdir(), "ws20-"));
    const path = join(home, "settings.json");
    writeFileSync(path, JSON.stringify({
      schemaVersion: 2,
      provider: { type: "openai-compatible", model: "claude-opus-5", baseUrl: "http://127.0.0.1:9999/v1" },
      reviewer: { model: "claude-opus-5" },
    }));
    const s = loadSettings(path, { persistMigration: true });
    expect(s.provider.model).toBe(tag("anthropic/claude-opus-5"));
    expect(s.reviewer?.model).toBe(tag("anthropic/claude-opus-5"));
    // The migration persisted a VALID v3 file.
    const onDisk = JSON.parse(readFileSync(path, "utf8"));
    expect(onDisk.schemaVersion).toBe(3);
    expect(onDisk.provider.model).toBe("anthropic/claude-opus-5");
  });
});
