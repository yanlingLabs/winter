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
  // the runtime's own named verdicts (WS-23): a model refusal, and a paused turn Winter stopped resuming
  | "refusal" | "pause_turn_limit"
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
  network: "the provider could not be reached or stopped responding",
  // Every refusal of the request ITSELF: a malformed request, but also (agent SDK 0.0.49) an
  // Anthropic `invalid_request_error` that is really a spend limit or an exhausted credit balance.
  // Never a retry hint; the vendor's own reason follows it in the detail.
  bad_request: "the provider refused the request",
  billing: "this account cannot be billed for the request",
  model_not_found: "the requested model is not available to this account",
  max_output_tokens: "the reply hit the model's output limit",
  context_overflow: "the conversation no longer fits in the model's context",
  max_turns: "the turn hit its maximum number of rounds",
  max_budget: "the turn hit its spending limit",
  structured_output_exhausted: "the model could not produce valid structured output",
  tool_failure: "a tool failed while the turn was running",
  refusal: "the model declined to respond to this request",
  pause_turn_limit: "the model kept pausing its turn, and Winter stopped resuming it",
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

/**
 * The longest detail an `agent_error.message` carries. 400 since agent SDK 0.0.49: the runtime caps a
 * provider's own message at 400 too (`provider/bridge.ts`'s `MAX_ERROR_MESSAGE_CHARS`), and a vendor's
 * explanation (Anthropic's credit-balance sentence is ~120 chars) must survive whole. Still far inside
 * `session.history`'s and the remote stream's 64 KiB per-string cap.
 */
export const AGENT_ERROR_DETAIL_MAX = 400;

/** A short, bounded, opaque-free detail, or undefined. The ONLY door foreign text uses. */
export function sanitizeDetail(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const text = raw.trim();
  if (text.length === 0) return undefined;
  for (const marker of OPAQUE_MARKERS) if (text.includes(marker)) return undefined;
  return text.length <= AGENT_ERROR_DETAIL_MAX ? text : `${text.slice(0, AGENT_ERROR_DETAIL_MAX)}…`;
}

/**
 * The runtime's own wrapping of a provider failure (`provider/bridge.ts`'s `providerErrorToTurnError`):
 * `provider request failed (<code>): <message>`, where `<code>` is the provider seam's typed class
 * (`ProviderError["code"]`). A raw throw it normalised has no parenthetical (`provider request failed:
 * <message>`). The prefix is the only place the runtime's class reaches this daemon for a failure with
 * no HTTP status (a mid-stream error frame, a stall, a timeout) — the result frame carries
 * `api_error_status: null` and no taxonomy member.
 */
const RUNTIME_FAILURE_PREFIX = /^provider request failed(?: \(([a-z_]+)\))?: /;

/** The runtime's typed class → this module's code. Only the classes a status-less failure can carry;
 *  `capability` keeps its own door (below), `aborted` never reaches a result, and anything else (a
 *  class a later SDK adds) reads as `server`, the pre-0.0.49 reading. `timeout`/`stall` are `network`,
 *  as `providers/runtime-provider.ts`'s `mapErrorCode` already reads them for the internal jobs. */
const RUNTIME_CLASS_CODE: Readonly<Record<string, AgentErrorCode>> = {
  bad_request: "bad_request",
  auth: "auth",
  rate_limit: "rate_limit",
  server: "server",
  network: "network",
  timeout: "network",
  stall: "network",
};

/** The runtime's typed class from its failure prefix, or undefined. */
export function runtimeFailureClass(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  return RUNTIME_FAILURE_PREFIX.exec(raw)?.[1];
}

/**
 * Anthropic's mid-stream error frame, as the agent SDK words it (0.0.49 `streamErrorFrame`):
 * `the provider ended the stream with an error frame (<type>): <the vendor's message>` — or with no
 * message, or no type. The class sentence already says the provider refused or failed, so the detail
 * keeps only the vendor's own sentence (the part a user can act on), or the type when that is all
 * there is.
 */
const STREAM_ERROR_FRAME = /^the provider ended the stream with an error frame(?: \(([A-Za-z0-9_]+)\))?(?:: ([\s\S]+))?$/;

/** The text worth showing: the runtime's failure prefix dropped, a stream error frame reduced to the
 *  vendor's own sentence. Everything else passes through unchanged (`sanitizeDetail` still bounds it). */
function readableFailureText(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  const text = raw.replace(RUNTIME_FAILURE_PREFIX, "");
  const frame = STREAM_ERROR_FRAME.exec(text);
  if (frame === null) return text;
  const [, type, vendor] = frame;
  if (vendor !== undefined && vendor.trim().length > 0) return vendor;
  return type !== undefined ? `the stream ended with an error frame (${type})` : "the stream ended with an error frame";
}

