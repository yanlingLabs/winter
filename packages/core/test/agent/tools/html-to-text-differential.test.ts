import { describe, expect, test } from "bun:test";
import { extractTitle, htmlToText } from "../../../src/agent/tools/web";

/**
 * Differential harness for the whole-branch review's Critical fix-round-2: `htmlToText`'s five
 * lazy-scan-to-a-required-token regexes (script/style/head/heading/anchor) were replaced with a
 * linear two-pass-plus-monotonic-pointer technique (see web.ts's own comment above
 * `replacePairedTag`/`convertHeadings`). The performance side of that fix is proven in web.test.ts's
 * own "linear-time scanning" describe block; THIS file proves the rewrite didn't change what
 * `htmlToText` actually RETURNS — the bar the coordinator set: zero divergence on realistic HTML,
 * with any adversarial-input divergence class named and characterized (not silently accepted).
 *
 * `oldHtmlToText` below is a byte-for-byte frozen copy of the PRE-FIX algorithm (the five original
 * regexes, in their original order) — kept here ONLY as the differential oracle, never imported
 * from anywhere else, so it can never drift with future edits to the real (fixed) implementation.
 */
function oldHtmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<head[\s\S]*?<\/head>/gi, "")
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, n, t) => `\n${"#".repeat(Number(n))} ${t}\n`)
    .replace(/<a\s[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href, t) => `${t} (${href})`)
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|h[1-6]|li|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ")
    .split("\n").map(l => l.trim()).filter(Boolean).join("\n");
}

