// WS-21 (spec §8): MIGRATION C — a home in the old layout (the runtime store at `<home>/projects`, the
// user's skills at `<home>/skills`, …) becomes the shared-runtime-home layout (`<home>/sdk/…`, in
// claude's formats). Migration B's discipline (`migrate-b.ts`, `manifest.ts`): a manifest written
// atomically after EVERY step, same-volume renames, every step idempotent, a typed refusal for a home
// caught half-way, and an explicit `--resume`/`--rollback`.
//
// TWO PHASES (DECISION 14 — spec §8's step order cannot be run as written). Step 2 reconciles the
// official leg's working copies through the ROUTER's `reconcileRootForRecovery`, which needs the
// router's own live store — built long after the boot hook — AND reads its canonical transcripts from
// `<home>/sdk/projects`, so it can only run AFTER step 3 has moved them there. So:
//
//   phase 1 (the boot hook, or `winter migrate --sdk-home`):
//     preflight → move-dirs → copy-files → split-settings → convert-plugins → runtime-state
//     then `phase1-complete` — a NORMAL booting state; the half-migrated refusal is phase 1 incomplete
//   phase 2 (the daemon's late site, after `createWinterRuntimeSdk`, before `startIpcServer`):
//     reconcile-official-roots → rekey-transcripts → archive → done
//
// ROUND 3 (DECISION): the canonical-cwd re-key is a PHASE 2 step, AFTER the reconcile — never in phase 1.
// The router judges each official working copy against the canonical file at the key the working copy
// itself names (the key 0.116 wrote); moved away first, that file would read as absent, the whole working
// copy would be "appended" into a NEW file at the raw key, and the session's history would be split in two.
//
// On a build whose router cannot reconcile, phase 1's preflight REFUSES when an official working copy
// holds anything — so no real home ever migrates before the integrated build can finish it.
//
// ROLLBACK restores everything except the step-2 reconcile appends, which stay in the canonical
// transcripts: they are lines that were already the session's own.
import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { randomBytes } from "node:crypto";
import { transcriptProjectKey } from "@yanlinglabs/winter-agent-sdk";
import { SDK_COMPAT_LINKS, SDK_PERSISTENT_ENTRIES, canonicalCwd, sdkHomeFor } from "../agent/paths";
import { downgradeRuntimeStateToV6, openRuntimeStateDb } from "../runtime-state/db";
import { RuntimeLeases, type LeaseProbe } from "../runtime-state/leases";
import { RuntimeSessionRecords } from "../runtime-state/records";
import { moveTranscriptFiles, transcriptEntriesOf } from "../runtime-state/transcript-rekey";
import type { RecoveryReport, RecoveryTranscriptOutcome } from "../runtime-sdk/run-home-contract";
import { normalizeRecoveryReport, quarantinedBackendSessions } from "../runtime-sdk/run-home-support";
import { DEAD_LEGACY_TOP_LEVEL_FILES } from "./dead-legacy-files";
import { LEGACY_INSTRUCTIONS_FILE } from "../legacy-names";
import { settingsSplitMarkerPath, splitSettingsToSdk } from "./settings-split";

export type MigrationCStep = "preflight" | "reconcile-official-roots" | "move-dirs" | "copy-files"
  | "split-settings" | "convert-plugins" | "runtime-state" | "rekey-transcripts" | "archive" | "done";

export const MIGRATION_C_PHASE1: readonly MigrationCStep[] = ["preflight", "move-dirs", "copy-files", "split-settings", "convert-plugins", "runtime-state"];
export const MIGRATION_C_PHASE2: readonly MigrationCStep[] = ["reconcile-official-roots", "rekey-transcripts", "archive", "done"];

export type MigrationCRefusalCode = "sdk_home_migration_required" | "sdk_home_migration_refused" | "sdk_home_half_migrated" | "nothing_to_resume" | "nothing_to_rollback";

export class MigrationCRefused extends Error {
  constructor(public readonly code: MigrationCRefusalCode, message: string) {
    super(message);
    this.name = "MigrationCRefused";
  }
}

export interface MigrationCStepRecord { step: MigrationCStep; status: "done" | "skipped"; at: string; detail?: Record<string, unknown> }

export interface MigrationCManifest {
  schemaVersion: 1;
  home: string;
  startedAt: string;
  finishedAt?: string;
  status: "in-progress" | "phase1-complete" | "complete" | "rolled-back";
  /** `migration/c-<ts>/` — backups, archives and the untranslated-rules file. */
  archiveDir: string;
  steps: MigrationCStepRecord[];
  /** Preflight backups (paths), `null` when the file did not exist before the migration. */
  backups: { settings: string | null; runtimeState: string | null; sdkSettings: string | null; sdkGlobal: string | null; splitMarker: string | null };
  /** Relative to the home. */
  moved: { from: string; to: string }[];
  /** Round 3, minor 3: the move-dirs rename in flight — written BEFORE the rename, cleared once `moved`
   *  records it (checked: the old path gone, the target there). Only ever one. */
  moving?: { from: string; to: string };
  links: string[];
  copied: string[];
  archived: { from: string; to: string }[];
  /** Review I6: per root, the router's overall outcome and — from a per-transcript router — each
   *  transcript's own (`canonical-ahead` needs nothing; a `quarantined` one marks ITS session). */
  reconciled: { root: string; outcome: "clean" | "appended" | "quarantined" | "failed"; transcripts?: RecoveryTranscriptOutcome[] }[];
  /** Round 3: the canonical-cwd re-key, per session — the INTENT is recorded (`pending`, with the names it
   *  will move) BEFORE any file moves, then `moved`; a `collision`/`refused` moved nothing and marked the
   *  session. Rollback moves back every recorded name that sits at `to` and not at `from`, and re-points
   *  the record. Absent on a manifest written before the step existed. */
  rekeyed?: MigrationCRekey[];
}

