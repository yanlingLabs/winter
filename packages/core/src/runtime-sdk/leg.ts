import { winterOptionsFromSettings, type Settings } from "../settings";
import type { Mode as SessionMode } from "../agent/tools/registry";

/** Which leg a session's RECORD describes. `"winter"` = it has (or will have) a Winter transcript
 *  and can be resumed; `"official"` = P8c: the record's `runtimeKind` says `claude-agent` — a
 *  spawned `claude` child, resumed through the router's own official adapter rather than Winter's;
 *  `"engine"` = an engine-ERA record — a pre-8b row 8a's boot backfill wrote with no backend id —
 *  which nothing can run any more (P8b-22's typed refusal). No new record is ever written with the
 *  `engine` shape since the retirement; the value survives as the name of that history. */
export type SessionLeg = "engine" | "winter" | "official";

/** Task 17: the engine is retired — the answer is `winter` for every mode. The signature and the
 *  door stay so a settings file's (ignored) `winterLeg.<mode>: false` is read through the ONE
 *  place that reports it (`winterOptionsFromSettings`; the flag is accepted for one release). */
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
 * P8c-14: NOW a function of `runtimeKind` for exactly one value — `"claude-agent"` is the official
 * leg's own record, unambiguous and never written for a Winter session (8a records every OTHER
 * session as `"winter-agent"`, engine sessions included, because Winter was the only runtime kind
 * this daemon hosted before 8c). A `claude-agent` record therefore reports `"official"` regardless
 * of `backendSessionId` (P8c-1's own creation transaction sets it in the SAME write, but this
 * predicate must not need to know that to be correct); everything else keeps the pre-8c rule.
 */
export function sessionLegOf(record: { backendSessionId?: string; runtimeKind?: string } | undefined): SessionLeg | undefined {
  if (record === undefined) return undefined;
  if (record.runtimeKind === "claude-agent") return "official";
  return typeof record.backendSessionId === "string" && record.backendSessionId.length > 0 ? "winter" : "engine";
}
