import type { CredentialRef } from "@yanlinglabs/winter-agent-sdk";
import type { CredentialPresence, KeychainSeam } from "@yanlinglabs/winter-runtime-sdk";
import type { SecretStore } from "../auth/secret-store";
import { keychainService } from "../profile";
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
 *
 * The list is a LITERAL array on purpose (not derived, not spread from elsewhere): adding a
 * provider here is meant to be a deliberate, reviewable edit — `keychain.test.ts` pins the exact
 * contents as a tripwire.
 *
 * PRESENCE IS NOT VALIDITY. `credentialPresenceFrom` (below) reports whether a slot's secret is
 * stored, never whether it still works — an expired Codex access token with a dead refresh token
 * reads as present here and fails later, at the turn, exactly like the engine path does today
 * (`codex-oauth.ts`'s refresh is purely 401-reactive; `expiresAt` is stored but never consulted for
 * a cheaper local check). The child/provider layer is what decides validity, never this inventory.
 *
 * PROVIDER IDS ARE THE PINNED CATALOG'S (Task 9, ruling 9 — this is the alignment Task 4's own
 * caveat said was owed). `CredentialPresence.byProvider` is keyed by the ids the router and the
 * child resolve models against, so they must be `@yanlinglabs/winter-provider-catalog`'s
 * `WinterProviderDescriptor.id` values verbatim — `"openai"` and `"codex-oauth"`, both present in
 * the pinned 0.0.3 catalog (`keychain.test.ts` pins that as a tripwire, so a catalog bump that
 * renamed either row fails here rather than silently un-routing every session).
 *
 * `"codex"` was Task 4's spelling and is GONE: the catalog's row is `codex-oauth`, which is also
 * exactly what 8a already persists as `RuntimeSessionRecord.providerId` for that provider
 * (`settings.provider.type`, `runtime-state/migrations/backfill.ts:44`) — so aligning to the
 * catalog collapsed two of the three vocabularies into one for the Codex case. The OpenAI case
 * still has two spellings (`settings.provider.type` is `"openai-compatible"`, the catalog id is
 * `"openai"`); they must not be cross-read.
 */
export const NORMA_CREDENTIAL_INVENTORY: readonly CredentialSlot[] = [
  { provider: "openai", secretName: OPENAI_API_KEY_SECRET, kind: "keychain" },
  { provider: "codex-oauth", secretName: CODEX_SECRET_NAMES.access, kind: "keychain" },
];

/** Error code/class only — NEVER `.message`, which could embed material for some future
 *  `SecretStore` implementation even though today's two (`Bun.secrets`, file read) do not put
 *  secret values into their own error text. */
function describeError(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    return code !== undefined ? String(code) : err.name;
  }
  return typeof err;
}

/**
 * `KeychainSeam` over Norma's own `SecretStore` (`Bun.secrets` in production via
 * `KeychainSecretStore`; `FileSecretStore` in tests — never opened directly here). `undefined` is
 * the seam's NORMAL answer for a miss (surface map §1.3) — never a throw, and never a log of the
 * ref or the material.
 *
 * Only `ref.kind === "keychain"` is answerable from this store (every other `CredentialRef` kind
 * names a credential the host resolves some other way — an env var, a file, an inline value, the
 * AWS default chain, or none at all — and this seam has nothing to say about those). A `ref.service`
 * naming a DIFFERENT Keychain service than Norma's own `keychainService()` is refused (this store
 * has nothing under that service); an unset `service` is accepted, since Norma's `SecretStore`
 * already resolves its one Keychain service once at module load (`auth/secret-store.ts:16`,
 * profile-aware) and most refs this seam sees will not spell it. Within that, only a `ref.account`
 * present in `NORMA_CREDENTIAL_INVENTORY` is served: an unlisted secret name (e.g. the Sparkle key,
 * a pairing token, a Search/ReadPage capability key) is refused as `undefined`, identically to a
 * genuine miss — there is no arbitrary secret-name read through this seam.
 *
 * A stored-but-EMPTY secret (`norma logout` writes `""` to every Codex secret rather than deleting
 * it) reads as `undefined`, matching `credentialPresenceFrom`'s truthiness check — the two must
 * never disagree about what counts as "no material". A `SecretStore.get` FAILURE (locked/denied
 * Keychain) never propagates: it is caught, logged at `warn` with the secret NAME and an error
 * CODE/class only (never the message text), and reported as `undefined` — a missing credential at
 * spawn is a typed refusal one layer up, never a throw from the middle of a launch.
 */
export function keychainSeamFromSecretStore(store: SecretStore): KeychainSeam {
  const known = new Set(NORMA_CREDENTIAL_INVENTORY.map((slot) => slot.secretName));
  return {
    async read(ref: CredentialRef): Promise<string | undefined> {
      if (ref.kind !== "keychain") return undefined;
      if (ref.service !== undefined && ref.service !== keychainService()) return undefined;
      if (!known.has(ref.account)) return undefined;
      try {
        return (await store.get(ref.account)) || undefined;
      } catch (err) {
        console.warn(`[keychain] read failed for "${ref.account}": ${describeError(err)}`);
        return undefined;
      }
    },
  };
}

/**
 * The `CredentialRef` for a known provider, or `undefined` when `provider` is not in
 * `NORMA_CREDENTIAL_INVENTORY`. Its `account` is the inventory's `secretName` and its `service` is
 * Norma's own `keychainService()` — the SAME pair `keychainSeamFromSecretStore.read` above accepts.
 *
 * The `keychain:<account>` string form of this ref (never constructed here — see 8a) is the exact
 * locator `RuntimeSessionRecord.authRef` persists (`runtime-state/records.ts:46`: "Opaque locator
 * (`keychain:openai-api-key`), never credential material"; pinned by
 * `test/runtime-state/records.test.ts:373-375`). Callers that need that string form derive it as
 * ``keychain:${ref.account}`` from this function's result, rather than hand-building either form
 * separately — this function is the one place that knows both.
 */
export function credentialRefFor(provider: string): CredentialRef | undefined {
  const slot = NORMA_CREDENTIAL_INVENTORY.find((s) => s.provider === provider);
  if (!slot) return undefined;
  return { kind: "keychain", account: slot.secretName, service: keychainService() };
}

/**
 * Presence-by-provider (`CredentialPresence.byProvider`), never the material: each inventory slot
 * is probed with `store.get` and, when present (non-empty — see `keychainSeamFromSecretStore`'s
 * doc comment on `norma logout`'s empty-string writes), contributes `provider → kind`.
 * `authByProvider` is omitted (C-14 — deferred to 8c). Never log the probed values; a
 * `JSON.stringify` of the result can never contain a secret because none is ever assigned into it.
 *
 * A `SecretStore.get` FAILURE for one slot never propagates and never fails the whole probe: it is
 * caught, logged at `warn` with the secret NAME and an error CODE/class only (never the message
 * text), and that slot is treated as absent — exactly as if the secret were simply not stored.
 */
export async function credentialPresenceFrom(
  store: SecretStore,
  inventory: readonly CredentialSlot[] = NORMA_CREDENTIAL_INVENTORY,
): Promise<CredentialPresence> {
  const byProvider: Record<string, CredentialRef["kind"]> = {};
  for (const slot of inventory) {
    let value: string | null;
    try {
      value = await store.get(slot.secretName);
    } catch (err) {
      console.warn(`[keychain] presence probe failed for "${slot.secretName}": ${describeError(err)}`);
      continue;
    }
    if (value) byProvider[slot.provider] = slot.kind;
  }
  return { byProvider };
}
