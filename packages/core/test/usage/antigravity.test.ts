// The Antigravity plan (`docs/claude/usage.md`): agy's own `/usage` (FAKE executables only), the parser against the
// live-seen shape, the guard and its latch, not installed, tracking off, the throttle.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AGY_USAGE_ARGS, agyGroupScope, judgeAgyUsage, windowsFromAgyUsage } from "../../src/usage/antigravity";
import { UsageDb } from "../../src/usage/db";
import { UsagePricer } from "../../src/usage/pricing";
import { UsageService, binaryKey, type UsageServiceDeps } from "../../src/usage/service";
import { AGY_USAGE, SECRETS, fakeAgy, probeRootIn, tempDir, type FakeAgyMode } from "./fixtures";

const pricer = new UsagePricer();
const NOW = Date.parse("2026-10-18T19:15:04Z");

function service(over: Partial<UsageServiceDeps> & { home?: string; db?: UsageDb } = {}) {
  const home = over.home ?? tempDir("home");
  const db = over.db ?? new UsageDb(join(home, "usage", "usage.db"));
  const logs: string[] = [];
  const svc = new UsageService({
    db, pricer, tracking: () => ({ codex: true, claudeCode: true, antigravity: true, opencode: true }), codexExecutable: () => undefined,
    claudeExecutable: () => undefined, winterCodexWindows: () => [], probeRoot: () => probeRootIn(home), planWaitMs: 20_000, now: () => NOW,
    log: { warn: (m, meta) => logs.push(`${m} ${JSON.stringify(meta ?? {})}`), info: (m, meta) => logs.push(`${m} ${JSON.stringify(meta ?? {})}`) },
    ...over,
  });
  return { home, db, svc, logs };
}

