import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorktreeManager } from "../../src/agent/worktree";

const isMac = process.platform === "darwin";

function git(args: string[], cwd: string): { code: number; stdout: string; stderr: string } {
  const p = Bun.spawnSync(["git", "-C", cwd, ...args]);
  return { code: p.exitCode ?? 0, stdout: p.stdout.toString(), stderr: p.stderr.toString() };
}

/** mkdtemp + git init + an initial commit so HEAD exists. */
function repo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "winter-wt-")));
  git(["init"], dir);
  git(["config", "user.email", "test@winter.dev"], dir);
  git(["config", "user.name", "Winter Test"], dir);
  writeFileSync(join(dir, "README.md"), "hello\n");
  git(["add", "-A"], dir);
  git(["commit", "-m", "init"], dir);
  return dir;
}

describe.if(isMac)("WorktreeManager", () => {
  test("enter creates the worktree dir + branch (head baseRef)", () => {
    const dir = repo();
    const m = new WorktreeManager({ baseRef: () => "head" });
    const wt = m.enter("s", dir, "feat");
    expect(wt.branch).toBe("winter/feat");
    expect(wt.name).toBe("feat");
    expect(wt.originalCwd).toBe(dir);
    expect(existsSync(wt.dir)).toBe(true);
    expect(m.active("s")).toEqual(wt);
    const listed = git(["branch", "--list", "winter/feat"], dir);
    expect(listed.stdout.trim().length).toBeGreaterThan(0);
  });

  test("enter creates the worktree dir + branch (fresh baseRef, falls back to HEAD without origin)", () => {
    const dir = repo();
    const m = new WorktreeManager({ baseRef: () => "fresh" });
    const wt = m.enter("s", dir, "feat2");
    expect(wt.branch).toBe("winter/feat2");
    expect(existsSync(wt.dir)).toBe(true);
    const listed = git(["branch", "--list", "winter/feat2"], dir);
    expect(listed.stdout.trim().length).toBeGreaterThan(0);
  });

  test("enter default name uses a random 8-char id when omitted", () => {
    const dir = repo();
    const m = new WorktreeManager({ baseRef: () => "head" });
    const wt = m.enter("s", dir);
    expect(wt.name).toMatch(/^[0-9a-f]{8}$/);
  });

  test("active tracks the entered worktree", () => {
    const dir = repo();
    const m = new WorktreeManager({ baseRef: () => "head" });
    expect(m.active("s")).toBeUndefined();
    const wt = m.enter("s", dir, "feat");
    expect(m.active("s")).toEqual(wt);
  });

  test("enter twice for the same session → error", () => {
    const dir = repo();
    const m = new WorktreeManager({ baseRef: () => "head" });
    m.enter("s", dir, "feat");
    expect(() => m.enter("s", dir, "feat2")).toThrow(/already in worktree/);
  });

  test("enter in a non-git dir → error", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "winter-wt-notgit-")));
    const m = new WorktreeManager({ baseRef: () => "head" });
    expect(() => m.enter("s", dir, "feat")).toThrow(/not a git repository/);
  });

  test("exit keep leaves the worktree dir; active is cleared; removed:false", () => {
    const dir = repo();
    const m = new WorktreeManager({ baseRef: () => "head" });
    const wt = m.enter("s", dir, "feat");
    const result = m.exit("s", "keep");
    expect(result).toEqual({ name: "feat", branch: "winter/feat", removed: false, originalCwd: dir });
    expect(existsSync(wt.dir)).toBe(true);
    expect(m.active("s")).toBeUndefined();
  });

  test("exit remove (clean) removes the worktree dir; removed:true", () => {
    const dir = repo();
    const m = new WorktreeManager({ baseRef: () => "head" });
    const wt = m.enter("s", dir, "feat");
    const result = m.exit("s", "remove");
    expect(result).toEqual({ name: "feat", branch: "winter/feat", removed: true, originalCwd: dir });
    expect(existsSync(wt.dir)).toBe(false);
    expect(m.active("s")).toBeUndefined();
  });

  test("exit remove (dirty) refuses without discardChanges — error lists the git status --short output", () => {
    const dir = repo();
    const m = new WorktreeManager({ baseRef: () => "head" });
    const wt = m.enter("s", dir, "feat");
    writeFileSync(join(wt.dir, "dirty.txt"), "uncommitted\n");
    expect(() => m.exit("s", "remove")).toThrow(/refusing to remove: uncommitted changes:/);
    expect(() => m.exit("s", "remove")).toThrow(/dirty\.txt/);
    expect(() => m.exit("s", "remove")).toThrow(/re-run with discard_changes: true to delete them/);
    // the worktree must still be there — the guard refused the removal.
    expect(existsSync(wt.dir)).toBe(true);
    expect(m.active("s")).toBeDefined(); // still active — exit() never got past the pre-check
  });

  test("exit remove (dirty) with discardChanges:true force-removes despite uncommitted changes", () => {
    const dir = repo();
    const m = new WorktreeManager({ baseRef: () => "head" });
    const wt = m.enter("s", dir, "feat");
    writeFileSync(join(wt.dir, "dirty.txt"), "uncommitted\n");
    const result = m.exit("s", "remove", true);
    expect(result).toEqual({ name: "feat", branch: "winter/feat", removed: true, originalCwd: dir });
    expect(existsSync(wt.dir)).toBe(false);
    expect(m.active("s")).toBeUndefined();
  });

  test("exit when not in a worktree → error", () => {
    const m = new WorktreeManager({ baseRef: () => "head" });
    expect(() => m.exit("no-such-session", "keep")).toThrow(/not currently in a worktree/);
  });
});

