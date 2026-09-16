import { describe, expect, test } from "bun:test";
import { facingNameOf, facingNameToTag, isModelTag, parseModelTag, splitTag, tagsForSlot, UNSTATED_TAG } from "../../src/runtime-sdk/model-tag";

describe("splitTag", () => {
  test("splits at the first slash; modelId may itself contain slashes", () => {
    expect(splitTag("codex-oauth/gpt-5.6-terra")).toEqual({ providerId: "codex-oauth", modelId: "gpt-5.6-terra" });
    expect(splitTag("openrouter/openai/gpt-4.1")).toEqual({ providerId: "openrouter", modelId: "openai/gpt-4.1" });
  });
  test("throws on a bare id", () => { expect(() => splitTag("gpt-5.6-terra")).toThrow(/not a model tag/); });
});
describe("isModelTag / parseModelTag", () => {
  test("accepts a pinned-catalog row key and the sentinel; rejects unknown providers and bare ids", () => {
    expect(isModelTag("openai/gpt-5.6-terra")).toBe(true);
    expect(isModelTag("codex-oauth/gpt-5.6-terra")).toBe(true);
    expect(isModelTag(UNSTATED_TAG)).toBe(true);
    expect(isModelTag("nosuchprovider/gpt-5.6")).toBe(false);
    expect(isModelTag("gpt-5.6-terra")).toBe(false);
    expect(parseModelTag("winter-test/echo")).toBe("winter-test/echo");
    expect(() => parseModelTag("terra")).toThrow(/not a model tag/);
  });
});
describe("slots", () => {
  test("terra maps to one tag per serving provider; a provider that does not serve it yields undefined", () => {
    expect(tagsForSlot("terra")).toContain("codex-oauth/gpt-5.6-terra");
    expect(tagsForSlot("terra")).toContain("openai/gpt-5.6-terra");
    expect(facingNameToTag("codex-oauth", "terra")).toBe("codex-oauth/gpt-5.6-terra");
    expect(facingNameToTag("deepseek", "terra")).toBeUndefined();
    expect(facingNameOf("codex-oauth/gpt-5.6-terra" as never)).toBe("terra");
    expect(facingNameOf("openai/gpt-5.6" as never)).toBeUndefined();
  });
  test("console serves the claude slots", () => {
    expect(facingNameToTag("console", "sonnet")).toBe("console/claude-sonnet-5");
  });
});
