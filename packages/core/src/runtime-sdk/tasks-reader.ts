import type { SessionEvent, Task } from "@yanlinglabs/winter-protocol";

/**
 * `task.list` over the Winter leg (P8c-11, Task 2.3).
 *
 * ── WHY THIS IS NOT A FILE READER, DESPITE THE BRIEF'S NAME FOR THIS FILE ───────────────────────
 *
 * The brief's premise was "read the child's task files under the session temp dir
 * (`<tmpDir>/tasks/*.json`)". Checked directly against the `winter-agent-sdk` checkout
 * (`packages/runtime/src/tools/task-graph-store.ts`, the store behind `TaskCreate`/`TaskUpdate`/
 * `TaskList`/`TaskGet`): the task graph is a **module-level, in-memory `Map<sessionId,
 * Map<taskId, TaskGraphRow>>` inside the CHILD PROCESS**. There is no file — not under the
 * session's temp dir, not under its project dot-dir, nowhere. (`TodoWrite`'s own list is the same
 * shape, a `Map<sessionId, Todo[]>` — also in-memory, also child-local, and in any case the wrong
 * tool: `task.list`'s wire shape is `{tasks: Task[]}` using the SAME `TaskSchema` `task_updated`
 * carries, which is the task-graph family, not `TodoWrite`.) So there is no file shape to confirm,
 * and a reader built around one would always return `[]`.
 *
 * What the daemon actually has is the WIRE record of that graph: every `TaskCreate`/`TaskUpdate`
 * call surfaces as a `system/task_started` / `system/task_updated` message, which the projector
 * (already, since 8b Task 11 — see `projector/index.ts`'s `acceptTaskFrame`) turns into a
 * `task_updated` `SessionEvent` carrying the full `Task` row. That event is PERSISTED
 * (`event-coverage.ts`: `task_updated: true` in both maps) — so the session's own store already
 * holds a durable, replayable history of every task mutation, with no dependency on the child
 * process still being alive (P8c-11: "the child's own effects are not relied upon — a child dies
 * at idle"). Folding that history to its latest state per task id is `task.list`'s answer.
 *
 * `status: "deleted"` is TERMINAL (`TaskSchema`'s own doc comment: "no event ever transitions a
 * task OUT of deleted") and is filtered out of the returned list — mirroring the retired engine's
 * `TaskStore.delete()`, which removed the id from its live map outright rather than keeping a
 * tombstone entry that `list()` would echo back.
 */

/** The structural subset `tasksFromEvents`/`readWinterTasks` need from `SessionStore` — narrowed
 *  so this module can be unit-tested with a plain array, and so it never depends on the concrete
 *  store class for a read this simple. */
export interface TaskEventSource {
  read(sessionId: string, fromSeq?: number): readonly SessionEvent[];
}

/**
 * Fold a session's persisted `task_updated` events into the current `Task[]`, latest row per id,
 * insertion order (first-seen id keeps its position — matches `TaskStore.list()`'s own Map-order
 * semantics, so a task's position in the list does not jump on every unrelated update).
 * `status: "deleted"` rows are excluded from the result (see the module doc comment).
 */
export function tasksFromEvents(events: readonly SessionEvent[]): Task[] {
  const byId = new Map<string, Task>();
  for (const e of events) {
    if (e.type !== "task_updated") continue;
    byId.set(e.task.id, e.task);
  }
  return [...byId.values()].filter((t) => t.status !== "deleted");
}

/** Convenience wrapper reading a session's FULL log and folding it — what `ipc/server.ts`'s
 *  `task.list` case calls when the session is on the Winter leg. A full-log read is acceptable
 *  here for the same reason `ipc/server.ts` already does one for `session_created` elsewhere
 *  (`store.read(sessionId, 0)[0]`): `task.list` is a low-frequency, human-triggered call, not a hot
 *  path, and `task_updated` rows are a small fraction of any session's log. */
export function readWinterTasks(store: TaskEventSource, sessionId: string): Task[] {
  return tasksFromEvents(store.read(sessionId, 0));
}
