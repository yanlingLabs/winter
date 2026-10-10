// The browser engine (`computer-use/browser/engine.ts` + `tab-driver.ts`) over FAKE backends that enforce the CDP
// allowlist and the world rules: open/tab/list, refs and StaleRef, the per-tab diff base and locks, the site floor's
// matrix, the secure-field floor, dialogs, uploads, the screenshot mapping, the fence and the lifecycle.
import { describe, expect, test } from "bun:test";
import { symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CDP_ALLOWED_METHODS } from "../../src/computer-use/browser/cdp-allowlist";
import { AutomationFailure } from "../../src/computer-use/errors";
import type { TabHandle } from "../../src/computer-use/worker/bridge";
import { BrowserEngine } from "../../src/computer-use/browser/engine";
import { BrowserBackendRegistry } from "../../src/computer-use/browser/registry";
import { FakeCdpTransport, type FakePage } from "./browser-fake-transport";
import { harness } from "./browser-harness";

const SHOP: FakePage = {
  url: "https://shop.example.com/cart",
  title: "Checkout — Shop",
  nodes: [{
    id: 1, role: "main", children: [
      { id: 2, role: "heading", name: "Your cart", level: 2 },
      { id: 3, role: "link", name: "Continue shopping", href: "shop.example.com" },
      { id: 4, role: "text field", name: "Coupon", value: "", showEmptyValue: true },
      { id: 5, role: "text field", name: "Password", value: "<redacted>", secure: true },
      { id: 6, role: "check box", name: "Gift wrap", states: ["unchecked"] },
      { id: 7, role: "button", name: "Pay" },
      { id: 8, role: "file input", name: "Receipt" },
    ],
  }],
  secure: [5],
  editable: [4],
  fileInputs: [8],
};

async function failure(p: Promise<unknown>): Promise<AutomationFailure | Error> {
  try { await p; } catch (err) { return err as Error; }
  throw new Error("expected a failure");
}

