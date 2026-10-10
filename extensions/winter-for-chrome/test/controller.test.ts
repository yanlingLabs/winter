// The extension's controller over a fake browser: opening tabs in the background into the session's Winter group,
// closing (through a page's "leave this page?") and keeping only Winter's own tabs, attaching (and refusing to), the
// guard on every command, events, detaches, the idle detach, what survives a worker restart, an update and a browser
// restart, the overlay and the toolbar Stop — and never once moving the user's view.
import { beforeEach, describe, expect, test } from "bun:test";
import { ExtensionController, ExtensionError, type LaunchKind } from "../src/controller";
import { FakeChrome, flush, ManualClock } from "./fake-chrome";

let chrome: FakeChrome;
let clock: ManualClock;
let notes: { method: string; params: Record<string, unknown> }[];
let driven: number[];
let c: ExtensionController;

async function make(opts: { idleDetachMs?: number; launch?: LaunchKind | null } = {}): Promise<ExtensionController> {
  const ctl = new ExtensionController(chrome, {
    notify: (method, params) => notes.push({ method, params }),
    onDriven: (n) => driven.push(n),
    clock,
    closeTimeoutMs: 500,
    launchHintMs: 1000,
    ...(opts.idleDetachMs === undefined ? {} : { idleDetachMs: opts.idleDetachMs }),
  });
  if (opts.launch !== null) ctl.noteLaunch(opts.launch ?? "install");
  await ctl.start();
  return ctl;
}

beforeEach(async () => {
  chrome = new FakeChrome();
  clock = new ManualClock();
  notes = [];
  driven = [];
  c = await make();
});

const code = async (p: Promise<unknown>): Promise<string> => {
  try { await p; return "ok"; } catch (err) { return err instanceof ExtensionError ? err.code : `untyped: ${String(err)}`; }
};

async function open(sessionId = "s_1", title = "Fix the build", url = "https://example.com/"): Promise<{ tabKey: string; agent: boolean; sessionId?: string; active: boolean }> {
  const r = await c.handle("tabs.create", { url, sessionId, sessionTitle: title }) as { tab: { tabKey: string; agent: boolean; sessionId?: string; active: boolean } };
  return r.tab;
}
const agents = async (ctl = c) => ((await ctl.handle("tabs.list", {})) as { tabs: { tabKey: string; agent: boolean; sessionId?: string }[] }).tabs.filter((t) => t.agent).map((t) => [t.tabKey, t.sessionId]);

