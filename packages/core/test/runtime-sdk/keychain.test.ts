import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXA_API_KEY_SECRET } from "../../src/agent/tools/search";
import { WEB_SEARCH_API_KEY_SECRET } from "../../src/agent/tools/web";
import { FileSecretStore, type SecretStore } from "../../src/auth/secret-store";
import { TOKEN_NAMES } from "../../src/auth/tokens";
import { keychainService } from "../../src/profile";
import { OPENAI_API_KEY_SECRET } from "../../src/providers/manager";
import { CODEX_SECRET_NAMES, CREDENTIAL_MATERIAL_NAMES, CodexAuthStore, writeOpenAiApiKey } from "../../src/auth/credential-material";
import { credentialPresenceFrom, credentialRefFor, keychainSeamFromSecretStore, WINTER_CREDENTIAL_INVENTORY, ANTHROPIC_CREDENTIAL_SECRET_NAME, ANTHROPIC_CONSOLE_CREDENTIAL_SECRET_NAME } from "../../src/runtime-sdk/keychain";
import { ANTHROPIC_CONSOLE_CREDENTIAL_ACCOUNT } from "@yanlinglabs/winter-provider-runtime";
import { Settings } from "../../src/settings";

// The real `CredentialRef` (`@yanlinglabs/winter-agent-sdk` protocol/config.d.ts:317-333) is a
// discriminated union with NO `api_key` kind and NO `provider`/`secretName` fields — the brief's
// `{ kind: "api_key", provider, secretName }` placeholder does not exist on the installed type.
// The kind that names a Keychain-backed secret is `{ kind: "keychain"; account: string; service?:
// string }`; `account` is the secret name, `service` is checked against Winter's own
// `keychainService()` by this adapter (see keychain.ts).
//
// HOTFIX (post-8b, 2026-09-11): the inventory's secret names moved from raw token/key strings
// ("openai-api-key" / "codex-access-token") to JSON `CredentialMaterial` records ("openai:default"
// / "codex-oauth:default") — see auth/credential-material.ts. `keychainSeamFromSecretStore.read`
// now unpacks the material and hands back the BARE injectable string, never the JSON blob.

