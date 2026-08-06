/** TUI renderer T4 — the damage-bounded frame writer (mechanism report Q5 perf + Q7 cure 4,
 *  ADAPTED). The pure half under test here:
 *
 *   - `diffFrames(prev, next)` — a LINE differ over already-wrapped frame rows: changed rows only,
 *     rows are opaque strings (ANSI styling included — a styling-only change IS a change), a
 *     row-count shrink yields explicit clear ops for the vanished rows, and — THE PERF PIN — the
 *     op count is bounded by DAMAGE, never by frame height (a 5,000-row pair differing in one row
 *     is exactly one op; asserted mechanically on op COUNT, not timing).
 *
 *   - `renderOps(ops, totalRows)` — the deterministic serializer: one BSU/ESU-wrapped string of
 *     absolute cursor-position (CSI row;1H) + row text + EL (clear-to-EOL) per op, cursor parked
 *     on the frame's last row at the end. Golden-string tests — byte-exact, like the alt-screen
 *     escapes' own tests.
 *
 *  Pure data in, pure string out — no Ink, no React, no stream. The writer/stream half
 *  (`makeDiffingWriter` & co) is tested further down once it exists. */
import { describe, expect, test } from "bun:test";
import { diffFrames, renderOps } from "../../src/tui/frame-diff";

const BSU = "\x1b[?2026h";
const ESU = "\x1b[?2026l";
const pos = (row1: number) => `\x1b[${row1};1H`;
const EL = "\x1b[K";

const rows = (n: number, tag = "R"): string[] => Array.from({ length: n }, (_, i) => `${tag}${i}`);

describe("diffFrames — changed rows only", () => {
  test("identical frames produce ZERO ops", () => {
    const a = ["alpha", "beta", "gamma"];
    expect(diffFrames(a, [...a])).toEqual([]);
  });

  test("identical empty frames produce zero ops", () => {
    expect(diffFrames([], [])).toEqual([]);
  });

  test("a one-line change produces exactly ONE op — the changed row, new text", () => {
    const prev = ["alpha", "beta", "gamma"];
    const next = ["alpha", "BETA", "gamma"];
    expect(diffFrames(prev, next)).toEqual([{ row: 1, text: "BETA" }]);
  });

  test("multiple changed rows come out in ascending row order", () => {
    const prev = ["a", "b", "c", "d"];
    const next = ["A", "b", "c", "D"];
    expect(diffFrames(prev, next)).toEqual([
      { row: 0, text: "A" },
      { row: 3, text: "D" },
    ]);
  });

  test("row-count growth: appended rows are ops with their new text", () => {
    const prev = ["a", "b"];
    const next = ["a", "b", "c", "d"];
    expect(diffFrames(prev, next)).toEqual([
      { row: 2, text: "c" },
      { row: 3, text: "d" },
    ]);
  });

  test("row-count shrink: vanished rows become explicit CLEAR ops (empty text)", () => {
    const prev = ["a", "b", "c", "d"];
    const next = ["a", "b"];
    expect(diffFrames(prev, next)).toEqual([
      { row: 2, text: "" },
      { row: 3, text: "" },
    ]);
  });

  test("ANSI-styled rows are opaque strings — a styling-only change IS a change", () => {
    const prev = ["\x1b[31mred\x1b[39m", "plain"];
    const next = ["\x1b[32mred\x1b[39m", "plain"]; // same visible text, different SGR
    expect(diffFrames(prev, next)).toEqual([{ row: 0, text: "\x1b[32mred\x1b[39m" }]);
  });

  test("defensive: an empty prev never indexes anywhere — every next row is an op", () => {
    expect(diffFrames([], ["x", "y"])).toEqual([
      { row: 0, text: "x" },
      { row: 1, text: "y" },
    ]);
  });

  test("THE PERF PIN: a 5,000-row pair differing in ONE row yields exactly ONE op", () => {
    const prev = rows(5000);
    const next = [...prev];
    next[3123] = "CHANGED";
    const ops = diffFrames(prev, next);
    expect(ops.length).toBe(1); // bounded by damage, never by frame height
    expect(ops[0]).toEqual({ row: 3123, text: "CHANGED" });
  });

  test("perf pin corollary: equal 5,000-row frames yield zero ops", () => {
    const a = rows(5000);
    expect(diffFrames(a, [...a])).toEqual([]);
  });
});

describe("renderOps — deterministic serialization (golden strings)", () => {
  test("zero ops serialize to the EMPTY string — nothing to write at all", () => {
    expect(renderOps([], 10)).toBe("");
  });

  test("one op: BSU + CSI row;1H + text + EL + park-on-last-row + ESU, byte-exact", () => {
    expect(renderOps([{ row: 2, text: "hello" }], 10)).toBe(
      BSU + pos(3) + "hello" + EL + pos(10) + ESU,
    );
  });

  test("multiple ops concatenate in given order inside ONE BSU/ESU envelope", () => {
    expect(renderOps([{ row: 0, text: "top" }, { row: 4, text: "" }], 5)).toBe(
      BSU + pos(1) + "top" + EL + pos(5) + EL + pos(5) + ESU,
    );
  });

  test("clear op (empty text) is position + EL alone", () => {
    expect(renderOps([{ row: 1, text: "" }], 3)).toBe(
      BSU + pos(2) + EL + pos(3) + ESU,
    );
  });

  test("totalRows 0 parks on row 1 (CSI row params are 1-based; 0 would be malformed)", () => {
    expect(renderOps([{ row: 0, text: "x" }], 0)).toBe(
      BSU + pos(1) + "x" + EL + pos(1) + ESU,
    );
  });
});
