import { expect, test } from "bun:test";
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
