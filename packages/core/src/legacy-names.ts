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
 *  the wrapper below, is a 9c step — never touched here). */
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
