import { afterEach, expect, jest, test } from "bun:test";
import type { NewSessionEvent } from "@winter/protocol";
import { PlanPresentedEvent, PlanResolvedEvent } from "@winter/protocol";
import type { SessionApprovalPolicy } from "../../src/agent/gate";
import { planBridgeFor, type BridgedPlanRequest } from "../../src/runtime-sdk/plan-bridge";

const SESSION = "s_plan_test";
const FIXED_NOW = 1_700_000_000_000;

afterEach(() => { jest.useRealTimers(); });

function baseRequest(over: Partial<BridgedPlanRequest> = {}): BridgedPlanRequest {
  return {
    sessionId: SESSION, callId: "tu-plan-1", toolName: "ExitPlanMode", gateToolName: "exit_plan_mode",
    requestId: "req-1", summary: "ExitPlanMode", issuedAt: FIXED_NOW, expiresAt: FIXED_NOW + 1000,
    plan: "1. Do the thing\n2. Verify it",
    ...over,
  };
}

function harness(over: Partial<Parameters<typeof planBridgeFor>[0]> = {}) {
  const events: NewSessionEvent[] = [];
  const policyCalls: Array<{ sessionId: string; policy: SessionApprovalPolicy }> = [];
  const bridge = planBridgeFor({
    emit: (e) => { events.push(e); },
    setPolicy: (sessionId, policy) => { policyCalls.push({ sessionId, policy }); },
    now: () => FIXED_NOW,
    parkTimeoutMs: 50,
    ...over,
  });
  return { events, policyCalls, bridge };
}

test("plan_presented carries sessionId/threadId/callId/plan and validates against the protocol schema", async () => {
  const { events, bridge } = harness();
  const pending = bridge.onExitPlanMode(baseRequest());
  expect(events).toHaveLength(1);
  expect(events[0]).toEqual({
    type: "plan_presented", sessionId: SESSION, threadId: "main", callId: "tu-plan-1",
    plan: "1. Do the thing\n2. Verify it",
  });
  expect(PlanPresentedEvent.parse({ ...events[0], seq: 1, ts: FIXED_NOW })).toBeTruthy();
  // Park it so the test does not leave a dangling timer.
  bridge.respond(SESSION, "tu-plan-1", { approved: true, autoAccept: false }, "test");
  await pending;
});

test("approve (autoAccept:false) → allow, plan_resolved, and policy set to \"ask\"", async () => {
  const { events, policyCalls, bridge } = harness();
  const pending = bridge.onExitPlanMode(baseRequest());
  const resolved = bridge.respond(SESSION, "tu-plan-1", { approved: true, autoAccept: false }, "mac");
  expect(resolved).toEqual({ ok: true, alreadyResolved: false });

  const res = await pending;
  expect(res).toEqual({ behavior: "allow", updatedInput: { plan: "1. Do the thing\n2. Verify it" } });
  expect(events[1]).toEqual({
    type: "plan_resolved", sessionId: SESSION, threadId: "main", callId: "tu-plan-1",
    approved: true, autoAccept: false, by: "mac",
  });
  expect(PlanResolvedEvent.parse({ ...events[1], seq: 2, ts: FIXED_NOW })).toBeTruthy();
  expect(policyCalls).toEqual([{ sessionId: SESSION, policy: "ask" }]);
});

test("approve (autoAccept:true) → policy set to \"auto\"", async () => {
  const { policyCalls, bridge } = harness();
  const pending = bridge.onExitPlanMode(baseRequest());
  bridge.respond(SESSION, "tu-plan-1", { approved: true, autoAccept: true }, "mac");
  await pending;
  expect(policyCalls).toEqual([{ sessionId: SESSION, policy: "auto" }]);
});

test("feedback (rejection) → deny with the feedback in the message, never touches setPolicy", async () => {
  const { events, policyCalls, bridge } = harness();
  const pending = bridge.onExitPlanMode(baseRequest());
  bridge.respond(SESSION, "tu-plan-1", { approved: false, feedback: "use SQLite instead", autoAccept: false }, "mac");
  const res = await pending;
  expect(res).toEqual({
    behavior: "deny",
    message: "Plan rejected: use SQLite instead. Stay in plan mode and revise your plan, then call ExitPlanMode again.",
  });
  expect(events[1]).toMatchObject({ type: "plan_resolved", approved: false, autoAccept: false, feedback: "use SQLite instead", by: "mac" });
  expect(policyCalls).toEqual([]);
});

test("rejection with no feedback text falls back to a generic reason", async () => {
  const { bridge } = harness();
  const pending = bridge.onExitPlanMode(baseRequest({ callId: "tu-plan-2" }));
  bridge.respond(SESSION, "tu-plan-2", { approved: false, autoAccept: false }, "mac");
  const res = await pending;
  expect(res.behavior).toBe("deny");
  expect((res as { message: string }).message).toContain("rejected the plan without specific feedback");
});

test("respond on an already-resolved callId reports alreadyResolved:true and does not throw", async () => {
  const { bridge } = harness();
  const pending = bridge.onExitPlanMode(baseRequest({ callId: "tu-plan-3" }));
  const first = bridge.respond(SESSION, "tu-plan-3", { approved: true, autoAccept: false }, "mac");
  const second = bridge.respond(SESSION, "tu-plan-3", { approved: true, autoAccept: false }, "mac");
  expect(first.alreadyResolved).toBe(false);
  expect(second).toEqual({ ok: true, alreadyResolved: true });
  await pending;
});

test("respond with no pending plan for that (sessionId, callId) reports alreadyResolved:true", () => {
  const { bridge } = harness();
  expect(bridge.respond(SESSION, "no-such-call", { approved: true, autoAccept: false }, "mac")).toEqual({ ok: true, alreadyResolved: true });
});

test("a park timeout denies, emits plan_resolved by \"timeout\", and never sets policy", async () => {
  const { events, policyCalls, bridge } = harness({ parkTimeoutMs: 5 });
  const res = await bridge.onExitPlanMode(baseRequest({ callId: "tu-plan-timeout" }));
  expect(res.behavior).toBe("deny");
  expect((res as { message: string }).message).toContain("no response");
  expect(events[1]).toMatchObject({ type: "plan_resolved", approved: false, by: "timeout" });
  expect(policyCalls).toEqual([]);
});

test("an emit failure on plan_presented denies without parking a waiter", async () => {
  const bridge = planBridgeFor({
    emit: () => { throw new Error("disk full"); },
    setPolicy: () => {},
    parkTimeoutMs: 50,
  });
  const res = await bridge.onExitPlanMode(baseRequest({ callId: "tu-plan-fail" }));
  expect(res).toEqual({ behavior: "deny", message: "ExitPlanMode was not presented — this session could not raise the plan." });
  // Nothing left pending: a late respond reports alreadyResolved.
  expect(bridge.respond(SESSION, "tu-plan-fail", { approved: true, autoAccept: false }, "late")).toEqual({ ok: true, alreadyResolved: true });
});

test("a setPolicy failure after approval still returns allow — the human's yes is not undone by a store error", async () => {
  const { bridge } = harness({ setPolicy: () => { throw new Error("store closed"); } });
  const pending = bridge.onExitPlanMode(baseRequest({ callId: "tu-plan-policy-fail" }));
  bridge.respond(SESSION, "tu-plan-policy-fail", { approved: true, autoAccept: false }, "mac");
  const res = await pending;
  expect(res).toEqual({ behavior: "allow", updatedInput: { plan: "1. Do the thing\n2. Verify it" } });
});
