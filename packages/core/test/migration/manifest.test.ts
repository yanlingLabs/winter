import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearWorkingManifest,
  completeMarkerPath,
  manifestFileState,
  manifestPath,
  migrationDir,
  readMigrationManifest,
  rolledBackManifestPath,
  writeManifestAtomic,
  type MigrationManifest,
} from "../../src/migration/manifest";

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "winter-migration-manifest-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function freshManifest(home: string): MigrationManifest {
  return {
    schemaVersion: 1,
    startedAt: new Date().toISOString(),
    legacyHome: "/legacy",
    home,
    profile: "dev",
    status: "in-progress",
    entries: [],
    keychain: [],
  };
}

describe("migration manifest", () => {
  test("readMigrationManifest returns null when no manifest file exists", () => {
    const home = tempDir();
    expect(readMigrationManifest(home)).toBeNull();
    expect(manifestFileState(home)).toEqual({ kind: "absent" });
  });

  test("writeManifestAtomic then readMigrationManifest round-trips", () => {
    const home = tempDir();
    const m = freshManifest(home);
    writeManifestAtomic(home, m);
    expect(readMigrationManifest(home)).toEqual(m);
  });

  test("a corrupt manifest file reads as null from readMigrationManifest, but as 'unreadable' from manifestFileState (fail-closed distinction)", () => {
    const home = tempDir();
    writeManifestAtomic(home, freshManifest(home)); // creates migration/ + a valid manifest first
    writeFileSync(manifestPath(home), "{ not json at all", { mode: 0o600 });
    expect(readMigrationManifest(home)).toBeNull();
    expect(manifestFileState(home)).toEqual({ kind: "unreadable" });
  });

  test("a manifest missing required fields reads as unreadable, not as a parsed shape", () => {
    const home = tempDir();
    writeManifestAtomic(home, freshManifest(home));
    writeFileSync(manifestPath(home), JSON.stringify({ schemaVersion: 1 }), { mode: 0o600 });
    expect(manifestFileState(home)).toEqual({ kind: "unreadable" });
  });

  test("clearWorkingManifest removes manifest.json and COMPLETE but keeps the migration/ directory", () => {
    const home = tempDir();
    writeManifestAtomic(home, { ...freshManifest(home), status: "complete", finishedAt: new Date().toISOString() });
    writeFileSync(completeMarkerPath(home), "");
    clearWorkingManifest(home);
    expect(readMigrationManifest(home)).toBeNull();
    expect(manifestFileState(home)).toEqual({ kind: "absent" });
    // The directory itself survives (rollback then writes manifest.rolled-back.json into it).
    writeFileSync(rolledBackManifestPath(home), JSON.stringify({ ok: true }));
    expect(readMigrationManifest(home)).toBeNull(); // rolled-back file is not the working manifest
  });

  test("paths are all scoped under <home>/migration", () => {
    const home = "/tmp/example-home";
    expect(migrationDir(home)).toBe(join(home, "migration"));
    expect(manifestPath(home)).toBe(join(home, "migration", "manifest.json"));
    expect(completeMarkerPath(home)).toBe(join(home, "migration", "COMPLETE"));
    expect(rolledBackManifestPath(home)).toBe(join(home, "migration", "manifest.rolled-back.json"));
  });
});
