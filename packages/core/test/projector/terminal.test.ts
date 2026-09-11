import { describe, expect, test } from "bun:test";
import { MAIN_THREAD } from "../../src/projector";
import { assistantText, assistantToolUse, init, makeProjector, modelUsage, result, run, toolResult } from "./harness";

type TC = { type: string; stopReason?: string; inputTokens?: number; outputTokens?: number; contextTokens?: number; message?: string; code?: string };

describe("projector: the terminal rule (Winter 8b Task 10)", () => {
  test("a clean result is ONE turn_completed(end_turn) on the main thread", () => {
    const { projector } = makeProjector();
    projector.accept(init());
    projector.accept(assistantText("done"));
    const out = projector.accept(result({ result: "done" }));
    expect(out.map((e) => e.type)).toEqual(["turn_completed"]);
    expect(out[0]).toMatchObject({ stopReason: "end_turn", threadId: MAIN_THREAD });
  });

  test("an is_error result emits BOTH agent_error AND turn_completed(error), agent_error FIRST", () => {
    // The engine emits the pair (engine.ts:2905-2906) and the golden pins it. A projector written
    // as "either/or" reads plausibly and loses one of the two.
    const { projector } = makeProjector();
    projector.accept(init());
    const out = projector.accept(result({ subtype: "error_during_execution", is_error: true, result: "HTTP 429: rate limited" }));
    expect(out.map((e) => e.type)).toEqual(["agent_error", "turn_completed"]);
    expect(out[0] as TC).toMatchObject({ message: "HTTP 429: rate limited", code: "result_error" });
    expect(out[1]).toMatchObject({ stopReason: "error" });
  });

  test("an `error_*` subtype is an error even when is_error is absent", () => {
    const { projector } = makeProjector();
    const out = projector.accept(result({ subtype: "error_max_turns", result: "" }));
    expect(out.map((e) => e.type)).toEqual(["agent_error", "turn_completed"]);
    expect((out[0] as TC).message).toContain("error_max_turns");
  });

  test("terminal_reason is appended to the message when it adds something", () => {
    const { projector } = makeProjector();
    const out = projector.accept(result({ subtype: "success", is_error: true, result: "upstream failed", terminal_reason: "api_error" }));
    expect((out[0] as TC).message).toBe("upstream failed (api_error)");
  });

  test("an api failure landing on subtype `success` with is_error is still an error (surface map §4.8 item 3)", () => {
    const { projector } = makeProjector();
    const out = projector.accept(result({ subtype: "success", is_error: true, result: "500", terminal_reason: "api_error", api_error_status: 500 }));
    expect(out.map((e) => e.type)).toEqual(["agent_error", "turn_completed"]);
    expect(out[1]).toMatchObject({ stopReason: "error" });
  });

  test("`interrupted: true` is a TURN BOUNDARY: turn_completed(aborted) and NO agent_error (P8b-24)", () => {
    const { projector } = makeProjector();
    const out = projector.accept(result({ interrupted: true }));
    expect(out.map((e) => e.type)).toEqual(["turn_completed"]);
    expect(out[0]).toMatchObject({ stopReason: "aborted" });
  });

  test("interrupted wins over is_error — an interrupt is never reported as a failure", () => {
    const { projector } = makeProjector();
    const out = projector.accept(result({ interrupted: true, is_error: true, subtype: "error_during_execution" }));
    expect(out.map((e) => e.type)).toEqual(["turn_completed"]);
    expect(out[0]).toMatchObject({ stopReason: "aborted" });
  });

  test("a SECOND result with no turn running is a protocol violation: logged and dropped", () => {
    const { projector, warnings } = makeProjector();
    projector.accept(init());
    projector.accept(assistantText("one"));
    expect(projector.accept(result()).map((e) => e.type)).toEqual(["turn_completed"]);
    expect(projector.accept(result())).toEqual([]);
    expect(warnings.join(" ")).toContain("second result");
  });

  test("a new turn after a terminal starts cleanly and produces its own terminal", () => {
    const { projector } = makeProjector();
    const out = run(projector, [init(), assistantText("one"), result(), assistantText("two"), result()]);
    expect(out.map((e) => e.type)).toEqual(["assistant_message", "turn_completed", "assistant_message", "turn_completed"]);
  });
});

