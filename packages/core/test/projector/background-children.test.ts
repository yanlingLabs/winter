import { describe, expect, test } from "bun:test";
import { SessionEvent } from "@yanlinglabs/winter-protocol";
import type { ProtocolSdkMessage } from "../../src/projector";
import { tasksFromEvents } from "../../src/runtime-sdk/tasks-reader";
import { FakeCheckpoints, accept, assistantToolUse, init, makeProjector, result, run, toolResult } from "./harness";

/**
 * Background (`run_in_background`) subagents and failed spawns — the thread lifecycle the Mac's live
 * subagent list folds (`thread_started` → working, `thread_completed` → done).
 *
 * Shapes mirror what was measured in `~/.winter-dev/sessions/global/s_98250c036992.jsonl` (Winter
 * leg, SDK 0.0.14) and `winter-agent-sdk/packages/runtime/src/tools/impl/agent.ts`: an async spawn's
 * `tool_result` is `{"status":"async_launched","agentId","taskId",…}` and the real finish arrives
 * later as `system/task_notification` carrying `tool_use_id` = the spawning call's id. A failed
 * spawn's result is `Error: …` with NO error flag on the wire (engine.ts drops the tool's `isError`).
 */
type Any = Record<string, unknown>;

const spawnBg = (id: string, input: Record<string, unknown> = {}) =>
  assistantToolUse(id, "Agent", { description: "inspect", prompt: "inspect the repo", subagent_type: "general-purpose", run_in_background: true, ...input });

const asyncLaunched = (id: string, taskId: string) =>
  toolResult(id, JSON.stringify({ status: "async_launched", agentId: `ag-${taskId}`, taskId, outputFile: `/tmp/${taskId}.output` }));

const sys = (subtype: string, over: Record<string, unknown>): ProtocolSdkMessage =>
  ({ type: "system", subtype, session_id: "be-1", uuid: `u-${subtype}-${String(over.task_id)}`, ...over } as unknown as ProtocolSdkMessage);

const taskStarted = (taskId: string, toolUseId: string | undefined, taskType = "agent") =>
  sys("task_started", { task_id: taskId, ...(toolUseId === undefined ? {} : { tool_use_id: toolUseId }), description: "inspect", task_type: taskType, is_backgrounded: true });

const taskNotification = (taskId: string, toolUseId: string | undefined, status: "completed" | "failed" | "stopped") =>
  sys("task_notification", { task_id: taskId, ...(toolUseId === undefined ? {} : { tool_use_id: toolUseId }), status, output_file: "/tmp/x", summary: `inspect (${status})` });

const threadEvents = (out: SessionEvent[], threadId: string) =>
  (out as unknown as Any[]).filter((e) => e.threadId === threadId && (e.type === "thread_started" || e.type === "thread_completed"));

