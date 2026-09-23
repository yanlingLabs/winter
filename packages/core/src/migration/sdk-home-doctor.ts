// WS-21 (spec §8, "`winter doctor` reports"): the shared runtime home's section of `winter doctor` —
// Migration C's status and archives, the settings split, quarantined roots, untranslated rules, leftover
// approved-rules entries and the last run-folder sweep. READ-ONLY and never throwing (a diagnostic must
// not crash the tool that runs it); counts and paths only, never a file's contents.
//
// Not reported, because nothing persists them (a gap, recorded in the lane report): the per-run
// builder's skipped links and unconditional rules — they are logged by the daemon when each run home
// is built (`runHomeReportSummary`), and exist only for that incarnation.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { openRuntimeStateDb } from "../runtime-state/db";
import { latestRecoveryAttempts } from "../runtime-state/doctor";
import { quarantinedRunRoots } from "../runtime-state/root-recovery";
import { isOldLayout, migrationCRolledBackPath, migrationCState } from "./migrate-c";
import { settingsSplitMarkerPath } from "./settings-split";

function archivedApprovedRecords(home: string): string[] {
  try {
    return readdirSync(join(home, "migration"))
      .filter((n) => n.startsWith("c-"))
      .map((n) => join(home, "migration", n, "archive", "permissions", "projects.json"))
      .filter((p) => existsSync(p));
  } catch { return []; }
}

function projectCount(recordPath: string): number {
  try {
    const raw = JSON.parse(readFileSync(recordPath, "utf8")) as { projects?: Record<string, unknown> };
    return raw.projects && typeof raw.projects === "object" ? Object.keys(raw.projects).length : 0;
  } catch { return 0; }
}

function untranslatedFiles(home: string): { path: string; rules: number }[] {
  try {
    return readdirSync(join(home, "migration"))
      .filter((n) => n.startsWith("c-"))
      .map((n) => join(home, "migration", n, "untranslated-rules.json"))
      .filter((p) => existsSync(p))
      .map((path) => {
        try { return { path, rules: (JSON.parse(readFileSync(path, "utf8")) as { rules?: unknown[] }).rules?.length ?? 0 }; } catch { return { path, rules: 0 }; }
      });
  } catch { return []; }
}

/** `winter doctor`'s shared-runtime-home lines. */
export function sdkHomeDoctorLines(home: string): string[] {
  const lines: string[] = [];
  try {
    const state = migrationCState(home);
    if (state.kind === "unreadable") lines.push("sdk home: HALF-MIGRATED — the Migration C manifest does not parse; run `winter migrate --sdk-home --rollback` (or move it aside)");
    else if (state.kind === "parsed") {
      const m = state.manifest;
      if (m.status === "complete") lines.push(`sdk home: migrated (Migration C complete ${m.finishedAt ?? ""}) — backups and archives under ${m.archiveDir}`);
      else if (m.status === "phase1-complete") lines.push(`sdk home: Migration C phase 1 done, phase 2 NOT — the official working copies still await the router's reconcile; the next daemon boot on a build that has it finishes Migration C (and refuses to open sessions until it does) — archive ${m.archiveDir}`);
      else lines.push("sdk home: HALF-MIGRATED — run `winter migrate --sdk-home --resume` or `winter migrate --sdk-home --rollback`");
      const quarantinedAtMigration = m.reconciled.filter((r) => r.outcome === "quarantined" || r.outcome === "failed");
      if (quarantinedAtMigration.length > 0) lines.push(`sdk home: ${quarantinedAtMigration.length} official working cop(ies) could not be proved clean at migration: ${quarantinedAtMigration.map((r) => `${r.root} (${r.outcome})`).join(", ")} — a copy is under ${join(home, "cache", "quarantine")} and the original in the archive`);
    } else if (existsSync(migrationCRolledBackPath(home))) {
      lines.push(`sdk home: Migration C was rolled back (${migrationCRolledBackPath(home)})${isOldLayout(home) ? " — the home is in the old layout" : ""}`);
    } else if (isOldLayout(home)) {
      lines.push("sdk home: old layout — the default home migrates at its next daemon boot on a build that supports it; any other home: `winter migrate --sdk-home --home <dir>` with the daemon stopped");
    } else {
      lines.push("sdk home: the shared runtime home layout (no migration needed)");
    }

    try {
      const marker = JSON.parse(readFileSync(settingsSplitMarkerPath(home), "utf8")) as { keys?: Record<string, string> };
      const keys = Object.keys(marker.keys ?? {});
      if (keys.length > 0) lines.push(`settings split: ${keys.length} key(s) copied into sdk/ once (${keys.join(", ")}); settings.json keeps its copies for a downgrade`);
    } catch { /* never split yet */ }

    for (const f of untranslatedFiles(home)) {
      if (f.rules > 0) lines.push(`untranslated rules: ${f.rules} saved allow rule(s) had no claude spelling that is not wider — ${f.path}`);
    }

    const live = join(home, "permissions", "projects.json");
    const records = [...(existsSync(live) ? [live] : []), ...archivedApprovedRecords(home)];
    for (const record of records) {
      const n = projectCount(record);
      if (n > 0) lines.push(`approved rules: ${n} project(s) still have "in this project" answers in the old record ${record} — run \`winter migrate-project\` in each to move them into its .winter/settings.local.json`);
    }

    if (existsSync(join(home, "runtimes", "runtime-state.db"))) {
      try {
        const rs = openRuntimeStateDb(home, { readonly: true });
        try {
          const q = quarantinedRunRoots(rs);
          if (q.length > 0) lines.push(`quarantined run roots: ${q.length} kept (never swept again): ${q.map((r) => r.root).join(", ")} — the router's copy of each working transcript is under ${join(home, "cache", "quarantine")}`);
        } finally { rs.close(); }
      } catch { /* an unmigrated or unreadable store is the runtime-state section's to report */ }
      const step6 = latestRecoveryAttempts(home).find((a) => a.step === 6);
      if (step6 !== undefined && step6.outcome !== "skipped") {
        const d = step6.detail as Record<string, unknown>;
        lines.push(`run-folder sweep (last boot): ${step6.outcome} — run folders ${String(d.runFoldersClean ?? 0)} clean, ${String(d.runFoldersAppended ?? 0)} appended, ${String(d.runFoldersQuarantined ?? 0)} quarantined, ${String(d.runFoldersFailed ?? 0)} failed; staging roots ${String(d.stagingRemoved ?? 0)} removed`);
      }
    }
  } catch (err) {
    lines.push(`sdk home: unavailable (${err instanceof Error ? err.name : "error"})`);
  }
  return lines;
}
