import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { render } from "ink-testing-library";
import { AgentsApp, AgentsView, mountAgentsFullscreen } from "../../src/tui/agents-view";
import {
  AGENTS_EMPTY_STATE, AGENTS_KEY_HINT, applyActivityEvent, applySessionList, emptyAgentsState,
  moveSelection, withNotice, AgentsStore,
} from "../../src/agents-cli";

// session-activity-hygiene T9: the Ink surface of `norma agents`. Content assertions only (the
// codebase's own rule for these render tests — "assert content, not ANSI"), which is exactly why the
// selected row's marker is a plain "▶ " rather than a color.

const T0 = 1_700_000_000_000;

function seeded() {
  return applySessionList(emptyAgentsState(), [
    { sessionId: "s_bg", activity: "background", title: "Fix the reaper", mode: "code" },
    { sessionId: "s_active", activity: "active", title: "Refactor the hub", mode: "code" },
  ], T0);
}

describe("<AgentsView>", () => {
  test("EMPTY STATE: says 'no background sessions' — never a blank screen", () => {
    const { lastFrame } = render(<AgentsView state={emptyAgentsState()} nowMs={T0} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain(AGENTS_EMPTY_STATE);
    expect(frame).toContain(AGENTS_KEY_HINT); // the verbs stay reachable/visible even with no rows
  });

  test("renders state, title and the running-for span per row", () => {
    const { lastFrame } = render(<AgentsView state={seeded()} nowMs={T0 + 252_000} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("background");
    expect(frame).toContain("Fix the reaper");
    expect(frame).toContain("active");
    expect(frame).toContain("Refactor the hub");
    expect(frame).toContain("≥4m 12s"); // a state already set when the roster opened: a LOWER bound
    expect(frame).toContain("s_bg");
  });

  test("a WITNESSED transition drops the ≥ — the roster knows when that span started", () => {
    const s = applyActivityEvent(seeded(), { sessionId: "s_active", activity: "background", ts: T0 + 1_000 }, T0 + 1_000);
    const frame = render(<AgentsView state={s} nowMs={T0 + 31_000} />).lastFrame() ?? "";
    expect(frame).toContain("30s");
    expect(frame).not.toContain("≥30s");
  });

  test("the selected row is marked with a plain-ASCII ▶ pointer, and only one row is", () => {
    const frame = render(<AgentsView state={seeded()} nowMs={T0} />).lastFrame() ?? "";
    expect(frame.split("\n").filter((l) => l.includes("▶")).length).toBe(1);
    // Selection starts on the first row (background sorts first).
    expect(frame.split("\n").find((l) => l.includes("▶"))).toContain("Fix the reaper");
  });

  test("moving the selection moves the pointer", () => {
    const frame = render(<AgentsView state={moveSelection(seeded(), 1)} nowMs={T0} />).lastFrame() ?? "";
    expect(frame.split("\n").find((l) => l.includes("▶"))).toContain("Refactor the hub");
  });

  test("a verb's notice is shown — the daemon's own answer, not a guess", () => {
    const frame = render(<AgentsView state={withNotice(seeded(), "s_bg → archived")} nowMs={T0} />).lastFrame() ?? "";
    expect(frame).toContain("s_bg → archived");
  });

  test("the open verb's notice is the exact resume command", () => {
    const frame = render(<AgentsView state={withNotice(seeded(), "norma resume s_bg")} nowMs={T0} />).lastFrame() ?? "";
    expect(frame).toContain("norma resume s_bg");
  });

  test("an untitled row (added by a transient before the next poll) shows its id, not a gap", () => {
    const s = applyActivityEvent(emptyAgentsState(), { sessionId: "s_bare", activity: "background", ts: T0 }, T0);
    expect(render(<AgentsView state={s} nowMs={T0} />).lastFrame() ?? "").toContain("s_bare");
  });

  // T9 amendment: the cwd column, restored once `SessionListResult` declared the field the daemon
  // had always been sending.
  test("renders the cwd column, home-collapsed", () => {
    const s = applySessionList(emptyAgentsState(), [
      { sessionId: "s_bg", activity: "background", title: "Fix the reaper", cwd: "/Users/x/code/norma" },
    ], T0);
    const frame = render(<AgentsView state={s} nowMs={T0} home="/Users/x" />).lastFrame() ?? "";
    expect(frame).toContain("~/code/norma");
  });

  test("a session with no recorded cwd renders a dash, not a fabricated path", () => {
    const s = applySessionList(emptyAgentsState(), [
      { sessionId: "s_bg", activity: "background", title: "Fix the reaper" },
    ], T0);
    const frame = render(<AgentsView state={s} nowMs={T0} home="/Users/x" />).lastFrame() ?? "";
    expect(frame).toContain("—");
  });

  test("a long title is truncated with an ellipsis rather than wrapping the row", () => {
    const s = applySessionList(emptyAgentsState(), [
      { sessionId: "s_long", activity: "background", title: "x".repeat(80) },
    ], T0);
    const frame = render(<AgentsView state={s} nowMs={T0} />).lastFrame() ?? "";
    expect(frame).toContain("…");
    expect(frame).not.toContain("x".repeat(41));
  });
});

// -------------------------------------------------------------------------------------------
// Bugfix pass B3 — the FULLSCREEN layout. With `frameRows` set the view is an alt-screen frame:
// exact height, key hint pinned to the bottom row, roster windowed by `planAgentsViewport` +
// `listStart` with honest overflow markers. Without `frameRows` the legacy inline layout above is
// byte-identical (those tests are the pin).
// -------------------------------------------------------------------------------------------

function manyRows(n: number) {
  return applySessionList(emptyAgentsState(), Array.from({ length: n }, (_, i) => ({
    sessionId: `s_${String(i).padStart(2, "0")}`,
    activity: "background",
    title: `task ${String(i).padStart(2, "0")}`,
  })), T0);
}

describe("<AgentsView> fullscreen (frameRows)", () => {
  test("the frame is exactly frameRows tall with the key hint on the LAST row", () => {
    const { lastFrame } = render(<AgentsView state={seeded()} nowMs={T0} frameRows={12} />);
    const lines = (lastFrame() ?? "").split("\n");
    expect(lines.length).toBe(12);
    expect(lines.at(-1)!).toContain("q quit"); // AGENTS_KEY_HINT's tail — pinned to the bottom
  });

  test("the empty state still says so, at full frame height", () => {
    const { lastFrame } = render(<AgentsView state={emptyAgentsState()} nowMs={T0} frameRows={10} />);
    const lines = (lastFrame() ?? "").split("\n");
    expect(lines.length).toBe(10);
    expect(lines.join("\n")).toContain(AGENTS_EMPTY_STATE);
  });

  test("overflow: only the window's rows render, with honest ↑/↓ N more markers", () => {
    // frame 8 → 6 available → markers reserve 2 → 4 shown of 10.
    const frame = render(<AgentsView state={manyRows(10)} nowMs={T0} frameRows={8} listStart={3} />).lastFrame() ?? "";
    expect(frame).toContain("↑ 3 more");
    expect(frame).toContain("↓ 3 more");
    expect(frame).toContain("task 03");
    expect(frame).toContain("task 06");
    expect(frame).not.toContain("task 02");
    expect(frame).not.toContain("task 07");
  });

  test("overflow at the top edge: no ↑ marker text, the ↓ marker counts everything below", () => {
    const frame = render(<AgentsView state={manyRows(10)} nowMs={T0} frameRows={8} listStart={0} />).lastFrame() ?? "";
    expect(frame).not.toContain("… ↑"); // the marker, not the key hint's own ↑↓ glyphs
    expect(frame).toContain("… ↓ 6 more");
    expect(frame).toContain("task 00");
    // Rows truncate to ONE physical line each in fullscreen (never wrap), so the frame height
    // math holds exactly: title + reserved marker + 4 rows + marker + hint = 8.
    expect((frame.split("\n")).length).toBe(8);
  });

  test("a notice renders above the hint, inside the frame", () => {
    const s = withNotice(seeded(), "norma resume s_bg");
    const lines = (render(<AgentsView state={s} nowMs={T0} frameRows={12} />).lastFrame() ?? "").split("\n");
    expect(lines.length).toBe(12);
    expect(lines.at(-2)!).toContain("norma resume s_bg"); // the dismissible hand-off line
    expect(lines.at(-1)!).toContain("q quit");
  });
});

// -------------------------------------------------------------------------------------------
// B3 — <AgentsApp> input mechanics, driven through ink-testing-library's real stdin (the
// app.test.tsx idiom): keys route through the pure keymap; mouse reports are decoded AT THE INPUT
// LAYER (the main TUI's emitter-patch mechanism) — a wheel notch becomes the arrows' own move
// action and the report's printable remnant never falls into the letter keymap as text.
// -------------------------------------------------------------------------------------------

const wait = (ms = 20) => new Promise((r) => setTimeout(r, ms));

describe("<AgentsApp> — input mechanics", () => {
  test("keys route through the keymap: q is a quit action", async () => {
    const actions: unknown[] = [];
    const { stdin } = render(<AgentsApp store={new AgentsStore()} onAction={(a) => actions.push(a)} />);
    await wait();
    stdin.write("q");
    await wait();
    expect(actions).toEqual([{ kind: "quit" }]);
  });

  test("wheel-at-input: SGR wheel reports become move actions, one row per notch, and never leak as keys", async () => {
    const actions: unknown[] = [];
    const { stdin } = render(<AgentsApp store={new AgentsStore()} onAction={(a) => actions.push(a)} />);
    await wait();
    stdin.write("\x1b[<64;10;5M"); // wheel up
    await wait();
    stdin.write("\x1b[<65;10;5M"); // wheel down
    await wait();
    expect(actions).toEqual([{ kind: "move", delta: -1 }, { kind: "move", delta: 1 }]);
  });
});

// -------------------------------------------------------------------------------------------
// B3 — the mount: `norma agents` goes through the SAME fullscreen machinery as the main TUI
// (mount.ts's scaffold: alt-screen escapes, the damage-diffing writer WITH the B1 cursor-escape
// pass-through, mouse tracking, exit hygiene). These mirror mount.test.ts's seams: injected
// render, escape sink, stdout stream — no real terminal.
// -------------------------------------------------------------------------------------------

const ENTER = "\x1b[?1049h\x1b[2J\x1b[H";
const MOUSE_ON = "\x1b[?1000h\x1b[?1006h";
const MOUSE_OFF = "\x1b[?1006l\x1b[?1000l";
const LEAVE = "\x1b[?1049l";
const BSU = "\x1b[?2026h";
const ERASE_SCREEN = "\x1b[2J";

function escName(s: string): string {
  return s === ENTER ? "ENTER" : s === MOUSE_ON ? "MOUSE_ON" : s === MOUSE_OFF ? "MOUSE_OFF" : s === LEAVE ? "LEAVE" : `?${JSON.stringify(s)}`;
}

function fakeStdoutStream(): { stream: NodeJS.WriteStream; writes: string[] } {
  const writes: string[] = [];
  const em = new EventEmitter() as unknown as Record<string, unknown>;
  em.rows = 24;
  em.columns = 80;
  em.isTTY = true;
  em.write = (chunk: unknown) => { writes.push(String(chunk)); return true; };
  return { stream: em as unknown as NodeJS.WriteStream, writes };
}

function withTty<T>(fn: () => T): T {
  const prev = process.stdout.isTTY;
  (process.stdout as unknown as { isTTY: boolean }).isTTY = true;
  try { return fn(); } finally { (process.stdout as unknown as { isTTY: boolean }).isTTY = prev; }
}

const mountArgs = () => ({ store: new AgentsStore(), onAction: () => {} });

describe("mountAgentsFullscreen — the alt-screen mount (B3)", () => {
  test("non-TTY: never renders, never writes an escape, resolves immediately", async () => {
    const prev = process.stdout.isTTY;
    (process.stdout as unknown as { isTTY: boolean }).isTTY = false;
    try {
      let renders = 0;
      const writes: string[] = [];
      const handle = mountAgentsFullscreen(
        mountArgs(),
        () => { renders += 1; return { unmount() {}, waitUntilExit: () => new Promise<void>(() => {}) }; },
        (s) => writes.push(s),
      );
      expect(renders).toBe(0);
      expect(writes).toEqual([]);
      handle.unmount(); // safe no-op on the headless path
      let resolved = false;
      await Promise.race([handle.waitUntilExit().then(() => { resolved = true; }), new Promise((r) => setTimeout(r, 30))]);
      expect(resolved).toBe(true);
    } finally {
      (process.stdout as unknown as { isTTY: boolean }).isTTY = prev;
    }
  });

  test("TTY: renders once with the alt-screen escapes first, a stdout proxy and Ink's ctrl+C exit disabled", () => {
    withTty(() => {
      let renders = 0;
      const writes: string[] = [];
      let opts: unknown;
      mountAgentsFullscreen(
        mountArgs(),
        (_node, o) => { renders += 1; opts = o; return { unmount() {}, waitUntilExit: () => new Promise<void>(() => {}) }; },
        (s) => writes.push(s),
      );
      expect(renders).toBe(1);
      expect(writes).toEqual([ENTER, MOUSE_ON]);
      expect((opts as { exitOnCtrlC?: boolean }).exitOnCtrlC).toBe(false);
      expect(typeof (opts as { stdout?: { write?: unknown } }).stdout?.write).toBe("function");
    });
  });

  test("exit hygiene: unmount() → mouse-off → unmount; waitUntilExit → LEAVE last (B1's order)", async () => {
    await withTty(async () => {
      const order: string[] = [];
      let resolveExit!: () => void;
      const exitP = new Promise<void>((r) => { resolveExit = r; });
      const handle = mountAgentsFullscreen(
        mountArgs(),
        () => ({
          unmount: () => { order.push("unmount"); },
          waitUntilExit: () => { order.push("waitUntilExit"); return exitP; },
        }),
        (s) => order.push(escName(s)),
      );
      expect(order).toEqual(["ENTER", "MOUSE_ON"]);
      handle.unmount();
      handle.unmount(); // idempotent — the runner's quit path may race a ctrl+C
      resolveExit();
      await handle.waitUntilExit();
      expect(order).toEqual(["ENTER", "MOUSE_ON", "MOUSE_OFF", "unmount", "waitUntilExit", "LEAVE"]);
    });
  });

  test("B1 on THIS surface: frames are damage-diffed and a bare cursor-visibility chunk passes through without wiping the paint", () => {
    withTty(() => {
      const prevDiff = process.env.NORMA_TUI_DIFF;
      delete process.env.NORMA_TUI_DIFF;
      try {
        const { stream, writes } = fakeStdoutStream();
        let inkStdout: NodeJS.WriteStream | undefined;
        mountAgentsFullscreen(
          mountArgs(),
          (_node, o) => {
            inkStdout = (o as { stdout: NodeJS.WriteStream }).stdout;
            return { unmount() {}, waitUntilExit: () => new Promise<void>(() => {}) };
          },
          () => {},
          stream,
        );
        inkStdout!.write("a\nb\n"); // Ink's first frame
        expect(writes.length).toBe(1);
        expect(writes[0]).toContain(BSU);
        expect(writes[0]).toContain(ERASE_SCREEN); // full first paint
        inkStdout!.write("\x1b[?25l"); // Ink's componentDidMount cliCursor.hide — control, NOT a frame
        expect(writes.length).toBe(2);
        expect(writes[1]).toBe("\x1b[?25l"); // verbatim pass-through
        inkStdout!.write("\x1b[2K\x1b[1A\x1b[2K\x1b[G" + "a\nb\n"); // identical frame re-render
        expect(writes.length).toBe(2); // zero damage ⇒ zero bytes — prev untouched by the control chunk
      } finally {
        if (prevDiff === undefined) delete process.env.NORMA_TUI_DIFF;
        else process.env.NORMA_TUI_DIFF = prevDiff;
      }
    });
  });
});
