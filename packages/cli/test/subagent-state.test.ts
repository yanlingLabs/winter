import { describe, expect, test } from "bun:test";
import { ROSTER_STALL_MS, subagentSilentMs, subagentStalled, updateSubagents, type CliSubagent } from "../src/subagent-state";

const spawn = { type: "thread_started", threadId: "th_a", parentThreadId: "main", agentType: "general-purpose", prompt: "go do it", description: "explore auth module" };

describe("updateSubagents (spec §2, CLI column: lifecycle + tokens, NO time)", () => {
  test("thread_started inserts queued with label; duplicate threadId is a no-op", () => {
    const s1 = updateSubagents([], spawn);
    expect(s1).toEqual([{ threadId: "th_a", agentType: "general-purpose", label: "explore auth module", status: "queued", outputTokens: 0, liveOutputChars: 0, activeMs: 0, toolCalls: 0 }]);
    expect(updateSubagents(s1, spawn)).toBe(s1); // same reference — replay dedupe
  });

  test("child turn_started → working; ghost threadIds are no-ops", () => {
    const s = updateSubagents(updateSubagents([], spawn), { type: "turn_started", threadId: "th_a" });
    expect(s[0]!.status).toBe("working");
    expect(updateSubagents(s, { type: "turn_started", threadId: "th_ghost" })).toBe(s);
  });

  test("child deltas accumulate; turn_completed banks tokens and reconciles the estimate", () => {
    let s = updateSubagents(updateSubagents([], spawn), { type: "turn_started", threadId: "th_a" });
    s = updateSubagents(s, { type: "assistant_delta", threadId: "th_a", delta: "hello wor" }); // 9 chars
    expect(s[0]!.liveOutputChars).toBe(9);
    s = updateSubagents(s, { type: "turn_completed", threadId: "th_a", stopReason: "end_turn", inputTokens: 1200, outputTokens: 42 });
    expect(s[0]).toMatchObject({ inputTokens: 1200, outputTokens: 42, liveOutputChars: 0, status: "working" });
  });

  test("thread_completed → done; main turn_completed prunes; main deltas ignored", () => {
    let s = updateSubagents([], spawn);
    expect(updateSubagents(s, { type: "assistant_delta", threadId: "main", delta: "xx" })).toBe(s);
    s = updateSubagents(s, { type: "thread_completed", threadId: "th_a", stopReason: "end_turn" });
    expect(s[0]!.status).toBe("done");
    expect(updateSubagents(s, { type: "turn_completed", threadId: "main", stopReason: "end_turn", inputTokens: 1, outputTokens: 1 })).toEqual([]);
  });

  test("main agent_error prunes defensively", () => {
    const s = updateSubagents([], spawn);
    expect(updateSubagents(s, { type: "agent_error", threadId: "main", message: "boom" })).toEqual([]);
  });

  test("child turn window banks active span; thread_completed defensively closes", () => {
    let s = updateSubagents([], spawn);
    s = updateSubagents(s, { type: "turn_started", threadId: "th_a", ts: 1000 });
    expect(s[0]!.activeSince).toBe(1000);
    s = updateSubagents(s, { type: "turn_completed", threadId: "th_a", ts: 4500, stopReason: "end_turn", inputTokens: 1, outputTokens: 1 });
    expect(s[0]).toMatchObject({ activeMs: 3500, activeSince: undefined });
    // defensive close path
    let d = updateSubagents(updateSubagents([], spawn), { type: "turn_started", threadId: "th_a", ts: 1000 });
    d = updateSubagents(d, { type: "thread_completed", threadId: "th_a", ts: 6000, stopReason: "aborted" });
    expect(d[0]).toMatchObject({ status: "done", activeMs: 5000, activeSince: undefined });
  });

  test("child tool_call bumps toolCalls and sets activity via extractToolDetail", () => {
    let s = updateSubagents([], spawn);
    s = updateSubagents(s, { type: "tool_call", threadId: "th_a", callId: "c1", name: "bash", argsJson: JSON.stringify({ command: "bun test" }) });
    s = updateSubagents(s, { type: "tool_call", threadId: "th_a", callId: "c2", name: "weird", argsJson: "{}" });
    expect(s[0]!.toolCalls).toBe(2);
    expect(s[0]!.activity).toBe("bun test"); // undefined detail keeps the previous activity
    expect(updateSubagents(s, { type: "tool_call", threadId: "main", callId: "c3", name: "bash", argsJson: "{}" })).toBe(s); // main no-op
  });

  // Roster honesty (no-timeout task, extended by task-16): `finish` carries HOW the thread ended,
  // off the wire's own thread_completed.stopReason — while `status` stays "done" for every
  // terminal thread (the single marker all the `status !== "done"` prune/footer filters and the
  // Swift-lockstep helpers key off; see the CliSubagent doc comment).
  test("thread_completed stopReason drives `finish` (end_turn→done, error→failed, aborted→stopped, stalled→stalled) while status is always 'done'", () => {
    const finished = updateSubagents(updateSubagents([], spawn), { type: "thread_completed", threadId: "th_a", stopReason: "end_turn" });
    expect(finished[0]).toMatchObject({ status: "done", finish: "done" });

    const failed = updateSubagents(updateSubagents([], spawn), { type: "thread_completed", threadId: "th_a", stopReason: "error" });
    expect(failed[0]).toMatchObject({ status: "done", finish: "failed" });

    const stopped = updateSubagents(updateSubagents([], spawn), { type: "thread_completed", threadId: "th_a", stopReason: "aborted" });
    expect(stopped[0]).toMatchObject({ status: "done", finish: "stopped" });

    // task-16 (Stalled roster verb, CC-parity follow-up): a stall-killed child now gets its own
    // distinct `finish`, never folded into "failed".
    const stalled = updateSubagents(updateSubagents([], spawn), { type: "thread_completed", threadId: "th_a", stopReason: "stalled" });
    expect(stalled[0]).toMatchObject({ status: "done", finish: "stalled" });
  });
});

