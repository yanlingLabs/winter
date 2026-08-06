/** `<AgentsView>` / `<AgentsApp>` (session-activity-hygiene T9; FULLSCREEN since bugfix pass B3) —
 *  the Ink surface of `norma agents`.
 *
 *  `<AgentsView>` is PRESENTATION ONLY: state + a clock in, rows out. No client, no side effects, no
 *  `Date.now()` — the `<TaskList>` / `<AgentList>` convention, and what lets the render tests assert
 *  frames without a daemon or a terminal. Every decision it renders (which rows exist, what the "for"
 *  column may honestly claim, what a verb did, how many rows fit the frame) was made in
 *  `agents-cli.ts`. With `frameRows` set it lays out an alt-screen frame: exact height, the key hint
 *  pinned to the bottom row, the roster windowed by `planAgentsViewport`/`listStart` with honest
 *  `↑/↓ N more` markers when rows are cut off. Without `frameRows` it renders the legacy inline
 *  layout unchanged (the render tests' pin, and `formatAgentsSnapshot`'s visual twin).
 *
 *  `<AgentsApp>` is the thin container: subscribe to the store, tick the clock, track terminal
 *  geometry, route keys through `keyToAgentsAction` and wheel notches through `wheelToAgentsAction`
 *  (decoded AT THE INPUT LAYER by input-model's `createMouseFilter`, the main TUI's own emitter
 *  patch — mouse tracking is on for the whole mount, so every report must be consumed before Ink's
 *  useInput can leak it into the keymap as text). It holds no roster logic of its own — a key
 *  becomes an action, an action becomes a call on the props; the only state it owns is the window's
 *  scroll position, and even that movement is `ensureRosterStart`'s decision.
 *
 *  Row shape, one line each (the `<AgentList>` selected-row idiom: a `▶ ` pointer that is plain
 *  ASCII, so tests never parse ANSI):
 *
 *    ▶ ● background  Fix the reaper                    4m 12s  ~/code/norma        s_1a2b3c4d5e6f
 *      ○ active      Refactor the hub                    ≥13s  ~/code/other        s_0f1e2d3c4b5a
 */

import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useInput, useStdin } from "ink";
import { homedir } from "node:os";
import {
  AGENTS_EMPTY_STATE, AGENTS_KEY_HINT, CWD_WIDTH, ensureRosterStart, formatCwdColumn, formatForColumn,
  keyToAgentsAction, planAgentsViewport, wheelToAgentsAction,
  type AgentRow, type AgentsAction, type AgentsMount, type AgentsMountHandle, type AgentsState,
} from "../agents-cli";
import { createMouseFilter, isMouseArtifact } from "./input-model";
import { mountFullscreen, type RenderLike } from "./mount";
import { theme } from "./theme";

const TITLE_WIDTH = 40;
const STATE_WIDTH = 10;

/** app.tsx's own geometry read (its module-local `readRows`), duplicated as the same one-liner
 *  because neither file exports it: live `process.stdout.rows` with the classic 24 fallback. */
const readRows = (): number => (typeof process.stdout.rows === "number" ? process.stdout.rows : 24);

/** Truncated with a trailing "…" only when actually cut short — `routinePromptHead`'s own rule. */
function titleCell(row: AgentRow): string {
  const text = row.title ?? row.sessionId;
  return text.length > TITLE_WIDTH ? `${text.slice(0, TITLE_WIDTH - 1)}…` : text.padEnd(TITLE_WIDTH);
}

function AgentRowView({ row, selected, nowMs, home, oneLine }: { row: AgentRow; selected: boolean; nowMs: number; home: string; oneLine?: boolean }) {
  // A backgrounded session is the one doing work nobody is watching — the filled dot. An active one
  // already has a window on it somewhere.
  // `oneLine` (fullscreen): truncate at the terminal edge instead of wrapping — the frame's height
  // math counts one PHYSICAL line per row, and a wrapped row would push the bottom chrome out of
  // the fixed-height frame (the same reason the main TUI pre-wraps its transcript at `columns`).
  const glyph = row.activity === "background" ? "●" : "○";
  return (
    <Text inverse={selected} wrap={oneLine ? "truncate" : undefined}>
      <Text dimColor={!selected}>{selected ? "▶ " : "  "}</Text>
      <Text color={selected ? undefined : row.activity === "background" ? theme.warning : theme.accent}>
        {`${glyph} ${row.activity.padEnd(STATE_WIDTH)}`}
      </Text>
      {titleCell(row)}
      <Text dimColor={!selected}>
        {`  ${formatForColumn(row, nowMs).padStart(8)}  ${formatCwdColumn(row.cwd, home).padEnd(CWD_WIDTH)}  ${row.sessionId}`}
      </Text>
    </Text>
  );
}