describe("projector: a background (async-launched) subagent", () => {
  test("stays OPEN across its async_launched tool_result and closes on the terminal task_notification", () => {
    const { projector } = makeProjector();
    const out = run(projector, [
      init(), spawnBg("call_1"),
      taskStarted("t1", "call_1"),
      asyncLaunched("call_1", "t1"),
      result(),
    ], { pushAt: [0] });
    expect(threadEvents(out, "call_1").map((e) => e.type)).toEqual(["thread_started"]);
    // The spawning call's own tool_result is still an ordinary, successful main-thread row.
    expect((out as unknown as Any[]).find((e) => e.type === "tool_result")).toMatchObject({ callId: "call_1", isError: false });

    // The main turn is over; the background agent finishes later.
    const done = accept(projector, taskNotification("t1", "call_1", "completed")) as unknown as Any[];
    expect(done).toEqual([expect.objectContaining({ type: "thread_completed", threadId: "call_1", stopReason: "end_turn" })]);
    expect(SessionEvent.safeParse(done[0]).success).toBe(true);
    // A second terminal for the same task is a no-op.
    expect(accept(projector, taskNotification("t1", "call_1", "completed"))).toEqual([]);
  });

  test("a failed background agent closes as `error`, a stopped one as `aborted`", () => {
    const { projector } = makeProjector();
    run(projector, [init(), spawnBg("call_f"), spawnBg("call_s"), asyncLaunched("call_f", "tf"), asyncLaunched("call_s", "ts")]);
    expect(accept(projector, taskNotification("tf", "call_f", "failed"))).toEqual([
      expect.objectContaining({ type: "thread_completed", threadId: "call_f", stopReason: "error" }),
    ]);
    expect(accept(projector, taskNotification("ts", "call_s", "stopped"))).toEqual([
      expect.objectContaining({ type: "thread_completed", threadId: "call_s", stopReason: "aborted" }),
    ]);
  });

  test("correlates by the result's taskId when the terminal frame carries no tool_use_id", () => {
    const { projector } = makeProjector();
    run(projector, [init(), spawnBg("call_2"), asyncLaunched("call_2", "t2")]);
    expect(accept(projector, taskNotification("t2", undefined, "completed"))).toEqual([
      expect.objectContaining({ type: "thread_completed", threadId: "call_2", stopReason: "end_turn" }),
    ]);
  });

  test("a terminal task_updated patch (no tool_use_id) closes the thread via the task_started mapping; `killed` → aborted", () => {
    const { projector } = makeProjector();
    // `taskStarted` precedes the result on the wire (it is emitted during tool execution); the
    // result's own taskId would map it too — here the result names a DIFFERENT field set on purpose.
    run(projector, [init(), spawnBg("call_4"), taskStarted("t4", "call_4"), toolResult("call_4", JSON.stringify({ status: "async_launched", agentId: "a4" }))]);
    expect(accept(projector, sys("task_updated", { task_id: "t4", patch: { status: "running" } }))).toEqual([]);
    expect(accept(projector, sys("task_updated", { task_id: "t4", patch: { status: "killed" } }))).toEqual([
      expect.objectContaining({ type: "thread_completed", threadId: "call_4", stopReason: "aborted" }),
    ]);
  });

  test("the official leg: tool_use_result.status async_launched keeps the thread open; local_agent notification closes it", () => {
    const { projector } = makeProjector();
    const officialAsync = {
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "toolu_9", content: [{ type: "text", text: "Async agent launched successfully.\nagentId: a1 (internal ID)" }] }] },
      tool_use_result: { status: "async_launched", agentId: "a1", description: "inspect", prompt: "p", outputFile: "/tmp/a1" },
    } as unknown as ProtocolSdkMessage;
    const out = run(projector, [init(), assistantToolUse("toolu_9", "Agent", { description: "inspect", prompt: "p", run_in_background: true }), officialAsync]);
    expect(threadEvents(out, "toolu_9").map((e) => e.type)).toEqual(["thread_started"]);
    expect(accept(projector, sys("task_notification", { task_id: "b1", tool_use_id: "toolu_9", status: "completed", output_file: "/tmp/a1", summary: "done" }))).toEqual([
      expect.objectContaining({ type: "thread_completed", threadId: "toolu_9", stopReason: "end_turn" }),
    ]);
  });

  test("the official leg's rendered text alone (no tool_use_result) is still recognised as async", () => {
    const { projector } = makeProjector();
    const out = run(projector, [
      init(), assistantToolUse("toolu_8", "Agent", { description: "d", prompt: "p", run_in_background: true }),
      toolResult("toolu_8", [{ type: "text", text: "Async agent launched successfully.\nagentId: a2" }]),
    ]);
    expect(threadEvents(out, "toolu_8").map((e) => e.type)).toEqual(["thread_started"]);
  });

  test("a FOREGROUND agent's late task_notification (CC emits one for sync agents too) projects nothing extra", () => {
    const { projector } = makeProjector();
    const out = run(projector, [
      init(), assistantToolUse("toolu_7", "Agent", { description: "d", prompt: "p" }),
      toolResult("toolu_7", [{ type: "text", text: "the report" }]),
    ]);
    expect(threadEvents(out, "toolu_7").map((e) => e.type)).toEqual(["thread_started", "thread_completed"]);
    expect(accept(projector, sys("task_notification", { task_id: "b7", tool_use_id: "toolu_7", status: "completed", output_file: "/x", summary: "s" }))).toEqual([]);
  });

  test("replay: a second projector over the same checkpoints duplicates no thread_completed", () => {
    const checkpoint = new FakeCheckpoints();
    const stream = [init(), spawnBg("call_r"), asyncLaunched("call_r", "tr"), taskNotification("tr", "call_r", "completed")];
    const first = run(makeProjector({ checkpoint }).projector, stream);
    expect(first.filter((e) => e.type === "thread_completed")).toHaveLength(1);
    const second = run(makeProjector({ checkpoint }).projector, stream);
    expect(second.filter((e) => e.type === "thread_completed")).toHaveLength(0);
  });
});

