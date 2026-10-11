// ComputerV2 Phase 4 — WebMCP's page-side code (`page-runtime/webmcp.ts`) as pure functions over a fake ModelContext:
// feature detection that fails closed, discovery kept to the frame's own window and origin, the shape checks, the
// caps and cuts, the input form (the JSON string first, the object only after a TypeError), and abort.
import { describe, expect, test } from "bun:test";
import {
  executeSiteTool, listSiteTools, modelContextOf, SITE_TOOL_CAPS, SiteToolCalls, siteToolInfo, type ModelContextLike,
} from "../../src/computer-use/browser/page-runtime/webmcp";
import { FAKE_TOP_WINDOW, FakeModelContext } from "./browser-fake-transport";

const OWN = { window: FAKE_TOP_WINDOW, origin: "https://shop.example.com" };

describe("feature detection fails closed", () => {
  test("no API, a non-object, a missing member, a throwing getter: no ModelContext", () => {
    expect(modelContextOf({})).toBeUndefined();
    expect(modelContextOf(null)).toBeUndefined();
    expect(modelContextOf({ modelContext: 42 })).toBeUndefined();
    expect(modelContextOf({ modelContext: { getTools: () => [] } })).toBeUndefined();
    expect(modelContextOf({ modelContext: { getTools: () => [], executeTool: "no" } })).toBeUndefined();
    expect(modelContextOf({ get modelContext() { throw new Error("boom"); } })).toBeUndefined();
    expect(modelContextOf({ modelContext: new FakeModelContext() })).toBeDefined();
  });

  test("a listing that throws, rejects, answers no array or never answers: no site tools", async () => {
    const mk = (getTools: () => unknown): ModelContextLike => ({ getTools: getTools as () => Promise<unknown>, executeTool: async () => null });
    expect(await listSiteTools(undefined, OWN)).toBeNull();
    expect(await listSiteTools(mk(() => { throw new Error("x"); }), OWN)).toBeNull();
    expect(await listSiteTools(mk(() => Promise.reject(new Error("x"))), OWN)).toBeNull();
    expect(await listSiteTools(mk(async () => ({ tools: [] })), OWN)).toBeNull();
    expect(await listSiteTools(mk(() => new Promise(() => {})), OWN, { listMs: 30 })).toBeNull();
  });

  test("a tool not shaped as the draft says is left out: a bad name, no description, not an object", () => {
    expect(siteToolInfo(null)).toBeUndefined();
    expect(siteToolInfo("search")).toBeUndefined();
    expect(siteToolInfo({ name: "search" })).toBeUndefined();
    expect(siteToolInfo({ name: "has space", description: "x" })).toBeUndefined();
    expect(siteToolInfo({ name: "x".repeat(129), description: "x" })).toBeUndefined();
    expect(siteToolInfo({ name: "ünicode", description: "x" })).toBeUndefined();
    expect(siteToolInfo({ name: 7, description: "x" })).toBeUndefined();
    expect(siteToolInfo({ get name() { throw new Error("trap"); }, description: "x" })).toBeUndefined();
    expect(siteToolInfo({ name: "search_site.v2-a", description: "Search" })).toEqual({ name: "search_site.v2-a", description: "Search", readOnly: false, consequential: false });
  });
});

describe("discovery", () => {
  test("only the frame's OWN tools: another frame's window, another origin and a duplicate name are left out", async () => {
    const mc = new FakeModelContext()
      .add({ name: "search_site", description: "Search the shop", annotations: { readOnlyHint: true } })
      .add({ name: "framed", description: "in an iframe", window: {} })
      .add({ name: "elsewhere", description: "another origin" }, undefined, "https://ads.example.net")
      .add({ name: "search_site", description: "a second registration" })
      .add({ name: "checkout", description: "Buy", annotations: { consequentialHint: true } });
    const r = await listSiteTools(mc, OWN, { describe: true });
    expect(r?.names).toEqual(["search_site", "checkout"]);
    expect(r?.total).toBe(2);
    expect(r?.tools?.map((t) => [t.name, t.readOnly, t.consequential])).toEqual([["search_site", true, false], ["checkout", false, true]]);
    expect(r?.more).toBe(0);
    // Names only (a state's line): nothing described.
    expect(await listSiteTools(mc, OWN)).toEqual({ names: ["search_site", "checkout"], total: 2 });
  });

  test("the page's words are cut, redacted and made one line; the schema (object or JSON string) kept within its cap", async () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop";
    const big = { type: "object", properties: Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`field_${i}`, { type: "string", description: "a field" }])) };
    const mc = new FakeModelContext()
      .add({ name: "a", title: "Find\nthings", description: `line one\nline two\u202Eflipped ${jwt} ${"x".repeat(600)}`, inputSchema: { type: "object", properties: { q: { type: "string" } } } })
      .add({ name: "b", description: "string schema (Chrome 153)", inputSchema: "{\"type\":\"object\",\"properties\":{\"n\":{\"type\":\"number\"}}}" })
      .add({ name: "c", description: "huge schema", inputSchema: big })
      .add({ name: "d", description: "broken schema", inputSchema: "{not json" });
    const r = (await listSiteTools(mc, OWN, { describe: true }))!;
    const [a, b, c, d] = r.tools!;
    expect(a!.title).toBe("Find things");
    expect(a!.description.startsWith("line one line two flipped <redacted> xxx")).toBe(true);
    expect(a!.description.length).toBe(SITE_TOOL_CAPS.descriptionChars + 1);
    expect(a!.description.endsWith("…")).toBe(true);
    expect(a!.inputSchema).toEqual({ type: "object", properties: { q: { type: "string" } } });
    expect(b!.inputSchema).toEqual({ type: "object", properties: { n: { type: "number" } } });
    expect(c!.inputSchema).toBeUndefined();
    expect(c!.schemaText!.length).toBe(SITE_TOOL_CAPS.schemaChars + 1);
    expect(d!.inputSchema).toBeUndefined();
    expect(d!.schemaText).toBe("{not json");
  });

  test("at most 50 described and 32 KiB of them; every name (≤ 200) still listed, the rest counted", async () => {
    const mc = new FakeModelContext();
    for (let i = 0; i < 250; i++) mc.add({ name: `tool_${i}`, description: "d".repeat(400) });
    const r = (await listSiteTools(mc, OWN, { describe: true }))!;
    expect(r.total).toBe(250);
    expect(r.names).toHaveLength(SITE_TOOL_CAPS.names);
    expect(r.tools!.length).toBeLessThanOrEqual(SITE_TOOL_CAPS.described);
    expect(JSON.stringify(r.tools).length).toBeLessThanOrEqual(SITE_TOOL_CAPS.describedBytes + 2 * r.tools!.length);
    expect(r.more).toBe(250 - r.tools!.length);
  });
});

