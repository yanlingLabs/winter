// ComputerV2 Phase 3 — a tab's developer readers: console(), network(), networkBody(id). The log and its rendering
// (`devtools.ts`), the body redaction (`body-redact.ts`), and the engine's members over the fake transport (which
// reduces events as every real transport does).
import { describe, expect, test } from "bun:test";
import { redactBody, SECRET_KEY, isTextMime } from "../../src/computer-use/browser/body-redact";
import { renderConsoleArgs, TabDevtools, consoleLine, requestLine } from "../../src/computer-use/browser/devtools";
import { PHASE3_TAB_EVENTS } from "../../src/computer-use/browser/tab-driver";
import type { AutomationFailure } from "../../src/computer-use/errors";
import type { TabHandle } from "../../src/computer-use/worker/bridge";
import type { FakePage } from "./browser-fake-transport";
import { harness } from "./browser-harness";

const PAGE: FakePage = { url: "https://app.example.com/", title: "App", nodes: [{ id: 1, role: "main", children: [{ id: 2, role: "heading", name: "Hi", level: 1 }] }] };

const s = (value: string) => ({ type: "string", value });

describe("console log", () => {
  test("format specifiers, primitives by value, objects by description; %c styles vanish", () => {
    expect(renderConsoleArgs([s("count %d of %s%c!"), { type: "number", value: 3.7 }, s("ten"), s("color:red")])).toBe("count 3 of ten!");
    expect(renderConsoleArgs([s("x"), { type: "object", className: "Object", description: "Object" }, { type: "undefined" }, { type: "object", subtype: "null", value: null }])).toBe("x Object undefined null");
    expect(renderConsoleArgs([{ type: "bigint", unserializableValue: "12n" }])).toBe("12n");
  });

  test("levels, sources (1-based), the engine's own world dropped, a re-attach's replay de-duplicated, a new page said", () => {
    const d = new TabDevtools(() => 1_000);
    const call = { type: "error", timestamp: 1791726519475, executionContextId: 1, args: [s("boom")], stackTrace: { callFrames: [{ url: "https://app.example.com/a.js?token=abc", lineNumber: 7, columnNumber: 25 }] } };
    d.onEvent("Runtime.consoleAPICalled", call, undefined, () => false);
    d.onEvent("Runtime.consoleAPICalled", call, undefined, () => false); // replayed after a re-attach
    d.onEvent("Runtime.consoleAPICalled", { ...call, executionContextId: 9, args: [s("winter's own")] }, undefined, (id) => id === 9);
    d.onEvent("Runtime.exceptionThrown", { timestamp: 2, exceptionDetails: { text: "Uncaught", url: "https://app.example.com/", lineNumber: 0, columnNumber: 3, exception: { description: "Error: oops\n    at x" } } }, undefined, () => false);
    d.onEvent("Log.entryAdded", { entry: { source: "network", level: "error", text: "Failed to load resource: 404", url: "https://app.example.com/x.png", timestamp: 3 } }, undefined, () => false);
    d.newPage("https://app.example.com/next");
    d.onEvent("Runtime.consoleAPICalled", { type: "warning", timestamp: 4, args: [s("careful")] }, undefined, () => false);
    const all = d.console();
    expect(all.entries.map((e) => e.level)).toEqual(["error", "error", "error", "page", "warning"]);
    expect(all.entries[0]).toMatchObject({ text: "boom" });
    expect(all.entries[0]!.source).toBe("https://app.example.com/a.js?token=<redacted>:8:26");
    expect(all.entries[1]!.text).toBe("Uncaught Error: oops\n    at x");
    expect(all.entries[2]!.text).toBe("[network] Failed to load resource: 404");
    expect(all.counts).toEqual({ error: 3, warning: 1 });
    expect(d.console({ levels: ["warning"] }).entries.map((e) => e.text)).toEqual(["careful"]);
    expect(d.console({ filter: "404" }).entries).toHaveLength(1);
    expect(d.console({ limit: 2 }).entries.map((e) => e.level)).toEqual(["page", "warning"]);
    expect(consoleLine(all.entries[2]!)).toMatch(/^\[error\] \d\d:\d\d:\d\d\.\d{3} \[network\] Failed to load resource: 404 — https:\/\/app\.example\.com\/x\.png$/);
    d.clearConsole();
    expect(d.console().entries).toEqual([]);
  });

  test("token-looking text is redacted; a long message is cut", () => {
    const d = new TabDevtools();
    d.onEvent("Runtime.consoleAPICalled", { type: "log", timestamp: 1, args: [s("key sk-abcdefghijklmnopqrstuvwxyz0123456789 " + "y".repeat(3_000))] }, undefined, () => false);
    const [e] = d.console().entries;
    expect(e!.text).not.toContain("sk-abcdefghijklmnopqrstuvwxyz0123456789");
    expect(e!.text.length).toBeLessThanOrEqual(2_001);
  });
});

