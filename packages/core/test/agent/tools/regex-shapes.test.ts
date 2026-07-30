import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * THE STRUCTURAL TRIPWIRE for the HTML-scanning regex class, and the reason it exists: Task 6b found
 * the SAME defect in a different regex in `web.ts` three rounds running (the final `<[^>]+>` strip;
 * then `<li\b[^>]*>` plus both `extractTitle` regexes; then `ANCHOR_OPEN_RE`, `HEADING_OPEN_RE` and
 * `page-core.ts`'s duplicate of the first). Each round fixed the instances it was handed and each
 * round's tests were written around those instances, so the next instance was invisible again.
 * Patching named sites is losing; this test makes the CLASS unrepresentable.
 *
 * THE CLASS: an HTML-matching pattern with an UNBOUNDED quantifier (`[^>]*`, `[^"]+`, `[\s\S]*?`,
 * `.*`) that is not the last thing in the pattern — i.e. it can consume arbitrarily far and then
 * requires a terminator that hostile input can simply omit. At every candidate start position the
 * engine consumes to end-of-string and fails, which is quadratic; stack two such quantifiers on one
 * span and it is cubic (measured: 86 s on 39 KB for the anchor pattern).
 *
 * THE RULE ENFORCED BELOW: every regex literal in live code in `web.ts` and `page-core.ts` that
 * mentions `<` or `>` must either carry no unbounded class/dot quantifier, or have that quantifier as
 * its final element, or be named in `ALLOWED` with a reason. Bounded quantifiers (`{1,4}`) and
 * quantifier-free candidate patterns are the shapes the fixes use, and they pass automatically.
 *
 * The fixed sites deliberately do NOT appear as allowlist entries: they were rewritten into
 * quantifier-free candidate regexes (`/<a\s/gi`, `/<h([1-6])/gi`, `/<li(?![0-9A-Za-z_])/gi`) plus a
 * bounded scan around a monotonic `>` pointer, so there is nothing left to allow.
 */

const FILES = ["web.ts", "page-core.ts"] as const;
const SRC_DIR = join(import.meta.dir, "../../../src/agent/tools");

/** Patterns that match the dangerous SHAPE but are provably safe, each with the proof. Adding an entry
 *  must be a deliberate, argued edit — that is the whole point of the list being asserted below. */
const ALLOWED: Array<{ source: string; why: string }> = [
  {
    source: "<br\\s*\\/?>",
    why:
      "`\\s*` can only consume WHITESPACE, and the whitespace run after one `<br` is disjoint from the "
      + "run after any other: a candidate begins with `<`, which is not whitespace, so it terminates the "
      + "preceding candidate's run. The sum of all runs is therefore bounded by the document length — "
      + "linear, not quadratic. Measured flat at 0.1 ms across the same 5k-160k doubling series on "
      + "which `[^>]*` patterns grew 4x per step.",
  },
];

/** A small lexer, because a regex-based scan for regex literals cannot tell code from comments — and
 *  the comments in `web.ts` deliberately quote the dangerous patterns as reference spellings (that is
 *  how the fixes document what they replaced). Flagging those would make this test cry wolf forever;
 *  missing live code would make it useless. So: track strings, templates, line and block comments, and
 *  treat `/` as starting a regex only when the previous significant character cannot end an
 *  expression. */
function liveRegexLiterals(src: string): Array<{ line: number; source: string }> {
  const out: Array<{ line: number; source: string }> = [];
  let i = 0;
  let line = 1;
  let prev = "";
  while (i < src.length) {
    const c = src[i]!;
    if (c === "\n") { line++; i++; continue; }
    if (c === "/" && src[i + 1] === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) { if (src[i] === "\n") line++; i++; }
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      i++;
      while (i < src.length && src[i] !== c) {
        if (src[i] === "\\") i++;
        else if (src[i] === "\n") line++;
        i++;
      }
      i++;
      prev = "x"; // a string literal can end an expression
      continue;
    }
    if (c === "/" && !/[\w)\]"'`]/.test(prev)) {
      const start = i;
      i++;
      let inClass = false;
      while (i < src.length) {
        const d = src[i]!;
        if (d === "\\") { i += 2; continue; }
        if (d === "[") inClass = true;
        else if (d === "]") inClass = false;
        else if (d === "/" && !inClass) break;
        else if (d === "\n") break; // unterminated: not a regex literal after all
        i++;
      }
      if (src[i] === "/") {
        out.push({ line, source: src.slice(start + 1, i) });
        i++;
        while (i < src.length && /[gimsuyd]/.test(src[i]!)) i++;
        prev = "x";
        continue;
      }
      i = start + 1; // bail out; treat the `/` as an operator
      continue;
    }
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return out;
}

/** True when `source` carries an unbounded quantifier (`*`, `+`, `{n,}`, greedy or lazy) applied to a
 *  character class, an escaped class (`\s`, `\S`, `\w`…) or `.`, AND something follows it — the shape
 *  that turns "consume as far as possible" into "consume to end-of-string, then fail". A quantifier at
 *  the very end of the pattern is safe: there is no terminator to be missing. */
