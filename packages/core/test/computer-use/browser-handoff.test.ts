// ComputerV2 Phase 3 — `waitForUser(reason)`, the sign-in hand-off, over the fake transports: the two cards (their
// words, options and clocks), the tab let go — by every session, a full detach — before the first card, Done from the
// card or from the browser's own toolbar, declining, no answer, the tab closed meanwhile, what the page logged while
// the user had it kept out of console(), dont-ask refused, plan allowed, and the audit count.
import { describe, expect, test } from "bun:test";
import { AutomationFailure } from "../../src/computer-use/errors";
import type { TabHandle } from "../../src/computer-use/worker/bridge";
import type { FakePage } from "./browser-fake-transport";
import { harness, type HarnessOpts } from "./browser-harness";

const PAGE: FakePage = { url: "https://accounts.example.com/login", title: "Sign in", nodes: [{ id: 1, role: "main", children: [{ id: 2, role: "heading", name: "Sign in", level: 1 }] }] };

async function failure(p: Promise<unknown>): Promise<Error> {
  try { await p; } catch (err) { return err as Error; }
  throw new Error("expected a failure");
}

async function opened(browser: "winter" | "chrome", o: HarnessOpts = {}) {
  const h = harness(o);
  (browser === "winter" ? h.winter : h.chrome).pages[PAGE.url] = PAGE;
  const r = h.run();
  const tab = await h.engine.global(r.scope, "browsers.open", { url: PAGE.url, ...(browser === "chrome" ? { browser: "chrome" } : {}) }) as TabHandle;
  const key = tab.id.split(":")[1]!;
  const p = (args: Record<string, unknown>) => h.engine.primitive(r.scope, tab.targetId, "waitForUser", args);
  return { h, r, tab, key, p };
}

const tick = () => new Promise((res) => setTimeout(res, 5));

