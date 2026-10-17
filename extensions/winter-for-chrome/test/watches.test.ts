// Winter for Chrome 1.2.0 — wake triggers' watches with NO debugger: the page watcher injected into the extension's own
// isolated world (top frame), again into each new document, its messages relayed as `watch.event` (with the extension's
// own-input stamp), its heartbeat answered, and everything taken down with the link to Winter.
import { beforeEach, describe, expect, test } from "bun:test";
import { wakeWatcher } from "../../../packages/core/src/computer-use/browser/page-runtime/watch";
import { forbiddenHits } from "../scripts/build";
import { ExtensionController, ExtensionError } from "../src/controller";
import { EXTENSION_FEATURES } from "../src/protocol";
import { LOAD_STALL_MS, WATCH_SILENCE_MS } from "../src/watches";
import { FakeChrome, flush, ManualClock } from "./fake-chrome";

let chrome: FakeChrome;
let notes: { method: string; params: Record<string, unknown> }[];
let c: ExtensionController;
/** What the page's watcher answers to each injection (by watch id); the args each injection carried. */
let answers: Map<string, unknown>;
let injected: Array<Record<string, any>>;
let clock: ManualClock;

const TAB = 101;
const doc = 1_700_000_000_123.5;
const spec = (over: Record<string, unknown> = {}) => ({
  watchId: "wk_0123456789ab", kind: "clicked", pill: "Winter continues when you click “Submit”", expiresAt: Date.now() + 3_600_000,
  locator: { doc, path: [["HTML", 0, 0], ["BODY", 0, 0], ["BUTTON", 2, 0]], tag: "BUTTON", attrs: { id: "submit" } }, ...over,
});

beforeEach(async () => {
  chrome = new FakeChrome();
  notes = [];
  answers = new Map();
  injected = [];
  chrome.scriptAnswer = (func, arg) => {
    if (func !== "wakeWatcher") return undefined;
    const a = arg as Record<string, any>;
    injected.push(a);
    if (a.op === "disarm") return true;
    return answers.get(a.spec?.watchId) ?? { ok: true, installed: "new", doc };
  };
  clock = new ManualClock();
  c = new ExtensionController(chrome, { notify: (method, params) => notes.push({ method, params }), clock, launchHintMs: 10 });
  c.noteLaunch("install");
  await c.start();
});

const errOf = async (p: Promise<unknown>): Promise<ExtensionError> => {
  try { await p; } catch (err) { return err as ExtensionError; }
  throw new Error("expected a refusal");
};
/** A message from the watcher in `tabId`'s frame `frameId`, as the browser hands it to the worker. */
function fromPage(message: Record<string, unknown>, tabId = TAB, frameId = 0): unknown {
  let answer: unknown;
  for (const l of chrome.runtimeOnMessage.listeners) l(message, { id: chrome.runtimeId, tab: { ...chrome.tabs_.get(tabId)!, id: tabId }, frameId }, (r) => { answer = r; });
  return answer;
}
// The controller's own listener is not registered here (background.ts does that): route the way it does.
beforeEach(() => {
  chrome.runtimeOnMessage.addListener((m, sender, sendResponse) => { c.watchMessage(m, sender, sendResponse); return undefined; });
});

describe("watch.arm", () => {
  test("injects the watcher into the extension's own world in the top frame — no debugger — and answers what it said", async () => {
    const r = await c.handle("watch.arm", { tabKey: String(TAB), spec: spec() });
    expect(r).toEqual({ ok: true, installed: "new", doc });
    const call = chrome.calls.find((x) => x.api === "scripting.executeScript")!;
    expect(call.args[0]).toMatchObject({ target: { tabId: TAB }, world: "ISOLATED", func: "wakeWatcher" });
    expect(injected[0]).toMatchObject({ op: "arm", sink: "runtime", spec: { watchId: "wk_0123456789ab", kind: "clicked", initial: "refuse" } });
    expect(chrome.calls.some((x) => x.api.startsWith("debugger."))).toBe(false);
    expect(c.watchCount()).toBe(1);
    expect(chrome.viewMovingCalls()).toEqual([]);
  });

  test("a condition already true is the watcher's answer (and nothing is kept); a page that takes no script, a browser page, or a malformed watch is refused not_allowed", async () => {
    answers.set("wk_0123456789ab", { ok: false, reason: "met" });
    expect(await c.handle("watch.arm", { tabKey: String(TAB), spec: spec({ kind: "appeared", text: "Saved" }) })).toEqual({ ok: false, reason: "met" });
    expect(c.watchCount()).toBe(0);
    chrome.scriptThrows.add(TAB);
    const e1 = await errOf(c.handle("watch.arm", { tabKey: String(TAB), spec: spec() }));
    expect([e1.code, e1.data.reason]).toEqual(["not_allowed", "page"]);
    const store = chrome.addTab({ windowId: 1, url: "chrome://settings/" });
    const e2 = await errOf(c.handle("watch.arm", { tabKey: String(store.id), spec: spec() }));
    expect([e2.code, e2.data.reason]).toEqual(["not_allowed", "page"]);
    const e3 = await errOf(c.handle("watch.arm", { tabKey: String(TAB), spec: spec({ watchId: "not-a-wake" }) }));
    expect([e3.code, e3.data.reason]).toEqual(["not_allowed", "malformed"]);
    const e4 = await errOf(c.handle("watch.arm", { tabKey: String(TAB), spec: spec({ kind: "javascript" }) }));
    expect(e4.code).toBe("not_allowed");
    expect((await errOf(c.handle("watch.arm", { tabKey: "999", spec: spec() }))).code).toBe("tab_gone");
  });
});

