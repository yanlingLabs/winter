import { describe, expect, test } from "bun:test";
import { MAIN_THREAD, isTodoTool } from "../../src/projector";
import { tasksFromEvents } from "../../src/runtime-sdk/tasks-reader";
import { FakeCheckpoints, assistantToolUse, init, makeProjector, run, toolResult } from "./harness";

/**
 * `TaskCreate`/`TaskUpdate` synthesize `task_updated` from the CALL, not from any wire frame — the
 * SDK's to-do store puts nothing on the wire (`children.ts`'s module doc). These builders mirror the
 * pinned executor shapes measured against a real session (`~/.winter-dev/sessions/global/
 * s_98250c036992.jsonl`) and `tools/impl/task-graph.ts`'s own T8 notes.
 */
const create = (id: string, subject: string, description: string, activeForm?: string) =>
  assistantToolUse(id, "TaskCreate", { subject, description, ...(activeForm !== undefined ? { activeForm } : {}) });

const createResult = (id: string, taskId: string, subject: string) =>
  toolResult(id, JSON.stringify({ task: { id: taskId, subject } }));

const createErrorResult = (id: string, message: string) =>
  toolResult(id, `Error: ${message}`, { is_error: true });

const update = (id: string, taskId: string, patch: Record<string, unknown>) =>
  assistantToolUse(id, "TaskUpdate", { taskId, ...patch });

const updateSuccessResult = (id: string, taskId: string, updatedFields: string[], statusChange?: { from: string; to: string }) =>
  toolResult(id, JSON.stringify({ success: true, taskId, updatedFields, ...(statusChange !== undefined ? { statusChange } : {}) }));

const updateFailResult = (id: string, taskId: string, error: string) =>
  toolResult(id, JSON.stringify({ success: false, taskId, updatedFields: [], error }));

