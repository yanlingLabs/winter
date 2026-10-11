// ComputerV2 Phase 2 — a tab's screenshot at the session model's budget (`screenshotBudgetFor`, the helper's rule:
// the long edge, and `ceil(w/tile) × ceil(h/tile) ≤ maxTiles`), and the mapping back: a `Point` is pixels in the
// image, sent to the page as CSS px of the viewport.
import type { ScreenshotBudget } from "../protocol";

export interface CssRect { x: number; y: number; width: number; height: number }

/** The output pixel size of `css` captured at `scale` on a `dpr` display (Chrome renders at device pixels). */
export function outputSize(css: { width: number; height: number }, scale: number, dpr: number): { w: number; h: number } {
  return { w: Math.max(1, Math.round(css.width * scale * dpr)), h: Math.max(1, Math.round(css.height * scale * dpr)) };
}

export function fitsBudget(w: number, h: number, budget: ScreenshotBudget): boolean {
  if (Math.max(w, h) > budget.maxLongEdge) return false;
  if (budget.tile !== undefined && budget.maxTiles !== undefined) {
    if (Math.ceil(w / budget.tile) * Math.ceil(h / budget.tile) > budget.maxTiles) return false;
  }
  return true;
}

/** The largest `clip.scale` (≤ 1/dpr·dpr, i.e. never upscaled past device pixels) whose output meets the budget. */
export function scaleFor(css: { width: number; height: number }, dpr: number, budget: ScreenshotBudget): number {
  const d = dpr > 0 ? dpr : 1;
  let s = Math.min(1, budget.maxLongEdge / (Math.max(css.width, css.height) * d));
  for (let i = 0; i < 200; i++) {
    const { w, h } = outputSize(css, s, d);
    if (fitsBudget(w, h, budget)) return s;
    s *= 0.97;
  }
  return s;
}

/** The pixel size of a JPEG (SOF marker) or PNG (IHDR) given as base64 — undefined when it can't be read. */
export function imageSize(base64: string): { width: number; height: number } | undefined {
  let bytes: Uint8Array;
  try { bytes = Uint8Array.from(Buffer.from(base64.slice(0, 1 << 20), "base64")); } catch { return undefined; }
  if (bytes.length > 24 && bytes[0] === 0x89 && bytes[1] === 0x50) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: dv.getUint32(16), height: dv.getUint32(20) };
  }
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) { i++; continue; }
    const marker = bytes[i + 1]!;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    const len = (bytes[i + 2]! << 8) | bytes[i + 3]!;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: (bytes[i + 5]! << 8) | bytes[i + 6]!, width: (bytes[i + 7]! << 8) | bytes[i + 8]! };
    }
    i += 2 + len;
  }
  return undefined;
}

/** One screenshot's frame: its image size and the viewport rectangle (CSS px) it shows. */
export interface ShotFrame { width: number; height: number; css: CssRect }

/** An image pixel → CSS px of the viewport. */
export function toCss(shot: ShotFrame, x: number, y: number): { x: number; y: number } {
  return { x: shot.css.x + (x * shot.css.width) / shot.width, y: shot.css.y + (y * shot.css.height) / shot.height };
}
