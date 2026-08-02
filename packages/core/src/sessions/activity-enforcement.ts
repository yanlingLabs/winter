import { ACTIVE_DEMOTION_MS, participatesInActivity, type ActivityRow } from "./activity";

/** Which clients may have a running turn KILLED when they let go of a session (spec §1.2).
 *
 *  `"terminal"` is the CLI: a terminal harness IS the session's user interface, so its going away
 *  means the user walked away — the turn has nowhere to render and nobody to approve for it, and
 *  leaving it burning tokens into a log nobody will read is the invisible-runner failure the whole
 *  activity model exists to fix. `"app"` is everything with a life of its own beyond one attachment
 *  — the Mac app (whose window closing is not the user leaving) and the phone (whose connection
 *  churns by design). */
export type HarnessKind = "terminal" | "app";

/** The ONE list that decides which clientName prefixes are turn-killing (see `harnessKindOf`).
 *
 *  The real hello strings this covers, as of this task — verified in source, and pinned verbatim by
 *  `test/sessions/activity-enforcement.test.ts`'s "harness kinds" block:
 *    - `cli-p`     — `norma -p`, the one-shot   (packages/cli/src/main.ts:613)
 *    - `cli-chat`  — the interactive Ink TUI     (same line)
 *    - `cli-<verb>` × 22 more, plus two built by template string
 *      (`cli-plugin-revoke-<id>`, `cli-plugin-restart-<name>`) — which is why this is a PREFIX rule
 *      and not a list of literals, since a literal list would silently mis-classify those two into
 *      the non-aborting default and nothing would ever notice.
 *  The app-kind clients, for the record: `orb` (apple/Norma AppModel.ownClientName, shared by the
 *  menu-bar harness and every detached window), `iphone-gateway` (the Mac gateway's daemon-facing
 *  client, one per phone session), `norma-probe` (the NormaKit debug streamer). */
export const TERMINAL_CLIENT_PREFIXES: readonly string[] = ["cli-"];

/** Classifies a harness. `role` is the connection's authenticated hello role — `"remote"` is
 *  checked FIRST and wins outright, because it is a stronger statement than any name match: it is
 *  the daemon's own record that this connection came in through the pairing gateway, and no phone
 *  may ever lose a turn to a blipped connection however its gateway chooses to call itself.
 *
 *  TERMINAL IS AN ALLOWLIST; app is the default. This is the load-bearing half. Terminal is the
 *  kind whose last detach kills a running turn, so a client that ships later must opt into that
 *  deliberately rather than inherit it by omission — the same reasoning `ACTIVITY_MODES`
 *  (activity.ts) records for mode participation. Defaulting the other way costs a user their
 *  in-flight work; defaulting this way costs, at worst, a turn that runs on unattended — which is
 *  the documented app-kind behaviour anyway. */
export function harnessKindOf(clientName: string, role?: string | null): HarnessKind {
  if (role === "remote") return "app";
  return TERMINAL_CLIENT_PREFIXES.some((p) => clientName.startsWith(p)) ? "terminal" : "app";
}

/** Spec §1.2's post-turn grace: how long an auto-backgrounded session stays background after its
 *  turn ends before it settles to idle. A module constant, not a setting — nothing here is a knob a
 *  user would turn, and a setting would drag in the hot-reload obligation for no gain. */
export const AUTO_BACKGROUND_GRACE_MS = 2 * 60_000;

/** How often the demotion sweep runs. It only walks the in-memory span map (bounded by the number
 *  of sessions with a live attachment — single digits in practice), so the cadence is chosen for
 *  how promptly a >24h session should be ANNOUNCED, not for cost. `session.list` already answers
 *  correctly at any instant without it; the sweep exists purely so an open UI hears about the
 *  demotion without re-polling. */
export const ACTIVITY_SWEEP_INTERVAL_MS = 60_000;

