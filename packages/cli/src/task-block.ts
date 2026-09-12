import type { Task } from "@yanlinglabs/winter-protocol";
import { collapseCompleted, formatElapsed, formatTokens, sortTasksForDisplay, taskCountsLine, taskGlyph } from "./task-display";
import type { CliSubagent } from "./subagent-state";
import { anySubagentAlive, subagentElapsedMs, subagentTokens } from "./subagent-display";

/** Glyphs for each task status — used ONLY by the non-TTY one-line-per-update render now (Task 4:
 *  the TTY pinned block switched to task-display's shared `taskGlyph`/sort/collapse so it stays in
 *  lockstep with the Swift window twin). Keyed loosely (Record<string, string>, not
 *  Record<Task["status"], string>) to match how call sites index it with an event payload's
 *  `.status` field (typed `any` at the wire boundary) without fighting TS7053.
 *
 *  `deleted` (T3 review fix wave 1): a task_updated carrying `status: "deleted"` now reaches this
 *  non-TTY line too (upsertTask below removes it from the TTY block instead, but the non-TTY path
 *  is a flat append-only event log, not a live list — it still prints ONE line per event). Without
 *  this entry the line would render the literal string "undefined" for the glyph. */
export const TASK_ICONS: Record<string, string> = { pending: "☐", in_progress: "◐", completed: "☑", deleted: "✗" };

/** Non-TTY (piped/`-p`) one-line-per-update literals (2e-iii-b Task 6). Headless consumers parse
 *  these, so they are byte-frozen: `nontty-bytes.test.ts` pins each output exactly, and main.ts's
 *  non-TTY branches call these SAME functions — any drift in either place breaks the test. Kept
 *  here beside DIM/RESET/TASK_ICONS (their only inputs) so the format and its colors live together.
 *  The TTY renders are the separate, freely-evolving `renderTaskBlock`/`agentSpawnLine`/
 *  `agentFinishLines` above; these three are the frozen non-TTY twins. */
export function NONTTY_TASK_LINE(status: string, subject: string): string {
  return `${DIM}${TASK_ICONS[status]} ${subject}${RESET}\n`;
}
export function NONTTY_SPAWN_LINE(agentType: string): string {
  return `${DIM}⌥ spawned ${agentType} subagent${RESET}\n`;
}
export function NONTTY_FINISH_LINE(stopReason: string): string {
  return `${DIM}✓ subagent done${stopReason !== "end_turn" ? ` (${stopReason})` : ""}${RESET}\n`;
}

