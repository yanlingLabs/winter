// The live suite's group `adapters` (ComputerV2 Phase 2: app adapters delivered at bind) — data plus assertions, no
// I/O of its own beyond making its temp documents; `run.ts` does the driving.
//
//   - on the FIXTURE (always): the extras block once per session and the one line after it; AX-backed extras (a test
//     adapter the live daemon adds — `FIXTURE_ADAPTER`, built only of `target.find` and `target.act`) that fill a
//     field, read it back and press a button, judged by the fixture's own log and state; `help()` topics; and a
//     generated `app.dict.markFixture(…)` on the fixture's own sdef (swift/Fixture/WinterCUFixture.sdef), judged by the
//     `script.mark` event the fixture logs;
//   - with `--real-apps`: Finder `reveal`/`selection`/`trash` (only a file this run made) /`openWith` on temp
//     documents, and Safari `openURL` (a temp page) / `pageText` / `tabs`, closing the tab it opened through
//     `app.dict.close({ ref })`.
//
// EVERY AppleScript-backed scenario first asks the live-test helper, which never asks the user, whether it already
// holds the Automation grant for that app (`test.automation`, `AEDeterminePermissionToAutomateTarget` with
// `askUserIfNeeded: false` — the -1744 path), and SKIPS with a note otherwise: a test never raises a TCC prompt. The
// question is put when the scenario starts (its `code` is read then), after the apps it needs are open. Notes, Mail and
// Xcode are live-gate drills only — they would touch the user's own data.
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { adapterProblems } from "../../packages/core/src/computer-use/adapters/registry";
import type { AppAdapter } from "../../packages/core/src/computer-use/adapters/types";
import type { Built } from "./build";
import { check, eventsSince, statusOf, type ScenarioResult } from "./lib";
import { FIXTURE_APP, FIXTURE_BUNDLE, type Scenario, type VerifyContext } from "./scenarios";

/** The fixture's adapter — TEST-ONLY, added to the live daemon only (`daemon-entry.ts`, `ComputerUseInjection.adapters`):
 *  its extras are composed of the AX doors alone, the way any extra may be. */
export const FIXTURE_ADAPTER: AppAdapter = {
  bundleIds: [FIXTURE_BUNDLE],
  guide: { id: "cu-live-fixture@1", text: "The live suite's fixture. Its Form window has the Name and Email fields and a Submit button; fill(), fieldValue() and submit() work on them by their labels." },
  extras: [
    {
      name: "fieldValue", access: "view", signature: "fieldValue(label: string): Promise<string | null>", summary: "the value of the Form's text field with that label",
      async run(scope, args) {
        const els = await scope.find({ role: "text field", name: String(args[0] ?? "") });
        return els[0]?.value ?? null;
      },
    },
    {
      name: "fill", access: "full", signature: "fill(label: string, text: string): Promise<void>", summary: "sets the Form's text field with that label",
      async run(scope, args) {
        const els = await scope.find({ role: "text field", name: String(args[0] ?? "") });
        if (els[0] === undefined) throw new Error(`no text field labelled ${String(args[0])}`);
        await scope.act({ kind: "setValue", ref: els[0].ref, value: String(args[1] ?? "") });
        return undefined;
      },
    },
    {
      name: "submit", access: "click", signature: "submit(): Promise<void>", summary: "presses the Form's Submit button",
      async run(scope) {
        const els = await scope.find({ role: "button", name: "Submit" });
        if (els[0] === undefined) throw new Error("no Submit button");
        await scope.act({ kind: "action", ref: els[0].ref, name: "AXPress" });
        return undefined;
      },
    },
  ],
};

/** The live-test helper's door (`run.ts`'s `helperCall` on the run's socket and home). */
export type HelperDoor = (method: string, params: Record<string, unknown>) => { result?: unknown; error?: unknown };

/** May the live-test helper already script this app? `granted`, else the reason it may not (never asks). The runner
 *  reads a scenario's code more than once as it starts, so an answer is reused for a few seconds. */
