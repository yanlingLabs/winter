import { expect, test } from "bun:test";
import { WorkflowRuntime } from "./runtime";

test("per-run concurrency is capped (never more than N agents in flight at once)", async () => {
  let inFlight = 0, peak = 0;
  const rt = new WorkflowRuntime({
    onEvent: () => {},
    caps: { concurrency: 3, total: 1000 },
    spawnAgent: async () => { inFlight++; peak = Math.max(peak, inFlight); await new Promise((r) => setTimeout(r, 20)); inFlight--; return { ok: true, result: "x" }; },
  });
  const runId = rt.launch({ sessionId: "s_1", source: `return await parallel(Array.from({length:12},(_,i)=>()=>agent("t"+i)));` });
  await rt.await(runId);
  expect(peak).toBeLessThanOrEqual(3);
});

test("exceeding the total-agents cap fails the run with a clear error", async () => {
  const rt = new WorkflowRuntime({
    onEvent: () => {},
    caps: { concurrency: 16, total: 5 },
    spawnAgent: async () => ({ ok: true, result: "x" }),
  });
  const runId = rt.launch({ sessionId: "s_1", source: `for (let i=0;i<50;i++) await agent("t"+i); return "unreachable";` });
  const view = await rt.await(runId);
  expect(view.status).toBe("failed");
  expect(view.error).toMatch(/cap/i);
});
