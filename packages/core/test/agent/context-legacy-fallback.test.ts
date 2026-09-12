// Phase 9c (P9c-4, Task M Step 7) — the legacy project-instructions/project-dir read-only fallback for the
// instructions loader and `.winter/rules`, both inside `ContextAssembler.assemble()`. Same harness
// shape as `context-rules.test.ts`: a real temp WINTER_HOME/TrustStore/SkillStore, never the live
// `~/.winter`.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextAssembler } from "../../src/agent/context";
import { TrustStore } from "../../src/agent/trust";
import { SkillStore } from "../../src/agent/skills";
import { LEGACY_INSTRUCTIONS_FILE, LEGACY_PROJECT_DIR } from "../../src/legacy-names";
import type { Settings } from "../../src/settings";

function realDir(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "winter-ctx-legacy-")));
}
function setup() {
  const home = realDir();
  mkdirSync(join(home, "memory"), { recursive: true });
  const trust = new TrustStore(join(home, "trust.json"));
  return { home, trust };
}
function settingsWith(readLegacyProjectFiles: boolean): Settings {
  return { schemaVersion: 1, legacy: { readLegacyProjectFiles } } as unknown as Settings;
}

describe("ContextAssembler — legacy read-only fallback (P9c-4)", () => {
  test("project instructions: falls back to the legacy file when WINTER.md is absent and the flag is on, and adds the deprecation notice", () => {
    const { home, trust } = setup();
    const cwd = realDir();
    writeFileSync(join(cwd, LEGACY_INSTRUCTIONS_FILE), "legacy project prose");
    trust.trust(cwd);
    const a = new ContextAssembler({ winterHome: home, trust, skills: new SkillStore({ winterHome: home, trust }), legacySettings: () => settingsWith(true) });
    const out = a.assemble({ cwd });
    expect(out).toContain("## Project instructions (WINTER.md)\nlegacy project prose");
    expect(out).toContain("Winter is reading legacy project files read-only");
    expect(out).toContain(join(cwd, LEGACY_INSTRUCTIONS_FILE));
    expect(out).toContain("winter migrate-project");
  });

  test("a Winter-named WINTER.md wins over a co-existing legacy file — never falls back when the Winter path already exists", () => {
    const { home, trust } = setup();
    const cwd = realDir();
    writeFileSync(join(cwd, "WINTER.md"), "winter prose");
    writeFileSync(join(cwd, LEGACY_INSTRUCTIONS_FILE), "legacy prose — must never appear");
    trust.trust(cwd);
    const a = new ContextAssembler({ winterHome: home, trust, skills: new SkillStore({ winterHome: home, trust }), legacySettings: () => settingsWith(true) });
    const out = a.assemble({ cwd });
    expect(out).toContain("winter prose");
    expect(out).not.toContain("legacy prose");
    expect(out).not.toContain("Winter is reading legacy project files");
  });

  test("flag off: the legacy file is ignored entirely, exactly as if it did not exist", () => {
    const { home, trust } = setup();
    const cwd = realDir();
    writeFileSync(join(cwd, LEGACY_INSTRUCTIONS_FILE), "legacy project prose");
    trust.trust(cwd);
    const a = new ContextAssembler({ winterHome: home, trust, skills: new SkillStore({ winterHome: home, trust }), legacySettings: () => settingsWith(false) });
    const out = a.assemble({ cwd });
    expect(out).not.toContain("legacy project prose");
    expect(out).not.toContain("Winter is reading legacy project files");
  });

  test("no legacySettings dep at all: byte-identical to pre-9c behavior (never falls back)", () => {
    const { home, trust } = setup();
    const cwd = realDir();
    writeFileSync(join(cwd, LEGACY_INSTRUCTIONS_FILE), "legacy project prose");
    trust.trust(cwd);
    const a = new ContextAssembler({ winterHome: home, trust, skills: new SkillStore({ winterHome: home, trust }) });
    const out = a.assemble({ cwd });
    expect(out).not.toContain("legacy project prose");
  });

  test("untrusted cwd: never falls back, matching the existing trust gate on project instructions/rules", () => {
    const { home, trust } = setup();
    const cwd = realDir();
    writeFileSync(join(cwd, LEGACY_INSTRUCTIONS_FILE), "legacy project prose");
    // deliberately never trust(cwd)
    const a = new ContextAssembler({ winterHome: home, trust, skills: new SkillStore({ winterHome: home, trust }), legacySettings: () => settingsWith(true) });
    const out = a.assemble({ cwd });
    expect(out).not.toContain("legacy project prose");
  });

  test("user instructions (~/.winter/WINTER.md) also falls back to the legacy home file", () => {
    const { home, trust } = setup();
    writeFileSync(join(home, LEGACY_INSTRUCTIONS_FILE), "legacy user prose");
    const a = new ContextAssembler({ winterHome: home, trust, skills: new SkillStore({ winterHome: home, trust }), legacySettings: () => settingsWith(true) });
    const out = a.assemble({ cwd: null });
    expect(out).toContain("## User instructions (~/.winter/WINTER.md)\nlegacy user prose");
    expect(out).toContain("Winter is reading legacy project files read-only");
  });

  test("project rules: falls back to the legacy project dir's rules/ when .winter/rules is absent, and never writes there", () => {
    const { home, trust } = setup();
    const cwd = realDir();
    mkdirSync(join(cwd, LEGACY_PROJECT_DIR, "rules"), { recursive: true });
    writeFileSync(join(cwd, LEGACY_PROJECT_DIR, "rules", "a.md"), "LEGACY_RULE_BODY");
    trust.trust(cwd);
    const a = new ContextAssembler({ winterHome: home, trust, skills: new SkillStore({ winterHome: home, trust }), legacySettings: () => settingsWith(true) });
    const out = a.assemble({ cwd });
    expect(out).toContain("## Project rules (.winter/rules/)");
    expect(out).toContain("LEGACY_RULE_BODY");
    expect(out).toContain("Winter is reading legacy project files read-only");
    // read-only: assemble() must never have created a .winter/rules directory as a side effect.
    expect(existsSync(join(cwd, ".winter", "rules"))).toBe(false);
  });

  test("a real .winter/rules directory (even empty) wins over the legacy one — never falls back", () => {
    const { home, trust } = setup();
    const cwd = realDir();
    mkdirSync(join(cwd, ".winter", "rules"), { recursive: true }); // present, but empty
    mkdirSync(join(cwd, LEGACY_PROJECT_DIR, "rules"), { recursive: true });
    writeFileSync(join(cwd, LEGACY_PROJECT_DIR, "rules", "a.md"), "LEGACY_RULE_BODY — must never appear");
    trust.trust(cwd);
    const a = new ContextAssembler({ winterHome: home, trust, skills: new SkillStore({ winterHome: home, trust }), legacySettings: () => settingsWith(true) });
    const out = a.assemble({ cwd });
    expect(out).not.toContain("LEGACY_RULE_BODY");
  });

  test("only ONE combined notice line even when both instructions and rules fall back", () => {
    const { home, trust } = setup();
    const cwd = realDir();
    writeFileSync(join(cwd, LEGACY_INSTRUCTIONS_FILE), "legacy project prose");
    mkdirSync(join(cwd, LEGACY_PROJECT_DIR, "rules"), { recursive: true });
    writeFileSync(join(cwd, LEGACY_PROJECT_DIR, "rules", "a.md"), "LEGACY_RULE_BODY");
    trust.trust(cwd);
    const a = new ContextAssembler({ winterHome: home, trust, skills: new SkillStore({ winterHome: home, trust }), legacySettings: () => settingsWith(true) });
    const out = a.assemble({ cwd });
    const occurrences = out.split("Winter is reading legacy project files read-only").length - 1;
    expect(occurrences).toBe(1);
    expect(out).toContain(join(cwd, LEGACY_INSTRUCTIONS_FILE));
    expect(out).toContain(join(cwd, LEGACY_PROJECT_DIR, "rules"));
  });
});