describe("browsers.list / open / tabs / tab", () => {
  test("list: winter is the default, the connected browser is listed, an installed one is not connected", async () => {
    const h = harness({ installed: ["com.microsoft.edgemac"] });
    const r = h.run();
    const rows = await h.engine.global(r.scope, "browsers.list", {}) as Array<{ id: string; isDefault: boolean; connected: boolean; reason?: string }>;
    expect(rows.map((x) => x.id)).toEqual(["winter", "chrome", "edge"]);
    expect(rows[0]).toMatchObject({ isDefault: true, connected: true });
    expect(rows[2]).toMatchObject({ connected: false, reason: "Winter for Chrome is not installed in Microsoft Edge — ask the user" });
  });

  test("open (winter): mints a panel tab, prints the daemon line then the fenced full state, returns a tab handle", async () => {
    const h = harness();
    h.winter.pages[SHOP.url] = SHOP;
    const r = h.run();
    const handle = await h.engine.global(r.scope, "browsers.open", { url: SHOP.url }) as TabHandle;
    expect(handle).toMatchObject({ kind: "tab", browser: "winter", id: "winter:w1" });
    expect(handle.targetId).toMatch(/^bt_[0-9a-f]{12}$/);
    expect(h.panel.get("s1")).toEqual([{ tabId: "w1", url: SHOP.url }]);
    const text = r.text();
    expect(text).toContain("opened a new tab in Winter's browser\n");
    expect(text).toContain('Tab "Checkout — Shop" — https://shop.example.com/cart');
    expect(text).toContain('[2] heading "Your cart" (level 2)');
    expect(text).toContain('[3] link "Continue shopping" → shop.example.com');
    expect(text).toContain('[4] text field "Coupon" value=""');
    expect(text).toContain('[5] text field "Password" value=<redacted>');
    expect(text).toMatch(/<screen-data id="[0-9a-f]+">\nTab "Checkout/);
    expect(h.engine.owns("s1", handle.targetId)).toBe(true);
    expect(h.engine.owns("s2", handle.targetId)).toBe(false);
  });

  test("open and tab print the ordinary state of a big page (folded to its line cap); full: true is the model's to ask for", async () => {
    const h = harness();
    const big: FakePage = {
      url: "https://big.example/list", title: "Big list",
      nodes: [{ id: 1, role: "main", children: [
        { id: 2, role: "heading", name: "Results", level: 1 },
        { id: 3, role: "list", name: "Results", children: Array.from({ length: 600 }, (_, i) => ({ id: 100 + i, role: "listitem", name: `Result number ${i}` })) },
      ] }],
    };
    h.winter.pages[big.url] = big;
    const r = h.run();
    const handle = await h.engine.global(r.scope, "browsers.open", { url: big.url }) as TabHandle;
    const opened = r.text();
    expect(opened).toContain('heading "Results"');
    expect(opened.split("\n").length).toBeLessThan(330);
    expect(opened).not.toContain("Result number 599");
    // The same tab bound afresh in another session: the ordinary state too.
    const r2 = h.run("s2");
    await h.engine.global(r2.scope, "browsers.tab", { id: handle.id }).catch(() => undefined);
    const full = await h.engine.primitive(r.scope, handle.targetId, "state", { full: true }) as string;
    expect(full).toContain("Result number 599");
    expect(full).not.toContain("the full state is cut");
  });

  test("open: a non-http(s) URL is NotAllowed before anything opens; about:blank mints a tab with no url, shown as about:blank", async () => {
    const h = harness();
    const r = h.run();
    for (const url of ["file:///etc/passwd", "javascript:alert(1)", "data:text/html,hi"]) {
      const e = await failure(h.engine.global(r.scope, "browsers.open", { url }));
      expect((e as AutomationFailure).kind).toBe("NotAllowed");
    }
    expect(h.panel.get("s1")).toBeUndefined();
    // Winter's start page for about:blank is a data: URL in the app; the model reads about:blank.
    h.winter.pages["about:blank"] = { url: "data:text/html,<p>Winter</p>", title: "", nodes: [] };
    const t = await h.engine.global(r.scope, "browsers.open", { url: "about:blank" }) as TabHandle;
    expect(h.panel.get("s1")).toEqual([{ tabId: "w1" }]);
    expect(await h.engine.primitive(r.scope, t.targetId, "url", {})).toBe("about:blank");
    expect(r.text()).toContain('Tab "(untitled)" — about:blank · settled ');
    expect(r.text()).not.toContain("new page");
    const js = await failure(h.engine.primitive(r.scope, t.targetId, "goto", { url: "javascript:void(0)" }));
    expect((js as AutomationFailure).kind).toBe("NotAllowed");
    expect(js.message).toBe("goto() opens only http(s) pages and about:blank — a javascript: URL is refused");
    expect(h.winter.sent.some((s) => s.method === "Page.navigate")).toBe(false);
  });

  test("a built-in tab closed in the strip: its hold is released and its binding is TargetLost", async () => {
    const h = harness();
    const r = h.run();
    const t = await h.engine.global(r.scope, "browsers.open", { url: "https://a.example/" }) as TabHandle;
    expect(h.winter.tabs.get("w1")!.attached).toBe(true);
    h.engine.panelTabClosed("s1", "w1");
    await new Promise((res) => setTimeout(res, 0));
    expect(h.winter.tabs.get("w1")!.attached).toBe(false);
    const e = await failure(h.engine.primitive(r.scope, t.targetId, "state", {}));
    expect((e as AutomationFailure).kind).toBe("TargetLost");
  });

  test("open (chrome): checked as an act, then a bind — the per-app card names Google Chrome; the daemon line says in the background", async () => {
    const h = harness({ policy: "ask", answer: () => "session" });
    const r = h.run();
    const handle = await h.engine.global(r.scope, "browsers.open", { url: "https://example.com/", browser: "chrome" }) as TabHandle;
    expect(handle.id).toMatch(/^chrome:\d+$/);
    expect(h.cards.map((c) => c.summary)).toEqual(["Allow Winter to use Google Chrome (com.google.Chrome)?"]);
    expect(r.text()).toContain("opened a new tab in Google Chrome (in the background)");
  });

  test("open (chrome) under plan: NotAllowed before anything is created; a view-only Chrome refuses it too", async () => {
    const plan = harness({ policy: "plan" });
    const e = await failure(plan.engine.global(plan.run().scope, "browsers.open", { url: "https://example.com/", browser: "chrome" }));
    expect((e as AutomationFailure).kind).toBe("NotAllowed");
    expect(plan.chrome.tabs.size).toBe(0);
    const view = harness({ apps: { "com.google.Chrome": { access: "view" } } });
    const e2 = await failure(view.engine.global(view.run().scope, "browsers.open", { url: "https://example.com/", browser: "chrome" }));
    expect((e2 as AutomationFailure).message).toContain("view only");
    expect(view.chrome.tabs.size).toBe(0);
  });

  test("open (winter) under plan is NotAllowed; the built-in browser raises no per-app card under ask", async () => {
    const plan = harness({ policy: "plan" });
    const e = await failure(plan.engine.global(plan.run().scope, "browsers.open", { url: "https://example.com/" }));
    expect((e as AutomationFailure).kind).toBe("NotAllowed");
    const ask = harness({ policy: "ask" });
    await ask.engine.global(ask.run().scope, "browsers.open", { url: "https://example.com/" });
    expect(ask.cards).toEqual([]);
  });

  test("an unknown or disconnected browser: TypeError naming the ids / BrowserUnavailable with the reason", async () => {
    const h = harness();
    const e = await failure(h.engine.global(h.run().scope, "browsers.open", { url: "https://example.com/", browser: "netscape" }));
    expect(e).toBeInstanceOf(TypeError);
    expect(e.message).toContain("winter, chrome");
    h.winterReg.unregister();
    const e2 = await failure(h.engine.global(h.run().scope, "browsers.open", { url: "https://example.com/" }));
    expect((e2 as AutomationFailure).kind).toBe("BrowserUnavailable");
    expect(e2.message).toContain("Winter isn't running");
  });

  test("tabs: winter lists the session's own strip (yours marks agent tabs); the list is fenced", async () => {
    const h = harness();
    const r = h.run();
    await h.engine.global(r.scope, "browsers.open", { url: "https://a.example/" });
    h.panel.get("s1")!.push({ tabId: "user-tab", url: "https://b.example/", title: "B" });
    h.winter.addTab({ url: "https://b.example/", title: "B", nodes: [] }, { tabKey: "user-tab", sessionId: "s1" });
    const r2 = h.run();
    const rows = await h.engine.global(r2.scope, "browsers.tabs", { browser: "winter" }) as Array<{ id: string; yours: boolean }>;
    expect(rows.map((x) => [x.id, x.yours])).toEqual([["winter:w1", true], ["winter:user-tab", false]]);
    expect(r2.text()).toContain("<screen-data");
    // Another session's strip is not this one's.
    const other = await h.engine.global(h.run("s2").scope, "browsers.tabs", { browser: "winter" });
    expect(other).toEqual([]);
  });

  test("tab: by id or exact URL (fragment ignored); none → TargetLost; several → TypeError; again → the same handle and a diff", async () => {
    const h = harness();
    h.chrome.addTab({ url: "https://news.example/a", title: "A", nodes: [{ id: 1, role: "heading", name: "A", level: 1 }] }, { tabKey: "418" });
    h.chrome.addTab({ url: "https://dup.example/", title: "D1", nodes: [] }, { tabKey: "419" });
    h.chrome.addTab({ url: "https://dup.example/", title: "D2", nodes: [] }, { tabKey: "420" });
    const r = h.run();
    const a = await h.engine.global(r.scope, "browsers.tab", { tab: "chrome:418" }) as TabHandle;
    expect(a).toMatchObject({ id: "chrome:418", browser: "chrome" });
    expect(r.text()).toContain("bound chrome:418 in Google Chrome");
    const b = await h.engine.global(r.scope, "browsers.tab", { tab: { url: "https://news.example/a#top" } }) as TabHandle;
    expect(b.targetId).toBe(a.targetId);
    expect(r.text()).toContain("already bound");
    const lost = await failure(h.engine.global(r.scope, "browsers.tab", { tab: { url: "https://nowhere.example/" } }));
    expect((lost as AutomationFailure).kind).toBe("TargetLost");
    const many = await failure(h.engine.global(r.scope, "browsers.tab", { tab: { url: "https://dup.example/" }, browser: "chrome" }));
    expect(many).toBeInstanceOf(TypeError);
    expect(many.message).toContain("chrome:419");
  });

  test("tabs with no browser named skips one the user set to Don't allow; naming it is NotAllowed", async () => {
    const h = harness({ apps: { "com.google.Chrome": { access: "deny" } } });
    h.chrome.addTab({ url: "https://u.example/", title: "U", nodes: [] }, { tabKey: "5" });
    const r = h.run();
    await h.engine.global(r.scope, "browsers.open", { url: "https://a.example/" });
    const rows = await h.engine.global(r.scope, "browsers.tabs", {}) as Array<{ id: string }>;
    expect(rows.map((x) => x.id)).toEqual(["winter:w1"]);
    const e = await failure(h.engine.global(r.scope, "browsers.tabs", { browser: "chrome" }));
    expect((e as AutomationFailure).kind).toBe("NotAllowed");
  });

  test("listing a user's browser needs its per-app consent, as a bind: the card under ask; declined is NotAllowed", async () => {
    const yes = harness({ policy: "ask", answer: () => "once" });
    yes.chrome.addTab({ url: "https://u.example/", title: "U", nodes: [] }, { tabKey: "5" });
    const rows = await yes.engine.global(yes.run().scope, "browsers.tabs", { browser: "chrome" }) as Array<{ id: string }>;
    expect(rows.map((x) => x.id)).toEqual(["chrome:5"]);
    expect(yes.cards.map((c) => c.summary)).toEqual(["Allow Winter to use Google Chrome (com.google.Chrome)?"]);
    const no = harness({ policy: "ask", answer: () => false });
    const e = await failure(no.engine.global(no.run().scope, "browsers.tabs", { browser: "chrome" }));
    expect((e as AutomationFailure).kind).toBe("NotAllowed");
    // plan may show the card too: listing is an observation, exactly like a bind.
    const plan = harness({ policy: "plan", answer: () => "once" });
    plan.chrome.addTab({ url: "https://u.example/", title: "U", nodes: [] }, { tabKey: "5" });
    expect(await plan.engine.global(plan.run().scope, "browsers.tabs", { browser: "chrome" })).toHaveLength(1);
    expect(plan.cards).toHaveLength(1);
  });

  test("under dont-ask only an Always-allow grant lists a user's browser", async () => {
    const no = harness({ policy: "dont-ask" });
    const e = await failure(no.engine.global(no.run().scope, "browsers.tabs", { browser: "chrome" }));
    expect((e as AutomationFailure).kind).toBe("NotAllowed");
    expect(no.cards).toEqual([]);
    const always = harness({ policy: "dont-ask", apps: { "com.google.Chrome": { grant: "always" } } });
    always.chrome.addTab({ url: "https://u.example/", title: "U", nodes: [] }, { tabKey: "5" });
    expect(await always.engine.global(always.run().scope, "browsers.tabs", { browser: "chrome" })).toHaveLength(1);
  });

  test("with no browser named: the built-in tabs plus the user's browsers already allowed this session; the rest are left out and said so, with no card", async () => {
    const h = harness({ policy: "ask", answer: () => "session" });
    h.chrome.addTab({ url: "https://u.example/", title: "U", nodes: [] }, { tabKey: "5" });
    const r = h.run();
    await h.engine.global(r.scope, "browsers.open", { url: "https://a.example/" });
    const first = await h.engine.global(r.scope, "browsers.tabs", {}) as Array<{ id: string }>;
    expect(first.map((x) => x.id)).toEqual(["winter:w1"]);
    expect(h.cards).toEqual([]);
    expect(r.text()).toContain("1 browser left out: Google Chrome (chrome) — not allowed in this session yet — name one with { browser } to ask the user");
    const nf = await failure(h.engine.global(r.scope, "browsers.tab", { tab: { url: "https://u.example/" } }));
    expect((nf as AutomationFailure).kind).toBe("TargetLost");
    expect(nf.message).toContain("1 browser was not searched");
    // Allowed for the session (its card answered), the default listing includes it.
    await h.engine.global(r.scope, "browsers.tabs", { browser: "chrome" });
    const r2 = h.run();
    const after = await h.engine.global(r2.scope, "browsers.tabs", {}) as Array<{ id: string }>;
    expect(after.map((x) => x.id)).toEqual(["winter:w1", "chrome:5"]);
    expect(h.cards).toHaveLength(1);
  });

  test("tab (winter): only this session's strip can be bound", async () => {
    const h = harness();
    h.winter.addTab({ url: "https://x.example/", title: "X", nodes: [] }, { tabKey: "foreign", sessionId: "s2" });
    h.panel.set("s2", [{ tabId: "foreign", url: "https://x.example/" }]);
    const e = await failure(h.engine.global(h.run("s1").scope, "browsers.tab", { tab: "winter:foreign" }));
    expect((e as AutomationFailure).kind).toBe("TargetLost");
  });
});

describe("refs, diffs, locks", () => {
  test("refs stay stable across states; a new document makes them StaleRef and the header says new page", async () => {
    const h = harness();
    h.winter.pages[SHOP.url] = SHOP;
    const r = h.run();
    const t = await h.engine.global(r.scope, "browsers.open", { url: SHOP.url }) as TabHandle;
    const s2 = await h.engine.primitive(r.scope, t.targetId, "state", { full: true }) as string;
    expect(s2).toContain("[7] button \"Pay\"");
    await h.engine.primitive(r.scope, t.targetId, "click", { target: 7 });
    h.winter.navigateTo("w1", "https://shop.example.com/done");
    const stale = await failure(h.engine.primitive(r.scope, t.targetId, "click", { target: 7 }));
    expect((stale as AutomationFailure).kind).toBe("StaleRef");
    const s3 = await h.engine.primitive(r.scope, t.targetId, "state", {}) as string;
    expect(s3.split("\n")[0]).toContain(" · new page");
    // Refs are never reused: the new page's first element is past every earlier ref.
    expect(s3).not.toContain("[1] text");
    expect(s3).toMatch(/\[9\] text "page https:\/\/shop.example.com\/done"/);
  });

  test("state() prints only what changed since the printed base; emit:false does not move the base; a reset forgets it", async () => {
    const h = harness();
    h.winter.pages[SHOP.url] = SHOP;
    const r = h.run();
    const t = await h.engine.global(r.scope, "browsers.open", { url: SHOP.url }) as TabHandle;
    await h.engine.primitive(r.scope, t.targetId, "setValue", { ref: 4, value: "SAVE10" });
    const quiet = await h.engine.primitive(r.scope, t.targetId, "state", { emit: false }) as string;
    expect(quiet).toContain('~ [4] value "" → "SAVE10"');
    const printed = await h.engine.primitive(r.scope, t.targetId, "state", {}) as string;
    expect(printed).toContain('~ [4] value "" → "SAVE10"');
    const again = await h.engine.primitive(r.scope, t.targetId, "state", {}) as string;
    expect(again).toContain("(no changes)");
    h.engine.forgetBindings("s1");
    expect(h.engine.owns("s1", t.targetId)).toBe(false);
  });

  test("two sessions on one tab: the second waits for the tab lock and gets TargetBusy naming the holder", async () => {
    const h = harness();
    h.chrome.addTab({ url: "https://x.example/", title: "X", nodes: [] }, { tabKey: "7" });
    const a = h.run("s1");
    const b = h.run("s2");
    await h.engine.global(a.scope, "browsers.tab", { tab: "chrome:7" });
    const e = await failure(h.engine.global(b.scope, "browsers.tab", { tab: "chrome:7" }));
    expect((e as AutomationFailure).kind).toBe("TargetBusy");
    expect(e.message).toContain("session s1");
    a.end();
    await h.engine.global(b.scope, "browsers.tab", { tab: "chrome:7" });
  });

  test("every CDP method the engine sends is on the allowlist (the fake refuses anything else)", async () => {
    const h = harness();
    h.winter.pages[SHOP.url] = SHOP;
    const r = h.run();
    const t = await h.engine.global(r.scope, "browsers.open", { url: SHOP.url }) as TabHandle;
    for (const [p, a] of [["click", { target: 7 }], ["type", { text: "hi", into: 4 }], ["key", { combo: "cmd+a", into: 4 }], ["scroll", { target: 3, direction: "down" }],
      ["hover", { target: 3, ms: 1 }], ["find", { query: "Pay" }], ["text", {}], ["waitForIdle", { timeoutMs: 100 }], ["screenshot", {}], ["goto", { url: "https://shop.example.com/x" }], ["back", {}], ["reload", {}]] as const) {
      await h.engine.primitive(r.scope, t.targetId, p, a as Record<string, unknown>);
    }
    for (const s of h.winter.sent) expect(CDP_ALLOWED_METHODS).toContain(s.method);
    // The world rule: no Runtime call ever went outside a "winter" world (the fake would have thrown).
    expect(h.winter.sent.some((s) => s.method === "Page.createIsolatedWorld" && s.params.worldName === "winter")).toBe(true);
  });
});

describe("the secure-field floor and input", () => {
  test("type into a password field is Refused with Phase 1's sentence; setValue too", async () => {
    const h = harness();
    h.winter.pages[SHOP.url] = SHOP;
    const r = h.run();
    const t = await h.engine.global(r.scope, "browsers.open", { url: SHOP.url }) as TabHandle;
    const e = await failure(h.engine.primitive(r.scope, t.targetId, "type", { text: "hunter2", into: 5 }));
    expect((e as AutomationFailure).kind).toBe("Refused");
    expect(e.message).toBe("that is a password or payment field — Winter never reads or types into one; ask the user to fill it in");
    const e2 = await failure(h.engine.primitive(r.scope, t.targetId, "setValue", { ref: 5, value: "x" }));
    expect((e2 as AutomationFailure).kind).toBe("Refused");
    expect(h.winter.sent.some((s) => s.method === "Input.dispatchKeyEvent")).toBe(false);
  });

  test("type with no focused field is Refused (not a text field); into a text field it says what it sent and what was received", async () => {
    const h = harness();
    h.winter.pages[SHOP.url] = SHOP;
    const r = h.run();
    const t = await h.engine.global(r.scope, "browsers.open", { url: SHOP.url }) as TabHandle;
    const e = await failure(h.engine.primitive(r.scope, t.targetId, "type", { text: "x" }));
    expect((e as AutomationFailure).kind).toBe("Refused");
    await h.engine.primitive(r.scope, t.targetId, "paste", { text: "SAVE10", into: 4 });
    expect(r.text()).toContain('pasted into [4] text field "Coupon"');
  });

  test("a payment iframe's field is secure; the frame's content is grafted under its iframe node", async () => {
    const h = harness();
    h.winter.pages["https://pay.example/"] = {
      url: "https://pay.example/", title: "Pay", nodes: [{ id: 6, role: "iframe", name: "Payment", frame: true, origin: "pay.example.com" }],
      frames: [{ frameId: "f1", ownerId: 6, nodes: [{ id: 1, role: "text field", name: "Card number", value: "<redacted>", secure: true }], secure: [1], oopif: true }],
    };
    const r = h.run();
    const t = await h.engine.global(r.scope, "browsers.open", { url: "https://pay.example/" }) as TabHandle;
    const text = r.text();
    expect(text).toContain('[1] iframe "Payment" (pay.example.com)');
    expect(text).toMatch(/\n {2}\[2\] text field "Card number" value=<redacted>/);
    const e = await failure(h.engine.primitive(r.scope, t.targetId, "type", { text: "4242", into: 2 }));
    expect((e as AutomationFailure).kind).toBe("Refused");
    // The OOPIF's runtime lives in its own CDP session.
    expect(h.winter.sent.some((s) => s.method === "Page.createIsolatedWorld" && s.session === "S-f1")).toBe(true);
  });

  test("a covered element: Error naming what covers it; a point needs a screenshot first, and vision", async () => {
    const h = harness();
    h.winter.pages[SHOP.url] = { ...SHOP, covered: { 7: { id: 40, role: "dialog", name: "Cookies" } } };
    const r = h.run();
    const t = await h.engine.global(r.scope, "browsers.open", { url: SHOP.url }) as TabHandle;
    const e = await failure(h.engine.primitive(r.scope, t.targetId, "click", { target: 7 }));
    expect(e.constructor).toBe(Error);
    expect(e.message).toMatch(/^\[\d+\] is covered by \[\d+\] dialog "Cookies" — dismiss it first$/);
    const p = await failure(h.engine.primitive(r.scope, t.targetId, "click", { target: [10, 10] }));
    expect((p as AutomationFailure).kind).toBe("NotAllowed");
    const blind = harness({ vision: false });
    blind.winter.pages[SHOP.url] = SHOP;
    const br = blind.run();
    const bt = await blind.engine.global(br.scope, "browsers.open", { url: SHOP.url }) as TabHandle;
    const v = await failure(blind.engine.primitive(br.scope, bt.targetId, "click", { target: [1, 1] }));
    expect((v as AutomationFailure).kind).toBe("NotAllowed");
    expect(v.message).toBe("this model can't see images — use state()");
    const s = await failure(blind.engine.primitive(br.scope, bt.targetId, "screenshot", {}));
    expect((s as AutomationFailure).kind).toBe("NotAllowed");
  });
});

describe("text leaves and frame refs", () => {
  test("setValue / upload on a label's text name the field it labels; on other text, say what takes a field", async () => {
    const h = harness();
    h.winter.pages[SHOP.url] = {
      ...SHOP,
      nodes: [{ ...SHOP.nodes[0]!, children: [...SHOP.nodes[0]!.children!, { id: 9, role: "text", name: "Coupon" }, { id: 10, role: "text", name: "Free delivery" }, { id: 11, role: "text", name: "Receipt" }] }],
      textLeaves: { 9: 4, 10: null, 11: 8 },
    };
    writeFileSync(join(h.cwd, "a.txt"), "hello");
    const r = h.run();
    const t = await h.engine.global(r.scope, "browsers.open", { url: SHOP.url }) as TabHandle;
    const labelled = await failure(h.engine.primitive(r.scope, t.targetId, "setValue", { ref: 9, value: "SAVE10" }));
    expect(labelled.message).toBe("[9] is text, not a field — it labels [4]: setValue([4], …)");
    expect((labelled as AutomationFailure).kind).toBeUndefined();
    const plain = await failure(h.engine.primitive(r.scope, t.targetId, "setValue", { ref: 10, value: "x" }));
    expect(plain.message).toBe("[10] is text, not a field — setValue() takes a field's ref (state() and find() list them)");
    const up = await failure(h.engine.primitive(r.scope, t.targetId, "upload", { ref: 11, paths: "a.txt" }));
    expect(up.message).toBe("[11] is text, not a field — it labels [8]: upload([8], …)");
    expect(h.winter.sent.some((s) => s.method === "DOM.setFileInputFiles")).toBe(false);
  });

  test("waitFor a ref in an iframe checks that frame's runtime, never the top frame's node with the same id", async () => {
    const h = harness();
    const url = "https://widget.example/";
    h.winter.pages[url] = {
      url, title: "Widget", nodes: [{ id: 1, role: "text", name: "Header" }, { id: 6, role: "iframe", name: "Widget", frame: true }],
      frames: [{ frameId: "f1", ownerId: 6, nodes: [{ id: 1, role: "text", name: "Loading…" }] }],
    };
    const r = h.run();
    const t = await h.engine.global(r.scope, "browsers.open", { url }) as TabHandle;
    expect(r.text()).toContain('[3] text "Loading…"');
    // Still there: the wait times out (the top frame's id 1, "Header", is not what it waits on).
    const e = await failure(h.engine.primitive(r.scope, t.targetId, "waitFor", { cond: { ref: 3 }, timeoutMs: 1 }).then(() =>
      h.engine.primitive(r.scope, t.targetId, "waitFor", { cond: { gone: 3 }, timeoutMs: 150 })));
    expect((e as AutomationFailure).kind).toBe("WaitTimeout");
    // The frame's text goes: the wait is met, though the top frame still has a node with id 1.
    h.winter.tabs.get("w1")!.page.frames![0]!.nodes = [];
    await h.engine.primitive(r.scope, t.targetId, "waitFor", { cond: { gone: 3 }, timeoutMs: 1_000 });
    const gone = await failure(h.engine.primitive(r.scope, t.targetId, "waitFor", { cond: { ref: 3 }, timeoutMs: 150 }));
    expect((gone as AutomationFailure).kind).toBe("WaitTimeout");
  });
});

describe("screenshots", () => {
  test("the JPEG fits the model's budget, the daemon line names both sizes, and a point maps back to CSS px", async () => {
    const h = harness();
    h.winter.pages[SHOP.url] = SHOP;
    const r = h.run();
    r.scope.metric.primitive = "screenshot";
    const t = await h.engine.global(r.scope, "browsers.open", { url: SHOP.url }) as TabHandle;
    const img = await h.engine.primitive(r.scope, t.targetId, "screenshot", {}) as { width: number; height: number };
    // 1200×800 CSS at DPR 2, the default budget's 1280-px long edge.
    expect(Math.max(img.width, img.height)).toBeLessThanOrEqual(1280);
    expect(r.text()).toContain(`clicks take this image's pixel coordinates: ${img.width}×${img.height} (viewport 1200×800 CSS px)`);
    await h.engine.primitive(r.scope, t.targetId, "click", { target: [img.width / 2, img.height / 2] });
    const press = h.winter.sent.filter((s) => s.method === "Input.dispatchMouseEvent" && s.params.type === "mousePressed").pop()!;
    expect(press.params.x).toBeCloseTo(600, 0);
    expect(press.params.y).toBeCloseTo(400, 0);
    // The capture's clip is the visual viewport in page coordinates (scrolled 300 px).
    const cap = h.winter.sent.find((s) => s.method === "Page.captureScreenshot")!;
    expect((cap.params.clip as { y: number }).y).toBe(300);
  });
});

describe("dialogs", () => {
  test("a confirm shows first after the header; any other act is TargetBusy; clicking OK answers it", async () => {
    const h = harness();
    h.winter.pages[SHOP.url] = SHOP;
    const r = h.run();
    const t = await h.engine.global(r.scope, "browsers.open", { url: SHOP.url }) as TabHandle;
    h.winter.openDialog("w1", "confirm", "Leave this page?");
    const s = await h.engine.primitive(r.scope, t.targetId, "state", {}) as string;
    const lines = s.split("\n");
    expect(lines[1]).toMatch(/^dialog confirm "Leave this page\?" — \[(\d+)\] button "OK" · \[(\d+)\] button "Cancel"$/);
    const ok = Number(/\[(\d+)\] button "OK"/.exec(lines[1]!)![1]);
    const busy = await failure(h.engine.primitive(r.scope, t.targetId, "click", { target: 7 }));
    expect((busy as AutomationFailure).kind).toBe("TargetBusy");
    expect(busy.message).not.toContain("Leave this page");
    await h.engine.primitive(r.scope, t.targetId, "click", { target: ok });
    expect(h.winter.sent.some((x) => x.method === "Page.handleJavaScriptDialog" && x.params.accept === true)).toBe(true);
    await h.engine.primitive(r.scope, t.targetId, "click", { target: 7 });
  });

  test("a prompt's field takes setValue, and OK sends it", async () => {
    const h = harness();
    const r = h.run();
    const t = await h.engine.global(r.scope, "browsers.open", { url: "https://p.example/" }) as TabHandle;
    h.winter.openDialog("w1", "prompt", "Your name?");
    const s = await h.engine.primitive(r.scope, t.targetId, "state", {}) as string;
    const field = Number(/\[(\d+)\] text field/.exec(s)![1]);
    const ok = Number(/\[(\d+)\] button "OK"/.exec(s)![1]);
    await h.engine.primitive(r.scope, t.targetId, "setValue", { ref: field, value: "Ada" });
    await h.engine.primitive(r.scope, t.targetId, "click", { target: ok });
    expect(h.winter.sent.find((x) => x.method === "Page.handleJavaScriptDialog")!.params).toEqual({ accept: true, promptText: "Ada" });
  });

  test("goto on an agent tab accepts its own beforeunload", async () => {
    const h = harness();
    const r = h.run();
    const t = await h.engine.global(r.scope, "browsers.open", { url: "https://p.example/" }) as TabHandle;
    h.winter.tabs.get("w1")!.beforeUnload = true;
    await h.engine.primitive(r.scope, t.targetId, "goto", { url: "https://q.example/" });
    expect(h.winter.sent.some((x) => x.method === "Page.handleJavaScriptDialog" && x.params.accept === true)).toBe(true);
    expect(await h.engine.primitive(r.scope, t.targetId, "url", {})).toBe("https://q.example/");
    // A beforeunload the PAGE raises by itself on a user's tab is shown, not answered.
    h.chrome.addTab({ url: "https://u.example/", title: "U", nodes: [] }, { tabKey: "9" });
    const u = await h.engine.global(r.scope, "browsers.tab", { tab: "chrome:9" }) as TabHandle;
    h.chrome.openDialog("9", "beforeunload", "");
    const s = await h.engine.primitive(r.scope, u.targetId, "state", {}) as string;
    expect(s.split("\n")[1]).toMatch(/^dialog beforeunload/);
    expect(h.chrome.sent.some((x) => x.tabKey === "9" && x.method === "Page.handleJavaScriptDialog")).toBe(false);
  });

  test("goto, back, forward and reload never navigate the user's own tab in their browser (Winter's built-in strip is exempt)", async () => {
    const h = harness();
    h.chrome.addTab({ url: "https://u.example/", title: "U", nodes: [] }, { tabKey: "9" });
    const r = h.run();
    const u = await h.engine.global(r.scope, "browsers.tab", { tab: "chrome:9" }) as TabHandle;
    for (const [p, a] of [["goto", { url: "https://v.example/" }], ["back", {}], ["forward", {}], ["reload", {}]] as const) {
      const e = await failure(h.engine.primitive(r.scope, u.targetId, p, a as Record<string, unknown>));
      expect((e as AutomationFailure).kind).toBe("NotAllowed");
      expect(e.message).toBe("this is the user's own tab — navigating it away could raise a leave-page prompt and lose their work; open the page in a new tab with browsers.open(url)");
    }
    expect(h.chrome.sent.some((x) => x.tabKey === "9" && /^Page\.(navigate|reload|navigateToHistoryEntry|getNavigationHistory)$/.test(x.method))).toBe(false);
    // In-page acts on it stay allowed.
    await h.engine.primitive(r.scope, u.targetId, "state", {});
    // The tab Winter opened in the same browser navigates; so does the user's tab in Winter's own strip.
    const mine = await h.engine.global(r.scope, "browsers.open", { url: "https://a.example/", browser: "chrome" }) as TabHandle;
    await h.engine.primitive(r.scope, mine.targetId, "goto", { url: "https://b.example/" });
    h.panel.set("s1", [{ tabId: "user-tab", url: "https://w.example/" }]);
    h.winter.addTab({ url: "https://w.example/", title: "W", nodes: [] }, { tabKey: "user-tab", sessionId: "s1" });
    const w = await h.engine.global(r.scope, "browsers.tab", { tab: "winter:user-tab" }) as TabHandle;
    await h.engine.primitive(r.scope, w.targetId, "goto", { url: "https://x.example/" });
    expect(await h.engine.primitive(r.scope, w.targetId, "url", {})).toBe("https://x.example/");
  });
});

describe("navigation", () => {
  test("goto: a net error is an Error with the browser's code; back with no history says so", async () => {
    const h = harness();
    const r = h.run();
    const t = await h.engine.global(r.scope, "browsers.open", { url: "https://p.example/" }) as TabHandle;
    h.winter.failNextNavigate = "net::ERR_NAME_NOT_RESOLVED";
    const e = await failure(h.engine.primitive(r.scope, t.targetId, "goto", { url: "https://nope.invalid/" }));
    expect(e.message).toContain("net::ERR_NAME_NOT_RESOLVED");
    const back = await failure(h.engine.primitive(r.scope, t.targetId, "back", {}));
    expect(back.message).toBe("no page to go back to");
    await h.engine.primitive(r.scope, t.targetId, "goto", { url: "https://q.example/" });
    expect(await h.engine.primitive(r.scope, t.targetId, "url", {})).toBe("https://q.example/");
    await h.engine.primitive(r.scope, t.targetId, "back", {});
    expect(await h.engine.primitive(r.scope, t.targetId, "url", {})).toBe("https://p.example/");
  });

  test("url() and title() return without printing, but the result is fenced", async () => {
    const h = harness();
    const r = h.run();
    const t = await h.engine.global(r.scope, "browsers.open", { url: "https://p.example/" }) as TabHandle;
    const before = r.builder.build().content.length;
    await h.engine.primitive(r.scope, t.targetId, "title", {});
    expect(r.builder.build().content.length).toBe(before);
    expect(r.builder.readScreen).toBe(true);
  });
});

describe("the dangerous-domain floor", () => {
  const LISTED = "https://evil.example/";
  test("ask: a site card naming the host and the browser; once covers the run", async () => {
    const h = harness({ policy: "ask", dangerousAdded: ["evil.example"], answer: () => "once" });
    const r = h.run();
    await h.engine.global(r.scope, "browsers.open", { url: LISTED });
    expect(h.cards.map((c) => c.summary)).toEqual(["Allow Winter to use evil.example in Winter's browser? It is on the dangerous-domains list."]);
    expect([...r.sites]).toEqual(["evil.example"]);
  });

  test("ask, declined: NotAllowed and nothing opened", async () => {
    const h = harness({ policy: "ask", dangerousAdded: ["evil.example"], answer: () => false });
    const e = await failure(h.engine.global(h.run().scope, "browsers.open", { url: LISTED }));
    expect((e as AutomationFailure).kind).toBe("NotAllowed");
    expect(h.panel.get("s1")).toBeUndefined();
  });

  test("a standing WebFetch(domain:…) rule counts as approval under ask", async () => {
    const h = harness({ policy: "ask", dangerousAdded: ["evil.example"], savedRules: ["WebFetch(domain:evil.example)"] });
    await h.engine.global(h.run().scope, "browsers.open", { url: LISTED });
    expect(h.cards).toEqual([]);
  });

  for (const [policy, mode] of [["auto", "code"], ["bypass", "code"], ["dont-ask", "code"], ["ask", "dispatch"]] as const) {
    test(`${policy} (${mode}): a hard block, no card, even with a standing rule`, async () => {
      const h = harness({ policy, facts: { mode }, dangerousAdded: ["evil.example"], savedRules: ["WebFetch(domain:evil.example)"] });
      const e = await failure(h.engine.global(h.run().scope, "browsers.open", { url: LISTED }));
      expect((e as AutomationFailure).kind).toBe("NotAllowed");
      expect(h.cards).toEqual([]);
    });
  }

  test("a committed navigation onto a listed host: only back/close/url/title work until it navigates away", async () => {
    const h = harness({ policy: "auto", dangerousAdded: ["evil.example"] });
    const r = h.run();
    const t = await h.engine.global(r.scope, "browsers.open", { url: "https://ok.example/" }) as TabHandle;
    h.winter.navigateTo("w1", LISTED);
    const e = await failure(h.engine.primitive(r.scope, t.targetId, "state", {}));
    expect((e as AutomationFailure).kind).toBe("NotAllowed");
    expect(e.message).toContain("only back(), close(), url() and title() work");
    expect(await h.engine.primitive(r.scope, t.targetId, "url", {})).toBe(LISTED);
    await h.engine.primitive(r.scope, t.targetId, "back", {});
    await h.engine.primitive(r.scope, t.targetId, "state", {});
  });

  test("goto onto a listed host under auto is refused before it navigates", async () => {
    const h = harness({ policy: "auto", dangerousAdded: ["evil.example"] });
    const r = h.run();
    const t = await h.engine.global(r.scope, "browsers.open", { url: "https://ok.example/" }) as TabHandle;
    const e = await failure(h.engine.primitive(r.scope, t.targetId, "goto", { url: LISTED }));
    expect((e as AutomationFailure).kind).toBe("NotAllowed");
    expect(h.winter.sent.some((s) => s.method === "Page.navigate")).toBe(false);
  });
});

describe("upload", () => {
  test("a file in the cwd is set on the file input; a symlink, a path outside, the home and the deny list are refused", async () => {
    const h = harness();
    h.winter.pages[SHOP.url] = SHOP;
    writeFileSync(join(h.cwd, "a.txt"), "hello");
    writeFileSync(join(h.cwd, "secret.txt"), "no");
    symlinkSync(join(h.cwd, "a.txt"), join(h.cwd, "link.txt"));
    writeFileSync(join(h.home, "h.txt"), "home");
    const r = h.run();
    const t = await h.engine.global(r.scope, "browsers.open", { url: SHOP.url }) as TabHandle;
    await h.engine.primitive(r.scope, t.targetId, "upload", { ref: 8, paths: "a.txt" });
    const set = h.winter.sent.find((s) => s.method === "DOM.setFileInputFiles")!;
    expect((set.params.files as string[])[0]).toEndWith("/a.txt");
    expect(r.text()).toContain("uploaded 1 file into [8]");
    for (const bad of ["link.txt", "/etc/hosts", join(h.home, "h.txt")]) {
      const e = await failure(h.engine.primitive(r.scope, t.targetId, "upload", { ref: 8, paths: bad }));
      expect((e as AutomationFailure).kind).toBe("NotAllowed");
    }
    const notInput = await failure(h.engine.primitive(r.scope, t.targetId, "upload", { ref: 7, paths: "a.txt" }));
    expect(notInput.message).toContain("not a file input");
  });
});

describe("lifecycle", () => {
  test("turn end: the user's tabs are released (never closed); unmarked agent tabs in the user's browser close; built-in ones stay", async () => {
    const h = harness();
    h.chrome.addTab({ url: "https://u.example/", title: "U", nodes: [] }, { tabKey: "5" });
    const r = h.run();
    const user = await h.engine.global(r.scope, "browsers.tab", { tab: "chrome:5" }) as TabHandle;
    const agent = await h.engine.global(r.scope, "browsers.open", { url: "https://a.example/", browser: "chrome" }) as TabHandle;
    const builtIn = await h.engine.global(r.scope, "browsers.open", { url: "https://w.example/" }) as TabHandle;
    r.end();
    h.engine.turnEnded("s1");
    const r2 = h.run();
    const e = await failure(h.engine.primitive(r2.scope, user.targetId, "state", {}));
    expect((e as AutomationFailure).kind).toBe("TargetLost");
    expect(e.message).toContain("released at the end of the turn");
    expect(h.chrome.tabs.get("5")!.closed).toBe(false);
    // The agent's own tab — the one it was just using — closed (being "selected" is not special).
    expect(h.chrome.tabs.get(agent.id.split(":")[1]!)!.closed).toBe(true);
    const gone = await failure(h.engine.primitive(r2.scope, agent.targetId, "state", {}));
    expect((gone as AutomationFailure).kind).toBe("TargetLost");
    expect(gone.message).toContain("when your turn ended");
    // The built-in browser's tab is never closed by the rule, and stays bound.
    await h.engine.primitive(r2.scope, builtIn.targetId, "state", {});
    expect([...h.winter.tabs.values()].every((t) => !t.closed)).toBe(true);
    // Re-binding the user's tab gives the same handle; close() on it is NotAllowed.
    const again = await h.engine.global(r2.scope, "browsers.tab", { tab: "chrome:5" }) as TabHandle;
    expect(again.targetId).toBe(user.targetId);
    const no = await failure(h.engine.primitive(r2.scope, user.targetId, "close", {}));
    expect((no as AutomationFailure).kind).toBe("NotAllowed");
  });

  test("keep() hands a tab to the user for good; handoff() lets it survive one turn end, then it closes", async () => {
    const h = harness();
    const r = h.run();
    const kept = await h.engine.global(r.scope, "browsers.open", { url: "https://k.example/", browser: "chrome" }) as TabHandle;
    const handed = await h.engine.global(r.scope, "browsers.open", { url: "https://h.example/", browser: "chrome" }) as TabHandle;
    await h.engine.primitive(r.scope, kept.targetId, "keep", {});
    await h.engine.primitive(r.scope, handed.targetId, "handoff", {});
    // A kept tab is the user's now: close() refuses it.
    const refused = await failure(h.engine.primitive(r.scope, kept.targetId, "close", {}));
    expect((refused as AutomationFailure).kind).toBe("NotAllowed");
    expect(refused.message).toBe("that tab is the user's now — Winter never closes it");
    // …and tabs() no longer calls it yours (the handed-off one still is).
    const rows = await h.engine.global(r.scope, "browsers.tabs", { browser: "chrome", emit: false }) as Array<{ id: string; yours: boolean }>;
    expect(rows.find((x) => x.id === kept.id)?.yours).toBe(false);
    expect(rows.find((x) => x.id === handed.id)?.yours).toBe(true);
    r.end();
    const tab = (t: TabHandle) => h.chrome.tabs.get(t.id.split(":")[1]!)!;
    expect(tab(kept).kept).toBe(true);
    h.engine.turnEnded("s1");
    expect(tab(kept).closed).toBe(false);
    expect(tab(handed).closed).toBe(false);
    const r2 = h.run();
    await h.engine.primitive(r2.scope, handed.targetId, "state", {});
    r2.end();
    // The mark was cleared at that turn end: the next one closes it (unless handed off again).
    h.engine.turnEnded("s1");
    expect(tab(handed).closed).toBe(true);
    expect(tab(kept).closed).toBe(false);
    h.engine.turnEnded("s1");
    expect(tab(kept).closed).toBe(false);
  });

  test("handoff() and keep() are click-only acts: a view-only Chrome refuses them, a click-only one allows them", async () => {
    const view = harness({ apps: { "com.google.Chrome": { access: "view" } } });
    view.chrome.addTab({ url: "https://u.example/", title: "U", nodes: [] }, { tabKey: "5", agent: true });
    const vr = view.run();
    const vt = await view.engine.global(vr.scope, "browsers.tab", { tab: "chrome:5" }) as TabHandle;
    const e = await failure(view.engine.primitive(vr.scope, vt.targetId, "handoff", {}));
    expect((e as AutomationFailure).kind).toBe("NotAllowed");
    const click = harness({ apps: { "com.google.Chrome": { access: "click" } } });
    const cr = click.run();
    const ct = await failure(click.engine.global(cr.scope, "browsers.open", { url: "https://a.example/", browser: "chrome" }));
    expect((ct as AutomationFailure).kind).toBe("NotAllowed"); // opening a tab is full-class
    click.chrome.addTab({ url: "https://u.example/", title: "U", nodes: [] }, { tabKey: "6" });
    const bound = await click.engine.global(cr.scope, "browsers.tab", { tab: "chrome:6" }) as TabHandle;
    await click.engine.primitive(cr.scope, bound.targetId, "handoff", {});
    await click.engine.primitive(cr.scope, bound.targetId, "keep", {});
  });

  test("the runtime idling out and the daemon stopping close nothing; deletion and archiving close the remaining agent tabs", async () => {
    const h = harness();
    const r = h.run();
    const a = await h.engine.global(r.scope, "browsers.open", { url: "https://a.example/", browser: "chrome" }) as TabHandle;
    const k = await h.engine.global(r.scope, "browsers.open", { url: "https://k.example/", browser: "chrome" }) as TabHandle;
    await h.engine.primitive(r.scope, a.targetId, "handoff", {});
    await h.engine.primitive(r.scope, k.targetId, "keep", {});
    await h.engine.global(r.scope, "browsers.open", { url: "https://w.example/" });
    r.end();
    const tab = (t: TabHandle) => h.chrome.tabs.get(t.id.split(":")[1]!)!;
    h.engine.sessionEnded("s1", "idle");
    h.engine.sessionEnded("s1", "stop");
    expect(tab(a).closed).toBe(false);
    h.engine.sessionEnded("s1", "deleted");
    expect(tab(a).closed).toBe(true);
    expect(tab(k).closed).toBe(false);
    expect([...h.winter.tabs.values()].every((t) => !t.closed)).toBe(true);

    const arch = harness();
    const ar = arch.run("s9");
    const t = await arch.engine.global(ar.scope, "browsers.open", { url: "https://a.example/", browser: "chrome" }) as TabHandle;
    await arch.engine.primitive(ar.scope, t.targetId, "handoff", {});
    ar.end();
    arch.engine.sessionArchived("s9");
    expect(arch.chrome.tabs.get(t.id.split(":")[1]!)!.closed).toBe(true);
  });

  test("after a daemon restart: the browser's agent tabs this run never opened close unless their session is running a turn", async () => {
    const registry = new BrowserBackendRegistry();
    const late = new FakeCdpTransport("chrome", "chrome");
    late.addTab({ url: "https://idle.example/", title: "I", nodes: [] }, { tabKey: "1", sessionId: "s-idle", agent: true });
    late.addTab({ url: "https://busy.example/", title: "B", nodes: [] }, { tabKey: "2", sessionId: "s-busy", agent: true });
    late.addTab({ url: "https://mine.example/", title: "M", nodes: [] }, { tabKey: "3" });
    const engine = new BrowserEngine({
      registry, mintWinterTab: () => "x", winterTabs: () => ({ tabs: [] }), sessionInfo: () => ({}), home: "/nonexistent",
      turnRunning: (sid) => sid === "s-busy",
    });
    registry.register(late, { family: "chrome", name: "Google Chrome", bundleId: "com.google.Chrome", instanceKey: "chrome-1" });
    await new Promise((r) => setTimeout(r, 10));
    expect(late.tabs.get("1")!.closed).toBe(true);
    expect(late.tabs.get("2")!.closed).toBe(false);
    expect(late.tabs.get("3")!.closed).toBe(false);
    // A service-worker restart (the same instance re-registering) closes nothing this run opened.
    const r = new FakeCdpTransport("chrome", "chrome");
    r.addTab({ url: "https://busy.example/", title: "B", nodes: [] }, { tabKey: "2", sessionId: "s-busy", agent: true });
    registry.register(r, { family: "chrome", name: "Google Chrome", bundleId: "com.google.Chrome", instanceKey: "chrome-1" });
    await new Promise((res) => setTimeout(res, 10));
    expect(r.tabs.get("2")!.closed).toBe(false);
    engine.stop();
  });

  test("a tab closed under the engine is TargetLost; the extension's Stop stops the session holding it", async () => {
    const h = harness();
    const r = h.run();
    const t = await h.engine.global(r.scope, "browsers.open", { url: "https://a.example/", browser: "chrome" }) as TabHandle;
    h.chrome.pressStop(t.id.split(":")[1]!);
    expect(h.stops).toEqual([{ sessionId: "s1", reason: "the user pressed Stop in the browser" }]);
    h.chrome.goneTab(t.id.split(":")[1]!, "detached_by_user");
    const e = await failure(h.engine.primitive(r.scope, t.targetId, "state", {}));
    expect((e as AutomationFailure).kind).toBe("TargetLost");
    expect(e.message).toContain("the user stopped Winter from controlling this tab");
  });

  test("Allow once: a user browser bound on it is released when the run ends", async () => {
    const h = harness({ policy: "ask", answer: () => "once" });
    h.chrome.addTab({ url: "https://u.example/", title: "U", nodes: [] }, { tabKey: "5" });
    const r = h.run();
    const t = await h.engine.global(r.scope, "browsers.tab", { tab: "chrome:5" }) as TabHandle;
    r.end();
    const e = await failure(h.engine.primitive(h.run().scope, t.targetId, "state", {}));
    expect((e as AutomationFailure).kind).toBe("TargetLost");
    expect(e.message).toContain("allowed for one call only");
  });

  test("closing a built-in agent tab records it for the strip", async () => {
    const h = harness();
    const r = h.run();
    const t = await h.engine.global(r.scope, "browsers.open", { url: "https://a.example/" }) as TabHandle;
    await h.engine.primitive(r.scope, t.targetId, "close", {});
    expect(h.closedWinter).toEqual([{ sessionId: "s1", tabId: "w1" }]);
    const e = await failure(h.engine.primitive(r.scope, t.targetId, "state", {}));
    expect((e as AutomationFailure).kind).toBe("TargetLost");
  });
});
