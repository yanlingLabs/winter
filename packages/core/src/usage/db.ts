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

export const USAGE_DB_SCHEMA_VERSION = 1;

export type UsageSource = "winter" | "codex" | "claude-code";
export const USAGE_SOURCES: readonly UsageSource[] = ["winter", "codex", "claude-code"];

/** How a record's cost was reached: the runtime's own list price, Winter's list-price estimate from the catalog (a
 *  subscription row, or another app's usage), or no price at all. */
export type CostBasis = "list" | "estimate" | "unknown";

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
  cacheSavingsUsd: number;
  records: number;
}

export interface IngestFileState {
  key: string;
  source: UsageSource;
  inode: number;
  offset: number;
  /** Source-specific carry-over (JSON): Codex's last cumulative totals, model, session id. */
  state: Record<string, unknown>;
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
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA busy_timeout = 2000");
    this.db.run("PRAGMA synchronous = NORMAL");
    this.migrate();
  }

  schemaVersion(): number {
    return this.db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0;
  }

  private migrate(): void {
    const v = this.schemaVersion();
    if (v > USAGE_DB_SCHEMA_VERSION) throw new Error(`usage.db is schema ${v}, newer than this Winter (${USAGE_DB_SCHEMA_VERSION})`);
    if (v === USAGE_DB_SCHEMA_VERSION) return;
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
      this.db.run(`PRAGMA user_version = ${USAGE_DB_SCHEMA_VERSION}`);
    })();
  }

  /** Insert records (in one transaction); a record whose `dedupe` is known is skipped. Returns how many were new. */
  insert(records: readonly UsageRecordInput[]): number {
    if (records.length === 0) return 0;
    const ins = this.db.prepare(`INSERT OR IGNORE INTO usage_records
      (dedupe, source, at, session_id, mode, provider, model, input, output, cache_read, cache_write, reasoning, cost_usd, cost_basis, cache_savings_usd)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const roll = this.db.prepare(`INSERT INTO usage_hourly
      (hour, source, provider, model, input, output, cache_read, cache_write, reasoning, cost_usd, unpriced_tokens, list_records, estimate_records, cache_savings_usd, records)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT (hour, source, provider, model) DO UPDATE SET
        input = input + excluded.input, output = output + excluded.output,
        cache_read = cache_read + excluded.cache_read, cache_write = cache_write + excluded.cache_write,
        reasoning = reasoning + excluded.reasoning, cost_usd = cost_usd + excluded.cost_usd,
        unpriced_tokens = unpriced_tokens + excluded.unpriced_tokens,
        list_records = list_records + excluded.list_records, estimate_records = estimate_records + excluded.estimate_records,
        cache_savings_usd = cache_savings_usd + excluded.cache_savings_usd, records = records + 1`);
    let added = 0;
    this.db.transaction(() => {
      for (const r of records) {
        const priced = r.costUsd !== undefined && r.costBasis !== "unknown";
        const res = ins.run(r.dedupe, r.source, Math.round(r.at), r.sessionId ?? null, r.mode ?? null, r.provider ?? "", r.model,
          r.input, r.output, r.cacheRead, r.cacheWrite, r.reasoning ?? null, priced ? r.costUsd! : null, priced ? r.costBasis : "unknown",
          r.cacheSavingsUsd ?? null);
        if (res.changes === 0) continue;
        added++;
        const hour = Math.floor(r.at / 3_600_000) * 3_600_000;
        const tokens = r.input + r.output + r.cacheRead + r.cacheWrite;
        roll.run(hour, r.source, r.provider ?? "", r.model, r.input, r.output, r.cacheRead, r.cacheWrite, r.reasoning ?? 0,
          priced ? r.costUsd! : 0, priced ? 0 : tokens, priced && r.costBasis === "list" ? 1 : 0, priced && r.costBasis === "estimate" ? 1 : 0,
          r.cacheSavingsUsd ?? 0);
      }
    })();
    return added;
  }

  private static rowOf(r: Record<string, unknown>): UsageRow {
    return {
      source: r.source as UsageSource, provider: String(r.provider ?? ""), model: String(r.model ?? ""),
      input: n(r.input), output: n(r.output), cacheRead: n(r.cache_read), cacheWrite: n(r.cache_write), reasoning: n(r.reasoning),
      costUsd: n(r.cost_usd), unpricedTokens: n(r.unpriced_tokens), listRecords: n(r.list_records), estimateRecords: n(r.estimate_records),
      cacheSavingsUsd: n(r.cache_savings_usd), records: n(r.records),
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
        SUM(COALESCE(cache_savings_usd, 0)) AS cache_savings_usd, COUNT(*) AS records
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
      if (c === "codex" || c === "claude-code" || c === "winter") { clauses.push("source = ?"); args.push(c); }
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
