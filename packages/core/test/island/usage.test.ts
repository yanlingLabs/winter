// The island's Usage tab, daemon half (`island/usage.ts`): plan windows from the runtime's `rate_limit_event` (handed
// over by the projector, still never persisted), per-session token counts from `turn_completed`, and the background
// jobs' quota — read from what the daemon already sees, nothing estimated.
import { describe, expect, test } from "bun:test";
import type { ProtocolSdkMessage } from "../../src/projector/types";
import type { SessionEvent } from "@yanlinglabs/winter-protocol";
import { IslandUsageResult } from "@yanlinglabs/winter-protocol";
import { IslandUsageRegistry, epochMs, ISLAND_USAGE_MAX_SESSIONS } from "../../src/island/usage";
import { accept, makeProjector } from "../projector/harness";

const turn = (sessionId: string, inputTokens: number, outputTokens: number, contextTokens?: number): SessionEvent =>
  ({ seq: 1, ts: "t", type: "turn_completed", sessionId, threadId: "main", stopReason: "end_turn", inputTokens, outputTokens,
     ...(contextTokens === undefined ? {} : { contextTokens }) }) as unknown as SessionEvent;

const background = () => ({ kind: "ok" as const, inputTokens: 10, outputTokens: 5 });

describe("IslandUsageRegistry", () => {
  test("keeps the LATEST report per window kind, resets in ms, only the named scalars", () => {
    const r = new IslandUsageRegistry({ background }, () => 1_000);
    r.noteRateLimit("s1", { status: "allowed", rateLimitType: "five_hour", utilization: 0.4, resetsAt: 1_900_000_000, secret: "x" } as never);
    r.noteRateLimit("s2", { status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.82, resetsAt: 1_900_000_100 });
    r.noteRateLimit("s2", { status: "allowed", rateLimitType: "seven_day", utilization: 0.1 });
    r.noteRateLimit("s3", { rateLimitType: "seven_day" }); // no status: ignored
    const snap = r.snapshot();
    expect(snap.windows).toEqual([
      { rateLimitType: "five_hour", status: "allowed_warning", utilization: 0.82, resetsAt: 1_900_000_100_000, at: 1_000, sessionId: "s2" },
      { rateLimitType: "seven_day", status: "allowed", utilization: 0.1, at: 1_000, sessionId: "s2" },
    ]);
    expect(IslandUsageResult.parse(snap)).toBeTruthy();
  });

  test("sums a session's turn_completed tokens since start and keeps its last measured context", () => {
    const r = new IslandUsageRegistry({ background, modelOf: () => ({ model: "example/model-x", contextWindow: 400_000 }) });
    r.observe(turn("s1", 100, 20, 30_000));
    r.observe(turn("s1", 50, 10));
    r.observe(turn("s2", 1, 1));
    const snap = r.snapshot("s1");
    expect(snap.session).toEqual({ sessionId: "s1", turns: 2, inputTokens: 150, outputTokens: 30, contextTokens: 30_000,
      model: "example/model-x", contextWindow: 400_000 });
    expect(r.snapshot("unknown").session).toEqual({ sessionId: "unknown", turns: 0, inputTokens: 0, outputTokens: 0,
      model: "example/model-x", contextWindow: 400_000 });
    expect(r.snapshot().session).toBeUndefined();
    expect(IslandUsageResult.parse(snap)).toBeTruthy();
  });

  test("the background jobs' quota and subscription snapshot pass through; a failing source never breaks the snapshot", () => {
    const r = new IslandUsageRegistry({
      background: () => ({ kind: "limited", resumeAt: 5, inputTokens: 1, outputTokens: 2 }),
      subscription: () => ({ info: { status: "rejected", resetsAt: 1_800_000_000, other: { deep: true } }, at: 7 }),
      modelOf: () => { throw new Error("boom"); },
    });
    const snap = r.snapshot("s1");
    expect(snap.background).toEqual({ kind: "limited", resumeAt: 5, inputTokens: 1, outputTokens: 2 });
    expect(snap.subscription).toEqual({ status: "rejected", resetsAt: 1_800_000_000_000, at: 7 });
    expect(snap.session?.contextWindow).toBeUndefined();
    const broken = new IslandUsageRegistry({ background: () => { throw new Error("x"); } });
    expect(broken.snapshot().background).toEqual({ kind: "ok", inputTokens: 0, outputTokens: 0 });
  });

  test("is bounded", () => {
    const r = new IslandUsageRegistry({ background });
    for (let i = 0; i < ISLAND_USAGE_MAX_SESSIONS + 10; i++) r.observe(turn(`s${i}`, 1, 1));
    expect(r.snapshot("s0").session?.turns).toBe(0);
    expect(r.snapshot(`s${ISLAND_USAGE_MAX_SESSIONS + 9}`).session?.turns).toBe(1);
    for (let i = 0; i < 40; i++) r.noteRateLimit("s", { status: "allowed", rateLimitType: `k${i}` });
    expect(r.snapshot().windows.length).toBeLessThanOrEqual(16);
  });

  test("epochMs: the runtime's resetsAt is unix seconds; junk is dropped", () => {
    expect(epochMs(1_900_000_000)).toBe(1_900_000_000_000);
    expect(epochMs(-1)).toBeUndefined();
    expect(epochMs("1")).toBeUndefined();
  });
});

test("the pinned runtime's own report (status + resetsAt in seconds, no utilization) becomes a window with no fill", () => {
  const r = new IslandUsageRegistry({ background }, () => 5);
  // Exactly what the provider runtime's quotaEvent writes, as the agent runtime frames it ({status:"allowed", ...info}).
  r.noteRateLimit("s1", { status: "rejected", resetsAt: Math.round(1_900_000_000_500 / 1000) });
  expect(r.snapshot().windows).toEqual([{ status: "rejected", resetsAt: 1_900_000_001_000, at: 5, sessionId: "s1" }]);
});

describe("the projector hands a rate_limit_event to onRateLimit and still persists nothing", () => {
  test("onRateLimit gets the frame's rate_limit_info; a throwing handler is swallowed", () => {
    const seen: Record<string, unknown>[] = [];
    const { projector } = makeProjector({ onRateLimit: (info) => { seen.push(info); } });
    const frame = { type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", rateLimitType: "five_hour", resetsAt: 1 }, uuid: "u", session_id: "s" } as unknown as ProtocolSdkMessage;
    expect(accept(projector, frame)).toEqual([]);
    expect(accept(projector, frame)).toEqual([]);
    expect(seen).toEqual([
      { status: "allowed_warning", rateLimitType: "five_hour", resetsAt: 1 },
      { status: "allowed_warning", rateLimitType: "five_hour", resetsAt: 1 },
    ]);
    const { projector: throwing } = makeProjector({ onRateLimit: () => { throw new Error("boom"); } });
    expect(accept(throwing, frame)).toEqual([]);
  });
});
