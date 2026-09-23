// WS-21 L3.7 (spec §8): `winter doctor`'s shared-runtime-home section — read-only, never throwing,
// counts and paths only.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sdkHomeDoctorLines } from "../../src/migration/sdk-home-doctor";
import { runMigrationC } from "../../src/migration/migrate-c";
import { openRuntimeStateDb } from "../../src/runtime-state/db";
import { RuntimeSessionRecords } from "../../src/runtime-state/records";

const tmpHome = (): string => realpathSync(mkdtempSync(join(tmpdir(), "winter-sdkdoc-")));

describe("sdkHomeDoctorLines", () => {
  test("a fresh home: the new layout, nothing else", () => {
    expect(sdkHomeDoctorLines(tmpHome())).toEqual(["sdk home: the shared runtime home layout (no migration needed)"]);
  });

  test("an old-layout home names the way forward", () => {
    const home = tmpHome();
    mkdirSync(join(home, "projects", "k"), { recursive: true });
    writeFileSync(join(home, "projects", "k", "s.jsonl"), "{}\n");
    expect(sdkHomeDoctorLines(home)[0]).toContain("old layout");
  });

  test("after Migration C: status and archive, the split, untranslated rules, the approved-rules leftovers, quarantined roots", async () => {
    const home = tmpHome();
    mkdirSync(join(home, "projects", "k"), { recursive: true });
    writeFileSync(join(home, "projects", "k", "s.jsonl"), "{}\n");
    mkdirSync(join(home, "sdk", "projects"), { recursive: true });
    writeFileSync(join(home, "settings.json"), JSON.stringify({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.6-sol" }, permissions: { allow: ["Bash(rm *)", "Bash(ls)"] } }));
    mkdirSync(join(home, "permissions"), { recursive: true });
    writeFileSync(join(home, "permissions", "projects.json"), JSON.stringify({ version: 1, projects: { "/a": ["Bash(make)"], "/b": ["Edit"] } }));
    openRuntimeStateDb(home).close();
    await runMigrationC(home, { log: () => {}, reconcileAvailable: true, probe: { alive: () => false, startedAt: () => "unknown" } });
    const rs = openRuntimeStateDb(home);
    new RuntimeSessionRecords(rs).noteQuarantinedRoot(join(home, "cache", "runs", "r1"));
    rs.close();
    const text = sdkHomeDoctorLines(home).join("\n");
    expect(text).toContain("migrated (Migration C complete");
    expect(text).toContain("settings split:");
    expect(text).toContain("untranslated rules: 1");
    expect(text).toContain('approved rules: 2 project(s) still have "in this project" answers');
    expect(text).toContain("winter migrate-project");
    expect(text).toContain(`quarantined run roots: 1 kept`);
    expect(text).not.toContain("Bash(make)"); // counts and paths, never the rules themselves
  });

  test("a half-migrated home says so", () => {
    const home = tmpHome();
    mkdirSync(join(home, "migration", "c"), { recursive: true });
    writeFileSync(join(home, "migration", "c", "manifest.json"), "{ torn");
    expect(sdkHomeDoctorLines(home)[0]).toContain("HALF-MIGRATED");
  });
});
