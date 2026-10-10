// Browser tabs through the WHOLE ComputerV2 path: a REAL sandboxed worker runs the script (its `Tab` class and the
// `browsers` global), the REAL service routes tab primitives to the REAL engine by membership, over FAKE backends.
// Covers the worker API, the fence, the audit's sites and browsers, a tab-only script leaving the helper alone, a
// timeout naming its tab, reset and turn-end lifecycle, and the extension's Stop.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApprovalBroker } from "../../src/agent/approvals";
import { BrowserEngine } from "../../src/computer-use/browser/engine";
import { BrowserBackendRegistry } from "../../src/computer-use/browser/registry";
import { HelperClient } from "../../src/computer-use/helper-client";
import { ComputerPolicy, type SessionFacts } from "../../src/computer-use/policy";
import { ComputerV2Service, type ScriptResult } from "../../src/computer-use/service";
import { sandboxAvailable } from "../../src/workflows/sandbox";
import type { Settings } from "../../src/settings";
import { FakeCdpTransport, type FakePage } from "./browser-fake-transport";
import { FakeHelper } from "./fake-helper";

const macOnly = sandboxAvailable() ? test : test.skip;
const services: ComputerV2Service[] = [];
afterEach(() => { for (const s of services.splice(0)) s.stop(); });

const SHOP: FakePage = {
  url: "https://shop.example.com/cart", title: "Checkout",
  nodes: [{ id: 1, role: "main", children: [{ id: 2, role: "text field", name: "Coupon", value: "", showEmptyValue: true }, { id: 3, role: "button", name: "Pay" }] }],
  editable: [2],
};

function world(o: { policy?: SessionFacts["policy"] } = {}) {
  const home = mkdtempSync(join(tmpdir(), "winter-browser-svc-"));
  const fake = new FakeHelper();
  const settings = { computerUse: { apps: {} } } as unknown as Settings;
  const facts: SessionFacts = { policy: o.policy ?? "bypass", mode: "code" };
  const audits: Array<Record<string, unknown>> = [];
  const interrupts: string[] = [];
  let svc!: ComputerV2Service;
  const helper = new HelperClient({
    home, profile: "dev", launchAllowed: true, transport: fake.transport, launcher: fake.launcher, verifier: fake.verifier,
    onNotification: (n) => svc.handleNotification(n), onDisconnect: () => svc.helperDisconnected(),
  });
  const approvals = new ApprovalBroker();
  const policy = new ComputerPolicy({ settings: () => settings, saveAlwaysGrant: () => {}, approvals, emit: () => {}, session: () => facts, attended: () => true });
  const registry = new BrowserBackendRegistry();
  const winter = new FakeCdpTransport("winter", "winter");
  const chrome = new FakeCdpTransport("chrome", "chrome");
  winter.pages[SHOP.url] = SHOP;
  registry.register(winter, { family: "winter", name: "Winter (built-in)", instanceKey: "winter" });
  registry.register(chrome, { family: "chrome", name: "Google Chrome", bundleId: "com.google.Chrome", instanceKey: "c1" });
  let n = 0;
  const strip: Array<{ tabId: string; url?: string }> = [];
  const engine = new BrowserEngine({
    registry, sessionInfo: () => ({ cwd: home, title: "t" }), home,
    mintWinterTab: (_sid, url) => { const tabId = `w${++n}`; strip.push({ tabId, ...(url === undefined ? {} : { url }) }); return tabId; },
    winterTabs: () => ({ tabs: strip.map((t) => ({ ...t, url: winter.tabs.get(t.tabId)?.page.url ?? t.url })) }),
    persistentlyAllowed: (sid, b) => policy.persistentlyAllowed(sid, b), stopScript: (sid, why) => svc.stopScript(sid, why),
  });
  svc = new ComputerV2Service({ helper, policy, settings: () => settings, browsers: engine, audit: (l) => audits.push(l), interrupt: (sid) => interrupts.push(sid) });
  services.push(svc);
  const run = (code: string, x: { timeoutMs?: number; reset?: boolean } = {}): Promise<ScriptResult> =>
    svc.run({ sessionId: "s1", vision: true, model: "anthropic/claude-opus-5-5" }, { code, ...x });
  return { fake, svc, run, audits, interrupts, winter, chrome, engine };
}

const text = (r: ScriptResult): string => r.content.map((c) => (c.type === "text" ? c.text : "[image]")).join("");

