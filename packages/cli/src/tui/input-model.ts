/** Pure text+cursor model for the composer (Phase 3c Task 3). Every op takes an `InputState` and
 *  returns a NEW one (no mutation) — `cursor` is always kept in `[0, text.length]` by construction,
 *  so callers never need to clamp themselves. A no-op edit/move (e.g. `left` at cursor 0) returns
 *  the SAME object reference (not just an equal one) so callers can use `Object.is` to detect "no
 *  change happened" cheaply if they ever need to (nothing here relies on that today).
 *
 *  UNICODE LIMITATION (documented, not solved — brief's explicit call): every op indexes `text` by
 *  JS string code unit (`.slice`/`.length`/`[i]`), not by grapheme cluster. Multi-code-unit
 *  characters (astral-plane emoji, combining accents, ZWJ sequences) can have the cursor land
 *  mid-character and `left`/`right`/`backspace`/`del` will split them rather than treating the
 *  cluster atomically. Fixing this would need a full grapheme-segmentation pass (`Intl.Segmenter`)
 *  wired through every op; out of scope for this task. */

export interface InputState {
  text: string;
  cursor: number;
}

/** Whitespace-delimited word boundary, per the brief (not punctuation-aware like some editors). */
const isWhitespace = (ch: string): boolean => /\s/.test(ch);

export function insert(s: InputState, chars: string): InputState {
  if (chars.length === 0) return s;
  const text = s.text.slice(0, s.cursor) + chars + s.text.slice(s.cursor);
  return { text, cursor: s.cursor + chars.length };
}

export function backspace(s: InputState): InputState {
  if (s.cursor === 0) return s;
  const text = s.text.slice(0, s.cursor - 1) + s.text.slice(s.cursor);
  return { text, cursor: s.cursor - 1 };
}

export function del(s: InputState): InputState {
  if (s.cursor >= s.text.length) return s;
  const text = s.text.slice(0, s.cursor) + s.text.slice(s.cursor + 1);
  return { text, cursor: s.cursor };
}

export function left(s: InputState): InputState {
  return s.cursor === 0 ? s : { ...s, cursor: s.cursor - 1 };
}

export function right(s: InputState): InputState {
  return s.cursor >= s.text.length ? s : { ...s, cursor: s.cursor + 1 };
}

export function home(s: InputState): InputState {
  return s.cursor === 0 ? s : { ...s, cursor: 0 };
}

export function end(s: InputState): InputState {
  return s.cursor >= s.text.length ? s : { ...s, cursor: s.text.length };
}

/** Skips any whitespace immediately left of the cursor, then the word before that — landing on the
 *  first character of that word (or 0, if it's the first word in the text). */
export function wordLeft(s: InputState): InputState {
  let i = s.cursor;
  while (i > 0 && isWhitespace(s.text[i - 1]!)) i--;
  while (i > 0 && !isWhitespace(s.text[i - 1]!)) i--;
  return i === s.cursor ? s : { ...s, cursor: i };
}

/** Skips any whitespace immediately right of the cursor, then the word after that — landing just
 *  past its last character (or `text.length`, if it's the last word in the text). */
export function wordRight(s: InputState): InputState {
  const n = s.text.length;
  let i = s.cursor;
  while (i < n && isWhitespace(s.text[i]!)) i++;
  while (i < n && !isWhitespace(s.text[i]!)) i++;
  return i === s.cursor ? s : { ...s, cursor: i };
}

/** Splits `text` around the cursor for rendering: `at` is the single character the cursor sits ON
 *  (an inverse-video block in the composer), `before`/`after` are the plain text either side. When
 *  the cursor is past the last character (the common "typing at the end" case) `at` is `""` — the
 *  composer renders an inverse SPACE in that case so there's still a visible cursor. */
export function renderWithCursor(s: InputState): { before: string; at: string; after: string } {
  const before = s.text.slice(0, s.cursor);
  const at = s.cursor < s.text.length ? s.text[s.cursor]! : "";
  const after = s.cursor < s.text.length ? s.text.slice(s.cursor + 1) : "";
  return { before, at, after };
}

