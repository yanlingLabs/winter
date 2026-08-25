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
 * **Fix round 1 (review I-1) recomputed both numbers below from scratch** — the ORIGINAL numbers
 * (35 000 / 45 000) covered ONE 30s handshake wait and nothing past it, which is unsafe rather than
 * merely tight (a too-short deadline reports "timed out" while the app is still honestly working; if
 * the agent retries a NON-IDEMPOTENT write — `insert_rows`/`append`/`add_slide`, … — on that false
 * signal, the first attempt's write can land AFTER the daemon gave up on it, so the retry's write
 * lands on top and the document is mutated twice for one agent intent).
 *
 * **Fix round 2 (review, a second Important) went further: named legs are not the WHOLE worst case,
 * and this comment must say what it does and does not cover, plainly, rather than imply a guarantee
 * the numbers cannot back.** What follows is split into the part that is COUNTED (§A) and the part
 * that is NOT (§B) — §B is not smaller than §A, and no fixed number bounds it.
 *
 * ## §A — what H + nR actually counts, every constant named and cited
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
 * **§A's totals: H + 2R for reads, H + 3R for writes**, plus a flat ~4.5s margin for
 * emit/socket/fan-out/scheduling/encode overhead (the category `BROWSER_WAIT_MAX_TIMEOUT_MS` reserves
 * headroom for, in `browser.ts` — explicitly NOT file I/O; §B below is a different category entirely):
 *
 *   read:  90 500 + 2×30 000 = 150 500 ms  → **155 000 ms** (155s)
 *   write: 90 500 + 3×30 000 = 180 500 ms  → **185 000 ms** (185s)
 *
 * ## §B — what sits OUTSIDE every term above, named rather than estimated
 *
 * Three real legs of the true worst case have no named term in §A, and none of them is bounded by
 * `handshakeTimeout`, `requestTimeout`, or anything else this file could multiply into R:
 *
 *  - **`stageDocument`** (`OfficeRuntime.swift:2827`, called at `:2323`) copies the real document
 *    INTO the helper's jail BEFORE `driver.open` is even called (`:2325`, one line later) — every
 *    verb pays this, not only writes. Its own header names the cost precisely: `copyfile(3)` with
 *    `COPYFILE_CLONE` is an instant copy-on-write clone when source and destination share an APFS
 *    volume (the common case), but "transparently falls back to an ordinary full byte copy otherwise
 *    (a different volume, an external drive, a network share, a filesystem without clone support)" —
 *    at that point the cost is real disk I/O scaling with document size, on hardware this code does
 *    not control.
 *  - **`placeAtomically`** (`OfficeRuntime.swift:2741`, called at `:2435`) runs AFTER `driver.save`
 *    returns (`:2402`) and BEFORE the save waiters resolve (`resumeSaveWaiters(.saved)`, `:2483`) —
 *    write-only, but on the hot path of every write. Its copy (`:2747`) is plain `FileManager.copyItem`,
 *    not `stageDocument`'s own explicit `copyfile(3)` + `COPYFILE_CLONE` call (`:2837`); this file does
 *    not assert whether Foundation's `copyItem` clones on its own where `stageDocument` has to ask for
 *    it by name, so treat that part as unverified rather than "never." What IS certain regardless: the
 *    source (`tempPath`, the helper's own save output) and destination (`path`, the user's document)
 *    share a volume only when the document happens to live on the same one as the helper's state dir —
 *    the identical common-case-vs-external-drive-or-network-share split `stageDocument` names above —
 *    and `clonefile(2)` cannot cross volumes at all, so a cross-volume place is a full byte copy under
 *    either reading. The `fsync` and `rename(2)` after it are always real I/O either way.
 *  - **`OfficeHelperRequestQueue`** (`OfficeRuntime.swift:3449-3469`, the ONE instance at
 *    `ShellSessionHost.swift:799`) is an app-wide FIFO — literally one `tail: Task` every Driver call
 *    chains behind, across EVERY open document and EVERY session, not scoped to the verb's own
 *    document. A verb's whole H + nR budget does not even START until every call enqueued ahead of it
 *    (from a completely unrelated document, in a completely unrelated session) has finished. Nothing
 *    in this file, or in the supervisor, bounds how long that queue is at the moment a new verb
 *    enqueues behind it.
 *
 * All three scale with facts this constant cannot see at define time (document size, storage
 * hardware, how many other office verbs happen to be in flight) — which is exactly why §B has no
 * number: bounding the unboundable would be inventing a number, not deriving one, and the fail-safe
 * direction from fix round 1 (generous, not tight) does not license that — a generous GUESS is still
 * a guess.
 *
 * ## What this makes true, and what a caller must therefore do
 *
 * **`OFFICE_READ_DEADLINE_MS`/`OFFICE_WRITE_DEADLINE_MS` are a PRACTICAL bound, not a proof.** They
 * are sized to comfortably outlast §A's real, countable worst case (with the 4.5s margin), and in the
 * overwhelming common case — helper already running, document already open, local SSD, nothing else
 * queued — they outlast §B too, by a wide margin. But §B is real and unbounded, so a deadline expiry
 * is not evidence the verb failed, or even that it is still running slowly; it is evidence of exactly
 * one thing, which `PanelCommandOutcome`'s own `timeout` kind already exists to say honestly
 * (`packages/core/src/panel/commands.ts`): **nothing is known**. Never "did not happen" — the write
 * may have landed on disk after the daemon stopped waiting for the app's answer, precisely because
 * §B's legs can outlast even a generous §A-plus-margin bound.
 *
 * **The durable protection this fact demands does not live in these two numbers, and cannot — no
 * finite deadline turns an unbounded tail into a bounded one.** It lives downstream, at whichever
 * layer decides whether to retry a timed-out write: a non-idempotent office write
 * (`insert_rows`/`append`/`add_slide`/… — anything in `OFFICE_WRITE_ACTIONS`) must never be
 * blind-retried on a bare timeout, because the ORIGINAL attempt may still complete after the retry is
 * sent, and the ORDER those two writes land in is not controlled by anything here. The coordinator is
 * carrying this as a hard requirement into the broker task and the write-verb task; this comment
 * exists so whoever builds either finds the contract stated here rather than re-deriving this whole
 * analysis from scratch. See the two constants' own trailing comments below for the one-line version
 * of this same pointer, placed where a reader reaching for a deadline value will actually see it.
 *
 * They are deliberately far larger than any browser deadline (`BROWSER_DEADLINES_MS`'s ceiling is
 * 30s) for the §A reason alone, before §B is even considered: a browser command waits on CDP, already
 * running in an always-live renderer process; an office command may have to bring an entire
 * LibreOfficeKit process up from nothing, retry that boot up to three times, and then pay for up to
 * three more independently-timed requests — categorically heavier, and the two are not comparable
 * numbers.
 *
 * **These numbers are still UNEXERCISED by this task's own behaviour, and that remains by design.**
 * T1's `OfficeCommandConsumer` answers every verb SYNCHRONOUSLY with a refusal — no verb here ever
 * waits long enough for either deadline, or §B's uncounted legs, to matter yet. A later task that
 * discovers §A's numbers are wrong for a REAL run should change the two constants below (and the
 * arithmetic in this comment, in the same change) rather than invent a 23rd per-verb number — the
 * read/write REQUEST-COUNT split is the fact that varies within §A; H and R do not, and §B is not a
 * number to begin with.
 *
 * Not settings, for the same reason `BROWSER_DEADLINES_MS` gives: nothing here is a knob a user would
 * turn.
 */