describe("what the watcher reports", () => {
  test("its event is relayed as watch.event — only from the tab's top frame, only for a watch the extension keeps, only its known fields", async () => {
    await c.handle("watch.arm", { tabKey: String(TAB), spec: spec() });
    const at = Date.now();
    fromPage({ type: "winter.wake.event", watchId: "wk_0123456789ab", outcome: "fired", at, url: "https://user.example/doc", value: "typed by the user" }, TAB, 1);
    fromPage({ type: "winter.wake.event", watchId: "wk_ffffffffffff", outcome: "fired", at, url: "https://user.example/doc" });
    fromPage({ type: "winter.wake.event", watchId: "wk_0123456789ab", outcome: "fired", at, url: "https://user.example/doc" }, 100);
    expect(notes.filter((n) => n.method === "watch.event")).toEqual([]);
    fromPage({ type: "winter.wake.event", watchId: "wk_0123456789ab", outcome: "fired", at, url: "https://user.example/doc", value: "typed by the user" });
    expect(notes.filter((n) => n.method === "watch.event")).toEqual([
      { method: "watch.event", params: { tabKey: String(TAB), watchId: "wk_0123456789ab", outcome: "fired", at, url: "https://user.example/doc" } },
    ]);
  });

  test("Winter's own input (this extension's debugger, any Input.* or navigation) stamps what lands within 500 ms as `own`", async () => {
    await c.handle("debugger.attach", { tabKey: String(TAB) });
    await c.handle("watch.arm", { tabKey: String(TAB), spec: spec() });
    await c.handle("cdp.send", { tabKey: String(TAB), method: "Input.dispatchMouseEvent", params: { type: "mousePressed", x: 1, y: 1, button: "left", clickCount: 1 } });
    fromPage({ type: "winter.wake.event", watchId: "wk_0123456789ab", outcome: "fired", at: Date.now(), url: "https://user.example/doc" });
    fromPage({ type: "winter.wake.event", watchId: "wk_0123456789ab", outcome: "fired", at: Date.now() + 2_000, url: "https://user.example/doc" });
    const ev = notes.filter((n) => n.method === "watch.event").map((n) => n.params.own);
    expect(ev).toEqual([true, undefined]);
  });

  test("the heartbeat names the watches the extension still keeps (a watcher it does not know takes itself down)", async () => {
    await c.handle("watch.arm", { tabKey: String(TAB), spec: spec() });
    expect(fromPage({ type: "winter.wake.alive", watchIds: ["wk_0123456789ab", "wk_aaaaaaaaaaaa"] })).toEqual({ known: ["wk_0123456789ab"] });
    expect(fromPage({ type: "winter.wake.alive", watchIds: ["wk_0123456789ab"] }, 100)).toEqual({ known: [] });
  });
});

