// ComputerV2 — wake triggers on browser tabs (`browser/wake/backend.ts`), over the fake transports (which enforce the CDP
// allowlist and the world rules, and play the page watcher's ops): the debugger path (Winter's built-in browser, a
// Winter for Chrome older than 1.2.0, an element in a child frame) and Winter for Chrome 1.2.0's debugger-free path.
// The real watcher in a real browser: `scripts/browser-e2e/` (opt-in).
import { describe, expect, test } from "bun:test";
import { shouldCloseAgentTab } from "../../src/computer-use/browser/lifecycle";
import { SECURE_FIELD_SENTENCE, TabDriver } from "../../src/computer-use/browser/tab-driver";
import { BrowserWakeBackend, WAKE_HEADLESS, WAKE_IN_FRAME_NOTE, WAKE_OLD_EXTENSION_NOTE, wakePill } from "../../src/computer-use/browser/wake/backend";
import type { FakePage } from "./browser-fake-transport";
import { AutomationFailure } from "../../src/computer-use/errors";
import type { TabHandle } from "../../src/computer-use/worker/bridge";
import type { WakeBackendEvent, WakeCondition } from "../../src/computer-use/wakes/types";
import { harness, type HarnessOpts } from "./browser-harness";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let n = 0;
const wakeId = (): string => `wk_${(++n).toString(16).padStart(12, "0")}`;

function page(url: string, extra: Partial<FakePage> = {}): FakePage {
  return {
    url, title: "Developer Dashboard",
    nodes: [
      { id: 1, role: "heading", name: "Dashboard" },
      { id: 2, role: "button", name: "Submit for review" },
      { id: 3, role: "text field", name: "Email" },
      { id: 4, role: "form", name: "Signup", children: [{ id: 5, role: "button", name: "Send" }] },
      { id: 6, role: "text field", name: "Password" },
    ],
    secure: [6],
    ...extra,
  };
}

function setup(o: HarnessOpts = {}) {
  const h = harness(o);
  const backend = new BrowserWakeBackend(h.engine, { pollMs: 40, recoverMs: 1_500 });
  const events: WakeBackendEvent[] = [];
  const r = h.run();
  const arm = (targetId: string, condition: WakeCondition, id = wakeId(), sessionId = "s1") =>
    backend.arm({ wakeId: id, sessionId, targetId, condition, expiresAt: Date.now() + 3_600_000 }, (e) => events.push(e));
  const refOf = async (targetId: string, name: string, scope = r.scope): Promise<string> => {
    const found = await h.engine.primitive(scope, targetId, "find", { query: name, emit: false }) as Array<{ ref: number; name?: string }>;
    const hit = found.find((f) => f.name === name);
    if (hit === undefined) throw new Error(`no ${name}`);
    return String(hit.ref);
  };
  const until = async (pred: () => boolean, ms = 2_000): Promise<boolean> => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (pred()) return true; await sleep(10); }
    return pred();
  };
  /** The built-in browser's tab on `url` (its page served by the fake). */
  const winterTab = async (url = "https://app.example/", extra: Partial<FakePage> = {}): Promise<TabHandle> => {
    h.winter.pages[url] = page(url, extra);
    return await h.engine.global(r.scope, "browsers.open", { url }) as TabHandle;
  };
  /** A tab of the USER's own in Chrome, bound. */
  const userTab = async (key = "7", url = "https://u.example/", extra: Partial<FakePage> = {}): Promise<TabHandle> => {
    h.chrome.addTab(page(url, extra), { tabKey: key });
    return await h.engine.global(r.scope, "browsers.tab", { tab: `chrome:${key}` }) as TabHandle;
  };
  return { h, backend, events, r, arm, refOf, until, winterTab, userTab };
}

async function failure(p: Promise<unknown>): Promise<AutomationFailure> {
  try { await p; } catch (err) { return err as AutomationFailure; }
  throw new Error("expected a failure");
}
const keyOf = (t: TabHandle): string => t.id.split(":")[1]!;

