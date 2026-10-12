import { expect, test } from "bun:test";
import { join } from "node:path";

const fixture = join(import.meta.dir, "fixtures/daemon-child-floor.ts");
const preload = join(import.meta.dir, "../preload.ts");
async function run(mode: string, candidate?: string): Promise<void> {
  const child = Bun.spawn([process.execPath, "run", "--preload", preload, fixture, mode, ...(candidate ? [candidate] : [])], { stdout: "pipe", stderr: "pipe", env: process.env });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
  expect(stdout).toBe("daemon child policy verified\n");
}
test("ordinary retired hook history never creates artificial Cowork activation debt", () => run("retired"));
test("ordinary HookRunner/LSP behavior has no outer floor with active storage", () => run("ordinary"));
