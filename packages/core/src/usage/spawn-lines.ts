import { spawn } from "node:child_process";
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";

// Spawning the user's own `codex` / `claude` for a plan reading (`docs/claude/usage.md`): one short-lived child in
// its OWN process group (so a timeout kills the whole tree), stdout read as lines, a hard deadline. Nothing it prints
// is logged.

export interface LineChild {
  /** Write one line to the child's stdin. */
  send(obj: unknown): void;
  /** Close stdin. */
  endInput(): void;
}

export interface RunOptions {
  args: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** Inherited variables to leave out of the child's environment. */
  dropEnv?: (key: string) => boolean;
  timeoutMs: number;
  /** Each stdout line; return a value to finish (the child is then shut down) or undefined to keep reading. */
  onLine: (line: string, child: LineChild) => unknown;
  onStart?: (child: LineChild) => void;
  /** `ignore` = stdin from /dev/null (a child that waits on an open stdin otherwise). Default `pipe`. */
  stdin?: "pipe" | "ignore";
  /** Bytes of stdout read at most (a runaway child is killed). */
  maxBytes?: number;
}

export type RunOutcome =
  | { kind: "done"; value: unknown }
  | { kind: "timeout" }
  | { kind: "exited"; code: number | null }
  | { kind: "spawn-failed" }
  | { kind: "too-large" };

function killGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  try { process.kill(-pid, signal); } catch { try { process.kill(pid, signal); } catch { /* gone */ } }
}

export function runLines(executable: string, opts: RunOptions): Promise<RunOutcome> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(executable, opts.args, {
        cwd: opts.cwd,
        env: Object.fromEntries(Object.entries({ ...process.env, ...opts.env })
          .filter(([k, v]) => v !== undefined && !(opts.dropEnv?.(k) ?? false))) as NodeJS.ProcessEnv,
        stdio: [opts.stdin ?? "pipe", "pipe", "ignore"], detached: true,
      });
    } catch {
      resolve({ kind: "spawn-failed" });
      return;
    }
    let settled = false;
    let buf = "";
    let bytes = 0;
    const maxBytes = opts.maxBytes ?? 4 * 1024 * 1024;
    const io: LineChild = {
      send: (obj) => { try { child.stdin?.write(`${JSON.stringify(obj)}\n`); } catch { /* closed */ } },
      endInput: () => { try { child.stdin?.end(); } catch { /* closed */ } },
    };
    const finish = (outcome: RunOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      io.endInput();
      if (child.exitCode === null && child.signalCode === null) {
        killGroup(child.pid, "SIGTERM");
        // A child that ignores SIGTERM is killed outright shortly after; unref'd, so it never holds the daemon.
        const hard = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) killGroup(child.pid, "SIGKILL"); }, 1_500);
        hard.unref?.();
      }
      resolve(outcome);
    };
    const timer = setTimeout(() => {
      killGroup(child.pid, "SIGKILL");
      finish({ kind: "timeout" });
    }, opts.timeoutMs);
    timer.unref?.();
    child.on("error", () => finish({ kind: "spawn-failed" }));
    child.stdin?.on("error", () => { /* EPIPE: the child went away */ });
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > maxBytes) { killGroup(child.pid, "SIGKILL"); finish({ kind: "too-large" }); return; }
      buf += chunk;
      for (let i = buf.indexOf("\n"); i !== -1 && !settled; i = buf.indexOf("\n")) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line.length === 0) continue;
        let value: unknown;
        try { value = opts.onLine(line, io); } catch { value = undefined; }
        if (value !== undefined) finish({ kind: "done", value });
      }
    });
    child.on("close", (code) => {
      if (settled) return;
      const tail = buf.trim();
      if (tail.length > 0) {
        let value: unknown;
        try { value = opts.onLine(tail, io); } catch { value = undefined; }
        if (value !== undefined) { finish({ kind: "done", value }); return; }
      }
      finish({ kind: "exited", code });
    });
    try { opts.onStart?.(io); } catch { /* the caller's own */ }
  });
}

function isExecutable(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false;
    accessSync(p, constants.X_OK);
    return true;
  } catch { return false; }
}

/**
 * The user's own `name` executable: an explicit override (authoritative — missing or "off" means none, never a
 * fall-through), else `$PATH`, else the usual install places.
 */
export function resolveExecutable(name: string, explicit: string | undefined, extra: readonly string[], pathEnv = process.env.PATH ?? ""): string | undefined {
  if (explicit !== undefined) {
    if (explicit === "" || explicit === "off") return undefined;
    return isExecutable(explicit) ? explicit : undefined;
  }
  for (const dir of pathEnv.split(delimiter)) {
    if (dir.length === 0) continue;
    const p = join(dir, name);
    if (isExecutable(p)) return p;
  }
  for (const p of extra) if (existsSync(p) && isExecutable(p)) return p;
  return undefined;
}
