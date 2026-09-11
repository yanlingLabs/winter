import { describe, expect, test } from "bun:test";
import { MAIN_THREAD, TASK_STATUS_MAP, isSpawnTool } from "../../src/projector";
import { assistantText, assistantToolUse, init, makeProjector, result, run, textDelta, toolResult } from "./harness";

type Any = Record<string, unknown>;
const spawn = (id: string, input: Record<string, unknown> = {}) =>
  assistantToolUse(id, "Agent", { description: "summarise", prompt: "summarise the note", subagent_type: "general-purpose", ...input });

const taskFrame = (subtype: string, over: Record<string, unknown>) =>
  ({ type: "system", subtype, session_id: "be-1", uuid: `u-${subtype}`, ...over } as never);

describe("projector/children: a spawned subagent's thread", () => {
  test("a spawning tool_use opens a child thread — tool_call first, then thread_started", () => {
    const { projector } = makeProjector();
    projector.accept(init());
    const out = projector.accept(spawn("toolu_03")) as unknown as Any[];
    expect(out.map((e) => e.type)).toEqual(["tool_call", "thread_started"]);
    expect(out[0]).toMatchObject({ threadId: MAIN_THREAD, name: "spawn_agent", callId: "toolu_03" });
    expect(out[1]).toMatchObject({
      type: "thread_started", threadId: "toolu_03", parentThreadId: MAIN_THREAD,
      agentType: "general-purpose", prompt: "summarise the note", description: "summarise",
    });
  });

  test("the child's threadId IS the spawning tool_use id — the same id its tool_result carries", () => {
    // This is what lets thread_started and thread_completed be derived from one identifier with no
    // registry lookup and no host round-trip.
    const { projector } = makeProjector();
    projector.accept(init());
    projector.accept(spawn("toolu_03"));
    const out = projector.accept(toolResult("toolu_03", "child final report")) as unknown as Any[];
    expect(out.map((e) => e.type)).toEqual(["tool_result", "thread_completed"]);
    expect(out[1]).toMatchObject({ type: "thread_completed", threadId: "toolu_03", stopReason: "end_turn" });
  });

  test("a failed child terminal is `error`; an interrupted one is `aborted`, never `error`", () => {
    for (const [block, stopReason] of [
      [{ is_error: true }, "error"],
      [{ denied: true }, "error"],
      [{ interrupted: true }, "aborted"],
    ] as Array<[Record<string, unknown>, string]>) {
      const { projector } = makeProjector();
      projector.accept(spawn("toolu_03"));
      const out = projector.accept(toolResult("toolu_03", "x", block)) as unknown as Any[];
      expect(out.find((e) => e.type === "thread_completed")).toMatchObject({ stopReason });
    }
  });

  test("a tool_result for a call that is NOT a child produces no thread_completed", () => {
    const { projector } = makeProjector();
    projector.accept(assistantToolUse("toolu_01", "Read", {}));
    const out = projector.accept(toolResult("toolu_01", "contents")) as unknown as Any[];
    expect(out.map((e) => e.type)).toEqual(["tool_result"]);
  });

  test("a child is opened ONCE — a repeated spawn block never re-opens the same thread", () => {
    const { projector } = makeProjector();
    projector.accept(spawn("toolu_03"));
    const again = projector.accept(spawn("toolu_03")) as unknown as Any[];
    expect(again.filter((e) => e.type === "thread_started")).toEqual([]);
  });

  test("a spawn with no subagent_type falls back to `general-purpose`, matching the engine's golden", () => {
    const { projector } = makeProjector();
    const out = projector.accept(assistantToolUse("toolu_03", "Agent", { prompt: "do it", description: "d" })) as unknown as Any[];
    expect(out[1]).toMatchObject({ agentType: "general-purpose" });
  });

  test("`Agent`, `Task` and the projected Norma name all count as spawning tools", () => {
    expect(isSpawnTool("Agent")).toBe(true);
    expect(isSpawnTool("Task")).toBe(true);
    expect(isSpawnTool("spawn_agent")).toBe(true);
    expect(isSpawnTool("Read")).toBe(false);
  });

  test("DEFAULT wire shape (forwardSubagentText OFF): the child's tool work rides its threadId, its text does not arrive at all", () => {
    const { projector } = makeProjector();
    const out = run(projector, [
      init(),
      spawn("toolu_03"),
      assistantToolUse("toolu_04", "Read", { file_path: "note.txt" }, "toolu_03"),
      toolResult("toolu_04", "contents", {}, "toolu_03"),
      toolResult("toolu_03", "child final report"),
      assistantText("The child reported back."),
      result(),
    ]) as unknown as Any[];
    const child = out.filter((e) => e.threadId === "toolu_03");
    expect(child.map((e) => e.type)).toEqual(["thread_started", "tool_call", "tool_result", "thread_completed"]);
    // its own words are simply not on the wire in this shape
    expect(child.some((e) => e.type === "assistant_message")).toBe(false);
  });

  test("forwardSubagentText ON: the child's own assistant_message and assistant_delta arrive, scoped by threadId", () => {
    const { projector } = makeProjector();
    const out = run(projector, [
      init(),
      spawn("toolu_03"),
      textDelta("child final report", "toolu_03"),
      assistantText("child final report", "toolu_03"),
      toolResult("toolu_03", "child final report"),
      result(),
    ]) as unknown as Any[];
    const child = out.filter((e) => e.threadId === "toolu_03");
    expect(child.map((e) => e.type)).toEqual(["thread_started", "assistant_delta", "assistant_message", "thread_completed"]);
    expect(child[2]).toMatchObject({ text: "child final report" });
  });

  test("child frames never contaminate the main thread's own sequence", () => {
    const { projector } = makeProjector();
    const out = run(projector, [
      init(), spawn("toolu_03"),
      assistantText("child says hi", "toolu_03"),
      toolResult("toolu_03", "done"),
      assistantText("back on main"),
      result(),
    ]) as unknown as Any[];
    expect(out.filter((e) => e.threadId === MAIN_THREAD).map((e) => e.type))
      .toEqual(["tool_call", "tool_result", "assistant_message", "turn_completed"]);
  });
});

