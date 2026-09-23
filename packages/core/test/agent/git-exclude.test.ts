// WS-21 L3.5 (spec §4.3, F21 — claude 2.1.250 D6t): writing `.winter/settings.local.json` inside a git
// repo that does not already ignore it appends `**/.winter/settings.local.json` to the user's GLOBAL git
// excludes — `core.excludesfile`, else `$XDG_CONFIG_HOME/git/ignore`, else `~/.config/git/ignore`.
// Every test runs git with a temp HOME, XDG_CONFIG_HOME and GIT_CONFIG_GLOBAL: the developer's own git
// config is never read or written.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureGlobalGitExclude, LOCAL_SETTINGS_EXCLUDE } from "../../src/agent/git-exclude";

const tmp = (p: string): string => realpathSync(mkdtempSync(join(tmpdir(), p)));
const ENV_KEYS = ["HOME", "XDG_CONFIG_HOME", "GIT_CONFIG_GLOBAL"] as const;
let saved: Record<string, string | undefined> = {};
let home: string;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  home = tmp("winter-gitx-home-");
  process.env.HOME = home;
  delete process.env.XDG_CONFIG_HOME;
  process.env.GIT_CONFIG_GLOBAL = join(home, ".gitconfig");
  writeFileSync(join(home, ".gitconfig"), "");
});
afterEach(() => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

function repo(): string {
  const dir = tmp("winter-gitx-repo-");
  const p = Bun.spawnSync(["git", "-C", dir, "init", "-q"], { env: process.env });
  if (p.exitCode !== 0) throw new Error("git init failed");
  return dir;
}
const lines = (path: string): string[] => readFileSync(path, "utf8").split("\n").filter(Boolean);

describe("ensureGlobalGitExclude", () => {
  test("no core.excludesfile, no XDG: appends to ~/.config/git/ignore, exactly once", () => {
    const r = repo();
    ensureGlobalGitExclude(r);
    ensureGlobalGitExclude(r); // idempotent: already ignored now
    const path = join(home, ".config", "git", "ignore");
    expect(lines(path)).toEqual([LOCAL_SETTINGS_EXCLUDE]);
    expect(LOCAL_SETTINGS_EXCLUDE).toBe("**/.winter/settings.local.json");
  });

  test("$XDG_CONFIG_HOME wins over ~/.config", () => {
    const xdg = tmp("winter-gitx-xdg-");
    process.env.XDG_CONFIG_HOME = xdg;
    ensureGlobalGitExclude(repo());
    expect(lines(join(xdg, "git", "ignore"))).toEqual([LOCAL_SETTINGS_EXCLUDE]);
    expect(existsSync(join(home, ".config", "git", "ignore"))).toBe(false);
  });

  test("core.excludesfile wins over both (a ~/ path expanded), and existing lines are kept", () => {
    process.env.XDG_CONFIG_HOME = tmp("winter-gitx-xdg-");
    writeFileSync(join(home, ".gitconfig"), "[core]\n\texcludesfile = ~/my-excludes\n");
    writeFileSync(join(home, "my-excludes"), "*.log"); // no trailing newline
    ensureGlobalGitExclude(repo());
    expect(lines(join(home, "my-excludes"))).toEqual(["*.log", LOCAL_SETTINGS_EXCLUDE]);
  });

  test("a repo that already ignores the file (its own .gitignore) is left alone — nothing global is written", () => {
    const r = repo();
    writeFileSync(join(r, ".gitignore"), ".winter/\n");
    ensureGlobalGitExclude(r);
    expect(existsSync(join(home, ".config", "git", "ignore"))).toBe(false);
  });

  test("outside a git repository nothing is written", () => {
    ensureGlobalGitExclude(tmp("winter-gitx-plain-"));
    expect(existsSync(join(home, ".config", "git", "ignore"))).toBe(false);
  });

  test("a pattern already present (added by hand) is not duplicated", () => {
    const path = join(home, ".config", "git", "ignore");
    mkdirSync(join(home, ".config", "git"), { recursive: true });
    writeFileSync(path, `${LOCAL_SETTINGS_EXCLUDE}\n`);
    ensureGlobalGitExclude(repo());
    expect(lines(path)).toEqual([LOCAL_SETTINGS_EXCLUDE]);
  });
});
