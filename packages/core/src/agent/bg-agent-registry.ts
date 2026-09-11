import { buildChildAddress, buildSessionAddress, serializeRuntimeAddress } from "@yanlinglabs/winter-agent-sdk/messaging";
import type { GlobalAgentMessage } from "@yanlinglabs/winter-agent-sdk/messaging";
import type { SessionMessagingFacet } from "@yanlinglabs/winter-agent-sdk";
import type { ChildProfiles, ChildStatus, PersistedWinterChild, RuntimeChildren } from "../runtime-state/children";
import type { SessionApprovalPolicy } from "./gate";

/**
 * BackgroundAgentRegistry — pure state tracker for detached (async) subagent
 * threads. Foundation for `run_in_background` on spawn_agent.
 *
 * Unlike BackgroundTaskRegistry (bg-registry.ts, which owns a ChildProcess +
 * output ring for backgrounded bash), this registry holds AGENT threads: the
 * child thread's live output already streams as ordinary thread events, so
 * there is nothing to buffer here — just lifecycle (running → terminal) and
 * the final result string. No process/thread spawning happens in this file;
 * the engine drives runThread and reports back via complete()/stop().
 *
 * Map-backed, never throws: every method is a total function over whatever
 * state exists (unknown ids are no-ops / undefined / false, never errors).
 */

// 4h-ii-c: "timeout" — a bg spawn whose SubagentManager.run() call rejected via its own clock
// (SubagentResult.timedOut:true) reports distinctly from a generic "failed", so a client can
// render/handle "timed out" separately from "errored". TERMINAL like completed/failed/stopped:
// takeForNotification surfaces it (unnotified), reopen() accepts it, stop() rejects it — see
// each method's own doc comment; none needed a code change for the new status, since all three
// already key off "running" vs. "not running" rather than an enumerated terminal set.
// P8b Task 13: `interrupted` joins the union. It is WS-16 §12's "interrupted/recoverable" — what a
// `running` child becomes at the next boot once the caller has PROVEN its process/thread is gone.
// Deliberately NOT terminal in `PersistedWinterChild`'s sense (it stamps no `completedAt`) and
// deliberately not `stopped` (nobody stopped it), and every consumer here already branches on
// `"running"` versus everything else, so widening the union changes no behaviour — it only stops an
// interrupted child being reported as a generic failure.
export type AgentStatus = "running" | "interrupted" | "completed" | "failed" | "stopped" | "timeout";

/**
 * Everything a future `resume` (4h-ii-b Task 3) needs to re-run this child thread EXCEPT its
 * `input` (the resume message itself, supplied by the resume caller) and `signal` (freshly
 * minted per resume attempt, never reused across runs). Captured by the spawn bridge
 * (engine.ts) at spawn time — for BOTH the synchronous and `run_in_background` paths — from the
 * exact values it already computed to start the child's own live run, so resume replays the
 * SAME agentType/cwd/roots/policy/model/instructions/maxTurns the original spawn used, not a
 * re-derived guess.
 */
export interface ResumeContext {
  agentType?: string;
  cwd: string;
  roots?: string[];
  approvalPolicy: SessionApprovalPolicy;
  model?: string;
  instructions: string;
  maxTurns?: number;
  // 4h-ii-b Task 3 (D5) — additive: the rest of what resume needs, CAPTURED at spawn (not
  // re-derived at resume, which risks divergence — e.g. agents.resolve() re-run against a
  // different cwd could pick a different local agent-def). `openingPrompt` is the child's ORIGINAL
  // spawn prompt, which the fresh spawn never persisted as a child event (it went straight into
  // runThread's in-memory input), so resume must prepend it by hand. `depth`/`loaded`/
  // `excludeTools`/`allowTools` are the exact runThread args the original spawn computed, snapshotted
  // to arrays here (Set → Array) so the ResumeContext stays a plain, structurally-clonable value.
  openingPrompt: string;
  description?: string;
  depth: number;
  loaded: string[];
  excludeTools: string[];
  allowTools?: string[];
}

export interface AgentEntry {
  agentId: string;
  sessionId: string;
  threadId: string;
  name?: string;
  status: AgentStatus;
  result?: string;
  startedAt: number;
  notified: boolean;
  abort: AbortController;
  // Optional/additive (4h-ii-b Task 1): absent for any entry registered before this field
  // existed (or by a caller that never builds a ResumeContext) — resume (T3) must treat a
  // missing `resume` as "not resumable", never assume it's present.
  resume?: ResumeContext;
}

