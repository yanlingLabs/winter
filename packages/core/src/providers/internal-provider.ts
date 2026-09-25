/**
 * 2026-09-19: ONE internal `Provider` per catalog provider, built on the agent SDK's own adapters.
 *
 * This replaces `manager.ts`'s single process-wide instance. The shape is the same
 * `RuntimeBackedProvider` (`runtime-provider.ts`) the two hand-written factories already produced —
 * what changes is that the provider IDENTITY, the endpoint and the credential slot are all read from
 * the catalog / the credential inventory rather than hardcoded per provider, so a new catalog provider
 * is usable here with no edit.
 *
 * "PROVIDERS LIVE IN THE SDKS" (user rule 2026-09-13) holds: nothing in this file or in
 * `internal-adapters.ts` knows an endpoint, a dialect, an auth scheme or a provider id. The endpoint is
 * `WinterProviderDescriptor.defaultEndpoints.api` (overridable per provider by
 * `settings.providers.<id>.baseUrl`, the ONE override door), the credential slot is the one
 * `credentialInventory()` derives, the material is resolved by the SDK's own `CredentialStore` seam
 * (`credential-store.ts`) and refreshed by the SDK's own OAuth refresh on a 401.
 *
 * EFFORT IS NORMALISED HERE, and it has to be. The pre-2026-09-19 factories passed
 * `descriptors: () => undefined`, which makes the runtime's `mapEffortAgainst` forward any NAMED effort
 * verbatim. With real descriptors it VALIDATES, and measured 2026-09-19 against the pinned runtime
 * 0.0.17 it refuses `capability` for both directions Winter actually produces:
 *   - `"none"` on an `openai`/`codex-oauth` row (vocabulary `[low, medium, high, xhigh, max]`) —
 *     `effortToSpendForRole` emits `"none"` verbatim whenever the row has a non-empty vocabulary;
 *   - `"medium"` on a `deepseek` row (vocabulary `[none, low, high, max]`) — the dreamer's own
 *     `DREAM_EFFORT` constant, which `effortToSpendForRole` returns UNMAPPED when nothing is stored.
 * A refused turn is a silently-dead background job, so the effort is mapped onto the row that is
 * actually about to be called (`implicitEffortFor`) — with `"none"` given its OWN rule below, since
 * `implicitEffortFor`'s ordinary fallback (the row's `defaultEffort`) is exactly backwards for it.
 *
 * D2 (2026-09-22, dist-session-fixes follow-up): the first cut of this rule DROPPED `"none"`
 * outright whenever the row's vocabulary lacked it, on the reasoning that `implicitEffortFor`'s
 * fallback (the row's `defaultEffort`) could land on something as heavy as `"medium"` — an
 * ESCALATION, never what a role asking for `"none"` wanted. That measurement was right about the
 * fallback but wrong about the fix: dropping the effort field entirely does not avoid the
 * escalation, it just lets the PROVIDER pick the escalation instead of Winter (still `"medium"` for
 * a `gpt-5.6` row, per its own `defaultEffort`) — which is precisely the root cause the dist log's
 * `[cleaner]`/`[titles]` timeouts traced back to: a role pinned to `"none"` for SPEED ran slower
 * than the row's `CLEANER_EFFORT = "low"` design point, not faster. The rule now sends the row's own
 * LOWEST declared tier instead (`REASONING_EFFORTS`' canonical order below, which is `EFFORT_LADDER`
 * — `openai/shared.ts` — with `"none"` prepended; every value any catalog row's `reasoning.efforts`
 * carries is drawn from this exact set, verified against the full pinned catalog) — asking the
 * PROVIDER for LESS reasoning than the escalation, never more, and never inventing a tier the row
 * does not itself declare.
 */
import type { SecretStore } from "../auth/secret-store";
import { credentialInventory } from "../runtime-sdk/keychain";
import { internalEffortNoEscalationFor, rowForTag } from "../runtime-sdk/provider-selection";
import { providerBaseUrlFor, REASONING_EFFORTS, type Settings } from "../settings";
import { catalogApiEndpointFor, catalogApiEndpointRawFor, internalAdapterFor } from "./internal-adapters";
import { credentialStoreOverSecretStore } from "./credential-store";
import { runtimeBackedProvider } from "./runtime-provider";
import type { Provider } from "./types";

