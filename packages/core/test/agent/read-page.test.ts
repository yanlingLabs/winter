import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolRegistry, type ToolContext } from "../../src/agent/tools/registry";
import { registerReadPageTool, type ResearchRunner, READPAGE_PER_PAGE_CHAR_CAP, READPAGE_TOTAL_OUTPUT_CHAR_CAP } from "../../src/agent/tools/read-page";
import { PageCache } from "../../src/agent/tools/page-core";
import { registerAskQuestionTool } from "../../src/agent/tools/ask-question";
import { registerSearchTool } from "../../src/agent/tools/search";
import { PermissionGate } from "../../src/agent/gate";
import { SessionStore } from "../../src/sessions/store";
import { SessionHub } from "../../src/sessions/hub";
import { ApprovalBroker } from "../../src/agent/approvals";
import { AgentEngine } from "../../src/agent/engine";
import { FakeProvider } from "../../src/agent/fake-provider";
import { SessionDirectories } from "../../src/agent/dirs";
import { ContextAssembler } from "../../src/agent/context";
import { TrustStore } from "../../src/agent/trust";
import { SkillStore } from "../../src/agent/skills";
import { Compactor } from "../../src/agent/compactor";
import type { ProviderEvent } from "../../src/providers/types";

/**
 * B2-T2: ReadPage — the registered tool wrapping Task 1's page-core (fetchCleanPage/renderLines/
 * PageCache). See task-2-brief.md + docs/superpowers/specs/2026-07-26-chat-mode-slice-b2-design.md
 * for the full contract this pins.
 *
 * CITE THE RESOLVED URL, EVERYWHERE (T1's named obligation to T2's reviewer): PageCache keys by the
 * FINAL resolved `CleanPage.url`, so every header/citation this tool emits must use that, never the
 * caller-supplied input — the redirect tests below are the load-bearing proof.
 */

function ctx(over: Partial<ToolContext> = {}): ToolContext {
  return { cwd: "/tmp", roots: ["/tmp"], sessionId: "s1", ...over };
}

interface Step { status: number; location?: string; body?: string; contentType?: string }

/** Same convention as page-core.test.ts's own `scriptedFetch` — a linear script of responses (one
 *  per redirect hop), plus a call counter so the citation round-trip test can assert on COUNTS. */
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

/** Dispatches by exact requested URL — for batching tests where several distinct URLs need
 *  distinct canned responses in ONE fetchFn (no redirects involved). */
function urlFetch(responses: Record<string, Step>): { fetchFn: typeof fetch; calls: () => number } {
  let calls = 0;
  const fetchFn = (async (url: string | URL) => {
    calls++;
    const key = String(url);
    const step = responses[key];
    if (!step) throw new Error(`no scripted response for ${key}`);
    const headers = new Headers();
    if (step.contentType) headers.set("content-type", step.contentType);
    return new Response(step.body ?? "", { status: step.status, headers });
  }) as unknown as typeof fetch;
  return { fetchFn, calls: () => calls };
}

const FIVE_LINE_HTML =
  "<html><head><title>Five Lines</title></head><body>" +
  "<p>line one</p><p>line two</p><p>line three</p><p>line four</p><p>line five</p>" +
  '<p><a href="https://other.example.com/x">other site</a></p>' +
  "</body></html>";

describe("ReadPage: registration shape (bug #7 regression + per-mode eligibility)", () => {
  test("is NOT deferred — chat has no ToolSearch, so a deferred ReadPage would be permanently uncallable", () => {
    const r = new ToolRegistry();
    registerReadPageTool(r, { cache: new PageCache() });
    expect(r.isDeferredBuiltin("ReadPage", true)).toBe(false);
  });

  test("eligible for chat and dispatch, NOT code", () => {
    const r = new ToolRegistry();
    registerReadPageTool(r, { cache: new PageCache() });
    expect(r.namesForMode("chat").has("ReadPage")).toBe(true);
    expect(r.namesForMode("dispatch").has("ReadPage")).toBe(true);
    expect(r.namesForMode("code").has("ReadPage")).toBe(false);
  });

  test("FetchPage is never registered by this file — forward guard for Task 3 (the real, daemon-wide proof lives in mode-toolset-census.test.ts)", () => {
    const r = new ToolRegistry();
    registerReadPageTool(r, { cache: new PageCache() });
    expect(r.has("FetchPage")).toBe(false);
  });
});

