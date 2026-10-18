import type { UsageRecordInput } from "./db";
import { tokenCount } from "./ingest-files";
import { shortStr } from "./plan";
import type { UsagePricer } from "./pricing";

// Claude Code's own long-term usage cache (`docs/claude/usage.md`): `<claude config dir>/stats-cache.json`, the file
// behind its `/stats` command. Claude Code deletes old transcripts (30 days by default); this cache keeps per-day,
// per-model totals after they are gone. Winter backfills ONLY the days its transcript ingest cannot cover.
//
// What the numbers mean (read from Claude Code 2.1.293's bundled code; cache `version` 5, `dailyModelTokensVersion` 5):
//  - `dailyModelTokens[].tokensByModel[model]` = input + output + cache read + cache write of every assistant message
//    whose OWN timestamp falls on that UTC date (`toISOString` day). Before `dailyModelTokensVersion` 5 the figure was
//    input + output only (cache excluded) and keyed by the session's first message: such a file is scaled up to all four
//    kinds with the model's all-time ratios. A v5 rebuild recomputes the days from the transcripts still on disk, so
//    the file's coverage starts at its last rebuild, not at `firstSessionDate`.
//  - `modelUsage[model]` = all-time sums of the four kinds; `costUSD` is not accrued by that code (it stays 0), so a
//    zero cost is priced by Winter's catalog instead (a positive one is shared out by tokens, as the brief asks).
//  - Claude Code counts a streamed message once per transcript line (no message-id dedupe), so its totals run HIGHER
//    than Winter's deduped transcript rows. Each import calibrates against the days both cover (see `calibration`).
//
// PRIVACY: the file also holds session counts, hour histograms and `longestSession` (a session id). Only
// `dailyModelTokens`, `modelUsage` and `lastComputedDate` are read; everything else is dropped with the parse.

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

/**
 * PURE: the calibration — Winter's deduped transcript totals ÷ Claude Code's own totals over the days both cover
 * reliably (after the first transcript day, within the last `CLAUDE_STATS_OVERLAP_DAYS`, before today, computed by
 * Claude Code). Per model; a model with no overlap takes the factor of all models together; none at all → 1. Clamped
 * to at most 1: it only ever corrects Claude Code's per-line over-count, never inflates.
 */
export function calibration(stats: ClaudeStats, real: readonly RealDayTotal[], cutoffDay: string | undefined, today: string, overlapFromDay: string):
  { byModel: Map<string, number>; global: number } {
  const byModel = new Map<string, number>();
  if (cutoffDay === undefined) return { byModel, global: 1 };
  const inOverlap = (d: string): boolean => d > cutoffDay && d >= overlapFromDay && d < today && (stats.lastComputedDate === undefined || d <= stats.lastComputedDate);
  const s = new Map<string, number>();
  const t = new Map<string, number>();
  let S = 0;
  let T = 0;
  for (const [day, models] of stats.days) {
    if (!inOverlap(day)) continue;
    for (const [model, tokens] of models) { s.set(model, (s.get(model) ?? 0) + tokens); S += tokens; }
  }
  for (const r of real) {
    if (!inOverlap(r.day) || !stats.days.has(r.day)) continue;
    const v = stats.countsCache ? r.all : r.io;
    t.set(r.model, (t.get(r.model) ?? 0) + v);
    T += v;
  }
  const global = S > 0 && T > 0 ? Math.min(1, T / S) : 1;
  for (const [model, sm] of s) {
    const tm = t.get(model) ?? 0;
    if (sm > 0 && tm > 0) byModel.set(model, Math.min(1, tm / sm));
  }
  return { byModel, global };
}

export interface StatsBackfillInput {
  stats: ClaudeStats;
  /** UTC day of the earliest TRANSCRIPT-derived Claude Code record (synthetic rows excluded); undefined = none. */
  cutoffDay?: string;
  /** Today, UTC. */
  today: string;
  real: readonly RealDayTotal[];
  overlapFromDay: string;
  pricer: UsagePricer;
}

/**
 * PURE: the synthetic rows Claude Code's `/stats` cache yields — one per model per day, for days BEFORE the first day
 * Winter's transcript ingest has (so a day is never counted twice), before today and no later than the cache's
 * `lastComputedDate`. A day's tokens are calibrated, then split by the model's all-time ratios; the cost is the
 * model's `costUSD` share when Claude Code kept one, else the catalog's list price of the split, else unknown.
 */
export function claudeStatsRecords(input: StatsBackfillInput): UsageRecordInput[] {
  const { stats, cutoffDay, today, pricer } = input;
  const cal = calibration(stats, input.real, cutoffDay, today, input.overlapFromDay);
  const out: UsageRecordInput[] = [];
  for (const [day, models] of [...stats.days].sort(([a], [b]) => a.localeCompare(b))) {
    if (cutoffDay !== undefined && day >= cutoffDay) continue;
    if (day >= today) continue;
    if (stats.lastComputedDate !== undefined && day > stats.lastComputedDate) continue;
    for (const [model, raw] of models) {
      const mu = stats.models.get(model);
      const io = mu === undefined ? 0 : mu.input + mu.output;
      // A pre-v5 day counts input + output only: scale it to all four kinds by the model's all-time ratio.
      const full = stats.countsCache || mu === undefined || io <= 0 ? raw : (raw * allOf(mu)) / io;
      const tokens = Math.round(full * (cal.byModel.get(model) ?? cal.global));
      if (tokens <= 0) continue;
      const split = splitByRatios(tokens, mu);
      const base = {
        dedupe: `ccstats:${model}:${day}`, source: "claude-code" as const, at: utcNoon(day), provider: "anthropic", model, synthetic: true,
      };
      if (split === undefined) {
        // No all-time ratios for this model: the tokens stay visible (as input), with no price — never a guess.
        out.push({ ...base, input: tokens, output: 0, cacheRead: 0, cacheWrite: 0, costBasis: "unknown" });
        continue;
      }
      const priced = mu !== undefined && mu.costUsd > 0
        ? { costUsd: (mu.costUsd * tokens) / allOf(mu), cacheSavingsUsd: pricer.savingsFor("anthropic", model, split.cacheRead) }
        : pricer.price("anthropic", model, split);
      out.push(priced === undefined
        ? { ...base, ...split, costBasis: "unknown" }
        : { ...base, ...split, costUsd: priced.costUsd, costBasis: "estimate", cacheSavingsUsd: priced.cacheSavingsUsd });
    }
  }
  return out;
}

/** The overlap window's first day for `now`. */
export const overlapFrom = (now: number): string => utcDay(now - CLAUDE_STATS_OVERLAP_DAYS * DAY_MS);
