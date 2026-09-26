import type { CredentialRef } from "@yanlinglabs/winter-agent-sdk";
import type { CredentialPresence } from "@yanlinglabs/winter-runtime-sdk";
import { loadCatalog } from "@yanlinglabs/winter-provider-catalog";
import type { WinterProviderDescriptor } from "@yanlinglabs/winter-provider-catalog";
import type { SecretStore } from "../auth/secret-store";
import { keychainService } from "../profile";
import { CREDENTIAL_MATERIAL_NAMES, readCredentialMaterial, writeCredentialMaterial } from "../auth/credential-material";

/**
 * One row of the credential inventory: a provider id, the `SecretStore` name that backs it, and
 * the `CredentialRef["kind"]` it is reached through. Winter's own secrets are ALWAYS Keychain-
 * resident in production (`KeychainSecretStore` over `Bun.secrets`; `FileSecretStore` stands in
 * for it in tests) — so every row here is `kind: "keychain"`. `CredentialRef`'s other kinds
 * (`env`/`file`/`inline`/`aws-default-chain`/`none`) name credentials the HOST supplies some other
 * way; this inventory has nothing to say about them (`credentialRefFor` below only ever names a
 * `kind: "keychain"` ref).
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
 * the `Search` capability tool's Exa key — never routed through a `CredentialRef`) are
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
 * target — never named by a credential ref, and `CodexAuthStore` no longer writes them at all.
 *
 * SUPERSEDED BY WS-19 (W19-1): the list used to be a LITERAL array on purpose, so that adding a
 * provider was a deliberate, reviewable edit. That is exactly what the standing "providers live in
 * the SDKs" ruling reversed — the inventory is now DERIVED from the pinned catalog
 * (`credentialInventory()` below), and `keychain.test.ts` pins the DERIVATION (today's four-row
 * prefix, the count formula, spot rows in and out) instead of the contents.
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
 * (`splitTag(settings.provider.model).providerId`, `runtime-state/migrations/backfill.ts:44`) — so
 * aligning to the catalog collapsed two of the three vocabularies into one for the Codex case.
 *
 * WS-20: `settings.provider.type` is GONE entirely — `settings.provider.model` is now a tag, and
 * `splitTag(...).providerId` IS the catalog id for every provider this inventory names. The one
 * remaining two-spelling case is NOT a settings vocabulary any more: it is the INTERNAL
 * `Provider.id` literal (`providers/runtime-provider.ts`) the daemon's own internal-calls adapter
 * reports for itself — `"openai-compatible"` for every non-codex-oauth tag, never the catalog's
 * `"openai"` id — which is a different concept from this inventory (credential slots, keyed by
 * catalog provider id) and must not be cross-read with it either.
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

/**
 * Winter Phase 10a fix wave 3 (M-B): the console profile's OWN Keychain slot — a SEPARATE account
 * from `anthropic:default` above. `anthropic:default` is the user's own API-KEY material
 * (`winter login --anthropic-key`); the console broker's bearer material (refreshed off
 * `ant auth print-credentials`, `console-profile-broker.ts`) now lands here instead, never mixed
 * into the api-key slot. Same LOCAL-literal convention as `ANTHROPIC_CREDENTIAL_SECRET_NAME` above
 * — `keychain.test.ts` pins it equal to the SDK's own `ANTHROPIC_CONSOLE_CREDENTIAL_ACCOUNT`, the
 * one account the SDK's Anthropic adapter honours a Console bearer under.
 *
 * The account NAME keeps its `anthropic:` prefix (it predates the catalog's separate `console`
 * provider, and renaming a Keychain item would strand every signed-in home), but since the WS-23
 * live-gate fix its inventory ROW is filed under the `console` catalog provider — see
 * `credentialInventory`'s head array. `anthropic/*` always names `anthropic:default`; `console/*`
 * always names this account.
 */
export const ANTHROPIC_CONSOLE_CREDENTIAL_SECRET_NAME = "anthropic:console";

