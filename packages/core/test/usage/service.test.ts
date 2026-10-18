// The usage service's own logic (`docs/claude/usage.md`): Winter's per-model turn capture (the projector's pure
// delta and the record), ranges and rollups, and the subscriptions tracker.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadCatalog } from "@yanlinglabs/winter-provider-catalog";
import { UsageDb } from "../../src/usage/db";
import { UsagePricer } from "../../src/usage/pricing";
import { UsageService, rangeWindow, subscriptionCycle } from "../../src/usage/service";
import { turnModelUsageOf, type LedgerSnapshot } from "../../src/projector/terminal";
import { tempDir } from "./fixtures";
import { accept, assistantText, init, makeProjector, modelUsage, result } from "../projector/harness";

const pricer = new UsagePricer();

function service(now: () => number) {
  const home = tempDir("home");
  const db = new UsageDb(join(home, "usage", "usage.db"));
  const svc = new UsageService({
    db, pricer, tracking: () => ({ codex: false, claudeCode: false }), codexExecutable: () => undefined, claudeExecutable: () => undefined,
    winterCodexWindows: () => [], neutralCwd: () => home, now,
  });
  return { db, svc };
}

describe("turnModelUsageOf (the projector's per-model turn figures)", () => {
  const row = (input: number, output: number, cacheRead: number, cacheWrite: number, cost: number, priced: boolean) => ({
    inputTokens: input, outputTokens: output, cacheReadInputTokens: cacheRead, cacheCreationInputTokens: cacheWrite, webSearchRequests: 0,
    costUSD: cost, canonicalModel: "x", provider: "anthropic", ...(priced ? { costBasis: "list" } : {}),
  });
  test("each row's delta against the previous result, the runtime's price kept only for a priced row", () => {
    const r1 = { type: "result", subtype: "success", modelUsage: { "anthropic/claude-sonnet-4.5": row(100, 10, 1000, 50, 0.01, true), "codex-oauth/gpt-6-sol": row(20, 2, 0, 0, 0, false) } };
    const a = turnModelUsageOf(r1 as never, new Map());
    expect(a.rows).toEqual([
      { model: "anthropic/claude-sonnet-4.5", canonicalModel: "x", provider: "anthropic", inputTokens: 100, outputTokens: 10, cacheReadTokens: 1000, cacheWriteTokens: 50, costUsd: 0.01, costBasis: "list" },
      { model: "codex-oauth/gpt-6-sol", canonicalModel: "x", provider: "anthropic", inputTokens: 20, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
    ]);
    const r2 = { type: "result", subtype: "success", modelUsage: { "anthropic/claude-sonnet-4.5": row(150, 30, 3000, 50, 0.025, true), "codex-oauth/gpt-6-sol": row(20, 2, 0, 0, 0, false) } };
    const b = turnModelUsageOf(r2 as never, a.snapshot);
    expect(b.rows).toHaveLength(1); // the unchanged row is no part of this turn
    expect(b.rows[0]).toMatchObject({ inputTokens: 50, outputTokens: 20, cacheReadTokens: 2000, cacheWriteTokens: 0 });
    expect(b.rows[0]!.costUsd).toBeCloseTo(0.015, 12);
    // A fresh ledger (a new incarnation: the counts went down) counts whole.
    const c = turnModelUsageOf({ type: "result", modelUsage: { "anthropic/claude-sonnet-4.5": row(5, 1, 0, 0, 0.001, true) } } as never, b.snapshot);
    expect(c.rows[0]).toMatchObject({ inputTokens: 5, outputTokens: 1, costUsd: 0.001 });
  });
  test("no ledger: a claude-shaped per-turn usage block is the turn, keyed on the session's model", () => {
    const prev = new Map<string, LedgerSnapshot>();
    const r = turnModelUsageOf({ type: "result", usage: { input_tokens: 3, output_tokens: 4, cache_read_input_tokens: 5, cache_creation_input_tokens: 6 } } as never, prev, { key: "deepseek/deepseek-chat" });
    expect(r.rows).toEqual([{ model: "deepseek/deepseek-chat", inputTokens: 3, outputTokens: 4, cacheReadTokens: 5, cacheWriteTokens: 6 }]);
    expect(turnModelUsageOf({ type: "result" } as never, prev).rows).toEqual([]);
  });
});

describe("the projector hands each projected turn's per-model usage to onTurnUsage, once", () => {
  test("called inside the terminal's claim: a replayed result calls nothing; a throwing handler is swallowed", () => {
    const seen: Array<{ sourceId: string; rows: unknown[] }> = [];
    const { projector } = makeProjector({ onTurnUsage: (u) => { seen.push(u); } });
    accept(projector, init());
    accept(projector, assistantText("hi"));
    const frame = result({ modelUsage: modelUsage(1200, 40, 300) });
    accept(projector, frame);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.rows).toHaveLength(1);
    expect(seen[0]!.rows[0]).toMatchObject({ outputTokens: 40, cacheReadTokens: 300 });
    accept(projector, frame); // no begun turn, no frames: dropped, nothing called
    expect(seen).toHaveLength(1);
    const { projector: throwing } = makeProjector({ onTurnUsage: () => { throw new Error("boom"); } });
    accept(throwing, assistantText("hi"));
    expect(() => accept(throwing, result({ modelUsage: modelUsage(1, 1) }))).not.toThrow();
  });

  test("the source id carries the projector's generation: a new incarnation's turn 0 is not the old one's", () => {
    const ids: string[] = [];
    for (const generation of [1, 2]) {
      const { projector } = makeProjector({ generation, onTurnUsage: (u) => { ids.push(u.sourceId); } });
      accept(projector, init());
      accept(projector, assistantText("hi"));
      accept(projector, result({ modelUsage: modelUsage(10, 1) }));
    }
    expect(ids).toHaveLength(2);
    expect(ids[0]).toMatch(/^g1:rs:/);
    expect(ids[1]).toMatch(/^g2:rs:/);
    expect(ids[0]!.slice(3)).toBe(ids[1]!.slice(3));
  });
});

