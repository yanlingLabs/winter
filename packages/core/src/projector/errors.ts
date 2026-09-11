import type { ResultFrame } from "./conversation";

/**
 * ── ONE DISTINCT `agent_error.code` PER ERROR CLASS (digest item 20 / WS-14 §13) ────────────────
 *
 * A collapsed `Error` mapping is the failure this module exists to prevent: every failure reaching
 * the user as one undifferentiated "agent error" makes a rate limit, a dead child process and a
 * corrupt store indistinguishable — to the user AND to the code that reads the field.
 * `routines/runner.ts:81` already switches on `code === "rate_limit"` today, so the codes are a
 * consumed contract, not decoration.
 *
 * TWO RULES THAT ARE NOT NEGOTIABLE HERE:
 *
 *  1. **The five provider codes keep their EXISTING spellings** — `auth`, `rate_limit`, `server`,
 *     `network`, `bad_request` (`providers/types.ts:11`, the enum today's `agent_error` producers
 *     draw from). Renaming `rate_limit` on the Winter leg would silently break the routines
 *     runner's quota detection, which is the one live consumer. Winter-specific classes get NEW
 *     codes; the shared ones are reused verbatim.
 *  2. **`message` is never raw error text that could carry opaque provider state.** A
 *     `redacted_thinking.data`, an `encrypted_content`, a `reasoning_item.itemJson` — the session
 *     JSONL is their only sink, and `agent_error.message` is rendered on the Mac, on the phone, and
 *     in logs. Every message here is composed from a CLASS description plus, at most, a status code
 *     or an error NAME. `sanitizeDetail` is the one place foreign text may pass, and it refuses
 *     anything carrying an opaque marker. `api_refusal_explanation` and friends are never read at
 *     all (§4.7 marks them display-only and never to be parsed).
 *
 * An INTERRUPT is not in this table at all: ruling P8b-24 makes it a turn boundary, projected as
 * `turn_completed(stopReason:"aborted")` by `terminal.ts`. The `aborted` code below exists only for
 * an `AbortError` thrown with no terminal result ever seen — a child killed mid-flight, which is a
 * different fact from a clean interrupt.
 */
export type AgentErrorCode =
  // shared with the engine's provider layer — spellings are load-bearing
  | "auth" | "rate_limit" | "server" | "network" | "bad_request"
  // provider classes the five do not name
  | "billing" | "model_not_found" | "max_output_tokens" | "context_overflow"
  // turn-shaped terminals
  | "max_turns" | "max_budget" | "structured_output_exhausted" | "tool_failure"
  // transport / lifecycle
  | "aborted" | "process_death" | "protocol_decode" | "connection_closed"
  // host-side storage
  | "store_error" | "store_lease"
  // the deliberate last resort
  | "unknown_error";

export interface ClassifiedError { code: AgentErrorCode; message: string }

/** One sentence per class, user-facing. Never interpolates foreign text. */
const CLASS_MESSAGE: Record<AgentErrorCode, string> = {
  auth: "the provider rejected these credentials",
  rate_limit: "the provider is rate limiting this account",
  server: "the provider is unavailable or overloaded",
  network: "the provider could not be reached",
  bad_request: "the provider rejected the request as invalid",
  billing: "this account cannot be billed for the request",
  model_not_found: "the requested model is not available to this account",
  max_output_tokens: "the reply hit the model's output limit",
  context_overflow: "the conversation no longer fits in the model's context",
  max_turns: "the turn hit its maximum number of rounds",
  max_budget: "the turn hit its spending limit",
  structured_output_exhausted: "the model could not produce valid structured output",
  tool_failure: "a tool failed while the turn was running",
  aborted: "the turn was stopped before it finished",
  process_death: "the runtime process exited unexpectedly",
  protocol_decode: "the runtime sent a frame this daemon could not decode",
  connection_closed: "the connection to the runtime closed",
  store_error: "the session store could not be read or written",
  store_lease: "another process holds this session's store lease",
  unknown_error: "the turn failed for an unrecognised reason",
};

/**
 * The 11-member `SDKAssistantMessageError` taxonomy (`frames.ts:381-392`) → codes. Closed on the
 * pin, so a value outside it falls to `unknown_error` rather than being passed through as a code.
 */
const PROVIDER_TAXONOMY: Readonly<Record<string, AgentErrorCode>> = {
  authentication_failed: "auth",
  oauth_org_not_allowed: "auth",
  account_on_hold: "billing",
  billing_error: "billing",
  rate_limit: "rate_limit",
  overloaded: "server",
  invalid_request: "bad_request",
  model_not_found: "model_not_found",
  server_error: "server",
  max_output_tokens: "max_output_tokens",
  unknown: "unknown_error",
};

/** `result.subtype` → code, for the subtypes that name a class by themselves (`frames.ts:585`). */
const SUBTYPE_CODE: Readonly<Record<string, AgentErrorCode>> = {
  error_max_turns: "max_turns",
  error_max_budget_usd: "max_budget",
  error_max_structured_output_retries: "structured_output_exhausted",
  error_during_execution: "tool_failure",
};

