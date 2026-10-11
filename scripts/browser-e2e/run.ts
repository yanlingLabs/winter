#!/usr/bin/env bun
// ComputerV2 Phase 2 — the browser engine END TO END against a real headless Chromium (opt-in):
//
//   WINTER_BROWSER_E2E=1 bun run e2e:browser
//
// A test-only `PipeTransport` (`--remote-debugging-pipe`, enforcing the CDP allowlist and the world rules) stands in for
// Winter.app's link; the REAL engine, page runtime, registry and diff bases drive it against the fixture pages served on
// two local origins (so the payment iframe is an out-of-process iframe). The browser is `$WINTER_TEST_CHROME`, or a
// Chrome for Testing build already on this Mac (Playwright's cache) — nothing is installed, the profile is a fresh temp
// directory, `--use-mock-keychain` keeps it off the login Keychain, and nothing is downloaded.
//
//   WINTER_BROWSER_E2E=1 WINTER_HEADLESS_APP=<Winter Headless Dev.app> bun run e2e:browser -- --headless [--no-verify]
//
// Phase 4: the same suite through the PRODUCTION headless pool on Winter Headless (`bun run dev:headless` builds one):
// every tab is `{ browser: "headless" }`, the pool spawns the helper over its pipes and checks it against its stated
// requirement (`--no-verify` skips that, for an unsigned build). No Chrome is launched; the scenarios that need a USER's
// browser (its downloads, WebMCP there) are skipped. Temp directories only.
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { CDP_ALLOWED_METHODS } from "../../packages/core/src/computer-use/browser/cdp-allowlist";
import { BrowserEngine } from "../../packages/core/src/computer-use/browser/engine";
import { headlessRequirementFor } from "../../packages/core/src/computer-use/browser/headless/engines";
import { HEADLESS_NAME, HeadlessPool } from "../../packages/core/src/computer-use/browser/headless/pool";
import { BrowserBackendRegistry } from "../../packages/core/src/computer-use/browser/registry";
import type { TabRunScope } from "../../packages/core/src/computer-use/browser/tab-scope";
import { TransportError } from "../../packages/core/src/computer-use/browser/transport";
import { DiffBases } from "../../packages/core/src/computer-use/diff-base";
import { AutomationFailure } from "../../packages/core/src/computer-use/errors";
import { processSatisfiesRequirement } from "../../packages/core/src/computer-use/helper-verify";
import { TargetLocks } from "../../packages/core/src/computer-use/locks";
import type { SessionFacts } from "../../packages/core/src/computer-use/policy";
import { ResultBuilder } from "../../packages/core/src/computer-use/result";
import type { PrimitiveMetric } from "../../packages/core/src/computer-use/telemetry";
import type { TabHandle } from "../../packages/core/src/computer-use/worker/bridge";
import { PipeTransport } from "./pipe-transport";

if (process.env.WINTER_BROWSER_E2E !== "1") {
  console.log("e2e:browser is opt-in: run with WINTER_BROWSER_E2E=1 (it launches a headless Chromium on a temp profile)");
  process.exit(0);
}
if (process.argv.includes("--extension")) {
  // The Winter for Chrome suite (its own runner, beside this one): the extension, its host and a temp-home daemon.
  const runner = join(import.meta.dir, "extension", "run.ts");
  if (!existsSync(runner)) {
    console.log("e2e:browser --extension: the Winter for Chrome suite (scripts/browser-e2e/extension/run.ts) is not on this branch");
    process.exit(0);
  }
  const child = Bun.spawn(["bun", "run", runner, ...process.argv.slice(2).filter((a) => a !== "--extension")], { stdio: ["inherit", "inherit", "inherit"] });
  process.exit(await child.exited);
}

/** `$WINTER_TEST_CHROME`, else the newest Chrome for Testing in Playwright's cache. */
function findChrome(): string | undefined {
  const env = process.env.WINTER_TEST_CHROME;
  if (env !== undefined && env.length > 0) return env;
  const cache = join(homedir(), "Library", "Caches", "ms-playwright");
  if (!existsSync(cache)) return undefined;
  const dirs = readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]));
  for (const d of dirs) {
    for (const arch of ["chrome-mac-arm64", "chrome-mac", "chrome-mac-x64"]) {
      const bin = join(cache, d, arch, "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing");
      if (existsSync(bin)) return bin;
    }
  }
  return undefined;
}

/** `--headless`: the suite on Winter Headless through the production pool (no Chrome at all). */
const HEADLESS = process.argv.includes("--headless");
const headlessApp = process.env.WINTER_HEADLESS_APP;
if (HEADLESS && (headlessApp === undefined || !existsSync(headlessApp))) {
  console.error("e2e:browser --headless: set WINTER_HEADLESS_APP to a built Winter Headless (bun run dev:headless → dist/dev/Winter Headless Dev.app)");
  process.exit(1);
}
/** What every default `browsers.open` adds: the headless browser, in that mode. */
const DEFAULT_BROWSER: Record<string, unknown> = HEADLESS ? { browser: "headless" } : {};
/** The page's viewport in CSS px: the test Chromium's window (`--window-size=1200,800`), or Winter Headless's fixed
 *  view (1280×800, `WinterCEFHeadlessView{Width,Height}`). */
const VIEW = HEADLESS ? { width: 1280, height: 800 } : { width: 1200, height: 800 };
const chrome = HEADLESS ? "" : findChrome();
if (chrome === undefined) {
  console.error("no Chromium to drive: set WINTER_TEST_CHROME to a Chrome for Testing binary");
  process.exit(1);
}

