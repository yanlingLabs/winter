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

/** Builds the adapter for one catalog provider, or `undefined` when its family is not drivable —
 *  the one place the table is consulted for a real turn. */
export function internalAdapterFor(providerId: string, opts: { tokenUrl?: string } = {}): ProviderAdapter | undefined {
  const adapterId = loadCatalog().providers.find((p) => p.id === providerId)?.adapterId;
  if (adapterId === undefined) return undefined;
  return FACTORIES[adapterId]?.(providerId, opts);
}

/** The catalog's own `api` endpoint for a provider — what `ConnectionProfile.baseUrl` must carry for
 *  a multi-provider adapter family (which has no vendor default of its own to fall back to). No
 *  `endpointOrigin` is stamped: the runtime reserves `"reviewed"` for its own copy path
 *  (`ConnectionProfile.endpointOrigin`'s doc), and an absent value reads as `"user"`, which the
 *  endpoint policy accepts for every shipped public https endpoint (measured 2026-09-19:
 *  `evaluateEndpoint` answers `ok` for `https://api.deepseek.com` with the field absent). */
export function catalogApiEndpointFor(providerId: string): string | undefined {
  const api = loadCatalog().providers.find((p) => p.id === providerId)?.defaultEndpoints?.api;
  return api !== undefined && api.length > 0 ? api : undefined;
}
