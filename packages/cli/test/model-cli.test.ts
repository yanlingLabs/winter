import { describe, expect, test } from "bun:test";
import { REASONING_EFFORTS } from "@yanlinglabs/winter-core";
import type { Settings } from "@yanlinglabs/winter-core";
import { parseModelArgs, validateEffort, validateModelTag, validateInternalProviderModelTag, validateAdvisorSlug, renderModelListing, modelDisplayWithHint } from "../src/model-cli";

describe("parseModelArgs", () => {
  test("no args -> show", () => {
    expect(parseModelArgs([])).toEqual({ kind: "show" });
  });

  test("a bare slug -> setModel", () => {
    expect(parseModelArgs(["codex-oauth/gpt-5.6-sol"])).toEqual({ kind: "setModel", slug: "codex-oauth/gpt-5.6-sol" });
  });

  test("--effort <level> alone -> setEffort (effort-only change)", () => {
    expect(parseModelArgs(["--effort", "high"])).toEqual({ kind: "setEffort", effort: "high" });
  });

  test("<slug> --effort <level> -> setModelAndEffort", () => {
    expect(parseModelArgs(["codex-oauth/gpt-5.6-luna", "--effort", "xhigh"])).toEqual({ kind: "setModelAndEffort", slug: "codex-oauth/gpt-5.6-luna", effort: "xhigh" });
  });

  test("--effort with no value -> usageError", () => {
    expect(parseModelArgs(["--effort"])).toMatchObject({ kind: "usageError" });
  });

  test("--effort with trailing garbage -> usageError", () => {
    expect(parseModelArgs(["--effort", "high", "extra"])).toMatchObject({ kind: "usageError" });
  });

  test("slug --effort with no value -> usageError", () => {
    expect(parseModelArgs(["codex-oauth/gpt-5.6-sol", "--effort"])).toMatchObject({ kind: "usageError" });
  });

  test("slug --effort with trailing garbage -> usageError", () => {
    expect(parseModelArgs(["codex-oauth/gpt-5.6-sol", "--effort", "high", "extra"])).toMatchObject({ kind: "usageError" });
  });

  test("a slug-position flag (looks like an unknown option) -> usageError", () => {
    expect(parseModelArgs(["--bogus"])).toMatchObject({ kind: "usageError" });
  });

  test("slug followed by an unrecognized second token -> usageError", () => {
    expect(parseModelArgs(["codex-oauth/gpt-5.6-sol", "bogus"])).toMatchObject({ kind: "usageError" });
  });

  // Winter Phase 8d (P8d-8, Task 4.3): the D30 advisor override's own standalone flag form.
  test("--advisor <slug> -> setAdvisor", () => {
    expect(parseModelArgs(["--advisor", "anthropic/claude-opus-5"])).toEqual({ kind: "setAdvisor", slug: "anthropic/claude-opus-5" });
  });

  test("--advisor auto -> clearAdvisor", () => {
    expect(parseModelArgs(["--advisor", "auto"])).toEqual({ kind: "clearAdvisor" });
  });

  test("--advisor with no value -> usageError", () => {
    expect(parseModelArgs(["--advisor"])).toMatchObject({ kind: "usageError" });
  });

  test("--advisor with trailing garbage -> usageError", () => {
    expect(parseModelArgs(["--advisor", "anthropic/claude-opus-5", "extra"])).toMatchObject({ kind: "usageError" });
  });
});

// WS-20: model is ALWAYS a provider-qualified tag now — validateModelTag replaces
// validateModelSlug's per-provider-type allowlist.
describe("validateModelTag", () => {
  test("WS-20: validateModelTag accepts a catalog tag and rejects a bare id with a tag-shaped message", () => {
    expect(validateModelTag("codex-oauth/gpt-5.6-terra")).toBeUndefined();
    expect(validateModelTag("gpt-5.6-terra")).toMatch(/provider-qualified tag/);
    expect(validateModelTag("nosuch/gpt-5.6-terra")).toMatch(/unknown provider/);
  });

  // Review fix: `isModelTag` accepts both as ESCAPES (for validating a stored value that may
  // legitimately carry either), but neither is a real, user-settable model -- a user typing
  // `winter model unstated/unstated` or `winter model winter-test/foo` must be refused, not
  // silently "succeed" into a sentinel/test-double record.
  test("WS-20: validateModelTag rejects the unstated sentinel and a winter-test double", () => {
    expect(validateModelTag("unstated/unstated")).toMatch(/provider-qualified tag/);
    expect(validateModelTag("winter-test/foo")).toMatch(/provider-qualified tag/);
  });

  // Review fix (item 4): a real, pinned provider, but a model that isn't one of its rows — refused
  // via `modelTagIsKnown` (core's own membership check, the SAME one the daemon consults), naming
  // both the model and the provider so the message matches the daemon's own vocabulary.
  test("WS-20 (item 4): rejects an unknown model under a real, enumerable provider", () => {
    expect(validateModelTag("codex-oauth/totally-made-up-model-xyz")).toBe("unknown model 'totally-made-up-model-xyz' for provider codex-oauth");
  });

  // The BYO-endpoint leniency: a provider WITH catalog rows still accepts an unlisted model when
  // the caller has configured its own endpoint for that provider (`settings.providers.<id>.baseUrl`)
  // — the same leniency `session.setModel`'s own membership check gives an arbitrary
  // openai-compatible model.
  test("WS-20 (item 4): a BYO endpoint override accepts an otherwise-unlisted model for that provider", () => {
    const settings = { providers: { openai: { baseUrl: "https://my-llm.example.com/v1" } } } as unknown as Settings;
    expect(validateModelTag("openai/my-custom-llm", settings)).toBeUndefined();
  });
});

