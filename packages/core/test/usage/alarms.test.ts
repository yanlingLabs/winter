// Plan alarms (`docs/claude/usage.md`): the `usage_alarms` table (schema 5) and its CRUD, the stable window key, the
// firing rule (met, not met, stale, measured before the alarm, not installed, tracking off), one-shot and single-flight
// firing, the background beats (the 30-min one and each alarmed plan's fast one), the env switch, and the island's
// notification on a real daemon — FAKE executables and temp dirs only.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, ConnWriter, CLIENT_CAPABILITY_ISLAND, type WritableSocket } from "@yanlinglabs/winter-protocol";
import { USAGE_DB_SCHEMA_VERSION, UsageDb } from "../../src/usage/db";
import { UsagePricer } from "../../src/usage/pricing";
import { planScopeKey, planWindowKey } from "../../src/usage/plan";
import { FAST_BEAT_SLACK_MS, PLAN_PROVIDERS, USAGE_BACKGROUND_EVERY_MS, UsageService, fastBeatFloor, type UsageServiceDeps } from "../../src/usage/service";
import type { FiredUsageAlarm } from "../../src/usage/db";
import { createUsageService } from "../../src/usage/wiring";
import { startDaemon, type RunningDaemon } from "../../src/daemon";
import { FileSecretStore } from "../../src/auth/secret-store";
import { claudeJson, codexMeta, codexRateLimits, codexRolloutPath, codexTokenCount, codexTurnContext, fakeClaude, fakeCodex, lines, probeRootIn, tempDir } from "./fixtures";

const pricer = new UsagePricer();
const sec = (ms: number) => Math.floor(ms / 1000);
/** An installed app that answers nothing (exits at once): the fallback rungs' tests. */
const FAILING = "/usr/bin/false";

interface Timer { fn: () => void; ms: number; cancelled: boolean }

function service(over: Partial<UsageServiceDeps> = {}) {
  const home = tempDir("alarms");
  const db = new UsageDb(join(home, "usage", "usage.db"));
  // The fired notices as the island would read them back on each change (from the DB).
  const fired: FiredUsageAlarm[] = [];
  const counts = { notices: 0 };
  const timers: Timer[] = [];
  const tracking = { codex: true, claudeCode: true, antigravity: true, opencode: true };
  const svc = new UsageService({
    db, pricer, tracking: () => tracking,
    codexExecutable: () => undefined, claudeExecutable: () => undefined, winterCodexWindows: () => [],
    probeRoot: () => probeRootIn(home), ingestEveryMs: 0, planWaitMs: 20_000, fallbackEveryMs: 0,
    onAlarmNotices: () => { counts.notices++; fired.splice(0, fired.length, ...db.firedAlarms()); },
    setInterval: (fn, ms) => {
      const t = { fn, ms, cancelled: false };
      timers.push(t);
      return () => { t.cancelled = true; };
    },
    ...over,
  });
  const live = () => timers.filter((t) => !t.cancelled);
  return { home, db, svc, fired, counts, timers, live, tracking };
}

function spawns(markerPath: string): number {
  return existsSync(markerPath) ? readFileSync(markerPath, "utf8").trim().split("\n").filter(Boolean)
    .filter((l) => (JSON.parse(l) as { argv: string[] }).argv[0] !== "auth").length : 0;
}

