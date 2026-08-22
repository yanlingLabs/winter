import { OFFICE_COMMAND_ACTIONS } from "@norma/protocol";

// ================================================================================================
// office-agent-tools T1 (task-1-brief.md; design
// docs/superpowers/specs/2026-08-22-office-agent-tools-design.md §1, §2, §6) — the wire and a
// routing shell that refuses every verb, so the bridge is proven end-to-end before a single office
// verb exists.
//
// **Modeled on browser.ts's own deadline/verb-set section, deliberately close.** That file is the
// bridge this one extends (§1: "Stage C does not move either [the daemon/app split]: it reuses the
// bridge the browser tool already established"), and its `BROWSER_DEADLINES_MS` is the precedent
// for sizing a per-verb deadline by what the verb actually waits on rather than picking one round
// number for everything.
//
// **No tool lives here yet.** `sheets`/`slides`/`docs` (later tasks) will register through the
// per-mode tool registry the way `registerBrowserTool` does, validate operands, and dispatch through
// `PanelCommandRegistry.dispatch` exactly as `browser.ts`'s `run` does. This file only ships what
// every one of those tools will need in common: the verb list (re-exported from the protocol, the
// single source of truth), the per-verb deadline, and one small, deliberately narrow args builder.
// ================================================================================================

export { OFFICE_COMMAND_ACTIONS };

export type OfficeCommandAction = (typeof OFFICE_COMMAND_ACTIONS)[number];

/** Each kind's read half — `info` (spec §1: doubles as the drivability probe, exactly as `browser
 *  tabs` does) and `read`. Six verbs: one pair per kind. Derived by filtering
 *  `OFFICE_COMMAND_ACTIONS` rather than hand-listed a second time, so this can never drift from the
 *  protocol's own list.
 *
 *  **Fail-safe today, but fail-safe is not the same as CORRECT, and this split is about to become
 *  load-bearing.** Fix round 1 (review M-3): a suffix this file has never seen defaults to the WRITE
 *  side (it fails `endsWith(".info")`/`endsWith(".read")` and falls into `OFFICE_WRITE_ACTIONS`
 *  below), which is the safe direction — Task 4 hangs the approval flow on `OFFICE_WRITE_ACTIONS`
 *  (spec §5: "an office write is a file write... rides the approval flow"), and an unrecognized verb
 *  wrongly gated as a write merely over-asks for approval, never under-asks. But "wrongly classified,
 *  safely" is still wrong, and Task 4 needs this partition to be RIGHT, not merely safe-by-default.
 *  So the true ground truth is no longer this filter — it is
 *  `office-commands.test.ts`'s literal, hand-spelled `EXPECTED_SIDE` table, naming all 22 verbs one
 *  by one. This filter is what Task 4 actually reads at runtime (kept exactly as it was, per that
 *  review's own instruction: "keep the fail-safe default"); the hand-spelled table is what PROVES
 *  the filter's output is correct, not merely internally consistent with itself. */
export const OFFICE_READ_ACTIONS = OFFICE_COMMAND_ACTIONS.filter(
  (a): a is Extract<OfficeCommandAction, `${string}.info` | `${string}.read`> => (
    a.endsWith(".info") || a.endsWith(".read")
  ),
);

/** Everything that is not a read verb: every verb that mutates the document and saves it immediately
 *  (spec §3 step 4). Derived as the complement of `OFFICE_READ_ACTIONS` for the same
 *  never-drift reason — and the same fail-safe-not-correctness caveat above applies here too, since
 *  this is the array Task 4 will gate the approval flow on. */
export const OFFICE_WRITE_ACTIONS = OFFICE_COMMAND_ACTIONS.filter(
  (a) => !(OFFICE_READ_ACTIONS as readonly string[]).includes(a),
);

