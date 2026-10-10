// The live ComputerV2 suite's SCENARIOS — data plus assertions, no I/O (the runner, `run.ts`, does the driving).
//
// Each scenario is ONE ComputerV2 call, made by the agent SDK's prompt-scripted double (`winter-test/calls`) — no
// LLM: the runner sends `CALL ToolSearch …` + `CALL ComputerV2 {code}` and the double makes exactly those calls.
// The scripts report what they saw with `report({...})` (a `CULIVE {json}` line), and every scenario is ALSO judged
// from the outside: the fixture's own log (what it really received), its state dump, the mirror probe's frames and
// the daemon's metrics. The runner adds, for EVERY scenario, the focus check: the user's frontmost app and active
// Space unchanged from the action's start until 3 s after it.
//
// The windows (the fixture app "Winter CU Fixture", `dev.cu-live.fixture`): "Fixture Form" (native fields),
// "Fixture Web" (WKWebView), "Fixture Canvas" (no accessibility), "Fixture Offspace" (full screen = its own Space).
// Handles persist across calls in the session's runtime (`win()` binds a window once and keeps it).
import { check, eventsSince, lastValue, MARKER, MIXED_TEXT, type Check, type FixtureEvent } from "./lib";

export const FIXTURE_APP = "Winter CU Fixture";
export const FIXTURE_BUNDLE = "dev.cu-live.fixture";
export const USER_APP_BUNDLE = "dev.cu-live.fixture-user";

/** One event the view probe printed (`cu-live-viewprobe`). */
export interface ProbeEvent { t: number; ev: string; targetId?: string; appName?: string; blank?: boolean; bytes?: number; stddevLuma?: number; sentinelPixels?: number }

/** `cu-live-tool image-stats` on one screenshot the daemon returned (its own pixels). */
export interface ImageStats { file: string; width: number; height: number; stddevLuma: number; blank: boolean; sentinelPixels: number; error?: string }

/** The fixture's sentinel: a solid #FF00FF block in every window — a screenshot of the window must contain it. */
export const SENTINEL_MIN_PIXELS = 200;

export interface VerifyContext {
  output: string;
  isError: boolean;
  facts: Record<string, unknown>;
  /** Fixture log events (both roles) — the scenario's own start is `since`. */
  events: readonly FixtureEvent[];
  since: number;
  /** The main fixture's `state` dump taken after the action, when the scenario asked for one. */
  state?: Record<string, unknown>;
  /** View probe events since the scenario started (main session only). */
  probe: readonly ProbeEvent[];
  /** `automation-metrics.jsonl` lines since the scenario started. */
  metrics: readonly Record<string, unknown>[];
  /** The screenshots the daemon returned since the scenario started, judged by their own pixels. */
  shots: readonly ImageStats[];
  /** A `desktopSwitch` scenario: what the runner saw of the desktop-switch prompt (absent otherwise). */
  prompt?: PromptObservation;
}

/**
 * The desktop-switch prompt as the runner saw it (user ruling 2026-10-10): the session's card(s) that default-allow,
 * and the helper's own on-screen panel — a NEW on-screen window of the helper while the card waited (`panelSeen`),
 * gone once it was answered (`panelGone`).
 */
export interface PromptObservation {
  cards: ReadonlyArray<{ toolName?: string; summary?: string; onTimeout?: string; expiresAt?: number; issuedAt?: number }>;
  panelSeen: boolean;
  panelGone: boolean;
}

/** The helper's own process name — the owner of its on-screen prompt panel in the window list. */
export const HELPER_OWNER = "Winter Computer Use Dev";
/** How long the user may be away from their desktop during ONE visit (arrive ≤ ~1.5 s, a fresh frame ≤ ~1 s, the
 *  capture, the return): the suite's bound, with each run's real figure in the scenario's note. */
export const DESKTOP_VISIT_MAX_AWAY_MS = 3_000;
/** The reason the live-screenshot scenarios give (it must reach the prompt verbatim). */
export const LIVE_REASON = "to see what the window shows right now";

export interface FixtureCommand { role: "main" | "user"; cmd: string; args?: Record<string, unknown> }

export type PrepareStep =
  | { cmd: string; args?: Record<string, unknown>; waitFor?: string }
  | { turn: string }
  | { returnUser: true };

export interface Scenario {
  name: string;
  group: string;
  /** Fixture commands sent (and acknowledged) before the action. */
  before?: FixtureCommand[];
  /** The ComputerV2 script (the prelude is prepended). */
  code: string;
  timeoutMs?: number;
  /** Dump the main fixture's state after the action (passed as `state`). */
  dump?: boolean;
  /**
   * Which session: the `bypass` one (default), the `ask` one (its cards are answered by the runner), or a FRESH
   * `bypass` session of its own (no target an earlier scenario bound is reused).
   */
  session?: "main" | "ask" | "fresh";
  /**
   * SETUP before the action, not asserted (the focus/input checks start after it): fixture commands (each waited for
   * by the fixture event it logs), ComputerV2 turns in a fresh session of their own, and putting the user back in
   * front on their Space (a full-screen change moves them).
   */
  prepare?: PrepareStep[];
  /** The approval answer for an `ask` scenario's card(s): an option id, or false to deny. */
  answer?: "once" | "session" | "always" | false;
  /**
   * A scenario that provokes the fixture into activating itself: a jump-and-back is then the subject, so the focus
   * check allows one excursion no longer than this many ms (and still demands the original app at the end).
   */
  allowExcursionMs?: number;
  /** In the ask session: a foreground card (denied by the rig) is expected besides the per-app card. */
  foregroundCard?: boolean;
  /**
   * The USER switches app mid-run: this many ms into the action the runner brings Finder (an app the agent never
   * touched) to the front, and the focus check becomes "that switch held — never pulled back".
   */
  userSwitchAfterMs?: number;
  /** The script prelude (default PRELUDE; the generic app checks bring their own, which includes it). */
  prelude?: string;
  /**
   * THE DESKTOP SWITCH (user ruling 2026-10-10): the action raises the desktop-switch prompt. The runner answers its
   * card (`approval_requested` with `onTimeout: "allow"`) after `afterMs` — `allow` (Switch now) or `refuse` — and
   * looks for the helper's on-screen panel while it waits and after the answer (`VerifyContext.prompt`).
   */
  desktopSwitch?: { answer: "allow" | "refuse"; afterMs: number };
  /** With `allowExcursionMs`: at most this many separate excursions (the open visit's "not back and forth", 5d). */
  maxExcursions?: number;
  verify(ctx: VerifyContext): Check[];
}

/** Defined at the top of every script — top-level declarations persist and may be redeclared (the REPL rule). */
export const PRELUDE = `
var H = (typeof H !== "undefined" && H) || new Map();
async function win(title) {
  if (!H.has(title)) H.set(title, await apps.open(${JSON.stringify(FIXTURE_APP)}, { window: title }));
  return H.get(title);
}
async function pick(app, name, role) {
  const els = await app.find(name, { emit: false });
  // A label is never what a scenario acts on: "text" must not match the static text "Notes" beside the text area.
  const fits = (e) => role === undefined ? e.role !== "static text" : e.role.includes(role) && (role === "static text" || e.role !== "static text");
  const hit = els.find((e) => fits(e) && e.name === name) || els.find((e) => fits(e) && (e.name || "").includes(name)) || els.find(fits);
  if (!hit) throw new Error("no " + (role || "element") + " named " + name + ": " + JSON.stringify(els.slice(0, 8)));
  return hit;
}
// The web window, once its page shows the "First" field (state() retried for up to 5 s) — a page still loading has
// no fields yet. The runner also waits for the fixture's WKWebView didFinish before any scenario that calls this.
async function webWin() {
  const web = await win("Fixture Web");
  const t0 = Date.now();
  for (;;) {
    if (/text field ["\u201C]First["\u201D]/.test(await web.state({ emit: false, full: true }))) return web;
    if (Date.now() - t0 > 5000) throw new Error("the fixture page didn't load");
    await sleep(250);
  }
}
// The Docs-like window, once its page shows the hidden "Document content" input (state() retried for up to 5 s).
// The runner also waits for the page's own ready message before any scenario that calls this.
async function docsWin() {
  const docs = await win("Fixture Docs");
  const t0 = Date.now();
  for (;;) {
    if ((await docs.state({ emit: false, full: true })).includes("Document content")) return docs;
    if (Date.now() - t0 > 5000) throw new Error("the docs page didn't load");
    await sleep(250);
  }
}
function report(o) { print(${JSON.stringify(MARKER)} + " " + JSON.stringify(o)); }
`;

