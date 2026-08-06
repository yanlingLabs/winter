/** TUI renderer T4 — the damage-bounded frame writer (mechanism report Q5 perf + Q7 cure 4,
 *  ADAPTED — no CC code, only the mechanism: repaint cost bounded by DAMAGE, never frame height).
 *
 *  CC's engine diffs a packed cell grid with per-node damage rects; Norma doesn't need the grid —
 *  the transcript is already a line log of pre-wrapped strings, so a LINE differ gets the same
 *  bound with a fraction of the machinery (the mechanism report's own "Renderer design
 *  implications" call). The pieces, layered pure→stream:
 *
 *   - `diffFrames(prev, next)` — pure: per-row string equality (rows are OPAQUE strings, ANSI
 *     included — a styling-only change is a change), changed rows out as ops, vanished rows
 *     (shrink) as explicit clear ops. O(rows) compares, O(damage) ops.
 *   - `renderOps(ops, totalRows)` — pure serializer: for each op an absolute cursor position
 *     (CSI row;1H, 1-based), the row text, and EL (CSI K, clear-to-EOL — erases any residue of a
 *     longer previous row); the whole batch wrapped in ONE BSU/ESU synchronized-update envelope
 *     with the cursor parked on the frame's last row at the end (cursor discipline: Ink keeps the
 *     terminal cursor HIDDEN for the app's whole life — log-update's cliCursor.hide — and Norma's
 *     composer paints its own inverse-video cursor glyph, so the park is escape-hygiene for
 *     tmux/emulator cursor-perturbation self-healing, not a visible-caret decision; absolute
 *     addressing per op replaces CC's CSI H + relative-move anchoring).
 *   - `makeDiffingWriter(out)` — the stateful boundary: full repaint (erase-screen INSIDE the sync
 *     envelope, then every row) on the first write and after `reset()` (SIGWINCH/resize,
 *     alt-screen re-entry); every other write diffs against the previous frame and writes ONLY
 *     the damage — one `out.write` per frame, zero writes when nothing changed. Defensive clamp
 *     (CAUTION 1): a frame taller than the live viewport is truncated to `out.rows` BEFORE
 *     diffing/recording, so absolute addressing never wraps at the terminal's bottom-row clamp
 *     and the writer never records rows it couldn't have painted.
 *   - `extractInkFrame(chunk)` — pure: strips the cursor/erase PRELUDE Ink's own writers prepend
 *     (log-update's eraseLines loop `\x1b[2K`/`\x1b[1A`/`\x1b[G`; the taller-than-viewport
 *     branch's ansi-escapes clearTerminal `\x1b[2J\x1b[3J\x1b[H`, `\x1b[0f` on old Windows) plus
 *     the one trailing `\n` log-update appends — leaving the bare frame text. Interior escapes
 *     (SGR styling) are untouched; a prelude-only chunk (log-update's `clear()`) extracts to the
 *     empty frame, which diffs to clear-everything.
 *   - `makeDiffingStdout(real)` — the Ink-facing stream: the same full-WriteStream Proxy shape as
 *     `makeSyncStdout` (see sync-stdout.ts's doc comment for why methods are bound to the REAL
 *     stream, never the proxy — the private-field brand-check hazard), but `write` routes every
 *     string chunk through extract→diff→damage-write instead of BSU-wrapping the full frame.
 *
 *  THE KILL-SWITCH: mount.ts consults `NORMA_TUI_DIFF` — `"0"` bypasses this module entirely
 *  (today's `makeSyncStdout` write-through), the plan's renderer-vs-writer bisect hatch. */

import { BSU, ESU } from "./alt-screen";

export type RowOp = { row: number; text: string };

/** Changed rows only, ascending; a vanished row (shrink) is `{ row, text: "" }`. Rows are opaque
 *  strings — byte equality, ANSI and all. Never indexes past either frame (CAUTION 1). */
export function diffFrames(prev: string[], next: string[]): RowOp[] {
  const ops: RowOp[] = [];
  const max = Math.max(prev.length, next.length);
  for (let i = 0; i < max; i++) {
    const p = i < prev.length ? prev[i] : undefined;
    const n = i < next.length ? next[i] : undefined;
    if (p === n) continue;
    ops.push({ row: i, text: n ?? "" });
  }
  return ops;
}

const ERASE_SCREEN = "\x1b[2J";
const EL = "\x1b[K"; // erase to end of line — clears residue when the new row is shorter
const posRow = (row0: number): string => `\x1b[${row0 + 1};1H`; // CSI params are 1-based

/** One op = position + text + EL (concatenated, given order). */
function opsBody(ops: RowOp[]): string {
  let body = "";
  for (const op of ops) body += posRow(op.row) + op.text + EL;
  return body;
}

