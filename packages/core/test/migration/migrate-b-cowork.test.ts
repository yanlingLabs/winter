// Migration B and Cowork storage. docs/cowork-execution-contracts.md, "Host storage authority, fences and
// migration": Cowork storage and its canonical database move only through a coordinated quiescent
// migration; a plain copy would orphan volumes from their records, drop the WAL, and duplicate the home
// identity. This build has no coordinated migration, so every route REFUSES or SKIPS, and never writes.
// Each guard has its own test so removing it alone fails a test (mutation checked in the PR).
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { classifyLegacyEntry, MigrationRefused, planMigrationB, readMigrationManifest, resumeMigrationB, rollbackMigrationB, runMigrationB, type MigrationDeps, type MigrationPlan } from "../../src/migration/migrate-b";
import { inspectCoworkSource, isCoworkStorageRel } from "../../src/migration/cowork-exclusion";
import { manifestPath, writeManifestAtomic } from "../../src/migration/manifest";
import { FileSecretStore } from "../../src/auth/secret-store";
import { openRuntimeStateDb } from "../../src/runtime-state/db";
import { CoworkRepository } from "../../src/cowork/repository";

const dirs: string[] = [];
const tempDir = (prefix = "winter-migrate-b-cowork-"): string => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; };
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

const write = (path: string, content: string | Buffer): void => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, content); };
const deps = (): MigrationDeps => ({ from: new FileSecretStore(tempDir("secrets-from-")), to: new FileSecretStore(tempDir("secrets-to-")), log: () => {} });

