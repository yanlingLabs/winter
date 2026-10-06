import { describe, expect, test } from "bun:test";
import { AGENT_ERROR_CODES, AGENT_ERROR_DETAIL_MAX, agentErrorDetail, classifyResult, classifyThrown, codeForHttpStatus, runtimeFailureClass, sanitizeDetail } from "../../src/projector";
import { CLASS_MESSAGE } from "../../src/projector/errors";
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

  test("credential-shaped runs in a vendor's text are scrubbed, ordinary identifiers and urls are not", () => {
    const keys = [
      "sk-ant-api03-AbCdEf0123456789xyzXYZ",
      "sk-proj-0123456789abcdefABCDEF",
      "xai-0123456789abcdefABCDEFghij",
      "AIzaSyA0123456789abcdefghijklmnopqrstuv",
      "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8",
    ];
    for (const key of keys) {
      const detail = sanitizeDetail(`invalid x-api-key: ${key} was rejected`)!;
      expect(detail).not.toContain(key);
      expect(detail).toContain("[redacted]");
    }
    expect(sanitizeDetail("Authorization: Bearer eyJhbGciOi.abc.def failed")).toBe("Authorization: [redacted] failed");
    const plain =
      "invalid_request_error: Your organization must be verified. Go to https://platform.openai.com/settings/organization/general";
    expect(sanitizeDetail(plain)).toBe(plain);
    expect(sanitizeDetail("Your credit balance is too low to access the Anthropic API.")).toBe(
      "Your credit balance is too low to access the Anthropic API.",
    );
  });

  test("a long detail is bounded, so a megabyte of provider prose can never reach the phone's frame cap", () => {
    const detail = sanitizeDetail("x".repeat(5000));
    expect(detail!.length).toBe(AGENT_ERROR_DETAIL_MAX + 1);
    expect(AGENT_ERROR_DETAIL_MAX).toBeLessThanOrEqual(400);
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
      result: "provider request failed (network): the keychain record for keychain:com.winter.core.dev/codex-access-token is not valid JSON credential material",
    }));
    expect(classified.code).toBe("auth");
    // The runtime's own `provider request failed (network): ` wrapper is dropped from the detail
    // (0.0.49): the class sentence already says what kind of failure it is.
    expect(classified.message).toBe(
      "the provider rejected these credentials: the keychain record for keychain:com.winter.core.dev/codex-access-token is not valid JSON credential material",
    );
  });

  test('"...is not a recognized credential material shape" → auth', () => {
    const classified = classifyResult(res({
      is_error: true,
      terminal_reason: "api_error",
      api_error_status: null,
      result: "the keychain record for keychain:com.winter.core.dev/openai:default is not a recognized credential material shape",
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

describe("Codex usage limit (2026-09-16 field report)", () => {
  // SDK 0.0.14 makes the ChatGPT Codex `usage_limit_reached` 429 terminal and words it
  // "usage limit reached (plan: plus) — resets in 48 min". The daemon's class stays `rate_limit`
  // (routines/runner.ts switches on it), but the human prefix must not say "rate limiting" —
  // a spent usage window is not "you are going too fast".
  test("a 429 whose detail names a usage limit keeps code rate_limit with a usage-limit message", () => {
    const c = classifyResult(res({ api_error_status: 429, result: "provider request failed (rate_limit): HTTP 429 — usage limit reached (plan: plus) — resets in 48 min" }));
    expect(c.code).toBe("rate_limit");
    expect(c.message.startsWith("your plan's usage limit is reached")).toBe(true);
    expect(c.message).toContain("resets in 48 min");
  });
  test("an ordinary 429 keeps the rate-limiting wording", () => {
    const c = classifyResult(res({ api_error_status: 429, result: "HTTP 429 — slow down" }));
    expect(c.message.startsWith("the provider is rate limiting this account")).toBe(true);
  });
});

describe("Winter-side capability refusal (2026-09-17 field report)", () => {
  test("the child's own pre-flight refusal is bad_request with a Winter prefix, never 'unavailable or overloaded'", () => {
    const c = classifyResult(res({ terminal_reason: "api_error", api_error_status: null, result: 'provider request failed (capability): a bare model id needs a provider: set `provider.providerId`, or use a qualified "<providerId>/<model>" key' }));
    expect(c.code).toBe("bad_request");
    expect(c.message.startsWith("Winter refused the request before sending it")).toBe(true);
    expect(c.message).not.toContain("unavailable or overloaded");
  });
});

/**
 * Agent SDK 0.0.49: a mid-stream Anthropic `error` frame carries the vendor's message and is classed
 * by its type IN THE RUNTIME. The result reaching the daemon is still `terminal_reason: "api_error"`,
 * `api_error_status: null`, so the class rides only the runtime's `provider request failed (<code>):`
 * prefix. These are the runtime's exact wordings (`provider/bridge.ts` + `streamErrorFrame`).
 */
describe("status-less provider failures are classed by the runtime's own code (agent SDK 0.0.49)", () => {
  const CREDIT = "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.";
  const midStream = (code: string, type: string | undefined, vendor: string | undefined) =>
    res({
      is_error: true,
      terminal_reason: "api_error",
      api_error_status: null,
      result: `provider request failed (${code}): the provider ended the stream with an error frame${type !== undefined ? ` (${type})` : ""}${vendor !== undefined ? `: ${vendor}` : ""}`,
    });

  test("the live case: an exhausted credit balance mid-stream is a refused request, its vendor sentence whole", () => {
    const c = classifyResult(midStream("bad_request", "invalid_request_error", CREDIT));
    expect(c.code).toBe("bad_request");
    expect(c.message).toBe(`the provider refused the request: ${CREDIT}`);
    expect(c.message).not.toContain("unavailable or overloaded");
    expect(c.message).not.toContain("provider request failed");
    expect(c.message).not.toContain("error frame");
  });

  const cases: Array<[string, string, AgentErrorCode, string]> = [
    ["bad_request", "invalid_request_error", "bad_request", CLASS_MESSAGE.bad_request],
    ["bad_request", "not_found_error", "bad_request", CLASS_MESSAGE.bad_request],
    ["bad_request", "request_too_large", "bad_request", CLASS_MESSAGE.bad_request],
    // billing_error is `bad_request` in the runtime, `billing` here — what its HTTP 402 is up front.
    ["bad_request", "billing_error", "billing", CLASS_MESSAGE.billing],
    ["auth", "authentication_error", "auth", CLASS_MESSAGE.auth],
    ["auth", "permission_error", "auth", CLASS_MESSAGE.auth],
    ["rate_limit", "rate_limit_error", "rate_limit", CLASS_MESSAGE.rate_limit],
    ["timeout", "timeout_error", "network", CLASS_MESSAGE.network],
    ["server", "overloaded_error", "server", CLASS_MESSAGE.server],
    ["server", "api_error", "server", CLASS_MESSAGE.server],
  ];
  for (const [runtimeCode, type, code, sentence] of cases) {
    test(`(${runtimeCode}) ${type} → ${code}, with its own sentence and the vendor's`, () => {
      const c = classifyResult(midStream(runtimeCode, type, "Something the vendor said."));
      expect(c.code).toBe(code);
      expect(c.message).toBe(`${sentence}: Something the vendor said.`);
    });
  }

  test("a refusal, a billing block and a credential failure never read as a transient overload", () => {
    for (const [runtimeCode, type] of [["bad_request", "invalid_request_error"], ["bad_request", "billing_error"], ["auth", "authentication_error"]] as const) {
      const c = classifyResult(midStream(runtimeCode, type, CREDIT));
      expect(c.code).not.toBe("server");
      expect(c.code).not.toBe("network");
      expect(c.message).not.toMatch(/unavailable|overloaded|try again|could not be reached/);
    }
  });

  test("a frame with no message keeps its type; one with neither still says what happened", () => {
    expect(classifyResult(midStream("bad_request", "invalid_request_error", undefined)).message)
      .toBe(`${CLASS_MESSAGE.bad_request}: the stream ended with an error frame (invalid_request_error)`);
    const bare = classifyResult(midStream("server", undefined, undefined));
    expect(bare.code).toBe("server");
    expect(bare.message).toBe(`${CLASS_MESSAGE.server}: the stream ended with an error frame`);
  });

  test("stall and timeout from the runtime are network; an unknown runtime class keeps the server reading", () => {
    const stall = classifyResult(res({ terminal_reason: "api_error", api_error_status: null, result: "provider request failed (stall): no bytes for 90s" }));
    expect(stall.code).toBe("network");
    expect(stall.message).toBe(`${CLASS_MESSAGE.network}: no bytes for 90s`);
    expect(classifyResult(res({ terminal_reason: "api_error", api_error_status: null, result: "provider request failed (network): fetch failed" })).code).toBe("network");
    expect(classifyResult(res({ terminal_reason: "api_error", api_error_status: null, result: "provider request failed (quantum): ???" })).code).toBe("server");
    // A prototype member is not a class.
    expect(classifyResult(res({ terminal_reason: "api_error", api_error_status: null, result: "provider request failed (constructor): x" })).code).toBe("server");
  });

  test("a raw throw the runtime normalised (no parenthetical) keeps server, its prefix dropped", () => {
    const c = classifyResult(res({ terminal_reason: "api_error", api_error_status: null, result: "provider request failed: socket hang up" }));
    expect(c.code).toBe("server");
    expect(c.message).toBe(`${CLASS_MESSAGE.server}: socket hang up`);
  });

  test("a real HTTP status still wins over the runtime's class, and the prefix is dropped there too", () => {
    const c = classifyResult(res({ terminal_reason: "api_error", api_error_status: 400, result: `provider request failed (bad_request): HTTP 400 — ${CREDIT}` }));
    expect(c.code).toBe("bad_request");
    expect(c.message).toBe(`${CLASS_MESSAGE.bad_request}: HTTP 400 — ${CREDIT}`);
    expect(classifyResult(res({ terminal_reason: "api_error", api_error_status: 503, result: "provider request failed (bad_request): odd" })).code).toBe("server");
  });

  test("the capability refusal and the credential marker keep their own doors", () => {
    const cap = classifyResult(res({ terminal_reason: "api_error", api_error_status: null, result: "provider request failed (capability): a bare model id needs a provider" }));
    expect(cap.code).toBe("bad_request");
    expect(cap.message).toBe("Winter refused the request before sending it: a bare model id needs a provider");
    const cred = classifyResult(res({ terminal_reason: "api_error", api_error_status: null, result: "provider request failed (network): the keychain record for x is not valid JSON credential material" }));
    expect(cred.code).toBe("auth");
  });

  test("the vendor's longest message (300 chars after the runtime's own cap) survives whole, and the whole stays bounded", () => {
    const vendor = `${"v".repeat(299)}…`;
    const c = classifyResult(midStream("bad_request", "invalid_request_error", vendor));
    expect(c.message).toBe(`${CLASS_MESSAGE.bad_request}: ${vendor}`);
    const huge = classifyResult(res({ terminal_reason: "api_error", api_error_status: null, result: `provider request failed (bad_request): ${"y".repeat(5000)}` }));
    expect(huge.message.length).toBeLessThanOrEqual(CLASS_MESSAGE.bad_request.length + 2 + AGENT_ERROR_DETAIL_MAX + 1);
  });

  test("an opaque marker in the vendor's text still refuses the detail", () => {
    const c = classifyResult(midStream("bad_request", "invalid_request_error", "bad redacted_thinking block AAAABBBB"));
    expect(c.code).toBe("bad_request");
    expect(c.message).toBe(CLASS_MESSAGE.bad_request);
  });

  test("runtimeFailureClass and agentErrorDetail read exactly the shapes they name", () => {
    expect(runtimeFailureClass("provider request failed (rate_limit): HTTP 429")).toBe("rate_limit");
    expect(runtimeFailureClass("provider request failed: x")).toBeUndefined();
    expect(runtimeFailureClass("something provider request failed (auth): x")).toBeUndefined();
    expect(runtimeFailureClass(undefined)).toBeUndefined();
    expect(agentErrorDetail("bad_request", `${CLASS_MESSAGE.bad_request}: ${CREDIT}`)).toBe(CREDIT);
    expect(agentErrorDetail("bad_request", CLASS_MESSAGE.bad_request)).toBeUndefined();
    expect(agentErrorDetail("auth", `${CLASS_MESSAGE.bad_request}: x`)).toBeUndefined();
    expect(agentErrorDetail(undefined, "anything: x")).toBeUndefined();
    expect(agentErrorDetail("toString", "x: y")).toBeUndefined();
  });

  test("end to end through the projector: the agent_error a client renders", () => {
    const { projector } = makeProjector();
    accept(projector, init());
    accept(projector, assistantText("working"));
    const out = accept(projector, result({
      is_error: true, subtype: "success", terminal_reason: "api_error", api_error_status: null,
      result: `provider request failed (bad_request): the provider ended the stream with an error frame (invalid_request_error): ${CREDIT}`,
    }));
    const err = out.find((e) => (e as TC).type === "agent_error") as TC;
    expect(err.code).toBe("bad_request");
    expect(err.message).toBe(`the provider refused the request: ${CREDIT}`);
    expect((out.at(-1) as TC).stopReason).toBe("error");
  });
});
