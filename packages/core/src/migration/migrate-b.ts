// Phase 9c Migration B (WS-16 §18) — copies a legacy home wholesale into a pristine Winter home on
// first boot. Three phases, always in this order: (1) walk the legacy home and classify every file
// (copy / rekey / skip-as-disposable / rebuild-later), (2) copy bytes / rewrite settings.json,
// writing the manifest to disk after EVERY step so a crash mid-run is always resumable, (3) copy
// the known-name Keychain items. See `global-constraints.md`'s Interfaces block for the pinned
// export surface — every name below is verbatim.
import { createHash } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { SecretStore } from "../auth/secret-store";
import { MIGRATION_B_SECRET_NAMES } from "../auth/legacy-secret-names";
import { LEGACY_DEV_HOME_DIR, LEGACY_HOME_DIR, LEGACY_HOME_ENV } from "../legacy-names";
import { keychainService } from "../profile";
import type { WinterProfile } from "../profile";
import { legacyKeychainServiceFor } from "./legacy-keychain-store";
import {
  clearWorkingManifest,
  completeMarkerPath,
  readMigrationManifest,
  rolledBackManifestPath,
  writeManifestAtomic,
  type MigrationEntryStatus,
  type MigrationFileEntry,
  type MigrationKeychainEntry,
  type MigrationManifest,
} from "./manifest";
import { rekeySettings } from "./rekey-settings";

export { MIGRATION_B_SECRET_NAMES } from "../auth/legacy-secret-names";
export { readMigrationManifest, manifestFileState, manifestPath } from "./manifest";
export type { MigrationEntryStatus, MigrationFileEntry, MigrationKeychainEntry, MigrationManifest } from "./manifest";

/** Thrown by `planMigrationB` (destination not pristine, P9c-10), the daemon boot hook
 *  (`home_half_migrated`, and — fix wave C3, P9c-17 — `migration_failed` for a residual throw the
 *  daemon converts rather than crash-looping on), and the resume/rollback guards below (nothing to
 *  act on). `code` is intentionally a superset of the two names the Interfaces block pins — the
 *  extra codes are internal-only refusals that were never meant to be part of the daemon's typed
 *  boot refusal. */
export class MigrationRefused extends Error {
  constructor(
    public readonly code: "destination_not_pristine" | "home_half_migrated" | "nothing_to_resume" | "nothing_to_rollback" | "migration_failed",
    message: string,
  ) {
    super(message);
    this.name = "MigrationRefused";
  }
}

/** Fix wave C3: the tag used in the "keychain unavailable" log line — the error's `name` (for a real
 *  `Error`) or `code` (for a Node-style errno object), NEVER `err.message`, which could echo a
 *  Keychain-provided value on some store implementations. */
function errorTag(err: unknown): string {
  if (err instanceof Error) return err.name || "Error";
  if (err && typeof err === "object" && "code" in err) return String((err as { code: unknown }).code);
  return "unknown";
}

/** `legacyHomeFor` — the legacy home override env var if set, else the legacy dist/dev home
 *  directory name under the user's home, per profile (`legacy-names.ts`'s `LEGACY_HOME_ENV` /
 *  `LEGACY_HOME_DIR` / `LEGACY_DEV_HOME_DIR`). */
export function legacyHomeFor(profile: WinterProfile, env: NodeJS.ProcessEnv = process.env): string {
  const override = env[LEGACY_HOME_ENV];
  if (override) return override;
  return join(homedir(), profile === "dev" ? LEGACY_DEV_HOME_DIR : LEGACY_HOME_DIR);
}

const BOOTSTRAP_TOP_LEVEL = new Set(["agents", "hooks", "logs", "memory", "outputs", "plugins", "projects", "run", "runtimes", "sessions", "skills"]);

