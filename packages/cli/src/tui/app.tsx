/** `<App>` (Phase 3a Task 6; Phase 3c Task 4 — rebuilt as CC's FULLSCREEN alt-screen shell). It
 *  folds the client's event stream (via the `EventBridge`) through the pure `reduce` reducer into
 *  one `TuiState`, renders a JS-WINDOWED transcript above a PINNED bottom bar (composer + turn
 *  chrome), and wires the composer/card callbacks back to the client
 *  (send/steer/interrupt/setPolicy/approval/ask/plan).
 *
 *  FULLSCREEN LAYOUT (Task 4), inside a root `<Box flexDirection="column" height={rows-1}>` (HARD
 *  CONSTRAINT 1: an explicit numeric height keeps Ink's `outputHeight < stdout.rows` unconditionally,
 *  so Ink never emits the scrollback-erasing clearTerminal):
 *    <Box flexGrow={1}>            — the transcript viewport: EXACTLY the visible lines of the flattened
 *                                    line log (welcome header ++ `makeFlattenCache().lines(committed)`),
 *                                    sliced by `viewport.ts` to `viewH` = (rows-1) − bottomBarRows, ONE
 *                                    <Text> per line (HARD CONSTRAINT 2: JS-window everything; never
 *                                    lean on Yoga overflow). `flexGrow` pushes the bar to the bottom
 *                                    when the log is shorter than the viewport.
 *    <Box flexShrink={0}>          — the pinned bottom bar, top-to-bottom:
 *      activeTurn (tail-sliced)     — the in-flight streaming turn, JS tail-capped at ⌈rows/3⌉ lines.
 *      [TaskList]                   — when tasks exist AND `tasksVisible` (DEFAULT TRUE; ctrl+t toggles).
 *      Spinner                      — animated in-progress indicator (only while a turn runs).
 *      PendingCards | Composer      — a card takes over input when `state.pending` is set.
 *      [AgentList]                  — the subagent tree, only while any agent is live.
 *      Footer                       — policy/interrupt/agents hint line.
 *
 *  KEY ROUTING — TWO `useInput` hooks, deliberately split (Phase 3c Task 5 review finding: a single
 *  `isActive: !state.pending` hook made ctrl+C dead the instant a pending card took over input, and
 *  Ink's own `exitOnCtrlC` is off — see mount.ts — so the app was UNQUITTABLE until the card was
 *  answered):
 *    1. The scroll/toggle hook (active while `!state.pending`): PgUp/PgDn scroll ±(viewH-1), ctrl+u
 *       scrolls UP ⌈viewH/2⌉, ctrl+o toggles `verbose`, ctrl+t toggles `tasksVisible`. It touches
 *       NEITHER ctrl+C NOR ctrl+D (both owned wholesale by #2 below — never duplicated, so the two
 *       hooks never both act on the same keystroke; the whole-branch review caught the original
 *       ctrl+d half-page-down binding double-firing with the exit flow — scroll AND arm on one
 *       press — so ctrl+d was ceded to the exit hook entirely. Half-page-DOWN is covered by PgDn;
 *       ctrl+u keeps half-page-up. Spec §5 amended to match).
 *    2. The EXIT hook (Task 5, `isActive: true` UNCONDITIONALLY): double-press ctrl+C (800ms window,
 *       timed off the ticking `nowMs`, never `Date.now`) — first press arms + (if a turn is running)
 *       ALSO interrupts; second press of the SAME key within the window calls `onExitRequest` (a
 *       DIFFERENT eligible key inside the window re-arms under that key instead of exiting); window
 *       expiry re-arms cleanly on the next press. ctrl+D drives the identical arm/exit flow, but
 *       ONLY when the composer is empty or unmounted (a pending card owns input) — a non-empty
 *       buffer leaves ctrl+D fully inert (nothing else binds it anymore). While armed, the footer
 *       shows the exact key-specific "Press Ctrl-C|Ctrl-D again to exit" hint (below).
 *  Home/End when the composer is EMPTY jump the transcript to its top/bottom (spec §5) — routed
 *  through the composer's T3 raw side-channel (the single consumer of those byte sequences), which
 *  calls back into this App's `scrollToTop`/`scrollToBottom` viewport updates instead of running its
 *  cursor ops; with text in the buffer they keep their cursor semantics and never scroll.
 *  Mouse SGR reports (wheel + any button/motion) are intercepted at the shared stdin input emitter
 *  and swallowed BEFORE any `useInput` consumer (either hook here, the composer's, or a pending
 *  card's) sees them — wheel scrolls ±3, every other mouse report is dropped (so no mouse bytes ever
 *  land in the composer buffer). Neither that emitter patch nor the composer's own T3 raw side-
 *  channel ever matches \x03/\x04, so neither interferes with the exit hook.
 *
 *  CHILD-TRANSCRIPT VIEW (child-transcript-view T3, CC sub-agents parity): ctrl+a (intercepted at
 *  the same emitter patch, since the composer owns ctrl+a-as-Home) toggles roster SELECT MODE while
 *  agents exist — the composer disables, ↑/↓ move a highlight over `<AgentList>` (its
 *  `selectedIndex` prop), Enter opens the highlighted agent's CHILD VIEW, `x` stops a running row
 *  (`agent.stop` RPC) or locally dismisses a finished one, Esc exits select mode. An open child
 *  view swaps the transcript region to that agent's `childBlocks` under a pinned one-line header;
 *  the composer re-enables with non-slash submits routed to `thread.send` (slash commands keep
 *  running in the MAIN session — CC: "built-in commands still run in your main conversation") and
 *  an empty-buffer Esc closes the view (`Composer.onEscEmpty`, outranking running-interrupt for
 *  that one case). A pruned roster row auto-closes its view; `x`-dismissals live in App state only
 *  (never the reducer's aggregates).
 *
 *  RESUME REPLAY (Task 5): `resumeTargetSeq` (mount.ts ← main.ts, set only on the `norma resume <id>`
 *  Ink route, which attaches from seq 0 instead of the tip) drives a `resuming` flag — true from
 *  mount until an event with `seq >= resumeTargetSeq` is processed (or never true at all if the prop
 *  is omitted or 0), rendering a dim "Resuming conversation…" line above the composer/card meanwhile.
 *  Every other event type's handling is unaffected — `task_notification` in particular already
 *  reduces to a no-op (state.ts's `default` case), so it replays invisibly like today.
 *
 *  Clock discipline unchanged from 3a: the reducer is fed an INJECTED clock (`now()` at event time);
 *  a ~100ms `setInterval` ticks `nowMs` in state for live chrome; `reduce` itself never calls
 *  Date.now. Policy cycle keeps the one-RPC-in-flight guard; idle-Esc stays inert. */

