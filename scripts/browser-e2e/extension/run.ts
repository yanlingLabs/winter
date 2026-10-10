/**
 * Winter for Chrome, end to end (opt-in):
 *
 *   WINTER_BROWSER_E2E=1 WINTER_TEST_CHROME=<Chrome for Testing .app or binary> bun run scripts/browser-e2e/extension/run.ts
 *   (also reached as `bun run e2e:browser -- --extension` once lane B's runner dispatches here)
 *
 * The real pieces, nothing of the user's: the dev build of the extension (built into a temp dir), a TEST build of
 * winter-browser-host (`swift build -DWINTER_CU_TEST_BUILD`, signed as com.winter.browserhost.test), a temp-home
 * daemon in this process with a file secret store, and Chrome for Testing — headless, a temp `--user-data-dir` whose OWN
 * `NativeMessagingHosts/` carries the host manifest — against the fixture pages in `fixture/`. It never touches the
 * user's browsers, profiles or `~/Library/Application Support/*\/NativeMessagingHosts`, and downloads nothing.
 *
 * The daemon's `browserHost` test seam stands in for the engine's registry (lane B's) and names the test host's identity;
 * the host's pid is checked with the daemon's real Security.framework check. The engine is not involved: the run drives
 * the registered `ExtensionTransport` directly — which is exactly the contract between the two.
 *
 * Writes its report to out/browser-e2e/extension-report.json. Exit 0 = every check passed.
 */
import "../../../packages/core/test/preload";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WINTER_TEAM_ID } from "../../../packages/core/src/auth/app-token-acl";
import { FileSecretStore } from "../../../packages/core/src/auth/secret-store";
import { allowedOrigins, EXTENSION_IDS, NATIVE_HOST_NAME } from "../../../packages/core/src/computer-use/browser/extension/extension-ids";
import { hostManifest, writeManifestInto } from "../../../packages/core/src/computer-use/browser/extension/manifest";
import type { BackendId, BackendRegistry, BrowserBackendInfo, BrowserFamily, CdpEvent, CdpTransport } from "../../../packages/core/src/computer-use/browser/transport";
import { startDaemon, type RunningDaemon } from "../../../packages/core/src/daemon";
import { build as buildExtension } from "../../../extensions/winter-for-chrome/scripts/build";
import { helperRequirement } from "../../computer-helper-lib";

const REPO = join(import.meta.dir, "..", "..", "..");
const OUT = join(REPO, "out", "browser-e2e");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── the report ────────────────────────────────────────────────────────────────────────────────────────────────────────

const results: { ok: boolean; what: string; detail?: string }[] = [];
const facts: Record<string, unknown> = {};
function check(ok: boolean, what: string, detail?: unknown): boolean {
  const d = detail === undefined ? undefined : typeof detail === "string" ? detail : JSON.stringify(detail);
  results.push({ ok, what, ...(d === undefined ? {} : { detail: d }) });
  console.error(`${ok ? "  ok  " : "  FAIL"} ${what}${!ok && d ? `\n         ${d.slice(0, 600)}` : ""}`);
  return ok;
}
async function code(p: Promise<unknown>): Promise<string> {
  try { await p; return "ok"; } catch (err) { return (err as { code?: string }).code ?? `untyped: ${String(err)}`; }
}
async function waitFor<T>(get: () => T | undefined, ms: number): Promise<T | undefined> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = get();
    if (v !== undefined) return v;
    if (Date.now() > deadline) return undefined;
    await sleep(50);
  }
}

// ── a registry with the pinned contract (lane B builds the real one) ──────────────────────────────────────────────────

class E2ERegistry implements BackendRegistry {
  private readonly ids = new Map<string, BackendId>();
  private readonly entries = new Map<BackendId, { transport: CdpTransport; info: { family: BrowserFamily; name: string; bundleId?: string }; token: number }>();
  private readonly listeners = new Set<() => void>();
  private token = 0;
  readonly unavailable: string[] = [];
  register(transport: CdpTransport, info: { family: BrowserFamily; name: string; bundleId?: string; instanceKey: string }) {
    const key = `${info.family}/${info.instanceKey}`;
    let id = this.ids.get(key);
    if (id === undefined) {
      const n = [...this.ids.values()].filter((v) => v === info.family || v.startsWith(`${info.family}#`)).length + 1;
      id = n === 1 ? info.family : `${info.family}#${n}`;
      this.ids.set(key, id);
    }
    const token = ++this.token;
    this.entries.set(id, { transport, info, token });
    for (const l of this.listeners) l();
    const bound = id;
    return { id: bound, unregister: () => { if (this.entries.get(bound)?.token === token) { this.entries.delete(bound); for (const l of this.listeners) l(); } } };
  }
  noteUnavailable(info: { reason: string }) { this.unavailable.push(info.reason); }
  get(id: BackendId) { return this.entries.get(id)?.transport; }
  list(): BrowserBackendInfo[] {
    return [...this.entries].map(([id, e]) => ({ id, family: e.info.family, name: e.info.name, ...(e.info.bundleId === undefined ? {} : { bundleId: e.info.bundleId }), connected: e.transport.connected }));
  }
  onChange(l: () => void) { this.listeners.add(l); return () => { this.listeners.delete(l); }; }
}

