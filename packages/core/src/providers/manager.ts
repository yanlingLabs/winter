import { statSync } from "node:fs";
import type { SecretStore } from "../auth/secret-store";
import { readOpenAiApiKey } from "../auth/credential-material";
import { OPENAI_API_KEY_SECRET } from "../auth/legacy-secret-names";
import { loadSettings, providerBaseUrlFor, type Settings } from "../settings";
import type { Provider } from "./types";
import { createCodexOauthRuntimeProvider, createOpenAiCompatibleRuntimeProvider } from "./runtime-provider";
import { QuotaManager, withQuota } from "./quota";
import { splitTag } from "../runtime-sdk/model-tag";

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
 * — "codex-oauth" onto the Codex OAuth adapter, every other provider id (chiefly "openai", the
 * BYO-endpoint arm) onto the OpenAI-compatible adapter with `providerBaseUrlFor(settings, providerId)`
 * (`providers.<id>.baseUrl` — `settings.provider.baseUrl` itself no longer exists on `ProviderSettings`;
 * the v2→v3 migration copies it into `providers.openai.baseUrl` once, see settings.ts).
 */
export async function createProvider(settings: Settings, secrets: SecretStore, settingsPath?: string): Promise<ActiveProvider> {
  const quota = new QuotaManager();
  let inner: Provider;
  const providerId = splitTag(settings.provider.model).providerId;
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