describe("waitForUser(): the cards", () => {
  test("Show me the tab → the tab is let go, then brought forward; Done on the second card → taken again, its whole state printed", async () => {
    const answers: string[] = [];
    const { h, r, key, p } = await opened("chrome", { answer: (s) => { answers.push(s); return s.startsWith("Google Chrome — ") ? "handoff_show" : "handoff_done"; } });
    const out = await p({ reason: "Sign in to your bank\n(2-step code)" });
    expect(out).toEqual({ done: true });
    expect(answers).toEqual([
      "Google Chrome — accounts.example.com: Sign in to your bank (2-step code). Winter waits while you do it.",
      "Waiting for you on accounts.example.com in Google Chrome — press Done when you have finished.",
    ]);
    expect(h.cards.map((c) => c.options?.map((o) => o.id))).toEqual([["handoff_show", "handoff_done"], ["handoff_done"]]);
    expect(h.chrome.presented).toEqual([`${key}@s1`]);
    // The debugger was let go before the tab came forward, and taken again after Done.
    const fake = h.chrome.tabs.get(key)!;
    expect(fake.attached).toBe(true);
    expect(h.chrome.overlays.filter((o) => o.tabKey === key && !o.active).length).toBeGreaterThan(0);
    const text = r.text();
    expect(text).toContain("brought the tab forward in Google Chrome for the user");
    expect(text).toContain("the user finished on accounts.example.com");
    expect(text).toMatch(/heading "Sign in"/);
    expect(r.handoffs()).toBe(1);
    r.end();
  });

  test("I've done it on the first card: nothing is shown; the tab was let go while the card was up, and is read again", async () => {
    const seen: boolean[] = [];
    let fake: { attached: boolean } | undefined;
    const { h, r, key, p } = await opened("chrome", { answer: () => { seen.push(fake!.attached); return "handoff_done"; } });
    fake = h.chrome.tabs.get(key)!;
    expect(fake.attached).toBe(true);
    expect(await p({ reason: "sign in" })).toEqual({ done: true });
    expect(seen).toEqual([false]);
    expect(fake.attached).toBe(true);
    expect(h.chrome.presented).toEqual([]);
    expect(h.cards).toHaveLength(1);
    r.end();
  });

  test("another session holding the tab does not keep it attached: the hand-off is a full detach, and that session attaches afresh later", async () => {
    const seen: boolean[] = [];
    let fake: { attached: boolean } | undefined;
    const { h, r, tab, key } = await opened("chrome", { answer: (s) => { seen.push(fake!.attached); return s.startsWith("Google Chrome — ") ? "handoff_show" : "handoff_done"; } });
    fake = h.chrome.tabs.get(key)!;
    r.end();
    // A second session binds and reads the same tab: it holds it now too.
    const r2 = h.run("s2");
    const b2 = await h.engine.global(r2.scope, "browsers.tab", { tab: tab.id }) as TabHandle;
    await h.engine.primitive(r2.scope, b2.targetId, "state", { emit: false });
    r2.end();
    const r1 = h.run("s1");
    const out = await h.engine.primitive(r1.scope, tab.targetId, "waitForUser", { reason: "sign in" });
    expect(out).toEqual({ done: true });
    // Detached while either card was up, although s2 still held the tab.
    expect(seen).toEqual([false, false]);
    r1.end();
    // s2's next read attaches again by itself.
    const r3 = h.run("s2");
    expect(typeof await h.engine.primitive(r3.scope, b2.targetId, "state", { emit: false })).toBe("string");
    expect(fake.attached).toBe(true);
    r3.end();
  });

  test("what the page logged while the user had the tab is not Winter's: replayed console entries from the hand-off are dropped", async () => {
    let during = 0;
    const { h, r, key, p } = await opened("chrome", { answer: (s) => { if (s.startsWith("Google Chrome — ")) return "handoff_show"; during = Date.now(); return "handoff_done"; } });
    const before = Date.now() - 1_000;
    h.chrome.pageEvent(key, "Runtime.consoleAPICalled", { type: "log", timestamp: before, args: [{ type: "string", value: "before the hand-off" }] });
    expect(await p({ reason: "sign in" })).toEqual({ done: true });
    // The browser replays the sign-in page's messages on Runtime.enable; one from after Winter is back is live.
    h.chrome.pageEvent(key, "Runtime.consoleAPICalled", { type: "log", timestamp: during, args: [{ type: "string", value: "one-time code 492817 accepted" }] });
    h.chrome.pageEvent(key, "Log.entryAdded", { entry: { source: "network", level: "error", text: "sign-in request failed", timestamp: during } });
    h.chrome.pageEvent(key, "Runtime.consoleAPICalled", { type: "log", timestamp: Date.now() + 5, args: [{ type: "string", value: "after the hand-off" }] });
    const entries = await h.engine.primitive(r.scope, (await h.engine.global(r.scope, "browsers.tab", { tab: `chrome:${key}` }) as TabHandle).targetId, "console", { emit: false }) as Array<{ text: string }>;
    expect(entries.map((e) => e.text)).toEqual(["before the hand-off", "after the hand-off"]);
    r.end();
  });

  test("declined, or no answer in time: { done: false } and the tab left as it was", async () => {
    const no = await opened("chrome", { answer: () => false });
    expect(await no.p({ reason: "sign in" })).toEqual({ done: false });
    expect(no.r.text()).toContain("the user did not take over (declined)");
    expect(no.h.chrome.presented).toEqual([]);
    no.r.end();

    const silent = await opened("chrome");
    expect(await silent.p({ reason: "sign in", timeoutMs: 30 })).toEqual({ done: false });
    expect(silent.r.text()).toContain("the user did not take over (no answer)");
    silent.r.end();
  });

  test("Done or Stop waiting in the browser's own toolbar answers the second card", async () => {
    const { h, r, key, p } = await opened("chrome", { answer: (s) => (s.startsWith("Google Chrome — ") ? "handoff_show" : undefined) });
    const done = p({ reason: "sign in" });
    for (let i = 0; i < 50 && h.cards.length < 2; i++) await tick();
    h.chrome.pressDone(key, true);
    expect(await done).toEqual({ done: true });
    const stop = p({ reason: "sign in again" });
    for (let i = 0; i < 50 && h.cards.length < 4; i++) await tick();
    h.chrome.pressDone(key, false);
    expect(await stop).toEqual({ done: false });
    expect(r.text()).toContain("the user stopped the wait — the tab stays with them");
    r.end();
  });

  test("the tab closed while Winter waited: TargetLost", async () => {
    const { h, r, key, p } = await opened("chrome", { answer: (s) => (s.startsWith("Google Chrome — ") ? "handoff_show" : undefined) });
    const waiting = p({ reason: "sign in" });
    for (let i = 0; i < 50 && h.cards.length < 2; i++) await tick();
    h.chrome.goneTab(key, "closed");
    const e = await failure(waiting);
    expect((e as AutomationFailure).kind).toBe("TargetLost");
    r.end();
  });

  test("the built-in browser: its hold is dropped before the first card (native prompts can show), then the tab is shown in Winter's window", async () => {
    const order: string[] = [];
    const { h, r, key, p } = await opened("winter", { answer: (s) => (s.startsWith("Winter's browser — ") ? "handoff_show" : "handoff_done") });
    const present = h.winter.present!;
    h.winter.present = async (k, o) => { order.push(`present attached=${h.winter.tabs.get(k)!.attached}`); await present(k, o); };
    expect(await p({ reason: "solve the CAPTCHA" })).toEqual({ done: true });
    expect(order).toEqual(["present attached=false"]);
    expect(h.winter.presented).toEqual([`${key}@s1`]);
    expect(r.text()).toContain("showed the tab to the user in Winter's window");
    r.end();
  });
});

