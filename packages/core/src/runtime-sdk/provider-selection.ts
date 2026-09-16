import { loadCatalog } from "@yanlinglabs/winter-provider-catalog";
import type { ModelFamilyListing, ProviderSelection } from "@yanlinglabs/winter-agent-sdk";
import { credentialRefFor } from "./keychain";
import { splitTag, WINTER_TEST_PREFIX, UNSTATED_TAG, type ModelTag } from "./model-tag";

/** The `winter-test/<name>` namespace (Winter map §11.6): selection is BY NAME through
 *  `model: "winter-test/<name>"` plus the env var `WINTER_TEST_PROVIDER`, precisely because a
 *  spawned or compiled child shares no module state with the test process. It is not a catalog
 *  provider and must never be resolved against one. */
export const WINTER_TEST_MODEL_PREFIX = WINTER_TEST_PREFIX;

/** The test-provider NAME a `winter-test/<name>` model selects, or `undefined`. `buildWinterOptions`
 *  puts it in the child's `WINTER_TEST_PROVIDER`; nothing else in the daemon reads it. */
export function testProviderNameFor(model: string | undefined): string | undefined {
  if (!model?.startsWith(WINTER_TEST_MODEL_PREFIX)) return undefined;
  const name = model.slice(WINTER_TEST_MODEL_PREFIX.length);
  return name || undefined;
}

/** WS-20: the ONE catalog row lookup by its EXACT key — the tag itself, since the catalog row
 *  `key` already IS the provider-qualified tag. Replaces `catalogRowsFor`'s broad alias/upstreamId
 *  matching (a bare-id concept that no longer exists — a tag names exactly one row or none). */
export function rowForTag(tag: string): { key: string; providerId: string } | undefined {
  return loadCatalog().models.find((m) => m.key === tag);
}

/**
 * WS-20: **a tag names exactly its provider and that provider's credential ref.** No selection, no
 * inventory-order tie-break, no bare-id ambiguity — the old bare-id selector this function replaces
 * is gone entirely, because there is nothing left to decide: `splitTag(tag).providerId` IS the
 * answer.
 *
 * `winter-test/*` and the `unstated/unstated` sentinel return `undefined` — the test double is
 * selected by env var, not by the catalog, and the sentinel names no provider to begin with.
 *
 * A provider with no stored credential still returns a selection WITHOUT an `authRef` — the child
 * then refuses with its own typed provider error, which is a better message than anything the host
 * could invent.
 */
export function providerFor(tag: ModelTag | string, home?: string): ProviderSelection | undefined {
  if (tag.startsWith(WINTER_TEST_PREFIX) || tag === UNSTATED_TAG) return undefined;
  const { providerId } = splitTag(tag);
  const ref = credentialRefFor(providerId, home);
  return ref ? { providerId, authRef: ref } : { providerId };
}

/**
 * P8c-12: `families` — the ONE `ModelFamilyListing` `selectRuntimeFor` (`create.ts`) builds
 * `SelectionInput` from, with exactly the fields `select-runtime.ts`'s `candidatesFor`/
 * `resolveSlot` read (`row.key/providerId/status/servable`, `family.slots[].name/canonicalModelId`).
 *
 * `servable` IS ALWAYS `"unknown"` HERE, DELIBERATELY (never `"present"`/`"absent"`) — Winter has no
 * independent per-provider reachability probe, and the doc on `ModelRowServable` is explicit that
 * `"unknown"` is the honest answer for a row nobody has probed. The REAL admission gate is
 * `candidatesFor`'s OWN separate `providerAuthView`/credential check, which this listing does not
 * duplicate — a row with no configured credential is excluded there regardless of what this
 * function reports for `servable`.
 *
 * `active` is always `undefined` — Winter does not (yet) persist a per-session "active family" the
 * way `Query.listModelFamilies()` does; the D25 reserved-slot names and the "unique name across
 * every family" fallback (`resolveSlot`'s own next two rungs) still work with no active set.
 *
 * `pricingBasis` is a placeholder ("unknown") — no selection-routing logic this file's own read of
 * `select-runtime.ts` consumes it (only `key`/`providerId`/`status`/`servable` are read for a
 * candidate), so inventing a real value here would be exactly the "one place a lane relies on an
 * inference nobody made" this codebase's own culture warns against — recorded as a carry for
 * whichever surface eventually renders it.
 *
 * WS-20: no more alias/upstreamId synonym rows. Every model request the router ever sees is now a
 * provider-qualified TAG (`requested.model`, §0.1), and the router matches `row.key === model`
 * directly — the synonym-row synthesis this function used to do existed only to paper over a BARE
 * id reaching `resolveModel` (which has no alias table of its own); a tag never needs it, so this
 * listing carries exactly one row per catalog row, nothing synthesized.
 */
export function familyListingFromCatalog(): ModelFamilyListing {
  const catalog = loadCatalog();
  const families = catalog.families.map((family) => {
    const inFamily = catalog.models.filter((m) => m.modelFamily === family.id);
    const canonicalIds = [...new Set(inFamily.map((m) => m.canonicalModelId))];
    const models = canonicalIds.map((canonicalModelId) => {
      const rows = inFamily.filter((m) => m.canonicalModelId === canonicalModelId);
      const listedRows = rows.map((r) => ({
        key: r.key, providerId: r.providerId, status: r.status, pricingBasis: "unknown", servable: "unknown" as const,
      }));
      return {
        canonicalModelId,
        displayName: rows[0]?.displayName ?? canonicalModelId,
        rows: listedRows,
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
