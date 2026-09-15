import type { CredentialRef } from "@yanlinglabs/winter-agent-sdk";
import type { CredentialPresence, KeychainSeam } from "@yanlinglabs/winter-runtime-sdk";
import { loadCatalog } from "@yanlinglabs/winter-provider-catalog";
import type { WinterProviderDescriptor } from "@yanlinglabs/winter-provider-catalog";
import type { SecretStore } from "../auth/secret-store";
import { keychainService } from "../profile";
import { CREDENTIAL_MATERIAL_NAMES, readCredentialMaterial, writeCredentialMaterial } from "../auth/credential-material";
import { officialAuthFamilyFor } from "./official-options";
import type { Settings } from "../settings";

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

/**
 * Winter Phase 10a fix wave 3 (M-B): the console profile's OWN Keychain slot — a SEPARATE account
 * from `anthropic:default` above. `anthropic:default` is the user's own API-KEY material
 * (`winter login --anthropic-key`); the console broker's bearer material (refreshed off
 * `ant auth print-credentials`, `console-profile-broker.ts`) now lands here instead, never mixed
 * into the api-key slot. Same LOCAL-literal convention as `ANTHROPIC_CREDENTIAL_SECRET_NAME` above
 * — the controller adds the equality test against the SDK's own export at the 0.0.9 integration.
 * `keychainSeamFromSecretStore.read()` below refuses to unpack anything but `bearer` material at
 * this account, and anything but `api-key` material at the default account — but that check is
 * keyed on the ACCOUNT the seam is asked to read, never on the ENV VARIABLE a caller wires the
 * result to. A ref that names THIS account still hands back its bearer, verbatim, to whatever
 * variable a caller pairs it with — including `ANTHROPIC_API_KEY`, if some upstream caller ever
 * built a ref naming this account for the api-key family. (CORRECTED, P10a fix wave 4/M-C: this
 * comment used to claim the seam itself made that "can never accidentally happen" — measured
 * false. `session-driver.ts`'s official-leg `inputDeps()` used to thread live `settings` into
 * `providerSelectionFor`'s "anthropic" resolution, which could hand `officialCredentialPlan` a
 * `provider.authRef` naming THIS account while `selection.authFamily` still said `"api-key"` — the
 * router then dutifully derives `ANTHROPIC_API_KEY` from that ref, and this seam, keyed only on the
 * account, serves the bearer exactly as documented above. What actually keeps the api-key arm off
 * this account is upstream of the seam entirely: that call site is now settings-independent and
 * always names `anthropic:default` — see its own doc comment for the fix.)
 */
export const ANTHROPIC_CONSOLE_CREDENTIAL_SECRET_NAME = "anthropic:console";

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
 * THE ORDER IS LOAD-BEARING and starts with today's four rows VERBATIM. `providerSelectionFor`
 * breaks a tie between several providers serving the same bare model id by inventory order
 * (presence-preferred first), so moving `openai` off the front would silently re-point every
 * credential-less `gpt-5.6-*` session at some third-party reseller. Today's prefix is therefore
 * pinned byte-for-byte and the derived remainder is appended in catalog order behind it.
 *
 * The two OAuth rows are NOT derived — they are the fixed accounts Winter's own bespoke login doors
 * write (`codex-oauth:default` from `winter login`, `anthropic:console` from the console broker) and
 * they carry no api-key slot of their own.
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
    // Fix wave 3 (M-B): a SECOND row for the SAME "anthropic" provider — registers the console
    // account in the seam's "known accounts" set (`keychainSeamFromSecretStore`'s `known` set below)
    // and makes `credentialPresenceFrom`'s presence probe see a console-only install as present, so
    // `providerSelectionFor` still picks "anthropic" as a candidate. `credentialRefFor` below never
    // reaches this row via the generic `.find()` lookup for "anthropic" — it special-cases that
    // provider id and picks the actual account itself (`officialAuthFamilyFor`-driven), so this row's
    // own ORDER relative to the row above never matters for that path.
    { provider: "anthropic", secretName: ANTHROPIC_CONSOLE_CREDENTIAL_SECRET_NAME, kind: "keychain" },
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
/**
 * Winter Phase 10a fix wave 3 (M-B): the two anthropic accounts each answer EXACTLY ONE material
 * kind — `anthropic:default` is the user's own api-key, `anthropic:console` is the console
 * broker's own bearer — never the other. Every OTHER account (`openai:default`,
 * `codex-oauth:default`) is unrestricted here (absent from this map), unpacking whatever kind it
 * actually holds, exactly as before this fix wave. This is a SEPARATE, narrower check than the
 * generic per-kind unpack switch below it: that switch still runs afterward for whatever passes
 * this gate, so adding a kind here still needs its own case there too.
 */
