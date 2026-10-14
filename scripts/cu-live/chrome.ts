// The live suite's `chrome` group: the ComputerV2 leftovers' probes on a REAL Chromium bound as an APP — Chrome for
// Testing, launched by the runner on a temp profile (never the user's Chrome, never its default profile), against the
// suite's Material-like page (`fixture-web/material.html`, served by the runner on 127.0.0.1, which POSTs what it sees
// to the runner's `/log`). Data and assertions only; the runner (`run.ts` + `chrome-rig.ts`) does the driving.
//
// What each probe expects (the leftovers lane's fixes, merged in 0655ed5ac):
//   1  Tab / Space / ⌘A into web controls: the key's effect shows in the page AND the answer does not say it did
//      nothing — or nothing happened in the page AND the answer says so ("the page may not have taken the key").
//      A key that did nothing with no word about it (the round-13 finding) fails.
//   2  "Select file": the click opens the chooser, or its answer names key("return", { into }); then that key is sent.
//   3  Material selects (setValue picks the EXACT option, an ambiguous or unknown one is refused naming the options, an
//      open list's options are readable), check boxes and radios (a click ticks them; find() says checked).
//   4  Floor F with the browser's UI in French: an act on chrome://inspect, and on the "Autoriser le débogage à
//      distance ?" dialog, is Refused (remote_debugging) — and remote debugging never comes on.
//   5  Off-desktop redraw: after a click in a Chrome window on another desktop, the next screenshot shows the result
//      (the page paints the #FF00FF sentinel), or says it may predate the action and names screenshot({ live: true }).
// (Probe 6, L4's file-chooser rule, is a TAB rule: `scripts/browser-e2e/material-run.ts`.)
import { check, type Check } from "./lib";
import type { Scenario, VerifyContext } from "./scenarios";
import { PRELUDE, SENTINEL_MIN_PIXELS } from "./scenarios";

export const CFT_BUNDLE = "com.google.chrome.for.testing";
/** Its process (and window-owner) name. */
export const CFT_PROCESS = "Google Chrome for Testing";
/** Playwright's build of it (`$WINTER_TEST_CHROME_APP` overrides). */
export const CFT_DEFAULT_APP = "Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app";
/** The page every material probe works in, and its title (the browser window's). */
export const MATERIAL_PAGE = "material.html";
export const MATERIAL_TITLE = "Material Probe";

/** One thing the page saw (`material.html`'s `log()`), with when the runner received it. */
export interface PageEvent { t: number; ev: string; at?: number; id?: string; value?: unknown; checked?: boolean; start?: number; end?: number; length?: number; [k: string]: unknown }

export function pageEventsSince(events: readonly PageEvent[], since: number): PageEvent[] {
  return events.filter((e) => (e.at ?? e.t) >= since);
}

/** Which Chrome for Testing a scenario needs: its UI language, what it opens, and whether its remote debugging is on
 *  (the dialog's precondition). `key` names the instance: a scenario with another key gets a FRESH launch. */
export interface ChromeNeed {
  key: string;
  lang: "en" | "fr";
  start: "material" | "inspect";
  /** Local State's `devtools.remote_debugging.user-enabled` (what chrome://inspect's own check box sets): the runner
   *  then connects to it, which raises "Allow remote debugging?". */
  remoteDebugging?: boolean;
  /** Bring it to the front ONCE after launch, as the user would have (then their app is put back): a browser the user
   *  has used, against one launched in the background and never shown in front. */
  shownOnce?: boolean;
  /** Bind it first (Winter switches the browser's accessibility on), THEN bring it to the front once as the user and
   *  put their app back: the second live run (2026-10-13) found the page's controls absent from the tree of a browser
   *  that never came to the front after the switch, and present in one that did (the full-screen row). */
  bindThenShow?: boolean;
  /** Its window goes full screen (its own Space) through its own full-screen button, pressed by a ComputerV2 turn in a
   *  session of its own, after launch — the user is put back on their desktop after. */
  fullScreen?: boolean;
  /** Finding A's diagnosis after launch (`ChromeRig.diagnose`): the browser's own tree read step by step. */
  diagnose?: boolean;
  /** More launch switches (a diagnostic: `--disable-backgrounding-occluded-windows`). */
  extraArgs?: string[];
}

/** What the runner saw of the browser around one scenario. */
export interface ChromeObservation {
  pid?: number;
  lang: string;
  profile: string;
  /** The profile's DevToolsActivePort after the scenario: remote debugging running. */
  devToolsActivePort: boolean;
  /** A dialog scenario: the runner's connection raised a new window of the browser (the dialog), and how. */
  dialogRaised?: boolean;
  dialogVia?: string;
  /** Did the runner's connection get an answer from the browser (the dialog was approved — never)? */
  connectionAnswered?: boolean;
  /** The helper's own Floor F lexicon line, when it logged one during the run. */
  lexiconLine?: string;
  note?: string;
  /** Finding A's diagnosis, step by step (the independent reader), and the step after which the page was there. */
  diag?: Array<{ step: string; webAreas?: number; webChildren?: number; manual?: unknown; enhanced?: unknown; trusted?: unknown; error?: string }>;
  /** The diagnostic row: the attributes of the Size combo box and the Title field, and the focus trace (50 ms). */
  attrs?: Record<string, unknown>;
  trace?: Array<Record<string, unknown>>;
  readableAfter?: string;
}

