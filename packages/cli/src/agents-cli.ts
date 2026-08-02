/** `norma agents` (session-activity-hygiene T9) — the live roster of BACKGROUND and ACTIVE
 *  code/cowork sessions, and the four verbs that move them through the lifecycle T1-T8 built.
 *
 *  **It never attaches.** Two independent reasons, both load-bearing:
 *
 *   1. Attaching is what MAKES a session "active" (T2's derivation counts harness attachments), so a
 *      roster that attached to look at a session would change the very state it is displaying.
 *   2. Attaching enrols the connection in T5's detach enforcement — closing the roster would then
 *      look like a terminal harness letting go, which for a `cli-` client aborts a running turn.
 *      A window you opened to WATCH work must not be able to kill it by being closed.
 *
 *  So the roster reads `session.list` (which carries the derived `activity` since T2) and listens
 *  for the `session_activity` transient, which since this task's core half reaches a harness that
 *  attached to nothing (`SessionHub.emitActivity` → `onGlobalEvent`). Poll for truth, transient for
 *  latency: the poll is the authority on titles/rows, the event is what makes a flip instant.
 *
 *  Everything here is pure and injectable for the same reason `cli-verb-gates.ts`'s route functions
 *  are: main.ts's argv switch cannot be driven by a unit test (see main.test.ts's own header), so
 *  anything that must be provable lives in this module and main.ts's `case` stays a thin wrapper.
 *  The Ink view is `tui/agents-view.tsx`; this file holds the state machine, the keymap and the
 *  verbs, so the component is presentation only.
 *
 *  ## What the roster CANNOT honestly show (and does not pretend to)
 *
 *  `session.list` carries no TURN-START stamp. T8 added `AgentEngine.turnStartedAt`, but it reaches
 *  only the dispatch-side `list_sessions` TOOL — the RPC never learned it. The daemon also does not
 *  tell an unattached client WHEN a state began. So the "for" column measures the span THIS VIEW has
 *  watched: an exact span when the roster witnessed the transition (a `session_activity` event, whose
 *  `ts` is used), and a `≥`-prefixed LOWER BOUND when the state was already set at open. A session
 *  backgrounded yesterday reads `≥12s` three seconds after launch — the honest answer, not `12s`.
 *
 *  `cwd` WAS in this list until T9's amendment. The daemon had always sent it (`store.list()` selects
 *  it, the handler returns rows verbatim) but `SessionListResult` never declared it, so the cli
 *  client's schema validation stripped it — a field on the socket that died at the door. It is
 *  declared now, so the column is real; see `formatCwdColumn`.
 */

import { homedir } from "node:os";
import type { NormaClient } from "./client";
import { formatElapsed } from "./task-display";

/** The client name this roster hello's with. `cli-` prefix ⇒ TERMINAL kind by T5's
 *  `TERMINAL_CLIENT_PREFIXES` (core/src/sessions/activity-enforcement.ts). That classification is
 *  moot while the roster never attaches — the enforcement only ever asks about a detaching
 *  ATTACHMENT — but the family is what every other CLI connection uses (`cli-ping`, `cli-sessions`,
 *  `cli-resume`), and a roster that called itself something else would be classified `app` the day
 *  somebody did make it attach. */
export const AGENTS_CLIENT_NAME = "cli-agents";

/** Shown instead of an empty list — the brief's hard requirement: never a blank screen. */
export const AGENTS_EMPTY_STATE = "no background sessions";

/** The footer. Also a parity list: every verb named here must be a verb `runAgentVerb` accepts
 *  (pinned in agents-cli.test.ts) and a key `keyToAgentsAction` maps. */
export const AGENTS_KEY_HINT =
  "↑↓ select · s stop · b background · c clear · a archive · o open (print resume) · q quit";

/** How often the roster re-reads `session.list`. The transient carries every state CHANGE instantly,
 *  so this poll exists for the rest — new sessions, titles, and any state a client could have missed
 *  while it was starting up. */
export const AGENTS_POLL_MS = 2000;

/** The two states the roster shows. `idle`/`archived` sessions are not "agents you have running", and
 *  a session with no `activity` at all does not participate in the lifecycle (chat/dispatch) — the
 *  roster reads the daemon's derived value rather than keeping a mode allowlist of its own, which is
 *  what makes `cowork` work here the day it ships without a line changing. */
const ROSTER_ACTIVITIES: ReadonlySet<string> = new Set(["background", "active"]);

