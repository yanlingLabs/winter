import { describe, expect, test } from "bun:test";
import {
  SessionEvent, SYSTEM_SESSION_ID, TaskSchema, PANEL_COMMAND_ACTIONS,
  BROWSER_COMMAND_ACTIONS, OFFICE_COMMAND_ACTIONS, PANEL_COMMAND_ARGS_MAX_JSON_BYTES,
} from "../src/events";
import {
  HelloParams, HelloResult, PROTOCOL_VERSION,
  PanelCommandResultParams, PANEL_COMMAND_RESULT_MAX_LENGTH, PANEL_COMMAND_IMAGE_B64_MAX_LENGTH,
} from "../src/methods";

describe("SessionEvent discriminated union", () => {
  const base = { seq: 1, sessionId: "s_abc", ts: 1781270000000 };

  test("user_message round-trips", () => {
    const e = { ...base, type: "user_message", threadId: "main", text: "hi", clientName: "cli-1" } as const;
    expect(SessionEvent.parse(e)).toEqual(e);
  });

  test("each variant parses and narrows on type", () => {
    const events = [
      { ...base, type: "session_created", scope: "global" },
      { ...base, type: "harness_attached", clientName: "orb" },
      { ...base, type: "harness_detached", clientName: "orb" },
      { ...base, type: "user_message", threadId: "main", text: "x", clientName: "a" },
    ] as const;
    for (const e of events) {
      const parsed = SessionEvent.parse(e);
      expect(parsed.type).toBe(e.type);
    }
  });

  test("user_message rejects empty text", () => {
    expect(() =>
      SessionEvent.parse({ ...base, type: "user_message", threadId: "main", text: "", clientName: "cli-1" })
    ).toThrow();
  });

  test("unknown type rejected; missing discriminator rejected", () => {
    expect(() => SessionEvent.parse({ ...base, type: "nope" })).toThrow();
    expect(() => SessionEvent.parse(base)).toThrow();
  });

  test("negative seq rejected", () => {
    expect(() => SessionEvent.parse({ ...base, seq: -1, type: "session_created", scope: "g" })).toThrow();
  });

  test("agent event variants parse", () => {
    const t = { ...base, threadId: "main" };
    const events = [
      { ...t, type: "turn_started" },
      { ...t, type: "assistant_message", text: "done!" },
      { ...t, type: "tool_call", callId: "c1", name: "read", argsJson: "{}" },
      { ...t, type: "tool_result", callId: "c1", output: "contents", isError: false },
      { ...t, type: "approval_requested", callId: "c2", toolName: "write", summary: "write hello.txt (24 bytes)", issuedAt: 1781270000000, expiresAt: 1781270300000 },
      { ...t, type: "approval_resolved", callId: "c2", approved: true, by: "cli-p" },
      { ...t, type: "turn_completed", stopReason: "end_turn", inputTokens: 100, outputTokens: 20 },
      { ...t, type: "agent_error", message: "not signed in" },
    ] as const;
    for (const e of events) expect(SessionEvent.parse(e).type).toBe(e.type);
  });

  // Phase 5 routines T3: `code` is additive-optional on the EXISTING agent_error variant (no new
  // SessionEvent variant, no NormaKit exhaustive-switch trap) — an older-shaped payload with no
  // `code` still parses (the "agent event variants parse" test above already covers that), and a
  // payload carrying one round-trips it losslessly.
  test("agent_error.code is additive-optional: present round-trips, absent stays undefined", () => {
    const t = { ...base, threadId: "main" };
    const withCode = { ...t, type: "agent_error", message: "HTTP 429 — rate limited", code: "rate_limit" } as const;
    expect(SessionEvent.parse(withCode)).toEqual(withCode);
    const withoutCode = SessionEvent.parse({ ...t, type: "agent_error", message: "tool crashed" });
    expect(withoutCode.type).toBe("agent_error");
    expect((withoutCode as { code?: string }).code).toBeUndefined();
  });

  test("assistant_delta parses; empty delta rejected", () => {
    const e = { ...base, threadId: "main", type: "assistant_delta", delta: "wor" } as const;
    expect(SessionEvent.parse(e)).toEqual(e);
    expect(() => SessionEvent.parse({ ...base, threadId: "main", type: "assistant_delta", delta: "" })).toThrow();
  });

  test("directory_added variant parses", () => {
    const e = { ...base, threadId: "main", type: "directory_added", path: "/opt/data", persisted: true };
    expect(SessionEvent.parse(e)).toMatchObject({ type: "directory_added", path: "/opt/data", persisted: true });
  });

  test("bg_task_* variants parse", () => {
    for (const e of [
      { ...base, threadId: "main", type: "bg_task_started", taskId: "bg_a1", command: "sleep 5" },
      { ...base, threadId: "main", type: "bg_task_output", taskId: "bg_a1", chunk: "line1\n" },
      { ...base, threadId: "main", type: "bg_task_exited", taskId: "bg_a1", exitCode: 0, killed: false },
      { ...base, threadId: "main", type: "bg_task_exited", taskId: "bg_a1", exitCode: null, killed: true },
    ]) {
      expect(SessionEvent.parse(e).type).toBe(e.type as SessionEvent["type"]);
    }
  });

  test("tool_result caps are enforced by schema shape only (output is plain string)", () => {
    const e = { ...base, threadId: "main", type: "tool_result", callId: "c", output: "x".repeat(100), isError: true };
    expect(SessionEvent.parse(e)).toMatchObject({ isError: true });
  });

  test("checkpoint event parses", () => {
    const e = SessionEvent.parse({ seq: 3, ts: 1781270000000, sessionId: "s_x", type: "checkpoint", threadId: "main", summary: "did X, decided Y", uptoSeq: 2 });
    expect(e.type).toBe("checkpoint" as SessionEvent["type"]);
    if (e.type === "checkpoint") { expect(e.uptoSeq).toBe(2); expect(e.summary).toContain("decided Y"); }
  });

  test("question_asked / question_resolved / task_updated round-trip", () => {
    const qa = {
      type: "question_asked" as const, sessionId: "s", threadId: "t", seq: 1, ts: 1, callId: "c1",
      questions: [
        { question: "Which codename?", header: "Codename", options: [{ label: "Falcon" }, { label: "Osprey", description: "the bird" }], multiSelect: false },
        { question: "Which features?", header: "Features", options: [{ label: "A" }, { label: "B" }, { label: "C" }], multiSelect: true },
      ],
    };
    expect(SessionEvent.parse(qa)).toEqual(qa);

    const qr = {
      type: "question_resolved", sessionId: "s", threadId: "t", seq: 2, ts: 2, callId: "c1",
      answers: { "Which codename?": "Osprey" }, by: "cli",
    } as const;
    expect(SessionEvent.parse(qr)).toEqual(qr);

    const tu = {
      type: "task_updated", sessionId: "s", threadId: "t", seq: 3, ts: 3,
      task: { id: "1", subject: "rename", status: "pending" },
    } as const;
    expect(SessionEvent.parse(tu)).toEqual(tu);

    // T3 review fix wave 1: task_update{status:"deleted"} now round-trips a "deleted" status too.
    const tuDeleted = {
      type: "task_updated", sessionId: "s", threadId: "t", seq: 4, ts: 4,
      task: { id: "1", subject: "rename", status: "deleted" },
    } as const;
    expect(SessionEvent.parse(tuDeleted)).toEqual(tuDeleted);
  });

  // 4h-ii-d (CC parity): Task gains owner/blocks/blockedBy/metadata, all optional/additive.
  test("TaskSchema: owner/blocks/blockedBy/metadata parse when present, and are absent when omitted (old shape)", () => {
    const withGraphFields = {
      id: "1", subject: "rename", status: "pending" as const,
      owner: "researcher", blocks: ["2", "3"], blockedBy: ["0"], metadata: { priority: "high", count: 2 },
    };
    expect(TaskSchema.parse(withGraphFields)).toEqual(withGraphFields);

    const oldShape = { id: "1", subject: "rename", status: "pending" as const };
    expect(TaskSchema.parse(oldShape)).toEqual(oldShape);
  });

  test("task_updated round-trips a task with owner/blocks/blockedBy/metadata present", () => {
    const tu = {
      type: "task_updated" as const, sessionId: "s", threadId: "t", seq: 5, ts: 5,
      task: { id: "1", subject: "rename", status: "pending" as const, owner: "user", blocks: ["2"], blockedBy: [] as string[], metadata: { k: "v" } },
    };
    expect(SessionEvent.parse(tu)).toEqual(tu);
  });

  // CC AskUserQuestion parity: per-option `preview` and per-answer `notes` are additive/optional —
  // both round-trip when present, and existing question_asked/question_resolved shapes without
  // them still parse unchanged.
  test("question_asked option preview / question_resolved notes round-trip (optional, additive)", () => {
    const qaWithPreview = {
      type: "question_asked" as const, sessionId: "s", threadId: "t", seq: 1, ts: 1, callId: "c1",
      questions: [
        { question: "Which theme?", header: "Theme", multiSelect: false, options: [
          { label: "Falcon", description: "the bird", preview: "--- a\n+++ b\n+falcon" },
          { label: "Osprey" },
        ] },
      ],
    };
    expect(SessionEvent.parse(qaWithPreview)).toEqual(qaWithPreview);

    const qrWithNotes = {
      type: "question_resolved" as const, sessionId: "s", threadId: "t", seq: 2, ts: 2, callId: "c1",
      answers: { "Which theme?": "Falcon" }, notes: { "Which theme?": "prefer the bird motif" }, by: "cli",
    };
    expect(SessionEvent.parse(qrWithNotes)).toEqual(qrWithNotes);

    // Both fields remain optional: the pre-existing shapes (no preview, no notes) still parse.
    const qaNoPreview = {
      type: "question_asked" as const, sessionId: "s", threadId: "t", seq: 3, ts: 3, callId: "c2",
      questions: [{ question: "Q?", header: "H", multiSelect: false, options: [{ label: "A" }, { label: "B" }] }],
    };
    expect(SessionEvent.parse(qaNoPreview)).toEqual(qaNoPreview);

    const qrNoNotes = {
      type: "question_resolved" as const, sessionId: "s", threadId: "t", seq: 4, ts: 4, callId: "c2",
      answers: { "Q?": "A" }, by: "cli",
    };
    expect(SessionEvent.parse(qrNoNotes)).toEqual(qrNoNotes);
  });

  test("bounds: 0/5 questions, 1/5 options, 13-char header rejected", () => {
    const t = { seq: 1, sessionId: "s", ts: 1, threadId: "t" };
    const validQuestion = { question: "Q?", header: "Header", options: [{ label: "A" }, { label: "B" }], multiSelect: false };

    expect(SessionEvent.safeParse({ ...t, type: "question_asked", callId: "c", questions: [] }).success).toBe(false); // 0 questions
    expect(SessionEvent.safeParse({ ...t, type: "question_asked", callId: "c", questions: Array(5).fill(validQuestion) }).success).toBe(false); // 5 questions
    expect(SessionEvent.safeParse({ ...t, type: "question_asked", callId: "c", questions: [validQuestion] }).success).toBe(true); // 1 question ok
    expect(SessionEvent.safeParse({ ...t, type: "question_asked", callId: "c", questions: [{ ...validQuestion, options: [{ label: "A" }] }] }).success).toBe(false); // 1 option
    expect(SessionEvent.safeParse({ ...t, type: "question_asked", callId: "c", questions: [{ ...validQuestion, options: Array(5).fill({ label: "A" }) }] }).success).toBe(false); // 5 options
    expect(SessionEvent.safeParse({ ...t, type: "question_asked", callId: "c", questions: [{ ...validQuestion, header: "H".repeat(13) }] }).success).toBe(false); // 13-char header
    expect(SessionEvent.safeParse({ ...t, type: "question_asked", callId: "c", questions: [{ ...validQuestion, header: "H".repeat(12) }] }).success).toBe(true); // 12-char header ok
  });

  test("plan_presented / plan_resolved round-trip", () => {
    const pp = { type: "plan_presented", sessionId: "s", threadId: "t", seq: 1, ts: 1, callId: "c1", plan: "# Plan\n1. do X" } as const;
    expect(SessionEvent.parse(pp)).toEqual(pp);
    const pr = { type: "plan_resolved", sessionId: "s", threadId: "t", seq: 2, ts: 2, callId: "c1", approved: true, feedback: "looks good", autoAccept: true, by: "cli" } as const;
    expect(SessionEvent.parse(pr)).toEqual(pr);
  });

  test("plan_presented requires a non-empty plan", () => {
    expect(SessionEvent.safeParse({ type: "plan_presented", sessionId: "s", threadId: "t", seq: 1, ts: 1, callId: "c", plan: "" }).success).toBe(false);
  });

  test("worktree_entered / worktree_exited round-trip", () => {
    const we = { type: "worktree_entered", sessionId: "s", threadId: "t", seq: 1, ts: 1, name: "fix-auth", path: "/repo/.norma/worktrees/fix-auth", branch: "norma/fix-auth" } as const;
    expect(SessionEvent.parse(we)).toEqual(we);
    const wx = { type: "worktree_exited", sessionId: "s", threadId: "t", seq: 2, ts: 2, name: "fix-auth", action: "keep", removed: false } as const;
    expect(SessionEvent.parse(wx)).toEqual(wx);
  });

  test("worktree_entered rejects empty name/path/branch; worktree_exited rejects bad action", () => {
    const t = { sessionId: "s", threadId: "t", seq: 1, ts: 1 };
    expect(SessionEvent.safeParse({ ...t, type: "worktree_entered", name: "", path: "/p", branch: "b" }).success).toBe(false);
    expect(SessionEvent.safeParse({ ...t, type: "worktree_entered", name: "n", path: "", branch: "b" }).success).toBe(false);
    expect(SessionEvent.safeParse({ ...t, type: "worktree_entered", name: "n", path: "/p", branch: "" }).success).toBe(false);
    expect(SessionEvent.safeParse({ ...t, type: "worktree_exited", name: "n", action: "delete", removed: false }).success).toBe(false);
  });

  test("thread_started / thread_completed round-trip", () => {
    const ts = { type: "thread_started", sessionId: "s", threadId: "th_child1", seq: 1, ts: 1, parentThreadId: "main", agentType: "researcher", prompt: "Summarize the auth module" } as const;
    expect(SessionEvent.parse(ts)).toEqual(ts);
    const tc = { type: "thread_completed", sessionId: "s", threadId: "th_child1", seq: 2, ts: 2, stopReason: "end_turn" } as const;
    expect(SessionEvent.parse(tc)).toEqual(tc);
  });

  test("thread_started rejects empty parentThreadId; thread_completed rejects bad stopReason", () => {
    const t = { sessionId: "s", threadId: "th_child1", seq: 1, ts: 1 };
    expect(SessionEvent.safeParse({ ...t, type: "thread_started", parentThreadId: "", agentType: "researcher", prompt: "x" }).success).toBe(false);
    expect(SessionEvent.safeParse({ ...t, type: "thread_completed", stopReason: "bogus" }).success).toBe(false);
  });

  test("lease_granted / lease_lost / peripheral_call_requested round-trip", () => {
    const t = { sessionId: "s", threadId: "main", seq: 1, ts: 1 };
    const holder = { kind: "session" as const, id: "s" };

    const granted = { ...t, type: "lease_granted", leaseId: "lease_1", class: "screenshot", holder, expiresAt: 20, tokenHash: "a".repeat(64) } as const;
    expect(SessionEvent.parse(granted)).toEqual(granted);

    const lost = { ...t, type: "lease_lost", leaseId: "lease_1", class: "screenshot", holder, reason: "expired" } as const;
    expect(SessionEvent.parse(lost)).toEqual(lost);

    const called = { ...t, type: "peripheral_call_requested", requestId: "req_1", leaseId: "lease_1", token: "tok_1", class: "noop", payloadJson: "{}" } as const;
    expect(SessionEvent.parse(called)).toEqual(called);
  });

  test("lease events reject unknown class, unknown holder kind, unknown lease_lost reason", () => {
    const t = { sessionId: "s", threadId: "main", seq: 1, ts: 1 };
    const holder = { kind: "session", id: "s" };
    const tokenHash = "a".repeat(64);
    expect(SessionEvent.safeParse({ ...t, type: "lease_granted", leaseId: "l", class: "bogus", holder, expiresAt: 1, tokenHash }).success).toBe(false);
    expect(SessionEvent.safeParse({ ...t, type: "lease_granted", leaseId: "l", class: "noop", holder: { kind: "bogus", id: "s" }, expiresAt: 1, tokenHash }).success).toBe(false);
    expect(SessionEvent.safeParse({ ...t, type: "lease_lost", leaseId: "l", class: "noop", holder, reason: "bogus" }).success).toBe(false);
    for (const reason of ["expired", "released", "panic", "revoked", "provider-gone"]) {
      expect(SessionEvent.safeParse({ ...t, type: "lease_lost", leaseId: "l", class: "noop", holder, reason }).success).toBe(true);
    }
  });

  test("lease_granted rejects a missing/empty tokenHash (spec §A1: no token, no service)", () => {
    const t = { sessionId: "s", threadId: "main", seq: 1, ts: 1 };
    const holder = { kind: "session" as const, id: "s" };
    expect(SessionEvent.safeParse({ ...t, type: "lease_granted", leaseId: "l", class: "noop", holder, expiresAt: 1 }).success).toBe(false);
    expect(SessionEvent.safeParse({ ...t, type: "lease_granted", leaseId: "l", class: "noop", holder, expiresAt: 1, tokenHash: "" }).success).toBe(false);
  });

  test("all four peripheral classes accepted: screenshot, ax-read, input-drive, noop", () => {
    const t = { sessionId: "s", threadId: "main", seq: 1, ts: 1 };
    const holder = { kind: "plugin" as const, id: "p_1" };
    for (const cls of ["screenshot", "ax-read", "input-drive", "noop"]) {
      expect(SessionEvent.safeParse({ ...t, type: "lease_granted", leaseId: "l", class: cls, holder, expiresAt: 1, tokenHash: "a".repeat(64) }).success).toBe(true);
    }
  });

  // Phase 4b Task 1 (spec §3): plugin.register's `tool.register`'d tools get invoked over the
  // plugin's own connection via this push, mirroring peripheral_call_requested's request/response
  // shape one-for-one — the plugin answers with `plugin.toolResult` (methods.ts).
  test("plugin_tool_invoke round-trips", () => {
    const t = { sessionId: "s", threadId: "main", seq: 1, ts: 1 };
    const invoke = { ...t, type: "plugin_tool_invoke", requestId: "req_1", tool: "echo", argsJson: '{"text":"hi"}' } as const;
    expect(SessionEvent.parse(invoke)).toEqual(invoke);
  });

  test("plugin_tool_invoke rejects empty requestId/tool", () => {
    const t = { sessionId: "s", threadId: "main", seq: 1, ts: 1 };
    expect(SessionEvent.safeParse({ ...t, type: "plugin_tool_invoke", requestId: "", tool: "echo", argsJson: "{}" }).success).toBe(false);
    expect(SessionEvent.safeParse({ ...t, type: "plugin_tool_invoke", requestId: "req_1", tool: "", argsJson: "{}" }).success).toBe(false);
    // argsJson has no min(1) — an argument-less tool invoke still needs a wire representation ("{}"),
    // and zod's z.string() alone (matching tool_call's argsJson) allows the empty string too.
    expect(SessionEvent.safeParse({ ...t, type: "plugin_tool_invoke", requestId: "req_1", tool: "echo", argsJson: "" }).success).toBe(true);
  });

  // Phase 4c Task 1 (spec §5): core pushes this to the active provider connection (Norma.app)
  // when a plugin (or the harness) calls hardware.request; mirrors plugin_tool_invoke's
  // request/response shape one-for-one — the provider answers with hardware.respond (methods.ts).
  test("hardware_requested round-trips", () => {
    const t = { sessionId: "s", threadId: "main", seq: 1, ts: 1 };
    const requested = { ...t, type: "hardware_requested", requestId: "req_1", verb: "setChargeLimit", argsJson: '{"percent":80}' } as const;
    expect(SessionEvent.parse(requested)).toEqual(requested);
  });

  test("hardware_requested rejects empty requestId/verb", () => {
    const t = { sessionId: "s", threadId: "main", seq: 1, ts: 1 };
    expect(SessionEvent.safeParse({ ...t, type: "hardware_requested", requestId: "", verb: "setChargeLimit", argsJson: "{}" }).success).toBe(false);
    expect(SessionEvent.safeParse({ ...t, type: "hardware_requested", requestId: "req_1", verb: "", argsJson: "{}" }).success).toBe(false);
    // argsJson has no min(1) — an argument-less verb still needs a wire representation ("{}"),
    // and zod's z.string() alone (matching plugin_tool_invoke's argsJson) allows the empty string too.
    expect(SessionEvent.safeParse({ ...t, type: "hardware_requested", requestId: "req_1", verb: "getChargeLimit", argsJson: "" }).success).toBe(true);
  });

  // Phase 4d Task 1 (spec §6/§7): core broadcasts this to every authed harness (ipc/server.ts's
  // harnessConns loop) when a plugin's tile.update lands, and again with tile:null on disconnect
  // — session-less, so sessionId is always the SYSTEM_SESSION_ID sentinel, and it extends Base
  // (no threadId) rather than ThreadBase.
  test("plugin_tile_updated round-trips; sessionId is the $system sentinel; tile:null (cleared) accepted", () => {
    const e = {
      seq: 5, sessionId: SYSTEM_SESSION_ID, ts: 1781270000000,
      type: "plugin_tile_updated", pluginId: "sample-echo", tile: { title: "Sample", value: "1" },
    } as const;
    expect(SessionEvent.parse(e)).toEqual(e);
    expect(e.sessionId).toBe("$system");

    const cleared = { ...e, tile: null } as const;
    expect(SessionEvent.parse(cleared)).toEqual(cleared);
  });

  test("plugin_tile_updated rejects an empty pluginId", () => {
    const t = { seq: 1, sessionId: SYSTEM_SESSION_ID, ts: 1 };
    expect(SessionEvent.safeParse({ ...t, type: "plugin_tile_updated", pluginId: "", tile: null }).success).toBe(false);
  });

  // Phase 4d Task 2 (spec §6/§7): the reverse direction — core pushes these directly to a
  // plugin's own connection (`shortcut.invoke`/`tile.action`, methods.ts). Session-less like
  // plugin_tile_updated, so sessionId is always the $system sentinel, and both extend Base (no
  // threadId) rather than ThreadBase.
  test("shortcut_invoke round-trips; sessionId is the $system sentinel", () => {
    const e = {
      seq: 6, sessionId: SYSTEM_SESSION_ID, ts: 1781270000001,
      type: "shortcut_invoke", shortcutId: "toggle-mute",
    } as const;
    expect(SessionEvent.parse(e)).toEqual(e);
    expect(e.sessionId).toBe("$system");
  });

  test("shortcut_invoke rejects an empty shortcutId", () => {
    const t = { seq: 1, sessionId: SYSTEM_SESSION_ID, ts: 1 };
    expect(SessionEvent.safeParse({ ...t, type: "shortcut_invoke", shortcutId: "" }).success).toBe(false);
  });

  test("tile_action round-trips; sessionId is the $system sentinel", () => {
    const e = {
      seq: 7, sessionId: SYSTEM_SESSION_ID, ts: 1781270000002,
      type: "tile_action", actionId: "reconnect",
    } as const;
    expect(SessionEvent.parse(e)).toEqual(e);
    expect(e.sessionId).toBe("$system");
  });

  test("tile_action rejects an empty actionId", () => {
    const t = { seq: 1, sessionId: SYSTEM_SESSION_ID, ts: 1 };
    expect(SessionEvent.safeParse({ ...t, type: "tile_action", actionId: "" }).success).toBe(false);
  });

  // history-parity Task 3 (CC/Codex parity): an opaque provider reasoning item (Responses API),
  // captured at output_item.done, persisted to the session JSONL and replayed verbatim into later
  // requests. itemJson is SENSITIVE opaque state (encrypted_content) — clients deliberately don't
  // model this variant (they skip unknown types, so it never renders) and NO generator fixture
  // exists (see events.ts's doc comment). z.string().min(1) rejects an empty itemJson.
  test("reasoning_item round-trips; the union accepts it; empty itemJson rejected", () => {
    const e = {
      ...base, threadId: "main", type: "reasoning_item",
      itemJson: '{"type":"reasoning","summary":[],"encrypted_content":"EC1"}',
    } as const;
    const parsed = SessionEvent.parse(e);
    expect(parsed).toEqual(e);
    expect(parsed.type).toBe("reasoning_item" as SessionEvent["type"]);
    expect(SessionEvent.safeParse({ ...base, threadId: "main", type: "reasoning_item", itemJson: "" }).success).toBe(false);
  });

  // bg-retrigger Task 1 (CC parity): background-agent completion notice — persisted (engine.ts's
  // notifyBgCompletion) and replayed as a user-role history message so the model learns a detached
  // agent finished without a user keystroke. Same no-generator-fixture precedent as reasoning_item
  // above (see this variant's own doc comment in events.ts).
  test("task_notification round-trips; the union accepts it; empty content rejected", () => {
    const e = {
      ...base, threadId: "main", type: "task_notification",
      content: "<task-notification>\n<task-id>th_1</task-id>\n<status>completed</status>\n<summary>Agent \"th_1\" completed</summary>\n<result>done</result>\n</task-notification>",
    } as const;
    const parsed = SessionEvent.parse(e);
    expect(parsed).toEqual(e);
    expect(parsed.type).toBe("task_notification" as SessionEvent["type"]);
    expect(SessionEvent.safeParse({ ...base, threadId: "main", type: "task_notification", content: "" }).success).toBe(false);
  });

  // Phase 5e T1 (reviewer maturity, the NormaKit-trap task): a NEW SessionEvent variant, persisted
  // once per actual reviewer.review() invocation (engine.ts, T2) — observability only, never
  // replayed into the model (eventToInput ignores it, unchanged in this task).
  test("tool_review round-trips for all three verdicts", () => {
    for (const verdict of ["safe", "unsafe", "error"] as const) {
      const e = {
        ...base, threadId: "main", type: "tool_review", toolName: "bash", verdict,
        reason: "flagged: recursive delete outside cwd", summary: "bash rm -rf /tmp/scratch",
      } as const;
      expect(SessionEvent.parse(e)).toEqual(e);
    }
  });

  test("tool_review rejects an unknown verdict and an empty toolName", () => {
    const t = { ...base, threadId: "main" };
    expect(SessionEvent.safeParse({ ...t, type: "tool_review", toolName: "bash", verdict: "maybe", reason: "x", summary: "y" }).success).toBe(false);
    expect(SessionEvent.safeParse({ ...t, type: "tool_review", toolName: "", verdict: "safe", reason: "x", summary: "y" }).success).toBe(false);
  });

  // session-activity-hygiene T4: the lifecycle's live signal. A NEW variant, TRANSIENT, and
  // SESSION-scoped — the `harness_attached` shape (bare Base), never ThreadBase: activity is a fact
  // about the whole session, so a threadId would imply a per-thread state that does not exist.
  test("session_activity round-trips for all four states", () => {
    for (const activity of ["active", "background", "idle", "archived"] as const) {
      const e = { ...base, type: "session_activity", activity } as const;
      expect(SessionEvent.parse(e)).toEqual(e);
    }
  });

  test("session_activity rejects a state outside the four, and carries no threadId", () => {
    expect(SessionEvent.safeParse({ ...base, type: "session_activity", activity: "none" }).success).toBe(false);
    expect(SessionEvent.safeParse({ ...base, type: "session_activity" }).success).toBe(false);
    // The wire shape has no threadId at all: zod strips unknown keys, so one supplied by a
    // confused producer is DROPPED rather than round-tripped — which is the assertion that would
    // fail the day someone "helpfully" re-bases this variant on ThreadBase.
    const stripped = SessionEvent.parse({ ...base, type: "session_activity", activity: "idle", threadId: "main" });
    expect((stripped as { threadId?: string }).threadId).toBeUndefined();
  });

  // approval_requested.reviewerReason is additive/optional (5e T1) — an older-shaped event with no
  // reviewerReason still parses (the "agent event variants parse" test above already covers the
  // bare shape), and a reviewer-escalated one carrying it round-trips losslessly.
  test("approval_requested.reviewerReason is additive-optional: present round-trips, absent stays undefined", () => {
    const t = { ...base, threadId: "main" };
    const withReason = {
      ...t, type: "approval_requested", callId: "c3", toolName: "bash", summary: "run rm -rf /tmp/scratch",
      issuedAt: 1781270000000, expiresAt: 1781270300000,
      reviewerReason: "recursive delete outside the session cwd",
    } as const;
    expect(SessionEvent.parse(withReason)).toEqual(withReason);
    const withoutReason = SessionEvent.parse({ ...t, type: "approval_requested", callId: "c3", toolName: "bash", summary: "run rm -rf /tmp/scratch", issuedAt: 1781270000000, expiresAt: 1781270300000 });
    expect(withoutReason.type).toBe("approval_requested");
    expect((withoutReason as { reviewerReason?: string }).reviewerReason).toBeUndefined();
  });

  // SP3 T4b review fix (Phase-A CRITICAL — backward-compat regression proof): issuedAt/expiresAt
  // are OPTIONAL on approval_requested because existing session JSONL logs contain PRE-T4b events
  // without them, and SessionStore recovery re-parses every persisted line through this schema — a
  // required field would make those lines unparseable and silently DROP pre-T4b approval history
  // (irreversible loss + seq gaps) on the next daemon recovery. This test is the tripwire: the OLD
  // persisted shape must keep parsing forever. (The daemon still ALWAYS emits both on new events.)
  test("approval_requested WITHOUT issuedAt/expiresAt (pre-T4b persisted shape) still parses — recovery must never drop old lines", () => {
    const t = { ...base, threadId: "main" };
    const oldShape = { ...t, type: "approval_requested", callId: "c9", toolName: "write", summary: "write a.txt" } as const;
    const parsed = SessionEvent.parse(oldShape); // must not throw
    expect(parsed.type).toBe("approval_requested");
    expect((parsed as { issuedAt?: number }).issuedAt).toBeUndefined();
    expect((parsed as { expiresAt?: number }).expiresAt).toBeUndefined();
    // And the NEW shape (every fresh daemon emit) round-trips both fields losslessly.
    const newShape = { ...oldShape, issuedAt: 1781270000000, expiresAt: 1781270300000 };
    expect(SessionEvent.parse(newShape)).toEqual(newShape);
  });
});