describe("the usage_alarms table (schema 5)", () => {
  test("a schema-4 usage.db migrates: its rows kept, the table added", () => {
    const path = join(tempDir("migrate"), "usage", "usage.db");
    let db = new UsageDb(path);
    const at = Date.now();
    db.insert([{ dedupe: "codex:s:1", source: "codex", at, provider: "openai", model: "gpt-5.1", input: 1, output: 2, cacheRead: 0, cacheWrite: 0, costUsd: 0.1, costBasis: "estimate" }]);
    db.db.run("DROP TABLE usage_alarms");
    db.db.run("PRAGMA user_version = 4");
    db.close();
    db = new UsageDb(path);
    expect(db.schemaVersion()).toBe(5);
    expect(USAGE_DB_SCHEMA_VERSION).toBe(5);
    expect(db.hourly(0, at + 1, ["codex"])[0]).toMatchObject({ records: 1 });
    expect(db.alarms()).toEqual([]);
    db.close();
  });

  test("add, list (oldest first), the same window and threshold once, remove — true only for the call that removed it", () => {
    const db = new UsageDb(join(tempDir("crud"), "usage", "usage.db"));
    const a = db.addAlarm({ id: "a1", provider: "claude-code", windowKey: "weekly", thresholdPercent: 80, createdAt: 2 });
    db.addAlarm({ id: "a0", provider: "codex", windowKey: "five_hour", thresholdPercent: 50, createdAt: 1 });
    expect(a.id).toBe("a1");
    // A double click: the stored one is answered, nothing new is kept.
    expect(db.addAlarm({ id: "a2", provider: "claude-code", windowKey: "weekly", thresholdPercent: 80, createdAt: 3 }).id).toBe("a1");
    expect(db.alarms().map((x) => x.id)).toEqual(["a0", "a1"]);
    expect(db.alarms()[1]).toEqual({ id: "a1", provider: "claude-code", windowKey: "weekly", thresholdPercent: 80, createdAt: 2 });
    expect(db.removeAlarm("a1")).toBe(true);
    expect(db.removeAlarm("a1")).toBe(false);
    expect(db.alarms().map((x) => x.id)).toEqual(["a0"]);
    db.close();
  });

  test("a usage.db already at schema 5 from an earlier build (no fired_at / notice, a table-wide UNIQUE) is repaired on open, its rows kept", () => {
    const path = join(tempDir("v5-old"), "usage", "usage.db");
    let db = new UsageDb(path);
    db.db.run("DROP TABLE usage_alarms");
    db.db.run(`CREATE TABLE usage_alarms (id TEXT PRIMARY KEY, provider TEXT NOT NULL, window_key TEXT NOT NULL, threshold INTEGER NOT NULL,
      created_at INTEGER NOT NULL, UNIQUE (provider, window_key, threshold))`);
    db.db.run("INSERT INTO usage_alarms (id, provider, window_key, threshold, created_at) VALUES ('old', 'codex', 'weekly', 70, 1)");
    expect(db.schemaVersion()).toBe(5);
    db.close();
    db = new UsageDb(path);
    const columns = (db.db.query("PRAGMA table_info(usage_alarms)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(columns).toContain("fired_at");
    expect(columns).toContain("notice");
    expect(db.alarms().map((a) => a.id)).toEqual(["old"]);
    // Fired, then armed again at the same threshold while its notice waits: the old UNIQUE is gone.
    expect(db.fireAlarm("old", 2, { kind: "weekly", usedPercent: 71 })).toBe(true);
    expect(db.addAlarm({ id: "new", provider: "codex", windowKey: "weekly", thresholdPercent: 70, createdAt: 3 }).id).toBe("new");
    expect(db.firedAlarms().map((a) => a.id)).toEqual(["old"]);
    db.close();
    // And a second open changes nothing.
    db = new UsageDb(path);
    expect(db.alarms().map((a) => a.id)).toEqual(["new"]);
    db.close();
  });

  test("a fired alarm is marked once (single-flight), leaves the ticks, waits for its acknowledgement, and frees its threshold", () => {
    const db = new UsageDb(join(tempDir("fired"), "usage", "usage.db"));
    db.addAlarm({ id: "a1", provider: "claude-code", windowKey: "weekly", thresholdPercent: 80, createdAt: 2 });
    const notice = { kind: "weekly", windowMinutes: 10_080, usedPercent: 82, resetsAt: 9_000 };
    expect(db.fireAlarm("a1", 5, notice)).toBe(true);
    expect(db.fireAlarm("a1", 6, notice)).toBe(false);
    expect(db.alarms()).toEqual([]); // a fired alarm is no tick
    expect(db.firedAlarms()).toEqual([{ id: "a1", provider: "claude-code", windowKey: "weekly", thresholdPercent: 80, createdAt: 2, firedAt: 5, ...notice }]);
    // The same alarm can be set again while the first one's notice waits.
    expect(db.addAlarm({ id: "a2", provider: "claude-code", windowKey: "weekly", thresholdPercent: 80, createdAt: 7 }).id).toBe("a2");
    expect(db.removeAlarm("a1")).toBe(false); // a tick's removal never takes a waiting notice
    expect(db.ackAlarm("a2")).toBe(false); // an armed alarm is not acknowledged
    expect(db.ackAlarm("a1")).toBe(true);
    expect(db.ackAlarm("a1")).toBe(false);
    expect(db.firedAlarms()).toEqual([]);
    expect(db.alarms().map((a) => a.id)).toEqual(["a2"]);
    db.close();
  });

  test("a fired notice survives a restart until it is acknowledged", async () => {
    const fake = fakeCodex(tempDir("bin"), "ok", { primary: 90, secondary: 10, resetsAtSec: sec(Date.now() + 3_600_000) });
    const { svc, db, home } = service({ codexExecutable: () => fake.path });
    const a = svc.setAlarm({ provider: "codex", windowKey: "five_hour", thresholdPercent: 80 });
    await svc.codexPlan();
    db.close();
    const again = new UsageDb(join(home, "usage", "usage.db"));
    let told = 0;
    const svc2 = new UsageService({
      db: again, pricer, tracking: () => ({ codex: true, claudeCode: true, antigravity: true, opencode: true }), codexExecutable: () => undefined,
      claudeExecutable: () => undefined, winterCodexWindows: () => [], probeRoot: () => probeRootIn(home), onAlarmNotices: () => { told++; },
    });
    expect(svc2.firedAlarms().map((f) => [f.id, f.usedPercent])).toEqual([[a.id, 90]]);
    expect(svc2.ackAlarm(a.id)).toBe(true);
    expect(told).toBe(1);
    expect(svc2.firedAlarms()).toEqual([]);
    expect(svc2.ackAlarm(a.id)).toBe(false);
    expect(told).toBe(1);
    again.close();
  });
});

describe("the window key", () => {
  test("its kind and scope (lower-cased), the same whichever rung or index; another length adds its minutes", () => {
    expect(planWindowKey({ kind: "five_hour" })).toBe("five_hour");
    expect(planWindowKey({ kind: "weekly_scoped", scope: "Fable" })).toBe("weekly_scoped:fable");
    expect(planWindowKey({ kind: "weekly_scoped", scope: "fable" })).toBe("weekly_scoped:fable");
    expect(planWindowKey({ kind: "weekly", scope: "Gemini" })).toBe("weekly:gemini");
    expect(planWindowKey({ kind: "other", windowMinutes: 1440 })).toBe("other@1440");
    // A per-model scope is keyed by its model family, however the source names it.
    expect(planScopeKey("Claude Opus 4.5")).toBe("opus");
    expect(planScopeKey("opus")).toBe("opus");
    expect(planScopeKey(" Sonnet ")).toBe("sonnet");
    expect(planScopeKey("Claude & GPT")).toBe("claude & gpt");
    expect(planWindowKey({ kind: "weekly_scoped", scope: "Claude Opus 4.5" })).toBe("weekly_scoped:opus");
  });

  test("Claude Code's /usage and its ~/.claude.json cache name the same per-model window by one key — an alarm set under one fires under the other", async () => {
    let now = Date.now();
    const home = tempDir("keys");
    const jsonPath = join(home, "claude.json");
    // The CLI names the limit by its display name ("Fable"); the cache by its key's suffix (`seven_day_fable`).
    const cli = fakeClaude(tempDir("bin"), "ok");
    const { svc: viaCli } = service({ claudeExecutable: () => cli.path, now: () => now });
    const cliKey = (await viaCli.claudeCodePlan()).windows.find((w) => w.kind === "weekly_scoped")?.windowKey;
    claudeJson(jsonPath, now + 1_000, { seven_day_fable: { utilization: 85, resets_at: new Date(now + 3 * 86_400_000).toISOString() } });
    const { svc: viaCache, fired } = service({ claudeExecutable: () => FAILING, claudeJsonPath: jsonPath, now: () => now });
    viaCache.setAlarm({ provider: "claude-code", windowKey: cliKey!, thresholdPercent: 80 });
    now += 2_000;
    const cached = await viaCache.claudeCodePlan();
    expect(cached.source).toBe("claude-cache");
    expect(cliKey).toBe("weekly_scoped:fable");
    expect(cached.windows.find((w) => w.kind === "weekly_scoped")?.windowKey).toBe(cliKey);
    expect(fired.map((f) => f.windowKey)).toEqual(["weekly_scoped:fable"]);
  });

  test("every answered window carries it", async () => {
    const fake = fakeCodex(tempDir("bin"), "ok");
    const { svc } = service({ codexExecutable: () => fake.path });
    const r = await svc.codexPlan();
    expect(r.windows.map((w) => w.windowKey)).toEqual(["five_hour", "weekly"]);
  });
});

describe("firing", () => {
  const resetsAtSec = sec(Date.now() + 3_600_000);

  test("met: a fresh reading at the threshold or above fires once — deleted, the notification carries the window", async () => {
    const fake = fakeCodex(tempDir("bin"), "ok", { primary: 85, secondary: 40, resetsAtSec });
    const { svc, fired } = service({ codexExecutable: () => fake.path });
    const a = svc.setAlarm({ provider: "codex", windowKey: "five_hour", thresholdPercent: 85 });
    svc.setAlarm({ provider: "codex", windowKey: "weekly", thresholdPercent: 41 });
    await svc.codexPlan();
    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({ id: a.id, provider: "codex", windowKey: "five_hour", kind: "five_hour", windowMinutes: 300, thresholdPercent: 85, usedPercent: 85, resetsAt: resetsAtSec * 1000 });
    // Not met (40 < 41): it stays.
    expect(svc.alarms().map((x) => x.windowKey)).toEqual(["weekly"]);
  });

  test("one-shot: a later reading over the threshold fires nothing more", async () => {
    const fake = fakeCodex(tempDir("bin"), "ok", { primary: 90, secondary: 40, resetsAtSec });
    const { svc, fired } = service({ codexExecutable: () => fake.path, codexAppServerEveryMs: 0 });
    svc.setAlarm({ provider: "codex", windowKey: "five_hour", thresholdPercent: 80 });
    await svc.codexPlan();
    await svc.codexPlan();
    await svc.codexPlan();
    expect(fired).toHaveLength(1);
    expect(svc.alarms()).toEqual([]);
  });

  test("concurrent reads fire it exactly once (single-flight)", async () => {
    const fake = fakeCodex(tempDir("bin"), "ok", { primary: 90, secondary: 95, resetsAtSec });
    const { svc, fired } = service({ codexExecutable: () => fake.path });
    svc.setAlarm({ provider: "codex", windowKey: "five_hour", thresholdPercent: 80 });
    svc.setAlarm({ provider: "codex", windowKey: "weekly", thresholdPercent: 90 });
    await Promise.all(Array.from({ length: 6 }, () => svc.codexPlan()));
    await Promise.all(Array.from({ length: 6 }, () => svc.summary("24h", ["winter"])));
    expect(fired.map((f) => f.windowKey).sort()).toEqual(["five_hour", "weekly"]);
    expect(spawns(fake.markerPath)).toBe(1);
  });

  test("a stale reading never fires (the newest rollout, older than its own window)", async () => {
    const codexHome = tempDir("codex");
    const old = Date.now() - 6 * 3_600_000;
    writeFileSync(codexRolloutPath(codexHome, old, "old"), lines(codexMeta(old, "s-old"), codexTurnContext(old, "gpt-5.1"),
      codexTokenCount(old, { input: 1, cached: 0, output: 1, reasoning: 0 }, { input: 1, cached: 0, output: 1, reasoning: 0 },
        codexRateLimits(95, 20, { primary: sec(Date.now() + 3_600_000), secondary: sec(Date.now() + 86_400_000) }))));
    const { svc, db, fired } = service({ codexHome, codexExecutable: () => FAILING });
    // Set BEFORE the record, so the freshness rule alone would not hold it back: only staleness does.
    db.addAlarm({ id: "a-old", provider: "codex", windowKey: "five_hour", thresholdPercent: 90, createdAt: old - 1 });
    const r = await svc.codexPlan();
    expect(r.source).toBe("codex-rollout");
    expect(r.windows.find((w) => w.kind === "five_hour")).toMatchObject({ usedPercent: 95, stale: true });
    expect(fired).toEqual([]);
    expect(svc.alarms()).toHaveLength(1);
  });

  test("a reading measured before the alarm was set is no news about it; the next fresh one fires it", async () => {
    let now = Date.now();
    const fake = fakeCodex(tempDir("bin"), "ok", { primary: 85, secondary: 40, resetsAtSec });
    const { svc, fired } = service({ codexExecutable: () => fake.path, now: () => now, codexAppServerEveryMs: 60_000 });
    await svc.codexPlan();
    now += 1_000;
    svc.setAlarm({ provider: "codex", windowKey: "five_hour", thresholdPercent: 80 });
    await svc.codexPlan(); // the cached reading, measured a second before the alarm
    expect(fired).toEqual([]);
    now += 61_000;
    await svc.codexPlan();
    expect(fired).toHaveLength(1);
  });

  test("not installed, or tracking off: no check, no firing — the alarms stay", async () => {
    const fake = fakeCodex(tempDir("bin"), "ok", { primary: 99, secondary: 99, resetsAtSec });
    let exe: string | undefined;
    const { svc, fired, tracking } = service({ codexExecutable: () => exe });
    svc.setAlarm({ provider: "codex", windowKey: "five_hour", thresholdPercent: 50 });
    expect((await svc.codexPlan()).source).toBe("not-installed");
    exe = fake.path;
    tracking.codex = false;
    expect((await svc.codexPlan()).source).toBe("disabled");
    expect(spawns(fake.markerPath)).toBe(0);
    expect(fired).toEqual([]);
    expect(svc.alarms()).toHaveLength(1);
    tracking.codex = true;
    await svc.codexPlan();
    expect(fired).toHaveLength(1);
  });

  test("Claude Code: a per-model weekly limit fires by its scope; it is judged as the spawn lands, too", async () => {
    const fake = fakeClaude(tempDir("bin"), "ok");
    // A read that stops waiting at once answers before the spawn lands: the landing itself fires the alarm.
    const { svc, fired } = service({ claudeExecutable: () => fake.path, planWaitMs: 0 });
    svc.setAlarm({ provider: "claude-code", windowKey: "weekly_scoped:fable", thresholdPercent: 80 });
    await svc.claudeCodePlan();
    const end = Date.now() + 10_000;
    while (fired.length === 0 && Date.now() < end) await Bun.sleep(20);
    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({ provider: "claude-code", kind: "weekly_scoped", scope: "Fable", thresholdPercent: 80, usedPercent: 80 });
  });
});

describe("the background beats", () => {
  test("the slow beat (30 min) reads every plan; a fast beat runs at the plan's throttle only while it has an alarm", async () => {
    const fake = fakeCodex(tempDir("bin"), "ok", { primary: 10, secondary: 10, resetsAtSec: sec(Date.now() + 3_600_000) });
    const { svc, live } = service({ codexExecutable: () => fake.path, codexAppServerEveryMs: 60_000 });
    // Nothing before it is started: setting an alarm arms nothing.
    const early = svc.setAlarm({ provider: "codex", windowKey: "weekly", thresholdPercent: 99 });
    expect(live()).toEqual([]);
    svc.removeAlarm(early.id);
    svc.startBackground();
    expect(live().map((t) => t.ms)).toEqual([USAGE_BACKGROUND_EVERY_MS]);
    expect(svc.beating).toEqual([]);
    // The slow beat reads the installed plans (the others answer at once: nothing to spawn).
    live()[0]!.fn();
    const end = Date.now() + 10_000;
    while (spawns(fake.markerPath) === 0 && Date.now() < end) await Bun.sleep(20);
    expect(spawns(fake.markerPath)).toBe(1);

    const a = svc.setAlarm({ provider: "codex", windowKey: "five_hour", thresholdPercent: 90 });
    const c = svc.setAlarm({ provider: "claude-code", windowKey: "weekly", thresholdPercent: 90 });
    svc.setAlarm({ provider: "claude-code", windowKey: "five_hour", thresholdPercent: 90 });
    expect(svc.beating).toEqual(["codex", "claude-code"]);
    expect(live().map((t) => t.ms).sort((x, y) => x - y)).toEqual([60_000, 300_000, USAGE_BACKGROUND_EVERY_MS]);
    svc.removeAlarm(c.id);
    expect(svc.beating).toEqual(["codex", "claude-code"]);
    svc.removeAlarm(a.id);
    expect(svc.beating).toEqual(["claude-code"]);
    svc.stopBackground();
    expect(live()).toEqual([]);
    expect(svc.beating).toEqual([]);
  });

  test("a fast beat's tick really reads (half its period is the floor), and its plan's last alarm firing stops it", async () => {
    let now = Date.now();
    const bin = tempDir("bin");
    const low = fakeCodex(join(bin, "low"), "ok", { primary: 10, secondary: 10, resetsAtSec: sec(Date.now() + 3_600_000) });
    const high = fakeCodex(join(bin, "high"), "ok", { primary: 60, secondary: 10, resetsAtSec: sec(Date.now() + 3_600_000) });
    let exe = low.path;
    const { svc, live, fired } = service({ codexExecutable: () => exe, now: () => now, codexAppServerEveryMs: 60_000 });
    svc.startBackground();
    await svc.codexPlan();
    svc.setAlarm({ provider: "codex", windowKey: "five_hour", thresholdPercent: 50 });
    const beat = live().find((t) => t.ms === 60_000)!;
    // Just under a period since the last read: the throttle alone would answer the cache.
    now += 59_000;
    exe = high.path;
    beat.fn();
    const end = Date.now() + 10_000;
    while (fired.length === 0 && Date.now() < end) await Bun.sleep(20);
    expect(spawns(high.markerPath)).toBe(1);
    expect(fired).toHaveLength(1);
    expect(svc.beating).toEqual([]);
    expect(beat.cancelled).toBe(true);
    expect(PLAN_PROVIDERS).toEqual(["codex", "claude-code", "antigravity"]);
  });

  test("a fast tick's spawn floor is the period less 5 s (never under half): one /usage per period, not two", () => {
    expect(FAST_BEAT_SLACK_MS).toBe(5_000);
    expect(fastBeatFloor(60_000)).toBe(55_000);
    expect(fastBeatFloor(300_000)).toBe(295_000);
    expect(fastBeatFloor(6_000)).toBe(3_000);
  });

  test("WINTER_USAGE_BACKGROUND=off (both preloads) keeps it off; without it the daemon's service starts it", () => {
    expect(process.env.WINTER_USAGE_BACKGROUND).toBe("off");
    const off = createUsageService({ home: tempDir("wire"), settings: () => undefined, injection: { catchUp: false } })!;
    expect(off.service.backgroundRunning).toBe(false);
    off.close();
    const saved = process.env.WINTER_USAGE_BACKGROUND;
    delete process.env.WINTER_USAGE_BACKGROUND;
    try {
      const on = createUsageService({ home: tempDir("wire"), settings: () => undefined, injection: { catchUp: false } })!;
      expect(on.service.backgroundRunning).toBe(true);
      on.close();
      expect(on.service.backgroundRunning).toBe(false);
      const injectedOff = createUsageService({ home: tempDir("wire"), settings: () => undefined, injection: { catchUp: false, background: false } })!;
      expect(injectedOff.service.backgroundRunning).toBe(false);
      injectedOff.close();
    } finally {
      process.env.WINTER_USAGE_BACKGROUND = saved;
    }
  });
});

class TestClient {
  private decoder = new LineDecoder();
  private nextId = 1;
  private pending = new Map<number, (msg: any) => void>();
  private socket!: Awaited<ReturnType<typeof Bun.connect>>;
  private writer!: ConnWriter;
  readonly notifications: string[] = [];

  static async connect(socketPath: string): Promise<TestClient> {
    const c = new TestClient();
    c.socket = await Bun.connect({
      unix: socketPath,
      socket: {
        data(_s, chunk) {
          for (const line of c.decoder.push(chunk)) {
            const msg = JSON.parse(line);
            if (msg.id !== undefined && c.pending.has(msg.id)) { c.pending.get(msg.id)!(msg); c.pending.delete(msg.id); }
            else if (msg.method !== undefined) c.notifications.push(msg.method);
          }
        },
        drain() { c.writer.onDrain(); },
      },
    });
    c.writer = new ConnWriter(c.socket as unknown as WritableSocket);
    return c;
  }

  request(method: string, params?: unknown): Promise<any> {
    const id = this.nextId++;
    this.writer.enqueue(encodeLine({ jsonrpc: "2.0", id, method, params }));
    return new Promise((resolve) => this.pending.set(id, resolve));
  }

  close(): void { this.socket.end(); }
}

describe("on a real daemon", () => {
  let daemon: RunningDaemon | undefined;
  afterEach(async () => { await daemon?.stop(); daemon = undefined; });

  test("an alarm set over the socket fires on the next read; its notice waits in island.activity across a restart until usage.alarms.ack", async () => {
    const home = tempDir("daemon");
    const fake = fakeCodex(tempDir("bin"), "ok", { primary: 72, secondary: 30, resetsAtSec: sec(Date.now() + 3_600_000) });
    const boot = () => startDaemon({
      home, secrets: new FileSecretStore(join(home, "test-secrets")),
      usage: { codexHome: null, claudeHome: null, claudeJsonPath: null, codexExecutable: fake.path, claudeExecutable: null, agyExecutable: null, opencodeExecutable: null, catchUp: false },
    });
    daemon = await boot();
    const connect = async (): Promise<TestClient> => {
      const c = await TestClient.connect(daemon!.socketPath);
      await c.request(METHODS.hello, { protocolVersion: PROTOCOL_VERSION, role: "harness", token: daemon!.tokens.harness, clientName: "orb", capabilities: [CLIENT_CAPABILITY_ISLAND] });
      return c;
    };
    let app = await connect();
    const set = (await app.request(METHODS.usageAlarmsSet, { provider: "codex", windowKey: "five_hour", thresholdPercent: 70 })).result;
    expect(set.alarms).toHaveLength(1);
    expect((await app.request(METHODS.islandActivity, {})).result.usageAlarms).toEqual([]);
    const summary = (await app.request(METHODS.usageSummary, { range: "24h", sources: ["winter"] })).result;
    expect(summary.plans.codex.windows[0]).toMatchObject({ windowKey: "five_hour", usedPercent: 72 });
    expect(summary.alarms).toEqual([]);
    const activity = (await app.request(METHODS.islandActivity, {})).result;
    expect(activity.usageAlarms).toEqual([expect.objectContaining({ id: set.alarm.id, provider: "codex", kind: "five_hour", thresholdPercent: 70, usedPercent: 72 })]);
    const end = Date.now() + 2_000;
    while (!app.notifications.includes("island.activityChanged") && Date.now() < end) await Bun.sleep(20);
    expect(app.notifications).toContain("island.activityChanged");
    expect((await app.request(METHODS.usageAlarmsList, {})).result.alarms).toEqual([]);
    app.close();

    // The daemon restarts before anyone saw it: the notice is still there.
    await daemon!.stop();
    daemon = await boot();
    app = await connect();
    expect((await app.request(METHODS.islandActivity, {})).result.usageAlarms.map((a: { id: string }) => a.id)).toEqual([set.alarm.id]);
    // Acknowledged (✕, ↗, or shown its full time): gone, and the island is told.
    const heard = app.notifications.length;
    expect((await app.request(METHODS.usageAlarmsAck, { id: set.alarm.id })).result).toEqual({ acked: true });
    expect((await app.request(METHODS.islandActivity, {})).result.usageAlarms).toEqual([]);
    const until = Date.now() + 2_000;
    while (app.notifications.length === heard && Date.now() < until) await Bun.sleep(20);
    expect(app.notifications.slice(heard)).toContain("island.activityChanged");
    expect((await app.request(METHODS.usageAlarmsAck, { id: set.alarm.id })).result).toEqual({ acked: false });
    app.close();
  }, 30_000);
});
