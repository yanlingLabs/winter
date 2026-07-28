import { describe, expect, test } from "bun:test";
import {
  fetchCleanPage,
  PageCache,
  PageCoreError,
  renderLines,
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
  '<p>Meta pixel: <a href="https://www.facebook.com/tr?id=1">ad4</a>.</p>' +
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