// ANSI — Winter blue for the live/in-progress state (status line + in_progress glyph), green for
// completed, dim for pending/idle text, bold for the single active row's subject. Co-located here
// (rather than main.ts's own AQUA/DIM/RESET) since task-block.ts is the pure-rendering module both
// the TTY block and the status line live in; main.ts imports DIM/RESET from here instead of
// duplicating them.
export const DIM = "\x1b[2m";
export const BOLD = "\x1b[1m";
export const RESET = "\x1b[0m";
export const BLUE = "\x1b[38;2;115;191;255m";
export const GREEN = "\x1b[38;2;120;200;90m";

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Pure upsert into the session's current task list. The daemon's task tools (task_create/
 *  task_update) emit one task_updated per task, each carrying that task's full current state —
 *  there is no batch/full-list "reset" event (unlike e.g. Claude Code's TodoWrite) — so tracking
 *  the list is just: replace-by-id, or append if this id hasn't been seen yet. Insertion order is
 *  preserved (first-created task stays first) so the block doesn't reshuffle as tasks update.
 *
 *  `status: "deleted"` (T3 review fix wave 1) is the one exception to "upsert": task_update's
 *  deleted branch (packages/core/src/agent/tools/tasks.ts) now emits a task_updated carrying this
 *  status right before the daemon's TaskStore actually removes the task, so the pinned block must
 *  REMOVE the entry instead of upserting a phantom row that would otherwise live forever (the
 *  daemon never sends a follow-up event once a task is gone). `renderTaskBlock`'s count header
 *  (`taskCountsLine`) is computed over whatever this function returns, so removing here is
 *  sufficient for the header to recount correctly too — no separate accounting needed. */
export function upsertTask(tasks: Task[], task: Task): Task[] {
  if (task.status === "deleted") return tasks.filter((t) => t.id !== task.id);
  const idx = tasks.findIndex((t) => t.id === task.id);
  if (idx === -1) return [...tasks, task];
  const next = tasks.slice();
  next[idx] = task;
  return next;
}

/** Width-aware truncation shared by every plain (un-colored) row this module renders — task rows
 *  AND the "… +N completed" summary row. Truncates to `columns - 2` so one logical line is always
 *  ONE physical terminal row: the erase dance (`\x1b[<n>A\x1b[0J`) counts logical lines, and a
 *  model-written subject longer than the terminal would otherwise WRAP, making the cursor-up count
 *  too small and stranding orphaned fragments mid-screen (FINAL-REVIEW FIX, 2d-ii-a). Operates on
 *  plain text — callers truncate BEFORE wrapping in ANSI color, so the visible-width budget is
 *  exact and no escape sequence is ever cut mid-code. `columns` undefined/tiny → no truncation. */
function truncatePlain(line: string, columns?: number): string {
  if (!columns || columns <= 2) return line;
  return line.length > columns - 2 ? `${line.slice(0, columns - 3)}…` : line;
}

function glyphColor(status: string): string {
  if (status === "in_progress") return BLUE;
  if (status === "completed") return GREEN;
  return DIM;
}

/** Pure block content: the Claude-Code-style task tree — in_progress first, then pending, with
 *  completed rows collapsed to the 3 most recent plus a "… +N completed" summary (shared
 *  sort/collapse rules from task-display.ts, kept in lockstep with the Swift window twin). Each
 *  row's glyph is colored by status (blue/in_progress, green/completed, dim/pending); the single
 *  in_progress row's subject is bold. Empty when there are no tasks, or when every task is
 *  completed — CC parity: the pinned block disappears once there's nothing left to do.
 *
 *  Truncation (see `truncatePlain`) happens on the plain glyph+subject text BEFORE the ANSI color
 *  is spliced back in, so a long subject never desyncs the erase math or corrupts an escape code.
 *
 *  Task 3 (2e-iii-b): whenever the block renders anything, a DIM count-header row —
 *  `taskCountsLine(tasks)` computed over the FULL (pre-sort/collapse) task list — is prepended
 *  (CC parity: "7 tasks (5 done, 1 in progress, 1 open)"). Run through the same `truncatePlain`
 *  discipline as every other row here, for the same one-logical-line-one-physical-row reason. */
export function renderTaskBlock(tasks: Task[], columns?: number): string[] {
  if (tasks.length === 0 || tasks.every((t) => t.status === "completed")) return [];
  const { rows, collapsedCompletedCount } = collapseCompleted(sortTasksForDisplay(tasks));
  const lines = rows.map((t) => {
    const plain = truncatePlain(`${taskGlyph(t.status)} ${t.subject}`, columns);
    const glyph = plain.slice(0, 1);
    const rest = plain.slice(1); // leading space + (possibly truncated+ellipsized) subject
    const body = t.status === "in_progress" ? `${BOLD}${rest}${RESET}` : rest;
    return `${glyphColor(t.status)}${glyph}${RESET}${body}`;
  });
  if (collapsedCompletedCount > 0) {
    lines.push(`${DIM}${truncatePlain(`… +${collapsedCompletedCount} completed`, columns)}${RESET}`);
  }
  return [`${DIM}${truncatePlain(taskCountsLine(tasks), columns)}${RESET}`, ...lines];
}

/** Pure CC-style transcript line for a spawned subagent (Task 5, 2e-iii-b) — printed once when a
 *  `thread_started` event lands on a TTY (main.ts's non-TTY branch keeps the plain
 *  `⌥ spawned <agentType> subagent` line unchanged). `label` is the CliSubagent's already-computed
 *  `subagentLabel` (description, or the prompt's truncated first line) — this function just lays
 *  out the given strings, it does no label derivation itself. */
export function agentSpawnLine(label: string, agentType: string): string {
  return `${BLUE}●${RESET} Agent(${label}) ${DIM}${agentType}${RESET}`;
}

/** Pure CC-style transcript lines for a finished subagent (Task 5, 2e-iii-b) — printed once when a
 *  `thread_completed` event lands on a TTY (main.ts's non-TTY branch keeps the plain
 *  `✓ subagent done` line unchanged). The second (tool-call count) line is omitted when the
 *  subagent never called a tool (`toolCalls === 0`) — nothing to report. */
export function agentFinishLines(label: string, activeMs: number, toolCalls: number): string[] {
  const lines = [`${GREEN}●${RESET} ${DIM}Agent "${label}" finished · ${formatElapsed(activeMs)}${RESET}`];
  if (toolCalls > 0) lines.push(`${DIM}⎿ Ran ${toolCalls} tool calls${RESET}`);
  return lines;
}

/** Pure CC-style turn-summary transcript line (Task 5, 2e-iii-b) — printed once when the MAIN
 *  thread's `turn_completed` lands on a TTY, just above the turn's final block teardown (main.ts's
 *  non-TTY branch prints nothing extra here — unchanged). `activeForm` is the caller's job
 *  (main.ts): the LAST in_progress task's activeForm, else "Worked" (past tense — the turn has
 *  already ended, unlike `renderStatusLine`'s in-flight "Working" fallback). */
export function turnSummaryLine(activeForm: string, elapsedMs: number, inTokens: number, outTokens: number): string {
  return `${DIM}✳ ${activeForm} for ${formatElapsed(elapsedMs)} · ↑ ${formatTokens(inTokens)} ↓ ${formatTokens(outTokens)} tokens${RESET}`;
}

/** `FooterSelection`: which thread's transcript is currently selected (default `"main"`), and —
 *  while the footer has keyboard focus (§4 of the design doc) — which row index the highlight
 *  cursor sits on (row 0 = main, then each live subagent in `items` order). `focusIndex: null`
 *  means the footer has no keyboard focus right now (only the `●`/`○` selection dot is drawn;
 *  nothing renders BOLD). */
export interface FooterSelection {
  selectedThreadId: string;
  focusIndex: number | null;
}

function footerDot(selected: boolean): string {
  return selected ? `${BLUE}●${RESET}` : `${DIM}○${RESET}`;
}

/** Middle-ellipsis truncation: keeps a head AND a tail slice of `s` (unlike `truncatePlain`'s
 *  tail-ellipsis, which keeps only the head) so a narrow footer row still shows both the start
 *  (glyph/agentType) and end (whatever was closest to the now-dropped right-aligned time/tokens)
 *  of its left part. Returns exactly `maxLen` visible chars (or `s` unchanged if it already fits). */
function middleTruncatePlain(s: string, maxLen: number): string {
  if (maxLen <= 0) return "";
  if (s.length <= maxLen) return s;
  if (maxLen === 1) return "…";
  const keep = maxLen - 1; // reserve 1 for the ellipsis
  const head = Math.ceil(keep / 2);
  const tail = keep - head;
  return tail > 0 ? `${s.slice(0, head)}…${s.slice(s.length - tail)}` : `${s.slice(0, head)}…`;
}

/** Builds one footer row: `<dot><reset><leftRest>[<pad><right>]`. `leftRest` is the plain text
 *  AFTER the selection dot (e.g. " main", or " general-purpose  Reading main.ts" — note the glyph
 *  itself is never part of `leftRest`, so it's never eaten by truncation); `rightPlain` is the
 *  plain right-aligned "<elapsed> · ↓ <tokens>" text, or "" for rows with nothing to right-align
 *  (the main row; a queued subagent row). `focused` bolds the WHOLE body (everything after the
 *  dot) — the keyboard-highlight cursor, distinct from the `●`/`○` selection dot.
 *
 *  Width discipline (spec §4): budget is `columns - 2` (same safety margin as `truncatePlain`),
 *  minus 1 more for the dot itself. If `leftRest` + a 1-space minimum pad + `rightPlain` doesn't
 *  fit, the right part is DROPPED FIRST; only if `leftRest` alone still doesn't fit is it
 *  middle-truncated. Never wraps — always exactly one physical row. `columns` undefined/tiny (the
 *  same threshold `truncatePlain` uses) skips truncation but still leaves a single-space pad
 *  between the two parts so the row stays readable when unbounded. */
function footerRow(selected: boolean, focused: boolean, leftRest: string, rightPlain: string, columns?: number): string {
  const budget = columns && columns > 2 ? columns - 3 : undefined; // -2 margin, -1 for the dot
  let left = leftRest;
  let right = rightPlain;
  if (budget !== undefined) {
    if (right && left.length + 1 + right.length > budget) right = ""; // drop right first
    if (left.length > budget) left = middleTruncatePlain(left, budget); // then middle-truncate left
  }
  const pad = right ? (budget !== undefined ? " ".repeat(Math.max(1, budget - left.length - right.length)) : " ") : "";
  const rest = `${left}${pad}${right}`;
  const body = focused ? `${BOLD}${rest}${RESET}` : rest;
  return `${footerDot(selected)}${body}`;
}

/** Queued rows show literal "waiting" in the activity slot (no tool has run yet); working/done
 *  rows show the latest `extractToolDetail` hit, falling back to "working…" until the first one
 *  lands (2e-iii-b design doc §3's fallback rule). */
function subagentActivity(s: CliSubagent): string {
  if (s.status === "queued") return "waiting";
  return s.activity ?? "working…";
}

/** The footer's right-aligned "<elapsed> · ↓ <tokens>" (or just "<elapsed>" while nothing token-
 *  wise is known yet — `subagentTokens` returns "" until the first `assistant_delta`/
 *  `turn_completed`). Queued rows render no time/tokens at all — a queued subagent hasn't started
 *  its clock. `subagentElapsedMs`/`subagentTokens` are Task 2's lockstep-adjacent pure helpers. */
function subagentRight(s: CliSubagent, nowMs: number): string {
  if (s.status === "queued") return "";
  const elapsed = formatElapsed(subagentElapsedMs(s, nowMs));
  const tokens = subagentTokens(s.inputTokens, s.outputTokens, s.liveOutputChars);
  return tokens ? `${elapsed} · ${tokens}` : elapsed;
}

/** Pure block content: the agents footer (2e-iii-b) — a THREAD SELECTOR, not a status list (that
 *  was `renderSubagentBlock`, DELETED — this supersedes it). Row 0 is always `main`; then each
 *  live subagent in `items`' first-seen order. Empty (no footer at all) unless a turn is actually
 *  running OR at least one subagent is still alive — matches the design doc's visibility rule
 *  exactly (`turnRunning || anySubagentAlive`), so the footer never lingers after everything's
 *  idle. */
export function renderAgentsFooter(
  items: CliSubagent[],
  selection: FooterSelection,
  turnRunning: boolean,
  nowMs: number,
  columns?: number,
): string[] {
  if (!turnRunning && !anySubagentAlive(items.map((s) => s.status))) return [];
  const rows = [footerRow(selection.selectedThreadId === "main", selection.focusIndex === 0, " main", "", columns)];
  const liveItems = items.filter((s) => s.status !== "done");
  liveItems.forEach((s, i) => {
    rows.push(footerRow(
      selection.selectedThreadId === s.threadId,
      selection.focusIndex === i + 1,
      ` ${s.agentType}  ${subagentActivity(s)}`,
      subagentRight(s, nowMs),
      columns,
    ));
  });
  return rows;
}

/** Pure "are we at a fresh line start" tracker. TTY-mode block erase/reprint must never happen
 *  mid partial-line (a streamed assistant delta or a bg-task-output chunk can end without a
 *  trailing newline) — corrupting a half-written line. Given the current tracked state and the
 *  exact text about to be written to stdout, this derives the new state: a write ending in "\n"
 *  puts us back at a safe fresh-line boundary; a non-empty write not ending in "\n" leaves us
 *  mid-line; an empty write changes nothing (no bytes actually went to the terminal). */
export function trackLineStart(atLineStart: boolean, text: string): boolean {
  if (text.length === 0) return atLineStart;
  return text.endsWith("\n");
}

/** State the live status line needs — everything main.ts's turn/token tracking already keeps. */
export interface StatusLineState {
  activeForm: string;
  elapsedMs: number;
  inTokens: number;
  outTokens: number;
  spinnerFrame: string;
}

/** Pure: the single-line "spinner · activeForm · elapsed · tokens" status line shown above the
 *  task tree while a turn is running (Claude-Code parity). Renders `activeForm` verbatim — the
 *  "in_progress task's activeForm, else 'Working'" fallback is the caller's job (main.ts), since
 *  this module has no notion of "the current task list", only the values it's handed. Wrapped in a
 *  single BLUE...RESET span (unlike task rows, which color only the glyph) since the whole line is
 *  transient chrome, not part of the task tree. */
export function renderStatusLine(s: StatusLineState): string {
  return `${BLUE}${s.spinnerFrame} ${s.activeForm}… (${formatElapsed(s.elapsedMs)} · ↑ ${formatTokens(s.inTokens)} ↓ ${formatTokens(s.outTokens)} tokens)${RESET}`;
}

/** Width-truncates a `renderStatusLine` result — which, unlike task rows, is wrapped in ONE color
 *  span for its entire length (`${BLUE}<visible>${RESET}`). A naive char-slice truncation (as used
 *  for task rows, which truncate plain text before adding color) would risk cutting into the
 *  trailing RESET on a narrow terminal, leaking blue into everything printed after — so this trims
 *  only the visible text between the known-length prefix/suffix and always re-appends a clean
 *  RESET. `columns` undefined/tiny, or the line already fits → unchanged. */
export function truncateStatusLine(line: string, columns?: number): string {
  if (!columns || columns <= 2) return line;
  const visible = line.slice(BLUE.length, line.length - RESET.length);
  const budget = columns - 2;
  if (visible.length <= budget) return line;
  return `${BLUE}${visible.slice(0, budget - 1)}…${RESET}`;
}

/** Pure: the interactive mode bar (2e-iii-b §7) — `▶▶ <policy> mode (shift+tab to cycle) · esc to
 *  interrupt`, always shown in interactive mode regardless of turn state. TWO color spans (unlike
 *  `renderStatusLine`'s one): BLUE through "mode", DIM for the rest — so truncation generalizes
 *  `truncateStatusLine`'s technique (slice the visible text, re-append a clean RESET, never cut an
 *  escape code) across a span boundary: truncate the CONCATENATED plain text to budget, then split
 *  the result back into however much of each span survived (dropping the DIM span entirely once
 *  nothing of it fits). `columns` undefined/tiny → unchanged, same threshold as everywhere else. */
export function renderModeBar(policy: string, columns?: number): string {
  const span1 = `▶▶ ${policy} mode`;
  const span2 = ` (shift+tab to cycle) · esc to interrupt`;
  if (!columns || columns <= 2) return `${BLUE}${span1}${RESET}${DIM}${span2}${RESET}`;
  const budget = columns - 2;
  const full = `${span1}${span2}`;
  if (full.length <= budget) return `${BLUE}${span1}${RESET}${DIM}${span2}${RESET}`;
  const truncated = `${full.slice(0, budget - 1)}…`;
  if (truncated.length <= span1.length) return `${BLUE}${truncated}${RESET}`;
  return `${BLUE}${truncated.slice(0, span1.length)}${RESET}${DIM}${truncated.slice(span1.length)}${RESET}`;
}

/** Pure: how many physical terminal rows a set of already-PAINTED lines (by their stored VISIBLE
 *  lengths) occupies at a given (possibly since-changed) `columns` width — `sum(max(1,
 *  ceil(len / columns)))`, each line at least 1 row (an empty line still occupies its row).
 *  `columns` undefined or falsy (0) → 1 row per line (`lengths.length`), matching the pre-resize
 *  behavior where the erase step just counted logical lines.
 *
 *  This is the resize-safety piece (design doc §8): every renderer in this file truncates each row
 *  to fit ONE physical row AT THE WIDTH IT WAS PAINTED, but a terminal resize can shrink the width
 *  out from under already-printed lines before the next repaint reflows them — the on-screen
 *  content itself may now be wrapping even though nothing has been reprinted yet. The erase step
 *  must count rows at the CURRENT (post-resize) width using each line's stored length, not assume
 *  1 logical line == 1 physical row, or it cursor-ups too few rows and strands fragments. */
export function physicalRows(lengths: number[], columns: number | undefined): number {
  if (!columns) return lengths.length;
  return lengths.reduce((sum, len) => sum + Math.max(1, Math.ceil(len / columns)), 0);
}
