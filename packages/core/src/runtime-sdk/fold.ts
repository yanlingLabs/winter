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
// The embedded runtime, the platform package and a Release bundle are version-locked to the pin
// (`REQUIRED_WINTER_AGENT_SDK`). A CONFIGURED code runtime is not: `runtimes.winterExecutable`,
// `$WINTER_RUNTIME_EXECUTABLE` and `<home>/runtimes/bin/winter` run whatever binary is there (logged when it
// differs, never refused). So what a session may assume is read from the version its spawn hook reports
// (`WinterSpawnHook.runtimeVersion`, the binary's own `--version`): `runtimeFolds` says whether that runtime
// folds. An older one never sends the fold frame (each push then gets its own `result`, ordinary C2
// accounting) and answers `clear_queued_input` with `WinterRpcError` `unknown_subtype` — caught here, as
// the SDK tells hosts to: any failure of the control means "nothing was cleared", never a thrown TaskStop.

/** The first agent SDK release whose runtime folds a mid-turn push and knows `clear_queued_input`. */
export const FOLD_SINCE = "0.0.44";

/** Does a runtime reporting `version` fold (≥ `FOLD_SINCE`)? `undefined` (unknown) never does. */
export function runtimeFolds(version: string | undefined): boolean {
  if (version === undefined) return false;
  const parse = (v: string): number[] | undefined => {
    const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
    return m === null ? undefined : [Number(m[1]), Number(m[2]), Number(m[3])];
  };
  const have = parse(version);
  const need = parse(FOLD_SINCE)!;
  if (have === undefined) return false;
  for (let i = 0; i < 3; i++) if (have[i] !== need[i]) return have[i]! > need[i]!;
  return true;
}
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
