// Claude Code's `/stats` history (`docs/claude/usage.md`, `usage/claude-stats.ts`): synthetic per-model daily rows for
// the days Winter's transcript ingest cannot cover — the boundary, the no-overlap rule, stable re-imports, the
// calibration, the ratio split and cost math, the size cap, a missing or corrupt file, the tracking switch, and the
// privacy rule (the cache's session id and counters never reach the DB, its WAL, a log line or an RPC answer).
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { UsageDb } from "../../src/usage/db";
import { UsagePricer } from "../../src/usage/pricing";
import { UsageService, type UsageTracking } from "../../src/usage/service";
import { CLAUDE_STATS_FALLBACK_CALIBRATION, CLAUDE_STATS_FILE, parseClaudeStats, splitByRatios } from "../../src/usage/claude-stats";
import { SECRETS, claudeAssistant, claudeTranscriptPath, claudeUser, lines, probeRootIn, tempDir } from "./fixtures";

const pricer = new UsagePricer();
const NOW = Date.UTC(2026, 9, 18, 9, 0, 0); // today (UTC) = 2026-10-18
const at = (day: string, hour = 10): number => Date.parse(`${day}T${String(hour).padStart(2, "0")}:00:00Z`);
const noon = (day: string): number => Date.parse(`${day}T12:00:00Z`);

const A = "claude-sonnet-4-5-20250929";
const B = "claude-opus-4-5-20251101";
const C = "glm-4.6"; // a non-Anthropic model run through Claude Code: no Anthropic price
const D = "kimi-k2-thinking"; // unpriced too, but Claude Code kept a cost for it

const DECOYS = ["DECOY-SESSION-5a5a-longest", "DECOY-OTHER-KEY-77", "2026-01-02T03:04:05.678Z"];

/** A stats cache shaped like Claude Code's (version 5), with decoys in every key Winter must NOT read. */
function statsCache(days: Record<string, Record<string, number>>, opts: { modelUsage?: Record<string, Record<string, number>>; lastComputedDate?: string; v?: number | null } = {}): string {
  return JSON.stringify({
    version: 5, lastComputedDate: opts.lastComputedDate ?? "2026-10-17",
    dailyActivity: Object.keys(days).map((date) => ({ date, messageCount: 5, sessionCount: 1, toolCallCount: 2 })),
    dailyModelTokens: Object.entries(days).map(([date, tokensByModel]) => ({ date, tokensByModel })),
    ...(opts.v === null ? {} : { dailyModelTokensVersion: opts.v ?? 5 }),
    modelUsage: opts.modelUsage ?? {
      [A]: { inputTokens: 1000, outputTokens: 3000, cacheReadInputTokens: 5000, cacheCreationInputTokens: 1000, costUSD: 0, contextWindow: 0, maxOutputTokens: 0, webSearchRequests: 0 },
      [B]: { inputTokens: 100_000, outputTokens: 100_000, cacheReadInputTokens: 700_000, cacheCreationInputTokens: 100_000, costUSD: 5, contextWindow: 0, maxOutputTokens: 0, webSearchRequests: 0 },
      [C]: { inputTokens: 500, outputTokens: 500, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0, contextWindow: 0, maxOutputTokens: 0, webSearchRequests: 0 },
      [D]: { inputTokens: 500_000, outputTokens: 500_000, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 2, contextWindow: 0, maxOutputTokens: 0, webSearchRequests: 0 },
    },
    totalSessions: 42, totalMessages: 4242,
    longestSession: { sessionId: DECOYS[0], duration: 123456, messageCount: 99, timestamp: DECOYS[2] },
    firstSessionDate: DECOYS[2], hourCounts: { "9": 3, "14": 7 }, shotDistribution: {},
    someOtherKey: { note: DECOYS[1], prompt: SECRETS[0] },
  });
}

function setup(opts: { tracking?: UsageTracking; claudeStatsMaxBytes?: number; fileBudgetBytes?: number } = {}) {
  const home = tempDir("home");
  const claudeHome = tempDir("claude");
  const db = new UsageDb(join(home, "usage", "usage.db"));
  const logs: string[] = [];
  const log = (msg: string, meta?: Record<string, unknown>) => { logs.push(meta === undefined ? msg : `${msg} ${JSON.stringify(meta)}`); };
  const tracking = opts.tracking ?? { codex: false, claudeCode: true, antigravity: true, opencode: true };
  const clock = { now: NOW };
  const svc = new UsageService({
    db, pricer, tracking: () => tracking, claudeHome,
    codexExecutable: () => undefined, claudeExecutable: () => undefined, winterCodexWindows: () => [],
    probeRoot: () => probeRootIn(home), ingestEveryMs: 0, now: () => clock.now, log: { warn: log, info: log },
    ...(opts.claudeStatsMaxBytes === undefined ? {} : { claudeStatsMaxBytes: opts.claudeStatsMaxBytes }),
    ...(opts.fileBudgetBytes === undefined ? {} : { fileBudgetBytes: opts.fileBudgetBytes }),
  });
  const statsPath = join(claudeHome, CLAUDE_STATS_FILE);
  return { home, claudeHome, db, svc, logs, tracking, statsPath, clock };
}

