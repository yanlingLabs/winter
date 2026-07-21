import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureGlobalGitignore } from "../src/global-gitignore";

const tmp = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), p)));
const PATTERNS = ["**/.norma/settings.local.json", "**/.norma/permissions.local.json", "**/.norma/worktrees/"];

describe("ensureGlobalGitignore", () => {
  test("creates the file (and parent) with the patterns when absent", () => {
    const path = join(tmp("gi-"), "config", "git", "ignore");
    ensureGlobalGitignore(PATTERNS, { path });
    expect(readFileSync(path, "utf8").split("\n").filter(Boolean).sort()).toEqual([...PATTERNS].sort());
  });
  test("appends only MISSING patterns, preserving existing content", () => {
    const dir = tmp("gi2-"); const path = join(dir, "ignore");
    writeFileSync(path, "node_modules\n**/.norma/worktrees/\n");
    ensureGlobalGitignore(PATTERNS, { path });
    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    expect(lines).toContain("node_modules");
    expect(lines.filter((l) => l === "**/.norma/worktrees/").length).toBe(1); // not duplicated
    expect(lines).toContain("**/.norma/settings.local.json");
  });
  test("idempotent — second call is a no-op", () => {
    const path = join(tmp("gi3-"), "ignore");
    ensureGlobalGitignore(PATTERNS, { path });
    const first = readFileSync(path, "utf8");
    ensureGlobalGitignore(PATTERNS, { path });
    expect(readFileSync(path, "utf8")).toBe(first);
  });
});
