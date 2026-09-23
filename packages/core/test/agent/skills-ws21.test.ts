// WS-21 L3.4 (spec §3.4.1, §3.4.2, F8): on a run-home build `skills.list` reports what a run folder
// carries, with claude's clash rules — user beats project, the NEAREST trusted project dir wins, walking
// from the cwd up to the repo root. Before that build, the daemon's own order (project first) stands.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillStore } from "../../src/agent/skills";
import { TrustStore } from "../../src/agent/trust";
import { storeHomeFor } from "../../src/agent/paths";
import { _clearRepoRootCacheForTests } from "../../src/agent/memory-dir";
import { setRunHomeSupportForTests } from "../../src/runtime-sdk/run-home-support";

const tmp = (p: string): string => realpathSync(mkdtempSync(join(tmpdir(), p)));
const writeSkill = (root: string, dir: string, description: string): void => {
  mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, dir, "SKILL.md"), `---\nname: ${dir}\ndescription: ${description}\n---\nbody`);
};

const saved: Record<string, string | undefined> = {};
beforeAll(() => {
  const fake = tmp("winter-skills21-gh-");
  writeFileSync(join(fake, ".gitconfig"), "");
  for (const [k, v] of Object.entries({ GIT_CONFIG_GLOBAL: join(fake, ".gitconfig"), XDG_CONFIG_HOME: join(fake, ".config") })) { saved[k] = process.env[k]; process.env[k] = v; }
});
afterAll(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
afterEach(() => { setRunHomeSupportForTests(undefined); _clearRepoRootCacheForTests(); });

function fixture() {
  const home = tmp("winter-skills21-h-");
  const repo = tmp("winter-skills21-r-");
  Bun.spawnSync(["git", "-C", repo, "init", "-q"]);
  const nested = join(repo, "pkg", "deep");
  mkdirSync(nested, { recursive: true });
  const trust = new TrustStore(join(home, "trust.json"));
  trust.trust(repo);
  return { home, repo, nested, trust };
}

describe("SkillStore.list precedence", () => {
  test("run-home build: user beats project; the NEAREST project dir wins; the walk reaches the repo root", () => {
    setRunHomeSupportForTests(true);
    const { home, repo, nested, trust } = fixture();
    writeSkill(join(storeHomeFor(home), "skills"), "shared", "from user");
    writeSkill(join(repo, ".winter", "skills"), "shared", "from repo root");
    writeSkill(join(repo, ".winter", "skills"), "rootonly", "root skill");
    writeSkill(join(nested, ".winter", "skills"), "near", "nearest wins");
    writeSkill(join(repo, ".winter", "skills"), "near", "farther loses");
    const list = new SkillStore({ winterHome: home, trust }).list({ cwd: nested });
    const by = Object.fromEntries(list.map((s) => [s.name, s]));
    expect(by.shared!.description).toBe("from user");
    expect(by.shared!.source).toBe("user");
    expect(by.near!.description).toBe("nearest wins");
    expect(by.rootonly!.source).toBe("project"); // the walk reached the repo root
  });

  test("before that build (router 0.0.11): the daemon's own order — the cwd's project dir beats user", () => {
    setRunHomeSupportForTests(false);
    const { home, repo, trust } = fixture();
    writeSkill(join(storeHomeFor(home), "skills"), "shared", "from user");
    writeSkill(join(repo, ".winter", "skills"), "shared", "from project");
    const by = Object.fromEntries(new SkillStore({ winterHome: home, trust }).list({ cwd: repo }).map((s) => [s.name, s]));
    expect(by.shared!.description).toBe("from project");
  });

  test("an untrusted project contributes nothing on either build", () => {
    for (const on of [true, false]) {
      setRunHomeSupportForTests(on);
      const home = tmp("winter-skills21-h-");
      const repo = tmp("winter-skills21-r-");
      writeSkill(join(repo, ".winter", "skills"), "sneaky", "x");
      const trust = new TrustStore(join(home, "trust.json"));
      expect(new SkillStore({ winterHome: home, trust }).list({ cwd: repo }).map((s) => s.name)).not.toContain("sneaky");
    }
  });
});

describe("sessionAvailability after the handover's retirement (L4 request 2)", () => {
  test("a run-home build: user/self/project/builtin skills load in sessions (the run folder carries them)", () => {
    setRunHomeSupportForTests(true);
    try {
      const store = new SkillStore({ winterHome: mkdtempSync(join(tmpdir(), "winter-sa-")), trust: { isTrusted: () => false } as never });
      for (const source of ["user", "self", "project", "builtin"] as const) expect(store.sessionAvailability({ name: "x", source })).toEqual({ loadsInSessions: true });
      expect(store.sessionAvailability({ name: "p:skill", source: "plugin" })).toEqual({ loadsInSessions: true });
      expect(store.sessionAvailability({ name: "Bad Name:x", source: "plugin" }).loadsInSessions).toBe(false);
    } finally { setRunHomeSupportForTests(undefined); }
  });
  test("router 0.0.11: they don't, and say why", () => {
    setRunHomeSupportForTests(false);
    try {
      const store = new SkillStore({ winterHome: mkdtempSync(join(tmpdir(), "winter-sa-")), trust: { isTrusted: () => false } as never });
      const r = store.sessionAvailability({ name: "x", source: "user" });
      expect(r.loadsInSessions).toBe(false);
      expect(r.sessionNote).toContain("no door");
    } finally { setRunHomeSupportForTests(undefined); }
  });
});
