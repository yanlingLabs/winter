import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { realpathSync } from "node:fs";

/**
 * File-based memory (MEMDIR, T1) — project-key derivation + the per-project memory directory
 * path. Mirrors Claude Code's own model (design doc `2026-07-15-file-based-memory-design.md`):
 * one memory dir per git repo (worktrees resolve to the SAME dir as their main checkout), a plain
 * cwd when not a repo at all, and a settings override that replaces the computation entirely.
 *
 * Deliberately has NO knowledge of `Settings` (the zod type) — callers pass a plain `{ normaHome,
 * directory? }` bag, same "getter/plain-deps, not the settings shape" convention engine.ts's
 * EngineConfig getters already follow (e.g. `reviewerAllow: () => settings?.reviewer?.allow`).
 */

function canon(p: string): string {
  try { return realpathSync(p); } catch { return resolve(p); }
}

function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith(`~${sep}`)) return join(homedir(), p.slice(2));
  return p;
}

/** Cache: canonicalized cwd -> resolved repo root (or the cwd itself when not a repo).
 *
 * `roots()` (the write-fence) and the context assembler both resolve this on nearly EVERY tool
 * call / turn (see daemon.ts's `sessionDirs` and context.ts's `assemble()`) — spawning `git` that
 * often would be wasteful, and a session's cwd/repo membership does not change over a daemon's
 * running lifetime (a worktree enter/exit already re-adds/removes roots through its OWN explicit
 * `dirs.add`/`dirs.remove` calls, never through this path) — so the expensive part (the git
 * subprocess) is memoized here, keyed by the canonical cwd. Unbounded is fine: the daemon sees a
 * small, roughly-fixed set of distinct cwds over its lifetime (one per open project), never an
 * unbounded stream.
 */
const repoRootCache = new Map<string, string>();

/** Test-only escape hatch — a test that spins up throwaway repos at the SAME path across cases
 *  (or wants to assert the cache actually short-circuits a second git spawn) needs to reset this;
 *  production code never calls it. */
export function _clearRepoRootCacheForTests(): void {
  repoRootCache.clear();
}

/**
 * Resolves the git repo root a `cwd` belongs to. Worktree-aware: uses `--git-common-dir`, NOT
 * `--show-toplevel` — for a linked worktree, `--show-toplevel` returns the WORKTREE's own
 * directory (wrong: two worktrees of the same repo would get two different memory dirs), while
 * `--git-common-dir` returns the absolute path to the ONE shared `.git` dir both the main
 * checkout and every linked worktree point at; that path's parent is the main repo root in both
 * cases (verified empirically: from the main checkout it resolves to `<root>/.git` too, so
 * `dirname()` is correct either way, no special-casing needed). A non-repo `cwd` (git exits
 * nonzero, or the binary itself is unavailable) falls back to the cwd itself, matching the
 * design doc's "non-repo cwd → the cwd itself" bullet.
 */
export function repoRootFor(cwd: string): string {
  const key = canon(cwd);
  const cached = repoRootCache.get(key);
  if (cached !== undefined) return cached;

  let root = key;
  try {
    const p = Bun.spawnSync(["git", "-C", key, "rev-parse", "--git-common-dir"]);
    if (p.exitCode === 0) {
      const raw = p.stdout.toString("utf8").trim();
      if (raw) {
        const commonDir = canon(isAbsolute(raw) ? raw : resolve(key, raw));
        root = dirname(commonDir);
      }
    }
  } catch {
    // git unavailable (ENOENT spawning it, etc.) — non-repo fallback, same as a nonzero exit.
  }
  repoRootCache.set(key, root);
  return root;
}

/** Turns an absolute path into a single filesystem-safe directory-name segment: strip the
 *  leading separator, then replace every remaining separator with `-` (mirrors Claude Code's own
 *  `~/.claude/projects/-Users-name-project` convention). A bare filesystem root (`/`) — no
 *  segments left after stripping — falls back to the literal "root" rather than an empty string,
 *  which `join()` would otherwise silently collapse away. */
export function sanitizeProjectKey(absPath: string): string {
  const stripped = absPath.startsWith(sep) ? absPath.slice(1) : absPath;
  const key = stripped.split(sep).join("-");
  return key.length > 0 ? key : "root";
}

export interface MemoryDirOptions {
  normaHome: string;
  /** `settings.memory.directory` — an absolute or `~/`-relative override that REPLACES the
   *  computed `~/.norma/projects/<key>/memory` path entirely (CC's own "relocatable directory"
   *  setting) — no further per-project nesting under it. Empty/whitespace-only is treated as
   *  absent (a settings.json with `"directory": ""` must not resolve to `normaHome` itself). */
  directory?: string;
}

/** Shared override-resolution: `memoryDirFor` and `globalMemoryDirFor` both replace their
 *  computed path ENTIRELY with `opts.directory` when set (CC's one relocatable-directory setting
 *  applies to whichever bucket a caller asked for — there's no separate "global override"). Null
 *  means "no override configured", not "empty string" (see `MemoryDirOptions.directory`'s own
 *  doc comment on whitespace-only treated as absent). */
function resolveOverride(opts: MemoryDirOptions): string | null {
  if (opts.directory && opts.directory.trim()) return canon(expandTilde(opts.directory.trim()));
  return null;
}

/**
 * The per-project memory directory for a session's `cwd` — pure path computation, no I/O beyond
 * `repoRootFor`'s memoized git spawn (specifically: does NOT create the directory; callers that
 * need it to exist do so lazily at the point they actually use it, same "create on demand, not at
 * boot" precedent as `session-tmp.ts`'s `sessionTmpDir`).
 */
export function memoryDirFor(cwd: string, opts: MemoryDirOptions): string {
  const override = resolveOverride(opts);
  if (override) return override;
  const key = sanitizeProjectKey(repoRootFor(cwd));
  return join(opts.normaHome, "projects", key, "memory");
}

/**
 * The "no project" bucket (T2, design doc's "facts that don't map to a project → a sensible
 * default location"): `~/.norma/projects/_global/memory`, the SAME `projects/<key>/memory` shape
 * `memoryDirFor` uses, with a reserved key (`_global`) `sanitizeProjectKey` can never itself
 * produce (its output always starts with a sanitized absolute-path segment, never `_`) — so this
 * can't collide with any real project's directory. Two consumers share it: T2's migration
 * importer (legacy USER-scope facts, which were never tied to a repo, land here) and the
 * memory.* RPC rewire (ipc/server.ts) when a caller passes no `cwd` (the CLI's `scope:"user"`,
 * no `--project`, never did) — so a fact migrated here is immediately visible to `norma memory
 * list` with no flags, no coincidence.
 */
export function globalMemoryDirFor(opts: MemoryDirOptions): string {
  const override = resolveOverride(opts);
  if (override) return override;
  return join(opts.normaHome, "projects", "_global", "memory");
}

/** Dreaming (Phase 7b): the shared assistant-memory bucket — `~/.norma/projects/_assistant/memory`.
 *  Reserved key like `_global` (sanitizeProjectKey can never emit a leading underscore). Loaded
 *  ONLY by assistant-mode sessions (dispatch now; chat/cowork later) via ContextAssembler's
 *  memoryBucket branch — never by cwd resolution, so code sessions structurally cannot see it.
 *  DELIBERATELY ignores the `memory.directory` relocation override: honoring it would collapse
 *  this bucket into the project bucket and leak dream memories into code sessions. */
export function assistantMemoryDirFor(opts: { normaHome: string }): string {
  return join(opts.normaHome, "projects", "_assistant", "memory");
}
