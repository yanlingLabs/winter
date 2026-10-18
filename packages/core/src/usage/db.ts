import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

// The usage DB (`docs/claude/usage.md`): `<WINTER_HOME>/usage/usage.db`, a file of its own — NEVER a table in
// `runtime-state.db`, whose schema version other branches move. Its own tiny schema (`PRAGMA user_version`).
//
//  - `usage_records`: one row per model per turn (Winter), per token_count increment (Codex) or per assistant
//    message (Claude Code). Numbers, a model, a provider, a time and an opaque id — NOTHING ELSE from another app's
//    files (no content, no path, no project name). `dedupe` is UNIQUE: a re-read never counts twice.
//  - `usage_hourly`: the same numbers rolled up per hour × source × provider × model, written in the SAME
//    transaction as the record (only when the record was new), for the long ranges.
//  - `ingest_files`: per-file read state for the external sources — keyed by a HASH of the path (the plaintext
//    path names the user's project), with the inode and byte offset, and the per-file state a delta needs.
//  - `subscriptions`: the plans the user entered (Settings-like data the user owns, edited over RPC).
//  - `probe_latches` (v2): a plan probe switched off for one exact binary (its realpath, mtime and size) — Claude Code's
//    `/usage` that reached the model loop. Survives restarts; an updated binary is a new key, so it is tried again.
//  - `synthetic` (v3): a row DERIVED from Claude Code's own `/stats` cache (`usage/claude-stats.ts`) for a day its
//    transcripts no longer cover — one per model per day, `dedupe` = `ccstats:<model>:<YYYY-MM-DD>`. They are the
//    only Claude Code rows ever replaced or removed (`reconcileSynthetic`), and the hourly rollup counts them
//    (`synthetic_records`).
//  - `reported` (v4): a cost the other app itself recorded (OpenCode's own per-model cost) — `cost_basis` "reported",
//    counted in the rollup's `reported_records`. OpenCode's rows are one per model per local day, REPLACED as the day
//    grows (`replaceDay`); its progress lives in `ingest_files` under a key of its own (`sourceState`).
//  - `usage_alarms` (v5): the user's one-shot plan alarms — a plan, one of its windows by a STABLE key (its kind and
//    scope, the same window across readings and rungs), a whole-percent threshold and when it was set. A fired alarm is
//    MARKED (`fired_at` and its notice, `fireAlarm` — true only for the call that marked it: the single-flight) and kept,
//    surviving restarts, until a client acknowledges its notice (`ackAlarm` deletes it).

export const USAGE_DB_SCHEMA_VERSION = 5;

export type UsageSource = "winter" | "codex" | "claude-code" | "opencode";
export const USAGE_SOURCES: readonly UsageSource[] = ["winter", "codex", "claude-code", "opencode"];

/** How a record's cost was reached: the runtime's own list price, Winter's list-price estimate from the catalog (a
 *  subscription row, or another app's usage), the cost the other app itself recorded (OpenCode), or no price at all. */
export type CostBasis = "list" | "estimate" | "reported" | "unknown";

export interface UsageRecordInput {
  dedupe: string;
  source: UsageSource;
  /** Epoch ms. */
  at: number;
  sessionId?: string;
  mode?: string;
  provider?: string;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning?: number;
  costUsd?: number;
  costBasis: CostBasis;
  /** What the cache reads saved against the same tokens at the full input price (list prices). */
  cacheSavingsUsd?: number;
  /** A row derived from Claude Code's `/stats` cache, not read from a transcript (shown as "est." with a footnote). */
  synthetic?: boolean;
}

export interface UsageRow {
  source: UsageSource;
  provider: string;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  costUsd: number;
  /** Tokens (all four kinds) of records with no price. */
  unpricedTokens: number;
  /** Records priced by the runtime itself (`list`). */
  listRecords: number;
  /** Records priced by Winter's estimate. */
  estimateRecords: number;
  /** Records priced by the other app itself (`reported`). */
  reportedRecords: number;
  cacheSavingsUsd: number;
  records: number;
  /** Of `records`, how many were derived from Claude Code's `/stats` cache (`synthetic`). */
  syntheticRecords: number;
}

/** A stored row, as the synthetic import and OpenCode's day replacement compare it. */
export interface SyntheticRow {
  dedupe: string;
  at: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number | null;
  costBasis: CostBasis;
  cacheSavingsUsd: number | null;
}

