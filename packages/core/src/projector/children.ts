import { MAIN_THREAD, type ContentBlock } from "./conversation";
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
 *       thread_completed ← the spawning call's `tool_result` block
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

/**
 * A child's terminal, read off the spawning call's own `tool_result` block.
 *
 * `stalled` exists in the enum for one specific path — a subagent killed by the progress-stall
 * watchdog, which renders differently from a genuine failure because a stall is resumable and keeps
 * partial output. On the Winter leg the watchdog is the host's (P8b-15 keeps it), so the driver
 * tells the projector; the wire itself can only distinguish `aborted` (an interrupted in-flight
 * call) from `error` and `end_turn`.
 */
export function threadCompletedFrom(block: ContentBlock, sessionId: string): ProjectedEvent | undefined {
  const threadId = typeof block.tool_use_id === "string" ? block.tool_use_id : undefined;
  if (threadId === undefined || threadId.length === 0) return undefined;
  const stopReason: "end_turn" | "aborted" | "error" =
    block.interrupted === true ? "aborted"
      : block.is_error === true || block.denied === true ? "error"
        : "end_turn";
  return { type: "thread_completed", sessionId, threadId, stopReason };
}

// ── the task graph (§4.4) ──────────────────────────────────────────────────────────────────────

/**
 * ── `system/task_updated` → the host's `task_updated`, AND THE ONE PLACE THE ENUMS DO NOT MEET ─────
 *
 * Winter's task graph is ONE registry holding both the model's to-do rows (`TaskCreate`: subject,
 * description, activeForm, blocks/blockedBy — the same shape as the host's own `task_create` tool) and
 * its background agent runs (`startTracking({kind:"agent"})`). Its status vocabulary has six values;
 * the host's `TaskSchema.status` has four (`pending | in_progress | completed | deleted`), and
 * P8b-21 forbids widening the enum this phase.
 *
 * Four map cleanly. Two do not, and both losses are recorded rather than hidden:
 *
 *   pending   → pending
 *   running   → in_progress
 *   paused    → pending        (not running, not finished; `pending` is the only non-terminal value)
 *   completed → completed
 *   failed    → completed  + `metadata.winterStatus: "failed"`   ← LOSSY
 *   killed    → deleted    + `metadata.winterStatus: "killed"`
 *
 * `failed → completed` is the uncomfortable one: a failed task renders with a tick. The
 * alternatives are worse — `deleted` makes the row vanish (the user loses the fact it ever ran) and
 * projecting nothing strands it at `in_progress` forever. `metadata` is a free-form shallow bag on
 * the existing schema, so the true status rides along additively for the day a renderer reads it.
 * **The clean fix is a `failed` member on `TaskSchema.status`, which is a protocol change and
 * therefore a later phase's** — flagged in the task report, not smuggled in here.
 */
export type WinterTaskStatus = "pending" | "running" | "completed" | "failed" | "killed" | "paused";
export type HostTaskStatus = "pending" | "in_progress" | "completed" | "deleted";

export const TASK_STATUS_MAP: Readonly<Record<WinterTaskStatus, HostTaskStatus>> = {
  pending: "pending",
  running: "in_progress",
  paused: "pending",
  completed: "completed",
  failed: "completed",
  killed: "deleted",
};

/** The two Winter statuses the host's enum cannot express; their real value rides in `metadata`. */
const LOSSY_STATUSES = new Set<WinterTaskStatus>(["failed", "killed"]);

export interface TaskRow { id: string; subject: string; status: HostTaskStatus; activeForm?: string; metadata?: Record<string, unknown> }

/**
 * Fold one `system/task_updated` patch into the tracked row and return the event, or undefined when
 * the patch says nothing this projector can express (an unknown status and no description change).
 *
 * A row this projector has never seen gets its `subject` from the patch's `description`, and failing
 * that from the task id — `TaskSchema.subject` is `z.string().min(1)` and an event that fails the
 * schema is worse than a row labelled by its id.
 */
export function applyTaskPatch(
  rows: Map<string, TaskRow>,
  taskId: string,
  patch: Record<string, unknown>,
  sessionId: string,
): ProjectedEvent | undefined {
  const rawStatus = typeof patch.status === "string" ? (patch.status as WinterTaskStatus) : undefined;
  const mapped = rawStatus !== undefined ? TASK_STATUS_MAP[rawStatus] : undefined;
  const description = typeof patch.description === "string" && patch.description.length > 0 ? patch.description : undefined;
  if (mapped === undefined && description === undefined) return undefined;

  const existing = rows.get(taskId);
  const row: TaskRow = {
    id: taskId,
    subject: description ?? existing?.subject ?? taskId,
    status: mapped ?? existing?.status ?? "pending",
    ...(existing?.activeForm === undefined ? {} : { activeForm: existing.activeForm }),
  };
  const metadata: Record<string, unknown> = { ...(existing?.metadata ?? {}) };
  if (rawStatus !== undefined && LOSSY_STATUSES.has(rawStatus)) metadata.winterStatus = rawStatus;
  const error = typeof patch.error === "string" ? patch.error : undefined;
  if (error !== undefined) metadata.winterError = error;
  if (Object.keys(metadata).length > 0) row.metadata = metadata;

  rows.set(taskId, row);
  return { type: "task_updated", sessionId, threadId: MAIN_THREAD, task: row };
}

/** Seed a row from a `system/task_started` frame so a later patch has a subject to carry. */
export function seedTask(rows: Map<string, TaskRow>, taskId: string, description: unknown): void {
  if (rows.has(taskId)) return;
  const subject = typeof description === "string" && description.length > 0 ? description : taskId;
  rows.set(taskId, { id: taskId, subject, status: "pending" });
}