// ── the browser's own DevTools endpoint (the temp profile's), to reach the extension's service worker ─────────────────

class BrowserCdp {
  private next = 1;
  private readonly waiting = new Map<number, { resolve(v: any): void; reject(e: Error): void }>();
  private constructor(private readonly ws: WebSocket) {
    ws.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data)) as { id?: number; result?: unknown; error?: { message: string } };
      if (m.id === undefined) return;
      const w = this.waiting.get(m.id);
      this.waiting.delete(m.id);
      if (m.error !== undefined) w?.reject(new Error(m.error.message)); else w?.resolve(m.result);
    };
  }
  static async connect(profile: string): Promise<BrowserCdp> {
    const file = join(profile, "DevToolsActivePort");
    const text = await waitFor(() => (existsSync(file) ? readFileSync(file, "utf8") : undefined), 20_000);
    const [port, path] = (text ?? "").trim().split("\n");
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
    await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error("no DevTools endpoint")); });
    return new BrowserCdp(ws);
  }
  send<T = any>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    const id = this.next++;
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }));
    return new Promise<T>((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      setTimeout(() => { if (this.waiting.delete(id)) reject(new Error(`${method} timed out`)); }, 10_000);
    });
  }
  private async worker(): Promise<{ targetId: string } | undefined> {
    const extensionUrl = `chrome-extension://${EXTENSION_IDS.dev[0]}/`;
    const { targetInfos } = await this.send<{ targetInfos: { targetId: string; type: string; url: string }[] }>("Target.getTargets");
    return targetInfos.find((x) => x.type === "service_worker" && x.url.startsWith(extensionUrl));
  }
  /** Stops Winter for Chrome's service worker. */
  async stopWorker(): Promise<boolean> {
    const sw = await this.worker();
    if (sw === undefined) return false;
    const r = await this.send<{ success: boolean }>("Target.closeTarget", { targetId: sw.targetId });
    return r.success;
  }
  /** Opens and closes a tab — in a window of its own, so closing it activates nothing in the user's window: an event the
   *  stopped worker listens to (`tabs.onRemoved`) starts it again. */
  async wakeWithTabEvent(): Promise<void> {
    const { targetId } = await this.send<{ targetId: string }>("Target.createTarget", { url: "about:blank", newWindow: true, background: true });
    await sleep(500);
    await this.send("Target.closeTarget", { targetId });
  }
  /** Runs `expression` in Winter for Chrome's service worker and returns its value. */
  async inWorker<T>(expression: string): Promise<T | undefined> {
    const extensionUrl = `chrome-extension://${EXTENSION_IDS.dev[0]}/`;
    let sw: { targetId: string } | undefined;
    for (let i = 0; i < 100 && sw === undefined; i++) {
      const { targetInfos } = await this.send<{ targetInfos: { targetId: string; type: string; url: string }[] }>("Target.getTargets");
      sw = targetInfos.find((x) => x.type === "service_worker" && x.url.startsWith(extensionUrl));
      if (sw === undefined) await sleep(100);
    }
    if (sw === undefined) throw new Error("Winter for Chrome's service worker is not running");
    const { sessionId } = await this.send<{ sessionId: string }>("Target.attachToTarget", { targetId: sw.targetId, flatten: true });
    try {
      const r = await this.send<{ result: { value?: T } }>("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
      return r.result.value;
    } finally {
      await this.send("Target.detachFromTarget", { sessionId }).catch(() => undefined);
    }
  }
  close(): void { this.ws.close(); }
}

// ── building the pieces ───────────────────────────────────────────────────────────────────────────────────────────────

