// ComputerV2 Phase 2 — when Winter closes a tab its automation opened (an "agent tab"). THE ONE PLACE the rule
// lives: the engine asks `shouldCloseAgentTab` at every main-thread turn end, when a session is deleted or archived,
// and when it first meets a user browser after a daemon restart.
//
// The user's ruling (2026-10-10), for tabs in the USER'S OWN browser:
//   - at every main-thread TURN END, every agent tab of the session that is not marked is closed — the tab the agent
//     was just using included (being "selected" is not special, nor is the browser's own tab pin);
//   - two marks, both set by the model: `keep()` hands the tab to the user for good (it leaves Winter's group and is
//     never closed again); `handoff()` lets it survive THIS turn's end only (the mark is cleared at that turn end);
//   - the session deleted or archived: its remaining agent tabs close;
//   - after a daemon restart, at the browser's next hello: agent tabs of sessions with no running turn close
//     (a `handoff` does not survive the restart; a kept tab is no longer an agent tab);
//   - the daemon stopping, or the computer-use runtime idling out, closes nothing;
//   - a tab a WAKE TRIGGER waits on (`wakeWhen`, armed) is not closed at a turn end: the user acts there, and the
//     trigger's ending wakes the session. Once it ends, the ordinary rule applies at the NEXT turn end (the wake turn's,
//     unless the agent marks it). Deleting or archiving the session still closes it.
// Tabs the user already had open are never closed (they are released at turn end). Tabs in Winter's own browser are
// never closed by this rule: they live in the session's panel strip and go with the session.
//
// Winter's HEADLESS browser (Phase 4, the user's ruling on headless tabs): every tab in it is an agent tab, and the same rule applies with two
// differences — `keep()` is refused there (nobody can see the tab, so it is never handed to anyone), and the runtime
// idling out closes them too (the session's private context goes then anyway). The daemon stopping still closes
// nothing per tab: the headless browser itself exits, and every tab with it.
import type { BrowserFamily } from "./transport";

export type AgentTabEvent = "turn-ended" | "session-deleted" | "session-archived" | "restart-orphan" | "idle-ended" | "daemon-stop";

export interface AgentTabFacts {
  event: AgentTabEvent;
  family: BrowserFamily;
  /** `keep()`: handed to the user. */
  kept: boolean;
  /** `handoff()`: survives this turn's end only. */
  handoff?: boolean;
  /** For `restart-orphan`: its session is running a turn now. */
  turnRunning?: boolean;
  /** A wake trigger is armed on it (`turn-ended` keeps it open). */
  waiting?: boolean;
}

export function shouldCloseAgentTab(f: AgentTabFacts): boolean {
  if (f.family === "winter") return false;
  if (f.kept) return false;
  switch (f.event) {
    case "turn-ended": return f.handoff !== true && f.waiting !== true;
    case "session-deleted":
    case "session-archived":
      return true;
    case "restart-orphan": return f.turnRunning !== true;
    case "idle-ended": return f.family === "headless";
    case "daemon-stop":
      return false;
  }
}
