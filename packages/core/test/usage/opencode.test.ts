// OpenCode's tokens and cost (`docs/claude/usage.md`), FAKE `opencode` only: the parser against the live-seen shape,
// today's row replaced as the day grows, yesterday finalized once, the backfill by `--days` differences under a spawn
// budget (resumed next pass), the negative clamp, the throttle, not installed, tracking off, a failing binary.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { UsageDb } from "../../src/usage/db";
import {
  dayMinus, daysBefore, localDay, localDayStart, localNoon, opencodeDaysArgs, opencodeDifference, parseOpencodeStats, OPENCODE_ALL_ARGS,
} from "../../src/usage/opencode";
import { UsagePricer } from "../../src/usage/pricing";
import { UsageService, type UsageServiceDeps } from "../../src/usage/service";
import { SECRETS, fakeOpencode, probeRootIn, tempDir, type OpencodeDayModel } from "./fixtures";

const pricer = new UsagePricer();
/** Mid-afternoon local time today: today's row sits at noon. */
const TODAY = localDay(Date.now());
const AFTERNOON = localNoon(TODAY) + 3 * 3_600_000;

function service(over: Partial<UsageServiceDeps> & { clock: { now: number } }) {
  const home = tempDir("home");
  const db = new UsageDb(join(home, "usage", "usage.db"));
  const logs: string[] = [];
  const { clock, ...rest } = over;
  const svc = new UsageService({
    db, pricer, tracking: () => ({ codex: true, claudeCode: true, antigravity: true, opencode: true }), codexExecutable: () => undefined,
    claudeExecutable: () => undefined, winterCodexWindows: () => [], probeRoot: () => probeRootIn(home), ingestEveryMs: 0, now: () => clock.now,
    log: { warn: (m, meta) => logs.push(`${m} ${JSON.stringify(meta ?? {})}`), info: (m, meta) => logs.push(`${m} ${JSON.stringify(meta ?? {})}`) },
    ...rest,
  });
  return { home, db, svc, logs };
}

function runs(markerPath: string): string[] {
  return existsSync(markerPath) ? readFileSync(markerPath, "utf8").trim().split("\n").filter(Boolean).map((l) => (JSON.parse(l) as { argv: string[] }).argv.join(" ")) : [];
}

const m = (id: string, input: number, extra: Partial<OpencodeDayModel> = {}): OpencodeDayModel => ({ id, providerID: "opencode", input, output: input / 10, ...extra });

/** Every stored OpenCode row: its day, model, variant (from the dedupe), input and cost. */
function rows(db: UsageDb): Array<{ day: string; model: string; input: number; cost: number | null; at: number; basis: string }> {
  return (db.db.query("SELECT dedupe, model, input, cost_usd, cost_basis, at FROM usage_records WHERE source = 'opencode' ORDER BY at, model").all() as Array<Record<string, any>>)
    .map((r) => ({ day: String(r.dedupe).slice(-10), model: String(r.model), input: Number(r.input), cost: r.cost_usd, at: Number(r.at), basis: String(r.cost_basis) }));
}

describe("opencode stats, parsed", () => {
  test("per-model tokens, the qualified model id, OpenCode's own cost and the active dates — nothing else", () => {
    const text = readFileSync(join(import.meta.dir, "shapes", "opencode-stats.json"), "utf8");
    const s = parseOpencodeStats(text)!;
    expect([...s.models.values()].map((x) => [x.model, x.variant, x.input, x.output, x.reasoning, x.cacheRead, x.cost])).toEqual([
      ["opencode/muse-spark-1.3-contributor-free", "default", 1000, 200, 50, 5000, 0],
      ["nvidia/deepseek-ai/deepseek-v4-pro", "default", 2000, 400, 50, 10000, 0.36941418],
      ["opencode/space-bunny-free", "max", 3000, 600, 50, 15000, 0],
    ]);
    expect(s.activity).toEqual(["2026-01-29", "2026-01-30", "2026-01-31"]);
    expect(parseOpencodeStats("not json")).toBeUndefined();
    expect(parseOpencodeStats(`OpenCode 2.0 banner\n${text}`)?.models.size).toBe(3);
  });

  test("a day is the difference of two runs, every count clamped at 0", () => {
    const wide = parseOpencodeStats(JSON.stringify({ models: [{ model: { id: "a", providerID: "p" }, tokens: { input: 10, output: 5, cache: { read: 3 } }, cost: 1 }] }))!;
    const narrow = parseOpencodeStats(JSON.stringify({ models: [{ model: { id: "a", providerID: "p" }, tokens: { input: 4, output: 9, cache: { read: 1 } }, cost: 2 }] }))!;
    const d = [...opencodeDifference(wide, narrow).models.values()][0]!;
    expect([d.input, d.output, d.cacheRead, d.cost]).toEqual([6, 0, 2, 0]);
  });

  test("local days: `--days k+1` − `--days k` is the day k days ago", () => {
    expect(daysBefore(dayMinus(TODAY, 3), TODAY)).toBe(3);
    expect(dayMinus(TODAY, 0)).toBe(TODAY);
    expect(opencodeDaysArgs(2)).toEqual(["stats", "--standalone", "--days", "2", "--models", "--cost", "--json"]);
  });
});

