import { expect, test } from "bun:test";
import type { NewSessionEvent } from "@norma/protocol";
import { sinksFor, type ProjectedToolCall, type ProjectedToolResult, type RoutineSink } from "../../src/runtime-sdk/sinks";

const SESSION = "s_sinks_test";

function fakeRoutines(): RoutineSink & { created: Array<{ spec: string; prompt: string; cwd?: string }>; deleted: string[] } {
  let n = 0;
  const created: Array<{ spec: string; prompt: string; cwd?: string }> = [];
  const deleted: string[] = [];
  return {
    created, deleted,
    create(input) {
      created.push(input);
      return { id: `routine-${++n}` };
    },
    delete(id) {
      deleted.push(id);
      return true;
    },
  };
}

function harness(over: Partial<Parameters<typeof sinksFor>[0]> = {}) {
  const events: NewSessionEvent[] = [];
  const fallbacks: Array<{ title: string; message: string }> = [];
  const routines = over.routines ?? fakeRoutines();
  const attached = { count: 0 };
  const sinks = sinksFor({
    routines,
    emit: (e) => { events.push(e); },
    attachedCount: () => attached.count,
    notifyFallback: (title, message) => { fallbacks.push({ title, message }); },
    ...over,
  });
  return { sinks, events, fallbacks, routines: routines as ReturnType<typeof fakeRoutines>, attached };
}

const call = (over: Partial<ProjectedToolCall>): ProjectedToolCall => ({
  sessionId: SESSION, threadId: "main", callId: "tu-1", name: "push_notification", argsJson: "{}", ...over,
});
const toolResult = (over: Partial<ProjectedToolResult>): ProjectedToolResult => ({
  sessionId: SESSION, threadId: "main", callId: "tu-1", output: "{}", isError: false, ...over,
});

// ── push_notification ─────────────────────────────────────────────────────────────────────────

test("push_notification: emits notification_requested with the fixed title and fires the headless fallback when nobody is attached", () => {
  const { sinks, events, fallbacks, attached } = harness();
  attached.count = 0;
  sinks.onToolCall(call({ name: "push_notification", argsJson: JSON.stringify({ message: "build finished", status: "proactive" }) }));
  expect(events).toEqual([{ type: "notification_requested", sessionId: SESSION, threadId: "main", title: "Norma", message: "build finished" }]);
  expect(fallbacks).toEqual([{ title: "Norma", message: "build finished" }]);
});

test("push_notification: does NOT fire the headless fallback when a client is attached", () => {
  const { sinks, events, fallbacks, attached } = harness();
  attached.count = 1;
  sinks.onToolCall(call({ name: "push_notification", argsJson: JSON.stringify({ message: "build finished", status: "proactive" }) }));
  expect(events).toHaveLength(1);
  expect(fallbacks).toEqual([]);
});

test("push_notification: a replayed tool_call for the SAME callId fires the sink 0 extra times", () => {
  const { sinks, events, fallbacks } = harness();
  const c = call({ name: "push_notification", argsJson: JSON.stringify({ message: "build finished", status: "proactive" }) });
  sinks.onToolCall(c);
  sinks.onToolCall(c);
  sinks.onToolCall(c);
  expect(events).toHaveLength(1);
  expect(fallbacks).toHaveLength(1);
});

test("push_notification: unparseable args are logged and never emitted", () => {
  const errors: string[] = [];
  const { sinks, events } = harness({ log: { info: () => {}, error: (m) => errors.push(m) } });
  sinks.onToolCall(call({ name: "push_notification", argsJson: "not json" }));
  expect(events).toEqual([]);
  expect(errors.length).toBeGreaterThan(0);
});

test("a tool_call for an unrelated name is ignored by both sinks", () => {
  const { sinks, events, routines } = harness();
  sinks.onToolCall(call({ name: "read", argsJson: "{}" }));
  expect(events).toEqual([]);
  expect(routines.created).toEqual([]);
});

// ── schedule (CronCreate/CronDelete/CronList collapsed) ──────────────────────────────────────────

test("schedule create: a routine lands only after the matching tool_result confirms success, carrying the child's id", () => {
  const { sinks, routines } = harness();
  sinks.onToolCall(call({ name: "schedule", callId: "tu-cron-1", argsJson: JSON.stringify({ cron: "0 9 * * *", prompt: "say good morning" }) }));
  expect(routines.created).toEqual([]); // not yet — waiting on the result
  sinks.onToolResult(toolResult({ callId: "tu-cron-1", output: JSON.stringify({ id: "winter-job-1", humanSchedule: "daily at 09:00", recurring: true }) }));
  expect(routines.created).toEqual([{ spec: "0 9 * * *", prompt: "say good morning", cwd: undefined }]);
});

