// P8c Task 1.3 — the selection matrix: `familyListingFromCatalog` fed through the router's own
// REAL `selectRuntime`, and `createWinterRuntimeSdk(...).selectRuntimeFor` end to end. Nothing here
// re-derives D13/D28's routing table — the whole point is that Winter's listing/credential inputs
// produce the SAME decision the router's own pinned rules would for a host that got them right.
//
// WS-20 rewrite: `requested.model` is now ALWAYS a provider-qualified TAG — router 0.0.8+ refuses
// a bare id typed (`bare-model-id`) and a `requested.provider` that disagrees with the tag's own
// prefix (`provider-mismatch`), so every direct `selectRuntime(...)` call below now sends BOTH
// fields, split from the same tag, exactly as `create.ts`'s own `buildSelectionInput` does. There
// is no more alias resolution (`catalogRowsFor`, matching a row's `key`/`upstreamId`/
// `canonicalModelId`/`aliases`, is deleted — `rowForTag` is an EXACT catalog-key lookup only), so
// the pre-WS-20 "M2: an alias-only model (haiku/opus)" tests are removed rather than patched: their
// entire premise (a short alias resolving through this listing) no longer exists as a routing
// concept — a bare "haiku" is now simply refused, typed, at the schema door before it ever reaches
// `selectRuntime` at all (see `session-set-model.test.ts`'s "bare id is refused" coverage).
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isSelectionRefusal, selectRuntime, type RuntimeSelection } from "@yanlinglabs/winter-runtime-sdk";
import { FileSecretStore } from "../../src/auth/secret-store";
import { writeCredentialMaterial } from "../../src/auth/credential-material";
import { createWinterRuntimeSdk, type WinterRuntimeSdk } from "../../src/runtime-sdk/create";
import { ANTHROPIC_CREDENTIAL_SECRET_NAME } from "../../src/runtime-sdk/keychain";
import { rowForTag, familyListingFromCatalog } from "../../src/runtime-sdk/provider-selection";

describe("familyListingFromCatalog + the router's own selectRuntime", () => {
  test("anthropic/claude-sonnet-5 + hasClaudePeer + an anthropic api-key credential + code mode -> claude-agent (D13-2)", () => {
    const result = selectRuntime({
      mode: "code",
      requested: { model: "anthropic/claude-sonnet-5", provider: "anthropic" },
      families: familyListingFromCatalog(),
      credentials: { byProvider: { anthropic: "keychain" }, authByProvider: { anthropic: { authFamily: "api-key" } } },
      hasClaudePeer: true,
      claudeOauthApproved: false,
    });
    if (isSelectionRefusal(result)) throw new Error(`unexpected refusal: ${result.detail}`);
    expect(result.runtimeKind).toBe("claude-agent");
    expect(result.reason.startsWith("D13-2")).toBe(true);
  });

  test("the SAME model with no official peer -> winter-agent (R-7b-1-no-peer)", () => {
    const result = selectRuntime({
      mode: "code",
      requested: { model: "anthropic/claude-sonnet-5", provider: "anthropic" },
      families: familyListingFromCatalog(),
      credentials: { byProvider: { anthropic: "keychain" } },
      hasClaudePeer: false,
      claudeOauthApproved: false,
    });
    if (isSelectionRefusal(result)) throw new Error(`unexpected refusal: ${result.detail}`);
    expect(result.runtimeKind).toBe("winter-agent");
    expect(result.reason.startsWith("R-7b-1-no-peer")).toBe(true);
  });

  test("a non-Claude family (openai) always routes to winter-agent (D28), peer present or not", () => {
    for (const hasClaudePeer of [true, false]) {
      const result = selectRuntime({
        mode: "code",
        requested: { model: "openai/gpt-5.6-sol", provider: "openai" },
        families: familyListingFromCatalog(),
        credentials: { byProvider: { openai: "keychain" } },
        hasClaudePeer,
        claudeOauthApproved: false,
      });
      if (isSelectionRefusal(result)) throw new Error(`unexpected refusal: ${result.detail}`);
      expect(result.runtimeKind).toBe("winter-agent");
      expect(result.reason.startsWith("D28")).toBe(true);
    }
  });

  test("dispatch and chat modes run on the Winter runtime even for a Claude model (D13-3-mode)", () => {
    for (const mode of ["dispatch", "chat"] as const) {
      const result = selectRuntime({
        mode,
        requested: { model: "anthropic/claude-sonnet-5", provider: "anthropic" },
        families: familyListingFromCatalog(),
        credentials: { byProvider: { anthropic: "keychain" }, authByProvider: { anthropic: { authFamily: "api-key" } } },
        hasClaudePeer: true,
        claudeOauthApproved: false,
      });
      if (isSelectionRefusal(result)) throw new Error(`unexpected refusal: ${result.detail}`);
      expect(result.runtimeKind).toBe("winter-agent");
      expect(result.reason.startsWith("D13-3-mode")).toBe(true);
    }
  });

  test("a persisted selection is returned BY IDENTITY, never re-decided", () => {
    const persisted: RuntimeSelection = {
      runtimeKind: "winter-agent", providerId: "openai", modelRef: "openai/gpt-5.6-sol", family: "gpt",
      authFamily: "api-key", sdkVersion: "0.0.4", reason: "persisted:test", decidedAt: new Date(0).toISOString(),
    };
    const result = selectRuntime({
      mode: "code",
      requested: { model: "anthropic/claude-sonnet-5", provider: "anthropic" },
      families: familyListingFromCatalog(),
      credentials: { byProvider: { anthropic: "keychain" }, authByProvider: { anthropic: { authFamily: "api-key" } } },
      hasClaudePeer: true,
      claudeOauthApproved: false,
      persisted,
    });
    expect(result).toBe(persisted);
  });

  test("a slot with no configured credential anywhere is a typed refusal, never a substitution", () => {
    let result: unknown;
    try {
      result = selectRuntime({
        mode: "code",
        requested: { model: "anthropic/claude-sonnet-5", provider: "anthropic" },
        families: familyListingFromCatalog(),
        credentials: { byProvider: {} },
        hasClaudePeer: true,
        claudeOauthApproved: false,
      });
    } catch (err) {
      result = err;
    }
    const refusal = ((result as { refusal?: unknown } | null)?.refusal ?? result) as object | undefined;
    expect(refusal !== undefined && isSelectionRefusal(refusal)).toBe(true);
  });

  // WS-20: a bare (non-tag-shaped) `requested.model` is refused typed by the router itself
  // (0.0.8+, reason `bare-model-id`) — never reaches D13/D28 at all. Replaces this file's old M5
  // pair, which pinned `catalogRowsFor` (an alias-matching helper deleted under WS-20); the
  // equivalent EXACT-match lookup `decideRuntime`'s bail-out now uses is `rowForTag`
  // (runtime-sdk/provider-selection.ts), pinned directly here instead.
  test("a bare requested.model is refused typed, never substituted or routed", () => {
    let result: unknown;
    try {
      result = selectRuntime({
        mode: "code",
        requested: { model: "claude-sonnet-5" },
        families: familyListingFromCatalog(),
        credentials: { byProvider: { anthropic: "keychain" }, authByProvider: { anthropic: { authFamily: "api-key" } } },
        hasClaudePeer: true,
        claudeOauthApproved: false,
      });
    } catch (err) {
      result = err;
    }
    const refusal = ((result as { refusal?: unknown } | null)?.refusal ?? result) as object | undefined;
    expect(refusal !== undefined && isSelectionRefusal(refusal)).toBe(true);
  });

  // `decideRuntime`'s own bail-out (session-driver.ts): `rowForTag(model) === undefined` — a tag
  // whose EXACT key no catalog row carries (a custom-endpoint model, off-catalog entirely).
  test("rowForTag: an off-catalog tag (a custom-endpoint model id) has no row — decideRuntime's own bail-out condition", () => {
    expect(rowForTag("openai/my-custom-finetune-id-nobody-published")).toBeUndefined();
  });

  test("rowForTag: a CATALOG-KNOWN tag (anthropic/claude-sonnet-5) always has a row — decideRuntime does NOT bail out on it", () => {
    expect(rowForTag("anthropic/claude-sonnet-5")).toBeDefined();
  });
});

