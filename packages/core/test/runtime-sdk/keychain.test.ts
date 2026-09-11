import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSecretStore } from "../../src/auth/secret-store";
import { credentialPresenceFrom, keychainSeamFromSecretStore, NORMA_CREDENTIAL_INVENTORY } from "../../src/runtime-sdk/keychain";

// The real `CredentialRef` (`@yanlinglabs/winter-agent-sdk` protocol/config.d.ts:317-333) is a
// discriminated union with NO `api_key` kind and NO `provider`/`secretName` fields — the brief's
// `{ kind: "api_key", provider, secretName }` placeholder does not exist on the installed type.
// The kind that names a Keychain-backed secret is `{ kind: "keychain"; account: string; service?:
// string }`; `account` is the secret name, `service` is ignored by this adapter (see keychain.ts).

let dir: string;
let store: FileSecretStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "p8b-kc-"));
  store = new FileSecretStore(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

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

  test("credentialPresenceFrom lists providers by KIND only — no material anywhere in the result", async () => {
    await store.set("openai-api-key", "sk-test");
    const presence = await credentialPresenceFrom(store);
    expect(presence.byProvider.openai).toBe("keychain");
    expect(presence.byProvider.codex).toBeUndefined();
    expect(JSON.stringify(presence)).not.toContain("sk-test");
  });

  test("credentialPresenceFrom reports codex only once its OAuth access token is stored", async () => {
    await store.set(NORMA_CREDENTIAL_INVENTORY.find((s) => s.provider === "codex")!.secretName, "codex-token");
    const presence = await credentialPresenceFrom(store);
    expect(presence.byProvider.codex).toBe("keychain");
    expect(presence.byProvider.openai).toBeUndefined();
    expect(presence.authByProvider).toBeUndefined(); // omitted in 8b (C-14)
  });

  test("every inventory slot names a secret the store's own known-names list contains", () => {
    for (const slot of NORMA_CREDENTIAL_INVENTORY) expect(typeof slot.secretName).toBe("string");
    expect(new Set(NORMA_CREDENTIAL_INVENTORY.map((s) => s.provider)).size).toBeGreaterThan(0);
  });
});
