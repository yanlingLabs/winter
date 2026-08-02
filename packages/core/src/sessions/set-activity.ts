import type { SessionActivity } from "@norma/protocol";
import type { ActivityDeriver, ActivityRow } from "./activity";
import { participatesInActivity } from "./activity";

/** What a caller ASKS FOR: a TARGET STATE, never a flag toggle (spec §1, T3's `session.setActivity`
 *  contract). `null` clears both stored bits. `"active"`/`"idle"` are deliberately NOT settable —
 *  they are derived facts about attachments and work, not things a caller may assert. */
export type ActivityTarget = "background" | "archived" | null;

/** The exact store slice this operation writes and reads back — a narrow structural interface (the
 *  `ReaperStore`/`CleanerStore` precedent) so a test can drive it without a real database, and so
 *  the set of store powers this grants is visible at a glance. */
export interface SetActivityStore {
  meta(sessionId: string): ActivityRow;
  setBackgrounded(sessionId: string, on: boolean): void;
  setArchived(sessionId: string, on: boolean): void;
}

export interface SetActivityDeps {
  store: SetActivityStore;
  /** `AgentEngine.isRunning` — a TURN, not the wider "any work" signal (see the archived guard). */
  isRunning(sessionId: string): boolean;
  /** THE derivation (`makeActivityDeriver`) — the same one `session.list` stamps rows with. */
  derive: ActivityDeriver;
  /** `SessionHub.emitActivity` — T4's live announcement. */
  emit(sessionId: string, activity: SessionActivity | undefined): void;
  /** Injectable clock (the `ReaperDeps.now`/`CleanerDeps.now` precedent). */
  now?: () => number;
}

/** `kind` exists so each caller can map a refusal into its own vocabulary — the RPC into
 *  `ERR.NOT_FOUND`/`ERR.INVALID_PARAMS`, a tool into an isError outcome — without either of them
 *  re-deciding WHICH refusals exist. */
export type SetActivityResult =
  | { ok: true; activity: SessionActivity | undefined }
  | { ok: false; kind: "not_found" | "invalid"; error: string };

/**
 * THE write half of the activity lifecycle (session-activity-hygiene T3, extracted in T8).
 *
 * Extracted from `session.setActivity`'s handler verbatim — same refusals, same wording, same
 * write order, same post-write re-read, same emission — because T8 gives dispatch a SECOND door
 * onto it (`manage_session`, the coordinator's management verb). Two doors onto one state machine
 * is fine; two implementations of one state machine is how "archiving a running session is refused"
 * becomes true on one door and false on the other, six months from now, silently. The RPC handler
 * and the tool both call THIS.
 *
 * What stays with each caller is only what is genuinely theirs: the RPC keeps `parseParams` and
 * `assertRemoteMayUseSession` (wire concerns), the tool keeps its own argument shape.
 */
export function setSessionActivity(
  deps: SetActivityDeps,
  sessionId: string,
  target: ActivityTarget,
): SetActivityResult {
  let meta: ActivityRow;
  // NOT_FOUND is resolved FIRST, explicitly, rather than left to a store setter to report at the
  // end: every refusal below reads a FACT about the session (its mode, whether a turn is running),
  // so an unknown id must come back as unknown rather than as a refusal that implies it exists.
  try { meta = deps.store.meta(sessionId); }
  catch (e) { return { ok: false, kind: "not_found", error: (e as Error).message }; }
  // T2's participation ALLOWLIST (code + cowork + absent-means-code) — chat and dispatch have no
  // lifecycle at all, so there is no state to set on them. Refused for a CLEAR too: the refusal is
  // about the session, not the value.
  if (!participatesInActivity(meta.mode)) {
    return { ok: false, kind: "invalid", error: "activity states apply to code and cowork sessions only" };
  }
  // Archived is a flag over IDLE (spec §1.4): archiving a session with a turn in flight would
  // strand that turn behind a hidden tab, so the door refuses and names the two ways out. Scoped to
  // `"archived"` on purpose — BACKGROUNDING a running session is the entire point of that flag
  // ("keep running unattended"), and a CLEAR must stay available or a mis-flagged running session
  // could never be un-flagged. `isRunning` (a TURN) rather than the wider "any work" signal: a
  // detached bash task already derives as `background`, so such a session has literally done what
  // this message asks for.
  if (target === "archived" && deps.isRunning(sessionId)) {
    return { ok: false, kind: "invalid", error: "stop or background it first" };
  }
  // The value names a TARGET STATE, not a flag — which is why `"background"` also clears the
  // archive flag: `archived` outranks `backgrounded` in the derivation, so writing one while leaving
  // the other set would answer "archived" to a caller who asked for background, a wire no-op. Naming
  // background as the target is a deliberate act on that session, exactly like a resume. NOT
  // symmetric: `"archived"` leaves `backgrounded` alone (it contradicts nothing below it) —
  // store.setArchived's documented independence, which is what returns a resumed session to
  // background rather than to idle.
  if (target === "archived") {
    deps.store.setArchived(sessionId, true);
  } else {
    // "background" and null (clear) differ only in the background bit; both clear the archive.
    deps.store.setBackgrounded(sessionId, target === "background");
    deps.store.setArchived(sessionId, false);
  }
  // Re-read rather than assuming what was just written: the derivation's inputs are the STORED
  // flags, and re-reading them is what keeps this echo an observation instead of a restatement.
  const after = deps.store.meta(sessionId);
  const activity = deps.derive(after, sessionId, (deps.now ?? Date.now)());
  // T4: the LIVE half. A caller's own answer reaches only that caller; every OTHER harness with this
  // session open would otherwise learn of the flag write on its next `session.list`. The SAME derived
  // value the caller is handed, so the two can never describe different states, and the hub
  // suppresses a re-statement (an idempotent set emits nothing).
  deps.emit(sessionId, activity);
  return { ok: true, activity };
}
