import { statSync } from "node:fs";
import type { SecretStore } from "../auth/secret-store";
import { readOpenAiApiKey } from "../auth/credential-material";
import { OPENAI_API_KEY_SECRET } from "../auth/legacy-secret-names";
import { loadSettings, providerBaseUrlFor, INTERNAL_PROVIDER_IDS, type Settings } from "../settings";
import type { ModelInfo, Provider, ProviderEvent, TurnRequest } from "./types";
import { createCodexOauthRuntimeProvider, createOpenAiCompatibleRuntimeProvider } from "./runtime-provider";
import { QuotaManager, withQuota } from "./quota";
import { splitTag, type ModelTag } from "../runtime-sdk/model-tag";

/** LEGACY raw record — migration source only (`auth/credential-material.ts`'s
 *  `readOpenAiApiKey`/`migrateLegacyCredentialMaterial`). Writers use `writeOpenAiApiKey`, which
 *  writes ONLY the `openai:default` JSON material record the spawned Winter child reads. Defined
 *  in the leaf `auth/legacy-secret-names.ts` (hotfix review r1, m1 — breaks the import cycle with
 *  `auth/credential-material.ts`) and re-exported here verbatim so every existing importer of
 *  `OPENAI_API_KEY_SECRET` from this module keeps working unchanged. */
export { OPENAI_API_KEY_SECRET };

/** What a turn actually resolves to: the model slug plus an optional reasoning-effort hint. WS-20:
 *  `model` is the BARE modelId (this module's `Provider` abstraction is bound to ONE backend at
 *  construction time and speaks that backend's own dialect) — the tag is split once, at THIS
 *  boundary, mirroring the runtime-sdk spawn boundary (§0.1). */
export interface LiveModelSelection {
  model: string;
  reasoningEffort?: string;
  /** The CATALOG providerId (`splitTag(settings.provider.model).providerId` at BOOT time, never
   *  re-derived live — see this interface's own doc comment above for why the provider identity
   *  is fixed for the life of this `ActiveProvider`). This is deliberately NOT `Provider.id` (the
   *  internal adapter literal, `"codex-oauth"` or `"openai-compatible"`) — a caller that wants to
   *  recompose a real `ModelTag` (`daemon.ts`'s own `liveModel`, ipc/sync.ts's `syncConfig`) needs
   *  the CATALOG id, and `Provider.id` only happens to agree with it for the codex-oauth arm. */
  providerId: string;
}

export interface ActiveProvider {
  provider: Provider;
  model: string;
  quota: QuotaManager;
  /**
   * Live per-turn model/effort resolver (spec: "changing models must NOT require a daemon
   * restart"). Re-reads `settingsPath` on every call, mtime-cached (same pattern as
   * ipc/server.ts's `livePlugins`) so a settings.json untouched since the last call is a cheap
   * cache hit, not a fresh parse. Falls back to the LAST GOOD resolved value — starting with the
   * boot-time settings passed to createProvider — on ANY read/parse failure (missing file,
   * mid-write partial JSON, failed zod validation): this must NEVER throw into a turn.
   *
   * WS-20: `settings.provider.model` is read VERBATIM, then split once at this boundary — no
   * deprecated-slug rewrite (the CODEX_MODELS allowlist and its DEFAULT_CODEX_MODEL fallback are
   * gone; the pinned catalog is the one source for which models exist, and an unlisted slug is
   * the provider's own 400 to report, not this daemon's to silently paper over). The provider
   * IDENTITY itself is fixed at the boot-time value (`providerId`, closed over below) — a
   * settings.json edited to name a DIFFERENT provider still needs a daemon restart to take effect
   * (out of scope here), so this resolver deliberately ignores any live-read provider prefix and
   * only ever emits the bare id for the provider this Provider instance was actually constructed
   * for.
   */
  liveModel: () => LiveModelSelection;
}

function statMtimeOrZero(path: string): number {
  try { return statSync(path).mtimeMs; } catch { return 0; } // missing file -> key 0
}

/** Resolves the (model, reasoningEffort) pair for one already-loaded Settings — `model` is the
 *  BARE modelId half of `settings.provider.model`'s tag, verbatim (see `liveModel`'s doc comment
 *  above for why no rewrite/fallback happens here any more). */
