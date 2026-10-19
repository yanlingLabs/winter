// Migration B and Cowork storage. docs/cowork-execution-contracts.md, "Host storage authority, fences and
// migration": Cowork storage and its canonical database move only through a coordinated quiescent
// migration; a plain copy would orphan volumes from their records, drop the WAL, and duplicate the home
// identity. This build has no coordinated migration, so every route REFUSES or SKIPS, and never writes.
// Each guard has its own test so removing it alone fails a test (mutation checked in the PR).
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { classifyLegacyEntry, MigrationRefused, planMigrationB, readMigrationManifest, resumeMigrationB, rollbackMigrationB, runMigrationB, type MigrationDeps, type MigrationPlan } from "../../src/migration/migrate-b";
import { inspectCoworkSource, isCoworkStorageRel, resolvesIntoCoworkStorage } from "../../src/migration/cowork-exclusion";
import { manifestPath, writeManifestAtomic, type MigrationFileEntry, type MigrationManifest } from "../../src/migration/manifest";
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

  test("OS litter alone under cowork/ (Finder, Spotlight, AppleDouble) is not Cowork storage, but any other entry still is", async () => {
    const source = tempDir(), home = tempDir();
    seedSource(source);
    for (const litter of [".DS_Store", ".localized", "._cowork-note"]) write(join(source, "cowork", litter), "x");
    expect(inspectCoworkSource(source)).toEqual({ present: false });
    const plan = await planMigrationB({ legacyHome: source, home, profile: "dev" });
    expect(plan.entries.some(entry => entry.status === "copied")).toBe(true);
    write(join(source, "cowork", "workspaces"), "a real entry");
    expect(inspectCoworkSource(source)).toMatchObject({ present: true, kind: "storage-tree" });
    expect((await refusalOf(() => planMigrationB({ legacyHome: source, home: tempDir(), profile: "dev" }))).code).toBe("cowork_storage_present");
  });

  test("a hidden entry that is not OS litter is still Cowork storage (the litter prefix is `._`, not `.`)", () => {
    for (const name of [".workspace", ".hidden", ".cowork-note", "_.DS_Store", ".DS_Store.bak", ".DS_Storex", ".localizedx"]) {
      const source = tempDir();
      write(join(source, "cowork", name), "x");
      expect({ name, found: inspectCoworkSource(source) }).toMatchObject({ name, found: { present: true, kind: "storage-tree" } });
    }
  });

  test("a zero-byte runtime-state file (no tables) is not Cowork storage; a file that is not a database still fails closed (corruption could hide records)", () => {
    const source = tempDir();
    write(join(source, "runtimes", "runtime-state.db"), "");
    expect(inspectCoworkSource(source)).toEqual({ present: false });
    write(join(source, "runtimes", "runtime-state.db"), "not sqlite");
    expect(inspectCoworkSource(source)).toMatchObject({ present: true, kind: "uninspectable" });
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

// ── Paths are judged by where they REALLY live ───────────────────────────────────────────────────────
// A lexical `cowork/` prefix check was bypassed by a symlinked parent (`innocent` -> `cowork/workspaces/ws`)
// and, on a case-insensitive volume, by `COWORK/...`. A `rebuilt` entry has no hash gate at all.
const IMAGE_BYTES = "guest volume bytes";
const sha = (text: string): string => createHash("sha256").update(text).digest("hex");
const entry = (dest: string, status: MigrationFileEntry["status"], content = IMAGE_BYTES): MigrationFileEntry =>
  ({ src: join(dest, "..", "src-unused"), dest, sha256: status === "rebuilt" ? "" : sha(content), bytes: content.length, status });
function manifestOf(home: string, entries: MigrationFileEntry[]): void {
  writeManifestAtomic(home, { schemaVersion: 1, startedAt: "t", legacyHome: join(home, "legacy-unused"), home, profile: "dev", status: "complete", entries, keychain: [] } satisfies MigrationManifest);
}
/** A destination that really holds an image under `cowork/`, reachable through an innocent-looking symlinked parent. */
function destinationWithImage() {
  const home = realpathSync(tempDir());
  const workspace = join(home, "cowork", "workspaces", WORKSPACE), image = join(workspace, "data.ext4");
  write(image, IMAGE_BYTES);
  symlinkSync(workspace, join(home, "innocent"));
  // `..` after the symlink: the kernel reads `innocent/../ws2` as `cowork/workspaces/ws2`, path.join as `<home>/ws2`.
  const sibling = join(home, "cowork", "workspaces", "ws2", "data.ext4");
  write(sibling, IMAGE_BYTES);
  mkdirSync(join(home, "sessions", "s1", "deep"), { recursive: true });
  symlinkSync(join(home, "sessions", "s1", "deep"), join(home, "escape"));
  symlinkSync(join(home, "sessions", "s1"), join(home, "linked"));
  return { home, image, sibling, viaLink: join(home, "innocent", "data.ext4"), dotdot: `${home}/innocent/../ws2/data.ext4` };
}

describe("resolvesIntoCoworkStorage", () => {
  test("follows symlinked parents, ignores case, handles paths that do not exist yet, and leaves ordinary paths alone", () => {
    const { home, image, viaLink } = destinationWithImage();
    expect(resolvesIntoCoworkStorage(home, image)).toBe(true);
    expect(resolvesIntoCoworkStorage(home, viaLink)).toBe(true);
    expect(resolvesIntoCoworkStorage(home, join(home, "innocent", "not-yet", "new.ext4"))).toBe(true); // deepest existing ancestor resolves into Cowork
    expect(resolvesIntoCoworkStorage(home, join(home, "COWORK", "workspaces", "w", "data.ext4"))).toBe(true); // spelling alone
    expect(resolvesIntoCoworkStorage(home, join(home, "Cowork"))).toBe(true);
    expect(resolvesIntoCoworkStorage("/home-that-does-not-exist", "/home-that-does-not-exist/cowork/x")).toBe(true);
    for (const rel of ["sessions/s1/a.jsonl", "coworker/x", "cowork.txt", "memory/cowork/notes.md", "sdk/cowork"]) expect(resolvesIntoCoworkStorage(home, join(home, rel))).toBe(false);
    // `..` after a symlinked parent is applied by the kernel to the symlink's TARGET (path.join would collapse it first).
    expect(resolvesIntoCoworkStorage(home, `${home}/innocent/../ws2/data.ext4`)).toBe(true); // innocent -> cowork/workspaces/ws_fixture, so ../ws2 is a Cowork sibling
    expect(resolvesIntoCoworkStorage(home, `${home}/escape/../../../cowork/workspaces/ws2/data.ext4`)).toBe(true); // escape -> sessions/s1/deep: three ups reach the home, then cowork/
    expect(resolvesIntoCoworkStorage(home, `${home}/innocent/../../../sessions/x`)).toBe(false); // ws_fixture -> workspaces -> cowork -> ... lands back at the home's sessions/
    expect(resolvesIntoCoworkStorage(home, `${home}/cowork/../sessions/x`)).toBe(false); // a plain real directory: the kernel and the lexical form agree
    expect(resolvesIntoCoworkStorage(home, `${home}/linked/../memory/x`)).toBe(false); // linked -> sessions/s1: lands in sessions/memory/x, not Cowork
    expect(resolvesIntoCoworkStorage(home, `${home}/sessions/./s1/../s1/a.jsonl`)).toBe(false);
    // a relative path with `..` starts from the working directory, like the kernel
    const cwd = process.cwd(); process.chdir(home);
    try {
      expect(resolvesIntoCoworkStorage(home, "innocent/../ws2/data.ext4")).toBe(true);
      expect(resolvesIntoCoworkStorage(home, "sessions/../coworker/x")).toBe(false);
    } finally { process.chdir(cwd); }
    expect(resolvesIntoCoworkStorage(home, join(tempDir(), "cowork", "x"))).toBe(false); // outside this home entirely
  });
});

describe("rollback keeps Cowork storage reached through a symlinked parent or another spelling", () => {
  for (const status of ["copied", "rebuilt"] as const) {
    test(`a ${status} entry whose destination goes through a symlinked parent is kept (rebuilt has no hash gate)`, async () => {
      const { home, image, viaLink } = destinationWithImage();
      manifestOf(home, [entry(viaLink, status)]);
      const logs: string[] = [];
      await rollbackMigrationB(home, { log: line => logs.push(line) });
      expect(readFileSync(image, "utf8")).toBe(IMAGE_BYTES);
      expect(logs.some(line => line.includes("Cowork storage is never removed"))).toBe(true);
    });
    test(`a ${status} entry spelled COWORK/ is kept`, async () => {
      const home = realpathSync(tempDir()), image = join(home, "COWORK", "workspaces", WORKSPACE, "data.ext4");
      write(image, IMAGE_BYTES); // the on-disk name is COWORK on any volume, so the lexical `cowork/` check cannot see it
      manifestOf(home, [entry(image, status)]);
      await rollbackMigrationB(home, { log: () => {} });
      expect(readFileSync(image, "utf8")).toBe(IMAGE_BYTES);
    });
    test(`a ${status} entry spelled COWORK/ over a directory stored as cowork/ is kept (case-insensitive volumes)`, async () => {
      const { home, image } = destinationWithImage();
      const alias = join(home, "COWORK", "workspaces", WORKSPACE, "data.ext4");
      if (!existsSync(alias)) return; // a case-sensitive volume has no such alias; the previous test covers the spelling
      manifestOf(home, [entry(alias, status)]);
      await rollbackMigrationB(home, { log: () => {} });
      expect(readFileSync(image, "utf8")).toBe(IMAGE_BYTES);
    });
  }
  // `..` after a symlinked parent: stat/unlink hand the raw path to the kernel, which applies `..` to the symlink's TARGET.
  for (const [label, make] of [
    ["copied with a recorded hash", (dest: string) => entry(dest, "copied")],
    ["copied with an empty sha256", (dest: string) => ({ ...entry(dest, "copied"), sha256: "" })],
    ["rebuilt", (dest: string) => entry(dest, "rebuilt")],
  ] as const) {
    test(`a ${label} entry written as <home>/innocent/../ws2/... is kept and the rollback carries on to later entries`, async () => {
      const { home, sibling, dotdot } = destinationWithImage();
      write(join(home, "sessions", "later.jsonl"), "later");
      manifestOf(home, [make(dotdot), entry(join(home, "sessions", "later.jsonl"), "copied", "later")]);
      const logs: string[] = [];
      await rollbackMigrationB(home, { log: line => logs.push(line) });
      expect(readFileSync(sibling, "utf8")).toBe(IMAGE_BYTES);
      expect(logs.some(line => line.includes(dotdot) && line.includes("kept") && line.includes("Cowork storage is never removed"))).toBe(true);
      expect(existsSync(join(home, "sessions", "later.jsonl"))).toBe(false); // not crashed partway: the next entry was processed
    });
  }
  test("a destination that climbs out of a symlinked directory back into Cowork is kept too", async () => {
    const { home, sibling } = destinationWithImage();
    const via = `${home}/escape/../../../cowork/workspaces/ws2/data.ext4`;
    manifestOf(home, [{ ...entry(via, "rebuilt") }]);
    await rollbackMigrationB(home, { log: () => {} });
    expect(readFileSync(sibling, "utf8")).toBe(IMAGE_BYTES);
  });
  test("a destination with `..` that really stays outside Cowork (cowork/../sessions, linked/../memory) is still removed", async () => {
    const { home } = destinationWithImage();
    write(join(home, "sessions", "x"), "plain"); write(join(home, "sessions", "memory", "x"), "via link");
    // (`rebuilt` for the symlinked one: a recorded hash would be read through a stream that normalizes `..` lexically, a
    // pre-existing quirk of hand-edited manifests that is not what this test is about.)
    manifestOf(home, [entry(`${home}/cowork/../sessions/x`, "copied", "plain"), entry(`${home}/linked/../memory/x`, "rebuilt")]);
    await rollbackMigrationB(home, { log: () => {} });
    expect(existsSync(join(home, "sessions", "x"))).toBe(false);
    expect(existsSync(join(home, "sessions", "memory", "x"))).toBe(false);
  });
  test("ordinary migrated files — including lookalikes and a symlinked parent that is not Cowork — are still removed", async () => {
    const home = realpathSync(tempDir());
    write(join(home, "sessions", "s1", "a.jsonl"), "session"); write(join(home, "coworker", "x"), "lookalike"); write(join(home, "memory", "cowork", "notes.md"), "notes");
    symlinkSync(join(home, "sessions", "s1"), join(home, "linked"));
    write(join(home, "sessions", "s1", "b.jsonl"), "via link");
    manifestOf(home, [entry(join(home, "sessions", "s1", "a.jsonl"), "copied", "session"), entry(join(home, "coworker", "x"), "copied", "lookalike"),
      entry(join(home, "memory", "cowork", "notes.md"), "copied", "notes"), entry(join(home, "linked", "b.jsonl"), "copied", "via link")]);
    await rollbackMigrationB(home, { log: () => {} });
    for (const rel of ["sessions/s1/a.jsonl", "coworker/x", "memory/cowork/notes.md", "sessions/s1/b.jsonl"]) expect(existsSync(join(home, rel))).toBe(false);
  });
});

describe("the executor refuses plans that reach Cowork storage through a symlink or another spelling", () => {
  for (const status of ["copied", "rekeyed", "rebuilt"] as const) {
    test(`a ${status} destination through a symlinked parent of the destination home is refused before anything is written`, async () => {
      const source = tempDir(); seedSource(source);
      const { home, image, viaLink } = destinationWithImage();
      const before = snapshot(home);
      const plan = await planMigrationB({ legacyHome: source, home: tempDir(), profile: "dev" });
      plan.home = home; plan.entries = [{ src: join(source, "settings.json"), dest: viaLink, status }];
      expect((await refusalOf(() => runMigrationB(plan, deps()))).code).toBe("cowork_storage_present");
      expect(readFileSync(image, "utf8")).toBe(IMAGE_BYTES);
      expect(snapshot(home)).toEqual(before);
    });
    test(`a ${status} source through a symlinked parent of the legacy home is refused`, async () => {
      const home = tempDir(), legacy = realpathSync(tempDir()); seedSource(legacy);
      const plan = await planMigrationB({ legacyHome: legacy, home, profile: "dev" });
      // `cowork` arrives later in the source (a hand-built plan, or storage created after planning)
      const workspace = join(legacy, "cowork", "workspaces", WORKSPACE); write(join(workspace, "data.ext4"), IMAGE_BYTES);
      symlinkSync(workspace, join(legacy, "innocent"));
      plan.entries = [{ src: join(legacy, "innocent", "data.ext4"), dest: join(home, "x.ext4"), status }];
      expect((await refusalOf(() => runMigrationB(plan, deps()))).code).toBe("cowork_storage_present");
      expect(existsSync(join(home, "x.ext4"))).toBe(false);
    });
    test(`a ${status} destination written as innocent/../ws2/... (the kernel's reading) is refused`, async () => {
      const source = tempDir(); seedSource(source);
      const { home, sibling, dotdot } = destinationWithImage();
      const before = snapshot(home);
      const plan = await planMigrationB({ legacyHome: source, home: tempDir(), profile: "dev" });
      plan.home = home; plan.entries = [{ src: join(source, "settings.json"), dest: dotdot, status }];
      expect((await refusalOf(() => runMigrationB(plan, deps()))).code).toBe("cowork_storage_present");
      expect(readFileSync(sibling, "utf8")).toBe(IMAGE_BYTES);
      expect(snapshot(home)).toEqual(before);
    });
    test(`a ${status} destination spelled COWORK/ is refused`, async () => {
      const source = tempDir(), home = realpathSync(tempDir()); seedSource(source);
      const plan = await planMigrationB({ legacyHome: source, home, profile: "dev" });
      plan.entries = [{ src: join(source, "settings.json"), dest: join(home, "COWORK", "workspaces", WORKSPACE, "data.ext4"), status }];
      expect((await refusalOf(() => runMigrationB(plan, deps()))).code).toBe("cowork_storage_present");
      expect(readdirSync(home)).toEqual([]);
    });
  }
  test("ordinary entries, lookalike names included, still migrate", async () => {
    const source = tempDir(), home = tempDir(); seedSource(source); write(join(source, "coworker", "x"), "lookalike"); write(join(source, "memory", "cowork", "notes.md"), "notes");
    const manifest = await runMigrationB(await planMigrationB({ legacyHome: source, home, profile: "dev" }), deps());
    expect(manifest.status).toBe("complete");
    for (const rel of ["coworker/x", "memory/cowork/notes.md", "sessions/s1/a.jsonl"]) expect(readFileSync(join(home, rel), "utf8").length).toBeGreaterThan(0);
  });
});

describe("inspection cleanup", () => {
  test("a temp-copy cleanup failure never turns the finding into a throw (the boot hook calls this)", () => {
    const left: string[] = [], failing = { removeScratch: (path: string) => { left.push(path); throw new Error("EBUSY"); } };
    try {
      const populated = tempDir(); seedSource(populated); seedRuntimeState(populated, true, true);
      expect(inspectCoworkSource(populated, failing)).toMatchObject({ present: true, kind: "authority-records" });
      const clean = tempDir(); seedSource(clean); seedRuntimeState(clean, false, true);
      expect(inspectCoworkSource(clean, failing)).toEqual({ present: false });
      expect(left).toHaveLength(2); // each inspection really did try to clean up
    } finally { for (const path of left) rmSync(path, { recursive: true, force: true }); }
  });
  test("by default the private copy is removed (a private TMPDIR is left empty)", () => {
    const source = tempDir(), scratchRoot = realpathSync(tempDir()); seedSource(source); seedRuntimeState(source, true, true);
    const previous = process.env.TMPDIR; process.env.TMPDIR = scratchRoot;
    try { expect(inspectCoworkSource(source)).toMatchObject({ present: true, kind: "authority-records" }); }
    finally { if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous; }
    expect(readdirSync(scratchRoot)).toEqual([]);
  });
});

describe("an unreadable legacy entry is not reported as Cowork storage", () => {
  test("the refusal says it could not be checked, and still refuses", async () => {
    const source = tempDir(), home = tempDir(); seedSource(source); write(join(source, "runtimes", "runtime-state.db"), "not a sqlite database");
    const refusal = await refusalOf(() => planMigrationB({ legacyHome: source, home, profile: "dev" }));
    expect(refusal.code).toBe("cowork_storage_present");
    expect(refusal.message).toContain("could not be checked for Cowork storage");
    expect(refusal.message).not.toContain("holds Cowork storage");
  });
  test("a real Cowork tree still reads as holding Cowork storage", async () => {
    const source = tempDir(), home = tempDir(); seedSource(source); seedCoworkTree(source);
    const refusal = await refusalOf(() => planMigrationB({ legacyHome: source, home, profile: "dev" }));
    expect(refusal.message).toContain("holds Cowork storage");
  });
});
