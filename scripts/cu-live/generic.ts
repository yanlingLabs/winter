// `--apps "<name or bundle id>,…"`: the APP-AGNOSTIC focus check — any installed app, no fixture inside it.
//
// For each app, one ComputerV2 call per action (so every action gets its own 20 ms focus/Space assertion and its own
// row): bind on this desktop; state(); AX-press one harmless, reversible control and undo it; type a marker into an
// EMPTY editable field and clear it again; right-click then Escape; scroll down and back up; a screenshot; and, for an
// app with no accessibility tree (Unity, VRoid Studio), a coordinate click on an empty corner plus a wheel scroll.
// Off-Space: only for an app this run launched itself (never the user's own windows), and only through the window's
// own full-screen button; otherwise it is skipped and said so.
//
// The PLANNING (which element is harmless, which field is editable, what undoes a press) is plain functions below,
// embedded into the scripts with `Function.prototype.toString` — the same code the dry run unit-tests (`generic.test.ts`)
// runs in the sandboxed worker. They reference nothing but their arguments and each other.
import { MARKER } from "./lib";
import { PRELUDE, type Scenario, type VerifyContext } from "./scenarios";
import { check } from "./lib";

/** One element as `find()` answers it. */
export interface PlanElement { ref: number; role: string; name?: string; value?: string; states?: string[] }

/** Names a test must never press: anything that destroys, sends, pays, signs, ends or leaves. */
export function isDestructiveName(name: string | undefined): boolean {
  return /\b(delete|close|quit|exit|send|buy|remove|sign|signin|signout|erase|trash|discard|uninstall|log ?out|log ?in|shut ?down|restart|reset|pay|purchase|order|checkout|submit|publish|post|share|unsubscribe|subscribe|empty|format|install|update|upgrade|download|upload|delete all|clear|revert|replace|overwrite|archive|block|report|kill|force|disconnect|cancel subscription|accept|agree|allow|approve|confirm|continue|ok)\b/i.test(name ?? "");
}

/** The roles of reversible controls, best first, and how each is undone. */
export const PRESSABLE_ROLES: ReadonlyArray<{ role: string; undo: "reselect" | "press-again" }> = [
  { role: "tab", undo: "reselect" },
  { role: "radio button", undo: "reselect" },
  { role: "disclosure triangle", undo: "press-again" },
  { role: "check box", undo: "press-again" },
  { role: "toggle", undo: "press-again" },
  { role: "switch", undo: "press-again" },
  { role: "button", undo: "press-again" },
];

/**
 * The harmless control to press, or undefined: enabled, named, not destructive, never a window control or menu, and
 * — for a plain button — only one named like a view toggle (pressing it again undoes it). `byRole` maps each role in
 * PRESSABLE_ROLES to what `find({ role })` answered.
 */
export function pickPressable(byRole: Record<string, PlanElement[]>): { element: PlanElement; undo: string; reselect?: PlanElement } | undefined {
  const order: Array<[string, string]> = [["tab", "reselect"], ["radio button", "reselect"], ["disclosure triangle", "press-again"], ["check box", "press-again"],
    ["toggle", "press-again"], ["switch", "press-again"], ["button", "press-again"]];
  const toggleish = /^(show|hide|toggle)\b|sidebar|\bpanel\b|\bview\b|inspector|outline|minimap|expand|collapse|details/i;
  for (const [role, undo] of order) {
    const all = (byRole[role] || []).filter((e) => e.role === role);
    const usable = all.filter((e) => {
      const name = (e.name || "").trim();
      if (name.length === 0 || name.length > 60) return false;
      if ((e.states || []).includes("disabled")) return false;
      if (isDestructiveName(name)) return false;
      if (role === "button" && !toggleish.test(name)) return false;
      if (undo === "reselect" && (e.states || []).includes("selected")) return false;   // pressing the selected one changes nothing
      return true;
    });
    if (usable.length === 0) continue;
    const element = usable[0]!;
    if (undo === "reselect") {
      const reselect = all.find((e) => (e.states || []).includes("selected"));
      if (reselect === undefined) continue;   // nothing to go back to: not reversible
      return { element, undo, reselect };
    }
    return { element, undo };
  }
  return undefined;
}

