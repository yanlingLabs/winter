// ExtensionTransport over a fake host: every CdpTransport call as its §6.4 request, the answers and typed errors, the
// allowlist refused before anything is sent, events (subscribed only, Network params stripped), tab loss, Stop, timeouts
// and disconnects.
import { describe, expect, test } from "bun:test";
import { ExtensionTransport } from "../../../src/computer-use/browser/extension/extension-transport";
import { TransportError } from "../../../src/computer-use/browser/transport";

interface Sent { jsonrpc: string; id: string; method: string; params: Record<string, unknown> }

function harness(timeouts: Record<string, number> = {}) {
  const sent: Sent[] = [];
  let writable = true;
  const t = new ExtensionTransport({ family: "chrome", write: (m) => { if (writable) sent.push(m as unknown as Sent); return writable; }, timeouts });
  t.bind("chrome");
  const answer = (result: unknown, i = sent.length - 1) => t.handle({ jsonrpc: "2.0", id: sent[i]!.id, result });
  const fail = (code: string, message: string, data: Record<string, unknown> = {}, i = sent.length - 1) =>
    t.handle({ jsonrpc: "2.0", id: sent[i]!.id, error: { code: -32000, message, data: { code, ...data } } });
  const notify = (method: string, params: Record<string, unknown>) => t.handle({ jsonrpc: "2.0", method, params });
  return { t, sent, answer, fail, notify, unplug: () => { writable = false; } };
}

const tab = { tabKey: "418", url: "https://example.com/", title: "Example", active: false, agent: true, sessionId: "s_1" };

describe("requests", () => {
  test("createTab → tabs.create { url, sessionId, sessionTitle } and the tab it answers", async () => {
    const h = harness();
    const p = h.t.createTab({ sessionId: "s_1", sessionTitle: "Fix the build", url: "https://example.com/" });
    expect(h.sent[0]).toMatchObject({ jsonrpc: "2.0", method: "tabs.create", params: { url: "https://example.com/", sessionId: "s_1", sessionTitle: "Fix the build" } });
    expect(h.sent[0]!.id).toMatch(/^d\d+$/);
    h.answer({ tab });
    expect(await p).toEqual(tab);
  });

  test("listTabs, closeTab, keepTab, detach, attach", async () => {
    const h = harness();
    const listed = h.t.listTabs({ sessionId: "s_1" });
    expect(h.sent.at(-1)).toMatchObject({ method: "tabs.list", params: {} });
    h.answer({ tabs: [tab, { ...tab, tabKey: "419", agent: false, sessionId: undefined }] });
    expect(await listed).toEqual([tab, { tabKey: "419", url: "https://example.com/", title: "Example", active: false, agent: false }]);

    const closed = h.t.closeTab("418");
    expect(h.sent.at(-1)).toMatchObject({ method: "tabs.close", params: { tabKey: "418" } });
    h.answer({});
    await closed;

    const kept = h.t.keepTab("418");
    expect(h.sent.at(-1)).toMatchObject({ method: "tabs.keep", params: { tabKey: "418" } });
    h.answer({});
    await kept;

    const attached = h.t.attach("418", { sessionId: "s_1" });
    expect(h.sent.at(-1)).toMatchObject({ method: "debugger.attach", params: { tabKey: "418" } });
    h.answer({ viewport: [1280, 720], dpr: 2 });
    expect(await attached).toEqual({ viewport: [1280, 720], dpr: 2 });

    const detached = h.t.detach("418");
    expect(h.sent.at(-1)).toMatchObject({ method: "debugger.detach", params: { tabKey: "418" } });
    h.answer({});
    await detached;
  });

  test("send → cdp.send and returns the browser's result; cdpSessionId rides along", async () => {
    const h = harness();
    const p = h.t.send<{ frameTree: unknown }>("418", "Page.getFrameTree", {}, { cdpSessionId: "S1" });
    expect(h.sent[0]).toMatchObject({ method: "cdp.send", params: { tabKey: "418", method: "Page.getFrameTree", params: {}, cdpSessionId: "S1" } });
    h.answer({ result: { frameTree: { frame: { id: "F" } } } });
    expect(await p).toEqual({ frameTree: { frame: { id: "F" } } });
  });

  test("a method outside the allowlist is refused before anything is sent", async () => {
    const h = harness();
    for (const method of ["Network.getCookies", "Storage.getCookies", "Runtime.getProperties", "Page.addScriptToEvaluateOnNewDocument", "Target.sendMessageToTarget", "Fetch.enable"]) {
      await expect(h.t.send("418", method)).rejects.toMatchObject({ code: "not_allowed" });
    }
    expect(h.sent).toEqual([]);
  });

  test("subscribe refuses an event outside the allowlist, sends the rest", async () => {
    const h = harness();
    await expect(h.t.subscribe("418", ["Page.frameNavigated", "Network.responseReceived"])).rejects.toMatchObject({ code: "not_allowed" });
    expect(h.sent).toEqual([]);
    const p = h.t.subscribe("418", ["Page.frameNavigated"]);
    expect(h.sent[0]).toMatchObject({ method: "cdp.subscribe", params: { tabKey: "418", events: ["Page.frameNavigated"] } });
    h.answer({});
    await p;
  });

  test("a command over 1 MiB is refused (Chrome takes at most 1 MiB from a host)", async () => {
    const h = harness();
    await expect(h.t.send("418", "Runtime.evaluate", { expression: "x".repeat(1024 * 1024), contextId: 1 })).rejects.toMatchObject({ code: "not_allowed" });
    expect(h.sent).toEqual([]);
  });
});

