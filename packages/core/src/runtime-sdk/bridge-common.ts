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
