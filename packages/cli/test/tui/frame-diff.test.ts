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
import { EventEmitter } from "node:events";
import { diffFrames, extractInkFrame, makeDiffingStdout, makeDiffingWriter, renderOps } from "../../src/tui/frame-diff";

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

// ---------------------------------------------------------------------------------------------
// The stream half: extractInkFrame (Ink's write preludes), makeDiffingWriter (stateful boundary:
// full repaint on first/reset, damage otherwise, viewport clamp), makeDiffingStdout (the proxy
// mount.ts hands Ink). Byte-exact against fakes — no terminal, no Ink instance.
// ---------------------------------------------------------------------------------------------

const ERASE_SCREEN = "\x1b[2J";
// ansi-escapes' building blocks, byte-for-byte (what Ink's writers actually prepend):
const eraseLine = "\x1b[2K";
const cursorUp = "\x1b[1A";
const cursorLeft = "\x1b[G";
const eraseLines = (n: number): string => {
  let s = "";
  for (let i = 0; i < n; i++) s += eraseLine + (i < n - 1 ? cursorUp : "");
  return n > 0 ? s + cursorLeft : s;
};
const CLEAR_TERMINAL = "\x1b[2J\x1b[3J\x1b[H"; // ansi-escapes clearTerminal (non-Windows)

describe("extractInkFrame — stripping Ink's own write prelude", () => {
  test("plain frame with log-update's trailing newline: newline stripped, text untouched", () => {
    expect(extractInkFrame("hello\nworld\n")).toBe("hello\nworld");
  });

  test("eraseLines prelude (steady-state log-update write) is stripped", () => {
    expect(extractInkFrame(eraseLines(3) + "x\ny\n")).toBe("x\ny");
  });

  test("clearTerminal prelude (Ink's taller-than-viewport branch) is stripped", () => {
    expect(extractInkFrame(CLEAR_TERMINAL + "x\n")).toBe("x");
  });

  test("prelude-only chunk (log-update clear()) extracts to the EMPTY frame", () => {
    expect(extractInkFrame(eraseLines(2))).toBe("");
  });

  test("frame styling (SGR) is untouched — only the LEADING prelude run is stripped", () => {
    expect(extractInkFrame(eraseLines(1) + "\x1b[31mred\x1b[39m\n")).toBe("\x1b[31mred\x1b[39m");
  });

  test("interior erase-shaped bytes survive (prefix strip only, never a global scrub)", () => {
    expect(extractInkFrame("a\x1b[2Kb")).toBe("a\x1b[2Kb");
  });

  test("exactly ONE trailing newline is stripped (log-update appends exactly one)", () => {
    expect(extractInkFrame("x\n\n")).toBe("x\n");
    expect(extractInkFrame("x")).toBe("x");
  });
});

function fakeOut(rows?: number): { out: NodeJS.WriteStream; writes: string[] } {
  const writes: string[] = [];
  const out = {
    rows,
    columns: 80,
    isTTY: true,
    write: (chunk: unknown) => { writes.push(String(chunk)); return true; },
  } as unknown as NodeJS.WriteStream;
  return { out, writes };
}

describe("makeDiffingWriter — full repaint on first write and after reset(), else damage", () => {
  test("first write: erase-screen INSIDE the sync envelope + every row + park, byte-exact", () => {
    const { out, writes } = fakeOut();
    makeDiffingWriter(out).write("a\nb");
    expect(writes).toEqual([
      BSU + ERASE_SCREEN + pos(1) + "a" + EL + pos(2) + "b" + EL + pos(2) + ESU,
    ]);
  });

  test("second write: only the damaged row, byte-exact", () => {
    const { out, writes } = fakeOut();
    const w = makeDiffingWriter(out);
    w.write("a\nb");
    w.write("a\nc");
    expect(writes[1]).toBe(BSU + pos(2) + "c" + EL + pos(2) + ESU);
    expect(writes.length).toBe(2);
  });

  test("an identical frame writes NOTHING at all (zero damage ⇒ zero bytes)", () => {
    const { out, writes } = fakeOut();
    const w = makeDiffingWriter(out);
    w.write("a\nb");
    w.write("a\nb");
    expect(writes.length).toBe(1);
  });

  test("row-count shrink: vanished row cleared, park follows the new (shorter) frame", () => {
    const { out, writes } = fakeOut();
    const w = makeDiffingWriter(out);
    w.write("a\nb");
    w.write("a");
    expect(writes[1]).toBe(BSU + pos(2) + EL + pos(1) + ESU);
  });

  test("reset() forces the next write to repaint fully (the SIGWINCH/re-entry contract)", () => {
    const { out, writes } = fakeOut();
    const w = makeDiffingWriter(out);
    w.write("a\nb");
    w.reset();
    w.write("a\nb"); // identical content — but post-reset it must repaint, not diff to zero
    expect(writes.length).toBe(2);
    expect(writes[1]).toBe(
      BSU + ERASE_SCREEN + pos(1) + "a" + EL + pos(2) + "b" + EL + pos(2) + ESU,
    );
  });

  test("empty frame: erase-screen + park on row 1, and prev-state clears diff to it cleanly", () => {
    const { out, writes } = fakeOut();
    const w = makeDiffingWriter(out);
    w.write("");
    expect(writes[0]).toBe(BSU + ERASE_SCREEN + pos(1) + ESU);
    w.write("x");
    w.write("");
    expect(writes[2]).toBe(BSU + pos(1) + EL + pos(1) + ESU); // back to empty = clear row 1
  });

  test("CAUTION 1 — viewport clamp: a frame taller than out.rows is truncated before painting AND before recording", () => {
    const { out, writes } = fakeOut(3);
    const w = makeDiffingWriter(out);
    w.write("r0\nr1\nr2\nr3\nr4"); // 5 rows into a 3-row terminal
    expect(writes[0]).toBe(
      BSU + ERASE_SCREEN + pos(1) + "r0" + EL + pos(2) + "r1" + EL + pos(3) + "r2" + EL + pos(3) + ESU,
    );
    // Recorded prev is the CLAMPED 3 rows: shrinking to 2 rows clears exactly row 3 — never a
    // phantom op for the rows that were never painted (r3/r4).
    w.write("r0\nr1");
    expect(writes[1]).toBe(BSU + pos(3) + EL + pos(2) + ESU);
  });

  test("no out.rows (undefined, e.g. a bare pipe): no clamp — all rows painted", () => {
    const { out, writes } = fakeOut(undefined);
    makeDiffingWriter(out).write("a\nb\nc\nd\ne");
    expect(writes[0]).toContain(pos(5) + "e");
  });
});

