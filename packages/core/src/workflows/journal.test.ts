import { expect, test } from "bun:test";
import { promptKey } from "./journal";
import { runWorkflow } from "./worker-harness";

test("promptKey is stable and (prompt,opts)-sensitive", () => {
  expect(promptKey("a", { model: "x" })).toBe(promptKey("a", { model: "x" }));
  expect(promptKey("a")).not.toBe(promptKey("b"));
});

test("harness serves cached results for unchanged prefix calls, runs the first changed call live", async () => {
  const live: string[] = [];
  const journal = [{ promptKey: promptKey("first"), value: "CACHED-1" }, { promptKey: promptKey("second"), value: "CACHED-2" }];
  const out = await runWorkflow({
    source: `const a = await agent("first"); const b = await agent("CHANGED"); return [a, b];`,
    args: null, concurrency: 16, phase: () => {}, log: () => {}, resumeJournal: journal,
    agent: async (p: string) => { live.push(p); return `LIVE-${p}`; },
  } as any);
  expect(out.result).toEqual(["CACHED-1", "LIVE-CHANGED"]); // first cached, second (changed) live
  expect(live).toEqual(["CHANGED"]); // only the changed call hit the bridge
});
