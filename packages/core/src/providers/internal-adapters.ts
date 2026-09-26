/**
 * 2026-09-19: WHICH `@yanlinglabs/winter-provider-runtime` adapter FAMILIES the daemon's own
 * background jobs (titles, the bash reviewer, the dreamer, the session cleaner) can be driven over.
 *
 * A LEAF module on purpose — it imports the provider runtime and the catalog and nothing of Winter's
 * own, so `settings.ts` can read `internalDrivableAdapterIds()` for its eligibility predicate without
 * an import cycle, and `internal-provider.ts` can build the real adapters off the same table.
 *
 * WHY A TABLE AT ALL, GIVEN "PROVIDERS LIVE IN THE SDKS" (user rule 2026-09-13). Nothing here knows
 * a provider id, an endpoint, a dialect or an auth scheme: every entry is one SDK factory called with
 * a descriptor lookup. The endpoints come from the catalog (`WinterProviderDescriptor.defaultEndpoints`)
 * and the credentials from the Keychain slot `credentialInventory()` already derives. What the table
 * encodes is only "can the daemon's `Provider` translation drive this family at all", which is a fact
 * about the DAEMON's own `providers/runtime-provider.ts` translation layer, not about any provider.
 *
 * WHY NOT `daemonProviderRegistry().resolve()`'s ADAPTER (registry.ts). Measured 2026-09-19 against
 * the pinned runtime 0.0.17: `createShippedAdapters` builds the OpenAI-family adapters with
 * `descriptorLookupForAdapter(catalog, adapterId)`, which is PROVIDER-BLIND — it indexes every row of
 * every provider sharing that adapter id by bare upstream id, first-wins. `winter.openai-chat-completions`
 * serves ~200 providers, so asking that adapter to stream `deepseek-v4-flash` resolved
 * `alibaba-cn/deepseek-v4-flash`'s descriptor and refused the turn `capability`
 * ("declares no reasoning effort vocabulary"); passing the catalog KEY instead fixed the lookup but
 * put the TAG on the wire as the model id, which a real endpoint would reject. So the daemon builds its
 * own adapter per provider with a PROVIDER-SCOPED descriptor lookup (`descriptorsForProvider` below),
 * which is exactly what the two pre-existing factories in `runtime-provider.ts` already did — with
 * `descriptors: () => undefined`, i.e. no descriptors at all. The registry stays what it is: the
 * endpoint resolver for the router's switch review (`registry.ts`'s own header).
 *
 * `createAnthropicMessagesAdapter`/`createGoogleGenerateContentAdapter` take the whole `catalog` and
 * resolve their descriptor PROVIDER-AWARE (the runtime's own `findDescriptor(catalog, providerId,
 * model)`), so they need no scoped lookup — they are handed the catalog exactly as
 * `createShippedAdapters` hands it to them.
 *
 * NOT DRIVABLE, and why each (report these rather than working around them):
 *  - `winter.bedrock-converse`, `winter.vertex-gemini` — their credential material is `aws` /
 *    `gcp-service-account` / `gcp-access-token`, and `providers/credential-store.ts`'s
 *    `toWinterMaterial` refuses those typed (Winter's own material records are api-key/oauth/bearer
 *    only). A daemon-side gap, not an SDK one.
 *  - `winter.xai-oauth` — the SDK ships the adapter and the login flow, but Winter has no login door
 *    for it and `credentialInventory()` derives no slot (it lists only api-key providers plus the two
 *    fixed OAuth accounts Winter's own doors write), so nothing could resolve its credential.
 *  - `winter.azure-openai`, `winter.local-openai` — `requiresUserEndpoint` / local-only rows, which
 *    `credentialInventory()` already excludes by construction.
 */
import { loadCatalog } from "@yanlinglabs/winter-provider-catalog";
import type { WinterModelDescriptor } from "@yanlinglabs/winter-provider-catalog";
import {
  createAnthropicMessagesAdapter,
  createChatCompletionsAdapter,
  createCodexOauthAdapter,
  createGoogleGenerateContentAdapter,
  createResponsesAdapter,
} from "@yanlinglabs/winter-provider-runtime";
import type { ProviderAdapter } from "@yanlinglabs/winter-provider-runtime";

/** A provider-SCOPED descriptor lookup — the runtime's own `findDescriptor(catalog, providerId, model)`
 *  rule (bare upstream id, catalog key, or alias), narrowed to ONE provider so a bare model id served
 *  by several providers on the same adapter can never resolve to the wrong vendor's row. See this
 *  module's header for the measurement that made this necessary. */
export function descriptorsForProvider(providerId: string): (id: string) => WinterModelDescriptor | undefined {
  return (id) =>
    loadCatalog().models.find(
      (m) => m.providerId === providerId && (m.upstreamId === id || m.key === id || m.aliases.includes(id)),
    );
}

/** One adapter-family factory, given the provider it is being built FOR. `tokenUrl` is the codex
 *  arm's test-only seam (see `internal-provider.ts`). */
type AdapterFactory = (providerId: string, opts: { tokenUrl?: string }) => ProviderAdapter;