describe("the debugger path — Winter's built-in browser", () => {
  test("clicked: armed with the element's label, the hold kept past the turn's end, the user's click fires it, and the hold goes after", async () => {
    const s = setup();
    const tab = await s.winterTab();
    const ref = await s.refOf(tab.targetId, "Submit for review");
    const armed = await s.arm(tab.targetId, { kind: "clicked", ref });
    expect(armed).toEqual({ element: { role: "button", name: "Submit for review" }, targetLabel: "Winter's browser — Developer Dashboard", rebind: `browsers.tab("${tab.id}")` });
    expect(s.h.winter.wakes.pills(keyOf(tab))).toEqual(["Winter continues when you click “Submit for review”"]);
    s.r.end();
    s.h.engine.turnEnded("s1");
    await sleep(30);
    // The built-in tab's hold stays while armed (the turn's end let go of the session's own only).
    expect(s.h.winter.tabs.get(keyOf(tab))!.attached).toBe(true);
    s.h.winter.wakes.user(keyOf(tab), { type: "click", id: 2 });
    expect(await s.until(() => s.events.length > 0)).toBe(true);
    expect(s.events[0]).toMatchObject({ outcome: "fired", detail: "clicked" });
    await sleep(30);
    expect(s.h.winter.tabs.get(keyOf(tab))!.attached).toBe(false);
    expect(s.backend.armedIds()).toEqual([]);
  });

  test("WINTER'S OWN INPUT never counts: its click on the element (any session) and what lands within 500 ms after are dropped; the user's later click fires", async () => {
    const s = setup();
    const tab = await s.winterTab();
    const ref = await s.refOf(tab.targetId, "Submit for review");
    await s.arm(tab.targetId, { kind: "clicked", ref });
    // Winter's own click through the engine: the page sees a trusted click on the element.
    await s.h.engine.primitive(s.r.scope, tab.targetId, "click", { target: Number(ref) });
    s.h.winter.wakes.user(keyOf(tab), { type: "click", id: 2, at: Date.now() + 200 });
    await sleep(150);
    expect(s.events).toEqual([]);
    s.h.winter.wakes.user(keyOf(tab), { type: "click", id: 2, at: Date.now() + 1_000 });
    expect(await s.until(() => s.events.length > 0)).toBe(true);
    expect(s.events[0]).toMatchObject({ outcome: "fired", detail: "clicked" });
  });

  test("ALREADY TRUE AT ARM is refused NotAllowed in the daemon's words (appeared, gone, titled, url)", async () => {
    const s = setup();
    const tab = await s.winterTab();
    const e1 = await failure(s.arm(tab.targetId, { kind: "appeared", text: "Dashboard" }));
    expect([e1.kind, e1.message]).toEqual(["NotAllowed", "“Dashboard” is already shown in this tab — nothing to wait for; check state()"]);
    const e2 = await failure(s.arm(tab.targetId, { kind: "gone", text: "Nowhere" }));
    expect([e2.kind, e2.message]).toEqual(["NotAllowed", "“Nowhere” isn't shown in this tab — nothing to wait for; check state()"]);
    const e3 = await failure(s.arm(tab.targetId, { kind: "titled", title: "Developer" }));
    expect([e3.kind, e3.message]).toEqual(["NotAllowed", "this tab's title already contains “Developer” — nothing to wait for; check title()"]);
    const e4 = await failure(s.arm(tab.targetId, { kind: "navigated", url: "app.example" }));
    expect([e4.kind, e4.message]).toEqual(["NotAllowed", "this tab's address already contains “app.example” — nothing to wait for; check url()"]);
    const ref = await s.refOf(tab.targetId, "Email");
    s.h.winter.tabs.get(keyOf(tab))!.page.nodes = s.h.winter.tabs.get(keyOf(tab))!.page.nodes.filter((x) => x.id !== 3);
    const e5 = await failure(s.arm(tab.targetId, { kind: "gone", ref }));
    expect([e5.kind, e5.message]).toEqual(["NotAllowed", `[${ref}] is already gone from this tab — nothing to wait for; check state()`]);
    expect(s.backend.armedIds()).toEqual([]);
  });

  test("state conditions fire on a false→true transition only; one that lands during Winter's own act is the baseline", async () => {
    const s = setup();
    const tab = await s.winterTab();
    const t = s.h.winter.tabs.get(keyOf(tab))!;
    await s.arm(tab.targetId, { kind: "appeared", text: "Saved" });
    // Winter's own click makes "Saved" appear: not the user's — the baseline.
    s.h.winter.onSend = (method, params) => {
      if (method === "Input.dispatchMouseEvent" && params.type === "mouseReleased") { t.page.text = "Saved"; s.h.winter.wakes.recheck(keyOf(tab)); }
    };
    await s.h.engine.primitive(s.r.scope, tab.targetId, "click", { target: Number(await s.refOf(tab.targetId, "Email")) });
    s.h.winter.onSend = undefined;
    await sleep(150);
    expect(s.events).toEqual([]);
    // It goes, and comes back by itself (an upload finishing): that is the transition.
    t.page.text = "Uploading…";
    s.h.winter.wakes.recheck(keyOf(tab));
    await sleep(600);
    t.page.text = "Upload complete — Saved";
    s.h.winter.wakes.recheck(keyOf(tab));
    expect(await s.until(() => s.events.length > 0)).toBe(true);
    expect(s.events[0]).toMatchObject({ outcome: "fired", detail: "appeared" });
  });

  test("titled fires with the title redacted; gone (an element) fires when it goes; changed fires with no value in it; submitted fires for any form", async () => {
    const s = setup();
    const tab = await s.winterTab();
    const t = s.h.winter.tabs.get(keyOf(tab))!;
    const titled = wakeId();
    await s.arm(tab.targetId, { kind: "titled", title: "Done" }, titled);
    const gone = wakeId();
    await s.arm(tab.targetId, { kind: "gone", ref: await s.refOf(tab.targetId, "Dashboard") }, gone);
    const changed = wakeId();
    await s.arm(tab.targetId, { kind: "changed", ref: await s.refOf(tab.targetId, "Email"), settleMs: 1_500 }, changed);
    const form = wakeId();
    await s.arm(tab.targetId, { kind: "submitted" }, form);
    expect(s.h.winter.wakes.pills(keyOf(tab)).sort()).toEqual([
      "Winter continues when this page's title changes", "Winter continues when you change “Email”", "Winter continues when you submit a form on this page", "Winter continues when “Dashboard” goes away",
    ].sort());
    t.page.title = "Done — token sk-abcdefghijklmnopqrstuvwxyz";
    t.page.nodes = t.page.nodes.filter((x) => x.id !== 1);
    s.h.winter.wakes.recheck(keyOf(tab));
    s.h.winter.wakes.user(keyOf(tab), { type: "change", id: 3, value: "me@private.example" });
    s.h.winter.wakes.user(keyOf(tab), { type: "submit" });
    expect(await s.until(() => s.events.length === 4)).toBe(true);
    const by = (id: string) => s.events.find((e) => e.wakeId === id)!;
    expect(by(titled)).toMatchObject({ outcome: "fired", detail: "title now “Done — token <redacted>”" });
    expect(by(gone)).toMatchObject({ outcome: "fired", detail: "gone" });
    expect(by(changed)).toMatchObject({ outcome: "fired", detail: "changed" });
    expect(JSON.stringify(s.events)).not.toContain("private.example");
    expect(by(form)).toMatchObject({ outcome: "fired", detail: "submitted the form" });
  });

  test("navigated: the page's own navigation fires (its URL redacted); Winter's own goto is the new baseline; a same-document change counts", async () => {
    const s = setup();
    const tab = await s.winterTab();
    const any = wakeId();
    await s.arm(tab.targetId, { kind: "navigated" }, any);
    await s.h.engine.primitive(s.r.scope, tab.targetId, "goto", { url: "https://app.example/step2" });
    await sleep(100);
    expect(s.events).toEqual([]);
    // Past the 500 ms grace after Winter's own navigation: the page moves by itself.
    await sleep(500);
    s.h.winter.navigateTo(keyOf(tab), "https://app.example/done?token=abc123&x=1");
    expect(await s.until(() => s.events.length > 0)).toBe(true);
    expect(s.events[0]).toMatchObject({ wakeId: any, outcome: "fired", detail: "now at https://app.example/done?token=<redacted>&x=1" });
    // { url }: a same-document move to it counts.
    const want = wakeId();
    await s.arm(tab.targetId, { kind: "navigated", url: "#review" }, want);
    s.h.winter.wakes.sameDocument(keyOf(tab), "https://app.example/done#review");
    expect(await s.until(() => s.events.length > 1)).toBe(true);
    expect(s.events[1]).toMatchObject({ wakeId: want, outcome: "fired" });
  });

  test("a ref condition's document going away is lost — unless the user's own press of that element came just before (then fired)", async () => {
    const s = setup();
    const tab = await s.winterTab();
    const a = wakeId();
    await s.arm(tab.targetId, { kind: "clicked", ref: await s.refOf(tab.targetId, "Submit for review") }, a);
    s.h.winter.navigateTo(keyOf(tab), "https://app.example/elsewhere");
    expect(await s.until(() => s.events.length > 0)).toBe(true);
    expect(s.events[0]).toMatchObject({ wakeId: a, outcome: "lost", reason: "the page changed" });

    const tab2 = await s.winterTab("https://app2.example/");
    const b = wakeId();
    await s.arm(tab2.targetId, { kind: "clicked", ref: await s.refOf(tab2.targetId, "Submit for review") }, b);
    s.h.winter.wakes.user(keyOf(tab2), { type: "press", id: 2 });
    await sleep(100);
    s.h.winter.navigateTo(keyOf(tab2), "https://app2.example/submitted");
    expect(await s.until(() => s.events.length > 1)).toBe(true);
    expect(s.events[1]).toMatchObject({ wakeId: b, outcome: "fired", detail: "clicked" });
  });

  test("a page condition survives navigations: a new document the page brings that shows it fires; one Winter's own goto brings does not", async () => {
    const s = setup();
    const tab = await s.winterTab();
    await s.arm(tab.targetId, { kind: "appeared", text: "Approved" });
    s.h.winter.pages["https://app.example/mine"] = page("https://app.example/mine", { text: "Approved (by Winter's goto)" });
    await s.h.engine.primitive(s.r.scope, tab.targetId, "goto", { url: "https://app.example/mine" });
    await sleep(300);
    expect(s.events).toEqual([]);
    s.h.winter.pages["https://app.example/result"] = page("https://app.example/result", { text: "Approved" });
    await sleep(600);
    s.h.winter.navigateTo(keyOf(tab), "https://app.example/result");
    expect(await s.until(() => s.events.length > 0, 3_000)).toBe(true);
    expect(s.events[0]).toMatchObject({ outcome: "fired", detail: "appeared" });
  });

  test("the tab closing, crashing, or the link dropping ends it lost", async () => {
    const s = setup();
    const t1 = await s.winterTab("https://a.example/");
    const t2 = await s.winterTab("https://b.example/");
    const a = wakeId(), b = wakeId();
    await s.arm(t1.targetId, { kind: "titled", title: "Ready" }, a);
    await s.arm(t2.targetId, { kind: "titled", title: "Ready" }, b);
    s.h.engine.panelTabClosed("s1", keyOf(t1));
    s.h.winter.goneTab(keyOf(t2), "crashed");
    expect(await s.until(() => s.events.length === 2)).toBe(true);
    expect(s.events.find((e) => e.wakeId === a)).toMatchObject({ outcome: "lost", reason: "the tab was closed" });
    expect(s.events.find((e) => e.wakeId === b)).toMatchObject({ outcome: "lost", reason: "the tab crashed" });
    const t3 = await s.winterTab("https://c.example/");
    const c = wakeId();
    await s.arm(t3.targetId, { kind: "titled", title: "Ready" }, c);
    s.h.winter.connected = false;
    expect(await s.until(() => s.events.length === 3)).toBe(true);
    expect(s.events[2]).toMatchObject({ wakeId: c, outcome: "lost", reason: "Winter isn't running" });
  });

  test("a cancel (disarm) is idempotent: nothing fires after it, the hold goes, and the pill leaves the page", async () => {
    const s = setup();
    const tab = await s.winterTab();
    const id = wakeId();
    await s.arm(tab.targetId, { kind: "clicked", ref: await s.refOf(tab.targetId, "Submit for review") }, id);
    s.r.end();
    s.h.engine.turnEnded("s1");
    s.backend.disarm(id);
    s.backend.disarm(id);
    await sleep(60);
    s.h.winter.wakes.user(keyOf(tab), { type: "click", id: 2 });
    await sleep(100);
    expect(s.events).toEqual([]);
    expect(s.h.winter.wakes.pills(keyOf(tab))).toEqual([]);
    expect(s.h.winter.tabs.get(keyOf(tab))!.attached).toBe(false);
  });

  test("waitForUser() on a tab the debugger path holds for a trigger is TargetBusy", async () => {
    const s = setup();
    const tab = await s.winterTab();
    await s.arm(tab.targetId, { kind: "titled", title: "Ready" });
    const e = await failure(s.h.engine.primitive(s.r.scope, tab.targetId, "waitForUser", { reason: "sign in" }));
    expect(e.kind).toBe("TargetBusy");
    expect(e.message).toMatch(/a wake trigger is armed on this tab/);
  });
});

