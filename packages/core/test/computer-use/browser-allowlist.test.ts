// ComputerV2 — the two PINNED browser files (`cdp-allowlist.ts`, `transport.ts`): what they promise, as tests. The
// allowlist is the extension's store justification as much as a guard, so these pin its shape: what may cross, what
// never does, and the caps the transports enforce.
import { describe, expect, test } from "bun:test";
import {
  CDP_ALLOWED_EVENTS, CDP_ALLOWED_METHODS, CDP_EVENT_ARRAY_MAX, CDP_EVENT_PARAMS, CDP_EVENT_STRING_MAX, CDP_FETCH_RESPONSE_HEADERS,
  CDP_IO_READ_MAX, CDP_NETWORK_BUFFER_MAX, CDP_NETWORK_EVENT_PARAMS, CDP_RESPONSE_BODY_MAX_CHARS, CDP_WORLD_NAME,
} from "../../src/computer-use/browser/cdp-allowlist";
import { BROWSER_FAMILIES, familyInfo, familyName } from "../../src/computer-use/browser/families";
import { TransportError, type CdpTransport, type TransportDownload, type TransportTab } from "../../src/computer-use/browser/transport";

describe("cdp-allowlist.ts", () => {
  test("no duplicates; the world is named winter", () => {
    expect(new Set(CDP_ALLOWED_METHODS).size).toBe(CDP_ALLOWED_METHODS.length);
    expect(new Set(CDP_ALLOWED_EVENTS).size).toBe(CDP_ALLOWED_EVENTS.length);
    expect(CDP_WORLD_NAME).toBe("winter");
  });

  test("Phase 3's methods and events are on it", () => {
    for (const m of ["Log.enable", "Log.disable", "Network.getResponseBody", "Fetch.enable", "Fetch.disable", "Fetch.continueRequest",
      "Fetch.failRequest", "Fetch.takeResponseBodyAsStream", "IO.read", "IO.close", "Emulation.setDeviceMetricsOverride",
      "Emulation.clearDeviceMetricsOverride"]) expect(CDP_ALLOWED_METHODS).toContain(m);
    for (const e of ["Runtime.consoleAPICalled", "Runtime.exceptionThrown", "Log.entryAdded", "Network.responseReceived",
      "Fetch.requestPaused", "Page.downloadWillBegin"]) expect(CDP_ALLOWED_EVENTS).toContain(e);
  });

  test("what is never on it: cookies, storage, post data, header events, writing a page, the browser target, page objects", () => {
    for (const m of ["Network.getCookies", "Network.getAllCookies", "Network.setCookie", "Network.getRequestPostData", "Storage.getCookies",
      "Fetch.fulfillRequest", "Fetch.continueWithAuth", "Fetch.getResponseBody", "Fetch.continueResponse", "IO.resolveBlob",
      "Runtime.getProperties", "Runtime.compileScript", "Page.addScriptToEvaluateOnNewDocument", "Page.setDownloadBehavior"]) {
      expect(CDP_ALLOWED_METHODS).not.toContain(m);
    }
    expect(CDP_ALLOWED_METHODS.filter((m) => /^(Browser|Storage|SystemInfo|Tethering)\./.test(m))).toEqual([]);
    expect(CDP_ALLOWED_EVENTS.filter((e) => /ExtraInfo$/.test(e))).toEqual([]);
  });

  test("every reduced event is allowlisted; every allowlisted Network event is reduced and keeps the idle params", () => {
    for (const e of Object.keys(CDP_EVENT_PARAMS)) expect(CDP_ALLOWED_EVENTS).toContain(e);
    for (const e of CDP_ALLOWED_EVENTS.filter((x) => x.startsWith("Network."))) {
      const paths = CDP_EVENT_PARAMS[e];
      expect(paths).toBeDefined();
      for (const p of CDP_NETWORK_EVENT_PARAMS) expect(paths).toContain(p);
    }
    // The page-data events are reduced too: nothing of them leaves whole.
    for (const e of ["Runtime.consoleAPICalled", "Runtime.exceptionThrown", "Log.entryAdded", "Fetch.requestPaused", "Page.downloadWillBegin"]) {
      expect(CDP_EVENT_PARAMS[e]).toBeDefined();
    }
  });

  test("no path names a header, a cookie, post data or a page object (Fetch's response headers go through the name filter)", () => {
    for (const [event, paths] of Object.entries(CDP_EVENT_PARAMS)) {
      for (const p of paths) {
        expect(p).toMatch(/^[A-Za-z]+(\[\])?(\.[A-Za-z]+(\[\])?)*$/);
        if (event === "Fetch.requestPaused" && p.startsWith("responseHeaders[].")) continue;
        expect(p.toLowerCase()).not.toMatch(/header|cookie|postdata|objectid|preview|custompreview|securitydetails/);
      }
    }
    expect(CDP_EVENT_PARAMS["Fetch.requestPaused"]).not.toContain("request.headers");
  });

  test("Fetch's header filter keeps a download's type, name and size only — never Set-Cookie", () => {
    expect([...CDP_FETCH_RESPONSE_HEADERS].sort()).toEqual(["content-disposition", "content-length", "content-type"]);
    for (const h of CDP_FETCH_RESPONSE_HEADERS) expect(h).toBe(h.toLowerCase());
    expect(CDP_FETCH_RESPONSE_HEADERS).not.toContain("set-cookie");
  });

  test("the caps", () => {
    expect(CDP_EVENT_STRING_MAX).toBe(4096);
    expect(CDP_EVENT_ARRAY_MAX).toBe(32);
    expect(CDP_NETWORK_BUFFER_MAX).toEqual({ resource: 1_048_576, total: 8_388_608 });
    expect(CDP_RESPONSE_BODY_MAX_CHARS).toBe(1_048_576);
    expect(CDP_IO_READ_MAX).toBe(1_048_576);
  });
});