/** `home` is a prop with a `homedir()` default rather than a call inside the row, keeping this
 *  component pure (no environment reads) and its `~`-collapsing deterministic under test — the same
 *  reason `nowMs` is a prop and not a `Date.now()`.
 *
 *  `frameRows`/`listStart` are the B3 fullscreen inputs, both optional so the legacy inline layout
 *  (no explicit height, every row, no markers) stays byte-identical when they are absent. The
 *  overflow markers are dim, honest counts — never a row silently missing from a roster that
 *  claims to be THE roster — and their two lines are reserved whenever the list overflows (blank at
 *  an edge) so the window they describe never resizes because of them (`planAgentsViewport`'s own
 *  rule). */
export function AgentsView({ state, nowMs, home = homedir(), frameRows, listStart = 0 }: {
  state: AgentsState;
  nowMs: number;
  home?: string;
  frameRows?: number;
  listStart?: number;
}) {
  const fullscreen = frameRows !== undefined;
  const plan = fullscreen ? planAgentsViewport(frameRows, state.rows.length, state.notice !== undefined) : undefined;
  const start = plan ? Math.min(Math.max(0, listStart), Math.max(0, state.rows.length - plan.capacity)) : 0;
  const end = plan ? Math.min(state.rows.length, start + plan.capacity) : state.rows.length;
  const above = start;
  const below = state.rows.length - end;
  return (
    <Box flexDirection="column" height={frameRows}>
      <Text bold color={theme.accent}>norma agents</Text>
      {state.rows.length === 0
        ? <Text dimColor>{AGENTS_EMPTY_STATE}</Text>
        : (
          <>
            {plan?.markers ? <Text dimColor>{above > 0 ? `  … ↑ ${above} more` : " "}</Text> : null}
            {state.rows.slice(start, end).map((r) => (
              <AgentRowView key={r.sessionId} row={r} selected={r.sessionId === state.selectedId} nowMs={nowMs} home={home} oneLine={fullscreen} />
            ))}
            {plan?.markers ? <Text dimColor>{below > 0 ? `  … ↓ ${below} more` : " "}</Text> : null}
          </>
        )}
      {fullscreen ? <Box flexGrow={1} /> : null}
      {state.notice ? <Text color={theme.success}>{state.notice}</Text> : null}
      <Text dimColor>{AGENTS_KEY_HINT}</Text>
    </Box>
  );
}

/** The store the roster's poll + event stream write into and this tree reads. Deliberately tiny and
 *  framework-free (it lives in the runner, which has no React): a snapshot getter, a setter that
 *  notifies, and an unsubscribe. */
export interface AgentsStoreLike {
  get(): AgentsState;
  subscribe(fn: () => void): () => void;
}

/** ONE `onAction` prop rather than an onMove/onVerb/onExit trio: `keyToAgentsAction` already
 *  produces the whole action union, so anything else here would be the same three-case switch
 *  written twice — once to take the union apart, once for the runner to put it back together. The
 *  component's entire job is store → frame, key → action, wheel → action. */