describe("Winter turns in the usage DB", () => {
  test("a runtime-priced row keeps its price; a subscription row gets the API twin's list-price estimate; replays never double", () => {
    const now = Date.UTC(2026, 9, 18, 12);
    const { db, svc } = service(() => now);
    const rows = [
      { model: "anthropic/claude-sonnet-4.5", provider: "anthropic", inputTokens: 100, outputTokens: 10, cacheReadTokens: 1000, cacheWriteTokens: 0, costUsd: 0.5, costBasis: "list" as const },
      { model: "codex-oauth/gpt-6-sol", canonicalModel: "codex-oauth/gpt-6-sol", inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      { model: "winter-test/echo", inputTokens: 5, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
    ];
    svc.recordWinterTurn("sid-1", "code", "rs:b:0", rows);
    svc.recordWinterTurn("sid-1", "code", "rs:b:0", rows);
    const r = db.db.query("SELECT model, provider, mode, cost_usd, cost_basis FROM usage_records ORDER BY id").all();
    const twin = loadCatalog().models.find((m) => m.key === "openai/gpt-6-sol")!.pricing!.value.inputPerMTokUsd;
    expect(r).toEqual([
      { model: "anthropic/claude-sonnet-4.5", provider: "anthropic", mode: "code", cost_usd: 0.5, cost_basis: "list" },
      { model: "codex-oauth/gpt-6-sol", provider: "codex-oauth", mode: "code", cost_usd: twin, cost_basis: "estimate" },
      { model: "winter-test/echo", provider: "winter-test", mode: "code", cost_usd: null, cost_basis: "unknown" },
    ]);
    const s = svc.series("24h", ["winter"]);
    expect(s.totals.records).toBe(3);
    expect(s.totals.costUsd).toBeCloseTo(0.5 + twin, 9);
    expect(s.models[0]!.model).toBe("codex-oauth/gpt-6-sol");
    expect(s.models.find((m) => m.model === "winter-test/echo")!.costBasis).toBe("unknown");
  });
});

describe("ranges and rollups", () => {
  test("each range covers its window; short ranges read records, long ones the hourly rollup; sources filter", () => {
    let now = Date.UTC(2026, 9, 18, 12, 30);
    const { db, svc } = service(() => now);
    const rec = (at: number, source: "winter" | "codex" | "claude-code", cost: number, dedupe: string) => db.insert([{
      dedupe, source, at, model: `${source}-model`, provider: "p", input: 10, output: 1, cacheRead: 100, cacheWrite: 0, costUsd: cost, costBasis: "estimate",
    }]);
    rec(now - 10 * 60_000, "winter", 1, "a");          // 10 min ago
    rec(now - 3 * 3_600_000, "codex", 2, "b");          // 3 h ago
    rec(now - 3 * 86_400_000, "claude-code", 4, "c");   // 3 days ago
    rec(now - 20 * 86_400_000, "codex", 8, "d");        // 20 days ago
    rec(now - 200 * 86_400_000, "winter", 16, "e");     // 200 days ago
    expect(svc.series("1h").totals.costUsd).toBe(1);
    expect(svc.series("24h").totals.costUsd).toBe(3);
    expect(svc.series("7d").totals.costUsd).toBe(7);
    expect(svc.series("30d").totals.costUsd).toBe(15);
    expect(svc.series("all").totals.costUsd).toBe(31);
    expect(svc.series("all", ["codex"]).totals.costUsd).toBe(10);
    expect(svc.series("all", ["winter", "claude-code"]).bySource.map((s) => [s.source, s.costUsd]).sort()).toEqual([["claude-code", 4], ["winter", 17]]);
    // Bucket counts and the sparkline.
    expect(svc.series("1h").buckets).toHaveLength(12);
    expect(svc.series("24h").buckets).toHaveLength(24);
    expect(svc.series("7d").buckets.length).toBeGreaterThanOrEqual(28);
    expect(svc.series("30d").buckets.length).toBeGreaterThanOrEqual(30);
    expect(svc.series("all").buckets.length).toBeLessThanOrEqual(62);
    const day = svc.series("30d");
    expect(day.buckets.reduce((a, b) => a + b.costUsd, 0)).toBe(15);
    // The hourly rollup agrees with the records.
    const hourly = db.db.query("SELECT SUM(cost_usd) AS c, SUM(cache_read) AS r, SUM(records) AS n FROM usage_hourly").get() as Record<string, number>;
    expect(hourly).toEqual({ c: 31, r: 500, n: 5 });
    // Cached tokens are their own column, everywhere.
    expect(svc.series("all").totals).toMatchObject({ input: 50, cacheRead: 500, output: 5 });
    now += 1;
    expect(rangeWindow("all", now, undefined).from).toBeLessThanOrEqual(now - 29 * 86_400_000);
  });
});

describe("subscriptions", () => {
  test("cycle math: next renewal, the cycle's start, monthly cost (a 31st renews on the month's last day)", () => {
    const at = (y: number, m: number, d: number) => new Date(y, m - 1, d, 15).getTime();
    expect(subscriptionCycle({ cadence: "monthly", renewalDay: 5, price: 20 }, at(2026, 10, 18))).toEqual({
      nextRenewal: new Date(2026, 10, 5).getTime(), cycleStart: new Date(2026, 9, 5).getTime(), monthlyCost: 20,
    });
    expect(subscriptionCycle({ cadence: "monthly", renewalDay: 31, price: 20 }, at(2027, 2, 10)).nextRenewal).toBe(new Date(2027, 1, 28).getTime());
    expect(subscriptionCycle({ cadence: "monthly", renewalDay: 18, price: 20 }, at(2026, 10, 18)).nextRenewal).toBe(new Date(2026, 10, 18).getTime());
    expect(subscriptionCycle({ cadence: "yearly", renewalDay: 1, renewalMonth: 3, price: 240 }, at(2026, 10, 18))).toEqual({
      nextRenewal: new Date(2027, 2, 1).getTime(), cycleStart: new Date(2026, 2, 1).getTime(), monthlyCost: 20,
    });
  });

  test("CRUD, and the cycle's usage at list price from the sources it covers", () => {
    const now = new Date(2026, 9, 18, 12).getTime();
    const { db, svc } = service(() => now);
    db.insert([
      { dedupe: "1", source: "codex", at: now - 86_400_000, model: "m", provider: "openai", input: 1, output: 1, cacheRead: 0, cacheWrite: 0, costUsd: 3, costBasis: "estimate" },
      { dedupe: "2", source: "winter", at: now - 86_400_000, model: "codex-oauth/x", provider: "codex-oauth", input: 1, output: 1, cacheRead: 0, cacheWrite: 0, costUsd: 2, costBasis: "estimate" },
      { dedupe: "3", source: "winter", at: now - 86_400_000, model: "anthropic/y", provider: "anthropic", input: 1, output: 1, cacheRead: 0, cacheWrite: 0, costUsd: 100, costBasis: "list" },
      { dedupe: "4", source: "codex", at: now - 60 * 86_400_000, model: "m", provider: "openai", input: 1, output: 1, cacheRead: 0, cacheWrite: 0, costUsd: 50, costBasis: "estimate" },
    ]);
    const saved = svc.setSubscription({ name: "ChatGPT Pro", provider: "openai", price: 200, currency: "USD", cadence: "monthly", renewalDay: 1, covers: ["codex", "winter:codex-oauth"] });
    let list = svc.subscriptions();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: saved.id, name: "ChatGPT Pro", monthlyCost: 200, usageThisCycleUsd: 5, cycleStart: new Date(2026, 9, 1).getTime() });
    svc.setSubscription({ ...saved, price: 100, currency: "EUR" });
    list = svc.subscriptions();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ price: 100, currency: "EUR", createdAt: saved.createdAt });
    expect(svc.removeSubscription(saved.id)).toBe(true);
    expect(svc.removeSubscription(saved.id)).toBe(false);
    expect(svc.subscriptions()).toEqual([]);
  });
});