describe("projector: the to-do list (TaskCreate/TaskUpdate) → task_updated", () => {
  test("`TaskCreate` and `TaskUpdate` are recognised, `Read` is not", () => {
    expect(isTodoTool("TaskCreate")).toBe(true);
    expect(isTodoTool("TaskUpdate")).toBe(true);
    expect(isTodoTool("Read")).toBe(false);
  });

  test("a TaskCreate call + success result → exactly one task_updated, pending, carrying activeForm", () => {
    const { projector } = makeProjector();
    const out = run(projector, [
      init(),
      create("toolu_01", "Define objectives", "Clarify the goal, outcomes and success criteria.", "Defining objectives"),
      createResult("toolu_01", "216ba54a-adaf-4b1b-b96a-8485539e0186", "Define objectives"),
    ]);
    const events = out.filter((e) => e.type === "task_updated");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "task_updated", sessionId: "s_test", threadId: MAIN_THREAD,
      task: { id: "216ba54a-adaf-4b1b-b96a-8485539e0186", subject: "Define objectives", status: "pending", activeForm: "Defining objectives" },
    });
  });

  test("a TaskCreate with no activeForm omits it — never a blank string", () => {
    const { projector } = makeProjector();
    const out = run(projector, [init(), create("toolu_01", "Define objectives", "d"), createResult("toolu_01", "t-1", "Define objectives")]);
    const ev = out.find((e) => e.type === "task_updated");
    expect(ev?.task).toEqual({ id: "t-1", subject: "Define objectives", status: "pending" });
  });

  test("a following TaskUpdate status:in_progress → a second task_updated reflecting it", () => {
    const { projector } = makeProjector();
    const out = run(projector, [
      init(),
      create("toolu_01", "Define objectives", "d", "Defining objectives"),
      createResult("toolu_01", "t-1", "Define objectives"),
      update("toolu_02", "t-1", { status: "in_progress" }),
      updateSuccessResult("toolu_02", "t-1", ["status"], { from: "pending", to: "in_progress" }),
    ]);
    const events = out.filter((e) => e.type === "task_updated");
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({
      task: { id: "t-1", subject: "Define objectives", status: "in_progress", activeForm: "Defining objectives" },
    });
  });

  test("a TaskUpdate that changes subject/activeForm merges them onto the tracked row", () => {
    const { projector } = makeProjector();
    const out = run(projector, [
      init(),
      create("toolu_01", "Define objectives", "d", "Defining objectives"),
      createResult("toolu_01", "t-1", "Define objectives"),
      update("toolu_02", "t-1", { subject: "Define the objectives", activeForm: "Refining objectives" }),
      updateSuccessResult("toolu_02", "t-1", ["subject", "activeForm"]),
    ]);
    const events = out.filter((e) => e.type === "task_updated");
    expect(events[1]).toMatchObject({ task: { id: "t-1", subject: "Define the objectives", activeForm: "Refining objectives", status: "pending" } });
  });

  test("status:\"deleted\" passes straight through, unmapped (no lossy fold, unlike the background-task graph)", () => {
    const { projector } = makeProjector();
    const out = run(projector, [
      init(),
      create("toolu_01", "Define objectives", "d"),
      createResult("toolu_01", "t-1", "Define objectives"),
      update("toolu_02", "t-1", { status: "deleted" }),
      updateSuccessResult("toolu_02", "t-1", ["status"], { from: "pending", to: "deleted" }),
    ]);
    const events = out.filter((e) => e.type === "task_updated");
    expect(events[1]).toMatchObject({ task: { id: "t-1", status: "deleted" } });
  });

  test("a failed (isError) TaskCreate result emits no task_updated", () => {
    const { projector } = makeProjector();
    const out = run(projector, [init(), create("toolu_01", "", "d"), createErrorResult("toolu_01", "subject must be a non-empty string")]);
    expect(out.filter((e) => e.type === "task_updated")).toEqual([]);
  });

  test("a TaskUpdate domain failure (success:false inside a non-error result) emits no task_updated", () => {
    const { projector } = makeProjector();
    const out = run(projector, [
      init(),
      create("toolu_01", "Define objectives", "d"),
      createResult("toolu_01", "t-1", "Define objectives"),
      update("toolu_02", "unknown-id", { status: "completed" }),
      updateFailResult("toolu_02", "unknown-id", "no such task: unknown-id"),
    ]);
    const events = out.filter((e) => e.type === "task_updated");
    expect(events).toHaveLength(1); // only the create
  });

  test("an UNTRACKED TaskUpdate (no subject anywhere) is skipped, not fabricated, and it says so", () => {
    const { projector, debugs } = makeProjector();
    const out = run(projector, [init(), update("toolu_09", "never-created", { status: "completed" }), updateSuccessResult("toolu_09", "never-created", ["status"])]);
    expect(out.filter((e) => e.type === "task_updated")).toEqual([]);
    expect(debugs.join(" ")).toContain("untracked row");
  });

  test("a TaskUpdate after a respawn resolves against the session's persisted rows (priorTodos)", () => {
    let reads = 0;
    const { projector } = makeProjector({
      priorTodos: () => { reads++; return [{ id: "t-1", subject: "Define objectives", status: "pending", activeForm: "Defining objectives" }]; },
    });
    const out = run(projector, [
      init(),
      update("toolu_02", "t-1", { status: "in_progress" }),
      updateSuccessResult("toolu_02", "t-1", ["status"], { from: "pending", to: "in_progress" }),
      update("toolu_03", "t-1", { status: "completed" }),
      updateSuccessResult("toolu_03", "t-1", ["status"], { from: "in_progress", to: "completed" }),
    ]);
    const events = out.filter((e) => e.type === "task_updated");
    expect(events.map((e) => e.task.status)).toEqual(["in_progress", "completed"]);
    expect(events[0]?.task).toMatchObject({ subject: "Define objectives", activeForm: "Defining objectives" });
    expect(reads).toBe(1);
  });

  test("a throwing priorTodos read degrades to the empty map, never breaks the fold", () => {
    const { projector, warnings } = makeProjector({ priorTodos: () => { throw new Error("store gone"); } });
    const out = run(projector, [init(), create("toolu_01", "S", "d"), createResult("toolu_01", "t-9", "S")]);
    expect(out.filter((e) => e.type === "task_updated")).toHaveLength(1);
    expect(warnings.join(" ")).toContain("could not seed prior to-do rows");
  });

  test("a call that is not TaskCreate/TaskUpdate is left alone entirely", () => {
    const { projector } = makeProjector();
    const out = run(projector, [init(), assistantToolUse("toolu_01", "Read", { file_path: "x" }), toolResult("toolu_01", "contents")]);
    expect(out.filter((e) => e.type === "task_updated")).toEqual([]);
  });

  test("replaying the same TaskCreate/TaskUpdate frames twice produces no duplicate task_updated", () => {
    const checkpoints = new FakeCheckpoints();
    const stream = [
      init(),
      create("toolu_01", "Define objectives", "d", "Defining objectives"),
      createResult("toolu_01", "t-1", "Define objectives"),
      update("toolu_02", "t-1", { status: "in_progress" }),
      updateSuccessResult("toolu_02", "t-1", ["status"], { from: "pending", to: "in_progress" }),
    ];
    const first = makeProjector({ checkpoint: checkpoints });
    const firstOut = run(first.projector, stream);
    expect(firstOut.filter((e) => e.type === "task_updated")).toHaveLength(2);

    // A fresh projector over the SAME checkpoint store is what a recovery re-read looks like — the
    // exact shape idempotency.test.ts already pins for tool_call/tool_result/terminal.
    const second = makeProjector({ checkpoint: checkpoints });
    const secondOut = run(second.projector, stream);
    expect(secondOut.filter((e) => e.type === "task_updated")).toEqual([]);
  });

  test("a to-do row's threadId is always MAIN — the to-do list is session-wide, not a thread's", () => {
    const { projector } = makeProjector();
    const out = run(projector, [init(), create("toolu_01", "Define objectives", "d"), createResult("toolu_01", "t-1", "Define objectives")]);
    const created = out.find((e) => e.type === "task_updated");
    expect(created).toMatchObject({ threadId: MAIN_THREAD });
  });

  test("readWinterTasks/task.list sees the synthesized row through the ordinary task_updated fold", () => {
    // `tasksFromEvents` (`runtime-sdk/tasks-reader.ts`) is what `ipc/server.ts`'s `task.list` folds
    // a session's persisted log through — it has no idea whether a `task_updated` came from a
    // TaskCreate/TaskUpdate call or a background-task frame, which is exactly the point: once the
    // event exists, the rest of the to-do pipeline (this projector's whole reason for existing) just
    // works.
    const { projector } = makeProjector();
    const out = run(projector, [
      init(),
      create("toolu_01", "Define objectives", "d", "Defining objectives"),
      createResult("toolu_01", "t-1", "Define objectives"),
      update("toolu_02", "t-1", { status: "completed" }),
      updateSuccessResult("toolu_02", "t-1", ["status"], { from: "pending", to: "completed" }),
    ]);
    expect(tasksFromEvents(out)).toEqual([{ id: "t-1", subject: "Define objectives", status: "completed", activeForm: "Defining objectives" }]);
  });
});
