import { followRedirects, htmlToText } from "./web";

/**
 * page-core: the shared building block behind chat mode's `ReadPage` tool (read a web page as
 * clean numbered markdown with its links preserved, load line ranges, batch pages) and its
 * research sub-agent — fetch -> clean -> extract links -> deterministic line numbering ->
 * in-memory TTL cache. Deliberately NOT registered as a tool: this file is a pure module with no
 * filesystem, no shell, nothing chat-mode-specific — a later task wraps it as `ReadPage`.
 *
 * Reuses web.ts's `followRedirects` (SSRF-guards EVERY redirect hop, streams with a byte cap,
 * injectable `fetchFn`) and `htmlToText` (headings -> `#`, links -> `text (href)`, lists -> `- `)
 * — fetching, SSRF policy, and whole-page text cleaning are NOT reimplemented here. Link
 * EXTRACTION, though, must run on the RAW html BEFORE `htmlToText`, because `htmlToText` rewrites
 * every `<a>` tag into `text (href)` prose and so destroys the structure a link list needs.
 *
 * The cache is in-memory ONLY, and that is a SECURITY posture, not a performance choice: chat
 * mode's contract is that it leaves nothing behind, and `~/.norma` is agent-readable by design
 * (only the run dir is denied — see CLAUDE.md's tool-surface note) — a disk cache would put
 * fetched web content into a location the agent (and, on a shared machine, whoever else can read
 * that agent's files) can read outside of the conversation that fetched it. Memory-only means the
 * cache vanishes with the process, same as everything else about a chat session.
 */

const DEFAULT_TTL_MS = 60 * 60 * 1000; // ~1h (USER DESIGN, task-1-brief.md)
const DEFAULT_MAX_ENTRIES = 50;
const DEFAULT_MAX_BYTES = 20 * 1024 * 1024; // 20MB soft cap — a handful of full pages (web.ts caps one fetch at 5MB)

/** B2-T3 fix-round-1 CRITICAL: mirrors web.ts's `REQUEST_TIMEOUT_MS` — this module's own fetch
 *  (`followRedirects`, below) used to be called with NO signal at all, so a stuck connection could
 *  hang `fetchCleanPage` (and everything built on it — plain `ReadPage` and the research runner)
 *  forever. Every call now gets a bound by default, combined with (never replaced by) any
 *  caller-supplied signal — a caller that forgets to pass one is still bounded. */
const DEFAULT_FETCH_TIMEOUT_MS = 15_000;

/** Fixed, small, NAMED seed list (USER DESIGN) — "no ads in the links list," not a full adblocker.
 *  Matched against the RESOLVED link's `hostname`/`pathname` (never a raw substring of the two
 *  concatenated — that let an unrelated page whose PATH merely contained one of these strings,
 *  e.g. `example.com/doubleclick.net.html`, get silently dropped as if it were the ad host itself;
 *  fix round 1, Important). Two entry shapes, both host-scoped:
 *   - a bare host (`doubleclick.net`, `googletagmanager.com`, `google-analytics.com`) matches the
 *     resolved hostname EXACTLY or as a dot-bounded SUBDOMAIN (`stats.doubleclick.net` drops,
 *     `notdoubleclick.net` does not — no bare substring check would tell those two apart);
 *   - `host/path` (`facebook.com/tr`, Meta's pixel-tracking endpoint) matches only the EXACT host
 *     `facebook.com` with a pathname starting `/tr` — scoped this tightly on purpose so it doesn't
 *     drop unrelated facebook.com links, or any other host whose path merely mentions "facebook.com/tr". */
export const AD_TRACKER_LINK_SUBSTRINGS = [
  "doubleclick.net",
  "googletagmanager.com",
  "google-analytics.com",
  "facebook.com/tr",
] as const;

