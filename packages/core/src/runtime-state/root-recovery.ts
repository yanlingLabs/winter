// WS-21 (spec §3.8, recovery): reconcile-then-delete for every root a crashed incarnation may have left
// a working copy in — run ONLY when the linked router has `reconcileRootForRecovery` (run-home routers),
// and run LATE, at the runtime-sdk construction site, because that call needs the router's own live
// store and `recoverRuntimeState` (§13) runs before the router exists (the same circularity step 10 has;
// `daemon.ts` restamps step 6 with this report).
//
// THREE SOURCES, ONE RULE — nothing is deleted until the router has reconciled it:
//   1. recorded roots  `runtime_sessions.active_local_write_root` (§13 step 6's seam)
//   2. run folders     every real directory under `<home>/cache/runs/` — at boot none is live, so each is
//                      a crashed (or `pending`) incarnation's; a folder this process built is skipped
//   3. staging roots   stale, unclaimed `claude-resume-*` directories (step 8's narrow sweep, deferred
//                      here on a run-home build so it runs only after the reconcile — spec §3.8)
//
//   clean | appended → deleted (`rm -rf`: links inside are removed, their targets untouched)
//   quarantined      → KEPT, recorded in `run_root_quarantine` (never reconciled or swept again — the
//                      router already copied its `projects/` under `<home>/cache/quarantine/`), the
//                      session marked `repair-required`, and reported by `winter doctor`
//   a throw          → kept and counted (the router rethrows its own refusals, e.g. a linked
//                      quarantine dir); recovery stays bounded — one root never stops the others
//
// NEVER THROUGH A LINK: a `cache`, `cache/runs` or run-folder entry that is a symbolic link is never
// reconciled (the router would scan `<target>/projects/*.jsonl` and could append a planted transcript to
// the canonical store) and never followed by the delete. Diagnostics carry counts and paths only.
import { lstatSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeStateDb } from "./db";
import { RuntimeSessionRecords } from "./records";
import { CLAUDE_RESUME_PREFIX, CLAUDE_RESUME_STALE_MS } from "./recovery";

export type RootReconcile = (root: string) => Promise<"clean" | "appended" | "quarantined">;

export interface RootRecoveryDeps {
  home: string;
  rs: RuntimeStateDb;
  /** The router handle's `reconcileRootForRecovery`. */
  reconcile: RootReconcile;
  /** A run folder a live incarnation of THIS process owns — never touched. */
  isLive?: (dir: string) => boolean;
  /** The staging scan root: `WINTER_CLAUDE_RESUME_SCAN_ROOT` in tests, else `os.tmpdir()`. */
  claudeResumeScanRoot?: string;
  log?: (line: string) => void;
  now?: () => string;
}

export interface RootRecoveryReport {
  recorded: { clean: number; appended: number; quarantined: number; failed: number; missing: number; kept: number; skipped: number };
  runFolders: { clean: number; appended: number; quarantined: number; failed: number; skipped: number; refused: number };
  staging: { removed: number; quarantined: number; failed: number };
  /** Every root quarantined by THIS pass. */
  quarantinedRoots: string[];
}

/** The rows `winter doctor` reports. */
export function quarantinedRunRoots(rs: RuntimeStateDb): { root: string; recordedAt: string }[] {
  try {
    return rs.db.query<{ root: string; recorded_at: string }, []>("SELECT root, recorded_at FROM run_root_quarantine ORDER BY recorded_at, root").all()
      .map((r) => ({ root: r.root, recordedAt: r.recorded_at }));
  } catch {
    return []; // a pre-v7 store (readonly doctor on an unmigrated home) has no such table
  }
}

const isRealDir = (p: string): boolean => {
  try { return lstatSync(p).isDirectory(); } catch { return false; }
};

