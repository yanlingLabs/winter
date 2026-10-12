// ComputerV2 wake triggers — the ONE place this lane cleans and cuts text: the labels a backend reports (the target,
// the element, a fired trigger's detail, a loss reason, its own note), the model's note, and every string `wakes.json`
// is read back with. Each string it hands on is WELL-FORMED UTF-16: a cut never splits a surrogate pair, and a lone
// surrogate that came in is replaced. A lone `\ud83d` survives `JSON.stringify` as an escape that Foundation's
// `JSONDecoder` refuses — the Mac would drop the whole `wake_armed` (its pill never shows) and the phone's history page
// would fail to decode.
import { WAKE_LABEL_MAX } from "@yanlinglabs/winter-protocol";

/** A high surrogate not followed by a low one, or a low surrogate not preceded by a high one. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
/** Controls, line and paragraph separators, and the bidi marks and overrides — a label is one plain line. */
// eslint-disable-next-line no-control-regex
const CONTROL_OR_BIDI = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069\u2028\u2029]+/g;

/** `s` with every lone surrogate replaced by U+FFFD (a pair is kept whole). */
export function wellFormed(s: string): string {
  return s.replace(LONE_SURROGATE, "\uFFFD");
}

/** At most `max` UTF-16 units of `s`, backed off by one when the cut would leave a high surrogate without its pair. */
export function cutUtf16(s: string, max: number): string {
  if (s.length <= max) return s;
  let end = Math.max(0, Math.floor(max));
  const last = end > 0 ? s.charCodeAt(end - 1) : 0;
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return s.slice(0, end);
}

/** One line, no control or bidi characters, well-formed, cut (with "…") — a label from the screen goes into a log, a
 *  pill and a message. */
export function wakeLabel(v: unknown, max: number = WAKE_LABEL_MAX): string {
  if (typeof v !== "string") return "";
  const one = wellFormed(v).replace(CONTROL_OR_BIDI, " ").replace(/\s+/g, " ").trim();
  return one.length > max ? `${cutUtf16(one, max - 1)}…` : one;
}
