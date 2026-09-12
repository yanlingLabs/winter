// Phase 9c (P9c-4, Task M Step 7) — the legacy project output-styles read-only fallback.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OutputStyleStore } from "../../src/agent/output-styles";
import { LEGACY_PROJECT_DIR } from "../../src/legacy-names";
import type { Settings } from "../../src/settings";

const tmp = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), p)));
const trustStub = (trusted: boolean) => ({ isTrusted: (_d: string) => trusted });
function settingsWith(readLegacyProjectFiles: boolean): Settings {
  return { schemaVersion: 1, legacy: { readLegacyProjectFiles } } as unknown as Settings;
}

describe("OutputStyleStore — legacy project output-styles fallback (P9c-4)", () => {
  test("resolve(): falls back to the legacy project dir when .winter/output-styles/<name>.md is absent and the flag is on", () => {
    const home = tmp("nh-");
    const cwd = tmp("cwd-");
    mkdirSync(join(cwd, LEGACY_PROJECT_DIR, "output-styles"), { recursive: true });
    writeFileSync(join(cwd, LEGACY_PROJECT_DIR, "output-styles", "mine.md"), "---\ndescription: legacy one\n---\nLEGACY_BODY");
    const store = new OutputStyleStore({ winterHome: home, trust: trustStub(true), legacySettings: () => settingsWith(true) });
    const r = store.resolve("mine", cwd);
    expect(r?.body).toBe("LEGACY_BODY");
    expect(r?.description).toBe("legacy one");
  });

  test("resolve(): a Winter-named file wins over a co-existing legacy one of the same name", () => {
    const home = tmp("nh-");
    const cwd = tmp("cwd-");
    mkdirSync(join(cwd, ".winter", "output-styles"), { recursive: true });
    writeFileSync(join(cwd, ".winter", "output-styles", "mine.md"), "---\ndescription: winter one\n---\nWINTER_BODY");
    mkdirSync(join(cwd, LEGACY_PROJECT_DIR, "output-styles"), { recursive: true });
    writeFileSync(join(cwd, LEGACY_PROJECT_DIR, "output-styles", "mine.md"), "---\ndescription: legacy one\n---\nLEGACY_BODY");
    const store = new OutputStyleStore({ winterHome: home, trust: trustStub(true), legacySettings: () => settingsWith(true) });
    const r = store.resolve("mine", cwd);
    expect(r?.body).toBe("WINTER_BODY");
  });

  test("resolve(): flag off — the legacy style is ignored entirely", () => {
    const home = tmp("nh-");
    const cwd = tmp("cwd-");
    mkdirSync(join(cwd, LEGACY_PROJECT_DIR, "output-styles"), { recursive: true });
    writeFileSync(join(cwd, LEGACY_PROJECT_DIR, "output-styles", "mine.md"), "---\ndescription: legacy one\n---\nLEGACY_BODY");
    const store = new OutputStyleStore({ winterHome: home, trust: trustStub(true), legacySettings: () => settingsWith(false) });
    expect(store.resolve("mine", cwd)).toBeNull();
  });

  test("resolve(): no legacySettings dep at all — byte-identical to pre-9c behavior", () => {
    const home = tmp("nh-");
    const cwd = tmp("cwd-");
    mkdirSync(join(cwd, LEGACY_PROJECT_DIR, "output-styles"), { recursive: true });
    writeFileSync(join(cwd, LEGACY_PROJECT_DIR, "output-styles", "mine.md"), "---\ndescription: legacy one\n---\nLEGACY_BODY");
    const store = new OutputStyleStore({ winterHome: home, trust: trustStub(true) });
    expect(store.resolve("mine", cwd)).toBeNull();
  });

  test("resolve(): untrusted cwd never falls back", () => {
    const home = tmp("nh-");
    const cwd = tmp("cwd-");
    mkdirSync(join(cwd, LEGACY_PROJECT_DIR, "output-styles"), { recursive: true });
    writeFileSync(join(cwd, LEGACY_PROJECT_DIR, "output-styles", "mine.md"), "---\ndescription: legacy one\n---\nLEGACY_BODY");
    const store = new OutputStyleStore({ winterHome: home, trust: trustStub(false), legacySettings: () => settingsWith(true) });
    expect(store.resolve("mine", cwd)).toBeNull();
  });

  test("list(): includes legacy project styles when the Winter-named directory does not exist at all", () => {
    const home = tmp("nh-");
    const cwd = tmp("cwd-");
    mkdirSync(join(cwd, LEGACY_PROJECT_DIR, "output-styles"), { recursive: true });
    writeFileSync(join(cwd, LEGACY_PROJECT_DIR, "output-styles", "mine.md"), "---\ndescription: legacy one\n---\nLEGACY_BODY");
    const store = new OutputStyleStore({ winterHome: home, trust: trustStub(true), legacySettings: () => settingsWith(true) });
    const names = store.list(cwd).map((s) => s.name);
    expect(names).toContain("mine");
  });

  test("list(): a present (even empty) Winter-named directory wins — the legacy directory is never scanned", () => {
    const home = tmp("nh-");
    const cwd = tmp("cwd-");
    mkdirSync(join(cwd, ".winter", "output-styles"), { recursive: true }); // present, empty
    mkdirSync(join(cwd, LEGACY_PROJECT_DIR, "output-styles"), { recursive: true });
    writeFileSync(join(cwd, LEGACY_PROJECT_DIR, "output-styles", "mine.md"), "---\ndescription: legacy one\n---\nLEGACY_BODY");
    const store = new OutputStyleStore({ winterHome: home, trust: trustStub(true), legacySettings: () => settingsWith(true) });
    const names = store.list(cwd).map((s) => s.name);
    expect(names).not.toContain("mine");
  });
});