describe("waitForUser(): policy and checks", () => {
  test("dont-ask never asks: NotAllowed naming the host; plan may ask (the user acts, not Winter)", async () => {
    const d = await opened("winter", { policy: "dont-ask" });
    const e = await failure(d.p({ reason: "sign in" }));
    expect((e as AutomationFailure).kind).toBe("NotAllowed");
    expect(e.message).toBe("this session never asks — tell the user in your reply what they need to do on accounts.example.com");
    expect(d.h.cards).toHaveLength(0);
    d.r.end();
    const plan = await opened("winter", { policy: "bypass", answer: () => "handoff_done" });
    plan.h.facts.policy = "plan";
    expect(await plan.p({ reason: "sign in" })).toEqual({ done: true });
    plan.r.end();
  });

  test("a page dialog open on the tab: refused TargetBusy before any card (showing the tab would dismiss it)", async () => {
    const { h, r, key, p } = await opened("winter", { answer: () => "handoff_show" });
    h.winter.openDialog(key, "confirm", "Leave without saving?");
    const e = await failure(p({ reason: "sign in" }));
    expect((e as AutomationFailure).kind).toBe("TargetBusy");
    expect(e.message).toBe("a page dialog is open (confirm) — read it with dialog() and answer it with answerDialog() first: handing the tab to the user would dismiss it");
    expect(h.cards).toHaveLength(0);
    expect(h.winter.presented).toEqual([]);
    expect(h.winter.tabs.get(key)!.attached).toBe(true);
    r.end();
  });

  test("a reason is required and capped; a bad timeout is a TypeError; an extension without present says to update it", async () => {
    const { h, r, p } = await opened("chrome");
    await expect(p({})).rejects.toThrow(/waitForUser\(\) takes a reason/);
    await expect(p({ reason: "   " })).rejects.toThrow(/takes a reason/);
    await expect(p({ reason: "x", timeoutMs: -1 })).rejects.toThrow(/positive number of ms/);
    delete h.chrome.present;
    const e = await failure(p({ reason: "sign in" }));
    expect((e as AutomationFailure).kind).toBe("BrowserUnavailable");
    r.end();
  });
});
