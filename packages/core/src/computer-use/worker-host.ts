// ComputerV2 (2026-10-08) — the daemon's side of ONE session's automation worker process: spawn it under the
// workflow seatbelt, speak the NDJSON bridge (`worker/bridge.ts`), run one script at a time, cancel, kill.
//
// Policy, locks and routing are NOT here: a `call` from the worker is handed to the run's `onCall`, and the
// service (`service.ts`) answers it with `reply`. This file is process plumbing only, which is what lets the
// tests drive a REAL sandboxed worker with a scripted `onCall`.
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { sandboxAvailable } from "../workflows/sandbox";
import { AUTOMATION_WORKER_ENV, buildAutomationSeatbeltProfile, devSourceRootFor } from "./sandbox";
import { WORKER_NOT_SANDBOXED_EXIT_CODE } from "../workflows/sandbox-guard";
import { AUTOMATION_WORKER_ARG } from "./worker/entry";
import { BRIDGE_MAX_LINE, type HostToWorker, type WorkerToHost } from "./worker/bridge";

export interface AutomationWorkerCommand { file: string; args: string[] }

/** The command that re-invokes THIS program as the worker — compiled binary or dev/test, the workflow
 *  runtime's own discriminator (`Bun.main` lives in `/$bunfs/` only in a compiled binary). */
export function defaultAutomationWorkerCommand(): AutomationWorkerCommand {
  if (Bun.main.startsWith("/$bunfs/") || Bun.main.includes("/$bunfs/")) return { file: process.execPath, args: [AUTOMATION_WORKER_ARG] };
  const entry = fileURLToPath(new URL("./worker/entry.ts", import.meta.url));
  return { file: process.execPath, args: [entry, AUTOMATION_WORKER_ARG] };
}

export type CallMessage = Extract<WorkerToHost, { op: "call" }>;

export interface RunHandlers {
  onCall(message: CallMessage): void;
  onPrint(text: string): void;
  onShow(image: string): void;
}

export type WorkerRunOutcome =
  | { kind: "done"; error?: { name: string; message: string; line?: number }; note?: string }
  /** The process went away before the run settled (killed, crashed, or refused to run — `refused`). */
  | { kind: "exited"; code: number | null; refused: boolean };

export interface AutomationWorkerOptions {
  command?: () => AutomationWorkerCommand;
  /** Paths the worker may never read, whatever else its profile allows — `<WINTER_HOME>` and the Read fence's set. */
  denyRead?: readonly string[];
  /** How long to wait for the worker's `ready` line. */
  readyTimeoutMs?: number;
  log?: (line: string) => void;
}

const READY_TIMEOUT_MS = 15_000;

export class AutomationWorkerUnavailable extends Error {
  constructor(message: string, readonly refused = false) {
    super(message);
    this.name = "AutomationWorkerUnavailable";
  }
}

/** One live worker process. Created by `AutomationWorker.start`; dead once `exited` resolves. */
export class AutomationWorker {
  private buf = "";
  private current: { id: string; handlers: RunHandlers; settle(o: WorkerRunOutcome): void } | undefined;
  private exitCode: number | null | undefined;
  readonly exited: Promise<{ code: number | null; refused: boolean }>;
  private resolveExited!: (v: { code: number | null; refused: boolean }) => void;

  private constructor(private readonly child: ChildProcess, private readonly log: (line: string) => void) {
    this.exited = new Promise((resolve) => { this.resolveExited = resolve; });
  }