// --- (a) realistic HTML: ~30 hand-written cases covering every construct htmlToText recognizes,
// plus a few whole-page, real-world-shaped documents (blog post / wiki article / docs page). Zero
// divergence here is the bar (coordinator's own words) — every one of these is asserted EXACTLY
// equal, not just "close enough". ------------------------------------------------------------------
const REALISTIC_CASES: Array<{ name: string; html: string }> = [
  { name: "plain paragraph", html: "<p>Hello world.</p>" },
  { name: "all six heading levels", html: "<h1>One</h1><h2>Two</h2><h3>Three</h3><h4>Four</h4><h5>Five</h5><h6>Six</h6>" },
  { name: "nested inline formatting inside a paragraph", html: "<p>Some <b>bold</b> and <i>italic</i> and <span>span</span> text.</p>" },
  { name: "absolute and relative links", html: '<p><a href="https://example.com/x">abs</a> and <a href="/rel/path">rel</a>.</p>' },
  { name: "a list of links", html: '<ul><li><a href="https://a.com/">A</a></li><li><a href="https://b.com/">B</a></li></ul>' },
  { name: "ordered and unordered lists", html: "<ul><li>one</li><li>two</li></ul><ol><li>first</li><li>second</li></ol>" },
  { name: "a simple table", html: "<table><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table>" },
  { name: "script with JS containing comparison operators", html: "<script>if (a < b && b > c) { x(); }</script><p>after</p>" },
  { name: "style with CSS combinators", html: "<style>div > p { color: red; } a < b {}</style><p>after</p>" },
  { name: "head with meta/title/link tags", html: '<head><meta charset="utf-8"><title>My Page</title><link rel="stylesheet" href="x.css"></head><body><h1>Body</h1></body>' },
  { name: "HTML entities", html: "<p>Tom &amp; Jerry &lt;3 say &quot;hi&quot; &#39;quote&#39; and&nbsp;space</p>" },
  { name: "mixed-case tags", html: "<SCRIPT>bad()</SCRIPT><Style>.x{}</Style><H1>Title</H1><A HREF=\"https://x.com/\">link</A>" },
  { name: "self-closing br variations", html: "line one<br>line two<br/>line three<br />line four" },
  { name: "nested markup inside an anchor", html: '<a href="https://x.com/"><b>bold link</b></a>' },
  { name: "empty tags", html: "<p></p><div></div><h2></h2>" },
  { name: "an HTML comment", html: "<!-- a comment --><p>after comment</p>" },
  { name: "duplicate/malformed nested head (bad server output)", html: "<head><head><title>Inner</title></head></head><body><h1>Body</h1></body>" },
  { name: "uppercase DOCTYPE + html wrapper", html: "<!DOCTYPE HTML><HTML><BODY><P>text</P></BODY></HTML>" },
  { name: "unclosed <li> items (loose HTML, common in the wild)", html: "<ul><li>Item one<li>Item two<li>Item three</ul>" },
  { name: "a stray '>' at the very end", html: "<p>hello</p>>" },
  { name: "several headings in a row with no body text between them", html: "<h2>A</h2><h3>B</h3><h2>C</h2>" },
  { name: "attribute values containing an ampersand and a query string", html: '<p>See <a href="https://x.com/?a=1&amp;b=2" title="A & B">this</a>.</p>' },
  { name: "relative link with a fragment-only anchor mixed in", html: '<p><a href="#top">top</a> and <a href="/page">page</a></p>' },
  { name: "div/p/tr closing tags all produce newlines", html: "<div>d</div><p>p</p><tr><td>t</td></tr>" },
  { name: "a <br> immediately followed by a heading", html: "line<br><h2>Next</h2>" },
  { name: "script immediately followed by style immediately followed by head", html: "<script>1</script><style>2</style><head><title>3</title></head><p>4</p>" },
  { name: "whitespace-only lines collapse (multiple blank lines between blocks)", html: "<p>a</p>\n\n\n<p>b</p>" },
  // Task 6b fix-round-1 (review Critical 1): the `<li\b[^>]*>` pass was linearized too, and the
  // absent-`>` shape it is quadratic on was NOT expressible by the fuzz vocabulary below before this
  // round (every `<li…>` token it emitted carried its own `>`). Pinned here as explicit cases as well
  // as being added to `NO_TERMINATOR_TAGS`, because a pairing bug in that pass is a byte divergence,
  // not just a slow one.
  { name: "an unterminated <li with no '>' anywhere after it", html: "<ul><li>one</li><li x" },
  { name: "many unterminated <li opens in a row", html: "<li a<li b<li c" },
  { name: "an unterminated <li whose '>' belongs to a LATER unrelated tag", html: "<li attr=\"oops<p>after</p>" },
  { name: "<li immediately followed by a word character (the \\b must not match)", html: "<link rel=x><lithium>Li</lithium>" },
  { name: "<li> with an empty attribute run", html: "<li><li >x" },
  { name: "a stray '<' between two list items", html: "<li>a</li><<li>b</li>" },
  {
    name: "realistic blog-post-shaped page",
    html:
      "<html><head><title>My Blog Post</title><meta charset=\"utf-8\"></head><body>" +
      "<h1>My Blog Post</h1>" +
      "<p>Published on <b>July 28, 2026</b> by the author.</p>" +
      "<p>This is the introduction paragraph, with a <a href=\"https://example.com/related\">related link</a> and some <i>emphasis</i>.</p>" +
      "<h2>A Subheading</h2>" +
      "<p>More body text here, explaining things in detail.</p>" +
      "<ul><li>First point</li><li>Second point</li><li>Third point with a <a href=\"https://example.com/ref\">reference</a></li></ul>" +
      "<p>Closing paragraph &amp; sign-off.</p>" +
      "</body></html>",
  },
  {
    name: "realistic wiki-article-shaped page",
    html:
      "<html><head><title>Widget (disambiguation)</title></head><body>" +
      "<h1>Widget</h1>" +
      "<div class=\"infobox\"><p><b>Type:</b> Example</p><p><b>Origin:</b> Somewhere</p></div>" +
      "<p>A widget is a thing used for demonstration &amp; illustration purposes.</p>" +
      "<h2>History</h2><p>The widget was first described in <a href=\"https://example.com/source\">a paper</a>.</p>" +
      "<h2>See also</h2><ul><li><a href=\"https://example.com/gadget\">Gadget</a></li><li><a href=\"https://example.com/gizmo\">Gizmo</a></li></ul>" +
      "<h2>References</h2><ol><li>Reference one</li><li>Reference two</li></ol>" +
      "</body></html>",
  },
  {
    name: "realistic docs-page-shaped page",
    html:
      "<html><head><title>API Reference</title><style>pre{background:#eee}</style></head><body>" +
      "<h1>API Reference</h1>" +
      "<p>This page documents the <code>fetchCleanPage</code> function.</p>" +
      "<h2>Parameters</h2>" +
      "<table><tr><td>url</td><td>string</td></tr><tr><td>cache</td><td>PageCache</td></tr></table>" +
      "<h2>Example</h2>" +
      "<script>console.log(fetchCleanPage('https://x.com/'));</script>" +
      "<p>See also <a href=\"https://example.com/guide\">the guide</a>.</p>" +
      "</body></html>",
  },
];