// A timeout on either of these is OUTCOME UNKNOWN, never "did not happen" (see §B above) — a
// non-idempotent write (anything in OFFICE_WRITE_ACTIONS) must NEVER be blind-retried on one.
export const OFFICE_READ_DEADLINE_MS = 155_000;
// Same caveat as OFFICE_READ_DEADLINE_MS above: a practical bound, not a proof — §B's uncounted legs
// (stageDocument, placeAtomically, the shared OfficeHelperRequestQueue) can outlast it. The retry
// discipline this demands belongs to the broker/write-verb tasks, not to this constant.
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

/**
 * office-agent-tools T4 — `sheets set`'s own dedicated, typed builder, exactly the shape this file's
 * own header above says a richer verb should get rather than stretching `officeCommandArgs`'s
 * primitives-only contract to fit. `values` is `sheets.ts`'s own already-zod-validated grid
 * (non-empty, rectangular, cell-count-capped) — carried here as a nested row-major array of JSON
 * primitives, never flattened or stringified: `panel_command.args` is `z.record(z.string(),
 * z.unknown())` at the wire layer (`events.ts`), so a nested array is exactly as legal as any other
 * field here, bounded by the SAME `PANEL_COMMAND_ARGS_MAX_JSON_BYTES` cap every `panel_command` pays
 * (checked by `sheets.ts` itself before ever calling this, via `sheetsSetMaxCells` — a cell-count
 * ceiling sized to keep the serialized form comfortably under that byte cap, not a byte count this
 * function re-derives). The app (`OfficeCommandConsumer`) is where the grid's real A1 dimensions get
 * checked against `range` and where each cell becomes a `(address, value)` pair for LOK — this
 * function's only job is shaping the wire payload, not validating it a second time.
 */
export function officeSheetsSetArgs(
  path: string,
  sheet: string,
  range: string,
  values: ReadonlyArray<ReadonlyArray<string | number | boolean>>,
): Record<string, unknown> {
  return { path, sheet, range, values };
}
