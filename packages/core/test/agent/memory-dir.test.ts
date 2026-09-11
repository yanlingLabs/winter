import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  repoRootFor,
  sanitizeProjectKey,
  memoryDirFor,
  memoryDirForRecord,
  memoryProjectKeyFor,
  globalMemoryDirFor,
  _clearRepoRootCacheForTests,
} from "../../src/agent/memory-dir";

function realDir(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "norma-memdir-")));
}

function git(args: string[], cwd: string): { code: number; stdout: string } {
  const p = Bun.spawnSync(["git", "-C", cwd, ...args]);
  return { code: p.exitCode ?? 0, stdout: p.stdout.toString("utf8") };
}

function initRepo(): string {
  const dir = realDir();
  git(["init", "-q"], dir);
  git(["-c", "user.email=t@t.com", "-c", "user.name=t", "commit", "--allow-empty", "-q", "-m", "init"], dir);
  return dir;
}

describe("memory-dir: repoRootFor", () => {
  beforeEach(() => _clearRepoRootCacheForTests());

  test("non-repo cwd resolves to itself", () => {
    const dir = realDir();
    expect(repoRootFor(dir)).toBe(dir);
  });

  test("repo root from the root itself, and from a nested subdirectory, resolve to the same root", () => {
    const root = initRepo();
    const nested = join(root, "a", "b");
    mkdirSync(nested, { recursive: true });
    expect(repoRootFor(root)).toBe(root);
    expect(repoRootFor(nested)).toBe(root);
  });

  test("a linked worktree resolves to the MAIN repo root, not the worktree's own directory", () => {
    const root = initRepo();
    const wtParent = realDir();
    const wtDir = join(wtParent, "wt");
    const add = git(["worktree", "add", "-q", "-b", "wt-branch", wtDir], root);
    expect(add.code).toBe(0);
    expect(repoRootFor(wtDir)).toBe(root);
    expect(repoRootFor(wtDir)).toBe(repoRootFor(root)); // same key for both checkouts
  });

  test("result is memoized (repeat calls for the same cwd don't require repeated git spawns to agree)", () => {
    const root = initRepo();
    const first = repoRootFor(root);
    const second = repoRootFor(root);
    expect(second).toBe(first);
  });
});

describe("memory-dir: sanitizeProjectKey", () => {
  test("replaces path separators with dashes and strips the leading one", () => {
    expect(sanitizeProjectKey("/Users/me/project")).toBe("Users-me-project");
  });

  test("bare filesystem root falls back to 'root' rather than an empty string", () => {
    expect(sanitizeProjectKey("/")).toBe("root");
  });
});

describe("memory-dir: memoryDirFor", () => {
  beforeEach(() => _clearRepoRootCacheForTests());

  test("computes ~/.norma/projects/<key>/memory for a repo cwd", () => {
    const normaHome = realDir();
    const root = initRepo();
    const dir = memoryDirFor(root, { normaHome });
    expect(dir).toBe(join(normaHome, "projects", sanitizeProjectKey(root), "memory"));
  });

  test("a worktree and its main checkout share the SAME memory dir", () => {
    const normaHome = realDir();
    const root = initRepo();
    const wtParent = realDir();
    const wtDir = join(wtParent, "wt");
    git(["worktree", "add", "-q", "-b", "wt-branch2", wtDir], root);
    expect(memoryDirFor(wtDir, { normaHome })).toBe(memoryDirFor(root, { normaHome }));
  });

  test("non-repo cwd keys off the cwd itself", () => {
    const normaHome = realDir();
    const cwd = realDir();
    expect(memoryDirFor(cwd, { normaHome })).toBe(join(normaHome, "projects", sanitizeProjectKey(cwd), "memory"));
  });

  test("settings.memory.directory overrides the computed path entirely (absolute)", () => {
    const normaHome = realDir();
    const root = initRepo();
    const override = realDir();
    expect(memoryDirFor(root, { normaHome, directory: override })).toBe(override);
  });

  test("settings.memory.directory honors a ~/ prefix", () => {
    const normaHome = realDir();
    const root = initRepo();
    const dir = memoryDirFor(root, { normaHome, directory: "~/norma-memdir-override-test-does-not-exist" });
    expect(dir.startsWith("/")).toBe(true);
    expect(dir.endsWith("norma-memdir-override-test-does-not-exist")).toBe(true);
  });

  test("an empty/whitespace-only override is treated as absent", () => {
    const normaHome = realDir();
    const root = initRepo();
    expect(memoryDirFor(root, { normaHome, directory: "   " })).toBe(join(normaHome, "projects", sanitizeProjectKey(root), "memory"));
  });

  test("does not create the directory (pure path computation)", () => {
    const normaHome = realDir();
    const root = initRepo();
    const dir = memoryDirFor(root, { normaHome });
    const exists = Bun.spawnSync(["test", "-d", dir]).exitCode === 0;
    expect(exists).toBe(false);
  });
});

