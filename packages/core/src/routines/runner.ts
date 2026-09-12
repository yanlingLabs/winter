import type { SessionStore } from "../sessions/store";
import type { SessionHub } from "../sessions/hub";
import type { RoutineRunner } from "./scheduler";

// Every rate-limit ProviderEvent carries `code: "rate_limit"` and a message starting with this
// exact prefix. Phase 5 routines T3 threads that `code` through as an additive optional field on
// `agent_error` (protocol/src/events.ts's AgentErrorEvent.code — engine.ts forwards `ev.code` when
// the error came from a live provider stream), so quota detection below now PREFERS the structured
// `code === "rate_limit"` check. This message-prefix match remains as the FALLBACK for an
// `agent_error` with no `code` at all (an older log, or one of engine.ts's two synthetic
// agent_error emit sites — "no cwd" / context cap — which have no provider code to carry).
// Phase 8d task 2.4: the message-prefix producer this fallback was originally paired with
// (`providers/openai-compatible.ts`'s `mapHttpError`) is gone — Norma's internal model calls now
// run over `@yanlinglabs/winter-provider-runtime` adapters (`providers/runtime-provider.ts`), whose
// own error messages are NOT guaranteed to start with "HTTP 429". This fallback is therefore a
// carry of unverified reach on today's provider layer, not a tripwire with a live producer to
// watch — recorded here rather than silently left implying one still exists.
const QUOTA_ERROR_PREFIX = "HTTP 429";

/** Builds the RoutineRunner the daemon wires into makeRoutineScheduler — `runHeadless` reuses the
 *  SAME internal path `norma -p` drives (session create → post the prompt as a user_message → one
 *  engine.runTurn → read the final assistant text back off the session log), just in-process
 *  instead of over the IPC socket (the scheduler already lives inside the daemon).
 *
 *  Origin stamping (design doc §2/§3: "origin: routine/<id> stamped in session meta, visible in
 *  sessions list") — T3 superseded T2's fallback: `origin` is now a real, additive session-meta
 *  field (`SessionCreateParams.origin` → the sqlite `sessions.origin` column → `SessionStore.list()`
 *  rows), passed straight through at `createSession`. The session-TITLE stamp T2 shipped stays —
 *  belt-and-suspenders, not replaced: the title is what a human sees in `norma sessions`/`resume`
 *  (`session_titled`), the `origin` meta field is the machine-readable record another program can
 *  filter/query on (e.g. "list every session this routine ever fired"). Neither overwrites the
 *  other — titles.ts's SessionTitler still never touches an already-titled session (`maybeTitle`'s
 *  first check is `if (this.store.getTitle(sessionId)) return`), and `origin` is write-once at
 *  create time, nothing else in the engine ever mutates it.
 *
 *  Known v1 limitation (phase 5a §7, document-don't-special-case): a routine turn runs at depth 0,
 *  so any `spawn_agent` it makes now defaults to BACKGROUND (phase 5a's flip) — the single
 *  `engine.runTurn` above returns as soon as the spawn's immediate `{agentId,status:"running"}`
 *  tool_result comes back, not once the delegate actually finishes. `resultText` above then reads
 *  whatever the main thread said BEFORE the delegate's own completion notification lands (that
 *  notification instead triggers its own separate idle-wake turn later, invisible to this
 *  particular runHeadless call/return). A routine prompt whose read-back must include a
 *  delegate's result should instruct the model to wait for it — i.e. have the model pass
 *  `run_in_background: false` on that spawn_agent call — rather than this runner special-casing
 *  routine-origin sessions to a different spawn default. */
/** The slice of Task 16's driver table a headless turn needs: a routine session is a new CODE
 *  session on the Winter leg every fire (the only leg since Task 17; fix wave F9 removed the
 *  runner's engine branch with it). */
export interface WinterTurnRunner {
  /** Create the session's driver, `send` the prompt (the driver appends the `user_message`), wait
   *  until nothing is in flight. Rejects with the leg's typed refusal. */
  runTurn(sessionId: string, text: string, clientName: string): Promise<void>;
}

export function makeDaemonRoutineRunner(deps: {
  store: SessionStore;
  hub: SessionHub;
  /** The driver table. `undefined` (a daemon whose Winter handle never constructed has one anyway;
   *  this is a harness without one) ⇒ every fire fails cleanly, as "agent disabled" always did. */
  winter?: WinterTurnRunner;
}): RoutineRunner {
  return {
    async runHeadless(opts): Promise<{ ok: boolean; quotaLimited?: boolean; resultText?: string; error?: string }> {
      if (!deps.winter) return { ok: false, error: "agent disabled: no runtime available" };

      const sessionId = deps.store.createSession("routine", { cwd: opts.cwd, approvalPolicy: opts.policy, origin: opts.origin });
      deps.hub.append(sessionId, { type: "session_titled", sessionId, threadId: "main", title: opts.origin });

      try {
        // The driver appends the `user_message` itself (P8b-39: the log is its queue).
        await deps.winter.runTurn(sessionId, opts.prompt, "routine");
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }

      const events = deps.store.read(sessionId);
      // Main-thread only — a routine prompt that itself spawns subagents surfaces their results
      // through the main thread's own assistant_message (spawn_agent's normal tool_result bridge),
      // exactly like a `norma -p` turn.
      const mainEvents = events.filter((e) => !("threadId" in e) || e.threadId === "main");
      const lastError = [...mainEvents].reverse().find((e) => e.type === "agent_error");
      if (lastError && lastError.type === "agent_error") {
        // Prefer the structured code when present (see QUOTA_ERROR_PREFIX's doc comment above);
        // fall back to the message-prefix match only for a code-less agent_error.
        const isQuota = lastError.code !== undefined
          ? lastError.code === "rate_limit"
          : lastError.message.startsWith(QUOTA_ERROR_PREFIX);
        return {
          ok: false,
          error: lastError.message,
          ...(isQuota ? { quotaLimited: true } : {}),
        };
      }
      const lastAssistant = [...mainEvents].reverse().find((e) => e.type === "assistant_message");
      return { ok: true, resultText: lastAssistant && lastAssistant.type === "assistant_message" ? lastAssistant.text : "" };
    },
  };
}
