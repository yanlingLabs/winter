// The managed copy of Winter-shipped skills (`migration/builtin-skills.ts`): one test per seeding rule, the
// failure postures (nothing here ever throws or blocks boot), that the embedded text IS the builtin file, and
// that the daemon's boot hook runs it (and only on a build whose router applies run homes).
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { FileSecretStore } from "../../src/auth/secret-store";
import { startDaemon, type RunningDaemon } from "../../src/daemon";
import { BUILTIN_SEEDED_SKILLS, builtinSkillsRecordPath, seedBuiltinSkills, seededSkillPath, sha256Hex } from "../../src/migration/builtin-skills";
import { setRunHomeSupportForTests } from "../../src/runtime-sdk/run-home-support";

const newHome = (): string => realpathSync(mkdtempSync(join(tmpdir(), "winter-builtin-skills-")));
const V1 = "---\nname: computer-use\ndescription: v1\n---\nversion one\n";
const V2 = "---\nname: computer-use\ndescription: v2\n---\nversion two\n";
const skill = (text: string) => [{ name: "computer-use", text }] as const;
const record = (home: string): Record<string, { seededHash: string }> => JSON.parse(readFileSync(builtinSkillsRecordPath(home), "utf8"));
const put = (path: string, text: string): void => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };

function run(home: string, text: string): { lines: string[]; outcome: string } {
  const lines: string[] = [];
  const report = seedBuiltinSkills(home, { skills: skill(text), log: (l) => lines.push(l) });
  return { lines, outcome: report.skills["computer-use"]! };
}

describe("seedBuiltinSkills", () => {
  test("never seeded and the target is absent: writes it (0600, atomically) and records the hash of what it wrote", () => {
    const home = newHome();
    const r = run(home, V1);
    const target = seededSkillPath(home, "computer-use");
    expect(r.outcome).toBe("seeded");
    expect(target).toBe(join(home, "sdk", "skills", "computer-use", "SKILL.md"));
    expect(readFileSync(target, "utf8")).toBe(V1);
    expect(statSync(target).mode & 0o777).toBe(0o600);
    expect(readdirSync(dirname(target))).toEqual(["SKILL.md"]); // no temp file left behind
    expect(record(home)).toEqual({ "computer-use": { seededHash: sha256Hex(V1) } });
    expect(r.lines).toHaveLength(1);
  });

  test("seeded, the copy untouched and the shipped text changed: a newer Winter updates it and records the new hash", () => {
    const home = newHome();
    run(home, V1);
    const r = run(home, V2);
    expect(r.outcome).toBe("updated");
    expect(readFileSync(seededSkillPath(home, "computer-use"), "utf8")).toBe(V2);
    expect(record(home)["computer-use"]!.seededHash).toBe(sha256Hex(V2));
    expect(r.lines).toHaveLength(1);
  });

  test("seeded, the copy untouched and the text unchanged: nothing is written, nothing is logged", () => {
    const home = newHome();
    run(home, V1);
    const target = seededSkillPath(home, "computer-use");
    const before = statSync(target);
    const recordBefore = readFileSync(builtinSkillsRecordPath(home), "utf8");
    const r = run(home, V1);
    expect(r.outcome).toBe("unchanged");
    expect(r.lines).toEqual([]);
    expect(statSync(target).ino).toBe(before.ino); // not even rewritten in place
    expect(readFileSync(builtinSkillsRecordPath(home), "utf8")).toBe(recordBefore);
  });

  test("seeded, then edited by the user: left alone with one log line, even when a newer text ships", () => {
    const home = newHome();
    run(home, V1);
    const target = seededSkillPath(home, "computer-use");
    writeFileSync(target, V1 + "my own tip\n");
    const r = run(home, V2);
    expect(r.outcome).toBe("edited");
    expect(readFileSync(target, "utf8")).toBe(V1 + "my own tip\n");
    expect(record(home)["computer-use"]!.seededHash).toBe(sha256Hex(V1)); // the record is not moved
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toContain("was edited");
  });

  test("seeded, then deleted by the user: NOT re-created, on this boot or a later one with newer text", () => {
    const home = newHome();
    run(home, V1);
    const target = seededSkillPath(home, "computer-use");
    unlinkSync(target);
    expect(run(home, V1).outcome).toBe("deleted-by-user");
    expect(run(home, V2).outcome).toBe("deleted-by-user");
    expect(existsSync(target)).toBe(false);
    expect(record(home)["computer-use"]!.seededHash).toBe(sha256Hex(V1)); // the memory of the seeding stays
  });

  test("never seeded but present (the user's own computer-use): never overwritten, not recorded", () => {
    const home = newHome();
    const target = seededSkillPath(home, "computer-use");
    put(target, "---\nname: computer-use\ndescription: mine\n---\nmy recipes\n");
    const r = run(home, V1);
    expect(r.outcome).toBe("not-ours");
    expect(readFileSync(target, "utf8")).toContain("my recipes");
    expect(existsSync(builtinSkillsRecordPath(home))).toBe(false);
    expect(run(home, V2).outcome).toBe("not-ours"); // a later boot with newer text neither
    expect(readFileSync(target, "utf8")).toContain("my recipes");
  });

  test("present and byte-identical to the shipped text with no record (a lost record): adopted, so later updates reach it", () => {
    const home = newHome();
    const target = seededSkillPath(home, "computer-use");
    put(target, V1);
    expect(run(home, V1).outcome).toBe("recorded");
    expect(record(home)["computer-use"]!.seededHash).toBe(sha256Hex(V1));
    expect(run(home, V2).outcome).toBe("updated");
    expect(readFileSync(target, "utf8")).toBe(V2);
  });

  test("a crash between the file's rename and the record's: the file already holds the shipped text, so only the record is repaired", () => {
    const home = newHome();
    run(home, V1);
    const target = seededSkillPath(home, "computer-use");
    writeFileSync(target, V2); // the update landed; the record still says V1
    const before = statSync(target);
    expect(run(home, V2).outcome).toBe("recorded");
    expect(statSync(target).ino).toBe(before.ino);
    expect(record(home)["computer-use"]!.seededHash).toBe(sha256Hex(V2));
  });

  test("a record that is not a JSON object is never overwritten: nothing is seeded or updated, one line says so", () => {
    const home = newHome();
    put(builtinSkillsRecordPath(home), "{ not json");
    const r = run(home, V1);
    expect(r.outcome).toBe("unreadable");
    expect(existsSync(seededSkillPath(home, "computer-use"))).toBe(false);
    expect(readFileSync(builtinSkillsRecordPath(home), "utf8")).toBe("{ not json");
    expect(r.lines).toHaveLength(1);
  });

  test("a symlinked skill folder or SKILL.md is the user's own arrangement: never written through", () => {
    const home = newHome();
    const elsewhere = newHome();
    put(join(elsewhere, "SKILL.md"), "elsewhere\n");
    mkdirSync(join(home, "sdk", "skills"), { recursive: true });
    symlinkSync(elsewhere, join(home, "sdk", "skills", "computer-use"));
    expect(run(home, V1).outcome).toBe("not-ours");
    expect(readFileSync(join(elsewhere, "SKILL.md"), "utf8")).toBe("elsewhere\n");

    const home2 = newHome();
    const real = join(newHome(), "mine.md");
    put(real, "mine\n");
    mkdirSync(join(home2, "sdk", "skills", "computer-use"), { recursive: true });
    symlinkSync(real, seededSkillPath(home2, "computer-use"));
    expect(run(home2, V1).outcome).toBe("not-ours");
    expect(lstatSync(seededSkillPath(home2, "computer-use")).isSymbolicLink()).toBe(true);
    expect(readFileSync(real, "utf8")).toBe("mine\n");
  });

  test("a failure only logs: it never throws, and a later boot retries", () => {
    const home = newHome();
    put(join(home, "sdk", "skills"), "a FILE where the skills folder should be"); // mkdir under it fails
    let r!: { lines: string[]; outcome: string };
    expect(() => { r = run(home, V1); }).not.toThrow();
    expect(r.outcome).toBe("failed");
    expect(r.lines.join("\n")).toContain("retried at the next boot");
    expect(existsSync(builtinSkillsRecordPath(home))).toBe(false); // nothing recorded for what was not written
    unlinkSync(join(home, "sdk", "skills"));
    expect(run(home, V1).outcome).toBe("seeded");
  });

  test("one skill failing does not stop the next", () => {
    const home = newHome();
    put(join(home, "sdk", "skills", "first"), "a FILE where the first skill's folder should be");
    const lines: string[] = [];
    const report = seedBuiltinSkills(home, { skills: [{ name: "first", text: V1 }, { name: "second", text: V2 }], log: (l) => lines.push(l) });
    expect(report.skills).toEqual({ first: "failed", second: "seeded" });
    expect(Object.keys(record(home))).toEqual(["second"]);
  });
});

