import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../../src/sessions/store";
import { SessionHub } from "../../src/sessions/hub";
import { Compactor } from "../../src/agent/compactor";
import { FakeProvider } from "../../src/agent/fake-provider";

function seedSession(n: number) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "winter-cmp-")));
  const store = new SessionStore(home);
  const hub = new SessionHub(store);
  const sid = store.createSession("global", { cwd: "/tmp", approvalPolicy: "auto" });
  for (let i = 0; i < n; i++) {
    store.append(sid, { type: "user_message", sessionId: sid, threadId: "main", text: `u${i}`, clientName: "test" });
    store.append(sid, { type: "assistant_message", sessionId: sid, threadId: "main", text: `a${i}` });
  }
  return { store, hub, sid };
}

// A FakeProvider that emits a fixed summary as one text_delta then done(end_turn).
function summarizer(summary: string) {
  return new FakeProvider([[{ type: "text_delta", delta: summary }, { type: "done", stopReason: "end_turn" }]]);
}

describe("Compactor", () => {
  test("summarizes older turns, keeps the tail, appends a checkpoint", async () => {
    const { store, hub, sid } = seedSession(10); // 20 messages
    const c = new Compactor({ provider: { provider: summarizer("SUMMARY_TOKEN"), model: "fake" }, store, hub, keepTail: 6 });
    const res = await c.compact(sid);
    expect(res.compacted).toBe(true);
    const cp = store.read(sid).find((e) => e.type === "checkpoint");
    expect(cp && (cp as any).summary).toBe("SUMMARY_TOKEN");
    // uptoSeq must be the seq of the last message BEFORE the kept tail (6 messages kept)
    const msgs = store.read(sid).filter((e) => e.type === "user_message" || e.type === "assistant_message");
    const tailStartSeq = msgs[msgs.length - 6]!.seq;
    expect((cp as any).uptoSeq).toBe(tailStartSeq - 1);
    expect(res.summaryChars).toBe("SUMMARY_TOKEN".length);
  });

  test("too few messages -> not compacted", async () => {
    const { store, hub, sid } = seedSession(2); // 4 messages, <= keepTail
    const c = new Compactor({ provider: { provider: summarizer("X"), model: "fake" }, store, hub, keepTail: 6 });
    expect((await c.compact(sid)).compacted).toBe(false);
    expect(store.read(sid).some((e) => e.type === "checkpoint")).toBe(false);
  });

  test("an already-checkpointed session carries the prior summary forward verbatim (never re-fed to the model)", async () => {
    const { store, hub, sid } = seedSession(10);
    const c1 = new Compactor({ provider: { provider: summarizer("FIRST lucky number 4242"), model: "fake" }, store, hub, keepTail: 6 });
    await c1.compact(sid);
    for (let i = 0; i < 6; i++) {
      store.append(sid, { type: "user_message", sessionId: sid, threadId: "main", text: `nu${i}`, clientName: "test" });
      store.append(sid, { type: "assistant_message", sessionId: sid, threadId: "main", text: `na${i}` });
    }
    // capture what the model is asked to summarize: a provider that records its input
    const rec: any = summarizer("SECOND");
    const orig = rec.streamTurn.bind(rec);
    const inputs: any[] = [];
    rec.streamTurn = (req: any) => { inputs.push(req.input); return orig(req); };
    const c2 = new Compactor({ provider: { provider: rec, model: "fake" }, store, hub, keepTail: 6 });
    await c2.compact(sid);
    // Regression guard: the model input on re-compaction contains ONLY the new older messages —
    // the prior summary is never re-fed, so a real model can no longer drop it under repeated
    // re-compression.
    expect(JSON.stringify(inputs[0])).not.toContain("FIRST");
    expect(JSON.stringify(inputs[0])).not.toContain("4242");
    // The new checkpoint's cumulative summary carries the prior summary forward verbatim AND
    // appends the freshly summarized section — this is the regression the live gate caught: a
    // fact from checkpoint 1 must still be present verbatim in checkpoint 2's summary.
    const checkpoints = store.read(sid).filter((e) => e.type === "checkpoint");
    expect(checkpoints.length).toBe(2);
    const newCheckpoint: any = checkpoints[1];
    expect(newCheckpoint.summary).toContain("FIRST lucky number 4242");
    expect(newCheckpoint.summary).toContain("SECOND");
  });

  test("honors the abort signal (interrupt cancels a running compaction)", async () => {
    const { store, hub, sid } = seedSession(10);
    // a provider whose streamTurn blocks until signal aborts (reuse AbortAwaitProvider)
    const { AbortAwaitProvider } = await import("../../src/agent/test-providers");
    const c = new Compactor({ provider: { provider: new AbortAwaitProvider(), model: "fake" }, store, hub, keepTail: 6 });
    const ac = new AbortController();
    const p = c.compact(sid, ac.signal);
    ac.abort();
    const res = await p;
    expect(res.compacted).toBe(false); // aborted before a summary -> no checkpoint
    expect(store.read(sid).some((e) => e.type === "checkpoint")).toBe(false);
  });

  test("rate-limited compaction QUEUES then runs (not dropped)", async () => {
    // Wrap the summarizer with the real withQuota + a QuotaManager marked limited-until soon.
    const { withQuota, QuotaManager } = await import("../../src/providers/quota");
    const { store, hub, sid } = seedSession(10);
    const q = new QuotaManager();
    q.noteRateLimit(120); // limited for 120ms from now — the real "mark limited" API
    const wrapped = withQuota(summarizer("QUEUED"), q);
    const c = new Compactor({ provider: { provider: wrapped, model: "fake" }, store, hub, keepTail: 6 });
    const res = await c.compact(sid);
    expect(res.compacted).toBe(true); // waited past the limit, then produced the checkpoint
    expect(store.read(sid).find((e) => e.type === "checkpoint")).toBeTruthy();
  });

  test("empty model summary → not compacted (no blank checkpoint)", async () => {
    const { store, hub, sid } = seedSession(10); // 20 messages
    // a provider that yields NO text_delta — just done(end_turn) → summary === ""
    const emptySummarizer = new FakeProvider([[{ type: "done", stopReason: "end_turn" }]]);
    const c = new Compactor({ provider: { provider: emptySummarizer, model: "fake" }, store, hub, keepTail: 6 });
    const res = await c.compact(sid);
    expect(res.compacted).toBe(false);
    expect(store.read(sid).some((e) => e.type === "checkpoint")).toBe(false);
  });

  test("whitespace-only model summary → not compacted (no blank checkpoint)", async () => {
    const { store, hub, sid } = seedSession(10); // 20 messages
    // a provider that yields only whitespace → summary.trim() === ""
    const whitespaceSummarizer = new FakeProvider([[{ type: "text_delta", delta: "   \n  " }, { type: "done", stopReason: "end_turn" }]]);
    const c = new Compactor({ provider: { provider: whitespaceSummarizer, model: "fake" }, store, hub, keepTail: 6 });
    const res = await c.compact(sid);
    expect(res.compacted).toBe(false);
    expect(store.read(sid).some((e) => e.type === "checkpoint")).toBe(false);
  });

  // Reachable in production: AgentEngine.steer() appends user_message events IMMEDIATELY, even
  // while a tool call sits mid-flight awaiting approval (default timeout 5 min). If a steer flood
  // of > keepTail messages lands during that window and a manual `compact` IPC call (a live method,
  // callable mid-turn) fires in it, the naive candidate uptoSeq computed purely from MESSAGE seqs
  // can land strictly BETWEEN a pending tool_call's seq and its (future or nonexistent) tool_result's
  // seq. historyInput's `seq <= uptoSeq` then folds the function_call but keeps the later
  // tool_result -> an orphaned tool_result in the provider input -> hard reject. These three tests
  // pin the Compactor's pair-aware clamp that prevents it.
  describe("clamp: never folds inside an unresolved main-thread tool_call/tool_result pair", () => {
    function emptySession() {
      const home = realpathSync(mkdtempSync(join(tmpdir(), "winter-cmp-pair-")));
      const store = new SessionStore(home);
      const hub = new SessionHub(store);
      const sid = store.createSession("global", { cwd: "/tmp", approvalPolicy: "auto" });
      return { store, hub, sid };
    }

    test("manual compact mid-approval, steer flood, result eventually arrives -> clamps to before the pending tool_call", async () => {
      const { store, hub, sid } = emptySession();
      const evUser0 = store.append(sid, { type: "user_message", sessionId: sid, threadId: "main", text: "u0", clientName: "test" });
      const evAsst0 = store.append(sid, { type: "assistant_message", sessionId: sid, threadId: "main", text: "a0" });
      const evCall = store.append(sid, { type: "tool_call", sessionId: sid, threadId: "main", callId: "c1", name: "read", argsJson: "{}" });
      const steerSeqs: number[] = [];
      for (let i = 0; i < 7; i++) {
        const ev = store.append(sid, { type: "user_message", sessionId: sid, threadId: "main", text: `steer${i}`, clientName: "test" });
        steerSeqs.push(ev.seq);
      }
      store.append(sid, { type: "tool_result", sessionId: sid, threadId: "main", callId: "c1", output: "result", isError: false });
      store.append(sid, { type: "assistant_message", sessionId: sid, threadId: "main", text: "a-final" });

      const c = new Compactor({ provider: { provider: summarizer("SUMMARY"), model: "fake" }, store, hub, keepTail: 4 });
      const res = await c.compact(sid);

      expect(res.compacted).toBe(true);
      // clamped to the last message strictly before the pending tool_call — never inside the pair
      expect(res.uptoSeq).toBe(evAsst0.seq);
      expect(res.uptoSeq).toBeLessThan(evCall.seq);
      for (const s of steerSeqs) expect(res.uptoSeq).not.toBe(s);
      const cp: any = store.read(sid).find((e) => e.type === "checkpoint");
      expect(cp.uptoSeq).toBe(evAsst0.seq);
      // never even touches evUser0's seq minus 1 territory unexpectedly — sanity that evAsst0 > evUser0
      expect(evAsst0.seq).toBeGreaterThan(evUser0.seq);
    });

    test("manual compact mid-approval, steer flood, NO result yet -> same clamp", async () => {
      const { store, hub, sid } = emptySession();
      const evUser0 = store.append(sid, { type: "user_message", sessionId: sid, threadId: "main", text: "u0", clientName: "test" });
      const evAsst0 = store.append(sid, { type: "assistant_message", sessionId: sid, threadId: "main", text: "a0" });
      const evCall = store.append(sid, { type: "tool_call", sessionId: sid, threadId: "main", callId: "c1", name: "read", argsJson: "{}" });
      for (let i = 0; i < 7; i++) {
        store.append(sid, { type: "user_message", sessionId: sid, threadId: "main", text: `steer${i}`, clientName: "test" });
      }
      // events end here: the tool call is still pending, no tool_result exists at all

      const c = new Compactor({ provider: { provider: summarizer("SUMMARY"), model: "fake" }, store, hub, keepTail: 4 });
      const res = await c.compact(sid);

      expect(res.compacted).toBe(true);
      expect(res.uptoSeq).toBe(evAsst0.seq);
      expect(res.uptoSeq).toBeLessThan(evCall.seq);
      expect(evUser0.seq).toBeLessThan(evAsst0.seq);
    });

    test("happy path unaffected: a tool_call/tool_result pair fully resolved before the tail compacts to the unclamped candidate", async () => {
      const { store, hub, sid } = emptySession();
      store.append(sid, { type: "user_message", sessionId: sid, threadId: "main", text: "u0", clientName: "test" });
      store.append(sid, { type: "assistant_message", sessionId: sid, threadId: "main", text: "a0" });
      store.append(sid, { type: "tool_call", sessionId: sid, threadId: "main", callId: "c1", name: "read", argsJson: "{}" });
      store.append(sid, { type: "tool_result", sessionId: sid, threadId: "main", callId: "c1", output: "result", isError: false });
      store.append(sid, { type: "assistant_message", sessionId: sid, threadId: "main", text: "a1" });
      for (let i = 0; i < 4; i++) {
        store.append(sid, { type: "user_message", sessionId: sid, threadId: "main", text: `u${i + 1}`, clientName: "test" });
        store.append(sid, { type: "assistant_message", sessionId: sid, threadId: "main", text: `a${i + 2}` });
      }

      const c = new Compactor({ provider: { provider: summarizer("SUMMARY"), model: "fake" }, store, hub, keepTail: 4 });
      const res = await c.compact(sid);

      expect(res.compacted).toBe(true);
      // Independently recompute what the UNCLAMPED candidate would be (mirrors the source's own
      // `older[older.length - 1].seq` derivation) to pin exact no-behavior-change on the happy path.
      const msgs = store.read(sid).filter((e) => e.type === "user_message" || e.type === "assistant_message");
      const expectedCandidate = msgs[msgs.length - 1 - 4]!.seq;
      expect(res.uptoSeq).toBe(expectedCandidate);
    });
  });

  // history-parity T3 review: reasoning_item events are persisted at STREAM time (engine.ts's
  // collector fires the instant the item arrives) while their function_call is persisted only at
  // DISPATCH time, later. Between those two points AgentEngine.steer() can append a `user_message`
  // (it persists immediately, mid-turn, same as the tool-pair clamp's own motivating scenario), so
  // a reasoning item and the function_call it belongs to can end up with a steer flood interleaved
  // between their seqs. The tool-pair clamp above only protects the pair itself — these tests pin
  // that the clamp ALSO refuses to fold a reasoning item while replaying its function_call bare.
  describe("clamp: never strands a reasoning item without its function_call (steer-interleave between stream-time reasoning and dispatch-time call)", () => {
    function emptySession() {
      const home = realpathSync(mkdtempSync(join(tmpdir(), "winter-cmp-reasoning-")));
      const store = new SessionStore(home);
      const hub = new SessionHub(store);
      const sid = store.createSession("global", { cwd: "/tmp", approvalPolicy: "auto" });
      return { store, hub, sid };
    }

    test("pending/unresolved call whose reasoning span is separated by a steer flood -> clamps below the round opening, not the flood", async () => {
      const { store, hub, sid } = emptySession();
      const evUser0 = store.append(sid, { type: "user_message", sessionId: sid, threadId: "main", text: "u0", clientName: "test" });
      const evAsst0 = store.append(sid, { type: "assistant_message", sessionId: sid, threadId: "main", text: "a0" });
      store.append(sid, { type: "reasoning_item", sessionId: sid, threadId: "main", itemJson: '{"ec":1}' });
      const steerSeqs: number[] = [];
      for (let i = 0; i < 7; i++) {
        const ev = store.append(sid, { type: "user_message", sessionId: sid, threadId: "main", text: `steer${i}`, clientName: "test" });
        steerSeqs.push(ev.seq);
      }
      const evCall = store.append(sid, { type: "tool_call", sessionId: sid, threadId: "main", callId: "c1", name: "read", argsJson: "{}" });
      // events end here: the call is still pending, no tool_result exists at all

      const c = new Compactor({ provider: { provider: summarizer("SUMMARY"), model: "fake" }, store, hub, keepTail: 4 });
      const res = await c.compact(sid);

      expect(res.compacted).toBe(true);
      // clamped to the last message strictly before the reasoning item's round opening (the
      // assistant message that precedes it) — NOT the largest message below the flood, which
      // would fold the reasoning item away while the (bare) function_call still replays.
      expect(res.uptoSeq).toBe(evAsst0.seq);
      expect(res.uptoSeq).toBeLessThan(evCall.seq);
      for (const s of steerSeqs) expect(res.uptoSeq).not.toBe(s);
      const cp: any = store.read(sid).find((e) => e.type === "checkpoint");
      expect(cp.uptoSeq).toBe(evAsst0.seq);
    });

    test("fully resolved pair whose reasoning span is separated by a steer flood -> clamps below the round opening even though the pair itself sits entirely above the candidate", async () => {
      const { store, hub, sid } = emptySession();
      const evUser0 = store.append(sid, { type: "user_message", sessionId: sid, threadId: "main", text: "u0", clientName: "test" });
      const evAsst0 = store.append(sid, { type: "assistant_message", sessionId: sid, threadId: "main", text: "a0" });
      store.append(sid, { type: "reasoning_item", sessionId: sid, threadId: "main", itemJson: '{"ec":1}' });
      for (let i = 0; i < 7; i++) {
        store.append(sid, { type: "user_message", sessionId: sid, threadId: "main", text: `steer${i}`, clientName: "test" });
      }
      const evCall = store.append(sid, { type: "tool_call", sessionId: sid, threadId: "main", callId: "c1", name: "read", argsJson: "{}" });
      store.append(sid, { type: "tool_result", sessionId: sid, threadId: "main", callId: "c1", output: "result", isError: false });
      store.append(sid, { type: "assistant_message", sessionId: sid, threadId: "main", text: "a-final" });

      const c = new Compactor({ provider: { provider: summarizer("SUMMARY"), model: "fake" }, store, hub, keepTail: 4 });
      const res = await c.compact(sid);

      expect(res.compacted).toBe(true);
      // The pair (call/result) is fully resolved and sits entirely above the naive candidate, so
      // T1's pair-only rule sees no offender here — but folding the naive candidate would still
      // fold reasoning(evAsst0.seq+1) away while replaying evCall's function_call bare. The clamp
      // must extend to protect the round opening regardless.
      expect(res.uptoSeq).toBe(evAsst0.seq);
      expect(res.uptoSeq).toBeLessThan(evCall.seq);
      expect(evUser0.seq).toBeLessThan(evAsst0.seq);
    });
  });
});
