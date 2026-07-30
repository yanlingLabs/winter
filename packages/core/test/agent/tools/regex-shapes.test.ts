import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

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
 * THE RULE ENFORCED BELOW: every regex literal in live code under `src/agent` that mentions `<` or `>`
 * must either carry no unbounded class/dot quantifier, or have that quantifier as its final element, or
 * have its ONLY unbounded quantifiers be whitespace-only and not leading (see
 * `unboundedQuantifierBeforeMore` for that rule and its proof), or be named in `ALLOWED` with a reason.
 * Bounded quantifiers (`{1,4}`) and quantifier-free candidate patterns are the shapes the fixes use,
 * and they pass automatically.
 *
 * The fixed sites deliberately do NOT appear as allowlist entries: they were rewritten into
 * quantifier-free candidate regexes (`/<a\s/gi`, `/<h([1-6])/gi`, `/<li(?![0-9A-Za-z_])/gi`) plus a
 * bounded scan around a monotonic `>` pointer, so there is nothing left to allow.
 */

/** The scan root. Was `src/agent/tools`, NON-recursively (review Minor 7 — demonstrated, not
 *  hypothetical: a dangerous regex in `src/agent/__x.ts` one level UP, or in
 *  `src/agent/tools/__sub/x.ts` one level DOWN, left the gate green). The derivation followed code
 *  *added beside* `web.ts` but not code *lifted out of* it — which is the very refactor its own doc
 *  comment cited. Now: recursive, from one level higher. */
const SRC_DIR = join(import.meta.dir, "../../../src/agent");

/** The whole of `packages/core/src`, walked only by the scope invariant below — the scanners could be
 *  moved anywhere in the package, and the invariant's job is to notice. */
const PACKAGE_SRC_DIR = join(import.meta.dir, "../../../src");

/** Every `.ts` under `dir`, recursively, as paths relative to `dir`. */
function walkTs(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walkTs(join(dir, entry.name), rel));
    else if (entry.name.endsWith(".ts")) out.push(rel);
  }
  return out;
}

/** DERIVED, not hardcoded (review Minor 5, bypass 1 — demonstrated, not hypothetical: a new file
 *  containing `/<td[^>]*>([\s\S]*?)<\/td>/gi` left the gate green). `FILES` used to be
 *  `["web.ts", "page-core.ts"]`, then every `.ts` directly inside `src/agent/tools`; it is now every
 *  `.ts` under `src/agent`, RECURSIVELY, so neither adding a file beside `web.ts` nor lifting the
 *  scanners into a shared module walks out of coverage.
 *
 *  Path is not the only thing tying scope to code — see the scanner-symbol invariant below, which
 *  fails loudly if a guarded scanner lands anywhere the derivation does not reach. */
const FILES: string[] = walkTs(SRC_DIR);

/** The scanners this gate exists to protect. If a file anywhere in `packages/core/src` mentions one of
 *  these and is NOT inside `FILES`, the derivation has silently narrowed and the invariant below says
 *  so — the property the path-based derivation alone could never have. */
const SCANNER_SYMBOLS = /scanAnchorOpens|scanHeadingOpens|stripTags|replaceListItems|extractLinks/;

/** Patterns that match the dangerous SHAPE but are provably safe, each with the proof. Adding an entry
 *  must be a deliberate, argued edit — that is the whole point of the list being asserted below.
 *
 *  EMPTY, and deliberately so. Widening the scope to `src/agent/**` brought exactly three flagged
 *  literals into view (`<br\s*\/?>` here, and `agent/engine.ts`'s two `</\s*task-notification\s*>`),
 *  and all three are the SAME safe shape: a whitespace-only unbounded quantifier behind a
 *  non-whitespace literal. Extending the RULE with that proof (see `unboundedQuantifierBeforeMore`)
 *  covers them and every future one; growing this list entry-by-entry would have covered three and
 *  taught the next author nothing. */
const ALLOWED: Array<{ source: string; why: string }> = [];

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

/** Every character a `\s`-only class may contain, as regex source. Anything else in a class makes the
 *  atom able to consume non-whitespace, which is what the exemption below may not cover. */