describe("the floors and the grants (no scope at arm)", () => {
  test("a headless tab is refused; a secure field is Refused (Phase 1's sentence)", async () => {
    const s = setup({ headless: true });
    s.h.headless.pages["https://h.example/"] = page("https://h.example/");
    const ht = await s.h.engine.global(s.r.scope, "browsers.open", { url: "https://h.example/", browser: "headless" }) as TabHandle;
    const e1 = await failure(s.arm(ht.targetId, { kind: "titled", title: "x" }));
    expect([e1.kind, e1.message]).toEqual(["NotAllowed", WAKE_HEADLESS]);
    const tab = await s.winterTab();
    const e2 = await failure(s.arm(tab.targetId, { kind: "changed", ref: await s.refOf(tab.targetId, "Password"), settleMs: 1_500 }));
    expect([e2.kind, e2.message]).toEqual(["Refused", SECURE_FIELD_SENTENCE]);
  });

  test("a dangerous-domains host: NotAllowed unless approved for the SESSION (a one-run approval does not count) or a saved rule allows it", async () => {
    const answers: string[] = ["once", "session"];
    const s = setup({ policy: "ask", dangerousAdded: ["risky.example"], answer: () => answers.shift() });
    const tab = await s.winterTab("https://risky.example/");
    const e = await failure(s.arm(tab.targetId, { kind: "titled", title: "Ready" }));
    expect(e.kind).toBe("NotAllowed");
    expect(e.message).toMatch(/risky\.example, which is on the dangerous-domains list and not approved for this session/);
    // The session's approval: the next run's card answered "session".
    s.r.end();
    const r2 = s.h.run();
    await s.h.engine.primitive(r2.scope, tab.targetId, "state", { emit: false });
    await s.arm(tab.targetId, { kind: "titled", title: "Ready" });
    // A saved WebFetch(domain:) rule: no card at all, and the trigger arms.
    const s2 = setup({ policy: "ask", dangerousAdded: ["risky.example"], savedRules: ["WebFetch(domain:risky.example)"], answer: () => false });
    const t2 = await s2.winterTab("https://risky.example/");
    await s2.arm(t2.targetId, { kind: "titled", title: "Ready" });
  });

  test("a user's browser allowed for one call only is refused; allowed for the session it arms", async () => {
    const once = setup({ policy: "ask", answer: () => "once" });
    const t1 = await once.userTab();
    const e = await failure(once.arm(t1.targetId, { kind: "titled", title: "Ready" }));
    expect([e.kind, e.message]).toEqual(["NotAllowed", "Google Chrome was allowed for one call only — a wake trigger needs it allowed for this session"]);
    const session = setup({ policy: "ask", answer: () => "session" });
    const t2 = await session.userTab();
    await session.arm(t2.targetId, { kind: "titled", title: "Ready" });
  });
});