import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { Box, Text, useInput, useStdin } from "ink";
import { Chalk } from "chalk";
import wrapAnsi from "wrap-ansi";
import { METHODS, type ApprovalPolicy, type SessionEvent } from "@norma/protocol";
import { initialState, reduce, type AgentRow, type Block, type LocalEvent, type PendingCard, type TuiState } from "./state";
import { activeTurnLines, makeFlattenCache } from "./flatten-blocks";
import { scrollBy, scrollToBottom, scrollToTop, viewportSlice, type ViewportState } from "./viewport";
import { collapseCompleted, sortTasksForDisplay, type TaskRow } from "../task-display";
import { renderWithCursor, type InputState } from "./input-model";
import { Spinner } from "./spinner";
import { TaskList } from "./task-list";
import { AgentList, FINISH_LABEL } from "./agent-list";
import { Footer, type ExitKey } from "./footer";
import { Composer } from "./composer";
import { PendingCards, type AnswerPayload } from "./pending-cards";
import { parseMouseInput } from "./alt-screen";
import { theme } from "./theme";
import { loadSafeHighlighter } from "./highlight-guard";
import type { Highlighter } from "./markdown";
import type { EventBridge } from "./event-bridge";
import type { parsePlanResponse } from "../plan-response";
import { runCommand, type CommandCtx } from "./commands";
import { buildFileIndex } from "./file-index";
import type { NormaClient } from "../client";

/** The subset of `NormaClient` `<App>` actually calls — declared structurally so tests can pass a
 *  fake that only records these callbacks (the real `NormaClient` satisfies it field-for-field). */
export interface AppClient {
  send(sessionId: string, text: string): unknown;
  steer(sessionId: string, text: string): unknown;
  interrupt(sessionId: string): unknown;
  setPolicy(sessionId: string, policy: ApprovalPolicy): unknown;
  askUserRespond(params: { sessionId: string; callId: string; answers: Record<string, string>; notes?: Record<string, string> }): unknown;
  planRespond(params: { sessionId: string; callId: string; approved: boolean; autoAccept?: boolean; feedback?: string }): unknown;
  request(method: string, params?: unknown): unknown;
  /** child-transcript-view T3: the two typed members (unlike the `unknown`-returning callbacks
   *  above) — App reads `delivered`/`status` off the results to render feedback notes. Declared
   *  as the STRUCTURAL subset App consumes; the real `NormaClient.sendToThread`/`agentStop`
   *  results (which also carry `ok: true`) are assignable as-is. */
  sendToThread(sessionId: string, agent: string, text: string): Promise<{ delivered: "queued" | "resumed"; agentId: string }>;
  agentStop(sessionId: string, agent: string): Promise<{ status: string }>;
}

/** Phase 3d T2 — everything the reducer's `dispatch` can be fed: every real wire `SessionEvent`
 *  PLUS the one App-internal synthetic event (`LocalEvent`, state.ts) the slash-command runners use
 *  to commit a note block (see `appendNote` below). `reduce`'s own second parameter stays the loose
 *  structural `WireEvent` (state.ts) — both members here satisfy it — so this union only widens
 *  what `dispatch` itself accepts, not `reduce`'s implementation. */
type AppEvent = SessionEvent | LocalEvent;

export interface AppProps {
  client: AppClient;
  bridge: EventBridge;
  sessionId: string;
  cwd: string;
  initialPolicy: ApprovalPolicy;
  /** Welcome-banner data (main.ts threads these through mountTui). */
  version: string;
  model: string;
  /** Injectable clock (tests). Defaults to Date.now — the ONLY place Date.now enters; passed to
   *  `reduce` strictly as the injected `nowMs`, keeping the reducer pure. Also times the T5
   *  double-press exit window (never `Date.now` directly). */
  now?: () => number;
  /** Exit request (mount.ts wires it to the alt-screen teardown) — the double-press ctrl+C/ctrl+D
   *  flow (Task 5) calls this on the SECOND press within the window. */
  onExitRequest?: () => void;
  /** Set ONLY on the Ink `norma resume <id>` route (main.ts attaches from seq 0 there instead of the
   *  tip, replaying the whole session) — the seq the replay is expected to reach. Drives the
   *  "Resuming conversation…" line: shown from mount until an event with `seq >= resumeTargetSeq` is
   *  processed, or never shown at all if this is `undefined` (a fresh session — today's behavior,
   *  byte-identical) or `0` (a resumed session with no prior events — nothing to wait for). */
  resumeTargetSeq?: number;
}

// Restrictiveness order (SP-policies Task 13): plan (must-approve-a-plan) is the most restrictive,
// bypass (auto-approve everything) the least; shift+tab cycles forward through all six and wraps.
// Exported for the CLI's own cycle test (test/policy-order.test.ts) — main.ts's `cyclePolicy` keeps
// an independent copy of this same array (it doesn't import app.tsx) and MUST stay in lockstep.
export const POLICY_ORDER: ApprovalPolicy[] = ["plan", "dont-ask", "ask", "accept-edits", "auto", "bypass"];
const EXIT_WINDOW_MS = 800; // T5 double-press ctrl+C/ctrl+D window, timed off the App's ticking `nowMs`

const readRows = (): number => (typeof process.stdout.rows === "number" ? process.stdout.rows : 24);
const readCols = (): number => (typeof process.stdout.columns === "number" ? process.stdout.columns : 80);

