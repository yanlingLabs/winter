/**
 * 2026-09-19: the ONE door every caller of Winter's own background jobs passes through —
 * `resolve(role)` answers either "here is the `Provider`, the bare model id it speaks and the
 * qualified tag this call runs on", or a typed refusal naming why the job is not running.
 *
 * WHY A RESOLVER AND NOT A ROUTING `Provider` FACADE. `Provider.streamTurn(req)` carries only a BARE
 * model id, which is ambiguous across providers by construction (that is the whole reason
 * `internalModelFor` existed). A facade would have to guess which backend a bare id meant — exactly the
 * silent-wrong-backend failure `internalModelFor`'s header warns about, re-created one layer up. So the
 * resolution happens where the ROLE is still known, and the caller is handed a `Provider` already
 * matched to the model it is about to send. `internalModelFor` is retired by this: its job (refuse a
 * cross-provider pin) becomes "resolve the pin's OWN provider", which is the fix rather than the guard.
 *
 * THE ANTI-RACE PROPERTY (`createRebindableProvider`'s header) is preserved and strengthened. There is
 * no "bound backend" for bookkeeping to disagree with any more: every answer — the wire's `permitted`,
 * the default-tag reader, and this dispatcher — derives synchronously from ONE mutable fact, the
 * `InternalProviderView`'s `credentialed` set, which moves only inside `view.refresh()`. A per-provider
 * `Provider` instance is cached against `view.generation()`, so a credential write (which bumps the
 * generation) can never leave a live instance resolving material that has been replaced, and a
 * `providers.<id>.baseUrl` change is caught by caching the resolved base URL beside it.
 *
 * NEVER THROWS, NEVER LOGS PER CALL. A refusal is a value; the narration of a state CHANGE belongs to
 * `internal-view.ts` (one line per change). A caller that gets a refusal skips its run, which is the
 * same "typed refusal over a silent wrong answer" discipline every RPC door in this codebase follows.
 */
import { loadCatalog } from "@yanlinglabs/winter-provider-catalog";
import type { SecretStore } from "../auth/secret-store";
import { splitTag, type ModelTag } from "../runtime-sdk/model-tag";
import {
  effortToSpendForRole,
  explicitInternalRolePin,
  internalRoleEffectiveTag,
  internalRoleNoTagReason,
  type InternalJobRole,
  type Settings,
} from "../settings";
import { wireModelIdFor } from "./internal-adapters";
import { buildInternalProvider, internalWireEffortFor } from "./internal-provider";
import { INTERNAL_JOBS_LOGIN_HINT } from "./internal-login-hint";
import type { InternalProviderView } from "./internal-view";
import { QuotaManager, withQuota } from "./quota";
import type { SubscriptionQuotaSource } from "./role-health";
import type { Provider } from "./types";
import { isRetiredCatalogTag } from "./catalog-role-problems";

/** The role union and its membership test live in `settings.ts` (`INTERNAL_JOB_ROLES`) beside the pure
 *  effective-tag rule both this module and the wire read — re-exported here so a consumer holding a
 *  router needs no second import. */
export type InternalRole = InternalJobRole;
export { INTERNAL_JOB_ROLES as INTERNAL_ROLES, isInternalJobRole as isInternalRole } from "../settings";

export interface InternalCall {
  provider: Provider;
  /** The BARE model id — what this provider's `streamTurn` expects. */
  model: string;
  /** The provider-qualified tag this call actually runs on: what role-health records against, and what
   *  `settings.modelRoles` reports as the role's `model`. */
  tag: ModelTag;
  providerId: string;
  /** Already mapped onto the row `tag` names, and omitted when the row cannot take it
   *  (`internalWireEffortFor`). */
  effort?: string;
  /** The daemon's ONE `QuotaManager` — carried on the call so a consumer's role-health classification
   *  can read `subscriptionQuota()` without a second dep (it used to come off
   *  `RebindableProvider.quota`). Shared across every provider: see `createInternalRouter`. */
  quota?: SubscriptionQuotaSource;
  /**
   * Set ONLY on a `fallbackToDefault` call whose explicit pin was unrunnable (see `ResolveOptions`): this
   * call is live and will run, on the DEFAULT tag, and `pinRefusal` is the pin's own issue so the wire can
   * still report it. `pinRefusal.tag` is the pin; this call's own `tag` is what is actually running.
   */
  pinRefusal?: InternalRefusal;
}

