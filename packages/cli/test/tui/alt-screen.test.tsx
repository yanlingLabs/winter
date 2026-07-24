import { describe, expect, test } from "bun:test";
import {
  enterAltScreen,
  leaveAltScreen,
  enableMouseTracking,
  disableMouseTracking,
  parseMouseInput,
  createMouseReportFilter,
} from "../../src/tui/alt-screen";

// The PagerSpike (T1 scaffold) was removed in Phase 3b Task 7 once the real ctrl+o pager landed —
// its behavioral coverage (toggle, windowing, enter/leave ordering) moved into test/tui/pager.test.tsx,
// which drives the mechanism through the actual <App>. What stays here is the pure escape-sequence
// contract of alt-screen.ts, which the pager relies on verbatim.

describe("alt-screen escape sequences", () => {
  test("enterAltScreen/leaveAltScreen write the exact escape sequences to the injected sink", () => {
    const sink: string[] = [];
    enterAltScreen((s) => sink.push(s));
    leaveAltScreen((s) => sink.push(s));
    expect(sink).toEqual(["\x1b[?1049h\x1b[2J\x1b[H", "\x1b[?1049l"]);
  });
});

// Phase 3c Task 1 — SGR mouse-wheel tracking, added alongside the alt-screen buffer switch since the
// fullscreen shell wants scroll-wheel support the moment it owns the alternate screen.
describe("mouse tracking escape sequences", () => {
  test("enableMouseTracking/disableMouseTracking write the exact SGR mouse-mode escapes", () => {
    const sink: string[] = [];
    enableMouseTracking((s) => sink.push(s));
    disableMouseTracking((s) => sink.push(s));
    expect(sink).toEqual(["\x1b[?1000h\x1b[?1006h", "\x1b[?1006l\x1b[?1000l"]);
  });
});

describe("parseMouseInput", () => {
  test("wheel up: SGR button code 64", () => {
    expect(parseMouseInput("\x1b[<64;10;5M")).toEqual({ isMouse: true, wheel: { dir: "up" } });
  });

  test("wheel down: SGR button code 65", () => {
    expect(parseMouseInput("\x1b[<65;10;5M")).toEqual({ isMouse: true, wheel: { dir: "down" } });
  });

  test("wheel up/down recognized on button-release form too ('m' terminator)", () => {
    expect(parseMouseInput("\x1b[<64;1;1m")).toEqual({ isMouse: true, wheel: { dir: "up" } });
    expect(parseMouseInput("\x1b[<65;1;1m")).toEqual({ isMouse: true, wheel: { dir: "down" } });
  });

  test("other SGR mouse events (click/release/motion) are swallowed as mouse noise, no wheel", () => {
    expect(parseMouseInput("\x1b[<0;10;5M")).toEqual({ isMouse: true });
    expect(parseMouseInput("\x1b[<0;10;5m")).toEqual({ isMouse: true });
    expect(parseMouseInput("\x1b[<35;42;12M")).toEqual({ isMouse: true }); // motion
    expect(parseMouseInput("\x1b[<32;1;1M")).toEqual({ isMouse: true }); // drag
  });

  test("plain text input passes through untouched", () => {
    expect(parseMouseInput("a")).toEqual({ isMouse: false });
    expect(parseMouseInput("\r")).toEqual({ isMouse: false });
    expect(parseMouseInput("\x1b[A")).toEqual({ isMouse: false }); // arrow-up, not mouse
  });

  test("partial/truncated SGR sequences are not misclassified as mouse", () => {
    expect(parseMouseInput("\x1b[<64;10")).toEqual({ isMouse: false });
    expect(parseMouseInput("\x1b[<")).toEqual({ isMouse: false });
    expect(parseMouseInput("\x1b[64;10;5M")).toEqual({ isMouse: false }); // missing '<'
  });
});

// tui-mouse — a single stdin `readable` chunk can hold MANY batched SGR reports (rapid trackpad
// scroll), or a report can be split across two separate chunks (a read boundary lands mid-report).
// `parseMouseInput`'s ^...$-anchored regex only ever recognizes a chunk that IS exactly one report,
// so either case previously fell through as `{isMouse: false}` for the WHOLE chunk, leaking the raw
// SGR bytes into the composer as literal text. `createMouseReportFilter` is the stateful, chunk-level
// fix: loop-consume every complete report in a chunk, buffer a bounded trailing partial across
// chunks, and return only genuine non-mouse text as `literal`.
describe("createMouseReportFilter — batched/split SGR reports", () => {
  test("a single chunk containing 3 concatenated wheel-up reports yields 3 wheel events and NO literal text", () => {
    const consume = createMouseReportFilter();
    const chunk = "\x1b[<64;10;5M".repeat(3);
    const { literal, wheelEvents } = consume(chunk);
    expect(literal).toBe("");
    expect(wheelEvents).toEqual([{ dir: "up" }, { dir: "up" }, { dir: "up" }]);
  });

  test("mixed batch: wheel-up, wheel-down, and a non-wheel button report all in one chunk", () => {
    const consume = createMouseReportFilter();
    const chunk = "\x1b[<64;10;5M" + "\x1b[<65;11;6M" + "\x1b[<0;12;7M";
    const { literal, wheelEvents } = consume(chunk);
    expect(literal).toBe(""); // the button report is swallowed too, just carries no wheel event
    expect(wheelEvents).toEqual([{ dir: "up" }, { dir: "down" }]);
  });

  test("a report split across two chunks completes on the second chunk with exactly one wheel event", () => {
    const consume = createMouseReportFilter();
    const first = consume("\x1b[<64;10;5"); // missing the trailing 'M'
    expect(first.literal).toBe("");
    expect(first.wheelEvents).toEqual([]); // not yet complete — nothing fires early
    const second = consume("M");
    expect(second.literal).toBe("");
    expect(second.wheelEvents).toEqual([{ dir: "up" }]);
  });

  test("a report split mid-number across two chunks still completes correctly", () => {
    const consume = createMouseReportFilter();
    const first = consume("\x1b[<64;1");
    expect(first.literal).toBe("");
    expect(first.wheelEvents).toEqual([]);
    const second = consume("0;5M");
    expect(second.literal).toBe("");
    expect(second.wheelEvents).toEqual([{ dir: "up" }]);
  });

  test("genuine typed text is untouched when there is no mouse report at all", () => {
    const consume = createMouseReportFilter();
    expect(consume("hello world")).toEqual({ literal: "hello world", wheelEvents: [] });
    expect(consume("[<64;10;5M")).toEqual({ literal: "[<64;10;5M", wheelEvents: [] }); // no real ESC byte
  });

  test("literal text before/after a mouse report in the same chunk survives, report is stripped", () => {
    const consume = createMouseReportFilter();
    const { literal, wheelEvents } = consume("ab" + "\x1b[<64;10;5M" + "cd");
    expect(literal).toBe("abcd");
    expect(wheelEvents).toEqual([{ dir: "up" }]);
  });

  test("a buffered partial that turns out not to be a mouse report is flushed as literal (bounded)", () => {
    const consume = createMouseReportFilter();
    const first = consume("\x1b[<64;1"); // looks like a valid in-progress prefix so far
    expect(first.literal).toBe("");
    // Next chunk breaks the numeric grammar — this was never going to become a report.
    const second = consume("x");
    expect(second.literal).toBe("\x1b[<64;1x");
    expect(second.wheelEvents).toEqual([]);
  });
});
