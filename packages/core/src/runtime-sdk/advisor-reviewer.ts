// Phase 8d Task 3.1 (P8d-8) — D30 on the OFFICIAL leg: the router's own `advisor.resolveReviewer`
// (`RuntimeSdkOptions.advisor`, `create.ts`) is a SINGLE, whole-router-handle `ReviewerResolver`
// (`() => ResolvedReviewer | undefined`, `@yanlinglabs/winter-agent-sdk/tools`) — the router forwards
// it to whichever official-leg session's standing "advisor" tool fires, with NO session context in
// the call itself (the resolver's own signature takes nothing). `resolveReviewer` therefore reads
// EVERYTHING it needs from live closures: `settings()` for the hot `runtimes.advisorModel` override,
// and `sessionModel()` for the D30 per-family default when that setting is unset.
//
// THE WINTER LEG DOES NOT USE THIS FILE. Its own advisor is configured per-session through
// `Options.advisor.model` (`mode-options.ts`/`session-driver.ts`) — the spawned `winter` child
// resolves its OWN reviewer PROVIDER internally (it reads the Keychain itself), so Norma only ever
// states the WINTER leg's target MODEL id, never builds a provider for it. `d30DefaultModel` below is
// the ONE shared piece both legs need (the family→model table), so the two can never state two
// different defaults for the same family.
//
// KNOWN LIMIT (documented, not silently accepted): because the router's `advisor.resolveReviewer` is
// ONE function shared by every official-leg session in this daemon process, `sessionModel()` cannot
// disambiguate between two CONCURRENT official-leg sessions on different models when
// `runtimes.advisorModel` is unset — the same shape `winter-agent-sdk`'s own R-6c-28 limitation
// documents for its settings cascade ("this SDK resolves settings once … the version only moves when
// a host hands down a new view"). This is a non-issue TODAY: the official leg only ever serves
// Claude-family models (D13-2 routes every Claude-family, Anthropic-protocol, credentialed model
// straight to it), so the D30 default for every official-leg session is always "Claude family ->
// fable" regardless of which session asked — `sessionModel()`'s "else the session's own model" arm is
// unreachable until a non-Claude model can run on this leg. Recorded as a carry for that day, not a
// bug today.
import type { AdvisorReviewer, AdvisorReviewerRequest, AdvisorReviewerTurn, ReviewerResolver } from "@yanlinglabs/winter-agent-sdk/tools";
import { loadCatalog } from "@yanlinglabs/winter-provider-catalog";
import { createAnthropicMessagesAdapter, OPENAI_API_BASE_URL } from "@yanlinglabs/winter-provider-runtime";
import type { ProviderContext } from "@yanlinglabs/winter-provider-runtime";
import type { SecretStore } from "../auth/secret-store";
import { readCredentialMaterial, CREDENTIAL_MATERIAL_NAMES } from "../auth/credential-material";
import { createCodexOauthRuntimeProvider, createOpenAiCompatibleRuntimeProvider } from "../providers/runtime-provider";
import { DEFAULT_CODEX_MODEL } from "../providers/codex-config";
import type { Provider, TurnInputItem } from "../providers/types";
import { credentialStoreOverSecretStore } from "../providers/credential-store";
import { winterOptionsFromSettings, type Settings } from "../settings";
import { ANTHROPIC_CREDENTIAL_SECRET_NAME, credentialRefFor } from "./keychain";

/** Which of Norma's three D30-relevant families a catalog-recognised model belongs to. `"other"` is
 *  every family the pinned catalog has that is neither the OpenAI ("gpt") nor the Claude ("claude")
 *  family — Gemini/Grok/DeepSeek/etc. — for which 8d states no provider-runtime mapping (see
 *  `buildReviewerFor`'s own doc): the D30 table's own third rung, "else the session's own model", is
 *  what such a family falls through to, and if THAT model is also not openai/claude the resolver
 *  answers `undefined` rather than inventing a fourth provider adapter this phase does not need. */
export type AdvisorFamily = "openai" | "claude" | "other";

/** A catalog row's `key`/`upstreamId`/`canonicalModelId`/alias match, same lookup
 *  `provider-selection.ts`'s `catalogRowsFor` uses — reimplemented here (rather than imported) only
 *  because that function's declared return type omits `modelFamily`; the row objects are identical
 *  either way, so this can never drift into a second answer for the same model. */