describe("browser tabs through the ComputerV2 service", () => {
  macOnly("browsers.open returns a Tab; its methods route to the engine; state is fenced; the audit names the browser and the site", async () => {
    const w = world();
    const r = await w.run("const tab = await browsers.open('https://shop.example.com/cart')\nprint(String(tab), tab.browser, tab.id)\nawait tab.type('SAVE10', { into: 2 })\nawait tab.click(3)\nawait tab.state()");
    expect(r.isError).toBe(false);
    const t = text(r);
    expect(t).toContain("opened a new tab in Winter's browser\n");
    expect(t).toContain("[Tab winter:w1] winter winter:w1");
    expect(t).toMatch(/<screen-data id="[0-9a-f]+">\nTab "Checkout"/);
    expect(t).toContain('~ [2] value "" → "SAVE10"');
    expect(w.audits[0]).toMatchObject({ kind: "automation", outcome: "ok", browsers: ["winter"], sites: ["shop.example.com"] });
    // A tab-only script never launched or told the helper.
    expect(w.fake.calls("script.active")).toEqual([]);
    expect(w.fake.calls("apps.list")).toEqual([]);
  }, 30_000);

  macOnly("the handle persists between calls; url() returns without printing; a Tab passed as an argument is stripped", async () => {
    const w = world();
    await w.run("const tab = await browsers.open('https://shop.example.com/cart')");
    const r = await w.run("const u = await tab.url()\nprint(u.length > 0)\nconst again = await browsers.tab(tab.id)\nprint(again.id === tab.id)");
    expect(text(r).match(/\btrue\b/g)?.length).toBe(2);
    expect(text(r)).toContain("already bound");
  }, 30_000);

  macOnly("errors cross as their classes: BrowserUnavailable, StaleRef, TargetLost after a reset", async () => {
    const w = world();
    const r = await w.run("try { await browsers.open('https://x.example/', { browser: 'chrome' }) } catch (e) { print('unexpected', e.name) }\ntry { await browsers.list(); w2 } catch (e) { print(e instanceof ReferenceError) }");
    expect(text(r)).not.toContain("unexpected");
    w.chrome.connected = false;
    const r2 = await w.run("try { await browsers.open('https://x.example/', { browser: 'chrome' }) } catch (e) { print(e instanceof BrowserUnavailable, e.message) }");
    expect(text(r2)).toContain("true Google Chrome can't be reached");
    await w.run("const tab = await browsers.open('https://shop.example.com/cart')");
    w.winter.navigateTo("w1", "https://shop.example.com/done");
    const r3 = await w.run("try { await tab.click(3) } catch (e) { print(e instanceof StaleRef) }");
    expect(text(r3)).toContain("true");
    const r4 = await w.run("print(typeof tab)", { reset: true });
    expect(text(r4)).toContain("undefined");
  }, 30_000);

  macOnly("a timeout names the tab it was working in; the turn's end releases a user's tab", async () => {
    const w = world();
    w.chrome.addTab({ url: "https://u.example/", title: "Inbox", nodes: [{ id: 1, role: "text", name: "hi" }], busy: true }, { tabKey: "9" });
    const r = await w.run("const t = await browsers.tab('chrome:9')\nwhile (true) { await t.waitForIdle({ timeoutMs: 200 }) }", { timeoutMs: 1_500 });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('the last waitForIdle() in Tab "Inbox"');
    w.svc.turnEnded("s1");
    const r2 = await w.run("try { await t.state() } catch (e) { print(e instanceof TargetLost, e.message) }");
    expect(text(r2)).toContain("true that tab is the user's and was released at the end of the turn");
  }, 30_000);

  macOnly("the extension's Stop button stops the script running on that tab and interrupts the turn", async () => {
    const w = world();
    w.chrome.addTab({ url: "https://u.example/", title: "U", nodes: [], busy: true }, { tabKey: "9" });
    const running = w.run("const t = await browsers.tab('chrome:9')\nwhile (true) { await t.waitForIdle({ timeoutMs: 100 }) }", { timeoutMs: 20_000 });
    await new Promise((res) => setTimeout(res, 600));
    w.chrome.pressStop("9");
    const r = await running;
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("the user pressed Stop in the browser");
    expect(w.interrupts).toEqual(["s1"]);
  }, 30_000);
});