export interface RegisterInput {
  agentId: string;
  sessionId: string;
  threadId: string;
  name?: string;
  /** The local controller for a child THIS process runs. Absent for a Winter child (Task 17): the
   *  child belongs to its session's `winter` process, so `stop()` asks through the owning session's
   *  messaging facet (`steerChild`) instead of aborting anything locally. */
  abort?: AbortController;
  resume?: ResumeContext;
}

export type RegisterResult = { ok: true } | { ok: false; error: string };

/** CC v2.1.199 parity: the stale agent-name guard's pure decision. Given the agentId a `name`
 *  PREVIOUSLY, successfully reached (`recorded` — undefined if this is the first time this
 *  (sessionId, name) pair is used) and the agentId THIS by-name resolution just found
 *  (`resolvedAgentId`), decides whether the caller may proceed. A `name` is a stable per-session
 *  handle a model uses to refer to an agent across several turns; if it were ever possible for that
 *  name to resolve to a DIFFERENT agent later (today's `register()` rejects a name collision
 *  outright, so this can't happen through the public API yet — this guard is defense-in-depth for
 *  any future name-reuse/eviction feature), a stale model reference would silently reach the WRONG
 *  agent. Exported and pure so it's unit-testable without a live registry. */
export type NameResolution = { ok: true } | { ok: false; error: string };
export function checkNameNotStale(recorded: string | undefined, resolvedAgentId: string, name: string): NameResolution {
  if (recorded !== undefined && recorded !== resolvedAgentId) {
    return {
      ok: false,
      error: `name '${name}' now reaches a different agent (${resolvedAgentId}); it previously reached ${recorded}. Address the agent by ID instead.`,
    };
  }
  return { ok: true };
}

/** child-transcript-view T1: applies the stale-name guard to an ALREADY-RESOLVED entry — factors
 *  out the exact 5 lines that were duplicated across the send_message tool bridge (engine.ts) and
 *  the task_stop tool (task-stop.ts), so a THIRD/FOURTH caller (AgentEngine.sendToAgent/stopAgent,
 *  backing the thread.send/agent.stop RPCs) doesn't duplicate it a third time. Callers still call
 *  `bgAgents.get(idOrName, sessionId)` themselves first — "not found" handling differs per caller
 *  (task_stop falls through to a background BASH task lookup before erroring; the RPCs and the
 *  send_message bridge just error with their own wording) — only the FOUND+guard branch, which is
 *  byte-identical everywhere, is shared here. A by-ID resolution (`idOrName === entry.agentId`)
 *  bypasses the guard entirely, same precedent as every existing caller. */
export function guardAgentName(
  // P8b Task 13: STRUCTURAL, not the class. The persisted registry answers the same two questions
  // from a durable sink, and the guard's four call sites (the send_message bridge, task_stop, and
  // the thread.send/agent.stop RPCs) must not each learn which implementation they were handed.
  bgAgents: Pick<AgentRegistry, "firstReached" | "recordReached">,
  sessionId: string,
  idOrName: string,
  entry: AgentEntry,
): NameResolution {
  if (idOrName === entry.agentId) return { ok: true };
  const check = checkNameNotStale(bgAgents.firstReached(sessionId, idOrName), entry.agentId, idOrName);
  if (!check.ok) return check;
  bgAgents.recordReached(sessionId, idOrName, entry.agentId);
  return { ok: true };
}

/**
 * What every consumer of the background-agent roster actually needs (P8b Task 13, C-12).
 *
 * TWO IMPLEMENTATIONS, ONE CONTRACT: `BackgroundAgentRegistry` (in-memory, this file, what the
 * daemon used when the 8a spine could not open) and `createPersistedChildren` (below, over
 * `runtime-state`'s `runtime_children` table plus its child profiles). Every call site — the
 * engine's spawn bridge, `task_stop`, `agent_list`/`agent_output`, the `thread.send`/`agent.stop`
 * RPCs — takes this type, so Task 17 deletes the engine without any of them moving.
 */
