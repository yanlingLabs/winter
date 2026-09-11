/**
 * LEGACY raw provider-credential secret names (hotfix review r1, m1).
 *
 * A LEAF module on purpose: `auth/credential-material.ts` needs these names for its one-way
 * migration (`migrateLegacyCredentialMaterial`) and its read-only fallbacks, while
 * `providers/manager.ts` and `providers/codex-oauth.ts` need `auth/credential-material.ts`'s
 * writers/readers — putting the names in either provider file would make that a real import
 * cycle. This file imports nothing from `providers/*`, so `auth/credential-material.ts` can import
 * it without one.
 *
 * `providers/manager.ts` and `providers/codex-oauth.ts` re-export these verbatim so every existing
 * importer (`runtime-sdk/keychain.ts`, `ipc/server.ts`, `cli/main.ts`, tests, `index.ts`) keeps
 * working unchanged — this file is an implementation detail, not a new public import path.
 *
 * These are migration-source / `norma logout`-blank-target ONLY now. Nothing writes them going
 * forward except `logout`'s blank; nothing reads them except the migration and the read-only
 * fallbacks in `CodexAuthStore.load()` / `readOpenAiApiKey`.
 */

/** The `openai-compatible` provider type's legacy raw API key record. */
export const OPENAI_API_KEY_SECRET = "openai-api-key";

/** The legacy raw Codex OAuth token-set records (access token + its four bookkeeping siblings). */
export const CODEX_SECRET_NAMES = {
  access: "codex-access-token",
  refresh: "codex-refresh-token",
  id: "codex-id-token",
  account: "codex-account-id",
  expires: "codex-expires-at",
} as const;
