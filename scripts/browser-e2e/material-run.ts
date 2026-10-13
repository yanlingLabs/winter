#!/usr/bin/env bun
// The leftover probes' TAB legs (opt-in): Material-style controls, Tab / Space / ⌘A, and the file-chooser rule, in a
// REAL Chromium tab driven by the REAL engine and page runtime — the browser-e2e rig (`PipeTransport` over a headless
// Chrome for Testing on a temp profile, `--use-mock-keychain`; nothing installed or downloaded) on the cu-live suite's
// own Material-like page (`scripts/cu-live/fixture-web/material.html`, our own markup of the ARIA patterns).
//
//   WINTER_BROWSER_E2E=1 bun run scripts/browser-e2e/material-run.ts [--report <file.json>]
//
// The page POSTs what it sees to this runner's `/log`: every row compares what the engine SAID with what the page
// SAW. Headless: the renderer, the DOM and CDP's `Input.*` are the browser's own; what this does not cover is the
// transport (Winter for Chrome's `chrome.debugger`, Winter.app's link). The app legs (the browser bound as an app,
// the screen) are the cu-live suite's `chrome` group.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BrowserEngine } from "../../packages/core/src/computer-use/browser/engine";
import { BrowserBackendRegistry } from "../../packages/core/src/computer-use/browser/registry";
import type { TabRunScope } from "../../packages/core/src/computer-use/browser/tab-scope";
import { CDP_ALLOWED_METHODS } from "../../packages/core/src/computer-use/browser/cdp-allowlist";
import { DiffBases } from "../../packages/core/src/computer-use/diff-base";
import { AutomationFailure } from "../../packages/core/src/computer-use/errors";
import { TargetLocks } from "../../packages/core/src/computer-use/locks";
import type { SessionFacts } from "../../packages/core/src/computer-use/policy";
import { ResultBuilder } from "../../packages/core/src/computer-use/result";
import type { PrimitiveMetric } from "../../packages/core/src/computer-use/telemetry";
import type { TabHandle } from "../../packages/core/src/computer-use/worker/bridge";
import { PipeTransport } from "./pipe-transport";
import { pageEventsSince, type PageEvent } from "../cu-live/chrome";

if (process.env.WINTER_BROWSER_E2E !== "1") {
  console.log("material-run is opt-in: run with WINTER_BROWSER_E2E=1 (it launches a headless Chrome for Testing on a temp profile)");
  process.exit(0);
}
const argv = process.argv.slice(2);
const reportAt: string = (argv.includes("--report") ? argv[argv.indexOf("--report") + 1] : undefined) ?? join(import.meta.dir, "..", "..", "out", "browser-e2e", "material-report.json");

function findChrome(): string | undefined {
  const env = process.env.WINTER_TEST_CHROME;
  if (env !== undefined && env.length > 0) return env;
  const cache = join(homedir(), "Library", "Caches", "ms-playwright");
  if (!existsSync(cache)) return undefined;
  for (const dir of readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]))) {
    const exe = join(cache, dir, "chrome-mac-arm64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing");
    if (existsSync(exe)) return exe;
  }
  return undefined;
}
const chrome = findChrome();
if (chrome === undefined) { console.error("no Chrome for Testing: set WINTER_TEST_CHROME"); process.exit(1); }

// ── the page and its log ──────────────────────────────────────────────────────────────────────────────────────────
const PAGE = join(import.meta.dir, "..", "cu-live", "fixture-web", "material.html");
const pageLog: PageEvent[] = [];
const server = Bun.serve({
  port: 0, hostname: "127.0.0.1",
  async fetch(req): Promise<Response> {
    const path = new URL(req.url).pathname;
    if (path === "/log" && req.method === "POST") {
      try { pageLog.push({ ...(JSON.parse(await req.text()) as PageEvent), at: Date.now() }); } catch { /* not one of ours */ }
      return new Response("", { status: 204 });
    }
    if (path === "/material.html") return new Response(readFileSync(PAGE, "utf8"), { headers: { "content-type": "text/html; charset=utf-8" } });
    return new Response("not found", { status: 404 });
  },
});
const URL_ = `http://127.0.0.1:${server.port}/material.html`;

