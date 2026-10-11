// ComputerV2 Phase 3 — managing the agent's OWN tabs: viewport(), mute(), keep({ group }), browsers.group(),
// browsers.windows(), browsers.tab({ active: true }) and the tab rows' lastUsed/group. Over the fake transports (the
// extension's side has its own tests in extensions/winter-for-chrome).
import { describe, expect, test } from "bun:test";
import { AutomationFailure } from "../../src/computer-use/errors";
import type { TabHandle } from "../../src/computer-use/worker/bridge";
import { harness } from "./browser-harness";

async function failure(p: Promise<unknown>): Promise<Error> {
  try { await p; } catch (err) { return err as Error; }
  throw new Error("expected a failure");
}

const keyOf = (t: TabHandle): string => t.id.split(":")[1]!;

describe("viewport()", () => {
  test("emulates a screen size on a tab Winter opened; null clears it; the size is checked", async () => {
    const h = harness();
    const r = h.run();
    const tab = await h.engine.global(r.scope, "browsers.open", { url: "https://a.example/", browser: "chrome" }) as TabHandle;
    await h.engine.primitive(r.scope, tab.targetId, "viewport", { size: { width: 390, height: 844, mobile: true, scale: 3 } });
    expect(h.chrome.tabs.get(keyOf(tab))!.emulated).toEqual({ width: 390, height: 844, mobile: true, scale: 3 });
    const sent = h.chrome.sent.filter((x) => x.method === "Emulation.setDeviceMetricsOverride").at(-1)!.params;
    expect(sent).toEqual({ width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
    await h.engine.primitive(r.scope, tab.targetId, "viewport", { size: null });
    expect(h.chrome.tabs.get(keyOf(tab))!.emulated).toBeUndefined();
    await expect(h.engine.primitive(r.scope, tab.targetId, "viewport", { size: { width: 100, height: 844 } })).rejects.toThrow(/width is a whole number 200–3840/);
    await expect(h.engine.primitive(r.scope, tab.targetId, "viewport", { size: { width: 400, height: 800, scale: 9 } })).rejects.toThrow(/scale is 1–3/);
    await expect(h.engine.primitive(r.scope, tab.targetId, "viewport", { size: "phone" })).rejects.toThrow(/takes \{ width, height/);
    r.end();
  });

  test("a user's own tab (bound, or handed over with keep()) is refused; keep() and the release clear an emulated size first", async () => {
    const h = harness();
    h.chrome.addTab({ url: "https://u.example/", title: "U", nodes: [] }, { tabKey: "7" });
    const r = h.run();
    const user = await h.engine.global(r.scope, "browsers.tab", { tab: "chrome:7" }) as TabHandle;
    const e = await failure(h.engine.primitive(r.scope, user.targetId, "viewport", { size: { width: 400, height: 800 } }));
    expect((e as AutomationFailure).kind).toBe("NotAllowed");
    expect(e.message).toMatch(/viewport\(\) works on a tab you opened/);
    const mine = await h.engine.global(r.scope, "browsers.open", { url: "https://m.example/", browser: "chrome" }) as TabHandle;
    await h.engine.primitive(r.scope, mine.targetId, "viewport", { size: { width: 400, height: 800 } });
    await h.engine.primitive(r.scope, mine.targetId, "keep", {});
    expect(h.chrome.tabs.get(keyOf(mine))!.emulated).toBeUndefined();
    expect((await failure(h.engine.primitive(r.scope, mine.targetId, "viewport", { size: { width: 400, height: 800 } })) as AutomationFailure).kind).toBe("NotAllowed");
    // The built-in browser too: a size set there goes when the tab is let go (its hold ends with the turn), and comes
    // back when the tab is next taken.
    const w = await h.engine.global(r.scope, "browsers.open", { url: "https://w.example/" }) as TabHandle;
    await h.engine.primitive(r.scope, w.targetId, "viewport", { size: { width: 500, height: 900 } });
    expect(h.winter.tabs.get(keyOf(w))!.emulated).toMatchObject({ width: 500, height: 900 });
    r.end();
    h.engine.turnEnded("s1");
    await new Promise((res) => setTimeout(res, 20));
    expect(h.winter.tabs.get(keyOf(w))!.emulated).toBeUndefined();
    const r2 = h.run();
    await h.engine.primitive(r2.scope, w.targetId, "state", { emit: false });
    expect(h.winter.tabs.get(keyOf(w))!.emulated).toMatchObject({ width: 500, height: 900 });
    await h.engine.primitive(r2.scope, w.targetId, "viewport", { size: null });
    r2.end();
    h.engine.turnEnded("s1");
    await new Promise((res) => setTimeout(res, 20));
    const r3 = h.run();
    await h.engine.primitive(r3.scope, w.targetId, "state", { emit: false });
    expect(h.winter.tabs.get(keyOf(w))!.emulated).toBeUndefined();
    r3.end();
  });
});

describe("mute()", () => {
  test("mutes and unmutes a tab Winter opened in the user's browser; refuses a user's tab; an older extension or the built-in browser says so", async () => {
    const h = harness();
    const r = h.run();
    const tab = await h.engine.global(r.scope, "browsers.open", { url: "https://a.example/", browser: "chrome" }) as TabHandle;
    await h.engine.primitive(r.scope, tab.targetId, "mute", {});
    expect(h.chrome.tabs.get(keyOf(tab))!.muted).toBe(true);
    await h.engine.primitive(r.scope, tab.targetId, "mute", { on: false });
    expect(h.chrome.tabs.get(keyOf(tab))!.muted).toBe(false);
    await expect(h.engine.primitive(r.scope, tab.targetId, "mute", { on: "loud" })).rejects.toThrow(/true \(the default\) or false/);
    h.chrome.addTab({ url: "https://u.example/", title: "U", nodes: [] }, { tabKey: "8" });
    const user = await h.engine.global(r.scope, "browsers.tab", { tab: "chrome:8" }) as TabHandle;
    expect((await failure(h.engine.primitive(r.scope, user.targetId, "mute", {})) as AutomationFailure).kind).toBe("NotAllowed");
    const w = await h.engine.global(r.scope, "browsers.open", { url: "https://w.example/" }) as TabHandle;
    await h.engine.primitive(r.scope, w.targetId, "mute", {});
    expect(h.winter.tabs.get(keyOf(w))!.muted).toBe(true);
    delete h.winter.setMuted;
    await expect(h.engine.primitive(r.scope, w.targetId, "mute", {})).rejects.toThrow(/built-in browser can't mute a tab yet/);
    delete h.chrome.setMuted;
    const old = await failure(h.engine.primitive(r.scope, tab.targetId, "mute", {}));
    expect((old as AutomationFailure).kind).toBe("BrowserUnavailable");
    expect(old.message).toMatch(/too old for mute\(\)/);
    r.end();
  });

  test("mute() and viewport() act: a view-only Chrome refuses them by its access, before anything else", async () => {
    const view = harness({ apps: { "com.google.Chrome": { access: "view" } } });
    view.chrome.addTab({ url: "https://v.example/", title: "V", nodes: [] }, { tabKey: "9" });
    const vr = view.run();
    const vt = await view.engine.global(vr.scope, "browsers.tab", { tab: "chrome:9" }) as TabHandle;
    for (const [primitive, args] of [["mute", {}], ["viewport", { size: { width: 400, height: 800 } }]] as const) {
      const e = await failure(view.engine.primitive(vr.scope, vt.targetId, primitive, args));
      expect((e as AutomationFailure).kind).toBe("NotAllowed");
      expect(e.message).not.toMatch(/works on a tab you opened/);
    }
    vr.end();
  });
});

describe("keep({ group })", () => {
  test("hands the tab over into the user's group of that name; the built-in browser and an older extension say what they did", async () => {
    const h = harness();
    const r = h.run();
    const a = await h.engine.global(r.scope, "browsers.open", { url: "https://a.example/", browser: "chrome" }) as TabHandle;
    await h.engine.primitive(r.scope, a.targetId, "keep", { group: "  Trip  " });
    expect(h.chrome.tabs.get(keyOf(a))).toMatchObject({ kept: true, keptGroup: "Trip" });
    const b = await h.engine.global(r.scope, "browsers.open", { url: "https://b.example/", browser: "chrome" }) as TabHandle;
    await expect(h.engine.primitive(r.scope, b.targetId, "keep", { group: "  " })).rejects.toThrow(/keep\(\)'s group is a name/);
    h.chrome.features!.delete("keepGroup");
    await h.engine.primitive(r.scope, b.targetId, "keep", { group: "Trip" });
    const w = await h.engine.global(r.scope, "browsers.open", { url: "https://w.example/" }) as TabHandle;
    await h.engine.primitive(r.scope, w.targetId, "keep", { group: "Trip" });
    expect(r.text()).toContain("kept — but this Winter for Chrome is too old to put it in a group");
    expect(r.text()).toContain("kept — Winter's built-in browser has no tab groups");
    r.end();
  });
});

describe("browsers.group()", () => {
  test("names, colors or folds this session's group in the one user browser allowed; checked before anything is sent", async () => {
    const h = harness();
    const r = h.run();
    await h.engine.global(r.scope, "browsers.open", { url: "https://a.example/", browser: "chrome" });
    await h.engine.global(r.scope, "browsers.group", { title: "  Flights ", color: "green", collapsed: true });
    expect(h.chrome.groupUpdates).toEqual([{ sessionId: "s1", title: "Flights", color: "green", collapsed: true }]);
    await expect(h.engine.global(r.scope, "browsers.group", { color: "black" })).rejects.toThrow(/color is one of grey, blue/);
    await expect(h.engine.global(r.scope, "browsers.group", {})).rejects.toThrow(/takes a title, color or collapsed/);
    await expect(h.engine.global(r.scope, "browsers.group", { browser: "winter", title: "x" })).rejects.toThrow(/built-in browser has no tab groups/);
    expect(h.chrome.groupUpdates).toHaveLength(1);
    delete h.chrome.updateGroup;
    expect((await failure(h.engine.global(r.scope, "browsers.group", { title: "x" })) as AutomationFailure).kind).toBe("BrowserUnavailable");
    r.end();
  });

  test("with no user browser allowed in the session it asks for one; in chat it is not available", async () => {
    const h = harness({ policy: "dont-ask" });
    const r = h.run();
    await expect(h.engine.global(r.scope, "browsers.group", { title: "x" })).rejects.toThrow(/name the user's browser with \{ browser \}/);
    r.end();
    const chat = harness({ facts: { mode: "chat", policy: "chat" } });
    const cr = chat.run();
    const e = await failure(chat.engine.global(cr.scope, "browsers.group", { browser: "chrome", title: "x" }));
    expect((e as AutomationFailure).kind).toBe("NotAllowed");
    cr.end();
  });
});

describe("browsers.windows() and the tab rows' facts", () => {
  test("lists the user's browser's windows, after the same check as listing its tabs", async () => {
    const h = harness();
    const r = h.run();
    h.chrome.windows = [{ id: 1, focused: true, tabs: 3 }, { id: 4, focused: false, tabs: 1 }];
    const rows = await h.engine.global(r.scope, "browsers.windows", { browser: "chrome" });
    expect(rows).toEqual([{ browser: "chrome", id: 1, focused: true, tabs: 3 }, { browser: "chrome", id: 4, focused: false, tabs: 1 }]);
    expect(r.text()).toContain("chrome window 1 — 3 tabs (in front)\nchrome window 4 — 1 tab");
    await expect(h.engine.global(r.scope, "browsers.windows", { browser: "winter" })).rejects.toThrow(/built-in browser has no windows/);
    r.end();
    const asks = harness({ policy: "ask" });
    const ar = asks.run();
    const pending = asks.engine.global(ar.scope, "browsers.windows", { browser: "chrome" });
    await new Promise((res) => setTimeout(res, 10));
    expect(asks.cards.map((c) => c.summary)).toEqual(["Allow Winter to use Google Chrome (com.google.Chrome)?"]);
    ar.end();
    await pending.catch(() => undefined);
  });

  test("tabs() rows carry lastUsed (ISO) and the group's title, redacted; tab({ active: true }) binds the one the user has in front", async () => {
    const h = harness();
    const old = h.chrome.addTab({ url: "https://old.example/", title: "Old", nodes: [] }, { tabKey: "20" });
    old.active = true;
    old.lastAccessed = Date.UTC(2026, 9, 1);
    const front = h.chrome.addTab({ url: "https://front.example/", title: "Front", nodes: [] }, { tabKey: "21" });
    front.active = true;
    front.lastAccessed = Date.UTC(2026, 9, 11, 9, 30);
    front.group = "Work sk-abcdefghijklmnopqrstuvwx";
    const r = h.run();
    const rows = await h.engine.global(r.scope, "browsers.tabs", { browser: "chrome", emit: false }) as Array<{ id: string; lastUsed?: string; group?: string }>;
    expect(rows.find((x) => x.id === "chrome:21")).toMatchObject({ lastUsed: "2026-10-11T09:30:00.000Z", group: "Work <redacted>" });
    const bound = await h.engine.global(r.scope, "browsers.tab", { tab: { active: true }, browser: "chrome" }) as TabHandle;
    expect(bound.id).toBe("chrome:21");
    await expect(h.engine.global(r.scope, "browsers.tab", { tab: { active: true }, browser: "winter" })).rejects.toThrow(/is for a user's browser/);
    r.end();
  });
});
