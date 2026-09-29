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

import stringWidth from "string-width";
import wrapAnsi from "wrap-ansi";
import { displayLineBreaks } from "./format";

export interface InputState {
  text: string;
  cursor: number;
  /** Other end of the active selection; absent when there is no selection. */
  anchor?: number;
}

export function selectionRange(s: InputState): [number, number] | null {
  if (s.anchor === undefined || s.anchor === s.cursor) return null;
  return [Math.min(s.anchor, s.cursor), Math.max(s.anchor, s.cursor)];
}

export function cursorTo(s: InputState, cursor: number, extend = false): InputState {
  const next = Math.min(s.text.length, Math.max(0, cursor));
  if (extend) {
    const anchor = s.anchor ?? s.cursor;
    return next === anchor ? { text: s.text, cursor: next } : { text: s.text, cursor: next, anchor };
  }
  return next === s.cursor && s.anchor === undefined ? s : { text: s.text, cursor: next };
}

export function selectedText(s: InputState): string {
  const range = selectionRange(s);
  return range ? s.text.slice(...range) : "";
}

export function deleteSelection(s: InputState): InputState {
  const range = selectionRange(s);
  if (!range) return s;
  return { text: s.text.slice(0, range[0]) + s.text.slice(range[1]), cursor: range[0] };
}

/** Whitespace-delimited word boundary, per the brief (not punctuation-aware like some editors). */
const isWhitespace = (ch: string): boolean => /\s/.test(ch);

export function insert(s: InputState, chars: string): InputState {
  if (chars.length === 0) return s;
  const base = deleteSelection(s);
  const text = base.text.slice(0, base.cursor) + chars + base.text.slice(base.cursor);
  return { text, cursor: base.cursor + chars.length };
}

export function backspace(s: InputState): InputState {
  if (selectionRange(s)) return deleteSelection(s);
  if (s.cursor === 0) return s;
  const text = s.text.slice(0, s.cursor - 1) + s.text.slice(s.cursor);
  return { text, cursor: s.cursor - 1 };
}

export function del(s: InputState): InputState {
  if (selectionRange(s)) return deleteSelection(s);
  if (s.cursor >= s.text.length) return s;
  const text = s.text.slice(0, s.cursor) + s.text.slice(s.cursor + 1);
  return { text, cursor: s.cursor };
}

export function left(s: InputState): InputState {
  const range = selectionRange(s);
  if (range) return cursorTo(s, range[0]);
  if (s.cursor === 0) return s;
  return cursorTo(s, s.text[s.cursor - 1] === "\n" && s.text[s.cursor - 2] === "\r" ? s.cursor - 2 : s.cursor - 1);
}

export function right(s: InputState): InputState {
  const range = selectionRange(s);
  if (range) return cursorTo(s, range[1]);
  if (s.cursor >= s.text.length) return s;
  return cursorTo(s, s.text[s.cursor] === "\r" && s.text[s.cursor + 1] === "\n" ? s.cursor + 2 : s.cursor + 1);
}

interface VisualRow {
  start: number;
  end: number;
  text: string;
  promptChars: number;
}

/** Match the composer's wrap model while retaining offsets into the unmodified draft. */
let visualCache: { text: string; columns: number; value: { rows: VisualRow[]; rawAt: number[] } } | undefined;
function visualRows(text: string, columns: number): { rows: VisualRow[]; rawAt: number[] } {
  if (visualCache?.text === text && visualCache.columns === columns) return visualCache.value;
  const rawAt = [0];
  let display = "";
  for (let raw = 0; raw < text.length;) {
    if (text[raw] === "\r") {
      raw += text[raw + 1] === "\n" ? 2 : 1;
      display += "\n";
    } else {
      display += text[raw]!;
      raw++;
    }
    rawAt.push(raw);
  }

  const rows: VisualRow[] = [];
  let logicalStart = 0;
  for (const [lineIndex, line] of display.split("\n").entries()) {
    const prompt = lineIndex === 0 ? "❯ " : "";
    let wrappedOffset = 0;
    for (const row of wrapAnsi(prompt + line, Math.max(1, columns), { hard: true, trim: false }).split("\n")) {
      const start = logicalStart + Math.max(0, wrappedOffset - prompt.length);
      const end = logicalStart + Math.max(0, wrappedOffset + row.length - prompt.length);
      rows.push({ start, end, text: row, promptChars: Math.min(row.length, Math.max(0, prompt.length - wrappedOffset)) });
      wrappedOffset += row.length;
    }
    logicalStart += line.length + 1;
  }
  const value = { rows, rawAt };
  visualCache = { text, columns, value };
  return value;
}

/** Mouse cell (zero-based visual row/column) to a raw draft offset, including soft wraps and the
 * first-row prompt. The same row map drives vertical arrows, so clicks cannot disagree with them. */