const answers = new WeakMap<HelperDoor, Map<string, { status: string; at: number }>>();
export function automationStatus(door: HelperDoor, bundleId: string, now: number = Date.now()): string {
  let asked = answers.get(door);
  if (asked === undefined) { asked = new Map(); answers.set(door, asked); }
  const hit = asked.get(bundleId);
  if (hit !== undefined && now - hit.at < 10_000) return hit.status;
  const r = door("test.automation", { bundleId });
  const raw = (r.result as { status?: unknown } | undefined)?.status;
  const status = typeof raw === "string" ? raw : `unknown (${JSON.stringify(r.error ?? r.result ?? null).slice(0, 120)})`;
  asked.set(bundleId, { status, at: now });
  return status;
}

const SKIP_WORDS: Record<string, string> = {
  would_ask: "macOS would ask the user first",
  denied: "the user said no",
  not_running: "the app is not running",
};
/** The script of a skipped AppleScript-backed scenario: one fact, so the row reads "skip" with its reason. */
export function automationSkip(app: string, status: string): string {
  return `report({ skipped: ${JSON.stringify(`no Automation grant for ${app} yet (${SKIP_WORDS[status] ?? status}) — not asked: a test never raises the prompt; grant it once in a live gate and run again`)} });`;
}

/** A scenario whose code is decided when it starts: the AppleScript-backed body only with the grant already held. */
function gated(base: Omit<Scenario, "code">, door: HelperDoor | undefined, bundleId: string, app: string, body: string): Scenario {
  return Object.defineProperty({ ...base }, "code", {
    enumerable: true,
    get(): string {
      if (door === undefined) return automationSkip(app, "no live-test helper");
      const status = automationStatus(door, bundleId);
      return status === "granted" ? body : automationSkip(app, status);
    },
  }) as Scenario;
}

const ok = (ctx: VerifyContext) => check("the script ran without an error", !ctx.isError, ctx.output.slice(-300));
const skipped = (ctx: VerifyContext): boolean => typeof ctx.facts.skipped === "string";
const BLOCK_HEAD = `${FIXTURE_APP} extras — on this app's handle: .extras.<name>(…); .help() shows them again`;
const MARK = "adapters ✓ \"mark\"";

/** The real-apps temp documents this group makes (beside `realAppsPreflight`'s), in `<dir>/adapters` — only named,
 *  not made, for a plan (`write: false`). */
export function adapterDocs(dir: string, write = true): { folder: string; reveal: string; trash: string; open: string } {
  const folder = join(dir, "adapters");
  if (!write) return { folder, reveal: join(folder, "reveal-me.txt"), trash: join(folder, "trash-me.txt"), open: join(folder, "adapters-open.txt") };
  mkdirSync(folder, { recursive: true });
  const docs = { folder, reveal: join(folder, "reveal-me.txt"), trash: join(folder, "trash-me.txt"), open: join(folder, "adapters-open.txt") };
  writeFileSync(docs.reveal, "revealed by the adapters group\n");
  writeFileSync(docs.trash, "a file the live run made, to be moved to the Trash\n");
  writeFileSync(docs.open, "opened with TextEdit by the adapters group\n");
  // Finder reports real paths (/private/var/…): compare against those.
  return { folder: realpathSync(folder), reveal: realpathSync(docs.reveal), trash: realpathSync(docs.trash), open: realpathSync(docs.open) };
}

/** The real-apps page `realAppsPreflight` opened in Safari, and the second page this group opens in a new tab. */
const SAFARI_PAGE = "CU Live Page";
const SAFARI_PAGE2 = "CU Live Page Two";

/**
 * The group. `door`: the live-test helper (for the Automation question); `realDir`: the `--real-apps` documents
 * folder (absent: only the fixture scenarios).
 */
