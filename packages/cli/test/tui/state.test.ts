import { describe, expect, test } from "bun:test";
import { initialState, reduce, type TuiState } from "../../src/tui/state";

const T0 = 1_700_000_000_000;

describe("state.ts — initialState", () => {
  test("returns the empty/idle shape", () => {
    expect(initialState()).toEqual({
      committed: [],
      activeAssistant: "",
      activeTools: [],
      tasks: [],
      agents: [],
      turnRunning: false,
      inTokens: 0,
      outTokens: 0,
      pending: null,
      childBlocks: {},
      childPendingTool: {},
    });
  });
});

describe("state.ts — assistant streaming (a)", () => {
  test("two deltas then assistant_message: activeAssistant empties, one committed block with joined text", () => {
    let s = initialState();
    s = reduce(s, { type: "assistant_delta", threadId: "main", delta: "Hello, " }, T0);
    s = reduce(s, { type: "assistant_delta", threadId: "main", delta: "world!" }, T0 + 10);
    expect(s.activeAssistant).toBe("Hello, world!");
    s = reduce(s, { type: "assistant_message", threadId: "main", text: "Hello, world!" }, T0 + 20);
    expect(s.activeAssistant).toBe("");
    expect(s.committed).toEqual([{ kind: "assistant", text: "Hello, world!" }]);
  });

  test("a non-main assistant_delta is NOT appended to activeAssistant (feeds agents instead)", () => {
    let s = initialState();
    s = reduce(s, { type: "thread_started", threadId: "th_a", parentThreadId: "main", agentType: "general-purpose", prompt: "go" }, T0);
    s = reduce(s, { type: "assistant_delta", threadId: "th_a", delta: "child text" }, T0 + 5);
    expect(s.activeAssistant).toBe("");
    expect(s.agents[0]!.liveOutputChars).toBe(10);
  });
});

describe("state.ts — tool call/result (b)", () => {
  test("tool_call then tool_result: one committed tool block, activeTools empty", () => {
    let s = initialState();
    s = reduce(s, { type: "tool_call", threadId: "main", callId: "c1", name: "bash", argsJson: '{"command":"ls"}' }, T0);
    expect(s.activeTools).toEqual([{ name: "bash", argsJson: '{"command":"ls"}' }]);
    s = reduce(s, { type: "tool_result", threadId: "main", callId: "c1", output: "file.txt", isError: false }, T0 + 5);
    expect(s.activeTools).toEqual([]);
    expect(s.committed).toEqual([{ kind: "tool", name: "bash", argsJson: '{"command":"ls"}', output: "file.txt", isError: false }]);
  });
});

describe("state.ts — spawn_agent name mapping (phase 5a T3)", () => {
  test("a spawn_agent tool_call carrying `name`, paired with a background tool_result ({agentId,status}), maps the name onto the matching AgentRow", () => {
    let s = initialState();
    s = reduce(s, { type: "thread_started", threadId: "th_bg1", parentThreadId: "main", agentType: "general-purpose", prompt: "go" }, T0);
    s = reduce(s, {
      type: "tool_call", threadId: "main", callId: "c1", name: "spawn_agent",
      argsJson: JSON.stringify({ prompt: "go", description: "scout", name: "scout-1" }),
    }, T0 + 1);
    s = reduce(s, {
      type: "tool_result", threadId: "main", callId: "c1",
      output: JSON.stringify({ agentId: "th_bg1", status: "running" }), isError: false,
    }, T0 + 2);
    expect(s.agents.find((a) => a.threadId === "th_bg1")?.name).toBe("scout-1");
  });

  test("a SYNC spawn's tool_result (the child's plain-text final report, not JSON) produces no mapping", () => {
    let s = initialState();
    s = reduce(s, { type: "thread_started", threadId: "th_sync1", parentThreadId: "main", agentType: "general-purpose", prompt: "go" }, T0);
    s = reduce(s, {
      type: "tool_call", threadId: "main", callId: "c2", name: "spawn_agent",
      argsJson: JSON.stringify({ prompt: "go", description: "scout", name: "scout-2" }),
    }, T0 + 1);
    s = reduce(s, {
      type: "tool_result", threadId: "main", callId: "c2",
      output: "the child's plain-text final report", isError: false,
    }, T0 + 2);
    expect(s.agents.find((a) => a.threadId === "th_sync1")?.name).toBeUndefined();
  });

  test("a nameless spawn (no `name` arg) produces no mapping even with a background-shaped result", () => {
    let s = initialState();
    s = reduce(s, { type: "thread_started", threadId: "th_bg2", parentThreadId: "main", agentType: "general-purpose", prompt: "go" }, T0);
    s = reduce(s, {
      type: "tool_call", threadId: "main", callId: "c3", name: "spawn_agent",
      argsJson: JSON.stringify({ prompt: "go", description: "scout" }),
    }, T0 + 1);
    s = reduce(s, {
      type: "tool_result", threadId: "main", callId: "c3",
      output: JSON.stringify({ agentId: "th_bg2", status: "running" }), isError: false,
    }, T0 + 2);
    expect(s.agents.find((a) => a.threadId === "th_bg2")?.name).toBeUndefined();
  });

  test("malformed argsJson and malformed output never throw and produce no mapping", () => {
    let s = initialState();
    s = reduce(s, { type: "thread_started", threadId: "th_bg3", parentThreadId: "main", agentType: "general-purpose", prompt: "go" }, T0);
    s = reduce(s, { type: "tool_call", threadId: "main", callId: "c4", name: "spawn_agent", argsJson: "not json" }, T0 + 1);
    expect(() => {
      s = reduce(s, { type: "tool_result", threadId: "main", callId: "c4", output: "also not json", isError: false }, T0 + 2);
    }).not.toThrow();
    expect(s.agents.find((a) => a.threadId === "th_bg3")?.name).toBeUndefined();
  });

  test("a non-spawn tool_call/tool_result is unaffected — existing tool block behavior untouched", () => {
    let s = initialState();
    s = reduce(s, { type: "tool_call", threadId: "main", callId: "c5", name: "bash", argsJson: '{"command":"ls"}' }, T0);
    s = reduce(s, { type: "tool_result", threadId: "main", callId: "c5", output: "file.txt", isError: false }, T0 + 1);
    expect(s.committed).toEqual([{ kind: "tool", name: "bash", argsJson: '{"command":"ls"}', output: "file.txt", isError: false }]);
  });

  test("no matching AgentRow yet (thread_started hasn't landed) is a silent no-op, never throws", () => {
    let s = initialState();
    s = reduce(s, {
      type: "tool_call", threadId: "main", callId: "c6", name: "spawn_agent",
      argsJson: JSON.stringify({ prompt: "go", description: "scout", name: "scout-3" }),
    }, T0);
    expect(() => {
      s = reduce(s, {
        type: "tool_result", threadId: "main", callId: "c6",
        output: JSON.stringify({ agentId: "th_ghost", status: "running" }), isError: false,
      }, T0 + 1);
    }).not.toThrow();
    expect(s.agents).toEqual([]);
  });
});

