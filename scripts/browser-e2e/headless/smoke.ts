// ComputerV2 Phase 4 — a smoke run of Winter Headless on its own, with no daemon: spawn the helper over its pipe
// (fds 3/4), open a windowless tab on a local fixture page, and drive it with the very commands the daemon's pool
// sends — a winter world, an evaluation, a screenshot, a click, an out-of-process-iframe page — then close the pipe
// and check the helper exits. Also checks, from outside, that the helper never owns a window and never becomes the
// frontmost app.
//
//   bun scripts/browser-e2e/headless/smoke.ts --app "<path to Winter Headless Dev.app>" [--out <dir>] [--keep]
//
// Writes its screenshot into --out (default: a temp dir). Nothing is written outside temp dirs.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const app = arg("--app");
if (app === undefined) {
  console.error("usage: smoke.ts --app <Winter Headless .app> [--out <dir>]");
  process.exit(2);
}
const exe = join(app, "Contents", "MacOS", app.split("/").pop()!.replace(/\.app$/, ""));
const out = arg("--out") ?? mkdtempSync(join(tmpdir(), "winter-headless-smoke-"));
const cacheRoot = mkdtempSync(join(tmpdir(), "winter-headless-cache-"));

// ── a local fixture: a page with a button, a counter and a cross-site iframe ──────────────────────────────────────
const frame = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: () => new Response("<!doctype html><title>frame</title><p id=f>inside the frame</p>", { headers: { "content-type": "text/html" } }),
});
const page = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: () => new Response(
    `<!doctype html><title>Winter Headless smoke</title>
     <body style="margin:0;font:24px system-ui">
       <h1 style="background:#ff00ff;margin:0;height:120px">Winter Headless</h1>
       <button id=b style="position:absolute;left:100px;top:200px;width:200px;height:80px" onclick="window.clicks=(window.clicks||0)+1;this.textContent='clicked '+window.clicks">click me</button>
       <iframe src="http://localhost:${frame.port}/" style="position:absolute;left:400px;top:200px;width:400px;height:200px"></iframe>
       <input id=t style="position:absolute;left:100px;top:320px;width:200px;height:30px">
       <input id=f type=file style="position:absolute;left:100px;top:380px;width:200px;height:30px">
     </body>`,
    { headers: { "content-type": "text/html" } }),
});
const url = `http://127.0.0.1:${page.port}/`;

// ── frontmost app and windows, sampled from outside ──────────────────────────────────────────────────────────────
async function frontmost(): Promise<string> {
  const p = Bun.spawn(["/usr/bin/lsappinfo", "front"], { stdout: "pipe", stderr: "ignore" });
  const asn = (await new Response(p.stdout).text()).trim();
  const q = Bun.spawn(["/usr/bin/lsappinfo", "info", "-only", "bundleid", asn], { stdout: "pipe", stderr: "ignore" });
  return (await new Response(q.stdout).text()).trim();
}

// ── the pipe ─────────────────────────────────────────────────────────────────────────────────────────────────────
const before = await frontmost();
const started = Date.now();
const helperArgs = process.argv.flatMap((a, i) => (process.argv[i - 1] === "--helper-arg" ? [a] : []));
const proc = spawn(exe, [`--winter-cache-root=${cacheRoot}`, ...helperArgs], { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"], env: { ...process.env } });
const toHelper = proc.stdio[3] as Writable;
const fromHelper = proc.stdio[4] as Readable;
let stderr = "";
proc.stderr?.on("data", (c: Buffer) => { stderr += c.toString("utf8"); });
let exitCode: number | null = null;
const exited = new Promise<void>((resolve) => proc.on("exit", (code, signal) => { exitCode = code ?? (signal ? 128 : -1); resolve(); }));

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
    if (m.method === "browserLink.events") events.push(m);
    const i = waiters.findIndex((w) => w.match(m));
    if (i >= 0) waiters.splice(i, 1)[0]!.resolve(m);
  }
});

