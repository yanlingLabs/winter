import type { UsageRecordInput } from "./db";
import { tokenCount } from "./ingest-files";
import { shortStr } from "./plan";
import type { UsagePricer } from "./pricing";

// Claude Code's own long-term usage cache (`docs/claude/usage.md`): `<claude config dir>/stats-cache.json`, the file
// behind its `/stats` command. Claude Code deletes old transcripts (30 days by default); this cache keeps per-day,
// per-model totals after they are gone. Winter backfills ONLY what its transcript rows lack, on the days whose transcripts
// may be gone (`StatsCoverage`).
//
// What the numbers mean (read from Claude Code 2.1.293's bundled code; cache `version` 5, `dailyModelTokensVersion` 5):
//  - `dailyModelTokens[].tokensByModel[model]` = input + output + cache read + cache write of every assistant message
//    whose OWN timestamp falls on that UTC date (`toISOString` day). Before `dailyModelTokensVersion` 5 the figure was
//    input + output only (cache excluded) and keyed by the session's first message: such a file is scaled up to all four
//    kinds with the model's all-time ratios. A v5 rebuild recomputes the days from the transcripts still on disk, so
//    the file's coverage starts at its last rebuild, not at `firstSessionDate`.
//  - `modelUsage[model]` = all-time sums of the four kinds; `costUSD` is not accrued by that code (it stays 0). Every
//    synthetic row is priced by Winter's catalog (one basis with the transcript rows); a positive `costUSD` is used only
//    for a model the catalog cannot price, shared out by tokens.
//  - Claude Code counts a streamed message once per transcript line (no message-id dedupe), so its totals run HIGHER
//    than Winter's deduped transcript rows. Each import calibrates against the days both cover (see `calibration`).
//
// PRIVACY: the file also holds session counts, hour histograms and `longestSession` (a session id). Only
// `dailyModelTokens`, `modelUsage`, `lastComputedDate` and `dailyModelTokensVersion` are read; everything else is
// dropped with the parse.

export const CLAUDE_STATS_FILE = "stats-cache.json";
/** Over this, `stats-cache.json` is not read at all (a real one is a few tens of KiB). */
export const CLAUDE_STATS_MAX_BYTES = 8 * 1024 * 1024;
/** The calibration window: days this recent are inside Claude Code's default 30-day transcript retention. */
export const CLAUDE_STATS_OVERLAP_DAYS = 28;

const DAY_MS = 86_400_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface ClaudeStatsModel { input: number; output: number; cacheRead: number; cacheWrite: number; costUsd: number }

export interface ClaudeStats {
  /** UTC day → model → tokens. */
  days: Map<string, Map<string, number>>;
  /** All-time per model. */
  models: Map<string, ClaudeStatsModel>;
  lastComputedDate?: string;
  /** `dailyModelTokensVersion` ≥ 5: a day's figure counts all four kinds; older files count input + output only. */
  countsCache: boolean;
}