// ── the fixture web: two origins (site isolation puts the second in its own process) ────────────────
const FIXTURE = join(import.meta.dir, "fixture-web");
const serve = (port: number, rewrite: (s: string) => string) => Bun.serve({
  port, hostname: "127.0.0.1",
  fetch(req): Response {
    const path = new URL(req.url).pathname.replace(/^\/$/, "/index.html");
    // Phase 3's downloads: an attachment, and a PDF a browser would show (no disposition).
    if (path === "/files/prices.csv") return new Response("item,price\ntea,3\n", { headers: { "content-type": "text/csv", "content-disposition": 'attachment; filename="prices.csv"' } });
    if (path === "/files/doc.pdf") return new Response("%PDF-1.4\n%fake\n", { headers: { "content-type": "application/pdf" } });
    // A download that comes through two redirects, the middle one on the other origin (the floor holds every hop).
    if (path === "/files/hop") return Response.redirect(`${OOP_ORIGIN}/files/hop2`, 302);
    if (path === "/files/hop2") return Response.redirect(`${BASE}/files/prices.csv`, 302);
    // Phase 3's readers: an API answer with a secret in it, a stylesheet and an image.
    if (path === "/api/items") return Response.json({ items: [{ name: "tea" }, { name: "cake" }], token: "tok_live_should_never_show", owner: "shop" });
    if (path === "/static/site.css") return new Response("h1 { color: navy; }", { headers: { "content-type": "text/css" } });
    if (path === "/static/logo.png") return new Response(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"), { headers: { "content-type": "image/png" } });
    const file = join(FIXTURE, path.replace(/\.\./g, ""));
    if (!existsSync(file)) return new Response("not found", { status: 404 });
    return new Response(rewrite(readFileSync(file, "utf8")), { headers: { "content-type": "text/html; charset=utf-8" } });
  },
});
const oop = serve(0, (s) => s);
const OOP_ORIGIN: string = `http://127.0.0.1:${oop.port}`;
const main = serve(0, (s) => s.replaceAll("OOP_ORIGIN", OOP_ORIGIN.replace("127.0.0.1", "127.0.0.1")));
// The main pages are served as localhost, the payment frame as 127.0.0.1: two sites.
const BASE: string = `http://localhost:${main.port}`;

/** The dangerous-domain list's additions (one scenario lists the other origin's host for a moment). */
let listedDomains: string[] = [];

// ── the engine over the pipe ─────────────────────────────────────────────────────────────────────
const registry = new BrowserBackendRegistry();
const transport = new PipeTransport("winter", "winter");
const userBrowser = new PipeTransport("chrome", "chrome");
const browserDownloads = mkdtempSync(join(tmpdir(), "winter-browser-e2e-downloads-"));
const headlessHome = mkdtempSync(join(tmpdir(), "winter-browser-e2e-headless-"));
const headlessPool = HEADLESS ? new HeadlessPool({
  home: headlessHome,
  enabled: () => true,
  resolve: () => ({ engine: "winter", app: headlessApp!, executable: join(headlessApp!, "Contents", "MacOS", headlessApp!.split("/").filter((x) => x.length > 0).at(-1)!.replace(/\.app$/, "")), requirement: headlessRequirementFor("dist", true) }),
  ...(process.argv.includes("--no-verify") ? {} : { verify: processSatisfiesRequirement }),
  log: (line) => { if (/started|exited/.test(line)) console.log(`  (${line})`); },
}) : undefined;
/** What the engine sent the headless pool, and what the helper refused (`not_allowed`) — but an ENDED winter world, which
 *  the helper answers in the browser's own words and the engine retries in a fresh one, as it would the browser's. */
const headlessSent: string[] = [];
const headlessRefused: string[] = [];
if (headlessPool !== undefined) {
  const send = headlessPool.send.bind(headlessPool);
  headlessPool.send = (async (tabKey: string, method: string, params?: Record<string, unknown>, opts?: { cdpSessionId?: string; timeoutMs?: number }) => {
    headlessSent.push(method);
    try {
      return await send(tabKey, method, params, opts);
    } catch (err) {
      if (err instanceof TransportError && err.code === "not_allowed" && !err.message.startsWith("Cannot find context with specified id")) headlessRefused.push(`${method}: ${err.message}`);
      throw err;
    }
  }) as typeof headlessPool.send;
}
if (headlessPool !== undefined) {
  registry.register(headlessPool, { family: "headless", name: HEADLESS_NAME, instanceKey: "headless" });
} else {
  // WebMCP (Phase 4): Winter's own browsers always run with it on; here both test browsers do.
  await transport.launch(chrome, ["--enable-features=WebMCP"]);
  registry.register(transport, { family: "winter", name: "Chromium (test)", instanceKey: "winter" });
  // Phase 3: a second Chromium playing a USER's browser (Winter for Chrome's backend: Fetch interception for downloads).
  // A download Winter does not catch lands in a temp folder, never the user's Downloads folder.
  userBrowser.features = new Set(["cdp3"]);
  await userBrowser.launch(chrome, ["--enable-features=WebMCP"]);
  await userBrowser.setDownloadDir(browserDownloads);
  registry.register(userBrowser, { family: "chrome", name: "Chrome for Testing", bundleId: "com.google.chrome.for.testing", instanceKey: "chrome-e2e" });
}
const cwd = mkdtempSync(join(tmpdir(), "winter-browser-e2e-cwd-"));
const sessionTmp = join(mkdtempSync(join(tmpdir(), "winter-browser-e2e-tmp-")), "winter-session-e2e");
writeFileSync(join(cwd, "receipt.txt"), "a receipt");
let tabSeq = 0;
const engine = new BrowserEngine({
  registry,
  mintWinterTab: () => `tab${++tabSeq}`,
  winterTabs: () => ({ tabs: [] }),
  sessionInfo: () => ({ cwd, title: "e2e" }),
  site: { dangerousDomainsAdded: () => listedDomains, savedAllowRules: () => [] },
  home: mkdtempSync(join(tmpdir(), "winter-browser-e2e-home-")),
  uploadRoots: () => ({ denyRead: [] }),
  downloadRoots: () => ({ tmpDir: sessionTmp, denyWrite: [], denyRead: [] }),
  ...(headlessPool === undefined ? {} : { headlessSessionEnded: (sid: string) => headlessPool.disposeSession(sid), headlessReason: () => headlessPool.reason }),
});
const locks = new TargetLocks();
const diffBases = new DiffBases();
const facts: SessionFacts = { policy: "bypass", mode: "code" };
const lastTargetShot = new Map<string, string>();

function scope(runId: string) {
  const builder = new ResultBuilder();
  const abort = new AbortController();
  const held = new Map<string, () => void>();
  const acted = new Set<string>();
  const metric: PrimitiveMetric = { ts: 0, sessionId: "e2e", callId: "cv2_e2e", primitive: "x", ms: 0, helperMs: 0 };
  const s: TabRunScope = {
    sessionId: "e2e", runId, callId: "cv2_e2e", vision: true, signal: abort.signal,
    live: () => {}, timeLeft: () => 60_000, clampWait: (ms) => Math.min(ms, 60_000),
    lock: async (key, label) => { if (!held.has(key)) held.set(key, await locks.acquire(key, { runId, sessionId: "e2e" }, { label })); },
    lockRun: (key) => locks.holder(key)?.runId,
    authorize: async () => {}, sessionPolicy: () => facts.policy, sessionFacts: () => facts,
    siteCard: async () => ({ approved: false }), persistentlyAllowed: () => true, granted: () => true,
    builder, keepImage: (img) => ({ image: "img", width: img.width, height: img.height }), lastTargetShot, acted, diffBases, metric,
    noteSite: () => {}, noteBrowser: () => {}, trusted: () => {},
  };
  return { s, text: () => builder.build().content.map((c) => (c.type === "text" ? c.text : "[image]")).join(""), end: () => { for (const r of held.values()) r(); abort.abort(); engine.runEnded("e2e", runId); } };
}

// ── scenarios ────────────────────────────────────────────────────────────────────────────────────
let passed = 0;
const failures: string[] = [];
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  const t0 = Date.now();
  try { await fn(); passed++; console.log(`  ✓ ${name} (${Date.now() - t0} ms)`); } catch (err) {
    failures.push(name);
    const detail = err instanceof Error ? `${err.name}: ${err.message}`.slice(0, 4_000) : String(err);
    console.log(`  ✗ ${name}\n      ${detail.split("\n").join("\n      ")}`);
  }
}
const expect = (cond: boolean, what: string, detail = ""): void => { if (!cond) throw new Error(`${what}${detail.length > 0 ? `\n${detail}` : ""}`); };
const refOf = (state: string, re: RegExp): number => {
  const line = state.split("\n").find((l) => re.test(l));
  if (line === undefined) throw new Error(`no line matches ${re}\n${state}`);
  return Number(/\[(\d+)\]/.exec(line)![1]);
};
async function failsWith(p: Promise<unknown>, kind: string): Promise<Error> {
  try { await p; } catch (err) {
    const k = err instanceof AutomationFailure ? err.kind : (err as Error).name;
    if (k !== kind) throw new Error(`expected ${kind}, got ${k}: ${(err as Error).message}`);
    return err as Error;
  }
  throw new Error(`expected ${kind}, but it succeeded`);
}

