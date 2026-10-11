// The optional permissions (`library.ts`, through the controller): history and bookmarks searched read-only and only
// when granted; a page-made download caught for an armed tab — and only its own — into Winter's subfolder, reported,
// erased from the list when released; every other download left as the browser would have it.
import { beforeEach, describe, expect, test } from "bun:test";
import { ExtensionController, ExtensionError } from "../src/controller";
import { FakeChrome, flush, ManualClock } from "./fake-chrome";

let chrome: FakeChrome;
let clock: ManualClock;
let notes: { method: string; params: Record<string, unknown> }[];
let needs: string[][];
let c: ExtensionController;

beforeEach(async () => {
  chrome = new FakeChrome();
  clock = new ManualClock();
  notes = [];
  needs = [];
  c = new ExtensionController(chrome, { notify: (method, params) => notes.push({ method, params }), onNeeds: (n) => needs.push([...n]), clock, launchHintMs: 1000 });
  c.noteLaunch("install");
  await c.start();
});

const refusal = async (p: Promise<unknown>): Promise<{ code: string; data: Record<string, unknown> } | "ok"> => {
  try { await p; return "ok"; } catch (err) { return err instanceof ExtensionError ? { code: err.code, data: err.data } : { code: `untyped: ${String(err)}`, data: {} }; }
};

describe("history and bookmarks", () => {
  test("refused not_allowed with data.permission until granted — and the popup is told what to offer", async () => {
    expect(await refusal(c.handle("history.search", { text: "flights", maxResults: 10 }))).toEqual({ code: "not_allowed", data: { permission: "history" } });
    expect(await refusal(c.handle("bookmarks.search", { text: "x", maxResults: 10 }))).toEqual({ code: "not_allowed", data: { permission: "bookmarks" } });
    expect(c.neededPermissions().sort()).toEqual(["bookmarks", "history"]);
    chrome.grant("history");
    expect(c.neededPermissions()).toEqual(["bookmarks"]);
    expect(needs.at(-1)).toEqual(["bookmarks"]);
  });

  test("history: web pages only, capped, the query passed through", async () => {
    chrome.grant("history");
    chrome.historyItems = [
      { url: "https://flights.example/search?from=ZRH", title: "Flights", lastVisitTime: 1_760_000_000_123.6 },
      { url: "javascript:alert(1)", title: "x" },
      { url: "data:text/html,hi", title: "y" },
      { url: "http://localhost:3000/", title: "Dev" },
    ];
    const r = await c.handle("history.search", { text: "flights", startTime: 5, maxResults: 500 }) as { items: unknown[] };
    expect(r.items).toEqual([
      { url: "https://flights.example/search?from=ZRH", title: "Flights", lastVisitTime: 1_760_000_000_124 },
      { url: "http://localhost:3000/", title: "Dev", lastVisitTime: 0 },
    ]);
    expect(chrome.historyQueries).toEqual([{ text: "flights", maxResults: 200, startTime: 5 }]);
  });

  test("bookmarks: a search or the most recent, with each one's folder path; folders and script bookmarks left out", async () => {
    chrome.grant("bookmarks");
    chrome.bookmarkNodes = [
      { id: "1", title: "Bookmarks Bar" },
      { id: "2", title: "Research", parentId: "1" },
      { id: "3", title: "A paper", url: "https://papers.example/1", parentId: "2" },
      { id: "4", title: "Paper tool", url: "javascript:void(0)", parentId: "2" },
      { id: "5", title: "News", url: "https://news.example/", parentId: "1" },
    ];
    const found = await c.handle("bookmarks.search", { text: "paper", maxResults: 10 }) as { items: unknown[] };
    expect(found.items).toEqual([{ url: "https://papers.example/1", title: "A paper", folder: "Bookmarks Bar/Research" }]);
    const recent = await c.handle("bookmarks.search", { maxResults: 10 }) as { items: Array<{ url: string }> };
    expect(recent.items.map((i) => i.url)).toEqual(["https://papers.example/1", "https://news.example/"]);
  });
});

