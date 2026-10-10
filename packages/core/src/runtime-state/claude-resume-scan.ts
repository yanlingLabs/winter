// The one place the daemon is allowed to LIST the per-user temp directory (`os.tmpdir()`), and the
// marker that makes it do so only once per home.
//
// WHY THIS EXISTS (2026-10-10). Both boot paths that looked for stale `claude-resume-*` staging roots —
// recovery step 8's sweep (`recovery.ts`, a router without run homes) and the late reconcile pass
// (`root-recovery.ts`, every real daemon) — did `readdirSync(os.tmpdir())` on EVERY boot. On a developer
// machine whose temp folder had grown to ~878,000 entries that single call took ~6.4 s of the user's real
// daemon boot, to find directories nothing has created since the official leg was retired (WS-23).
//
// THE RULE NOW:
//   - the FULL listing runs at most once per (home, scan root): when it has finished — or its budget ran
//     out — `<home>/migration/claude-resume-scan.json` records the root, and no later boot lists it again;
//   - what the listing found and could not deal with YET (a root a live generation still names, one younger
//     than the 24 h stale rule, a reconcile that threw, a directory that would not remove) is recorded as
//     `pending` PATHS and re-checked by path on later boots, with no listing — so the stale rule, the
//     `known` protection and the quarantine keep exactly their meaning;
//   - a staging root a directory row of THIS home names (`configDir`, a crashed official resume's) never
//     needs a listing either: `root-recovery.ts` takes it by path;
//   - the listing is BOUNDED (`CLAUDE_RESUME_SCAN_BUDGET_MS` / `CLAUDE_RESUME_SCAN_MAX_ENTRIES`): a temp
//     folder that cannot be listed in that time is recorded as incompletely scanned and left alone — a
//     leaked staging directory that survives it is a disk leak, never a boot stall, and nothing creates
//     one any more;
//   - it reads names and entry types only: nothing under the temp root is opened.
//
// WHY IT STAYS ON THE BOOT PATH THE FIRST TIME. The staging pass is ordered BEFORE any session opens and
// before Migration C's phase 2 re-key (`daemon.ts`, "ORDERING CONTRACT"): a `canonical-ahead` verdict is
// only safe while no live session owns the key, and a staging copy reconciled after the re-key is appended
// into an orphan. So the one-time listing is bounded and recorded, not moved behind the socket.
//
// This module deliberately imports nothing from `recovery.ts`/`root-recovery.ts` (both import IT).
import { existsSync, mkdirSync, opendirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** WS-16 §10's own literal — repeated (not imported) in `runtime-sdk/mode-options.ts`'s
 *  `controlPlaneDenyRules`, which names this constant right back. */
export const CLAUDE_RESUME_PREFIX = "claude-resume-";

/** A resume genuinely in flight is never this old — every drain/timeout window the router or the
 *  official leg itself imposes is far shorter. Anything past this age under the staging root is
 *  leaked, not live. */
export const CLAUDE_RESUME_STALE_MS = 24 * 60 * 60 * 1000;

/** Wall-clock budget of the one-time listing. A cold 878k-entry temp folder took ~6.4 s; the listing
 *  stops here and the marker says it was cut short. */
export const CLAUDE_RESUME_SCAN_BUDGET_MS = 3_000;

/** Hard cap on directory entries read by the one-time listing (a runaway folder, a slow filesystem). */
export const CLAUDE_RESUME_SCAN_MAX_ENTRIES = 2_000_000;

/** How often the budget clock is read — a `performance.now()` per entry would cost more than the listing. */
const CLOCK_EVERY = 2048;

/** At most this many distinct scan roots are remembered per home (a flapping `$TMPDIR` cannot grow the file). */
const MARKER_ROOTS_MAX = 8;

/** At most this many pending staging paths are remembered. */
const MARKER_PENDING_MAX = 256;

export interface ClaudeResumeScanMarker {
  schema: 1;
  /** When the most recent listing finished (ISO). */
  scannedAt: string;
  /** Every scan root a listing has covered; a boot whose root is in here lists nothing. */
  roots: string[];
  /** The most recent listing: `false` when its budget ran out before the end of the directory. */
  complete: boolean;
  /** Directory entries the most recent listing read. */
  entries: number;
  /** `claude-resume-*` directories the most recent listing found. */
  found: number;
  /** Staging paths found and not dealt with; retried by path (never by listing) at later boots. */
  pending: string[];
}

export interface ClaudeResumeListing {
  /** The `claude-resume-*` DIRECTORIES directly under the root (names only). */
  names: string[];
  /** Entries read. */
  entries: number;
  /** `false`: the budget (time or entries) ended the listing before the directory did. */
  complete: boolean;
  /** The root does not exist (or is not a directory): nothing to sweep, and nothing that can appear by itself. */
  absent: boolean;
}

/** The listing seam. The real one is `listClaudeResumeStaging`; a test passes a spy to prove a boot did
 *  or did not list the temp root. It THROWS for an error that says nothing about the directory's
 *  contents (permissions, descriptor exhaustion) — the caller leaves the marker unwritten and a later
 *  boot tries again. */
export type ClaudeResumeLister = (scanRoot: string) => ClaudeResumeListing;

export interface ClaudeResumeListOptions {
  budgetMs?: number;
  maxEntries?: number;
  /** Test seam: the monotonic clock in ms. */
  now?: () => number;
  /** Test seam: the directory opener. */
  open?: typeof opendirSync;
}

/**
 * List the `claude-resume-*` directories directly under `scanRoot`, bounded in time and entries. Names
 * and entry types only — nothing inside any directory is opened or stat'd.
 */
export function listClaudeResumeStaging(scanRoot: string, options: ClaudeResumeListOptions = {}): ClaudeResumeListing {
  const budgetMs = options.budgetMs ?? CLAUDE_RESUME_SCAN_BUDGET_MS;
  const maxEntries = options.maxEntries ?? CLAUDE_RESUME_SCAN_MAX_ENTRIES;
  const now = options.now ?? (() => performance.now());
  const open = options.open ?? opendirSync;
  const names: string[] = [];
  let entries = 0;
  let complete = true;
  let dir: ReturnType<typeof opendirSync> | undefined;
  try {
    // Bun opens lazily: a missing root throws at the FIRST `readSync`, not at `opendirSync` — so both sit in
    // one try, and an absent root is told apart from an unreadable one by the error code alone.
    dir = open(scanRoot);
    const startedAt = now();
    for (let entry = dir.readSync(); entry !== null; entry = dir.readSync()) {
      entries++;
      if (entry.name.startsWith(CLAUDE_RESUME_PREFIX) && entry.isDirectory()) names.push(entry.name);
      if (entries % CLOCK_EVERY === 0 && (entries >= maxEntries || now() - startedAt > budgetMs)) {
        complete = false;
        break;
      }
    }
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return { names: [], entries: 0, complete: true, absent: true };
    throw e;
  } finally {
    try { dir?.closeSync(); } catch { /* a close that fails costs nothing */ }
  }
  return { names, entries, complete, absent: false };
}

export function claudeResumeScanMarkerPath(home: string): string {
  return join(home, "migration", "claude-resume-scan.json");
}

/** The marker, or `undefined` when absent, unreadable, or of a schema this build does not know (all of
 *  which mean "not scanned yet" — the safe direction). */
export function readClaudeResumeScanMarker(home: string): ClaudeResumeScanMarker | undefined {
  try {
    const raw = JSON.parse(readFileSync(claudeResumeScanMarkerPath(home), "utf8")) as Partial<ClaudeResumeScanMarker> | null;
    if (raw === null || typeof raw !== "object" || raw.schema !== 1) return undefined;
    if (!Array.isArray(raw.roots) || !raw.roots.every((r) => typeof r === "string")) return undefined;
    const pending = Array.isArray(raw.pending) ? raw.pending.filter((p): p is string => typeof p === "string") : [];
    return {
      schema: 1,
      scannedAt: typeof raw.scannedAt === "string" ? raw.scannedAt : "",
      roots: raw.roots,
      complete: raw.complete !== false,
      entries: typeof raw.entries === "number" ? raw.entries : 0,
      found: typeof raw.found === "number" ? raw.found : 0,
      pending,
    };
  } catch {
    return undefined;
  }
}

/** True when a listing has already covered `scanRoot` for this home. */
export function claudeResumeScanDone(home: string, scanRoot: string): boolean {
  return readClaudeResumeScanMarker(home)?.roots.includes(scanRoot) === true;
}

/** Record a finished (or budget-cut) listing of `scanRoot`. Atomic (temp + rename), 0600, best effort:
 *  a marker that cannot be written costs only a repeat listing at the next boot. Returns whether it landed. */
export function recordClaudeResumeScan(
  home: string,
  scanRoot: string,
  result: { complete: boolean; entries: number; found: number; pending: string[] },
  now: () => string = () => new Date().toISOString(),
): boolean {
  const path = claudeResumeScanMarkerPath(home);
  const previous = readClaudeResumeScanMarker(home);
  const roots = [...(previous?.roots ?? []).filter((r) => r !== scanRoot), scanRoot].slice(-MARKER_ROOTS_MAX);
  // Pending paths are per root; a path of another root's is kept only while it is still a candidate.
  const pending = [...new Set([...(previous?.pending ?? []).filter((p) => !p.startsWith(`${scanRoot}/`)), ...result.pending])].slice(0, MARKER_PENDING_MAX);
  const marker: ClaudeResumeScanMarker = { schema: 1, scannedAt: now(), roots, complete: result.complete, entries: result.entries, found: result.found, pending };
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(tmp, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, path);
    return true;
  } catch {
    try { rmSync(tmp, { force: true }); } catch { /* best effort */ }
    return false;
  }
}

