// ComputerV2 — wake triggers on browser tabs (`browser/wake/backend.ts`), over the fake transports (which enforce the CDP
// allowlist and the world rules, and play the page watcher's ops): the debugger path (Winter's built-in browser, a
// Winter for Chrome older than 1.2.0, an element in a child frame) and Winter for Chrome 1.2.0's debugger-free path.
// The real watcher in a real browser: `scripts/browser-e2e/` (opt-in).
import { describe, expect, test } from "bun:test";
import { shouldCloseAgentTab } from "../../src/computer-use/browser/lifecycle";
import { HOLD_CEILING_SENTENCE, SECURE_FIELD_SENTENCE, TabDriver } from "../../src/computer-use/browser/tab-driver";
import { HOLDS_PER_SESSION } from "../../src/computer-use/browser/engine";
import { TransportError } from "../../src/computer-use/browser/transport";
import { BrowserWakeBackend, WAKE_HEADLESS, WAKE_IN_FRAME_NOTE, WAKE_OLD_EXTENSION_NOTE, WAKE_UPDATE_WINTER, wakePill, wakeUrlShape } from "../../src/computer-use/browser/wake/backend";
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

function setup(o: HarnessOpts & { skew?: { ms: number } } = {}) {
  const h = harness(o);
  const backend = new BrowserWakeBackend(h.engine, { pollMs: 40, recoverMs: 1_500, closedGraceMs: 150, ...(o.skew === undefined ? {} : { now: () => Date.now() + o.skew!.ms }) });
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
    // The origin and path only: a GET form's typed values (the query) never appear.
    expect(s.events[0]).toMatchObject({ wakeId: any, outcome: "fired", detail: "now at https://app.example/done?…" });
    expect(JSON.stringify(s.events)).not.toContain("abc123");
    // { url }: a same-document move to it counts — the detail names the model's own words.
    const want = wakeId();
    await s.arm(tab.targetId, { kind: "navigated", url: "#review" }, want);
    s.h.winter.wakes.sameDocument(keyOf(tab), "https://app.example/done#review");
    expect(await s.until(() => s.events.length > 1)).toBe(true);
    expect(s.events[1]).toMatchObject({ wakeId: want, outcome: "fired", detail: "now at https://app.example/done#… — matched “#review”" });
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

describe("WATCH-ONLY: a waiting tab changes nothing the user sees or does", () => {
  const interceptOn = (t: { intercept: Map<string, boolean> }): boolean => [...t.intercept.values()].some((v) => v);

  test("built-in: after the turn ends, the hold sent is watch-only, no interception, no focus emulation, no emulated size, no overlay — a primitive takes the full hold back and it drops back after", async () => {
    const s = setup();
    const tab = await s.winterTab();
    const t = s.h.winter.tabs.get(keyOf(tab))!;
    await s.h.engine.primitive(s.r.scope, tab.targetId, "viewport", { size: { width: 600, height: 500 } });
    await s.h.engine.primitive(s.r.scope, tab.targetId, "click", { target: Number(await s.refOf(tab.targetId, "Email")) });
    await s.arm(tab.targetId, { kind: "clicked", ref: await s.refOf(tab.targetId, "Submit for review") });
    // While the arming run holds it: the primitive's full hold, as ever.
    expect(t.holdModes.at(-1)).toBe("full");
    expect(interceptOn(t) && t.focusEmulation && t.emulated !== undefined).toBe(true);
    s.r.end();
    s.h.engine.turnEnded("s1");
    expect(await s.until(() => t.holdModes.at(-1) === "watch")).toBe(true);
    await sleep(30);
    expect(t.attached).toBe(true);
    expect(interceptOn(t)).toBe(false);
    expect(t.focusEmulation).toBe(false);
    expect(t.emulated).toBeUndefined();
    expect(s.h.winter.overlays.at(-1)).toMatchObject({ tabKey: keyOf(tab), active: false });
    // Another run uses the tab: the full hold, its interception and its size back…
    const r2 = s.h.run();
    const again = await s.h.engine.global(r2.scope, "browsers.tab", { tab: tab.id }) as TabHandle;
    await s.h.engine.primitive(r2.scope, again.targetId, "state", { emit: false });
    expect(t.holdModes.at(-1)).toBe("full");
    expect(interceptOn(t) && t.focusEmulation).toBe(true);
    expect(t.emulated).toMatchObject({ width: 600, height: 500 });
    // …and its turn's end drops it back to watch-only (the wait goes on).
    r2.end();
    s.h.engine.turnEnded("s1");
    expect(await s.until(() => t.holdModes.at(-1) === "watch" && !interceptOn(t))).toBe(true);
    expect(s.backend.armedIds().length).toBe(1);
  });

  test("built-in: an idle detach recovered while only the wake holds it attaches watch-only from the start", async () => {
    const s = setup();
    const tab = await s.winterTab();
    const t = s.h.winter.tabs.get(keyOf(tab))!;
    await s.arm(tab.targetId, { kind: "clicked", ref: await s.refOf(tab.targetId, "Submit for review") });
    s.r.end();
    s.h.engine.turnEnded("s1");
    expect(await s.until(() => t.holdModes.at(-1) === "watch")).toBe(true);
    const sent = t.holdModes.length;
    s.h.winter.detachIdle(keyOf(tab));
    expect(await s.until(() => t.attached && t.holdModes.length > sent)).toBe(true);
    expect(t.holdModes.slice(sent)).toEqual(["watch"]);
    expect(interceptOn(t)).toBe(false);
    expect(t.focusEmulation).toBe(false);
  });

  test("built-in: a Winter.app without the watchOnly feature never holds a tab for a wake (NotAllowed, update Winter)", async () => {
    const s = setup();
    delete s.h.winter.watchOnlyHolds;
    const tab = await s.winterTab();
    const e = await failure(s.arm(tab.targetId, { kind: "titled", title: "Ready" }));
    expect([e.kind, e.message]).toEqual(["NotAllowed", WAKE_UPDATE_WINTER]);
    expect(s.backend.armedIds()).toEqual([]);
  });

  test("an older Winter for Chrome (debugger kept): after the turn ends, no interception and no focus emulation on the user's tab", async () => {
    const s = setup();
    const tab = await s.userTab();
    const t = s.h.chrome.tabs.get("7")!;
    await s.arm(tab.targetId, { kind: "submitted" });
    expect(interceptOn(t)).toBe(true);
    s.r.end();
    s.h.engine.turnEnded("s1");
    expect(await s.until(() => !interceptOn(t))).toBe(true);
    expect(t.attached).toBe(true);
    expect(t.focusEmulation).toBe(false);
  });

  test("a confirm() the user's submit raises while the arming run still holds the tab: never cancelled — the full hold stays (no watch-only hold, which would dismiss it), the wait ends lost saying so, and the woken session answers it", async () => {
    const s = setup();
    const tab = await s.winterTab();
    const t = s.h.winter.tabs.get(keyOf(tab))!;
    const id = wakeId();
    await s.arm(tab.targetId, { kind: "submitted" }, id);
    // The user submits while the arming run still holds the tab (full hold: the app holds the dialog unseen) — the
    // page pauses on the dialog, and the wait's own report is stuck behind it.
    s.h.winter.wakes.user(keyOf(tab), { type: "submit", at: Date.now() + 1_000 });
    s.h.winter.openDialog(keyOf(tab), "confirm", "Submit your listing for review?");
    await sleep(120);
    expect(s.events).toEqual([]);
    const modes = t.holdModes.length;
    s.r.end();
    s.h.engine.turnEnded("s1");
    // The wait ends lost, naming the dialog — its session is woken to read and answer it.
    expect(await s.until(() => s.events.length > 0)).toBe(true);
    expect(s.events[0]).toMatchObject({ wakeId: id, outcome: "lost" });
    expect(s.events[0]!.reason).toMatch(/opened a confirm dialog and is paused on it .* dialog\(\) .* answerDialog\(\)/);
    await sleep(80);
    // Never a watch-only hold (Winter.app would dismiss the held dialog as Cancel), never an answer from Winter.
    expect(t.holdModes.slice(modes)).not.toContain("watch");
    expect(t.attached).toBe(true);
    expect(s.h.winter.sent.some((x) => x.method === "Page.handleJavaScriptDialog")).toBe(false);
    // The woken session reads it and answers it as the user said: then the tab is let go.
    const r2 = s.h.run();
    const again = await s.h.engine.global(r2.scope, "browsers.tab", { tab: tab.id }) as TabHandle;
    expect(await s.h.engine.primitive(r2.scope, again.targetId, "dialog", {})).toMatchObject({ type: "confirm" });
    await s.h.engine.primitive(r2.scope, again.targetId, "answerDialog", { accept: true });
    r2.end();
    s.h.engine.turnEnded("s1");
    expect(await s.until(() => !t.attached)).toBe(true);
  });

  test("…a cancelled wait does not keep such a dialog (it goes as Winter lets the tab go, as without a wait)", async () => {
    const s = setup();
    const tab = await s.winterTab();
    const t = s.h.winter.tabs.get(keyOf(tab))!;
    const id = wakeId();
    await s.arm(tab.targetId, { kind: "submitted" }, id);
    s.h.winter.openDialog(keyOf(tab), "alert", "Saved");
    s.backend.disarm(id);
    s.r.end();
    s.h.engine.turnEnded("s1");
    expect(await s.until(() => !t.attached)).toBe(true);
    expect(s.events).toEqual([]);
  });

  test("a confirm() raised just as a wait fired on the user's action (its report got out first) is kept for the woken session too", async () => {
    const s = setup();
    const tab = await s.winterTab();
    const t = s.h.winter.tabs.get(keyOf(tab))!;
    await s.arm(tab.targetId, { kind: "clicked", ref: await s.refOf(tab.targetId, "Submit for review") });
    s.h.winter.wakes.user(keyOf(tab), { type: "click", id: 2, at: Date.now() + 1_000 });
    expect(await s.until(() => s.events.length > 0)).toBe(true);
    s.h.winter.openDialog(keyOf(tab), "confirm", "Sure?");
    s.r.end();
    s.h.engine.turnEnded("s1");
    await sleep(80);
    expect(t.attached).toBe(true);
    expect(s.h.winter.sent.some((x) => x.method === "Page.handleJavaScriptDialog")).toBe(false);
    s.h.winter.closeDialog(keyOf(tab), true);
    expect(await s.until(() => !t.attached)).toBe(true);
  });

  test("a dialog raised during a watch-only wait is the user's to answer: the wake ending detaches with no answer sent (watch-only holds none)", async () => {
    const s = setup();
    const tab = await s.winterTab();
    const t = s.h.winter.tabs.get(keyOf(tab))!;
    await s.arm(tab.targetId, { kind: "submitted" });
    s.r.end();
    s.h.engine.turnEnded("s1");
    expect(await s.until(() => t.holdModes.at(-1) === "watch")).toBe(true);
    s.h.winter.wakes.user(keyOf(tab), { type: "submit", at: Date.now() + 1_000 });
    s.h.winter.openDialog(keyOf(tab), "confirm", "Sure?");
    await sleep(100);
    // The browser shows it (watch-only): the user answers it, and only then does the page — and the report — go on.
    expect(s.events).toEqual([]);
    s.h.winter.closeDialog(keyOf(tab), true);
    expect(await s.until(() => s.events.length > 0 && !t.attached)).toBe(true);
    expect(s.events[0]).toMatchObject({ outcome: "fired", detail: "submitted the form" });
    expect(s.h.winter.sent.some((x) => x.method === "Page.handleJavaScriptDialog")).toBe(false);
  });

  test("the poller polls around a page dialog (never parked on it): even when the dialog's closing event is lost, the user's click after it fires", async () => {
    const s = setup();
    const tab = await s.winterTab();
    await s.arm(tab.targetId, { kind: "clicked", ref: await s.refOf(tab.targetId, "Submit for review") });
    s.r.end();
    s.h.engine.turnEnded("s1");
    expect(await s.until(() => s.h.winter.tabs.get(keyOf(tab))!.holdModes.at(-1) === "watch")).toBe(true);
    s.h.winter.openDialog(keyOf(tab), "alert", "Saved");
    await sleep(100);
    // The user answers it in the browser, and the browser's "closed" never reaches the engine (its record goes stale).
    s.h.winter.closeDialog(keyOf(tab), true, { silently: true });
    // Several poll rounds go by (the page answers again) before the user clicks.
    await sleep(300);
    s.h.winter.wakes.user(keyOf(tab), { type: "click", id: 2, at: Date.now() + 1_000 });
    expect(await s.until(() => s.events.length > 0, 1_500)).toBe(true);
    expect(s.events[0]).toMatchObject({ outcome: "fired", detail: "clicked" });
  });

  test("a cancel while a page dialog is open still takes the watch (its ring and pill) off the page", async () => {
    const s = setup();
    const tab = await s.winterTab();
    const id = wakeId();
    await s.arm(tab.targetId, { kind: "clicked", ref: await s.refOf(tab.targetId, "Submit for review") }, id);
    s.h.winter.openDialog(keyOf(tab), "alert", "Hello");
    s.backend.disarm(id);
    expect(await s.until(() => s.h.winter.wakes.pills(keyOf(tab)).length === 0)).toBe(true);
  });

  test("a watch whose disarm never reached the page goes at the next poll of its frame (each poll names the watches kept)", async () => {
    const s = setup();
    const tab = await s.winterTab();
    const gone = wakeId(), kept = wakeId();
    await s.arm(tab.targetId, { kind: "titled", title: "Ready" }, gone);
    await s.arm(tab.targetId, { kind: "clicked", ref: await s.refOf(tab.targetId, "Submit for review") }, kept);
    s.h.winter.wakes.failOps.add("watchDisarm");
    s.backend.disarm(gone);
    expect(await s.until(() => s.h.winter.wakes.pills(keyOf(tab)).length === 1)).toBe(true);
    expect(s.h.winter.wakes.pills(keyOf(tab))).toEqual(["Winter continues when you click “Submit for review”"]);
  });
});

describe("only the user's action counts — timing", () => {
  test("a submit whose qualifying input was Winter's own (a page's requestSubmit() just after Winter typed) never fires; the user's own does", async () => {
    const s = setup();
    const tab = await s.winterTab();
    await s.arm(tab.targetId, { kind: "submitted" });
    const t0 = Date.now();
    await s.h.engine.primitive(s.r.scope, tab.targetId, "click", { target: Number(await s.refOf(tab.targetId, "Email")) });
    const ownEnd = Date.now();
    // The page submits by itself 700 ms after Winter's input ended (past the grace), on the strength of Winter's input.
    s.h.winter.wakes.user(keyOf(tab), { type: "submit", at: ownEnd + 700, cause: Math.max(t0, ownEnd - 5) });
    await sleep(120);
    expect(s.events).toEqual([]);
    s.h.winter.wakes.user(keyOf(tab), { type: "submit", at: ownEnd + 2_000, cause: ownEnd + 1_980 });
    expect(await s.until(() => s.events.length > 0)).toBe(true);
    expect(s.events[0]).toMatchObject({ outcome: "fired", detail: "submitted the form" });
  });

  test("Winter's own navigation is decided when it STARTS: a goto whose commit lands after the grace is still the baseline", async () => {
    const s = setup();
    const tab = await s.winterTab();
    await s.arm(tab.targetId, { kind: "navigated" });
    s.h.winter.slowCommitMs = 1_200;
    // Winter's goto starts the navigation, and its run ends (stopped) long before the slow commit lands.
    const going = s.h.engine.primitive(s.r.scope, tab.targetId, "goto", { url: "https://app.example/step2" }).catch(() => undefined);
    await sleep(80);
    s.r.end();
    await going;
    await sleep(1_700);
    expect(s.h.winter.tabs.get(keyOf(tab))!.page.url).toBe("https://app.example/step2");
    expect(s.events).toEqual([]);
    // The page's own navigation afterwards fires.
    delete s.h.winter.slowCommitMs;
    s.h.winter.navigateTo(keyOf(tab), "https://app.example/done");
    expect(await s.until(() => s.events.length > 0)).toBe(true);
    expect(s.events[0]).toMatchObject({ outcome: "fired", detail: "now at https://app.example/done" });
  });

  test("the press window runs from the user's press to when the page went — not to when the backend learned of it", async () => {
    const skew = { ms: 0 };
    const s = setup({ skew });
    const tab = await s.winterTab();
    await s.arm(tab.targetId, { kind: "clicked", ref: await s.refOf(tab.targetId, "Submit for review") });
    s.h.winter.wakes.user(keyOf(tab), { type: "press", id: 2 });
    await sleep(80);
    s.h.winter.navigateTo(keyOf(tab), "https://app.example/submitted");
    // The backend learns of the loss "10 s" later (a slow recovery): the press still made it the user's.
    skew.ms = 10_000;
    expect(await s.until(() => s.events.length > 0)).toBe(true);
    expect(s.events[0]).toMatchObject({ outcome: "fired", detail: "clicked" });
  });
});

describe("hold budgets", () => {
  test(`a waiting tab's hold counts: past ${HOLDS_PER_SESSION} waiting tabs a new wait is refused TargetBusy naming wakes.cancel, and so is another tab's hold`, async () => {
    const s = setup();
    const tabs: TabHandle[] = [];
    for (let i = 0; i <= HOLDS_PER_SESSION; i++) tabs.push(await s.winterTab(`https://t${i}.example/`));
    for (let i = 0; i < HOLDS_PER_SESSION; i++) await s.arm(tabs[i]!.targetId, { kind: "titled", title: "Ready" });
    const e = await failure(s.arm(tabs[HOLDS_PER_SESSION]!.targetId, { kind: "titled", title: "Ready" }));
    expect(e.kind).toBe("TargetBusy");
    expect(e.message).toMatch(/too many tabs are waiting; cancel one with wakes\.cancel\(id\)/);
    s.r.end();
    s.h.engine.turnEnded("s1");
    await sleep(50);
    // A later run: the waiting tabs stay held, so a hold on another tab is refused — never past the cap in silence.
    const r2 = s.h.run();
    const other = await s.h.engine.global(r2.scope, "browsers.tab", { tab: tabs[HOLDS_PER_SESSION]!.id }).catch((err: unknown) => err) as AutomationFailure;
    const e2 = other instanceof AutomationFailure ? other : await failure(s.h.engine.primitive(r2.scope, (other as TabHandle).targetId, "state", { emit: false }));
    expect(e2.kind).toBe("TargetBusy");
    expect(e2.message).toMatch(/wait for the user — too many tabs are waiting; stop waiting on one with wakes\.cancel\(id\)/);
    expect([...s.h.winter.tabs.values()].filter((t) => t.attached).length).toBe(HOLDS_PER_SESSION);
  });

  test("Winter.app's ceiling on held tabs, reached while tabs wait: its sentence names wakes.cancel too", async () => {
    const s = setup();
    const t1 = await s.winterTab("https://a.example/");
    await s.arm(t1.targetId, { kind: "titled", title: "Ready" });
    const t2 = await s.winterTab("https://b.example/");
    s.r.end();
    s.h.engine.turnEnded("s1");
    await sleep(30);
    const attach = s.h.winter.attach.bind(s.h.winter);
    s.h.winter.attach = async (tabKey, o) => {
      if (tabKey === keyOf(t2)) throw new TransportError("not_allowed", "Winter's built-in browser already holds 24 tabs for automation — release one first", { holdCeiling: true });
      return attach(tabKey, o);
    };
    const r2 = s.h.run();
    const e = await failure(s.h.engine.primitive(r2.scope, t2.targetId, "state", { emit: false }));
    expect(e.kind).toBe("TargetBusy");
    expect(e.message.startsWith(HOLD_CEILING_SENTENCE)).toBe(true);
    expect(e.message).toContain("or stop waiting on one with wakes.cancel(id) (1 built-in tab waits for the user)");
  });
});

describe("rekey, leaks", () => {
  test("a user's tab the browser replaced under a new id: the watch follows it (events on the new id count; the cancel names it)", async () => {
    const s = setup();
    s.h.chrome.withWatch();
    s.h.chrome.pages["https://shop.example/"] = page("https://shop.example/");
    const tab = await s.h.engine.global(s.r.scope, "browsers.open", { url: "https://shop.example/", browser: "chrome" }) as TabHandle;
    const id = wakeId();
    await s.arm(tab.targetId, { kind: "submitted" }, id);
    // Winter's own navigation of it comes back under a new key (the extension moved the watch with it).
    s.h.chrome.tabs.get(keyOf(tab))!.navigateFallback = { newKey: "900" };
    await s.h.engine.primitive(s.r.scope, tab.targetId, "goto", { url: "https://shop.example/cart" }).catch(() => undefined);
    s.h.chrome.wakes.moveExt(keyOf(tab), "900");
    s.h.chrome.wakes.user("900", { type: "submit", at: Date.now() + 1_000 });
    expect(await s.until(() => s.events.length > 0)).toBe(true);
    expect(s.events[0]).toMatchObject({ wakeId: id, outcome: "fired", detail: "submitted the form" });
    // Its cancel reached the extension under the new id.
    expect(await s.until(() => s.h.chrome.wakes.extCount() === 0)).toBe(true);
  });

  test("a tab that really closed: lost after the rekey's grace", async () => {
    const s = setup();
    s.h.chrome.withWatch();
    const tab = await s.userTab();
    await s.arm(tab.targetId, { kind: "submitted" });
    s.h.chrome.goneTab("7", "closed");
    expect(await s.until(() => s.events.length > 0)).toBe(true);
    expect(s.events[0]).toMatchObject({ outcome: "lost", reason: "the tab was closed" });
  });

  test("Stop pressed in a browser on a tab a trigger holds stops the sessions' scripts only — never a wake holder as a session", async () => {
    const s = setup();
    const tab = await s.userTab();
    await s.arm(tab.targetId, { kind: "titled", title: "Ready" });
    s.h.chrome.pressStop("7");
    expect(s.h.stops.map((x) => x.sessionId)).toEqual(["s1"]);
    s.r.end();
    s.h.engine.turnEnded("s1");
    await sleep(30);
    s.h.chrome.pressStop("7");
    expect(s.h.stops.map((x) => x.sessionId)).toEqual(["s1"]);
  });

  test("the debugger path's navigation listener goes with the tab's last watch", async () => {
    const s = setup();
    const tab = await s.winterTab();
    const d = s.h.engine.wakeTarget("s1", tab.targetId).driver;
    const before = d.listeners.size;
    const a = wakeId(), b = wakeId();
    await s.arm(tab.targetId, { kind: "navigated" }, a);
    await s.arm(tab.targetId, { kind: "titled", title: "Ready" }, b);
    expect(d.listeners.size).toBe(before + 1);
    s.backend.disarm(a);
    expect(d.listeners.size).toBe(before + 1);
    s.backend.disarm(b);
    expect(d.listeners.size).toBe(before);
  });

  test("wakeUrlShape: origin and path only, redacted, with ?… and #… where a query and a fragment were", () => {
    expect(wakeUrlShape("https://shop.example/search?q=my+secret+order&page=2#top")).toBe("https://shop.example/search?…#…");
    expect(wakeUrlShape("https://shop.example/")).toBe("https://shop.example/");
    expect(wakeUrlShape("data:text/html,hi")).toBe("about:blank");
    expect(wakeUrlShape("not a url")).toBe("another page");
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
    expect(by(nav)).toMatchObject({ outcome: "fired", detail: "now at https://u.example/thanks — matched “/thanks”" });
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
  test("an agent tab a trigger waits on is not closed at a turn end; once the trigger ended between turns, the next turn end (the wake turn's) closes it", async () => {
    let running = true;
    const s = setup({ engineDeps: { turnRunning: () => running } });
    s.h.chrome.withWatch();
    s.h.chrome.pages["https://shop.example/"] = page("https://shop.example/");
    const tab = await s.h.engine.global(s.r.scope, "browsers.open", { url: "https://shop.example/", browser: "chrome" }) as TabHandle;
    const id = wakeId();
    await s.arm(tab.targetId, { kind: "titled", title: "Paid" }, id);
    s.r.end();
    running = false;
    s.h.engine.turnEnded("s1");
    await sleep(20);
    expect(s.h.chrome.tabs.get(keyOf(tab))!.closed).toBe(false);
    s.backend.disarm(id);
    running = true;
    s.h.engine.turnEnded("s1");
    await sleep(20);
    expect(s.h.chrome.tabs.get(keyOf(tab))!.closed).toBe(true);
  });

  test("HIGH 2: the user acts before the arming turn ends — the tab is NOT closed at that turn end (handoff mark), and closes at the following one", async () => {
    let running = true;
    const s = setup({ engineDeps: { turnRunning: () => running } });
    s.h.chrome.withWatch();
    s.h.chrome.pages["https://shop.example/"] = page("https://shop.example/");
    const tab = await s.h.engine.global(s.r.scope, "browsers.open", { url: "https://shop.example/", browser: "chrome" }) as TabHandle;
    await s.arm(tab.targetId, { kind: "clicked", ref: await s.refOf(tab.targetId, "Submit for review") });
    // The user clicks while the arming turn is still running: the trigger ends (fired) mid-turn.
    s.h.chrome.wakes.user(keyOf(tab), { type: "click", id: 2, at: Date.now() + 1_000 });
    expect(await s.until(() => s.events.length > 0)).toBe(true);
    s.r.end();
    s.h.engine.turnEnded("s1");
    await sleep(20);
    expect(s.h.chrome.tabs.get(keyOf(tab))!.closed).toBe(false);
    // The wake turn's end: the ordinary rule.
    s.h.engine.turnEnded("s1");
    await sleep(20);
    expect(s.h.chrome.tabs.get(keyOf(tab))!.closed).toBe(true);
  });

  test("HIGH 2: …and the wake turn may still keep it with handoff() — the turn after closes it then", async () => {
    let running = true;
    const s = setup({ engineDeps: { turnRunning: () => running } });
    s.h.chrome.withWatch();
    s.h.chrome.pages["https://shop.example/"] = page("https://shop.example/");
    const tab = await s.h.engine.global(s.r.scope, "browsers.open", { url: "https://shop.example/", browser: "chrome" }) as TabHandle;
    await s.arm(tab.targetId, { kind: "clicked", ref: await s.refOf(tab.targetId, "Submit for review") });
    s.h.chrome.wakes.user(keyOf(tab), { type: "click", id: 2, at: Date.now() + 1_000 });
    expect(await s.until(() => s.events.length > 0)).toBe(true);
    s.r.end();
    s.h.engine.turnEnded("s1");
    const r2 = s.h.run();
    const again = await s.h.engine.global(r2.scope, "browsers.tab", { tab: tab.id }) as TabHandle;
    await s.h.engine.primitive(r2.scope, again.targetId, "handoff", {});
    r2.end();
    s.h.engine.turnEnded("s1");
    await sleep(20);
    expect(s.h.chrome.tabs.get(keyOf(tab))!.closed).toBe(false);
    s.h.engine.turnEnded("s1");
    await sleep(20);
    expect(s.h.chrome.tabs.get(keyOf(tab))!.closed).toBe(true);
    void running;
  });

  test("waiting counts ANY session's trigger: a peer's wait on an agent tab keeps it open at its own session's turn end", async () => {
    const s = setup({ engineDeps: { turnRunning: () => false } });
    s.h.chrome.withWatch();
    s.h.chrome.pages["https://shop.example/"] = page("https://shop.example/");
    const tab = await s.h.engine.global(s.r.scope, "browsers.open", { url: "https://shop.example/", browser: "chrome" }) as TabHandle;
    s.r.end();
    // Session s2 binds the same tab and arms on it.
    const peer = s.h.run("s2");
    const bound = await s.h.engine.global(peer.scope, "browsers.tab", { tab: tab.id }) as TabHandle;
    await s.arm(bound.targetId, { kind: "titled", title: "Paid" }, wakeId(), "s2");
    peer.end();
    s.h.engine.turnEnded("s1");
    await sleep(20);
    expect(s.h.chrome.tabs.get(keyOf(tab))!.closed).toBe(false);
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