describe("state.ts — turn lifecycle (c)", () => {
  test("turn_started sets turnRunning+turnStartMs; turn_completed sets tokens+turnRunning=false and leaves agents intact", () => {
    let s = initialState();
    s = reduce(s, { type: "thread_started", threadId: "th_a", parentThreadId: "main", agentType: "general-purpose", prompt: "go" }, T0);
    s = reduce(s, { type: "turn_started", threadId: "main" }, T0 + 1);
    expect(s.turnRunning).toBe(true);
    expect(s.turnStartMs).toBe(T0 + 1);
    s = reduce(s, { type: "turn_completed", threadId: "main", stopReason: "end_turn", inputTokens: 120, outputTokens: 45 }, T0 + 500);
    expect(s.turnRunning).toBe(false);
    expect(s.inTokens).toBe(120);
    expect(s.outTokens).toBe(45);
    expect(s.agents).toHaveLength(1); // NOT wiped
    expect(s.agents[0]!.threadId).toBe("th_a");
  });

  test("a child thread's turn_started/turn_completed do not touch turnRunning/tokens", () => {
    let s = initialState();
    s = reduce(s, { type: "thread_started", threadId: "th_a", parentThreadId: "main", agentType: "general-purpose", prompt: "go" }, T0);
    s = reduce(s, { type: "turn_started", threadId: "th_a" }, T0 + 1);
    expect(s.turnRunning).toBe(false);
    expect(s.turnStartMs).toBeUndefined();
    s = reduce(s, { type: "turn_completed", threadId: "th_a", stopReason: "end_turn", inputTokens: 5, outputTokens: 5 }, T0 + 50);
    expect(s.turnRunning).toBe(false);
    expect(s.inTokens).toBe(0);
    expect(s.outTokens).toBe(0);
  });
});

describe("state.ts — THE BUG FIX: bg-agent finish survives the main turn_completed", () => {
  test("thread_started(child) -> turn_started(child) -> thread_completed(child), THEN main turn_completed: committed finish note has real label + non-zero activeMs, and agents is not wiped", () => {
    let s = initialState();
    s = reduce(s, {
      type: "thread_started", threadId: "th_bg", parentThreadId: "main", agentType: "general-purpose",
      prompt: "refactor the widget", description: "refactor widget",
    }, T0);
    s = reduce(s, { type: "turn_started", threadId: "th_bg", ts: T0 + 100 }, T0 + 100);
    s = reduce(s, { type: "tool_call", threadId: "th_bg", callId: "bg1", name: "bash", argsJson: '{"command":"echo hi"}' }, T0 + 150);
    // the child finishes BEFORE the main turn completes (the common case; the historical bug hit
    // when this ordering reversed — either way agents must never be wiped by main turn_completed)
    // updateSubagents banks activeMs off the EVENT's own `ts` (wire events always carry one; `nowMs`
    // here is `reduce`'s separately-injected clock param), so thread_completed's `ts` is what drives
    // the 14s active span, not the third argument.
    s = reduce(s, { type: "thread_completed", threadId: "th_bg", stopReason: "end_turn", ts: T0 + 14_100 }, T0 + 14_100);

    const finishNote = s.committed.find((b) => b.kind === "note" && b.text.includes("refactor widget"));
    expect(finishNote).toBeDefined();
    expect(finishNote).toEqual({ kind: "note", text: 'Agent "refactor widget": Done (1 tool use · 14s)' });

    const agentBefore = s.agents.find((a) => a.threadId === "th_bg");
    expect(agentBefore?.status).toBe("done");
    expect(agentBefore?.activeMs).toBeGreaterThan(0);

    // Now the MAIN thread's own turn_completed lands — must NOT wipe `agents` or `committed`.
    s = reduce(s, { type: "turn_completed", threadId: "main", stopReason: "end_turn", inputTokens: 10, outputTokens: 10 }, T0 + 15_000);

    expect(s.committed).toContainEqual({ kind: "note", text: 'Agent "refactor widget": Done (1 tool use · 14s)' });
    const agentAfter = s.agents.find((a) => a.threadId === "th_bg");
    expect(agentAfter).toBeDefined();
    expect(agentAfter?.label).toBe("refactor widget");
    expect(agentAfter?.activeMs).toBeGreaterThan(0);
  });

  test("the historical ordering: main turn_completed fires BEFORE the bg child's own thread_completed — the finish note still gets the real label/stats, not empty/zero", () => {
    let s = initialState();
    s = reduce(s, {
      type: "thread_started", threadId: "th_bg", parentThreadId: "main", agentType: "general-purpose",
      prompt: "long background job", description: "long background job",
    }, T0);
    s = reduce(s, { type: "turn_started", threadId: "th_bg", ts: T0 + 100 }, T0 + 100);
    // main's OWN turn finishes first (the run_in_background case: main doesn't wait for the child)
    s = reduce(s, { type: "turn_completed", threadId: "main", stopReason: "end_turn", inputTokens: 1, outputTokens: 1 }, T0 + 300);
    expect(s.agents).toHaveLength(1); // still there — not pruned by main's turn_completed

    // ... the bg child finishes much later (123s active span, matching formatElapsed's own "2m 3s" fixture)
    s = reduce(s, { type: "thread_completed", threadId: "th_bg", stopReason: "end_turn", ts: T0 + 100 + 123_000 }, T0 + 100 + 123_000);
    const finishNote = s.committed.at(-1);
    expect(finishNote).toEqual({ kind: "note", text: 'Agent "long background job": Done (0 tool uses · 2m 3s)' });
    // crucially: NOT the pre-fix bug's empty label / zero-duration placeholder
    expect((finishNote as { text: string }).text).not.toContain('Agent "": Done');
    expect((finishNote as { text: string }).text).not.toContain("· 0s");
  });
});