describe("errors", () => {
  test("the extension's typed error becomes a TransportError with its code and data", async () => {
    const h = harness();
    const p = h.t.send("418", "Runtime.evaluate", { expression: "1" });
    h.fail("not_allowed", "Runtime.evaluate needs a winter-world contextId");
    const err = await p.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransportError);
    expect(err).toMatchObject({ code: "not_allowed", message: "Runtime.evaluate needs a winter-world contextId" });

    const q = h.t.send("418", "DOM.getDocument");
    h.fail("cdp_error", "No node with given id", { cdpCode: -32000, cdpMessage: "No node with given id" });
    expect(await q.catch((e: unknown) => e)).toMatchObject({ code: "cdp_error", data: { cdpCode: -32000, cdpMessage: "No node with given id" } });

    for (const code of ["tab_gone", "attach_refused", "timeout", "protocol_mismatch", "disconnected"]) {
      const r = h.t.attach("418", { sessionId: "s" });
      h.fail(code, code);
      expect(await r.catch((e: unknown) => e)).toMatchObject({ code });
    }
  });

  test("an unknown error code reads as cdp_error", async () => {
    const h = harness();
    const p = h.t.listTabs();
    h.fail("weird", "something");
    expect(await p.catch((e: unknown) => e)).toMatchObject({ code: "cdp_error" });
  });

  test("a malformed answer is a cdp_error", async () => {
    const h = harness();
    const p = h.t.createTab({ sessionId: "s", url: "https://x/" });
    h.answer({ tab: { tabKey: 418 } });
    expect(await p.catch((e: unknown) => e)).toMatchObject({ code: "cdp_error" });
  });

  test("no answer in time → timeout; a late answer is dropped", async () => {
    const h = harness({ command: 30 });
    const p = h.t.listTabs();
    expect(await p.catch((e: unknown) => e)).toMatchObject({ code: "timeout" });
    expect(h.answer({ tabs: [] })).toBe(true);
  });

  test("a screenshot gets the longer ceiling", async () => {
    const h = harness({ cdp: 20, screenshot: 200 });
    const shot = h.t.send("418", "Page.captureScreenshot", { format: "jpeg" });
    const other = h.t.send("418", "Page.getLayoutMetrics");
    expect(await other.catch((e: unknown) => e)).toMatchObject({ code: "timeout" });
    h.answer({ result: { data: "abc" } }, 0);
    expect(await shot).toEqual({ data: "abc" });
  });

  test("disconnect rejects everything in flight and every later call", async () => {
    const h = harness();
    const p = h.t.listTabs();
    h.t.disconnect();
    expect(h.t.connected).toBe(false);
    expect(await p.catch((e: unknown) => e)).toMatchObject({ code: "disconnected" });
    await expect(h.t.send("418", "Page.enable")).rejects.toMatchObject({ code: "disconnected" });
  });

  test("a write the connection cannot carry → disconnected", async () => {
    const h = harness();
    h.unplug();
    await expect(h.t.listTabs()).rejects.toMatchObject({ code: "disconnected" });
  });

  test("overlay is best effort: never throws, even disconnected", () => {
    const h = harness({ overlay: 10 });
    h.t.overlay("418", { active: true, cursor: { x: 10, y: 20, kind: "press" } });
    expect(h.sent.at(-1)).toMatchObject({ method: "overlay", params: { tabKey: "418", active: true, cursor: { x: 10, y: 20, kind: "press" } } });
    h.t.disconnect();
    expect(() => h.t.overlay("418", { active: false })).not.toThrow();
  });
});