let dir: string;
let store: FileSecretStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "p8b-kc-"));
  store = new FileSecretStore(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A `SecretStore` whose `get` always rejects — simulates a locked/denied Keychain (F2). */
class ThrowingSecretStore implements SecretStore {
  async get(): Promise<string | null> {
    const err = new Error("keychain locked — should never appear in a log line");
    (err as Error & { code?: string }).code = "EKEYCHAINLOCKED";
    throw err;
  }
  async set(): Promise<void> {
    throw new Error("not used by these tests");
  }
}

describe("KeychainSeam over SecretStore", () => {
  test("present → the BARE material value (never the JSON wrapper); absent → undefined (a NORMAL answer, never a throw)", async () => {
    await writeOpenAiApiKey(store, "sk-test");
    const seam = keychainSeamFromSecretStore(store);
    expect(await seam.read({ kind: "keychain", account: CREDENTIAL_MATERIAL_NAMES.openai })).toBe("sk-test");
    expect(await seam.read({ kind: "keychain", account: "nope" })).toBeUndefined();
  });

  test("a record holding a raw non-JSON string (a pre-migration leftover) returns undefined", async () => {
    await store.set(CREDENTIAL_MATERIAL_NAMES.openai, "sk-raw-leftover"); // not JSON — the shape the OLD inventory used to store
    expect(await keychainSeamFromSecretStore(store).read({ kind: "keychain", account: CREDENTIAL_MATERIAL_NAMES.openai })).toBeUndefined();
  });

  test("CodexAuthStore.save() writes material the seam unpacks to the bare access token", async () => {
    await new CodexAuthStore(store).save({ accessToken: "a", refreshToken: "r", idToken: null, accountId: null, expiresAt: 0 });
    const seam = keychainSeamFromSecretStore(store);
    expect(await seam.read({ kind: "keychain", account: CREDENTIAL_MATERIAL_NAMES.codexOauth })).toBe("a");
  });

  test("a ref the inventory does not know is refused as undefined (no arbitrary secret-name reads)", async () => {
    await store.set("sparkle-private-key", "never");
    expect(await keychainSeamFromSecretStore(store).read({ kind: "keychain", account: "sparkle-private-key" })).toBeUndefined();
  });

  test("a non-keychain CredentialRef kind is refused as undefined, never a throw", async () => {
    const seam = keychainSeamFromSecretStore(store);
    expect(await seam.read({ kind: "env", name: "ANTHROPIC_API_KEY" })).toBeUndefined();
    expect(await seam.read({ kind: "none" })).toBeUndefined();
  });

  test("a stored EMPTY secret reads as undefined, exactly like presence treats it (winter logout writes \"\" to the codex material record)", async () => {
    await store.set(CREDENTIAL_MATERIAL_NAMES.openai, "");
    expect(await keychainSeamFromSecretStore(store).read({ kind: "keychain", account: CREDENTIAL_MATERIAL_NAMES.openai })).toBeUndefined();
  });

  test("a SecretStore.get failure never propagates — read() reports undefined, not a rejection", async () => {
    const seam = keychainSeamFromSecretStore(new ThrowingSecretStore());
    await expect(seam.read({ kind: "keychain", account: CREDENTIAL_MATERIAL_NAMES.openai })).resolves.toBeUndefined();
  });

  test("a ref.service that differs from Winter's own keychainService() is refused; unset service is accepted", async () => {
    await writeOpenAiApiKey(store, "sk-test");
    const seam = keychainSeamFromSecretStore(store);
    expect(await seam.read({ kind: "keychain", account: CREDENTIAL_MATERIAL_NAMES.openai })).toBe("sk-test");
    expect(await seam.read({ kind: "keychain", account: CREDENTIAL_MATERIAL_NAMES.openai, service: keychainService() })).toBe("sk-test");
    expect(await seam.read({ kind: "keychain", account: CREDENTIAL_MATERIAL_NAMES.openai, service: "com.some.other.vendor" })).toBeUndefined();
  });

  test("credentialPresenceFrom lists providers by KIND only — no material anywhere in the result", async () => {
    await writeOpenAiApiKey(store, "sk-test");
    const presence = await credentialPresenceFrom(store);
    expect(presence.byProvider.openai).toBe("keychain");
    expect(presence.byProvider["codex-oauth"]).toBeUndefined();
    expect(JSON.stringify(presence)).not.toContain("sk-test");
  });

  test("credentialPresenceFrom reports codex only once VALID OAuth material is stored", async () => {
    await new CodexAuthStore(store).save({ accessToken: "at_live", refreshToken: null, idToken: null, accountId: null, expiresAt: 0 });
    const presence = await credentialPresenceFrom(store);
    expect(presence.byProvider["codex-oauth"]).toBe("keychain");
    expect(presence.byProvider.openai).toBeUndefined();
    // P8c-10: authByProvider is now filled for every present provider this file has a family for.
    expect(presence.authByProvider).toEqual({ "codex-oauth": { authFamily: "custom" } });
  });

  test("credentialPresenceFrom: authByProvider (P8c-10) — openai and anthropic are api-key, codex-oauth is custom", async () => {
    await writeOpenAiApiKey(store, "sk-test");
    await store.set(WINTER_CREDENTIAL_INVENTORY.find((s) => s.provider === "anthropic")!.secretName, JSON.stringify({ kind: "api-key", key: "sk-ant-test" }));
    const presence = await credentialPresenceFrom(store);
    expect(presence.authByProvider).toEqual({ openai: { authFamily: "api-key" }, anthropic: { authFamily: "api-key" } });
  });

  test("credentialPresenceFrom: PRESENCE IS PARSEABILITY (hotfix review r1, M1) — a raw non-JSON leftover (the OLD pre-hotfix shape) is ABSENT, never present", async () => {
    await store.set(WINTER_CREDENTIAL_INVENTORY.find((s) => s.provider === "codex-oauth")!.secretName, "codex-token");
    const presence = await credentialPresenceFrom(store);
    expect(presence.byProvider["codex-oauth"]).toBeUndefined();
  });

  test("a SecretStore.get failure never propagates — credentialPresenceFrom treats the slot as absent", async () => {
    const presence = await credentialPresenceFrom(new ThrowingSecretStore());
    expect(presence.byProvider).toEqual({});
  });

  test("the inventory's contents are pinned — adding/renaming a provider is a deliberate edit to this test too", () => {
    expect(WINTER_CREDENTIAL_INVENTORY).toEqual([
      { provider: "openai", secretName: "openai:default", kind: "keychain" },
      { provider: "codex-oauth", secretName: "codex-oauth:default", kind: "keychain" },
      { provider: "anthropic", secretName: "anthropic:default", kind: "keychain" },
      // Fix wave 3 (M-B): a SECOND "anthropic" row for the console bearer account — see this
      // row's own comment in keychain.ts for why `credentialRefFor` never reaches it via the
      // generic per-provider `.find()` lookup, and why its presence here still matters (the
      // seam's "known accounts" set, and `credentialPresenceFrom`'s console-only presence case).
      { provider: "anthropic", secretName: "anthropic:console", kind: "keychain" },
    ]);
  });

  test("every non-provider secret is excluded from the inventory AND refused by read() even when present", async () => {
    const excluded = [
      "sparkle-private-key",
      TOKEN_NAMES.harness,
      TOKEN_NAMES.admin,
      TOKEN_NAMES.remote,
      EXA_API_KEY_SECRET,
      WEB_SEARCH_API_KEY_SECRET,
      // LEGACY raw records (hotfix): migration-source/logout-target only now, never read through
      // this seam.
      OPENAI_API_KEY_SECRET,
      CODEX_SECRET_NAMES.access,
      CODEX_SECRET_NAMES.refresh,
      CODEX_SECRET_NAMES.id,
      CODEX_SECRET_NAMES.account,
      CODEX_SECRET_NAMES.expires,
    ];
    const inventoryNames = new Set(WINTER_CREDENTIAL_INVENTORY.map((s) => s.secretName));
    const seam = keychainSeamFromSecretStore(store);
    for (const name of excluded) {
      expect(inventoryNames.has(name)).toBe(false);
      await store.set(name, "present");
      expect(await seam.read({ kind: "keychain", account: name })).toBeUndefined();
    }
  });

  test("credentialRefFor names a known provider's ref (matching 8a's keychain:<account> locator form); unknown providers get undefined", () => {
    expect(credentialRefFor("openai")).toEqual({ kind: "keychain", account: "openai:default", service: keychainService() });
    expect(credentialRefFor("codex-oauth")).toEqual({ kind: "keychain", account: "codex-oauth:default", service: keychainService() });
    expect(credentialRefFor("nope")).toBeUndefined();
  });

  // Fix wave 3 (M-B): the two anthropic accounts each answer EXACTLY ONE material kind.
  describe("the two anthropic accounts each serve exactly one material kind (M-B)", () => {
    test("anthropic:default (api-key) refuses bearer material — the api-key arm can never inject an OAuth token as ANTHROPIC_API_KEY", async () => {
      await store.set(ANTHROPIC_CREDENTIAL_SECRET_NAME, JSON.stringify({ kind: "bearer", token: "console-bearer-should-never-leak-here" }));
      const seam = keychainSeamFromSecretStore(store);
      expect(await seam.read({ kind: "keychain", account: ANTHROPIC_CREDENTIAL_SECRET_NAME })).toBeUndefined();
    });

    test("anthropic:default (api-key) refuses oauth material too — not just bearer", async () => {
      await store.set(ANTHROPIC_CREDENTIAL_SECRET_NAME, JSON.stringify({ kind: "oauth", accessToken: "should-never-leak-here" }));
      const seam = keychainSeamFromSecretStore(store);
      expect(await seam.read({ kind: "keychain", account: ANTHROPIC_CREDENTIAL_SECRET_NAME })).toBeUndefined();
    });

    test("anthropic:default (api-key) still serves its own kind normally", async () => {
      await store.set(ANTHROPIC_CREDENTIAL_SECRET_NAME, JSON.stringify({ kind: "api-key", key: "sk-ant-real" }));
      const seam = keychainSeamFromSecretStore(store);
      expect(await seam.read({ kind: "keychain", account: ANTHROPIC_CREDENTIAL_SECRET_NAME })).toBe("sk-ant-real");
    });

    test("anthropic:console (bearer) refuses api-key material — the console arm can never accidentally serve the user's own api-key", async () => {
      await store.set(ANTHROPIC_CONSOLE_CREDENTIAL_SECRET_NAME, JSON.stringify({ kind: "api-key", key: "sk-ant-should-never-leak-here" }));
      const seam = keychainSeamFromSecretStore(store);
      expect(await seam.read({ kind: "keychain", account: ANTHROPIC_CONSOLE_CREDENTIAL_SECRET_NAME })).toBeUndefined();
    });

    test("anthropic:console (bearer) still serves its own kind normally", async () => {
      await store.set(ANTHROPIC_CONSOLE_CREDENTIAL_SECRET_NAME, JSON.stringify({ kind: "bearer", token: "console-bearer-real" }));
      const seam = keychainSeamFromSecretStore(store);
      expect(await seam.read({ kind: "keychain", account: ANTHROPIC_CONSOLE_CREDENTIAL_SECRET_NAME })).toBe("console-bearer-real");
    });

    test("every OTHER account is unrestricted — openai still serves whatever kind it actually holds", async () => {
      await writeOpenAiApiKey(store, "sk-test");
      const seam = keychainSeamFromSecretStore(store);
      expect(await seam.read({ kind: "keychain", account: CREDENTIAL_MATERIAL_NAMES.openai })).toBe("sk-test");
    });
  });

  describe("credentialRefFor — the console-vs-default anthropic account (M-B, \"Native sessions\")", () => {
    test("with no settings (every pre-existing caller, e.g. advisor-reviewer.ts) — unconditionally anthropic:default, unchanged", () => {
      expect(credentialRefFor("anthropic", dir)).toEqual({ kind: "keychain", account: ANTHROPIC_CREDENTIAL_SECRET_NAME, service: keychainService(undefined, dir) });
    });

    test("settings.runtimes.official.auth = \"console\" -> anthropic:console", () => {
      const settings = Settings.parse({ schemaVersion: 2, provider: { type: "codex-oauth", model: "x" }, runtimes: { official: { auth: "console" } } });
      expect(credentialRefFor("anthropic", dir, settings)).toEqual({ kind: "keychain", account: ANTHROPIC_CONSOLE_CREDENTIAL_SECRET_NAME, service: keychainService(undefined, dir) });
    });

    test("settings.runtimes.official.auth = \"api-key\" -> anthropic:default", () => {
      const settings = Settings.parse({ schemaVersion: 2, provider: { type: "codex-oauth", model: "x" }, runtimes: { official: { auth: "api-key" } } });
      expect(credentialRefFor("anthropic", dir, settings)).toEqual({ kind: "keychain", account: ANTHROPIC_CREDENTIAL_SECRET_NAME, service: keychainService(undefined, dir) });
    });

    test("\"auto\" (the default) with no console profile on disk -> anthropic:default — both legs agree with officialAuthFamilyFor", () => {
      const settings = Settings.parse({ schemaVersion: 2, provider: { type: "codex-oauth", model: "x" } });
      expect(credentialRefFor("anthropic", dir, settings)).toEqual({ kind: "keychain", account: ANTHROPIC_CREDENTIAL_SECRET_NAME, service: keychainService(undefined, dir) });
    });

    test("every OTHER provider is unaffected by the settings parameter", () => {
      const settings = Settings.parse({ schemaVersion: 2, provider: { type: "codex-oauth", model: "x" }, runtimes: { official: { auth: "console" } } });
      expect(credentialRefFor("openai", dir, settings)).toEqual({ kind: "keychain", account: "openai:default", service: keychainService(undefined, dir) });
    });
  });

  // Test-keychain-isolation TRIPWIRE: `test/preload.ts` sets `WINTER_KEYCHAIN_SERVICE` for the
  // whole run, and every real daemon/session in this test process runs on a temp (non-default)
  // `WINTER_HOME` — so a resolution built for ANY test home must never land back on the real
  // `com.winter.core[.dev]` service, no matter which function does the resolving. This fails loudly
  // the moment either the preload's override or `keychainService()`'s default-home guard regresses.
  test("TRIPWIRE: a test-homed credentialRefFor/keychainSeamFromSecretStore resolution never equals the REAL Keychain service", async () => {
    expect(process.env.WINTER_KEYCHAIN_SERVICE).toBeTruthy(); // preload precondition — if this is unset, the tripwire is meaningless
    const ref = credentialRefFor("openai", dir); // `dir` (beforeEach) is a temp, non-default home
    if (ref?.kind !== "keychain") throw new Error("expected a keychain CredentialRef for a known provider");
    expect(ref.service).toBeDefined();
    expect(ref.service).not.toBe("com.winter.core");
    expect(ref.service).not.toBe("com.winter.core.dev");
    expect(ref.service).toBe(process.env.WINTER_KEYCHAIN_SERVICE);

    // The seam built for that same test home must accept a ref stamped with the ISOLATED service
    // (what the child would actually send) and refuse one stamped with the REAL service (proof the
    // isolation is not merely cosmetic — a real-service ref really is treated as "some other vendor").
    await writeOpenAiApiKey(store, "sk-test");
    const seam = keychainSeamFromSecretStore(store, dir);
    expect(await seam.read({ kind: "keychain", account: CREDENTIAL_MATERIAL_NAMES.openai, service: ref.service })).toBe("sk-test");
    expect(await seam.read({ kind: "keychain", account: CREDENTIAL_MATERIAL_NAMES.openai, service: "com.winter.core" })).toBeUndefined();
  });
});

describe("the console bearer's Keychain account (P10a R-10a-6, 0.0.9 integration)", () => {
  test("the daemon's local literal equals the SDK's exported console account, and is never the API-key slot", () => {
    expect(ANTHROPIC_CONSOLE_CREDENTIAL_SECRET_NAME).toBe(ANTHROPIC_CONSOLE_CREDENTIAL_ACCOUNT);
    expect(ANTHROPIC_CONSOLE_CREDENTIAL_SECRET_NAME).not.toBe(ANTHROPIC_CREDENTIAL_SECRET_NAME);
  });
});
