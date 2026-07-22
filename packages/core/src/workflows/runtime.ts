import { randomBytes } from "node:crypto";
import { WorkflowRegistry } from "./registry";
import { makeSemaphore, type Semaphore } from "./semaphore";
import type { BridgeRequest, BridgeResponse, WorkerInit } from "./bridge";
import type { AgentOpts, WorkflowProgress, WorkflowRunView } from "./types";

export interface WorkflowRuntimeDeps {
  onEvent: (sessionId: string, ev: WorkflowRuntimeEvent) => void;
  spawnAgent?: (sessionId: string, prompt: string, opts: AgentOpts | undefined, signal: AbortSignal) => Promise<{ ok: boolean; result: string }>;
  workerUrl?: URL;
  caps?: { concurrency?: number; total?: number };
  runsDir?: string;
}

export type WorkflowRuntimeEvent =
  | { type: "started"; runId: string; name?: string; summary: string }
  | { type: "progress"; runId: string; progress: WorkflowProgress }
  | { type: "completed"; runId: string; result: string }
  | { type: "failed"; runId: string; error: string };

export interface WorkflowLaunch { sessionId: string; source: string; args?: unknown; name?: string; runId?: string }

interface LiveRun {
  runId: string;
  sessionId: string;
  worker: Worker;
  done: Promise<WorkflowRunView>;
  running: number;
  completed: number;
  total: number;
  /** Run-local semaphore bounding how many `agent` bridge requests this run services concurrently
   *  — layered over the global SubagentManager pool (Global Constraints). Default 16. */
  sem: Semaphore;
  /** Hard stop on total agents spawned by this run — never silently truncates. Default 1000. */
  totalCap: number;
}

const CONCURRENCY_DEFAULT = 16;
const TOTAL_DEFAULT = 1000;

export class WorkflowRuntime {
  private readonly reg = new WorkflowRegistry();
  private readonly live = new Map<string, LiveRun>();
  constructor(private readonly deps: WorkflowRuntimeDeps) {}

  launch(l: WorkflowLaunch): string {
    const runId = l.runId ?? `wf_${randomBytes(6).toString("hex")}`;
    const abort = new AbortController();
    this.reg.register({ runId, sessionId: l.sessionId, name: l.name, abort });

    const workerUrl = this.deps.workerUrl ?? new URL("./worker-entry.ts", import.meta.url);
    const worker = new Worker(workerUrl.href, { type: "module" });
    let settle!: (v: WorkflowRunView) => void;
    const done = new Promise<WorkflowRunView>((res) => { settle = res; });
    this.settlers.set(runId, settle);
    const run: LiveRun = {
      runId, sessionId: l.sessionId, worker, done, running: 0, completed: 0, total: 0,
      sem: makeSemaphore(this.deps.caps?.concurrency ?? CONCURRENCY_DEFAULT),
      totalCap: this.deps.caps?.total ?? TOTAL_DEFAULT,
    };
    this.live.set(runId, run);

    abort.signal.addEventListener("abort", () => this.teardown(runId, () => this.finish(runId, "stopped")));

    worker.onmessage = (ev: MessageEvent) => void this.onWorkerMessage(run, ev.data as BridgeRequest);
    worker.onerror = () => this.teardown(runId, () => this.finish(runId, "failed", "worker crashed"));

    const summary = l.source.trim().split("\n")[0]?.slice(0, 120) ?? "";
    this.deps.onEvent(l.sessionId, { type: "started", runId, name: l.name, summary });

    const init: WorkerInit = { source: l.source, args: l.args ?? null, concurrency: this.deps.caps?.concurrency ?? CONCURRENCY_DEFAULT };
    worker.postMessage(init);
    return runId;
  }

  await(runId: string): Promise<WorkflowRunView> {
    const run = this.live.get(runId);
    if (run) return run.done;
    const v = this.reg.get(runId);
    return Promise.resolve(v ?? { runId, sessionId: "", status: "failed", counts: { running: 0, completed: 0, total: 0 }, startedAt: 0, error: "unknown run" });
  }

  list(sessionId: string): WorkflowRunView[] { return this.reg.list(sessionId); }
  get(runId: string): WorkflowRunView | undefined { return this.reg.get(runId); }
  stop(runId: string): boolean { return this.reg.stop(runId); }
  takeForNotification(runId: string): WorkflowRunView | undefined { return this.reg.takeForNotification(runId); }