describe("notifications", () => {
  test("cdp.event reaches listeners only for a subscribed, allowlisted event; Network params are stripped", async () => {
    const h = harness();
    const events: unknown[] = [];
    h.t.onEvent((e) => events.push(e));
    h.notify("cdp.event", { tabKey: "418", method: "Page.frameNavigated", params: { frame: {} } });
    expect(events).toEqual([]); // not subscribed yet
    const sub = h.t.subscribe("418", ["Page.frameNavigated", "Network.requestWillBeSent"]);
    h.answer({});
    await sub;
    h.notify("cdp.event", { tabKey: "418", method: "Page.frameNavigated", params: { frame: { id: "F" } }, cdpSessionId: "S1" });
    h.notify("cdp.event", { tabKey: "418", method: "Network.requestWillBeSent", params: { requestId: "1", timestamp: 2, type: "Document", request: { headers: { cookie: "secret" } } } });
    h.notify("cdp.event", { tabKey: "418", method: "Page.loadEventFired", params: {} }); // not subscribed
    h.notify("cdp.event", { tabKey: "418", method: "Network.responseReceived", params: {} }); // never allowed
    h.notify("cdp.event", { tabKey: "419", method: "Page.frameNavigated", params: {} }); // another tab
    expect(events).toEqual([
      { tabKey: "418", method: "Page.frameNavigated", params: { frame: { id: "F" } }, cdpSessionId: "S1" },
      { tabKey: "418", method: "Network.requestWillBeSent", params: { requestId: "1", timestamp: 2, type: "Document" } },
    ]);
  });

  test("only a tab really closed or crashed — or taken back by the user — is gone; Stop becomes onStop", () => {
    const h = harness();
    const gone: [string, string][] = [];
    const stops: string[] = [];
    h.t.onTabGone((k, r) => gone.push([k, r]));
    h.t.onStop((k) => stops.push(k));
    h.notify("tab.gone", { tabKey: "1", reason: "closed" });
    h.notify("tab.gone", { tabKey: "2", reason: "crashed" });
    h.notify("debugger.detached", { tabKey: "3", reason: "canceled_by_user" });
    h.notify("stop.pressed", { tabKey: "6" });
    expect(gone).toEqual([["1", "closed"], ["2", "crashed"], ["3", "detached_by_user"]]);
    expect(stops).toEqual(["6"]);
  });

  test("an idle or target_closed detach of a tab that still exists is the debugger's own Inspector.detached, never a lost tab", async () => {
    const h = harness();
    const gone: string[] = [];
    const events: unknown[] = [];
    h.t.onTabGone((k) => gone.push(k));
    h.t.onEvent((e) => events.push(e));
    const sub = h.t.subscribe("4", ["Page.frameNavigated"]); // Inspector.detached not subscribed: delivered anyway
    h.answer({});
    await sub;
    h.notify("debugger.detached", { tabKey: "4", reason: "target_closed" });
    h.notify("debugger.detached", { tabKey: "5", reason: "idle" });
    expect(gone).toEqual([]);
    expect(events).toEqual([
      { tabKey: "4", method: "Inspector.detached", params: { reason: "target_closed" } },
      { tabKey: "5", method: "Inspector.detached", params: { reason: "idle" } },
    ]);
    // The tab's subscription ended with its debugger: nothing more is forwarded until it is attached and subscribed again.
    h.notify("cdp.event", { tabKey: "4", method: "Page.frameNavigated", params: {} });
    expect(events).toHaveLength(2);
  });

  test("a throwing listener does not stop the others", () => {
    const h = harness();
    const seen: string[] = [];
    h.t.onStop(() => { throw new Error("boom"); });
    h.t.onStop((k) => seen.push(k));
    h.notify("stop.pressed", { tabKey: "7" });
    expect(seen).toEqual(["7"]);
  });

  test("an unsubscribe stops delivery", () => {
    const h = harness();
    const seen: string[] = [];
    const off = h.t.onStop((k) => seen.push(k));
    off();
    h.notify("stop.pressed", { tabKey: "7" });
    expect(seen).toEqual([]);
  });

  test("a request from the extension is not the transport's to answer", () => {
    const h = harness();
    expect(h.t.handle({ jsonrpc: "2.0", id: "e5", method: "hello", params: {} })).toBe(false);
  });
});