describe("tabs.create", () => {
  test("opens in the background, in the session's \"Winter · <title>\" group, in the window the user used last", async () => {
    const before = chrome.activeTabs();
    const tab = await open();
    expect(tab).toMatchObject({ agent: true, sessionId: "s_1", active: false });
    const created = chrome.tabs_.get(Number(tab.tabKey))!;
    expect(created.windowId).toBe(1);
    expect(created.groupId).toBeGreaterThan(0);
    expect(chrome.groups_.get(created.groupId)?.title).toBe("Winter · Fix the build");
    expect(chrome.calls.find((x) => x.api === "tabGroups.update")?.args[1]).toEqual({ title: "Winter · Fix the build", color: "blue" });
    expect(chrome.activeTabs()).toEqual(before);
    expect(chrome.viewMovingCalls()).toEqual([]);
  });

  test("a second tab of the same session joins its group, in that group's window", async () => {
    chrome.addWindow({ id: 2, incognito: false });
    const first = await open();
    chrome.lastFocused = 2;
    const second = await open("s_1", "Fix the build", "https://example.com/two");
    const a = chrome.tabs_.get(Number(first.tabKey))!;
    const b = chrome.tabs_.get(Number(second.tabKey))!;
    expect(b.groupId).toBe(a.groupId);
    expect(b.windowId).toBe(1);
    const other = await open("s_2", "Another");
    expect(chrome.tabs_.get(Number(other.tabKey))!.groupId).not.toBe(a.groupId);
    expect(chrome.tabs_.get(Number(other.tabKey))!.windowId).toBe(2);
  });

  test("a failed group step never leaks the tab: it is returned, Winter's, and closable", async () => {
    chrome.groupFails = true;
    const tab = await open();
    expect(tab).toMatchObject({ agent: true, sessionId: "s_1" });
    expect(chrome.tabs_.get(Number(tab.tabKey))!.groupId).toBe(-1);
    expect(await agents()).toEqual([[tab.tabKey, "s_1"]]);
    await c.handle("tabs.close", { tabKey: tab.tabKey });
    expect(chrome.tabs_.has(Number(tab.tabKey))).toBe(false);
  });

  test("never a private window; no window at all is a typed error", async () => {
    chrome.windows_ = [{ id: 9, incognito: true }, { id: 3, incognito: false }];
    chrome.lastFocused = 9;
    const tab = await open();
    expect(chrome.tabs_.get(Number(tab.tabKey))!.windowId).toBe(3);
    chrome.windows_ = [{ id: 9, incognito: true }];
    expect(await code(open("s_9"))).toBe("cdp_error");
  });

  test("only http, https and about:blank; a session is required", async () => {
    for (const url of ["file:///etc/passwd", "javascript:alert(1)", "chrome://settings", "data:text/html,x", "blob:https://x/1", "nonsense"]) {
      expect(await code(c.handle("tabs.create", { url, sessionId: "s_1", sessionTitle: "" }))).toBe("not_allowed");
    }
    expect(await code(c.handle("tabs.create", { url: "https://x.test/", sessionTitle: "" }))).toBe("not_allowed");
    expect(await code(c.handle("tabs.create", { url: "about:blank", sessionId: "s_1", sessionTitle: "" }))).toBe("ok");
  });
});

describe("which tabs are Winter's, across restarts", () => {
  test("a worker restart (or a daemon restart) keeps every agent tab with its session", async () => {
    const a = await open("s_1", "One");
    const b = await open("s_2", "Two");
    const again = await make({ launch: null }); // the alive mark is there: no launch hint is waited for
    expect(await agents(again)).toEqual([[a.tabKey, "s_1"], [b.tabKey, "s_2"]]);
    const c2 = await again.handle("tabs.create", { url: "https://example.com/3", sessionId: "s_1", sessionTitle: "One" }) as { tab: { tabKey: string } };
    expect(chrome.tabs_.get(Number(c2.tab.tabKey))!.groupId).toBe(chrome.tabs_.get(Number(a.tabKey))!.groupId);
  });

  test("an update of the extension (storage.session cleared) keeps them too", async () => {
    const a = await open();
    chrome.updateExtension();
    const updated = await make({ launch: "update" });
    expect(await agents(updated)).toEqual([[a.tabKey, "s_1"]]);
    expect(await code(updated.handle("tabs.close", { tabKey: a.tabKey }))).toBe("ok");
  });

  test("a browser restart clears the record: an old id now naming a restored tab is never taken for Winter's", async () => {
    const a = await open();
    chrome.restartBrowser();
    expect(chrome.tabs_.has(Number(a.tabKey))).toBe(true); // the same id, now a restored tab
    const fresh = await make({ launch: "startup" });
    expect(await agents(fresh)).toEqual([]);
    for (const t of chrome.tabs_.keys()) expect(await code(fresh.handle("tabs.close", { tabKey: String(t) }))).toBe("not_allowed");
  });

  test("no word on why the worker started, in time, reads as a browser start (forgetting is the safe side)", async () => {
    await open();
    chrome.restartBrowser();
    const p = make({ launch: null });
    await flush();
    await clock.advance(1000);
    const fresh = await p;
    expect(await agents(fresh)).toEqual([]);
  });

  test("a worker restart detaches what the previous worker left attached, and removes its overlays", async () => {
    await c.handle("debugger.attach", { tabKey: "101" });
    await c.handle("overlay", { tabKey: "101", active: true });
    expect(chrome.attachedDebuggers.has(101)).toBe(true);
    const before = chrome.calls.length;
    await make({ launch: null });
    expect(chrome.attachedDebuggers.has(101)).toBe(false);
    const after = chrome.calls.slice(before).filter((x) => x.api === "scripting.executeScript").map((x) => x.args[0]);
    expect(after).toEqual([{ target: { tabId: 101 }, world: "ISOLATED", func: "drawOverlay", args: [{ active: false }] }]);
  });
});