/** See `AD_TRACKER_LINK_SUBSTRINGS`'s doc comment for the two entry shapes this checks. */
function isAdTrackerLink(resolved: URL): boolean {
  const host = resolved.hostname.toLowerCase();
  const path = resolved.pathname;
  return AD_TRACKER_LINK_SUBSTRINGS.some((entry) => {
    const slash = entry.indexOf("/");
    if (slash === -1) return host === entry || host.endsWith(`.${entry}`);
    const entryHost = entry.slice(0, slash);
    const entryPath = entry.slice(slash); // keeps the leading "/"
    return host === entryHost && path.startsWith(entryPath);
  });
}

export interface CleanPage {
  url: string; // final resolved URL after redirects
  title: string;
  lines: string[]; // deterministic: same input bytes -> identical array
  links: Array<{ href: string; text: string }>; // absolute, deduped, ad/tracker hosts dropped
  fetchedAt: number; // epoch ms (from the injected clock)
  fromCache: boolean;
}

export interface PageCoreDeps {
  fetchFn?: typeof fetch; // injectable; default global fetch
  now?: () => number; // injectable clock for TTL tests
  audit?: (line: Record<string, unknown>) => void;
  /** Audit-line `tool` label — a named obligation from Task 2's review (task-3-brief.md): every
   *  audit line below used to hardcode `tool: "ReadPage"`, which would have mislabeled every fetch
   *  the FetchPage-only research sub-agent (Task 3, agent/research.ts) drives through this SAME
   *  function. Defaults to "ReadPage" so ReadPage's own call sites (read-page.ts's `renderPage`)
   *  are byte-identical without passing this; the research runner passes "FetchPage" instead, so
   *  audit.jsonl can tell the two callers apart. */
  tool?: string;
  /** Caller-supplied abort (e.g. research.ts's own wall-clock deadline signal) — combined
   *  (`AbortSignal.any`) with this function's own default per-fetch timeout below, never a
   *  replacement for it: a caller's signal can only narrow the bound, never widen it past
   *  DEFAULT_FETCH_TIMEOUT_MS (or `timeoutMs`, if overridden). */
  signal?: AbortSignal;
  /** Test-only override of DEFAULT_FETCH_TIMEOUT_MS. Production never sets this — every real
   *  caller is bounded by the fixed 15s default regardless of whether it also passes `signal`. */
  timeoutMs?: number;
}

interface CacheEntry {
  page: CleanPage;
  expiresAt: number;
  bytes: number;
}

/** Rough byte weight of a cached page — good enough to govern LRU/byte-cap pressure; not an exact
 *  wire size and never security-relevant (the cap is a memory-hygiene knob, not a trust boundary). */
function estimateBytes(page: CleanPage): number {
  let total = Buffer.byteLength(page.url, "utf8") + Buffer.byteLength(page.title, "utf8");
  for (const line of page.lines) total += Buffer.byteLength(line, "utf8") + 1;
  for (const link of page.links) total += Buffer.byteLength(link.href, "utf8") + Buffer.byteLength(link.text, "utf8");
  return total;
}

/**
 * In-memory ONLY (see module doc comment above for why) TTL+LRU cache of cleaned pages, keyed by
 * the resolved `CleanPage.url`. `get`/`put` never re-clean — storing the CLEANED result (not raw
 * bytes) is exactly what makes a citation's line range stable inside the TTL: two `get`s of the
 * same entry return the SAME `lines` array (see `fetchCleanPage`'s determinism contract).
 *
 * A single eviction pass enforces both caps together: after every `put`, oldest-first (Map
 * iteration order tracks insertion/recency — `get` re-inserts its key to mark it most-recently-used)
 * entries are dropped until both `size <= maxEntries` and the running byte total `<= maxBytes`.
 */
export class PageCache {
  private entries = new Map<string, CacheEntry>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private totalBytes = 0;

  constructor(opts?: { ttlMs?: number; maxEntries?: number; maxBytes?: number }) {
    this.ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS;
    this.maxEntries = opts?.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.maxBytes = opts?.maxBytes ?? DEFAULT_MAX_BYTES;
  }