describe("network log", () => {
  test("a request's method, URL, status, type, timing and size; redirects are hops; failures and filters", () => {
    const d = new TabDevtools();
    d.onEvent("Network.requestWillBeSent", { requestId: "1", timestamp: 10, wallTime: 1791726519, type: "Document", request: { url: "https://app.example.com/login?code=SECRET", method: "GET" } }, undefined, () => false);
    d.onEvent("Network.requestWillBeSent", { requestId: "1", timestamp: 10.05, type: "Document", request: { url: "https://app.example.com/home", method: "GET" }, redirectResponse: { status: 302 } }, undefined, () => false);
    d.onEvent("Network.responseReceived", { requestId: "1", timestamp: 10.1, type: "Document", response: { url: "https://app.example.com/home", status: 200, mimeType: "text/html" } }, undefined, () => false);
    d.onEvent("Network.loadingFinished", { requestId: "1", timestamp: 10.2, encodedDataLength: 2048 }, undefined, () => false);
    d.onEvent("Network.requestWillBeSent", { requestId: "2", timestamp: 11, type: "XHR", request: { url: "https://api.example.com/items", method: "POST" } }, "child", () => false);
    d.onEvent("Network.responseReceived", { requestId: "2", timestamp: 11.2, type: "XHR", response: { status: 500, mimeType: "application/json" } }, "child", () => false);
    d.onEvent("Network.loadingFinished", { requestId: "2", timestamp: 11.3, encodedDataLength: 40 }, "child", () => false);
    d.onEvent("Network.requestWillBeSent", { requestId: "3", timestamp: 12, type: "Image", request: { url: "https://cdn.example.com/x.png", method: "GET" } }, undefined, () => false);
    d.onEvent("Network.loadingFailed", { requestId: "3", timestamp: 12.1, type: "Image", errorText: "net::ERR_BLOCKED_BY_CLIENT", canceled: false, blockedReason: "inspector" }, undefined, () => false);
    const all = d.network().entries;
    expect(all.map((r) => [r.id, r.status, r.type])).toEqual([["r1", 302, "document"], ["r2", 200, "document"], ["r3", 500, "xhr"], ["r4", undefined, "image"]]);
    expect(all[0]!.url).toBe("https://app.example.com/login?code=<redacted>");
    expect(all[1]).toMatchObject({ ms: 150, bytes: 2048, mime: "text/html" });
    expect(all[3]!.failed).toBe("net::ERR_BLOCKED_BY_CLIENT (blocked: inspector)");
    expect(d.network({ failed: true }).entries.map((r) => r.id)).toEqual(["r3", "r4"]);
    expect(d.network({ types: ["xhr"] }).entries.map((r) => r.id)).toEqual(["r3"]);
    expect(d.network({ filter: "CDN" }).entries.map((r) => r.id)).toEqual(["r4"]);
    expect(d.request("r3")).toMatchObject({ session: "child", requestId: "2", done: true });
    expect(requestLine(all[1]!)).toBe("r2 GET 200 document 150 ms 2.0 KB https://app.example.com/home");
    expect(requestLine(all[3]!)).toContain("failed (net::ERR_BLOCKED_BY_CLIENT");
  });
});

