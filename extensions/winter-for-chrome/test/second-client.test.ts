// The second client (opensky, next version): its own controller beside Winter's in one browser. It may use only the restricted
// method set, only on the tabs it opened; neither client sees, drives or closes the other's tabs or hears of them
// closing; each keeps its own storage keys and group prefix; the toolbar's Stop stops both; and its connection is its
// own (its own instance id, a stop that never reconnects, a status that never touches the badge).
import { beforeEach, describe, expect, test } from "bun:test";
import { HostConnection } from "../src/connection";
import { ExtensionController, ExtensionError, OPENSKY_CLIENT, SECOND_CLIENT_METHODS } from "../src/controller";
import { OPENSKY_HOST_NAME } from "../src/manifest";
import { SECOND_CLIENT_FEATURES } from "../src/protocol";
import { ClientLink, StatusBoard } from "../src/status";
import { FakeChrome, FakePort, flush, ManualClock } from "./fake-chrome";

let chrome: FakeChrome;
let clock: ManualClock;
let winterNotes: { method: string; params: Record<string, unknown> }[];
let skyNotes: { method: string; params: Record<string, unknown> }[];
let winter: ExtensionController;
let sky: ExtensionController;
let status: StatusBoard;

beforeEach(async () => {
  chrome = new FakeChrome();
  clock = new ManualClock();
  winterNotes = [];
  skyNotes = [];
  status = new StatusBoard(chrome);
  winter = new ExtensionController(chrome, {
    notify: (method, params) => winterNotes.push({ method, params }),
    onDriven: (n) => status.setDriven(n),
    foreignTab: (tabId) => sky.heldTab(tabId),
    foreignGroup: (groupId) => sky.ownsGroup(groupId),
    clock,
    launchHintMs: 1000,
  });
  sky = new ExtensionController(chrome, {
    client: OPENSKY_CLIENT,
    notify: (method, params) => skyNotes.push({ method, params }),
    onDriven: (n) => status.setDriven(n, OPENSKY_CLIENT.name),
    foreignTab: (tabId) => winter.heldTab(tabId),
    foreignGroup: (groupId) => winter.ownsGroup(groupId),
    clock,
    launchHintMs: 1000,
  });
  winter.noteLaunch("install");
  sky.noteLaunch("install");
  await winter.start();
  await sky.start();
});

const code = async (p: Promise<unknown>): Promise<string> => {
  try { await p; return "ok"; } catch (err) { return err instanceof ExtensionError ? err.code : `untyped: ${String(err)}`; }
};
const openIn = async (ctl: ExtensionController, sessionId: string, title = "Book a table"): Promise<string> =>
  ((await ctl.handle("tabs.create", { url: "https://example.com/", sessionId, sessionTitle: title })) as { tab: { tabKey: string } }).tab.tabKey;
const listed = async (ctl: ExtensionController): Promise<string[]> =>
  ((await ctl.handle("tabs.list", {})) as { tabs: { tabKey: string }[] }).tabs.map((t) => t.tabKey).sort();

