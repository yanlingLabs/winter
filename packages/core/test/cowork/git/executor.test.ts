import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { IsolatedGitExecutor, resolveGitExecutable } from "../../../src/cowork/git/executor";

test("Git cancellation terminates owned helper processes holding output pipes", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "winter-git-tree-")));
  // A fixed fixture executable ignores Git argv, like a Git pack helper keeping its pipe.
  // Its child is in the executor's private process group; no external PID is signalled.
  const executable = join(root, "fixture-git");
  writeFileSync(executable, "#!/bin/sh\n(/bin/sleep 0.3; printf survived > child-survived) &\nprintf ready > child-ready\nwait\n", { mode: 0o700 });
  try {
    const began = Date.now();
    await expect(new IsolatedGitExecutor(executable, 3000).run({ cwd: root, home: root, args: [], withinBudget: () => !existsSync(join(root, "child-ready")) })).rejects.toMatchObject({ code: "object_budget" });
    expect(Date.now() - began).toBeLessThan(3000);
    expect(existsSync(join(root, "child-ready"))).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 450));
    expect(existsSync(join(root, "child-survived"))).toBe(false);
    // The child inherits stdout. 'close' within this bound witnesses its pipe closure;
    // this fixture does not claim a general malicious-child termination proof.
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("Git termination also bounds waiting for pipes held by an escaped fixture descendant", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "winter-git-escaped-"))), executable = join(root, "fixture-git");
  writeFileSync(executable, `#!${process.execPath}\nimport { spawn } from 'node:child_process';\nimport { writeFileSync } from 'node:fs';\nconst child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] });\nwriteFileSync('escaped-pid', String(child.pid));\nsetInterval(() => {}, 5000);\n`, { mode: 0o700 });
  try {
    const began = Date.now();
    await expect(new IsolatedGitExecutor(executable, 3000, 1024, 100).run({ cwd: root, home: root, args: [], withinBudget: () => !existsSync(join(root, "escaped-pid")) })).rejects.toMatchObject({ code: "object_budget" });
    expect(Date.now() - began).toBeLessThan(3500);
    expect(existsSync(join(root, "escaped-pid"))).toBe(true);
  } finally {
    // Only this fixture's child is signalled. The broker itself cannot guarantee
    // group confinement; production still requires a host process/resource jail.
    if (existsSync(join(root, "escaped-pid"))) { try { process.kill(-Number(readFileSync(join(root, "escaped-pid"), "utf8")), "SIGKILL"); } catch { /* already gone */ } }
    rmSync(root, { recursive: true, force: true });
  }
});
test("host Git resolution caches a real executable and refuses the macOS xcrun shim", () => {
  expect(resolveGitExecutable()).toBe(resolveGitExecutable());
  if (process.platform === "darwin") {
    expect(resolveGitExecutable()).not.toBe("/usr/bin/git");
    expect(() => new IsolatedGitExecutor("/usr/bin/git")).toThrow("invalid_request");
  }
});
