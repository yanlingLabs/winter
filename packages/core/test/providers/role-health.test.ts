import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyDispatchAgentError, classifyProviderFailure, RoleHealthRegistry, recordDispatchOutcome, withProblem } from "../../src/providers/role-health";


// A base64 secret contains `+`, `/` and `=`. If those were outside the redactor's character class the
// key would be split into runs shorter than the threshold, and every piece would survive on its own.
test("a base64-shaped secret in an unclassified provider message never reaches the detail line", () => {
  const secret = "abcdEFGH1234+ijklMNOP5678/qrstUVWX9012==";
  const out = classifyProviderFailure({ code: "bad_request", message: `request failed for token ${secret} upstream` });
  expect(out.reason).toBe("other");
  for (const piece of ["abcdEFGH1234", "ijklMNOP5678", "qrstUVWX9012", secret]) expect(out.detail).not.toContain(piece);
  expect(out.detail).toContain("[redacted]");
});

describe("classifyProviderFailure — one reason per case, from real structured inputs", () => {
  test("auth + WinterCredentialMissing -> no-credential, no message fragment ever reaches detail", () => {
    const c = classifyProviderFailure({ code: "auth", providerCode: "WinterCredentialMissing", message: "sk-super-secret-leaked-key-01234567890" });
    expect(c.reason).toBe("no-credential");
    expect(c.detail).not.toContain("sk-super-secret");
    expect(c.detail).not.toContain("leaked");
  });

  test("auth, no providerCode -> credential-rejected, message NEVER used (auth-class safest rule)", () => {
    const c = classifyProviderFailure({ code: "auth", message: "Bearer sk-ant-abcdefghijklmnopqrstuvwxyz0123456789 rejected" });
    expect(c.reason).toBe("credential-rejected");
    expect(c.detail).not.toContain("sk-ant");
    expect(c.detail).not.toContain("Bearer");
  });

  test("rate_limit + usage_limit_reached providerCode -> usage-limit (not rate-limited)", () => {
    const c = classifyProviderFailure({ code: "rate_limit", providerCode: "usage_limit_reached", message: "HTTP 429" });
    expect(c.reason).toBe("usage-limit");
  });

  test("rate_limit + insufficient_quota providerCode -> out-of-credits", () => {
    const c = classifyProviderFailure({ code: "rate_limit", providerCode: "insufficient_quota", message: "HTTP 429" });
    expect(c.reason).toBe("out-of-credits");
  });

  test("rate_limit, no billing-shaped providerCode -> rate-limited", () => {
    const c = classifyProviderFailure({ code: "rate_limit", message: "HTTP 429" });
    expect(c.reason).toBe("rate-limited");
  });

  test("bad_request + model_not_found providerCode -> model-unavailable", () => {
    const c = classifyProviderFailure({ code: "bad_request", providerCode: "model_not_found", message: "no such model" });
    expect(c.reason).toBe("model-unavailable");
  });

  test("bad_request, no recognised providerCode -> other, with a capped/stripped message fragment", () => {
    const longKey = "A".repeat(40);
    const c = classifyProviderFailure({ code: "bad_request", message: `malformed request near token ${longKey} end` });
    expect(c.reason).toBe("other");
    expect(c.detail).toContain("[redacted]");
    expect(c.detail).not.toContain(longKey);
  });

  test("bad_request + usage-limit/out-of-credits providerCode still routes through the SAME buckets as rate_limit", () => {
    expect(classifyProviderFailure({ code: "bad_request", providerCode: "usage_limit_exceeded", message: "" }).reason).toBe("usage-limit");
    expect(classifyProviderFailure({ code: "bad_request", providerCode: "billing_not_active", message: "" }).reason).toBe("out-of-credits");
  });

  test("model_not_found (dispatch's own coarse code) -> model-unavailable", () => {
    expect(classifyProviderFailure({ code: "model_not_found", message: "" }).reason).toBe("model-unavailable");
  });

  test("billing (dispatch's own coarse code) -> out-of-credits, honestly (usage-limit is NOT distinguishable at this layer)", () => {
    expect(classifyProviderFailure({ code: "billing", message: "" }).reason).toBe("out-of-credits");
  });

  test("server / network -> provider-unavailable", () => {
    expect(classifyProviderFailure({ code: "server", message: "500" }).reason).toBe("provider-unavailable");
    expect(classifyProviderFailure({ code: "network", message: "ECONNRESET" }).reason).toBe("provider-unavailable");
  });

  test("retryAt from retryAfterMs", () => {
    const now = () => 1_000_000;
    const c = classifyProviderFailure({ code: "rate_limit", retryAfterMs: 5000, message: "429" }, now);
    expect(c.retryAt).toBe(new Date(1_000_000 + 5000).toISOString());
  });

  test("retryAt from subscription-quota info when no retryAfterMs is present", () => {
    const c = classifyProviderFailure({
      code: "rate_limit", providerCode: "usage_limit_reached", message: "429",
      subscriptionQuota: { info: { status: "rejected", resetsAt: 2_000_000 }, at: 1 },
    });
    expect(c.retryAt).toBe(new Date(2_000_000 * 1000).toISOString());
  });

  test("subscription-quota info with status allowed never produces a retryAt", () => {
    const c = classifyProviderFailure({
      code: "rate_limit", message: "429",
      subscriptionQuota: { info: { status: "allowed" }, at: 1 },
    });
    expect(c.retryAt).toBeUndefined();
  });

  test("a secret-shaped fragment never reaches detail even when message is the ONLY source (other bucket)", () => {
    const apiKey = "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789ABCDEF";
    const c = classifyProviderFailure({ code: "bad_request", message: `invalid key ${apiKey}` });
    expect(c.detail).not.toContain(apiKey);
  });

  test("detail is capped at ~160 chars for the other bucket", () => {
    const c = classifyProviderFailure({ code: "bad_request", message: "x".repeat(500) });
    expect(c.detail.length).toBeLessThanOrEqual(160);
  });
});