  get(url: string, now: number): CleanPage | undefined {
    const entry = this.entries.get(url);
    if (!entry) return undefined;
    if (now >= entry.expiresAt) {
      this.entries.delete(url);
      this.totalBytes -= entry.bytes;
      return undefined;
    }
    // Refresh recency (LRU): delete + re-insert so this key becomes the most-recently-used —
    // Map iteration order is insertion order, so this is also the LAST key `evict()` would touch.
    this.entries.delete(url);
    this.entries.set(url, entry);
    return { ...entry.page, fromCache: true };
  }

  put(page: CleanPage, now: number): void {
    const existing = this.entries.get(page.url);
    if (existing) {
      this.totalBytes -= existing.bytes;
      this.entries.delete(page.url);
    }
    const bytes = estimateBytes(page);
    this.entries.set(page.url, { page: { ...page, fromCache: false }, expiresAt: now + this.ttlMs, bytes });
    this.totalBytes += bytes;
    this.evict();
  }

  private evict(): void {
    for (const [key, entry] of this.entries) {
      if (this.entries.size <= this.maxEntries && this.totalBytes <= this.maxBytes) break;
      this.entries.delete(key);
      this.totalBytes -= entry.bytes;
    }
  }
}

/** Own small title-extraction helper — NOT web.ts's private `extractTitle` (it isn't exported;
 *  only `followRedirects`, `ssrfGuard` (transitively, via `followRedirects`), and `htmlToText` are).
 *  Same idea (h1, else `<title>`, run through `htmlToText` and collapsed to one line) kept small
 *  and separate rather than exporting web.ts internals this task doesn't otherwise need. */
function extractTitle(html: string): string {
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const src = h1?.[1] ?? html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  if (!src) return "-";
  const text = htmlToText(src).replace(/\n+/g, " ").trim();
  return text || "-";
}

/** Extracts links from RAW html (before `htmlToText`, which rewrites every `<a>` into
 *  `text (href)` prose and so destroys the tag) — the same `<a href="...">...</a>` pattern
 *  `htmlToText` itself matches. Every href is absolute-resolved against `baseUrl` (the FINAL,
 *  post-redirect URL). Drops fragment-only in-page anchors, non-http(s) schemes (`mailto:`,
 *  `javascript:`, ...), and known ad/tracker hosts; dedupes by resolved href, keeping the first
 *  occurrence's anchor text. */