describe("schema 4", () => {
  test("a schema-3 usage.db migrates: its rows kept, none counted as reported", () => {
    const path = join(tempDir("migrate"), "usage", "usage.db");
    let db = new UsageDb(path);
    const at = Date.now();
    db.insert([{ dedupe: "codex:s:1", source: "codex", at, provider: "openai", model: "gpt-5.1", input: 1, output: 2, cacheRead: 0, cacheWrite: 0, costUsd: 0.1, costBasis: "estimate" }]);
    db.db.run("ALTER TABLE usage_hourly DROP COLUMN reported_records");
    db.db.run("PRAGMA user_version = 3");
    db.close();
    db = new UsageDb(path);
    expect(db.schemaVersion()).toBe(4);
    expect(db.hourly(0, at + 1, ["codex"])[0]).toMatchObject({ records: 1, estimateRecords: 1, reportedRecords: 0 });
    db.close();
  });
});

describe("OpenCode in the usage DB", () => {
  test("today is ONE row per model per variant, REPLACED as the day grows (never added twice); reported cost; throttled to 10 min", async () => {
    const fake = fakeOpencode(tempDir("bin"), { daily: { 0: [m("big-pickle", 100, { cost: 0.5 }), m("big-pickle", 7, { variant: "max" })] } });
    const clock = { now: AFTERNOON };
    const { db, svc } = service({ opencodeExecutable: () => fake.path, clock });
    await svc.ingest(true);
    expect(rows(db).map((r) => [r.day, r.model, r.input, r.cost, r.basis])).toEqual([
      [TODAY, "opencode/big-pickle", 100, 0.5, "reported"], [TODAY, "opencode/big-pickle", 7, 0, "reported"],
    ]);
    expect(rows(db)[0]!.at).toBe(localNoon(TODAY));
    // Five minutes on, more usage: within the throttle — no run.
    fake.write({ daily: { 0: [m("big-pickle", 250, { cost: 1.25 }), m("big-pickle", 7, { variant: "max" })] } });
    const before = runs(fake.markerPath).length;
    clock.now += 5 * 60_000;
    await svc.ingest(true);
    expect(runs(fake.markerPath)).toHaveLength(before);
    clock.now += 6 * 60_000;
    await svc.ingest(true);
    expect(rows(db).map((r) => r.input)).toEqual([250, 7]);
    // The rollup follows the replacement: totals count each row once.
    const s = svc.series("24h", ["opencode"]);
    expect(s.totals.input).toBe(257);
    expect(s.totals.records).toBe(2);
    expect(s.totals.costUsd).toBeCloseTo(1.25, 9);
    expect(s.models.map((r) => [r.model, r.costBasis])).toEqual([["opencode/big-pickle", "reported"]]);
    expect(svc.series("30d", ["opencode"]).totals.input).toBe(257);
    // Nothing of the decoys anywhere.
    const everything = JSON.stringify(s) + readFileSync(db.path).toString("latin1");
    for (const x of SECRETS) expect(everything.includes(x)).toBe(false);
  }, 30_000);

  test("before noon, today's row sits at NOW (never in the future, so every range shows it)", async () => {
    const fake = fakeOpencode(tempDir("bin"), { daily: { 0: [m("big-pickle", 10)] } });
    const clock = { now: localNoon(TODAY) - 3 * 3_600_000 };
    const { db, svc } = service({ opencodeExecutable: () => fake.path, clock });
    await svc.ingest(true);
    expect(rows(db)[0]!.at).toBe(clock.now);
    expect(svc.series("1h", ["opencode"]).totals.input).toBe(10);
  }, 30_000);

  test("after midnight, yesterday is read from `--days 2` − `--days 1` and finalized once two batches agree; today starts fresh", async () => {
    const fake = fakeOpencode(tempDir("bin"), { daily: { 0: [m("big-pickle", 100)] } });
    const clock = { now: AFTERNOON };
    const { db, svc } = service({ opencodeExecutable: () => fake.path, clock });
    await svc.ingest(true);
    // The rest of that day's usage lands after the last pass; then midnight.
    const tomorrow = dayMinus(TODAY, -1);
    fake.write({ daily: { 0: [m("big-pickle", 5)], 1: [m("big-pickle", 180)] } });
    clock.now = localNoon(tomorrow) + 3_600_000;
    await svc.ingest(true);
    expect(rows(db).map((r) => [r.day, r.input])).toEqual([[TODAY, 180], [tomorrow, 5]]);
    const twos = () => runs(fake.markerPath).filter((a) => a === opencodeDaysArgs(2).join(" ")).length;
    // The second read, a batch later, agrees: finalized — and never asked again.
    clock.now += 11 * 60_000;
    await svc.ingest(true);
    const after = twos();
    clock.now += 11 * 60_000;
    await svc.ingest(true);
    expect(twos()).toBe(after);
    expect(rows(db).map((r) => [r.day, r.input])).toEqual([[TODAY, 180], [tomorrow, 5]]);
  }, 30_000);

  test("a message spanning midnight (filed under the day it started): yesterday is never finalized short", async () => {
    const fake = fakeOpencode(tempDir("bin"), { daily: { 0: [m("a", 100)] } });
    const clock = { now: AFTERNOON };
    const { db, svc } = service({ opencodeExecutable: () => fake.path, clock });
    await svc.ingest(true);
    const tomorrow = dayMinus(TODAY, -1);
    // 00:05: a message begun at 23:58 is still running — yesterday has part of it, today nothing; today never moves.
    fake.write({ daily: { 0: [], 1: [m("a", 160)] } });
    clock.now = localDayStart(tomorrow) + 5 * 60_000;
    await svc.ingest(true);
    expect(rows(db).map((r) => [r.day, r.input])).toEqual([[TODAY, 160]]);
    // 00:16: it finished — yesterday grew. The two reads differ: still not final.
    fake.write({ daily: { 0: [m("b", 3)], 1: [m("a", 190)] } });
    clock.now += 11 * 60_000;
    await svc.ingest(true);
    expect(rows(db).map((r) => [r.day, r.input])).toEqual([[TODAY, 190], [tomorrow, 3]]);
    // 00:27: the same again — final. Whatever comes later for that day is never read.
    clock.now += 11 * 60_000;
    await svc.ingest(true);
    fake.write({ daily: { 0: [m("b", 3)], 1: [m("a", 999)] } });
    clock.now += 11 * 60_000;
    await svc.ingest(true);
    expect(rows(db).map((r) => [r.day, r.input])).toEqual([[TODAY, 190], [tomorrow, 3]]);
  }, 30_000);

  test("the backfill: every active day by differences, newest first, under a spawn budget — resumed next pass until done", async () => {
    // Usage 1, 2, 3, 5 and 6 days ago (4 days ago idle) plus today.
    const daily: Record<number, OpencodeDayModel[]> = {
      0: [m("big-pickle", 1)], 1: [m("big-pickle", 10)], 2: [m("big-pickle", 20), m("grok-code", 2)], 3: [m("big-pickle", 30)],
      5: [m("grok-code", 50)], 6: [m("big-pickle", 60, { cost: 0.6 })],
    };
    const activity = [6, 5, 3, 2, 1, 0].map((k) => dayMinus(TODAY, k));
    const fake = fakeOpencode(tempDir("bin"), { daily, activity });
    const clock = { now: AFTERNOON };
    const { db, svc } = service({ opencodeExecutable: () => fake.path, clock, opencodeSpawnBudget: 7 });
    await svc.ingest(true);
    // Pass 1: today, --all, 1 day ago (`--days 2` then `--days 1` — its narrow run is today's run after it), 2 days ago
    // (`--days 3`, `--days 2`, then today again) — the budget is spent.
    expect(runs(fake.markerPath)).toEqual([
      opencodeDaysArgs(1), [...OPENCODE_ALL_ARGS], opencodeDaysArgs(2), opencodeDaysArgs(1), opencodeDaysArgs(3), opencodeDaysArgs(2), opencodeDaysArgs(1),
    ].map((a) => a.join(" ")));
    expect(new Set(rows(db).map((r) => r.day))).toEqual(new Set([0, 1, 2].map((k) => dayMinus(TODAY, k))));
    // The catch-up runs on while the budget ran out (no 10-minute wait), and resumes from the saved list.
    await svc.catchUp();
    const byDay = new Map<string, Record<string, number>>();
    for (const r of rows(db)) byDay.set(r.day, { ...byDay.get(r.day), [r.model]: r.input });
    for (const [k, list] of Object.entries(daily)) {
      expect(byDay.get(dayMinus(TODAY, Number(k)))).toEqual(Object.fromEntries(list.map((x) => [`opencode/${x.id}`, x.input])));
    }
    expect(byDay.has(dayMinus(TODAY, 4))).toBe(false);
    expect(runs(fake.markerPath).filter((a) => a.includes("--all"))).toHaveLength(1);
    // A batch later every day is read again, agrees and is final; after that a pass asks for today alone.
    clock.now += 11 * 60_000;
    await svc.catchUp();
    const count = runs(fake.markerPath).length;
    clock.now += 11 * 60_000;
    await svc.ingest(true);
    expect(runs(fake.markerPath).slice(count)).toEqual([opencodeDaysArgs(1).join(" ")]);
  }, 30_000);

  test("OpenCode in use DURING a batch: today moved around yesterday's pair, so only today is written; yesterday waits, never counted twice", async () => {
    const fake = fakeOpencode(tempDir("bin"), { daily: { 0: [m("a", 100)], 1: [m("a", 50)] }, activity: [dayMinus(TODAY, 1), TODAY], grow: 1 });
    const clock = { now: AFTERNOON };
    const { db, svc, logs } = service({ opencodeExecutable: () => fake.path, clock });
    await svc.ingest(true);
    // Every run saw a bigger today: yesterday not written, today's row is the last run's figure.
    const first = rows(db);
    expect(first.map((r) => r.day)).toEqual([TODAY]);
    expect(first[0]!.input).toBe(100 + runs(fake.markerPath).length);
    expect(logs.some((l) => l.includes("read again next time"))).toBe(true);
    // Quiet again: the next batch finalizes yesterday exactly, today once.
    fake.write({ daily: { 0: [m("a", 130)], 1: [m("a", 50)] }, activity: [dayMinus(TODAY, 1), TODAY] });
    clock.now += 11 * 60_000;
    await svc.ingest(true);
    expect(rows(db).map((r) => [r.day, r.input])).toEqual([[dayMinus(TODAY, 1), 50], [TODAY, 130]]);
    expect(svc.series("30d", ["opencode"]).totals.input).toBe(180);
  }, 30_000);

  test("every run gets TZ: the zone Winter counts its days in", async () => {
    const fake = fakeOpencode(tempDir("bin"), { daily: { 0: [m("a", 1)] } });
    const { svc } = service({ opencodeExecutable: () => fake.path, clock: { now: AFTERNOON } });
    await svc.ingest(true);
    const marks = readFileSync(fake.markerPath, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { env: string[] });
    for (const mk of marks) expect(mk.env).toContain("TZ");
    expect(localDay(Date.parse("2026-03-08T07:30:00Z"), "America/Los_Angeles")).toBe("2026-03-07");
    expect(localDay(Date.parse("2026-03-08T07:30:00Z"), "Asia/Tokyo")).toBe("2026-03-08");
    // The DST day in Los Angeles is 23 hours; its noon is 19:00 UTC.
    expect(localNoon("2026-03-08", "America/Los_Angeles")).toBe(Date.parse("2026-03-08T19:00:00Z"));
  }, 30_000);

  test("asleep for days: the active days between the last batch and yesterday are asked for once (`--all` again)", async () => {
    const fake = fakeOpencode(tempDir("bin"), { daily: { 0: [m("a", 1)] }, activity: [TODAY] });
    const clock = { now: AFTERNOON };
    const { db, svc } = service({ opencodeExecutable: () => fake.path, clock });
    await svc.ingest(true);
    // Four days on; OpenCode was used two days after the last batch (two days ago, by then).
    const later = dayMinus(TODAY, -4);
    fake.write({ daily: { 0: [m("a", 4)], 2: [m("a", 22)], 4: [m("a", 1)] }, activity: [TODAY, dayMinus(later, 2), later] });
    clock.now = localNoon(later) + 3_600_000;
    await svc.ingest(true);
    expect(rows(db).map((r) => [r.day, r.input])).toEqual([[TODAY, 1], [dayMinus(later, 2), 22], [later, 4]]);
    expect(runs(fake.markerPath).filter((a) => a.includes("--all"))).toHaveLength(2);
  }, 30_000);

  test("the backfill resumes after a restart from the saved list (never asking --all again)", async () => {
    const daily: Record<number, OpencodeDayModel[]> = { 0: [m("a", 1)], 3: [m("a", 3)], 9: [m("a", 9)] };
    const fake = fakeOpencode(tempDir("bin"), { daily, activity: [9, 3, 0].map((k) => dayMinus(TODAY, k)) });
    const clock = { now: AFTERNOON };
    const home = tempDir("home");
    const mk = () => {
      const db = new UsageDb(join(home, "usage", "usage.db"));
      return { db, svc: new UsageService({
        db, pricer, tracking: () => ({ codex: false, claudeCode: false, antigravity: false, opencode: true }), codexExecutable: () => undefined,
        claudeExecutable: () => undefined, winterCodexWindows: () => [], probeRoot: () => probeRootIn(home), ingestEveryMs: 0,
        now: () => clock.now, opencodeExecutable: () => fake.path, opencodeSpawnBudget: 5,
      }) };
    };
    const first = mk();
    await first.svc.ingest(true); // today, --all, yesterday (--days 2, --days 1): 3 days ago does not fit
    first.db.close();
    const second = mk();
    await second.svc.catchUp();
    expect(rows(second.db).map((r) => [r.day, r.input])).toEqual([[dayMinus(TODAY, 9), 9], [dayMinus(TODAY, 3), 3], [TODAY, 1]]);
    expect(runs(fake.markerPath).filter((a) => a.includes("--all"))).toHaveLength(1);
  }, 30_000);

  test("a failing opencode: nothing written, never `more` (the catch-up does not loop), retried after the throttle", async () => {
    const fake = fakeOpencode(tempDir("bin"), { daily: {}, fail: true });
    const clock = { now: AFTERNOON };
    const { db, svc, logs } = service({ opencodeExecutable: () => fake.path, clock });
    await svc.catchUp();
    expect(runs(fake.markerPath)).toHaveLength(1);
    expect(rows(db)).toEqual([]);
    expect(logs.join("\n").includes("SECRET")).toBe(false);
    clock.now += 11 * 60_000;
    await svc.ingest(true);
    expect(runs(fake.markerPath)).toHaveLength(2);
  }, 30_000);

  test("a run failing mid-batch keeps the 10-minute throttle (no re-batch every pass)", async () => {
    const fake = fakeOpencode(tempDir("bin"), { daily: { 0: [m("a", 1)] }, activity: [TODAY], failFrom: 3 });
    const clock = { now: AFTERNOON };
    const { svc } = service({ opencodeExecutable: () => fake.path, clock });
    await svc.ingest(true); // today, --all, then yesterday's `--days 2` fails
    expect(runs(fake.markerPath)).toHaveLength(3);
    clock.now += 30_000;
    await svc.catchUp();
    expect(runs(fake.markerPath)).toHaveLength(3);
    clock.now += 10 * 60_000;
    await svc.ingest(true);
    expect(runs(fake.markerPath)).toHaveLength(4);
  }, 30_000);

  test("not on this Mac: nothing run, and the summary says so; tracking off: nothing run", async () => {
    const clock = { now: AFTERNOON };
    const none = service({ clock });
    const s = await none.svc.summary("24h", undefined, { plans: false });
    expect(s.installed.opencode).toBe(false);
    const fake = fakeOpencode(tempDir("bin"), { daily: { 0: [m("a", 1)] } });
    const off = service({ clock, opencodeExecutable: () => fake.path, tracking: () => ({ codex: false, claudeCode: false, antigravity: false, opencode: false }) });
    await off.svc.ingest(true);
    expect(runs(fake.markerPath)).toHaveLength(0);
    expect((await off.svc.summary("24h", undefined, { plans: false })).installed.opencode).toBe(true);
  }, 30_000);
});