/**
 * The ONE material kind each Anthropic account may hold, for PRESENCE (`credentialPresenceFrom`) and
 * `credential.list`'s own `present` (`credentials.ts`) alike — so the two never disagree about a stray
 * record of the wrong kind. An api-key sitting in the console account is not "console present" (the
 * SDK's adapter would refuse to send it there), and a bearer sitting in `anthropic:default` is not
 * "anthropic present" (the adapter refuses a bearer under any account but the console one — see
 * `buildHeaders` in the SDK's `adapters/anthropic/messages.ts`). Every other slot has no required kind:
 * any material the child's `coerceMaterial` accepts counts.
 */
export const ANTHROPIC_ACCOUNT_REQUIRED_KIND: Readonly<Record<string, "api-key" | "bearer">> = {
  [ANTHROPIC_CREDENTIAL_SECRET_NAME]: "api-key",
  [ANTHROPIC_CONSOLE_CREDENTIAL_SECRET_NAME]: "bearer",
};

/** `winter login --anthropic-key` (`cli/main.ts`) — the SAME `{kind:"api-key", key}` material shape
 *  `writeOpenAiApiKey` writes, under the anthropic row's own name. No legacy raw-key record exists
 *  for this provider (it is new in 8c), so there is no blank-the-legacy-name step to mirror. */
export async function writeAnthropicApiKey(store: SecretStore, key: string): Promise<void> {
  await writeCredentialMaterial(store, ANTHROPIC_CREDENTIAL_SECRET_NAME, { kind: "api-key", key });
}

/**
 * WS-19 (W19-1): the inventory is DERIVED FROM THE CATALOG, never hand-extended again.
 *
 * The four-row literal this replaced is the reason WS-18's five-hop chain was unreachable in the
 * product: `providerSelectionFor` refuses any model whose provider has no row here, so DeepSeek,
 * GLM and OpenRouter could not be routed to at all no matter what the user stored. The standing
 * ruling ("providers and login systems live in the agent SDKs; the daemon owns only storage slots")
 * makes derivation the only correct shape: a catalog bump that adds a provider adds its credential
 * slot, with no edit here.
 *
 * WHICH ROWS (spec §3): every catalog provider whose `authKinds` includes `"api-key"`, whose
 * `risk.class` is not `"blocked"`, and which does not require the user's own endpoint
 * (`requiresUserEndpoint` — `azure-ai`, `oci`, whose shipped endpoint is a placeholder host). Every
 * `local-none` row, every `cloud-credential-chain`-only row and every blocked row is absent by
 * construction rather than by a denylist anyone has to maintain.
 *
 * THE ORDER SELECTS NOTHING (since WS-20). It used to be load-bearing: the retired bare-id selector
 * (`providerSelectionFor`) broke ties between providers serving one bare model id by inventory order.
 * A model is always a provider-qualified tag now, so the tag names its provider and this order never
 * decides which provider or credential a session or a job uses. What it still orders, and why the
 * four-row head stays pinned (`keychain.test.ts`) with the derived remainder in catalog order behind
 * it: `credential.list`'s row order (the Providers pane, the phone), and which credentialed provider
 * an internal role's `no-default-model` refusal NAMES when nothing the user chose can run it
 * (`preferredInternalProviderFor`'s last rung, via `internalProviderPreferenceOrder`).
 *
 * The two OAuth rows are NOT derived — they are the fixed accounts Winter's own bespoke login doors
 * write (`codex-oauth:default` from `winter login`, `anthropic:console` from the console broker) and
 * they carry no api-key slot of their own. Each is filed under the catalog provider it serves
 * (`codex-oauth`, `console`), so every provider appears exactly once.
 *
 * Memoised: `loadCatalog()` is itself memoised for the life of the process and the catalog is
 * immutable, so this array is computed once and handed back by reference (callers treat it as
 * `readonly`, and `WINTER_CREDENTIAL_INVENTORY` below is exactly this call's result).
 */
let memoisedInventory: readonly CredentialSlot[] | undefined;