export interface AgentRegistry {
  firstReached(sessionId: string, name: string): string | undefined;
  recordReached(sessionId: string, name: string, agentId: string): void;
  register(e: RegisterInput): RegisterResult;
  complete(agentId: string, outcome: { ok: boolean; result: string }, opts?: { notified?: boolean; timedOut?: boolean }): void;
  reopen(agentId: string, abort: AbortController): boolean;
  stop(agentId: string): boolean;
  get(idOrName: string, sessionId?: string): AgentEntry | undefined;
  list(sessionId: string): AgentEntry[];
  takeForNotification(agentId: string): AgentEntry | undefined;
  /**
   * Claim the completion notice WITHOUT reading the entry back.
   *
   * ⚠️ THE REASON THIS EXISTS AT ALL: `task_stop` used to write `entry.notified = true` on the
   * object `get()` returned, which worked only because that object WAS the map's live row. A
   * persisted registry materialises its entries from a table, so the same line would set a field on
   * a copy and the notice would re-surface on a later turn — leaking a stopped child's raw result
   * into a turn that never asked for it. A method cannot be got wrong that way.
   */
  markNotified(agentId: string): void;
  /**
   * "This child made progress" — the resettable window behind the no-wall-clock rule (CLAUDE.md;
   * Norma map §10). A no-op on the in-memory registry, whose children are watched by
   * `SubagentManager` instead.
   */
  progress(agentId: string): void;
}

export class BackgroundAgentRegistry implements AgentRegistry {
  private agents = new Map<string, AgentEntry>();
  // Stale-name guard bookkeeping (checkNameNotStale above): plain storage ONLY — the actual
  // refuse-or-proceed DECISION is made by each caller (engine.ts's send_message bridge,
  // task-stop.ts's tool), never here, so a read-only resolver (agent_output/agent_list) that never
  // calls firstReached/recordReached is completely unaffected by this guard. Keyed
  // `${sessionId} ${name}` — never cleared, matching this registry's own agents map lifetime
  // (process/daemon lifetime, no session-scoped teardown exists today).
  private nameReach = new Map<string, string>();

  /** The agentId this (sessionId, name) pair previously, successfully reached — undefined if
   *  never recorded. Callers check this via `checkNameNotStale` BEFORE acting on a by-name
   *  resolution. */
  firstReached(sessionId: string, name: string): string | undefined {
    return this.nameReach.get(`${sessionId} ${name}`);
  }

  /** Records `agentId` as the (possibly first) agentId this (sessionId, name) pair reached. Callers
   *  call this only AFTER `checkNameNotStale` confirms there's no conflicting prior record. */
  recordReached(sessionId: string, name: string, agentId: string): void {
    this.nameReach.set(`${sessionId} ${name}`, agentId);
  }

  /**
   * Registers a new running entry. Rejects (never throws) two cases:
   *  - `agentId` already registered (covers re-registering the same
   *    agentId, whether or not the name also matches — re-registration is
   *    always a caller bug, not a name-reuse question).
   *  - `name` already resolves to a DIFFERENT agentId in the same session
   *    (CC-style: a background-agent name must be unique per session so
   *    `get()` by name is unambiguous).
   */
  register(e: RegisterInput): RegisterResult {
    if (this.agents.has(e.agentId)) {
      return { ok: false, error: `agent '${e.agentId}' is already registered` };
    }
    if (e.name) {
      const existing = this.findByName(e.sessionId, e.name);
      if (existing) {
        return { ok: false, error: `name '${e.name}' already in use by agent ${existing.agentId}` };
      }
    }
    this.agents.set(e.agentId, {
      agentId: e.agentId,
      sessionId: e.sessionId,
      threadId: e.threadId,
      name: e.name,
      status: "running",
      startedAt: Date.now(),
      notified: false,
      abort: e.abort ?? new AbortController(),
      resume: e.resume,
    });
    return { ok: true };
  }

  /** running → completed|failed|timeout, stores the result. No-op if unknown or already terminal.
   *  `opts.notified` (4h-ii-b Task 1): set `true` for a SYNC spawn's own completion — the
   *  synchronous caller already received this result directly as its tool_result, in the SAME
   *  turn, so `takeForNotification`'s later claim (bg-retrigger Task 1: engine.ts's
   *  `notifyBgCompletion`, built for `run_in_background`'s DETACHED completions) must
   *  never re-surface it on a future turn — that would leak the child's raw result text into a
   *  turn that never asked for it (Seam #1: a child's internal output must stay scoped to its own
   *  turn). Omitted/false (the `run_in_background` path's own call site) is unchanged: a bg
   *  completion starts unnotified so the claim picks it up exactly once.
   *  `opts.timedOut` (4h-ii-c): set `true` when this completion is reporting a
   *  SubagentResult.timedOut:true (the child's own SubagentManager.run() call hit its clock) —
   *  status becomes `"timeout"` instead of the outcome.ok-derived completed/failed, so a timed-
   *  out child is never misreported as a generic failure. Omitted/false is unchanged. */
  complete(agentId: string, outcome: { ok: boolean; result: string }, opts?: { notified?: boolean; timedOut?: boolean }): void {
    const e = this.agents.get(agentId);
    if (!e || e.status !== "running") return;
    e.status = opts?.timedOut ? "timeout" : outcome.ok ? "completed" : "failed";
    e.result = outcome.result;
    if (opts?.notified) e.notified = true;
  }

