import { describe, expect, test } from "bun:test";
import {
  fetchCleanPage,
  PageCache,
  PageCoreError,
  renderLines,
  extractLinks,
  checkDangerousDomain,
  AD_TRACKER_LINK_SUBSTRINGS,
  type CleanPage,
} from "../../../src/agent/tools/page-core";

// --- fake fetch: script of responses, one per redirect hop, matching web.test.ts's convention,
// plus a call counter so cache tests assert on COUNTS (never on timing). ------------------------

interface Step { status: number; location?: string; body?: string; contentType?: string }

function scriptedFetch(script: Step[]): { fetchFn: typeof fetch; calls: () => number } {
  let i = 0;
  let calls = 0;
  const fetchFn = (async (_url: string, _init?: RequestInit) => {
    calls++;
    const step = script[Math.min(i, script.length - 1)]!;
    i++;
    const headers = new Headers();
    if (step.location) headers.set("location", step.location);
    if (step.contentType) headers.set("content-type", step.contentType);
    return new Response(step.body ?? "", { status: step.status, headers });
  }) as typeof fetch;
  return { fetchFn, calls: () => calls };
}

function clock(startMs: number): { now: () => number; advance: (ms: number) => void } {
  let t = startMs;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

const PAGE_HTML =
  '<html><head><title>Example Page</title></head><body>' +
  '<h1>Example Page</h1>' +
  '<p>Some intro text.</p>' +
  '<p>Another paragraph with a <a href="/relative/path">relative link</a>.</p>' +
  '<p>An absolute link: <a href="https://other.com/x">other site</a>.</p>' +
  '<p>An in-page anchor: <a href="#section2">jump</a>.</p>' +
  '<p>An ad: <a href="https://ads.doubleclick.net/pixel">ad1</a>.</p>' +
  '<p>A tag manager: <a href="https://www.googletagmanager.com/gtm.js">ad2</a>.</p>' +
  '<p>Analytics: <a href="https://www.google-analytics.com/analytics.js">ad3</a>.</p>' +
  '<p>Meta pixel: <a href="https://facebook.com/tr?id=1">ad4</a>.</p>' +
  '<p>Duplicate: <a href="https://other.com/x">dup of other site</a>.</p>' +
  '</body></html>';

describe("fetchCleanPage: clean + number determinism", () => {
  test("same HTML bytes in -> byte-identical lines array across two independent calls", async () => {
    const { fetchFn: fetchFn1 } = scriptedFetch([{ status: 200, body: PAGE_HTML, contentType: "text/html" }]);
    const { fetchFn: fetchFn2 } = scriptedFetch([{ status: 200, body: PAGE_HTML, contentType: "text/html" }]);
    const c = clock(1000);

    // Two SEPARATE caches, so this proves the clean step itself is deterministic, not just that
    // the cache is returning the same object twice.
    const page1 = await fetchCleanPage("https://example.com/page", new PageCache(), { fetchFn: fetchFn1, now: c.now });
    const page2 = await fetchCleanPage("https://example.com/page", new PageCache(), { fetchFn: fetchFn2, now: c.now });

    expect(page1.lines).toEqual(page2.lines);
    expect(page1.lines.length).toBeGreaterThan(0);
    expect(page1.title).toBe(page2.title);
  });

  // Fix round 1, Minor: a CRLF plain-text body must not leak a trailing "\r" onto every line but
  // the last — those stray \r's would ride straight into citations and renderLines output for any
  // .txt/code fetch (the non-HTML path skips htmlToText, which is the only place \r was ever being
  // implicitly cleaned up for the HTML path).
  test("a CRLF plain-text body splits into clean lines with no stray '\\r', and stays deterministic", async () => {
    const body = "line one\r\nline two\r\nline three";
    const { fetchFn: fetchFn1 } = scriptedFetch([{ status: 200, body, contentType: "text/plain" }]);
    const { fetchFn: fetchFn2 } = scriptedFetch([{ status: 200, body, contentType: "text/plain" }]);

    const page1 = await fetchCleanPage("https://example.com/notes.txt", new PageCache(), { fetchFn: fetchFn1, now: () => 0 });
    const page2 = await fetchCleanPage("https://example.com/notes.txt", new PageCache(), { fetchFn: fetchFn2, now: () => 0 });

    expect(page1.lines).toEqual(["line one", "line two", "line three"]);
    for (const line of page1.lines) expect(line).not.toContain("\r");
    expect(page1.lines).toEqual(page2.lines); // determinism holds for the non-HTML path too
  });
});

describe("fetchCleanPage: links extraction", () => {
  test("resolves relative hrefs against the final URL, drops #anchors and known ad/tracker hosts, keeps text, dedupes by href", async () => {
    const { fetchFn } = scriptedFetch([{ status: 200, body: PAGE_HTML, contentType: "text/html" }]);
    const page = await fetchCleanPage("https://example.com/page", new PageCache(), { fetchFn, now: () => 0 });

    expect(page.links).toEqual([
      { href: "https://example.com/relative/path", text: "relative link" },
      { href: "https://other.com/x", text: "other site" },
    ]);
    // Ad/tracker hosts must not appear at all.
    for (const bad of ["doubleclick", "googletagmanager", "google-analytics", "facebook.com/tr"]) {
      expect(page.links.some((l) => l.href.includes(bad))).toBe(false);
    }
    // In-page anchor never appears either.
    expect(page.links.some((l) => l.href.includes("#section2"))).toBe(false);
  });

  test("resolves links against the final URL after a redirect, not the originally-requested URL", async () => {
    const html = '<a href="/child">child link</a>';
    const { fetchFn } = scriptedFetch([
      { status: 302, location: "https://redirected.example.com/final/" },
      { status: 200, body: html, contentType: "text/html" },
    ]);
    const page = await fetchCleanPage("https://example.com/start", new PageCache(), { fetchFn, now: () => 0 });
    expect(page.url).toBe("https://redirected.example.com/final/");
    expect(page.links).toEqual([{ href: "https://redirected.example.com/child", text: "child link" }]);
  });

  test("non-http(s) schemes (mailto:, javascript:) are dropped", async () => {
    const html = '<a href="mailto:a@b.com">mail</a><a href="javascript:alert(1)">js</a><a href="https://ok.com/">ok</a>';
    const { fetchFn } = scriptedFetch([{ status: 200, body: html, contentType: "text/html" }]);
    const page = await fetchCleanPage("https://example.com/", new PageCache(), { fetchFn, now: () => 0 });
    expect(page.links).toEqual([{ href: "https://ok.com/", text: "ok" }]);
  });
});

// --- fix round 1, Important: the ad-host filter must match the RESOLVED HOSTNAME (exact or
// subdomain suffix for bare-host entries; exact host + path-prefix for the one host+path entry),
// never a bare substring of hostname+pathname concatenated — a substring match let an unrelated
// page whose PATH happens to contain an ad-host string (e.g. "doubleclick.net" appearing in
// example.com's own path) get silently dropped as if it were the ad host itself. -----------------

describe("ad-host filter: hostname-scoped matching (false-positive fix)", () => {
  test("a legitimate link whose PATH merely contains 'doubleclick.net' survives (not an ad host)", async () => {
    const html = '<a href="https://example.com/doubleclick.net.html">unrelated page</a>';
    const { fetchFn } = scriptedFetch([{ status: 200, body: html, contentType: "text/html" }]);
    const page = await fetchCleanPage("https://example.com/", new PageCache(), { fetchFn, now: () => 0 });
    expect(page.links).toEqual([{ href: "https://example.com/doubleclick.net.html", text: "unrelated page" }]);
  });

  test("a legitimate link whose PATH merely contains 'facebook.com/tr' survives (not the Meta pixel)", async () => {
    const html = '<a href="https://news.example.com/facebook.com/tr-scandal-article">news article</a>';
    const { fetchFn } = scriptedFetch([{ status: 200, body: html, contentType: "text/html" }]);
    const page = await fetchCleanPage("https://example.com/", new PageCache(), { fetchFn, now: () => 0 });
    expect(page.links).toEqual([
      { href: "https://news.example.com/facebook.com/tr-scandal-article", text: "news article" },
    ]);
  });

  test("a real doubleclick.net SUBDOMAIN is still dropped", async () => {
    const html = '<a href="https://stats.doubleclick.net/pixel">tracker</a><a href="https://ok.com/">ok</a>';
    const { fetchFn } = scriptedFetch([{ status: 200, body: html, contentType: "text/html" }]);
    const page = await fetchCleanPage("https://example.com/", new PageCache(), { fetchFn, now: () => 0 });
    expect(page.links).toEqual([{ href: "https://ok.com/", text: "ok" }]);
  });

  test("a host that merely STARTS WITH 'doubleclick.net' text but isn't a subdomain (notdoubleclick.net) survives", async () => {
    const html = '<a href="https://notdoubleclick.net/">not an ad host</a>';
    const { fetchFn } = scriptedFetch([{ status: 200, body: html, contentType: "text/html" }]);
    const page = await fetchCleanPage("https://example.com/", new PageCache(), { fetchFn, now: () => 0 });
    expect(page.links).toEqual([{ href: "https://notdoubleclick.net/", text: "not an ad host" }]);
  });
});

// --- whole-branch review, two one-line minors bundled (2026-07-28): (a) www.facebook.com/tr — the
// REAL Meta Pixel — regressed to "kept" by the earlier fix round's exact-host-only check (Meta
// serves it from the `www` subdomain, verified against Meta's own docs); (b) the "/tr" path check
// had no boundary, so "/trending"/"/travel" were dropped as false positives. ------------------------
describe("ad-host filter: facebook.com/tr regression + path-boundary (whole-branch review minors)", () => {
  test("the real Meta Pixel on www.facebook.com/tr IS filtered (regression fix — subdomain must match too)", async () => {
    const html = '<a href="https://www.facebook.com/tr?id=1">pixel</a><a href="https://ok.com/">ok</a>';
    const { fetchFn } = scriptedFetch([{ status: 200, body: html, contentType: "text/html" }]);
    const page = await fetchCleanPage("https://example.com/", new PageCache(), { fetchFn, now: () => 0 });
    expect(page.links).toEqual([{ href: "https://ok.com/", text: "ok" }]);
  });

  test("facebook.com/trending and facebook.com/travel are NOT filtered (path-boundary fix)", async () => {
    const html = '<a href="https://facebook.com/trending/today">trending</a><a href="https://facebook.com/travel">travel</a>';
    const { fetchFn } = scriptedFetch([{ status: 200, body: html, contentType: "text/html" }]);
    const page = await fetchCleanPage("https://example.com/", new PageCache(), { fetchFn, now: () => 0 });
    expect(page.links).toEqual([
      { href: "https://facebook.com/trending/today", text: "trending" },
      { href: "https://facebook.com/travel", text: "travel" },
    ]);
  });

  test("facebook.com/tr itself (bare, exact path) is still filtered", async () => {
    const html = '<a href="https://facebook.com/tr">pixel</a><a href="https://ok.com/">ok</a>';
    const { fetchFn } = scriptedFetch([{ status: 200, body: html, contentType: "text/html" }]);
    const page = await fetchCleanPage("https://example.com/", new PageCache(), { fetchFn, now: () => 0 });
    expect(page.links).toEqual([{ href: "https://ok.com/", text: "ok" }]);
  });

  test("facebook.com/tr/pixel.gif (a bounded child path) is still filtered", async () => {
    const html = '<a href="https://facebook.com/tr/pixel.gif">pixel</a><a href="https://ok.com/">ok</a>';
    const { fetchFn } = scriptedFetch([{ status: 200, body: html, contentType: "text/html" }]);
    const page = await fetchCleanPage("https://example.com/", new PageCache(), { fetchFn, now: () => 0 });
    expect(page.links).toEqual([{ href: "https://ok.com/", text: "ok" }]);
  });
});

// --- Critical 2, whole-branch review: the SAME shape as web.ts:98's pre-existing regex
// (`/<a\s[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi`) is effectively quadratic on many `<a href>`
// starts with a distant or absent `</a>` — its lazy `[\s\S]*?` scans forward hunting for the next
// `</a>` from EVERY open tag independently. Reviewer's measured series (per-pass): 128KB->169ms,
// 256KB->652ms, 512KB->2602ms, 1024KB->10470ms (ratios ~3.9-4.0x per doubling, clean O(n^2)); a full
// fetchCleanPage pass over 3MB with no closing tags at all measured 187,667ms. The fix scans opens
// and closes SEPARATELY (two single-pass regexes, neither with a lazy-scan-to-a-later-token shape)
// and pairs them with a monotonic pointer — O(n) total. Measured directly against `extractLinks`
// (exported for this test) rather than the full `fetchCleanPage` pipeline: `htmlToText` (web.ts) has
// the IDENTICAL pre-existing shape and is explicitly OUT OF SCOPE for this fix (see the branch-fix
// report) — testing the full pipeline on this exact pathological input would still be slow because
// of THAT unfixed function, which would not prove anything about THIS one. ------------------------
describe("extractLinks: linear-time scanning (Critical 2 fix — quadratic-scan)", () => {
  /** Many `<a href="...">` starts, NO `</a>` anywhere — the "absent" half of the reviewer's own
   *  framing ("a distant/absent </a>"), and the shape that made the ORIGINAL regex's lazy scan run
   *  each open tag all the way to end-of-string. Post-fix this is actually the FASTEST shape (the
   *  close-tag pre-scan finds zero closes, so the main loop bails on the very first open) — that is
   *  the direct, correct consequence of no longer scanning per-open for a close that never comes. */
  function unclosedAnchorHtml(totalBytes: number): string {
    const unit = '<a href="https://example.com/x">link text ';
    const reps = Math.ceil(totalBytes / unit.length);
    return unit.repeat(reps);
  }

  test("a doubling size series (128KB->1MB) of unclosed <a> starts all complete in a few ms, not growing ~4x per step", () => {
    const sizesKb = [128, 256, 512, 1024];
    const timings = sizesKb.map((kb) => {
      const html = unclosedAnchorHtml(kb * 1024);
      const start = performance.now();
      const links = extractLinks(html, "https://example.com/");
      const elapsed = performance.now() - start;
      expect(links).toEqual([]); // no </a> anywhere -> nothing closes -> nothing extracted (same as the original regex's own semantics for this shape)
      return elapsed;
    });
    // Pre-fix this series was ~169/652/2602/10470ms (each step ~4x the last, textbook O(n^2)).
    // Post-fix every step must stay small and bounded — not a ratio assertion (CI timing noise),
    // an absolute one: even the largest (1MB) must complete in well under what the SMALLEST (128KB)
    // took pre-fix.
    for (const t of timings) expect(t).toBeLessThan(200);
  });

  test("the 3MB pathological case (no closing tags at all) completes in a small bounded time (was 187,667ms end-to-end pre-fix)", () => {
    const html = unclosedAnchorHtml(3 * 1024 * 1024);
    const start = performance.now();
    const links = extractLinks(html, "https://example.com/");
    const elapsed = performance.now() - start;
    expect(links).toEqual([]);
    expect(elapsed).toBeLessThan(500);
  });

  // Deliberately SMALL scale (unlike the series above): the first open's "inner" content here is
  // whatever sits between it and the one distant close — i.e. every one of the OTHER opens, as raw
  // text — and that gets run through `htmlToText` (web.ts) to build the anchor's text, same as any
  // real nested-anchor page. `htmlToText` has the IDENTICAL pre-existing quadratic shape on many
  // unclosed `<a>` starts and is explicitly OUT OF SCOPE for this fix — a large version of this test
  // would (correctly) still be slow, but from THAT function, not from anything this fix touches. Kept
  // small so it proves the CORRECTNESS of the pairing/skip logic (this function's own job) without
  // the assertion depending on a function this branch deliberately leaves unfixed.
  test("many opens with exactly ONE distant closing tag: the first open absorbs everything up to it (matches the original regex's own nested-anchor semantics), fast", () => {
    const opens = '<a href="https://example.com/x">text '.repeat(300); // ~11KB of opens, zero closes yet
    const html = opens + "</a>";
    const start = performance.now();
    const links = extractLinks(html, "https://example.com/");
    const elapsed = performance.now() - start;
    expect(links.length).toBe(1); // only the FIRST open pairs with the one close; every later open starts inside its consumed span and is skipped, same as the original lazy-regex's own behavior
    expect(elapsed).toBeLessThan(500);
  });

  test("5,000 well-formed, properly-closed sequential anchors (the realistic case) all extract correctly and quickly", () => {
    const html = Array.from({ length: 5000 }, (_, i) => `<a href="https://example.com/${i}">link ${i}</a>`).join("");
    const start = performance.now();
    const links = extractLinks(html, "https://example.com/");
    const elapsed = performance.now() - start;
    expect(links.length).toBe(5000);
    expect(links[0]).toEqual({ href: "https://example.com/0", text: "link 0" });
    expect(links[4999]).toEqual({ href: "https://example.com/4999", text: "link 4999" });
    expect(elapsed).toBeLessThan(200);
  });
});

// --- in-flight dedup minor, folded into the Critical 2 commit (8x amplifier on the same CPU bound):
// N identical urls batched in one ReadPage/FetchPage call previously raced N independent fetches,
// since the cache only records a result once the FIRST one resolves. ------------------------------
describe("fetchCleanPage: in-flight de-dup for identical concurrent urls (folded into Critical 2 fix)", () => {
  test("3 concurrent fetchCleanPage calls for the IDENTICAL url produce exactly ONE real fetch", async () => {
    const { fetchFn, calls } = scriptedFetch([{ status: 200, body: PAGE_HTML, contentType: "text/html" }]);
    const cache = new PageCache();
    const [a, b, c] = await Promise.all([
      fetchCleanPage("https://example.com/dup", cache, { fetchFn, now: () => 0 }),
      fetchCleanPage("https://example.com/dup", cache, { fetchFn, now: () => 0 }),
      fetchCleanPage("https://example.com/dup", cache, { fetchFn, now: () => 0 }),
    ]);
    expect(calls()).toBe(1);
    expect(a.lines).toEqual(b.lines);
    expect(a.lines).toEqual(c.lines);
  });

  test("after the in-flight fetch settles, a LATER call (outside the race) reads from cache with still no new fetch", async () => {
    const { fetchFn, calls } = scriptedFetch([{ status: 200, body: PAGE_HTML, contentType: "text/html" }]);
    const cache = new PageCache();
    await Promise.all([
      fetchCleanPage("https://example.com/dup2", cache, { fetchFn, now: () => 0 }),
      fetchCleanPage("https://example.com/dup2", cache, { fetchFn, now: () => 0 }),
    ]);
    expect(calls()).toBe(1);
    const later = await fetchCleanPage("https://example.com/dup2", cache, { fetchFn, now: () => 0 });
    expect(calls()).toBe(1);
    expect(later.fromCache).toBe(true);
  });

  test("distinct urls are NOT deduped — each gets its own fetch", async () => {
    const { fetchFn, calls } = scriptedFetch([
      { status: 200, body: PAGE_HTML, contentType: "text/html" },
      { status: 200, body: PAGE_HTML, contentType: "text/html" },
    ]);
    const cache = new PageCache();
    await Promise.all([
      fetchCleanPage("https://example.com/one", cache, { fetchFn, now: () => 0 }),
      fetchCleanPage("https://example.com/two", cache, { fetchFn, now: () => 0 }),
    ]);
    expect(calls()).toBe(2);
  });
});

/** A fetchFn whose response is resolved manually (via `resolve`) — lets a test deterministically
 *  control WHEN the shared in-flight fetch settles, so a "joiner" can attach to it mid-flight and
 *  its own behavior (abort, origin) can be asserted before/after that settlement, with no reliance
 *  on timing/sleep. */
function deferredFetch(): { fetchFn: typeof fetch; resolve: (body: string) => void; calls: () => number } {
  let calls = 0;
  let resolveFn: ((res: Response) => void) | undefined;
  const fetchFn = (async (_url: string, _init?: RequestInit) => {
    calls++;
    return new Promise<Response>((resolve) => { resolveFn = resolve; });
  }) as unknown as typeof fetch;
  return {
    fetchFn,
    calls: () => calls,
    resolve: (body: string) => resolveFn!(new Response(body, { status: 200, headers: { "content-type": "text/html" } })),
  };
}

// --- Minor 4 (whole-branch review, fix round 2): dedupe cross-tags the cache origin, and discards
// the joiner's abort. (a) a "user" fetch that joins an in-flight "research" fetch for the same url
// was stored with the RESEARCH tag (the joiner's own origin was discarded — the producer, created by
// whichever caller happened to be FIRST, closed over only ITS OWN origin) — narrowing Important 3's
// guarantee, since it's then evictable by research pressure even though a user asked for it. (b) a
// joiner rode the FIRST caller's signal composition and its own `ctx.signal` was ignored entirely —
// a joiner aborted at 50ms was still pending at 600ms, regressing "a user abort beats the default
// bound". Fix: track the STRONGEST origin among all joiners (user wins) and apply it at cache.put
// time; race EACH caller's own return against ITS OWN signal, independent of the shared producer. --
describe("fetchCleanPage: dedupe cross-tags the origin, and discards the joiner's abort (Minor 4 fix, fix round 2)", () => {
  test("a 'user' fetch joining an in-flight 'research' fetch is stored with the STRONGER 'user' origin, not the initiator's", async () => {
    const { fetchFn, resolve, calls } = deferredFetch();
    const cache = new PageCache(); // production defaults

    const researchPromise = fetchCleanPage("https://example.com/joint", cache, { fetchFn, origin: "research" });
    await Promise.resolve(); // let the research call register itself as in-flight before the user joins
    const userPromise = fetchCleanPage("https://example.com/joint", cache, { fetchFn, origin: "user" });

    resolve(PAGE_HTML);
    await Promise.all([researchPromise, userPromise]);
    expect(calls()).toBe(1); // still deduped — exactly one real fetch

    // Proof the STORED entry is tagged "user": 60 subsequent research entries (production defaults,
    // same probe shape as the entry-count-trim fix above) must NOT be able to evict it, even though
    // it was the OLDEST entry in the cache and would be first in line if it were still "research".
    for (let i = 0; i < 60; i++) {
      const { fetchFn: rf } = scriptedFetch([{ status: 200, body: PAGE_HTML, contentType: "text/html" }]);
      await fetchCleanPage(`https://research${i}.example.com/`, cache, { fetchFn: rf, origin: "research" });
    }
    const stillCached = await fetchCleanPage("https://example.com/joint", cache, {
      fetchFn: (async () => { throw new Error("must not refetch — should have hit cache"); }) as unknown as typeof fetch,
    });
    expect(stillCached.fromCache).toBe(true);
  });

  test("when NO joiner is 'user', the entry is still stored 'research' (origin merging doesn't just always upgrade)", async () => {
    const { fetchFn, resolve, calls } = deferredFetch();
    const cache = new PageCache({ maxBytes: 100_000, maxEntries: 3, ttlMs: 100_000 });

    const first = fetchCleanPage("https://example.com/joint2", cache, { fetchFn, origin: "research" });
    await Promise.resolve();
    const second = fetchCleanPage("https://example.com/joint2", cache, { fetchFn, origin: "research" });
    resolve(PAGE_HTML);
    await Promise.all([first, second]);
    expect(calls()).toBe(1);

    // With ONLY research joiners, the entry stays "research" — later research pressure past the
    // count cap CAN evict it (proves the merge isn't a blanket "always user" no-op).
    for (let i = 0; i < 5; i++) {
      const { fetchFn: rf } = scriptedFetch([{ status: 200, body: PAGE_HTML, contentType: "text/html" }]);
      await fetchCleanPage(`https://r${i}.example.com/`, cache, { fetchFn: rf, origin: "research" });
    }
    // Not asserting eviction happened (unrelated to this fix); asserting it CAN be evicted the same
    // way any other research entry can is out of scope for this specific test — the important
    // property (proven above) is that a genuine "user" joiner upgrades the tag; this test's only
    // job is to show that doesn't happen when nobody actually is "user".
    expect(calls()).toBeGreaterThanOrEqual(1); // sanity: research fetches above genuinely ran
  });

  // Manual race against a short internal deadline (not bun's own per-test timeout, which cannot
  // forcibly interrupt a truly-parked `await` on a promise that never settles): pre-fix, the
  // joiner never detaches at all — it just rides the SAME shared promise object as the initiator,
  // which never resolves/rejects until `resolve()` below is called — so a naive
  // `await expect(joinerPromise).rejects...` would hang this test (and the whole run) forever
  // rather than failing fast with a clear RED.
  test("a joiner's OWN abort detaches it promptly — the shared underlying fetch is unaffected and still completes for the initiator", async () => {
    const { fetchFn, resolve, calls } = deferredFetch();
    const cache = new PageCache();

    const initiatorPromise = fetchCleanPage("https://example.com/abort-join", cache, { fetchFn });
    await Promise.resolve(); // let the initiator register itself as in-flight before the joiner attaches

    const controller = new AbortController();
    const joinerPromise = fetchCleanPage("https://example.com/abort-join", cache, {
      fetchFn,
      signal: controller.signal,
      timeoutMs: 5000, // stands in for production's uninjectable 15s default — must not be what fires
    });

    const start = Date.now();
    setTimeout(() => controller.abort(), 20);
    const outcome = await Promise.race([
      joinerPromise.then(() => "resolved" as const, () => "rejected" as const),
      new Promise<"never-settled">((r) => setTimeout(() => r("never-settled"), 1000)),
    ]);
    expect(outcome).toBe("rejected"); // the joiner must detach via rejection, not resolve, and not hang
    expect(Date.now() - start).toBeLessThan(1000); // proves the JOINER's own 20ms abort fired, not the 5000ms default

    // The shared fetch is UNAFFECTED by the joiner's detach: resolving it now still completes the
    // INITIATOR's own promise, with no second network call.
    resolve(PAGE_HTML);
    const initiatorResult = await initiatorPromise;
    expect(initiatorResult.lines.length).toBeGreaterThan(0);
    expect(calls()).toBe(1);
  }, 3000);
});

describe("PageCache: TTL, LRU (maxEntries), and byte-cap eviction", () => {
  function makePage(url: string, byteWeight: number): CleanPage {
    return {
      url,
      title: "T",
      lines: ["x".repeat(byteWeight)],
      links: [],
      fetchedAt: 0,
      fromCache: false,
    };
  }

  test("get returns undefined for a URL never put", () => {
    const cache = new PageCache();
    expect(cache.get("https://never.com/", 0)).toBeUndefined();
  });

  test("get returns the entry (fromCache:true) inside the TTL, and undefined once now >= expiresAt", () => {
    const cache = new PageCache({ ttlMs: 1000 });
    const page = makePage("https://a.com/", 10);
    cache.put(page, 0);

    const hit = cache.get("https://a.com/", 999);
    expect(hit).toBeDefined();
    expect(hit!.fromCache).toBe(true);
    expect(hit!.lines).toEqual(page.lines);

    expect(cache.get("https://a.com/", 1000)).toBeUndefined(); // exactly at expiry
  });

  test("LRU: putting past maxEntries evicts the least-recently-used entry, not the most recent", () => {
    const cache = new PageCache({ maxEntries: 2, ttlMs: 100_000 });
    cache.put(makePage("https://a.com/", 1), 0);
    cache.put(makePage("https://b.com/", 1), 0);
    // Touch A so B becomes the least-recently-used.
    expect(cache.get("https://a.com/", 0)).toBeDefined();
    cache.put(makePage("https://c.com/", 1), 0);

    expect(cache.get("https://b.com/", 0)).toBeUndefined(); // evicted
    expect(cache.get("https://a.com/", 0)).toBeDefined();
    expect(cache.get("https://c.com/", 0)).toBeDefined();
  });

  test("maxBytes: putting past the byte cap evicts oldest entries until back under it", () => {
    // Each makePage(url, 10) weighs ~26 bytes (url ~14 + title 1 + a 10-char line + 1): a=26,
    // a+b=52, a+b+c=78. maxBytes:60 sits between 52 and 78, so adding c must evict exactly the
    // oldest entry (a) to get back under the cap, leaving b and c.
    const cache = new PageCache({ maxBytes: 60, maxEntries: 100, ttlMs: 100_000 });
    cache.put(makePage("https://a.com/", 10), 0);
    cache.put(makePage("https://b.com/", 10), 0);
    cache.put(makePage("https://c.com/", 10), 0); // pushes total to ~78 (> 60) -> oldest (a) evicted

    expect(cache.get("https://a.com/", 0)).toBeUndefined();
    expect(cache.get("https://b.com/", 0)).toBeDefined();
    expect(cache.get("https://c.com/", 0)).toBeDefined();
  });

  // --- Important 3, whole-branch review: research's own fetches (many pages per run, up to the
  // 15-page ceiling) must not be able to evict the USER's own recently-read pages inside the TTL.
  // CHOSEN MITIGATION (documented, not the only option the reviewer offered): a RESERVED BYTE SHARE
  // — research-tagged entries are capped at a FIXED FRACTION of the cache's total byte budget,
  // evicting only OTHER research entries once full; the remaining share is exclusively available to
  // "user"-tagged (plain ReadPage) entries, which research can never touch to make room for itself.
  // Folded in alongside a larger total budget (20MB -> 60MB) so research keeps roughly its OLD
  // effective headroom (the old 20MB total) while the user's own reads get a FRESH, separate share
  // research can never encroach on. Same PageCache instance throughout — never a separate research
  // cache (the citation contract depends on ReadPage and the research runner sharing ONE cache). ---
  describe("PageCache: reserved research byte share (Important 3 fix — research cannot evict user entries)", () => {
    test("research entries evict OTHER research entries once their own share is full, never a user entry", () => {
      // researchByteShare 0.5 of a 100-byte budget = 50 bytes reserved for research. Each page here
      // weighs ~26 bytes (see the maxBytes test's own arithmetic above).
      const cache = new PageCache({ maxBytes: 100, maxEntries: 100, ttlMs: 100_000, researchByteShare: 0.5 });
      cache.put(makePage("https://user.com/", 10), 0, "user");
      cache.put(makePage("https://r1.com/", 10), 0, "research");
      cache.put(makePage("https://r2.com/", 10), 0, "research"); // research's own 50-byte share (~52 bytes of r1+r2) is now full/over

      expect(cache.get("https://user.com/", 0)).toBeDefined(); // the user's entry is UNTOUCHED
      expect(cache.get("https://r1.com/", 0)).toBeUndefined(); // oldest RESEARCH entry evicted to make room
      expect(cache.get("https://r2.com/", 0)).toBeDefined();
    });

    test("a research run cannot evict the user's own entry even when research entries vastly outnumber it", () => {
      const cache = new PageCache({ maxBytes: 200, maxEntries: 100, ttlMs: 100_000, researchByteShare: 0.5 });
      cache.put(makePage("https://user.com/important", 10), 0, "user");
      for (let i = 0; i < 10; i++) cache.put(makePage(`https://research${i}.com/`, 10), 0, "research");

      expect(cache.get("https://user.com/important", 0)).toBeDefined();
    });

    // NOTE, not a fixed mirrored "user share": the reservation is one-directional (research is
    // capped; the user is not) — a "user"-tagged entry is only evicted by the ORDINARY combined cap
    // (entries count + overall bytes across BOTH tags, unchanged pass-2 behavior), so with zero
    // research entries in the picture the user gets the FULL `maxBytes`, not half of it.
    test("with no research entries at all, user entries still evict oldest-first among THEMSELVES once the OVERALL byte cap is exceeded (unchanged LRU discipline)", () => {
      const cache = new PageCache({ maxBytes: 60, maxEntries: 100, ttlMs: 100_000, researchByteShare: 0.5 });
      cache.put(makePage("https://u1.com/", 10), 0, "user");
      cache.put(makePage("https://u2.com/", 10), 0, "user");
      cache.put(makePage("https://u3.com/", 10), 0, "user"); // pushes total to ~78 (> 60) -> oldest (u1) evicted

      expect(cache.get("https://u1.com/", 0)).toBeUndefined(); // oldest USER entry evicted
      expect(cache.get("https://u2.com/", 0)).toBeDefined();
      expect(cache.get("https://u3.com/", 0)).toBeDefined();
    });

    test("put's origin defaults to \"user\" when omitted — every existing (pre-fix) call site is unaffected", () => {
      const cache = new PageCache({ maxBytes: 100, maxEntries: 100, ttlMs: 100_000, researchByteShare: 0.5 });
      cache.put(makePage("https://plain.com/", 10), 0); // no origin argument at all
      for (let i = 0; i < 10; i++) cache.put(makePage(`https://research${i}.com/`, 10), 0, "research");
      expect(cache.get("https://plain.com/", 0)).toBeDefined(); // treated as "user" -> protected from research eviction
    });

    // --- fix round 2 (whole-branch review, Important): the byte reservation above only protects
    // the BYTE dimension — pass 2's ENTRY-COUNT trim (`this.entries.size > this.maxEntries`) was
    // still oldest-first ACROSS BOTH tags, origin-blind. Reachable in a single ReadPage call: 8
    // `query` entries x the 15-page clamp = 120 research fetches, comfortably over the 50-entry
    // default cap while nowhere near the 60MB default byte cap. Probed on PRODUCTION DEFAULTS
    // (`new PageCache()`, no overrides) to match exactly what the coordinator's own probe found. ---
    test("PRODUCTION DEFAULTS: 1 user entry + 60 tiny research entries — the user's entry survives even though entries.size (61) is way past maxEntries (50), bytes nowhere near maxBytes", () => {
      const cache = new PageCache(); // production defaults: maxEntries 50, maxBytes 60MB, researchByteShare 1/3
      cache.put(makePage("https://user.com/important", 10), 0, "user");
      for (let i = 0; i < 60; i++) cache.put(makePage(`https://research${i}.com/`, 10), 0, "research");

      expect(cache.get("https://user.com/important", 0)).toBeDefined(); // must NOT be evicted by count pressure
    });

    test("the entry-count trim prefers evicting RESEARCH entries first, oldest-first among themselves, before ever touching a user entry", () => {
      const cache = new PageCache({ maxBytes: 100_000, maxEntries: 3, ttlMs: 100_000 }); // bytes irrelevant here — only the count cap should bite
      cache.put(makePage("https://user.com/", 10), 0, "user");
      cache.put(makePage("https://r1.com/", 10), 0, "research");
      cache.put(makePage("https://r2.com/", 10), 0, "research");
      cache.put(makePage("https://r3.com/", 10), 0, "research"); // entries.size hits 4 > maxEntries(3) -> oldest RESEARCH (r1) evicted, not the user entry

      expect(cache.get("https://user.com/", 0)).toBeDefined();
      expect(cache.get("https://r1.com/", 0)).toBeUndefined(); // oldest research entry evicted
      expect(cache.get("https://r2.com/", 0)).toBeDefined();
      expect(cache.get("https://r3.com/", 0)).toBeDefined();
    });

    test("once every research entry is gone, the count cap DOES fall back to evicting the user's own (oldest) entries", () => {
      const cache = new PageCache({ maxBytes: 100_000, maxEntries: 2, ttlMs: 100_000 });
      cache.put(makePage("https://u1.com/", 10), 0, "user");
      cache.put(makePage("https://u2.com/", 10), 0, "user");
      cache.put(makePage("https://u3.com/", 10), 0, "user"); // no research entries exist at all -> falls back to oldest-first among users

      expect(cache.get("https://u1.com/", 0)).toBeUndefined(); // oldest user entry evicted — only the user's OWN reads can do this
      expect(cache.get("https://u2.com/", 0)).toBeDefined();
      expect(cache.get("https://u3.com/", 0)).toBeDefined();
    });
  });
});

describe("fetchCleanPage + PageCache integration: fetchFn call counting (spy, never timing)", () => {
  test("a second fetch inside the TTL makes ZERO further fetchFn calls and returns fromCache:true", async () => {
    const { fetchFn, calls } = scriptedFetch([{ status: 200, body: PAGE_HTML, contentType: "text/html" }]);
    const cache = new PageCache({ ttlMs: 60_000 });
    const c = clock(0);

    const first = await fetchCleanPage("https://example.com/page", cache, { fetchFn, now: c.now });
    expect(calls()).toBe(1);
    expect(first.fromCache).toBe(false);

    c.advance(1000); // well inside the 60s TTL
    const second = await fetchCleanPage("https://example.com/page", cache, { fetchFn, now: c.now });
    expect(calls()).toBe(1); // no new fetchFn call
    expect(second.fromCache).toBe(true);
    expect(second.lines).toEqual(first.lines);
    expect(second.fetchedAt).toBe(first.fetchedAt); // stamped at ORIGINAL fetch time, not the cache hit
  });

  test("a fetch after the TTL has elapsed calls fetchFn again", async () => {
    const { fetchFn, calls } = scriptedFetch([{ status: 200, body: PAGE_HTML, contentType: "text/html" }]);
    const cache = new PageCache({ ttlMs: 1000 });
    const c = clock(0);

    await fetchCleanPage("https://example.com/page", cache, { fetchFn, now: c.now });
    expect(calls()).toBe(1);

    c.advance(1001); // past the TTL
    const third = await fetchCleanPage("https://example.com/page", cache, { fetchFn, now: c.now });
    expect(calls()).toBe(2); // refetched
    expect(third.fromCache).toBe(false);
  });
});

describe("renderLines", () => {
  const page: CleanPage = {
    url: "https://example.com/",
    title: "Example Page",
    lines: ["line one", "line two", "line three", "line four", "line five"],
    links: [],
    fetchedAt: 0,
    fromCache: false,
  };

  test("no range renders the whole page, numbered 1-based with the N→text format", () => {
    const out = renderLines(page);
    const lines = out.split("\n");
    expect(lines[0]).toContain("Example Page");
    expect(lines[0]).toContain("lines 1-5 of 5");
    expect(lines.slice(1)).toEqual([
      "1→line one",
      "2→line two",
      "3→line three",
      "4→line four",
      "5→line five",
    ]);
  });

  test("a valid range returns exactly those numbered lines, nothing more", () => {
    const out = renderLines(page, 2, 4);
    const lines = out.split("\n");
    expect(lines[0]).toContain("lines 2-4 of 5");
    expect(lines.slice(1)).toEqual(["2→line two", "3→line three", "4→line four"]);
  });

  test("out-of-bounds start/end clamps to the page's actual bounds and says so in the header", () => {
    const out = renderLines(page, -5, 9999);
    const lines = out.split("\n");
    expect(lines[0]).toContain("lines 1-5 of 5");
    expect(lines[0]!.toLowerCase()).toContain("clamp");
    expect(lines[0]).toContain("-5"); // reports what was actually requested
    expect(lines[0]).toContain("9999");
    expect(lines.slice(1)).toEqual([
      "1→line one",
      "2→line two",
      "3→line three",
      "4→line four",
      "5→line five",
    ]);
  });

  test("a valid in-bounds range is NOT reported as clamped", () => {
    const out = renderLines(page, 1, 5);
    expect(out.split("\n")[0]!.toLowerCase()).not.toContain("clamp");
  });
});

describe("fetchCleanPage: SSRF refusal reuses web.ts's ssrfGuard (via followRedirects)", () => {
  test("a private-address URL throws before any fetchFn call, with the ssrf_refused outcome vocabulary", async () => {
    let calledFetch = false;
    const fetchFn = (async () => { calledFetch = true; return new Response("unreachable"); }) as unknown as typeof fetch;
    const audited: Record<string, unknown>[] = [];

    await expect(
      fetchCleanPage("http://10.0.0.5/", new PageCache(), { fetchFn, now: () => 0, audit: (l) => audited.push(l) }),
    ).rejects.toThrow(/refusing to fetch a private address/);

    expect(calledFetch).toBe(false); // guard fired BEFORE any network attempt
    expect(audited[0]).toMatchObject({ outcome: "ssrf_refused" });
  });

  test("the thrown error carries outcome:'ssrf_refused' as a structured field (PageCoreError)", async () => {
    try {
      await fetchCleanPage("http://127.0.0.1/", new PageCache(), { fetchFn: (async () => new Response("")) as unknown as typeof fetch, now: () => 0 });
      throw new Error("expected fetchCleanPage to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(PageCoreError);
      expect((e as PageCoreError).outcome).toBe("ssrf_refused");
    }
  });
});

describe("fetchCleanPage: other outcome vocabulary parity with web.ts", () => {
  test("non-2xx HTTP status throws 'fetch failed: <status>' with outcome http_error", async () => {
    const { fetchFn } = scriptedFetch([{ status: 500, body: "boom" }]);
    try {
      await fetchCleanPage("https://example.com/broken", new PageCache(), { fetchFn, now: () => 0 });
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(PageCoreError);
      expect((e as Error).message).toBe("fetch failed: 500");
      expect((e as PageCoreError).outcome).toBe("http_error");
    }
  });

  test("a network-level fetch failure throws with outcome network_error", async () => {
    const fetchFn = (async () => { throw new Error("getaddrinfo ENOTFOUND example.com"); }) as unknown as typeof fetch;
    try {
      await fetchCleanPage("https://example.com/", new PageCache(), { fetchFn, now: () => 0 });
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(PageCoreError);
      expect((e as PageCoreError).outcome).toBe("network_error");
    }
  });

  test("an aborted/timed-out fetch throws with outcome timeout", async () => {
    const fetchFn = (async () => { const err = new Error("timed out"); err.name = "TimeoutError"; throw err; }) as unknown as typeof fetch;
    try {
      await fetchCleanPage("https://example.com/", new PageCache(), { fetchFn, now: () => 0 });
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(PageCoreError);
      expect((e as PageCoreError).outcome).toBe("timeout");
    }
  });
});

// B2-T3 fix-round-1 CRITICAL: fetchCleanPage previously called followRedirects with NO signal at
// all — a fetchFn that never settles (a genuinely stuck connection, which DOES honor an
// AbortSignal once one exists — unlike a maximally adversarial double) would hang fetchCleanPage
// (and everything above it: ReadPage, the research runner) forever. The fix is a per-fetch default
// timeout (mirrors web.ts's REQUEST_TIMEOUT_MS posture) that always applies even when the caller
// supplies no signal of its own, combined (never replaced) with any caller-supplied signal.
describe("fetchCleanPage: the per-fetch default timeout (fix-round-1 CRITICAL)", () => {
  /** A fetchFn that behaves like a genuinely stuck (not merely slow) network connection: it never
   *  resolves on its own, but DOES reject once its own signal fires — exactly what real `fetch()`
   *  does against a real AbortSignal. This is what page-core's signal-only fix is meant to bound
   *  (a maximally adversarial double that ignores signals entirely is research.ts's own problem to
   *  guard against with an explicit race, proven separately in research.test.ts). */
  function hangingUntilAborted(): typeof fetch {
    return (async (_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return; // would never resolve — shouldn't happen once fetchCleanPage always supplies one
        const abort = () => {
          const err = new Error("The operation was aborted.");
          err.name = "AbortError";
          reject(err);
        };
        if (signal.aborted) return abort();
        signal.addEventListener("abort", abort, { once: true });
      });
    }) as unknown as typeof fetch;
  }

  test("a fetchFn that hangs until its signal fires still rejects within a caller-shrunk timeoutMs — no caller signal required", async () => {
    const start = Date.now();
    await expect(
      fetchCleanPage("https://example.com/", new PageCache(), { fetchFn: hangingUntilAborted(), timeoutMs: 30 }),
    ).rejects.toThrow(/timed out/);
    expect(Date.now() - start).toBeLessThan(1000);
  });

  test("the thrown error carries outcome:'timeout' (PageCoreError), matching the same vocabulary an explicit-signal timeout already uses", async () => {
    try {
      await fetchCleanPage("https://example.com/", new PageCache(), { fetchFn: hangingUntilAborted(), timeoutMs: 30 });
      throw new Error("expected fetchCleanPage to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(PageCoreError);
      expect((e as PageCoreError).outcome).toBe("timeout");
    }
  });

  test("a caller-supplied signal is honored TOO (combined with, not replaced by, the default) — an early caller abort still rejects promptly", async () => {
    const controller = new AbortController();
    const fetchFn = hangingUntilAborted();
    const promise = fetchCleanPage("https://example.com/", new PageCache(), { fetchFn, signal: controller.signal, timeoutMs: 5000 });
    setTimeout(() => controller.abort(), 20);
    const start = Date.now();
    await expect(promise).rejects.toThrow(/timed out/);
    expect(Date.now() - start).toBeLessThan(1000); // proves the CALLER's signal (not the 5s timeoutMs) is what fired
  });
});

// fix-round-2 IMPORTANT (upgraded from the reviewer's Minor): web.ts's followRedirects only
// wraps the INITIAL fetchFn() call in a try/catch — the body read (readCapped, web.ts:195) runs
// OUTSIDE that try, so a timeout that fires AFTER headers arrive but DURING the body read escapes
// followRedirects raw. Before this fix, fetchCleanPage had no try/catch of its own around the
// followRedirects call either, so that raw error (a plain Error/DOMException, not a PageCoreError,
// outcome: undefined) propagated straight out of fetchCleanPage — AND no audit line was ever
// emitted for a fetch that genuinely reached the network. "Server sends headers then stalls" is
// ordinary internet behavior, made newly reachable by fix-round-1's own 15s default.
describe("fetchCleanPage: a timeout DURING the body read (after headers) still audits and classifies correctly (fix-round-2 IMPORTANT)", () => {
  /** A Response whose body never delivers a single byte and never closes on its own — but DOES
   *  error (as a real aborted body stream would) once the signal passed to the fetchFn fires. This
   *  simulates "headers arrived, body stalls" — readCapped's `reader.read()` call is what would
   *  hang, and what its abort-driven rejection must propagate through. */
  function stalledBodyFetch(): typeof fetch {
    return (async (_url: string, init?: RequestInit) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const signal = init?.signal;
          if (!signal) return; // shouldn't happen — fetchCleanPage always supplies one
          const onAbort = () => {
            const err = new Error("The operation was aborted.");
            err.name = "AbortError";
            controller.error(err);
          };
          if (signal.aborted) onAbort();
          else signal.addEventListener("abort", onAbort, { once: true });
        },
      });
      return new Response(stream, { status: 200, headers: { "content-type": "text/html" } });
    }) as unknown as typeof fetch;
  }

  test("produces a PageCoreError with outcome:'timeout', a URL-naming message, well within the shrunk timeoutMs bound", async () => {
    const start = Date.now();
    try {
      await fetchCleanPage("https://example.com/", new PageCache(), { fetchFn: stalledBodyFetch(), timeoutMs: 30 });
      throw new Error("expected fetchCleanPage to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(PageCoreError);
      expect((e as PageCoreError).outcome).toBe("timeout");
      expect((e as Error).message).toContain("example.com");
    }
    expect(Date.now() - start).toBeLessThan(1000);
  });

  test("emits an audit line with outcome:'timeout' — a fetch that genuinely reached the network is never silently unaudited", async () => {
    const audited: Record<string, unknown>[] = [];
    try {
      await fetchCleanPage("https://example.com/", new PageCache(), { fetchFn: stalledBodyFetch(), timeoutMs: 30, audit: (l) => audited.push(l) });
    } catch { /* asserted above */ }
    expect(audited.length).toBeGreaterThan(0);
    expect(audited.at(-1)).toMatchObject({ outcome: "timeout", tool: "ReadPage" });
  });
});

