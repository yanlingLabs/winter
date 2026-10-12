// ComputerV2 Phase 4 — the SURFACE PROOF for a headless presentation: Winter Headless keeps the page, a viewer sees it
// through the GPU and takes it over, the agent gets the SAME live page back — repeatedly — and nothing of the page is
// lost on the way. No daemon, no Winter.app: this script is the daemon (the helper's pipe, fds 3/4) and runs the proof
// viewer (`viewer.m`, built and ad-hoc signed here; the helper accepts it by its cdhash) as the panel's stand-in. Only
// local pages; nothing is shown on screen.
//
// The page is a SENTINEL: an id and `performance.timeOrigin` of its own, a closure counter, an agent-typed field and a
// user-typed one, a `<select>`, two history entries, a WebSocket heartbeat and a 4 MB upload the server reads slowly —
// all reported into the DOM, which the agent reads from its own world. The ORACLE, after every hand-back: the same id
// and time origin, no top-frame navigation event ever, the closure still counting, both fields kept, the history
// unchanged, ONE WebSocket connection (still beating) and ONE upload request, server-side.
//
// Cycles: present (watch) → take over (the viewer clicks and types; key presses toggle a marker the viewer's probe
// pixel watches: input→pixel time) → hand back → unpresent. Then: a scale change mid-presentation (new pool
// generations), a slow viewer (the producer must drop, never queue), a pending JS dialog and a `<select>` popup across a
// presentation, and a viewer that dies without a word (the helper must end the presentation and keep the tab).
//
// The page also runs a CSS animation, so frames keep coming at the presentation's 60 a second.
//
//   bun scripts/browser-e2e/headless/present/proof.ts --app "<Winter Headless Dev.app>" [--cycles 8] [--report <file>]
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const app = arg("--app");
if (app === undefined) { console.error("usage: proof.ts --app <Winter Headless .app> [--cycles N] [--report file]"); process.exit(2); }
const cycles = Number(arg("--cycles") ?? "8");
const exe = join(app, "Contents", "MacOS", app.split("/").pop()!.replace(/\.app$/, ""));
const repo = join(import.meta.dir, "..", "..", "..", "..");
const work = mkdtempSync(join(tmpdir(), "winter-present-proof-"));
const cacheRoot = join(work, "cache");

// ── the viewer: built and ad-hoc signed here; accepted by its cdhash ─────────────────────────────────────────────────
const viewerBin = join(work, "viewer");
const src = join(repo, "apple", "Winter", "Sources", "HeadlessPresent");
const built = spawnSync("/usr/bin/clang", ["-fobjc-arc", "-O2", "-I", src, join(import.meta.dir, "viewer.m"), join(src, "WinterPresentConsumer.m"),
  join(src, "WinterPresentAuth.m"), "-framework", "Foundation", "-framework", "Metal", "-framework", "IOSurface", "-framework", "Security", "-lbsm",
  "-o", viewerBin], { encoding: "utf8" });
if (built.status !== 0) { console.error(built.stderr); process.exit(1); }
spawnSync("/usr/bin/codesign", ["-s", "-", "-f", viewerBin]);
const cdhash = /CDHash=([0-9a-f]+)/.exec(spawnSync("/usr/bin/codesign", ["-dvvv", viewerBin], { encoding: "utf8" }).stderr)?.[1];
if (cdhash === undefined) { console.error("no cdhash for the viewer"); process.exit(1); }
const viewerRequirement = `cdhash H"${cdhash}"`;
// What the viewer requires of the producer: the helper's own designated requirement, read off the app.
const producerRequirement = (spawnSync("/usr/bin/codesign", ["-d", "-r-", app], { encoding: "utf8" }).stdout + spawnSync("/usr/bin/codesign", ["-d", "-r-", app], { encoding: "utf8" }).stderr)
  .split("\n").find((l) => l.startsWith("designated => "))?.slice("designated => ".length);
if (producerRequirement === undefined) { console.error("the helper has no designated requirement"); process.exit(1); }