/** What a consumer of the internal provider is handed per call — the one seam
 *  `SessionTitler`/`BashReviewer`/`Dreamer`/`SessionCleaner` take instead of a `Provider` plus four
 *  getters. Re-resolved on EVERY call, which is what makes a settings, pin or credential change hot. */
export type InternalCallSource = () => InternalCall | InternalRefusal;

/**
 * 2026-09-19: EXACTLY ONE of `source`/`resolve` (what a real daemon wires) or `provider` (the legacy
 * structurally-typed double ~16 test files construct) must be given. Spelled once here so all four
 * internal-job consumers refuse the same way instead of reading `undefined.provider`.
 */
export function requireInternalWiring(what: string): never {
  throw new Error(`${what}: neither an internal-jobs resolver nor a provider handle was wired`);
}

/**
 * The two reason strings the Mac's Roles pane already ships wording for, plus the pre-existing
 * `no-credential`:
 *
 *  - `"provider-unsupported"` — the role's EXPLICIT tag names a provider Winter's own jobs cannot run
 *    on (a first-party Claude provider, or one whose adapter family the daemon cannot drive).
 *    `detail` names the provider's display name.
 *  - `"no-credential"` — the role's explicit tag names an ELIGIBLE provider with nothing stored in its
 *    slot. The pre-existing reason, reused deliberately: it already means exactly this, and the Mac
 *    already renders it.
 *  - `"no-internal-credential"` — NO eligible provider holds a credential at all, so there is nothing
 *    for a defaulted role to fall back to and every internal role is inert together.
 *  - `"model-not-in-catalog"` (R.1 ruling 1, WS-21) — the role's tag (a pin, or the default rule's
 *    answer) is a provider-qualified tag the linked catalog has no row for: a row a refresh RETIRED with
 *    no rename (`deepseek/deepseek-reasoner`, V16), stored before the upgrade. No credential makes it
 *    runnable, so it is judged before the credential (after the provider's eligibility), and treated exactly like any
 *    other unrunnable pin (the reviewer falls back; titles/the dreamer/the cleaner stay inert with a
 *    note). The same reason `settings.modelRoles` derives for a session-facing role
 *    (`catalog-role-problems.ts`).
 *  - `"no-default-model"` (M-3) — a provider IS credentialed, but Winter will not CHOOSE a model on it:
 *    it declares no `terra`/`luna` family slot and it is not `settings.provider.model`'s own provider,
 *    so there is no model the user can be said to have picked. The fix is a pin, not a credential, so it
 *    has to be a different reason from `no-credential` — see `internalRoleDefaultTagFor`'s own doc for
 *    the measurement that made guessing unacceptable.
 */
export interface InternalRefusal {
  reason: "provider-unsupported" | "no-credential" | "no-internal-credential" | "no-default-model" | "model-not-in-catalog";
  detail: string;
  /** The tag the refusal is ABOUT — the role's explicit pin, or `null` when the role has no pin and
   *  nothing to default onto. `role-health.ts`'s `problemFor` compares a note's model against the
   *  role's current effective model, so a synthetic problem has to carry one when one exists. */
  tag: ModelTag | null;
}

export function isInternalRefusal(v: InternalCall | InternalRefusal): v is InternalRefusal {
  return (v as InternalRefusal).reason !== undefined;
}

