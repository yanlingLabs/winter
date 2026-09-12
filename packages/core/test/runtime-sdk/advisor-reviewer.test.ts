// Phase 8d Task 3.1 (P8d-8) — unit coverage for `advisor-reviewer.ts`'s D30 default table and the
// "no credential for this family" branch (review fix F3: checked SYNCHRONOUSLY at `resolveReviewer()`
// time, against `credentialPresenceCache`'s background-refreshed snapshot — never inside
// `generate()`). The cache starts COLD for every name (see that function's own doc): a test that
// wrote credential material still needs to poll `resolve()` a few times for the background probe to
// land — `waitForResolved` below is that poll, and it is the honest shape of "a synchronous answer
// over an asynchronous fact", not a flake workaround.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolvedReviewer, ReviewerResolver } from "@yanlinglabs/winter-agent-sdk/tools";
import { FileSecretStore } from "../../src/auth/secret-store";
import { CREDENTIAL_MATERIAL_NAMES, writeCredentialMaterial } from "../../src/auth/credential-material";
import { ANTHROPIC_CREDENTIAL_SECRET_NAME } from "../../src/runtime-sdk/keychain";
import { advisorReviewerFor, d30DefaultModel, familyOfModel, officialLegDefaultSessionModel } from "../../src/runtime-sdk/advisor-reviewer";
import type { Settings } from "../../src/settings";

function withAdvisorModel(advisorModel: string | undefined): Settings {
  return { schemaVersion: 2, runtimes: { advisorModel } } as unknown as Settings;
}

function withProviderModel(model: string): Settings {
  return { schemaVersion: 2, provider: { type: "codex-oauth", model }, runtimes: {} } as unknown as Settings;
}

/** Polls `resolve()` until it stops answering `undefined` (the background credential-presence probe
 *  has landed) or the timeout passes — the honest way to observe a sync-cache-over-async-fact seam
 *  from a test, never a fixed `Bun.sleep`. */
async function waitForResolved(resolve: ReviewerResolver, timeoutMs = 2000): Promise<ResolvedReviewer | undefined> {
  const t0 = Date.now();
  let last: ResolvedReviewer | undefined;
  do {
    last = resolve();
    if (last !== undefined) return last;
    await new Promise((r) => setTimeout(r, 5));
  } while (Date.now() - t0 < timeoutMs);
  return last;
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
  const build = async (
    settings: Settings | undefined, sessionModel: string | undefined,
    material: Array<{ name: string }> = [],
  ) => {
    secretsDir = mkdtempSync(join(tmpdir(), "advisor-reviewer-secrets-"));
    const secrets = new FileSecretStore(secretsDir);
    for (const m of material) await writeCredentialMaterial(secrets, m.name, { kind: "api-key", key: "sk-test" });
    return advisorReviewerFor({
      settings: () => settings,
      secrets,
      familyOf: familyOfModel,
      sessionModel: () => sessionModel,
    });
  };
  const cleanup = () => { try { rmSync(secretsDir, { recursive: true, force: true }); } catch { /* best effort */ } };

  test("no explicit setting, no session model -> undefined (nothing to derive a default from)", async () => {
    const resolve = await build(withAdvisorModel(undefined), undefined);
    expect(resolve()).toBeUndefined();
    cleanup();
  });

  test("no explicit setting, a gpt-family session model, a codex-oauth credential present -> the D30 default (astra), openai family", async () => {
    const resolve = await build(withAdvisorModel(undefined), "codex-oauth/gpt-6-astra", [{ name: CREDENTIAL_MATERIAL_NAMES.codexOauth }]);
    const resolved = await waitForResolved(resolve);
    expect(resolved?.model).toBe("gpt-6-astra");
    expect(resolved?.provider).toBeDefined();
    cleanup();
  });

  test("no explicit setting, a claude-family session model, an anthropic credential present -> the D30 default (fable)", async () => {
    const resolve = await build(withAdvisorModel(undefined), "anthropic/claude-sonnet-5", [{ name: ANTHROPIC_CREDENTIAL_SECRET_NAME }]);
    const resolved = await waitForResolved(resolve);
    expect(resolved?.model).toBe("claude-fable-5.1");
    expect(resolved?.provider).toBeDefined();
    cleanup();
  });

  test("an explicit runtimes.advisorModel WINS over the D30 default, live (with the target family's credential present)", async () => {
    const settings = withAdvisorModel("anthropic/claude-opus-5");
    const resolve = await build(settings, "codex-oauth/gpt-6-astra", [{ name: ANTHROPIC_CREDENTIAL_SECRET_NAME }]); // session is gpt-family; the setting still wins
    const resolved = await waitForResolved(resolve);
    expect(resolved?.model).toBe("anthropic/claude-opus-5");
    cleanup();
  });

  test("a family this daemon has no provider-runtime mapping for (\"other\") -> undefined, never a throw", async () => {
    const resolve = await build(withAdvisorModel("aimlapi/gemini-1.5-pro"), undefined);
    expect(familyOfModel("aimlapi/gemini-1.5-pro")).toBe("other");
    expect(resolve()).toBeUndefined();
    cleanup();
  });

  test("hot: re-reading settings.runtimes.advisorModel takes effect on the very next call, no restart", async () => {
    // Built DIRECTLY (not via the `build()` helper above) — `settings` must be a LIVE getter over
    // this OUTER `let` binding, which `build()`'s own parameter-capture cannot give it.
    let settings: Settings = withAdvisorModel("codex-oauth/gpt-6-astra");
    secretsDir = mkdtempSync(join(tmpdir(), "advisor-reviewer-secrets-"));
    const secrets = new FileSecretStore(secretsDir);
    await writeCredentialMaterial(secrets, CREDENTIAL_MATERIAL_NAMES.codexOauth, { kind: "oauth", accessToken: "tok" });
    await writeCredentialMaterial(secrets, ANTHROPIC_CREDENTIAL_SECRET_NAME, { kind: "api-key", key: "sk-test" });
    const resolve = advisorReviewerFor({ settings: () => settings, secrets, familyOf: familyOfModel, sessionModel: () => undefined });
    expect((await waitForResolved(resolve))?.model).toBe("codex-oauth/gpt-6-astra");
    settings = withAdvisorModel("anthropic/claude-fable-5-1"); // the catalog KEY (dash) — canonicalModelId uses a dot
    expect((await waitForResolved(resolve))?.model).toBe("anthropic/claude-fable-5-1");
    cleanup();
  });
});

