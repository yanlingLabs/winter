// Agent SDK 0.0.44's mid-turn FOLD (user ruling 2026-10-04: "lets fold the message into the running turn").
//
// The runtime's contract (0.0.44, its CHANGELOG):
//   1. A host `user` frame (a `HostPromptQueue.push`) that arrives while the top-level engine runs a turn
//      waits in a FIFO pending buffer. Just before the turn's next request (after the next tool round, and
//      after the budget, auto-compaction and hook-stop checks) EVERY pending one is folded into the running
//      turn (the model reads it as a system-reminder, "The user sent a new message while you were
//      working: …"). A folded push produces NO `result` of its own: the running turn's one `result` covers it.
//   2. When it folds, the stream carries `SDKHostInputFoldedMessage` — `{ type: "system", subtype:
//      "host_input_folded", count, uuid, session_id }` — written only after the folded attachment is stored:
//      the host's `count` EARLIEST pushes that had not yet started a turn were absorbed into the running turn.
//   3. A push still pending when the running turn ends — or when an interrupt, a budget stop or a hook stop
//      ends it before that next request — starts its own next turn (one per push, FIFO, each with its own
//      `result`). `UserPromptSubmit` runs per folded prompt and a block ends the fold at that prompt; `/compact`
//      or a resolver-expanded `/name` ends it too. Those prompts and everything after them run as their own
//      turns. Subagent engines never fold.
//   4. `Query.clearQueuedInput(): Promise<{ cleared }>` (control `clear_queued_input`) drops every pending push
//      that has neither started a turn nor been folded and answers how many. `Query.interrupt()` is unchanged
//      and KEEPS pending pushes (they run after the interrupted turn).
//
// A Winter daemon on 0.0.44 always runs a 0.0.44 runtime (`REQUIRED_WINTER_AGENT_SDK`, version-locked: the
// spawned binary by the executable ladder, the embedded one by `embeddedVersionCheck`), so nothing here is
// feature-detected any more. The ONE defensive guard left is the clear's rejection: an older runtime answers
// `clear_queued_input` with `WinterRpcError` `unknown_subtype` (the SDK tells hosts to catch it), and any
// failure of the control means "nothing was cleared", never a thrown TaskStop.
import type { Query, SDKHostInputFoldedMessage } from "@yanlinglabs/winter-agent-sdk";

/** `system/host_input_folded` → its `count`; `undefined` for every other frame (or a malformed one). */
export function hostInputFoldedCount(msg: unknown): number | undefined {
  if (typeof msg !== "object" || msg === null) return undefined;
  const m = msg as Partial<SDKHostInputFoldedMessage>;
  if (m.type !== "system" || m.subtype !== "host_input_folded") return undefined;
  // Subagent engines never fold; a frame forwarded from one (`parent_tool_use_id`) is never the session's.
  const parent = (msg as { parent_tool_use_id?: unknown }).parent_tool_use_id;
  if (typeof parent === "string" && parent.length > 0) return undefined;
  const count = m.count;
  return typeof count === "number" && Number.isInteger(count) && count > 0 ? count : undefined;
}

/**
 * `Query.clearQueuedInput()`, never rejecting: how many pending pushes the child dropped, 0 when the control
 * failed — an older runtime's `unknown_subtype` included (`log` says which). The method is optional on the SDK's
 * interface only so a host's structural doubles keep type-checking; every `Query` the SDK returns has it.
 */
export async function clearQueuedInput(query: Query, log: (line: string) => void): Promise<number> {
  if (typeof query.clearQueuedInput !== "function") return 0;
  try {
    const { cleared } = await query.clearQueuedInput();
    return typeof cleared === "number" && Number.isInteger(cleared) && cleared > 0 ? cleared : 0;
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    log(code === "unknown_subtype"
      ? "the runtime does not know clear_queued_input (an older runtime) — nothing was cleared"
      : `clearing the queued input failed: ${err instanceof Error ? err.name : "unknown"} — nothing was cleared`);
    return 0;
  }
}