console.log(`browser e2e on ${chrome.split("/").slice(-1)[0]} — fixture ${BASE}, payment frame ${OOP_ORIGIN}`);
const run1 = scope("r1");
let tab!: TabHandle;
let state = "";
const P = (primitive: string, args: Record<string, unknown> = {}, sc = run1.s) => engine.primitive(sc, tab.targetId, primitive, args);

await check("browsers.open prints the full flattened state: frames, the OOPIF, open shadow DOM, redaction", async () => {
  tab = await engine.global(run1.s, "browsers.open", { url: `${BASE}/index.html`, ...DEFAULT_BROWSER }) as TabHandle;
  state = run1.text();
  expect(state.includes(HEADLESS ? "opened a new tab in Winter's headless browser" : "opened a new tab in Winter's browser"), "the daemon line", state);
  expect(/Tab "Fixture Shop" — http:\/\/localhost:\d+\/index.html/.test(state), "the header", state);
  expect(/\[\d+\] heading "Your cart" \(level 1\)/.test(state), "the heading", state);
  expect(/\[\d+\] link "Next page" → localhost:\d+/.test(state), "a link with its host", state);
  expect(/\[\d+\] text field "Coupon" value=""/.test(state), "an empty text field shows value=\"\"", state);
  expect(/\[\d+\] text field "Password" value=<redacted>/.test(state), "the password is redacted", state);
  expect(!state.includes("hunter2"), "the password value never appears", state);
  expect(/\[\d+\] check box "Gift wrap" \(unchecked\)/.test(state), "the check box", state);
  expect(/\[\d+\] pop up button "Size" value="Small"/.test(state), "the select", state);
  expect(/\[\d+\] button "Shadow button"/.test(state), "the open shadow root is flattened", state);
  expect(/\[\d+\] iframe "Same origin" \(localhost:\d+\)/.test(state), "the same-origin iframe", state);
  expect(/\[\d+\] button "Frame button"/.test(state), "the same-origin frame's content is grafted", state);
  expect(/\[\d+\] iframe "Payment" \(127\.0\.0\.1:\d+\)/.test(state), "the payment iframe", state);
  expect(/\[\d+\] button "Pay now"/.test(state), "the out-of-process iframe's content is grafted", state);
  expect(/text field "Card number" value=<redacted>/.test(state), "a cc-number field is redacted", state);
  expect(state.includes("<redacted>") && !state.includes("eyJhbGciOiJIUzI1NiJ9"), "a JWT in page text is redacted", state);
  expect(/\[\d+\] list "Recommendations" \(3 items\)/.test(state), "the list with its item count", state);
});

await check("type into a text field (verified), click, and the diff shows the change", async () => {
  const s = await P("state", { full: true, emit: false }) as string;
  const coupon = refOf(s, /text field "Coupon"/);
  await P("type", { text: "SAVE10", into: coupon });
  const apply = refOf(s, /button "Apply"/);
  await P("click", { target: apply });
  const d = await P("state", {}) as string;
  expect(/~ \[\d+\] value "" → "SAVE10"/.test(d), "the field's value changed in the diff", d);
  expect(d.includes("Applied SAVE10"), "the click ran the page's handler", d);
  expect(run1.text().includes("received: verified"), "type says what was received");
});

await check("the secure-field floor: type into the password field is Refused, nothing typed", async () => {
  const s = await P("state", { full: true, emit: false }) as string;
  const pw = refOf(s, /text field "Password"/);
  const e = await failsWith(P("type", { text: "x", into: pw }), "Refused");
  expect(e.message.startsWith("that is a password or payment field"), "Phase 1's sentence", e.message);
  const card = refOf(s, /text field "Card number"/);
  await failsWith(P("type", { text: "4242", into: card }), "Refused");
});

await check("setValue on a select, select() on text, find(), text() with redaction", async () => {
  const s = await P("state", { full: true, emit: false }) as string;
  await P("setValue", { ref: refOf(s, /pop up button "Size"/), value: "Large" });
  const d = await P("state", {}) as string;
  expect(/value "Small" → "Large"/.test(d), "the select changed", d);
  await P("select", { ref: refOf(s, /text field "Coupon"/), text: "VE1" });
  const found = await P("find", { query: "Pay now", emit: false }) as Array<{ ref: number; role: string }>;
  expect(found.length === 1 && found[0]!.role === "button", "find reaches into the out-of-process frame", JSON.stringify(found));
  const text = await P("text", { emit: false }) as string;
  expect(text.includes("Your cart") && text.includes("<redacted>") && !text.includes("eyJhbGciOiJIUzI1NiJ9"), "readable text, token redacted", text.slice(0, 400));
});

