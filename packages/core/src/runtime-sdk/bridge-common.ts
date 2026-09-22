/** The narrow logging surface the approval and question bridges share. Structural and deliberately
 *  tiny so whatever `Logger` Task 5's `create.ts` settles on satisfies it; optional in both bridges'
 *  deps, defaulting to a console-backed one. **Codes only** — a bridge never logs tool input
 *  contents (P8b-19 / the tool surface's own rule), because a permission request's input is exactly
 *  the sensitive half. */
export interface BridgeLogger {
  info(message: string): void;
  error(message: string): void;
}

/** stderr-backed default, matching how the rest of the daemon logs (`console.error` throughout
 *  `daemon.ts`/`ipc/server.ts`; stdout is the NDJSON socket's business, never a log sink). */
export const consoleBridgeLogger: BridgeLogger = {
  info: (m) => console.error(m),
  error: (m) => console.error(m),
};

/**
 * **No park timeout** (P8b-19 / SDK surface map §5.1: "a pending permission RPC has NO park
 * timeout — only the callback resolving, or the whole query aborting, ever ends the wait").
 *
 * `ApprovalBroker.wait` / `QuestionBroker.wait` are timeout-shaped by construction: both always arm
 * a `setTimeout` and fail closed when it fires. `2**31 - 1` ms (~24.8 days) is `setTimeout`'s own
 * ceiling, and is ALREADY this codebase's spelling of "indefinite" — `engine.ts`'s dispatch-child
 * question window is literally this value, with the comment *"setTimeout caps at 2^31-1 ms (~24.8
 * days) — that IS our indefinite; a comment, not a behavior knob."* Reusing it keeps both brokers
 * completely untouched (no new no-timer mode, no second code path through `wait`) while giving a
 * bridged request a deadline no live session will ever reach.
 */
export const NO_PARK_TIMEOUT_MS = 2 ** 31 - 1;

/**
 * The reason the bash safety reviewer (`hooks.ts`) escalates with when it could reach NO verdict — a
 * transient failure on a home that does have a runnable provider. The child hands a PreToolUse
 * hook's `ask` back to `canUseTool` with this text verbatim as `decisionReason` (agent SDK 0.0.17
 * `hooks/runner.ts` `permissionDecisionReason` → `permissions/evaluator.ts` `hookAskMessage`), and it
 * is the ONE hook-forced ask the approval bridge acts on: under `auto` the gate answers `allow` for
 * `bash`, so without it a reviewer outage silently ran the command — where claude's auto mode, whose
 * classifier the reviewer stands in for, never silently allows what its classifier could not judge
 * (C3, lane C, 2026-09-22). Lives here, beside the bridges, so neither side imports the other.
 */
export const REVIEWER_ESCALATION_REASON = "reviewer unavailable — escalating for manual approval";

/**
 * WHICH sandbox escapes the reviewer POSITIVELY CLEARED — keyed `sessionId` + the call's `toolUseID`,
 * the same identity the approval broker keys on (C3-1, lane C, 2026-09-22).
 *
 * Under `auto` an escape (`dangerouslyDisableSandbox: true`) runs without a card ONLY when the reviewer
 * judged THAT call `safe` under `UNSANDBOXED_REVIEW_INSTRUCTION` (`agent/reviewer.ts`). The hook records
 * a clearance here and the approval bridge requires one — so every other outcome FAILS CLOSED to a card
 * (a typed deny where nobody can answer one): no reviewer wired, the reviewer disabled, no runnable
 * model, a transient failure, an `unsafe` verdict that somehow reached the bridge, a missing call id,
 * an evicted note. That is claude's own shape: its auto mode runs nothing its classifier did not clear
 * (`utils/permissions/permissions.ts` ~845-875 fails closed or prompts). A NEGATIVE note ("the reviewer
 * could not judge this one") was the first cut and was fail-OPEN — every path that never wrote it
 * (no reviewer, disabled, structural no-model) ran the escape unreviewed.
 *
 * Why a note at all: for an escape the agent SDK's stage 3 names its OWN mandatory-interaction reason
 * and drops a hook's (0.0.17 `permissions/evaluator.ts` ~1976-1985), and a hook `allow` resolves only
 * after stage 3 — so every escape reaches `canUseTool` with the same P3-J text whatever the reviewer
 * said. The hook and the bridge are built in different places (`daemon.ts`'s `hooksFor`,
 * `session-driver.ts`'s `canUseToolFor`) and meet only here, in-process.
 *
 * Bounded: a clearance the bridge never takes (the child allowed the call itself, or the turn was
 * interrupted before the permission request) is evicted oldest-first past the cap — and eviction can
 * only cost a card, never grant a run. A `toolUseID` is unique per call, so a lingering clearance can
 * never apply to a different command.
 */
/** key → the exact command the reviewer cleared (C3 round 3: a clearance is bound to what was
 *  reviewed, so an input a later stage rewrote — a hook transform, a `canUseTool` retry with new
 *  args — can never ride a verdict about something else). */
const reviewerCleared = new Map<string, string>();
const REVIEWER_CLEARED_CAP = 512;
const clearedKey = (sessionId: string, toolUseID: string): string => `${sessionId}\u0000${toolUseID}`;

export function noteReviewerCleared(sessionId: string, toolUseID: string | undefined, command: string): void {
  if (toolUseID === undefined || toolUseID.length === 0) return;
  const key = clearedKey(sessionId, toolUseID);
  reviewerCleared.delete(key);   // re-insert at the young end
  reviewerCleared.set(key, command);
  while (reviewerCleared.size > REVIEWER_CLEARED_CAP) {
    const oldest = reviewerCleared.keys().next().value;
    if (oldest === undefined) break;
    reviewerCleared.delete(oldest);
  }
}

/** Consumes the clearance: `true` at most once per call, and only for the very command reviewed. */
export function takeReviewerCleared(sessionId: string, toolUseID: string | undefined, command: unknown): boolean {
  if (toolUseID === undefined || toolUseID.length === 0) return false;
  const key = clearedKey(sessionId, toolUseID);
  const cleared = reviewerCleared.get(key);
  reviewerCleared.delete(key);
  return cleared !== undefined && typeof command === "string" && cleared === command;
}
