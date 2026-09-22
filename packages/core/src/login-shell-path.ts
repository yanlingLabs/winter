// The daemon's PATH, resolved ONCE at boot from the user's LOGIN shell.
//
// WHY. A daemon launched by the Mac app (a `Process` with no `environment`), by Sparkle's relaunch
// or by the launchd plist inherits LaunchServices' PATH — measured on the live app:
// `/usr/bin:/bin:/usr/sbin:/sbin`. Everything the daemon spawns inherits that in turn: the Winter
// child (`buildChildEnv` forwards PATH verbatim), its Bash tool, every stdio MCP server, the daemon's
// own `McpManager`, plugins. So `node`, `npx`, `gh`, `ffmpeg`… in `/opt/homebrew/bin` were all
// "command not found" in an app-launched session, while a terminal-launched daemon had them.
//
// WHAT. `$SHELL -l -c <script>` — a login shell, which reads `/etc/zprofile` (macOS's `path_helper`)
// and the user's `.zprofile`/`.zshenv` (where `brew shellenv` conventionally lives) — with the user's
// interactive rc file sourced explicitly, stdin from /dev/null and its output discarded. That is the
// shape Claude Code's own shell snapshot uses (`ShellSnapshot.ts`: `[shell, '-c', '-l', script]`,
// `source "<rc>" < /dev/null`, a bounded timeout). The PATH is printed between two markers, so
// whatever an rc file prints to stdout (a banner, nvm, an update prompt) can never be mistaken for
// it. The result is MERGED into `process.env.PATH` — login-shell entries first, then the inherited
// ones, de-duplicated — so every later spawn, whichever launch path started the daemon, sees it.
//
// NEVER HANGS BOOT. Bounded (`LOGIN_SHELL_TIMEOUT_MS`), the shell runs in its own process group and
// the whole group is SIGKILLed on the deadline, and ANY failure (timeout, non-zero exit, no markers,
// a spawn error) falls back to the inherited PATH plus the standard Homebrew directories that exist.
// Never throws.
//
// TESTS NEVER SPAWN THE REAL SHELL. `run` is injectable, and `WINTER_LOGIN_SHELL_PATH=off` (set by
// both test preloads, and inherited by any daemon subprocess a test spawns) turns resolution off.
//
// LOGGING. One line, from `describeLoginShellPath`: the source, the shell, and the directories it
// ADDED. PATH entries are directory names; no other environment value and none of the shell's own
// output is ever logged.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, isAbsolute } from "node:path";

/** The env seam: `off` disables resolution (the test preloads set it). */
export const LOGIN_SHELL_PATH_ENV = "WINTER_LOGIN_SHELL_PATH";
/** Plenty for a login shell (tens to hundreds of ms in practice); short enough that a broken rc
 *  file costs boot a bounded, one-off delay. */
export const LOGIN_SHELL_TIMEOUT_MS = 5_000;
/** The failure fallback only — never appended unconditionally (a working login shell is the
 *  authority on the user's PATH). Order follows `brew shellenv`. */
export const HOMEBREW_FALLBACK_DIRS: readonly string[] = ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin"];
export const LOGIN_SHELL_PATH_START = "__WINTER_LOGIN_PATH_START__";
export const LOGIN_SHELL_PATH_END = "__WINTER_LOGIN_PATH_END__";
/** The fallback shell when `SHELL` is absent (LaunchServices does not always set it), relative, or
 *  a dialect this module has no script for. macOS's default login shell. */
const DEFAULT_SHELL = "/bin/zsh";
const MAX_STDOUT_BYTES = 1024 * 1024;

export type ShellRunResult = { kind: "ok"; stdout: string } | { kind: "timeout" } | { kind: "error"; reason: string };
export type ShellRunner = (shell: string, args: string[], timeoutMs: number, env: Record<string, string | undefined>) => Promise<ShellRunResult>;

