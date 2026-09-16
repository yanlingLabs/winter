import { describe, expect, test } from "bun:test";
import { canonicalizeModelTag, facingNameOf, facingNameToTag, isModelTag, modelTagIsKnown, parseModelTag, splitTag, tagsForSlot, UNSTATED_TAG, WINTER_TEST_PREFIX, type ModelTag } from "../../src/runtime-sdk/model-tag";

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
// WS-20 (review round 2, M4): `isModelTag` regressed the membership gate to provider-EXISTENCE
// only — `codex-oauth/gpt-5.4` (a typo) passes it because "codex-oauth" is a pinned provider, even
// though no such row exists. `modelTagIsKnown` is the stricter door: a real catalog row, UNLESS a
// BYO `providers.<id>.baseUrl` is configured for that provider (an intentionally unlisted model) or
// the provider has no catalog rows of its own at all.
describe("modelTagIsKnown", () => {
  test("a typo model on a real, catalog-backed provider is refused (the M4 regression)", () => {
    expect(modelTagIsKnown("codex-oauth/gpt-5.4")).toBe(false);
    expect(modelTagIsKnown("codex-oauth/gpt-5.4", undefined)).toBe(false);
    expect(modelTagIsKnown("codex-oauth/gpt-5.4", {})).toBe(false);
  });
  test("a real catalog row always passes, with or without settings", () => {
    expect(modelTagIsKnown("codex-oauth/gpt-5.6-terra")).toBe(true);
    expect(modelTagIsKnown("openai/gpt-5.6-terra", {})).toBe(true);
  });
  test("an off-catalog model on a provider with a BYO baseUrl configured passes (the escape hatch)", () => {
    expect(modelTagIsKnown("openai/my-finetune", { providers: { openai: { baseUrl: "https://api.example.com/v1" } } })).toBe(true);
    // The SAME id with no baseUrl configured for that provider is refused.
    expect(modelTagIsKnown("openai/my-finetune", {})).toBe(false);
    expect(modelTagIsKnown("openai/my-finetune")).toBe(false);
    // A baseUrl configured for a DIFFERENT provider doesn't leak the escape hatch across providers.
    expect(modelTagIsKnown("openai/my-finetune", { providers: { anthropic: { baseUrl: "https://api.example.com/v1" } } })).toBe(false);
  });
  test("a blank baseUrl string does not count as configured", () => {
    expect(modelTagIsKnown("openai/my-finetune", { providers: { openai: { baseUrl: "" } } })).toBe(false);
  });
  test("winter-test/* and the unstated sentinel are accepted exactly as isModelTag accepts them", () => {
    expect(modelTagIsKnown(`${WINTER_TEST_PREFIX}echo`)).toBe(true);
    expect(modelTagIsKnown(UNSTATED_TAG)).toBe(true);
  });
  test("shape-invalid and unrecognized-provider tags are refused, same as isModelTag", () => {
    expect(modelTagIsKnown("not-a-tag-at-all")).toBe(false);
    expect(modelTagIsKnown("nosuchprovider/gpt-5.6")).toBe(false);
  });
});

// WS-20 (review round 2, M4 fix — R1): `<providerId>/<facingName>` is a legitimate request (spec
// §1: "a facing name resolves to a tag only within a chosen provider") — `anthropic/sonnet` names
// the SLOT `sonnet` within provider `anthropic`, not a typo. `canonicalizeModelTag` resolves it to
// the REAL catalog row key; `modelTagIsKnown` is a thin boolean wrapper over it.
describe("canonicalizeModelTag", () => {
  test("a facing-name request resolves to its provider's real catalog row key", () => {
    expect(canonicalizeModelTag("anthropic/sonnet")).toBe(tag("anthropic/claude-sonnet-5"));
    expect(canonicalizeModelTag("codex-oauth/terra")).toBe(tag("codex-oauth/gpt-5.6-terra"));
  });
  test("case-insensitive slot-name matching", () => {
    expect(canonicalizeModelTag("anthropic/Sonnet")).toBe(tag("anthropic/claude-sonnet-5"));
    expect(canonicalizeModelTag("anthropic/SONNET")).toBe(tag("anthropic/claude-sonnet-5"));
  });
  test("an already-canonical row key resolves to itself, unchanged", () => {
    expect(canonicalizeModelTag("codex-oauth/gpt-5.6-terra")).toBe(tag("codex-oauth/gpt-5.6-terra"));
  });
  test("neither a real row nor a facing name, on a provider with catalog rows and no BYO baseUrl, is still refused", () => {
    expect(canonicalizeModelTag("anthropic/nosuch")).toBeUndefined();
    expect(modelTagIsKnown("anthropic/nosuch")).toBe(false);
  });
  test("a facing name for a slot this provider does NOT serve falls through to the typo-refusal rule", () => {
    // "terra" is a gpt-family slot; anthropic serves no such slot.
    expect(canonicalizeModelTag("anthropic/terra")).toBeUndefined();
  });
  test("the BYO-baseUrl escape hatch still applies when neither a row nor a facing name matches", () => {
    expect(canonicalizeModelTag("openai/my-finetune", { providers: { openai: { baseUrl: "https://api.example.com/v1" } } })).toBe(tag("openai/my-finetune"));
  });
  test("sentinel and winter-test/* pass through unchanged, never treated as a facing name", () => {
    expect(canonicalizeModelTag(UNSTATED_TAG)).toBe(UNSTATED_TAG);
    expect(canonicalizeModelTag(`${WINTER_TEST_PREFIX}echo`)).toBe(tag(`${WINTER_TEST_PREFIX}echo`));
  });
  test("modelTagIsKnown agrees with canonicalizeModelTag's defined/undefined split", () => {
    expect(modelTagIsKnown("anthropic/sonnet")).toBe(true);
    expect(modelTagIsKnown("codex-oauth/gpt-5.4")).toBe(false); // the M4 typo-refusal regression control
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