/** Anthropic's `billing_error` (HTTP 402 when it is refused up front, which `codeForHttpStatus` already
 *  reads as `billing`): the agent SDK files it under `bad_request` mid-stream, so it is recognised here
 *  by the frame's own type, the same structured fact the status carries up front. */
function isBillingStreamFrame(raw: unknown): boolean {
  if (typeof raw !== "string") return false;
  return STREAM_ERROR_FRAME.exec(raw.replace(RUNTIME_FAILURE_PREFIX, ""))?.[1] === "billing_error";
}

/**
 * The detail that follows a class sentence, for a reader that has its own sentence for the class (role
 * health's dispatch note): the message with this module's class sentence dropped, or undefined when
 * the message is the bare sentence or is not one of ours.
 */
export function agentErrorDetail(code: string | undefined, message: string): string | undefined {
  const sentence = code !== undefined && Object.hasOwn(CLASS_MESSAGE, code) ? CLASS_MESSAGE[code as AgentErrorCode] : undefined;
  if (sentence === undefined || !message.startsWith(`${sentence}: `)) return undefined;
  const detail = message.slice(sentence.length + 2).trim();
  return detail.length > 0 ? detail : undefined;
}

/** SDK 0.0.14's wording for a ChatGPT Codex `usage_limit_reached` 429 (`provider-runtime/src/errors.ts`
 *  `normalizeHttpError`): a SPENT usage window that resets on a clock, not "you are going too fast". The
 *  class stays `rate_limit` (`routines/runner.ts` switches on it); only the human prefix changes. */
const USAGE_LIMIT_DETAIL = /usage limit reached/i;
const USAGE_LIMIT_MESSAGE = "your plan's usage limit is reached";

const compose = (code: AgentErrorCode, detail?: string): ClassifiedError => {
  const prefix = code === "rate_limit" && detail !== undefined && USAGE_LIMIT_DETAIL.test(detail) ? USAGE_LIMIT_MESSAGE : CLASS_MESSAGE[code];
  return { code, message: detail === undefined ? prefix : `${prefix}: ${detail}` };
};

/**
 * Hotfix (credential material, P8b): a `CredentialResolutionError("malformed")` thrown by the
 * child's `winter-agent-sdk` `packages/runtime/src/provider/keychain-store.ts` (a stored Keychain
 * record that does not `JSON.parse` into material its `coerceMaterial()` accepts) is not a
 * `ProviderError`, so it falls through `provider-runtime/src/errors.ts`'s `normalizeThrown` to the
 * generic `{ code: "network", retryable: true }` branch, then reaches this daemon as
 * `terminal_reason: "api_error"` / `api_error_status: null` with the raw thrown text riding
 * `result.result` — structurally IDENTICAL to any other pre-request resolution failure (e.g. "model
 * ... is not in provider ...'s catalog", `conformance/goldens/p6-resolution-failure.trace.json`).
 * There is no structured field that tells these apart; the child's own fixed wording is the only
 * discriminator available, so this matches it rather than leaving every credential failure to read
 * as `server` ("the provider is unavailable or overloaded" — wrong: retrying changes nothing, the
 * record is deterministically malformed). A wording change in a future SDK bump makes the match
 * silently stop firing (caught by this module's own unit test, not a runtime assertion) and the
 * failure reverts to `server` — still accurate, just less specific, never a throw.
 */
const CREDENTIAL_RESOLUTION_MARKERS = [
  "is not valid JSON credential material",
  "is not a recognized credential material shape",
];

/** The child's OWN pre-flight refusal (`provider-runtime` `capabilityRefusal`, e.g. "a bare model id
 *  needs a provider", "declares no reasoning effort vocabulary"): Winter refused before any request
 *  left the machine, so "unavailable or overloaded" (a retry hint) is the wrong class. */
const CAPABILITY_REFUSAL_MARKER = "provider request failed (capability)";
const CAPABILITY_REFUSAL_MESSAGE = "Winter refused the request before sending it";
function isCapabilityRefusal(raw: unknown): boolean {
  return typeof raw === "string" && raw.includes(CAPABILITY_REFUSAL_MARKER);
}

function isCredentialResolutionFailure(raw: unknown): boolean {
  return typeof raw === "string" && CREDENTIAL_RESOLUTION_MARKERS.some((marker) => raw.includes(marker));
}

