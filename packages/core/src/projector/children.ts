import { MAIN_THREAD, isErrorResult, toolResultOutput, type ContentBlock } from "./conversation";
import type { ProjectedEvent } from "./types";

/**
 * ── CHILD (SUBAGENT) CORRELATION ────────────────────────────────────────────────────────────────
 *
 * `parent_tool_use_id` is the MESSAGE-STREAM child correlator (surface map §4.3) and the only one:
 * `agentID` is deliberately NOT a message-stream field on any variant — it is a permission-time
 * correlator on `CanUseTool`'s options object and on `SDKPermissionDeniedMessage.agent_id`.
 * Conflating the two is a named brief error, corrected by the shape authority, and it is why
 * nothing here reads an agent id.
 *
 * A child's identity on the host side is therefore the spawning call's `tool_use.id`, used as the
 * `threadId`. That is stable for the life of the child, unique by construction (the model never
 * reuses a tool_use id), and it is the SAME id the child's completing `tool_result` carries as
 * `tool_use_id` — so `thread_started` and `thread_completed` are derived from one identifier with
 * no registry lookup and no host round-trip.
 *
 * ── THE TWO WIRE SHAPES, AND WHY BOTH ARE HANDLED ───────────────────────────────────────────────
 *
 * By DEFAULT only a subagent's `tool_use`/`tool_result` blocks are forwarded to the host stream. Its
 * own text and thinking are forwarded ONLY when `Options.forwardSubagentText: true`
 * (`winter-agent-sdk/dist/options.d.ts:99` on the installed barrel — the exact option name, checked,
 * not remembered). So:
 *
 *   forwardSubagentText OFF (the default, and what a Winter session gets today):
 *       thread_started  ← the spawning `tool_use` block
 *       …the child's own tool_call/tool_result events, on the child's threadId…
 *       thread_completed ← the spawning call's `tool_result` block — for a FOREGROUND spawn, or one
 *                          that failed; a `run_in_background` spawn's result only says it LAUNCHED,
 *                          so its thread stays open until the background-task terminal frame
 *                          (`system/task_notification`, or a terminal `task_updated`) names it
 *                          (`spawnOutcome`, `backgroundStopReason`, `ProjectorImpl.acceptTaskFrame`)
 *
 *   forwardSubagentText ON:
 *       the same, PLUS the child's `assistant_message` (and `assistant_delta`) on its threadId,
 *       which `conversation.ts` already produces for any frame carrying `parent_tool_use_id`.
 *
 * Both shapes are in the fixtures — but only the DEFAULT one is measured. **The
 * `code-child-spawn-forwarded` fixture is AUTHORED from the §4.3 shape** (m4, review r2): the
 * real-child measurement ran with default options, so no recording exists with
 * `forwardSubagentText: true`, and nothing here may claim as fact that a child's own text does
 * arrive with the option on — only that IF it arrives in that shape, it folds onto the child's
 * threadId. It is a target of the deferred `describeWithWinterBinary`-gated real-child test,
 * alongside the `stream_event` gap.
 *
 * **Task 16 obligation, recorded here and in the task report:** the
 * engine's golden carries the child's own `assistant_message`, so leaving `forwardSubagentText` off
 * makes child transcripts thinner on the Winter leg than they are today. Turning it on is a
 * one-field decision in `buildWinterOptions`, and it is a decision, not an oversight — it doubles
 * the frames a fan-out of subagents puts on the wire.
 *
 * ── WHAT THIS MODULE DELIBERATELY DOES NOT PRODUCE ──────────────────────────────────────────────
 *
 * The engine also emits a `turn_started`/`turn_completed` PAIR on each child thread. Neither is
 * derivable here: a child's turn boundaries are not on the wire (there is no per-child `result`),
 * and `turn_completed` requires token counts that no per-child usage exists for. Inventing a
 * zero-token child terminal would put a fabricated figure into the product log, so the pair is left
 * to the session driver (Task 16), which knows when it appended `thread_started` — the same place
 * the MAIN thread's `turn_started` comes from. `thread_completed.stopReason` already carries the
 * fact the pair would have carried.
 */