describe("a Winter for Chrome older than 1.2.0: the debugger is kept for the wait", () => {
  test("the watch outlives the binding — a reset, the worker's idle end, the user's tab released at turn end — and says how to wait without the bar", async () => {
    const s = setup();
    const tab = await s.userTab();
    const armed = await s.arm(tab.targetId, { kind: "clicked", ref: await s.refOf(tab.targetId, "Submit for review") });
    expect(armed.note).toBe(WAKE_OLD_EXTENSION_NOTE);
    s.r.end();
    s.h.engine.turnEnded("s1");
    s.h.engine.forgetBindings("s1");
    s.h.engine.sessionEnded("s1", "idle");
    await sleep(60);
    expect(s.h.chrome.tabs.get("7")!.attached).toBe(true);
    s.h.chrome.wakes.user("7", { type: "click", id: 2 });
    expect(await s.until(() => s.events.length > 0)).toBe(true);
    expect(s.events[0]).toMatchObject({ outcome: "fired", detail: "clicked" });
  });

  test("the debugger let go (an idle detach): attached again and the watch armed again by its locator in the same document", async () => {
    const s = setup();
    const tab = await s.userTab();
    await s.arm(tab.targetId, { kind: "clicked", ref: await s.refOf(tab.targetId, "Submit for review") });
    s.h.chrome.detachIdle("7");
    await sleep(300);
    expect(s.h.chrome.tabs.get("7")!.attached).toBe(true);
    s.h.chrome.wakes.user("7", { type: "click", id: 2 });
    expect(await s.until(() => s.events.length > 0)).toBe(true);
    expect(s.events[0]).toMatchObject({ outcome: "fired", detail: "clicked" });
  });

  test("the user taking the tab back (the debugging bar dismissed) ends it lost", async () => {
    const s = setup();
    const tab = await s.userTab();
    await s.arm(tab.targetId, { kind: "titled", title: "Ready" });
    s.h.chrome.goneTab("7", "detached_by_user");
    expect(await s.until(() => s.events.length > 0)).toBe(true);
    expect(s.events[0]).toMatchObject({ outcome: "lost", reason: "the user stopped Winter from controlling this tab" });
  });
});