describe("ReadPage: gate classification (NETWORK, matching Search)", () => {
  test("allows under every policy — plan/auto/ask all allow, identical to Search's own verdicts", () => {
    const g = new PermissionGate();
    for (const p of ["plan", "auto", "ask"] as const) {
      expect(g.evaluate("ReadPage", p)).toBe("allow");
      expect(g.evaluate("ReadPage", p)).toBe(g.evaluate("Search", p));
    }
  });
});

describe("ReadPage: full page (numbered lines + Links: tail)", () => {
  test("no lineStart/lineEnd loads the whole page, numbered, with a Links: tail listing the page's links", async () => {
    const { fetchFn } = scriptedFetch([{ status: 200, body: FIVE_LINE_HTML, contentType: "text/html" }]);
    const r = new ToolRegistry();
    registerReadPageTool(r, { cache: new PageCache(), fetchFn });

    const out = await r.execute("ReadPage", { pages: [{ url: "https://example.com/page" }] }, ctx());
    expect(out.isError).toBe(false);
    expect(out.output).toContain("https://example.com/page");
    expect(out.output).toContain("1→line one");
    expect(out.output).toContain("5→line five");
    expect(out.output).toContain("Links:");
    expect(out.output).toContain("other site (https://other.example.com/x)");
  });
});

// --- Important 3, whole-branch review: page-core.ts's CleanPage.fromCache already exists but was
// unused by both callers — the model has no way to tell a cached read from a fresh refetch, even
// though cached/fresh renders are byte-identical otherwise. Surface it in the header. -------------
describe("ReadPage: description no longer promises a purely time-based caching guarantee (Important 3 fix)", () => {
  test("the description tells the model to check the freshness marker rather than assume a fixed time window", () => {
    const r = new ToolRegistry();
    registerReadPageTool(r, { cache: new PageCache() });
    const spec = r.specs(null).find((s) => s.name === "ReadPage");
    // The old wording promised reload stability "roughly 1 hour" — a pure TIME bound — while
    // eviction pressure could actually reclaim the entry in seconds under load. The new wording must
    // point the model at the per-page header's own freshness marker instead of a time estimate alone.
    expect(spec?.description.toLowerCase()).toContain("cached");
    expect(spec?.description.toLowerCase()).toContain("fresh fetch");
  });
});

describe("ReadPage: freshness signal in the per-page header (Important 3 fix)", () => {
  test("a first fetch is labeled as a fresh fetch, not cached", async () => {
    const { fetchFn } = scriptedFetch([{ status: 200, body: FIVE_LINE_HTML, contentType: "text/html" }]);
    const r = new ToolRegistry();
    registerReadPageTool(r, { cache: new PageCache(), fetchFn });
    const out = await r.execute("ReadPage", { pages: [{ url: "https://example.com/page" }] }, ctx());
    expect(out.output.toLowerCase()).toContain("fresh");
    expect(out.output.toLowerCase()).not.toContain("cached");
  });

  test("a second call inside the TTL is labeled as cached", async () => {
    const { fetchFn } = scriptedFetch([{ status: 200, body: FIVE_LINE_HTML, contentType: "text/html" }]);
    const cache = new PageCache();
    const r = new ToolRegistry();
    registerReadPageTool(r, { cache, fetchFn });
    await r.execute("ReadPage", { pages: [{ url: "https://example.com/page" }] }, ctx());
    const second = await r.execute("ReadPage", { pages: [{ url: "https://example.com/page" }] }, ctx());
    expect(second.output.toLowerCase()).toContain("cached");
  });
});

