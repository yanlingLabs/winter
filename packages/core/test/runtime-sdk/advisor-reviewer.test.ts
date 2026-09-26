// Phase 8d Task 3.1 (P8d-8) — unit coverage for `advisor-reviewer.ts`'s D30 default table, the one
// piece of that file the Winter leg uses (`session-driver.ts` states `Options.advisor.model` from it
// when `runtimes.advisorModel` is unset). WS-23: the official leg's `advisorReviewerFor` resolver and
// its tests are gone with the leg.
import { describe, expect, test } from "bun:test";
import { d30DefaultModel, familyOfModel } from "../../src/runtime-sdk/advisor-reviewer";
import type { ModelTag } from "../../src/runtime-sdk/model-tag";

/** A plain test literal known to be tag-shaped, asserted as `ModelTag` against a branded return —
 *  a type assertion only, never a runtime validation. */
const tag = (s: string): ModelTag => s as ModelTag;

describe("familyOfModel / d30DefaultModel — the D30 per-family table", () => {
  test("an openai (gpt) family model resolves to the family's own slot-1 tag, on the SAME provider", () => {
    expect(familyOfModel("codex-oauth/gpt-6-astra")).toBe("openai");
    // WS-20: the answer is a TAG (the same provider's own row for family slot 1), never a bare id.
    expect(d30DefaultModel("codex-oauth/gpt-6-astra")).toBe(tag("codex-oauth/gpt-6-astra")); // already the default itself
    expect(d30DefaultModel("openai/gpt-5.6-sol")).toBe(tag("openai/gpt-6-astra"));
    expect(d30DefaultModel("gpt-6-astra")).toBeUndefined(); // WS-20: a bare id is not a tag — no provider to resolve against
  });

  test("a claude family model resolves to the family's own slot-1 tag (fable), on the SAME provider", () => {
    expect(familyOfModel("anthropic/claude-sonnet-5")).toBe("claude");
    expect(d30DefaultModel("anthropic/claude-sonnet-5")).toBe(tag("anthropic/claude-fable-5-1"));
  });

  test("WS-20: no cross-provider fallback — a provider that does not serve its family's slot 1 answers undefined", () => {
    // console mirrors every anthropic Claude row (L1's Task), so this one still resolves — pick a
    // family/provider combination the catalog does NOT carry to prove the negative instead: an
    // unrecognised id resolves to no family at all, so there is no slot to look up.
    expect(familyOfModel("not-a-real-model-id")).toBe("other");
    expect(d30DefaultModel("not-a-real-model-id")).toBeUndefined();
  });

  test("no session model at all -> no default at all", () => {
    expect(d30DefaultModel(undefined)).toBeUndefined();
  });
});
