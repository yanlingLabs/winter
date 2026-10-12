// ComputerV2 Phase 4 — the whole headless chain on this Mac, with no daemon: the REAL browser engine over the REAL
// headless pool, spawning a built Winter Headless (the pipes, the signature check skipped for an unsigned dev build only
// when asked), on local fixture pages. It opens a tab with `{ browser: "headless" }` and reads its state; types,
// clicks and takes a screenshot; clicks inside an out-of-process iframe; answers a page dialog; uploads a file through
// the page's file input; lists the page's own WebMCP tools (`document.modelContext`); refuses a LAN URL; closes the tab
// at the turn's end, disposes the session's context and stops the pool. Last, a separate DRIVER process starts the
// helper and is SIGKILLed: the helper and every CEF subprocess under it must be gone within seconds (the pipe's EOF).
//
//   bun scripts/browser-e2e/headless/engine-smoke.ts --app "<Winter Headless .app>" [--no-verify]
//
// For a Release-built Winter.app, --app is its nested `Contents/Helpers/Winter Headless.app` (it borrows the enclosing
// app's Chromium). Everything it writes is in temp directories.
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
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
const noVerify = process.argv.includes("--no-verify");
const newPool = (home: string, metric?: (m: PrimitiveMetric) => void, log?: (l: string) => void): HeadlessPool => new HeadlessPool({
  home,
  enabled: () => true,
  resolve: () => ({ engine: "winter", app, executable, requirement: headlessRequirementFor("dist", true) }),
  ...(noVerify ? { verify: () => true } : { verify: processSatisfiesRequirement }),
  ...(metric === undefined ? {} : { metric }),
  ...(log === undefined ? {} : { log }),
});

// ── the DRIVER mode: a separate process that starts the helper, says its pid, and waits to be killed ──
if (process.argv.includes("--driver")) {
  const pool = newPool(mkdtempSync(join(tmpdir(), "winter-headless-driver-")));
  const page = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("<title>driver</title><h1>driver</h1>", { headers: { "content-type": "text/html" } }) });
  await pool.createTab({ sessionId: "s_driver", url: `http://localhost:${page.port}/` });
  process.stdout.write(`${JSON.stringify({ helperPid: pool.pid })}\n`);
  await new Promise(() => {});
}

const home = mkdtempSync(join(tmpdir(), "winter-headless-engine-"));
// The session's working directory (an upload comes from there — never from Winter's own home).
const cwd = mkdtempSync(join(tmpdir(), "winter-headless-engine-cwd-"));
writeFileSync(join(cwd, "receipt.txt"), "a receipt");

// Two sites (localhost and 127.0.0.1): an iframe from the second is an out-of-process iframe.
const frameSite = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  fetch: () => new Response(`<!doctype html><title>frame</title><button onclick="this.textContent='frame clicked'">In the frame</button>`, { headers: { "content-type": "text/html" } }),
});
const page = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  fetch: (req) => {
    const path = new URL(req.url).pathname;
    const html = (body: string) => new Response(`<!doctype html>${body}`, { headers: { "content-type": "text/html" } });
    if (path === "/frames") return html(`<title>Frames</title><h1>Frames</h1><iframe title="Other site" src="http://127.0.0.1:${frameSite.port}/" width=400 height=120></iframe>`);
    if (path === "/dialog") return html(`<title>Dialog</title><button onclick="document.getElementById('o').textContent = confirm('Proceed?') ? 'answered yes' : 'answered no'">Ask</button><p id=o>not asked</p>`);
    if (path === "/upload") return html(`<title>Upload</title><label>Receipt <input type=file onchange="document.getElementById('o').textContent = 'picked ' + this.files[0].name"></label><p id=o>nothing picked</p>`);
    if (path === "/tools") {
      return html(`<title>Tools</title><h1>Site tools</h1><script>
        if (document.modelContext) document.modelContext.registerTool({ name: "say_hello", description: "Say hello", execute: async () => "hello" });
        document.title = document.modelContext ? "Tools" : "Tools (no WebMCP)";</script>`);
    }
    return html(`<title>Engine smoke</title><h1>Headless</h1>
      <label>Name <input id=n></label> <button onclick="document.title='clicked '+document.getElementById('n').value">Go</button>`);
  },
});
const base = `http://localhost:${page.port}`;

