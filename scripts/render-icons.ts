/** One-shot brand-asset renderer: assets/brand/*.svg -> app icns (dist solid / dev hollow) +
 *  menu-bar template PNG sets (idle + 12 pulse frames each for thinking [whole-mark breathing] and
 *  working [rotating comet-tail], 1x/2x, black-on-transparent). Outputs are COMMITTED; this script
 *  re-runs only when the mark or the pulse math changes.
 *  Usage: bun run icons:render */
import { Resvg } from "@resvg/resvg-js";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const BRAND = join(ROOT, "assets", "brand");
const SUPPORT = join(ROOT, "apple", "Norma", "Support");
const MENUBAR = join(ROOT, "apple", "Norma", "Resources", "MenuBar");

const idleSvg = readFileSync(join(BRAND, "scale-burst.svg"), "utf8");
const FRAMES = 12; // pulse frames per cycle (also the ray count — see rayPaths())

/** Every <path .../> element, document order (the 12 rays). Loud-fail kept on the BASE mark
 *  (idleSvg / its hollow dev twin) — every generated frame is built by re-tagging THESE paths with
 *  a per-frame opacity, so a malformed base mark must still throw here rather than silently
 *  render a wrong frame count. */
function rayPaths(svg: string): string[] {
  const m = svg.match(/<path[^>]*\/>/g);
  if (!m || m.length !== 12) throw new Error(`expected 12 rays, got ${m?.length}`);
  return m;
}

/** menubar-anim REDESIGN NOTE: this used to be `rayOpacities(variantSvg)` — it parsed the CSS
 *  @keyframes out of assets/brand/scale-burst-{thinking,working}.svg and derived one STATIC
 *  per-ray opacity value per state, which `frameSvg` then rotated by k rays per frame. The math
 *  was verified wrong: rotating a 12-ray pattern built from a 4-period keyframe curve (thinking's
 *  named a/b/c/d dips) means every individual ray cycles through the WHOLE dip range roughly once
 *  every 4 frames — at 80ms/frame that's a brightness flip ~3x/second, which reads as shimmer or
 *  vanishing, not a pulse (compounded for "working" by its near-invisible [1,.95,.88,.81,.82]
 *  range). The functions below replace that entirely with a pure per-frame formula — they no
 *  longer read or derive anything from the variant SVGs' CSS keyframes at all. */

/** thinking: whole-mark breathing. Every ray shares ONE opacity for frame k — a smooth cosine ease
 *  1.0 -> 0.45 -> 1.0 across the FRAMES-frame cycle (paired with a slower 0.15s/frame cadence in
 *  MenuBarController: FRAMES * 0.15s ≈ 1.8s per full breath). */
function thinkingOpacities(k: number): number[] {
  const v = 0.45 + 0.55 * (0.5 + 0.5 * Math.cos((2 * Math.PI * k) / FRAMES));
  return Array(FRAMES).fill(v);
}

/** working: rotating comet-tail. A smooth 12-stop opacity gradient around the ring — the ray at
 *  the "head" (ray (k + FRAMES - 1) % FRAMES) is brightest (1.0), the one dimmest is a full turn
 *  behind it (0.35) — and the head advances by exactly one ray per frame, so it reads as genuine
 *  rotation (paired with a faster 0.10s/frame cadence in MenuBarController: FRAMES * 0.10s ≈ 1.2s
 *  per revolution — working is meant to read "busier" than thinking). */
function workingOpacities(k: number): number[] {
  return Array.from({ length: FRAMES }, (_, i) => 0.35 + 0.65 * (((i - k + FRAMES) % FRAMES) / (FRAMES - 1)));
}

/** Rebuild a variant SVG by applying a per-ray opacity array (ray i -> opacities[i]) onto the idle
 *  geometry, so every generated frame shares identical paths with the idle mark. */
function frameSvg(base: string, opacities: number[]): string {
  const paths = rayPaths(base);
  const applied = paths.map((p, i) => {
    const o = opacities[i]!;
    const clean = p.replace(/ ?opacity="[0-9.]+"/, "");
    return o >= 1 ? clean : clean.replace("<path", `<path opacity="${o}"`);
  });
  let out = base;
  for (let i = 0; i < paths.length; i++) out = out.replace(paths[i]!, applied[i]!);
  return out;
}

/** Hollow variant: same rays, stroke-only. */
function hollow(svg: string): string {
  return svg.replace('<g fill="#000">', '<g fill="none" stroke="#000" stroke-width="7" stroke-linejoin="miter">');
}

function renderPng(svg: string, px: number): Buffer {
  return Buffer.from(new Resvg(svg, { fitTo: { mode: "width", value: px } }).render().asPng());
}

/** App icon tile: light rounded-rect (radius 22.37% — Apple's squircle approximation), mark at
 *  68% centered. Composed in SVG so resvg does all rasterizing. */
function appIconSvg(mark: string, size: number): string {
  const inner = mark
    .replace(/<svg[^>]*>/, "")
    .replace("</svg>", "");
  const r = Math.round(size * 0.2237);
  const markSize = size * 0.68;
  const offset = (size - markSize) / 2;
  const scale = markSize / 240;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect x="0" y="0" width="${size}" height="${size}" rx="${r}" fill="#FAFAF7"/>
  <g transform="translate(${offset},${offset}) scale(${scale})">${inner}</g>
</svg>`;
}

function writeIcns(markSvg: string, outIcns: string, tmpName: string) {
  const iconset = join(ROOT, "out", `${tmpName}.iconset`);
  rmSync(iconset, { recursive: true, force: true });
  mkdirSync(iconset, { recursive: true });
  for (const s of [16, 32, 128, 256, 512]) {
    writeFileSync(join(iconset, `icon_${s}x${s}.png`), renderPng(appIconSvg(markSvg, s), s));
    writeFileSync(join(iconset, `icon_${s}x${s}@2x.png`), renderPng(appIconSvg(markSvg, s * 2), s * 2));
  }
  execSync(`iconutil -c icns "${iconset}" -o "${outIcns}"`);
  rmSync(iconset, { recursive: true, force: true });
}

mkdirSync(MENUBAR, { recursive: true });
writeIcns(idleSvg, join(SUPPORT, "AppIcon.icns"), "AppIcon");
writeIcns(hollow(idleSvg), join(SUPPORT, "AppIconDev.icns"), "AppIconDev");

for (const [prefix, mark] of [["mb", idleSvg], ["mb-dev", hollow(idleSvg)]] as const) {
  writeFileSync(join(MENUBAR, `${prefix}-idle.png`), renderPng(mark, 18));
  writeFileSync(join(MENUBAR, `${prefix}-idle@2x.png`), renderPng(mark, 36));
  for (const state of ["thinking", "working"] as const) {
    for (let k = 0; k < FRAMES; k++) {
      const opacities = state === "thinking" ? thinkingOpacities(k) : workingOpacities(k);
      const f = frameSvg(mark, opacities);
      writeFileSync(join(MENUBAR, `${prefix}-${state}-${k}.png`), renderPng(f, 18));
      writeFileSync(join(MENUBAR, `${prefix}-${state}-${k}@2x.png`), renderPng(f, 36));
    }
  }
}
console.log("icons rendered");