describe("htmlToText differential harness: realistic HTML — ZERO divergence is the bar", () => {
  for (const { name, html } of REALISTIC_CASES) {
    test(name, () => {
      expect(htmlToText(html)).toBe(oldHtmlToText(html));
    });
  }
});

// --- (b) several thousand randomized adversarial inputs — divergence counted and (if any)
// characterized, not silently accepted. Deterministic (seeded mulberry32 PRNG) so a failure is
// always reproducible from the same seed, never CI-timing-flavored flakiness. -----------------------
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeFuzzer(seed: number) {
  const rand = mulberry32(seed);
  const pick = <T,>(arr: T[]): T => arr[Math.floor(rand() * arr.length)]!;
  const int = (min: number, max: number): number => min + Math.floor(rand() * (max - min + 1));

  // Vocabulary deliberately biased toward the shapes most likely to expose a pairing bug: same-tag
  // nesting/interleaving (headings across levels, anchors), and malformed opens missing their own
  // terminating '>' (the one real divergence class found during development — see web.ts's own
  // comment on SCRIPT_OPEN_RE/STYLE_OPEN_RE/HEAD_OPEN_RE for the fix that closed it).
  const TAGS = ["script", "style", "head", "h1", "h2", "h3", "h4", "h5", "h6", "a", "li", "br", "p", "div", "tr", "span", "b", "SCRIPT", "Style", "Head", "H2", "A"];
  const ATTR_FRAGS = ["", ' class="x"', ' id="y" data-z="1"', ' href="https://example.com/z"', ' href="/rel"', ' href="", ', " href=noquotes", ' href="mismatched'];
  const TEXT_FRAGS = ["hello", "world &amp; friends", "<3", ">>", "&nbsp;pad", "", " ", "\n", "&#39;quoted&#39;", "text with < and > raw"];
  const ENTITY_FRAGS = ["&amp;", "&lt;", "&gt;", "&quot;", "&#39;", "&nbsp;", "&unknown;"];
  // Tags emitted WITHOUT their own terminating '>' — the shape every quadratic pass in this cleaner is
  // quadratic on, and the shape a pairing bug shows up as a byte divergence in. Task 6b fix-round-1
  // added `li` and `title` (review Critical 1): before that, `script`/`style`/`head` were the only
  // unterminated opens the generator could express, so this corpus could not have caught a divergence
  // in the `<li` pass — one of the two sites that round linearized.
  //
  // `h1` IS DELIBERATELY ABSENT, and this is the interesting part. Adding it makes the generator able
  // to express `<h1<h2>`-shaped input, which is exactly PRICE-OF-LINEARITY divergence class (A) that
  // web.ts's own comment documents and the fix-round-2 whole-branch review accepted: the original
  // combined `<h([1-6])[^>]*>([\s\S]*?)<\/h\1>` could backtrack INTO its own open tag's parse to
  // satisfy the trailing close, and `convertHeadings`'s two-pass scan cannot. Measured here:
  // 16/10,000 (seed 0xc0ffee) and 23/10,000 (seed 0x539) with `h1` in this list.
  //
  // Attributed, not assumed. `convertHeadings` is untouched by BOTH Task 6b commits (`git diff` over
  // `19b766f8..HEAD` shows no heading lines), and swapping ONLY the heading pass back to the original
  // combined regex — while keeping this round's `<li` scan and `stripTags` — drives those same two
  // corpora to **0/10,000 and 0/10,000**. So every divergence the `h1` token produces belongs to the
  // accepted class in code this task did not modify, and none belongs to `replaceListItems` or
  // `stripTags`. Per-token isolation says the same thing: `li` alone 0/10,000, `title` alone 0/10,000,
  // `h1` alone 28/10,000.
  //
  // Including it would therefore mean either weakening this gate to a non-zero budget or asserting a
  // classifier for a known-accepted class — both worse than leaving the heading class where its own
  // documentation already is. The `<h1`/`<title` absent-`>` shapes ARE covered at zero divergence in
  // section (c) below, against `extractTitle`, which is the function whose `<h1`/`<title` handling
  // this round actually changed.
  const NO_TERMINATOR_TAGS = ["script", "style", "head", "li", "title"];

  function randomToken(): string {
    const kind = int(0, 12);
    if (kind <= 2) return `<${pick(TAGS)}${pick(ATTR_FRAGS)}>`; // well-formed-ish open
    if (kind <= 4) return `</${pick(TAGS)}>`; // close
    if (kind <= 6) return pick(TEXT_FRAGS);
    if (kind === 7) return pick(ENTITY_FRAGS);
    if (kind === 8) return "<"; // stray
    if (kind === 9) return ">"; // stray
    if (kind === 10) return `<${pick(NO_TERMINATOR_TAGS)}`; // open with NO '>' at all
    if (kind === 11) return `<${pick(NO_TERMINATOR_TAGS)} attr="no-terminator-here`; // attr frag, no '>'
    return `<h${int(1, 6)}${pick(ATTR_FRAGS)}>`; // extra heading weight (interleaving stress)
  }

  return (tokenCount: number): string => Array.from({ length: tokenCount }, randomToken).join("");
}

