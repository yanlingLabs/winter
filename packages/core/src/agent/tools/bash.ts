import { z } from "zod";
import { realpathSync } from "node:fs";
import { spawn } from "node:child_process";
import { buildSeatbeltProfile, sandboxAvailable } from "../sandbox";
import type { ToolRegistry } from "./registry";
import type { BackgroundTaskRegistry } from "../bg-registry";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const DEPRECATION_RE = /^sandbox-exec: .*deprecated.*$/gim;
const MAX_CAPTURE = 256 * 1024; // hard bound before the registry's own 64KB cap; prevents OOM on chatty long runs

export function registerBashTool(r: ToolRegistry, deps: { bgRegistry?: BackgroundTaskRegistry } = {}): void {
  r.register({
    name: "bash",
    description: "Run a shell command in the session directory. Confined by a macOS sandbox: writes are limited to the session directory and network is disabled. Combined stdout+stderr is returned with the exit code. Note: bare mktemp may fail under the sandbox (macOS ignores $TMPDIR); use $TMPDIR explicitly, e.g. mktemp \"$TMPDIR/XXXXXX\". Set runInBackground: true to launch long-running commands without blocking; poll output with bash_output and stop them with task_stop. If a prior bash call was blocked by the safety reviewer, pass justification: a short explanation of why this command is necessary and safe; the reviewer will reconsider. It does not affect execution. If a command fails because it needs the network (e.g. git push, npm install, curl, a one-shot ssh), retry it with allowNetwork: true — it still runs sandboxed, with the write fence fully intact, but network is additionally allowed for that one call; this is shown to the user for approval. If a command still fails under allowNetwork because it is fundamentally incompatible with the sandbox (e.g. docker, some gh auth flows), retry with dangerouslyDisableSandbox: true as a last resort — a dangerous override that disables sandboxing entirely (no write fence, full network); it is ALWAYS shown to the user for approval, on every single use, no exceptions. IMPORTANT: Avoid using this tool to run `cat`, `head`, `tail`, `sed`, `awk`, or `echo` commands, unless explicitly instructed or after you have verified that a dedicated tool cannot accomplish your task. Instead, use the appropriate dedicated tool as this will provide a much better experience: Read files with `read`, search with `grep`, list files with `glob`.",
    args: z.object({
      command: z.string().min(1),
      timeoutMs: z.number().int().positive().max(MAX_TIMEOUT_MS).optional(),
      runInBackground: z.boolean().optional(),
      justification: z.string().optional(),
      // SP-approvals Task 11 (spec §8): widens the sandbox for one call — write fence intact,
      // network additionally allowed. The engine's dispatch loop cards every use under `ask` (a
      // matching Bash(prefix:*) rule may silence a LATER matching call; the read-only classifier
      // never can) and lets it run cardless — but still reviewed — under `auto`.
      allowNetwork: z.boolean().optional(),
      // SP-approvals Task 11 (spec §8): CC's exact name — a full sandbox escape, no write fence,
      // no network restriction. The engine ALWAYS cards this, under every policy, and no
      // permission rule can ever silence it.
      dangerouslyDisableSandbox: z.boolean().optional(),
    }),
    async run({ command, timeoutMs, runInBackground, allowNetwork, dangerouslyDisableSandbox }, { cwd, roots, tmpDir, sessionId, signal }) {
      if (runInBackground) {
        if (!deps.bgRegistry) throw new Error("background tasks are not available in this context");
        const taskId = deps.bgRegistry.start(sessionId, command, { allowNetwork, dangerouslyDisableSandbox });
        const outputFile = deps.bgRegistry.outputFile(sessionId, taskId);
        return `background task ${taskId} started\noutput_file: ${outputFile}\nRead or grep that file for the full output as it accumulates — prefer it over bash_output for large output.`;
      }
      const realCwd = realpathSync(cwd);
      const scratch = realpathSync(tmpDir ?? realCwd); // engine always supplies a session tmp; fall back to cwd
      const timeout = timeoutMs ?? DEFAULT_TIMEOUT_MS;

      // SP-approvals Task 11 (spec §8): dangerouslyDisableSandbox skips sandbox-exec entirely — a
      // plain, unsandboxed spawn (no seatbelt profile at all: no write fence, no network deny).
      // By the time run() executes, the engine's dispatch loop has ALREADY carded this call under
      // every policy (no rule/classifier can silence it) — this is purely the execution half of
      // the feature; cwd/$TMPDIR semantics stay identical to the sandboxed path below.
      let spawnFile: string;
      let spawnArgs: string[];
      if (dangerouslyDisableSandbox) {
        spawnFile = "/bin/bash";
        spawnArgs = ["-c", command];
      } else {
        if (!sandboxAvailable()) {
          throw new Error("bash is unavailable: macOS sandbox-exec not found on this host");
        }
        const writable = [...new Set([realCwd, ...roots.map((r) => realpathSync(r)), scratch])];
        // SP-approvals final review: buildSeatbeltProfile now ALSO denies writing
        // "<root>/.norma/permissions.local.json" for every one of these writable roots,
        // automatically — no extra option to pass here. See that function's own doc comment
        // (sandbox.ts) for why a bash-invoked write needs this on top of engine.ts's own
        // dispatch-loop check (which only ever sees the write/edit TOOLS, never a shell command).
        const profile = buildSeatbeltProfile({
          cwd: realCwd,
          writableRoots: writable.filter((r) => r !== realCwd),
          allowNetwork: !!allowNetwork,
        });
        spawnFile = "/usr/bin/sandbox-exec";
        spawnArgs = ["-p", profile, "/bin/bash", "-c", command];
      }

      return await new Promise<string>((resolve) => {
        const child = spawn(spawnFile, spawnArgs, {
          cwd: realCwd,
          stdio: ["ignore", "pipe", "pipe"],
          detached: true,
          env: { ...process.env, TMPDIR: scratch },
        });

        let buf = "";
        let truncated = false;
        const append = (d: Buffer) => {
          if (truncated) return;
          buf += d.toString("utf8");
          if (buf.length > MAX_CAPTURE) {
            buf = buf.slice(0, MAX_CAPTURE);
            truncated = true;
          }
        };
        child.stdout.on("data", append);
        child.stderr.on("data", append);

        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          // Negative pid targets the whole process group. `detached: true` made
          // this child its own group leader (setsid), so this also reaps
          // sandbox-exec, bash, and any forked/backgrounded grandchildren —
          // closing all pipe fds so stream collection unblocks promptly.
          try {
            process.kill(-child.pid!, "SIGKILL");
          } catch {
            /* group already gone */
          }
        }, timeout);

        let aborted = false;
        const onAbort = () => {
          aborted = true;
          // Same group-kill as the timeout path — reaps the whole process
          // group so an interrupted session.turn doesn't leave orphans.
          try {
            process.kill(-child.pid!, "SIGKILL");
          } catch {
            /* group already gone */
          }
        };
        if (signal) {
          if (signal.aborted) onAbort();
          else signal.addEventListener("abort", onAbort, { once: true });
        }

        const finish = (code: number | null) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          const merged = buf.replace(DEPRECATION_RE, "").replace(/\n{3,}/g, "\n\n").trimEnd()
            + (truncated ? "\n[output truncated at 256KB]" : "");
          if (aborted) resolve(`${merged}\n[aborted]`);
          else resolve(timedOut ? `${merged}\n[timed out after ${timeout}ms, killed]` : `${merged}\n[exit ${code}]`);
        };

        child.on("close", (code) => finish(code));
        child.on("error", (err) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          resolve(`failed to launch bash: ${(err as Error).message}\n[exit -1]`);
        });
      });
    },
  });
}
