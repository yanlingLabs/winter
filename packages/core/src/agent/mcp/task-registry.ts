/**
 * McpTaskRegistry — pure state tracker for in-flight MCP tasks (protocol revision 2025-11-25's
 * experimental `tasks` primitive), the third sibling of BackgroundTaskRegistry (bg-registry.ts,
 * backgrounded bash) and BackgroundAgentRegistry (bg-agent-registry.ts, detached subagents).
 *
 * Deliberately mirrors bg-agent-registry's shape: lifecycle only, no I/O, no spawning. The SDK's
 * callToolStream generator drives progress; this file only records where a task got to and who
 * still owes a notification for it.
 *
 * Map-backed, never throws: every method is a total function over whatever state exists (unknown
 * keys are no-ops / undefined, never errors) — the same contract bg-agent-registry documents.
 *
 * KEYING: `${server}:${taskId}`. A taskId is only unique WITHIN one server, so two servers can
 * legitimately both hand out "1" — hence the composite key rather than the bare id.
 */
export type McpTaskStatus = "running" | "completed" | "failed" | "cancelled";

export interface McpTaskEntry {
  key: string;
  sessionId: string;
  server: string;
  tool: string;
  taskId: string;
  status: McpTaskStatus;
  /** Server-authored. UNTRUSTED — every consumer must sanitize before persisting it. */
  result?: string;
  notified: boolean;
}

export interface McpTaskRegisterInput { sessionId: string; server: string; tool: string; taskId: string }

export function taskKey(server: string, taskId: string): string { return `${server}:${taskId}`; }

export class McpTaskRegistry {
  private entries = new Map<string, McpTaskEntry>();

  register(e: McpTaskRegisterInput): void {
    const key = taskKey(e.server, e.taskId);
    this.entries.set(key, { key, ...e, status: "running", notified: false });
  }

  /** Terminal transition. `status` defaults to completed/failed from `ok`; pass it explicitly for
   *  "cancelled", which is a distinct outcome a client-side abort produces.
   *
   *  FIRST TERMINAL STATE WINS. An abort and the stream's own settlement genuinely race — the
   *  abort handler cancels upstream and marks the entry cancelled, and the generator may then
   *  still yield a result for work the server had already finished. Ignoring the later call keeps
   *  the notification honest ("cancelled") instead of letting a straggler rewrite history, and it
   *  is also what makes `complete` idempotent for the exactly-once claim below. */
  complete(key: string, outcome: { ok: boolean; result: string; status?: McpTaskStatus }): void {
    const e = this.entries.get(key);
    if (!e || e.status !== "running") return;
    e.status = outcome.status ?? (outcome.ok ? "completed" : "failed");
    e.result = outcome.result;
  }

  get(key: string): McpTaskEntry | undefined { return this.entries.get(key); }

  list(sessionId: string): McpTaskEntry[] {
    return [...this.entries.values()].filter((e) => e.sessionId === sessionId);
  }

  /** Claims a terminal, not-yet-notified entry: marks it notified and returns it. Unknown key,
   *  still running, or already notified → undefined. Single-consumer claim, exactly as
   *  bg-agent-registry.takeForNotification — this is what makes the notification exactly-once
   *  even though both the abort path and the settle path can call onTaskSettled. */
  takeForNotification(key: string): McpTaskEntry | undefined {
    const e = this.entries.get(key);
    if (!e || e.status === "running" || e.notified) return undefined;
    e.notified = true;
    return e;
  }
}