export interface LoginShellPathDeps {
  /** The environment to read and UPDATE. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  run?: ShellRunner;
  exists?: (path: string) => boolean;
  timeoutMs?: number;
}

export interface LoginShellPathOutcome {
  source: "login-shell" | "fallback" | "disabled";
  /** The shell that was run (absent when disabled). */
  shell?: string;
  /** Why the fallback was taken. */
  reason?: string;
  /** Directories that were not on PATH before, in their new order. */
  added: string[];
  changed: boolean;
  ms: number;
}

/** The text between the first START marker and the END marker after it, or `undefined` when either
 *  is missing, the value is empty, or it spans a line break (not a PATH). */
export function parseMarkedPath(stdout: string): string | undefined {
  const start = stdout.indexOf(LOGIN_SHELL_PATH_START);
  if (start < 0) return undefined;
  const from = start + LOGIN_SHELL_PATH_START.length;
  const end = stdout.indexOf(LOGIN_SHELL_PATH_END, from);
  if (end < 0) return undefined;
  const value = stdout.slice(from, end);
  if (value === "" || /[\r\n\0]/.test(value)) return undefined;
  return value;
}

/** `first` then `second`, first occurrence wins, empty entries dropped. */
export function mergePathLists(first: readonly string[], second: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of [...first, ...second]) {
    if (entry === "" || seen.has(entry)) continue;
    seen.add(entry);
    out.push(entry);
  }
  return out;
}

const POSIX_SHELLS = new Set(["zsh", "bash", "sh", "ksh", "dash"]);

/** The shell to run and the script for its dialect. An rc file is sourced the way Claude Code's
 *  snapshot sources it — stdin from /dev/null, its output discarded — so PATH additions made there
 *  (nvm, pyenv, a `brew shellenv` line in `.zshrc`) are captured too. */
function shellInvocation(env: Record<string, string | undefined>): { shell: string; args: string[] } {
  const declared = env.SHELL;
  const name = declared !== undefined && isAbsolute(declared) ? basename(declared) : undefined;
  const printPath = `printf '%s' '${LOGIN_SHELL_PATH_START}'; printf '%s' "$PATH"; printf '%s' '${LOGIN_SHELL_PATH_END}'`;
  if (name === "fish") {
    return {
      shell: declared!,
      args: ["-l", "-c", `printf '%s' '${LOGIN_SHELL_PATH_START}'; string join : $PATH; printf '%s' '${LOGIN_SHELL_PATH_END}'`],
    };
  }
  const shell = name !== undefined && POSIX_SHELLS.has(name) ? declared! : DEFAULT_SHELL;
  const rc = basename(shell) === "zsh" ? '"${ZDOTDIR:-$HOME}/.zshrc"' : basename(shell) === "bash" ? '"$HOME/.bashrc"' : undefined;
  const sourceRc = rc === undefined ? "" : `[ -f ${rc} ] && . ${rc} </dev/null >/dev/null 2>&1; `;
  return { shell, args: ["-l", "-c", `${sourceRc}${printPath}`] };
}

/** The real runner: its own process group, stdin ignored, stdout capped. Resolves the moment the END
 *  marker arrives — a background job an rc file started can inherit the pipe and hold it open long
 *  after the shell itself is done, so waiting for `close` would turn a good answer into a timeout —
 *  and on the deadline at the latest, when the whole group is SIGKILLed. */