/** Just the fields the roster reads off a `session.list` row (a structural subset of
 *  `SessionListResult.sessions[]` — same plain-interface convention as client.ts's `Routine`). */
export interface AgentSessionRow {
  sessionId: string;
  title?: string;
  mode?: string;
  activity?: string;
  /** Declared on the wire by T9's amendment (`SessionListResult`, packages/protocol/src/methods.ts).
   *  The daemon always sent it; the cli client's schema validation stripped it until it was named. */
  cwd?: string;
}

export interface AgentRow {
  sessionId: string;
  title?: string;
  mode?: string;
  /** Absent means "no recorded cwd" (a session created without one, or one whose index was rebuilt
   *  — cwd does not ride the event log). Never fabricated; rendered as a dash. */
  cwd?: string;
  activity: "background" | "active";
  /** When this view first knew the session to be in THIS state. */
  sinceMs: number;
  /** `true` when `sinceMs` is merely when the roster first SAW the state, not when it began — the
   *  difference between "3s" and "≥3s". See the module doc. */
  observedOnly: boolean;
}

export interface AgentsState {
  rows: AgentRow[];
  /** The SESSION the cursor is on, not an index — rows come and go under it every poll. */
  selectedId?: string;
  notice?: string;
}

export function emptyAgentsState(): AgentsState {
  return { rows: [] };
}

/** No `?? s.rows[0]` fallback: every producer of `AgentsState` (`applySessionList`'s and
 *  `applyActivityEvent`'s own `reselect` calls) already resolves `selectedId` to a concrete, valid
 *  row — or deliberately to `undefined` — before this is ever called, so a fallback here could only
 *  ever silently resurrect a selection one of those callers chose to clear (m36: exactly what let a
 *  rapid repeat of a destructive verb land on a row nobody asked for). */
export function selectedAgent(s: AgentsState): AgentRow | undefined {
  return s.rows.find((r) => r.sessionId === s.selectedId);
}

/** Background first (the roster's subject), then active; each group ordered by the text actually
 *  DISPLAYED (title, or the id when a row has none yet), then by id — so a poll never reshuffles
 *  rows under the cursor for no reason, and a row added by a transient before its title is known
 *  doesn't leap to the top of the group and then move again when the poll names it. */
function sortRows(rows: AgentRow[]): AgentRow[] {
  const rank = (r: AgentRow): number => (r.activity === "background" ? 0 : 1);
  const shown = (r: AgentRow): string => r.title ?? r.sessionId;
  return [...rows].sort((a, b) =>
    rank(a) - rank(b)
    || shown(a).localeCompare(shown(b))
    || a.sessionId.localeCompare(b.sessionId));
}

/** Keeps the cursor on a session that still exists, falling back to the first row (and to nothing
 *  when the roster empties). */
function reselect(rows: AgentRow[], selectedId?: string): string | undefined {
  if (selectedId && rows.some((r) => r.sessionId === selectedId)) return selectedId;
  return rows[0]?.sessionId;
}

/** Fold a fresh `session.list` into the roster. The list is the AUTHORITY on which rows exist and
 *  what they are called; the only thing it cannot supply is when a state began, so a row already
 *  known IN THE SAME STATE keeps its original stamp (otherwise every 2s poll would restart the
 *  clock) and a row whose state moved between polls re-stamps as observed-only (we know it changed
 *  by now, not when). */
export function applySessionList(s: AgentsState, sessions: AgentSessionRow[], nowMs: number): AgentsState {
  const known = new Map(s.rows.map((r) => [r.sessionId, r]));
  const rows: AgentRow[] = [];
  for (const row of sessions) {
    if (!row.activity || !ROSTER_ACTIVITIES.has(row.activity)) continue;
    const activity = row.activity as AgentRow["activity"];
    const prev = known.get(row.sessionId);
    const unchanged = prev !== undefined && prev.activity === activity;
    rows.push({
      sessionId: row.sessionId,
      title: row.title,
      mode: row.mode,
      cwd: row.cwd,
      activity,
      sinceMs: unchanged ? prev.sinceMs : nowMs,
      observedOnly: unchanged ? prev.observedOnly : true,
    });
  }
  const sorted = sortRows(rows);
  return { ...s, rows: sorted, selectedId: reselect(sorted, s.selectedId) };
}

/** The live half: one `session_activity` transient. A transition INTO a roster state adds or flips a
 *  row (stamped with the event's own `ts` — a witnessed transition, so no `≥`); a transition OUT of
 *  one removes it, which is how an archive of a session nobody has open finally reaches a window.
 *  A row added here carries no title: the next poll supplies it, and inventing one would be worse
 *  than a bare id for the ~2s in between. */