describe("Winter for Chrome 1.2.0: no debugger while it waits", () => {
  test("armed through the extension: the tab is let go at once; the user's click fires; Winter's own click (its stamp) does not", async () => {
    const s = setup();
    s.h.chrome.withWatch();
    const tab = await s.userTab();
    const ref = await s.refOf(tab.targetId, "Submit for review");
    const armed = await s.arm(tab.targetId, { kind: "clicked", ref });
    expect(armed.note).toBeUndefined();
    expect(s.h.chrome.wakes.extCount()).toBe(1);
    s.r.end();
    s.h.engine.turnEnded("s1");
    await sleep(30);
    expect(s.h.chrome.tabs.get("7")!.attached).toBe(false);
    // Winter's own click (another run binds the tab again): dropped.
    const r2 = s.h.run();
    const again = await s.h.engine.global(r2.scope, "browsers.tab", { tab: "chrome:7" }) as TabHandle;
    await s.h.engine.primitive(r2.scope, again.targetId, "click", { target: Number(await s.refOf(again.targetId, "Submit for review", r2.scope)) });
    await sleep(50);
    expect(s.events).toEqual([]);
    s.h.chrome.wakes.user("7", { type: "click", id: 2, at: Date.now() + 1_000 });
    expect(await s.until(() => s.events.length > 0)).toBe(true);
    expect(s.events[0]).toMatchObject({ outcome: "fired", detail: "clicked" });
    expect(s.h.chrome.wakes.extCount()).toBe(0);
  });

  test("page conditions are injected again in each new document; a ref condition's document going is lost; the link dropping is lost", async () => {
    const s = setup();
    s.h.chrome.withWatch();
    const tab = await s.userTab();
    const appeared = wakeId(), ref = wakeId(), nav = wakeId();
    await s.arm(tab.targetId, { kind: "appeared", text: "Order placed" }, appeared);
    await s.arm(tab.targetId, { kind: "clicked", ref: await s.refOf(tab.targetId, "Submit for review") }, ref);
    await s.arm(tab.targetId, { kind: "navigated", url: "/thanks" }, nav);
    s.h.chrome.pages["https://u.example/thanks"] = page("https://u.example/thanks", { text: "Order placed" });
    s.h.chrome.navigateTo("7", "https://u.example/thanks");
    expect(await s.until(() => s.events.length === 3)).toBe(true);
    const by = (id: string) => s.events.find((e) => e.wakeId === id)!;
    expect(by(ref)).toMatchObject({ outcome: "lost", reason: "the page changed" });
    expect(by(nav)).toMatchObject({ outcome: "fired", detail: "now at https://u.example/thanks" });
    expect(by(appeared)).toMatchObject({ outcome: "fired", detail: "appeared" });
    const last = wakeId();
    await s.arm(tab.targetId, { kind: "titled", title: "Shipped" }, last);
    s.h.chrome.wakes.dropExtension();
    expect(await s.until(() => s.events.length === 4)).toBe(true);
    expect(by(last)).toMatchObject({ outcome: "lost", reason: "Winter for Chrome disconnected" });
  });

  test("an element inside a child frame keeps the debugger (and says so)", async () => {
    const s = setup();
    s.h.chrome.withWatch();
    const tab = await s.userTab("8", "https://f.example/", { frames: [{ frameId: "F1", ownerId: 9, url: "https://pay.example/", nodes: [{ id: 1, role: "button", name: "Confirm" }] }] });
    tab.id;
    const found = await s.h.engine.primitive(s.r.scope, tab.targetId, "find", { query: "Confirm", emit: false }) as Array<{ ref: number }>;
    const armed = await s.arm(tab.targetId, { kind: "clicked", ref: String(found[0]!.ref) });
    expect(armed.note).toBe(WAKE_IN_FRAME_NOTE);
    expect(s.h.chrome.wakes.extCount()).toBe(0);
    s.h.chrome.wakes.user("8", { type: "click", id: 1, frameId: "F1" });
    expect(await s.until(() => s.events.length > 0)).toBe(true);
    expect(s.events[0]).toMatchObject({ outcome: "fired", detail: "clicked" });
  });
});

