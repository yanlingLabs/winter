import { realpathSync, lstatSync, readlinkSync } from "node:fs";
import { isAbsolute, resolve, sep, dirname, basename, join } from "node:path";

/**
 * Where the daemon keeps the SKILLS-ONLY plugin views it hands a Winter child
 * (`SkillStore.childSkillSurface`): `<home>/cache/skill-plugins/<plugin>/skills` → the plugin's own
 * skills directory. Here, in this leaf module, because two owners must agree on it without importing
 * each other: `agent/skills.ts` builds the views and `runtime-sdk/mode-options.ts` write-fences them.
 *
 * `cache/` because the location has to be READABLE by the session — a skill points at its own
 * supporting files by path, and `<home>/run`/`<home>/runtimes` are denied to Read/Glob/Grep and to the
 * Bash sandbox on both legs — and DISPOSABLE: the views are rebuilt before every spawn, and Migration B
 * skips `cache/**` (`migration/migrate-b.ts`).
 */
export function skillPluginViewsRoot(winterHome: string): string {
  return join(winterHome, "cache", "skill-plugins");
}

// Symlink chains longer than this are rejected outright (mirrors the kernel's own ELOOP guard,
// just tighter). Also breaks link CYCLES (a→b→a never terminates otherwise): lstat on a cycle
// member succeeds every hop (lstat never follows the final link), so only this cap stops it.
const MAX_LINK_DEPTH = 8;

/** Resolve the LEAF of `target` through any symlink chain (lstat/readlink, relative link text
 *  resolved against the link's own directory), returning the final non-link path — which may not
 *  exist (a DANGLING link's target). Non-links and entirely nonexistent paths return unchanged.
 *
 *  Exists to close a fence hole (task-24 review F4): `canonAncestor` below realpaths the deepest
 *  EXISTING path — but a dangling symlink's leaf makes `realpathSync(target)` throw ENOENT, so the
 *  walk retreated to the link's PARENT directory and never saw where the link actually points. An
 *  in-root dangling symlink aimed at a nonexistent file in an existing OUTSIDE directory therefore
 *  passed containment, and the subsequent write followed the link and landed outside every root —
 *  a reviewer-less, card-less escape. Resolving the leaf's link text FIRST (this function), then
 *  canonAncestor-ing the RESULT, makes containment judge the real destination. Chain-capped at
 *  MAX_LINK_DEPTH (throws — fail-closed; callers treat it like any other fence rejection). */
export function resolveLeafSymlinks(target: string, depth = 0): string {
  if (depth >= MAX_LINK_DEPTH) throw new Error(`too many levels of symbolic links: ${target}`);
  let st;
  try { st = lstatSync(target); } catch { return target; } // nothing on disk at all — no link to follow
  if (!st.isSymbolicLink()) return target;
  const linkText = readlinkSync(target);
  const next = isAbsolute(linkText) ? resolve(linkText) : resolve(dirname(target), linkText);
  return resolveLeafSymlinks(next, depth + 1);
}

/** Symlink-hardened: realpath of `target` itself if it exists, else of its deepest existing
 *  ancestor (walking up dirname). Exported for fs-read.ts's denylist check, which needs the exact
 *  same "what real directory does this path's existing part actually live in" answer that
 *  resolveWithinAny's own containment check below relies on — a symlink can't be used to hide a
 *  path from either. */
export function canonAncestor(target: string): string {
  let probe = target;
  while (true) {
    try { return realpathSync(probe); }
    catch { const parent = dirname(probe); if (parent === probe) return probe; probe = parent; }
  }
}

/**
 * Resolve `p` (relative → roots[0]) and verify it stays within ANY root.
 * Symlink-hardened: the deepest existing ancestor is realpathed before the
 * containment check. Throws on escape.
 *
 * Per-root resilient: a root whose `realpathSync` throws (vanished/renamed —
 * e.g. a worktree dir removed by `exit_worktree {remove}` that still lingers
 * in SessionDirectories' `added` set) is SKIPPED rather than fatal, so one
 * stale root can never brick resolution against the other, still-valid
 * roots. Mirrors the try/catch tolerance in dirs.ts's `canon`/`roots`.
 *
 * Leaf-link hardened (task-24 review F4): the target's LEAF is resolved through any symlink chain
 * (resolveLeafSymlinks above) BEFORE the canonAncestor containment probe, so a dangling in-root
 * symlink pointing outside every root is REJECTED — previously the ENOENT fallback walked to the
 * link's parent (in-root) and the write escaped through the link. A dangling in-root link to an
 * in-root target still resolves fine (the resolved leaf is in-root), and non-dangling links were
 * already covered by realpath. The RETURN value stays the caller's literal `target` (not the link
 * destination) — unchanged contract; the write then flows through the link to the destination
 * containment just vetted.
 */
export function resolveWithinAny(roots: string[], p: string): string {
  if (roots.length === 0) throw new Error("no allowed directories configured");
  const reals: string[] = [];
  for (const r of roots) {
    try { reals.push(realpathSync(r)); }
    catch { /* vanished/renamed root — skip, don't let it break resolution against the others */ }
  }
  if (reals.length === 0) throw new Error(`path is outside the allowed directories: ${p}`);
  const target = isAbsolute(p) ? resolve(p) : resolve(reals[0]!, p);
  const probe = canonAncestor(resolveLeafSymlinks(target));
  for (const root of reals) {
    if (probe === root || probe.startsWith(root + sep)) return target;
  }
  throw new Error(`path is outside the allowed directories: ${p}`);
}

/** Single-root convenience wrapper (unchanged behavior for existing callers). */
export function resolveWithin(root: string, p: string): string {
  return resolveWithinAny([root], p);
}

/** True if `child` is `parent` or a descendant of it (both realpath-canonicalized; falls back to raw on error). */
export function isWithin(child: string, parent: string): boolean {
  const canon = (p: string) => { try { return realpathSync(p); } catch { return p; } };
  const c = canon(child), t = canon(parent);
  return c === t || c.startsWith(t + sep);
}

/** Canonical location of a possibly-NOT-YET-EXISTING write target: realpath the deepest existing
 *  ancestor (same walk as canonAncestor above — resolves any symlinked directory on the way),
 *  then re-append the missing tail verbatim. Exists because neither existing primitive can answer
 *  "where would a write to `p` actually land": a bare `realpathSync(p)` THROWS on a missing file,
 *  and `isWithin`'s raw-text fallback then keeps the PRE-symlink spelling — which let a new file
 *  written through an in-cwd symlink into an added root classify as "within cwd" and skip the fs
 *  safety review (5e T3 review finding). Read-only: never creates anything on disk. */
export function canonicalizeForWrite(p: string): string {
  const target = resolve(p);
  let probe = target;
  const missing: string[] = [];
  while (true) {
    try {
      const real = realpathSync(probe);
      return missing.length ? join(real, ...missing.reverse()) : real;
    } catch {
      const parent = dirname(probe);
      if (parent === probe) return target; // nothing on the path exists at all — raw is all there is
      missing.push(basename(probe));
      probe = parent;
    }
  }
}