export function applyActivityEvent(
  s: AgentsState,
  event: { sessionId: string; activity: string; ts: number },
  _nowMs: number,
): AgentsState {
  const inRoster = ROSTER_ACTIVITIES.has(event.activity);
  const existing = s.rows.find((r) => r.sessionId === event.sessionId);
  if (!inRoster) {
    if (!existing) return s;
    const rows = s.rows.filter((r) => r.sessionId !== event.sessionId);
    // m36: a LIVE removal of the SELECTED row must not auto-advance onto whatever is now first —
    // a rapid repeat of the very verb that just removed it (a second `a` before the frame even
    // repaints) would otherwise land on THAT row instead of doing nothing. Clear outright when it
    // was the row just removed; `reselect` still applies when some OTHER session left the roster
    // (the selection, if still valid, is untouched either way).
    const selectedId = s.selectedId === event.sessionId ? undefined : reselect(rows, s.selectedId);
    return { ...s, rows, selectedId };
  }
  const activity = event.activity as AgentRow["activity"];
  if (existing && existing.activity === activity) return s; // a re-statement is not a new span
  const next: AgentRow = existing
    ? { ...existing, activity, sinceMs: event.ts, observedOnly: false }
    : { sessionId: event.sessionId, activity, sinceMs: event.ts, observedOnly: false };
  const rows = sortRows([...s.rows.filter((r) => r.sessionId !== event.sessionId), next]);
  return { ...s, rows, selectedId: reselect(rows, s.selectedId) };
}

export function moveSelection(s: AgentsState, delta: number): AgentsState {
  if (s.rows.length === 0) return s;
  const current = s.rows.findIndex((r) => r.sessionId === s.selectedId);
  const from = current === -1 ? 0 : current;
  const next = Math.min(s.rows.length - 1, Math.max(0, from + delta));
  return { ...s, selectedId: s.rows[next]!.sessionId };
}

export function withNotice(s: AgentsState, notice: string | undefined): AgentsState {
  return { ...s, notice };
}

/** The "for" column. See the module doc for why the bound is explicit — printing an exact-looking
 *  span for a state whose start we never learned would be a lie the user cannot detect. */
export function formatForColumn(row: { sinceMs: number; observedOnly: boolean }, nowMs: number): string {
  const span = formatElapsed(Math.max(0, nowMs - row.sinceMs));
  return row.observedOnly ? `≥${span}` : span;
}

export const CWD_WIDTH = 28;

/** The cwd column: home collapsed to `~`, then truncated from the LEFT — a roster answers "which
 *  project is this?", and that is the TAIL of a path, not its head. `home` is a parameter (not a
 *  `homedir()` call inside) so the formatting is pure and testable, matching every other formatter
 *  in this file.
 *
 *  A dash, not a blank, when there is no recorded cwd: an empty cell in an aligned column reads as a
 *  rendering bug, while absence here is a real and ordinary state (a session created without a cwd,
 *  or one whose index was rebuilt). Never substitutes a plausible-looking path. */
export function formatCwdColumn(cwd: string | undefined, home: string): string {
  if (!cwd) return "—";
  // `cwd === home` OR strictly under it — a bare `startsWith` would turn /Users/xavier into ~avier.
  const collapsed = cwd === home ? "~" : cwd.startsWith(`${home}/`) ? `~${cwd.slice(home.length)}` : cwd;
  return collapsed.length > CWD_WIDTH ? `…${collapsed.slice(collapsed.length - (CWD_WIDTH - 1))}` : collapsed;
}

/** The EXACT resume invocation, verified against main.ts's own `case "resume"` route (`norma resume
 *  <sessionId>` — a SUBCOMMAND, not a `--resume` flag) and matching `formatResumeHint`'s wording,
 *  which is what the TUI already prints on exit. If those ever diverge, the roster is the surface
 *  telling the user something that does not work. */
export function agentResumeCommand(sessionId: string): string {
  return `norma resume ${sessionId}`;
}

/** One plain (uncolored) line per row — used for the non-TTY snapshot and as the content the Ink
 *  view's own row assertions can be checked against (the `routines-cli.ts` formatter precedent). */
export function formatAgentsSnapshot(s: AgentsState, nowMs: number, home = homedir()): string[] {
  if (s.rows.length === 0) return [AGENTS_EMPTY_STATE];
  return s.rows.map((r) =>
    `${r.activity.padEnd(10)} ${(r.title ?? r.sessionId).padEnd(40)} ${formatForColumn(r, nowMs).padStart(8)}  `
    + `${formatCwdColumn(r.cwd, home).padEnd(CWD_WIDTH)}  ${r.sessionId}`);
}

