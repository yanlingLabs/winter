import type { ProjectedEvent } from "./types";
import type { ResultFrame } from "./conversation";
import { classifyResult } from "./errors";

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
 *    (`Math.max` over rounds), which the wire cannot reconstruct. On a ONE-ROUND turn the delta IS
 *    that figure exactly, so it is reported; on a multi-round turn the delta is the SUM of rounds,
 *    which over-states the context by a factor of the round count, so the field is OMITTED rather
 *    than guessed. **This is a stated fidelity gap, not an oversight**, and the SDK carry that closes
 *    it is: expose per-round input usage on the wire (or a `context_used` field on `result`).
 *
 *    **WHO READS IT TODAY** (corrected 2026-09-18, whole-branch review N2 — this block used to cite an
 *    auto-compaction trigger that scanned back for the last positive reading, and no such consumer
 *    exists any more): NOTHING in the daemon. The Winter leg's child compacts itself, and
 *    `session.compact` answers `not_supported_on_winter_leg`; the only reader of the field in either
 *    language is `apple/WinterKit`'s own probe binary. So an omitted figure costs a diagnostic, not a
 *    behaviour — which is why the 0.0.17 rules below can afford to omit it as widely as they do, and
 *    why the case for getting it RIGHT is honesty rather than harm avoidance.
 *  - No `modelUsage` at all (an unpriced row — the measured case for every `winter-test/*` double)
 *    → zeros and no `contextTokens`. Nothing is fabricated.
 *
 * ── AGENT SDK 0.0.17 (P-B1): THE LEDGER IS NO LONGER THE MAIN LOOP'S ────────────────────────────
 *
 * Two changes in that release break both halves of the old reading, and they arrive together:
 *
 *  1. **the main row's KEY is the qualified `provider/model` catalog key**, not the string the host
 *     passed. The daemon passes the BARE modelId (`mode-options.ts`'s WS-20 spawn boundary) while
 *     `system/init.model` echoes that same bare string, so the old `model === init.model` equality
 *     MISSED ON EVERY WINTER-LEG SESSION — and the old fallback then SUMMED every row.
 *     `init.winter_provider.modelKey` is the row key verbatim (the child emits it beside `model`),
 *     which is why `MainModelKey` carries both and why the key is tried first.
 *  2. **the ledger carries more rows than the main loop's**: subagent spend is priced and rolled up
 *     at every depth, and the web tools' inner passes land there too (`WebSearch`'s pass runs on the
 *     SESSION'S OWN model, so it lands on the MAIN row; `WebFetch`'s digest lands on its own row when
 *     a `digestModel` is stated, and on the main row when it is not).
 *
 * So summing stopped being a degradation and became a WRONG ANSWER: a figure labelled "this
 * conversation's context" that silently carries a subagent's whole run and every inner web pass. Hence
 * `mainExact` below — and hence `sawSharedRowActivity`, because a MATCH alone is not enough: a child on
 * the inherited model and `WebSearch`'s inner pass both accrue into the very row this figure reads.
 *
 * **HOW OFTEN THAT OMITS, stated rather than discovered later** (review N2): `sawSharedRowActivity` is
 * set by ANY `WebFetch`/`WebSearch`/spawn tool-use block, ANY `system/task_*` frame, or a background
 * child still open at the terminal — and the window is terminal-to-terminal, so an interrupt's trailing
 * `task_notification` carries into the next turn as well. A web-heavy or subagent-heavy code turn
 * therefore reports no `contextTokens` at all, essentially always. With no consumer in the daemon (see
 * above) that is a diagnostic going quiet, not a regression; the alternative was a number nobody could
 * trust.
 *
 * `inputTokens`/`outputTokens` DELIBERATELY still sum every row (decision, P-B1 item 4): they are
 * what the turn SPENT, and from 0.0.17 on a subagent's and an inner pass's generations are real
 * spend the root is charged for. The root's `total_cost_usd`/`modelUsage` already cover the whole
 * agent tree, so nothing may add a child's usage on top of them (nothing in this daemon does — no
 * `task_notification` carries usage at all; its only field is `content`).
 */
export interface UsageTotals {
  /** Every row's input (base + cache read + cache creation) — what the turn cost going in. */
  input: number;
  /** Every row's output. */
  output: number;
  /**
   * The SESSION'S CANONICAL MODEL row's input only (m6, review r1).
   *
   * `contextTokens` answers "how full is this conversation's context", which is a fact about the
   * main loop's model and nothing else. Winter's ledger is keyed by model and §4.2 says auxiliary
   * calls (compaction summariser, classifier, advisor, `countTokens`) emit no stream events — which
   * says nothing about whether they accrue into `modelUsage`. Summing every row would therefore let
   * an auxiliary call inflate a figure labelled EXACT. Keying to the session's own model row closes
   * that without needing to prove what the ledger does.
   *
   * `0` when no row could be identified as the session's own (`mainExact: false`) — never the sum,
   * which is the 0.0.17 failure this field's doc block above describes.
   */
  main: number;
  /**
   * Is `main` THE SESSION'S OWN ROW (or, with no model known at all, the whole ledger)?
   *
   * `false` means "rows exist and none of them is identifiably this session's" — the honest
   * degradation, and the one state in which `contextTokens` is omitted rather than guessed. It also
   * fences the DELTA: a `previous` that was inexact carries `main: 0`, so a delta taken against it
   * would report this turn's whole cumulative row as one turn's context. `projectTerminal` therefore
   * requires BOTH ends exact, which self-heals on the following turn.
   */
  mainExact: boolean;
}

