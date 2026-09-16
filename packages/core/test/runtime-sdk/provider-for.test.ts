import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { keychainService } from "../../src/profile";
import { providerFor } from "../../src/runtime-sdk/provider-selection";
import type { ModelTag } from "../../src/runtime-sdk/model-tag";

test("a tag names exactly its provider and that provider's credential ref", () => {
  expect(providerFor("codex-oauth/gpt-5.6-terra" as ModelTag)).toEqual({ providerId: "codex-oauth", authRef: { kind: "keychain", account: "codex-oauth:default", service: keychainService() } });
  expect(providerFor("openai/gpt-5.6-terra" as ModelTag)?.providerId).toBe("openai");
  expect(providerFor("console/claude-sonnet-5" as ModelTag)).toEqual({ providerId: "console" });
  expect(providerFor("winter-test/echo" as ModelTag)).toBeUndefined();
});

test("nothing in runtime-sdk can pick a provider for a bare id any more", () => {
  const src = readFileSync(join(import.meta.dir, "../../src/runtime-sdk/provider-selection.ts"), "utf8");
  expect(src.includes("providerSelectionFor")).toBe(false);
  expect(src.includes("inventoryProvidersServing")).toBe(false);
});