describe("projector/children: Winter's task graph → task_updated", () => {
  test("THE STATUS MAP, pinned — six Winter values onto Norma's four", () => {
    expect(TASK_STATUS_MAP).toEqual({
      pending: "pending",
      running: "in_progress",
      paused: "pending",
      completed: "completed",
      failed: "completed",
      killed: "deleted",
    });
  });

  test("a task_started seeds the row, persists nothing itself, and a later patch carries its subject", () => {
    const { projector } = makeProjector();
    expect(projector.accept(taskFrame("task_started", { task_id: "t1", description: "write the report" }))).toEqual([]);
    const out = projector.accept(taskFrame("task_updated", { task_id: "t1", patch: { status: "running" } })) as unknown as Any[];
    expect(out.map((e) => e.type)).toEqual(["task_updated"]);
    expect(out[0]!.task).toMatchObject({ id: "t1", subject: "write the report", status: "in_progress" });
  });

  test("a patch for a row nobody seeded still produces a schema-valid event, labelled by its id", () => {
    // `TaskSchema.subject` is z.string().min(1); an event that fails the schema is worse than a row
    // labelled by its task id.
    const { projector } = makeProjector();
    const out = projector.accept(taskFrame("task_updated", { task_id: "t9", patch: { status: "pending" } })) as unknown as Any[];
    expect(out[0]!.task).toMatchObject({ id: "t9", subject: "t9", status: "pending" });
  });

  test("`failed` is LOSSY: it renders completed, with the true status preserved in metadata", () => {
    // Norma's status enum has no failure state and P8b-21 forbids widening it this phase. The
    // alternatives are worse: `deleted` makes the row vanish, and projecting nothing strands it at
    // in_progress forever. Flagged in the task report as a protocol change for a later phase.
    const { projector } = makeProjector();
    const out = projector.accept(taskFrame("task_updated", { task_id: "t1", patch: { status: "failed", error: "the tool exited 1" } })) as unknown as Any[];
    expect(out[0]!.task).toMatchObject({ status: "completed", metadata: { winterStatus: "failed", winterError: "the tool exited 1" } });
  });

  test("`killed` removes the row (status deleted), with the true status in metadata", () => {
    const { projector } = makeProjector();
    const out = projector.accept(taskFrame("task_updated", { task_id: "t1", patch: { status: "killed" } })) as unknown as Any[];
    expect(out[0]!.task).toMatchObject({ status: "deleted", metadata: { winterStatus: "killed" } });
  });

  test("a task_notification's `stopped` is the patch vocabulary's `killed` under another name", () => {
    const { projector } = makeProjector();
    const out = projector.accept(taskFrame("task_notification", { task_id: "t1", status: "stopped", summary: "cancelled", output_file: "/tmp/x" })) as unknown as Any[];
    expect(out[0]!.task).toMatchObject({ status: "deleted", subject: "cancelled" });
  });

  test("a patch that says nothing projectable produces nothing", () => {
    const { projector } = makeProjector();
    expect(projector.accept(taskFrame("task_updated", { task_id: "t1", patch: { total_paused_ms: 5 } }))).toEqual([]);
  });

  test("task_progress, background_tasks_changed and local_command_output persist nothing", () => {
    const { projector } = makeProjector();
    expect(projector.accept(taskFrame("task_progress", { task_id: "t1", description: "d", usage: {} }))).toEqual([]);
    expect(projector.accept(taskFrame("background_tasks_changed", { tasks: [] }))).toEqual([]);
    expect(projector.accept(taskFrame("local_command_output", { content: "x" }))).toEqual([]);
  });

  test("every task event is MAIN-thread scoped — the task graph is the session's, not a thread's", () => {
    const { projector } = makeProjector();
    const out = projector.accept(taskFrame("task_updated", { task_id: "t1", patch: { status: "running" } })) as unknown as Any[];
    expect(out[0]).toMatchObject({ threadId: MAIN_THREAD });
  });
});
