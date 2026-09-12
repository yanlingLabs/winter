// P8c Task 1.3 — the selection matrix: `familyListingFromCatalog` fed through the router's own
// REAL `selectRuntime`, and `createNormaRuntimeSdk(...).selectRuntimeFor` end to end. Nothing here
// re-derives D13/D28's routing table — the whole point is that Norma's listing/credential inputs
// produce the SAME decision the router's own pinned rules would for a host that got them right.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isSelectionRefusal, selectRuntime, type RuntimeSelection } from "@yanlinglabs/winter-runtime-sdk";
import { FileSecretStore } from "../../src/auth/secret-store";
import { writeCredentialMaterial } from "../../src/auth/credential-material";
import { createNormaRuntimeSdk, type NormaRuntimeSdk } from "../../src/runtime-sdk/create";
import { ANTHROPIC_CREDENTIAL_SECRET_NAME } from "../../src/runtime-sdk/keychain";
import { catalogRowsFor, familyListingFromCatalog } from "../../src/runtime-sdk/provider-selection";

describe("familyListingFromCatalog + the router's own selectRuntime", () => {
  test("claude-sonnet-5 + hasClaudePeer + an anthropic api-key credential + code mode -> claude-agent (D13-2)", () => {
    const result = selectRuntime({
      mode: "code",
      requested: { model: "claude-sonnet-5" },
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
      requested: { model: "claude-sonnet-5" },
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
        requested: { model: "gpt-5.6-sol" },
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
        requested: { model: "claude-sonnet-5" },
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
      requested: { model: "claude-sonnet-5" },
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
        requested: { model: "claude-sonnet-5" },
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

  // Fix round 1, M5: `decideRuntime`'s fourth bail-out (session-driver.ts) reads `catalogRowsFor`
  // directly, never `selectRuntime` — this pins the REAL catalog answer that bail-out depends on.
  test("M5: a model with NO row in the pinned catalog at all (a custom-endpoint model id) — decideRuntime's own bail-out condition", () => {
    expect(catalogRowsFor("my-custom-finetune-id-nobody-published")).toEqual([]);
  });

  test("M5: a CATALOG-KNOWN model (claude-sonnet-5) always has at least one row — decideRuntime does NOT bail out on it", () => {
    expect(catalogRowsFor("claude-sonnet-5").length).toBeGreaterThan(0);
  });

  // Fix wave M2: the router's own `resolveModel` (the SDK's compiled code) matches ONLY a row's
  // `key` or an entry's `canonicalModelId` — it has no `aliases`/`upstreamId` field to consult.
  // `catalogRowsFor` matches a BROADER set (key/upstreamId/canonicalModelId/aliases), so an
  // alias-only model passes `decideRuntime`'s bail-out #4 (a real catalog row exists) and then must
  // still resolve against THIS listing, or it refuses despite being unambiguously catalogued.
  test("M2: an alias-only model (haiku) resolves against the REAL router through familyListingFromCatalog", () => {
    expect(catalogRowsFor("haiku").length).toBeGreaterThan(0); // pins the fixture's own premise
    const result = selectRuntime({
      mode: "code",
      requested: { model: "haiku" },
      families: familyListingFromCatalog(),
      credentials: { byProvider: { anthropic: "keychain" }, authByProvider: { anthropic: { authFamily: "api-key" } } },
      hasClaudePeer: true,
      claudeOauthApproved: false,
    });
    if (isSelectionRefusal(result)) throw new Error(`unexpected refusal: ${result.detail}`);
    expect(result.runtimeKind).toBe("claude-agent");
    expect(result.providerId).toBe("anthropic");
    // The REAL provider-qualified key is stamped — the alias only opened a second door onto the
    // SAME row, it never displaces what `modelRef` records (this file's own `familyListingFromCatalog`
    // doc comment).
    expect(result.modelRef).toBe("anthropic/claude-haiku-4-5-20251001");
  });

  test("M2: an alias never resolves to the WRONG canonical model — 'haiku' and 'opus' land on different rows", () => {
    const families = familyListingFromCatalog();
    const creds = { byProvider: { anthropic: "keychain" as const }, authByProvider: { anthropic: { authFamily: "api-key" as const } } };
    const haiku = selectRuntime({ mode: "code", requested: { model: "haiku" }, families, credentials: creds, hasClaudePeer: true, claudeOauthApproved: false });
    const opus = selectRuntime({ mode: "code", requested: { model: "opus" }, families, credentials: creds, hasClaudePeer: true, claudeOauthApproved: false });
    if (isSelectionRefusal(haiku) || isSelectionRefusal(opus)) throw new Error("unexpected refusal");
    expect(haiku.modelRef).not.toBe(opus.modelRef);
    expect(opus.modelRef).toBe("anthropic/claude-opus-5");
  });
});

describe("createNormaRuntimeSdk(...).selectRuntimeFor", () => {
  let home: string;
  let secretsDir: string;
  const handles: NormaRuntimeSdk[] = [];

  afterEach(async () => {
    for (const h of handles.splice(0)) await h.dispose();
    rmSync(home, { recursive: true, force: true });
  });

  test("routes claude-sonnet-5 to the official leg once the anthropic credential is stored", async () => {
    home = mkdtempSync(join(tmpdir(), "p8c-selection-"));
    secretsDir = join(home, "secrets");
    const secrets = new FileSecretStore(secretsDir);
    await writeCredentialMaterial(secrets, ANTHROPIC_CREDENTIAL_SECRET_NAME, { kind: "api-key", key: "sk-ant-test" });
    const handle = await createNormaRuntimeSdk({ home, settings: () => null, secrets, capabilities: [] });
    handles.push(handle);
    const result = await handle.selectRuntimeFor({ mode: "code", model: "claude-sonnet-5" });
    if (isSelectionRefusal(result)) throw new Error(`unexpected refusal: ${result.detail}`);
    // This dev/test environment has the real optional peer installed, so `hasClaudePeer` is true —
    // matching the FIRST describe block's own D13-2 case.
    expect(result.runtimeKind).toBe("claude-agent");
    expect(result.providerId).toBe("anthropic");
  });

  test("refuses typed (never substitutes) when no provider has a credential for the model", async () => {
    home = mkdtempSync(join(tmpdir(), "p8c-selection-"));
    secretsDir = join(home, "secrets");
    const handle = await createNormaRuntimeSdk({ home, settings: () => null, secrets: new FileSecretStore(secretsDir), capabilities: [] });
    handles.push(handle);
    const result = await handle.selectRuntimeFor({ mode: "code", model: "claude-sonnet-5" });
    expect(isSelectionRefusal(result)).toBe(true);
  });

  // Fix wave M2: the same real, end-to-end door `session-driver.ts`'s `decideRuntime` calls for a
  // NEW session (`selectRuntimeFor`) — an alias-only model must succeed here too, not just against
  // the pure `selectRuntime` function above.
  test("M2: session.create's own door (selectRuntimeFor) resolves an alias-only model (haiku) to the official leg", async () => {
    home = mkdtempSync(join(tmpdir(), "p8c-selection-alias-"));
    secretsDir = join(home, "secrets");
    const secrets = new FileSecretStore(secretsDir);
    await writeCredentialMaterial(secrets, ANTHROPIC_CREDENTIAL_SECRET_NAME, { kind: "api-key", key: "sk-ant-test" });
    const handle = await createNormaRuntimeSdk({ home, settings: () => null, secrets, capabilities: [] });
    handles.push(handle);
    const result = await handle.selectRuntimeFor({ mode: "code", model: "haiku" });
    if (isSelectionRefusal(result)) throw new Error(`unexpected refusal: ${result.detail}`);
    expect(result.runtimeKind).toBe("claude-agent");
    expect(result.providerId).toBe("anthropic");
  });
});
