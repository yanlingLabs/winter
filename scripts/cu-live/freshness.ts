// The freshness measurement's PURE parts (unit-tested in freshness.test.ts, no screen): where the advancing regions
// are in a capture, what their cells SAY, how far each capture lags the truth, the per-phase verdicts and the table,
// the Safari preference save/restore plan, and the plan a dry run prints.
//
// The question it answers (a static Google Doc never could): does a window on ANOTHER Space keep painting, and does
// an active ScreenCaptureKit stream on it make a difference? Every advancing region shows the wall-clock counter
// floor(ms / 100) & 0xFFFF as 16 cells (MSB first, black = 1) and an odd-parity cell — FreshCode in the fixture's
// Fresh.swift and fresh.html draw the same rule — so a capture says which instant it shows.

export interface FreshRegion { name: string; x: number; y: number; cell: number; cells: number; kind: "counter" | "slot" }
export interface FreshLayout { sentinel: { x: number; y: number; size: number }; regions: FreshRegion[] }

const band = (name: string, y: number, kind: "counter" | "slot" = "counter"): FreshRegion => ({ name, x: 72, y, cell: 28, cells: kind === "slot" ? 16 : 17, kind });

/** The fixture's Fresh window, in its content points: the native band at 12, the web view from 56 (page + 56). */
export const FIXTURE_FRESH_LAYOUT: FreshLayout = {
  sentinel: { x: 8, y: 8, size: 48 },
  regions: [band("native", 12), band("dom", 64), band("canvas", 108), band("css", 152, "slot")],
};
/** `fresh.html?sentinel=1` in a browser of its own: the page draws the sentinel; the bands in page coordinates. */
export const PAGE_FRESH_LAYOUT: FreshLayout = {
  sentinel: { x: 8, y: 8, size: 48 },
  regions: [band("dom", 8), band("canvas", 52), band("css", 96, "slot")],
};

// ── what the cells say ────────────────────────────────────────────────────────────────────────────────────────

/** A cell's luma → its bit, or null when it is neither clearly dark nor clearly light (a capture mid-repaint). */
export function cellBit(luma: number): 0 | 1 | null {
  if (luma < 0) return null;
  if (luma <= 80) return 1;
  if (luma >= 175) return 0;
  return null;
}

/** 16 bits MSB first and the odd-parity cell → the counter, or null (unreadable, or the parity is wrong). */
export function decodeCounter(lumas: readonly number[]): number | null {
  if (lumas.length !== 17) return null;
  const bits = lumas.map(cellBit);
  if (bits.some((b) => b === null)) return null;
  const value = bits.slice(0, 16).reduce<number>((v, b) => (v << 1) | b!, 0);
  const ones = bits.slice(0, 16).filter((b) => b === 1).length;
  return (ones % 2) === bits[16] ? value : null;
}

/** The CSS band: exactly one dark slot of 16 → its index, else null. */
export function decodeSlot(lumas: readonly number[]): number | null {
  if (lumas.length !== 16) return null;
  const bits = lumas.map(cellBit);
  if (bits.some((b) => b === null)) return null;
  const dark = bits.flatMap((b, i) => (b === 1 ? [i] : []));
  return dark.length === 1 ? dark[0]! : null;
}

/** What each region should show at `ms`: the counter, or the CSS slot (period 1.6 s). */
export const idealCounter = (ms: number): number => Math.floor(ms / 100) & 0xffff;
export const idealSlot = (ms: number): number => Math.floor((ms % 1600) / 100);

/** How far behind `ms` a decoded value is, in ms (negative: a little ahead — the capture's time is its midpoint). */
export function lagMs(kind: FreshRegion["kind"], decoded: number, ms: number): number {
  if (kind === "counter") {
    const d = (idealCounter(ms) - decoded) & 0xffff;
    return (d >= 0x8000 ? d - 0x10000 : d) * 100;
  }
  const d = (idealSlot(ms) - decoded + 16) % 16;
  return (d >= 8 ? d - 16 : d) * 100;
}

