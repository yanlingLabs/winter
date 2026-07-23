import { expect, test } from "bun:test";
import { makeWorkflowBridgeHarness } from "./workflow-bridge.testkit"; // FakeProvider that emits one Workflow tool_call

// Task B-gatefix: both tests below pin `approvalPolicy: "bypass"` explicitly. They predate this
// task and originally relied on the harness's default policy (`auto`) launching a Workflow call
// silently — Task B-gatefix's whole point is that `auto` no longer does that (it now CARDS, see the
// dedicated auto test further down), so left at the old implicit default these would hang forever
// waiting on an approval nothing ever resolves. Their actual intent is the LAUNCH/notification
// MECHANICS (runId shape, completion → task_notification), not gate policy — `bypass` (opt-in
// no-guardrails, still silent under this task's fix) is the minimal, intent-preserving pin.
test("calling Workflow launches a run and returns runId/status:running", async () => {
  const { engine, sessionId, toolResults } = await makeWorkflowBridgeHarness({ script: `return 1;`, approvalPolicy: "bypass" });
  await engine.runTurn(sessionId);
  const parsed = JSON.parse(toolResults()[0]!.output);
  expect(parsed.status).toBe("running");
  expect(parsed.runId).toMatch(/^wf_/);
});

test("a completed background run appends a task_notification to the session", async () => {
  const { engine, sessionId, store } = await makeWorkflowBridgeHarness({ script: `return "the summary";`, approvalPolicy: "bypass" });
  await engine.runTurn(sessionId);
  await new Promise((r) => setTimeout(r, 100)); // let the run finish + notify
  const events = store.read(sessionId);
  expect(events.some((e) => e.type === "task_notification" && /the summary|workflow/i.test((e as any).content))).toBe(true);
});

// Task B2 SECURITY: the launch gate must actually be consulted by the bridge, not just by
// gate.evaluate() in isolation (gate.test.ts already pins the classification itself) — this drives
// the REAL dispatch loop end to end and proves a `plan` session's Workflow call never reaches
// WorkflowRuntime.launch() at all: the tool_result is a plain denial, never a {runId,...} shape, and
// no approval card is ever raised (plan mode blocks outright, no human round-trip).
test("Workflow under plan mode is denied — never launches, no approval card", async () => {
  const { engine, sessionId, toolResults } = await makeWorkflowBridgeHarness({ script: `return 1;`, approvalPolicy: "plan" });
  await engine.runTurn(sessionId);
  const result = toolResults()[0]!;
  expect(result.isError).toBe(true);
  expect(result.output).toMatch(/plan mode/i);
  expect(() => JSON.parse(result.output)).toThrow(); // never the {runId,status} launch shape
});

// Task B2 SECURITY: under `ask` policy the call must CARD (wait for a human), never silently
// launch. Drives the real dispatch loop far enough to observe the approval_requested event, then
// approves it via the broker and confirms the launch proceeds only AFTER that approval.
test("Workflow under ask policy cards — waits for approval before launching", async () => {
  const { engine, sessionId, broker, toolResults } = await makeWorkflowBridgeHarness({ script: `return 1;`, approvalPolicy: "ask" });
  const turn = engine.runTurn(sessionId);
  // Poll briefly for the approval to register — requestApproval registers with the broker
  // synchronously before emitting approval_requested, so this settles almost immediately.
  for (let i = 0; i < 50 && !broker.list(sessionId).length; i++) await new Promise((r) => setTimeout(r, 5));
  const pending = broker.list(sessionId);
  expect(pending.length).toBe(1);
  expect(pending[0]!.toolName).toBe("Workflow");
  expect(toolResults().length).toBe(0); // no tool_result yet — the call is genuinely blocked on the card
  broker.resolve(sessionId, pending[0]!.callId, true, "user");
  await turn;
  const parsed = JSON.parse(toolResults()[0]!.output);
  expect(parsed.status).toBe("running");
  expect(parsed.runId).toMatch(/^wf_/);
});

// Task B-gatefix Part 1 SECURITY (user decision 2026-07-22, CC-parity — this is the exact bug this
// task fixes): B2 originally free-passed a Workflow launch under `accept-edits` straight to
// WorkflowRuntime.launch(), no card, no human round-trip. Byte-identical shape to the `ask` test
// just above (same poll-for-broker-registration/no-tool_result-yet/resolve/await pattern) — proves
// the fix through the REAL dispatch loop, not just gate.evaluate() in isolation (gate.test.ts pins
// the classification itself).
test("Workflow under accept-edits policy CARDS — waits for approval before launching (Task B-gatefix)", async () => {
  const { engine, sessionId, broker, toolResults } = await makeWorkflowBridgeHarness({ script: `return 1;`, approvalPolicy: "accept-edits" });
  const turn = engine.runTurn(sessionId);
  for (let i = 0; i < 50 && !broker.list(sessionId).length; i++) await new Promise((r) => setTimeout(r, 5));
  const pending = broker.list(sessionId);
  expect(pending.length).toBe(1);
  expect(pending[0]!.toolName).toBe("Workflow");
  expect(toolResults().length).toBe(0); // no tool_result yet — genuinely blocked on the card, not silently launched
  broker.resolve(sessionId, pending[0]!.callId, true, "user");
  await turn;
  const parsed = JSON.parse(toolResults()[0]!.output);
  expect(parsed.status).toBe("running");
  expect(parsed.runId).toMatch(/^wf_/);
});

// Task B-gatefix Part 2 SECURITY (user decision 2026-07-22, CC-parity): B2 originally free-passed a
// Workflow launch under `auto` too, straight to WorkflowRuntime.launch(), no card, no review —
// exactly like the accept-edits bug above. This harness wires no `cfg.reviewer` (mirrors every other
// workflow-bridge test in this file), so the CARD fallback this task chose (gate.ts special-cases
// Workflow to "ask" under auto — see gate.ts's own doc comment for why the AI-reviewer branch was
// rejected) is what must fire; a reviewer-branch implementation would instead show NO card here and
// launch straight through on a "safe" verdict — this test's shape (assert a card, not a launch)
// pins the CARD choice specifically. Byte-identical to the accept-edits test just above.
test("Workflow under auto policy CARDS (never silently reaches launch()) — Task B-gatefix", async () => {
  const { engine, sessionId, broker, toolResults } = await makeWorkflowBridgeHarness({ script: `return 1;`, approvalPolicy: "auto" });
  const turn = engine.runTurn(sessionId);
  for (let i = 0; i < 50 && !broker.list(sessionId).length; i++) await new Promise((r) => setTimeout(r, 5));
  const pending = broker.list(sessionId);
  expect(pending.length).toBe(1);
  expect(pending[0]!.toolName).toBe("Workflow");
  expect(toolResults().length).toBe(0); // no tool_result yet — genuinely blocked on the card, not silently launched
  broker.resolve(sessionId, pending[0]!.callId, true, "user");
  await turn;
  const parsed = JSON.parse(toolResults()[0]!.output);
  expect(parsed.status).toBe("running");
  expect(parsed.runId).toMatch(/^wf_/);
});