/** Replace the pending paths of ONE root in an existing marker (a later boot retried them). A no-op
 *  when there is no marker or nothing changed — the listing that would create one has not run. */
export function updateClaudeResumeScanPending(home: string, scanRoot: string, pending: string[]): void {
  const marker = readClaudeResumeScanMarker(home);
  if (marker === undefined) return;
  const merged = [...marker.pending.filter((p) => !p.startsWith(`${scanRoot}/`)), ...pending].slice(0, MARKER_PENDING_MAX);
  if (merged.length === marker.pending.length && merged.every((p, i) => p === marker.pending[i])) return;
  const path = claudeResumeScanMarkerPath(home);
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, `${JSON.stringify({ ...marker, pending: merged }, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, path);
  } catch {
    try { rmSync(tmp, { force: true }); } catch { /* best effort */ }
  }
}

/**
 * Is there a claude staging root a Migration C phase 2 re-key must wait for? With a marker covering the
 * root: only the pending paths (no listing). Without one: the bounded listing — Migration C is a
 * once-per-home event, and the recovery pass that writes the marker runs after its phase 1.
 */
export function claudeResumeStagingPresent(
  home: string,
  scanRoot: string,
  list: ClaudeResumeLister = listClaudeResumeStaging,
  exists: (path: string) => boolean = existsSync,
): boolean {
  const marker = readClaudeResumeScanMarker(home);
  if (marker?.roots.includes(scanRoot) === true) return marker.pending.some((p) => p.startsWith(`${scanRoot}/`) && exists(p));
  try {
    return list(scanRoot).names.length > 0;
  } catch {
    return false;
  }
}
