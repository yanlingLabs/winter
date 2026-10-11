// ComputerV2 Phase 4 — `browsers.read(url)` (`computer-use/browser/http-read.ts`): a page's text over plain HTTP, the
// daemon fetching for the sandboxed worker. Over an injected fetch and resolver: every hop checked before anything is
// sent to it (scheme, credentials, the address rule as written and as resolved, the dangerous-domain floor), the
// connect pinned to a checked address, loopback allowed and the LAN refused, the caps, the content types, `needsJs`,
// cancel and timeout, the fence and the redaction, the in-flight limits, and metrics that carry no URL. Then the real
// thing on loopback: a pinned TLS connect verified against the original name, gzip, and the address fallback.
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addressClassOf, decodeNumericEntities, ipAddressClass } from "../../src/agent/tools/web";
import { BrowserEngine } from "../../src/computer-use/browser/engine";
import {
  HttpReader, looksLikeItNeedsJs, READ_MAX_BYTES, READ_MAX_CHARS, READ_USER_AGENT, READS_PER_HOST, READS_PER_SESSION, type HttpReaderDeps,
} from "../../src/computer-use/browser/http-read";
import { BrowserBackendRegistry } from "../../src/computer-use/browser/registry";
import { SiteApprovals } from "../../src/computer-use/browser/site-policy";
import { AutomationFailure } from "../../src/computer-use/errors";
import { harness, type HarnessOpts } from "./browser-harness";

type Init = RequestInit & { tls?: { serverName?: string } };
interface Sent { url: string; host: string; serverName?: string; headers: Record<string, string> }

/** A fake network: names resolve to addresses; a request is answered by the handler for `<Host><path>`. */
function net(o: { names?: Record<string, string[]>; pages: Record<string, (req: Sent) => Response | Promise<Response>> }) {
  const sent: Sent[] = [];
  const resolved: string[] = [];
  const deps: HttpReaderDeps = {
    resolve: async (name) => {
      resolved.push(name);
      if (/^[0-9.]+$/.test(name) || name.includes(":")) return [name];
      const a = o.names?.[name];
      if (a === undefined) throw new Error("ENOTFOUND");
      return a;
    },
    fetchFn: async (url: string, init: Init) => {
      if (init.signal?.aborted === true) throw Object.assign(new Error("aborted"), { name: "AbortError" });
      const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
      const u = new URL(url);
      const req: Sent = { url, host: headers.host ?? "", ...(init.tls?.serverName === undefined ? {} : { serverName: init.tls.serverName }), headers };
      sent.push(req);
      const handler = o.pages[`${req.host}${u.pathname}${u.search}`];
      if (handler === undefined) throw new Error(`no page for ${req.host}${u.pathname}`);
      // Like a real fetch: an abort of the request's signal rejects it at once.
      const signal = init.signal ?? undefined;
      return await new Promise<Response>((resolve, reject) => {
        const onAbort = (): void => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        signal?.addEventListener("abort", onAbort, { once: true });
        Promise.resolve(handler(req)).then((v) => { signal?.removeEventListener("abort", onAbort); resolve(v); }, (e: unknown) => { signal?.removeEventListener("abort", onAbort); reject(e); });
      });
    },
  };
  return { deps, sent, resolved };
}

const html = (body: string, extra: Record<string, string> = {}): Response => new Response(body, { headers: { "content-type": "text/html; charset=utf-8", ...extra } });
const redirect = (to: string, status = 302): Response => new Response(null, { status, headers: { location: to } });

function setup(o: { names?: Record<string, string[]>; pages: Record<string, (req: Sent) => Response | Promise<Response>> }, h: HarnessOpts = {}) {
  const hz = harness(h);
  const n = net(o);
  const reader = new HttpReader(n.deps);
  const approvals = new SiteApprovals();
  const site = { dangerousDomainsAdded: () => h.dangerousAdded ?? [], savedAllowRules: () => h.savedRules ?? [] };
  const r = hz.run();
  const read = (url: string, args: Record<string, unknown> = {}) => reader.read(r.scope, url, args, { approvals, site, cwd: undefined });
  return { ...hz, ...n, reader, r, read };
}

async function failure(p: Promise<unknown>): Promise<Error> {
  try { await p; } catch (err) { return err as Error; }
  throw new Error("expected a failure");
}
const kind = (e: Error): string => (e instanceof AutomationFailure ? e.kind : e.name);

