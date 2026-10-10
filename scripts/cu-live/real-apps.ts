// `--real-apps`: a smaller set against Safari, TextEdit, Finder and Preview — on TEMP documents only, opened by the
// runner in the background (`open -g`). Each scenario closes the window it worked in through THAT window's own close
// button (never a shortcut: cmd+w acts on the app's active window, which may be one of the user's), and the cleanup
// quits only an app this run launched itself. Same focus/Space assertions as every scenario.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { check, type Check } from "./lib";
import type { Scenario, VerifyContext } from "./scenarios";

export const REAL_DIR_NAME = "cu-live-real";
const PAGE_TITLE = "CU Live Page";
const PAGE2_TITLE = "CU Live Page Two";
const FOLDER = "cu-live-folder";

export interface RealAppsRun { dir: string; cleanup(): Promise<void> }

/** Stands for the run's temp documents folder in a scenario's code; `withRealDir` puts the real path in. */
export const REAL_DIR_TOKEN = "__CU_LIVE_REAL_DIR__";

export function withRealDir(s: Scenario, dir: string): Scenario {
  return { ...s, code: s.code.split(REAL_DIR_TOKEN).join(dir) };
}

const APPS = [
  { name: "TextEdit", bundleId: "com.apple.TextEdit" },
  { name: "Preview", bundleId: "com.apple.Preview" },
  { name: "Safari", bundleId: "com.apple.Safari" },
] as const;

function running(name: string): number[] {
  const r = spawnSync("pgrep", ["-x", name], { encoding: "utf8" });
  return (r.stdout ?? "").split("\n").map(Number).filter((n) => Number.isInteger(n) && n > 0);
}

