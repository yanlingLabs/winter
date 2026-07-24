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

export type WheelEvent = { dir: "up" | "down" };

// SGR mouse report: CSI < Cb ; Cx ; Cy (M|m). Cb=64 is wheel-up, Cb=65 is wheel-down; any other Cb
// (button press/release/motion) is mouse activity we still want to swallow (so it doesn't get
// misread as literal characters by whatever's driving useInput) but carries no wheel event.
const SGR_MOUSE_RE = /^\x1b\[<(\d+);(\d+);(\d+)[Mm]$/;

export function parseMouseInput(input: string): { wheel?: WheelEvent; isMouse: boolean } {
  const match = SGR_MOUSE_RE.exec(input);
  if (!match) return { isMouse: false };
  const code = Number(match[1]);
  if (code === 64) return { isMouse: true, wheel: { dir: "up" } };
  if (code === 65) return { isMouse: true, wheel: { dir: "down" } };
  return { isMouse: true };
}

// tui-mouse fix — `parseMouseInput` above is ^...$-anchored: it only ever recognizes a STRING that
// IS exactly one complete SGR report. Ink's App.js reads raw stdin with `stdin.read()` inside a
// `while` loop and emits one "input" event per read — a burst of rapid trackpad-scroll reports can
// land concatenated in a single read (`\x1b[<64;x;yM\x1b[<64;x;yM…`), or a single report can just as
// easily be split across two separate reads at a buffer boundary. Either way the anchored regex
// fails to match the WHOLE chunk, `parseMouseInput` returns `{isMouse:false}`, and the raw ESC bytes
// fall through to Ink's own `useInput` (`parse-keypress.js`, vendored from `enquirer`) — which does
// not understand the SGR `ESC[<...M` grammar at all, strips only the single leading ESC byte, and
// hands the rest to the composer as literal typed text. That's the observed
// `[<64;116;23M16;23M16;23M…` leak.
//
// A report anchored only at the START — used to find/consume one complete report at the front of a
// (possibly multi-report) buffer, leaving whatever follows for the next loop iteration.
const SGR_MOUSE_HEAD_RE = /^\x1b\[<(\d+);(\d+);(\d+)[Mm]/;

// The longest prefix of a report that hasn't been terminated by M/m yet but could STILL become one
// as more bytes arrive (digits/semicolons only, at most 2 semicolons). Bounded by MAX_PARTIAL_BUFFER
// below so a stream that merely happens to start with "\x1b[<" can't buffer forever.
const SGR_MOUSE_PARTIAL_RE = /^\x1b\[<\d*(?:;\d*(?:;\d*)?)?$/;
const MAX_PARTIAL_BUFFER = 32; // generous headroom over the longest realistic "\x1b[<255;9999;9999"

/** Stateful filter over RAW stdin chunks. Loop-consumes every complete SGR mouse report found
 *  anywhere in a chunk (there may be several — batched trackpad scroll), firing one wheel event per
 *  report, and carries a trailing PARTIAL report across chunk boundaries in its closure. Anything
 *  left over that isn't mouse-shaped — including a buffered prefix that turns out not to complete
 *  into a report — is returned as `literal`, so genuine typed text (which never contains a raw ESC
 *  byte, so never even matches the `\x1b[<` search below) is never dropped. One filter instance must
 *  be reused across an input stream's whole lifetime — a fresh instance per call would lose the
 *  partial-report buffer across chunks. */
export function createMouseReportFilter(): (chunk: string) => { literal: string; wheelEvents: WheelEvent[] } {
  let pending = "";

  return (chunk: string) => {
    const data = pending + chunk;
    pending = "";
    let literal = "";
    const wheelEvents: WheelEvent[] = [];
    let i = 0;
    while (i < data.length) {
      const rest = data.slice(i);
      const start = rest.indexOf("\x1b[<");
      if (start === -1) {
        literal += rest;
        break;
      }
      literal += rest.slice(0, start);
      const candidate = rest.slice(start);
      const head = SGR_MOUSE_HEAD_RE.exec(candidate);
      if (head) {
        const code = Number(head[1]);
        if (code === 64) wheelEvents.push({ dir: "up" });
        else if (code === 65) wheelEvents.push({ dir: "down" });
        i += start + head[0].length;
        continue;
      }
      if (candidate.length <= MAX_PARTIAL_BUFFER && SGR_MOUSE_PARTIAL_RE.test(candidate)) {
        pending = candidate; // could still complete on the next chunk — buffer and wait
        break;
      }
      // Looked like the start of a mouse report but can no longer become one — not mouse activity
      // after all. Flush just the one byte as literal and keep scanning past it for further reports.
      literal += candidate[0];
      i += start + 1;
    }
    return { literal, wheelEvents };
  };
}
