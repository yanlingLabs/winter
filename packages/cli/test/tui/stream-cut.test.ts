/** `stream-cut.ts` (TUI renderer T3) — pure unit tests for `cutCompleteLines`, the single split
 *  every streaming render derives from: everything up to (and including) the LAST newline is
 *  `complete` (settled transcript rows), the remainder is `tail` (the single still-open line).
 *
 *  CRLF note (the plan's "check the wire" item): provider deltas are raw model text — a model
 *  quoting a CRLF file (or a tool transcript echoed into prose) CAN put `\r\n` on the wire, so the
 *  cut is defined purely on `\n` (the universal line terminator): a preceding `\r` stays glued to
 *  its `\n` inside `complete`, and a bare interior `\r` (no `\n` after it yet) is NOT a cut point —
 *  it rides the tail like any other char until its line actually completes. */

import { describe, expect, test } from "bun:test";
import { cutCompleteLines } from "../../src/tui/stream-cut";

describe("cutCompleteLines — split at the last newline", () => {
  test("empty buffer → both halves empty", () => {
    expect(cutCompleteLines("")).toEqual({ complete: "", tail: "" });
  });

  test("no newline → everything is tail", () => {
    expect(cutCompleteLines("streaming wor")).toEqual({ complete: "", tail: "streaming wor" });
  });

  test("trailing newline → everything is complete, tail empty", () => {
    expect(cutCompleteLines("one line\n")).toEqual({ complete: "one line\n", tail: "" });
  });

  test("multi-line with a partial last line → cut after the last newline", () => {
    expect(cutCompleteLines("a\nb\nc")).toEqual({ complete: "a\nb\n", tail: "c" });
  });

  test("multi-line fully terminated → all complete", () => {
    expect(cutCompleteLines("a\nb\nc\n")).toEqual({ complete: "a\nb\nc\n", tail: "" });
  });

  test("a lone newline → one complete empty line", () => {
    expect(cutCompleteLines("\n")).toEqual({ complete: "\n", tail: "" });
  });

  test("leading newline before an open line", () => {
    expect(cutCompleteLines("\nabc")).toEqual({ complete: "\n", tail: "abc" });
  });

  test("blank-line runs stay in complete verbatim", () => {
    expect(cutCompleteLines("para\n\n\nnext")).toEqual({ complete: "para\n\n\n", tail: "next" });
  });

  test("CRLF: the \\r stays glued to its \\n inside complete", () => {
    expect(cutCompleteLines("a\r\nb")).toEqual({ complete: "a\r\n", tail: "b" });
  });

  test("a bare interior \\r (no \\n yet) is not a cut point — it rides the tail", () => {
    expect(cutCompleteLines("a\nb\rc")).toEqual({ complete: "a\n", tail: "b\rc" });
  });

  test("invariants: complete + tail reconstructs the buffer; tail never contains \\n; complete is empty or \\n-terminated", () => {
    const buffers = ["", "x", "x\n", "a\nb", "a\r\nb\r\n", "\n\n", "fence```\nstill open", "a\nb\rc"];
    for (const buffer of buffers) {
      const { complete, tail } = cutCompleteLines(buffer);
      expect(complete + tail).toBe(buffer);
      expect(tail.includes("\n")).toBe(false);
      expect(complete === "" || complete.endsWith("\n")).toBe(true);
    }
  });
});