describe("ReadPage: line ranges + the citation round-trip (the property that matters most)", () => {
  test("a lineStart/lineEnd entry returns exactly those numbered lines", async () => {
    const { fetchFn } = scriptedFetch([{ status: 200, body: FIVE_LINE_HTML, contentType: "text/html" }]);
    const r = new ToolRegistry();
    registerReadPageTool(r, { cache: new PageCache(), fetchFn });

    const out = await r.execute("ReadPage", { pages: [{ url: "https://example.com/page", lineStart: 2, lineEnd: 4 }] }, ctx());
    expect(out.isError).toBe(false);
    expect(out.output).toContain("lines:2-4 of 6");
    expect(out.output).toContain("2→line two");
    expect(out.output).toContain("3→line three");
    expect(out.output).toContain("4→line four");
    expect(out.output).not.toContain("1→line one");
    expect(out.output).not.toContain("5→line five");
  });

  // THE property: cite a `lines:N-M` from a full-page fetch, reload with lineStart/lineEnd, get
  // byte-identical text back, with ZERO additional fetchFn calls — proof the shared PageCache is
  // doing its job and that the citation contract (page-core.ts's own doc comment) actually holds
  // through this tool's wrapping. Deliberately over a REDIRECTING url — the resolved-URL evidence:
  // the first response must say "requested: X → resolved: Y", and the SECOND call must be made
  // against Y (the resolved address) to hit the cache — a citation built from the input address
  // would refetch instead, per page-core.ts's own cache-key contract.
  test("citation round-trip across a redirect: the resolved URL is cited, and re-loading its cited range makes ZERO additional fetchFn calls", async () => {
    const { fetchFn, calls } = scriptedFetch([
      { status: 302, location: "https://redirected.example.com/final/" },
      { status: 200, body: FIVE_LINE_HTML, contentType: "text/html" },
    ]);
    const r = new ToolRegistry();
    registerReadPageTool(r, { cache: new PageCache(), fetchFn });

    const first = await r.execute("ReadPage", { pages: [{ url: "https://example.com/start" }] }, ctx());
    expect(first.isError).toBe(false);
    // Resolved-URL evidence: requested != resolved, and the tool says so exactly once.
    expect(first.output).toContain("requested: https://example.com/start → resolved: https://redirected.example.com/final/");
    // Never cites the pre-redirect address as if it were the page's own URL.
    expect(first.output).toContain("lines:1-6 of 6");
    expect(calls()).toBe(2); // one redirect hop + the final 200

    // Cite lines 2-4 from the first response, reload with the RESOLVED url — must hit the cache.
    const second = await r.execute(
      "ReadPage",
      { pages: [{ url: "https://redirected.example.com/final/", lineStart: 2, lineEnd: 4 }] },
      ctx(),
    );
    expect(second.isError).toBe(false);
    expect(calls()).toBe(2); // ZERO additional fetchFn calls — served from the shared cache
    expect(second.output).toContain("2→line two");
    expect(second.output).toContain("3→line three");
    expect(second.output).toContain("4→line four");
    // No "requested: ... -> resolved: ..." line this time: the input URL now IS the resolved one.
    expect(second.output).not.toContain("requested:");
    expect(second.output).toContain("https://redirected.example.com/final/");
  });
});

describe("ReadPage: batching — one failing entry must not fail the batch", () => {
  test("3 URLs, one SSRF-refused: the batch returns per-page sections, the failing section carries the error, the other two succeed", async () => {
    const okA = "<html><head><title>Page A</title></head><body><p>alpha content</p></body></html>";
    const okB = "<html><head><title>Page B</title></head><body><p>bravo content</p></body></html>";
    const { fetchFn } = urlFetch({
      "https://a.example.com/": { status: 200, body: okA, contentType: "text/html" },
      "https://b.example.com/": { status: 200, body: okB, contentType: "text/html" },
    });
    const r = new ToolRegistry();
    registerReadPageTool(r, { cache: new PageCache(), fetchFn });

    const out = await r.execute(
      "ReadPage",
      { pages: [{ url: "https://a.example.com/" }, { url: "http://10.0.0.5/" }, { url: "https://b.example.com/" }] },
      ctx(),
    );

    expect(out.isError).toBe(false); // one failure among three successes must not fail the whole call
    expect(out.output).toContain("alpha content");
    expect(out.output).toContain("bravo content");
    expect(out.output).toContain("http://10.0.0.5/");
    expect(out.output.toLowerCase()).toContain("refusing to fetch a private address");
  });
});

