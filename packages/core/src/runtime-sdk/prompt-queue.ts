/**
 * **The host-owned prompt queue** — the `AsyncIterable<string>` every Winter session is opened with
 * (G-15 / P8b-6), and the ONLY way a host pushes a later user turn onto the Winter leg.
 *
 * Surface map §2.5 is the whole rationale. A `string` prompt sends one `user` frame then
 * `end_input`, so such a session is **unreachable by messaging** for the rest of its life. An
 * `AsyncIterable<string>` prompt sends each item as a `user` frame *as it arrives* and closes input
 * only when the iterable itself completes — so "the host pushes later user turns by writing into
 * its own `AsyncIterable<string>`… That is the mechanism, and the SDK provides no helper for it on
 * the Winter leg" (the router ships `createOfficialInputStream()` for the OFFICIAL leg only). This
 * module is Winter's.
 *
 * Closing the queue is also how a session ENDS cleanly (§2.5 way 1): `close()` → the iterable
 * completes → `end_input` → the child finishes its last turn and EOFs stdout.
 */
export interface HostPromptQueue extends AsyncIterable<string> {
  /** Append a turn. Throws once the queue is closed — a push nobody will ever read is a bug in the
   *  caller, not something to swallow. */
  push(text: string): void;
  /** End the stream. Items already pushed are still drained first; idempotent. */
  close(): void;
  readonly closed: boolean;
  /** Items pushed and not yet handed to the iterator. Counts ITEMS, never parked readers. */
  readonly pending: number;
}

export function createHostPromptQueue(): HostPromptQueue {
  const items: string[] = [];
  // Parked `next()` calls, in arrival order. FIFO is load-bearing, not incidental: two concurrent
  // readers must be served in the order they asked, or a turn can overtake an earlier one.
  const waiters: Array<(r: IteratorResult<string>) => void> = [];
  let closed = false;

  const settleAllWaiters = (): void => {
    while (waiters.length) waiters.shift()!({ value: undefined, done: true });
  };

  const queue: HostPromptQueue = {
    push(text: string): void {
      if (closed) throw new Error("prompt queue closed");
      // A parked reader takes the item directly — never through the buffer, so `pending` stays an
      // honest count of what is waiting for a reader rather than of what has been handed on.
      const waiter = waiters.shift();
      if (waiter) { waiter({ value: text, done: false }); return; }
      items.push(text);
    },

    close(): void {
      if (closed) return;
      closed = true;
      // Items already buffered are NOT dropped: a reader that arrives after close still drains
      // them, and only then sees `done`. A parked reader, by definition, has nothing buffered to
      // take (push hands to a parked reader directly), so every waiter can be ended right now.
      settleAllWaiters();
    },

    get closed(): boolean { return closed; },
    get pending(): number { return items.length; },

    [Symbol.asyncIterator](): AsyncIterator<string> {
      return {
        next(): Promise<IteratorResult<string>> {
          if (items.length) return Promise.resolve({ value: items.shift()!, done: false });
          if (closed) return Promise.resolve({ value: undefined, done: true });
          return new Promise((resolve) => { waiters.push(resolve); });
        },
        /**
         * The consumer walking away (surface map §2.5 way 2: a `break` out of `for await`, or an
         * explicit `.return()`) CLOSES the queue. Without this, a session whose iteration ended
         * would go on accepting pushes forever — each one silently dropped into a buffer nothing
         * will ever read, which is the worst shape a "message delivered" can take.
         */
        return(): Promise<IteratorResult<string>> {
          queue.close();
          return Promise.resolve({ value: undefined, done: true });
        },
      };
    },
  };

  return queue;
}
