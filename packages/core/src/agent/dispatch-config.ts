/** session-activity-hygiene task 1: dispatch's model and reasoning effort are a FIXED PIN, not a
 *  per-session choice — a user ruling, the same shape as `RESEARCH_MODEL`/`RESEARCH_EFFORT`
 *  (research.ts): dispatch is the user's ambient coordinator on this Mac, not a conversation
 *  someone tunes turn by turn, so there is no picker for it to answer to.
 *
 *  Enforced in TWO independent layers (the `ultra`-tier pattern, provider-correctness T5):
 *   1. `AgentEngine.resolveSel` (engine.ts) short-circuits a dispatch session's resolution to
 *      these two constants BEFORE `meta.model`, `meta.effort`, `live()`, or the boot default are
 *      even read — the seam stays inert no matter how a value reached the session (a stale
 *      pre-fix row, a fork, a hand-edited index), not merely for values that arrive through the
 *      RPC doors.
 *   2. `session.setModel` / `session.setEffort` (ipc/server.ts) refuse a dispatch-mode target
 *      OUTRIGHT, before their own resolution/validation helpers (`resolveModelSelection`,
 *      `assertEffortSelectable`) even run — the door, so the daemon never even stores an override
 *      nobody will ever honor.
 *
 *  `DISPATCH_EFFORT` is an ordinary member of `REASONING_EFFORTS` (settings.ts) — this is a fixed
 *  SELECTION of a real wire effort, not a client-side tier like `ultra`; it needs no translation. */
export const DISPATCH_MODEL = "gpt-5.6-terra";
export const DISPATCH_EFFORT = "medium";

/** The one refusal message both doors throw — extracted so the two surfaces cannot drift (same
 *  reasoning as `resolveModelSelection`/`assertEffortSelectable` being shared helpers rather than
 *  two copies). Built FROM the constants above so it can never name a stale value. */
export const DISPATCH_PIN_MESSAGE = `dispatch runs a fixed model: ${DISPATCH_MODEL} at ${DISPATCH_EFFORT}`;