export interface IngestFileState {
  key: string;
  source: UsageSource;
  inode: number;
  offset: number;
  /** Source-specific carry-over (JSON): Codex's last cumulative totals, model, session id. */
  state: Record<string, unknown>;
}

/** The plans an alarm can watch (the plan slots, not the usage sources). */
export type AlarmProvider = "codex" | "claude-code" | "antigravity";

/** A one-shot plan alarm: fires once when a window's used share reaches `thresholdPercent`; its notice is then kept
 *  until a client acknowledges it, and the row goes. */
export interface UsageAlarm {
  id: string;
  provider: AlarmProvider;
  /** The window's stable key (`planWindowKey`: its kind and scope). */
  windowKey: string;
  /** 1…100, whole. */
  thresholdPercent: number;
  createdAt: number;
}

/** What a fired alarm's notice says about the window that met it (kept with the row until it is acknowledged). */
export interface UsageAlarmNotice {
  kind: string;
  scope?: string;
  windowMinutes?: number;
  /** The used share (0…100) that met it. */
  usedPercent: number;
  /** Epoch ms. */
  resetsAt?: number;
}

/** A fired alarm, waiting for a client's acknowledgement. */
export interface FiredUsageAlarm extends UsageAlarm, UsageAlarmNotice {
  /** Epoch ms. */
  firedAt: number;
}

export interface Subscription {
  id: string;
  name: string;
  provider: string;
  price: number;
  currency: string;
  cadence: "monthly" | "yearly";
  /** 1…31 (clamped to the month's length). */
  renewalDay: number;
  /** 1…12, yearly plans only. */
  renewalMonth?: number;
  /** Which usage counts toward this plan: `codex`, `claude-code`, `winter` (any Winter session), or `winter:<provider>`. */
  covers: string[];
  createdAt: number;
  updatedAt: number;
}

