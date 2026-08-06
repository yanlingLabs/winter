import { describe, expect, test } from "bun:test";
import { Chalk } from "chalk";
import { renderMarkdown, splitStableBoundary, loadHighlighter } from "../../src/tui/markdown";
import { theme } from "../../src/tui/theme";

// This suite intentionally builds its own `Chalk({ level: 3 })` instance
// rather than relying on the ambient `chalk` default export. Chalk auto
// detects color support and defaults to level 0 (no ANSI at all) on a
// non-TTY stream — which is what `bun test` runs under — so `chalk.bold("x")
// === "x"` there and any assertion built from the ambient export would be
// vacuous. markdown.ts forces `level: 3` internally for exactly this reason;
// mirroring that here keeps expectations tied to markdown.ts's real output
// instead of to whatever terminal happens to run the suite.
const ansi = new Chalk({ level: 3 });

describe("markdown.ts — renderMarkdown inline styles (a)", () => {
  test("bold, italic, and inline code get their theme styles", () => {
    const out = renderMarkdown("**bold** and *em* and `code`");
    expect(out).toContain(ansi.bold("bold"));
    expect(out).toContain(ansi.italic("em"));
    expect(out).toContain(ansi.hex(theme.permission)("code"));
  });
});

describe("markdown.ts — headings (b)", () => {
  test("depth 1 is bold+italic+underline", () => {
    expect(renderMarkdown("# Title")).toBe(ansi.bold.italic.underline("Title"));
  });

  test("depth 2 and depth 3 are bold only", () => {
    expect(renderMarkdown("## Sub")).toBe(ansi.bold("Sub"));
    expect(renderMarkdown("### SubSub")).toBe(ansi.bold("SubSub"));
  });
});

describe("markdown.ts — blockquote (c)", () => {
  test("each line is prefixed with a dim bar and italicized", () => {
    const out = renderMarkdown("> line one\n> line two");
    const expected = [`${ansi.dim("▎")} ${ansi.italic("line one")}`, `${ansi.dim("▎")} ${ansi.italic("line two")}`].join(
      "\n",
    );
    expect(out).toBe(expected);
  });
});

describe("markdown.ts — nested lists (d)", () => {
  test("unordered lists use `-` bullets with 2-space indent per nesting level", () => {
    const out = renderMarkdown("- item1\n- item2\n  - nested\n");
    expect(out.split("\n")).toEqual(["- item1", "- item2", "  - nested"]);
  });

  test("ordered lists: numeric at depth 0, numeric at depth 1, letters at depth 2, 2-space indent per level", () => {
    const out = renderMarkdown("1. top\n   1. mid\n      1. deep\n");
    expect(out.split("\n")).toEqual(["1. top", "  1. mid", "    a. deep"]);
  });

  test("ordered lists go lowercase roman at depth 3+", () => {
    const out = renderMarkdown("1. l0\n   1. l1\n      1. l2\n         1. l3\n");
    expect(out.split("\n")).toEqual(["1. l0", "  1. l1", "    a. l2", "      i. l3"]);
  });
});

describe("markdown.ts — strikethrough disabled (e)", () => {
  test("~~x~~ is NOT struck through; renders as literal text", () => {
    const out = renderMarkdown("~~strike~~ approx ~5~");
    expect(out).toBe("~~strike~~ approx ~5~");
  });
});

describe("markdown.ts — fenced code blocks (f)", () => {
  test("without a highlighter, the code is preserved verbatim", () => {
    const code = "const x = 1;\nconst y = 2;";
    const out = renderMarkdown("```js\n" + code + "\n```");
    expect(out).toBe(code);
  });

  test("with a highlighter, its output is embedded", () => {
    const code = "const x = 1;";
    const fakeHighlight = (c: string, lang?: string) => `<<${lang}:${c}>>`;
    const out = renderMarkdown("```js\n" + code + "\n```", fakeHighlight);
    expect(out).toBe(`<<js:${code}>>`);
  });
});