describe("state.ts — roster honesty: finish note verb from thread_completed.stopReason (no-timeout task)", () => {
  test("a FAILED child (stopReason 'error' — incl. a stalled one) commits 'Failed (...)', never 'Done'", () => {
    let s = initialState();
    s = reduce(s, {
      type: "thread_started", threadId: "th_f", parentThreadId: "main", agentType: "general-purpose",
      prompt: "scan the machine", description: "laptop scan",
    }, T0);
    s = reduce(s, { type: "turn_started", threadId: "th_f", ts: T0 + 100 }, T0 + 100);
    s = reduce(s, { type: "thread_completed", threadId: "th_f", stopReason: "error", ts: T0 + 5_100 }, T0 + 5_100);

    const note = s.committed.at(-1) as { kind: string; text: string };
    expect(note.kind).toBe("note");
    expect(note.text).toBe('Agent "laptop scan": Failed (0 tool uses · 5s)');
    expect(note.text).not.toContain("Done");
    // the live row carries the honest finish too (agent-list.tsx renders it)
    expect(s.agents.find((a) => a.threadId === "th_f")).toMatchObject({ status: "done", finish: "failed" });
  });

  test("a STOPPED child (stopReason 'aborted' — ESC cascade / task_stop) commits 'Stopped (...)', never 'Done'", () => {
    let s = initialState();
    s = reduce(s, {
      type: "thread_started", threadId: "th_s", parentThreadId: "main", agentType: "general-purpose",
      prompt: "long task", description: "long task",
    }, T0);
    s = reduce(s, { type: "turn_started", threadId: "th_s", ts: T0 + 100 }, T0 + 100);
    s = reduce(s, { type: "thread_completed", threadId: "th_s", stopReason: "aborted", ts: T0 + 3_100 }, T0 + 3_100);

    const note = s.committed.at(-1) as { kind: string; text: string };
    expect(note.text).toBe('Agent "long task": Stopped (0 tool uses · 3s)');
    expect(note.text).not.toContain("Done");
    expect(s.agents.find((a) => a.threadId === "th_s")).toMatchObject({ status: "done", finish: "stopped" });
  });

  // task-16 (Stalled roster verb, CC-parity follow-up): a subagent killed by the progress-stall
  // watchdog used to reach the wire as stopReason "error", rendering as a flat "Failed" —
  // indistinguishable from a genuine crash even though a stall is resumable and carries partial
  // output. It now gets its own distinct verb.
  test("a STALLED child (stopReason 'stalled' — progress-stall watchdog) commits 'Stalled (...)', never 'Done' or 'Failed'", () => {
    let s = initialState();
    s = reduce(s, {
      type: "thread_started", threadId: "th_st", parentThreadId: "main", agentType: "general-purpose",
      prompt: "scan the machine", description: "laptop scan",
    }, T0);
    s = reduce(s, { type: "turn_started", threadId: "th_st", ts: T0 + 100 }, T0 + 100);
    s = reduce(s, { type: "thread_completed", threadId: "th_st", stopReason: "stalled", ts: T0 + 4_100 }, T0 + 4_100);

    const note = s.committed.at(-1) as { kind: string; text: string };
    expect(note.text).toBe('Agent "laptop scan": Stalled (0 tool uses · 4s)');
    expect(note.text).not.toContain("Done");
    expect(note.text).not.toContain("Failed");
    expect(s.agents.find((a) => a.threadId === "th_st")).toMatchObject({ status: "done", finish: "stalled" });
  });

  test("failed/stopped rows are STILL pruned on the next main turn_started, exactly like done ones (status stays the terminal marker)", () => {
    let s = initialState();
    s = reduce(s, {
      type: "thread_started", threadId: "th_f", parentThreadId: "main", agentType: "general-purpose",
      prompt: "x", description: "failing agent",
    }, T0);
    s = reduce(s, { type: "thread_completed", threadId: "th_f", stopReason: "error", ts: T0 + 100 }, T0 + 100);
    expect(s.agents).toHaveLength(1);
    s = reduce(s, { type: "turn_started", threadId: "main" }, T0 + 200);
    expect(s.agents).toHaveLength(0); // pruned — terminal is terminal, whatever the verb
  });
});

