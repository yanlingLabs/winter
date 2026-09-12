// Review r0, Major M1 (P9c-4) — the visible per-project deprecation notice must cover ALL FOUR
// legacy readers, not just the two owned directly by `ContextAssembler` (instructions + rules).
// This file wires the REAL `OutputStyleStore` and `ProjectSettingsResolver` — the same classes
// `daemon.ts` constructs — into a `ContextAssembler`, exactly the way `daemon.ts` wires them
// (`styleResolver`, `legacySettingsOverlayPathsFor`), and proves each reader's legacy fallback
// actually reaches the ONE combined per-turn notice, end to end. Never the live `~/.winter`.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextAssembler } from "../../src/agent/context";
import { TrustStore } from "../../src/agent/trust";
import { SkillStore } from "../../src/agent/skills";
import { OutputStyleStore } from "../../src/agent/output-styles";
import { ProjectSettingsResolver } from "../../src/project-settings";
import { LEGACY_INSTRUCTIONS_FILE, LEGACY_PROJECT_DIR } from "../../src/legacy-names";
import { Settings } from "../../src/settings";

function realDir(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "winter-ctx-legacy-all-")));
}
function minimalSettings(readLegacyProjectFiles: boolean): Settings {
  return Settings.parse({ schemaVersion: 2, provider: { type: "codex-oauth", model: "x" }, legacy: { readLegacyProjectFiles } });
}

function build(cwd: string, home: string, settings: Settings) {
  const trust = new TrustStore(join(home, "trust.json"));
  trust.trust(cwd);
  const outputStyleStore = new OutputStyleStore({ winterHome: home, trust, legacySettings: () => settings });
  const projectSettings = new ProjectSettingsResolver({ base: () => settings, trust });
  const assembler = new ContextAssembler({
    winterHome: home,
    trust,
    skills: new SkillStore({ winterHome: home, trust }),
    legacySettings: () => settings,
    styleResolver: (c) => outputStyleStore.resolve("mine", c),
    legacySettingsOverlayPathsFor: (c) => projectSettings.legacyOverlayPathsUsed(c),
  });
  return assembler;
}

describe("ContextAssembler — the combined notice covers all four legacy readers (review M1)", () => {
  test("a legacy output-style registers its path, and the assembled system context names it", () => {
    const home = realDir();
    mkdirSync(join(home, "memory"), { recursive: true });
    const cwd = realDir();
    const legacyStylePath = join(cwd, LEGACY_PROJECT_DIR, "output-styles", "mine.md");
    mkdirSync(join(cwd, LEGACY_PROJECT_DIR, "output-styles"), { recursive: true });
    writeFileSync(legacyStylePath, "---\ndescription: legacy style\nkeep-coding-instructions: true\n---\nLEGACY_STYLE_BODY");

    const assembler = build(cwd, home, minimalSettings(true));
    const out = assembler.assemble({ cwd });

    expect(out).toContain("LEGACY_STYLE_BODY"); // the style itself was actually applied
    expect(out).toContain("Winter is reading legacy project files read-only");
    expect(out).toContain(legacyStylePath);
    expect(out).toContain("winter migrate-project");
  });

  test("a legacy settings.json overlay registers its path, and the assembled system context names it", () => {
    const home = realDir();
    mkdirSync(join(home, "memory"), { recursive: true });
    const cwd = realDir();
    const legacySettingsPath = join(cwd, LEGACY_PROJECT_DIR, "settings.json");
    mkdirSync(join(cwd, LEGACY_PROJECT_DIR), { recursive: true });
    writeFileSync(legacySettingsPath, JSON.stringify({ reviewer: { enabled: false } }));

    const assembler = build(cwd, home, minimalSettings(true));
    const out = assembler.assemble({ cwd });

    expect(out).toContain("Winter is reading legacy project files read-only");
    expect(out).toContain(legacySettingsPath);
  });

  test("both together: ONE combined notice names every legacy path in use, from all four readers at once", () => {
    const home = realDir();
    mkdirSync(join(home, "memory"), { recursive: true });
    const cwd = realDir();
    writeFileSync(join(cwd, LEGACY_INSTRUCTIONS_FILE), "legacy instructions prose");
    mkdirSync(join(cwd, LEGACY_PROJECT_DIR, "rules"), { recursive: true });
    writeFileSync(join(cwd, LEGACY_PROJECT_DIR, "rules", "a.md"), "LEGACY_RULE_BODY");
    mkdirSync(join(cwd, LEGACY_PROJECT_DIR, "output-styles"), { recursive: true });
    writeFileSync(join(cwd, LEGACY_PROJECT_DIR, "output-styles", "mine.md"), "---\ndescription: d\n---\nLEGACY_STYLE_BODY");
    writeFileSync(join(cwd, LEGACY_PROJECT_DIR, "settings.json"), JSON.stringify({ reviewer: { enabled: false } }));

    const assembler = build(cwd, home, minimalSettings(true));
    const out = assembler.assemble({ cwd });

    const occurrences = out.split("Winter is reading legacy project files read-only").length - 1;
    expect(occurrences).toBe(1); // ONE combined line, not one per reader
    expect(out).toContain(join(cwd, LEGACY_INSTRUCTIONS_FILE));
    expect(out).toContain(join(cwd, LEGACY_PROJECT_DIR, "rules"));
    expect(out).toContain(join(cwd, LEGACY_PROJECT_DIR, "output-styles", "mine.md"));
    expect(out).toContain(join(cwd, LEGACY_PROJECT_DIR, "settings.json"));
  });

  test("flag off: neither the output-style nor the settings-overlay reader registers anything, and no notice appears", () => {
    const home = realDir();
    mkdirSync(join(home, "memory"), { recursive: true });
    const cwd = realDir();
    mkdirSync(join(cwd, LEGACY_PROJECT_DIR, "output-styles"), { recursive: true });
    writeFileSync(join(cwd, LEGACY_PROJECT_DIR, "output-styles", "mine.md"), "---\ndescription: d\n---\nLEGACY_STYLE_BODY");
    writeFileSync(join(cwd, LEGACY_PROJECT_DIR, "settings.json"), JSON.stringify({ reviewer: { enabled: false } }));

    const assembler = build(cwd, home, minimalSettings(false));
    const out = assembler.assemble({ cwd });

    expect(out).not.toContain("LEGACY_STYLE_BODY");
    expect(out).not.toContain("Winter is reading legacy project files");
  });
});
