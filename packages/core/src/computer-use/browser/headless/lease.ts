// ComputerV2 Phase 4, lane H3 — the person's CONTROL LEASE on a headless tab shown in Winter's panel: what the agent
// reads while the person holds the tab. One sentence, shared by the pool (which refuses the agent's commands) and the
// engine (which refuses every primitive on a held tab before it reaches the pool).

/** Every agent command or primitive on a headless tab the person holds in Winter's panel — read as `TargetBusy`. */
export const HEADLESS_USER_HAS_TAB = "the user has this tab in Winter's panel — it is theirs until they hand it back; work in another tab meanwhile";

/** What the agent may still do with a tab the person holds: let it go, keep it for the next turn, or wait for the person
 *  (which turns the hold into the agent's hand-off). Everything else — every read included — is `TargetBusy`. */
export const HELD_TAB_PRIMITIVES: ReadonlySet<string> = new Set(["close", "handoff", "waitForUser"]);