function extractLinks(html: string, baseUrl: string): Array<{ href: string; text: string }> {
  const re = /<a\s[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const seen = new Set<string>();
  const links: Array<{ href: string; text: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const rawHref = m[1] ?? "";
    if (!rawHref || rawHref.startsWith("#")) continue; // in-page anchor only, never a real link
    let resolved: URL;
    try {
      resolved = new URL(rawHref, baseUrl);
    } catch {
      continue; // unparsable href — skip rather than fail the whole page
    }
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") continue; // mailto:, javascript:, ...
    if (isAdTrackerLink(resolved)) continue;
    const href = resolved.toString();
    if (seen.has(href)) continue;
    seen.add(href);
    const text = htmlToText(m[2] ?? "").replace(/\n+/g, " ").trim();
    links.push({ href, text });
  }
  return links;
}

/** Structured error thrown by `fetchCleanPage` — `outcome` is web.ts's exact vocabulary
 *  (`ssrf_refused`/`timeout`/`http_error`/`network_error`/`parse_error`), attached as a real field
 *  rather than left for callers to re-derive from the message text. Mirrors web.ts's own local
 *  `outcome` variable, just carried on the thrown error since this module has no `run()`/audit
 *  closure of its own to keep it in. */
export class PageCoreError extends Error {
  constructor(
    message: string,
    public readonly outcome: string,
  ) {
    super(message);
    this.name = "PageCoreError";
  }
}

/**
 * Fetch + clean + link-extract a page, serving a cached CLEANED copy inside the TTL instead of
 * re-fetching or re-cleaning. That is the determinism contract: a citation `url lines:N-M` must
 * re-resolve to the same text later, which only holds if the SAME cleaned `lines` array is served
 * every time inside the cache window — never a fresh re-clean of possibly-changed live bytes.
 *
 * Cache key nuance: `cache.get`/`cache.put` are keyed by `CleanPage.url` (the FINAL, resolved
 * address) — for a `url` that doesn't redirect, that's identical to what's passed in here, so
 * repeat calls with the same string hit the cache. For a `url` that DOES redirect, a repeat call
 * with the original (pre-redirect) address will still refetch; a repeat call with the previously
 * RETURNED (resolved) address — exactly what a citation cites and a later `ReadPage` call would
 * pass — hits the cache. This matches the one property that matters here: citations stay stable.
 */
export async function fetchCleanPage(url: string, cache: PageCache, deps: PageCoreDeps = {}): Promise<CleanPage> {
  const now = deps.now?.() ?? Date.now();

  const tool = deps.tool ?? "ReadPage";

  const cached = cache.get(url, now);
  if (cached) {
    deps.audit?.({ kind: "network", tool, url, outcome: "ok", fromCache: true });
    return cached;
  }

  // fix-round-1 CRITICAL: always bounded, even when `deps.signal` is absent — see
  // DEFAULT_FETCH_TIMEOUT_MS's own doc comment.
  const timeoutSignal = AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS);
  const signal = deps.signal ? AbortSignal.any([deps.signal, timeoutSignal]) : timeoutSignal;

  const res = await followRedirects(url, { fetchFn: deps.fetchFn, signal });
  if (!res.ok) {
    const outcome =
      res.kind === "ssrf"
        ? "ssrf_refused"
        : res.kind === "timeout"
          ? "timeout"
          : res.kind === "redirects"
            ? "too_many_redirects"
            : res.kind === "http"
              ? "http_error"
              : "network_error";
    deps.audit?.({ kind: "network", tool, url, outcome });
    throw new PageCoreError(res.error, outcome);
  }

  let page: CleanPage;
  try {
    const isHtml = res.contentType.toLowerCase().includes("text/html");
    // Non-HTML path: htmlToText (the HTML path) already trims each line, which incidentally drops
    // a trailing "\r" too — the raw-text path has no such step, so a CRLF body (any .txt/code
    // fetch) would otherwise leak "\r" onto every line but the last (fix round 1, Minor).
    const cleanedText = isHtml ? htmlToText(res.body) : res.body.replace(/\r\n/g, "\n");
    const title = isHtml ? extractTitle(res.body) : "-";
    const links = isHtml ? extractLinks(res.body, res.url) : [];
    page = { url: res.url, title, lines: cleanedText.split("\n"), links, fetchedAt: now, fromCache: false };
  } catch (e) {
    deps.audit?.({ kind: "network", tool, url, outcome: "parse_error" });
    throw new PageCoreError(`could not parse page content: ${e instanceof Error ? e.message : String(e)}`, "parse_error");
  }

  cache.put(page, now);
  deps.audit?.({ kind: "network", tool, url, outcome: "ok", fromCache: false });
  return page;
}

/** Numbered `N→text` rendering (1-based line numbers), the whole page when no range is given.
 *  Out-of-bounds/inverted `lineStart`/`lineEnd` clamp to `[1, lines.length]` and the header says so
 *  — reporting both the requested and the actually-rendered range — rather than silently returning
 *  an empty result or throwing on a caller's stale/miscounted range. */
export function renderLines(page: CleanPage, lineStart?: number, lineEnd?: number): string {
  const total = page.lines.length;
  if (total === 0) return `${page.title} (0 lines)`;

  const reqStart = lineStart ?? 1;
  const reqEnd = lineEnd ?? total;
  const start = Math.min(Math.max(Math.trunc(reqStart), 1), total);
  const end = Math.min(Math.max(Math.trunc(reqEnd), start), total);
  const clamped = start !== reqStart || end !== reqEnd;

  const body: string[] = [];
  for (let i = start; i <= end; i++) body.push(`${i}→${page.lines[i - 1]}`);

  const header = clamped
    ? `${page.title} (lines ${start}-${end} of ${total} — requested ${reqStart}-${reqEnd}, clamped)`
    : `${page.title} (lines ${start}-${end} of ${total})`;

  return [header, ...body].join("\n");
}
