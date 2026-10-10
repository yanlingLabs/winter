// ComputerV2 Phase 2 — when Winter closes a tab its automation opened (an "agent tab").
//
// THE ONE PLACE the rule lives: the engine (idle end, session deletion) and Winter for Chrome's host server (orphaned
// groups found after a daemon restart) both ask `shouldCloseAgentTab`. The final rule is pending a user decision;
// what is here is the current placeholder:
//
//   - a tab in Winter's own browser is NEVER closed by this rule: it lives in the session's panel strip and goes
//     with the session (archive and delete already stop it);
//   - a tab the model kept (`keep()`) is never closed — it is the user's now;
//   - otherwise, a tab in the user's own browser closes when its session's computer-use runtime idles out (30
//     minutes) or the session is deleted; an orphaned Winter group found after a restart closes when its session is
//     deleted or archived (else it waits for that session's next idle end);
//   - a turn's end and the daemon stopping close nothing.
import type { BrowserFamily } from "./transport";

export type AgentTabEvent = "turn-ended" | "idle-ended" | "session-deleted" | "daemon-stop" | "orphan-found";

export interface AgentTabFacts {
  event: AgentTabEvent;
  family: BrowserFamily;
  /** The model called `keep()` on it. */
  kept: boolean;
  /** For `orphan-found`: the session it belongs to is deleted or archived. */
  sessionGone?: boolean;
}

export function shouldCloseAgentTab(f: AgentTabFacts): boolean {
  if (f.family === "winter") return false;
  if (f.kept) return false;
  switch (f.event) {
    case "idle-ended":
    case "session-deleted":
      return true;
    case "orphan-found":
      return f.sessionGone === true;
    case "turn-ended":
    case "daemon-stop":
      return false;
  }
}