/** The welcome header — the FIRST lines of the transcript line log (prepended once; they scroll off
 *  the top as the transcript grows, exactly like any other scrollback line). Bold-accent `Norma` +
 *  dim version, then a dim `model · cwd` line, then a blank spacer. A fixed-level Chalk instance
 *  (same reason as flatten-blocks.ts / markdown.ts: the ambient default downgrades to level 0 under
 *  a non-TTY and would strip these codes). */
function welcomeLines(version: string, model: string, cwd: string): string[] {
  const ansi = new Chalk({ level: 3 });
  return [
    `${ansi.hex(theme.accent).bold("Norma")}${ansi.dim(` v${version}`)}`,
    ansi.dim(`${model} · ${cwd}`),
    "",
  ];
}

/** Child-view header (child-transcript-view T3) — the ONE line pinned above the transcript
 *  viewport while a child view is open: `agent <name|agentId> — <status/finish> · esc back`. Styled
 *  per the welcome banner's idiom just above (accent-bold identity, dim chrome, fixed-level Chalk
 *  for the same non-TTY reason). The identity slot is the child's re-taskable `name` when the
 *  spawn mapping resolved one, else its threadId (== the bg registry's agentId for spawned
 *  children) — deliberately the ADDRESSABLE handle, not `.label`'s display text, since this header
 *  captions the view whose composer messages that exact handle. Hard-capped to the FIRST wrapped
 *  row (wrap-ansi, the file's standard primitive) so `viewH`'s "subtract exactly 1" math can never
 *  be violated by a long name on a narrow terminal. */
function childHeaderLine(row: AgentRow, columns: number): string {
  const ansi = new Chalk({ level: 3 });
  const statusText = row.status === "done" ? (FINISH_LABEL[row.finish ?? "done"] ?? "Done") : row.status;
  const styled = `${ansi.dim("agent ")}${ansi.hex(theme.accent).bold(row.name ?? row.threadId)}${ansi.dim(` — ${statusText} · esc back`)}`;
  return wrapAnsi(styled, Math.max(1, columns), { hard: true, trim: false }).split("\n")[0]!;
}

/** Stable empty-blocks constant (child-transcript-view T3): the child-view flatten memo's
 *  dependency is the child's block ARRAY REFERENCE — a fresh `?? []` per render would defeat it. */
const NO_BLOCKS: Block[] = [];

/** Rendered line count of `<TaskList>` for `tasks`: the count header (1) + the collapsed display
 *  rows + one overflow line when older completed rows were folded away. Logical-row model (assumes
 *  each row fits one terminal line) — mirrors `task-list.tsx`'s own structure. */
function taskListRows(tasks: TaskRow[]): number {
  const { rows, collapsedCompletedCount } = collapseCompleted(sortTasksForDisplay(tasks));
  return 1 + rows.length + (collapsedCompletedCount > 0 ? 1 : 0);
}

/** Rendered line count of a pending card. Approval is one line; plan/question are best-effort
 *  logical-row estimates (the transcript is only a background surface while a card owns input, so a
 *  slight miscount here just adds/removes blank rows above the card, never breaks its own layout). */
function pendingCardRows(pending: PendingCard): number {
  if (pending.kind === "approval") return 1;
  if (pending.kind === "plan") return 5 + pending.plan.split("\n").length; // header + plan + 3-line menu + choose line
  const q = (pending.questions as { options?: unknown[] }[])[0];
  const options = Array.isArray(q?.options) ? q!.options!.length : 0;
  return 3 + options * 2 + 1; // header/question + per-option lines + prompt
}

/** Rendered line count of the IDLE composer's bordered box: the top/bottom border rules (2) + the
 *  content line's WRAP-AWARE row count (Phase 3c Task 5 review fix — the flat `3` this replaced
 *  assumed the content line never wraps, undercounting `bottomBarRows` the moment typed text +
 *  prompt/cursor overflowed `columns`, which risks the exact Yoga shrink-distortion the module doc
 *  above warns about). Builds the SAME string composer.tsx's real render assembles (`"❯ " + before +
 *  cursor-cell + after`, `renderWithCursor`'s cursor-cell placeholder space included) and hard-wraps
 *  it at `columns` via `wrap-ansi` — the identical wrapping primitive `flatten-blocks.ts` already
 *  uses elsewhere in this app, so this count and Ink's own Yoga-measured wrap agree. The dim/inverse
 *  ANSI codes the real render bakes in are omitted here on purpose: `wrap-ansi` measures ANSI-aware
 *  (via `string-width`), so they don't change the wrap point either way — only the plain text needs
 *  to be reconstructed for an accurate row count. */
function composerRows(text: string, cursor: number, columns: number): number {
  const { before, at, after } = renderWithCursor({ text, cursor });
  const content = `❯ ${before}${at || " "}${after}`;
  const contentRows = wrapAnsi(content, Math.max(1, columns), { hard: true, trim: false }).split("\n").length;
  return 2 + Math.max(1, contentRows);
}

/** The pinned bottom bar's rendered line count — subtracted from `rows-1` to size the transcript
 *  viewport. Deliberately a JS line-count model (HARD CONSTRAINT 2: the frame height must be
 *  computed, never guessed via Yoga). Slight OVER-estimates are safe (they only leave blank space in
 *  the flexGrow viewport); the risk is UNDER-estimating so the viewport overflows its flex share and
 *  Yoga shrink-distorts — so the fixed pieces (footer 1, the T5 "Resuming conversation…" line 1 while
 *  active) and the per-row task/agent counts are chosen to match the components' natural (unwrapped)
 *  heights; the composer alone is wrap-aware (`composerRows` above, T5's hard-requirement fix) —
 *  task subjects/footer stay best-effort single-line estimates, per that same review. */
