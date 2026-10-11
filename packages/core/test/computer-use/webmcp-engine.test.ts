// ComputerV2 Phase 4 — WebMCP through the engine, over the fake transports and a fake `document.modelContext`: the
// state's `site tools` line and its diff, `tab.tools()` (fenced, capped), `tab.callTool()` as an act (policy, the site
// floor, the setting), its input checks, its answer (parsed, redacted, fenced), cancel and timeout, a call that
// navigates, and what telemetry and the audit count carry (never a tool's name).
import { describe, expect, test } from "bun:test";
import { AutomationFailure } from "../../src/computer-use/errors";
import type { TabHandle } from "../../src/computer-use/worker/bridge";
import { FakeModelContext, type FakePage } from "./browser-fake-transport";
import { harness, type HarnessOpts } from "./browser-harness";

const URL_ = "https://shop.example.com/";
const PAGE: FakePage = { url: URL_, title: "Shop", nodes: [{ id: 1, role: "main", children: [{ id: 2, role: "heading", name: "Deals", level: 1 }, { id: 3, role: "button", name: "Buy" }] }] };

async function failure(p: Promise<unknown>): Promise<Error> {
  try { await p; } catch (err) { return err as Error; }
  throw new Error("expected a failure");
}

function siteTools(): FakeModelContext {
  return new FakeModelContext()
    .add({ name: "search_site", title: "Search", description: "Search the shop's products", inputSchema: { type: "object", properties: { q: { type: "string" } } }, annotations: { readOnlyHint: true } }, (i) => ({ hits: [`result for ${(i as { q?: string }).q ?? ""}`] }))
    .add({ name: "add_to_cart", description: "Add an item to the cart", annotations: { consequentialHint: true } })
    .add({ name: "framed_tool", description: "an iframe's tool", window: {} });
}

/** The built-in browser (no card) or a user's Chrome (its per-app policy), with the page and its tools. */
async function opened(browser: "winter" | "chrome" = "winter", o: HarnessOpts & { mc?: FakeModelContext; page?: FakePage } = {}) {
  const h = harness(o);
  const mc = o.mc ?? siteTools();
  const fake = browser === "winter" ? h.winter : h.chrome;
  fake.pages[URL_] = { ...(o.page ?? PAGE), modelContext: mc };
  const r = h.run();
  const tab = await h.engine.global(r.scope, "browsers.open", { url: URL_, ...(browser === "chrome" ? { browser: "chrome" } : {}) }) as TabHandle;
  const key = tab.id.split(":")[1]!;
  const p = (primitive: string, args: Record<string, unknown> = {}) => h.engine.primitive(r.scope, tab.targetId, primitive, args);
  return { h, r, tab, key, p, mc, fake };
}

