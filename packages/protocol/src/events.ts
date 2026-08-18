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
  // Chat Mode Slice A: "chat" added — a conversation with no filesystem/shell access that shares
  // dispatch's _assistant memory bucket but, unlike dispatch, is NOT a singleton (many chats).
  mode: z.enum(["code", "dispatch", "chat"]).optional(),
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

/** Shape shared by the diff store's on-disk id (`packages/core/src/diffs/store.ts`'s `DIFF_ID_RE`)
 *  and every wire reference to one. Kept as two separate constants in two packages deliberately —
 *  core has no reason to depend on protocol's zod schemas — but the PATTERN must match exactly: a
 *  diffId that fails this regex can never reach `writeDiff`/`readStoredDiff`'s path-join guard. */
export const DIFF_ID_SHAPE = /^[A-Za-z0-9_-]{1,64}$/;

/** Summary of one file's diff, stamped onto `ToolResultEvent.fileDiff` below and returned (with a
 *  patch body) by `panel.readDiff` (methods.ts). `path`/`diffId` are bounded (1024 / 64 chars) —
 *  load-bearing, not tidiness: this shape rides inside a PERSISTED, remote-streamed `tool_result`
 *  event, so an unbounded field would be exactly the silent-connection-killer hazard
 *  `PANEL_URL_MAX_LENGTH`'s doc (further down this file) names for panel fields — `capEvent`'s
 *  whole-event ceiling and the phone's frame limit are the real bounds a value here must stay
 *  under. */
export const FileDiffSummary = z.object({
  path: z.string().min(1).max(1024),
  added: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative(),
  diffId: z.string().regex(DIFF_ID_SHAPE),
});
export type FileDiffSummary = z.infer<typeof FileDiffSummary>;

export const ToolResultEvent = ThreadBase.extend({
  type: z.literal("tool_result"), callId: z.string().min(1), output: z.string(), isError: z.boolean(),
  /** Set only by the daemon engine for edit/write/notebook_edit; chat-mode engines never produce it. */
  fileDiff: FileDiffSummary.optional(),
});
/** Opaque provider reasoning item (Responses API), captured at output_item.done and replayed
 *  verbatim into later requests (CC/Codex parity — see the history-parity spec). itemJson is
 *  SENSITIVE opaque state (encrypted_content): the session JSONL is its only sink; clients
 *  (CLI/app) deliberately do NOT model this variant — both skip unknown event types, so it
 *  never renders. Do NOT add a generator fixture: Swift's all-fixtures round-trip would degrade
 *  it to unknownEvent and fail equality; TS tests cover the variant. */
export const ReasoningItemEvent = ThreadBase.extend({ type: z.literal("reasoning_item"), itemJson: z.string().min(1) });

/** SP-approvals T4: a caller-facing "grant a rule" choice offered alongside plain approve/deny —
 *  e.g. "Always allow `git push` in this project." `id` is an open set (not a literal union here:
 *  the daemon mints the concrete ids per tool, engine.ts's `approvalOptionsFor` — Task 5 — typically
 *  "allow_once" | "allow_project" | "allow_global" | "deny"); `label` is the exact human-readable
 *  text to render, already composed with the rule string for a rule-bearing option, so a client
 *  never has to build that sentence itself. `rule`/`scope` are present TOGETHER on an option that
 *  persists a permission rule when chosen (the wire carries the chosen option back via
 *  `ApprovalRespondParams.optionId`, methods.ts) and both absent on a plain option (allow-once/deny)
 *  that grants nothing durable. */
export const ApprovalOption = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  rule: z.string().optional(),
  scope: z.enum(["project", "global"]).optional(),
});
export type ApprovalOption = z.infer<typeof ApprovalOption>;