/** Cursor park — the frame's last row (row 1 for an empty frame: CSI row 0 is malformed). */
function park(totalRows: number): string {
  return `\x1b[${Math.max(1, totalRows)};1H`;
}

/** Deterministic damage serialization: `""` for zero ops (nothing is written at all), else ONE
 *  BSU/ESU-wrapped string of per-op position+text+EL, cursor parked on the last frame row. */
export function renderOps(ops: RowOp[], totalRows: number): string {
  if (ops.length === 0) return "";
  return BSU + opsBody(ops) + park(totalRows) + ESU;
}

export type DiffingWriter = { write(frame: string): void; reset(): void };

/** The stateful diffing boundary over a real stream. `frame` is the BARE frame text (no Ink
 *  prelude, no trailing newline — `extractInkFrame`'s output); rows are its `\n`-split lines.
 *  First write and first-write-after-`reset()` repaint fully (erase-screen inside the sync
 *  envelope — the mechanism report's resize rule: the erase swaps atomically with the repaint
 *  instead of blanking the screen for the re-render gap); all else is diffed damage. */
export function makeDiffingWriter(out: NodeJS.WriteStream): DiffingWriter {
  let prev: string[] | null = null;
  return {
    write(frame: string): void {
      let rows = frame === "" ? [] : frame.split("\n");
      // CAUTION 1 — defensive viewport clamp: Ink can transiently emit frames taller than the
      // terminal (its own outputHeight >= rows branch). Absolute addressing past the bottom row
      // clamps AT the bottom row (every excess line overpainting the same row), so truncate
      // before painting AND before recording — the writer never carries rows it didn't paint.
      const limit = typeof out.rows === "number" && out.rows > 0 ? out.rows : Infinity;
      if (rows.length > limit) rows = rows.slice(0, limit);
      if (prev === null) {
        const all = rows.map((text, row) => ({ row, text }));
        out.write(BSU + ERASE_SCREEN + opsBody(all) + park(rows.length) + ESU);
      } else {
        const s = renderOps(diffFrames(prev, rows), rows.length);
        if (s !== "") out.write(s); // zero damage ⇒ zero bytes
      }
      prev = rows;
    },
    reset(): void {
      prev = null;
    },
  };
}

/** Ink's own write preludes (see the module doc comment): log-update's eraseLines loop and
 *  ansi-escapes' clearTerminal — matched as a leading run of exactly these tokens, nothing else
 *  (interior/frame escapes such as SGR styling never match at index 0 once the run ends). */
const INK_PRELUDE = /^(?:\x1b\[2K|\x1b\[1A|\x1b\[G|\x1b\[2J|\x1b\[3J|\x1b\[H|\x1b\[0f)+/;

/** Bare frame text out of an Ink stdout chunk: leading prelude stripped, ONE trailing `\n`
 *  (log-update's own append) stripped. A prelude-only chunk (log-update `clear()`) → `""`. */
export function extractInkFrame(chunk: string): string {
  const stripped = chunk.replace(INK_PRELUDE, "");
  return stripped.endsWith("\n") ? stripped.slice(0, -1) : stripped;
}

export type DiffingStdout = { stream: NodeJS.WriteStream; reset(): void };

/** The Ink-facing stream for mount.ts: a full-WriteStream Proxy over `real` whose `write` routes
 *  string chunks through extract→diff→damage; everything else forwards to the real stream, live
 *  (Ink reads `columns`/`rows` fresh per layout and subscribes 'resize' on this object). `reset`
 *  exposes the writer's full-repaint trigger for mount.ts's resize/re-entry hooks. Non-string
 *  chunks pass through untouched (Ink only ever writes strings — same posture as sync-stdout). */
export function makeDiffingStdout(real: NodeJS.WriteStream): DiffingStdout {
  const writer = makeDiffingWriter(real);
  const wrappedWrite = (
    chunk: unknown,
    encodingOrCallback?: unknown,
    callback?: unknown,
  ): boolean => {
    if (typeof chunk !== "string") {
      return (real.write as (...a: unknown[]) => boolean)(chunk, encodingOrCallback, callback);
    }
    if (chunk !== "") writer.write(extractInkFrame(chunk));
    // Honor the Writable callback contract for any caller that awaits it — the damage write (if
    // any) has already been handed to the real stream synchronously above.
    const cb = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
    if (typeof cb === "function") (cb as () => void)();
    return true;
  };
  const stream = new Proxy(real, {
    get(target, prop, _receiver) {
      if (prop === "write") return wrappedWrite;
      const value = (target as unknown as Record<PropertyKey, unknown>)[prop];
      return typeof value === "function" ? value.bind(target) : value;
    },
    set(target, prop, value) {
      (target as unknown as Record<PropertyKey, unknown>)[prop] = value;
      return true;
    },
  }) as NodeJS.WriteStream;
  return { stream, reset: () => writer.reset() };
}
