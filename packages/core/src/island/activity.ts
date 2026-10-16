import type { SessionEvent } from "@yanlinglabs/winter-protocol";
import { TurnOriginPairer } from "../sessions/turn-origins";
import type { IslandClient, IslandHost, IslandSessionFacts } from "./registry";

// The Winter island's ACTIVITY (`docs/claude/island.md`, phase 2): what the Mac's island shows besides the cards that
// wait for an answer — no event stream the app holds covers every session, so the daemon watches them here.
//
//   - `computerUse`: the sessions driving ComputerV2 NOW — from the first `computer_v2` call of a turn to that turn's
//     end (never per script: a turn's scripts follow one another with the model's thinking between them, and the
//     island's pill must not blink in those gaps). The latest script's `title` and the apps it opens label it.
//   - `results`: a turn that ENDED WITH THE SESSION IDLE, waiting for the user — the last assistant text, cut short. A
//     turn end is held `RESULT_SETTLE_MS` first: another main turn starting meanwhile (a queued message, a fold, an
//     autonomous loop's next turn) means the session did not stop, and nothing is published. Turns another agent or
//     Dispatch started (`messaging`, `dispatch`) publish nothing — Dispatch reports its children itself.
//   - `watches`: every ARMED ComputerV2 wake trigger (`wakeWhen`), read from the wake registry itself.
//
// `island.activity` answers from here; `island.activityChanged` (bare, once per burst) tells the island clients to ask
// again. No timer runs unless a turn just ended while an island client is connected (one one-shot per such turn).

/** The ComputerV2 tool's names in a `tool_call` (the host name the projector strips to, and the plain name). */
const COMPUTER_V2_NAMES: ReadonlySet<string> = new Set(["computer_v2", "ComputerV2"]);
/** The projector's own pass-through `user_message` (never a host push; `turn-origins.ts`). */
const PROJECTOR_PASSTHROUGH_CLIENT = "winter";
/** Turn origins whose end is not shown — every door that starts a turn with nobody waiting on it: another agent's
 *  message (`messaging`), Dispatch's own child prompts (`dispatch`; Dispatch reports those itself, then wakes with a
 *  `dispatch-wake` turn whose end IS shown), a Workflow's `agent()` child (`workflow`, `daemon.ts`'s `runTurn`), a
 *  scheduled routine (`routine`, `routines/runner.ts`) and the embedded runtime's self-check (`embedded-probe`). The
 *  human doors (the app, the TUI, the phone, `-p`) and the wakes (`dispatch-wake`, `computer-wake`) are shown. */
export const ISLAND_NO_RESULT_ORIGINS: ReadonlySet<string> = new Set(["messaging", "dispatch", "workflow", "routine", "embedded-probe"]);
/** Sessions whose turns are never shown, whoever started them: a Workflow's children and scheduled routines'. */
function automatedSession(origin: string | undefined): boolean {
  return origin === "workflow-child" || origin === "routine" || origin?.startsWith("routine/") === true;
}

/** How long a turn end is held before it counts as "the session is idle, waiting for the user". */
export const ISLAND_RESULT_SETTLE_MS = 1_500;
/** How long a published result is listed (an island client that connects later shows only fresh ones itself). */
export const ISLAND_RESULT_TTL_MS = 10 * 60_000;
/** The most results held, the most sessions followed, and the longest summary. */
export const ISLAND_RESULTS_MAX = 32;
export const ISLAND_FOLLOWED_SESSIONS_MAX = 512;
export const ISLAND_RESULT_SUMMARY_MAX = 240;
/** A computer-use entry with no ComputerV2 call or result for this long is dropped, running or not (a turn end that
 *  never came, a child that died without one): a generous cap, past any script's 300 s timeout. */
export const ISLAND_CU_STALE_MS = 10 * 60_000;
/** The most apps a computer-use entry names, and the longest app name. */
const CU_APPS_MAX = 3;
const CU_APP_NAME_MAX = 40;
const CU_TITLE_MAX = 80;

export interface IslandWatchSource {
  sessionId: string;
  wakeId: string;
  condition: string;
  targetLabel: string;
  elementLabel?: string;
  armedAt: number;
  expiresAt: number;
}

export interface IslandComputerUseItem {
  sessionId: string;
  /** Epoch ms: the turn's first ComputerV2 call, and its latest event. */
  startedAt: number;
  lastAt: number;
  /** A script runs right now (false between two scripts of the turn). */
  running: boolean;
  /** The latest script's `title`, when it sent one. */
  title?: string;
  /** The apps (and sites) the latest script opens, in order, as names a person would say. */
  apps: string[];
  session: IslandSessionFacts;
  hosts: IslandHost[];
}

