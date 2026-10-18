// Plan readings (`docs/claude/usage.md`): the Codex ladder (its app-server → the newest rollout's `rate_limits` →
// Winter's own codex-oauth report) and the Claude Code ladder (its own `/usage` → `~/.claude.json`'s cache), with
// FAKE executables only, the staleness rule, the throttles, and the guard on `/usage`.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { UsageDb } from "../../src/usage/db";
import { UsagePricer } from "../../src/usage/pricing";
import { UsageService, type UsageServiceDeps } from "../../src/usage/service";
import { staleness } from "../../src/usage/plan";
import { CLAUDE_USAGE_ARGS } from "../../src/usage/claude-code";
import {
  SECRETS, claudeJson, codexMeta, codexRateLimits, codexRolloutPath, codexTokenCount, codexTurnContext, fakeClaude, fakeCodex, lines, tempDir,
} from "./fixtures";

const pricer = new UsagePricer();
const NOW = Date.now();
const sec = (ms: number) => Math.floor(ms / 1000);

function service(over: Partial<UsageServiceDeps> & { logs?: string[] } = {}) {
  const home = tempDir("home");
  const db = new UsageDb(join(home, "usage", "usage.db"));
  const logs = over.logs ?? [];
  const svc = new UsageService({
    db, pricer, tracking: () => ({ codex: true, claudeCode: true }),
    codexExecutable: () => undefined, claudeExecutable: () => undefined, winterCodexWindows: () => [],
    neutralCwd: () => home, ingestEveryMs: 0, planWaitMs: 20_000,
    log: { warn: (m, meta) => logs.push(`${m} ${JSON.stringify(meta ?? {})}`), info: (m, meta) => logs.push(`${m} ${JSON.stringify(meta ?? {})}`) },
    ...over,
  });
  return { home, db, svc, logs };
}