describe("projector: a spawn that failed immediately", () => {
  test("an `Error:` result with no error flag (the SDK drops it) closes the thread as `error` and marks the tool_result", () => {
    const { projector } = makeProjector();
    const out = run(projector, [
      init(), spawnBg("call_e"),
      toolResult("call_e", 'Error: unknown subagent_type "general" -- no AgentDefinition by that name was found.'),
    ]) as unknown as Any[];
    expect(out.find((e) => e.type === "tool_result")).toMatchObject({ callId: "call_e", isError: true });
    expect(out.find((e) => e.type === "thread_completed")).toMatchObject({ threadId: "call_e", stopReason: "error" });
  });

  test("the engine's own `error: true` spelling is an error, for any tool, and closes a spawn as `error`", () => {
    const { projector } = makeProjector();
    const out = run(projector, [
      init(), assistantToolUse("call_x", "Read", { file_path: "/x" }), toolResult("call_x", "[error: boom]", { error: true }),
      spawnBg("call_y"), toolResult("call_y", "[error: boom]", { error: true }),
    ]) as unknown as Any[];
    expect(out.filter((e) => e.type === "tool_result").map((e) => e.isError)).toEqual([true, true]);
    expect(out.find((e) => e.type === "thread_completed")).toMatchObject({ threadId: "call_y", stopReason: "error" });
  });

  test("a NON-spawn tool whose output merely starts with `Error:` is not reclassified", () => {
    const { projector } = makeProjector();
    const out = run(projector, [
      init(), assistantToolUse("call_g", "Grep", { pattern: "Error:" }), toolResult("call_g", "Error: this is a matched line"),
    ]) as unknown as Any[];
    expect(out.find((e) => e.type === "tool_result")).toMatchObject({ isError: false });
  });

  test("an interrupted spawn closes as `aborted`", () => {
    const { projector } = makeProjector();
    const out = run(projector, [init(), spawnBg("call_i"), toolResult("call_i", "[interrupted]", { interrupted: true })]) as unknown as Any[];
    expect(out.find((e) => e.type === "thread_completed")).toMatchObject({ stopReason: "aborted" });
  });
});

describe("projector: background-task frames never feed the to-do list", () => {
  test("agent, bash and workflow task frames produce no task_updated, and task.list stays to-do-only", () => {
    const { projector } = makeProjector();
    const frames = [
      init(),
      taskStarted("tb", undefined, "bash"),
      sys("task_updated", { task_id: "tb", patch: { status: "running" } }),
      sys("task_updated", { task_id: "tb", patch: { status: "failed", error: "exit 1" } }),
      taskNotification("tb", undefined, "failed"),
      taskStarted("tw", undefined, "workflow"),
      taskNotification("tw", undefined, "completed"),
      taskStarted("ta", "call_unknown", "agent"),
      taskNotification("ta", "call_unknown", "completed"),
      sys("task_progress", { task_id: "ta", description: "d", usage: {} }),
      assistantToolUse("c1", "TaskCreate", { subject: "Write tests", description: "d" }),
      toolResult("c1", JSON.stringify({ task: { id: "1", subject: "Write tests" } })),
    ];
    const out = run(projector, frames);
    const todos = out.filter((e) => e.type === "task_updated") as unknown as Any[];
    expect(todos.map((e) => (e.task as Any).id)).toEqual(["1"]);
    expect(tasksFromEvents(out).map((t) => t.id)).toEqual(["1"]);
  });
});