await check("clicks inside frames: the same-origin frame and the out-of-process iframe (frame offsets mapped)", async () => {
  const s = await P("state", { full: true, emit: false }) as string;
  await P("click", { target: refOf(s, /button "Frame button"/) });
  await P("click", { target: refOf(s, /button "Pay now"/) });
  await P("click", { target: refOf(s, /button "Shadow button"/) });
  const after = await P("state", { full: true, emit: false }) as string;
  expect(after.includes("frame pressed"), "the same-origin frame's button ran", after);
  expect(after.includes("oop pressed"), "the out-of-process iframe's button ran", after);
  expect(after.includes("shadow pressed"), "the shadow button ran", after);
});

await check("an element far below the fold is scrolled into view once and clicked", async () => {
  const s = await P("state", { full: true, emit: false }) as string;
  await P("click", { target: refOf(s, /button "Far below"/) });
  const after = await P("state", { full: true, emit: false }) as string;
  expect(after.includes("Big pressed"), "the far button ran", after);
});

await check("waitFor text that arrives after a delay; WaitTimeout says what it saw", async () => {
  const s = await P("state", { full: true, emit: false }) as string;
  await P("click", { target: refOf(s, /button "Load more"/) });
  const w = await P("waitFor", { cond: { text: "Delayed content arrived" }, timeoutMs: 5_000 }) as { waitedMs: number };
  expect(w.waitedMs >= 0, "waited");
  const e = await failsWith(P("waitFor", { cond: { text: "never ever" }, timeoutMs: 300 }), "WaitTimeout");
  expect(e.message.includes("seen: title \"Fixture Shop\""), "it says what it saw", e.message);
  const idle = await P("waitForIdle", { timeoutMs: 3_000 }) as { settled: boolean };
  expect(idle.settled, "the page goes quiet");
});

await check("a confirm dialog: shown first in state, other acts are TargetBusy, OK answers it", async () => {
  const s = await P("state", { full: true, emit: false }) as string;
  const apply = refOf(s, /button "Apply"/);
  await P("click", { target: refOf(s, /button "Confirm something"/) });
  const d = await P("state", {}) as string;
  const line = d.split("\n")[1] ?? "";
  expect(/^dialog confirm "Leave this page\?" — \[\d+\] button "OK" · \[\d+\] button "Cancel"$/.test(line), "the dialog line", d);
  await failsWith(P("click", { target: apply }), "TargetBusy");
  await P("click", { target: Number(/\[(\d+)\] button "OK"/.exec(line)![1]) });
  const after = await P("state", { full: true, emit: false }) as string;
  expect(after.includes("confirmed"), "the page got OK", after);
});

await check("a prompt dialog: setValue on its field, then OK sends the reply", async () => {
  const s = await P("state", { full: true, emit: false }) as string;
  await P("click", { target: refOf(s, /button "Ask my name"/) });
  const d = await P("state", {}) as string;
  const line = d.split("\n")[1] ?? "";
  expect(/^dialog prompt "Your name\?" — \[\d+\] text field value="nobody" · \[\d+\] button "OK" · \[\d+\] button "Cancel"$/.test(line), "the prompt line", d);
  await P("setValue", { ref: Number(/\[(\d+)\] text field/.exec(line)![1]), value: "Ada" });
  await P("click", { target: Number(/\[(\d+)\] button "OK"/.exec(line)![1]) });
  const after = await P("state", { full: true, emit: false }) as string;
  expect(after.includes("hello Ada"), "the page got the reply", after);
});

await check("typing into a field inside a child frame: focus is placed there, keys reach it, the page sees input events", async () => {
  const s = await P("state", { full: true, emit: false }) as string;
  await P("type", { text: "hi there", into: refOf(s, /text field "Frame note"/) });
  const after = await P("state", { full: true, emit: false }) as string;
  expect(after.includes("echo hi there"), "the frame's input handler ran per key", after);
  expect(run1.text().includes('sent 8 characters to ['), "the act line");
});

await check("hover shows hover-only content; scroll and key() reach the page; text({ markdown }) has headings and links", async () => {
  const s = await P("state", { full: true, emit: false }) as string;
  await P("hover", { target: refOf(s, /button "Hover me"/), ms: 50 });
  let after = await P("state", { full: true, emit: false }) as string;
  expect(after.includes("tooltip shown"), "the hover handler ran", after);
  await P("scroll", { target: refOf(s, /heading "Your cart"/), direction: "down", pages: 1 });
  await P("key", { combo: "cmd+a", into: refOf(s, /text field "Coupon"/) });
  await P("key", { combo: "backspace" });
  after = await P("state", { full: true, emit: false }) as string;
  expect(/text field "Coupon" value=""/.test(after), "select-all then backspace cleared the field", after);
  const md = await P("text", { markdown: true, emit: false }) as string;
  expect(md.includes("# Your cart") && /\[Next page\]\(http:\/\/localhost:\d+\/page2\.html\)/.test(md) === false, "a heading (the nav is boilerplate outside main)", md.slice(0, 600));
});

await check("upload a file from the session's cwd into the file input", async () => {
  const s = await P("state", { full: true, emit: false }) as string;
  await P("upload", { ref: refOf(s, /file input "Receipt"/), paths: "receipt.txt" });
  const after = await P("state", { full: true, emit: false }) as string;
  expect(after.includes("picked receipt.txt"), "the page saw the file", after);
});

await check("a screenshot's point maps back to the page (click by pixels)", async () => {
  await P("goto", { url: `${BASE}/index.html` });
  const img = await P("screenshot", { emit: false }) as { width: number; height: number };
  expect(img.width > 0 && img.width <= 1280 && img.height <= 1280, "within the default budget", JSON.stringify(img));
  // The Apply button's centre, measured by the page runtime, as image pixels.
  const s = await P("state", { full: true, emit: false }) as string;
  void s;
  // Click at the image's top-left nav link area: the first link sits near (20+, 20+) CSS px.
  await P("click", { target: [Math.round(40 * img.width / VIEW.width), Math.round(28 * img.height / VIEW.height)] });
  const loaded = await P("waitFor", { cond: { url: "page2.html" }, timeoutMs: 5_000 }) as { waitedMs: number };
  expect(loaded.waitedMs >= 0, "the pixel click followed the link");
});