  /**
   * 4h-ii-b Task 3 (D3): re-admits an already-registered TERMINAL entry so `resume` (engine.ts's
   * spawn bridge) can re-run its child thread. `register()` REJECTS a known agentId (re-
   * registration is a caller bug there), so resume needs this dedicated re-open path instead.
   *
   * If the entry exists AND is terminal (completed/failed/stopped/timeout): flips status → running, clears
   * the stale `result`, resets `notified` to false (so the resumed run's OWN completion notice
   * re-fires — CC parity: a resumed agent that finishes again notifies again), and swaps in the
   * resume attempt's fresh AbortController (`abort` is never reused across runs). Returns true.
   *
   * If missing, or already running, returns false and does nothing — both cases the bridge already
   * guards (unknown → "no agent to resume"; running → "still running, use send_message"), so a
   * false here is purely defensive. A reopened (now-running) entry is naturally excluded from
   * `takeForNotification` again (its status is no longer terminal).
   */
  reopen(agentId: string, abort: AbortController): boolean {
    const e = this.agents.get(agentId);
    if (!e || e.status === "running") return false;
    e.status = "running";
    e.result = undefined;
    e.notified = false;
    e.abort = abort;
    return true;
  }

  /**
   * If running: fires `entry.abort.abort()`, flips status → stopped, returns true.
   * Otherwise (unknown id or already terminal) returns false and does nothing.
   * The abort signal's effect on the actual child thread (interrupting runThread)
   * is wired by the engine — this method only fires the controller + updates state.
   */
  stop(agentId: string): boolean {
    const e = this.agents.get(agentId);
    if (!e || e.status !== "running") return false;
    e.abort.abort();
    e.status = "stopped";
    return true;
  }

  /**
   * Looks up by agentId first; if not found (or found but scoped out of
   * `sessionId`), falls back to a by-name lookup (optionally scoped to
   * `sessionId`). An id that resolves to an entry in a DIFFERENT session
   * than the one requested returns undefined rather than falling through
   * to a name search on the same string.
   */
  get(idOrName: string, sessionId?: string): AgentEntry | undefined {
    const byId = this.agents.get(idOrName);
    if (byId) return !sessionId || byId.sessionId === sessionId ? byId : undefined;
    for (const e of this.agents.values()) {
      if (e.name === idOrName && (!sessionId || e.sessionId === sessionId)) return e;
    }
    return undefined;
  }

  /** All entries (running + terminal) for a session, in registration order. */
  list(sessionId: string): AgentEntry[] {
    return [...this.agents.values()].filter((e) => e.sessionId === sessionId);
  }

  /** Claims a terminal, not-yet-notified entry for completion-notice persistence: marks it
   *  notified:true and returns it. Unknown id, still running, or already notified → undefined.
   *  Single-consumer — at most one caller ever receives a given entry, which is what makes the
   *  persisted notification exactly-once. */
  takeForNotification(agentId: string): AgentEntry | undefined {
    const e = this.agents.get(agentId);
    if (!e || e.status === "running" || e.notified) return undefined;
    e.notified = true;
    return e;
  }

  /** The in-memory registry's entries ARE the map's rows, so this is the same write `task_stop`
   *  used to make by hand — kept as a method so both implementations share one contract. */
  markNotified(agentId: string): void {
    const e = this.agents.get(agentId);
    if (e) e.notified = true;
  }

  /** No watchdog here: this registry's children are engine threads, and `SubagentManager` owns
   *  their progress window (Norma map §10). Present so the two implementations share one type. */
  progress(_agentId: string): void {}