export function familyOfModel(model: string): AdvisorFamily {
  const catalog = loadCatalog();
  const row = catalog.models.find((m) => m.key === model || m.upstreamId === model || m.canonicalModelId === model || m.aliases.includes(model));
  if (row === undefined) return "other";
  if (row.modelFamily === "gpt") return "openai";
  if (row.modelFamily === "claude") return "claude";
  return "other";
}

/** D30's own per-family default: family slot 1's canonical model id ("astra" for gpt, "fable" for
 *  claude — WS-13c §9's own ranked slot 1). `undefined` only if the pinned catalog ever drops the
 *  family entirely (never true for the two families 8d cares about; a defensive `undefined` rather
 *  than a throw so a catalog hiccup degrades to "no reviewer", never a daemon crash). */
function firstSlotCanonicalIdFor(familyId: "gpt" | "claude"): string | undefined {
  return loadCatalog().families.find((f) => f.id === familyId)?.slots[0]?.canonicalModelId;
}

/**
 * Review fix F1: `advisorReviewerFor`'s `sessionModel` deriving the D30 default is only correct when
 * it reports THIS resolver's own family — and the ONE caller of this resolver (`daemon.ts`, feeding
 * `RuntimeSdkOptions.advisor` for the OFFICIAL leg) has a single, deployment-wide instance serving
 * every official-leg session, which by D13-2 is ALWAYS Claude-family (Anthropic-protocol, credentialed
 * Claude models route straight to this leg; no other family can land here at all). Wiring
 * `sessionModel` to `settings.provider.model` — the WINTER leg's own default-provider model, which on
 * a Codex/OpenAI-primary install is an openai-family model — therefore fed `d30DefaultModel` the WRONG
 * family and silently resolved an OpenAI reviewer for a Claude-only leg. This is the fix: a
 * `sessionModel` for this ONE known-Claude-only caller that reports the Claude family unconditionally,
 * never reading `settings.provider` at all. (The "else the session's own model" rung of D30's table
 * stays reachable for a FUTURE non-Claude-family official-leg session — see this module's own header
 * — this export just states the one thing this deployment can promise TODAY: every session on this
 * leg is Claude-family, so its placeholder session-model IS a Claude-family model, unconditionally.)
 */
export function officialLegDefaultSessionModel(): string | undefined {
  return firstSlotCanonicalIdFor("claude");
}

/**
 * D30's table, shared by both legs so they can never state two different defaults for the same
 * family: unset -> a gpt session's reviewer is "astra" (`gpt-6-astra`), a claude session's is "fable"
 * (`claude-fable-5-1`), any OTHER family falls through to the session's own model (which then most
 * likely resolves to `familyOfModel` = "other" too, and `advisorReviewerFor`'s own resolver answers
 * `undefined` — no provider mapping exists for a non-openai/claude family in 8d).
 */
export function d30DefaultModel(sessionModel: string | undefined): string | undefined {
  const family = sessionModel !== undefined ? familyOfModel(sessionModel) : "other";
  if (family === "openai") return firstSlotCanonicalIdFor("gpt") ?? sessionModel;
  if (family === "claude") return firstSlotCanonicalIdFor("claude") ?? sessionModel;
  return sessionModel;
}

/** `AdvisorReviewerRequest.messages` -> one non-streaming text turn, for the OpenAI-family Norma
 *  `Provider` shape (`providers/types.ts`'s `TurnInputItem`/`ProviderEvent`) — the SAME shape
 *  `agent/reviewer.ts`'s `BashReviewer` already drives, reused here rather than re-derived. Never
 *  streams (WS-06 §4/R6-G: "an auxiliary generation never emits stream_events" is the router's OWN
 *  rule for its reviewer backend; Norma's side of that is simply never surfacing partial deltas). */
async function generateOverNormaProvider(provider: Provider, model: string, input: AdvisorReviewerRequest): Promise<AdvisorReviewerTurn> {
  const turnInput: TurnInputItem[] = input.messages.map((m) => ({ type: "message", role: m.role === "tool" ? "assistant" : m.role, content: m.content }));
  let text = "";
  for await (const ev of provider.streamTurn({ model, input: turnInput, tools: [] })) {
    if (ev.type === "text_delta") text += ev.delta;
    else if (ev.type === "error") throw new Error(`advisor reviewer provider error (${ev.code})`);
  }
  return { kind: "text", text };
}

