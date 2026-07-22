import { expect, test } from "bun:test";
import { runWorkflow } from "./worker-harness";

const noop = () => {};
function base(source: string, agent = async (p: string) => `[${p}]`) {
  return { source, args: { day: "2026-07-22" }, concurrency: 16, agent, phase: noop, log: noop };
}

test("runs meta + body, returns the body's return value, agent() reaches the bridge", async () => {
  const src = `export const meta = { name: "t", description: "d" };
    const a = await agent("hello");
    return { got: a, day: args.day };`;
  const out = await runWorkflow(base(src));
  expect(out.meta).toEqual({ name: "t", description: "d" });
  expect(out.result).toEqual({ got: "[hello]", day: "2026-07-22" });
});

test("parallel runs thunks; a thrown thunk resolves to null, batch survives", async () => {
  const src = `return await parallel([
    () => agent("a"),
    () => { throw new Error("boom"); },
    () => agent("c"),
  ]);`;
  const out = await runWorkflow(base(src));
  expect(out.result).toEqual(["[a]", null, "[c]"]);
});

test("pipeline flows each item through stages; a stage throw drops that item to null", async () => {
  const src = `return await pipeline([1, 2],
    async (n) => { if (n === 2) throw new Error("x"); return n * 10; },
    async (n) => n + 1);`;
  const out = await runWorkflow(base(src));
  expect(out.result).toEqual([11, null]);
});

test("curated scope: Bun/process/require/fetch shadowed; Date.now/Math.random/argless new Date withheld", async () => {
  const probe = async (expr: string) =>
    (await runWorkflow(base(`return (${expr});`))).result;
  expect(await probe("typeof Bun")).toBe("undefined");
  expect(await probe("typeof process")).toBe("undefined");
  expect(await probe("typeof require")).toBe("undefined");
  expect(await probe("typeof fetch")).toBe("undefined");
  await expect(runWorkflow(base(`return Math.random();`))).rejects.toThrow(/determinism/);
  await expect(runWorkflow(base(`return Date.now();`))).rejects.toThrow(/determinism/);
  await expect(runWorkflow(base(`return new Date();`))).rejects.toThrow(/determinism/);
  expect(await probe("new Date(args.day).getUTCFullYear()")).toBe(2026); // args-supplied timestamp OK
});

test("a syntax/eval error rejects (surfaced by the runtime as workflow_failed)", async () => {
  await expect(runWorkflow(base(`return (;`))).rejects.toBeDefined();
});
