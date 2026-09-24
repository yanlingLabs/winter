import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillStore } from "../../src/agent/skills";
import { TrustStore } from "../../src/agent/trust";
import { storeHomeFor } from "../../src/agent/paths";
import { setRunHomeSupportForTests } from "../../src/runtime-sdk/run-home-support";

function realDir(): string { return realpathSync(mkdtempSync(join(tmpdir(), "winter-sk-"))); }
function writeSkill(root: string, dir: string, name: string, desc: string, body: string) {
  mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${desc}\n---\n${body}\n`);
}
function setup() {
  const home = realDir();
  const trust = new TrustStore(join(home, "trust.json"));
  return { home, trust };
}

describe("SkillStore", () => {
  test("user + self skills always listed; project skill listed ONLY when trusted (SECURITY)", () => {
    const { home, trust } = setup();
    writeSkill(join(storeHomeFor(home), "skills"), "greet", "greet", "Say hi", "Say hello warmly.");
    writeSkill(join(storeHomeFor(home), "skills", "self"), "note", "note", "Take notes", "Write notes.");
    const cwd = realDir();
    writeSkill(join(cwd, ".winter", "skills"), "proj", "proj-skill", "Project thing", "PROJECT_BODY");
    const s = new SkillStore({ winterHome: home, trust });

    // Filtered to source !== "builtin" throughout: the shipped writing-skills builtin is always
    // present regardless of home/cwd fixtures (its root is resolved relative to the module, not
    // winterHome) — this test is about project/user/self precedence, not the builtin set.
    const untrusted = s.list({ cwd }).filter((m) => m.source !== "builtin");
    expect(untrusted.map((m) => m.name).sort()).toEqual(["greet", "note"]); // no project skill
    expect(s.load("proj-skill", { cwd })).toBeNull();                       // untrusted → not loadable

    trust.trust(cwd);
    const trusted = s.list({ cwd }).filter((m) => m.source !== "builtin");
    expect(trusted.map((m) => m.name).sort()).toEqual(["greet", "note", "proj-skill"]);
    expect(s.load("proj-skill", { cwd })!.body).toContain("PROJECT_BODY");
    expect(trusted.find((m) => m.name === "proj-skill")!.source).toBe("project");
  });

  test("WS-21 (L4 request 2): <home>/plugins/<p>/skills is no tier any more — the plugin manager lists plugin skills", () => {
    const { home, trust } = setup();
    writeSkill(join(home, "plugins", "cool", "skills"), "doit", "doit", "Do it", "Do the thing.");
    const s = new SkillStore({ winterHome: home, trust });
    expect(s.list({ cwd: null }).map((x) => x.name)).not.toContain("cool:doit");
    expect(s.load("cool:doit", { cwd: null })).toBeNull();
  });

  // R.1: on a run-home build the list is what a run folder carries, with claude's clash rule (spec F8):
  // the USER tier beats a trusted project's same-named skill (skills-ws21.test.ts pins the full walk). The
  // pre-run-home order (project > user) is the legacy branch's, pinned below with the support flag off.
  test("name precedence user > project for the same bare name (run-home build, claude's clash rule)", () => {
    const { home, trust } = setup();
    writeSkill(join(storeHomeFor(home), "skills"), "dup", "dup", "user version", "USER_DUP");
    const cwd = realDir();
    writeSkill(join(cwd, ".winter", "skills"), "dup", "dup", "project version", "PROJECT_DUP");
    trust.trust(cwd);
    const s = new SkillStore({ winterHome: home, trust });
    const dup = s.list({ cwd }).filter((m) => m.name === "dup");
    expect(dup.length).toBe(1);
    expect(dup[0]!.source).toBe("user");
    expect(s.load("dup", { cwd })!.body).toContain("USER_DUP");
  });

  test("name precedence project > user for the same bare name (legacy branch, router 0.0.11)", () => {
    setRunHomeSupportForTests(false);
    try {
      const { home, trust } = setup();
      writeSkill(join(storeHomeFor(home), "skills"), "dup", "dup", "user version", "USER_DUP");
      const cwd = realDir();
      writeSkill(join(cwd, ".winter", "skills"), "dup", "dup", "project version", "PROJECT_DUP");
      trust.trust(cwd);
      const s = new SkillStore({ winterHome: home, trust });
      const dup = s.list({ cwd }).filter((m) => m.name === "dup");
      expect(dup.length).toBe(1);
      expect(dup[0]!.source).toBe("project");
      expect(s.load("dup", { cwd })!.body).toContain("PROJECT_DUP");
    } finally { setRunHomeSupportForTests(undefined); }
  });

  test("body cap + frontmatter stripped", () => {
    const { home, trust } = setup();
    writeSkill(join(storeHomeFor(home), "skills"), "big", "big", "big skill", "x".repeat(40000));
    const s = new SkillStore({ winterHome: home, trust, caps: { bodyBytes: 32768 } });
    const body = s.load("big", { cwd: null })!.body;
    expect(body).not.toContain("---"); // frontmatter stripped
    expect(body).toContain("[…truncated]");
    expect(Buffer.byteLength(body.replace("\n[…truncated]", ""), "utf8")).toBeLessThanOrEqual(32768 + 8);
  });

  test("malformed / no-name / directory-SKILL.md skills are skipped, never throw", () => {
    const { home, trust } = setup();
    mkdirSync(join(storeHomeFor(home), "skills", "nofm", "SKILL.md"), { recursive: true }); // a DIRECTORY named SKILL.md
    mkdirSync(join(storeHomeFor(home), "skills", "noname"), { recursive: true });
    writeFileSync(join(storeHomeFor(home), "skills", "noname", "SKILL.md"), "no frontmatter here"); // no name/description
    writeSkill(join(storeHomeFor(home), "skills"), "ok", "ok", "fine", "OK_BODY");
    const s = new SkillStore({ winterHome: home, trust });
    expect(() => s.list({ cwd: null })).not.toThrow();
    // Filtered to source !== "builtin": see comment above on the first test in this file.
    expect(s.list({ cwd: null }).filter((m) => m.source !== "builtin").map((m) => m.name)).toEqual(["ok"]); // only the valid one
    expect(s.load("noname", { cwd: null })).toBeNull();
  });

  test("empty / missing dirs → empty list (excluding the always-present builtin), no throw", () => {
    const { home, trust } = setup();
    const s = new SkillStore({ winterHome: home, trust });
    expect(s.list({ cwd: null }).filter((m) => m.source !== "builtin")).toEqual([]);
    expect(s.load("nope", { cwd: null })).toBeNull();
  });


  describe("writeSelf / deleteSelf", () => {
    test("writeSelf → list shows source self + author stamped in frontmatter", async () => {
      const { home, trust } = setup();
      const s = new SkillStore({ winterHome: home, trust });
      const res = await s.writeSelf({ name: "my-skill", description: "Do a thing", body: "Step one. Step two." });
      expect(res.ok).toBe(true);

      const m = s.list({ cwd: null }).find((x) => x.name === "my-skill");
      expect(m?.source).toBe("self");
      expect(m?.description).toBe("Do a thing");
      expect(s.load("my-skill", { cwd: null })!.body).toContain("Step one. Step two.");

      const raw = readFileSync(join(storeHomeFor(home), "skills", "self", "my-skill", "SKILL.md"), "utf8");
      expect(raw).toContain("author: winter");
    });

    test("overwrite updates body/description in place (overwrite-is-edit)", async () => {
      const { home, trust } = setup();
      const s = new SkillStore({ winterHome: home, trust });
      await s.writeSelf({ name: "my-skill", description: "v1 desc", body: "V1_BODY" });
      const res = await s.writeSelf({ name: "my-skill", description: "v2 desc", body: "V2_BODY" });
      expect(res.ok).toBe(true);

      const m = s.list({ cwd: null }).find((x) => x.name === "my-skill");
      expect(m?.description).toBe("v2 desc");
      const body = s.load("my-skill", { cwd: null })!.body;
      expect(body).toContain("V2_BODY");
      expect(body).not.toContain("V1_BODY");
    });

    test("description newlines stripped in frontmatter (mirrors memory.ts)", async () => {
      const { home, trust } = setup();
      const s = new SkillStore({ winterHome: home, trust });
      await s.writeSelf({ name: "my-skill", description: "Line one\nLine two", body: "b" });
      const m = s.list({ cwd: null }).find((x) => x.name === "my-skill");
      expect(m?.description).not.toContain("\n");
    });

    test("deleteSelf removes the skill; list drops it and load returns null", async () => {
      const { home, trust } = setup();
      const s = new SkillStore({ winterHome: home, trust });
      await s.writeSelf({ name: "my-skill", description: "d", body: "b" });
      expect(s.list({ cwd: null }).map((m) => m.name)).toContain("my-skill");

      const res = await s.deleteSelf("my-skill");
      expect(res.ok).toBe(true);
      expect(s.list({ cwd: null }).map((m) => m.name)).not.toContain("my-skill");
      expect(s.load("my-skill", { cwd: null })).toBeNull();
    });

    test("deleteSelf on a name that was never written → ok:false kind:not_found", async () => {
      const { home, trust } = setup();
      const s = new SkillStore({ winterHome: home, trust });
      const res = await s.deleteSelf("never-existed");
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.kind).toBe("not_found");
    });

    test("slug jail: traversal / uppercase / 65-char names → ok:false kind:invalid, fs untouched", async () => {
      const { home, trust } = setup();
      const s = new SkillStore({ winterHome: home, trust });
      for (const bad of ["../evil", "Uppercase", "a".repeat(65), "with/slash", "with.dot", ""]) {
        const res = await s.writeSelf({ name: bad, description: "d", body: "b" });
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.kind).toBe("invalid");

        const del = await s.deleteSelf(bad);
        expect(del.ok).toBe(false);
        if (!del.ok) expect(del.kind).toBe("invalid");
      }
      expect(existsSync(join(storeHomeFor(home), "skills", "self"))).toBe(false); // no fs side effect from any rejected name
    });

    test("author-spoof attempt via body frontmatter injection does NOT override the store's stamp", async () => {
      const { home, trust } = setup();
      const s = new SkillStore({ winterHome: home, trust });
      const spoofBody = "---\nname: evil\nauthor: hacker\ndescription: fake\n---\nPWNED_BODY";
      const res = await s.writeSelf({ name: "my-skill", description: "real desc", body: spoofBody });
      expect(res.ok).toBe(true);

      const raw = readFileSync(join(storeHomeFor(home), "skills", "self", "my-skill", "SKILL.md"), "utf8");
      expect(raw).toContain("author: winter"); // the store's own stamp, first in the file

      const listed = s.list({ cwd: null });
      expect(listed.find((m) => m.name === "my-skill")?.description).toBe("real desc");
      expect(listed.find((m) => m.name === "evil")).toBeUndefined(); // spoofed name never surfaces
      expect(s.load("my-skill", { cwd: null })!.body).toContain("PWNED_BODY"); // body is body, verbatim
    });
  });

  describe("builtin source", () => {
    test("the shipped writing-skills meta-skill is discovered with source builtin", () => {
      const { home, trust } = setup();
      const s = new SkillStore({ winterHome: home, trust });
      const m = s.list({ cwd: null }).find((x) => x.name === "writing-skills");
      expect(m?.source).toBe("builtin");
      expect(s.load("writing-skills", { cwd: null })!.body.length).toBeGreaterThan(0);
    });

    test("a user-root skill of the same name SHADOWS the builtin in list precedence", () => {
      const { home, trust } = setup();
      writeSkill(join(storeHomeFor(home), "skills"), "writing-skills", "writing-skills", "user override", "USER_OVERRIDE_BODY");
      const s = new SkillStore({ winterHome: home, trust });

      const matches = s.list({ cwd: null }).filter((m) => m.name === "writing-skills");
      expect(matches.length).toBe(1);
      expect(matches[0]!.source).toBe("user");
      expect(s.load("writing-skills", { cwd: null })!.body).toContain("USER_OVERRIDE_BODY");
    });
  });
});