/** The spawning tools whose `tool_use` opens a child thread. Winter's name is `Agent`; the host
 *  name it is projected under is `spawn_agent` (ruling P8b-25) — matched on BOTH because
 *  `tool-names.ts` maps the wire name before a `tool_call` is built, and this module reads the
 *  raw wire block. */
const SPAWN_TOOLS = new Set(["Agent", "Task", "spawn_agent"]);

export const isSpawnTool = (winterName: string): boolean => SPAWN_TOOLS.has(winterName);

export interface ChildRecord {
  /** The spawning `tool_use.id`, used as the host `threadId`. */
  threadId: string;
  parentThreadId: string;
  agentType: string;
  prompt: string;
  description?: string;
}

/**
 * Read a spawning `tool_use` block into a child record. `subagent_type` is the SDK's field for the
 * agent kind; `general-purpose` is the engine's own default for a spawn with no type
 * (`thread_started.agentType` in the golden), so it is the fallback rather than an empty string —
 * `ThreadStartedEvent.agentType` is `z.string()` and an empty one would parse but render as a blank
 * chip on the Mac.
 */
export function childFromSpawn(block: ContentBlock, parentThreadId: string): ChildRecord | undefined {
  const threadId = typeof block.id === "string" ? block.id : undefined;
  if (threadId === undefined || threadId.length === 0) return undefined;
  const input = typeof block.input === "object" && block.input !== null ? (block.input as Record<string, unknown>) : {};
  const agentType = typeof input.subagent_type === "string" && input.subagent_type.length > 0 ? input.subagent_type : "general-purpose";
  const prompt = typeof input.prompt === "string" ? input.prompt : "";
  const description = typeof input.description === "string" && input.description.length > 0 ? input.description : undefined;
  return { threadId, parentThreadId, agentType, prompt, ...(description === undefined ? {} : { description }) };
}

export function threadStarted(child: ChildRecord, sessionId: string): ProjectedEvent {
  return {
    type: "thread_started", sessionId, threadId: child.threadId,
    parentThreadId: child.parentThreadId, agentType: child.agentType, prompt: child.prompt,
    ...(child.description === undefined ? {} : { description: child.description }),
  };
}

/** `thread_completed.stopReason` — the protocol's own enum (`ThreadCompletedEvent`). */
export type ThreadStopReason = "end_turn" | "aborted" | "error" | "stalled";

export function threadCompleted(threadId: string, stopReason: ThreadStopReason, sessionId: string): ProjectedEvent {
  return { type: "thread_completed", sessionId, threadId, stopReason };
}

/**
 * What a spawning call's own `tool_result` says about its child:
 *
 *  - `{kind:"done"}` — the child is finished (a foreground spawn, or a spawn that failed before a
 *    child ever ran). `stopReason` is `aborted` for an interrupted call, `error` for any error
 *    spelling (`isErrorResult`) OR an output beginning `Error:` — the Winter engine drops a tool's
 *    returned `isError` on the wire (`winter-agent-sdk` `engine.ts:5965`), and EVERY failure branch
 *    of its Agent executor (`tools/impl/agent.ts`: unknown subagent_type, spawn failed,
 *    isolation:"remote", background setup failed, a non-completed foreground child) returns an
 *    `Error:`-prefixed output, so that prefix is the only failure signal that reaches the daemon.
 *    The prefix test is applied to SPAWN results only (a Grep hit may well start with "Error:").
 *    `stalled` is not derivable here: the stall watchdog is the host's, never a wire fact.
 *  - `{kind:"background"}` — the spawn LAUNCHED a child that is still running
 *    (`run_in_background`). The thread stays open until a background-task terminal frame names it
 *    (`acceptTaskFrame`). Recognised on both legs:
 *      Winter:   the output is JSON `{"status":"async_launched","agentId","taskId",…}` (agent.ts);
 *      official: the user frame's `tool_use_result` is `{status:"async_launched",…}` — trusted only
 *                when the frame carries exactly one tool_result, since the field is frame-level —
 *                or, failing that, Claude Code's rendered text "Async agent launched successfully."
 *                (`AgentTool.tsx`'s `mapToolResultToToolResultBlockParam`).
 *    `taskId` is Winter's background-task id when the result names one — the fallback correlator
 *    for a `task_updated` patch, which carries no `tool_use_id`.
 */
