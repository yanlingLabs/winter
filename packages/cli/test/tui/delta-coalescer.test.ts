/** TUI renderer T4 — delta coalescing (mechanism report Q5: the ~16ms throttle discipline,
 *  ADAPTED to Norma's shape: not a global Ink throttle, ONE trailing-edge timer in the
 *  delta-handling path). `makeDeltaCoalescer` sits between the EventBridge subscription and the
 *  reducer dispatch in app.tsx:
 *
 *   - `assistant_delta` events queue; the FIRST delta of a window arms one ~16ms timer; the
 *     timer's flush dispatches the whole window's deltas MERGED — one event per thread, deltas
 *     concatenated (reducer-equivalent by construction: MAIN folds `activeAssistant + delta`,
 *     children fold `liveOutputChars + delta.length`; both are concat/sum-associative, and the
 *     merged event carries the LAST event's seq/ts so stamping lands where sequential dispatch
 *     would have left it). THE COALESCING PIN: N rapid deltas in a window ⇒ ONE dispatch ⇒ at
 *     most one React commit for the whole burst (≤2 renders across a window boundary).
 *   - The timer is trailing-edge and NEVER re-armed by later deltas in the window (a debounce
 *     would starve under continuous streaming — the throttle shape, not the debounce shape).
 *   - Any NON-delta event flushes the queue synchronously FIRST, then dispatches itself — wire
 *     order is preserved exactly (turn_completed's swap always sees every delta already folded).
 *   - `dispose()` (App effect cleanup) flushes pending deltas and cancels the timer — nothing is
 *     ever dropped, nothing fires after unmount.
 *
 *  Timers are INJECTED (set/clear) so every test is deterministic manual time — no sleeps. */
import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "@norma/protocol";
import { DELTA_COALESCE_MS, makeDeltaCoalescer } from "../../src/tui/event-bridge";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ev = (o: Record<string, unknown>) => o as any as SessionEvent;
const delta = (threadId: string, text: string, seq: number) =>
  ev({ type: "assistant_delta", threadId, delta: text, seq, sessionId: "s" });

/** Manual timer harness: `set` records the callback; `fire()` runs it (simulating expiry). */
function fakeTimers() {
  let pending: (() => void) | null = null;
  let sets = 0;
  let clears = 0;
  return {
    timers: {
      set: (fn: () => void, _ms: number) => { pending = fn; sets += 1; return sets; },
      clear: (_id: unknown) => { pending = null; clears += 1; },
    },
    fire: () => { const fn = pending; pending = null; if (fn) fn(); },
    counts: () => ({ sets, clears }),
    hasPending: () => pending !== null,
  };
}

function spyDispatch() {
  const seen: SessionEvent[] = [];
  return { seen, dispatch: (e: SessionEvent) => { seen.push(e); } };
}

describe("makeDeltaCoalescer — THE COALESCING PIN", () => {
  test("N rapid deltas in one window fold to ONE dispatch: concatenated text, the LAST event's seq", () => {
    const t = fakeTimers();
    const { seen, dispatch } = spyDispatch();
    const c = makeDeltaCoalescer(dispatch, t.timers);
    for (let i = 0; i < 50; i++) c.push(delta("main", `w${i} `, i + 1));
    expect(seen.length).toBe(0); // nothing dispatched inside the window
    t.fire();
    expect(seen.length).toBe(1); // 50 deltas ⇒ ONE dispatch ⇒ one commit for the burst
    const merged = seen[0] as unknown as { type: string; delta: string; seq: number };
    expect(merged.type).toBe("assistant_delta");
    expect(merged.delta).toBe(Array.from({ length: 50 }, (_, i) => `w${i} `).join(""));
    expect(merged.seq).toBe(50);
  });

  test("trailing edge, ONE timer: later deltas in the window never re-arm it (throttle, not debounce)", () => {
    const t = fakeTimers();
    const c = makeDeltaCoalescer(spyDispatch().dispatch, t.timers);
    for (let i = 0; i < 20; i++) c.push(delta("main", "x", i + 1));
    expect(t.counts().sets).toBe(1); // armed once, by the FIRST delta of the window
  });

  test("after a flush the NEXT delta opens a fresh window (a new timer)", () => {
    const t = fakeTimers();
    const { seen, dispatch } = spyDispatch();
    const c = makeDeltaCoalescer(dispatch, t.timers);
    c.push(delta("main", "a", 1));
    t.fire();
    c.push(delta("main", "b", 2));
    expect(t.counts().sets).toBe(2);
    t.fire();
    expect(seen.length).toBe(2);
    expect((seen[1] as unknown as { delta: string }).delta).toBe("b");
  });

  test("a NON-delta event flushes queued deltas FIRST, then itself — synchronously, wire order kept", () => {
    const t = fakeTimers();
    const { seen, dispatch } = spyDispatch();
    const c = makeDeltaCoalescer(dispatch, t.timers);
    c.push(delta("main", "hel", 1));
    c.push(delta("main", "lo", 2));
    c.push(ev({ type: "assistant_message", threadId: "main", text: "hello", seq: 3, sessionId: "s" }));
    expect(seen.map((e) => e.type)).toEqual(["assistant_delta", "assistant_message"]);
    expect((seen[0] as unknown as { delta: string }).delta).toBe("hello");
    expect(t.hasPending()).toBe(false); // the armed timer was cancelled by the synchronous flush
  });

  test("multi-thread window: one merged event PER thread, first-seen thread order", () => {
    const t = fakeTimers();
    const { seen, dispatch } = spyDispatch();
    const c = makeDeltaCoalescer(dispatch, t.timers);
    c.push(delta("main", "m1", 1));
    c.push(delta("th_child", "c1", 2));
    c.push(delta("main", "m2", 3));
    c.push(delta("th_child", "c2", 4));
    t.fire();
    expect(seen.length).toBe(2);
    expect(seen.map((e) => (e as unknown as { threadId: string }).threadId)).toEqual(["main", "th_child"]);
    expect(seen.map((e) => (e as unknown as { delta: string }).delta)).toEqual(["m1m2", "c1c2"]);
    expect(seen.map((e) => e.seq)).toEqual([3, 4]); // each merged event stamps its thread's LAST seq
  });

  test("dispose() flushes pending deltas synchronously and cancels the timer — nothing dropped, nothing fires later", () => {
    const t = fakeTimers();
    const { seen, dispatch } = spyDispatch();
    const c = makeDeltaCoalescer(dispatch, t.timers);
    c.push(delta("main", "tail", 9));
    c.dispose();
    expect(seen.length).toBe(1);
    expect((seen[0] as unknown as { delta: string }).delta).toBe("tail");
    expect(t.hasPending()).toBe(false);
    t.fire(); // a straggler expiry after dispose must be inert
    expect(seen.length).toBe(1);
  });

  test("a delta-free stream passes through untouched — no timer, no reordering, no dispatch delay", () => {
    const t = fakeTimers();
    const { seen, dispatch } = spyDispatch();
    const c = makeDeltaCoalescer(dispatch, t.timers);
    c.push(ev({ type: "turn_started", threadId: "main", seq: 1, sessionId: "s" }));
    c.push(ev({ type: "turn_completed", threadId: "main", seq: 2, sessionId: "s" }));
    expect(seen.map((e) => e.type)).toEqual(["turn_started", "turn_completed"]);
    expect(t.counts().sets).toBe(0);
  });

  test("the window constant is ~16ms (the CC frame-budget number, a named constant)", () => {
    expect(DELTA_COALESCE_MS).toBe(16);
  });
});