export const spawnShellRunner: ShellRunner = (shell, args, timeoutMs, env) =>
  new Promise<ShellRunResult>((resolve) => {
    let settled = false;
    let closed = false;
    const done = (r: ShellRunResult): void => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(shell, args, { stdio: ["ignore", "pipe", "ignore"], detached: true, env: env as NodeJS.ProcessEnv });
    } catch (err) {
      resolve({ kind: "error", reason: err instanceof Error ? err.message : String(err) });
      return;
    }
    const killGroup = (): void => {
      try { if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
    };
    // Kept armed after an early answer too: whatever the probe left running in its own group is
    // reaped at the deadline rather than outliving it.
    const timer = setTimeout(() => { if (!closed) killGroup(); done({ kind: "timeout" }); }, timeoutMs);
    timer.unref?.();
    let stdout = "";
    child.stdout?.on("data", (d: Buffer) => {
      if (stdout.length < MAX_STDOUT_BYTES) stdout += d.toString("utf8");
      if (parseMarkedPath(stdout) !== undefined) done({ kind: "ok", stdout });
    });
    child.on("error", (err) => { clearTimeout(timer); done({ kind: "error", reason: err.message }); });
    child.on("close", (code, signal) => {
      closed = true;
      clearTimeout(timer);
      if (code === 0) done({ kind: "ok", stdout });
      // A non-zero exit with the markers already printed still carries a usable PATH (an rc file
      // whose LAST command failed is common); the caller parses and decides.
      else if (parseMarkedPath(stdout) !== undefined) done({ kind: "ok", stdout });
      else done({ kind: "error", reason: signal ? `killed by ${signal}` : `exit ${code}` });
    });
  });

/**
 * Resolve the login shell's PATH and merge it into `deps.env` (default `process.env`). Never throws.
 */
export async function applyLoginShellPath(deps: LoginShellPathDeps = {}): Promise<LoginShellPathOutcome> {
  const env = deps.env ?? process.env;
  const startedAt = Date.now();
  if (env[LOGIN_SHELL_PATH_ENV] === "off") return { source: "disabled", added: [], changed: false, ms: 0 };
  const before = env.PATH ?? "";
  const inherited = before.split(":");
  const { shell, args } = shellInvocation(env);
  const timeoutMs = deps.timeoutMs ?? LOGIN_SHELL_TIMEOUT_MS;
  let result: ShellRunResult;
  try {
    // `DISABLE_AUTO_UPDATE` keeps oh-my-zsh from prompting for an update on a login shell.
    result = await (deps.run ?? spawnShellRunner)(shell, args, timeoutMs, { ...env, DISABLE_AUTO_UPDATE: "true" });
  } catch (err) {
    result = { kind: "error", reason: err instanceof Error ? err.message : String(err) };
  }
  const loginPath = result.kind === "ok" ? parseMarkedPath(result.stdout) : undefined;
  let merged: string[];
  let source: LoginShellPathOutcome["source"];
  let reason: string | undefined;
  if (loginPath !== undefined) {
    source = "login-shell";
    // Relative entries (`.`, `bin`) are never merged: the daemon's cwd is arbitrary, so they would
    // resolve against whatever directory a spawn happens to run in.
    merged = mergePathLists(loginPath.split(":").filter((p) => isAbsolute(p)), inherited);
  } else {
    source = "fallback";
    reason = result.kind === "timeout"
      ? `timed out after ${timeoutMs}ms`
      : result.kind === "error"
        ? `failed (${result.reason.split("\n")[0]!.slice(0, 120)})`
        : "printed no PATH";
    const exists = deps.exists ?? existsSync;
    merged = mergePathLists(HOMEBREW_FALLBACK_DIRS.filter((d) => exists(d)), inherited);
  }
  const inheritedSet = new Set(inherited);
  const added = merged.filter((p) => !inheritedSet.has(p));
  const next = merged.join(":");
  const changed = added.length > 0 && next !== before;
  if (changed) env.PATH = next;
  return { source, shell, ...(reason === undefined ? {} : { reason }), added: changed ? added : [], changed, ms: Date.now() - startedAt };
}

/** The ONE boot log line. Directory names only. */
export function describeLoginShellPath(o: LoginShellPathOutcome): string {
  if (o.source === "disabled") return `env: login-shell PATH resolution is off (${LOGIN_SHELL_PATH_ENV}=off) — PATH unchanged`;
  const effect = o.changed ? `added ${o.added.join(", ")}` : "PATH unchanged";
  if (o.source === "login-shell") return `env: PATH from the login shell (${o.shell}, ${o.ms}ms) — ${effect}`;
  return `env: the login shell (${o.shell}) ${o.reason ?? "failed"} — fell back to the inherited PATH plus the Homebrew dirs present; ${effect}`;
}