/** The SDK's own account convention (`keychain-store.ts`'s `DEFAULT_PROVIDER_ACCOUNT_ID`): one
 *  fixed account per provider — multi-account is explicitly out of WS-19's scope. Spelled here so
 *  the derived secret names and `auth/credential-material.ts`'s two hand-written literals
 *  (`openai:default`, `codex-oauth:default`) are visibly the same convention. */
export const DEFAULT_CREDENTIAL_ACCOUNT_ID = "default";

/** Spec §3's membership test, spelled once so `credentialInventory` and `credentialRows` (and any
 *  test that wants to reason about the same set) cannot drift. */
export function isInScopeApiKeyProvider(p: WinterProviderDescriptor): boolean {
  return p.authKinds.includes("api-key") && p.risk.class !== "blocked" && p.requiresUserEndpoint !== true;
}

export function credentialInventory(): readonly CredentialSlot[] {
  if (memoisedInventory !== undefined) return memoisedInventory;
  // Today's four, verbatim and first — see the order note above.
  const head: CredentialSlot[] = [
    { provider: "openai", secretName: CREDENTIAL_MATERIAL_NAMES.openai, kind: "keychain" },
    { provider: "codex-oauth", secretName: CREDENTIAL_MATERIAL_NAMES.codexOauth, kind: "keychain" },
    { provider: "anthropic", secretName: ANTHROPIC_CREDENTIAL_SECRET_NAME, kind: "keychain" },
    // The console broker's bearer account, filed under the `console` CATALOG provider (WS-23 live-gate
    // fix). Fix wave 3 (M-B) had filed it under "anthropic": in the official-leg era a Console-only home
    // still had to select the `anthropic` provider so the `claude` child would use the `ant` profile.
    // That conflation is what refused every `console/*` session at create time once the Winter runtime
    // served Claude (the router admits a row only when `byProvider` names ITS provider, and nothing
    // produced `byProvider.console`) — and it reported a Console-only home's `anthropic/*` rows as
    // credentialed with no api key behind them. `console` is its own catalog provider on the Winter
    // runtime, and the SDK's Anthropic adapter sends this bearer for exactly that provider id.
    { provider: "console", secretName: ANTHROPIC_CONSOLE_CREDENTIAL_SECRET_NAME, kind: "keychain" },
  ];
  const already = new Set(head.map((s) => s.provider));
  const derived = loadCatalog().providers
    .filter((p) => isInScopeApiKeyProvider(p) && !already.has(p.id))
    .map<CredentialSlot>((p) => ({ provider: p.id, secretName: `${p.id}:${DEFAULT_CREDENTIAL_ACCOUNT_ID}`, kind: "keychain" }));
  memoisedInventory = [...head, ...derived];
  return memoisedInventory;
}

/** The exported constant name every existing caller already reads — now the derivation's result
 *  rather than a literal (WS-19 §5 keeps the name deliberately: nothing downstream changes). */
export const WINTER_CREDENTIAL_INVENTORY: readonly CredentialSlot[] = credentialInventory();

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
 * The `CredentialRef` for a known provider, or `undefined` when `provider` is not in
 * `WINTER_CREDENTIAL_INVENTORY`. Its `account` is the inventory's `secretName` and its `service` is
 * Winter's own `keychainService()` — the pair the child resolves itself (the daemon never reads through it).
 *
 * The `keychain:<account>` string form of this ref (never constructed here — see 8a) is the exact
 * locator `RuntimeSessionRecord.authRef` persists (`runtime-state/records.ts:46`: "Opaque locator
 * (`keychain:openai-api-key`), never credential material" — the doc example predates this hotfix;
 * new records persist `keychain:openai:default` / `keychain:codex-oauth:default`, still opaque);
 * pinned by `test/runtime-state/records.test.ts:373-375` (a literal locator string, unaffected by
 * the account-name rename). Callers that need that string form derive it as
 * ``keychain:${ref.account}`` from this function's result, rather than hand-building either form
 * separately — this function is the one place that knows both.
 *
 * WS-20: the arm is no longer decided HERE — a model is always a provider-qualified tag, so the
 * caller already names `"anthropic"` or `"console"` as two SEPARATE providers (the tag's own
 * prefix), and this function just looks up each one's fixed inventory row like every other
 * provider.
 *
 * WS-23 (the Winter-only pivot, 2026-09-25): `console` names the console broker's OWN bearer slot
 * (`anthropic:console`, refreshed off `ant auth print-credentials` by `console-profile-broker.ts`)
 * — the official `claude` leg that used to read the on-disk profile is gone, and the Winter child
 * needs a credential locator like every other provider. The slot holds `{kind:"bearer", token}`
 * material, which the child's `coerceMaterial` accepts and the SDK's anthropic-messages adapter sends
 * as `Authorization: Bearer` plus the OAuth beta for the `console` provider id. Since the live-gate fix
 * that slot is an ordinary inventory row filed under `console`, so this is the same one lookup as
 * every other provider — and presence (`credentialPresenceFrom`) reads the same slot this names.
 */
