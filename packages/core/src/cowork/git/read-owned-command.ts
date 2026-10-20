import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { GitReadError } from "./read-types";

export interface OwnedGitReadCommand {
  file: string; args: readonly string[]; cwd?: string; env: Record<string, string>;
}
export interface OwnedGitReadCommandResult { code: number; stdout: string; stderr: string }
export interface OwnedGitReadCommandLimits { capacity: number; wallMs: number; outputBytes: number; drainMs: number }
/** Test hooks are host-only, never command/RPC fields. The production launcher owns its process group. */
export interface OwnedGitReadCommandFixture {
  isolatedFixture: true; spawn?: typeof spawn; kill?: (pid: number) => void;
}
/** Auxiliary trusted-tool ownership. Failure never discards an unreaped owned child.
 * A drain deadline bounds the caller's wait, not proof that termination occurred. */
export class OwnedGitReadCommandRunner {
  private readonly owners = new Set<object>();
  readonly measurements = { uncertainStops: 0 };
  constructor(private readonly limits: OwnedGitReadCommandLimits, private readonly fixture?: OwnedGitReadCommandFixture) {
    if (fixture && fixture.isolatedFixture !== true) throw new GitReadError("invalid_request");
    this.limits = Object.freeze({ ...limits });
    if (!Object.values(limits).every(value => Number.isSafeInteger(value) && value > 0)
      || limits.capacity > 8 || limits.wallMs > 30_000 || limits.outputBytes > 1_048_576 || limits.drainMs > 5_000) throw new GitReadError("invalid_request");
  }
  get retainedOwnership(): number { return this.owners.size; }
  run(command: OwnedGitReadCommand, signal?: AbortSignal): Promise<OwnedGitReadCommandResult> {
    if (signal?.aborted) return Promise.reject(new GitReadError("cancelled"));
    if (this.owners.size >= this.limits.capacity) return Promise.reject(new GitReadError("busy"));
    const owner = {}; this.owners.add(owner);
    return new Promise((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = (this.fixture?.spawn ?? spawn)(command.file, [...command.args], {
          cwd: command.cwd, env: { ...command.env }, detached: true, stdio: ["pipe", "pipe", "pipe"],
        }) as ChildProcessWithoutNullStreams;
      } catch { this.owners.delete(owner); reject(new GitReadError("integration_unavailable")); return; }
      let exited = false, closed = false, settled = false, code = -1, total = 0;
      let failure: GitReadError | undefined, stdout = "", stderr = "";
      let drain: ReturnType<typeof setTimeout> | undefined, repeat: ReturnType<typeof setInterval> | undefined;
      const finish = () => {
        if (settled) return; settled = true;
        clearTimeout(wall); clearTimeout(drain); clearInterval(repeat); signal?.removeEventListener("abort", abort);
        if (failure) reject(failure); else if (!exited || !closed) reject(new GitReadError("integration_unavailable")); else resolve({ code, stdout, stderr });
      };
      const kill = () => {
        if (!child.pid || exited) return;
        try { if (this.fixture?.kill) this.fixture.kill(child.pid); else process.kill(-child.pid, "SIGKILL"); }
        catch { /* The owned exit event is authoritative; a failed kill never releases admission. */ }
      };
      const stop = (reason: GitReadError["code"]) => {
        failure ??= new GitReadError(reason); kill();
        if (drain) return;
        repeat = setInterval(kill, 50);
        drain = setTimeout(() => {
          if (!exited) this.measurements.uncertainStops++;
          child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); finish();
          // owners retains this child until the installed exit/error listener proves termination/no launch.
        }, this.limits.drainMs);
      };
      const abort = () => stop("cancelled");
      const wall = setTimeout(() => stop("budget_exceeded"), this.limits.wallMs);
      signal?.addEventListener("abort", abort, { once: true });
      child.stdout.on("data", (chunk: Buffer) => { total += chunk.length; if (total > this.limits.outputBytes) stop("budget_exceeded"); else if (!failure) stdout += chunk.toString(); });
      child.stderr.on("data", (chunk: Buffer) => { total += chunk.length; if (total > this.limits.outputBytes) stop("budget_exceeded"); else if (!failure) stderr += chunk.toString(); });
      child.stdout.on("error", () => stop("integration_unavailable")); child.stderr.on("error", () => stop("integration_unavailable"));
      child.stdin.on("error", () => stop("integration_unavailable")); child.stdin.end();
      child.once("error", () => {
        if (!child.pid) { exited = true; closed = true; this.owners.delete(owner); failure ??= new GitReadError("integration_unavailable"); finish(); }
        else stop("integration_unavailable");
      });
      child.once("exit", exitCode => { exited = true; code = exitCode ?? -1; this.owners.delete(owner); });
      child.once("close", () => { closed = true; if (!exited) { stop("integration_unavailable"); return; } finish(); });
      if (signal?.aborted) abort();
    });
  }
}
