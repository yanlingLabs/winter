import { describe, expect, test } from "bun:test";
import { isContextLengthError, parseProviderErrorCode } from "../../src/providers/errors";

/** THE REAL SHAPE (recorded 2026-08-02, followups T1).
 *
 *  A context overflow on the Responses endpoint (both the plain OpenAI-compatible provider and the
 *  Codex OAuth one — they share `mapHttpError`) comes back as an HTTP **400** whose JSON body
 *  carries OpenAI's canonical structured code `context_length_exceeded`. Two body forms are live:
 *
 *  (A) the Responses-API form —
 *      {"error":{"message":"Your input exceeds the context window of this model. Please adjust
 *       your input and try again.","type":"invalid_request_error","param":"input",
 *       "code":"context_length_exceeded"}}                                        // 196 chars
 *
 *  (B) the chat-completions-lineage form —
 *      {"error":{"message":"This model's maximum context length is 272000 tokens. However, your
 *       messages resulted in 289431 tokens. Please reduce the length of the messages.",
 *       "type":"invalid_request_error","param":"messages","code":"context_length_exceeded"}}
 *                                                                                  // 252 chars
 *
 *  `mapHttpError` flattens both to `{code:"bad_request", message:"HTTP 400 — <body sliced to 200
 *  chars>"}`. **Form (B) is 252 chars, so the structured `code` is TRUNCATED AWAY** — the very
 *  field a recognizer wants is the one the cap eats, because it trails the (unbounded) human
 *  message. That is why the code is parsed off the FULL body before the slice and surfaced as
 *  `providerCode`, rather than being substring-matched out of the prose afterwards.
 */
const BODY_RESPONSES_FORM = JSON.stringify({
  error: {
    message: "Your input exceeds the context window of this model. Please adjust your input and try again.",
    type: "invalid_request_error", param: "input", code: "context_length_exceeded",
  },
});
const BODY_CHAT_FORM = JSON.stringify({
  error: {
    message: "This model's maximum context length is 272000 tokens. However, your messages resulted in 289431 tokens. Please reduce the length of the messages.",
    type: "invalid_request_error", param: "messages", code: "context_length_exceeded",
  },
});

describe("parseProviderErrorCode", () => {
  test("lifts the structured error.code out of both live body forms", () => {
    expect(parseProviderErrorCode(BODY_RESPONSES_FORM)).toBe("context_length_exceeded");
    expect(parseProviderErrorCode(BODY_CHAT_FORM)).toBe("context_length_exceeded");
  });

  test("non-JSON / codeless / non-string-code bodies yield undefined rather than throwing", () => {
    expect(parseProviderErrorCode("Bad Gateway")).toBeUndefined();
    expect(parseProviderErrorCode("")).toBeUndefined();
    expect(parseProviderErrorCode(JSON.stringify({ error: { message: "nope" } }))).toBeUndefined();
    expect(parseProviderErrorCode(JSON.stringify({ error: { code: 400 } }))).toBeUndefined();
    expect(parseProviderErrorCode(JSON.stringify({ detail: "nope" }))).toBeUndefined();
  });
});

// P8d-13: `mapHttpError`'s own describe block was removed here when `providers/openai-compatible.ts`
// was deleted (its `CodexOAuthProvider`/`OpenAICompatibleProvider` callers — the only two —
// were both superseded by `providers/runtime-provider.ts` in Winter Phase 8c). The 200-char-cap
// structured-code regression it guarded (`parseProviderErrorCode` above still guards the parsing
// half) has no equivalent producer on the new adapter path today; recorded as a lane-2 concern
// rather than silently dropped.

describe("isContextLengthError — conservative recognition", () => {
  test("recognizes the structured code, even when the prose was truncated away", () => {
    expect(isContextLengthError({
      type: "error", code: "bad_request",
      message: "HTTP 400 — {\"error\":{\"message\":\"…\",\"type\":\"inv", // prose gone
      providerCode: "context_length_exceeded",
    })).toBe(true);
  });

  test("recognizes both live prose forms when no structured code survived", () => {
    expect(isContextLengthError({ type: "error", code: "bad_request", message: `HTTP 400 — ${BODY_CHAT_FORM.slice(0, 200)}` })).toBe(true);
    expect(isContextLengthError({ type: "error", code: "bad_request", message: `HTTP 400 — ${BODY_RESPONSES_FORM.slice(0, 200)}` })).toBe(true);
  });

  test("recognizes a context-length failure delivered mid-stream as response.failed (code \"server\")", () => {
    // responses-sse.ts maps `response.failed` to {code:"server", message: response.error.message} —
    // the same overflow can arrive that way, so recognition must not be gated on `bad_request`.
    expect(isContextLengthError({ type: "error", code: "server", message: "Your input exceeds the context window of this model." })).toBe(true);
  });

  /** THE I4 LESSON — this codebase's own vocabulary is hostile to raw `contains`. Recognition
   *  requires an overflow CLAIM (a code, or a phrase that says something exceeded a limit), never
   *  the bare presence of the words. `mapHttpError` embeds RAW BODY TEXT, and a 400 body routinely
   *  echoes the offending input back — i.e. the user's own prose lands in `message`. */
  test("does not fire on unrelated 400s, or on prose that merely mentions context/length", () => {
    const notContextLength = [
      "HTTP 400 — {\"error\":{\"message\":\"Unsupported value: 'reasoning.effort' does not support 'ultra'\",\"code\":\"unsupported_value\"}}",
      "HTTP 400 — {\"error\":{\"message\":\"Invalid 'input[3]': orphaned function_call_output\",\"code\":\"invalid_request_error\"}}",
      "HTTP 401 — token expired",
      // a body echoing the user's own words back:
      "HTTP 400 — {\"error\":{\"message\":\"Invalid value for 'input[0].content': explain how context length works\"}}",
      // substring traps: neither is a word-boundary match
      "HTTP 400 — unknown field 'subcontext_length_exceeded_flag'",
      "HTTP 400 — parameter 'contextlength' is not supported",
    ];
    for (const message of notContextLength) {
      expect(isContextLengthError({ type: "error", code: "bad_request", message })).toBe(false);
    }
  });

  test("a non-context-length structured code never fires, whatever the prose says", () => {
    expect(isContextLengthError({
      type: "error", code: "bad_request",
      message: "HTTP 400 — could not parse 'maximum context length' out of your instructions",
      providerCode: "invalid_prompt",
    })).toBe(false);
  });
});
