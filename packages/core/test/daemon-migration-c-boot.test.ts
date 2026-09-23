// WS-21 L3.7 (spec §8): Migration C's boot hook, on a build whose router applies run homes (pinned with
// `setRunHomeSupportForTests(true)` — router 0.0.11 does not, and there the old layout IS the layout).
//
//   the profile's default home in the old layout → phase 1 runs at boot, phase 2 at the late site
//   a preflight refusal on the default home        → boot refuses, typed (never log-and-continue)
//   any other home in the old layout               → boot refuses `sdk_home_migration_required`
//   a half-migrated home                           → boot refuses `sdk_home_half_migrated` (every build)
//   a fresh temp home seeded with settings         → boots; the settings split copies the moved keys
//
// Every home is a mkdtemp; the default-home gate is driven by `homedirOverride` (P9c-15), never the real ~.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon, type RunningDaemon } from "../src/daemon";
import { FileSecretStore } from "../src/auth/secret-store";
import { setRunHomeSupportForTests } from "../src/runtime-sdk/run-home-support";
import { MigrationCRefused, migrationCCompletePath, migrationCState } from "../src/migration/migrate-c";
import { openRuntimeStateDb } from "../src/runtime-state/db";
import { readSdkSettings } from "../src/sdk-files";

let daemon: RunningDaemon | undefined;
afterEach(async () => {
  await daemon?.stop();
  daemon = undefined;
  setRunHomeSupportForTests(undefined);
});

const parentDir = (): string => realpathSync(mkdtempSync(join(tmpdir(), "winter-migc-boot-")));

function seedOldLayout(home: string): void {
  mkdirSync(join(home, "projects", "-Users-x-app", "memory"), { recursive: true });
  writeFileSync(join(home, "projects", "-Users-x-app", "s1.jsonl"), '{"type":"user","uuid":"u1"}\n');
  writeFileSync(join(home, "projects", "-Users-x-app", "memory", "MEMORY.md"), "- a fact\n");
  mkdirSync(join(home, "skills", "self", "deploy"), { recursive: true });
  writeFileSync(join(home, "skills", "self", "deploy", "SKILL.md"), "---\nname: deploy\n---\n");
  writeFileSync(join(home, "settings.json"), JSON.stringify({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.6-sol" }, outputStyle: "terse" }));
}

async function boot(home: string, parent: string): Promise<RunningDaemon> {
  return startDaemon({
    home,
    secrets: new FileSecretStore(join(parent, "secrets")),
    migration: { legacyHome: join(parent, "no-legacy-home"), homedirOverride: () => parent },
    agentProvider: null,
  });
}

describe("Migration C at boot (run-home router)", () => {
  test("the default home in the old layout migrates: phase 1 at boot, phase 2 at the late site, then boots", async () => {
    setRunHomeSupportForTests(true);
    const parent = parentDir();
    const home = join(parent, ".winter");
    seedOldLayout(home);
    daemon = await boot(home, parent);
    expect(lstatSync(join(home, "projects")).isSymbolicLink()).toBe(true);
    expect(existsSync(join(home, "sdk", "projects", "-Users-x-app", "memory", "MEMORY.md"))).toBe(true);
    expect(existsSync(join(home, "sdk", "skills", "self", "deploy", "SKILL.md"))).toBe(true);
    // no official working copy to reconcile, so phase 2 completed at this very boot
    expect(migrationCState(home)).toMatchObject({ kind: "parsed", manifest: { status: "complete" } });
    expect(existsSync(migrationCCompletePath(home))).toBe(true);
    expect((readSdkSettings(home) as Record<string, unknown>).outputStyle).toBe("terse");
    expect(daemon.settings()).not.toBeNull();
  });

  test("a preflight refusal on the default home refuses BOOT, typed, and moves nothing", async () => {
    setRunHomeSupportForTests(true);
    const parent = parentDir();
    const home = join(parent, ".winter");
    seedOldLayout(home);
    mkdirSync(join(home, "sdk", "projects"), { recursive: true });
    writeFileSync(join(home, "sdk", "projects", "stray.jsonl"), "x"); // sdk/ already has content
    let caught: unknown;
    try { daemon = await boot(home, parent); } catch (err) { caught = err; }
    expect(caught).toBeInstanceOf(MigrationCRefused);
    expect((caught as MigrationCRefused).code).toBe("sdk_home_migration_refused");
    expect(lstatSync(join(home, "projects")).isDirectory()).toBe(true);
    expect(lstatSync(join(home, "projects")).isSymbolicLink()).toBe(false);
  });

  test("a non-default home in the old layout refuses sdk_home_migration_required", async () => {
    setRunHomeSupportForTests(true);
    const parent = parentDir();
    const home = join(parent, "custom-home");
    seedOldLayout(home);
    let caught: unknown;
    try { daemon = await boot(home, parent); } catch (err) { caught = err; }
    expect((caught as MigrationCRefused).code).toBe("sdk_home_migration_required");
    expect((caught as Error).message).toContain("winter migrate --sdk-home --home");
    expect(lstatSync(join(home, "projects")).isSymbolicLink()).toBe(false);
  });

  test("a half-migrated home refuses sdk_home_half_migrated, whatever the router", async () => {
    const parent = parentDir();
    const home = join(parent, "half");
    mkdirSync(join(home, "migration", "c"), { recursive: true });
    writeFileSync(join(home, "migration", "c", "manifest.json"), JSON.stringify({ schemaVersion: 1, status: "in-progress", steps: [] }));
    let caught: unknown;
    try { daemon = await boot(home, parent); } catch (err) { caught = err; }
    expect((caught as MigrationCRefused).code).toBe("sdk_home_half_migrated");
  });

  test("a fresh temp home seeded with settings boots, and the split copies the moved keys", async () => {
    setRunHomeSupportForTests(true);
    const parent = parentDir();
    const home = join(parent, "fresh");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "settings.json"), JSON.stringify({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.6-sol" }, permissions: { allow: ["Bash(ls)"] }, mcpServers: { a: { type: "stdio", command: "x" } } }));
    daemon = await boot(home, parent);
    expect(migrationCState(home).kind).toBe("absent");
    expect((readSdkSettings(home) as Record<string, any>).permissions.allow).toEqual(["Bash(ls)"]);
  });

  test("the dev profile's default home (~/.winter-dev, by homedirOverride) migrates the same way", async () => {
    setRunHomeSupportForTests(true);
    const prior = process.env.WINTER_PROFILE;
    process.env.WINTER_PROFILE = "dev";
    try {
      const parent = parentDir();
      const home = join(parent, ".winter-dev");
      seedOldLayout(home);
      daemon = await boot(home, parent);
      expect(lstatSync(join(home, "projects")).isSymbolicLink()).toBe(true);
      expect(migrationCState(home)).toMatchObject({ kind: "parsed", manifest: { status: "complete" } });
    } finally {
      if (prior === undefined) delete process.env.WINTER_PROFILE; else process.env.WINTER_PROFILE = prior;
    }
  });

  test("router 0.0.11 (no run homes): the old layout is left exactly as it is", async () => {
    setRunHomeSupportForTests(false);
    const parent = parentDir();
    const home = join(parent, ".winter");
    seedOldLayout(home);
    daemon = await boot(home, parent);
    expect(lstatSync(join(home, "projects")).isSymbolicLink()).toBe(false);
    expect(migrationCState(home).kind).toBe("absent");
    const rs = openRuntimeStateDb(home);
    rs.close();
  });
});
