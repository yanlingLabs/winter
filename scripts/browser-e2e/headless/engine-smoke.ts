// ComputerV2 Phase 4 — the whole headless chain on this Mac, with no daemon: the REAL browser engine over the REAL
// headless pool, spawning a built Winter Headless (the pipes, the signature check skipped for an unsigned dev build only
// when asked), on a local fixture page. Opens a tab with `{ browser: "headless" }`, reads its state, clicks, types, takes
// a screenshot, refuses a LAN URL, closes the tab at the turn's end, disposes the session's context and stops the pool.
//
//   bun scripts/browser-e2e/headless/engine-smoke.ts --app "<Winter Headless Dev.app>" [--no-verify]
//
// Everything it writes is in temp directories.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { BrowserEngine } from "../../../packages/core/src/computer-use/browser/engine";
import { headlessRequirementFor } from "../../../packages/core/src/computer-use/browser/headless/engines";
import { HEADLESS_NAME, HeadlessPool } from "../../../packages/core/src/computer-use/browser/headless/pool";
import { BrowserBackendRegistry } from "../../../packages/core/src/computer-use/browser/registry";
import type { TabRunScope } from "../../../packages/core/src/computer-use/browser/tab-scope";
import { DiffBases } from "../../../packages/core/src/computer-use/diff-base";
import { AutomationFailure } from "../../../packages/core/src/computer-use/errors";
import { processSatisfiesRequirement } from "../../../packages/core/src/computer-use/helper-verify";
import { TargetLocks } from "../../../packages/core/src/computer-use/locks";
import type { SessionFacts } from "../../../packages/core/src/computer-use/policy";
import { ResultBuilder } from "../../../packages/core/src/computer-use/result";
import type { PrimitiveMetric } from "../../../packages/core/src/computer-use/telemetry";
import type { TabHandle } from "../../../packages/core/src/computer-use/worker/bridge";

const arg = (name: string): string | undefined => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
const app = arg("--app");
if (app === undefined) { console.error("usage: engine-smoke.ts --app <Winter Headless .app> [--no-verify]"); process.exit(2); }
const executable = join(app, "Contents", "MacOS", basename(app).replace(/\.app$/, ""));
const home = mkdtempSync(join(tmpdir(), "winter-headless-engine-"));

const page = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  fetch: () => new Response(`<!doctype html><title>Engine smoke</title><h1>Headless</h1>
    <label>Name <input id=n></label> <button onclick="document.title='clicked '+document.getElementById('n').value">Go</button>`,
  { headers: { "content-type": "text/html" } }),
});
const url = `http://localhost:${page.port}/`;

const metrics: PrimitiveMetric[] = [];
const pool = new HeadlessPool({
  home,
  enabled: () => true,
  resolve: () => ({ engine: "winter", app, executable, requirement: headlessRequirementFor("dist", true) }),
  ...(process.argv.includes("--no-verify") ? { verify: () => true } : { verify: processSatisfiesRequirement }),
  metric: (m) => metrics.push(m),
  log: (l) => console.log(`  log: ${l}`),
});
const registry = new BrowserBackendRegistry();
registry.register(pool, { family: "headless", name: HEADLESS_NAME, instanceKey: "headless" });
const ended: string[] = [];
const engine = new BrowserEngine({
  registry, mintWinterTab: () => "unused", winterTabs: () => ({ tabs: [] }), sessionInfo: () => ({ cwd: home, title: "smoke" }),
  home, headlessSessionEnded: (sid) => { ended.push(sid); pool.disposeSession(sid); }, headlessReason: () => pool.reason,
});
const locks = new TargetLocks();
const diffBases = new DiffBases();
const facts: SessionFacts = { policy: "ask", mode: "code" };
function scope(runId: string) {
  const builder = new ResultBuilder();
  const abort = new AbortController();
  const held = new Map<string, () => void>();
  const metric: PrimitiveMetric = { ts: 0, sessionId: "smoke", callId: "cv2", primitive: "x", ms: 0, helperMs: 0 };
  const s: TabRunScope = {
    sessionId: "smoke", runId, callId: "cv2", vision: true, signal: abort.signal, live: () => {}, timeLeft: () => 60_000, clampWait: (ms) => Math.min(ms, 60_000),
    lock: async (key, label) => { if (!held.has(key)) held.set(key, await locks.acquire(key, { runId, sessionId: "smoke" }, { label })); },
    lockRun: (key) => locks.holder(key)?.runId, authorize: async () => { throw new Error("no card may be raised for Winter's own browser"); },
    sessionPolicy: () => facts.policy, sessionFacts: () => facts, siteCard: async () => ({ approved: false }), persistentlyAllowed: () => false, granted: () => false,
    builder, keepImage: (img) => ({ image: "img", width: img.width, height: img.height }), lastTargetShot: new Map(), acted: new Set(), diffBases, metric,
    noteSite: () => {}, noteBrowser: () => {}, trusted: () => {},
  };
  return { s, metric, text: () => builder.build().content.map((c) => (c.type === "text" ? c.text : "[image]")).join(""), end: () => { for (const r of held.values()) r(); abort.abort(); engine.runEnded("smoke", runId); } };
}