await check("a new document: earlier refs are StaleRef; the header says new page; back() returns", async () => {
  const s = await P("state", { full: true, emit: false }) as string;
  expect(s.includes('Tab "Second page"'), "on the second page", s);
  const link = refOf(s, /link "Back home"/);
  await P("goto", { url: `${BASE}/index.html` });
  await failsWith(P("click", { target: link }), "StaleRef");
  const st = await P("state", {}) as string;
  expect(st.split("\n")[0]!.includes(" · new page"), "the header says new page", st.split("\n")[0]);
  await P("back", {});
  expect((await P("url", {}) as string).endsWith("/page2.html"), "back() went back");
  await P("forward", {});
  expect((await P("url", {}) as string).endsWith("/index.html"), "forward() went forward");
  await P("reload", {});
});

await check("goto: a load failure is an Error with the browser's net error", async () => {
  const e = await failsWith(P("goto", { url: "http://127.0.0.1:1/" }), "Error");
  expect(/net::ERR_/.test(e.message), "the net error", e.message);
});

await check("native pickers never open: a select, date, time, color (and its label) and file input refuse pointer and keys; setValue/upload instead", async () => {
  await P("goto", { url: `${BASE}/pickers.html` });
  const s = await P("state", { full: true, emit: false }) as string;
  const country = refOf(s, /pop up button "Country"/);
  const e1 = await failsWith(P("click", { target: country }), "Refused");
  expect(/^\[\d+\] opens a pop-up menu when pressed or keyed — use setValue\(ref, value\) instead$/.test(e1.message), "the select's refusal", e1.message);
  for (const combo of ["space", "return", "alt+down", "down"]) await failsWith(P("key", { combo, into: country }), "Refused");
  const toppings = refOf(s, /list box "Toppings"/);
  await failsWith(P("click", { target: toppings }), "Refused");
  const arrival = refOf(s, /text field "Arrival"/);
  const e2 = await failsWith(P("click", { target: arrival }), "Refused");
  expect(e2.message.includes("opens a date picker"), "the date input's refusal", e2.message);
  await failsWith(P("type", { text: "2026-10-10", into: arrival }), "Refused");
  await failsWith(P("click", { target: refOf(s, /text field "At"/) }), "Refused");
  const colour = refOf(s, /button "Colour"/);
  const e3 = await failsWith(P("click", { target: colour }), "Refused");
  expect(e3.message.includes("opens a color picker"), "the color input's refusal", e3.message);
  const e4 = await failsWith(P("click", { target: refOf(s, /file input "Attachment"/) }), "Refused");
  expect(e4.message.includes("opens a file chooser") && e4.message.includes("use upload(ref, paths) instead"), "the file input's refusal names upload()", e4.message);
  // The colour's label sits at a known place (CSS 600–800 × 20–60): pressing it would open the colour picker too.
  const img = await P("screenshot", { emit: false }) as { width: number; height: number };
  const e5 = await failsWith(P("click", { target: [Math.round(700 * img.width / VIEW.width), Math.round(40 * img.height / VIEW.height)] }), "Refused");
  expect(e5.message.startsWith("that control opens a color picker"), "a pixel press on the label", e5.message);
  // setValue is the way: by visible text, by value, several lines for a multiple select; a date in its shape.
  await P("setValue", { ref: country, value: "Japan" });
  let after = await P("state", { full: true, emit: false }) as string;
  expect(/pop up button "Country" value="Japan"/.test(after) && after.includes("country changed to jp"), "the select took Japan, the page saw change", after);
  await P("setValue", { ref: country, value: "br" });
  await P("setValue", { ref: toppings, value: "Cheese\nOlives" });
  after = await P("state", { full: true, emit: false }) as string;
  expect(after.includes("toppings changed to Cheese+Olives"), "the multiple select took two", after);
  await P("setValue", { ref: arrival, value: "2026-10-10" });
  after = await P("state", { full: true, emit: false }) as string;
  expect(/text field "Arrival" value="2026-10-10"/.test(after) && after.includes("arrival changed to 2026-10-10"), "the date took its value", after);
  const bad = await failsWith(P("setValue", { ref: arrival, value: "next tuesday" }), "Error");
  expect(bad.message.includes("takes a value like YYYY-MM-DD"), "a date's shape", bad.message);
  await P("setValue", { ref: colour, value: "#ff0000" });
  after = await P("state", { full: true, emit: false }) as string;
  expect(after.includes("colour changed to #ff0000"), "the colour took its value", after);
});

await check("a text leaf is pressed where its text is drawn; a right-click never opens the browser's own menu", async () => {
  const s = await P("state", { full: true, emit: false }) as string;
  await P("click", { target: refOf(s, /text "Press this text"/) });
  let after = await P("state", { full: true, emit: false }) as string;
  expect(after.includes("div pressed"), "the text's element got the click", after);
  await P("click", { target: refOf(after, /text "Right-click here"/), button: "right" });
  await P("waitFor", { cond: { text: "menu prevented" }, timeoutMs: 3_000 });
  after = await P("state", { full: true, emit: false }) as string;
  expect(after.includes("menu prevented: true"), "the contextmenu event was prevented", after);
});

await check("editing keys carry their macOS commands: cmd+z undoes typing, cmd+shift+z redoes it, alt+backspace deletes a word", async () => {
  const s = await P("state", { full: true, emit: false }) as string;
  const notes = refOf(s, /text field "Notes"/);
  await P("type", { text: "hello world", into: notes });
  await P("key", { combo: "alt+backspace", into: notes });
  let after = await P("state", { full: true, emit: false }) as string;
  expect(/text field "Notes" value="hello "/.test(after), "alt+backspace deleted the word", after);
  await P("key", { combo: "cmd+z", into: notes });
  after = await P("state", { full: true, emit: false }) as string;
  expect(/text field "Notes" value="hello world"/.test(after), "cmd+z undid the deletion", after);
  await P("key", { combo: "cmd+shift+z", into: notes });
  after = await P("state", { full: true, emit: false }) as string;
  expect(/text field "Notes" value="hello "/.test(after), "cmd+shift+z redid it", after);
  await failsWith(P("key", { combo: "cmd+v", into: notes }), "Refused");
});

await check("with nothing editable focused, a key carrying a command keeps its default: the page hears it and it scrolls", async () => {
  const s = await P("state", { full: true, emit: false }) as string;
  // A press on plain text moves the focus off the Notes field (to the page).
  await P("click", { target: refOf(s, /text "(Press this text|div pressed)"/) });
  expect(!(await P("text", { emit: false }) as string).includes("scrolled down"), "the page has not scrolled yet");
  await P("key", { combo: "down" });
  await P("waitFor", { cond: { text: "key ArrowDown" }, timeoutMs: 3_000 });
  await P("waitFor", { cond: { text: "scrolled down" }, timeoutMs: 3_000 });
  await P("key", { combo: "backspace" });
  await P("waitFor", { cond: { text: "key Backspace" }, timeoutMs: 3_000 });
});