  private findByName(sessionId: string, name: string): AgentEntry | undefined {
    for (const e of this.agents.values()) {
      if (e.sessionId === sessionId && e.name === name) return e;
    }
    return undefined;
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// P8b Task 13 (C-12 / P8b-15): the SAME roster, over 8a's durable child store.
//
// WS-17 §8 row 6 is the proof row this exists for: "Winter child identity + `ResumeContext`
// reconstructed after daemon restart". `BackgroundAgentRegistry` is one `Map`, so a restart lost
// every child wholesale — the names a model was using, which of them had finished, and every
// `ResumeContext` that made `resume` possible at all. 8a shipped the replacement table
// (`runtime_children`) and the reclassification rule and wired it to nothing; this is the wiring.
//
// WHAT LIVES WHERE, and why it is three sinks rather than one:
//
//  * `runtime_children` (SQLite) — identity and outcome. Indexed, transactional, and the thing
//    `reclassifyAfterRestart` sweeps. Every column is WS-16 §12's "locator or effective fact".
//  * the child PROFILE (`runtime-state/children.ts`'s `ChildProfiles`) — the `ResumeContext`, the
//    `threadId`, the result text and the notified flag. A dozen fields of prompt and instruction
//    that have no business being columns, under the one tree the read tools are denied.
//  * `abort` (in memory, here) — an `AbortController` is the one thing §12 names as NEVER durable.
//    A restarted daemon holds none, which is exactly why the restart path is
//    `reclassifyAfterRestart(isGone)` and not "abort what was running".
//
// STOPPING A CHILD AFTER A RESTART IS A REQUEST, NOT A KILL. With no local `AbortController` the
// only door is the OWNING SESSION's messaging facet — `steerChild`, because "a child engine has no
// facet surface of its own" (surface map §9.2) and `resumeChild` is never the reverse of it. The
// facet is asynchronous and `stop()` is not, so the steer is fired and its failure logged: the
// registry's own state flips to `stopped` either way, which is what every caller reads.

/** The default progress window, identical to `SubagentManager`'s and to the Winter runtime's own
 *  `ASYNC_AGENT_STALL_TIMEOUT_MS` (surface map §9.3). There is deliberately NO wall clock. */
export const CHILD_STALL_TIMEOUT_MS = 600_000;

/** An injectable timer pair, so a test drives the watchdog instead of waiting ten minutes for it. */
export interface ChildTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface PersistedChildrenDeps {
  store: RuntimeChildren;
  profiles: ChildProfiles;
  /** The provider this daemon is configured with — the child's POST-inheritance resolution. */
  providerId: () => string;
  /** The catalog row key the child ran on, when the caller knows one. */
  modelRef?: (input: RegisterInput) => string | undefined;
  versions?: { catalog: string; adapter: string };
  /**
   * The owning session's live messaging facet — `task_stop`'s only door to a child this process did
   * not spawn. Absent (nothing attached, or the session has since ended) means a stop is recorded
   * and nothing is asked of the child, which is the honest outcome rather than a pretended kill.
   */
  facetFor?: (sessionId: string) => SessionMessagingFacet | undefined;
  /**
   * ⚠️ ARMING IS OPT-IN, AND OMITTING THIS DEP IS THE SHIPPED DAEMON'S ANSWER (fix round 1, F1).
   *
   * `SubagentManager` already owns a RESETTABLE progress window for every engine child, fed from
   * `runThread`'s one chokepoint, and its `AbortController` is folded into the child's run signal on
   * both spawn paths. A second timer over the same children is not a second safety net, it is a
   * second killer — and while this registry's own window was armed unconditionally it was a 600 s
   * WALL CLOCK, because nothing in production reset it. That is the exact shape CLAUDE.md's tool
   * surface forbids ("subagents with no wall-clock timeout — a progress-stall watchdog instead").
   *
   * So: dep ABSENT ⇒ no timer is ever armed and `progress()` is bookkeeping only, which is what
   * `daemon.ts` passes while the engine still runs children. Dep PRESENT ⇒ the window is live and
   * resettable: the getter is re-read at every arm (`settings.subagents.stallTimeoutMs` is hot),
   * `undefined` from it means the 600 s default, and `null`/`0` disables it. Task 17 turns it on
   * for Winter children when `SubagentManager` retires with the engine.
   */
  stallTimeoutMs?: () => number | null | undefined;
  timers?: ChildTimers;
  now?: () => number;
  log?: (line: string) => void;
}

const REAL_TIMERS: ChildTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/** `AgentStatus` and `ChildStatus` are the same union since Task 13 widened the former; this is the
 *  assertion that says so at the one place they meet. */
const asAgentStatus = (s: ChildStatus): AgentStatus => s;

export function createPersistedChildren(deps: PersistedChildrenDeps): AgentRegistry {
  const timers = deps.timers ?? REAL_TIMERS;
  const now = deps.now ?? (() => Date.now());
  const versions = deps.versions ?? { catalog: "unstated", adapter: "unstated" };
  /** childId → the live `AbortController`, for children THIS process spawned. Never durable. */
  const aborts = new Map<string, AbortController>();
  /** childId → the armed stall timer. Disarmed by every terminal transition. */
  const watch = new Map<string, unknown>();
  /** childId → parent, for the id-only lookups a caller may still make. Warmed by `register`; the
   *  table's own `locate()` answers for anything this process did not spawn. */
  const parentOf = new Map<string, string>();

  const log = deps.log ?? (() => {});

  /**
   * ⚠️ THE CONTRACT THE IN-MEMORY REGISTRY HAD FOR FREE, AND THIS ONE HAS TO EARN.
   *
   * `BackgroundAgentRegistry`'s own header promises "never throws: every method is a total function
   * over whatever state exists" — trivially true of a `Map`. This implementation reads SQLite and a
   * filesystem, and its callers are the agent loop: `engine.ts`'s `runTurn` asks `list(sessionId)`
   * on every round to decide whether to pin `task_stop`. Found by the suite rather than by reasoning
   * — a daemon whose runtime-state handle had already been closed at teardown raised
   * `RangeError: Cannot use a closed database` straight out of the middle of a turn.
   *
   * So every door answers the EMPTY answer on a broken store, and the failure is logged once per
   * call rather than propagated: a child roster that cannot be read costs child routing, never the
   * turn that happened to ask about it.
   */
  const tryOr = <T>(what: string, fn: () => T, fallback: T): T => {
    try {
      return fn();
    } catch (err) {
      log(`${what} failed (${err instanceof Error ? err.name : "unknown"}); answering as if there were no such child`);
      return fallback;
    }
  };

  const parentFor = (childId: string, sessionId?: string): string | undefined => {
    if (sessionId !== undefined) return sessionId;
    const known = parentOf.get(childId);
    if (known !== undefined) return known;
    const located = tryOr("children.locate", () => deps.store.locate(childId), []);
    // Ambiguous by construction: two parents may mint the same childId, and answering about the
    // wrong one is the confusion `ChildRef` exists to prevent. One match is an answer; more is not.
    return located.length === 1 ? located[0]!.parent : undefined;
  };

  const toEntry = (child: PersistedWinterChild): AgentEntry => {
    const profile = tryOr("children.profile", () => deps.profiles.read(child.parentWinterSessionId, child.childId), undefined);
    return {
      agentId: child.childId,
      sessionId: child.parentWinterSessionId,
      threadId: profile?.threadId ?? child.transcriptRef,
      ...(child.name === undefined ? {} : { name: child.name }),
      status: asAgentStatus(child.status),
      ...(profile?.result === undefined ? {} : { result: profile.result }),
      startedAt: Date.parse(child.startedAt),
      notified: profile?.notified ?? false,
      // A restarted daemon owns no controller for a child it did not spawn. A fresh, unfired one
      // keeps every `entry.abort.signal` reader working and is honest: aborting it stops nothing,
      // which is why `stop()` goes through the facet rather than through here.
      abort: aborts.get(child.childId) ?? new AbortController(),
      ...(profile?.resume === undefined ? {} : { resume: profile.resume }),
    };
  };

  const row = (parent: string, childId: string): PersistedWinterChild | undefined =>
    tryOr("children.get", () => deps.store.get(parent, childId), undefined);

  const read = (parent: string, childId: string): AgentEntry | undefined => {
    const child = row(parent, childId);
    return child === undefined ? undefined : toEntry(child);
  };

  const disarm = (childId: string): void => {
    const handle = watch.get(childId);
    if (handle !== undefined) {
      timers.clear(handle);
      watch.delete(childId);
    }
  };

  /**
   * The progress-stall watchdog (CLAUDE.md's invariant: no wall clock, a resettable progress window).
   *
   * ONE-SHOT AND SELF-DISARMING, which is what makes it safe to run BESIDE `SubagentManager`'s while
   * the engine still lives: whichever fires first makes the child terminal, and `complete()` is a
   * no-op on a child that is no longer running. So the pair cannot double-report, in either order.
   */
  const arm = (parent: string, childId: string): void => {
    disarm(childId);
    // Opt-in (F1). No dep ⇒ this registry watches nothing and never aborts anybody.
    if (deps.stallTimeoutMs === undefined) return;
    const configured = deps.stallTimeoutMs();
    const ms = configured === undefined ? CHILD_STALL_TIMEOUT_MS : configured;
    if (ms === null || ms === 0 || !Number.isFinite(ms) || ms < 0) return;
    watch.set(
      childId,
      timers.set(() => {
        watch.delete(childId);
        log(`child ${childId} of ${parent}: no progress for ${Math.round(ms / 1000)}s — stopped`);
        aborts.get(childId)?.abort();
        registry.complete(childId, { ok: false, result: `stalled: no progress for ${Math.round(ms / 1000)}s` }, { timedOut: true });
      }, ms),
    );
  };

  /** A stop envelope the owning session's facet can carry. Norma sends no body the model wrote —
   *  this is a control instruction, and it is attributed to the parent session itself. */
  const stopEnvelope = (parent: string, childId: string): GlobalAgentMessage => ({
    messageId: `stop:${encodeURIComponent(parent)}:${encodeURIComponent(childId)}:${now()}`,
    from: buildSessionAddress(parent),
    fromGeneration: 0,
    to: buildChildAddress(parent, childId),
    toGeneration: 0,
    body: "Stop what you are doing and end this turn now. Report what you completed; start nothing new.",
    summary: "stop requested",
    notifyWhenIdle: false,
    createdAt: now(),
    expiresAt: now() + 60_000,
    hopCount: 0,
    senderPermissionClass: "prompts",
  });

  const registry: AgentRegistry = {
    firstReached(sessionId: string, name: string): string | undefined {
      return tryOr("children.reach", () => deps.profiles.reach(sessionId)[name], undefined);
    },

    recordReached(sessionId: string, name: string, agentId: string): void {
      tryOr("children.reach write", () => deps.profiles.recordReach(sessionId, name, agentId), undefined);
    },

    register(e: RegisterInput): RegisterResult {
      // Both refusals are `BackgroundAgentRegistry`'s, verbatim, including their wording: a model
      // that has learned what "already in use" means must not meet a new sentence for it.
      if (row(e.sessionId, e.agentId) !== undefined) {
        return { ok: false, error: `agent '${e.agentId}' is already registered` };
      }
      if (e.name) {
        const existing = tryOr("children.findByName", () => deps.store.findByName(e.name!, e.sessionId), []).find((c) => c.childId !== e.agentId);
        if (existing) {
          return { ok: false, error: `name '${e.name}' already in use by agent ${existing.childId}` };
        }
      }
      const startedAt = new Date(now()).toISOString();
      try {
        deps.store.upsert({
          parentWinterSessionId: e.sessionId,
          childId: e.agentId,
          ...(e.name === undefined ? {} : { name: e.name }),
          agentType: e.resume?.agentType ?? "general-purpose",
          providerId: deps.providerId(),
          modelRef: deps.modelRef?.(e) ?? e.resume?.model ?? "unstated",
          providerCatalogVersion: versions.catalog,
          providerAdapterVersion: versions.adapter,
          status: "running",
          transcriptRef: e.threadId,
          resumeContextRef: deps.profiles.refFor(e.sessionId, e.agentId),
          startedAt,
          generation: 1,
          ...(e.resume?.model === undefined ? {} : { requestedModel: e.resume.model }),
        });
      } catch (err) {
        // A refusal from the store (a terminal row being pushed back to running) is a REFUSAL here
        // too, never a throw out of a registration the caller expected a boolean from.
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
      tryOr(
        "children.profile write",
        () =>
          deps.profiles.write(e.sessionId, e.agentId, {
            threadId: e.threadId,
            notified: false,
            ...(e.resume === undefined ? {} : { resume: e.resume }),
          }),
        undefined,
      );
      if (e.abort !== undefined) aborts.set(e.agentId, e.abort);
      parentOf.set(e.agentId, e.sessionId);
      arm(e.sessionId, e.agentId);
      return { ok: true };
    },

    complete(agentId, outcome, opts): void {
      const parent = parentFor(agentId);
      if (parent === undefined) return;
      const child = row(parent, agentId);
      if (child === undefined || child.status !== "running") return;
      disarm(agentId);
      tryOr("children.setStatus", () => deps.store.setStatus(parent, agentId, opts?.timedOut ? "timeout" : outcome.ok ? "completed" : "failed"), undefined);
      tryOr("children.profile patch", () => deps.profiles.patch(parent, agentId, { result: outcome.result, ...(opts?.notified ? { notified: true } : {}) }), undefined);
      aborts.delete(agentId);
    },

    reopen(agentId, abort): boolean {
      const parent = parentFor(agentId);
      if (parent === undefined) return false;
      const child = row(parent, agentId);
      if (child === undefined || child.status === "running") return false;
      // `interrupted` is resumable for exactly the same reason every other non-running status is —
      // the child is not going to make progress on its own, and the caller has a fresh controller.
      tryOr("children.setStatus", () => deps.store.setStatus(parent, agentId, "running"), undefined);
      tryOr("children.profile patch", () => deps.profiles.patch(parent, agentId, { result: undefined, notified: false }), undefined);
      aborts.set(agentId, abort);
      parentOf.set(agentId, parent);
      arm(parent, agentId);
      return true;
    },

    stop(agentId): boolean {
      const parent = parentFor(agentId);
      if (parent === undefined) return false;
      const child = row(parent, agentId);
      if (child === undefined || child.status !== "running") return false;
      disarm(agentId);
      const local = aborts.get(agentId);
      if (local !== undefined) {
        local.abort();
      } else {
        // No controller: this child belongs to a session this process did not spawn (a restart), so
        // the owning session's facet is the only door — and it is a steer, never a kill.
        // Inside `tryOr` like every other host call: the daemon's `facetFor` does a synchronous
        // SQLite read and then builds an address, and `UnaddressableEntryError` out of a
        // non-canonical backend id would otherwise escape a `stop()` that promises never to throw.
        const facet = tryOr("children.facet", () => deps.facetFor?.(parent), undefined);
        if (facet === undefined) {
          log(`child ${agentId} of ${parent}: stopped in the roster, but no live owner to ask (nothing was interrupted)`);
        } else {
          void Promise.resolve(facet.steerChild(agentId, stopEnvelope(parent, agentId))).then(
            (outcome) => {
              if (outcome.status !== "delivered" && outcome.status !== "queued") {
                log(`child ${agentId} of ${parent}: the stop request answered ${outcome.status}`);
              }
            },
            (err: unknown) => log(`child ${agentId} of ${parent}: the stop request failed (${err instanceof Error ? err.name : "unknown"})`),
          );
        }
      }
      tryOr("children.setStatus", () => deps.store.setStatus(parent, agentId, "stopped"), undefined);
      aborts.delete(agentId);
      return true;
    },

    get(idOrName, sessionId): AgentEntry | undefined {
      const parent = parentFor(idOrName, sessionId);
      if (parent !== undefined) {
        const byId = read(parent, idOrName);
        if (byId) return byId;
      }
      const named = tryOr("children.findByName", () => deps.store.findByName(idOrName, sessionId), []);
      // Unscoped, a name is ambiguous exactly as a bare child id is: the same name in two sessions
      // is legal and always has been, so an unscoped lookup answers only when there is ONE match
      // rather than picking somebody else's child (F7).
      if (sessionId === undefined && named.length !== 1) return undefined;
      return named[0] === undefined ? undefined : toEntry(named[0]);
    },

    list(sessionId): AgentEntry[] {
      return tryOr("children.list", () => deps.store.list(sessionId), []).map(toEntry);
    },

    takeForNotification(agentId): AgentEntry | undefined {
      const parent = parentFor(agentId);
      if (parent === undefined) return undefined;
      const child = row(parent, agentId);
      if (child === undefined || child.status === "running") return undefined;
      const profile = tryOr("children.profile", () => deps.profiles.read(parent, agentId), undefined);
      if (profile?.notified === true) return undefined;
      tryOr("children.profile patch", () => deps.profiles.patch(parent, agentId, { notified: true }), undefined);
      return toEntry(child);
    },

    markNotified(agentId): void {
      const parent = parentFor(agentId);
      if (parent === undefined) return;
      tryOr("children.profile patch", () => deps.profiles.patch(parent, agentId, { notified: true }), undefined);
    },

    progress(agentId): void {
      const parent = parentFor(agentId);
      if (parent === undefined) return;
      if (watch.has(agentId)) arm(parent, agentId);
    },
  };

  return registry;
}
