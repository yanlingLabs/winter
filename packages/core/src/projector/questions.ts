/**
 * ── WHY THE PROJECTOR DOES NOT PRODUCE `question_asked` / `question_resolved` ───────────────────
 *
 * `AskUserQuestion` is answered inside `canUseTool` (Task 8's question bridge): the runtime asks
 * permission for the call, the bridge parks it, the user answers on the Mac or the phone, and the
 * answer goes back as `PermissionResult.updatedInput.answers`. All of that happens in a CALLBACK,
 * before any frame about it reaches the message stream.
 *
 * That ordering settles ownership. `question_asked` has to appear the moment the question is put —
 * otherwise nothing renders a card and nobody can answer — so its producer must be the bridge, and
 * `question_resolved` must be the bridge too, because only the bridge holds the answers. By the
 * time the projector sees anything, the question is already answered and the only frames are the
 * ordinary `tool_use` / `tool_result` pair, which `conversation.ts` projects as an ordinary
 * `tool_call` / `tool_result`. The same reasoning puts `approval_requested`/`approval_resolved` on
 * the approval bridge.
 *
 * So this module produces nothing. It exists to hold the decision at the place a reader looks for
 * it, and to give `index.ts` one honest predicate: a question's tool_call is still a REAL tool_call
 * and must keep being projected (dropping it would leave the transcript with an answer and no
 * question, and would break the `callId` linkage the bridge's own events share with it).
 *
 * **The `callId` is the join.** The bridge's `question_asked.callId` and the projector's
 * `tool_call.callId` are both the `tool_use.id`, so the two producers' events line up in the
 * transcript with no coordination between them — which is the only reason this split works.
 *
 * None of this is guessed from the goldens: no golden scenario contains a question, and the brief's
 * instruction was to match the goldens and invent nothing. Task 8 owns the bridge; part 2 owns
 * saying so, and `PROJECTED_EVENT_COVERAGE` marks all four variants `false` with the producer named.
 */

/** The SDK's question tool, and the Norma name it is projected under (ruling P8b-25). */
export const QUESTION_TOOLS: readonly string[] = ["AskUserQuestion", "AskQuestion", "ask_user"];

/** True for the tool whose answers the question bridge owns. Read by `index.ts` only to log the
 *  hand-off once, never to suppress the tool_call. */
export const isQuestionTool = (name: string): boolean => QUESTION_TOOLS.includes(name);
