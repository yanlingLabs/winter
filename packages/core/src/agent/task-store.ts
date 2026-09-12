import type { Task } from "@winter/protocol";

/** Session-scoped agent task lists. Engine-memory (same lifecycle as loadedSkills) — the
 *  task_updated events are persisted for harness replay; the store itself is not (deferred).
 *
 *  Task descriptions (4g-ii, CC parity): @winter/protocol's `Task` has no `description` field
 *  (only id/subject/status/activeForm), and this task deliberately does NOT touch
 *  packages/protocol (a zero-fixture-drift constraint for this phase). So descriptions are kept
 *  in a SEPARATE per-session map here, core-side only — never merged into the `Task` objects
 *  returned by list()/create() or handed to `ctx.taskEvent`, which stay byte-identical to the
 *  wire `Task` shape (task.list's RPC response and the task_updated event's `task` field are
 *  UNCHANGED). The task_get tool (tools/tasks.ts, Phase 4g Task 4) composes `get()` +
 *  `descriptionOf()` to surface the description back to the model. */
export class TaskStore {
  private sessions = new Map<string, Map<string, Task>>();
  private descriptions = new Map<string, Map<string, string>>();

  private forSession(sessionId: string): Map<string, Task> {
    let m = this.sessions.get(sessionId);
    if (!m) { m = new Map(); this.sessions.set(sessionId, m); }
    return m;
  }

  private descFor(sessionId: string): Map<string, string> {
    let m = this.descriptions.get(sessionId);
    if (!m) { m = new Map(); this.descriptions.set(sessionId, m); }
    return m;
  }

  create(sessionId: string, subject: string, description: string, activeForm?: string): Task {
    const m = this.forSession(sessionId);
    const task: Task = { id: String(m.size + 1), subject, status: "pending", ...(activeForm ? { activeForm } : {}) };
    m.set(task.id, task);
    this.descFor(sessionId).set(task.id, description);
    return task;
  }

  /** Patch shape widened to every patchable Task field (4h-ii-d, CC parity: owner/blocks/
   *  blockedBy/metadata joined status/subject/activeForm) — `Partial<Omit<Task, "id">>` tracks
   *  @winter/protocol's `Task` automatically, so a future protocol-side field needs no store change.
   *  The store itself still just shallow-merges the patch onto the existing task (`{...t, ...patch}`);
   *  the addBlocks/addBlockedBy append+dedupe and metadata shallow-merge computation happens in the
   *  TOOL (tools/tasks.ts's task_update), which reads the current task via `get()`, computes the
   *  new full arrays/object, and passes them here as a plain "set" patch. */
  update(sessionId: string, id: string, patch: Partial<Omit<Task, "id">>): Task | undefined {
    const m = this.forSession(sessionId);
    const t = m.get(id);
    if (!t) return undefined;
    const next: Task = { ...t, ...patch };
    m.set(id, next);
    return next;
  }

  /** Terminal removal from the store's live map (the tool caller — tasks.ts's task_update
   *  "deleted" branch — emits a task_updated event with `status: "deleted"` via `update()` BEFORE
   *  calling this, so live task views see the removal on the wire; T3 review fix wave 1,
   *  @winter/protocol's Task.status enum now has a "deleted" value). This method itself still just
   *  drops the id from the map/description store — no event, no return value beyond the
   *  existed/didn't-exist boolean. Returns false (no-op) if the id doesn't exist. */
  delete(sessionId: string, id: string): boolean {
    const existed = this.forSession(sessionId).delete(id);
    this.descFor(sessionId).delete(id);
    return existed;
  }

  list(sessionId: string): Task[] { return [...this.forSession(sessionId).values()]; }

  /** Single-task lookup backing the task_get tool (4g Task 4) — same wire shape as list()/
   *  create() (id/subject/status/activeForm, no description). undefined for an unknown id or
   *  session. */
  get(sessionId: string, id: string): Task | undefined {
    return this.forSession(sessionId).get(id);
  }

  /** Core-side-only description lookup — see the class doc comment. undefined if the task was
   *  never created with one (shouldn't happen post-4g-ii: task_create requires it) or has since
   *  been deleted. */
  descriptionOf(sessionId: string, id: string): string | undefined {
    return this.descFor(sessionId).get(id);
  }
}