describe("state.ts — prune done agents on next main turn_started", () => {
  test("a done agent is dropped from state.agents on the next main turn_started, a still-working agent remains, and its finish note in state.committed survives", () => {
    let s = initialState();
    // agent A: starts, runs, and finishes -> status "done", finish note committed
    s = reduce(s, {
      type: "thread_started", threadId: "th_a", parentThreadId: "main", agentType: "general-purpose",
      prompt: "refactor widget", description: "refactor widget",
    }, T0);
    s = reduce(s, { type: "turn_started", threadId: "th_a", ts: T0 + 100 }, T0 + 100);
    s = reduce(s, { type: "thread_completed", threadId: "th_a", stopReason: "end_turn", ts: T0 + 5_100 }, T0 + 5_100);
    expect(s.agents.find((a) => a.threadId === "th_a")?.status).toBe("done");

    // agent B: starts and is still working (no thread_completed yet)
    s = reduce(s, {
      type: "thread_started", threadId: "th_b", parentThreadId: "main", agentType: "general-purpose",
      prompt: "run tests", description: "run tests",
    }, T0 + 200);
    s = reduce(s, { type: "turn_started", threadId: "th_b", ts: T0 + 300 }, T0 + 300);
    expect(s.agents.find((a) => a.threadId === "th_b")?.status).toBe("working");

    const finishNoteBefore = s.committed.find((b) => b.kind === "note" && b.text.includes("refactor widget"));
    expect(finishNoteBefore).toBeDefined();

    // the main thread starts its NEXT turn — this must prune th_a (done) but keep th_b (working)
    s = reduce(s, { type: "turn_started", threadId: "main" }, T0 + 6_000);

    expect(s.agents.find((a) => a.threadId === "th_a")).toBeUndefined(); // (a) done agent gone
    expect(s.agents.find((a) => a.threadId === "th_b")).toBeDefined(); // (b) working agent remains
    expect(s.agents.find((a) => a.threadId === "th_b")?.status).toBe("working");
    // (c) the finish note is still in committed — pruning `agents` must not touch `committed`
    expect(s.committed).toContainEqual({ kind: "note", text: 'Agent "refactor widget": Done (0 tool uses · 5s)' });

    // (d) a turn_started with NO done agents is a referential no-op on `agents`
    const agentsRef = s.agents;
    const s2 = reduce(s, { type: "turn_started", threadId: "main" }, T0 + 7_000);
    expect(s2.agents).toBe(agentsRef);
  });
});

describe("state.ts — turn-summary / interrupted blocks (phase 3b Task 3, a+b)", () => {
  test("(a) main turn_completed(end_turn) commits ONE turn-summary block with real duration + tokens", () => {
    let s = initialState();
    s = reduce(s, { type: "turn_started", threadId: "main" }, T0);
    s = reduce(s, { type: "turn_completed", threadId: "main", stopReason: "end_turn", inputTokens: 13_700, outputTokens: 149 }, T0 + 12_000);
    expect(s.committed.at(-1)).toEqual({ kind: "turn-summary", durationMs: 12_000, inTokens: 13_700, outTokens: 149 });
    expect(s.committed.filter((b) => b.kind === "turn-summary")).toHaveLength(1);
  });

  test("(b) main turn_completed(stopReason 'aborted') commits an interrupted block, NOT a turn-summary", () => {
    let s = initialState();
    s = reduce(s, { type: "turn_started", threadId: "main" }, T0);
    s = reduce(s, { type: "turn_completed", threadId: "main", stopReason: "aborted", inputTokens: 5, outputTokens: 2 }, T0 + 3_000);
    expect(s.committed.at(-1)).toEqual({ kind: "interrupted" });
    expect(s.committed.some((b) => b.kind === "turn-summary")).toBe(false);
    // tokens are still tracked on state even when the turn was interrupted
    expect(s.inTokens).toBe(5);
    expect(s.outTokens).toBe(2);
  });

  test("(b) a child thread's turn_completed (any stopReason) commits neither turn-summary nor interrupted", () => {
    let s = initialState();
    s = reduce(s, { type: "thread_started", threadId: "th_a", parentThreadId: "main", agentType: "general-purpose", prompt: "go" }, T0);
    s = reduce(s, { type: "turn_started", threadId: "th_a" }, T0 + 1);
    const before = s.committed.length;
    s = reduce(s, { type: "turn_completed", threadId: "th_a", stopReason: "aborted", inputTokens: 5, outputTokens: 5 }, T0 + 50);
    expect(s.committed.length).toBe(before);
    s = reduce(s, { type: "turn_completed", threadId: "th_a", stopReason: "end_turn", inputTokens: 5, outputTokens: 5 }, T0 + 60);
    expect(s.committed.length).toBe(before);
  });

  test("turnStartMs unset (no prior main turn_started) -> durationMs is 0", () => {
    let s = initialState();
    s = reduce(s, { type: "turn_completed", threadId: "main", stopReason: "end_turn", inputTokens: 1, outputTokens: 1 }, T0 + 999);
    expect(s.committed.at(-1)).toEqual({ kind: "turn-summary", durationMs: 0, inTokens: 1, outTokens: 1 });
  });
});

