import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promptKey, RunJournal } from "./journal";
import { WorkflowRegistry } from "./registry";
import { buildWorkflowSeatbeltProfile, sandboxAvailable } from "./sandbox";
import { makeSemaphore, type Semaphore } from "./semaphore";
import type { BridgeRequest, BridgeResponse, WorkerInit } from "./bridge";
import type { AgentOpts, WorkflowProgress, WorkflowRunView } from "./types";

const WORKFLOW_SUBCOMMAND = "__workflow-worker";

/** Command to re-invoke THIS program in workflow-worker mode, correct for both the compiled binary
 *  and dev/test. `process.execPath` is always the file to spawn; `Bun.main` is the discriminator
 *  (compiled vs dev) because dev needs an extra script-path arg — verified both ways in the Track-A
 *  spike (trackA-spike-notes.md). */
function defaultWorkerCommand(): { file: string; args: string[] } {
  if (Bun.main.startsWith("/$bunfs/") || Bun.main.includes("/$bunfs/")) {
    // COMPILED: execPath IS the norma-core binary; the subcommand routes through main.ts's switch.
    return { file: process.execPath, args: [WORKFLOW_SUBCOMMAND] };
  }
  // DEV/TEST: execPath is `bun`; hand it the entry .ts directly — this also works under `bun test`,
  // where Bun.main is the test runner, not main.ts. The trailing subcommand is harmless here.
  const entry = fileURLToPath(new URL("./subprocess-entry.ts", import.meta.url));
  return { file: process.execPath, args: [entry, WORKFLOW_SUBCOMMAND] };
}

export interface WorkflowRuntimeDeps {
  onEvent: (sessionId: string, ev: WorkflowRuntimeEvent) => void;
  spawnAgent?: (sessionId: string, prompt: string, opts: AgentOpts | undefined, signal: AbortSignal) => Promise<{ ok: boolean; result: string }>;
  caps?: { concurrency?: number; total?: number };
  runsDir?: string;
  /** Test seam (REPLACES `workerUrl`): overrides the inner spawn command (file+args, pre-sandbox).
   *  Default = defaultWorkerCommand(). Tests can point at a fake entry to avoid the real bridge. */
  workerCommand?: () => { file: string; args: string[] };
}

export type WorkflowRuntimeEvent =
  | { type: "started"; runId: string; name?: string; summary: string }
  | { type: "progress"; runId: string; progress: WorkflowProgress }
  | { type: "completed"; runId: string; result: string }
  | { type: "failed"; runId: string; error: string };

export interface WorkflowLaunch {
  sessionId: string; source: string; args?: unknown; name?: string; runId?: string;
  /** Task A6: seeds the launched run's Worker with a prior run's cached agent() results (resume() only). */
  resumeJournal?: Array<{ promptKey: string; value: unknown }>;
}

interface LiveRun {
  runId: string;
  sessionId: string;
  child: ChildProcess;
  /** Reassembly buffer for NDJSON arriving on `child.stdout` — a `data` chunk may split or coalesce
   *  lines, so partial data accumulates here until a `\n` completes a line. */
  stdoutBuf: string;
  done: Promise<WorkflowRunView>;
  running: number;
  completed: number;
  total: number;
  /** Run-local semaphore bounding how many `agent` bridge requests this run services concurrently
   *  — layered over the global SubagentManager pool (Global Constraints). Default 16. */
  sem: Semaphore;
  /** Hard stop on total agents spawned by this run — never silently truncates. Default 1000. */
  totalCap: number;
  /** Task A6: this run's own journal — serviceAgent appends to it after each successful agent()
   *  result, keyed by call order, so a later resume(runId) can replay the unchanged prefix. */
  journal: RunJournal;
  /** I2: this run's own controller (armed at launch, wired to teardown) — threaded into every
   *  spawnAgent call via serviceAgent so stop()/teardown genuinely cancels in-flight bridged agents
   *  instead of letting them run to completion after their reply can no longer reach the dead child. */
  abort: AbortController;
}