/** A one-page PDF with a line of text — hand-written, so no tool is needed to make it. */
export function minimalPdf(text: string): string {
  const stream = `BT /F1 24 Tf 72 700 Td (${text.replace(/[()\\]/g, "")}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((o, i) => { offsets.push(body.length); body += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return body;
}

/** Make the temp documents, note which apps were already running, and open the documents in the background. */
export function realAppsPreflight(root: string, log: (l: string) => void): RealAppsRun {
  const dir = join(root, REAL_DIR_NAME);
  mkdirSync(join(dir, FOLDER), { recursive: true });
  writeFileSync(join(dir, "page.html"), `<!doctype html><html><head><meta charset="utf-8"><title>${PAGE_TITLE}</title></head><body>
<h1>${PAGE_TITLE}</h1><input id="live" aria-label="Live Input">
<button id="go" onclick="document.title = 'Clicked: ' + document.getElementById('live').value">Live Button</button></body></html>\n`);
  writeFileSync(join(dir, "page2.html"), `<!doctype html><html><head><meta charset="utf-8"><title>${PAGE2_TITLE}</title></head><body><h1>${PAGE2_TITLE}</h1></body></html>\n`);
  writeFileSync(join(dir, "note.txt"), "First line of the temp note.\n");
  writeFileSync(join(dir, FOLDER, "alpha.txt"), "a\n");
  writeFileSync(join(dir, FOLDER, "beta.txt"), "b\n");
  writeFileSync(join(dir, "doc.pdf"), minimalPdf("Winter CU live PDF"));
  const before = new Map(APPS.map((a) => [a.name, running(a.name)] as const));
  const open = (args: string[]): void => { const r = spawnSync("open", args, { encoding: "utf8" }); if (r.status !== 0) throw new Error(`open ${args.join(" ")}: ${r.stderr}`); };
  // Not the folder: Finder may put an `open`ed folder in a TAB of the user's own window (on any Space) — the Finder
  // scenario makes a NEW Finder window for it instead.
  log("opening temp documents in Safari, TextEdit and Preview (in the background)…");
  open(["-g", "-a", "TextEdit", join(dir, "note.txt")]);
  open(["-g", "-a", "Preview", join(dir, "doc.pdf")]);
  open(["-g", "-a", "Safari", join(dir, "page.html")]);
  return {
    dir,
    async cleanup(): Promise<void> {
      // Quit only what this run launched (it held nothing of the user's): SIGTERM, no Apple Event.
      for (const a of APPS) {
        if ((before.get(a.name) ?? []).length > 0) continue;
        for (const pid of running(a.name)) { try { process.kill(pid, "SIGTERM"); } catch { /* gone */ } }
      }
    },
  };
}

const okRun = (ctx: VerifyContext): Check => check("the script ran without an error", !ctx.isError, ctx.output.slice(-300));

/**
 * Close the bound window with its own close button, and dismiss a save sheet if one appears. Once the window has
 * closed, the bound target is gone: a look for a sheet then answers TargetLost/NoWindow (or times out), which
 * means the close worked — reported as `closed`, never thrown.
 */
const CLOSE = `
async function closeOwn(app) {
  const btn = (await app.find({ role: "close button" }, { emit: false }))[0];
  if (!btn) throw new Error("no close button in the bound window");
  await app.action(btn.ref, "press");
  for (const label of ["Don't Save", "Revert Changes", "Delete"]) {
    let b;
    try { b = (await app.find({ role: "button", name: label }, { emit: false }))[0]; } catch (e) { report({ closed: "window gone (" + e.name + ")" }); return; }
    if (b) { await app.action(b.ref, "press"); report({ closed: "after " + label }); return; }
  }
  report({ closed: "no sheet" });
}`;

export const REAL_APP_SCENARIOS: Scenario[] = [
  {
    name: "Safari: a local page — type, click, read the title", group: "real-apps", timeoutMs: 45_000,
    code: `${CLOSE}
const sf = await apps.open("com.apple.Safari", { window: ${JSON.stringify(PAGE_TITLE)} });
const input = await pick(sf, "Live Input", "text field");
await sf.type("safari ✓", { into: input.ref });
const go = await pick(sf, "Live Button", "button");
await sf.action(go.ref, "press");
const w = await sf.waitFor({ title: "Clicked: safari ✓" }, { timeoutMs: 5000 }).then(() => true, () => false);
report({ titled: w });
// The bound window's OWN address field, with the window in the background: ⌘L, a URL, Return — it loads there.
let refused = null;
try { await sf.key("cmd+l"); } catch (e) { refused = e.name + ": " + String(e.message).slice(0, 200); }
let loaded = false;
if (refused === null) {
  await sf.type("file://${REAL_DIR_TOKEN}/page2.html");
  await sf.key("return");
  loaded = await sf.waitFor({ title: ${JSON.stringify(PAGE2_TITLE)} }, { timeoutMs: 8000 }).then(() => true, () => false);
}
report({ loaded, refused });
await closeOwn(sf);`,
    verify: (ctx) => [okRun(ctx), check("the page saw the typed text and the click", ctx.facts.titled === true),
      check("⌘L, a URL and Return loaded it in the bound window (the address field of the window in the background)", ctx.facts.loaded === true,
        String(ctx.facts.refused ?? ctx.output.slice(-300))),
      check("never a silent success: a Return that loaded nothing says so", ctx.facts.loaded === true || /did not change after Return|refused|Unsupported|Error/i.test(`${String(ctx.facts.refused ?? "")} ${ctx.output}`),
        ctx.output.slice(-300))],
  },
  {
    name: "TextEdit: a temp note — append text", group: "real-apps", timeoutMs: 45_000,
    code: `${CLOSE}
const te = await apps.open("com.apple.TextEdit", { window: "note.txt" });
const area = (await te.find({ role: "text area" }, { emit: false }))[0];
if (!area) throw new Error("no text area");
await te.select(area.ref, "temp note.", { caret: "end" });
await te.type(" Appended ✓ by Winter.", { into: area.ref });
const value = (await te.find({ role: "text area" }, { emit: false }))[0]?.value ?? "";
report({ value });
await closeOwn(te);`,
    verify: (ctx) => [okRun(ctx), check("the note holds the appended text", String(ctx.facts.value ?? "").includes("temp note. Appended ✓ by Winter."), String(ctx.facts.value))],
  },
  {
    name: "Finder: a temp folder — read its items", group: "real-apps", timeoutMs: 45_000,
    // The temp folder opened by the helper itself (apps.open of a path: NSWorkspace, never activating Finder) — no
    // AppleScript: Finder's dictionary needs an Automation grant, and a test must never put a TCC prompt on screen.
    // Only a window Finder made for it (more Finder windows than before) is closed again, by its own close button;
    // a window it reused (one of the user's, a tab in it) or one bound capture only is a skip, left as it is.
    code: `
const folder = ${JSON.stringify(`${REAL_DIR_TOKEN}/${FOLDER}`)};
const finderWindows = async () => (await screen.windows({ emit: false })).filter((w) => w.app === "Finder");
const before = (await finderWindows()).length;
const fd = await apps.open(folder);
const s = await fd.state({ emit: false, full: true });
const after = await finderWindows();
const ours = after.filter((w) => w.title === ${JSON.stringify(FOLDER)});
if (/no accessibility here/i.test(s)) report({ skipped: "Finder showed the folder in a window accessibility never saw (another Space: capture only) — left as it is" });
else if (after.length <= before) report({ skipped: "Finder reused a window it already had (yours, or a tab in it) — read, but left as it is", alpha: s.includes("alpha.txt"), beta: s.includes("beta.txt") });
else {
  report({ alpha: s.includes("alpha.txt"), beta: s.includes("beta.txt"), onScreen: ours.map((w) => w.onScreen) });
  // Its close button only, and only when the bound window is the folder's (its header names it) — no sheet
  // handling here: a Finder window's toolbar may carry a "Delete" button.
  const header = s.split("\\n")[0] ?? "";
  const btn = header.includes(${JSON.stringify(FOLDER)}) ? (await fd.find({ role: "close button" }, { emit: false }))[0] : undefined;
  if (btn) { await fd.action(btn.ref, "press"); report({ closed: "pressed its close button" }); }
  else report({ closed: false, header });
}`,
    verify: (ctx) => typeof ctx.facts.skipped === "string" ? [okRun(ctx)] : [okRun(ctx),
      check("Finder lists both temp files", ctx.facts.alpha === true && ctx.facts.beta === true, JSON.stringify(ctx.facts)),
      check("the window Finder made for it was closed again", typeof ctx.facts.closed === "string", String(ctx.facts.closed))],
  },
  {
    name: "Preview: a temp PDF — screenshot", group: "real-apps", timeoutMs: 45_000,
    code: `${CLOSE}
const pv = await apps.open("com.apple.Preview", { window: "doc.pdf" });
const img = await pv.screenshot({ emit: false });
report({ w: img.width, h: img.height });
await closeOwn(pv);`,
    verify: (ctx) => {
      const shots = ctx.shots.filter((s) => s.error === undefined);
      return [okRun(ctx), check("the PDF window was captured, and its pixels are not blank", shots.length > 0 && shots.every((s) => !s.blank), shots.map((s) => `σ${s.stddevLuma.toFixed(1)}`).join(", ") || "no screenshot")];
    },
  },
];

/** For the report: the TextEdit note's text on disk (unchanged unless autosave wrote it). */
export function noteOnDisk(root: string): string {
  try { return readFileSync(join(root, REAL_DIR_NAME, "note.txt"), "utf8"); } catch { return ""; }
}
