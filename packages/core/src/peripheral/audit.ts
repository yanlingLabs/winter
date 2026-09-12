import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** Append-only JSONL audit trail for the peripheral lease machinery (spec §A1: "every
 *  acquire/renew-failure/release/revoke/panic is an audit-log line with requester identity,
 *  class, and lease id"). Every line is stamped with the WRITE-time `ts` (the caller's `entry`
 *  cannot override it — a caller-supplied `ts` field is silently clobbered).
 *
 *  mkdir-safe: the parent directory is created (recursive) lazily on first successful write,
 *  not in the constructor — so a broken WINTER_HOME never surfaces as a constructor throw, only
 *  as a logged write failure the next time append() is called.
 *
 *  Write errors (mkdir or the append itself) are logged to stderr and swallowed, never thrown:
 *  the lease action the audit line describes has already happened (or is happening) by the time
 *  append() runs, so a failure to record it must not unwind the broker's public surface — see
 *  PeripheralBroker's "typed results, never throw" convention. */
export class AuditLog {
  private dirEnsured = false;

  constructor(private readonly path: string) {}

  append(entry: Record<string, unknown>): void {
    try {
      if (!this.dirEnsured) {
        mkdirSync(dirname(this.path), { recursive: true });
        this.dirEnsured = true;
      }
      appendFileSync(this.path, JSON.stringify({ ...entry, ts: Date.now() }) + "\n");
    } catch (e) {
      console.error(`[audit] write failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