describe("the call", () => {
  test("the input form: the JSON string first — a browser that takes it runs the tool once", async () => {
    const mc = new FakeModelContext();
    mc.inputForm = "string";
    mc.add({ name: "echo", description: "echo" });
    const out = await executeSiteTool(mc, mc.tools[0]!, { text: "hi" }, new AbortController().signal);
    expect(JSON.parse(out as string)).toEqual({ ok: true, input: { text: "hi" } });
    expect(mc.calls).toEqual([{ name: "echo", form: "string", ran: true, input: { text: "hi" } }]);
  });

  test("…and only a TypeError (the browser's conversion, before the tool runs) retries with the object", async () => {
    const mc = new FakeModelContext();
    mc.inputForm = "object";
    mc.add({ name: "echo", description: "echo" });
    await executeSiteTool(mc, mc.tools[0]!, { text: "hi" }, new AbortController().signal);
    expect(mc.calls.map((c) => [c.form, c.ran])).toEqual([["string", false], ["object", true]]);
  });

  test("any other failure is never retried: the tool runs at most once", async () => {
    for (const thrown of [Object.assign(new Error("Tool was executed but the invocation failed"), { name: "UnknownError" }), new RangeError("x"), "a string"]) {
      let runs = 0;
      const mc: ModelContextLike = { getTools: async () => [], executeTool: async () => { runs++; throw thrown; } };
      await expect(executeSiteTool(mc, {}, {}, new AbortController().signal)).rejects.toBeDefined();
      expect(runs).toBe(1);
    }
    // A TypeError after an abort is not retried either.
    let runs = 0;
    const ac = new AbortController();
    ac.abort();
    const mc: ModelContextLike = { getTools: async () => [], executeTool: async () => { runs++; throw new TypeError("x"); } };
    await expect(executeSiteTool(mc, {}, {}, ac.signal)).rejects.toBeInstanceOf(TypeError);
    expect(runs).toBe(1);
  });

  test("a call: an unknown name, the answer cut at 256 KiB, a failure's words cut, null kept", async () => {
    const mc = new FakeModelContext()
      .add({ name: "big", description: "x" }, () => "y".repeat(SITE_TOOL_CAPS.resultChars + 10))
      .add({ name: "bad", description: "x" }, () => { throw new Error("nope"); })
      .add({ name: "nav", description: "x" }, () => null)
      .add({ name: "framed", description: "in a frame", window: {} });
    const calls = new SiteToolCalls();
    expect(await calls.call(mc, OWN, { name: "missing", input: {}, callId: "c1" })).toEqual({ ok: false, reason: "unknown" });
    expect(await calls.call(mc, OWN, { name: "framed", input: {}, callId: "c1" })).toEqual({ ok: false, reason: "unknown" });
    expect(await calls.call(undefined, OWN, { name: "big", input: {}, callId: "c1" })).toEqual({ ok: false, reason: "unknown" });
    const big = await calls.call(mc, OWN, { name: "big", input: {}, callId: "c2" });
    expect(big.ok && big.cut === true && big.result!.length === SITE_TOOL_CAPS.resultChars).toBe(true);
    expect(await calls.call(mc, OWN, { name: "bad", input: {}, callId: "c3" })).toEqual({ ok: false, reason: "failed", name: "UnknownError", message: "Tool was executed but the invocation failed. For example, the script function threw an error" });
    expect(await calls.call(mc, OWN, { name: "nav", input: {}, callId: "c4" })).toEqual({ ok: true, result: null });
  });

  test("cancel aborts the page's signal: the call answers aborted; an unknown id cancels nothing", async () => {
    let sawAbort = false;
    const mc = new FakeModelContext().add({ name: "slow", description: "x" }, (_i, signal) => new Promise((res) => {
      signal.addEventListener("abort", () => { sawAbort = true; });
      setTimeout(() => res("late"), 5_000);
    }));
    const calls = new SiteToolCalls();
    const p = calls.call(mc, OWN, { name: "slow", input: {}, callId: "slow-1" });
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.cancel("nope")).toBe(false);
    expect(calls.cancel("slow-1")).toBe(true);
    expect(await p).toEqual({ ok: false, reason: "aborted" });
    expect(sawAbort).toBe(true);
    expect(calls.cancel("slow-1")).toBe(false);
  });
});