// 4h-i Task 4 (CC parity: spawn_agent isolation:"worktree"): createDetached/removeDetached are
// STATELESS — they must never touch `this.sessions`, the per-session active-worktree map
// enter()/exit() use. That's the whole point: a spawned child's ephemeral isolation worktree
// must be able to coexist with (and be torn down completely independently of) a user's own
// concurrent enter_worktree/exit_worktree session state.
describe.if(isMac)("WorktreeManager: createDetached/removeDetached (stateless, 4h-i Task 4)", () => {
  test("createDetached creates the worktree dir + branch, same layout as enter(), WITHOUT touching sessions state", () => {
    const dir = repo();
    const m = new WorktreeManager({ baseRef: () => "head" });
    const wt = m.createDetached(dir, "spawn-feat");
    expect(wt.branch).toBe("winter/spawn-feat");
    expect(existsSync(wt.dir)).toBe(true);
    const listed = git(["branch", "--list", "winter/spawn-feat"], dir);
    expect(listed.stdout.trim().length).toBeGreaterThan(0);
    // no per-session bookkeeping — active() sees nothing
    expect(m.active("any-session")).toBeUndefined();
  });

  test("createDetached default name uses a random 8-char id when omitted", () => {
    const dir = repo();
    const m = new WorktreeManager({ baseRef: () => "head" });
    const wt = m.createDetached(dir);
    expect(wt.branch).toMatch(/^winter\/[0-9a-f]{8}$/);
    expect(existsSync(wt.dir)).toBe(true);
  });

  test("createDetached does NOT collide with an active session worktree (enter() + createDetached() coexist)", () => {
    const dir = repo();
    const m = new WorktreeManager({ baseRef: () => "head" });
    const sessionWt = m.enter("s1", dir, "session-feat"); // occupies the session's ONE slot
    const childWt = m.createDetached(dir, "spawn-child"); // must NOT throw "already in worktree"
    expect(existsSync(sessionWt.dir)).toBe(true);
    expect(existsSync(childWt.dir)).toBe(true);
    expect(childWt.dir).not.toBe(sessionWt.dir);
    // the session's active-worktree state is completely unaffected by the detached create
    expect(m.active("s1")).toEqual(sessionWt);
  });

  test("createDetached in a non-git dir → error", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "winter-wt-notgit-")));
    const m = new WorktreeManager({ baseRef: () => "head" });
    expect(() => m.createDetached(dir, "x")).toThrow(/not a git repository/);
  });

  test("removeDetached (clean, cleanOnly:true) removes the worktree dir, returns true, does NOT touch sessions", () => {
    const dir = repo();
    const m = new WorktreeManager({ baseRef: () => "head" });
    const wt = m.createDetached(dir, "spawn-clean");
    const removed = m.removeDetached(wt.dir, dir, true);
    expect(removed).toBe(true);
    expect(existsSync(wt.dir)).toBe(false);
  });

  test("removeDetached (dirty, cleanOnly:true) leaves the worktree on disk, returns false, does NOT throw", () => {
    const dir = repo();
    const m = new WorktreeManager({ baseRef: () => "head" });
    const wt = m.createDetached(dir, "spawn-dirty");
    writeFileSync(join(wt.dir, "dirty.txt"), "uncommitted\n");
    const removed = m.removeDetached(wt.dir, dir, true);
    expect(removed).toBe(false);
    expect(existsSync(wt.dir)).toBe(true); // left in place — no data loss
  });

  test("removeDetached (dirty, cleanOnly:false) force-removes despite uncommitted changes", () => {
    const dir = repo();
    const m = new WorktreeManager({ baseRef: () => "head" });
    const wt = m.createDetached(dir, "spawn-force");
    writeFileSync(join(wt.dir, "dirty.txt"), "uncommitted\n");
    const removed = m.removeDetached(wt.dir, dir, false);
    expect(removed).toBe(true);
    expect(existsSync(wt.dir)).toBe(false);
  });

  test("createDetached + removeDetached never mutate an unrelated active session worktree", () => {
    const dir = repo();
    const m = new WorktreeManager({ baseRef: () => "head" });
    const sessionWt = m.enter("s1", dir, "session-feat2");
    const childWt = m.createDetached(dir, "spawn-child2");
    m.removeDetached(childWt.dir, dir, true);
    expect(existsSync(childWt.dir)).toBe(false); // child's worktree gone
    expect(existsSync(sessionWt.dir)).toBe(true); // session's own worktree untouched
    expect(m.active("s1")).toEqual(sessionWt); // session state untouched
  });
});