describe("tabs.list, tabs.close, tabs.keep", () => {
  test("lists every tab of the profile (never a private one), marking Winter's", async () => {
    chrome.addTab({ windowId: 1, url: "https://secret.example/", incognito: true });
    const mine = await open();
    const tabs = (await c.handle("tabs.list", {}) as { tabs: { tabKey: string; url: string; title: string; active: boolean; agent: boolean }[] }).tabs;
    expect(tabs.map((t) => t.url)).toEqual(["https://user.example/inbox", "https://user.example/doc", "https://example.com/"]);
    expect(tabs.find((t) => t.tabKey === mine.tabKey)?.agent).toBe(true);
    expect(tabs[0]).toEqual({ tabKey: "100", url: "https://user.example/inbox", title: "Inbox", active: true, agent: false });
  });

  test("closes a Winter tab; refuses the user's", async () => {
    const mine = await open();
    expect(await code(c.handle("tabs.close", { tabKey: "100" }))).toBe("not_allowed");
    expect(chrome.tabs_.has(100)).toBe(true);
    await c.handle("tabs.close", { tabKey: mine.tabKey });
    expect(chrome.tabs_.has(Number(mine.tabKey))).toBe(false);
    expect(await code(c.handle("tabs.close", { tabKey: mine.tabKey }))).toBe("tab_gone");
    expect(await code(c.handle("tabs.close", { tabKey: "not-a-number" }))).toBe("tab_gone");
  });

  test("a page that asks \"leave this page?\" is closed through the debugger: the prompt accepted, no native dialog left", async () => {
    const mine = await open();
    chrome.beforeunload.add(Number(mine.tabKey));
    await c.handle("tabs.close", { tabKey: mine.tabKey }); // not attached: the close attaches for itself
    expect(chrome.tabs_.has(Number(mine.tabKey))).toBe(false);
    expect(chrome.nativeDialogs).toEqual([]);
    expect(chrome.calls.some((x) => x.api === "debugger.sendCommand" && x.args[1] === "Page.handleJavaScriptDialog" && (x.args[2] as { accept: boolean }).accept)).toBe(true);
    // Attached (and driven) at the time: the same.
    const other = await open();
    await c.handle("debugger.attach", { tabKey: other.tabKey });
    chrome.beforeunload.add(Number(other.tabKey));
    await c.handle("tabs.close", { tabKey: other.tabKey });
    expect(chrome.tabs_.has(Number(other.tabKey))).toBe(false);
    expect(chrome.nativeDialogs).toEqual([]);
    expect(c.attachedTabs()).toEqual([]);
    expect(notes.filter((n) => n.method === "tab.gone").map((n) => n.params.tabKey)).toEqual([mine.tabKey, other.tabKey]);
  });

  test("a beforeunload prompt is accepted only while Winter closes ITS tab — never on a user's tab, never outside a close", async () => {
    await c.handle("debugger.attach", { tabKey: "101" });
    chrome.emitCdp(101, "Page.javascriptDialogOpening", { type: "beforeunload", message: "" });
    const mine = await open();
    await c.handle("debugger.attach", { tabKey: mine.tabKey });
    chrome.emitCdp(Number(mine.tabKey), "Page.javascriptDialogOpening", { type: "beforeunload", message: "" });
    await flush();
    expect(chrome.calls.some((x) => x.api === "debugger.sendCommand" && x.args[1] === "Page.handleJavaScriptDialog")).toBe(false);
  });

  test("closing a group's last tab ungroups it first: no group is left behind", async () => {
    const a = await open();
    const b = await open();
    const group = chrome.tabs_.get(Number(a.tabKey))!.groupId;
    await c.handle("tabs.close", { tabKey: a.tabKey });
    expect(chrome.groups_.has(group)).toBe(true); // b is still in it
    await c.handle("tabs.close", { tabKey: b.tabKey });
    expect(chrome.groups_.has(group)).toBe(false);
    const closing = chrome.calls.filter((x) => x.api === "tabs.ungroup" || x.api === "tabs.remove").map((x) => [x.api, x.args[0]]);
    expect(closing).toEqual([["tabs.ungroup", [Number(a.tabKey)]], ["tabs.remove", Number(a.tabKey)], ["tabs.ungroup", [Number(b.tabKey)]], ["tabs.remove", Number(b.tabKey)]]);
    const next = await open();
    expect(chrome.groups_.has(chrome.tabs_.get(Number(next.tabKey))!.groupId)).toBe(true);
  });

  test("Chrome's own pin does not protect an agent tab: it is still Winter's, and closable", async () => {
    const a = await open();
    chrome.pinTab(Number(a.tabKey));
    expect(await agents()).toEqual([[a.tabKey, "s_1"]]);
    await c.handle("tabs.close", { tabKey: a.tabKey });
    expect(chrome.tabs_.has(Number(a.tabKey))).toBe(false);
  });

  test("a tab the user drags into a Winter group stays the user's", async () => {
    const a = await open();
    chrome.tabs_.get(101)!.groupId = chrome.tabs_.get(Number(a.tabKey))!.groupId;
    expect(await agents()).toEqual([[a.tabKey, "s_1"]]);
    expect(await code(c.handle("tabs.close", { tabKey: "101" }))).toBe("not_allowed");
  });

  test("keep() takes the tab out of the Winter group: it is the user's from then on, and never closed by Winter", async () => {
    const mine = await open();
    await c.handle("tabs.keep", { tabKey: mine.tabKey });
    expect(chrome.tabs_.get(Number(mine.tabKey))!.groupId).toBe(-1);
    expect(await agents()).toEqual([]);
    expect(await code(c.handle("tabs.close", { tabKey: mine.tabKey }))).toBe("not_allowed");
    await c.handle("tabs.keep", { tabKey: "101" }); // a user tab: nothing to do
    expect(chrome.calls.filter((x) => x.api === "tabs.ungroup")).toHaveLength(1);
    const pinned = await open();
    chrome.pinTab(Number(pinned.tabKey));
    await c.handle("tabs.keep", { tabKey: pinned.tabKey });
    expect(chrome.calls.filter((x) => x.api === "tabs.ungroup")).toHaveLength(1);
    expect(await code(c.handle("tabs.close", { tabKey: pinned.tabKey }))).toBe("not_allowed");
  });
});

