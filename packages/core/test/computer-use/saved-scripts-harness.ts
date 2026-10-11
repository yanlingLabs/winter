// ComputerV2 Phase 4 — a test world for saved scripts and the idle-end notice: the REAL service with an IN-PROCESS
// worker (the real runtime, `worker/runtime.ts`, driven through the same bridge messages the sandboxed process
// speaks), so a worker's start, idle end, crash and reset can be seen on any machine. No helper, no app: the scripts
// here only print, save and run saved scripts.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ComputerPolicy } from "../../src/computer-use/policy";
import type { HelperClient } from "../../src/computer-use/helper-client";
import { ComputerV2Service, type ScriptResult } from "../../src/computer-use/service";
import { AutomationTelemetry } from "../../src/computer-use/telemetry";
import type { AutomationWorker, RunHandlers, WorkerRunOutcome } from "../../src/computer-use/worker-host";
import type { HostToWorker, SavedScriptSource, WorkerToHost } from "../../src/computer-use/worker/bridge";
import { createAutomationRuntime } from "../../src/computer-use/worker/runtime";

/** One "process": a fresh runtime; `kill()` ends it like a crash (its run settles `exited`). */
export class InProcessWorker {
  static started = 0;
  readonly id = ++InProcessWorker.started;
  /** Every `run` message it was sent (what a fresh worker was told to install). */
  readonly runs: Array<{ runId: string; code: string; install?: SavedScriptSource[] }> = [];
  /** A line the test wants the "worker" to send as if the model's code wrote it (a forged bridge line). */
  forge?: (runId: string) => WorkerToHost[];
  private dead = false;
  private current: { id: string; handlers: RunHandlers; settle(o: WorkerRunOutcome): void } | undefined;
  private readonly rt = createAutomationRuntime({
    post: (m) => this.fromRuntime(m),
    transpile: (code) => new Bun.Transpiler({ loader: "ts" }).transformSync(code),
  });

  get alive(): boolean { return !this.dead; }
  get pid(): number { return 100_000 + this.id; }

  private fromRuntime(m: WorkerToHost): void {
    const run = this.current;
    if (run === undefined || !("runId" in m) || m.runId !== run.id) return;
    switch (m.op) {
      case "call": run.handlers.onCall(m); return;
      case "print": run.handlers.onPrint(m.text); return;
      case "show": run.handlers.onShow(m.image); return;
      case "done":
        this.current = undefined;
        run.settle({ kind: "done", ...(m.error === undefined ? {} : { error: m.error }), ...(m.note === undefined ? {} : { note: m.note }), ...(m.installFailed === undefined ? {} : { installFailed: m.installFailed }) });
    }
  }

  run(runId: string, code: string, handlers: RunHandlers, install?: SavedScriptSource[]): Promise<WorkerRunOutcome> {
    if (this.dead) return Promise.resolve({ kind: "exited", code: null, refused: false });
    this.runs.push({ runId, code, ...(install === undefined ? {} : { install }) });
    return new Promise((settle) => {
      this.current = { id: runId, handlers, settle };
      const forged = this.forge?.(runId);
      if (forged !== undefined) {
        // The forged lines go to the daemon as if the worker wrote them; the script itself then runs as usual.
        for (const f of forged) this.fromRuntime(f);
      }
      this.rt.handle({ op: "run", runId, code, ...(install === undefined ? {} : { install }) } as HostToWorker);
    });
  }

  reply(id: number, outcome: { ok: true; value?: unknown } | { ok: false; error: { kind: string; message: string } }): void {
    if (this.dead) return;
    this.rt.handle({ op: "reply", id, ...outcome } as HostToWorker);
    this.replies.push({ id, ...outcome });
  }
  readonly replies: Array<{ id: number; ok: boolean; value?: unknown; error?: { kind: string; message: string } }> = [];

  cancel(runId: string, reason?: string): void { if (!this.dead) this.rt.handle({ op: "cancel", runId, ...(reason === undefined ? {} : { reason }) }); }

  kill(): void {
    if (this.dead) return;
    this.dead = true;
    const run = this.current;
    this.current = undefined;
    run?.settle({ kind: "exited", code: null, refused: false });
  }
}

export function savedScriptsWorld(opts: { idleMs?: number } = {}) {
  const home = mkdtempSync(join(tmpdir(), "winter-cu-saved-"));
  const workers: InProcessWorker[] = [];
  const audits: Array<Record<string, unknown>> = [];
  const telemetry = new AutomationTelemetry(home);
  const helper = { connected: false, generation: 0, tell: () => {} } as unknown as HelperClient;
  const policy = { clearSession: () => {}, persistentlyAllowed: () => false, authorize: async () => {} } as unknown as ComputerPolicy;
  const svc = new ComputerV2Service({
    helper, policy, settings: () => null, telemetry, audit: (l) => audits.push(l),
    startWorker: async () => { const w = new InProcessWorker(); workers.push(w); return w as unknown as AutomationWorker; },
    ...(opts.idleMs === undefined ? {} : { idleMs: opts.idleMs }),
  });
  const run = (code: string, o: { sessionId?: string; reset?: boolean } = {}): Promise<ScriptResult> =>
    svc.run({ sessionId: o.sessionId ?? "s1", vision: true, model: "anthropic/claude-opus-5-5" }, { code, ...(o.reset === undefined ? {} : { reset: o.reset }) });
  const metrics = (): Array<Record<string, unknown>> => {
    try { return readFileSync(telemetry.path, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>); } catch { return []; }
  };
  return { svc, run, workers, audits, metrics, home, latest: () => workers.at(-1)! };
}

export const textOf = (r: ScriptResult): string => r.content.map((c) => (c.type === "text" ? c.text : "[image]")).join("\n");
export const sleepMs = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