export interface MigrationCRekey {
  sessionId: string;
  backendId: string;
  /** Transcript keys, under `sdk/projects`. */
  from: string;
  to: string;
  /** This session's names at `from` when the intent was recorded (the transcript last). */
  entries: string[];
  outcome: "pending" | "moved" | "collision" | "refused";
  reason?: string;
}

export function migrationCDir(home: string): string { return join(home, "migration", "c"); }
export function migrationCManifestPath(home: string): string { return join(migrationCDir(home), "manifest.json"); }
export function migrationCCompletePath(home: string): string { return join(migrationCDir(home), "COMPLETE"); }
export function migrationCRolledBackPath(home: string): string { return join(migrationCDir(home), "manifest.rolled-back.json"); }

function writeManifest(home: string, m: MigrationCManifest): void {
  mkdirSync(migrationCDir(home), { recursive: true, mode: 0o700 });
  const tmp = join(migrationCDir(home), `.manifest.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(m, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, migrationCManifestPath(home));
}

export type MigrationCState = { kind: "absent" } | { kind: "unreadable" } | { kind: "parsed"; manifest: MigrationCManifest };

/** Fail-closed, like Migration B's `manifestFileState`: a manifest that exists but will not parse is
 *  evidence of an interrupted write, never of "nothing happened". */
export function migrationCState(home: string): MigrationCState {
  const p = migrationCManifestPath(home);
  if (!existsSync(p)) return { kind: "absent" };
  try {
    const m = JSON.parse(readFileSync(p, "utf8")) as MigrationCManifest;
    if (m && m.schemaVersion === 1 && typeof m.status === "string" && Array.isArray(m.steps)) return { kind: "parsed", manifest: m };
  } catch { /* fall through */ }
  return { kind: "unreadable" };
}

/** Does `dir` (a real directory, never through a link) hold at least one non-directory entry,
 *  anywhere below it? Bounded: an enormous tree answers as soon as it finds one. */
function hasFiles(dir: string, budget = { left: 20_000 }): boolean {
  let entries;
  try {
    if (!lstatSync(dir).isDirectory()) return false;
    entries = readdirSync(dir, { withFileTypes: true });
  } catch { return false; }
  for (const e of entries) {
    if (--budget.left <= 0) return true; // too big to finish counting: it has content
    if (!e.isDirectory()) return true;
    if (hasFiles(join(dir, e.name), budget)) return true;
  }
  return false;
}

/**
 * Spec §8's OLD LAYOUT (r3, widened by review M7): any directory Migration C moves (`SDK_COMPAT_LINKS`:
 * projects, backups, skills, agents, workflows, output-styles) is a real directory (not a compatibility
 * link) WITH CONTENT (a file somewhere below it), or the home holds an instructions file (`WINTER.md`, or
 * the legacy one) that `sdk/` does not — and Migration C is not done. A run-home build reads none of those
 * from the old place, so a home holding only one of them would otherwise have it silently unread. Moved
 * keys in `settings.json` never count. A fresh home — bootstrap creates none of them — never matches.
 */
export function isOldLayout(home: string): boolean {
  if (existsSync(migrationCCompletePath(home))) return false;
  if (SDK_COMPAT_LINKS.some(([name]) => hasFiles(join(home, name)))) return true;
  if (existsSync(join(sdkHomeFor(home), "WINTER.md"))) return false;
  return [join(home, "WINTER.md"), join(home, LEGACY_INSTRUCTIONS_FILE)].some((p) => {
    try { return lstatSync(p).isFile(); } catch { return false; }
  });
}

export interface MigrationCDeps {
  log: (line: string) => void;
  now?: () => Date;
  /** Phase 2's door: the router handle's `reconcileRootForRecovery`. */
  reconcile?: (root: string) => Promise<RecoveryReport | "clean" | "appended" | "quarantined">;
  /** Whether phase 2 will have that door (the linked router applies run homes). Preflight refuses an
   *  official working copy with content when it will not. */
  reconcileAvailable: boolean;
  /** Lane L4's `convertLegacyPlugins` (a COPY into `sdk/plugins`). Absent: preflight refuses a home
   *  with plugin directories. Wired at integration. */
  convertLegacyPlugins?: (home: string) => Promise<{ converted: string[]; unconvertible: { name: string; reason: string }[] }>;
  /** Preflight's lease probe (tests describe a live or recycled pid); the live machine by default. */
  probe?: LeaseProbe;
}

/** The official leg's working-copy roots phase 2 reconciles (never recorded in runtime-state). */
function officialRoots(home: string): string[] {
  return [join(home, "runtimes", "claude-config"), join(home, "runtimes", "official-agent-spool")];
}

/** `<home>/plugins` entries that are plugin DIRECTORIES (a stray file is not a plugin). */
function legacyPluginDirs(home: string): string[] {
  try {
    return readdirSync(join(home, "plugins"), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch { return []; }
}

/**
 * Review I1: the one thing about `sdk/` that refuses the migration is a REAL COLLISION — a compat target
 * (`SDK_COMPAT_LINKS`) that already has content while its old path is also a real directory with content.
 * Anything else the new build wrote into `sdk/` (tasks, teams, agent memory, plugins, commands, a history
 * file, a rolled-back home's leftovers) is no obstacle: move-dirs only ever renames into a compat target.
 * (The earlier "bootstrap only" rule left a rolled-back home refusing forever.)
 */
function sdkPreflightProblem(home: string): string | undefined {
  for (const [name, target] of SDK_COMPAT_LINKS) {
    const from = join(home, name);
    const to = join(home, target);
    if (isSymlink(from) || !hasFiles(from)) continue;
    if (hasFiles(to)) return `${from} and ${to} both have content — resolve by hand, then \`winter migrate --sdk-home --resume\``;
  }
  return undefined;
}

