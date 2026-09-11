import { describe, expect, test } from "bun:test";
import { PROJECTED_EVENT_COVERAGE, UNPERSISTED_KINDS, isKnownUnpersistedKind, kindOf, summarize } from "../../src/projector";
import type { ProtocolSdkMessage } from "../../src/projector";
import { accept, assistantText, init, makeProjector } from "./harness";

const msg = (o: Record<string, unknown>) => o as unknown as ProtocolSdkMessage;

/**
 * P8b-8 / P8b-21: hook rows, `rate_limit_event`, `auth_status`, status/compaction rows and every
 * Winter-only extension message are OBSERVED and never persisted. 8b adds no variant for them, so
 * "logged at debug, codes only" is the whole contract — and the logging half is a SECURITY rule,
 * not a tidiness one.
 */
describe("projector/hooks: observed, never persisted", () => {
  const unpersisted: Array<[string, Record<string, unknown>]> = [
    ["hook_started", { type: "hook_started", hook_id: "h1", hook_name: "PreToolUse", hook_event: "PreToolUse", session_id: "s", uuid: "u" }],
    ["hook_progress", { type: "hook_progress", hook_id: "h1", hook_name: "PreToolUse", hook_event: "PreToolUse", session_id: "s", uuid: "u" }],
    ["hook_response", { type: "hook_response", hook_id: "h1", hook_name: "PreToolUse", hook_event: "PreToolUse", outcome: "success", exit_code: 0, output: "SECRET_HOOK_STDOUT", stdout: "SECRET_HOOK_STDOUT", stderr: "", session_id: "s", uuid: "u" }],
    ["rate_limit_event", { type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", resetsAt: 1 } }],
    ["auth_status", { type: "auth_status", isAuthenticating: true, output: ["SECRET_LOGIN_URL"] }],
    ["system/api_retry", { type: "system", subtype: "api_retry", attempt: 2, max_retries: 10, retry_delay_ms: 500, error_status: 429, error: "rate_limit" }],
    ["system/status", { type: "system", subtype: "status", status: "compacting", compact_result: "success" }],
    ["system/compact_boundary", { type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "auto", pre_tokens: 100000, preserved_messages: 4 } }],
    ["system/thinking_tokens", { type: "system", subtype: "thinking_tokens", estimated_tokens: 120, estimated_tokens_delta: 20 }],
    ["system/model_refusal_fallback", { type: "system", subtype: "model_refusal_fallback", trigger: "refusal", direction: "down", original_model: "a", fallback_model: "b", request_id: "r", api_refusal_explanation: "SECRET_REFUSAL_PROSE", content: "SECRET_REFUSAL_PROSE" }],
    ["system/model_refusal_no_fallback", { type: "system", subtype: "model_refusal_no_fallback", trigger: "refusal", original_model: "a", request_id: "r", api_refusal_explanation: "SECRET_REFUSAL_PROSE" }],
    ["system/reasoning_summary", { type: "system", subtype: "reasoning_summary", text: "SECRET_REASONING_TEXT", provider: "p", model: "m" }],
    ["system/model_switch", { type: "system", subtype: "model_switch", reason: "fallback", from_model: "a", to_model: "b", provider: "p" }],
    ["system/continuity_warning", { type: "system", subtype: "continuity_warning", warning: "provider_state_missing", detail: "SECRET_CONTINUITY_DETAIL", anchor_uuid: "u" }],
    ["system/permission_denied", { type: "system", subtype: "permission_denied", tool_name: "Write", tool_use_id: "t1", decision_reason_type: "mode", message: "denied", session_id: "s", uuid: "u" }],
    ["system/local_command_output", { type: "system", subtype: "local_command_output", content: "SECRET_COMMAND_OUTPUT", uuid: "u", session_id: "s" }],
    ["system/background_tasks_changed", { type: "system", subtype: "background_tasks_changed", tasks: [], uuid: "u", session_id: "s" }],
  ];

  for (const [kind, frame] of unpersisted) {
    test(`${kind}: accept returns [] — nothing persisted, nothing broadcast`, () => {
      const { projector } = makeProjector();
      accept(projector, init());
      expect(accept(projector, msg(frame))).toEqual([]);
    });
  }

  test("a whole stream of unpersisted frames around a turn changes the turn's own sequence not at all", () => {
    const { projector } = makeProjector();
    const out = [
      ...accept(projector, init()),
      ...unpersisted.flatMap(([, f]) => accept(projector, msg(f))),
      ...accept(projector, assistantText("the answer")),
    ];
    expect(out.map((e) => e.type)).toEqual(["assistant_message"]);
  });

  test("the log payload is a KIND and allowlisted SCALARS — never the message body", () => {
    // `system/reasoning_summary` carries a foreign model's reasoning text; `model_refusal_*`
    // carries an explanation §4.7 marks display-only and never to be parsed; a hook response
    // carries the hook's stdout. None of it is cleared for a log line, and a well-meaning
    // JSON.stringify(msg) in a debug branch is exactly how it would get there.
    for (const [, frame] of unpersisted) {
      const payload = JSON.stringify(summarize(msg(frame)));
      expect(payload).not.toContain("SECRET_");
    }
  });

  test("the allowlist is per-family: a field not listed for a kind is never logged, even if present", () => {
    const payload = summarize(msg({ type: "system", subtype: "continuity_warning", warning: "sidecar_unreadable", detail: "SECRET_CONTINUITY_DETAIL" }));
    expect(payload).toEqual({ kind: "system/continuity_warning", warning: "sidecar_unreadable" });
  });

  test("an UNKNOWN kind logs its kind ALONE — a future frame family is the likeliest unvetted payload", () => {
    expect(summarize(msg({ type: "some_future_frame", secret: "SECRET_PAYLOAD", n: 1 }))).toEqual({ kind: "some_future_frame" });
    expect(isKnownUnpersistedKind("some_future_frame")).toBe(false);
  });

  test("kindOf renders `type` or `type/subtype`", () => {
    expect(kindOf(msg({ type: "rate_limit_event" }))).toBe("rate_limit_event");
    expect(kindOf(msg({ type: "system", subtype: "status" }))).toBe("system/status");
    expect(kindOf(msg({ nope: 1 }))).toBe("<untyped>");
  });

  test("every kind this daemon deliberately does not persist is in the allowlist, and vice versa", () => {
    for (const [kind] of unpersisted) expect({ kind, known: isKnownUnpersistedKind(kind) }).toEqual({ kind, known: true });
    expect(UNPERSISTED_KINDS.length).toBe(unpersisted.length);
  });

  test("the coverage map gains NOTHING from these families — no variant was invented for them (P8b-21)", () => {
    // There is no `hook_*` SessionEvent and 8b adds none; inventing one would re-enter the full
    // seven-step protocol checklist, Swift side included.
    const produced = Object.entries(PROJECTED_EVENT_COVERAGE).filter(([, v]) => v === true).map(([k]) => k).sort();
    expect(produced).toEqual([
      "agent_error", "assistant_delta", "assistant_message", "task_updated", "thread_completed",
      "thread_started", "tool_call", "tool_result", "turn_completed", "user_message",
    ]);
  });
});
