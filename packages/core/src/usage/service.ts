import { createHash, randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmdirSync, rmSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { AGY_TIMEOUT_BACKOFF_MS, antigravityPlanFromCli } from "./antigravity";
import { CLAUDE_JSON_MAX_BYTES, claudeCodeRecordOf, claudeCodeTranscripts, claudeCacheFile, claudePlanFromCli, claudeSubscriptionType, readCapped } from "./claude-code";
import {
  CLAUDE_STATS_FILE, CLAUDE_STATS_MAX_BYTES, CLAUDE_TRANSCRIPT_RETENTION_DAYS, estimateKey, isPartialDay, overlapFrom, parseClaudeStats, refreshEstimates,
  statsDate, statsRows, utcDay, utcNoon, type ClaudeStats, type StatsCoverage, type StatsEstimate,
} from "./claude-stats";
import { codexPlanFromAppServer, codexPlanFromRollouts, codexRecordOf, codexRollouts, codexStateOf } from "./codex";
import { USAGE_SOURCES, type AlarmProvider, type FiredUsageAlarm, type Subscription, type SyntheticRow, type UsageAlarm, type UsageDb, type UsageRecordInput, type UsageRow, type UsageSource } from "./db";
import { fileKey, readNewLines, type FoundFile } from "./ingest-files";
import {
  OPENCODE_ALL_ARGS, OPENCODE_SETTLE_AFTER_DAY_MS, currentTimeZone, dayMinus, daysBefore, localDay, localDayEnd, localDayStart, localNoon, opencodeDayRecords, opencodeDaysArgs,
  opencodeDifference, opencodeFingerprint, runOpencodeStats, sameOpencodeStats, type OpencodeStats,
} from "./opencode";
import { planWindowKey, staleness, type PlanReading, type PlanStatusWindow, type PlanWindow } from "./plan";
import type { UsagePricer } from "./pricing";

// The usage service (`docs/claude/usage.md`): records Winter's own turns as they end, ingests the user's Codex and
// Claude Code usage ON DEMAND (when a Usage surface asks — no watcher, no timer: an idle daemon does nothing), reads
// the plans (Codex, Claude Code, Antigravity) through their source ladders, keeps the user's one-shot plan alarms (every
// plan read judges them; a background beat reads the plans — `startBackground`), and answers the `usage.*` RPCs.

export type UsageRange = "1h" | "24h" | "7d" | "30d" | "all";
export const USAGE_RANGES: readonly UsageRange[] = ["1h", "24h", "7d", "30d", "all"];

export interface UsageTracking { codex: boolean; claudeCode: boolean; antigravity: boolean; opencode: boolean }

export interface UsageServiceDeps {
  db: UsageDb;
  pricer: UsagePricer;
  /** LIVE: which external sources the user lets Winter read (`settings.usage`). */
  tracking: () => UsageTracking;
  /** `<CODEX_HOME>` (undefined = no Codex install to read). */
  codexHome?: string;
  /** Claude Code's config dir (the one holding `projects/`). */
  claudeHome?: string;
  /** Claude Code's `~/.claude.json`. */
  claudeJsonPath?: string;
  codexExecutable: () => string | undefined;
  claudeExecutable: () => string | undefined;
  /** The user's Antigravity CLI (`agy`); absent = not on this Mac. */
  agyExecutable?: () => string | undefined;
  /** The user's OpenCode (`opencode`); absent = not on this Mac. */
  opencodeExecutable?: () => string | undefined;
  /** Winter's own codex-oauth `rate_limit_event` windows (status only) — the Codex plan's last rung. */
  winterCodexWindows: () => PlanStatusWindow[];
  /** The directory each probe's own fresh, empty cwd is made in (`<home>/usage`): a probe runs where no project config
   *  loads, and exactly its own directory is removed after it. */
  probeRoot: () => string;
  version?: string;
  now?: () => number;
  log?: { warn?: (msg: string, meta?: Record<string, unknown>) => void; info?: (msg: string, meta?: Record<string, unknown>) => void };
  /** Throttles (ms) — tests shorten them. */
  ingestEveryMs?: number;
  codexAppServerEveryMs?: number;
  claudeCliEveryMs?: number;
  appServerTimeoutMs?: number;
  claudeCliTimeoutMs?: number;
  agyCliEveryMs?: number;
  /** After a timed-out agy run (default 6 h). */
  agyTimeoutBackoffMs?: number;
  agyCliTimeoutMs?: number;
  /** OpenCode's stats runs: at most one batch per `opencodeEveryMs` (default 10 min), at most `opencodeSpawnBudget`
   *  runs per pass (default 40; a backfill that needs more continues next pass), each killed at `opencodeTimeoutMs`. */
  opencodeEveryMs?: number;
  opencodeSpawnBudget?: number;
  opencodeTimeoutMs?: number;
  /** How long a plan read waits for a spawn still running before answering with what it has (default 2 s — a client's
   *  request times out at 5 s; the spawn finishes in the background and the next ask gets it). */
  planWaitMs?: number;
  /** How often the Codex rollout rung is re-read (default 60 s; tests shorten it). */
  fallbackEveryMs?: number;
  /** Bytes read per file per pass (default 64 MiB) and the longest line parsed (default 16 MiB); tests shorten both. */
  fileBudgetBytes?: number;
  maxLineBytes?: number;
  /** `~/.claude.json` over this is not read (default 32 MiB). */
  claudeJsonMaxBytes?: number;
  /** Claude Code's `stats-cache.json` over this is not read (default 8 MiB). */
  claudeStatsMaxBytes?: number;
  /** The fired alarms waiting for an acknowledgement changed — one fired, or one was acknowledged (the island's
   *  notifications, `IslandActivity.usageAlarmsChanged`, which reads them back from `firedAlarms`). */
  onAlarmNotices?: () => void;
  /** The background plan checks (`startBackground`): every installed and tracked plan every `backgroundEveryMs`
   *  (default 30 min), and a plan with an alarm on its own beat (`alarmBeatMs`; default its throttle — Codex 60 s, Claude
   *  Code and Antigravity 5 min). Tests shorten them. */
  backgroundEveryMs?: number;
  alarmBeatMs?: Partial<Record<AlarmProvider, number>>;
  /** Test seam: a repeating timer; returns its cancel. */
  setInterval?: (fn: () => void, ms: number) => () => void;
}

/** The plans in their slots' order (what the background beat reads). */
export const PLAN_PROVIDERS: readonly AlarmProvider[] = ["codex", "claude-code", "antigravity"];
/** The background beat's period (user 2026-10-18: every installed and tracked plan, alarm or not). */
export const USAGE_BACKGROUND_EVERY_MS = 30 * 60_000;
/** A fast beat's spawn floor sits this far under its period. */
export const FAST_BEAT_SLACK_MS = 5_000;

/** PURE: a fast beat's spawn floor — the period less `FAST_BEAT_SLACK_MS`, never under half the period. */
export function fastBeatFloor(periodMs: number): number {
  return Math.max(periodMs / 2, periodMs - FAST_BEAT_SLACK_MS);
}

const defaultInterval = (fn: () => void, ms: number): (() => void) => {
  const t = setInterval(fn, ms);
  (t as { unref?: () => void }).unref?.();
  return () => clearInterval(t);
};

/** A binary's identity for a probe latch: its realpath, mtime and size (an update is a new binary). */
export function binaryKey(tool: string, exe: string): string | undefined {
  try {
    const real = realpathSync(exe);
    const st = statSync(real);
    // The path is hashed: in plaintext it names the user's home (their username).
    return `${tool}:${createHash("sha256").update(real).digest("hex").slice(0, 32)}:${Math.round(st.mtimeMs)}:${st.size}`;
  } catch { return undefined; }
}

/** Remove a probe's own directory — only a real (non-link) directory whose realpath is inside `root`'s. */
export function removeProbeDir(root: string, dir: string): boolean {
  try {
    const st = lstatSync(dir);
    if (!st.isDirectory() || st.isSymbolicLink()) return false;
    const realRoot = realpathSync(root);
    const real = realpathSync(dir);
    if (!real.startsWith(realRoot + sep) || real === realRoot) return false;
    try { rmdirSync(dir); return true; } catch { /* not empty: the probe left something behind */ }
    rmSync(dir, { recursive: true, force: true });
    return true;
  } catch { return false; }
}

/** A stored synthetic row against a planned one: any token count, the cost or its basis changed. */
function differs(s: SyntheticRow, r: UsageRecordInput): boolean {
  const cost = r.costBasis === "unknown" || r.costUsd === undefined ? null : r.costUsd;
  return s.input !== r.input || s.output !== r.output || s.cacheRead !== r.cacheRead || s.cacheWrite !== r.cacheWrite || s.costBasis !== r.costBasis
    || (cost === null) !== (s.costUsd === null) || (cost !== null && s.costUsd !== null && Math.abs(cost - s.costUsd) > 1e-9)
    || Math.abs((s.cacheSavingsUsd ?? 0) - (r.cacheSavingsUsd ?? 0)) > 1e-9;
}

/** Where Claude Code's `/stats` history keeps its own state in `ingest_files` (`sourceState`): when Winter first and last
 *  read the transcripts in full, the spans between reads too far apart, and the per-day estimates. */
export const CLAUDE_STATS_STATE_KEY = "claude-code:stats-history";
/** A complete read's time is written at most this often (a gap is measured in weeks). */
const PASS_NOTE_EVERY_MS = 6 * 3_600_000;

export interface ClaudeStatsHistory {
  firstPassAt?: number;
  lastPassAt?: number;
  gaps: Array<[string, string]>;
  estimates: Map<string, StatsEstimate>;
  /** The estimates were made at least once: until then the rows already stored are left alone. */
  planned: boolean;
}

const finiteNum = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** PURE: the stored state, validated — anything malformed is dropped, never trusted. */
export function parseStatsHistory(state: Record<string, unknown> | undefined): ClaudeStatsHistory {
  const firstPassAt = finiteNum(state?.firstPassAt);
  const lastPassAt = finiteNum(state?.lastPassAt);
  const gaps: Array<[string, string]> = [];
  if (Array.isArray(state?.gaps)) {
    for (const g of state.gaps) {
      if (!Array.isArray(g)) continue;
      const a = statsDate(g[0]);
      const b = statsDate(g[1]);
      if (a !== undefined && b !== undefined && a <= b) gaps.push([a, b]);
    }
  }
  const estimates = new Map<string, StatsEstimate>();
  const stored = state?.estimates;
  if (typeof stored === "object" && stored !== null && !Array.isArray(stored)) {
    for (const [key, v] of Object.entries(stored)) {
      if (statsDate(key.slice(0, 10)) === undefined || key[10] !== ":" || key.length < 12 || typeof v !== "object" || v === null) continue;
      const e = v as Record<string, unknown>;
      const raw = finiteNum(e.raw);
      const cal = finiteNum(e.cal);
      const days = finiteNum(e.days);
      if (raw === undefined || raw < 0 || cal === undefined || cal < 0 || cal > 1 || days === undefined || days < 0) continue;
      const split = Array.isArray(e.split) && e.split.length === 4 && e.split.every((x) => finiteNum(x) !== undefined && (x as number) >= 0)
        ? e.split as [number, number, number, number] : undefined;
      const usdPerToken = finiteNum(e.usdPerToken);
      estimates.set(key, { raw, cal, days, ...(split === undefined ? {} : { split }), ...(usdPerToken !== undefined && usdPerToken > 0 ? { usdPerToken } : {}) });
    }
  }
  return {
    ...(firstPassAt === undefined ? {} : { firstPassAt }), ...(lastPassAt === undefined ? {} : { lastPassAt }),
    gaps, estimates, planned: state?.planned === true,
  };
}

/** PURE: `gaps` with the span [a, b] added, overlapping or touching spans merged; undefined when it adds nothing. */
export function addGap(gaps: ReadonlyArray<readonly [string, string]>, a: string, b: string): Array<[string, string]> | undefined {
  if (gaps.some(([x, y]) => x <= a && b <= y)) return undefined;
  const next = (d: string): string => utcDay(Date.parse(`${d}T00:00:00Z`) + 86_400_000);
  const out: Array<[string, string]> = [];
  for (const [x, y] of [...gaps.map(([x, y]) => [x, y] as [string, string]), [a, b] as [string, string]].sort(([x], [y]) => x.localeCompare(y))) {
    const last = out[out.length - 1];
    if (last !== undefined && x <= next(last[1])) { if (y > last[1]) last[1] = y; } else out.push([x, y]);
  }
  return out;
}

/** Where each plan's last good reading from its own probe is kept (`sourceState`, filed under "winter" so no Claude Code
 *  or Codex file query ever counts it): shown, its staleness judged afresh, until a fresh read lands (user 2026-10-19:
 *  "show the cached usage limits until the fresh re-fetch arrives") — through a failed probe and across a restart. */
export const PLAN_READINGS_KEY = "plans:last-readings";
/** The rungs whose reading is kept: each plan's own probe (a fallback rung is re-read on its own). */
const KEPT_SOURCES: Record<PlanReading["provider"], PlanReading["source"]> = {
  codex: "codex-app-server", "claude-code": "claude-cli", antigravity: "agy-cli",
};
const WINDOW_KINDS = new Set(["five_hour", "weekly", "weekly_scoped", "other"]);

/** PURE: the kept readings, validated — anything malformed is dropped, never trusted (a stored `stale` or `windowKey` is
 *  ignored: both are judged afresh on every answer). */
export function parseKeptReadings(state: Record<string, unknown> | undefined): Map<PlanReading["provider"], PlanReading> {
  const out = new Map<PlanReading["provider"], PlanReading>();
  const str = (v: unknown, max = 200): string | undefined => (typeof v === "string" && v.length > 0 && v.length <= max ? v : undefined);
  for (const provider of Object.keys(KEPT_SOURCES) as Array<PlanReading["provider"]>) {
    const r = state?.[provider];
    if (typeof r !== "object" || r === null || Array.isArray(r)) continue;
    const o = r as Record<string, unknown>;
    const at = finiteNum(o.at);
    if (o.provider !== provider || o.source !== KEPT_SOURCES[provider] || at === undefined || !Array.isArray(o.windows)) continue;
    const windows: PlanWindow[] = [];
    for (const w of o.windows) {
      if (typeof w !== "object" || w === null) continue;
      const x = w as Record<string, unknown>;
      const id = str(x.id, 120);
      const used = finiteNum(x.usedPercent);
      if (id === undefined || typeof x.kind !== "string" || !WINDOW_KINDS.has(x.kind) || used === undefined || used < 0 || used > 100) continue;
      const windowMinutes = finiteNum(x.windowMinutes);
      const resetsAt = finiteNum(x.resetsAt);
      const scope = str(x.scope, 120);
      const severity = str(x.severity, 40);
      windows.push({
        id, kind: x.kind as PlanWindow["kind"], usedPercent: used, stale: false,
        ...(windowMinutes === undefined ? {} : { windowMinutes }), ...(resetsAt === undefined ? {} : { resetsAt }),
        ...(scope === undefined ? {} : { scope }), ...(severity === undefined ? {} : { severity }),
      });
    }
    if (windows.length === 0) continue;
    const planType = str(o.planType, 40);
    const limitReached = str(o.limitReached, 200);
    const c = o.credits;
    const credits = typeof c === "object" && c !== null && !Array.isArray(c) ? (() => {
      const k = c as Record<string, unknown>;
      const balance = str(k.balance, 40);
      return {
        ...(typeof k.hasCredits === "boolean" ? { hasCredits: k.hasCredits } : {}), ...(typeof k.unlimited === "boolean" ? { unlimited: k.unlimited } : {}),
        ...(balance === undefined ? {} : { balance }),
      };
    })() : undefined;
    out.set(provider, {
      provider, source: KEPT_SOURCES[provider], at, windows,
      ...(planType === undefined ? {} : { planType }), ...(limitReached === undefined ? {} : { limitReached }),
      ...(credits === undefined ? {} : { credits }),
    });
  }
  return out;
}

/** PURE: the newer of two readings by when they were measured (one with no time loses). */
export function newerReading(a: PlanReading | undefined, b: PlanReading | undefined): PlanReading | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return (b.at ?? -Infinity) > (a.at ?? -Infinity) ? b : a;
}

