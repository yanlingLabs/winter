// P9b-6 — the LEGACY (pre-rename, "Norma") literals, kept in exactly ONE place so 9c's migrator
// (WS-16 §18) has a single import to reach for. This file is NEVER read by feature code: every
// current-brand name lives in `runtime-sdk/brand.ts` / `winter-dir.ts` / `profile.ts`, and nothing
// in this module may be used to resolve a live path, launchd label, or Keychain service. Its Swift
// twin is `apple/Winter/Sources/App/LegacyNames.swift`. Both files are on the codemod's exempt list
// and the residue test's allowlist, by path — this is the one place in `packages/` the old spellings
// may still appear.

/** The historical KeepAlive launchd agent label, from BEFORE profiles existed. `cli/src/launchd.ts`
 *  tears this one down on migration; it predates `com.winter.core[.dev]` entirely. 9c's migrator
 *  input. */
export const LEGACY_LAUNCHD_LABEL = "com.norma.core";

/** The pre-rename dist home directory name (`~/.norma`). 9c's migrator input (source side of the
 *  `~/.norma` → `~/.winter` move). */
export const LEGACY_HOME_DIR = ".norma";

/** The pre-rename dev home directory name (`~/.norma-dev`). 9c's migrator input. */
export const LEGACY_DEV_HOME_DIR = ".norma-dev";

/** The pre-rename home override env var. 9c's migrator input — read ONLY by the migrator, never by
 *  a live home resolver (`winter-dir.ts` reads `WINTER_HOME`, never this). */
export const LEGACY_HOME_ENV = "NORMA_HOME";

/** The pre-rename profile env var. 9c's migrator input — read ONLY by the migrator, never by a live
 *  profile resolver (`profile.ts` reads `WINTER_PROFILE`, never this). */
export const LEGACY_PROFILE_ENV = "NORMA_PROFILE";

/** The pre-rename CC-directory-parity tmpdir override env var. 9c's migrator input. */
export const LEGACY_TMPDIR_ENV = "NORMA_TMPDIR";

/** The pre-rename dist Keychain service. 9c's migrator input (a Keychain item COPY from a
 *  Norma-signed process, never a live daemon's own service — `profile.ts`'s `keychainService()`
 *  never returns this). */
export const LEGACY_KEYCHAIN_SERVICE = "com.norma.core";

/** The pre-rename dev Keychain service. 9c's migrator input. */
export const LEGACY_KEYCHAIN_SERVICE_DEV = "com.norma.core.dev";

/** The pre-rename dist CLI symlink path. 9c's migrator input (the retirement of this link, and of
 *  the wrapper below, is a 9c step — never touched here). Fix wave m3 ruling: the handoff retires
 *  this path ONLY when it is a symlink whose resolved target sits inside `/Applications/Norma.app`
 *  (or the running bundle's own path) — never a plain, user-owned file that happens to sit at this
 *  exact path (someone's own `norma` script, unrelated to this app). See
 *  `apple/Norma/Sources/App/Handoff.swift` (norma-final) for the actual teardown logic. */
export const LEGACY_CLI_LINK = "/usr/local/bin/norma";

/** The pre-rename global dev-wrapper names `removeLegacyDevWrapper` may remove, IFF the sibling's
 *  bytes prove it was our own wrapper (never by name alone). 9c's migrator input; `as const` so a
 *  consumer narrows to the literal pair rather than a bare `string[]`. */
export const LEGACY_DEV_WRAPPER_NAMES = ["norma", "norma-dev"] as const;

/** The pre-rename per-repo project config directory name (`.norma/`). 9c's migrator input for
 *  `winter migrate-project`. */
export const LEGACY_PROJECT_DIR = ".norma";

/** The pre-rename per-repo/user instructions file name (`NORMA.md`). 9c's migrator input for
 *  `winter migrate-project`; Global Constraints bullet 1 — there is deliberately NO legacy-read
 *  fallback for this file until 9c. */
export const LEGACY_INSTRUCTIONS_FILE = "NORMA.md";

/** The pre-rename `runtimes.winterExecutable` override env var (`NORMA_WINTER_EXECUTABLE`).
 *  Migration B's settings re-key input ONLY (`migration/rekey-settings.ts`) — never read by a live
 *  executable resolver (that ladder reads `WINTER_RUNTIME_EXECUTABLE`, never this). */
export const LEGACY_WINTER_EXECUTABLE_ENV = "NORMA_WINTER_EXECUTABLE";

/** The pre-rename `runtimes.claudeExecutable` override env var (`NORMA_CLAUDE_EXECUTABLE`).
 *  Migration B's settings re-key input ONLY — never read by a live resolver (that ladder reads
 *  `WINTER_CLAUDE_EXECUTABLE`, never this). */
export const LEGACY_CLAUDE_EXECUTABLE_ENV = "NORMA_CLAUDE_EXECUTABLE";

/** The pre-rename protocol Keychain service holding the daemon's own config-encryption key
 *  (P9c-14, the user's ruling: this service is PROTECTED and must never be migrated — a copied key
 *  would let a process presenting the new identity decrypt material sealed under the old one,
 *  collapsing a boundary the rename is supposed to preserve). Migration B's exclusion input only:
 *  `MIGRATION_B_SECRET_NAMES` never includes a name resolved through this service, and nothing in
 *  `migration/**` may construct a `SecretStore` bound to it. */
export const LEGACY_CONFIG_KEY_SERVICE = "com.norma.config-key";
