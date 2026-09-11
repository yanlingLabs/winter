import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXA_API_KEY_SECRET } from "../../src/agent/tools/search";
import { WEB_SEARCH_API_KEY_SECRET } from "../../src/agent/tools/web";
import { FileSecretStore, type SecretStore } from "../../src/auth/secret-store";
import { TOKEN_NAMES } from "../../src/auth/tokens";
import { keychainService } from "../../src/profile";
import { CODEX_SECRET_NAMES } from "../../src/providers/codex-oauth";
import { credentialPresenceFrom, credentialRefFor, keychainSeamFromSecretStore, NORMA_CREDENTIAL_INVENTORY } from "../../src/runtime-sdk/keychain";

// The real `CredentialRef` (`@yanlinglabs/winter-agent-sdk` protocol/config.d.ts:317-333) is a
// discriminated union with NO `api_key` kind and NO `provider`/`secretName` fields — the brief's
// `{ kind: "api_key", provider, secretName }` placeholder does not exist on the installed type.
// The kind that names a Keychain-backed secret is `{ kind: "keychain"; account: string; service?:
// string }`; `account` is the secret name, `service` is checked against Norma's own
// `keychainService()` by this adapter (see keychain.ts).

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
  test("present → the material; absent → undefined (a NORMAL answer, never a throw)", async () => {
    await store.set("openai-api-key", "sk-test");
    const seam = keychainSeamFromSecretStore(store);
    expect(await seam.read({ kind: "keychain", account: "openai-api-key" })).toBe("sk-test");
    expect(await seam.read({ kind: "keychain", account: "nope" })).toBeUndefined();
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

  test("a stored EMPTY secret reads as undefined, exactly like presence treats it (norma logout writes \"\" to codex secrets)", async () => {
    await store.set("openai-api-key", "");
    expect(await keychainSeamFromSecretStore(store).read({ kind: "keychain", account: "openai-api-key" })).toBeUndefined();
  });

  test("a SecretStore.get failure never propagates — read() reports undefined, not a rejection", async () => {
    const seam = keychainSeamFromSecretStore(new ThrowingSecretStore());
    await expect(seam.read({ kind: "keychain", account: "openai-api-key" })).resolves.toBeUndefined();
  });

  test("a ref.service that differs from Norma's own keychainService() is refused; unset service is accepted", async () => {
    await store.set("openai-api-key", "sk-test");
    const seam = keychainSeamFromSecretStore(store);
    expect(await seam.read({ kind: "keychain", account: "openai-api-key" })).toBe("sk-test");
    expect(await seam.read({ kind: "keychain", account: "openai-api-key", service: keychainService() })).toBe("sk-test");
    expect(await seam.read({ kind: "keychain", account: "openai-api-key", service: "com.some.other.vendor" })).toBeUndefined();
  });

  test("credentialPresenceFrom lists providers by KIND only — no material anywhere in the result", async () => {
    await store.set("openai-api-key", "sk-test");
    const presence = await credentialPresenceFrom(store);
    expect(presence.byProvider.openai).toBe("keychain");
    expect(presence.byProvider["codex-oauth"]).toBeUndefined();
    expect(JSON.stringify(presence)).not.toContain("sk-test");
  });

  test("credentialPresenceFrom reports codex only once its OAuth access token is stored", async () => {
    await store.set(NORMA_CREDENTIAL_INVENTORY.find((s) => s.provider === "codex-oauth")!.secretName, "codex-token");
    const presence = await credentialPresenceFrom(store);
    expect(presence.byProvider["codex-oauth"]).toBe("keychain");
    expect(presence.byProvider.openai).toBeUndefined();
    expect(presence.authByProvider).toBeUndefined(); // omitted in 8b (C-14)
  });

  test("a SecretStore.get failure never propagates — credentialPresenceFrom treats the slot as absent", async () => {
    const presence = await credentialPresenceFrom(new ThrowingSecretStore());
    expect(presence.byProvider).toEqual({});
  });

  test("the inventory's contents are pinned — adding/renaming a provider is a deliberate edit to this test too", () => {
    expect(NORMA_CREDENTIAL_INVENTORY).toEqual([
      { provider: "openai", secretName: "openai-api-key", kind: "keychain" },
      { provider: "codex-oauth", secretName: "codex-access-token", kind: "keychain" },
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
      CODEX_SECRET_NAMES.refresh,
      CODEX_SECRET_NAMES.id,
      CODEX_SECRET_NAMES.account,
      CODEX_SECRET_NAMES.expires,
    ];
    const inventoryNames = new Set(NORMA_CREDENTIAL_INVENTORY.map((s) => s.secretName));
    const seam = keychainSeamFromSecretStore(store);
    for (const name of excluded) {
      expect(inventoryNames.has(name)).toBe(false);
      await store.set(name, "present");
      expect(await seam.read({ kind: "keychain", account: name })).toBeUndefined();
    }
  });

  test("credentialRefFor names a known provider's ref (matching 8a's keychain:<account> locator form); unknown providers get undefined", () => {
    expect(credentialRefFor("openai")).toEqual({ kind: "keychain", account: "openai-api-key", service: keychainService() });
    expect(credentialRefFor("codex-oauth")).toEqual({ kind: "keychain", account: "codex-access-token", service: keychainService() });
    expect(credentialRefFor("nope")).toBeUndefined();
  });
});
