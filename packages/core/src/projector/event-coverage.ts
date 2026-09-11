import type { SessionEvent } from "@norma/protocol";

/**
 * ── WHY THIS FILE EXISTS (Winter 8b, C-5 / ruling P8b-9) ────────────────────────────────────────
 *
 * CLAUDE.md's protocol-change checklist step 4 is a COMPILE-TIME trap: a `satisfies
 * Record<SessionEvent["type"], boolean>` clause that stops `tsc` on `packages/core` the moment a
 * new `SessionEvent` variant is added to the protocol union, until someone makes an explicit
 * per-variant decision. Until 8b that clause lived in `agent/subagent-transcript.ts` — a file the
 * engine owns and that retires WITH the engine. Deleting the engine would have silently disarmed
 * the checklist for every future variant, which is why both maps now live here, in a module the
 * projector owns and nothing retires.
 *
 * ── WHY TWO MAPS AND NOT ONE ────────────────────────────────────────────────────────────────────
 *
 * They answer two different questions and their answers genuinely differ:
 *
 *   SUBAGENT_TRANSCRIPT_INCLUDE — "is this written into a child's MODEL-GREPPABLE transcript file?"
 *   PROJECTED_EVENT_COVERAGE    — "does the SDK→SessionEvent projector PRODUCE this variant?"
 *
 * Three variants show the split immediately: `assistant_delta` is excluded from a transcript file
 * (transient, never persisted) but IS produced by the projector (P8b-8: `stream_event` text deltas
 * → `assistant_delta`); `child_update` and `tool_review` are written into a child's transcript but
 * have producers (`agent/dispatch-children.ts`, the bash reviewer) that are not the projector at
 * all. Collapsing the two into one map would make whichever name it carried a lie. Both carry the
 * `satisfies` clause, so the checklist trap fires twice — deliberately.
 */

/**
 * ALLOWLIST BY DESIGN (task-9 review, Important): the transcript file is a MODEL-GREPPABLE
 * surface, so the event filter must fail CLOSED — an unknown/future event type must never leak
 * into it by default; add new types here deliberately. The `satisfies Record<SessionEvent["type"],
 * boolean>` clause makes this the NormaKit-switch-trap discipline at compile time: adding a NEW
 * SessionEvent variant to the protocol union makes this object non-conforming (missing key) and
 * fails `tsc --noEmit` until someone makes an explicit include/exclude decision for the transcript.
 *
 * `true` = written to the child's transcript file. The included set is derived from the engine's
 * actual thread-scoped emit sites (engine.ts's `this.emit(sessionId, { type: ..., threadId })`
 * calls that can carry a CHILD threadId): the conversation/tool flow a child produces.
 *
 * `false` = excluded. Notable exclusions:
 *  - reasoning_item: opaque `encrypted_content` whose ONLY allowed sink is the session store
 *    (events.ts:57-63 — "the session JSONL is its only sink"); a transcript file would be a
 *    second sink (user's standing security rule beats CC parity).
 *  - peripheral_call_requested / lease_granted / lease_lost: transient peripheral plumbing that
 *    carries a RAW capability token / tokenHash — must never land in a model-readable file.
 *  - assistant_delta + the plugin/hardware/tile events: TRANSIENT (broadcast-only, never
 *    persisted/replayed) — they never reach the engine's emit() chokepoint anyway.
 *  - session-scoped bookkeeping (session_created/titled, harness_*, directory_added, checkpoint,
 *    task_notification, bg_task_*): main-/session-scoped, never a child-thread event.
 *  - plan_presented/plan_resolved: plan tools are excluded from every child (childExcludeTools),
 *    so these are main-thread-only today.
 *  - workflow_started/_progress/_completed/_failed (CC-parity phase 3, Track D Task D1): the
 *    Workflow tool is main-thread-only (engine.ts's workflowsEnabled gate — "Top-level interactive
 *    CODE sessions only"), and daemon.ts's onEvent bridge always appends these with a hardcoded
 *    `threadId: "main"` — they can never be a registered child thread's own event, so this is the
 *    same "main-/session-scoped, never a child-thread event" bucket as session_created/checkpoint
 *    above, not a reachability accident.
 *
 * MOVED VERBATIM from `agent/subagent-transcript.ts` by Winter 8b Task 10 (C-5) — values and
 * comments unchanged; only its home moved, so the compile trap outlives the engine.
 */