// ---------------------------------------------------------------------------------------------
// Mouse decoding at the input layer (TUI renderer T1 — mechanism report Q3 + Q7 cure 3).
//
// mount.ts enables SGR mouse reporting (\x1b[?1000h\x1b[?1006h): a wheel notch arrives as
// "\x1b[<64;COL;ROWM" (up) / "\x1b[<65;COL;ROWM" (down); clicks/releases/motion arrive in the
// same grammar with other button codes. A terminal that honors 1000 but not 1006 answers in the
// legacy X10 format instead: "\x1b[M" + three payload bytes (button+32, col+32, row+32). Wheel
// is a FIRST-CLASS input event (`WheelEvent`, consumed by the scroll model); every other mouse
// report is noise to swallow. The structural rule (the CC shape, adapted): mouse bytes are
// decoded/refused AT THE INPUT LAYER, before any text-insertion fallback — unknown or partial
// mouse CSI can never fall through as typed text.
//
// Ink 5.2.1 reality this has to survive (verified against its parse-keypress directly): Ink hands
// the RAW chunk to internal_eventEmitter "input"; use-input parses the whole chunk as ONE
// keypress, strips a single leading ESC, and delivers the remnant to every useInput consumer with
// name "", ctrl:false, meta:false — so a full report reaching useInput becomes the printable
// string "[<64;116;23M". That is the user-reported composer leak, byte-for-byte. Three layers
// here close it: `createMouseFilter` (chunk router at the emitter patch — reassembles reports
// split ANYWHERE, including inside the 3-byte "\x1b[<" prefix at a pty-buffer boundary, the hole
// the old alt-screen.ts filter had), `decodeMouse` (one report → wheel or null), and
// `isMouseArtifact` (the composer's final never-insert guard for any remnant that still reaches a
// useInput consumer through a path the router doesn't own).
// ---------------------------------------------------------------------------------------------

/** A wheel notch as a first-class input event. `lines` is the scroll magnitude the notch carries
 *  (always `WHEEL_SCROLL_LINES` today — the field exists so the scroll model consumes a complete
 *  event, not an event plus a constant it has to know about). */
export type WheelEvent = { kind: "wheelUp" | "wheelDown"; lines: number };

/** Lines scrolled per wheel notch — the same ±3 the emitter patch has always applied. */
export const WHEEL_SCROLL_LINES = 3;

// Modifier bits carried inside the button code (shift=4, alt/meta=8, ctrl=16) — irrelevant to
// wheel direction, so they're masked off before comparing against the wheel base codes 64/65.
const MOUSE_MODIFIER_BITS = 4 | 8 | 16;