type Row = { dedupe: string; at: number; model: string; input: number; output: number; cache_read: number; cache_write: number; cost_usd: number | null; cost_basis: string; synthetic: number; session_id: string | null };
const synthetic = (db: UsageDb): Row[] => db.db.query("SELECT * FROM usage_records WHERE synthetic = 1 ORDER BY at, model").all() as Row[];
const byKey = (db: UsageDb): Map<string, Row> => new Map(synthetic(db).map((r) => [r.dedupe, r]));

/** The rollup must always equal the records it summarizes — after inserts AND removals. */
function expectRollupConsistent(db: UsageDb): void {
  const rec = db.db.query(`SELECT source, model, SUM(input) i, SUM(output) o, SUM(cache_read) cr, SUM(cache_write) cw, COUNT(*) n, SUM(synthetic) s,
    SUM(COALESCE(cost_usd, 0)) c FROM usage_records GROUP BY source, model ORDER BY source, model`).all() as Array<Record<string, number>>;
  const hr = db.db.query(`SELECT source, model, SUM(input) i, SUM(output) o, SUM(cache_read) cr, SUM(cache_write) cw, SUM(records) n, SUM(synthetic_records) s,
    SUM(cost_usd) c FROM usage_hourly GROUP BY source, model HAVING SUM(records) > 0 ORDER BY source, model`).all() as Array<Record<string, number>>;
  expect(hr.map(({ c: _c, ...r }) => r)).toEqual(rec.map(({ c: _c, ...r }) => r));
  for (const [i, r] of rec.entries()) expect(hr[i]!.c!).toBeCloseTo(r.c!, 9);
}

/** Transcript records for model A: one per listed day, `tokens` each (all four kinds, split 10/30/50/10 like A's ratios). */
function transcripts(claudeHome: string, days: string[], tokens = 10_000, model = A, session = "cc-session-1"): void {
  const t = tokens / 10;
  writeFileSync(claudeTranscriptPath(claudeHome, session), lines(...days.flatMap((d, i) => [
    claudeUser(at(d)),
    claudeAssistant(at(d) + 1000, { msgId: `m-${session}-${i}`, requestId: `r-${i}`, sessionId: session, model, input: t, output: 3 * t, cacheRead: 5 * t, cacheWrite: t }),
  ])));
}

describe("the backfill boundary and the row shape", () => {
  test("only days before the first transcript day, before today and up to lastComputedDate; split by all-time ratios; priced", async () => {
    const { db, svc, claudeHome, statsPath } = setup();
    transcripts(claudeHome, ["2026-10-01", "2026-10-05"]);
    writeFileSync(statsPath, statsCache({
      "2026-09-20": { [A]: 20_000 },
      "2026-09-25": { [A]: 10_000, [B]: 100_000, [C]: 3_000, [D]: 100_000 },
      "2026-10-01": { [A]: 10_000 },           // the first transcript day: the transcripts have it
      "2026-10-03": { [B]: 50_000 },           // B has no transcripts, but the day is after the boundary: never imported
      "2026-10-05": { [A]: 10_000 },           // shared with the transcripts at 1:1 — the calibration is 1
      "2026-10-18": { [A]: 1 },                // today: never
    }));
    await svc.ingest(true);
    const rows = byKey(db);
    expect([...rows.keys()].sort()).toEqual([`ccstats:${A}:2026-09-20`, `ccstats:${A}:2026-09-25`, `ccstats:${B}:2026-09-25`, `ccstats:${C}:2026-09-25`, `ccstats:${D}:2026-09-25`].sort());
    const a = rows.get(`ccstats:${A}:2026-09-20`)!;
    expect(a).toMatchObject({ at: noon("2026-09-20"), model: A, input: 2000, output: 6000, cache_read: 10_000, cache_write: 2000, cost_basis: "estimate", session_id: null, synthetic: 1 });
    // costUSD is 0 in Claude Code's cache: the split is priced by the same catalog as the transcripts.
    expect(a.cost_usd!).toBeCloseTo(pricer.price("anthropic", A, { input: 2000, output: 6000, cacheRead: 10_000, cacheWrite: 2000 })!.costUsd, 12);
    // One pricing basis: the catalog, even where Claude Code kept a costUSD (B's would have been 0.5 USD).
    const b = rows.get(`ccstats:${B}:2026-09-25`)!;
    expect(b).toMatchObject({ input: 10_000, output: 10_000, cache_read: 70_000, cache_write: 10_000, cost_basis: "estimate" });
    expect(b.cost_usd!).toBeCloseTo(pricer.price("anthropic", B, { input: 10_000, output: 10_000, cacheRead: 70_000, cacheWrite: 10_000 })!.costUsd, 12);
    expect(b.cost_usd!).not.toBeCloseTo(0.5, 6);
    // costUSD only as the fallback for a model the catalog cannot price: 2 USD × 100k / 1M.
    expect(pricer.price("anthropic", D, { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 })).toBeUndefined();
    const d = rows.get(`ccstats:${D}:2026-09-25`)!;
    expect(d).toMatchObject({ input: 50_000, output: 50_000, cost_basis: "estimate" });
    expect(d.cost_usd!).toBeCloseTo(0.2, 12);
    // A model nothing prices keeps its tokens, unpriced.
    expect(rows.get(`ccstats:${C}:2026-09-25`)).toMatchObject({ input: 1500, output: 1500, cost_usd: null, cost_basis: "unknown" });
    // The transcript rows are untouched; the rollup matches the records.
    expect((db.db.query("SELECT COUNT(*) n FROM usage_records WHERE synthetic = 0").get() as { n: number }).n).toBe(2);
    expectRollupConsistent(db);
  });

  test("no transcripts at all: every computed day before today is history", async () => {
    const { db, svc, statsPath } = setup();
    writeFileSync(statsPath, statsCache({ "2026-09-20": { [A]: 100 }, "2026-10-17": { [A]: 100 }, "2026-10-18": { [A]: 100 } }));
    await svc.ingest(true);
    expect(synthetic(db).map((r) => r.dedupe)).toEqual([`ccstats:${A}:2026-09-20`, `ccstats:${A}:2026-10-17`]);
  });

  test("a day after lastComputedDate is not imported", async () => {
    const { db, svc, statsPath } = setup();
    writeFileSync(statsPath, statsCache({ "2026-09-20": { [A]: 100 }, "2026-09-22": { [A]: 100 } }, { lastComputedDate: "2026-09-21" }));
    await svc.ingest(true);
    expect(synthetic(db).map((r) => r.dedupe)).toEqual([`ccstats:${A}:2026-09-20`]);
  });

  test("the split always sums to the day's tokens", () => {
    const m = { input: 7, output: 13, cacheRead: 101, cacheWrite: 3, costUsd: 0 };
    for (const total of [1, 2, 99, 12_345, 1_000_001]) {
      const s = splitByRatios(total, m)!;
      expect(s.input + s.output + s.cacheRead + s.cacheWrite).toBe(total);
      expect(Math.min(s.input, s.output, s.cacheRead, s.cacheWrite)).toBeGreaterThanOrEqual(0);
    }
    expect(splitByRatios(10, undefined)).toBeUndefined();
    expect(splitByRatios(10, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 })).toBeUndefined();
  });
});

