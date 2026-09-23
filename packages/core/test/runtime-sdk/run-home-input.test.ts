// WS-21 L3.3 (spec §3.1, §3.7; Contract A): the per-generation inputs the daemon hands `buildRunHome`.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHomeInputFor, gitRootFor, _clearGitRootCacheForTests, type RunHomeInputDeps } from "../../src/runtime-sdk/run-home-input";
import { assistantMemoryDirFor, memoryDirFor, repoRootFor, _clearRepoRootCacheForTests } from "../../src/agent/memory-dir";
import { CAPABILITY_SERVER_KEYS, reservedMcpServerNames } from "../../src/capabilities/names";
import type { Settings } from "../../src/settings";

const real = (p: string): string => realpathSync(p);
const tmp = (prefix: string): string => real(mkdtempSync(join(tmpdir(), prefix)));

// Git runs below read config: keep it off the developer's global git config and home.
const saved: Record<string, string | undefined> = {};
beforeAll(() => {
  const fakeHome = tmp("winter-rhi-home-");
  for (const [k, v] of Object.entries({ HOME: fakeHome, XDG_CONFIG_HOME: join(fakeHome, ".config"), GIT_CONFIG_GLOBAL: join(fakeHome, ".gitconfig") })) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  writeFileSync(join(fakeHome, ".gitconfig"), "");
});
afterAll(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
beforeEach(() => { _clearGitRootCacheForTests(); _clearRepoRootCacheForTests(); });

function git(args: string[], cwd: string): void {
  const p = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "ignore", stderr: "ignore" });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed`);
}
function initRepo(): string {
  const dir = tmp("winter-rhi-repo-");
  git(["init", "-q"], dir);
  git(["-c", "user.email=t@t.test", "-c", "user.name=t", "commit", "--allow-empty", "-q", "-m", "init"], dir);
  return dir;
}

const deps = (over: Partial<RunHomeInputDeps> = {}): RunHomeInputDeps => ({
  home: tmp("winter-rhi-h-"),
  trust: { isTrusted: () => false },
  settings: () => null,
  reservedMcpServerNames: [...reservedMcpServerNames()],
  ...over,
});

describe("runHomeInputFor", () => {
  test("an untrusted cwd has NO project tier (trustedProjectRoot null)", () => {
    const repo = initRepo();
    const input = runHomeInputFor(deps(), { mode: "code", dispatchChild: false, leg: "winter", cwd: repo });
    expect(input.trustedProjectRoot).toBeNull();
    expect(input.gitRoot).toBe(repo); // the local tier's anchor is a fact of the repo, not of trust
  });

  test("a trusted cwd names repoRootFor(cwd) as the project root, from a nested directory too", () => {
    const repo = initRepo();
    const nested = join(repo, "a", "b");
    mkdirSync(nested, { recursive: true });
    const input = runHomeInputFor(deps({ trust: { isTrusted: () => true } }), { mode: "code", dispatchChild: false, leg: "official", cwd: nested });
    expect(input.trustedProjectRoot).toBe(repoRootFor(nested));
    expect(input.trustedProjectRoot).toBe(repo);
    expect(input.gitRoot).toBe(repo);
    expect(input.leg).toBe("official");
  });

  test("outside a repository gitRoot is null", () => {
    const dir = tmp("winter-rhi-plain-");
    expect(runHomeInputFor(deps(), { mode: "code", dispatchChild: false, leg: "winter", cwd: dir }).gitRoot).toBeNull();
  });

  test("a worktree's gitRoot is its OWN top (the local tier), while repoRootFor follows the main checkout", () => {
    const repo = initRepo();
    const wt = join(tmp("winter-rhi-wt-"), "wt");
    git(["worktree", "add", "-q", "-b", "wt-branch", wt], repo);
    expect(gitRootFor(wt)).toBe(real(wt));
    expect(repoRootFor(wt)).toBe(repo);
  });

  test("chat and dispatch get the _assistant memory bucket (spec §3.7, the daemon's own injection)", () => {
    const d = deps();
    const cwd = tmp("winter-rhi-cwd-");
    for (const mode of ["chat", "dispatch"] as const) {
      expect(runHomeInputFor(d, { mode, dispatchChild: false, leg: "winter", cwd }).memoryDir).toBe(assistantMemoryDirFor({ winterHome: d.home }));
    }
  });

  test("code gets the project MEMDIR; a workdir-less code session gets _assistant (the assembler's rule)", () => {
    const d = deps();
    const cwd = tmp("winter-rhi-cwd-");
    expect(runHomeInputFor(d, { mode: "code", dispatchChild: false, leg: "winter", cwd }).memoryDir).toBe(memoryDirFor(cwd, { winterHome: d.home }));
    expect(runHomeInputFor(d, { mode: "code", dispatchChild: false, leg: "winter", cwd, workdirLess: true }).memoryDir).toBe(assistantMemoryDirFor({ winterHome: d.home }));
  });

  test("code honours sdk/settings.json autoMemoryDirectory (the moved memory.directory)", () => {
    const d = deps();
    const pinned = tmp("winter-rhi-pinned-");
    mkdirSync(join(d.home, "sdk"), { recursive: true });
    writeFileSync(join(d.home, "sdk", "settings.json"), JSON.stringify({ autoMemoryDirectory: pinned }));
    expect(runHomeInputFor(d, { mode: "code", dispatchChild: false, leg: "winter", cwd: tmp("winter-rhi-cwd-") }).memoryDir).toBe(pinned);
  });

  test("the daemon's relocation-aware memoryDirFor wins when supplied", () => {
    const d = deps({ memoryDirFor: () => "/relocated/memory" });
    expect(runHomeInputFor(d, { mode: "code", dispatchChild: false, leg: "winter", cwd: "/x" }).memoryDir).toBe("/relocated/memory");
  });

  test("a dispatch child is passed through; mcp.disabled comes from the live settings", () => {
    const d = deps({ settings: () => ({ mcp: { disabled: ["noisy"] } }) as unknown as Settings });
    const input = runHomeInputFor(d, { mode: "code", dispatchChild: true, leg: "winter", cwd: "/x" });
    expect(input.dispatchChild).toBe(true);
    expect(input.mcpDisabled).toEqual(["noisy"]);
  });

  test("the reserved names include every winter__<key> capability server, and the brand's own name", () => {
    const input = runHomeInputFor(deps(), { mode: "code", dispatchChild: false, leg: "winter", cwd: "/x" });
    for (const key of CAPABILITY_SERVER_KEYS) expect(input.reservedMcpServerNames).toContain(`winter__${key}`);
    expect(input.reservedMcpServerNames).toContain("winter");
  });
});