export function adapterScenarios(o: { door?: HelperDoor; realDir?: string; plan?: boolean }): Scenario[] {
  const out: Scenario[] = [
    {
      name: "adapters: the fixture's extras block once per session, then one line; the handle lists them", group: "adapters", session: "fresh",
      code: `
const form = await apps.open(${JSON.stringify(FIXTURE_APP)}, { window: "Fixture Form" });
const again = await apps.open(${JSON.stringify(FIXTURE_APP)}, { window: "Fixture Form" });
report({ extras: Object.keys(again.extras), dict: Object.keys(again.dict), then: typeof again.extras.then });`,
      verify: (ctx) => [ok(ctx),
        check("the first bind printed the block (unfenced, before its state)", ctx.output.includes(BLOCK_HEAD) && ctx.output.includes("Guide cu-live-fixture@1:"), ctx.output.slice(0, 600)),
        check("the block was printed once; the second bind said it was shown earlier", ctx.output.split("Guide cu-live-fixture@1:").length === 2 && ctx.output.includes(`(${FIXTURE_APP}: extras, dictionary commands and guide cu-live-fixture@1 were shown earlier`), ctx.output.slice(0, 1_200)),
        check("the handle lists the extras", JSON.stringify(ctx.facts.extras) === JSON.stringify(["fieldValue", "fill", "submit"]), JSON.stringify(ctx.facts.extras)),
        check("the handle lists the fixture's dictionary command (helper 1.8.0)", Array.isArray(ctx.facts.dict) && (ctx.facts.dict as string[]).includes("markFixture"), JSON.stringify(ctx.facts.dict)),
        check("then is never callable on the extras", ctx.facts.then === "undefined", String(ctx.facts.then))],
    },
    {
      name: "adapters: AX-backed extras fill a field, read it back and press Submit — in the background", group: "adapters",
      before: [{ role: "main", cmd: "reset" }], dump: true,
      code: `
const form = await win("Fixture Form");
await form.extras.fill("Name", ${JSON.stringify(MARK)});
const value = await form.extras.fieldValue("Name");
await form.extras.submit();
report({ value });`,
      verify: (ctx) => [ok(ctx),
        check("fieldValue() read the text fill() set", ctx.facts.value === MARK, JSON.stringify(ctx.facts.value)),
        check("the fixture's Name field holds it", ctx.state?.name === MARK, JSON.stringify(ctx.state?.name)),
        check("Submit was pressed (the fixture's log)", eventsSince(ctx.events, ctx.since, "button").some((e) => e.id === "submit"), JSON.stringify(eventsSince(ctx.events, ctx.since, "button"))),
        check("the extras' names are in the metrics (never their arguments)", ["fill", "fieldValue", "submit"].every((n) => ctx.metrics.some((m) => m.primitive === "extra" && m.extra === n)) && !JSON.stringify(ctx.metrics).includes("adapters ✓"), JSON.stringify(ctx.metrics.filter((m) => m.primitive === "extra")))],
    },
    {
      name: "adapters: help() topics — the block, one extra, the dictionary (read from the sdef, no AppleScript)", group: "adapters",
      code: `
const form = await win("Fixture Form");
const all = await form.help({ emit: false });
const one = await form.help("fill", { emit: false });
const dict = await form.help("dict", { emit: false });
let bad = null;
try { await form.help("nope"); } catch (e) { bad = e.name; }
report({ all: all.includes("Guide cu-live-fixture@1:"), one: one.startsWith("fill(label: string, text: string)"), dict: dict.includes("markFixture(direct: string, { repeats?: integer, flagged?: boolean, tone?: \\"plain\\" | \\"loud\\", tags?: string[] })"), bad });`,
      verify: (ctx) => [ok(ctx),
        check("help() is the block", ctx.facts.all === true), check("help(name) is that extra", ctx.facts.one === true),
        check("help(\"dict\") lists markFixture with its typed parameters", ctx.facts.dict === true, ctx.output.slice(-800)),
        check("an unknown topic is a TypeError", ctx.facts.bad === "TypeError", String(ctx.facts.bad))],
    },
    gated({
      name: "adapters: app.dict.markFixture(…) runs the fixture's own sdef command — every kind of value arrives", group: "adapters",
      verify: (ctx) => {
        if (skipped(ctx)) return [ok(ctx)];
        const mark = eventsSince(ctx.events, ctx.since, "script.mark").at(-1);
        return [ok(ctx),
          check("the result came back like applescript()'s", ctx.facts.result === `marked: ${MARK}`, JSON.stringify(ctx.facts.result)),
          check("the fixture logged the text, the integer, the boolean, the enumerator and the list", mark !== undefined && mark.text === MARK && mark.repeats === 3 && mark.flagged === true && mark.tone === "loud" && JSON.stringify(mark.tags) === JSON.stringify(["a", "b \"c\"\nd"]), JSON.stringify(mark))];
      },
    }, o.door, FIXTURE_BUNDLE, FIXTURE_APP, `
const form = await win("Fixture Form");
const r = await form.dict.markFixture(${JSON.stringify(MARK)}, { repeats: 3, flagged: true, tone: "loud", tags: ["a", "b \\"c\\"\\nd"] });
report({ result: r.result });`),
  ];
  if (o.realDir === undefined) return out;

  const docs = adapterDocs(o.realDir, o.plan !== true);
  const finderWindows = `const finderWindows = async () => (await screen.windows({ emit: false })).filter((w) => w.app === "Finder");`;
  /** Close the window a Finder (or TextEdit) bind made for this run, by its own close button — never one of the user's. */
  const closeMade = `
async function closeMade(app, made) {
  if (!made) return "left as it was (not one this run made)";
  const btn = (await app.find({ role: "close button" }, { emit: false }))[0];
  if (!btn) return "no close button";
  await app.action(btn.ref, "press");
  return "closed";
}`;
  out.push(
    gated({
      name: "adapters: Finder reveal + selection of a temp file — only in a window Finder made for the run", group: "adapters", timeoutMs: 45_000,
      verify: (ctx) => skipped(ctx) ? [ok(ctx)] : [ok(ctx),
        check("reveal() worked in the bound (new) window", ctx.facts.revealed === true || ctx.facts.revealed === false, JSON.stringify(ctx.facts)),
        check("selection() returned the revealed file (or said the bound window is not Finder's frontmost)", (Array.isArray(ctx.facts.selected) && (ctx.facts.selected as string[]).includes(docs.reveal)) || String(ctx.facts.selected).startsWith("NoWindow"), JSON.stringify(ctx.facts.selected)),
        check("the window this run made was closed again", ctx.facts.closed === "closed", String(ctx.facts.closed))],
    }, o.door, "com.apple.finder", "Finder", `${finderWindows}${closeMade}
const before = (await finderWindows()).length;
const fd = await apps.open(${JSON.stringify(docs.folder)});
// Only a window Finder made for this run is worked in: a folder shown in one of the user's windows (a tab) is left alone.
if ((await finderWindows()).length <= before) report({ skipped: "Finder showed the folder in a window it already had (maybe the user's) — no extra was used there" });
else {
  const r = await fd.extras.reveal(${JSON.stringify(docs.reveal)});
  let selected;
  try { selected = await fd.extras.selection(); } catch (e) { selected = e.name + ": " + e.message; }
  report({ revealed: r.selected, selected, closed: await closeMade(fd, true) });
}`),
    gated({
      name: "adapters: Finder trash (a file this run made) + openWith TextEdit, in the background", group: "adapters", timeoutMs: 45_000,
      verify: (ctx) => skipped(ctx) ? [ok(ctx)] : [ok(ctx),
        check("trash() reported one item", ctx.facts.trashed === 1, JSON.stringify(ctx.facts.trashed)),
        check("the file is gone from the run's folder (it is in the Trash)", !existsSync(docs.trash)),
        check("openWith() opened it in TextEdit", ctx.facts.opened === "TextEdit", JSON.stringify(ctx.facts.opened)),
        check("TextEdit's window for it was closed again", ctx.facts.teClosed === "closed", String(ctx.facts.teClosed))],
    }, o.door, "com.apple.finder", "Finder", `${finderWindows}${closeMade}
const before = (await finderWindows()).length;
const fd = await apps.open(${JSON.stringify(docs.folder)});
const t = await fd.extras.trash(${JSON.stringify(docs.trash)});
const o = await fd.extras.openWith(${JSON.stringify(docs.open)}, "TextEdit");
const te = await apps.open("com.apple.TextEdit", { window: "adapters-open.txt" });
const teClosed = await closeMade(te, true);
report({ trashed: t.trashed, opened: o.opened, teClosed, closed: await closeMade(fd, (await finderWindows()).length > before) });`),
    gated({
      name: "adapters: Safari in a window of its OWN (openWindow, bound by id): openURL, pageText, tabs, closed by id", group: "adapters", timeoutMs: 60_000,
      verify: (ctx) => skipped(ctx) ? [ok(ctx)] : [ok(ctx),
        check("openWindow() gave the run its own window, bound by that id", typeof ctx.facts.own === "number" && ctx.facts.boundOwn === true, JSON.stringify(ctx.facts)),
        check("openURL() added a tab to THAT window, its current tab kept", typeof ctx.facts.tab === "number" && ctx.facts.currentKept === true, JSON.stringify(ctx.facts)),
        check("pageText() read the new tab's text", ctx.facts.text === true, JSON.stringify(ctx.facts)),
        check("tabs() listed the own window's two tabs", ctx.facts.listed === true, JSON.stringify(ctx.facts)),
        check("the own window was closed again (by its id)", ctx.facts.closed === true, JSON.stringify(ctx.facts))],
    }, o.door, "com.apple.Safari", "Safari", `
// Safari's scripting is reached through the run's page window (bound by its title, read only: no extra acts in it);
// everything else happens in a NEW window the run makes and binds by its exact id.
const anchor = await apps.open("com.apple.Safari", { window: ${JSON.stringify(SAFARI_PAGE)} });
const { window: own } = await anchor.extras.openWindow(${JSON.stringify(`file://${o.realDir}/page.html`)});
const sf = await apps.open("com.apple.Safari", { window: own });
const boundOwn = (await sf.windows()).some((w) => w.id === own);
const where = await sf.extras.openURL(${JSON.stringify(`file://${o.realDir}/page2.html`)});
let text = "";
const t0 = Date.now();
while (!text.includes(${JSON.stringify(SAFARI_PAGE2)}) && Date.now() - t0 < 8000) { text = await sf.extras.pageText({ tab: where.tab }); if (!text.includes(${JSON.stringify(SAFARI_PAGE2)})) await sleep(250); }
const tabs = await sf.extras.tabs();
const mine = tabs.find((t) => t.tab === where.tab);
const current = tabs.find((t) => t.current);
// Close what the run made, by exact references: its extra tab, then its own window.
await sf.dict.close({ ref: "tab " + where.tab + " of window id " + own });
await sf.dict.close({ ref: "window id " + own });
const left = await anchor.applescript('tell application id "com.apple.Safari" to return (exists window id ' + own + ') as text', { emit: false });
report({ own, boundOwn, tab: where.tab, text: text.includes(${JSON.stringify(SAFARI_PAGE2)}), listed: tabs.length === 2 && mine !== undefined && mine.url.endsWith("page2.html"), currentKept: current !== undefined && current.tab !== where.tab, closed: left.result === "false" });`),
  );
  return out;
}

/** The dry run's rows (no screen): the fixture carries its dictionary, the test adapter is valid, and the plan. */
export function adaptersDryRun(built: Pick<Built, "fixtureMain">, o: { realApps: boolean }): ScenarioResult[] {
  const t0 = Date.now();
  const resources = join(built.fixtureMain, "Contents", "Resources");
  const plist = join(built.fixtureMain, "Contents", "Info.plist");
  const key = (k: string): string => spawnSync("plutil", ["-extract", k, "raw", plist], { encoding: "utf8" }).stdout.trim();
  const sdef = join(resources, key("OSAScriptingDefinition") || "WinterCUFixture.sdef");
  const lint = spawnSync("xmllint", ["--noout", "--xinclude", sdef], { encoding: "utf8" });
  const text = existsSync(sdef) ? readFileSync(sdef, "utf8") : "";
  const fixture = [
    check("the fixture is scriptable (NSAppleScriptEnabled, OSAScriptingDefinition)", key("NSAppleScriptEnabled") === "true" && key("OSAScriptingDefinition") === "WinterCUFixture.sdef", `${key("NSAppleScriptEnabled")} ${key("OSAScriptingDefinition")}`),
    check("its sdef is in the bundle and parses (Standard Suite included)", existsSync(sdef) && lint.status === 0, lint.stderr.trim().slice(0, 300)),
    check("it declares mark fixture (WCUFmark) with its cocoa class", text.includes('code="WCUFmark"') && text.includes('<cocoa class="WCUMarkCommand"/>')),
    check("the fixture's test adapter is a valid adapter", adapterProblems([FIXTURE_ADAPTER]).length === 0, adapterProblems([FIXTURE_ADAPTER]).join("; ")),
  ];
  const plan = adapterScenarios({ plan: true, ...(o.realApps ? { realDir: "/the-real-apps-folder" } : {}) });
  return [
    { name: "adapters: the fixture's dictionary and test adapter", group: "adapters", status: statusOf(fixture), ms: Date.now() - t0, checks: fixture },
    { name: "plan: adapters", group: "plan", status: "pass", ms: 0, checks: [check("planned", true)],
      note: `${plan.length} scenarios: ${plan.map((s) => s.name.replace(/^adapters: /, "")).join(" | ")} — every AppleScript-backed one runs only when test.automation answers granted (never asking), else it skips with a note` },
  ];
}