describe("re-imports", () => {
  test("stable: the same file again changes nothing, and is parsed only when its mtime or size changes", async () => {
    const { db, svc, claudeHome, statsPath } = setup();
    transcripts(claudeHome, ["2026-10-01", "2026-10-02"]);
    const shared = { "2026-10-02": { [A]: 10_000 } }; // calibration 1
    writeFileSync(statsPath, statsCache({ "2026-09-20": { [A]: 20_000 }, "2026-09-25": { [B]: 100_000 }, ...shared }));
    await svc.ingest(true);
    const first = synthetic(db);
    expect(first).toHaveLength(2);
    await svc.ingest(true);
    await svc.ingest(true);
    expect(svc.claudeStatsParses).toBe(1);
    // Touched (same bytes): parsed again, nothing rewritten (same row ids).
    utimesSync(statsPath, new Date(NOW), new Date(NOW + 5000));
    await svc.ingest(true);
    expect(svc.claudeStatsParses).toBe(2);
    expect(synthetic(db)).toEqual(first);
    // A changed day replaces its row (never adds a second one).
    writeFileSync(statsPath, statsCache({ "2026-09-20": { [A]: 40_000 }, "2026-09-25": { [B]: 100_000 }, ...shared }));
    await svc.ingest(true);
    const rows = byKey(db);
    expect(rows.size).toBe(2);
    expect(rows.get(`ccstats:${A}:2026-09-20`)).toMatchObject({ input: 4000, output: 12_000, cache_read: 20_000, cache_write: 4000 });
    expectRollupConsistent(db);
  });

  test("a fresh service on the same DB (a restart) re-plans to the same rows", async () => {
    const env = setup();
    transcripts(env.claudeHome, ["2026-10-01"]);
    writeFileSync(env.statsPath, statsCache({ "2026-09-20": { [A]: 20_000 } }));
    await env.svc.ingest(true);
    const before = synthetic(env.db);
    const svc2 = new UsageService({
      db: env.db, pricer, tracking: () => env.tracking, claudeHome: env.claudeHome, codexExecutable: () => undefined, claudeExecutable: () => undefined,
      winterCodexWindows: () => [], probeRoot: () => probeRootIn(env.home), ingestEveryMs: 0, now: () => NOW,
    });
    await svc2.ingest(true);
    expect(synthetic(env.db)).toEqual(before);
  });
});

describe("never counted twice", () => {
  test("transcripts reaching an earlier day take it over: that day's synthetic rows go, the rest stay", async () => {
    const { db, svc, claudeHome, statsPath } = setup();
    transcripts(claudeHome, ["2026-10-01"]);
    writeFileSync(statsPath, statsCache({ "2026-09-20": { [A]: 20_000 }, "2026-09-25": { [A]: 10_000, [B]: 100_000 } }));
    await svc.ingest(true);
    expect(synthetic(db)).toHaveLength(3);
    // An older transcript turns up (a resumed session's file survived): 09-25 is now covered by transcripts.
    transcripts(claudeHome, ["2026-09-25"], 10_000, A, "cc-session-old");
    await svc.ingest(true);
    expect(synthetic(db).map((r) => r.dedupe)).toEqual([`ccstats:${A}:2026-09-20`]);
    expectRollupConsistent(db);
    // The covered day is counted once: only the transcript's tokens.
    const day = db.db.query("SELECT SUM(input + output + cache_read + cache_write) t FROM usage_records WHERE at >= ? AND at < ?")
      .get(Date.parse("2026-09-25T00:00:00Z"), Date.parse("2026-09-26T00:00:00Z")) as { t: number };
    expect(day.t).toBe(10_000);
  });

  test("a day Claude Code's cache stops listing keeps its imported row (history is never dropped)", async () => {
    const { db, svc, statsPath } = setup();
    writeFileSync(statsPath, statsCache({ "2026-09-20": { [A]: 20_000 }, "2026-09-25": { [A]: 10_000 } }));
    await svc.ingest(true);
    writeFileSync(statsPath, statsCache({ "2026-09-25": { [A]: 10_000 } }) + " ");
    await svc.ingest(true);
    expect(synthetic(db).map((r) => r.dedupe)).toEqual([`ccstats:${A}:2026-09-20`, `ccstats:${A}:2026-09-25`]);
  });

  test("the import waits for a chunked transcript import to finish (its boundary is the first transcript day)", async () => {
    const { db, svc, claudeHome, statsPath } = setup({ fileBudgetBytes: 1000 });
    transcripts(claudeHome, ["2026-10-01", "2026-10-02", "2026-10-03"]);
    writeFileSync(statsPath, statsCache({ "2026-09-20": { [A]: 20_000 } }));
    await svc.ingest(true);
    expect(synthetic(db)).toHaveLength(0);
    await svc.catchUp();
    expect(synthetic(db).map((r) => r.dedupe)).toEqual([`ccstats:${A}:2026-09-20`]);
  });
});