describe("agent tabs and the lifecycle", () => {
  test("an agent tab a trigger waits on is not closed at a turn end; once the trigger ended, the next turn end closes it", async () => {
    const s = setup();
    s.h.chrome.withWatch();
    s.h.chrome.pages["https://shop.example/"] = page("https://shop.example/");
    const tab = await s.h.engine.global(s.r.scope, "browsers.open", { url: "https://shop.example/", browser: "chrome" }) as TabHandle;
    const id = wakeId();
    await s.arm(tab.targetId, { kind: "titled", title: "Paid" }, id);
    s.r.end();
    s.h.engine.turnEnded("s1");
    await sleep(20);
    expect(s.h.chrome.tabs.get(keyOf(tab))!.closed).toBe(false);
    s.backend.disarm(id);
    s.h.engine.turnEnded("s1");
    await sleep(20);
    expect(s.h.chrome.tabs.get(keyOf(tab))!.closed).toBe(true);
  });

  test("shouldCloseAgentTab: waiting keeps a tab past a turn end only", () => {
    expect(shouldCloseAgentTab({ event: "turn-ended", family: "chrome", kept: false, waiting: true })).toBe(false);
    expect(shouldCloseAgentTab({ event: "turn-ended", family: "chrome", kept: false })).toBe(true);
    expect(shouldCloseAgentTab({ event: "session-archived", family: "chrome", kept: false, waiting: true })).toBe(true);
    expect(shouldCloseAgentTab({ event: "session-deleted", family: "chrome", kept: false, waiting: true })).toBe(true);
  });
});