/**
 * `targetModel` is the D30-reported canonical id (e.g. `gpt-6-astra`) — what `ResolvedReviewer.model`
 * states to the caller. The WIRE call is a SEPARATE concern: `createOpenAiCompatibleRuntimeProvider`
 * forwards an arbitrary model string verbatim (`manager.ts`'s own doc: "openai-compatible has no
 * allowlist — arbitrary API models are legitimate there"), so `targetModel` is sent as-is on that
 * branch. `createCodexOauthRuntimeProvider`'s backend, by contrast, only accepts its OWN verified
 * slugs (`CODEX_MODELS` — `manager.ts`'s `resolveSelection` falls an unrecognised configured slug
 * back to `DEFAULT_CODEX_MODEL` for exactly this reason), and 8d has no canonical-id -> Codex-native
 * slug table — so the codex-oauth branch sends `DEFAULT_CODEX_MODEL` on the wire while still
 * REPORTING `targetModel` as the resolved reviewer's `model`. Documented simplification, not a typo:
 * a future D30 slot-to-adapter-id table (the SDK's own `resolveSlotToProvider`, WS-13c §4) is the
 * real fix and is out of this lane's scope.
 */
function openAiFamilyReviewer(secrets: SecretStore, settings: () => Settings | undefined, targetModel: string): AdvisorReviewer {
  return {
    async generate(input: AdvisorReviewerRequest): Promise<AdvisorReviewerTurn> {
      const material = await readCredentialMaterial(secrets, CREDENTIAL_MATERIAL_NAMES.codexOauth);
      if (material !== null) {
        return generateOverNormaProvider(createCodexOauthRuntimeProvider(secrets), DEFAULT_CODEX_MODEL, input);
      }
      const provider = settings()?.provider;
      const baseUrl = provider?.type === "openai-compatible" ? provider.baseUrl : OPENAI_API_BASE_URL;
      return generateOverNormaProvider(createOpenAiCompatibleRuntimeProvider(secrets, baseUrl), targetModel, input);
    },
  };
}

/**
 * The Claude-family reviewer, over the SAME `anthropic:default` credential-material record the
 * official leg's own credential plan already reads (`keychain.ts`'s `ANTHROPIC_CREDENTIAL_SECRET_NAME`
 * — NO new credential kind, per P8d-8). Built directly on
 * `@yanlinglabs/winter-provider-runtime`'s Anthropic Messages adapter rather than through
 * `providers/runtime-provider.ts` (that module has no Anthropic export today, and it is Lane 2's file
 * in 8d — this is a small, self-contained adapter local to the advisor's own concern, never a second,
 * independently-drifting copy of `RuntimeBackedProvider`).
 */
function claudeFamilyReviewer(secrets: SecretStore, targetModel: string, connectionOverride?: () => { anthropicBaseUrl?: string } | undefined): AdvisorReviewer {
  const adapter = createAnthropicMessagesAdapter();
  const ref = credentialRefFor("anthropic");
  // P8d-17: TEST-ONLY (never a production `daemon.ts` wiring, never an ambient env var — the same
  // "a value only a test constructs" spirit as `official-options.ts`'s own `officialConnectionOverride`
  // and the Winter leg's `winter-test/<name>` double). `local: true` is required for the loopback
  // baseUrl to pass provider-runtime's own endpoint policy (the SAME reason
  // `createOpenAiCompatibleRuntimeProvider`'s own header states for its identical declaration).
  const override = connectionOverride?.();
  const context: ProviderContext = {
    connection: { providerId: "anthropic", ...(override?.anthropicBaseUrl === undefined ? {} : { baseUrl: override.anthropicBaseUrl, local: true }) },
    credentials: credentialStoreOverSecretStore(secrets),
    authRef: ref ?? { kind: "keychain", account: ANTHROPIC_CREDENTIAL_SECRET_NAME },
    stallTimeoutMs: 60_000,
    log: () => {},
  };
  return {
    async generate(input: AdvisorReviewerRequest): Promise<AdvisorReviewerTurn> {
      const model = targetModel;
      let text = "";
      for await (const ev of adapter.streamTurn({ model, messages: input.messages.map((m) => ({ role: m.role, content: m.content })) }, context)) {
        if (ev.type === "text_delta") text += ev.text;
        else if (ev.type === "error") throw new Error(`advisor reviewer provider error (${ev.error.code})`);
      }
      return { kind: "text", text };
    },
  };
}