describe("hello method schemas", () => {
  test("valid hello", () => {
    const p = { protocolVersion: PROTOCOL_VERSION, role: "harness", token: "t", clientName: "test" } as const;
    expect(HelloParams.parse(p).role).toBe("harness");
    expect(HelloResult.parse({ ok: true, serverVersion: "0.0.1", protocolVersion: PROTOCOL_VERSION }).ok).toBe(true);
  });

  test("unknown role rejected", () => {
    expect(() => HelloParams.parse({ protocolVersion: 0, role: "root", token: "t", clientName: "x" })).toThrow();
  });

  // Phase 4b Task 1: role "plugin" is id-bound — hello carries an optional pluginId so a plugin
  // authenticates AS a specific installed plugin. This is shape-only (verification is Task 2);
  // pluginId is absent for the other two roles and must stay optional so their hellos still parse.
  test("role \"plugin\" accepted with an optional pluginId", () => {
    const withId = HelloParams.parse({ protocolVersion: PROTOCOL_VERSION, role: "plugin", token: "t", clientName: "sample-echo", pluginId: "sample-echo" });
    expect(withId.role).toBe("plugin");
    expect(withId.pluginId).toBe("sample-echo");

    const withoutId = HelloParams.parse({ protocolVersion: PROTOCOL_VERSION, role: "plugin", token: "t", clientName: "sample-echo" });
    expect(withoutId.pluginId).toBeUndefined();
  });

  test("pluginId rejects an empty string when present", () => {
    expect(() => HelloParams.parse({ protocolVersion: PROTOCOL_VERSION, role: "plugin", token: "t", clientName: "x", pluginId: "" })).toThrow();
  });

  test("pluginId is accepted (and ignored) on non-plugin roles too — the field isn't role-gated at the wire layer", () => {
    const p = HelloParams.parse({ protocolVersion: PROTOCOL_VERSION, role: "harness", token: "t", clientName: "x", pluginId: "sample-echo" });
    expect(p.role).toBe("harness");
    expect(p.pluginId).toBe("sample-echo");
  });
});