function resolveSelection(settings: Settings, providerId: string): LiveModelSelection {
  const { model, reasoningEffort } = settings.provider;
  return { model: splitTag(model).modelId, providerId, ...(reasoningEffort ? { reasoningEffort } : {}) };
}

/** Builds the `liveModel` resolver for `createProvider`. `settingsPath` is optional — omitted
 *  (e.g. tests, `winter provider-smoke`) means the resolver just keeps returning the boot-time
 *  selection forever (no re-read possible without a path). `providerId` is the BOOT-time catalog
 *  id (`createProvider`'s own `providerId` local) — passed in rather than re-derived from each
 *  live read, because the provider IDENTITY is fixed at boot (this function's own doc comment). */
function buildLiveModelResolver(
  bootSettings: Settings,
  settingsPath: string | undefined,
  providerId: string,
): () => LiveModelSelection {
  let lastGood = resolveSelection(bootSettings, providerId);
  let cache: { key: number; value: LiveModelSelection } | null = null;

  return () => {
    if (!settingsPath) return lastGood;
    const key = statMtimeOrZero(settingsPath);
    if (cache && cache.key === key) return cache.value;
    let settings: Settings;
    try {
      settings = loadSettings(settingsPath);
    } catch {
      return lastGood; // read/parse failure — never throw into a turn, keep the last good value
    }
    const value = resolveSelection(settings, providerId);
    cache = { key, value };
    lastGood = value;
    return value;
  };
}

/**
 * `settingsPath` (optional) enables the returned `liveModel()` resolver to re-read settings.json
 * on each call instead of only ever reflecting this boot-time snapshot — omit it (as
 * `provider-smoke` and most tests do) and `liveModel()` just keeps returning the boot selection.
 *
 * WS-20: which backend this daemon runs is decided by `splitTag(settings.provider.model).providerId`
 * — "codex-oauth" onto the Codex OAuth adapter, every other INTERNAL provider id (chiefly "openai",
 * the BYO-endpoint arm) onto the OpenAI-compatible adapter with
 * `providerBaseUrlFor(settings, providerId)` (`providers.<id>.baseUrl` — `settings.provider.baseUrl`
 * itself no longer exists on `ProviderSettings`; the v2→v3 migration copies it into
 * `providers.openai.baseUrl` once, see settings.ts).
 *
 * WS-20 (review round 4): `settings.provider.model` is UNCONSTRAINED at the schema level (any
 * catalog provider, or `winter-test/*` — a SESSION's own model always has been, and the schema
 * gate a prior round put on this field broke the ordinary "my default chat model is Claude" case,
 * since a session with no explicit override falls back to THIS field, not just the internal
 * Provider's own binding). The daemon's internal Provider, by contrast, really can only ever be
 * ONE of `INTERNAL_PROVIDER_IDS` (codex-oauth/openai) — a single process-wide instance, built here.
 * A `providerId` outside that set answers `null` rather than mis-building an OpenAI-compatible
 * client pointed at a provider it was never meant to speak to; the caller (daemon.ts) treats that
 * as "no internal Provider" — titles/reviewer/dreamer/cleaner/research/compaction go inert, logged
 * ONCE, never a boot refusal. A per-provider internal Provider (one instance per provider, built on
 * the SDK) is the real follow-up that would let this set grow; not attempted here.
 */
