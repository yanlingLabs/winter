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
const FOLDER = "cu-live-folder";

export interface RealAppsRun { cleanup(): Promise<void> }

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
  writeFileSync(join(dir, "note.txt"), "First line of the temp note.\n");
  writeFileSync(join(dir, FOLDER, "alpha.txt"), "a\n");
  writeFileSync(join(dir, FOLDER, "beta.txt"), "b\n");
  writeFileSync(join(dir, "doc.pdf"), minimalPdf("Winter CU live PDF"));
  const before = new Map(APPS.map((a) => [a.name, running(a.name)] as const));
  const open = (args: string[]): void => { const r = spawnSync("open", args, { encoding: "utf8" }); if (r.status !== 0) throw new Error(`open ${args.join(" ")}: ${r.stderr}`); };
  log("opening temp documents in Safari, TextEdit, Finder and Preview (in the background)…");
  open(["-g", "-a", "TextEdit", join(dir, "note.txt")]);
  open(["-g", "-a", "Preview", join(dir, "doc.pdf")]);
  open(["-g", "-a", "Safari", join(dir, "page.html")]);
  open(["-g", join(dir, FOLDER)]);
  return {
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

/** Close the bound window with its own close button, and dismiss a save sheet if one appears. */
const CLOSE = `
async function closeOwn(app) {
  const btn = (await app.find({ role: "close button" }, { emit: false }))[0];
  if (!btn) throw new Error("no close button in the bound window");
  await app.action(btn.ref, "press");
  for (const label of ["Don't Save", "Revert Changes", "Delete"]) {
    const b = (await app.find({ role: "button", name: label }, { emit: false }))[0];
    if (b) { await app.action(b.ref, "press"); break; }
  }
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
await closeOwn(sf);
report({ titled: w });`,
    verify: (ctx) => [okRun(ctx), check("the page saw the typed text and the click", ctx.facts.titled === true)],
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
await closeOwn(te);
report({ value });`,
    verify: (ctx) => [okRun(ctx), check("the note holds the appended text", String(ctx.facts.value ?? "").includes("temp note. Appended ✓ by Winter."), String(ctx.facts.value))],
  },
  {
    name: "Finder: a temp folder — read its items", group: "real-apps", timeoutMs: 45_000,
    code: `${CLOSE}
const fd = await apps.open("com.apple.finder", { window: ${JSON.stringify(FOLDER)} });
const s = await fd.state({ emit: false, full: true });
const seen = { alpha: s.includes("alpha.txt"), beta: s.includes("beta.txt") };
await closeOwn(fd);
report(seen);`,
    verify: (ctx) => [okRun(ctx), check("Finder lists both temp files", ctx.facts.alpha === true && ctx.facts.beta === true, JSON.stringify(ctx.facts))],
  },
  {
    name: "Preview: a temp PDF — screenshot", group: "real-apps", timeoutMs: 45_000,
    code: `${CLOSE}
const pv = await apps.open("com.apple.Preview", { window: "doc.pdf" });
const img = await pv.screenshot({ emit: false });
await closeOwn(pv);
report({ w: img.width, h: img.height });`,
    verify: (ctx) => {
      const bytes = ctx.metrics.filter((m) => m.primitive === "screenshot").map((m) => Number(m.imageBytes));
      return [okRun(ctx), check("the PDF window was captured with content", bytes.length > 0 && Math.max(...bytes) > 8_000, `bytes ${bytes.join(", ")}`)];
    },
  },
];

/** For the report: the TextEdit note's text on disk (unchanged unless autosave wrote it). */
export function noteOnDisk(root: string): string {
  try { return readFileSync(join(root, REAL_DIR_NAME, "note.txt"), "utf8"); } catch { return ""; }
}
