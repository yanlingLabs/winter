import type { WorkflowCounts, WorkflowRunView, WorkflowStatus } from "./types";

interface WorkflowRunEntry {
  runId: string;
  sessionId: string;
  name?: string;
  status: WorkflowStatus;
  counts: WorkflowCounts;
  phase?: string;
  result?: string;
  error?: string;
  startedAt: number;
  notified: boolean;
  abort: AbortController;
}

/** Pure Map-backed state tracker for workflow runs — the WorkflowRuntime's bookkeeping half,
 *  mirroring BackgroundAgentRegistry (agent/bg-agent-registry.ts). Never throws: unknown runIds are
 *  no-ops / undefined / false. */
export class WorkflowRegistry {
  private runs = new Map<string, WorkflowRunEntry>();

  register(e: { runId: string; sessionId: string; name?: string; abort: AbortController }): void {
    if (this.runs.has(e.runId)) return;
    this.runs.set(e.runId, {
      runId: e.runId, sessionId: e.sessionId, name: e.name, status: "running",
      counts: { running: 0, completed: 0, total: 0 }, startedAt: Date.now(), notified: false, abort: e.abort,
    });
  }

  setPhase(runId: string, phase: string): void { const e = this.runs.get(runId); if (e) e.phase = phase; }
  setCounts(runId: string, counts: WorkflowCounts): void { const e = this.runs.get(runId); if (e) e.counts = counts; }

  /** running → completed|failed, stores the result string. No-op if unknown or already terminal.
   *  opts.notified (mirrors bg-agent-registry.complete): true for a run_in_background:false inline
   *  completion — the caller already got the result as its tool_result, so takeForNotification must
   *  never re-surface it. */
  complete(runId: string, outcome: { ok: boolean; result: string }, opts?: { notified?: boolean }): void {
    const e = this.runs.get(runId);
    if (!e || e.status !== "running") return;
    e.status = outcome.ok ? "completed" : "failed";
    if (outcome.ok) e.result = outcome.result; else e.error = outcome.result;
    if (opts?.notified) e.notified = true;
  }

  fail(runId: string, error: string): void { this.complete(runId, { ok: false, result: error }); }

  /** running → stopped, fires abort. false if unknown or already terminal. */
  stop(runId: string): boolean {
    const e = this.runs.get(runId);
    if (!e || e.status !== "running") return false;
    // Set "stopped" BEFORE firing abort: abort() runs its listeners SYNCHRONOUSLY, and the runtime's
    // abort→teardown→settle cascade (and any finish() it triggers, which guards on status==="running")
    // reads the status during that synchronous run. Aborting first would let a concurrent await()
    // settler resolve with a stale "running" snapshot, and a finish() overwrite "stopped" with "failed".
    e.status = "stopped";
    e.abort.abort();
    return true;
  }

  get(runId: string): WorkflowRunView | undefined {
    const e = this.runs.get(runId);
    return e ? this.view(e) : undefined;
  }

  list(sessionId: string): WorkflowRunView[] {
    return [...this.runs.values()].filter((e) => e.sessionId === sessionId).map((e) => this.view(e));
  }

  /** Single-consumer claim (exactly-once completion notice) — mirrors
   *  BackgroundAgentRegistry.takeForNotification. */
  takeForNotification(runId: string): WorkflowRunView | undefined {
    const e = this.runs.get(runId);
    if (!e || e.status === "running" || e.notified) return undefined;
    e.notified = true;
    return this.view(e);
  }

  private view(e: WorkflowRunEntry): WorkflowRunView {
    return { runId: e.runId, sessionId: e.sessionId, name: e.name, status: e.status, counts: e.counts,
      phase: e.phase, result: e.result, error: e.error, startedAt: e.startedAt };
  }
}