// ================================================================================================
// B2 Task 2 — the command wire. `panel_command` grew from one verb to nine and gained a per-verb
// `args` bag; `panel.commandResult` is the answer channel. These pin the two things a schema change
// here can silently break: the verb set itself, and the two caps that keep a frame deliverable.
//
// office-agent-tools T1 repartitioned `PANEL_COMMAND_ACTIONS` into `BROWSER_COMMAND_ACTIONS` (the
// original nine, unchanged) plus `OFFICE_COMMAND_ACTIONS` (22 new office verbs) — this describe
// block's own name still says "B2 T2" because everything else in it (args, the two caps) is still
// exactly B2's mechanism; only the verb COUNT below needed updating for the wire to have grown.
// ================================================================================================
describe("panel_command (B2 T2)", () => {
  const base = { seq: 7, sessionId: "s_abc", ts: 1781270000000 };
  const cmd = (over: Record<string, unknown>) => ({
    ...base, type: "panel_command", commandId: "cmd_1", deadlineMs: 15000, ...over,
  });

  test("every verb of both families parses, and the union is exactly their sum", () => {
    for (const action of PANEL_COMMAND_ACTIONS) {
      expect(SessionEvent.parse(cmd({ action })).type).toBe("panel_command");
    }
    // Not a hand-typed number: computed from the two family constants this test also imports, so a
    // verb added to either family without being composed into the union fails here rather than
    // silently changing what "every verb parses" means. 9 browser + 22 office today.
    expect(PANEL_COMMAND_ACTIONS).toHaveLength(BROWSER_COMMAND_ACTIONS.length + OFFICE_COMMAND_ACTIONS.length);
    expect(BROWSER_COMMAND_ACTIONS).toHaveLength(9);
    expect(OFFICE_COMMAND_ACTIONS).toHaveLength(22);
  });

  test("an unknown verb is refused", () => {
    expect(() => SessionEvent.parse(cmd({ action: "eval" }))).toThrow();
  });

  test("args round-trips as an opaque per-verb bag", () => {
    const e = cmd({ action: "type", tabId: "tab_1", args: { selector: "#q", text: "norma", submit: true } });
    expect(SessionEvent.parse(e)).toEqual(e);
  });

  test("args is optional — a verb that needs no payload omits it", () => {
    const e = cmd({ action: "back", tabId: "tab_1" });
    expect((SessionEvent.parse(e) as { args?: unknown }).args).toBeUndefined();
  });

  // The cap is REFUSAL, never truncation: a silently shortened selector or typed string is a
  // different, wrong action performed against the user's logged-in browser.
  test("args at the cap passes, one byte over is REFUSED", () => {
    const fill = (bytes: number) => cmd({ action: "type", args: { text: "x".repeat(bytes) } });
    // Measure the real serialized size and pad to land exactly on the cap.
    const overhead = Buffer.byteLength(JSON.stringify({ text: "" }), "utf8");
    const atCap = fill(PANEL_COMMAND_ARGS_MAX_JSON_BYTES - overhead);
    expect(Buffer.byteLength(JSON.stringify(atCap.args), "utf8")).toBe(PANEL_COMMAND_ARGS_MAX_JSON_BYTES);
    expect(SessionEvent.parse(atCap)).toEqual(atCap);
    expect(() => SessionEvent.parse(fill(PANEL_COMMAND_ARGS_MAX_JSON_BYTES - overhead + 1))).toThrow();
  });

  // The cap counts BYTES, not UTF-16 units — the thing being bounded is a socket frame.
  test("the args cap counts bytes, so multi-byte characters count for more than one", () => {
    const overhead = Buffer.byteLength(JSON.stringify({ text: "" }), "utf8");
    // Each "é" is 2 UTF-8 bytes: half as many characters fit as ASCII would.
    const chars = (PANEL_COMMAND_ARGS_MAX_JSON_BYTES - overhead) / 2;
    expect(SessionEvent.parse(cmd({ action: "type", args: { text: "é".repeat(chars) } })).type).toBe("panel_command");
    expect(() => SessionEvent.parse(cmd({ action: "type", args: { text: "é".repeat(chars + 1) } }))).toThrow();
  });
});

