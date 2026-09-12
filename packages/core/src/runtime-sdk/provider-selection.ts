import { loadCatalog } from "@yanlinglabs/winter-provider-catalog";
import type { ModelFamilyListing, ProviderSelection } from "@yanlinglabs/winter-agent-sdk";
import type { CredentialPresence } from "@yanlinglabs/winter-runtime-sdk";
import { NORMA_CREDENTIAL_INVENTORY, credentialRefFor } from "./keychain";

/** The `winter-test/<name>` namespace (Norma map §11.6): selection is BY NAME through
 *  `model: "winter-test/<name>"` plus the env var `WINTER_TEST_PROVIDER`, precisely because a
 *  spawned or compiled child shares no module state with the test process. It is not a catalog
 *  provider and must never be resolved against one. */
export const WINTER_TEST_MODEL_PREFIX = "winter-test/";

/** The test-provider NAME a `winter-test/<name>` model selects, or `undefined`. `buildWinterOptions`
 *  puts it in the child's `WINTER_TEST_PROVIDER`; nothing else in the daemon reads it. */
export function testProviderNameFor(model: string | undefined): string | undefined {
  if (!model?.startsWith(WINTER_TEST_MODEL_PREFIX)) return undefined;
  const name = model.slice(WINTER_TEST_MODEL_PREFIX.length);
  return name || undefined;
}

/** Every catalog row whose id, upstream id, canonical id or alias is `model`. Memoised through
 *  `loadCatalog`, which is itself memoised for the life of the process. */
export function catalogRowsFor(model: string): Array<{ key: string; providerId: string }> {
  const catalog = loadCatalog();
  return catalog.models.filter((m) =>
    m.key === model || m.upstreamId === model || m.canonicalModelId === model || m.aliases.includes(model),
  );
}

/** Is this a fully-qualified `<providerId>/<model>` catalog key? */
function qualifiedProviderFor(model: string): string | undefined {
  const row = loadCatalog().models.find((m) => m.key === model);
  return row?.providerId;
}

/**
 * **Which provider a session's model resolves against, and which credential names it** — the value
 * of `Options.provider` (surface map §7.1).
 *
 * The host NAMES the credential and never reads it: the returned `authRef` is a
 * `{ kind: "keychain", account, service }` locator, and the CHILD resolves the material through the
 * `KeychainSeam` Task 4 built. Nothing here touches a `SecretStore`.
 *
 * The resolution, in order:
 *
 * 1. **No model** → `undefined`. (`Options.model` is separately set by `buildWinterOptions`; "no
 *    model AND no provider" is the child's own typed resolution error, never a silent default.)
 * 2. **`winter-test/<name>`** → `undefined`. The test double is selected by env var, not by the
 *    catalog, and naming a provider for it would be a lie.
 * 3. **A fully-qualified `<providerId>/<model>` key** → that provider, with its ref if Norma has
 *    one. §7.1: "a qualified key needs no `provider` at all" — we still return one so the
 *    credential is named, which is the half the child cannot do for itself.
 * 4. **A bare id** → resolve against the pinned catalog, RESTRICTED to the providers Norma actually
 *    has credentials for. This restriction is load-bearing: a bare id like `gpt-5.6-sol` matches
 *    SIX catalog rows (`agentrouter`, `codex-oauth`, `freeaiapikey`, `kie`, `kilocode`, `openai`),
 *    so "resolve the model id against the catalog" alone is ambiguous and would pick an arbitrary
 *    third-party reseller. Within Norma's own inventory the choice is made in inventory order,
 *    preferring a provider whose credential is actually PRESENT — so a Codex-only install routes
 *    `gpt-5.6-sol` to `codex-oauth` and an API-key install routes it to `openai`, which is exactly
 *    what the engine leg does today.
 * 5. **Served by no inventory provider** → `undefined`, letting the child's own catalog-first
 *    selection answer. Never a host-side throw (a model Norma cannot name is the child's typed
 *    refusal to give, not ours).
 *
 * A provider that serves the model but has NO stored credential still returns a selection WITHOUT
 * an `authRef` — the child then refuses with its own typed provider error, which is a better
 * message than anything the host could invent.
 */