/** A legacy-shaped source: settings.json plus ordinary migratable content. */
function seedSource(root: string): void {
  write(join(root, "settings.json"), JSON.stringify({ schemaVersion: 1 }));
  write(join(root, "sessions", "s1", "a.jsonl"), '{"type":"user_message"}\n');
  write(join(root, "memory", "_global", "x.md"), "# memory\n");
}
const WORKSPACE = "ws_fixture";
/** Images, a manifest, and shared artifacts whose names collide with Migration B's generic rules. */
function seedCoworkTree(root: string): string[] {
  const base = join(root, "cowork", "workspaces", WORKSPACE);
  const files = [
    "data.ext4", "env.ext4", "manifest.json",
    "shared/instructions/WINTER.md", "shared/memory/notes.md",
    "shared/outputs/s1/index.db", "shared/outputs/s1/report.db-wal", "shared/outputs/s1/report.db-shm",
  ];
  for (const rel of files) write(join(base, rel), `bytes of ${rel}`);
  return files.map(rel => join(base, rel));
}
/** Every path (type, size, mtime, content hash) so "source untouched" is a real byte-level claim. */
function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const abs = join(dir, name), st = lstatSync(abs), rel = relative(root, abs);
      if (st.isDirectory()) { out[rel] = "dir"; walk(abs); }
      else if (st.isSymbolicLink()) out[rel] = "symlink";
      else out[rel] = `${st.size}:${st.mtimeMs}:${createHash("sha256").update(readFileSync(abs)).digest("hex")}`;
    }
  };
  walk(root);
  return out;
}
const refusalOf = async (run: () => Promise<unknown>): Promise<MigrationRefused> => {
  try { await run(); } catch (error) { expect(error).toBeInstanceOf(MigrationRefused); return error as MigrationRefused; }
  throw new Error("expected a MigrationRefused");
};
/** A real runtime-state database. `rows` puts one canonical Cowork row in it (the home identity). */
function seedRuntimeState(root: string, rows: boolean, sidecars: boolean): void {
  const rs = openRuntimeStateDb(root);
  try {
    if (rows) new CoworkRepository(rs).homeIdentity();
    rs.db.run("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally { rs.close(); }
  if (!sidecars) for (const suffix of ["-wal", "-shm"]) rmSync(join(root, "runtimes", `runtime-state.db${suffix}`), { force: true });
}

describe("isCoworkStorageRel", () => {
  test("is exactly the cowork root and what is beneath it", () => {
    expect(isCoworkStorageRel("cowork")).toBe(true);
    expect(isCoworkStorageRel("cowork/workspaces/w/data.ext4")).toBe(true);
    for (const rel of ["coworker/x", "cowork.txt", "sessions/cowork/x", "projects/cowork", ""]) expect(isCoworkStorageRel(rel)).toBe(false);
  });
});

describe("classification barrier (independent of the planner refusal)", () => {
  test("anything under cowork/ is skipped — even names the generic rules would rebuild or copy — while lookalikes stay ordinary", () => {
    for (const rel of ["cowork/workspaces/w/data.ext4", "cowork/workspaces/w/env.ext4", "cowork/workspaces/w/manifest.json", "cowork/workspaces/w/shared/outputs/s/index.db", "cowork/workspaces/w/shared/outputs/s/x.db-wal", "cowork/workspaces/w/shared/memory/notes.md", "cowork/control/x"]) {
      expect(classifyLegacyEntry(rel, true)).toBe("skipped");
    }
    expect(classifyLegacyEntry("sessions/index.db", true)).toBe("rebuilt");
    expect(classifyLegacyEntry("memory/_global/x.md", true)).toBe("copied");
    expect(classifyLegacyEntry("coworker/notes.md", true)).toBe("copied");
  });
});

describe("planMigrationB refuses a source that holds Cowork storage, before anything is written", () => {
  test("a populated cowork/ tree refuses with a typed code; the source is byte-identical and the destination stays empty", async () => {
    const source = tempDir(), home = tempDir();
    seedSource(source); seedCoworkTree(source);
    const before = snapshot(source), homeBefore = snapshot(home);
    const refusal = await refusalOf(() => planMigrationB({ legacyHome: source, home, profile: "dev" }));
    expect(refusal.code).toBe("cowork_storage_present");
    expect(refusal.message).toContain("cowork/");
    expect(snapshot(source)).toEqual(before);
    expect(snapshot(home)).toEqual(homeBefore);
    expect(readMigrationManifest(home)).toBeNull();
  });

  test("an empty workspace directory is still Cowork storage (storage creates the directory first)", async () => {
    const source = tempDir(), home = tempDir();
    seedSource(source); mkdirSync(join(source, "cowork", "workspaces", WORKSPACE, "shared"), { recursive: true });
    expect((await refusalOf(() => planMigrationB({ legacyHome: source, home, profile: "dev" }))).code).toBe("cowork_storage_present");
  });

  test("an empty cowork/ root alone is not storage; an ordinary legacy home still plans", async () => {
    const source = tempDir(), home = tempDir();
    seedSource(source); mkdirSync(join(source, "cowork"));
    const plan = await planMigrationB({ legacyHome: source, home, profile: "dev" });
    expect(plan.entries.some(entry => entry.status === "copied")).toBe(true);
  });

  test("a symlink named cowork is refused, never followed", async () => {
    const source = tempDir(), home = tempDir(), elsewhere = tempDir();
    seedSource(source); symlinkSync(elsewhere, join(source, "cowork"));
    expect((await refusalOf(() => planMigrationB({ legacyHome: source, home, profile: "dev" }))).code).toBe("cowork_storage_present");
  });

  for (const sidecars of [true, false]) {
    test(`a runtime-state database with canonical Cowork rows refuses (${sidecars ? "WAL sidecars present" : "no sidecars"}), and the source is not modified`, async () => {
      const source = tempDir(), home = tempDir();
      seedSource(source); seedRuntimeState(source, true, sidecars);
      const before = snapshot(source);
      const refusal = await refusalOf(() => planMigrationB({ legacyHome: source, home, profile: "dev" }));
      expect(refusal.code).toBe("cowork_storage_present");
      expect(refusal.message).toContain("authority");
      expect(snapshot(source)).toEqual(before);
      expect(readMigrationManifest(home)).toBeNull();
    });
  }

  test("a runtime-state database whose Cowork tables are empty does not block an ordinary migration", async () => {
    const source = tempDir(), home = tempDir();
    seedSource(source); seedRuntimeState(source, false, true);
    expect(inspectCoworkSource(source)).toEqual({ present: false });
    const plan = await planMigrationB({ legacyHome: source, home, profile: "dev" });
    expect(plan.entries.length).toBeGreaterThan(0);
  });

  test("a runtime-state database that cannot be inspected fails closed", async () => {
    const source = tempDir(), home = tempDir();
    seedSource(source); write(join(source, "runtimes", "runtime-state.db"), "this is not a sqlite database at all");
    const refusal = await refusalOf(() => planMigrationB({ legacyHome: source, home, profile: "dev" }));
    expect(refusal.code).toBe("cowork_storage_present");
    expect(refusal.message).toContain("could not be inspected");
  });
});

describe("execution barrier: a plan can never copy, rekey or rebuild a Cowork path", () => {
  const poisoned = async (status: "copied" | "rekeyed" | "rebuilt"): Promise<{ plan: MigrationPlan; home: string; source: string }> => {
    const source = tempDir(), home = tempDir();
    seedSource(source); const [image] = seedCoworkTree(source) as [string];
    const plan = await planMigrationB({ legacyHome: source, home, profile: "dev" }).catch(() => undefined) ?? { legacyHome: source, home, profile: "dev" as const, entries: [] };
    plan.entries.push({ src: image, dest: join(home, relative(source, image)), status });
    return { plan, home, source };
  };
  for (const status of ["copied", "rekeyed", "rebuilt"] as const) {
    test(`a hand-built plan with a ${status} Cowork entry is refused before the manifest or any file is written`, async () => {
      const { plan, home, source } = await poisoned(status);
      const before = snapshot(source);
      expect((await refusalOf(() => runMigrationB(plan, deps()))).code).toBe("cowork_storage_present");
      expect(existsSync(join(home, "cowork"))).toBe(false);
      expect(readdirSync(home)).toEqual([]);
      expect(snapshot(source)).toEqual(before);
    });
  }
  test("a skipped Cowork entry is allowed through — skipping is the safe direction", async () => {
    const source = tempDir(), home = tempDir();
    seedSource(source);
    const plan = await planMigrationB({ legacyHome: source, home, profile: "dev" });
    plan.entries.push({ src: join(source, "cowork", "x"), dest: join(home, "cowork", "x"), status: "skipped" });
    const manifest = await runMigrationB(plan, deps());
    expect(manifest.status).toBe("complete");
    expect(existsSync(join(home, "cowork"))).toBe(false);
  });
});

describe("resume applies the same refusal", () => {
  test("Cowork storage that appears in the source after an interrupted run blocks the resume; nothing more is copied", async () => {
    const source = tempDir(), home = tempDir();
    seedSource(source);
    const plan = await planMigrationB({ legacyHome: source, home, profile: "dev" });
    // Interrupt after the first file, leaving an in-progress manifest.
    await expect(runMigrationB(plan, { ...deps(), beforeEntry: step => { if (step.kind === "file" && step.index === 1) throw new Error("crash"); } })).rejects.toThrow("crash");
    expect(readMigrationManifest(home)?.status).toBe("in-progress");
    const copiedBefore = readMigrationManifest(home)!.entries.length;
    seedCoworkTree(source);
    expect((await refusalOf(() => resumeMigrationB(home, deps()))).code).toBe("cowork_storage_present");
    expect(readMigrationManifest(home)!.entries.length).toBe(copiedBefore);
    expect(existsSync(join(home, "cowork"))).toBe(false);
  });
});

describe("rollback never removes Cowork storage", () => {
  test("a manifest that lists a Cowork file as migrated (even with a matching hash) leaves that file in place", async () => {
    const source = tempDir(), home = tempDir();
    seedSource(source);
    const plan = await planMigrationB({ legacyHome: source, home, profile: "dev" });
    await runMigrationB(plan, deps());
    // The destination later holds a Cowork volume; a hand-edited manifest claims the migration wrote it.
    const volume = join(home, "cowork", "workspaces", WORKSPACE, "data.ext4");
    write(volume, "guest volume bytes");
    const manifest = readMigrationManifest(home)!;
    manifest.entries.push({ src: join(source, "x"), dest: volume, sha256: createHash("sha256").update("guest volume bytes").digest("hex"), bytes: 18, status: "copied" });
    writeManifestAtomic(home, manifest);
    expect(existsSync(manifestPath(home))).toBe(true);
    const logs: string[] = [];
    await rollbackMigrationB(home, { log: line => logs.push(line) });
    expect(readFileSync(volume, "utf8")).toBe("guest volume bytes");
    expect(logs.some(line => line.includes("Cowork storage is never removed"))).toBe(true);
    // Ordinary migrated files were removed as before.
    expect(existsSync(join(home, "memory", "_global", "x.md"))).toBe(false);
  });
});
