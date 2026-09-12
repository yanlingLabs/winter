import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LEGACY_INSTRUCTIONS_FILE, WINTER_INSTRUCTIONS_FILE } from "@yanlinglabs/winter-core";
import { runMigrateProjectCommand, type MigrateProjectCommandDeps } from "../src/commands/migrate-project";

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "winter-cli-migrate-project-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function baseDeps(overrides: Partial<MigrateProjectCommandDeps> = {}): { deps: MigrateProjectCommandDeps; lines: string[]; errLines: string[] } {
  const lines: string[] = [];
  const errLines: string[] = [];
  const deps: MigrateProjectCommandDeps = {
    argv: [],
    cwd: tempDir(),
    log: (l) => lines.push(l),
    error: (l) => errLines.push(l),
    confirm: async () => true,
    ...overrides,
  };
  return { deps, lines, errLines };
}

describe("winter migrate-project", () => {
  test("nothing to migrate: reports and exits 0", async () => {
    const { deps, lines } = baseDeps();
    const code = await runMigrateProjectCommand(deps);
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("nothing to migrate");
  });

  test("prints the plan, then applies it with --yes", async () => {
    const { deps, lines } = baseDeps({ argv: ["--yes"] });
    writeFileSync(join(deps.cwd, LEGACY_INSTRUCTIONS_FILE), "# hi\n");
    const code = await runMigrateProjectCommand(deps);
    expect(code).toBe(0);
    expect(existsSync(join(deps.cwd, WINTER_INSTRUCTIONS_FILE))).toBe(true);
    const joined = lines.join("\n");
    expect(joined).toContain("plan for");
    expect(joined).toContain("->");
    expect(joined).toContain("done");
  });

  test("without --yes, asks for confirmation and aborts on 'no'", async () => {
    let asked = false;
    const { deps } = baseDeps({ confirm: async () => { asked = true; return false; } });
    writeFileSync(join(deps.cwd, LEGACY_INSTRUCTIONS_FILE), "# hi\n");
    const code = await runMigrateProjectCommand(deps);
    expect(code).toBe(1);
    expect(asked).toBe(true);
    expect(existsSync(join(deps.cwd, LEGACY_INSTRUCTIONS_FILE))).toBe(true); // untouched
  });

  test("refuses when both the legacy and Winter instructions files exist, naming both, and never touches either file", async () => {
    const { deps, errLines } = baseDeps({ argv: ["--yes"] });
    writeFileSync(join(deps.cwd, LEGACY_INSTRUCTIONS_FILE), "old");
    writeFileSync(join(deps.cwd, WINTER_INSTRUCTIONS_FILE), "new");
    const code = await runMigrateProjectCommand(deps);
    expect(code).toBe(1);
    const joined = errLines.join("\n");
    expect(joined).toContain(LEGACY_INSTRUCTIONS_FILE);
    expect(joined).toContain(WINTER_INSTRUCTIONS_FILE);
    expect(existsSync(join(deps.cwd, LEGACY_INSTRUCTIONS_FILE))).toBe(true);
    expect(existsSync(join(deps.cwd, WINTER_INSTRUCTIONS_FILE))).toBe(true);
  });

  test("accepts an explicit target directory as the first positional argument", async () => {
    const outer = tempDir();
    const target = join(outer, "sub");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, LEGACY_INSTRUCTIONS_FILE), "# hi\n");
    const { deps } = baseDeps({ argv: [target, "--yes"], cwd: outer });
    const code = await runMigrateProjectCommand(deps);
    expect(code).toBe(0);
    expect(existsSync(join(target, WINTER_INSTRUCTIONS_FILE))).toBe(true);
  });
});
