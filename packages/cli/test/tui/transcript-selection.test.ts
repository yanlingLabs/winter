import { describe, expect, test } from "bun:test";
import { selectedTranscriptText, transcriptLineAt } from "../../src/tui/transcript";
import { followBottom } from "../../src/tui/scroll-model";

describe("transcript mouse selection", () => {
  test("copies visible text without ANSI styling, including a partial multi-line selection", () => {
    const lines = ["\x1b[2m✻ first line\x1b[22m", "second line"];
    expect(selectedTranscriptText(lines, {
      anchor: { line: 0, column: 2 }, focus: { line: 1, column: 6 },
    })).toBe("first line\nsecond");
  });

  test("screen rows map to the live line log, not to the pinned composer", () => {
    const lines = ["one", "two", "three", "four"];
    expect(transcriptLineAt(lines, followBottom(), 3, 1)).toBeNull(); // earlier-lines disclosure
    expect(transcriptLineAt(lines, followBottom(), 3, 2)).toBe(2);
    expect(transcriptLineAt(lines, followBottom(), 3, 3)).toBe(3);
    expect(transcriptLineAt(lines, followBottom(), 3, 4)).toBeNull();
  });
});