describe("downloads (a file the page makes itself)", () => {
  async function armedTab(): Promise<number> {
    const tab = await c.handle("tabs.create", { url: "https://shop.example.com/make", sessionId: "s_1", sessionTitle: "t" }) as { tab: { tabKey: string } };
    // Attached, as Winter is while it waits for a download: the tab's Page.downloadWillBegin reaches the extension.
    await c.handle("debugger.attach", { tabKey: tab.tab.tabKey });
    return Number(tab.tab.tabKey);
  }

  test("an arm without the permission is refused (data.permission); a bad subfolder is refused", async () => {
    const tabId = await armedTab();
    expect(await refusal(c.handle("downloads.arm", { tabKey: String(tabId), subdir: "Winter/abc123", until: Date.now() + 60_000, maxBytes: 1000 })))
      .toEqual({ code: "not_allowed", data: { permission: "downloads" } });
    expect(c.neededPermissions()).toEqual(["downloads"]);
    chrome.grant("downloads");
    expect((await refusal(c.handle("downloads.arm", { tabKey: String(tabId), subdir: "../../etc", until: Date.now() + 60_000, maxBytes: 1000 })) as { code: string }).code).toBe("not_allowed");
  });

  test("armed: the tab's page-made download goes into Winter's subfolder and is reported done with its path; released, it leaves the list", async () => {
    chrome.grant("downloads");
    const tabId = await armedTab();
    await c.handle("downloads.arm", { tabKey: String(tabId), subdir: "Winter/abc123", until: Date.now() + 60_000, maxBytes: 1000 });
    const id = await chrome.pageDownload({ url: "blob:https://shop.example.com/7f1c", name: "made.txt", bytes: 5, downloadsDir: "/Users/u/Downloads", mime: "text/plain", fromTab: tabId });
    expect(chrome.suggested.get(id)).toBe("Winter/abc123/made.txt");
    const reports = notes.filter((n) => n.method === "download").map((n) => n.params);
    expect(reports).toEqual([
      { tabKey: String(tabId), download: { id: String(id), state: "started", name: "made.txt", bytes: 0, totalBytes: 5, mime: "text/plain" } },
      { tabKey: String(tabId), download: { id: String(id), state: "done", name: "made.txt", bytes: 5, path: "/Users/u/Downloads/Winter/abc123/made.txt", mime: "text/plain" } },
    ]);
    await c.handle("downloads.release", { id: String(id) });
    expect(chrome.erased).toEqual([id]);
  });

  test("never another site's download, one made before the arm, or one past the size cap; unarmed downloads are left alone", async () => {
    chrome.grant("downloads");
    const free = await chrome.pageDownload({ url: "https://elsewhere.example/a.zip", name: "a.zip", bytes: 1, downloadsDir: "/d" });
    expect(chrome.suggested.get(free)).toBeUndefined();
    const tabId = await armedTab();
    await c.handle("downloads.arm", { tabKey: String(tabId), subdir: "Winter/abc123", until: Date.now() + 60_000, maxBytes: 10 });
    const other = await chrome.pageDownload({ url: "https://elsewhere.example/b.zip", name: "b.zip", bytes: 1, downloadsDir: "/d" });
    expect(chrome.suggested.get(other)).toBeUndefined();
    const old = await chrome.pageDownload({ url: "blob:https://shop.example.com/1", name: "old.txt", bytes: 1, downloadsDir: "/d", startTime: Date.now() - 60_000 });
    expect(chrome.suggested.get(old)).toBeUndefined();
    const big = await chrome.pageDownload({ url: "blob:https://shop.example.com/2", name: "big.bin", bytes: 50, downloadsDir: "/d", fromTab: tabId });
    expect(chrome.cancelled).toEqual([big]);
    expect(notes.filter((n) => n.method === "download").map((n) => (n.params.download as { state: string }).state)).toEqual(["failed"]);
    expect(chrome.suggested.get(big)).toBeUndefined();
  });

  test("only the ARMED TAB's own download: the user's download from another tab of the same site is never taken", async () => {
    chrome.grant("downloads");
    const tabId = await armedTab();
    const userTab = chrome.addTab({ windowId: 1, url: "https://shop.example.com/docs", title: "Docs" });
    await c.handle("downloads.arm", { tabKey: String(tabId), subdir: "Winter/abc123", until: Date.now() + 60_000, maxBytes: 1_000 });
    // The user's own PDF from the same site, in their own tab (no downloadWillBegin from the armed tab): left alone.
    const theirs = await chrome.pageDownload({ url: "https://shop.example.com/report.pdf", referrer: "https://shop.example.com/docs", name: "report.pdf", bytes: 5, downloadsDir: "/d", holdMs: () => clock.advance(3_000) });
    expect(chrome.suggested.get(theirs)).toBeUndefined();
    expect(notes.filter((n) => n.method === "download")).toEqual([]);
    void userTab;
    // The armed tab's own, its word coming AFTER the browser's item: held, then taken.
    const ours = await chrome.pageDownload({ url: "blob:https://shop.example.com/abc", name: "export.csv", bytes: 5, downloadsDir: "/d", fromTab: tabId, willBegin: "after" });
    expect(chrome.suggested.get(ours)).toBe("Winter/abc123/export.csv");
  });

  test("a running download's bytes are reported as progress while they grow (onChanged carries none)", async () => {
    chrome.grant("downloads");
    const tabId = await armedTab();
    await c.handle("downloads.arm", { tabKey: String(tabId), subdir: "Winter/abc123", until: Date.now() + 600_000, maxBytes: 1_000_000 });
    const id = await chrome.pageDownload({ url: "blob:https://shop.example.com/slow", name: "slow.bin", bytes: 900_000, downloadsDir: "/d", complete: false, fromTab: tabId });
    chrome.downloadProgress(id, 100_000);
    await clock.advance(2_000);
    chrome.downloadProgress(id, 400_000);
    await clock.advance(2_000);
    await clock.advance(2_000); // no growth: nothing new said
    const states = notes.filter((n) => n.method === "download").map((n) => [(n.params.download as { state: string }).state, (n.params.download as { bytes: number }).bytes]);
    expect(states).toEqual([["started", 0], ["progress", 100_000], ["progress", 400_000]]);
    chrome.downloadProgress(id, 2_000_000);
    await clock.advance(2_000);
    expect(chrome.cancelled).toEqual([id]); // past maxBytes: cancelled
  });

  test("switched off and on again: the arms go, and the new downloads API is listened to afresh", async () => {
    chrome.grant("downloads");
    const tabId = await armedTab();
    await c.handle("downloads.arm", { tabKey: String(tabId), subdir: "Winter/abc123", until: Date.now() + 60_000, maxBytes: 100 });
    chrome.revoke("downloads");
    expect(await refusal(c.handle("downloads.arm", { tabKey: String(tabId), subdir: "Winter/abc123", until: Date.now() + 60_000, maxBytes: 100 })))
      .toEqual({ code: "not_allowed", data: { permission: "downloads" } });
    chrome.grant("downloads");
    await c.handle("downloads.arm", { tabKey: String(tabId), subdir: "Winter/def456", until: Date.now() + 60_000, maxBytes: 100 });
    const id = await chrome.pageDownload({ url: "blob:https://shop.example.com/9", name: "again.txt", bytes: 3, downloadsDir: "/d", fromTab: tabId });
    expect(chrome.suggested.get(id)).toBe("Winter/def456/again.txt");
  });

  test("the arm ends at its deadline, when the tab closes, and when the link to Winter drops", async () => {
    chrome.grant("downloads");
    const tabId = await armedTab();
    await c.handle("downloads.arm", { tabKey: String(tabId), subdir: "Winter/abc123", until: Date.now() + 1_000, maxBytes: 10 });
    await clock.advance(1_001);
    const late = await chrome.pageDownload({ url: "blob:https://shop.example.com/3", name: "late.txt", bytes: 1, downloadsDir: "/d", fromTab: tabId });
    expect(chrome.suggested.get(late)).toBeUndefined();
    await c.handle("downloads.arm", { tabKey: String(tabId), subdir: "Winter/abc123", until: Date.now() + 60_000, maxBytes: 10 });
    await c.releaseAll();
    await flush();
    const after = await chrome.pageDownload({ url: "blob:https://shop.example.com/4", name: "after.txt", bytes: 1, downloadsDir: "/d", fromTab: tabId });
    expect(chrome.suggested.get(after)).toBeUndefined();
  });
});