export interface InternalRouter {
  readonly view: InternalProviderView;
  /**
   * M-3/M-2: the quota ledger for ONE provider, created on first use and keyed exactly like the
   * `Provider` cache. `undefined` for a provider that has never been called.
   *
   * ONE PER PROVIDER, not one shared (M-2, review): `QuotaManager` carries a global `limitedUntil`, so a
   * Codex usage-limit 429 — whose `retryAfterMs` is hour-scale — used to stall a perfectly healthy
   * DeepSeek role through the shared instance. A rate limit is a fact about one vendor's account.
   */
  quotaFor(providerId: string): QuotaManager | undefined;
  /**
   * What `daemon.status`/`sync.config` read — THE `codex-oauth` LEDGER, always.
   *
   * `daemon.ts` reads this ONCE at boot into the value it hands `startIpcServer`, when the map is still
   * empty, so the getter's own fallback creates the codex ledger and that is the one status reports for
   * the daemon's whole life. Deliberate, and it is the compatibility requirement: codex-oauth is the only
   * backend that ever reports a subscription quota (`quotaEvent`), so a codex user's status reads exactly
   * as it did before the per-provider split. A home that never calls codex-oauth therefore shows an inert
   * zero/ok ledger — which is ALSO what it showed before this branch (a null `agentProvider` meant
   * `daemon.ts` substituted a fresh, never-written `QuotaManager`), so nothing regressed; it is simply
   * not a cross-vendor view. Per-provider numbers are `quotaFor`, and the token counters on any one
   * ledger are that provider's alone — summing an OpenAI-priced count and a DeepSeek-priced count into
   * one field would be a wrong number that reads as authoritative. The RPC shape is unchanged.
   */
  readonly quota: QuotaManager;
  /** The role's EFFECTIVE tag — what `settings.modelRoles` reports and what a problem is keyed to.
   *  Answers even for a role that cannot run (an explicit pin on an unsupported provider is still that
   *  role's model), and `null` only when the role has no pin and nothing to default onto. */
  effectiveTag(role: InternalRole, settings: Settings | null | undefined): ModelTag | null;
  resolve(role: InternalRole, settings: Settings | null | undefined, opts?: ResolveOptions): InternalCall | InternalRefusal;
}

/**
 * USER RULING 2026-09-19: `fallbackToDefault` is for `reviewer.model` AND NOTHING ELSE.
 *
 * A SAFETY job must not switch itself off because of a pin mistake. When the reviewer's EXPLICIT pin is
 * unrunnable — `provider-unsupported` (a pre-ruling Claude pin), `no-credential` (pinned to a provider
 * whose key has not arrived; a state the write door deliberately admits) or `model-not-in-catalog` (a
 * pin on a row the catalog retired, R.1 ruling 1) — the reviewer RUNS on the
 * answer an UNPINNED reviewer would get (the default rule's rungs 1-2), and the role's `problem` still
 * reports the pin's own issue with a "meanwhile" note saying what it is actually reviewing on
 * (`internal-role-problems.ts`). Only when the default rule has no answer either
 * (`no-internal-credential`/`no-default-model`) does the hook's structural `allow()` path apply.
 *
 * DELIBERATELY NOT for titles/the dreamer/the cleaner: for those, spending a credential on a provider the
 * user did not choose for that job is worse than not running it, so a refused pin stays inert with a note.
 * The asymmetry is the whole point — one of these four is a safety gate and three are conveniences — and
 * `resolve` ENFORCES it on the role rather than trusting callers to pass this flag correctly, so setting it
 * for another role is inert by construction.
 */
export interface ResolveOptions {
  fallbackToDefault?: boolean;
}

/** The consumer defaults that predate roles being able to store an effort — passed through
 *  `effortToSpendForRole` verbatim, exactly as each consumer did before, and then normalised onto the
 *  row by `internalWireEffortFor`. `undefined` for titles/the reviewer: neither ever sent one. */
const CONSUMER_EFFORT: Readonly<Record<InternalRole, string | undefined>> = {
  "titles.model": undefined,
  "reviewer.model": undefined,
  "pins.dream": "medium",
  "pins.cleaner": "low",
};

function providerDisplayName(providerId: string): string {
  return loadCatalog().providers.find((p) => p.id === providerId)?.displayName ?? providerId;
}