// ── Phase 3: the readers and the element members, in the page runtime against a real page ────────────
const run3 = scope("r3");
let rtab!: TabHandle;
const R = (primitive: string, args: Record<string, unknown> = {}) => engine.primitive(run3.s, rtab.targetId, primitive, args);

await check("console(): the page's console calls and its uncaught exception, as text", async () => {
  rtab = await engine.global(run3.s, "browsers.open", { url: `${BASE}/readers.html`, ...DEFAULT_BROWSER }) as TabHandle;
  await R("waitFor", { cond: { load: "load" }, timeoutMs: 5_000 });
  await new Promise((r) => setTimeout(r, 300));
  const entries = await R("console", { emit: false }) as Array<{ level: string; text: string }>;
  const lines = entries.map((e) => `${e.level} ${e.text}`);
  expect(lines.some((l) => l.startsWith("log ready")), "the log line", lines.join("\n"));
  expect(lines.some((l) => l === "error failed to load widget"), "the error line", lines.join("\n"));
  expect(lines.some((l) => l.startsWith("error") && l.includes("boom from the page")), "the uncaught exception", lines.join("\n"));
});

await check("network() and networkBody(id): the API call with its status; its JSON body with the secret redacted", async () => {
  // What Winter saw since it bound the tab: the first load's requests came before; a reload is seen whole.
  await R("reload");
  await R("waitFor", { cond: { load: "load" }, timeoutMs: 5_000 });
  await new Promise((r) => setTimeout(r, 300));
  const api = await R("network", { filter: "/api/items", emit: false }) as Array<{ id: string; url: string; status?: number; mime?: string }>;
  expect(api.length === 1 && api[0]!.status === 200, "the request and its status", JSON.stringify(api));
  const body = await R("networkBody", { id: api[0]!.id, emit: false }) as string;
  expect(body.includes('"owner": "shop"') && body.includes("<redacted>") && !body.includes("tok_live_should_never_show"), "the body, its token redacted", body);
});

await check("find()'s DOM keys reach real elements: testId, label, placeholder, css", async () => {
  const one = async (q: Record<string, unknown>) => (await R("find", { query: q, emit: false }) as Array<{ ref: number; role: string }>);
  expect((await one({ testId: "buy" })).length === 1, "testId");
  expect((await one({ label: "Email" }))[0]?.role === "text field", "label → the email field", JSON.stringify(await one({ label: "Email" })));
  expect((await one({ placeholder: "Search products" })).length === 1, "placeholder");
  expect((await one({ css: "a.price" })).length === 1, "css");
  expect((await one({ css: "input[type=password]" })).length === 1, "css: an equality test on a descriptive attribute");
  // A value test would read the password through the match count: refused before the page sees it.
  await failsWith(R("find", { query: { css: 'input[type=password][value^="hu"]' }, emit: false }), "NotAllowed");
  await failsWith(R("find", { query: { css: "input[value^=hu]" }, emit: false }), "NotAllowed");
});

await check("inspect(ref | point), html(), text({ within }), assets()", async () => {
  const link = (await R("find", { query: { testId: "buy" }, emit: false }) as Array<{ ref: number }>)[0]!.ref;
  const info = await R("inspect", { target: link, emit: false }) as { tag: string; attributes: Record<string, string>; box: number[]; visible: boolean };
  expect(info.tag === "a" && info.attributes["data-testid"] === "buy" && info.visible && info.box[2]! > 0, "the link's facts", JSON.stringify(info));
  const shot = await R("screenshot", { emit: false }) as { width: number; height: number };
  // The image's pixels per CSS px.
  const scale = shot.width / VIEW.width;
  const at = await R("inspect", { target: [Math.round((info.box[0]! + info.box[2]! / 2) * scale), Math.round((info.box[1]! + info.box[3]! / 2) * scale)], emit: false }) as { tag: string };
  expect(at.tag === "a", "a point inspects the element there", JSON.stringify({ at, box: info.box, shot }));
  const html = await R("html", { emit: false }) as string;
  expect(html.includes('data-testid="buy"') && !html.includes("script-secret-value") && !html.includes("hunter2"), "the markup, scripts and field values left out", html.slice(0, 600));
  const title = (await R("find", { query: { role: "heading" }, emit: false }) as Array<{ ref: number }>)[0]!.ref;
  expect(await R("text", { within: title, emit: false }) === "Price list", "text({ within }) reads one element");
  const assets = await R("assets", { emit: false }) as Array<{ kind: string; url: string }>;
  expect(assets.some((a) => a.kind === "stylesheet" && a.url.endsWith("/static/site.css")) && assets.some((a) => a.kind === "image" && a.url.endsWith("/static/logo.png")), "assets: the stylesheet and the image", JSON.stringify(assets));
  expect(!JSON.stringify(assets).includes("sigsecret77"), "assets: a signed URL's signature redacted", JSON.stringify(assets));
});

await check("URL-valued attributes and markdown links print with their credentials redacted (html, inspect, text({ markdown }))", async () => {
  const secrets = ["resetsecret42", "datasecret9", "sigsecret77"];
  const html = await R("html", { emit: false }) as string;
  expect(secrets.every((x) => !html.includes(x)) && html.includes("/reset?token=<redacted>&amp;lang=en") && html.includes("api_key=<redacted>") && html.includes("sig=<redacted> 1x"), "html()", html.slice(0, 1_200));
  const reset = (await R("find", { query: { css: "#reset" }, emit: false }) as Array<{ ref: number }>)[0]!.ref;
  const info = await R("inspect", { target: reset, emit: false }) as { attributes: Record<string, string> };
  expect(info.attributes.href === "/reset?token=<redacted>&lang=en" && info.attributes["data-url"] === "https://api.example.com/x?api_key=<redacted>", "inspect()", JSON.stringify(info.attributes));
  const md = await R("text", { markdown: true, emit: false }) as string;
  expect(md.includes("[Reset your password](") && md.includes("/reset?token=<redacted>&lang=en)") && secrets.every((x) => !md.includes(x)), "text({ markdown })", md);
  const para = await R("text", { within: reset, markdown: true, emit: false }) as string;
  expect(!para.includes("resetsecret42"), "text({ within, markdown })", para);
});

