import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { keychainService } from "../../src/profile";
import { implicitEffortFor, providerFor } from "../../src/runtime-sdk/provider-selection";
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

describe("implicitEffortFor (2026-09-17: a pin's fixed tier is mapped onto the row, never forced)", () => {
  test("a row that lists the tier keeps it; a row that declares no vocabulary yields undefined (no effort sent)", () => {
    expect(implicitEffortFor("codex-oauth/gpt-5.6-terra", "medium")).toBe("medium");
    expect(implicitEffortFor("alibaba-cn/deepseek-v4-flash", "medium")).toBeUndefined();
  });
  test("a row that lists other tiers falls back to its own defaultEffort or to nothing", () => {
    // R.1 (catalog refresh): DeepSeek's row is now `deepseek/deepseek-flash` (vocabulary none/low/high/max,
    // no medium) and declares a default, `high`, which is what the tier falls back to.
    const r = implicitEffortFor("deepseek/deepseek-flash", "medium");
    expect(r === undefined || ["none", "low", "high", "max"].includes(r)).toBe(true);
    expect(r).toBe("high");
  });
  test("unknown rows and test doubles pass the tier through", () => {
    expect(implicitEffortFor("winter-test/echo", "medium")).toBe("medium");
    expect(implicitEffortFor("openai/my-finetune", "medium")).toBe("medium");
  });
});