export function cursorAtVisualPosition(text: string, columns: number, rowIndex: number, column: number): number {
  const { rows, rawAt } = visualRows(text, columns);
  const row = rows[Math.min(rows.length - 1, Math.max(0, rowIndex))]!;
  let best = 0;
  let distance = Infinity;
  for (let offset = 0; offset <= row.end - row.start; offset++) {
    const cell = stringWidth(row.text.slice(0, row.promptChars + offset));
    const delta = Math.abs(Math.max(0, column) - cell);
    if (delta < distance) { distance = delta; best = offset; }
  }
  return rawAt[row.start + best] ?? text.length;
}

/** Move the edit cursor by one displayed row, preserving its preferred screen column through
 * shorter lines. The raw text is never normalized; only the display-position map is. */
export function moveVerticalCursor(
  s: InputState,
  columns: number,
  direction: -1 | 1,
  preferredColumn?: number,
): { state: InputState; column: number } {
  const { rows, rawAt } = visualRows(s.text, columns);
  let lo = 0, hi = rawAt.length - 1;
  while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (rawAt[mid]! <= s.cursor) lo = mid; else hi = mid - 1; }
  const displayCursor = lo;
  lo = 0; hi = rows.length - 1;
  while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (rows[mid]!.start <= displayCursor) lo = mid; else hi = mid - 1; }
  const current = lo;
  const source = rows[current]!;
  const sourceColumn = stringWidth(source.text.slice(0, source.promptChars + Math.max(0, displayCursor - source.start)));
  // A cursor cell appended at the exact right edge wraps onto a row of its own, even though
  // the unadorned draft has no character there. Account for that rendered row when navigating.
  const cursorWrapped = displayCursor === source.end && sourceColumn >= Math.max(1, columns)
    && (current === rows.length - 1 || rows[current + 1]!.start > displayCursor);
  const column = preferredColumn ?? (cursorWrapped ? 0 : sourceColumn);
  const targetIndex = cursorWrapped ? (direction === -1 ? current : current + 1) : current + direction;
  if (targetIndex < 0 || targetIndex >= rows.length) return { state: s, column };

  const target = rows[targetIndex]!;
  // The end of a soft-wrapped row is the *next* row's first cursor position. Keep the
  // cursor on the requested row by stopping at its last character in that case.
  const softWrapBelow = targetIndex + 1 < rows.length && rows[targetIndex + 1]!.start === target.end;
  const fullRightEdge = stringWidth(target.text) >= Math.max(1, columns);
  const maxOffset = Math.max(0, target.end - target.start - (softWrapBelow || fullRightEdge ? 1 : 0));
  let bestOffset = 0;
  let bestDistance = Infinity;
  for (let offset = 0; offset <= maxOffset; offset++) {
    const cell = stringWidth(target.text.slice(0, target.promptChars + offset));
    const distance = Math.abs(column - cell);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestOffset = offset;
    }
  }
  const nextCursor = rawAt[target.start + bestOffset] ?? s.text.length;
  return { state: cursorTo(s, nextCursor), column };
}

export function home(s: InputState): InputState {
  return cursorTo(s, 0);
}

export function end(s: InputState): InputState {
  return cursorTo(s, s.text.length);
}

/** Skips any whitespace immediately left of the cursor, then the word before that — landing on the
 *  first character of that word (or 0, if it's the first word in the text). */
export function wordLeft(s: InputState): InputState {
  const range = selectionRange(s);
  if (range) return cursorTo(s, range[0]);
  let i = s.cursor;
  while (i > 0 && isWhitespace(s.text[i - 1]!)) i--;
  while (i > 0 && !isWhitespace(s.text[i - 1]!)) i--;
  return cursorTo(s, i);
}

/** Skips any whitespace immediately right of the cursor, then the word after that — landing just
 *  past its last character (or `text.length`, if it's the last word in the text). */
export function wordRight(s: InputState): InputState {
  const range = selectionRange(s);
  if (range) return cursorTo(s, range[1]);
  const n = s.text.length;
  let i = s.cursor;
  while (i < n && isWhitespace(s.text[i]!)) i++;
  while (i < n && !isWhitespace(s.text[i]!)) i++;
  return cursorTo(s, i);
}

export function deleteWordLeft(s: InputState): InputState {
  if (selectionRange(s)) return deleteSelection(s);
  const start = wordLeft(s).cursor;
  return start === s.cursor ? s : { text: s.text.slice(0, start) + s.text.slice(s.cursor), cursor: start };
}

