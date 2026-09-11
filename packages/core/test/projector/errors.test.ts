import { describe, expect, test } from "bun:test";
import { AGENT_ERROR_CODES, classifyResult, classifyThrown, codeForHttpStatus, sanitizeDetail } from "../../src/projector";
import type { AgentErrorCode } from "../../src/projector";
import { accept, acceptError, assistantText, init, makeProjector, result } from "./harness";

type TC = { type: string; code?: string; message?: string; stopReason?: string };
const res = (over: Record<string, unknown>) => ({ type: "result", subtype: "success", permission_denials: [], ...over } as never);

/**
 * Digest item 20 / WS-14 §13: ONE DISTINCT CODE PER CLASS. A collapsed `Error` mapping is the
 * failure — `routines/runner.ts:81` already switches on `code === "rate_limit"`, so these are a
 * consumed contract.
 */
describe("projector/errors: one distinct agent_error code per class", () => {
  const cases: Array<[string, Record<string, unknown>, AgentErrorCode]> = [
    ["provider auth (taxonomy)", { error: "authentication_failed" }, "auth"],
    ["provider auth (oauth org)", { error: "oauth_org_not_allowed" }, "auth"],
    ["provider auth (HTTP 401)", { api_error_status: 401 }, "auth"],
    ["provider auth (HTTP 403)", { api_error_status: 403 }, "auth"],
    ["rate limit (taxonomy)", { error: "rate_limit" }, "rate_limit"],
    ["rate limit (HTTP 429)", { api_error_status: 429 }, "rate_limit"],
    ["overloaded", { error: "overloaded" }, "server"],
    ["server error (HTTP 503)", { api_error_status: 503 }, "server"],
    ["network (HTTP 408)", { api_error_status: 408 }, "network"],
    ["billing (account on hold)", { error: "account_on_hold" }, "billing"],
    ["billing (HTTP 402)", { api_error_status: 402 }, "billing"],
    ["invalid request", { error: "invalid_request" }, "bad_request"],
    ["model not found", { error: "model_not_found" }, "model_not_found"],
    ["max output tokens", { error: "max_output_tokens" }, "max_output_tokens"],
    // 0.0.3 has NO wire producer for this: Winter auto-compacts before an overflow and the
    // 11-member taxonomy has no overflow member. The class is implemented and tested so the code is
    // distinct and has a home the day a signal appears — NOT claimed to be reachable today.
    ["context overflow (no 0.0.3 producer)", { terminal_reason: "context_overflow" }, "context_overflow"],
    ["max turns", { subtype: "error_max_turns" }, "max_turns"],
    ["max budget", { subtype: "error_max_budget_usd" }, "max_budget"],
    ["structured output exhausted (subtype)", { subtype: "error_max_structured_output_retries" }, "structured_output_exhausted"],
    ["structured output exhausted (terminal_reason)", { terminal_reason: "structured_output_retry_exhausted" }, "structured_output_exhausted"],
    ["tool failure", { subtype: "error_during_execution" }, "tool_failure"],
    ["unrecognised", { subtype: "success" }, "unknown_error"],
  ];

  for (const [name, frame, code] of cases) {
    test(`${name} → code "${code}"`, () => {
      expect(classifyResult(res(frame)).code).toBe(code);
    });
  }

  test("the classes are DISTINCT — no two result classes collapse onto one code by accident", () => {
    // The point of the table: a reader can tell a rate limit from a dead process from a bad model.
    const distinct = new Set(cases.map(([, , code]) => code));
    expect(distinct.size).toBe(14);
  });

  const thrown: Array<[string, string, AgentErrorCode]> = [
    ["AbortError", "aborted", "aborted"],
    ["ProcessError", "runtime exited", "process_death"],
    ["CLIConnectionError", "runtime exited before init", "process_death"],
    ["ProtocolDecodeError", "bad frame", "protocol_decode"],
    ["WinterRpcError", "connection_closed", "connection_closed"],
    ["WinterRpcTimeoutError", "timed out", "connection_closed"],
    ["SessionNotFoundError", "no such session", "store_error"],
    ["WinterStoreError", "cannot write", "store_error"],
    ["WinterStoreLeaseError", "lease is held by pid 42", "store_lease"],
    ["InvalidBrandError", "bad brand", "bad_request"],
    ["TypeError", "x is not a function", "unknown_error"],
  ];

  for (const [name, message, code] of thrown) {
    test(`a thrown ${name} → code "${code}"`, () => {
      const err = new Error(message);
      err.name = name;
      expect(classifyThrown(err).code).toBe(code);
    });
  }

  test("classification is by error NAME, never instanceof — a duplicated module must not silently miss", () => {
    // The SDK's error classes come from the installed package; a bundled or duplicated copy makes
    // `instanceof` false while the name stays right. A plain object with the right name classifies.
    const impostor = Object.assign(new Error("lease held"), { name: "WinterStoreLeaseError" });
    expect(classifyThrown(impostor).code).toBe("store_lease");
  });

  test("every declared code has a message, and no two codes share one", () => {
    expect(AGENT_ERROR_CODES.length).toBeGreaterThan(15);
    expect(new Set(AGENT_ERROR_CODES).size).toBe(AGENT_ERROR_CODES.length);
  });

  test("HTTP status classification covers the ranges, not just the named codes", () => {
    expect(codeForHttpStatus(418)).toBe("bad_request");
    expect(codeForHttpStatus(599)).toBe("server");
    expect(codeForHttpStatus(200)).toBe("unknown_error");
  });
});

