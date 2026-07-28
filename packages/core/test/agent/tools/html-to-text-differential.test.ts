import { describe, expect, test } from "bun:test";
import { htmlToText } from "../../../src/agent/tools/web";

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
  const NO_TERMINATOR_TAGS = ["script", "style", "head"]; // the class that used to diverge — see above

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
