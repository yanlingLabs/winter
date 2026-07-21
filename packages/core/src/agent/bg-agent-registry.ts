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
export type AgentStatus = "running" | "completed" | "failed" | "stopped" | "timeout";

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
  abort: AbortController;
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
  bgAgents: BackgroundAgentRegistry,
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

export class BackgroundAgentRegistry {
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
      abort: e.abort,
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

  private findByName(sessionId: string, name: string): AgentEntry | undefined {
    for (const e of this.agents.values()) {
      if (e.sessionId === sessionId && e.name === name) return e;
    }
    return undefined;
  }
}
