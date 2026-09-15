// Winter Phase 10b (D1-6, R6-R8 review, CRITICAL): the daemon's own `ProviderRegistry`, for one
// purpose only — feeding `@yanlinglabs/winter-provider-runtime`'s `createEndpointResolver` so the
// router's pre-flight switch review (`HandoffBarrierDeps.resolveEndpoint`) reads REAL catalog
// reasoning-capability facts instead of falling back to the registry-free default.
//
// WHY A REGISTRY AT ALL, NOT JUST THE CATALOG. `createEndpointResolver(registry)` calls
// `registry.resolve({ model, provider })`, and the registry's own `resolve()` REFUSES `no-adapter`
// for any provider whose adapter id has no adapter INSTANCE registered — regardless of whether the
// catalog has a perfectly good descriptor for the model (measured against the published router
// 0.0.5's `store/registry.ts`: `build()` checks `adapters.get(provider.adapterId)` before it ever
// looks at the descriptor). A registry built with zero adapters registered therefore answers
// `no-adapter` for EVERY model, `endpointFromRegistry` falls back to `endpointFromOrigin` (bare
// stamped facts, `readableState: "none"` for everything), and the review over-warns on exactly the
// transfers it exists to pass silently — the measured DeepSeek -> GLM regression the resume note
// names. So this module registers every adapter this build SHIPS (`createShippedAdapters`), not
// because any of them is ever asked to actually stream a turn (`resolveEndpoint` only ever reads
// `resolved.descriptor`/`resolved.continuationDomain`, never `adapter.streamTurn`), but because an
// adapter's mere PRESENCE is what lets `resolve()` return the row at all.
//
// COVERAGE, STATED PLAINLY (ledger-claim correction, whole-branch review, fix round 2):
// `createShippedAdapters(catalog)` registers one adapter per SHIPPED CATALOG adapter id — this
// resolver is CATALOG-ONLY, exactly like the router's own registry-free default it replaces
// (`defaultEndpointResolver`'s own `buildCatalogRegistry`, measured against the published router
// source). A session on a BYO/custom `provider.baseUrl` endpoint (no catalog row at all —
// `catalogRowsFor`'s own bail-out in `runtime-sdk/handoff.ts`) has NO adapter here and none in the
// router's own default either: neither resolver covers custom providers today. Wiring custom
// providers into this registry (and the router's own door for them) is a tracked follow-up, not
// something this module already does — any claim elsewhere that this registry "covers custom
// providers" is describing the router 0.0.6 amendment's own OPEN item, not this file's contents.
//
// NO CREDENTIALS, NO NETWORK. `createShippedAdapters(catalog)` is pure catalog-shape construction —
// every shipped factory takes only `descriptors`/`identityHeaders`/`catalog`, never a `ProviderContext`
// or a credential — so this registry is safe to build at import time, in every process, including a
// hermetic test with no keys configured at all.
import { loadCatalog } from "@yanlinglabs/winter-provider-catalog";
import { createEndpointResolver, createRegistry, createShippedAdapters } from "@yanlinglabs/winter-provider-runtime";
import type { ContinuityEndpoint, MessageOrigin, ProviderRegistry } from "@yanlinglabs/winter-provider-runtime";

let registry: ProviderRegistry | undefined;

/**
 * The daemon's one `ProviderRegistry`, built once per process against the compiled catalog with
 * every shipped adapter pre-registered. Memoised: the catalog is fixed for the life of the process
 * (loaded once by `@yanlinglabs/winter-provider-catalog` itself), so there is nothing to gain by
 * rebuilding it, and every call site sharing one instance is what makes `resolveEndpoint`'s own
 * per-`modelKey` cache (`createEndpointResolver`) actually shared too.
 */
export function daemonProviderRegistry(): ProviderRegistry {
  if (registry === undefined) {
    const catalog = loadCatalog();
    const built = createRegistry(catalog);
    for (const adapter of createShippedAdapters(catalog)) built.register(adapter);
    registry = built;
  }
  return registry;
}

let resolveEndpoint: ((origin: MessageOrigin) => ContinuityEndpoint) | undefined;

/**
 * The one `resolveEndpoint` function every router construction site should inject —
 * `HandoffBarrierDeps.resolveEndpoint` at minimum (`runtime-sdk/create.ts`'s `handoff` options).
 * Memoised for the same reason `createEndpointResolver`'s own returned closure caches per
 * `modelKey`: rebuilding it would throw that cache away for no reason, since the underlying
 * registry never changes shape after boot.
 */
export function daemonResolveEndpoint(): (origin: MessageOrigin) => ContinuityEndpoint {
  if (resolveEndpoint === undefined) {
    resolveEndpoint = createEndpointResolver(daemonProviderRegistry());
  }
  return resolveEndpoint;
}

/** Test seam: forces the next call to rebuild both memoised values — mirrors the router's own
 *  `__resetDefaultEndpointResolverForTests`. Production never calls this. */
export function __resetDaemonProviderRegistryForTests(): void {
  registry = undefined;
  resolveEndpoint = undefined;
}
