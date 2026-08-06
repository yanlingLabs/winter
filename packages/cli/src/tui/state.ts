/** Pure app-state reducer for the Ink TUI (Phase 3a Task 2) — THE HEART: composes Norma's existing
 *  tested reducers (`subagent-state.ts`'s `updateSubagents`, `task-block.ts`'s `upsertTask`) into
 *  ONE `TuiState` that every Ink component (Tasks 3-6) renders from. Every wire event in main.ts's
 *  interactive switch (packages/cli/src/main.ts:493-680) has an equivalent transition here.
 *
 *  Note-block wording is matched to main.ts's plain-text CONTENT (glyphs/words), MINUS the
 *  embedded ANSI escapes main.ts's `emit()` bakes in — `Block`'s fields are presentation-agnostic
 *  data; coloring a note/tool/assistant block is the Ink components' job (Tasks 3-6), not this
 *  reducer's. `approval_resolved`'s note (main.ts never prints one today — raw-mode there just
 *  lets the "y/N" keystroke reach cooked stdin) is new: Ink owns the whole render surface via
 *  `useInput`, so an answered approval needs an explicit committed record or it would otherwise
 *  vanish with no trace once `pending` clears.
 *
 *  CHILD TRANSCRIPTS (child-transcript-view T2): a child event (`threadId !== MAIN`) used to be
 *  routed ONLY to `feedAgents`/`updateSubagents` (roster aggregates) and otherwise discarded. It
 *  now ALSO accumulates into `childBlocks[threadId]` — a capped, per-thread mirror of `committed`
 *  built from the SAME block shapes (user/assistant/tool/note/turn-summary/interrupted), via the
 *  shared `buildToolBlock`/`withChildBlock` helpers below so the main path's byte-for-byte output
 *  is untouched. `feedAgents`/`updateSubagents` keep running EXACTLY as before — `childBlocks` is
 *  purely additive, never a replacement for the roster aggregates.
 *
 *  THE BUG FIX (`Agent "" · 0s`, main.ts:637-649): main.ts's `updateSubagents` prunes the WHOLE
 *  subagent list to `[]` on the MAIN thread's own `turn_completed`
 *  (`subagent-state.ts`'s `case "turn_completed": if (threadId === "main") return items.length ? []
 *  : items`) — a `run_in_background` child that finishes AFTER the main turn already lost its
 *  label/stats by the time its `thread_completed` arrives (`item` is `undefined`, so main.ts falls
 *  back to the bare threadId/0). This reducer NEVER feeds a MAIN-thread `turn_completed` (or
 *  `agent_error`) into `updateSubagents` — those are the only two cases that prune — so `agents`
 *  here is never wiped wholesale; a finished child's row survives (marked `"done"`) until its OWN
 *  `thread_completed` commits its finish note, reading stats from that still-live row (which, by
 *  construction, can never be undefined here).
 *
 *  LIVE STALL HINT (task-5): three more child events now ALSO reach `feedAgents` —
 *  `tool_result`, `approval_requested`, `approval_resolved`. They contribute nothing to the roster's
 *  display aggregates; they exist so `updateSubagents` can keep the row's freshness stamp and its
 *  two "legitimate silence" counters honest, which is what `subagentStalled` (subagent-state.ts)
 *  needs to call a LIVE child stalled before the daemon's watchdog kills it. Routing them here was
 *  mandatory rather than cosmetic: `tool_call` was already fed, so an unfed `tool_result` left the
 *  in-flight counter permanently climbing and every child mid-tool would have been mislabelled.
 *  (`norma -p`'s main.ts feeds this reducer every event already, so it needed no equivalent change.)
 *
 *  PURE: `nowMs` is the caller's injected clock (App.tsx will tick it); `reduce` itself never calls
 *  `Date.now()`. ZERO Ink/React import — unit-testable in isolation (state.test.ts). */

import type { ApprovalOption, ApprovalPolicy, SessionActivity, Task } from "@norma/protocol";
import { updateSubagents, type CliSubagent } from "../subagent-state";
import { subagentTokens } from "../subagent-display";
import { upsertTask } from "../task-block";
import { formatElapsed, type TaskRow } from "../task-display";
import { spinnerFrame } from "./spinner-verbs";

export type Block =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool"; name: string; argsJson: string; output?: string; isError?: boolean }
  | { kind: "skill"; name: string } // reserved: no current wire event drives this (future skill-detection)
  | { kind: "note"; text: string } // dir-added / worktree / bg-task / agent-finish / approval-resolved one-liners
  | { kind: "turn-summary"; durationMs: number; inTokens: number; outTokens: number } // main turn_completed, stopReason !== "aborted"
  | { kind: "interrupted" }; // main turn_completed, stopReason === "aborted"

/** Phase 3d Task 2 — `"local_note"` is an App-INTERNAL synthetic event, never a real wire
 *  `SessionEvent` (protocol/events.ts has no such variant, and never will — see app.tsx's
 *  `AppEvent` union). It exists purely so the in-chat slash-command runners (commands.ts's
 *  `CommandCtx.appendNote`) have a way to commit a note block through the SAME reducer/dispatch
 *  path every other transcript line goes through, instead of a separate ad-hoc "local blocks" list
 *  that the transcript/flatten-cache would need to know about too. Pure additive case — reduce's
 *  handling of every real wire event type is completely unaffected.
 *
 *  `threadId` (child-transcript-view T3, additive/optional): when set to a non-MAIN thread, the
 *  note commits into THAT child's `childBlocks` entry instead of the main `committed` log — the
 *  App's child view uses this to surface `thread.send`'s queued/resumed feedback and RPC-error
 *  notes (unknown agent, resume-refused) right where the user is looking, never crashing the TUI.
 *  Omitted (main transcript) is the pre-existing behavior, byte-identical. */
