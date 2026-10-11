import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { IsolatedGitExecutor } from "../../../src/cowork/git/executor";

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