// --- Critical 1, whole-branch review (USER-REVISED design, 2026-07-28): chat has no approval flow
// at all — a dangerous-domain url is HARD-BLOCKED (isError per-entry, no card, never reaches
// fetchFn), naming the matched entry so the transcript reads as a deliberate policy block, not a
// network failure. A non-dangerous sibling in the same batch is unaffected. -----------------------
describe("ReadPage: dangerous-domain hard-block (Critical 1 fix, no card, ever)", () => {
  test("a SHIPPED dangerous host (transfer.sh) is refused outright — zero fetchFn calls, isError, names the matched entry", async () => {
    let fetchCalled = false;
    const fetchFn = (async () => { fetchCalled = true; return new Response("nope"); }) as unknown as typeof fetch;
    const r = new ToolRegistry();
    registerReadPageTool(r, { cache: new PageCache(), fetchFn });

    const out = await r.execute("ReadPage", { pages: [{ url: "https://transfer.sh/x" }] }, ctx());
    expect(out.isError).toBe(true);
    expect(fetchCalled).toBe(false); // never reached the network
    expect(out.output).toContain("https://transfer.sh/x");
    expect(out.output).toContain("transfer.sh"); // names the matched entry
    expect(out.output.toLowerCase()).toContain("dangerous");
  });

  test("a mixed batch: the dangerous entry is refused, the safe sibling still succeeds — isError:false overall", async () => {
    const { fetchFn } = urlFetch({
      "https://a.example.com/": { status: 200, body: FIVE_LINE_HTML, contentType: "text/html" },
    });
    const r = new ToolRegistry();
    registerReadPageTool(r, { cache: new PageCache(), fetchFn });

    const out = await r.execute(
      "ReadPage",
      { pages: [{ url: "https://a.example.com/" }, { url: "https://pastebin.com/raw/x" }] },
      ctx(),
    );
    expect(out.isError).toBe(false); // the safe sibling rescues the batch
    expect(out.output).toContain("1→line one");
    expect(out.output).toContain("pastebin.com");
    expect(out.output.toLowerCase()).toContain("dangerous");
  });

  test("a batch where EVERY entry is dangerous is isError:true (all-fail contract, same as any other all-failing batch)", async () => {
    const r = new ToolRegistry();
    registerReadPageTool(r, { cache: new PageCache() });
    const out = await r.execute(
      "ReadPage",
      { pages: [{ url: "https://transfer.sh/a" }, { url: "https://webhook.site/b" }] },
      ctx(),
    );
    expect(out.isError).toBe(true);
  });

  test("a USER-ADDED domain (settings.permissions.dangerousDomains.added) is blocked exactly like a shipped one", async () => {
    let fetchCalled = false;
    const fetchFn = (async () => { fetchCalled = true; return new Response("nope"); }) as unknown as typeof fetch;
    const r = new ToolRegistry();
    registerReadPageTool(r, {
      cache: new PageCache(),
      fetchFn,
      dangerousDomainsAdded: (cwd) => (cwd === "/tmp" ? ["my-internal-exfil.example"] : undefined),
    });

    const out = await r.execute("ReadPage", { pages: [{ url: "https://my-internal-exfil.example/x" }] }, ctx());
    expect(out.isError).toBe(true);
    expect(fetchCalled).toBe(false);
    expect(out.output).toContain("my-internal-exfil.example");
  });

  test("an ordinary (non-dangerous) host is completely unaffected", async () => {
    const { fetchFn } = scriptedFetch([{ status: 200, body: FIVE_LINE_HTML, contentType: "text/html" }]);
    const r = new ToolRegistry();
    registerReadPageTool(r, { cache: new PageCache(), fetchFn });
    const out = await r.execute("ReadPage", { pages: [{ url: "https://example.com/page" }] }, ctx());
    expect(out.isError).toBe(false);
    expect(out.output).toContain("1→line one");
  });

  test("a query entry whose SEED url is dangerous is refused before research ever runs", async () => {
    let researchCalled = false;
    const stub: ResearchRunner = { async run() { researchCalled = true; return "REPORT"; } };
    const r = new ToolRegistry();
    registerReadPageTool(r, { cache: new PageCache(), research: stub });

    const out = await r.execute("ReadPage", { pages: [{ url: "https://transfer.sh/seed", query: "summarize" }] }, ctx());
    expect(out.isError).toBe(true);
    expect(researchCalled).toBe(false);
    expect(out.output).toContain("transfer.sh");
  });

  test("EVERY policy the gate allows ReadPage under still hard-blocks — there is no card at all, ever (probed across the same policy set web_fetch cards under)", async () => {
    // ReadPage's gate verdict is unconditionally "allow" under every policy (see the "gate
    // classification" describe block above) — the hard-block below is enforced entirely INSIDE the
    // tool, independent of policy, so it fires identically regardless of what policy a caller is
    // under. This test proves that independence directly: same tool call, no policy plumbing
    // involved at all, and the refusal is identical every time.
    for (const _policy of ["plan", "dont-ask", "ask", "accept-edits", "auto", "bypass"] as const) {
      const r = new ToolRegistry();
      registerReadPageTool(r, { cache: new PageCache() });
      const out = await r.execute("ReadPage", { pages: [{ url: "https://transfer.sh/x" }] }, ctx());
      expect(out.isError).toBe(true);
      expect(out.output.toLowerCase()).toContain("dangerous");
    }
  });
});

