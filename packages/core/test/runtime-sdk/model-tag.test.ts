import { describe, expect, test } from "bun:test";
import { facingNameOf, facingNameToTag, isModelTag, parseModelTag, splitTag, tagsForSlot, UNSTATED_TAG, type ModelTag } from "../../src/runtime-sdk/model-tag";

/** A plain test literal known to be tag-shaped, asserted as `ModelTag` for `toBe`/`toEqual` against
 *  a branded return value — a type assertion only, never a runtime validation. */
const tag = (s: string): ModelTag => s as ModelTag;

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
    expect(parseModelTag("winter-test/echo")).toBe(tag("winter-test/echo"));
    expect(() => parseModelTag("terra")).toThrow(/not a model tag/);
  });
});
describe("slots", () => {
  test("terra maps to one tag per serving provider; a provider that does not serve it yields undefined", () => {
    expect(tagsForSlot("terra")).toContain(tag("codex-oauth/gpt-5.6-terra"));
    expect(tagsForSlot("terra")).toContain(tag("openai/gpt-5.6-terra"));
    expect(facingNameToTag("codex-oauth", "terra")).toBe(tag("codex-oauth/gpt-5.6-terra"));
    expect(facingNameToTag("deepseek", "terra")).toBeUndefined();
    expect(facingNameOf("codex-oauth/gpt-5.6-terra" as never)).toBe("terra");
    expect(facingNameOf("openai/gpt-5.6" as never)).toBeUndefined();
  });
  test("console serves the claude slots", () => {
    expect(facingNameToTag("console", "sonnet")).toBe(tag("console/claude-sonnet-5"));
  });
});