const CONCURRENCY_DEFAULT = 16;
const TOTAL_DEFAULT = 1000;

export class WorkflowRuntime {
  private readonly reg = new WorkflowRegistry();
  private readonly live = new Map<string, LiveRun>();
  /** Task A6: each launch's source, keyed by runId — resume() replays it verbatim. Mirrors `reg`:
   *  never pruned, so a long-lived daemon accumulates one string per run ever launched. */
  private readonly sources = new Map<string, string>();
  /** Task A6: journal root, `<runsDir>/<runId>/journal.jsonl` per run. Defaults to a fresh temp dir
   *  so a caller who doesn't pass `runsDir` (every test today) never touches a real NORMA_HOME —
   *  the daemon wires the actual `<normaHome>/workflows-runs` path explicitly (Task B2). */
  private readonly runsDir: string;
  constructor(private readonly deps: WorkflowRuntimeDeps) {
    this.runsDir = deps.runsDir ?? mkdtempSync(join(tmpdir(), "norma-workflow-runs-"));
  }

  launch(l: WorkflowLaunch): string {
    const runId = l.runId ?? `wf_${randomBytes(6).toString("hex")}`;
    this.sources.set(runId, l.source);
    const abort = new AbortController();
    this.reg.register({ runId, sessionId: l.sessionId, name: l.name, abort });

    let settle!: (v: WorkflowRunView) => void;
    const done = new Promise<WorkflowRunView>((res) => { settle = res; });
    this.settlers.set(runId, settle);

    if (!sandboxAvailable()) throw new Error("workflows unavailable: macOS sandbox-exec not found");
    const cmd = this.deps.workerCommand?.() ?? defaultWorkerCommand();
    const profile = buildWorkflowSeatbeltProfile(cmd.file);
    const child = spawn("/usr/bin/sandbox-exec", ["-p", profile, cmd.file, ...cmd.args],
      { stdio: ["pipe", "pipe", "pipe"], detached: true });

    const run: LiveRun = {
      runId, sessionId: l.sessionId, child, stdoutBuf: "", done, running: 0, completed: 0, total: 0,
      sem: makeSemaphore(this.deps.caps?.concurrency ?? CONCURRENCY_DEFAULT),
      totalCap: this.deps.caps?.total ?? TOTAL_DEFAULT,
      journal: new RunJournal(this.runsDir, runId),
      abort,
    };
    this.live.set(runId, run);

    abort.signal.addEventListener("abort", () => this.teardown(runId, () => this.finish(runId, "stopped")));

    // stdout NDJSON → onWorkerMessage (identical op-handling to before, now framed over a pipe
    // instead of arriving as structured-clone MessageEvents).
    child.stdout!.on("data", (d: Buffer) => {
      run.stdoutBuf += d.toString("utf8");
      let i;
      while ((i = run.stdoutBuf.indexOf("\n")) >= 0) {
        const line = run.stdoutBuf.slice(0, i); run.stdoutBuf = run.stdoutBuf.slice(i + 1);
        if (!line.trim()) continue;
        let msg: BridgeRequest;
        try { msg = JSON.parse(line); } catch { continue; }
        void this.onWorkerMessage(run, msg);
      }
    });
    // Crash/exit-without-done fallback (replaces worker.onerror). The `done`/`error` bridge messages
    // drive normal terminal state and teardown first; if the child dies without ever sending one
    // (killed externally, OOM, sandbox-exec itself failing to start it), fail here instead of hanging
    // await() forever. Guarded on `live.has` since a normal done/error/stop already tore this down.
    child.on("close", (code) => {
      if (this.live.has(runId)) this.teardown(runId, () => this.finish(runId, "failed", `workflow worker exited (code ${code ?? "signal"})`));
    });
    child.on("error", (err) => {
      if (this.live.has(runId)) this.teardown(runId, () => this.finish(runId, "failed", `workflow worker failed to spawn: ${(err as Error).message}`));
    });

    const summary = l.source.trim().split("\n")[0]?.slice(0, 120) ?? "";
    this.deps.onEvent(l.sessionId, { type: "started", runId, name: l.name, summary });

    const init: WorkerInit = {
      source: l.source, args: l.args ?? null, concurrency: this.deps.caps?.concurrency ?? CONCURRENCY_DEFAULT,
      resumeJournal: l.resumeJournal,
    };
    child.stdin!.write(JSON.stringify(init) + "\n");
    return runId;
  }

