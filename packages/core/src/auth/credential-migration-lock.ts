// WS-27 review: the ONE lock every Keychain shadow pass and migration of a home runs under.
//
// The daemon's boot lock (`lock.ts`) cannot serve: it treats a live pid whose socket does not answer as
// stale, and a booting daemon has no socket until well after its Keychain work — so a second daemon (or a
// transition, which never listens at all) could run recovery and drop a shadow that a first one's in-flight
// migration still needs. This lock is judged on the HOLDER PROCESS alone: an exclusive file
// `<home>/run/credential-migration.lock` naming its holder's pid AND that process's start time
// (`ps -o lstart=`), stale exactly when that pid is gone or now belongs to a process started at another time
// (a reused pid). It is created ATOMICALLY with its content (written to a temp file, then `link`ed into
// place), so a reader never sees it empty; an unreadable one younger than `UNREADABLE_GRACE_MS` is taken to
// be held. A file naming THIS pid is stale unless this process took it (a previous process with our pid).
//
// Held around: the daemon's early restore pass through its credential migration and the pairing-token
// passes (a daemon that finds it held WAITS, bounded, then refuses to boot — `waitForCredentialMigrationLock`);
// the dev transition's whole run (the adopt child checks its PARENT holds it before acting).
import { spawnSync } from "node:child_process";
import { linkSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function credentialMigrationLockPath(home: string): string {
  return join(home, "run", "credential-migration.lock");
}

export interface CredentialMigrationLock {
  release(): void;
}

/** A lock file this young that cannot be parsed is being written (or was, by a process that died at once):
 *  held, not stale. */
export const UNREADABLE_GRACE_MS = 5_000;

/** Homes whose lock THIS process took (and has not released) — what tells our own lock from a dead
 *  process's that happened to have our pid. */
const takenHere = new Set<string>();

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists, it is just not ours to signal.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** A process's start time as `ps` prints it (`lstart`), or `undefined` when it cannot be asked. */
export function processStartTime(pid: number): string | undefined {
  const r = spawnSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 2_000 });
  const text = (r.stdout ?? "").trim();
  return r.status === 0 && text !== "" ? text : undefined;
}

interface LockRecord {
  pid: number;
  start?: string;
}

function readRecord(home: string): LockRecord | undefined {
  try {
    const parsed = JSON.parse(readFileSync(credentialMigrationLockPath(home), "utf8")) as { pid?: unknown; start?: unknown };
    if (typeof parsed.pid !== "number" || !Number.isInteger(parsed.pid) || parsed.pid <= 0) return undefined;
    return { pid: parsed.pid, ...(typeof parsed.start === "string" ? { start: parsed.start } : {}) };
  } catch {
    return undefined;
  }
}

/** The pid named in the lock file, or `undefined` (absent or unreadable). */
export function credentialMigrationLockHolder(home: string): number | undefined {
  return readRecord(home)?.pid;
}

/** Is the process a record names still the one that wrote it? */
function recordLive(home: string, record: LockRecord, startOf: (pid: number) => string | undefined): boolean {
  if (record.pid === process.pid) return takenHere.has(home);
  if (!alive(record.pid)) return false;
  if (record.start === undefined) return true; // an older record: pid liveness is all there is
  const now = startOf(record.pid);
  return now === undefined || now === record.start; // cannot ask: held (the safe side)
}

/**
 * Takes the lock, or answers who holds it (`{ heldBy }`; `-1` when that is not yet readable). Stale files are
 * replaced; the create itself is exclusive (`link` fails when the name exists), so two takers cannot both win.
 * `startOf` is injectable for tests.
 */