// ---------------------------------------------------------------------------------------------
// The keymap
// ---------------------------------------------------------------------------------------------

export type AgentVerb = "stop" | "background" | "clear" | "archive" | "open";

export type AgentsAction =
  | { kind: "move"; delta: number }
  | { kind: "verb"; verb: AgentVerb }
  | { kind: "quit" };

/** Ink's `useInput` payload, narrowed to what this keymap reads (so a test can hand it a literal). */
export interface AgentsKey { upArrow: boolean; downArrow: boolean; escape: boolean; ctrl: boolean }

/** Pure so the component's hook is one line and every binding is provable without a terminal.
 *  ctrl+c is checked BEFORE the letter table — otherwise ctrl+c would clear the selected session's
 *  flags on its way out. */
export function keyToAgentsAction(input: string, key: AgentsKey): AgentsAction | null {
  if (key.ctrl && input === "c") return { kind: "quit" };
  if (key.escape) return { kind: "quit" };
  if (key.downArrow || input === "j") return { kind: "move", delta: 1 };
  if (key.upArrow || input === "k") return { kind: "move", delta: -1 };
  switch (input) {
    case "s": return { kind: "verb", verb: "stop" };
    case "b": return { kind: "verb", verb: "background" };
    case "c": return { kind: "verb", verb: "clear" };
    case "a": return { kind: "verb", verb: "archive" };
    case "o": case "\r": return { kind: "verb", verb: "open" };
    case "q": return { kind: "quit" };
    default: return null;
  }
}

// ---------------------------------------------------------------------------------------------
// The verbs
// ---------------------------------------------------------------------------------------------

/** Exactly the two RPCs the roster may make, structurally — a fake in a test satisfies it, and the
 *  type itself is the statement that `attach`/`send` are not on this surface. */
export type AgentsVerbClient = Pick<NormaClient, "interrupt" | "sessionSetActivity">;

export interface AgentVerbResult {
  message: string;
  /** `true` when the verb changed daemon state, so the caller should re-poll rather than wait out
   *  the interval (the transient usually beats it, but a refused verb emits nothing at all). */
  changed: boolean;
}

/** Runs one verb against one row and hands back the line to show. Never throws: a refusal (an
 *  archived-target rule, a non-participating mode, a vanished session) is the daemon's own sentence,
 *  shown verbatim — a management surface that swallowed refusals would be the "shown but broken"
 *  shape this codebase keeps closing.
 *
 *  `background`/`clear`/`archive` report the daemon's POST-WRITE DERIVED activity, never the value
 *  asked for: clearing a session whose detached bash task is still writing comes back "background",
 *  and client.ts's own doc says to report this value. */
export async function runAgentVerb(
  client: AgentsVerbClient,
  verb: AgentVerb,
  row: { sessionId: string },
): Promise<AgentVerbResult> {
  // No RPC at all: "open" is a hand-off, not a command. The roster deliberately does not attach or
  // spawn a session view of its own — it prints the invocation and lets the user run it.
  if (verb === "open") return { message: agentResumeCommand(row.sessionId), changed: false };
  try {
    if (verb === "stop") {
      const { wasRunning } = await client.interrupt(row.sessionId);
      return {
        message: wasRunning ? `${row.sessionId} stopped` : `${row.sessionId}: nothing was running`,
        changed: wasRunning,
      };
    }
    // The RPC's own three-valued write surface: the two settable flags, or `null` to clear BOTH
    // back to purely derived. `active`/`idle` are DERIVED states and deliberately not writable —
    // which is why this is narrower than `SessionActivity` and needs no cast.
    const activity: "background" | "archived" | null =
      verb === "background" ? "background" : verb === "archive" ? "archived" : null;
    const res = await client.sessionSetActivity({ sessionId: row.sessionId, activity });
    return { message: `${row.sessionId} → ${res.activity ?? "(no lifecycle)"}`, changed: true };
  } catch (e) {
    return { message: `${row.sessionId}: ${(e as Error).message}`, changed: false };
  }
}

// ---------------------------------------------------------------------------------------------
// The runner — what main.ts's `case "agents"` is a thin wrapper around
// ---------------------------------------------------------------------------------------------

