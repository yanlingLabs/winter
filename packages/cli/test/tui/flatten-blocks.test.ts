/** Phase 3c Task 2 — the transcript LINE LOG: `flattenBlock` renders one committed `Block` to
 *  pre-wrapped ANSI lines (every line ≤ `columns` visible columns), and `makeFlattenCache` memoizes
 *  that work across the append-only `TuiState.committed` array so a fullscreen re-render doesn't
 *  re-flatten (re-parse markdown, re-wrap) content that hasn't changed.
 *
 *  Visible-text parity: every case below is the plain-text analog of a 3b `transcript.tsx` /
 *  `group-blocks.ts` assertion (see `test/tui/components.test.tsx` and `test/tui/group-blocks.test.ts`)
 *  — same glyphs, same wording, same caps — now produced as ANSI strings instead of Ink elements.
 *
 *  This suite intentionally builds its own `new Chalk({ level: 3 })` instance (see markdown.test.ts's
 *  header for why): `bun test` runs non-TTY, where the ambient `chalk` default export is level 0.
 */
import { describe, expect, test } from "bun:test";
import { Chalk } from "chalk";
import { flattenBlock, makeFlattenCache, type FlattenOpts } from "../../src/tui/flatten-blocks";
import type { Block } from "../../src/tui/state";

const ansi = new Chalk({ level: 3 });
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");
const opts = (o: Partial<FlattenOpts> = {}): FlattenOpts => ({ columns: 80, verbose: false, ...o });

describe("flattenBlock — every line is ≤ columns visible columns", () => {
  function assertNoOverflow(lines: string[], columns: number) {
    for (const line of lines) expect(stripAnsi(line).length).toBeLessThanOrEqual(columns);
  }

  test("user block", () => {
    const lines = flattenBlock({ kind: "user", text: "hello there" }, opts());
    expect(stripAnsi(lines.join("\n"))).toContain("❯ hello there");
    assertNoOverflow(lines, 80);
  });

  test("assistant block: gutter + markdown-rendered body (bold applied, raw ** gone)", () => {
    const lines = flattenBlock({ kind: "assistant", text: "hi **there**, friend" }, opts());
    const joined = stripAnsi(lines.join("\n"));
    expect(joined).toContain("⏺");
    expect(joined).toContain("hi there, friend");
    expect(lines.join("\n")).not.toContain("**there**");
    expect(lines.join("\n")).toContain(ansi.bold("there")); // markdown bold actually applied
  });

  test("tool block: bold name + (args) + ⎿ result, capped at 10 lines + '+N lines' hint (non-verbose)", () => {
    const output = Array.from({ length: 25 }, (_, i) => `line${i}`).join("\n");
    const lines = flattenBlock(
      { kind: "tool", name: "bash", argsJson: '{"command":"ls -la"}', output, isError: false },
      opts(),
    );
    const joined = stripAnsi(lines.join("\n"));
    expect(joined).toContain("bash");
    expect(joined).toContain('({"command":"ls -la"})');
    expect(lines.join("\n")).toContain(ansi.bold("bash"));
    expect(joined).toContain("⎿");
    for (let i = 0; i < 10; i++) expect(joined).toContain(`line${i}`);
    for (let i = 10; i < 25; i++) expect(joined).not.toContain(`line${i}`);
    expect(joined).toContain("… +15 lines (ctrl+o to expand)");
    assertNoOverflow(lines, 80);
  });

  test("tool block: verbose shows the FULL output, no cap, no hint", () => {
    const output = Array.from({ length: 25 }, (_, i) => `line${i}`).join("\n");
    const lines = flattenBlock(
      { kind: "tool", name: "bash", argsJson: "{}", output },
      opts({ verbose: true }),
    );
    const joined = stripAnsi(lines.join("\n"));
    for (let i = 0; i < 25; i++) expect(joined).toContain(`line${i}`);
    expect(joined).not.toContain("ctrl+o to expand");
  });

  test("tool block: empty output renders only the head line (no ⎿ row at all)", () => {
    const lines = flattenBlock({ kind: "tool", name: "bash", argsJson: "{}", output: "" }, opts());
    expect(stripAnsi(lines.join("\n"))).not.toContain("⎿");
  });

  test("tool block: empty argsJson renders the bare name with no parens", () => {
    const lines = flattenBlock({ kind: "tool", name: "bash", argsJson: "", output: "ok" }, opts());
    expect(stripAnsi(lines.join("\n"))).not.toContain("()");
  });

  test("tool block: errored output still shows content (color-only error state, no 'ERROR:' literal)", () => {
    const lines = flattenBlock({ kind: "tool", name: "bash", argsJson: "{}", output: "boom", isError: true }, opts());
    const joined = stripAnsi(lines.join("\n"));
    expect(joined).toContain("boom");
    expect(joined).not.toContain("ERROR:");
  });

  test("skill block", () => {
    const lines = flattenBlock({ kind: "skill", name: "refactor" }, opts());
    expect(stripAnsi(lines.join("\n"))).toContain("✻ Skill: refactor");
  });

  test("note block: dim ✻ prefix, embedded-newline content passed through untouched (component parity)", () => {
    const lines = flattenBlock({ kind: "note", text: 'Agent "w" finished · 14s\n⎿ Ran 1 tool calls' }, opts());
    const joined = stripAnsi(lines.join("\n"));
    expect(joined).toContain("✻");
    expect(joined).toContain('Agent "w" finished · 14s');
    expect(joined).toContain("Ran 1 tool calls");
  });

  test("turn-summary block: verb + elapsed + token arrows", () => {
    const lines = flattenBlock({ kind: "turn-summary", durationMs: 12_000, inTokens: 13_700, outTokens: 149 }, opts());
    const joined = stripAnsi(lines.join("\n"));
    expect(joined).toContain("✻");
    expect(joined).toContain("for 12s");
    expect(joined).toContain("↑13.7k");
    expect(joined).toContain("↓149");
    expect(joined).toContain("tokens");
  });

  test("interrupted block: exact wording", () => {
    const lines = flattenBlock({ kind: "interrupted" }, opts());
    expect(stripAnsi(lines.join("\n"))).toContain("Interrupted · What should Norma do instead?");
  });
});