/**
 * How to find the session's own row, from `system/init` (and re-derived on `system/model_switch`).
 *
 * `key` is `init.winter_provider.modelKey ?? init.model`; `modelId` is `init.model` verbatim. With
 * NEITHER (no `system/init` seen at all — every raw-stream replay harness) `main` falls back to the
 * whole ledger and stays `mainExact: true`: there is no model to be wrong about, and this is the
 * pre-0.0.17 behaviour for that case, kept deliberately.
 */
export interface MainModelKey {
  key?: string;
  modelId?: string;
}

/**
 * Tool calls whose OWN model pass can land on the session's main ledger row (0.0.17, P-B1 item 3).
 *
 * `WebSearch` runs its inner pass on the SESSION'S OWN model, always — so its tokens are on the main
 * row by construction. `WebFetch`'s digest runs on `Options.web.fetch.digestModel` when the host
 * states one (its own row) and on the session's model when it does not, and the projector cannot see
 * which — so it counts too. Both names are the same on both legs (the Winter runtime copied claude's
 * own tool names); the host spellings ride along because `renameTool` has already mapped a Winter
 * name by the time a transcript reads it and a future caller may hand either one over.
 *
 * Subagent spawns are NOT here: `isSpawnTool` (`children.ts`) is the one owner of that question.
 */
const MAIN_ROW_SHARING_TOOLS: ReadonlySet<string> = new Set(["WebSearch", "WebFetch", "web_search", "web_fetch"]);

export const sharesMainLedgerRow = (toolName: string): boolean => MAIN_ROW_SHARING_TOOLS.has(toolName);

interface LedgerRow { inputTokens?: unknown; outputTokens?: unknown; cacheReadInputTokens?: unknown; cacheCreationInputTokens?: unknown }

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);

const rowInputOf = (row: LedgerRow): number =>
  num(row.inputTokens) + num(row.cacheReadInputTokens) + num(row.cacheCreationInputTokens);

/**
 * Which ledger key is the session's own row, or `undefined` when none can be named.
 *
 * Two rungs and no third:
 *  1. the KEY, exactly (`init.winter_provider.modelKey`, which the child guarantees equals the row
 *     key; or `init.model` on a leg that sends no `winter_provider` — the official leg);
 *  2. the UNIQUE row whose key ends with `/${modelId}` — the qualified key for the bare id the
 *     daemon passed. **Unique, not first:** two providers can serve the same model id, and picking
 *     one of two candidates would be a guess presented as an exact reading.
 *
 * **THE OFFICIAL LEG IS UNMEASURED** (review N3 — an earlier version of this comment asserted its
 * behaviour was "unchanged", on a premise nobody has checked). No official-leg `modelUsage` frame
 * exists anywhere in this repository's fixtures: every one of them is keyed `winter-test/echo`. What
 * IS structural is that claude's row keys carry no `/`, so rung 2 can never fire there — the answer is
 * rung 1 or nothing. If `init.model` is an ALIAS while the rows are keyed by the dated id, this
 * reports `mainExact: false` and OMITS `contextTokens` where the pre-0.0.17 code reported an inflated
 * whole-ledger sum. Omitting an unknown is the right direction, and with no consumer (see the block
 * above) it costs nothing; a real captured frame is what would let anyone claim more than that.
 */
function mainRowKeyOf(keys: readonly string[], key: string | undefined, modelId: string | undefined): string | undefined {
  if (key !== undefined && keys.includes(key)) return key;
  if (modelId === undefined || modelId.length === 0) return undefined;
  const suffix = `/${modelId}`;
  const candidates = keys.filter((k) => k.endsWith(suffix));
  return candidates.length === 1 ? candidates[0] : undefined;
}

/** Sum the cumulative ledger across every model row. Input counts cache reads and cache writes:
 *  they are context the provider charged for on the way in, and leaving them out would under-report
 *  a cached conversation by most of its size. */
