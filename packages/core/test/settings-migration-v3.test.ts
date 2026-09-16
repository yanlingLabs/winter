import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
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
    const s = loadSettings(join(home, "settings.json"));
    expect(s.schemaVersion).toBe(3);
    expect(s.provider).toEqual({ model: tag("codex-oauth/gpt-5.6-terra"), reasoningEffort: "high" });
    expect(s.runtimes?.advisorModel).toBe("console/claude-opus-5");
    expect(s.reviewer?.model).toBe(tag("codex-oauth/gpt-5.6-luna"));
    expect((s.runtimes as any)?.official?.auth).toBeUndefined();
    expect(existsSync(join(home, "settings.json.bak-pre-ws20"))).toBe(true);
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
});