describe("projector: turn_completed usage (the contextTokens contract)", () => {
  test("a single-round priced turn sets inputTokens, outputTokens AND contextTokens exactly", () => {
    const { projector } = makeProjector();
    projector.accept(init());
    projector.accept(assistantText("hi"));
    const out = projector.accept(result({ modelUsage: modelUsage(1200, 40) })) as TC[];
    expect(out[0]).toMatchObject({ inputTokens: 1200, outputTokens: 40, contextTokens: 1200 });
  });

  test("cache read/creation tokens count as input — a cached conversation is not under-reported", () => {
    const { projector } = makeProjector();
    projector.accept(assistantText("hi"));
    const out = projector.accept(result({ modelUsage: modelUsage(200, 10, 1000) })) as TC[];
    expect(out[0]).toMatchObject({ inputTokens: 1200, contextTokens: 1200 });
  });

  test("modelUsage is CUMULATIVE, so the SECOND turn reports the DELTA, not the running total", () => {
    const { projector } = makeProjector();
    projector.accept(init());
    projector.accept(assistantText("one"));
    const first = projector.accept(result({ modelUsage: modelUsage(1000, 20) })) as TC[];
    projector.accept(assistantText("two"));
    const second = projector.accept(result({ modelUsage: modelUsage(2500, 55) })) as TC[];
    expect(first[0]).toMatchObject({ inputTokens: 1000, outputTokens: 20 });
    expect(second[0]).toMatchObject({ inputTokens: 1500, outputTokens: 35 });
  });

  test("a MULTI-round turn omits contextTokens rather than over-stating it", () => {
    // The engine's contextTokens is max-over-rounds; a cumulative ledger can only give the SUM,
    // which would drive premature auto-compaction (engine.ts:1689 reads the last positive value).
    // Omitting leaves the trigger on the last EXACT reading. Stated fidelity gap, not an oversight.
    const { projector } = makeProjector();
    projector.accept(init());
    projector.accept(assistantToolUse("t1", "Read", {}));
    projector.accept(toolResult("t1", "contents"));
    projector.accept(assistantText("summary"));
    const out = projector.accept(result({ modelUsage: modelUsage(3300, 37) })) as TC[];
    expect(out[0]).toMatchObject({ inputTokens: 3300, outputTokens: 37 });
    expect(out[0]!.contextTokens).toBeUndefined();
  });

  test("an UNPRICED row emits no modelUsage: zeros, and contextTokens omitted — nothing fabricated", () => {
    // The measured case for every winter-test double.
    const { projector } = makeProjector();
    projector.accept(assistantText("hi"));
    const out = projector.accept(result()) as TC[];
    expect(out[0]).toMatchObject({ inputTokens: 0, outputTokens: 0 });
    expect(out[0]!.contextTokens).toBeUndefined();
  });

  test("usage that goes BACKWARDS (a ledger reset on resume) clamps to zero, never negative", () => {
    const { projector } = makeProjector();
    projector.accept(assistantText("one"));
    projector.accept(result({ modelUsage: modelUsage(5000, 100) }));
    projector.accept(assistantText("two"));
    const out = projector.accept(result({ modelUsage: modelUsage(10, 1) })) as TC[];
    expect(out[0]).toMatchObject({ inputTokens: 0, outputTokens: 0 });
  });

  test("usage totals across several model rows are summed", () => {
    const { projector } = makeProjector();
    projector.accept(assistantText("hi"));
    const out = projector.accept(result({
      modelUsage: {
        a: { inputTokens: 100, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
        b: { inputTokens: 200, outputTokens: 7, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      },
    })) as TC[];
    expect(out[0]).toMatchObject({ inputTokens: 300, outputTokens: 12 });
  });
});