describe("debugger.attach / detach", () => {
  test("attaches, turns on focus emulation, and answers the CSS viewport and the DPR", async () => {
    const r = await c.handle("debugger.attach", { tabKey: "101" });
    expect(r).toEqual({ viewport: [1280, 720], dpr: 2 });
    expect(chrome.attachedDebuggers.has(101)).toBe(true);
    expect(chrome.calls.some((x) => x.api === "debugger.sendCommand" && x.args[1] === "Emulation.setFocusEmulationEnabled" && (x.args[2] as { enabled: boolean }).enabled)).toBe(true);
    expect(await c.handle("debugger.attach", { tabKey: "101" })).toEqual({ viewport: [1280, 720], dpr: 2 }); // idempotent
    expect(chrome.calls.filter((x) => x.api === "debugger.attach")).toHaveLength(1);
    expect(chrome.viewMovingCalls()).toEqual([]);
  });

  test("refuses the browser's own pages, store pages, its own pages, and local or opaque documents", async () => {
    for (const url of ["chrome://settings/", "edge://flags", "brave://rewards", "vivaldi://about", "opera://plugins", "arc://x", "chrome-extension://other/page.html",
      `chrome-extension://${chrome.runtimeId}/popup.html`, "devtools://devtools/bundled/inspector.html", "view-source:https://x/", "about:settings",
      "file:///Users/someone/secret.txt", "data:text/html,<b>x</b>", "blob:https://example.com/0f0e", "filesystem:https://example.com/temporary/a.txt",
      "https://chromewebstore.google.com/detail/x", "https://chrome.google.com/webstore/detail/x", "https://microsoftedge.microsoft.com/addons/detail/x"]) {
      const t = chrome.addTab({ windowId: 1, url });
      expect({ url, code: await code(c.handle("debugger.attach", { tabKey: String(t.id) })) }).toEqual({ url, code: "attach_refused" });
    }
    expect(chrome.calls.filter((x) => x.api === "debugger.attach")).toHaveLength(0);
    const ok = chrome.addTab({ windowId: 1, url: "https://chrome.google.com/search" });
    expect(await code(c.handle("debugger.attach", { tabKey: String(ok.id) }))).toBe("ok");
  });

  test("another debugger already attached → attach_refused; a closed tab → tab_gone", async () => {
    chrome.foreignDebuggers.add(101);
    expect(await code(c.handle("debugger.attach", { tabKey: "101" }))).toBe("attach_refused");
    expect(await code(c.handle("debugger.attach", { tabKey: "999" }))).toBe("tab_gone");
  });

  test("detach is idempotent and never closes the tab", async () => {
    await c.handle("debugger.attach", { tabKey: "101" });
    await c.handle("debugger.detach", { tabKey: "101" });
    await c.handle("debugger.detach", { tabKey: "101" });
    expect(chrome.attachedDebuggers.has(101)).toBe(false);
    expect(chrome.tabs_.has(101)).toBe(true);
  });
});

