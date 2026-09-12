import type { CredentialRef } from "@yanlinglabs/winter-agent-sdk";
import type { CredentialPresence, KeychainSeam } from "@yanlinglabs/winter-runtime-sdk";
import type { SecretStore } from "../auth/secret-store";
import { keychainService } from "../profile";
import { CREDENTIAL_MATERIAL_NAMES, readCredentialMaterial, writeCredentialMaterial } from "../auth/credential-material";

/**
 * One row of the credential inventory: a provider id, the `SecretStore` name that backs it, and
 * the `CredentialRef["kind"]` it is reached through. Winter's own secrets are ALWAYS Keychain-
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
 *  - `openai` — `CREDENTIAL_MATERIAL_NAMES.openai` = "openai:default" (`auth/credential-material.ts`),
 *    a JSON `{ kind: "api-key", key }` record — the `openai-compatible` provider type's single API
 *    key.
 *  - `codex-oauth` — `CREDENTIAL_MATERIAL_NAMES.codexOauth` = "codex-oauth:default", a JSON
 *    `{ kind: "oauth", accessToken, refreshToken?, expiresAt?, accountId?, idToken? }` record.
 *
 * HOTFIX (post-8b, 2026-09-11): these are JSON MATERIAL records, not the raw token/key strings the
 * inventory used to point at (`"openai-api-key"` / `"codex-access-token"`). The spawned Winter
 * child resolves a `CredentialRef` by reading the Keychain ITSELF (`Bun.secrets.get`, never through
 * Winter's own provider code) and `JSON.parse`s whatever it finds — a raw string fails outright
 * ("... is not valid JSON credential material"). `auth/credential-material.ts` is the single
 * source of truth for these records; the OLD raw names (`OPENAI_API_KEY_SECRET`,
 * `CODEX_SECRET_NAMES.access` and its four bookkeeping siblings) are now a one-way migration
 * source (`migrateLegacyCredentialMaterial`, run once at daemon boot) and `winter logout`'s blank
 * target — never read through this seam, and `CodexAuthStore` no longer writes them at all.
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
/**
 * P8c-10: the anthropic row, added for the official leg's `api-key` auth family.
 *
 * `"anthropic:default"` is a LOCAL literal rather than a `CREDENTIAL_MATERIAL_NAMES` member —
 * `auth/credential-material.ts` is not a lane-1-owned file this phase (it is not named in the
 * 8c lane map at all), and `readCredentialMaterial`/`writeCredentialMaterial` both take an
 * arbitrary secret NAME (never keyed off that constant internally), so nothing requires editing it
 * to add a third provider row here. `winter login --anthropic-key` (`cli/main.ts`) writes exactly
 * this name.
 */
export const ANTHROPIC_CREDENTIAL_SECRET_NAME = "anthropic:default";

/** `winter login --anthropic-key` (`cli/main.ts`) — the SAME `{kind:"api-key", key}` material shape
 *  `writeOpenAiApiKey` writes, under the anthropic row's own name. No legacy raw-key record exists
 *  for this provider (it is new in 8c), so there is no blank-the-legacy-name step to mirror. */
export async function writeAnthropicApiKey(store: SecretStore, key: string): Promise<void> {
  await writeCredentialMaterial(store, ANTHROPIC_CREDENTIAL_SECRET_NAME, { kind: "api-key", key });
}

