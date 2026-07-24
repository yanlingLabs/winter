/** One-shot brand-asset renderer: assets/brand/*.svg -> app icns (dist solid / dev hollow) +
 *  menu-bar template PNG sets (idle + 12 rotated pulse frames for thinking/working, 1x/2x,
 *  black-on-transparent). Outputs are COMMITTED; this script re-runs only when the mark changes.
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
const variants = {
  thinking: readFileSync(join(BRAND, "scale-burst-thinking.svg"), "utf8"),
  working: readFileSync(join(BRAND, "scale-burst-working.svg"), "utf8"),
};

/** Every <path .../> element, document order (the 12 rays). */
function rayPaths(svg: string): string[] {
  const m = svg.match(/<path[^>]*\/>/g);
  if (!m || m.length !== 12) throw new Error(`expected 12 rays, got ${m?.length}`);
  return m;
}

/** Per-ray opacity (1 when unspecified).
 *
 *  ADAPTATION NOTE (verified shape differs from the brief's assumption): the brief's
 *  rayOpacities() assumed each <path> in the thinking/working variants carries a static
 *  opacity="0.x" attribute. The real source SVGs (yanling-scale-burst-{thinking,working}-v2.svg)
 *  instead encode the pulse purely via CSS: thinking uses four named @keyframes (a/b/c/d) keyed
 *  by a per-ray class, each dipping to a different minimum opacity; working uses one shared
 *  @keyframes "work" with per-ray `animation-delay` stagger (a travelling-phase pulse, matching
 *  its own <desc>: "a directional pulse travels across twelve independent rays"). A literal
 *  opacity="" attribute is never present, so the brief's regex would silently return 1 for every
 *  ray (all "pulse" frames pixel-identical to idle) — this is the ONE function adapted to read
 *  the real encoding instead. rayPaths(), frameSvg(), hollow(), appIconSvg(), writeIcns() and the
 *  overall pipeline are unchanged from the brief. */
