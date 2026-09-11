import { expect, test } from "bun:test";
import type { SessionEvent } from "@norma/protocol";
import { readWinterTasks, tasksFromEvents, type TaskEventSource } from "../../src/runtime-sdk/tasks-reader";

const SESSION = "s_tasks_test";

function taskUpdated(seq: number, task: { id: string; subject: string; status: "pending" | "in_progress" | "completed" | "deleted"; activeForm?: string }): SessionEvent {
  return { type: "task_updated", sessionId: SESSION, threadId: "main", seq, ts: 1_700_000_000_000 + seq, task } as SessionEvent;
}

test("tasksFromEvents folds task_updated rows to their LATEST state, one per id", () => {
  const events = [
    taskUpdated(1, { id: "1", subject: "write the plan", status: "pending" }),
    taskUpdated(2, { id: "2", subject: "implement it", status: "pending" }),
    taskUpdated(3, { id: "1", subject: "write the plan", status: "in_progress" }),
    taskUpdated(4, { id: "1", subject: "write the plan", status: "completed" }),
  ];
  const tasks = tasksFromEvents(events);
  expect(tasks).toEqual([
    { id: "1", subject: "write the plan", status: "completed" },
    { id: "2", subject: "implement it", status: "pending" },
  ]);
});

test("a task whose latest status is \"deleted\" is excluded from the result (terminal, no tombstone)", () => {
  const events = [
    taskUpdated(1, { id: "1", subject: "write the plan", status: "pending" }),
    taskUpdated(2, { id: "2", subject: "implement it", status: "pending" }),
    taskUpdated(3, { id: "1", subject: "write the plan", status: "deleted" }),
  ];
  expect(tasksFromEvents(events)).toEqual([{ id: "2", subject: "implement it", status: "pending" }]);
});

test("non-task_updated events are ignored", () => {
  const events: SessionEvent[] = [
    { type: "user_message", sessionId: SESSION, threadId: "main", seq: 1, ts: 1, text: "hi", clientName: "cli" } as SessionEvent,
    taskUpdated(2, { id: "1", subject: "write the plan", status: "pending" }),
    { type: "turn_completed", sessionId: SESSION, threadId: "main", seq: 3, ts: 3, stopReason: "end_turn", inputTokens: 1, outputTokens: 1 } as SessionEvent,
  ];
  expect(tasksFromEvents(events)).toEqual([{ id: "1", subject: "write the plan", status: "pending" }]);
});

test("an empty log yields an empty list", () => {
  expect(tasksFromEvents([])).toEqual([]);
});

test("insertion order is preserved by first-seen id — an unrelated later update does not reorder the list", () => {
  const events = [
    taskUpdated(1, { id: "2", subject: "b", status: "pending" }),
    taskUpdated(2, { id: "1", subject: "a", status: "pending" }),
    taskUpdated(3, { id: "2", subject: "b", status: "in_progress" }),
  ];
  expect(tasksFromEvents(events).map((t) => t.id)).toEqual(["2", "1"]);
});

test("readWinterTasks reads the store's full log (fromSeq 0) and folds it", () => {
  const store: TaskEventSource = {
    read: (sessionId, fromSeq) => {
      expect(sessionId).toBe(SESSION);
      expect(fromSeq).toBe(0);
      return [taskUpdated(1, { id: "1", subject: "write the plan", status: "pending" })];
    },
  };
  expect(readWinterTasks(store, SESSION)).toEqual([{ id: "1", subject: "write the plan", status: "pending" }]);
});
