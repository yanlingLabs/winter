import type { SessionActivity } from "@norma/protocol";
import type { ActivityDeriver, ActivityRow } from "./activity";
import { participatesInActivity } from "./activity";

/** What a caller ASKS FOR (spec §1, T3's `session.setActivity` contract). `"active"`/`"idle"` are
 *  deliberately NOT settable — they are derived facts about attachments and work, not things a
 *  caller may assert.
 *
 *  activity-verb-semantics: FOUR values, one per stored bit in each direction — `"background"` and
 *  `"archived"` SET their bit, `"unbackground"` clears the background bit, and `null` (RESUME)
 *  clears the archive bit. Each clear touches EXACTLY ONE flag. That is the whole change from T3,
 *  where `null` cleared both and `"background"` un-archived as a side effect: a session has two
 *  independent facts about it ("the user hid this" and "this runs unattended"), and a verb that
 *  moves the one you didn't name is a verb that loses the other one's answer. */
export type ActivityTarget = "background" | "archived" | "unbackground" | null;

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

/** The participation refusal, verbatim, as ONE constant: `session.setActivity` and dispatch's
 *  `manage_session` both answer with it for the three STATE-SETTING verbs (background/archive/
 *  resume), so the rule reads identically at every door instead of being near-identical sentences
 *  that drift. `manage_session`'s `stop` is governed by the same allowlist but sets no activity
 *  state, so it answers with its own honest refusal instead (`STOP_MODE_REFUSAL`,
 *  agent/tools/list-sessions.ts). */
export const ACTIVITY_MODE_REFUSAL = "activity states apply to code and cowork sessions only";

/** activity-verb-semantics ruling 1: an ARCHIVED session is IMMUTABLE except through resume, and the
 *  refusal NAMES the one door out. Exported as a constant for the same reason the sentence above is:
 *  the RPC, dispatch's `manage_session` and the `norma agents` roster all reach this state machine,
 *  and a near-identical hand-written sentence at each door is how three remedies start pointing at
 *  three different remedies. */
export const ARCHIVED_IMMUTABLE_REFUSAL = "session is archived — resume it first";

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
    return { ok: false, kind: "invalid", error: ACTIVITY_MODE_REFUSAL };
  }
  // Archived is a flag over IDLE (spec §1.4): archiving a session with a turn in flight would
  // strand that turn behind a hidden tab, so the door refuses and names the two ways out. Scoped to
  // `"archived"` on purpose — BACKGROUNDING a running session is the entire point of that flag
  // ("keep running unattended"), and `"unbackground"` must stay available or a mis-flagged running
  // session could never be un-flagged. `isRunning` (a TURN) rather than the wider "any work" signal: a
  // detached bash task already derives as `background`, so such a session has literally done what
  // this message asks for.
  if (target === "archived" && deps.isRunning(sessionId)) {
    return { ok: false, kind: "invalid", error: "stop or background it first" };
  }
  // activity-verb-semantics ruling 1: ARCHIVED IS IMMUTABLE EXCEPT THROUGH RESUME. This deliberately
  // REVERSES T3's target-state reasoning, which had `"background"` clear the archive flag so the
  // caller's asked-for state and the derived answer could not disagree. The cost of that consistency
  // was a verb that silently un-hides what the user hid — the same invisible resurrection the
  // `send_message` bridge already refuses, spelled with a different word. So the two background
  // verbs REFUSE on an archived session and name the remedy instead.
  //
  // `"archived"` is exempt because it is not a mutation of a hidden session, it is a restatement of
  // its hiddenness: an idempotent success whose write changes no bit and whose emission
  // self-suppresses (SessionHub.emitActivity fires ONLY ON CHANGE). Refusing it would make a
  // coordinator's "make sure this is archived" fail on the sessions where it already holds.
  //
  // `null` (resume) is exempt because it IS the door out.
  if (meta.archived && (target === "background" || target === "unbackground")) {
    return { ok: false, kind: "invalid", error: ARCHIVED_IMMUTABLE_REFUSAL };
  }
  // ONE VERB, ONE FLAG. The two setters write their own bit and leave the other alone
  // (`store.setArchived`'s documented independence), and so do the two clears:
  //
  //   * `"unbackground"` clears `backgrounded` only. Reaching an archived session through it is
  //     already refused above, so it can never un-hide anything.
  //   * `null` (RESUME) clears `archived` only — `backgrounded` SURVIVES a resume. This is what
  //     makes the verb mean the same thing as resume-by-opening: `session.attach` has always
  //     cleared exactly the archive flag (ipc/server.ts), so an archived background worker comes
  //     back a background worker whichever door the user used. T3 cleared both here, which is why
  //     the two doors disagreed.
  switch (target) {
    case "archived": deps.store.setArchived(sessionId, true); break;
    case "background": deps.store.setBackgrounded(sessionId, true); break;
    case "unbackground": deps.store.setBackgrounded(sessionId, false); break;
    case null: deps.store.setArchived(sessionId, false); break;
    // This union just grew once, and the failure mode of the next growth is silent: an unhandled
    // target writes NOTHING and still returns `{ok: true}` with a derived state, so the caller is
    // told its write succeeded and the flag never moved. The `never` assignment (the house pattern
    // — tui/transcript.tsx, flatten-blocks.ts) makes that a compile error instead.
    default: {
      const _exhaustive: never = target;
      throw new Error(`unhandled activity target: ${String(_exhaustive)}`);
    }
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
