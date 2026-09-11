import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SessionEvent } from "@norma/protocol";
import { SUBAGENT_TRANSCRIPT_INCLUDE } from "../projector/event-coverage";

/**
 * The transcript's event allowlist. MOVED (Winter 8b Task 10, C-5 / ruling P8b-9) to
 * `../projector/event-coverage.ts` — values and doc comment unchanged, only its home. The
 * `satisfies Record<SessionEvent["type"], boolean>` clause it carries is CLAUDE.md's protocol-
 * checklist step 4, and this module retires with the engine; the projector's module does not, so
 * the compile-time trap for a new `SessionEvent` variant outlives `AgentEngine`.
 */
const TRANSCRIPT_INCLUDE = SUBAGENT_TRANSCRIPT_INCLUDE;

/**
 * Per-subagent transcript files (CC parity, "surface each subagent's FULL TRANSCRIPT as a file
 * path the parent agent can read/glob/grep" — token-efficient, exactly like Claude Code does). One
 * JSONL file per child thread at `<sessionTmpDir>/subagents/agent-<threadId>.jsonl`, holding every
 * ALLOWLISTED event scoped to that thread (see TRANSCRIPT_INCLUDE above) in append order. The
 * session tmp dir is ALREADY an allowed read root for the sandboxed read/glob/grep tools
 * (fs-read.ts's `readRootsOf`), so the model can consult its own subagents' transcripts with no
 * new fence/root — see spawn.ts's / agent-query.ts's tool descriptions for the "grep or paginate,
 * don't read it whole" guidance surfaced to the model.
 *
 * The child's spawn PROMPT is never itself persisted as a session event (engine.ts's own KNOWN GAP
 * note on `childHistoryInput` — the fresh spawn passes it straight into runThread's in-memory
 * input, never through the store). So the FIRST event this writer ever sees for a (sessionId,
 * threadId) pair — which, by construction (engine.ts registers the child thread immediately before
 * emitting its `thread_started`, and nothing else can be emitted for a brand-new threadId before
 * that), is always that child's own `thread_started` — gets a synthetic `{type:"spawn_prompt", ts,
 * agentType, prompt}` line written just ahead of it, so the file reads as a complete transcript
 * from the child's very first instruction onward. This closes the prompt-persistence gap AT THE
 * FILE level only — the session store / replay / childHistoryInput are completely untouched.
 *
 * Failure-safe, PER-THREAD (task-9 review, Minors 1+3): any error (a throwing tmpDirOf, a vanished
 * tmp dir, a full disk, a permissions problem, ...) is caught, logged once for THAT
 * (sessionId, threadId) key, and marks the key "failed" — every later append for it is a silent
 * fast no-op (no retry storm against a persistently broken path), while OTHER threads/sessions
 * keep their own independent state (one thread's failure never silences the rest of the process).
 * Nothing here ever throws into the engine's hot `emit()` path.
 */
export class SubagentTranscripts {
  // Per-(sessionId, threadId) lifecycle: absent = not bootstrapped yet; "ready" = directory
  // created (+ spawn_prompt written, when applicable) and appends flowing; "failed" = an fs/
  // accessor error was logged once for this key and all further appends for it are skipped.
  private readonly state = new Map<string, "ready" | "failed">();

  constructor(
    // Mirrors daemon.ts's own `tmpDirOf` accessor (registerLspTools' dep) — a getter over the
    // session tmp dir, absent/undefined meaning "this session has no transcript surfaced anywhere"
    // (e.g. a test harness that never wires it). Never called eagerly — only at `pathFor`/`append`
    // time, so an absent accessor costs nothing until something actually tries to use it.
    private readonly tmpDirOf: (sessionId: string) => string | undefined,
  ) {}

  /** Path construction that may THROW (tmpDirOf is caller-supplied and may do real work — e.g.
   *  daemon.ts wires sessionTmpDir, which mkdirs/realpaths) — internal only; both public entry
   *  points wrap it. */
  private buildPath(sessionId: string, threadId: string): string | undefined {
    const dir = this.tmpDirOf(sessionId);
    return dir ? join(dir, "subagents", `agent-${threadId}.jsonl`) : undefined;
  }

  /** Path accessor for result-building surfaces (bg tool_results, notifications, trailers,
   *  agent_output) — NEVER throws: a throwing tmpDirOf resolves to undefined, so those surfaces
   *  just omit the path, same as the unwired case. */
  pathFor(sessionId: string, threadId: string): string | undefined {
    try {
      return this.buildPath(sessionId, threadId);
    } catch {
      return undefined;
    }
  }

  /** Appends one JSON line for `event` to this (sessionId, threadId)'s transcript file, lazily
   *  creating the `subagents/` directory (and the synthetic spawn_prompt line, if `event` is this
   *  thread's first-ever `thread_started`) on the first call for that key. No-op — no file, no
   *  throw — when: the event type is not in TRANSCRIPT_INCLUDE's written set (allowlist, see its
   *  doc comment), tmpDirOf resolves to undefined (unwired), the key was already marked "failed",
   *  or any error occurs now (logged once, key marked "failed", see the class doc). */
  append(sessionId: string, threadId: string, event: SessionEvent): void {
    // Allowlist gate — fail closed: an unknown/future type reads `undefined` here, which is
    // `!== true`, so it is excluded until someone deliberately adds it to TRANSCRIPT_INCLUDE.
    if (TRANSCRIPT_INCLUDE[event.type] !== true) return;
    const key = `${sessionId} ${threadId}`;
    if (this.state.get(key) === "failed") return; // this thread's writer is disabled — fast no-op
    try {
      const path = this.buildPath(sessionId, threadId);
      if (!path) return; // tmpDirOf unwired for this session — transcripts off, not an error
      if (this.state.get(key) !== "ready") {
        mkdirSync(dirname(path), { recursive: true });
        this.state.set(key, "ready");
        if (event.type === "thread_started") {
          const spawnLine = { type: "spawn_prompt" as const, ts: event.ts, agentType: event.agentType, prompt: event.prompt };
          appendFileSync(path, JSON.stringify(spawnLine) + "\n");
        }
      }
      appendFileSync(path, JSON.stringify(event) + "\n");
    } catch (err) {
      this.state.set(key, "failed");
      console.error(`subagent transcript disabled for thread ${threadId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