const WHITESPACE_CLASS_MEMBER = /^(?:\\s|\\t|\\n|\\r|\\f|\\v|\\u00[aA]0|\s)$/;

/** True when a class body (`[...]`'s contents) can match ONLY whitespace. Conservative: an unrecognised
 *  member, a negation, or a range makes it false. */
function classIsWhitespaceOnly(body: string): boolean {
  if (body === "" || body.startsWith("^") || body.includes("-")) return false;
  let i = 0;
  while (i < body.length) {
    const member = body[i] === "\\" ? body.slice(i, i + (/^\\u/.test(body.slice(i)) ? 6 : 2)) : body[i]!;
    if (!WHITESPACE_CLASS_MEMBER.test(member)) return false;
    i += member.length;
  }
  return true;
}

/** True when `source` carries an unbounded quantifier (`*`, `+`, `{n,}`, greedy or lazy) applied to a
 *  character class, an escaped class (`\s`, `\S`, `\w`…) or `.`, AND something follows it — the shape
 *  that turns "consume as far as possible" into "consume to end-of-string, then fail". A quantifier at
 *  the very end of the pattern is safe: there is no terminator to be missing.
 *
 *  THE WHITESPACE EXEMPTION (review §4 / §7.2, and what lets `ALLOWED` be empty). An unbounded
 *  quantifier over a WHITESPACE-ONLY atom is linear rather than quadratic, provided it is not the
 *  pattern's leading atom and the pattern has no alternation. Proof: every candidate start is pinned to
 *  a preceding non-whitespace literal, and a whitespace run has exactly one position immediately before
 *  it — so no two candidates can consume the same run, and each candidate consumes at most one run per
 *  `\s`-quantifier (a constant). The sum of all runs is bounded by the document length. Measured on the
 *  three live instances (`<br\s*\/?>`, and `engine.ts`'s two `</\s*task-notification\s*>`): flat at
 *  0.1 ms and 1.3 ms/938 KB across the same doubling series on which `[^>]*` patterns grew 4x per step.
 *
 *  Both conditions are load-bearing, and both are self-tested below:
 *   - LEADING is quadratic. `/\s*x/` on a run of spaces retries at every position in the run and
 *     re-consumes its tail each time — the exemption must not cover it.
 *   - ALTERNATION can smuggle a leading position in (`/(?:y|\s*x)/`), so the exemption declines to
 *     reason about any pattern containing `|`.
 *
 *  `^`-anchoring is deliberately NOT a second exemption even though it would also be sound (one start
 *  position). The review's Important 5 was a `$`-anchored alternative that was quadratic for exactly the
 *  reason a `^`-anchored one is not, and no live pattern needs it — an exemption phrased around
 *  "anchored" is an invitation to generalise it the wrong way. */
