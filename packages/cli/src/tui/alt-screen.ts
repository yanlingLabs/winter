/** Alt-screen pager SPIKE (phase 3b Task 1) — pure escape-sequence writers behind an injectable
 *  sink so tests can assert exact bytes without touching real stdout. `enterAltScreen` switches the
 *  terminal to its alternate screen buffer (`\x1b[?1049h`) — which by itself already leaves the
 *  normal buffer + scrollback untouched underneath (that's the terminal's own save/restore
 *  contract for private mode 1049) — then additionally clears the (now-alternate) buffer and homes
 *  the cursor (`\x1b[2J\x1b[H`) so the pager starts on a clean screen instead of whatever the
 *  alternate buffer last held. `leaveAltScreen` switches back (`\x1b[?1049l`), which restores the
 *  normal buffer's content and cursor position exactly as the terminal saved them on entry. */

export function enterAltScreen(write: (s: string) => void): void {
  write("\x1b[?1049h\x1b[2J\x1b[H");
}

export function leaveAltScreen(write: (s: string) => void): void {
  write("\x1b[?1049l");
}

/** SGR mouse tracking (phase 3c Task 1) — mode 1000 reports button press/release/motion-while-pressed,
 *  mode 1006 switches the REPORTING FORMAT to SGR (`\x1b[<btn;x;yM`/`m`, decimal coordinates with no
 *  upper bound and an unambiguous M/m press/release suffix) instead of the legacy X10 format (which
 *  encodes coordinates as raw bytes offset by 32 and breaks past column/row 223). Scroll-wheel clicks
 *  are reported as synthetic "buttons" 64 (up) / 65 (down) within this same stream — there is no
 *  separate wheel-tracking mode to enable. Both modes are entered/left together since 1006 only
 *  changes 1000's report format and is meaningless on its own. */
export function enableMouseTracking(write: (s: string) => void): void {
  write("\x1b[?1000h\x1b[?1006h");
}

export function disableMouseTracking(write: (s: string) => void): void {
  write("\x1b[?1006l\x1b[?1000l");
}

// Mouse REPORT decoding used to live here (`parseMouseInput` / `createMouseReportFilter`) — it
// moved to input-model.ts (TUI renderer T1: `decodeMouse` / `createMouseFilter` /
// `isMouseArtifact`), where the decode is a first-class part of the input layer instead of a
// regex filter bolted beside it. This module keeps only the tracking-mode escapes above.