  private async onWorkerMessage(run: LiveRun, msg: BridgeRequest): Promise<void> {
    switch (msg.op) {
      case "phase":
        this.reg.setPhase(run.runId, msg.title);
        this.emitProgress(run, { phase: msg.title });
        break;
      case "log":
        this.emitProgress(run, { log: msg.message });
        break;
      case "agent": {
        const reply = await this.serviceAgent(run, msg);
        // guard: worker may already be torn down (stopped) before the agent resolves
        if (this.live.has(run.runId)) run.worker.postMessage(reply);
        break;
      }
      case "done":
        this.teardown(run.runId, () => this.finish(run.runId, "completed", typeof msg.result === "string" ? msg.result : JSON.stringify(msg.result ?? null)));
        break;
      case "error":
        this.teardown(run.runId, () => this.finish(run.runId, "failed", msg.message));
        break;
    }
  }

  /** Absent spawnAgent → a typed reply the script's agent() rejects on. Otherwise: the total cap is
   *  a hard stop (checked BEFORE acquiring the semaphore, so a run pinned at capacity fails fast
   *  instead of queuing forever) — never silently truncates, and the failure message logs how many
   *  completed before the stop. The semaphore then bounds how many spawnAgent calls (which count
   *  against the global SubagentManager pool too) this run has in flight at once. */
  protected async serviceAgent(run: LiveRun, msg: Extract<BridgeRequest, { op: "agent" }>): Promise<BridgeResponse> {
    if (!this.deps.spawnAgent) return { callId: msg.callId, ok: false, error: "workflow agents are not available in this runtime" };
    if (run.total >= run.totalCap) {
      const err = `workflow exceeded the per-run agent cap (${run.totalCap}) — ${run.completed} completed before the stop`;
      this.teardown(run.runId, () => this.finish(run.runId, "failed", err));
      return { callId: msg.callId, ok: false, error: err };
    }
    await run.sem.acquire();
    run.running++; run.total++;
    this.reg.setCounts(run.runId, { running: run.running, completed: run.completed, total: run.total });
    this.emitProgress(run, {});
    try {
      const abort = new AbortController();
      const out = await this.deps.spawnAgent(run.sessionId, msg.prompt, msg.opts, abort.signal);
      return out.ok ? { callId: msg.callId, ok: true, value: out.result } : { callId: msg.callId, ok: false, error: out.result };
    } finally {
      run.running--; run.completed++;
      this.reg.setCounts(run.runId, { running: run.running, completed: run.completed, total: run.total });
      this.emitProgress(run, {});
      run.sem.release();
    }
  }

  protected emitProgress(run: LiveRun, p: { phase?: string; log?: string }): void {
    const progress: WorkflowProgress = { ...p, counts: { running: run.running, completed: run.completed, total: run.total } };
    this.deps.onEvent(run.sessionId, { type: "progress", runId: run.runId, progress });
  }

  private teardown(runId: string, then: () => void): void {
    const run = this.live.get(runId);
    if (!run) return;
    this.live.delete(runId);
    try { run.worker.terminate(); } catch { /* already gone */ }
    then();
  }

  private finish(runId: string, status: "completed" | "failed" | "stopped", detail?: string): void {
    const run = this.live.get(runId);
    if (status === "completed") { this.reg.complete(runId, { ok: true, result: detail ?? "" }); this.deps.onEvent(this.sessionOf(runId), { type: "completed", runId, result: detail ?? "" }); }
    else if (status === "failed") { this.reg.fail(runId, detail ?? "error"); this.deps.onEvent(this.sessionOf(runId), { type: "failed", runId, error: detail ?? "error" }); }
    else { /* stopped already set by reg.stop() via abort */ }
    const v = this.reg.get(runId);
    // resolve await() waiters — the LiveRun was deleted in teardown, so re-look the settle up:
    void run; if (v) this.settlers.get(runId)?.(v);
    this.settlers.delete(runId);
  }

  // settle bookkeeping kept separate so finish() can resolve after teardown deleted the LiveRun:
  private settlers = new Map<string, (v: WorkflowRunView) => void>();
  private sessionOf(runId: string): string { return this.reg.get(runId)?.sessionId ?? ""; }
}