/** The Keychain account (= the material record name) for a provider's internal calls — the SAME slot a
 *  session's `authRef` names, read from the one derivation rather than re-spelled. */
export function internalCredentialAccountFor(providerId: string): string | undefined {
  return credentialInventory().find((s) => s.provider === providerId)?.secretName;
}

/**
 * The effort actually put on an internal request for `tag`. `undefined` in, `undefined` out.
 *
 * A tag with NO catalog row (`winter-test/*`, a harness double) passes through verbatim:
 * `implicitEffortFor` already takes that posture, and refusing there would be a guess dressed as a rule.
 */
export function internalWireEffortFor(tag: string, effort: string | undefined): string | undefined {
  if (effort === undefined) return undefined;
  // M-1 (review) / D2 follow-up (2026-09-22): `"none"` must NEVER reach `implicitEffortFor`. That
  // function answers "is `wanted` in the row's vocabulary, else the row's `defaultEffort`", and
  // `defaultEffort` is exactly backwards for `"none"` — it is a role asking for LESS reasoning, and
  // falling to the row's own default (often `"medium"`) would silently give it MORE instead.
  //
  // The rule, in full, scoped precisely to what was measured and asked for (controller ruling,
  // 2026-09-22): a row with NO declared vocabulary at all takes no effort setting, so nothing is
  // sent (unchanged). A row whose vocabulary already lists `"none"` itself is sent `"none"` (SDK 0.0.23,
  // below). The remaining case: a row
  // that DOES reason but declares no `"none"` tier of its own now gets its OWN LOWEST declared effort
  // (`REASONING_EFFORTS`' canonical low-to-high order, this module's header) rather than dropping the
  // field and letting the provider's own (higher) default apply. `REASONING_EFFORTS.find(...)` always
  // finds a match on this path — verified against the full pinned catalog, every `reasoning.efforts`
  // value across every row is one of its members.
  // SDK 0.0.23 (2026-09-25) settled the "SDK CARRY" below (settings.ts): the catalog now lists a literal
  // `"none"` exactly where the vendor documents one for the dialect the adapter speaks (the GPT-5.x/6
  // rows, grok-4.3, glm-5.2, qwen3.8, …; the audit dropped DeepSeek chat's undocumented one), and the
  // adapter's `mapEffort` accepts any member of the row's own vocabulary. So a row that lists `"none"`
  // is now SENT `"none"` — dropping it let the provider's own (higher) default apply, which is exactly
  // the 2026-09-22 timeout-storm shape this function exists to prevent.
  if (effort === "none") {
    const vocab = rowForTag(tag)?.reasoning?.efforts ?? [];
    if (vocab.length === 0) return undefined;
    if (vocab.includes("none")) return "none";
    const lowest = REASONING_EFFORTS.find((e) => vocab.includes(e));
    if (lowest !== undefined) noteNoneSubstitutedOnce(tag, lowest);
    return lowest;
  }
  if (rowForTag(tag) === undefined) return effort;
  // R.1 (controller ruling): never UP — a heavier row default is dropped, not sent.
  return internalEffortNoEscalationFor(tag, effort);
}

const noneSubstitutedNoted = new Set<string>();
/** One line per tag per process (the `staleEffortNoted`/`session-driver.ts` precedent) — an internal
 *  job re-resolves its effort on every call, so this must never become a per-call log. */
function noteNoneSubstitutedOnce(tag: string, sentEffort: string): void {
  if (noneSubstitutedNoted.has(tag)) return;
  if (noneSubstitutedNoted.size > 256) noneSubstitutedNoted.clear();
  noneSubstitutedNoted.add(tag);
  console.error(`internal role effort "none" is not on "${tag}"'s own vocabulary — sending its lowest declared effort ("${sentEffort}") instead of letting the provider's own (higher) default apply`);
}

export interface InternalProviderBuildRefusal {
  /** `"provider-unsupported"`: the daemon cannot drive this provider's adapter family, or the catalog
   *  ships no endpoint for it. `"no-credential"`: nothing is stored in its slot. */
  code: "provider-unsupported" | "no-credential";
  detail: string;
}

