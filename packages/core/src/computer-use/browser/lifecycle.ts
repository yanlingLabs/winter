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
//   - the daemon stopping, or the computer-use runtime idling out, closes nothing.
// Tabs the user already had open are never closed (they are released at turn end). Tabs in Winter's own browser are
// never closed by this rule: they live in the session's panel strip and go with the session.
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
}

export function shouldCloseAgentTab(f: AgentTabFacts): boolean {
  if (f.family === "winter") return false;
  if (f.kept) return false;
  switch (f.event) {
    case "turn-ended": return f.handoff !== true;
    case "session-deleted":
    case "session-archived":
      return true;
    case "restart-orphan": return f.turnRunning !== true;
    case "idle-ended":
    case "daemon-stop":
      return false;
  }
}