function marks(markerPath: string): Array<{ argv: string[]; cwd: string; pid: number }> {
  return existsSync(markerPath) ? readFileSync(markerPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Gone within `ms` (a killed child is a zombie until it is reaped, which a loaded machine can take a moment over). */
async function goneWithin(pid: number, ms = 3_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (alive(pid) && Date.now() < end) await Bun.sleep(25);
  return !alive(pid);
}

describe("staleness", () => {
  test("stale when older than its window, or when its reset has passed", () => {
    const now = 1_000_000_000_000;
    expect(staleness(now - 60_000, 300, now + 3_600_000, now)).toEqual({ stale: false });
    expect(staleness(now - 301 * 60_000, 300, now + 3_600_000, now)).toEqual({ stale: true, staleReason: "older_than_window" });
    expect(staleness(now - 60_000, 10_080, now - 1, now)).toEqual({ stale: true, staleReason: "reset_passed" });
    expect(staleness(undefined, undefined, undefined, now)).toEqual({ stale: false });
  });
});

describe("the Codex plan", () => {
  function rollouts(codexHome: string, at: number, primary: number, secondary: number, resets: { primary: number; secondary: number }) {
    const file = codexRolloutPath(codexHome, at, `r${at}`);
    writeFileSync(file, lines(codexMeta(at, `s${at}`), codexTurnContext(at, "gpt-5.1"),
      codexTokenCount(at, { input: 1, cached: 0, output: 1, reasoning: 0 }, { input: 1, cached: 0, output: 1, reasoning: 0 }, codexRateLimits(primary, secondary, resets)),
      // A later count with NO rate limits: the tail is read back past it.
      codexTokenCount(at + 1, { input: 2, cached: 0, output: 2, reasoning: 0 }, { input: 1, cached: 0, output: 1, reasoning: 0 })));
    return file;
  }

  test("the app-server answers first: real percentages, resets, plan type; one spawn per throttle window; the process is gone after", async () => {
    const bin = tempDir("bin");
    const fake = fakeCodex(bin, "ok", { primary: 12, secondary: 40, resetsAtSec: sec(NOW + 3_600_000) });
    let now = NOW;
    const { svc, home } = service({ codexExecutable: () => fake.path, now: () => now, codexAppServerEveryMs: 60_000 });
    const plan = await svc.codexPlan();
    expect(plan.source).toBe("codex-app-server");
    expect(plan.planType).toBe("pro");
    expect(plan.credits).toEqual({ hasCredits: true, unlimited: false, balance: "12" });
    expect(plan.windows.map((w) => [w.kind, w.usedPercent, w.stale])).toEqual([["five_hour", 12, false], ["weekly", 40, false]]);
    expect(plan.windows[0]!.resetsAt).toBe(sec(NOW + 3_600_000) * 1000);
    expect(JSON.stringify(plan).includes("acct-should-not-matter")).toBe(false);
    const m = marks(fake.markerPath);
    expect(m).toHaveLength(1);
    expect(m[0]!.argv).toEqual(["app-server"]);
    expect(m[0]!.cwd.endsWith(home.split("/").pop()!)).toBe(true);
    // Cached within the window; asked again after it.
    now += 30_000;
    await svc.codexPlan();
    expect(marks(fake.markerPath)).toHaveLength(1);
    now += 31_000;
    await svc.codexPlan();
    expect(marks(fake.markerPath)).toHaveLength(2);
    for (const x of marks(fake.markerPath)) expect(await goneWithin(x.pid)).toBe(true);
  });

  test("a hung app-server is killed at the timeout, and the rollout answers (with its age and staleness)", async () => {
    const bin = tempDir("bin");
    const fake = fakeCodex(bin, "hang");
    const codexHome = tempDir("codex");
    rollouts(codexHome, NOW - 10 * 60_000, 2, 34, { primary: sec(NOW + 3_600_000), secondary: sec(NOW + 86_400_000) });
    const { svc, logs } = service({ codexExecutable: () => fake.path, codexHome, appServerTimeoutMs: 1_200 });
    const started = Date.now();
    const plan = await svc.codexPlan();
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(plan.source).toBe("codex-rollout");
    expect(plan.at).toBe(NOW - 10 * 60_000);
    expect(plan.windows.map((w) => [w.kind, w.usedPercent, w.stale])).toEqual([["five_hour", 2, false], ["weekly", 34, false]]);
    // (A child killed before it even started writes no mark: nothing left to check then.)
    for (const m of marks(fake.markerPath)) expect(await goneWithin(m.pid)).toBe(true);
    expect(logs.some((l) => l.includes("timeout"))).toBe(true);
  });

  test("a malformed or refused reply falls back to the rollout; a missing binary too", async () => {
    for (const mode of ["malformed", "error"] as const) {
      const fake = fakeCodex(tempDir("bin"), mode);
      const codexHome = tempDir("codex");
      rollouts(codexHome, NOW - 60_000, 5, 6, { primary: sec(NOW + 3_600_000), secondary: sec(NOW + 86_400_000) });
      const { svc } = service({ codexExecutable: () => fake.path, codexHome });
      expect((await svc.codexPlan()).source).toBe("codex-rollout");
    }
    const codexHome = tempDir("codex");
    rollouts(codexHome, NOW - 60_000, 5, 6, { primary: sec(NOW + 3_600_000), secondary: sec(NOW + 86_400_000) });
    const { svc } = service({ codexExecutable: () => undefined, codexHome });
    expect((await svc.codexPlan()).source).toBe("codex-rollout");
  });

  test("the NEWEST rollout's last rate_limits; stale when older than its window or past its reset", async () => {
    const codexHome = tempDir("codex");
    const old = rollouts(codexHome, NOW - 6 * 3_600_000, 90, 91, { primary: sec(NOW - 3_600_000), secondary: sec(NOW + 86_400_000) });
    utimesSync(old, new Date(NOW - 6 * 3_600_000), new Date(NOW - 6 * 3_600_000));
    const { svc } = service({ codexHome });
    let plan = await svc.codexPlan();
    // Six hours old: the 5-hour window is past its reset (and older than its window); the weekly one still holds.
    expect(plan.windows.map((w) => [w.kind, w.usedPercent, w.stale, w.staleReason])).toEqual([["five_hour", 90, true, "reset_passed"], ["weekly", 91, false, undefined]]);
    rollouts(codexHome, NOW - 60_000, 3, 4, { primary: sec(NOW + 3_600_000), secondary: sec(NOW + 86_400_000) });
    plan = await svc.codexPlan();
    expect(plan.windows.map((w) => w.usedPercent)).toEqual([3, 4]);
  });

  test("no Codex at all: Winter's own codex-oauth report, status only, labelled; none without it", async () => {
    const { svc } = service({ winterCodexWindows: () => [{ rateLimitType: "five_hour", status: "allowed", at: NOW - 1000, resetsAt: NOW + 1000 }] });
    const plan = await svc.codexPlan();
    expect(plan).toMatchObject({ source: "winter-codex-oauth", windows: [], statusOnly: [{ rateLimitType: "five_hour", status: "allowed" }] });
    expect((await service().svc.codexPlan()).source).toBe("none");
  });

  test("tracking off: nothing is spawned or read", async () => {
    const fake = fakeCodex(tempDir("bin"), "ok");
    const { svc } = service({ codexExecutable: () => fake.path, tracking: () => ({ codex: false, claudeCode: false }) });
    expect((await svc.codexPlan()).source).toBe("disabled");
    expect((await svc.claudeCodePlan()).source).toBe("disabled");
    expect(marks(fake.markerPath)).toHaveLength(0);
  });
});

describe("a plan read never holds a client past its short wait", () => {
  test("a slow spawn: the first ask answers from the next rung, the spawn finishes in the background, the next ask has it", async () => {
    const bin = tempDir("bin");
    // A Claude CLI that takes ~1 s.
    const slow = fakeClaude(bin, "ok");
    const wrapper = join(bin, "slow-claude");
    writeFileSync(wrapper, `#!/bin/sh\nsleep 1\nexec "${slow.path}" "$@"\n`);
    require("node:fs").chmodSync(wrapper, 0o755);
    const { svc } = service({ claudeExecutable: () => wrapper, planWaitMs: 100 });
    const started = Date.now();
    expect((await svc.claudeCodePlan()).source).toBe("none");
    expect(Date.now() - started).toBeLessThan(800);
    const end = Date.now() + 10_000;
    let plan = await svc.claudeCodePlan();
    while (plan.source !== "claude-cli" && Date.now() < end) { await Bun.sleep(100); plan = await svc.claudeCodePlan(); }
    expect(plan.source).toBe("claude-cli");
    expect(marks(slow.markerPath)).toHaveLength(1);
  });
});

describe("the Claude Code plan", () => {
  test("claude's own /usage, with EXACTLY the verified invocation, in the neutral cwd: session, weekly, weekly per model", async () => {
    const fake = fakeClaude(tempDir("bin"), "ok");
    let now = NOW;
    const { svc, home } = service({ claudeExecutable: () => fake.path, now: () => now });
    const plan = await svc.claudeCodePlan();
    expect(plan.source).toBe("claude-cli");
    expect(plan.windows.map((w) => [w.kind, w.usedPercent, w.scope, w.stale])).toEqual([
      ["five_hour", 23, undefined, false], ["weekly", 61, undefined, false], ["weekly_scoped", 80, "opus", false],
    ]);
    expect(JSON.stringify(plan).includes("SECRET")).toBe(false);
    const m = marks(fake.markerPath);
    expect(m[0]!.argv).toEqual([...CLAUDE_USAGE_ARGS]);
    expect(m[0]!.cwd.includes(home.split("/").pop()!)).toBe(true);
    // Throttled to once per five minutes.
    now += 4 * 60_000;
    await svc.claudeCodePlan();
    expect(marks(fake.markerPath)).toHaveLength(1);
    now += 2 * 60_000;
    await svc.claudeCodePlan();
    expect(marks(fake.markerPath)).toHaveLength(2);
  });

  for (const mode of ["no-local-command", "wrong-command", "cost", "turns"] as const) {
    test(`/usage that is not the free local command (${mode}) is REJECTED, and the CLI is not asked again`, async () => {
      const fake = fakeClaude(tempDir("bin"), mode);
      let now = NOW;
      const { svc, logs } = service({ claudeExecutable: () => fake.path, now: () => now });
      expect((await svc.claudeCodePlan()).source).toBe("none");
      expect(logs.some((l) => l.includes("not asked again until restart"))).toBe(true);
      expect(logs.join("\n").includes("SECRET")).toBe(false);
      now += 3_600_000;
      await svc.claudeCodePlan();
      expect(marks(fake.markerPath)).toHaveLength(1);
    });
  }

  test("no usage_report, malformed output and a hang (killed) all fall through to ~/.claude.json — only its one key", async () => {
    for (const mode of ["no-report", "malformed", "hang"] as const) {
      const fake = fakeClaude(tempDir("bin"), mode);
      const jsonPath = join(tempDir("claude-json"), ".claude.json");
      claudeJson(jsonPath, NOW - 120_000, {
        five_hour: { utilization: 42, resets_at: new Date(NOW + 3_600_000).toISOString() },
        seven_day: { utilization: 70, resets_at: new Date(NOW + 3 * 86_400_000).toISOString() },
        seven_day_opus: { utilization: 15, resets_at: new Date(NOW - 1000).toISOString() },
      });
      const logs: string[] = [];
      const { svc, db } = service({ claudeExecutable: () => fake.path, claudeJsonPath: jsonPath, claudeCliTimeoutMs: 1_200, logs });
      const plan = await svc.claudeCodePlan();
      expect(plan.source).toBe("claude-cache");
      expect(plan.at).toBe(NOW - 120_000);
      expect(plan.windows.map((w) => [w.kind, w.usedPercent, w.scope, w.stale])).toEqual([
        ["five_hour", 42, undefined, false], ["weekly", 70, undefined, false], ["weekly_scoped", 15, "opus", true],
      ]);
      const everything = JSON.stringify(plan) + logs.join("\n") + readFileSync(db.path).toString("latin1");
      for (const s of SECRETS) expect(everything.includes(s)).toBe(false);
      expect(everything.includes("someone@example.com")).toBe(false);
      if (mode === "hang") for (const m of marks(fake.markerPath)) expect(await goneWithin(m.pid)).toBe(true);
    }
  });

  test("nothing installed and no cache: none", async () => {
    const { svc } = service({ claudeJsonPath: join(tempDir("x"), "absent.json") });
    expect((await svc.claudeCodePlan()).source).toBe("none");
  });
});