// Review fix (item 4): `winter model <tag>` (the CLI verb, main.ts's `case "model"`) writes the
// GLOBAL settings.provider.model, which binds the daemon's own internal Provider — codex-oauth or
// openai only. A PER-SESSION `/model` (tui/commands.ts) does NOT use this gate — see
// tui/commands.test.ts for that side.
describe("validateInternalProviderModelTag", () => {
  test("accepts an internal-provider tag (codex-oauth/openai)", () => {
    expect(validateInternalProviderModelTag("codex-oauth/gpt-5.6-terra")).toBeUndefined();
  });

  test("refuses a real, non-internal catalog provider with the daemon's own message", () => {
    const err = validateInternalProviderModelTag("anthropic/claude-opus-5");
    expect(err).toBe("provider.model must name codex-oauth or openai — the daemon's internal provider supports codex-oauth and openai; any provider is fine per session");
  });

  test("still surfaces the shape/catalog errors validateModelTag itself would", () => {
    expect(validateInternalProviderModelTag("not-a-tag")).toMatch(/provider-qualified tag/);
    expect(validateInternalProviderModelTag("codex-oauth/totally-made-up-model-xyz")).toContain("unknown model");
  });
});

describe("validateEffort", () => {
  test("every documented effort slug is valid", () => {
    for (const effort of REASONING_EFFORTS) {
      expect(validateEffort(effort)).toBeUndefined();
    }
  });

  test("an unknown effort slug is rejected with a clear message listing valid slugs", () => {
    const err = validateEffort("bogus");
    expect(err).not.toBeUndefined();
    for (const effort of REASONING_EFFORTS) expect(err).toContain(effort);
  });
});

// Winter Phase 8d (P8d-8, Task 4.3) + WS-20: validated against the PINNED CATALOG by TAG
// (`validateModelTag` then `rowForTag`) — deliberately not a live provider list, since this
// command runs with no daemon RPC.
describe("validateAdvisorSlug", () => {
  test("a real catalog tag is valid", () => {
    expect(validateAdvisorSlug("anthropic/claude-opus-5")).toBeUndefined();
  });

  test("a bare (non-tag) slug is rejected with the tag-shaped message", () => {
    expect(validateAdvisorSlug("claude-opus-5")).toMatch(/provider-qualified tag/);
  });

  // Review fix (item 4): `validateModelTag` (which `validateAdvisorSlug` calls first) now itself
  // catches a tag-shaped-but-nonexistent model under a real, enumerable provider via
  // `modelTagIsKnown` — "unknown model '<id>' for provider <p>" fires before `validateAdvisorSlug`'s
  // own `rowForTag` fallback ("not in the pinned catalog…") is ever reached for this case.
  test("a tag-shaped model with zero catalog rows is rejected, naming the model and provider", () => {
    const err = validateAdvisorSlug("anthropic/totally-made-up-model-xyz");
    expect(err).not.toBeUndefined();
    expect(err).toContain("unknown model 'totally-made-up-model-xyz' for provider anthropic");
  });
});

describe("renderModelListing", () => {
  test("WS-20: `winter model` show output groups by provider with the facing name", () => {
    const out = renderModelListing([
      { id: "codex-oauth/gpt-5.6-terra", providerId: "codex-oauth", displayName: "GPT-5.6 Terra", facingName: "terra", efforts: ["low"] },
      { id: "openai/gpt-5.6-terra", providerId: "openai", displayName: "GPT-5.6 Terra", facingName: "terra", efforts: ["low"] },
    ], "codex-oauth/gpt-5.6-terra");
    expect(out).toBe("codex-oauth\n  * terra  (gpt-5.6-terra)\nopenai\n    terra  (gpt-5.6-terra)\n");
  });
});

// Review fix (Nit 1): every free-text CLI line that used to print a raw provider-qualified tag now
// goes through this — the modelId, with the provider trailing as a hint, never the opaque tag.
describe("modelDisplayWithHint", () => {
  test("WS-20: a tag renders as 'modelId (providerId)', never the raw tag", () => {
    expect(modelDisplayWithHint("codex-oauth/gpt-5.6-terra")).toBe("gpt-5.6-terra (codex-oauth)");
  });

  test("WS-20: a non-tag-shaped value (e.g. 'auto') passes through unchanged", () => {
    expect(modelDisplayWithHint("auto")).toBe("auto");
  });
});