describe("the pieces", () => {
  test("engine.hostOf: the bound tab's host for the audit line — after a reset too, for a target a trigger was armed on", async () => {
    const s = setup();
    const tab = await s.winterTab("https://shop.example/cart?token=x");
    expect(s.h.engine.hostOf("s1", tab.targetId)).toBe("shop.example");
    await s.arm(tab.targetId, { kind: "titled", title: "Paid" });
    s.h.engine.forgetBindings("s1");
    expect(s.h.engine.hostOf("s1", tab.targetId)).toBe("shop.example");
    expect(s.h.engine.hostOf("s1", "bt_000000000000")).toBeUndefined();
  });

  test("TabDriver.ownInputAt: in flight, and 500 ms after, from any session", () => {
    let now = 10_000;
    const d = new TabDriver("winter", "w1", {} as never, "Winter's browser", () => now);
    expect(d.ownInputAt(now)).toBe(false);
    d.beginOwnInput();
    now += 300;
    expect(d.ownInputAt(now)).toBe(true);
    d.endOwnInput();
    expect(d.ownInputAt(now + 499)).toBe(true);
    expect(d.ownInputAt(now + 501)).toBe(false);
    expect(d.ownInputAt(9_000)).toBe(false);
  });

  test("the pill's words are fixed per kind and name only the element's own label", () => {
    expect(wakePill("clicked", "Submit for review")).toBe("Winter continues when you click “Submit for review”");
    expect(wakePill("clicked", "")).toBe("Winter continues when you click the marked element");
    expect(wakePill("submitted", "", { anyForm: true })).toBe("Winter continues when you submit a form on this page");
    expect(wakePill("appeared", "")).toBe("Winter continues when this page changes");
    expect(wakePill("navigated", "")).toBe("Winter continues when you go to another page");
    expect(wakePill("changed", "Notes  for\nthe reviewer")).toBe("Winter continues when you change “Notes for the reviewer”");
  });
});
