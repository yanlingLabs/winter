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
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { CDP_ALLOWED_METHODS } from "../../packages/core/src/computer-use/browser/cdp-allowlist";
import { BrowserEngine } from "../../packages/core/src/computer-use/browser/engine";
import { BrowserBackendRegistry } from "../../packages/core/src/computer-use/browser/registry";
import type { TabRunScope } from "../../packages/core/src/computer-use/browser/tab-scope";
import { DiffBases } from "../../packages/core/src/computer-use/diff-base";
import { AutomationFailure } from "../../packages/core/src/computer-use/errors";
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

const chrome = findChrome();
if (chrome === undefined) {
  console.error("no Chromium to drive: set WINTER_TEST_CHROME to a Chrome for Testing binary");
  process.exit(1);
}

// ── the fixture web: two origins (site isolation puts the second in its own process) ────────────────
const FIXTURE = join(import.meta.dir, "fixture-web");
const serve = (port: number, rewrite: (s: string) => string) => Bun.serve({
  port, hostname: "127.0.0.1",
  fetch(req) {
    const path = new URL(req.url).pathname.replace(/^\/$/, "/index.html");
    const file = join(FIXTURE, path.replace(/\.\./g, ""));
    if (!existsSync(file)) return new Response("not found", { status: 404 });
    return new Response(rewrite(readFileSync(file, "utf8")), { headers: { "content-type": "text/html; charset=utf-8" } });
  },
});
const oop = serve(0, (s) => s);
const OOP_ORIGIN = `http://127.0.0.1:${oop.port}`;
const main = serve(0, (s) => s.replaceAll("OOP_ORIGIN", OOP_ORIGIN.replace("127.0.0.1", "127.0.0.1")));
// The main pages are served as localhost, the payment frame as 127.0.0.1: two sites.
const BASE = `http://localhost:${main.port}`;

// ── the engine over the pipe ─────────────────────────────────────────────────────────────────────
const transport = new PipeTransport("winter", "winter");
await transport.launch(chrome);
const registry = new BrowserBackendRegistry();
registry.register(transport, { family: "winter", name: "Chromium (test)", instanceKey: "winter" });
const cwd = mkdtempSync(join(tmpdir(), "winter-browser-e2e-cwd-"));
writeFileSync(join(cwd, "receipt.txt"), "a receipt");
let tabSeq = 0;
const engine = new BrowserEngine({
  registry,
  mintWinterTab: () => `tab${++tabSeq}`,
  winterTabs: () => ({ tabs: [] }),
  sessionInfo: () => ({ cwd, title: "e2e" }),
  site: { dangerousDomainsAdded: () => [], savedAllowRules: () => [] },
  home: mkdtempSync(join(tmpdir(), "winter-browser-e2e-home-")),
  uploadRoots: () => ({ denyRead: [] }),
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
  tab = await engine.global(run1.s, "browsers.open", { url: `${BASE}/index.html` }) as TabHandle;
  state = run1.text();
  expect(state.includes("opened a new tab in Winter's browser"), "the daemon line", state);
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
  await P("click", { target: [Math.round(40 * img.width / 1200), Math.round(28 * img.height / 800)] });
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

await check("the engine never sent a method outside the allowlist, and the transport refused nothing", async () => {
  expect(transport.sent.every((m) => CDP_ALLOWED_METHODS.includes(m)), "all methods allowlisted");
  expect(transport.refused.length === 0, "nothing refused", transport.refused.join("\n"));
});

run1.end();
engine.stop();
await transport.close();
oop.stop(true);
main.stop(true);
console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length === 0 ? 0 : 1);