const ARTICLE = `<!doctype html><html><head><title>Docs &#8212; API</title><script src="/a.js"></script></head><body>
<h1>The API</h1><p>Read the guide at <a href="https://docs.example.com/guide">the guide</a>.</p>
<ul><li>One &#x2019;s</li><li>Two</li></ul>${"<p>More text to make this a real page. </p>".repeat(10)}</body></html>`;

describe("browsers.read: a page's text over plain HTTP", () => {
  test("a public page: GET to a checked address, the original host as Host and TLS server name, Winter's honest UA, no cookies", async () => {
    const t = setup({ names: { "docs.example.com": ["93.184.216.34"] }, pages: { "docs.example.com/api": () => html(ARTICLE) } });
    const res = await t.read("https://docs.example.com/api");
    expect(res).toMatchObject({ url: "https://docs.example.com/api", status: 200, type: "text/html", truncated: false, needsJs: false });
    expect(res.title).toBe("The API");
    expect(res.text).toContain("# The API");
    expect(res.text).toContain("the guide (https://docs.example.com/guide)");
    expect(res.text).toContain("- One ’s");
    const s = t.sent[0]!;
    expect(new URL(s.url).hostname).toBe("93.184.216.34");
    expect(s.host).toBe("docs.example.com");
    expect(s.serverName).toBe("docs.example.com");
    expect(s.headers["user-agent"]).toBe(READ_USER_AGENT);
    expect(READ_USER_AGENT).toMatch(/^Mozilla\/5\.0 \(Macintosh; Mac OS X\) Winter\/\d+\.\d+\.\d+$/);
    expect(s.headers.accept).toContain("text/html");
    for (const h of ["cookie", "authorization", "referer"]) expect(s.headers[h]).toBeUndefined();
    // Printed: the header line then the text, fenced as page data.
    const out = t.r.text();
    expect(out).toMatch(/<screen-data id="[0-9a-f]+">\nread https:\/\/docs\.example\.com\/api — 200 text\/html · [\d,]+ characters · "The API"\n# The API/);
    expect(t.r.builder.readScreen).toBe(true);
  });

  test("emit:false prints nothing but still marks the result as page data", async () => {
    const t = setup({ names: { "a.example": ["93.184.216.34"] }, pages: { "a.example/": () => new Response("plain", { headers: { "content-type": "text/plain" } }) } });
    const res = await t.read("https://a.example/", { emit: false });
    expect(res.text).toBe("plain");
    expect(t.r.text()).not.toContain("read https://");
    expect(t.r.text()).not.toContain("plain");
    expect(t.r.builder.readScreen).toBe(true);
  });

  test("loopback is allowed (a local dev server over plain http); every other private address is refused before anything is sent", async () => {
    const t = setup({ names: { localhost: ["127.0.0.1"] }, pages: { "localhost:3000/": () => html("<p>dev server</p>") } });
    expect((await t.read("http://localhost:3000/")).text).toBe("dev server");
    for (const url of ["http://10.0.0.5/", "http://192.168.1.1/admin", "http://172.16.0.1/", "http://169.254.169.254/latest", "http://100.64.0.1/",
      "http://[fd00::1]/", "http://[fe80::1]/", "http://0.0.0.0/", "http://printer.local/", "http://0177.0.0.1.example.invalid@10.0.0.1/"]) {
      const before = t.sent.length;
      const e = await failure(t.read(url));
      expect(kind(e)).toBe("NotAllowed");
      expect(t.sent.length).toBe(before);
    }
    // A name that RESOLVES into the LAN is refused at the resolved address — and a mixed answer too.
    const r2 = setup({ names: { "intranet.example.com": ["192.168.1.20"], "mixed.example.com": ["93.184.216.34", "10.1.2.3"] }, pages: {} });
    for (const url of ["https://intranet.example.com/", "https://mixed.example.com/"]) {
      const e = await failure(r2.read(url));
      expect(kind(e)).toBe("NotAllowed");
      expect(e.message).toContain("private network address");
    }
    expect(r2.sent).toEqual([]);
  });

  test("a redirect may lead into this Mac's loopback only from a read that started there", async () => {
    const t = setup({
      names: { "pub.example": ["93.184.216.34"], "rebind.example": ["127.0.0.1"], localhost: ["127.0.0.1"] },
      pages: {
        "pub.example/to-local": () => redirect("http://127.0.0.1:8080/admin"),
        "pub.example/to-rebind": () => redirect("http://rebind.example:8080/admin"),
        "localhost:3000/old": () => redirect("http://127.0.0.1:3000/new"),
        "127.0.0.1:3000/new": () => html("<p>moved locally</p>"),
      },
    });
    for (const path of ["/to-local", "/to-rebind"]) {
      const e = await failure(t.read(`https://pub.example${path}`));
      expect(kind(e)).toBe("NotAllowed");
      expect(e.message).toContain("follows redirects into localhost only from localhost");
    }
    expect(t.sent.some((s) => s.host.endsWith(":8080"))).toBe(false);
    expect((await t.read("http://localhost:3000/old")).text).toBe("moved locally");
  });

  test("a URL with a user name or password is refused; a non-http(s) one is refused before any browser or socket", async () => {
    const t = setup({ pages: {} });
    const e = await failure(t.read("https://user:pw@docs.example.com/"));
    expect(kind(e)).toBe("NotAllowed");
    expect(e.message).toContain("user name or password");
    const blank = await failure(t.read("about:blank"));
    expect(blank).toBeInstanceOf(TypeError);
    expect(t.sent).toEqual([]);
  });

  test("every redirect hop is checked again: into the LAN, onto another scheme, and past five hops", async () => {
    const t = setup({
      names: { "a.example": ["93.184.216.34"], "b.example": ["93.184.216.35"], "lan.example": ["10.9.9.9"] },
      pages: {
        "a.example/to-lan": () => redirect("http://lan.example/secret"),
        "a.example/to-ip": () => redirect("http://192.168.0.1/"),
        "a.example/to-file": () => redirect("file:///etc/passwd"),
        "a.example/loop": () => redirect("/loop2"),
        "a.example/loop2": () => redirect("/loop3"),
        "a.example/loop3": () => redirect("/loop4"),
        "a.example/loop4": () => redirect("/loop5"),
        "a.example/loop5": () => redirect("/loop6"),
        "a.example/loop6": () => redirect("/loop7"),
        "a.example/hop": () => redirect("https://b.example/landed", 301),
        "b.example/landed": () => html("<p>landed</p>"),
      },
    });
    for (const path of ["/to-lan", "/to-ip"]) {
      const e = await failure(t.read(`https://a.example${path}`));
      expect(kind(e)).toBe("NotAllowed");
      expect(e.message).toContain("a redirect led to a private network address");
    }
    expect(t.sent.some((s) => s.host === "lan.example" || s.host === "192.168.0.1")).toBe(false);
    expect(kind(await failure(t.read("https://a.example/to-file")))).toBe("NotAllowed");
    const loop = await failure(t.read("https://a.example/loop"));
    expect(loop.message).toContain("too many redirects (more than 5)");
    const ok = await t.read("https://a.example/hop");
    expect(ok.url).toBe("https://b.example/landed");
    expect(ok.text).toBe("landed");
    expect([...t.r.sites]).toContain("b.example");
  });

  test("the dangerous-domain floor on the URL and on every hop: a card under ask (once covers the run), a hard block under auto", async () => {
    const pages = { "ok.example/": () => redirect("https://evil.example/x"), "evil.example/x": () => html("<p>evil</p>") };
    const names = { "ok.example": ["93.184.216.34"], "evil.example": ["93.184.216.66"] };
    const ask = setup({ names, pages }, { policy: "ask", dangerousAdded: ["evil.example"], answer: () => "once" });
    expect((await ask.read("https://ok.example/")).text).toBe("evil");
    expect(ask.cards.map((c) => c.summary)).toEqual(["Allow Winter to use evil.example in Winter's page reader? It is on the dangerous-domains list."]);
    const declined = setup({ names, pages }, { policy: "ask", dangerousAdded: ["evil.example"], answer: () => false });
    expect(kind(await failure(declined.read("https://evil.example/x")))).toBe("NotAllowed");
    expect(declined.sent).toEqual([]);
    for (const policy of ["auto", "bypass", "dont-ask"] as const) {
      const blocked = setup({ names, pages }, { policy, dangerousAdded: ["evil.example"] });
      const e = await failure(blocked.read("https://ok.example/"));
      expect(kind(e)).toBe("NotAllowed");
      expect(blocked.cards).toEqual([]);
      expect(blocked.sent.some((s) => s.host === "evil.example")).toBe(false);
    }
    const dispatch = setup({ names, pages }, { policy: "ask", facts: { mode: "dispatch" }, dangerousAdded: ["evil.example"] });
    expect(kind(await failure(dispatch.read("https://evil.example/x")))).toBe("NotAllowed");
    // plan: an observe primitive — the read runs, a listed host still asks.
    const plan = setup({ names, pages: { "ok.example/": () => html("<p>fine</p>") } }, { policy: "plan" });
    expect((await plan.read("https://ok.example/")).text).toBe("fine");
  });

  test("a status of 400 or more is a result, not a throw, and the printed header says it", async () => {
    const t2 = setup({ names: { "a.example": ["93.184.216.34"] }, pages: { "a.example/gone": () => new Response("<p>No such page</p>", { status: 404, headers: { "content-type": "text/html" } }) } });
    const res = await t2.read("https://a.example/gone");
    expect(res.status).toBe(404);
    expect(res.text).toBe("No such page");
    expect(t2.r.text()).toContain("— 404 (an error page) text/html");
  });

  test("content types: text and JSON as they are, the page's charset honoured, entities decoded; anything else is an Error", async () => {
    const latin1 = Buffer.from("caf\xe9 cr\xe8me", "latin1");
    const t = setup({
      names: { "a.example": ["93.184.216.34"] },
      pages: {
        "a.example/data.json": () => new Response(JSON.stringify({ ok: true, items: [1, 2] }), { headers: { "content-type": "application/json" } }),
        "a.example/feed": () => new Response("<rss><item>x</item></rss>", { headers: { "content-type": "application/rss+xml" } }),
        "a.example/latin": () => new Response(latin1, { headers: { "content-type": "text/plain; charset=iso-8859-1" } }),
        "a.example/meta": () => new Response(Buffer.concat([Buffer.from('<html><head><meta charset="windows-1252"></head><body><p>'), latin1, Buffer.from("</p></body></html>")]), { headers: { "content-type": "text/html" } }),
        "a.example/img.png": () => new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), { headers: { "content-type": "image/png" } }),
        "a.example/none": () => new Response("<!DOCTYPE html><html><body><h2>Sniffed</h2></body></html>"),
      },
    });
    expect(JSON.parse((await t.read("https://a.example/data.json")).text)).toEqual({ ok: true, items: [1, 2] });
    expect((await t.read("https://a.example/feed")).text).toBe("<rss><item>x</item></rss>");
    expect((await t.read("https://a.example/latin")).text).toBe("café crème");
    expect((await t.read("https://a.example/meta")).text).toBe("café crème");
    const png = await failure(t.read("https://a.example/img.png"));
    expect(png.message).toBe("image/png is not text — open it with apps.open(url) or in a tab");
    expect((await t.read("https://a.example/none")).text).toBe("## Sniffed");
    expect(decodeNumericEntities("a&#8217;b &#x1F600; &#0; &#xD800; &#1114112;")).toBe("a’b \u{1F600} � � �");
  });

  test("the caps: 5 MiB off the wire, HTML converted from at most 1,048,576 characters, at most 1,048,576 returned — each says truncated", async () => {
    const big = "x".repeat(READ_MAX_BYTES + 4096);
    const t = setup({
      names: { "a.example": ["93.184.216.34"] },
      pages: {
        "a.example/huge.txt": () => new Response(big, { headers: { "content-type": "text/plain" } }),
        "a.example/long.html": () => html(`<p>${"word ".repeat(300_000)}</p>`),
        "a.example/ok.txt": () => new Response("short", { headers: { "content-type": "text/plain" } }),
      },
    });
    const huge = await t.read("https://a.example/huge.txt", { emit: false });
    expect(huge.truncated).toBe(true);
    expect(huge.text.length).toBe(READ_MAX_CHARS);
    expect(t.r.metric.bytes).toBe(READ_MAX_BYTES);
    const long = await t.read("https://a.example/long.html", { emit: false });
    expect(long.truncated).toBe(true);
    expect(long.text.length).toBeLessThanOrEqual(READ_MAX_CHARS);
    expect((await t.read("https://a.example/ok.txt", { emit: false })).truncated).toBe(false);
  });

  test("needsJs: an app shell, a script-only page and a noscript plea say so; an ordinary article does not", () => {
    expect(looksLikeItNeedsJs('<html><body><div id="root"></div><script src="/main.js"></script></body></html>', "")).toBe(true);
    expect(looksLikeItNeedsJs('<html><body><div id="__next"></div></body></html>', "")).toBe(true);
    expect(looksLikeItNeedsJs("<html><body><app-root></app-root></body></html>", "")).toBe(true);
    expect(looksLikeItNeedsJs('<html><body><script src="/x.js"></script><p>Loading…</p></body></html>', "Loading…")).toBe(true);
    expect(looksLikeItNeedsJs("<html><body><noscript>You need to enable JavaScript to run this app.</noscript><p>hi</p></body></html>", "hi")).toBe(true);
    expect(looksLikeItNeedsJs(ARTICLE, "x".repeat(2_500))).toBe(false);
    expect(looksLikeItNeedsJs('<div id="root"></div>', "y".repeat(500))).toBe(false);
    // Adversarial shapes stay fast.
    const t0 = performance.now();
    looksLikeItNeedsJs("<script".repeat(200_000) + "<noscript".repeat(100_000) + `<div id="root"${" ".repeat(100_000)}`, "");
    expect(performance.now() - t0).toBeLessThan(2_000);
  });

  test("the fence and the redaction: token-looking text and credential URL values never come back in clear", async () => {
    const t = setup({
      names: { "app.example": ["93.184.216.34"] },
      pages: { "app.example/cb?code=Zx81kQ2mPqLw&state=ok": () => html("<head><title>key sk-live0123456789abcdefABCDEF</title></head><h1>key sk-live0123456789abcdefABCDEF</h1><p>token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJl here</p>") },
    });
    const res = await t.read("https://app.example/cb?code=Zx81kQ2mPqLw&state=ok");
    expect(res.url).toBe("https://app.example/cb?code=<redacted>&state=ok");
    expect(res.text).toBe("# key <redacted>\ntoken <redacted> here");
    expect(res.title).toBe("key <redacted>");
    const out = t.r.text();
    for (const secret of ["Zx81kQ2mPqLw", "sk-live0123", "eyJhbGci"]) expect(out).not.toContain(secret);
    expect(out).toContain("<screen-data");
  });

  test("cancel and timeout: a run cancelled mid-read is Cancelled; a slow page times out within the script's time left", async () => {
    let unblock: (() => void) | undefined;
    const t = setup({
      names: { "slow.example": ["93.184.216.34"] },
      pages: { "slow.example/": () => new Promise<Response>((resolve) => { unblock = () => resolve(html("<p>late</p>")); }) },
    });
    const pending = t.read("https://slow.example/");
    await new Promise((r) => setTimeout(r, 20));
    t.r.abort.abort();
    expect(kind(await failure(pending))).toBe("Cancelled");
    unblock?.();
    const t2 = setup({ names: { "slow.example": ["93.184.216.34"] }, pages: { "slow.example/": () => new Promise<Response>(() => { /* never answers */ }) } });
    t2.r.scope.timeLeft = () => 60;
    const t0 = Date.now();
    const e = await failure(t2.read("https://slow.example/"));
    expect(e.message).toMatch(/timed out after \d+ s reading slow\.example/);
    expect(Date.now() - t0).toBeLessThan(1_000);
  });

  test(`at most ${READS_PER_SESSION} reads in flight per session and ${READS_PER_HOST} per host; identical reads in flight share one fetch`, async () => {
    let inFlight = 0;
    let peak = 0;
    const perHost = new Map<string, number>();
    let peakHost = 0;
    const page = (req: Sent) => new Promise<Response>((resolve) => {
      inFlight++; peak = Math.max(peak, inFlight);
      perHost.set(req.host, (perHost.get(req.host) ?? 0) + 1);
      peakHost = Math.max(peakHost, perHost.get(req.host)!);
      setTimeout(() => { inFlight--; perHost.set(req.host, perHost.get(req.host)! - 1); resolve(new Response("ok", { headers: { "content-type": "text/plain" } })); }, 15);
    });
    const names: Record<string, string[]> = {};
    const pages: Record<string, (req: Sent) => Promise<Response>> = {};
    for (let i = 0; i < 6; i++) { names[`h${i}.example`] = ["93.184.216.34"]; for (let j = 0; j < 4; j++) pages[`h${i}.example/p${j}`] = page; }
    const t = setup({ names, pages });
    await Promise.all(Object.keys(pages).map((k) => t.read(`https://${k}`, { emit: false })));
    expect(peak).toBe(READS_PER_SESSION);
    const one = setup({ names: { "one.example": ["93.184.216.34"] }, pages: Object.fromEntries(Array.from({ length: 10 }, (_, j) => [`one.example/p${j}`, page])) });
    peakHost = 0;
    await Promise.all(Array.from({ length: 10 }, (_, j) => one.read(`https://one.example/p${j}`, { emit: false })));
    expect(peakHost).toBe(READS_PER_HOST);
    const same = setup({ names: { "s.example": ["93.184.216.34"] }, pages: { "s.example/": page } });
    await Promise.all([same.read("https://s.example/", { emit: false }), same.read("https://s.example/", { emit: false }), same.read("https://s.example/", { emit: false })]);
    expect(same.sent.length).toBe(1);
  });

  test("telemetry and audit: backend http, the status and bytes — never the URL, its path or query; the final host in sites", async () => {
    const t = setup({ names: { "docs.example.com": ["93.184.216.34"] }, pages: { "docs.example.com/private/path?q=secret-query": () => html("<p>hello</p>") } });
    await t.read("https://docs.example.com/private/path?q=secret-query");
    expect(t.r.metric).toMatchObject({ backend: "http", httpStatus: 200 });
    expect(t.r.metric.bytes).toBeGreaterThan(0);
    const line = JSON.stringify(t.r.metric);
    for (const s of ["private/path", "secret-query", "docs.example.com"]) expect(line).not.toContain(s);
    expect([...t.r.sites]).toEqual(["docs.example.com"]);
    expect([...t.r.browsers]).toEqual(["http"]);
  });

  test("chat never reads; plan does (an observe primitive)", async () => {
    const chat = setup({ names: { "a.example": ["93.184.216.34"] }, pages: { "a.example/": () => html("<p>x</p>") } }, { facts: { mode: "chat", policy: "chat" } });
    expect(kind(await failure(chat.read("https://a.example/")))).toBe("NotAllowed");
    expect(chat.sent).toEqual([]);
  });

  test("the engine: browsers.read normalises the URL as browsers.open does and reaches the reader", async () => {
    const h = harness();
    const n = net({ names: { "docs.example.com": ["93.184.216.34"] }, pages: { "docs.example.com/x": () => html("<p>via the engine</p>") } });
    const engine = new BrowserEngine({ registry: new BrowserBackendRegistry(), mintWinterTab: () => "x", winterTabs: () => ({ tabs: [] }), sessionInfo: () => ({}), home: h.home, httpReader: new HttpReader(n.deps) });
    const r = h.run();
    const res = await engine.global(r.scope, "browsers.read", { url: "docs.example.com/x" }) as { url: string; text: string };
    expect(res).toMatchObject({ url: "https://docs.example.com/x", text: "via the engine" });
    expect(r.scope.metric.engineMs).toBeGreaterThanOrEqual(0);
    const js = await failure(engine.global(r.scope, "browsers.read", { url: "javascript:alert(1)" }));
    expect(kind(js)).toBe("NotAllowed");
    engine.stop();
  });
});