/** The launch arguments (after `open -n -g -a <app> --args`). Never the default profile; a mock keychain. */
export function chromeLaunchArgs(need: ChromeNeed, profile: string, pageUrl: string): string[] {
  const start = need.start === "inspect" ? "chrome://inspect/#remote-debugging" : pageUrl;
  return [
    `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--use-mock-keychain", "--password-store=basic",
    "--disable-sync", "--disable-background-networking", "--disable-component-update", "--disable-default-apps", "--mute-audio",
    // No Cast / mDNS discovery: run 3 (2026-10-13) raised macOS's "find devices on local networks?" prompt the first
    // time an instance was brought to the front.
    "--disable-features=MediaRouter",
    `--lang=${need.lang}`, "--window-size=1100,900", "--window-position=80,60", ...(need.extraArgs ?? []), start,
  ];
}

/** The profile's `Local State` before the first launch: remote debugging switched on as chrome://inspect does. */
export function localStateFor(need: ChromeNeed): Record<string, unknown> | undefined {
  return need.remoteDebugging === true ? { devtools: { remote_debugging: { "user-enabled": true } } } : undefined;
}

/** `DevToolsActivePort`'s two lines → the browser endpoint's port and path. */
export function parseDevToolsActivePort(text: string): { port: number; path: string } | undefined {
  const [port, path] = text.split("\n").map((l) => l.trim());
  const n = Number(port);
  return Number.isInteger(n) && n > 0 && n < 65536 && path !== undefined && path.startsWith("/devtools/") ? { port: n, path } : undefined;
}

/** The process list (`ps -axo pid=,command=`) → the main browser process of the instance on `profile`. */
export function chromePidFrom(ps: string, app: string, profile: string): number | undefined {
  const exe = `${app}/Contents/MacOS/${CFT_PROCESS}`;
  for (const line of ps.split("\n")) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (m !== null && m[2]!.startsWith(`${exe} `) && m[2]!.includes(`--user-data-dir=${profile}`)) return Number(m[1]);
  }
  return undefined;
}

/** Any Chrome for Testing main process already running (from anything — the group then refuses to run). */
export function runningChromeForTesting(ps: string): number[] {
  return ps.split("\n").flatMap((line) => {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    // The main executable only (a helper's path is "…Testing Helper (Renderer).app/Contents/MacOS/…Helper (Renderer)").
    return m !== null && new RegExp(`${CFT_PROCESS}\\.app/Contents/MacOS/${CFT_PROCESS}(\\s|$)`).test(m[2]!) ? [Number(m[1])] : [];
  });
}

/** The text between `=== <step>` and the next `=== ` in a script's output (each step prints its marker first). */
export function stepOutput(output: string, step: string): string {
  const start = output.indexOf(`=== ${step}\n`);
  if (start < 0) return "";
  const from = start + step.length + 5;
  const next = output.indexOf("=== ", from);
  return output.slice(from, next < 0 ? undefined : next);
}

/** A key's answer says nothing visibly happened (the helper's honest note, any of its spellings). */
export function saysNothingHappened(text: string): boolean {
  return /may not have taken the key|did not move after|did not change after|selection did not change|had no visible effect|nothing changed that accessibility can see|had no effect accessibility can see/.test(text);
}

/** Probe 1's verdict for one key: what the page saw against what the answer said. */
export function keyVerdict(effect: boolean, answer: string): { ok: boolean; verdict: string } {
  const honest = saysNothingHappened(answer);
  // The off-desktop caveat (finding D): "nothing happened" stated as unverified is honest whatever the page did.
  if (honest && /so this is unverified/.test(answer)) return { ok: true, verdict: effect ? "worked; the answer said it could not verify (off-desktop caveat)" : "did nothing; the answer said so, unverified (off-desktop caveat)" };
  if (effect && !honest) return { ok: true, verdict: "worked, and the answer did not say otherwise" };
  if (!effect && honest) return { ok: true, verdict: "did nothing in the page, and the answer SAID so" };
  if (effect && honest) return { ok: false, verdict: "worked in the page, but the answer said nothing happened" };
  return { ok: false, verdict: "did nothing in the page and the answer did not say so (the round-13 bug)" };
}

const ok = (ctx: VerifyContext): Check => check("the script ran without an error", !ctx.isError, ctx.output.slice(-400));
const page = (ctx: VerifyContext): PageEvent[] => (ctx.page ?? []) as PageEvent[];
const fact = (ctx: VerifyContext, k: string): string => String(ctx.facts[k] ?? "");
const short = (s: string): string => s.replace(/\s+/g, " ").trim().slice(0, 400);

/** The prelude every chrome script adds after the suite's: the browser's handle, steps, and attempts that report. */
export const CHROME_PRELUDE = `
// Bound again in every script (binding the same window again prints only what changed): the group quits and launches
// instances between rows, and a handle kept from an earlier one is TargetLost.
async function cft() { return await apps.open(${JSON.stringify(CFT_BUNDLE)}, { emit: false }); }
/** How long until the page's controls reach accessibility (polled up to \`ms\`), or -1. */
async function webReady(w, ms) {
  const t0 = Date.now();
  for (;;) {
    const s = await w.state({ full: true, emit: false });
    if (/web area/.test(s) && /Select file/.test(s)) return Date.now() - t0;
    if (Date.now() - t0 > ms) return -1;
    await sleep(500);
  }
}
function step(name) { print("=== " + name); }
async function attempt(name, fn) {
  step(name);
  try { const v = await fn(); report({ [name]: "ok" }); return v; }
  catch (e) { const s = ((e && e.constructor && e.constructor.name) || "Error") + ": " + ((e && e.message) || String(e)); print(s); report({ [name]: s }); return undefined; }
}
async function one(app, q, roles) {
  const els = await app.find(q, { emit: false });
  const fits = (e) => roles === undefined || roles.some((r) => (e.role || "").includes(r));
  const name = typeof q === "string" ? q : q.name;
  return els.find((e) => fits(e) && e.name === name) || els.find((e) => fits(e) && (e.name || "").includes(name)) || els.find(fits);
}
`;

const SELECT_ROLES = ["combo box", "pop up button", "popup button", "pop-up button"];
const CHECK_ROLES = ["check box", "checkbox"];

/** The turn that sends a bound browser's window full screen (its own Space), through its own button. */
export const FULL_SCREEN_TURN = `
const w = await apps.open(${JSON.stringify(CFT_BUNDLE)}, { emit: false });
const btn = (await w.find({ role: "full screen button" }, { emit: false }))[0];
if (!btn) throw new Error("no full screen button");
await w.action(btn.ref, "press");
await sleep(2500);`;

/** The windowed instance: launched behind the user's app and diagnosed (finding A) — the probes run there too. */
const WINDOWED: ChromeNeed = { key: "material-windowed", lang: "en", start: "material", diagnose: true };
/** The full-screen instance (its own Space): the one way the first runs found the page readable. */
const FULLSCREEN: ChromeNeed = { key: "material-fullscreen", lang: "en", start: "material", fullScreen: true };
const MATERIAL = WINDOWED;

/** Finding A's row: the rig's step-by-step diagnosis (the browser's OWN tree, an independent reader), then the helper's
 *  view, then two of the browser's own UI acts that rebuild a page's view (Reload, then the window's zoom button). */
const FINDING_A_ROW: Scenario = {
  name: "chrome app (finding A): a windowed browser behind your app — is the page in the browser's own tree, and in the helper's?", group: "chrome", chrome: WINDOWED,
  code: `
const w = await cft();
report({ helperFirstMs: await webReady(w, 6000) });
if ((await webReady(w, 0)) < 0) {
  const reload = (await w.find({ role: "button" }, { emit: false })).find((e) => /^(Reload|Actualiser)$/.test(e.name || ""));
  if (reload) { await attempt("press Reload", () => w.click(reload.ref)); report({ helperAfterReloadMs: await webReady(w, 6000) }); }
}
if ((await webReady(w, 0)) < 0) {
  const zoom = (await w.find({ role: "zoom button" }, { emit: false }))[0];
  if (zoom) { await attempt("press zoom", () => w.action(zoom.ref, "press")); report({ helperAfterZoomMs: await webReady(w, 6000) }); }
}
const s = await w.state({ full: true, emit: false });
print(s.slice(0, 2500));`,
  verify: (ctx) => {
    const d = ctx.chrome?.diag ?? [];
    const steps = d.map((x) => `${x.step}: ${String(x.webAreas)} web area(s), ${String(x.webChildren)} children (manual ${String(x.manual)}, enhanced ${String(x.enhanced)})`).join(" | ");
    const helper = [["at once", ctx.facts.helperFirstMs], ["after Reload", ctx.facts.helperAfterReloadMs], ["after zoom", ctx.facts.helperAfterZoomMs]].filter(([, v]) => v !== undefined).map(([k, v]) => `${String(k)}: ${Number(v) >= 0 ? `${String(v)} ms` : "no page"}`).join("; ");
    return [
      ok(ctx),
      check("the independent reader could read the browser (Accessibility access)", d.length > 0 && d.every((x) => x.trusted === true), steps || "no diagnosis ran"),
      check(`the browser's OWN tree held the page${ctx.chrome?.readableAfter === undefined ? "" : ` (after: ${ctx.chrome.readableAfter})`}`, ctx.chrome?.readableAfter !== undefined, steps),
      check(`the helper read the page (${helper})`, Number(ctx.facts.helperFirstMs) >= 0 || Number(ctx.facts.helperAfterReloadMs) >= 0 || Number(ctx.facts.helperAfterZoomMs) >= 0, helper),
    ];
  },
};

