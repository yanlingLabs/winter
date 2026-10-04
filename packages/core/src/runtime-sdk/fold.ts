// Agent SDK 0.0.44's mid-turn FOLD (user ruling 2026-10-04: "lets fold the message into the running turn").
//
// THE ONE PLACE the 0.0.44 members are named before the pin bump. Until then they are absent from the
// installed types, so each is a structural guard here, feature-detected on the live object; the bump
// replaces these guards with the SDK's own types and nothing else in the daemon has to change.
//
// The runtime's contract (0.0.44):
//   1. A host `user` frame (a `HostPromptQueue.push`) that arrives while a turn runs waits in a FIFO
//      pending buffer. At the next tool round EVERY pending one is folded into the running turn (the
//      model reads it as a system-reminder, "The user sent a new message while you were working: …").
//      A folded push produces NO `result` of its own: the running turn's single `result` covers it.
//   2. When it folds, the query stream carries `{ type: "system", subtype: "host_input_folded", count,
//      uuid, session_id }` BEFORE the frames of the next model request: the host's `count` EARLIEST
//      pushes that had not yet started a turn were absorbed into the running turn.
//   3. A push still pending when the running turn ends starts its own next turn (one per push, FIFO,
//      each with its own `result`) — the pre-0.0.44 behaviour (P8b-38).
//   4. `Query.clearQueuedInput(): Promise<{ cleared }>` (control `clear_queued_input`) drops every pending
//      push that has neither started a turn nor been folded and answers how many. `Query.interrupt()` is
//      unchanged and KEEPS pending pushes (they run after the interrupted turn).
//
// The fold is the top-level engine's: a subagent's forwarded frame (`parent_tool_use_id`) is never one.

/** `system/host_input_folded` → its `count`; `undefined` for every other frame (or a malformed one). */
export function hostInputFoldedCount(msg: unknown): number | undefined {
  if (typeof msg !== "object" || msg === null) return undefined;
  const m = msg as { type?: unknown; subtype?: unknown; count?: unknown; parent_tool_use_id?: unknown };
  if (m.type !== "system" || m.subtype !== "host_input_folded") return undefined;
  if (typeof m.parent_tool_use_id === "string" && m.parent_tool_use_id.length > 0) return undefined;
  const count = m.count;
  return typeof count === "number" && Number.isInteger(count) && count > 0 ? count : undefined;
}

/** `Query.clearQueuedInput` bound to its query, or `undefined` on a runtime without it (≤ 0.0.43). */
export function clearQueuedInputOf(query: unknown): (() => Promise<{ cleared: number }>) | undefined {
  const fn = (query as { clearQueuedInput?: unknown } | undefined)?.clearQueuedInput;
  if (typeof fn !== "function") return undefined;
  return async () => {
    const answer = await (fn as () => Promise<unknown>).call(query);
    const cleared = (answer as { cleared?: unknown } | undefined)?.cleared;
    return { cleared: typeof cleared === "number" && Number.isInteger(cleared) && cleared > 0 ? cleared : 0 };
  };
}

/**
 * Does this live child FOLD a mid-turn push into its running turn? Read as the presence of
 * `clearQueuedInput`, which 0.0.44 ships together with the fold (both halves of one contract). A
 * runtime without it (≤ 0.0.43) runs every mid-turn push as its own next turn (P8b-38), and a push can
 * then never be taken back — which is why SendMessage steers only when this is true.
 */
export function foldsQueuedInput(query: unknown): boolean {
  return typeof (query as { clearQueuedInput?: unknown } | undefined)?.clearQueuedInput === "function";
}
