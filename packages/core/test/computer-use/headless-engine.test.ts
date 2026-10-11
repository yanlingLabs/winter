// ComputerV2 Phase 4 — the `headless` family threaded through the browser engine, over a FAKE headless backend: Winter's
// own (no per-app card, `plan` observe-only), the private-network rule (D4), D2's tab lifecycle (closed at the turn's
// end unless handoff(), keep() refused, closed and disposed when the runtime ends), the engine option, the budget read
// as TargetBusy, and the listing.
import { describe, expect, test } from "bun:test";
import { HEADLESS_KEEP } from "../../src/computer-use/browser/engine";
import { HEADLESS_LAN_REFUSAL } from "../../src/computer-use/browser/headless/private-network";
import { TransportError } from "../../src/computer-use/browser/transport";
import { AutomationFailure } from "../../src/computer-use/errors";
import type { TabHandle } from "../../src/computer-use/worker/bridge";
import { harness } from "./browser-harness";

async function failure(p: Promise<unknown>): Promise<AutomationFailure | Error> {
  try { await p; } catch (err) { return err as Error; }
  throw new Error("expected a failure");
}

const keyOf = (t: TabHandle): string => t.id.split(":")[1]!;

function withHeadless(o: Parameters<typeof harness>[0] = {}) {
  const ended: string[] = [];
  const h = harness({ ...o, headless: true, engineDeps: { headlessSessionEnded: (sid) => ended.push(sid), headlessReason: () => "turned off in Settings", ...o.engineDeps } });
  return { ...h, ended };
}

describe("the headless row", () => {
  test("listed second, after Winter's own browser; a disconnected one gives the pool's reason", () => {
    const h = withHeadless();
    expect(h.engine.listRows().map((r) => r.id).slice(0, 2)).toEqual(["winter", "headless"]);
    expect(h.engine.listRows()[1]).toEqual({ id: "headless", name: "Winter (headless)", isDefault: false, connected: true });
    h.headless.connected = false;
    expect(h.engine.listRows()[1]).toEqual({ id: "headless", name: "Winter (headless)", isDefault: false, connected: false, reason: "turned off in Settings" });
  });

  test("not listed at all where no pool is registered", () => {
    expect(harness().engine.listRows().some((r) => r.id === "headless")).toBe(false);
  });
});

