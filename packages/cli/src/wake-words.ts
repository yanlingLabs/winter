// ComputerV2 wake triggers (2026-10-12) — the terminal's words for them. A trigger is announced by the persisted
// `wake_armed`/`wake_ended` pair; the session is then woken by a daemon-written `user_message` under
// `clientName: "computer-wake"` whose text is for the MODEL (a `<computer-wake>` block). The TUI and `winter -p` never
// show that text as the user's: they say, as a note, what happened — built from the pair, never from the message.
// (The Mac app says the same with its own copy, `WakeWords.swift`.)
import { COMPUTER_WAKE_CLIENT_NAME } from "@yanlinglabs/winter-protocol";

export { COMPUTER_WAKE_CLIENT_NAME };

export interface ArmedWakeFacts { condition: string; targetLabel: string; elementLabel?: string }

/** What a trigger waits for, as the user reads it after "waiting for": "you to click “Submit for review” in Chrome —
 *  Dashboard", "“Sent” to appear in Mail — Inbox". */
export function waitingWords(w: ArmedWakeFacts): string {
  const t = w.targetLabel || "the app";
  const el = w.elementLabel;
  switch (w.condition) {
    case "clicked": return `you to click ${el ?? "an element"} in ${t}`;
    case "submitted": return `you to submit ${el ?? "a form"} in ${t}`;
    case "changed": return `you to change ${el ?? "a field"} in ${t}`;
    case "navigated": return el === undefined ? `${t} to move to another page` : `${t} to reach ${el}`;
    case "appeared": return `${el ?? "the text"} to appear in ${t}`;
    case "gone": return `${el ?? "an element"} to go away in ${t}`;
    case "titled": return `${t}'s title to contain ${el ?? "the text"}`;
    default: return `something in ${t}`;
  }
}

/** What happened, for an ended trigger the session was woken for: "you clicked “Submit for review” in Chrome". */
export function endedWords(w: ArmedWakeFacts, reason: string): string {
  const t = w.targetLabel || "the app";
  const el = w.elementLabel;
  if (reason === "lost") return `${t} went away while Winter waited`;
  if (reason === "expired") return `the wait for ${waitingWords(w)} ran out`;
  if (reason === "restart") return `Winter restarted while it waited for ${waitingWords(w)}`;
  switch (w.condition) {
    case "clicked": return `you clicked ${el ?? "it"} in ${t}`;
    case "submitted": return `you submitted ${el ?? "a form"} in ${t}`;
    case "changed": return `you changed ${el ?? "the field"} in ${t}`;
    case "navigated": return el === undefined ? `${t} moved to another page` : `${t} reached ${el}`;
    case "appeared": return `${el ?? "the text"} appeared in ${t}`;
    case "gone": return `${el ?? "it"} went away in ${t}`;
    case "titled": return `${t}'s title now contains ${el ?? "the text"}`;
    default: return `the wait in ${t} ended`;
  }
}

/** Does a trigger ending this way wake the session? (`cancelled` and `disabled` never do; `expired` only when the model
 *  asked — then the wake message follows, and the note reads from it.) */
export const WAKING_REASONS: ReadonlySet<string> = new Set(["fired", "lost", "expired", "restart"]);