export function createInternalRouter(deps: {
  view: InternalProviderView;
  secrets: SecretStore;
  /** Shared across every per-provider instance for the daemon's whole life — quota tracking is
   *  per-daemon, never per-provider-instance (`createProvider`'s `existingQuota` doc). */
  quota?: QuotaManager;
  /** TEST-ONLY: a loopback base URL per provider id, threaded into `buildInternalProvider`. */
  testBackendUrl?: (providerId: string) => string | undefined;
}): InternalRouter {
  // M-2: ONE ledger PER PROVIDER, created lazily and keyed like the `Provider` cache. A `deps.quota`
  // (tests, and any caller that wants to observe one) seeds the FIRST provider asked for, so a
  // single-provider test sees exactly what it did before.
  const quotas = new Map<string, QuotaManager>();
  let seedQuota = deps.quota;
  const quotaFor = (providerId: string): QuotaManager => {
    const hit = quotas.get(providerId);
    if (hit !== undefined) return hit;
    const made = seedQuota ?? new QuotaManager();
    seedQuota = undefined;
    quotas.set(providerId, made);
    return made;
  };
  const cache = new Map<string, { generation: number; baseUrl: string | undefined; provider: Provider | null }>();

  const providerFor = (providerId: string, settings: Settings | null | undefined): Provider | null => {
    const generation = deps.view.generation();
    const baseUrl = settings?.providers?.[providerId]?.baseUrl;
    const hit = cache.get(providerId);
    if (hit !== undefined && hit.generation === generation && hit.baseUrl === baseUrl) return hit.provider;
    const quota = quotaFor(providerId);
    const built = buildInternalProvider({
      providerId,
      secrets: deps.secrets,
      settings,
      onSubscriptionQuota: (info) => quota.noteSubscriptionQuota(info),
      ...(() => {
        const url = deps.testBackendUrl?.(providerId);
        return url === undefined ? {} : { testBackendUrl: url };
      })(),
    });
    const provider = "provider" in built ? withQuota(built.provider, quota) : null;
    cache.set(providerId, { generation, baseUrl, provider });
    return provider;
  };

  const effectiveTag = (role: InternalRole, settings: Settings | null | undefined): ModelTag | null =>
    internalRoleEffectiveTag(settings, role, deps.view.snapshot());

  /** Resolve ONE already-chosen tag. Split out of `resolve` so the reviewer's pin fallback can ask the
   *  same question twice — once for the pin, once for the default — with no second spelling of the rules. */
  const resolveTag = (role: InternalRole, settings: Settings | null | undefined, tag: ModelTag): InternalCall | InternalRefusal => {
    let providerId: string;
    let model: string;
    try {
      ({ providerId, modelId: model } = splitTag(tag));
    } catch {
      return { reason: "provider-unsupported", detail: `${JSON.stringify(tag)} is not a provider-qualified model tag`, tag };
    }
    if (!deps.view.eligible().has(providerId)) {
      return { reason: "provider-unsupported", detail: `${providerDisplayName(providerId)} can't be used for Winter's own jobs yet`, tag };
    }
    // R.1 ruling 1: a tag with no catalog row can never run — judged after the provider (a provider Winter's
    // jobs can never use is the more fundamental answer) and before the credential (no key would make it
    // runnable). Never a silent substitute; the reviewer's fallback below is the user-ruled exception, and it
    // reports this pin's own issue while it runs.
    if (isRetiredCatalogTag(tag)) {
      return { reason: "model-not-in-catalog", detail: `${tag} is not in this build's model catalog — pick another model for this job`, tag };
    }
    if (!deps.view.credentialed().has(providerId)) {
      // NO self-heal here, and the reason is worth recording: this branch is reachable ONLY through an
      // EXPLICIT pin. Every rung of `preferredInternalProviderFor` tests `credentialed.has(id)`, so a
      // DEFAULTED role's tag is on a credentialed provider by construction and an uncredentialed default
      // surfaces as `no-internal-credential`/`no-default-model` (both of which do probe). A pin on some
      // other provider is a deliberate choice whose credential nothing writes behind the user's back.
      return { reason: "no-credential", detail: `no credential is stored for ${providerDisplayName(providerId)}`, tag };
    }
    const provider = providerFor(providerId, settings);
    if (provider === null) {
      return { reason: "provider-unsupported", detail: `${providerDisplayName(providerId)} can't be used for Winter's own jobs yet`, tag };
    }
    const wanted = effortToSpendForRole(settings, role, tag, CONSUMER_EFFORT[role]);
    const effort = internalWireEffortFor(tag, wanted);
    return { provider, model: wireModelIdFor(providerId, model), tag, providerId, quota: quotaFor(providerId), ...(effort === undefined ? {} : { effort }) };
  };

  /** The refusal for "no tag at all" — shared by `resolve` and the pin-fallback path. */
  const noTagRefusal = (role: InternalRole, settings: Settings | null | undefined): InternalRefusal => {
    const why = internalRoleNoTagReason(settings, role, deps.view.snapshot());
    if (why?.reason === "no-default-model") {
      // A credential IS present — a probe would not change this answer, so no self-heal here.
      return {
        reason: "no-default-model",
        detail: `pick a model for this job in Settings › Roles — Winter won't choose one on ${providerDisplayName(why.providerId ?? "")} for you`,
        tag: null,
      };
    }
    // SELF-HEAL (B-1): `winter login` writes `codex-oauth:default` in-process, so a cached snapshot can
    // be stale in exactly this state. Non-blocking and rate-limited — the NEXT call is right.
    deps.view.refreshSoon();
    return { reason: "no-internal-credential", detail: `no provider Winter's own jobs can run on has a credential stored — ${INTERNAL_JOBS_LOGIN_HINT}`, tag: null };
  };

  return {
    view: deps.view,
    quotaFor: (providerId) => quotas.get(providerId),
    // See the interface's own doc: `daemon.ts` reads this at boot with the map empty, so the fallback
    // creates the codex-oauth ledger and status reports that one for the daemon's whole life.
    get quota(): QuotaManager {
      return quotas.get("codex-oauth") ?? [...quotas.values()][0] ?? quotaFor("codex-oauth");
    },
    effectiveTag,
    resolve(role, settings, opts) {
      const tag = effectiveTag(role, settings);
      if (tag === null) return noTagRefusal(role, settings);
      const first = resolveTag(role, settings, tag);
      if (!isInternalRefusal(first)) return first;
      // THE REVIEWER'S PIN FALLBACK (user ruling — see `ResolveOptions`). Only for a refusal about the PIN
      // itself, and only when a pin is what produced this tag: the default rule's own answers
      // (`no-internal-credential`/`no-default-model`) are handled above and have nothing to fall back to.
      if (opts?.fallbackToDefault !== true) return first;
      // THE ASYMMETRY IS ENFORCED HERE, not left to the call sites. `reviewer.model` is the only safety
      // gate of the four; for titles/the dreamer/the cleaner, spending a credential on a provider the user
      // did not choose for that job is worse than not running it, so a refused pin stays inert with a note.
      // Gating on the role rather than trusting every present and future caller to pass the flag correctly
      // is what makes that a property of the router instead of a convention.
      if (role !== "reviewer.model") return first;
      if (explicitInternalRolePin(settings, role) === undefined) return first;
      if (first.reason !== "provider-unsupported" && first.reason !== "no-credential" && first.reason !== "model-not-in-catalog") return first;
      const fallbackTag = internalRoleEffectiveTag(settings, role, deps.view.snapshot(), { ignoreExplicitPin: true });
      if (fallbackTag === null) return noTagRefusal(role, settings);
      const second = resolveTag(role, settings, fallbackTag);
      // The default rule can only land on a credentialed, eligible provider, so a refusal here would be a
      // build failure (an unusable endpoint). Report the PIN's issue in that case — it is the actionable one.
      if (isInternalRefusal(second)) return first;
      return { ...second, pinRefusal: first };
    },
  };
}

