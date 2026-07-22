import { expect, test } from "bun:test";
import { WorkflowRuntime, type WorkflowRuntimeEvent } from "./runtime";

function makeRuntime(over: Partial<ConstructorParameters<typeof WorkflowRuntime>[0]> = {}) {
  const events: Array<[string, WorkflowRuntimeEvent]> = [];
  const rt = new WorkflowRuntime({
    onEvent: (sid, ev) => events.push([sid, ev]),
    spawnAgent: async (_sid, prompt) => ({ ok: true, result: `[${prompt}]` }),
    ...over,
  });
  return { rt, events };
}

test("a trivial script runs in the Worker and returns its result", async () => {
  const { rt } = makeRuntime();
  const runId = rt.launch({ sessionId: "s_1", source: `export const meta={name:"t",description:"d"};\nconst a=await agent("hi");\nreturn a;` });
  const view = await rt.await(runId);
  expect(view.status).toBe("completed");
  expect(view.result).toBe("[hi]");
});

test("phase/log emit progress events; the run tracks counts", async () => {
  const { rt, events } = makeRuntime();
  const runId = rt.launch({ sessionId: "s_1", source: `phase("triage"); log("scanning"); return 1;` });
  await rt.await(runId);
  const progress = events.filter(([, e]) => e.type === "progress").map(([, e]) => e as Extract<WorkflowRuntimeEvent, {type:"progress"}>);
  expect(progress.some((e) => e.progress.phase === "triage")).toBe(true);
  expect(progress.some((e) => e.progress.log === "scanning")).toBe(true);
});

test("stop() terminates a mid-run Worker", async () => {
  const { rt } = makeRuntime({ spawnAgent: async () => new Promise(() => {}) }); // never resolves
  const runId = rt.launch({ sessionId: "s_1", source: `await agent("forever"); return "unreachable";` });
  await new Promise((r) => setTimeout(r, 50));
  expect(rt.stop(runId)).toBe(true);
  const view = await rt.await(runId);
  expect(view.status).toBe("stopped");
});

test("a script eval error → failed, never crashes the process", async () => {
  const { rt } = makeRuntime();
  const runId = rt.launch({ sessionId: "s_1", source: `return (;` });
  const view = await rt.await(runId);
  expect(view.status).toBe("failed");
  expect(view.error).toBeDefined();
});
