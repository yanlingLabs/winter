import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

/** Append-only JSONL audit trail for the routine scheduler (phase 5 routines, design doc §2:
 *  "every fire/defer/error appends an audit line to ~/.winter/routines-audit.jsonl"). Mirrors
 *  peripheral/audit.ts's AuditLog byte-for-byte — see that file's doc comment for the full
 *  rationale; the short version: every line is stamped with the WRITE-time `ts` (a caller-supplied
 *  `ts` field is silently clobbered), the parent directory is created lazily on first successful
 *  write (not in the constructor), and write errors (mkdir or append) are logged to stderr and
 *  swallowed, never thrown — the fire/defer/error the audit line describes has already happened
 *  (or is happening) by the time append() runs, so a failed audit write must not unwind the
 *  scheduler's tick loop. Kept as its own class (not a re-export of peripheral's AuditLog) so the
 *  two subsystems stay independently evolvable, matching how routines/store.ts doesn't reuse
 *  sessions/store.ts either. */
export class RoutineAuditLog {
  private dirEnsured = false;

  constructor(private readonly path: string) {}

  append(entry: object): void {
    try {
      if (!this.dirEnsured) {
        mkdirSync(dirname(this.path), { recursive: true });
        this.dirEnsured = true;
      }
      appendFileSync(this.path, JSON.stringify({ ...entry, ts: Date.now() }) + "\n");
    } catch (e) {
      console.error(`[routines-audit] write failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

/** Standalone default path (~/.winter/routines-audit.jsonl) — daemon.ts overrides this with the
 *  bootstrapped winterHome-relative path instead (mirrors routines/store.ts's openRoutineStore
 *  default, which is likewise only for standalone/no-daemon-wiring use). */
export function defaultRoutinesAuditPath(): string {
  return join(homedir(), ".winter", "routines-audit.jsonl");
}