export interface IslandResultItem {
  /** Stable: the session and the `turn_completed`'s seq. */
  id: string;
  sessionId: string;
  /** The turn's last assistant text, on one line, cut to `ISLAND_RESULT_SUMMARY_MAX`. */
  summary: string;
  /** Epoch ms of the turn's end. */
  at: number;
  session: IslandSessionFacts;
  hosts: IslandHost[];
}

export interface IslandWatchItem extends IslandWatchSource {
  session: IslandSessionFacts;
}

export interface IslandActivitySnapshot {
  computerUse: IslandComputerUseItem[];
  results: IslandResultItem[];
  watches: IslandWatchItem[];
}

export interface IslandActivityDeps {
  facts(sessionId: string): IslandSessionFacts | undefined;
  hosts(sessionId: string): IslandHost[];
  /** Every armed wake trigger (the wake registry); absent when computer use is not built. */
  watches?(): IslandWatchSource[];
  /** The session still has a card waiting for an answer: its turn did not end idle. */
  hasPendingCard?(sessionId: string): boolean;
  now?(): number;
  settleMs?: number;
  /** Test seam: a one-shot timer; returns its cancel. */
  setTimer?(fn: () => void, ms: number): () => void;
}

interface CUEntry {
  startedAt: number;
  lastAt: number;
  running: Set<string>;
  title?: string;
  apps: string[];
}

interface Followed {
  pairer: TurnOriginPairer<string>;
  /** A main turn is open on the log. */
  open: boolean;
  origin?: string;
  /** The open turn's last main-thread assistant text. */
  lastText?: string;
  /** Bumped by every main `turn_started`: a settle that sees it moved publishes nothing. */
  generation: number;
  cancelSettle?: () => void;
}

const defaultTimer = (fn: () => void, ms: number): (() => void) => {
  const t = setTimeout(fn, ms);
  (t as { unref?: () => void }).unref?.();
  return () => clearTimeout(t);
};

export class IslandActivity {
  private readonly cu = new Map<string, CUEntry>();
  private readonly followed = new Map<string, Followed>();
  private readonly results = new Map<string, Omit<IslandResultItem, "session" | "hosts">>();
  private readonly clients = new Set<IslandClient>();
  private notifyScheduled = false;

  constructor(private readonly deps: IslandActivityDeps) {}

  addClient(client: IslandClient): void { this.clients.add(client); }
  removeClient(client: IslandClient): void { this.clients.delete(client); }

  /** Test seam: the turn ends waiting out their settle. */
  get settling(): number {
    let n = 0;
    for (const f of this.followed.values()) if (f.cancelSettle !== undefined) n++;
    return n;
  }

  private now(): number { return this.deps.now?.() ?? Date.now(); }

  /** Every appended event of every session (`SessionHub.addObserver`). */
  observe(event: SessionEvent): void {
    const main = (event as { threadId?: string }).threadId === "main";
    switch (event.type) {
      case "tool_call":
        if (COMPUTER_V2_NAMES.has(event.name)) this.cuCall(event.sessionId, event.callId, event.argsJson, event.ts);
        if (main) this.follow(event.sessionId).pairer.other();
        return;
      case "tool_result": {
        const e = this.cu.get(event.sessionId);
        if (e?.running.delete(event.callId) === true) { e.lastAt = event.ts; this.changed(); }
        if (main) this.follow(event.sessionId).pairer.other();
        return;
      }
      case "wake_armed":
      case "wake_ended":
        this.changed();
        return;
      default:
        break;
    }
    if (!main) return;
    switch (event.type) {
      case "user_message":
        if (event.clientName !== PROJECTOR_PASSTHROUGH_CLIENT) this.follow(event.sessionId).pairer.message(event.clientName);
        return;
      case "turn_started": {
        const f = this.follow(event.sessionId);
        f.origin = f.pairer.turnStarted(f.open);
        if (!f.open) f.lastText = undefined;
        f.open = true;
        f.generation += 1;
        f.cancelSettle?.();
        f.cancelSettle = undefined;
        // The session moved on: its last result is no longer the news.
        if (this.dropResultsOf(event.sessionId)) this.changed();
        return;
      }
      case "assistant_message": {
        const f = this.follow(event.sessionId);
        f.pairer.other();
        const text = event.text.trim();
        if (text.length > 0) f.lastText = text;
        return;
      }
      case "agent_error":
        // The turn failed (a provider error, the runtime child died): its computer use is over.
        this.followed.get(event.sessionId)?.pairer.other();
        if (this.cu.delete(event.sessionId)) this.changed();
        return;
      case "turn_completed": {
        const f = this.follow(event.sessionId);
        f.pairer.other();
        f.open = false;
        if (this.cu.delete(event.sessionId)) this.changed();
        this.turnEnded(event.sessionId, f, event.stopReason, event.seq, event.ts);
        return;
      }
      default:
        this.followed.get(event.sessionId)?.pairer.other();
        return;
    }
  }