// ── the measurement ───────────────────────────────────────────────────────────────────────────────────────────

/** One capture, as the sampler reported it. */
export interface CaptureRecord { phase: string; source: "skylight" | "stream"; file: string; t: number; ok: boolean; error?: unknown; frameAgeMs?: number; ms?: number }
/** The tool's line for one capture file. */
export interface DecodeLine { file: string; ok: boolean; error?: string; regions?: Record<string, { hash: string; lumas: number[] }> }
/** The fixture's `fresh.tick`: what each region really rendered, every 100 ms. */
export interface TickRecord { t: number; native?: number; dom?: number; canvas?: number }

export type Verdict = "fresh" | "partly fresh" | "stale" | "no captures";
export interface CellResult {
  region: string; phase: string; source: string;
  captures: number; images: number; decoded: number; unique: number;
  lagMedianMs: number | null; lagMaxMs: number | null;
  /** The region's own rendering against the wall clock (fixture ticks): did the CONTENT advance? */
  renderLagMedianMs: number | null;
  verdict: Verdict;
}

const median = (xs: readonly number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) / 2)]!;
};

/**
 * Fresh: the region changed in at least half the captures that decoded and its median lag is within a second;
 * stale: at most one distinct image; between them, partly fresh. (Report, don't assert: the verdict is data.)
 */
export function verdictOf(images: number, unique: number, lagMedianMs: number | null): Verdict {
  if (images === 0) return "no captures";
  if (unique <= 1) return "stale";
  if (unique >= Math.max(2, images / 2) && lagMedianMs !== null && Math.abs(lagMedianMs) <= 1_000) return "fresh";
  return "partly fresh";
}

export function analyzeFreshness(layout: FreshLayout, captures: readonly CaptureRecord[], decodes: readonly DecodeLine[], ticks: readonly TickRecord[]): CellResult[] {
  const byFile = new Map(decodes.map((d) => [d.file, d]));
  const keys: Array<{ phase: string; source: string }> = [];
  for (const c of captures) if (!keys.some((k) => k.phase === c.phase && k.source === c.source)) keys.push({ phase: c.phase, source: c.source });
  const out: CellResult[] = [];
  for (const { phase, source } of keys) {
    const mine = captures.filter((c) => c.phase === phase && c.source === source);
    const span = mine.length === 0 ? [0, 0] : [Math.min(...mine.map((c) => c.t)), Math.max(...mine.map((c) => c.t))];
    for (const r of layout.regions) {
      const hashes = new Set<string>();
      const lags: number[] = [];
      let images = 0, decoded = 0;
      for (const c of mine) {
        const d = c.ok ? byFile.get(c.file.split("/").pop()!) : undefined;
        const reg = d?.ok ? d.regions?.[r.name] : undefined;
        if (reg === undefined) continue;
        images++;
        hashes.add(reg.hash);
        const v = r.kind === "counter" ? decodeCounter(reg.lumas) : decodeSlot(reg.lumas);
        if (v === null) continue;
        decoded++;
        lags.push(lagMs(r.kind, v, c.t));
      }
      const tickLags: number[] = [];
      for (const t of ticks) {
        if (t.t < span[0]! || t.t > span[1]!) continue;
        const v = r.name === "native" ? t.native : r.name === "dom" ? t.dom : r.name === "canvas" ? t.canvas : undefined;
        if (v !== undefined) tickLags.push(lagMs("counter", v, t.t));
      }
      const lagMedianMs = median(lags);
      out.push({
        region: r.name, phase, source, captures: mine.length, images, decoded, unique: hashes.size,
        lagMedianMs, lagMaxMs: lags.length === 0 ? null : Math.max(...lags),
        renderLagMedianMs: median(tickLags),
        verdict: verdictOf(images, hashes.size, lagMedianMs),
      });
    }
  }
  return out;
}

