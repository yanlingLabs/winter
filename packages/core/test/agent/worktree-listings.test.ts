// WS-24: the daemon's listing surfaces name what a session in a LINKED WORKTREE of a trusted repository
// actually loads. Trust is keyed on the repository (`projectScopeTrusted` — the worktree's own path is not in
// `trust.json`), and the items are read along the walk from the cwd up to the project scope's root (the
// worktree's OWN git top, `projectScopeRootFor`) — the walk the run home loads them along. Before, each of
// these checked trust on the cwd's own path and read `<cwd>/.winter/…` only, so a worktree listed nothing.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TrustStore } from "../../src/agent/trust";
import { OutputStyleStore } from "../../src/agent/output-styles";
import { WorkflowStore } from "../../src/workflows/store";
import { MemoryStore } from "../../src/agent/memory";
import { trustedProjectWalk } from "../../src/agent/project-scope-dirs";
import { sessionPermissionDirs } from "../../src/daemon";
import { _clearGitRootCacheForTests } from "../../src/runtime-sdk/run-home-input";
import { _clearRepoRootCacheForTests } from "../../src/agent/memory-dir";

const tmp = (p: string): string => realpathSync(mkdtempSync(join(tmpdir(), p)));

function repoWithWorktree(): { main: string; wt: string; parent: string } {
  const main = tmp("winter-ws24-wt-main-");
  const git = (...args: string[]) => expect(Bun.spawnSync(["git", "-C", main, ...args], { stderr: "ignore" }).exitCode).toBe(0);
  git("init", "-q");
  writeFileSync(join(main, "f"), "x");
  git("add", "f");
  git("commit", "-q", "-m", "init");
  const parent = tmp("winter-ws24-wt-parent-");
  const wt = join(parent, "wt");
  git("worktree", "add", "-q", "-b", "side", wt);
  return { main, wt: realpathSync(wt), parent };
}

function write(path: string, body: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, body);
}

describe("listing surfaces from a linked worktree of a trusted repo (WS-24)", () => {
  let home: string;
  let repo: ReturnType<typeof repoWithWorktree>;
  let trust: TrustStore;

  beforeAll(() => {
    _clearGitRootCacheForTests();
    _clearRepoRootCacheForTests();
    home = tmp("winter-ws24-wt-home-");
    repo = repoWithWorktree();
    trust = new TrustStore(join(home, "trust.json"));
    trust.trust(repo.main); // the MAIN checkout — never the worktree's own path
    expect(trust.isTrusted(repo.wt)).toBe(false);
    const wt = repo.wt;
    write(join(wt, ".winter", "output-styles", "wt-style.md"), "---\ndescription: from the worktree root\n---\nbody");
    write(join(wt, "pkg", ".winter", "output-styles", "wt-style.md"), "---\ndescription: from pkg\n---\nnearer body");
    write(join(wt, "pkg", ".winter", "output-styles", "pkg-only.md"), "---\ndescription: pkg only\n---\nbody");
    write(join(wt, ".winter", "workflows", "wt-flow.js"), "export const meta = { description: 'root flow' };\n");
    write(join(wt, "pkg", ".winter", "workflows", "wt-flow.js"), "export const meta = { description: 'pkg flow' };\n");
    mkdirSync(join(wt, "pkg", "deep"), { recursive: true });
  });
  afterAll(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(repo.main, { recursive: true, force: true });
    rmSync(repo.parent, { recursive: true, force: true });
  });

  test("the walk: trusted through the repository, from the cwd up to the worktree's own top", () => {
    const deep = join(repo.wt, "pkg", "deep");
    expect(trustedProjectWalk(deep, trust)).toEqual([deep, join(repo.wt, "pkg"), repo.wt]);
    expect(trustedProjectWalk(deep, new TrustStore(join(home, "nobody.json")))).toEqual([]);
    expect(trustedProjectWalk(null, trust)).toEqual([]);
  });

  test("output styles: listed from the worktree; along the walk the ROOT-most wins (the run home's lastWins)", () => {
    const styles = new OutputStyleStore({ winterHome: home, trust });
    const names = new Map(styles.list(join(repo.wt, "pkg", "deep")).map((s) => [s.name, s.description]));
    expect(names.get("wt-style")).toBe("from the worktree root");
    expect(names.get("pkg-only")).toBe("pkg only");
    expect(styles.resolve("wt-style", join(repo.wt, "pkg"))?.description).toBe("from the worktree root");
    expect(styles.resolve("pkg-only", join(repo.wt, "pkg", "deep"))?.description).toBe("pkg only");
    // An untrusted repository lists no project style at all.
    const untrusted = new OutputStyleStore({ winterHome: home, trust: new TrustStore(join(home, "nobody.json")) });
    expect(untrusted.list(repo.wt).some((s) => s.name === "wt-style")).toBe(false);
  });

  test("workflows: listed from the worktree; the NEAREST definition wins", () => {
    const flows = new WorkflowStore({ winterHome: home, trust });
    const listed = flows.list(join(repo.wt, "pkg", "deep")).find((w) => w.name === "wt-flow");
    expect(listed).toEqual({ name: "wt-flow", description: "pkg flow", source: "project" });
    expect(flows.resolve("wt-flow", repo.wt)?.description).toBe("root flow");
    expect(flows.read("wt-flow", join(repo.wt, "pkg"))?.body).toContain("pkg flow");
  });

  test("project memory: a worktree of a trusted repo reaches it; the directory stays the cwd's own", async () => {
    const memory = new MemoryStore({ winterHome: home, trust });
    const sub = join(repo.wt, "pkg", "deep");
    const wrote = await memory.write("project", { name: "wt-fact", description: "a fact", type: "project", body: "b" }, { source: "rpc" }, sub);
    expect(wrote.ok).toBe(true);
    expect(existsSync(join(sub, ".winter", "memory", "wt-fact.md"))).toBe(true); // beside the session, as before
    const listed = memory.list("project", sub);
    expect(listed.ok && listed.value.map((f) => f.name)).toEqual(["wt-fact"]);
    // An untrusted repository still refuses.
    const untrusted = new MemoryStore({ winterHome: home, trust: new TrustStore(join(home, "nobody.json")) });
    expect(untrusted.list("project", sub).ok).toBe(false);
  });

  test("permission dirs: the worktree's project tiers, trusted through the repository", () => {
    write(join(repo.wt, ".winter", "settings.json"), JSON.stringify({ permissions: { additionalDirectories: ["/wt/committed"] } }));
    write(join(repo.wt, ".winter", "settings.local.json"), JSON.stringify({ permissions: { additionalDirectories: ["/wt/local"] } }));
    const dirs = sessionPermissionDirs(home, join(repo.wt, "pkg"), trust);
    expect(dirs).toContain("/wt/committed");
    expect(dirs).toContain("/wt/local");
    expect(sessionPermissionDirs(home, join(repo.wt, "pkg"), new TrustStore(join(home, "nobody.json")))).not.toContain("/wt/committed");
  });
});
