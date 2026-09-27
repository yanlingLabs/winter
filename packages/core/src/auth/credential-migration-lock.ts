// WS-27 review: the ONE lock every Keychain shadow pass and migration of a home runs under.
//
// The daemon's boot lock (`lock.ts`) cannot serve: it treats a live pid whose socket does not answer as
// stale, and a booting daemon has no socket until well after its Keychain work — so a second daemon (or a
// transition, which never listens at all) could run recovery and drop a shadow that a first one's in-flight
// migration still needs. This lock is judged on PID LIVENESS ONLY: an O_EXCL file
// `<home>/run/credential-migration.lock` naming its holder, stale exactly when that pid is gone. A process
// that finds it held by a live pid does no shadow pass and no migration at all (one log line).
//
// Held around: the daemon's pre-lock restore pass through its credential migration and the pairing-token
// passes; the dev transition's whole run (the adopt child checks its PARENT holds it before acting).
import { linkSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function credentialMigrationLockPath(home: string): string {
  return join(home, "run", "credential-migration.lock");
}

export interface CredentialMigrationLock {
  release(): void;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists, it is just not ours to signal.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The pid named in the lock file, or `undefined` (absent or unreadable). */
export function credentialMigrationLockHolder(home: string): number | undefined {
  try {
    const pid = (JSON.parse(readFileSync(credentialMigrationLockPath(home), "utf8")) as { pid?: unknown }).pid;
    return typeof pid === "number" && Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Takes the lock, or answers who holds it (`{ heldBy }`, a live pid). A file naming a dead pid, or none, is
 * stale and replaced; the create itself is exclusive, so two takers cannot both win.
 */
export function acquireCredentialMigrationLock(home: string, pid: number = process.pid): CredentialMigrationLock | { heldBy: number } {
  const path = credentialMigrationLockPath(home);
  mkdirSync(join(home, "run"), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      writeFileSync(path, JSON.stringify({ pid, startedAt: Date.now() }), { flag: "wx", mode: 0o600 });
      return {
        release() {
          if (credentialMigrationLockHolder(home) !== pid) return; // not ours (any more)
          try { unlinkSync(path); } catch { /* gone */ }
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const holder = credentialMigrationLockHolder(home);
      if (holder !== undefined && holder !== pid && alive(holder)) return { heldBy: holder };
      if (holder === pid) return { heldBy: pid }; // a second take in this process: never re-entrant
      // Stale. Move it aside (atomic) rather than unlinking by name: a racer may have replaced it with a
      // live lock between our read and now, and a blind unlink would delete THAT one.
      const aside = `${path}.${pid}.stale`;
      try { renameSync(path, aside); } catch { continue; /* a racer moved it first: try the create again */ }
      let moved: number | undefined;
      try { moved = (JSON.parse(readFileSync(aside, "utf8")) as { pid?: number }).pid; } catch { moved = undefined; }
      if (moved !== undefined && moved !== holder && alive(moved)) {
        // We moved a live racer's lock: put it back (exclusively) and defer to it.
        try { linkSync(aside, path); } catch { /* another lock is there now */ }
        try { unlinkSync(aside); } catch { /* gone */ }
        return { heldBy: moved };
      }
      try { unlinkSync(aside); } catch { /* gone */ }
    }
  }
  const holder = credentialMigrationLockHolder(home);
  return { heldBy: holder ?? -1 };
}
