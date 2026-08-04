import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../../src/sessions/store";
import { SessionHub } from "../../src/sessions/hub";
import { makeDaemonRoutineRunner, type MinimalEngine } from "../../src/routines/runner";

function makeHome(): string {
  return mkdtempSync(join(tmpdir(), "norma-routine-runner-"));
}

describe("makeDaemonRoutineRunner — runHeadless", () => {
  test("no engine configured (agent disabled): fails cleanly, no session left dangling on the happy path", async () => {
    const store = new SessionStore(makeHome());
    const hub = new SessionHub(store);
    const runner = makeDaemonRoutineRunner({ store, hub, engine: null });

    const result = await runner.runHeadless({ prompt: "check inbox", policy: "auto", cwd: "/tmp", origin: "routine/r1" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/agent disabled|no provider/i);
  });

  test("success: creates a session titled with `origin`, posts the prompt, runs one turn, returns the final assistant text", async () => {
    const store = new SessionStore(makeHome());
    const hub = new SessionHub(store);
    let sawSessionId: string | undefined;
    let sawPrompt: string | undefined;
    const engine: MinimalEngine = {
      async runTurn(sessionId) {
        sawSessionId = sessionId;
        const events = store.read(sessionId);
        const userMsg = events.find((e) => e.type === "user_message");
        sawPrompt = userMsg && "text" in userMsg ? userMsg.text : undefined;
        hub.append(sessionId, { type: "assistant_message", sessionId, threadId: "main", text: "3 unread emails" });
        hub.append(sessionId, { type: "turn_completed", sessionId, threadId: "main", stopReason: "end_turn", inputTokens: 10, outputTokens: 5 });
      },
    };
    const runner = makeDaemonRoutineRunner({ store, hub, engine });

    const result = await runner.runHeadless({ prompt: "check inbox", policy: "auto", cwd: "/tmp/proj", origin: "routine/r1" });

    expect(result.ok).toBe(true);
    expect(result.resultText).toBe("3 unread emails");
    expect(sawPrompt).toBe("check inbox");
    expect(sawSessionId).toBeDefined();

    // origin is visible in the session list BOTH ways now (phase 5 T3): the title stamp T2 shipped
    // (kept — user-visible) AND the real session-meta `origin` field T3 adds (machine-readable),
    // set together at createSession — neither is ever overwritten by the other.
    const listed = store.list().find((s) => s.sessionId === sawSessionId);
    expect(listed?.title).toBe("routine/r1");
    expect(listed?.origin).toBe("routine/r1");
    expect(listed?.cwd).toBe("/tmp/proj");

    // working-directories T6: the spawn dir lands as an UNLOCKED primary at birth — createSession's
    // own INSERT, not the pre-branch lazy migration (which would have derived it LOCKED). This
    // engine stub already ran a fake "turn" above (an assistant_message + turn_completed, no actual
    // write/bash call), so staying unlocked here also proves the row isn't locked just by a turn
    // running — only a real successful write/bash call (T5's first-write-locks path) would flip it,
    // and the real engine turn a routine actually runs writes almost immediately (its whole point is
    // doing something in `cwd`), so in production this locks fast — correct and free, same as a
    // dispatch child (dispatch-children.test.ts's own T6 pin).
    expect(store.dirs(sawSessionId!)).toEqual([{ path: "/tmp/proj", locked: false }]);
  });

  test("quota error: an agent_error whose message starts with HTTP 429 maps to quotaLimited", async () => {
    const store = new SessionStore(makeHome());
    const hub = new SessionHub(store);
    const engine: MinimalEngine = {
      async runTurn(sessionId) {
        hub.append(sessionId, { type: "agent_error", sessionId, threadId: "main", message: "HTTP 429 — rate limited" });
        hub.append(sessionId, { type: "turn_completed", sessionId, threadId: "main", stopReason: "error", inputTokens: 0, outputTokens: 0 });
      },
    };
    const runner = makeDaemonRoutineRunner({ store, hub, engine });

    const result = await runner.runHeadless({ prompt: "x", policy: "auto", cwd: "/tmp", origin: "routine/r2" });
    expect(result.ok).toBe(false);
    expect(result.quotaLimited).toBe(true);
    expect(result.error).toBe("HTTP 429 — rate limited");
  });

  // Phase 5 routines T3 (design doc §3, carried from T2's report): the structured `code` field is
  // now threaded through (protocol/src/events.ts's AgentErrorEvent.code, engine.ts forwards
  // ev.code) — quota detection PREFERS `code === "rate_limit"` over the "HTTP 429" message-prefix
  // string match, which remains only as a fallback for errors that never carried a code.
  test("quota error via structured code: agent_error.code === \"rate_limit\" maps to quotaLimited even with a message that does NOT start with HTTP 429", async () => {
    const store = new SessionStore(makeHome());
    const hub = new SessionHub(store);
    const engine: MinimalEngine = {
      async runTurn(sessionId) {
        hub.append(sessionId, { type: "agent_error", sessionId, threadId: "main", message: "rate limited, try later", code: "rate_limit" });
        hub.append(sessionId, { type: "turn_completed", sessionId, threadId: "main", stopReason: "error", inputTokens: 0, outputTokens: 0 });
      },
    };
    const runner = makeDaemonRoutineRunner({ store, hub, engine });

    const result = await runner.runHeadless({ prompt: "x", policy: "auto", cwd: "/tmp", origin: "routine/r5" });
    expect(result.ok).toBe(false);
    expect(result.quotaLimited).toBe(true);
    expect(result.error).toBe("rate limited, try later");
  });

  test("a non-rate_limit code (e.g. \"auth\") is NOT quotaLimited, even if the message happens to start with HTTP 429", async () => {
    const store = new SessionStore(makeHome());
    const hub = new SessionHub(store);
    const engine: MinimalEngine = {
      async runTurn(sessionId) {
        hub.append(sessionId, { type: "agent_error", sessionId, threadId: "main", message: "HTTP 429 — actually an auth error", code: "auth" });
        hub.append(sessionId, { type: "turn_completed", sessionId, threadId: "main", stopReason: "error", inputTokens: 0, outputTokens: 0 });
      },
    };
    const runner = makeDaemonRoutineRunner({ store, hub, engine });

    const result = await runner.runHeadless({ prompt: "x", policy: "auto", cwd: "/tmp", origin: "routine/r6" });
    expect(result.ok).toBe(false);
    expect(result.quotaLimited).toBeUndefined();
  });

  test("non-quota error: an agent_error NOT starting with HTTP 429 is a plain error (not quotaLimited)", async () => {
    const store = new SessionStore(makeHome());
    const hub = new SessionHub(store);
    const engine: MinimalEngine = {
      async runTurn(sessionId) {
        hub.append(sessionId, { type: "agent_error", sessionId, threadId: "main", message: "tool crashed" });
        hub.append(sessionId, { type: "turn_completed", sessionId, threadId: "main", stopReason: "error", inputTokens: 0, outputTokens: 0 });
      },
    };
    const runner = makeDaemonRoutineRunner({ store, hub, engine });

    const result = await runner.runHeadless({ prompt: "x", policy: "auto", cwd: "/tmp", origin: "routine/r3" });
    expect(result.ok).toBe(false);
    expect(result.quotaLimited).toBeUndefined();
    expect(result.error).toBe("tool crashed");
  });

  test("engine.runTurn throwing surfaces as a plain error result, never rejects", async () => {
    const store = new SessionStore(makeHome());
    const hub = new SessionHub(store);
    const engine: MinimalEngine = { async runTurn() { throw new Error("engine exploded"); } };
    const runner = makeDaemonRoutineRunner({ store, hub, engine });

    const result = await runner.runHeadless({ prompt: "x", policy: "auto", cwd: "/tmp", origin: "routine/r4" });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("engine exploded");
  });
});
