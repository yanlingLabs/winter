import { describe, expect, test } from "bun:test";
import { MAIN_THREAD } from "../../src/projector";
import {
  accept, assistantText, assistantToolUse, beginTurn, init, makeProjector, modelUsage, result, run, toolResult,
} from "./harness";

type TC = { type: string; stopReason?: string; inputTokens?: number; outputTokens?: number; contextTokens?: number; message?: string; code?: string };

describe("projector: the terminal rule (Winter 8b Task 10)", () => {
  test("a clean result is ONE turn_completed(end_turn) on the main thread", () => {
    const { projector } = makeProjector();
    accept(projector, init());
    accept(projector, assistantText("done"));
    const out = accept(projector, result({ result: "done" }));
    expect(out.map((e) => e.type)).toEqual(["turn_completed"]);
    expect(out[0]).toMatchObject({ stopReason: "end_turn", threadId: MAIN_THREAD });
  });

  test("an is_error result emits BOTH agent_error AND turn_completed(error), agent_error FIRST", () => {
    // The engine emits the pair (engine.ts:2905-2906) and the golden pins it. A projector written
    // as "either/or" reads plausibly and loses one of the two.
    const { projector } = makeProjector();
    accept(projector, init());
    beginTurn(projector, "do it");
    const out = accept(projector, result({ subtype: "error_during_execution", is_error: true, result: "a tool blew up" }));
    expect(out.map((e) => e.type)).toEqual(["agent_error", "turn_completed"]);
    expect(out[0] as TC).toMatchObject({ code: "tool_failure" });
    expect(out[1]).toMatchObject({ stopReason: "error" });
  });

  test("an `error_*` subtype is an error even when is_error is absent, and names its own class", () => {
    const { projector } = makeProjector();
    beginTurn(projector, "do it");
    const out = accept(projector, result({ subtype: "error_max_turns", result: "" }));
    expect(out.map((e) => e.type)).toEqual(["agent_error", "turn_completed"]);
    expect(out[0] as TC).toMatchObject({ code: "max_turns" });
  });

  test("classification precedence: the provider taxonomy beats api_error_status beats terminal_reason beats subtype", () => {
    // A fresh projector per case: a second `result` with no turn in between is a protocol
    // violation and is dropped (see the test below), which would make every case after the first
    // read as `undefined`.
    const codeOf = (over: Record<string, unknown>) => {
      const { projector } = makeProjector();
      beginTurn(projector, "do it");
      return (accept(projector, result({ is_error: true, ...over }))[0] as TC).code;
    };
    // taxonomy wins over a status that would say something else
    expect(codeOf({ error: "rate_limit", api_error_status: 500, subtype: "error_max_turns" })).toBe("rate_limit");
    // status wins over terminal_reason and subtype
    expect(codeOf({ api_error_status: 401, terminal_reason: "api_error", subtype: "error_max_turns" })).toBe("auth");
    // terminal_reason wins over subtype
    expect(codeOf({ terminal_reason: "structured_output_retry_exhausted", subtype: "error_during_execution" })).toBe("structured_output_exhausted");
    // subtype is the last structural signal before unknown_error
    expect(codeOf({ subtype: "error_max_budget_usd" })).toBe("max_budget");
    expect(codeOf({ subtype: "success" })).toBe("unknown_error");
  });

  test("an api failure landing on subtype `success` with is_error is still an error (surface map §4.8 item 3)", () => {
    const { projector } = makeProjector();
    beginTurn(projector, "do it");
    const out = accept(projector, result({ subtype: "success", is_error: true, result: "500", terminal_reason: "api_error", api_error_status: 500 }));
    expect(out.map((e) => e.type)).toEqual(["agent_error", "turn_completed"]);
    expect(out[1]).toMatchObject({ stopReason: "error" });
  });

  test("`interrupted: true` is a TURN BOUNDARY: turn_completed(aborted) and NO agent_error (P8b-24)", () => {
    // A frameless turn — the user hits stop before the first token. THIS is the shape that made
    // `beginTurn` necessary: with no push door, a turn whose first event is its terminal is
    // indistinguishable from a duplicate terminal, and P8b-24 loses every interrupt but the first.
    const { projector } = makeProjector();
    beginTurn(projector, "start something long");
    const out = accept(projector, result({ interrupted: true }));
    expect(out.map((e) => e.type)).toEqual(["turn_completed"]);
    expect(out[0]).toMatchObject({ stopReason: "aborted" });
  });

  test("interrupted wins over is_error — an interrupt is never reported as a failure", () => {
    const { projector } = makeProjector();
    beginTurn(projector, "do it");
    const out = accept(projector, result({ interrupted: true, is_error: true, subtype: "error_during_execution" }));
    expect(out.map((e) => e.type)).toEqual(["turn_completed"]);
    expect(out[0]).toMatchObject({ stopReason: "aborted" });
  });

  test("EXACTLY ONE terminal per begun turn: the second result inside one turn is dropped and warned", () => {
    const { projector, warnings } = makeProjector();
    accept(projector, init());
    beginTurn(projector, "do it");
    accept(projector, assistantText("one"));
    expect(accept(projector, result()).map((e) => e.type)).toEqual(["turn_completed"]);
    expect(accept(projector, result())).toEqual([]);
    expect(warnings.join(" ")).toContain("no begun turn");
  });

  test("M1: TWO pushed turns get TWO terminals, even when the second turn emits no frame at all", () => {
    // The measured two-envelope tooluse recording, reduced to its terminals. Frame-keyed logic gave
    // ONE turn_completed here and warned about the other — the client's spinner then hangs forever
    // with every unit test green.
    const { projector } = makeProjector();
    accept(projector, init());
    beginTurn(projector, "first user turn");
    accept(projector, assistantText("tool round done"));
    const first = accept(projector, result());
    beginTurn(projector, "second user turn");
    const second = accept(projector, result({ subtype: "error_during_execution", is_error: true, result: "no more scripted turns" }));
    expect(first.map((e) => e.type)).toEqual(["turn_completed"]);
    expect(second.map((e) => e.type)).toEqual(["agent_error", "turn_completed"]);
  });

  test("beginTurn returns the turn_started the host appends — and never a user_message", () => {
    // `turn_started` has a producer on the Winter leg now; `user_message` stays the host's (P8b-5),
    // and a projector that produced one too would double-append the user's turn.
    const { projector } = makeProjector();
    const out = beginTurn(projector, "say hello");
    expect(out.map((e) => e.type)).toEqual(["turn_started"]);
    expect(out[0]).toMatchObject({ threadId: MAIN_THREAD });
    expect(projector.turnRunning).toBe(true);
  });

  test("a result with no begun turn AND no frames is a protocol violation — dropped and warned", () => {
    const { projector, warnings } = makeProjector();
    accept(projector, init());
    expect(accept(projector, result())).toEqual([]);
    expect(warnings.join(" ")).toContain("no begun turn and no frames");
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
    accept(projector, init());
    accept(projector, assistantText("hi"));
    const out = accept(projector, result({ modelUsage: modelUsage(1200, 40) })) as TC[];
    expect(out[0]).toMatchObject({ inputTokens: 1200, outputTokens: 40, contextTokens: 1200 });
  });

  test("cache read/creation tokens count as input — a cached conversation is not under-reported", () => {
    const { projector } = makeProjector();
    accept(projector, assistantText("hi"));
    const out = accept(projector, result({ modelUsage: modelUsage(200, 10, 1000) })) as TC[];
    expect(out[0]).toMatchObject({ inputTokens: 1200, contextTokens: 1200 });
  });

  test("modelUsage is CUMULATIVE, so the SECOND turn reports the DELTA, not the running total", () => {
    const { projector } = makeProjector();
    accept(projector, init());
    accept(projector, assistantText("one"));
    const first = accept(projector, result({ modelUsage: modelUsage(1000, 20) })) as TC[];
    accept(projector, assistantText("two"));
    const second = accept(projector, result({ modelUsage: modelUsage(2500, 55) })) as TC[];
    expect(first[0]).toMatchObject({ inputTokens: 1000, outputTokens: 20 });
    expect(second[0]).toMatchObject({ inputTokens: 1500, outputTokens: 35 });
  });

  test("a MULTI-round turn omits contextTokens rather than over-stating it", () => {
    // The engine's contextTokens is max-over-rounds; a cumulative ledger can only give the SUM,
    // which would drive premature auto-compaction (engine.ts:1689 reads the last positive value).
    // Omitting leaves the trigger on the last EXACT reading. Stated fidelity gap, not an oversight.
    const { projector } = makeProjector();
    accept(projector, init());
    accept(projector, assistantToolUse("t1", "Read", {}));
    accept(projector, toolResult("t1", "contents"));
    accept(projector, assistantText("summary"));
    const out = accept(projector, result({ modelUsage: modelUsage(3300, 37) })) as TC[];
    expect(out[0]).toMatchObject({ inputTokens: 3300, outputTokens: 37 });
    expect(out[0]!.contextTokens).toBeUndefined();
  });

  test("an UNPRICED row (P8b-30): required fields report 0, OPTIONAL contextTokens is OMITTED, logged ONCE", () => {
    // The measured case for every winter-test double, and real for any row Winter cannot price.
    // `turn_completed`'s schema makes inputTokens/outputTokens required and contextTokens optional,
    // so the required pair reports 0 and the optional field is absent — "not known" rather than
    // "measured, and it was nothing". Nothing is fabricated either way.
    const { projector, debugs } = makeProjector();
    accept(projector, init());
    accept(projector, assistantText("one"));
    const first = accept(projector, result()) as TC[];
    expect(first[0]).toMatchObject({ inputTokens: 0, outputTokens: 0 });
    expect(first[0]!.contextTokens).toBeUndefined();
    expect(Object.keys(first[0]!)).not.toContain("contextTokens");

    // ONE line per session, not one per turn: an unpriced row is a property of the model.
    accept(projector, assistantText("two"));
    accept(projector, result());
    expect(debugs.filter((d) => d.includes("unpriced catalog row")).length).toBe(1);
  });

  test("usage that goes BACKWARDS (a ledger reset on resume) clamps to zero, never negative", () => {
    const { projector } = makeProjector();
    accept(projector, assistantText("one"));
    accept(projector, result({ modelUsage: modelUsage(5000, 100) }));
    accept(projector, assistantText("two"));
    const out = accept(projector, result({ modelUsage: modelUsage(10, 1) })) as TC[];
    expect(out[0]).toMatchObject({ inputTokens: 0, outputTokens: 0 });
  });

  test("contextTokens is keyed to the SESSION'S model row — an auxiliary model cannot inflate it (m6)", () => {
    // `contextTokens` answers "how full is this conversation's context", which is a fact about the
    // main loop's model. Winter's ledger is keyed by model and §4.2 says nothing about whether the
    // compaction summariser / classifier / advisor accrue into it — so summing every row would let
    // an auxiliary call inflate a figure labelled EXACT. Keying to the init model closes that
    // without needing to prove what the ledger does.
    const { projector } = makeProjector();
    accept(projector, init({ model: "winter-test/echo" }));
    beginTurn(projector, "do it");
    accept(projector, assistantText("hi"));
    const out = accept(projector, result({
      modelUsage: {
        "winter-test/echo": { inputTokens: 1200, outputTokens: 40, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
        "some/summariser": { inputTokens: 9000, outputTokens: 100, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      },
    })) as TC[];
    // the user is still charged for both rows...
    expect(out[0]).toMatchObject({ inputTokens: 10200, outputTokens: 140 });
    // ...but the CONTEXT figure is the session's own model's, not the sum
    expect(out[0]).toMatchObject({ contextTokens: 1200 });
  });

  test("with NO init seen, contextTokens degrades to the summed input — stated, not hidden", () => {
    const { projector } = makeProjector();
    beginTurn(projector, "do it");
    accept(projector, assistantText("hi"));
    const out = accept(projector, result({ modelUsage: modelUsage(1200, 40) })) as TC[];
    expect(out[0]).toMatchObject({ contextTokens: 1200 });
  });

  test("a terminal with priced usage but ZERO assistant rounds omits contextTokens (m8: `rounds === 1`)", () => {
    // Zero observed rounds is not "one round, therefore exact" — it is a measurement nobody made.
    const { projector } = makeProjector();
    accept(projector, init());
    beginTurn(projector, "do it");
    const out = accept(projector, result({ modelUsage: modelUsage(1200, 40) })) as TC[];
    expect(out[0]!.contextTokens).toBeUndefined();
  });

  test("usage totals across several model rows are summed", () => {
    const { projector } = makeProjector();
    accept(projector, assistantText("hi"));
    const out = accept(projector, result({
      modelUsage: {
        a: { inputTokens: 100, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
        b: { inputTokens: 200, outputTokens: 7, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      },
    })) as TC[];
    expect(out[0]).toMatchObject({ inputTokens: 300, outputTokens: 12 });
  });
});

// ── AGENT SDK 0.0.17 (P-B1): the ledger is no longer the main loop's ────────────────────────────
//
// Two changes arrive together — the main row is keyed by the QUALIFIED `provider/model` catalog key
// (while the daemon passes the BARE id at the spawn boundary, so `init.model` is bare), and subagent
// spend plus the web tools' inner passes are priced into the same ledger. The old reading
// (`model === init.model`, else SUM every row) therefore missed on every Winter-leg session and
// inflated `contextTokens` by a child's whole run — which drives premature, repeated auto-compaction.
describe("projector: contextTokens under a QUALIFIED ledger (SDK 0.0.17, P-B1)", () => {
  /** The real Winter-leg 0.0.17 init: `model` is the bare id, `winter_provider.modelKey` is the row key. */
  const qualifiedInit = (modelId: string, providerId: string) =>
    init({ model: modelId, winter_provider: { providerId, modelKey: `${providerId}/${modelId}` } });

  const row = (input: number, output: number) => ({
    inputTokens: input, outputTokens: output, cacheReadInputTokens: 0, cacheCreationInputTokens: 0,
    webSearchRequests: 0, costUSD: 0, costBasis: "list",
  });

  test("the main row is found by `winter_provider.modelKey`, and a CHILD's row never inflates it", () => {
    const { projector } = makeProjector();
    accept(projector, qualifiedInit("gpt-5.6-terra", "codex-oauth"));
    accept(projector, assistantText("hi"));
    const out = accept(projector, result({
      modelUsage: {
        "codex-oauth/gpt-5.6-terra": row(1200, 40),
        // A subagent on another model — priced and rolled up since 0.0.17.
        "openai/gpt-5.6-luna": row(9000, 300),
      },
    })) as TC[];
    // spend is the whole tree (deliberate: it is what the turn cost)...
    expect(out[0]).toMatchObject({ inputTokens: 10200, outputTokens: 340 });
    // ...the CONTEXT figure is the main row alone, and is emphatically not the 10200 sum.
    expect(out[0]).toMatchObject({ contextTokens: 1200 });
  });

  test("no `winter_provider` (the official leg): `init.model` keys the row, unchanged behaviour", () => {
    const { projector } = makeProjector();
    accept(projector, init({ model: "claude-opus-4-8" }));
    accept(projector, assistantText("hi"));
    const out = accept(projector, result({
      modelUsage: { "claude-opus-4-8": row(800, 20), "claude-haiku-4-5": row(5000, 90) },
    })) as TC[];
    expect(out[0]).toMatchObject({ contextTokens: 800 });
  });

  test("with no `winter_provider`, the UNIQUE row ending in `/${init.model}` is the fallback rung", () => {
    const { projector } = makeProjector();
    accept(projector, init({ model: "gpt-5.6-terra" }));   // bare, and no provider extension at all
    accept(projector, assistantText("hi"));
    const out = accept(projector, result({
      modelUsage: { "codex-oauth/gpt-5.6-terra": row(1200, 40), "openai/gpt-5.6-luna": row(700, 9) },
    })) as TC[];
    expect(out[0]).toMatchObject({ contextTokens: 1200 });
  });

  test("TWO rows end in `/${init.model}` — ambiguous, so contextTokens is OMITTED, never guessed and never summed", () => {
    // Two providers can serve the same model id (the WS-20 ruling's whole point), and picking one of
    // two candidates would be a guess presented as an exact reading.
    const { projector } = makeProjector();
    accept(projector, init({ model: "gpt-5.6-terra" }));
    accept(projector, assistantText("hi"));
    const out = accept(projector, result({
      modelUsage: { "codex-oauth/gpt-5.6-terra": row(1200, 40), "openai/gpt-5.6-terra": row(700, 9) },
    })) as TC[];
    expect(out[0]).toMatchObject({ inputTokens: 1900, outputTokens: 49 });
    expect(out[0]!.contextTokens).toBeUndefined();
  });

  test("NO row is the session's own: contextTokens is omitted rather than falling back to the SUM", () => {
    // This is the exact 0.0.17 regression. The old code summed here and reported the sum as exact.
    const { projector } = makeProjector();
    accept(projector, init({ model: "gpt-5.6-terra" }));
    accept(projector, assistantText("hi"));
    const out = accept(projector, result({ modelUsage: { "openai/gpt-5.6-luna": row(9000, 300) } })) as TC[];
    expect(out[0]).toMatchObject({ inputTokens: 9000, outputTokens: 300 });
    expect(out[0]!.contextTokens).toBeUndefined();
  });

  test("an inexact turn does not corrupt the NEXT turn's delta — one omission, then it self-heals", () => {
    const { projector } = makeProjector();
    accept(projector, init({ model: "gpt-5.6-terra" }));
    accept(projector, assistantText("one"));
    // turn 1: nothing matches (inexact, main = 0)
    accept(projector, result({ modelUsage: { "openai/gpt-5.6-luna": row(9000, 300) } }));
    accept(projector, assistantText("two"));
    // turn 2: the session's own row appears — exact, but `previous` was not, so no contextTokens yet
    const second = accept(projector, result({
      modelUsage: { "openai/gpt-5.6-luna": row(9000, 300), "codex-oauth/gpt-5.6-terra": row(1000, 20) },
    })) as TC[];
    expect(second[0]!.contextTokens).toBeUndefined();
    accept(projector, assistantText("three"));
    const third = accept(projector, result({
      modelUsage: { "openai/gpt-5.6-luna": row(9000, 300), "codex-oauth/gpt-5.6-terra": row(1700, 35) },
    })) as TC[];
    expect(third[0]).toMatchObject({ contextTokens: 700 });
  });

  test("`system/model_switch` re-keys the main row AND rebases the delta — a switch does not silently kill contextTokens", () => {
    const { projector } = makeProjector();
    accept(projector, qualifiedInit("gpt-5.6-terra", "codex-oauth"));
    accept(projector, assistantText("one"));
    accept(projector, result({ modelUsage: { "codex-oauth/gpt-5.6-terra": row(1000, 20) } }));
    accept(projector, {
      type: "system", subtype: "model_switch", reason: "set_model",
      from_model: "codex-oauth/gpt-5.6-terra", to_model: "anthropic/claude-opus-5", provider: "anthropic",
    } as never);
    accept(projector, assistantText("two"));
    const out = accept(projector, result({
      modelUsage: { "codex-oauth/gpt-5.6-terra": row(1000, 20), "anthropic/claude-opus-5": row(900, 30) },
    })) as TC[];
    expect(out[0]).toMatchObject({ contextTokens: 900 });
  });
});

describe("projector: contextTokens and the tools that SHARE the main row (0.0.17, P-B1 item 3)", () => {
  const qualifiedInit = () => init({
    model: "gpt-5.6-terra", winter_provider: { providerId: "codex-oauth", modelKey: "codex-oauth/gpt-5.6-terra" },
  });
  const usage = (input: number, output: number) => ({
    "codex-oauth/gpt-5.6-terra": {
      inputTokens: input, outputTokens: output, cacheReadInputTokens: 0, cacheCreationInputTokens: 0,
      webSearchRequests: 0, costUSD: 0, costBasis: "list",
    },
  });

  // A single-round turn with a matched row is exact — UNLESS something else spent on that row.
  test("a WebSearch call omits contextTokens: its inner pass runs on the SESSION'S OWN model", () => {
    const { projector } = makeProjector();
    accept(projector, qualifiedInit());
    accept(projector, assistantToolUse("t1", "WebSearch", { query: "winter" }));
    const out = accept(projector, result({ modelUsage: usage(4000, 60) })) as TC[];
    expect(out[0]).toMatchObject({ inputTokens: 4000 });
    expect(out[0]!.contextTokens).toBeUndefined();
  });

  test("a WebFetch call omits it too — its digest lands on the main row unless a digestModel is stated", () => {
    const { projector } = makeProjector();
    accept(projector, qualifiedInit());
    accept(projector, assistantToolUse("t1", "WebFetch", { url: "https://example.com", prompt: "what" }));
    const out = accept(projector, result({ modelUsage: usage(4000, 60) })) as TC[];
    expect(out[0]!.contextTokens).toBeUndefined();
  });

  test("a subagent spawn omits it: a child on the INHERITED model shares the main row", () => {
    const { projector } = makeProjector();
    accept(projector, qualifiedInit());
    accept(projector, assistantToolUse("t1", "Agent", { description: "look", prompt: "look" }));
    const out = accept(projector, result({ modelUsage: usage(4000, 60) })) as TC[];
    expect(out[0]!.contextTokens).toBeUndefined();
  });

  test("a plain single-round turn on the same shapes still REPORTS it — the guard is not a blanket off switch", () => {
    const { projector } = makeProjector();
    accept(projector, qualifiedInit());
    accept(projector, assistantToolUse("t1", "Read", { file_path: "a.txt" }));
    const out = accept(projector, result({ modelUsage: usage(4000, 60) })) as TC[];
    expect(out[0]).toMatchObject({ contextTokens: 4000 });
  });

  test("the window is TERMINAL-to-terminal: a task frame arriving while idle omits the NEXT turn's figure", () => {
    // 0.0.16 runs subagents in the background by default, so a child's spend lands in the cumulative
    // ledger BETWEEN turns. A flag cleared at turn start would miss exactly that.
    const { projector } = makeProjector();
    accept(projector, qualifiedInit());
    accept(projector, assistantText("one"));
    accept(projector, result({ modelUsage: usage(1000, 20) }));
    accept(projector, { type: "system", subtype: "task_notification", task_id: "bg-1", status: "completed" } as never);
    accept(projector, assistantText("two"));
    const out = accept(projector, result({ modelUsage: usage(2000, 40) })) as TC[];
    expect(out[0]).toMatchObject({ inputTokens: 1000 });
    expect(out[0]!.contextTokens).toBeUndefined();
  });

  test("a BACKGROUND child still open at the terminal omits it, frame or no frame", () => {
    const { projector } = makeProjector();
    accept(projector, qualifiedInit());
    accept(projector, assistantToolUse("t1", "Agent", { description: "look", prompt: "look", run_in_background: true }));
    accept(projector, toolResult("t1", JSON.stringify({ status: "async_launched", agentId: "a-1", taskId: "bg-1" })));
    accept(projector, result({ modelUsage: usage(1000, 20) }));
    // The spawn's own turn is covered by the tool_use above; THIS turn is the one that must stay
    // guarded because the child is still running and still spending.
    accept(projector, assistantText("meanwhile"));
    const out = accept(projector, result({ modelUsage: usage(1800, 35) })) as TC[];
    expect(out[0]!.contextTokens).toBeUndefined();
  });
});