describe("state.ts — task upsert/delete (e)", () => {
  test("task_updated upserts by id; a 'deleted' status removes the row", () => {
    let s = initialState();
    s = reduce(s, { type: "task_updated", threadId: "main", task: { id: "t1", subject: "write tests", status: "pending" } }, T0);
    s = reduce(s, { type: "task_updated", threadId: "main", task: { id: "t2", subject: "ship it", status: "pending" } }, T0 + 1);
    expect(s.tasks.map((t) => t.id)).toEqual(["t1", "t2"]);
    s = reduce(s, { type: "task_updated", threadId: "main", task: { id: "t1", subject: "write tests", status: "in_progress" } }, T0 + 2);
    expect(s.tasks.find((t) => t.id === "t1")?.status).toBe("in_progress");
    expect(s.tasks).toHaveLength(2);
    s = reduce(s, { type: "task_updated", threadId: "main", task: { id: "t1", subject: "write tests", status: "deleted" } }, T0 + 3);
    expect(s.tasks.map((t) => t.id)).toEqual(["t2"]);
  });
});

describe("state.ts — pending cards (f)", () => {
  test("approval_requested sets pending; approval_resolved clears it and commits a resolved note", () => {
    let s = initialState();
    s = reduce(s, { type: "approval_requested", threadId: "main", callId: "call1", toolName: "bash", summary: "rm -rf tmp/" }, T0);
    expect(s.pending).toEqual({ kind: "approval", callId: "call1", toolName: "bash", summary: "rm -rf tmp/" });
    // reviewerReason (phase 5e T5) must be OMITTED, not set to `undefined`, when the wire event
    // carries none — matches the `notes` omission convention pending-cards.test.tsx (b1) pins.
    expect(Object.prototype.hasOwnProperty.call(s.pending!, "reviewerReason")).toBe(false);
    // options (SP-approvals T7): same omission discipline.
    expect(Object.prototype.hasOwnProperty.call(s.pending!, "options")).toBe(false);
    s = reduce(s, { type: "approval_resolved", threadId: "main", callId: "call1", approved: true, by: "user" }, T0 + 5);
    expect(s.pending).toBeNull();
    expect(s.committed).toContainEqual({ kind: "note", text: "approved bash" });
  });

  test("approval_requested threads options through when the wire event carries them (SP-approvals T7)", () => {
    let s = initialState();
    const options = [
      { id: "allow_once", label: "Allow once" },
      { id: "allow_project", label: 'Allow "Bash(git push:*)" in this project', rule: "Bash(git push:*)", scope: "project" as const },
      { id: "allow_global", label: 'Allow "Bash(git push:*)" everywhere', rule: "Bash(git push:*)", scope: "global" as const },
      { id: "deny", label: "Deny" },
    ];
    s = reduce(s, { type: "approval_requested", threadId: "main", callId: "call3", toolName: "bash", summary: "git push", options }, T0);
    expect(s.pending).toEqual({ kind: "approval", callId: "call3", toolName: "bash", summary: "git push", options });
  });

  test("approval_requested threads reviewerReason through when the wire event carries one (phase 5e T5)", () => {
    let s = initialState();
    s = reduce(
      s,
      { type: "approval_requested", threadId: "main", callId: "call2", toolName: "bash", summary: "rm -rf tmp/", reviewerReason: "recursive delete outside the session cwd" },
      T0,
    );
    expect(s.pending).toEqual({
      kind: "approval",
      callId: "call2",
      toolName: "bash",
      summary: "rm -rf tmp/",
      reviewerReason: "recursive delete outside the session cwd",
    });
  });

  test("approval_resolved(denied) commits a denied note", () => {
    let s = initialState();
    s = reduce(s, { type: "approval_requested", threadId: "main", callId: "call1", toolName: "write", summary: "edit file" }, T0);
    s = reduce(s, { type: "approval_resolved", threadId: "main", callId: "call1", approved: false, by: "user" }, T0 + 5);
    expect(s.pending).toBeNull();
    expect(s.committed).toContainEqual({ kind: "note", text: "denied write" });
  });

  test("question_asked sets a question pending card", () => {
    let s = initialState();
    const questions = [{ question: "which db?", header: "DB", options: [{ label: "postgres" }, { label: "sqlite" }], multiSelect: false }];
    s = reduce(s, { type: "question_asked", threadId: "main", callId: "q1", questions }, T0);
    expect(s.pending).toEqual({ kind: "question", callId: "q1", questions });
  });

  test("question_resolved clears the pending question card and commits an answer note per question", () => {
    let s = initialState();
    const questions = [{ question: "which db?", header: "DB", options: [{ label: "postgres" }, { label: "sqlite" }], multiSelect: false }];
    s = reduce(s, { type: "question_asked", threadId: "main", callId: "q1", questions }, T0);
    expect(s.pending).not.toBeNull();
    s = reduce(s, { type: "question_resolved", threadId: "main", callId: "q1", answers: { "which db?": "postgres" }, by: "user" }, T0 + 5);
    expect(s.pending).toBeNull();
    expect(s.committed).toContainEqual({ kind: "note", text: "which db?: postgres" });
  });

  test("question_resolved with empty answers (broker timeout / resolved elsewhere) still clears pending", () => {
    let s = initialState();
    const questions = [{ question: "which db?", header: "DB", options: [{ label: "postgres" }], multiSelect: false }];
    s = reduce(s, { type: "question_asked", threadId: "main", callId: "q1", questions }, T0);
    const before = s.committed.length;
    s = reduce(s, { type: "question_resolved", threadId: "main", callId: "q1", answers: {}, by: "broker" }, T0 + 5);
    expect(s.pending).toBeNull();
    expect(s.committed.length).toBe(before); // no answers → no notes committed
  });

  test("plan_presented sets a plan pending card; plan_resolved clears it and commits the matched wording", () => {
    let s = initialState();
    s = reduce(s, { type: "plan_presented", threadId: "main", callId: "p1", plan: "1. do X\n2. do Y" }, T0);
    expect(s.pending).toEqual({ kind: "plan", callId: "p1", plan: "1. do X\n2. do Y" });
    s = reduce(s, { type: "plan_resolved", threadId: "main", callId: "p1", approved: true, autoAccept: true, by: "user" }, T0 + 5);
    expect(s.pending).toBeNull();
    expect(s.committed).toContainEqual({ kind: "note", text: "plan approved (auto-accept edits)" });
  });

  test("plan_resolved(rejected)", () => {
    let s = initialState();
    s = reduce(s, { type: "plan_presented", threadId: "main", callId: "p1", plan: "1. do X" }, T0);
    s = reduce(s, { type: "plan_resolved", threadId: "main", callId: "p1", approved: false, autoAccept: false, by: "user" }, T0 + 5);
    expect(s.committed).toContainEqual({ kind: "note", text: "plan rejected" });
  });
});

