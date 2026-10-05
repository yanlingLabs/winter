// The thinking pill's title rule, hardened (review r1): linear-time patterns (audited and fuzzed on a
// time budget), headings that name files, engine-independent Unicode handling, persisted titles that
// equal the whole-text derivation, and CJK reasoning. The phone engine's Swift port runs the same
// cases (`apple/WinterChatKit/Tests/WinterChatKitTests/ThinkingTitleRuleTests.swift`).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ThinkingKind } from "@yanlinglabs/winter-protocol";
import { ThinkingBlocks, deriveThinkingTitle, type ReasoningProgressFrame } from "../../src/projector/thinking";
import { TITLE_PATTERNS, activityTitleOf, lastValidHeading } from "../../src/projector/thinking-title";

interface FixtureBlock { id: string; kind: ThinkingKind; title: string | null; text: string }
const fixture = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "thinking-titles.json"), "utf8")) as { blocks: FixtureBlock[] };
const final = (text: string): string | undefined => activityTitleOf(text, true);
const live = (text: string): string | undefined => activityTitleOf(text, false);

describe("the bold rule accepts real headings that NAME a file or code", () => {
  test("a file name, a dotted name or inline code inside a heading is fine; a heading that IS only one is not", () => {
    expect(lastValidHeading("**Inspecting package.json scripts**\n\nbody")).toBe("Inspecting package.json scripts");
    expect(lastValidHeading("**Reviewing Node.js setup**\n\nbody")).toBe("Reviewing Node.js setup");
    expect(lastValidHeading("**Checking `foo` usage**\n\nbody")).toBe("Checking `foo` usage");
    expect(lastValidHeading("**Comparing src/a.ts and src/b.ts**\n\nbody")).toBe("Comparing src/a.ts and src/b.ts");
    for (const t of ["**src/calc.js:**", "**src/calc.js**", "**`calc.js`**", "**test/calc.test.js**"]) expect(lastValidHeading(`${t}\nbody`)).toBeUndefined();
  });

  test("a heading on a line no line break has closed yet is provisional (includeOpenLine)", () => {
    expect(lastValidHeading("**Foo**")).toBe("Foo");
    expect(lastValidHeading("**Foo**", false)).toBeUndefined();
    expect(lastValidHeading("**Foo**\n", false)).toBe("Foo");
  });
});

/** Every nested or adjacent unbounded quantifier in a regex source: a quantified group whose body holds
 *  an unbounded quantifier, or two unbounded atoms with only optional atoms between them — the shapes
 *  that backtrack super-linearly. An approximation that errs toward flagging. */
