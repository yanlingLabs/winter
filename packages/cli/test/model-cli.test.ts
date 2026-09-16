import { describe, expect, test } from "bun:test";
import { REASONING_EFFORTS } from "@yanlinglabs/winter-core";
import { parseModelArgs, validateEffort, validateModelTag, validateAdvisorSlug, renderModelListing } from "../src/model-cli";

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
// (`validateModelTag` then `catalogRowsFor`) — deliberately not a live provider list, since this
// command runs with no daemon RPC.
describe("validateAdvisorSlug", () => {
  test("a real catalog tag is valid", () => {
    expect(validateAdvisorSlug("anthropic/claude-opus-5")).toBeUndefined();
  });

  test("a bare (non-tag) slug is rejected with the tag-shaped message", () => {
    expect(validateAdvisorSlug("claude-opus-5")).toMatch(/provider-qualified tag/);
  });

  test("a tag-shaped model with zero catalog rows is rejected, naming the clearing spelling", () => {
    const err = validateAdvisorSlug("anthropic/totally-made-up-model-xyz");
    expect(err).not.toBeUndefined();
    expect(err).toContain("auto");
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
