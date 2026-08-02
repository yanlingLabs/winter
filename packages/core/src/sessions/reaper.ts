import { appendCleanerLog } from "./cleaner-log";

/** session-activity-hygiene T6: the exact slice of `SessionStore` the reaper needs — a narrow
 *  structural interface (the `ActivityEnforcementDeps`/`ActivityRow` precedent, activity-
 *  enforcement.ts/activity.ts) rather than the concrete class, so a test can inject a minimal fake
 *  to exercise failure paths a real sqlite/fs-backed store doesn't make easy to provoke on demand.
 *  A real `SessionStore` already has all three members with compatible signatures, so every
 *  production caller (daemon.ts, ipc/server.ts) passes its real store with no adapter. */
export interface ReaperStore {
  emptySessionIds(attachedCount: (sessionId: string) => number, nowMs: number): string[];
  getTitle(sessionId: string): string | null;
  deleteSession(sessionId: string): void;
}

export interface ReaperDeps {
  store: ReaperStore;
  /** `SessionHub.attachedCount`, injected — see `ReaperStore`'s own doc comment for why the store
   *  never holds this itself. */
  attachedCount: (sessionId: string) => number;
  /** `<home>/cleaner.jsonl` — the SAME normaHome the store itself was constructed with, in every
   *  real caller (daemon.ts's `dirs.home`). Passed explicitly (not read off the store) so a test can
   *  point it anywhere without a second store accessor. */
  home: string;
  /** Injectable clock (the `ActivityEnforcementDeps.now` precedent,
   *  test/sessions/activity-enforcement.test.ts) — defaults to the real `Date.now` so production
   *  callers pass nothing and every test controls "how old" without a real sleep. */
  now?: () => number;
}

/**
 * session-activity-hygiene T6 (spec §2): one reap pass over every empty, sufficiently-old,
 * unattended session `store.emptySessionIds` reports — delete, then best-effort audit (controller
 * ruling: delete first, log second; a failed log write is a logged warning, never a reason to undo
 * or retry the delete — the delete already happened, and retrying it would just throw "unknown
 * session" on the very next attempt). Shared by the two callers that need identical behavior (the
 * mint-time sweep after `session.create`'s reply, and the once-at-boot sweep in daemon.ts) so the
 * order and the failure handling live in exactly one place, never two copies that could drift.
 *
 * Never throws. A failure reaping one candidate is logged and the pass moves on to the next one
 * (mirrors activity-enforcement.ts's `sweep()` — one bad session must not abort a shared pass), and
 * a failure computing the candidate set AT ALL degrades to "reaped nothing this pass" rather than
 * propagating — required at the mint-time call site, which must never fail a `session.create` reply
 * over unrelated hygiene, and harmless at the boot call site, which has nothing to protect but
 * shouldn't fail daemon startup over it either.
 *
 * Returns the reaped ids — tests/observability only; neither caller depends on the return value.
 */
export function reapEmptySessions(deps: ReaperDeps): string[] {
  const now = deps.now ?? Date.now;
  const reaped: string[] = [];

  let candidates: string[];
  try {
    candidates = deps.store.emptySessionIds(deps.attachedCount, now());
  } catch (err) {
    console.error("[reaper] candidate query failed:", err);
    return reaped;
  }

  for (const sessionId of candidates) {
    let title: string | undefined;
    try {
      title = deps.store.getTitle(sessionId) ?? undefined; // read BEFORE delete — the row won't exist after
      deps.store.deleteSession(sessionId);
    } catch (err) {
      console.error(`[reaper] failed to reap ${sessionId}:`, err);
      continue;
    }
    reaped.push(sessionId);
    try {
      appendCleanerLog(deps.home, { sessionId, title, reason: "reaped: empty", date: new Date(now()).toISOString() });
    } catch (err) {
      console.error(`[reaper] audit log append failed for ${sessionId}:`, err);
    }
  }

  return reaped;
}