/**
 * Per-verb deadlines, in milliseconds — the office half of `BROWSER_DEADLINES_MS`'s job: how long
 * the daemon's pending entry waits for the app's answer before the agent is told nothing is known.
 *
 * **Fix round 1 (review I-1) recomputed both numbers below from scratch — the ORIGINAL numbers
 * (35 000 / 45 000) were unsafe, not merely tight, and here is the failure they invited:** they
 * covered ONE 30s handshake wait and nothing past it. The REAL worst case is a helper that is
 * genuinely starting up (its 3-attempt retry loop, not one attempt) followed by every discrete
 * request the verb then sends, each carrying ITS OWN independent 30s timeout. A deadline sized for
 * only the first of those legs times out on the daemon side WHILE the app is still honestly working
 * — the agent is told "nothing is known", and if it retries a NON-IDEMPOTENT write
 * (`insert_rows`/`append`/`add_slide`, …) the app can complete the FIRST attempt's write after the
 * daemon already gave up on it, so the retry's write lands on top — the document is mutated twice for
 * one agent intent. **Fail-safe direction is therefore GENEROUS, not tight**: a too-long deadline
 * costs the agent latency waiting on a helper that is, worst case, still legitimately trying; a
 * too-short one corrupts a user's document. The numbers below are deliberately large for exactly this
 * reason — see `office-commands.test.ts`'s own deadline-arithmetic test, which recomputes both totals
 * from the same named constants below and fails if either drifts under its real worst case again.
 *
 * **The arithmetic, leg by leg, every constant named and cited:**
 *
 *  1. **The helper spawn/handshake, WITH its retry loop** — not one attempt.
 *     `OfficeHelperSupervisor.Configuration` (`apple/Norma/Sources/AppShell/OfficeHelperSupervisor.swift:399-401`):
 *     `handshakeTimeout: TimeInterval = 30.0` (the bound on ONE attempt — spawn, poll for the socket
 *     file, connect, `hello`/`helloOk`; `attemptOnce`, same file, lines 549-663, and its own
 *     comment at lines 613-620 records the fix that makes the whole attempt — not just the connect —
 *     provably bounded by this number), `maxAttempts: Int = 3`, `backoff: TimeInterval = 0.25`. The
 *     retry loop itself (`start()`, same file, lines 523-544) tries up to `maxAttempts` times with
 *     `backoff` BETWEEN attempts and none after the last one:
 *     `3 × 30.0s + 2 × 0.25s = 90.5s` worst case before the supervisor gives up
 *     (`.helperUnavailable`) — call this **H = 90 500 ms**.
 *  2. **Every subsequent request to an already-ready helper carries its OWN 30s timeout, separate
 *     from H.** `OfficeHelperClient` is constructed with
 *     `requestTimeout: configuration.handshakeTimeout` (same file, line 658), and that file's own
 *     comment (lines 651-656) confirms this covers "every steady-state request this client ever
 *     sends (ping/open/close, not just the boot handshake above)" — call one request's bound
 *     **R = 30 000 ms**.
 *  3. **How many requests a verb actually makes, cold.** Spec §3 step 2's open-or-adopt applies to
 *     EVERY verb, not only `info` — every verb pays for at least one `open`
 *     (`OfficeRuntime.Driver.open`, `apple/Norma/Sources/AppShell/OfficeRuntime.swift:1415`, a real
 *     `async throws` request/reply call, hence R-bounded). A read/info verb then issues its own
 *     query (this file's Task 1 ships no such Driver method yet — task 2+ will add one — but it will
 *     be a second request/reply call riding the SAME `OfficeHelperClient`, hence the SAME R): **2
 *     requests**. A write verb additionally SAVES — `OfficeRuntime.Driver.save`
 *     (`OfficeRuntime.swift:1431`, also `async throws`, also R-bounded) — on top of `open` and its
 *     own edit request (again not yet built, again R-bounded by the same client): **3 requests**,
 *     open + edit + save, not one.
 *
 * **Totals: H + 2R for reads, H + 3R for writes**, plus a flat ~4.5s margin for everything the
 * arithmetic above does not itemize (the emit, the socket, the hub fan-out, the app's own
 * scheduling, the result's encode and its trip home — the same category `BROWSER_WAIT_MAX_TIMEOUT_MS`
 * reserves headroom for, in `browser.ts`):
 *
 *   read:  90 500 + 2×30 000 = 150 500 ms  → **155 000 ms** (155s)
 *   write: 90 500 + 3×30 000 = 180 500 ms  → **185 000 ms** (185s)
 *
 * **In the common case these numbers are never approached** — a helper that is already running and a
 * document that is already open answer in a small fraction of either bound; both are WORST-CASE
 * ceilings for a cold start, not the expected latency of an ordinary call. They are deliberately far
 * larger than any browser deadline (`BROWSER_DEADLINES_MS`'s ceiling is 30s): a browser command waits
 * on CDP, already running in an always-live renderer process; an office command may have to bring an
 * entire LibreOfficeKit process up from nothing, retry that boot up to three times, and then pay for
 * up to three more independently-timed requests — categorically heavier, and the two are not
 * comparable numbers.
 *
 * **These numbers are still UNEXERCISED by this task's own behaviour, and that remains by design.**
 * T1's `OfficeCommandConsumer` answers every verb SYNCHRONOUSLY with a refusal — no verb here ever
 * waits long enough for either deadline to matter yet. A later task that discovers these are wrong
 * for a REAL run should change the two constants below (and the arithmetic in this comment, in the
 * same change) rather than invent a 23rd per-verb number — the read/write REQUEST-COUNT split is the
 * fact that varies; the handshake cost (H) and the per-request cost (R) do not.
 *
 * Not settings, for the same reason `BROWSER_DEADLINES_MS` gives: nothing here is a knob a user would
 * turn.
 */
