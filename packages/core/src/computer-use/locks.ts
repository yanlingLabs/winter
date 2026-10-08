// ComputerV2 (2026-10-08) — the per-target locks that replace concurrency lanes (spec §14). The tool is
// concurrency-safe with no lane, so the daemon owns the exclusivity:
//
//   - an app is locked by bundle id + pid, ACROSS SESSIONS (Dispatch children share the user's apps), from a
//     script's first primitive on it until the script ends;
//   - a waiter waits at most 30 s (less when the script's own timeout is nearer), then fails `TargetBusy`
//     naming the session that holds it — which also breaks a cross-app deadlock between two scripts;
//   - one GLOBAL foreground lock serializes rung-4 input (the user's real pointer) and whole-screen shots.
//
// Re-entrant per run: a script that touches its own target again never waits on itself.
import { AutomationFailure } from "./errors";

export const LOCK_WAIT_MS = 30_000;
export const FOREGROUND_LOCK_KEY = "\u0000foreground";

export interface LockOwner { runId: string; sessionId: string }

interface Held { owner: LockOwner; depth: number; waiters: Array<{ owner: LockOwner; grant(): void }> }

export class TargetLocks {
  private readonly held = new Map<string, Held>();

  /** Who holds `key` right now (tests, diagnostics). */
  holder(key: string): LockOwner | undefined { return this.held.get(key)?.owner; }

  /**
   * Acquire `key` for `owner`. Resolves to a release function (idempotent). Rejects `TargetBusy` after
   * `waitMs`, or `Cancelled` when `signal` aborts first.
   */
  acquire(key: string, owner: LockOwner, opts: { waitMs?: number; signal?: AbortSignal; label: string }): Promise<() => void> {
    const current = this.held.get(key);
    if (current === undefined) {
      this.held.set(key, { owner, depth: 1, waiters: [] });
      return Promise.resolve(this.releaser(key, owner));
    }
    if (current.owner.runId === owner.runId) {
      current.depth++;
      return Promise.resolve(this.releaser(key, owner));
    }
    const waitMs = opts.waitMs ?? LOCK_WAIT_MS;
    return new Promise((resolve, reject) => {
      let settled = false;
      const entry = {
        owner,
        grant: () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          opts.signal?.removeEventListener("abort", onAbort);
          resolve(this.releaser(key, owner));
        },
      };
      const leave = (err: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
        const h = this.held.get(key);
        if (h !== undefined) h.waiters = h.waiters.filter((w) => w !== entry);
        reject(err);
      };
      const timer = setTimeout(() => {
        const by = this.held.get(key)?.owner.sessionId ?? "another session";
        leave(new AutomationFailure("TargetBusy", `${opts.label} is in use by session ${by} — wait for it to finish, or work on another app`));
      }, waitMs);
      const onAbort = (): void => leave(new AutomationFailure("Cancelled", "the script was cancelled while waiting for a lock"));
      if (opts.signal?.aborted) { onAbort(); return; }
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      current.waiters.push(entry);
    });
  }

  private releaser(key: string, owner: LockOwner): () => void {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const h = this.held.get(key);
      if (h === undefined || h.owner.runId !== owner.runId) return;
      if (--h.depth > 0) return;
      const next = h.waiters.shift();
      if (next === undefined) { this.held.delete(key); return; }
      h.owner = next.owner;
      h.depth = 1;
      next.grant();
    };
  }
}