describe("state.ts — user messages", () => {
  test("user_message commits a user block", () => {
    let s = initialState();
    s = reduce(s, { type: "user_message", threadId: "main", text: "hi there", clientName: "cli-chat" }, T0);
    expect(s.committed).toEqual([{ kind: "user", text: "hi there" }]);
  });
});

describe("state.ts — note one-liners match main.ts's wording (bg-task/worktree/directory/agent_error)", () => {
  test("directory_added", () => {
    let s = initialState();
    s = reduce(s, { type: "directory_added", threadId: "main", path: "/tmp/x", persisted: true }, T0);
    expect(s.committed).toEqual([{ kind: "note", text: "+ dir /tmp/x (remembered)" }]);
    s = reduce(s, { type: "directory_added", threadId: "main", path: "/tmp/y", persisted: false }, T0);
    expect(s.committed[1]).toEqual({ kind: "note", text: "+ dir /tmp/y" });
  });

  test("bg_task_started / bg_task_output / bg_task_exited", () => {
    let s = initialState();
    s = reduce(s, { type: "bg_task_started", threadId: "main", taskId: "bg1", command: "npm run build" }, T0);
    expect(s.committed.at(-1)).toEqual({ kind: "note", text: "▶ bg bg1 started: npm run build" });
    s = reduce(s, { type: "bg_task_output", threadId: "main", taskId: "bg1", chunk: "compiling...\n" }, T0);
    expect(s.committed.at(-1)).toEqual({ kind: "note", text: "compiling...\n" });
    s = reduce(s, { type: "bg_task_exited", threadId: "main", taskId: "bg1", exitCode: 0, killed: false }, T0);
    expect(s.committed.at(-1)).toEqual({ kind: "note", text: "■ bg bg1 exited (exit 0)" });
    s = reduce(s, { type: "bg_task_exited", threadId: "main", taskId: "bg1", exitCode: null, killed: true }, T0);
    expect(s.committed.at(-1)).toEqual({ kind: "note", text: "■ bg bg1 exited (killed)" });
    // not killed but no exit code available — matches main.ts's `"exit " + e.exitCode` verbatim
    // (string-coerces null to "null"), rather than silently defaulting to "exit 0".
    s = reduce(s, { type: "bg_task_exited", threadId: "main", taskId: "bg1", exitCode: null, killed: false }, T0);
    expect(s.committed.at(-1)).toEqual({ kind: "note", text: "■ bg bg1 exited (exit null)" });
  });

  test("worktree_entered / worktree_exited", () => {
    let s = initialState();
    s = reduce(s, { type: "worktree_entered", threadId: "main", name: "feature-x", path: "/tmp/wt", branch: "feature-x" }, T0);
    expect(s.committed.at(-1)).toEqual({ kind: "note", text: "⛿ entered worktree feature-x (branch feature-x)" });
    s = reduce(s, { type: "worktree_exited", threadId: "main", name: "feature-x", action: "remove", removed: true }, T0);
    expect(s.committed.at(-1)).toEqual({ kind: "note", text: "⟲ left worktree feature-x (removed)" });
    s = reduce(s, { type: "worktree_exited", threadId: "main", name: "feature-y", action: "keep", removed: false }, T0);
    expect(s.committed.at(-1)).toEqual({ kind: "note", text: "⟲ left worktree feature-y" });
  });

  test("agent_error", () => {
    let s = initialState();
    s = reduce(s, { type: "agent_error", threadId: "main", message: "provider timeout" }, T0);
    expect(s.committed.at(-1)).toEqual({ kind: "note", text: "agent error: provider timeout" });
  });

  // task-30 (push-notification track): the CLI renders a minimal note line — real delivery is the
  // app's native alert / the daemon's headless osascript fallback, neither of which the CLI does.
  test("notification_requested", () => {
    let s = initialState();
    s = reduce(s, { type: "notification_requested", threadId: "main", title: "Norma", message: "migration finished" }, T0);
    expect(s.committed.at(-1)).toEqual({ kind: "note", text: "notification: Norma: migration finished" });
  });

  test("lease_granted / lease_lost (Phase 5 CU) — CU control notes with friendly class labels", () => {
    let s = initialState();
    const holder = { kind: "session", id: "s1" };
    s = reduce(s, { type: "lease_granted", threadId: "main", leaseId: "l1", class: "screenshot", holder, expiresAt: 0, tokenHash: "h" }, T0);
    expect(s.committed.at(-1)).toEqual({ kind: "note", text: "⌘ Norma acquired screen capture control" });
    s = reduce(s, { type: "lease_granted", threadId: "main", leaseId: "l2", class: "input-drive", holder, expiresAt: 0, tokenHash: "h" }, T0);
    expect(s.committed.at(-1)).toEqual({ kind: "note", text: "⌘ Norma acquired mouse/keyboard control" });
    s = reduce(s, { type: "lease_lost", threadId: "main", leaseId: "l1", class: "screenshot", holder, reason: "released" }, T0);
    expect(s.committed.at(-1)).toEqual({ kind: "note", text: "⌘ Norma released screen capture control (released)" });
    s = reduce(s, { type: "lease_lost", threadId: "main", leaseId: "l2", class: "ax-read", holder, reason: "provider-gone" }, T0);
    expect(s.committed.at(-1)).toEqual({ kind: "note", text: "⌘ Norma released accessibility control (provider-gone)" });
  });

  test("local_note (Phase 3d T2 — App-internal only, never a real wire event): commits a note block", () => {
    let s = initialState();
    s = reduce(s, { type: "local_note", text: "compacted (through seq 42, 900 char summary)" }, T0);
    expect(s.committed).toEqual([{ kind: "note", text: "compacted (through seq 42, 900 char summary)" }]);
    // Purely additive: every other field is untouched.
    expect(s.turnRunning).toBe(false);
    expect(s.pending).toBeNull();
  });

  // child-transcript-view T3: a threadId-routed local_note lands in THAT child's block list, not
  // the main transcript — App's child view uses this for thread.send feedback/error notes. A
  // threadId of "main" (defensive) or absent keeps the pre-existing main-committed behavior.
  test("local_note with a child threadId commits into childBlocks, never committed (T3)", () => {
    let s = initialState();
    s = reduce(s, { type: "local_note", text: "message queued", threadId: "th_1" }, T0);
    expect(s.committed).toEqual([]);
    expect(s.childBlocks["th_1"]).toEqual([{ kind: "note", text: "message queued" }]);
    s = reduce(s, { type: "local_note", text: "main note", threadId: "main" }, T0);
    expect(s.committed).toEqual([{ kind: "note", text: "main note" }]);
    expect(s.childBlocks["main"]).toBeUndefined();
  });

  // Phase 5e T1 (reviewer maturity, the wire-vocabulary/5c lesson): `tool_review` is a NEW
  // SessionEvent variant this reducer has no dedicated case for — confirms the existing `default:
  // return s` (no exhaustive switch on `e.type` here, unlike NormaKit's Swift accessor switches)
  // already no-ops gracefully, so no reducer change was needed for this task. A later task (T5)
  // may add a dedicated rendering; this only pins today's safe-by-construction behavior.
  test("tool_review (unknown to this reducer) is a no-op: state is byte-identical", () => {
    const s = initialState();
    const next = reduce(s, {
      type: "tool_review", threadId: "main", toolName: "bash", verdict: "unsafe",
      reason: "recursive delete outside cwd", summary: "bash rm -rf /tmp/x",
    }, T0);
    expect(next).toEqual(s);
  });
});

