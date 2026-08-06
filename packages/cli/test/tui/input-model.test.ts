import { describe, expect, test } from "bun:test";
import {
  backspace,
  createMouseFilter,
  decodeMouse,
  del,
  end,
  home,
  insert,
  isMouseArtifact,
  left,
  renderWithCursor,
  right,
  WHEEL_SCROLL_LINES,
  wordLeft,
  wordRight,
  type InputState,
  type WheelEvent,
} from "../../src/tui/input-model";

const s = (text: string, cursor: number): InputState => ({ text, cursor });

describe("input-model", () => {
  describe("insert", () => {
    test("inserts at the cursor, moving it past the inserted text", () => {
      expect(insert(s("ac", 1), "b")).toEqual({ text: "abc", cursor: 2 });
    });
    test("inserts a whole pasted string as one op", () => {
      expect(insert(s("", 0), "hello")).toEqual({ text: "hello", cursor: 5 });
    });
    test("empty insert is a no-op (same state)", () => {
      const state = s("ab", 1);
      expect(insert(state, "")).toBe(state);
    });
    test("inserts at the end", () => {
      expect(insert(s("ab", 2), "c")).toEqual({ text: "abc", cursor: 3 });
    });
    test("inserts at the start", () => {
      expect(insert(s("bc", 0), "a")).toEqual({ text: "abc", cursor: 1 });
    });
  });

  describe("backspace", () => {
    test("removes the char before the cursor", () => {
      expect(backspace(s("abc", 3))).toEqual({ text: "ab", cursor: 2 });
    });
    test("removes a mid-text char", () => {
      expect(backspace(s("abc", 2))).toEqual({ text: "ac", cursor: 1 });
    });
    test("no-op at cursor 0", () => {
      const state = s("abc", 0);
      expect(backspace(state)).toBe(state);
    });
    test("no-op on empty text", () => {
      const state = s("", 0);
      expect(backspace(state)).toBe(state);
    });
  });

  describe("del", () => {
    test("removes the char at the cursor, cursor unchanged", () => {
      expect(del(s("abc", 0))).toEqual({ text: "bc", cursor: 0 });
    });
    test("removes a mid-text char", () => {
      expect(del(s("abc", 1))).toEqual({ text: "ac", cursor: 1 });
    });
    test("no-op at end of text", () => {
      const state = s("abc", 3);
      expect(del(state)).toBe(state);
    });
    test("no-op on empty text", () => {
      const state = s("", 0);
      expect(del(state)).toBe(state);
    });
  });

  describe("left/right", () => {
    test("left moves back one", () => {
      expect(left(s("abc", 2))).toEqual({ text: "abc", cursor: 1 });
    });
    test("left no-op at 0", () => {
      const state = s("abc", 0);
      expect(left(state)).toBe(state);
    });
    test("right moves forward one", () => {
      expect(right(s("abc", 1))).toEqual({ text: "abc", cursor: 2 });
    });
    test("right no-op at end", () => {
      const state = s("abc", 3);
      expect(right(state)).toBe(state);
    });
  });

  describe("home/end", () => {
    test("home jumps to 0", () => {
      expect(home(s("abc", 2))).toEqual({ text: "abc", cursor: 0 });
    });
    test("home no-op already at 0", () => {
      const state = s("abc", 0);
      expect(home(state)).toBe(state);
    });
    test("end jumps to text.length", () => {
      expect(end(s("abc", 1))).toEqual({ text: "abc", cursor: 3 });
    });
    test("end no-op already at end", () => {
      const state = s("abc", 3);
      expect(end(state)).toBe(state);
    });
  });

  describe("wordLeft/wordRight (whitespace-delimited)", () => {
    test("wordLeft from end of last word lands at its start", () => {
      expect(wordLeft(s("foo bar", 7))).toEqual({ text: "foo bar", cursor: 4 });
    });
    test("wordLeft skips trailing whitespace before jumping", () => {
      expect(wordLeft(s("foo bar   ", 10))).toEqual({ text: "foo bar   ", cursor: 4 });
    });
    test("wordLeft from mid-word lands at that word's start", () => {
      expect(wordLeft(s("foo bar", 5))).toEqual({ text: "foo bar", cursor: 4 });
    });
    test("wordLeft from the first word lands at 0", () => {
      expect(wordLeft(s("foo bar", 2))).toEqual({ text: "foo bar", cursor: 0 });
    });
    test("wordLeft no-op at 0", () => {
      const state = s("foo bar", 0);
      expect(wordLeft(state)).toBe(state);
    });
    test("wordRight from start of first word lands after it", () => {
      expect(wordRight(s("foo bar", 0))).toEqual({ text: "foo bar", cursor: 3 });
    });
    test("wordRight skips leading whitespace before jumping", () => {
      expect(wordRight(s("foo   bar", 3))).toEqual({ text: "foo   bar", cursor: 9 });
    });
    test("wordRight from the last word lands at text.length", () => {
      expect(wordRight(s("foo bar", 5))).toEqual({ text: "foo bar", cursor: 7 });
    });
    test("wordRight no-op at end", () => {
      const state = s("foo bar", 7);
      expect(wordRight(state)).toBe(state);
    });
  });

  describe("non-ASCII basics (single-code-unit BMP chars — see input-model.ts's documented grapheme limitation)", () => {
    test("insert/backspace round-trip on accented text", () => {
      const typed = insert(s("", 0), "café");
      expect(typed).toEqual({ text: "café", cursor: 4 });
      expect(backspace(typed)).toEqual({ text: "caf", cursor: 3 }); // é is one code unit — removed whole
    });
    test("cursor ops treat an accented char as one position", () => {
      const state = s("café", 4);
      expect(left(state)).toEqual({ text: "café", cursor: 3 }); // now sitting on "é"
      expect(renderWithCursor(left(state))).toEqual({ before: "caf", at: "é", after: "" });
      expect(del(left(state))).toEqual({ text: "caf", cursor: 3 });
    });
    test("wordLeft over non-ASCII words", () => {
      expect(wordLeft(s("crème brûlée", 12))).toEqual({ text: "crème brûlée", cursor: 6 });
    });
  });

  // ---- TUI renderer T1: mouse decoding at the input layer (plan Task 1; mechanism report Q3 +
  // Q7 cure 3). mount.ts enables SGR mouse reporting (\x1b[?1000h\x1b[?1006h), so a wheel notch
  // makes the terminal write "\x1b[<64;COL;ROWM" (up) / "\x1b[<65;COL;ROWM" (down) to stdin; a
  // terminal that supports 1000 but NOT 1006 answers in the legacy X10 format instead: "\x1b[M"
  // plus three payload bytes (button+32, col+32, row+32). Wheel is decoded into a first-class
  // event; every OTHER mouse report is mouse noise to swallow — never text. ----
  describe("decodeMouse", () => {
    const up: WheelEvent = { kind: "wheelUp", lines: WHEEL_SCROLL_LINES };
    const down: WheelEvent = { kind: "wheelDown", lines: WHEEL_SCROLL_LINES };

    test("SGR wheel-up: \\x1b[<64;10;5M", () => {
      expect(decodeMouse("\x1b[<64;10;5M")).toEqual(up);
    });
    test("SGR wheel-down: \\x1b[<65;10;5M", () => {
      expect(decodeMouse("\x1b[<65;10;5M")).toEqual(down);
    });
    test("SGR wheel on the release terminator 'm' still decodes (terminal variance)", () => {
      expect(decodeMouse("\x1b[<64;1;1m")).toEqual(up);
      expect(decodeMouse("\x1b[<65;1;1m")).toEqual(down);
    });
    test("modifier bits held during a wheel (shift=4 / alt=8 / ctrl=16) stay a wheel", () => {
      expect(decodeMouse("\x1b[<68;10;5M")).toEqual(up); // shift+wheel-up
      expect(decodeMouse("\x1b[<72;10;5M")).toEqual(up); // alt+wheel-up
      expect(decodeMouse("\x1b[<80;10;5M")).toEqual(up); // ctrl+wheel-up
      expect(decodeMouse("\x1b[<69;10;5M")).toEqual(down); // shift+wheel-down
    });
    test("ESC-stripped remnants decode too — Ink's use-input strips ONE leading ESC before any consumer sees input", () => {
      expect(decodeMouse("[<64;116;23M")).toEqual(up); // the observed live leak shape
      expect(decodeMouse("<65;10;5M")).toEqual(down); // split after \x1b[ at a chunk boundary
    });
    test("click/release/motion/drag SGR reports → null (mouse, not wheel — swallowed, NOT text)", () => {
      expect(decodeMouse("\x1b[<0;10;5M")).toBeNull(); // left-button press
      expect(decodeMouse("\x1b[<0;10;5m")).toBeNull(); // left-button release
      expect(decodeMouse("\x1b[<35;42;12M")).toBeNull(); // motion
      expect(decodeMouse("\x1b[<32;1;1M")).toBeNull(); // drag
    });
    test("legacy X10 (CSI M) wheel: payload button byte 96 → up, 97 → down", () => {
      expect(decodeMouse("\x1b[M\x60\x21\x21")).toEqual(up);
      expect(decodeMouse("\x1b[M\x61\x21\x21")).toEqual(down);
      expect(decodeMouse("[M\x60\x21\x21")).toEqual(up); // ESC-stripped remnant form
    });
    test("legacy X10 click/release → null (swallowed mouse noise)", () => {
      expect(decodeMouse("\x1b[M\x20\x21\x21")).toBeNull(); // button-0 press
      expect(decodeMouse("\x1b[M\x23\x21\x21")).toBeNull(); // release
    });
    test("partial CSI and plain text → null (routing decides swallowing — decode never invents a wheel)", () => {
      expect(decodeMouse("\x1b[<64;10")).toBeNull();
      expect(decodeMouse("\x1b[<")).toBeNull();
      expect(decodeMouse("\x1b[A")).toBeNull(); // arrow-up, not mouse
      expect(decodeMouse("abc")).toBeNull();
      expect(decodeMouse("")).toBeNull();
    });
  });

  describe("isMouseArtifact (the composer's never-insert guard)", () => {
    test("the historically observed composer leak string IS an artifact", () => {
      expect(isMouseArtifact("[<64;116;23M16;23M16;23M")).toBe(true);
    });
    test("full and ESC-stripped single reports", () => {
      expect(isMouseArtifact("\x1b[<64;1;1M")).toBe(true);
      expect(isMouseArtifact("[<65;10;5M")).toBe(true);
      expect(isMouseArtifact("<0;10;5m")).toBe(true);
    });
    test("batched reports with interior raw ESC bytes", () => {
      expect(isMouseArtifact("[<65;10;5M\x1b[<65;10;6M")).toBe(true);
    });
    test("legacy X10 remnants", () => {
      expect(isMouseArtifact("[M\x60\x21\x21")).toBe(true);
      expect(isMouseArtifact("\x1b[M\x20\x21\x21")).toBe(true);
    });
    test("genuine text is NEVER an artifact (pastes must keep typing)", () => {
      expect(isMouseArtifact("hello")).toBe(false);
      expect(isMouseArtifact("3M")).toBe(false); // a real company name, not a mouse report
      expect(isMouseArtifact("1;2M")).toBe(false); // digit-run without a mouse head is text
      expect(isMouseArtifact("see [<64;1;1M here")).toBe(false); // artifact-looking substring inside prose
      expect(isMouseArtifact("<html>")).toBe(false);
      expect(isMouseArtifact("")).toBe(false);
    });
  });

  describe("createMouseFilter (stateful chunk router at the input layer)", () => {
    const up: WheelEvent = { kind: "wheelUp", lines: WHEEL_SCROLL_LINES };
    const down: WheelEvent = { kind: "wheelDown", lines: WHEEL_SCROLL_LINES };

    test("REAL-LEAK REGRESSION: a report split inside its 3-byte ESC prefix reassembles — zero bytes become text", () => {
      // A fast trackpad flick fills the pty buffer; the read boundary can land anywhere in the
      // 12-byte report — including right after the bare ESC. The OLD filter (alt-screen.ts) only
      // searched for the full "\x1b[<" prefix, so it forwarded the trailing "\x1b" as a spurious
      // Esc AND the next chunk's "[<64;116;23M" continuation verbatim as literal text — the
      // user-reported wheel-into-composer bytes.
      const f = createMouseFilter();
      expect(f("\x1b[<64;1;1M\x1b")).toEqual({ text: "", wheel: [up] });
      expect(f("[<64;116;23M")).toEqual({ text: "", wheel: [up] });
    });
    test("split after \\x1b[ likewise reassembles", () => {
      const f = createMouseFilter();
      expect(f("\x1b[<65;1;1M\x1b[")).toEqual({ text: "", wheel: [down] });
      expect(f("<65;10;5M")).toEqual({ text: "", wheel: [down] });
    });
    test("a cold lone ESC (a human Esc press) passes through immediately — never held, never delayed", () => {
      const f = createMouseFilter();
      expect(f("\x1b")).toEqual({ text: "\x1b", wheel: [] });
    });
    test("three concatenated wheel-ups in one chunk yield three wheel events and no text", () => {
      const f = createMouseFilter();
      expect(f("\x1b[<64;10;5M\x1b[<64;10;6M\x1b[<64;10;7M")).toEqual({ text: "", wheel: [up, up, up] });
    });
    test("mixed batch: wheel-up, wheel-down, and a click — click swallowed, no text", () => {
      const f = createMouseFilter();
      expect(f("\x1b[<64;3;4M\x1b[<65;3;5M\x1b[<0;3;5M")).toEqual({ text: "", wheel: [up, down] });
    });
    test("a report split after the full prefix completes on the next chunk (old pin, kept)", () => {
      const f = createMouseFilter();
      expect(f("\x1b[<64;10;5")).toEqual({ text: "", wheel: [] });
      expect(f("M")).toEqual({ text: "", wheel: [up] });
    });
    test("a report split mid-number completes on the next chunk (old pin, kept)", () => {
      const f = createMouseFilter();
      expect(f("\x1b[<64;1")).toEqual({ text: "", wheel: [] });
      expect(f("0;5M")).toEqual({ text: "", wheel: [up] });
    });
    test("literal text before/after a report in the same chunk survives, report stripped", () => {
      const f = createMouseFilter();
      expect(f("ab\x1b[<64;10;5Mcd")).toEqual({ text: "abcd", wheel: [up] });
    });
    test("plain text with no mouse bytes is untouched", () => {
      const f = createMouseFilter();
      expect(f("hello world")).toEqual({ text: "hello world", wheel: [] });
    });
    test("a broken partial CSI followed by printable text yields ONLY the text — the dead prefix never inserts", () => {
      // The OLD filter flushed the dead prefix as literal ("\x1b[<64;1x" reached the composer);
      // the plan's contract: unknown/partial CSI must NEVER fall through to text insertion.
      const f = createMouseFilter();
      expect(f("\x1b[<64;1")).toEqual({ text: "", wheel: [] });
      expect(f("x")).toEqual({ text: "x", wheel: [] });
    });
    test("legacy X10 wheel reports are consumed — whole and split across chunks", () => {
      const f = createMouseFilter();
      expect(f("\x1b[M\x60\x21\x21")).toEqual({ text: "", wheel: [up] });
      expect(f("\x1b[M\x61")).toEqual({ text: "", wheel: [] }); // partial: held
      expect(f("\x21\x21")).toEqual({ text: "", wheel: [down] });
    });
    test("legacy X10 clicks are swallowed, not text", () => {
      const f = createMouseFilter();
      expect(f("\x1b[M\x20\x21\x21")).toEqual({ text: "", wheel: [] });
    });
    test("non-mouse CSI (arrows etc.) passes through byte-identical — real keys keep working", () => {
      const f = createMouseFilter();
      expect(f("\x1b[A")).toEqual({ text: "\x1b[A", wheel: [] });
      expect(f("\x1b[3~")).toEqual({ text: "\x1b[3~", wheel: [] });
    });
    test("a held ambiguous ESC that turns out to be a real keypress is forwarded on the next chunk", () => {
      const f = createMouseFilter();
      expect(f("\x1b[<64;1;1M\x1b")).toEqual({ text: "", wheel: [up] }); // ESC held (mouse context)
      expect(f("hello")).toEqual({ text: "\x1bhello", wheel: [] }); // not a continuation — flushed intact
    });
  });

  describe("renderWithCursor", () => {
    test("splits before/at/after around a mid-text cursor", () => {
      expect(renderWithCursor(s("abc", 1))).toEqual({ before: "a", at: "b", after: "c" });
    });
    test("at is '' when cursor is past the last character", () => {
      expect(renderWithCursor(s("abc", 3))).toEqual({ before: "abc", at: "", after: "" });
    });
    test("empty text: everything is ''", () => {
      expect(renderWithCursor(s("", 0))).toEqual({ before: "", at: "", after: "" });
    });
    test("cursor at 0 on non-empty text", () => {
      expect(renderWithCursor(s("abc", 0))).toEqual({ before: "", at: "a", after: "bc" });
    });
  });
});