function run(cmd: string, args: string[], opts: { cwd?: string } = {}) {
  const r = spawnSync(cmd, args, { cwd: opts.cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** The team identity, if this Mac has one (the dev daemon's rule); else ad-hoc. */
async function signingHash(): Promise<string> {
  try {
    const { signingIdentity } = await import("../../dev-helper");
    return signingIdentity().hash;
  } catch {
    return "-";
  }
}

/** A test build of winter-browser-host, signed as com.winter.browserhost.test; returns its path and requirement. */
async function buildTestHost(dir: string): Promise<{ path: string; requirement: string }> {
  const scratch = join(OUT, "host-build");
  const log = join(OUT, "host-build.log");
  console.error(`browser-e2e: building the test host (swift build, log: ${log})…`);
  const built = spawnSync("/bin/sh", ["-c", `swift build --package-path '${join(REPO, "apple", "ComputerUse", "WinterBrowserHost")}' --scratch-path '${scratch}' -c debug -Xswiftc -DWINTER_CU_TEST_BUILD --product winter-browser-host > '${log}' 2>&1`]);
  const product = join(scratch, "debug", "winter-browser-host");
  if (built.status !== 0 || !existsSync(product)) throw new Error(`swift build failed (exit ${built.status}); see ${log}`);
  const path = join(dir, "winter-browser-host");
  copyFileSync(product, path);
  const hash = await signingHash();
  const stated = helperRequirement("com.winter.browserhost.test", WINTER_TEAM_ID);
  const args = ["--force", "--sign", hash, "--identifier", "com.winter.browserhost.test", "--options", "runtime", "--timestamp=none"];
  if (hash !== "-") args.push(`-r=designated => ${stated}`);
  const signed = run("codesign", [...args, path]);
  if (signed.status !== 0) throw new Error(`codesign failed: ${signed.stderr}`);
  const requirement = hash === "-" ? (/^designated => (.+)$/m.exec(run("codesign", ["-d", "-r-", path]).stdout)?.[1]?.trim() ?? "never") : stated;
  facts.hostSigning = hash === "-" ? "ad-hoc" : "Winter's team";
  return { path, requirement };
}

function chromeBinary(): string {
  const raw = process.env.WINTER_TEST_CHROME ?? "";
  if (raw.endsWith(".app")) {
    const plist = run("plutil", ["-extract", "CFBundleExecutable", "raw", "-o", "-", join(raw, "Contents", "Info.plist")]).stdout.trim();
    return join(raw, "Contents", "MacOS", plist);
  }
  return raw;
}

function serve(dir: string, onRequest: (path: string) => void) {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      onRequest(path);
      if (path === "/ping") return new Response("pong");
      const file = join(dir, path.replace(/^\/+/, "") || "page.html");
      if (!file.startsWith(dir) || !existsSync(file)) return new Response("not found", { status: 404 });
      return new Response(readFileSync(file), { headers: { "content-type": "text/html; charset=utf-8" } });
    },
  });
}

// ── the run ───────────────────────────────────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const exe = chromeBinary();
  if (!existsSync(exe)) throw new Error(`WINTER_TEST_CHROME (${process.env.WINTER_TEST_CHROME}) is not Chrome for Testing`);
  facts.chrome = run(exe, ["--version"]).stdout.trim();
  mkdirSync(OUT, { recursive: true });
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wfc-e2e-")));
  const home = join(root, "home");
  const profile = join(root, "profile");
  mkdirSync(home, { recursive: true });
  mkdirSync(profile, { recursive: true });
  let chrome: ChildProcess | undefined;
  let daemon: RunningDaemon | undefined;
  const requests: string[] = [];
  const server = serve(join(import.meta.dir, "fixture"), (p) => requests.push(p));
  const base = `http://127.0.0.1:${server.port}`;
  const crossSite = `http://localhost:${server.port}/frame.html`;
  try {
    const [extensionDir] = await buildExtension(["dev"], join(root, "extension"));
    const host = await buildTestHost(root);
    writeManifestInto(join(profile, "NativeMessagingHosts"), hostManifest({ name: NATIVE_HOST_NAME.dev, path: host.path, allowedOrigins: allowedOrigins(EXTENSION_IDS.dev) }));
    const bunDr = /^designated => (.+)$/m.exec(run("codesign", ["-d", "-r-", process.execPath]).stdout)?.[1]?.trim() ?? "always";

    const boot = async (registry: E2ERegistry) => startDaemon({
      home,
      secrets: new FileSecretStore(join(home, "test-secrets")),
      agentProvider: null,
      browserHost: { registry, allowedExtensionIds: EXTENSION_IDS.dev, hostRequirement: host.requirement },
    });
    let registry = new E2ERegistry();
    daemon = await boot(registry);
    check(existsSync(join(home, "run", "browser.sock")), "the daemon listens on <home>/run/browser.sock");

    // Chrome for Testing, headless, a temp profile; the user's own tab first.
    const chromeLog: string[] = [];
    chrome = spawn(exe, [
      "--headless=new", `--user-data-dir=${profile}`, `--load-extension=${extensionDir}`, "--no-first-run", "--no-default-browser-check",
      "--disable-gpu", "--window-size=1200,900", "--force-device-scale-factor=2", "--remote-debugging-port=0", `${base}/user.html`,
    ], {
      env: { ...process.env, WINTER_BROWSER_HOST_HOME: home, WINTER_CU_TEST_DAEMON_REQUIREMENT: bunDr },
      stdio: ["ignore", "ignore", "pipe"],
    });
    chrome.stderr?.setEncoding("utf8");
    chrome.stderr?.on("data", (d: string) => chromeLog.push(...d.split("\n").filter((l) => l.includes("winter-browser-host") || l.includes("[winter]") || /extension|service.?worker/i.test(l))));

    const t = await waitFor(() => { const x = registry.get("chrome"); return x?.connected === true ? x : undefined; }, 30_000);
    if (!check(t !== undefined, "the extension's hello registers a transport: chrome for Chrome for Testing (the host verified by its pid)", chromeLog.slice(-5).join(" | "))) return;
    let transport = t!;
    const browserCdp = await BrowserCdp.connect(profile);
    const groupTitles = async () => (await browserCdp.inWorker<string[]>("chrome.tabGroups.query({}).then((gs) => gs.map((g) => g.title))")) ?? [];
    check(registry.list()[0]?.bundleId === "com.google.chrome.for.testing", "registered with the browser's bundle id", registry.list());

    // The user's tab is the active one, and nobody else's.
    let userTab = (await transport.listTabs()).find((x) => x.url.endsWith("/user.html"));
    for (let i = 0; i < 50 && userTab === undefined; i++) {
      await sleep(100);
      userTab = (await transport.listTabs()).find((x) => x.url.endsWith("/user.html"));
    }
    check(userTab !== undefined && userTab.active && !userTab.agent, "tabs.list: the user's tab, active, not Winter's", userTab ?? await transport.listTabs());

    // ── an agent tab, in the background ──
    const tab = await transport.createTab({ sessionId: "s_e2e", sessionTitle: "Winter for Chrome e2e", url: `${base}/page.html?frame=${encodeURIComponent(crossSite)}` });
    check(tab.agent && tab.sessionId === "s_e2e" && !tab.active, "createTab: an agent tab of the session, opened in the background", tab);
    const events: CdpEvent[] = [];
    transport.onEvent((e) => { if (e.tabKey === tab.tabKey) events.push(e); });
    const gone: string[] = [];
    transport.onTabGone((k, r) => gone.push(`${k}:${r}`));

    const attached = await transport.attach(tab.tabKey, { sessionId: "s_e2e" });
    facts.attach = attached;
    check(attached.viewport[0] > 0 && attached.viewport[1] > 0 && attached.dpr === 2, "attach: the CSS viewport and the device pixel ratio (forced to 2)", attached);
    await transport.subscribe(tab.tabKey, ["Page.frameNavigated", "Page.loadEventFired", "Runtime.executionContextCreated", "Network.requestWillBeSent", "Target.attachedToTarget", "Page.javascriptDialogOpening"]);
    await transport.send(tab.tabKey, "Page.enable");
    await transport.send(tab.tabKey, "Runtime.enable");
    await transport.send(tab.tabKey, "Network.enable");
    await transport.send(tab.tabKey, "Page.reload", { ignoreCache: true });
    await waitFor(() => events.find((e) => e.method === "Page.loadEventFired"), 10_000);

    const tree = await transport.send<{ frameTree: { frame: { id: string } } }>(tab.tabKey, "Page.getFrameTree");
    const frameId = tree.frameTree.frame.id;
    const world = await transport.send<{ executionContextId: number }>(tab.tabKey, "Page.createIsolatedWorld", { frameId, worldName: "winter" });
    const evalIn = <T>(expression: string, contextId = world.executionContextId, cdpSessionId?: string) =>
      transport.send<{ result: { value?: T; objectId?: string } }>(tab.tabKey, "Runtime.evaluate", { contextId, expression, returnByValue: true }, cdpSessionId === undefined ? {} : { cdpSessionId });
    const title = await evalIn<string>("document.title");
    check(title.result.value === "Winter e2e page", "Runtime.evaluate in the \"winter\" world reads the page", title);

    // The world rules and the allowlist, enforced by the extension itself (raw requests past the daemon's own check).
    const raw = (method: string, params: Record<string, unknown>) =>
      (transport as unknown as { request(m: string, p: Record<string, unknown>, t: number): Promise<unknown> }).request("cdp.send", { tabKey: tab.tabKey, method, params }, 10_000);
    const mainWorld = events.findLast((e) => e.method === "Runtime.executionContextCreated" && (e.params.context as { auxData?: { isDefault?: boolean } })?.auxData?.isDefault === true);
    const mainId = (mainWorld?.params.context as { id?: number } | undefined)?.id;
    check(mainId !== undefined, "the page's main-world context is announced (subscribed)");
    check(await code(evalIn("document.cookie", mainId)) === "not_allowed", "the extension refuses Runtime.evaluate in the page's main world");
    check(await code(transport.send(tab.tabKey, "Runtime.evaluate", { expression: "1" })) === "not_allowed", "…and without a contextId");
    check(await code(transport.send(tab.tabKey, "Page.createIsolatedWorld", { frameId, worldName: "main" })) === "not_allowed", "…and a world not named \"winter\"");
    check(await code(raw("Network.getCookies", {})) === "not_allowed", "…and a method outside the allowlist (Network.getCookies), sent straight past the daemon");
    check(await code(raw("Storage.getCookies", {})) === "not_allowed", "…Storage.getCookies too");
    check(await code(raw("Page.addScriptToEvaluateOnNewDocument", { source: "1" })) === "not_allowed", "…and Page.addScriptToEvaluateOnNewDocument");
    check(await code(raw("Page.reload", { scriptToEvaluateOnLoad: "document.title = 'pwned'" })) === "not_allowed", "…and Page.reload with a script for the page's own world");
    check(await code(raw("Page.navigate", { url: "javascript:document.title='pwned'" })) === "not_allowed", "…and Page.navigate to a javascript: URL");
    check(await code(raw("Page.navigate", { url: "file:///etc/hosts" })) === "not_allowed", "…and to a file: URL");
    const titleAfter = await evalIn<string>("document.title");
    check(titleAfter.result.value === "Winter e2e page", "…none of which ran", titleAfter.result.value);

    // Network events arrive reduced.
    const net = events.filter((e) => e.method === "Network.requestWillBeSent");
    check(net.length > 0 && net.every((e) => Object.keys(e.params).every((k) => ["requestId", "timestamp", "type"].includes(k))), "Network events arrive reduced to requestId, timestamp, type", net[0]?.params);

    // Input in the background tab, through Input.* (never the OS pointer).
    const box = await evalIn<{ x: number; y: number }>("(() => { const r = document.getElementById('count').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()");
    const at = box.result.value!;
    transport.overlay(tab.tabKey, { active: true, cursor: { x: at.x, y: at.y, kind: "press" } });
    for (const type of ["mousePressed", "mouseReleased"]) {
      await transport.send(tab.tabKey, "Input.dispatchMouseEvent", { type, x: at.x, y: at.y, button: "left", clickCount: 1 });
    }
    const clicks = await evalIn<string>("document.body.dataset.clicks");
    check(clicks.result.value === "1", "a click through Input.dispatchMouseEvent lands in the background tab", clicks);
    await transport.send(tab.tabKey, "DOM.enable");
    const notes = await evalIn<string>("(() => { document.getElementById('notes').focus(); return document.activeElement?.id; })()");
    await transport.send(tab.tabKey, "Input.insertText", { text: "typed by Winter" });
    const typed = await evalIn<string>("document.getElementById('notes').value");
    check(notes.result.value === "notes" && typed.result.value === "typed by Winter", "focus (with focus emulation) and Input.insertText type into the background tab", { focused: notes.result.value, typed: typed.result.value });

    // The overlay: one element, in a closed shadow root, drawn by the extension's isolated world.
    await sleep(500);
    const overlay = await evalIn<{ present: boolean; shadow: boolean }>("(() => { const el = document.querySelector('winter-agent-overlay'); return { present: el !== null, shadow: el !== null && el.shadowRoot === null }; })()");
    check(overlay.result.value?.present === true && overlay.result.value?.shadow === true, "the overlay is drawn: one <winter-agent-overlay>, its shadow root closed to the page", overlay.result.value);
    // What the page's own script can see of it (it records that in the DOM every 100 ms): the element, never its shadow
    // root, never the extension's state.
    await sleep(300);
    const pageSaw = await evalIn<string>("document.body.dataset.pageSees");
    check(pageSaw.result.value === "element,closed,undefined", "the page sees only the overlay's element: not its shadow root, not the extension's state", pageSaw.result.value);
    // An indicator only: a click where its pill sits reaches the page's own button underneath.
    const corner = await evalIn<{ x: number; y: number }>("(() => { const r = document.getElementById('corner').getBoundingClientRect(); return { x: r.right - 20, y: r.bottom - 12 }; })()");
    for (const type of ["mousePressed", "mouseReleased"]) {
      await transport.send(tab.tabKey, "Input.dispatchMouseEvent", { type, x: corner.result.value!.x, y: corner.result.value!.y, button: "left", clickCount: 1 });
    }
    const cornerClicks = await evalIn<string>("document.body.dataset.corner");
    check(cornerClicks.result.value === "1", "the overlay takes no click: a click where its pill sits reaches the page's button underneath", cornerClicks.result.value);
    transport.overlay(tab.tabKey, { active: false });
    await sleep(500);
    const removed = await evalIn<boolean>("document.querySelector('winter-agent-overlay') === null");
    check(removed.result.value === true, "…and removed when the tab is no longer driven");

    // A dialog: caught over CDP, answered over CDP.
    const ask = await evalIn<{ x: number; y: number }>("(() => { const r = document.getElementById('alert').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()");
    await transport.send(tab.tabKey, "Input.dispatchMouseEvent", { type: "mousePressed", x: ask.result.value!.x, y: ask.result.value!.y, button: "left", clickCount: 1 });
    // The release runs the click handler, which blocks in confirm(): the browser answers the input command only once the
    // dialog is gone — so it is not awaited until the dialog has been answered.
    const release = transport.send(tab.tabKey, "Input.dispatchMouseEvent", { type: "mouseReleased", x: ask.result.value!.x, y: ask.result.value!.y, button: "left", clickCount: 1 });
    const dialog = await waitFor(() => events.find((e) => e.method === "Page.javascriptDialogOpening"), 5000);
    check(dialog?.params.type === "confirm", "a page dialog arrives as Page.javascriptDialogOpening (while the click that opened it is still unanswered)", dialog?.params);
    await transport.send(tab.tabKey, "Page.handleJavaScriptDialog", { accept: true });
    check(await code(release) === "ok", "…the click's own command answers once the dialog is handled");
    const answered = await evalIn<string>("document.body.dataset.dialog");
    check(answered.result.value === "true", "…and Page.handleJavaScriptDialog answers it (the page saw OK)", answered);

    // A screenshot.
    const shot = await transport.send<{ data: string }>(tab.tabKey, "Page.captureScreenshot", { format: "jpeg", quality: 80 });
    const jpeg = Buffer.from(shot.data, "base64");
    facts.screenshotBytes = jpeg.length;
    check(jpeg[0] === 0xff && jpeg[1] === 0xd8, "Page.captureScreenshot of the background tab returns a JPEG", { bytes: jpeg.length });

    // An out-of-process iframe through a flat child session (chrome.debugger DebuggerSession, Chrome 125+).
    await transport.send(tab.tabKey, "Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    const child = await waitFor(() => events.find((e) => e.method === "Target.attachedToTarget" && (e.params.targetInfo as { type?: string })?.type === "iframe"), 8000);
    const childSession = child?.params.sessionId as string | undefined;
    facts.oopif = child === undefined ? "no out-of-process iframe target was attached" : (child.params.targetInfo as { url?: string })?.url;
    if (check(childSession !== undefined, "the cross-site iframe attaches as a flat child session", facts.oopif)) {
      await transport.send(tab.tabKey, "Runtime.enable", {}, { cdpSessionId: childSession! });
      const childTree = await transport.send<{ frameTree: { frame: { id: string } } }>(tab.tabKey, "Page.getFrameTree", {}, { cdpSessionId: childSession! });
      const childWorld = await transport.send<{ executionContextId: number }>(tab.tabKey, "Page.createIsolatedWorld", { frameId: childTree.frameTree.frame.id, worldName: "winter" }, { cdpSessionId: childSession! });
      const inside = await evalIn<string>("document.getElementById('inside')?.textContent", childWorld.executionContextId, childSession);
      check(inside.result.value === "inside the cross-site frame", "…and the winter world in it reads the frame", inside);
      check(await code(evalIn<string>("1", world.executionContextId, childSession)) === "not_allowed", "…whose contexts are its own (the top frame's world id is refused there)");
    }

    // DOM.setFileInputFiles: a probe, not an assertion (whether an extension's debugger may set files is the browser's call).
    const fileInput = await transport.send<{ result: { objectId?: string } }>(tab.tabKey, "Runtime.evaluate", { contextId: world.executionContextId, expression: "document.getElementById('file')" });
    const probeFile = join(root, "upload.txt");
    writeFileSync(probeFile, "hello");
    try {
      await transport.send(tab.tabKey, "DOM.setFileInputFiles", { files: [probeFile], objectId: fileInput.result.objectId });
      const names = await evalIn<string>("Array.from(document.getElementById('file').files).map((f) => f.name).join(',')");
      facts.setFileInputFiles = `allowed (files: ${names.result.value})`;
    } catch (err) {
      facts.setFileInputFiles = `refused: ${(err as Error).message}`;
    }
    console.error(`  note DOM.setFileInputFiles over chrome.debugger: ${String(facts.setFileInputFiles)}`);

    // keep() and close().
    const second = await transport.createTab({ sessionId: "s_e2e", sessionTitle: "Winter for Chrome e2e", url: `${base}/frame.html` });
    await transport.keepTab(second.tabKey);
    const afterKeep = (await transport.listTabs()).find((x) => x.tabKey === second.tabKey);
    check(afterKeep !== undefined && !afterKeep.agent, "keepTab: the tab is the user's from then on", afterKeep);
    check(await code(transport.closeTab(second.tabKey)) === "not_allowed", "…and Winter can no longer close it");
    check(await code(transport.closeTab(userTab!.tabKey)) === "not_allowed", "closeTab refuses the user's tab");

    const activeTrail: string[] = [];
    const noteActive = async (when: string) => {
      const a = (await transport.listTabs()).filter((x) => x.active).map((x) => `${x.tabKey}=${x.url.replace(base, "")}`).join(",");
      activeTrail.push(`${when}: ${a}`);
    };
    await noteActive("before the leave tests");
    // A page that asks "leave this page?": discarded, then removed — no prompt, no dialog, nothing brought forward (the
    // browser brings a tab forward to show that prompt, whatever raises it).
    for (const variant of ["attached", "not attached"] as const) {
      const bu = await transport.createTab({ sessionId: `s_bu_${variant === "attached" ? "a" : "d"}`, sessionTitle: `Leave test ${variant}`, url: `${base}/bu.html` });
      await sleep(1000);
      await transport.attach(bu.tabKey, { sessionId: "s_bu" });
      for (const type of ["mousePressed", "mouseReleased"]) await transport.send(bu.tabKey, "Input.dispatchMouseEvent", { type, x: 20, y: 20, button: "left", clickCount: 1 });
      await transport.send(bu.tabKey, "Input.insertText", { text: "x" });
      await noteActive(`(${variant}) after the input`);
      if (variant === "not attached") await transport.detach(bu.tabKey);
      check((await groupTitles()).includes(`Winter · Leave test ${variant}`), `(${variant}) the agent tab sits in its session's Winter group`, await groupTitles());
      await noteActive(`(${variant}) after reading the groups`);
      const started = Date.now();
      const closed = await code(transport.closeTab(bu.tabKey));
      const ms = Date.now() - started;
      const still = (await transport.listTabs()).some((x) => x.tabKey === bu.tabKey);
      check(closed === "ok" && !still && ms < 5000, `(${variant}) closeTab closes a page that asks "leave this page?" — no dialog left behind (${ms} ms)`, { closed, still, ms });
      const activeNow = (await transport.listTabs()).filter((x) => x.active).map((x) => x.tabKey);
      check(JSON.stringify(activeNow) === JSON.stringify([userTab!.tabKey]), `(${variant}) …and nothing came forward: the user's tab is still the active one`, activeNow);
      check(!(await groupTitles()).includes(`Winter · Leave test ${variant}`), `(${variant}) …and its group is gone with its last tab`, await groupTitles());
      await noteActive(`after the leave test (${variant})`);
    }

    // The service worker restarts (stopped through DevTools — `chrome.runtime.reload()` of this command-line-loaded
    // build does not come back in Chrome for Testing — then woken by a tab event): it reconnects on its own, still knows
    // which tabs are Winter's, and has let go of the debugger and overlay its predecessor held.
    const kept = await transport.createTab({ sessionId: "s_restart", sessionTitle: "Restart test", url: `${base}/frame.html` });
    await sleep(800);
    await transport.attach(kept.tabKey, { sessionId: "s_restart" });
    transport.overlay(kept.tabKey, { active: true });
    await sleep(500);
    const before = transport;
    await noteActive("before the worker restart");
    const stopped = await browserCdp.stopWorker();
    check(stopped, "the extension's service worker is stopped (DevTools Target.closeTarget)");
    await waitFor(() => (before.connected ? undefined : true), 10_000);
    await browserCdp.wakeWithTabEvent();
    const restarted = await waitFor(() => { const x = registry.get("chrome"); return x !== undefined && x !== before && x.connected ? x : undefined; }, 30_000);
    if (check(restarted !== undefined, "after a service-worker restart the extension reconnects on its own", chromeLog.slice(-6))) {
      transport = restarted!;
      await noteActive("after the worker restart");
      const after = (await transport.listTabs()).filter((x) => x.agent).map((x) => [x.tabKey, x.sessionId]).sort();
      check(JSON.stringify(after) === JSON.stringify([[tab.tabKey, "s_e2e"], [kept.tabKey, "s_restart"]].sort()),
        "…still reports its agent tabs with their sessions", after);
      // Its predecessor's debugger was let go (a debugger still held would refuse this attach), and its overlay removed.
      check(await code(transport.attach(kept.tabKey, { sessionId: "s_restart" })) === "ok", "…has let go of the debugger its predecessor held (the tab attaches again)");
      await transport.send(kept.tabKey, "Runtime.enable");
      const keptTree = await transport.send<{ frameTree: { frame: { id: string } } }>(kept.tabKey, "Page.getFrameTree");
      const keptWorld = await transport.send<{ executionContextId: number }>(kept.tabKey, "Page.createIsolatedWorld", { frameId: keptTree.frameTree.frame.id, worldName: "winter" });
      const overlayLeft = await transport.send<{ result: { value?: boolean } }>(kept.tabKey, "Runtime.evaluate", { contextId: keptWorld.executionContextId, expression: "document.querySelector('winter-agent-overlay') !== null", returnByValue: true });
      check(overlayLeft.result.value === false, "…and removed its predecessor's overlay", overlayLeft.result.value);
      check(await code(transport.closeTab(kept.tabKey)) === "ok", "…and can close its agent tabs");
      await noteActive("after closing the restart test's tab");
    }

    // The daemon restarts: the extension comes back on its own and still reports its agent tabs with their sessions.
    const third = await transport.createTab({ sessionId: "s_other", sessionTitle: "Another session", url: `${base}/frame.html` });
    await daemon.stop();
    daemon = undefined;
    check(!transport.connected, "the daemon stopping disconnects the transport");
    browserCdp.close();
    registry = new E2ERegistry();
    daemon = await boot(registry);
    const again = await waitFor(() => { const x = registry.get("chrome"); return x?.connected === true ? x : undefined; }, 30_000);
    if (check(again !== undefined, "after a daemon restart the extension reconnects through the host on its own")) {
      const listed = await again!.listTabs();
      const agents = listed.filter((x) => x.agent).map((x) => [x.tabKey, x.sessionId]).sort();
      check(JSON.stringify(agents) === JSON.stringify([[tab.tabKey, "s_e2e"], [third.tabKey, "s_other"]].sort()),
        "…and reports every agent tab with its session (what the engine closes from)", agents);
      await again!.closeTab(tab.tabKey);
      await again!.closeTab(third.tabKey);
      const left = await again!.listTabs();
      check(!left.some((x) => x.tabKey === tab.tabKey || x.tabKey === third.tabKey), "closeTab closes the agent tabs", left.map((x) => x.url));
      const user = left.find((x) => x.tabKey === userTab!.tabKey);
      check(user?.active === true && left.filter((x) => x.active).length === 1, "the user's tab was the active one from start to end — nothing came forward", { now: left.map((x) => [x.url, x.active]), trail: activeTrail });
    }
    check(gone.length === 0 || gone.every((g) => !g.startsWith(`${userTab!.tabKey}:`)), "no tab of the user's was reported gone", gone);
  } finally {
    if (chrome !== undefined && chrome.exitCode === null) {
      chrome.kill("SIGTERM");
      const exited = await Promise.race([new Promise((r) => chrome!.once("exit", r)), sleep(5000).then(() => "late")]);
      if (exited === "late") chrome.kill("SIGKILL");
    }
    await daemon?.stop();
    server.stop(true);
    rmSync(root, { recursive: true, force: true });
    facts.fixtureRequests = requests.length;
  }
}

if (process.env.WINTER_BROWSER_E2E !== "1") {
  console.error("browser-e2e (extension): skipped — set WINTER_BROWSER_E2E=1 (and WINTER_TEST_CHROME) to run it");
  process.exit(0);
}
if (!process.env.WINTER_TEST_CHROME) {
  console.error("browser-e2e (extension): WINTER_TEST_CHROME is not set — point it at Chrome for Testing (a .app or its binary)");
  process.exit(1);
}
try {
  await main();
} catch (err) {
  check(false, "the run reached its end", err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err));
}
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "extension-report.json"), `${JSON.stringify({ results, facts }, null, 2)}\n`);
const failed = results.filter((r) => !r.ok);
console.error(`browser-e2e (extension): ${results.length - failed.length}/${results.length} checks passed — report: ${join(OUT, "extension-report.json")}`);
console.error(`  facts: ${JSON.stringify(facts)}`);
process.exit(failed.length === 0 ? 0 : 1);
