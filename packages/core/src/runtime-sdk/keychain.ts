import type { CredentialRef } from "@yanlinglabs/winter-agent-sdk";
import type { CredentialPresence, KeychainSeam } from "@yanlinglabs/winter-runtime-sdk";
import type { SecretStore } from "../auth/secret-store";
import { CODEX_SECRET_NAMES } from "../providers/codex-oauth";
import { OPENAI_API_KEY_SECRET } from "../providers/manager";

/**
 * One row of the credential inventory: a provider id, the `SecretStore` name that backs it, and
 * the `CredentialRef["kind"]` it is reached through. Norma's own secrets are ALWAYS Keychain-
 * resident in production (`KeychainSecretStore` over `Bun.secrets`; `FileSecretStore` stands in
 * for it in tests) — so every row here is `kind: "keychain"`. `CredentialRef`'s other kinds
 * (`env`/`file`/`inline`/`aws-default-chain`/`none`) name credentials the HOST supplies some other
 * way; this inventory has nothing to say about them (`keychainSeamFromSecretStore.read` below
 * refuses anything that isn't `kind: "keychain"`).
 */
export interface CredentialSlot {
  provider: string;
  secretName: string;
  kind: CredentialRef["kind"];
}

/**
 * The known PROVIDER-routing secrets — never the full `SecretStore` namespace. `auth/tokens.ts`'s
 * `TOKEN_NAMES` (harness/admin/remote — pairing/remote auth, not a model provider) and
 * `agent/tools/{search,web}.ts`'s `EXA_API_KEY_SECRET`/`WEB_SEARCH_API_KEY_SECRET` (daemon-owned
 * Search/ReadPage capability-tool keys, P8b-12 — never routed through a `CredentialRef`) are
 * DELIBERATELY excluded, same as the Sparkle key. Only the two provider-credential families
 * `createProvider` (`providers/manager.ts:104-113`) reads from today are IN:
 *
 *  - `openai` — `OPENAI_API_KEY_SECRET` = "openai-api-key" (`providers/manager.ts:10`), the
 *    `openai-compatible` provider type's single API key.
 *  - `codex` — `CODEX_SECRET_NAMES.access` = "codex-access-token" (`providers/codex-oauth.ts:9`),
 *    the OAuth access token that gates `CodexAuthStore.load()` (`codex-oauth.ts:28-29`: "no access
 *    token" IS "no credential"). The other four `CODEX_SECRET_NAMES` entries (refresh/id/
 *    account/expires, `codex-oauth.ts:10-13`) are refresh/session bookkeeping for that SAME OAuth
 *    credential, not a separate provider token — they stay internal to `CodexAuthStore`
 *    (`providers/codex-oauth.ts`), which reads them directly off the `SecretStore`, never through
 *    this seam. Only the access token is a `CredentialSlot` here.
 */
export const NORMA_CREDENTIAL_INVENTORY: readonly CredentialSlot[] = [
  { provider: "openai", secretName: OPENAI_API_KEY_SECRET, kind: "keychain" },
  { provider: "codex", secretName: CODEX_SECRET_NAMES.access, kind: "keychain" },
];

/**
 * `KeychainSeam` over Norma's own `SecretStore` (`Bun.secrets` in production via
 * `KeychainSecretStore`; `FileSecretStore` in tests — never opened directly here). `undefined` is
 * the seam's NORMAL answer for a miss (surface map §1.3) — never a throw, and never a log of the
 * ref or the material.
 *
 * Only `ref.kind === "keychain"` is answerable from this store (every other `CredentialRef` kind
 * names a credential the host resolves some other way — an env var, a file, an inline value, the
 * AWS default chain, or none at all — and this seam has nothing to say about those). Within that,
 * only a `ref.account` present in `NORMA_CREDENTIAL_INVENTORY` is served: an unlisted secret name
 * (e.g. the Sparkle key) is refused as `undefined`, identically to a genuine miss — there is no
 * arbitrary secret-name read through this seam. `ref.service` is ignored: Norma's `SecretStore`
 * already resolves its one Keychain service once at module load (`auth/secret-store.ts:16`,
 * profile-aware via `keychainService()`), so there is no per-call service to route on.
 */
export function keychainSeamFromSecretStore(store: SecretStore): KeychainSeam {
  const known = new Set(NORMA_CREDENTIAL_INVENTORY.map((slot) => slot.secretName));
  return {
    async read(ref: CredentialRef): Promise<string | undefined> {
      if (ref.kind !== "keychain") return undefined;
      if (!known.has(ref.account)) return undefined;
      return (await store.get(ref.account)) ?? undefined;
    },
  };
}

/**
 * Presence-by-provider (`CredentialPresence.byProvider`), never the material: each inventory slot
 * is probed with `store.get` and, when present, contributes `provider → kind`. `authByProvider` is
 * omitted (C-14 — deferred to 8c). Never log the probed values; a `JSON.stringify` of the result
 * can never contain a secret because none is ever assigned into it.
 */
export async function credentialPresenceFrom(
  store: SecretStore,
  inventory: readonly CredentialSlot[] = NORMA_CREDENTIAL_INVENTORY,
): Promise<CredentialPresence> {
  const byProvider: Record<string, CredentialRef["kind"]> = {};
  for (const slot of inventory) {
    const value = await store.get(slot.secretName);
    if (value) byProvider[slot.provider] = slot.kind;
  }
  return { byProvider };
}
