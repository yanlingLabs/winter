import { spawn } from "node:child_process";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { GitPublicationError, type GitCommand, type GitExecutor, type GitResult } from "./types";

let defaultExecutable: string | undefined;
/** Never invoke macOS's /usr/bin/git xcrun shim, which can open a CLT installer. */
export function resolveGitExecutable(): string {
  if (defaultExecutable) return defaultExecutable;
  const candidates = process.platform === "darwin"
    ? ["/Library/Developer/CommandLineTools/usr/bin/git", "/Applications/Xcode.app/Contents/Developer/usr/bin/git"]
    : ["/usr/bin/git"];
  for (const candidate of candidates) {
    try { accessSync(candidate, constants.X_OK); if (statSync(candidate).isFile()) return defaultExecutable = realpathSync(candidate); }
    catch { /* Missing toolchains remain unavailable; never launch discovery/UI helpers. */ }
  }
  throw new GitPublicationError("integration_unavailable");
}

/** Fixed executable, argv-only, fresh environment, no ambient Git configuration or helpers. */
export class IsolatedGitExecutor implements GitExecutor {
  constructor(private readonly executable = resolveGitExecutable(), private readonly timeoutMs = 15_000,
    private readonly maxOutputBytes = 1_048_576, private readonly killWaitMs = 1_000) {
    if (!isAbsolute(executable) || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0 || !Number.isSafeInteger(killWaitMs) || killWaitMs <= 0) throw new GitPublicationError("invalid_request");
    try {
      this.executable = realpathSync(executable); accessSync(this.executable, constants.X_OK);
      if (!statSync(this.executable).isFile() || (process.platform === "darwin" && this.executable === "/usr/bin/git")) throw new Error();
    } catch { throw new GitPublicationError("invalid_request"); }
  }
  run(command: GitCommand): Promise<GitResult> {
    if (command.signal?.aborted) return Promise.reject(new GitPublicationError("cancelled"));
    return new Promise((resolve, reject) => {
      const child = spawn(this.executable, ["-c", "core.hooksPath=/dev/null", "-c", "credential.helper=", "-c", "protocol.allow=never", "-c", "protocol.file.allow=always", "-c", "http.followRedirects=false", "-c", "core.attributesFile=/dev/null", "-c", "core.fsmonitor=false", ...command.args], {
        cwd: command.cwd, stdio: ["ignore", "pipe", "pipe"], detached: true,
        env: { PATH: "/usr/bin:/bin", HOME: command.home, XDG_CONFIG_HOME: command.home, LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_NO_REPLACE_OBJECTS: "1", GIT_PROTOCOL_FROM_USER: "0", GIT_ALLOW_PROTOCOL: "file" },
      });
      let stdout = "", bytes = 0, failure: GitPublicationError | undefined, settled = false, budgetRunning = false;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const clean = () => { clearTimeout(timer); clearTimeout(killTimer); clearInterval(budget); command.signal?.removeEventListener("abort", abort); };
      const finish = (code?: number | null) => {
        if (settled) return; settled = true; clean();
        if (failure) reject(failure); else resolve({ code: code ?? -1, stdout });
      };
      const stop = (code: "command_failed" | "cancelled" | "object_budget") => {
        if (settled || failure) return;
        failure = new GitPublicationError(code);
        // Git delegates pack parsing to helpers. Kill the owned group, not just
        // its leader. An escaped descendant may retain output pipes; bound waiting too.
        if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* close/error owns settlement */ } }
        killTimer = setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); finish(); }, this.killWaitMs);
      };
      const abort = () => stop("cancelled");
      const timer = setTimeout(() => stop("command_failed"), this.timeoutMs);
      // Asynchronous checks, at most one in flight; never synchronously walk the
      // entire quarantine every 10 ms on the daemon's event loop.
      const budget = setInterval(() => {
        if (settled || failure || budgetRunning || !command.withinBudget) return;
        budgetRunning = true;
        Promise.resolve().then(command.withinBudget).then(ok => { if (!ok) stop("object_budget"); }, () => stop("object_budget"))
          .finally(() => { budgetRunning = false; });
      }, 250);
      command.signal?.addEventListener("abort", abort, { once: true });
      const read = (chunk: Buffer, out: boolean) => { bytes += chunk.length; if (bytes > this.maxOutputBytes) stop("command_failed"); else if (out) stdout += chunk.toString("utf8"); };
      child.stdout.on("data", chunk => read(chunk, true)); child.stderr.on("data", chunk => read(chunk, false));
      child.on("error", () => { failure ??= new GitPublicationError("command_failed"); finish(); });
      child.on("close", code => finish(code));
      if (command.signal?.aborted) abort();
    });
  }
}