/** The table: variant × region × phase/source → verdict, distinct images, lag. */
export function freshnessTable(variants: ReadonlyArray<{ variant: string; cells: readonly CellResult[]; note?: string }>): string {
  const rows: string[][] = [["variant", "region", "phase", "source", "verdict", "unique/images", "lag median/max", "content lag"]];
  for (const v of variants) {
    for (const c of v.cells) {
      rows.push([v.variant, c.region, c.phase, c.source, c.verdict, `${c.unique}/${c.images}`,
        c.lagMedianMs === null ? "—" : `${c.lagMedianMs}/${c.lagMaxMs} ms`, c.renderLagMedianMs === null ? "—" : `${c.renderLagMedianMs} ms`]);
    }
  }
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)));
  return rows.map((r) => r.map((cell, i) => cell.padEnd(widths[i]!)).join("  ").trimEnd()).join("\n");
}

// ── Safari's WebKit preferences (`--safari-webkit-prefs`) ─────────────────────────────────────────────────────

/** Astra's three keys: Safari imports them from its standard defaults into WebKit's preferences. */
export const SAFARI_PREF_KEYS = [
  "WebKitPreferences.hiddenPageDOMTimerThrottlingEnabled",
  "WebKitPreferences.hiddenPageDOMTimerThrottlingAutoIncreases",
  "WebKitPreferences.pageVisibilityBasedProcessSuppressionEnabled",
] as const;
/** Safari is sandboxed: its standard defaults are its container's plist (the path form `defaults` accepts). */
export const SAFARI_PREFS_DOMAIN = "Library/Containers/com.apple.Safari/Data/Library/Preferences/com.apple.Safari";

/** A key's original state: absent, or present with its `defaults` type flag and value. */
export type PrefOriginal = { present: false } | { present: true; type: "bool" | "int" | "float" | "string"; value: string };

/** `defaults read-type` → the write flag (`Type is boolean` → bool), or undefined for a type this cannot restore. */
export function prefTypeFlag(readTypeOutput: string): "bool" | "int" | "float" | "string" | undefined {
  const m = /Type is (\w+)/.exec(readTypeOutput);
  switch (m?.[1]) {
    case "boolean": return "bool";
    case "integer": return "int";
    case "float": return "float";
    case "string": return "string";
    default: return undefined;
  }
}

/** The `defaults` argument lists: apply (each key NO) and restore (each key back exactly; absent ones deleted). */
export function safariPrefsPlan(domain: string, originals: Readonly<Record<string, PrefOriginal>>): { apply: string[][]; restore: string[][] } {
  const apply = SAFARI_PREF_KEYS.map((k) => ["write", domain, k, "-bool", "NO"]);
  const restore = SAFARI_PREF_KEYS.map((k) => {
    const o = originals[k];
    if (o === undefined) throw new Error(`no recorded original for ${k}`);
    if (!o.present) return ["delete", domain, k];
    const value = o.type === "bool" ? (o.value === "1" || /^(yes|true)$/i.test(o.value) ? "YES" : "NO") : o.value;
    return ["write", domain, k, `-${o.type}`, value];
  });
  return { apply, restore };
}

/** What `--dry-run` prints for the freshness measurement (and its Safari variants). */
export function describeFreshnessPlan(o: { safari: boolean; safariPrefs: boolean }): string[] {
  const lines = [
    "fixture (a1) default WKWebView and (a2) _setWindowOcclusionDetectionEnabled:NO: the Fresh window to another Space, stream OFF 10 s → ON 20 s → OFF 10 s, a SkyLight still every 500 ms (+ the SCStream frame while ON), four regions (native, DOM, canvas, CSS)",
  ];
  if (o.safari) {
    lines.push(`Safari${o.safariPrefs ? " with the three WebKitPreferences keys set NO (Safari quit + relaunched before and after, originals restored exactly)" : ""}: fresh.html in a NEW window (open -g), full screen by its own button, the same three phases, then out of full screen and only that window closed`);
  }
  return lines;
}