/** P9c-16 (whole-branch review, Critical C2): named app-owned top-level directories the pristine
 *  check tolerates WITHOUT recursing into them at all — unlike `BOOTSTRAP_TOP_LEVEL`, their content
 *  is never required to be empty. Winter.app must never write into `WINTER_HOME` before the
 *  daemon's first successful connect, but a UI marker file (today: `app-state/cli-install-offered`)
 *  is impractical to avoid — this is the ONE named exception, not a general escape hatch: any FUTURE
 *  app-side home write is a deliberate addition to this list, reviewed the same way. A legacy
 *  `app-state` directory in the SOURCE home still migrates normally (`copyFileWithHash` overwrites
 *  the destination file byte-for-byte), so tolerating it here creates no divergence. */
const TOLERATED_APP_OWNED_TOP_LEVEL = new Set(["app-state"]);

/** Review M2: known macOS/Finder noise that must never block the first-boot migration — a mere
 *  Finder browse of a fresh `~/.winter` drops a `.DS_Store` (and `.localized` on some volumes; an
 *  AppleDouble `._*` sidecar can appear from a copy/USB-transfer touching the folder) with no user
 *  action at all. Ignored ONLY at the home's TOP LEVEL — everything else (inside a bootstrap-set
 *  directory, or any other top-level name) stays exactly as strict as before. */
const IGNORED_TOP_LEVEL_NOISE = new Set([".DS_Store", ".localized"]);
function isIgnorableTopLevelNoise(name: string): boolean {
  return IGNORED_TOP_LEVEL_NOISE.has(name) || name.startsWith("._");
}

/** The full path of the first regular file/symlink/etc found inside `path` (recursing into
 *  subdirectories, sorted for determinism), or `undefined` when it is empty (or absent) all the
 *  way down. Review M2: this is the "not pristine" REASON, not just a boolean — `winter doctor`
 *  names it so the user has somewhere to look instead of a bare "not pristine" verdict. */
function firstNonEmptyEntry(path: string): string | undefined {
  let entries: string[];
  try {
    entries = readdirSync(path).sort();
  } catch {
    return undefined;
  }
  for (const name of entries) {
    const full = join(path, name);
    let st;
    try {
      st = lstatSync(full);
    } catch {
      continue; // vanished between readdir and lstat — treat as not-there
    }
    if (st.isDirectory()) {
      const nested = firstNonEmptyEntry(full);
      if (nested) return nested;
    } else {
      return full; // a file, symlink, socket, etc — not empty
    }
  }
  return undefined;
}

/** Same idea as `firstNonEmptyEntry`, for `run/` specifically — `core.lock`/`core.sock` are always
 *  tolerated there (they're the daemon's own lock/socket, expected on an otherwise-pristine home). */
function firstOffendingRunEntry(path: string): string | undefined {
  let entries: string[];
  try {
    entries = readdirSync(path).sort();
  } catch {
    return undefined;
  }
  const offender = entries.find((e) => e !== "core.lock" && e !== "core.sock");
  return offender ? join(path, offender) : undefined;
}

export interface PristineCheck {
  pristine: boolean;
  /** Full path of the first entry that made the home non-pristine. `undefined` iff `pristine`. */
  reason?: string;
}

/**
 * Full report for: an absent home, an empty directory, or a directory containing ONLY entries from
 * the bootstrap set (`agents hooks logs memory outputs plugins projects run runtimes sessions
 * skills`), each of which must itself be empty (`run/` may additionally hold `core.lock`/
 * `core.sock`) — ignoring known top-level OS noise (`isIgnorableTopLevelNoise`, review M2) and any
 * NAMED app-owned top-level directory (`TOLERATED_APP_OWNED_TOP_LEVEL`, P9c-16 — content never
 * inspected, unlike the bootstrap set). `pristine: false` the moment any OTHER entry exists
 * anywhere — at the top level, or inside a bootstrap-set directory — and `reason` names the first
 * one found, full path.
 */
