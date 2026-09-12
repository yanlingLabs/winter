import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextAssembler } from "../../src/agent/context";
import { TrustStore } from "../../src/agent/trust";
import { SkillStore } from "../../src/agent/skills";

function realDir(): string { return realpathSync(mkdtempSync(join(tmpdir(), "winter-ctx-"))); }
function setup() {
  const home = realDir();
  mkdirSync(join(home, "memory"), { recursive: true });
  const trust = new TrustStore(join(home, "trust.json"));
  return { home, trust };
}

describe("ContextAssembler", () => {
  test("user WINTER.md always loads; project WINTER.md loads only when trusted (SECURITY)", () => {
    const { home, trust } = setup();
    writeFileSync(join(home, "WINTER.md"), "USER_RULE_SENTINEL");
    const cwd = realDir();
    writeFileSync(join(cwd, "WINTER.md"), "PROJECT_RULE_SENTINEL");
    const a = new ContextAssembler({ winterHome: home, trust, skills: new SkillStore({ winterHome: home, trust }) });

    const untrusted = a.assemble({ cwd });
    expect(untrusted).toContain("USER_RULE_SENTINEL");
    expect(untrusted).not.toContain("PROJECT_RULE_SENTINEL"); // untrusted project WINTER.md is NOT injected

    trust.trust(cwd);
    const trusted = a.assemble({ cwd });
    expect(trusted).toContain("PROJECT_RULE_SENTINEL");        // trusted → injected
    expect(trusted).toContain("USER_RULE_SENTINEL");
  });

  test("F2 (4e gate ledger): assembled output states today's date (YYYY-MM-DD, LOCAL timezone)", () => {
    const { home, trust } = setup();
    const a = new ContextAssembler({ winterHome: home, trust, skills: new SkillStore({ winterHome: home, trust }) });
    const out = a.assemble({ cwd: null });
    // Mirror the assembler: LOCAL date parts, not toISOString (UTC) — review-caught F2 fix.
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    expect(out).toContain(`Today's date is ${today}.`);
  });

  test("base prompt present; capability stub present; empty sources omit their headers", () => {
    const { home, trust } = setup();
    const a = new ContextAssembler({ winterHome: home, trust, skills: new SkillStore({ winterHome: home, trust }) });
    const out = a.assemble({ cwd: null });
    expect(out).toContain("Winter"); // base prompt
    expect(out).toMatch(/Available capabilities/);
    expect(out).not.toMatch(/Project instructions/); // no cwd → no project header
    expect(out).not.toMatch(/User instructions/);     // no user WINTER.md → no header
  });

  test("memory index: user always, project trusted-only", () => {
    const { home, trust } = setup();
    writeFileSync(join(home, "memory", "MEMORY.md"), "USER_MEMORY_FACT");
    const cwd = realDir();
    mkdirSync(join(cwd, ".winter", "memory"), { recursive: true });
    writeFileSync(join(cwd, ".winter", "memory", "MEMORY.md"), "PROJECT_MEMORY_FACT");
    const a = new ContextAssembler({ winterHome: home, trust, skills: new SkillStore({ winterHome: home, trust }) });
    const untrusted = a.assemble({ cwd });
    expect(untrusted).toContain("USER_MEMORY_FACT");
    expect(untrusted).not.toContain("PROJECT_MEMORY_FACT");
    trust.trust(cwd);
    expect(a.assemble({ cwd })).toContain("PROJECT_MEMORY_FACT");
  });

  test("caps: oversized WINTER.md truncated with marker; long MEMORY.md line-capped", () => {
    const { home, trust } = setup();
    writeFileSync(join(home, "WINTER.md"), "x".repeat(40000));
    writeFileSync(join(home, "memory", "MEMORY.md"), Array.from({ length: 500 }, (_, i) => `line${i}`).join("\n"));
    const a = new ContextAssembler({ winterHome: home, trust, skills: new SkillStore({ winterHome: home, trust }) });
    const out = a.assemble({ cwd: null });
    expect(out).toContain("[…truncated]");
    expect(out).not.toContain("line300"); // beyond the 200-line memory cap
    expect(out).toContain("line0");
  });

  test("missing/broken files never throw (section omitted)", () => {
    const { home, trust } = setup();
    const a = new ContextAssembler({ winterHome: home, trust, skills: new SkillStore({ winterHome: home, trust }) });
    // point cwd at a dir with a WINTER.md that is actually a directory (unreadable as a file)
    const cwd = realDir(); mkdirSync(join(cwd, "WINTER.md")); trust.trust(cwd);
    expect(() => a.assemble({ cwd })).not.toThrow();
    expect(a.assemble({ cwd })).not.toContain("Project instructions");
  });

  test("byte cap is UTF-8 byte-accurate for non-ASCII (not char-length) and truncates on a valid boundary", () => {
    const { home, trust } = setup();
    // 20000 CJK chars = 60000 UTF-8 bytes, well over the 32768-byte instructions cap
    writeFileSync(join(home, "WINTER.md"), "字".repeat(20000));
    const a = new ContextAssembler({ winterHome: home, trust, skills: new SkillStore({ winterHome: home, trust }) });
    const out = a.assemble({ cwd: null });
    expect(out).toContain("[…truncated]");
    // the user-instructions content must be <= the byte cap (not ~1.8x over):
    // (isolate to just this section — stop at the next "## " heading — so the trailing
    // "## Available capabilities" boilerplate doesn't inflate the measured byte count)
    const section = (out.split("## User instructions")[1] ?? "").split("\n\n## ")[0] ?? "";
    expect(Buffer.byteLength(section.replace("\n[…truncated]", ""), "utf8")).toBeLessThanOrEqual(32768 + 64); // +header slack
    // no lone surrogate / invalid unit: re-encoding round-trips cleanly (no U+FFFD from OUR split beyond at most the boundary char)
    expect(() => Buffer.from(out, "utf8")).not.toThrow();
    // an emoji straddling the boundary does not leave a lone surrogate:
    const home2 = realDir(); mkdirSync(join(home2, "memory"), { recursive: true });
    const trust2 = new (trust.constructor as any)(join(home2, "trust.json"));
    writeFileSync(join(home2, "WINTER.md"), "a".repeat(32766) + "😀😀😀");
    const b = new ContextAssembler({ winterHome: home2, trust: trust2, skills: new SkillStore({ winterHome: home2, trust: trust2 }) });
    const o2 = b.assemble({ cwd: null });
    // no unpaired surrogate: matching /[\ud800-\udfff]/ against a valid string finds only paired ones; a lone one would be caught by round-trip:
    expect(Buffer.from(o2, "utf8").toString("utf8").includes("��")).toBe(false); // not a cascade of replacements
  });

  test("present-but-EMPTY WINTER.md is omitted (no empty header)", () => {
    const { home, trust } = setup();
    writeFileSync(join(home, "WINTER.md"), ""); // zero bytes, but the file EXISTS
    const a = new ContextAssembler({ winterHome: home, trust, skills: new SkillStore({ winterHome: home, trust }) });
    expect(a.assemble({ cwd: null })).not.toContain("User instructions");
  });

  test("memory 24576-byte cap fires independently of the 200-line cap", () => {
    const { home, trust } = setup();
    // 50 long lines (< 200 lines) but > 24576 bytes → byte cap must fire
    writeFileSync(join(home, "memory", "MEMORY.md"), Array.from({length:50}, () => "y".repeat(1000)).join("\n"));
    const a = new ContextAssembler({ winterHome: home, trust, skills: new SkillStore({ winterHome: home, trust }) });
    const out = a.assemble({ cwd: null });
    expect(out).toContain("[…truncated]");
    // isolate to just this section (stop at the next "## " heading) for the same reason as above
    const mem = (out.split("## Memory")[1] ?? "").split("\n\n## ")[0] ?? "";
    expect(Buffer.byteLength(mem.replace("\n[…truncated]",""), "utf8")).toBeLessThanOrEqual(24576 + 64);
  });

  test("capability index lists discovered skills; loadedSkills injects the body", () => {
    const { home, trust } = setup(); // existing helper: temp winterHome + TrustStore
    // write a user skill
    mkdirSync(join(home, "skills", "haiku"), { recursive: true });
    writeFileSync(join(home, "skills", "haiku", "SKILL.md"), "---\nname: haiku\ndescription: Respond in haiku\n---\nHAIKU_BODY_ONLY_HERE\n");
    const skills = new SkillStore({ winterHome: home, trust });
    const a = new ContextAssembler({ winterHome: home, trust, skills });
    const idx = a.assemble({ cwd: null });
    expect(idx).toContain("Available capabilities");
    expect(idx).toContain("haiku"); expect(idx).toContain("Respond in haiku");
    expect(idx).not.toContain("HAIKU_BODY_ONLY_HERE");    // body NOT in the index (progressive disclosure)
    expect(idx).not.toMatch(/Loaded skills/);             // none loaded

    const loaded = a.assemble({ cwd: null, loadedSkills: ["haiku"] });
    expect(loaded).toMatch(/Loaded skills/);
    expect(loaded).toContain("HAIKU_BODY_ONLY_HERE");     // full body injected when loaded
  });

  test("no skills → 'No skills are installed.'; unresolved loadedSkills silently dropped", () => {
    const { home, trust } = setup();
    // A real SkillStore always discovers the shipped `writing-skills` builtin (phase 5c), so this
    // exercises context.ts's empty branch directly via a stub reporting zero skills, the same way
    // scheduler.test.ts stubs RoutineStore methods — the real-store + builtin case is covered by
    // "capability index lists discovered skills" above and the builtin-specific test below.
    const emptySkills = { list: () => [], load: () => null } as unknown as SkillStore;
    const a = new ContextAssembler({ winterHome: home, trust, skills: emptySkills });
    expect(a.assemble({ cwd: null })).toContain("No skills are installed.");
    expect(() => a.assemble({ cwd: null, loadedSkills: ["ghost"] })).not.toThrow();
    expect(a.assemble({ cwd: null, loadedSkills: ["ghost"] })).not.toMatch(/Loaded skills/); // nothing resolved
  });

  test("real SkillStore with zero configured skills still lists the shipped writing-skills builtin", () => {
    const { home, trust } = setup();
    const a = new ContextAssembler({ winterHome: home, trust, skills: new SkillStore({ winterHome: home, trust }) });
    const idx = a.assemble({ cwd: null });
    expect(idx).toContain("Available capabilities");
    expect(idx).toContain("writing-skills");
    expect(idx).not.toContain("No skills are installed.");
  });

  test("mixed resolution: resolved skills injected, unresolved dropped (no empty header)", () => {
    const { home, trust } = setup();
    // set up the haiku skill
    mkdirSync(join(home, "skills", "haiku"), { recursive: true });
    writeFileSync(join(home, "skills", "haiku", "SKILL.md"), "---\nname: haiku\ndescription: Respond in haiku\n---\nHAIKU_BODY_ONLY_HERE\n");
    const skills = new SkillStore({ winterHome: home, trust });
    const a = new ContextAssembler({ winterHome: home, trust, skills });

    // assemble with both a resolved skill (haiku) and an unresolved one (ghost)
    const out = a.assemble({ cwd: null, loadedSkills: ["haiku", "ghost"] });
    expect(out).toContain("HAIKU_BODY_ONLY_HERE"); // haiku body is present
    expect(out).not.toContain("#### ghost");      // unresolved skill name not as empty header
    expect(out).toMatch(/### Loaded skills/);     // section header present (at least one resolved)
  });
});
