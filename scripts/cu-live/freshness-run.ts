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
async function measure(d: FreshDeps, variant: string, windowId: number, layout: FreshLayout, rect: [number, number, number, number], since: number): Promise<Pick<VariantResult, "captures" | "cells" | "disturbed" | "notes">> {
  const dir = join(d.home, "fresh", variant.replace(/[^a-z0-9]+/gi, "-"));
  mkdirSync(dir, { recursive: true });
  const t0 = Date.now();
  const lines = await d.sample({ windowId, dir, phases: FRESH_PHASES, intervalMs: 500, rect, fps: 10 });
  const t1 = Date.now();
  const parsed = lines.flatMap((l) => { try { return [JSON.parse(l) as Record<string, unknown>]; } catch { return []; } });
  const done = parsed.find((p) => "done" in p);
  if (done?.done !== true) throw new Error(`the sampler did not finish: ${JSON.stringify(done ?? lines.slice(-2))}`);
  const captures = parsed.filter((p) => p.event === "capture") as unknown as CaptureRecord[];
  const notes = parsed.filter((p) => p.event === "stream" && p.ok !== true).map((p) => `stream ${p.on ? "start" : "stop"} failed: ${JSON.stringify(p.error)}`);
  const files = captures.filter((c) => c.ok).map((c) => c.file);
  const layoutPath = join(dir, "layout.json");
  writeFileSync(layoutPath, JSON.stringify(layout));
  const decodes: DecodeLine[] = [];
  for (let i = 0; i < files.length; i += 40) {
    const r = d.sh(d.tool, ["fresh-decode", layoutPath, ...files.slice(i, i + 40)]);
    for (const l of r.stdout.split("\n")) { try { if (l.trim()) decodes.push(JSON.parse(l) as DecodeLine); } catch { /* skip */ } }
  }
  const ticks: TickRecord[] = d.events().filter((e) => e.ev === "fresh.tick" && e.t >= since).map((e) => ({
    t: e.t, ...(typeof e.native === "number" ? { native: e.native } : {}), ...(typeof e.dom === "number" ? { dom: e.dom } : {}), ...(typeof e.canvas === "number" ? { canvas: e.canvas } : {}),
  }));
  const moved = focusViolations(d.monitor(), t0, t1, d.baseline);
  return {
    captures: captures.length,
    cells: analyzeFreshness(layout, captures, decodes, ticks),
    notes: [...notes, ...(decodes.filter((x) => !x.ok).length > 0 ? [`${decodes.filter((x) => !x.ok).length} captures had no sentinel`] : [])],
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

/** Safari: the page in a NEW window (never a tab of the user's), full screen by its own button, measured, undone. */
export async function measureSafari(d: FreshDeps, variant: string): Promise<VariantResult> {
  const since = Date.now();
  const base: VariantResult = { variant, ok: false, notes: [], occlusion: [], captures: 0, cells: [] };
  const pageDir = join(d.root, "safari-fresh");
  mkdirSync(pageDir, { recursive: true });
  copyFileSync(join(d.webDir, "fresh.html"), join(pageDir, "fresh.html"));
  const url = `${pathToFileURL(join(pageDir, "fresh.html")).href}?sentinel=1`;
  let windowId: number | undefined;
  let fullScreen = false;
  try {
    const before = safariWindows(d);
    d.sh("open", ["-g", "-a", "Safari", url]);
    windowId = await waitFor("a new Safari window", 8_000, () => [...safariWindows(d)].find((id) => !before.has(id))).catch(() => undefined);
    if (windowId === undefined) {
      // Safari put it in a tab of one of the user's windows: a window of our own through File › New Window instead.
      base.notes.push("open -g used a tab; made a new window through File › New Window");
      await d.turn(`
const sf = await apps.open("com.apple.Safari");
await sf.menu(["File", "New Window"]);
await sleep(1500);
const mine = (await sf.windows()).find((w) => !${JSON.stringify([...before])}.includes(w.id));
if (!mine) report({ made: false });
else { await sf.useWindow(mine.id); await sf.key("cmd+l"); await sf.type(${JSON.stringify(url)}); await sf.key("return"); report({ made: true, id: mine.id }); }`);
      windowId = await waitFor("the new Safari window", 8_000, () => [...safariWindows(d)].find((id) => !before.has(id))).catch(() => undefined);
    }
    if (windowId === undefined) throw new Error("Safari opened no new window — not measured (the test never uses a window of yours)");
    await (d.sleep ?? sleep)(3_000); // the page loads
    const fs = await d.turn(`
const w = await apps.open("com.apple.Safari", { window: ${windowId} });
const b = (await w.find({ role: "full screen button" }, { emit: false }))[0];
if (!b) report({ fullScreen: false }); else { await w.action(b.ref, "press"); report({ fullScreen: true }); }`);
    if (fs.facts.fullScreen !== true) throw new Error(`could not put the Safari window in full screen: ${fs.output.slice(-200)}`);
    fullScreen = true;
    await (d.sleep ?? sleep)(2_500);
    await d.returnUser();
    await (d.sleep ?? sleep)(2_000);
    d.abortIfInput();
    const m = await measure(d, variant, windowId, PAGE_FRESH_LAYOUT, [0, 0, 760, 460], since);
    d.abortIfInput();
    return { ...base, ok: true, windowId, placement: "full screen (its own button)", ...m, notes: [...base.notes, ...m.notes] };
  } catch (err) {
    return { ...base, ...(windowId === undefined ? {} : { windowId }), error: err instanceof Error ? err.message : String(err) };
  } finally {
    if (windowId !== undefined) {
      // Out of full screen, then ONLY that window closed — by its own buttons.
      await d.turn(`
const w = await apps.open("com.apple.Safari", { window: ${windowId} });
${fullScreen ? `const fsb = (await w.find({ role: "full screen button" }, { emit: false }))[0];
if (fsb) { await w.action(fsb.ref, "press"); await sleep(2500); }` : ""}
const close = (await w.find({ role: "close button" }, { emit: false }))[0];
if (close) { await w.action(close.ref, "press"); report({ closed: true }); } else report({ closed: false });`).catch(() => undefined);
      await (d.sleep ?? sleep)(1_000);
      await d.returnUser().catch(() => undefined);
    }
  }
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