export function describeHomePristineness(home: string): PristineCheck {
  let topEntries: string[];
  try {
    topEntries = readdirSync(home).sort();
  } catch {
    return { pristine: true }; // absent
  }
  for (const entry of topEntries) {
    if (isIgnorableTopLevelNoise(entry)) continue; // Finder/AppleDouble noise — never blocks migration
    if (TOLERATED_APP_OWNED_TOP_LEVEL.has(entry)) continue; // P9c-16: app-owned UI markers — content never inspected
    if (!BOOTSTRAP_TOP_LEVEL.has(entry)) return { pristine: false, reason: join(home, entry) };
    const full = join(home, entry);
    let st;
    try {
      st = lstatSync(full);
    } catch {
      continue;
    }
    if (!st.isDirectory()) return { pristine: false, reason: full }; // a FILE named e.g. "sessions"
    const offender = entry === "run" ? firstOffendingRunEntry(full) : firstNonEmptyEntry(full);
    if (offender) return { pristine: false, reason: offender };
  }
  return { pristine: true };
}

export function isPristineHome(home: string): boolean {
  return describeHomePristineness(home).pristine;
}

// ── Planning ─────────────────────────────────────────────────────────────────────────────────────

export interface MigrationPlanFileEntry {
  src: string;
  dest: string;
  status: MigrationEntryStatus;
}

export interface MigrationPlan {
  legacyHome: string;
  home: string;
  profile: WinterProfile;
  entries: MigrationPlanFileEntry[];
}

interface WalkedFile {
  rel: string;
  abs: string;
  isRegular: boolean;
}

/** Depth-first, sorted-per-directory walk of every non-directory entry under `root` (deterministic
 *  order — the "resume produces a byte-identical manifest" test depends on it). A non-regular entry
 *  (symlink, socket, fifo) is still yielded (so the plan accounts for it) but flagged
 *  `isRegular: false` — it is never followed and never copied. */
function walkLegacyHome(root: string, sub = ""): WalkedFile[] {
  const absDir = sub ? join(root, sub) : root;
  let names: string[];
  try {
    names = readdirSync(absDir).sort();
  } catch {
    return [];
  }
  const out: WalkedFile[] = [];
  for (const name of names) {
    const rel = sub ? `${sub}/${name}` : name;
    const abs = join(absDir, name);
    let st;
    try {
      st = lstatSync(abs);
    } catch {
      continue; // vanished mid-walk
    }
    if (st.isDirectory()) out.push(...walkLegacyHome(root, rel));
    else out.push({ rel, abs, isRegular: st.isFile() });
  }
  return out;
}

/** The disposable-set classification (Task M Step 1, verbatim): anything under `run/`, any file
 *  named `index.db` at any depth, any `*.db-shm`/`*.db-wal`, anything under `logs/` or `cache/`, and
 *  top-level `daemon.log` are never copied byte-for-byte; top-level `settings.json` is re-keyed
 *  rather than copied verbatim; everything else, copied. A non-regular source (symlink/socket/etc)
 *  is always `"skipped"`, regardless of path. */
function classify(rel: string, isRegular: boolean): MigrationEntryStatus {
  if (!isRegular) return "skipped";
  if (rel === "settings.json") return "rekeyed";
  if (rel === "daemon.log") return "skipped";
  if (rel.startsWith("run/") || rel.startsWith("logs/") || rel.startsWith("cache/")) return "skipped";
  const base = rel.slice(rel.lastIndexOf("/") + 1);
  if (base === "index.db") return "rebuilt";
  if (base.endsWith(".db-shm") || base.endsWith(".db-wal")) return "skipped";
  return "copied";
}

/** The pristine-refusal-free planner — `resumeMigrationB` needs this to re-derive an in-progress
 *  run's plan against a destination that is, by definition, no longer pristine. `planMigrationB`
 *  below is this plus the P9c-10 refusal for every OTHER caller. */