// One COMPLETE SGR report, tolerating the ESC-stripped remnant forms Ink's parser produces
// ("[<..." after one ESC strip; "<..." when a split left "\x1b[" in an earlier chunk).
const SGR_COMPLETE_RE = /^(?:\x1b\[<|\[<|<)(\d{1,3});(\d{1,4});(\d{1,4})[Mm]$/;
// One COMPLETE legacy X10 report (ESC-stripped form tolerated the same way). Payload bytes are
// value+32, so they are never ESC; `[\s\S]` (not `.`) because col/row bytes can be anything ≥ 32.
const LEGACY_COMPLETE_RE = /^(?:\x1b\[M|\[M)([\s\S])[\s\S]{2}$/;

function wheelFromButton(button: number): WheelEvent | null {
  const base = button & ~MOUSE_MODIFIER_BITS;
  if (base === 64) return { kind: "wheelUp", lines: WHEEL_SCROLL_LINES };
  if (base === 65) return { kind: "wheelDown", lines: WHEEL_SCROLL_LINES };
  return null;
}

/** SGR (`CSI < b;x;y M/m`) and legacy (`CSI M` + 3 payload bytes) mouse sequences →
 *  `WheelEvent | null` (null = non-wheel mouse, swallowed by the router/guard — never text).
 *  Accepts the ESC-stripped remnant forms too (see the section comment). Anything that isn't a
 *  complete mouse report — partial CSI, arrows, plain text — is also null: decode never invents a
 *  wheel; the ROUTER decides what gets swallowed vs forwarded. */
export function decodeMouse(seq: string): WheelEvent | null {
  const sgr = SGR_COMPLETE_RE.exec(seq);
  if (sgr) return wheelFromButton(Number(sgr[1]));
  const legacy = LEGACY_COMPLETE_RE.exec(seq);
  if (legacy) return wheelFromButton(legacy[1]!.charCodeAt(0) - 32);
  return null;
}

// isMouseArtifact grammar: an unambiguous mouse HEAD must open the string (so prose that merely
// CONTAINS a report-looking substring — a paste — is never swallowed); after one head, trusted
// CONTINUATIONS cover the mangled shapes Ink produces for batched reports (interior raw ESC kept,
// or a later report's own prefix partially eaten — the observed "[<64;116;23M16;23M16;23M").
const ARTIFACT_SGR_HEAD_RE = /^(?:\x1b\[<|\[<|<)\d{1,3};\d{1,4};\d{1,4}[Mm]/;
const ARTIFACT_LEGACY_HEAD_RE = /^(?:\x1b\[M|\[M)[\s\S]{3}/;
const ARTIFACT_CONT_RE = /^(?:(?:\x1b\[<|\[<|<)?\d{1,4}(?:;\d{1,4}){0,2}[Mm]|(?:\x1b\[M|\[M)[\s\S]{3})/;

/** The composer's final never-insert guard: is this ENTIRE string mouse-report debris? True only
 *  when an unambiguous report opens the string and every byte after it belongs to a report
 *  remnant — so genuine text (including pastes that merely mention a report shape mid-string)
 *  always returns false and keeps typing. */
export function isMouseArtifact(input: string): boolean {
  const head = ARTIFACT_SGR_HEAD_RE.exec(input) ?? ARTIFACT_LEGACY_HEAD_RE.exec(input);
  if (!head) return false;
  let rest = input.slice(head[0].length);
  while (rest.length > 0) {
    const cont = ARTIFACT_CONT_RE.exec(rest);
    if (!cont) return false;
    rest = rest.slice(cont[0].length);
  }
  return true;
}

// Router internals. A report can split across reads ANYWHERE — the pty buffer boundary during a
// fast flick does not respect report boundaries — so the router carries a possibly-incomplete
// tail across chunks. Two tail classes:
//   unambiguous — already inside mouse-only grammar ("\x1b[<…" / "\x1b[M" + <3 payload bytes):
//     held unconditionally (nothing else on a keyboard produces these prefixes);
//   ambiguous — a bare "\x1b" or "\x1b[": held ONLY with mouse context (this feed consumed a
//     report, or continued a held tail), because a COLD bare ESC is a human Esc keypress and must
//     pass through instantly — holding it would delay/require-a-second-key for Esc semantics.
const SGR_HEAD_RE = /^\x1b\[<(\d{1,3});(\d{1,4});(\d{1,4})[Mm]/;
const SGR_PARTIAL_RE = /^\x1b\[<\d{0,3}(?:;\d{0,4}(?:;\d{0,4})?)?$/;
const SGR_DEAD_PREFIX_RE = /^\x1b\[<\d{0,3}(?:;\d{0,4}(?:;\d{0,4})?)?/;
const LEGACY_PARTIAL_RE = /^\x1b\[M[\s\S]{0,2}$/;
const LEGACY_REPORT_LEN = 6; // "\x1b[M" + 3 payload bytes
const MAX_PARTIAL_BUFFER = 32; // generous headroom over the longest realistic report

/** Stateful chunk router over RAW stdin chunks — the input-layer owner of mouse bytes (wired at
 *  the one pre-useInput emitter patch in app.tsx). Consumes every complete report anywhere in a
 *  chunk (batched flicks), reassembles reports split across chunk boundaries AT ANY BYTE
 *  (including inside the ESC prefix — the old filter's leak), decodes wheel notches into
 *  first-class `WheelEvent`s, swallows every other mouse report, and forwards genuine key/text
 *  bytes untouched. A dead mouse prefix (entered mouse-only grammar, then broke) is DROPPED, not
 *  flushed — partial mouse CSI never becomes text. One instance per input stream's lifetime: a
 *  fresh instance per chunk would lose the carried tail. */
export function createMouseFilter(): (chunk: string) => { text: string; wheel: WheelEvent[] } {
  let pending = "";

  return (chunk: string) => {
    const hadPending = pending !== "";
    const data = pending + chunk;
    pending = "";
    let text = "";
    const wheel: WheelEvent[] = [];
    // Mouse context for the ambiguous-tail rule: continuing a held tail counts, as does any
    // report consumed in THIS feed.
    let mouseContext = hadPending;
    let i = 0;
    while (i < data.length) {
      const esc = data.indexOf("\x1b", i);
      if (esc === -1) {
        text += data.slice(i);
        break;
      }
      text += data.slice(i, esc);
      const rest = data.slice(esc);
      const sgr = SGR_HEAD_RE.exec(rest);
      if (sgr) {
        const ev = wheelFromButton(Number(sgr[1]));
        if (ev) wheel.push(ev);
        mouseContext = true;
        i = esc + sgr[0].length;
        continue;
      }
      if (rest.startsWith("\x1b[M") && rest.length >= LEGACY_REPORT_LEN) {
        const ev = wheelFromButton(rest.charCodeAt(3) - 32);
        if (ev) wheel.push(ev);
        mouseContext = true;
        i = esc + LEGACY_REPORT_LEN;
        continue;
      }
      // `rest` runs to the end of `data` from the first unconsumed ESC — is it a holdable tail?
      if (rest.length <= MAX_PARTIAL_BUFFER) {
        const unambiguous = SGR_PARTIAL_RE.test(rest) || LEGACY_PARTIAL_RE.test(rest);
        const ambiguous = rest === "\x1b" || rest === "\x1b[";
        if (unambiguous || (ambiguous && mouseContext)) {
          pending = rest;
          break;
        }
      }
      if (rest.startsWith("\x1b[<")) {
        // A dead SGR prefix (grammar broken, or over the buffer bound): swallow exactly the
        // prefix bytes and keep scanning — whatever follows may be genuine text ("never text"
        // applies to the mouse bytes, not their neighbors).
        i = esc + SGR_DEAD_PREFIX_RE.exec(rest)![0].length;
        continue;
      }
      // Not mouse at all (arrow keys, alt+key, a cold lone Esc): forward the ESC byte and keep
      // scanning after it — real keys stay byte-identical.
      text += "\x1b";
      i = esc + 1;
    }
    return { text, wheel };
  };
}