describe("the reader's address rule (web.ts, additive)", () => {
  test("loopback in every spelling; the LAN, link-local, CGNAT, ULA, unspecified and .local are private; public is neither", () => {
    for (const u of ["http://localhost/", "http://app.localhost:3000/", "http://127.0.0.1/", "http://127.9.9.9/", "http://[::1]/", "http://0177.0.0.1/", "http://[::ffff:127.0.0.1]/"]) {
      expect(addressClassOf(u)?.cls).toBe("loopback");
    }
    for (const u of ["http://10.0.0.1/", "http://010.0.0.1/", "http://192.168.0.1/", "http://172.31.255.255/", "http://169.254.1.1/", "http://100.100.0.1/",
      "http://[fc00::1]/", "http://[fe80::1]/", "http://0.0.0.0/", "http://[::]/", "http://nas.local/", "http://[::ffff:10.0.0.1]/"]) {
      expect(addressClassOf(u)?.cls).toBe("private");
    }
    expect(addressClassOf("https://example.com/")).toBeUndefined();
    expect(addressClassOf("https://8.8.8.8/")).toBeUndefined();
    expect(ipAddressClass("127.0.0.1")).toBe("loopback");
    expect(ipAddressClass("::1")).toBe("loopback");
    expect(ipAddressClass("10.2.3.4")).toBe("private");
    expect(ipAddressClass("fd12::9")).toBe("private");
    expect(ipAddressClass("93.184.216.34")).toBeNull();
    expect(ipAddressClass("2606:2800:220:1::")).toBeNull();
    expect(ipAddressClass("not an address")).toBe("private");
  });
});