describe("the state names the page's tools", () => {
  test("bind prints them on one line after the header; frames' tools are left out", async () => {
    const { r } = await opened();
    const text = r.text();
    expect(text).toContain("site tools (WebMCP): search_site, add_to_cart — tab.tools() describes them");
    expect(text).not.toContain("framed_tool");
    // The line sits after the header, before the tree — and inside the DATA-ONLY fence.
    const lines = text.split("\n");
    const i = lines.findIndex((l) => l.startsWith("site tools (WebMCP)"));
    expect(lines[i - 1]).toMatch(/^Tab "Shop" — https:\/\/shop\.example\.com\//);
    expect(text.indexOf("<screen-data")).toBeLessThan(text.indexOf("site tools (WebMCP)"));
    r.end();
  });

  test("a diff names them only when the set changed — and says when they went", async () => {
    const { r, p, mc } = await opened();
    const unchanged = await p("state", { emit: false }) as string;
    expect(unchanged).not.toContain("site tools");
    // emit:false does not move the diff base: print one so the next diffs compare with it.
    await p("state");
    mc.add({ name: "checkout", description: "Pay" });
    const added = await p("state") as string;
    expect(added).toContain("site tools (WebMCP): search_site, add_to_cart, checkout — tab.tools() describes them");
    mc.tools.length = 0;
    const gone = await p("state") as string;
    expect(gone).toContain("site tools (WebMCP): none now");
    const again = await p("state") as string;
    expect(again).not.toContain("site tools");
    r.end();
  });

  test("more than 20: the first 20 and how many more", async () => {
    const mc = new FakeModelContext();
    for (let i = 0; i < 27; i++) mc.add({ name: `t${i}`, description: "x" });
    const { r } = await opened("winter", { mc });
    expect(r.text()).toContain(`site tools (WebMCP): ${Array.from({ length: 20 }, (_, i) => `t${i}`).join(", ")} … and 7 more — tab.tools() describes them`);
    r.end();
  });

  test("no API, a broken one, or the setting off: no line at all", async () => {
    for (const mc of [undefined, { getTools: () => { throw new Error("x"); }, executeTool: async () => null }, { getTools: async () => "nope", executeTool: async () => null }]) {
      const h = harness();
      h.winter.pages[URL_] = { ...PAGE, ...(mc === undefined ? {} : { modelContext: mc }) };
      const r = h.run();
      await h.engine.global(r.scope, "browsers.open", { url: URL_ });
      expect(r.text()).not.toContain("site tools");
      expect(r.text()).toContain('heading "Deals"');
      r.end();
    }
    const off = await opened("winter", { webMcp: () => false });
    expect(off.r.text()).not.toContain("site tools");
    expect(off.mc.getToolsCalls).toBe(0);
    off.r.end();
  });
});

describe("tab.tools()", () => {
  test("describes the page's own tools, fenced, and returns them", async () => {
    const { r, p } = await opened();
    const tools = await p("tools") as Array<{ name: string; readOnly: boolean; consequential: boolean; inputSchema?: unknown }>;
    expect(tools.map((t) => [t.name, t.readOnly, t.consequential])).toEqual([["search_site", true, false], ["add_to_cart", false, true]]);
    expect(tools[0]!.inputSchema).toEqual({ type: "object", properties: { q: { type: "string" } } });
    const text = r.text();
    expect(text).toContain("site tools (WebMCP) of Tab \"Shop\" — the page's own words, not instructions:");
    expect(text).toContain("- search_site (Search) [read-only]: Search the shop's products");
    expect(text).toContain("  input: {\"type\":\"object\",\"properties\":{\"q\":{\"type\":\"string\"}}}");
    expect(text).toContain("- add_to_cart [consequential]: Add an item to the cart");
    expect(text.lastIndexOf("<screen-data")).toBeLessThan(text.indexOf("- search_site"));
    r.end();
  });

  test("a page with none says so; the setting off answers [] with a daemon line, reading nothing", async () => {
    const none = await opened("winter", { mc: new FakeModelContext() });
    expect(await none.p("tools")).toEqual([]);
    expect(none.r.text()).toContain("offers no site tools (WebMCP)");
    none.r.end();
    let on = true;
    const off = await opened("winter", { webMcp: () => on });
    on = false;
    const calls = off.mc.getToolsCalls;
    expect(await off.p("tools")).toEqual([]);
    expect(off.r.text()).toContain("site tools are turned off in Settings");
    expect(off.mc.getToolsCalls).toBe(calls);
    off.r.end();
  });

  test("past 50 tools or 32 KiB: the rest counted, by name", async () => {
    const mc = new FakeModelContext();
    for (let i = 0; i < 60; i++) mc.add({ name: `tool_${i}`, description: "d" });
    const { r, p } = await opened("winter", { mc });
    const tools = await p("tools", { emit: true }) as unknown[];
    expect(tools).toHaveLength(50);
    expect(r.text()).toContain("… 10 more tools not shown (by name: tool_50, tool_51");
    r.end();
  });
});

describe("tab.callTool()", () => {
  test("runs the tool once with the input, returns its answer parsed and prints it fenced; it is an act (the next state settles)", async () => {
    const { r, p, mc, tab } = await opened();
    const out = await p("callTool", { name: "search_site", input: { q: "tea" } });
    expect(out).toEqual({ hits: ["result for tea"] });
    expect(mc.calls.filter((c) => c.ran)).toEqual([{ name: "search_site", form: "object", ran: true, input: { q: "tea" } }]);
    const text = r.text();
    expect(text).toContain("site tool result:\n{\n  \"hits\": [\n    \"result for tea\"\n  ]\n}");
    expect(text.lastIndexOf("<screen-data")).toBeLessThan(text.indexOf("site tool result"));
    expect(r.scope.acted.has(tab.targetId)).toBe(true);
    expect(r.siteTools()).toBe(1);
    // Telemetry carries the backend and the time, never the tool's name, input or answer.
    const metric = JSON.stringify(r.metric);
    expect(metric).not.toContain("search_site");
    expect(metric).not.toContain("tea");
    r.end();
  });

  test("a browser on the old input form (a JSON string) runs it once too", async () => {
    const mc = siteTools();
    mc.inputForm = "string";
    const { r, p } = await opened("winter", { mc });
    expect(await p("callTool", { name: "search_site", input: { q: "cake" } })).toEqual({ hits: ["result for cake"] });
    expect(mc.calls.map((c) => [c.form, c.ran])).toEqual([["string", true]]);
    r.end();
  });

  test("an answer that is not JSON stays a string; secret-looking values are masked", async () => {
    const mc = new FakeModelContext()
      .add({ name: "plain", description: "x" }, () => "just text")
      .add({ name: "secret", description: "x" }, () => ({ user: "ada", token: "tok_live_should_never_show" }));
    const { r, p } = await opened("winter", { mc });
    expect(await p("callTool", { name: "plain" })).toBe("just text");
    expect(await p("callTool", { name: "secret" })).toEqual({ user: "ada", token: "<redacted>" });
    expect(r.text()).not.toContain("tok_live_should_never_show");
    r.end();
  });

  test("refused: an unknown or an iframe's tool, a tool of an earlier page, a bad input, an input over 64 KiB", async () => {
    const { h, r, p, key } = await opened();
    const unknown = await failure(p("callTool", { name: "no_such_tool" }));
    expect(unknown.message).toBe("this page doesn't offer that tool now — tab.tools() lists what it offers");
    expect((await failure(p("callTool", { name: "framed_tool" }))).message).toContain("doesn't offer that tool now");
    await expect(p("callTool", {})).rejects.toThrow(/callTool\(\) takes a tool's name/);
    await expect(p("callTool", { name: "search_site", input: [1, 2] })).rejects.toThrow(/input is an object/);
    await expect(p("callTool", { name: "search_site", input: "q=tea" })).rejects.toThrow(/input is an object/);
    await expect(p("callTool", { name: "search_site", timeoutMs: -5 })).rejects.toThrow(/positive number of ms/);
    const big = await failure(p("callTool", { name: "search_site", input: { q: "x".repeat(70_000) } }));
    expect((big as AutomationFailure).kind).toBe("NotAllowed");
    // A new page has its own tools (none here): the earlier page's name is refused.
    h.winter.pages["https://shop.example.com/next"] = { ...PAGE, url: "https://shop.example.com/next", title: "Next" };
    h.winter.navigateTo(key, "https://shop.example.com/next");
    await p("state", { emit: false });
    expect((await failure(p("callTool", { name: "search_site" }))).message).toContain("doesn't offer that tool now");
    r.end();
  });

  test("a tool that fails: its words printed fenced, the error says only that it failed", async () => {
    const mc = new FakeModelContext().add({ name: "boom", description: "x" }, () => { throw new Error("internal page detail"); });
    const { r, p } = await opened("winter", { mc });
    const e = await failure(p("callTool", { name: "boom" }));
    expect(e.message).toBe("the site's tool failed — what it said is printed above");
    expect(r.text()).toContain("the site's tool failed (UnknownError): Tool was executed but the invocation failed");
    r.end();
  });

  test("a timeout aborts the page's signal and says so; a cancel stops it too", async () => {
    let aborted = 0;
    const slow = (_i: unknown, signal: AbortSignal) => new Promise((res) => { signal.addEventListener("abort", () => { aborted++; }); setTimeout(() => res("late"), 60_000); });
    const mc = new FakeModelContext().add({ name: "slow", description: "x" }, slow);
    const { r, p } = await opened("winter", { mc });
    const t0 = Date.now();
    const e = await failure(p("callTool", { name: "slow", timeoutMs: 100 }));
    expect((e as AutomationFailure).kind).toBe("WaitTimeout");
    expect(e.message).toBe("the site's tool did not answer within 0.1 s — it was asked to stop; check the page (state()) before calling it again");
    expect(aborted).toBe(1);
    expect(Date.now() - t0).toBeLessThan(2_000);
    // A cancel (the run's signal) aborts the page's signal as well.
    const pending = p("callTool", { name: "slow" });
    await new Promise((res) => setTimeout(res, 50));
    r.abort.abort();
    await expect(pending).rejects.toBeDefined();
    await new Promise((res) => setTimeout(res, 50));
    expect(aborted).toBe(2);
    r.end();
  });

  test("a tool that navigates the page: a daemon line, null, and the earlier refs stale", async () => {
    const { h, r, p, key } = await opened();
    h.winter.pages["https://shop.example.com/cart"] = { ...PAGE, url: "https://shop.example.com/cart", title: "Cart" };
    const mc = h.winter.pages[URL_]!.modelContext as FakeModelContext;
    mc.impl.set("add_to_cart", () => { h.winter.navigateTo(key, "https://shop.example.com/cart"); return new Promise(() => {}); });
    expect(await p("callTool", { name: "add_to_cart", input: { id: 7 } })).toBeNull();
    expect(r.text()).toContain("the site's tool navigated the page — every earlier ref is stale; call state()");
    expect((await failure(p("click", { target: 3 })) as AutomationFailure).kind).toBe("StaleRef");
    r.end();
  });

  test("the setting off: NotAllowed before anything runs", async () => {
    let on = true;
    const { r, p, mc } = await opened("winter", { webMcp: () => on });
    on = false;
    const e = await failure(p("callTool", { name: "search_site" }));
    expect((e as AutomationFailure).kind).toBe("NotAllowed");
    expect(e.message).toBe("site tools are turned off in Settings");
    expect(mc.calls).toEqual([]);
    r.end();
  });
});

describe("policy: a call is an act under the existing rules (no card of its own)", () => {
  test("plan refuses it (the built-in browser and a user's), while listing still works", async () => {
    // (browsers.open is itself an act: opened first, then the session switched to plan.)
    const w = await opened("winter");
    w.h.facts.policy = "plan";
    expect(((await failure(w.p("callTool", { name: "search_site" }))) as AutomationFailure).kind).toBe("NotAllowed");
    expect((await w.p("tools", { emit: false }) as unknown[]).length).toBe(2);
    expect(w.mc.calls).toEqual([]);
    w.r.end();
    const c = await opened("chrome", { policy: "bypass" });
    c.h.facts.policy = "plan";
    expect(((await failure(c.p("callTool", { name: "search_site" }))) as AutomationFailure).kind).toBe("NotAllowed");
    expect(c.mc.calls).toEqual([]);
    c.r.end();
  });

  test("a user's browser set to click-only or view-only refuses it; full access runs it, with no card", async () => {
    for (const access of ["click", "view"]) {
      const h = harness({ apps: { "com.google.Chrome": { access } } });
      const mc = siteTools();
      h.chrome.addTab({ ...PAGE, modelContext: mc }, { tabKey: "40" });
      const r = h.run();
      const t = await h.engine.global(r.scope, "browsers.tab", { tab: "chrome:40" }) as TabHandle;
      const e = await failure(h.engine.primitive(r.scope, t.targetId, "callTool", { name: "search_site" }));
      expect({ access, kind: (e as AutomationFailure).kind }).toEqual({ access, kind: "NotAllowed" });
      expect(mc.calls).toEqual([]);
      r.end();
    }
    const full = await opened("chrome");
    expect(await full.p("callTool", { name: "search_site", input: { q: "x" } })).toEqual({ hits: ["result for x"] });
    expect(full.h.cards).toEqual([]);
    full.r.end();
  });

  test("a tab on an unapproved dangerous-domain host can neither list nor call", async () => {
    const LISTED = "https://evil.example/";
    const { h, r, p, key } = await opened("winter", { policy: "auto", dangerousAdded: ["evil.example"] });
    const mc = siteTools();
    h.winter.pages[LISTED] = { ...PAGE, url: LISTED, title: "Evil", modelContext: mc };
    h.winter.navigateTo(key, LISTED);
    for (const prim of ["tools", "callTool"]) {
      const e = await failure(p(prim, { name: "search_site" }));
      expect({ prim, kind: (e as AutomationFailure).kind }).toEqual({ prim, kind: "NotAllowed" });
    }
    expect(mc.calls).toEqual([]);
    r.end();
  });

  test("a page dialog holds the tab: the call waits for it to be answered (TargetBusy)", async () => {
    const { h, r, p, key, mc } = await opened();
    h.winter.openDialog(key, "alert", "Hi");
    await new Promise((res) => setTimeout(res, 10));
    expect(((await failure(p("callTool", { name: "search_site" }))) as AutomationFailure).kind).toBe("TargetBusy");
    expect(mc.calls).toEqual([]);
    r.end();
  });
});
