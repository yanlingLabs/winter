// Shared timing helpers for the Ink/React tests.
//
// `settle` lets every task ALREADY QUEUED on the event loop run — React's scheduler (a setImmediate per
// render/commit/passive-effect flush), Ink's frame write, promise chains — counted in loop TURNS, never wall
// time. A bare `setTimeout(ms)` is not enough on a loaded machine: when the process is descheduled past the
// timer's due time the loop runs the (expired) timer BEFORE the immediates React queued for the keystroke, and the
// test asserts on a frame that has not rendered yet.
export const settle = async (turns = 16): Promise<void> => {
  for (let i = 0; i < turns; i++) await new Promise<void>((r) => setImmediate(r));
};

/** A real-time pause of at least `ms` (for tests that ride a real timer) followed by a `settle`. */
export const wait = async (ms: number): Promise<void> => {
  await new Promise((r) => setTimeout(r, ms));
  await settle();
};

/** Waits for `cond` to hold (checked every few ms and after each settle). The deadline only bounds a hang — it is
 *  never what a passing test waits for — and a miss throws naming `what`. */
export async function until(cond: () => unknown, what: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (cond()) return;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 5));
    await settle(4);
  }
}