describe("calibration and day semantics", () => {
  test("Claude Code counting 3× what the deduped transcripts hold over the shared days scales the history by ⅓", async () => {
    const { db, svc, claudeHome, statsPath } = setup();
    transcripts(claudeHome, ["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"]);
    writeFileSync(statsPath, statsCache({
      "2026-09-20": { [A]: 30_000 },
      "2026-10-01": { [A]: 30_000 }, // the boundary day itself is not used (it may be partial)
      "2026-10-02": { [A]: 30_000 }, "2026-10-03": { [A]: 30_000 }, "2026-10-04": { [A]: 30_000 },
    }));
    await svc.ingest(true);
    expect(byKey(db).get(`ccstats:${A}:2026-09-20`)).toMatchObject({ input: 1000, output: 3000, cache_read: 5000, cache_write: 1000 });
  });

  test("a model with no shared days takes the factor of all models; the factor never inflates", async () => {
    const { db, svc, claudeHome, statsPath } = setup();
    transcripts(claudeHome, ["2026-10-01", "2026-10-02"]);
    writeFileSync(statsPath, statsCache({ "2026-09-20": { [B]: 100_000 }, "2026-10-02": { [A]: 20_000 } }));
    await svc.ingest(true);
    expect(byKey(db).get(`ccstats:${B}:2026-09-20`)).toMatchObject({ input: 5000, output: 5000, cache_read: 35_000, cache_write: 5000 });
    // Transcripts holding MORE than the cache: factor 1, not above.
    const env = setup();
    transcripts(env.claudeHome, ["2026-10-01", "2026-10-02"], 50_000);
    writeFileSync(env.statsPath, statsCache({ "2026-09-20": { [A]: 10_000 }, "2026-10-02": { [A]: 10_000 } }));
    await env.svc.ingest(true);
    expect(byKey(env.db).get(`ccstats:${A}:2026-09-20`)).toMatchObject({ input: 1000, output: 3000, cache_read: 5000, cache_write: 1000 });
  });

  test("a model's own factor needs a settled number of shared days; until then it takes the factor of all models", async () => {
    const env = setup();
    const week = ["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08"];
    transcripts(env.claudeHome, week, 10_000); // A: 7 comparable days (the first is the first transcript day) at ½
    transcripts(env.claudeHome, ["2026-10-07", "2026-10-08"], 10_000, B, "cc-b"); // B: 2 days at ¼
    writeFileSync(env.statsPath, statsCache({
      "2026-09-10": { [A]: 100_000, [B]: 100_000 },
      ...Object.fromEntries(week.map((d) => [d, { [A]: 20_000, ...(d >= "2026-10-07" ? { [B]: 40_000 } : {}) }])),
    }));
    await env.svc.ingest(true);
    const t = (m: string): number => { const r = byKey(env.db).get(`ccstats:${m}:2026-09-10`)!; return r.input + r.output + r.cache_read + r.cache_write; };
    expect(t(A)).toBe(50_000); // its own ½
    expect(t(B)).toBe(Math.round(100_000 * (90_000 / 220_000))); // all pairs: (70k + 20k) / (140k + 80k)
  });

  test("an older cache (dailyModelTokensVersion < 5) counted input + output only: scaled to all four kinds", async () => {
    const { db, svc, claudeHome, statsPath } = setup();
    transcripts(claudeHome, ["2026-10-01", "2026-10-02"]);
    // 10-02: the transcripts' 4000 input + output against the cache's 4000 → 1.
    writeFileSync(statsPath, statsCache({ "2026-09-20": { [A]: 4000 }, "2026-10-02": { [A]: 4000 } }, { v: null }));
    await svc.ingest(true);
    expect(byKey(db).get(`ccstats:${A}:2026-09-20`)).toMatchObject({ input: 1000, output: 3000, cache_read: 5000, cache_write: 1000 });
  });

  test("no day both cover: Claude Code's per-line figure is scaled by the fallback calibration, not taken as is", async () => {
    const { db, svc, statsPath } = setup();
    writeFileSync(statsPath, statsCache({ "2026-09-20": { [A]: 20_000 } }));
    await svc.ingest(true);
    const tokens = Math.round(20_000 * CLAUDE_STATS_FALLBACK_CALIBRATION);
    const split = splitByRatios(tokens, { input: 1000, output: 3000, cacheRead: 5000, cacheWrite: 1000, costUsd: 0 })!;
    expect(byKey(db).get(`ccstats:${A}:2026-09-20`)).toMatchObject({ input: split.input, output: split.output, cache_read: split.cacheRead, cache_write: split.cacheWrite });
  });
});

