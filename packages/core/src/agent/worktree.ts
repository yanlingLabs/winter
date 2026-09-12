import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface ActiveWorktree {
  name: string;
  dir: string;
  branch: string;
  originalCwd: string;
}

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

function git(args: string[], cwd: string): GitResult {
  const p = Bun.spawnSync(["git", "-C", cwd, ...args]);
  return { code: p.exitCode ?? 0, stdout: p.stdout.toString(), stderr: p.stderr.toString() };
}

/** Pure git worktree lifecycle (add/remove) + per-session active state. No shell, no persistence. */
export class WorktreeManager {
  // hot-settings T2: was a plain boot-captured value; now an optional getter read fresh by
  // currentBaseRef()/resolveBaseRef() on every worktree creation — a later settings reload's new
  // worktree.baseRef applies to the NEXT enter()/createDetached() with no reconstruction.
  private readonly baseRefFn?: () => string | undefined;
  private readonly sessions = new Map<string, ActiveWorktree>();

  constructor(deps?: { baseRef?: () => string | undefined }) {
    this.baseRefFn = deps?.baseRef;
  }

  /** Read fresh on every call — never cached at construction. Anything other than the literal
   *  "head" (absent getter, undefined, or any other string) defaults to "fresh", the SAME default
   *  the pre-getter code applied. Exposed so a test can assert a live settings-holder change is
   *  reflected without reconstructing the manager (hot-settings T2). */
  currentBaseRef(): "fresh" | "head" {
    return this.baseRefFn?.() === "head" ? "head" : "fresh";
  }

  enter(sessionId: string, cwd: string, name?: string): ActiveWorktree {
    const already = this.sessions.get(sessionId);
    if (already) throw new Error(`already in worktree ${already.name}; exit first`);

    const isRepo = git(["rev-parse", "--git-dir"], cwd);
    if (isRepo.code !== 0) throw new Error("not a git repository");

    const toplevel = git(["rev-parse", "--show-toplevel"], cwd);
    if (toplevel.code !== 0) throw new Error("not a git repository");
    const root = toplevel.stdout.trim();

    const wtName = name ?? randomUUID().slice(0, 8);
    const dir = join(root, ".winter", "worktrees", wtName);
    const branch = `winter/${wtName}`;

    if (existsSync(dir)) throw new Error(`worktree dir already exists: ${dir}`);
    const branchList = git(["branch", "--list", branch], root);
    if (branchList.stdout.trim().length > 0) throw new Error(`branch already exists: ${branch}`);

    const base = this.resolveBaseRef(root);

    const add = git(["worktree", "add", dir, "-b", branch, base], root);
    if (add.code !== 0) throw new Error(`git worktree add failed: ${add.stderr.trim()}`);

    const result: ActiveWorktree = { name: wtName, dir, branch, originalCwd: cwd };
    this.sessions.set(sessionId, result);
    return result;
  }

  exit(
    sessionId: string,
    action: "keep" | "remove",
    discardChanges?: boolean,
  ): { name: string; branch: string; removed: boolean; originalCwd: string } {
    const active = this.sessions.get(sessionId);
    if (!active) throw new Error("not currently in a worktree");

    if (action === "remove") {
      if (discardChanges) {
        // Force removal even with uncommitted changes — the caller has explicitly opted in to
        // discarding them (exit_worktree's discard_changes: true).
        const remove = git(["worktree", "remove", "--force", active.dir], active.originalCwd);
        if (remove.code !== 0) throw new Error(`git worktree remove failed: ${remove.stderr.trim()}`);
      } else {
        // Pre-check with `git status --short` (rather than letting a plain `git worktree remove`
        // fail and relaying git's own stderr) so the caller gets the actual dirty-paths listing —
        // exit_worktree's contract promises that listing in the error.
        const status = git(["status", "--short"], active.dir);
        if (status.stdout.trim().length > 0) {
          throw new Error(`refusing to remove: uncommitted changes:\n${status.stdout.trim()}\nre-run with discard_changes: true to delete them`);
        }
        const remove = git(["worktree", "remove", active.dir], active.originalCwd);
        if (remove.code !== 0) throw new Error(`git worktree remove failed: ${remove.stderr.trim()}`);
      }
    }

    this.sessions.delete(sessionId);
    return { name: active.name, branch: active.branch, removed: action === "remove", originalCwd: active.originalCwd };
  }

