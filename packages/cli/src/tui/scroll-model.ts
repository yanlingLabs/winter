/** `scroll-model.ts` (TUI renderer T2) — the pure scroll model for the virtualized transcript
 *  viewport. Mechanism source: the CC fullscreen renderer's ScrollBox + useVirtualScroll shape
 *  (mechanism report Q1 + Q5), ADAPTED to this app's pre-wrapped line-log architecture: rows here
 *  are ALREADY physical terminal lines (`flatten-blocks.ts` wraps at `columns` before anything
 *  scrolls), so virtualization is a plain array-bounds problem — no per-item height estimation.
 *
 *  `ScrollState` is BOTTOM-anchored (the CC sticky-scroll shape, and the reason this supersedes
 *  `viewport.ts`'s top-anchored `scrollTop`): `offset` counts rows above the bottom of the content
 *  (0 = the newest row is the window's last row), `follow` is stick-to-bottom. Follow-mode needs no
 *  bookkeeping at all — offset 0 IS the bottom whatever the content length — but a bottom-anchored
 *  offset SLIDES when content grows while scrolled back (the same absolute rows are now deeper
 *  above the bottom), which is exactly what `onContentGrown` compensates. Consumers therefore:
 *   - feed every wheel notch (a first-class `WheelEvent`, input-model.ts T1) to `applyWheel`;
 *   - report every content-length growth to `onContentGrown` BEFORE slicing that render;
 *   - slice with `visibleSlice`, which also render-time-clamps any stale offset (content shrink —
 *     e.g. a verbose retoggle — never needs a stored-state fixup; `applyWheel` re-clamps too).
 *
 *  Reference preservation (house rule, state.ts/viewport.ts): every no-op transition returns the
 *  SAME object so callers can skip redundant setState with `Object.is`.
 *
 *  No Ink, no React, no side effects — every function is a total, deterministic transform. */

import type { WheelEvent } from "./input-model";

export type ScrollState = { offset: number; follow: boolean };

/** Rows mounted beyond each edge of the exact viewport window by `visibleSlice` callers that keep
 *  a materialized neighborhood (the CC `useVirtualScroll` overscan number). The PAINT path passes
 *  `0` instead — the alt-screen frame is hard-capped at `rows - 1` (app.tsx HARD CONSTRAINT 1) and
 *  Yoga overflow-clipping is banned (HARD CONSTRAINT 2), so overscan rows must never enter the
 *  rendered tree; this constant exists for consumers that PREPARE rows rather than paint them
 *  (T3's stream-settled row handoff, T4's frame differ). */
export const OVERSCAN_ROWS = 80;

/** The followed bottom — the mount/reset state (fresh session, child-view open/close, End key). */
export function followBottom(): ScrollState {
  return { offset: 0, follow: true };
}

/** The largest meaningful offset: with fewer content rows than the viewport there is nowhere to
 *  scroll (0); otherwise the top window sits `contentRows - viewportRows` above the bottom. */
function maxOffset(viewportRows: number, contentRows: number): number {
  return Math.max(0, contentRows - viewportRows);
}

/** The stored offset made effective: follow short-circuits it to 0 (the bottom needs no offset),
 *  and a stale out-of-range value (content shrank since it was stored) clamps into range. */
function effectiveOffset(s: ScrollState, max: number): number {
  return s.follow ? 0 : Math.min(Math.max(0, s.offset), max);
}

/** One wheel notch (or a wheel-shaped key: PgUp/PgDn/ctrl+u ride this too — wheel is a first-class
 *  key, the T1 shape). Semantics, each pinned by `test/tui/scroll-model.test.ts`:
 *   - wheelUp ALWAYS leaves follow-mode — even when clamping means nothing moved (content shorter
 *     than the viewport): the user's intent to scroll away is what matters, the viewport.ts
 *     precedent carried forward;
 *   - wheelDown re-enters follow exactly when the clamped offset lands on 0 (the bottom);
 *   - both directions clamp into `[0, max(0, contentRows - viewportRows)]`. */
export function applyWheel(s: ScrollState, e: WheelEvent, viewportRows: number, contentRows: number): ScrollState {
  const max = maxOffset(viewportRows, contentRows);
  const cur = effectiveOffset(s, max);
  if (e.kind === "wheelUp") {
    const offset = Math.min(cur + e.lines, max);
    if (!s.follow && offset === s.offset) return s;
    return { offset, follow: false };
  }
  const offset = Math.max(0, cur - e.lines);
  const follow = offset === 0;
  if (follow === s.follow && (follow || offset === s.offset)) return s;
  return { offset, follow };
}

/** Content grew by `grownBy` rows (appended at the bottom — the only way this log grows). While
 *  followed the view is pinned to the bottom by construction (offset 0, nothing to do); while
 *  scrolled back the offset compensates by exactly `grownBy` so the view shows the SAME rows —
 *  growth never moves a reader. Zero/negative deltas (no growth, or a shrink such as a verbose
 *  retoggle swapping the whole log) are no-ops: shrink correctness is `visibleSlice`'s render-time
 *  clamp, not stored-state surgery. */
export function onContentGrown(s: ScrollState, grownBy: number): ScrollState {
  if (s.follow || grownBy <= 0) return s;
  return { offset: s.offset + grownBy, follow: false };
}

/** The mounted window over `rows`: the exact `viewportRows`-tall window addressed by `s`, expanded
 *  by `overscan` rows at each edge, clamped into `[0, rows.length]`. `start`/`end` are the usual
 *  half-open slice bounds. Degenerate cases are total: a zero/negative viewport yields an empty
 *  exact window (overscan can still surround it), content shorter than the viewport yields the
 *  whole content whatever the state. */
export function visibleSlice<T>(rows: T[], s: ScrollState, viewportRows: number, overscan: number): { start: number; end: number } {
  const len = rows.length;
  const vh = Math.max(0, viewportRows);
  const max = maxOffset(vh, len);
  const offset = effectiveOffset(s, max);
  const exactEnd = len - offset;
  const exactStart = Math.max(0, exactEnd - vh);
  return { start: Math.max(0, exactStart - overscan), end: Math.min(len, exactEnd + overscan) };
}

/** Jump to the very top (Home on an empty composer). A CONCRETE max offset, not a sentinel: with
 *  `onContentGrown` compensation the view then stays on the top rows as content streams in below
 *  (a sentinel "always top" would be a different, surprising behavior). Always unfollowed — there
 *  is nothing below the top to keep following. */
export function scrollToTop(viewportRows: number, contentRows: number): ScrollState {
  return { offset: maxOffset(Math.max(0, viewportRows), contentRows), follow: false };
}