export type SpawnOutcome = { kind: "done"; stopReason: ThreadStopReason; failed: boolean } | { kind: "background"; taskId?: string };

const ASYNC_LAUNCHED = "async_launched";
const OFFICIAL_ASYNC_TEXT = "Async agent launched successfully.";

export function spawnOutcome(block: ContentBlock, frameToolUseResult: unknown): SpawnOutcome {
  if (block.interrupted === true) return { kind: "done", stopReason: "aborted", failed: true };
  const text = toolResultOutput(block);
  if (isErrorResult(block) || text.trimStart().startsWith("Error:")) return { kind: "done", stopReason: "error", failed: true };
  const parsed = parseJsonObject(text);
  if (parsed?.status === ASYNC_LAUNCHED) {
    const taskId = typeof parsed.taskId === "string" && parsed.taskId.length > 0 ? parsed.taskId : undefined;
    return { kind: "background", ...(taskId === undefined ? {} : { taskId }) };
  }
  if (isPlainObject(frameToolUseResult) && frameToolUseResult.status === ASYNC_LAUNCHED) return { kind: "background" };
  if (text.trimStart().startsWith(OFFICIAL_ASYNC_TEXT)) return { kind: "background" };
  return { kind: "done", stopReason: "end_turn", failed: false };
}

/**
 * A background-task TERMINAL status → the child thread's stopReason, or `undefined` for a
 * non-terminal one. Both vocabularies are read: `task_notification.status`
 * (`completed | failed | stopped`) and `task_updated.patch.status`
 * (`pending | running | completed | failed | killed | paused`). A failure is `error` and a stop/kill
 * is `aborted` — never a clean `end_turn`.
 */