function buildPlan(input: { legacyHome: string; home: string; profile: WinterProfile }): MigrationPlan {
  const files = walkLegacyHome(input.legacyHome);
  const entries: MigrationPlanFileEntry[] = files.map(({ rel, isRegular }) => ({
    src: join(input.legacyHome, rel),
    dest: join(input.home, rel),
    status: classify(rel, isRegular),
  }));
  return { legacyHome: input.legacyHome, home: input.home, profile: input.profile, entries };
}

export async function planMigrationB(input: { legacyHome: string; home: string; profile: WinterProfile }): Promise<MigrationPlan> {
  if (!isPristineHome(input.home)) {
    throw new MigrationRefused(
      "destination_not_pristine",
      `${input.home} is not a pristine Winter home — move it aside, e.g. \`mv ${input.home} ${input.home}.bak\`, then retry`,
    );
  }
  return buildPlan(input);
}

// ── Execution ────────────────────────────────────────────────────────────────────────────────────

export interface MigrationDeps {
  from: SecretStore;
  to: SecretStore;
  log: (line: string) => void;
  /** TEST ONLY: called immediately before the step at `index` executes; a throw aborts the run at
   *  exactly that point, with every earlier step's manifest entry already durably written to disk.
   *  Production callers never set this. */
  beforeEntry?: (step: { kind: "file"; index: number; entry: MigrationPlanFileEntry } | { kind: "keychain"; index: number; name: string }) => void;
}

function sha256OfBuffer(s: string | Buffer): string {
  return createHash("sha256").update(s).digest("hex");
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const rs = createReadStream(path);
    rs.on("data", (chunk) => hash.update(chunk));
    rs.on("end", () => resolve());
    rs.on("error", reject);
  });
  return hash.digest("hex");
}

/** Streams `src` into `dest` (creating parent dirs as needed), hashing as it goes, and preserves
 *  the source file's mode bits on the copy. */
async function copyFileWithHash(src: string, dest: string): Promise<{ sha256: string; bytes: number }> {
  mkdirSync(dirname(dest), { recursive: true });
  const hash = createHash("sha256");
  let bytes = 0;
  await new Promise<void>((resolve, reject) => {
    const rs = createReadStream(src);
    const ws = createWriteStream(dest);
    rs.on("data", (chunk) => {
      hash.update(chunk);
      bytes += chunk.length;
    });
    rs.on("error", reject);
    ws.on("error", reject);
    ws.on("finish", () => resolve());
    rs.pipe(ws);
  });
  try {
    chmodSync(dest, statSync(src).mode);
  } catch {
    /* best-effort */
  }
  return { sha256: hash.digest("hex"), bytes };
}

async function executeFileEntry(plan: MigrationPlanFileEntry): Promise<MigrationFileEntry> {
  const { src, dest, status } = plan;
  if (status === "copied") {
    const { sha256, bytes } = await copyFileWithHash(src, dest);
    return { src, dest, sha256, bytes, status };
  }
  if (status === "rekeyed") {
    const raw = readFileSync(src, "utf8");
    let out = raw;
    try {
      out = `${JSON.stringify(rekeySettings(JSON.parse(raw)).out, null, 2)}\n`;
    } catch {
      /* unparseable settings.json — carry it forward verbatim rather than lose it */
    }
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, out, { mode: 0o600 });
    return { src, dest, sha256: sha256OfBuffer(out), bytes: Buffer.byteLength(out), status };
  }
  // "skipped" | "rebuilt": never read or copy bytes (a disposable/journal file, or one the runtime
  // recreates on its own). No provenance hash to record.
  return { src, dest, sha256: "", bytes: 0, status };
}

