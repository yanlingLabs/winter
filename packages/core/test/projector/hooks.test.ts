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

  test("every kind this daemon deliberately does not persist is in the allowlist", () => {
    for (const [kind] of unpersisted) expect({ kind, known: isKnownUnpersistedKind(kind) }).toEqual({ kind, known: true });
  });

  test("the TASK frames the projector handles on purpose are known kinds, not `unrecognised` (n8)", () => {
    // `task_started` is CONSUMED (it maps a task id onto a background child thread) and
    // `task_progress` is a deliberate skip. Missing from the allowlist, their once-per-kind line
    // read "unrecognised wire message" — the daemon log claiming the projector had never heard of
    // frames it handles deliberately, which is the one signal that line exists to give.
    for (const kind of ["system/task_started", "system/task_progress", "system/task_updated", "system/task_notification"]) {
      expect({ kind, known: isKnownUnpersistedKind(kind) }).toEqual({ kind, known: true });
    }
    // +1: `system/api_retry` stays a KNOWN kind for the log allowlist even though it now projects a transient.
    expect(UNPERSISTED_KINDS.length).toBe(unpersisted.length + 4 + 1);
  });

  test("the coverage map gains NOTHING from these families — no variant was invented for them (P8b-21)", () => {
    // There is no `hook_*` SessionEvent and 8b adds none; inventing one would re-enter the full
    // seven-step protocol checklist, Swift side included.
    const produced = Object.entries(PROJECTED_EVENT_COVERAGE).filter(([, v]) => v === true).map(([k]) => k).sort();
    expect(produced).toEqual([
      "agent_error", "assistant_delta", "assistant_message", "provider_retry", "task_updated", "thread_completed",
      "thread_started", "tool_call", "tool_result", "turn_completed", "turn_started", "user_message",
    ]);
  });
});

describe("projector: system/api_retry → provider_retry (TRANSIENT progress, 2026-09-17)", () => {
  test("one retry frame projects exactly one broadcast-only provider_retry carrying the SDK's own fields", () => {
    const { projector } = makeProjector();
    accept(projector, init());
    const batch = projector.accept(msg({ type: "system", subtype: "api_retry", attempt: 3, max_retries: 10, retry_delay_ms: 8000, error_status: 429, error: "rate_limit" }));
    expect(batch.persist).toEqual([]);
    expect(batch.broadcast.map((e) => e.type)).toEqual(["provider_retry"]);
    const e = batch.broadcast[0] as { attempt: number; maxRetries: number; retryDelayMs: number; status: number | null; message: string; threadId: string };
    expect({ attempt: e.attempt, maxRetries: e.maxRetries, retryDelayMs: e.retryDelayMs, status: e.status, message: e.message, threadId: e.threadId })
      .toEqual({ attempt: 3, maxRetries: 10, retryDelayMs: 8000, status: 429, message: "rate_limit", threadId: "main" });
  });
  test("a retry never carries a body: a non-string `error` becomes an empty message, a null status stays null", () => {
    const { projector } = makeProjector();
    accept(projector, init());
    const batch = projector.accept(msg({ type: "system", subtype: "api_retry", attempt: 1, max_retries: 10, retry_delay_ms: 500, error_status: null, error: { secret: "SECRET_BODY" } }));
    const e = batch.broadcast[0] as { status: number | null; message: string };
    expect(e.status).toBeNull();
    expect(e.message).toBe("");
    expect(JSON.stringify(batch)).not.toContain("SECRET_BODY");
  });
  test("retries around a turn leave the turn's persisted sequence untouched", () => {
    const { projector } = makeProjector();
    const out = [
      ...accept(projector, init()),
      ...accept(projector, msg({ type: "system", subtype: "api_retry", attempt: 1, max_retries: 10, retry_delay_ms: 500, error_status: 429, error: "rate_limit" })).filter((e) => e.type !== "provider_retry"),
      ...accept(projector, assistantText("the answer")),
    ];
    expect(out.map((e) => e.type)).toEqual(["assistant_message"]);
  });
});