export function backgroundStopReason(status: unknown): ThreadStopReason | undefined {
  switch (status) {
    case "completed": return "end_turn";
    case "failed": return "error";
    case "stopped":
    case "killed": return "aborted";
    default: return undefined;
  }
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  const t = text.trim();
  if (!t.startsWith("{")) return undefined;
  try {
    const v: unknown = JSON.parse(t);
    return isPlainObject(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

// ── background tasks vs the to-do list ────────────────────────────────────────────────────────

/**
 * **The SDK's BACKGROUND-task registry is NOT the model's to-do list.** The runtime keeps two
 * *completely separate* registries that happen to share a display name: `startTracking({kind:
 * "agent"|"bash"|"workflow"})`'s background-task registry, which DOES put frames on the wire
 * (`system/task_started`/`task_updated`/`task_progress`/`task_notification`), and the
 * `TaskCreate`/`TaskUpdate`/`TaskList`/`TaskGet` to-do store (`tools/task-graph-store.ts`), which
 * emits **nothing** onto the wire.
 *
 * Until this fix the projector folded the background frames into `task_updated` — so every
 * background agent/bash/workflow run appeared as a phantom row in the user's to-do list, and a
 * background AGENT's real finish was spent there instead of closing its thread. Now:
 *
 *  - the to-do list (`task_updated`, and so `task.list`) is fed SOLELY by `applyTodoResult` below;
 *  - a background frame that names an open background CHILD thread (by `tool_use_id`, or by a task
 *    id learned from `task_started`/the async result) closes that thread with `thread_completed`
 *    on its terminal status (`backgroundStopReason`) — see `ProjectorImpl.acceptTaskFrame`;
 *  - every other background frame (bash, workflow, an agent this projector never saw spawn) is
 *    observed and logged once per kind, never persisted. There is no existing SessionEvent that
 *    states "a background shell finished" for a list the user reads, and the model itself learns of
 *    it through the runtime's own notification; inventing one is a protocol change (P8b-21).
 */
export type HostTaskStatus = "pending" | "in_progress" | "completed" | "deleted";

export interface TaskRow { id: string; subject: string; status: HostTaskStatus; activeForm?: string; metadata?: Record<string, unknown> }

// ── the model's to-do list (`TaskCreate`/`TaskUpdate`) → `task_updated` ────────────────────────────
//
// See this section's module doc above for why this is a wholly separate mechanism from
// `acceptTaskFrame`'s frame-fed background-task registry: `TaskCreate`/`TaskUpdate` put NOTHING on
// the wire, so the only signal a to-do mutation happened is the tool call itself — its `tool_use`
// block (the input) paired with its `tool_result` (success/failure, and for `TaskCreate` the minted
// id). `HostTaskStatus` already matches `TaskUpdate`'s own input `status` enum exactly
// (`pending|in_progress|completed|deleted` on both sides — no `TASK_STATUS_MAP`-style lossy fold is
// needed here), so `status: "deleted"` passes straight through unchanged, as `TaskSchema`'s own
// doc comment on `task_updated` requires (a live task view removes the row rather than upserting a
// phantom that outlives the delete).

/** Winter's `TaskCreate`/`TaskUpdate` tool names, matched on the RAW runtime name — the SAME
 *  convention `isSpawnTool` uses, and for the same reason: the projector's assistant-frame loop
 *  reads the wire block before `renameTool` runs. Matched identically on the official leg: Claude
 *  Code's own "current task system" is the SAME four tools under the SAME names
 *  (`winter-vs-cc-tools.md`'s tool-parity table), so a `claude` child's `TaskCreate`/`TaskUpdate`
 *  calls are indistinguishable from a Winter child's at this layer. */
const TODO_TOOLS = new Set(["TaskCreate", "TaskUpdate"]);
export const isTodoTool = (winterName: string): boolean => TODO_TOOLS.has(winterName);

/** A `TaskCreate`/`TaskUpdate` call's own input, tracked from its `tool_use` block until its
 *  `tool_result` resolves it — needed because NEITHER result shape echoes the new field values
 *  back: `TaskCreate`'s result is `{task:{id,subject}}` (subject only, no activeForm), and
 *  `TaskUpdate`'s is `{success,taskId,updatedFields,statusChange?}` — the NAMES of what changed,
 *  never the new values themselves (`tools/impl/task-graph.ts`'s T8 note 6). */
export interface PendingTodoCall { kind: "create" | "update"; input: Record<string, unknown> }

/** Read a `TaskCreate`/`TaskUpdate` `tool_use` block into a `PendingTodoCall`, or `undefined` for
 *  any other tool. */
export function pendingTodoFrom(block: ContentBlock): PendingTodoCall | undefined {
  const name = typeof block.name === "string" ? block.name : undefined;
  if (name !== "TaskCreate" && name !== "TaskUpdate") return undefined;
  const input = typeof block.input === "object" && block.input !== null && !Array.isArray(block.input)
    ? (block.input as Record<string, unknown>) : {};
  return { kind: name === "TaskCreate" ? "create" : "update", input };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const HOST_TASK_STATUSES: ReadonlySet<HostTaskStatus> = new Set(["pending", "in_progress", "completed", "deleted"]);

/**
 * Parse a `TaskCreate`/`TaskUpdate` `tool_result` block's payload. The SDK's own executor always
 * JSON-stringifies its result (`tools/impl/task-graph.ts`: every branch returns `output:
 * JSON.stringify(...)`), and `toolResultOutput` already flattens both wire shapes of `content` (a
 * bare string, or an array of text blocks) down to that one string — covering the official leg
 * too, since nothing in `@anthropic-ai/claude-agent-sdk`'s own types names a distinct
 * `tool_use_result` carrier for this. A `content` that is already a plain object (never observed,
 * tolerated defensively) is read directly. Never throws: anything that fails to parse, or parses to
 * something other than a plain object, is `undefined` — "nothing to project", not a crash.
 */
function parseTodoResultJson(block: ContentBlock): Record<string, unknown> | undefined {
  const raw = (block as Record<string, unknown>).content;
  if (isPlainObject(raw)) return raw;
  const text = toolResultOutput(block);
  if (text.length === 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return isPlainObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Fold a resolved `TaskCreate`/`TaskUpdate` call into the tracked to-do rows and return the
 * `task_updated` event to emit, or `undefined` when there is nothing to project:
 *
 *  - the call errored (`isErrorResult`: `is_error`/`error`/`denied`/`interrupted`) — never a task update;
 *  - `TaskUpdate`'s own domain failures report `success:false` INSIDE a non-error result
 *    (`tools/impl/task-graph.ts`'s T8 note 1: not-found/self-reference/unknown-reference never set
 *    `isError` — the input shape was fine, the graph operation was not) — also nothing to project;
 *  - the result did not parse as the pinned shape at all (a foreign or malformed payload);
 *  - an UNTRACKED `TaskUpdate` — no row for that id in `rows`, even after the projector seeded
 *    them from the session's persisted history (`ProjectorDeps.priorTodos`). `TaskSchema.subject`
 *    is `z.string().min(1)` and there is no wire fact to label an unseen row with, so this is a
 *    **deliberate skip, not a fabricated row**, logged by the caller.
 *
 * `TaskCreate`'s new row takes its `subject` from the RESULT (the store's own echo, per the
 * documented `{task:{id,subject}}` shape) and its `activeForm` from the CALL's input (the result
 * never carries it) — `status` is always `"pending"`, matching the store's own `createTask`.
 * `TaskUpdate` merges the call's `subject`/`activeForm`/`status` onto the tracked row, falling back
 * to the row's previous value for any field the call did not touch.
 */
export function applyTodoResult(
  rows: Map<string, TaskRow>,
  call: PendingTodoCall,
  block: ContentBlock,
  sessionId: string,
): ProjectedEvent | undefined {
  if (isErrorResult(block)) return undefined;
  const result = parseTodoResultJson(block);
  if (result === undefined) return undefined;

  if (call.kind === "create") {
    const task = isPlainObject(result.task) ? result.task : undefined;
    const id = typeof task?.id === "string" && task.id.length > 0 ? task.id : undefined;
    const subject = typeof task?.subject === "string" && task.subject.length > 0 ? task.subject : undefined;
    if (id === undefined || subject === undefined) return undefined;
    const activeForm = typeof call.input.activeForm === "string" && call.input.activeForm.length > 0 ? call.input.activeForm : undefined;
    const row: TaskRow = { id, subject, status: "pending", ...(activeForm === undefined ? {} : { activeForm }) };
    rows.set(id, row);
    return { type: "task_updated", sessionId, threadId: MAIN_THREAD, task: row };
  }

  // TaskUpdate
  if (result.success !== true) return undefined;
  const taskId = typeof result.taskId === "string" && result.taskId.length > 0 ? result.taskId : undefined;
  if (taskId === undefined) return undefined;
  const existing = rows.get(taskId);
  const inputStatus = typeof call.input.status === "string" ? call.input.status : undefined;
  const status = inputStatus !== undefined && HOST_TASK_STATUSES.has(inputStatus as HostTaskStatus) ? (inputStatus as HostTaskStatus) : undefined;
  const subject = typeof call.input.subject === "string" && call.input.subject.length > 0 ? call.input.subject : existing?.subject;
  if (subject === undefined) return undefined;   // untracked row, no subject anywhere — skip (see doc above)
  const activeForm = typeof call.input.activeForm === "string" && call.input.activeForm.length > 0 ? call.input.activeForm : existing?.activeForm;
  const row: TaskRow = {
    id: taskId, subject, status: status ?? existing?.status ?? "pending",
    ...(activeForm === undefined ? {} : { activeForm }),
  };
  rows.set(taskId, row);
  return { type: "task_updated", sessionId, threadId: MAIN_THREAD, task: row };
}