await check("setValue(check box, true) presses it once; dialog() and answerDialog(false)", async () => {
  const news = (await R("find", { query: { label: "Newsletter" }, emit: false }) as Array<{ ref: number }>)[0]!.ref;
  await R("setValue", { ref: news, value: true });
  await R("setValue", { ref: news, value: true });
  const st = await R("state", { full: true, emit: false }) as string;
  expect(/check box "Newsletter" \([^)]*\bchecked\)/.test(st), "checked, once", st);
  const del = (await R("find", { query: { role: "button", name: "Delete" }, emit: false }) as Array<{ ref: number }>)[0]!.ref;
  await R("click", { target: del });
  const d = await R("dialog") as { type: string; message: string } | null;
  expect(d?.type === "confirm" && d.message === "Delete it?", "the open dialog as a value", JSON.stringify(d));
  await R("answerDialog", { accept: false });
  await R("waitFor", { cond: { text: "kept" }, timeoutMs: 3_000 });
});

await check("screenshot({ fullPage }) and viewport(): the whole page, and an emulated phone width the page sees", async () => {
  const whole = await R("screenshot", { fullPage: true, emit: false }) as { width: number; height: number };
  const view = await R("screenshot", { emit: false }) as { width: number; height: number };
  expect(whole.height / whole.width > view.height / view.width * 2, "the full page is much taller than the viewport", JSON.stringify({ whole, view }));
  const before = /width (\d+)/.exec(await R("text", { emit: false }) as string)?.[1];
  expect(before === String(VIEW.width), "the page's own width before any override", String(before));
  await R("viewport", { size: { width: 390, height: 844, mobile: true } });
  await R("waitFor", { cond: { text: "width 390" }, timeoutMs: 3_000 }).catch((err: unknown) => { throw new Error(`the emulated width never reached the page: ${(err as Error).message}`); });
  await R("viewport", { size: null });
  await R("waitFor", { cond: { text: `width ${VIEW.width}` }, timeoutMs: 3_000 }).catch((err: unknown) => { throw new Error(`the page's own width never came back: ${(err as Error).message}`); });
});
run3.end();

// ── Phase 4: WebMCP — the page's own tools, read and called from the page runtime's winter world ───────────────
const run4 = scope("r4");
let wtab!: TabHandle;
const W = (primitive: string, args: Record<string, unknown> = {}) => engine.primitive(run4.s, wtab.targetId, primitive, args);

await check("WebMCP: the state names the page's own tools (not the iframe's); tools() describes them", async () => {
  wtab = await engine.global(run4.s, "browsers.open", { url: `${BASE}/webmcp.html`, ...DEFAULT_BROWSER }) as TabHandle;
  const s = await W("state", { full: true, emit: false }) as string;
  // (Chrome lists them by name.)
  expect(s.includes("site tools (WebMCP): add_to_cart, failing_tool, search_products, slow_tool — tab.tools() describes them") && !s.includes("frame_tool"), "the state's line", s.slice(0, 600));
  const tools = await W("tools", { emit: false }) as Array<{ name: string; readOnly: boolean; consequential: boolean; inputSchema?: unknown }>;
  expect(tools.map((t) => t.name).join(",") === "add_to_cart,failing_tool,search_products,slow_tool", "the four tools", JSON.stringify(tools));
  const search = tools.find((t) => t.name === "search_products")!;
  const cart = tools.find((t) => t.name === "add_to_cart")!;
  // (consequentialHint is reported from Chrome 155 on; 153 has readOnlyHint only.)
  expect(search.readOnly && !search.consequential && !cart.readOnly && JSON.stringify(search.inputSchema).includes("\"q\""), "their annotations and schema", JSON.stringify([search, cart]));
});

await check("WebMCP: callTool runs the page's tool from the winter world and returns its answer; the page sees it", async () => {
  const found = await W("callTool", { name: "search_products", input: { q: "green" } }) as { results: string[] };
  expect(JSON.stringify(found) === JSON.stringify({ results: ["green tea"] }), "the search's answer", JSON.stringify(found));
  const added = await W("callTool", { name: "add_to_cart", input: { name: "green tea" } }) as { added: string; cart: number };
  expect(added.added === "green tea" && added.cart === 1, "the cart's answer", JSON.stringify(added));
  const text = await W("text", { emit: false }) as string;
  expect(text.includes("cart: 1"), "the page itself changed", text.slice(0, 300));
  await failsWith(W("callTool", { name: "frame_tool" }), "Error");
});

await check("WebMCP: a failing tool reports the browser's failure; a tool that never answers is stopped at its timeout, and the page sees the abort", async () => {
  const e = await failsWith(W("callTool", { name: "failing_tool" }), "Error");
  expect(e.message === "the site's tool failed — what it said is printed above", "the error", e.message);
  const t0 = Date.now();
  await failsWith(W("callTool", { name: "slow_tool", timeoutMs: 500 }), "WaitTimeout");
  expect(Date.now() - t0 < 4_000, "stopped within the grace", String(Date.now() - t0));
  // The fixture's own `toolcancel` listener writes "cancelled" when the browser tells the page its tool was cancelled
  // (a browser with no such event — Chrome 153 — says "no cancel event" instead, and only the timeout is checked).
  const page = await W("text", { emit: false }) as string;
  if (!page.includes("no cancel event")) await W("waitFor", { cond: { text: "cancelled" }, timeoutMs: 3_000 });
});

await check("WebMCP: plan refuses a call (an act) but still lists", async () => {
  facts.policy = "plan";
  try {
    await failsWith(W("callTool", { name: "search_products", input: { q: "x" } }), "NotAllowed");
    expect((await W("tools", { emit: false }) as unknown[]).length === 4, "listing still works");
  } finally {
    facts.policy = "bypass";
  }
});

if (!HEADLESS) await check("WebMCP in a user's browser (its per-app policy): listed and called the same way", async () => {
  const utab = await engine.global(run4.s, "browsers.open", { url: `${BASE}/webmcp.html`, browser: "chrome" }) as TabHandle;
  const U = (primitive: string, args: Record<string, unknown> = {}) => engine.primitive(run4.s, utab.targetId, primitive, args);
  const s = await U("state", { full: true, emit: false }) as string;
  expect(s.includes("site tools (WebMCP): add_to_cart, failing_tool, search_products, slow_tool"), "the line", s.slice(0, 400));
  const found = await U("callTool", { name: "search_products", input: { q: "black" } }) as { results: string[] };
  expect(found.results[0] === "black tea", "the answer", JSON.stringify(found));
});
run4.end();