const results: Array<[string, boolean, string]> = [];
const check = async (name: string, fn: () => Promise<string | boolean>): Promise<void> => {
  try { const r = await fn(); results.push([name, r !== false, typeof r === "string" ? r : ""]); } catch (err) { results.push([name, false, err instanceof Error ? `${err.name}: ${err.message}` : String(err)]); }
  const [n, ok, d] = results.at(-1)!;
  console.log(`${ok ? "PASS" : "FAIL"} ${n}${d.length > 0 ? ` — ${d.slice(0, 300)}` : ""}`);
};

const r = scope("r1");
let tab!: TabHandle;
await check("browsers.open({ browser: \"headless\" }) starts the helper and prints the page", async () => {
  const t0 = Date.now();
  tab = await engine.global(r.s, "browsers.open", { url, browser: "headless" }) as TabHandle;
  const text = r.text();
  return text.includes("opened a new tab in Winter's headless browser") && text.includes("Engine smoke") ? `${Date.now() - t0} ms to the first state` : false;
});
await check("type and click; the page's title says so", async () => {
  const state = await engine.primitive(r.s, tab.targetId, "state", { full: true, emit: false }) as string;
  const field = Number(/\[(\d+)\] text field "Name"/.exec(state)?.[1]);
  const button = Number(/\[(\d+)\] button "Go"/.exec(state)?.[1]);
  await engine.primitive(r.s, tab.targetId, "type", { into: field, text: "winter" });
  await engine.primitive(r.s, tab.targetId, "click", { target: button });
  const title = await engine.primitive(r.s, tab.targetId, "title", { emit: false }) as string;
  return title === "clicked winter" ? title : false;
});
await check("a screenshot", async () => {
  const shot = await engine.primitive(r.s, tab.targetId, "screenshot", { emit: false }) as { width?: number };
  return typeof shot?.width === "number" ? `${shot.width} px wide` : false;
});
await check("the primitives are metered as headless", async () => r.metric.headlessEngine === "winter" && r.metric.backend === "headless");
await check("a LAN address is refused", async () => {
  try { await engine.global(r.s, "browsers.open", { url: "http://192.168.1.1/", browser: "headless" }); return false; } catch (err) { return err instanceof AutomationFailure && err.kind === "NotAllowed"; }
});
r.end();
await check("the turn's end closes the tab", async () => {
  engine.turnEnded("smoke");
  await Bun.sleep(300);
  return pool.tabCount("smoke") === 0;
});
await check("the runtime's end disposes the session's context", async () => {
  engine.sessionEnded("smoke", "idle");
  return ended.includes("smoke");
});
await check("the launch was metered", async () => metrics.some((m) => m.primitive === "headless.launch"));
pool.stop();
await check("the pool's stop ends the helper", async () => { await Bun.sleep(500); return !pool.running; });
page.stop(true);
const failed = results.filter(([, ok]) => !ok).length;
console.log(`${results.length - failed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