// ── the server: the sentinel page, its heartbeat socket, its slow upload ─────────────────────────────────────────────
let wsOpens = 0, wsCloses = 0, wsMessages = 0, uploadRequests = 0, uploadBytes = 0, uploadDone = false;
const sentinel = (port: number): string => `<!doctype html><title>sentinel</title>
<style>body{margin:0;font:16px system-ui}#m{position:absolute;left:20px;top:20px;width:40px;height:40px;background:#00ff00}
#f{position:absolute;left:120px;top:20px}input,textarea,select{display:block;margin:6px 0;font:16px system-ui}
#spin{position:absolute;left:20px;top:200px;width:60px;height:60px;background:#3366ff;animation:spin 1s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}</style>
<div id=m></div><div id=spin></div>
<div id=f><input id=a placeholder=agent><input id=b placeholder=user><select id=s><option>one</option><option>two</option><option>three</option></select></div>
<pre id=state style="position:absolute;left:20px;top:300px"></pre>
<script>
const S = { id: crypto.randomUUID(), origin: performance.timeOrigin, ticks: 0, keys: 0, wsOpen: 0, wsMessages: 0, uploads: 0, uploadDone: "" };
const tick = (() => { let n = 0; return () => ++n; })();
let parity = 0;
document.addEventListener("keydown", (e) => {
  if (e.key !== "k") return;
  parity ^= 1; S.keys++;
  document.getElementById("m").style.background = parity ? "#ff00ff" : "#00ff00";
});
const ws = new WebSocket("ws://127.0.0.1:${port}/hb");
ws.onopen = () => { S.wsOpen++; };
ws.onmessage = () => { S.wsMessages++; };
setInterval(() => { if (ws.readyState === 1) ws.send("hb"); }, 200);
S.uploads++;
fetch("/upload", { method: "POST", body: new Blob([new Uint8Array(4 * 1024 * 1024)]) }).then((r) => r.text()).then((t) => { S.uploadDone = t; });
history.pushState({ n: 1 }, "", "#one");
history.pushState({ n: 2 }, "", "#two");
setInterval(() => {
  S.ticks = tick();
  document.body.dataset.sentinel = JSON.stringify({ ...S, history: history.length, a: document.getElementById("a").value, b: document.getElementById("b").value, s: document.getElementById("s").value });
}, 100);
</script>`;
let serverPort = 0;
const server = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  idleTimeout: 255,  // the slow upload sits on its connection for a long while
  async fetch(req, srv): Promise<Response | undefined> {
    const path = new URL(req.url).pathname;
    if (path === "/hb") return srv.upgrade(req) ? undefined : new Response("ws only", { status: 400 });
    if (path === "/upload") {
      // The upload's request stays IN FLIGHT across the presentations: its body taken, its answer held 40 s.
      uploadRequests++;
      uploadBytes += (await req.arrayBuffer()).byteLength;
      await Bun.sleep(40_000);
      uploadDone = true;
      return new Response(`received ${uploadBytes}`);
    }
    return new Response(sentinel(serverPort), { headers: { "content-type": "text/html" } });
  },
  websocket: { open() { wsOpens++; }, message(ws) { wsMessages++; ws.send("ack"); }, close() { wsCloses++; } },
});
serverPort = server.port ?? 0;
const pageUrl = `http://127.0.0.1:${serverPort}/`;

