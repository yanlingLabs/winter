import { describe, expect, test } from "bun:test";
import { parseSummary, type ShardResult, verdict } from "./test-shards";

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