// P8b-17: the live path and WS-16 §17 phase 5 move TOGETHER. The migration relocates
// `projects/<todaysKey>/` to the SDK's compatibility key and re-keys the session's runtime record in
// the same transaction; everything below is what stops this file from still pointing at the empty
// directory the tree used to occupy.
describe("memory-dir: the relocation door (P8b-17)", () => {
  beforeEach(() => _clearRepoRootCacheForTests());

  test("relocatedKey replaces the derived key, and is asked for exactly that key", () => {
    const normaHome = realDir();
    const root = initRepo();
    const todaysKey = sanitizeProjectKey(root);
    const asked: string[] = [];

    const dir = memoryDirFor(root, {
      normaHome,
      relocatedKey: (k) => { asked.push(k); return "compat-key-64"; },
    });

    expect(asked).toEqual([todaysKey]);
    expect(dir).toBe(join(normaHome, "projects", "compat-key-64", "memory"));
  });

  test("a resolver that answers undefined leaves the derivation exactly as it was", () => {
    const normaHome = realDir();
    const root = initRepo();
    expect(memoryDirFor(root, { normaHome, relocatedKey: () => undefined })).toBe(memoryDirFor(root, { normaHome }));
  });

  test("memoryProjectKeyFor names the same key the directory is built from", () => {
    const normaHome = realDir();
    const root = initRepo();
    const opts = { normaHome, relocatedKey: (k: string) => (k === sanitizeProjectKey(root) ? "moved-here" : undefined) };
    expect(memoryProjectKeyFor(root, opts)).toBe("moved-here");
    expect(memoryDirFor(root, opts)).toBe(join(normaHome, "projects", memoryProjectKeyFor(root, opts), "memory"));
  });

  test("the settings override still wins over a relocation — a pinned MEMDIR is never re-keyed", () => {
    const normaHome = realDir();
    const override = realDir();
    const root = initRepo();
    expect(memoryDirFor(root, { normaHome, directory: override, relocatedKey: () => "compat-key-64" })).toBe(override);
  });

  test("memoryDirForRecord reads the record's OWN key — no derivation, no git, no relocation map", () => {
    const normaHome = realDir();
    // Deliberately a key no derivation from this path could produce: the record is the authority.
    expect(memoryDirForRecord({ memoryProjectKey: "some-compat-key" }, { normaHome })).toBe(
      join(normaHome, "projects", "some-compat-key", "memory"),
    );
  });

  test("memoryDirForRecord honours the settings override, same as every other MEMDIR door", () => {
    const normaHome = realDir();
    const override = realDir();
    expect(memoryDirForRecord({ memoryProjectKey: "some-compat-key" }, { normaHome, directory: override })).toBe(override);
  });
});

// T2 (design doc "migration importer" / "dashboard rewire"): the "no project" bucket both the
// importer (legacy USER-scope facts) and the memory.* RPC rewire (a cwd-less request) fall back
// to — see memory-migrate.ts / ipc/server.ts's own doc comments.
describe("memory-dir: globalMemoryDirFor", () => {
  test("computes ~/.norma/projects/_global/memory", () => {
    const normaHome = realDir();
    expect(globalMemoryDirFor({ normaHome })).toBe(join(normaHome, "projects", "_global", "memory"));
  });

  test("never collides with a real project's sanitized key", () => {
    const normaHome = realDir();
    const root = initRepo();
    expect(globalMemoryDirFor({ normaHome })).not.toBe(memoryDirFor(root, { normaHome }));
  });

  test("settings.memory.directory overrides the computed path entirely, same as memoryDirFor", () => {
    const normaHome = realDir();
    const override = realDir();
    expect(globalMemoryDirFor({ normaHome, directory: override })).toBe(override);
  });

  test("an empty/whitespace-only override is treated as absent", () => {
    const normaHome = realDir();
    expect(globalMemoryDirFor({ normaHome, directory: "  " })).toBe(join(normaHome, "projects", "_global", "memory"));
  });
});
