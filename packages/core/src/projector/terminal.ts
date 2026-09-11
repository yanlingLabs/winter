import type { ProjectedEvent } from "./types";
import type { ResultFrame } from "./conversation";

/**
 * The terminal `result` → `turn_completed` (and, on an error, `agent_error` FIRST).
 *
 * ── ONE RESULT → ONE EMISSION SET, NEVER EITHER/OR ──────────────────────────────────────────────
 *
 * The engine emits BOTH `agent_error` AND `turn_completed(stopReason:"error")` for a failed turn,
 * in that order (`agent/engine.ts:2905-2906`), and the golden streams pin it. A projector written
 * as "either a `turn_completed` or an `agent_error`" reads plausibly and fails the replay: the
 * phone's transcript shows the error row, and `turn_completed` is what ends the spinner. So the
 * rule is "exactly one terminal EVENT SET per turn", and `agent_error` is part of the set.
 *
 * A SECOND `result` with no intervening turn is a protocol violation (§4.9: exactly one per user
 * envelope). It is logged and dropped — never projected — by the caller in `index.ts`.
 */

/**
 * ── `contextTokens`, and the one place this projector deliberately reports LESS than the engine ──
 *
 * Winter does not put per-round usage on the wire. The normalized `message_start` stream event
 * carries `{type, id?, model?}` only — the runtime consumes the provider's `usage` internally and
 * does not forward it (read out of `dist/winter`, not inferred) — and the surface map records that
 * Winter deliberately omits the main-loop `usage` block from `result` (§4.8). The ONLY usage a host
 * ever sees is `result.modelUsage`, which is (a) present only for a PRICED catalog row and (b) a
 * per-session CUMULATIVE ledger, not a per-turn figure.
 *
 * So:
 *  - `inputTokens` / `outputTokens` = this turn's DELTA against the previous result's totals. Exact.
 *  - `contextTokens` — the engine's definition is "the largest single round's input"
 *    (`engine.ts:2693-2696`, `Math.max` over rounds), which the wire cannot reconstruct. On a
 *    ONE-ROUND turn the delta IS that figure exactly, so it is reported. On a multi-round turn the
 *    delta is the SUM of rounds, which over-states the context by a factor of the round count —
 *    and the consumer (`engine.ts:1689`'s auto-compaction trigger) scans backwards for the last
 *    `turn_completed` with `contextTokens > 0`, so a fabricated high figure would compact
 *    prematurely and repeatedly, losing context on purpose. `contextTokens` is therefore OMITTED
 *    rather than guessed, and the trigger falls back to the last exact reading; the overflow-driven
 *    compaction path remains the backstop. **This is a stated fidelity gap, not an oversight, and
 *    the SDK 0.0.4 carry that closes it is: expose per-round input usage on the wire (or a
 *    `context_used` field on `result`).**
 *  - No `modelUsage` at all (an unpriced row — the measured case for every `winter-test/*` double)
 *    → zeros and no `contextTokens`. Nothing is fabricated.
 */
export interface UsageTotals { input: number; output: number }

interface LedgerRow { inputTokens?: unknown; outputTokens?: unknown; cacheReadInputTokens?: unknown; cacheCreationInputTokens?: unknown }

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);

/** Sum the cumulative ledger across every model row. Input counts cache reads and cache writes:
 *  they are context the provider charged for on the way in, and leaving them out would under-report
 *  a cached conversation by most of its size. */
export function totalsOf(result: ResultFrame): UsageTotals | undefined {
  const usage = (result as { modelUsage?: unknown }).modelUsage;
  if (typeof usage !== "object" || usage === null) return undefined;
  let input = 0;
  let output = 0;
  for (const row of Object.values(usage as Record<string, LedgerRow>)) {
    if (typeof row !== "object" || row === null) continue;
    input += num(row.inputTokens) + num(row.cacheReadInputTokens) + num(row.cacheCreationInputTokens);
    output += num(row.outputTokens);
  }
  return { input, output };
}

export interface TerminalInput {
  result: ResultFrame;
  sessionId: string;
  threadId: string;
  /** Cumulative totals after the PREVIOUS result, or undefined if this is the first. */
  previous: UsageTotals | undefined;
  /** How many `assistant` frames this turn produced — 1 makes `contextTokens` exact. */
  rounds: number;
}

export interface TerminalOutput { events: ProjectedEvent[]; totals: UsageTotals | undefined; stopReason: "end_turn" | "aborted" | "error" }

/**
 * `interrupted: true` rides the result's index signature and is what `dist/winter` emits for an
 * interrupted turn: `{type:"result", subtype:"success", is_error:false, interrupted:true, …}`. It is
 * checked BEFORE `is_error` so ruling P8b-24 holds off the wire alone — an interrupt is a turn
 * boundary, never an `agent_error` — with no host-side "I called interrupt" flag to keep in sync.
 */
export function projectTerminal(input: TerminalInput): TerminalOutput {
  const { result, sessionId, threadId, previous, rounds } = input;
  const totals = totalsOf(result);
  const inputTokens = totals === undefined ? 0 : Math.max(0, totals.input - (previous?.input ?? 0));
  const outputTokens = totals === undefined ? 0 : Math.max(0, totals.output - (previous?.output ?? 0));
  const contextTokens = totals !== undefined && rounds <= 1 && inputTokens > 0 ? { contextTokens: inputTokens } : {};

  const interrupted = (result as { interrupted?: unknown }).interrupted === true;
  const isError = !interrupted && (result.is_error === true || (typeof result.subtype === "string" && result.subtype.startsWith("error_")));
  const stopReason: "end_turn" | "aborted" | "error" = interrupted ? "aborted" : isError ? "error" : "end_turn";

  const events: ProjectedEvent[] = [];
  if (isError) {
    // Part 1 maps every failed result to ONE generic class. Task 11 refines it per WS-14 §13 using
    // `subtype`, `terminal_reason` and `api_error_status` — which is why those three ride the
    // message here rather than being flattened into prose.
    events.push({
      type: "agent_error", sessionId, threadId,
      message: errorMessage(result),
      code: "result_error",
    });
  }
  events.push({ type: "turn_completed", sessionId, threadId, stopReason, inputTokens, outputTokens, ...contextTokens });
  return { events, totals, stopReason };
}

/**
 * The user-facing error text. `result.result` is the runtime's own message; the subtype is appended
 * only when it adds something the message does not already say. `api_refusal_explanation` and every
 * other provider-authored field is NOT read here — §4.7 marks it display-only and never to be
 * parsed, and nothing opaque may reach a log line.
 */
function errorMessage(result: ResultFrame): string {
  const text = typeof result.result === "string" ? result.result.trim() : "";
  const reason = typeof result.terminal_reason === "string" ? result.terminal_reason : undefined;
  const parts = [text.length > 0 ? text : `the turn ended with ${result.subtype}`];
  if (reason !== undefined && !parts[0]!.includes(reason)) parts.push(`(${reason})`);
  return parts.join(" ");
}