// ---------------------------------------------------------------------------------------------
// LIVE stall hint (task-5): the terminal "Stalled" verb above only appears AFTER the daemon's
// progress-stall watchdog has already killed the child (600s of provider silence by default).
// Until then a wedged child is indistinguishable from a working one on the roster. These pin the
// PRE-KILL signal: the row banks the ts of every wire event it sees plus the two "legitimate
// silence" counters, and a pure predicate — deliberately the same shape as watchdog.ts's own
// `isStalled` for `norma -p` — turns that into a live verdict.
// ---------------------------------------------------------------------------------------------
describe("live stall hint (task-5): lastEventAt / in-flight counters / subagentStalled", () => {
  const at = (ts: number) => ({ ts });

  test("every tracked child event stamps lastEventAt from the event's OWN ts (never Date.now)", () => {
    let s = updateSubagents([], { ...spawn, ...at(1000) });
    expect(s[0]!.lastEventAt).toBe(1000);
    s = updateSubagents(s, { type: "turn_started", threadId: "th_a", ...at(2000) });
    expect(s[0]!.lastEventAt).toBe(2000);
    s = updateSubagents(s, { type: "assistant_delta", threadId: "th_a", delta: "hi", ...at(3000) });
    expect(s[0]!.lastEventAt).toBe(3000);
    s = updateSubagents(s, { type: "tool_call", threadId: "th_a", name: "bash", argsJson: "{}", ...at(4000) });
    expect(s[0]!.lastEventAt).toBe(4000);
    s = updateSubagents(s, { type: "tool_result", threadId: "th_a", output: "ok", ...at(5000) });
    expect(s[0]!.lastEventAt).toBe(5000);
    // a ts-less event (only ever a hand-built test fixture) leaves the last stamp standing
    s = updateSubagents(s, { type: "assistant_delta", threadId: "th_a", delta: "x" });
    expect(s[0]!.lastEventAt).toBe(5000);
  });

  test("subagentSilentMs is nowMs - lastEventAt, clamped ≥ 0; 0 when nothing was ever stamped", () => {
    const s = updateSubagents([], { ...spawn, ...at(1000) });
    expect(subagentSilentMs(s[0]!, 4000)).toBe(3000);
    expect(subagentSilentMs(s[0]!, 500)).toBe(0); // clock skew never reads negative
    const unstamped = updateSubagents([], spawn);
    expect(subagentSilentMs(unstamped[0]!, 999_999)).toBe(0);
  });

  test("a WORKING child silent past the threshold is stalled; under it is not", () => {
    const s = updateSubagents(updateSubagents([], spawn), { type: "turn_started", threadId: "th_a", ...at(1000) });
    expect(subagentStalled(s[0]!, 1000 + ROSTER_STALL_MS, ROSTER_STALL_MS)).toBe(false); // exactly at the edge
    expect(subagentStalled(s[0]!, 1000 + ROSTER_STALL_MS + 1, ROSTER_STALL_MS)).toBe(true);
  });

  test("an in-flight TOOL is legitimate silence — never stalled until its tool_result lands", () => {
    let s = updateSubagents(updateSubagents([], spawn), { type: "turn_started", threadId: "th_a", ...at(1000) });
    s = updateSubagents(s, { type: "tool_call", threadId: "th_a", name: "bash", argsJson: JSON.stringify({ command: "bun test" }), ...at(2000) });
    expect(s[0]!.toolsInFlight).toBe(1);
    expect(subagentStalled(s[0]!, 9_999_999, ROSTER_STALL_MS)).toBe(false); // a long bash is working, not stalled
    s = updateSubagents(s, { type: "tool_result", threadId: "th_a", output: "done", ...at(3000) });
    expect(s[0]!.toolsInFlight).toBe(0);
    expect(subagentStalled(s[0]!, 3000 + ROSTER_STALL_MS + 1, ROSTER_STALL_MS)).toBe(true);
    // never negative: a stray/ghost tool_result can't push the counter below zero
    s = updateSubagents(s, { type: "tool_result", threadId: "th_a", output: "stray", ...at(3500) });
    expect(s[0]!.toolsInFlight).toBe(0);
  });

  test("a PENDING APPROVAL is legitimate silence — waiting on a human is not a stall", () => {
    let s = updateSubagents(updateSubagents([], spawn), { type: "turn_started", threadId: "th_a", ...at(1000) });
    s = updateSubagents(s, { type: "approval_requested", threadId: "th_a", callId: "c1", toolName: "bash", summary: "rm", ...at(2000) });
    expect(s[0]!.approvalsPending).toBe(1);
    expect(subagentStalled(s[0]!, 9_999_999, ROSTER_STALL_MS)).toBe(false);
    s = updateSubagents(s, { type: "approval_resolved", threadId: "th_a", callId: "c1", approved: true, by: "user", ...at(3000) });
    expect(s[0]!.approvalsPending).toBe(0);
    expect(subagentStalled(s[0]!, 3000 + ROSTER_STALL_MS + 1, ROSTER_STALL_MS)).toBe(true);
  });

  test("QUEUED (waiting on a pool slot) and DONE rows are never stalled, however long they sit", () => {
    const queued = updateSubagents([], { ...spawn, ...at(1000) });
    expect(queued[0]!.status).toBe("queued");
    expect(subagentStalled(queued[0]!, 9_999_999, ROSTER_STALL_MS)).toBe(false);
    const done = updateSubagents(queued, { type: "thread_completed", threadId: "th_a", stopReason: "stalled", ...at(2000) });
    expect(subagentStalled(done[0]!, 9_999_999, ROSTER_STALL_MS)).toBe(false); // the FINISH verb owns this row now
  });

  test("a row that never saw a stamped event is never stalled (nothing to measure)", () => {
    const s = updateSubagents(updateSubagents([], spawn), { type: "turn_started", threadId: "th_a" });
    expect(s[0]!.status).toBe("working");
    expect(s[0]!.lastEventAt).toBeUndefined();
    expect(subagentStalled(s[0]!, 9_999_999, ROSTER_STALL_MS)).toBe(false);
  });

  test("main-thread tool_result / approval events never touch the roster (same reference)", () => {
    const s = updateSubagents([], { ...spawn, ...at(1000) });
    expect(updateSubagents(s, { type: "tool_result", threadId: "main", output: "x", ...at(2000) })).toBe(s);
    expect(updateSubagents(s, { type: "approval_requested", threadId: "main", callId: "c", toolName: "bash", summary: "s", ...at(2000) })).toBe(s);
    expect(updateSubagents(s, { type: "approval_resolved", threadId: "main", callId: "c", approved: true, by: "u", ...at(2000) })).toBe(s);
    // ghost child threadIds are no-ops too
    expect(updateSubagents(s, { type: "tool_result", threadId: "th_ghost", output: "x", ...at(2000) })).toBe(s);
  });
});