export function bottomBarRows(input: {
  tasksVisible: boolean;
  tasks: TaskRow[];
  agents: AgentRow[];
  running: boolean;
  pending: PendingCard | null;
  activeTurnRows: number;
  /** Terminal width — feeds the composer's wrap-aware row count (or is simply unused when a card
   *  replaces the composer). */
  columns: number;
  /** The idle composer's CURRENT text/cursor (App mirrors these off `Composer`'s `onStateChange`) —
   *  irrelevant (and safely ignored) whenever `pending` is set, since a card replaces the composer. */
  composerText: string;
  composerCursor: number;
  /** T5: the "Resuming conversation…" line renders (and counts) while true. */
  resuming: boolean;
  /** Phase 3d T2: the slash-command completion menu's CURRENT visible row count — `min(6,
   *  filteredCount)` while open, `0` while closed — mirrored off `Composer`'s `onMenuRowsChange`
   *  (the same "App mirrors a Composer-owned derived value" convention `composerText`/
   *  `composerCursor` already use above). Irrelevant while `pending` is set for the same reason:
   *  the composer (and its menu) isn't even mounted then. */
  menuRows: number;
}): number {
  const { tasksVisible, tasks, agents, running, pending, activeTurnRows, columns, composerText, composerCursor, resuming, menuRows } = input;
  let n = activeTurnRows; // in-flight active turn (already tail-capped at ⌈rows/3⌉)
  if (tasks.length > 0 && tasksVisible) n += taskListRows(tasks);
  if (running) n += 1; // Spinner
  if (resuming) n += 1; // "Resuming conversation…"
  n += pending ? pendingCardRows(pending) : composerRows(composerText, composerCursor, columns) + menuRows;
  if (agents.length > 0) n += agents.length * 2; // each agent: head row + continuation row
  n += 1; // Footer
  return n;
}

