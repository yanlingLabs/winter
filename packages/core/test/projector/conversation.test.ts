import { describe, expect, test } from "bun:test";
import { TRANSIENT_EVENT_TYPES } from "@norma/protocol";
import { MAIN_THREAD } from "../../src/projector";
import {
  accept, assistantText, assistantToolUse, init, makeProjector, result, run, textDelta, toolResult, userTextFrame,
} from "./harness";

describe("projector: conversation fold (Winter 8b Task 10)", () => {
  test("system/init persists nothing and starts no turn", () => {
    const { projector } = makeProjector();
    expect(accept(projector, init())).toEqual([]);
    expect(projector.turnRunning).toBe(false);
  });

  test("a final assistant text block becomes one assistant_message on the main thread", () => {
    const { projector } = makeProjector();
    accept(projector, init());
    const out = accept(projector, assistantText("Hello, world."));
    expect(out.map((e) => e.type)).toEqual(["assistant_message"]);
    expect(out[0]).toMatchObject({ type: "assistant_message", sessionId: "s_test", threadId: MAIN_THREAD, text: "Hello, world." });
    expect(projector.turnRunning).toBe(true);
  });

  test("multiple text blocks in one assistant message concatenate into ONE assistant_message", () => {
    const { projector } = makeProjector();
    const out = accept(projector, {
      type: "assistant", message: { content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] },
    } as never);
    expect(out.map((e) => e.type)).toEqual(["assistant_message"]);
    expect(out[0]).toMatchObject({ text: "ab" });
  });

  test("thinking and redacted_thinking blocks are NEVER read — no reasoning_item, no leaked text", () => {
    const { projector } = makeProjector();
    const out = accept(projector, {
      type: "assistant",
      message: {
        content: [
          { type: "thinking", thinking: "private chain of thought", signature: "" },
          { type: "redacted_thinking", data: "OPAQUE_PROVIDER_STATE" },
          { type: "text", text: "the answer" },
        ],
      },
    } as never);
    expect(out.map((e) => e.type)).toEqual(["assistant_message"]);
    expect(out[0]).toMatchObject({ text: "the answer" });
    expect(JSON.stringify(out)).not.toContain("OPAQUE_PROVIDER_STATE");
    expect(JSON.stringify(out)).not.toContain("private chain of thought");
  });

  test("a tool_use block becomes a tool_call carrying callId, the NORMA name, and argsJson", () => {
    const { projector } = makeProjector();
    const out = accept(projector, assistantToolUse("toolu_01", "Read", { file_path: "note.txt" }));
    expect(out.map((e) => e.type)).toEqual(["tool_call"]);
    // `Read` → `read` (ruling P8b-25): the SessionEvent surface keeps Norma's tool vocabulary.
    expect(out[0]).toMatchObject({ type: "tool_call", callId: "toolu_01", name: "read", threadId: MAIN_THREAD });
    expect(JSON.parse((out[0] as { argsJson: string }).argsJson)).toEqual({ file_path: "note.txt" });
  });

  test("tool NAMES are translated Winter → Norma, and an unknown name passes through unchanged", () => {
    const { projector } = makeProjector();
    const seen = (winter: string) => (accept(projector, assistantToolUse(`c-${winter}`, winter, {}))[0] as { name: string }).name;
    expect(seen("Read")).toBe("read");
    expect(seen("Write")).toBe("write");
    expect(seen("Edit")).toBe("edit");
    expect(seen("Bash")).toBe("bash");
    expect(seen("Agent")).toBe("spawn_agent");
    expect(seen("mcp__norma__browser__browser")).toBe("browser");
    expect(seen("mcp__norma__office__docs")).toBe("docs");
    // fail-OPEN: an unfamiliar label is cosmetic; dropping the call would break the callId linkage
    expect(seen("mcp__someone_else__thing")).toBe("mcp__someone_else__thing");
    expect(seen("BrandNewWinterTool")).toBe("BrandNewWinterTool");
  });

  test("the SHARED table is the one source — where it differed from the projector's private copy, it wins", () => {
    // The private `projector/tool-names.ts` is deleted; `renameTool` reads the policy lane's
    // `runtime-sdk/tool-names.ts`, the same table the approval bridge gates by, so the name on a
    // permission card and the name in the transcript cannot drift apart. Two of the private table's
    // rows differed, and neither appears in any fixture or golden:
    //   `Monitor`          private `bash_output` → shared has NO pair, so it falls through unchanged
    //                      (it IS in WINTER_TOOL_GATE_CLASS as `bash`, which is a gating decision,
    //                      not a display name).
    //   `AskUserQuestion`  private `AskQuestion` → shared `ask_user`.
    const { projector } = makeProjector();
    const seen = (winter: string) => (accept(projector, assistantToolUse(`c-${winter}`, winter, {}))[0] as { name: string }).name;
    expect(seen("Monitor")).toBe("Monitor");
    expect(seen("AskUserQuestion")).toBe("ask_user");
    // and the rows the two tables always agreed on are unchanged
    expect(seen("Read")).toBe("read");
    expect(seen("Agent")).toBe("spawn_agent");
    expect(seen("TaskOutput")).toBe("agent_output");
  });

  test("text AND tool_use in one assistant message: assistant_message first, then the tool_call", () => {
    const { projector } = makeProjector();
    const out = accept(projector, {
      type: "assistant",
      message: { content: [{ type: "text", text: "reading it" }, { type: "tool_use", id: "t1", name: "Read", input: {} }] },
    } as never);
    expect(out.map((e) => e.type)).toEqual(["assistant_message", "tool_call"]);
  });

  test("two tool_use blocks in one message become two tool_calls, in block order", () => {
    const { projector } = makeProjector();
    const out = accept(projector, {
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }, { type: "tool_use", id: "t2", name: "Glob", input: {} }] },
    } as never);
    expect(out.map((e) => (e as { callId?: string }).callId)).toEqual(["t1", "t2"]);
  });

  test("a user frame's tool_result block becomes a tool_result keyed by tool_use_id", () => {
    const { projector } = makeProjector();
    const out = accept(projector, toolResult("toolu_01", "hello from the golden fixture\n"));
    expect(out.map((e) => e.type)).toEqual(["tool_result"]);
    expect(out[0]).toMatchObject({ type: "tool_result", callId: "toolu_01", output: "hello from the golden fixture\n", isError: false });
  });

  test("a user frame WITH `role` folds identically to one without — the real child omits it", () => {
    const a = makeProjector();
    const b = makeProjector();
    const withRole = accept(a.projector, { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "x" }] } } as never);
    const without = accept(b.projector, toolResult("t1", "x"));
    expect(withRole.map((e) => e.type)).toEqual(["tool_result"]);
    expect(without.map((e) => e.type)).toEqual(["tool_result"]);
    expect((withRole[0] as { output: string }).output).toBe((without[0] as { output: string }).output);
  });

  test("`denied: true` on a tool_result block is an ERROR result — the spelling a real denial uses", () => {
    const { projector } = makeProjector();
    const out = accept(projector, toolResult("toolu_02", "Denied: …", { denied: true }));
    expect(out[0]).toMatchObject({ type: "tool_result", isError: true });
  });

  test("`is_error: true` and `interrupted: true` are error results too", () => {
    const a = makeProjector();
    const b = makeProjector();
    expect(accept(a.projector, toolResult("t1", "boom", { is_error: true }))[0]).toMatchObject({ isError: true });
    expect(accept(b.projector, toolResult("t2", "[interrupted]", { interrupted: true }))[0]).toMatchObject({ isError: true });
  });

  test("a tool_result whose content is a block array flattens to its text, naming non-text blocks", () => {
    const { projector } = makeProjector();
    const out = accept(projector, toolResult("t1", [{ type: "text", text: "line" }, { type: "image", source: { data: "BASE64" } }]));
    expect(out[0]).toMatchObject({ output: "line[image]" });
    expect(JSON.stringify(out)).not.toContain("BASE64");
  });

  test("two tool_result blocks on one user frame become two tool_result events", () => {
    const { projector } = makeProjector();
    const out = accept(projector, {
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "a" }, { type: "tool_result", tool_use_id: "t2", content: "b" }] },
    } as never);
    expect(out.map((e) => (e as { callId?: string }).callId)).toEqual(["t1", "t2"]);
  });

  test("a stream_event text delta becomes a TRANSIENT assistant_delta that consumes no seq", () => {
    const { projector } = makeProjector();
    const first = accept(projector, assistantText("x"));       // consumes seq 1
    const delta = accept(projector, textDelta("chunk"));
    expect(delta.map((e) => e.type)).toEqual(["assistant_delta"]);
    expect(TRANSIENT_EVENT_TYPES.has(delta[0]!.type)).toBe(true);
    // the transient reuses the persisted event's seq rather than taking the next one
    expect(delta[0]!.seq).toBe(first[0]!.seq);
  });

  test("thinking / signature / input_json deltas are NOT projected", () => {
    const { projector } = makeProjector();
    for (const delta of [{ type: "thinking_delta", thinking: "…" }, { type: "signature_delta", signature: "SIG" }, { type: "input_json_delta", partial_json: "{\"a\"" }]) {
      const out = accept(projector, { type: "stream_event", event: { type: "content_block_delta", index: 0, delta }, parent_tool_use_id: null, uuid: "u", session_id: "be-1" } as never);
      expect(out).toEqual([]);
    }
  });

  test("non-delta stream events (message_start/stop, content_block_start/stop) project nothing", () => {
    const { projector } = makeProjector();
    for (const ev of [{ type: "message_start" }, { type: "content_block_start", index: 0 }, { type: "content_block_stop", index: 0 }, { type: "message_delta" }, { type: "message_stop" }]) {
      expect(accept(projector, { type: "stream_event", event: ev, parent_tool_use_id: null, uuid: "u", session_id: "be-1" } as never)).toEqual([]);
    }
  });

  test("parent_tool_use_id puts a frame on the CHILD thread; absent/null means main", () => {
    const { projector } = makeProjector();
    const child = accept(projector, assistantToolUse("toolu_child", "Read", {}, "toolu_parent"));
    expect(child[0]).toMatchObject({ threadId: "toolu_parent" });
    const main = accept(projector, assistantText("back on main"));
    expect(main[0]).toMatchObject({ threadId: MAIN_THREAD });
    const childDelta = accept(projector, textDelta("c", "toolu_parent"));
    expect(childDelta[0]).toMatchObject({ threadId: "toolu_parent" });
  });

  test("a text-only user frame becomes a user_message (an inbound delivery, not an echo)", () => {
    const { projector } = makeProjector();
    const out = accept(projector, userTextFrame("<agent-message from=\"other\">ping</agent-message>"));
    expect(out.map((e) => e.type)).toEqual(["user_message"]);
    expect(out[0]).toMatchObject({ threadId: MAIN_THREAD, clientName: "winter" });
  });

  test("an empty / whitespace-only frame projects nothing at all", () => {
    const { projector } = makeProjector();
    expect(accept(projector, assistantText(""))).toEqual([]);
    expect(accept(projector, userTextFrame("   "))).toEqual([]);
  });

  test("a tool_use block missing its id or name is skipped rather than projected half-formed", () => {
    const { projector } = makeProjector();
    const out = accept(projector, {
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Read", input: {} }, { type: "tool_use", id: "t2", input: {} }, { type: "tool_use", id: "t3", name: "Glob", input: {} }] },
    } as never);
    expect(out.map((e) => (e as { callId?: string }).callId)).toEqual(["t3"]);
  });

  test("unknown wire types (rate_limit_event, auth_status, hook rows, Winter extensions) persist nothing", () => {
    const { projector } = makeProjector();
    const unknowns = [
      { type: "rate_limit_event", rate_limit_info: { status: "allowed" } },
      { type: "auth_status", isAuthenticating: true, output: ["step"] },
      { type: "system", subtype: "api_retry", attempt: 1, max_retries: 10, error_status: 429, error: "rate_limit" },
      { type: "system", subtype: "continuity_warning", warning: "provider_state_missing", detail: "2 anchors" },
      { type: "system", subtype: "reasoning_summary", text: "SUMMARY", provider: "p", model: "m" },
      { type: "hook_started", hook_id: "h", hook_name: "n", hook_event: "e", session_id: "s", uuid: "u" },
      { type: "task_started", task_id: "t", description: "d", uuid: "u", session_id: "s" },
      { type: "something_from_the_future", payload: 1 },
    ];
    for (const m of unknowns) expect(accept(projector, m as never)).toEqual([]);
  });

  test("m5: no single accept ever fills BOTH halves of the batch — which is what makes flattening order-safe", () => {
    // The persist/broadcast split exists so a caller cannot append an `assistant_delta` by accident.
    // A call that returned both would also make "concatenate them for one ordered stream" a
    // reordering bug, so the invariant is asserted rather than assumed.
    const { projector } = makeProjector();
    const messages = [
      init(), textDelta("a"), assistantText("a"), assistantToolUse("t1", "Read", {}),
      toolResult("t1", "x"), userTextFrame("hello"), result(),
    ];
    projector.beginTurn({ text: "go" });
    for (const m of messages) {
      const batch = projector.accept(m);
      expect(batch.persist.length === 0 || batch.broadcast.length === 0).toBe(true);
      for (const e of batch.broadcast) expect(TRANSIENT_EVENT_TYPES.has(e.type)).toBe(true);
      for (const e of batch.persist) expect(TRANSIENT_EVENT_TYPES.has(e.type)).toBe(false);
    }
  });

  test("a full text-only turn: init, deltas, final message, result", () => {
    const { projector } = makeProjector();
    const out = run(projector, [init(), textDelta("Hello"), textDelta(", world."), assistantText("Hello, world."), result()], { pushAt: [0] });
    // `turn_started` leads because `run` now KEEPS what `beginTurn` returns (M1, review r2) — the
    // host appends that event rather than making its own.
    expect(out.map((e) => e.type)).toEqual(["turn_started", "assistant_delta", "assistant_delta", "assistant_message", "turn_completed"]);
    expect(projector.turnRunning).toBe(false);
    expect(projector.lastResultAt).toBe("2026-09-11T00:00:00.000Z");
  });
});