describe("ReadPage: caps — a pathological page/batch must stay bounded", () => {
  function bigHtml(title: string, paragraphs: number): string {
    const body = Array.from(
      { length: paragraphs },
      (_, i) => `<p>Paragraph number ${i} padded with some filler text so each line has real weight to it.</p>`,
    ).join("");
    return `<html><head><title>${title}</title></head><body>${body}</body></html>`;
  }

  test("a pathological single page stays under the per-page cap", async () => {
    const { fetchFn } = scriptedFetch([{ status: 200, body: bigHtml("Huge", 3000), contentType: "text/html" }]);
    const r = new ToolRegistry();
    registerReadPageTool(r, { cache: new PageCache(), fetchFn });

    const out = await r.execute("ReadPage", { pages: [{ url: "https://example.com/huge" }] }, ctx());
    expect(out.isError).toBe(false);
    expect(out.output.length).toBeLessThanOrEqual(READPAGE_PER_PAGE_CHAR_CAP);
  });

  test("a pathological batch (8 huge pages) stays under the total output cap", async () => {
    const urls = Array.from({ length: 8 }, (_, i) => `https://big${i}.example.com/`);
    const responses: Record<string, Step> = {};
    for (const u of urls) responses[u] = { status: 200, body: bigHtml("Huge", 3000), contentType: "text/html" };
    const { fetchFn } = urlFetch(responses);
    const r = new ToolRegistry();
    registerReadPageTool(r, { cache: new PageCache(), fetchFn });

    const out = await r.execute("ReadPage", { pages: urls.map((url) => ({ url })) }, ctx());
    expect(out.isError).toBe(false);
    expect(out.output.length).toBeLessThanOrEqual(READPAGE_TOTAL_OUTPUT_CHAR_CAP);
  });
});