function quantifierHazards(src: string): string[] {
  const hazards: string[] = [];
  interface Shape { startsUnbounded: boolean; endsUnbounded: boolean; hasUnbounded: boolean }
  const skipClass = (s: string, i: number): number => {          // i at '[' → index just past ']'
    let j = i + 1;
    while (j < s.length && s[j] !== "]") { if (s[j] === "\\") j += 1; j += 1; }
    return j + 1;
  };
  const groupEnd = (s: string, i: number): number => {           // i at '(' → index just past ')'
    let depth = 0;
    for (let j = i; j < s.length; j++) {
      const c = s[j];
      if (c === "\\") { j += 1; continue; }
      if (c === "[") { j = skipClass(s, j) - 1; continue; }
      if (c === "(") depth += 1;
      else if (c === ")") { depth -= 1; if (depth === 0) return j + 1; }
    }
    return s.length;
  };
  const scan = (s: string): Shape => {
    const shape: Shape = { startsUnbounded: false, endsUnbounded: false, hasUnbounded: false };
    let prevEnds = false;
    let first = true;
    let i = 0;
    while (i < s.length) {
      const c = s[i]!;
      if (c === "|") { prevEnds = false; first = true; i += 1; continue; }
      let atom: Shape = { startsUnbounded: false, endsUnbounded: false, hasUnbounded: false };
      let zeroWidth = false;
      let isGroup = false;
      if (c === "\\") i += 2;
      else if (c === "[") i = skipClass(s, i);
      else if (c === "(") {
        isGroup = true;
        const end = groupEnd(s, i);
        let body = s.slice(i + 1, end - 1);
        if (/^\?(?:[=!]|<[=!])/.test(body)) zeroWidth = true;
        body = body.replace(/^\?(?:[:=!]|<[=!]|<[a-zA-Z]+>)/, "");
        atom = scan(body);
        i = end;
      } else if (c === "^" || c === "$") { zeroWidth = true; i += 1; }
      else i += 1;
      let unbounded = false;
      let optional = zeroWidth;
      const q = s[i];
      if (q === "*" || q === "+") { unbounded = true; optional ||= q === "*"; i += 1; }
      else if (q === "?") { optional = true; i += 1; }
      else if (q === "{") {
        const close = s.indexOf("}", i);
        const body = s.slice(i + 1, close);
        if (/^\d+,$/.test(body)) unbounded = true;
        if (/^0(?:,|$)/.test(body)) optional = true;
        i = close + 1;
      }
      if (q !== undefined && "*+?}".includes(q) && (s[i] === "?" || s[i] === "+")) i += 1;   // lazy / possessive
      if (unbounded && atom.hasUnbounded) hazards.push(`nested unbounded quantifier in ${src}`);
      if (isGroup && zeroWidth) {
        // A lookaround between two runs pins where the first may stop — it delimits like a literal.
        shape.hasUnbounded ||= atom.hasUnbounded;
        prevEnds = false;
        continue;
      }
      // A single atom under `*`/`+` starts and ends an unbounded run; a group's run starts and ends with
      // its body's (a repeated group whose body ends in a required literal is delimited by it).
      const starts = isGroup ? atom.startsUnbounded : unbounded;
      const ends = isGroup ? atom.endsUnbounded : unbounded;
      if (prevEnds && starts) hazards.push(`adjacent unbounded quantifiers in ${src}`);
      shape.hasUnbounded ||= unbounded || atom.hasUnbounded;
      if (first && !zeroWidth) shape.startsUnbounded ||= starts;
      if (!zeroWidth) first = false;
      if (ends) prevEnds = true;
      else if (!optional) prevEnds = false;
      shape.endsUnbounded = ends || (optional && shape.endsUnbounded);
    }
    return shape;
  };
  scan(src);
  return hazards;
}