// ── Phase 3: download() in a user's browser (Fetch interception) ─────────────────────────────────────
// The downloads: a USER's browser's (Winter for Chrome's Fetch route). Winter's headless browser never downloads.
if (!HEADLESS) {
const run2 = scope("r2");
let dtab!: TabHandle;
const D = (primitive: string, args: Record<string, unknown> = {}) => engine.primitive(run2.s, dtab.targetId, primitive, args);
const browserFolder = (): string[] => readdirSync(browserDownloads).filter((f) => !f.endsWith(".crdownload"));

await check("download(link) in a user's browser: a temporary tab under Fetch interception, the file in the session folder, nothing in the browser's folder", async () => {
  dtab = await engine.global(run2.s, "browsers.open", { url: `${BASE}/downloads.html`, browser: "chrome" }) as TabHandle;
  const s = await D("state", { full: true, emit: false }) as string;
  const tabsBefore = (await userBrowser.listTabs()).length;
  const got = await D("download", { target: refOf(s, /link "Price list"/) }) as { path: string; name: string; bytes: number; mime: string };
  expect(got.name === "prices.csv" && got.mime === "text/csv" && got.bytes === 17, "the file's facts", JSON.stringify(got));
  expect(readFileSync(got.path, "utf8") === "item,price\ntea,3\n", "the file's bytes", readFileSync(got.path, "utf8"));
  expect(got.path.startsWith(sessionTmp) || got.path.includes("winter-session-e2e"), "in the session's temp folder", got.path);
  expect((await userBrowser.listTabs()).length === tabsBefore, "the temporary tab closed");
  await new Promise((r) => setTimeout(r, 500));
  expect(browserFolder().length === 0, "the browser saved nothing", browserFolder().join(", "));
});

await check("download({ url }) through two redirects: a listed MIDDLE hop is refused before a byte is read; unlisted, the redirected file is saved", async () => {
  listedDomains = ["127.0.0.1"];
  try {
    await failsWith(D("download", { target: { url: `${BASE}/files/hop` } }), "NotAllowed");
  } finally {
    listedDomains = [];
  }
  await new Promise((r) => setTimeout(r, 300));
  expect(browserFolder().length === 0, "the browser saved nothing", browserFolder().join(", "));
  const got = await D("download", { target: { url: `${BASE}/files/hop` } }) as { name: string; bytes: number };
  // (the earlier link's prices.csv is already in the folder: this one is "prices (2).csv")
  expect(/^prices( \(\d+\))?\.csv$/.test(got.name) && got.bytes === 17, "the redirected file", JSON.stringify(got));
});

await check("download(button) in the bound tab: armed, clicked, caught — the page stays", async () => {
  const s = await D("state", { full: true, emit: false }) as string;
  const got = await D("download", { target: refOf(s, /button "Export"/), to: "exports/" }) as { path: string; name: string };
  expect(got.path === join(realpathSync(cwd), "exports", "prices.csv"), "into the working directory", got.path);
  expect((await D("url", {}) as string).endsWith("/downloads.html"), "the page stayed");
  await new Promise((r) => setTimeout(r, 500));
  expect(browserFolder().length === 0, "the browser saved nothing", browserFolder().join(", "));
});

await check("download(link to a PDF): the browser would show it — Winter saves it", async () => {
  const s = await D("state", { full: true, emit: false }) as string;
  const got = await D("download", { target: refOf(s, /link "Read the PDF"/) }) as { name: string; mime: string };
  expect(got.name === "doc.pdf" && got.mime === "application/pdf", "the PDF's facts", JSON.stringify(got));
});

await check("download(data: link): decoded by Winter, named by its download attribute", async () => {
  const s = await D("state", { full: true, emit: false }) as string;
  const got = await D("download", { target: refOf(s, /link "Inline note"/) }) as { path: string; name: string };
  expect(got.name === "note.txt" && readFileSync(got.path, "utf8") === "hello data", "the decoded file", JSON.stringify(got));
});

await check("a page-made (blob:) file without the downloads permission: CDP never sees it, Page.downloadWillBegin does — the sentence says to allow downloads", async () => {
  dtab = await engine.global(run2.s, "browsers.open", { url: `${BASE}/downloads.html`, browser: "chrome" }) as TabHandle;
  const s = await D("state", { full: true, emit: false }) as string;
  const e = await failsWith(D("download", { target: refOf(s, /button "Make file"/), timeoutMs: 3_000 }), "WaitTimeout");
  expect(e.message.includes("that file is made by the page itself") && e.message.includes('saved "made.txt"'), "the sentence", e.message);
  expect(browserFolder().includes("made.txt"), "the browser saved its own copy (in the test's folder)", browserFolder().join(", "));
});

await check("an unarmed click that downloads: Page.downloadWillBegin still fires, and the next state says the browser saved it", async () => {
  const s = await D("state", { full: true, emit: false }) as string;
  await D("click", { target: refOf(s, /button "Export"/) });
  await new Promise((r) => setTimeout(r, 1_000));
  const after = await D("state", { full: true, emit: false }) as string;
  expect(after.includes('the page started a download of "prices.csv"') && after.includes("saved it in its own Downloads folder"), "the note", after);
});
run2.end();

}

if (HEADLESS) await check("the engine never sent a method outside the allowlist, and Winter Headless refused nothing", async () => {
  expect(headlessSent.length > 0 && headlessSent.every((m) => CDP_ALLOWED_METHODS.includes(m)), "all methods allowlisted");
  expect(headlessRefused.length === 0, "nothing refused", headlessRefused.join("\n"));
});
if (!HEADLESS) await check("the engine never sent a method outside the allowlist, and the transport refused nothing", async () => {
  expect(transport.sent.every((m) => CDP_ALLOWED_METHODS.includes(m)), "all methods allowlisted");
  expect(transport.refused.length === 0, "nothing refused", transport.refused.join("\n"));
  expect(userBrowser.sent.every((m) => CDP_ALLOWED_METHODS.includes(m)), "all methods allowlisted (the user's browser)");
  expect(userBrowser.refused.length === 0, "nothing refused (the user's browser)", userBrowser.refused.join("\n"));
});

run1.end();
engine.stop();
if (headlessPool !== undefined) {
  headlessPool.stop();
} else {
  await transport.close();
  await userBrowser.close();
}
oop.stop(true);
main.stop(true);
console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length === 0 ? 0 : 1);
