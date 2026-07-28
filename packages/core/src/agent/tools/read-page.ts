import { z } from "zod";
import type { ToolRegistry } from "./registry";
import { fetchCleanPage, renderLines, PageCache, PageCoreError, checkDangerousDomain, dangerousDomainRefusal } from "./page-core";

/**
 * ReadPage (B2-T2): chat mode's (and, per user decision, dispatch's) batched page-reading tool —
 * the registered wrapper around Task 1's page-core module (`fetchCleanPage`/`renderLines`/
 * `PageCache`). See task-2-brief.md + docs/superpowers/specs/2026-07-26-chat-mode-slice-b2-design.md.
 *
 * CITE THE RESOLVED URL, EVERYWHERE — a named obligation carried over from Task 1's review:
 * `PageCache` keys by the FINAL, post-redirect `CleanPage.url` (page-core.ts's own doc comment), so
 * a citation built from the caller-supplied (pre-redirect) address always refetches instead of
 * hitting the cache. Every header below states the input URL once, as "requested: X → resolved:
 * Y", ONLY when they differ, and cites `page.url` (the resolved one) everywhere else — that is what
 * keeps a later `lineStart`/`lineEnd` follow-up call landing in the same cache entry.
 *
 * Two-tools-not-one (spec §"User decisions", item 1): this file registers ONLY `ReadPage`, the main
 * chat model's tool (batching, optional `query`, optional line ranges, optional `max_pages`).
 * `FetchPage` — the research sub-agent's *only* tool (batches too, but no `query`/ranges/max_pages)
 * — is Task 3's, and is deliberately never registered in the daemon's shared registry at all (its
 * own tiny toolset lives entirely inside the ephemeral research call) — see
 * mode-toolset-census.test.ts's forward guard.
 */

const MAX_PAGES = 8;
export const READPAGE_PER_PAGE_CHAR_CAP = 20_000; // one page's rendered section, incl. its Links: tail
export const READPAGE_TOTAL_OUTPUT_CHAR_CAP = 60_000; // the whole batch response — chat has no `read`
// tool, so there is no save-to-file escape hatch (Search's own doc comment makes the same point):
// whatever this returns inline is ALL the model gets.

const RESEARCH_UNAVAILABLE = "research is not available in this session yet";

const PageRequest = z
  .object({
    url: z.string().min(1),
    query: z.string().min(1).optional(),
    lineStart: z.number().int().positive().optional(),
    lineEnd: z.number().int().positive().optional(),
    max_pages: z.number().int().positive().optional(), // only meaningful with query
  })
  .refine((p) => !(p.query && (p.lineStart || p.lineEnd)), {
    message: "query and line ranges are mutually exclusive per entry",
  });

const ReadPageArgs = z.object({ pages: z.array(PageRequest).min(1).max(MAX_PAGES) });

type PageRequestT = z.infer<typeof PageRequest>;

/** What the tool passes a wired research runner for a `query` entry — the entry's own url/query,
 *  plus its optional model-chosen `max_pages` (Task 3 clamps this to its own hard ceiling).
 *  `cwd` (Critical 1 fix, whole-branch review) is the calling turn's `ctx.cwd`, threaded through
 *  SOLELY so the sub-agent's own dangerous-domain hard-block (research.ts) can resolve the SAME
 *  per-project `settings.permissions.dangerousDomains.added` list this tool's own hard-block uses —
 *  the sub-agent has no session/cwd identity of its own (by design, see research.ts's module doc
 *  comment), so this is its only route to that per-project list. */
export interface ResearchQuery {
  url: string;
  query: string;
  max_pages?: number;
  cwd?: string;
}

/**
 * Task 3's hook: given a page URL and a query, run the ephemeral research sub-agent (its own
 * `FetchPage`-only toolset — ideas doc §4/§5) to completion and return the finished, cited report
 * TEXT — the exact string that becomes this entry's ReadPage output. Absent in Task 2 (this tool
 * ships without it): a `query` entry then resolves to `RESEARCH_UNAVAILABLE` instead of calling
 * anything, so ReadPage works standalone before Task 3 lands.
 */
