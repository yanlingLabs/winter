// Phase 9c (P9c-4, Task M Step 7) — the legacy project settings-overlay read-only fallback.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectSettingsResolver } from "../src/project-settings";
import { Settings } from "../src/settings";
import { LEGACY_PROJECT_DIR } from "../src/legacy-names";

function tmpDir(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}
function minimalBase(overrides: Record<string, unknown> = {}): Settings {
  return Settings.parse({ schemaVersion: 2, provider: { type: "codex-oauth", model: "x" }, ...overrides });
}

describe("ProjectSettingsResolver — legacy project settings-overlay fallback (P9c-4)", () => {
  test("falls back to the legacy project dir's settings.json when .winter/settings.json is absent and the flag is on", () => {
    const cwd = tmpDir("winter-psr-legacy-a-");
    mkdirSync(join(cwd, LEGACY_PROJECT_DIR), { recursive: true });
    writeFileSync(join(cwd, LEGACY_PROJECT_DIR, "settings.json"), JSON.stringify({ reviewer: { enabled: false } }));
    const base = minimalBase({ reviewer: { enabled: true }, legacy: { readLegacyProjectFiles: true } });
    const resolver = new ProjectSettingsResolver({ base: () => base, trust: { isTrusted: () => true } });
    expect(resolver.effective(cwd)?.reviewer?.enabled).toBe(false);
  });

  test("a .winter/settings.json overlay wins over a co-existing legacy one", () => {
    const cwd = tmpDir("winter-psr-legacy-b-");
    mkdirSync(join(cwd, ".winter"), { recursive: true });
    writeFileSync(join(cwd, ".winter", "settings.json"), JSON.stringify({ reviewer: { enabled: false } }));
    mkdirSync(join(cwd, LEGACY_PROJECT_DIR), { recursive: true });
    writeFileSync(join(cwd, LEGACY_PROJECT_DIR, "settings.json"), JSON.stringify({ reviewer: { enabled: true }, cleaner: { enabled: false } }));
    const base = minimalBase({ reviewer: { enabled: true }, legacy: { readLegacyProjectFiles: true } });
    const resolver = new ProjectSettingsResolver({ base: () => base, trust: { isTrusted: () => true } });
    const effective = resolver.effective(cwd);
    expect(effective?.reviewer?.enabled).toBe(false); // from .winter, not the legacy dir
    expect(effective?.cleaner?.enabled).toBeUndefined(); // legacy dir's OTHER key never merged in
  });

  test("flag off: the legacy overlay is ignored entirely", () => {
    const cwd = tmpDir("winter-psr-legacy-c-");
    mkdirSync(join(cwd, LEGACY_PROJECT_DIR), { recursive: true });
    writeFileSync(join(cwd, LEGACY_PROJECT_DIR, "settings.json"), JSON.stringify({ reviewer: { enabled: false } }));
    const base = minimalBase({ reviewer: { enabled: true }, legacy: { readLegacyProjectFiles: false } });
    const resolver = new ProjectSettingsResolver({ base: () => base, trust: { isTrusted: () => true } });
    expect(resolver.effective(cwd)?.reviewer?.enabled).toBe(true);
  });

  test("untrusted cwd: never falls back, same gate as the Winter-named overlay", () => {
    const cwd = tmpDir("winter-psr-legacy-d-");
    mkdirSync(join(cwd, LEGACY_PROJECT_DIR), { recursive: true });
    writeFileSync(join(cwd, LEGACY_PROJECT_DIR, "settings.json"), JSON.stringify({ reviewer: { enabled: false } }));
    const base = minimalBase({ reviewer: { enabled: true }, legacy: { readLegacyProjectFiles: true } });
    const resolver = new ProjectSettingsResolver({ base: () => base, trust: { isTrusted: () => false } });
    expect(resolver.effective(cwd)?.reviewer?.enabled).toBe(true);
  });

  test("a symlinked legacy project dir is treated as absent, never followed (same symlink-safety shape as .winter)", () => {
    const cwd = tmpDir("winter-psr-legacy-e-");
    const decoy = tmpDir("winter-psr-legacy-e-decoy-");
    writeFileSync(join(decoy, "settings.json"), JSON.stringify({ reviewer: { enabled: false } }));
    symlinkSync(decoy, join(cwd, LEGACY_PROJECT_DIR));
    const base = minimalBase({ reviewer: { enabled: true }, legacy: { readLegacyProjectFiles: true } });
    const resolver = new ProjectSettingsResolver({ base: () => base, trust: { isTrusted: () => true } });
    expect(resolver.effective(cwd)?.reviewer?.enabled).toBe(true);
  });

  test("settings.local.json falls back independently of settings.json (each file's own presence decides)", () => {
    const cwd = tmpDir("winter-psr-legacy-f-");
    mkdirSync(join(cwd, ".winter"), { recursive: true });
    writeFileSync(join(cwd, ".winter", "settings.json"), JSON.stringify({ reviewer: { enabled: false } }));
    mkdirSync(join(cwd, LEGACY_PROJECT_DIR), { recursive: true });
    writeFileSync(join(cwd, LEGACY_PROJECT_DIR, "settings.local.json"), JSON.stringify({ permissions: { additionalDirectories: ["/legacy-local"] } }));
    const base = minimalBase({ reviewer: { enabled: true }, legacy: { readLegacyProjectFiles: true } });
    const resolver = new ProjectSettingsResolver({ base: () => base, trust: { isTrusted: () => true } });
    const effective = resolver.effective(cwd);
    expect(effective?.reviewer?.enabled).toBe(false); // from .winter/settings.json
    expect(effective?.permissions?.additionalDirectories).toContain("/legacy-local"); // from the legacy local file
  });

  test("re-reads after the legacy file changes even while purely on the fallback path (cache signature includes it)", () => {
    const cwd = tmpDir("winter-psr-legacy-g-");
    mkdirSync(join(cwd, LEGACY_PROJECT_DIR), { recursive: true });
    writeFileSync(join(cwd, LEGACY_PROJECT_DIR, "settings.json"), JSON.stringify({ reviewer: { enabled: false } }));
    const base = minimalBase({ reviewer: { enabled: true }, legacy: { readLegacyProjectFiles: true } });
    const resolver = new ProjectSettingsResolver({ base: () => base, trust: { isTrusted: () => true } });
    expect(resolver.effective(cwd)?.reviewer?.enabled).toBe(false);
    writeFileSync(join(cwd, LEGACY_PROJECT_DIR, "settings.json"), JSON.stringify({ cleaner: { enabled: false } }));
    const second = resolver.effective(cwd);
    expect(second?.reviewer?.enabled).toBe(true); // no longer overridden
    expect(second?.cleaner?.enabled).toBe(false);
  });
});
