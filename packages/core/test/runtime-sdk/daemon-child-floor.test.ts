import { expect, test } from "bun:test";
import { join } from "node:path";

const fixture = join(import.meta.dir, "fixtures/daemon-child-floor.ts");
const preload = join(import.meta.dir, "../preload.ts");
async function run(mode: string, candidate?: string): Promise<void> {
  const child = Bun.spawn([process.execPath, "run", "--preload", preload, fixture, mode, ...(candidate ? [candidate] : [])], { stdout: "pipe", stderr: "pipe", env: process.env });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
  expect(stdout).toBe("daemon child floor verified\n");
}
test("retired direct hook exit does not admit newly protected roots without descendant proof", () => run("retired"));
// Explicit candidate input keeps a source checkout from being mistaken for the installed/released SDK.
test.skipIf(process.platform !== "darwin" || !process.env.WINTER_TEST_FLOOR_SDK)("native HookRunner/LSP floors protect volumes, preserve ordinary writes and cover new workspaces", () => run("kernel", process.env.WINTER_TEST_FLOOR_SDK));