describe("a missing, corrupt or oversized file; the tracking switch", () => {
  test("missing: nothing, no error", async () => {
    const { db, svc, logs } = setup();
    await svc.ingest(true);
    expect(synthetic(db)).toHaveLength(0);
    expect(svc.claudeStatsParses).toBe(0);
    expect(logs.filter((l) => l.includes("stats"))).toEqual([]);
  });

  test("corrupt: nothing imported, existing rows kept, one log line; a repaired file imports", async () => {
    const { db, svc, logs, statsPath } = setup();
    writeFileSync(statsPath, statsCache({ "2026-09-20": { [A]: 100 } }));
    await svc.ingest(true);
    expect(synthetic(db)).toHaveLength(1);
    writeFileSync(statsPath, "{\"dailyModelTokens\": [ broken");
    await svc.ingest(true);
    writeFileSync(statsPath, "{\"dailyModelTokens\": \"not an array\"}");
    await svc.ingest(true);
    expect(synthetic(db)).toHaveLength(1);
    expect(logs.filter((l) => l.includes("could not be read"))).toHaveLength(1);
    writeFileSync(statsPath, statsCache({ "2026-09-20": { [A]: 100 }, "2026-09-21": { [A]: 100 } }));
    await svc.ingest(true);
    expect(synthetic(db)).toHaveLength(2);
  });

  test("over the size cap: never parsed, one log line", async () => {
    const { db, svc, logs, statsPath } = setup({ claudeStatsMaxBytes: 512 });
    writeFileSync(statsPath, statsCache({ "2026-09-20": { [A]: 100 } }));
    await svc.ingest(true);
    utimesSync(statsPath, new Date(NOW), new Date(NOW + 7000));
    await svc.ingest(true);
    expect(svc.claudeStatsParses).toBe(0);
    expect(synthetic(db)).toHaveLength(0);
    expect(logs.filter((l) => l.includes("over the size cap"))).toHaveLength(1);
  });

  test("Claude Code tracking off: the file is not read; rows already imported stay", async () => {
    const { db, svc, statsPath, tracking } = setup();
    writeFileSync(statsPath, statsCache({ "2026-09-20": { [A]: 100 } }));
    tracking.claudeCode = false;
    await svc.ingest(true);
    expect(svc.claudeStatsParses).toBe(0);
    expect(synthetic(db)).toHaveLength(0);
    tracking.claudeCode = true;
    await svc.ingest(true);
    expect(synthetic(db)).toHaveLength(1);
    tracking.claudeCode = false;
    writeFileSync(statsPath, statsCache({ "2026-09-20": { [A]: 100 }, "2026-09-21": { [A]: 100 } }));
    await svc.ingest(true);
    expect(svc.claudeStatsParses).toBe(1);
    expect(synthetic(db)).toHaveLength(1);
  });
});

describe("the answers", () => {
  test("model rows count their synthetic records; history says where Claude Code's /stats history ends", async () => {
    const { svc, claudeHome, statsPath } = setup();
    transcripts(claudeHome, ["2026-10-01"]);
    writeFileSync(statsPath, statsCache({ "2026-09-20": { [A]: 20_000 }, "2026-09-25": { [A]: 10_000 } }));
    await svc.ingest(true);
    const series = svc.series("all");
    const row = series.models.find((m) => m.source === "claude-code" && m.model === A)!;
    expect(row).toMatchObject({ records: 3, syntheticRecords: 2, costBasis: "estimate" });
    expect(series.history).toEqual({ claudeCodeStats: { from: noon("2026-09-20"), before: noon("2026-10-01") } });
    const summary = await svc.summary("30d", undefined, { plans: false });
    expect(summary.history.claudeCodeStats?.before).toBe(noon("2026-10-01"));
    expect(summary.bySource.find((s) => s.source === "claude-code")!.syntheticRecords).toBe(2);
  });

  test("no history imported: no history answer", async () => {
    const { svc } = setup();
    expect(svc.series("all").history).toEqual({});
  });
});

describe("privacy", () => {
  test("the cache's session id, counters and unlisted keys never reach the DB, its WAL, a log line or an answer", async () => {
    const { db, svc, logs, claudeHome, statsPath } = setup();
    transcripts(claudeHome, ["2026-10-01"]);
    writeFileSync(statsPath, statsCache({ "2026-09-20": { [A]: 20_000 }, "2026-09-25": { [B]: 100_000 } }));
    await svc.ingest(true);
    expect(synthetic(db)).toHaveLength(2);
    const parsed = parseClaudeStats(readFileSync(statsPath, "utf8"))!;
    expect(JSON.stringify([...parsed.days], (_k, v) => (v instanceof Map ? [...v] : v))).not.toContain("DECOY");
    const answer = JSON.stringify([await svc.summary("all", undefined, { plans: false }), svc.series("all"), svc.history()]);
    const path = db.path;
    db.close();
    const bytes = [readFileSync(path), ...(existsSync(`${path}-wal`) ? [readFileSync(`${path}-wal`)] : [])].map((b) => b.toString("latin1")).join("");
    for (const secret of [...DECOYS, ...SECRETS, claudeHome, "someone"]) {
      expect(bytes.includes(secret)).toBe(false);
      expect(answer.includes(secret)).toBe(false);
      for (const l of logs) expect(l.includes(secret)).toBe(false);
    }
  });
});

