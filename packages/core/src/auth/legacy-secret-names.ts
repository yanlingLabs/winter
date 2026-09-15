/**
 * LEGACY raw provider-credential secret names (hotfix review r1, m1).
 *
 * A LEAF module on purpose: `auth/credential-material.ts` needs these names for its one-way
 * migration (`migrateLegacyCredentialMaterial`), its read-only fallbacks, and (Phase 8d task 2.4,
 * since the class relocated there from the now-deleted `providers/codex-oauth.ts`) `CodexAuthStore` — while
 * `providers/manager.ts` needs `auth/credential-material.ts`'s writers/readers — putting the names
 * in `manager.ts` would make that a real import cycle. This file imports nothing from
 * `providers/*`, so `auth/credential-material.ts` can import it without one.
 *
 * `providers/manager.ts` and `auth/credential-material.ts` re-export these verbatim so every
 * existing importer (`runtime-sdk/keychain.ts`, `ipc/server.ts`, `cli/main.ts`, tests, `index.ts`)
 * keeps working unchanged — this file is an implementation detail, not a new public import path.
 *
 * These are migration-source / `winter logout`-blank-target ONLY now. Nothing writes them going
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

/**
 * Phase 9c Migration B (P9c-14): every Keychain secret name the migrator copies from the LEGACY
 * service to the CURRENT one, by known name — `SecretStore` has no enumeration, so this is the
 * complete inventory `migration/migrate-b.ts` walks. Verbatim COPIES of the literals declared
 * canonically elsewhere (`CREDENTIAL_MATERIAL_NAMES` / `ANTHROPIC_CREDENTIAL_SECRET_NAME` /
 * `ANTHROPIC_CONSOLE_CREDENTIAL_SECRET_NAME` — the
 * material records; `TOKEN_NAMES` — the remote/harness/admin tokens; `OPENAI_API_KEY_SECRET` +
 * `CODEX_SECRET_NAMES` above — the pre-material raw records; `WEB_SEARCH_API_KEY_SECRET` +
 * `EXA_API_KEY_SECRET` — the two tool keys), repeated as string literals rather than imported so
 * this LEAF module's import graph stays exactly as narrow as the file header above requires. A
 * name drifting in exactly one of those modules without a matching edit here is caught by
 * `migration/migrate-b.test.ts`'s own literal-parity assertion, not by a shared import.
 *
 * `LEGACY_CONFIG_KEY_SERVICE` (`legacy-names.ts`) names a whole SERVICE, not an item in this list —
 * it is deliberately never read here: P9c-14 protects it from migration entirely.
 */
export const MIGRATION_B_SECRET_NAMES: readonly string[] = [
  "openai:default",
  "codex-oauth:default",
  "anthropic:default",
  // WS-19 (W19-9): the Console broker's OWN bearer account (`anthropic:console`,
  // `runtime-sdk/keychain.ts`'s `ANTHROPIC_CONSOLE_CREDENTIAL_SECRET_NAME`). It shipped in Phase
  // 10a, AFTER this list was written, and was simply never added — so a migrated home silently lost
  // its Console sign-in and had to re-run `winter login --anthropic-console`.
  "anthropic:console",
  "harness-token",
  "admin-token",
  "remote-token",
  "openai-api-key",
  "codex-access-token",
  "codex-refresh-token",
  "codex-id-token",
  "codex-account-id",
  "codex-expires-at",
  "web-search-api-key",
  "exa-api-key",
] as const;