/** The roster's state holder: the poll and the event stream write into it, the Ink tree reads it.
 *  Framework-free on purpose (this module has no React), and it notifies only on a REAL change —
 *  `update` returning the same object is a no-op, which is what keeps an idempotent poll from
 *  repainting the terminal every 2 seconds. */
export class AgentsStore {
  private state: AgentsState = emptyAgentsState();
  private listeners = new Set<() => void>();
  get(): AgentsState { return this.state; }
  subscribe(fn: () => void): () => void { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  update(fn: (s: AgentsState) => AgentsState): void {
    const next = fn(this.state);
    if (next === this.state) return;
    this.state = next;
    for (const fn2 of this.listeners) fn2();
  }
}

/** Exactly what the roster asks of a daemon connection. `attach`/`send` are deliberately absent —
 *  see the module doc for why a roster that attached would be a bug, not a feature. */
export type AgentsRosterClient = AgentsVerbClient & Pick<NormaClient, "listSessions" | "close">;

export interface AgentsMountHandle {
  waitUntilExit(): Promise<void>;
  unmount(): void;
}

export type AgentsMount = (opts: { store: AgentsStore; onAction(action: AgentsAction): void }) => AgentsMountHandle;

export interface RunAgentsDeps {
  connect(clientName: string, onEvent: (event: { type?: string } & Record<string, unknown>) => void): Promise<AgentsRosterClient>;
  isTTY: boolean;
  log(line: string): void;
  mount: AgentsMount;
  now?(): number;
  pollMs?: number;
}

/** `norma agents`, whole. Every dependency is injected for the reason at the top of this file:
 *  main.ts's `case` cannot be unit-tested, so the command's behaviour has to be provable here.
 *
 *  Poll AND subscribe, deliberately both: the transient carries every state CHANGE the instant it
 *  happens (including on sessions with nothing attached, which is what this task's core half
 *  delivered), while the poll is the authority on which rows exist and what they are called — a
 *  session created, titled or backgrounded before this process started has no event to replay. */
export async function runAgentsCommand(deps: RunAgentsDeps): Promise<void> {
  const now = deps.now ?? (() => Date.now());
  const pollMs = deps.pollMs ?? AGENTS_POLL_MS;
  const store = new AgentsStore();

  const client = await deps.connect(AGENTS_CLIENT_NAME, (event) => {
    if (!event || event.type !== "session_activity") return;
    const e = event as unknown as { sessionId: string; activity: string; ts: number };
    store.update((s) => applyActivityEvent(s, e, now()));
  });

  const refresh = async (): Promise<void> => {
    try {
      const { sessions } = await client.listSessions();
      store.update((s) => applySessionList(s, sessions as AgentSessionRow[], now()));
    } catch {
      // A daemon blip must not blank the roster: the last known rows are still the best answer we
      // have, and the next poll heals. (Losing the connection entirely surfaces as a stale view,
      // which the socket's own close will end.)
    }
  };
  await refresh();

  // Piped/redirected: print the roster once and exit. Same headless safety net `mountTui` has —
  // never render, never take over a terminal that isn't one. Makes `norma agents | grep …` work.
  if (!deps.isTTY) {
    for (const line of formatAgentsSnapshot(store.get(), now())) deps.log(line);
    client.close();
    return;
  }

  const timer = setInterval(() => { void refresh(); }, pollMs);
  let handle: AgentsMountHandle | undefined;
  /** The last `open` hand-off, re-printed after the tree comes down: a command you asked for in
   *  order to copy it is worthless if it dies with the frame it was rendered in (the
   *  `formatResumeHint`-after-unmount discipline main.ts already follows). */
  let lastOpen: string | undefined;

  const onAction = (action: AgentsAction): void => {
    if (action.kind === "quit") { handle?.unmount(); return; }
    if (action.kind === "move") { store.update((s) => moveSelection(s, action.delta)); return; }
    const row = selectedAgent(store.get());
    if (!row) { store.update((s) => withNotice(s, AGENTS_EMPTY_STATE)); return; }
    void runAgentVerb(client, action.verb, row).then((result) => {
      if (action.verb === "open") lastOpen = result.message;
      store.update((s) => withNotice(s, result.message));
      // Re-read immediately rather than waiting out the interval: the transient normally beats the
      // poll, but a REFUSED verb emits nothing at all, and the row's real state is worth confirming.
      if (result.changed) void refresh();
    });
  };

  handle = deps.mount({ store, onAction });
  await handle.waitUntilExit();
  clearInterval(timer);
  client.close();
  if (lastOpen) deps.log(lastOpen);
}