describe("cdp.send", () => {
  test("needs the tab attached; refuses what the guard refuses, before the browser sees it", async () => {
    expect(await code(c.handle("cdp.send", { tabKey: "101", method: "Page.enable", params: {} }))).toBe("tab_gone");
    await c.handle("debugger.attach", { tabKey: "101" });
    const sent = () => chrome.calls.filter((x) => x.api === "debugger.sendCommand").map((x) => x.args[1]);
    const before = sent().length;
    expect(await code(c.handle("cdp.send", { tabKey: "101", method: "Network.getCookies", params: {} }))).toBe("not_allowed");
    expect(await code(c.handle("cdp.send", { tabKey: "101", method: "Runtime.evaluate", params: { expression: "document.cookie" } }))).toBe("not_allowed");
    expect(await code(c.handle("cdp.send", { tabKey: "101", method: "Page.createIsolatedWorld", params: { frameId: "F", worldName: "main" } }))).toBe("not_allowed");
    expect(await code(c.handle("cdp.send", { tabKey: "101", method: "Page.navigate", params: { url: "javascript:alert(document.cookie)" } }))).toBe("not_allowed");
    expect(await code(c.handle("cdp.send", { tabKey: "101", method: "Page.reload", params: { scriptToEvaluateOnLoad: "document.cookie" } }))).toBe("not_allowed");
    expect(sent().length).toBe(before);
  });

  test("the winter world end to end: Runtime on, createIsolatedWorld, then evaluate in it; a child session addresses its own target", async () => {
    chrome.cdp["Page.createIsolatedWorld"] = { executionContextId: 31 };
    chrome.cdp["Runtime.evaluate"] = (_t: unknown, p: Record<string, unknown> | undefined) => ({ result: { type: "string", value: `ran in ${String(p?.contextId)}` } });
    await c.handle("debugger.attach", { tabKey: "101" });
    await c.handle("cdp.send", { tabKey: "101", method: "Runtime.enable", params: {} });
    await c.handle("cdp.send", { tabKey: "101", method: "Page.createIsolatedWorld", params: { frameId: "F", worldName: "winter" } });
    expect(await c.handle("cdp.send", { tabKey: "101", method: "Runtime.evaluate", params: { contextId: 31, expression: "1" } })).toEqual({ result: { result: { type: "string", value: "ran in 31" } } });
    expect(await code(c.handle("cdp.send", { tabKey: "101", method: "Runtime.evaluate", params: { contextId: 31, expression: "1" }, cdpSessionId: "S1" }))).toBe("not_allowed");
    await c.handle("cdp.send", { tabKey: "101", method: "Page.getFrameTree", params: {}, cdpSessionId: "S1" });
    expect(chrome.calls.at(-1)?.args[0]).toEqual({ tabId: 101, sessionId: "S1" });
  });

  test("a protocol error comes back typed with cdpCode and cdpMessage", async () => {
    chrome.cdp["DOM.getDocument"] = () => { throw new Error(JSON.stringify({ code: -32000, message: "No node with given id found" })); };
    await c.handle("debugger.attach", { tabKey: "101" });
    try {
      await c.handle("cdp.send", { tabKey: "101", method: "DOM.getDocument", params: {} });
      throw new Error("expected a refusal");
    } catch (err) {
      expect(err).toBeInstanceOf(ExtensionError);
      expect(err).toMatchObject({ code: "cdp_error", message: "No node with given id found", data: { cdpCode: -32000, cdpMessage: "No node with given id found" } });
    }
  });
});