/**
 * A transcript lease that is not PROVEN stale, anywhere in runtime-state — review I4: `live` (pid running
 * AND start identity matching) or `unknown` (alive, identity unestablished — never broken by the lease
 * code itself, so never assumed dead here). A store that cannot be read at all refuses too: fail closed.
 */
function leaseProblem(home: string, probe: LeaseProbe | undefined): string | undefined {
  if (!existsSync(join(home, "runtimes", "runtime-state.db"))) return undefined;
  let rs;
  try { rs = openRuntimeStateDb(home, { readonly: true }); } catch (err) {
    return `runtime-state.db cannot be read (${(err as Error).name}) — its transcript leases cannot be checked; repair it first (\`winter doctor\`)`;
  }
  try {
    const leases = new RuntimeLeases(rs, { pid: process.pid, startedAt: "unknown" });
    const ids = rs.db.query<{ id: string }, []>("SELECT DISTINCT winter_session_id AS id FROM runtime_generations WHERE lease_holder_pid IS NOT NULL AND lease_released_at IS NULL").all();
    for (const { id } of ids) {
      const lease = leases.holder(id);
      if (lease === undefined) continue;
      const verdict = leases.revalidate(lease, probe);
      if (verdict !== "stale") return `session ${id} holds a transcript lease that is ${verdict === "live" ? "live" : "not provably stale"} — stop it first`;
    }
    return undefined;
  } catch (err) {
    return `runtime-state.db's transcript leases cannot be read (${(err as Error).name}) — repair it first (\`winter doctor\`)`;
  } finally {
    rs.close();
  }
}

/** Why phase 1 cannot run on this home, or `undefined`. Every check that can refuse runs BEFORE the
 *  first byte moves. */
export function migrationCPreflightProblem(home: string, deps: Pick<MigrationCDeps, "reconcileAvailable" | "convertLegacyPlugins" | "probe">): string | undefined {
  const lease = leaseProblem(home, deps.probe);
  if (lease !== undefined) return lease;
  const sdk = sdkPreflightProblem(home);
  if (sdk !== undefined) return sdk;
  if (!deps.reconcileAvailable) {
    const root = officialRoots(home).find((r) => hasFiles(join(r, "projects")) || (r.endsWith("official-agent-spool") && hasFiles(r)));
    if (root !== undefined) return `${root} holds an official working copy, and this build's router cannot reconcile it — Migration C runs on the build that can`;
  }
  if (deps.convertLegacyPlugins === undefined && legacyPluginDirs(home).length > 0) {
    return `${join(home, "plugins")} holds plugins, and this build has no plugin converter — Migration C runs on the build that has one`;
  }
  return undefined;
}

export async function planMigrationC(home: string, deps?: Pick<MigrationCDeps, "reconcileAvailable" | "convertLegacyPlugins" | "probe">): Promise<{ needed: boolean; steps: MigrationCStep[]; refusal?: string }> {
  const state = migrationCState(home);
  if (state.kind === "parsed" && state.manifest.status === "complete") return { needed: false, steps: [] };
  if (state.kind === "parsed" && (state.manifest.status === "in-progress" || state.manifest.status === "phase1-complete")) {
    const done = new Set(state.manifest.steps.map((s) => s.step));
    return { needed: true, steps: [...MIGRATION_C_PHASE1, ...MIGRATION_C_PHASE2].filter((s) => !done.has(s)) };
  }
  if (!isOldLayout(home)) return { needed: false, steps: [] };
  const refusal = deps === undefined ? undefined : migrationCPreflightProblem(home, deps);
  return { needed: true, steps: [...MIGRATION_C_PHASE1, ...MIGRATION_C_PHASE2], ...(refusal === undefined ? {} : { refusal }) };
}

function stamp(d: Date): string { return d.toISOString().replace(/[:.]/g, "-"); }

function backupFile(src: string, dir: string, name: string): string | null {
  if (!existsSync(src)) return null;
  const dest = join(dir, name);
  copyFileSync(src, dest);
  return dest;
}

function isSymlink(p: string): boolean {
  try { return lstatSync(p).isSymbolicLink(); } catch { return false; }
}

/** Claude's `history.jsonl` entry shape from Winter's `{display, ts, sessionId}` (spec §8 step 4). */
function convertHistory(src: string, dest: string, cwdOf: (sessionId: string) => string | undefined): number {
  let n = 0;
  const out: string[] = [];
  for (const line of readFileSync(src, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      const e = JSON.parse(line) as { display?: unknown; ts?: unknown; sessionId?: unknown };
      if (typeof e.display !== "string") continue;
      const sessionId = typeof e.sessionId === "string" ? e.sessionId : undefined;
      out.push(JSON.stringify({
        display: e.display, pastedContents: {},
        timestamp: typeof e.ts === "number" ? e.ts : Date.now(),
        project: (sessionId !== undefined ? cwdOf(sessionId) : undefined) ?? "",
        ...(sessionId !== undefined ? { sessionId } : {}),
      }));
      n++;
    } catch { /* a corrupt line is dropped, as the TUI's own reader does */ }
  }
  writeFileSync(dest, out.length > 0 ? `${out.join("\n")}\n` : "", { mode: 0o600 });
  return n;
}

