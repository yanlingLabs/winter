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
}

export interface FixtureCommand { role: "main" | "user"; cmd: string; args?: Record<string, unknown> }

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
  /** Which session: the `bypass` one (default) or the `ask` one (its cards are answered by the runner). */
  session?: "main" | "ask";
  /** The approval answer for an `ask` scenario's card(s): an option id, or false to deny. */
  answer?: "once" | "session" | "always" | false;
  /**
   * A scenario that provokes the fixture into activating itself: a jump-and-back is then the subject, so the focus
   * check allows one excursion no longer than this many ms (and still demands the original app at the end).
   */
  allowExcursionMs?: number;
  /** In the ask session: a foreground card (denied by the rig) is expected besides the per-app card. */
  foregroundCard?: boolean;
  /** The script prelude (default PRELUDE; the generic app checks bring their own, which includes it). */
  prelude?: string;
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
function report(o) { print(${JSON.stringify(MARKER)} + " " + JSON.stringify(o)); }
`;

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

const DOC_TEXT = "Doc line: Mixed CASE ✓ ünï 日本 & <tag> 100%";
const PASTE_TEXT = "Pasted ✓ «text» — 2026";
const OFFSPACE_TEXT = "off-Space ✓ Typed";

export const SCENARIOS: Scenario[] = [
  // ── binding ────────────────────────────────────────────────────────────────────────────────────────────────
  {
    name: "bind on-Space (Form, Web, Canvas)", group: "bind",
    code: `
const form = await win("Fixture Form");
const web = await win("Fixture Web");
const canvas = await win("Fixture Canvas");
report({ bundleId: form.bundleId, windows: (await form.windows()).map((w) => w.title) });`,
    verify: (ctx) => [
      ok(ctx),
      check("bound the fixture by name", fact(ctx, "bundleId") === FIXTURE_BUNDLE, String(fact(ctx, "bundleId"))),
      check("windows() lists the fixture's windows", Array.isArray(fact(ctx, "windows")) && (fact(ctx, "windows") as string[]).includes("Fixture Web")),
      ...mirrorChecks(ctx, FIXTURE_APP),
    ],
  },
  {
    name: "bind off-Space (full-screen window)", group: "bind",
    code: `
const off = await win("Fixture Offspace");
const s = await off.state({ emit: false, full: true });
const listed = (await screen.windows({ emit: false })).filter((w) => w.title === "Fixture Offspace");
report({ hasField: s.includes("Offspace Field"), onScreen: listed.map((w) => w.onScreen) });`,
    verify: (ctx) => [
      ok(ctx),
      check("the off-Space window's state reads its field", fact(ctx, "hasField") === true),
      // The helper may bind the full-screen window where it is, or move it to this desktop (its detail line says which).
      check("screen.windows reports it off screen, or the bind says where it went", (Array.isArray(fact(ctx, "onScreen")) && (fact(ctx, "onScreen") as boolean[]).includes(false)) || /moved|where it is|another Space|full screen/i.test(ctx.output), JSON.stringify(fact(ctx, "onScreen"))),
      ...mirrorChecks(ctx, FIXTURE_APP),
    ],
  },
  {
    name: "type into the off-Space window", group: "bind",
    code: `
const off = await win("Fixture Offspace");
const field = await pick(off, "Offspace Field", "text field");
await off.type(${JSON.stringify(OFFSPACE_TEXT)}, { into: field.ref });
report({ typed: true });`,
    verify: (ctx) => [ok(ctx), check("the off-Space field received the exact text", lastValue(ctx.events, ctx.since, "field.change", "offspace") === OFFSPACE_TEXT, String(lastValue(ctx.events, ctx.since, "field.change", "offspace")))],
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
const web = await win("Fixture Web");
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
const web = await win("Fixture Web");
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
const web = await win("Fixture Web");
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
const web = await win("Fixture Web");
const comment = await pick(web, "Comment", "text");
await web.paste(${JSON.stringify(PASTE_TEXT)}, { into: comment.ref });
report({ ok: true });`,
    dump: true,
    verify: (ctx) => [ok(ctx), check("Comment holds the pasted text", String(webState(ctx).comment ?? "").includes(PASTE_TEXT), JSON.stringify(webState(ctx).comment))],
  },
  // ── scrolling ──────────────────────────────────────────────────────────────────────────────────────────────
  {
    name: "scroll by wheel (web page)", group: "scroll",
    before: [{ role: "main", cmd: "reset" }],
    code: `
const web = await win("Fixture Web");
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
const web = await win("Fixture Web");
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