  /** What the island shows besides its cards. Prunes stale computer-use entries and old results. */
  list(): IslandActivitySnapshot {
    const now = this.now();
    for (const [sid, e] of [...this.cu]) {
      if (now - e.lastAt > ISLAND_CU_STALE_MS) this.cu.delete(sid);
    }
    for (const [id, r] of [...this.results]) {
      if (now - r.at > ISLAND_RESULT_TTL_MS) this.results.delete(id);
    }
    const computerUse = [...this.cu].map(([sessionId, e]): IslandComputerUseItem => ({
      sessionId, startedAt: e.startedAt, lastAt: e.lastAt, running: e.running.size > 0,
      ...(e.title === undefined ? {} : { title: e.title }), apps: [...e.apps],
      session: this.factsOf(sessionId), hosts: this.hostsOf(sessionId),
    }));
    const results = [...this.results.values()].map((r): IslandResultItem => ({
      id: r.id, sessionId: r.sessionId, summary: r.summary, at: r.at,
      session: this.factsOf(r.sessionId), hosts: this.hostsOf(r.sessionId),
    }));
    let sources: IslandWatchSource[] = [];
    try { sources = this.deps.watches?.() ?? []; } catch { sources = []; }
    const watches = sources.map((w): IslandWatchItem => ({ ...w, session: this.factsOf(w.sessionId) }));
    return { computerUse, results, watches };
  }

  private factsOf(sid: string): IslandSessionFacts {
    try { return this.deps.facts(sid) ?? {}; } catch { return {}; }
  }

  private hostsOf(sid: string): IslandHost[] {
    try { return this.deps.hosts(sid); } catch { return []; }
  }

  private follow(sid: string): Followed {
    let f = this.followed.get(sid);
    if (f === undefined) {
      f = { pairer: new TurnOriginPairer<string>(), open: false, generation: 0 };
      this.followed.set(sid, f);
      while (this.followed.size > ISLAND_FOLLOWED_SESSIONS_MAX) {
        const oldest = this.followed.keys().next().value as string;
        this.followed.get(oldest)?.cancelSettle?.();
        this.followed.delete(oldest);
      }
    } else {
      // Most recently heard last, so the bound drops the quietest session.
      this.followed.delete(sid);
      this.followed.set(sid, f);
    }
    return f;
  }

  private cuCall(sid: string, callId: string, argsJson: string, ts: number): void {
    let e = this.cu.get(sid);
    if (e === undefined) {
      e = { startedAt: ts, lastAt: ts, running: new Set(), apps: [] };
      this.cu.set(sid, e);
    }
    e.running.add(callId);
    e.lastAt = ts;
    const label = computerV2Facts(argsJson);
    if (label.title === undefined) delete e.title; else e.title = label.title;
    // A script that names no app keeps the apps the turn already bound (the runtime keeps them between scripts).
    if (label.apps.length > 0) e.apps = label.apps;
    this.armStaleCheck();
    this.changed();
  }

  /** While anything is listed as using the computer, ONE one-shot at the oldest entry's stale time drops what went
   *  quiet and tells the clients (no timer otherwise). */
  private cancelStale?: () => void;
  private staleAt?: number;
  private armStaleCheck(): void {
    let oldest: number | undefined;
    for (const e of this.cu.values()) oldest = oldest === undefined ? e.lastAt : Math.min(oldest, e.lastAt);
    if (oldest === undefined) { this.cancelStale?.(); this.cancelStale = undefined; this.staleAt = undefined; return; }
    const at = oldest + ISLAND_CU_STALE_MS;
    if (this.cancelStale !== undefined && this.staleAt === at) return;
    this.cancelStale?.();
    this.staleAt = at;
    const setTimer = this.deps.setTimer ?? defaultTimer;
    this.cancelStale = setTimer(() => {
      this.cancelStale = undefined;
      this.staleAt = undefined;
      const before = this.cu.size;
      const now = this.now();
      for (const [sid, e] of [...this.cu]) if (now - e.lastAt > ISLAND_CU_STALE_MS) this.cu.delete(sid);
      if (this.cu.size !== before) this.changed();
      this.armStaleCheck();
    }, Math.max(0, at - this.now()) + 1);
  }