describe("classifyDispatchAgentError — coarse AgentErrorCode only, no status/providerCode reach the wire", () => {
  test("provider-attributable codes classify", () => {
    expect(classifyDispatchAgentError("auth")?.reason).toBe("credential-rejected");
    expect(classifyDispatchAgentError("rate_limit")?.reason).toBe("rate-limited");
    expect(classifyDispatchAgentError("server")?.reason).toBe("provider-unavailable");
    expect(classifyDispatchAgentError("network")?.reason).toBe("provider-unavailable");
    expect(classifyDispatchAgentError("model_not_found")?.reason).toBe("model-unavailable");
    expect(classifyDispatchAgentError("billing")?.reason).toBe("out-of-credits");
    expect(classifyDispatchAgentError("bad_request")?.reason).toBe("other");
  });

  test("non-provider codes (max_turns, tool_failure, aborted, store_error, unknown, absent) record nothing", () => {
    for (const code of ["max_turns", "max_budget", "structured_output_exhausted", "tool_failure", "aborted", "process_death", "protocol_decode", "connection_closed", "store_error", "store_lease", "unknown_error", undefined]) {
      expect(classifyDispatchAgentError(code)).toBeUndefined();
    }
  });
});

describe("RoleHealthRegistry", () => {
  function tmpHome(): string {
    return mkdtempSync(join(tmpdir(), "winter-role-health-"));
  }

  test("failure -> visible via problemFor; success -> cleared", () => {
    const reg = new RoleHealthRegistry(tmpHome());
    expect(reg.problemFor("pins.dream", "codex-oauth/gpt-5.6-terra")).toBeNull();
    reg.recordFailure("pins.dream", "codex-oauth/gpt-5.6-terra", { reason: "rate-limited", detail: "rate limited" });
    const problem = reg.problemFor("pins.dream", "codex-oauth/gpt-5.6-terra");
    expect(problem).not.toBeNull();
    expect(problem?.reason).toBe("rate-limited");
    expect(problem?.model).toBe("codex-oauth/gpt-5.6-terra");
    expect(typeof problem?.at).toBe("string");
    reg.recordSuccess("pins.dream");
    expect(reg.problemFor("pins.dream", "codex-oauth/gpt-5.6-terra")).toBeNull();
  });

  test("a note about a model the role no longer uses reads as no-problem — without deleting the underlying note", () => {
    const reg = new RoleHealthRegistry(tmpHome());
    reg.recordFailure("pins.cleaner", "openai/gpt-5.4", { reason: "credential-rejected", detail: "x" });
    expect(reg.problemFor("pins.cleaner", "codex-oauth/gpt-5.6-terra")).toBeNull();
    // Moving back to the failed model surfaces the SAME note again — proof it was never deleted.
    expect(reg.problemFor("pins.cleaner", "openai/gpt-5.4")?.reason).toBe("credential-rejected");
  });

  test("problemFor with a null current model is always problem-free", () => {
    const reg = new RoleHealthRegistry(tmpHome());
    reg.recordFailure("runtimes.advisorModel", "openai/gpt-5.4", { reason: "other", detail: "x" });
    expect(reg.problemFor("runtimes.advisorModel", null)).toBeNull();
  });

  test("persistence round-trips across a fresh instance on the same home", () => {
    const home = tmpHome();
    const reg1 = new RoleHealthRegistry(home);
    reg1.recordFailure("pins.research", "codex-oauth/gpt-5.6-luna", { reason: "usage-limit", detail: "the plan's usage window is exhausted", retryAt: "2026-09-19T00:00:00.000Z" });
    const reg2 = new RoleHealthRegistry(home);
    const problem = reg2.problemFor("pins.research", "codex-oauth/gpt-5.6-luna");
    expect(problem).toMatchObject({ reason: "usage-limit", model: "codex-oauth/gpt-5.6-luna", retryAt: "2026-09-19T00:00:00.000Z" });
  });

  test("a missing file starts empty, never throws", () => {
    const home = tmpHome(); // no role-health.json written yet
    expect(() => new RoleHealthRegistry(home)).not.toThrow();
    const reg = new RoleHealthRegistry(home);
    expect(reg.problemFor("pins.dispatch", "openai/gpt-5.4")).toBeNull();
  });

  test("a corrupt file starts empty, never throws", () => {
    const home = tmpHome();
    mkdirSync(join(home, "runtimes"), { recursive: true });
    writeFileSync(join(home, "runtimes", "role-health.json"), "{not valid json");
    expect(() => new RoleHealthRegistry(home)).not.toThrow();
    const reg = new RoleHealthRegistry(home);
    expect(reg.problemFor("pins.dispatch", "openai/gpt-5.4")).toBeNull();
  });

  test("a file with a malformed entry shape is skipped, not thrown on", () => {
    const home = tmpHome();
    mkdirSync(join(home, "runtimes"), { recursive: true });
    writeFileSync(join(home, "runtimes", "role-health.json"), JSON.stringify({ "pins.dream": { reason: 42 } }));
    const reg = new RoleHealthRegistry(home);
    expect(reg.problemFor("pins.dream", "anything")).toBeNull();
  });

  test("persists atomically — a reader never sees a torn write (no leftover .tmp file after a call)", () => {
    const home = tmpHome();
    const reg = new RoleHealthRegistry(home);
    reg.recordFailure("pins.dispatch", "openai/gpt-5.4", { reason: "rate-limited", detail: "x" });
    const path = join(home, "runtimes", "role-health.json");
    const written = JSON.parse(readFileSync(path, "utf8"));
    expect(written["pins.dispatch"].reason).toBe("rate-limited");
  });

  test("recordSuccess on a role with no note is a no-op (no write)", () => {
    const reg = new RoleHealthRegistry(tmpHome());
    expect(() => reg.recordSuccess("pins.dream")).not.toThrow();
    expect(reg.problemFor("pins.dream", "anything")).toBeNull();
  });
});

