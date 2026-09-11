import type { Settings } from "../settings";
import type { Mode as SessionMode } from "../agent/tools/registry";

/** Which engine a session runs on. Recorded at CREATION and never re-read: P8b-13's flag governs
 *  NEW sessions only, so a session runs to completion on the leg it was born on even if the setting
 *  flips mid-flight. */
export type SessionLeg = "engine" | "winter";

/** The shape Task 15 adds under `settings.runtimes`. Declared structurally here rather than
 *  imported, because the zod block does not carry `winterLeg` yet and this lane must not edit the
 *  settings schema (Task 15 owns it). When Task 15 lands, this cast becomes redundant but stays
 *  correct — the field names are pinned by the Interfaces block on both sides. */
type RuntimesWithLeg = { winterLeg?: Partial<Record<SessionMode, boolean>> } | undefined;

/**
 * **The leg a NEW session of this mode is created on** (P8b-13).
 *
 * Reads `settings.runtimes.winterLeg.<mode>` and defaults to `"engine"` — for an absent `runtimes`
 * block, an absent `winterLeg`, an absent per-mode key, and any value that is not literally `true`.
 * That default is the safety property of the whole phase: `settings.runtimes` is `.optional()` (it
 * is a top-level key like every other, deliberately not defaulted so `saveSettings` never stamps
 * today's values into every user's file), so **every existing install and every hand-built settings
 * literal in the codebase has no `runtimes` block at all** — and each must keep running on the
 * engine until a human turns a flag on.
 *
 * `=== true` rather than truthiness: a settings file hand-edited to `"yes"` or `1` must not move a
 * user's sessions onto a leg they did not ask for.
 */
export function legForNewSession(mode: SessionMode, settings: Settings | undefined): SessionLeg {
  const runtimes = settings?.runtimes as RuntimesWithLeg;
  return runtimes?.winterLeg?.[mode] === true ? "winter" : "engine";
}

/**
 * **The leg an EXISTING session runs on, read from its 8a record** (P8b-13's "a resumed session
 * follows its record, never the flag") — and the ONE predicate P8b-22's refusal keys on.
 *
 * There is no `leg` column on `RuntimeSessionRecord` (Task 16 finding: the brief assumed one). The
 * leg is instead a fact the record already carries: a session created on the Winter leg has its
 * BACKEND uuid allocated in the creation transaction (`Options.sessionId`, the name of the child's
 * own transcript under `<home>/projects/<key>/`), and nothing else ever writes one — the §17 phase-4
 * backfill deliberately leaves it absent ("no compatibility transcript exists"), and an engine-leg
 * create (P8b-14's dual-run creation transaction) does the same. So `backendSessionId !== undefined`
 * IS "this session has, or will have, a Winter transcript", which is exactly the fact routing needs:
 * a record without one can never be resumed on the Winter leg, whatever a flag says today.
 *
 * `selection.reason` is stamped with a human-readable account of the leg at creation (what a host
 * renders for "why is this session on that runtime"); it is NEVER parsed. Routing reads this.
 *
 * Deliberately NOT a function of `runtimeKind`: 8a records every session — engine sessions included
 * — as `"winter-agent"`, because that is the only runtime kind this daemon hosts.
 */
export function sessionLegOf(record: { backendSessionId?: string } | undefined): SessionLeg | undefined {
  if (record === undefined) return undefined;
  return typeof record.backendSessionId === "string" && record.backendSessionId.length > 0 ? "winter" : "engine";
}