export function unboundedQuantifierBeforeMore(source: string): boolean {
  const hasAlternation = source.includes("|");
  let sawLiteralBefore = false;
  let i = 0;
  while (i < source.length) {
    let atomIsScanning = false;
    let atomIsWhitespaceOnly = false;
    if (source[i] === "\\") {
      atomIsScanning = /[sSwWdD]/.test(source[i + 1] ?? "");
      atomIsWhitespaceOnly = source[i + 1] === "s";
      i += 2;
    } else if (source[i] === "[") {
      const bodyStart = i + 1;
      i++;
      while (i < source.length && source[i] !== "]") { if (source[i] === "\\") i++; i++; }
      atomIsWhitespaceOnly = classIsWhitespaceOnly(source.slice(bodyStart, i));
      i++;
      atomIsScanning = true;
    } else if (source[i] === "(") {
      // A QUANTIFIED GROUP is the same defect wearing a hat (review Minor 5, bypass 3):
      // `<x(?:[^>])*>` was NOT flagged before this branch, and it is genuinely dangerous — measured
      // 1011 ms at 98 KB, *slower* than the bare `[^>]*` control at 599 ms. It also happens to be
      // exactly how one writes an attribute-aware tag matcher (`(?:[^>]|"[^"]*")*`), which makes it the
      // most likely shape for a future author to reach for.
      const start = i;
      let depth = 0;
      while (i < source.length) {
        if (source[i] === "\\") { i += 2; continue; }
        if (source[i] === "[") {
          i++;
          while (i < source.length && source[i] !== "]") { if (source[i] === "\\") i++; i++; }
        } else if (source[i] === "(") depth++;
        else if (source[i] === ")") { depth--; if (depth === 0) { i++; break; } }
        i++;
      }
      atomIsScanning = /\[|\.|\\[sSwWdD]/.test(source.slice(start, i));
    } else if (source[i] === ".") {
      atomIsScanning = true;
      i++;
    } else {
      // An ordinary literal character, which is what pins a candidate start position — but only when it
      // is REQUIRED. An optional one (`x?`, `x*`, `x{0,2}`) pins nothing, so a `\s*` behind it can still
      // be reached at every position. Regex syntax that matches nothing (anchors, quantifier marks,
      // group/alternation punctuation) never pins either.
      const optional = source[i + 1] === "?" || source[i + 1] === "*" || source[i + 1] === "{";
      if (!optional && !/[\^$|?*+(){}]/.test(source[i]!)) sawLiteralBefore = true;
      i++;
      continue;
    }
    // a quantifier may follow, optionally lazy
    let quantified = false;
    let matchesAtLeastOne = true; // no quantifier at all ⇒ the atom must match exactly once
    if (source[i] === "*" || source[i] === "+") {
      quantified = true;
      matchesAtLeastOne = source[i] === "+";
      i++;
    } else if (source[i] === "{") {
      const close = source.indexOf("}", i);
      if (close > 0 && /^\{\d+,\}$/.test(source.slice(i, close + 1))) quantified = true;
      if (close > 0) { matchesAtLeastOne = !/^\{0[,}]/.test(source.slice(i, close + 1)); i = close + 1; }
    } else if (source[i] === "?") {
      matchesAtLeastOne = false;
    }
    if (source[i] === "?") i++; // lazy marker (or the optional marker, which we do not treat as unbounded)
    const whitespaceExempt = atomIsWhitespaceOnly && sawLiteralBefore && !hasAlternation;
    if (quantified && atomIsScanning && !whitespaceExempt && i < source.length) return true;
    if (matchesAtLeastOne) sawLiteralBefore = true; // it must consume a character, so it pins what follows
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
      // …and the group-wrapped spellings of the same thing (review Minor 5, bypass 3)
      "<x(?:[^>])*>",
      '<x(?:[^>]|"[^"]*")*>',
      "<x(?:.)+>",
    ]) {
      expect(mentionsMarkup(offender) && unboundedQuantifierBeforeMore(offender)).toBe(true);
    }
  });

  test("the tripwire does NOT fire on the quantifier-free candidate regexes the fixes use", () => {
    for (const safe of ["<a\\s", "<h([1-6])", "<li(?![0-9A-Za-z_])", "<\\/a>", "<\\/h([1-6])>", "<script", "<\\/(p|div|h[1-6]|li|tr)>", "^[0-9a-f]{1,4}$"]) {
      expect(unboundedQuantifierBeforeMore(safe)).toBe(false);
    }
  });

  test("the whitespace exemption covers the three live instances and nothing looser", () => {
    // EXEMPT — a whitespace-only unbounded quantifier behind a required non-whitespace literal. These
    // are the only three such literals in scope, and they are why `ALLOWED` is empty.
    for (const safe of ["<br\\s*\\/?>", "<\\/\\s*task-notification\\s*>", "<x[ \\t]*>"]) {
      expect(unboundedQuantifierBeforeMore(safe)).toBe(false);
    }
    // NOT exempt — each breaks one condition of the proof, and each is genuinely quadratic.
    for (const unsafe of [
      "\\s*<x>", // LEADING: every position is a candidate and re-consumes the run's tail
      "\\s+x", // same, with `+`
      "<x>|\\s*y", // ALTERNATION can smuggle the leading position back in past the pinning literal
      "x?\\s*<y>", // the only preceding literal is OPTIONAL, so the `\s*` is reachable at every position
      "<x[^>]*\\s*>", // a second, non-whitespace unbounded quantifier is still the original defect
      "<x\\S*>", // `\S` is not whitespace
      "<x[\\s\\S]*>", // the class can consume anything — the `[\s\S]*?` shape this family started as
    ]) {
      expect(unboundedQuantifierBeforeMore(unsafe)).toBe(true);
    }
  });

  test("the lexer finds live regexes and ignores the ones quoted in comments", () => {
    // Two failure modes this pins: a lexer that finds nothing (the tripwire silently stops guarding)
    // and one that reads doc comments (it cries wolf over the reference spellings the fixes document).
    // The derived list must actually contain the two files this task worked on — a derivation that
    // silently returned nothing, or the wrong directory, would make every check below vacuous.
    expect(FILES).toContain("tools/web.ts");
    expect(FILES).toContain("tools/page-core.ts");
    expect(FILES.length).toBeGreaterThan(10);
    // The recursion really did widen the scope past the tools directory (review Minor 7): `engine.ts`
    // sits one level up and used to be invisible to this gate.
    expect(FILES).toContain("engine.ts");
    expect(FILES.filter((f) => !f.startsWith("tools/")).length).toBeGreaterThan(5);
    // page-core.ts is down to exactly three live regexes now that its duplicate of the anchor open
    // pattern is gone (`/<\/a>/gi`, `/\n+/g`, `/\r\n/g`); web.ts has many.
    expect(liveRegexLiterals(readFileSync(join(SRC_DIR, "tools/page-core.ts"), "utf8")).length).toBeGreaterThanOrEqual(3);
    expect(liveRegexLiterals(readFileSync(join(SRC_DIR, "tools/web.ts"), "utf8")).length).toBeGreaterThan(15);
    for (const file of FILES) {
      const found = liveRegexLiterals(readFileSync(join(SRC_DIR, file), "utf8"));
      for (const { source } of found) {
        // These appear ONLY inside comments in the current sources; seeing one means the lexer leaked.
        expect(source).not.toBe("<[^>]+>");
        expect(source).not.toBe("<li\\b[^>]*>");
      }
    }
    // And it really does see the live ones.
    const web = liveRegexLiterals(readFileSync(join(SRC_DIR, "tools/web.ts"), "utf8")).map((r) => r.source);
    expect(web).toContain("<a\\s");
    expect(web).toContain("<h([1-6])");
    expect(web).toContain("<li(?![0-9A-Za-z_])");
  });

  /** THE INVARIANT THAT TIES SCOPE TO CODE RATHER THAN TO A PATH (review Minor 7). A path-derived scope
   *  can only ever follow code that stays put; this one follows the code itself. If a scanner is lifted
   *  into `src/util/html.ts` tomorrow, the gate does not quietly stop guarding it — this fails, naming
   *  the file, and the fix is one edit to `SRC_DIR`. */
  test("every file in the package that carries a guarded scanner is inside the scanned scope", () => {
    const carriers = walkTs(PACKAGE_SRC_DIR)
      .filter((f) => SCANNER_SYMBOLS.test(readFileSync(join(PACKAGE_SRC_DIR, f), "utf8")));
    expect(carriers.length).toBeGreaterThan(0); // a matcher that found nothing would be vacuous

    const scoped = new Set(FILES.map((f) => relative(PACKAGE_SRC_DIR, join(SRC_DIR, f))));
    const escaped = carriers.filter((f) => !scoped.has(f));
    expect(escaped.join("\n")).toBe("");
  });

  test("no live regex under src/agent scans unboundedly past a missing '>'", () => {
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
    // EMPTY. Every literal that used to need an entry is covered by the whitespace exemption's proof
    // instead, so the gate now has zero exceptions — and re-introducing one is a visible edit here.
    expect(ALLOWED.map((a) => a.source)).toEqual([]);
    for (const { why } of ALLOWED) expect(why.length).toBeGreaterThan(80); // a reason, not a shrug
  });
});