export interface ResearchRunner {
  run(q: ResearchQuery, opts: { signal?: AbortSignal }): Promise<string>;
}

export interface ReadPageDeps {
  cache: PageCache;
  /** Emits one line per fetched page (never per batch) — page-core's own `fetchCleanPage` calls
   *  this directly, so ReadPage never double-audits a fetch. */
  audit?: (line: Record<string, unknown>) => void;
  /** Test-only injection point (defaults to global fetch) — no live network in the test suite. */
  fetchFn?: typeof fetch;
  /** Injectable clock, forwarded to page-core's TTL bookkeeping — test-only. */
  now?: () => number;
  /** Task 3 wires this; absent (Task 2's shipped state) → every `query` entry is a no-op failure. */
  research?: ResearchRunner;
  /** Test-only override of page-core's own default per-fetch timeout (DEFAULT_FETCH_TIMEOUT_MS) —
   *  forwarded straight through to `fetchCleanPage` (fix-round-1 CRITICAL) so a test can prove
   *  ReadPage itself no longer hangs on a stuck fetch without waiting out the real 15s default.
   *  Production never sets this — every real call is bounded by page-core's own fixed default. */
  timeoutMs?: number;
  /** Critical 1 fix (whole-branch review, USER-REVISED design 2026-07-28): the user-added half of
   *  the effective dangerous-domain list — SAME shape/getter as engine.ts's own
   *  `EngineConfig.dangerousDomainsAdded` (and, in daemon.ts, literally the SAME function reference),
   *  resolved per-project, hot (no daemon restart). Absent → no user additions; the SHIPPED list
   *  alone still applies. See `page-core.ts`'s `checkDangerousDomain` for the full rationale — this
   *  tool has NO approval flow, so a match here is a hard refusal, never a card. */
  dangerousDomainsAdded?: (cwd?: string) => string[] | undefined;
}

type EntryResult = { ok: boolean; text: string };

/** Truncates `text` to at most `cap` characters TOTAL (including `marker`) when it's over cap —
 *  never silently drops the marker itself over the limit, unlike Search's simpler
 *  slice-then-append (whose marker rides a couple bytes past its own cap; harmless there, but this
 *  tool's caps are asserted on exactly, so the marker's length is reserved up front). */
function capText(text: string, cap: number, marker: string): string {
  if (text.length <= cap) return text;
  return text.slice(0, Math.max(0, cap - marker.length)) + marker;
}

/** Renders one non-`query` entry: cache-aware `fetchCleanPage` -> `renderLines`, wrapped with the
 *  resolved-URL header and a `Links:` tail. Never throws — a fetch failure (SSRF refusal, timeout,
 *  http/network/parse error) becomes an `ok:false` result instead, so one bad URL in a batch can
 *  never take the others down with it.
 *
 *  fix-round-2 Minor: `signal` (the calling turn's own `ctx.signal`) is forwarded into
 *  `fetchCleanPage` — before this, a user-interrupted turn left a plain page-read fetch running to
 *  the full per-fetch default bound regardless. `fetchCleanPage`'s own signal composition
 *  (`AbortSignal.any`) already means whichever of the caller's signal or the default fires FIRST
 *  wins, so this is a pure forward, no new composition logic needed here.
 *
 *  Critical 1 fix (whole-branch review): a dangerous-domain url is refused BEFORE `fetchCleanPage`
 *  is ever called — zero network reached, no card (chat has no approval flow at all, USER DECISION)
 *  — see `checkDangerousDomain`'s own doc comment for the full rationale.
 *
 *  Minor 3 fix (whole-branch review, fix round 2): the SAME resolved `added` list is also forwarded
 *  into `fetchCleanPage` as `dangerousAdded`, so a SAFE url that redirects INTO a dangerous host
 *  (this check above only catches the caller-supplied url itself) is caught by page-core's own
 *  post-redirect re-check instead of sailing through. */