describe("markdown.ts — GFM tables (review fix)", () => {
  const TABLE = "| Name | Value |\n| --- | --- |\n| al | 1 |\n| be | 22 |";
  const CELLS = ["Name", "Value", "al", "1", "be", "22"];

  test("a 2x2 table renders ALL cell texts with a separator row (nothing dropped)", () => {
    const out = renderMarkdown(TABLE);
    for (const cell of CELLS) {
      expect(out).toContain(cell);
    }
    // separator row of ─ with ┼ column junctions
    expect(out).toMatch(/─+┼─+/);
    // one line each for header, separator, and the two body rows
    expect(out.split("\n").length).toBe(4);
  });

  test("header cells are bold", () => {
    const out = renderMarkdown(TABLE);
    // Header is the widest cell in each column of this fixture, so header
    // cells carry no padding inside the bold wrap.
    expect(out).toContain(ansi.bold("Name"));
    expect(out).toContain(ansi.bold("Value"));
  });

  test("a table mid-document does not disturb surrounding blocks", () => {
    const out = renderMarkdown(`Before para.\n\n${TABLE}\n\nAfter para.`);
    expect(out.startsWith("Before para.\n\n")).toBe(true);
    expect(out.endsWith("\n\nAfter para.")).toBe(true);
    for (const cell of CELLS) {
      expect(out).toContain(cell);
    }
  });

  test("regression: table output is no longer an empty string", () => {
    const out = renderMarkdown(TABLE);
    expect(out.length).toBeGreaterThan(0);
    for (const cell of CELLS) {
      expect(out).toContain(cell);
    }
  });
});

describe("markdown.ts — splitStableBoundary (g)", () => {
  test("mid-paragraph text with no completed block boundary: everything is tail", () => {
    const text = "just some mid paragraph text with no boundary yet";
    const { stable, tail } = splitStableBoundary(text);
    expect(stable).toBe("");
    expect(tail).toBe(text);
  });

  test("two complete paragraphs + a partial third: first two stable, third is tail", () => {
    const text = "First paragraph complete.\n\nSecond paragraph complete.\n\nThird partial para";
    const { stable, tail } = splitStableBoundary(text);
    expect(stable).toBe("First paragraph complete.\n\nSecond paragraph complete.\n\n");
    expect(tail).toBe("Third partial para");
    expect(stable + tail).toBe(text);
  });

  test("an unclosed fenced code block stays entirely in the tail", () => {
    const text = "Intro paragraph.\n\n```js\nconst x = 1;";
    const { stable, tail } = splitStableBoundary(text);
    expect(stable).toBe("Intro paragraph.\n\n");
    expect(tail).toBe("```js\nconst x = 1;");
    expect(stable + tail).toBe(text);
  });

  test("boundary only advances as text grows (monotonic)", () => {
    const base = "P1.\n\nP2.\n\nGrowing partial";
    const grown = base + " tail that keeps extending the same open paragraph";
    const a = splitStableBoundary(base).stable;
    const b = splitStableBoundary(grown).stable;
    expect(a).toBe("P1.\n\nP2.\n\n");
    expect(b.startsWith(a)).toBe(true);
  });
});

describe("markdown.ts — no-markdown fast path (h)", () => {
  test("plain text with no markdown indicators returns unchanged", () => {
    const text = "This is just plain text without any markdown indicators at all.";
    expect(renderMarkdown(text)).toBe(text);
  });
});

describe("markdown.ts — loadHighlighter", () => {
  test("resolves to a working highlighter for a real language", async () => {
    const highlight = await loadHighlighter();
    const out = highlight("const x = 1;", "javascript");
    expect(typeof out).toBe("string");
    expect(out.length).toBeGreaterThan(0);
  });

  test("never throws: an unknown language degrades to plain text instead of crashing", async () => {
    const highlight = await loadHighlighter();
    const code = "some code";
    expect(() => highlight(code, "not-a-real-language-xyz")).not.toThrow();
    expect(highlight(code, "not-a-real-language-xyz")).toBe(code);
  });
});

// ---------------------------------------------------------------------------------------------
// TUI renderer T3 — createStreamingMarkdown: the incremental streaming renderer (mechanism report
// Q2's StreamingMarkdown shape, adapted). THE contract is byte-equality with `renderMarkdown` at
// every observed prefix — that equality is what makes the turn-end swap (streamed rows → committed
// assistant block, both rendered through this module) a visual no-op.
// ---------------------------------------------------------------------------------------------

import { createStreamingMarkdown } from "../../src/tui/markdown";

/** Feed `text` cumulatively in `chunk`-sized deltas, asserting EVERY intermediate render equals a
 *  fresh `renderMarkdown` of the same prefix (the streamed frame is always the frame a cold render
 *  would produce — the no-glue guarantee's pure half). Returns the final render. */
function streamInChunks(text: string, chunk: number, highlight?: (code: string, lang?: string) => string): string {
  const sm = createStreamingMarkdown();
  let out = "";
  for (let i = chunk; i < text.length + chunk; i += chunk) {
    const prefix = text.slice(0, Math.min(i, text.length));
    out = sm.render(prefix, highlight);
    expect(out).toBe(renderMarkdown(prefix, highlight));
  }
  return out;
}