export function AgentsApp({ store, onAction, now = () => Date.now() }: {
  store: AgentsStoreLike;
  onAction(action: AgentsAction): void;
  now?(): number;
}) {
  const [state, setState] = useState<AgentsState>(() => store.get());
  const [nowMs, setNowMs] = useState<number>(() => now());
  // Terminal geometry, live off process.stdout (+ a resize listener) — app.tsx's exact pattern.
  // The frame is rows-1 (HARD CONSTRAINT 1's shape: keep Ink's outputHeight strictly under
  // stdout.rows so the terminal never scrolls under the alt screen).
  const [rows, setRows] = useState(readRows);

  useEffect(() => store.subscribe(() => setState(store.get())), [store]);
  useEffect(() => {
    // 1s, not app.tsx's 100ms: the only live chrome here is a duration rendered in whole seconds.
    const id = setInterval(() => setNowMs(now()), 1000);
    return () => clearInterval(id);
  }, [now]);
  useEffect(() => {
    const onResize = () => setRows(readRows());
    process.stdout.on("resize", onResize);
    return () => { process.stdout.off("resize", onResize); };
  }, []);

  // Mouse reports: intercepted at the shared stdin input emitter BEFORE any useInput consumer —
  // the main TUI's own patch shape (app.tsx, TUI renderer T1), reused because the failure class is
  // identical: mount.ts enables mouse tracking for the whole mount, so a wheel flick over this
  // roster would otherwise arrive in `useInput` as the printable "[<64;…M" remnant and fall into
  // the letter keymap. Wheel notches become the arrows' own move action; every other report is
  // swallowed. One stateful filter per mount (a ref) so a report split across reads survives.
  const { internal_eventEmitter: inputEmitter } = useStdin();
  const mouseFilterRef = useRef(createMouseFilter());
  const onActionRef = useRef(onAction);
  onActionRef.current = onAction;
  useEffect(() => {
    const em = inputEmitter;
    if (!em) return;
    const orig = em.emit.bind(em) as (event: string, ...args: unknown[]) => boolean;
    const consumeMouseReports = mouseFilterRef.current;
    const patched = (event: string, ...args: unknown[]): boolean => {
      if (event === "input") {
        const chunk = String(args[0]);
        const { text, wheel } = consumeMouseReports(chunk);
        for (const w of wheel) onActionRef.current(wheelToAgentsAction(w));
        if (text !== chunk) {
          // The chunk contained mouse-report bytes — never forward the ORIGINAL raw chunk (the
          // tui-mouse leak); forward only whatever genuine text is left, if any.
          if (text === "") return true;
          return orig(event, text);
        }
      }
      return orig(event, ...args);
    };
    em.emit = patched as typeof em.emit;
    return () => { em.emit = orig as typeof em.emit; };
  }, [inputEmitter]);

  useInput((input, key) => {
    if (isMouseArtifact(input)) return; // defense-in-depth (app.tsx's own second layer)
    const action = keyToAgentsAction(input, key);
    if (action) onAction(action);
  });

  const frameRows = Math.max(4, rows - 1);
  // The window's start, remembered across renders in a ref (not state: the corrected value is only
  // ever consumed by THIS render, and every input that could move it — selection, rows, notice,
  // geometry — already causes one).
  const startRef = useRef(0);
  const plan = planAgentsViewport(frameRows, state.rows.length, state.notice !== undefined);
  const selIdx = state.rows.findIndex((r) => r.sessionId === state.selectedId);
  startRef.current = ensureRosterStart(startRef.current, selIdx, state.rows.length, plan.capacity);

  return <AgentsView state={state} nowMs={nowMs} frameRows={frameRows} listStart={startRef.current} />;
}

/** The real mount `runAgentsCommand` is handed by main.ts — since B3 a FULLSCREEN alt-screen
 *  surface through `mountFullscreen`, the exact machinery `mountTui` uses (alt-screen escape
 *  order, the damage-diffing writer with B1's cursor-escape pass-through, `NORMA_TUI_DIFF=0`
 *  kill-switch, resize reset, exit hygiene) — never a second hand-rolled alt-screen stack.
 *
 *  T9 originally kept this an INLINE render so the `open` verb's resume command would survive on
 *  screen after exit; the alt screen erases its frame by design, so that guarantee now rests
 *  ENTIRELY on the runner re-printing `lastOpen` after `waitUntilExit()` — which lands in the
 *  NORMAL buffer because mount.ts writes LEAVE before resolving (the same structural order
 *  main.ts's resume hint relies on). The runner's re-print predates B3 (agents-cli.ts's
 *  `lastOpen`), so the hand-off doctrine (print the command, never auto-exec a resume) holds
 *  unchanged. `unmount` maps to the scaffold's idempotent `requestExit` (mouse-off first — the
 *  keymap owns ctrl+c/q/Esc, so the runner's quit action is the one teardown door). */
export function mountAgentsFullscreen(
  opts: { store: AgentsStoreLike; onAction(action: AgentsAction): void },
  renderImpl?: RenderLike,
  write?: (s: string) => void,
  stdoutStream?: NodeJS.WriteStream,
): AgentsMountHandle {
  const handle = mountFullscreen(
    () => <AgentsApp store={opts.store} onAction={opts.onAction} />,
    renderImpl, write, stdoutStream,
  );
  return { waitUntilExit: handle.waitUntilExit, unmount: handle.requestExit };
}

export const mountAgents: AgentsMount = (opts) => mountAgentsFullscreen(opts);
