import { z } from "zod";

const Base = z.object({
  seq: z.number().int().nonnegative(),
  sessionId: z.string().min(1),
  ts: z.number().int().nonnegative(), // epoch ms
});

/** Sentinel `sessionId` for events that aren't scoped to any session (Phase 4d Task 1's
 *  `plugin_tile_updated`, spec §6/§7): a dashboard connection is never "attached" to a session
 *  (there's nothing to `session.attach` to for a plugin tile), so these events are broadcast
 *  server-side by looping every authed harness connection (ipc/server.ts's `harnessConns`, the
 *  same mechanism `session_created` already uses) rather than through the per-session
 *  `SessionHub`. `Base.sessionId` requires `min(1)`, so a session-less event still needs SOME
 *  non-empty string to satisfy the schema — `$system` is reserved for exactly that (never a real
 *  session id: `SessionStore.createSession` always mints `s_<12-hex-chars>`, so a literal `$`
 *  prefix can never collide with a real session's id). */
export const SYSTEM_SESSION_ID = "$system";

export const SessionCreatedEvent = Base.extend({
  type: z.literal("session_created"),
  scope: z.string().min(1),
  // Dispatch (Phase 7 durability follow-up): carried so a full index.db rebuild (SessionStore's
  // recoverAll pass 2, which derives a rebuilt row ONLY from this event) can restore the
  // dispatch-singleton invariant — dispatchSessionId()'s SELECT WHERE mode='dispatch' is how
  // session.dispatch's get-or-create finds the ONE permanent dispatch session; without this, an
  // index rebuild would null out `mode` and mint a second dispatch session, orphaning the
  // original's whole conversation history. Additive/optional — older-shaped events still parse;
  // absent means "code" (same convention as SessionRow.mode/opts.mode elsewhere).
  mode: z.enum(["code", "dispatch"]).optional(),
});

export const HarnessAttachedEvent = Base.extend({
  type: z.literal("harness_attached"),
  clientName: z.string().min(1),
});

export const HarnessDetachedEvent = Base.extend({
  type: z.literal("harness_detached"),
  clientName: z.string().min(1),
});

export const UserMessageEvent = Base.extend({
  type: z.literal("user_message"),
  threadId: z.string().min(1),
  text: z.string().min(1),
  clientName: z.string().min(1),
});

const ThreadBase = Base.extend({ threadId: z.string().min(1) });

export const TurnStartedEvent = ThreadBase.extend({ type: z.literal("turn_started") });
export const AssistantMessageEvent = ThreadBase.extend({ type: z.literal("assistant_message"), text: z.string() });
/** TRANSIENT streaming chunk: broadcast-only, never persisted to the session log and never
 *  replayed on attach. Carries seq = the store's lastSeq at broadcast time (NOT its own seq) —
 *  monotonic-safe for naive lastSeq tracking, but clients MUST exempt assistant_delta from
 *  seq-based dedupe and lastSeq updates. The final assistant_message is the persisted record. */
export const AssistantDeltaEvent = ThreadBase.extend({ type: z.literal("assistant_delta"), delta: z.string().min(1) });
export const ToolCallEvent = ThreadBase.extend({
  type: z.literal("tool_call"), callId: z.string().min(1), name: z.string().min(1), argsJson: z.string(),
});
export const ToolResultEvent = ThreadBase.extend({
  type: z.literal("tool_result"), callId: z.string().min(1), output: z.string(), isError: z.boolean(),
});
/** Opaque provider reasoning item (Responses API), captured at output_item.done and replayed
 *  verbatim into later requests (CC/Codex parity — see the history-parity spec). itemJson is
 *  SENSITIVE opaque state (encrypted_content): the session JSONL is its only sink; clients
 *  (CLI/app) deliberately do NOT model this variant — both skip unknown event types, so it
 *  never renders. Do NOT add a generator fixture: Swift's all-fixtures round-trip would degrade
 *  it to unknownEvent and fail equality; TS tests cover the variant. */