describe("events", () => {
  test("forwarded only when subscribed and allowlisted; Network stripped; child sessions named; a winter-NAMED context is not ours", async () => {
    await c.handle("debugger.attach", { tabKey: "101" });
    await c.handle("cdp.send", { tabKey: "101", method: "Runtime.enable", params: {} });
    expect(await code(c.handle("cdp.subscribe", { tabKey: "101", events: ["Page.frameNavigated", "Network.responseReceived"] }))).toBe("not_allowed");
    await c.handle("cdp.subscribe", { tabKey: "101", events: ["Page.frameNavigated", "Network.requestWillBeSent"] });
    chrome.emitCdp(101, "Page.frameNavigated", { frame: { id: "F" } }, "S1");
    chrome.emitCdp(101, "Network.requestWillBeSent", { requestId: "9", timestamp: 1, type: "Fetch", request: { headers: { Cookie: "x" } } });
    chrome.emitCdp(101, "Page.loadEventFired", {});
    chrome.emitCdp(101, "Runtime.consoleAPICalled", { args: [] });
    chrome.emitCdp(100, "Page.frameNavigated", {}); // a tab Winter is not attached to
    chrome.emitCdp(101, "Runtime.executionContextCreated", { context: { id: 44, name: "winter", auxData: { type: "isolated" } } });
    expect(notes).toEqual([
      { method: "cdp.event", params: { tabKey: "101", method: "Page.frameNavigated", params: { frame: { id: "F" } }, cdpSessionId: "S1" } },
      { method: "cdp.event", params: { tabKey: "101", method: "Network.requestWillBeSent", params: { requestId: "9", timestamp: 1, type: "Fetch" } } },
    ]);
    expect(await code(c.handle("cdp.send", { tabKey: "101", method: "Runtime.evaluate", params: { contextId: 44, expression: "1" } }))).toBe("not_allowed");
  });

  test("a crash is tab.gone crashed", async () => {
    await c.handle("debugger.attach", { tabKey: "101" });
    chrome.emitCdp(101, "Inspector.targetCrashed", {});
    expect(notes).toContainEqual({ method: "tab.gone", params: { tabKey: "101", reason: "crashed" } });
  });

  test("the user cancelling the debugging bar → debugger.detached canceled_by_user", async () => {
    await c.handle("debugger.attach", { tabKey: "101" });
    await chrome.userCancelsInfobar(101);
    expect(notes).toEqual([{ method: "debugger.detached", params: { tabKey: "101", reason: "canceled_by_user" } }]);
    expect(c.attachedTabs()).toEqual([]);
  });

  test("a closed tab → tab.gone closed, once", async () => {
    await c.handle("debugger.attach", { tabKey: "101" });
    await chrome.closeTab(101);
    expect(notes.filter((n) => n.method === "tab.gone")).toEqual([{ method: "tab.gone", params: { tabKey: "101", reason: "closed" } }]);
    expect(notes.filter((n) => n.method === "debugger.detached")).toEqual([]);
  });

  test("a detach the page caused (the tab still there) → debugger.detached target_closed", async () => {
    await c.handle("debugger.attach", { tabKey: "101" });
    chrome.attachedDebuggers.delete(101);
    for (const l of chrome.debuggerOnDetach.listeners) l({ tabId: 101 }, "target_closed");
    await flush();
    expect(notes).toEqual([{ method: "debugger.detached", params: { tabKey: "101", reason: "target_closed" } }]);
  });
});