export function totalsOf(result: ResultFrame, main?: MainModelKey): UsageTotals | undefined {
  const usage = (result as { modelUsage?: unknown }).modelUsage;
  if (typeof usage !== "object" || usage === null) return undefined;
  const rows = Object.entries(usage as Record<string, LedgerRow>).filter(
    (entry): entry is [string, LedgerRow] => typeof entry[1] === "object" && entry[1] !== null,
  );
  let input = 0;
  let output = 0;
  for (const [, row] of rows) {
    input += rowInputOf(row);
    output += num(row.outputTokens);
  }
  const key = main?.key;
  const modelId = main?.modelId;
  // No model known at all → the whole ledger, as before this release (see `MainModelKey`).
  if (key === undefined && (modelId === undefined || modelId.length === 0)) return { input, output, main: input, mainExact: true };
  const mainKey = mainRowKeyOf(rows.map(([k]) => k), key, modelId);
  if (mainKey === undefined) return { input, output, main: 0, mainExact: false };
  const mainRow = rows.find(([k]) => k === mainKey)![1];
  return { input, output, main: rowInputOf(mainRow), mainExact: true };
}

export interface TerminalInput {
  result: ResultFrame;
  sessionId: string;
  threadId: string;
  /** Cumulative totals after the PREVIOUS result, or undefined if this is the first. */
  previous: UsageTotals | undefined;
  /** How many `assistant` frames this turn produced — exactly 1 makes `contextTokens` exact. */
  rounds: number;
  /** How to find the session's own ledger row (`MainModelKey`), when a `system/init` has been seen. */
  mainModel?: MainModelKey;
  /**
   * 0.0.17 (P-B1 item 3): did anything OTHER than the main loop accrue into the main row since the
   * previous terminal — a subagent (at any depth, foreground or background), or a `WebSearch` /
   * `WebFetch` call whose inner pass may run on the session's own model?
   *
   * A child on the INHERITED model shares the main row, and `WebSearch`'s inner pass always does, so
   * a matched row is not by itself an exact context reading. This flag is the other half of that
   * test, and it is deliberately coarse: the honest answer is "not exact", and `contextTokens` is
   * omitted rather than reported with a child's spend folded in.
   *
   * Absent reads as `false` — the pre-0.0.17 shape for every existing caller and fixture, none of
   * which spawns or searches.
   */
  sawSharedRowActivity?: boolean;
}

export interface TerminalOutput { events: ProjectedEvent[]; totals: UsageTotals | undefined; stopReason: "end_turn" | "aborted" | "error" }

/**
 * `interrupted: true` rides the result's index signature and is what `dist/winter` emits for an
 * interrupted turn: `{type:"result", subtype:"success", is_error:false, interrupted:true, …}`. It is
 * checked BEFORE `is_error` so ruling P8b-24 holds off the wire alone — an interrupt is a turn
 * boundary, never an `agent_error` — with no host-side "I called interrupt" flag to keep in sync.
 */
export function projectTerminal(input: TerminalInput): TerminalOutput {
  const { result, sessionId, threadId, previous, rounds, mainModel } = input;
  const totals = totalsOf(result, mainModel);
  const inputTokens = totals === undefined ? 0 : Math.max(0, totals.input - (previous?.input ?? 0));
  const outputTokens = totals === undefined ? 0 : Math.max(0, totals.output - (previous?.output ?? 0));
  // `rounds === 1`, not `<= 1` (m8, review r1): a `result` with priced usage but NO assistant frame
  // at all has zero observed rounds, and calling that "one round, therefore exact" states a
  // measurement nobody made. Exactly one round is the only shape where the delta IS the round.
  const mainDelta = totals === undefined ? 0 : Math.max(0, totals.main - (previous?.main ?? 0));
  // 0.0.17 (P-B1): BOTH ends of the delta must be the session's own row, and nothing else may have
  // spent on it in this window — see `UsageTotals.mainExact` and `sawSharedRowActivity`.
  const mainExact = totals !== undefined && totals.mainExact && (previous === undefined || previous.mainExact);
  const contextTokens = mainExact && rounds === 1 && mainDelta > 0 && input.sawSharedRowActivity !== true
    ? { contextTokens: mainDelta }
    : {};

  const interrupted = (result as { interrupted?: unknown }).interrupted === true;
  const isError = !interrupted && (result.is_error === true || (typeof result.subtype === "string" && result.subtype.startsWith("error_")));
  const stopReason: "end_turn" | "aborted" | "error" = interrupted ? "aborted" : isError ? "error" : "end_turn";

  const events: ProjectedEvent[] = [];
  if (isError) {
    // ONE DISTINCT CODE PER CLASS (digest item 20 / WS-14 §13) — `errors.ts` reads `subtype`,
    // `terminal_reason`, `api_error_status` and the 11-member provider taxonomy, in that order of
    // specificity, and composes a message that can never carry opaque provider state.
    const classified = classifyResult(result);
    events.push({ type: "agent_error", sessionId, threadId, message: classified.message, code: classified.code });
  }
  events.push({ type: "turn_completed", sessionId, threadId, stopReason, inputTokens, outputTokens, ...contextTokens });
  return { events, totals, stopReason };
}