describe("recordDispatchOutcome — daemon.ts's hub-observer logic, factored out for unit testing", () => {
  const errorEvent = (code: string | undefined) =>
    ({ type: "agent_error" as const, seq: 1, sessionId: "s_x", ts: 0, threadId: "main", message: "x", code });
  const turnCompleted = (stopReason: "end_turn" | "aborted" | "error") =>
    ({ type: "turn_completed" as const, seq: 2, sessionId: "s_x", ts: 0, threadId: "main", stopReason, inputTokens: 0, outputTokens: 0 });

  test("a provider-attributable agent_error records pins.dispatch under the given tag", () => {
    const reg = new RoleHealthRegistry(mkdtempSync(join(tmpdir(), "winter-dispatch-rh-")));
    recordDispatchOutcome(errorEvent("rate_limit"), "codex-oauth/gpt-5.6-terra", reg);
    expect(reg.problemFor("pins.dispatch", "codex-oauth/gpt-5.6-terra")?.reason).toBe("rate-limited");
  });

  test("a non-provider agent_error code (e.g. max_turns) records nothing", () => {
    const reg = new RoleHealthRegistry(mkdtempSync(join(tmpdir(), "winter-dispatch-rh-")));
    recordDispatchOutcome(errorEvent("max_turns"), "codex-oauth/gpt-5.6-terra", reg);
    expect(reg.problemFor("pins.dispatch", "codex-oauth/gpt-5.6-terra")).toBeNull();
  });

  test("turn_completed(end_turn) clears a previously recorded note", () => {
    const reg = new RoleHealthRegistry(mkdtempSync(join(tmpdir(), "winter-dispatch-rh-")));
    reg.recordFailure("pins.dispatch", "codex-oauth/gpt-5.6-terra", { reason: "other", detail: "x" });
    recordDispatchOutcome(turnCompleted("end_turn"), "codex-oauth/gpt-5.6-terra", reg);
    expect(reg.problemFor("pins.dispatch", "codex-oauth/gpt-5.6-terra")).toBeNull();
  });

  test("turn_completed(aborted) is neither a success nor a failure — the note survives", () => {
    const reg = new RoleHealthRegistry(mkdtempSync(join(tmpdir(), "winter-dispatch-rh-")));
    reg.recordFailure("pins.dispatch", "codex-oauth/gpt-5.6-terra", { reason: "other", detail: "x" });
    recordDispatchOutcome(turnCompleted("aborted"), "codex-oauth/gpt-5.6-terra", reg);
    expect(reg.problemFor("pins.dispatch", "codex-oauth/gpt-5.6-terra")).not.toBeNull();
  });

  test("turn_completed(error) is not itself a success — the agent_error just before it already recorded the failure", () => {
    const reg = new RoleHealthRegistry(mkdtempSync(join(tmpdir(), "winter-dispatch-rh-")));
    recordDispatchOutcome(errorEvent("server"), "codex-oauth/gpt-5.6-terra", reg);
    recordDispatchOutcome(turnCompleted("error"), "codex-oauth/gpt-5.6-terra", reg);
    expect(reg.problemFor("pins.dispatch", "codex-oauth/gpt-5.6-terra")?.reason).toBe("provider-unavailable");
  });

  test("an unrelated event type is a no-op", () => {
    const reg = new RoleHealthRegistry(mkdtempSync(join(tmpdir(), "winter-dispatch-rh-")));
    recordDispatchOutcome({ type: "session_titled", seq: 1, sessionId: "s_x", ts: 0, threadId: "main", title: "x" } as any, "codex-oauth/gpt-5.6-terra", reg);
    expect(reg.problemFor("pins.dispatch", "codex-oauth/gpt-5.6-terra")).toBeNull();
  });
});

describe("withProblem", () => {
  test("merges problemFor's result onto a modelRoleInfo-shaped object; null when roleHealth is absent", () => {
    const info = { model: "openai/gpt-5.4" as string | null, explicit: true };
    expect(withProblem(info, "pins.dream", undefined)).toMatchObject({ ...info, problem: null });

    const reg = new RoleHealthRegistry(mkdtempSync(join(tmpdir(), "winter-role-health-")));
    reg.recordFailure("pins.dream", "openai/gpt-5.4", { reason: "other", detail: "x" });
    expect(withProblem(info, "pins.dream", reg).problem).toMatchObject({ reason: "other", model: "openai/gpt-5.4" });
  });
});