/** Whether a scenario works in the Docs-like page (it calls `docsWin()`): the runner first waits for its ready message. */
export function usesDocsPage(s: Pick<Scenario, "code">): boolean {
  return s.code.includes("docsWin()");
}

/** Whether a scenario works in the web window's page (it calls `webWin()`): the runner first waits for didFinish. */
export function usesWebPage(s: Pick<Scenario, "code">): boolean {
  return s.code.includes("webWin()");
}

export function scriptOf(s: Pick<Scenario, "code" | "prelude">): string {
  return `${s.prelude ?? PRELUDE}\n${s.code.trim()}\n`;
}

const ok = (ctx: VerifyContext): Check => check("the script ran without an error", !ctx.isError, ctx.output.slice(-300));
const fact = (ctx: VerifyContext, key: string): unknown => ctx.facts[key];
const has = (events: readonly FixtureEvent[], since: number, ev: string, match: (e: FixtureEvent) => boolean, role = "main"): boolean =>
  eventsSince(events, since, ev, role).some(match);
const webState = (ctx: VerifyContext): Record<string, unknown> => (ctx.state?.web !== null && typeof ctx.state?.web === "object" ? ctx.state.web as Record<string, unknown> : {});

/** Frames for the targets this scenario bound: some arrived, none blank, and no target was announced twice. */
function mirrorChecks(ctx: VerifyContext, app: string): Check[] {
  const bound = ctx.probe.filter((p) => p.ev === "bound" && (p.appName ?? app) === app);
  const ids = new Set(bound.map((b) => b.targetId));
  const frames = ctx.probe.filter((p) => p.ev === "frame" && ids.has(p.targetId));
  const blank = frames.filter((f) => f.blank === true);
  const repeats = [...ids].filter((id) => bound.filter((b) => b.targetId === id).length > 1);
  return [
    check("the mirror announced the bound window (view.bound)", bound.length > 0, "no view.bound since the bind"),
    check("mirror frames arrived for it", frames.length > 0, "no view.frame for the bound target"),
    check("no blank mirror frame (no flash)", blank.length === 0, `${blank.length} of ${frames.length} frames blank`),
    check("no repeat view.bound for one target", repeats.length === 0, `repeated: ${repeats.join(", ")}`),
    check("the mirror frames show the window's sentinel", frames.some((f) => (f.sentinelPixels ?? 0) > 0), `sentinel pixels ${frames.map((f) => f.sentinelPixels ?? 0).join(",")}`),
  ];
}

/** The screenshot's OWN pixels (the daemon's test sink): decoded, not blank, and the window's sentinel is in it. */
function screenshotChecks(ctx: VerifyContext): Check[] {
  const shots = ctx.shots.filter((s) => s.error === undefined);
  const describe = shots.map((s) => `${s.width}x${s.height} σ${s.stddevLuma.toFixed(1)} sentinel ${s.sentinelPixels}`).join("; ");
  return [
    check("the screenshot was returned and decodes", shots.length > 0, ctx.shots.map((s) => s.error ?? "").join("; ") || "no screenshot written"),
    check("its pixels are not blank", shots.length > 0 && shots.every((s) => !s.blank), describe),
    check(`it shows the fixture's sentinel block (≥ ${SENTINEL_MIN_PIXELS} #FF00FF pixels)`, shots.length > 0 && shots.every((s) => s.sentinelPixels >= SENTINEL_MIN_PIXELS), describe),
  ];
}

/** The desktop-switch prompt: ONE card that default-allows, naming the app, its bundle id and the reason, and the
 *  helper's own panel on the user's desktop while it waited — closed once answered. */
function promptChecks(ctx: VerifyContext): Check[] {
  const p = ctx.prompt;
  const cards = p?.cards ?? [];
  const c = cards[0];
  return [
    check("ONE desktop-switch card that default-allows (onTimeout: allow, a minute)", cards.length === 1 && c?.toolName === "ComputerV2" && c?.onTimeout === "allow"
      && typeof c?.expiresAt === "number" && typeof c?.issuedAt === "number" && c.expiresAt - c.issuedAt === 60_000, JSON.stringify(cards)),
    check("it names the app, its bundle id and the reason", (c?.summary ?? "").includes(`${FIXTURE_APP} (${FIXTURE_BUNDLE})`) && (c?.summary ?? "").includes(LIVE_REASON), String(c?.summary)),
    check("the helper's own prompt appeared on your desktop while it waited", p?.panelSeen === true, "no new on-screen window of the helper"),
    check("…and closed once the card was answered", p?.panelGone === true, "the helper's prompt window was still on screen"),
  ];
}

/** The metrics line of the scenario's live screenshot. */
const liveShotMetric = (ctx: VerifyContext): Record<string, unknown> | undefined =>
  ctx.metrics.find((m) => m.primitive === "screenshot" && m.visitAnswer !== undefined);

const DOC_TEXT = "Doc line: Mixed CASE ✓ ünï 日本 & <tag> 100%";
/** ~3,000 characters over many lines: a paste that, typed as keys, ran out a 30 s script (the live failure). */
const LONG_PASTE = Array.from({ length: 60 }, (_, i) => `Line ${String(i + 1).padStart(2, "0")}: the quick brown fox jumps over the lazy dog.`).join("\n");
const squash = (s: string): string => s.replace(/\s+/g, " ").trim();
const PASTE_TEXT = "Pasted ✓ «text» — 2026";
const OFFSPACE_TEXT = "off-Space ✓ Typed";
/** Typed into the Docs-like page's hidden input: mixed case, symbols, non-ASCII, one line. */
export const DOCS_TEXT = "Docs ✓ Typed: Mixed CASE ünï 日本 #42 (ok)";
/** Dashes a layout types with Option (an em and an en dash): they must reach the page as text, never as chords. */
export const DOCS_DASH_TEXT = "Plan — v2 – final";
/** Several lines, typed (not pasted) into an editor that can't be read back. */
export const DOCS_LINES_TEXT = "line one\nline two";
export const DOCS_SHORT_PASTE = "filler check";
/** Exactly 3,000 characters over many lines, for the big paste. */
export const DOCS_BIG_PASTE = (() => {
  const lines: string[] = [];
  for (let i = 1; lines.join("\n").length < 3_000; i++) lines.push(`Line ${String(i).padStart(3, "0")} — the quick brown fox ✓ jumps over ${i} lazy dogs; ünï 日本.`);
  return lines.join("\n").slice(0, 3_000);
})();

