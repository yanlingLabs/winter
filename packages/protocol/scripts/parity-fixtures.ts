/**
 * Chat Slice D, Task 4 — cross-language parity fixture construction, shared between `generate.ts`
 * (which WRITES `fixtures/dangerous-domains.json` + `fixtures/cleaner-vectors.json`) and this
 * package's own freshness test (`test/parity-fixtures.test.ts`). Both sides call the SAME
 * functions below — never a second, independently-typed copy of the domain list, the vector
 * inputs, or the html->lines transform — so the test's "regenerating produces byte-identical
 * output" claim is actually true by construction: if a fixture on disk ever disagrees with what
 * these functions compute RIGHT NOW, that's real drift (core's htmlToText/renderLines/
 * SHIPPED_DANGEROUS_DOMAINS changed and `pnpm protocol:generate` wasn't re-run), not a false
 * positive from two hand-maintained copies disagreeing with each other.
 *
 * Reaches into `@norma/core` via a RELATIVE import, deliberately: core depends on protocol
 * (`@norma/core`'s package.json lists `@norma/protocol`), never the reverse — protocol declaring a
 * package dependency on core would be a real cycle. This file is a dev-time codegen/test helper
 * only, though, never part of protocol's published `"."` export (`src/index.ts`, which does not
 * import this file or anything under `scripts/`) — no protocol *consumer* ever pulls core in via
 * this path. `SHIPPED_DANGEROUS_DOMAINS`/`htmlToText`/`renderLines`/`CleanPage` are already
 * exported by core for their own callers, so this only reuses the real symbols, never duplicates
 * their values.
 */
import { SHIPPED_DANGEROUS_DOMAINS } from "../../core/src/agent/dangerous-domains";
import { htmlToText } from "../../core/src/agent/tools/web";
import { renderLines, type CleanPage } from "../../core/src/agent/tools/page-core";

/** The exact shipped dangerous-domain list, verbatim — `fixtures/dangerous-domains.json`'s entire
 *  content (a plain JSON array, no wrapper object). */
export function buildDangerousDomainsFixture(): readonly string[] {
  return SHIPPED_DANGEROUS_DOMAINS;
}

export interface CleanerVectorInput {
  name: string;
  html: string;
}

export interface CleanerVector {
  name: string;
  html: string;
  lines: string[];
}

/** >20k-char page (coverage: "cap behavior") — built by APPENDING real paragraph markup until the
 *  html crosses the threshold, rather than a fixed repeat count, so the exact byte length is a
 *  deterministic function of the loop, never a guessed constant. Proves `htmlToText`/`renderLines`
 *  apply no hidden line/length cap of their own on a large page (unlike web.ts's network-layer
 *  MAX_FETCH_BYTES/PREVIEW_BYTES, which this pure pipeline never touches). */
function buildLargeHtml(): string {
  let html = "<h1>Large Page</h1>";
  let i = 0;
  while (html.length < 20_500) {
    html += `<p>Paragraph ${i}: the quick brown fox jumps over the lazy dog for cap-behavior padding.</p>`;
    i++;
  }
  return html;
}

/** ≥12 vectors (task-4-brief.md's coverage list): nested blocks, lists, tables, pre/code, entities,
 *  comments/scripts stripped, malformed nesting, unicode, the two accepted linearization-
 *  divergence-class regression INPUTS named in web.ts's "PRICE OF LINEARITY" comment (copied
 *  verbatim — `<h3<h2>` and `<a href="href=">` — letting THIS module compute their outputs, never
 *  hand-copying either), an empty page, and a >20k-char page. */
export const CLEANER_VECTOR_INPUTS: CleanerVectorInput[] = [
  {
    name: "nested inline blocks",
    html: "<div><p>Some <b>bold <i>italic</i></b> and <span>span</span> text.</p></div>",
  },
  {
    name: "ordered and unordered lists",
    html: "<ul><li>Alpha</li><li>Beta</li></ul><ol><li>First</li><li>Second</li></ol>",
  },
  {
    name: "a simple table",
    html: "<table><tr><td>Name</td><td>Score</td></tr><tr><td>Ada</td><td>42</td></tr></table>",
  },
  {
    name: "pre/code block (no special preformatting)",
    html: "<pre><code>function add(a, b) {\n  return a + b;\n}</code></pre>",
  },
  {
    name: "HTML entities",
    html: "<p>Tom &amp; Jerry &lt;3 say &quot;hi&quot; and &#39;bye&#39;&nbsp;now</p>",
  },
  {
    name: "comments and scripts/styles stripped",
    html: "<!-- top comment --><style>.x{color:red}</style><script>alert('hi')</script><p>Visible text only.</p><!-- trailing comment -->",
  },
  {
    name: "malformed nesting: unclosed li items",
    html: "<ul><li>Item one<li>Item two<li>Item three</ul>",
  },
  {
    name: "unicode text",
    html: "<p>héllo wörld — 日本語のテスト — emoji 🎉 and café ümlaut</p>",
  },
  {
    // web.ts's "PRICE OF LINEARITY" comment, divergence class (A): "an open like `<h3<h2>` whose
    // `[^>]*` swallowed a later heading open" — regression input copied verbatim.
    name: "heading linearization divergence class (PRICE OF LINEARITY A, web.ts)",
    html: "<p>before</p><h3<h2>Nested Heading</h2><p>after</p>",
  },
  {
    // Divergence class (B): "pathological href values like `<a href=\"href=\">` pair differently
    // for the same backtracking reason" — regression input copied verbatim.
    name: "anchor linearization divergence class (PRICE OF LINEARITY B, web.ts)",
    html: '<p>before</p><a href="href=">divergent anchor text</a><p>after</p>',
  },
  {
    name: "empty page",
    html: "",
  },
  {
    name: ">20k-char page (cap behavior)",
    html: buildLargeHtml(),
  },
  {
    name: "links rewritten to text (href)",
    html: '<p>See <a href="https://example.com/a">Example A</a> and <a href="/relative/b">Example B</a>.</p>',
  },
  {
    name: "mixed-case tags and self-closing <br> variations",
    html: "<P>Line one<BR>Line two<br/>Line three</P><H2>Heading</H2>",
  },
];

/** The shared html->lines transform: `htmlToText` builds the cleaned-line array exactly the way
 *  `page-core.ts`'s `fetchCleanPage` does (`cleanedText.split("\n")` becomes `CleanPage.lines`),
 *  then `renderLines` (no range — the whole page) numbers it. `title`/`url`/`fetchedAt` are fixed,
 *  content-independent placeholders (this fixture is about the html->lines pipeline, not title
 *  extraction or caching), so every vector's header reads `"Fixture (lines 1-N of N)"` uniformly. */
export function buildCleanerVector(input: CleanerVectorInput): CleanerVector {
  const page: CleanPage = {
    url: "https://example.com/fixture",
    title: "Fixture",
    lines: htmlToText(input.html).split("\n"),
    links: [],
    fetchedAt: 0,
    fromCache: false,
  };
  return { name: input.name, html: input.html, lines: renderLines(page).split("\n") };
}

export function buildCleanerVectorsFixture(): CleanerVector[] {
  return CLEANER_VECTOR_INPUTS.map(buildCleanerVector);
}