describe("new documents", () => {
  test("a URL change is reported to a navigated watch; each new document gets the watcher again (`fire`, or `baseline` after the extension's own navigation); an element's watch whose document went is lost", async () => {
    await c.handle("watch.arm", { tabKey: String(TAB), spec: spec({ watchId: "wk_00000000000a", kind: "navigated", locator: undefined, pill: "Winter continues when you go to another page" }) });
    await c.handle("watch.arm", { tabKey: String(TAB), spec: spec({ watchId: "wk_00000000000b", kind: "appeared", text: "Order placed", locator: undefined }) });
    await c.handle("watch.arm", { tabKey: String(TAB), spec: spec({ watchId: "wk_00000000000c" }) });
    injected = [];
    answers.set("wk_00000000000c", { ok: false, reason: "doc" });
    for (const l of chrome.tabsOnUpdated.listeners) l(TAB, { status: "loading", url: "https://user.example/thanks" });
    for (const l of chrome.tabsOnUpdated.listeners) l(TAB, { status: "complete" });
    await flush();
    const events = notes.filter((n) => n.method === "watch.event").map((n) => n.params);
    expect(events.find((e) => e.watchId === "wk_00000000000a")).toMatchObject({ outcome: "url", url: "https://user.example/thanks" });
    expect(events.find((e) => e.watchId === "wk_00000000000c")).toMatchObject({ outcome: "lost", reason: "doc" });
    expect(injected.filter((a) => a.op === "arm").map((a) => [a.spec.watchId, a.spec.initial])).toEqual([["wk_00000000000a", "fire"], ["wk_00000000000b", "fire"], ["wk_00000000000c", "fire"]]);
    expect(c.watchCount()).toBe(2);
    // The extension's own navigation (Winter's goto through its debugger): the next document is a baseline.
    await c.handle("debugger.attach", { tabKey: String(TAB) });
    injected = [];
    await c.handle("cdp.send", { tabKey: String(TAB), method: "Page.navigate", params: { url: "https://user.example/next" } });
    for (const l of chrome.tabsOnUpdated.listeners) l(TAB, { status: "loading", url: "https://user.example/next" });
    for (const l of chrome.tabsOnUpdated.listeners) l(TAB, { status: "complete" });
    await flush();
    expect(injected.filter((a) => a.op === "arm").map((a) => a.spec.initial)).toEqual(["baseline", "baseline"]);
    expect(notes.filter((n) => n.method === "watch.event").at(-1)!.params).toMatchObject({ outcome: "url", own: true });
  });
});

describe("the address", () => {
  test("a navigated watch hears of an address change as its site and path, a digest, and whether it holds Winter's words — never its query or fragment", async () => {
    await c.handle("watch.arm", { tabKey: String(TAB), spec: spec({ watchId: "wk_00000000000a", kind: "navigated", locator: undefined, url: "step=2", pill: "Winter continues when you go to another page" }) });
    for (const l of chrome.tabsOnUpdated.listeners) l(TAB, { status: "loading", url: "https://user.example/search?q=my+secret+order&step=2#top" });
    const e = notes.filter((n) => n.method === "watch.event").at(-1)!.params;
    expect(e).toMatchObject({ outcome: "url", url: "https://user.example/search?…#…", match: true });
    expect(typeof e.key).toBe("string");
    expect(JSON.stringify(notes)).not.toContain("secret");
    for (const l of chrome.tabsOnUpdated.listeners) l(TAB, { status: "loading", url: "https://user.example/search?q=other" });
    const f = notes.filter((n) => n.method === "watch.event").at(-1)!.params;
    expect(f).toMatchObject({ url: "https://user.example/search?…", match: false });
    expect(f.key).not.toBe(e.key);
  });
});

