import { describe, expect, test } from "bun:test";
import {
  enterAltScreen,
  leaveAltScreen,
  enableMouseTracking,
  disableMouseTracking,
} from "../../src/tui/alt-screen";

// The PagerSpike (T1 scaffold) was removed in Phase 3b Task 7 once the real ctrl+o pager landed —
// its behavioral coverage (toggle, windowing, enter/leave ordering) moved into test/tui/pager.test.tsx,
// which drives the mechanism through the actual <App>. What stays here is the pure escape-sequence
// contract of alt-screen.ts, which the pager relies on verbatim.
//
// Mouse REPORT decoding coverage (`parseMouseInput` / `createMouseReportFilter`) moved to
// test/tui/input-model.test.ts in TUI renderer T1, following its subject: decoding now lives in
// input-model.ts (`decodeMouse` / `createMouseFilter` / `isMouseArtifact`) as part of the input
// layer proper. This file keeps only the tracking-mode escape contract.

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