describe("the shipped list", () => {
  test("every seeded skill's text is its packages/core/skills/<name>/SKILL.md, byte for byte (the builtin listing and the copy agree)", () => {
    expect(BUILTIN_SEEDED_SKILLS.map((s) => s.name)).toContain("computer-use");
    for (const s of BUILTIN_SEEDED_SKILLS) {
      const onDisk = readFileSync(join(import.meta.dir, "..", "..", "skills", s.name, "SKILL.md"), "utf8");
      expect(s.text).toBe(onDisk);
      expect(s.text.length).toBeGreaterThan(0);
    }
  });
});

describe("the daemon's boot", () => {
  let daemon: RunningDaemon | undefined;
  afterEach(async () => {
    await daemon?.stop();
    daemon = undefined;
    setRunHomeSupportForTests(undefined);
  });

  async function boot(home: string): Promise<void> {
    daemon = await startDaemon({ home, secrets: new FileSecretStore(join(home, "test-secrets")), agentProvider: null });
  }
  async function reboot(home: string): Promise<void> {
    await daemon?.stop();
    daemon = undefined;
    await boot(home);
  }

  test("seeds the shipped skills into sdk/skills on every boot, and honours a deletion and an edit across boots", async () => {
    const home = newHome();
    await boot(home);
    const target = seededSkillPath(home, "computer-use");
    const shipped = BUILTIN_SEEDED_SKILLS.find((s) => s.name === "computer-use")!.text;
    expect(readFileSync(target, "utf8")).toBe(shipped);
    expect(record(home)["computer-use"]!.seededHash).toBe(sha256Hex(shipped));

    // An edit survives the next boot.
    writeFileSync(target, shipped + "\nmy note\n");
    await reboot(home);
    expect(readFileSync(target, "utf8")).toBe(shipped + "\nmy note\n");

    // A deletion survives it too.
    unlinkSync(target);
    await reboot(home);
    expect(existsSync(target)).toBe(false);
  });

  test("a build whose router applies no run homes seeds nothing (sdk/ is not the skill store there)", async () => {
    setRunHomeSupportForTests(false);
    const home = newHome();
    await boot(home);
    expect(existsSync(join(home, "sdk", "skills"))).toBe(false);
    expect(existsSync(builtinSkillsRecordPath(home))).toBe(false);
  });
});