// ── the engine over the pipe (a user's Chrome stand-in: its tabs, its family) ───────────────────────────────────────
const registry = new BrowserBackendRegistry();
const browser = new PipeTransport("chrome", "chrome");
browser.features = new Set(["cdp3"]);
await browser.launch(chrome, []);
registry.register(browser, { family: "chrome", name: "Chrome for Testing", bundleId: "com.google.chrome.for.testing", instanceKey: "chrome-material" });
const cwd = mkdtempSync(join(tmpdir(), "winter-material-e2e-cwd-"));
const engine = new BrowserEngine({
  registry, mintWinterTab: () => "unused", winterTabs: () => ({ tabs: [] }), sessionInfo: () => ({ cwd, title: "material" }),
  site: { dangerousDomainsAdded: () => [], savedAllowRules: () => [] },
  home: mkdtempSync(join(tmpdir(), "winter-material-e2e-home-")),
  uploadRoots: () => ({ denyRead: [] }),
  downloadRoots: () => ({ tmpDir: mkdtempSync(join(tmpdir(), "winter-material-e2e-tmp-")), denyWrite: [], denyRead: [] }),
});
const locks = new TargetLocks();
const diffBases = new DiffBases();
const facts: SessionFacts = { policy: "bypass", mode: "code" };
const metrics: PrimitiveMetric[] = [];
function scope(runId: string) {
  const builder = new ResultBuilder();
  const abort = new AbortController();
  const held = new Map<string, () => void>();
  const metric: PrimitiveMetric = { ts: 0, sessionId: "material", callId: "cv2_material", primitive: "x", ms: 0, helperMs: 0 };
  metrics.push(metric);
  const s: TabRunScope = {
    sessionId: "material", runId, callId: "cv2_material", vision: true, signal: abort.signal,
    live: () => {}, timeLeft: () => 60_000, clampWait: (ms) => Math.min(ms, 60_000),
    lock: async (key, label) => { if (!held.has(key)) held.set(key, await locks.acquire(key, { runId, sessionId: "material" }, { label })); },
    lockRun: (key) => locks.holder(key)?.runId,
    authorize: async () => {}, sessionPolicy: () => facts.policy, sessionFacts: () => facts,
    siteCard: async () => ({ approved: false }), persistentlyAllowed: () => true, granted: () => true,
    builder, keepImage: (img) => ({ image: "img", width: img.width, height: img.height }), lastTargetShot: new Map(), acted: new Set(), diffBases, metric,
    noteSite: () => {}, noteBrowser: () => {}, trusted: () => {},
  };
  return { s, text: () => builder.build().content.map((c) => (c.type === "text" ? c.text : "[image]")).join(""), end: () => { for (const r of held.values()) r(); abort.abort(); engine.runEnded("material", runId); } };
}

// ── rows ─────────────────────────────────────────────────────────────────────────────────────────────────────────
interface Row { probe: string; name: string; ok: boolean; ms: number; error?: string; evidence: Record<string, unknown> }
const rows: Row[] = [];
async function row(probe: string, name: string, fn: (ev: Record<string, unknown>) => Promise<void>): Promise<void> {
  const t0 = Date.now();
  const evidence: Record<string, unknown> = {};
  try { await fn(evidence); rows.push({ probe, name, ok: true, ms: Date.now() - t0, evidence }); console.log(`  ✓ [${probe}] ${name}`); } catch (err) {
    const error = err instanceof Error ? `${err.name}: ${err.message}`.slice(0, 4_000) : String(err);
    rows.push({ probe, name, ok: false, ms: Date.now() - t0, error, evidence });
    console.log(`  ✗ [${probe}] ${name}\n      ${error.split("\n").join("\n      ")}`);
  }
}
const expect = (cond: boolean, what: string, detail = ""): void => { if (!cond) throw new Error(`${what}${detail.length > 0 ? `\n${detail}` : ""}`); };
const refOf = (state: string, re: RegExp): number => {
  const line = state.split("\n").find((l) => re.test(l));
  if (line === undefined) throw new Error(`no line matches ${re}\n${state}`);
  return Number(/\[(\d+)\]/.exec(line)![1]);
};
const lineOf = (state: string, re: RegExp): string => state.split("\n").find((l) => re.test(l)) ?? "";
/** The role=checkbox "Accept the terms": by its name, else (the runtime may not name it from its content) the check
 *  box whose first child line is that text. */