const FACTORIES: Readonly<Record<string, AdapterFactory>> = {
  "winter.openai-responses": (providerId) => createResponsesAdapter({ descriptors: descriptorsForProvider(providerId) }),
  "winter.openai-chat-completions": (providerId) => createChatCompletionsAdapter({ descriptors: descriptorsForProvider(providerId) }),
  "winter.codex-oauth": (providerId, opts) =>
    createCodexOauthAdapter({
      descriptors: descriptorsForProvider(providerId),
      ...(opts.tokenUrl === undefined ? {} : { tokenUrl: opts.tokenUrl }),
    }),
  // Provider-aware by construction — see this module's header.
  "winter.anthropic-messages": () => createAnthropicMessagesAdapter({ catalog: loadCatalog() }),
  "winter.google-generate-content": () => createGoogleGenerateContentAdapter({ catalog: loadCatalog() }),
};

/** The adapter ids the daemon can drive — the eligibility predicate's fourth condition
 *  (`settings.ts`'s `internalEligibleProviderIds`). */
export function internalDrivableAdapterIds(): ReadonlySet<string> {
  return new Set(Object.keys(FACTORIES));
}

/**
 * N-3: the model id to put ON THE WIRE for one tag's bare half, resolved through the SAME
 * provider-scoped descriptor the adapter itself will use — `upstreamId` when the row has one, else the
 * bare id verbatim.
 *
 * The catalog's own invariant is `key === providerId + "/" + upstreamId` (pinned across every row by
 * `internal-adapters.test.ts`), so this is a no-op for every shipped row today. It is here because the
 * invariant is DATA, not a type: a future row whose key and upstream id differ would otherwise have the
 * key's bare half sent as the model id, which the endpoint would reject — and the failure would look
 * like a bad model name rather than a lookup that needed one hop.
 */
export function wireModelIdFor(providerId: string, bareModelId: string): string {
  return descriptorsForProvider(providerId)(bareModelId)?.upstreamId ?? bareModelId;
}

/** Builds the adapter for one catalog provider, or `undefined` when its family is not drivable —
 *  the one place the table is consulted for a real turn. */
export function internalAdapterFor(providerId: string, opts: { tokenUrl?: string } = {}): ProviderAdapter | undefined {
  const adapterId = loadCatalog().providers.find((p) => p.id === providerId)?.adapterId;
  if (adapterId === undefined) return undefined;
  return FACTORIES[adapterId]?.(providerId, opts);
}

/**
 * The catalog's own `api` endpoint for a provider — what `ConnectionProfile.baseUrl` must carry for a
 * MULTI-provider adapter family, which has no vendor default of its own to fall back to.
 *
 * `undefined` for a family that serves exactly ONE catalog provider, deliberately, mirroring the
 * runtime's own `generatedBaseUrlForAdapter` rule (`createShippedAdapters`): such an adapter carries a
 * built-in default, `resolveEndpoint` PREFERS `connection.baseUrl` when one is set, and the factory this
 * replaced passed no base URL at all for codex-oauth. Measured 2026-09-19 the two agree byte-for-byte
 * (`CODEX.backendUrl` = `https://chatgpt.com/backend-api/codex` = the catalog's `codex-oauth` api), so
 * forcing the catalog value would be a no-op TODAY — but a later catalog or SDK bump that moved one of
 * them would silently redirect every existing codex user's internal calls, and no loopback test could
 * see it (they all override the URL). Deferring to the adapter keeps the pre-existing behaviour exactly.
 *
 * WS-23 (agent SDK 0.0.25): `openai` NO LONGER defers. `winter.openai-responses` now serves `openai`
 * AND `xai`, so it is a multi-provider family with no single vendor default, and `openai` gets the
 * catalog's `https://api.openai.com/v1` stated explicitly. That is the SAME host its internal jobs
 * always reached: `internal-adapters.test.ts` pins the catalog row equal to the SDK's own
 * `OPENAI_API_BASE_URL`, so a divergence is a test failure, never a silent redirect.
 *
 * No `endpointOrigin` is stamped: the runtime reserves `"reviewed"` for its own copy path
 * (`ConnectionProfile.endpointOrigin`'s doc), and an absent value reads as `"user"`, which the endpoint
 * policy accepts for every shipped public https endpoint (measured: `evaluateEndpoint` answers `ok` for
 * `https://api.deepseek.com` with the field absent).
 */
export function catalogApiEndpointFor(providerId: string): string | undefined {
  const catalog = loadCatalog();
  const provider = catalog.providers.find((p) => p.id === providerId);
  if (provider === undefined) return undefined;
  const siblings = catalog.providers.filter((p) => p.adapterId === provider.adapterId).length;
  if (siblings === 1) return undefined; // the adapter's own generated default — see the doc above
  const api = provider.defaultEndpoints?.api;
  return api !== undefined && api.length > 0 ? api : undefined;
}

/** The catalog `api` endpoint verbatim, WITHOUT the single-provider deferral — for the test that pins
 *  the SDK's own constants against it, and for a caller that genuinely wants the catalog's answer. */
export function catalogApiEndpointRawFor(providerId: string): string | undefined {
  const api = loadCatalog().providers.find((p) => p.id === providerId)?.defaultEndpoints?.api;
  return api !== undefined && api.length > 0 ? api : undefined;
}