test("schedule create: an isError result is never mirrored", () => {
  const { sinks, routines } = harness();
  sinks.onToolCall(call({ name: "schedule", callId: "tu-cron-2", argsJson: JSON.stringify({ cron: "bogus", prompt: "x" }) }));
  sinks.onToolResult(toolResult({ callId: "tu-cron-2", output: "Error: minute: bogus is not a valid value", isError: true }));
  expect(routines.created).toEqual([]);
});

test("schedule create: a result with no id is never mirrored", () => {
  const { sinks, routines } = harness();
  sinks.onToolCall(call({ name: "schedule", callId: "tu-cron-3", argsJson: JSON.stringify({ cron: "0 9 * * *", prompt: "x" }) }));
  sinks.onToolResult(toolResult({ callId: "tu-cron-3", output: JSON.stringify({ humanSchedule: "daily at 09:00" }) }));
  expect(routines.created).toEqual([]);
});

test("schedule create: cwdFor supplies the routine's cwd when wired", () => {
  const { sinks, routines } = harness({ cwdFor: () => "/Users/x/project" });
  sinks.onToolCall(call({ name: "schedule", callId: "tu-cron-4", argsJson: JSON.stringify({ cron: "0 9 * * *", prompt: "x" }) }));
  sinks.onToolResult(toolResult({ callId: "tu-cron-4", output: JSON.stringify({ id: "w-4" }) }));
  expect(routines.created).toEqual([{ spec: "0 9 * * *", prompt: "x", cwd: "/Users/x/project" }]);
});

test("schedule delete: resolves the child's minted id to the mirrored routine and deletes it", () => {
  const { sinks, routines } = harness();
  sinks.onToolCall(call({ name: "schedule", callId: "tu-cron-5", argsJson: JSON.stringify({ cron: "0 9 * * *", prompt: "x" }) }));
  sinks.onToolResult(toolResult({ callId: "tu-cron-5", output: JSON.stringify({ id: "winter-job-5" }) }));
  expect(routines.created).toEqual([{ spec: "0 9 * * *", prompt: "x", cwd: undefined }]);
  const createdId = "routine-1";

  sinks.onToolCall(call({ name: "schedule", callId: "tu-cron-6", argsJson: JSON.stringify({ id: "winter-job-5" }) }));
  expect(routines.deleted).toEqual([createdId]);
});

test("schedule delete: an id this daemon never mirrored is a harmless no-op (matches CronDelete's own contract)", () => {
  const { sinks, routines } = harness();
  sinks.onToolCall(call({ name: "schedule", callId: "tu-cron-7", argsJson: JSON.stringify({ id: "never-seen" }) }));
  expect(routines.deleted).toEqual([]);
});

test("schedule delete: a replayed tool_call for the SAME callId deletes only once", () => {
  const { sinks, routines } = harness();
  sinks.onToolCall(call({ name: "schedule", callId: "tu-cron-8", argsJson: JSON.stringify({ cron: "0 9 * * *", prompt: "x" }) }));
  sinks.onToolResult(toolResult({ callId: "tu-cron-8", output: JSON.stringify({ id: "winter-job-8" }) }));
  const del = call({ name: "schedule", callId: "tu-cron-9", argsJson: JSON.stringify({ id: "winter-job-8" }) });
  sinks.onToolCall(del);
  sinks.onToolCall(del);
  expect(routines.deleted).toEqual(["routine-1"]);
});

test("schedule list (empty args): no side effect on either sink", () => {
  const { sinks, routines } = harness();
  sinks.onToolCall(call({ name: "schedule", callId: "tu-cron-10", argsJson: "{}" }));
  expect(routines.created).toEqual([]);
  expect(routines.deleted).toEqual([]);
});

test("a tool_result for a callId with no pending create is ignored", () => {
  const { sinks, routines } = harness();
  sinks.onToolResult(toolResult({ callId: "no-such-call", output: JSON.stringify({ id: "x" }) }));
  expect(routines.created).toEqual([]);
});

test("schedule create: a RoutineStore validation failure is logged, not thrown, and mirrors nothing", () => {
  const errors: string[] = [];
  const routines: RoutineSink = {
    create: () => { throw new TypeError("invalid spec"); },
    delete: () => true,
  };
  const { sinks } = harness({ routines, log: { info: () => {}, error: (m) => errors.push(m) } });
  sinks.onToolCall(call({ name: "schedule", callId: "tu-cron-11", argsJson: JSON.stringify({ cron: "0 9 * * *", prompt: "x" }) }));
  expect(() => sinks.onToolResult(toolResult({ callId: "tu-cron-11", output: JSON.stringify({ id: "w-11" }) }))).not.toThrow();
  expect(errors.length).toBeGreaterThan(0);
});