async function migrateOneSecret(name: string, deps: Pick<MigrationDeps, "from" | "to" | "log">, fromService: string, toService: string): Promise<MigrationKeychainEntry> {
  // Check the DESTINATION first — P9c-10 never overwrites an existing destination item, and this
  // also means an already-present item's legacy value is never even read.
  const existing = await deps.to.get(name);
  if (existing !== null) return { name, from: fromService, to: toService, status: "skipped-existing" };
  // P9c-17 (fix wave C3, Critical): a Keychain failure reading the LEGACY item or writing the
  // destination item is per-item and non-fatal — one refused item must never abort the whole
  // migration run. Recorded exactly like a genuine absence (the pinned `MigrationKeychainStatus`
  // union has no separate "failed" state); the distinct log line is what preserves the failure for
  // an operator. Never logs `err.message` — only `name` and the error's own `name`/`code` — a
  // Keychain error message can echo back material on some store implementations.
  try {
    const value = await deps.from.get(name);
    if (value === null) return { name, from: fromService, to: toService, status: "absent" };
    await deps.to.set(name, value);
    return { name, from: fromService, to: toService, status: "copied" };
  } catch (err) {
    deps.log(`keychain unavailable: ${name} (${errorTag(err)})`);
    return { name, from: fromService, to: toService, status: "absent" };
  }
}

function freshManifest(plan: MigrationPlan): MigrationManifest {
  return {
    schemaVersion: 1,
    startedAt: new Date().toISOString(),
    legacyHome: plan.legacyHome,
    home: plan.home,
    profile: plan.profile,
    status: "in-progress",
    entries: [],
    keychain: [],
  };
}

async function execute(plan: MigrationPlan, deps: MigrationDeps, resumeFrom?: MigrationManifest): Promise<MigrationManifest> {
  const manifest = resumeFrom ?? freshManifest(plan);
  // Written BEFORE the first step executes — a crash before entry #0 even runs still leaves an
  // "in-progress" manifest on disk, so the boot hook refuses on the very next boot rather than
  // silently re-attempting on a partially-created destination.
  if (!resumeFrom) writeManifestAtomic(plan.home, manifest);

  const doneFiles = new Set(manifest.entries.map((e) => `${e.src}\0${e.dest}`));
  const doneKeychain = new Set(manifest.keychain.map((k) => k.name));
  const fromService = legacyKeychainServiceFor(plan.profile);
  const toService = keychainService(plan.profile);

  let index = 0;
  for (const planEntry of plan.entries) {
    if (doneFiles.has(`${planEntry.src}\0${planEntry.dest}`)) {
      index++;
      continue;
    }
    deps.beforeEntry?.({ kind: "file", index, entry: planEntry });
    const result = await executeFileEntry(planEntry);
    manifest.entries.push(result);
    writeManifestAtomic(plan.home, manifest);
    deps.log(`file ${result.status}: ${result.dest}`);
    index++;
  }

  index = 0;
  for (const name of MIGRATION_B_SECRET_NAMES) {
    if (doneKeychain.has(name)) {
      index++;
      continue;
    }
    deps.beforeEntry?.({ kind: "keychain", index, name });
    const result = await migrateOneSecret(name, deps, fromService, toService);
    manifest.keychain.push(result);
    writeManifestAtomic(plan.home, manifest);
    deps.log(`keychain ${result.status}: ${name}`); // NEVER the value — `name` only
    index++;
  }

  manifest.finishedAt = new Date().toISOString();
  manifest.status = "complete";
  writeManifestAtomic(plan.home, manifest);
  writeFileSync(completeMarkerPath(plan.home), "");
  const copied = manifest.entries.filter((e) => e.status === "copied" || e.status === "rekeyed").length;
  const kcCopied = manifest.keychain.filter((k) => k.status === "copied").length;
  const kcSkipped = manifest.keychain.filter((k) => k.status === "skipped-existing").length;
  deps.log(`complete: ${copied} files, ${kcCopied + kcSkipped} keychain items (${kcCopied} copied, ${kcSkipped} skipped-existing)`);
  return manifest;
}

export async function runMigrationB(plan: MigrationPlan, deps: MigrationDeps): Promise<MigrationManifest> {
  return execute(plan, deps);
}

