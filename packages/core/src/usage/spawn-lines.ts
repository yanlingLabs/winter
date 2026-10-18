import { spawn } from "node:child_process";
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

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
  /** The child's WHOLE environment (`probeEnv` builds it from an allowlist); nothing else is inherited. */
  env: Record<string, string>;
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
        env: opts.env as NodeJS.ProcessEnv,
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

/** The variables a plan probe inherits — an ALLOWLIST: the user's identity, locale, shell, temp dir, PATH and proxy /
 *  CA settings, plus
 *  the tool's own config-dir variable (`extra`: `CODEX_HOME` / `CLAUDE_CONFIG_DIR`, so it finds its own sign-in where
 *  the user put it). Nothing else crosses: no API key or base URL (`ANTHROPIC_*`, `OPENAI_*`) that would switch the
 *  tool off the user's plan login, no nested-session marker (`CLAUDECODE`, `CLAUDE_CODE_*`, `CODEX_*` sandbox flags),
 *  no `WINTER_*`. */
export const PROBE_ENV_ALLOW = [
  "HOME", "PATH", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "SHELL",
  // A user behind a proxy or a custom CA: the tool's own network call must still reach its service.
  "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy", "ALL_PROXY", "all_proxy",
  "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE",
] as const;

export function probeEnv(extra: readonly string[] = [], from: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of [...PROBE_ENV_ALLOW, ...extra]) {
    const v = from[k];
    if (typeof v === "string" && v.length > 0) out[k] = v;
  }
  return out;
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
 * fall-through), else the usual ABSOLUTE install places first (`installs`), else `$PATH`'s ABSOLUTE entries — a
 * relative entry (`.`, `bin`) would resolve against the daemon's cwd and is never searched.
 */
export function resolveExecutable(name: string, explicit: string | undefined, installs: readonly string[], pathEnv = process.env.PATH ?? ""): string | undefined {
  if (explicit !== undefined) {
    if (explicit === "" || explicit === "off" || !isAbsolute(explicit)) return undefined;
    return isExecutable(explicit) ? explicit : undefined;
  }
  for (const p of installs) if (isAbsolute(p) && existsSync(p) && isExecutable(p)) return p;
  for (const dir of pathEnv.split(delimiter)) {
    if (dir.length === 0 || !isAbsolute(dir)) continue;
    const p = join(dir, name);
    if (isExecutable(p)) return p;
  }
  return undefined;
}
