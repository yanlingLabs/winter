// Every test process gets its own temp root and nothing it makes outlives the run (per-process-tmp.ts).
// The user's per-user temp folder reached ~878,000 entries because tests never cleaned up after themselves.
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { perProcessTmp, removeTree } from "./per-process-tmp";

const until = async (what: string, check: () => boolean, ms: number): Promise<void> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return;
    await Bun.sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
};

describe("this test process runs inside its own temp root", () => {
  test("os.tmpdir() is the per-process root, under the temp folder the process started with", () => {
    expect(perProcessTmp.root).toBeDefined();
    const root = perProcessTmp.root!;
    expect(tmpdir()).toBe(root);
    expect(process.env.TMPDIR).toBe(root);
    expect(root.startsWith(`${perProcessTmp.realTmp}/winter-test-`)).toBe(true);
    expect(existsSync(root)).toBe(true);
  });

  test("the preload's own throwaway dirs (xdg, claude-resume scan root, legacy home, git config) are inside it", () => {
    for (const value of [process.env.XDG_CONFIG_HOME, process.env.WINTER_CLAUDE_RESUME_SCAN_ROOT, process.env.GIT_CONFIG_GLOBAL]) {
      expect(value?.startsWith(`${perProcessTmp.root}/`)).toBe(true);
    }
  });

  test("a child that is handed process.env sees the same temp folder", async () => {
    const child = Bun.spawn(["bun", "-e", "console.log(require('node:os').tmpdir())"], { env: { ...process.env }, stdout: "pipe" });
    expect((await new Response(child.stdout).text()).trim()).toBe(perProcessTmp.root!);
    await child.exited;
  });
});

describe("removeTree", () => {
  test("removes a tree that holds a read-only directory (a fixture that chmod'ed it)", () => {
    const root = mkdtempSync(join(tmpdir(), "winter-removetree-"));
    const locked = join(root, "a", "locked");
    mkdirSync(locked, { recursive: true });
    writeFileSync(join(locked, "f"), "x");
    chmodSync(locked, 0o500);
    removeTree(root);
    expect(existsSync(root)).toBe(false);
  });

  test("never throws, whatever it is given", () => {
    expect(() => removeTree(join(tmpdir(), "winter-removetree-does-not-exist"))).not.toThrow();
  });
});

describe("a finished run leaves nothing behind in the temp folder it started with", () => {
  async function runFixtureProcess(extraTestBody: string, signal?: "SIGTERM" | "SIGKILL"): Promise<{ outer: string; exitCode: number | null }> {
    // The nested process reads THIS process's already-narrowed tmpdir() as its "real" one, so everything it
    // makes lands in `outer`, which is itself inside this process's root.
    const outer = mkdtempSync(join(tmpdir(), "winter-pptmp-outer-"));
    const fixture = mkdtempSync(join(tmpdir(), "winter-pptmp-fixture-"));
    writeFileSync(join(fixture, "bunfig.toml"), `[test]\npreload = ["${join(import.meta.dir, "per-process-tmp.ts")}"]\n`);
    writeFileSync(join(fixture, "a.test.ts"), `
      import { test, expect } from "bun:test";
      import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
      import { tmpdir } from "node:os";
      import { join } from "node:path";
      test("makes a mess in tmpdir()", async () => {
        for (let i = 0; i < 5; i++) writeFileSync(join(mkdtempSync(join(tmpdir(), "mess-")), "f"), "x");
        const ro = join(mkdtempSync(join(tmpdir(), "mess-ro-")), "locked");
        mkdirSync(ro); writeFileSync(join(ro, "f"), "x"); chmodSync(ro, 0o500);
        expect(tmpdir()).toContain("winter-test-");
        ${extraTestBody}
      });
    `);
    const child = Bun.spawn(["bun", "test"], { cwd: fixture, env: { ...process.env, TMPDIR: outer }, stdout: "pipe", stderr: "pipe" });
    if (signal !== undefined) {
      // Wait for the nested run to have made its root, then kill it the hard way.
      await until("the nested run's temp root", () => readdirSync(outer).some((n) => n.startsWith("winter-test-")), 15_000);
      child.kill(signal);
    }
    const exitCode = await child.exited;
    return { outer, exitCode };
  }

  test("a normal run: its root is removed once the process is gone", async () => {
    const { outer, exitCode } = await runFixtureProcess("");
    expect(exitCode).toBe(0);
    await until("the run's temp root to be removed", () => readdirSync(outer).length === 0, 15_000);
    rmSync(outer, { recursive: true, force: true });
  }, 30_000);

  test("a killed run (SIGKILL — nothing in the process can react) is cleaned up too", async () => {
    const { outer } = await runFixtureProcess("await Bun.sleep(60_000);", "SIGKILL");
    await until("the killed run's temp root to be removed", () => readdirSync(outer).length === 0, 15_000);
    rmSync(outer, { recursive: true, force: true });
  }, 40_000);

  test("a terminated run (SIGTERM) is cleaned up too", async () => {
    const { outer } = await runFixtureProcess("await Bun.sleep(60_000);", "SIGTERM");
    await until("the terminated run's temp root to be removed", () => readdirSync(outer).length === 0, 15_000);
    rmSync(outer, { recursive: true, force: true });
  }, 40_000);
});
