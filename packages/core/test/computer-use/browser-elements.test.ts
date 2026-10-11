// ComputerV2 Phase 3 — a tab's element readers and the small Playwright-parity members: inspect (ref or point),
// html, text({ within }), find's DOM keys, assets, screenshot({ within | fullPage }), setValue(ref, bool),
// waitFor({ load }), dialog() / answerDialog(). Over the fake transport (the page runtime's own DOM code is exercised
// by the e2e suite against a real Chrome).
import { describe, expect, test } from "bun:test";
import { AutomationFailure } from "../../src/computer-use/errors";
import type { TabHandle } from "../../src/computer-use/worker/bridge";
import type { FakePage } from "./browser-fake-transport";
import { harness } from "./browser-harness";

const PAGE: FakePage = {
  url: "https://shop.example.com/", title: "Shop",
  nodes: [{ id: 1, role: "main", children: [
    { id: 2, role: "heading", name: "Deals", level: 1 },
    { id: 3, role: "link", name: "Price list", href: "shop.example.com" },
    { id: 4, role: "check box", name: "Gift wrap", states: ["unchecked"] },
    { id: 5, role: "check box", name: "Newsletter", states: ["checked"] },
    { id: 6, role: "button", name: "Pay", states: ["disabled"] },
  ] }],
  attributes: { 3: { href: "https://shop.example.com/prices.csv", "data-testid": "prices" } },
  html: "<!doctype html>\n<html><body><h1>Deals</h1></body></html>",
  assets: [{ kind: "image", url: "https://cdn.example.com/a.png" }, { kind: "stylesheet", url: "https://cdn.example.com/s.css" }],
};

async function failure(p: Promise<unknown>): Promise<Error> {
  try { await p; } catch (err) { return err as Error; }
  throw new Error("expected a failure");
}

async function opened(o: { vision?: boolean } = {}) {
  const h = harness(o);
  h.winter.pages[PAGE.url] = PAGE;
  const r = h.run();
  const tab = await h.engine.global(r.scope, "browsers.open", { url: PAGE.url }) as TabHandle;
  const p = (primitive: string, args: Record<string, unknown> = {}) => h.engine.primitive(r.scope, tab.targetId, primitive, args);
  return { h, r, tab, p };
}

describe("inspect()", () => {
  test("by ref: tag, role, name, attributes, box, visible/enabled — printed fenced, returned as data", async () => {
    const { r, p } = await opened();
    const info = await p("inspect", { target: 6 }) as { ref: number; role: string; enabled: boolean; box: number[] };
    expect(info).toMatchObject({ ref: 6, role: "button", enabled: false });
    expect(info.box).toEqual([55, 28, 10, 4]);
    const link = await p("inspect", { target: 3, emit: false }) as { attributes: Record<string, string> };
    expect(link.attributes).toEqual({ href: "https://shop.example.com/prices.csv", "data-testid": "prices" });
    expect(r.text()).toMatch(/\[6\] <button> button "Pay" \(disabled\)\nbox 55, 28, 10, 4 · visible · disabled/);
  });

  test("by point (vision): the element there gets a ref; without vision a point is NotAllowed", async () => {
    const { p } = await opened();
    const shot = await p("screenshot", { emit: false }) as { width: number; height: number };
    // The fake puts element 4 at (40, 20) CSS px of a 1200×800 viewport: the same place in the image's pixels.
    const found = await p("inspect", { target: [(40 * shot.width) / 1200, (20 * shot.height) / 800], emit: false }) as { ref: number; role: string };
    expect(found).toMatchObject({ ref: 4, role: "check box" });
    await expect(p("inspect", { target: [1, 1] })).rejects.toThrow(/nothing is at that point/);
    const blind = await opened({ vision: false });
    const e = await failure(blind.p("inspect", { target: [1, 1] }));
    expect((e as AutomationFailure).kind).toBe("NotAllowed");
    await expect(blind.p("inspect", { target: "x" })).rejects.toThrow(/inspect\(\) takes an element ref$/);
  });
});

describe("html(), text({ within }), assets()", () => {
  test("html: the page, one element, a cut said", async () => {
    const { p } = await opened();
    expect(await p("html", { emit: false })).toBe(PAGE.html);
    expect(await p("html", { within: 2, emit: false })).toBe('<div id="2">Deals</div>');
    expect(await p("html", { maxChars: 10, emit: false })).toMatch(/^<!doctype \n<!-- cut at 10 characters/);
    await expect(p("html", { within: "x" })).rejects.toThrow(/within takes an element ref/);
  });

  test("text({ within }) reads one element", async () => {
    const { p } = await opened();
    expect(await p("text", { within: 2, emit: false })).toBe("Deals");
  });

  test("assets: the page's and the network log's, by kind; an unknown kind is a TypeError", async () => {
    const { h, p, tab } = await opened();
    h.winter.pageEvent(tab.id.slice(7), "Network.requestWillBeSent", { requestId: "f1", timestamp: 1, type: "Font", request: { url: "https://cdn.example.com/f.woff2", method: "GET" } });
    const all = await p("assets", { emit: false }) as Array<{ kind: string; url: string }>;
    expect(all).toEqual([
      { kind: "image", url: "https://cdn.example.com/a.png" }, { kind: "stylesheet", url: "https://cdn.example.com/s.css" },
      { kind: "font", url: "https://cdn.example.com/f.woff2" },
    ]);
    expect(await p("assets", { kinds: ["stylesheet"], emit: false })).toEqual([{ kind: "stylesheet", url: "https://cdn.example.com/s.css" }]);
    await expect(p("assets", { kinds: ["video"] })).rejects.toThrow(/kinds are image, media, font, stylesheet, script/);
  });
});