describe("body redaction", () => {
  test("JSON values under secret keys at any depth, tokens anywhere; ordinary keys kept", () => {
    const body = JSON.stringify({ access_token: "abc", user: { name: "Ann", author: "Bo", password: "hunter2", sessionId: "x1", nested: [{ apiKey: "k", note: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJlLXZhbHVlLWhlcmU" }] } });
    const r = redactBody(body, "application/json", 64_000);
    expect(r.text).not.toContain("abc");
    expect(r.text).not.toContain("hunter2");
    expect(r.text).not.toContain("x1");
    expect(r.text).not.toContain('"k"');
    expect(r.text).not.toContain("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0");
    expect(r.text).toContain('"author": "Bo"');
    expect(r.text).toContain('"name": "Ann"');
  });

  test("forms and key: value text; a cut is said", () => {
    expect(redactBody("user=ann&password=hunter2&next=%2F", "application/x-www-form-urlencoded", 1000).text).toBe("user=ann&password=<redacted>&next=%2F");
    expect(redactBody("token: abc123\nname: Ann", "text/plain", 1000).text).toBe("token: <redacted>\nname: Ann");
    const r = redactBody("word ".repeat(20), "text/plain", 10);
    expect(r).toEqual({ text: "word word ", cut: true });
  });

  test("the secret-key rule and text MIME types", () => {
    for (const k of ["password", "Password", "access_token", "refreshToken", "api_key", "apiKey", "client_secret", "Authorization", "session_id", "cookie", "csrfToken", "pin"]) expect({ k, m: SECRET_KEY.test(k) }).toEqual({ k, m: true });
    for (const k of ["author", "name", "spinner", "tokenizer_version", "description", "id"]) expect({ k, m: SECRET_KEY.test(k) }).toEqual({ k, m: false });
    for (const m of ["text/html", "application/json", "application/ld+json", "application/xml", "image/svg+xml", "application/javascript"]) expect(isTextMime(m)).toBe(true);
    for (const m of ["image/png", "application/pdf", "font/woff2", undefined]) expect(isTextMime(m)).toBe(false);
  });
});

describe("console(), network(), networkBody() on a tab", () => {
  async function opened() {
    const h = harness();
    h.winter.pages[PAGE.url] = PAGE;
    const r = h.run();
    const handle = await h.engine.global(r.scope, "browsers.open", { url: PAGE.url }) as TabHandle;
    r.end();
    const key = handle.id.slice("winter:".length);
    /** One primitive in its own run (each run holds the tab's lock until it ends). */
    const call = async (primitive: string, args: Record<string, unknown>): Promise<{ value: unknown; text: string }> => {
      const run = h.run();
      try { return { value: await h.engine.primitive(run.scope, handle.targetId, primitive, args), text: run.text() }; } finally { run.end(); }
    };
    return { h, handle, key, call };
  }

  test("console() prints fenced lines and a count; the events reached it reduced (no page objects)", async () => {
    const { h, key, call } = await opened();
    h.winter.pageEvent(key, "Runtime.consoleAPICalled", { type: "error", timestamp: 1791726519475, executionContextId: 1, args: [s("failed:"), { type: "object", className: "Error", description: "TypeError: x is undefined", objectId: "-1.1.1" }] });
    h.winter.pageEvent(key, "Runtime.consoleAPICalled", { type: "log", timestamp: 1791726519476, args: [s("ready")] });
    const { value, text } = await call("console", {});
    const entries = value as Array<{ level: string; text: string }>;
    expect(entries.map((e) => [e.level, e.text])).toEqual([["error", "failed: TypeError: x is undefined"], ["log", "ready"]]);
    expect(text).toMatch(/<screen-data id="[0-9a-f]+">\nconsole of Tab "App": 1 error, 1 log/);
    expect(text).toContain("failed: TypeError: x is undefined");
    expect((await call("console", { levels: ["error"], emit: false })).value).toHaveLength(1);
    await expect(call("console", { levels: ["fatal"] })).rejects.toThrow(/levels are error, warning, info, log, debug/);
  });

  test("network() lists requests; networkBody(id) reads a body redacted, refuses a binary one, says when none is kept", async () => {
    const { h, key, call } = await opened();
    h.winter.pageEvent(key, "Network.requestWillBeSent", { requestId: "7", timestamp: 1, type: "Fetch", request: { url: "https://api.example.com/me", method: "GET", headers: { Cookie: "sid=1" } } });
    h.winter.pageEvent(key, "Network.responseReceived", { requestId: "7", timestamp: 1.02, type: "Fetch", response: { url: "https://api.example.com/me", status: 200, mimeType: "application/json", headers: { "set-cookie": "sid=2" } } });
    h.winter.pageEvent(key, "Network.loadingFinished", { requestId: "7", timestamp: 1.03, encodedDataLength: 77 });
    h.winter.keepBody(key, "7", JSON.stringify({ name: "Ann", token: "tok_123" }));
    h.winter.pageEvent(key, "Network.requestWillBeSent", { requestId: "8", timestamp: 2, type: "Image", request: { url: "https://cdn.example.com/a.png", method: "GET" } });
    h.winter.pageEvent(key, "Network.responseReceived", { requestId: "8", timestamp: 2.1, type: "Image", response: { status: 200, mimeType: "image/png" } });
    h.winter.pageEvent(key, "Network.loadingFinished", { requestId: "8", timestamp: 2.2, encodedDataLength: 9000 });
    h.winter.keepBody(key, "8", "iVBORw0KGgo=", true);
    h.winter.pageEvent(key, "Network.requestWillBeSent", { requestId: "9", timestamp: 3, type: "XHR", request: { url: "https://api.example.com/gone", method: "GET" } });
    h.winter.pageEvent(key, "Network.loadingFinished", { requestId: "9", timestamp: 3.1, encodedDataLength: 1 });
    const net = await call("network", { types: ["fetch", "image", "xhr"] });
    const rows = net.value as Array<{ id: string; status?: number }>;
    expect(rows.map((x) => x.status)).toEqual([200, 200, undefined]);
    expect(net.text).toContain("GET 200 fetch 30 ms 77 B https://api.example.com/me");
    expect(net.text).not.toContain("sid=");
    const body = (await call("networkBody", { id: rows[0]!.id })).value as string;
    expect(body).toContain('"name": "Ann"');
    expect(body).not.toContain("tok_123");
    expect((await call("networkBody", { id: rows[1]!.id })).value).toMatch(/^\(binary, 9 B, image\/png\) — save it with download/);
    await expect(call("networkBody", { id: rows[2]!.id })).rejects.toThrow(/no longer keeps that response's body/);
    await expect(call("networkBody", { id: "r999" })).rejects.toThrow(/no request r999/);
    // The driver asked the browser to keep bodies — capped, and never a request body.
    const tab = h.winter.tabs.get(key)!;
    expect(tab.networkBuffers).toEqual({ resource: 1_048_576, total: 8_388_608 });
  });
});

describe("a Winter for Chrome built before Phase 3 (its hello names no cdp3)", () => {
  test("still drives tabs — subscribed to Phase 2's events only, no Log.enable — and the members that need Phase 3's CDP say to update it", async () => {
    const h = harness();
    h.chrome.features = new Set(["mute"]);
    const r = h.run();
    const tab = await h.engine.global(r.scope, "browsers.open", { url: "https://a.example/", browser: "chrome" }) as TabHandle;
    const fake = h.chrome.tabs.get(tab.id.split(":")[1]!)!;
    for (const e of PHASE3_TAB_EVENTS) expect(fake.subscribed).not.toContain(e);
    expect(fake.subscribed).toContain("Network.requestWillBeSent");
    expect(h.chrome.sent.some((x) => x.method === "Log.enable")).toBe(false);
    await h.engine.primitive(r.scope, tab.targetId, "state", { emit: false });
    for (const [primitive, args] of [["console", {}], ["network", {}], ["networkBody", { id: "1" }], ["viewport", { size: { width: 400, height: 800 } }]] as const) {
      const e = await h.engine.primitive(r.scope, tab.targetId, primitive, args).then(() => undefined, (err: unknown) => err as AutomationFailure);
      expect({ primitive, kind: e?.kind, message: e?.message }).toEqual({ primitive, kind: "BrowserUnavailable", message: `the Winter for Chrome in Google Chrome is too old for ${primitive}() — ask the user to update it` });
    }
    r.end();
  });
});