describe("makeDiffingStdout — the Ink-facing proxy", () => {
  function fakeRealStream(): { real: NodeJS.WriteStream; writes: string[] } {
    const writes: string[] = [];
    const em = new EventEmitter() as unknown as Record<string, unknown>;
    em.rows = 24;
    em.columns = 80;
    em.isTTY = true;
    em.write = (chunk: unknown) => { writes.push(typeof chunk === "string" ? chunk : `<buf:${String(chunk)}>`); return true; };
    return { real: em as unknown as NodeJS.WriteStream, writes };
  }

  test("Ink's first frame write (no prelude) → full repaint bytes on the real stream", () => {
    const { real, writes } = fakeRealStream();
    const { stream } = makeDiffingStdout(real);
    stream.write("hi\nthere\n");
    expect(writes).toEqual([
      BSU + ERASE_SCREEN + pos(1) + "hi" + EL + pos(2) + "there" + EL + pos(2) + ESU,
    ]);
  });

  test("a steady-state Ink write (eraseLines prelude) diffs to damage only", () => {
    const { real, writes } = fakeRealStream();
    const { stream } = makeDiffingStdout(real);
    stream.write("hi\nthere\n");
    stream.write(eraseLines(3) + "hi\nTHERE\n");
    expect(writes[1]).toBe(BSU + pos(2) + "THERE" + EL + pos(2) + ESU);
  });

  test("log-update clear() (prelude-only chunk) clears every previous row", () => {
    const { real, writes } = fakeRealStream();
    const { stream } = makeDiffingStdout(real);
    stream.write("hi\nthere\n");
    stream.write(eraseLines(3));
    expect(writes[1]).toBe(BSU + pos(1) + EL + pos(2) + EL + pos(1) + ESU);
  });

  test("reset() (mount.ts's resize hook) → the next Ink write repaints fully", () => {
    const { real, writes } = fakeRealStream();
    const { stream, reset } = makeDiffingStdout(real);
    stream.write("a\n");
    reset();
    stream.write(eraseLines(2) + "a\n");
    expect(writes[1]).toBe(BSU + ERASE_SCREEN + pos(1) + "a" + EL + pos(1) + ESU);
  });

  test("non-string chunks pass through to the real stream untouched", () => {
    const { real, writes } = fakeRealStream();
    const { stream } = makeDiffingStdout(real);
    stream.write(Buffer.from("raw") as unknown as string);
    expect(writes[0]).toStartWith("<buf:");
  });

  test("the Writable callback contract is honored on string writes", () => {
    const { real } = fakeRealStream();
    const { stream } = makeDiffingStdout(real);
    let called = 0;
    stream.write("x\n", () => { called += 1; });
    expect(called).toBe(1);
  });

  test("geometry reads live off the real stream; events register on the REAL emitter", () => {
    const { real } = fakeRealStream();
    const { stream } = makeDiffingStdout(real);
    expect(stream.columns).toBe(80);
    (real as unknown as { columns: number }).columns = 120;
    expect(stream.columns).toBe(120); // live, not a snapshot
    let resized = 0;
    stream.on("resize", () => { resized += 1; });
    (real as unknown as EventEmitter).emit("resize");
    expect(resized).toBe(1); // Ink's stdout.on('resize') lands on the real stream
  });
});