describe("review r1 (HIGH): no title pattern backtracks super-linearly", () => {
  test("the audit fires on the shapes that do (a gate that cannot fire is theatre), and passes safe ones", () => {
    expect(quantifierHazards(String.raw`^(?:(?:now|so)(?![A-Za-z'])\s*,?\s+)*`).length).toBeGreaterThan(0);   // the old LEAD
    expect(quantifierHazards(String.raw`\s*,?\s+`).length).toBeGreaterThan(0);
    expect(quantifierHazards(String.raw`(a+)+b`).length).toBeGreaterThan(0);
    expect(quantifierHazards(String.raw`(?:x\s+)*`).length).toBeGreaterThan(0);
    expect(quantifierHazards(String.raw`^[ \t]*\*\*(.+?)\*\*(.*)$`)).toEqual([]);
    expect(quantifierHazards(String.raw`^(?:(?:now|so)(?![a-z'])(?: ?,)? )*([a-z]+ing)(?=[ ,]|$)(.*)$`)).toEqual([]);
  });

  test("every pattern the module compiles passes the audit", () => {
    expect(TITLE_PATTERNS.length).toBe(18);
    for (const re of TITLE_PATTERNS) expect({ source: re.source, hazards: quantifierHazards(re.source) }).toEqual({ source: re.source, hazards: [] });
  });

  const timed = (s: string): number => {
    const t0 = performance.now();
    activityTitleOf(s, true);
    activityTitleOf(s, false);
    lastValidHeading(s);
    return performance.now() - t0;
  };
  const warm = (): void => { for (let i = 0; i < 50; i++) timed("Let me read the files. **Heading**\n"); };

  test("the measured adversarial inputs finish in milliseconds (they took 2.6–7.9 s)", () => {
    warm();
    const adversarial = [
      `${"now  ".repeat(22)}xyz qq.`, `${"now  ".repeat(44)}x.`, `${"now   ".repeat(14)}xyz qq.`, `${"so , ".repeat(40)}xyz qq.`,
      `${"yes        ".repeat(19)}no.`, `${"ok      ok      fine    yes     ".repeat(6)}x.`, `${"now ,".repeat(60)}`,
      `${"I'll  ".repeat(30)}x.`, `${"let me  ".repeat(25)}x.`, `${"Checking ".repeat(40)}x.`, "*".repeat(400),
      "`a. b`".repeat(60), `${"- ".repeat(150)}x.`, `${", so ".repeat(60)}x.`, `${"— ".repeat(150)}x.`,
      `${"now　　".repeat(30)}x.`, `${"now\u0085\u0085".repeat(30)}x.`, `${".".repeat(500)}x`,
    ];
    for (const s of adversarial) expect({ s: s.slice(0, 24), fast: timed(s) < 10 }).toEqual({ s: s.slice(0, 24), fast: true });
  });

  test("a fuzz loop of 3,000 random 220-char candidates stays under 10 ms each and 1 s in all", () => {
    const toks = ["now", "so", "ok", "yes", "let me", "let", "me", "i'll", "i", "will", "need", "to", "check", "checking", "start", "by",
      "and", "then", "just", "quickly", "—", "--", "-", ",", ";", ":", "(", ")", "`", "**", "i've", "found", "checked", "the", "a",
      "that", "is", "go", "ahead", "double", "  ", "   ", "\t", " , ", "' ", "'", "。", "，", "检查"];
    let seed = 1;
    const rnd = (): number => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    warm();
    let worst = 0;
    const t0 = performance.now();
    for (let k = 0; k < 3000; k++) {
      let s = "";
      while (s.length < 219) s += toks[Math.floor(rnd() * toks.length)]! + (rnd() < 0.5 ? " " : rnd() < 0.5 ? "  " : "");
      worst = Math.max(worst, timed(`${s.slice(0, 219)}.`));
    }
    const total = performance.now() - t0;
    expect({ worstUnder10ms: worst < 10, totalUnder1s: total < 1000 }).toEqual({ worstUnder10ms: true, totalUnder1s: true });
  });

  test("streamed into the projector as one delta, an adversarial line costs milliseconds, not seconds", () => {
    const blocks = new ThinkingBlocks("s_test", () => 0);
    const f = (phase: "start" | "delta", text?: string): ReasoningProgressFrame =>
      ({ type: "system", subtype: "reasoning_progress", block_id: "rb", phase, kind: "exposed", ...(text === undefined ? {} : { text }) });
    blocks.start(f("start"));
    const t0 = performance.now();
    blocks.delta(f("delta", `Output:\n${"yes        ".repeat(19)}no.\n${"now  ".repeat(44)}x.\n`));
    expect(performance.now() - t0).toBeLessThan(50);
  });
});

describe("review r1: Unicode is read the same way by both engines, and never reaches a title", () => {
  const CONTROL = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁤⁦-⁩؜﻿]/;

  test("\\v, NEL and U+FEFF are whitespace; ZWSP and bidi controls are dropped; ſ and the Kelvin sign are not ASCII letters", () => {
    expect(final("Let me read the\u000bfile.")).toBe("Reading the file");
    expect(final("Let me read the\u0085file.")).toBe("Reading the file");
    expect(final("Checking﻿the logs.")).toBe("Checking the logs");
    expect(final("Checking the​ lo‮gs.")).toBe("Checking the logs");
    expect(final("Let me ſcan the files.")).toBeUndefined();
    expect(final("Let me checK the files.")).toBeUndefined();
    // ASCII-only lower-casing for matching; the original casing is kept in the title.
    expect(final("LET ME READ THE FILES.")).toBe("Reading THE FILES");
  });

  test("no derived title carries a control, zero-width or bidi unit", () => {
    for (const b of fixture.blocks) if (b.title !== null) expect(CONTROL.test(b.title)).toBe(false);
    expect(CONTROL.test(lastValidHeading("**Reading‮ the​ logs\u0007**\nbody")!)).toBe(false);
    expect(deriveThinkingTitle("update", ["Reading‮ the\u0085logs"])).toBe("Reading the logs");
  });
});