describe("what a second client may ask", () => {
  test("only the restricted set: no tabs.present, windows, history, bookmarks, downloads or watches", async () => {
    for (const method of ["tabs.present", "windows.list", "history.search", "bookmarks.search", "downloads.arm", "downloads.release", "watch.arm", "watch.cancel"]) {
      expect(SECOND_CLIENT_METHODS.has(method)).toBe(false);
      expect(await code(sky.handle(method, { tabKey: "101" }))).toBe("not_allowed");
    }
    expect(await code(sky.handle("ping", {}))).toBe("ok");
    expect(chrome.viewMovingCalls()).toEqual([]);
  });

  test("only on the tabs it opened: the user's tabs are refused for every tab call, and never listed", async () => {
    for (const method of ["debugger.attach", "cdp.send", "tabs.close", "tabs.mute", "tabs.keep", "overlay", "cdp.subscribe", "debugger.detach"]) {
      expect(await code(sky.handle(method, { tabKey: "101", method: "Runtime.enable", muted: true, active: true, events: [] }))).toBe("not_allowed");
    }
    expect(chrome.attachedDebuggers.has(101)).toBe(false);
    expect(chrome.tabs_.has(101)).toBe(true);
    expect(await listed(sky)).toEqual([]);
    const mine = await openIn(sky, "o_1");
    expect(await listed(sky)).toEqual([mine]);
    expect(await code(sky.handle("debugger.attach", { tabKey: mine }))).toBe("ok");
  });

  test("its group says opensky, and keep() never puts a tab in the user's groups", async () => {
    const mine = await openIn(sky, "o_1", "Book a table");
    expect(chrome.groups_.get(chrome.tabs_.get(Number(mine))!.groupId)?.title).toBe("opensky · Book a table");
    expect(await code(sky.handle("tabs.keep", { tabKey: mine, group: "Work" }))).toBe("not_allowed");
    expect(await code(sky.handle("tabs.keep", { tabKey: mine }))).toBe("ok");
    // Kept: the user's now — opensky can no longer touch it, Winter can.
    expect(await code(sky.handle("debugger.attach", { tabKey: mine }))).toBe("not_allowed");
    expect(await code(winter.handle("debugger.attach", { tabKey: mine }))).toBe("ok");
  });

  test("its working pill names opensky", async () => {
    const mine = await openIn(sky, "o_1");
    await sky.handle("debugger.attach", { tabKey: mine });
    await sky.handle("overlay", { tabKey: mine, active: true });
    const drawn = chrome.calls.filter((x) => x.api === "scripting.executeScript").at(-1)?.args[0] as { args: [{ label?: string }] };
    expect(drawn.args[0].label).toContain("opensky is working");
  });
});

describe("each client's tabs are its own", () => {
  test("Winter neither lists nor drives nor closes opensky's tabs; opensky never sees Winter's", async () => {
    const skyTab = await openIn(sky, "o_1");
    const winterTab = await openIn(winter, "s_1");
    expect(await listed(winter)).not.toContain(skyTab);
    expect(await listed(winter)).toContain(winterTab);
    expect(await listed(sky)).toEqual([skyTab]);
    for (const method of ["debugger.attach", "tabs.close", "tabs.present", "tabs.keep", "cdp.send"]) {
      expect(await code(winter.handle(method, { tabKey: skyTab, method: "Runtime.enable" }))).toBe("not_allowed");
      expect(await code(sky.handle(method, { tabKey: winterTab, method: "Runtime.enable" }))).toBe("not_allowed");
    }
    expect(chrome.tabs_.has(Number(skyTab))).toBe(true);
    expect(chrome.tabs_.has(Number(winterTab))).toBe(true);
  });

  test("a user tab Winter is driving is refused to opensky (attached counts as held)", async () => {
    await winter.handle("debugger.attach", { tabKey: "101" });
    expect(winter.ownsTab(101)).toBe(true);
    expect(await code(sky.handle("cdp.send", { tabKey: "101", method: "Runtime.enable" }))).toBe("not_allowed");
  });

  test("tab.gone goes only to the tab's owner", async () => {
    const skyTab = await openIn(sky, "o_1");
    const winterTab = await openIn(winter, "s_1");
    await chrome.closeTab(Number(skyTab));
    await chrome.closeTab(Number(winterTab));
    await chrome.closeTab(100); // a user tab: Winter hears of it (as before), opensky does not
    await flush();
    expect(skyNotes.filter((n) => n.method === "tab.gone").map((n) => n.params.tabKey)).toEqual([skyTab]);
    expect(winterNotes.filter((n) => n.method === "tab.gone").map((n) => n.params.tabKey)).toEqual([winterTab, "100"]);
  });

  test("separate storage keys: opensky's record is not Winter's", async () => {
    const skyTab = await openIn(sky, "o_1");
    const winterTab = await openIn(winter, "s_1");
    const local = (await chrome.storage.local.get(["winterAgents", "openskyAgents"])) as Record<string, unknown>;
    expect(JSON.stringify(local.winterAgents)).toContain(winterTab);
    expect(JSON.stringify(local.winterAgents)).not.toContain(`${skyTab}`);
    expect(JSON.stringify(local.openskyAgents)).toContain(skyTab);
    await sky.handle("debugger.attach", { tabKey: skyTab });
    const session = (await chrome.storage.session.get(["winterAttached", "openskyAttached", "openskyAlive"])) as Record<string, unknown>;
    expect(session.openskyAttached).toEqual([Number(skyTab)]);
    expect(session.winterAttached ?? []).toEqual([]);
    expect(session.openskyAlive).toBe(true);
  });

  test("disown (the user turned opensky off) releases everything and gives its tabs to the user", async () => {
    const skyTab = await openIn(sky, "o_1");
    await sky.handle("debugger.attach", { tabKey: skyTab });
    await sky.disown();
    expect(chrome.attachedDebuggers.has(Number(skyTab))).toBe(false);
    expect(sky.ownsTab(Number(skyTab))).toBe(false);
    expect(chrome.tabs_.has(Number(skyTab))).toBe(true);
    expect(await listed(winter)).toContain(skyTab);
  });
});

