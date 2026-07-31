import { describe, expect, test } from "bun:test";
import type { ProviderEvent } from "../../src/providers/types";
import { FakeProvider } from "../../src/agent/fake-provider";
import { CODEX_MODELS } from "../../src/providers/codex-config";
import { DEFAULT_COMPACT_THRESHOLD_FRAC } from "../../src/agent/engine";
import { setupEngine } from "./engine-steer.test";

describe("engine historyInput is checkpoint-aware", () => {
  test("a turn's input is [summary] + only messages AFTER the latest checkpoint's uptoSeq", async () => {
    const provider = new FakeProvider([[{ type: "text_delta", delta: "ok" }, { type: "done", stopReason: "end_turn" }]]);
    const { engine, store, sessionId } = setupEngine(provider);

    // seed u0/a0..u4/a4 (5 pairs)
    for (let i = 0; i < 5; i++) {
      store.append(sessionId, { type: "user_message", sessionId, threadId: "main", text: `u${i}`, clientName: "test" });
      store.append(sessionId, { type: "assistant_message", sessionId, threadId: "main", text: `a${i}` });
    }
    const msgs = store.read(sessionId).filter((e) => e.type === "user_message" || e.type === "assistant_message");
    // checkpoint covers u0..a2 (the first 6 messages); u3/a3, u4/a4 remain as the tail
    const uptoSeq = msgs[5]!.seq; // seq of a2
    store.append(sessionId, { type: "checkpoint", sessionId, threadId: "main", summary: "SUMMARY_TOKEN", uptoSeq });

    await engine.runTurn(sessionId);

    const input = provider.requests[0]!.input;
    const serialized = JSON.stringify(input);

    // summary present, once, as the first item:
    expect(serialized).toContain("[Summary of earlier conversation]");
    expect(serialized).toContain("SUMMARY_TOKEN");
    expect(input[0]).toMatchObject({ type: "message", role: "user", content: "[Summary of earlier conversation]\nSUMMARY_TOKEN" });

    // tail (post-checkpoint) messages present:
    expect(serialized).toContain("u3");
    expect(serialized).toContain("a3");
    expect(serialized).toContain("u4");
    expect(serialized).toContain("a4");

    // pre-checkpoint messages NOT present:
    expect(input.some((it) => "content" in it && it.content === "u0")).toBe(false);
    expect(input.some((it) => "content" in it && it.content === "a0")).toBe(false);
    expect(input.some((it) => "content" in it && it.content === "u1")).toBe(false);
    expect(input.some((it) => "content" in it && it.content === "a2")).toBe(false);
  });

  test("no checkpoint -> full history, unchanged behavior", async () => {
    const provider = new FakeProvider([[{ type: "text_delta", delta: "ok" }, { type: "done", stopReason: "end_turn" }]]);
    const { engine, store, sessionId } = setupEngine(provider);
    store.append(sessionId, { type: "user_message", sessionId, threadId: "main", text: "hello", clientName: "test" });

    await engine.runTurn(sessionId);

    const serialized = JSON.stringify(provider.requests[0]!.input);
    expect(serialized).toContain("hello");
    expect(serialized).not.toContain("[Summary of earlier conversation]");
  });

  test("multiple checkpoints: input uses the LATEST checkpoint's summary and uptoSeq, not the earlier one's", async () => {
    const provider = new FakeProvider([[{ type: "text_delta", delta: "ok" }, { type: "done", stopReason: "end_turn" }]]);
    const { engine, store, sessionId } = setupEngine(provider);

    // seed u0/a0..u7/a7 (8 pairs)
    for (let i = 0; i < 8; i++) {
      store.append(sessionId, { type: "user_message", sessionId, threadId: "main", text: `u${i}`, clientName: "test" });
      store.append(sessionId, { type: "assistant_message", sessionId, threadId: "main", text: `a${i}` });
    }
    const msgs = store.read(sessionId).filter((e) => e.type === "user_message" || e.type === "assistant_message");
    // earlier checkpoint: covers u0..a2 (first 6 messages)
    store.append(sessionId, { type: "checkpoint", sessionId, threadId: "main", summary: "OLD_SUMMARY", uptoSeq: msgs[5]!.seq });
    // latest checkpoint: covers u0..a4 (first 10 messages) — supersedes the earlier one
    store.append(sessionId, { type: "checkpoint", sessionId, threadId: "main", summary: "NEW_SUMMARY", uptoSeq: msgs[9]!.seq });

    await engine.runTurn(sessionId);

    const input = provider.requests[0]!.input;
    const serialized = JSON.stringify(input);

    // the LATEST checkpoint's summary is used, exactly once; the earlier one's is not:
    expect(serialized).toContain("NEW_SUMMARY");
    expect(serialized).not.toContain("OLD_SUMMARY");

    // tail = messages after the LATEST checkpoint's uptoSeq (u5..a7):
    expect(serialized).toContain("u5");
    expect(serialized).toContain("a7");

    // messages folded into the latest checkpoint (including ones the earlier checkpoint left as
    // tail, e.g. u3/u4) are NOT present verbatim:
    expect(input.some((it) => "content" in it && it.content === "u0")).toBe(false);
    expect(input.some((it) => "content" in it && it.content === "u3")).toBe(false);
    expect(input.some((it) => "content" in it && it.content === "u4")).toBe(false);
    expect(input.some((it) => "content" in it && it.content === "a4")).toBe(false);
  });
});