/** The leftover fixes' evidence (2026-10-14): the Size combo box's and the Title field's attributes as Chrome gives
 *  them, and the focus every 50 ms while `key("tab", { into: Title })` runs. */
const TRACE_ROW: Scenario = {
  name: "chrome app (diagnostic): the combo box's and Title's attributes, the focus through Tab into Title", group: "chrome", chrome: WINDOWED, chromeTrace: true,
  code: `
const w = await cft();
await webReady(w, 8000);
const title = await one(w, "Title", ["text field"]);
await sleep(1200);
report({ tabStart: Date.now() });
await attempt("tab", () => w.key("tab", { into: title.ref }));
report({ tabEnd: Date.now() });
await sleep(800);
const s = await w.state({ emit: false });
report({ header: s.split("\\n")[0] });
step("end");`,
  verify: (ctx) => [ok(ctx), check("the attributes and the focus trace were taken", ctx.chrome?.attrs !== undefined && (ctx.chrome?.trace?.length ?? 0) > 0, JSON.stringify(ctx.chrome?.attrs ?? {}).slice(0, 300))],
};

const SCENARIOS_: Scenario[] = [
  FINDING_A_ROW,
  TRACE_ROW,
  {
    name: "chrome app: bind Chrome for Testing on the Material page (reads its controls)", group: "chrome", chrome: MATERIAL,
    code: `
const w = await cft();
report({ webReadyMs: await webReady(w, 8000) });
const s = await w.state({ full: true, emit: false });
print(s.slice(0, 6000));
report({ boundName: w.name, boundId: w.bundleId, hasSize: /Size/.test(s), hasTerms: /Accept the terms/.test(s), hasSelectFile: /Select file/.test(s) });`,
    verify: (ctx) => [
      ok(ctx),
      check("bound Chrome for Testing by its bundle id", ctx.facts.boundId === CFT_BUNDLE, String(ctx.facts.boundId)),
      check("its state lists the page's Size select, terms check box and Select file button",
        ctx.facts.hasSize === true && ctx.facts.hasTerms === true && ctx.facts.hasSelectFile === true, short(ctx.output)),
    ],
  },
  {
    name: "chrome app: mat-select — options readable and selectable (exact match, ambiguity and no match refused)", group: "chrome", chrome: MATERIAL,
    code: `
const w = await cft();
await webReady(w, 8000);
const size = await one(w, "Size", ${JSON.stringify(SELECT_ROLES)});
report({ sizeRole: size && size.role, sizeValue0: size && size.value });
await attempt("set Small", () => w.setValue(size.ref, "Small"));
const s1 = await one(w, "Size", ${JSON.stringify(SELECT_ROLES)});
report({ sizeAfterSmall: s1 && s1.value });
await attempt("set Extra", () => w.setValue(size.ref, "Extra"));
await attempt("set Gigantic", () => w.setValue(size.ref, "Gigantic"));
await attempt("open the list", () => w.click(size.ref));
await sleep(600);
const opts = await w.find({ role: "option" }, { emit: false });
report({ optionsSeen: opts.map((o) => o.name) });
const large = opts.find((o) => o.name === "Large");
if (large) await attempt("click the Large option", () => w.click(large.ref));
await sleep(400);
const s2 = await one(w, "Size", ${JSON.stringify(SELECT_ROLES)});
report({ sizeAfterLarge: s2 && s2.value });`,
    verify: (ctx) => {
      const sizes = page(ctx).filter((e) => e.ev === "select.value" && e.id === "size").map((e) => String(e.value));
      const seen = Array.isArray(ctx.facts.optionsSeen) ? (ctx.facts.optionsSeen as unknown[]).map(String) : [];
      return [
        ok(ctx),
        check("Size is read as a select (combo box / pop-up button)", SELECT_ROLES.some((r) => fact(ctx, "sizeRole").includes(r)), fact(ctx, "sizeRole")),
        check("setValue(\"Small\") answered ok", fact(ctx, "set Small") === "ok", fact(ctx, "set Small")),
        check("the PAGE chose Small (never Extra Small) first", sizes[0] === "Small", JSON.stringify(sizes)),
        check("find() then reads Size as Small", /^Small$/i.test(fact(ctx, "sizeAfterSmall").trim()), fact(ctx, "sizeAfterSmall")),
        check("an ambiguous \"Extra\" is refused, naming both matches or the options", /Extra Small/.test(fact(ctx, "set Extra")) && /Extra Large/.test(fact(ctx, "set Extra")) && fact(ctx, "set Extra") !== "ok", fact(ctx, "set Extra")),
        check("an unknown option is refused naming the options", fact(ctx, "set Gigantic") !== "ok" && ["Small", "Medium", "Large"].every((o) => fact(ctx, "set Gigantic").includes(o)), fact(ctx, "set Gigantic")),
        check("the open list's options are readable (all five found)", ["Small", "Extra Small", "Medium", "Large", "Extra Large"].every((o) => seen.includes(o)), JSON.stringify(seen)),
        check("clicking the Large option chose it in the page", sizes.includes("Large") && fact(ctx, "click the Large option") === "ok", `${JSON.stringify(sizes)} ${fact(ctx, "click the Large option")}`),
        check("no option other than the ones asked for was chosen", sizes.every((v) => v === "Small" || v === "Large"), JSON.stringify(sizes)),
      ];
    },
  },
  {
    name: "chrome app: Material check boxes and radios — a click ticks them, find() says checked", group: "chrome", chrome: MATERIAL,
    code: `
const w = await cft();
await webReady(w, 8000);
const targets = [["Accept the terms", ${JSON.stringify(CHECK_ROLES)}, "terms"], ["Notify me", ${JSON.stringify(CHECK_ROLES)}, "notify"], ["Mature content", ${JSON.stringify(CHECK_ROLES)}, "mature"], ["Unlisted", ["radio"], "unlisted"]];
for (const [name, roles, key] of targets) {
  const e = await one(w, name, roles);
  report({ ["role_" + key]: e && e.role, ["before_" + key]: e && e.states });
  if (!e) continue;
  await attempt("click " + key, () => w.click(e.ref));
  await sleep(300);
  const after = await one(w, name, roles);
  report({ ["after_" + key]: after && after.states });
}`,
    verify: (ctx) => {
      const checks: Check[] = [ok(ctx)];
      for (const [key, id] of [["terms", "terms"], ["notify", "notify"], ["mature", "mature"], ["unlisted", "vis-unlisted"]] as const) {
        const after = Array.isArray(ctx.facts[`after_${key}`]) ? (ctx.facts[`after_${key}`] as unknown[]).map(String) : [];
        const ticked = page(ctx).some((e) => e.ev === "check" && e.id === id && e.checked === true);
        checks.push(check(`${key}: the click answered ok`, fact(ctx, `click ${key}`) === "ok", fact(ctx, `click ${key}`) || `not found (role ${fact(ctx, `role_${key}`)})`));
        checks.push(check(`${key}: the PAGE ticked it`, ticked, JSON.stringify(page(ctx).filter((e) => e.ev === "check"))));
        checks.push(check(`${key}: find() reports it checked`, after.includes("checked"), JSON.stringify(after)));
      }
      return checks;
    },
  },
  {
    name: "chrome app: Tab, Space and cmd+a into the Material page — the page and the answer agree", group: "chrome", chrome: MATERIAL,
    code: `
const w = await cft();
await webReady(w, 8000);
const title = await one(w, "Title", ["text field"]);
const terms = await one(w, "Accept the terms", ${JSON.stringify(CHECK_ROLES)});
report({ titleRef: title && title.ref, termsRef: terms && terms.ref });
await attempt("tab", () => w.key("tab", { into: title.ref }));
await sleep(500);
await attempt("space", () => w.key("space", { into: terms.ref }));
await sleep(500);
await attempt("cmd+a", () => w.key("cmd+a", { into: title.ref }));
await sleep(500);
step("end");`,
    verify: (ctx) => {
      const ev = page(ctx);
      const focus = ev.filter((e) => e.ev === "focus").map((e) => String(e.id));
      // The focus after the Tab: a focus event, or (a background window fires none) the page's activeElement.
      const active = ev.filter((e) => e.ev === "active").map((e) => String(e.id));
      const tab = keyVerdict(focus.includes("subtitle") || active.at(0) === "subtitle", stepOutput(ctx.output, "tab"));
      const space = keyVerdict(ev.some((e) => e.ev === "check" && e.id === "terms"), stepOutput(ctx.output, "space"));
      const all = keyVerdict(ev.some((e) => e.ev === "selection" && e.id === "title" && e.start === 0 && Number(e.length) > 0 && e.end === e.length), stepOutput(ctx.output, "cmd+a"));
      return [
        ok(ctx),
        check(`Tab: ${tab.verdict}`, tab.ok && fact(ctx, "tab") === "ok", `${short(stepOutput(ctx.output, "tab"))} | page focus: ${focus.join(" → ")} | active after Tab: ${active.join(", ")}`),
        check(`Space: ${space.verdict}`, space.ok && fact(ctx, "space") === "ok", `${short(stepOutput(ctx.output, "space"))} | page: ${JSON.stringify(ev.filter((e) => e.ev === "check"))}`),
        check(`cmd+a: ${all.verdict}`, all.ok && fact(ctx, "cmd+a") === "ok", `${short(stepOutput(ctx.output, "cmd+a"))} | page: ${JSON.stringify(ev.filter((e) => e.ev === "selection").slice(-3))}`),
      ];
    },
  },
  {
    name: "chrome app: a web \"Select file\" button — the chooser opens, or the answer names key(\"return\", { into })", group: "chrome", chrome: MATERIAL,
    code: `
const w = await cft();
await webReady(w, 8000);
const btn = await one(w, "Select file", ["button"]);
const w0 = await w.windows();
await attempt("click", () => w.click(btn.ref));
await sleep(1500);
const w1 = await w.windows();
const s1 = await w.state({ emit: false });
report({ windowsBefore: w0.length, windowsAfterClick: w1.length, sheetAfterClick: /sheet|Cancel/.test(s1) });
let opened = w1.length > w0.length || /sheet|Cancel/.test(s1);
if (!opened) {
  await attempt("return", () => w.key("return", { into: btn.ref }));
  await sleep(1500);
  const w2 = await w.windows();
  const s2 = await w.state({ emit: false });
  report({ windowsAfterReturn: w2.length, sheetAfterReturn: /sheet|Cancel/.test(s2) });
  opened = w2.length > w0.length || /sheet|Cancel/.test(s2);
}
step("cancel");
if (opened) {
  const cancel = (await w.find({ role: "button", name: "Cancel" }, { emit: false })).find((e) => e.name === "Cancel");
  if (cancel) await attempt("press Cancel", () => w.click(cancel.ref));
  else await attempt("escape", () => w.key("escape"));
}
step("end");`,
    verify: (ctx) => {
      const ev = page(ctx);
      const clickAnswer = stepOutput(ctx.output, "click");
      const requested = ev.filter((e) => e.ev === "file.requested").length;
      const openedOnClick = ctx.facts.sheetAfterClick === true || Number(ctx.facts.windowsAfterClick) > Number(ctx.facts.windowsBefore);
      const openedOnReturn = ctx.facts.sheetAfterReturn === true || Number(ctx.facts.windowsAfterReturn) > Number(ctx.facts.windowsBefore);
      const namesReturn = /key\("return", \{ into: \d+ \}\)/.test(clickAnswer);
      return [
        ok(ctx),
        check("the click reached the page's button", ev.some((e) => e.ev === "button" && e.id === "select-file"), JSON.stringify(ev.filter((e) => e.ev === "button" || e.ev.startsWith("file")))),
        check(`the click opened the chooser, or its answer names key("return", { into })`, openedOnClick || namesReturn, `${openedOnClick ? "opened" : "not opened"}; answer: ${short(clickAnswer)}`),
        check("if the click did not open it, key(\"return\", { into }) did", openedOnClick || openedOnReturn, `return answer: ${short(stepOutput(ctx.output, "return"))}; page file requests ${requested}`),
        check("the chooser was closed again (Cancel / Escape, or none opened)", !(openedOnClick || openedOnReturn) || fact(ctx, "press Cancel") === "ok" || fact(ctx, "escape") === "ok", `${fact(ctx, "press Cancel")} ${fact(ctx, "escape")}`),
      ];
    },
  },
  {
    // A FRESH instance (its window then goes full screen = its own Space, through its own full-screen button, as the
    // generic off-Space check does for an app the run launched). The page paints the sentinel only on the click.
    name: "chrome app (off-desktop): after an act in a Chrome window on another desktop, the next screenshot shows it — or says it may predate it", group: "chrome",
    chrome: { key: "material-offspace", lang: "en", start: "material", fullScreen: true },
    session: "fresh",
    // The act is setValue into the "Paint word" field (an accessibility write — no desktop visit; the page paints on its
    // input). A visit an act may still ask for is allowed (consented), so the act lands either way and the picture right
    // after it is what is judged. A plain click is tried LAST, for its own fact.
    desktopSwitch: { answer: "allow", afterMs: 1_500 }, allowExcursionMs: 20_000, maxExcursions: 12,
    code: `
const w = await apps.open(${JSON.stringify(CFT_BUNDLE)});
const word = (await w.find({ role: "text field" }, { emit: false })).find((e) => e.name === "Paint word");
const paint = (await w.find({ role: "button", name: "Paint" }, { emit: false })).find((e) => e.name === "Paint");
step("before");
await w.screenshot();
await attempt("act", () => w.setValue(word.ref, "paint"));
step("after");
await w.screenshot();
await sleep(3000);
step("later");
await w.screenshot();
await attempt("click", () => w.click(paint.ref));
step("end");`,
    verify: (ctx) => {
      const shots = ctx.shots.filter((s) => s.error === undefined);
      const [before, after, later] = shots;
      const painted = page(ctx).some((e) => e.ev === "paint");
      const afterText = stepOutput(ctx.output, "after");
      const predates = /may predate the last action/.test(afterText) && /screenshot\(\{ live: true/.test(afterText);
      const staleSaid = /stale since [^:]*: captured .* not redrawing it there/.test(afterText);
      const honest = predates || staleSaid;
      const shows = after !== undefined && after.sentinelPixels >= SENTINEL_MIN_PIXELS;
      const desc = shots.map((s) => `${s.width}x${s.height} sentinel ${s.sentinelPixels}`).join("; ");
      return [
        ok(ctx),
        check("the window was off this desktop (the bind says so)", /another desktop|another Space|off this desktop|capture only|not on this desktop/i.test(ctx.output), short(ctx.output.slice(0, 600))),
        check("the act landed in the page (it painted)", painted, `act: ${fact(ctx, "act")}; page: ${JSON.stringify(page(ctx).slice(-5))}`),
        check("(fact) a plain click there afterwards: answered", fact(ctx, "click") !== "", `click: ${fact(ctx, "click")}`),
        check("three screenshots were returned", shots.length >= 3, desc),
        check("the picture BEFORE the act shows no sentinel", before !== undefined && before.sentinelPixels < SENTINEL_MIN_PIXELS, desc),
        check("the picture right AFTER the act shows the result, or says it may predate the action and names screenshot({ live: true })", shows || honest,
          `${shows ? "shows it" : "stale"}; ${predates ? "said it may predate the action (the fix's note)" : staleSaid ? "said only the older stale label (no 'may predate', no live: true)" : "said nothing"}: ${short(afterText)} | ${desc} | act: ${fact(ctx, "act")}`),
        check("(the fix's own words) a stale picture right after the act says it may predate it and names screenshot({ live: true })", shows || predates, short(afterText)),
        check("(measured) 3 s later the picture shows it", later !== undefined && later.sentinelPixels >= SENTINEL_MIN_PIXELS, desc),
      ];
    },
  },
  {
    name: "chrome fr (Floor F): an act on chrome://inspect is refused — UI in French", group: "chrome",
    // Chrome opens no chrome:// page from its command line (the first run showed a new tab): the page is reached as a
    // person would, through the address bar (the browser's own UI, which Floor F leaves alone).
    // Full screen: the one way the page was readable in the first runs (finding A); a desktop visit an act may need is
    // allowed (the card answered "switch", a consented move).
    chrome: { key: "fr-inspect", lang: "fr", start: "material", fullScreen: true },
    desktopSwitch: { answer: "allow", afterMs: 1_500 }, allowExcursionMs: 20_000, maxExcursions: 12,
    code: `
const w = await cft();
const bar = (await w.find({ role: "text field" }, { emit: false })).find((e) => /adresse|address/i.test(e.name || ""));
report({ bar: bar && bar.name });
await attempt("type the address", () => w.setValue(bar.ref, "chrome://inspect/#remote-debugging"));
await attempt("go", () => w.key("return", { into: bar.ref }));
let s = "";
const t0 = Date.now();
while (Date.now() - t0 < 10000) { s = await w.state({ full: true, emit: false }); if (/web area/.test(s) && /inspect/i.test(s.split("\\n")[0] + s)) { if (/\\] web area[^\\n]*\\n\\s+\\[/.test(s)) break; } await sleep(500); }
print(s.slice(0, 5000));
report({ refs: (s.match(/\\[\\d+\\]/g) || []).length, capture: /capture only/i.test(s), header: s.split("\\n")[0], onInspect: /inspect/i.test(s) });
// The elements INSIDE the page (indented under its web area line): a check box first, else a button, else a link.
const lines = s.split("\\n");
const at = lines.findIndex((l) => /\\] web area/.test(l));
const depth = at < 0 ? 0 : lines[at].search(/\\S/);
const inside = [];
for (let i = at + 1; at >= 0 && i < lines.length && lines[i].search(/\\S/) > depth; i++) inside.push(lines[i].trim());
const pickRole = (role) => inside.find((l) => new RegExp("^\\\\[\\\\d+\\\\] " + role + "\\\\b").test(l));
const target = pickRole("check box") || pickRole("button") || pickRole("link");
report({ insidePage: inside.length, target: target || null });
if (target) await attempt("act in the page", () => w.click(Number(/\\[(\\d+)\\]/.exec(target)[1])));
await attempt("key tab", () => w.key("tab"));
step("end");`,
    verify: (ctx) => {
      const acted = fact(ctx, "act in the page");
      const tab = fact(ctx, "key tab");
      const refused = (s: string): boolean => /^Refused: /.test(s) && /remote debugging/i.test(s);
      return [
        ok(ctx),
        check("the run reached chrome://inspect through the address bar", fact(ctx, "type the address") === "ok" && fact(ctx, "go") === "ok" && ctx.facts.onInspect === true && Number(ctx.facts.insidePage) > 0,
          `bar ${fact(ctx, "bar")}; ${fact(ctx, "type the address")}; ${fact(ctx, "go")}; ${String(ctx.facts.insidePage)} elements in the page; ${fact(ctx, "header")}`),
        check("reading the inspect page is allowed (state lists its elements; not capture-only)", Number(ctx.facts.insidePage) > 0 && ctx.facts.capture !== true, `refs ${String(ctx.facts.refs)}`),
        check("a click on an element of the inspect page is Refused (remote debugging)", refused(acted), `${fact(ctx, "target")}: ${acted || "nothing in the page to click"}`),
        check("a key with the inspect page shown is Refused (remote debugging)", refused(tab), tab),
        check("remote debugging did not come on (no DevToolsActivePort in the profile)", ctx.chrome?.devToolsActivePort === false, JSON.stringify(ctx.chrome)),
        check("the browser showed French (the run set its AppleLanguages)", ctx.chrome?.lang === "fr", JSON.stringify(ctx.chrome)),
      ];
    },
  },
  {
    name: "chrome fr (Floor F): the \"Autoriser le débogage à distance ?\" dialog — every act refused, nothing approved", group: "chrome",
    chrome: { key: "fr-dialog", lang: "fr", start: "material", remoteDebugging: true },
    code: `
const w = await cft();
const s = await w.state({ full: true, emit: false });
print(s.slice(0, 3000));
const wins = await w.windows();
report({ windows: wins.map((x) => x.title) });
const allow = (await w.find({ role: "button", name: "Autoriser" }, { emit: false }))[0] || (await w.find("Autoriser", { emit: false }))[0];
report({ allowFound: allow ? allow.role + " " + allow.name : null });
if (allow) await attempt("press Autoriser", () => w.click(allow.ref));
const paint = (await w.find({ role: "button", name: "Paint" }, { emit: false })).find((e) => e.name === "Paint");
if (paint) await attempt("click Paint", () => w.click(paint.ref));
await attempt("key return", () => w.key("return"));
step("end");`,
    verify: (ctx) => {
      const refused = (s: string): boolean => /^Refused: /.test(s) && /remote debugging/i.test(s);
      const raised = ctx.chrome?.dialogRaised === true;
      const acts = ["press Autoriser", "click Paint", "key return"].filter((k) => fact(ctx, k) !== "");
      return [
        ok(ctx),
        check("the runner raised the dialog (remote debugging on, a client connected)", raised, JSON.stringify(ctx.chrome)),
        check("every act while it is up is Refused (remote debugging)", acts.length > 0 && acts.every((k) => refused(fact(ctx, k))), acts.map((k) => `${k}: ${fact(ctx, k)}`).join(" | ")),
        check("the page got no click (Paint never painted)", !page(ctx).some((e) => e.ev === "paint"), JSON.stringify(page(ctx).slice(-5))),
        check("the connection was never approved (no answer from the browser)", ctx.chrome?.connectionAnswered !== true, JSON.stringify(ctx.chrome)),
      ];
    },
  },
];

/** The app-leg probes (1, 2, 3) once more on the FULL-SCREEN instance — a desktop visit an act may need is allowed. */
const PROBE_NAMES = ["bind Chrome for Testing", "mat-select", "Material check boxes", "Tab, Space and cmd+a", "\"Select file\""];
const FULLSCREEN_ROWS: Scenario[] = SCENARIOS_.filter((x) => x.chrome === WINDOWED && PROBE_NAMES.some((n) => x.name.includes(n))).map((x) => ({
  ...x, name: x.name.replace(/^chrome app:/, "chrome app (full screen):"), chrome: FULLSCREEN,
  desktopSwitch: { answer: "allow" as const, afterMs: 1_500 }, allowExcursionMs: 20_000, maxExcursions: 12,
}));
// Order: the windowed instance (finding A, then its probes), the full-screen probes, off-desktop redraw, Floor F.
SCENARIOS_.splice(SCENARIOS_.findIndex((x) => x.chrome?.key === "material-offspace"), 0, ...FULLSCREEN_ROWS);

/** The group's scenarios, each with the chrome prelude after the suite's. */
export const CHROME_SCENARIOS: Scenario[] = SCENARIOS_.map((s) => ({ ...s, prelude: `${PRELUDE}\n${CHROME_PRELUDE}` }));

/** Is a scenario one of this group's (it names the browser it needs)? */
export function needsChrome(s: Pick<Scenario, "chrome">): s is { chrome: ChromeNeed } {
  return s.chrome !== undefined;
}

/** The dry run's plan lines (no screen). */
export function describeChromePlan(app: string | undefined): string[] {
  return [
    app === undefined ? "Chrome for Testing NOT found — the chrome group would skip" : `Chrome for Testing: ${app} (${CFT_BUNDLE})`,
    "each instance: open -n -g -a <it> --args --user-data-dir=<run temp> --use-mock-keychain … <page> — never the user's Chrome, never its default profile; quit (SIGTERM, then SIGKILL) when its scenarios end and at cleanup, an abort too",
    "refuses to start when any Chrome for Testing is already running (a second instance would make the bind ambiguous)",
    "French: `defaults write com.google.chrome.for.testing AppleLanguages (fr)` for those launches (Chrome on macOS takes its UI language from AppleLanguages, and Floor F reads the same key), deleted again after them and at cleanup",
    "the dialog: Local State devtools.remote_debugging.user-enabled = true (what chrome://inspect's check box sets), then the runner connects to the endpoint in DevToolsActivePort (a raw WebSocket) and never answers; a dialog that does not come up fails that row's first check with the reason",
    ...CHROME_SCENARIOS.map((s) => `${s.chrome!.key}: ${s.name}`),
  ];
}