export const SUBAGENT_TRANSCRIPT_INCLUDE = {
  // ---- written: the child thread's own conversation/tool flow ----
  thread_started: true,
  thread_completed: true,
  turn_started: true,
  turn_completed: true,
  assistant_message: true,
  tool_call: true,
  tool_result: true,
  user_message: true, // resume prompts / send_message drains persist child-scoped user_messages
  agent_error: true,
  approval_requested: true, // a gated child tool call's approval flow is part of its transcript
  approval_resolved: true,
  question_asked: true,
  question_resolved: true,
  task_updated: true, // task tools are not child-excluded — a child's task updates are its work
  tool_review: true, // reviewer verdicts on the child's own calls (précis only, never full args)
  // task-30 (push-notification track): push_notification is NOT in childExcludeTools (engine.ts) —
  // a background subagent finishing a long task is exactly the CC-parity case ("pushes when a
  // long task finishes"), so its own notification_requested calls are part of its work, same
  // reasoning as task_updated above. Content is just title/message text, nothing sensitive.
  notification_requested: true,
  worktree_entered: true,
  worktree_exited: true,
  child_update: true, // dispatch child status changes (spawned/running/awaiting/completed/error)
  // ---- excluded: allowlist by design — an unknown/future event type must never leak into a
  // model-greppable file; add new types above deliberately (see events.ts:57-63 for why
  // reasoning_item is absent from the written set) ----
  reasoning_item: false,
  assistant_delta: false,
  plan_presented: false,
  plan_resolved: false,
  checkpoint: false,
  task_notification: false,
  session_created: false,
  session_titled: false,
  harness_attached: false,
  harness_detached: false,
  directory_added: false,
  bg_task_started: false,
  bg_task_output: false,
  bg_task_exited: false,
  lease_granted: false,
  lease_lost: false,
  peripheral_call_requested: false,
  plugin_tool_invoke: false,
  hardware_requested: false,
  plugin_tile_updated: false,
  shortcut_invoke: false,
  tile_action: false,
  // session-activity-hygiene T4: TRANSIENT and SESSION-scoped (it carries no threadId at all — it
  // is a fact about the whole session's lifecycle, not about any thread), so it is in the same
  // bucket as harness_attached/session_created above twice over. It also never reaches the engine's
  // emit() chokepoint: `SessionHub.emitActivity` broadcasts it directly.
  session_activity: false,
  // CC-parity phase 3 (Workflows, Track D Task D1): main-thread-only — see the doc comment above.
  workflow_started: false,
  workflow_progress: false,
  workflow_completed: false,
  workflow_failed: false,
  // panel-shell T3: all five are SESSION-scoped (`Base.extend`, no `threadId`), so like the
  // `session_activity: false` above they never reach the engine's emit() chokepoint —
  // `engine.ts:1389` early-returns on any event without a `threadId`. A `true` here could not
  // fire. The agent learns what page is on screen in Plan B, via the browser tool's own
  // thread-scoped `tool_result`.
  panel_tab_opened: false,
  panel_tab_closed: false,
  panel_tab_activated: false,
  panel_tab_navigated: false,
  panel_command: false,
} satisfies Record<SessionEvent["type"], boolean>;

/**
 * Does the SDK→SessionEvent projector produce this variant, ever?
 *
 * `true` = some branch of `projector/` returns this variant from `accept()` (whether the caller
 * then persists it or, for a transient, hands it to the hub to broadcast). `false` = the projector
 * never produces it — either because it has a live non-projector producer that the Winter leg does
 * not disturb (every `panel_*` comes from a capability tool via `panel/open-tab.ts`; the four
 * `workflow_*` from `daemon.ts`; `bg_task_*` from `agent/bg-registry.ts`; `child_update` from
 * `agent/dispatch-children.ts`; `session_created`/`harness_*`/`session_activity` from
 * `sessions/{store,hub}.ts`), or because it must never be produced at all (`reasoning_item`:
 * opaque provider state whose only sink is the session JSONL — the projector has no branch that
 * can emit it, and none may ever be added).
 *
 * "Produce" means ANY door of the projector — `accept`, `beginTurn` or `acceptError` — not just
 * `accept`. `turn_started` is the row that makes the distinction matter: only `beginTurn` emits it,
 * and a map scoped to `accept` alone would call it `false` and invite the host to synthesize a
 * second one.
 *
 * This map is NOT decorative: `test/projector/event-coverage.test.ts` asserts the direction that can
 * be checked cheaply — every variant the projector actually emits across the golden scenarios is
 * `true` here — and `golden-replay.test.ts` now compares `beginTurn`'s batch rather than dropping
 * it, so a duplicate `turn_started` fails a test instead of reaching the session log.
 */