const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export class UsageDb {
  readonly db: Database;

  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path, { create: true });
    try { chmodSync(path, 0o600); } catch { /* best effort */ }
    try {
      this.db.run("PRAGMA journal_mode = WAL");
      this.db.run("PRAGMA busy_timeout = 2000");
      this.db.run("PRAGMA synchronous = NORMAL");
      this.migrate();
    } catch (err) {
      try { this.db.close(); } catch { /* already closed */ }
      throw err;
    }
  }

  schemaVersion(): number {
    return this.db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0;
  }

  private migrate(): void {
    const v = this.schemaVersion();
    if (v > USAGE_DB_SCHEMA_VERSION) throw new Error(`usage.db is schema ${v}, newer than this Winter (${USAGE_DB_SCHEMA_VERSION})`);
    if (v === USAGE_DB_SCHEMA_VERSION) { this.ensureAlarmsTable(); return; }
    if (v < 1) this.migrateTo1();
    if (v < 2) {
      this.db.transaction(() => {
        this.db.run(`CREATE TABLE IF NOT EXISTS probe_latches (
          key TEXT PRIMARY KEY,
          reason TEXT NOT NULL,
          at INTEGER NOT NULL
        )`);
        this.db.run("PRAGMA user_version = 2");
      })();
    }
    if (v < 3) {
      this.db.transaction(() => {
        this.db.run("ALTER TABLE usage_records ADD COLUMN synthetic INTEGER NOT NULL DEFAULT 0");
        this.db.run("ALTER TABLE usage_hourly ADD COLUMN synthetic_records INTEGER NOT NULL DEFAULT 0");
        // `earliestReal` / `syntheticSpan` are a seek, not a walk of the `at` index past other sources' older rows.
        this.db.run("CREATE INDEX IF NOT EXISTS usage_records_source_synthetic_at ON usage_records(source, synthetic, at)");
        this.db.run("PRAGMA user_version = 3");
      })();
    }
    if (v < 4) {
      this.db.transaction(() => {
        this.db.run("ALTER TABLE usage_hourly ADD COLUMN reported_records INTEGER NOT NULL DEFAULT 0");
        this.db.run("PRAGMA user_version = 4");
      })();
    }
    if (v < 5) {
      this.db.transaction(() => {
        this.ensureAlarmsTable();
        this.db.run("PRAGMA user_version = 5");
      })();
    }
  }

  /**
   * The v5 table, idempotently — run on every open at schema 5 too: a usage.db made by an earlier build of schema 5
   * (alarms deleted when they fired, a table-wide UNIQUE) gets `fired_at` / `notice` and the armed-only index. That
   * table's UNIQUE (provider, window_key, threshold) would block arming an alarm again while its fired notice waits, so
   * such a table is rebuilt (rows kept); otherwise only the missing columns are added (`PRAGMA table_info`).
   */
  private ensureAlarmsTable(): void {
    this.db.transaction(() => {
      // `fired_at` / `notice`: set once when it fires; the row stays until its notice is acknowledged.
      const create = (name: string): string => `CREATE TABLE IF NOT EXISTS ${name} (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        window_key TEXT NOT NULL,
        threshold INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        fired_at INTEGER,
        notice TEXT
      )`;
      const existing = this.db.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'usage_alarms'").get() as { sql: string } | null;
      if (existing === null) {
        this.db.run(create("usage_alarms"));
      } else {
        const columns = new Set((this.db.query("PRAGMA table_info(usage_alarms)").all() as Array<{ name: string }>).map((c) => c.name));
        if (!columns.has("fired_at")) this.db.run("ALTER TABLE usage_alarms ADD COLUMN fired_at INTEGER");
        if (!columns.has("notice")) this.db.run("ALTER TABLE usage_alarms ADD COLUMN notice TEXT");
        if (/UNIQUE\s*\(/i.test(existing.sql)) {
          this.db.run(create("usage_alarms_rebuilt"));
          this.db.run(`INSERT INTO usage_alarms_rebuilt (id, provider, window_key, threshold, created_at, fired_at, notice)
            SELECT id, provider, window_key, threshold, created_at, fired_at, notice FROM usage_alarms`);
          this.db.run("DROP TABLE usage_alarms");
          this.db.run("ALTER TABLE usage_alarms_rebuilt RENAME TO usage_alarms");
        }
      }
      // One ARMED alarm per plan, window and threshold: a double click sets one, and a tick's removal removes it whole;
      // a fired one waiting for its acknowledgement never blocks setting the same alarm again.
      this.db.run("CREATE UNIQUE INDEX IF NOT EXISTS usage_alarms_armed ON usage_alarms(provider, window_key, threshold) WHERE fired_at IS NULL");
    })();
  }

  private migrateTo1(): void {
    this.db.transaction(() => {
      this.db.run(`CREATE TABLE IF NOT EXISTS usage_records (
        id INTEGER PRIMARY KEY,
        dedupe TEXT NOT NULL UNIQUE,
        source TEXT NOT NULL,
        at INTEGER NOT NULL,
        session_id TEXT,
        mode TEXT,
        provider TEXT NOT NULL DEFAULT '',
        model TEXT NOT NULL,
        input INTEGER NOT NULL,
        output INTEGER NOT NULL,
        cache_read INTEGER NOT NULL,
        cache_write INTEGER NOT NULL,
        reasoning INTEGER,
        cost_usd REAL,
        cost_basis TEXT NOT NULL,
        cache_savings_usd REAL
      )`);
      this.db.run("CREATE INDEX IF NOT EXISTS usage_records_at ON usage_records(at)");
      this.db.run(`CREATE TABLE IF NOT EXISTS usage_hourly (
        hour INTEGER NOT NULL,
        source TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        input INTEGER NOT NULL DEFAULT 0,
        output INTEGER NOT NULL DEFAULT 0,
        cache_read INTEGER NOT NULL DEFAULT 0,
        cache_write INTEGER NOT NULL DEFAULT 0,
        reasoning INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL DEFAULT 0,
        unpriced_tokens INTEGER NOT NULL DEFAULT 0,
        list_records INTEGER NOT NULL DEFAULT 0,
        estimate_records INTEGER NOT NULL DEFAULT 0,
        cache_savings_usd REAL NOT NULL DEFAULT 0,
        records INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (hour, source, provider, model)
      )`);
      this.db.run(`CREATE TABLE IF NOT EXISTS ingest_files (
        key TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        inode INTEGER NOT NULL,
        offset INTEGER NOT NULL,
        state TEXT NOT NULL DEFAULT '{}',
        updated_at INTEGER NOT NULL
      )`);
      this.db.run(`CREATE TABLE IF NOT EXISTS subscriptions (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        provider TEXT NOT NULL,
        price REAL NOT NULL,
        currency TEXT NOT NULL,
        cadence TEXT NOT NULL,
        renewal_day INTEGER NOT NULL,
        renewal_month INTEGER,
        covers TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`);
      this.db.run("PRAGMA user_version = 1");
    })();
  }

  /** Insert records (in one transaction); a record whose `dedupe` is known is skipped. Returns how many were new. */
  insert(records: readonly UsageRecordInput[]): number {
    if (records.length === 0) return 0;
    const ins = this.db.prepare(`INSERT OR IGNORE INTO usage_records
      (dedupe, source, at, session_id, mode, provider, model, input, output, cache_read, cache_write, reasoning, cost_usd, cost_basis, cache_savings_usd, synthetic)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const roll = this.db.prepare(`INSERT INTO usage_hourly
      (hour, source, provider, model, input, output, cache_read, cache_write, reasoning, cost_usd, unpriced_tokens, list_records, estimate_records, cache_savings_usd, records, synthetic_records, reported_records)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT (hour, source, provider, model) DO UPDATE SET
        input = input + excluded.input, output = output + excluded.output,
        cache_read = cache_read + excluded.cache_read, cache_write = cache_write + excluded.cache_write,
        reasoning = reasoning + excluded.reasoning, cost_usd = cost_usd + excluded.cost_usd,
        unpriced_tokens = unpriced_tokens + excluded.unpriced_tokens,
        list_records = list_records + excluded.list_records, estimate_records = estimate_records + excluded.estimate_records,
        cache_savings_usd = cache_savings_usd + excluded.cache_savings_usd, records = records + 1,
        synthetic_records = synthetic_records + excluded.synthetic_records, reported_records = reported_records + excluded.reported_records`);
    let added = 0;
    this.db.transaction(() => {
      for (const r of records) {
        const priced = r.costUsd !== undefined && r.costBasis !== "unknown";
        const res = ins.run(r.dedupe, r.source, Math.round(r.at), r.sessionId ?? null, r.mode ?? null, r.provider ?? "", r.model,
          r.input, r.output, r.cacheRead, r.cacheWrite, r.reasoning ?? null, priced ? r.costUsd! : null, priced ? r.costBasis : "unknown",
          r.cacheSavingsUsd ?? null, r.synthetic === true ? 1 : 0);
        if (res.changes === 0) continue;
        added++;
        const hour = Math.floor(r.at / 3_600_000) * 3_600_000;
        const tokens = r.input + r.output + r.cacheRead + r.cacheWrite;
        roll.run(hour, r.source, r.provider ?? "", r.model, r.input, r.output, r.cacheRead, r.cacheWrite, r.reasoning ?? 0,
          priced ? r.costUsd! : 0, priced ? 0 : tokens, priced && r.costBasis === "list" ? 1 : 0, priced && r.costBasis === "estimate" ? 1 : 0,
          r.cacheSavingsUsd ?? 0, r.synthetic === true ? 1 : 0, priced && r.costBasis === "reported" ? 1 : 0);
      }
    })();
    return added;
  }

  // ── synthetic rows (Claude Code's `/stats` history) ─────────────────────────────────────────────

  /** The earliest TRANSCRIPT-derived (non-synthetic) record of `source`, epoch ms — synthetic rows never move it. */
  earliestReal(source: UsageSource): number | undefined {
    const r = this.db.query("SELECT MIN(at) AS at FROM usage_records WHERE source = ? AND synthetic = 0").get(source) as { at: number | null } | null;
    return r?.at ?? undefined;
  }

  /** The first and last synthetic record of `source`, epoch ms. */
  syntheticSpan(source: UsageSource): { first: number; last: number } | undefined {
    const r = this.db.query("SELECT MIN(at) AS first, MAX(at) AS last FROM usage_records WHERE source = ? AND synthetic = 1")
      .get(source) as { first: number | null; last: number | null } | null;
    return r?.first === null || r?.first === undefined || r.last === null ? undefined : { first: r.first, last: r.last };
  }

  /** Non-synthetic token totals of `source` per model per UTC day (`YYYY-MM-DD`) since `fromMs`: `all` = the four
   *  kinds, `io` = input + output only. */
  dailyRealTotals(source: UsageSource, fromMs: number): Array<{ model: string; day: string; all: number; io: number }> {
    const rows = this.db.query(`SELECT model, (at / 86400000) AS d, SUM(input + output + cache_read + cache_write) AS a, SUM(input + output) AS io
      FROM usage_records WHERE source = ? AND synthetic = 0 AND at >= ? GROUP BY model, d`).all(source, fromMs) as Array<Record<string, unknown>>;
    return rows.map((r) => ({ model: String(r.model), day: new Date(n(r.d) * 86_400_000).toISOString().slice(0, 10), all: n(r.a), io: n(r.io) }));
  }

  syntheticRows(source: UsageSource): SyntheticRow[] {
    return this.storedRows(source, true);
  }

  /** The stored rows of `source` (synthetic or not), with `at` in [from, to) when given. */
  storedRows(source: UsageSource, synthetic: boolean, from = Number.MIN_SAFE_INTEGER, to = Number.MAX_SAFE_INTEGER): SyntheticRow[] {
    const rows = this.db.query("SELECT dedupe, at, input, output, cache_read, cache_write, cost_usd, cost_basis, cache_savings_usd FROM usage_records WHERE source = ? AND synthetic = ? AND at >= ? AND at < ?")
      .all(source, synthetic ? 1 : 0, from, to) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      dedupe: String(r.dedupe), at: n(r.at), input: n(r.input), output: n(r.output), cacheRead: n(r.cache_read), cacheWrite: n(r.cache_write),
      costUsd: typeof r.cost_usd === "number" ? r.cost_usd : null,
      costBasis: r.cost_basis === "list" || r.cost_basis === "estimate" || r.cost_basis === "reported" ? r.cost_basis : "unknown",
      cacheSavingsUsd: typeof r.cache_savings_usd === "number" ? r.cache_savings_usd : null,
    }));
  }

  /** The synthetic rows of `source` at or after `fromMs` (an index seek). */
  syntheticDedupesFrom(source: UsageSource, fromMs: number): string[] {
    return (this.db.query("SELECT dedupe FROM usage_records WHERE source = ? AND synthetic = 1 AND at >= ?").all(source, fromMs) as Array<{ dedupe: string }>)
      .map((r) => r.dedupe);
  }

  /**
   * Apply a synthetic-row plan in ONE transaction: remove the rows named in `remove` (and any being replaced), then
   * insert `upsert` — a removed row's numbers come off its hour's rollup (an hour row left with no records goes). Only
   * synthetic rows are ever touched. Returns how many rows were removed and added.
   */
  reconcileSynthetic(source: UsageSource, remove: readonly string[], upsert: readonly UsageRecordInput[]): { removed: number; added: number } {
    return this.reconcile(source, true, remove, upsert);
  }

  /**
   * Replace a whole day of `source`'s (non-synthetic) rows with `rows` in ONE transaction: every stored row with `at` in
   * [from, to) goes (its numbers off its hour's rollup), then `rows` are inserted. OpenCode's per-model daily rows, which
   * grow through the day and are finalized after it.
   */
  replaceDay(source: UsageSource, from: number, to: number, rows: readonly UsageRecordInput[]): { removed: number; added: number } {
    let result = { removed: 0, added: 0 };
    this.db.transaction(() => {
      result = this.reconcile(source, false, this.storedRows(source, false, from, to).map((r) => r.dedupe), rows);
    })();
    return result;
  }

  /** Remove `remove` (and any row being replaced) of `source` with this `synthetic` flag, then insert `upsert`. */
  private reconcile(source: UsageSource, synthetic: boolean, remove: readonly string[], upsert: readonly UsageRecordInput[]): { removed: number; added: number } {
    if (remove.length === 0 && upsert.length === 0) return { removed: 0, added: 0 };
    const get = this.db.prepare("SELECT * FROM usage_records WHERE dedupe = ? AND source = ? AND synthetic = ?");
    const del = this.db.prepare("DELETE FROM usage_records WHERE id = ?");
    const sub = this.db.prepare(`UPDATE usage_hourly SET input = input - ?, output = output - ?, cache_read = cache_read - ?,
        cache_write = cache_write - ?, reasoning = reasoning - ?, cost_usd = cost_usd - ?, unpriced_tokens = unpriced_tokens - ?,
        list_records = list_records - ?, estimate_records = estimate_records - ?, reported_records = reported_records - ?,
        cache_savings_usd = cache_savings_usd - ?, records = records - 1, synthetic_records = synthetic_records - ?
      WHERE hour = ? AND source = ? AND provider = ? AND model = ?`);
    const empty = this.db.prepare("DELETE FROM usage_hourly WHERE hour = ? AND source = ? AND provider = ? AND model = ? AND records <= 0");
    let removed = 0;
    let added = 0;
    this.db.transaction(() => {
      for (const dedupe of new Set([...remove, ...upsert.map((r) => r.dedupe)])) {
        const r = get.get(dedupe, source, synthetic ? 1 : 0) as Record<string, unknown> | null;
        if (r === null) continue;
        const hour = Math.floor(n(r.at) / 3_600_000) * 3_600_000;
        const priced = r.cost_usd !== null && r.cost_basis !== "unknown";
        const tokens = n(r.input) + n(r.output) + n(r.cache_read) + n(r.cache_write);
        sub.run(n(r.input), n(r.output), n(r.cache_read), n(r.cache_write), n(r.reasoning), priced ? n(r.cost_usd) : 0, priced ? 0 : tokens,
          priced && r.cost_basis === "list" ? 1 : 0, priced && r.cost_basis === "estimate" ? 1 : 0, priced && r.cost_basis === "reported" ? 1 : 0,
          n(r.cache_savings_usd), synthetic ? 1 : 0, hour, String(r.source), String(r.provider ?? ""), String(r.model));
        empty.run(hour, String(r.source), String(r.provider ?? ""), String(r.model));
        del.run(n(r.id));
        removed++;
      }
      added = this.insert(upsert.map((r) => ({ ...r, source, synthetic })));
    })();
    return { removed, added };
  }

  private static rowOf(r: Record<string, unknown>): UsageRow {
    return {
      source: r.source as UsageSource, provider: String(r.provider ?? ""), model: String(r.model ?? ""),
      input: n(r.input), output: n(r.output), cacheRead: n(r.cache_read), cacheWrite: n(r.cache_write), reasoning: n(r.reasoning),
      costUsd: n(r.cost_usd), unpricedTokens: n(r.unpriced_tokens), listRecords: n(r.list_records), estimateRecords: n(r.estimate_records),
      reportedRecords: n(r.reported_records),
      cacheSavingsUsd: n(r.cache_savings_usd), records: n(r.records), syntheticRecords: n(r.synthetic_records),
    };
  }

  /** Raw records in [from, to), grouped by `bucketMs` (aligned to `from`) × source × provider × model. For short ranges. */
  recordsGrouped(from: number, to: number, sources: readonly UsageSource[], bucketMs: number): Array<UsageRow & { bucket: number }> {
    if (sources.length === 0) return [];
    const marks = sources.map(() => "?").join(",");
    const rows = this.db.query(`SELECT (? + ((at - ?) / ?) * ?) AS bucket, source, provider, model,
        SUM(input) AS input, SUM(output) AS output, SUM(cache_read) AS cache_read, SUM(cache_write) AS cache_write,
        SUM(COALESCE(reasoning, 0)) AS reasoning, SUM(COALESCE(cost_usd, 0)) AS cost_usd,
        SUM(CASE WHEN cost_usd IS NULL THEN input + output + cache_read + cache_write ELSE 0 END) AS unpriced_tokens,
        SUM(CASE WHEN cost_basis = 'list' THEN 1 ELSE 0 END) AS list_records,
        SUM(CASE WHEN cost_basis = 'estimate' THEN 1 ELSE 0 END) AS estimate_records,
        SUM(CASE WHEN cost_basis = 'reported' THEN 1 ELSE 0 END) AS reported_records,
        SUM(COALESCE(cache_savings_usd, 0)) AS cache_savings_usd, COUNT(*) AS records, SUM(synthetic) AS synthetic_records
      FROM usage_records WHERE at >= ? AND at < ? AND source IN (${marks})
      GROUP BY bucket, source, provider, model`).all(from, from, bucketMs, bucketMs, from, to, ...sources) as Array<Record<string, unknown>>;
    return rows.map((r) => ({ ...UsageDb.rowOf(r), bucket: n(r.bucket) }));
  }

  /** Hourly rollups with hour in [fromHour, to). */
  hourly(fromHour: number, to: number, sources: readonly UsageSource[]): Array<UsageRow & { hour: number }> {
    if (sources.length === 0) return [];
    const marks = sources.map(() => "?").join(",");
    const rows = this.db.query(`SELECT * FROM usage_hourly WHERE hour >= ? AND hour < ? AND source IN (${marks}) ORDER BY hour`)
      .all(fromHour, to, ...sources) as Array<Record<string, unknown>>;
    return rows.map((r) => ({ ...UsageDb.rowOf(r), hour: n(r.hour) }));
  }

  /** The earliest record's time, or undefined for an empty DB. */
  earliest(sources: readonly UsageSource[]): number | undefined {
    if (sources.length === 0) return undefined;
    const marks = sources.map(() => "?").join(",");
    const r = this.db.query(`SELECT MIN(hour) AS h FROM usage_hourly WHERE source IN (${marks})`).get(...sources) as { h: number | null } | null;
    return r?.h ?? undefined;
  }

  /** Summed cost (list + estimate) for records in [from, to) matching a subscription's `covers`. */
  costFor(from: number, to: number, covers: readonly string[]): { costUsd: number; tokens: number; unpricedTokens: number } {
    const clauses: string[] = [];
    const args: Array<string | number> = [from, to];
    for (const c of covers) {
      if (c === "codex" || c === "claude-code" || c === "opencode" || c === "winter") { clauses.push("source = ?"); args.push(c); }
      else if (c.startsWith("winter:")) { clauses.push("(source = 'winter' AND provider = ?)"); args.push(c.slice("winter:".length)); }
    }
    if (clauses.length === 0) return { costUsd: 0, tokens: 0, unpricedTokens: 0 };
    const r = this.db.query(`SELECT SUM(COALESCE(cost_usd, 0)) AS cost, SUM(input + output + cache_read + cache_write) AS tokens,
        SUM(CASE WHEN cost_usd IS NULL THEN input + output + cache_read + cache_write ELSE 0 END) AS unpriced
      FROM usage_records WHERE at >= ? AND at < ? AND (${clauses.join(" OR ")})`).get(...args) as Record<string, unknown> | null;
    return { costUsd: n(r?.cost), tokens: n(r?.tokens), unpricedTokens: n(r?.unpriced) };
  }

  // ── ingest offsets ──────────────────────────────────────────────────────────────────────────────

  fileState(key: string): IngestFileState | undefined {
    const r = this.db.query("SELECT * FROM ingest_files WHERE key = ?").get(key) as Record<string, unknown> | null;
    if (r === null) return undefined;
    let state: Record<string, unknown> = {};
    try { const parsed = JSON.parse(String(r.state)); if (typeof parsed === "object" && parsed !== null) state = parsed; } catch { state = {}; }
    return { key, source: r.source as UsageSource, inode: n(r.inode), offset: n(r.offset), state };
  }

  /** Write a file's read state together with the records read up to it — one transaction, so a crash between never
   *  re-counts (dedupe would catch it anyway) nor skips. */
  commitFile(file: IngestFileState, records: readonly UsageRecordInput[], now: number): number {
    let added = 0;
    this.db.transaction(() => {
      added = this.insert(records);
      this.db.query(`INSERT INTO ingest_files (key, source, inode, offset, state, updated_at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (key) DO UPDATE SET source = excluded.source, inode = excluded.inode, offset = excluded.offset,
          state = excluded.state, updated_at = excluded.updated_at`)
        .run(file.key, file.source, file.inode, file.offset, JSON.stringify(file.state), now);
    })();
    return added;
  }

  /** A source's own progress record (JSON), kept in `ingest_files` under `key` (no file behind it). */
  sourceState(key: string): Record<string, unknown> | undefined {
    return this.fileState(key)?.state;
  }

  setSourceState(key: string, source: UsageSource, state: Record<string, unknown>, now: number): void {
    this.commitFile({ key, source, inode: 0, offset: 0, state }, [], now);
  }

  // ── probe latches ───────────────────────────────────────────────────────────────────────────────

  latch(key: string): { reason: string; at: number } | undefined {
    const r = this.db.query("SELECT reason, at FROM probe_latches WHERE key = ?").get(key) as { reason: string; at: number } | null;
    return r ?? undefined;
  }

  setLatch(key: string, reason: string, at: number): void {
    this.db.query("INSERT INTO probe_latches (key, reason, at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET reason = excluded.reason, at = excluded.at")
      .run(key, reason, at);
  }

  // ── plan alarms ─────────────────────────────────────────────────────────────────────────────────

  private static alarmOf(r: Record<string, unknown>): UsageAlarm | undefined {
    const provider = r.provider === "codex" || r.provider === "claude-code" || r.provider === "antigravity" ? r.provider : undefined;
    if (provider === undefined) return undefined;
    return { id: String(r.id), provider, windowKey: String(r.window_key), thresholdPercent: n(r.threshold), createdAt: n(r.created_at) };
  }

  /** Every ARMED alarm (not fired yet), oldest first — the lines' ticks, the beats, the judging. */
  alarms(): UsageAlarm[] {
    const rows = this.db.query("SELECT * FROM usage_alarms WHERE fired_at IS NULL ORDER BY created_at, id").all() as Array<Record<string, unknown>>;
    return rows.flatMap((r) => { const a = UsageDb.alarmOf(r); return a === undefined ? [] : [a]; });
  }

  /** Every FIRED alarm still waiting for its notice's acknowledgement, in the order they fired. */
  firedAlarms(): FiredUsageAlarm[] {
    const rows = this.db.query("SELECT * FROM usage_alarms WHERE fired_at IS NOT NULL ORDER BY fired_at, id").all() as Array<Record<string, unknown>>;
    return rows.flatMap((r) => {
      const a = UsageDb.alarmOf(r);
      if (a === undefined) return [];
      let notice: Record<string, unknown> = {};
      try { const p = JSON.parse(String(r.notice ?? "{}")); if (typeof p === "object" && p !== null) notice = p; } catch { notice = {}; }
      const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
      const scope = typeof notice.scope === "string" ? notice.scope : undefined;
      const windowMinutes = num(notice.windowMinutes);
      const resetsAt = num(notice.resetsAt);
      return [{
        ...a, firedAt: n(r.fired_at), kind: typeof notice.kind === "string" ? notice.kind : "other", usedPercent: num(notice.usedPercent) ?? a.thresholdPercent,
        ...(scope === undefined ? {} : { scope }), ...(windowMinutes === undefined ? {} : { windowMinutes }), ...(resetsAt === undefined ? {} : { resetsAt }),
      }];
    });
  }

  /** Store an armed alarm; one already armed for the same plan, window and threshold is kept (and answered) instead. */
  addAlarm(a: UsageAlarm): UsageAlarm {
    this.db.query("INSERT OR IGNORE INTO usage_alarms (id, provider, window_key, threshold, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(a.id, a.provider, a.windowKey, a.thresholdPercent, a.createdAt);
    return this.alarms().find((x) => x.provider === a.provider && x.windowKey === a.windowKey && x.thresholdPercent === a.thresholdPercent) ?? a;
  }

  /** Mark an armed alarm fired, with its notice. True only for the call that marked it — a fire happens once, whoever
   *  else read the same reading. */
  fireAlarm(id: string, at: number, notice: UsageAlarmNotice): boolean {
    return this.db.query("UPDATE usage_alarms SET fired_at = ?, notice = ? WHERE id = ? AND fired_at IS NULL")
      .run(at, JSON.stringify(notice), id).changes > 0;
  }

  /** Delete an ARMED alarm (a tick's removal). */
  removeAlarm(id: string): boolean {
    return this.db.query("DELETE FROM usage_alarms WHERE id = ? AND fired_at IS NULL").run(id).changes > 0;
  }

  /** Delete a FIRED alarm: its notice was acknowledged (dismissed, opened, or shown its full time). */
  ackAlarm(id: string): boolean {
    return this.db.query("DELETE FROM usage_alarms WHERE id = ? AND fired_at IS NOT NULL").run(id).changes > 0;
  }

  // ── subscriptions ───────────────────────────────────────────────────────────────────────────────

  subscriptions(): Subscription[] {
    const rows = this.db.query("SELECT * FROM subscriptions ORDER BY created_at, id").all() as Array<Record<string, unknown>>;
    return rows.map((r) => {
      let covers: string[] = [];
      try { const c = JSON.parse(String(r.covers)); if (Array.isArray(c)) covers = c.filter((x): x is string => typeof x === "string"); } catch { covers = []; }
      return {
        id: String(r.id), name: String(r.name), provider: String(r.provider), price: n(r.price), currency: String(r.currency),
        cadence: r.cadence === "yearly" ? "yearly" : "monthly", renewalDay: n(r.renewal_day),
        ...(r.renewal_month === null || r.renewal_month === undefined ? {} : { renewalMonth: n(r.renewal_month) }),
        covers, createdAt: n(r.created_at), updatedAt: n(r.updated_at),
      };
    });
  }

  upsertSubscription(s: Subscription): void {
    this.db.query(`INSERT INTO subscriptions (id, name, provider, price, currency, cadence, renewal_day, renewal_month, covers, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET name = excluded.name, provider = excluded.provider, price = excluded.price,
        currency = excluded.currency, cadence = excluded.cadence, renewal_day = excluded.renewal_day,
        renewal_month = excluded.renewal_month, covers = excluded.covers, updated_at = excluded.updated_at`)
      .run(s.id, s.name, s.provider, s.price, s.currency, s.cadence, s.renewalDay, s.renewalMonth ?? null, JSON.stringify(s.covers), s.createdAt, s.updatedAt);
  }

  removeSubscription(id: string): boolean {
    return this.db.query("DELETE FROM subscriptions WHERE id = ?").run(id).changes > 0;
  }

  close(): void {
    try { this.db.close(); } catch { /* already closed */ }
  }
}