/**
 * Builds the internal `Provider` for one catalog provider, or says why it cannot.
 *
 * NO EAGER CREDENTIAL READ — matching the pre-existing codex arm (and, deliberately, NOT the pre-existing
 * openai arm, which threw at construction time and is the reason `daemon.ts`'s boot `catch` produced
 * `agentProvider = null` for a home with no OpenAI key). Presence is the caller's question, answered from
 * `InternalProviderView`'s snapshot; the material is resolved by the SDK at the first turn, and a missing
 * or rejected one surfaces as a typed `auth` error on that turn exactly as before.
 *
 * `testBackendUrl` is a TEST-ONLY seam, the same one `createCodexOauthRuntimeProvider` already had:
 * it points the adapter (and, for an OAuth arm, its refresh endpoint) at a loopback fake instead of the
 * real backend. Production never passes it.
 */
export function buildInternalProvider(cfg: {
  providerId: string;
  secrets: SecretStore;
  settings: Settings | null | undefined;
  onSubscriptionQuota?: (info: Record<string, unknown>) => void;
  testBackendUrl?: string;
}): { provider: Provider } | { refusal: InternalProviderBuildRefusal } {
  const { providerId } = cfg;
  const account = internalCredentialAccountFor(providerId);
  if (account === undefined) {
    return { refusal: { code: "provider-unsupported", detail: `${providerId} has no credential slot on this daemon` } };
  }
  const adapter = internalAdapterFor(providerId, cfg.testBackendUrl === undefined ? {} : { tokenUrl: `${cfg.testBackendUrl}/oauth/token` });
  if (adapter === undefined) {
    return { refusal: { code: "provider-unsupported", detail: `${providerId}'s adapter family is not one Winter's own jobs can be driven over` } };
  }
  // The user's own override wins; otherwise the catalog's endpoint. A multi-provider adapter family has
  // no vendor default of its own, so an absent endpoint here is a real refusal rather than a silent
  // request to whatever the adapter would have guessed.
  const override = providerBaseUrlFor(cfg.settings, providerId);
  const baseUrl = cfg.testBackendUrl ?? override ?? catalogApiEndpointFor(providerId);
  // `undefined` is legitimate for a family that serves exactly one catalog provider — the adapter's own
  // generated default applies, which is what the two retired factories relied on
  // (`catalogApiEndpointFor`'s doc). It is a REFUSAL only for a multi-provider family, which has no
  // default to fall back to: sending a request to whatever such an adapter would have guessed is worse
  // than saying the provider is unusable.
  if (baseUrl === undefined && catalogApiEndpointRawFor(providerId) === undefined) {
    return { refusal: { code: "provider-unsupported", detail: `the pinned catalog ships no API endpoint for ${providerId}` } };
  }
  // `local: true` ONLY for an endpoint the USER entered (`providers.<id>.baseUrl`) or the loopback test
  // seam. The pre-2026-09-19 openai-compatible factory declared it unconditionally to preserve Winter's
  // historically unrestricted BYO-endpoint behaviour — "arbitrary API models are legitimate there" —
  // and that carve-out has to survive: an `openai` user pointed at `http://localhost:11434` (Ollama,
  // LM Studio, a LAN gateway) would otherwise have every internal job refused by the runtime's
  // plain-http/private-address endpoint policy. It is deliberately NOT extended to the ~94 CATALOG
  // endpoints, which would disable that policy for all of them; measured 2026-09-19, every shipped
  // public https endpoint passes with `local` absent.
  const local = cfg.testBackendUrl !== undefined || override !== undefined;
  const provider = runtimeBackedProvider({
    id: providerId,
    adapter,
    context: {
      connection: { providerId, ...(baseUrl === undefined ? {} : { baseUrl }), ...(local ? { local: true } : {}) },
      credentials: credentialStoreOverSecretStore(cfg.secrets),
      authRef: { kind: "keychain", account },
      stallTimeoutMs: 60_000,
      log: () => {},
    },
    models: () => [],
    ...(cfg.onSubscriptionQuota === undefined ? {} : { onSubscriptionQuota: cfg.onSubscriptionQuota }),
  });
  return { provider };
}