  /** Spawn under the seatbelt and wait for `ready`. Throws `AutomationWorkerUnavailable`. */
  static async start(opts: AutomationWorkerOptions = {}): Promise<AutomationWorker> {
    if (!sandboxAvailable()) throw new AutomationWorkerUnavailable("the automation runtime needs the macOS sandbox (sandbox-exec), which this machine does not have");
    const cmd = (opts.command ?? defaultAutomationWorkerCommand)();
    // The worker's OWN profile (a read allowlist — `sandbox.ts`), a minimal environment (nothing of the daemon's)
    // and `/` as its working directory (the daemon's own cwd may be anywhere, the user's home included).
    const devRoot = devSourceRootFor();
    const profile = buildAutomationSeatbeltProfile({ selfExecPath: cmd.file, ...(devRoot === undefined ? {} : { devSourceRoot: devRoot }), ...(opts.denyRead === undefined ? {} : { denyRead: opts.denyRead }) });
    const child = spawn("/usr/bin/sandbox-exec", ["-p", profile, cmd.file, ...cmd.args], { stdio: ["pipe", "pipe", "pipe"], detached: true, cwd: "/", env: { ...AUTOMATION_WORKER_ENV } });
    const worker = new AutomationWorker(child, opts.log ?? (() => {}));
    let readyResolve!: () => void;
    let readyReject!: (e: Error) => void;
    const ready = new Promise<void>((res, rej) => { readyResolve = res; readyReject = rej; });
    let isReady = false;
    let stderr = "";
    child.stderr?.on("data", (d: Buffer) => { if (stderr.length < 4096) stderr += d.toString("utf8"); });
    child.stdout?.on("data", (d: Buffer) => {
      worker.buf += d.toString("utf8");
      let i: number;
      while ((i = worker.buf.indexOf("\n")) >= 0) {
        const line = worker.buf.slice(0, i);
        worker.buf = worker.buf.slice(i + 1);
        if (!line.trim()) continue;
        if (line.length > BRIDGE_MAX_LINE) continue;
        let msg: WorkerToHost;
        try { msg = JSON.parse(line) as WorkerToHost; } catch { continue; }
        if (msg.op === "ready") { if (!isReady) { isReady = true; readyResolve(); } continue; }
        worker.onMessage(msg);
      }
      // A runaway line (no newline for 4 MiB) is a broken worker: drop the buffer rather than grow forever.
      if (worker.buf.length > BRIDGE_MAX_LINE) worker.buf = "";
    });
    child.stdin?.on("error", () => { /* reported through "close" */ });
    child.on("error", (err) => { if (!isReady) readyReject(new AutomationWorkerUnavailable(`the automation runtime could not start: ${err.message}`)); });
    child.on("close", (code) => {
      const refused = code === WORKER_NOT_SANDBOXED_EXIT_CODE;
      worker.exitCode = code;
      if (!isReady) readyReject(new AutomationWorkerUnavailable(refused ? "the automation runtime refused to run outside its sandbox" : `the automation runtime exited before it was ready (code ${code ?? "signal"})${stderr.trim() ? `: ${stderr.trim().slice(0, 300)}` : ""}`, refused));
      const run = worker.current;
      worker.current = undefined;
      run?.settle({ kind: "exited", code, refused });
      worker.resolveExited({ code, refused });
    });
    const timer = setTimeout(() => readyReject(new AutomationWorkerUnavailable("the automation runtime did not start in time")), opts.readyTimeoutMs ?? READY_TIMEOUT_MS);
    try {
      await ready;
    } catch (err) {
      worker.kill();
      throw err;
    } finally {
      clearTimeout(timer);
    }
    return worker;
  }

  get alive(): boolean { return this.exitCode === undefined; }
  get pid(): number | undefined { return this.child.pid; }

  private send(message: HostToWorker): void {
    if (!this.alive) return;
    try { this.child.stdin?.write(`${JSON.stringify(message)}\n`); } catch { /* reported through "close" */ }
  }

  private onMessage(msg: WorkerToHost): void {
    const run = this.current;
    if (run === undefined) return;
    // A line naming another run is ignored — the worker is untrusted, and a stale or forged id names nothing.
    if (!("runId" in msg) || msg.runId !== run.id) return;
    switch (msg.op) {
      case "call": run.handlers.onCall(msg); return;
      case "print": if (typeof msg.text === "string") run.handlers.onPrint(msg.text); return;
      case "show": if (typeof msg.image === "string") run.handlers.onShow(msg.image); return;
      case "done": {
        this.current = undefined;
        run.settle({ kind: "done", ...(msg.error === undefined ? {} : { error: msg.error }), ...(msg.note === undefined ? {} : { note: msg.note }) });
        return;
      }
    }
  }

  /** Run one script. Resolves when it settles or the process goes away; never rejects. */
  run(runId: string, code: string, handlers: RunHandlers): Promise<WorkerRunOutcome> {
    if (!this.alive) return Promise.resolve({ kind: "exited", code: this.exitCode ?? null, refused: false });
    if (this.current !== undefined) return Promise.resolve({ kind: "done", error: { name: "Error", message: "another script is still running in this session's runtime" } });
    return new Promise<WorkerRunOutcome>((settle) => {
      this.current = { id: runId, handlers, settle };
      this.send({ op: "run", runId, code });
    });
  }

  reply(id: number, outcome: { ok: true; value?: unknown } | { ok: false; error: { kind: string; message: string } }): void {
    this.send({ op: "reply", id, ...outcome } as HostToWorker);
  }

  cancel(runId: string, reason?: string): void {
    this.send({ op: "cancel", runId, ...(reason === undefined ? {} : { reason }) });
  }

  /** Kill the process group (sandbox-exec and the worker together), like the workflow runtime's teardown. */
  kill(): void {
    if (this.exitCode !== undefined) return;
    try { if (this.child.pid) process.kill(-this.child.pid, "SIGKILL"); }
    catch { try { this.child.kill("SIGKILL"); } catch { /* already gone */ } }
    this.log(`automation worker pid ${this.child.pid ?? "?"} killed`);
  }
}