export const WINTER_CREDENTIAL_INVENTORY: readonly CredentialSlot[] = [
  { provider: "openai", secretName: CREDENTIAL_MATERIAL_NAMES.openai, kind: "keychain" },
  { provider: "codex-oauth", secretName: CREDENTIAL_MATERIAL_NAMES.codexOauth, kind: "keychain" },
  { provider: "anthropic", secretName: ANTHROPIC_CREDENTIAL_SECRET_NAME, kind: "keychain" },
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
 * `KeychainSeam` over Winter's own `SecretStore` (`Bun.secrets` in production via
 * `KeychainSecretStore`; `FileSecretStore` in tests — never opened directly here). `undefined` is
 * the seam's NORMAL answer for a miss (surface map §1.3) — never a throw, and never a log of the
 * ref or the material.
 *
 * Only `ref.kind === "keychain"` is answerable from this store (every other `CredentialRef` kind
 * names a credential the host resolves some other way — an env var, a file, an inline value, the
 * AWS default chain, or none at all — and this seam has nothing to say about those). A `ref.service`
 * naming a DIFFERENT Keychain service than Winter's own `keychainService()` is refused (this store
 * has nothing under that service); an unset `service` is accepted, since Winter's `SecretStore`
 * already resolves its one Keychain service once at module load (`auth/secret-store.ts:16`,
 * profile-aware) and most refs this seam sees will not spell it. Within that, only a `ref.account`
 * present in `WINTER_CREDENTIAL_INVENTORY` is served: an unlisted secret name (e.g. the Sparkle key,
 * a pairing token, a Search/ReadPage capability key) is refused as `undefined`, identically to a
 * genuine miss — there is no arbitrary secret-name read through this seam.
 *
 * HOTFIX (post-8b, 2026-09-11): the stored record is now JSON `CredentialMaterial`
 * (`auth/credential-material.ts`), but this seam must still hand back the BARE INJECTABLE STRING,
 * never the JSON blob — the router's official leg (`winter-runtime-sdk` `src/official/auth.ts`
 * `fetchAuthCredentials`) takes exactly what `read()` returns and injects it verbatim as an
 * environment variable (e.g. `ANTHROPIC_API_KEY`); a JSON object there would be a broken
 * credential. `readCredentialMaterial` is the ONE parser (never a second one here): its result is
 * unpacked per kind — `api-key` → `.key`, `oauth` → `.accessToken`, `bearer` → `.token` — the
 * MATERIAL VALUE the child/router actually needs, never the wrapper. A blank record, a missing
 * record, unparsable JSON, or an unrecognized shape all resolve to `undefined` (via
 * `readCredentialMaterial`'s own `null`), with at most the ONE warning it already logs naming the
 * record NAME — never a second warning here, and never the value.
 *
 * A `SecretStore.get` FAILURE (locked/denied Keychain) never propagates: it is caught, logged at
 * `warn` with the secret NAME and an error CODE/class only (never the message text), and reported
 * as `undefined` — a missing credential at spawn is a typed refusal one layer up, never a throw
 * from the middle of a launch.
 */
export function keychainSeamFromSecretStore(store: SecretStore): KeychainSeam {
  const known = new Set(WINTER_CREDENTIAL_INVENTORY.map((slot) => slot.secretName));
  return {
    async read(ref: CredentialRef): Promise<string | undefined> {
      if (ref.kind !== "keychain") return undefined;
      if (ref.service !== undefined && ref.service !== keychainService()) return undefined;
      if (!known.has(ref.account)) return undefined;
      try {
        const material = await readCredentialMaterial(store, ref.account);
        if (material === null) return undefined;
        switch (material.kind) {
          case "api-key": return material.key;
          case "oauth": return material.accessToken;
          case "bearer": return material.token;
          default: {
            // Exhaustiveness (hotfix review r1, m3): a future `CredentialMaterial` variant that
            // forgets to add a case here fails `typecheck:core` on this line, not silently at
            // runtime.
            const _never: never = material;
            return _never;
          }
        }
      } catch (err) {
        console.warn(`[keychain] read failed for "${ref.account}": ${describeError(err)}`);
        return undefined;
      }
    },
  };
}

/**
 * The `CredentialRef` for a known provider, or `undefined` when `provider` is not in
 * `WINTER_CREDENTIAL_INVENTORY`. Its `account` is the inventory's `secretName` and its `service` is
 * Winter's own `keychainService()` — the SAME pair `keychainSeamFromSecretStore.read` above accepts.
 *
 * The `keychain:<account>` string form of this ref (never constructed here — see 8a) is the exact
 * locator `RuntimeSessionRecord.authRef` persists (`runtime-state/records.ts:46`: "Opaque locator
 * (`keychain:openai-api-key`), never credential material" — the doc example predates this hotfix;
 * new records persist `keychain:openai:default` / `keychain:codex-oauth:default`, still opaque);
 * pinned by `test/runtime-state/records.test.ts:373-375` (a literal locator string, unaffected by
 * the account-name rename). Callers that need that string form derive it as
 * ``keychain:${ref.account}`` from this function's result, rather than hand-building either form
 * separately — this function is the one place that knows both.
 */
export function credentialRefFor(provider: string): CredentialRef | undefined {
  const slot = WINTER_CREDENTIAL_INVENTORY.find((s) => s.provider === provider);
  if (!slot) return undefined;
  return { kind: "keychain", account: slot.secretName, service: keychainService() };
}

/**
 * Presence-by-provider (`CredentialPresence.byProvider`), never the material: each inventory slot
 * is probed through `readCredentialMaterial` (the SAME single `get` + parse the seam's `read()`
 * uses) and, when it parses to real material, contributes `provider → kind`. `authByProvider` is
 * omitted (C-14 — deferred to 8c). Never log the probed values; a `JSON.stringify` of the result
 * can never contain a secret because none is ever assigned into it.
 *
 * PRESENCE IS PARSEABILITY, NOT VALIDITY (hotfix review r1, M1): a blank/missing record reads as
 * absent exactly as before (`readCredentialMaterial` returns `null` for both), but a NON-EMPTY
 * record that does not parse into material the child's `coerceMaterial` accepts is now ALSO
 * absent — never "present with material the child will reject". Before this, a raw non-JSON
 * leftover (the exact shape the OLD, pre-hotfix inventory used to store) read as present, which
 * would have `providerSelectionFor` attach a ref the child then failed on, all the way through the
 * SDK's ~72s retry ladder (see the error-classification finding in the hotfix report) — parsing
 * here means that ref is never attached in the first place. This still says nothing about
 * WORKING — an expired-but-well-formed OAuth material with a dead refresh token still reads as
 * present and fails later, at the turn, exactly as documented above.
 *
 * A `SecretStore.get` FAILURE for one slot never propagates and never fails the whole probe: it is
 * caught, logged at `warn` with the secret NAME and an error CODE/class only (never the message
 * text), and that slot is treated as absent — exactly as if the secret were simply not stored.
 * (A malformed-but-present record does NOT hit this catch — `readCredentialMaterial` handles that
 * case itself, with its own single warning, and returns `null` rather than throwing.)
 */
/**
 * P8c-10: which `SelectionAuthFamily` each inventory provider's credential belongs to (WS-14 §12's
 * own table, C-14). `openai`/`anthropic` are both a bare API key; `codex-oauth` is Winter's own
 * OAuth material shape, which the router's selector treats as `"custom"` (never `"claude-oauth"` —
 * that family is reserved for the Anthropic subscription login this daemon does not have, D14).
 */
const PROVIDER_AUTH_FAMILY: Readonly<Record<string, "api-key" | "custom">> = {
  openai: "api-key",
  anthropic: "api-key",
  "codex-oauth": "custom",
};

export async function credentialPresenceFrom(
  store: SecretStore,
  inventory: readonly CredentialSlot[] = WINTER_CREDENTIAL_INVENTORY,
): Promise<CredentialPresence> {
  const byProvider: Record<string, CredentialRef["kind"]> = {};
  const authByProvider: Record<string, { authFamily: "api-key" | "custom" }> = {};
  for (const slot of inventory) {
    let material: Awaited<ReturnType<typeof readCredentialMaterial>>;
    try {
      material = await readCredentialMaterial(store, slot.secretName);
    } catch (err) {
      console.warn(`[keychain] presence probe failed for "${slot.secretName}": ${describeError(err)}`);
      continue;
    }
    if (material) {
      byProvider[slot.provider] = slot.kind;
      const authFamily = PROVIDER_AUTH_FAMILY[slot.provider];
      if (authFamily !== undefined) authByProvider[slot.provider] = { authFamily };
    }
  }
  return { byProvider, ...(Object.keys(authByProvider).length === 0 ? {} : { authByProvider }) };
}