export async function createProvider(
  settings: Settings,
  secrets: SecretStore,
  settingsPath?: string,
  /**
   * Daemon settings surface (2026-09-17 plan, item 2): an existing `QuotaManager` to wrap the
   * freshly-built backend in, instead of a brand-new one. `createRebindableProvider`'s `refresh`
   * passes the ORIGINAL instance across every rebuild so daemon.ts's exposed `quota` field (wired
   * once into `startIpcServer`'s opts) stays the SAME object for the daemon's whole life — quota
   * tracking is per-daemon, not per-provider-instance, so a `provider.model` write that crosses
   * providers must not reset (or orphan) it. Every existing caller omits this and gets a fresh
   * `QuotaManager`, unchanged.
   */
  existingQuota?: QuotaManager,
): Promise<ActiveProvider | null> {
  const providerId = splitTag(settings.provider.model).providerId;
  if (!(INTERNAL_PROVIDER_IDS as readonly string[]).includes(providerId)) return null;
  const quota = existingQuota ?? new QuotaManager();
  let inner: Provider;
  if (providerId === "codex-oauth") {
    // P8c lane 5: onto the `@yanlinglabs/winter-provider-runtime` codex-oauth adapter — credential
    // resolution (and, on a 401, refresh write-back) goes through `credential-store.ts`'s
    // `CredentialStore`, which reads/writes the SAME `codex-oauth:default` material record the
    // spawned Winter child does (`runtime-provider.ts`'s own header). No eager credential check
    // here — matches the pre-8c `CodexOAuthProvider` construction (deleted, Phase 8d task 2.4:
    // superseded by this adapter and never re-added), which never touched the secret store at construction time
    // either; a missing/invalid credential surfaces as a typed `auth` error from the FIRST
    // `streamTurn()` call, same as before.
    // P8d-13: the ONE wiring line for the subscription-quota carry — `quota` already exists above
    // (constructed before the provider-type branch), so this is the door, not a new one.
    inner = createCodexOauthRuntimeProvider(secrets, undefined, (info) => quota.noteSubscriptionQuota(info));
  } else {
    // Fail-fast, unchanged: `createProvider` itself throws before anything is constructed when no
    // key is stored (manager.test.ts pins this exact message).
    const apiKey = await readOpenAiApiKey(secrets);
    if (!apiKey) throw new Error("no API key stored — run: winter login --api-key");
    // providerBaseUrlFor's own doc comment: "ABSENT IS THE NORMAL CASE" — an empty string is the
    // same "no override" signal `createOpenAiCompatibleRuntimeProvider`'s `connection.baseUrl` has
    // always accepted (the adapter falls back to its own generated default).
    inner = createOpenAiCompatibleRuntimeProvider(secrets, providerBaseUrlFor(settings, providerId) ?? "");
  }
  const liveModel = buildLiveModelResolver(settings, settingsPath, providerId);
  return { provider: withQuota(inner, quota), model: splitTag(settings.provider.model).modelId, quota, liveModel };
}

/**
 * Daemon settings surface (2026-09-17 plan, item 2): a `Provider` whose underlying BACKEND can be
 * replaced in place (`rebind`) without this object's own identity ever changing. This is the fix
 * for the gap `settings.ts`'s `modelRoleInfo` doc comment names: `agentProvider` (daemon.ts) used
 * to be built ONCE at boot from `settings.provider.model` and never rebuilt on a hot write, so a
 * live `provider.model` change updated every LIVE bookkeeping read (`ownProviderFor`,
 * `internalModelFor`'s comparison) before the actual bound backend caught up — the gate would say
 * "yes, this pin routes to provider X" while the call it waved through still dispatched to
 * whichever backend was live at boot.
 *
 * Several existing callers capture `.provider` directly rather than through a level of
 * indirection (`agent/research.ts`'s runner takes `active.provider` itself, not a wrapper around
 * it) — so the fix cannot be "reassign the wrapper's `.provider` field", it has to be "the object
 * every caller is already holding to never changes identity, only what it forwards to". Every
 * consumer that captured a `SwappableProvider` reference — directly, or one level removed through
 * `agentProvider.provider` — sees a rebind with NO changes to its own code.
 *
 * `streamTurn` captures `this.current` at CALL time, so an in-flight call is never torn: it keeps
 * running the async iterable it already got from whichever backend it started on, even if
 * `rebind()` runs moments later. Only a call that starts AFTER `rebind()` returns dispatches to
 * the new backend. This is what makes a hot swap safe with no drain/cancellation logic at all —
 * the same property `settings-apply.ts`'s CU/LSP diffs get from a DIFFERENT mechanism (an explicit
 * drain loop); a `Provider` needs no such loop because `rebind` never disposes of the old backend,
 * it only stops handing it out.
 */
export class SwappableProvider implements Provider {
  private current: Provider;
  constructor(initial: Provider) {
    this.current = initial;
  }
  get id(): string {
    return this.current.id;
  }
  models(): ModelInfo[] {
    return this.current.models();
  }
  streamTurn(req: TurnRequest): AsyncIterable<ProviderEvent> {
    return this.current.streamTurn(req);
  }
  /** Never call from anywhere but `RebindableProvider.refresh` below — a bare `rebind` bypasses
   *  that function's `providerId` bookkeeping, which is what stops a redundant rebuild from
   *  running on every settings write that leaves `provider.model` on the SAME provider. */
  rebind(next: Provider): void {
    this.current = next;
  }
}