export const ApprovalRequestedEvent = ThreadBase.extend({
  type: z.literal("approval_requested"), callId: z.string().min(1), toolName: z.string().min(1), summary: z.string(),
  // SP3 T4b: the approval's issue/expiry timestamps (epoch ms). The daemon ALWAYS emits both on
  // NEW events (it always knows the deadline at emit time) — but the fields are OPTIONAL, exactly
  // like reviewerReason/childSessionId below, so OLDER persisted events (pre-T4b session JSONL)
  // still parse: SessionStore recovery re-parses every line through this schema and a required
  // field would silently DROP every pre-T4b approval_requested from history (irreversible loss +
  // seq gaps — Phase-A review CRITICAL). Absent means "unknown expiry" — clients must treat it as
  // NOT expired, never as expired. `expiresAt` is the broker's fail-closed timeout deadline
  // (issuedAt + timeoutMs); a phone renders "expires in Ns" and derives `.expired` from it without
  // waiting for approval_resolved{by:"timeout"} — the same value the parallel `approval.list`
  // (methods.ts) surfaces, where it is ALWAYS present (a live query, never an old persisted line).
  issuedAt: z.number().int().optional(), expiresAt: z.number().int().optional(),
  // Phase 5e T1 (reviewer maturity, spec §"reviewerReason? on approval_requested"): populated when
  // this escalation came from the safety reviewer (engine.ts's review hook) — the reviewer's own
  // sentence, sanitized+capped at EMISSION (engine side), so clients can render it distinctly from
  // `summary` instead of the old smashed-in "⚠ safety reviewer: ..." prefix. Additive/optional — an
  // ask-policy or reviewer-less escalation omits it, and older-shaped events still parse.
  reviewerReason: z.string().optional(),
  // Dispatch relay (Phase 7): set on the MIRRORED copy of a child session's approval living in the
  // dispatch session's stream — identifies which child to respond into. Absent on native approvals.
  childSessionId: z.string().optional(),
  // SP-approvals T4: per-approval allow-rule choices (Task 5's `approvalOptionsFor`) — e.g. an
  // "always allow `git push` in this project" option alongside plain approve/deny. Optional/
  // additive: a reviewer-escalation/grant/worktree card (no rule-worthy shape) or an older
  // persisted event omits it; clients that don't render options still see a valid approval card.
  options: z.array(ApprovalOption).optional(),
});
export const ApprovalResolvedEvent = ThreadBase.extend({
  type: z.literal("approval_resolved"), callId: z.string().min(1), approved: z.boolean(), by: z.string().min(1),
  // Dispatch relay (Phase 7): see approval_requested.
  childSessionId: z.string().optional(),
});
/** `inputTokens`/`outputTokens` are the turn's TOTALS — summed across every tool round — which is
 *  what a "tokens billed this turn" readout means (the CLI/TUI turn-summary line renders exactly
 *  this). They are NOT the size of the context, and must never be used as such: a turn with N tool
 *  rounds re-sends the (growing) context N times, so the sum can be several times the largest
 *  single request.
 *
 *  `contextTokens` (additive optional, like `agent_error.code` — an extra field on an EXISTING
 *  variant, so no new Swift case and no NormaKit exhaustive-switch trap) is the OTHER figure: the
 *  provider-reported input size of the turn's LARGEST single request, i.e. how full the context
 *  actually got. That is the only correct input to the auto-compaction trigger
 *  (`engine.ts`'s `maybeAutoCompact`), which previously read `inputTokens` and therefore compacted
 *  prematurely on tool-heavy turns — a session whose context was 40% full got summarized because
 *  three rounds of it summed past the threshold.
 *
 *  ABSENT (events written before 2026-07-31, the pre-stream error path where no round ever reported
 *  usage, and any producer that does not emit it) means **SKIP THE EVENT** — never fall back to
 *  `inputTokens`. That fallback IS the bug above: `inputTokens` sums across tool rounds, so
 *  substituting it re-introduces exactly the premature compaction this field was added to remove,
 *  on precisely the events that carry the least information. `engine.ts`'s `maybeAutoCompact`
 *  deliberately carries NO `?? inputTokens` for this reason; a consumer with nothing to read should
 *  keep looking back rather than trust a figure that means something else. If you EMIT this field,
 *  it is the per-round MAXIMUM (`Math.max` across the turn's requests), never a sum and never the
 *  last round's value.
 *
 *  Mirrored on the Swift side too (followups T3, `apple/NormaProtocol/Sources/NormaProtocol/
 *  SessionEvent.swift`'s `TurnCompleted.contextTokens`), with a TS-generated fixture
 *  (`turn_completed_with_contextTokens.json`) proving the round-trip — the "TS-only, no Swift
 *  mirror, no client renders it" reasoning that used to sit here expired the moment
 *  `NormaChatKit`'s `ChatEngine` became a live SECOND producer of `turn_completed`: its events reach
 *  this daemon's log verbatim via `sync.push`, and the field only survives that trip because the
 *  Swift type that gets JSON-encoded once (on the phone, at emit time) actually carries it. A
 *  future field addition to an existing variant should re-ask this question fresh rather than
 *  assume "no Swift mirror needed" still holds — it holds only until a second producer exists. */