  private turnEnded(sid: string, f: Followed, stopReason: string, seq: number, ts: number): void {
    const text = f.lastText;
    f.lastText = undefined;
    // Shown only to an island client, only for a turn that ended normally with something said, and not for a turn
    // another agent or Dispatch's spawn started. An interrupted turn: the user stopped it (or it was stopped for them).
    if (this.clients.size === 0 || stopReason !== "end_turn" || text === undefined) return;
    if (f.origin !== undefined && ISLAND_NO_RESULT_ORIGINS.has(f.origin)) return;
    let origin: string | undefined;
    try { origin = this.deps.facts(sid)?.origin; } catch { origin = undefined; }
    if (automatedSession(origin)) return;
    const generation = f.generation;
    f.cancelSettle?.();
    const setTimer = this.deps.setTimer ?? defaultTimer;
    f.cancelSettle = setTimer(() => {
      f.cancelSettle = undefined;
      if (f.generation !== generation || f.open) return;
      try { if (this.deps.hasPendingCard?.(sid) === true) return; } catch { /* no card known */ }
      this.publish({ id: `${sid}:${seq}`, sessionId: sid, summary: islandResultSummary(text), at: ts });
    }, this.deps.settleMs ?? ISLAND_RESULT_SETTLE_MS);
  }

  private publish(r: Omit<IslandResultItem, "session" | "hosts">): void {
    this.dropResultsOf(r.sessionId);
    this.results.set(r.id, r);
    while (this.results.size > ISLAND_RESULTS_MAX) this.results.delete(this.results.keys().next().value as string);
    this.changed();
  }

  private dropResultsOf(sid: string): boolean {
    let dropped = false;
    for (const [id, r] of [...this.results]) {
      if (r.sessionId === sid) { this.results.delete(id); dropped = true; }
    }
    return dropped;
  }

  /** Tells every island client, once per burst (one microtask). */
  private changed(): void {
    this.armStaleCheck();
    if (this.clients.size === 0 || this.notifyScheduled) return;
    this.notifyScheduled = true;
    queueMicrotask(() => {
      this.notifyScheduled = false;
      for (const c of [...this.clients]) {
        try { c.notifyActivity?.(); } catch { /* a dead connection's close() removes it */ }
      }
    });
  }
}

/** PURE: the last assistant text as a result card's summary — markdown marks dropped, one line, cut short. */
export function islandResultSummary(text: string): string {
  const plain = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/^\s{0,3}(#{1,6}|[-*+]|\d+[.)])\s+/gm, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  if (plain.length <= ISLAND_RESULT_SUMMARY_MAX) return plain;
  return `${plain.slice(0, ISLAND_RESULT_SUMMARY_MAX - 1).trimEnd()}…`;
}

const APPS_OPEN = /\bapps\s*\.\s*open\s*\(\s*(["'`])([^"'`\\\n$]{1,120})\1/g;
const BROWSERS_OPEN = /\bbrowsers\s*\.\s*(?:open|read)\s*\(\s*(["'`])([^"'`\\\n$]{1,300})\1/g;
const LABEL_SCAN = 16_000;

/** PURE: what a ComputerV2 call's arguments say about it — its `title`, and the apps (names, from bundle ids and
 *  `.app` paths too) and sites its script opens, in order. Untrusted text: only scanned, bounded. */
export function computerV2Facts(argsJson: string): { title?: string; apps: string[] } {
  let args: { title?: unknown; code?: unknown } = {};
  try { args = JSON.parse(argsJson) as typeof args; } catch { /* a partial or odd call */ }
  const out: { title?: string; apps: string[] } = { apps: [] };
  if (typeof args.title === "string") {
    const title = args.title.split(/\s+/).filter((w) => w.length > 0).join(" ");
    if (title.length > 0) out.title = title.slice(0, CU_TITLE_MAX);
  }
  const code = typeof args.code === "string" ? args.code.slice(0, LABEL_SCAN) : "";
  const found: { at: number; name: string }[] = [];
  for (const m of code.matchAll(APPS_OPEN)) {
    const name = appDisplayName(m[2]!);
    if (name !== undefined) found.push({ at: m.index ?? 0, name });
  }
  for (const m of code.matchAll(BROWSERS_OPEN)) {
    try {
      const host = new URL(m[2]!.trim()).host;
      if (host.length > 0) found.push({ at: m.index ?? 0, name: host.slice(0, CU_APP_NAME_MAX) });
    } catch { /* not a URL */ }
  }
  const seen = new Set<string>();
  for (const f of found.sort((a, b) => a.at - b.at)) {
    if (seen.has(f.name.toLowerCase())) continue;
    seen.add(f.name.toLowerCase());
    out.apps.push(f.name);
    if (out.apps.length >= CU_APPS_MAX) break;
  }
  return out;
}

function appDisplayName(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  const cut = (s: string): string => (s.length > CU_APP_NAME_MAX ? `${s.slice(0, CU_APP_NAME_MAX - 1)}…` : s);
  if (trimmed.endsWith(".app")) {
    const base = trimmed.split("/").pop()!.replace(/\.app$/, "");
    return base.length === 0 ? undefined : cut(base);
  }
  const labels = trimmed.split(".");
  if (labels.length >= 3 && labels.every((l) => /^[A-Za-z0-9_-]+$/.test(l))) return cut(labels[labels.length - 1]!);
  return cut(trimmed);
}