async function renderPage(entry: PageRequestT, deps: ReadPageDeps, signal: AbortSignal | undefined, cwd: string | undefined): Promise<EntryResult> {
  const added = deps.dangerousDomainsAdded?.(cwd);
  const dangerous = checkDangerousDomain(entry.url, added);
  if (dangerous) {
    return { ok: false, text: dangerousDomainRefusal(entry.url, dangerous, "ReadPage has no approval flow to ask for one, so fetches to known exfiltration/tunnel-provider hosts are blocked outright") };
  }
  try {
    const page = await fetchCleanPage(entry.url, deps.cache, {
      fetchFn: deps.fetchFn,
      now: deps.now,
      audit: deps.audit,
      timeoutMs: deps.timeoutMs,
      signal,
      dangerousAdded: added,
    });
    const rendered = renderLines(page, entry.lineStart, entry.lineEnd);
    const newlineIdx = rendered.indexOf("\n");
    const headerLine = newlineIdx === -1 ? rendered : rendered.slice(0, newlineIdx);
    const body = newlineIdx === -1 ? "" : rendered.slice(newlineIdx + 1);
    // renderLines' own header always carries "lines X-Y of Z" (clamped or not) — reused here rather
    // than re-deriving the clamp arithmetic a second time, just reformatted with the colon this
    // tool's citation contract uses ("lines:N-M", matching the spec doc's own citation examples).
    const m = headerLine.match(/lines (\d+)-(\d+) of (\d+)/);
    const start = m?.[1] ?? "1";
    const end = m?.[2] ?? String(page.lines.length);
    const total = m?.[3] ?? String(page.lines.length);

    // CITE THE RESOLVED URL, EVERYWHERE: state the input once, only when it actually differed —
    // every citation after this line is `page.url`, the address the shared cache is keyed on.
    const urlLine = entry.url === page.url ? page.url : `requested: ${entry.url} → resolved: ${page.url}`;

    // Minor 5 fix (whole-branch review, fix round 2): strip dangerous-domain links from the
    // rendered Links: tail before the model ever sees them — same rationale as Search's own
    // dangerous-result fold-in (search.ts): advertising a link the hard-block would refuse anyway
    // is a half-measure that just has the model try it, fail, and possibly retry. Never a silent
    // drop: the withheld count is always stated, so a shorter list reads as a deliberate filter,
    // not an incomplete one.
    let linksWithheld = 0;
    const safeLinks = page.links.filter((l) => {
      if (!checkDangerousDomain(l.href, added)) return true;
      linksWithheld++;
      return false;
    });
    const withheldNote = linksWithheld > 0 ? `(${linksWithheld} link${linksWithheld === 1 ? "" : "s"} withheld — matched the dangerous-domain list)` : undefined;
    const linksList = safeLinks.length
      ? safeLinks.map((l, i) => `${i + 1}. ${l.text || "(no text)"} (${l.href})`).join("\n") + (withheldNote ? `\n${withheldNote}` : "")
      : withheldNote ?? "(none)";

    // Important 3 fix (whole-branch review): `page.fromCache` already existed but was unused by
    // this tool — the model had no way to tell a cached read from a fresh refetch, even though the
    // two renders are byte-identical otherwise. Stated plainly here rather than left implicit.
    const freshness = page.fromCache ? "cached" : "fresh fetch";
    const text = capText(
      [urlLine, `${page.title} — lines:${start}-${end} of ${total} (${freshness})`, body, "", "Links:", linksList].join("\n"),
      READPAGE_PER_PAGE_CHAR_CAP,
      `\n[page output truncated at ${READPAGE_PER_PAGE_CHAR_CAP} chars — request a narrower lineStart/lineEnd]`,
    );
    return { ok: true, text };
  } catch (e) {
    const message = e instanceof PageCoreError || e instanceof Error ? e.message : String(e);
    // Cite the INPUT url here (never a "resolved" one — there isn't one; the fetch never
    // succeeded), so the failing section in a batch is still identifiable by the url it was asked
    // to read.
    return { ok: false, text: `${entry.url}: ${message}` };
  }
}