export async function recoverRunRoots(deps: RootRecoveryDeps): Promise<RootRecoveryReport> {
  const log = deps.log ?? (() => {});
  const now = deps.now ?? (() => new Date().toISOString());
  const report: RootRecoveryReport = {
    recorded: { clean: 0, appended: 0, quarantined: 0, failed: 0, missing: 0, kept: 0, skipped: 0 },
    runFolders: { clean: 0, appended: 0, quarantined: 0, failed: 0, skipped: 0, refused: 0 },
    staging: { removed: 0, quarantined: 0, failed: 0 },
    quarantinedRoots: [],
  };
  const known = new Set(quarantinedRunRoots(deps.rs).map((q) => q.root));
  const handled = new Set<string>();
  const runsDir = join(deps.home, "cache", "runs");
  const isRunFolder = (p: string): boolean => p.startsWith(`${runsDir}/`) && !p.slice(runsDir.length + 1).includes("/");
  const scanRoot = deps.claudeResumeScanRoot ?? tmpdir();
  const isStagingRoot = (p: string): boolean => p.startsWith(`${scanRoot.replace(/\/+$/, "")}/${CLAUDE_RESUME_PREFIX}`) && !p.slice(scanRoot.replace(/\/+$/, "").length + 1).includes("/");

  const quarantine = (root: string): void => {
    known.add(root);
    report.quarantinedRoots.push(root);
    try {
      deps.rs.db.run("INSERT OR IGNORE INTO run_root_quarantine (root, recorded_at, detail_json) VALUES (?, ?, '{}')", [root, now()]);
    } catch { /* bounded: the audit row is evidence, never a dependency */ }
    log(`run-root recovery: quarantined and kept ${root}`);
  };
  const remove = (root: string): boolean => {
    try { rmSync(root, { recursive: true, force: true }); return true; } catch { return false; }
  };

  const cacheDir = join(deps.home, "cache");
  let cacheLinked = false;
  for (const p of [cacheDir, runsDir]) {
    try { if (lstatSync(p).isSymbolicLink()) cacheLinked = true; } catch { /* absent: nothing to sweep */ }
  }

  // ── 1. recorded roots ───────────────────────────────────────────────────────────────────────
  const records = new RuntimeSessionRecords(deps.rs);
  let recorded: { id: string; root: string; kind: string | null }[] = [];
  try {
    recorded = deps.rs.db.query<{ id: string; root: string; kind: string | null }, []>(
      "SELECT winter_session_id AS id, active_local_write_root AS root, active_local_write_root_kind AS kind FROM runtime_sessions WHERE active_local_write_root IS NOT NULL ORDER BY winter_session_id",
    ).all();
  } catch { recorded = []; }
  for (const row of recorded) {
    if (known.has(row.root)) { report.recorded.skipped++; handled.add(row.root); continue; }
    let st;
    try { st = lstatSync(row.root); } catch { report.recorded.missing++; continue; }
    handled.add(row.root);
    if (!st.isDirectory() || (cacheLinked && row.root.startsWith(`${cacheDir}/`))) {
      report.recorded.failed++;
      log(`run-root recovery: recorded root is not a real directory (or lies behind a linked cache), left alone: ${row.root}`);
      continue;
    }
    try {
      const outcome = await deps.reconcile(row.root);
      if (outcome === "quarantined") {
        report.recorded.quarantined++;
        quarantine(row.root);
        try { records.setTranscriptHealth(row.id, "repair-required"); } catch { /* bounded */ }
        continue;
      }
      report.recorded[outcome]++;
      // Only a run folder or a staging root is Winter's to delete; any other recorded root (the pre-WS-21
      // official spool) stays where it is — reconciled, not removed.
      if ((isRunFolder(row.root) || isStagingRoot(row.root)) && remove(row.root)) {
        try { deps.rs.db.run("UPDATE runtime_sessions SET active_local_write_root = NULL, active_local_write_root_kind = NULL WHERE winter_session_id = ?", [row.id]); } catch { /* bounded */ }
      } else {
        report.recorded.kept++;
      }
    } catch {
      report.recorded.failed++;
    }
  }

  // ── 2. run folders under <home>/cache/runs ──────────────────────────────────────────────────
  if (cacheLinked) {
    report.runFolders.refused++;
    log(`run-root recovery: ${cacheDir} or ${runsDir} is a symbolic link — no run folder is reconciled or removed through it`);
  } else {
    let entries: { name: string; dir: boolean }[] = [];
    try { entries = readdirSync(runsDir, { withFileTypes: true }).map((e) => ({ name: e.name, dir: e.isDirectory() })); } catch { entries = []; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const dir = join(runsDir, e.name);
      if (handled.has(dir)) continue;
      if (!e.dir || !isRealDir(dir) || known.has(dir) || deps.isLive?.(dir) === true) { report.runFolders.skipped++; continue; }
      try {
        const outcome = await deps.reconcile(dir);
        if (outcome === "quarantined") { report.runFolders.quarantined++; quarantine(dir); continue; }
        report.runFolders[outcome]++;
        remove(dir);
      } catch {
        report.runFolders.failed++;
      }
    }
  }

  // ── 3. stale, unclaimed claude staging roots ────────────────────────────────────────────────
  const claimed = new Set<string>();
  try {
    for (const q of [
      "SELECT DISTINCT local_write_root AS p FROM runtime_generations WHERE local_write_root IS NOT NULL",
      "SELECT DISTINCT effective_temp_dir AS p FROM runtime_sessions WHERE effective_temp_dir IS NOT NULL",
      "SELECT DISTINCT active_local_write_root AS p FROM runtime_sessions WHERE active_local_write_root IS NOT NULL",
    ]) for (const r of deps.rs.db.query<{ p: string }, []>(q).all()) claimed.add(r.p);
  } catch { /* bounded: an unreadable claim set sweeps nothing below */ }
  let staging: string[] = [];
  try {
    staging = readdirSync(scanRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith(CLAUDE_RESUME_PREFIX))
      .map((e) => join(scanRoot, e.name));
  } catch { staging = []; }
  for (const dir of staging.sort()) {
    if (handled.has(dir) || known.has(dir)) continue;
    if ([...claimed].some((root) => root === dir || root.startsWith(`${dir}/`))) continue;
    let ageMs: number;
    try { ageMs = Date.now() - statSync(dir).mtimeMs; } catch { continue; }
    if (ageMs < CLAUDE_RESUME_STALE_MS) continue;
    try {
      const outcome = await deps.reconcile(dir);
      if (outcome === "quarantined") { report.staging.quarantined++; quarantine(dir); continue; }
      if (remove(dir)) report.staging.removed++;
    } catch {
      report.staging.failed++;
    }
  }
  return report;
}

/** The report as a step-6 `detail` (counts and paths only). */
export function rootRecoveryDetail(r: RootRecoveryReport): Record<string, number | string | string[]> {
  return {
    recordedClean: r.recorded.clean, recordedAppended: r.recorded.appended, recordedQuarantined: r.recorded.quarantined,
    recordedFailed: r.recorded.failed, recordedMissing: r.recorded.missing, recordedKept: r.recorded.kept,
    runFoldersClean: r.runFolders.clean, runFoldersAppended: r.runFolders.appended, runFoldersQuarantined: r.runFolders.quarantined,
    runFoldersFailed: r.runFolders.failed, runFoldersSkipped: r.runFolders.skipped, runFoldersRefused: r.runFolders.refused,
    stagingRemoved: r.staging.removed, stagingQuarantined: r.staging.quarantined, stagingFailed: r.staging.failed,
    quarantinedRoots: r.quarantinedRoots,
  };
}