/** Injectable one-shot timers — the default uses real (unref'd) ones; tests capture the callback
 *  and fire it by hand, so the 2-minute grace is testable in microseconds and with no real sleep.
 *  Mirrors `CuScheduler` (agent/computer-use.ts), setTimeout-shaped rather than setInterval-shaped
 *  like `LspManager`'s idle timers. */
export interface ActivityTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const DEFAULT_TIMERS: ActivityTimers = {
  setTimeout(fn, ms) {
    const t = setTimeout(fn, ms);
    (t as { unref?: () => void }).unref?.();
    return t;
  },
  clearTimeout(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

/** The identity the detach policy reads off a departing harness — structurally satisfied by
 *  `HubClient` (sessions/hub.ts), which is what the hub actually passes. */
export interface EnforcementClient {
  clientName: string;
  role?: string | null;
}

export interface ActivityEnforcementDeps {
  /** The session's stored lifecycle row — `SessionStore.meta`. THROWS for an unknown session, and
   *  every hook below treats that throw as "the row is gone, there is nothing to enforce". */
  meta(sessionId: string): ActivityRow;
  /** Derive this session's CURRENT activity and hand it to `SessionHub.emitActivity` — the ONE
   *  derive-then-emit path (`deriveActivity`, ipc/server.ts). Never "emit this state I decided":
   *  the enforcement moves the daemon's own signals and then asks the single derivation what that
   *  now means, so the emitted stream and `session.list` cannot describe different states. The
   *  hub's change memo is what makes calling it on every transition cheap. */
  emit(sessionId: string): void;
  /** `AgentEngine.isRunning`. */
  turnRunning(sessionId: string): boolean;
  /** `AgentEngine.interrupt` — the EXISTING ESC-abort path, so an enforcement abort produces the
   *  same `turn_completed(aborted)` a user's ESC does, and is resumable on identical terms. */
  abortTurn(sessionId: string): void;
  /** True when something will start a turn on this session BY ITSELF later, so letting it settle to
   *  idle would be a lie. See the wiring in ipc/server.ts for what this actually resolves to and
   *  why routines are NOT part of it. */
  scheduledWakeup(sessionId: string): boolean;
  now?(): number;
  timers?: ActivityTimers;
  graceMs?: number;
}

export interface ActivityEnforcement {
  /** A harness attached (called AFTER the attach is registered and after `session.attach`'s
   *  archived-clear, so the derivation sees the finished state). `attachedCount` is the session's
   *  attachment count now — zero means the attach did not take (see the implementation). */
  onAttached(sessionId: string, attachedCount: number): void;
  /** A harness went away. `remaining` is the attachment count AFTER the removal. */
  onDetached(sessionId: string, client: EnforcementClient, remaining: number): void;
  /** A top-level turn settled (all terminal paths, including abort). */
  onTurnSettled(sessionId: string): void;
  /** Start of this session's current continuously-active span — `ActivitySignals.activeSince`. */
  activeSince(sessionId: string): number | undefined;
  /** Whether this session is provisionally auto-backgrounded — `ActivitySignals.autoBackground`. */
  autoBackgrounded(sessionId: string): boolean;
  /** One demotion pass. Public so tests drive it without a clock. */
  sweep(): void;
  start(intervalMs?: number): void;
  stop(): void;
}

/**
 * The enforcement half of the session lifecycle (spec §1.2): what the daemon DOES when the last
 * harness lets go, when an auto-backgrounded turn ends, and when a session has called itself active
 * for a day.
 *
 * Deliberately dependency-injected rather than reaching for the engine/hub/store directly: the
 * derivation it has to agree with (`deriveActivity`) is a closure inside `startIpcServer`, which is
 * the only place engine signals, hub attachments and the store are all in scope. So the server wires
 * this up and hands it `emit`; this module owns the POLICY and the in-memory state, and never
 * derives an activity of its own — a second derivation is precisely the divergence T3 had to fix
 * once already.
 *
 * All state here is in memory and provisional. The two STORED flags stay user-explicit: nothing in
 * this file ever writes `backgrounded`/`archived` (the `session.setActivity` RPC is their only
 * writer). A daemon restart therefore forgets every auto-background and every active span, which is
 * correct — after a restart nothing is attached and no turn is running, so the derivation answers
 * from scratch.
 */
export function createActivityEnforcement(deps: ActivityEnforcementDeps): ActivityEnforcement {
  const now = deps.now ?? (() => Date.now());
  const timers = deps.timers ?? DEFAULT_TIMERS;
  const graceMs = deps.graceMs ?? AUTO_BACKGROUND_GRACE_MS;

  /** sessionId -> start of its current continuously-active span. Present ⇔ something is attached. */
  const spanStart = new Map<string, number>();
  /** Sessions provisionally auto-backgrounded (app-kind harness detached mid-turn). */
  const autoBackground = new Set<string>();
  /** sessionId -> the pending post-turn grace timer. */
  const grace = new Map<string, unknown>();
  let sweepTimer: ReturnType<typeof setInterval> | null = null;

  /** Every hook starts here: the row is the enforcement's own gate. A vanished row (deleted
   *  session, a detach racing a delete) means there is nothing left to enforce OR announce — and
   *  `emit` on such a session would throw out of the hub's fan-out, which is exactly the reachable
   *  path the memo-ordering fix in `SessionHub.emitActivity` guards. `undefined` = don't proceed.
   *
   *  A session that is GONE is also forgotten here, which is the only place that can happen for a
   *  session deleted between two hooks (the detach that would normally clear its span never comes).
   *  Deliberately not done for a merely non-participating mode: chat/dispatch never acquire any
   *  bookkeeping to drop, and a mode is not a disappearance. */
  function lifecycleRow(sessionId: string): ActivityRow | undefined {
    let row: ActivityRow;
    try { row = deps.meta(sessionId); }
    catch { forget(sessionId); return undefined; }
    return participatesInActivity(row.mode) ? row : undefined;
  }

  function forget(sessionId: string): void {
    spanStart.delete(sessionId);
    autoBackground.delete(sessionId);
    cancelGrace(sessionId);
  }

  function cancelGrace(sessionId: string): void {
    const handle = grace.get(sessionId);
    if (handle === undefined) return;
    timers.clearTimeout(handle);
    grace.delete(sessionId);
  }

  function armGrace(sessionId: string): void {
    cancelGrace(sessionId);
    grace.set(sessionId, timers.setTimeout(() => {
      grace.delete(sessionId);
      autoBackground.delete(sessionId);
      // Two minutes is long enough for the session to have been deleted meanwhile, so re-check
      // rather than announce into the void (`lifecycleRow` also forgets what we still held).
      if (!lifecycleRow(sessionId)) return;
      // The provisional background is over; ask the derivation what the session is NOW (idle,
      // normally — but "background" again if the stored flag went on meanwhile, or a new turn
      // started, in which case the memo swallows this).
      try { deps.emit(sessionId); }
      catch (err) { console.error(`[activity] grace emit failed for ${sessionId}:`, err); }
    }, graceMs));
  }

  return {
    onAttached(sessionId: string, attachedCount: number): void {
      // An attach that left the session with NOTHING attached did not take: `SessionHub.attach`
      // returns early without registering a client whose socket died during the replay drain (a
      // slow-consumer backlog cap), and that client never produces a detach either — so stamping a
      // span here would open one nothing can ever close, and 24h later the sweep would demote a
      // session with no harness on it at all.
      if (attachedCount === 0) return;
      if (!lifecycleRow(sessionId)) return;
      // An attachment ends any provisional background outright — the whole point of the grace
      // window is to wait and see whether somebody comes back, and somebody just did.
      cancelGrace(sessionId);
      autoBackground.delete(sessionId);
      // Only the FIRST attachment opens a span: "continuously active" means continuously, so a
      // second harness joining must not reset the >24h clock (nor must a re-attach churn it).
      if (!spanStart.has(sessionId)) spanStart.set(sessionId, now());
      deps.emit(sessionId);
    },

    onDetached(sessionId: string, client: EnforcementClient, remaining: number): void {
      const row = lifecycleRow(sessionId);
      if (!row) return;
      if (remaining === 0) {
        // The continuously-active span is over whatever happens next.
        spanStart.delete(sessionId);
        // `backgrounded`/`archived` are the user having already SAID what should happen to this
        // session: background means "keep running unattended" (killing that turn would be the exact
        // opposite of the request), and archived is a flag over idle. Either way the enforcement
        // has nothing to add — and no provisional mark either, since the state it would provision
        // is already the answer.
        if (!row.backgrounded && !row.archived && deps.turnRunning(sessionId)) {
          if (harnessKindOf(client.clientName, client.role) === "terminal") {
            // The user's terminal went away mid-turn. Same abort a user's ESC performs — a
            // `turn_completed(aborted)`, resumable, no new machinery. NOT emitted as "idle" here:
            // the turn is still unwinding, so at this instant the honest derivation is "background"
            // (work running, nobody attached) and the idle lands from `onTurnSettled` when the
            // abort actually settles. Announcing idle early would be the one thing that makes
            // `session.list` and the live stream disagree.
            deps.abortTurn(sessionId);
          } else {
            // App/phone: the turn keeps running, and the session says so — provisionally, in
            // memory. NEVER the stored flag: nobody asked for this session to be backgrounded, so
            // nothing may survive the grace window (or a restart) as if they had.
            autoBackground.add(sessionId);
          }
        }
      }
      deps.emit(sessionId);
    },

    onTurnSettled(sessionId: string): void {
      if (!lifecycleRow(sessionId)) return;
      // `turnRunning` still true means the engine's between-turns drain already started a follow-up
      // (a background notification, a stranded cross-session message). The grace belongs to the
      // turn that really is the last one, so keep the mark and wait for that settle instead.
      if (autoBackground.has(sessionId) && !deps.turnRunning(sessionId)) {
        if (deps.scheduledWakeup(sessionId)) {
          // Something will wake this session on its own; it is not going idle, it is waiting — and
          // that work already derives as "background" through `bgWork`, so dropping the provisional
          // mark costs no flicker.
          autoBackground.delete(sessionId);
        } else {
          armGrace(sessionId);
        }
      }
      deps.emit(sessionId);
    },

    activeSince(sessionId: string): number | undefined {
      return spanStart.get(sessionId);
    },

    autoBackgrounded(sessionId: string): boolean {
      return autoBackground.has(sessionId);
    },

    sweep(): void {
      const at = now();
      for (const [sessionId, since] of spanStart) {
        if (at - since <= ACTIVE_DEMOTION_MS) continue;
        // A span whose session no longer exists (deleted while attached) is bookkeeping for nothing
        // — `lifecycleRow` drops it rather than re-attempting a doomed emit on every tick.
        if (!lifecycleRow(sessionId)) continue;
        // ONLY the emit. The derivation computes "background" from `activeSince` by itself, so
        // there is no state to flip here and no stored flag to write — and re-deriving the
        // threshold in two places is how the two would eventually disagree. Repeats cost nothing:
        // `SessionHub.emitActivity`'s change memo is the one de-dupe, deliberately not a second one
        // here.
        try { deps.emit(sessionId); }
        catch (err) { console.error(`[activity] demotion emit failed for ${sessionId}:`, err); }
      }
    },

    start(intervalMs: number = ACTIVITY_SWEEP_INTERVAL_MS): void {
      if (sweepTimer) return; // idempotent, mirrors stop() — the makeRoutineScheduler precedent
      sweepTimer = setInterval(() => {
        try { this.sweep(); }
        catch (err) { console.error("[activity] sweep failed:", err); }
      }, intervalMs);
      sweepTimer.unref?.(); // never keeps the daemon process alive on its own
    },

    stop(): void {
      if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
      for (const handle of grace.values()) timers.clearTimeout(handle);
      grace.clear();
    },
  };
}