/**
 * Daemon settings surface (2026-09-17 plan, item 2): the daemon-boot-lifetime handle —
 * `daemon.ts`'s `agentProvider` — that stays hot across a `provider.model` write. Structurally the
 * SAME shape `createProvider`'s `ActiveProvider` already had (`provider`/`model`/`quota`/`live`,
 * renamed from `liveModel` only because every existing consumer's own field is already called
 * `live`, e.g. `SessionTitler`'s `deps.provider.live`) — every pre-existing consumer
 * (`SessionTitler`, `BashReviewer`, `Dreamer`, `SessionCleaner`, the research runner, `daemon.ts`'s
 * own `knownModels`/`liveSelection` closures) keeps working unmodified, because they were never
 * typed against `ActiveProvider` directly, only against the narrower shape this also satisfies.
 *
 * `model`/`live` are MUTATED in place by `refresh` (never reassigned to a new object — this exact
 * object is what every consumer captured), so the ONE remaining piece — `provider` — being a
 * `SwappableProvider` is what makes the mutation visible even to a caller that unwrapped `.provider`
 * at construction time and threw the wrapper away (research.ts).
 */
export interface RebindableProvider {
  readonly provider: SwappableProvider;
  model: string;
  live: () => LiveModelSelection;
  readonly quota: QuotaManager;
  /**
   * Re-resolves against `nextSettings`; rebuilds and rebinds ONLY when the resolved catalog
   * `providerId` actually changed (a same-provider write — a new model on the SAME provider, an
   * unrelated key entirely — is a cheap no-op: `splitTag` + a string compare, no network/keychain
   * touch). Returns `true` on an actual rebind, `false` on every no-op AND on a failed rebuild
   * (e.g. the new provider has no stored credential, or moved OUTSIDE `INTERNAL_PROVIDER_IDS`
   * entirely) — a failed rebuild never tears down the OLD backend; it keeps serving every caller,
   * logged once, exactly like a boot-time `createProvider` failure already is (see
   * `createProvider`'s own null-branch comment). Never throws: every failure mode this function can
   * hit is reported through the return value, because a throw here would reach
   * `settings-apply.ts`'s single-flight apply loop and (per that file's own F1 discipline) risks
   * wedging the NEXT hot-reload behind a retried rebuild of a provider that will never succeed.
   */
  refresh(nextSettings: Settings, secrets: SecretStore, settingsPath?: string): Promise<boolean>;
}

/**
 * Builds the boot-time `RebindableProvider` and its `refresh` closure. `null` under the exact same
 * condition `createProvider` itself answers `null` (a provider outside `INTERNAL_PROVIDER_IDS`) —
 * daemon.ts's existing "no internal Provider, log once, everything downstream goes inert" path is
 * unchanged for that case; `refresh` only ever matters once a REAL `RebindableProvider` exists to
 * call it on.
 */