/** Wait for `p`, at most `ms`. */
async function within(p: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([p, new Promise<void>((r) => { timer = setTimeout(r, ms); timer.unref?.(); })]);
  if (timer !== undefined) clearTimeout(timer);
}

export interface WinterTurnRow {
  model: string;
  canonicalModel?: string;
  provider?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd?: number;
  costBasis?: "list";
}

export interface UsageTotals {
  costUsd: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  unpricedTokens: number;
  cacheSavingsUsd: number;
  records: number;
  /** Of `records`, how many are Claude Code `/stats` estimates (no transcript left for that day). */
  syntheticRecords: number;
}

/** Where the Claude Code history came from: days before `before` (UTC noon of that day, epoch ms) are Claude Code's
 *  own `/stats` totals; `from` is the first such day. */
export interface UsageHistory { claudeCodeStats?: { from: number; before: number } }

export interface UsageModelRow extends UsageTotals {
  source: UsageSource;
  provider: string;
  model: string;
  /** `list` (the runtime's own price), `estimate` (Winter's list-price estimate), `reported` (the other app's own
   *  figure — OpenCode), `mixed`, or `unknown`. */
  costBasis: "list" | "estimate" | "reported" | "mixed" | "unknown";
}

export interface UsageBucket { start: number; costUsd: number; tokens: number; bySource: Partial<Record<UsageSource, number>>; models: Array<{ source: UsageSource; model: string; costUsd: number; tokens: number }> }

const EMPTY = (): UsageTotals => ({ costUsd: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, unpricedTokens: 0, cacheSavingsUsd: 0, records: 0, syntheticRecords: 0 });

