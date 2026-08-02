/** `<AgentsView>` / `<AgentsApp>` (session-activity-hygiene T9) — the Ink surface of `norma agents`.
 *
 *  `<AgentsView>` is PRESENTATION ONLY: state + a clock in, rows out. No client, no side effects, no
 *  `Date.now()` — the `<TaskList>` / `<AgentList>` convention, and what lets the render tests assert
 *  frames without a daemon or a terminal. Every decision it renders (which rows exist, what the "for"
 *  column may honestly claim, what a verb did) was made in `agents-cli.ts`.
 *
 *  `<AgentsApp>` is the thin container: subscribe to the store, tick the clock, route keys through
 *  `keyToAgentsAction`. It holds no roster logic of its own — a key becomes an action, an action
 *  becomes a call on the props.
 *
 *  Row shape, one line each (the `<AgentList>` selected-row idiom: a `▶ ` pointer that is plain
 *  ASCII, so tests never parse ANSI):
 *
 *    ▶ ● background  Fix the reaper                    4m 12s  ~/code/norma        s_1a2b3c4d5e6f
 *      ○ active      Refactor the hub                    ≥13s  ~/code/other        s_0f1e2d3c4b5a
 */

import React, { useEffect, useState } from "react";
import { Box, Text, render as inkRender, useInput } from "ink";
import { homedir } from "node:os";
import {
  AGENTS_EMPTY_STATE, AGENTS_KEY_HINT, CWD_WIDTH, formatCwdColumn, formatForColumn, keyToAgentsAction,
  type AgentRow, type AgentsAction, type AgentsMount, type AgentsState,
} from "../agents-cli";
import { theme } from "./theme";

const TITLE_WIDTH = 40;
const STATE_WIDTH = 10;

/** Truncated with a trailing "…" only when actually cut short — `routinePromptHead`'s own rule. */
function titleCell(row: AgentRow): string {
  const text = row.title ?? row.sessionId;
  return text.length > TITLE_WIDTH ? `${text.slice(0, TITLE_WIDTH - 1)}…` : text.padEnd(TITLE_WIDTH);
}

function AgentRowView({ row, selected, nowMs, home }: { row: AgentRow; selected: boolean; nowMs: number; home: string }) {
  // A backgrounded session is the one doing work nobody is watching — the filled dot. An active one
  // already has a window on it somewhere.
  const glyph = row.activity === "background" ? "●" : "○";
  return (
    <Text inverse={selected}>
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
 *  reason `nowMs` is a prop and not a `Date.now()`. */
export function AgentsView({ state, nowMs, home = homedir() }: { state: AgentsState; nowMs: number; home?: string }) {
  return (
    <Box flexDirection="column">
      <Text bold color={theme.accent}>norma agents</Text>
      {state.rows.length === 0
        ? <Text dimColor>{AGENTS_EMPTY_STATE}</Text>
        : state.rows.map((r) => (
          <AgentRowView key={r.sessionId} row={r} selected={r.sessionId === state.selectedId} nowMs={nowMs} home={home} />
        ))}
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
 *  component's entire job is store → frame and key → action. */
export function AgentsApp({ store, onAction, now = () => Date.now() }: {
  store: AgentsStoreLike;
  onAction(action: AgentsAction): void;
  now?(): number;
}) {
  const [state, setState] = useState<AgentsState>(() => store.get());
  const [nowMs, setNowMs] = useState<number>(() => now());

  useEffect(() => store.subscribe(() => setState(store.get())), [store]);
  useEffect(() => {
    // 1s, not app.tsx's 100ms: the only live chrome here is a duration rendered in whole seconds.
    const id = setInterval(() => setNowMs(now()), 1000);
    return () => clearInterval(id);
  }, [now]);

  useInput((input, key) => {
    const action = keyToAgentsAction(input, key);
    if (action) onAction(action);
  });

  return <AgentsView state={state} nowMs={nowMs} />;
}

/** The real Ink mount `runAgentsCommand` is handed by main.ts (tests inject a fake instead — same
 *  `RenderLike` seam `mountTui` uses).
 *
 *  Deliberately an INLINE render, not `mountTui`'s alt-screen: an alt screen would erase the frame
 *  on exit, and the one thing a user asks this roster for and needs to KEEP is the `open` verb's
 *  resume command. (The runner re-prints it after unmount anyway, so the guarantee doesn't rest on
 *  this choice.) `exitOnCtrlC: false` because the keymap owns ctrl+c — Ink's own handler would tear
 *  the process down without closing the socket or printing that hand-off. */
export const mountAgents: AgentsMount = ({ store, onAction }) => {
  const instance = inkRender(<AgentsApp store={store} onAction={onAction} />, { exitOnCtrlC: false });
  return {
    waitUntilExit: () => instance.waitUntilExit(),
    unmount: () => instance.unmount(),
  };
};
