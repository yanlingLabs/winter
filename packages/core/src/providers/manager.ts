import { statSync } from "node:fs";
import type { SecretStore } from "../auth/secret-store";
import { readOpenAiApiKey } from "../auth/credential-material";
import { loadSettings, type Settings } from "../settings";
import type { Provider } from "./types";
import { OpenAICompatibleProvider } from "./openai-compatible";
import { CodexAuthStore, CodexOAuthProvider } from "./codex-oauth";
import { QuotaManager, withQuota } from "./quota";
import { CODEX_MODELS, DEFAULT_CODEX_MODEL } from "./codex-config";

/** LEGACY raw record — migration source only (`auth/credential-material.ts`'s
 *  `readOpenAiApiKey`/`migrateLegacyCredentialMaterial`). Writers use `writeOpenAiApiKey`, which
 *  writes ONLY the `openai:default` JSON material record the spawned Winter child reads. */
export const OPENAI_API_KEY_SECRET = "openai-api-key";

/** What a turn actually resolves to: the model slug plus an optional reasoning-effort hint. */
export interface LiveModelSelection {
  model: string;
  reasoningEffort?: string;
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
   * Deprecation fallback (codex-oauth only): a configured model not in CODEX_MODELS (e.g. a
   * since-deprecated slug like "gpt-5.4") silently resolves to DEFAULT_CODEX_MODEL, logging ONE
   * console.error per distinct deprecated slug (not per turn). openai-compatible has no
   * allowlist — arbitrary API models are legitimate there, so its configured model always passes
   * through untouched. The provider TYPE itself is fixed at the boot-time value (`providerType`,
   * closed over below) — a settings.json edited to a DIFFERENT provider.type still needs a
   * daemon restart to take effect (out of scope here), so this resolver deliberately ignores any
   * live-read `type` field and only ever branches on the type this Provider instance was actually
   * constructed for.
   */
  liveModel: () => LiveModelSelection;
}

function statMtimeOrZero(path: string): number {
  try { return statSync(path).mtimeMs; } catch { return 0; } // missing file -> key 0
}

/** Resolves the (model, reasoningEffort) pair for one already-loaded Settings, applying the
 *  codex-oauth deprecated-slug fallback (warn once per distinct slug via `warnedSlugs`).
 *  `providerType` is always the BOOT-time type (see liveModel's doc comment) — never re-derived
 *  from the freshly re-read `settings`. */
function resolveSelection(
  providerType: Settings["provider"]["type"],
  settings: Settings,
  warnedSlugs: Set<string>,
): LiveModelSelection {
  const { model, reasoningEffort } = settings.provider;
  if (providerType !== "codex-oauth") {
    return { model, ...(reasoningEffort ? { reasoningEffort } : {}) };
  }
  if (CODEX_MODELS.some((m) => m.id === model)) {
    return { model, ...(reasoningEffort ? { reasoningEffort } : {}) };
  }
  if (!warnedSlugs.has(model)) {
    warnedSlugs.add(model);
    console.error(`model "${model}" is deprecated/unavailable for codex-oauth — falling back to ${DEFAULT_CODEX_MODEL}`);
  }
  return { model: DEFAULT_CODEX_MODEL, ...(reasoningEffort ? { reasoningEffort } : {}) };
}

/** Builds the `liveModel` resolver for `createProvider`. `settingsPath` is optional — omitted
 *  (e.g. tests, `norma provider-smoke`) means the resolver just keeps returning the boot-time
 *  selection forever (no re-read possible without a path). */
function buildLiveModelResolver(
  providerType: Settings["provider"]["type"],
  bootSettings: Settings,
  settingsPath: string | undefined,
): () => LiveModelSelection {
  const warnedSlugs = new Set<string>();
  let lastGood = resolveSelection(providerType, bootSettings, warnedSlugs);
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
    const value = resolveSelection(providerType, settings, warnedSlugs);
    cache = { key, value };
    lastGood = value;
    return value;
  };
}

/**
 * `settingsPath` (optional) enables the returned `liveModel()` resolver to re-read settings.json
 * on each call instead of only ever reflecting this boot-time snapshot — omit it (as
 * `provider-smoke` and most tests do) and `liveModel()` just keeps returning the boot selection.
 */
export async function createProvider(settings: Settings, secrets: SecretStore, settingsPath?: string): Promise<ActiveProvider> {
  const quota = new QuotaManager();
  let inner: Provider;
  const providerType = settings.provider.type;
  if (providerType === "codex-oauth") {
    inner = new CodexOAuthProvider({ authStore: new CodexAuthStore(secrets) });
  } else {
    const apiKey = await readOpenAiApiKey(secrets);
    if (!apiKey) throw new Error("no API key stored — run: norma login --api-key");
    inner = new OpenAICompatibleProvider({ baseUrl: settings.provider.baseUrl, apiKey });
  }
  const liveModel = buildLiveModelResolver(providerType, settings, settingsPath);
  return { provider: withQuota(inner, quota), model: settings.provider.model, quota, liveModel };
}