describe("schema 3", () => {
  test("a schema-2 usage.db migrates: its rows kept, all transcript-derived (synthetic = 0)", () => {
    const home = tempDir("migrate");
    const path = join(home, "usage", "usage.db");
    let db = new UsageDb(path);
    db.insert([{ dedupe: "cc:m1:r1", source: "claude-code", at: NOW, provider: "anthropic", model: A, input: 1, output: 2, cacheRead: 3, cacheWrite: 4, costBasis: "unknown" }]);
    // Back to what schema 2 had.
    db.db.run("DROP INDEX usage_records_source_synthetic_at");
    db.db.run("ALTER TABLE usage_records DROP COLUMN synthetic");
    db.db.run("ALTER TABLE usage_hourly DROP COLUMN synthetic_records");
    db.db.run("ALTER TABLE usage_hourly DROP COLUMN reported_records");
    db.db.run("PRAGMA user_version = 2");
    db.close();
    db = new UsageDb(path);
    expect(db.schemaVersion()).toBe(5);
    expect(db.db.query("SELECT dedupe, synthetic FROM usage_records").all()).toEqual([{ dedupe: "cc:m1:r1", synthetic: 0 }]);
    expect(db.earliestReal("claude-code")).toBe(NOW);
    expect(db.hourly(0, NOW + 1, ["claude-code"])[0]).toMatchObject({ records: 1, syntheticRecords: 0 });
    db.close();
  });
});

describe("review fixes: transcripts win whatever the stats file's state; stable across days", () => {
  for (const damage of ["deleted", "corrupt", "over the cap"] as const) {
    test(`stats file ${damage} after an import, then an older transcript appears: that day counted once`, async () => {
      const env = setup({ claudeStatsMaxBytes: damage === "over the cap" ? 64 * 1024 : undefined });
      transcripts(env.claudeHome, ["2026-10-01"]);
      writeFileSync(env.statsPath, statsCache({ "2026-09-20": { [A]: 20_000 }, "2026-09-25": { [A]: 10_000 } }));
      await env.svc.ingest(true);
      expect(synthetic(env.db)).toHaveLength(2);
      if (damage === "deleted") rmSync(env.statsPath);
      else if (damage === "corrupt") writeFileSync(env.statsPath, "{ not json");
      else writeFileSync(env.statsPath, "x".repeat(64 * 1024 + 1));
      transcripts(env.claudeHome, ["2026-09-25"], 10_000, A, "cc-session-old");
      await env.svc.ingest(true);
      expect(synthetic(env.db).map((r) => r.dedupe)).toEqual([`ccstats:${A}:2026-09-20`]);
      expectRollupConsistent(env.db);
      const day = env.db.db.query("SELECT SUM(input + output + cache_read + cache_write) t FROM usage_records WHERE at >= ? AND at < ?")
        .get(Date.parse("2026-09-25T00:00:00Z"), Date.parse("2026-09-26T00:00:00Z")) as { t: number };
      expect(day.t).toBe(10_000);
      // The footnote's date is the first transcript day.
      expect(env.svc.history().claudeCodeStats?.before).toBe(noon("2026-09-25"));
    });
  }

  test("a chunked transcript import still removes the synthetic rows of days it has already reached", async () => {
    const env = setup({ fileBudgetBytes: 1000 });
    transcripts(env.claudeHome, ["2026-10-01"]);
    writeFileSync(env.statsPath, statsCache({ "2026-09-20": { [A]: 20_000 }, "2026-09-25": { [A]: 10_000 } }));
    await env.svc.catchUp();
    expect(synthetic(env.db)).toHaveLength(2);
    // An older session's file: its first line (09-25) is read on the first pass; the rest waits for later passes.
    transcripts(env.claudeHome, ["2026-09-25", "2026-09-26", "2026-09-27", "2026-09-28"], 10_000, A, "cc-session-old");
    await env.svc.ingest(true);
    // Still chunked: not every record of the older file is in yet.
    expect((env.db.db.query("SELECT COUNT(*) n FROM usage_records WHERE synthetic = 0").get() as { n: number }).n).toBeLessThan(5);
    expect(synthetic(env.db).map((r) => r.dedupe)).toEqual([`ccstats:${A}:2026-09-20`]);
  });

  test("a new day alone neither re-parses nor re-plans (rows stay put)", async () => {
    const env = setup();
    transcripts(env.claudeHome, ["2026-10-01", "2026-10-02"]);
    writeFileSync(env.statsPath, statsCache({ "2026-09-20": { [A]: 20_000 }, "2026-10-02": { [A]: 20_000 } }));
    await env.svc.ingest(true);
    const before = synthetic(env.db);
    const logsBefore = env.logs.length;
    for (let d = 1; d <= 40; d++) { env.clock.now = NOW + d * 86_400_000; await env.svc.ingest(true); }
    expect(env.svc.claudeStatsParses).toBe(1);
    expect(synthetic(env.db)).toEqual(before);
    expect(env.logs.length).toBe(logsBefore);
  });

  test("calibration compares the SAME (model, day) pairs: a stats day the transcripts lack does not dilute it", async () => {
    const env = setup();
    transcripts(env.claudeHome, ["2026-10-01", "2026-10-02"]);
    writeFileSync(env.statsPath, statsCache({
      "2026-09-20": { [A]: 30_000 },
      "2026-10-02": { [A]: 30_000 },                // shared: ours 10k vs theirs 30k → ⅓
      "2026-10-03": { [A]: 30_000 }, "2026-10-04": { [A]: 30_000, [B]: 50_000 }, // no transcripts: not compared
    }));
    await env.svc.ingest(true);
    expect(byKey(env.db).get(`ccstats:${A}:2026-09-20`)).toMatchObject({ input: 1000, output: 3000, cache_read: 5000, cache_write: 1000 });
  });
});