/** Continues an interrupted run found at `<home>/migration/manifest.json` — re-derives the SAME
 *  plan from the manifest's own recorded `legacyHome`/`home`/`profile` (bypassing the pristine
 *  refusal: the destination is, correctly, no longer pristine mid-run) and skips every step already
 *  present in the manifest. */
export async function resumeMigrationB(home: string, deps: MigrationDeps): Promise<MigrationManifest> {
  const existing = readMigrationManifest(home);
  if (!existing || existing.status !== "in-progress") {
    throw new MigrationRefused("nothing_to_resume", `no in-progress migration found at ${home} to resume`);
  }
  const plan = buildPlan({ legacyHome: existing.legacyHome, home: existing.home, profile: existing.profile });
  return execute(plan, deps, existing);
}

/**
 * Undoes a migration: removes every destination file this run actually wrote (`copied`/`rekeyed`
 * entries) — but ONLY when the destination's current content still hashes to the value this run
 * recorded, so a file the daemon has since written through (a new session, a settings edit) is left
 * alone and reported, never silently destroyed. `rebuilt` entries (e.g. `sessions/index.db`) carry
 * no recorded hash — migration never wrote them in the first place, so a `rebuilt`-entry dest that
 * exists at rollback time can only be something the DAEMON later rebuilt from real session data, and
 * it is deleted UNCONDITIONALLY (no hash guard is possible with nothing to compare against). This is
 * non-destructive by construction: the same rebuild runs again, from the same untouched JSONL, the
 * next time that store opens — never a second copy of the guard the OTHER two statuses get. Never
 * touches the legacy home. Ends with the working `manifest.json`/`COMPLETE` cleared and a final
 * `status: "rolled-back"` copy at `manifest.rolled-back.json`, inside the same `migration/` directory.
 *
 * Fix wave M1 (review Minor) — RULING: rollback needs a READABLE manifest. `readMigrationManifest`
 * (below) reads absent and unreadable/corrupt alike as `null`, so an UNREADABLE manifest hits the
 * exact same `nothing_to_rollback` refusal as no manifest at all — there is no partial-entry
 * fallback to salvage from a manifest this function cannot even parse. The daemon boot hook's
 * `unreadable` refusal message (`daemon.ts`) therefore never points an operator at `--rollback` as
 * the FIRST move for that flavour — moving the corrupt file aside and re-running from scratch is;
 * `--rollback` only helps once files are known to have already been copied. `winter migrate
 * --status` is the one place that surfaces the `unreadable` state explicitly (via
 * `manifestFileState`, not `readMigrationManifest`), rather than reporting it as "never run".
 */
export async function rollbackMigrationB(home: string, deps: { log: (line: string) => void }): Promise<MigrationManifest> {
  const manifest = readMigrationManifest(home);
  if (!manifest) {
    throw new MigrationRefused("nothing_to_rollback", `no migration manifest found at ${home} to roll back`);
  }
  for (const entry of manifest.entries) {
    if (entry.status !== "copied" && entry.status !== "rekeyed" && entry.status !== "rebuilt") continue;
    let st;
    try {
      st = statSync(entry.dest);
    } catch {
      continue; // already absent
    }
    if (!st.isFile()) continue;
    const currentHash = entry.sha256 ? await hashFile(entry.dest) : "";
    if (entry.sha256 && currentHash !== entry.sha256) {
      deps.log(`rollback: kept ${entry.dest} (modified since migration — hash mismatch)`);
      continue;
    }
    try {
      unlinkSync(entry.dest);
      deps.log(`rollback: removed ${entry.dest}`);
    } catch {
      /* already gone */
    }
  }
  const rolledBack: MigrationManifest = { ...manifest, status: "rolled-back", finishedAt: new Date().toISOString() };
  clearWorkingManifest(home);
  writeFileSync(rolledBackManifestPath(home), `${JSON.stringify(rolledBack, null, 2)}\n`, { mode: 0o600 });
  deps.log("rollback: complete");
  return rolledBack;
}