export const ReasoningItemEvent = ThreadBase.extend({ type: z.literal("reasoning_item"), itemJson: z.string().min(1) });
export const ApprovalRequestedEvent = ThreadBase.extend({
  type: z.literal("approval_requested"), callId: z.string().min(1), toolName: z.string().min(1), summary: z.string(),
  // SP3 T4b: the approval's issue/expiry timestamps (epoch ms). REQUIRED — the daemon always knows
  // the deadline at emit time, so every real approval_requested carries them (the fixture does too).
  // `expiresAt` is the broker's fail-closed timeout deadline (issuedAt + timeoutMs); a phone renders
  // "expires in Ns" and derives `.expired` from it without waiting for approval_resolved{by:"timeout"}.
  // Same value the parallel `approval.list` (methods.ts) surfaces for a pending approval.
  issuedAt: z.number().int(), expiresAt: z.number().int(),
  // Phase 5e T1 (reviewer maturity, spec §"reviewerReason? on approval_requested"): populated when
  // this escalation came from the safety reviewer (engine.ts's review hook) — the reviewer's own
  // sentence, sanitized+capped at EMISSION (engine side), so clients can render it distinctly from
  // `summary` instead of the old smashed-in "⚠ safety reviewer: ..." prefix. Additive/optional — an
  // ask-policy or reviewer-less escalation omits it, and older-shaped events still parse.
  reviewerReason: z.string().optional(),
  // Dispatch relay (Phase 7): set on the MIRRORED copy of a child session's approval living in the
  // dispatch session's stream — identifies which child to respond into. Absent on native approvals.
  childSessionId: z.string().optional(),
});
export const ApprovalResolvedEvent = ThreadBase.extend({
  type: z.literal("approval_resolved"), callId: z.string().min(1), approved: z.boolean(), by: z.string().min(1),
  // Dispatch relay (Phase 7): see approval_requested.
  childSessionId: z.string().optional(),
});
export const TurnCompletedEvent = ThreadBase.extend({
  type: z.literal("turn_completed"), stopReason: z.enum(["end_turn", "aborted", "error"]),
  inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative(),
});
/** `code` (phase 5 routines T3, blocking concern carried from T2's runner.ts report): additive
 *  optional field on this EXISTING variant (not a new SessionEvent variant — no NormaKit
 *  exhaustive-switch trap) mirroring `ProviderEvent`'s own `{type:"error", code, message,
 *  retryAfterMs?}` shape (providers/types.ts) — `engine.ts` forwards `ev.code` when the error came
 *  from a live provider stream; the two synthetic `agent_error` emit sites (no cwd, context-cap)
 *  have no provider code and simply omit it. Lets a consumer (routines/runner.ts's quota
 *  detection) check `code === "rate_limit"` instead of string-matching the message's `"HTTP 429"`
 *  prefix — see runner.ts's own doc comment for why that prefix match remains as a fallback for
 *  older logs / synthetic errors that never carried a code. */
export const AgentErrorEvent = ThreadBase.extend({ type: z.literal("agent_error"), message: z.string(), code: z.string().optional() });
export const DirectoryAddedEvent = ThreadBase.extend({
  type: z.literal("directory_added"),
  path: z.string().min(1),
  persisted: z.boolean(),
});

export const BgTaskStartedEvent = ThreadBase.extend({ type: z.literal("bg_task_started"), taskId: z.string().min(1), command: z.string() });
export const BgTaskOutputEvent = ThreadBase.extend({ type: z.literal("bg_task_output"), taskId: z.string().min(1), chunk: z.string() });
export const BgTaskExitedEvent = ThreadBase.extend({ type: z.literal("bg_task_exited"), taskId: z.string().min(1), exitCode: z.number().int().nullable(), killed: z.boolean() });

export const CheckpointEvent = ThreadBase.extend({
  type: z.literal("checkpoint"), summary: z.string(), uptoSeq: z.number().int().nonnegative(),
});