describe("races (the review's findings)", () => {
  test("turned off while an attach is in flight: the debugger is detached again, nothing held", async () => {
    const skyTab = await openIn(sky, "o_1");
    const attaching = code(sky.handle("debugger.attach", { tabKey: skyTab }));
    const off = sky.disown();
    expect(await attaching).toBe("not_allowed");
    await off;
    expect(chrome.attachedDebuggers.has(Number(skyTab))).toBe(false);
    expect(sky.attachedTabs()).toEqual([]);
    expect(sky.ownsTab(Number(skyTab))).toBe(false);
    expect(await code(winter.handle("debugger.attach", { tabKey: skyTab }))).toBe("ok");
  });

  test("turned off while a tab is opening: it is closed again and never recorded", async () => {
    const before = chrome.tabs_.size;
    const opening = code(sky.handle("tabs.create", { url: "https://example.com/", sessionId: "o_1", sessionTitle: "x" }));
    const off = sky.disown();
    expect(await opening).toBe("not_allowed");
    await off;
    await flush();
    expect(chrome.tabs_.size).toBe(before);
    const local = (await chrome.storage.local.get(["openskyAgents"])) as Record<string, unknown>;
    expect(JSON.stringify(local.openskyAgents ?? {})).not.toMatch(/\d{3}/);
    expect(await code(sky.handle("ping", {}))).toBe("not_allowed");
    sky.reopen();
    expect(await code(sky.handle("ping", {}))).toBe("ok");
  });

  test("tab.gone routing does not depend on which controller hears the close first", async () => {
    // A fresh pair whose opensky controller registers its listeners FIRST.
    chrome = new FakeChrome();
    const w: { method: string; params: Record<string, unknown> }[] = [];
    const o: { method: string; params: Record<string, unknown> }[] = [];
    let first!: ExtensionController;
    const skyFirst = new ExtensionController(chrome, { client: OPENSKY_CLIENT, notify: (m, p) => o.push({ method: m, params: p }), foreignTab: (id) => first.heldTab(id), clock, launchHintMs: 1000 });
    first = new ExtensionController(chrome, { notify: (m, p) => w.push({ method: m, params: p }), foreignTab: (id) => skyFirst.heldTab(id), clock, launchHintMs: 1000 });
    skyFirst.noteLaunch("install");
    first.noteLaunch("install");
    await skyFirst.start();
    await first.start();
    const skyTab = await openIn(skyFirst, "o_1");
    const winterTab = await openIn(first, "s_1");
    await chrome.closeTab(Number(skyTab));
    await chrome.closeTab(Number(winterTab));
    await flush();
    expect(w.filter((n) => n.method === "tab.gone").map((n) => n.params.tabKey)).toEqual([winterTab]);
    expect(o.filter((n) => n.method === "tab.gone").map((n) => n.params.tabKey)).toEqual([skyTab]);
  });

  test("Winter's keep({ group }) never joins one of opensky's groups", async () => {
    const skyTab = await openIn(sky, "o_1", "X");
    const skyGroup = chrome.tabs_.get(Number(skyTab))!.groupId;
    const winterTab = await openIn(winter, "s_1");
    await winter.handle("tabs.keep", { tabKey: winterTab, group: "opensky · X" });
    const kept = chrome.tabs_.get(Number(winterTab))!;
    expect(kept.groupId).not.toBe(skyGroup);
    expect(kept.groupId).toBeGreaterThan(0);
  });
});

