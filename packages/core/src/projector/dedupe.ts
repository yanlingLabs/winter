/**
 * ── P8b-5's echo dedupe, AND THE MEASUREMENT THAT MADE IT A NO-OP ───────────────────────────────
 *
 * The ruling: the host appends `user_message` itself before pushing a user turn into the prompt
 * queue, so the projector "never re-appends a host-pushed user turn (it dedupes the echoed `user`
 * frame by the pushed text's uuid/position)". The brief made that conditional on a measurement
 * rather than an assumption, and the measurement says there is nothing to dedupe:
 *
 *     dist/winter @ SDK v0.0.3, measured 2026-09-11, two user turns pushed through an
 *     AsyncIterable<string> prompt, `includePartialMessages: true`, child pinned to a temp home:
 *
 *       winter-test/echo     system/init  assistant  result  assistant  result
 *       winter-test/tooluse  system/init  assistant  system/permission_denied
 *                            user(tool_result)  assistant  result  result
 *
 * Two pushed turns, and NOT ONE `user` frame attributable to either. The only `user` frame in
 * either recording is the tool-result carrier. The runtime consumes the host's `user` input frames
 * and never re-emits them on the output stream.
 *
 * So this module keeps the ruling's SHAPE — a bounded window of recently pushed texts, and one
 * predicate — while doing nothing on the 0.0.3 wire, and `test/projector/idempotency.test.ts` pins
 * the measurement as a test rather than as a comment. It exists for two reasons:
 *
 *   1. It is the ONE place a future echo would be caught. If a later runtime starts echoing (or a
 *      host bug pushes the same text twice), `shouldDropEcho` is already wired into the `user`-text
 *      branch of `index.ts` and the fix is a behaviour change in one function, not a new seam.
 *   2. It documents WHY there is no dedupe, at the place someone will look for one. A missing
 *      module reads as an oversight; this one reads as a measurement.
 *
 * The window is text-keyed, not uuid-keyed, because the measured `user` frame carries no `uuid` at
 * all (only `system/*` frames do). Each pushed text is consumable ONCE — a user who genuinely sends
 * "ok" twice must see two `user_message`s, so a matching echo removes the entry rather than
 * leaving it to swallow every later repeat.
 *
 * ── A FOLDED push (agent SDK 0.0.44, user ruling 2026-10-04) ──────────────────────────────────────
 *
 * A push made while a turn runs is folded into that turn at its next tool round, and the model reads
 * it WRAPPED ("The user sent a new message while you were working: …", a system-reminder). The 0.0.44
 * contract names no output frame for it — only `system/host_input_folded` — but should a runtime ever
 * surface the wrapper as a text-only `user` frame, it is the folded text again, never a new message:
 * the host appended its `user_message` at push time. So a folded text is recorded (`folded`), and a
 * later text-only frame that CONTAINS it (the wrapper) is dropped as its echo, consuming it — once,
 * like every entry here.
 */

/** How many recent pushes stay eligible for an echo match. A turn is pushed and answered long
 *  before eight more are queued; a larger window would start swallowing genuine repeats. */
export const ECHO_WINDOW = 8;

export interface EchoWindow {
  /** Record a text the HOST pushed into the prompt queue (and already appended as `user_message`). */
  pushed(text: string): void;
  /** Record a pushed text the runtime FOLDED into its running turn (0.0.44) — its wrapper is an echo. */
  folded(text: string): void;
  /** True when `text` is an echo of a host push that has not been matched yet — consuming it: the
   *  text itself, or a wrapper CONTAINING a folded one (every folded text it contains is consumed). */
  shouldDropEcho(text: string): boolean;
  readonly size: number;
}

export function createEchoWindow(limit: number = ECHO_WINDOW): EchoWindow {
  const recent: string[] = [];
  const folds: string[] = [];
  return {
    pushed(text: string): void {
      recent.push(text);
      while (recent.length > limit) recent.shift();
    },
    folded(text: string): void {
      if (text.trim().length === 0) return;
      folds.push(text.trim());
      while (folds.length > limit) folds.shift();
    },
    shouldDropEcho(text: string): boolean {
      const at = recent.indexOf(text);
      if (at >= 0) {
        recent.splice(at, 1);
        const f = folds.indexOf(text.trim());
        if (f >= 0) folds.splice(f, 1);
        return true;
      }
      let matched = false;
      for (let i = folds.length - 1; i >= 0; i--) {
        if (!text.includes(folds[i]!)) continue;
        matched = true;
        folds.splice(i, 1);
      }
      return matched;
    },
    get size(): number { return recent.length + folds.length; },
  };
}