// ── the real thing, on loopback only ─────────────────────────────────────────────────────────────────────────────

const servers: Array<{ stop(force?: boolean): void }> = [];
afterEach(() => { for (const s of servers.splice(0)) s.stop(true); });

function makeCert(): { cert: string; key: string } | undefined {
  const openssl = Bun.which("openssl");
  if (openssl === null) return undefined;
  const dir = mkdtempSync(join(tmpdir(), "winter-read-tls-"));
  try {
    execFileSync(openssl, ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem"), "-days", "1",
      "-subj", "/CN=docs.example.test", "-addext", "subjectAltName=DNS:docs.example.test"], { stdio: "ignore" });
    return { cert: readFileSync(join(dir, "cert.pem"), "utf8"), key: readFileSync(join(dir, "key.pem"), "utf8") };
  } catch { return undefined; }
}

describe("browsers.read on the real network stack (loopback)", () => {
  test("a pinned TLS connect: the URL carries the checked address, the certificate is verified against the original name", async () => {
    const pair = makeCert();
    if (pair === undefined) return; // no openssl: the pinned form is still covered by the fake-network tests
    let hostSeen: string | null = null;
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", tls: { cert: pair.cert, key: pair.key }, fetch(req) { hostSeen = req.headers.get("host"); return new Response("<h1>Over TLS</h1>", { headers: { "content-type": "text/html" } }); } });
    servers.push(server);
    const withCa = (ca: string) => async (url: string, init: Init) => await fetch(url, { ...init, tls: { ...init.tls, ca } } as RequestInit);
    const make = (serverNameOverride?: string) => new HttpReader({
      resolve: async () => ["127.0.0.1"],
      fetchFn: async (url, init) => withCa(pair.cert)(url, serverNameOverride === undefined ? init : { ...init, tls: { serverName: serverNameOverride } }),
    });
    const h = harness();
    const r = h.run();
    const policy = { approvals: new SiteApprovals(), site: {}, cwd: undefined };
    const res = await make().read(r.scope, `https://docs.example.test:${server.port}/`, { emit: false }, policy);
    expect(res.text).toBe("# Over TLS");
    expect(String(hostSeen)).toBe(`docs.example.test:${server.port}`);
    // The certificate is checked against the name it was asked for: another name is refused.
    const wrong = await failure(make("other.example.test").read(r.scope, `https://docs.example.test:${server.port}/`, { emit: false }, policy));
    expect(wrong.message).toContain("could not connect");
  });

  test("plain http to localhost with the system resolver and fetch: gzip decoded, a refused address skipped for the next", async () => {
    const server = Bun.serve({
      port: 0, hostname: "127.0.0.1",
      fetch(req) {
        if (new URL(req.url).pathname === "/gz") return new Response(Bun.gzipSync(Buffer.from("<p>squeezed</p>")), { headers: { "content-type": "text/html", "content-encoding": "gzip" } });
        return new Response("plain dev server", { headers: { "content-type": "text/plain" } });
      },
    });
    servers.push(server);
    const h = harness();
    const r = h.run();
    const policy = { approvals: new SiteApprovals(), site: {}, cwd: undefined };
    const reader = new HttpReader();
    expect((await reader.read(r.scope, `http://localhost:${server.port}/`, { emit: false }, policy)).text).toBe("plain dev server");
    expect((await reader.read(r.scope, `http://localhost:${server.port}/gz`, { emit: false }, policy)).text).toBe("squeezed");
    // ::1 first (nothing listens there), then 127.0.0.1.
    const fallback = new HttpReader({ resolve: async () => ["::1", "127.0.0.1"] });
    expect((await fallback.read(r.scope, `http://localhost:${server.port}/`, { emit: false }, policy)).text).toBe("plain dev server");
  });
});
