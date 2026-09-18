/**
 * The `models.catalog` RPC's own reader — catalog family/pricing facts, shaped for the Mac app's
 * Roles pane model picker (families down the left, a family's models on the right, a provider list
 * per model with pricing). Kept OUT of `settings.ts` (already large) and beside `registry.ts`,
 * this package's other daemon-owned `loadCatalog()` consumer.
 *
 * The whole point of this module is that it adds NOTHING a picker could disagree with
 * `settings.modelRoles` about: every provider/model here is exactly what `permittedProviders`
 * (settings.ts) already lets some role's `permitted` name, called here unfiltered — never a second,
 * hand-written copy of that predicate that the two could drift apart from.
 */
import { loadCatalog } from "@yanlinglabs/winter-provider-catalog";
import type { CapabilityEvidence, ModelPricing } from "@yanlinglabs/winter-provider-catalog";
import { permittedProviders } from "../settings";
import { credentialInventory } from "../runtime-sdk/keychain";

export interface ModelCatalogWirePricing {
  inputPerMTokUsd: number;
  outputPerMTokUsd: number;
  cacheReadPerMTokUsd?: number;
  cacheWritePerMTokUsd?: number;
  source: string;
  confidence: string;
  observedAt?: string;
  sourceRef?: string;
}

export interface ModelCatalogWireModel {
  tag: string;
  canonicalModelId: string;
  providerId: string;
  familyId: string;
  status: string;
  pricing: ModelCatalogWirePricing | null;
  costBasis: "list" | "unknown";
}

export interface ModelCatalogWireProvider {
  id: string;
  displayName: string;
  pricingBasis: "token" | "subscription" | "free";
  authKinds: string[];
  credentialSlotId: string | null;
  /** Which door credentials this provider — see the protocol schema's own doc; `null` slot alone is
   *  ambiguous between "another door" and "no door", and those must not look alike to a picker. */
  credentialDoor: "keychain" | "console-profile" | "none";
}

export interface ModelCatalogWireFamily {
  id: string;
  displayName: string;
  vendor: string;
  status: "candidate" | "supported";
}

export interface ModelCatalogWireResult {
  ok: true;
  schemaVersion: number;
  catalogVersion: string;
  families: ModelCatalogWireFamily[];
  providers: ModelCatalogWireProvider[];
  models: ModelCatalogWireModel[];
}

/**
 * `winter-provider-runtime`'s `estimateCostUsd` rule (`registry.ts`, ~line 155-173 in the SDK
 * checkout), RE-IMPLEMENTED rather than called: that function prices a REAL `UsageForCost` object
 * (actual tokens spent on a turn), and there is no such object at listing time — calling it here
 * would mean fabricating one just to read its `costBasis` back off, which is worse than restating
 * the one-line rule it applies. R6-9's own words: "`official-doc` evidence -> `costBasis: \"list\"`",
 * literally — anything else, including no pricing evidence at all, is `"unknown"`, never a guess
 * dressed as a vendor's published price.
 *
 * EXPORTED so the test suite can exercise the non-`official-doc` branch directly: today's compiled
 * catalog has exactly 18 priced rows and all 18 cite `"official-doc"` (an inferred/upstream-priced
 * row exists in the schema but not yet in the data), so a test going only through `modelCatalogWire`
 * could never reach `"unknown"` on a row that DOES carry pricing — only on one that carries none.
 */
export function costBasisFor(pricing: CapabilityEvidence<ModelPricing> | undefined): "list" | "unknown" {
  return pricing?.source === "official-doc" ? "list" : "unknown";
}

function wirePricing(pricing: CapabilityEvidence<ModelPricing> | undefined): ModelCatalogWirePricing | null {
  if (pricing === undefined) return null;
  const v = pricing.value;
  return {
    inputPerMTokUsd: v.inputPerMTokUsd,
    outputPerMTokUsd: v.outputPerMTokUsd,
    ...(v.cacheReadPerMTokUsd === undefined ? {} : { cacheReadPerMTokUsd: v.cacheReadPerMTokUsd }),
    ...(v.cacheWritePerMTokUsd === undefined ? {} : { cacheWritePerMTokUsd: v.cacheWritePerMTokUsd }),
    source: pricing.source,
    confidence: pricing.confidence,
    ...(pricing.observedAt === undefined ? {} : { observedAt: pricing.observedAt }),
    ...(pricing.sourceRef === undefined ? {} : { sourceRef: pricing.sourceRef }),
  };
}

