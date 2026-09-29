import { expect, test } from "bun:test";
import wrapAnsi from "wrap-ansi";
import { makeDraftWrapper } from "../../src/tui/draft-wrap";
import { makePasteBatch } from "../../src/tui/paste-batch";

test("fragmented repeated pastes are delivered once, before the following Enter", () => {
  const received: string[] = [];
  const batch = makePasteBatch((text) => received.push(text));
  const chunk = "pasted line\r\n".repeat(400);
  for (let i = 0; i < 100; i++) batch.push(chunk);
  expect(received).toEqual([]);
  batch.push("\r");
  expect(received).toEqual([chunk.repeat(100), "\r"]);
  batch.dispose();
});

test("paste batching flushes before editing and preserves repeated paste order", () => {
  const received: string[] = [];
  const batch = makePasteBatch((text) => received.push(text));
  batch.push("first\nsecond");
  batch.push("\x1b[D");
  batch.push("third");
  batch.flush();
  expect(received).toEqual(["first\nsecond", "\x1b[D", "third"]);
  batch.dispose();
});

test("cached draft wrapping preserves Unicode, cursor styling, whitespace, and resize behavior", () => {
  const cached = makeDraftWrapper();
  const draft = "❯ one two three\n\n  中文 👩‍💻 text\n" + "x".repeat(120) + "\n\x1b[7m \x1b[27m";
  for (const width of [20, 40, 20]) {
    for (const text of [draft, draft + "tail", draft.replace("three", "THREE")]) {
      expect(cached(text, width)).toEqual(wrapAnsi(text, width, { hard: true, trim: false }).split("\n"));
    }
  }
});