export const PROJECTED_EVENT_COVERAGE = {
  // ---- produced: the conversation spine (Task 10) ----
  assistant_message: true, // `assistant` (final) text blocks
  assistant_delta: true, // `stream_event` → `text_delta` (TRANSIENT: broadcast, never persisted)
  tool_call: true, // `assistant` (final) `tool_use` blocks
  tool_result: true, // `user` frames carrying `tool_result` blocks
  turn_completed: true, // the terminal `result`, `contextTokens` from its usage
  agent_error: true, // an `is_error` result (Task 11 refines the code per WS-14 §13 class)
  // `user_message` is produced ONLY as a pass-through: a `user` text frame that the host's own
  // push queue does not account for (an inbound agent-message delivery rendered into the child's
  // input). The ordinary path is the HOST appending `user_message` before it pushes (P8b-5), and
  // `projector/dedupe.ts` drops the echo so it is never appended twice.
  user_message: true,
  // ---- produced: children and the task graph (Task 11) ----
  //
  // A child thread's identity is the spawning `tool_use.id`, which is also the `tool_use_id` on its
  // completing `tool_result` — so both ends come off the wire with no registry lookup (children.ts).
  thread_started: true,
  thread_completed: true,
  // `system/task_updated` and `system/task_notification` fold into Winter's task graph mirror.
  task_updated: true,
  // ---- produced: the turn boundary the HOST opens ----
  //
  // PRODUCER: `beginTurn` (`index.ts`), not `accept`. The host calls `beginTurn` when it pushes a
  // user turn — after appending its own `user_message` (P8b-5) — and the batch that comes back
  // carries this event.
  //
  // **TASK 16's OBLIGATION IS THEREFORE "APPEND WHAT `beginTurn` RETURNS", NEVER "SYNTHESIZE YOUR
  // OWN".** A driver that did both would write TWO `turn_started` rows per turn into the session
  // JSONL — persisted, replayed, and (since `SUBAGENT_TRANSCRIPT_INCLUDE.turn_started` is `true`)
  // copied into every child's model-greppable transcript. This row said `false` for one review
  // cycle while `beginTurn` produced it, which is exactly how that would have happened.
  turn_started: true,
  //
  // ---- never produced ----
  //
  // APPROVALS AND QUESTIONS ARE THE BRIDGES', NOT THE PROJECTOR'S, and the reason is ordering. Both
  // are answered inside `canUseTool` — a CALLBACK that runs before any frame about the call reaches
  // the message stream. `approval_requested` / `question_asked` have to appear the moment the ask is
  // made, or nothing renders a card and nobody can answer; and only the bridge holds the answer, so
  // the `*_resolved` half is its too. By the time the projector sees anything, the question is
  // already answered and all that is left is an ordinary `tool_use`/`tool_result` pair, which it
  // projects as an ordinary `tool_call`/`tool_result`. The two producers' events line up in the
  // transcript because both key on the same `tool_use.id` as their `callId` — that shared join is
  // the whole reason the split works. See `projector/questions.ts`.
  //   producers: `runtime-sdk/approval-bridge.ts` + `question-bridge.ts` (Task 8), and for
  //   peripheral leases `daemon.ts:143-213`'s `buildLeasePolicy` (a second, older producer).
  approval_requested: false,
  approval_resolved: false,
  question_asked: false,
  question_resolved: false,
  // PLAN PRESENTATION IS THE SAME SHAPE, FOR THE SAME REASON (Winter Phase 8c, P8c-11 / Task 2.3):
  // `ExitPlanMode` also arrives inside `canUseTool`, resolved by the BRIDGE before any frame about
  // the call reaches the message stream — same ordering argument as approvals/questions just
  // above, same "the projector only ever sees the ordinary tool_use/tool_result pair once this is
  // already answered" consequence. This pair used to sit in the "fate follows the tool that
  // raised them" bucket below (the engine's `exit_plan_mode` tool retired with no successor named);
  // the successor is now named, so it moves up here rather than staying `true` on a promise the
  // brief's own text made but this map's documented semantics ("does the PROJECTOR produce this")
  // would contradict if honored literally — see `runtime-sdk/plan-bridge.ts`'s header doc comment.
  //   producer: `runtime-sdk/plan-bridge.ts`'s `planBridgeFor(...).onExitPlanMode`.
  plan_presented: false,
  plan_resolved: false,
  //
  // Opaque `encrypted_content` / `itemJson`; the session JSONL is its only sink and the projector
  // has no branch that can emit it. Never flip this to `true`.
  reasoning_item: false,
  // Live non-projector producers, untouched by the Winter leg (Norma map §3, "27 with non-engine
  // producers that keep working untouched").
  session_created: false,
  session_titled: false,
  harness_attached: false,
  harness_detached: false,
  session_activity: false,
  checkpoint: false,
  bg_task_started: false,
  bg_task_output: false,
  bg_task_exited: false,
  child_update: false,
  workflow_started: false,
  workflow_progress: false,
  workflow_completed: false,
  workflow_failed: false,
  lease_granted: false,
  lease_lost: false,
  peripheral_call_requested: false,
  plugin_tool_invoke: false,
  hardware_requested: false,
  plugin_tile_updated: false,
  shortcut_invoke: false,
  tile_action: false,
  panel_tab_opened: false,
  panel_tab_closed: false,
  panel_tab_activated: false,
  panel_tab_navigated: false,
  panel_command: false,
  // ---- engine-only PRODUCT events whose fate follows the tool that raised them (Norma map §3's
  // fourth bucket — "the one a plan forgets", because nothing in the type system notices their
  // producer vanishing). None of them is projected from a wire message; each needs its successor
  // named when the engine retires (Task 17), and that is tracked there, not here. ----
  directory_added: false, // the `ipc/server.ts:2010` half survives; the engine half does not
  worktree_entered: false,
  worktree_exited: false,
  tool_review: false, // `BashReviewer` stays on the provider layer (P8b-10)
  notification_requested: false, // the `dispatch-children.ts:260` half survives
  task_notification: false,
} satisfies Record<SessionEvent["type"], boolean>;