export const QuestionOptionSchema = z.object({
  label: z.string().min(1), description: z.string().optional(),
  // CC AskUserQuestion parity: a per-option preview (e.g. a diff/scheme snippet rendered
  // alongside the option) shown in the "visual scheme on the right" panel. Optional/additive —
  // older-shaped questions without a preview still parse.
  preview: z.string().optional(),
});
export const QuestionSchema = z.object({
  question: z.string().min(1), header: z.string().min(1).max(12),
  options: z.array(QuestionOptionSchema).min(2).max(4), multiSelect: z.boolean(),
});
export const TaskSchema = z.object({
  id: z.string().min(1), subject: z.string().min(1),
  // "deleted" (T3 review fix wave 1): task_update{status:"deleted"} emits a task_updated event
  // carrying this status BEFORE the task is removed from the session's TaskStore, so live task
  // views (CLI pinned block, app SessionModel) can react by REMOVING the task instead of
  // upserting a phantom entry that outlives the delete. Terminal — no event ever transitions a
  // task OUT of "deleted".
  status: z.enum(["pending", "in_progress", "completed", "deleted"]), activeForm: z.string().optional(),
  // Task-graph fields (4h-ii-d, CC parity) — all optional/additive so old-shaped tasks (none of
  // these) keep parsing identically. owner: an agent name/id or "user" that owns the task.
  // blocks/blockedBy: ids of tasks this task blocks / is blocked by — task_update's
  // addBlocks/addBlockedBy append+dedupe into these (tools/tasks.ts); referenced ids are NOT
  // validated to exist here or there, since the referenced task may be created later. metadata:
  // a free-form shallow-mergeable bag (task_update's metadata arg merges new keys in; no delete
  // mechanism — YAGNI).
  owner: z.string().min(1).optional(),
  blocks: z.array(z.string()).optional(),
  blockedBy: z.array(z.string()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type QuestionOption = z.infer<typeof QuestionOptionSchema>;
export type Question = z.infer<typeof QuestionSchema>;
export type Task = z.infer<typeof TaskSchema>;

export const QuestionAskedEvent = ThreadBase.extend({
  type: z.literal("question_asked"), callId: z.string().min(1), questions: z.array(QuestionSchema).min(1).max(4),
  // Dispatch relay (Phase 7): see approval_requested.
  childSessionId: z.string().optional(),
});
export const QuestionResolvedEvent = ThreadBase.extend({
  type: z.literal("question_resolved"), callId: z.string().min(1), answers: z.record(z.string(), z.string()), by: z.string().min(1),
  // CC AskUserQuestion parity: free-text notes ("press n to add notes"), keyed by question text
  // like `answers`. Optional/additive — older-shaped resolutions without notes still parse.
  notes: z.record(z.string(), z.string()).optional(),
  // Dispatch relay (Phase 7): see approval_requested.
  childSessionId: z.string().optional(),
});
export const TaskUpdatedEvent = ThreadBase.extend({ type: z.literal("task_updated"), task: TaskSchema });

export const PlanPresentedEvent = ThreadBase.extend({
  type: z.literal("plan_presented"), callId: z.string().min(1), plan: z.string().min(1),
});
export const PlanResolvedEvent = ThreadBase.extend({
  type: z.literal("plan_resolved"), callId: z.string().min(1), approved: z.boolean(),
  feedback: z.string().optional(), autoAccept: z.boolean(), by: z.string().min(1),
});

export const WorktreeEnteredEvent = ThreadBase.extend({
  type: z.literal("worktree_entered"), name: z.string().min(1), path: z.string().min(1), branch: z.string().min(1),
});
export const WorktreeExitedEvent = ThreadBase.extend({
  type: z.literal("worktree_exited"), name: z.string().min(1), action: z.enum(["keep", "remove"]), removed: z.boolean(),
});

export const ThreadStartedEvent = ThreadBase.extend({
  type: z.literal("thread_started"), parentThreadId: z.string().min(1), agentType: z.string(), prompt: z.string(),
  description: z.string().optional(),
});
export const ThreadCompletedEvent = ThreadBase.extend({
  // "stalled" (task-16, CC-parity follow-up — the no-timeout task's own deferred item): a
  // subagent killed by the progress-stall watchdog (SubagentStallError, core/agent/subagents.ts)
  // used to reach the wire as "error", rendering as a plain "Failed" — indistinguishable from a
  // genuine provider/tool error even though a stall is resumable and carries partial output. This
  // value is engine-emitted ONLY for that specific kill path (engine.ts distinguishes
  // `SubagentResult.stalled` before falling back to "error") — a real error still reports "error".
  // Deliberately NOT added to `turn_completed`'s own (separate) stopReason enum above — a stall
  // only ever aborts a CHILD thread from the outside; the main thread's own turn never stalls this
  // way (it has no watchdog of its own).
  type: z.literal("thread_completed"), stopReason: z.enum(["end_turn", "aborted", "error", "stalled"]),
});

/** Dispatch (Phase 7): appended to the DISPATCH session's stream by the DispatchChildren registry
 *  whenever a child session's status changes materially (spawned, turn ended, error, stopped).
 *  `status` is DERIVED daemon-side (never stored). `resultSummary` is the child's final
 *  assistant message when the update is a turn-end. */
export const ChildUpdateEvent = ThreadBase.extend({
  type: z.literal("child_update"),
  childSessionId: z.string().min(1),
  status: z.enum(["running", "awaiting_approval", "awaiting_input", "completed", "error"]),
  title: z.string(),
  resultSummary: z.string().optional(),
});

/** Background-agent completion notice (CC parity: <task-notification>), persisted and replayed as a
 *  user-role message so the model learns a detached agent finished without a user keystroke.
 *  Clients render nothing for it (thread_completed carries the visible finish line). Do NOT add a
 *  generator fixture: Swift round-trips it as unknownEvent (reasoning_item precedent). */
export const TaskNotificationEvent = ThreadBase.extend({ type: z.literal("task_notification"), content: z.string().min(1) });

export const SessionTitledEvent = ThreadBase.extend({
  type: z.literal("session_titled"), title: z.string().min(1),
});

/** Capability classes for the peripheral lease v1 stub (Phase 2f): the three real capabilities
 *  (implemented at Phase 5g) plus `noop`, the v1 stub used to gate the lease machinery end-to-end. */
export const PeripheralClassSchema = z.enum(["screenshot", "ax-read", "input-drive", "noop"]);
export const HolderSchema = z.object({
  kind: z.enum(["session", "plugin"]),
  id: z.string().min(1),
});
export type Holder = z.infer<typeof HolderSchema>;

/** TRANSIENT (broadcast-only via `broadcastTransient`, like `assistant_delta`): leases are
 *  runtime state — replay must never resurrect one. The audit log is the durable record.
 *
 *  `tokenHash` (sha256 hex of the raw token) rides this event so the PROVIDER can validate
 *  token+class+expiry on every `peripheral_call_requested` (spec §A1: "no token, no service") —
 *  the raw token itself is NEVER broadcast; it goes solely to the requester in the
 *  `peripheral.lease` RESPONSE and back from the requester in capability calls. */
export const LeaseGrantedEvent = ThreadBase.extend({
  type: z.literal("lease_granted"),
  leaseId: z.string().min(1),
  class: PeripheralClassSchema,
  holder: HolderSchema,
  expiresAt: z.number().int().nonnegative(),
  tokenHash: z.string().min(1),
});
/** TRANSIENT — see LeaseGrantedEvent. */
export const LeaseLostEvent = ThreadBase.extend({
  type: z.literal("lease_lost"),
  leaseId: z.string().min(1),
  class: PeripheralClassSchema,
  holder: HolderSchema,
  reason: z.enum(["expired", "released", "panic", "revoked", "provider-gone"]),
});
/** TRANSIENT — core pushes this to the provider's connection (approval-broker request/response
 *  pattern); the provider answers via `peripheral.respond {requestId, resultJson?, error?}`. */
export const PeripheralCallRequestedEvent = ThreadBase.extend({
  type: z.literal("peripheral_call_requested"),
  requestId: z.string().min(1),
  leaseId: z.string().min(1),
  token: z.string().min(1),
  class: PeripheralClassSchema,
  payloadJson: z.string(),
});

/** TRANSIENT (broadcast-only, like `assistant_delta`/the lease events above) — core pushes this
 *  to a plugin's own connection (the same approval-broker request/response pattern as
 *  `peripheral_call_requested`); the plugin answers via `plugin.toolResult`
 *  {requestId, resultJson?, error?} (methods.ts). A tool-call turn is never resurrected by
 *  replay, so this must never be persisted or re-delivered on session.attach. */
export const PluginToolInvokeEvent = ThreadBase.extend({
  type: z.literal("plugin_tool_invoke"),
  requestId: z.string().min(1),
  tool: z.string().min(1),
  argsJson: z.string(),
});

/** TRANSIENT (broadcast-only, like `assistant_delta`/the lease events/`plugin_tool_invoke` above)
 *  — core pushes this to the active PROVIDER's connection (Norma.app, spec §5) when a plugin (or
 *  the harness, dev/testing) calls `hardware.request` (methods.ts): the app-side broker answers
 *  via `hardware.respond` {requestId, resultJson?, error?}, the same approval-broker
 *  request/response pattern as `peripheral_call_requested`/`plugin_tool_invoke`. A hardware verb
 *  call is never resurrected by replay, so this must never be persisted or re-delivered on
 *  session.attach. */
export const HardwareRequestedEvent = ThreadBase.extend({
  type: z.literal("hardware_requested"),
  requestId: z.string().min(1),
  verb: z.string().min(1),
  argsJson: z.string(),
});

/** TRANSIENT (broadcast-only, never appended to the session log/replayed on attach — there's no
 *  session to attach to; see `SYSTEM_SESSION_ID` above) — Phase 4d Task 1's live tile push. Core
 *  broadcasts this to every authed harness (ipc/server.ts's `broadcastTileUpdated`) whenever a
 *  plugin's `tile.update` lands in `PluginContribRegistry`, and again with `tile: null` when the
 *  plugin disconnects (its tile is cleared, and dashboards must drop the now-stale card). Extends
 *  `Base` directly (NOT `ThreadBase`) — a plugin's declarative tile isn't scoped to any thread. */
export const PluginTileUpdatedEvent = Base.extend({
  type: z.literal("plugin_tile_updated"),
  pluginId: z.string().min(1),
  tile: z.record(z.string(), z.unknown()).nullable(),
});

/** TRANSIENT (broadcast-only, never persisted to the session log/replayed on attach — there's no
 *  session to attach to; `sessionId` is always the `$system` sentinel) — Phase 4d Task 2's
 *  harness→plugin push: core sends this directly to a plugin's own connection when a future UI
 *  fires one of that plugin's registered shortcuts (`shortcut.invoke`, methods.ts). Extends `Base`
 *  directly (NOT `ThreadBase`), same reasoning as `PluginTileUpdatedEvent` above — this push isn't
 *  scoped to any thread. */
export const ShortcutInvokeEvent = Base.extend({
  type: z.literal("shortcut_invoke"),
  shortcutId: z.string().min(1),
});

/** TRANSIENT — see `ShortcutInvokeEvent` above. Phase 4d Task 2's other harness→plugin push: core
 *  sends this when a future UI clicks one of the plugin's declarative tile's action buttons
 *  (`tile.action`, methods.ts). */
export const TileActionEvent = Base.extend({
  type: z.literal("tile_action"),
  actionId: z.string().min(1),
});

/** Reviewer observability (phase 5e T1, spec §1 — full NormaKit switch-trap discipline: this is a
 *  NEW variant, unlike `agent_error.code` above). Persisted once per ACTUAL `reviewer.review()`
 *  invocation (engine.ts's review hook) — NEVER for the `bashLooksSafe` static bypass, so this
 *  observes model-invocations of the reviewer, not every gate decision. `summary` is the capped,
 *  newline-stripped call précis (command/path/tool id — NEVER full args/bodies); `reason` is the
 *  reviewer's sentence, same sanitization. Both are sanitized+capped at EMISSION (engine side,
 *  reason<=300/summary<=160) — deliberately no zod max() here, matching sibling free-text fields
 *  (`approval_requested.summary`, `agent_error.message`) that also cap at the writer, not the
 *  schema. NOT sensitive (no `encrypted_content`) — a normal generator fixture exists (unlike
 *  `reasoning_item`/`task_notification` above). Injection containment: this event reaches CLIENTS
 *  ONLY — engine.ts's `eventToInput` never maps it back into the model's turn context (the
 *  reviewer's one deliberate channel to the model stays the pre-existing denial `tool_result`
 *  text). Engine replay: ignored (falls through `eventToInput`'s if-chain to its `null` default —
 *  no code change needed there for this to hold). */
export const ToolReviewEvent = ThreadBase.extend({
  type: z.literal("tool_review"),
  toolName: z.string().min(1),
  verdict: z.enum(["safe", "unsafe", "error"]),
  reason: z.string(),
  summary: z.string(),
});

/** Push-notification track (task-30, the final CC-parity tool item): emitted by the
 *  `push_notification` tool (core's `agent/tools/push-notification.ts`) once per call — a real
 *  wire event, NOT transient (unlike `assistant_delta`/the lease events above): it's persisted
 *  and replayed like `tool_review`/`task_updated`, so a client that attaches/reattaches later
 *  still sees it in the session's history. `title`/`message` mirror the tool's own zod bounds
 *  (min(1)/max(100) and min(1)/max(500)) — the tool always supplies a non-empty title (defaults
 *  to "Norma" when the caller omits one), so this schema can require both rather than treating
 *  either as optional.
 *
 *  DELIVERY is entirely client-side (NormaKit/CLI/app), not this schema's concern: the app posts
 *  a native `UNUserNotificationCenter` alert (see `SessionModel.apply` in the Norma target, which
 *  additionally gates delivery on the event's `ts` being wall-clock-fresh — a reattach/refocus
 *  replays a session's ENTIRE history from seq 0, and without that freshness gate every
 *  historical notification would re-fire as a new banner on every reconnect); the daemon itself
 *  also shells out to `osascript` as a headless fallback ONLY when the session has zero attached
 *  clients at emission time (`SessionHub.attachedCount`, checked by the engine's `notify` bridge
 *  in `engine.ts`) — see `agent/notify-fallback.ts`'s own doc comment for why that fallback is
 *  argv-safe against injection. */
export const NotificationRequestedEvent = ThreadBase.extend({
  type: z.literal("notification_requested"),
  title: z.string().min(1).max(100),
  message: z.string().min(1).max(500),
});

export const SessionEvent = z.discriminatedUnion("type", [
  SessionCreatedEvent,
  HarnessAttachedEvent,
  HarnessDetachedEvent,
  UserMessageEvent,
  TurnStartedEvent,
  AssistantMessageEvent,
  AssistantDeltaEvent,
  ToolCallEvent,
  ToolResultEvent,
  ReasoningItemEvent,
  ApprovalRequestedEvent,
  ApprovalResolvedEvent,
  TurnCompletedEvent,
  AgentErrorEvent,
  DirectoryAddedEvent,
  BgTaskStartedEvent,
  BgTaskOutputEvent,
  BgTaskExitedEvent,
  CheckpointEvent,
  QuestionAskedEvent,
  QuestionResolvedEvent,
  TaskUpdatedEvent,
  PlanPresentedEvent,
  PlanResolvedEvent,
  WorktreeEnteredEvent,
  WorktreeExitedEvent,
  ThreadStartedEvent,
  ThreadCompletedEvent,
  TaskNotificationEvent,
  SessionTitledEvent,
  LeaseGrantedEvent,
  LeaseLostEvent,
  PeripheralCallRequestedEvent,
  PluginToolInvokeEvent,
  HardwareRequestedEvent,
  PluginTileUpdatedEvent,
  ShortcutInvokeEvent,
  TileActionEvent,
  ToolReviewEvent,
  NotificationRequestedEvent,
  ChildUpdateEvent,
]);
export type SessionEvent = z.infer<typeof SessionEvent>;

/** Event payload before the store assigns seq/ts (distributes Omit over the union). */
type DistributedOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
export type NewSessionEvent = DistributedOmit<SessionEvent, "seq" | "ts">;