function add(t: UsageTotals, r: UsageRow): void {
  t.costUsd += r.costUsd; t.input += r.input; t.output += r.output; t.cacheRead += r.cacheRead; t.cacheWrite += r.cacheWrite;
  t.reasoning += r.reasoning; t.unpricedTokens += r.unpricedTokens; t.cacheSavingsUsd += r.cacheSavingsUsd; t.records += r.records;
  t.syntheticRecords += r.syntheticRecords;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function localMidnight(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** PURE: a range's window and bucket size. `earliest` is the oldest hour on record (for `all`). */
export function rangeWindow(range: UsageRange, nowMs: number, earliest?: number): { from: number; to: number; bucketMs: number; fromRecords: boolean } {
  // `to` is exclusive in the queries: one past now, so a record stamped this very millisecond counts.
  const now = nowMs + 1;
  switch (range) {
    case "1h": return { from: now - HOUR, to: now, bucketMs: 5 * 60_000, fromRecords: true };
    case "24h": return { from: now - DAY, to: now, bucketMs: HOUR, fromRecords: true };
    case "7d": { const from = Math.floor((now - 7 * DAY) / HOUR) * HOUR; return { from, to: now, bucketMs: 6 * HOUR, fromRecords: false }; }
    case "30d": return { from: localMidnight(now - 29 * DAY), to: now, bucketMs: DAY, fromRecords: false };
    case "all": {
      const from = localMidnight(Math.min(earliest ?? now, now - 29 * DAY));
      const days = Math.ceil((now - from) / DAY);
      return { from, to: now, bucketMs: Math.max(1, Math.ceil(days / 60)) * DAY, fromRecords: false };
    }
  }
}

/** PURE: the next renewal, the current cycle's start and the monthly cost of a plan. */
export function subscriptionCycle(s: Pick<Subscription, "cadence" | "renewalDay" | "renewalMonth" | "price">, now: number): { nextRenewal: number; cycleStart: number; monthlyCost: number } {
  const at = (y: number, m: number): number => {
    const dim = new Date(y, m + 1, 0).getDate();
    return new Date(y, m, Math.min(Math.max(1, s.renewalDay), dim)).getTime();
  };
  const today = new Date(localMidnight(now));
  if (s.cadence === "yearly") {
    const month = Math.min(12, Math.max(1, s.renewalMonth ?? 1)) - 1;
    let next = at(today.getFullYear(), month);
    if (next <= today.getTime()) next = at(today.getFullYear() + 1, month);
    const prev = at(new Date(next).getFullYear() - 1, month);
    return { nextRenewal: next, cycleStart: prev, monthlyCost: s.price / 12 };
  }
  let y = today.getFullYear();
  let m = today.getMonth();
  let next = at(y, m);
  if (next <= today.getTime()) { m += 1; if (m > 11) { m = 0; y += 1; } next = at(y, m); }
  let py = y;
  let pm = m - 1;
  if (pm < 0) { pm = 11; py -= 1; }
  return { nextRenewal: next, cycleStart: at(py, pm), monthlyCost: s.price };
}

export class UsageService {
  private readonly now: () => number;
  private ingestRun: Promise<void> | undefined;
  private lastIngestAt = 0;
  private ingestMore = false;
  private lastTracking: UsageTracking | undefined;
  private codexCache: { at: number; reading?: PlanReading; failure?: string } | undefined;
  /** Each plan's last good probe reading (`PLAN_READINGS_KEY`), loaded once. */
  private keptReadings: Map<PlanReading["provider"], PlanReading> | undefined;
  private codexRun: Promise<void> | undefined;
  private claudeCache: { at: number; reading?: PlanReading; failure?: string } | undefined;
  private claudeRun: Promise<void> | undefined;
  private agyCache: { at: number; reading?: PlanReading; failure?: string } | undefined;
  private agyRun: Promise<void> | undefined;
  /** OpenCode's last stats batch (its throttle), and whether its backfill ran out of budget (then the throttle waits). */
  private opencodeAt = 0;
  private opencodeMore = false;
  /** Claude Code's plan name (`auth status`'s `subscriptionType`), per binary, re-asked hourly. */
  private claudePlanName: { at: number; key: string; value?: string } | undefined;
  /** Set when `/usage` came back as something other than the local command: this rung is off until restart. */
  /** The passive rungs' last readings (rollout tails, `~/.claude.json`), re-read at most every `fallbackEveryMs`. */
  private rolloutCache: { at: number; reading?: PlanReading } | undefined;
  private claudeFileCache: { stamp: string; reading?: PlanReading; multiple?: string } | undefined;
  /** Test seam: how many times `~/.claude.json` was parsed. */
  claudeFileParses = 0;
  private claudeFileOverCapLogged = false;
  /** Claude Code's `stats-cache.json`, parsed only when its mtime or size changed. */
  private statsFile: { stamp: string; stats?: ClaudeStats } | undefined;
  /** The last estimate refresh's inputs (file stamp, coverage): unchanged → nothing to do. */
  private statsSignature: string | undefined;
  /** The last row plan's inputs (the estimates, coverage, transcript totals on partial days): unchanged → nothing to do. */
  private statsRowsSignature: string | undefined;
  /** Claude Code's `/stats` history state (`CLAUDE_STATS_STATE_KEY`), loaded once. */
  private statsHistoryState: ClaudeStatsHistory | undefined;
  private statsLogged = new Set<string>();
  /** Test seam: how many times `stats-cache.json` was parsed. */
  claudeStatsParses = 0;
  /** The background beat (`startBackground`): the slow one's cancel, and each alarmed plan's fast one. */
  private cancelSlowBeat: (() => void) | undefined;
  private readonly fastBeats = new Map<AlarmProvider, () => void>();

  constructor(private readonly deps: UsageServiceDeps) {
    this.now = deps.now ?? Date.now;
  }

  // ── Winter's own turns ─────────────────────────────────────────────────────────────────────────

  /** A projected turn's per-model rows (`onTurnUsage`). A runtime-priced row keeps its price (`list`); an unpriced
   *  one (a subscription row) gets Winter's list-price estimate at its API twin, or none. */
  recordWinterTurn(sessionId: string, mode: string | undefined, sourceId: string, rows: readonly WinterTurnRow[]): void {
    const at = this.now();
    const records: UsageRecordInput[] = rows.map((r) => {
      const slash = r.model.indexOf("/");
      const provider = r.provider !== undefined && slash < 0 ? r.provider : slash > 0 ? r.model.slice(0, slash) : r.provider;
      const usage = { input: r.inputTokens, output: r.outputTokens, cacheRead: r.cacheReadTokens, cacheWrite: r.cacheWriteTokens };
      const base = {
        dedupe: `winter:${sessionId}:${sourceId}:${r.model}`, source: "winter" as const, at, sessionId,
        ...(mode === undefined ? {} : { mode }), ...(provider === undefined ? {} : { provider }), model: r.model,
        input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite,
      };
      if (r.costBasis === "list" && r.costUsd !== undefined) {
        return { ...base, costUsd: r.costUsd, costBasis: "list" as const, cacheSavingsUsd: this.deps.pricer.savingsFor(provider, r.canonicalModel ?? r.model, usage.cacheRead) };
      }
      const est = this.deps.pricer.price(provider, r.canonicalModel ?? r.model, usage);
      return est === undefined ? { ...base, costBasis: "unknown" as const } : { ...base, costUsd: est.costUsd, costBasis: "estimate" as const, cacheSavingsUsd: est.cacheSavingsUsd };
    });
    try { this.deps.db.insert(records); } catch (err) { this.deps.log?.warn?.("[usage] could not record a turn", { error: String(err) }); }
  }

  // ── the external ingest (on demand) ────────────────────────────────────────────────────────────

  /** Start (or join) an ingest pass unless one ran within the throttle; resolves when the pass is done. */
  ingest(force = false): Promise<void> {
    if (this.ingestRun !== undefined) return this.ingestRun;
    const every = this.deps.ingestEveryMs ?? 20_000;
    // A tracking switch flipped since the last pass is news: never held back by the throttle.
    const tracking = this.deps.tracking();
    const switched = this.lastTracking === undefined || JSON.stringify(this.lastTracking) !== JSON.stringify(tracking);
    if (!force && !switched && !this.ingestMore && this.now() - this.lastIngestAt < every) return Promise.resolve();
    this.lastTracking = tracking;
    this.ingestRun = this.ingestPass().finally(() => { this.ingestRun = undefined; this.lastIngestAt = this.now(); });
    return this.ingestRun;
  }

  /**
   * The background catch-up (user 2026-10-18: keep Claude Code's usage past its own 30-day transcript cleanup). Rows are
   * never deleted here, but they exist only once ingested — so a few minutes after boot and every few hours, ingest
   * EVERYTHING new (a chunked first import runs to its end), whether or not a Usage screen is open. Each switch still
   * applies: a source turned off is not read. Bounded: at most `maxPasses` passes per catch-up.
   */
  async catchUp(maxPasses = 200): Promise<void> {
    for (let i = 0; i < maxPasses; i++) {
      await this.ingest(true);
      if (!this.ingestMore) return;
    }
  }

  ingestState(): { running: boolean; lastAt?: number } {
    return { running: this.ingestRun !== undefined, ...(this.lastIngestAt > 0 ? { lastAt: this.lastIngestAt } : {}) };
  }

  private async ingestPass(): Promise<void> {
    const tracking = this.deps.tracking();
    let more = false;
    try {
      if (tracking.codex && this.deps.codexHome !== undefined) {
        const files = await codexRollouts(this.deps.codexHome);
        more = (await this.ingestFiles("codex", files, (line, state, file) =>
          codexRecordOf(line, state, fileKey("codex", file.path).slice(6, 22), this.deps.pricer, file.mtimeMs))) || more;
      }
      if (tracking.claudeCode && this.deps.claudeHome !== undefined) {
        const passAt = this.now();
        const files = await claudeCodeTranscripts(this.deps.claudeHome);
        const ccMore = await this.ingestFiles("claude-code", files, (line, _state, file) => claudeCodeRecordOf(line, this.deps.pricer, file.mtimeMs));
        more = ccMore || more;
        this.noteClaudePass(passAt, !ccMore);
        // Transcripts win, EVERY pass (a chunked import, a missing or corrupt stats file included): the rows are re-planned
        // against the transcript totals as they are. New estimates only once the transcripts are all in.
        await this.importClaudeStats(this.deps.claudeHome, !ccMore);
      }
      const opencode = this.deps.opencodeExecutable?.();
      if (tracking.opencode && opencode !== undefined) more = (await this.ingestOpencode(opencode)) || more;
    } catch (err) {
      this.deps.log?.warn?.("[usage] ingest failed", { error: err instanceof Error ? err.name : "error" });
    }
    this.ingestMore = more;
  }

  private statsLog(key: string, msg: string): void {
    if (this.statsLogged.has(key)) return;
    this.statsLogged.add(key);
    this.deps.log?.warn?.(msg);
  }

  private statsState(): ClaudeStatsHistory {
    this.statsHistoryState ??= parseStatsHistory(this.deps.db.sourceState(CLAUDE_STATS_STATE_KEY));
    return this.statsHistoryState;
  }

  private saveStatsState(h: ClaudeStatsHistory): void {
    this.deps.db.setSourceState(CLAUDE_STATS_STATE_KEY, "claude-code", {
      ...(h.firstPassAt === undefined ? {} : { firstPassAt: h.firstPassAt }), ...(h.lastPassAt === undefined ? {} : { lastPassAt: h.lastPassAt }),
      gaps: h.gaps, estimates: Object.fromEntries(h.estimates), planned: h.planned,
    }, this.now());
  }

  /**
   * Claude Code's transcripts were just read (`complete`: all of them, no chunk left). Note when Winter FIRST read them —
   * on a DB from before this note, the oldest file read-state (a file read once and never grown since keeps the time of
   * its first read) — and, when no complete read happened for longer than Claude Code's retention (the daemon not
   * running, the tracking switch off), the days that may have been emptied in between.
   */
  private noteClaudePass(passAt: number, complete: boolean): void {
    const h = this.statsState();
    let dirty = false;
    if (h.firstPassAt === undefined) {
      h.firstPassAt = Math.min(this.deps.db.firstFileReadAt("claude-code", CLAUDE_STATS_STATE_KEY) ?? passAt, passAt);
      dirty = true;
    }
    const lost = passAt - CLAUDE_TRANSCRIPT_RETENTION_DAYS * DAY;
    if (h.lastPassAt !== undefined && lost > h.lastPassAt) {
      const gaps = addGap(h.gaps, utcDay(h.lastPassAt), utcDay(lost));
      if (gaps !== undefined) { h.gaps = gaps; dirty = true; }
    }
    if (complete && (h.lastPassAt === undefined || passAt - h.lastPassAt >= PASS_NOTE_EVERY_MS)) { h.lastPassAt = passAt; dirty = true; }
    if (dirty) this.saveStatsState(h);
  }

  /** Which days Winter's Claude Code transcript rows may not hold in full (`StatsCoverage`). */
  private coverage(): StatsCoverage {
    const h = this.statsState();
    const earliest = this.deps.db.earliestReal("claude-code");
    return {
      ...(earliest === undefined ? {} : { firstTranscriptDay: utcDay(earliest) }),
      ...(h.firstPassAt === undefined ? {} : { partialThrough: utcDay(h.firstPassAt - CLAUDE_TRANSCRIPT_RETENTION_DAYS * DAY) }),
      gaps: h.gaps,
    };
  }

  /** Winter's transcript totals (all four kinds) per model on each partial day, keyed like the estimates. An index seek
   *  per span: partial days hold few transcript rows (most of theirs are gone). */
  private partialRealTotals(c: StatsCoverage): Map<string, number> {
    const spans: Array<[number, number]> = [];
    if (c.partialThrough !== undefined) spans.push([Number.MIN_SAFE_INTEGER, Date.parse(`${c.partialThrough}T00:00:00Z`) + DAY]);
    for (const [a, b] of c.gaps) spans.push([Date.parse(`${a}T00:00:00Z`), Date.parse(`${b}T00:00:00Z`) + DAY]);
    const out = new Map<string, number>();
    for (const [from, to] of spans) {
      for (const r of this.deps.db.dailyRealTotals("claude-code", from, to)) if (isPartialDay(c, r.day)) out.set(estimateKey(r.model, r.day), r.all);
    }
    return out;
  }

  /** Claude Code's `stats-cache.json`, parsed only when its mtime or size changed; undefined when there is none. */
  private async readClaudeStats(claudeHome: string): Promise<{ stamp: string; stats?: ClaudeStats } | undefined> {
    const path = join(claudeHome, CLAUDE_STATS_FILE);
    let st: { mtimeMs: number; size: number };
    try { st = statSync(path); } catch { return undefined; }
    const stamp = `${Math.floor(st.mtimeMs)}:${st.size}`;
    if (this.statsFile?.stamp !== stamp) {
      const cap = this.deps.claudeStatsMaxBytes ?? CLAUDE_STATS_MAX_BYTES;
      const text = st.size > cap ? "over-cap" : await readCapped(path, cap);
      let stats: ClaudeStats | undefined;
      if (text === "over-cap") this.statsLog("over-cap", "[usage] Claude Code's stats cache is over the size cap; its history is not read");
      else if (text !== undefined) {
        stats = parseClaudeStats(text);
        this.claudeStatsParses++;
        if (stats === undefined) this.statsLog("corrupt", "[usage] Claude Code's stats cache could not be read; its history is not imported");
      }
      this.statsFile = { stamp, ...(stats === undefined ? {} : { stats }) };
    }
    return this.statsFile;
  }

  /**
   * Backfill Claude Code's history from its own `/stats` cache (`usage/claude-stats.ts`) for the days its transcripts may
   * no longer hold in full — the PARTIAL days (`StatsCoverage`): before Winter first read them less Claude Code's
   * retention, before the first transcript day, and any span Winter was away longer than the retention.
   *  - After a COMPLETE transcript read, the cache refreshes the estimates (`refreshEstimates`) — parsed only when its
   *    mtime or size changed, re-estimated only when it or the coverage changed (never merely because a day passed).
   *    The estimates live in the usage DB: a day the cache stops listing or shrinks keeps its estimate.
   *  - EVERY pass the rows are re-planned (`statsRows`) when the estimates, the coverage or the transcript totals on
   *    partial days changed: each partial day gets what its surviving transcripts lack, a day transcripts now cover in
   *    full loses its row — written only where they differ. A missing, corrupt or over-cap file refreshes nothing;
   *    the rows still follow the transcripts.
   */
  private async importClaudeStats(claudeHome: string, complete: boolean): Promise<void> {
    const h = this.statsState();
    const coverage = this.coverage();
    const coverageKey = JSON.stringify(coverage);
    if (complete) {
      const read = await this.readClaudeStats(claudeHome);
      const signature = `${read?.stamp ?? ""}|${coverageKey}`;
      if (read?.stats !== undefined && signature !== this.statsSignature) {
        const now = this.now();
        const from = overlapFrom(now);
        const real = this.deps.db.dailyRealTotals("claude-code", Date.parse(`${from}T00:00:00Z`));
        const r = refreshEstimates(h.estimates, { stats: read.stats, coverage, today: utcDay(now), real, overlapFromDay: from });
        if (r.changed || !h.planned) {
          h.estimates = r.estimates;
          h.planned = true;
          this.saveStatsState(h);
          this.statsRowsSignature = undefined;
        }
        this.statsSignature = signature;
      }
    }
    if (!h.planned) return; // never estimated yet: the rows already stored stay as they are
    const real = this.partialRealTotals(coverage);
    const rowsSignature = `${coverageKey}|${[...real].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join(",")}`;
    if (rowsSignature === this.statsRowsSignature) return;
    const wanted = statsRows(h.estimates, coverage, real, this.deps.pricer);
    const stored = new Map(this.deps.db.syntheticRows("claude-code").map((r) => [r.dedupe, r]));
    const keep = new Set(wanted.map((r) => r.dedupe));
    const remove = [...stored.keys()].filter((d) => !keep.has(d));
    const upsert = wanted.filter((r) => { const s = stored.get(r.dedupe); return s === undefined || differs(s, r); });
    const { removed, added } = remove.length + upsert.length > 0 ? this.deps.db.reconcileSynthetic("claude-code", remove, upsert) : { removed: 0, added: 0 };
    this.statsRowsSignature = rowsSignature;
    if (removed + added > 0) this.deps.log?.info?.("[usage] Claude Code /stats history updated", { added, removed });
  }

  /** Where the Claude Code history came from (the Usage window's footnote): its first day, and the first day after the
   *  partial ones — the later of the first transcript day and the day after Winter's first read less the retention;
   *  with no transcripts at all, the day after the last imported day. */
  history(): UsageHistory {
    const span = this.deps.db.syntheticSpan("claude-code");
    if (span === undefined) return {};
    const c = this.coverage();
    let before: string;
    if (c.firstTranscriptDay === undefined) before = utcDay(span.last + DAY);
    else {
      const afterPartial = c.partialThrough === undefined ? c.firstTranscriptDay : utcDay(Date.parse(`${c.partialThrough}T00:00:00Z`) + DAY);
      before = afterPartial > c.firstTranscriptDay ? afterPartial : c.firstTranscriptDay;
    }
    return { claudeCodeStats: { from: span.first, before: utcNoon(before) } };
  }

  /**
   * OpenCode's usage, from its own `opencode stats` (`usage/opencode.ts`) — at most one batch per `opencodeEveryMs`
   * (10 min) unless its backfill ran out of budget. Each batch:
   *  - TODAY: `--days 1`, and again after every day's pair (below); today's row is the last one, REPLACING the day's rows.
   *  - every past day still to FINALIZE, newest first, as `--days k+1` − `--days k`, the two runs back to back (never one
   *    shared with another day): yesterday, the last day written as "today" (the daemon may have slept through midnights —
   *    then `--all` is asked once more for the active days in between), every day read but not finalized yet, and the
   *    one-time backfill — every active date `--all` lists, kept as a `pending` list until done (an interrupted backfill
   *    resumes).
   *  - A pair counts only when today did not move around it: the `--days 1` runs either side of it agree (for yesterday
   *    the pair's own narrow run is the one after). Else a message of today finished during the pair — it would sit in
   *    the wider run and not the narrower, in that day's row AND today's — and the day waits for the next batch; the
   *    other days are judged on their own.
   *  - A day is FINALIZED (written, `done`, never asked again; the last two weeks kept) only when two batches at least
   *    half a throttle apart read the same pair (`reads`: the day's last fingerprint and when) AND it ended at least
   *    `OPENCODE_SETTLE_AFTER_DAY_MS` (2 h) ago — a spanning message may go quiet for a long tool run first. OpenCode files a message
   *    under the day it STARTED: one begun at 23:58 and still running after midnight keeps growing yesterday's pair, which
   *    is never finalized short. Until then each read is written as the day's rows (provisional).
   * At most `opencodeSpawnBudget` runs per batch: out of budget = `more` (the next pass skips both throttles; a day read
   * moments ago is skipped, not re-read); a failed run ends the batch (an ordinary failure, retried after the throttle —
   * never `more`, so a broken binary never loops the catch-up). A local midnight crossed mid-batch discards it whole.
   * Every day is a calendar day in the zone resolved for this batch, which every run gets as `TZ`. Returns `more`.
   */
  private async ingestOpencode(exe: string): Promise<boolean> {
    const now = this.now();
    if (!this.opencodeMore && this.opencodeAt > 0 && now - this.opencodeAt < (this.deps.opencodeEveryMs ?? 600_000)) return false;
    this.opencodeAt = now;
    this.opencodeMore = false;
    const tz = currentTimeZone();
    const today = localDay(now, tz);
    const key = "opencode:progress";
    const saved = this.deps.db.sourceState(key) ?? {};
    const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
    const done = new Set(strings(saved.done));
    let pending = strings(saved.pending);
    let listed = saved.listed === true;
    const lastToday = typeof saved.lastToday === "string" ? saved.lastToday : undefined;
    // Each day read but not finalized yet: its pair's fingerprint, and when it was read.
    const reads = new Map<string, { fp: string; at: number }>();
    if (typeof saved.reads === "object" && saved.reads !== null && !Array.isArray(saved.reads)) {
      for (const [d, v] of Object.entries(saved.reads as Record<string, unknown>)) {
        const r = v as { fp?: unknown; at?: unknown } | null;
        if (r !== null && typeof r === "object" && typeof r.fp === "string" && typeof r.at === "number") reads.set(d, { fp: r.fp, at: r.at });
      }
    }
    const settleMs = (this.deps.opencodeEveryMs ?? 600_000) / 2;
    let budget = this.deps.opencodeSpawnBudget ?? 40;
    let allRun: OpencodeStats | undefined;
    const run = async (args: string[]): Promise<OpencodeStats | undefined> => {
      budget -= 1;
      const r = await this.inProbeDir((cwd) => runOpencodeStats(exe, args, {
        cwd, tz, ...(this.deps.opencodeTimeoutMs === undefined ? {} : { timeoutMs: this.deps.opencodeTimeoutMs }),
      })).catch(() => ({ failure: "spawn-failed" as const, stats: undefined }));
      if (r.stats === undefined) this.deps.log?.info?.("[usage] opencode stats gave no reading", { reason: r.failure ?? "no-json" });
      return r.stats;
    };
    const all = async (): Promise<OpencodeStats | undefined> => (allRun ??= await run([...OPENCODE_ALL_ARGS]));
    const days = (k: number): Promise<OpencodeStats | undefined> => run(opencodeDaysArgs(k));
    // Today's latest run: every pair is judged against the one before it and the one after it.
    let current = await days(1);
    if (current === undefined) return false;
    let failed = false;
    if (!listed) {
      const a = await all();
      if (a === undefined) failed = true;
      else { pending = a.activity.filter((d) => d < today && !done.has(d)); listed = true; }
    }
    const due = new Set(pending);
    const yesterday = dayMinus(today, 1);
    due.add(yesterday);
    if (lastToday !== undefined) due.add(lastToday);
    for (const d of reads.keys()) due.add(d);
    // Asleep for days (no batch since before yesterday): the active days in between are asked for once, via `--all`.
    if (!failed && lastToday !== undefined && lastToday < yesterday) {
      const a = await all();
      if (a === undefined) failed = true;
      for (const d of a?.activity ?? []) if (d > lastToday && d < today && !done.has(d)) due.add(d);
    }
    const writes: Array<{ day: string; rows: UsageRecordInput[] }> = [];
    let moved = false;
    for (const day of [...due].filter((d) => d < today && !done.has(d)).sort().reverse()) {
      if (failed) break;
      const prior = reads.get(day);
      // Read moments ago (a catch-up pass): its next read must be a batch apart, so it waits — not counted as `more`.
      if (prior !== undefined && now - prior.at < settleMs) continue;
      const k = daysBefore(day, today);
      // The pair, and today's run after it (yesterday's narrow run is that run).
      if (budget < (k === 1 ? 2 : 3)) { this.opencodeMore = true; break; }
      const before = current;
      const wide = await days(k + 1);
      const narrow = wide === undefined ? undefined : await days(k);
      const after = narrow === undefined ? undefined : k === 1 ? narrow : await days(1);
      if (wide === undefined || narrow === undefined || after === undefined) { failed = true; break; }
      current = after;
      if (!sameOpencodeStats(before, after)) { moved = true; continue; }
      const diff = opencodeDifference(wide, narrow);
      const fp = opencodeFingerprint(diff);
      writes.push({ day, rows: opencodeDayRecords(diff, day, localNoon(day, tz), this.deps.pricer) });
      // Final only when it read the same twice AND the day ended two hours ago or more (a message begun before midnight
      // can sit quiet through a long tool run, then add tokens to the day it started).
      const settled = now >= localDayEnd(day, tz) + OPENCODE_SETTLE_AFTER_DAY_MS;
      if (prior !== undefined && prior.fp === fp) {
        if (settled) { done.add(day); reads.delete(day); }
      } else reads.set(day, { fp, at: now });
    }
    // Every `--days` run counts from the local midnight of its moment: across a midnight the differences are wrong. (Only
    // then is the throttle reset: a failed run keeps it.)
    if (localDay(this.now(), tz) !== today) { this.opencodeAt = 0; this.opencodeMore = false; return false; }
    this.replaceOpencodeDay(today, opencodeDayRecords(current, today, Math.min(localNoon(today, tz), this.now()), this.deps.pricer), tz);
    for (const w of writes) this.replaceOpencodeDay(w.day, w.rows, tz);
    // Today moved around a day's pair: that day's difference may hold some of today's tokens. Read again next batch.
    if (moved) this.deps.log?.info?.("[usage] opencode was in use during the read; some finished days are read again next time");
    if (failed) this.opencodeMore = false;
    const keepFrom = dayMinus(today, 14);
    this.deps.db.setSourceState(key, "opencode", {
      done: [...done].filter((d) => d >= keepFrom).sort(), pending: pending.filter((d) => !done.has(d)), listed,
      reads: Object.fromEntries([...reads].filter(([d]) => !done.has(d))),
      // A day not finalized yet stays "the last today" until it is — so it is asked for again.
      lastToday: lastToday !== undefined && lastToday < today && !done.has(lastToday) ? lastToday : today,
    }, this.now());
    return this.opencodeMore;
  }

  /** Replace one local day of OpenCode rows — written only when something differs (a re-read of an unchanged day writes nothing). */
  private replaceOpencodeDay(day: string, rows: readonly UsageRecordInput[], tz: string): void {
    const from = localDayStart(day, tz);
    const to = localDayEnd(day, tz);
    const stored = new Map(this.deps.db.storedRows("opencode", false, from, to).map((r) => [r.dedupe, r]));
    if (stored.size === rows.length && rows.every((r) => { const s = stored.get(r.dedupe); return s !== undefined && !differs(s, r); })) return;
    this.deps.db.replaceDay("opencode", from, to, rows);
  }

  /** Read every file's new bytes. Returns true when a budget left bytes for the next pass. */
  private async ingestFiles(
    source: UsageSource, files: readonly FoundFile[],
    recordOf: (line: string, state: Record<string, unknown>, file: FoundFile) => UsageRecordInput | undefined,
  ): Promise<boolean> {
    let more = false;
    let budget = 256 * 1024 * 1024;
    for (const file of files) {
      const key = fileKey(source, file.path);
      const prev = this.deps.db.fileState(key);
      if (prev !== undefined && prev.inode === file.inode && prev.offset === file.size) continue;
      if (budget <= 0) { more = true; break; }
      const reset = prev !== undefined && (prev.inode !== file.inode || file.size < prev.offset);
      const state = source === "codex" ? (codexStateOf(reset || prev === undefined ? {} : prev.state) as Record<string, unknown>) : {};
      const records: UsageRecordInput[] = [];
      const skipping = !reset && prev?.state.__skipping === true;
      const read = await readNewLines(file, prev === undefined ? undefined : { inode: prev.inode, offset: prev.offset, skipping }, (line) => {
        const r = recordOf(line, state, file);
        if (r !== undefined) records.push(r);
      }, { budget: this.deps.fileBudgetBytes ?? 64 * 1024 * 1024, ...(this.deps.maxLineBytes === undefined ? {} : { maxLine: this.deps.maxLineBytes }) }); // a whole budget per file: a long line always progresses
      budget -= read.offset - (reset || prev === undefined ? 0 : prev.offset);
      if (read.more) more = true;
      const saved = read.skipping ? { ...state, __skipping: true } : (({ __skipping: _, ...rest }) => rest)(state as Record<string, unknown>);
      this.deps.db.commitFile({ key, source, inode: file.inode, offset: read.offset, state: saved }, records, this.now());
      // Yield between files: a first import of a large history never holds the event loop for long.
      await new Promise<void>((r) => setImmediate(r));
    }
    return more;
  }

  // ── plans ───────────────────────────────────────────────────────────────────────────────────────

  /** A plan's last good probe reading — kept through a failed probe and across a restart; undefined before the first. */
  private kept(provider: PlanReading["provider"]): PlanReading | undefined {
    this.keptReadings ??= parseKeptReadings(this.deps.db.sourceState(PLAN_READINGS_KEY));
    return this.keptReadings.get(provider);
  }

  /** A probe gave a reading: keep it (memory and usage.db — a failed write keeps it in memory). */
  private keep(reading: PlanReading): void {
    if (reading.source !== KEPT_SOURCES[reading.provider] || reading.at === undefined) return;
    this.kept(reading.provider);
    this.keptReadings!.set(reading.provider, reading);
    try {
      this.deps.db.setSourceState(PLAN_READINGS_KEY, "winter", Object.fromEntries(this.keptReadings!), this.now());
    } catch { /* kept in memory; the next reading tries again */ }
  }

  /** A reading as of now: each window's staleness judged afresh from when it was measured. */
  private judged(r: PlanReading): PlanReading {
    return { ...r, windows: r.windows.map((w) => ({ ...w, ...staleness(r.at, w.windowMinutes, w.resetsAt, this.now()) })) };
  }

  /** The Codex plan: Codex's app-server → the newest rollout's `rate_limits` → Winter's own codex-oauth report. Every
   *  answer judges the plan's alarms. `minAgeMs`: a fast beat's own floor for a fresh spawn (below the throttle). */
  async codexPlan(minAgeMs?: number): Promise<PlanReading> {
    return this.answered(await this.readCodexPlan(minAgeMs));
  }

  private async readCodexPlan(minAgeMs?: number): Promise<PlanReading> {
    if (!this.deps.tracking().codex) return { provider: "codex", source: "disabled", windows: [] };
    // Not on this Mac: no slot at all (user 2026-10-18), whatever an old rollout or Winter's own sign-in could say.
    if (this.deps.codexExecutable() === undefined) return { provider: "codex", source: "not-installed", windows: [] };
    const now = this.now();
    const every = minAgeMs ?? this.deps.codexAppServerEveryMs ?? 60_000;
    if (this.codexRun !== undefined) {
      await within(this.codexRun, this.deps.planWaitMs ?? 2_000);
    } else if (this.codexCache === undefined || now - this.codexCache.at >= every) {
      this.codexRun ??= (async () => {
        const exe = this.deps.codexExecutable();
        if (exe === undefined) { this.codexCache = { at: this.now(), failure: "not-installed" }; return; }
        const r = await this.inProbeDir((cwd) => codexPlanFromAppServer(exe, {
          now: this.now, cwd, ...(this.deps.version === undefined ? {} : { version: this.deps.version }),
          ...(this.deps.appServerTimeoutMs === undefined ? {} : { timeoutMs: this.deps.appServerTimeoutMs }),
        })).catch(() => ({ failure: "spawn-failed" as string, reading: undefined }));
        this.codexCache = { at: this.now(), ...r };
        if (r.reading !== undefined) this.keep(r.reading);
        // Judged as it lands: a read that stopped waiting (`planWaitMs` — a background beat's) answered the cache before.
        this.judgeAlarms(r.reading);
        if (r.failure !== undefined) this.deps.log?.info?.("[usage] codex app-server gave no plan reading", { reason: r.failure });
      })().finally(() => { this.codexRun = undefined; });
      await within(this.codexRun, this.deps.planWaitMs ?? 2_000);
    }
    // The latest probe's own reading; else the last good one (a failed probe, a restart) against the passive rung — the
    // newer of the two.
    if (this.codexCache?.reading !== undefined) return this.judged(this.codexCache.reading);
    const kept = this.kept("codex");
    let fromRollout: PlanReading | undefined;
    if (this.deps.codexHome !== undefined) {
      // The passive rung, cached like the spawn (a tree walk + tail reads every 5 s would not be cheap).
      if (this.rolloutCache === undefined || this.now() - this.rolloutCache.at >= (this.deps.fallbackEveryMs ?? 60_000)) {
        this.rolloutCache = { at: this.now(), reading: await codexPlanFromRollouts(await codexRollouts(this.deps.codexHome), this.now()) };
      }
      fromRollout = this.rolloutCache.reading;
    }
    const best = newerReading(kept, fromRollout);
    if (best !== undefined) return this.judged(best);
    const winter = this.deps.winterCodexWindows();
    if (winter.length > 0) return { provider: "codex", source: "winter-codex-oauth", windows: [], statusOnly: winter, at: Math.max(...winter.map((w) => w.at)) };
    return { provider: "codex", source: "none", windows: [] };
  }

  /** The Claude Code plan (`ClaudeCodePlanUsageSource`): Claude Code's own `/usage` → `~/.claude.json`'s cache. Every
   *  answer judges the plan's alarms. */
  async claudeCodePlan(minAgeMs?: number): Promise<PlanReading> {
    return this.answered(await this.readClaudeCodePlan(minAgeMs));
  }

  private async readClaudeCodePlan(minAgeMs?: number): Promise<PlanReading> {
    if (!this.deps.tracking().claudeCode) return { provider: "claude-code", source: "disabled", windows: [] };
    if (this.deps.claudeExecutable() === undefined) return { provider: "claude-code", source: "not-installed", windows: [] };
    const now = this.now();
    const every = minAgeMs ?? this.deps.claudeCliEveryMs ?? 300_000;
    if (this.claudeRun !== undefined) {
      await within(this.claudeRun, this.deps.planWaitMs ?? 2_000);
    } else if (this.claudeCache === undefined || now - this.claudeCache.at >= every) {
      this.claudeRun ??= (async () => {
        const exe = this.deps.claudeExecutable();
        if (exe === undefined) { this.claudeCache = { at: this.now(), failure: "not-installed" }; return; }
        // The latch: a binary whose `/usage` once reached the model loop is never asked again — until it changes.
        const key = binaryKey("claude", exe);
        if (key === undefined || this.deps.db.latch(key) !== undefined) { this.claudeCache = { at: this.now(), failure: "latched" }; return; }
        // The plan's name (Max, Pro…), from Claude Code's own offline `auth status` — hourly, per binary.
        if (this.claudePlanName === undefined || this.claudePlanName.key !== key || this.now() - this.claudePlanName.at >= 3_600_000) {
          const value = await this.inProbeDir((cwd) => claudeSubscriptionType(exe, { cwd })).catch(() => undefined);
          this.claudePlanName = { at: this.now(), key, ...(value === undefined ? {} : { value }) };
        }
        const r = await this.inProbeDir((cwd) => claudePlanFromCli(exe, {
          cwd, now: this.now,
          ...(this.deps.claudeCliTimeoutMs === undefined ? {} : { timeoutMs: this.deps.claudeCliTimeoutMs }),
        })).catch(() => ({ failure: "spawn-failed" as const, reading: undefined }));
        // Kept with the plan's name (a restart forgets `auth status` until its next run).
        const name = this.claudePlanName?.value;
        if (r.reading !== undefined) this.keep(name === undefined || r.reading.planType !== undefined ? r.reading : { ...r.reading, planType: name });
        this.claudeCache = { at: this.now(), ...r };
        this.judgeAlarms(r.reading);
        if (r.failure === "guard" || r.failure === "guard-model-turn") {
          try { this.deps.db.setLatch(key, r.failure, this.now()); } catch { /* the in-memory cache still holds it back for the throttle */ }
          this.deps.log?.warn?.("[usage] claude /usage did not come back as the local command; not asked again until Claude Code changes");
        } else if (r.failure !== undefined) {
          this.deps.log?.info?.("[usage] claude /usage gave no plan reading", { reason: r.failure });
        }
      })().finally(() => { this.claudeRun = undefined; });
      await within(this.claudeRun, this.deps.planWaitMs ?? 2_000);
    }
    // The plan's name from `auth status` ("max"), its size from `~/.claude.json` ("20x" → "max_20x", shown "Max 20x").
    const file = this.deps.claudeJsonPath === undefined ? undefined : await this.claudeJsonFile(this.deps.claudeJsonPath);
    // A kept reading carries the name it was read with (a restart forgets `auth status` until its next run).
    const named = (r: PlanReading): PlanReading => {
      const base = r.planType ?? this.claudePlanName?.value;
      if (base === undefined) return r;
      return { ...r, planType: file?.multiple === undefined || /_\d{1,3}x$/.test(base) ? base : `${base}_${file.multiple}` };
    };
    if (this.claudeCache?.reading !== undefined) return named(this.judged(this.claudeCache.reading));
    // The last good `/usage` (a failed probe, a restart) against `~/.claude.json`'s cache — the newer of the two.
    const best = newerReading(this.kept("claude-code"), file?.reading);
    if (best !== undefined) return named(this.judged(best));
    return { provider: "claude-code", source: "none", windows: [] };
  }

  /** The Antigravity plan: `agy`'s own `/usage` (no other rung — nothing else of agy's is read). Every answer judges
   *  the plan's alarms. */
  async antigravityPlan(minAgeMs?: number): Promise<PlanReading> {
    return this.answered(await this.readAntigravityPlan(minAgeMs));
  }

  private async readAntigravityPlan(minAgeMs?: number): Promise<PlanReading> {
    if (!this.deps.tracking().antigravity) return { provider: "antigravity", source: "disabled", windows: [] };
    if (this.deps.agyExecutable?.() === undefined) return { provider: "antigravity", source: "not-installed", windows: [] };
    const now = this.now();
    // A run killed at Winter's own deadline (agy ignored its `--print-timeout`) backs off for hours, not minutes — a
    // beat's floor never shortens that.
    const every = this.agyCache?.failure === "timeout" ? (this.deps.agyTimeoutBackoffMs ?? AGY_TIMEOUT_BACKOFF_MS) : (minAgeMs ?? this.deps.agyCliEveryMs ?? 300_000);
    if (this.agyRun !== undefined) {
      await within(this.agyRun, this.deps.planWaitMs ?? 2_000);
    } else if (this.agyCache === undefined || now - this.agyCache.at >= every) {
      this.agyRun ??= (async () => {
        const exe = this.deps.agyExecutable?.();
        if (exe === undefined) { this.agyCache = { at: this.now(), failure: "not-installed" }; return; }
        // The latch, as for Claude Code: a binary whose `/usage` once reached the model loop is not asked again until it changes.
        const key = binaryKey("agy", exe);
        if (key === undefined || this.deps.db.latch(key) !== undefined) { this.agyCache = { at: this.now(), failure: "latched" }; return; }
        // The timeout back-off, persisted (a restart does not shorten it), per exact binary, with its own expiry.
        const backoffKey = binaryKey("agy-timeout", exe);
        const backoff = backoffKey === undefined ? undefined : this.deps.db.latch(backoffKey);
        if (backoff !== undefined && this.now() - backoff.at < (this.deps.agyTimeoutBackoffMs ?? AGY_TIMEOUT_BACKOFF_MS)) {
          this.agyCache = { at: this.now(), failure: "backoff" };
          return;
        }
        const r = await this.inProbeDir((cwd) => antigravityPlanFromCli(exe, {
          cwd, now: this.now,
          ...(this.deps.agyCliTimeoutMs === undefined ? {} : { timeoutMs: this.deps.agyCliTimeoutMs }),
        })).catch(() => ({ failure: "spawn-failed" as const, reading: undefined }));
        this.agyCache = { at: this.now(), ...r };
        if (r.reading !== undefined) this.keep(r.reading);
        this.judgeAlarms(r.reading);
        if (r.failure === "guard") {
          try { this.deps.db.setLatch(key, r.failure, this.now()); } catch { /* the in-memory cache still holds it back for the throttle */ }
          this.deps.log?.warn?.("[usage] agy /usage did not come back as the read-only command; not asked again until Antigravity changes");
        } else if (r.failure === "timeout") {
          try { if (backoffKey !== undefined) this.deps.db.setLatch(backoffKey, "timeout", this.now()); } catch { /* the in-memory throttle still holds it back */ }
          this.deps.log?.info?.("[usage] agy /usage outlived its own --print-timeout; not asked again for hours");
        } else if (r.failure !== undefined) {
          this.deps.log?.info?.("[usage] agy /usage gave no plan reading", { reason: r.failure });
        }
      })().finally(() => { this.agyRun = undefined; });
      await within(this.agyRun, this.deps.planWaitMs ?? 2_000);
    }
    // The latest probe's reading, else the last good one (a failed or backed-off probe, a restart).
    const cached = this.agyCache?.reading ?? this.kept("antigravity");
    if (cached !== undefined) return this.judged(cached);
    return { provider: "antigravity", source: "none", windows: [] };
  }

  // ── plan alarms ─────────────────────────────────────────────────────────────────────────────────

  /** A reading as answered: each window carries its stable key, and the plan's alarms are judged against it. */
  private answered(reading: PlanReading): PlanReading {
    const keyed: PlanReading = { ...reading, windows: reading.windows.map((w) => ({ ...w, windowKey: planWindowKey(w) })) };
    this.judgeAlarms(keyed);
    return keyed;
  }

  /** Every ARMED alarm, oldest first (a fired one waiting for its acknowledgement is not a tick any more). */
  alarms(): UsageAlarm[] {
    return this.deps.db.alarms();
  }

  /** Every fired alarm whose notice no client has acknowledged yet, in the order they fired — from the DB, so a
   *  restart, an app away for hours or a busy island never loses one. */
  firedAlarms(): FiredUsageAlarm[] {
    try { return this.deps.db.firedAlarms(); } catch { return []; }
  }

  /** A client acknowledged a fired alarm's notice (dismissed it, opened it, or showed it its full time): the row goes. */
  ackAlarm(id: string): boolean {
    const acked = this.deps.db.ackAlarm(id);
    if (acked) this.noticesChanged();
    return acked;
  }

  private noticesChanged(): void {
    try { this.deps.onAlarmNotices?.(); } catch { /* the island's failure is its own */ }
  }

  /** Set an alarm (whole percent); one already set for the same window and threshold is answered instead. The plan's
   *  fast beat starts with its first alarm. Whether the window is already past it is the client's rule: the daemon
   *  keeps it, and the next fresh reading that meets it fires it. */
  setAlarm(input: { provider: AlarmProvider; windowKey: string; thresholdPercent: number }): UsageAlarm {
    const alarm = this.deps.db.addAlarm({
      id: randomUUID(), provider: input.provider, windowKey: input.windowKey,
      thresholdPercent: Math.min(100, Math.max(1, Math.round(input.thresholdPercent))), createdAt: this.now(),
    });
    this.rescheduleBeats();
    return alarm;
  }

  /** Remove an alarm; the plan's fast beat stops with its last one. */
  removeAlarm(id: string): boolean {
    const removed = this.deps.db.removeAlarm(id);
    this.rescheduleBeats();
    return removed;
  }

  /**
   * Fire the alarms a reading meets — ONCE each: a window that is not stale, in a reading measured no earlier than the
   * alarm was set (an older one is no news about it), whose used share is at the threshold or above. The alarm is
   * MARKED fired with its notice (`UsageDb.fireAlarm`: `fired_at` set only where it was null) and counts only when THIS
   * call marked it, so two reads of the same reading — a spawn landing while a client's read answers the cache,
   * concurrent asks — fire it once. The row then waits, persisted, for a client to acknowledge its notice. Not installed
   * or tracking off: the reading has no windows, nothing fires, the alarms stay armed.
   */
  private judgeAlarms(reading: PlanReading | undefined): void {
    if (reading === undefined || reading.at === undefined || reading.windows.length === 0) return;
    let alarms: UsageAlarm[];
    try { alarms = this.deps.db.alarms().filter((a) => a.provider === reading.provider); } catch { return; }
    let fired = false;
    for (const a of alarms) {
      if (reading.at < a.createdAt) continue;
      const w = reading.windows.find((x) => !x.stale && planWindowKey(x) === a.windowKey && x.usedPercent >= a.thresholdPercent);
      if (w === undefined) continue;
      const notice = {
        kind: w.kind, ...(w.scope === undefined ? {} : { scope: w.scope }), ...(w.windowMinutes === undefined ? {} : { windowMinutes: w.windowMinutes }),
        usedPercent: w.usedPercent, ...(w.resetsAt === undefined ? {} : { resetsAt: w.resetsAt }),
      };
      try { if (!this.deps.db.fireAlarm(a.id, this.now(), notice)) continue; } catch { continue; }
      fired = true;
      this.deps.log?.info?.("[usage] plan alarm fired", { provider: a.provider, window: a.windowKey, threshold: a.thresholdPercent });
    }
    if (fired) {
      this.rescheduleBeats();
      this.noticesChanged();
    }
  }

  // ── the background plan checks ──────────────────────────────────────────────────────────────────

  /**
   * The background beat (user 2026-10-18, reversing "no background plan polling"): every installed and tracked plan is
   * read every `backgroundEveryMs` (30 min), alarm or not; a plan with at least one alarm is ALSO read on its own fast
   * beat — its throttle (Codex 60 s, Claude Code and Antigravity 5 min) — which stops with its last alarm. Each read is
   * the plan's own ladder (not installed or tracking off answers at once: nothing spawned, nothing fired), and every read
   * judges the alarms. Unref'd timers: they never hold the daemon. No read at start.
   */
  startBackground(): void {
    if (this.cancelSlowBeat !== undefined) return;
    this.cancelSlowBeat = this.interval(() => { void this.checkPlans(PLAN_PROVIDERS); }, this.deps.backgroundEveryMs ?? USAGE_BACKGROUND_EVERY_MS);
    this.rescheduleBeats();
  }

  stopBackground(): void {
    this.cancelSlowBeat?.();
    this.cancelSlowBeat = undefined;
    for (const cancel of this.fastBeats.values()) cancel();
    this.fastBeats.clear();
  }

  /** Test seam: the background beat is running. */
  get backgroundRunning(): boolean {
    return this.cancelSlowBeat !== undefined;
  }

  /** Test seam: the plans on a fast beat now. */
  get beating(): AlarmProvider[] {
    return PLAN_PROVIDERS.filter((p) => this.fastBeats.has(p));
  }

  /** Read these plans now (each answer judges their alarms) — the beats' entry; a failure is the next beat's to retry.
   *  `fast`: a fast beat ticks just as its cache comes of age (a spawn's own run time ends its age early), so its floor
   *  is the period less `FAST_BEAT_SLACK_MS` (5 s; at most half the period) — each tick reads, and a client's read in
   *  between rarely adds a second spawn to a period. */
  async checkPlans(providers: readonly AlarmProvider[], fast = false): Promise<void> {
    await Promise.all(providers.map((p) => {
      const floor = fast ? fastBeatFloor(this.beatMs(p)) : undefined;
      const read = p === "codex" ? this.codexPlan(floor) : p === "claude-code" ? this.claudeCodePlan(floor) : this.antigravityPlan(floor);
      return read.catch(() => undefined);
    }));
  }

  private beatMs(p: AlarmProvider): number {
    const own = this.deps.alarmBeatMs?.[p];
    if (own !== undefined) return own;
    if (p === "codex") return this.deps.codexAppServerEveryMs ?? 60_000;
    return p === "claude-code" ? (this.deps.claudeCliEveryMs ?? 300_000) : (this.deps.agyCliEveryMs ?? 300_000);
  }

  private interval(fn: () => void, ms: number): () => void {
    return (this.deps.setInterval ?? defaultInterval)(fn, ms);
  }

  /** A fast beat for each plan with an alarm, none for the rest — only while the background runs. */
  private rescheduleBeats(): void {
    if (this.cancelSlowBeat === undefined) return;
    let wanted: Set<AlarmProvider>;
    try { wanted = new Set(this.deps.db.alarms().map((a) => a.provider)); } catch { wanted = new Set(); }
    for (const [p, cancel] of [...this.fastBeats]) {
      if (!wanted.has(p)) { cancel(); this.fastBeats.delete(p); }
    }
    for (const p of PLAN_PROVIDERS) {
      if (wanted.has(p) && !this.fastBeats.has(p)) this.fastBeats.set(p, this.interval(() => { void this.checkPlans([p], true); }, this.beatMs(p)));
    }
  }

  /** `~/.claude.json`'s plan cache and the plan's size ("20x"): re-parsed only when the file's mtime or size changed;
   *  never read over the cap (checked on the stat AND on the bytes actually read); the over-cap line is logged once per
   *  process. */
  private async claudeJsonFile(path: string): Promise<{ reading?: PlanReading; multiple?: string } | undefined> {
    let st: { mtimeMs: number; size: number };
    try { st = statSync(path); } catch { this.claudeFileCache = undefined; return undefined; }
    const stamp = `${Math.floor(st.mtimeMs)}:${st.size}`;
    if (this.claudeFileCache?.stamp === stamp) return this.claudeFileCache;
    const cap = this.deps.claudeJsonMaxBytes ?? CLAUDE_JSON_MAX_BYTES;
    const result = st.size > cap ? "over-cap" : await claudeCacheFile(path, this.now(), cap);
    if (result === "over-cap") {
      this.claudeFileCache = { stamp };
      if (!this.claudeFileOverCapLogged) {
        this.claudeFileOverCapLogged = true;
        this.deps.log?.warn?.("[usage] Claude Code's config file is over the size cap; its plan cache is not read");
      }
      return undefined;
    }
    this.claudeFileCache = { stamp, ...(result ?? {}) };
    this.claudeFileParses++;
    return this.claudeFileCache;
  }

  /**
   * Run a probe in its OWN fresh directory — `mkdtemp` under `probeRoot()`, 0700, verified by lstat to be a real
   * directory — and remove exactly that directory afterwards. Never a shared or pre-existing path, never through a
   * symlink: the removal re-checks lstat (a real directory, not a link) and that its realpath lies inside the probe
   * root's realpath; an empty directory is just `rmdir`ed, and `rmSync` (which unlinks a symlink found inside rather
   * than following it) runs only on that verified path.
   */
  async inProbeDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const root = this.deps.probeRoot();
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const dir = mkdtempSync(join(root, "probe-"));
    chmodSync(dir, 0o700);
    const st = lstatSync(dir);
    if (!st.isDirectory() || st.isSymbolicLink()) throw new Error("probe directory is not a real directory");
    try {
      return await fn(dir);
    } finally {
      removeProbeDir(root, dir);
    }
  }


  // ── queries ─────────────────────────────────────────────────────────────────────────────────────

  private rows(range: UsageRange, sources: readonly UsageSource[]): { from: number; to: number; bucketMs: number; rows: Array<UsageRow & { at: number }> } {
    const now = this.now();
    const w = rangeWindow(range, now, range === "all" ? this.deps.db.earliest(sources) : undefined);
    const rows = w.fromRecords
      ? this.deps.db.recordsGrouped(w.from, w.to, sources, w.bucketMs).map((r) => ({ ...r, at: r.bucket }))
      : this.deps.db.hourly(w.from, w.to, sources).map((r) => ({ ...r, at: r.hour }));
    return { from: w.from, to: w.to, bucketMs: w.bucketMs, rows };
  }

  series(range: UsageRange, sources: readonly UsageSource[] = USAGE_SOURCES): {
    range: UsageRange; from: number; to: number; bucketMs: number; buckets: UsageBucket[]; models: UsageModelRow[];
    totals: UsageTotals; bySource: Array<{ source: UsageSource } & UsageTotals>; history: UsageHistory;
  } {
    const { from, to, bucketMs, rows } = this.rows(range, sources);
    const count = Math.max(1, Math.ceil((to - from) / bucketMs));
    const buckets: UsageBucket[] = Array.from({ length: count }, (_, i) => ({ start: from + i * bucketMs, costUsd: 0, tokens: 0, bySource: {}, models: [] }));
    const models = new Map<string, UsageModelRow>();
    const bySource = new Map<UsageSource, UsageTotals>();
    const totals = EMPTY();
    for (const r of rows) {
      const i = Math.min(count - 1, Math.max(0, Math.floor((r.at - from) / bucketMs)));
      const b = buckets[i]!;
      const tokens = r.input + r.output + r.cacheRead + r.cacheWrite;
      b.costUsd += r.costUsd;
      b.tokens += tokens;
      b.bySource[r.source] = (b.bySource[r.source] ?? 0) + r.costUsd;
      const m = b.models.find((x) => x.source === r.source && x.model === r.model);
      if (m === undefined) b.models.push({ source: r.source, model: r.model, costUsd: r.costUsd, tokens });
      else { m.costUsd += r.costUsd; m.tokens += tokens; }
      const key = `${r.source}\u0000${r.provider}\u0000${r.model}`;
      let row = models.get(key);
      if (row === undefined) { row = { source: r.source, provider: r.provider, model: r.model, costBasis: "unknown", ...EMPTY() }; models.set(key, row); }
      add(row, r);
      const prevBasis = row.costBasis;
      const kinds = ([["list", r.listRecords], ["estimate", r.estimateRecords], ["reported", r.reportedRecords]] as const).filter(([, c]) => c > 0);
      const basis = kinds.length === 1 ? kinds[0]![0] : kinds.length > 1 ? "mixed" : "unknown";
      row.costBasis = prevBasis === "unknown" ? basis : basis === "unknown" || basis === prevBasis ? prevBasis : "mixed";
      let s = bySource.get(r.source);
      if (s === undefined) { s = EMPTY(); bySource.set(r.source, s); }
      add(s, r);
      add(totals, r);
    }
    return {
      range, from, to, bucketMs, buckets, history: this.history(),
      models: [...models.values()].sort((a, b) => b.costUsd - a.costUsd || (b.input + b.output + b.cacheRead) - (a.input + a.output + a.cacheRead)),
      totals, bySource: [...bySource.entries()].map(([source, t]) => ({ source, ...t })),
    };
  }

  async summary(range: UsageRange, sources: readonly UsageSource[] = USAGE_SOURCES, opts: { plans?: boolean; waitMs?: number } = {}) {
    // The ingest and the plan ladders run side by side; each answers within its own short wait.
    const [, codex, claudeCode, antigravity] = await Promise.all([
      this.ingestWithin(opts.waitMs ?? 1_500),
      opts.plans === false ? undefined : this.codexPlan(),
      opts.plans === false ? undefined : this.claudeCodePlan(),
      opts.plans === false ? undefined : this.antigravityPlan(),
    ]);
    const s = this.series(range, sources);
    const plans = codex === undefined || claudeCode === undefined || antigravity === undefined ? undefined : { codex, claudeCode, antigravity };
    return {
      range: s.range, from: s.from, to: s.to, bucketMs: s.bucketMs, totals: s.totals, bySource: s.bySource,
      topModels: s.models.slice(0, 5),
      spark: s.buckets.map((b) => b.costUsd), sparkTokens: s.buckets.map((b) => b.tokens),
      ...(plans === undefined ? {} : { plans }),
      tracking: this.deps.tracking(), ingest: this.ingestState(), history: s.history,
      // The plan alarms, so both surfaces draw their ticks from the answer they already ask for.
      alarms: this.alarmsSafe(),
      // A source with no plan slot to say "not installed": OpenCode's toggle shows only when it is on this Mac.
      installed: { opencode: this.deps.opencodeExecutable?.() !== undefined },
    };
  }

  private alarmsSafe(): UsageAlarm[] {
    try { return this.deps.db.alarms(); } catch { return []; }
  }

  /** Run (or join) an ingest pass, waiting at most `ms` for it — what is stored by then is answered. */
  async ingestWithin(ms: number): Promise<void> {
    const run = this.ingest();
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([run, new Promise<void>((r) => { timer = setTimeout(r, ms); timer.unref?.(); })]);
    if (timer !== undefined) clearTimeout(timer);
  }

  // ── subscriptions ───────────────────────────────────────────────────────────────────────────────

  subscriptions() {
    const now = this.now();
    return this.deps.db.subscriptions().map((s) => {
      const cycle = subscriptionCycle(s, now);
      const usage = this.deps.db.costFor(cycle.cycleStart, now, s.covers);
      return { ...s, ...cycle, usageThisCycleUsd: usage.costUsd, usageThisCycleTokens: usage.tokens, unpricedTokens: usage.unpricedTokens };
    });
  }

  setSubscription(input: Omit<Subscription, "id" | "createdAt" | "updatedAt"> & { id?: string }): Subscription {
    const now = this.now();
    const existing = input.id === undefined ? undefined : this.deps.db.subscriptions().find((s) => s.id === input.id);
    const sub: Subscription = {
      id: input.id ?? randomUUID(), name: input.name, provider: input.provider, price: input.price, currency: input.currency,
      cadence: input.cadence, renewalDay: input.renewalDay, ...(input.renewalMonth === undefined ? {} : { renewalMonth: input.renewalMonth }),
      covers: input.covers, createdAt: existing?.createdAt ?? now, updatedAt: now,
    };
    this.deps.db.upsertSubscription(sub);
    return sub;
  }

  removeSubscription(id: string): boolean {
    return this.deps.db.removeSubscription(id);
  }
}
