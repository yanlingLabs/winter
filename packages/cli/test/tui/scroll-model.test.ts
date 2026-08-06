/** TUI renderer T2 — the pure scroll model for the virtualized transcript viewport (mechanism
 *  report Q1 fullscreen/ScrollBox + Q5 virtualization, ADAPTED). `ScrollState` is bottom-anchored:
 *  `offset` counts rows ABOVE the bottom of the content (0 = at the bottom), `follow` is the
 *  stick-to-bottom flag. Pure data + total functions — no Ink, no React.
 *
 *  Every semantic the plan names is a test here:
 *   - wheel-up leaves follow-mode and scrolls back;
 *   - wheel-down at the bottom re-enters follow;
 *   - clamped at both ends;
 *   - content growth while scrolled back does NOT move the view (`onContentGrown` compensates —
 *     bottom-anchored offsets slide with growth unless compensated);
 *   - `visibleSlice` returns viewport+overscan bounds (OVERSCAN_ROWS = 80, the CC number);
 *   - zero-height viewport and content-shorter-than-viewport degenerate cleanly.
 *
 *  Reference-preservation convention (state.ts / viewport.ts house rule): a no-op transition
 *  returns the SAME object, so callers can cheaply skip redundant setState. */
import { describe, expect, test } from "bun:test";
import type { WheelEvent } from "../../src/tui/input-model";
import {
  applyWheel,
  followBottom,
  onContentGrown,
  OVERSCAN_ROWS,
  scrollToTop,
  visibleSlice,
  type ScrollState,
} from "../../src/tui/scroll-model";

const up = (lines: number): WheelEvent => ({ kind: "wheelUp", lines });
const down = (lines: number): WheelEvent => ({ kind: "wheelDown", lines });
const rows = (n: number): string[] => Array.from({ length: n }, (_, i) => `R${i}`);

describe("applyWheel — wheel-up leaves follow and scrolls back", () => {
  test("from followed bottom: offset grows by the event's lines, follow clears", () => {
    const s = applyWheel(followBottom(), up(3), 10, 50);
    expect(s).toEqual({ offset: 3, follow: false });
  });

  test("accumulates across notches while unfollowed", () => {
    const s1 = applyWheel(followBottom(), up(3), 10, 50);
    const s2 = applyWheel(s1, up(3), 10, 50);
    expect(s2).toEqual({ offset: 6, follow: false });
  });

  test("a stale stored offset under follow=true reads as 0 (follow short-circuits offset)", () => {
    const stale: ScrollState = { offset: 99, follow: true };
    expect(applyWheel(stale, up(3), 10, 50)).toEqual({ offset: 3, follow: false });
  });
});

describe("applyWheel — wheel-down at the bottom re-enters follow", () => {
  test("landing exactly on 0 re-follows", () => {
    expect(applyWheel({ offset: 3, follow: false }, down(3), 10, 50)).toEqual({ offset: 0, follow: true });
  });

  test("overshooting past 0 clamps to 0 and re-follows", () => {
    expect(applyWheel({ offset: 2, follow: false }, down(5), 10, 50)).toEqual({ offset: 0, follow: true });
  });

  test("a wheel-down that does NOT reach the bottom stays unfollowed", () => {
    expect(applyWheel({ offset: 9, follow: false }, down(3), 10, 50)).toEqual({ offset: 6, follow: false });
  });

  test("wheel-down while already followed at the bottom is a no-op returning the SAME reference", () => {
    const s = followBottom();
    expect(Object.is(applyWheel(s, down(3), 10, 50), s)).toBe(true);
  });
});

describe("applyWheel — clamped at both ends", () => {
  test("wheel-up clamps at the top (offset never exceeds contentRows - viewportRows)", () => {
    // 50 rows, 10-row viewport → max offset 40.
    expect(applyWheel({ offset: 38, follow: false }, up(5), 10, 50)).toEqual({ offset: 40, follow: false });
    expect(applyWheel(followBottom(), up(9999), 10, 50)).toEqual({ offset: 40, follow: false });
  });

  test("wheel-down clamps at 0 (covered by re-follow) — and never goes negative from 0 unfollowed", () => {
    expect(applyWheel({ offset: 0, follow: false }, down(3), 10, 50)).toEqual({ offset: 0, follow: true });
  });

  test("an over-max stored offset (content shrank, e.g. verbose retoggle) is re-clamped before applying", () => {
    // 20 rows, 10-row viewport → max offset 10; stored 50 is stale.
    expect(applyWheel({ offset: 50, follow: false }, down(3), 10, 20)).toEqual({ offset: 7, follow: false });
    expect(applyWheel({ offset: 50, follow: false }, up(3), 10, 20)).toEqual({ offset: 10, follow: false });
  });

  test("content shorter than the viewport: nowhere to scroll — offset pinned at 0, but wheel-up STILL unfollows (user intent, the viewport.ts precedent), wheel-down re-follows", () => {
    const unstuck = applyWheel(followBottom(), up(3), 10, 4);
    expect(unstuck).toEqual({ offset: 0, follow: false });
    expect(applyWheel(unstuck, down(3), 10, 4)).toEqual({ offset: 0, follow: true });
  });
});

