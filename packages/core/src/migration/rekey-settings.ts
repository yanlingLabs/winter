// Phase 9c Migration B / `winter migrate-project` (P9b-8's explicit map, replayed on settings
// VALUES): a legacy `settings.json` (the daemon's own, or a project's legacy-project-dir one — see
// `legacy-names.ts`'s `LEGACY_PROJECT_DIR`) may carry the pre-rename env-var names or legacy home
// directory path segments (`LEGACY_HOME_DIR`/`LEGACY_DEV_HOME_DIR`) inside plain STRING values
// (e.g. `runtimes.winterExecutable` naming the legacy override env var by a leading `$`, or a
// hand-written absolute path under the old home). Keys are NEVER renamed — the schema is unchanged
// across the rename, so a settings.json's shape survives verbatim; only the legacy spellings living
// inside its string values are rewritten.
import { LEGACY_CLAUDE_EXECUTABLE_ENV, LEGACY_DEV_HOME_DIR, LEGACY_HOME_DIR, LEGACY_HOME_ENV, LEGACY_PROFILE_ENV, LEGACY_TMPDIR_ENV, LEGACY_WINTER_EXECUTABLE_ENV } from "../legacy-names";

/** The P9b-8 whole-token env-var map, verbatim (global-constraints.md, Task M Step 5). */
const ENV_TOKEN_MAP: readonly (readonly [string, string])[] = [
  [LEGACY_HOME_ENV, "WINTER_HOME"],
  [LEGACY_PROFILE_ENV, "WINTER_PROFILE"],
  [LEGACY_TMPDIR_ENV, "WINTER_TMPDIR"],
  [LEGACY_WINTER_EXECUTABLE_ENV, "WINTER_RUNTIME_EXECUTABLE"],
  [LEGACY_CLAUDE_EXECUTABLE_ENV, "WINTER_CLAUDE_EXECUTABLE"],
];

/** The path-segment map (`LEGACY_DEV_HOME_DIR` → `.winter-dev`, `LEGACY_HOME_DIR` → `.winter`,
 *  each as a whole path segment — global-constraints.md, Task M Step 5, verbatim). `LEGACY_HOME_DIR`
 *  is a strict prefix of `LEGACY_DEV_HOME_DIR` (one dotfile name plus a `-dev` suffix), but
 *  `replacePathSegment`'s trailing lookahead (`/` or end-of-string right after the legacy spelling)
 *  already refuses to match the shorter name inside the longer one — the next character there is
 *  `-`, not a segment boundary — so listing the dev variant first is a readability choice, not a
 *  correctness requirement; either order produces the same result. */
const PATH_TOKEN_MAP: readonly (readonly [string, string])[] = [
  [LEGACY_DEV_HOME_DIR, ".winter-dev"],
  [LEGACY_HOME_DIR, ".winter"],
];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whole-token replace: `from` must sit on identifier boundaries (no `[A-Za-z0-9_]` touching either
 *  side) — matches the codemod's own env-var-rename convention, so a `$`-prefixed shell reference to
 *  the legacy env var and the bare name both rewrite, but a substring inside a longer identifier
 *  never does. */
function replaceToken(s: string, from: string, to: string): string {
  const re = new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(from)}(?![A-Za-z0-9_])`, "g");
  return s.replace(re, to);
}

/** Path-segment replace: `legacy` (a legacy home dotfile name) is rewritten only where it forms a
 *  whole path segment — preceded by the start of the string, `/`, or `~`, and followed by `/` or the
 *  end of the string. This is a superset of the brief's literal `/…/`-bounded patterns (it also
 *  catches the no-trailing-slash case, e.g. a bare tilde-relative reference naming the legacy home
 *  itself) without ever matching a mid-segment substring. */
function replacePathSegment(s: string, legacy: string, winter: string): string {
  const re = new RegExp(`(^|[/~])${escapeRegExp(legacy)}(?=\\/|$)`, "g");
  return s.replace(re, (_m, boundary: string) => `${boundary}${winter}`);
}

function rekeyString(value: string): string {
  let out = value;
  for (const [from, to] of ENV_TOKEN_MAP) out = replaceToken(out, from, to);
  for (const [legacy, winter] of PATH_TOKEN_MAP) out = replacePathSegment(out, legacy, winter);
  return out;
}

export interface RekeyChange {
  /** Dot/bracket path into the object, e.g. `runtimes.winterExecutable` or `permissions.allow[2]`. Root scalar is `""`. */
  path: string;
  from: string;
  to: string;
}

export interface RekeyResult {
  out: unknown;
  changes: RekeyChange[];
}

const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Walks a parsed settings JSON value, rewriting every STRING it finds through `rekeyString`; object
 * keys, numbers, booleans and null pass through unchanged. Returns a fresh value (never mutates
 * `json`) plus the list of every value actually changed, for `--status`-style reporting and for the
 * no-op round-trip test (`rekeySettings(rekeySettings(x).out).changes` must be empty).
 */
export function rekeySettings(json: unknown): RekeyResult {
  const changes: RekeyChange[] = [];

  function walk(value: unknown, path: string): unknown {
    if (typeof value === "string") {
      const rekeyed = rekeyString(value);
      if (rekeyed !== value) changes.push({ path, from: value, to: rekeyed });
      return rekeyed;
    }
    if (Array.isArray(value)) return value.map((v, i) => walk(v, `${path}[${i}]`));
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (DANGEROUS_KEYS.has(k)) continue; // never traverse into these, same guard as project-settings.ts
        out[k] = walk(v, path ? `${path}.${k}` : k);
      }
      return out;
    }
    return value; // number | boolean | null | undefined
  }

  return { out: walk(json, ""), changes };
}