  /** Task A6: re-launches runId's original source as a NEW run (fresh runId, same sessionId/name),
   *  seeded with the prior run's journal — the harness's agent() shim (worker-harness.ts) replays
   *  cached results for the unchanged call prefix and only goes live from the first changed/new call
   *  on (Global Constraints). Same-session only: sessionId is copied from the prior run, never
   *  supplied by the caller. Throws on an unknown runId — mirrors `resume`'s "must exist" contract
   *  rather than silently no-op'ing (this.reg's other lookups return undefined/false instead because
   *  they're queries; this one launches a Worker, so a typo'd runId failing loudly is worth more). */
  resume(runId: string): string {
    const prior = this.reg.get(runId);
    if (!prior) throw new Error(`unknown run ${runId}`);
    const source = this.sources.get(runId);
    if (source === undefined) throw new Error(`no source recorded for run ${runId}`);
    const journal = new RunJournal(this.runsDir, runId).load();
    return this.launch({ sessionId: prior.sessionId, source, name: prior.name, resumeJournal: journal });
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
        // guard: the child may already be torn down (stopped) before the agent resolves
        if (this.live.has(run.runId)) run.child.stdin!.write(JSON.stringify(reply) + "\n");
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
    try { // M4: everything acquire() pairs with is inside the try, so release() always runs
      run.running++; run.total++;
      if (this.live.has(run.runId)) { // M1: don't touch counts/progress for an already-torn-down run
        this.reg.setCounts(run.runId, { running: run.running, completed: run.completed, total: run.total });
        this.emitProgress(run, {});
      }
      const perCall = new AbortController();
      // I2: stop()/teardown fires run.abort — chaining it here means it actually cancels this
      // in-flight agent (via runWorkflowAgent's own AbortSignal.any([childSignal, signal])) instead
      // of leaving it to run to completion with its reply discarded. perCall is reserved for future
      // per-call cancellation (none exists yet — it never fires on its own today).
      const signal = AbortSignal.any([run.abort.signal, perCall.signal]);
      const out = await this.deps.spawnAgent(run.sessionId, msg.prompt, msg.opts, signal);
      // Task A6: only successful results are journaled — a failed call has nothing worth caching,
      // and a later resume() should retry it live rather than replay the failure.
      if (out.ok) run.journal.append(promptKey(msg.prompt, msg.opts), out.result);
      return out.ok ? { callId: msg.callId, ok: true, value: out.result } : { callId: msg.callId, ok: false, error: out.result };
    } finally {
      run.running--; run.completed++;
      run.sem.release(); // M4: release FIRST — never blocked by a possibly-throwing emit below
      if (this.live.has(run.runId)) { // M1: don't emit progress/counts for a run that already finished
        this.reg.setCounts(run.runId, { running: run.running, completed: run.completed, total: run.total });
        this.emitProgress(run, {});
      }
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
    // Group-kill: `detached: true` at spawn made the child its own process-group leader, so the
    // negative pid reaps sandbox-exec + the bun child together (mirrors agent/tools/bash.ts). Falls
    // back to a direct kill of the child pid if the group-kill fails for any reason.
    try { if (run.child.pid) process.kill(-run.child.pid, "SIGKILL"); }
    catch { try { run.child.kill("SIGKILL"); } catch { /* already gone */ } }
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
