import { winterOptionsFromSettings, type Settings } from "../settings";
import type { Mode as SessionMode } from "../agent/tools/registry";

/** Which engine a session runs on. Recorded at CREATION and never re-read: P8b-13's flag governs
 *  NEW sessions only, so a session runs to completion on the leg it was born on even if the setting
 *  flips mid-flight. */
export type SessionLeg = "engine" | "winter";

/** The shape Task 15 adds under `settings.runtimes`. Declared structurally here rather than
 *  imported, because the zod block does not carry `winterLeg` yet and this lane must not edit the
 *  settings schema (Task 15 owns it). When Task 15 lands, this cast becomes redundant but stays
 *  correct — the field names are pinned by the Interfaces block on both sides. */
/** Reads the ONE defaults door (`winterOptionsFromSettings`), so an ABSENT `runtimes` block and an
 *  absent field answer the per-mode default the schema declares — never a hard-coded `false`. */
export function legForNewSession(mode: SessionMode, settings: Settings | null | undefined): SessionLeg {
  return winterOptionsFromSettings(settings).winterLeg[mode] ? "winter" : "engine";
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
