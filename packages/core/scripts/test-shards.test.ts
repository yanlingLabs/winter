import { describe, expect, test } from "bun:test";
import { isClearCrash, parseSummary, runAll, type ShardResult, verdict } from "./test-shards";

const ok = (shard: number, files = 154): ShardResult => ({ shard, exitCode: 0, tests: 100, files });
const good = [ok(1), ok(2), ok(3, 153)];

describe("test-shards aggregation", () => {
  test("a clean 3-way partition passes", () => expect(verdict(good, 3, 461)).toEqual([]));
  test("a failing middle shard fails the step", () => {
    expect(verdict([ok(1), { ...ok(2), exitCode: 1 }, ok(3, 153)], 3, 461)).not.toEqual([]);
  });
  test("a signal death (exit null / 133) fails the step", () => {
    expect(verdict([ok(1), ok(2), { ...ok(3, 153), exitCode: null, signal: "SIGSEGV" }], 3, 461)).not.toEqual([]);
    expect(verdict([ok(1), ok(2), { ...ok(3, 153), exitCode: 133 }], 3, 461)).not.toEqual([]);
  });
  test("a crash with no summary line fails even with exit 0", () => {
    expect(verdict([ok(1), { shard: 2, exitCode: 0, tests: null, files: null }, ok(3, 153)], 3, 461)).not.toEqual([]);
  });
  test("a missing shard result fails", () => expect(verdict([ok(1), ok(3, 153)], 3, 461)).not.toEqual([]));
  test("a shard that ran 0 files fails", () => {
    expect(verdict([ok(1), ok(2, 0), ok(3, 153)], 3, 307)).not.toEqual([]);
  });
  test("dropped files (sum below the glob's count) fail", () => expect(verdict(good, 3, 500)).not.toEqual([]));
  test("an uneven split fails", () => expect(verdict([ok(1, 300), ok(2, 5), ok(3, 156)], 3, 461)).not.toEqual([]));
  test("parseSummary reads bun's line and ignores the rest", () => {
    expect(parseSummary("x\nRan 2461 tests across 154 files. [104.29s]\n")).toEqual({ tests: 2461, files: 154 });
    expect(parseSummary("no summary here")).toBeNull();
  });
});

const crash: ShardResult = { shard: 2, exitCode: 133, tests: null, files: null };
const scripted = (plan: Record<number, ShardResult[]>) => {
  const calls: number[] = [];
  const run = async (s: number) => {
    calls.push(s);
    return (plan[s] as ShardResult[]).shift() as ShardResult;
  };
  return { run, calls };
};

describe("test-shards crash retry", () => {
  test("isClearCrash: 133 or a signal without a summary only", () => {
    expect(isClearCrash(crash)).toBe(true);
    expect(isClearCrash({ ...crash, exitCode: null, signal: "SIGSEGV" })).toBe(true);
    expect(isClearCrash({ ...crash, exitCode: 1 })).toBe(false);
    expect(isClearCrash({ ...crash, tests: 5, files: 3 })).toBe(false);
  });
  test("crash then pass: retried once, passes, warns", async () => {
    const { run, calls } = scripted({ 1: [ok(1)], 2: [crash, ok(2)], 3: [ok(3, 153)] });
    const lines: string[] = [];
    const results = await runAll(3, run, (l) => lines.push(l));
    expect(calls).toEqual([1, 2, 2, 3]);
    expect(verdict(results, 3, 461)).toEqual([]);
    expect(lines.some((l) => l.startsWith("::warning::shard 2/3 crashed"))).toBe(true);
    expect(lines.some((l) => l.includes("shard 2/3 crashed (Bun exit 133, no summary)"))).toBe(true);
  });
  test("crash then crash: fails the step", async () => {
    const { run, calls } = scripted({ 1: [ok(1)], 2: [crash, crash], 3: [ok(3, 153)] });
    const results = await runAll(3, run, () => {});
    expect(calls).toEqual([1, 2, 2, 3]);
    expect(verdict(results, 3, 461)).not.toEqual([]);
  });
  test("a non-crash failure is not retried", async () => {
    const { run, calls } = scripted({ 1: [ok(1)], 2: [{ ...ok(2), exitCode: 1 }], 3: [ok(3, 153)] });
    const results = await runAll(3, run, () => {});
    expect(calls).toEqual([1, 2, 3]);
    expect(verdict(results, 3, 461)).not.toEqual([]);
  });
  test("133 WITH a summary (tests failed, then a crash) is not retried", async () => {
    const { run, calls } = scripted({ 1: [ok(1)], 2: [{ ...ok(2), exitCode: 133 }], 3: [ok(3, 153)] });
    const results = await runAll(3, run, () => {});
    expect(calls).toEqual([1, 2, 3]);
    expect(verdict(results, 3, 461)).not.toEqual([]);
  });
});
