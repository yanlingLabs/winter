import { expect, spyOn, test } from "bun:test";
// Harness: build an AgentEngine with a FakeProvider whose child turn emits one assistant_message,
// wired with SubagentManager + AgentStore (mirror the setup in agent/spawn.test.ts / engine tests).
import { makeWorkflowAgentHarness } from "./workflow-agent.testkit"; // small local testkit (see step 3)

test("runWorkflowAgent reaches the real spawn machinery and returns the child's final report", async () => {
  const { engine, sessionId } = await makeWorkflowAgentHarness({ childReply: "child says hi" });
  const out = await engine.runWorkflowAgent(sessionId, "do a thing", undefined, new AbortController().signal);
  expect(out).toEqual({ ok: true, result: "child says hi" });
});

test("the spawned agent runs at accept-edits and does NOT have the Workflow tool", async () => {
  const { engine, sessionId, toolsSeenByChild } = await makeWorkflowAgentHarness({ childReply: "ok", recordChildTools: true });
  await engine.runWorkflowAgent(sessionId, "edit a file", undefined, new AbortController().signal);
  expect(toolsSeenByChild()).not.toContain("Workflow");
  // policy assertion: the harness's FakeProvider records meta.approvalPolicy handed to the child turn
  expect(toolsSeenByChild.policy?.()).toBe("accept-edits");
});

// M3 (review fix): a workflow-spawned agent must not itself be able to call spawn_agent — nesting a
// grandchild subtree would count against the global SubagentManager pool but escape the run's OWN
// semaphore + totalCap, since only the workflow's direct agent() fan-out is counted there. Unlike
// the "Workflow" tool check above, this can't ride toolsSeenByChild()/specs(): the testkit's stub
// registry never registers anything named "spawn_agent" (only "Workflow" is stubbed — see the
// testkit's own doc comment), so a specs()-filter assertion would pass vacuously whether or not
// runWorkflowAgent excludes it. Instead, spy on runThread directly (same TS-private-is-a-plain-
// method-at-runtime trick the testkit uses) and read the real `excludeTools` Set it was built with
// — the exact mechanism the engine's own specs() filter reads (`.filter((s) =>
// !excludeTools?.has(s.name))`), so this genuinely fails if "spawn_agent" is ever dropped from it.
test("the spawned agent's tool set excludes spawn_agent (nested fan-out must not escape the run's caps)", async () => {
  const { engine, sessionId } = await makeWorkflowAgentHarness({ childReply: "ok" });
  const runThreadSpy = spyOn(engine as unknown as { runThread: (...args: unknown[]) => unknown }, "runThread");
  await engine.runWorkflowAgent(sessionId, "do a thing", undefined, new AbortController().signal);
  const call = runThreadSpy.mock.calls[0] as [{ excludeTools?: Set<string> }];
  expect(call[0].excludeTools?.has("spawn_agent")).toBe(true);
});