/** An HTTP status → provider class. `api_error_status` is the structural signal; the result's prose
 *  is never string-matched for "429" or "401", which is what the engine had to do. */
export function codeForHttpStatus(status: number): AgentErrorCode {
  if (status === 401 || status === 403) return "auth";
  if (status === 402) return "billing";
  if (status === 404) return "model_not_found";
  if (status === 408 || status === 499) return "network";
  if (status === 429) return "rate_limit";
  if (status >= 500) return "server";
  if (status >= 400) return "bad_request";
  return "unknown_error";
}

/**
 * Markers of opaque provider state. If any appears in a string, that string never leaves this
 * module — the session JSONL is the only sink for those payloads, and an error message is not it.
 */
const OPAQUE_MARKERS = ["encrypted_content", "itemJson", "reasoning_item", "redacted_thinking", "signature_delta"];

/** A short, bounded, opaque-free detail, or undefined. The ONLY door foreign text uses. */
export function sanitizeDetail(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const text = raw.trim();
  if (text.length === 0) return undefined;
  for (const marker of OPAQUE_MARKERS) if (text.includes(marker)) return undefined;
  return text.length <= 200 ? text : `${text.slice(0, 200)}…`;
}

const compose = (code: AgentErrorCode, detail?: string): ClassifiedError => ({
  code,
  message: detail === undefined ? CLASS_MESSAGE[code] : `${CLASS_MESSAGE[code]}: ${detail}`,
});

/**
 * Classify a terminal `result` that is an error.
 *
 * Precedence, most specific first: the provider taxonomy (a named class), then `api_error_status`
 * (a structural HTTP class), then `terminal_reason`, then `subtype`. Anything unrecognised is
 * `unknown_error` — never a pass-through of the runtime's own string as a code, which would make
 * the field unswitchable.
 */
export function classifyResult(result: ResultFrame): ClassifiedError {
  const detail = sanitizeDetail(result.result);

  const taxonomy = typeof result.error === "string" ? PROVIDER_TAXONOMY[result.error] : undefined;
  if (taxonomy !== undefined) return compose(taxonomy, detail);

  const status = result.api_error_status;
  if (typeof status === "number" && Number.isFinite(status)) return compose(codeForHttpStatus(status), detail);

  const reason = typeof result.terminal_reason === "string" ? result.terminal_reason : undefined;
  if (reason === "structured_output_retry_exhausted") return compose("structured_output_exhausted", detail);
  // NOTE: 0.0.3 has NO wire producer for a context overflow — Winter auto-compacts before it can
  // happen (`DEFAULT_COMPACTION_THRESHOLD` on the barrel), and the 11-member provider taxonomy has
  // no overflow member. The class is implemented and tested against a synthetic frame so the code
  // is distinct and has a home the day a signal appears; it is NOT claimed to be reachable today.
  if (reason === "context_overflow") return compose("context_overflow", detail);
  if (reason === "api_error") return compose("server", detail);

  const bySubtype = typeof result.subtype === "string" ? SUBTYPE_CODE[result.subtype] : undefined;
  if (bySubtype !== undefined) return compose(bySubtype, detail);

  return compose("unknown_error", detail);
}

/**
 * Classify an exception the driver's `for await` caught. This door matters: §4.8 item 3 — an error
 * result is yielded AND THEN thrown (`ResultError` at `query.ts:1084`), so a host that never wraps
 * its iteration gets an unhandled rejection. The driver wraps, hands the error here, and the
 * projector answers with an `agent_error`/`turn_completed` pair ONLY if the turn is still open.
 *
 * Classification is by the error's `name`, never by `instanceof`: the SDK's error classes come from
 * the installed package, and a duplicated-module or bundled copy makes `instanceof` silently false
 * while the name stays right.
 */
export function classifyThrown(err: unknown): ClassifiedError {
  const name = err instanceof Error ? err.name : "";
  const detail = sanitizeDetail(err instanceof Error ? err.message : undefined);
  switch (name) {
    case "AbortError": return compose("aborted", detail);
    case "ProcessError": return compose("process_death", detail);
    case "CLIConnectionError": return compose("process_death", detail);
    case "ProtocolDecodeError": return compose("protocol_decode", detail);
    case "WinterRpcError": return compose("connection_closed", detail);
    case "WinterRpcTimeoutError": return compose("connection_closed", detail);
    case "SessionNotFoundError": return compose("store_error", detail);
    case "WinterStoreLeaseError": return compose("store_lease", detail);
    case "WinterStoreError": return compose("store_error", detail);
    case "InvalidBrandError": return compose("bad_request", detail);
    // `ResultError` is the "error-result-then-throw" pair of a result already classified and
    // already projected — the driver must not project it twice. `index.ts` drops it when the
    // turn's terminal has already been emitted; this branch only fires for a ResultError that
    // arrives with no terminal, which is a genuine protocol violation.
    case "ResultError": return compose("unknown_error", detail);
    default: return compose("unknown_error", detail);
  }
}

/** Exported for the table's own test: every class has a distinct code and a message. */
export const AGENT_ERROR_CODES = Object.keys(CLASS_MESSAGE) as readonly AgentErrorCode[];
export { CLASS_MESSAGE };