export function credentialRefFor(provider: string, home?: string): CredentialRef | undefined {
  const slot = WINTER_CREDENTIAL_INVENTORY.find((s) => s.provider === provider);
  if (!slot) return undefined;
  return { kind: "keychain", account: slot.secretName, service: keychainService(undefined, home) };
}

/**
 * Presence-by-provider (`CredentialPresence.byProvider`), never the material: each inventory slot
 * is probed through `readCredentialMaterial` (the one `get` + parse) and, when it parses to real material, contributes `provider → kind`. `authByProvider` is
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
 * An Anthropic account additionally counts only when it holds ITS kind (`ANTHROPIC_ACCOUNT_REQUIRED_KIND`
 * — api-key in `anthropic:default`, bearer in `anthropic:console`), the same narrowing
 * `credential.list` applies, so the router's admission and the Providers pane agree on a stray record.
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
/** WS-19 (W19-1): DERIVED alongside the inventory rather than a three-row literal — every derived
 *  api-key row is `"api-key"`, and `codex-oauth` (Winter's own OAuth material shape) stays
 *  `"custom"`, exactly as before. `console` has no entry, deliberately: its family is not expressible
 *  in this `"api-key" | "custom"` vocabulary, and the router names it itself — `candidatesFor`
 *  overrides a `console` row's auth family to `console-profile` whenever a ref admits it, so the
 *  presence `byProvider.console` carries is all it needs. */
let memoisedAuthFamily: Readonly<Record<string, "api-key" | "custom">> | undefined;
function providerAuthFamilyMap(): Readonly<Record<string, "api-key" | "custom">> {
  if (memoisedAuthFamily !== undefined) return memoisedAuthFamily;
  const map: Record<string, "api-key" | "custom"> = { "codex-oauth": "custom" };
  for (const p of loadCatalog().providers) {
    if (isInScopeApiKeyProvider(p)) map[p.id] = "api-key";
  }
  memoisedAuthFamily = map;
  return map;
}

/** Kept as an exported binding for readers that want the table itself (it was a module-private
 *  literal before WS-19); it is the derivation's result, computed once. */
export const PROVIDER_AUTH_FAMILY: Readonly<Record<string, "api-key" | "custom">> = providerAuthFamilyMap();