const metrics: PrimitiveMetric[] = [];
const pool = newPool(home, (m) => metrics.push(m), (l) => console.log(`  log: ${l}`));
const registry = new BrowserBackendRegistry();
registry.register(pool, { family: "headless", name: HEADLESS_NAME, instanceKey: "headless" });
const ended: string[] = [];
const engine = new BrowserEngine({
  registry, mintWinterTab: () => "unused", winterTabs: () => ({ tabs: [] }), sessionInfo: () => ({ cwd, title: "smoke" }),
  home, uploadRoots: () => ({ denyRead: [] }),
  headlessSessionEnded: (sid) => { ended.push(sid); pool.disposeSession(sid); }, headlessReason: () => pool.reason,
  headlessLocalNetworkRefusedAt: (tabKey) => pool.localNetworkRefusedAt(tabKey),
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
const refOf = (state: string, re: RegExp): number => {
  const m = re.exec(state);
  if (m === null) throw new Error(`no ${re} in the state: ${state.slice(0, 400)}`);
  return Number(m[1]);
};

const r = scope("r1");
let tab!: TabHandle;
const P = (primitive: string, args: Record<string, unknown> = {}) => engine.primitive(r.s, tab.targetId, primitive, args);
await check("browsers.open({ browser: \"headless\" }) starts the helper and prints the page", async () => {
  const t0 = Date.now();
  tab = await engine.global(r.s, "browsers.open", { url: `${base}/`, browser: "headless" }) as TabHandle;
  const text = r.text();
  return text.includes("opened a new tab in Winter's headless browser") && text.includes("Engine smoke") ? `${Date.now() - t0} ms to the first state` : false;
});
await check("state(), type and click; the page's title says so", async () => {
  const state = await P("state", { full: true, emit: false }) as string;
  await P("type", { into: refOf(state, /\[(\d+)\] text field "Name"/), text: "winter" });
  await P("click", { target: refOf(state, /\[(\d+)\] button "Go"/) });
  const title = await P("title", { emit: false }) as string;
  return title === "clicked winter" ? title : false;
});
await check("a screenshot", async () => {
  const shot = await P("screenshot", { emit: false }) as { width?: number };
  return typeof shot?.width === "number" ? `${shot.width} px wide` : false;
});
await check("a click inside an out-of-process iframe (another site)", async () => {
  await P("goto", { url: `${base}/frames` });
  let state = "";
  for (let i = 0; i < 30 && !/button "In the frame"/.test(state); i++) { state = await P("state", { full: true, emit: false }) as string; if (!/button "In the frame"/.test(state)) await Bun.sleep(200); }
  await P("click", { target: refOf(state, /\[(\d+)\] button "In the frame"/) });
  const after = await P("state", { full: true, emit: false }) as string;
  return /button "frame clicked"/.test(after) ? "the frame's button changed" : `not changed: ${after.slice(0, 300)}`;
});
await check("a page dialog: shown first in the state, answered, the page sees the answer", async () => {
  await P("goto", { url: `${base}/dialog` });
  const state = await P("state", { full: true, emit: false }) as string;
  await P("click", { target: refOf(state, /\[(\d+)\] button "Ask"/) });
  const d = await P("dialog", { emit: false }) as { type?: string; message?: string } | null;
  await P("answerDialog", { accept: true });
  await P("waitFor", { cond: { text: "answered yes" }, timeoutMs: 5_000 });
  return d?.type === "confirm" && d.message === "Proceed?" ? "confirm → answered yes" : `dialog was ${JSON.stringify(d)}`;
});
await check("a file chooser: upload() picks a file through the page's file input (no native panel)", async () => {
  await P("goto", { url: `${base}/upload` });
  const state = await P("state", { full: true, emit: false }) as string;
  await P("upload", { ref: refOf(state, /\[(\d+)\] file input "Receipt"/), paths: "receipt.txt" });
  await P("waitFor", { cond: { text: "picked receipt.txt" }, timeoutMs: 5_000 });
  return "picked receipt.txt";
});
await check("document.modelContext: the page's own WebMCP tool is listed", async () => {
  await P("goto", { url: `${base}/tools` });
  const title = await P("title", { emit: false }) as string;
  if (title !== "Tools") return `the page found no document.modelContext (title "${title}")`;
  const tools = await P("tools", { emit: false }) as Array<{ name?: string }>;
  return tools.some((t) => t.name === "say_hello") ? "say_hello" : `tools: ${JSON.stringify(tools).slice(0, 200)}`;
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

// ── a driver that dies takes the helper and its CEF subprocesses with it ──
const treeOf = (roots: number[]): Set<number> => {
  const ps = Bun.spawnSync(["/bin/ps", "-A", "-o", "pid=,ppid="], { stdout: "pipe", env: { ...process.env, LC_ALL: "C" } }).stdout.toString();
  const children = new Map<number, number[]>();
  for (const line of ps.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (m !== null) children.set(Number(m[2]), [...(children.get(Number(m[2])) ?? []), Number(m[1])]);
  }
  const out = new Set<number>();
  const stack = [...roots];
  while (stack.length > 0) { const p = stack.pop()!; if (!out.has(p)) { out.add(p); stack.push(...(children.get(p) ?? [])); } }
  return out;
};
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
await check("a driver SIGKILLed: the helper and every CEF subprocess under it are gone (the pipe's EOF)", async () => {
  const driver = spawn(process.execPath, [import.meta.path, "--driver", "--app", app, ...(noVerify ? ["--no-verify"] : [])], { stdio: ["ignore", "pipe", "inherit"], env: { ...process.env } });
  let line = "";
  const helperPid = await new Promise<number | undefined>((resolve) => {
    const t = setTimeout(() => resolve(undefined), 30_000);
    driver.stdout!.on("data", (c: Buffer) => {
      line += c.toString("utf8");
      const nl = line.indexOf("\n");
      if (nl >= 0) { clearTimeout(t); try { resolve((JSON.parse(line.slice(0, nl)) as { helperPid?: number }).helperPid); } catch { resolve(undefined); } }
    });
  });
  if (helperPid === undefined) { driver.kill("SIGKILL"); return "the driver never reported its helper"; }
  await Bun.sleep(1_000);
  const tree = [...treeOf([helperPid])];
  driver.kill("SIGKILL");
  const t0 = Date.now();
  while (Date.now() - t0 < 8_000 && tree.some(alive)) await Bun.sleep(100);
  const left = tree.filter(alive);
  for (const pid of left) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  if (left.length > 0) throw new Error(`still alive 8 s after the driver died (killed now): ${left.join(", ")} of ${tree.length}`);
  return `${tree.length} process(es) gone in ${Date.now() - t0} ms`;
});

page.stop(true);
frameSite.stop(true);
const failed = results.filter(([, ok]) => !ok).length;
console.log(`${results.length - failed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
