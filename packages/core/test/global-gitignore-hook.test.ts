import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addLocalDir } from "../src/settings";
import { PermissionRules } from "../src/agent/permission-rules";

const tmp = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), p)));

// Save/restore rather than delete: the repo-wide preload (test/preload.ts) points
// XDG_CONFIG_HOME at a hermetic temp dir for the whole bun test process. A bare
// `delete` here would strip that guard for every test file that runs after this one
// in the same process, letting a later test's ensureGlobalGitignore() call fall
// through to the real ~/.config/git/ignore.
const prevXdg = process.env.XDG_CONFIG_HOME;
afterEach(() => {
  if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = prevXdg;
});

describe("global-gitignore hook", () => {
  test("addLocalDir adds the personal patterns to the global excludes", () => {
    const xdg = tmp("xdg-");
    process.env.XDG_CONFIG_HOME = xdg;
    addLocalDir(tmp("proj-"), "/some/dir");
    const gi = readFileSync(join(xdg, "git", "ignore"), "utf8");
    expect(gi).toContain("**/.norma/settings.local.json");
    expect(gi).toContain("**/.norma/permissions.local.json");
  });

  test("PermissionRules.append(project) adds the personal patterns", () => {
    const xdg = tmp("xdg2-");
    process.env.XDG_CONFIG_HOME = xdg;
    const pr = new PermissionRules({ globalAllow: () => [], normaHome: tmp("home-") });
    pr.append("Bash(ls:*)", "project", tmp("proj2-"));
    expect(readFileSync(join(xdg, "git", "ignore"), "utf8")).toContain("**/.norma/permissions.local.json");
  });
});