const STREAM_CORPUS: string[] = [
  "hello world",
  "plain para\n\nwith blank\n\n\nruns and no indicators at all",
  "# Heading\n\nA **bold** para with `code`.\n",
  "para one\n\npara two\n\n- item 1\n- item 2\n  - nested\n\n> quote line\n\n---\n",
  "Intro\n\n```js\nconst x = 1;\nconst y = 2;\n```\n\nAfter",
  "Open fence, never closed:\n\n```python\nfor i in range(3):\n    print(i)",
  "| a | b |\n|---|---|\n| 1 | 2 |\n",
  "start **bold\nacross** end",
  "~approx~ tilde text stays literal",
  "para\n# head\n",
  "Title\n===\nbody after a setext heading",
];

describe("markdown.ts — createStreamingMarkdown equals renderMarkdown at every prefix (T3)", () => {
  test("corpus × chunk sizes: every intermediate and final render is byte-equal to a cold renderMarkdown", () => {
    for (const text of STREAM_CORPUS) {
      for (const chunk of [1, 3, 7, text.length || 1]) {
        expect(streamInChunks(text, chunk)).toBe(renderMarkdown(text));
      }
    }
  });

  test("with a highlighter: fenced code goes through it identically to renderMarkdown", () => {
    const marker = (code: string, lang?: string) => `«${lang ?? "?"}:${code}»`;
    const text = "Intro\n\n```js\nconst x = 1;\n```\n\ndone";
    expect(streamInChunks(text, 5, marker)).toBe(renderMarkdown(text, marker));
  });
});

describe("markdown.ts — streaming open-fence styling (T3: the line-boundary-spanning construct)", () => {
  test("a fence opened in complete lines styles the still-open tail line as code", () => {
    const marker = (code: string, lang?: string) => `«${lang ?? "?"}:${code}»`;
    const sm = createStreamingMarkdown();
    sm.render("```js\ncode1\n", marker);
    const out = sm.render("```js\ncode1\ncod", marker);
    // The partial tail line "cod" is INSIDE the highlighted code payload — never literal text.
    expect(out).toContain("«js:code1\ncod»");
  });
});

describe("markdown.ts — createStreamingMarkdown boundary discipline (T3)", () => {
  test("the stable boundary is monotonic and never advances into an unclosed fence", () => {
    // Indicator-bearing text (`**`) so the renderer leaves the verbatim fast path — plain
    // indicator-free text correctly keeps boundary 0 forever (it never lexes at all).
    const sm = createStreamingMarkdown();
    sm.render("para **one**\n\npara two\n\n");
    const afterParas = sm.boundary();
    expect(afterParas).toBeGreaterThan(0);
    sm.render("para **one**\n\npara two\n\n```js\nline1\n");
    const inFence = sm.boundary();
    expect(inFence).toBeGreaterThanOrEqual(afterParas);
    sm.render("para **one**\n\npara two\n\n```js\nline1\nline2\nline3\n");
    // The unclosed fence is one provisional token — the boundary must not move past its opener.
    expect(sm.boundary()).toBe(inFence);
    expect(sm.boundary()).toBeLessThanOrEqual("para **one**\n\npara two\n\n".length);
  });

  test("a tail-only delta (no newline arrived) never moves the boundary", () => {
    const sm = createStreamingMarkdown();
    sm.render("done `block`\n\nnext para\n\nopen para grows");
    const b = sm.boundary();
    expect(b).toBeGreaterThan(0); // not the fast path — the boundary genuinely advanced
    sm.render("done `block`\n\nnext para\n\nopen para grows and grows");
    expect(sm.boundary()).toBe(b);
  });

  test("a non-append transition (new stream segment) self-heals to the fresh text", () => {
    const sm = createStreamingMarkdown();
    sm.render("first segment **bold**\n\nmore\n\ntail");
    const fresh = "a brand new segment with `code`";
    expect(sm.render(fresh)).toBe(renderMarkdown(fresh));
  });

  test("a highlighter change resets and re-renders correctly", () => {
    const marker = (code: string) => `[hl]${code}[/hl]`;
    const text = "```js\nx\n```\n";
    const sm = createStreamingMarkdown();
    expect(sm.render(text)).toBe(renderMarkdown(text));
    expect(sm.render(text, marker)).toBe(renderMarkdown(text, marker));
  });
});

describe("markdown.ts — createStreamingMarkdown CRLF fallback (T3)", () => {
  test("a buffer containing \\r renders byte-equal to renderMarkdown (full, non-incremental path)", () => {
    const text = "line one\r\nline two\r\n\r\n**bold**";
    const sm = createStreamingMarkdown();
    sm.render("line one\r\n");
    expect(sm.render(text)).toBe(renderMarkdown(text));
  });
});