describe("review r1: a streamed block persists exactly what the whole text derives", () => {
  const persist = (kind: ThinkingKind, chunks: string[]): { live: Array<string | undefined>; block: string | undefined } => {
    const blocks = new ThinkingBlocks("s_test", () => 0);
    const f = (phase: "start" | "delta" | "end", text?: string): ReasoningProgressFrame =>
      ({ type: "system", subtype: "reasoning_progress", block_id: "rb", phase, kind, ...(text === undefined ? {} : { text }) });
    blocks.start(f("start"));
    const liveTitles = chunks.map((c) => (blocks.delta(f("delta", c))[0] as { title?: string } | undefined)?.title);
    return { live: liveTitles, block: (blocks.end(f("end"))[0] as { title?: string }).title };
  };

  test("a provisional title the next text undoes is shown but never persisted", () => {
    const a = persist("exposed", ["Using the cache.", "Map is slower."]);
    expect(a.live[0]).toBe("Using the cache");
    expect(a.block).toBeUndefined();
    expect(deriveThinkingTitle("exposed", ["Using the cache.Map is slower."], { final: true })).toBeUndefined();
    expect(persist("exposed", ["Reading the file.", "s is slow here."]).block).toBeUndefined();
    const b = persist("summary", ["**Foo**", " bar baz."]);
    expect(b.live[0]).toBe("Foo");
    expect(b.block).toBeUndefined();
    // …while one the following text CLOSES is kept.
    expect(persist("exposed", ["Using the cache.", " Map is slower."]).block).toBe("Using the cache");
    expect(persist("summary", ["**Foo**", "\nbar baz."]).block).toBe("Foo");
  });

  test("for every fixture block, the persisted title equals the whole-text derivation across 1/17/160-unit splits", () => {
    for (const b of fixture.blocks) {
      const whole = deriveThinkingTitle(b.kind, [b.text], { final: true });
      expect(whole ?? null).toBe(b.title);
      for (const size of b.text.length <= 1500 ? [1, 17, 160] : [17, 160]) {
        const chunks: string[] = [];
        for (let i = 0; i < b.text.length; i += size) chunks.push(b.text.slice(i, i + size));
        expect({ id: b.id, size, title: persist(b.kind, chunks).block }).toEqual({ id: b.id, size, title: whole });
      }
    }
  });
});

describe("review r1: CJK reasoning", () => {
  test("。！？； end a sentence by themselves (no space needed), live too", () => {
    expect(live("让我想想。Let me read 配置文件。")).toBe("Reading 配置文件");
    expect(live("Let me read 配置文件！还有")).toBe("Reading 配置文件");
    expect(live("Let me read the files；")).toBe("Reading the files");
  });

  test("a Chinese object is cut at fullwidth punctuation and capped by characters, never 200 units", () => {
    expect(final("Let me check 这个函数的实现，看看它是否正确。")).toBe("Checking 这个函数的实现");
    const long = final(`I need to read ${"配置文件和测试用例".repeat(10)}。`)!;
    expect(long).toBe(`Reading ${"配置文件和测试用例".repeat(4).slice(0, 32)}…`);
  });

  test("pure Chinese gives no title, never garbage; a Chinese provider heading is still a heading", () => {
    for (const s of ["让我读取文件。我需要检查代码。", "首先，我要检查这个项目的结构；然后运行测试！", "这是一个很小的项目"]) {
      expect(final(s)).toBeUndefined();
      expect(deriveThinkingTitle("exposed", [s], { final: true })).toBeUndefined();
    }
    expect(deriveThinkingTitle("summary", ["**分析代码结构**\n\n内容"])).toBe("分析代码结构");
  });
});