describe("ReadPage: query (research hook) — T2 ships without T3", () => {
  test("a query entry with no research wired returns isError 'research is not available in this session yet', with no crash", async () => {
    const r = new ToolRegistry();
    registerReadPageTool(r, { cache: new PageCache() });

    const out = await r.execute("ReadPage", { pages: [{ url: "https://example.com/", query: "what is this page about?" }] }, ctx());
    expect(out.isError).toBe(true);
    expect(out.output).toBe("research is not available in this session yet");
  });

  test("a query entry mixed with a normal page in the same batch: the query entry fails alone, the normal page still succeeds", async () => {
    const { fetchFn } = urlFetch({
      "https://a.example.com/": { status: 200, body: FIVE_LINE_HTML, contentType: "text/html" },
    });
    const r = new ToolRegistry();
    registerReadPageTool(r, { cache: new PageCache(), fetchFn });

    const out = await r.execute(
      "ReadPage",
      { pages: [{ url: "https://a.example.com/" }, { url: "https://b.example.com/", query: "summarize this" }] },
      ctx(),
    );
    expect(out.isError).toBe(false); // the successful page rescues the batch
    expect(out.output).toContain("1→line one");
    expect(out.output).toContain("research is not available in this session yet");
  });

  test("a query entry with research WIRED calls it with the entry's url/query/max_pages (+ ctx.cwd, for the sub-agent's OWN dangerous-domain hard-block) and relays its report verbatim", async () => {
    const calls: Array<{ url: string; query: string; max_pages?: number; cwd?: string }> = [];
    const stub: ResearchRunner = {
      async run(q) {
        calls.push(q);
        return "REPORT: it's about widgets. https://example.com/ lines:1-3";
      },
    };
    const r = new ToolRegistry();
    registerReadPageTool(r, { cache: new PageCache(), research: stub });

    const out = await r.execute(
      "ReadPage",
      { pages: [{ url: "https://example.com/", query: "what is this about?", max_pages: 3 }] },
      ctx(),
    );
    expect(out.isError).toBe(false);
    expect(out.output).toBe("REPORT: it's about widgets. https://example.com/ lines:1-3");
    // cwd rides ctx().cwd ("/tmp") through — see research.ts's ResearchQuery.cwd doc comment (Critical
    // 1 fix): FetchPage's own hard-block needs the SAME per-project dangerousDomainsAdded lookup
    // ReadPage itself uses, and ctx.cwd is the only way it can reach that.
    expect(calls).toEqual([{ url: "https://example.com/", query: "what is this about?", max_pages: 3, cwd: "/tmp" }]);
  });

  test("query and a line range on the same entry are rejected by the schema (mutually exclusive)", async () => {
    const r = new ToolRegistry();
    registerReadPageTool(r, { cache: new PageCache() });
    const out = await r.execute("ReadPage", { pages: [{ url: "https://example.com/", query: "x", lineStart: 1 }] }, ctx());
    expect(out.isError).toBe(true);
    expect(out.output).toContain("invalid arguments for ReadPage");
  });
});

