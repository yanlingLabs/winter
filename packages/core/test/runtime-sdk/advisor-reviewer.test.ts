// Phase 8d Task 3.1 (P8d-8) — unit coverage for `advisor-reviewer.ts`'s D30 default table and the
// "no provider mapping for this family" branch. The credential-presence check itself is deferred to
// `AdvisorReviewer.generate()` (async — `resolveReviewer()` is synchronous by contract), so it is not
// exercised here; see this file's own header on `advisorReviewerFor` for why that split is correct.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSecretStore } from "../../src/auth/secret-store";
import { advisorReviewerFor, d30DefaultModel, familyOfModel } from "../../src/runtime-sdk/advisor-reviewer";
import type { Settings } from "../../src/settings";

function withAdvisorModel(advisorModel: string | undefined): Settings {
  return { schemaVersion: 2, runtimes: { advisorModel } } as unknown as Settings;
}

describe("familyOfModel / d30DefaultModel — the D30 per-family table", () => {
  test("an openai (gpt) family model resolves to the family's own slot-1 canonical id", () => {
    expect(familyOfModel("codex-oauth/gpt-6-astra")).toBe("openai");
    expect(d30DefaultModel("codex-oauth/gpt-6-astra")).toBe("gpt-6-astra");
    expect(d30DefaultModel("gpt-6-astra")).toBe("gpt-6-astra"); // already the default itself
  });

  test("a claude family model resolves to the family's own slot-1 canonical id (fable)", () => {
    expect(familyOfModel("anthropic/claude-sonnet-5")).toBe("claude");
    expect(d30DefaultModel("anthropic/claude-sonnet-5")).toBe("claude-fable-5.1");
  });

  test("an unrecognised / other-family model falls through to itself (\"else the session's own model\")", () => {
    expect(familyOfModel("not-a-real-model-id")).toBe("other");
    expect(d30DefaultModel("not-a-real-model-id")).toBe("not-a-real-model-id");
  });

  test("no session model at all -> no default at all", () => {
    expect(d30DefaultModel(undefined)).toBeUndefined();
  });
});

describe("advisorReviewerFor — the ONE ReviewerResolver for the official leg", () => {
  let secretsDir: string;
  const build = (settings: Settings | undefined, sessionModel: string | undefined) => {
    secretsDir = mkdtempSync(join(tmpdir(), "advisor-reviewer-secrets-"));
    return advisorReviewerFor({
      settings: () => settings,
      secrets: new FileSecretStore(secretsDir),
      familyOf: familyOfModel,
      sessionModel: () => sessionModel,
    });
  };
  const cleanup = () => { try { rmSync(secretsDir, { recursive: true, force: true }); } catch { /* best effort */ } };

  test("no explicit setting, no session model -> undefined (nothing to derive a default from)", () => {
    const resolve = build(withAdvisorModel(undefined), undefined);
    expect(resolve()).toBeUndefined();
    cleanup();
  });

  test("no explicit setting, a gpt-family session model -> the D30 default (astra), openai family", () => {
    const resolve = build(withAdvisorModel(undefined), "codex-oauth/gpt-6-astra");
    const resolved = resolve();
    expect(resolved?.model).toBe("gpt-6-astra");
    expect(resolved?.provider).toBeDefined();
    cleanup();
  });

  test("no explicit setting, a claude-family session model -> the D30 default (fable)", () => {
    const resolve = build(withAdvisorModel(undefined), "anthropic/claude-sonnet-5");
    const resolved = resolve();
    expect(resolved?.model).toBe("claude-fable-5.1");
    expect(resolved?.provider).toBeDefined();
    cleanup();
  });

  test("an explicit runtimes.advisorModel WINS over the D30 default, live", () => {
    let settings = withAdvisorModel("anthropic/claude-opus-5");
    const resolve = build(settings, "codex-oauth/gpt-6-astra"); // session is gpt-family; the setting still wins
    expect(resolve()?.model).toBe("anthropic/claude-opus-5");
    cleanup();
  });

  test("a family this daemon has no provider-runtime mapping for (\"other\") -> undefined, never a throw", () => {
    const resolve = build(withAdvisorModel("aimlapi/gemini-1.5-pro"), undefined);
    expect(familyOfModel("aimlapi/gemini-1.5-pro")).toBe("other");
    expect(resolve()).toBeUndefined();
    cleanup();
  });

  test("hot: re-reading settings.runtimes.advisorModel takes effect on the very next call, no restart", () => {
    let settings: Settings = withAdvisorModel("codex-oauth/gpt-6-astra");
    secretsDir = mkdtempSync(join(tmpdir(), "advisor-reviewer-secrets-"));
    const resolve = advisorReviewerFor({
      settings: () => settings,
      secrets: new FileSecretStore(secretsDir),
      familyOf: familyOfModel,
      sessionModel: () => undefined,
    });
    expect(resolve()?.model).toBe("codex-oauth/gpt-6-astra");
    settings = withAdvisorModel("anthropic/claude-fable-5-1"); // the catalog KEY (dash) — canonicalModelId uses a dot
    expect(resolve()?.model).toBe("anthropic/claude-fable-5-1");
    cleanup();
  });
});
