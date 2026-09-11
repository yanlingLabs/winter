// P8b Task 13, fix round 1 (F1) — the roster's progress window is fed BY THE ENGINE.
//
// THE BUG THIS FILE EXISTS TO MAKE IMPOSSIBLE: the persisted registry shipped a 600 s timer whose
// only reset door, `AgentRegistry.progress()`, had **zero production callers**. Its unit test called
// `reg.progress("a1")` by hand, so it pinned an API that nothing invoked — a green test over a wall
// clock, which is precisely what CLAUDE.md's tool surface ("subagents with no wall-clock timeout — a
// progress-stall watchdog instead") and the standing "subagents: no timeout" directive forbid.
//
// So the assertion here is deliberately about the SOURCE of the reset, not about the timer: a child
// driven through the engine's REAL spawn bridge must report progress into the roster, on every
// provider event, without any test ever touching `progress()` itself. The registry is the shipped
// `BackgroundAgentRegistry` (whose own `progress` is a no-op) with that one method instrumented, so
// what is observed is the engine's call and nothing else.
import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "@norma/protocol";
import { setup } from "./engine-spawn.test";

const done = (reason: "end_turn" | "tool_calls") => ({ type: "done" as const, stopReason: reason });
const spawn = (callId: string, prompt: string, extra: Record<string, unknown> = {}) => ({
  type: "tool_call" as const,
  callId,
  name: "spawn_agent",
  argsJson: JSON.stringify({ prompt, description: "test task", run_in_background: false, ...extra }),
});

/** Replace `progress` on the harness's live registry — the SAME object `EngineConfig.bgAgents`
 *  holds, so every call recorded here came out of `engine.ts`. */
function instrument(bgAgents: { progress(id: string): void }): string[] {
  const seen: string[] = [];
  bgAgents.progress = (id: string): void => {
    seen.push(id);
  };
  return seen;
}

const childIdOf = (events: readonly SessionEvent[]): string =>
  (events.find((e) => e.type === "thread_started") as Extract<SessionEvent, { type: "thread_started" }>).threadId;

describe("the engine feeds AgentRegistry.progress (fix round 1, F1)", () => {
  test("a SYNCHRONOUS spawn reports progress into the roster, once per streamed provider event", async () => {
    const { engine, store, sessionId, bgAgents } = setup([
      [spawn("s1", "do X"), done("tool_calls")],
      [{ type: "text_delta", delta: "working" }, { type: "text_delta", delta: " on it" }, done("end_turn")],
    ]);
    const seen = instrument(bgAgents);

    await engine.runTurn(sessionId);

    const childId = childIdOf(store.read(sessionId));
    // `runThread`'s ONE chokepoint fires for every provider event — text deltas, tool calls,
    // reasoning, usage, done alike — so a child that is streaming anything at all is reporting.
    expect(seen.length).toBeGreaterThan(0);
    expect(new Set(seen)).toEqual(new Set([childId]));
  });

  test("a DETACHED (`run_in_background`) spawn reports progress too — the path with no parent turn watching", async () => {
    const { engine, store, sessionId, bgAgents } = setup([
      [spawn("s1", "do X", { run_in_background: true }), done("tool_calls")],
      [{ type: "text_delta", delta: "child finished" }, done("end_turn")],
    ]);
    const seen = instrument(bgAgents);

    await engine.runTurn(sessionId);

    const childId = childIdOf(store.read(sessionId));
    // A detached child outlives its parent's turn, so the roster's window is the only one that
    // could ever bound it once `SubagentManager` retires (Task 17). Poll rather than sleep: the
    // detached chain settles on its own microtasks.
    for (let i = 0; i < 50 && seen.length === 0; i += 1) await new Promise((r) => setTimeout(r, 10));
    expect(seen.length).toBeGreaterThan(0);
    expect(new Set(seen)).toEqual(new Set([childId]));
  });

  test("the reported id is the CHILD's, never the parent session's — a window is per child", async () => {
    const { engine, store, sessionId, bgAgents } = setup([
      [spawn("s1", "do X"), done("tool_calls")],
      [{ type: "text_delta", delta: "one" }, done("end_turn")],
    ]);
    const seen = instrument(bgAgents);

    await engine.runTurn(sessionId);

    expect(seen.length).toBeGreaterThan(0); // `every` over an empty array is vacuously true
    expect(seen).not.toContain(sessionId);
    expect(seen.every((id) => id.startsWith("th_"))).toBe(true);
    expect(bgAgents.get(childIdOf(store.read(sessionId)))).toBeDefined();
  });
});