/** The Docs-like page's events since the scenario started (`docs.<type>`, main fixture). */
function docsEvents(ctx: VerifyContext, type: string): FixtureEvent[] {
  return eventsSince(ctx.events, ctx.since, `docs.${type}`);
}
/** The page's model text: the dump's, else the last `docs.text` line. */
function docsText(ctx: VerifyContext): string | undefined {
  const d = ctx.state?.docs;
  if (d !== null && typeof d === "object" && typeof (d as Record<string, unknown>).text === "string") return (d as Record<string, string>).text;
  const last = docsEvents(ctx, "text").at(-1);
  return typeof last?.text === "string" ? last.text : undefined;
}
function docsState(ctx: VerifyContext): Record<string, unknown> {
  const d = ctx.state?.docs;
  return d !== null && typeof d === "object" ? d as Record<string, unknown> : {};
}
const refusedFor = (ctx: VerifyContext): string => String(ctx.facts.refused ?? "");

export const SCENARIOS: Scenario[] = [
  // ── binding ────────────────────────────────────────────────────────────────────────────────────────────────
  {
    name: "bind on-Space (Form, Web, Canvas)", group: "bind",
    code: `
const form = await win("Fixture Form");
const web = await webWin();
const canvas = await win("Fixture Canvas");
report({ bundleId: form.bundleId, windows: (await form.windows()).map((w) => w.title) });`,
    verify: (ctx) => [
      ok(ctx),
      check("bound the fixture by name", fact(ctx, "bundleId") === FIXTURE_BUNDLE, String(fact(ctx, "bundleId"))),
      check("windows() lists the fixture's windows", Array.isArray(fact(ctx, "windows")) && (fact(ctx, "windows") as string[]).includes("Fixture Web")),
      ...mirrorChecks(ctx, FIXTURE_APP),
    ],
  },
  // A full-screen window accessibility never saw on the active Space binds CAPTURE ONLY by design (macOS never
  // exposed its elements): the bind says so, a screenshot works, a point click lands, and keys go to the window — or
  // are refused (focus_not_placed) rather than sent blind.
  {
    name: "bind off-Space (full screen, never seen here): capture only", group: "bind",
    code: `
const off = await win("Fixture Offspace");
const s = await off.state({ emit: false, full: true });
const img = await off.screenshot({ emit: false });
const listed = (await screen.windows({ emit: false })).filter((w) => w.title === "Fixture Offspace");
report({ hasField: s.includes("Offspace Field"), noAxNote: /no accessibility here/i.test(s), w: img.width, h: img.height, onScreen: listed.map((w) => w.onScreen) });`,
    verify: (ctx) => [
      ok(ctx),
      check("bound capture only, with the \"no accessibility here\" note", /capture only/i.test(ctx.output) && fact(ctx, "noAxNote") === true, ctx.output.slice(0, 200)),
      check("its state lists no elements (no Offspace Field)", fact(ctx, "hasField") === false),
      check("screen.windows reports it off screen", Array.isArray(fact(ctx, "onScreen")) && (fact(ctx, "onScreen") as boolean[]).includes(false), JSON.stringify(fact(ctx, "onScreen"))),
      ...screenshotChecks(ctx),
      ...mirrorChecks(ctx, FIXTURE_APP),
    ],
  },
  {
    name: "act in the off-Space window (capture only): a point click, then keys", group: "bind",
    before: [{ role: "main", cmd: "steal", args: { mode: "off" } }],
    code: `
const off = await win("Fixture Offspace");
const img = await off.screenshot({ emit: false });
const frame = (await screen.windows({ emit: false })).find((w) => w.title === "Fixture Offspace")?.frame;
// The Offspace Field's centre is (232, 112) points from the content's top-left — the window's, in full screen —
// and a point is in the screenshot's pixels.
const sx = frame ? img.width / frame[2] : 1, sy = frame ? img.height / frame[3] : 1;
await off.click([Math.round(232 * sx), Math.round(112 * sy)]);
let typed = null;
try { await off.type(${JSON.stringify(OFFSPACE_TEXT)}); typed = "sent"; } catch (e) { typed = e.name + ": " + String(e.message).slice(0, 200); }
report({ typed, scale: [sx, sy] });`,
    verify: (ctx) => {
      const landed = lastValue(ctx.events, ctx.since, "field.change", "offspace");
      const typed = String(fact(ctx, "typed"));
      return [ok(ctx),
        check("the point click landed (the fixture logged the field's focus or the window becoming key)",
          has(ctx.events, ctx.since, "focus", (e) => e.id === "offspace") || has(ctx.events, ctx.since, "window.key", (e) => e.title === "Fixture Offspace"),
          JSON.stringify(eventsSince(ctx.events, ctx.since, "focus").concat(eventsSince(ctx.events, ctx.since, "window.key")).slice(-3))),
        check("the keys landed in the field, or were refused with focus_not_placed", landed === OFFSPACE_TEXT || /focus_not_placed|couldn't put the keyboard focus/i.test(typed),
          `field ${JSON.stringify(landed)}; type: ${typed}`)];
    },
  },
  // The same window first SHOWN on the user's Space — accessibility sees it there — then taken off-Space again: it
  // is AX-reachable, so a fresh bind (a session with no earlier target for it) is a full one.
  {
    name: "bind off-Space after it was shown on this desktop: a full bind", group: "bind", session: "fresh",
    prepare: [
      { cmd: "restoreSpace", waitFor: "offspace.restored" },
      { returnUser: true },
      { turn: `const shown = await apps.open(${JSON.stringify(FIXTURE_APP)}, { window: "Fixture Offspace" });
report({ seen: (await shown.state({ emit: false, full: true })).includes("Offspace Field") });` },
      { cmd: "offspace", waitFor: "offspace" },
      { returnUser: true },
    ],
    code: `
const off = await apps.open(${JSON.stringify(FIXTURE_APP)}, { window: "Fixture Offspace" });
const s = await off.state({ emit: false, full: true });
const listed = (await screen.windows({ emit: false })).filter((w) => w.title === "Fixture Offspace");
report({ hasField: s.includes("Offspace Field"), noAxNote: /no accessibility here/i.test(s), onScreen: listed.map((w) => w.onScreen) });`,
    verify: (ctx) => [
      ok(ctx),
      check("a full bind: not capture only", !/capture only/i.test(ctx.output) && fact(ctx, "noAxNote") === false, ctx.output.slice(0, 200)),
      check("its state reads the Offspace Field", fact(ctx, "hasField") === true),
      check("it is off this desktop again", Array.isArray(fact(ctx, "onScreen")) && (fact(ctx, "onScreen") as boolean[]).includes(false), JSON.stringify(fact(ctx, "onScreen"))),
    ],
  },
  // ── clicks ─────────────────────────────────────────────────────────────────────────────────────────────────
  {
    name: "AX press (Submit)", group: "click",
    code: `
const form = await win("Fixture Form");
const b = await pick(form, "Submit", "button");
await form.action(b.ref, "press");
report({ pressed: b.ref });`,
    verify: (ctx) => [ok(ctx), check("the fixture got the press", has(ctx.events, ctx.since, "button", (e) => e.id === "submit"))],
  },
  {
    name: "element click (Agree checkbox)", group: "click",
    before: [{ role: "main", cmd: "reset" }],
    code: `
const form = await win("Fixture Form");
const c = await pick(form, "Agree", "check box");
await form.click(c.ref);
report({ clicked: c.ref });`,
    verify: (ctx) => [ok(ctx), check("the checkbox was checked", has(ctx.events, ctx.since, "button", (e) => e.id === "agree" && e.checked === true))],
  },
  {
    name: "coordinate click on the canvas (window-targeted)", group: "click",
    code: `
const canvas = await win("Fixture Canvas");
const shot = await canvas.screenshot({ emit: false });
await canvas.click([Math.round(shot.width / 2), Math.round(shot.height / 2)]);
report({ w: shot.width, h: shot.height });`,
    verify: (ctx) => {
      const clicks = eventsSince(ctx.events, ctx.since, "canvas.mouse").filter((e) => e.button === "left");
      const c = clicks.at(-1);
      return [ok(ctx), check("the canvas got one left click", c !== undefined && c.clicks === 1, JSON.stringify(c)),
        check("the click landed inside the canvas", c !== undefined && Number(c.x) > 0 && Number(c.y) > 0, JSON.stringify(c))];
    },
  },
  {
    name: "double click on the canvas", group: "click",
    code: `
const canvas = await win("Fixture Canvas");
const shot = await canvas.screenshot({ emit: false });
await canvas.click([Math.round(shot.width / 3), Math.round(shot.height / 3)], { count: 2 });
report({ ok: true });`,
    verify: (ctx) => [ok(ctx), check("the canvas got a double click", has(ctx.events, ctx.since, "canvas.mouse", (e) => e.button === "left" && e.clicks === 2))],
  },
  {
    name: "right click on the canvas", group: "click",
    code: `
const canvas = await win("Fixture Canvas");
const shot = await canvas.screenshot({ emit: false });
await canvas.click([Math.round(shot.width / 2), Math.round(shot.height / 3)], { button: "right" });
await canvas.key("escape");
report({ ok: true });`,
    verify: (ctx) => [ok(ctx), check("the canvas got a right click", has(ctx.events, ctx.since, "canvas.mouse", (e) => e.button === "right"))],
  },
  {
    name: "context menu item (Canvas Red)", group: "click",
    code: `
const canvas = await win("Fixture Canvas");
const shot = await canvas.screenshot({ emit: false });
await canvas.click([Math.round(shot.width / 2), Math.round(shot.height / 2)], { button: "right" });
const item = await pick(canvas, "Canvas Red", "menu item");
await canvas.click(item.ref);
report({ item: item.name });`,
    verify: (ctx) => [ok(ctx), check("the context menu item ran", has(ctx.events, ctx.since, "context", (e) => e.item === "Canvas Red"))],
  },
  {
    // A button whose click changes only pixels, never anything accessibility shows: the press works, the helper must
    // see that in the pixels and NOT click it as well (a toggle would flip back, an action would run twice).
    name: "a press whose effect only shows in pixels is not repeated", group: "click",
    before: [{ role: "main", cmd: "reset" }],
    code: `
const web = await webWin();
const b = await pick(web, "Pixel Button", "button");
await web.click(b.ref);
report({ ok: true });`,
    verify: (ctx) => {
      const presses = eventsSince(ctx.events, ctx.since, "web.pixel");
      return [ok(ctx), check("pressed exactly once", presses.length === 1, JSON.stringify(presses))];
    },
  },
  {
    // Hover-only UI: a menu that opens on mouseenter (hover(), then its item), and a button that acts only once the
    // pointer has entered it (a click arrives by the hover path; an accessibility press alone would not arm it).
    name: "hover: a hover-revealed menu, and a button armed by the pointer entering it", group: "click",
    before: [{ role: "main", cmd: "reset" }],
    code: `
const web = await webWin();
const trigger = await pick(web, "Hover Menu", "button");
await web.hover(trigger.ref, { ms: 600 });
const item = await pick(web, "Hidden Item");
await web.click(item.ref);
const armed = await pick(web, "Armed Button", "button");
await web.click(armed.ref);
report({ ok: true });`,
    verify: (ctx) => [ok(ctx),
      check("hover() opened the menu", has(ctx.events, ctx.since, "web.hover", () => true)),
      check("its hidden item was clicked", eventsSince(ctx.events, ctx.since, "web.hoveritem").length === 1),
      check("the armed button acted exactly once", eventsSince(ctx.events, ctx.since, "web.armed").length === 1,
        JSON.stringify(eventsSince(ctx.events, ctx.since, "web.armed")))],
  },
  {
    // Google Docs' widgets act on a real mouse press: an accessibility press is ignored, and the helper must notice
    // (nothing changed) and click the element instead — pressing it exactly once.
    name: "a web button that ignores accessibility presses (acts on a real mouse press)", group: "click",
    before: [{ role: "main", cmd: "reset" }],
    code: `
const web = await webWin();
const b = await pick(web, "Closure Button", "button");
await web.click(b.ref);
report({ ok: true });`,
    verify: (ctx) => {
      const presses = eventsSince(ctx.events, ctx.since, "web.closure");
      return [ok(ctx), check("it was pressed exactly once", presses.length === 1, JSON.stringify(presses))];
    },
  },
  // ── typing ─────────────────────────────────────────────────────────────────────────────────────────────────
  {
    name: "type into a native field (exact text)", group: "type",
    before: [{ role: "main", cmd: "reset" }],
    code: `
const form = await win("Fixture Form");
const name = await pick(form, "Name", "text field");
await form.type(${JSON.stringify(MIXED_TEXT)}, { into: name.ref });
report({ ok: true });`,
    dump: true,
    verify: (ctx) => [ok(ctx),
      check("the Name field holds the exact text", ctx.state?.name === MIXED_TEXT, JSON.stringify(ctx.state?.name)),
      check("the user's app received no keys", eventsSince(ctx.events, ctx.since, "user.key", "user").length === 0)],
  },
  {
    name: "type into web inputs (exact text)", group: "type",
    before: [{ role: "main", cmd: "reset" }],
    code: `
const web = await webWin();
const first = await pick(web, "First", "text");
await web.type(${JSON.stringify(MIXED_TEXT)}, { into: first.ref });
const search = await pick(web, "Search", "text");
await web.type("search term", { into: search.ref });
const comment = await pick(web, "Comment", "text");
await web.type("line one", { into: comment.ref });
report({ ok: true });`,
    dump: true,
    verify: (ctx) => [ok(ctx),
      check("First holds the exact text", webState(ctx).first === MIXED_TEXT, JSON.stringify(webState(ctx).first)),
      check("Search holds its text", webState(ctx).search === "search term", JSON.stringify(webState(ctx).search)),
      check("Comment holds its text", webState(ctx).comment === "line one", JSON.stringify(webState(ctx).comment))],
  },
  {
    name: "type into a contenteditable doc", group: "type",
    before: [{ role: "main", cmd: "reset" }],
    code: `
const web = await webWin();
const doc = await pick(web, "Doc");
await web.type(${JSON.stringify(DOC_TEXT)}, { into: doc.ref });
report({ ok: true });`,
    dump: true,
    verify: (ctx) => [ok(ctx), check("the doc holds the exact text", String(webState(ctx).doc ?? "").trim() === DOC_TEXT, JSON.stringify(webState(ctx).doc))],
  },
  {
    // In the ASK session: the per-app card is approved (once); the foreground card a background ⌘Z may raise is
    // denied by the rig — so ⌘Z either is undone for real (verified) or answers NeedsForeground, never a silent
    // no-op.
    name: "cmd+a/c/v/z in web fields", group: "type", session: "ask", answer: "once", foregroundCard: true,
    before: [{ role: "main", cmd: "reset" }],
    code: `
const web = await webWin();
const first = await pick(web, "First", "text");
const search = await pick(web, "Search", "text");
await web.type("copy me ✓", { into: first.ref });
await web.type("old", { into: search.ref });
await web.key("cmd+a", { into: first.ref });
await web.key("cmd+c", { into: first.ref });
await web.key("cmd+a", { into: search.ref });
await web.key("cmd+v", { into: search.ref });
const pasted = (await web.find({ name: "Search" }, { emit: false }))[0]?.value ?? null;
let undo = "done";
try { await web.key("cmd+z", { into: search.ref }); } catch (e) { undo = e.name; }
report({ pasted, undo });`,
    dump: true,
    verify: (ctx) => [ok(ctx),
      check("cmd+a/c/v copied First into Search", lastValueEver(ctx.events, ctx.since, "web.input", "search", "copy me ✓"), JSON.stringify(fact(ctx, "pasted"))),
      check("cmd+z undid the paste (verified), or said it needs the foreground — never a silent no-op",
        fact(ctx, "undo") === "NeedsForeground" || (fact(ctx, "undo") === "done" && webState(ctx).search === "old"),
        `undo: ${JSON.stringify(fact(ctx, "undo"))}, search: ${JSON.stringify(webState(ctx).search)}`)],
  },
  {
    name: "paste into a web field", group: "type",
    before: [{ role: "main", cmd: "reset" }],
    code: `
const web = await webWin();
const comment = await pick(web, "Comment", "text");
await web.paste(${JSON.stringify(PASTE_TEXT)}, { into: comment.ref });
report({ ok: true });`,
    dump: true,
    verify: (ctx) => [ok(ctx), check("Comment holds the pasted text", String(webState(ctx).comment ?? "").includes(PASTE_TEXT), JSON.stringify(webState(ctx).comment))],
  },
  {
    // The real paste (Edit › Paste in the focus blip), never thousands of keys: well inside the default 30 s.
    name: "paste ~3,000 characters into a contenteditable doc", group: "type",
    before: [{ role: "main", cmd: "reset" }],
    code: `
const web = await webWin();
const doc = await pick(web, "Doc");
const t0 = Date.now();
await web.paste(${JSON.stringify(LONG_PASTE)}, { into: doc.ref });
report({ ms: Date.now() - t0 });`,
    dump: true,
    verify: (ctx) => [ok(ctx),
      check("it took seconds, not a key per character", Number(fact(ctx, "ms")) < 10_000, `${String(fact(ctx, "ms"))} ms`),
      check("the doc holds all of it", squash(String(webState(ctx).doc ?? "")) === squash(LONG_PASTE),
        `${String(webState(ctx).doc ?? "").length} characters`)],
  },
  // ── scrolling ──────────────────────────────────────────────────────────────────────────────────────────────
  {
    name: "scroll by wheel (web page)", group: "scroll",
    before: [{ role: "main", cmd: "reset" }],
    code: `
const web = await webWin();
const area = (await web.find({ role: "web area" }, { emit: false }))[0];
if (!area) throw new Error("no web area");
await web.scroll(area.ref, "down", 2);
report({ ok: true });`,
    dump: true,
    verify: (ctx) => [ok(ctx), check("the page scrolled down", Number(webState(ctx).scrollY ?? 0) > 50, `scrollY ${String(webState(ctx).scrollY)}`)],
  },
  {
    name: "scroll by keys (web page, End)", group: "scroll",
    before: [{ role: "main", cmd: "reset" }],
    code: `
const web = await webWin();
const button = await pick(web, "Web Button", "button");
await web.key("end", { into: button.ref });
report({ ok: true });`,
    dump: true,
    verify: (ctx) => [ok(ctx), check("End scrolled the page far down", Number(webState(ctx).scrollY ?? 0) > 400, `scrollY ${String(webState(ctx).scrollY)}`)],
  },
  {
    name: "scroll by the scroll bar itself (Notes, not a wheel)", group: "scroll",
    before: [{ role: "main", cmd: "reset" }],
    code: `
const form = await win("Fixture Form");
const notes = await pick(form, "Notes", "text area");
await form.setValue(notes.ref, Array.from({ length: 120 }, (_, i) => "line " + (i + 1)).join("\\n"));
await form.state({ emit: false });
const bars = (await form.find({ role: "scroll bar" }, { emit: false })).filter((b) => !(b.states || []).includes("disabled"));
const bar = bars.find((b) => (b.name || "").toLowerCase().includes("vertical")) || bars[0];
if (!bar) throw new Error("no enabled scroll bar: " + JSON.stringify(await form.find({ role: "scroll bar" }, { emit: false })));
// The bar's own parts (value indicator, arrows, page areas) — what state() lists under it.
const parts = (await form.state({ emit: false, full: true, within: bar.ref })).split("\\n")
  .map((l) => l.match(/^\\s*\\[(\\d+)\\] (value indicator|increment arrow|increment page|button)\\b/)).filter(Boolean).map((m) => ({ ref: Number(m[1]), role: m[2] }));
let route = null;
const tried = [];
const attempt = async (name, f) => { if (route !== null) return; try { await f(); route = name; } catch (e) { tried.push(name + ": " + e.name + " " + String(e.message).slice(0, 100)); } };
await attempt("setValue on the bar", () => form.setValue(bar.ref, "0.7"));
const indicator = parts.find((p) => p.role === "value indicator");
if (indicator) await attempt("setValue on the value indicator", () => form.setValue(indicator.ref, "0.7"));
const arrow = parts.find((p) => p.role === "increment arrow");
if (arrow) await attempt("press the increment arrow", () => form.click(arrow.ref));
for (const p of parts.filter((p) => p.role === "increment page" || p.role === "button")) await attempt("press page area [" + p.ref + "]", () => form.click(p.ref));
report({ route, tried, parts });`,
    verify: (ctx) => {
      const moved = eventsSince(ctx.events, ctx.since, "scroller").filter((e) => e.id === "notes" && e.byWheel === false && Number(e.value) > 0);
      return [ok(ctx),
        check("a scroll-bar route was available", fact(ctx, "route") !== null, JSON.stringify(fact(ctx, "tried"))),
        check("the scroller moved without a wheel event", moved.length > 0, JSON.stringify(eventsSince(ctx.events, ctx.since, "scroller").slice(-3)))];
    },
  },
  // ── menus ──────────────────────────────────────────────────────────────────────────────────────────────────
  {
    name: "menu item enabled only for a selection (background)", group: "menu",
    before: [{ role: "main", cmd: "reset" }],
    code: `
const form = await win("Fixture Form");
const notes = await pick(form, "Notes", "text area");
await form.setValue(notes.ref, "make me loud please");
await form.select(notes.ref, "loud");
await form.menu(["Fixture", "Uppercase Selection"]);
report({ ok: true });`,
    dump: true,
    verify: (ctx) => [ok(ctx),
      check("the menu command ran", has(ctx.events, ctx.since, "menu", (e) => e.title === "Uppercase Selection")),
      check("it uppercased exactly the selection", ctx.state?.notes === "make me LOUD please", JSON.stringify(ctx.state?.notes))],
  },
  // ── AppleScript ────────────────────────────────────────────────────────────────────────────────────────────
  {
    name: "AppleScript (no Apple Event) and its refusals", group: "applescript",
    code: `
const form = await win("Fixture Form");
const r = await form.applescript('return "winter" & " " & (2 + 3)', { emit: false });
let shell = null, other = null, jxa = null;
try { await form.applescript('do shell script "id"', { emit: false }); } catch (e) { shell = e.name; }
try { await form.applescript('tell application "Finder" to get name of startup disk', { emit: false }); } catch (e) { other = e.name; }
const dict = await form.scriptingDictionary({ emit: false });
report({ result: r.result, shell, other, scriptable: dict.scriptable });`,
    verify: (ctx) => [ok(ctx),
      // The result comes back as AppleScript writes the value (a string quoted, `"winter 5"`); either form counts.
      check("a script with no Apple Event ran", fact(ctx, "result") === "winter 5" || fact(ctx, "result") === '"winter 5"', String(fact(ctx, "result"))),
      check("do shell script is refused", fact(ctx, "shell") === "Refused" || fact(ctx, "shell") === "NotAllowed", String(fact(ctx, "shell"))),
      check("another app is refused", fact(ctx, "other") === "Refused" || fact(ctx, "other") === "NotAllowed", String(fact(ctx, "other"))),
      check("scriptingDictionary answers", typeof fact(ctx, "scriptable") === "boolean")],
  },
  // ── screenshots ────────────────────────────────────────────────────────────────────────────────────────────
  {
    name: "screenshot on-Space", group: "screenshot",
    code: `
const canvas = await win("Fixture Canvas");
const img = await canvas.screenshot({ emit: false });
report({ w: img.width, h: img.height });`,
    verify: (ctx) => [ok(ctx), ...screenshotChecks(ctx), check("a real size", Number(fact(ctx, "w")) > 100 && Number(fact(ctx, "h")) > 100)],
  },
  {
    name: "screenshot off-Space", group: "screenshot",
    code: `
const off = await win("Fixture Offspace");
const img = await off.screenshot({ emit: false });
report({ w: img.width, h: img.height });`,
    verify: (ctx) => [ok(ctx), ...screenshotChecks(ctx), check("a real size", Number(fact(ctx, "w")) > 100 && Number(fact(ctx, "h")) > 100)],
  },
  // ── the desktop switch (user ruling 2026-10-10) ─────────────────────────────────────────────────────────────
  // A LIVE picture of a window on another desktop can only be had there: the user is ASKED (the card and the helper's
  // on-screen panel), then moved there for that one capture and straight back. Refused: nothing moves at all. These
  // run after the capture-only rows (a visit shows the window on screen, after which accessibility may see it).
  {
    name: "desktop switch: a live screenshot off-Space, refused — NeedsForeground, nothing moved", group: "desktop-switch",
    desktopSwitch: { answer: "refuse", afterMs: 1_000 },
    code: `
const off = await win("Fixture Offspace");
// A still first, right here: the live shot's own still then has a previous one to compare with (unchanged → it needs
// the visit), whatever earlier scenarios did.
await off.screenshot({ emit: false });
try {
  const img = await off.screenshot({ emit: false, live: true, reason: ${JSON.stringify(LIVE_REASON)} });
  report({ shot: true, w: img.width });
} catch (e) { report({ error: e.name, message: e.message }); }`,
    verify: (ctx) => [
      ok(ctx),
      ...promptChecks(ctx),
      check("the screenshot failed with NeedsForeground, saying the user refused and to ask them", fact(ctx, "error") === "NeedsForeground"
        && /refused to be moved to .*'s desktop — ask them in your reply/.test(String(fact(ctx, "message"))), `${String(fact(ctx, "error"))}: ${String(fact(ctx, "message"))}`),
      check("no visit was made (metrics)", ctx.metrics.every((m) => m.primitive !== "desktop.visit") && liveShotMetric(ctx)?.visitAnswer === "refuse", JSON.stringify(liveShotMetric(ctx))),
    ],
  },
  {
    // 5d: two live shots back to back are ONE open visit — one switch, both captured there, one return (a moment after
    // the second), one line and one metrics entry with 2 actions. (The refused row's "Don't switch" was lifted by this
    // row's own turn: a message from the runner's client is a human-origin message.)
    name: "desktop switch: two live screenshots off-Space — the prompt, ONE visit for both, the user back on their desktop", group: "desktop-switch",
    desktopSwitch: { answer: "allow", afterMs: 1_500 },
    allowExcursionMs: DESKTOP_VISIT_MAX_AWAY_MS,
    maxExcursions: 1,
    code: `
const off = await win("Fixture Offspace");
await off.screenshot({ emit: false });  // a still first (see the refused row)
const img = await off.screenshot({ emit: false, live: true, reason: ${JSON.stringify(LIVE_REASON)} });
const again = await off.screenshot({ emit: false, live: true, reason: ${JSON.stringify(LIVE_REASON)} });
report({ w: img.width, h: img.height, w2: again.width });`,
    verify: (ctx) => {
      const visits = ctx.metrics.filter((m) => m.primitive === "desktop.visit");
      const visit = visits[0]?.visit as { actions?: number; ms?: number; returned?: boolean } | undefined;
      return [
        ok(ctx), ...screenshotChecks(ctx), ...promptChecks(ctx),
        check("the result says it in ONE line: moved there for both and back", (ctx.output.match(/moved the user to /g) ?? []).length === 1
          && new RegExp(`moved the user to ${FIXTURE_APP}'s desktop for [\\d.]+ m?s \\(2 actions\\) and back`).test(ctx.output), ctx.output.slice(0, 400)),
        check("ONE visit with both shots in it, the user verified back (metrics)", visits.length === 1 && visit?.actions === 2 && visit?.returned === true
          && liveShotMetric(ctx)?.visitAnswer === "allow", JSON.stringify(visits)),
        check("a real size", Number(fact(ctx, "w")) > 100 && Number(fact(ctx, "h")) > 100 && Number(fact(ctx, "w2")) > 100),
      ];
    },
  },
  {
    // The guardian protects the user FROM the agent, never from themselves: an app the agent never touched coming
    // forward mid-run (the user switching to it) is never pulled back.
    name: "guardian: the user switching to another app mid-run is left alone", group: "guardian",
    before: [{ role: "main", cmd: "reset" }],
    userSwitchAfterMs: 1_200,
    code: `
const form = await win("Fixture Form");
const email = await pick(form, "Email", "text field");
await form.click(email.ref);
for (let i = 0; i < 6; i++) { await form.state({ emit: false }); await sleep(500); }
report({ ok: true });`,
    verify: (ctx) => [ok(ctx)],
  },
  // ── the focus guardian ─────────────────────────────────────────────────────────────────────────────────────
  {
    name: "guardian: the app activates itself on field focus", group: "guardian",
    before: [{ role: "main", cmd: "reset" }, { role: "main", cmd: "steal", args: { mode: "focus" } }],
    code: `
const form = await win("Fixture Form");
const email = await pick(form, "Email", "text field");
await form.click(email.ref);
await form.type("steal@test", { into: email.ref });
report({ ok: true });`,
    allowExcursionMs: 400,
    verify: (ctx) => [ok(ctx),
      check("the fixture tried to activate itself", has(ctx.events, ctx.since, "activated", (e) => e.reason === "steal-focus"), "no steal attempt logged — the trigger did not fire"),
      check("the text still arrived", lastValue(ctx.events, ctx.since, "field.change", "email") === "steal@test")],
  },
  {
    name: "guardian: a delayed self-activation 1 s later", group: "guardian",
    before: [{ role: "main", cmd: "steal", args: { mode: "delayed" } }],
    code: `
const canvas = await win("Fixture Canvas");
const shot = await canvas.screenshot({ emit: false });
await canvas.click([Math.round(shot.width / 4), Math.round(shot.height / 2)]);
await sleep(1500);
report({ ok: true });`,
    allowExcursionMs: 400,
    verify: (ctx) => [ok(ctx), check("the fixture tried to activate itself 1 s later", has(ctx.events, ctx.since, "activated", (e) => e.reason === "steal-delayed"), "no delayed steal logged")],
  },
  // ── document open ──────────────────────────────────────────────────────────────────────────────────────────
  {
    name: "document open without activation", group: "document",
    before: [{ role: "main", cmd: "steal", args: { mode: "off" } }],
    code: `
const form = await win("Fixture Form");
const b = await pick(form, "Open Document", "button");
await form.action(b.ref, "press");
const w = await form.waitFor({ title: "Document" }, { timeoutMs: 5000 }).catch((e) => ({ error: e.name }));
report({ waited: w });`,
    verify: (ctx) => [ok(ctx),
      check("the document opened", has(ctx.events, ctx.since, "doc.window", () => true)),
      check("the app did not activate itself", !has(ctx.events, ctx.since, "activated", () => true))],
  },
  {
    name: "document open by an app that activates on open", group: "document",
    before: [{ role: "main", cmd: "steal", args: { mode: "focus" } }],
    code: `
const form = await win("Fixture Form");
const b = await pick(form, "Open Document", "button");
await form.action(b.ref, "press");
await sleep(800);
report({ ok: true });`,
    allowExcursionMs: 400,
    verify: (ctx) => [ok(ctx),
      check("the document opened", has(ctx.events, ctx.since, "doc.window", () => true)),
      check("the app tried to activate on open", has(ctx.events, ctx.since, "activated", (e) => e.reason === "doc-open"))],
  },
  // ── a Docs-like page (Google Docs' failure modes, offline) ─────────────────────────────────────────────────
  // Written against the CONTRACT (the receiver named, the press fallback said, wrong-shaped and non-editable focus
  // refused, the focus move reported, the real paste route), not against whatever the helper does today.
  {
    name: "Docs: type into the doc through its hidden input", group: "docs",
    before: [{ role: "main", cmd: "reset" }],
    code: `
const docs = await docsWin();
const canvas = await pick(docs, "Document canvas");
await docs.click(canvas.ref);
await docs.type(${JSON.stringify(DOCS_TEXT)});
await sleep(300);
report({ typed: true });`,
    dump: true,
    verify: (ctx) => [ok(ctx),
      check("the click put the focus in the hidden input (fixture log)", docsEvents(ctx, "focus").some((e) => e.id === "doc"), JSON.stringify(docsEvents(ctx, "focus").slice(-3))),
      check("the exact text arrived (the page's model)", docsText(ctx) === DOCS_TEXT, JSON.stringify(docsText(ctx))),
      check("the result names the receiver (the window's focus, or Docs' hidden input)", /sent [\d,]+ characters? to \S/.test(ctx.output) || /hidden (text )?input/i.test(ctx.output), ctx.output.slice(0, 300)),
      check("the result says the text can't be read back", /can'?t be read back|cannot be read back|can not be read back/i.test(ctx.output), ctx.output.slice(0, 300))],
  },
  {
    name: "Docs: press a Closure-style Close button (it ignores click)", group: "docs",
    before: [{ role: "main", cmd: "reset" }, { role: "main", cmd: "docsOpenFind" }],
    code: `
const docs = await docsWin();
const close = (await docs.find({ role: "button", name: "Close" }, { emit: false })).find((e) => e.name === "Close");
if (!close) throw new Error("no Close button: " + JSON.stringify(await docs.find("Close", { emit: false })));
await docs.click(close.ref);
await sleep(300);
report({ pressed: close.ref });`,
    dump: true,
    verify: (ctx) => {
      const fellBack = /did nothing|clicked (it )?instead|click(ed)? with the pointer|mouse (down|events)/i.test(ctx.output);
      const mouse = docsEvents(ctx, "mouse").filter((e) => e.id === "find-close").map((e) => e.phase);
      // WebKit's accessibility press is itself a mousedown + mouseup + click (the button's ignored `click` is logged
      // either way), so the press log alone can't tell. The helper clicked instead when the click's own rung (its
      // metric) is an event rung (2+) — or the button got a second press; then the result must say so.
      const presses = mouse.filter((p) => p === "down").length;
      const clickRung = ctx.metrics.filter((m) => m.primitive === "click").map((m) => Number(m.rung)).find((r) => Number.isFinite(r));
      const clickedInstead = presses >= 2 || (clickRung !== undefined && clickRung >= 2);
      return [ok(ctx),
        check("the panel closed (fixture log)", docsEvents(ctx, "panel").some((e) => e.open === false) && docsState(ctx).panelOpen === false, JSON.stringify(docsEvents(ctx, "panel"))),
        check("the button got a mousedown and a mouseup", mouse.includes("down") && mouse.includes("up"), JSON.stringify(mouse)),
        check("the result says the AX press did nothing and it clicked instead (or the AX press itself worked)", !clickedInstead || fellBack,
          `${presses} presses, click rung ${String(clickRung)}; ${ctx.output.slice(0, 240)}`)];
    },
  },
  {
    name: "Docs: paste with no into, multi-line, into the single-line title — refused (wrong_field_shape)", group: "docs",
    before: [{ role: "main", cmd: "reset" }],
    code: `
const docs = await docsWin();
const title = await pick(docs, "Document title", "text field");
await docs.click(title.ref);
let refused = null;
try { await docs.paste("line one\\nline two"); } catch (e) { refused = e.name + ": " + String(e.message).slice(0, 300); }
report({ refused });`,
    dump: true,
    verify: (ctx) => [ok(ctx),
      check("the click put the focus in the title (fixture log)", docsEvents(ctx, "focus").some((e) => e.id === "title"), JSON.stringify(docsEvents(ctx, "focus").slice(-3))),
      check("refused: wrong_field_shape", /^Refused/.test(refusedFor(ctx)) && /wrong_field_shape|single[- ]line|multi[- ]?line|line break|one line/i.test(refusedFor(ctx)), refusedFor(ctx)),
      check("nothing was pasted", docsEvents(ctx, "title").length === 0 && docsEvents(ctx, "paste").length === 0 && (docsState(ctx).title === undefined || docsState(ctx).title === "Untitled document"), JSON.stringify(docsState(ctx).title))],
  },
  {
    name: "Docs: paste with no into, over 200 characters, into the search input — refused (wrong_field_shape)", group: "docs",
    before: [{ role: "main", cmd: "reset" }],
    code: `
const docs = await docsWin();
const search = await pick(docs, "Search the menus", "field");
await docs.click(search.ref);
let refused = null;
try { await docs.paste(${JSON.stringify("A long single line for a search box. ".repeat(7).trim())}); } catch (e) { refused = e.name + ": " + String(e.message).slice(0, 300); }
report({ refused });`,
    dump: true,
    verify: (ctx) => [ok(ctx),
      check("the click put the focus in the search input (fixture log)", docsEvents(ctx, "focus").some((e) => e.id === "page-search"), JSON.stringify(docsEvents(ctx, "focus").slice(-3))),
      check("refused: wrong_field_shape", /^Refused/.test(refusedFor(ctx)) && /wrong_field_shape|200|too long|single[- ]line|short field/i.test(refusedFor(ctx)), refusedFor(ctx)),
      check("nothing was pasted", docsEvents(ctx, "search").length === 0 && docsEvents(ctx, "paste").length === 0 && (docsState(ctx).search === undefined || docsState(ctx).search === ""), JSON.stringify(docsState(ctx).search))],
  },
  {
    name: "Docs: paste with no into while the HTML menu bar has the focus — refused (focus_not_editable)", group: "docs",
    before: [{ role: "main", cmd: "reset" }],
    code: `
const docs = await docsWin();
const edit = (await docs.find("Edit", { emit: false })).find((e) => /menu/.test(e.role) && e.name === "Edit");
if (!edit) throw new Error("no Edit menu in the page: " + JSON.stringify(await docs.find("Edit", { emit: false })));
await docs.click(edit.ref);
let refused = null;
try { await docs.paste("should not land anywhere"); } catch (e) { refused = e.name + ": " + String(e.message).slice(0, 300); }
report({ refused });`,
    dump: true,
    verify: (ctx) => [ok(ctx),
      check("the click put the focus on the menu bar (fixture log)", docsEvents(ctx, "focus").some((e) => e.id === "menu-edit"), JSON.stringify(docsEvents(ctx, "focus").slice(-3))),
      check("refused: focus_not_editable", /^Refused/.test(refusedFor(ctx)) && /focus_not_editable|not editable|isn'?t editable|not a text|can'?t take text/i.test(refusedFor(ctx)), refusedFor(ctx)),
      check("nothing was pasted", ["paste", "text", "title", "search", "find", "replace"].every((t) => docsEvents(ctx, t).length === 0) && (docsState(ctx).text === undefined || docsState(ctx).text === ""), JSON.stringify(docsState(ctx)))],
  },
  {
    name: "Docs: an act that moves the focus says where it went (focus: now …)", group: "docs",
    before: [{ role: "main", cmd: "reset" }, { role: "main", cmd: "docsOpenFind" }],
    code: `
const docs = await docsWin();
const find = await pick(docs, "Find", "text field");
await docs.click(find.ref);
await docs.key("tab");
report({ ok: true });`,
    verify: (ctx) => {
      const ids = docsEvents(ctx, "focus").map((e) => String(e.id));
      return [ok(ctx),
        check("the focus went from Find to Replace with (fixture log)", ids.includes("find") && ids.lastIndexOf("replace") > ids.indexOf("find"), JSON.stringify(ids)),
        check("the result carries a `focus: now …` line", /focus: now/i.test(ctx.output), ctx.output.slice(0, 400))];
    },
  },
  {
    name: "Docs: a 3,000-character paste into the doc with { into } — the real paste route", group: "docs",
    before: [{ role: "main", cmd: "reset" }],
    timeoutMs: 90_000,
    code: `
const docs = await docsWin();
const els = await docs.find("Document content", { emit: false });
const input = els.find((e) => /text/.test(e.role) && e.role !== "static text") || els[0];
if (!input) throw new Error("no Document content element");
await docs.paste(${JSON.stringify(DOCS_BIG_PASTE)}, { into: input.ref });
await sleep(500);
report({ into: input.role });`,
    dump: true,
    verify: (ctx) => {
      const pastes = docsEvents(ctx, "paste");
      return [ok(ctx),
        check("the full 3,000 characters arrived (the page's model)", docsText(ctx) === DOCS_BIG_PASTE, `${docsText(ctx)?.length ?? "no"} characters`),
        check("through a real paste: the page got a paste event of 3,000 characters, not keystrokes", pastes.some((e) => e.length === DOCS_BIG_PASTE.length) && docsEvents(ctx, "key").filter((e) => e.meta !== true).length < 20,
          `paste events ${JSON.stringify(pastes.map((e) => e.length))}, keys ${docsEvents(ctx, "key").length}`)];
    },
  },
  {
    name: "Docs: an em dash typed into the doc — no Option chord the page could take as its shortcut", group: "docs",
    before: [{ role: "main", cmd: "reset" }],
    code: `
const docs = await docsWin();
const canvas = await pick(docs, "Document canvas");
await docs.click(canvas.ref);
await docs.type(${JSON.stringify(DOCS_DASH_TEXT)});
await sleep(300);
report({ typed: true });`,
    dump: true,
    verify: (ctx) => [ok(ctx),
      check("the whole text arrived, dashes included (the page's model)", docsText(ctx) === DOCS_DASH_TEXT, JSON.stringify(docsText(ctx))),
      check("no key reached the page with Option held (it would have been the page's shortcut)", docsEvents(ctx, "shortcut").length === 0 && !docsEvents(ctx, "key").some((e) => e.alt === true),
        JSON.stringify(docsEvents(ctx, "shortcut"))),
      check("nothing went to the search input", docsEvents(ctx, "search").length === 0 && (docsState(ctx).search === undefined || docsState(ctx).search === ""), JSON.stringify(docsState(ctx).search))],
  },
  {
    name: "Docs: several lines typed into the doc — keys with Return, never a silent paste", group: "docs",
    before: [{ role: "main", cmd: "reset" }],
    code: `
const docs = await docsWin();
const canvas = await pick(docs, "Document canvas");
await docs.click(canvas.ref);
await docs.type(${JSON.stringify(DOCS_LINES_TEXT)});
await sleep(300);
report({ typed: true });`,
    dump: true,
    verify: (ctx) => [ok(ctx),
      check("the lines arrived (the page's model)", docsText(ctx) === DOCS_LINES_TEXT, JSON.stringify(docsText(ctx))),
      check("not as a paste the result did not mention", docsEvents(ctx, "paste").length === 0 || /as a paste/.test(ctx.output), `${docsEvents(ctx, "paste").length} paste events`),
      check("the result says what the doc received can't be checked", /received: unverifiable|can'?t be read back/i.test(ctx.output), ctx.output.slice(0, 300))],
  },
  {
    name: "Docs: a menu only the page has (Tools › Word count) — opened with real clicks, verified", group: "docs",
    before: [{ role: "main", cmd: "reset" }],
    code: `
const docs = await docsWin();
await docs.menu(["Tools", "Word count"]);
report({ chose: true });`,
    dump: true,
    verify: (ctx) => {
      const chosen = docsEvents(ctx, "click").filter((e) => e.id === "mi-word-count");
      return [ok(ctx),
        check("the page's Tools menu opened on a real mouse press (fixture log)", docsEvents(ctx, "mouse").some((e) => e.id === "menu-tools" && e.phase === "down"), JSON.stringify(docsEvents(ctx, "mouse").slice(-3))),
        check("Word count was chosen (fixture log)", chosen.length === 1 && chosen[0]?.ignored === false, JSON.stringify(chosen)),
        check("the result says it was the page's own menu", /page's own menu bar/.test(ctx.output), ctx.output.slice(0, 300))];
    },
  },
  {
    name: "Docs: a short paste into the filler-only document input is never claimed as shown", group: "docs",
    before: [{ role: "main", cmd: "reset" }],
    code: `
const docs = await docsWin();
const els = await docs.find("Document content", { emit: false });
const input = els.find((e) => /text/.test(e.role) && e.role !== "static text") || els[0];
if (!input) throw new Error("no Document content element");
await docs.paste(${JSON.stringify(DOCS_SHORT_PASTE)}, { into: input.ref });
await sleep(400);
report({ into: input.role });`,
    dump: true,
    verify: (ctx) => [ok(ctx),
      check("the paste arrived (the page's model)", docsText(ctx) === DOCS_SHORT_PASTE, JSON.stringify(docsText(ctx))),
      check("never \"the field shows the pasted text\" for an input that shows only filler", !/field shows the pasted text/.test(ctx.output), ctx.output.slice(0, 300)),
      check("said unconfirmed or can't be read back", /unconfirmed|can'?t be read back/i.test(ctx.output), ctx.output.slice(0, 300))],
  },
  // ── the per-app card (the `ask` session) ───────────────────────────────────────────────────────────────────
  {
    name: "per-app card under ask: Allow once", group: "card", session: "ask", answer: "once",
    before: [{ role: "main", cmd: "steal", args: { mode: "off" } }],
    code: `
const f = await apps.open(${JSON.stringify(FIXTURE_APP)}, { window: "Fixture Form" });
report({ bundleId: f.bundleId });`,
    verify: (ctx) => [ok(ctx), check("bound after the card was answered", fact(ctx, "bundleId") === FIXTURE_BUNDLE)],
  },
  {
    name: "per-app card under ask: Deny", group: "card", session: "ask", answer: false,
    code: `
let refused = null;
try { await apps.open(${JSON.stringify(FIXTURE_APP)}, { window: "Fixture Web" }); } catch (e) { refused = e.name + ": " + e.message; }
report({ refused });`,
    verify: (ctx) => [check("the bind was refused as NotAllowed", String(fact(ctx, "refused") ?? "").startsWith("NotAllowed"), String(fact(ctx, "refused")))],
  },
];

/** Did `ev` for `id` ever carry `value` since `since` (an intermediate value a later step overwrote)? */
function lastValueEver(events: readonly FixtureEvent[], since: number, ev: string, id: string, value: string): boolean {
  return events.some((e) => e.t >= since && e.ev === ev && e.id === id && e.value === value);
}

/** The card the `ask` scenarios expect (the daemon's per-app card). */
export function expectedCardSummary(): string {
  return `Allow Winter to use ${FIXTURE_APP} (${FIXTURE_BUNDLE})?`;
}
