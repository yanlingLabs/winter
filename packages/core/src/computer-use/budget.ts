// ComputerV2 (2026-10-08) — the screenshot budget, decided in the DAEMON from the session's model (spec §12,
// spine §5): the long edge and tiling each provider family reads best, JPEG at 0.8 stepped down under 3 MiB,
// and `computerUse.screenshotMaxDim` as an upper bound. The helper scales to it; the model never thinks about
// scale (a `Point` is pixels in the target's latest screenshot, mapped by the helper).
import { rowForTag } from "../runtime-sdk/provider-selection";
import type { ScreenshotBudget } from "./protocol";

export const SCREENSHOT_QUALITY = 0.8;
/** An encoded screenshot over this many bytes is re-taken at the next lower quality. */
export const SCREENSHOT_BYTE_CAP = 3 * 1024 * 1024;
const QUALITY_STEPS = [0.8, 0.6, 0.45, 0.3] as const;

/** The quality to retry at after `quality` came back over the byte cap, or `undefined` at the floor. */
export function nextScreenshotQuality(quality: number): number | undefined {
  return QUALITY_STEPS.find((q) => q < quality - 1e-9);
}

export type ScreenshotFamily = "anthropic" | "anthropic-5" | "openai" | "gemini" | "other";

/** Claude 5.x and later read the larger budget (2576 px / 4784 tiles). */
function isClaude5Plus(canonical: string): boolean {
  const m = /^claude-[a-z]+-(\d+)/.exec(canonical) ?? /^claude-(\d+)/.exec(canonical);
  return m !== null && Number(m[1]) >= 5;
}

/** The provider family a session's model belongs to, for its screenshot budget — by the catalog row's
 *  `modelFamily` (a Claude model on any provider is a Claude model), never by the provider id. */
export function screenshotFamilyFor(model: string | undefined): ScreenshotFamily {
  if (model === undefined) return "other";
  const row = rowForTag(model) as { modelFamily?: unknown; canonicalModelId?: unknown } | undefined;
  const family = typeof row?.modelFamily === "string" ? row.modelFamily : undefined;
  if (family === "claude") {
    const canonical = typeof row?.canonicalModelId === "string" ? row.canonicalModelId : model.slice(model.indexOf("/") + 1);
    return isClaude5Plus(canonical) ? "anthropic-5" : "anthropic";
  }
  if (family === "gpt" || family === "o-series") return "openai";
  if (family === "gemini") return "gemini";
  return "other";
}

const FAMILY_BUDGETS: Readonly<Record<ScreenshotFamily, Omit<ScreenshotBudget, "quality">>> = {
  "anthropic": { maxLongEdge: 1568, tile: 28, maxTiles: 1568 },
  "anthropic-5": { maxLongEdge: 2576, tile: 28, maxTiles: 4784 },
  "openai": { maxLongEdge: 1440, tile: 32 },
  "gemini": { maxLongEdge: 1440 },
  "other": { maxLongEdge: 1280 },
};

/** The budget for one screenshot. `maxDim` (`computerUse.screenshotMaxDim`) only ever LOWERS the long edge. */
export function screenshotBudgetFor(model: string | undefined, maxDim: number | undefined, quality: number = SCREENSHOT_QUALITY): ScreenshotBudget {
  const base = FAMILY_BUDGETS[screenshotFamilyFor(model)];
  const maxLongEdge = maxDim !== undefined && maxDim > 0 ? Math.min(base.maxLongEdge, Math.floor(maxDim)) : base.maxLongEdge;
  return { ...base, maxLongEdge, quality };
}
