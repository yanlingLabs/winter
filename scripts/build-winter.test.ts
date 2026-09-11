// P8b-2: the only part of `build-winter.ts` that can be tested without a two-minute compile is the
// gate that decides whether the checkout is the pinned peer. It is also the part that MATTERS — a
// build from any other commit produces a binary the daemon is not pinned to, and nothing downstream
// could tell the difference.
//
// No network, no real build, no `bun install` anywhere: the fixture is a local git repo created in
// a temp dir. `core.hooksPath` is pointed at an empty directory so this repo's / the machine's
// global hooks never run against a throwaway fixture (that is a fixture-scoping choice, not a
// `--no-verify` bypass), and the identity is a literal placeholder.
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkoutIsAtTag } from "./build-winter";

const temps: string[] = [];
afterAll(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });

interface Fixture { dir: string; git: (...args: string[]) => void; commit: (file: string, body: string) => void }

function fixtureRepo(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "build-winter-"));
  temps.push(dir);
  const hooks = join(dir, ".empty-hooks");
  mkdirSync(hooks, { recursive: true });
  const git = (...args: string[]): void => {
    const r = spawnSync("git", ["-C", dir, "-c", `core.hooksPath=${hooks}`, "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  };
  const commit = (file: string, body: string): void => {
    writeFileSync(join(dir, file), body);
    git("add", file);
    git("commit", "-q", "-m", file);
  };
  git("init", "-q", "-b", "main");
  commit("a.txt", "one\n");
  return { dir, git, commit };
}

describe("checkoutIsAtTag (P8b-2 pinned-peer gate)", () => {
  test("HEAD exactly at the tag → ok, and `found` is the tag", () => {
    const { dir, git } = fixtureRepo();
    git("tag", "v0.0.3");
    expect(checkoutIsAtTag(dir, "v0.0.3")).toEqual({ ok: true, found: "v0.0.3" });
  });

  // Review F-4: the reason this is MEMBERSHIP and not `git describe --tags --exact-match`, which
  // prints one of several tags and would refuse a correct checkout for naming the wrong one.
  test("HEAD carrying the pinned tag AND another → still ok", () => {
    const { dir, git } = fixtureRepo();
    git("tag", "v0.0.3");
    git("tag", "v-something-kit4");
    const r = checkoutIsAtTag(dir, "v0.0.3");
    expect(r.ok).toBe(true);
    expect(r.found).toContain("v0.0.3");
  });

  test("HEAD at a DIFFERENT tag → refused, and the refusal names what it actually found", () => {
    const { dir, git } = fixtureRepo();
    git("tag", "v0.0.2");
    const r = checkoutIsAtTag(dir, "v0.0.3");
    expect(r.ok).toBe(false);
    expect(r.found).toBe("v0.0.2");
  });

  test("HEAD one commit PAST the tag → refused (the tag existing is not enough)", () => {
    const { dir, git, commit } = fixtureRepo();
    git("tag", "v0.0.3");
    commit("b.txt", "two\n");
    const r = checkoutIsAtTag(dir, "v0.0.3");
    expect(r.ok).toBe(false);
    expect(r.found).toBe("");
  });

  test("no tag at all → refused, never a throw", () => {
    const { dir } = fixtureRepo();
    const r = checkoutIsAtTag(dir, "v0.0.3");
    expect(r.ok).toBe(false);
    expect(r.found).toBe("");
  });

  test("a path that is not a git checkout → refused, never a throw", () => {
    const dir = mkdtempSync(join(tmpdir(), "build-winter-nogit-"));
    temps.push(dir);
    const r = checkoutIsAtTag(dir, "v0.0.3");
    expect(r.ok).toBe(false);
  });
});