export function acquireCredentialMigrationLock(home: string, deps: { startOf?: (pid: number) => string | undefined } = {}): CredentialMigrationLock | { heldBy: number } {
  const startOf = deps.startOf ?? processStartTime;
  const path = credentialMigrationLockPath(home);
  mkdirSync(join(home, "run"), { recursive: true, mode: 0o700 });
  const start = startOf(process.pid);
  const content = JSON.stringify({ pid: process.pid, ...(start !== undefined ? { start } : {}), startedAt: Date.now() });
  for (let attempt = 0; attempt < 3; attempt++) {
    const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    writeFileSync(tmp, content, { mode: 0o600 });
    try {
      linkSync(tmp, path);
      takenHere.add(home);
      return {
        release() {
          takenHere.delete(home);
          if (readRecord(home)?.pid !== process.pid) return; // not ours (any more)
          try { unlinkSync(path); } catch { /* gone */ }
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    } finally {
      try { unlinkSync(tmp); } catch { /* gone */ }
    }
    const record = readRecord(home);
    if (record === undefined) {
      let age = Number.POSITIVE_INFINITY;
      try { age = Date.now() - statSync(path).mtimeMs; } catch { continue; /* gone: try the create again */ }
      if (age < UNREADABLE_GRACE_MS) return { heldBy: -1 };
    } else if (recordLive(home, record, startOf)) {
      return { heldBy: record.pid };
    }
    // Stale. Move it aside (atomic) rather than unlinking by name: a racer may have replaced it with a live
    // lock between our read and now, and a blind unlink would delete THAT one.
    const aside = `${path}.${process.pid}.stale`;
    try { renameSync(path, aside); } catch { continue; /* a racer moved it first: try the create again */ }
    let moved: LockRecord | undefined;
    try {
      const parsed = JSON.parse(readFileSync(aside, "utf8")) as LockRecord;
      moved = typeof parsed.pid === "number" ? parsed : undefined;
    } catch { moved = undefined; }
    if (moved !== undefined && (record === undefined || moved.pid !== record.pid || moved.start !== record.start) && recordLive(home, moved, startOf)) {
      // We moved a live racer's lock: put it back (exclusively) and defer to it.
      try { linkSync(aside, path); } catch { /* another lock is there now */ }
      try { unlinkSync(aside); } catch { /* gone */ }
      return { heldBy: moved.pid };
    }
    try { unlinkSync(aside); } catch { /* gone */ }
  }
  return { heldBy: credentialMigrationLockHolder(home) ?? -1 };
}

/** A boot that could not get the lock within its bound: refused, typed, before any credential is read. */
export class CredentialMigrationBusy extends Error {
  readonly code = "credential_migration_busy" as const;
  constructor(readonly heldBy: number, waitedMs: number) {
    super(`keychain: ${heldBy > 0 ? `pid ${heldBy}` : "another process"} has held the credential migration lock for ${Math.round(waitedMs / 1000)} s (a daemon booting, or a dev Keychain transition) — not booting without its shadow recovery; start again once it has finished`);
    this.name = "CredentialMigrationBusy";
  }
}

/** How long a booting daemon waits for the lock before it refuses. */
export const CREDENTIAL_MIGRATION_LOCK_WAIT_MS = 60_000;

/**
 * The daemon's door: take the lock, waiting (bounded) while a live process holds it; throw
 * `CredentialMigrationBusy` if it is still held at the end — never return without it.
 */
export async function waitForCredentialMigrationLock(home: string, deps: {
  waitMs?: number;
  pollMs?: number;
  acquire?: (home: string) => CredentialMigrationLock | { heldBy: number };
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (line: string) => void;
} = {}): Promise<CredentialMigrationLock> {
  const acquire = deps.acquire ?? ((h: string) => acquireCredentialMigrationLock(h));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const waitMs = deps.waitMs ?? CREDENTIAL_MIGRATION_LOCK_WAIT_MS;
  const started = now();
  let logged = false;
  for (;;) {
    const taken = acquire(home);
    if (!("heldBy" in taken)) return taken;
    const waited = now() - started;
    if (waited >= waitMs) throw new CredentialMigrationBusy(taken.heldBy, waited);
    if (!logged) {
      deps.log?.(`keychain: ${taken.heldBy > 0 ? `pid ${taken.heldBy}` : "another process"} holds the credential migration lock — waiting up to ${Math.round(waitMs / 1000)} s`);
      logged = true;
    }
    await sleep(deps.pollMs ?? 250);
  }
}
