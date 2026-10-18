import { createHash, randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmdirSync, rmSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { CLAUDE_JSON_MAX_BYTES, claudeCodeRecordOf, claudeCodeTranscripts, claudePlanFromCacheFile, claudePlanFromCli, claudeSubscriptionType, readCapped } from "./claude-code";
import { CLAUDE_STATS_FILE, CLAUDE_STATS_MAX_BYTES, claudeStatsRecords, overlapFrom, parseClaudeStats, utcDay, utcNoon, type ClaudeStats } from "./claude-stats";
import { codexPlanFromAppServer, codexPlanFromRollouts, codexRecordOf, codexRollouts, codexStateOf } from "./codex";
import { USAGE_SOURCES, type Subscription, type SyntheticRow, type UsageDb, type UsageRecordInput, type UsageRow, type UsageSource } from "./db";
import { fileKey, readNewLines, type FoundFile } from "./ingest-files";
import { staleness, type PlanReading, type PlanStatusWindow } from "./plan";
import type { UsagePricer } from "./pricing";

// The usage service (`docs/claude/usage.md`): records Winter's own turns as they end, ingests the user's Codex and
// Claude Code usage ON DEMAND (when a Usage surface asks — no watcher, no timer: an idle daemon does nothing), reads
// the two plans through their source ladders, and answers the `usage.*` RPCs.

export type UsageRange = "1h" | "24h" | "7d" | "30d" | "all";
export const USAGE_RANGES: readonly UsageRange[] = ["1h", "24h", "7d", "30d", "all"];

export interface UsageTracking { codex: boolean; claudeCode: boolean }

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
}

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
  /** `list` (the runtime's own price), `estimate` (Winter's list-price estimate), `mixed`, or `unknown`. */
  costBasis: "list" | "estimate" | "mixed" | "unknown";
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
  private codexRun: Promise<void> | undefined;
  private claudeCache: { at: number; reading?: PlanReading; failure?: string } | undefined;
  private claudeRun: Promise<void> | undefined;
  /** Claude Code's plan name (`auth status`'s `subscriptionType`), per binary, re-asked hourly. */
  private claudePlanName: { at: number; key: string; value?: string } | undefined;
  /** Set when `/usage` came back as something other than the local command: this rung is off until restart. */
  /** The passive rungs' last readings (rollout tails, `~/.claude.json`), re-read at most every `fallbackEveryMs`. */
  private rolloutCache: { at: number; reading?: PlanReading } | undefined;
  private claudeFileCache: { stamp: string; reading?: PlanReading } | undefined;
  /** Test seam: how many times `~/.claude.json` was parsed. */
  claudeFileParses = 0;
  private claudeFileOverCapLogged = false;
  /** Claude Code's `stats-cache.json`, parsed only when its mtime or size changed. */
  private statsFile: { stamp: string; stats?: ClaudeStats } | undefined;
  /** The last applied backfill's inputs (file stamp, transcript cutoff day, today): unchanged → nothing to do. */
  private statsSignature: string | undefined;
  private statsLogged = new Set<string>();
  /** Test seam: how many times `stats-cache.json` was parsed. */
  claudeStatsParses = 0;

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
    const switched = this.lastTracking === undefined || this.lastTracking.codex !== tracking.codex || this.lastTracking.claudeCode !== tracking.claudeCode;
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
        const files = await claudeCodeTranscripts(this.deps.claudeHome);
        const ccMore = await this.ingestFiles("claude-code", files, (line, _state, file) => claudeCodeRecordOf(line, this.deps.pricer, file.mtimeMs));
        more = ccMore || more;
        // Transcripts win, EVERY pass (a chunked import, a missing or corrupt stats file included): a synthetic row on a
        // day the transcripts now cover goes. New history is planned only once the transcripts are all in — its boundary
        // is the first transcript day.
        this.dropCoveredSynthetic();
        if (!ccMore) await this.importClaudeStats(this.deps.claudeHome);
      }
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

  /** The UTC day of the earliest TRANSCRIPT-derived Claude Code record (synthetic rows never move it). */
  private cutoffDay(): string | undefined {
    const earliest = this.deps.db.earliestReal("claude-code");
    return earliest === undefined ? undefined : utcDay(earliest);
  }

  /** Remove every synthetic Claude Code row on or after the first transcript day — an indexed seek; a write only when
   *  there is something to remove. Independent of the stats file: it may be missing, corrupt or unchanged. */
  private dropCoveredSynthetic(): void {
    const cutoffDay = this.cutoffDay();
    if (cutoffDay === undefined) return;
    const covered = this.deps.db.syntheticDedupesFrom("claude-code", Date.parse(`${cutoffDay}T00:00:00Z`));
    if (covered.length === 0) return;
    const { removed } = this.deps.db.reconcileSynthetic("claude-code", covered, []);
    if (removed > 0) this.deps.log?.info?.("[usage] Claude Code /stats history updated", { added: 0, removed });
  }

  /**
   * Backfill Claude Code's history from its own `/stats` cache (`usage/claude-stats.ts`) for the days its transcripts no
   * longer cover. The file is parsed only when its mtime or size changed; the rows are re-planned (and re-calibrated)
   * only when the file or the transcript coverage (the first transcript day) changed — never merely because a day
   * passed — and written only where they differ. A day the cache no longer lists keeps its rows (history). A missing,
   * corrupt or over-cap file plans nothing; `dropCoveredSynthetic` runs before this regardless.
   */
  private async importClaudeStats(claudeHome: string): Promise<void> {
    const path = join(claudeHome, CLAUDE_STATS_FILE);
    let st: { mtimeMs: number; size: number };
    try { st = statSync(path); } catch { return; }
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
    const stats = this.statsFile.stats;
    if (stats === undefined) return;
    const now = this.now();
    const today = utcDay(now);
    const cutoffDay = this.cutoffDay();
    const signature = `${stamp}|${cutoffDay ?? ""}`;
    if (signature === this.statsSignature) return;
    const from = overlapFrom(now);
    const real = cutoffDay === undefined ? [] : this.deps.db.dailyRealTotals("claude-code", Date.parse(`${from}T00:00:00Z`));
    const wanted = claudeStatsRecords({ stats, ...(cutoffDay === undefined ? {} : { cutoffDay }), today, real, overlapFromDay: from, pricer: this.deps.pricer });
    const stored = new Map(this.deps.db.syntheticRows("claude-code").map((r) => [r.dedupe, r]));
    // Covered days were removed by `dropCoveredSynthetic` this very pass; the plan never reaches them.
    const upsert = wanted.filter((r) => { const s = stored.get(r.dedupe); return s === undefined || differs(s, r); });
    const { removed, added } = this.deps.db.reconcileSynthetic("claude-code", [], upsert);
    this.statsSignature = signature;
    if (removed + added > 0) this.deps.log?.info?.("[usage] Claude Code /stats history updated", { added, removed });
  }

  /** Where the Claude Code history came from (the Usage window's footnote). */
  history(): UsageHistory {
    const span = this.deps.db.syntheticSpan("claude-code");
    if (span === undefined) return {};
    // The first transcript day when there is one (every synthetic row lies before it); with no transcripts at all, the
    // day after the last imported day.
    const cutoffDay = this.cutoffDay();
    const before = cutoffDay !== undefined ? utcNoon(cutoffDay) : utcNoon(utcDay(span.last + 86_400_000));
    return { claudeCodeStats: { from: span.first, before } };
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

  /** The Codex plan: Codex's app-server → the newest rollout's `rate_limits` → Winter's own codex-oauth report. */
  async codexPlan(): Promise<PlanReading> {
    if (!this.deps.tracking().codex) return { provider: "codex", source: "disabled", windows: [] };
    // Not on this Mac: no slot at all (user 2026-10-18), whatever an old rollout or Winter's own sign-in could say.
    if (this.deps.codexExecutable() === undefined) return { provider: "codex", source: "not-installed", windows: [] };
    const now = this.now();
    const every = this.deps.codexAppServerEveryMs ?? 60_000;
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
        if (r.failure !== undefined) this.deps.log?.info?.("[usage] codex app-server gave no plan reading", { reason: r.failure });
      })().finally(() => { this.codexRun = undefined; });
      await within(this.codexRun, this.deps.planWaitMs ?? 2_000);
    }
    if (this.codexCache?.reading !== undefined) return this.codexCache.reading;
    if (this.deps.codexHome !== undefined) {
      // The passive rung, cached like the spawn (a tree walk + tail reads every 5 s would not be cheap).
      if (this.rolloutCache === undefined || this.now() - this.rolloutCache.at >= (this.deps.fallbackEveryMs ?? 60_000)) {
        this.rolloutCache = { at: this.now(), reading: await codexPlanFromRollouts(await codexRollouts(this.deps.codexHome), this.now()) };
      }
      const fromRollout = this.rolloutCache.reading;
      if (fromRollout !== undefined) return { ...fromRollout, windows: fromRollout.windows.map((w) => ({ ...w, ...staleness(fromRollout.at, w.windowMinutes, w.resetsAt, this.now()) })) };
    }
    const winter = this.deps.winterCodexWindows();
    if (winter.length > 0) return { provider: "codex", source: "winter-codex-oauth", windows: [], statusOnly: winter, at: Math.max(...winter.map((w) => w.at)) };
    return { provider: "codex", source: "none", windows: [] };
  }

  /** The Claude Code plan (`ClaudeCodePlanUsageSource`): Claude Code's own `/usage` → `~/.claude.json`'s cache. */
  async claudeCodePlan(): Promise<PlanReading> {
    if (!this.deps.tracking().claudeCode) return { provider: "claude-code", source: "disabled", windows: [] };
    if (this.deps.claudeExecutable() === undefined) return { provider: "claude-code", source: "not-installed", windows: [] };
    const now = this.now();
    const every = this.deps.claudeCliEveryMs ?? 300_000;
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
        this.claudeCache = { at: this.now(), ...r };
        if (r.failure === "guard" || r.failure === "guard-model-turn") {
          try { this.deps.db.setLatch(key, r.failure, this.now()); } catch { /* the in-memory cache still holds it back for the throttle */ }
          this.deps.log?.warn?.("[usage] claude /usage did not come back as the local command; not asked again until Claude Code changes");
        } else if (r.failure !== undefined) {
          this.deps.log?.info?.("[usage] claude /usage gave no plan reading", { reason: r.failure });
        }
      })().finally(() => { this.claudeRun = undefined; });
      await within(this.claudeRun, this.deps.planWaitMs ?? 2_000);
    }
    const plan = this.claudePlanName?.value;
    const named = (r: PlanReading): PlanReading => (plan === undefined || r.planType !== undefined ? r : { ...r, planType: plan });
    if (this.claudeCache?.reading !== undefined) return named(this.claudeCache.reading);
    if (this.deps.claudeJsonPath !== undefined) {
      const cached = await this.claudeJsonReading(this.deps.claudeJsonPath);
      if (cached !== undefined) return named({ ...cached, windows: cached.windows.map((w) => ({ ...w, ...staleness(cached.at, w.windowMinutes, w.resetsAt, this.now()) })) });
    }
    return { provider: "claude-code", source: "none", windows: [] };
  }

  /** `~/.claude.json`'s plan cache: re-parsed only when the file's mtime or size changed; never read over the cap
   *  (checked on the stat AND on the bytes actually read); the over-cap line is logged once per process. */
  private async claudeJsonReading(path: string): Promise<PlanReading | undefined> {
    let st: { mtimeMs: number; size: number };
    try { st = statSync(path); } catch { this.claudeFileCache = undefined; return undefined; }
    const stamp = `${Math.floor(st.mtimeMs)}:${st.size}`;
    if (this.claudeFileCache?.stamp === stamp) return this.claudeFileCache.reading;
    const cap = this.deps.claudeJsonMaxBytes ?? CLAUDE_JSON_MAX_BYTES;
    const result = st.size > cap ? "over-cap" : await claudePlanFromCacheFile(path, this.now(), cap);
    if (result === "over-cap") {
      this.claudeFileCache = { stamp };
      if (!this.claudeFileOverCapLogged) {
        this.claudeFileOverCapLogged = true;
        this.deps.log?.warn?.("[usage] Claude Code's config file is over the size cap; its plan cache is not read");
      }
      return undefined;
    }
    this.claudeFileCache = { stamp, reading: result };
    this.claudeFileParses++;
    return result;
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
      const basis = r.listRecords > 0 && r.estimateRecords === 0 ? "list" : r.estimateRecords > 0 && r.listRecords === 0 ? "estimate" : r.listRecords + r.estimateRecords > 0 ? "mixed" : "unknown";
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
    // The ingest and both plan ladders run side by side; each answers within its own short wait.
    const [, codex, claudeCode] = await Promise.all([
      this.ingestWithin(opts.waitMs ?? 1_500),
      opts.plans === false ? undefined : this.codexPlan(),
      opts.plans === false ? undefined : this.claudeCodePlan(),
    ]);
    const s = this.series(range, sources);
    const plans = codex === undefined || claudeCode === undefined ? undefined : { codex, claudeCode };
    return {
      range: s.range, from: s.from, to: s.to, bucketMs: s.bucketMs, totals: s.totals, bySource: s.bySource,
      topModels: s.models.slice(0, 5),
      spark: s.buckets.map((b) => b.costUsd), sparkTokens: s.buckets.map((b) => b.tokens),
      ...(plans === undefined ? {} : { plans }),
      tracking: this.deps.tracking(), ingest: this.ingestState(), history: s.history,
    };
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
