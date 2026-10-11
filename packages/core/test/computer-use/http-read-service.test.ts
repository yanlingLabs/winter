// `browsers.read(url)` through the WHOLE ComputerV2 path: a REAL sandboxed worker (which has no network) calls it, the
// REAL service routes it to the REAL engine, whose reader fetches over an injected network. Many reads in one call
// (`Promise.all`), the fence, the audit's sites and browsers, no helper — and every other `browsers.*` primitive
// routed to the engine too (the service once routed only four of them).
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApprovalBroker } from "../../src/agent/approvals";
import { BrowserEngine } from "../../src/computer-use/browser/engine";
import { HttpReader } from "../../src/computer-use/browser/http-read";
import { BrowserBackendRegistry } from "../../src/computer-use/browser/registry";
import { HelperClient } from "../../src/computer-use/helper-client";
import { ComputerPolicy, type SessionFacts } from "../../src/computer-use/policy";
import { ComputerV2Service, type ScriptResult } from "../../src/computer-use/service";
import { BROWSER_PRIMITIVES } from "../../src/computer-use/worker/bridge";
import { sandboxAvailable } from "../../src/workflows/sandbox";
import type { Settings } from "../../src/settings";
import { FakeHelper } from "./fake-helper";

const macOnly = sandboxAvailable() ? test : test.skip;
const services: ComputerV2Service[] = [];
afterEach(() => { for (const s of services.splice(0)) s.stop(); });

function world(o: { policy?: SessionFacts["policy"] } = {}) {
  const home = mkdtempSync(join(tmpdir(), "winter-read-svc-"));
  const fake = new FakeHelper();
  const settings = { computerUse: { apps: {} } } as unknown as Settings;
  const facts: SessionFacts = { policy: o.policy ?? "bypass", mode: "code" };
  const audits: Array<Record<string, unknown>> = [];
  let svc!: ComputerV2Service;
  const helper = new HelperClient({
    home, profile: "dev", launchAllowed: true, transport: fake.transport, launcher: fake.launcher, verifier: fake.verifier,
    onNotification: (n) => svc.handleNotification(n), onDisconnect: () => svc.helperDisconnected(),
  });
  const policy = new ComputerPolicy({ settings: () => settings, saveAlwaysGrant: () => {}, approvals: new ApprovalBroker(), emit: () => {}, session: () => facts, attended: () => true });
  const fetched: string[] = [];
  const reader = new HttpReader({
    resolve: async () => ["93.184.216.34"],
    fetchFn: async (_url, init) => {
      const host = ((init.headers ?? {}) as Record<string, string>).Host ?? "";
      fetched.push(host);
      const n = /^doc(\d+)\.example$/.exec(host)?.[1] ?? "?";
      return new Response(`<html><head><title>Doc ${n}</title></head><body><h1>Page ${n}</h1><p>Body of page ${n}.</p></body></html>`, { headers: { "content-type": "text/html" } });
    },
  });
  const engine = new BrowserEngine({
    registry: new BrowserBackendRegistry(), sessionInfo: () => ({ cwd: home, title: "t" }), home,
    mintWinterTab: () => "w1", winterTabs: () => ({ tabs: [] }), httpReader: reader,
  });
  svc = new ComputerV2Service({ helper, policy, settings: () => settings, browsers: engine, audit: (l) => audits.push(l) });
  services.push(svc);
  const run = (code: string): Promise<ScriptResult> => svc.run({ sessionId: "s1", vision: true, model: "anthropic/claude-opus-5-5" }, { code });
  return { fake, run, audits, fetched };
}

const text = (r: ScriptResult): string => r.content.map((c) => (c.type === "text" ? c.text : "[image]")).join("");

describe("browsers.read through the ComputerV2 service", () => {
  macOnly("twenty reads in one call with Promise.all; the values reach the script; the result is fenced; the audit names http and the sites", async () => {
    const w = world();
    const r = await w.run([
      "const urls = Array.from({ length: 20 }, (_, i) => `https://doc${i}.example/`)",
      "const pages = await Promise.all(urls.map((u) => browsers.read(u, { emit: false })))",
      "print(pages.length, pages[7].status, pages[7].title, pages[7].text.split('\\n')[0], pages.every((p) => !p.needsJs))",
      "await browsers.read('https://doc3.example/')",
    ].join("\n"));
    expect(r.isError).toBe(false);
    const t = text(r);
    expect(t).toContain("20 200 Page 7 # Page 7 true");
    expect(t).toMatch(/<screen-data id="[0-9a-f]+">/);
    expect(t).toContain("read https://doc3.example/ — 200 text/html");
    expect(w.fetched.length).toBe(21);
    expect(w.audits[0]).toMatchObject({ kind: "automation", outcome: "ok", browsers: ["http"] });
    expect((w.audits[0]!.sites as string[]).length).toBe(20);
    // No app, no tab: the helper never heard of it.
    expect(w.fake.calls("script.active")).toEqual([]);
  }, 30_000);

  macOnly("a refusal crosses as its class: the LAN is NotAllowed inside the script", async () => {
    const w = world();
    const r = await w.run("try { await browsers.read('http://192.168.1.1/') } catch (e) { print(e instanceof NotAllowed, e.message) }");
    expect(text(r)).toContain("true 192.168.1.1 is a private network address");
    expect(w.fetched).toEqual([]);
  }, 30_000);

  macOnly("every browsers.* primitive reaches the engine (none falls through to an app target)", async () => {
    const w = world();
    const calls = BROWSER_PRIMITIVES.map((p) => p.split(".")[1]!).filter((m) => m !== "read" && m !== "open" && m !== "tab");
    const r = await w.run(`for (const m of ${JSON.stringify(calls)}) { try { await browsers[m]({ browser: "nope" }); print(m, "ok") } catch (e) { print(m, e.name, e.message.slice(0, 60)) } }`);
    const t = text(r);
    for (const m of calls) {
      expect(t).toContain(m);
      expect(t).not.toMatch(new RegExp(`${m} TargetLost`));
    }
    expect(t).not.toContain("that app is no longer bound");
  }, 30_000);
});