describe("engine auto-compact trigger (at turn start, off the real provider-reported context size)", () => {
  // FakeProvider's models() must report a ModelInfo whose id matches the model setupEngine's
  // harness hardcodes onto EngineConfig.provider ("gated-1") — otherwise contextWindow() can't
  // resolve a contextWindow for it and the threshold is effectively Infinity.
  const SMALL_MODEL = { id: "gated-1", family: "fake", contextWindow: 1000, supportsVision: false };
  // threshold = contextWindow(1000) * NORMA_COMPACT_THRESHOLD_FRAC(default 0.75) = 750

  function seedMessages(store: ReturnType<typeof setupEngine>["store"], sessionId: string, n: number) {
    for (let i = 0; i < n; i++) {
      store.append(sessionId, { type: "user_message", sessionId, threadId: "main", text: `u${i}`, clientName: "test" });
      store.append(sessionId, { type: "assistant_message", sessionId, threadId: "main", text: `a${i}` });
    }
  }

  test("a context over the threshold triggers a compaction before the turn's own streamTurn call", async () => {
    const provider = new FakeProvider(
      [
        [{ type: "text_delta", delta: "SUMMARY_TOKEN" }, { type: "done", stopReason: "end_turn" }], // the compaction's own streamTurn
        [{ type: "text_delta", delta: "ok" }, { type: "done", stopReason: "end_turn" }], // the actual turn's streamTurn
      ],
      [SMALL_MODEL],
    );
    const { engine, store, sessionId } = setupEngine(provider);
    seedMessages(store, sessionId, 5); // 10 messages, > Compactor's default keepTail(6) → compactable
    // contextTokens is the figure the trigger reads (review I2: a turn carrying no context
    // measurement is SKIPPED, never read off inputTokens — see maybeAutoCompact's doc comment).
    store.append(sessionId, { type: "turn_completed", sessionId, threadId: "main", stopReason: "end_turn", inputTokens: 900, outputTokens: 10, contextTokens: 900 }); // 900 > 750

    await engine.runTurn(sessionId);

    // a checkpoint landed (auto-compact ran):
    const checkpoint = store.read(sessionId).find((e) => e.type === "checkpoint");
    expect(checkpoint).toBeDefined();
    expect(checkpoint && "summary" in checkpoint && checkpoint.summary).toBe("SUMMARY_TOKEN");

    // the compaction's streamTurn happened FIRST, the turn's own streamTurn SECOND:
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[0]!.instructions).toContain("compacting");

    // the turn's own input (built by historyInput AFTER auto-compact ran) reflects the
    // checkpoint — auto-compact ran before historyInput, not after:
    const turnInput = provider.requests[1]!.input;
    const serialized = JSON.stringify(turnInput);
    expect(serialized).toContain("[Summary of earlier conversation]");
    expect(serialized).toContain("SUMMARY_TOKEN");
    expect(turnInput.some((it) => "content" in it && it.content === "u0")).toBe(false);
  });

  test("a context under the threshold does not trigger compaction", async () => {
    const provider = new FakeProvider([[{ type: "text_delta", delta: "ok" }, { type: "done", stopReason: "end_turn" }]], [SMALL_MODEL]);
    const { engine, store, sessionId } = setupEngine(provider);
    seedMessages(store, sessionId, 5);
    store.append(sessionId, { type: "turn_completed", sessionId, threadId: "main", stopReason: "end_turn", inputTokens: 100, outputTokens: 10, contextTokens: 100 }); // 100 < 750

    await engine.runTurn(sessionId);

    expect(store.read(sessionId).some((e) => e.type === "checkpoint")).toBe(false);
    expect(provider.requests).toHaveLength(1); // only the turn's own streamTurn — no compaction call
  });

  test("first turn (no prior turn_completed) does not trigger compaction", async () => {
    const provider = new FakeProvider([[{ type: "text_delta", delta: "ok" }, { type: "done", stopReason: "end_turn" }]], [SMALL_MODEL]);
    const { engine, store, sessionId } = setupEngine(provider);
    seedMessages(store, sessionId, 5); // plenty of messages to compact, but no turn_completed yet

    await engine.runTurn(sessionId);

    expect(store.read(sessionId).some((e) => e.type === "checkpoint")).toBe(false);
    expect(provider.requests).toHaveLength(1);
  });

  // ── The trigger was wrong in BOTH directions. Each direction is pinned independently below, so
  //    a single test can never pass because two errors cancelled. ─────────────────────────────

  /** DIRECTION 1 — TOO HIGH TO EVER REACH (the dead-compactor bug).
   *
   *  `CODEX_MODELS` hardcoded `contextWindow: 372_000`; the real window is 272,000. The threshold
   *  is a fraction OF that number, so the bug moved it ABOVE the provider's own hard ceiling:
   *
   *      372_000 × 0.75 = 279_000   vs a ceiling of 272_000
   *
   *  A request whose context exceeds 272,000 is rejected by the backend, so `inputTokens` can
   *  never be reported above it — the trigger was mathematically unreachable and auto-compaction
   *  was dead on every Codex model. The session did not get compacted; it hit the provider's hard
   *  limit and failed.
   *
   *  This test drives the engine with a ModelInfo carrying the REAL `CODEX_MODELS` window (not a
   *  copy of the number) and a previous turn at 271,000 tokens — the largest context the provider
   *  can ever report. Pre-fix: 271,000 < 279,000 → no compaction. Post-fix: 271,000 > 204,000 →
   *  compaction. */
  test("a context just under the provider's real 272,000 ceiling DOES trigger compaction (the trigger is reachable)", async () => {
    const CODEX_SHAPED = { id: "gated-1", family: "gpt-5", contextWindow: CODEX_MODELS[0]!.contextWindow, supportsVision: true };
    // the arithmetic under test, visible: window × frac must land BELOW 272,000 to be reachable
    expect(CODEX_SHAPED.contextWindow * DEFAULT_COMPACT_THRESHOLD_FRAC).toBeLessThan(272_000);

    const provider = new FakeProvider(
      [
        [{ type: "text_delta", delta: "SUMMARY_TOKEN" }, { type: "done", stopReason: "end_turn" }], // the compaction's own streamTurn
        [{ type: "text_delta", delta: "ok" }, { type: "done", stopReason: "end_turn" }],
      ],
      [CODEX_SHAPED],
    );
    const { engine, store, sessionId } = setupEngine(provider);
    seedMessages(store, sessionId, 5);
    store.append(sessionId, {
      type: "turn_completed", sessionId, threadId: "main", stopReason: "end_turn",
      inputTokens: 271_000, outputTokens: 10, contextTokens: 271_000,
    });

    await engine.runTurn(sessionId);

    expect(store.read(sessionId).some((e) => e.type === "checkpoint")).toBe(true);
    expect(provider.requests[0]!.instructions).toContain("compacting");
  });

  /** DIRECTION 2 — TOO LOW ON TOOL-HEAVY TURNS (the premature-compaction bug).
   *
   *  `turn_completed.inputTokens` is the SUM of every tool ROUND's input tokens (correct for a
   *  "tokens billed this turn" readout, which is what the CLI/TUI render it as) — but the trigger
   *  needs the size of the CONTEXT, i.e. ONE request, not the sum of N of them. A turn with three
   *  300-token rounds sums to 900 while the context never exceeded 300; against a 750 threshold
   *  the pre-fix trigger compacted a session whose context was 40% full.
   *
   *  Pinned separately from Direction 1 on purpose: the two errors push opposite ways, and a
   *  single end-to-end test could have passed with both still present. */
  test("a tool-heavy turn does NOT trigger compaction on the SUM of its rounds", async () => {
    const toolRound = (callId: string): ProviderEvent[] => [
      { type: "tool_call", callId, name: "glob", argsJson: '{"pattern":"*"}' },
      { type: "usage", inputTokens: 300, outputTokens: 5 },
      { type: "done", stopReason: "tool_calls" },
    ];
    const provider = new FakeProvider(
      [
        toolRound("c1"),
        toolRound("c2"),
        [{ type: "text_delta", delta: "done" }, { type: "usage", inputTokens: 300, outputTokens: 5 }, { type: "done", stopReason: "end_turn" }],
        [{ type: "text_delta", delta: "second turn" }, { type: "usage", inputTokens: 10, outputTokens: 1 }, { type: "done", stopReason: "end_turn" }],
      ],
      [SMALL_MODEL],
    );
    const { engine, store, sessionId } = setupEngine(provider);
    seedMessages(store, sessionId, 5); // compactable, so a spurious trigger is visible

    await engine.runTurn(sessionId); // 3 rounds × 300 = 900 summed; the context itself peaked at 300

    const completed = store.read(sessionId).find((e) => e.type === "turn_completed") as
      { inputTokens: number; outputTokens: number; contextTokens?: number };
    // the BILLING figure is unchanged — the sum is what the CLI/TUI turn summary means:
    expect(completed.inputTokens).toBe(900);
    // the CONTEXT figure is the largest single request, NOT the sum:
    expect(completed.contextTokens).toBe(300);

    await engine.runTurn(sessionId); // the trigger reads the turn above

    // 300 < 750 → nothing to compact. Pre-fix the trigger saw 900 and compacted a 40%-full context.
    expect(store.read(sessionId).some((e) => e.type === "checkpoint")).toBe(false);
    expect(provider.requests.some((r) => (r.instructions ?? "").includes("compacting"))).toBe(false);
  });

  /** DIRECTION 3 (found while fixing the other two, pinned independently) — A BACKGROUND CHILD'S
   *  turn_completed MASKING THE MAIN THREAD'S.
   *
   *  The trigger takes the LAST `turn_completed` in the session, of ANY thread. A detached
   *  (background) subagent finishes AFTER the main turn it was spawned from, so its own tiny
   *  `turn_completed` lands last and the trigger then measures the CHILD's context instead of the
   *  main thread's — under-reporting it, and suppressing a compaction the main thread needed.
   *  Compaction only ever folds MAIN-thread history (`historyInput` filters other threads out), so
   *  reading a child's figure is never right. */
  /** DIRECTION 4 (T2 review I2a) — AN ABORTED TURN ZEROES THE MEASUREMENT.
   *
   *  ESC mid-stream aborts before the provider's `response.completed`, so no `usage` event ever
   *  arrives and the abort path emits `turn_completed{aborted, 0, 0, contextTokens: 0}`. That
   *  becomes the last main-thread completion, and the trigger then measures 0 — silently
   *  suppressing the compaction the PREVIOUS turn had already earned. `Math.max`'s "never degrade
   *  to zero" defense was applied WITHIN a turn; this is the same defense ACROSS turns. */
  test("an aborted turn (0 tokens, no usage ever reported) does not suppress the compaction the previous turn earned", async () => {
    const provider = new FakeProvider(
      [
        [{ type: "text_delta", delta: "SUMMARY_TOKEN" }, { type: "done", stopReason: "end_turn" }],
        [{ type: "text_delta", delta: "ok" }, { type: "done", stopReason: "end_turn" }],
      ],
      [SMALL_MODEL],
    );
    const { engine, store, sessionId } = setupEngine(provider);
    seedMessages(store, sessionId, 5);
    store.append(sessionId, {
      type: "turn_completed", sessionId, threadId: "main", stopReason: "end_turn",
      inputTokens: 900, outputTokens: 10, contextTokens: 900, // 900 > 750 → this turn earned a compaction
    });
    store.append(sessionId, {
      type: "turn_completed", sessionId, threadId: "main", stopReason: "aborted",
      inputTokens: 0, outputTokens: 0, contextTokens: 0, // ESC before any usage arrived
    });

    await engine.runTurn(sessionId);

    expect(store.read(sessionId).some((e) => e.type === "checkpoint")).toBe(true);
  });

  /** DIRECTION 5 (T2 review I2b) — A SECOND, LIVE PRODUCER EMITS NO `contextTokens`.
   *
   *  `apple/NormaChatKit/.../ChatEngine.swift` is the phone's standalone chat engine. It sums
   *  `inputTokens` across its own tool rounds — the identical round-summing fixed here on the TS
   *  side — and emits `turn_completed` with NO `contextTokens`. Those lines reach this daemon's log
   *  BYTE-VERBATIM via `sync.push` (raw-JSONL replication), and `maybeAutoCompact` has no mode
   *  gate, so a Mac turn following a phone-authored turn in a synced chat session would measure the
   *  phone's ROUND SUM. This is a CURRENT producer, not legacy data.
   *
   *  A figure that cannot be trusted is worse than no figure: the trigger skips such an event and
   *  keeps walking back to the most recent completion that carries a real context measurement. */
  test("a turn_completed with NO contextTokens (the phone's ChatEngine shape) is never read as a context size", async () => {
    const provider = new FakeProvider([[{ type: "text_delta", delta: "ok" }, { type: "done", stopReason: "end_turn" }]], [SMALL_MODEL]);
    const { engine, store, sessionId } = setupEngine(provider);
    seedMessages(store, sessionId, 5);
    // exactly the phone's shape: a round SUM in inputTokens, contextTokens absent
    store.append(sessionId, {
      type: "turn_completed", sessionId, threadId: "main", stopReason: "end_turn",
      inputTokens: 900, outputTokens: 20, // 900 > 750 — but it is a SUM, not a context size
    });

    await engine.runTurn(sessionId);

    expect(store.read(sessionId).some((e) => e.type === "checkpoint")).toBe(false);
    expect(provider.requests).toHaveLength(1); // no compaction streamTurn
  });

  test("a background CHILD's later turn_completed does not mask the main thread's context", async () => {
    const provider = new FakeProvider(
      [
        [{ type: "text_delta", delta: "SUMMARY_TOKEN" }, { type: "done", stopReason: "end_turn" }],
        [{ type: "text_delta", delta: "ok" }, { type: "done", stopReason: "end_turn" }],
      ],
      [SMALL_MODEL],
    );
    const { engine, store, sessionId } = setupEngine(provider);
    seedMessages(store, sessionId, 5);
    store.append(sessionId, {
      type: "turn_completed", sessionId, threadId: "main", stopReason: "end_turn",
      inputTokens: 900, outputTokens: 10, contextTokens: 900, // 900 > 750 → the main thread needs a compaction
    });
    store.append(sessionId, {
      type: "turn_completed", sessionId, threadId: "th_bg_child", stopReason: "end_turn",
      inputTokens: 10, outputTokens: 2, contextTokens: 10, // a bg subagent landing after the main turn
    });

    await engine.runTurn(sessionId);

    expect(store.read(sessionId).some((e) => e.type === "checkpoint")).toBe(true);
  });
});
