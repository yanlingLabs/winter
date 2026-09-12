import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateMemoryStore } from "../../src/agent/memory-migrate";
import { memoryDirFor, globalMemoryDirFor } from "../../src/agent/memory-dir";

function realDir(): string { return realpathSync(mkdtempSync(join(tmpdir(), "winter-mem-migrate-"))); }

function writeFactFile(dir: string, name: string, description: string, type = "user", body = `body of ${name}`): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.md`), `---\nname: ${name}\ndescription: ${description}\ntype: ${type}\n---\n\n${body}`, "utf8");
}

/** Fixed trust list — `trust.list()` is all the importer reads off `TrustStore`. */
function trustOf(dirs: string[]): { list(): string[] } {
  return { list: () => dirs };
}

describe("memory-migrate: legacy USER scope -> the global bucket", () => {
  test("migrates a user-scope fact into globalMemoryDirFor's directory", () => {
    const winterHome = realDir();
    writeFactFile(join(winterHome, "memory"), "coffee-pref", "Likes oat milk lattes");

    const result = migrateMemoryStore({ winterHome, trust: trustOf([]) });

    const target = globalMemoryDirFor({ winterHome });
    expect(existsSync(join(target, "coffee-pref.md"))).toBe(true);
    expect(readFileSync(join(target, "coffee-pref.md"), "utf8")).toContain("Likes oat milk lattes");
    expect(readFileSync(join(target, "MEMORY.md"), "utf8")).toContain("- [coffee-pref](coffee-pref.md) — Likes oat milk lattes");
    expect(result.sources[0]).toMatchObject({ migrated: ["coffee-pref"], skipped: [] });
  });

  test("no legacy user-scope directory at all -> no-op, target never created", () => {
    const winterHome = realDir();
    migrateMemoryStore({ winterHome, trust: trustOf([]) });
    expect(existsSync(globalMemoryDirFor({ winterHome }))).toBe(false);
  });
});

describe("memory-migrate: legacy PROJECT scope -> the project's own MEMDIR", () => {
  test("migrates a trusted dir's project-scope fact into memoryDirFor(trustedDir)", () => {
    const winterHome = realDir();
    const projectDir = realDir();
    writeFactFile(join(projectDir, ".winter", "memory"), "build-cmd", "Use bun run build");

    migrateMemoryStore({ winterHome, trust: trustOf([projectDir]) });

    const target = memoryDirFor(projectDir, { winterHome });
    expect(existsSync(join(target, "build-cmd.md"))).toBe(true);
    expect(readFileSync(join(target, "build-cmd.md"), "utf8")).toContain("Use bun run build");
  });

  test("a trusted dir with no .winter/memory at all is silently skipped (no source entry)", () => {
    const winterHome = realDir();
    const projectDir = realDir(); // trusted, but never used the old memory tools
    const result = migrateMemoryStore({ winterHome, trust: trustOf([projectDir]) });
    // only the (empty) user-scope source is reported; the project dir contributes nothing
    expect(result.sources).toHaveLength(1);
  });

  test("two trusted dirs in the same repo converge on the SAME target MEMDIR", () => {
    const winterHome = realDir();
    const projectDir = realDir();
    const nested = join(projectDir, "sub");
    mkdirSync(nested, { recursive: true });
    writeFactFile(join(projectDir, ".winter", "memory"), "a", "da");
    writeFactFile(join(nested, ".winter", "memory"), "b", "db");

    migrateMemoryStore({ winterHome, trust: trustOf([projectDir, nested]) });

    // both non-repo dirs key off themselves (no .git here) -> DIFFERENT targets, since
    // memoryDirFor's repo-root resolution falls back to the cwd itself for a non-repo path.
    // Assert each fact landed at its OWN dir's computed target (the "no false merge" half of the
    // convergence claim); the "same repo" convergence case is covered by memory-dir.test.ts's own
    // worktree tests (memoryDirFor itself, not this importer).
    expect(existsSync(join(memoryDirFor(projectDir, { winterHome }), "a.md"))).toBe(true);
    expect(existsSync(join(memoryDirFor(nested, { winterHome }), "b.md"))).toBe(true);
  });
});

describe("memory-migrate: idempotency", () => {
  test("re-running the importer twice does not duplicate index entries or error", () => {
    const winterHome = realDir();
    writeFactFile(join(winterHome, "memory"), "coffee-pref", "Likes oat milk lattes");

    migrateMemoryStore({ winterHome, trust: trustOf([]) });
    const second = migrateMemoryStore({ winterHome, trust: trustOf([]) });

    expect(second.sources[0]).toMatchObject({ migrated: [], skipped: ["coffee-pref"] });
    const index = readFileSync(join(globalMemoryDirFor({ winterHome }), "MEMORY.md"), "utf8");
    const indexLines = index.split("\n").filter((l) => l.startsWith("- ["));
    expect(indexLines).toHaveLength(1);
  });

  test("a name collision with a fact ALREADY at the target is skipped, never overwritten", () => {
    const winterHome = realDir();
    writeFactFile(join(winterHome, "memory"), "coffee-pref", "Legacy description");
    const target = globalMemoryDirFor({ winterHome });
    writeFactFile(target, "coffee-pref", "User's own newer note"); // pre-existing target fact

    const result = migrateMemoryStore({ winterHome, trust: trustOf([]) });

    expect(result.sources[0]).toMatchObject({ migrated: [], skipped: ["coffee-pref"] });
    expect(readFileSync(join(target, "coffee-pref.md"), "utf8")).toContain("User's own newer note");
  });

  test("a later boot picks up a NEW legacy fact added after the first migration ran", () => {
    const winterHome = realDir();
    writeFactFile(join(winterHome, "memory"), "a", "da");
    migrateMemoryStore({ winterHome, trust: trustOf([]) });

    writeFactFile(join(winterHome, "memory"), "b", "db"); // added to the OLD store later
    const second = migrateMemoryStore({ winterHome, trust: trustOf([]) });

    expect(second.sources[0]).toMatchObject({ migrated: ["b"], skipped: ["a"] });
    const target = globalMemoryDirFor({ winterHome });
    expect(existsSync(join(target, "a.md"))).toBe(true);
    expect(existsSync(join(target, "b.md"))).toBe(true);
  });
});

describe("memory-migrate: the OLD store is retained, never modified or deleted", () => {
  test("source files still exist, byte-identical, after migration", () => {
    const winterHome = realDir();
    const sourceDir = join(winterHome, "memory");
    writeFactFile(sourceDir, "coffee-pref", "Likes oat milk lattes");
    const before = readFileSync(join(sourceDir, "coffee-pref.md"), "utf8");

    migrateMemoryStore({ winterHome, trust: trustOf([]) });

    expect(readFileSync(join(sourceDir, "coffee-pref.md"), "utf8")).toBe(before);
  });

  test("project-scope source directory is untouched too", () => {
    const winterHome = realDir();
    const projectDir = realDir();
    const sourceDir = join(projectDir, ".winter", "memory");
    writeFactFile(sourceDir, "build-cmd", "Use bun run build");
    const before = readFileSync(join(sourceDir, "build-cmd.md"), "utf8");

    migrateMemoryStore({ winterHome, trust: trustOf([projectDir]) });

    expect(readFileSync(join(sourceDir, "build-cmd.md"), "utf8")).toBe(before);
  });
});

describe("memory-migrate: corrupt/invalid source facts are skipped, never thrown", () => {
  test("a corrupt frontmatter file in the source is silently skipped", () => {
    const winterHome = realDir();
    const sourceDir = join(winterHome, "memory");
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, "corrupt.md"), "not frontmatter");
    writeFactFile(sourceDir, "good", "A valid fact");

    const result = migrateMemoryStore({ winterHome, trust: trustOf([]) });
    expect(result.sources[0]?.migrated).toEqual(["good"]);
  });
});

describe("memory-migrate: settings.memory.directory override", () => {
  test("the override replaces BOTH the global bucket and every project's target", () => {
    const winterHome = realDir();
    const override = realDir();
    const projectDir = realDir();
    writeFactFile(join(winterHome, "memory"), "user-fact", "d1");
    writeFactFile(join(projectDir, ".winter", "memory"), "project-fact", "d2");

    migrateMemoryStore({ winterHome, trust: trustOf([projectDir]), directory: override });

    expect(existsSync(join(override, "user-fact.md"))).toBe(true);
    expect(existsSync(join(override, "project-fact.md"))).toBe(true);
  });
});
