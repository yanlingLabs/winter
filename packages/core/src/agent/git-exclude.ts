// WS-21 (spec §4.3, F21): keep a project's personal `.winter/settings.local.json` out of git, the way
// claude keeps `.claude/settings.local.json` out of it.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

/** The pattern appended to the global excludes (claude's own, with Winter's project dir). */
export const LOCAL_SETTINGS_EXCLUDE = "**/.winter/settings.local.json";

/** `git -C <dir> <args>`, inheriting the process env (HOME, XDG_CONFIG_HOME, GIT_CONFIG_GLOBAL). */
function git(dir: string, args: string[]): { code: number; stdout: string } {
  try {
    const p = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "ignore", env: process.env });
    return { code: p.exitCode ?? 1, stdout: p.stdout.toString() };
  } catch {
    return { code: 1, stdout: "" };
  }
}

/** The home directory as GIT sees it: `$HOME` (git's own rule), else the OS answer. Read live on every
 *  call — Bun's `os.homedir()` is fixed at process start, and the global excludes file must be the one
 *  the `git` this module spawns will read. */
function gitHome(): string {
  const h = process.env.HOME;
  return h !== undefined && h !== "" ? h : homedir();
}

/** `~` / `~/x` → the home directory (git's own expansion of `core.excludesfile`). */
function expandTilde(p: string): string {
  if (p === "~") return gitHome();
  if (p.startsWith("~/")) return join(gitHome(), p.slice(2));
  return p;
}

/**
 * The global excludes file git reads, resolved as git and claude do: `git config --global
 * core.excludesfile` when set, else `$XDG_CONFIG_HOME/git/ignore` (a non-empty `XDG_CONFIG_HOME`), else
 * `~/.config/git/ignore`.
 */
export function globalGitExcludesFile(cwd: string): string {
  const configured = git(cwd, ["config", "--global", "--get", "core.excludesfile"]);
  const value = configured.code === 0 ? configured.stdout.trim() : "";
  if (value !== "") {
    const expanded = expandTilde(value);
    return isAbsolute(expanded) ? expanded : resolve(gitHome(), expanded);
  }
  const xdg = process.env.XDG_CONFIG_HOME;
  return join(xdg !== undefined && xdg !== "" ? xdg : join(gitHome(), ".config"), "git", "ignore");
}

/**
 * claude parity (2.1.250 D6t): inside a git repo, when `git check-ignore` says the file is not ignored,
 * append `**\/.winter/settings.local.json` to `git config --global core.excludesfile`, else
 * `$XDG_CONFIG_HOME/git/ignore`, else `~/.config/git/ignore`. Idempotent.
 *
 * Best-effort, never throws: a global excludes file that cannot be written is a cosmetic loss (git
 * shows the file as untracked), never a reason to fail the save that triggered it. Only ever APPENDS —
 * existing lines are never rewritten, and a pattern already present (by hand) is not duplicated.
 */
export function ensureGlobalGitExclude(gitRoot: string): void {
  const inside = git(gitRoot, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.code !== 0 || inside.stdout.trim() !== "true") return;
  // Exit 0 = ignored already (the repo's own .gitignore, info/exclude, or the global file).
  if (git(gitRoot, ["check-ignore", "-q", join(".winter", "settings.local.json")]).code === 0) return;
  const path = globalGitExcludesFile(gitRoot);
  try {
    const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
    if (existing.split(/\r?\n/).some((l) => l.trim() === LOCAL_SETTINGS_EXCLUDE)) return;
    if (!existsSync(path)) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${LOCAL_SETTINGS_EXCLUDE}\n`);
      return;
    }
    const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
    appendFileSync(path, `${prefix}${LOCAL_SETTINGS_EXCLUDE}\n`);
  } catch (err) {
    console.error(`git-exclude: could not update ${path} (${(err as NodeJS.ErrnoException)?.code ?? "error"}) — .winter/settings.local.json may show as untracked`);
  }
}
