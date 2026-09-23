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
//     reconcile-official-roots → archive → done
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
import { SDK_COMPAT_LINKS, SDK_PERSISTENT_ENTRIES, sdkHomeFor } from "../agent/paths";
import { openRuntimeStateDb } from "../runtime-state/db";
import { RuntimeLeases, type LeaseProbe } from "../runtime-state/leases";
import { DEAD_LEGACY_TOP_LEVEL_FILES } from "./dead-legacy-files";
import { settingsSplitMarkerPath, splitSettingsToSdk } from "./settings-split";

export type MigrationCStep = "preflight" | "reconcile-official-roots" | "move-dirs" | "copy-files"
  | "split-settings" | "convert-plugins" | "runtime-state" | "archive" | "done";

export const MIGRATION_C_PHASE1: readonly MigrationCStep[] = ["preflight", "move-dirs", "copy-files", "split-settings", "convert-plugins", "runtime-state"];
export const MIGRATION_C_PHASE2: readonly MigrationCStep[] = ["reconcile-official-roots", "archive", "done"];

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
  links: string[];
  copied: string[];
  archived: { from: string; to: string }[];
  reconciled: { root: string; outcome: "clean" | "appended" | "quarantined" | "failed" }[];
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
 * Spec §8's OLD LAYOUT, exactly (r3): `<home>/projects` or `<home>/skills` is a real directory (not a
 * compatibility link) WITH CONTENT (a file somewhere below it), and Migration C is not done. Moved keys
 * in `settings.json` never count. A fresh home — bootstrap creates neither — never matches.
 */
export function isOldLayout(home: string): boolean {
  if (existsSync(migrationCCompletePath(home))) return false;
  return ["projects", "skills"].some((name) => hasFiles(join(home, name)));
}