export type LocalEvent = { type: "local_note"; text: string; threadId?: string };

/** `AgentRow` IS `CliSubagent`-shaped (the brief's interface matches it field-for-field) — reuse the
 *  type directly rather than re-declaring an equivalent interface that could drift out of lockstep.
 *  `name` (phase 5a Task 3, added here rather than on `CliSubagent` itself so subagent-state.ts
 *  stays untouched): the child's stable per-session handle, recorded from a background
 *  `spawn_agent` tool_call/tool_result pair (see the `tool_result` case below) — the re-task
 *  handle `send_message`/`resume` actually need, distinct from `.label`'s description-derived
 *  display text. Undefined until (or unless) that pairing resolves for this row's threadId. */
export type AgentRow = CliSubagent & { name?: string };

export type PendingCard =
  // reviewerReason (phase 5e T5): additive/optional, mirroring `approval_requested.reviewerReason`
  // on the wire (protocol/events.ts) — set only when this escalation came from the safety reviewer.
  // Omitted (never `reviewerReason: undefined`) when absent, so a non-reviewer card's shape is
  // exactly what it was before this field existed (byte-identical regression pin, state.test.ts).
  // options (SP-approvals T7): additive/optional, mirroring `approval_requested.options` — the
  // daemon's allow-rule choices (Task 5's `approvalOptionsFor`). Same omit-when-absent discipline:
  // a reviewer-escalation/grant/worktree card or an older daemon carries none, and the card renders
  // exactly as before this field existed (pending-cards.tsx's (d1a) byte-identical pin).
  | { kind: "approval"; callId: string; toolName: string; summary: string; reviewerReason?: string; options?: ApprovalOption[] }
  | { kind: "question"; callId: string; questions: unknown[] }
  | { kind: "plan"; callId: string; plan: string };

export interface TuiState {
  committed: Block[]; // → <Static> (Task 3)
  activeAssistant: string; // streaming text of the in-flight assistant message
  activeTools: { name: string; argsJson: string }[]; // tool_calls emitted this turn not yet resulted
  tasks: TaskRow[]; // raw upserted list; sort/collapse is the component's job (task-display.ts)
  agents: AgentRow[]; // CliSubagent-shaped; NEVER pruned wholesale on the main turn_completed
  turnRunning: boolean;
  turnStartMs?: number;
  inTokens: number;
  outTokens: number;
  pending: PendingCard | null;
  // child-transcript-view T2: per-child mirror of `committed`, keyed by threadId, capped at
  // CHILD_BLOCK_CAP (drop-oldest) — a live view, not an archive (T3's consumer surface: read
  // `childBlocks[threadId] ?? []` to render a selected agent's transcript).
  childBlocks: Record<string, Block[]>;
  // One in-flight child tool_call per threadId (mirrors `activeTools`, but per-thread since
  // multiple children may each have a call outstanding at once) — internal pairing state so the
  // matching tool_result can build a complete `{kind:"tool",...}` Block; not part of T3's primary
  // read surface, but exposed on TuiState since `reduce` is pure (no cross-call closures).
  childPendingTool: Record<string, { name: string; argsJson: string }>;
  // TUI renderer T5: LIVE background shell tasks — the `bg list` data folded off the events already
  // on the stream (`bg_task_started` appends, `bg_task_exited` removes; the committed one-line
  // notes for both are untouched). Feeds the status chrome's running-work line. Bounded by the
  // daemon's own bg-task lifecycle; a replay from seq 0 nets started/exited pairs back out.
  bgTasks: BgTaskRow[];
  // TUI renderer T5: the session's lifecycle state off the `session_activity` transient
  // (session-activity-hygiene T4 — advisory-and-current, never persisted/replayed). Absent until
  // the first event arrives; App may seed an initial value from the resume route's session.list
  // row instead. Drives the chrome's "backgrounded"/"archived" chip.
  activity?: SessionActivity;
}

/** One live background shell task (TUI renderer T5) — the two fields the running-work line needs. */
export interface BgTaskRow {
  taskId: string;
  command: string;
}

const MAIN = "main";

/** Live-view cap per child thread (child-transcript-view T2): beyond this many blocks, the OLDEST
 *  are dropped on append — the durable record is the transcript file (subagent-transcripts
 *  track), this is just a bounded live view. */
const CHILD_BLOCK_CAP = 200;

export function initialState(): TuiState {
  return {
    committed: [],
    activeAssistant: "",
    activeTools: [],
    tasks: [],
    agents: [],
    turnRunning: false,
    inTokens: 0,
    outTokens: 0,
    pending: null,
    childBlocks: {},
    childPendingTool: {},
    bgTasks: [],
    // `activity` deliberately ABSENT (not `undefined`-set): absence means "nothing known yet" —
    // the same spread-omit discipline PendingCard's optional fields use.
  };
}

