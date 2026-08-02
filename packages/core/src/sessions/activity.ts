import type { SessionActivity } from "@norma/protocol";
import type { SessionRow } from "./store";

/** The four lifecycle states (spec §1). Aliased from the protocol's `SessionActivity` rather than
 *  re-typed: `session.list` serves this value, so a second hand-written union here would be a
 *  parity list nobody registered as one. */
export type Activity = SessionActivity;

/** Spec §1.2's auto-demotion window: a session continuously ACTIVE for longer than this becomes
 *  background. Its whole purpose is surfacing the invisible runner — a turn on a sleep→reason loop
 *  that has held a session "active" for a day is not what a user means by active. */
export const ACTIVE_DEMOTION_MS = 24 * 60 * 60 * 1000;

/** Live inputs to the derivation. Everything here is a SIGNAL the daemon already owns — nothing in
 *  this shape is persisted (the two persisted bits are `SessionRow.backgrounded`/`.archived`).
 *
 *  Kept as one named shape rather than positional args so a new signal is an additive field with a
 *  compile error at every builder, not a silently-defaulted parameter. */
export interface ActivitySignals {
  /** A turn is executing right now — `AgentEngine.isRunning(sessionId)`. */
  turnRunning: boolean;
  /** Live harness attachments — `SessionHub.attachedCount(sessionId)`. Zero is common and real
   *  (a scheduled routine runs completely unattended). */
  attachedCount: number;
  /** Unattended work that OUTLIVES a turn: a backgrounded bash task or a detached agent thread —
   *  `AgentEngine.hasBackgroundWork(sessionId)`. Distinct from `turnRunning` on purpose: a session
   *  whose turn ended while a `run_in_background` task keeps writing is still doing work, and
   *  calling that "idle" is exactly the invisible-runner blindness spec §1 opens with. */
  bgWork: boolean;
  /** When the session's last event was appended. NOT read by `activityFor` today — declared here
   *  because the cleaner (spec §3: candidates are "idle ∧ ≥24h since last event") is the next
   *  consumer, and a signal builder that starts populating it honestly now cannot later be caught
   *  passing a plausible-looking stand-in. Never fabricate it: `SessionStore.lastEventTs` is the
   *  honest source. */
  lastEventTs: number;
  /** Start of the session's current continuously-active span, for the >24h demotion. ABSENT means
   *  "nothing is tracking a span", which must read as "not over the window" — never as 0/epoch,
   *  which would demote every session on earth. Maintained in memory by T5's enforcement
   *  (`activity-enforcement.ts`: stamped when a session goes from zero attachments to one, dropped
   *  when its last harness detaches). */
  activeSince?: number;
  /** T5's PROVISIONAL background: the daemon auto-backgrounded this session because its APP-kind
   *  harness detached mid-turn, and the post-turn grace window has not expired yet. Ephemeral and
   *  in-memory — deliberately NOT the stored `backgrounded` flag, which stays user-explicit
   *  (`session.setActivity` is its only writer).
   *
   *  A signal rather than a row overlay because that is exactly what it is: a live fact the daemon
   *  owns, on the same footing as `turnRunning`/`attachedCount`. It matters for ONE window — after
   *  the turn ends the session has no turn, no attachment and (typically) no background work, so
   *  without this input the derivation would answer "idle" the instant the turn settled and the
   *  2-minute grace would be invisible to `session.list` while the emitted stream still said
   *  "background". Absent/false for every caller that isn't the daemon's own enforcement. */
  autoBackground?: boolean;
}

/** The modes that HAVE a lifecycle (spec §1: "Code and cowork participate fully"). Absent mode is
 *  code by the standing convention (`isCodeMode`, packages/cli/src/session-mode.ts; `sync.ts`) —
 *  every session minted before `mode` existed, and every plain `session.create`, is a code session.
 *
 *  Deliberately an ALLOWLIST rather than "everything except chat/dispatch". The state is not a
 *  label: from T5 on, `active` means "abort the running turn when the last harness detaches". A
 *  mode that ships later must opt into a turn-killing lifecycle deliberately — inheriting it by
 *  omission is the failure that costs a user work. `"cowork"` is listed even though no session can
 *  carry it yet (SessionStore's own column type stops at code/dispatch/chat), on the same
 *  precedent as engine.ts's `isChatOrCowork`: the predicate is already right the day cowork ships,
 *  with no gating logic to revisit. */
const ACTIVITY_MODES: ReadonlySet<string> = new Set(["code", "cowork"]);

export function participatesInActivity(mode?: string): boolean {
  return ACTIVITY_MODES.has(mode ?? "code");
}

/** Everything `activityFor` reads off a session, and nothing else. Narrowed from `SessionRow` in T3
 *  so the SAME derivation serves both per-session readers the daemon has: `session.list`, which
 *  holds full rows, and `session.setActivity`/`session.attach`, which hold a `store.meta()` result
 *  (one indexed SELECT for one session — a full `list()` scan to learn one session's two flags
 *  would be the wrong cost, and fabricating the row's missing fields to satisfy a wider type would
 *  be exactly the plausible-stand-in this module's signal docs warn against).
 *
 *  `SessionRow` remains assignable, so every existing caller is unaffected. */
export type ActivityRow = Pick<SessionRow, "mode" | "backgrounded" | "archived">;

/**
 * The ONE derivation of a session's activity state (spec §1). PURE: same inputs, same answer, no
 * clock read (`nowMs` is a parameter precisely so the >24h demotion is testable and so a batch of
 * rows is derived against ONE instant rather than a drifting one).
 *
 * Priority, highest first — the order is the whole design, not an implementation detail:
 *   1. `archived` flag                                    → "archived"
 *   2. `backgrounded` flag, OR work running with nothing
 *      attached, OR continuously active > 24 h, OR the
 *      daemon's provisional auto-background               → "background"
 *   3. any harness attached                               → "active"
 *   4. otherwise                                          → "idle"
 *
 * Returns `undefined` for a non-participating mode (chat/dispatch): absence is the fourth answer,
 * meaning "no lifecycle here", and it outranks every flag — an archived chat row is still nothing.
 */
export function activityFor(row: ActivityRow, signals: ActivitySignals, nowMs: number): Activity | undefined {
  if (!participatesInActivity(row.mode)) return undefined;
  if (row.archived) return "archived";
  // A turn and a detached task are the same fact to this derivation: work is happening. Splitting
  // them matters to the ENFORCEMENT hook (T5 aborts a turn; it does not kill a bash task), not here.
  const working = signals.turnRunning || signals.bgWork;
  const demoted = signals.activeSince !== undefined && nowMs - signals.activeSince > ACTIVE_DEMOTION_MS;
  if (row.backgrounded || (working && signals.attachedCount === 0) || demoted || signals.autoBackground) {
    return "background";
  }
  if (signals.attachedCount > 0) return "active";
  return "idle";
}
