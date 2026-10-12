// ComputerV2 wake triggers — what the PHONE gets of a `computer-wake` message (spine R-W3). The message's text is for
// the MODEL: a `<computer-wake>` block with the model's own note in it and the `<screen-data>` fence markup around the
// screen's words. The note is never shown on the user's screen, and the phone renders a `user_message` as a bubble —
// so both phone paths (`session.history` and the live/replay stream, through `phoneViewOf`) replace the text with ONE
// daemon line built from the event FACTS: the `wake_armed`/`wake_ended` pair already on the session's log, e.g.
// "Winter continued: a wake trigger ended (you clicked “Submit” in Chrome)".
//
// Which triggers a message reports is read off the lines the daemon itself starts with `- wk_<12 hex> ` (the model's
// note and every label are one line each, never at a line's start). The facts come from the LOG, never from what one
// connection happened to stream (a replay may start after the `wake_armed`), and only from events BEFORE the message —
// so a message re-read from a history page is the same bytes it was live.
import type { SessionEvent } from "@yanlinglabs/winter-protocol";

const WAKE_LINE = /^- (wk_[0-9a-f]{12}) /gm;

interface ArmedFacts { condition: string; targetLabel: string; elementLabel?: string }

/** What happened, for an ending a wake message carries — the terminal's and the Mac's words (`cli/src/wake-words.ts`,
 *  `WakeWords.swift`). */
function endedWords(w: ArmedFacts, reason: string): string {
  const t = w.targetLabel || "the app";
  const el = w.elementLabel;
  if (reason === "lost") return `${t} went away while Winter waited`;
  if (reason === "expired") return `the wait in ${t} ran out`;
  if (reason === "restart") return `Winter restarted while it waited in ${t}`;
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

/** The one line the phone shows for a `computer-wake` message at `seq` whose text is `text`, from `log` (the session's
 *  events; absent or unreadable → the line without its facts). Never the note, never the fence markup. */
export function computerWakePhoneLine(text: string, seq: number, log: readonly SessionEvent[] | undefined): string {
  const ids = [...new Set([...text.matchAll(WAKE_LINE)].map((m) => m[1]!))];
  const armed = new Map<string, ArmedFacts>();
  const ended = new Map<string, string>();
  if (log !== undefined && ids.length > 0) {
    const wanted = new Set(ids);
    for (const e of log) {
      if (e.seq >= seq) continue;
      if (e.type === "wake_armed" && wanted.has(e.wakeId)) {
        armed.set(e.wakeId, { condition: e.condition, targetLabel: e.targetLabel, ...(e.elementLabel === undefined ? {} : { elementLabel: e.elementLabel }) });
      } else if (e.type === "wake_ended" && wanted.has(e.wakeId)) ended.set(e.wakeId, e.reason);
    }
  }
  const facts = ids.flatMap((id) => {
    const a = armed.get(id);
    const r = ended.get(id);
    return a === undefined || r === undefined ? [] : [endedWords(a, r)];
  });
  const head = ids.length > 1 ? `Winter continued: ${ids.length} wake triggers ended` : "Winter continued: a wake trigger ended";
  return facts.length === 0 ? head : `${head} (${facts.join("; ")})`;
}