  active(sessionId: string): ActiveWorktree | undefined {
    return this.sessions.get(sessionId);
  }

  /** Creates an EPHEMERAL worktree for a spawned child (spawn_agent `isolation:"worktree"`,
   *  4h-i Task 4) — does NOT read or write `this.sessions`. Mirrors enter()'s git sequence
   *  exactly (same `.winter/worktrees/<name>` layout, same `winter/<name>` branch naming, same
   *  base-ref resolution) but is a pure create with no per-session bookkeeping: a child's
   *  isolation worktree is per-child and torn down by the SPAWN BRIDGE itself (via
   *  removeDetached below), never by exit_worktree — sharing `sessions` here would let a
   *  child's isolation worktree collide with (or get silently torn down/orphaned by) the
   *  session's own concurrent enter_worktree/exit_worktree state, since both would fight over
   *  the SAME one-slot-per-session map. Throws on any git failure (not a repo, dir/branch
   *  collision, `git worktree add` failure) — same throw-on-failure contract as enter(), so
   *  callers can `try/catch` it identically. */
  createDetached(baseCwd: string, name?: string): { dir: string; branch: string } {
    const isRepo = git(["rev-parse", "--git-dir"], baseCwd);
    if (isRepo.code !== 0) throw new Error("not a git repository");

    const toplevel = git(["rev-parse", "--show-toplevel"], baseCwd);
    if (toplevel.code !== 0) throw new Error("not a git repository");
    const root = toplevel.stdout.trim();

    const wtName = name ?? randomUUID().slice(0, 8);
    const dir = join(root, ".winter", "worktrees", wtName);
    const branch = `winter/${wtName}`;

    if (existsSync(dir)) throw new Error(`worktree dir already exists: ${dir}`);
    const branchList = git(["branch", "--list", branch], root);
    if (branchList.stdout.trim().length > 0) throw new Error(`branch already exists: ${branch}`);

    const base = this.resolveBaseRef(root);
    const add = git(["worktree", "add", dir, "-b", branch, base], root);
    if (add.code !== 0) throw new Error(`git worktree add failed: ${add.stderr.trim()}`);

    return { dir, branch };
  }

  /** Tears down an EPHEMERAL worktree created by createDetached — does NOT touch
   *  `this.sessions`. `cleanOnly: true` (the spawn bridge's only use) mirrors exit_worktree's
   *  default clean-only guard: if `git status --short` inside `dir` shows uncommitted changes,
   *  the worktree is left on disk for the user to review and this returns `false` (no git
   *  removal attempted, no throw — a dirty worktree is an expected, non-exceptional outcome).
   *  `cleanOnly: false` force-removes regardless (mirrors exit()'s discardChanges:true path;
   *  unused by the spawn bridge today — NO auto-merge/auto-discard of a child's work — but kept
   *  symmetric with exit()'s own two removal modes). Returns `true` iff the worktree was
   *  actually removed. Throws only on an unexpected `git worktree remove` failure. */
  removeDetached(dir: string, baseCwd: string, cleanOnly: boolean): boolean {
    if (cleanOnly) {
      const status = git(["status", "--short"], dir);
      if (status.stdout.trim().length > 0) return false; // dirty — leave it, caller logs
    }
    const args = cleanOnly ? ["worktree", "remove", dir] : ["worktree", "remove", "--force", dir];
    const remove = git(args, baseCwd);
    if (remove.code !== 0) throw new Error(`git worktree remove failed: ${remove.stderr.trim()}`);
    return true;
  }

  private resolveBaseRef(root: string): string {
    if (this.currentBaseRef() === "head") return "HEAD";
    const symref = git(["symbolic-ref", "refs/remotes/origin/HEAD"], root);
    if (symref.code !== 0) return "HEAD";
    const ref = symref.stdout.trim();
    const prefix = "refs/remotes/origin/";
    return ref.startsWith(prefix) ? ref.slice(prefix.length) : ref || "HEAD";
  }
}