/**
 * The `models.catalog` result, built fresh on every call — `loadCatalog()` is itself memoised and
 * immutable for the process, so there is nothing to cache here beyond what it already does.
 */
export function modelCatalogWire(): ModelCatalogWireResult {
  const catalog = loadCatalog();

  // The SAME set `settings.modelRoles`'s "any"/"same-as-session" roles permit — `permittedProviders()`
  // unfiltered, exactly the call `modelRoleInfo` makes for those roles. Flattening `.models` here
  // (rather than re-filtering `catalog.models` by hand) is what makes the two surfaces provably
  // agree: a change to the floor moves both at once.
  const eligible = permittedProviders();
  const eligibleProviderIds = new Set<string>(eligible.map((p) => p.providerId));
  const eligibleModelTags = new Set<string>(eligible.flatMap((p) => p.models));

  // `credentialInventory()`'s slots, keyed by provider id, first-match. `anthropic` carries TWO
  // rows (`anthropic:default`, the api-key slot; `anthropic:console`, the console broker's bearer
  // slot — keychain.ts's own doc on why both are filed under "anthropic"); the derivation's head
  // array lists the api-key row FIRST, so `.find` lands on `anthropic:default` — the row that
  // actually matches the "anthropic" CATALOG provider's own `authKinds` (it includes "api-key"; the
  // console row's material kind is "bearer", not this provider's). The catalog's separate `console`
  // provider (authKinds: ["console-profile"]) matches no inventory row at all under ITS id — its
  // one usable slot is filed under "anthropic" — so `credentialSlotId` for it is genuinely `null`,
  // not a lookup miss: a real, eligible provider this daemon can serve but never stores a key for
  // under its own catalog id.
  const slots = credentialInventory();

  const providers: ModelCatalogWireProvider[] = catalog.providers
    .filter((p) => eligibleProviderIds.has(p.id))
    .map((p) => {
      const slotId = slots.find((s) => s.provider === p.id)?.secretName ?? null;
      // `credentialSlotId: null` alone is AMBIGUOUS to a consumer, and dangerously so: on `console`
      // it means "credentialed by a different door", but a future eligible provider with no door at
      // all would report the identical `null`. A picker that reads `null` as "cannot hold a
      // credential" would mark a correctly-signed-in Console user as unusable. So the DOOR is named
      // explicitly, and derived from data rather than from a provider id:
      //   "keychain"        -> join `credential.list` on `credentialSlotId`; that is the whole test.
      //   "console-profile" -> `winter login --anthropic-console`; readiness is the on-disk `ant`
      //                        profile, checked LIVE at every spawn (`console_profile_missing`), so
      //                        it is deliberately NOT answered by this read. Offerable, not promised.
      //   "none"            -> eligible in the catalog, but this daemon stores no credential for it.
      // `keychain.ts`'s `credentialRefFor` is the pin for why `console` has no slot of its own: "its
      // presence is the on-disk profile file ... never a `CredentialRef`".
      const door = slotId !== null ? "keychain" : p.authKinds.includes("console-profile") ? "console-profile" : "none";
      return {
        id: p.id,
        displayName: p.displayName,
        pricingBasis: p.pricingBasis,
        authKinds: [...p.authKinds],
        credentialSlotId: slotId,
        credentialDoor: door,
      };
    });

  const models: ModelCatalogWireModel[] = catalog.models
    .filter((m) => eligibleModelTags.has(m.key))
    .map((m) => ({
      tag: m.key,
      canonicalModelId: m.canonicalModelId,
      providerId: m.providerId,
      familyId: m.modelFamily,
      status: m.status,
      pricing: wirePricing(m.pricing),
      costBasis: costBasisFor(m.pricing),
    }));

  // Families with at least one offerable model, in the catalog's own id order — an empty family
  // (every row it claims is ineligible or claimed by nothing) is dead UI in a picker whose left
  // column is meant to be clicked into a right-hand list. `WinterCatalog.families` is already
  // sorted by id and carries no cross-family rank (WS-13c only orders a family's own slots), so
  // that order is kept as-is rather than an ordinal invented here.
  const familyIdsInUse = new Set(models.map((m) => m.familyId));
  const families: ModelCatalogWireFamily[] = catalog.families
    .filter((f) => familyIdsInUse.has(f.id))
    .map((f) => ({ id: f.id, displayName: f.displayName, vendor: f.vendor, status: f.status }));

  return {
    ok: true,
    schemaVersion: catalog.schemaVersion,
    catalogVersion: catalog.catalogVersion,
    families,
    providers,
    models,
  };
}