describe("htmlToText differential harness: randomized adversarial fuzz — divergence counted and characterized", () => {
  test("10,000 randomized documents (seeded, reproducible): zero divergence from realistic input's own oracle", () => {
    const fuzz = makeFuzzer(0xc0ffee);
    const N = 10_000;
    let divergences = 0;
    const examples: Array<{ input: string; oldOut: string; newOut: string }> = [];

    for (let i = 0; i < N; i++) {
      const doc = fuzz(Math.floor(mulberry32(i + 1)() * 30) + 2);
      const oldOut = oldHtmlToText(doc);
      const newOut = htmlToText(doc);
      if (oldOut !== newOut) {
        divergences++;
        if (examples.length < 10) examples.push({ input: doc, oldOut, newOut });
      }
    }

    // Development history (disclosed, not hidden): an EARLIER version of the fix used
    // `/<script[^>]*>/gi`-shaped open regexes for script/style/head (mirroring headings/anchors,
    // which DO require their own terminating '>' in the original). That version showed a real
    // divergence class on exactly this fuzz vocabulary — ~0.6% on a corpus weighted toward
    // "no-terminator" tokens — because the ORIGINAL script/style/head regexes never required
    // their own '>' at all (`<script[\s\S]*?<\/script>` scans past ANY characters, including a
    // stray '>' belonging to unrelated markup). Switching those three (and ONLY those three, since
    // headings/anchors' originals genuinely do require `[^>]*>`) to a bare-token open regex
    // (`/<script/gi`) closed the gap entirely: this fuzz run is the proof, at zero divergence.
    if (divergences > 0) {
      console.error(`htmlToText differential fuzz: ${divergences}/${N} divergences`, examples);
    }
    expect(divergences).toBe(0);
  });

  test("a second, differently-seeded 10,000-document run also shows zero divergence (not a lucky seed)", () => {
    const fuzz = makeFuzzer(1337);
    const N = 10_000;
    let divergences = 0;
    for (let i = 0; i < N; i++) {
      const doc = fuzz(Math.floor(mulberry32(i + 9999)() * 30) + 2);
      if (oldHtmlToText(doc) !== htmlToText(doc)) divergences++;
    }
    expect(divergences).toBe(0);
  });
});

// --- (c) `extractTitle`, Task 6b fix-round-1 (review Critical 1). Both of its regexes
// (`/<h1[^>]*>([\s\S]*?)<\/h1>/i` and the `<title>` fallback) were O(n²) on the absent-`>` shape:
// non-global, but a FAILING match still retries at every `<h1` position. Replaced with a bounded
// forward scan (`firstElementInner`), whose equivalence rests on an argument — the open tag's `>` is
// forced, and a later candidate's `>` is never earlier — so it wants a differential, not just a
// ceiling test. Same harness shape as (a)/(b) above. -------------------------------------------------
//
// `oldExtractTitle` is a byte-for-byte frozen copy of the PRE-fix extraction, kept here only as the
// oracle. It deliberately calls the LIVE `htmlToText`: the only thing under test here is which
// substring gets extracted, and `htmlToText` has its own oracle in (a)/(b). Sharing the unchanged
// half is what isolates the changed half.
function oldExtractTitle(html: string): string {
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const src = h1?.[1] ?? html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  if (!src) return "-";
  const text = htmlToText(src).replace(/\n+/g, " ").trim();
  return text || "-";
}

