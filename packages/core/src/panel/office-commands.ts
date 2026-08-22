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
 *  protocol's own list — `office-commands.test.ts` pins the filter's result against a hand-spelled
 *  expectation once, which is what makes that derivation trustworthy rather than merely convenient. */
export const OFFICE_READ_ACTIONS = OFFICE_COMMAND_ACTIONS.filter(
  (a): a is Extract<OfficeCommandAction, `${string}.info` | `${string}.read`> => (
    a.endsWith(".info") || a.endsWith(".read")
  ),
);

/** Everything that is not a read verb: every verb that mutates the document and saves it immediately
 *  (spec §3 step 4). Derived as the complement of `OFFICE_READ_ACTIONS` for the same
 *  never-drift reason. */
export const OFFICE_WRITE_ACTIONS = OFFICE_COMMAND_ACTIONS.filter(
  (a) => !(OFFICE_READ_ACTIONS as readonly string[]).includes(a),
);

/**
 * Per-verb deadlines, in milliseconds — the office half of `BROWSER_DEADLINES_MS`'s job: how long
 * the daemon's pending entry waits for the app's answer before the agent is told nothing is known.
 *
 * **Two values, not twenty-two**, because every office verb's cost breaks down the same way (spec §3
 * steps 1-4) and only ONE step differs between the read and write halves:
 *
 *  - every verb may pay for a COLD OFFICE HELPER — `OfficeHelperSupervisor.Config.handshakeTimeout`
 *    (`apple/Norma/Sources/AppShell/OfficeHelperSupervisor.swift`) is **30 000 ms**, and spec §3
 *    step 2's open-or-adopt applies to every verb, not only `info` — a `read` on a document nobody
 *    has opened yet pays the identical cold-start cost. Both deadlines below MUST clear that number
 *    with real margin, or a verb that is genuinely still starting up would be told "timed out" for
 *    work that was honestly in progress (`office-commands.test.ts` pins this against the real
 *    constant, not a guess at it);
 *  - every verb may then pay for a COLD DOCUMENT OPEN through LibreOfficeKit, on top of the helper
 *    handshake — real work on a real (possibly large) file;
 *  - **only the write half also pays for a SAVE** — helper-side render to a temp file under the
 *    fence, then an atomic place onto the real path (Stage B's save path, spec §3 step 4: "an agent
 *    edit is never left unsaved in memory"). That is the one cost `read`/`info` never carry, and it
 *    is what earns writes a longer deadline rather than sharing the read one.
 *
 * **35 000 ms for reads, 45 000 ms for writes** — 5s of margin over the 30s handshake for a read
 * (open + one read, no save), 15s of margin for a write (open + edit + save, the operation with
 * headroom to spare for a large document). Both are deliberately far more generous than any browser
 * deadline (`BROWSER_DEADLINES_MS`'s ceiling is 30s): a browser command waits on CDP, already-running
 * in an always-live renderer process; an office command may have to bring an entire LibreOfficeKit
 * process up from nothing first, which is categorically heavier.
 *
 * **These numbers are UNEXERCISED by this task's own behaviour, and that is by design, not an
 * oversight.** T1's `OfficeCommandConsumer` answers every verb SYNCHRONOUSLY with a refusal — no
 * verb here ever waits long enough for either deadline to matter yet. They exist now because the
 * wire's exact-equality tripwire (`office-commands.test.ts`, mirroring `browser.test.ts`'s) requires
 * every verb in `OFFICE_COMMAND_ACTIONS` to have SOME deadline before a real tool can dispatch
 * against it, and because picking the number once, with its arithmetic written down, is cheaper than
 * every later task re-deriving it. A later task that discovers these are wrong for a REAL run should
 * change the two constants below, not invent a 23rd per-verb number — the read/write split is the
 * fact that varies; nothing else about an office verb's cost does.
 *
 * Not settings, for the same reason `BROWSER_DEADLINES_MS` gives: nothing here is a knob a user would
 * turn.
 */
export const OFFICE_READ_DEADLINE_MS = 35_000;
export const OFFICE_WRITE_DEADLINE_MS = 45_000;

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