describe("state.ts — child transcript accumulation (child-transcript-view T2)", () => {
  test("user/assistant/tool events for a child thread accumulate into childBlocks[threadId], isolated across threads", () => {
    let s = initialState();
    s = reduce(s, { type: "thread_started", threadId: "th_a", parentThreadId: "main", agentType: "general-purpose", prompt: "go" }, T0);
    s = reduce(s, { type: "thread_started", threadId: "th_b", parentThreadId: "main", agentType: "general-purpose", prompt: "go" }, T0);

    s = reduce(s, { type: "user_message", threadId: "th_a", text: "steer th_a", clientName: "send_message" }, T0 + 1);
    s = reduce(s, { type: "assistant_message", threadId: "th_a", text: "on it" }, T0 + 2);
    s = reduce(s, { type: "tool_call", threadId: "th_a", callId: "c1", name: "bash", argsJson: '{"command":"ls"}' }, T0 + 3);
    s = reduce(s, { type: "tool_result", threadId: "th_a", callId: "c1", output: "file.txt", isError: false }, T0 + 4);

    s = reduce(s, { type: "assistant_message", threadId: "th_b", text: "different agent" }, T0 + 5);

    expect(s.childBlocks["th_a"]).toEqual([
      { kind: "user", text: "steer th_a" },
      { kind: "assistant", text: "on it" },
      { kind: "tool", name: "bash", argsJson: '{"command":"ls"}', output: "file.txt", isError: false },
    ]);
    expect(s.childBlocks["th_b"]).toEqual([{ kind: "assistant", text: "different agent" }]);

    // MAIN's own committed transcript is untouched by any of this (isolation from the main path).
    expect(s.committed).toEqual([]);
    // The child's tool_call/tool_result pairing is consumed — no dangling pending entry.
    expect(s.childPendingTool["th_a"]).toBeUndefined();
  });

  test("user_message from a steer drain (clientName 'send_message', non-MAIN threadId) renders as a user block in the child's list, not the main transcript", () => {
    let s = initialState();
    s = reduce(s, { type: "thread_started", threadId: "th_c", parentThreadId: "main", agentType: "general-purpose", prompt: "go" }, T0);
    s = reduce(s, { type: "user_message", threadId: "th_c", text: "please also check the tests", clientName: "send_message" }, T0 + 1);
    expect(s.childBlocks["th_c"]).toEqual([{ kind: "user", text: "please also check the tests" }]);
    expect(s.committed).toEqual([]);
  });

  test("MAIN blocks are byte-identical to before the refactor (regression pin for the shared helpers)", () => {
    let s = initialState();
    s = reduce(s, { type: "user_message", threadId: "main", text: "hi", clientName: "cli-chat" }, T0);
    s = reduce(s, { type: "assistant_message", threadId: "main", text: "hello back" }, T0 + 1);
    s = reduce(s, { type: "tool_call", threadId: "main", callId: "c1", name: "bash", argsJson: '{"command":"ls"}' }, T0 + 2);
    s = reduce(s, { type: "tool_result", threadId: "main", callId: "c1", output: "file.txt", isError: false }, T0 + 3);
    expect(s.committed).toEqual([
      { kind: "user", text: "hi" },
      { kind: "assistant", text: "hello back" },
      { kind: "tool", name: "bash", argsJson: '{"command":"ls"}', output: "file.txt", isError: false },
    ]);
    // Nothing leaked into childBlocks for the main thread.
    expect(s.childBlocks).toEqual({});
  });

  test("cap: appending past CHILD_BLOCK_CAP (200) drops the oldest, keeping exactly 200 with the newest content", () => {
    let s = initialState();
    s = reduce(s, { type: "thread_started", threadId: "th_cap", parentThreadId: "main", agentType: "general-purpose", prompt: "go" }, T0);
    for (let i = 0; i < 205; i++) {
      s = reduce(s, { type: "user_message", threadId: "th_cap", text: `msg-${i}` }, T0 + i);
    }
    const blocks = s.childBlocks["th_cap"]!;
    expect(blocks).toHaveLength(200);
    expect(blocks[0]).toEqual({ kind: "user", text: "msg-5" }); // oldest 5 (msg-0..msg-4) dropped
    expect(blocks.at(-1)).toEqual({ kind: "user", text: "msg-204" });
  });

  test("child thread_completed appends the finish-verb note to childBlocks[threadId] (reusing subagent-state's finish mapping), same block as the roster-wide note", () => {
    let s = initialState();
    s = reduce(s, {
      type: "thread_started", threadId: "th_st", parentThreadId: "main", agentType: "general-purpose",
      prompt: "scan the machine", description: "laptop scan",
    }, T0);
    s = reduce(s, { type: "turn_started", threadId: "th_st", ts: T0 + 100 }, T0 + 100);
    s = reduce(s, { type: "thread_completed", threadId: "th_st", stopReason: "stalled", ts: T0 + 4_100 }, T0 + 4_100);

    const expectedNote = { kind: "note" as const, text: 'Agent "laptop scan": Stalled (0 tool uses · 4s)' };
    expect(s.childBlocks["th_st"]).toContainEqual(expectedNote);
    expect(s.committed).toContainEqual(expectedNote); // same block, both destinations
  });

  test("child turn_completed appends a turn-summary block (or interrupted, on stopReason 'aborted') to childBlocks, with this turn's own duration", () => {
    let s = initialState();
    s = reduce(s, { type: "thread_started", threadId: "th_multi", parentThreadId: "main", agentType: "general-purpose", prompt: "go" }, T0);
    s = reduce(s, { type: "turn_started", threadId: "th_multi", ts: T0 + 100 }, T0 + 100);
    s = reduce(s, { type: "turn_completed", threadId: "th_multi", stopReason: "end_turn", inputTokens: 10, outputTokens: 5, ts: T0 + 3_100 }, T0 + 3_100);
    expect(s.childBlocks["th_multi"]).toContainEqual({ kind: "turn-summary", durationMs: 3_000, inTokens: 10, outTokens: 5 });

    s = reduce(s, { type: "turn_started", threadId: "th_multi", ts: T0 + 3_200 }, T0 + 3_200);
    s = reduce(s, { type: "turn_completed", threadId: "th_multi", stopReason: "aborted", inputTokens: 1, outputTokens: 1, ts: T0 + 3_700 }, T0 + 3_700);
    expect(s.childBlocks["th_multi"]).toContainEqual({ kind: "interrupted" });
  });

  test("pruning a done agent's roster row on the next main turn_started also drops its childBlocks (and childPendingTool) entry", () => {
    let s = initialState();
    s = reduce(s, {
      type: "thread_started", threadId: "th_p", parentThreadId: "main", agentType: "general-purpose",
      prompt: "refactor widget", description: "refactor widget",
    }, T0);
    s = reduce(s, { type: "turn_started", threadId: "th_p", ts: T0 + 100 }, T0 + 100);
    s = reduce(s, { type: "user_message", threadId: "th_p", text: "go" }, T0 + 150);
    s = reduce(s, { type: "thread_completed", threadId: "th_p", stopReason: "end_turn", ts: T0 + 5_100 }, T0 + 5_100);
    expect(s.childBlocks["th_p"]).toBeDefined();
    expect(s.childBlocks["th_p"]!.length).toBeGreaterThan(0);

    s = reduce(s, { type: "turn_started", threadId: "main" }, T0 + 6_000);
    expect(s.agents.find((a) => a.threadId === "th_p")).toBeUndefined(); // roster row gone (pre-existing prune)
    expect(s.childBlocks["th_p"]).toBeUndefined(); // its transcript entry is gone too
    expect(s.childPendingTool["th_p"]).toBeUndefined();
  });
});

describe("state.ts — purity", () => {
  test("reduce never touches Date.now(): identical nowMs replays produce identical output", () => {
    const events = [
      { type: "turn_started", threadId: "main" },
      { type: "assistant_delta", threadId: "main", delta: "hi" },
      { type: "assistant_message", threadId: "main", text: "hi" },
      { type: "turn_completed", threadId: "main", stopReason: "end_turn", inputTokens: 1, outputTokens: 1 },
    ];
    const run = () => events.reduce<TuiState>((acc, e) => reduce(acc, e, T0 + 42), initialState());
    expect(run()).toEqual(run());
  });
});