/** The sessions index's cwd per session, read-only; `undefined` for anything it cannot say. */
function sessionCwds(home: string): (sessionId: string) => string | undefined {
  const path = join(home, "sessions", "index.db");
  if (!existsSync(path)) return () => undefined;
  let db: Database | undefined;
  try {
    db = new Database(path, { readonly: true });
    const rows = db.query<{ session_id: string; cwd: string | null }, []>("SELECT session_id, cwd FROM sessions").all();
    const map = new Map(rows.filter((r) => r.cwd !== null).map((r) => [r.session_id, r.cwd!]));
    return (id) => map.get(id);
  } catch {
    return () => undefined;
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

/** The sessions index's cwd and first working directory per session, read-only — what each leg keys a
 *  transcript by (the Winter leg the `cwd` column, the official leg `cwd ?? dirs[0]`). */
function sessionPrimaries(home: string): (sessionId: string) => { cwd?: string; firstDir?: string } | undefined {
  const path = join(home, "sessions", "index.db");
  if (!existsSync(path)) return () => undefined;
  let db: Database | undefined;
  try {
    db = new Database(path, { readonly: true });
    const rows = db.query<{ session_id: string; cwd: string | null; dirs: string | null }, []>("SELECT session_id, cwd, dirs FROM sessions").all();
    const map = new Map(rows.map((r) => {
      let firstDir: string | undefined;
      try { const d = JSON.parse(r.dirs ?? "[]") as { path?: unknown }[]; if (typeof d[0]?.path === "string") firstDir = d[0].path; } catch { /* unreadable: none */ }
      return [r.session_id, { ...(r.cwd === null ? {} : { cwd: r.cwd }), ...(firstDir === undefined ? {} : { firstDir }) }] as const;
    }));
    return (id) => map.get(id);
  } catch {
    return () => undefined;
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

/**
 * Round 3 (Important): the BULK canonical-cwd re-key — every session record whose recorded transcript key
 * differs from the key its leg now looks under (the canonical cwd's) has its files moved there
 * (`moveTranscriptFiles`: never overwriting, the transcript last) and its record re-pointed. Each intent is
 * written to the manifest BEFORE its files move, so a crash is finished on resume and reversed on rollback;
 * a collision moves nothing, marks the session `repair-required` and is logged. A session with no cwd keys
 * by its temp dir, which is already a realpath — nothing to do. The driver repeats the check lazily at
 * every resume for anything this step never saw.
 */
function rekeyTranscripts(home: string, m: MigrationCManifest, log: (line: string) => void): Record<string, unknown> {
  if (!existsSync(join(home, "runtimes", "runtime-state.db"))) return { reason: "no runtime-state.db" };
  const projects = join(sdkHomeFor(home), "projects");
  const primaries = sessionPrimaries(home);
  m.rekeyed ??= [];
  let moved = 0, collisions = 0;
  const rs = openRuntimeStateDb(home);
  try {
    const records = new RuntimeSessionRecords(rs);
    const rows = rs.db.query<{ id: string; kind: string; backend: string; key: string }, []>(
      "SELECT winter_session_id AS id, runtime_kind AS kind, backend_session_id AS backend, transcript_project_key AS key FROM runtime_sessions WHERE backend_session_id IS NOT NULL ORDER BY winter_session_id",
    ).all();
    for (const row of rows) {
      let entry = m.rekeyed.find((e) => e.sessionId === row.id);
      if (entry !== undefined && entry.outcome !== "pending") continue;
      if (entry === undefined) {
        const p = primaries(row.id);
        const primary = row.kind === "claude-agent" ? (p?.cwd ?? p?.firstDir) : p?.cwd;
        if (primary === undefined) continue;
        const to = transcriptProjectKey(canonicalCwd(primary));
        if (to === row.key) continue;
        entry = { sessionId: row.id, backendId: row.backend, from: row.key, to, entries: transcriptEntriesOf(join(projects, row.key), row.backend), outcome: "pending" };
        m.rekeyed.push(entry);
        writeManifest(home, m);                 // the intent, BEFORE any file moves
      }
      const result = moveTranscriptFiles(projects, entry.backendId, entry.from, entry.to);
      if (result.kind === "moved" || result.kind === "not-needed") {
        records.rekeyTranscript(entry.sessionId, entry.from, entry.to, join(projects, entry.to));
        entry.outcome = "moved";
        moved++;
      } else {
        entry.outcome = result.kind;
        if (result.kind === "refused") entry.reason = result.reason;
        collisions++;
        try { records.setTranscriptHealth(entry.sessionId, "repair-required"); } catch { /* bounded */ }
        log(result.kind === "collision"
          ? `migration C: transcript re-key collision for ${entry.sessionId} — both its recorded key and the canonical cwd's key hold it; nothing moved, marked repair-required`
          : `migration C: transcript re-key for ${entry.sessionId} refused (${result.reason}); nothing moved, marked repair-required`);
      }
      writeManifest(home, m);
    }
  } finally { rs.close(); }
  if (moved > 0) log(`migration C: ${moved} session transcript(s) re-keyed to the canonical cwd`);
  return { moved, notMoved: collisions };
}

/**
 * Run (or resume) Migration C: phase 1, then phase 2 when `deps.reconcile` is given. Throws
 * `MigrationCRefused` before anything moves when the preflight refuses. Returns the manifest.
 */
export async function runMigrationC(home: string, deps: MigrationCDeps): Promise<MigrationCManifest> {
  const now = deps.now ?? (() => new Date());
  const state = migrationCState(home);
  if (state.kind === "unreadable") throw new MigrationCRefused("sdk_home_half_migrated", `${migrationCManifestPath(home)} does not parse — move it aside or run \`winter migrate --sdk-home --rollback\``);
  let m: MigrationCManifest;
  if (state.kind === "parsed" && state.manifest.status !== "rolled-back") {
    m = state.manifest;
    if (m.status === "complete") return m;
  } else {
    if (!isOldLayout(home)) throw new MigrationCRefused("nothing_to_resume", `${home} is not in the old layout — nothing to migrate`);
    const problem = migrationCPreflightProblem(home, deps);
    if (problem !== undefined) throw new MigrationCRefused("sdk_home_migration_refused", `Migration C refused: ${problem}`);
    const at = now();
    const archiveDir = join(home, "migration", `c-${stamp(at)}`);
    mkdirSync(archiveDir, { recursive: true, mode: 0o700 });
    // ── 1. preflight's backups, BEFORE the manifest exists: a backup that fails leaves no half-migrated
    // home behind, only a typed refusal. Review I2: the store is opened READ-ONLY and copied with
    // `VACUUM INTO`, so the backup is the pre-migration schema (a read-write open would run the v7
    // rebuild first, and the "pre-migration" copy would already be v7).
    // Round 3, minor 8: EVERY backup failure is the same typed refusal, and it takes its own empty
    // `c-<ts>` directory with it — no half-made archive is left behind for an operator to wonder about.
    const refuseBackup = (what: string, err: unknown): never => {
      try { rmSync(archiveDir, { recursive: true, force: true }); } catch { /* best effort */ }
      throw new MigrationCRefused("sdk_home_migration_refused", `Migration C refused: ${what} could not be backed up (${(err as { code?: string }).code ?? (err as Error).name}) — nothing was moved`);
    };
    let runtimeState: string | null = null;
    if (existsSync(join(home, "runtimes", "runtime-state.db"))) {
      try {
        const rs = openRuntimeStateDb(home, { readonly: true });
        try { runtimeState = rs.backup(archiveDir); } finally { rs.close(); }
      } catch (err) { refuseBackup("runtime-state.db", err); }
    }
    const backup = (src: string, name: string): string | null => {
      try { return backupFile(src, archiveDir, name); } catch (err) { return refuseBackup(src, err); }
    };
    m = {
      schemaVersion: 1, home, startedAt: at.toISOString(), status: "in-progress", archiveDir, steps: [],
      backups: {
        settings: backup(join(home, "settings.json"), "settings.json.bak"),
        runtimeState,
        sdkSettings: backup(join(sdkHomeFor(home), "settings.json"), "sdk-settings.json.bak"),
        sdkGlobal: backup(join(sdkHomeFor(home), ".winter.json"), "sdk-winter.json.bak"),
        splitMarker: backup(settingsSplitMarkerPath(home), "settings-split.json.bak"),
      },
      moved: [], links: [], copied: [], archived: [], reconciled: [],
    };
    m.steps.push({ step: "preflight", status: "done", at: now().toISOString() });
    writeManifest(home, m);
  }
  const done = (step: MigrationCStep): boolean => m.steps.some((s) => s.step === step);
  const record = (step: MigrationCStep, status: "done" | "skipped", detail?: Record<string, unknown>): void => {
    m.steps.push({ step, status, at: now().toISOString(), ...(detail === undefined ? {} : { detail }) });
    writeManifest(home, m);
  };

  // ── 3. move-dirs: same-volume renames into sdk/, a relative compatibility link at each old path ──
  if (!done("move-dirs")) {
    const inFlight = m.moving;                    // a crashed run's intent (minor 3), read once
    for (const [name, target] of SDK_COMPAT_LINKS) {
      const from = join(home, name);
      const to = join(home, target);
      if (isSymlink(from)) continue;               // already a link (a resumed run, or never old)
      if (existsSync(from) && !hasFiles(from)) {
        // Review I1: an EMPTY old directory (bootstrap of an older build) — nothing to move; it gives way to
        // the link, and whatever the new build already wrote into the target stays where it is.
        rmSync(from, { recursive: true, force: true });
        mkdirSync(to, { recursive: true, mode: 0o700 });
        symlinkSync(relative(home, to), from);
        m.links.push(name);
        writeManifest(home, m);
        continue;
      }
      // Round 3, minor 3: a move is recorded only when it PROVABLY happened — the intent (`moving`) is
      // written before the rename and the result checked after it. (The old "the target has files, so a
      // crashed rename put them there" guess died with I1: the new build's own content may sit there.)
      const intended = inFlight?.from === name;
      if (existsSync(from)) {
        if (existsSync(to)) {
          // bootstrap's empty placeholder gives way; anything with content means a resumed/partial run
          if (hasFiles(to)) throw new MigrationCRefused("sdk_home_migration_refused", `${to} and ${from} both have content — resolve by hand, then \`winter migrate --sdk-home --resume\``);
          rmSync(to, { recursive: true, force: true });
        }
        mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
        m.moving = { from: name, to: target };
        writeManifest(home, m);                    // the intent, before the rename
        renameSync(from, to);
        if (existsSync(from) || !existsSync(to)) throw new MigrationCRefused("sdk_home_half_migrated", `the rename of ${from} into ${to} did not land — nothing more was moved; \`winter migrate --sdk-home --rollback\``);
        m.moved.push({ from: name, to: target });
        delete m.moving;
        writeManifest(home, m);
      } else if (m.moved.some((mv) => mv.from === name)) {
        // renamed and recorded; the link is what a crash left undone
      } else if (intended && existsSync(to)) {
        // the intent was recorded, the old path is gone and the target is there: the rename landed and a
        // crash came before the manifest said so
        m.moved.push({ from: name, to: target });
        delete m.moving;
        writeManifest(home, m);
      } else {
        if (intended && m.moving?.from === name) { delete m.moving; writeManifest(home, m); }
        continue;                                   // never existed (whatever the target holds is the new build's): nothing to link
      }
      symlinkSync(relative(home, to), from);
      m.links.push(name);
      writeManifest(home, m);
    }
    record("move-dirs", "done", { moved: m.moved.length });
  }

  // ── 4. copy-files: WINTER.md (or the legacy instructions file) and history.jsonl, into sdk/ ──────
  if (!done("copy-files")) {
    const sdk = sdkHomeFor(home);
    const instructions = [join(home, "WINTER.md"), join(home, LEGACY_INSTRUCTIONS_FILE)].find((p) => existsSync(p) && !isSymlink(p));
    if (instructions !== undefined && !existsSync(join(sdk, "WINTER.md"))) {
      copyFileSync(instructions, join(sdk, "WINTER.md"));
      m.copied.push("sdk/WINTER.md");
    }
    let history = 0;
    const hist = join(home, "history.jsonl");
    if (existsSync(hist) && !isSymlink(hist) && !existsSync(join(sdk, "history.jsonl"))) {
      history = convertHistory(hist, join(sdk, "history.jsonl"), sessionCwds(home));
      m.copied.push("sdk/history.jsonl");
    }
    record("copy-files", "done", { copied: m.copied.length, historyEntries: history });
  }

  // ── 5. split-settings (no tag rewrite: tags canonicalize on read) ────────────────────────────────
  if (!done("split-settings")) {
    const r = splitSettingsToSdk(home, { now, log: deps.log });
    record("split-settings", "done", { copied: r.copied, alreadyPresent: r.alreadyPresent, untranslated: r.untranslated.length, ...(r.untranslatedFile ? { untranslatedFile: r.untranslatedFile } : {}) });
  }

  // ── 6. convert-plugins: a COPY (the originals stay for a downgrade) ──────────────────────────────
  if (!done("convert-plugins")) {
    const plugins = legacyPluginDirs(home);
    if (plugins.length === 0) record("convert-plugins", "skipped", { reason: "no plugin directories" });
    else if (deps.convertLegacyPlugins === undefined) throw new MigrationCRefused("sdk_home_migration_refused", `${join(home, "plugins")} holds plugins and this build has no plugin converter`);
    else {
      const r = await deps.convertLegacyPlugins(home);
      record("convert-plugins", "done", { converted: r.converted, unconvertible: r.unconvertible });
    }
  }

  // ── 7. runtime-state: backend_root into sdk/projects; the stale official config-dir bookkeeping ────
  if (!done("runtime-state")) {
    let detail: Record<string, unknown> = { reason: "no runtime-state.db" };
    if (existsSync(join(home, "runtimes", "runtime-state.db"))) {
      const rs = openRuntimeStateDb(home); // v7 (run-folder) applies on open
      try {
        const oldPrefix = `${join(home, "projects")}/`;
        const newPrefix = `${join(sdkHomeFor(home), "projects")}/`;
        const roots = officialRoots(home);
        const rewritten = rs.db.run("UPDATE runtime_sessions SET backend_root = ? || substr(backend_root, ?) WHERE substr(backend_root, 1, ?) = ?", [newPrefix, oldPrefix.length + 1, oldPrefix.length, oldPrefix]).changes;
        let cleared = 0;
        for (const root of roots) {
          const like = `${root}%`;
          cleared += rs.db.run("UPDATE runtime_generations SET config_dir = NULL WHERE config_dir LIKE ?", [like]).changes;
          cleared += rs.db.run("UPDATE runtime_generations SET local_write_root = NULL, local_write_root_kind = NULL WHERE local_write_root LIKE ?", [like]).changes;
          cleared += rs.db.run("UPDATE runtime_sessions SET active_local_write_root = NULL, active_local_write_root_kind = NULL WHERE active_local_write_root LIKE ?", [like]).changes;
        }
        detail = { backendRootsRewritten: rewritten, staleConfigDirRowsCleared: cleared };
      } finally { rs.close(); }
    }
    record("runtime-state", "done", detail);
  }

  if (m.status === "in-progress") {
    m.status = "phase1-complete";
    writeManifest(home, m);
    deps.log(`migration C: phase 1 complete — ${m.moved.length} director(ies) moved into ${sdkHomeFor(home)}`);
  }
  // Phase 2 right away when a router door is here, or when there is nothing for one to reconcile.
  if (deps.reconcile !== undefined || !officialRoots(home).some((r) => existsSync(r) && !isSymlink(r) && hasFiles(r))) return finishMigrationC(home, deps);
  return m;
}

/** Mark the Winter sessions owning these BACKEND session ids `repair-required`; returns the ones marked.
 *  Bounded: a store that will not open marks nothing (the manifest still records every transcript). */
function markQuarantinedSessions(home: string, backendIds: readonly string[]): string[] {
  if (backendIds.length === 0 || !existsSync(join(home, "runtimes", "runtime-state.db"))) return [];
  const marked: string[] = [];
  let rs;
  try { rs = openRuntimeStateDb(home); } catch { return []; }
  try {
    const records = new RuntimeSessionRecords(rs);
    for (const id of backendIds) {
      const owner = records.byBackendSessionId(id);
      if (owner === undefined) continue;
      try { records.setTranscriptHealth(owner.winterSessionId, "repair-required"); marked.push(owner.winterSessionId); } catch { /* bounded */ }
    }
  } finally { rs.close(); }
  return marked;
}

/**
 * Phase 2 (the late site): reconcile the official working copies through the router, archive what
 * the new layout no longer reads, and mark the migration done. Idempotent; a root the router cannot
 * reconcile is recorded `failed` and still archived (a move — nothing is lost).
 */
export async function finishMigrationC(home: string, deps: Pick<MigrationCDeps, "log" | "now" | "reconcile">): Promise<MigrationCManifest> {
  const now = deps.now ?? (() => new Date());
  const state = migrationCState(home);
  if (state.kind !== "parsed" || state.manifest.status !== "phase1-complete") {
    if (state.kind === "parsed" && state.manifest.status === "complete") return state.manifest;
    throw new MigrationCRefused("nothing_to_resume", "Migration C phase 2 needs a completed phase 1");
  }
  const m = state.manifest;
  const done = (step: MigrationCStep): boolean => m.steps.some((s) => s.step === step);
  const record = (step: MigrationCStep, status: "done" | "skipped", detail?: Record<string, unknown>): void => {
    m.steps.push({ step, status, at: now().toISOString(), ...(detail === undefined ? {} : { detail }) });
    writeManifest(home, m);
  };

  if (!done("reconcile-official-roots")) {
    for (const root of officialRoots(home)) {
      if (m.reconciled.some((r) => r.root === root)) continue;
      if (!existsSync(root) || isSymlink(root) || !hasFiles(root)) continue;
      // No door (a build whose router cannot reconcile, or the CLI, which has no router): phase 1's
      // preflight already proved the working copies empty then; content now means refuse, never archive
      // an unreconciled transcript tail.
      if (deps.reconcile === undefined) {
        throw new MigrationCRefused("sdk_home_migration_refused", `${root} holds an official working copy and no router can reconcile it here — the next daemon boot on the integrated build finishes Migration C`);
      }
      let entry: MigrationCManifest["reconciled"][number];
      try {
        const report = normalizeRecoveryReport(await deps.reconcile(root));
        entry = { root, outcome: report.outcome, ...(report.transcripts.length > 0 ? { transcripts: report.transcripts } : {}) };
        // Review I6: the root is never one unit — only a session one of whose transcripts the router
        // quarantined needs repair; `canonical-ahead` (a resumed or cross-leg official session's normal
        // state) and `appended` need nothing more.
        const marked = markQuarantinedSessions(home, quarantinedBackendSessions(report));
        if (marked.length > 0) deps.log(`migration C: ${marked.length} session(s) marked repair-required (a quarantined transcript): ${marked.join(", ")}`);
      } catch {
        entry = { root, outcome: "failed" };
      }
      m.reconciled.push(entry);
      writeManifest(home, m);
      deps.log(`migration C: ${root} reconciled — ${entry.outcome}${entry.transcripts ? ` (${entry.transcripts.length} transcript(s))` : ""}`);
    }
    record("reconcile-official-roots", m.reconciled.length === 0 ? "skipped" : "done", { roots: m.reconciled.length });
  }

  if (!done("rekey-transcripts")) {
    const detail = rekeyTranscripts(home, m, deps.log);
    record("rekey-transcripts", (m.rekeyed ?? []).length === 0 ? "skipped" : "done", detail);
  }

  if (!done("archive")) {
    const archive = join(m.archiveDir, "archive");
    const candidates = [
      ...DEAD_LEGACY_TOP_LEVEL_FILES.map((f) => join(home, f)),
      ...officialRoots(home),
      join(home, "cache", "skill-plugins"),
      join(home, "permissions"),
    ];
    for (const src of candidates) {
      const rel = relative(home, src);
      if (m.archived.some((a) => a.from === rel)) continue;
      const dest = join(archive, rel);
      if (!existsSync(src) && !isSymlink(src)) {
        // Review M4: renamed, then a crash before the manifest said so — the destination is this move's
        // (nothing else writes under this migration's own archive), so record it and rollback restores it.
        if (existsSync(dest) || isSymlink(dest)) {
          m.archived.push({ from: rel, to: relative(home, dest) });
          writeManifest(home, m);
        }
        continue;
      }
      mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
      renameSync(src, dest);
      m.archived.push({ from: rel, to: relative(home, dest) });
      writeManifest(home, m);
    }
    record("archive", "done", { archived: m.archived.length });
  }

  record("done", "done");
  m.status = "complete";
  m.finishedAt = now().toISOString();
  writeManifest(home, m);
  writeFileSync(migrationCCompletePath(home), `${m.finishedAt}\n`, { mode: 0o600 });
  deps.log(`migration C: complete — ${m.archived.length} item(s) archived under ${m.archiveDir}`);
  return m;
}

/** One transaction on runtime-state through a RAW handle — no schema step on open (a rollback has already
 *  stepped the store back to v6, and `openRuntimeStateDb` would step it forward again). Absent: a no-op. */
function rawRuntimeState(home: string, fn: (db: Database) => void): void {
  const path = join(home, "runtimes", "runtime-state.db");
  if (!existsSync(path)) return;
  const db = new Database(path);
  try {
    db.run("PRAGMA busy_timeout = 5000");
    db.transaction(() => fn(db))();
  } finally { db.close(); }
}

/**
 * Put the home back in the old layout: everything Migration C did, undone — EXCEPT the step-2 reconcile
 * appends, which stay in the canonical transcripts (lines that were already the session's own).
 *
 * DECISION 15 — never revert what the USER did after the migration. The migration never writes
 * `settings.json` and only ever rewrote `backend_root` in runtime-state, so rollback reverses exactly
 * that one rewrite instead of restoring the preflight backups over the live files (which would drop every
 * post-upgrade settings edit, generation, handoff and quarantine row). The sdk files the split filled are
 * left (an older build never reads them, and they hold the user's post-upgrade answers); the copies
 * `copy-files` made are moved into the archive, never deleted. The preflight backups stay under
 * `archiveDir` for an operator. The daemon must be stopped (the CLI checks the lock).
 */
export async function rollbackMigrationC(home: string, deps: Pick<MigrationCDeps, "log" | "now">): Promise<MigrationCManifest> {
  const now = deps.now ?? (() => new Date());
  const state = migrationCState(home);
  if (state.kind === "absent") throw new MigrationCRefused("nothing_to_rollback", `${home} has no Migration C to roll back`);
  if (state.kind === "unreadable") throw new MigrationCRefused("nothing_to_rollback", `${migrationCManifestPath(home)} does not parse — nothing can be rolled back from it`);
  const m = state.manifest;
  if (m.status === "rolled-back") throw new MigrationCRefused("nothing_to_rollback", "Migration C was already rolled back");

  // Round 3, minor 1: the schema step FIRST — before any archive restore or `backend_root` reversal — so
  // a store that cannot step back (a newer build's schema, a broken reference) refuses the rollback with
  // NOTHING undone, never a half-rolled-back home. Review I3: the older build a rollback is for reads v7
  // as `newer-schema` and would run with its runtime spine offline. DOCUMENTED CONSEQUENCE: the step drops
  // `run_root_quarantine`, so after a re-upgrade the boot sweep reconciles those kept roots AGAIN — a
  // still-unprovable one quarantines again (another evidence copy under `cache/quarantine/`, its sessions
  // re-marked, both idempotent); nothing is deleted on the way. Every store write below therefore goes
  // through a RAW handle (`rawRuntimeState`): `openRuntimeStateDb` would run the v7 step again on open.
  let schema: ReturnType<typeof downgradeRuntimeStateToV6>;
  try {
    schema = downgradeRuntimeStateToV6(home);
  } catch (err) {
    throw new MigrationCRefused("sdk_home_migration_refused", `Migration C rollback refused: runtime-state.db cannot step back to schema v6 (${(err as { reason?: string }).reason ?? (err as Error).name}) — nothing was restored`);
  }
  // archive → back in place (reverse order)
  for (const a of [...m.archived].reverse()) {
    const from = join(home, a.to);
    const to = join(home, a.from);
    if (existsSync(from) && !existsSync(to)) { mkdirSync(dirname(to), { recursive: true }); renameSync(from, to); }
  }
  // rekey-transcripts → reversed (round 3): every recorded name that sits at `to` and not at `from` moves
  // back (a name recorded BEFORE its move and absent from `to` then was provably this step's), and the record
  // is re-pointed at the raw key — before the prefix reversal below carries it under <home>/projects.
  const rekeyed = m.rekeyed ?? [];
  if (rekeyed.length > 0) {
    const projects = join(sdkHomeFor(home), "projects");
    for (const e of [...rekeyed].reverse()) {
      for (const name of [...e.entries].reverse()) {
        const at = join(projects, e.to, name);
        const back = join(projects, e.from, name);
        if ((existsSync(at) || isSymlink(at)) && !existsSync(back) && !isSymlink(back)) {
          mkdirSync(join(projects, e.from), { recursive: true, mode: 0o700 });
          renameSync(at, back);
        }
      }
    }
    rawRuntimeState(home, (db) => {
      for (const e of rekeyed) {
        if (e.outcome !== "moved" && e.outcome !== "pending") continue;
        db.run("UPDATE runtime_sessions SET transcript_project_key = ?, backend_root = ? WHERE winter_session_id = ? AND transcript_project_key = ?", [e.from, join(projects, e.from), e.sessionId, e.to]);
      }
    });
  }
  // runtime-state → the one rewrite reversed (`backend_root` back under <home>/projects)
  if (m.steps.some((st) => st.step === "runtime-state")) {
    rawRuntimeState(home, (db) => {
      const sdkPrefix = `${join(sdkHomeFor(home), "projects")}/`;
      const oldPrefix = `${join(home, "projects")}/`;
      db.run("UPDATE runtime_sessions SET backend_root = ? || substr(backend_root, ?) WHERE substr(backend_root, 1, ?) = ?", [oldPrefix, sdkPrefix.length + 1, sdkPrefix.length, sdkPrefix]);
    });
  }
  // copy-files → the copies moved aside (a user edit to one after the upgrade is kept, not lost)
  for (const rel of m.copied) {
    const src = join(home, rel);
    if (!existsSync(src)) continue;
    const dest = join(m.archiveDir, "rolled-back", rel);
    mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
    renameSync(src, dest);
  }
  // move-dirs → links removed, directories renamed back, bootstrap's empty placeholders restored
  for (const mv of [...m.moved].reverse()) {
    const oldPath = join(home, mv.from);
    const newPath = join(home, mv.to);
    if (isSymlink(oldPath)) unlinkSync(oldPath);
    if (existsSync(newPath) && !existsSync(oldPath)) renameSync(newPath, oldPath);
    const placeholder = relative("sdk", mv.to);
    if (placeholder === "projects" || (SDK_PERSISTENT_ENTRIES as readonly string[]).includes(placeholder)) mkdirSync(newPath, { recursive: true, mode: 0o700 });
  }
  for (const name of m.links) {
    const p = join(home, name);
    if (isSymlink(p)) unlinkSync(p);
  }
  rmSync(migrationCCompletePath(home), { force: true });
  m.status = "rolled-back";
  m.finishedAt = now().toISOString();
  writeFileSync(migrationCRolledBackPath(home), `${JSON.stringify(m, null, 2)}\n`, { mode: 0o600 });
  rmSync(migrationCManifestPath(home), { force: true });
  deps.log(`migration C: rolled back — ${m.moved.length} director(ies) moved back${schema === "not-needed" ? "" : ", runtime-state.db stepped back to schema v6"}; the reconcile appends stay in the canonical transcripts; backups kept under ${m.archiveDir}`);
  return m;
}
