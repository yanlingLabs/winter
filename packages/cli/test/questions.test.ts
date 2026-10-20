import { describe, expect, test } from "bun:test";
import { answerPrompt, formatOptionLines, freeTextHintLine, isFreeTextQuestion, isOtherChoice, otherMenuLine, parseQuestionAnswer, questionOptions } from "../src/questions";

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

describe("parseQuestionAnswer", () => {
  test("number → label; comma numbers → joined; free text passthrough; whitespace trimmed", () => {
    const opts = ["Falcon", "Osprey", "Heron"];
    expect(parseQuestionAnswer("2", opts, false)).toBe("Osprey");
    expect(parseQuestionAnswer("1,3", opts, true)).toBe("Falcon, Heron");
    expect(parseQuestionAnswer(" 2 ", opts, false)).toBe("Osprey");
    expect(parseQuestionAnswer("something else", opts, false)).toBe("something else"); // free text (the "Other" path)
    expect(parseQuestionAnswer("9", opts, false)).toBe("9"); // out-of-range number → treated as free text
  });

  test("comma numbers only join when multiSelect is true", () => {
    const opts = ["Falcon", "Osprey", "Heron"];
    // multiSelect false: comma path is never taken, whole string is treated as one token → not a valid number → free text verbatim
    expect(parseQuestionAnswer("1,3", opts, false)).toBe("1,3");
  });

  test("multiSelect with an out-of-range number falls back to free text verbatim", () => {
    const opts = ["Falcon", "Osprey", "Heron"];
    expect(parseQuestionAnswer("1,9", opts, true)).toBe("1,9");
    expect(parseQuestionAnswer("1,abc,9", opts, true)).toBe("1,abc,9");
  });

  // Free-text questions (2026-10-20): a multiSelect question takes typed text WITH its picks — the
  // labels first, then the words, ", "-joined (the one string every Mac surface sends).
  test("multiSelect numbers mixed with typed words → the labels, then the words", () => {
    const opts = ["Falcon", "Osprey", "Heron"];
    expect(parseQuestionAnswer("1,abc", opts, true)).toBe("Falcon, abc");
    expect(parseQuestionAnswer("3, 1, a kestrel, maybe", opts, true)).toBe("Heron, Falcon, a kestrel, maybe");
    expect(parseQuestionAnswer("red, blue", opts, true)).toBe("red, blue"); // no pick: the text, verbatim
    expect(parseQuestionAnswer("1,abc", opts, false)).toBe("1,abc"); // single-select never splits
  });

  test("the 'Other' index (options.length + 1) is out-of-range → free text (raw fallback, pre-isOtherChoice check)", () => {
    const opts = ["Falcon", "Osprey", "Heron"];
    expect(parseQuestionAnswer("4", opts, false)).toBe("4");
  });
});

describe("formatOptionLines — Task 3 (ask_user CC parity: option preview)", () => {
  test("no preview → exactly the pre-existing single option line (byte-identical to before this feature)", () => {
    expect(formatOptionLines(1, { label: "Falcon" })).toEqual(["  1) Falcon\n"]);
  });

  test("description (no preview) → same dim-wrapped description formatting as before this feature", () => {
    expect(formatOptionLines(2, { label: "Osprey", description: "a diving raptor" })).toEqual([
      `  2) Osprey ${DIM}a diving raptor${RESET}\n`,
    ]);
  });

  test("single-line preview → option line unchanged, plus one indented '┆'-rail line", () => {
    expect(formatOptionLines(1, { label: "Falcon", preview: "diff: +12 -3" })).toEqual([
      "  1) Falcon\n",
      "     ┆ diff: +12 -3\n",
    ]);
  });

  test("multi-line preview → one '┆'-rail line PER preview line, in order", () => {
    expect(formatOptionLines(3, { label: "Heron", preview: "line one\nline two\nline three" })).toEqual([
      "  3) Heron\n",
      "     ┆ line one\n",
      "     ┆ line two\n",
      "     ┆ line three\n",
    ]);
  });

  test("description AND preview together — description stays on the option line, preview follows on its own rail lines", () => {
    expect(formatOptionLines(4, { label: "Osprey", description: "a diving raptor", preview: "scheme: light\nscheme: dark" })).toEqual([
      `  4) Osprey ${DIM}a diving raptor${RESET}\n`,
      "     ┆ scheme: light\n",
      "     ┆ scheme: dark\n",
    ]);
  });

  test("empty-string preview is falsy → treated as no preview (no rail lines appended)", () => {
    expect(formatOptionLines(1, { label: "Falcon", preview: "" })).toEqual(["  1) Falcon\n"]);
  });
});

describe("isOtherChoice", () => {
  test("matches exactly the Other menu number (options.length + 1)", () => {
    expect(isOtherChoice("4", 3)).toBe(true);
    expect(isOtherChoice(" 4 ", 3)).toBe(true); // whitespace trimmed
  });

  test("does not match a real option number, a different out-of-range number, or free text", () => {
    expect(isOtherChoice("1", 3)).toBe(false);
    expect(isOtherChoice("3", 3)).toBe(false); // last real option, not Other
    expect(isOtherChoice("9", 3)).toBe(false); // out-of-range but not the Other index
    expect(isOtherChoice("something else", 3)).toBe(false);
    expect(isOtherChoice("4,1", 3)).toBe(false); // comma list, not a bare Other selection
  });
});

describe("free-text questions (2026-10-20)", () => {
  const menu = { header: "H", question: "Which?", options: [{ label: "A" }, { label: "B" }], multiSelect: false };

  test("no options (empty or absent) is a free-text question with no menu", () => {
    expect(isFreeTextQuestion({ question: "Name?", options: [] })).toBe(true);
    expect(isFreeTextQuestion({ question: "Name?" })).toBe(true);
    expect(questionOptions({ question: "Name?" })).toEqual([]);
    expect(isFreeTextQuestion(menu)).toBe(false);
  });

  test("the answer prompt: free text asks for the answer; menus are unchanged", () => {
    expect(answerPrompt({ question: "Name?", options: [] })).toBe("your answer: ");
    expect(answerPrompt(menu)).toBe("choose (number or text): ");
    expect(answerPrompt({ ...menu, multiSelect: true })).toBe("choose (comma-separated numbers or text): ");
  });

  test("the Other line carries the placeholder as its hint, else the old words", () => {
    expect(otherMenuLine(menu)).toBe("  3) Other (type your answer)\n");
    expect(otherMenuLine({ ...menu, placeholder: "a city" })).toBe("  3) Other (a city)\n");
  });

  test("a free-text question's hint line is its placeholder, dim — or nothing", () => {
    expect(freeTextHintLine({ question: "Name?", options: [], placeholder: "e.g. Winter" })).toBe(`  ${DIM}e.g. Winter${RESET}\n`);
    expect(freeTextHintLine({ question: "Name?", options: [] })).toBeNull();
  });
});