/** Runs a `query` entry through the wired research hook (Task 3) — or, absent one, resolves to the
 *  fixed "not available" message. Never throws on its own: a research-runner failure becomes an
 *  `ok:false` result exactly like a fetch failure above, so it rides the same one-bad-entry
 *  isolation.
 *
 *  Critical 1 fix (whole-branch review): the SEED url (this entry's own `entry.url`) is
 *  dangerous-domain-checked BEFORE the research runner is ever invoked — a query entry pointed at a
 *  blocked host must not even start the sub-agent. This is defense-in-depth as much as anything: it
 *  is also the ONLY place the seed gets checked before reaching `research.run()` at all, since the
 *  sub-agent itself has no cwd/settings context of its own for anything BUT what `cwd` (below) hands
 *  it for its own SEPARATE hard-block on the pages it fetches later via FetchPage (research.ts). */
async function runResearch(entry: PageRequestT, deps: ReadPageDeps, signal: AbortSignal | undefined, cwd: string | undefined): Promise<EntryResult> {
  if (!deps.research) return { ok: false, text: RESEARCH_UNAVAILABLE };
  const dangerous = checkDangerousDomain(entry.url, deps.dangerousDomainsAdded?.(cwd));
  if (dangerous) {
    return { ok: false, text: dangerousDomainRefusal(entry.url, dangerous, "research has no approval flow to ask for one, so a blocked seed page is refused outright") };
  }
  try {
    const report = await deps.research.run({ url: entry.url, query: entry.query!, max_pages: entry.max_pages, cwd }, { signal });
    return { ok: true, text: report };
  } catch (e) {
    return { ok: false, text: `research failed for ${entry.url}: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export function registerReadPageTool(r: ToolRegistry, deps: ReadPageDeps): void {
  r.register({
    name: "ReadPage",
    description:
      "Read one or more web pages as clean, line-numbered markdown, each followed by a 'Links:' tail listing that page's outbound links. " +
      "Batch up to 8 pages in a single call — each entry is independent. " +
      "With no lineStart/lineEnd the whole page loads (subject to a per-page size cap); give lineStart/lineEnd to load just that inclusive line range instead. " +
      "Cite what you used as '<url> lines:N-M', using the RESOLVED url shown in the output (after any redirect) — never the url you originally requested. " +
      "The same lineStart/lineEnd reloads the identical text later as long as the page is still cached — usually around an hour, but heavy fetching can reclaim it sooner, so don't assume a fixed window. " +
      "Each page's header says '(cached)' or '(fresh fetch)' — check that instead: 'cached' means the same bytes you saw before, 'fresh fetch' means the page was reloaded and may have changed since. " +
      "Give an entry 'query' instead of a line range to run background research over that page and its links — you get back a cited report instead of the raw page. 'query' and a line range cannot both be set on the same entry.",
    // User decision (spec §6): dispatch gets the SAME ReadPage as chat, immediate — not deferred
    // (see the `deferred` field's absence below — bug #7's precedent: chat's derived toolset has no
    // ToolSearch member unless something chat-eligible is itself deferred, so a deferred ReadPage
    // here would be permanently uncallable there, exactly like `Search`'s own doc comment argues).
    modes: ["chat", "dispatch"],
    args: ReadPageArgs,
    async run({ pages }: z.infer<typeof ReadPageArgs>, ctx) {
      const results = await Promise.all(
        pages.map((entry) => (entry.query ? runResearch(entry, deps, ctx.signal, ctx.cwd) : renderPage(entry, deps, ctx.signal, ctx.cwd))),
      );
      const anyOk = results.some((res) => res.ok);
      // A single-entry call returns its own text bare (no "## Page 1" wrapper) — the common case,
      // and what keeps a one-page fetch/one-query call's output free of batch furniture. A
      // multi-entry call labels each section so a mixed success/failure batch stays legible.
      let combined =
        results.length === 1
          ? results[0]!.text
          : results.map((res, i) => `## Page ${i + 1}\n${res.text}`).join("\n\n---\n\n");
      combined = capText(combined, READPAGE_TOTAL_OUTPUT_CHAR_CAP, "\n\n[batch output truncated]");
      // One bad entry must not fail the whole batch (spec's testing section, "Batching"): only
      // throw (-> isError:true) when EVERY entry failed, so the registry's own catch-to-isError
      // path carries this exact message through untouched — matches the query-with-no-research
      // case's contract ("isError 'research is not available'") for the common single-entry shape.
      if (!anyOk) throw new Error(combined);
      return combined;
    },
  });
}