describe("transport.ts", () => {
  test("a Phase 2 transport (no optional member) is still a CdpTransport; the Phase 3 shapes", () => {
    const none = (): (() => void) => () => undefined;
    const phase2: CdpTransport = {
      backend: "chrome", family: "chrome", connected: true,
      createTab: async () => ({ tabKey: "1", url: "about:blank", title: "", active: false, agent: true }),
      closeTab: async () => undefined, keepTab: async () => undefined, listTabs: async () => [],
      attach: async () => ({ viewport: [800, 600], dpr: 2 }), detach: async () => undefined,
      send: async <T>() => ({}) as T, subscribe: async () => undefined,
      onEvent: none, onTabGone: none, overlay: () => undefined, onStop: none,
    };
    expect(phase2.present).toBeUndefined();
    expect(phase2.armDownloads).toBeUndefined();
    const tab: TransportTab = { tabKey: "7", url: "https://example.com/", title: "x", active: true, agent: false, lastAccessed: 1, group: "Research", windowId: 3 };
    expect(tab.group).toBe("Research");
    const d: TransportDownload = { id: "4", state: "done", name: "report.csv", path: "/tmp/x/report.csv", bytes: 12, mime: "text/csv" };
    expect(d.state).toBe("done");
  });

  test("Phase 4: the headless family, createTab's engine, and the capacity code", async () => {
    const none = (): (() => void) => () => undefined;
    const seen: Array<string | undefined> = [];
    const headless: CdpTransport = {
      backend: "headless", family: "headless", connected: true,
      createTab: async (o) => { seen.push(o.engine); return { tabKey: "w-1", url: o.url, title: "", active: false, agent: true, sessionId: o.sessionId }; },
      closeTab: async () => undefined, keepTab: async () => undefined, listTabs: async () => [],
      attach: async () => ({ viewport: [1280, 800], dpr: 1 }), detach: async () => undefined,
      send: async <T>() => ({}) as T, subscribe: async () => undefined,
      onEvent: none, onTabGone: none, overlay: () => undefined, onStop: none,
    };
    await headless.createTab({ sessionId: "s_1", url: "about:blank" });
    await headless.createTab({ sessionId: "s_1", url: "about:blank", engine: "chrome" });
    expect(seen).toEqual([undefined, "chrome"]);
    const full = new TransportError("capacity", "the headless browser's tab budget is spent — close tabs first");
    expect(full.code).toBe("capacity");
    expect(familyName("headless")).toBe("Winter (headless)");
    expect(familyInfo("headless")?.bundleIds).toEqual([]);
    expect(BROWSER_FAMILIES.map((f) => f.family).slice(0, 2)).toEqual(["winter", "headless"]);
  });
});