export const TurnCompletedEvent = ThreadBase.extend({
  type: z.literal("turn_completed"), stopReason: z.enum(["end_turn", "aborted", "error"]),
  inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative(),
  contextTokens: z.number().int().nonnegative().optional(),
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
  // `header` is the ≤12-char chip shown above a question in multi-question cards. OPTIONAL since
  // Slice B1: chat's `AskQuestion` emits a deliberately simplified card (question + labels + Other,
  // no chip, no per-option description, no notes), and a header-less question is a genuinely
  // different SHAPE — not a rendering trick. Absent ⟹ simplified card; see PendingCards.swift.
  question: z.string().min(1), header: z.string().min(1).max(12).optional(),
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

/** CC-parity phase 3 (Workflows, Track D Task D1): the wire counterpart of WorkflowRuntime's
 *  internal `WorkflowRuntimeEvent` (core's `workflows/runtime.ts`) — the daemon's `onEvent` bridge
 *  (daemon.ts) maps its `started`/`progress`/`completed`/`failed` variants onto these 4 events so
 *  an attached client (the app) can watch a Workflow run live. Additive to, never instead of, the
 *  existing `notifyWorkflowCompletion` assistant-facing `task_notification` these SAME runtime
 *  events also drive — the wire events are new observability, not a replacement channel. NOT
 *  sensitive (no `encrypted_content`) — normal generator fixtures, same precedent as
 *  `tool_review`/`notification_requested` above (full NormaKit exhaustive-switch discipline: these
 *  are NEW variants). */
export const WorkflowStartedEvent = ThreadBase.extend({ type: z.literal("workflow_started"), runId: z.string().min(1), name: z.string().optional(), summary: z.string() });
export const WorkflowProgressEvent = ThreadBase.extend({ type: z.literal("workflow_progress"), runId: z.string().min(1), phase: z.string().optional(), log: z.string().optional(), running: z.number().int().nonnegative(), completed: z.number().int().nonnegative(), total: z.number().int().nonnegative() });
export const WorkflowCompletedEvent = ThreadBase.extend({ type: z.literal("workflow_completed"), runId: z.string().min(1), resultSummary: z.string() });
export const WorkflowFailedEvent = ThreadBase.extend({ type: z.literal("workflow_failed"), runId: z.string().min(1), error: z.string() });

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

/** session-activity-hygiene (spec §1): a code/cowork session's lifecycle state.
 *
 *  A REAL lifecycle, not a cosmetic label — from T5 on, `active` carries enforcement (when the last
 *  harness detaches and the session is not backgrounded, its running turn is aborted through the
 *  ESC-abort path). Two of the four are STORED flags (`backgrounded`, `archived` — index columns on
 *  `SessionRow`); the rest is derived at read time from signals the daemon already owns (running
 *  turns, hub attachments, background bash/agent registries). The single derivation lives in
 *  `packages/core/src/sessions/activity.ts` (`activityFor`) — never re-derive it at a call site.
 *
 *  ABSENT IS A REAL VALUE: "this session does not participate". Chat and dispatch never carry one
 *  (dispatch is definitionally the daemon itself; chat needs none of this), so a client must render
 *  absence as "no state", never coerce it to `idle`.
 *
 *  Lives HERE rather than beside its first consumer (`SessionListResult`, methods.ts) because the
 *  `session_activity` event below needs the same enum and methods.ts already imports from this
 *  file — the reverse edge would be a module cycle. */
export const SessionActivity = z.enum(["active", "background", "idle", "archived"]);
export type SessionActivity = z.infer<typeof SessionActivity>;

/** TRANSIENT (broadcast-only via `broadcastTransient`, like `assistant_delta` and the lease events
 *  above) — session-activity-hygiene T4, the LIVE half of the lifecycle `session.list` made
 *  readable and `session.setActivity` made writable.
 *
 *  Emitted by the daemon (`SessionHub.emitActivity`) whenever a participating session's DERIVED
 *  state actually changes, so an open UI flips without polling `session.list`. Session-scoped, not
 *  thread-scoped: activity is a fact about the whole session (an attachment, a stored flag), never
 *  about one thread — hence the `harness_attached`/`harness_detached` shape (bare `Base`, no
 *  `threadId`) rather than `ThreadBase`.
 *
 *  Why transient rather than persisted: the state is a pure FUNCTION of the two stored flags plus
 *  live signals (attachments, running turns) and is re-derived on every read, so a replayed history
 *  of past transitions would be a second, staler source of truth for something the next
 *  `session.list` answers exactly. Persisting it would also make every attach/detach churn append
 *  to the JSONL. Clients must treat it as advisory-and-current, and exempt it from seq dedupe /
 *  cursor advancement like every other transient (see `TRANSIENT_EVENT_TYPES` below).
 *
 *  Only ever carries a state a participating session can actually be in: chat/dispatch derive to
 *  `undefined` ("no lifecycle"), and `emitActivity` emits nothing for them — absence is never
 *  represented on the wire. */
export const SessionActivityEvent = Base.extend({
  type: z.literal("session_activity"),
  activity: SessionActivity,
});

export const PanelTabKind = z.enum(["web", "document", "code", "note", "diff", "files"]);

/** panel-cef Task 6b: the field-size caps on every panel `url`/`title`, carried from Plan A (which
 *  surfaced them and owned none) and made LIVE by this task — Task 6b builds the first producer of
 *  either field, so until now nothing on earth could set them.
 *
 *  **Why this is a security bound and not tidiness.** A page `<title>` is chosen by whatever site
 *  the user visits, and it lands in a session JSONL that is APPEND-ONLY, NEVER DELETED, replayed on
 *  every session open, and re-read WHOLE by `panel.list` on every attach/hop. Unbounded, one hostile
 *  page could park megabytes in a file the daemon re-reads forever.
 *
 *  **These caps bind on READ as well as on write**, and that is deliberate rather than incidental:
 *  `SessionStore` parses every log line through `SessionEvent` (`sessions/store.ts`) exactly as
 *  `hub.append` parses every write, so a value that cannot be written can never be read either.
 *
 *  **The corollary if these numbers are ever LOWERED is DATA LOSS, not a loud failure.** An
 *  already-written longer event becomes unparseable — and `readGoodLines` (`sessions/store.ts`)
 *  SKIPS unparseable lines rather than stopping at them, so the session still opens and simply has
 *  fewer events in it. Worse, `recoverAll` runs on every daemon open, sees `sawBad`, and REWRITES
 *  the log file without the offending lines (temp+rename). A shrunk cap therefore silently and
 *  PERMANENTLY deletes already-recorded panel navigations from a JSONL that is append-only,
 *  never-deleted and user-delete-only — at the next daemon start, with nothing anywhere saying so.
 *  Raising them is always safe; lowering them is a data migration, and the reason is destruction
 *  rather than a failed read.
 *
 *  Present tense, same mechanism: these caps were ADDED to pre-existing event types, so any
 *  `panel_tab_opened` already on disk with an over-cap `url`/`title` is skipped on read and dropped
 *  from the log at the next open. Unreachable through the shipped path (no producer of either field
 *  existed before this task — the panel "+" always passed `nil`), reachable by anyone who called
 *  `panel.openTab` over the socket directly since Plan A.
 *
 *  Sized to be unreachable by honest content rather than tight:
 *   - **2048 chars for a URL** — the de-facto interop ceiling (IE's 2083; most servers cap headers
 *     near 8 KiB). Only `http`/`https` URLs are ever persisted (see `PanelReportNavigationParams`
 *     in methods.ts), so the unbounded shapes — `data:` and `javascript:` — cannot reach here at all.
 *   - **256 chars for a title** — far above any real `<title>` and above what the tab pill can show
 *     at `panelTabPillSize.width`.
 *
 *  The APP's producer truncates a title to this and DROPS an over-long URL rather than truncating it
 *  (a truncated URL is a different, wrong URL that would later be restored into a web view), so a
 *  real page never reaches these limits from the shipped path. Mirrored in Swift by
 *  `PanelURLPolicy.urlMaxLength`/`.titleMaxLength` (`apple/Norma/Sources/AppShell/PanelURLPolicy
 *  .swift`), with a literal pin test on each side naming the other — two hand-mirrored numbers in
 *  two languages with no compile-time coupling is this repo's worst known drift class
 *  (`TRANSIENT_EVENT_TYPES`), and drift here is SILENT in both directions because the app's
 *  `try?`-wrapped RPC swallows the rejection. */
export const PANEL_URL_MAX_LENGTH = 2048;
export const PANEL_TITLE_MAX_LENGTH = 256;

export const PanelTabOpenedEvent = Base.extend({
  type: z.literal("panel_tab_opened"),
  tabId: z.string().min(1),
  kind: PanelTabKind,
  url: z.string().max(PANEL_URL_MAX_LENGTH).optional(),
  title: z.string().max(PANEL_TITLE_MAX_LENGTH).optional(),
  /** Set only when kind === "diff". */
  diffId: z.string().regex(DIFF_ID_SHAPE).optional(),
});

export const PanelTabClosedEvent = Base.extend({
  type: z.literal("panel_tab_closed"),
  tabId: z.string().min(1),
});

export const PanelTabActivatedEvent = Base.extend({
  type: z.literal("panel_tab_activated"),
  tabId: z.string().min(1),
});

/** Committed TOP-LEVEL navigations only — no subframes, no in-flight redirects, no fragment
 *  changes. That bound is what keeps a browsing session at ~10-50 events instead of thousands,
 *  in a JSONL that is replayed on every session open.
 *
 *  panel-cef Task 6b built the sole producer and resolved that bound in CEF's own terms:
 *  `CefLoadHandler::OnLoadEnd` gated on `frame->IsMain()`. `include/cef_load_handler.h` states the
 *  exclusions verbatim — the callback comes "after a navigation has been committed", and "will not
 *  be called for same page navigations (fragments, history state, etc.) or for navigations that
 *  fail or are canceled before commit" — so all three exclusions are CEF's contract rather than a
 *  filter the app maintains. Live address changes (which DO include fragments) drive the URL field
 *  only and are never reported. */
export const PanelTabNavigatedEvent = Base.extend({
  type: z.literal("panel_tab_navigated"),
  tabId: z.string().min(1),
  url: z.string().min(1).max(PANEL_URL_MAX_LENGTH),
  title: z.string().max(PANEL_TITLE_MAX_LENGTH),
});

/** B2 Task 2: the agent's nine browser verbs, in one place so the TS producer, the app's consumer
 *  and the tool schema all name the same set. Plan A shipped this enum one-valued (`navigate`) with
 *  no producer at all; B2 gives the agent hands.
 *
 *  Split by capability, because the per-mode tool registry depends on the split (spec §1): the READ
 *  set — `navigate`, `back`, `read`, `screenshot` (plus the tab verbs, which are RPCs and never
 *  travel this channel) — is what chat mode may ever reach; the INTERACT set — `click`, `type`,
 *  `scroll`, `submit`, `wait` — is offered only in code and dispatch. This constant is deliberately
 *  the FLAT union: the wire has no reason to care which half a verb came from, and the split that
 *  matters is enforced where it is decided (the tool registration), not here.
 *
 *  **B2 Task 4 built that registration, and two clauses above needed correcting to stay true.**
 *
 *  (1) The spec's phrase was "code/cowork/dispatch"; the DAEMON has no such mode. `registry.ts`'s
 *  `Mode` is `code|dispatch|chat` and `engine.ts`'s `resolveMode` folds a `cowork` session into
 *  `"chat"` (deliberately — see its own comment: cowork is chat-shaped and there is no cowork slot
 *  for a per-mode seam to resolve against). So the day cowork ships, a cowork session gets CHAT's
 *  read-only browser until someone widens `Mode` — a change with its own blast radius, not made
 *  here. "code and dispatch" is what is actually enforced, so that is what this now says.
 *
 *  (2) "Enforced at the tool registration" is now literal rather than a rendering convention:
 *  `browser` declares `ToolDefinition.argsByMode` (`packages/core/src/agent/tools/registry.ts`),
 *  which resolves through ONE predicate that both `specs()`/`specFor()` (what the model is shown) and
 *  `execute()` (what is accepted) call. A chat session that named an INTERACT verb anyway — a
 *  provider ignoring the advertised schema — is rejected at argument validation, before the tool's
 *  own code runs and long before anything is emitted onto this channel. */
export const PANEL_COMMAND_ACTIONS = [
  "navigate", "back", "read", "screenshot", "click", "type", "scroll", "submit", "wait",
] as const;

/** Cap on `panel_command.args`, measured as `Buffer.byteLength(JSON.stringify(args), "utf8")` —
 *  BYTES of serialized JSON, not characters and not per-field. Bytes because the thing being bounded
 *  is a socket frame; the whole object because `args` is `z.unknown()`-valued and a per-field cap
 *  cannot see inside a nested shape.
 *
 *  **8 KiB, and why that number.** The payloads are per-verb and small by nature — a CSS selector, a
 *  scroll offset, a wait predicate — with exactly one that scales with model output: `type`'s text.
 *  8 KiB is roughly 8000 ASCII characters, well past any form field an agent legitimately fills
 *  (a long email draft is ~2 KiB), and it sits two orders of magnitude below the limits that would
 *  actually bite. Those limits are real and worth naming, because `panel_command` is in
 *  `REMOTE_STREAM_EVENT_TYPES` and therefore reaches the PHONE even though the phone has no panel:
 *  `capEvent`'s `WHOLE_EVENT_CEILING` (160 KiB) and the iroh de-framer's hard 1 MiB frame, whose
 *  overflow path is a silent connection kill. An unbounded `args` would be exactly the
 *  "oversized field is a silent connection-killer" hazard CLAUDE.md names.
 *
 *  **Refused, never truncated.** A truncated selector or a truncated typed string is a DIFFERENT,
 *  wrong action performed against a browser the user is logged into — the same reasoning that makes
 *  the app drop an over-long URL rather than shorten it (`PANEL_URL_MAX_LENGTH`'s doc above). */
export const PANEL_COMMAND_ARGS_MAX_JSON_BYTES = 8 * 1024;

/** TRANSIENT — the daemon's only push channel to the app for verbs needing CEF execution.
 *
 *  Why transient rather than persisted: a persisted command is REPLAYED on every future attach,
 *  and unlike a replayed `ask_user` (which renders a stale card) a replayed `navigate` is an
 *  ACTION. Transient removes the hazard by construction rather than by a rule someone has to
 *  remember — transients are never persisted, so they can never be replayed. B2 sharpens that
 *  reasoning rather than softening it: a replayed `click` or `submit` would re-fire a purchase.
 *
 *  Tab lifecycle mutations are NOT commands: the daemon mints the id and appends the persisted
 *  event, and the app reacts to it. Commands carry only verbs whose value is the RESULT — which is
 *  why every command has an answer channel (`panel.commandResult`, methods.ts) and a `commandId`
 *  correlating the two. The daemon holds a pending entry per `commandId` until the first result
 *  wins or `deadlineMs` expires (`packages/core/src/panel/commands.ts`). */
export const PanelCommandEvent = Base.extend({
  type: z.literal("panel_command"),
  commandId: z.string().min(1),
  tabId: z.string().min(1).optional(),
  action: z.enum(PANEL_COMMAND_ACTIONS),
  // Capped for consistency with the persisted variants above, though the reasoning differs: this
  // one is TRANSIENT and never enters a JSONL, so the cap here bounds a FRAME rather than a file.
  // It is still the right default — B2's agent-authored navigate is the producer, and a model can
  // emit an arbitrarily long string.
  url: z.string().max(PANEL_URL_MAX_LENGTH).optional(),
  /** Per-verb payload, opaque at this layer. B2 Task 5 fixed the real shapes on both sides:
   *  `{selector}` for `click`/`submit`, `{selector, text}` for `type`, `{selector}` OR
   *  `{direction, amount}` for `scroll`, `{until, timeoutMs}` for `wait`. (This comment used to say
   *  `{dx, dy}` for `scroll`, which the built verb is not.)
   *  Deliberately NOT a discriminated per-verb union —
   *  the consumer that gives each key meaning is the app's CDP bridge (Task 3), and a wire-level
   *  union would have to be re-mirrored in Swift on every verb tweak for no gained safety (the
   *  Swift side decodes `args` as opaque JSON either way). Bounded by
   *  `PANEL_COMMAND_ARGS_MAX_JSON_BYTES`; see that constant for the byte measure and for why an
   *  over-cap object is REFUSED rather than truncated.
   *
   *  The cap is a FIELD-level `.refine`, not an object-level `.superRefine` (the shape
   *  `PanelOpenTabParams` uses one file over): an object-level refinement turns the schema into a
   *  `ZodEffects`, and `z.discriminatedUnion` below accepts only `ZodObject` members — this event
   *  is a union member, that one is a standalone params schema. */
  args: z.record(z.string(), z.unknown()).refine(
    (a) => Buffer.byteLength(JSON.stringify(a), "utf8") <= PANEL_COMMAND_ARGS_MAX_JSON_BYTES,
    { message: `args JSON exceeds the ${PANEL_COMMAND_ARGS_MAX_JSON_BYTES}-byte cap` },
  ).optional(),
  /** How long the daemon holds the pending entry before resolving it as a TIMEOUT. Set by the
   *  producer per verb (`wait` and `navigate` need longer than `click`), never by the model. */
  deadlineMs: z.number().int().positive(),
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
  WorkflowStartedEvent,
  WorkflowProgressEvent,
  WorkflowCompletedEvent,
  WorkflowFailedEvent,
  SessionActivityEvent,
  PanelTabOpenedEvent,
  PanelTabClosedEvent,
  PanelTabActivatedEvent,
  PanelTabNavigatedEvent,
  PanelCommandEvent,
]);
export type SessionEvent = z.infer<typeof SessionEvent>;

/** The nine BROADCAST-ONLY TRANSIENT event types — the canonical, cross-language definition.
 *
 *  A transient is fanned out to attached clients by `SessionHub.broadcastTransient` and is NEVER
 *  appended to the session log: absent from the JSONL, absent from attach replay, absent from
 *  `session.history`. It is stamped with `seq = the store's CURRENT lastSeq` — the seq of the last
 *  event actually APPENDED, not one of its own — so on a caught-up client a transient routinely
 *  arrives at `seq == cursor` (and can even sit BELOW the cursor). Every client therefore MUST
 *  exempt these from BOTH seq-based dedupe AND lastSeq/cursor advancement (see
 *  `AssistantDeltaEvent`'s own doc comment for the original statement of that obligation).
 *
 *  **Why this constant exists.** The list was hand-copied into four places — `NormaClient.route`
 *  (Mac), `NormaSessionClient` (phone), its test mirror, and the daemon's remote live-stream
 *  filter (`sessions/remote-stream.ts`) — because Swift's `SessionEvent.Discriminator` is
 *  `private`. Hand-mirrored list #4 was one copy too many: an event type that is transient in the
 *  daemon but missing from a client's copy is dropped 100% of the time, silently, with a green
 *  suite (exactly the iOS-streaming bug — the phone's client was missing the whole list). The
 *  Swift mirror is `SessionEvent.transientTypes` in `apple/NormaProtocol`; both sides are pinned to
 *  the same literal nine by parity tests (`packages/core/test/ipc/remote-live-stream.test.ts`
 *  and `SessionEventTransientTests`), so editing one side alone fails a test rather than silently
 *  diverging.
 *
 *  **Adding a transient is a TWO-list edit** (CLAUDE.md's protocol-checklist addendum): this set AND
 *  `REMOTE_STREAM_EVENT_TYPES` (`packages/core/src/sessions/remote-stream.ts`, which derives its
 *  transient half from here — so membership here is what gets a new transient to the phone at all).
 *  The parity tests pin "exactly the current set", which catches an ADDITION on one side only; they
 *  cannot catch an omission from a list that was never told the type exists. */
export const TRANSIENT_EVENT_TYPES: ReadonlySet<SessionEvent["type"]> = new Set<SessionEvent["type"]>([
  "assistant_delta",
  "lease_granted",
  "lease_lost",
  "peripheral_call_requested",
  "plugin_tool_invoke",
  "hardware_requested",
  "plugin_tile_updated",
  // session-activity-hygiene T4: the lifecycle's live signal (7 → 8).
  "session_activity",
  // panel-shell T3: the daemon->app command channel. See PanelCommandEvent for why transient.
  //
  // This membership ALSO puts it on the remote stream — `REMOTE_STREAM_EVENT_TYPES` spreads this
  // set wholesale rather than listing it — and that is accepted rather than worked around.
  //
  // **Corrected mechanism (whole-branch review, Minor-1): the phone decodes this variant fine,
  // `args` included.** `SessionEvent.PanelCommand` has carried `args` since B2 Task 2, content-
  // checked by NormaProtocol's own round-trip test. `NormaKit`'s `try?` (`parseServerLine`)
  // protects the CONNECTION from a genuinely unrecognized event — it has nothing to do with this
  // one, which decodes just fine. What actually drops it is the phone's chat-transcript fold, which
  // handles only `HISTORY_EVENT_TYPES ∪ {assistant_delta}` and `default: break`s on everything else
  // (`norma-ios` `Transcript.apply`). The agent's browsing URLs are not lost the same way: they
  // already reach the phone via `tool_call`, which IS in `HISTORY_EVENT_TYPES`, with its arguments.
  //
  // **The forward obligation that leaves (M6, a decision rather than an oversight):** `args` carries
  // MODEL-AUTHORED text (a `type` call's `text`, a selector) inside an opaque record, on an event
  // that DOES reach the phone. Nothing renders it there today, so nothing is exposed today — but the
  // day a phone renderer reads `panel_command.args`, it must treat it as untrusted model text,
  // exactly as any renderer of `tool_call.argsJson` already must.
  //
  // Panel STATE stays Mac-only the real way: the four persisted panel variants are absent from
  // `HISTORY_EVENT_TYPES`.
  "panel_command",
]);

/** Event payload before the store assigns seq/ts (distributes Omit over the union). */
type DistributedOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
export type NewSessionEvent = DistributedOmit<SessionEvent, "seq" | "ts">;