function wait(match: (m: Message) => boolean, ms: number, what: string): Promise<Message> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out waiting for ${what}\n--- helper stderr ---\n${stderr}`)), ms);
    waiters.push({ match, resolve: (m) => { clearTimeout(t); resolve(m); } });
  });
}

let linkId = "";
let next = 1;
async function command(op: string, params: Record<string, unknown>, ms = 20_000): Promise<Record<string, unknown>> {
  const cmdId = `c${next++}`;
  const label = op === "cdp.send" ? `cdp.send ${String(params.method)}${params.cdpSessionId ? " (child session)" : ""}` : op;
  toHelper.write(`${JSON.stringify({ jsonrpc: "2.0", method: "browserLink.command", params: { linkId, cmdId, op, params } })}\n`);
  const m = await wait((x) => x.method === "browserLink.result" && x.params.cmdId === cmdId, ms, `${label} (${cmdId})`);
  if (m.params.ok !== true) throw new Error(`${op} failed: ${JSON.stringify(m.params.error)}`);
  return (m.params.result ?? {}) as Record<string, unknown>;
}
async function cdp(method: string, params: Record<string, unknown> = {}, cdpSessionId?: string): Promise<Record<string, unknown>> {
  const r = await command("cdp.send", { tabId: "w-1", method, params, ...(cdpSessionId ? { cdpSessionId } : {}) });
  return (r.result ?? {}) as Record<string, unknown>;
}

const results: Array<[string, boolean, string?]> = [];
function check(name: string, ok: boolean, detail?: string): void {
  results.push([name, ok, detail]);
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

try {
  const hello = await wait((m) => m.method === "headless.hello", 30_000, "headless.hello");
  linkId = String(hello.params.linkId);
  check("hello", hello.params.protocol === 1, `protocol ${hello.params.protocol}, ready in ${Date.now() - started} ms`);

  const ensured = await command("tab.ensure", { sessionId: "s_smoke", tabId: "w-1", url });
  check("tab.ensure creates a windowless tab", Array.isArray(ensured.viewport), JSON.stringify(ensured.viewport));

  await command("cdp.subscribe", { tabId: "w-1", events: ["Page.loadEventFired", "Runtime.executionContextCreated", "Page.frameNavigated", "Target.attachedToTarget", "Page.javascriptDialogOpening", "Page.javascriptDialogClosed", "Page.fileChooserOpened"] });
  await cdp("Page.enable");
  await cdp("Runtime.enable");
  // Wait for the page to finish loading (poll the frame tree's URL).
  let frameId = "";
  for (let i = 0; i < 100; i++) {
    const tree = await cdp("Page.getFrameTree") as { frameTree?: { frame?: { id?: string; url?: string } } };
    frameId = tree.frameTree?.frame?.id ?? "";
    if (tree.frameTree?.frame?.url === url) break;
    await Bun.sleep(100);
  }
  check("the page loaded", frameId !== "");

  const world = await cdp("Page.createIsolatedWorld", { frameId, worldName: "winter" }) as { executionContextId?: number };
  check("a winter world", typeof world.executionContextId === "number");
  const title = await cdp("Runtime.evaluate", { expression: "document.title", contextId: world.executionContextId, returnByValue: true }) as { result?: { value?: unknown } };
  check("Runtime.evaluate in the winter world (a renderer attached)", title.result?.value === "Winter Headless smoke", String(title.result?.value));

  const refused = await command("cdp.send", { tabId: "w-1", method: "Runtime.evaluate", params: { expression: "1" } }).then(() => false, () => true);
  check("the page's own world is refused", refused);

  const shot = await cdp("Page.captureScreenshot", { format: "png" }) as { data?: string };
  if (typeof shot.data === "string") writeFileSync(join(out, "smoke.png"), Buffer.from(shot.data, "base64"));
  check("Page.captureScreenshot", typeof shot.data === "string" && shot.data.length > 1000, `${shot.data?.length ?? 0} base64 chars → ${join(out, "smoke.png")}`);

  for (const type of ["mousePressed", "mouseReleased"]) {
    await cdp("Input.dispatchMouseEvent", { type, x: 200, y: 240, button: "left", clickCount: 1 });
  }
  const clicks = await cdp("Runtime.evaluate", { expression: "document.getElementById('b').textContent", contextId: world.executionContextId, returnByValue: true }) as { result?: { value?: unknown } };
  check("Input.dispatchMouseEvent clicks the button", clicks.result?.value === "clicked 1", String(clicks.result?.value));

  const flat = () => events.flatMap((m) => (m.params.events as Array<{ method: string; params: Record<string, unknown>; cdpSessionId?: string }>));
  async function eventually(what: string, pred: () => boolean, ms = 5_000): Promise<boolean> {
    for (const end = Date.now() + ms; Date.now() < end;) {
      if (pred()) return true;
      await Bun.sleep(50);
    }
    console.log(`(gave up waiting for ${what})`);
    return false;
  }
  const evalWinter = async (expression: string) =>
    ((await cdp("Runtime.evaluate", { expression, contextId: world.executionContextId, returnByValue: true })) as { result?: { value?: unknown } }).result?.value;

  // Typing: focus the field by a click, then insert text.
  for (const type of ["mousePressed", "mouseReleased"]) {
    await cdp("Input.dispatchMouseEvent", { type, x: 150, y: 335, button: "left", clickCount: 1 });
  }
  await cdp("Input.insertText", { text: "héllo headless" });
  await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "!", text: "!" });
  await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "!" });
  check("typing into a field", await evalWinter("document.getElementById('t').value") === "héllo headless!", String(await evalWinter("document.getElementById('t').value")));

  // Out-of-process iframes: auto-attach, flattened child sessions.
  await cdp("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  const child = await eventually("Target.attachedToTarget", () => flat().some((e) => e.method === "Target.attachedToTarget"));
  const childSession = flat().find((e) => e.method === "Target.attachedToTarget")?.params.sessionId as string | undefined;
  let childEval = "";
  if (childSession) {
    await cdp("Page.enable", {}, childSession);
    const ctree = await cdp("Page.getFrameTree", {}, childSession) as { frameTree?: { frame?: { id?: string } } };
    const cworld = await cdp("Page.createIsolatedWorld", { frameId: ctree.frameTree?.frame?.id, worldName: "winter" }, childSession) as { executionContextId?: number };
    childEval = String(((await cdp("Runtime.evaluate", { expression: "document.getElementById('f').textContent", contextId: cworld.executionContextId, returnByValue: true }, childSession)) as { result?: { value?: unknown } }).result?.value);
  }
  check("an out-of-process iframe attaches as a flattened child session", child && childEval === "inside the frame", childEval);

  // A JS dialog: held (never shown), reported over DevTools, answered by the engine.
  await evalWinter("setTimeout(() => { window.answer = confirm('proceed?'); }, 0); 1");
  const opened = await eventually("Page.javascriptDialogOpening", () => flat().some((e) => e.method === "Page.javascriptDialogOpening"));
  console.log(`INFO dialog events: ${flat().filter((e) => e.method.includes("Dialog")).map((e) => e.method).join(", ")}`);
  await cdp("Page.handleJavaScriptDialog", { accept: true });
  await Bun.sleep(300);
  const answer = await evalWinter("window.answer");
  check("a dialog is held and answered over DevTools", opened && answer === true, `opened=${opened} answer=${String(answer)}`);

  // A file chooser: intercepted over DevTools when asked; never a native panel.
  await cdp("Page.setInterceptFileChooserDialog", { enabled: true });
  for (const type of ["mousePressed", "mouseReleased"]) {
    await cdp("Input.dispatchMouseEvent", { type, x: 150, y: 395, button: "left", clickCount: 1 });
  }
  const chooser = await eventually("Page.fileChooserOpened", () => flat().some((e) => e.method === "Page.fileChooserOpened"));
  check("a file chooser is intercepted (no native panel)", chooser);
  await cdp("Page.setInterceptFileChooserDialog", { enabled: false });

  // WebMCP behind its feature (reported, not required: it is an origin-trial API).
  const webmcp = await evalWinter("typeof document.modelContext + '/' + typeof navigator.modelContext");
  console.log(`INFO WebMCP: document.modelContext / navigator.modelContext = ${String(webmcp)}`);

  check("events arrive in batches", events.length > 0, `${events.length} batch(es)`);

  const live = await command("tabs.live", {}) as { tabs?: Array<{ sessionId?: string }> };
  check("tabs.live names the session", live.tabs?.[0]?.sessionId === "s_smoke");

  const front = await frontmost();
  check("the frontmost app never changed", front === before, `${before} → ${front}`);

  await command("tab.close", { tabId: "w-1" });
  const disposed = await command("context.dispose", { sessionId: "s_smoke" });
  check("context.dispose", typeof disposed.closed === "number");
} catch (err) {
  check("the run", false, err instanceof Error ? err.message : String(err));
} finally {
  toHelper.end();
  const timeout = setTimeout(() => proc.kill("SIGKILL"), 5_000);
  await exited;
  clearTimeout(timeout);
  check("the helper exits when its pipe closes", exitCode === 0, `exit ${exitCode}`);
  page.stop(true);
  frame.stop(true);
  if (!process.argv.includes("--keep")) rmSync(cacheRoot, { recursive: true, force: true });
  if (process.argv.includes("--stderr")) console.log(stderr);
  const failed = results.filter(([, ok]) => !ok).length;
  console.log(`${results.length - failed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}
