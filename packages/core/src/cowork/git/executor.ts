import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { GitPublicationError, type GitCommand, type GitExecutor, type GitResult } from "./types";

/** Fixed executable, argv-only, fresh environment, no ambient Git configuration or helpers. */
export class IsolatedGitExecutor implements GitExecutor {
  constructor(private readonly executable = "/usr/bin/git", private readonly timeoutMs = 15_000, private readonly maxOutputBytes = 1_048_576) {
    if (!isAbsolute(executable) || timeoutMs <= 0 || maxOutputBytes <= 0) throw new GitPublicationError("invalid_request");
  }
  run(command: GitCommand): Promise<GitResult> {
    if (command.signal?.aborted) return Promise.reject(new GitPublicationError("cancelled"));
    return new Promise((resolve, reject) => {
      const child = spawn(this.executable, ["-c", "core.hooksPath=/dev/null", "-c", "credential.helper=", "-c", "protocol.allow=never", "-c", "protocol.file.allow=always", "-c", "http.followRedirects=false", "-c", "core.attributesFile=/dev/null", "-c", "core.fsmonitor=false", ...command.args], {
        cwd: command.cwd, stdio: ["ignore", "pipe", "pipe"], detached: true,
        env: { PATH: "/usr/bin:/bin", HOME: command.home, XDG_CONFIG_HOME: command.home, LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_NO_REPLACE_OBJECTS: "1", GIT_PROTOCOL_FROM_USER: "0", GIT_ALLOW_PROTOCOL: "file" },
      });
      let stdout = "", bytes = 0, failure: GitPublicationError | undefined;
      const stop = (code: "command_failed" | "cancelled" | "object_budget") => {
        failure ??= new GitPublicationError(code);
        // Git delegates pack parsing to helpers. Kill the owned group, not just its leader,
        // and settle only when inherited output pipes close. No caller-supplied PID exists.
        if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* close/error owns settlement */ } }
      };
      const abort = () => stop("cancelled");
      const timer = setTimeout(() => stop("command_failed"), this.timeoutMs);
      const budget = setInterval(() => { try { if (command.withinBudget && !command.withinBudget()) stop("object_budget"); } catch { stop("object_budget"); } }, 10);
      command.signal?.addEventListener("abort", abort, { once: true });
      const read = (chunk: Buffer, out: boolean) => { bytes += chunk.length; if (bytes > this.maxOutputBytes) stop("command_failed"); else if (out) stdout += chunk.toString("utf8"); };
      child.stdout.on("data", chunk => read(chunk, true)); child.stderr.on("data", chunk => read(chunk, false));
      const clean = () => { clearTimeout(timer); clearInterval(budget); command.signal?.removeEventListener("abort", abort); };
      child.on("error", () => { clean(); reject(new GitPublicationError("command_failed")); });
      child.on("close", code => { clean(); if (failure) reject(failure); else resolve({ code: code ?? -1, stdout }); });
      if (command.signal?.aborted) abort();
    });
  }
}