export interface MigrationCDeps {
  log: (line: string) => void;
  now?: () => Date;
  /** Phase 2's door: the router handle's `reconcileRootForRecovery`. */
  reconcile?: (root: string) => Promise<"clean" | "appended" | "quarantined">;
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

/** `sdk/` may hold only what bootstrap and the pre-migration doors create: the empty persistent dirs,
 *  `sdk/projects`, and the two files the settings/MCP doors write on any build. */
function sdkPreflightProblem(home: string): string | undefined {
  const sdk = sdkHomeFor(home);
  let entries;
  try { entries = readdirSync(sdk, { withFileTypes: true }); } catch { return undefined; }
  const bootstrapDirs = new Set<string>(["projects", ...SDK_PERSISTENT_ENTRIES]);
  const allowedFiles = new Set(["settings.json", ".winter.json"]);
  for (const e of entries) {
    if (e.isDirectory() && bootstrapDirs.has(e.name)) {
      if (hasFiles(join(sdk, e.name))) return `${join(sdk, e.name)} already has content`;
      continue;
    }
    if (!e.isDirectory() && allowedFiles.has(e.name)) continue;
    return `${join(sdk, e.name)} is not something Migration C expects to find in ${sdk}`;
  }
  return undefined;
}

/** A live transcript lease anywhere in runtime-state: pid running AND start identity matching. */
function liveLease(home: string, probe: LeaseProbe | undefined): string | undefined {
  if (!existsSync(join(home, "runtimes", "runtime-state.db"))) return undefined;
  let rs;
  try { rs = openRuntimeStateDb(home, { readonly: true }); } catch { return undefined; }
  try {
    const leases = new RuntimeLeases(rs, { pid: process.pid, startedAt: "unknown" });
    const ids = rs.db.query<{ id: string }, []>("SELECT DISTINCT winter_session_id AS id FROM runtime_generations WHERE lease_holder_pid IS NOT NULL AND lease_released_at IS NULL").all();
    for (const { id } of ids) {
      const lease = leases.holder(id);
      if (lease && leases.revalidate(lease, probe) === "live") return id;
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    rs.close();
  }
}

/** Why phase 1 cannot run on this home, or `undefined`. Every check that can refuse runs BEFORE the
 *  first byte moves. */
export function migrationCPreflightProblem(home: string, deps: Pick<MigrationCDeps, "reconcileAvailable" | "convertLegacyPlugins" | "probe">): string | undefined {
  const lease = liveLease(home, deps.probe);
  if (lease !== undefined) return `session ${lease} holds a live transcript lease — stop it first`;
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
    m = {
      schemaVersion: 1, home, startedAt: at.toISOString(), status: "in-progress", archiveDir, steps: [],
      backups: { settings: null, runtimeState: null, sdkSettings: null, sdkGlobal: null, splitMarker: null },
      moved: [], links: [], copied: [], archived: [], reconciled: [],
    };
    writeManifest(home, m);
  }
  const done = (step: MigrationCStep): boolean => m.steps.some((s) => s.step === step);
  const record = (step: MigrationCStep, status: "done" | "skipped", detail?: Record<string, unknown>): void => {
    m.steps.push({ step, status, at: now().toISOString(), ...(detail === undefined ? {} : { detail }) });
    writeManifest(home, m);
  };

  // ── 1. preflight: the backups (the refusals ran above, before the manifest existed) ─────────────
  if (!done("preflight")) {
    const dir = m.archiveDir;
    m.backups.settings = backupFile(join(home, "settings.json"), dir, "settings.json.bak");
    m.backups.sdkSettings = backupFile(join(sdkHomeFor(home), "settings.json"), dir, "sdk-settings.json.bak");
    m.backups.sdkGlobal = backupFile(join(sdkHomeFor(home), ".winter.json"), dir, "sdk-winter.json.bak");
    m.backups.splitMarker = backupFile(settingsSplitMarkerPath(home), dir, "settings-split.json.bak");
    if (existsSync(join(home, "runtimes", "runtime-state.db"))) {
      const rs = openRuntimeStateDb(home);
      try { m.backups.runtimeState = rs.backup(dir); } finally { rs.close(); }
    }
    record("preflight", "done");
  }

  // ── 3. move-dirs: same-volume renames into sdk/, a relative compatibility link at each old path ──
  if (!done("move-dirs")) {
    for (const [name, target] of SDK_COMPAT_LINKS) {
      const from = join(home, name);
      const to = join(home, target);
      if (isSymlink(from)) continue;               // already a link (a resumed run, or never old)
      if (existsSync(from)) {
        if (existsSync(to)) {
          // bootstrap's empty placeholder gives way; anything with content means a resumed/partial run
          if (hasFiles(to)) throw new MigrationCRefused("sdk_home_migration_refused", `${to} and ${from} both have content — resolve by hand, then \`winter migrate --sdk-home --resume\``);
          rmSync(to, { recursive: true, force: true });
        }
        mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
        renameSync(from, to);
        m.moved.push({ from: name, to: target });
        writeManifest(home, m);
      } else if (m.moved.some((mv) => mv.from === name)) {
        // renamed and recorded; the link is what a crash left undone
      } else if (hasFiles(to)) {
        // renamed, then a crash before the manifest said so: preflight proved `to` empty at the start,
        // so its content can only be this move's
        m.moved.push({ from: name, to: target });
        writeManifest(home, m);
      } else {
        continue;                                   // never existed: nothing to link
      }
      symlinkSync(relative(home, to), from);
      m.links.push(name);
      writeManifest(home, m);
    }
    record("move-dirs", "done", { moved: m.moved.length });
  }

  // ── 4. copy-files: WINTER.md (or the legacy NORMA.md) and history.jsonl, into sdk/ ───────────────
  if (!done("copy-files")) {
    const sdk = sdkHomeFor(home);
    const instructions = [join(home, "WINTER.md"), join(home, "NORMA.md")].find((p) => existsSync(p) && !isSymlink(p));
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
      let outcome: MigrationCManifest["reconciled"][number]["outcome"];
      try { outcome = await deps.reconcile(root); } catch { outcome = "failed"; }
      m.reconciled.push({ root, outcome });
      writeManifest(home, m);
      deps.log(`migration C: ${root} reconciled — ${outcome}`);
    }
    record("reconcile-official-roots", m.reconciled.length === 0 ? "skipped" : "done", { roots: m.reconciled.length });
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
      if (!existsSync(src) && !isSymlink(src)) continue;
      const rel = relative(home, src);
      if (m.archived.some((a) => a.from === rel)) continue;
      const dest = join(archive, rel);
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

  // archive → back in place (reverse order)
  for (const a of [...m.archived].reverse()) {
    const from = join(home, a.to);
    const to = join(home, a.from);
    if (existsSync(from) && !existsSync(to)) { mkdirSync(dirname(to), { recursive: true }); renameSync(from, to); }
  }
  // runtime-state → the one rewrite reversed (`backend_root` back under <home>/projects)
  if (m.steps.some((st) => st.step === "runtime-state") && existsSync(join(home, "runtimes", "runtime-state.db"))) {
    const rs = openRuntimeStateDb(home);
    try {
      const sdkPrefix = `${join(sdkHomeFor(home), "projects")}/`;
      const oldPrefix = `${join(home, "projects")}/`;
      rs.db.run("UPDATE runtime_sessions SET backend_root = ? || substr(backend_root, ?) WHERE substr(backend_root, 1, ?) = ?", [oldPrefix, sdkPrefix.length + 1, sdkPrefix.length, sdkPrefix]);
    } finally { rs.close(); }
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
  deps.log(`migration C: rolled back — ${m.moved.length} director(ies) moved back; the reconcile appends stay in the canonical transcripts; backups kept under ${m.archiveDir}`);
  return m;
}