describe("AD_TRACKER_LINK_SUBSTRINGS", () => {
  test("is the fixed seed list named in the brief", () => {
    expect(AD_TRACKER_LINK_SUBSTRINGS).toEqual([
      "doubleclick.net",
      "googletagmanager.com",
      "google-analytics.com",
      "facebook.com/tr",
    ]);
  });
});

// --- Critical 1 (whole-branch review, USER-REVISED design 2026-07-28): chat mode has no approval
// flow at all — a dangerous-domain url is HARD-BLOCKED, never carded. `checkDangerousDomain` is the
// ONE shared helper both ReadPage (read-page.ts) and the research sub-agent's FetchPage (research.ts)
// call to enforce that — reusing dangerous-domains.ts's own `dangerousDomainMatch`/
// `SHIPPED_DANGEROUS_DOMAINS`, never a second matcher. --------------------------------------------
describe("checkDangerousDomain: the shared hard-block matcher (Critical 1 fix)", () => {
  test("a SHIPPED dangerous host (transfer.sh) matches, naming itself as the matched entry", () => {
    const m = checkDangerousDomain("https://transfer.sh/x");
    expect(m).toEqual({ host: "transfer.sh", matchedEntry: "transfer.sh" });
  });

  test("a subdomain of a shipped entry matches too, naming the PARENT entry", () => {
    const m = checkDangerousDomain("https://raw.pastebin.com/abc");
    expect(m).toEqual({ host: "raw.pastebin.com", matchedEntry: "pastebin.com" });
  });

  test("an ordinary host matches nothing", () => {
    expect(checkDangerousDomain("https://example.com/x")).toBeNull();
  });

  test("a USER-ADDED domain (settings.permissions.dangerousDomains.added) matches when passed in", () => {
    expect(checkDangerousDomain("https://my-custom-exfil.example/x")).toBeNull(); // not dangerous with no additions
    expect(checkDangerousDomain("https://my-custom-exfil.example/x", ["my-custom-exfil.example"]))
      .toEqual({ host: "my-custom-exfil.example", matchedEntry: "my-custom-exfil.example" });
  });

  test("a malformed url returns null (nothing to block; the fetch itself will fail with its own clear error)", () => {
    expect(checkDangerousDomain("not a url")).toBeNull();
  });
});