export const OFFICE_READ_DEADLINE_MS = 155_000;
export const OFFICE_WRITE_DEADLINE_MS = 185_000;

function deadlinesFor<A extends readonly OfficeCommandAction[]>(
  actions: A, ms: number,
): Record<A[number], number> {
  const out = {} as Record<A[number], number>;
  for (const a of actions) out[a as A[number]] = ms;
  return out;
}

/** Every `OFFICE_COMMAND_ACTIONS` value maps to exactly one of the two deadlines above. Composed
 *  from the two partitioned arrays rather than hand-typed as 22 literal entries — `browser.ts`'s own
 *  `BROWSER_DEADLINES_MS` hand-types nine because each of those nine has an INDEPENDENTLY reasoned
 *  number; these 22 do not, they have exactly two, so hand-typing here would be twenty duplicate
 *  lines with nothing left to say that the read/write split above hasn't already said.
 *  `office-commands.test.ts` carries the EXACT-EQUALITY tripwire against `OFFICE_COMMAND_ACTIONS` —
 *  the task brief's own words, "the identical exact-equality tripwire" the browser suite has. */
export const OFFICE_DEADLINES_MS: Record<OfficeCommandAction, number> = {
  ...deadlinesFor(OFFICE_READ_ACTIONS, OFFICE_READ_DEADLINE_MS),
  ...deadlinesFor(OFFICE_WRITE_ACTIONS, OFFICE_WRITE_DEADLINE_MS),
};

/**
 * Build `panel_command.args` for an office command. Every verb takes an absolute `path` (spec §2's
 * preamble) — the one field every future per-verb builder will share — so this function owns exactly
 * that field, plus whatever ADDITIONAL fields the caller names explicitly.
 *
 * **Deliberately narrow, and deliberately not the place a per-verb operand schema lives.** Spec §2's
 * tables give `sheets`/`slides`/`docs` genuinely different operand shapes per verb (`range` and
 * `values`/`formulas` for `sheets.set`, `{title?, body?}` for `slides.set_text`, `find`/`replaceWith`
 * for `docs.replace`, …) that no task has built a real, validated schema for yet. A speculative
 * per-verb builder written now would be guessing at shapes task 2/3/4 are the ones meant to design —
 * exactly the shape of premature commitment `browser.ts`'s own `commandArgs` avoids by building each
 * verb's payload from ALREADY-PARSED, zod-validated operands, never from a caller's raw bag. This
 * function keeps that same discipline at the one field it can honestly own today: `path` is fixed
 * here and CANNOT be overridden by `fields` (a `fields.path` is silently dropped, not merged over) —
 * the one invariant every office verb shares belongs in the one place every future caller reaches,
 * not repeated by each of them.
 *
 * `fields` is intentionally typed to primitives only (no nested objects/arrays): the moment a verb
 * needs a richer shape — `sheets.set`'s `values`/`formulas` grid, for one — that verb's own task
 * should give it a dedicated, typed builder rather than stretch this generic one to fit.
 */
export function officeCommandArgs(
  path: string,
  fields?: Readonly<Record<string, string | number | boolean>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { path };
  if (fields) {
    for (const key of Object.keys(fields)) {
      if (key === "path") continue;
      out[key] = fields[key];
    }
  }
  return out;
}