/**
 * A router over ONE already-built `Provider` — the injected-double path (`daemon.ts`'s
 * `opts.agentProvider`, which many tests pass as a plain `{provider, model}`). Every role resolves to
 * that provider and that model, which is what those tests have always asserted, and no secret store or
 * catalog lookup is touched.
 */
export function staticInternalRouter(cfg: {
  view: InternalProviderView;
  provider: Provider;
  model: string;
  tag?: ModelTag;
  quota?: QuotaManager;
}): InternalRouter {
  const quota = cfg.quota ?? new QuotaManager();
  const tag = cfg.tag ?? (`${cfg.provider.id}/${cfg.model}` as ModelTag);
  return {
    view: cfg.view,
    quota,
    quotaFor: () => quota,
    effectiveTag: (role, settings) => explicitInternalRolePin(settings, role) ?? tag,
    resolve(role, settings) {
      const pinned = explicitInternalRolePin(settings, role);
      // An explicit pin still decides the MODEL (that is what every pre-existing test that sets
      // `settings.pins.dream` asserts) but never the backend: there is only one here.
      const effectiveTag = pinned ?? tag;
      let model = cfg.model;
      try { model = splitTag(effectiveTag).modelId; } catch { /* a non-tag double keeps the given model */ }
      // M-1 (review): through the SAME `internalWireEffortFor` production uses. ~16 test doubles run
      // this path, so it is what actually exercises the effort rule — a second, laxer spelling here
      // would mean the `"none"`/unmappable-tier behaviour was never under test at all.
      const wanted = effortToSpendForRole(settings, role, effectiveTag, CONSUMER_EFFORT[role]);
      const effort = internalWireEffortFor(effectiveTag, wanted);
      return { provider: cfg.provider, model, tag: effectiveTag, quota, providerId: (() => { try { return splitTag(effectiveTag).providerId; } catch { return cfg.provider.id; } })(), ...(effort === undefined ? {} : { effort }) };
    },
  };
}