describe("never silent, never lost on a same-document change", () => {
  const loadingThenComplete = (url?: string): void => {
    for (const l of chrome.tabsOnUpdated.listeners) l(TAB, { status: "loading", ...(url === undefined ? {} : { url }) });
    for (const l of chrome.tabsOnUpdated.listeners) l(TAB, { status: "complete" });
  };

  test("a pushState or a new fragment says \"loading\" too (measured): the element's watch is asked again and stays", async () => {
    await c.handle("watch.arm", { tabKey: String(TAB), spec: spec() });
    answers.set("wk_0123456789ab", { ok: true, installed: "alive", doc });
    loadingThenComplete("https://user.example/doc#review");
    await flush();
    expect(notes.filter((n) => n.method === "watch.event")).toEqual([]);
    expect(c.watchCount()).toBe(1);
  });

  test("a new document that takes no script (a browser page, a store page): an element's watch is lost at once, dated when the load began; a page condition waits for the next load", async () => {
    await c.handle("watch.arm", { tabKey: String(TAB), spec: spec() });
    await c.handle("watch.arm", { tabKey: String(TAB), spec: spec({ watchId: "wk_00000000000b", kind: "appeared", text: "Order placed", locator: undefined }) });
    chrome.scriptThrows.add(TAB);
    const before = Date.now();
    loadingThenComplete("https://chromewebstore.google.com/");
    await flush();
    const lost = notes.filter((n) => n.method === "watch.event").map((n) => n.params);
    expect(lost).toEqual([{ tabKey: String(TAB), watchId: "wk_0123456789ab", outcome: "lost", at: expect.any(Number), reason: "doc" }]);
    expect(lost[0]!.at as number).toBeGreaterThanOrEqual(before);
    expect(c.watchCount()).toBe(1);
  });

  test("a load that never completes is looked at anyway after 10 s: the element's document went — lost", async () => {
    await c.handle("watch.arm", { tabKey: String(TAB), spec: spec() });
    for (const l of chrome.tabsOnUpdated.listeners) l(TAB, { status: "loading", url: "https://user.example/slow" });
    answers.set("wk_0123456789ab", { ok: false, reason: "doc" });
    await flush();
    expect(notes.filter((n) => n.method === "watch.event")).toEqual([]);
    await clock.advance(LOAD_STALL_MS);
    expect(notes.filter((n) => n.method === "watch.event").map((n) => n.params)).toMatchObject([{ watchId: "wk_0123456789ab", outcome: "lost", reason: "doc" }]);
  });

  test("a watcher not heard from for a minute (a renderer that crashed) is looked at: no page there any more — lost; one that answers keeps its watch", async () => {
    await c.handle("watch.arm", { tabKey: String(TAB), spec: spec() });
    answers.set("wk_0123456789ab", { ok: true, installed: "alive", doc });
    await clock.advance(WATCH_SILENCE_MS);
    expect(notes.filter((n) => n.method === "watch.event")).toEqual([]);
    expect(c.watchCount()).toBe(1);
    // Its heartbeat holds the next look off.
    await clock.advance(WATCH_SILENCE_MS - 1_000);
    fromPage({ type: "winter.wake.alive", watchIds: ["wk_0123456789ab"] });
    chrome.scriptThrows.add(TAB);
    await clock.advance(WATCH_SILENCE_MS - 1_000);
    expect(notes.filter((n) => n.method === "watch.event")).toEqual([]);
    await clock.advance(2_000);
    expect(notes.filter((n) => n.method === "watch.event").map((n) => n.params)).toMatchObject([{ watchId: "wk_0123456789ab", outcome: "lost", reason: "doc" }]);
    expect(c.watchCount()).toBe(0);
  });

  test("a submit or a change carries the time of the input that made it the user's; this extension's own input then makes it `own`", async () => {
    await c.handle("debugger.attach", { tabKey: String(TAB) });
    await c.handle("watch.arm", { tabKey: String(TAB), spec: spec({ kind: "submitted", locator: undefined, anyForm: true }) });
    await c.handle("cdp.send", { tabKey: String(TAB), method: "Input.insertText", params: { text: "draft" } });
    const typed = Date.now();
    fromPage({ type: "winter.wake.event", watchId: "wk_0123456789ab", outcome: "fired", at: typed + 5_000, cause: typed, url: "https://user.example/doc" });
    fromPage({ type: "winter.wake.event", watchId: "wk_0123456789ab", outcome: "fired", at: typed + 5_000, cause: typed + 4_990, url: "https://user.example/doc" });
    expect(notes.filter((n) => n.method === "watch.event").map((n) => [n.params.cause, n.params.own])).toEqual([[typed, true], [typed + 4_990, undefined]]);
  });
});

describe("ending", () => {
  test("watch.cancel takes the watcher down (idempotent); the link dropping takes every one down; a closed tab forgets its own", async () => {
    await c.handle("watch.arm", { tabKey: String(TAB), spec: spec() });
    await c.handle("watch.cancel", { tabKey: String(TAB), watchId: "wk_0123456789ab" });
    await c.handle("watch.cancel", { tabKey: String(TAB), watchId: "wk_0123456789ab" });
    expect(injected.filter((a) => a.op === "disarm").length).toBe(2);
    expect(c.watchCount()).toBe(0);
    await c.handle("watch.arm", { tabKey: String(TAB), spec: spec({ watchId: "wk_00000000000d" }) });
    await c.handle("watch.arm", { tabKey: "100", spec: spec({ watchId: "wk_00000000000e" }) });
    injected = [];
    await c.releaseAll();
    expect(injected.map((a) => [a.op, a.watchId]).sort()).toEqual([["disarm", "wk_00000000000d"], ["disarm", "wk_00000000000e"]]);
    expect(c.watchCount()).toBe(0);
    await c.handle("watch.arm", { tabKey: String(TAB), spec: spec({ watchId: "wk_00000000000f" }) });
    for (const l of chrome.tabsOnRemoved.listeners) l(TAB);
    expect(c.watchCount()).toBe(0);
  });
});

describe("the watcher function", () => {
  test("stands alone (Chrome serializes it), reports through runtime messages, draws a closed, pointer-free overlay, and holds nothing the extension must never do", () => {
    const src = wakeWatcher.toString();
    const fn = new Function(`return (${src});`)() as unknown;
    expect(typeof fn).toBe("function");
    expect(src).toContain('"winter.wake.event"');
    expect(src).toContain('mode: "closed"');
    expect(src).toContain("pointer-events: none !important");
    expect(src).toContain("isTrusted");
    expect(forbiddenHits(src)).toEqual([]);
    expect(EXTENSION_FEATURES).toContain("watch");
  });
});