/** A `YYYY-MM-DD` that is a real calendar date, else undefined. */
export function statsDate(v: unknown): string | undefined {
  if (typeof v !== "string" || !DATE_RE.test(v)) return undefined;
  const t = Date.parse(`${v}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().startsWith(v) ? v : undefined;
}

/** The UTC day of an epoch ms. */
export const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
/** Noon UTC of a day: the same calendar date in every zone from UTC−12 to UTC+11:59, so local day buckets see it. */
export const utcNoon = (day: string): number => Date.parse(`${day}T12:00:00Z`);

const modelName = (v: string): string | undefined => {
  const m = shortStr(v, 80);
  return m === undefined || m === "<synthetic>" ? undefined : m;
};
const money = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** PURE: the three keys Winter uses, validated; undefined when the text is not a stats cache (corrupt, wrong shape). */
export function parseClaudeStats(text: string): ClaudeStats | undefined {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return undefined; }
  if (!isObj(parsed) || !Array.isArray(parsed.dailyModelTokens)) return undefined;
  const days = new Map<string, Map<string, number>>();
  for (const entry of parsed.dailyModelTokens) {
    if (!isObj(entry)) continue;
    const date = statsDate(entry.date);
    if (date === undefined || !isObj(entry.tokensByModel)) continue;
    const day = days.get(date) ?? new Map<string, number>();
    for (const [raw, value] of Object.entries(entry.tokensByModel)) {
      const model = modelName(raw);
      const tokens = tokenCount(value);
      if (model === undefined || tokens === 0) continue;
      day.set(model, (day.get(model) ?? 0) + tokens);
    }
    if (day.size > 0) days.set(date, day);
  }
  const models = new Map<string, ClaudeStatsModel>();
  if (isObj(parsed.modelUsage)) {
    for (const [raw, u] of Object.entries(parsed.modelUsage)) {
      const model = modelName(raw);
      if (model === undefined || !isObj(u)) continue;
      models.set(model, {
        input: tokenCount(u.inputTokens), output: tokenCount(u.outputTokens), cacheRead: tokenCount(u.cacheReadInputTokens),
        cacheWrite: tokenCount(u.cacheCreationInputTokens), costUsd: money(u.costUSD),
      });
    }
  }
  const lastComputedDate = statsDate(parsed.lastComputedDate);
  const v = parsed.dailyModelTokensVersion;
  const countsCache = typeof v === "number" && Number.isFinite(v) && v >= 5;
  return { days, models, ...(lastComputedDate === undefined ? {} : { lastComputedDate }), countsCache };
}

const allOf = (m: ClaudeStatsModel): number => m.input + m.output + m.cacheRead + m.cacheWrite;

/** PURE: `total` tokens split by a model's all-time ratios (whole tokens, summing exactly to `total`). */
export function splitByRatios(total: number, m: ClaudeStatsModel | undefined): { input: number; output: number; cacheRead: number; cacheWrite: number } | undefined {
  if (m === undefined) return undefined;
  const sum = allOf(m);
  if (sum <= 0) return undefined;
  const weights = [m.input, m.output, m.cacheRead, m.cacheWrite];
  const parts = weights.map((w) => Math.floor((total * w) / sum));
  const largest = weights.indexOf(Math.max(...weights));
  parts[largest]! += total - parts.reduce((a, b) => a + b, 0);
  return { input: parts[0]!, output: parts[1]!, cacheRead: parts[2]!, cacheWrite: parts[3]! };
}

export interface RealDayTotal { model: string; day: string; all: number; io: number }

/** Claude Code's default transcript retention (its `cleanupPeriodDays`). Winter never reads the user's Claude Code
 *  settings (that file can hold secrets): a shorter setting leaves some emptied days counted as complete, a longer one
 *  has a few complete days estimated (their shortfall only, never the whole day). */
export const CLAUDE_TRANSCRIPT_RETENTION_DAYS = 30;
/** With no day both cover, Claude Code's per-line figures are scaled by this: Winter's deduped totals ÷ Claude Code's over
 *  26 complete days measured in October 2026 (single days 0.39–0.70). */
export const CLAUDE_STATS_FALLBACK_CALIBRATION = 0.53;
/** An estimate is re-calibrated while fewer shared days than this back it; from then on it is kept as made. */
export const CLAUDE_STATS_SETTLED_DAYS = 7;

/** Which days Winter's transcript rows may NOT hold in full. */
export interface StatsCoverage {
  /** The earliest transcript-derived day; undefined = no transcripts at all (every day is history). */
  firstTranscriptDay?: string;
  /** The last day Claude Code's cleanup may have emptied before Winter FIRST read the transcripts: the UTC day of (the
   *  first pass − the retention). Every day after it was read while all of its transcripts were still on disk. */
  partialThrough?: string;
  /** Spans (inclusive) whose transcripts may have gone while Winter was not reading them: no complete pass for longer
   *  than the retention (the daemon not running, Claude Code tracking switched off). */
  gaps: ReadonlyArray<readonly [string, string]>;
}

/** PURE: may `day`'s transcripts be gone, in part or whole? */
export function isPartialDay(c: StatsCoverage, day: string): boolean {
  if (c.firstTranscriptDay === undefined || day < c.firstTranscriptDay) return true;
  if (c.partialThrough !== undefined && day <= c.partialThrough) return true;
  return c.gaps.some(([a, b]) => a <= day && day <= b);
}

/** A day the calibration may compare: complete, and not the first transcript day (it may begin part-way). */
const comparable = (c: StatsCoverage, day: string): boolean => !isPartialDay(c, day) && day !== c.firstTranscriptDay;

/**
 * PURE: the calibration — Winter's deduped transcript totals ÷ Claude Code's own totals over the SAME (model, day) pairs
 * both have tokens for, on COMPLETE days only (a day whose transcripts are partly gone would drag it down), within the
 * last `CLAUDE_STATS_OVERLAP_DAYS`, before today, computed by Claude Code. Per model once the model's own pairs span
 * `CLAUDE_STATS_SETTLED_DAYS` (a day or two of one model is noise: 0.30 measured against 0.43 messages per transcript
 * line); before that, and for a model with no pair, the factor of all shared pairs together; none at all →
 * `CLAUDE_STATS_FALLBACK_CALIBRATION`. Clamped to at most 1: it only ever corrects Claude Code's per-line over-count,
 * never inflates. `days` = the distinct days behind it.
 */
export function calibration(stats: ClaudeStats, real: readonly RealDayTotal[], coverage: StatsCoverage, today: string, overlapFromDay: string):
  { byModel: Map<string, number>; global: number; days: number } {
  const byModel = new Map<string, number>();
  const inOverlap = (d: string): boolean => comparable(coverage, d) && d >= overlapFromDay && d < today
    && (stats.lastComputedDate === undefined || d <= stats.lastComputedDate);
  const s = new Map<string, number>();
  const t = new Map<string, number>();
  const modelDays = new Map<string, Set<string>>();
  const days = new Set<string>();
  let S = 0;
  let T = 0;
  for (const r of real) {
    if (!inOverlap(r.day)) continue;
    const theirs = stats.days.get(r.day)?.get(r.model) ?? 0;
    const ours = stats.countsCache ? r.all : r.io;
    if (theirs <= 0 || ours <= 0) continue; // only pairs BOTH have
    s.set(r.model, (s.get(r.model) ?? 0) + theirs);
    t.set(r.model, (t.get(r.model) ?? 0) + ours);
    modelDays.set(r.model, (modelDays.get(r.model) ?? new Set<string>()).add(r.day));
    days.add(r.day);
    S += theirs;
    T += ours;
  }
  if (S <= 0 || T <= 0) return { byModel, global: CLAUDE_STATS_FALLBACK_CALIBRATION, days: 0 };
  for (const [model, sm] of s) {
    const tm = t.get(model) ?? 0;
    if (sm > 0 && tm > 0 && (modelDays.get(model)?.size ?? 0) >= CLAUDE_STATS_SETTLED_DAYS) byModel.set(model, Math.min(1, tm / sm));
  }
  return { byModel, global: Math.min(1, T / S), days: days.size };
}

/** Winter's estimate of one model's partial day: what the day held in all, deduped — kept in the usage DB, so it outlives
 *  Claude Code's cache listing the day. */
export interface StatsEstimate {
  /** Claude Code's figure for the day in all four kinds — the largest it has listed (a rebuild of its cache from the
   *  transcripts left can shrink or drop a day). */
  raw: number;
  /** The calibration applied, and the shared days behind it (0 = the fallback). */
  cal: number;
  days: number;
  /** The model's all-time split (input, output, cache read, cache write), when Claude Code listed one. */
  split?: [number, number, number, number];
  /** Claude Code's own cost per token, for a model the catalog cannot price. */
  usdPerToken?: number;
}

/** An estimate's key: the day, then the model. */
export const estimateKey = (model: string, day: string): string => `${day}:${model}`;
const keyDay = (key: string): string => key.slice(0, 10);
const keyModel = (key: string): string => key.slice(11);

export interface StatsPlanInput {
  stats: ClaudeStats;
  coverage: StatsCoverage;
  /** Today, UTC. */
  today: string;
  /** Winter's transcript totals per model per day since `overlapFromDay` (the calibration's side). */
  real: readonly RealDayTotal[];
  overlapFromDay: string;
}

/**
 * PURE: the estimates after reading Claude Code's cache — one per model per PARTIAL day it lists (before today, no later
 * than its `lastComputedDate`). A day's figure is scaled to all four kinds (a pre-v5 file counts input + output only)
 * and only ever grows; the calibration is replaced while a better-founded one exists and the old one rests on fewer than
 * `CLAUDE_STATS_SETTLED_DAYS`, then kept. A day the cache stops listing keeps its estimate; a day that is no longer
 * partial (transcripts reached it) loses it.
 */
export function refreshEstimates(prev: ReadonlyMap<string, StatsEstimate>, input: StatsPlanInput): { estimates: Map<string, StatsEstimate>; changed: boolean } {
  const { stats, coverage, today } = input;
  const cal = calibration(stats, input.real, coverage, today, input.overlapFromDay);
  const out = new Map<string, StatsEstimate>();
  let changed = false;
  for (const [key, e] of prev) {
    if (isPartialDay(coverage, keyDay(key))) out.set(key, e);
    else changed = true;
  }
  for (const [day, models] of stats.days) {
    if (!isPartialDay(coverage, day) || day >= today) continue;
    if (stats.lastComputedDate !== undefined && day > stats.lastComputedDate) continue;
    for (const [model, value] of models) {
      const mu = stats.models.get(model);
      const io = mu === undefined ? 0 : mu.input + mu.output;
      // A pre-v5 day counts input + output only: scale it to all four kinds by the model's all-time ratio.
      const full = stats.countsCache || mu === undefined || io <= 0 ? value : (value * allOf(mu)) / io;
      const key = estimateKey(model, day);
      const p = out.get(key);
      const raw = Math.max(p?.raw ?? 0, full);
      const recalibrate = p === undefined || (p.days < CLAUDE_STATS_SETTLED_DAYS && cal.days > p.days);
      if (p !== undefined && !recalibrate && raw === p.raw) continue;
      const split: [number, number, number, number] | undefined = mu !== undefined && allOf(mu) > 0
        ? [mu.input, mu.output, mu.cacheRead, mu.cacheWrite] : p?.split;
      const usdPerToken = mu !== undefined && mu.costUsd > 0 && allOf(mu) > 0 ? mu.costUsd / allOf(mu) : p?.usdPerToken;
      out.set(key, {
        raw,
        ...(recalibrate ? { cal: cal.byModel.get(model) ?? cal.global, days: cal.days } : { cal: p.cal, days: p.days }),
        ...(split === undefined ? {} : { split }),
        ...(usdPerToken === undefined ? {} : { usdPerToken }),
      });
      changed = true;
    }
  }
  return { estimates: out, changed };
}

/**
 * PURE: the synthetic rows — for each estimate on a still-partial day, what the transcripts left of it lack: the
 * calibrated figure minus Winter's own transcript tokens for that model and day (`real`, keyed like the estimates), when
 * positive. So a day is never counted twice, and a complete day is never touched. The shortfall is split by the model's
 * all-time ratios; the cost is the catalog's list price of the split (the same basis as every transcript row), else —
 * for a model the catalog cannot price — Claude Code's own cost per token if it kept one, else unknown.
 */
export function statsRows(estimates: ReadonlyMap<string, StatsEstimate>, coverage: StatsCoverage, real: ReadonlyMap<string, number>, pricer: UsagePricer): UsageRecordInput[] {
  const out: UsageRecordInput[] = [];
  for (const [key, e] of [...estimates].sort(([a], [b]) => a.localeCompare(b))) {
    const day = keyDay(key);
    if (!isPartialDay(coverage, day)) continue;
    const model = keyModel(key);
    const tokens = Math.round(e.raw * e.cal) - (real.get(key) ?? 0);
    if (tokens <= 0) continue;
    const base = {
      dedupe: `ccstats:${model}:${day}`, source: "claude-code" as const, at: utcNoon(day), provider: "anthropic", model, synthetic: true,
    };
    const split = e.split === undefined ? undefined
      : splitByRatios(tokens, { input: e.split[0], output: e.split[1], cacheRead: e.split[2], cacheWrite: e.split[3], costUsd: 0 });
    if (split === undefined) {
      // No all-time ratios for this model: the tokens stay visible (as input), with no price — never a guess.
      out.push({ ...base, input: tokens, output: 0, cacheRead: 0, cacheWrite: 0, costBasis: "unknown" });
      continue;
    }
    const priced = pricer.price("anthropic", model, split)
      ?? (e.usdPerToken !== undefined ? { costUsd: e.usdPerToken * tokens, cacheSavingsUsd: 0 } : undefined);
    out.push(priced === undefined
      ? { ...base, ...split, costBasis: "unknown" }
      : { ...base, ...split, costUsd: priced.costUsd, costBasis: "estimate", cacheSavingsUsd: priced.cacheSavingsUsd });
  }
  return out;
}

/** The overlap window's first day for `now`. */
export const overlapFrom = (now: number): string => utcDay(now - CLAUDE_STATS_OVERLAP_DAYS * DAY_MS);