describe("panel.commandResult (B2 T2)", () => {
  const ok = { sessionId: "s_abc", commandId: "cmd_1", ok: true };

  test("minimal success and failure shapes parse", () => {
    expect(PanelCommandResultParams.parse(ok)).toEqual(ok);
    const fail = { ...ok, ok: false, result: "no element matched #q" };
    expect(PanelCommandResultParams.parse(fail)).toEqual(fail);
  });

  test("result at the cap passes, one over is refused", () => {
    expect(PanelCommandResultParams.parse({ ...ok, result: "r".repeat(PANEL_COMMAND_RESULT_MAX_LENGTH) }).result)
      .toHaveLength(PANEL_COMMAND_RESULT_MAX_LENGTH);
    expect(() => PanelCommandResultParams.parse({ ...ok, result: "r".repeat(PANEL_COMMAND_RESULT_MAX_LENGTH + 1) })).toThrow();
  });

  test("imageBase64 at the cap passes, one over is refused", () => {
    expect(PanelCommandResultParams.parse({ ...ok, imageBase64: "A".repeat(PANEL_COMMAND_IMAGE_B64_MAX_LENGTH) }).imageBase64)
      .toHaveLength(PANEL_COMMAND_IMAGE_B64_MAX_LENGTH);
    expect(() => PanelCommandResultParams.parse({ ...ok, imageBase64: "A".repeat(PANEL_COMMAND_IMAGE_B64_MAX_LENGTH + 1) })).toThrow();
  });

  test("the image cap leaves real margin under the daemon's 8 MiB NDJSON line cap", () => {
    expect(PANEL_COMMAND_IMAGE_B64_MAX_LENGTH).toBeLessThan(8 * 1024 * 1024 / 2);
  });
});
