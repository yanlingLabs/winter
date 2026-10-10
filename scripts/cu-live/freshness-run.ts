// The freshness measurement's LIVE side (the runner calls it with its own plumbing; the logic it applies is
// freshness.ts's, unit-tested). A measurement, not a test: a variant PASSES when the measurement completed — its
// verdicts are the data (`freshness.json`), never asserted.
//
// Fixture variants: (a1) a default WKWebView, (a2) the same with `-[WKWebView _setWindowOcclusionDetectionEnabled:NO]`.
// The Fresh window goes to another Space (another desktop, a Space made for it, else full screen — the runner then
// returns the user to theirs), and NOTHING visits that Space while the sampler takes stream OFF → ON → OFF.
// Safari (`--safari-freshness`): fresh.html in a NEW Safari window, full screen by its own button, the same phases,
// then out of full screen and only that window closed. `--safari-webkit-prefs` wraps it in Astra's three Safari
// WebKitPreferences keys set NO — originals recorded first, restored exactly after, Safari quit/relaunched around.
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { FRESH_PHASES, type FreshSamplerParams } from "./fresh-sampler";
import {
  analyzeFreshness, FIXTURE_FRESH_LAYOUT, PAGE_FRESH_LAYOUT, prefTypeFlag, SAFARI_PREF_KEYS, SAFARI_PREFS_DOMAIN, safariPrefsPlan,
  type CaptureRecord, type CellResult, type DecodeLine, type FreshLayout, type PrefOriginal, type TickRecord,
} from "./freshness";
import { focusViolations, type FixtureEvent, type FocusBaseline, type MonitorSample } from "./lib";

