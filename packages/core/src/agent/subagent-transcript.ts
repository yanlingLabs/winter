import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SessionEvent } from "@norma/protocol";

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
 */
const TRANSCRIPT_INCLUDE = {
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
 * Per-subagent transcript files (CC parity, "surface each subagent's FULL TRANSCRIPT as a file
 * path the parent agent can read/glob/grep" — token-efficient, exactly like Claude Code does). One
 * JSONL file per child thread at `<sessionTmpDir>/subagents/agent-<threadId>.jsonl`, holding every
 * ALLOWLISTED event scoped to that thread (see TRANSCRIPT_INCLUDE above) in append order. The
 * session tmp dir is ALREADY an allowed read root for the sandboxed read/glob/grep tools
 * (fs-read.ts's `readRootsOf`), so the model can consult its own subagents' transcripts with no
 * new fence/root — see spawn.ts's / agent-query.ts's tool descriptions for the "grep or paginate,
 * don't read it whole" guidance surfaced to the model.
 *
 * The child's spawn PROMPT is never itself persisted as a session event (engine.ts's own KNOWN GAP
 * note on `childHistoryInput` — the fresh spawn passes it straight into runThread's in-memory
 * input, never through the store). So the FIRST event this writer ever sees for a (sessionId,
 * threadId) pair — which, by construction (engine.ts registers the child thread immediately before
 * emitting its `thread_started`, and nothing else can be emitted for a brand-new threadId before
 * that), is always that child's own `thread_started` — gets a synthetic `{type:"spawn_prompt", ts,
 * agentType, prompt}` line written just ahead of it, so the file reads as a complete transcript
 * from the child's very first instruction onward. This closes the prompt-persistence gap AT THE
 * FILE level only — the session store / replay / childHistoryInput are completely untouched.
 *
 * Failure-safe, PER-THREAD (task-9 review, Minors 1+3): any error (a throwing tmpDirOf, a vanished
 * tmp dir, a full disk, a permissions problem, ...) is caught, logged once for THAT
 * (sessionId, threadId) key, and marks the key "failed" — every later append for it is a silent
 * fast no-op (no retry storm against a persistently broken path), while OTHER threads/sessions
 * keep their own independent state (one thread's failure never silences the rest of the process).
 * Nothing here ever throws into the engine's hot `emit()` path.
 */
export class SubagentTranscripts {
  // Per-(sessionId, threadId) lifecycle: absent = not bootstrapped yet; "ready" = directory
  // created (+ spawn_prompt written, when applicable) and appends flowing; "failed" = an fs/
  // accessor error was logged once for this key and all further appends for it are skipped.
  private readonly state = new Map<string, "ready" | "failed">();

  constructor(
    // Mirrors daemon.ts's own `tmpDirOf` accessor (registerLspTools' dep) — a getter over the
    // session tmp dir, absent/undefined meaning "this session has no transcript surfaced anywhere"
    // (e.g. a test harness that never wires it). Never called eagerly — only at `pathFor`/`append`
    // time, so an absent accessor costs nothing until something actually tries to use it.
    private readonly tmpDirOf: (sessionId: string) => string | undefined,
  ) {}

  /** Path construction that may THROW (tmpDirOf is caller-supplied and may do real work — e.g.
   *  daemon.ts wires sessionTmpDir, which mkdirs/realpaths) — internal only; both public entry
   *  points wrap it. */
  private buildPath(sessionId: string, threadId: string): string | undefined {
    const dir = this.tmpDirOf(sessionId);
    return dir ? join(dir, "subagents", `agent-${threadId}.jsonl`) : undefined;
  }

  /** Path accessor for result-building surfaces (bg tool_results, notifications, trailers,
   *  agent_output) — NEVER throws: a throwing tmpDirOf resolves to undefined, so those surfaces
   *  just omit the path, same as the unwired case. */
  pathFor(sessionId: string, threadId: string): string | undefined {
    try {
      return this.buildPath(sessionId, threadId);
    } catch {
      return undefined;
    }
  }

  /** Appends one JSON line for `event` to this (sessionId, threadId)'s transcript file, lazily
   *  creating the `subagents/` directory (and the synthetic spawn_prompt line, if `event` is this
   *  thread's first-ever `thread_started`) on the first call for that key. No-op — no file, no
   *  throw — when: the event type is not in TRANSCRIPT_INCLUDE's written set (allowlist, see its
   *  doc comment), tmpDirOf resolves to undefined (unwired), the key was already marked "failed",
   *  or any error occurs now (logged once, key marked "failed", see the class doc). */
  append(sessionId: string, threadId: string, event: SessionEvent): void {
    // Allowlist gate — fail closed: an unknown/future type reads `undefined` here, which is
    // `!== true`, so it is excluded until someone deliberately adds it to TRANSCRIPT_INCLUDE.
    if (TRANSCRIPT_INCLUDE[event.type] !== true) return;
    const key = `${sessionId} ${threadId}`;
    if (this.state.get(key) === "failed") return; // this thread's writer is disabled — fast no-op
    try {
      const path = this.buildPath(sessionId, threadId);
      if (!path) return; // tmpDirOf unwired for this session — transcripts off, not an error
      if (this.state.get(key) !== "ready") {
        mkdirSync(dirname(path), { recursive: true });
        this.state.set(key, "ready");
        if (event.type === "thread_started") {
          const spawnLine = { type: "spawn_prompt" as const, ts: event.ts, agentType: event.agentType, prompt: event.prompt };
          appendFileSync(path, JSON.stringify(spawnLine) + "\n");
        }
      }
      appendFileSync(path, JSON.stringify(event) + "\n");
    } catch (err) {
      this.state.set(key, "failed");
      console.error(`subagent transcript disabled for thread ${threadId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