/** Loosely-typed incoming wire event — mirrors `SessionEvent` (protocol/events.ts) but `reduce`
 *  reads fields defensively (same discipline as `subagent-state.ts`'s `WireEvent`) since a caller
 *  may feed it any object shaped like an event (tests, replay, a future transport variant). */
type WireEvent = { type: string; threadId?: string; [k: string]: unknown };

const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
const num = (v: unknown, fallback = 0): number => (typeof v === "number" ? v : fallback);

/** Human label for a peripheral capability class in the CU lease notes (Phase 5 CU). Unknown
 *  classes fall back to the raw class string. */
const CU_CLASS_LABELS: Record<string, string> = {
  screenshot: "screen capture",
  "ax-read": "accessibility",
  "input-drive": "mouse/keyboard",
  noop: "noop",
};
const cuClassLabel = (cls: string): string => CU_CLASS_LABELS[cls] ?? cls;

/** Best-effort single string field out of a JSON blob — malformed JSON, a non-object shape, or a
 *  missing/empty field all yield `undefined` rather than throwing (same try/catch-then-shape-check
 *  idiom as subagent-display.ts's `extractToolDetail` / history-store.ts's `loadHistory`). */
function parseStringField(json: string, key: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const v = (parsed as Record<string, unknown>)[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** Phase 5a Task 3 (NO protocol changes): a background `spawn_agent` tool_call's `argsJson` carries
 *  a `name` arg; its paired tool_result (the SAME main-thread call, per the `tool_result` case's own
 *  one-in-flight invariant below) is `{agentId,status:"running"}` JSON ONLY for a background spawn
 *  — a SYNC spawn's tool_result is the child's plain-text final report, so `parseStringField` fails
 *  to parse it and this yields `undefined` by construction, same as any other non-JSON text. Also
 *  `undefined` for a nameless spawn, or any tool_call that isn't `spawn_agent` at all. */
function bgSpawnNameMapping(call: { name: string; argsJson: string } | undefined, output: string): { agentId: string; name: string } | undefined {
  if (call?.name !== "spawn_agent") return undefined;
  const name = parseStringField(call.argsJson, "name");
  if (!name) return undefined;
  const agentId = parseStringField(output, "agentId");
  return agentId ? { agentId, name } : undefined;
}

/** Feeds ONE event into `updateSubagents` and returns the possibly-updated `agents` array — the
 *  single call site every child-thread branch below shares, so the "which events reach
 *  updateSubagents" decision lives in exactly one place. Deliberately NEVER called for a
 *  MAIN-thread `turn_completed` or for `agent_error` — subagent-state.ts prunes the whole list to
 *  `[]` for those two cases (see the file header), which is exactly the bug this reducer fixes. */
function feedAgents(s: TuiState, e: WireEvent): TuiState {
  const next = updateSubagents(s.agents, e);
  return next === s.agents ? s : { ...s, agents: next };
}

/** Shared tool-`Block` construction (child-transcript-view T2) — the SAME shape the main path's
 *  `tool_result` case has always built inline, now factored out so a child's own tool_call/
 *  tool_result pairing (below) produces byte-identical Block shapes without duplicating the
 *  field list. `call` is whichever pending call (main's `activeTools[0]` or a child's
 *  `childPendingTool[threadId]`) paired with this result; absent (a stray/ghost result) falls
 *  back to the same empty-string defaults the main path already tolerated. */
function buildToolBlock(call: { name: string; argsJson: string } | undefined, output: string, isError: boolean): Block {
  return { kind: "tool", name: call?.name ?? "", argsJson: call?.argsJson ?? "", output, isError };
}

/** Appends `block` to `map[threadId]`, dropping the OLDEST entries past `CHILD_BLOCK_CAP` — the
 *  one mutation site for every child-transcript append below. Always returns a fresh array/map
 *  (no reference-equality short-circuit needed here: every call site only invokes this when it
 *  already knows a block is being appended). */
function withChildBlock(map: Record<string, Block[]>, threadId: string, block: Block): Record<string, Block[]> {
  const merged = [...(map[threadId] ?? []), block];
  const capped = merged.length > CHILD_BLOCK_CAP ? merged.slice(merged.length - CHILD_BLOCK_CAP) : merged;
  return { ...map, [threadId]: capped };
}

/** Drops `ids` from a per-thread map (`childBlocks` or `childPendingTool`) — shared by the
 *  roster's existing done-agent prune (`turn_started`, MAIN) so a pruned agent's transcript/
 *  pending-tool bookkeeping doesn't linger forever (memory hygiene, child-transcript-view T2).
 *  Referential no-op when none of `ids` are present, matching this file's existing "same
 *  reference on no change" convention (e.g. `feedAgents`). */
function pruneChildEntries<T>(map: Record<string, T>, ids: string[]): Record<string, T> {
  if (!ids.some((id) => id in map)) return map;
  const next = { ...map };
  for (const id of ids) delete next[id];
  return next;
}

export function reduce(s: TuiState, e: WireEvent, nowMs: number): TuiState {
  switch (e.type) {
    case "user_message": {
      // Same Block shape for both destinations (child-transcript-view T2: a steer-drain/thread.send
      // echo lands here with a non-MAIN threadId — previously silently committed to the MAIN
      // transcript regardless of thread; now routed to that child's own block list instead).
      const block: Block = { kind: "user", text: str(e.text) };
      if (e.threadId !== MAIN) return { ...s, childBlocks: withChildBlock(s.childBlocks, str(e.threadId), block) };
      return { ...s, committed: [...s.committed, block] };
    }

    case "assistant_delta": {
      if (e.threadId !== MAIN) return feedAgents(s, e); // child deltas: track liveOutputChars only
      return { ...s, activeAssistant: s.activeAssistant + str(e.delta) };
    }

    case "assistant_message": {
      // Same Block shape for both destinations (child-transcript-view T2): children run to
      // completion inside the main tool loop, so this never needed a separate MAIN-committed
      // block (the finish note is what makes a child's work permanent there) — but it now feeds
      // that child's OWN block list instead of being discarded.
      const block: Block = { kind: "assistant", text: str(e.text) };
      if (e.threadId !== MAIN) return { ...s, childBlocks: withChildBlock(s.childBlocks, str(e.threadId), block) };
      return { ...s, committed: [...s.committed, block], activeAssistant: "" };
    }

    case "tool_call": {
      if (e.threadId !== MAIN) {
        // Child tool calls still bump toolCalls/activity via feedAgents (unchanged aggregate
        // path) AND now stash the pending call (name/argsJson) so the matching tool_result
        // (below) can build a complete Block — same one-in-flight-per-thread invariant as MAIN's
        // activeTools, just keyed per child threadId since multiple children run concurrently.
        const fed = feedAgents(s, e);
        const threadId = str(e.threadId);
        return { ...fed, childPendingTool: { ...fed.childPendingTool, [threadId]: { name: str(e.name), argsJson: str(e.argsJson) } } };
      }
      return { ...s, activeTools: [...s.activeTools, { name: str(e.name), argsJson: str(e.argsJson) }] };
    }

    case "tool_result": {
      if (e.threadId !== MAIN) {
        // Pair with the child's own pending call (stashed by tool_call above) and commit into
        // that child's block list — mirrors MAIN's pairing below via the shared buildToolBlock
        // helper, so both paths produce byte-identical tool Block shapes.
        //
        // task-5 (live stall hint): ALSO fed to the roster now. `tool_call` was already routed
        // (it bumps toolCalls/activity), so without its matching result the row's in-flight
        // counter could only ever climb — and a child mid-`bash` would be mislabelled "Stalled"
        // the moment the silence threshold elapsed, which is the one thing that hint must not do.
        const fed = feedAgents(s, e);
        const threadId = str(e.threadId);
        const call = fed.childPendingTool[threadId];
        const block = buildToolBlock(call, str(e.output), e.isError === true);
        const childPendingTool = { ...fed.childPendingTool };
        delete childPendingTool[threadId];
        return { ...fed, childPendingTool, childBlocks: withChildBlock(fed.childBlocks, threadId, block) };
      }
      // Main-thread tool_call/tool_result always alternate one at a time — the engine's dispatch
      // loop (packages/core/src/agent/engine.ts's `for (const call of calls)`) emits tool_call,
      // awaits execution, THEN emits that SAME call's tool_result before ever emitting the next
      // tool_call — so activeTools holds at most one entry for "main" and this call is always the
      // one it pairs with; no callId needs to ride the (call-id-less) activeTools/Block shapes.
      const call = s.activeTools[0];
      const output = str(e.output);
      const next: TuiState = {
        ...s,
        activeTools: s.activeTools.slice(1),
        committed: [...s.committed, buildToolBlock(call, output, e.isError === true)],
      };
      // phase 5a T3: learn a background child's `name` off this same call/result pairing (see
      // bgSpawnNameMapping above). engine.ts's spawn bridge always emits the child's own
      // thread_started BEFORE this tool_result (registerThread + the emit happen synchronously,
      // ahead of the spawnOutcomes entry this result reads), so the matching AgentRow already
      // exists here in the real wire order; no match (or no mapping at all) is a silent no-op —
      // never an assumption this reducer would throw on if that ordering were ever violated.
      const mapping = bgSpawnNameMapping(call, output);
      if (!mapping) return next;
      const idx = next.agents.findIndex((a) => a.threadId === mapping.agentId);
      if (idx === -1) return next;
      const agents = next.agents.slice();
      agents[idx] = { ...agents[idx]!, name: mapping.name };
      return { ...next, agents };
    }

    case "turn_started": {
      if (e.threadId !== MAIN) return feedAgents(s, e);
      // Drop finished subagents from the live roster at the next main turn. Their named finish notes are
      // already committed on thread_completed, so nothing is lost — this keeps the don't-prune-on-
      // turn_completed guard (the `Agent "" · 0s` fix) intact while bounding the pinned live region's
      // height, so a long agent-heavy session can't grow <AgentList> past the terminal and re-hide the
      // composer (whole-branch review, Important). Restores legacy's per-turn roster clear cadence.
      const doneIds = s.agents.filter((a) => a.status === "done").map((a) => a.threadId);
      const agents = doneIds.length ? s.agents.filter((a) => a.status !== "done") : s.agents;
      // Memory hygiene (child-transcript-view T2): a pruned agent's own transcript view is gone
      // (dismissed row falls back to main, per the design's failure modes), so its childBlocks/
      // childPendingTool entries would otherwise linger forever — drop them alongside the row.
      const childBlocks = pruneChildEntries(s.childBlocks, doneIds);
      const childPendingTool = pruneChildEntries(s.childPendingTool, doneIds);
      return { ...s, turnRunning: true, turnStartMs: nowMs, agents, childBlocks, childPendingTool };
    }

    case "turn_completed": {
      if (e.threadId !== MAIN) {
        // Child turn_completed (child-transcript-view T2): a multi-turn child gets the SAME kind
        // of per-turn marker MAIN does (turn-summary/interrupted, below) appended to its OWN block
        // list, so a busy child's live view shows turn boundaries too — not just its final finish
        // note (that's thread_completed's job, separately). durationMs is this turn's own span:
        // the delta in the row's banked `activeMs` across `feedAgents` (which closes the span
        // using the EVENT's own `ts`, never `nowMs`) rather than a separate per-child turnStartMs
        // field — reuses subagent-state.ts's existing closeSpan bookkeeping instead of duplicating
        // it. Absent row (ghost threadId, ordering violation) falls back to 0, same discipline as
        // MAIN's `turnStartMs === undefined` fallback below.
        const threadId = str(e.threadId);
        const before = s.agents.find((a) => a.threadId === threadId);
        const withDone = feedAgents(s, e);
        const after = withDone.agents.find((a) => a.threadId === threadId);
        const durationMs = before && after ? after.activeMs - before.activeMs : 0;
        const block: Block =
          e.stopReason === "aborted"
            ? { kind: "interrupted" }
            : { kind: "turn-summary", durationMs, inTokens: num(e.inputTokens), outTokens: num(e.outputTokens) };
        return { ...withDone, childBlocks: withChildBlock(withDone.childBlocks, threadId, block) };
      }
      // MAIN-thread only — and critically NEVER routed through updateSubagents (see file header):
      // that is the one-line fix for the `Agent "" · 0s` bug.
      const inTokens = num(e.inputTokens);
      const outTokens = num(e.outputTokens);
      // Commits exactly ONE transcript-visible marker for the just-finished main turn: an
      // "interrupted" block when the user cancelled it (stopReason "aborted"), otherwise a
      // "turn-summary" block carrying the real elapsed span (nowMs - turnStartMs; 0 if a
      // turn_completed somehow arrives with no matching turn_started) + the token counts. Phase
      // 3b Task 3 — rendering (verb/glyph/wording) lives in transcript.tsx, not here.
      const block: Block =
        e.stopReason === "aborted"
          ? { kind: "interrupted" }
          : { kind: "turn-summary", durationMs: s.turnStartMs !== undefined ? nowMs - s.turnStartMs : 0, inTokens, outTokens };
      return { ...s, turnRunning: false, inTokens, outTokens, committed: [...s.committed, block] };
    }

    case "thread_started":
      return feedAgents(s, e);

    case "thread_completed": {
      // Feed updateSubagents FIRST so `row` below reads the fully-closed span (banked activeMs) —
      // matches main.ts:646's `subagents.find(...)` which also reads AFTER that event's own
      // reassignment. Never pruned to [] regardless of arrival order relative to the main turn's
      // own turn_completed (that guard lives in the `turn_completed` case above), so `row` is never
      // undefined here — this reducer's whole point.
      //
      // Wording (phase 3b Task 6, matching CC's AgentTool/UI.tsx completion summary per
      // cc-ui-study-transcript.md §4): ONE line, `Agent "{label}": Done ({toolCalls} tool use(s)[ ·
      // {tokens} tokens] · {elapsed})` — no second `⎿` line (the old two-line "finished ·
      // elapsed\n⎿ Ran N tool calls" wording folds the tool count into the parens instead).
      // `subagentTokens` (subagent-display.ts, READ-only) already renders its own "↑X ↓Y" arrows,
      // so its output is embedded verbatim as the tokens segment with " tokens" appended — same
      // "arrows + literal word tokens" convention transcript.tsx's turn-summary block already uses.
      // It returns "" when NOTHING is known yet (no child turn_completed ever landed before this
      // thread_completed — the exact case both 3a bug-fix fixtures below hit), in which case the
      // whole tokens segment is omitted rather than leaving a dangling "· ·".
      const withDone = feedAgents(s, e);
      const row = withDone.agents.find((a) => a.threadId === e.threadId);
      const label = row?.label ?? str(e.threadId);
      const toolCalls = row?.toolCalls ?? 0;
      const tokens = subagentTokens(row?.inputTokens, row?.outputTokens ?? 0, row?.liveOutputChars ?? 0);
      const parts = [`${toolCalls} tool use${toolCalls === 1 ? "" : "s"}`];
      if (tokens) parts.push(`${tokens} tokens`);
      parts.push(formatElapsed(row?.activeMs ?? 0));
      // Roster honesty (no-timeout task, extended by task-16): the verb comes from the row's
      // `finish` (the wire's own thread_completed.stopReason via subagent-state.ts) — a genuinely
      // failed child commits "Failed", a user-stopped one "Stopped", a stall-killed one "Stalled"
      // (task-16: its own distinct verb — resumable, partial output, never a flat "Failed"),
      // never a dishonest "Done". Absent finish (a ghost-threadId row never tracked) falls back to
      // "Done", the pre-change wording.
      const verb = row?.finish === "failed" ? "Failed"
        : row?.finish === "stopped" ? "Stopped"
        : row?.finish === "stalled" ? "Stalled"
        : "Done";
      const text = `Agent "${label}": ${verb} (${parts.join(" · ")})`;
      // Same note block, TWO destinations (child-transcript-view T2): the roster-wide MAIN
      // transcript (unchanged) AND this child's own block list, so its live view shows
      // "done/stalled/failed" inline without the user needing to glance at the main transcript.
      const block: Block = { kind: "note", text };
      return {
        ...withDone,
        committed: [...withDone.committed, block],
        childBlocks: withChildBlock(withDone.childBlocks, str(e.threadId), block),
      };
    }

    case "task_updated":
      return { ...s, tasks: upsertTask(s.tasks as Task[], e.task as Task) };

    case "approval_requested": {
      // phase 5e T5: thread reviewerReason through if present (spread-omitted, not `undefined`-set,
      // when absent — see the PendingCard doc comment above).
      const reviewerReason = typeof e.reviewerReason === "string" ? e.reviewerReason : undefined;
      // SP-approvals T7: same cast-and-omit discipline as the "question" case's `questions` field
      // below (no per-item validation here either — pending-cards.tsx's ApprovalCard is the render-
      // time consumer, same division of labor as QuestionCard/`LegacyQuestion`).
      const options = Array.isArray(e.options) ? (e.options as ApprovalOption[]) : undefined;
      // task-5 (live stall hint): a CHILD's approval parks that child on a human, which is
      // legitimate silence — the roster must know, or it would call the row "Stalled" while the
      // card it is blocked on sits right there on screen. A MAIN-thread approval (the common case)
      // is a no-op inside updateSubagents, and the `pending` card below is untouched either way.
      const fed = feedAgents(s, e);
      return {
        ...fed,
        pending: {
          kind: "approval",
          callId: str(e.callId),
          toolName: str(e.toolName),
          summary: str(e.summary),
          ...(reviewerReason !== undefined ? { reviewerReason } : {}),
          ...(options !== undefined ? { options } : {}),
        },
      };
    }

    case "approval_resolved": {
      const pending = s.pending;
      const toolName = pending?.kind === "approval" && pending.callId === e.callId ? pending.toolName : str(e.callId);
      const text = `${e.approved ? "approved" : "denied"} ${toolName}`;
      // task-5: the release half of approval_requested's roster feed above — the child is off the
      // human's hook and its silence is measurable again from here.
      const fed = feedAgents(s, e);
      return { ...fed, pending: null, committed: [...fed.committed, { kind: "note", text }] };
    }

    case "question_asked":
      return { ...s, pending: { kind: "question", callId: str(e.callId), questions: (e.questions as unknown[]) ?? [] } };

    case "question_resolved": {
      // Symmetric to approval_resolved/plan_resolved: the resolution event — also fired when another
      // attached client answers or the QuestionBroker times out — clears the pending card and leaves a
      // transcript trace of the answers. main.ts renders no dedicated question_resolved line (its
      // cooked-stdin echo of the typed answers served that role); in the Ink model the card lived in
      // the live region, so a committed note is the only surviving trace. Empty answers (timeout /
      // resolved elsewhere with no payload) → clear pending, commit nothing.
      const answers = (e.answers ?? {}) as Record<string, string>;
      const notes = Object.entries(answers).map(([q, a]) => ({ kind: "note" as const, text: `${q}: ${a}` }));
      return { ...s, pending: null, committed: [...s.committed, ...notes] };
    }

    case "plan_presented":
      return { ...s, pending: { kind: "plan", callId: str(e.callId), plan: str(e.plan) } };

    case "plan_resolved": {
      // Same wording as main.ts:618 (minus ANSI): "plan approved[ (auto-accept edits)]" / "plan rejected".
      const text = e.approved ? `plan approved${e.autoAccept ? " (auto-accept edits)" : ""}` : "plan rejected";
      return { ...s, pending: null, committed: [...s.committed, { kind: "note", text }] };
    }

    case "directory_added": {
      const text = `+ dir ${str(e.path)}${e.persisted ? " (remembered)" : ""}`;
      return { ...s, committed: [...s.committed, { kind: "note", text }] };
    }

    case "bg_task_started": {
      const text = `▶ bg ${str(e.taskId)} started: ${str(e.command).slice(0, 80)}`;
      // T5: ALSO fold the liveness row (dedupe on taskId — an attach replay can re-deliver the
      // event). The committed note above is byte-identical to before.
      const taskId = str(e.taskId);
      const bgTasks = s.bgTasks.some((t) => t.taskId === taskId)
        ? s.bgTasks
        : [...s.bgTasks, { taskId, command: str(e.command) }];
      return { ...s, bgTasks, committed: [...s.committed, { kind: "note", text }] };
    }

    case "bg_task_output":
      return { ...s, committed: [...s.committed, { kind: "note", text: str(e.chunk) }] };

    case "bg_task_exited": {
      // Matches main.ts:556's `"exit " + e.exitCode` byte-for-byte, INCLUDING a null exitCode
      // (killed:false, no exit code available) stringifying to "exit null" — no `num()` fallback
      // here, since that would silently turn a real "exit null" into a misleading "exit 0".
      const text = `■ bg ${str(e.taskId)} exited (${e.killed ? "killed" : `exit ${e.exitCode}`})`;
      // T5: drop the liveness row; the list keeps its reference when the id was never tracked
      // (this file's "same reference on no change" convention, e.g. feedAgents).
      const taskId = str(e.taskId);
      const bgTasks = s.bgTasks.some((t) => t.taskId === taskId)
        ? s.bgTasks.filter((t) => t.taskId !== taskId)
        : s.bgTasks;
      return { ...s, bgTasks, committed: [...s.committed, { kind: "note", text }] };
    }

    // TUI renderer T5: the session-lifecycle transient (session-activity-hygiene T4) — advisory-
    // and-current, so it folds into ONE field and commits nothing. Referential no-op on a
    // re-broadcast of the same state so idle chrome never repaints for it.
    case "session_activity": {
      const activity = str(e.activity) as SessionActivity;
      if (!activity || activity === s.activity) return s;
      return { ...s, activity };
    }

    case "worktree_entered": {
      const text = `⛿ entered worktree ${str(e.name)} (branch ${str(e.branch)})`;
      return { ...s, committed: [...s.committed, { kind: "note", text }] };
    }

    case "worktree_exited": {
      const text = `⟲ left worktree ${str(e.name)}${e.removed ? " (removed)" : ""}`;
      return { ...s, committed: [...s.committed, { kind: "note", text }] };
    }

    // Computer use (Phase 5 CU): the peripheral lease acquire/release events (transient, broadcast
    // on the requester's session). Rendered as one-line notes so CU control is visible in the
    // transcript. CLI-only — no Swift-lockstep twin; the -p path (main.ts) has no lease branch, so
    // headless output is unchanged.
    case "lease_granted": {
      const text = `⌘ Norma acquired ${cuClassLabel(str(e.class))} control`;
      return { ...s, committed: [...s.committed, { kind: "note", text }] };
    }

    case "lease_lost": {
      const text = `⌘ Norma released ${cuClassLabel(str(e.class))} control (${str(e.reason)})`;
      return { ...s, committed: [...s.committed, { kind: "note", text }] };
    }

    // task-30 (push-notification track): a minimal one-liner — the app's own delivery (native
    // UNUserNotificationCenter alert, SessionModel.apply in the Norma target) is where the real
    // "notification" happens; the CLI just needs a visible trace in the transcript, same class as
    // the CU lease notes above.
    case "notification_requested": {
      const text = `notification: ${str(e.title)}: ${str(e.message)}`;
      return { ...s, committed: [...s.committed, { kind: "note", text }] };
    }

    case "agent_error": {
      // main.ts:659 sends this to console.error (stderr), not the pinned block — but the Ink app
      // has no separate stderr surface, so its content becomes a committed note here (same wording).
      const text = `agent error: ${str(e.message)}`;
      return { ...s, committed: [...s.committed, { kind: "note", text }] };
    }

    case "local_note": {
      // See the `LocalEvent` doc comment above — App-internal only, never a real wire event.
      const block: Block = { kind: "note", text: str(e.text) };
      const threadId = typeof e.threadId === "string" ? e.threadId : undefined;
      if (threadId !== undefined && threadId !== MAIN) return { ...s, childBlocks: withChildBlock(s.childBlocks, threadId, block) };
      return { ...s, committed: [...s.committed, block] };
    }

    default:
      return s; // unknown/unhandled event types are no-ops (both CLI/app already skip unknowns)
  }
}

// ================================================================================================
// TUI renderer T5 — the bottom status chrome's PURE model (spec §3; mechanism report Q4 adapted).
//
// `statusChromeModel` is the ONE place the chrome's content is decided; footer.tsx renders its
// output verbatim (one `<Text wrap="truncate">` row per StatusLine — each line is exactly one
// terminal row by construction, so app.tsx's `bottomBarLayout` counts `lines.length` and the
// height model never lies). THE PIN: one line; two when running work exists; never more —
// `lines.length <= 2` is structural (a work line + a status line are the only two products), and
// many work items collapse into the truncated `"N running: a, b, +K"` summary instead of more rows.
//
// T6 (r-m11): the work line and the roster pill each STATE THEIR OWN SCOPE — the work line counts
// RUNNING work only (live agents + bg shells: `"N running: …"`), the pill counts roster ROWS
// (`"N agents · ctrl+a"`, done-awaiting-prune included, because it captions what ctrl+a opens).
// The two can legitimately diverge (a done agent leaves the work count but not the roster yet);
// self-labeling makes the divergence read as two truths, not one contradiction. "running" also
// un-collides the label from the ctrl+t task LIST (todo subjects), which "N tasks" clashed with.
//
// FLICKER DISCIPLINE (T4 frame-diff): the status line reads NO clock — idle chrome is byte-stable
// across ticks, so the damage-diffed writer emits zero ops for it. Only the work line's spinner
// glyph advances (a 120ms bucket of `nowMs`), repainting exactly one row while work runs.
// ================================================================================================

/** Tones the footer maps onto theme colors ("dim" inherits the footer's dim base). */
export type StatusTone = "dim" | "planMode" | "warning" | "autoAccept" | "dangerMode" | "accent";

export interface StatusSegment {
  text: string;
  tone: StatusTone;
}

/** One rendered chrome row: segments joined by `sep` (the status line keeps the footer's
 *  established `" · "`; the work line joins glyph+body with a plain space). */
export interface StatusLine {
  key: "work" | "status" | "exit";
  sep: string;
  segments: StatusSegment[];
}

/** Everything the chrome reads — all EXISTING wire/session state (zero daemon changes): the
 *  roster + bgTasks liveness folds above, the App-held policy/model/effort (live through
 *  `/model`'s CommandCtx callback), the `session_activity` fold, and the exit-armed flag. */
export interface StatusChromeInput {
  policy: ApprovalPolicy;
  running: boolean;
  /** The roster as the App renders it (visibleAgents — dismissed rows excluded). */
  agents: AgentRow[];
  bgTasks: BgTaskRow[];
  /** The session's LIVE model slug (`""` = unknown → segment omitted, the pre-T5 footer shape). */
  model: string;
  effort?: string;
  activity?: SessionActivity;
  /** Which key armed the double-press exit window (footer.tsx's `ExitKey`, structurally). */
  exitArmed?: "ctrl-c" | "ctrl-d";
  /** Injected clock — read ONLY by the work line's spinner glyph; the status line never sees it. */
  nowMs: number;
}

/** Label budget for one work item on the running-work line. */
const WORK_LABEL_MAX = 20;
/** Labels spelled out before the `+K` overflow summary (the `"3 running: a, b, +1"` shape). */
const WORK_LABELS_SHOWN = 2;

const shortLabel = (s: string): string => (s.length > WORK_LABEL_MAX ? `${s.slice(0, WORK_LABEL_MAX - 1)}…` : s);

/** The running-work labels, in roster-then-bg order: live (non-terminal) subagents by their
 *  re-task `name` (falling back to the display label), then live bg shell tasks by command.
 *  Exported so app.tsx's layout accounting and this selector can never disagree about whether
 *  the second chrome line exists. */
export function runningWorkLabels(agents: AgentRow[], bgTasks: BgTaskRow[]): string[] {
  return [
    ...agents.filter((a) => a.status !== "done").map((a) => shortLabel(a.name ?? a.label)),
    ...bgTasks.map((t) => shortLabel(t.command)),
  ];
}

export function statusChromeModel(input: StatusChromeInput): { lines: StatusLine[] } {
  const { policy, running, agents, bgTasks, model, effort, activity, exitArmed, nowMs } = input;

  // Exit-armed replaces the WHOLE chrome with the one key-specific hint (the pre-T5 footer's
  // contract, kept: nothing else renders alongside, so the line reads unambiguously).
  if (exitArmed) {
    const text = exitArmed === "ctrl-d" ? "Press Ctrl-D again to exit" : "Press Ctrl-C again to exit";
    return { lines: [{ key: "exit", sep: " · ", segments: [{ text, tone: "dim" }] }] };
  }

  const lines: StatusLine[] = [];

  // --- the work line (only while running work exists — the second line, capped at ONE row) ------
  const labels = runningWorkLabels(agents, bgTasks);
  if (labels.length > 0) {
    const shown = labels.slice(0, WORK_LABELS_SHOWN);
    const extra = labels.length - shown.length;
    // T6 (r-m11): "running" — the line's self-labeled scope (see the module doc above); the count
    // is invariant-worded, so no singular/plural fork.
    const body = `${labels.length} running: ${shown.join(", ")}${extra > 0 ? `, +${extra}` : ""}`;
    lines.push({
      key: "work",
      sep: " ",
      segments: [
        { text: spinnerFrame(nowMs), tone: "accent" },
        { text: body, tone: "dim" },
      ],
    });
  }

  // --- the status line (always; wording byte-compatible with the pre-T5 footer) ----------------
  const segments: StatusSegment[] = [];
  if (policy === "plan") segments.push({ text: "⏸ plan mode on (shift+tab to cycle)", tone: "planMode" });
  else if (policy === "dont-ask") segments.push({ text: "✕ dont-ask — auto-declines prompts (shift+tab to cycle)", tone: "warning" });
  else if (policy === "accept-edits") segments.push({ text: "✎ accept edits (shift+tab to cycle)", tone: "autoAccept" });
  else if (policy === "auto") segments.push({ text: "⏵⏵ auto mode on (shift+tab to cycle)", tone: "autoAccept" });
  else if (policy === "bypass") segments.push({ text: "⚠ bypass — all actions auto-approved (shift+tab to cycle)", tone: "dangerMode" });

  if (running) segments.push({ text: "esc to interrupt", tone: "dim" });

  if (agents.length > 0) {
    segments.push({ text: `${agents.length} agent${agents.length === 1 ? "" : "s"} · ctrl+a`, tone: "dim" });
  }

  // The empty-state hint keeps its pre-T5 role: it fills in when NO keybinding-bearing segment
  // rendered — the passive info segments below (chip, model) don't suppress it.
  if (segments.length === 0) {
    segments.push({ text: "? for shortcuts · shift+tab to cycle modes", tone: "dim" });
  }

  // The activity chip, when notable (spec §3): the session runs unattended (backgrounded) or is
  // archived. `active`/`idle`/absent are the unremarkable states — no chip.
  if (activity === "background") segments.push({ text: "● backgrounded", tone: "warning" });
  else if (activity === "archived") segments.push({ text: "● archived", tone: "warning" });

  // The session's live model + effort — last, the CC status-line position adapted (model reads as
  // the line's right edge). Unknown model (`""`) omits the segment: never show a guess.
  if (model) segments.push({ text: effort ? `${model} (${effort})` : model, tone: "dim" });

  lines.push({ key: "status", sep: " · ", segments });
  return { lines };
}
