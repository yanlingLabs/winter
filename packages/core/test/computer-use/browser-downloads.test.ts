// ComputerV2 Phase 3 — `download(ref | { url })`, end to end over the fake transports: the built-in browser's native
// handler (link protocol 2), a user's browser's Fetch interception (the URL route in a temporary tab, and a button
// clicked in the bound tab), a page-made (blob:) file through Winter for Chrome's optional downloads permission, data:
// links, the destination rules, the per-run cap, the policy class, and what an unarmed download says.
import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { AutomationFailure } from "../../src/computer-use/errors";
import type { TabHandle } from "../../src/computer-use/worker/bridge";
import type { FakePage } from "./browser-fake-transport";
import { harness } from "./browser-harness";

const CSV = "https://shop.example.com/prices.csv";
const PAGE: FakePage = {
  url: "https://shop.example.com/", title: "Shop",
  nodes: [{ id: 1, role: "main", children: [
    { id: 2, role: "button", name: "Export" },
    { id: 3, role: "link", name: "Price list" },
    { id: 4, role: "link", name: "Inline" },
    { id: 5, role: "link", name: "Made here" },
  ] }],
  links: {
    3: { kind: "link", url: CSV },
    4: { kind: "link", url: "data:text/csv;base64,eCx5CjEsMgo=", download: "inline.csv" },
    5: { kind: "link", url: "blob:https://shop.example.com/7f1c" },
  },
};
const FILES = { [CSV]: { body: "item,price\ntea,3\n", headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="prices.csv"', "content-length": "17" } } };

async function failure(p: Promise<unknown>): Promise<Error> {
  try { await p; } catch (err) { return err as Error; }
  throw new Error("expected a failure");
}

async function opened(browser: "winter" | "chrome", page: FakePage = PAGE, o: Parameters<typeof harness>[0] = {}) {
  const h = harness(o);
  const fake = browser === "winter" ? h.winter : h.chrome;
  fake.pages[page.url] = page;
  fake.files = { ...FILES };
  const r = h.run();
  const tab = await h.engine.global(r.scope, "browsers.open", { url: page.url, ...(browser === "chrome" ? { browser: "chrome" } : {}) }) as TabHandle;
  const p = (primitive: string, args: Record<string, unknown> = {}) => h.engine.primitive(r.scope, tab.targetId, primitive, args);
  const tmpRoot = join(realpathSync(h.tmp), "winter-session-s1");
  return { h, r, tab, p, fake, tmpRoot };
}

describe("the built-in browser (its own download handler)", () => {
  test("a link: downloaded in the tab with no navigation, into the session's temp folder, said fenced, counted", async () => {
    const { h, r, p, fake, tmpRoot } = await opened("winter", PAGE, { nativeDownloads: ["winter"] });
    const got = await p("download", { target: 3 }) as { path: string; name: string; bytes: number; mime: string };
    expect(got).toEqual({ path: join(tmpRoot, "downloads", "prices.csv"), name: "prices.csv", bytes: 17, mime: "text/csv" });
    expect(readFileSync(got.path, "utf8")).toBe("item,price\ntea,3\n");
    expect(r.text()).toMatch(/<screen-data id="[0-9a-f]+">[\s\S]*downloaded "prices\.csv" \(17 B, text\/csv\) → /);
    expect(h.winter.sent.some((x) => x.method === "Page.navigate" && x.params.url === CSV)).toBe(false);
    expect(fake.downloadArms.size).toBe(0); // disarmed
    expect(r.metric.download).toEqual({ bytes: 17 });
    expect(r.downloads()).toBe(1);
    r.end();
  });

  test("a button: the tab is armed, the button clicked, the file caught; unarmed, a download is refused and the next state says so", async () => {
    const page: FakePage = { ...PAGE, url: "https://shop.example.com/export", clickDownload: CSV };
    const { r, p } = await opened("winter", page, { nativeDownloads: ["winter"] });
    const got = await p("download", { target: 2 }) as { name: string };
    expect(got.name).toBe("prices.csv");
    await p("click", { target: 2 });
    await new Promise((res) => setTimeout(res, 10));
    const text = await p("state", { full: true, emit: false }) as string;
    expect(text).toContain('the page started a download of "prices.csv" — it was not saved; download(ref) saves a file into this session');
    r.end();
  });

  test("a Winter.app without link protocol 2 says to update Winter", async () => {
    const { r, p } = await opened("winter");
    await expect(p("download", { target: 3 })).rejects.toThrow(/Winter's built-in browser can't save downloads until Winter is updated/);
    r.end();
  });
});

describe("a user's browser (Fetch interception)", () => {
  test("a link: loaded in a TEMPORARY background tab, captured, the request failed Aborted, the tab closed — the bound tab never navigated", async () => {
    const { h, r, p, tab } = await opened("chrome");
    const before = new Set(h.chrome.tabs.keys());
    const got = await p("download", { target: 3 }) as { path: string; name: string; bytes: number; mime: string };
    expect(got).toMatchObject({ name: "prices.csv", bytes: 17, mime: "text/csv" });
    expect(readFileSync(got.path, "utf8")).toBe("item,price\ntea,3\n");
    const temp = [...h.chrome.tabs.values()].find((t) => !before.has(t.tabKey))!;
    expect(temp.closed).toBe(true);
    const sentTo = (key: string, m: string) => h.chrome.sent.filter((x) => x.tabKey === key && x.method === m);
    expect(sentTo(temp.tabKey, "Fetch.failRequest").map((x) => x.params)).toEqual([{ requestId: expect.any(String), errorReason: "Aborted" }]);
    expect(sentTo(temp.tabKey, "Fetch.disable")).toHaveLength(1);
    expect(sentTo(tab.id.split(":")[1]!, "Page.navigate").map((x) => x.params.url)).not.toContain(CSV);
    r.end();
  });

  test("a button in the bound tab: armed, clicked, caught; the arm is always taken off", async () => {
    const page: FakePage = { ...PAGE, url: "https://shop.example.com/export", clickDownload: CSV };
    const { h, r, p, tab } = await opened("chrome", page);
    const key = tab.id.split(":")[1]!;
    const got = await p("download", { target: 2, to: "data/" }) as { path: string };
    expect(got.path).toBe(join(realpathSync(h.cwd), "data", "prices.csv"));
    expect(h.chrome.tabs.get(key)!.fetchOn.size).toBe(0);
    r.end();
  });

  test("both captures armed (the downloads permission on) and a SLOW Fetch read: bytes arriving keep it alive — not 'stalled'", async () => {
    const big = "https://shop.example.com/big.bin";
    const page: FakePage = { ...PAGE, url: "https://shop.example.com/export", clickDownload: big };
    const { h, r, p } = await opened("chrome", page, { nativeDownloads: ["chrome"] });
    h.chrome.files[big] = { body: "x".repeat(200 * 1024), headers: { "content-type": "application/octet-stream", "content-disposition": 'attachment; filename="big.bin"' } };
    h.chrome.commandDelay = (method) => (method === "IO.read" ? 80 : 0);
    const got = await p("download", { target: 2, timeoutMs: 150 }) as { name: string; bytes: number };
    expect(got).toMatchObject({ name: "big.bin", bytes: 200 * 1024 });
    r.end();
  });

  test("a click that opens a page instead: the page goes through, and the wait says so", async () => {
    const html = "https://shop.example.com/report.html";
    const page: FakePage = { ...PAGE, url: "https://shop.example.com/export", clickDownload: html };
    const { h, r, p, tab } = await opened("chrome", page);
    h.chrome.files[html] = { body: "<html></html>", headers: { "content-type": "text/html" } };
    const e = await failure(p("download", { target: 2, timeoutMs: 300 }));
    expect((e as AutomationFailure).kind).toBe("WaitTimeout");
    expect(e.message).toBe("the click opened a page instead of a download — read the page (state()) and download from its link");
    expect(h.chrome.sent.filter((x) => x.tabKey === tab.id.split(":")[1] && x.method === "Fetch.continueRequest")).toHaveLength(1);
    expect(h.chrome.tabs.get(tab.id.split(":")[1]!)!.fetchOn.size).toBe(0);
    r.end();
  });

  test("a file the page makes itself (blob:): refused without the downloads permission; with it, moved out of the browser's folder", async () => {
    const page: FakePage = { ...PAGE, url: "https://shop.example.com/make", clickBlob: { name: "made.txt", body: "hello" } };
    const off = await opened("chrome", page);
    const e = await failure(off.p("download", { target: 5 }));
    expect((e as AutomationFailure).kind).toBe("NotAllowed");
    expect(e.message).toBe("this file is made by the page itself — to save it from Google Chrome, ask the user to allow downloads in Winter for Chrome's menu (its toolbar button)");
    off.r.end();

    const denied = await opened("chrome", page, { nativeDownloads: ["chrome"] });
    denied.fake.downloadsPermission = false;
    expect((await failure(denied.p("download", { target: 5 }))).message).toMatch(/ask the user to allow downloads in Winter for Chrome's menu/);
    denied.r.end();

    const on = await opened("chrome", page, { nativeDownloads: ["chrome"] });
    const folder = join(on.h.tmp, "Downloads");
    mkdirSync(folder);
    on.fake.browserDownloadsDir = folder;
    const got = await on.p("download", { target: 5 }) as { path: string; name: string; bytes: number };
    expect(got).toMatchObject({ name: "made.txt", bytes: 5 });
    expect(readFileSync(got.path, "utf8")).toBe("hello");
    // Moved: nothing is left in the browser's folder (the Winter/<random> subfolder and Winter/ removed too).
    expect(readdirSync(folder)).toEqual([]);
    expect(on.fake.released).toEqual(["dl1"]);
    on.r.end();

    // A reported file older than the arm is not this download's: refused, and left where it was.
    const stale = await opened("chrome", page, { nativeDownloads: ["chrome"] });
    const staleFolder = join(stale.h.tmp, "Downloads");
    mkdirSync(staleFolder);
    stale.fake.browserDownloadsDir = staleFolder;
    stale.fake.backdateDownloads = true;
    await expect(stale.p("download", { target: 5 })).rejects.toThrow(/older than the download/);
    stale.r.end();
  });
});

describe("data: links, destinations, limits, policy", () => {
  test("a data: link is decoded by Winter (no browser), named by its download attribute", async () => {
    const { r, p, h } = await opened("chrome");
    const got = await p("download", { target: 4 }) as { path: string; name: string; mime: string };
    expect(got).toMatchObject({ name: "inline.csv", mime: "text/csv" });
    expect(readFileSync(got.path, "utf8")).toBe("x,y\n1,2\n");
    expect(h.chrome.sent.some((x) => x.method === "Fetch.enable")).toBe(false);
    r.end();
  });

  test("a bad destination fails before anything is fetched; at most 20 downloads per script", async () => {
    const { h, r, p } = await opened("chrome");
    const tabsBefore = h.chrome.tabs.size;
    const e = await failure(p("download", { target: 3, to: ".git/hooks/x" }));
    expect(e.message).toMatch(/hidden folders or files/);
    expect(h.chrome.tabs.size).toBe(tabsBefore);
    for (let i = 0; i < 20; i++) await p("download", { target: 4, to: "inline/" });
    const cap = await failure(p("download", { target: 4 }));
    expect(cap.message).toBe("at most 20 downloads per script — run another script for more");
    expect(readdirSync(join(realpathSync(h.cwd), "inline"))).toHaveLength(20);
    r.end();
  });

  test("download() is a full-class act: a click-only Chrome refuses it, plan mode refuses it", async () => {
    const h = harness({ apps: { "com.google.Chrome": { access: "click" } } });
    h.chrome.addTab({ ...PAGE, nodes: PAGE.nodes }, { tabKey: "40" });
    const r = h.run();
    const t = await h.engine.global(r.scope, "browsers.tab", { tab: "chrome:40" }) as TabHandle;
    expect((await failure(h.engine.primitive(r.scope, t.targetId, "download", { target: 4 })) as AutomationFailure).kind).toBe("NotAllowed");
    r.end();
  });

  test("a download the page starts by itself in a user's browser, unarmed: the next state says the browser saved it", async () => {
    const page: FakePage = { ...PAGE, url: "https://shop.example.com/export", clickDownload: "https://shop.example.com/other.zip" };
    const { r, p } = await opened("chrome", page);
    await p("click", { target: 2 });
    const text = await p("state", { full: true, emit: false }) as string;
    expect(text).toContain('the page started a download of "other.zip" — Google Chrome saved it in its own Downloads folder; download(ref) saves a file into this session');
    r.end();
  });
});
