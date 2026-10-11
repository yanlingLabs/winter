// ComputerV2 Phase 3 — `waitForUser(reason)`, the sign-in hand-off, over the fake transports: the two cards (their
// words, options and clocks), the tab let go before it is shown (the built-in browser shown first, then let go), Done
// from the card or from the browser's own toolbar, declining, no answer, the tab closed meanwhile, dont-ask refused,
// plan allowed, and the audit count.
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

  test("I've done it on the first card: nothing is shown, the tab read again at once", async () => {
    const { h, r, p } = await opened("chrome", { answer: () => "handoff_done" });
    expect(await p({ reason: "sign in" })).toEqual({ done: true });
    expect(h.chrome.presented).toEqual([]);
    expect(h.cards).toHaveLength(1);
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

  test("the built-in browser: shown in Winter's window FIRST, then let go", async () => {
    const order: string[] = [];
    const { h, r, key, p } = await opened("winter", { answer: (s) => (s.startsWith("Winter's browser — ") ? "handoff_show" : "handoff_done") });
    const present = h.winter.present!;
    h.winter.present = async (k, o) => { order.push(`present attached=${h.winter.tabs.get(k)!.attached}`); await present(k, o); };
    expect(await p({ reason: "solve the CAPTCHA" })).toEqual({ done: true });
    expect(order).toEqual(["present attached=true"]);
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