// B2-T3 fix-round-1 CRITICAL: the reviewer proved plain ReadPage hangs identically to the research
// runner on a stuck fetch (page-core.ts previously passed followRedirects no signal at all). The
// fix lives entirely in page-core.ts's own default per-fetch timeout (page-core.test.ts's own
// "per-fetch default timeout" describe block proves the mechanism) — this is the "ReadPage itself
// inherits it" proof, forwarding a shrunk `timeoutMs` through the new ReadPageDeps field so the
// test doesn't have to wait out the real 15s default.
describe("ReadPage: a stuck fetch no longer hangs the tool (fix-round-1 CRITICAL)", () => {
  function hangingUntilAborted(): typeof fetch {
    return (async (_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return;
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

  test("a per-entry fetch that hangs until its signal fires resolves via the default timeout, well within the test's shrunken bound, as an isError:true entry-failure", async () => {
    const r = new ToolRegistry();
    registerReadPageTool(r, { cache: new PageCache(), fetchFn: hangingUntilAborted(), timeoutMs: 30 });

    const start = Date.now();
    const out = await r.execute("ReadPage", { pages: [{ url: "https://example.com/" }] }, ctx());
    expect(Date.now() - start).toBeLessThan(1000);
    expect(out.isError).toBe(true); // the sole entry failed -> whole batch isError (existing "one bad entry" contract)
    expect(out.output.toLowerCase()).toContain("timed out");
  });

  // fix-round-2 Minor: renderPage never forwarded ctx.signal (the caller/user's own abort) into
  // fetchCleanPage at all — a user-interrupted turn left a plain page-read fetch running to the
  // FULL default bound regardless. `timeoutMs: 5000` here stands in for the real (uninjectable in
  // production) 15s default, just shrunk so RED capture doesn't take 15s — the point is proving
  // ctx.signal (60ms) wins over whatever the default bound is, not any particular millisecond value.
  test("a user abort (ctx.signal) mid-fetch returns promptly instead of running to the per-fetch default bound", async () => {
    const r = new ToolRegistry();
    registerReadPageTool(r, { cache: new PageCache(), fetchFn: hangingUntilAborted(), timeoutMs: 5000 });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 60);

    const start = Date.now();
    const out = await r.execute("ReadPage", { pages: [{ url: "https://example.com/" }] }, ctx({ signal: controller.signal }));
    expect(Date.now() - start).toBeLessThan(2000); // proves ctx.signal (60ms), not the 5000ms default, is what fired
    expect(out.isError).toBe(true);
    expect(out.output.toLowerCase()).toMatch(/timed out|aborted/);
  });
});

describe("ReadPage via a real turn: not deferred, visible immediately (production-shaped harness)", () => {
  function harness(mode: "chat" | "dispatch" | "code") {
    const home = mkdtempSync(join(tmpdir(), "norma-readpage-turn-"));
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "norma-readpage-turn-cwd-")));
    const store = new SessionStore(home);
    const hub = new SessionHub(store);
    const registry = new ToolRegistry();
    registerAskQuestionTool(registry);
    registerSearchTool(registry);
    registerReadPageTool(registry, { cache: new PageCache() });

    const assemblerHome = mkdtempSync(join(tmpdir(), "norma-readpage-turn-actx-"));
    const assemblerTrust = new TrustStore(join(assemblerHome, "trust.json"));
    const skills = new SkillStore({ normaHome: assemblerHome, trust: assemblerTrust });
    const broker = new ApprovalBroker();
    const provider = new FakeProvider([
      [{ type: "text_delta", delta: "hi" }, { type: "usage", inputTokens: 10, outputTokens: 2 }, { type: "done", stopReason: "end_turn" }],
    ] as ProviderEvent[][]);
    const dirs = new SessionDirectories(() => [cwd]);
    const assembler = new ContextAssembler({ normaHome: assemblerHome, trust: assemblerTrust, skills });
    const compactor = new Compactor({ provider: { provider, model: "fake-1" }, store, hub });
    const engine = new AgentEngine({
      store, hub, registry, broker,
      gate: new PermissionGate(),
      provider: { provider, model: "fake-1" },
      dirs, assembler, compactor,
      // Production-shaped: the config OBJECT present, `enabled` resolving undefined — daemon.ts's
      // real shape when the user never touched settings.toolSearch.enabled (chat-mode-allowlist
      // .test.ts's own convention/rationale).
      toolSearch: { enabled: () => undefined },
    });
    const sessionId = store.createSession("global", { cwd, approvalPolicy: "auto", mode });
    return { engine, sessionId, provider };
  }

  test("chat's offered set is exactly AskQuestion, ReadPage, Search", async () => {
    const { engine, sessionId, provider } = harness("chat");
    await engine.runTurn(sessionId);
    const names = (provider.requests[0]?.tools ?? []).map((t) => t.name).sort();
    expect(names).toEqual(["AskQuestion", "ReadPage", "Search"]);
  });

  test("dispatch's immediate tool list contains ReadPage (not deferred there either)", async () => {
    const { engine, sessionId, provider } = harness("dispatch");
    await engine.runTurn(sessionId);
    const names = (provider.requests[0]?.tools ?? []).map((t) => t.name);
    expect(names).toContain("ReadPage");
  });

  test("code never offers ReadPage", async () => {
    const { engine, sessionId, provider } = harness("code");
    await engine.runTurn(sessionId);
    const names = (provider.requests[0]?.tools ?? []).map((t) => t.name);
    expect(names).not.toContain("ReadPage");
  });
});