const TITLE_CASES: Array<{ name: string; html: string }> = [
  { name: "h1 present", html: "<h1>Hello</h1><title>Ignored</title>" },
  { name: "no h1, title used", html: "<head><title>Only Title</title></head><body>x</body>" },
  { name: "neither", html: "<p>nothing here</p>" },
  { name: "h1 with attributes", html: '<h1 class="a" id="b">Attr H1</h1>' },
  { name: "uppercase tags", html: "<H1>Upper</H1>" },
  { name: "mixed-case close", html: "<h1>Mixed</H1>" },
  // The `??`-not-`||` edge: an h1 that MATCHED but captured "" must short-circuit to "-" rather than
  // fall through to <title>, because "" is not nullish.
  { name: "EMPTY h1 short-circuits and does NOT fall through to title", html: "<h1></h1><title>Not Used</title>" },
  { name: "whitespace-only h1 also cleans to nothing", html: "<h1>   </h1><title>Not Used</title>" },
  { name: "h1 containing markup and entities", html: '<h1>A <b>bold</b> &amp; <a href="/x">linked</a> title</h1>' },
  { name: "h1 spanning newlines", html: "<h1>\n  Multi\n  line\n</h1>" },
  // The absent-`>` shapes — the quadratic trigger, and the pairing edges the argument turns on.
  { name: "unterminated h1 open, no '>' anywhere", html: "<h1 x" },
  { name: "unterminated h1 open then a title", html: "<h1 x<title>Fallback</title>" },
  { name: "many unterminated h1 opens", html: "<h1 a<h1 b<h1 c" },
  { name: "h1 open with no close anywhere", html: "<h1>dangling text" },
  { name: "h1 open, no close, but a title exists", html: "<h1>dangling<title>Used</title>" },
  { name: "a </h1> BEFORE the open tag's own '>'", html: "<h1 </h1> x>body" },
  { name: "the first h1 has no close but a later one does", html: "<h1>first<h1>second</h1>" },
  { name: "nested h1 opens with one close", html: "<h1><h1>inner</h1>" },
  { name: "unterminated title open", html: "<title x" },
  { name: "many unterminated title opens", html: "<title a<title b<title c" },
  { name: "title open with no close", html: "<title>dangling" },
  { name: "<h1 followed by a word char still matches (no \\b in this regex, unlike <li)", html: "<h1x>Yes</h1>" },
  { name: "h1 close with a level mismatch", html: "<h1>text</h2>" },
  { name: "a bare '<' before the h1", html: "<<h1>after stray</h1>" },
  { name: "empty string", html: "" },
  { name: "only a '<'", html: "<" },
];

describe("extractTitle differential harness: the bounded scan matches the frozen regex oracle", () => {
  for (const { name, html } of TITLE_CASES) {
    test(name, () => {
      expect(extractTitle(html)).toBe(oldExtractTitle(html));
    });
  }

  test("10,000 randomized title-shaped documents (seeded): zero divergence", () => {
    const rand = mulberry32(0x71713);
    const pick = <T,>(arr: T[]): T => arr[Math.floor(rand() * arr.length)]!;
    // Vocabulary biased at the two regexes' own edges: opens with and without their `>`, closes,
    // level mismatches, `</h1>` text sitting inside an open tag, and bare `<`/`>`.
    const TOKENS = [
      "<h1>", "<h1 ", '<h1 class="x">', "<h1x>", "</h1>", "</H1>", "<H1>",
      "<title>", "<title ", '<title lang="en">', "</title>", "</TITLE>",
      "<", ">", "<p>", "</p>", "<b>x</b>", "text", " ", "\n", "&amp;", "&lt;",
      "</h2>", '<a href="/x">link</a>', "<li x", "<script",
    ];
    let divergences = 0;
    const examples: string[] = [];
    for (let i = 0; i < 10_000; i++) {
      const len = 1 + Math.floor(rand() * 14);
      let doc = "";
      for (let j = 0; j < len; j++) doc += pick(TOKENS);
      if (extractTitle(doc) !== oldExtractTitle(doc)) {
        divergences++;
        if (examples.length < 10) examples.push(doc);
      }
    }
    if (divergences > 0) console.error("extractTitle divergences", examples);
    expect(divergences).toBe(0);
  });
});