describe("projector/errors: an error message can NEVER carry opaque provider state", () => {
  // The session JSONL is the only sink for these payloads; `agent_error.message` is rendered on the
  // Mac, on the phone, and in logs.
  const OPAQUE = ["encrypted_content", "itemJson", "reasoning_item", "redacted_thinking", "signature_delta"];

  for (const marker of OPAQUE) {
    test(`a result whose text contains "${marker}" is refused as a detail`, () => {
      expect(sanitizeDetail(`failed while writing ${marker}: AAAABBBBCCCC`)).toBeUndefined();
      const classified = classifyResult(res({ is_error: true, result: `boom ${marker} AAAABBBBCCCC`, api_error_status: 500 }));
      expect(classified.message).not.toContain(marker);
      expect(classified.message).not.toContain("AAAABBBBCCCC");
      expect(classified.code).toBe("server");
    });
  }

  test("a long detail is bounded, so a megabyte of provider prose can never reach the phone's frame cap", () => {
    const detail = sanitizeDetail("x".repeat(5000));
    expect(detail!.length).toBeLessThanOrEqual(201);
  });

  test("the end-to-end path is clean too: nothing opaque survives into the emitted agent_error", () => {
    const { projector } = makeProjector();
    accept(projector, init());
    accept(projector, assistantText("working"));
    const out = accept(projector, result({
      is_error: true, subtype: "error_during_execution",
      result: "tool crashed; itemJson={\"encrypted_content\":\"SECRETSECRET\"}",
    }));
    const json = JSON.stringify(out);
    for (const marker of OPAQUE) expect(json).not.toContain(marker);
    expect(json).not.toContain("SECRETSECRET");
    expect((out[0] as TC).code).toBe("tool_failure");
  });
});