describe("lifetime", () => {
  test("5 minutes without a command detaches (debugger.detached idle); each command restarts the clock", async () => {
    c = await make({ idleDetachMs: 5 * 60_000, launch: null });
    await c.handle("debugger.attach", { tabKey: "101" });
    await clock.advance(4 * 60_000);
    await c.handle("cdp.send", { tabKey: "101", method: "Page.enable", params: {} });
    await clock.advance(4 * 60_000);
    expect(chrome.attachedDebuggers.has(101)).toBe(true);
    await clock.advance(60_001);
    expect(chrome.attachedDebuggers.has(101)).toBe(false);
    expect(notes).toEqual([{ method: "debugger.detached", params: { tabKey: "101", reason: "idle" } }]);
  });

  test("releaseAll (the link to Winter dropped) detaches every tab and removes the overlays", async () => {
    await c.handle("debugger.attach", { tabKey: "100" });
    await c.handle("debugger.attach", { tabKey: "101" });
    await c.handle("overlay", { tabKey: "101", active: true });
    await c.releaseAll();
    expect(chrome.attachedDebuggers.size).toBe(0);
    const last = chrome.calls.filter((x) => x.api === "scripting.executeScript").at(-1);
    expect(last?.args[0]).toMatchObject({ target: { tabId: 101 }, world: "ISOLATED", args: [{ active: false }] });
    expect(notes).toEqual([]);
    expect(driven).toEqual([1, 0]);
  });
});

describe("overlay and Stop", () => {
  test("drawn in the extension's isolated world on a driven tab; never in the page's main world; nothing on an undriven tab", async () => {
    await c.handle("overlay", { tabKey: "101", active: true });
    expect(chrome.calls.filter((x) => x.api === "scripting.executeScript")).toEqual([]);
    await c.handle("debugger.attach", { tabKey: "101" });
    await c.handle("overlay", { tabKey: "101", active: true, cursor: { x: 10, y: 20, kind: "press" } });
    await c.handle("overlay", { tabKey: "101", active: false });
    const calls = chrome.calls.filter((x) => x.api === "scripting.executeScript").map((x) => x.args[0]);
    expect(calls).toEqual([
      { target: { tabId: 101 }, world: "ISOLATED", func: "drawOverlay", args: [{ active: true, cursor: { x: 10, y: 20, kind: "press" } }] },
      { target: { tabId: 101 }, world: "ISOLATED", func: "drawOverlay", args: [{ active: false }] },
    ]);
  });

  test("Stop is the toolbar button: a click while tabs are driven stops Winter in each; with nothing driven it does nothing", async () => {
    chrome.clickAction();
    expect(notes).toEqual([]);
    await c.handle("debugger.attach", { tabKey: "100" });
    await c.handle("debugger.attach", { tabKey: "101" });
    await c.handle("overlay", { tabKey: "101", active: true });
    expect(driven).toEqual([1]);
    chrome.clickAction();
    expect(notes).toEqual([{ method: "stop.pressed", params: { tabKey: "101" } }]);
    await c.handle("overlay", { tabKey: "100", active: true });
    chrome.clickAction();
    expect(notes.slice(1).map((n) => n.params.tabKey).sort()).toEqual(["100", "101"]);
    await c.handle("overlay", { tabKey: "101", active: false });
    await c.handle("debugger.detach", { tabKey: "100" });
    expect(driven).toEqual([1, 2, 1, 0]);
  });
});

test("unknown methods are refused as such", async () => {
  await expect(c.handle("tabs.activate", { tabKey: "101" })).rejects.toThrow();
  await expect(c.handle("windows.focus", {})).rejects.toThrow();
  expect(chrome.viewMovingCalls()).toEqual([]);
});