describe("partial days: Claude Code's cleanup emptied them before Winter read them", () => {
  // A fresh DB's first read is NOW (2026-10-18 09:00 UTC): with the 30-day retention, 09-18 and every day before it are
  // partial; 09-19 on was read while all of its transcripts were still on disk.
  const A_SPLIT = { input: 1000, output: 3000, cacheRead: 5000, cacheWrite: 1000, costUsd: 0 };
  const total = (r: Row | undefined): number => (r === undefined ? 0 : r.input + r.output + r.cache_read + r.cache_write);
  const state = (db: UsageDb): Record<string, unknown> => db.sourceState("claude-code:stats-history") ?? {};

  /** Recent complete days at half Claude Code's figure (the calibration: ½ over four shared days), one resumed session
   *  that survived with a line on 09-10, and a complete day OUTSIDE the calibration window holding a tenth. */
  function scene() {
    const env = setup();
    transcripts(env.claudeHome, ["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"], 10_000);
    transcripts(env.claudeHome, ["2026-09-10"], 2_000, A, "cc-resumed");
    transcripts(env.claudeHome, ["2026-09-19"], 2_000, A, "cc-low-day");
    const cache = {
      "2026-09-10": { [A]: 30_000 }, "2026-09-12": { [A]: 10_000 }, "2026-09-19": { [A]: 20_000 },
      "2026-10-01": { [A]: 20_000 }, "2026-10-02": { [A]: 20_000 }, "2026-10-03": { [A]: 20_000 }, "2026-10-04": { [A]: 20_000 },
    };
    writeFileSync(env.statsPath, statsCache(cache));
    return { ...env, cache };
  }

  test("a partial day gets only what its surviving transcripts lack; a complete day, however low, gets nothing", async () => {
    const { db, svc } = scene();
    await svc.ingest(true);
    const rows = byKey(db);
    expect([...rows.keys()].sort()).toEqual([`ccstats:${A}:2026-09-10`, `ccstats:${A}:2026-09-12`]);
    // 09-10: ½ × 30k = 15k in all, 2k of it in the resumed session's transcript → 13k estimated.
    const s = splitByRatios(13_000, A_SPLIT)!;
    expect(rows.get(`ccstats:${A}:2026-09-10`)).toMatchObject({ input: s.input, output: s.output, cache_read: s.cacheRead, cache_write: s.cacheWrite });
    expect(total(rows.get(`ccstats:${A}:2026-09-12`))).toBe(5_000);
    // The day itself is counted once: transcript + estimate = the calibrated figure.
    const day = db.db.query("SELECT SUM(input + output + cache_read + cache_write) t FROM usage_records WHERE at >= ? AND at < ?")
      .get(Date.parse("2026-09-10T00:00:00Z"), Date.parse("2026-09-11T00:00:00Z")) as { t: number };
    expect(day.t).toBe(15_000);
    // The footnote: the first day read in full.
    expect(svc.history().claudeCodeStats?.before).toBe(noon("2026-09-19"));
    expectRollupConsistent(db);
  });

  test("a late transcript row on a partial day shrinks its row; the same inputs again write nothing", async () => {
    const { db, svc, claudeHome, logs } = scene();
    await svc.ingest(true);
    transcripts(claudeHome, ["2026-09-12"], 1_000, A, "cc-surfaced");
    await svc.ingest(true);
    expect(total(byKey(db).get(`ccstats:${A}:2026-09-12`))).toBe(4_000);
    const before = synthetic(db);
    const logged = logs.length;
    await svc.ingest(true);
    await svc.ingest(true);
    expect(synthetic(db)).toEqual(before);
    expect(logs.length).toBe(logged);
    expectRollupConsistent(db);
  });

  test("a partial day its transcripts reach in full loses its row (never counted twice)", async () => {
    const { db, svc, claudeHome } = scene();
    await svc.ingest(true);
    transcripts(claudeHome, ["2026-09-12"], 6_000, A, "cc-surfaced");
    await svc.ingest(true);
    expect(byKey(db).has(`ccstats:${A}:2026-09-12`)).toBe(false);
    expectRollupConsistent(db);
  });

  test("Claude Code's cache shrinking or dropping a day (a rebuild from the transcripts left) keeps the estimate", async () => {
    const { db, svc, statsPath, cache } = scene();
    await svc.ingest(true);
    const before = synthetic(db);
    const { "2026-09-12": _gone, ...rest } = cache;
    writeFileSync(statsPath, statsCache({ ...rest, "2026-09-10": { [A]: 4_000 } }));
    await svc.ingest(true);
    expect(svc.claudeStatsParses).toBe(2);
    expect(synthetic(db)).toEqual(before);
  });

  test("Winter's first read is remembered: a restart days later keeps the boundary", async () => {
    const env = scene();
    await env.svc.ingest(true);
    const before = synthetic(env.db);
    expect(state(env.db).firstPassAt).toBe(NOW);
    const later = NOW + 10 * 86_400_000;
    const svc2 = new UsageService({
      db: env.db, pricer, tracking: () => env.tracking, claudeHome: env.claudeHome, codexExecutable: () => undefined, claudeExecutable: () => undefined,
      winterCodexWindows: () => [], probeRoot: () => probeRootIn(env.home), ingestEveryMs: 0, now: () => later,
    });
    // Claude Code's cleanup takes the resumed session's file: its rows are Winter's already.
    rmSync(claudeTranscriptPath(env.claudeHome, "cc-resumed"));
    await svc2.ingest(true);
    expect(synthetic(env.db)).toEqual(before);
    expect(state(env.db).firstPassAt).toBe(NOW);
    expect(svc2.history().claudeCodeStats?.before).toBe(noon("2026-09-19"));
  });

  test("a DB from before the note: the first read is the oldest file read-state", async () => {
    const env = scene();
    await env.svc.ingest(true);
    // Back to a DB with no note, its files first read five days earlier (09-13 is then the last partial day).
    env.db.db.run("DELETE FROM ingest_files WHERE key = 'claude-code:stats-history'");
    env.db.db.run(`UPDATE ingest_files SET updated_at = ${NOW - 5 * 86_400_000} WHERE source = 'claude-code'`);
    const svc2 = new UsageService({
      db: env.db, pricer, tracking: () => env.tracking, claudeHome: env.claudeHome, codexExecutable: () => undefined, claudeExecutable: () => undefined,
      winterCodexWindows: () => [], probeRoot: () => probeRootIn(env.home), ingestEveryMs: 0, now: () => NOW,
    });
    await svc2.ingest(true);
    expect(state(env.db).firstPassAt).toBe(NOW - 5 * 86_400_000);
    expect(svc2.history().claudeCodeStats?.before).toBe(noon("2026-09-14"));
    expect([...byKey(env.db).keys()].sort()).toEqual([`ccstats:${A}:2026-09-10`, `ccstats:${A}:2026-09-12`]);
  });

  test("Winter away longer than the retention: the days in between become partial and are estimated", async () => {
    const env = scene();
    await env.svc.ingest(true);
    // 45 days later. Claude Code ran on 10-22 meanwhile; its cleanup took those transcripts before Winter came back.
    env.clock.now = NOW + 45 * 86_400_000; // 2026-12-02
    transcripts(env.claudeHome, ["2026-11-25", "2026-11-26", "2026-11-27", "2026-11-28"], 10_000, A, "cc-back");
    writeFileSync(env.statsPath, statsCache({
      ...env.cache, "2026-10-22": { [A]: 8_000 },
      "2026-11-25": { [A]: 20_000 }, "2026-11-26": { [A]: 20_000 }, "2026-11-27": { [A]: 20_000 }, "2026-11-28": { [A]: 20_000 },
    }, { lastComputedDate: "2026-12-01" }));
    await env.svc.ingest(true);
    expect(state(env.db).gaps).toEqual([["2026-10-18", "2026-11-02"]]);
    expect(total(byKey(env.db).get(`ccstats:${A}:2026-10-22`))).toBe(4_000);
    // Days read in full before Winter left are untouched.
    expect(byKey(env.db).has(`ccstats:${A}:2026-10-02`)).toBe(false);
  });

  test("an estimate on few shared days is re-calibrated as more arrive, then kept once settled", async () => {
    const env = setup();
    transcripts(env.claudeHome, ["2026-10-01", "2026-10-02"], 10_000);
    writeFileSync(env.statsPath, statsCache({ "2026-09-10": { [A]: 30_000 }, "2026-10-02": { [A]: 10_000 } })); // 1 day at 1
    await env.svc.ingest(true);
    expect(total(byKey(env.db).get(`ccstats:${A}:2026-09-10`))).toBe(30_000);
    // Seven more shared days at ½: (10k + 70k) / (10k + 140k) over 8 days — settled.
    const days = ["2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09"];
    transcripts(env.claudeHome, days, 10_000, A, "cc-more");
    const more = Object.fromEntries(days.map((d) => [d, { [A]: 20_000 }]));
    writeFileSync(env.statsPath, statsCache({ "2026-09-10": { [A]: 30_000 }, "2026-10-02": { [A]: 10_000 }, ...more }));
    await env.svc.ingest(true);
    const settled = Math.round(30_000 * (80_000 / 150_000));
    expect(total(byKey(env.db).get(`ccstats:${A}:2026-09-10`))).toBe(settled);
    // More days at ¼ move the factor, not the settled estimate.
    const late = ["2026-10-10", "2026-10-11", "2026-10-12"];
    transcripts(env.claudeHome, late, 5_000, A, "cc-late");
    writeFileSync(env.statsPath, statsCache({ "2026-09-10": { [A]: 30_000 }, "2026-10-02": { [A]: 10_000 }, ...more, ...Object.fromEntries(late.map((d) => [d, { [A]: 20_000 }])) }));
    await env.svc.ingest(true);
    expect(total(byKey(env.db).get(`ccstats:${A}:2026-09-10`))).toBe(settled);
  });
});