describe("the toolbar's Stop", () => {
  test("stops every client's driven tabs and names who is working", async () => {
    const skyTab = await openIn(sky, "o_1");
    await sky.handle("debugger.attach", { tabKey: skyTab });
    await sky.handle("overlay", { tabKey: skyTab, active: true });
    expect(status.drivenTabs()).toBe(1);
    expect(status.drivers()).toBe("opensky");
    await winter.handle("debugger.attach", { tabKey: "101" });
    await winter.handle("overlay", { tabKey: "101", active: true });
    expect(status.drivenTabs()).toBe(2);
    expect(status.drivers()).toBe("opensky and Winter");
    const title = chrome.calls.filter((c) => c.api === "action.setTitle").at(-1)?.args[0] as { title: string };
    expect(title.title).toContain("Stop opensky and Winter");
    chrome.clickAction();
    expect(skyNotes.filter((n) => n.method === "stop.pressed")).toEqual([{ method: "stop.pressed", params: { tabKey: skyTab } }]);
    expect(winterNotes.filter((n) => n.method === "stop.pressed")).toEqual([{ method: "stop.pressed", params: { tabKey: "101" } }]);
    await sky.handle("overlay", { tabKey: skyTab, active: false });
    expect(status.drivers()).toBe("Winter");
  });
});

describe("its connection", () => {
  function connect(): { conn: HostConnection; link: ClientLink } {
    const link = new ClientLink(OPENSKY_CLIENT.name);
    const conn = new HostConnection(chrome, sky, link, { hostName: OPENSKY_HOST_NAME.store, instanceKey: "openskyInstanceId", peer: "opensky", features: SECOND_CLIENT_FEATURES, clock });
    return { conn, link };
  }

  test("dials opensky's own host, with its own instance id, and never touches the badge", async () => {
    const { conn, link } = connect();
    const badges = chrome.calls.filter((c) => c.api === "action.setBadgeText").length;
    conn.start();
    expect(chrome.calls.filter((c) => c.api === "runtime.connectNative").at(-1)?.args[0]).toBe("com.opensky.browser");
    const port = chrome.ports.at(-1) as FakePort;
    await port.deliver({ method: "host.status", params: { daemon: "connected" } });
    await flush();
    const hello = port.sent.at(-1) as { params: { instanceId: string; features: string[] } };
    // Offered only what it may use.
    expect(hello.params.features).toEqual(["cdp3", "mute", "group", "tabFacts"]);
    const stored = (await chrome.storage.local.get(["openskyInstanceId", "instanceId"])) as Record<string, unknown>;
    expect(hello.params.instanceId).toBe(stored.openskyInstanceId as string);
    expect(stored.instanceId).toBeUndefined();
    expect(link.get()?.state).toBe("connecting");
    expect(chrome.calls.filter((c) => c.api === "action.setBadgeText").length).toBe(badges);
  });

  test("stop() closes the port, releases every tab, and never reconnects", async () => {
    const { conn, link } = connect();
    conn.start();
    const port = chrome.ports.at(-1) as FakePort;
    const skyTab = await openIn(sky, "o_1");
    await sky.handle("debugger.attach", { tabKey: skyTab });
    await conn.stop();
    expect(port.disconnected).toBe(true);
    expect(chrome.attachedDebuggers.has(Number(skyTab))).toBe(false);
    const dials = chrome.calls.filter((c) => c.api === "runtime.connectNative").length;
    await clock.advance(120_000);
    await flush();
    expect(chrome.calls.filter((c) => c.api === "runtime.connectNative").length).toBe(dials);
    expect(link.sentence()).toContain("opensky");
  });

  test("a refusal from opensky's side names opensky, not Winter", async () => {
    const { conn, link } = connect();
    conn.start();
    const port = chrome.ports.at(-1) as FakePort;
    await port.deliver({ method: "host.status", params: { daemon: "refused" } });
    await flush();
    expect(link.sentence()).toBe("opensky refused the connection");
  });
});