describe("flattenBlock — ANSI-aware hard wrap at `columns`", () => {
  test("a styled 200-char content line hard-wraps to exactly 3 lines at content-width 80 (columns=82, gutter=2), bold style reapplied on every wrapped row", () => {
    const text = `**${"x".repeat(200)}**`;
    const lines = flattenBlock({ kind: "assistant", text }, opts({ columns: 82 }));
    expect(lines.length).toBe(3);

    const visible = lines.map(stripAnsi);
    expect(visible[0]).toBe(`⏺ ${"x".repeat(80)}`);
    expect(visible[1]).toBe(`  ${"x".repeat(80)}`);
    expect(visible[2]).toBe(`  ${"x".repeat(40)}`);

    const boldOpen = ansi.bold("Z").split("Z")[0] ?? "";
    expect(boldOpen).not.toBe("");
    for (const line of lines) expect(line).toContain(boldOpen);
    // no visible content lost or duplicated across the wrap
    expect(visible.map((l) => l.replace(/^(⏺ |  )/, "")).join("")).toBe("x".repeat(200));
  });

  test("an unbroken 300-char token (no spaces — e.g. a long path) hard-wraps rather than overflowing", () => {
    const longPath = "p".repeat(300);
    const lines = flattenBlock({ kind: "tool", name: "bash", argsJson: "{}", output: longPath }, opts({ columns: 40 }));
    for (const line of lines) expect(stripAnsi(line).length).toBeLessThanOrEqual(40);
    // reconstructed RESULT content (head line dropped, gutter/blank-prefix stripped) still has all
    // 300 characters, in order — hard:true breaks the token instead of letting any row overflow.
    const resultLines = lines.slice(1); // lines[0] is the "⏺ bash({})" head row
    const reconstructed = resultLines.map((l) => stripAnsi(l).replace(/^(  ⎿  |     )/, "")).join("");
    expect(reconstructed).toBe(longPath);
  });
});

describe("flattenBlock — collapsed-group rendering happens at the cache level (groupBlocks), not here", () => {
  test("flattenBlock never groups on its own: a lone 'read' tool block still renders as a normal tool block", () => {
    const lines = flattenBlock({ kind: "tool", name: "read", argsJson: '{"path":"a.ts"}', output: "ok" }, opts());
    const joined = stripAnsi(lines.join("\n"));
    expect(joined).toContain("read");
    expect(joined).not.toContain("ctrl+o to expand");
  });
});