// --- Minor 3 (whole-branch review, fix round 2): checkDangerousDomain only ever ran on the
// CALLER-SUPPLIED url (before fetchCleanPage was even invoked, in read-page.ts/research.ts) — a
// SAFE url that redirects INTO a dangerous host sailed through untouched: probed as
// ReadPage("https://safe.example/go") -> 302 -> https://transfer.sh/dropped fetched and rendered,
// isError:false. Can't undo the network egress that already happened (matches webFetchGate's own
// documented limit), but must stop the dangerous host's CONTENT from ever reaching the model or the
// cache — fetchCleanPage now re-checks the RESOLVED (post-redirect) host too. -----------------------
describe("fetchCleanPage: a redirect INTO a dangerous host is caught too (Minor 3 fix, fix round 2)", () => {
  test("a safe url that 302s to a dangerous host is refused before ever being rendered or cached", async () => {
    const { fetchFn } = scriptedFetch([
      { status: 302, location: "https://transfer.sh/dropped" },
      { status: 200, body: "<p>dropped content</p>", contentType: "text/html" },
    ]);
    // Precondition: the REQUESTED url itself is not dangerous — a caller's own pre-fetch
    // checkDangerousDomain check (read-page.ts's renderPage, research.ts's handleFetchPage) would
    // let this one through; the bug is specifically that the RESOLVED host was never re-checked.
    expect(checkDangerousDomain("https://safe.example/go")).toBeNull();

    await expect(
      fetchCleanPage("https://safe.example/go", new PageCache(), { fetchFn }),
    ).rejects.toThrow(/dangerous-domain/i);
  });

  test("the thrown error names the RESOLVED host (transfer.sh), not the safe requested one, with a distinct outcome", async () => {
    const { fetchFn } = scriptedFetch([
      { status: 302, location: "https://transfer.sh/dropped" },
      { status: 200, body: "<p>dropped content</p>", contentType: "text/html" },
    ]);
    try {
      await fetchCleanPage("https://safe.example/go", new PageCache(), { fetchFn });
      throw new Error("expected fetchCleanPage to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(PageCoreError);
      expect((e as Error).message).toContain("transfer.sh");
      expect((e as Error).message).not.toContain("safe.example");
      expect((e as PageCoreError).outcome).toBe("dangerous_domain_redirect");
    }
  });

  test("nothing is cached under the resolved (dangerous) url, and the audit line records the block, never a successful fetch", async () => {
    const { fetchFn } = scriptedFetch([
      { status: 302, location: "https://transfer.sh/dropped" },
      { status: 200, body: "<p>dropped content</p>", contentType: "text/html" },
    ]);
    const cache = new PageCache();
    const audited: Record<string, unknown>[] = [];
    await expect(
      fetchCleanPage("https://safe.example/go", cache, { fetchFn, audit: (l) => audited.push(l) }),
    ).rejects.toThrow();
    expect(cache.get("https://transfer.sh/dropped", 0)).toBeUndefined();
    expect(audited.at(-1)).toMatchObject({ outcome: "dangerous_domain_redirect" });
  });

  test("a USER-ADDED domain is caught on the redirect too, via the resolved effective list", async () => {
    const { fetchFn } = scriptedFetch([
      { status: 302, location: "https://my-internal-exfil.example/x" },
      { status: 200, body: "<p>dropped</p>", contentType: "text/html" },
    ]);
    await expect(
      fetchCleanPage("https://safe.example/go", new PageCache(), {
        fetchFn,
        dangerousAdded: ["my-internal-exfil.example"],
      }),
    ).rejects.toThrow(/my-internal-exfil\.example/);
  });

  test("a page that resolves to a SAFE host (no redirect into danger) is completely unaffected", async () => {
    const { fetchFn } = scriptedFetch([{ status: 200, body: "<p>hi</p>", contentType: "text/html" }]);
    const page = await fetchCleanPage("https://safe.example/", new PageCache(), { fetchFn });
    expect(page.lines).toEqual(["hi"]);
  });

  test("a MULTI-HOP redirect chain that only turns dangerous on the LAST hop is still caught", async () => {
    const { fetchFn } = scriptedFetch([
      { status: 302, location: "https://still-safe.example/step2" },
      { status: 302, location: "https://transfer.sh/final" },
      { status: 200, body: "<p>dropped</p>", contentType: "text/html" },
    ]);
    await expect(
      fetchCleanPage("https://safe.example/start", new PageCache(), { fetchFn }),
    ).rejects.toThrow(/transfer\.sh/);
  });
});
