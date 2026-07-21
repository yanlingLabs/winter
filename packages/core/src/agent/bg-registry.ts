import { spawn, type ChildProcess } from "node:child_process";
import { realpathSync, mkdirSync, appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { buildSeatbeltProfile, sandboxAvailable } from "./sandbox";
import { OutputCoalescer } from "./bg-coalescer";
import type { NewSessionEvent } from "@norma/protocol";

const RING_CAP = 1024 * 1024; // 1 MiB in-memory ring per task
const FILE_CAP = 64 * 1024 * 1024; // generous per-task output-FILE byte cap (the ring stays 1MiB)
const DEPRECATION_RE = /^sandbox-exec: .*deprecated.*$/gim;

function fmtCap(bytes: number): string {
  return bytes % (1024 * 1024) === 0 ? `${bytes / (1024 * 1024)}MB` : `${bytes} bytes`;
}

interface Task {
  taskId: string; sessionId: string; command: string;
  child: ChildProcess; status: "running" | "exited" | "killed"; exitCode: number | null;
  ring: string; cursor: number; ringDropped: boolean; dropNoted: boolean; startedAt: number;
  coalescer: OutputCoalescer;
  // CC parity (TaskOutput deprecated in favor of Read on the task's output file): the full
  // combined stdout+stderr for this task, teed alongside `ring` (which is capped/evicted for the
  // in-memory bash_output view). Lazily created — the `bash/` subdir under the session tmp dir is
  // mkdir'd only when a background task actually starts, not for every session. Writes are
  // BATCHED through `fileCoalescer` (the same OutputCoalescer pattern the event stream's
  // `coalescer` above already uses — never raw sync IO per data event) and capped at FILE_CAP:
  // on hit, one "[output file capped at ...]" note line is appended and the tee stops for good;
  // the ring/bash_output keep working past the cap. `fileCoalescer` is disposed (final flush) on
  // task close/error, so the file is complete the moment the task ends.
  outFile: string;
  fileCoalescer: OutputCoalescer;
}

export interface BgDeps {
  emit: (sessionId: string, event: NewSessionEvent) => void;
  spawnCtx: (sessionId: string) => { cwd: string; roots: string[]; tmpDir: string };
  killGraceMs?: number;
  ringCap?: number;
  fileCap?: number; // per-task output-file byte cap (default FILE_CAP 64MB) — injectable for tests
}

export class BackgroundTaskRegistry {
  private tasks = new Map<string, Task>();
  private readonly killGraceMs: number;
  private readonly ringCap: number;
  private readonly fileCap: number;
  // Set by killAll() (whole-daemon shutdown only — never by killAllForSession). Child processes
  // report their exit asynchronously, often after the caller (daemon.stop()) has already closed
  // the SessionStore; emitting into a torn-down hub at that point would throw "closed database"
  // from an unrelated event-loop tick. Once shutting down, nobody is listening anyway, so drop
  // further events instead of forwarding them.
  private stopped = false;
  constructor(private readonly deps: BgDeps) {
    this.killGraceMs = deps.killGraceMs ?? 2000;
    this.ringCap = deps.ringCap ?? RING_CAP;
    this.fileCap = deps.fileCap ?? FILE_CAP;
  }

  private emit(sessionId: string, event: NewSessionEvent): void {
    if (this.stopped) return;
    this.deps.emit(sessionId, event);
  }

  private own(sessionId: string, taskId: string): Task {
    const t = this.tasks.get(taskId);
    if (!t || t.sessionId !== sessionId) throw new Error(`unknown background task: ${taskId}`);
    return t;
  }

  has(sessionId: string, taskId: string): boolean {
    const t = this.tasks.get(taskId);
    return !!t && t.sessionId === sessionId;
  }

  // SP-approvals Task 11 (spec §8): `opts` carries bash's two escalation args, already RESOLVED
  // (parsed + gated) by the caller — bash.ts's run() forwards its own same-named args unchanged;
  // the engine's dispatch loop is what actually decides whether a call bearing either flag is
  // allowed to reach here at all (permission-gate-order.test.ts covers that gating). This registry
  // only needs to honor them at spawn time, identically to the foreground bash tool
  // (tools-bash.test.ts's escalation-arg suite is the execution-level twin of this one). Default
  // `{}` keeps every pre-T11 2-arg caller (tests included) byte-identical: sandboxed, no network.
  start(sessionId: string, command: string, opts: { allowNetwork?: boolean; dangerouslyDisableSandbox?: boolean } = {}): string {
    const allowNetwork = opts.allowNetwork === true;
    const dangerouslyDisableSandbox = opts.dangerouslyDisableSandbox === true;
    // dangerouslyDisableSandbox never touches sandbox-exec at all (see the spawn branch below), so
    // requiring it to be present on the host would be a nonsensical, overly strict precondition.
    if (!dangerouslyDisableSandbox && !sandboxAvailable()) throw new Error("background bash unavailable: macOS sandbox-exec not found");
    const { cwd, roots, tmpDir } = this.deps.spawnCtx(sessionId);
    const realCwd = realpathSync(cwd);
    const scratch = realpathSync(tmpDir);
    // SP-approvals T11 review, LOW-1: single spawn call site (spawnFile/spawnArgs decided by the
    // branch below), mirroring bash.ts's own foreground shape exactly — was two separate `spawn`
    // calls with duplicated options; hoisted so the two shapes can never drift apart.
    let spawnFile: string;
    let spawnArgs: string[];
    if (dangerouslyDisableSandbox) {
      // Plain, unsandboxed spawn — no seatbelt profile at all (no write fence, no network deny).
      // cwd/$TMPDIR semantics stay identical to the sandboxed branch below.
      spawnFile = "/bin/bash";
      spawnArgs = ["-c", command];
    } else {
      const writable = [...new Set([realCwd, ...roots.map((r) => realpathSync(r)), scratch])];
      // SP-approvals final review: buildSeatbeltProfile now ALSO denies writing
      // "<root>/.norma/permissions.local.json" for every one of these writable roots,
      // automatically — no extra option to pass here (see that function's own doc comment,
      // sandbox.ts, for the full rationale — same shape bash.ts's foreground spawn gets).
      const profile = buildSeatbeltProfile({ cwd: realCwd, writableRoots: writable.filter((r) => r !== realCwd), allowNetwork });
      spawnFile = "/usr/bin/sandbox-exec";
      spawnArgs = ["-p", profile, "/bin/bash", "-c", command];
    }
    const child: ChildProcess = spawn(spawnFile, spawnArgs, {
      cwd: realCwd, stdio: ["ignore", "pipe", "pipe"], detached: true, env: { ...process.env, TMPDIR: scratch },
    });
    const taskId = `bg_${randomBytes(6).toString("hex")}`;
    // CC parity (TaskOutput deprecated in favor of Read on the task's output file): lazily create
    // <sessionTmpDir>/bash/ (only when a bg task actually starts — every OTHER session never gets
    // one) and tee this task's output there under <taskId>.log. Pre-created empty so the
    // output_file path bash's spawn result hands the model is immediately readable, even for a
    // task that produces no output at all.
    const bashDir = join(scratch, "bash");
    mkdirSync(bashDir, { recursive: true });
    const outFile = join(bashDir, `${taskId}.log`);
    try { writeFileSync(outFile, ""); } catch { /* best-effort — see fileCoalescer's catch below */ }
    const coalescer = new OutputCoalescer((chunk) =>
      this.emit(sessionId, { type: "bg_task_output", sessionId, threadId: "main", taskId, chunk }));
    // File tee: batched (timer/microtask-flushed) like the event coalescer above — NEVER a raw
    // sync write per data event — and capped at this.fileCap with a single trailing note line.
    // Disk failures are swallowed per flush: the ring/bash_output must keep working regardless.
    const fileCoalescer = new OutputCoalescer(
      (chunk) => { try { appendFileSync(outFile, chunk); } catch { /* best-effort */ } },
      { persistCap: this.fileCap, truncationNote: `\n[output file capped at ${fmtCap(this.fileCap)}]` },
    );
    const task: Task = { taskId, sessionId, command, child, status: "running", exitCode: null, ring: "", cursor: 0, ringDropped: false, dropNoted: false, startedAt: Date.now(), coalescer, outFile, fileCoalescer };
    this.tasks.set(taskId, task);

    const onData = (d: Buffer) => {
      const s = d.toString("utf8").replace(DEPRECATION_RE, "");
      if (s.length === 0) return;
      task.fileCoalescer.push(s);
      task.ring += s;
      if (task.ring.length > this.ringCap) {
        const trimmed = task.ring.length - this.ringCap; // bytes actually dropped from the front
        task.ring = task.ring.slice(trimmed);
        task.cursor = Math.max(0, task.cursor - trimmed);
        task.ringDropped = true; // note surfaced once in read(), not stored in the ring (keeps cursor math clean)
      }
      task.coalescer.push(s);
    };
    child.stdout!.on("data", onData);
    child.stderr!.on("data", onData);
    child.on("close", (code) => {
      task.coalescer.dispose();
      task.fileCoalescer.dispose(); // final flush — the file is complete the moment the task ends
      if (task.status !== "killed") task.status = "exited";
      task.exitCode = code;
      this.emit(sessionId, { type: "bg_task_exited", sessionId, threadId: "main", taskId, exitCode: code, killed: task.status === "killed" });
    });
    child.on("error", () => { task.coalescer.dispose(); task.fileCoalescer.dispose(); task.status = "exited"; task.exitCode = -1;
      this.emit(sessionId, { type: "bg_task_exited", sessionId, threadId: "main", taskId, exitCode: -1, killed: false }); });

    this.emit(sessionId, { type: "bg_task_started", sessionId, threadId: "main", taskId, command });
    return taskId;
  }

  read(sessionId: string, taskId: string): { chunk: string; status: string; exitCode: number | null } {
    const t = this.own(sessionId, taskId);
    const start = Math.min(t.cursor, t.ring.length);
    let chunk = t.ring.slice(start);
    t.cursor = t.ring.length;
    if (t.ringDropped && !t.dropNoted) { t.dropNoted = true; chunk = "[background output ring full — oldest output dropped]\n" + chunk; }
    return { chunk, status: t.status, exitCode: t.exitCode };
  }

  /** The output log path this task tees to (CC parity — `bash`'s background-spawn result
   *  surfaces this so the model can Read/grep it directly instead of polling bash_output).
   *  Complete-but-capped: batched flushes land continuously, a final flush happens at task
   *  close/error, and past `fileCap` bytes the file carries one trailing cap-note line instead
   *  of growing further. Throws for an unknown/foreign task, same as read()/kill(). */
  outputFile(sessionId: string, taskId: string): string {
    return this.own(sessionId, taskId).outFile;
  }

  kill(sessionId: string, taskId: string): void {
    const t = this.own(sessionId, taskId);
    if (t.status !== "running") return;
    t.status = "killed";
    try { process.kill(-t.child.pid!, "SIGTERM"); } catch { /* gone */ }
    setTimeout(() => { try { process.kill(-t.child.pid!, "SIGKILL"); } catch { /* gone */ } }, this.killGraceMs);
  }

  list(sessionId: string) {
    return [...this.tasks.values()].filter((t) => t.sessionId === sessionId)
      .map((t) => ({ taskId: t.taskId, command: t.command, status: t.status, exitCode: t.exitCode, startedAt: t.startedAt }));
  }

  killAllForSession(sessionId: string): void {
    for (const t of this.tasks.values()) if (t.sessionId === sessionId && t.status === "running") this.kill(sessionId, t.taskId);
  }
  killAll(): void {
    this.stopped = true;
    for (const t of this.tasks.values()) if (t.status === "running") this.kill(t.sessionId, t.taskId);
  }
}