// ── the pipe (the daemon's half) ─────────────────────────────────────────────────────────────────────────────────────
const proc = spawn(exe, [`--winter-cache-root=${cacheRoot}`], { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"], env: { ...process.env } });
const toHelper = proc.stdio[3] as Writable;
const fromHelper = proc.stdio[4] as Readable;
let stderr = "";
proc.stderr?.on("data", (c: Buffer) => { stderr += c.toString("utf8"); });
type Message = { method: string; params: Record<string, unknown> };
const waiters: Array<{ match: (m: Message) => boolean; resolve: (m: Message) => void }> = [];
const events: Message[] = [];
let pending = Buffer.alloc(0);
fromHelper.on("data", (chunk: Buffer) => {
  pending = Buffer.concat([pending, chunk]);
  for (let nl = pending.indexOf(0x0a); nl >= 0; nl = pending.indexOf(0x0a)) {
    const text = pending.subarray(0, nl).toString("utf8");
    pending = pending.subarray(nl + 1);
    if (text.length === 0) continue;
    const m = JSON.parse(text) as Message;
    events.push(m);
    const i = waiters.findIndex((w) => w.match(m));
    if (i >= 0) waiters.splice(i, 1)[0]!.resolve(m);
  }
});
function wait(match: (m: Message) => boolean, ms: number, what: string): Promise<Message> {
  const seen = events.find(match);
  if (seen !== undefined) return Promise.resolve(seen);
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out waiting for ${what}\n--- helper stderr ---\n${stderr.slice(-3000)}`)), ms);
    waiters.push({ match, resolve: (m) => { clearTimeout(t); resolve(m); } });
  });
}
let linkId = "";
let next = 1;
async function command(op: string, params: Record<string, unknown>, ms = 20_000): Promise<Record<string, unknown>> {
  const cmdId = `c${next++}`;
  toHelper.write(`${JSON.stringify({ jsonrpc: "2.0", method: "browserLink.command", params: { linkId, cmdId, op, params } })}\n`);
  const m = await wait((x) => x.method === "browserLink.result" && x.params.cmdId === cmdId, ms, `${op} (${cmdId})`);
  if (m.params.ok !== true) throw new Error(`${op} failed: ${JSON.stringify(m.params.error)}`);
  return (m.params.result ?? {}) as Record<string, unknown>;
}
const cdp = async (method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> =>
  ((await command("cdp.send", { tabId: "w-1", method, params })).result ?? {}) as Record<string, unknown>;
const flat = () => events.filter((m) => m.method === "browserLink.events").flatMap((m) => m.params.events as Array<{ method: string; params: Record<string, unknown> }>);

const results: Array<[string, boolean, string]> = [];
function check(name: string, ok: boolean, detail = ""): void {
  results.push([name, ok, detail]);
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

// ── the viewer process ───────────────────────────────────────────────────────────────────────────────────────────────
type ViewerEvent = Record<string, unknown> & { event: string };
class ViewerProc {
  readonly events: ViewerEvent[] = [];
  private buf = "";
  readonly child;
  constructor(service: string, nonce: string) {
    this.child = spawn(viewerBin, ["--service", service, "--nonce", nonce, "--producer-requirement", producerRequirement!, "--probe", "40,40"],
      { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env } });
    this.child.stdout!.on("data", (c: Buffer) => {
      this.buf += c.toString("utf8");
      for (let nl = this.buf.indexOf("\n"); nl >= 0; nl = this.buf.indexOf("\n")) {
        const line = this.buf.slice(0, nl); this.buf = this.buf.slice(nl + 1);
        if (line.trim().length > 0) this.events.push(JSON.parse(line) as ViewerEvent);
      }
    });
  }
  send(c: Record<string, unknown>): void { this.child.stdin!.write(`${JSON.stringify(c)}\n`); }
  async until(event: string, ms = 10_000): Promise<ViewerEvent> {
    for (const end = Date.now() + ms; Date.now() < end;) {
      const e = this.events.find((x) => x.event === event);
      if (e !== undefined) return e;
      await Bun.sleep(20);
    }
    throw new Error(`the viewer never said ${event}: ${JSON.stringify(this.events.slice(-5))}`);
  }
  async stats(): Promise<ViewerEvent> {
    const before = this.events.filter((e) => e.event === "stats").length;
    this.send({ cmd: "stats" });
    for (const end = Date.now() + 5_000; Date.now() < end;) {
      const all = this.events.filter((e) => e.event === "stats");
      if (all.length > before) return all[all.length - 1]!;
      await Bun.sleep(20);
    }
    throw new Error("no stats from the viewer");
  }
  exited(): Promise<number | null> { return new Promise((r) => { if (this.child.exitCode !== null) r(this.child.exitCode); else this.child.on("exit", (c) => r(c)); }); }
}

const nonceHex = (): string => [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, "0")).join("");
async function present(control: boolean): Promise<{ viewer: ViewerProc; nonce: string; requestedAt: number }> {
  const nonce = nonceHex();
  const requestedAt = performance.now();
  const r = await command("headless.present", { tabId: "w-1", nonce, viewerRequirement, control, scale: 2 });
  const viewer = new ViewerProc(String(r.service), nonce);
  return { viewer, nonce, requestedAt };
}

// The agent's own read of the sentinel (its world), and the server's.
let world: number | undefined;
async function sentinelState(): Promise<Record<string, unknown>> {
  if (world === undefined) {
    const tree = await cdp("Page.getFrameTree") as { frameTree?: { frame?: { id?: string } } };
    world = ((await cdp("Page.createIsolatedWorld", { frameId: tree.frameTree?.frame?.id, worldName: "winter" })) as { executionContextId?: number }).executionContextId;
  }
  const r = await cdp("Runtime.evaluate", { expression: "document.body.dataset.sentinel || '{}'", contextId: world, returnByValue: true }) as { result?: { value?: string } };
  return JSON.parse(r.result?.value ?? "{}") as Record<string, unknown>;
}

const allowedCycleChecks: string[] = [];
let baseline: Record<string, unknown> = {};
async function oracle(label: string, expect: { b?: string; s?: string } = {}): Promise<void> {
  await Bun.sleep(300);
  const now = await sentinelState();
  const navigations = flat().filter((e) => e.method === "Page.frameNavigated" && !(e.params.frame as { parentId?: string } | undefined)?.parentId).length;
  const problems: string[] = [];
  if (now.id !== baseline.id) problems.push(`the page's id changed (${String(baseline.id)} → ${String(now.id)})`);
  if (now.origin !== baseline.origin) problems.push("its time origin changed (a new document)");
  if (navigations !== 0) problems.push(`${navigations} top-frame navigation(s)`);
  if (Number(now.ticks) <= Number(baseline.ticks)) problems.push("its closure stopped counting");
  if (now.a !== "agent-typed") problems.push(`the agent's field reads "${String(now.a)}"`);
  if (expect.b !== undefined && now.b !== expect.b) problems.push(`the user's field reads "${String(now.b)}", not "${expect.b}"`);
  if (expect.s !== undefined && now.s !== expect.s) problems.push(`the select reads "${String(now.s)}", not "${expect.s}"`);
  if (now.history !== baseline.history) problems.push(`history length ${String(now.history)} (was ${String(baseline.history)})`);
  if (wsOpens !== 1 || wsCloses !== 0) problems.push(`server: ${wsOpens} WebSocket opening(s), ${wsCloses} close(s)`);
  if (Number(now.wsOpen) !== 1) problems.push(`the page opened its socket ${String(now.wsOpen)} time(s)`);
  if (uploadRequests !== 1 || Number(now.uploads) !== 1) problems.push(`${uploadRequests} upload request(s) at the server, ${String(now.uploads)} started by the page`);
  check(`oracle after ${label}: the same live page, nothing lost`, problems.length === 0,
    problems.join("; ") || `id ${String(now.id).slice(0, 8)}, ticks ${String(now.ticks)}, keys ${String(now.keys)}, ws msgs ${wsMessages}, upload ${uploadDone ? `answered (page: "${String(now.uploadDone)}")` : "in flight"}`);
  allowedCycleChecks.push(label);
}

const report: Record<string, unknown> = { cycles: [] as unknown[] };
const firstFrameMs: number[] = [];
const viewerStats: ViewerEvent[] = [];
const producerStats: Array<Record<string, unknown>> = [];
try {
  const hello = await wait((m) => m.method === "headless.hello", 30_000, "headless.hello");
  linkId = String(hello.params.linkId);
  await command("tab.ensure", { sessionId: "s_proof", tabId: "w-1", url: pageUrl });
  await command("cdp.subscribe", { tabId: "w-1", events: ["Page.frameNavigated", "Page.javascriptDialogOpening", "Page.javascriptDialogClosed"] });
  await cdp("Page.enable");
  await cdp("Runtime.enable");
  for (let i = 0; i < 100 && !(await sentinelState()).id; i++) { world = undefined; await Bun.sleep(100); }
  // The agent types into its field, as an agent would.
  const aBox = await cdp("Runtime.evaluate", { expression: "JSON.stringify(document.getElementById('a').getBoundingClientRect())", contextId: world, returnByValue: true }) as { result?: { value?: string } };
  const ab = JSON.parse(aBox.result?.value ?? "{}") as { x: number; y: number; width: number; height: number };
  for (const type of ["mousePressed", "mouseReleased"]) await cdp("Input.dispatchMouseEvent", { type, x: ab.x + 10, y: ab.y + ab.height / 2, button: "left", clickCount: 1 });
  await cdp("Input.insertText", { text: "agent-typed" });
  await Bun.sleep(300);
  // The baseline: from here on nothing may change but the counters.
  flat().splice(0);
  events.splice(0, events.length, ...events.filter((m) => m.method !== "browserLink.events"));
  baseline = await sentinelState();
  check("the sentinel page is live (its socket open, its upload in progress)", typeof baseline.id === "string" && baseline.wsOpen === 1 && baseline.uploads === 1,
    `id ${String(baseline.id).slice(0, 8)}, history ${String(baseline.history)}`);
  const bBox = JSON.parse(((await cdp("Runtime.evaluate", { expression: "JSON.stringify(document.getElementById('b').getBoundingClientRect())", contextId: world, returnByValue: true })) as { result?: { value?: string } }).result?.value ?? "{}") as { x: number; y: number; height: number };

  // ── the cycles: show, take over, hand back ──
  let userText = "";
  for (let c = 1; c <= cycles; c++) {
    const { viewer, requestedAt } = await present(false);
    await viewer.until("welcome");
    for (const end = Date.now() + 5_000; Date.now() < end && (await viewer.stats()).frames === 0;) await Bun.sleep(50);
    firstFrameMs.push(performance.now() - requestedAt);
    await Bun.sleep(500);
    await command("headless.control", { tabId: "w-1", control: true });
    viewer.send({ cmd: "click", x: bBox.x + 10, y: bBox.y + bBox.height / 2 });
    await Bun.sleep(150);
    viewer.send({ cmd: "key", code: 35, native: 119 });  // End: the caret after what is there
    await Bun.sleep(50);
    viewer.send({ cmd: "type", text: String(c) });
    userText += String(c);
    for (let p = 0; p < 10; p++) { viewer.send({ cmd: "press" }); await Bun.sleep(180); }
    await Bun.sleep(300);
    await command("headless.control", { tabId: "w-1", control: false });
    const vs = await viewer.stats();
    viewerStats.push(vs);
    const ps = await command("headless.unpresent", { tabId: "w-1" });
    producerStats.push(ps);
    await viewer.until("ended", 3_000).catch(() => undefined);
    viewer.send({ cmd: "bye" });
    await viewer.exited();
    (report.cycles as unknown[]).push({ cycle: c, viewer: vs, producer: ps });
    // The marker toggled 10 times per cycle: the user's keys ALSO reached the page as text ("k") — they are the
    // user's own input into their focused field.
    userText += "kkkkkkkkkk";
    await oracle(`cycle ${c} (show → take over → hand back)`, { b: userText });
    // The agent works on the same page between presentations.
    const t = await cdp("Runtime.evaluate", { expression: "document.title", contextId: world, returnByValue: true }) as { result?: { value?: string } };
    if (t.result?.value !== "sentinel") check(`the agent reads the page after cycle ${c}`, false, String(t.result?.value));
  }
  const presses = viewerStats.map((v) => Number(v.inputToPixelCount)).reduce((a, b) => a + b, 0);
  check("every presented frame was read by the viewer, none reused in flight, none out of order",
    viewerStats.every((v) => v.reusedInFlight === 0 && v.outOfOrder === 0 && Number(v.frames) > 0),
    viewerStats.map((v) => `${String(v.frames)}f`).join(" "));
  check("input→pixel measured for the key presses", presses >= cycles * 8, `${presses} of ${cycles * 10}`);
  const ports = producerStats.map((p) => Number(p.taskPorts));
  check("the helper holds no more Mach ports after many presentations than after the first ones (no leaked right)",
    ports.length >= 3 && ports[ports.length - 1]! <= ports[1]! + 8, `port names after each: ${ports.join(" ")}`);

  // ── a scale change mid-presentation: new generations, nothing stale shown ──
  {
    const { viewer } = await present(false);
    await viewer.until("welcome");
    await Bun.sleep(600);
    viewer.send({ cmd: "scale", value: 1 });
    await Bun.sleep(800);
    viewer.send({ cmd: "scale", value: 2 });
    await Bun.sleep(800);
    const vs = await viewer.stats();
    const gens = viewer.events.filter((e) => e.event === "generation");
    const ps = await command("headless.unpresent", { tabId: "w-1" });
    viewer.send({ cmd: "bye" });
    await viewer.exited();
    check("a scale change makes a new pool generation; no frame of a stale one is read",
      Number(vs.pools) >= 3 && vs.reusedInFlight === 0 && gens.length >= 3,
      `${String(vs.pools)} pools, generations ${gens.map((g) => `${String(g.width)}x${String(g.height)}`).join(" → ")}, ${String(vs.staleFrames)} stale frame(s) ignored`);
    report.scaleChange = { viewer: vs, producer: ps };
    await oracle("a scale change");
  }

  // ── a slow viewer: the producer drops, never queues ──
  {
    const { viewer } = await present(false);
    await viewer.until("welcome");
    viewer.send({ cmd: "lag", ms: 250 });
    // Something on the page moving, so frames keep coming (the closure ticks every 100 ms).
    await Bun.sleep(3_000);
    const vs = await viewer.stats();
    const ps = await command("headless.unpresent", { tabId: "w-1" });
    viewer.send({ cmd: "bye" });
    await viewer.exited();
    check("a slow viewer: the producer drops frames rather than queue them (at most 3 in flight)",
      Number(ps.dropped) > 0 && vs.reusedInFlight === 0, `producer ${String(ps.frames)} sent, ${String(ps.dropped)} dropped; viewer read ${String(vs.frames)}`);
    report.slowViewer = { viewer: vs, producer: ps };
  }

  // ── a pending JS dialog across a presentation: answered once, by the agent, after ──
  {
    await cdp("Runtime.evaluate", { expression: "setTimeout(() => { window.answer = confirm('proceed?'); window.answers = (window.answers || 0) + 1; }, 0); 1", contextId: world, returnByValue: true });
    const opened = await wait((m) => m.method === "browserLink.events" && (m.params.events as Array<{ method: string }>).some((e) => e.method === "Page.javascriptDialogOpening"), 5_000, "the dialog").then(() => true, () => false);
    const { viewer } = await present(true);
    await viewer.until("welcome");
    await Bun.sleep(800);
    const vs = await viewer.stats();
    await command("headless.unpresent", { tabId: "w-1" });
    viewer.send({ cmd: "bye" });
    await viewer.exited();
    await cdp("Page.handleJavaScriptDialog", { accept: true });
    await Bun.sleep(300);
    const a = await cdp("Runtime.evaluate", { expression: "JSON.stringify([window.answer, window.answers])", contextId: world, returnByValue: true }) as { result?: { value?: string } };
    check("a dialog pending across a presentation is answered once, after it", opened && a.result?.value === "[true,1]", `opened=${opened}, [answer, answers]=${a.result?.value}, ${String(vs.frames)} frame(s) shown meanwhile`);
    await oracle("a pending dialog", { b: userText });
  }

  // ── a <select> popup, opened and chosen by the user through the presentation ──
  {
    const sBox = JSON.parse(((await cdp("Runtime.evaluate", { expression: "JSON.stringify(document.getElementById('s').getBoundingClientRect())", contextId: world, returnByValue: true })) as { result?: { value?: string } }).result?.value ?? "{}") as { x: number; y: number; height: number };
    const { viewer } = await present(true);
    await viewer.until("welcome");
    await Bun.sleep(300);
    viewer.send({ cmd: "click", x: sBox.x + 10, y: sBox.y + sBox.height / 2 });
    await Bun.sleep(700);
    viewer.send({ cmd: "key", code: 40, native: 125 });  // ArrowDown
    await Bun.sleep(200);
    viewer.send({ cmd: "key", code: 13, native: 36, char: 13 });  // Return
    await Bun.sleep(500);
    const vs = await viewer.stats();
    const ps = await command("headless.unpresent", { tabId: "w-1" });
    viewer.send({ cmd: "bye" });
    await viewer.exited();
    const after = await sentinelState();
    check("a <select> opened and chosen through the presentation", after.s === "two" && Number(vs.frames) > 0,
      `select reads "${String(after.s)}"; viewer ${String(vs.frames)} frame(s), ${String(vs.pools)} pool(s), ${String(vs.staleFrames)} stale; producer ${JSON.stringify(ps)}`);
    await oracle("a select popup", { b: userText, s: "two" });
  }

  // ── a viewer that dies without a word ──
  {
    const { viewer } = await present(true);
    await viewer.until("welcome");
    await Bun.sleep(500);
    const mark = events.length;
    viewer.send({ cmd: "die" });
    await viewer.exited();
    const ended = await wait((m) => m.method === "headless.presentationEnded" && events.indexOf(m) >= mark, 5_000, "headless.presentationEnded").then((m) => String(m.params.reason), () => "");
    check("a viewer that dies: the helper ends the presentation by itself and says so", ended.length > 0, ended);
    await oracle("a dead viewer", { b: userText, s: "two" });
    const again = await present(false);
    await again.viewer.until("welcome");
    await Bun.sleep(400);
    const vs = await again.viewer.stats();
    const ps = await command("headless.unpresent", { tabId: "w-1" });
    again.viewer.send({ cmd: "bye" });
    await again.viewer.exited();
    check("and the tab can be presented again", Number(vs.frames) > 0,
      `viewer ${String(vs.frames)} frame(s), ${String(vs.pools)} pool(s), ${String(vs.staleFrames)} stale; producer ${JSON.stringify(ps)}`);
  }

  // ── the upload that was in flight through all of it: answered once, to the same page ──
  for (const end = Date.now() + 45_000; Date.now() < end && !(await sentinelState()).uploadDone;) await Bun.sleep(500);
  {
    const now = await sentinelState();
    check("the upload in flight through the presentations was sent once and answered to the same page",
      uploadRequests === 1 && uploadBytes === 4 * 1024 * 1024 && now.uploadDone === `received ${4 * 1024 * 1024}` && now.id === baseline.id,
      `${uploadRequests} request(s), ${uploadBytes} bytes; the page read "${String(now.uploadDone)}"`);
  }

  // ── a viewer that is not the one the daemon named ──
  {
    const nonce = nonceHex();
    const r = await command("headless.present", { tabId: "w-1", nonce, viewerRequirement: 'identifier "com.example.not-winter"', control: true, scale: 2 });
    const impostor = new ViewerProc(String(r.service), nonce);
    await Bun.sleep(1_500);
    const vs = await impostor.stats().catch(() => ({ event: "stats", frames: -1 } as ViewerEvent));
    await command("headless.unpresent", { tabId: "w-1" });
    impostor.send({ cmd: "bye" });
    await impostor.exited();
    check("a viewer that does not satisfy the named requirement gets no frame", Number(vs.frames) === 0, `${String(vs.frames)} frame(s)`);
  }
} catch (err) {
  check("the run", false, err instanceof Error ? err.message : String(err));
} finally {
  toHelper.end();
  const timer = setTimeout(() => proc.kill("SIGKILL"), 5_000);
  await new Promise((r) => proc.on("exit", r));
  clearTimeout(timer);
  server.stop(true);
  const all = (key: string) => viewerStats.map((v) => Number(v[key])).filter((n) => n >= 0);
  const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s.length === 0 ? -1 : s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))]!; };
  const summary = {
    firstFrameMs: { p50: pct(firstFrameMs, 0.5), max: Math.max(...firstFrameMs, -1) },
    inputToPixelMsP50PerCycle: all("inputToPixelP50"), inputToPixelMsP95PerCycle: all("inputToPixelP95"), inputToPixelMsP99PerCycle: all("inputToPixelP99"),
    frameAgeMsP50PerCycle: all("frameAgeP50"), frameAgeMsP95PerCycle: all("frameAgeP95"),
    copyMsP50: producerStats.map((p) => Number(p.copyP50Ms)), copyMsP99: producerStats.map((p) => Number(p.copyP99Ms)), copyMsMax: producerStats.map((p) => Number(p.copyMaxMs)),
  };
  report.summary = summary;
  console.log(`INFO ${JSON.stringify(summary)}`);
  const reportFile = arg("--report");
  if (reportFile !== undefined) writeFileSync(reportFile, `${JSON.stringify({ results, report }, null, 2)}\n`);
  if (!process.argv.includes("--keep")) rmSync(work, { recursive: true, force: true });
  const failed = results.filter(([, ok]) => !ok).length;
  console.log(`${results.length - failed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}