function rayOpacities(svg: string): number[] {
  const paths = rayPaths(svg);
  const styleMatch = svg.match(/<style>([\s\S]*?)<\/style>/);
  if (!styleMatch) throw new Error("render-icons: no <style> block found in SVG — did the SVG format change?");
  const style = styleMatch[1]!;

  /** Extract the content of a named @keyframes block by brace-depth balance (not by hunting for
   *  a literal adjacent "}}", which over-reads when the SVG pretty-prints the block's closing
   *  brace on its own line — it then keeps matching into the next @-rule). Returns null when the
   *  name simply isn't declared at all (a legitimate case: e.g. the "working" variant has no
   *  per-letter @keyframes, only a shared "work" one — callers fall back accordingly). Throws if
   *  a block IS found but doesn't look like a real keyframes body, since that means the balance
   *  scan or the assumed SVG shape is wrong, not that the animation is absent. */
  function keyframesBlock(name: string): string | null {
    const startMarker = `@keyframes ${name}{`;
    const start = style.indexOf(startMarker);
    if (start === -1) return null;
    let depth = 1;
    let i = start + startMarker.length;
    for (; i < style.length; i++) {
      if (style[i] === "{") depth++;
      else if (style[i] === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    if (depth !== 0) {
      throw new Error(
        `render-icons: @keyframes ${name} block in <style> never closes (brace depth never returns to 0) — did the SVG format change?`,
      );
    }
    const block = style.slice(start + startMarker.length, i);
    if (block.includes("@")) {
      throw new Error(
        `render-icons: @keyframes ${name} block bled into a following @-rule (captured text contains "@") — did the SVG format change?`,
      );
    }
    if (!/[0-9%,]+\{/.test(block)) {
      throw new Error(
        `render-icons: @keyframes ${name} block in <style> contains no percentage stop (e.g. "50%{...}") — did the SVG format change?`,
      );
    }
    return block;
  }

  /** Parse a named @keyframes block into sorted {pct, op} stops (only steps that state an
   *  explicit opacity — CSS interpolates the omitted ones from their neighbors). Returns [] only
   *  when the name isn't declared at all (see keyframesBlock); throws if the block exists but not
   *  one of its stops states an opacity, since silently returning [] there would make callers fall
   *  back to a flat, pulse-less default instead of failing loud. */
  function keyframeStops(name: string): { pct: number; op: number }[] {
    const block = keyframesBlock(name);
    if (block === null) return [];
    const out: { pct: number; op: number }[] = [];
    for (const stop of block.matchAll(/([0-9%,]+)\{([^}]*)\}/g)) {
      const opM = stop[2]!.match(/opacity:([0-9.]+)/);
      if (!opM) continue;
      for (const pctStr of stop[1]!.split(",")) out.push({ pct: Number(pctStr.replace("%", "")), op: Number(opM[1]) });
    }
    if (!out.length) {
      throw new Error(
        `render-icons: @keyframes ${name} block in <style> has no stop with an explicit opacity — did the SVG format change?`,
      );
    }
    return out.sort((a, b) => a.pct - b.pct);
  }

  /** Linear-interpolate a keyframe curve at a given percent (wraps at 100%). */
  function sampleAt(stops: { pct: number; op: number }[], pct: number): number {
    if (!stops.length) {
      throw new Error("render-icons: sampleAt called with no keyframe stops — did the SVG format change?");
    }
    const p = ((pct % 100) + 100) % 100;
    for (let i = 0; i < stops.length; i++) {
      const a = stops[i]!;
      const b = stops[(i + 1) % stops.length]!;
      const span = ((b.pct - a.pct + 100) % 100) || 100;
      const d = ((p - a.pct) % 100 + 100) % 100;
      if (d <= span) return a.op + ((b.op - a.op) * d) / span;
    }
    return stops[0]!.op;
  }

  return paths.map((p) => {
    const direct = p.match(/opacity="([0-9.]+)"/);
    if (direct) return Number(direct[1]); // original brief shape, kept for forward-compat
    const cls = p.match(/class="p ([a-z]) p(\d+)"/);
    if (!cls) {
      throw new Error(
        `render-icons: ray <path> missing expected class="p <letter> p<index>" attribute — did the SVG format change? (${p.slice(0, 80)})`,
      );
    }
    const [, letter, idxStr] = cls;
    const letterStops = keyframeStops(letter!);
    if (letterStops.length) return Math.min(...letterStops.map((s) => s.op)); // thinking: each ray-class's dip depth
    // No letter-keyed keyframe (working): derive this ray's own phase from its animation-delay
    // against the single shared "work" curve — a real per-ray snapshot at t=0.
    const delayM = style.match(new RegExp(`\\.p${idxStr}\\{[^}]*?animation-delay:(-?[0-9.]+)s`));
    if (!delayM) {
      throw new Error(`render-icons: no animation-delay found for .p${idxStr} in <style> — did the SVG format change?`);
    }
    const delay = Number(delayM[1]);
    const durM = style.match(/animation:\s*work\s+([0-9.]+)s/);
    if (!durM) {
      throw new Error(`render-icons: no "animation: work <duration>s" declaration found in <style> — did the SVG format change?`);
    }
    const duration = Number(durM[1]);
    const workStops = keyframeStops("work");
    if (!workStops.length) {
      throw new Error(`render-icons: @keyframes work not found in <style> — did the SVG format change?`);
    }
    return sampleAt(workStops, (-delay / duration) * 100);
  });
}

/** Rebuild a variant SVG with the opacity PATTERN rotated by k rays (spinner pulse frame k),
 *  applied onto the idle geometry so every frame shares identical paths. */
function frameSvg(base: string, opacities: number[], k: number): string {
  const paths = rayPaths(base);
  const rotated = paths.map((p, i) => {
    const o = opacities[(i + k) % opacities.length]!;
    const clean = p.replace(/ ?opacity="[0-9.]+"/, "");
    return o >= 1 ? clean : clean.replace("<path", `<path opacity="${o}"`);
  });
  let out = base;
  for (let i = 0; i < paths.length; i++) out = out.replace(paths[i]!, rotated[i]!);
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
    const opacities = rayOpacities(variants[state]);
    for (let k = 0; k < 12; k++) {
      const f = frameSvg(mark, opacities, k);
      writeFileSync(join(MENUBAR, `${prefix}-${state}-${k}.png`), renderPng(f, 18));
      writeFileSync(join(MENUBAR, `${prefix}-${state}-${k}@2x.png`), renderPng(f, 36));
    }
  }
}
console.log("icons rendered");
