import { describe, expect, test } from "bun:test";
import { mkdtempSync, existsSync, statSync, readFileSync, writeFileSync, lstatSync, mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrapWinterDir, resolveWinterHome } from "../src/winter-dir";

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), "winter-home-"));
}

// P9b-7/P9b-12: this is the daemon's OWN home resolver — `WINTER_HOME` when set, `~/.winter`
// otherwise. It is what `resolveWinterHome()` from the SDK, given `CORE_BRAND`, must equal
// (pinned in `test/runtime-sdk/brand.test.ts`).
describe("resolveWinterHome", () => {
  test("WINTER_HOME wins when set", () => {
    const saved = process.env.WINTER_HOME;
    try {
      process.env.WINTER_HOME = "/tmp/some-winter-home";
      expect(resolveWinterHome()).toBe("/tmp/some-winter-home");
    } finally {
      if (saved === undefined) delete process.env.WINTER_HOME;
      else process.env.WINTER_HOME = saved;
    }
  });

  test("falls back to ~/.winter when unset", () => {
    const saved = process.env.WINTER_HOME;
    try {
      delete process.env.WINTER_HOME;
      expect(resolveWinterHome()).toBe(join(homedir(), ".winter"));
    } finally {
      if (saved === undefined) delete process.env.WINTER_HOME;
      else process.env.WINTER_HOME = saved;
    }
  });
});

describe("bootstrapWinterDir", () => {
  test("creates the full directory layout", () => {
    const home = tmpHome();
    const dirs = bootstrapWinterDir(home);
    for (const d of ["sessions", "memory", "logs", "run", "runtimes", "runtimes/backups", "runtimes/handoff-leases"]) {
      expect(existsSync(join(home, d))).toBe(true);
    }
    expect(dirs.runDir).toBe(join(home, "run"));
    expect(dirs.socketPath).toBe(join(home, "run", "core.sock"));
    expect(dirs.runtimesDir).toBe(join(home, "runtimes"));
    expect(dirs.runtimeStatePath).toBe(join(home, "runtimes", "runtime-state.db"));
  });

  // WS-21 (spec §8 bootstrap): a fresh home is never in the old layout. `sdk/` and claude's
  // persistent set are created; the old-layout entries are not.
  test("creates sdk/ (0700), its store and the persistent set; none of the old-layout entries", () => {
    const home = tmpHome();
    bootstrapWinterDir(home);
    expect(statSync(join(home, "sdk")).mode & 0o777).toBe(0o700);
    for (const d of ["sdk/projects", "sdk/file-history", "sdk/tasks", "sdk/teams", "sdk/agent-memory", "sdk/workflows"]) {
      expect(statSync(join(home, d)).isDirectory()).toBe(true);
    }
    for (const d of ["skills", "agents", "plugins", "hooks", "runtimes/official-agent-spool"]) {
      expect(existsSync(join(home, d))).toBe(false);
    }
  });

  // No compatibility link is planted: the agent SDK's store refuses a symlink at <store>/projects on
  // every append, so a link there would break every child still writing the old path.
  test("plants no link at the old top-level paths", () => {
    const home = tmpHome();
    bootstrapWinterDir(home);
    for (const d of ["projects", "backups", "skills", "agents", "workflows"]) expect(existsSync(join(home, d))).toBe(false);
  });

  test("an existing old-layout projects/ is left exactly as found (only Migration C moves data)", () => {
    const home = tmpHome();
    mkdirSync(join(home, "projects", "k"), { recursive: true });
    writeFileSync(join(home, "projects", "k", "s.jsonl"), "{}\n");
    bootstrapWinterDir(home);
    expect(lstatSync(join(home, "projects")).isDirectory()).toBe(true);
    expect(readFileSync(join(home, "projects", "k", "s.jsonl"), "utf8")).toBe("{}\n");
  });

  test("run dir is 0700", () => {
    const home = tmpHome();
    bootstrapWinterDir(home);
    expect(statSync(join(home, "run")).mode & 0o777).toBe(0o700);
  });

  test("writes default settings.json once, never overwrites", () => {
    const home = tmpHome();
    bootstrapWinterDir(home);
    const settingsPath = join(home, "settings.json");
    expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toHaveProperty("schemaVersion", 1);
    writeFileSync(settingsPath, JSON.stringify({ schemaVersion: 1, custom: true }));
    bootstrapWinterDir(home); // idempotent
    expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toHaveProperty("custom", true);
  });

  test("respects WINTER_HOME env override (no-arg call)", () => {
    const saved = process.env.WINTER_HOME;
    const home = mkdtempSync(join(tmpdir(), "winter-env-"));
    try {
      process.env.WINTER_HOME = home;
      const dirs = bootstrapWinterDir(); // no explicit arg
      expect(dirs.home).toBe(home);
    } finally {
      if (saved === undefined) delete process.env.WINTER_HOME;
      else process.env.WINTER_HOME = saved;
    }
  });

  test("settings.json is 0600", () => {
    const home = tmpHome();
    bootstrapWinterDir(home);
    expect(statSync(join(home, "settings.json")).mode & 0o777).toBe(0o600);
  });
});