export function providerSelectionFor(
  model: string | undefined,
  credentials: CredentialPresence,
): ProviderSelection | undefined {
  if (!model) return undefined;
  if (model.startsWith(WINTER_TEST_MODEL_PREFIX)) return undefined;

  const qualified = qualifiedProviderFor(model);
  if (qualified) {
    const ref = credentials.byProvider[qualified] ? credentialRefFor(qualified) : undefined;
    return ref ? { providerId: qualified, authRef: ref } : { providerId: qualified };
  }

  const serving = new Set(catalogRowsFor(model).map((r) => r.providerId));
  if (serving.size === 0) return undefined;

  const inInventory = NORMA_CREDENTIAL_INVENTORY.filter((s) => serving.has(s.provider));
  if (inInventory.length === 0) return undefined;

  const withCredential = inInventory.find((s) => credentials.byProvider[s.provider] !== undefined);
  const chosen = withCredential ?? inInventory[0]!;
  const ref = withCredential ? credentialRefFor(chosen.provider) : undefined;
  return ref ? { providerId: chosen.provider, authRef: ref } : { providerId: chosen.provider };
}

/** Which of Norma's inventory providers the pinned catalog says serve `model`. Exported for the
 *  parity test, which pins the EXACT answer for every model Norma's own default catalogue offers —
 *  so a catalog bump that adds or drops a row fails loudly in either direction. */
export function inventoryProvidersServing(model: string): string[] {
  const serving = new Set(catalogRowsFor(model).map((r) => r.providerId));
  return NORMA_CREDENTIAL_INVENTORY.filter((s) => serving.has(s.provider)).map((s) => s.provider);
}

/**
 * P8c-12: `families` — the ONE `ModelFamilyListing` `selectRuntimeFor` (`create.ts`) builds
 * `SelectionInput` from, with exactly the fields `select-runtime.ts`'s `candidatesFor`/
 * `resolveSlot` read (`row.key/providerId/status/servable`, `family.slots[].name/canonicalModelId`).
 *
 * `servable` IS ALWAYS `"unknown"` HERE, DELIBERATELY (never `"present"`/`"absent"`) — Norma has no
 * independent per-provider reachability probe, and the doc on `ModelRowServable` is explicit that
 * `"unknown"` is the honest answer for a row nobody has probed. The REAL admission gate is
 * `candidatesFor`'s OWN separate `providerAuthView`/credential check, which this listing does not
 * duplicate — a row with no configured credential is excluded there regardless of what this
 * function reports for `servable`.
 *
 * `active` is always `undefined` — Norma does not (yet) persist a per-session "active family" the
 * way `Query.listModelFamilies()` does; the D25 reserved-slot names and the "unique name across
 * every family" fallback (`resolveSlot`'s own next two rungs) still work with no active set.
 *
 * `pricingBasis` is a placeholder ("unknown") — no selection-routing logic this file's own read of
 * `select-runtime.ts` consumes it (only `key`/`providerId`/`status`/`servable` are read for a
 * candidate), so inventing a real value here would be exactly the "one place a lane relies on an
 * inference nobody made" this codebase's own culture warns against — recorded as a carry for
 * whichever surface eventually renders it.
 */
export function familyListingFromCatalog(): ModelFamilyListing {
  const catalog = loadCatalog();
  const families = catalog.families.map((family) => {
    const inFamily = catalog.models.filter((m) => m.modelFamily === family.id);
    const canonicalIds = [...new Set(inFamily.map((m) => m.canonicalModelId))];
    const models = canonicalIds.map((canonicalModelId) => {
      const rows = inFamily.filter((m) => m.canonicalModelId === canonicalModelId);
      return {
        canonicalModelId,
        displayName: rows[0]?.displayName ?? canonicalModelId,
        rows: rows.map((r) => ({ key: r.key, providerId: r.providerId, status: r.status, pricingBasis: "unknown", servable: "unknown" as const })),
      };
    });
    return {
      id: family.id,
      displayName: family.displayName,
      vendor: family.vendor,
      slots: family.slots.map((s) => ({ name: s.name, canonicalModelId: s.canonicalModelId, description: s.description, reason: s.reason })),
      models,
    };
  });
  return { active: undefined, families };
}