const termsRef = (state: string): number => {
  const lines = state.split("\n");
  const named = lines.find((l) => /check box "Accept the terms"/.test(l));
  if (named !== undefined) return Number(/\[(\d+)\]/.exec(named)![1]);
  const i = lines.findIndex((l, k) => /\] check box\b/.test(l) && /text "Accept the terms"/.test(lines[k + 1] ?? ""));
  if (i < 0) throw new Error(`no Accept the terms check box\n${state}`);
  return Number(/\[(\d+)\]/.exec(lines[i]!)![1]);
};
async function failure(p: Promise<unknown>): Promise<{ kind: string; message: string } | undefined> {
  try { await p; return undefined; } catch (err) { return { kind: err instanceof AutomationFailure ? err.kind : (err as Error).name, message: (err as Error).message }; }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** The page's events since `t`, after letting its beacons land. */
async function seen(t: number): Promise<PageEvent[]> { await sleep(400); return pageEventsSince(pageLog, t); }

console.log(`material probes (tab legs) on ${chrome.split("/").slice(-1)[0]} — ${URL_}`);
const run = scope("m1");
const tab = await engine.global(run.s, "browsers.open", { url: URL_, browser: "chrome" }) as TabHandle;
const P = (primitive: string, args: Record<string, unknown> = {}) => engine.primitive(run.s, tab.targetId, primitive, args);
/** One primitive's own printed lines (the builder is shared by the run: what it printed since). */
async function said(primitive: string, args: Record<string, unknown> = {}): Promise<{ value: unknown; text: string }> {
  const before = run.text().length;
  const value = await P(primitive, args);
  return { value, text: run.text().slice(before) };
}
for (let i = 0; i < 40 && !pageLog.some((e) => e.ev === "ready"); i++) await sleep(100);
let state = await P("state", { full: true, emit: false }) as string;

await row("3", "ARIA selects read as combo boxes with their shown value", async (ev) => {
  ev.size = lineOf(state, /combo box "Size"/);
  ev.lang = lineOf(state, /combo box "Language"/);
  expect(/combo box "Size".*Medium/.test(state), "Size reads as a combo box showing Medium", state);
  expect(/combo box "Language".*English/.test(state), "Language reads as a combo box showing English", state);
});

await row("3", "mat-select: setValue picks the EXACT option (Small, never Extra Small), the page sees it", async (ev) => {
  const size = refOf(state, /combo box "Size"/);
  const t = Date.now();
  const r = await said("setValue", { ref: size, value: "Small" });
  ev.said = r.text;
  const page = await seen(t);
  ev.page = page;
  expect(page.some((e) => e.ev === "select.value" && e.id === "size" && e.value === "Small"), "the page chose Small", JSON.stringify(page));
  state = await P("state", { full: true, emit: false }) as string;
  ev.after = lineOf(state, /combo box "Size"/);
  expect(/combo box "Size".*"?Small"?/.test(ev.after as string) && !/Extra Small/.test(ev.after as string), "Size now shows Small", ev.after as string);
});

await row("3", "mat-select: an option by a unique prefix (Extra L → Extra Large); an ambiguous one refused naming both; none refused naming the options", async (ev) => {
  const size = refOf(state, /combo box "Size"/);
  const t = Date.now();
  ev.prefix = (await said("setValue", { ref: size, value: "Extra L" })).text;
  const page = await seen(t);
  expect(page.some((e) => e.ev === "select.value" && e.value === "Extra Large"), "the page chose Extra Large", JSON.stringify(page));
  const amb = await failure(P("setValue", { ref: size, value: "Extra" }));
  ev.ambiguous = amb;
  expect(amb !== undefined && /Extra Small/.test(amb.message) && /Extra Large/.test(amb.message), "\"Extra\" is refused naming both matches", JSON.stringify(amb));
  const none = await failure(P("setValue", { ref: size, value: "Gigantic" }));
  ev.none = none;
  expect(none !== undefined && ["Small", "Medium", "Large"].every((o) => none.message.includes(o)), "an unknown option is refused naming the options", JSON.stringify(none));
  state = await P("state", { full: true, emit: false }) as string;
});

await row("3", "mat-select: the open list's options are readable (click opens it; state lists the options)", async (ev) => {
  const lang = refOf(state, /combo box "Language"/);
  await P("click", { target: lang });
  await sleep(200);
  const open = await P("state", { full: true, emit: false }) as string;
  ev.options = open.split("\n").filter((l) => /option "/.test(l));
  expect(["English", "French", "German"].every((o) => new RegExp(`option "${o}"`).test(open)), "the three options are listed", open);
  const t = Date.now();
  await P("click", { target: refOf(open, /option "German"/) });
  const page = await seen(t);
  ev.page = page;
  expect(page.some((e) => e.ev === "select.value" && e.id === "lang" && e.value === "German"), "clicking the option chose it", JSON.stringify(page));
  state = await P("state", { full: true, emit: false }) as string;
});

await row("3", "(finding) a role=checkbox named by its content reads WITH its name (ARIA name from content)", async (ev) => {
  ev.line = lineOf(state, /check box/);
  expect(/check box "Accept the terms"/.test(state), "the check box carries its name", state.split("\n").filter((l) => /check box|Accept the terms/.test(l)).join("\n"));
});

for (const [name, re, id] of [
  ["role=checkbox + aria-checked (Accept the terms)", /check box(?: "Accept the terms")?/, "terms"],
  ["a wrapper over a covered native input (Notify me)", /check box "Notify me"/, "notify"],
  ["a label over a ZERO-SIZE native input (Mature content)", /check box "Mature content"/, "mature"],
  ["a covered native radio (Unlisted)", /radio button "Unlisted"/, "vis-unlisted"],
] as const) {
  await row("3", `click ticks ${name}; the page sees it and state reports checked`, async (ev) => {
    const ref = id === "terms" ? termsRef(state) : refOf(state, re);
    ev.before = lineOf(state, re);
    const t = Date.now();
    const r = await said("click", { target: ref });
    ev.said = r.text;
    const page = await seen(t);
    ev.page = page.filter((e) => e.ev === "check");
    expect(page.some((e) => e.ev === "check" && e.id === id && e.checked === true), "the page saw it checked", JSON.stringify(page));
    state = await P("state", { full: true, emit: false }) as string;
    ev.after = state.split("\n").find((l) => l.trim().startsWith(`[${ref}] `)) ?? "";
    expect(/\bchecked\b/.test(ev.after as string) && !/unchecked/.test(ev.after as string), "state says checked", ev.after as string);
  });
}

await row("1", "Tab into Title: the focus moves on and the answer says where; the page agrees", async (ev) => {
  const title = refOf(state, /text field "Title"/);
  const t = Date.now();
  const r = await said("key", { combo: "tab", into: title });
  ev.said = r.text;
  const page = await seen(t);
  ev.page = page.filter((e) => e.ev === "focus" || e.ev === "key");
  const last = [...page].reverse().find((e) => e.ev === "focus");
  expect(last !== undefined && last.id === "subtitle", "the page's focus moved from Title to Subtitle", JSON.stringify(page));
  expect(!/did not move|may not have taken/.test(r.text), "the answer does not claim nothing happened", r.text);
});

await row("1", "Space into Accept the terms: it toggles and the answer says so; the page agrees", async (ev) => {
  state = await P("state", { full: true, emit: false }) as string;
  const terms = termsRef(state);
  const t = Date.now();
  const r = await said("key", { combo: "space", into: terms });
  ev.said = r.text;
  const page = await seen(t);
  ev.page = page.filter((e) => e.ev === "check" || e.ev === "key");
  const toggled = page.some((e) => e.ev === "check" && e.id === "terms");
  const saysNothing = /did not change|may not have taken|still reads/.test(r.text);
  ev.verdict = toggled ? "toggled" : saysNothing ? "honest: nothing happened, said" : "SILENT no-op";
  expect(toggled && !saysNothing, "the page toggled it and the answer does not say otherwise", r.text);
});

await row("1", "cmd+a into Title: the whole value is selected and the answer says so; the page agrees", async (ev) => {
  state = await P("state", { full: true, emit: false }) as string;
  const title = refOf(state, /text field "Title"/);
  const t = Date.now();
  const r = await said("key", { combo: "cmd+a", into: title });
  ev.said = r.text;
  const page = await seen(t);
  ev.page = page.filter((e) => e.ev === "selection");
  const whole = page.some((e) => e.ev === "selection" && e.id === "title" && e.start === 0 && e.end === e.length && Number(e.length) > 0);
  expect(whole, "the page selected the whole value", JSON.stringify(page));
  expect(!/did not change|may not have taken/.test(r.text), "the answer does not claim nothing happened", r.text);
});

await row("2+6", "Select file (a file input in its form): the chooser is held and the answer names upload([n], paths)", async (ev) => {
  state = await P("state", { full: true, emit: false }) as string;
  const t0 = Date.now();
  const r = await said("click", { target: refOf(state, /button "Select file"/) });
  ev.ms = Date.now() - t0;
  ev.said = r.text;
  const page = await seen(t0);
  ev.page = page.filter((e) => e.ev === "button" || e.ev.startsWith("file"));
  expect(page.some((e) => e.ev === "button" && e.id === "select-file"), "the page got the click", JSON.stringify(page));
  expect(/opened the page's file chooser/.test(r.text) && /upload\(\[\d+\], paths\)/.test(r.text), "the answer says the chooser opened and names upload([n], paths)", r.text);
});

await row("6", "L4: a plain button with no file input in its form or near it — no file-chooser line, no chooser wait", async (ev) => {
  state = await P("state", { full: true, emit: false }) as string;
  const plain = refOf(state, /button "Plain action"/);
  const paint = refOf(state, /button "Paint"/);
  const times: number[] = [];
  for (let i = 0; i < 3; i++) {
    const t0 = Date.now();
    const r = await said("click", { target: plain });
    times.push(Date.now() - t0);
    expect(!/file chooser/.test(r.text), "no file-chooser line", r.text);
  }
  ev.plainMs = times;
  const page = await seen(Date.now() - 2_000);
  expect(page.filter((e) => e.ev === "button" && e.id === "plain").length >= 3, "the page got the clicks", JSON.stringify(page));
  // The Paint button sits outside the form, but four ancestors up is <body>, which holds the form's file input: the
  // rule's "near it" reaches it — measured, not asserted (it waits 150 ms and says nothing when no chooser opens).
  const t1 = Date.now();
  const r = await said("click", { target: paint });
  ev.paintMs = Date.now() - t1;
  ev.paintSaid = r.text;
  expect(!/file chooser/.test(r.text), "no file-chooser line on Paint either (no chooser opened)", r.text);
});

await row("all", "the engine sent only allowlisted methods, and the transport refused nothing", async (ev) => {
  ev.sends = browser.sent.length;
  expect(browser.sent.every((m) => CDP_ALLOWED_METHODS.includes(m)), "all allowlisted");
  expect(browser.refused.length === 0, "nothing refused", browser.refused.join("\n"));
});

run.end();
engine.stop();
await browser.close();
server.stop(true);
const failed = rows.filter((r) => !r.ok);
mkdirSync(dirname(reportAt), { recursive: true });
writeFileSync(reportAt, `${JSON.stringify({ generatedAt: new Date().toISOString(), chrome, url: URL_, rows, pageLog }, null, 2)}\n`);
console.log(`\n${rows.length - failed.length} passed, ${failed.length} failed — report ${reportAt}`);
process.exit(failed.length === 0 ? 0 : 1);