export function App({
  client, bridge, sessionId, cwd, initialPolicy, version, model,
  now = Date.now, onExitRequest, resumeTargetSeq,
}: AppProps) {
  const [state, dispatch] = useReducer(
    (s: TuiState, e: AppEvent) => reduce(s, e, now()),
    undefined,
    initialState,
  );
  const [nowMs, setNowMs] = useState(() => now());
  const [policy, setPolicy] = useState<ApprovalPolicy>(initialPolicy);
  const policyInFlight = useRef(false);
  const [tasksVisible, setTasksVisible] = useState(true); // CC default: the task view is shown
  const [verbose, setVerbose] = useState(false); // ctrl+o expands tool outputs / disables grouping
  const [highlight, setHighlight] = useState<Highlighter | undefined>(undefined);

  // T5: mirrors the idle composer's OWN InputState (see composer.tsx's `onStateChange` doc comment)
  // — feeds `bottomBarRows`' wrap-aware composer height and the exit hook's ctrl+D eligibility check.
  // A real `useState` (not a ref): `bottomBarRows` must recompute on the SAME render Ink is about to
  // lay the composer out on, or the JS height model could transiently under-count a just-typed
  // wrapped line (the exact Yoga shrink-distortion risk this task's hard requirement fixes).
  const [composerState, setComposerState] = useState<InputState>({ text: "", cursor: 0 });
  const onComposerStateChange = useCallback((s: InputState) => setComposerState(s), []);

  // Phase 3d T2: mirrors the completion menu's visible row count off `Composer`'s
  // `onMenuRowsChange` — same reasoning as `composerState` above (`bottomBarRows` must recompute on
  // the SAME render the menu is about to lay out on), PLUS it's the only way App can observe an
  // Esc-dismissed menu at all: dismissal changes no `InputState` field.
  const [menuRows, setMenuRows] = useState(0);
  const onComposerMenuRowsChange = useCallback((n: number) => setMenuRows(n), []);

  // Phase 3d T2: the in-chat slash-command registry (commands.ts, T1) — `appendNote` commits a note
  // block through the SAME reducer/dispatch path every other transcript line goes through, via the
  // App-internal `local_note` event (state.ts's `LocalEvent` — never a real wire event). `client` is
  // cast to the full `NormaClient` the runners need (`CommandCtx.client`) — `AppClient` above is
  // deliberately only the subset App itself calls; the real production `client` prop (main.ts) is
  // always a genuine `NormaClient`, which satisfies both shapes.
  //
  // T2 review item 3: the SESSION'S live cwd lives in a ref, seeded from the mount-time prop (the
  // welcome banner keeps the original value on purpose), and every run builds a FRESH ctx reading
  // it at run time — so a `/cd`'s daemon-confirmed new cwd (delivered back through `onCwdChanged`,
  // commands.ts's runCd) is what LATER commands in the same session (`/skills`, `/mcp`) receive as
  // `ctx.cwd`.
  const appendNote = useCallback((text: string) => dispatch({ type: "local_note", text }), []);
  const cwdRef = useRef(cwd);
  const onRunCommand = useCallback((text: string) => {
    const ctx: CommandCtx = {
      client: client as unknown as NormaClient,
      sessionId,
      cwd: cwdRef.current,
      appendNote,
      onCwdChanged: (newCwd: string) => { cwdRef.current = newCwd; },
    };
    void runCommand(ctx, text);
  }, [client, sessionId, appendNote]);

  // Phase 3d T3: the "@"-file mention index (file-index.ts) — App owns the ONE lazy build for the
  // composer's whole lifetime, per the brief ("keep it simple: one build per session, no refresh in
  // v1"). `fileIndexRef` is the guard: `onNeedFileIndex` (fired by the composer's first "@"-trigger
  // — see its prop doc on composer.tsx) starts `buildFileIndex` at most once no matter how many
  // times it's called afterward; `fileIndex` state is what actually reaches the composer (via the
  // `fileIndex` prop below) once that promise resolves, turning the menu's "indexing…" placeholder
  // into live matches. Uses the SAME live-cwd ref `onRunCommand` above reads (`cwdRef`) rather than
  // the original mount-time `cwd` prop, so a `/cd` issued before the first "@" is honored.
  const fileIndexRef = useRef<Promise<string[]> | null>(null);
  const [fileIndex, setFileIndex] = useState<string[] | undefined>(undefined);
  const onNeedFileIndex = useCallback(() => {
    if (fileIndexRef.current) return; // already building/built — one per session
    const built = buildFileIndex(cwdRef.current);
    fileIndexRef.current = built;
    void built.then((list) => setFileIndex(list));
  }, []);

  // T5 double-press ctrl+C/ctrl+D exit-armed state (see the file-top doc comment's KEY ROUTING #2).
  // Carries WHICH key armed it (whole-branch review item 3) so the footer hint names the right key;
  // `exitArmedKey` is `undefined` once the window lapses (the stored press simply ages out against
  // the ticking `nowMs` — no timer to cancel).
  const [exitArmed, setExitArmed] = useState<{ atMs: number; key: ExitKey } | null>(null);
  const exitArmedKey: ExitKey | undefined =
    exitArmed !== null && nowMs - exitArmed.atMs <= EXIT_WINDOW_MS ? exitArmed.key : undefined;

  // T5 resume replay: true from mount until an event with `seq >= resumeTargetSeq` is processed (see
  // the file-top doc comment's RESUME REPLAY section). `resumeTargetSeq` is a constant for the
  // mount's whole lifetime (main.ts sets it once, before rendering), so this lazy initializer only
  // ever runs against its true starting value.
  const [resuming, setResuming] = useState<boolean>(() => resumeTargetSeq !== undefined && resumeTargetSeq > 0);

  // Terminal geometry, live off process.stdout (+ a resize listener). Ink lays the root out at an
  // explicit height=rows-1, and the transcript/active-turn are pre-wrapped at `columns`.
  const [rows, setRows] = useState(readRows);
  const [columns, setColumns] = useState(readCols);
  useEffect(() => {
    const onResize = () => { setRows(readRows()); setColumns(readCols()); };
    process.stdout.on("resize", onResize);
    return () => { process.stdout.off("resize", onResize); };
  }, []);

  // Scroll state for the windowed transcript (viewport.ts). Starts stuck to the bottom (auto-follow).
  const [vp, setVp] = useState<ViewportState>(() => scrollToBottom());

  // ---- Live child-transcript view (child-transcript-view T3) -----------------------------------
  // `agentSel` — roster select mode's highlight index into `visibleAgents` (null = off; toggled by
  // ctrl+a, intercepted at the emitter patch below). `childViewId` — the open child view's
  // threadId (null = main transcript). `dismissed` — locally-hidden FINISHED rows (`x` in select
  // mode): App-local presentation state by design, never a reducer aggregate — the reducer's
  // `agents` roster stays the honest wire-derived record (its own turn_started prune eventually
  // drops the rows for real, and the sync effect below then forgets the stale ids).
  const [agentSel, setAgentSel] = useState<number | null>(null);
  const [childViewId, setChildViewId] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());

  const visibleAgents = useMemo(
    () => (dismissed.size === 0 ? state.agents : state.agents.filter((a) => !dismissed.has(a.threadId))),
    [state.agents, dismissed],
  );

  // Roster-shrink bookkeeping: select mode exits when nothing is left to select; an out-of-range
  // highlight (a row above it vanished) folds back to the last row — same "fold a clamp back into
  // state" convention as the viewport's own clampedVp effect below.
  useEffect(() => {
    if (agentSel === null) return;
    if (visibleAgents.length === 0) setAgentSel(null);
    else if (agentSel > visibleAgents.length - 1) setAgentSel(visibleAgents.length - 1);
  }, [agentSel, visibleAgents.length]);

  // Prune sync (design doc failure mode): a child view whose roster row vanished (state.ts's
  // turn_started prune, which also drops its childBlocks) auto-closes back to the main view; and
  // dismissed ids whose rows are gone are forgotten (memory hygiene — the same reason state.ts
  // prunes childBlocks/childPendingTool alongside the rows).
  useEffect(() => {
    if (childViewId !== null && !state.agents.some((a) => a.threadId === childViewId)) setChildViewId(null);
    setDismissed((prev) => {
      if (prev.size === 0) return prev;
      const kept = [...prev].filter((id) => state.agents.some((a) => a.threadId === id));
      return kept.length === prev.size ? prev : new Set(kept);
    });
  }, [state.agents, childViewId]);

  // Opening/closing a child view re-sticks the viewport to the bottom — a fresh view starts at its
  // own tail, and returning to main resumes auto-follow (never a stale scroll offset from the
  // OTHER view's line log).
  useEffect(() => { setVp(scrollToBottom()); }, [childViewId]);

  // The child view is "open" only while its roster row still exists — the row is the header/status
  // source, and the auto-close effect above resets `childViewId` on the next tick anyway; gating
  // the render on the row (not the id alone) just closes the one-render gap in between.
  const childRow = childViewId !== null ? state.agents.find((a) => a.threadId === childViewId) : undefined;
  const childOpen = childRow !== undefined;
  const onCloseChildView = useCallback(() => setChildViewId(null), []);

  // The select-mode highlight, render-clamped (the effect above folds the clamp into state a tick
  // later; rendering meanwhile must never index past the end).
  const selIdx = agentSel === null || visibleAgents.length === 0 ? null : Math.min(agentSel, visibleAgents.length - 1);

  // Whole-branch review item 2 (spec §5, previously dead): Home/End with an EMPTY composer jump the
  // transcript to its top/bottom. The composer's T3 raw side-channel is the single consumer of those
  // byte sequences, so it calls back through these instead of its cursor ops when its text is empty
  // (see composer.tsx). `scrollToTop` unsticks (nothing below the top to follow); `scrollToBottom`
  // re-sticks so the tail auto-follows again.
  const onComposerScrollTop = useCallback(() => setVp((cur) => scrollToTop(cur)), []);
  const onComposerScrollBottom = useCallback(() => setVp(() => scrollToBottom()), []);

  // Subscribe to the bridge; flush its pre-subscribe (attach-replay) backlog then forward live. T5:
  // also clears `resuming` once the replay reaches `resumeTargetSeq` — every `SessionEvent` carries a
  // `seq` (protocol/events.ts's `Base`), so this needs no per-type special-casing (a `task_notification`
  // still reduces to a no-op in state.ts, replaying invisibly, but its `seq` still counts here).
  useEffect(() => bridge.subscribe((e) => {
    dispatch(e);
    if (resumeTargetSeq !== undefined && e.seq >= resumeTargetSeq) setResuming(false);
  }), [bridge, resumeTargetSeq]);

  // Ticking clock so elapsed/spinner chrome advances between real events (legacy 120ms tick twin).
  useEffect(() => {
    const id = setInterval(() => setNowMs(now()), 100);
    return () => clearInterval(id);
  }, [now]);

  // Load the code-fence syntax highlighter once (best-effort, stderr-suppressed — HARD CONSTRAINT 4).
  useEffect(() => {
    let live = true;
    void loadSafeHighlighter().then((hl) => { if (live) setHighlight(() => hl); });
    return () => { live = false; };
  }, []);

  // Flatten cache (memoizes per-block wrapping across the append-only committed array). Rebuilt when
  // the highlighter loads (a one-time transition) so already-cached code fences re-render highlighted;
  // columns/verbose changes are handled by the cache's own internal invalidation.
  const cache = useMemo(() => makeFlattenCache(), [highlight]);

  // --- derived per render -------------------------------------------------------------------------
  const welcome = useMemo(() => welcomeLines(version, model, cwd), [version, model, cwd]);
  const bodyLines = cache.lines(state.committed, { columns, verbose, highlight });

  // Child-view line log (child-transcript-view T3): the transcript region renders the OPEN child's
  // own block list instead of `state.committed`. Flattened through a FRESH one-shot cache inside
  // the memo — never the incremental main `cache` above: `childBlocks` is CAP-DROPPED (state.ts's
  // CHILD_BLOCK_CAP drop-oldest), not append-only, so the incremental cache's index-keyed
  // memoization would silently serve stale lines once the cap shifts indices. The memo's key is
  // the child array's REFERENCE (the reducer returns a new array per append), so the full
  // re-flatten (≤ 200 blocks) runs only when the child's transcript actually changed, never on
  // clock ticks.
  const childBlocksArr = childOpen ? state.childBlocks[childRow!.threadId] ?? NO_BLOCKS : null;
  const childLines = useMemo(
    () => (childBlocksArr === null ? null : makeFlattenCache().lines(childBlocksArr, { columns, verbose, highlight })),
    [childBlocksArr, columns, verbose, highlight],
  );
  const lineLog = childLines ?? welcome.concat(bodyLines);

  const activeCap = Math.ceil(rows / 3);
  const dimToolDot = Math.floor(nowMs / 500) % 2 === 0;
  const atAll = activeTurnLines(state.activeAssistant, state.activeTools, { columns, highlight, dimToolDot });
  const atVisible = atAll.slice(-activeCap); // JS tail-slice (HARD CONSTRAINT 2)

  const barRows = bottomBarRows({
    tasksVisible, tasks: state.tasks, agents: visibleAgents,
    running: state.turnRunning, pending: state.pending, activeTurnRows: atVisible.length,
    columns, composerText: composerState.text, composerCursor: composerState.cursor, resuming,
    menuRows,
  });
  // The child-view header (childHeaderLine) is pinned ABOVE the viewport, outside both the line
  // log and the bottom bar — subtract its one row here so the frame stays exactly rows-1 tall.
  const viewH = Math.max(1, (rows - 1) - barRows - (childOpen ? 1 : 0));

  const { visible, vp: clampedVp } = viewportSlice(lineLog, vp, viewH);

  // Keep `len`/`viewH` current for the input handlers + the mouse emitter patch (both may run from a
  // closure created on an earlier render); refs updated during render, read at event time.
  const lineCountRef = useRef(lineLog.length);
  const viewHRef = useRef(viewH);
  lineCountRef.current = lineLog.length;
  viewHRef.current = viewH;
  // Same event-time-read pattern for the emitter patch's ctrl+a branch (child-transcript-view T3):
  // whether any roster rows exist to select, and whether a pending card owns input right now.
  const visibleAgentCountRef = useRef(visibleAgents.length);
  const pendingRef = useRef<PendingCard | null>(state.pending);
  visibleAgentCountRef.current = visibleAgents.length;
  pendingRef.current = state.pending;

  // Fold back a clamp (e.g. verbose toggle shrank the log under a stored scrollTop) so state stays
  // consistent — no-op when viewportSlice returned the same reference.
  useEffect(() => {
    if (clampedVp !== vp) setVp(clampedVp);
  }, [clampedVp, vp]);

  // --- mouse + ctrl+a: intercept at the shared stdin input emitter, BEFORE any useInput consumer
  // (this App's or the composer's) sees them. Ink emits the RAW chunk (ESC intact) on
  // internal_eventEmitter 'input' (its App.js), so parseMouseInput's strict regex matches directly.
  // A wheel report scrolls ±3; every mouse report (wheel or button/motion) is dropped so no mouse
  // bytes ever reach the composer buffer. ctrl+a (\x01) toggles roster select mode while agents
  // exist (child-transcript-view T3 — see the branch's own comment inside). Restored on unmount. ---
  const { internal_eventEmitter: inputEmitter } = useStdin();
  useEffect(() => {
    const em = inputEmitter;
    if (!em) return;
    const orig = em.emit.bind(em) as (event: string, ...args: unknown[]) => boolean;
    const patched = (event: string, ...args: unknown[]): boolean => {
      if (event === "input") {
        const chunk = String(args[0]);
        const m = parseMouseInput(chunk);
        if (m.isMouse) {
          if (m.wheel) {
            const delta = m.wheel.dir === "up" ? -3 : 3;
            setVp((cur) => scrollBy(cur, delta, lineCountRef.current, viewHRef.current));
          }
          return true; // swallow — no listener fires for this chunk
        }
        // child-transcript-view T3: ctrl+a (\x01) toggles roster select mode — intercepted HERE
        // (the same pre-useInput surface the mouse reports use) because the composer already binds
        // ctrl+a as cursor-Home: letting both a composer branch and an App useInput branch see the
        // keystroke is exactly the double-fire the 3c whole-branch review banned, so the ONE actor
        // is chosen before Ink dispatches at all. Swallowed ONLY while roster rows exist AND no
        // pending card owns input — otherwise \x01 falls through untouched (empty roster keeps the
        // composer's cursor-Home byte-identical; a pending card keeps today's input ownership).
        if (chunk === "\x01" && pendingRef.current === null && visibleAgentCountRef.current > 0) {
          setAgentSel((cur) => (cur === null ? 0 : null));
          return true;
        }
      }
      return orig(event, ...args);
    };
    em.emit = patched as typeof em.emit;
    return () => { em.emit = orig as typeof em.emit; };
  }, [inputEmitter]);

  // child-transcript-view T3: message the OPEN child view's agent (thread.send). Addressed by
  // threadId — which IS the bg registry's stable agentId for spawned children — so the stale-name
  // guard is bypassed by construction (a by-ID resolution always is). Feedback per `delivered`
  // lands as a note IN THE CHILD VIEW via the threadId-routed local_note (state.ts): the typed
  // text itself arrives as a wire user_message later (steer drain / resume echo), so only the
  // delivery outcome is noted here — never a locally-faked user block that would duplicate the
  // echo. RPC errors (unknown agent; T1's "invalid" = resume-refused, e.g. a no-history child)
  // render as a note the same way — never a crash (design doc failure mode).
  const sendToChild = (threadId: string, text: string) => {
    const row = state.agents.find((a) => a.threadId === threadId);
    const display = row?.name ?? row?.label ?? threadId;
    client.sendToThread(sessionId, threadId, text)
      .then((r) => dispatch({
        type: "local_note", threadId,
        text: r.delivered === "resumed"
          ? `agent "${display}" resumed with your message`
          : `message queued for agent "${display}" — delivered at its next round`,
      }))
      .catch((err: unknown) => dispatch({
        type: "local_note", threadId,
        text: `message to agent "${display}" failed: ${err instanceof Error ? err.message : String(err)}`,
      }));
  };

  // child-transcript-view T3: stop a RUNNING roster row (select-mode `x`). The result note lands in
  // the MAIN transcript (select mode is a main-view surface); the row's own status flip arrives via
  // the wire (thread_completed stopReason "aborted") like every other roster update. agent.stop is
  // idempotent daemon-side, so a race with the child finishing just reports the terminal status.
  const stopAgent = (row: AgentRow) => {
    const display = row.name ?? row.label;
    client.agentStop(sessionId, row.threadId)
      .then((r) => dispatch({ type: "local_note", text: `agent "${display}" ${r.status === "stopped" ? "stopped" : `already ${r.status}`}` }))
      .catch((err: unknown) => dispatch({ type: "local_note", text: `agent "${display}" stop failed: ${err instanceof Error ? err.message : String(err)}` }));
  };

  // child-transcript-view T3 (CC parity): while a child view is open, BOTH the submit and steer
  // paths route the typed text to THAT agent ("follow-up messages go to that agent") — a running
  // MAIN turn changes nothing about where the text goes. Slash input never reaches either path
  // (composer's parseSlashInput branch → onRunCommand → the MAIN session, unchanged — "built-in
  // commands still run in your main conversation").
  const onSubmit = (text: string) => {
    if (childOpen) { sendToChild(childRow!.threadId, text); return; }
    void client.send(sessionId, text);
  };
  const onSteer = (text: string) => {
    if (childOpen) { sendToChild(childRow!.threadId, text); return; }
    void client.steer(sessionId, text);
  };
  // idle-Esc parity: no-op while nothing is running (legacy's idle readLine swallowed Esc).
  const onInterrupt = () => { if (state.turnRunning) void client.interrupt(sessionId); };
  const onCyclePolicy = () => {
    if (policyInFlight.current) return; // one setPolicy RPC at a time (repeat presses dropped)
    policyInFlight.current = true;
    const next = POLICY_ORDER[(POLICY_ORDER.indexOf(policy) + 1) % POLICY_ORDER.length]!;
    Promise.resolve(client.setPolicy(sessionId, next))
      .then(() => { setPolicy(next); }) // advance the bar only on success (mirror main.ts:392)
      .catch(() => { /* failure: leave the bar unchanged, same as legacy */ })
      .finally(() => { policyInFlight.current = false; });
  };
  // optionId (SP-approvals T7): set only when the human picked a numbered rule-bearing option in
  // PendingCards' ApprovalCard — included in the RPC params only then (`ApprovalRespondParams`
  // treats a missing optionId as plain allow-once/deny, methods.ts), never sent as a literal
  // `optionId: undefined`.
  const onApprove = (callId: string, yes: boolean, optionId?: string) => {
    void client.request(METHODS.approvalRespond, {
      sessionId, callId, approved: yes,
      ...(optionId !== undefined ? { optionId } : {}),
    });
  };
  const onAnswer = (callId: string, payload: AnswerPayload) => {
    void client.askUserRespond({
      sessionId, callId, answers: payload.answers,
      ...(payload.notes ? { notes: payload.notes } : {}),
    });
  };
  const onPlan = (callId: string, resp: ReturnType<typeof parsePlanResponse>) => {
    void client.planRespond({ sessionId, callId, ...resp });
  };

  useInput(
    (input, key) => {
      // Mouse defense-in-depth: the emitter patch above already swallows SGR reports before this
      // handler, but if any mouse-shaped input slips through (Ink strips the leading ESC), swallow it
      // here too so it never triggers a key branch below. Scrolling is handled by the patch, not here.
      const m = parseMouseInput(input.startsWith("\x1b") ? input : `\x1b${input}`);
      if (m.isMouse) return;

      // child-transcript-view T3 — roster select mode owns ↑/↓/Enter/x/Esc while active. The
      // composer is DISABLED for select mode's whole duration (see its `disabled` prop below), so
      // none of these five ever double-fire against history-nav/submit/insert/interrupt — the one
      // actor per key. Every OTHER key deliberately falls through to the scroll/toggle bindings
      // below (PgUp/PgDn/ctrl+u/o/t all keep working mid-select), and ctrl+C/ctrl+D stay owned by
      // the always-active exit hook as ever.
      if (selIdx !== null) {
        const row = visibleAgents[selIdx];
        if (key.upArrow) { setAgentSel(Math.max(0, selIdx - 1)); return; }
        if (key.downArrow) { setAgentSel(Math.min(visibleAgents.length - 1, selIdx + 1)); return; }
        if (key.return) {
          // Enter opens the selected agent's child view (CC parity) and leaves select mode — the
          // composer re-enables, now routing non-slash submits to this agent.
          if (row) { setChildViewId(row.threadId); setAgentSel(null); }
          return;
        }
        if (input === "x" && !key.ctrl && !key.meta) {
          // x: stop a running row (agent.stop RPC — roster status updates arrive via events), or
          // locally dismiss a finished one (hide from the roster; select mode stays on, the clamp
          // effect re-targets the highlight).
          if (row) {
            if (row.status === "done") setDismissed((prev) => new Set(prev).add(row.threadId));
            else stopAgent(row);
          }
          return;
        }
        if (key.escape) { setAgentSel(null); return; }
      }

      const len = lineCountRef.current;
      const vh = viewHRef.current;
      if (key.pageUp) { setVp((cur) => scrollBy(cur, -(vh - 1), len, vh)); return; }
      if (key.pageDown) { setVp((cur) => scrollBy(cur, vh - 1, len, vh)); return; }
      if (key.ctrl && input === "u") { setVp((cur) => scrollBy(cur, -Math.ceil(vh / 2), len, vh)); return; }
      if (key.ctrl && input === "o") { setVerbose((v) => !v); return; }
      if (key.ctrl && input === "t") { setTasksVisible((v) => !v); return; }
      // ctrl+C AND ctrl+D are deliberately NOT handled here — both belong solely to the dedicated
      // always-active exit hook below (T5 + whole-branch review item 1: the original ctrl+d
      // half-page-down binding here double-fired with the exit flow — one press scrolled AND armed
      // exit / interrupted a running turn twice over. Half-page-down is PgDn now; spec §5 amended).
    },
    { isActive: !state.pending },
  );

  // First press: arm the exit window under `key` (+ interrupt, if a turn is running). Second press
  // of the SAME key within the window: fire onExitRequest. A different eligible key within the
  // window (or any press after expiry) re-arms under that key instead of exiting.
  const armOrExit = (pressKey: ExitKey): void => {
    if (exitArmedKey === pressKey) {
      setExitArmed(null);
      onExitRequest?.();
      return;
    }
    onInterrupt(); // no-op while idle — the turnRunning guard already lives inside onInterrupt
    setExitArmed({ atMs: nowMs, key: pressKey });
  };

  // ALWAYS-ACTIVE exit hook (Task 5 hard requirement): a SEPARATE `useInput` from the scroll/toggle
  // hook above, `isActive: true` UNCONDITIONALLY — so ctrl+C/ctrl+D can quit even while a pending
  // card owns input (the bug this fixes: the scroll/toggle hook goes `isActive: false` the instant a
  // card appears, Ink's own `exitOnCtrlC` is off — mount.ts — and neither PendingCards' nor
  // Composer's own `useInput` ever act on ctrl+C/ctrl+D, so the app was previously unquittable until
  // the card was answered). Only ctrl+C and ctrl+D are handled here — and NOWHERE else (the scroll
  // hook ceded ctrl+d entirely; see its comment) — every other key falls through untouched.
  useInput(
    (input, key) => {
      if (key.ctrl && input === "c") { armOrExit("ctrl-c"); return; }
      if (key.ctrl && input === "d") {
        // Only when the composer is empty or unmounted (a pending card owns input) — a non-empty
        // buffer leaves ctrl+D fully inert (no other hook binds it anymore).
        const composerEligible = state.pending !== null || composerState.text.length === 0;
        if (composerEligible) armOrExit("ctrl-d");
      }
    },
    { isActive: true },
  );

  return (
    <Box flexDirection="column" height={rows - 1}>
      {/* child-transcript-view T3: the pinned one-line header captioning the open child view —
          rendered OUTSIDE the scrolling viewport (always visible, unlike the welcome banner which
          scrolls off) and pre-counted in viewH's math above. */}
      {childOpen ? <Text>{childHeaderLine(childRow!, columns)}</Text> : null}
      <Box flexGrow={1} flexDirection="column" overflow="hidden">
        {visible.map((line, i) => (
          <Text key={i}>{line.length > 0 ? line : " "}</Text>
        ))}
      </Box>
      <Box flexDirection="column" flexShrink={0}>
        {atVisible.map((line, i) => (
          <Text key={`at${i}`}>{line.length > 0 ? line : " "}</Text>
        ))}
        {state.tasks.length > 0 && tasksVisible ? <TaskList tasks={state.tasks} nowMs={nowMs} /> : null}
        <Spinner
          running={state.turnRunning}
          turnStartMs={state.turnStartMs}
          nowMs={nowMs}
          outTokens={state.outTokens}
          tasks={state.tasks}
        />
        {resuming ? <Text dimColor>Resuming conversation…</Text> : null}
        {state.pending ? (
          <PendingCards pending={state.pending} onApprove={onApprove} onAnswer={onAnswer} onPlan={onPlan} />
        ) : (
          <Composer
            running={state.turnRunning}
            policy={policy}
            // Select mode disables the composer wholesale (child-transcript-view T3) — its five
            // keys (↑/↓/Enter/x/Esc) belong to the App's select branch alone while active; the
            // buffer/cursor are preserved untouched for when select mode exits.
            disabled={!!state.pending || selIdx !== null}
            onSubmit={onSubmit}
            onSteer={onSteer}
            onInterrupt={onInterrupt}
            onCyclePolicy={onCyclePolicy}
            nowMs={nowMs}
            sessionId={sessionId}
            onStateChange={onComposerStateChange}
            onScrollTop={onComposerScrollTop}
            onScrollBottom={onComposerScrollBottom}
            onRunCommand={onRunCommand}
            onMenuRowsChange={onComposerMenuRowsChange}
            columns={columns}
            fileIndex={fileIndex}
            onNeedFileIndex={onNeedFileIndex}
            // Passed ONLY while a child view is open: an empty-buffer Esc then closes the view
            // (back to main) instead of any other Esc semantics — see composer.tsx's prop doc.
            onEscEmpty={childOpen ? onCloseChildView : undefined}
          />
        )}
        {visibleAgents.length > 0 ? <AgentList agents={visibleAgents} nowMs={nowMs} selectedIndex={selIdx ?? undefined} /> : null}
        <Footer policy={policy} running={state.turnRunning} agents={visibleAgents} exitArmed={exitArmedKey} />
      </Box>
    </Box>
  );
}