/**
 * WS-23: the `terminal_reason`s the runtime names ITSELF, each a verdict about the turn rather than
 * about one HTTP exchange — so each outranks `api_error_status` (below). The case that makes the
 * ordering load-bearing is `prompt_too_long`: the runtime emits it WITH the vendor's status (a 400 on
 * Anthropic's overflow), which the status branch would read as `bad_request` ("the provider rejected
 * the request as invalid") — a message that sends the user looking for a malformed request instead of
 * a conversation that no longer fits.
 *
 *  - `prompt_too_long` — the context overflowed and the runtime's reactive compaction could not
 *    recover it (claude's own `TerminalReason` spelling; the runtime reuses it). → `context_overflow`.
 *  - `refusal` — the model ended the stream with `stop_reason: "refusal"` and there was no fallback
 *    model to retry on. `result` carries the partial text, else the vendor's explanation (display-only,
 *    never parsed — it reaches the message only through `sanitizeDetail`'s bound).
 *  - `pause_turn_limit` — the vendor paused the turn more times than the runtime resumes one
 *    (`MAX_PAUSE_TURN_CONTINUATIONS`); `result` is the paused turn's text.
 *
 * `hook_stopped` is deliberately NOT here: it is `is_error: false` (a hook ended the turn on purpose),
 * and `terminal.ts` projects it as a `hook_notice`, never an `agent_error`.
 */
const NAMED_TERMINAL_CODE: Readonly<Record<string, AgentErrorCode>> = {
  prompt_too_long: "context_overflow",
  refusal: "refusal",
  pause_turn_limit: "pause_turn_limit",
};

/**
 * Classify a terminal `result` that is an error.
 *
 * Precedence, most specific first: the provider taxonomy (a named class), then the runtime's own
 * named terminal verdicts (`NAMED_TERMINAL_CODE`, WS-23), then `api_error_status` (a structural HTTP
 * class), then the remaining `terminal_reason`s (a status-less `api_error` by the runtime's own
 * class from its failure prefix — 0.0.49), then `subtype`. Anything unrecognised is
 * `unknown_error` — never a pass-through of the runtime's own string as a code, which would make
 * the field unswitchable.
 */
export function classifyResult(result: ResultFrame): ClassifiedError {
  const detail = sanitizeDetail(readableFailureText(result.result));

  const taxonomy = typeof result.error === "string" ? PROVIDER_TAXONOMY[result.error] : undefined;
  if (taxonomy !== undefined) return compose(taxonomy, detail);

  const reason = typeof result.terminal_reason === "string" ? result.terminal_reason : undefined;
  const named = reason !== undefined ? NAMED_TERMINAL_CODE[reason] : undefined;
  if (named !== undefined) return compose(named, detail);

  const status = result.api_error_status;
  if (typeof status === "number" && Number.isFinite(status)) return compose(codeForHttpStatus(status), detail);

  if (reason === "structured_output_retry_exhausted") return compose("structured_output_exhausted", detail);
  // The runtime's own overflow spelling is `prompt_too_long` (above, since WS-23). This older
  // spelling has never had a wire producer; it keeps its class so a frame carrying it is not
  // misread as `unknown_error`.
  if (reason === "context_overflow") return compose("context_overflow", detail);
  if (reason === "api_error") {
    if (isCapabilityRefusal(result.result)) return { code: "bad_request", message: detail === undefined ? CAPABILITY_REFUSAL_MESSAGE : `${CAPABILITY_REFUSAL_MESSAGE}: ${detail}` };
    // A credential-resolution failure specifically (see the marker doc comment above) is an `auth`
    // problem, not a `server` one — checked BEFORE the runtime's own class (it arrives wrapped as
    // `provider request failed (network): …`), so the stored record reads as the credential it is.
    if (isCredentialResolutionFailure(result.result)) return compose("auth", detail);
    // Agent SDK 0.0.49: a status-less provider failure (a mid-stream error frame, a stall, a timeout)
    // is classed by the runtime itself, and that class rides the failure prefix. Read it, so a request
    // the provider REFUSED mid-stream (an exhausted credit balance) is never shown as "unavailable or
    // overloaded" and never fed to a consumer as a transient server failure. A billing frame is
    // `billing`, as its HTTP 402 is up front. No prefix (a pre-request resolution failure, an unknown
    // model) or a class this table does not know keeps the `server` reading it always had.
    if (isBillingStreamFrame(result.result)) return compose("billing", detail);
    const runtimeClass = runtimeFailureClass(result.result);
    const byRuntime = runtimeClass !== undefined && Object.hasOwn(RUNTIME_CLASS_CODE, runtimeClass) ? RUNTIME_CLASS_CODE[runtimeClass] : undefined;
    return compose(byRuntime ?? "server", detail);
  }

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