describe("find()'s DOM keys", () => {
  test("label / placeholder / testId / css / exact reach the page runtime; a long selector is refused", async () => {
    const { h, p } = await opened();
    await p("find", { query: { testId: "prices", css: "a.price", exact: true }, emit: false });
    const call = h.winter.sent.filter((x) => x.method === "Runtime.callFunctionOn").map((x) => (x.params.arguments as Array<{ value: unknown }>)).find((a) => a[0]!.value === "find")!;
    expect(call[1]!.value).toEqual({ testId: "prices", css: "a.price", exact: true });
    await expect(p("find", { query: { css: "a".repeat(501) } })).rejects.toThrow(/at most 500 characters/);
  });
});

describe("screenshot({ within | fullPage })", () => {
  test("fullPage captures beyond the viewport, says it is for looking, and a Point in it is refused", async () => {
    const { h, r, p } = await opened();
    await p("screenshot", { fullPage: true });
    const shot = h.winter.sent.filter((x) => x.method === "Page.captureScreenshot").at(-1)!;
    expect(shot.params.captureBeyondViewport).toBe(true);
    expect((shot.params.clip as { height: number }).height).toBe(4000);
    expect(r.text()).toContain("the whole page,");
    const e = await failure(p("click", { target: [5, 5] }));
    expect(e.message).toMatch(/full-page screenshot is for looking/);
  });

  test("within clips to the element's box", async () => {
    const { h, p } = await opened();
    await p("screenshot", { within: 2, emit: false });
    const clip = h.winter.sent.filter((x) => x.method === "Page.captureScreenshot").at(-1)!.params.clip as { x: number; y: number; width: number; height: number };
    expect(clip).toMatchObject({ x: 15, y: 308, width: 10, height: 4 });
    await expect(p("screenshot", { within: 2, fullPage: true })).rejects.toThrow(/within or fullPage, not both/);
  });
});

describe("setValue(ref, true | false), waitFor({ load }), dialogs as values", () => {
  test("a check box is pressed only when its state differs; a boolean on anything else is a TypeError", async () => {
    const { h, p } = await opened();
    const clicks = (): number => h.winter.sent.filter((x) => x.method === "Input.dispatchMouseEvent" && x.params.type === "mousePressed").length;
    const before = clicks();
    await p("setValue", { ref: 4, value: true });
    expect(clicks()).toBe(before + 1);
    await p("setValue", { ref: 5, value: true }); // already checked
    expect(clicks()).toBe(before + 1);
    await expect(p("setValue", { ref: 2, value: true })).rejects.toThrow(/is for a check box, radio or switch/);
  });

  test("waitFor({ load }) answers at once for a loaded page; a bad state is a TypeError", async () => {
    const { p } = await opened();
    expect(await p("waitFor", { cond: { load: "load" } })).toMatchObject({ waitedMs: expect.any(Number) });
    await expect(p("waitFor", { cond: { load: "idle" } })).rejects.toThrow(/"domcontentloaded" or "load"/);
    await expect(p("waitFor", { cond: { load: "load", text: "x" } })).rejects.toThrow(/waits for the page's load alone/);
  });

  test("dialog() returns the open dialog (or null); answerDialog(false) cancels it, a prompt takes its text", async () => {
    const { h, p } = await opened();
    expect(await p("dialog")).toBeNull();
    h.winter.openDialog("w1", "confirm", "Delete it?");
    expect(await p("dialog")).toEqual({ type: "confirm", message: "Delete it?" });
    await p("answerDialog", { accept: false });
    expect(h.winter.sent.filter((x) => x.method === "Page.handleJavaScriptDialog").at(-1)!.params).toMatchObject({ accept: false });
    h.winter.openDialog("w1", "prompt", "Name?");
    await p("answerDialog", { accept: true, text: "Ada" });
    expect(h.winter.sent.filter((x) => x.method === "Page.handleJavaScriptDialog").at(-1)!.params).toEqual({ accept: true, promptText: "Ada" });
    await expect(p("answerDialog", { accept: true })).rejects.toThrow(/no page dialog is open/);
  });
});