/**
 * `advisorReviewerFor` (Interfaces block) — the ONE `ReviewerResolver` `create.ts` passes as
 * `RuntimeSdkOptions.advisor.resolveReviewer`, ALWAYS (never conditional on the setting — the
 * no-restart rule lives inside this closure, not at the call site).
 *
 * SYNCHRONOUS BY CONTRACT (`ReviewerResolver = () => ResolvedReviewer | undefined`): this function
 * decides WHETHER a reviewer resolves and WHICH model it reports WITHOUT a live Keychain read —
 * credential PRESENCE is checked against `credentialPresenceCache`'s sync, background-refreshed
 * snapshot (review fix F3), and a family with no configured credential reports `undefined` here,
 * exactly like the SDK's own `resolveReviewer` does for its "nothing to ask" case — never a throw.
 * The credential's actual VALUE is still read (and the HTTP-capable provider actually built) only
 * inside the returned `AdvisorReviewer.generate()`, which IS async — so a credential that was present
 * at `resolveReviewer()` time but goes missing (or was a cold-cache false-negative promoted to
 * true moments later) before `generate()` runs is WS-06 §4's ordinary "reviewer unavailable" tool
 * error, never a crash; presence here is a snapshot, not a lock (matching the SDK's own R6-G note on
 * `credentialEpoch`).
 */
/**
 * Review fix F3: a SYNCHRONOUS "is this credential material present" cache, refreshed in the
 * background — the same "a synchronous answer over an asynchronous fact" shape
 * `winter-agent-sdk`'s own `production-wiring.ts`/`session-provider.ts` uses for its identical
 * credential-gate problem (`credentialPresent`, read during the M5 diagnosis). `ReviewerResolver` is
 * pinned SYNCHRONOUS (`() => ResolvedReviewer | undefined`), so a real Keychain read cannot happen
 * inside `resolveReviewer()` itself — this cache is what lets the resolver answer `undefined` for a
 * family with no configured credential WITHOUT ever awaiting inside the call.
 *
 * COLD-START HONESTY: a name probed for the first time answers `false` (absent) synchronously and
 * fires a background probe; the NEXT call after that probe lands reads the real answer. This can
 * under-report "present" for one call right after this resolver is first built (or after a fresh
 * material write) — recorded rather than hidden, and it fails toward "no reviewer" (WS-06 §4's own
 * safe default), never toward inventing a provider for a credential that turns out absent.
 */
function credentialPresenceCache(secrets: SecretStore): (name: string) => boolean {
  const cache = new Map<string, boolean>();
  const inFlight = new Set<string>();
  const refresh = (name: string): void => {
    if (inFlight.has(name)) return;
    inFlight.add(name);
    void readCredentialMaterial(secrets, name)
      .then((m) => cache.set(name, m !== null))
      .catch(() => cache.set(name, false))
      .finally(() => inFlight.delete(name));
  };
  return (name: string): boolean => {
    refresh(name);
    return cache.get(name) ?? false;
  };
}

export function advisorReviewerFor(deps: {
  settings: () => Settings | undefined;
  secrets: SecretStore;
  familyOf: (model: string) => AdvisorFamily;
  sessionModel: () => string | undefined;
  /**
   * P8d-17 (controller ruling): TEST-ONLY (never a production `daemon.ts` wiring, never an ambient
   * env var — mirrors `official-options.ts`'s own `officialConnectionOverride` pattern). Redirects the
   * Claude-family reviewer's own HTTP call at a loopback Anthropic fake, so a real official-leg
   * session's `advisor` tool call can be proven to reach a scripted reviewer end to end.
   */
  connectionOverride?: () => { anthropicBaseUrl?: string } | undefined;
}): ReviewerResolver {
  const hasCredential = credentialPresenceCache(deps.secrets);
  return () => {
    const explicit = winterOptionsFromSettings(deps.settings()).advisorModel;
    const targetModel = explicit ?? d30DefaultModel(deps.sessionModel());
    if (targetModel === undefined) return undefined;
    const family = deps.familyOf(targetModel);
    // Review fix F3: "no credential for the target family" is `undefined`, checked HERE (sync, from
    // the cache above) — never inside `generate()`, and never a live Keychain read in this function.
    if (family === "openai") {
      if (!hasCredential(CREDENTIAL_MATERIAL_NAMES.codexOauth) && !hasCredential(CREDENTIAL_MATERIAL_NAMES.openai)) return undefined;
      return { provider: openAiFamilyReviewer(deps.secrets, deps.settings, targetModel), model: targetModel };
    }
    if (family === "claude") {
      if (!hasCredential(ANTHROPIC_CREDENTIAL_SECRET_NAME)) return undefined;
      return { provider: claudeFamilyReviewer(deps.secrets, targetModel, deps.connectionOverride), model: targetModel };
    }
    // "other": 8d states no provider-runtime mapping for a third family (see this module's header).
    return undefined;
  };
}
