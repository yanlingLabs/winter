// Phase 9c (P9c-4, Task M Step 7) — the ONE fallback rule every Winter-named project reader
// (instructions file, `.winter/rules`, `.winter/output-styles`, the `.winter/settings.json` trust-
// gated overlay) applies identically: when the Winter-named path is absent, the LEGACY path exists,
// and `legacyProjectFilesReadEnabled(settings)` is on, read the legacy path instead — READ-ONLY,
// never written to by anything in this tree. Turning the flag off makes every legacy path invisible
// again, with no other behavior change.
import { existsSync } from "node:fs";
import { legacyProjectFilesReadEnabled, type Settings } from "../settings";

export { LEGACY_INSTRUCTIONS_FILE, LEGACY_PROJECT_DIR } from "../legacy-names";

/**
 * Resolves ONE Winter-named path against its legacy counterpart. Returns the Winter path unchanged
 * (even when it, too, is absent — callers already handle "nothing there" by their own existing
 * means) unless ALL THREE conditions hold: `winterPath` does not exist, `legacyPath` does, and the
 * flag is on — in which case it returns `legacyPath` with `usedLegacy: true`, the caller's cue to
 * fold `legacyPath` into whatever deprecation notice it surfaces.
 */
export function resolveLegacyProjectPath(winterPath: string, legacyPath: string, settings: Settings | null): { path: string; usedLegacy: boolean } {
  if (!existsSync(winterPath) && legacyProjectFilesReadEnabled(settings) && existsSync(legacyPath)) {
    return { path: legacyPath, usedLegacy: true };
  }
  return { path: winterPath, usedLegacy: false };
}

/** Same rule, for a DIRECTORY (`.winter/rules`, `.winter/output-styles`) rather than a single file —
 *  "absent" here means "does not exist as a directory at all"; an empty Winter-named directory
 *  still counts as present (never falls back), matching how a project can deliberately keep an
 *  empty `.winter/rules/` to suppress a legacy one. */
export function resolveLegacyProjectDir(winterDir: string, legacyDir: string, settings: Settings | null): { dir: string; usedLegacy: boolean } {
  const r = resolveLegacyProjectPath(winterDir, legacyDir, settings);
  return { dir: r.path, usedLegacy: r.usedLegacy };
}