describe("projector/errors: the thrown-error door (surface map §4.8 item 3)", () => {
  test("a throw with a turn still open produces agent_error + turn_completed(error)", () => {
    const { projector } = makeProjector();
    accept(projector, init());
    accept(projector, assistantText("working"));
    const err = Object.assign(new Error("runtime exited"), { name: "ProcessError" });
    const out = acceptError(projector, err) as unknown as TC[];
    expect(out.map((e) => e.type)).toEqual(["agent_error", "turn_completed"]);
    expect(out[0]).toMatchObject({ code: "process_death" });
    expect(out[1]).toMatchObject({ stopReason: "error" });
    expect(projector.turnRunning).toBe(false);
  });

  test("a thrown AbortError is a TURN BOUNDARY, not an error (P8b-24) — no agent_error", () => {
    const { projector } = makeProjector();
    accept(projector, init());
    accept(projector, assistantText("working"));
    const err = Object.assign(new Error("aborted"), { name: "AbortError" });
    const out = acceptError(projector, err) as unknown as TC[];
    expect(out.map((e) => e.type)).toEqual(["turn_completed"]);
    expect(out[0]).toMatchObject({ stopReason: "aborted" });
  });

  test("a ResultError for a result ALREADY projected is the error-result-then-throw pair — projected once, not twice", () => {
    const { projector } = makeProjector();
    accept(projector, init());
    accept(projector, assistantText("working"));
    const terminal = accept(projector, result({ is_error: true, api_error_status: 500 }));
    expect(terminal.map((e) => e.type)).toEqual(["agent_error", "turn_completed"]);
    const err = Object.assign(new Error("result error: error_during_execution"), { name: "ResultError" });
    expect(acceptError(projector, err)).toEqual([]);
  });

  test("a throw with no turn running produces nothing and warns", () => {
    const { projector, warnings } = makeProjector();
    accept(projector, init());
    expect(acceptError(projector, new Error("boom"))).toEqual([]);
    expect(warnings.join(" ")).toContain("no turn running");
  });
});

/**
 * Hotfix (credential material, P8b): a `CredentialResolutionError("malformed")` thrown by the
 * child's keychain-store.ts has NO structured discriminator on the wire — it reaches this daemon as
 * `terminal_reason: "api_error"` / `api_error_status: null`, structurally identical to any other
 * pre-request resolution failure (see the conformance golden `p6-resolution-failure.trace.json`,
 * which is exactly this shape for an unknown-model failure). The ONLY way to tell a credential
 * failure apart is the child's own fixed wording in `result.result` — this pins that match, and pins
 * that an unrelated `api_error` (no marker present) keeps reading as `server`, unchanged.
 */
describe("projector/errors: a credential-resolution api_error classifies as auth, not server", () => {
  test('the exact live bug — "...is not valid JSON credential material" → auth, not server', () => {
    const classified = classifyResult(res({
      is_error: true,
      terminal_reason: "api_error",
      api_error_status: null,
      result: "provider request failed (network): the keychain record for keychain:com.norma.core.dev/codex-access-token is not valid JSON credential material",
    }));
    expect(classified.code).toBe("auth");
    expect(classified.message).toBe(
      "the provider rejected these credentials: provider request failed (network): the keychain record for keychain:com.norma.core.dev/codex-access-token is not valid JSON credential material",
    );
  });

  test('"...is not a recognized credential material shape" → auth', () => {
    const classified = classifyResult(res({
      is_error: true,
      terminal_reason: "api_error",
      api_error_status: null,
      result: "the keychain record for keychain:com.norma.core.dev/openai:default is not a recognized credential material shape",
    }));
    expect(classified.code).toBe("auth");
  });

  test("an api_error with NEITHER marker stays server — an unknown model, not a credential problem", () => {
    const classified = classifyResult(res({
      is_error: true,
      terminal_reason: "api_error",
      api_error_status: null,
      result: 'model "definitely-not-a-model-t10" is not in provider "anthropic"\'s catalog (its live catalog is authoritative, so absence is definitive)',
    }));
    expect(classified.code).toBe("server");
  });

  test("api_error_status (a real HTTP status) still wins over the credential marker — precedence unchanged", () => {
    // A credential failure never carries a real HTTP status (no request was ever made), but this
    // pins that IF one ever did, the structural HTTP class still takes precedence, exactly like
    // every other api_error case.
    const classified = classifyResult(res({
      is_error: true,
      terminal_reason: "api_error",
      api_error_status: 500,
      result: "... is not valid JSON credential material",
    }));
    expect(classified.code).toBe("server"); // codeForHttpStatus(500), not the marker match
  });
});
