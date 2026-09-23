// Review I2 (2026-09-23) / WS-21 L3.5: the daemon's own record of "Allow … in this project" answers,
// `<home>/permissions/projects.json`, is RETIRED as a store — nothing writes it any more (a card's answer
// goes to the trusted project's `.winter/settings.local.json`, see `test/ipc/approval-save.test.ts`). What
// an older build recorded is still READ (the saved-rules reader on a build whose router does not apply run
// homes, `winter doctor`, `winter migrate-project`), so the reader keeps every safety property it had:
// canonical roots, and never through a link (re-review R1).
import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApprovedProjectRules } from "../../src/agent/approved-project-rules";
import { repoRootFor } from "../../src/agent/memory-dir";
import { FileSecretStore } from "../../src/auth/secret-store";
import { startDaemon } from "../../src/daemon";
import { persistedAllowRulesFor } from "../../src/runtime-sdk/mode-options";

function realDir(prefix: string): string { return realpathSync(mkdtempSync(join(tmpdir(), prefix))); }

/** What an older build left behind: the daemon's own 0700 directory and its record. */
function seed(home: string, projects: Record<string, string[]>): void {
  mkdirSync(join(home, "permissions"), { recursive: true, mode: 0o700 });
  writeFileSync(join(home, "permissions", "projects.json"), JSON.stringify({ version: 1, projects }), { mode: 0o600 });
}

describe("ApprovedProjectRules — a read-only reader of an older build's record", () => {
  test("reads per CANONICAL root (a symlinked spelling is the same project)", () => {
    const home = realDir("winter-approved-home-");
    const repo = realDir("winter-approved-repo-");
    const alias = join(realDir("winter-approved-alias-"), "link");
    symlinkSync(repo, alias);
    seed(home, { [repo]: ["Bash(npm test)", "Bash(make:*)"] });
    const store = new ApprovedProjectRules({ winterHome: home });
    expect(store.rulesFor(repo)).toEqual(["Bash(npm test)", "Bash(make:*)"]);
    expect(store.rulesFor(alias)).toEqual(["Bash(npm test)", "Bash(make:*)"]);
    expect(store.file()).toBe(join(home, "permissions", "projects.json"));
  });

  test("it has no writer any more", () => {
    const store = new ApprovedProjectRules({ winterHome: realDir("winter-approved-nowrite-") }) as unknown as Record<string, unknown>;
    expect(store["record"]).toBeUndefined();
    expect(store["prepare"]).toBeUndefined();
  });

  test("a missing or malformed record reads as nothing, and is left exactly as found", () => {
    const home = realDir("winter-approved-bad-");
    expect(new ApprovedProjectRules({ winterHome: home }).rulesFor("/anything")).toEqual([]);
    mkdirSync(join(home, "permissions"), { recursive: true });
    writeFileSync(join(home, "permissions", "projects.json"), "{ not json");
    expect(new ApprovedProjectRules({ winterHome: home }).rulesFor("/anything")).toEqual([]);
    expect(readFileSync(join(home, "permissions", "projects.json"), "utf8")).toBe("{ not json");
  });
});

// Re-review R1 (2026-09-23): the record is applied WITHOUT a trust check, so it must be the daemon's own
// file. A `<home>/permissions` that is a link, or a `projects.json` that is a link, reads as nothing.
describe("ApprovedProjectRules — never through a link (re-review R1)", () => {
  function plantedStore(repo: string, rules: string[]): string {
    const elsewhere = realDir("winter-approved-planted-");
    writeFileSync(join(elsewhere, "projects.json"), JSON.stringify({ version: 1, projects: { [repo]: rules } }));
    return elsewhere;
  }

  test("a symlinked STORE directory reads as nothing, logs once", () => {
    const home = realDir("winter-approved-r1-home-");
    const repo = realDir("winter-approved-r1-repo-");
    symlinkSync(plantedStore(repo, ["Bash"]), join(home, "permissions"));
    const logs: string[] = [];
    const store = new ApprovedProjectRules({ winterHome: home, log: (m) => logs.push(m) });
    expect(store.rulesFor(repo)).toEqual([]);
    const saved = persistedAllowRulesFor(repo, {
      projectRootOf: (c) => c, effectiveSettings: () => null,
      approvedProjectRules: (root) => store.rulesFor(root), isTrusted: () => false,
    });
    expect(saved).toEqual([]);
    expect(logs).toHaveLength(1); // one line for the condition, not one per read
    expect(logs[0]).toContain(join(home, "permissions"));
  });

  test("a symlinked projects.json inside the real store directory is refused the same way, and left for the user", () => {
    const home = realDir("winter-approved-r1-file-");
    const repo = realDir("winter-approved-r1-file-repo-");
    const elsewhere = plantedStore(repo, ["Bash"]);
    mkdirSync(join(home, "permissions"), { mode: 0o700 });
    symlinkSync(join(elsewhere, "projects.json"), join(home, "permissions", "projects.json"));
    const logs: string[] = [];
    const store = new ApprovedProjectRules({ winterHome: home, log: (m) => logs.push(m) });
    expect(store.rulesFor(repo)).toEqual([]);
    expect(logs).toHaveLength(1);
    expect(lstatSync(join(home, "permissions", "projects.json")).isSymbolicLink()).toBe(true);
  });

  // Re-review M-b: the root those rules are looked up by is `repoRootFor(cwd)`, and a `.git` FILE
  // pointing at another project's git dir used to make THAT project the root.
  test("M-b: a directory whose .git file points at another project's git dir does not inherit its approvals", () => {
    const home = realDir("winter-approved-mb-home-");
    const other = realDir("winter-approved-mb-other-");
    expect(Bun.spawnSync(["git", "-C", other, "init", "-q"]).exitCode).toBe(0);
    const evil = realDir("winter-approved-mb-evil-");
    writeFileSync(join(evil, ".git"), `gitdir: ${join(other, ".git")}\n`);
    seed(home, { [other]: ["Bash"] });
    const store = new ApprovedProjectRules({ winterHome: home, log: () => {} });
    const savedRulesFor = (cwd: string) => persistedAllowRulesFor(cwd, {
      projectRootOf: (c) => repoRootFor(c), effectiveSettings: () => null,
      approvedProjectRules: (root) => store.rulesFor(root), isTrusted: () => false,
    });
    expect(savedRulesFor(other)).toEqual(["Bash"]);
    expect(savedRulesFor(evil)).toEqual([]);
  });

  test("WS-21: the daemon no longer creates <home>/permissions at boot (Migration C archives it)", async () => {
    const home = realDir("winter-approved-r1-boot-");
    const daemon = await startDaemon({ home, secrets: new FileSecretStore(join(home, "test-secrets")), agentProvider: null });
    try {
      expect(existsSync(join(home, "permissions"))).toBe(false);
    } finally {
      await daemon.stop();
    }
  });
});