const ANTHROPIC_ACCOUNT_ALLOWED_KIND: Readonly<Record<string, "api-key" | "bearer">> = {
  [ANTHROPIC_CREDENTIAL_SECRET_NAME]: "api-key",
  [ANTHROPIC_CONSOLE_CREDENTIAL_SECRET_NAME]: "bearer",
};

export function keychainSeamFromSecretStore(store: SecretStore, home?: string): KeychainSeam {
  const known = new Set(WINTER_CREDENTIAL_INVENTORY.map((slot) => slot.secretName));
  return {
    async read(ref: CredentialRef): Promise<string | undefined> {
      if (ref.kind !== "keychain") return undefined;
      if (ref.service !== undefined && ref.service !== keychainService(undefined, home)) return undefined;
      if (!known.has(ref.account)) return undefined;
      try {
        const material = await readCredentialMaterial(store, ref.account);
        if (material === null) return undefined;
        // Fix wave 3 (M-B): refuse the WRONG kind at either anthropic account outright — a
        // one-line warning that carries no value (never the material, never even the found kind's
        // actual content, only its NAME).
        const allowedKind = ANTHROPIC_ACCOUNT_ALLOWED_KIND[ref.account];
        if (allowedKind !== undefined && material.kind !== allowedKind) {
          console.warn(`[keychain] "${ref.account}" holds "${material.kind}" material, but only "${allowedKind}" is served from this account — refusing`);
          return undefined;
        }
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
 *
 * Winter Phase 10a fix wave 3 (M-B, "Native sessions"): for `provider === "anthropic"` the account
 * is no longer the inventory row's fixed `secretName` — it is decided FRESH, by reusing
 * `officialAuthFamilyFor(home, settings, …)` (the SAME decision the official leg's own console-vs-
 * api-key arm makes), so both legs agree on which credential a session actually gets. `settings`
 * absent (every pre-existing caller — `advisor-reviewer.ts`'s own internal Anthropic-Messages
 * reviewer deliberately never passes it, since it always wants the plain api-key material) keeps
 * the OLD, unconditional `anthropic:default` behavior — `officialAuthFamilyFor` needs a real
 * `home` to check profile presence, so this new behavior also requires `home`, not just `settings`.
 * Every OTHER provider is unaffected: still the inventory's one fixed row, `.find()`ed as before.
 */
export function credentialRefFor(provider: string, home?: string, settings?: Settings | null): CredentialRef | undefined {
  if (provider === "anthropic") {
    const account = home !== undefined && settings !== undefined && officialAuthFamilyFor(home, settings, false) === "console"
      ? ANTHROPIC_CONSOLE_CREDENTIAL_SECRET_NAME
      : ANTHROPIC_CREDENTIAL_SECRET_NAME;
    return { kind: "keychain", account, service: keychainService(undefined, home) };
  }
  const slot = WINTER_CREDENTIAL_INVENTORY.find((s) => s.provider === provider);
  if (!slot) return undefined;
  return { kind: "keychain", account: slot.secretName, service: keychainService(undefined, home) };
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
/** WS-19 (W19-1): DERIVED alongside the inventory rather than a three-row literal — every derived
 *  api-key row is `"api-key"`, and `codex-oauth` (Winter's own OAuth material shape) stays
 *  `"custom"`, exactly as before. The anthropic console arm needs no entry of its own: it shares the
 *  `"anthropic"` provider id with the api-key row, and the router's selector reads this map by
 *  PROVIDER, not by account — which is what "the anthropic console arm as today" means here. */
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
    if (row.material) {
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