describe("makeFlattenCache — non-verbose applies groupBlocks (collapsed runs); verbose does not", () => {
  test("non-verbose: a lone read collapses to one dim summary + ctrl+o hint, no per-call args/output", () => {
    const blocks: Block[] = [{ kind: "tool", name: "read", argsJson: '{"path":"a.ts"}', output: "ok" }];
    const cache = makeFlattenCache();
    const joined = stripAnsi(cache.lines(blocks, opts()).join("\n"));
    expect(joined).toContain("⏺");
    expect(joined).toContain("Read 1 file");
    expect(joined).toContain("(ctrl+o to expand)");
    expect(joined).not.toContain('{"path":"a.ts"}');
    expect(joined).not.toContain("ok");
  });

  test("non-verbose: a non-collapsible tool (bash) still renders individually, unaffected by grouping", () => {
    const blocks: Block[] = [{ kind: "tool", name: "bash", argsJson: '{"command":"ls"}', output: "ok" }];
    const cache = makeFlattenCache();
    const joined = stripAnsi(cache.lines(blocks, opts()).join("\n"));
    expect(joined).toContain("bash");
    expect(joined).not.toContain("ctrl+o to expand");
  });

  test("verbose: the SAME blocks expand individually with FULL output, no grouping, no cap", () => {
    const bigOutput = Array.from({ length: 25 }, (_, i) => `out-${i}`).join("\n");
    const blocks: Block[] = [
      { kind: "tool", name: "read", argsJson: '{"path":"a"}', output: "AAA" },
      { kind: "tool", name: "read", argsJson: '{"path":"b"}', output: "BBB" },
      { kind: "tool", name: "bash", argsJson: '{"cmd":"x"}', output: bigOutput },
    ];
    const cache = makeFlattenCache();
    const joined = stripAnsi(cache.lines(blocks, opts({ verbose: true })).join("\n"));
    expect(joined).not.toContain("Read 2 files");
    expect(joined).not.toContain("ctrl+o to expand");
    expect(joined).toContain("AAA");
    expect(joined).toContain("BBB");
    expect(joined).toContain("out-0");
    expect(joined).toContain("out-24");
  });
});

describe("makeFlattenCache — incremental memoization (append-only ⇒ only new indices flatten)", () => {
  function spyCounter() {
    let calls = 0;
    const spy = (b: Block, o: FlattenOpts) => {
      calls++;
      return flattenBlock(b, o);
    };
    return { spy, count: () => calls };
  }

  test("verbose mode: re-flattening the SAME array hits the cache (0 new calls); appending flattens only the new index", () => {
    const { spy, count } = spyCounter();
    const cache = makeFlattenCache(spy);
    const a: Block = { kind: "note", text: "one" };
    const b: Block = { kind: "note", text: "two" };

    cache.lines([a], opts({ verbose: true }));
    expect(count()).toBe(1);

    cache.lines([a], opts({ verbose: true })); // unchanged — must hit cache
    expect(count()).toBe(1);

    cache.lines([a, b], opts({ verbose: true })); // append — only `b` (index 1) is new
    expect(count()).toBe(2);

    cache.lines([a, b], opts({ verbose: true })); // unchanged again
    expect(count()).toBe(2);
  });

  test("non-verbose: a settled 'block' item is cached; the trailing OPEN collapsed run always re-flattens (never freezes stale)", () => {
    const { spy, count } = spyCounter();
    const cache = makeFlattenCache(spy);
    const note: Block = { kind: "note", text: "hello" };
    const read1: Block = { kind: "tool", name: "read", argsJson: '{"path":"a"}', output: "A" };
    const read2: Block = { kind: "tool", name: "read", argsJson: '{"path":"b"}', output: "B" };
    const closer: Block = { kind: "note", text: "done" };

    let out = stripAnsi(cache.lines([note, read1], opts()).join("\n"));
    expect(count()).toBe(1); // only `note` goes through the per-block flatten hook
    expect(out).toContain("Read 1 file");

    out = stripAnsi(cache.lines([note, read1, read2], opts()).join("\n"));
    expect(count()).toBe(1); // still just `note` — the open run's re-flatten never calls the hook
    expect(out).toContain("Read 2 files"); // and it's NOT stale — proves it wasn't cached at "1 file"
    expect(out).not.toContain("Read 1 file");

    out = stripAnsi(cache.lines([note, read1, read2, closer], opts()).join("\n"));
    expect(count()).toBe(2); // `closer` is a new settled block item -> +1 (note still not re-called)
    expect(out).toContain("Read 2 files"); // the now-closed run's summary survives, correctly
  });

  test("opts change (columns or verbose) invalidates the whole cache", () => {
    const { spy, count } = spyCounter();
    const cache = makeFlattenCache(spy);
    const note: Block = { kind: "note", text: "hi" };

    cache.lines([note], opts({ columns: 80 }));
    expect(count()).toBe(1);
    cache.lines([note], opts({ columns: 80 })); // unchanged
    expect(count()).toBe(1);
    cache.lines([note], opts({ columns: 40 })); // columns changed -> full invalidation
    expect(count()).toBe(2);
    cache.lines([note], opts({ columns: 40, verbose: true })); // verbose flip -> full invalidation
    expect(count()).toBe(3);
  });
});

// ---------------------------------------------------------------------------------------------
// TUI renderer T3 — makeStreamRenderer: the in-flight turn as transcript rows. The load-bearing
// pin is SWAP PARITY: after streaming a text in arbitrary chunks, the renderer's assistant rows
// are byte-identical (array-equal) to `flattenBlock({kind:"assistant", text})` — which is exactly
// what the committed block renders at turn end, so the streamed→committed swap repaints nothing.
// ---------------------------------------------------------------------------------------------