describe("createWinterRuntimeSdk(...).selectRuntimeFor", () => {
  let home: string;
  let secretsDir: string;
  const handles: WinterRuntimeSdk[] = [];

  afterEach(async () => {
    for (const h of handles.splice(0)) await h.dispose();
    rmSync(home, { recursive: true, force: true });
  });

  test("routes anthropic/claude-sonnet-5 to the official leg once the anthropic credential is stored", async () => {
    home = mkdtempSync(join(tmpdir(), "p8c-selection-"));
    secretsDir = join(home, "secrets");
    const secrets = new FileSecretStore(secretsDir);
    await writeCredentialMaterial(secrets, ANTHROPIC_CREDENTIAL_SECRET_NAME, { kind: "api-key", key: "sk-ant-test" });
    const handle = await createWinterRuntimeSdk({ home, settings: () => null, secrets, capabilities: [] });
    handles.push(handle);
    const result = await handle.selectRuntimeFor({ mode: "code", model: "anthropic/claude-sonnet-5" });
    if (isSelectionRefusal(result)) throw new Error(`unexpected refusal: ${result.detail}`);
    // This dev/test environment has the real optional peer installed, so `hasClaudePeer` is true —
    // matching the FIRST describe block's own D13-2 case.
    expect(result.runtimeKind).toBe("claude-agent");
    expect(result.providerId).toBe("anthropic");
  });

  test("refuses typed (never substitutes) when no provider has a credential for the model", async () => {
    home = mkdtempSync(join(tmpdir(), "p8c-selection-"));
    secretsDir = join(home, "secrets");
    const handle = await createWinterRuntimeSdk({ home, settings: () => null, secrets: new FileSecretStore(secretsDir), capabilities: [] });
    handles.push(handle);
    const result = await handle.selectRuntimeFor({ mode: "code", model: "anthropic/claude-sonnet-5" });
    expect(isSelectionRefusal(result)).toBe(true);
  });

  // WS-20: a bare model at this SAME real, end-to-end door (`session-driver.ts`'s `decideRuntime`
  // calls the identical `selectRuntimeFor`) is refused typed too — `buildSelectionInput` only ever
  // sends `requested.provider` alongside a value it itself split from `input.model`, so a caller
  // that hands this door a bare id gets the router's own `bare-model-id` refusal, never a guess.
  test("a bare model at this SAME real door is refused typed, never substituted", async () => {
    home = mkdtempSync(join(tmpdir(), "p8c-selection-bare-"));
    secretsDir = join(home, "secrets");
    const secrets = new FileSecretStore(secretsDir);
    await writeCredentialMaterial(secrets, ANTHROPIC_CREDENTIAL_SECRET_NAME, { kind: "api-key", key: "sk-ant-test" });
    const handle = await createWinterRuntimeSdk({ home, settings: () => null, secrets, capabilities: [] });
    handles.push(handle);
    const result = await handle.selectRuntimeFor({ mode: "code", model: "claude-sonnet-5" });
    expect(isSelectionRefusal(result)).toBe(true);
  });
});