export async function credentialPresenceFrom(
  store: SecretStore,
  inventory: readonly CredentialSlot[] = WINTER_CREDENTIAL_INVENTORY,
): Promise<CredentialPresence> {
  // WS-19: the inventory went from 4 rows to ~150, and this probe runs on every session
  // create/open and every `selectRuntimeFor`. Sequential awaits would turn one presence probe into
  // ~150 round-trips to the Keychain in series; the reads are independent, so they are issued
  // together and the RESULT is folded in inventory order afterwards, which keeps the answer (and
  // the order of any warning) identical to the sequential version.
  const probed = await Promise.all(inventory.map(async (slot) => {
    try {
      return { slot, material: await readCredentialMaterial(store, slot.secretName) };
    } catch (err) {
      return { slot, failure: describeError(err) };
    }
  }));
  const byProvider: Record<string, CredentialRef["kind"]> = {};
  const authByProvider: Record<string, { authFamily: "api-key" | "custom" }> = {};
  const authFamilies = providerAuthFamilyMap();
  // WS-19 (review Minor 4): ONE aggregated line, not one per slot. The inventory is ~150 rows now,
  // and a locked or denied Keychain fails every one of them — the per-slot form turned a single
  // fault into 148 identical log lines per probe, on every session open. A COUNT and the error
  // CODES only; never a secret name (the failing set is the whole inventory, which the log already
  // knows), and never a value.
  const failures: string[] = [];
  for (const row of probed) {
    if ("failure" in row && row.failure !== undefined) {
      failures.push(row.failure);
      continue;
    }
    const required = ANTHROPIC_ACCOUNT_REQUIRED_KIND[row.slot.secretName];
    if (row.material && (required === undefined || row.material.kind === required)) {
      byProvider[row.slot.provider] = row.slot.kind;
      const authFamily = authFamilies[row.slot.provider];
      if (authFamily !== undefined) authByProvider[row.slot.provider] = { authFamily };
    }
  }
  if (failures.length > 0) {
    console.warn(`[keychain] ${failures.length} of ${probed.length} presence probe(s) failed (${[...new Set(failures)].join(", ")})`);
  }
  return { byProvider, ...(Object.keys(authByProvider).length === 0 ? {} : { authByProvider }) };
}

/**
 * 2026-09-18 (agent SDK 0.0.17): does the item THIS REF NAMES hold usable material right now?
 *
 * For an auxiliary route whose whole point is "state this model only if the credential this daemon
 * can NAME for it is really there" — `Options.web.fetch.authRef` and a cross-provider advisor's
 * `authRef`, whose absence is a typed refusal on every call rather than a fallback. It was written when
 * `CredentialPresence.byProvider`'s `anthropic` key covered two accounts (fixed since: every provider
 * now has exactly one slot); it stays because it reads only the ONE item the route would name instead
 * of probing the whole ~150-slot inventory, on a path that runs once per incarnation.
 *
 * ONE probe of ONE named item, and only the caller's `undefined`/boolean ever leaves it — the value is
 * never read into anything logged or returned, and a store failure reads as absent.
 */
export async function refMaterialPresent(store: SecretStore | undefined, ref: CredentialRef | undefined): Promise<boolean> {
  if (store === undefined || ref === undefined || ref.kind !== "keychain") return false;
  try {
    const material = await readCredentialMaterial(store, ref.account);
    const required = ANTHROPIC_ACCOUNT_REQUIRED_KIND[ref.account];
    return material !== null && (required === undefined || material.kind === required);
  } catch {
    return false;
  }
}

/**
 * 2026-09-18: "does this CATALOG PROVIDER hold a credential right now" — the one rule every
 * provider-facing listing answers it with, shared by `ipc/picker-models.ts` (`sync.config`'s `models`)
 * and `providers/model-catalog-wire.ts` (`models.catalog`'s `providers`), so the two surfaces cannot
 * disagree about whether a provider is ready.
 *
 * WS-23 live-gate fix: `console` is answered by its Keychain slot like every other provider, no longer
 * by the on-disk `ant` profile (`consoleProfileCredentialFile`). The slot is what a turn actually sends
 * — the Winter child and the daemon's own internal jobs both read `anthropic:console` — while the
 * profile is only where the broker refreshes it FROM. The two normally move together (a login fills
 * the slot at once; the broker's watcher deletes it when the profile disappears), and where they
 * diverge — a profile whose first refresh has not landed or keeps failing — the profile would offer a
 * provider whose turn cannot run and which the router's create-time admission (the same `byProvider`)
 * refuses. One source is how the listings, selection and the turn gate agree.
 *
 * PRESENCE IS NOT VALIDITY — the file-wide rule (see this module's own header): a stored bearer may be
 * expired or revoked, and only the child/provider layer decides that. `true` here is "offerable",
 * never "promised".
 */
export function credentialPresentProbe(deps: { credentials: CredentialPresence }): (providerId: string) => boolean {
  return (providerId: string): boolean => deps.credentials.byProvider[providerId] !== undefined;
}