export async function createRebindableProvider(settings: Settings, secrets: SecretStore, settingsPath?: string): Promise<RebindableProvider | null> {
  const active = await createProvider(settings, secrets, settingsPath);
  if (active === null) return null;
  const swappable = new SwappableProvider(active.provider);
  let boundProviderId = splitTag(settings.provider.model).providerId;
  const self: RebindableProvider = {
    provider: swappable,
    model: active.liveModel().model,
    live: active.liveModel,
    quota: active.quota,
    async refresh(nextSettings, nextSecrets, nextSettingsPath) {
      let nextProviderId: string;
      try {
        nextProviderId = splitTag(nextSettings.provider.model).providerId;
      } catch {
        return false; // malformed tag — Settings.parse would already have refused this file; never rebind on it
      }
      if (nextProviderId === boundProviderId) return false; // no provider-identity change — cheap no-op
      if (!(INTERNAL_PROVIDER_IDS as readonly string[]).includes(nextProviderId)) {
        // Moved OUTSIDE the internal-provider set entirely. There is nothing sane to rebind to —
        // daemon.ts's boot-time null path has no running backend to preserve, but this one does,
        // and "the daemon's own internal calls silently stop" is worse than "they keep running on
        // the last provider that actually worked". Logged once; the OLD backend is left in place.
        console.error(
          `provider: settings.provider.model now names "${nextProviderId}" — the daemon's internal provider only rebuilds for ${INTERNAL_PROVIDER_IDS.join("/")}, so titles, the bash reviewer, the dreamer, the session cleaner, research, and turn compaction stay on "${boundProviderId}" until it's set back to one of those`,
        );
        return false;
      }
      let nextActive: ActiveProvider | null;
      try {
        // The SAME `self.quota` instance every rebuild since boot — see `createProvider`'s
        // `existingQuota` param doc comment for why quota tracking is per-daemon, not
        // per-provider-instance.
        nextActive = await createProvider(nextSettings, nextSecrets, nextSettingsPath, self.quota);
      } catch (err) {
        // e.g. the new provider has no stored credential (`createProvider`'s openai branch throws
        // fail-fast). Logged once; the OLD backend — still bound inside `swappable` — keeps serving
        // every caller exactly as it did before this write.
        console.error(`provider: rebuilding the internal provider for "${nextProviderId}" failed (${(err as Error).message}) — staying on "${boundProviderId}"`);
        return false;
      }
      if (nextActive === null) return false; // guarded by the INTERNAL_PROVIDER_IDS check above; never reached in practice
      // THE SWAP. `swappable`'s own identity never changes — every existing holder of it (directly,
      // or through `self.provider`) sees this take effect on its very next call. An in-flight call
      // already dispatched to the OLD backend keeps running (see `SwappableProvider.streamTurn`'s
      // own doc comment) — nothing here waits for, cancels, or otherwise touches it.
      swappable.rebind(nextActive.provider);
      self.model = nextActive.liveModel().model;
      self.live = nextActive.liveModel;
      boundProviderId = nextProviderId;
      return true;
    },
  };
  return self;
}

/**
 * WS-20 (review round 1, GUARD): the daemon has exactly ONE internal-calls `Provider` instance
 * (`ActiveProvider`, above) — the dispatch pin, the dreamer, the session cleaner and the ephemeral
 * research sub-agent all wire THEIR turns through it, never a second one. Each of those callers
 * resolves its OWN model as a tag (`pinsFor(settings).<slot>`) and then splits it once at the
 * internal-Provider spawn boundary (`splitTag(pin).modelId`) to get the bare id that instance's
 * `streamTurn()` expects.
 *
 * That split alone is not enough: `pinsFor`'s per-slot default can name a DIFFERENT provider than
 * the one `settings.provider.model` actually bound the internal instance to (a user override in
 * `settings.pins.<slot>`, or a slot whose own default fallback rule picked a sibling provider —
 * `pinsFor`'s own doc comment). Splitting off the bare modelId and sending it to the WRONG
 * backend is silent: the internal Provider has no way to know the id it was handed came from a
 * different provider's vocabulary, and depending on the two providers' id conventions it may
 * simply 400, or — worse — resolve to an unrelated real model on the wrong service.
 *
 * `internalModelFor` is the one gate every caller of the internal Provider must pass through: it
 * returns the bare modelId ONLY when the pin's own provider matches the internal instance's, and
 * `undefined` (logging one line naming the pin's FIELD, e.g. `"pins.dream"` — never the tag itself,
 * which is not a secret either, but the field name is enough to diagnose without repeating the
 * daemon's provider config into the log on every mismatch) otherwise. Every caller skips its run
 * on `undefined` rather than guessing — the same "typed refusal over a silent wrong answer"
 * discipline as every RPC-facing door in this arc, applied to the daemon's own internal caller.
 *
 * Deliberately NOT a redesign of the internal-Provider abstraction (still exactly one instance,
 * still bare-id-only at its own boundary) — that is a follow-up if the mismatch turns out to
 * matter in practice; this is the guard that makes a mismatch loud instead of silent today.
 */
export function internalModelFor(pin: ModelTag, provider: { providerId: string }, fieldName: string): string | undefined {
  const { providerId, modelId } = splitTag(pin);
  if (providerId !== provider.providerId) {
    console.error(`${fieldName}: names provider "${providerId}", but the daemon's internal provider is "${provider.providerId}" — skipping this run rather than sending the model to the wrong backend`);
    return undefined;
  }
  return modelId;
}
