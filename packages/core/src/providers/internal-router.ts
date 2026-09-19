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
  type InternalJobRole,
  type Settings,
} from "../settings";
import { buildInternalProvider, internalWireEffortFor } from "./internal-provider";
import { INTERNAL_JOBS_LOGIN_HINT } from "./internal-login-hint";
import type { InternalProviderView } from "./internal-view";
import { QuotaManager, withQuota } from "./quota";
import type { SubscriptionQuotaSource } from "./role-health";
import type { Provider } from "./types";

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
}

/** What a consumer of the internal provider is handed per call — the one seam
 *  `SessionTitler`/`BashReviewer`/`Dreamer`/`SessionCleaner` take instead of a `Provider` plus four
 *  getters. Re-resolved on EVERY call, which is what makes a settings, pin or credential change hot. */
export type InternalCallSource = () => InternalCall | InternalRefusal;

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
 */
export interface InternalRefusal {
  reason: "provider-unsupported" | "no-credential" | "no-internal-credential";
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
  readonly quota: QuotaManager;
  /** The role's EFFECTIVE tag — what `settings.modelRoles` reports and what a problem is keyed to.
   *  Answers even for a role that cannot run (an explicit pin on an unsupported provider is still that
   *  role's model), and `null` only when the role has no pin and nothing to default onto. */
  effectiveTag(role: InternalRole, settings: Settings | null | undefined): ModelTag | null;
  resolve(role: InternalRole, settings: Settings | null | undefined): InternalCall | InternalRefusal;
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
  const quota = deps.quota ?? new QuotaManager();
  const cache = new Map<string, { generation: number; baseUrl: string | undefined; provider: Provider | null }>();

  const providerFor = (providerId: string, settings: Settings | null | undefined): Provider | null => {
    const generation = deps.view.generation();
    const baseUrl = settings?.providers?.[providerId]?.baseUrl;
    const hit = cache.get(providerId);
    if (hit !== undefined && hit.generation === generation && hit.baseUrl === baseUrl) return hit.provider;
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

  return {
    view: deps.view,
    quota,
    effectiveTag,
    resolve(role, settings) {
      const tag = effectiveTag(role, settings);
      if (tag === null) {
        return { reason: "no-internal-credential", detail: `no provider Winter's own jobs can run on has a credential stored — ${INTERNAL_JOBS_LOGIN_HINT}`, tag: null };
      }
      let providerId: string;
      let model: string;
      try {
        ({ providerId, modelId: model } = splitTag(tag));
      } catch {
        return { reason: "provider-unsupported", detail: `${JSON.stringify(tag)} is not a provider-qualified model tag`, tag };
      }
      if (!deps.view.eligible().has(providerId)) {
        return {
          reason: "provider-unsupported",
          detail: `${providerDisplayName(providerId)} can't be used for Winter's own jobs yet`,
          tag,
        };
      }
      if (!deps.view.credentialed().has(providerId)) {
        return {
          reason: "no-credential",
          detail: `no credential is stored for ${providerDisplayName(providerId)}`,
          tag,
        };
      }
      const provider = providerFor(providerId, settings);
      if (provider === null) {
        return {
          reason: "provider-unsupported",
          detail: `${providerDisplayName(providerId)} can't be used for Winter's own jobs yet`,
          tag,
        };
      }
      const wanted = effortToSpendForRole(settings, role, tag, CONSUMER_EFFORT[role]);
      const effort = internalWireEffortFor(tag, wanted);
      return { provider, model, tag, providerId, quota, ...(effort === undefined ? {} : { effort }) };
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
    effectiveTag: (role, settings) => explicitInternalRolePin(settings, role) ?? tag,
    resolve(role, settings) {
      const pinned = explicitInternalRolePin(settings, role);
      // An explicit pin still decides the MODEL (that is what every pre-existing test that sets
      // `settings.pins.dream` asserts) but never the backend: there is only one here.
      const effectiveTag = pinned ?? tag;
      let model = cfg.model;
      try { model = splitTag(effectiveTag).modelId; } catch { /* a non-tag double keeps the given model */ }
      const wanted = effortToSpendForRole(settings, role, effectiveTag, CONSUMER_EFFORT[role]);
      return { provider: cfg.provider, model, tag: effectiveTag, quota, providerId: (() => { try { return splitTag(effectiveTag).providerId; } catch { return cfg.provider.id; } })(), ...(wanted === undefined ? {} : { effort: wanted }) };
    },
  };
}

