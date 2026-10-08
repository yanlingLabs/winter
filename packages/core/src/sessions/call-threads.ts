// The reviewing pill (2026-10-08): which THREAD a tool call is on, by its callId, for the daemon's own transient
// about that call (`tool_review_progress`). Learned from the session log as it is appended — a `tool_call` names its
// `callId` and `threadId` (the projector puts a subagent's call on the spawning call's thread) — and forgotten at
// the call's `tool_result`. The runtime sends a call's assistant frame before it runs the call's PreToolUse hooks,
// so the call is known by the time its review starts; an unknown call reads as the main thread.
import type { SessionEvent } from "@yanlinglabs/winter-protocol";

/** Calls remembered per session at most (a call that never gets a result — a killed child — is dropped oldest
 *  first past this). */
const MAX_CALLS_PER_SESSION = 512;

export class CallThreads {
  private readonly bySession = new Map<string, Map<string, string>>();

  /** A hub observer: every appended event. */
  observe(event: SessionEvent): void {
    if (event.type === "tool_call") {
      let calls = this.bySession.get(event.sessionId);
      if (calls === undefined) { calls = new Map(); this.bySession.set(event.sessionId, calls); }
      calls.delete(event.callId);
      calls.set(event.callId, event.threadId);
      while (calls.size > MAX_CALLS_PER_SESSION) calls.delete(calls.keys().next().value!);
    } else if (event.type === "tool_result") {
      const calls = this.bySession.get(event.sessionId);
      calls?.delete(event.callId);
      if (calls !== undefined && calls.size === 0) this.bySession.delete(event.sessionId);
    }
  }

  /** The call's thread, or `"main"` for a call this has not seen. */
  threadOf(sessionId: string, callId: string): string {
    return this.bySession.get(sessionId)?.get(callId) ?? "main";
  }

  /** The session is gone. */
  forget(sessionId: string): void { this.bySession.delete(sessionId); }
}