describe("Winter's own browser: no card, plan observe-only", () => {
  test("open under ask raises no per-app card; the daemon line says nobody sees it; every primitive is metered as headless", async () => {
    const h = withHeadless({ policy: "ask" });
    const r = h.run();
    const tab = await h.engine.global(r.scope, "browsers.open", { url: "https://a.example/", browser: "headless" }) as TabHandle;
    expect(h.cards).toEqual([]);
    expect(tab.browser).toBe("headless");
    expect(r.text()).toContain("opened a new tab in Winter's headless browser (nobody sees it)");
    expect(h.headless.tabs.get(keyOf(tab))?.agent).toBe(true);
    await h.engine.primitive(r.scope, tab.targetId, "state", { emit: false });
    expect(r.metric.headlessEngine).toBe("winter");
    expect(r.metric.backend).toBe("headless");
    r.end();
  });

  test("plan: opening and acting are refused, reading works", async () => {
    const h = withHeadless({ policy: "bypass" });
    const r = h.run();
    const tab = await h.engine.global(r.scope, "browsers.open", { url: "https://a.example/", browser: "headless" }) as TabHandle;
    h.facts.policy = "plan";
    expect((await failure(h.engine.global(r.scope, "browsers.open", { url: "https://b.example/", browser: "headless" })) as AutomationFailure).kind).toBe("NotAllowed");
    expect((await failure(h.engine.primitive(r.scope, tab.targetId, "goto", { url: "https://c.example/" })) as AutomationFailure).kind).toBe("NotAllowed");
    await h.engine.primitive(r.scope, tab.targetId, "url", {});
    r.end();
  });

  test("the user-browser-only calls name the headless browser", async () => {
    const h = withHeadless();
    const r = h.run();
    expect((await failure(h.engine.global(r.scope, "browsers.windows", { browser: "headless" }))).message).toBe("Winter's headless browser has no windows — name a user's browser (browsers.list())");
    expect((await failure(h.engine.global(r.scope, "browsers.history", { browser: "headless" }))).message).toBe("Winter's headless browser keeps no history or bookmarks");
    expect((await failure(h.engine.global(r.scope, "browsers.tab", { tab: { active: true }, browser: "headless" }))).message).toMatch(/is for a user's browser — bind a headless tab by its id/);
    r.end();
  });
});

describe("the local network (D4)", () => {
  test("a LAN URL is refused before anything opens; this Mac is allowed", async () => {
    const h = withHeadless();
    const r = h.run();
    for (const url of ["http://192.168.1.1/", "http://10.0.0.5:8080/admin", "http://nas.local/", "http://router/", "http://[fd00::1]/"]) {
      const e = await failure(h.engine.global(r.scope, "browsers.open", { url, browser: "headless" }));
      expect((e as AutomationFailure).kind).toBe("NotAllowed");
      expect(e.message).toBe(HEADLESS_LAN_REFUSAL);
    }
    expect(h.headless.tabs.size).toBe(0);
    await h.engine.global(r.scope, "browsers.open", { url: "http://localhost:3000/", browser: "headless" });
    await h.engine.global(r.scope, "browsers.open", { url: "http://127.0.0.1:5173/", browser: "headless" });
    // The built-in browser keeps reaching the LAN (a user's router page is theirs to open there).
    await h.engine.global(r.scope, "browsers.open", { url: "http://192.168.1.1/" });
    r.end();
  });

  test("goto onto the LAN is refused; a tab that lands there (a redirect) is read and acted on no further", async () => {
    const h = withHeadless();
    h.headless.pages["https://pub.example/"] = { url: "http://192.168.1.10/", title: "Router", nodes: [{ id: 1, role: "button", name: "Reboot" }] };
    const r = h.run();
    const ok = await h.engine.global(r.scope, "browsers.open", { url: "https://a.example/", browser: "headless" }) as TabHandle;
    const e = await failure(h.engine.primitive(r.scope, ok.targetId, "goto", { url: "http://172.16.0.1/" }));
    expect(e.message).toBe(HEADLESS_LAN_REFUSAL);
    const landed = await failure(h.engine.global(r.scope, "browsers.open", { url: "https://pub.example/", browser: "headless" }));
    expect((landed as AutomationFailure).kind).toBe("NotAllowed");
    expect(landed.message).toMatch(/^Winter's headless browser doesn't open pages on the local network .*This tab is on one — only .* work on it until it navigates away$/);
    r.end();
  });
});

describe("the tab lifecycle (D2)", () => {
  test("keep() is refused; waitForUser, download and unmuting are refused; mute() is fine", async () => {
    const h = withHeadless();
    const r = h.run();
    const tab = await h.engine.global(r.scope, "browsers.open", { url: "https://a.example/", browser: "headless" }) as TabHandle;
    const keep = await failure(h.engine.primitive(r.scope, tab.targetId, "keep", {}));
    expect((keep as AutomationFailure).kind).toBe("NotAllowed");
    expect(keep.message).toBe(HEADLESS_KEEP);
    expect((await failure(h.engine.primitive(r.scope, tab.targetId, "waitForUser", { reason: "sign in" }))).message).toMatch(/^nobody can see a headless tab/);
    expect((await failure(h.engine.primitive(r.scope, tab.targetId, "download", { target: { url: "https://a.example/f.zip" } }))).message).toMatch(/^Winter's headless browser doesn't download files/);
    expect((await failure(h.engine.primitive(r.scope, tab.targetId, "mute", { on: false }))).message).toBe("a headless tab never plays sound");
    await h.engine.primitive(r.scope, tab.targetId, "mute", {});
    r.end();
  });

  test("tabs close at the end of each main-thread turn unless handoff() kept one for the next turn", async () => {
    const h = withHeadless();
    const r = h.run();
    const plain = await h.engine.global(r.scope, "browsers.open", { url: "https://a.example/", browser: "headless" }) as TabHandle;
    const handed = await h.engine.global(r.scope, "browsers.open", { url: "https://b.example/", browser: "headless" }) as TabHandle;
    await h.engine.primitive(r.scope, handed.targetId, "handoff", {});
    r.end();
    h.engine.turnEnded("s1");
    expect(h.headless.tabs.get(keyOf(plain))?.closed).toBe(true);
    expect(h.headless.tabs.get(keyOf(handed))?.closed).toBe(false);
    const r2 = h.run();
    await h.engine.primitive(r2.scope, handed.targetId, "state", { emit: false });
    expect((await failure(h.engine.primitive(r2.scope, plain.targetId, "state", {})) as AutomationFailure).kind).toBe("TargetLost");
    r2.end();
    h.engine.turnEnded("s1");
    expect(h.headless.tabs.get(keyOf(handed))?.closed).toBe(true);
  });

  test("a headless tab is closed at the turn's end even while the pool is not offered (it never stays counted)", async () => {
    const h = withHeadless();
    const r = h.run();
    const tab = await h.engine.global(r.scope, "browsers.open", { url: "https://a.example/", browser: "headless" }) as TabHandle;
    r.end();
    h.headless.connected = false;
    const asked: string[] = [];
    h.headless.closeTab = async (tabKey: string) => { asked.push(tabKey); };
    h.engine.turnEnded("s1");
    expect(asked).toEqual([keyOf(tab)]);
  });

  test("the runtime idling out or the session deleted closes the session's headless tabs and disposes its context; the daemon's stop does neither", async () => {
    for (const reason of ["idle", "deleted"] as const) {
      const h = withHeadless();
      const r = h.run();
      const tab = await h.engine.global(r.scope, "browsers.open", { url: "https://a.example/", browser: "headless" }) as TabHandle;
      const user = await h.engine.global(r.scope, "browsers.open", { url: "https://u.example/", browser: "chrome" }) as TabHandle;
      r.end();
      h.engine.sessionEnded("s1", reason);
      expect(h.headless.tabs.get(keyOf(tab))?.closed).toBe(true);
      expect(h.ended).toEqual(["s1"]);
      // An agent tab in a user's browser stays through an idle end (only a deletion closes it).
      expect(h.chrome.tabs.get(keyOf(user))?.closed).toBe(reason === "deleted");
    }
    const h = withHeadless();
    const r = h.run();
    const tab = await h.engine.global(r.scope, "browsers.open", { url: "https://a.example/", browser: "headless" }) as TabHandle;
    r.end();
    h.engine.sessionEnded("s1", "stop");
    expect(h.headless.tabs.get(keyOf(tab))?.closed).toBe(false);
    expect(h.ended).toEqual([]);
  });

  test("a crashed headless tab reads why, and what to do", async () => {
    const h = withHeadless();
    const r = h.run();
    const tab = await h.engine.global(r.scope, "browsers.open", { url: "https://a.example/", browser: "headless" }) as TabHandle;
    h.headless.goneTab(keyOf(tab), "crashed");
    const e = await failure(h.engine.primitive(r.scope, tab.targetId, "state", {}));
    expect((e as AutomationFailure).kind).toBe("TargetLost");
    expect(e.message).toBe("Winter's headless browser stopped (or this tab's page crashed) — open the page again with browsers.open()");
    r.end();
  });
});

describe("listing and binding", () => {
  test("browsers.tabs() lists the session's headless tabs with no card; browsers.tab binds one again by its id", async () => {
    const h = withHeadless({ policy: "ask" });
    const r = h.run();
    const tab = await h.engine.global(r.scope, "browsers.open", { url: "https://a.example/", browser: "headless" }) as TabHandle;
    const rows = await h.engine.global(r.scope, "browsers.tabs", { emit: false }) as Array<{ id: string; browser: string; yours: boolean }>;
    expect(rows.find((x) => x.browser === "headless")).toMatchObject({ id: tab.id, yours: true });
    const again = await h.engine.global(r.scope, "browsers.tab", { tab: tab.id }) as TabHandle;
    expect(again.targetId).toBe(tab.targetId);
    expect(h.cards).toEqual([]);
    r.end();
  });
});

describe("the engine option and the budget", () => {
  test("engine is for the headless browser, and only Winter's own is offered", async () => {
    const h = withHeadless();
    const r = h.run();
    expect((await failure(h.engine.global(r.scope, "browsers.open", { url: "https://a.example/", browser: "chrome", engine: "winter" }))).message).toBe('{ engine } is for { browser: "headless" }');
    expect((await failure(h.engine.global(r.scope, "browsers.open", { url: "https://a.example/", browser: "headless", engine: "chrome" }))).message).toBe('no headless engine "chrome" — the engines are: winter');
    await h.engine.global(r.scope, "browsers.open", { url: "https://a.example/", browser: "headless", engine: "winter" });
    r.end();
  });

  test("the pool's budget (capacity) reads as TargetBusy with its sentence; nothing is let go for it", async () => {
    const h = withHeadless();
    const r = h.run();
    h.headless.createTab = async () => { throw new TransportError("capacity", "this session already has 8 headless tabs open — close one with tab.close()"); };
    const e = await failure(h.engine.global(r.scope, "browsers.open", { url: "https://a.example/", browser: "headless" }));
    expect((e as AutomationFailure).kind).toBe("TargetBusy");
    expect(e.message).toBe("this session already has 8 headless tabs open — close one with tab.close()");
    r.end();
  });

  test("headless tabs neither count toward the built-in browser's hold caps nor are let go for them", async () => {
    const h = withHeadless();
    const r = h.run();
    for (let i = 0; i < 10; i++) await h.engine.global(r.scope, "browsers.open", { url: `https://a.example/${i}`, browser: "headless" });
    expect(r.text()).not.toContain("let go of");
    r.end();
  });
});