export function deleteWordRight(s: InputState): InputState {
  if (selectionRange(s)) return deleteSelection(s);
  const finish = wordRight(s).cursor;
  return finish === s.cursor ? s : { text: s.text.slice(0, s.cursor) + s.text.slice(finish), cursor: s.cursor };
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

/** Presentation-only cursor split. The edit model retains raw line endings for submission. */
export function renderDisplayWithCursor(s: InputState): { before: string; at: string; after: string } {
  const text = displayLineBreaks(s.text);
  const cursor = displayLineBreaks(s.text.slice(0, s.cursor)).length;
  const before = text.slice(0, cursor);
  const at = text[cursor] ?? "";
  // Draw a cursor cell before a line break without consuming the break itself.
  return at === "\n"
    ? { before, at: "↵", after: text.slice(cursor) }
    : { before, at, after: text.slice(cursor + (at ? 1 : 0)) };
}

// ---------------------------------------------------------------------------------------------
// Mouse decoding at the input layer (TUI renderer T1 — mechanism report Q3 + Q7 cure 3).
//
// mount.ts enables SGR mouse reporting (\x1b[?1002h\x1b[?1006h): a wheel notch arrives as
// "\x1b[<64;COL;ROWM" (up) / "\x1b[<65;COL;ROWM" (down); clicks/releases/motion arrive in the
// same grammar with other button codes. A terminal that honors 1002 but not 1006 answers in the
// legacy X10 format instead: "\x1b[M" + three payload bytes (button+32, col+32, row+32). Wheel
// is a FIRST-CLASS input event (`WheelEvent`, consumed by the scroll model); button/drag reports
// become `PointerEvent`s for selection and cursor placement. The structural rule: mouse bytes are
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

export type PointerEvent = {
  kind: "press" | "drag" | "release";
  button: number;
  column: number;
  row: number;
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
};

/** Keep only the latest drag coordinate per paint interval. A trackpad can deliver many reports
 * before Ink finishes one frame; rendering every intermediate selection makes the highlight
 * trail the pointer. Press/release stay synchronous, and release's final coordinate supersedes
 * any queued drag so no endpoint is lost. */
export function makePointerCoalescer(deliver: (event: PointerEvent) => void, intervalMs = 16): {
  push(event: PointerEvent): void;
  dispose(): void;
} {
  let pending: PointerEvent | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const cancel = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    pending = null;
  };
  const flush = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    const latest = pending;
    pending = null;
    if (latest) deliver(latest);
  };
  return {
    push(event) {
      if (event.kind !== "drag") {
        // A release can arrive in the same stdin read as the final drag. Deliver that drag first;
        // dropping it makes short, fast drags appear to select nothing at all.
        flush();
        deliver(event);
        return;
      }
      pending = event;
      if (timer === null) timer = setTimeout(() => {
        timer = null;
        const latest = pending;
        pending = null;
        if (latest) deliver(latest);
      }, intervalMs);
    },
    dispose: cancel,
  };
}

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

function pointerFromButton(button: number, column: number, row: number, release: boolean): PointerEvent | null {
  const base = button & ~MOUSE_MODIFIER_BITS;
  if (base >= 64 || (base !== 3 && base > 2 && (base < 32 || base > 34))) return null;
  return {
    kind: release || base === 3 ? "release" : base >= 32 ? "drag" : "press",
    button: base >= 32 ? base - 32 : base === 3 ? 0 : base,
    column, row,
    shift: (button & 4) !== 0,
    alt: (button & 8) !== 0,
    ctrl: (button & 16) !== 0,
  };
}

/** Button coordinates are 1-based terminal cells. Unsupported mouse buttons remain swallowed. */
export function decodePointer(seq: string): PointerEvent | null {
  const sgr = SGR_COMPLETE_RE.exec(seq);
  if (sgr) return pointerFromButton(Number(sgr[1]), Number(sgr[2]), Number(sgr[3]), seq.endsWith("m"));
  const legacy = LEGACY_COMPLETE_RE.exec(seq);
  if (!legacy) return null;
  const prefixLength = seq.startsWith("\x1b") ? 3 : 2;
  return pointerFromButton(seq.charCodeAt(prefixLength) - 32, seq.charCodeAt(prefixLength + 1) - 32, seq.charCodeAt(prefixLength + 2) - 32, false);
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
 *  first-class `WheelEvent`s, routes pointer reports, and forwards genuine key/text
 *  bytes untouched. A dead mouse prefix (entered mouse-only grammar, then broke) is DROPPED, not
 *  flushed — partial mouse CSI never becomes text. One instance per input stream's lifetime: a
 *  fresh instance per chunk would lose the carried tail. */
export function createMouseFilter(onWheel?: (event: WheelEvent, row: number, column: number) => void): (chunk: string) => { text: string; wheel: WheelEvent[]; pointer?: PointerEvent[] } {
  let pending = "";

  return (chunk: string) => {
    const hadPending = pending !== "";
    const data = pending + chunk;
    pending = "";
    let text = "";
    const wheel: WheelEvent[] = [];
    const pointer: PointerEvent[] = [];
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
        if (ev) { wheel.push(ev); onWheel?.(ev, Number(sgr[3]), Number(sgr[2])); }
        else {
          const p = decodePointer(sgr[0]);
          if (p) pointer.push(p);
        }
        mouseContext = true;
        i = esc + sgr[0].length;
        continue;
      }
      if (rest.startsWith("\x1b[M") && rest.length >= LEGACY_REPORT_LEN) {
        const ev = wheelFromButton(rest.charCodeAt(3) - 32);
        if (ev) { wheel.push(ev); onWheel?.(ev, rest.charCodeAt(5) - 32, rest.charCodeAt(4) - 32); }
        else {
          const p = decodePointer(rest.slice(0, LEGACY_REPORT_LEN));
          if (p) pointer.push(p);
        }
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
    return pointer.length > 0 ? { text, wheel, pointer } : { text, wheel };
  };
}