describe("onContentGrown — growth while scrolled back does not move the view", () => {
  test("follow=true stays pinned to the bottom: SAME reference, offset stays 0", () => {
    const s = followBottom();
    expect(Object.is(onContentGrown(s, 7), s)).toBe(true);
  });

  test("!follow: offset compensates by exactly grownBy", () => {
    expect(onContentGrown({ offset: 5, follow: false }, 7)).toEqual({ offset: 12, follow: false });
  });

  test("the compensated state shows the IDENTICAL rows after an append (the whole point)", () => {
    const before = rows(40);
    const after = [...before, ...rows(7).map((r) => `NEW${r}`)];
    const s: ScrollState = { offset: 5, follow: false };
    const w1 = visibleSlice(before, s, 10, 0);
    const w2 = visibleSlice(after, onContentGrown(s, after.length - before.length), 10, 0);
    expect(after.slice(w2.start, w2.end)).toEqual(before.slice(w1.start, w1.end));
  });

  test("zero / negative growth (no change, or a shrink handled by render-time clamping) is a no-op returning the SAME reference", () => {
    const s: ScrollState = { offset: 5, follow: false };
    expect(Object.is(onContentGrown(s, 0), s)).toBe(true);
    expect(Object.is(onContentGrown(s, -3), s)).toBe(true);
  });
});

describe("visibleSlice — viewport+overscan bounds", () => {
  test("OVERSCAN_ROWS is the CC number, 80 — a named constant, not a magic literal", () => {
    expect(OVERSCAN_ROWS).toBe(80);
  });

  test("followed bottom, no overscan: exactly the last viewportRows rows", () => {
    expect(visibleSlice(rows(100), followBottom(), 10, 0)).toEqual({ start: 90, end: 100 });
  });

  test("scrolled back, no overscan: the window sits `offset` rows above the bottom", () => {
    expect(visibleSlice(rows(1000), { offset: 500, follow: false }, 10, 0)).toEqual({ start: 490, end: 500 });
  });

  test("overscan expands both bounds symmetrically", () => {
    expect(visibleSlice(rows(1000), { offset: 500, follow: false }, 10, OVERSCAN_ROWS)).toEqual({ start: 410, end: 580 });
  });

  test("overscan clamps at the top edge", () => {
    // At the very top: exact window [0, 10) — overscan cannot go above row 0.
    expect(visibleSlice(rows(100), { offset: 90, follow: false }, 10, OVERSCAN_ROWS)).toEqual({ start: 0, end: 90 });
  });

  test("overscan clamps at the bottom edge", () => {
    // Followed bottom: exact window [90, 100) — overscan cannot go past the content end.
    expect(visibleSlice(rows(100), followBottom(), 10, OVERSCAN_ROWS)).toEqual({ start: 10, end: 100 });
  });

  test("an over-max offset clamps to the top window", () => {
    expect(visibleSlice(rows(30), { offset: 9999, follow: false }, 10, 0)).toEqual({ start: 0, end: 10 });
  });

  test("follow ignores any stored offset — always the bottom window", () => {
    expect(visibleSlice(rows(30), { offset: 15, follow: true }, 10, 0)).toEqual({ start: 20, end: 30 });
  });

  test("zero-height viewport: an empty window (start === end), followed or scrolled", () => {
    const atBottom = visibleSlice(rows(50), followBottom(), 0, 0);
    expect(atBottom.start).toBe(atBottom.end);
    const scrolled = visibleSlice(rows(50), { offset: 30, follow: false }, 0, 0);
    expect(scrolled.start).toBe(scrolled.end);
    expect(scrolled).toEqual({ start: 20, end: 20 });
  });

  test("content shorter than the viewport: the whole content, regardless of state", () => {
    expect(visibleSlice(rows(4), followBottom(), 10, 0)).toEqual({ start: 0, end: 4 });
    expect(visibleSlice(rows(4), { offset: 3, follow: false }, 10, 0)).toEqual({ start: 0, end: 4 });
  });

  test("empty content: the empty window", () => {
    expect(visibleSlice([], followBottom(), 10, OVERSCAN_ROWS)).toEqual({ start: 0, end: 0 });
  });
});

describe("followBottom / scrollToTop helpers", () => {
  test("followBottom is the followed bottom state", () => {
    expect(followBottom()).toEqual({ offset: 0, follow: true });
  });

  test("scrollToTop lands on the max offset, unfollowed — visibleSlice then shows the top window", () => {
    const s = scrollToTop(10, 50);
    expect(s).toEqual({ offset: 40, follow: false });
    expect(visibleSlice(rows(50), s, 10, 0)).toEqual({ start: 0, end: 10 });
  });

  test("scrollToTop on content shorter than the viewport: offset 0 (nowhere to go), still unfollowed", () => {
    expect(scrollToTop(10, 4)).toEqual({ offset: 0, follow: false });
  });
});