import { makeStreamRenderer } from "../../src/tui/flatten-blocks";
import { theme } from "../../src/tui/theme";

const streamOpts = (o: Partial<{ columns: number; dimToolDot: boolean }> = {}) => ({
  columns: 80,
  dimToolDot: false,
  ...o,
});

const SWAP_CORPUS: string[] = [
  "plain reply, no markdown at all",
  "hi **there**, friend",
  "# Title\n\nBody with `code` and a longer paragraph that will wrap when the columns budget is small enough to force it.\n",
  "Intro\n\n```js\nconst x = 1;\n```\n\nAfter",
  "- item 1\n- item 2\n\n> quoted\n\ndone",
  "table:\n\n| a | b |\n|---|---|\n| 1 | 2 |\n",
];

describe("makeStreamRenderer — swap parity with flattenBlock (T3's no-glue pin, pure half)", () => {
  test("after streaming in chunks, assistant rows array-equal the committed assistant block's rows", () => {
    for (const text of SWAP_CORPUS) {
      for (const chunk of [1, 4, text.length]) {
        const r = makeStreamRenderer();
        let rows: string[] = [];
        for (let i = chunk; i < text.length + chunk; i += chunk) {
          rows = r.lines(text.slice(0, Math.min(i, text.length)), [], streamOpts());
        }
        expect(rows).toEqual(flattenBlock({ kind: "assistant", text }, opts()));
      }
    }
  });

  test("swap parity holds with a highlighter and at a narrow width", () => {
    const marker = (code: string, lang?: string) => `«${lang ?? "?"}:${code}»`;
    const text = "Intro paragraph that wraps at narrow widths for sure.\n\n```js\nconst long = 1;\n```\n";
    const r = makeStreamRenderer();
    let rows: string[] = [];
    for (let i = 3; i < text.length + 3; i += 3) {
      rows = r.lines(text.slice(0, Math.min(i, text.length)), [], { ...streamOpts({ columns: 24 }), highlight: marker });
    }
    expect(rows).toEqual(flattenBlock({ kind: "assistant", text }, opts({ columns: 24, highlight: marker })));
  });
});

describe("makeStreamRenderer — per-delta row stability (T3: only the open segment re-renders)", () => {
  test("a tail-only delta leaves every row above the open segment byte-identical", () => {
    const r = makeStreamRenderer();
    const settled = "First **para** settled.\n\nSecond para settled.\n\n";
    const before = r.lines(`${settled}open tail grows`, [], streamOpts());
    const after = r.lines(`${settled}open tail grows more`, [], streamOpts());
    // The settled blocks' rows (everything except the open paragraph's own rows) are unchanged.
    const settledRowCount = before.length - 1; // the open para renders as its single last row here
    expect(after.slice(0, settledRowCount)).toEqual(before.slice(0, settledRowCount));
  });
});

describe("makeStreamRenderer — in-flight tool rows (the activeTurnLines shape carried forward)", () => {
  test("tool head: gutter dot + bold name + (argsHead); dot dims on dimToolDot", () => {
    const r = makeStreamRenderer();
    const tools = [{ name: "bash", argsJson: '{"command":"ls"}' }];
    const normal = r.lines("", tools, streamOpts({ dimToolDot: false }));
    expect(normal.length).toBe(1);
    expect(stripAnsi(normal[0]!)).toBe('⏺ bash({"command":"ls"})');
    expect(normal[0]!).toContain(ansi.bold("bash"));
    const dimmed = r.lines("", tools, streamOpts({ dimToolDot: true }));
    expect(dimmed[0]!).toContain(ansi.dim("⏺"));
  });

  test("assistant rows precede tool rows; idle (no text, no tools) renders []", () => {
    const r = makeStreamRenderer();
    expect(r.lines("", [], streamOpts())).toEqual([]);
    const rows = r.lines("thinking out loud", [{ name: "read", argsJson: "{}" }], streamOpts());
    expect(stripAnsi(rows[0]!)).toContain("thinking out loud");
    expect(stripAnsi(rows[rows.length - 1]!)).toContain("read");
  });

  test("every row respects the columns budget", () => {
    const r = makeStreamRenderer();
    const rows = r.lines(
      "A rather long streaming paragraph with **inline** styling that must hard-wrap at the narrow budget.",
      [{ name: "bash", argsJson: JSON.stringify({ command: "echo " + "x".repeat(120) }) }],
      streamOpts({ columns: 30 }),
    );
    for (const row of rows) expect(stripAnsi(row).length).toBeLessThanOrEqual(30);
    void theme;
  });
});