describe("F3 (review round 1) — the resolver returns undefined when no credential for the target family exists", () => {
  let secretsDir: string;
  const cleanup = () => { try { rmSync(secretsDir, { recursive: true, force: true }); } catch { /* best effort */ } };

  test("openai family, NO credential stored at all -> undefined (never a reviewer built on a missing credential)", async () => {
    secretsDir = mkdtempSync(join(tmpdir(), "advisor-reviewer-f3-secrets-"));
    const resolve = advisorReviewerFor({
      settings: () => withAdvisorModel(undefined),
      secrets: new FileSecretStore(secretsDir),
      familyOf: familyOfModel,
      sessionModel: () => "codex-oauth/gpt-6-astra",
    });
    // Poll long enough for the (empty) background probe to land — still absent either way.
    const resolved = await waitForResolved(resolve, 500);
    expect(resolved).toBeUndefined();
    cleanup();
  });

  test("openai family, a codex-oauth credential IS stored -> a reviewer resolves", async () => {
    secretsDir = mkdtempSync(join(tmpdir(), "advisor-reviewer-f3-secrets-"));
    const secrets = new FileSecretStore(secretsDir);
    await writeCredentialMaterial(secrets, CREDENTIAL_MATERIAL_NAMES.codexOauth, { kind: "oauth", accessToken: "tok" });
    const resolve = advisorReviewerFor({
      settings: () => withAdvisorModel(undefined),
      secrets,
      familyOf: familyOfModel,
      sessionModel: () => "codex-oauth/gpt-6-astra",
    });
    const resolved = await waitForResolved(resolve);
    expect(resolved).toBeDefined();
    expect(resolved!.model).toBe("gpt-6-astra");
    cleanup();
  });

  test("claude family, NO anthropic credential stored -> undefined", async () => {
    secretsDir = mkdtempSync(join(tmpdir(), "advisor-reviewer-f3-secrets-"));
    const resolve = advisorReviewerFor({
      settings: () => withAdvisorModel(undefined),
      secrets: new FileSecretStore(secretsDir),
      familyOf: familyOfModel,
      sessionModel: () => "anthropic/claude-sonnet-5",
    });
    const resolved = await waitForResolved(resolve, 500);
    expect(resolved).toBeUndefined();
    cleanup();
  });

  test("claude family, the anthropic credential IS stored -> a reviewer resolves", async () => {
    secretsDir = mkdtempSync(join(tmpdir(), "advisor-reviewer-f3-secrets-"));
    const secrets = new FileSecretStore(secretsDir);
    await writeCredentialMaterial(secrets, ANTHROPIC_CREDENTIAL_SECRET_NAME, { kind: "api-key", key: "sk-test" });
    const resolve = advisorReviewerFor({
      settings: () => withAdvisorModel(undefined),
      secrets,
      familyOf: familyOfModel,
      sessionModel: () => "anthropic/claude-sonnet-5",
    });
    const resolved = await waitForResolved(resolve);
    expect(resolved).toBeDefined();
    expect(resolved!.model).toBe("claude-fable-5.1");
    cleanup();
  });
});

describe("F1 (review round 1) — the official leg's D30 default never derives from settings.provider.model", () => {
  test("officialLegDefaultSessionModel() reports a Claude-family model unconditionally", () => {
    const model = officialLegDefaultSessionModel();
    expect(model).toBeDefined();
    expect(familyOfModel(model!)).toBe("claude");
  });

  test("a daemon whose settings.provider.model is a CODEX (openai-family) model still resolves a Claude reviewer for the official leg", async () => {
    const secretsDir = mkdtempSync(join(tmpdir(), "advisor-reviewer-f1-secrets-"));
    const secrets = new FileSecretStore(secretsDir);
    // The official leg's own credential family (anthropic) — present, so F3's gate does not itself
    // account for the "undefined" this test would otherwise (wrongly) attribute to F1.
    await writeCredentialMaterial(secrets, ANTHROPIC_CREDENTIAL_SECRET_NAME, { kind: "api-key", key: "sk-test" });
    // The EXACT wiring shape daemon.ts uses after the fix: `sessionModel` is
    // `officialLegDefaultSessionModel`, wired independently of `settings()` — a settings object whose
    // OWN provider is a codex-oauth (openai-family) model must not leak into the official leg's
    // reviewer choice at all.
    const settings = withProviderModel("gpt-5.6-sol"); // an openai-family model, deliberately
    const resolve = advisorReviewerFor({
      settings: () => settings,
      secrets,
      familyOf: familyOfModel,
      sessionModel: officialLegDefaultSessionModel,
    });
    const resolved = await waitForResolved(resolve);
    expect(resolved).toBeDefined();
    expect(familyOfModel(resolved!.model)).toBe("claude"); // NEVER "openai", despite settings.provider.model
    rmSync(secretsDir, { recursive: true, force: true });
  });
});
