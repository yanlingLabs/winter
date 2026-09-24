import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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

// WS-21 L3.7 (spec §8, "repos are never touched automatically"): `winter migrate-project` gains two
// steps — the repo-root `.mcp.json` → `.winter/mcp.json`, and the daemon's old approved-rules record (plus
// a legacy `.winter/permissions.local.json`) → `.winter/settings.local.json` in claude's grammar. The
// saved-answer door then touches the global git excludes file, so HOME, XDG_CONFIG_HOME and
// GIT_CONFIG_GLOBAL are temp paths for every test here.
describe("winter migrate-project — the WS-21 steps", () => {
  const saved: Record<string, string | undefined> = {};
  const env = ["HOME", "XDG_CONFIG_HOME", "GIT_CONFIG_GLOBAL"] as const;
  beforeEach(() => {
    const fake = tempDir();
    for (const k of env) saved[k] = process.env[k];
    process.env.HOME = fake;
    process.env.XDG_CONFIG_HOME = join(fake, ".config");
    process.env.GIT_CONFIG_GLOBAL = join(fake, ".gitconfig");
    writeFileSync(process.env.GIT_CONFIG_GLOBAL, "[user]\n\tname = t\n\temail = t@example.invalid\n");
  });
  afterEach(() => {
    for (const k of env) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  });

  function repo(): string {
    const dir = realpathSync(tempDir());
    Bun.spawnSync(["git", "-C", dir, "init", "-q"]);
    return dir;
  }

  test(".mcp.json moves to .winter/mcp.json, content unchanged", async () => {
    const dir = repo();
    const body = JSON.stringify({ mcpServers: { team: { command: "node" } } });
    writeFileSync(join(dir, ".mcp.json"), body);
    const { deps, lines } = baseDeps({ argv: [dir, "--yes"] });
    expect(await runMigrateProjectCommand(deps)).toBe(0);
    expect(existsSync(join(dir, ".mcp.json"))).toBe(false);
    expect(readFileSync(join(dir, ".winter", "mcp.json"), "utf8")).toBe(body);
    expect(lines.join("\n")).toContain(".winter/mcp.json");
  });

  test(".mcp.json beside an existing .winter/mcp.json refuses (the operator's call)", async () => {
    const dir = repo();
    writeFileSync(join(dir, ".mcp.json"), "{}");
    mkdirSync(join(dir, ".winter"), { recursive: true });
    writeFileSync(join(dir, ".winter", "mcp.json"), "{}");
    const { deps, errLines } = baseDeps({ argv: [dir, "--yes"] });
    expect(await runMigrateProjectCommand(deps)).toBe(1);
    expect(errLines.join("\n")).toContain("resolve manually");
  });

  test("the approved-rules record and a legacy permissions.local.json land in .winter/settings.local.json, translated", async () => {
    const dir = repo();
    const home = realpathSync(tempDir());
    mkdirSync(join(home, "permissions"), { recursive: true });
    writeFileSync(join(home, "permissions", "projects.json"), JSON.stringify({ version: 1, projects: { [dir]: ["Bash(make:*)", "Bash(rm *)"] } }));
    mkdirSync(join(dir, ".winter"), { recursive: true });
    writeFileSync(join(dir, ".winter", "permissions.local.json"), JSON.stringify({ allow: ["Edit"] }));
    const { deps, lines } = baseDeps({ argv: [dir, "--yes"], home });
    expect(await runMigrateProjectCommand(deps)).toBe(0);
    const local = JSON.parse(readFileSync(join(dir, ".winter", "settings.local.json"), "utf8"));
    expect(local.permissions.allow).toEqual(["Bash(make:*)", "Edit", "Write"]); // `Bash(rm *)` is never widened into a glob
    expect(lines.join("\n")).toContain("saved rule(s)");
    // the global excludes file (in the temp HOME) now keeps the file out of git
    expect(readFileSync(join(process.env.XDG_CONFIG_HOME!, "git", "ignore"), "utf8")).toContain("**/.winter/settings.local.json");
  });

  test("the approved-rules record Migration C archived is still found", async () => {
    const dir = repo();
    const home = realpathSync(tempDir());
    const archived = join(home, "migration", "c-2026-09-23T00-00-00-000Z", "archive", "permissions");
    mkdirSync(archived, { recursive: true });
    writeFileSync(join(archived, "projects.json"), JSON.stringify({ version: 1, projects: { [dir]: ["Bash(npm test)"] } }));
    const { deps } = baseDeps({ argv: [dir, "--yes"], home });
    expect(await runMigrateProjectCommand(deps)).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, ".winter", "settings.local.json"), "utf8")).permissions.allow).toEqual(["Bash(npm test)"]);
  });
});