function marks(markerPath: string): Array<{ argv: string[]; cwd: string; env: string[] }> {
  return existsSync(markerPath) ? readFileSync(markerPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
}

describe("agy's /usage, parsed", () => {
  test("each bucket is a window: used = 1 − remaining, its kind, reset and group", () => {
    const data = (AGY_USAGE.command as Record<string, unknown>).data;
    const windows = windowsFromAgyUsage(data, NOW, NOW);
    expect(windows.map((w) => [w.id, w.kind, w.windowMinutes, w.usedPercent, w.scope, w.stale])).toEqual([
      ["gemini-weekly", "weekly", 10_080, 27, "Gemini", false],
      ["gemini-5h", "five_hour", 300, 0, "Gemini", false],
      ["3p-weekly", "weekly", 10_080, 27, "Claude & GPT", false],
      ["3p-5h", "five_hour", 300, 0, "Claude & GPT", false],
    ]);
    expect(windows[0]!.resetsAt).toBe(Date.parse("2026-10-25T18:15:04Z"));
  });

  test("a group's name, shortly", () => {
    expect(agyGroupScope("Gemini Models")).toBe("Gemini");
    expect(agyGroupScope("Claude and GPT models")).toBe("Claude & GPT");
    expect(agyGroupScope("Open Weights")).toBe("Open Weights");
    expect(agyGroupScope(undefined)).toBeUndefined();
  });

  test("the guard: only the read-only command with no turn and no token is read; positive evidence is `guard`", () => {
    expect(judgeAgyUsage(AGY_USAGE, NOW).reading?.source).toBe("agy-cli");
    const variant = (f: (o: Record<string, any>) => void) => { const o = JSON.parse(JSON.stringify(AGY_USAGE)); f(o); return judgeAgyUsage(o, NOW).failure; };
    expect(variant((o) => { o.num_turns = 1; })).toBe("guard");
    expect(variant((o) => { o.usage.output_tokens = 3; })).toBe("guard");
    expect(variant((o) => { o.command.name = "chat"; })).toBe("guard");
    expect(variant((o) => { o.conversation_id = "c-1"; })).toBe("guard");
    // No command but a successful answer with text: the model answered "/usage" as a prompt.
    expect(variant((o) => { delete o.command; })).toBe("guard");
    expect(variant((o) => { delete o.command; o.response = ""; })).toBe("no-command");
    expect(variant((o) => { delete o.command; o.status = "ERROR"; })).toBe("no-command");
    // A missing count never reads as zero.
    expect(variant((o) => { delete o.num_turns; })).toBe("unverified");
    expect(variant((o) => { delete o.usage; })).toBe("unverified");
    expect(variant((o) => { delete o.conversation_id; })).toBe("unverified");
    expect(variant((o) => { o.status = "ERROR"; })).toBe("error");
    expect(variant((o) => { o.command.data.groups = []; })).toBe("no-report");
  });
});

describe("the Antigravity plan", () => {
  test("agy's own /usage with EXACTLY the verified invocation, in its own probe dir, nothing of its text kept; throttled to 5 min", async () => {
    const fake = fakeAgy(tempDir("bin"), "banner");
    let now = NOW;
    const { svc } = service({ agyExecutable: () => fake.path, now: () => now });
    const plan = await svc.antigravityPlan();
    expect(plan.source).toBe("agy-cli");
    expect(plan.provider).toBe("antigravity");
    expect(plan.windows.map((w) => [w.scope, w.kind, w.usedPercent])).toEqual([
      ["Gemini", "weekly", 27], ["Gemini", "five_hour", 0], ["Claude & GPT", "weekly", 27], ["Claude & GPT", "five_hour", 0],
    ]);
    expect(plan.planType).toBeUndefined();
    for (const s of SECRETS) expect(JSON.stringify(plan).includes(s)).toBe(false);
    const m = marks(fake.markerPath);
    expect(m).toHaveLength(1);
    expect(m[0]!.argv).toEqual([...AGY_USAGE_ARGS]);
    expect(m[0]!.cwd).toMatch(/\/usage\/probe-[^/]+$/);
    expect(existsSync(m[0]!.cwd)).toBe(false);
    expect(m[0]!.env.filter((k) => k.startsWith("WINTER_") || k.startsWith("GEMINI_") || k.startsWith("GOOGLE_"))).toEqual([]);
    now += 4 * 60_000;
    await svc.antigravityPlan();
    expect(marks(fake.markerPath)).toHaveLength(1);
    now += 2 * 60_000;
    await svc.antigravityPlan();
    expect(marks(fake.markerPath)).toHaveLength(2);
  });

  for (const mode of ["turns", "tokens", "other-command", "conversation", "answered"] as const satisfies readonly FakeAgyMode[]) {
    test(`a /usage that reached the model loop (${mode}) LATCHES the binary: one warning, no content, not asked again until it changes`, async () => {
      const fake = fakeAgy(tempDir("bin"), mode);
      const home = tempDir("home");
      let now = NOW;
      const first = service({ home, agyExecutable: () => fake.path, now: () => now });
      expect((await first.svc.antigravityPlan()).source).toBe("none");
      expect(first.db.latch(binaryKey("agy", fake.path)!)?.reason).toBe("guard");
      expect(first.logs.filter((l) => l.includes("not asked again until Antigravity changes"))).toHaveLength(1);
      expect(first.logs.join("\n").includes("SECRET")).toBe(false);
      first.db.close();
      // A restart, an hour later: still latched.
      now += 3_600_000;
      const second = service({ home, db: new UsageDb(join(home, "usage", "usage.db")), agyExecutable: () => fake.path, now: () => now });
      expect((await second.svc.antigravityPlan()).source).toBe("none");
      expect(marks(fake.markerPath)).toHaveLength(1);
    });
  }

  for (const mode of ["no-json", "no-command", "no-telemetry", "exit-1"] as const satisfies readonly FakeAgyMode[]) {
    test(`an ordinary failure (${mode}) is cached for the throttle, then retried — never latched`, async () => {
      const fake = fakeAgy(tempDir("bin"), mode);
      let now = NOW;
      const { svc, db } = service({ agyExecutable: () => fake.path, now: () => now });
      expect((await svc.antigravityPlan()).source).toBe("none");
      now += 60_000;
      await svc.antigravityPlan();
      expect(marks(fake.markerPath)).toHaveLength(1);
      expect(db.latch(binaryKey("agy", fake.path)!)).toBeUndefined();
      now += 5 * 60_000;
      await svc.antigravityPlan();
      expect(marks(fake.markerPath)).toHaveLength(2);
    });
  }

  test("a hung agy (it ignored its own --print-timeout) is killed at Winter's deadline and not asked again for hours", async () => {
    const fake = fakeAgy(tempDir("bin"), "hang");
    let now = NOW;
    const { svc, db } = service({ agyExecutable: () => fake.path, agyCliTimeoutMs: 2_000, now: () => now });
    expect((await svc.antigravityPlan()).source).toBe("none");
    expect(db.latch(binaryKey("agy", fake.path)!)).toBeUndefined();
    const ran = () => marks(fake.markerPath).length;
    const first = ran();
    now += 60 * 60_000;
    await svc.antigravityPlan();
    expect(ran()).toBe(first);
    now += 5 * 3_600_000 + 60_000;
    await svc.antigravityPlan();
    expect(ran()).toBe(first + 1);
  });

  test("not on this Mac: no slot; tracking off: nothing spawned", async () => {
    expect((await service().svc.antigravityPlan()).source).toBe("not-installed");
    const fake = fakeAgy(tempDir("bin"), "ok");
    const off = service({ agyExecutable: () => fake.path, tracking: () => ({ codex: true, claudeCode: true, antigravity: false, opencode: false }) });
    expect((await off.svc.antigravityPlan()).source).toBe("disabled");
    expect(marks(fake.markerPath)).toHaveLength(0);
  });

  test("usage.summary carries plans.antigravity beside the other two", async () => {
    const fake = fakeAgy(tempDir("bin"), "ok");
    const { svc } = service({ agyExecutable: () => fake.path });
    const s = await svc.summary("24h");
    expect(s.plans?.antigravity.source).toBe("agy-cli");
    expect(s.plans?.codex.source).toBe("not-installed");
    expect(s.tracking.antigravity).toBe(true);
  });
});
