/** `EventBridge` (Phase 3a Task 6) — the seam between `client.ts`'s connect-time `onEvent` sink and
 *  `<App>`'s React subscription, WITHOUT touching `client.ts` (which the legacy path still shares).
 *
 *  `NormaClient.connect({ onEvent })` fixes its event callback at connect time; it is not an async
 *  iterator. But `<App>` can only subscribe from a `useEffect`, which runs a tick AFTER the first
 *  render — and the session bootstrap (`attach`) can have already replayed events into `onEvent` by
 *  then. So the bridge BUFFERS every event pushed before a subscriber attaches and, on `subscribe`,
 *  flushes that backlog in arrival order before forwarding live events. Nothing replayed is lost.
 *
 *  Single-subscriber by design (one `<App>` per session): `subscribe` replaces the handler and
 *  returns an unsubscribe that drops back to buffering (App's effect-cleanup path). Pure data plumb
 *  — no ink/react import, so `main.ts` can construct the bridge on the shared path without pulling
 *  the Ink module graph onto the non-TTY branch. */

import type { SessionEvent } from "@norma/protocol";

export type EventBridge = {
  push(e: SessionEvent): void;
  subscribe(fn: (e: SessionEvent) => void): () => void;
};

export function makeEventBridge(): EventBridge {
  let handler: ((e: SessionEvent) => void) | null = null;
  const buffer: SessionEvent[] = [];
  return {
    push(e) {
      if (handler) handler(e);
      else buffer.push(e); // no subscriber yet (pre-mount / between subscriptions) — hold in order
    },
    subscribe(fn) {
      handler = fn;
      // Drain the pre-subscribe backlog (attach-replay + anything since) in arrival order, then the
      // caller receives live events directly via push() above.
      while (buffer.length > 0) fn(buffer.shift()!);
      return () => {
        if (handler === fn) handler = null; // back to buffering until the next subscribe
      };
    },
  };
}

// ---------------------------------------------------------------------------------------------
// TUI renderer T4 — delta coalescing (mechanism report Q5's ~16ms throttle discipline, adapted:
// ONE trailing-edge timer in the delta-handling path, never a global Ink throttle).
// ---------------------------------------------------------------------------------------------

/** The coalescing window — CC's frame budget (~one 60Hz frame). A named constant, not a magic
 *  literal: app.tsx wires it, the pin tests assert against it. */
export const DELTA_COALESCE_MS = 16;

export type DeltaCoalescer = { push(e: SessionEvent): void; dispose(): void };

type TimerFns = { set: (fn: () => void, ms: number) => unknown; clear: (id: unknown) => void };
const realTimers: TimerFns = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
};

/** Sits between the bridge subscription and the reducer `dispatch` (app.tsx). `assistant_delta`
 *  events queue; the FIRST delta of a window arms the one timer; the flush dispatches the window
 *  MERGED — one event per thread (first-seen thread order), `delta` fields concatenated, all
 *  other fields (seq/ts/…) from that thread's LAST event. Merging is reducer-equivalent by
 *  construction: MAIN folds `activeAssistant + delta` (concat-associative) and child threads fold
 *  `liveOutputChars + delta.length` (sum-associative) with last-event stamping — both land on the
 *  byte-identical state sequential dispatch would produce, while costing ONE React commit per
 *  window instead of one per delta. Deltas are the only event type held back: any non-delta
 *  event flushes the queue synchronously ahead of itself, so wire order is preserved exactly
 *  (`turn_completed`'s swap always sees every delta already folded — the T3 no-glue pin's
 *  ordering assumption stays true). Timers are injectable for deterministic tests. */
export function makeDeltaCoalescer(
  dispatch: (e: SessionEvent) => void,
  timers: TimerFns = realTimers,
): DeltaCoalescer {
  let queue: SessionEvent[] = [];
  let timer: unknown = null;

  const flush = (): void => {
    if (timer !== null) { timers.clear(timer); timer = null; }
    if (queue.length === 0) return;
    const batch = queue;
    queue = [];
    // Merge per thread, preserving first-seen thread order (cross-thread relative order is
    // semantically free: deltas touch disjoint state slices per thread).
    const byThread = new Map<string, { last: SessionEvent; parts: string[] }>();
    for (const e of batch) {
      const threadId = String((e as { threadId?: unknown }).threadId ?? "");
      const part = String((e as { delta?: unknown }).delta ?? "");
      const entry = byThread.get(threadId);
      if (entry) { entry.last = e; entry.parts.push(part); }
      else byThread.set(threadId, { last: e, parts: [part] });
    }
    for (const { last, parts } of byThread.values()) {
      dispatch({ ...last, delta: parts.join("") } as SessionEvent);
    }
  };

  return {
    push(e) {
      if (e.type === "assistant_delta") {
        queue.push(e);
        if (timer === null) timer = timers.set(flush, DELTA_COALESCE_MS); // one timer, trailing edge
        return;
      }
      flush(); // deltas queued in this window land BEFORE the non-delta event — wire order kept
      dispatch(e);
    },
    dispose() {
      flush(); // App effect cleanup: nothing dropped, and the cleared timer can never fire late
    },
  };
}
