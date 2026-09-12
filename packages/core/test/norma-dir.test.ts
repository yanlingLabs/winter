import { describe, expect, test } from "bun:test";
import { mkdtempSync, existsSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrapWinterDir } from "../src/winter-dir";

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), "winter-home-"));
}

describe("bootstrapWinterDir", () => {
  test("creates the full directory layout", () => {
    const home = tmpHome();
    const dirs = bootstrapWinterDir(home);
    for (const d of ["sessions", "memory", "skills/self", "agents", "plugins", "hooks", "logs", "run", "runtimes", "runtimes/backups", "runtimes/official-agent-spool", "runtimes/handoff-leases"]) {
      expect(existsSync(join(home, d))).toBe(true);
    }
    expect(dirs.runDir).toBe(join(home, "run"));
    expect(dirs.socketPath).toBe(join(home, "run", "core.sock"));
    expect(dirs.runtimesDir).toBe(join(home, "runtimes"));
    expect(dirs.runtimeStatePath).toBe(join(home, "runtimes", "runtime-state.db"));
    expect(statSync(join(home, "runtimes", "official-agent-spool")).mode & 0o777).toBe(0o700);
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