/** The editable field to type into: EMPTY (never the user's content), enabled, not secure, not a password-ish name. */
export function pickEditable(byRole: Record<string, PlanElement[]>): PlanElement | undefined {
  const sensitive = /pass(word|code|phrase)?|\bpin\b|secret|token|card|cvv|cvc|ssn|security code|2fa|otp|one-time/i;
  for (const role of ["search field", "text field", "combo box", "text area"]) {
    const hit = (byRole[role] || []).find((e) => e.role === role
      && !(e.states || []).includes("disabled")
      && !sensitive.test(e.name || "")
      && (e.value === undefined || e.value === null || e.value === ""));
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/** Is a secure (password) field focused? Then nothing is typed in the app at all. */
export function secureFocused(secure: PlanElement[]): boolean {
  return secure.some((e) => (e.states || []).includes("focused"));
}

/** Did the state show an accessibility tree worth acting on? (`[n]` refs beyond the window itself.) */
export function refCount(state: string): number {
  return (state.match(/\[\d+\]/g) || []).length;
}

/** The planning functions as the scripts carry them (their `toString()`, i.e. transpiled JavaScript). */
export const PLANNING = [isDestructiveName, pickPressable, pickEditable, secureFocused, refCount].map((f) => f.toString()).join("\n");

/** Every generic script starts with this: the fixture prelude (report, pick), the planning, and the app handles. */
export const GENERIC_PRELUDE = `${PRELUDE}
${PLANNING}
var GH = (typeof GH !== "undefined" && GH) || new Map();
async function byRoles(app, roles) {
  const out = {};
  for (const role of roles) out[role] = await app.find({ role }, { emit: false });
  return out;
}
function skip(reason) { report({ skipped: reason }); }
`;

export interface GenericApp { query: string; key: string; /** Resolved by the runner (`resolveApp`), when it could. */ bundleId?: string }

export function parseApps(spec: string | undefined): GenericApp[] {
  if (spec === undefined) return [];
  const seen = new Set<string>();
  return spec.split(",").map((s) => s.trim()).filter((s) => s.length > 0 && !seen.has(s.toLowerCase()) && (seen.add(s.toLowerCase()), true))
    .map((query, i) => ({ query, key: `app${i}` }));
}

/** A marker no real field holds, mixed-case with a non-ASCII letter, so a lost or mangled keystroke shows. */
export const TYPE_MARKER = "WinterCU-Marker-Ünï-42";

const G = (key: string): string => `const app = GH.get(${JSON.stringify(key)}); if (!app) throw new Error("the app is not bound");`;

/** The scripts, one per action. `offSpace` names the variant in its rows. */
export const SCRIPTS = {
  bind: (a: GenericApp): string => `
const list = await apps.list({ emit: false });
const want = ${JSON.stringify((a.bundleId ?? a.query).toLowerCase())};
const norm = (s) => s.toLowerCase().replace(/\\.app$/, "").replace(/[^a-z0-9]/g, "");
const entry = list.find((x) => x.bundleId.toLowerCase() === want) || list.find((x) => norm(x.name) === norm(want));
if (!entry) { report({ installed: false }); skip("not installed (apps.list() does not name it)"); }
else {
  report({ installed: true, bundleId: entry.bundleId, name: entry.name, wasRunning: entry.running });
  const app = await apps.open(entry.bundleId);
  GH.set(${JSON.stringify(a.key)}, app);
  const s = await app.state({ emit: false, full: true });
  // Whether any of its windows is on THIS desktop (screen.windows: onScreen false = another Space, full screen or
  // minimized) — an already-running app's windows elsewhere are never moved, so the visual steps then skip.
  const onScreen = (await screen.windows({ emit: false })).some((w) => (w.app === app.name || w.app === entry.name) && w.onScreen);
  report({ bound: true, refs: refCount(s), windows: (await app.windows()).length, onScreen });
}`,
  state: (a: GenericApp): string => `${G(a.key)}
const s = await app.state({ full: true });
report({ refs: refCount(s) });`,
  press: (a: GenericApp): string => `${G(a.key)}
const roles = ["tab", "radio button", "disclosure triangle", "check box", "toggle", "switch", "button"];
const plan = pickPressable(await byRoles(app, roles));
if (!plan) skip("no harmless, reversible control (tabs, toggles, view buttons; never delete/close/send/…)");
else {
  // AX press; an element that lists no press action (Chrome's web controls: "show menu, scroll to visible") is
  // clicked instead — the same harmless, reversible control.
  const pressRef = async (ref) => {
    try { await app.action(ref, "press"); return "press"; } catch (e) {
      if (e.name !== "TypeError" || !/has no action/.test(String(e.message))) throw e;
      await app.click(ref);
      return "click";
    }
  };
  // A redraw between the read and the press (VS Code re-renders its tree) leaves the ref stale: re-find the element
  // by role and name ONCE and press that.
  const press = async (el) => {
    try { return await pressRef(el.ref); } catch (e) {
      if (e.name !== "StaleRef") throw e;
      const fresh = (await app.find({ role: el.role, name: el.name }, { emit: false })).find((x) => x.role === el.role && x.name === el.name);
      if (!fresh) throw e;
      return (await pressRef(fresh.ref)) + " (re-found after StaleRef)";
    }
  };
  const how = await press(plan.element);
  // Undo by NAME, found again: the press may have redrawn the tree (a stale ref must not leave the change behind).
  const back = plan.undo === "reselect" ? plan.reselect : plan.element;
  const again = (await app.find({ role: back.role, name: back.name }, { emit: false })).find((e) => e.name === back.name) || back;
  await press(again);
  report({ pressed: plan.element.role + " " + JSON.stringify(plan.element.name), undo: plan.undo, how });
}`,
  type: (a: GenericApp): string => `${G(a.key)}
const secure = await app.find({ role: "secure text field" }, { emit: false });
if (secureFocused(secure)) skip("a password field is focused — nothing is typed");
else {
  const field = pickEditable(await byRoles(app, ["search field", "text field", "combo box", "text area"]));
  if (!field) skip("no EMPTY editable field (it never types into your content)");
  else {
    await app.type(${JSON.stringify(TYPE_MARKER)}, { into: field.ref });
    const typed = (await app.find(${JSON.stringify(TYPE_MARKER)}, { emit: false })).some((e) => (e.value || "").includes(${JSON.stringify(TYPE_MARKER)}));
    await app.key("cmd+a", { into: field.ref });
    await app.key("delete", { into: field.ref });
    let left = (await app.find(${JSON.stringify(TYPE_MARKER)}, { emit: false })).some((e) => (e.value || "").includes(${JSON.stringify(TYPE_MARKER)}));
    for (let i = 0; left && i < 3; i++) {
      await app.key("cmd+z", { into: field.ref });
      left = (await app.find(${JSON.stringify(TYPE_MARKER)}, { emit: false })).some((e) => (e.value || "").includes(${JSON.stringify(TYPE_MARKER)}));
    }
    if (left) { try { await app.setValue(field.ref, ""); left = false; } catch (e) { /* reported below */ } }
    report({ field: field.role + " " + JSON.stringify(field.name || ""), typed, restored: !left });
  }
}`,
  rightClick: (a: GenericApp): string => `${G(a.key)}
const roles = ["tab", "radio button", "button", "group", "scroll area", "web area"];
const all = await byRoles(app, roles);
const target = roles.flatMap((r) => all[r] || []).find((e) => !isDestructiveName(e.name));
if (!target) skip("no element to right-click");
else {
  await app.click(target.ref, { button: "right" });
  await app.key("escape");
  report({ rightClicked: target.role + " " + JSON.stringify(target.name || "") });
}`,
  scroll: (a: GenericApp): string => `${G(a.key)}
const all = await byRoles(app, ["scroll area", "web area", "table", "outline", "list"]);
const target = ["scroll area", "web area", "table", "outline", "list"].flatMap((r) => all[r] || [])[0];
if (!target) skip("no scrollable element");
else {
  await app.scroll(target.ref, "down", 1);
  await app.scroll(target.ref, "up", 1);
  report({ scrolled: target.role });
}`,
  screenshot: (a: GenericApp): string => `${G(a.key)}
const img = await app.screenshot({ emit: false });
report({ w: img.width, h: img.height });`,
  noAx: (a: GenericApp): string => `${G(a.key)}
const shot = await app.screenshot({ emit: false });
const point = [Math.max(1, shot.width - 40), Math.max(1, shot.height - 40)];
await app.click(point);
await app.scroll(point, "down", 1);
await app.scroll(point, "up", 1);
report({ clicked: point });`,
  /** SETUP, not asserted: the window's own full-screen button (only for an app this run launched). */
  fullScreen: (a: GenericApp): string => `${G(a.key)}
const btn = (await app.find({ role: "full screen button" }, { emit: false }))[0];
if (!btn) skip("no full-screen button (off-Space needs one — never anything with UI)");
else { await app.action(btn.ref, "press"); await sleep(1500); report({ fullScreen: true }); }`,
  /** Cleanup for an app that was already running: close the windows this run opened (the bind's detail said so). */
  closeOpened: (a: GenericApp): string => `${G(a.key)}
const btn = (await app.find({ role: "close button" }, { emit: false }))[0];
if (!btn) skip("no close button");
else { await app.action(btn.ref, "press"); report({ closed: true }); }`,
};

/** The verdict of one action: the script ran (or skipped, saying why) — the runner adds the focus checks. */
export function genericVerify(ctx: VerifyContext): ReturnType<Scenario["verify"]> {
  const skipped = ctx.facts.skipped;
  if (typeof skipped === "string") return [check(`skipped: ${skipped}`, true)];
  const checks = [check("the action ran without an error", !ctx.isError, ctx.output.slice(-300))];
  if (ctx.facts.restored === false) checks.push(check("the typed marker was cleared again", false, String(ctx.facts.field)));
  if (ctx.facts.typed === false) checks.push(check("the marker reached the field", false, String(ctx.facts.field)));
  if (ctx.shots.length > 0) checks.push(check("the screenshot's pixels are not blank", ctx.shots.every((s) => !s.blank && s.error === undefined), ctx.shots.map((s) => s.error ?? `σ${s.stddevLuma.toFixed(1)}`).join(", ")));
  return checks;
}

/** A generic action as a scenario row. */
export function genericScenario(a: GenericApp, label: string, action: keyof typeof SCRIPTS, offSpace = false): Scenario {
  return {
    name: `${a.query}${offSpace ? " (off-Space)" : ""}: ${label}`,
    group: `app ${a.query}`,
    code: SCRIPTS[action](a),
    prelude: GENERIC_PRELUDE,
    timeoutMs: 45_000,
    verify: genericVerify,
  };
}

/** The on-desktop actions after the bind, in order. `noAx` only when the bind found (almost) no tree. */
export function onDesktopPlan(refs: number): Array<{ label: string; action: keyof typeof SCRIPTS }> {
  const steps: Array<{ label: string; action: keyof typeof SCRIPTS }> = [
    { label: "state()", action: "state" },
    { label: "AX-press a harmless control (and undo it)", action: "press" },
    { label: "type a marker into an empty field (and clear it)", action: "type" },
    { label: "right-click → Escape", action: "rightClick" },
    { label: "scroll down and up", action: "scroll" },
    { label: "screenshot", action: "screenshot" },
  ];
  if (refs < 4) steps.push({ label: "no accessibility tree: a coordinate click + a wheel scroll", action: "noAx" });
  return steps;
}

/** The off-Space actions (after the full-screen setup). */
export function offSpacePlan(): Array<{ label: string; action: keyof typeof SCRIPTS }> {
  return [
    { label: "state()", action: "state" },
    { label: "AX-press a harmless control (and undo it)", action: "press" },
    { label: "type a marker into an empty field (and clear it)", action: "type" },
    { label: "screenshot", action: "screenshot" },
  ];
}

/**
 * Why off-Space is skipped for an app, or undefined to try it: never for an app the user already had running (the run
 * never moves the user's windows), and only through a full-screen button (decided live).
 */
/** Why a visual step (screenshot, coordinate click) skips: an already-running app with no window on this desktop. */
export function visualSkipReason(wasRunning: boolean | undefined, onScreen: unknown, action: string): string | undefined {
  if (action !== "screenshot" && action !== "noAx") return undefined;
  if (wasRunning === true && onScreen === false) return "none of its windows is on this desktop (another Space, minimized or not open) — the test never moves your windows";
  return undefined;
}

export function offSpaceSkipReason(wasRunning: boolean | undefined): string | undefined {
  if (wasRunning === true) return "the app was already running — the test never moves your windows";
  if (wasRunning === undefined) return "unknown whether the app was running";
  return undefined;
}

/** How the run leaves the app: quit it if the run launched it, else close only the windows the run opened. */
export function restorePlan(wasRunning: boolean | undefined, bindOutput: string): { quit: boolean; closeOpenedWindow: boolean } {
  if (wasRunning === false) return { quit: true, closeOpenedWindow: false };
  return { quit: false, closeOpenedWindow: /opened a new .*window/i.test(bindOutput) };
}

/** Is an app query a bundle id (reverse-DNS) rather than a display name? */
export function looksLikeBundleId(query: string): boolean {
  return /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+){2,}$/.test(query);
}

export interface ResolvedApp { path: string; bundleId: string; name: string; via: "bundle id" | "LaunchServices" | "bundle names" }

export interface ResolveDeps {
  /** `mdfind <query>` → its lines. */
  mdfind(query: string): string[];
  /** The bundle's Info.plist as an object (`plutil -convert json`), or undefined. */
  infoPlist(appPath: string): Record<string, unknown> | undefined;
  /** The bundles to scan in the last step (default /Applications, ~/Applications, /System/Applications). */
  dirs: string[];
  /** The `.app` entries of a directory (one level, plus one sub-folder level like Utilities). */
  listApps(dir: string): string[];
}

/** Names compared case- and space-insensitively ("VRoid Studio" ≡ "VRoidStudio" ≡ "vroid-studio"). */
export function normalizeAppName(s: string): string {
  return s.toLowerCase().replace(/\.app$/, "").replace(/[^a-z0-9]/g, "");
}

function namesOf(plist: Record<string, unknown> | undefined, path: string): string[] {
  const base = path.split("/").at(-1) ?? "";
  return [plist?.CFBundleDisplayName, plist?.CFBundleName, plist?.CFBundleExecutable, base].filter((v): v is string => typeof v === "string" && v.length > 0);
}

/**
 * `--apps` names → an installed app, in order: (1) a bundle id (Spotlight's `kMDItemCFBundleIdentifier`);
 * (2) LaunchServices' display name (`mdfind` on application bundles, name prefix, case/diacritic-insensitive);
 * (3) CFBundleDisplayName / CFBundleName / CFBundleExecutable (and the bundle's file name) of the apps in
 * /Applications, ~/Applications and /System/Applications, matched case- and space-insensitively — so "VRoid Studio"
 * finds /Applications/VRoidStudio.app (bundle id net.pixiv.vroid.macosx, a file name with no space).
 */
export function resolveApp(query: string, deps: ResolveDeps): ResolvedApp | undefined {
  const fromPath = (path: string, via: ResolvedApp["via"]): ResolvedApp | undefined => {
    const plist = deps.infoPlist(path);
    const bundleId = typeof plist?.CFBundleIdentifier === "string" ? plist.CFBundleIdentifier : undefined;
    if (bundleId === undefined) return undefined;
    return { path, bundleId, name: namesOf(plist, path)[0] ?? query, via };
  };
  const q = query.replace(/'/g, "").trim();
  const apps = (lines: string[]): string[] => lines.map((l) => l.trim()).filter((l) => l.endsWith(".app"));
  if (looksLikeBundleId(q)) {
    for (const path of apps(deps.mdfind(`kMDItemCFBundleIdentifier == '${q}'`))) {
      const hit = fromPath(path, "bundle id");
      if (hit !== undefined && hit.bundleId.toLowerCase() === q.toLowerCase()) return hit;
    }
  }
  const want = normalizeAppName(q);
  for (const path of apps(deps.mdfind(`kMDItemContentType == 'com.apple.application-bundle' && kMDItemDisplayName == '${q}*'cd`))) {
    const hit = fromPath(path, "LaunchServices");
    if (hit !== undefined && namesOf(deps.infoPlist(path), path).some((n) => normalizeAppName(n) === want)) return hit;
  }
  for (const dir of deps.dirs) {
    for (const path of deps.listApps(dir)) {
      if (namesOf(deps.infoPlist(path), path).some((n) => normalizeAppName(n) === want)) {
        const hit = fromPath(path, "bundle names");
        if (hit !== undefined) return hit;
      }
    }
  }
  return undefined;
}

/** A one-line description of what the run would do with an app (the dry run prints it). */
export function describePlan(a: GenericApp): string {
  const steps = ["bind on this desktop", ...onDesktopPlan(10).map((s) => s.label), "(no-AX click+wheel if its tree is empty)",
    "off-Space via its full-screen button only if the run launched it", "left as found (quit if launched, else close only opened windows)"];
  return `${a.query}: ${steps.join("; ")}`;
}

/** Apps the default `--real-apps` set adds when installed: an Electron app and Chrome. (A Unity app: `--apps "VRoid Studio"`.) */
export const DEFAULT_GENERIC_APPS: ReadonlyArray<{ query: string; bundleId: string }> = [
  { query: "com.microsoft.VSCode", bundleId: "com.microsoft.VSCode" },
  { query: "com.google.Chrome", bundleId: "com.google.Chrome" },
];

export { MARKER };