export interface FreshDeps {
  tool: string;
  home: string;
  root: string;
  /** The fixture's web resources (fresh.html), for the Safari copy. */
  webDir: string;
  log(line: string): void;
  sh(cmd: string, args: string[]): { status: number | null; stdout: string; stderr: string };
  post(cmd: string, args?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  events(): FixtureEvent[];
  /** The user back in front on their Space (after a full-screen change moved them). */
  returnUser(): Promise<void>;
  /** One ComputerV2 turn (setup, not asserted): its output and `report()` facts. */
  turn(code: string): Promise<{ output: string; isError: boolean; facts: Record<string, unknown> }>;
  /** `winter-core-live __helper-freshness`: the sampler's stdout lines. */
  sample(params: FreshSamplerParams): Promise<string[]>;
  monitor(): readonly MonitorSample[];
  baseline: FocusBaseline;
  abortIfInput(): void;
  /** Injectable for tests (default: real time). */
  sleep?(ms: number): Promise<void>;
}

export interface VariantResult {
  variant: string;
  ok: boolean;
  error?: string;
  notes: string[];
  windowId?: number;
  placement?: string;
  occlusion: Array<{ t: number; visible: boolean }>;
  captures: number;
  cells: CellResult[];
  /** The user's front app / Space changed while the sampler ran: the measurement may have been disturbed. */
  disturbed?: string;
  /** What the sampler and the decoder actually produced — so a table of "no captures" says why. */
  pipeline?: PipelineSummary;
}

export interface PipelineSummary {
  capturesOk: number;
  capturesFailed: number;
  /** Each distinct capture error (its JSON), with how often it came back. */
  captureErrors: Array<{ error: string; count: number }>;
  streamEvents: Array<{ on: boolean; ok: boolean; error?: string }>;
  decodeLines: number;
  decodedWithSentinel: number;
  decodeFailures: Array<{ error: string; count: number }>;
  /** The decoder's own exit status / stderr when a batch did not exit 0. */
  decoderProblems: string[];
  /** The sampler's raw stdout, kept beside the PNGs. */
  samplerLog: string;
}

function tally(values: readonly string[]): Array<{ error: string; count: number }> {
  const m = new Map<string, number>();
  for (const v of values) m.set(v, (m.get(v) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([error, count]) => ({ error, count }));
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(what: string, ms: number, probe: () => T | undefined): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = probe();
    if (v !== undefined) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out (${ms} ms) waiting for ${what}`);
    await sleep(100);
  }
}

/** Sample, decode, analyze — the shared tail of every variant. */
async function measure(d: FreshDeps, variant: string, windowId: number, layout: FreshLayout, rect: [number, number, number, number], since: number): Promise<Pick<VariantResult, "captures" | "cells" | "disturbed" | "notes" | "pipeline">> {
  const dir = join(d.home, "fresh", variant.replace(/[^a-z0-9]+/gi, "-"));
  mkdirSync(dir, { recursive: true });
  // The captures are named by the temp dir's `/var/…` spelling, not its realpath `/private/var/…`: helper ≤ 1.5.1
  // compared after NSURL standardizing, which drops `/private` only from a path that already exists — the home,
  // never a PNG not written yet — and so refused every capture. Later helpers compare realpaths; both accept this.
  const samplerDir = dir.replace(/^\/private\/(var|tmp)\//, "/$1/");
  const t0 = Date.now();
  const lines = await d.sample({ windowId, dir: samplerDir, phases: FRESH_PHASES, intervalMs: 500, rect, fps: 10 });
  const t1 = Date.now();
  const samplerLog = join(dir, "sampler.jsonl");
  writeFileSync(samplerLog, `${lines.join("\n")}\n`);
  const parsed = lines.flatMap((l) => { try { return [JSON.parse(l) as Record<string, unknown>]; } catch { return []; } });
  const done = parsed.find((p) => "done" in p);
  if (done?.done !== true) throw new Error(`the sampler did not finish: ${JSON.stringify(done ?? lines.slice(-2))}`);
  const captures = parsed.filter((p) => p.event === "capture") as unknown as CaptureRecord[];
  const streams = parsed.filter((p) => p.event === "stream").map((p) => ({ on: p.on === true, ok: p.ok === true, ...(p.ok === true ? {} : { error: JSON.stringify(p.error) }) }));
  const notes = streams.filter((s) => !s.ok).map((s) => `stream ${s.on ? "start" : "stop"} failed: ${s.error}`);
  const files = captures.filter((c) => c.ok).map((c) => c.file);
  const failed = captures.filter((c) => !c.ok).map((c) => JSON.stringify((c as unknown as { error?: unknown }).error ?? "no error given"));
  const layoutPath = join(dir, "layout.json");
  writeFileSync(layoutPath, JSON.stringify(layout));
  const decodes: DecodeLine[] = [];
  const decoderProblems: string[] = [];
  for (let i = 0; i < files.length; i += 40) {
    const r = d.sh(d.tool, ["fresh-decode", layoutPath, ...files.slice(i, i + 40)]);
    if (r.status !== 0) decoderProblems.push(`batch ${i / 40}: exit ${r.status} ${r.stderr.trim().slice(0, 300)}`);
    for (const l of r.stdout.split("\n")) { try { if (l.trim()) decodes.push(JSON.parse(l) as DecodeLine); } catch { /* skip */ } }
  }
  const pipeline: PipelineSummary = {
    capturesOk: files.length, capturesFailed: failed.length, captureErrors: tally(failed), streamEvents: streams,
    decodeLines: decodes.length, decodedWithSentinel: decodes.filter((x) => x.ok).length,
    decodeFailures: tally(decodes.filter((x) => !x.ok).map((x) => x.error ?? "no error given")), decoderProblems, samplerLog,
  };
  if (failed.length > 0) notes.push(`${failed.length} of ${captures.length} captures failed — ${pipeline.captureErrors.slice(0, 3).map((e) => `${e.error} ×${e.count}`).join("; ")}`);
  if (files.length > 0 && decodes.length === 0) notes.push(`the decoder printed nothing for ${files.length} captures${decoderProblems.length > 0 ? ` (${decoderProblems[0]})` : ""}`);
  d.log(`freshness ${variant}: captures ok ${files.length}, failed ${failed.length}; decoded ${pipeline.decodedWithSentinel}/${decodes.length}${failed.length > 0 ? ` — first error ${pipeline.captureErrors[0]!.error}` : ""}`);
  const ticks: TickRecord[] = d.events().filter((e) => e.ev === "fresh.tick" && e.t >= since).map((e) => ({
    t: e.t, ...(typeof e.native === "number" ? { native: e.native } : {}), ...(typeof e.dom === "number" ? { dom: e.dom } : {}), ...(typeof e.canvas === "number" ? { canvas: e.canvas } : {}),
  }));
  const moved = focusViolations(d.monitor(), t0, t1, d.baseline);
  return {
    captures: captures.length,
    cells: analyzeFreshness(layout, captures, decodes, ticks),
    notes: [...notes, ...(decodes.filter((x) => !x.ok).length > 0 ? [`${decodes.filter((x) => !x.ok).length} captures had no sentinel`] : [])],
    pipeline,
    ...(moved.length > 0 ? { disturbed: `${moved[0]!.what} at +${moved[0]!.t - t0} ms` } : {}),
  };
}

/** (a1)/(a2): the fixture's Fresh window. */
export async function measureFixtureVariant(d: FreshDeps, variant: string, occlusionDetection: boolean): Promise<VariantResult> {
  const since = Date.now();
  const base: VariantResult = { variant, ok: false, notes: [], occlusion: [], captures: 0, cells: [] };
  try {
    await d.post("freshStart", { occlusionDetection }, 10_000);
    const ready = await waitFor("the Fresh page (fresh.ready)", 15_000, () => d.events().find((e) => e.ev === "fresh.ready" && e.t >= since));
    const windowId = Number(ready.window);
    const spi = d.events().find((e) => e.ev === "fresh.occlusionDetection" && e.t >= since);
    if (!occlusionDetection && spi?.supported !== true) base.notes.push("_setWindowOcclusionDetectionEnabled: is not in this WebKit — measured as (a1)");
    await d.post("freshOffspace", {}, 30_000);
    const placed = await waitFor("the Fresh window off this desktop", 15_000, () => d.events().find((e) => e.ev === "fresh.offspace" && e.t >= since));
    await (d.sleep ?? sleep)(800);
    await d.returnUser();
    await (d.sleep ?? sleep)(2_000); // settle: nothing visits that Space from here on
    d.abortIfInput();
    const m = await measure(d, variant, windowId, FIXTURE_FRESH_LAYOUT, [0, 0, 640, 240], since);
    d.abortIfInput();
    return {
      ...base, ok: true, windowId, placement: String(placed.method), ...m, notes: [...base.notes, ...m.notes],
      occlusion: d.events().filter((e) => e.ev === "fresh.occlusion" && e.t >= since).map((e) => ({ t: e.t, visible: e.visible === true })),
    };
  } catch (err) {
    return { ...base, error: err instanceof Error ? err.message : String(err) };
  } finally {
    await d.post("freshStop", {}, 20_000).catch(() => undefined);
    await (d.sleep ?? sleep)(800);
    await d.returnUser().catch(() => undefined);
  }
}

/** The Safari window ids (layer 0) right now. */
function safariWindows(d: FreshDeps): Set<number> {
  const ids = d.sh(d.tool, ["windows", "Safari"]).stdout.split("\n").flatMap((l) => {
    try { const w = JSON.parse(l) as { id: number; layer: number }; return w.layer === 0 ? [w.id] : []; } catch { return []; }
  });
  return new Set(ids);
}

/** The page's own title (fresh.html's <title>): how the runner knows the test's window shows the page. */
const FRESH_PAGE_TITLE = "Fixture Fresh";

/**
 * Safari: the page in a NEW window of the test's own (never a tab of the user's), full screen by its own button,
 * measured, undone. The window comes first (File › New Window, which works from the background); the page is then
 * loaded INTO it with no keys and no URL hand-off: its address field's value set and the field's own confirm
 * action (AXConfirm) — nothing that can reach another window. `open -g -a Safari <url>` cannot be used: Safari
 * opens an external URL as a tab of its last ACTIVE window, the user's, whatever window is newest (two runs
 * proved it, one stray tab each); and ⌘L → type → return in a background window never navigated.
 * The window's title must read the page's before anything is measured; it is closed by the SAME handle that put
 * it in full screen (a fresh bind of a window on its own full-screen Space has no accessibility), and the close is
 * verified by the app's own window list (a closed Safari window lingers, hidden, in the window server's list for
 * Reopen Last Closed Window) — a window left behind fails the variant loudly.
 */
export async function measureSafari(d: FreshDeps, variant: string): Promise<VariantResult> {
  const since = Date.now();
  const base: VariantResult = { variant, ok: false, notes: [], occlusion: [], captures: 0, cells: [] };
  const pageDir = join(d.root, "safari-fresh");
  mkdirSync(pageDir, { recursive: true });
  copyFileSync(join(d.webDir, "fresh.html"), join(pageDir, "fresh.html"));
  const url = `${pathToFileURL(join(pageDir, "fresh.html")).href}?sentinel=1`;
  let windowId: number | undefined;
  let fullScreen = false;
  let result: VariantResult;
  try {
    const before = safariWindows(d);
    const made = await d.turn(`
const sfApp = await apps.open("com.apple.Safari");
await sfApp.menu(["File", "New Window"]);
await sleep(1500);
const sfMine = (await sfApp.windows()).find((w) => !${JSON.stringify([...before])}.includes(w.id));
report(sfMine ? { made: true, id: sfMine.id } : { made: false });`);
    windowId = typeof made.facts.id === "number" ? made.facts.id : undefined;
    if (windowId === undefined) throw new Error(`File › New Window made no Safari window — not measured: ${made.output.slice(-200)}`);
    d.log(`freshness ${variant}: the test's Safari window ${windowId}; loading the page into its own address field`);
    const nav = await d.turn(`
const sfNav = await apps.open("com.apple.Safari", { window: ${windowId} });
const sfFields = await sfNav.find({ role: "text field" }, { emit: false });
const sfField = sfFields.find((f) => /search|address/i.test(f.name ?? "")) ?? sfFields[0];
if (!sfField) report({ navigated: false, fields: 0 });
else { await sfNav.setValue(sfField.ref, ${JSON.stringify(url)}); await sfNav.action(sfField.ref, "confirm"); report({ navigated: true, field: sfField.name ?? "" }); }`);
    if (nav.facts.navigated !== true) throw new Error(`could not load the page into the test's Safari window: ${JSON.stringify(nav.facts)} ${nav.output.slice(-200)}`);
    await (d.sleep ?? sleep)(3_000); // the page loads
    const fs = await d.turn(`
const sfFresh = await apps.open("com.apple.Safari", { window: ${windowId} });
const sfTitle = (await sfFresh.windows()).find((w) => w.id === ${windowId})?.title ?? "";
if (sfTitle !== ${JSON.stringify(FRESH_PAGE_TITLE)}) report({ title: sfTitle, fullScreen: false });
else {
  const b = (await sfFresh.find({ role: "full screen button" }, { emit: false }))[0];
  if (!b) report({ title: sfTitle, fullScreen: false }); else { await sfFresh.action(b.ref, "press"); report({ title: sfTitle, fullScreen: true }); }
}`);
    if (fs.facts.title !== FRESH_PAGE_TITLE) {
      throw new Error(`the test's Safari window shows "${String(fs.facts.title)}", not the page, after its address field was confirmed; not measured`);
    }
    if (fs.facts.fullScreen !== true) throw new Error(`could not put the Safari window in full screen: ${fs.output.slice(-200)}`);
    fullScreen = true;
    await (d.sleep ?? sleep)(2_500);
    await d.returnUser();
    await (d.sleep ?? sleep)(2_000);
    d.abortIfInput();
    const m = await measure(d, variant, windowId, PAGE_FRESH_LAYOUT, [0, 0, 760, 460], since);
    d.abortIfInput();
    result = { ...base, ok: true, windowId, placement: "full screen (its own button)", ...m, notes: [...base.notes, ...m.notes] };
  } catch (err) {
    result = { ...base, ...(windowId === undefined ? {} : { windowId }), error: err instanceof Error ? err.message : String(err) };
  }
  if (windowId !== undefined) {
    // Out of full screen, then ONLY that window closed — by its own buttons, through the handle that is still bound
    // to it (`sfFresh`, else a bind of the window, which is on this desktop then). Verified through the app's own
    // window list (`sfApp`, bound in the first turn): a window left behind fails the variant.
    const id = windowId;
    const handle = fullScreen ? "sfFresh" : `(await apps.open("com.apple.Safari", { window: ${id} }))`;
    let open: boolean | undefined = true;
    for (let attempt = 1; attempt <= 2 && open !== false; attempt++) {
      const c = await d.turn(`
const sfClose = ${attempt === 1 ? handle : `(await apps.open("com.apple.Safari", { window: ${id} }))`};
${fullScreen ? `// Out of full screen first. A full-screen window's title-bar buttons are not in its tree; the menu item is
// matched by its EXACT title, so if another window were the one menus act on, the item would read "Enter Full
// Screen" and this throws instead of acting there.
const sfFsb = (await sfClose.find({ role: "full screen button" }, { emit: false }))[0];
try {
  if (sfFsb) await sfClose.action(sfFsb.ref, "press"); else await sfClose.menu(["View", "Exit Full Screen"]);
  await sleep(2500);
} catch (e) { print("exit full screen: " + String(e?.name ?? e) + " " + String(e?.message ?? "").slice(0, 160)); }` : ""}
const sfBtn = (await sfClose.find({ role: "close button" }, { emit: false }))[0];
if (sfBtn) { await sfClose.action(sfBtn.ref, "press"); report({ closed: true }); } else report({ closed: false });`).catch((err: unknown) => ({ output: String(err), isError: true, facts: {} as Record<string, unknown> }));
      await (d.sleep ?? sleep)(1_500);
      const check = await d.turn(`
try { report({ open: (await sfApp.windows()).some((w) => w.id === ${id}) }); } catch (e) { report({ checkError: String(e?.name ?? e) }); }`).catch(() => undefined);
      open = typeof check?.facts.open === "boolean" ? check.facts.open : undefined;
      d.log(`freshness ${variant}: closing the test's Safari window ${id} (try ${attempt}): ${JSON.stringify(c.facts)}${c.isError ? ` — ${c.output.slice(-200)}` : ""}${/exit full screen: [^\n<]*/.exec(c.output) ? ` (${/exit full screen: [^\n<]*/.exec(c.output)![0]})` : ""}; still in Safari's window list: ${open === undefined ? `unknown (${JSON.stringify(check?.facts ?? {})})` : open}`);
    }
    if (open !== false) {
      const left = open === true
        ? `the test's Safari window ${id} is still open (a Start Page or the test page) — close it by hand`
        : `could not confirm the test's Safari window ${id} closed — check Safari for an extra window`;
      d.log(`freshness ${variant}: ${left}`);
      result = { ...result, ok: false, error: [result.error, left].filter(Boolean).join("; ") };
    }
    await d.returnUser().catch(() => undefined);
  }
  return result;
}

// ── `--safari-webkit-prefs`: record, set NO, measure, restore exactly ─────────────────────────────────────────

export const SAFARI_PREFS_WARNING = [
  "",
  "  !!! --safari-webkit-prefs QUITS AND RELAUNCHES SAFARI — twice — and temporarily sets three of its WebKit",
  "  !!! preferences (WebKitPreferences.hiddenPageDOMTimerThrottlingEnabled, …AutoIncreases,",
  "  !!! WebKitPreferences.pageVisibilityBasedProcessSuppressionEnabled) to NO. The originals (absent included) are",
  "  !!! recorded first and restored exactly afterwards; Safari restores its windows on relaunch.",
  "  !!! Pass --yes-restart-safari to go ahead.",
  "",
].join("\n");

export function safariPrefsBackupPath(outDir: string): string { return join(outDir, "safari-prefs-backup.json"); }

function safariRunning(d: FreshDeps): boolean { return d.sh("pgrep", ["-x", "Safari"]).stdout.trim().length > 0; }

/** Safari's own File… no: its app menu's Quit, through the helper (no Apple Event, no activation). */
async function quitSafari(d: FreshDeps): Promise<void> {
  if (!safariRunning(d)) return;
  await d.turn(`const sf = await apps.open("com.apple.Safari"); await sf.menu(["Safari", "Quit Safari"]); report({ quit: true });`).catch(() => undefined);
  await waitFor("Safari to quit", 30_000, () => (safariRunning(d) ? undefined : true));
}

function readOriginals(d: FreshDeps, domain: string): Record<string, PrefOriginal> {
  const all = d.sh("defaults", ["read", domain]);
  if (all.status !== 0) throw new Error(`cannot read Safari's preferences (${all.stderr.trim().slice(0, 120)}) — nothing was changed`);
  const out: Record<string, PrefOriginal> = {};
  for (const k of SAFARI_PREF_KEYS) {
    const t = d.sh("defaults", ["read-type", domain, k]);
    if (t.status !== 0) { out[k] = { present: false }; continue; }
    const type = prefTypeFlag(t.stdout);
    if (type === undefined) throw new Error(`${k} has a type this cannot restore (${t.stdout.trim()}) — nothing was changed`);
    out[k] = { present: true, type, value: d.sh("defaults", ["read", domain, k]).stdout.trim() };
  }
  return out;
}

function runDefaults(d: FreshDeps, commands: string[][]): string[] {
  return commands.flatMap((args) => {
    const r = d.sh("defaults", args);
    // Deleting a key that is already gone is not a failure.
    return r.status === 0 || (args[0] === "delete" && /does not exist/i.test(r.stderr)) ? [] : [`defaults ${args.join(" ")}: ${r.stderr.trim()}`];
  });
}

/** Restores from a backup an interrupted run left (Safari quit around it). Returns what failed. */
export async function restoreSafariPrefsIfInterrupted(d: FreshDeps, outDir: string): Promise<string[]> {
  const backup = safariPrefsBackupPath(outDir);
  if (!existsSync(backup)) return [];
  const { domain, originals } = JSON.parse(readFileSync(backup, "utf8")) as { domain: string; originals: Record<string, PrefOriginal> };
  d.log("an earlier --safari-webkit-prefs run was interrupted: restoring Safari's original preferences first…");
  await quitSafari(d);
  const failed = runDefaults(d, safariPrefsPlan(domain, originals).restore);
  if (failed.length === 0) rmSync(backup);
  d.sh("open", ["-g", "-a", "Safari"]);
  await (d.sleep ?? sleep)(5_000);
  return failed;
}

/** The Safari measurement inside the preference change: record → quit → write NO → relaunch → measure → quit → restore → relaunch. */
export async function measureSafariWithPrefs(d: FreshDeps, outDir: string, variant: string): Promise<VariantResult> {
  const domain = join(homedir(), SAFARI_PREFS_DOMAIN);
  const failedEarlier = await restoreSafariPrefsIfInterrupted(d, outDir);
  if (failedEarlier.length > 0) return { variant, ok: false, error: `an earlier run's preferences could not be restored: ${failedEarlier.join("; ")}`, notes: [], occlusion: [], captures: 0, cells: [] };
  let originals: Record<string, PrefOriginal>;
  try { originals = readOriginals(d, domain); } catch (err) {
    return { variant, ok: false, error: err instanceof Error ? err.message : String(err), notes: [], occlusion: [], captures: 0, cells: [] };
  }
  const plan = safariPrefsPlan(domain, originals);
  writeFileSync(safariPrefsBackupPath(outDir), JSON.stringify({ domain, originals, writtenAt: new Date().toISOString() }, null, 2));
  d.log(`Safari's originals recorded (${safariPrefsBackupPath(outDir)}): ${JSON.stringify(originals)}`);
  let result: VariantResult;
  try {
    await quitSafari(d);
    const failed = runDefaults(d, plan.apply);
    if (failed.length > 0) throw new Error(failed.join("; "));
    d.sh("open", ["-g", "-a", "Safari"]);
    await (d.sleep ?? sleep)(6_000); // its windows come back
    result = await measureSafari(d, variant);
    result.notes.push(`with ${SAFARI_PREF_KEYS.join(", ")} = NO`);
  } catch (err) {
    result = { variant, ok: false, error: err instanceof Error ? err.message : String(err), notes: [], occlusion: [], captures: 0, cells: [] };
  } finally {
    await quitSafari(d).catch(() => undefined);
    const failed = runDefaults(d, plan.restore);
    if (failed.length === 0) rmSync(safariPrefsBackupPath(outDir), { force: true });
    else d.log(`!!! Safari's preferences were NOT fully restored (${failed.join("; ")}); the backup stays at ${safariPrefsBackupPath(outDir)} and the next --safari-webkit-prefs run restores it first`);
    d.sh("open", ["-g", "-a", "Safari"]);
  }
  return result!;
}
