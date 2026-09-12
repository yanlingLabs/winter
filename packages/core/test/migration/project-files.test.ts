import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ProjectMigrationRefused,
  WINTER_INSTRUCTIONS_FILE,
  WINTER_PROJECT_DIR,
  planProjectMigration,
  runProjectMigration,
} from "../../src/migration/project-files";
import { LEGACY_INSTRUCTIONS_FILE, LEGACY_PROJECT_DIR, LEGACY_WINTER_EXECUTABLE_ENV } from "../../src/legacy-names";

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "winter-migrate-project-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function initGitRepo(dir: string): void {
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
}

describe("planProjectMigration / runProjectMigration — a plain (non-git) directory", () => {
  test("plans and runs an instructions-file + project-dir move, rekeying settings.json string values", () => {
    const dir = tempDir();
    writeFileSync(join(dir, LEGACY_INSTRUCTIONS_FILE), "# hello\nsome prose\n");
    mkdirSync(join(dir, LEGACY_PROJECT_DIR), { recursive: true });
    writeFileSync(join(dir, LEGACY_PROJECT_DIR, "settings.json"), JSON.stringify({ runtimes: { winterExecutable: `$${LEGACY_WINTER_EXECUTABLE_ENV}` } }));

    const plan = planProjectMigration(dir);
    expect(plan.gitTracked).toBe(false);
    expect(plan.steps).toHaveLength(2);
    expect(plan.steps.every((s) => s.method === "rename")).toBe(true);
    expect(plan.settingsChanges).toEqual([{ path: "runtimes.winterExecutable", from: `$${LEGACY_WINTER_EXECUTABLE_ENV}`, to: "$WINTER_RUNTIME_EXECUTABLE" }]);

    runProjectMigration(plan);

    expect(existsSync(join(dir, LEGACY_INSTRUCTIONS_FILE))).toBe(false);
    expect(existsSync(join(dir, WINTER_INSTRUCTIONS_FILE))).toBe(true);
    expect(readFileSync(join(dir, WINTER_INSTRUCTIONS_FILE), "utf8")).toBe("# hello\nsome prose\n"); // content untouched

    expect(existsSync(join(dir, LEGACY_PROJECT_DIR))).toBe(false);
    expect(existsSync(join(dir, WINTER_PROJECT_DIR))).toBe(true);
    const settings = JSON.parse(readFileSync(join(dir, WINTER_PROJECT_DIR, "settings.json"), "utf8"));
    expect(settings.runtimes.winterExecutable).toBe("$WINTER_RUNTIME_EXECUTABLE");
  });

  test("planProjectMigration refuses when both old and new instructions files exist, naming both", () => {
    const dir = tempDir();
    writeFileSync(join(dir, LEGACY_INSTRUCTIONS_FILE), "old");
    writeFileSync(join(dir, WINTER_INSTRUCTIONS_FILE), "new");
    let caught: unknown;
    try {
      planProjectMigration(dir);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ProjectMigrationRefused);
    expect((caught as ProjectMigrationRefused).code).toBe("both_exist");
    expect((caught as ProjectMigrationRefused).message).toContain(LEGACY_INSTRUCTIONS_FILE);
    expect((caught as ProjectMigrationRefused).message).toContain(WINTER_INSTRUCTIONS_FILE);
  });

  test("planProjectMigration refuses when both old and new project dirs exist, naming both", () => {
    const dir = tempDir();
    mkdirSync(join(dir, LEGACY_PROJECT_DIR));
    mkdirSync(join(dir, WINTER_PROJECT_DIR));
    let caught: unknown;
    try {
      planProjectMigration(dir);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ProjectMigrationRefused);
    expect((caught as ProjectMigrationRefused).code).toBe("both_exist");
    expect((caught as ProjectMigrationRefused).message).toContain(LEGACY_PROJECT_DIR);
    expect((caught as ProjectMigrationRefused).message).toContain(WINTER_PROJECT_DIR);
  });

  test("runProjectMigration refuses on an empty plan (nothing to migrate)", () => {
    const dir = tempDir();
    const plan = planProjectMigration(dir);
    expect(plan.steps).toHaveLength(0);
    let caught: unknown;
    try {
      runProjectMigration(plan);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ProjectMigrationRefused);
    expect((caught as ProjectMigrationRefused).code).toBe("nothing_to_migrate");
  });
});

describe("planProjectMigration / runProjectMigration — inside a git work tree with the paths tracked", () => {
  test("uses git mv, and the file survives as a tracked rename", () => {
    const dir = tempDir();
    initGitRepo(dir);
    writeFileSync(join(dir, LEGACY_INSTRUCTIONS_FILE), "# hello\n");
    execFileSync("git", ["add", LEGACY_INSTRUCTIONS_FILE], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "seed"], { cwd: dir });

    const plan = planProjectMigration(dir);
    expect(plan.gitTracked).toBe(true);
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]?.method).toBe("git-mv");

    runProjectMigration(plan);
    expect(existsSync(join(dir, WINTER_INSTRUCTIONS_FILE))).toBe(true);
    const status = execFileSync("git", ["status", "--porcelain"], { cwd: dir }).toString();
    expect(status).toContain("R  "); // a staged rename, not an add+delete pair
  });

  test("an untracked legacy file inside a work tree falls back to a plain rename, not git mv", () => {
    const dir = tempDir();
    initGitRepo(dir);
    writeFileSync(join(dir, LEGACY_INSTRUCTIONS_FILE), "# untracked\n");
    // Deliberately never `git add`ed.
    const plan = planProjectMigration(dir);
    expect(plan.gitTracked).toBe(true);
    expect(plan.steps[0]?.method).toBe("rename");
    runProjectMigration(plan);
    expect(existsSync(join(dir, WINTER_INSTRUCTIONS_FILE))).toBe(true);
  });
});
