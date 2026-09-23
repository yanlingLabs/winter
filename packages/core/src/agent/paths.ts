import { realpathSync, lstatSync, readlinkSync } from "node:fs";
import { isAbsolute, resolve, sep, dirname, basename, join } from "node:path";
import { linkedRouterSupportsRunHome } from "../runtime-sdk/run-home-support";

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
  return join(homeCacheDir(winterHome), "skill-plugins");
}

/**
 * `<home>/cache` — today used ONLY by the skill views above, and write-fenced WHOLE on both legs
 * (re-review M-a: fencing just the views left the directories above them swappable for links).
 * Because a user may deliberately make it a link (a cache on another volume), the daemon never
 * unlinks it — a spawn that finds it a link gets no plugin skills (`agent/skills.ts`).
 */
export function homeCacheDir(winterHome: string): string {
  return join(winterHome, "cache");
}

/**
 * The directory holding the daemon's OWN record of per-project rules the user approved from a card
 * (`agent/approved-project-rules.ts`) — `<home>/permissions`. A leaf helper for the same reason as
 * `skillPluginViewsRoot`: the store writes it and `runtime-sdk/mode-options.ts` write-fences it.
 */
export function approvedProjectRulesDir(winterHome: string): string {
  return join(winterHome, "permissions");
}

/**
 * The trust record (`TrustStore`) — `<home>/trust.json`. A leaf helper for the same reason: the
 * daemon builds the store on it and `runtime-sdk/mode-options.ts` write-fences it (writing it trusts
 * any project).
 */
export function trustRecordFile(winterHome: string): string {
  return join(winterHome, "trust.json");
}

// ── WS-21: the shared runtime home (`<home>/sdk`) ─────────────────────────────────────────────────
//
// `<home>` stays the daemon's own home (Winter's settings, event log, trust, runtime-state). The
// runtime-facing files — the transcript store, skills, agents, plugins, the claude-format settings and
// global config — live one level down, in `<home>/sdk`, in claude's formats, and BOTH runtimes read
// them there (through the router's per-run folder once the router applies run homes).
//
// CONVENTION: every helper below, and every path function that reaches a runtime-facing directory
// (`memoryDirFor`, `winterSessions`, `loadUserAgentDefinitions`, …), takes the DAEMON home and applies
// `sdkHomeFor`/`storeHomeFor` itself. No caller computes either home by hand, so there is exactly one
// spelling of each.

/** `<home>/sdk` — the shared runtime home. Mirrors the router's own `sdkHomeOf(home)` (Contract A). */
export function sdkHomeFor(home: string): string {
  return join(home, "sdk");
}

/** `<home>/sdk/settings.json` — claude `Settings` (claude keys only; spec §2.2). */
export function sdkSettingsPath(home: string): string {
  return join(sdkHomeFor(home), "settings.json");
}

/** `<home>/sdk/.winter.json` — claude's `.claude.json` shape: user `mcpServers` and
 *  `projects[<abs root>].mcpServers` (local scope). Spec §2.2. */
export function sdkGlobalConfigPath(home: string): string {
  return join(sdkHomeFor(home), ".winter.json");
}

/** `<home>/sdk/plugins` — claude's plugins root (install records, marketplaces, `cache/`, …; F15). */
export function sdkPluginsRoot(home: string): string {
  return join(sdkHomeFor(home), "plugins");
}

/**
 * **Where this build's runtime-facing directories live** — the transcript store and its per-project
 * memory (`projects/`), and the user tiers of `skills/`, `agents/` and `workflows/`:
 *
 *  - `<home>/sdk` once the linked router applies run homes (the integrated WS-21 build);
 *  - `<home>` itself otherwise — exactly today's layout, because an agent SDK 0.0.20 child and router
 *    0.0.11 write and scan there, and their stores refuse a symlinked `projects/` level
 *    (`runtime-sdk/run-home-support.ts` has the full reasoning).
 *
 * Every path helper that reaches one of those directories takes the DAEMON home and applies this
 * itself, so no call site can pick the wrong layout. Migration C moves the directories only on a
 * build where this answers `sdk/`, so the reads and the data always agree.
 */
export function storeHomeFor(home: string): string {
  return linkedRouterSupportsRunHome() ? sdkHomeFor(home) : home;
}

/** `<store home>/projects` — the canonical transcript store (and per-project memory). */
export function storeProjectsDir(home: string): string {
  return join(storeHomeFor(home), "projects");
}

/**
 * claude's persistent config-dir set (F18), pre-created in `sdk/` so every run folder can link it.
 * The same list, in the same order, as the router's `RUN_HOME_PERSISTENT_ENTRIES` (Contract A).
 */
export const SDK_PERSISTENT_ENTRIES = ["file-history", "tasks", "teams", "agent-memory", "workflows"] as const;

/**
 * The directories Migration C moves into `sdk/` and the compatibility links it leaves at their OLD
 * top-level paths (spec §2.1, §8 step 3), as `[old top-level name, link text relative to <home>]`.
 * RELATIVE link text on purpose: the home can be moved or copied as a unit.
 *
 * NEVER planted by `bootstrapWinterDir`: the agent SDK's store refuses a symlink at `<store>/projects`
 * on every append (`ensureSecureDir`), so a link there is only safe once nothing writes the old path.
 */
export const SDK_COMPAT_LINKS: ReadonlyArray<readonly [name: string, target: string]> = [
  ["projects", "sdk/projects"],
  ["backups", "sdk/file-history"],
  ["skills", "sdk/skills"],
  ["agents", "sdk/agents"],
  ["workflows", "sdk/workflows"],
];

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
