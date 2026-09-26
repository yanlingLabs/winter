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
import type { CredentialPresence } from "@yanlinglabs/winter-runtime-sdk";
import { permittedProviders } from "../settings";
import { credentialInventory, credentialPresentProbe } from "../runtime-sdk/keychain";
import { effortVocabularyOf } from "../runtime-sdk/provider-selection";

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
  /** The row's own reasoning-effort vocabulary — see the protocol schema's own doc for why `null`
   *  and `[]` are different answers here and must not be collapsed. */
  efforts: string[] | null;
  defaultEffort: string | null;
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
  /** Whether that door is actually SATISFIED on this home right now — `credentialPresentProbe`
   *  (runtime-sdk/keychain.ts), the same rule `sync.config`'s own model list filters on and the
   *  router's create-time admission reads. */
  credentialPresent: boolean;
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
 *
 * `deps` is the credential-readiness input, and it is a PARAMETER rather than a probe this function
 * runs itself: reading the Keychain is asynchronous and ~150 slots wide (`credentialPresenceFrom`),
 * and the caller (`ipc/server.ts`'s `models.catalog` handler) already computes exactly this pair for
 * `sync.config` on the very same `opts.secrets`/`opts.winterHome`. Taking the ALREADY-COMPUTED
 * presence keeps this reader synchronous and keeps the two surfaces on one probe per call. A server
 * with no secret store wired hands over an empty `{byProvider:{}}`, which reports every provider as
 * not-ready — the same degradation `sync.config` documents for the same inputs. (`home` is no longer
 * read: the Console's readiness is its Keychain slot now, not an on-disk profile.)
 */
export function modelCatalogWire(deps: { credentials: CredentialPresence; home: string }): ModelCatalogWireResult {
  const catalog = loadCatalog();
  const credentialPresent = credentialPresentProbe(deps);

  // The SAME set `settings.modelRoles`'s "any"/"same-as-session" roles permit — `permittedProviders()`
  // unfiltered, exactly the call `modelRoleInfo` makes for those roles. Flattening `.models` here
  // (rather than re-filtering `catalog.models` by hand) is what makes the two surfaces provably
  // agree: a change to the floor moves both at once.
  const eligible = permittedProviders();
  const eligibleProviderIds = new Set<string>(eligible.map((p) => p.providerId));
  const eligibleModelTags = new Set<string>(eligible.flatMap((p) => p.models));

  // `credentialInventory()`'s slots, keyed by provider id — exactly one per provider. `anthropic` names
  // `anthropic:default` (the api-key slot) and, since the WS-23 live-gate fix, `console` names
  // `anthropic:console` (the console broker's bearer slot, which used to be filed under "anthropic"
  // and so left `console` with a `null` slot here).
  const slots = credentialInventory();

  const providers: ModelCatalogWireProvider[] = catalog.providers
    .filter((p) => eligibleProviderIds.has(p.id))
    .map((p) => {
      const slotId = slots.find((s) => s.provider === p.id)?.secretName ?? null;
      // The DOOR answers "which flow fixes this provider when it is not ready", named explicitly and
      // derived from data rather than from a provider id — a slot id alone cannot say it:
      //   "console-profile" -> `winter login --anthropic-console` (or the app's Sign in). Checked
      //                        FIRST: the Console HAS a Keychain slot now (`anthropic:console`), but
      //                        the broker fills it from the `ant` login — there is no key to paste,
      //                        so a picker must never offer "add a key" for it.
      //   "keychain"        -> a key in Settings → Providers, into `credentialSlotId`.
      //   "none"            -> eligible in the catalog, but this daemon stores no credential for it.
      const door = p.authKinds.includes("console-profile") ? "console-profile" : slotId !== null ? "keychain" : "none";
      return {
        id: p.id,
        displayName: p.displayName,
        pricingBasis: p.pricingBasis,
        authKinds: [...p.authKinds],
        credentialSlotId: slotId,
        credentialDoor: door,
        // The DOOR above says how this provider can be credentialed; this says whether it IS.
        // Computed HERE, daemon-side, so no client has to join `credential.list` by guessing
        // `<providerId>:default` (which is wrong for `console`, whose slot is `anthropic:console`).
        // `credentialPresentProbe` is the one rule, and `sync.config`'s model list and the router's
        // create-time admission read the same presence.
        credentialPresent: credentialPresent(p.id),
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
      // `effortVocabularyOf` (runtime-sdk/provider-selection.ts) — the ROW form, so this listing
      // never re-looks-up by tag what it already holds, and the SAME rule
      // `settings.modelRoles`' per-role `efforts` answers with. Catalog truth, in the row's own
      // order: no `"none"` is prepended, unlike `sync.config`'s `models[].efforts`, where the
      // prepend is that surface's PICKER convention (`effortsForModel`, ipc/sync.ts — the catalog
      // excludes `"none"` because it is Winter's unset, not a catalog tier). A consumer building a
      // selection control from this field adds `"none"` by that same rule; a consumer reporting what
      // the catalog KNOWS must not see a value the catalog never declared.
      efforts: effortVocabularyOf(m),
      // `ReasoningCapabilities.defaultEffort` is optional even on a row that HAS a vocabulary (15 of
      // the 48 rows with one declare it), so `null` here means "the catalog names no default", never
      // "no default applies" — the provider still has one, unobserved. It is the fallback
      // `implicitEffortFor` maps an unsupported implicit effort onto, which is why it rides beside
      // the vocabulary rather than being left for a consumer to guess.
      defaultEffort: m.reasoning?.defaultEffort ?? null,
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