export function unboundedQuantifierBeforeMore(source: string): boolean {
  let i = 0;
  while (i < source.length) {
    let atomIsScanning = false;
    if (source[i] === "\\") {
      atomIsScanning = /[sSwWdD]/.test(source[i + 1] ?? "");
      i += 2;
    } else if (source[i] === "[") {
      i++;
      while (i < source.length && source[i] !== "]") { if (source[i] === "\\") i++; i++; }
      i++;
      atomIsScanning = true;
    } else if (source[i] === ".") {
      atomIsScanning = true;
      i++;
    } else {
      i++;
      continue;
    }
    // a quantifier may follow, optionally lazy
    let quantified = false;
    if (source[i] === "*" || source[i] === "+") { quantified = true; i++; }
    else if (source[i] === "{") {
      const close = source.indexOf("}", i);
      if (close > 0 && /^\{\d+,\}$/.test(source.slice(i, close + 1))) quantified = true;
      if (close > 0) i = close + 1;
    }
    if (source[i] === "?") i++; // lazy marker (or the optional marker, which we do not treat as unbounded)
    if (quantified && atomIsScanning && i < source.length) return true;
  }
  return false;
}

const mentionsMarkup = (source: string): boolean => source.includes("<") || source.includes(">");

describe("regex shapes in the HTML-scanning paths (structural tripwire)", () => {
  test("the tripwire itself fires on all four historical offenders", () => {
    // If this test ever goes green-by-vacuity, everything below is theatre. These are the exact
    // patterns Task 6b removed, in the order the three review rounds found them.
    for (const offender of [
      "<[^>]+>", // round 0: the final tag strip
      "<li\\b[^>]*>", // round 1: the list-item pass
      "<h1[^>]*>([\\s\\S]*?)<\\/h1>", // round 1: extractTitle
      "<title[^>]*>([\\s\\S]*?)<\\/title>", // round 1: extractTitle's fallback
      "<a\\s[^>]*href=\"([^\"]+)\"[^>]*>", // round 2: the cubic one
      "<h([1-6])[^>]*>", // round 2: the heading open
      "<script[\\s\\S]*?<\\/script>", // the pre-T6 shape this whole family started as
    ]) {
      expect(mentionsMarkup(offender) && unboundedQuantifierBeforeMore(offender)).toBe(true);
    }
  });

  test("the tripwire does NOT fire on the quantifier-free candidate regexes the fixes use", () => {
    for (const safe of ["<a\\s", "<h([1-6])", "<li(?![0-9A-Za-z_])", "<\\/a>", "<\\/h([1-6])>", "<script", "<\\/(p|div|h[1-6]|li|tr)>", "^[0-9a-f]{1,4}$"]) {
      expect(unboundedQuantifierBeforeMore(safe)).toBe(false);
    }
  });

  test("the lexer finds live regexes and ignores the ones quoted in comments", () => {
    // Two failure modes this pins: a lexer that finds nothing (the tripwire silently stops guarding)
    // and one that reads doc comments (it cries wolf over the reference spellings the fixes document).
    // page-core.ts is down to exactly three live regexes now that its duplicate of the anchor open
    // pattern is gone (`/<\/a>/gi`, `/\n+/g`, `/\r\n/g`); web.ts has many.
    expect(liveRegexLiterals(readFileSync(join(SRC_DIR, "page-core.ts"), "utf8")).length).toBeGreaterThanOrEqual(3);
    expect(liveRegexLiterals(readFileSync(join(SRC_DIR, "web.ts"), "utf8")).length).toBeGreaterThan(15);
    for (const file of FILES) {
      const found = liveRegexLiterals(readFileSync(join(SRC_DIR, file), "utf8"));
      for (const { source } of found) {
        // These appear ONLY inside comments in the current sources; seeing one means the lexer leaked.
        expect(source).not.toBe("<[^>]+>");
        expect(source).not.toBe("<li\\b[^>]*>");
      }
    }
    // And it really does see the live ones.
    const web = liveRegexLiterals(readFileSync(join(SRC_DIR, "web.ts"), "utf8")).map((r) => r.source);
    expect(web).toContain("<a\\s");
    expect(web).toContain("<h([1-6])");
    expect(web).toContain("<li(?![0-9A-Za-z_])");
  });

  test("no live regex in web.ts or page-core.ts scans unboundedly past a missing '>'", () => {
    const allowed = new Set(ALLOWED.map((a) => a.source));
    const offenders: string[] = [];
    for (const file of FILES) {
      for (const { line, source } of liveRegexLiterals(readFileSync(join(SRC_DIR, file), "utf8"))) {
        if (!mentionsMarkup(source)) continue;
        if (!unboundedQuantifierBeforeMore(source)) continue;
        if (allowed.has(source)) continue;
        offenders.push(`${file}:${line}  /${source}/`);
      }
    }
    expect(offenders.join("\n")).toBe("");
  });

  test("the allowlist is exactly what it is documented to be (adding to it must be deliberate)", () => {
    expect(ALLOWED.map((a) => a.source)).toEqual(["<br\\s*\\/?>"]);
    for (const { why } of ALLOWED) expect(why.length).toBeGreaterThan(80); // a reason, not a shrug
  });
});
