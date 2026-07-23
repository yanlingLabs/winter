import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { Composer, computeFileQuery, computeFileToken, computeSlashQuery } from "../../src/tui/composer";
import { appendHistory } from "../../src/tui/history-store";

// useInput wires its stdin listener inside a React effect, which runs on the next tick after
// render() returns (not synchronously) — same caveat spike.test.tsx documents. A short wait after
// render() (before the first write) and after each write (to let the resulting state update flush
// into a new frame) keeps every assertion below deterministic.
const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));

// T3 introduced an inverse-video cursor (`<Text inverse>`), which wraps its character in SGI escape
// codes (`\x1b[7m` ... `\x1b[27m`) even though the rest of the frame carries no color codes in this
// non-TTY test harness — same convention as flatten-blocks.test.ts's local stripAnsi helper.
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

const historyPath = (): string => join(mkdtempSync(join(tmpdir(), "norma-composer-")), "history.jsonl");

describe("Composer", () => {
  test("(a) type text + Enter while idle calls onSubmit once and clears the buffer", async () => {
    const submitted: string[] = [];
    const steered: string[] = [];
    const { stdin, lastFrame } = render(
      <Composer
        running={false}
        policy="ask"
        onSubmit={(text) => submitted.push(text)}
        onSteer={(text) => steered.push(text)}
        onInterrupt={() => {}}
        onCyclePolicy={() => {}}
        nowMs={0}
        historyPath={historyPath()}
      />,
    );
    await wait();
    stdin.write("hi");
    await wait();
    stdin.write("\r");
    await wait();

    expect(submitted).toEqual(["hi"]);
    expect(steered).toEqual([]);
    expect(stripAnsi(lastFrame() ?? "")).toContain("❯  "); // buffer cleared: prompt + inverse-space cursor
  });

  test("(b) type text + Enter while running calls onSteer, not onSubmit", async () => {
    const submitted: string[] = [];
    const steered: string[] = [];
    const { stdin } = render(
      <Composer
        running
        policy="ask"
        onSubmit={(text) => submitted.push(text)}
        onSteer={(text) => steered.push(text)}
        onInterrupt={() => {}}
        onCyclePolicy={() => {}}
        nowMs={0}
        historyPath={historyPath()}
      />,
    );
    await wait();
    stdin.write("go on");
    await wait();
    stdin.write("\r");
    await wait();

    expect(steered).toEqual(["go on"]);
    expect(submitted).toEqual([]);
  });

  test("(c) Esc while running calls onInterrupt", async () => {
    let interrupts = 0;
    const { stdin } = render(
      <Composer
        running
        policy="ask"
        onSubmit={() => {}}
        onSteer={() => {}}
        onInterrupt={() => { interrupts += 1; }}
        onCyclePolicy={() => {}}
        nowMs={0}
        historyPath={historyPath()}
      />,
    );
    await wait();
    stdin.write("\x1b"); // esc
    await wait();

    expect(interrupts).toBe(1);
  });

  test("(c2) Esc while running still interrupts even with text in the buffer (precedence #1 wins)", async () => {
    let interrupts = 0;
    const { stdin } = render(
      <Composer
        running
        policy="ask"
        onSubmit={() => {}}
        onSteer={() => {}}
        onInterrupt={() => { interrupts += 1; }}
        onCyclePolicy={() => {}}
        nowMs={0}
        historyPath={historyPath()}
      />,
    );
    await wait();
    stdin.write("some text");
    await wait();
    stdin.write("\x1b"); // esc — must interrupt, not enter double-esc-clear bookkeeping
    await wait();

    expect(interrupts).toBe(1);
  });

  // child-transcript-view T3: `onEscEmpty` (precedence #0) — provided + EMPTY buffer routes the
  // whole Esc there, outranking even the running-interrupt (see the prop's doc comment); with text
  // in the buffer it never fires and precedence #1 wins exactly as in (c2) above.
  test("(c3) Esc with onEscEmpty + empty buffer fires it INSTEAD of interrupt; text restores the old rules", async () => {
    let interrupts = 0;
    let closed = 0;
    const { stdin } = render(
      <Composer
        running
        policy="ask"
        onSubmit={() => {}}
        onSteer={() => {}}
        onInterrupt={() => { interrupts += 1; }}
        onCyclePolicy={() => {}}
        nowMs={0}
        historyPath={historyPath()}
        onEscEmpty={() => { closed += 1; }}
      />,
    );
    await wait();
    stdin.write("\x1b"); // esc on EMPTY buffer -> onEscEmpty only
    await wait();
    expect(closed).toBe(1);
    expect(interrupts).toBe(0);

    stdin.write("draft");
    await wait();
    stdin.write("\x1b"); // esc with TEXT -> precedence #1 (running-interrupt), onEscEmpty untouched
    await wait();
    expect(interrupts).toBe(1);
    expect(closed).toBe(1);
  });

  test("(d) Shift+Tab calls onCyclePolicy", async () => {
    let cycles = 0;
    const { stdin } = render(
      <Composer
        running={false}
        policy="ask"
        onSubmit={() => {}}
        onSteer={() => {}}
        onInterrupt={() => {}}
        onCyclePolicy={() => { cycles += 1; }}
        nowMs={0}
        historyPath={historyPath()}
      />,
    );
    await wait();
    stdin.write("\x1b[Z"); // shift+tab
    await wait();

    expect(cycles).toBe(1);
  });

  test("(e) disabled ignores typing and Enter", async () => {
    const submitted: string[] = [];
    const { stdin, lastFrame } = render(
      <Composer
        running={false}
        policy="ask"
        onSubmit={(text) => submitted.push(text)}
        onSteer={() => {}}
        onInterrupt={() => {}}
        onCyclePolicy={() => {}}
        nowMs={0}
        historyPath={historyPath()}
        disabled
      />,
    );
    const before = lastFrame() ?? "";
    await wait();
    stdin.write("hi");
    await wait();
    stdin.write("\r");
    await wait();

    expect(submitted).toEqual([]);
    expect(lastFrame() ?? "").toBe(before);
  });

  test("(f) backspace edits the buffer", async () => {
    const { stdin, lastFrame } = render(
      <Composer
        running={false}
        policy="ask"
        onSubmit={() => {}}
        onSteer={() => {}}
        onInterrupt={() => {}}
        onCyclePolicy={() => {}}
        nowMs={0}
        historyPath={historyPath()}
      />,
    );
    await wait();
    stdin.write("abc");
    await wait();
    stdin.write("\x7f"); // backspace
    await wait();

    expect(stripAnsi(lastFrame() ?? "")).toContain("❯ ab ");
  });

  test("(g) cursor position is reflected in the frame via the inverse-video character", async () => {
    const { stdin, lastFrame } = render(
      <Composer
        running={false}
        policy="ask"
        onSubmit={() => {}}
        onSteer={() => {}}
        onInterrupt={() => {}}
        onCyclePolicy={() => {}}
        nowMs={0}
        historyPath={historyPath()}
      />,
    );
    await wait();
    stdin.write("abc");
    await wait();
    stdin.write("\x1b[D"); // left
    await wait();
    stdin.write("\x1b[D"); // left again — cursor now sits on "b" (index 1)
    await wait();

    // The character UNDER the cursor ("b") is wrapped in SGI inverse-video codes; "a" and "c" (on
    // either side) are not — this is the only way to observe cursor position in a rendered frame,
    // since before+at+after always reassembles to the same "abc" once ANSI codes are stripped.
    expect(lastFrame() ?? "").toContain("[7mb[27m");
  });

  test("(h) left/right/insert: typing mid-text inserts at the cursor, not at the end", async () => {
    const submitted: string[] = [];
    const { stdin } = render(
      <Composer
        running={false}
        policy="ask"
        onSubmit={(text) => submitted.push(text)}
        onSteer={() => {}}
        onInterrupt={() => {}}
        onCyclePolicy={() => {}}
        nowMs={0}
        historyPath={historyPath()}
      />,
    );
    await wait();
    stdin.write("ac");
    await wait();
    stdin.write("\x1b[D"); // left — cursor between "a" and "c"
    await wait();
    stdin.write("b");
    await wait();
    stdin.write("\r");
    await wait();

    expect(submitted).toEqual(["abc"]);
  });

  test("(h2) real Forward-Delete (ESC [3~) deletes the char AT the cursor", async () => {
    const submitted: string[] = [];
    const { stdin } = render(
      <Composer
        running={false}
        policy="ask"
        onSubmit={(text) => submitted.push(text)}
        onSteer={() => {}}
        onInterrupt={() => {}}
        onCyclePolicy={() => {}}
        nowMs={0}
        historyPath={historyPath()}
      />,
    );
    await wait();
    stdin.write("abc");
    await wait();
    stdin.write("\x1b[H"); // Home — cursor to 0, sitting on "a"
    await wait();
    stdin.write("\x1b[3~"); // Forward-Delete — removes "a", cursor stays put
    await wait();
    stdin.write("\r");
    await wait();

    expect(submitted).toEqual(["bc"]);
  });

  test("(h3) ctrl+arrow word-jumps: edits land at both word boundaries end-to-end", async () => {
    const submitted: string[] = [];
    const { stdin } = render(
      <Composer
        running={false}
        policy="ask"
        onSubmit={(text) => submitted.push(text)}
        onSteer={() => {}}
        onInterrupt={() => {}}
        onCyclePolicy={() => {}}
        nowMs={0}
        historyPath={historyPath()}
      />,
    );
    await wait();
    stdin.write("foo bar");
    await wait();
    stdin.write("\x1b[1;5D"); // ctrl+left — word-left, cursor to the start of "bar" (index 4)
    await wait();
    stdin.write("X");
    await wait();
    stdin.write("\x1b[1;5C"); // ctrl+right — word-right, cursor past "Xbar" (end of text)
    await wait();
    stdin.write("!");
    await wait();
    stdin.write("\r");
    await wait();

    expect(submitted).toEqual(["foo Xbar!"]);
  });

  test("(i) Home/End/ctrl+a/ctrl+e move the cursor to the edges", async () => {
    const submitted: string[] = [];
    const { stdin } = render(
      <Composer
        running={false}
        policy="ask"
        onSubmit={(text) => submitted.push(text)}
        onSteer={() => {}}
        onInterrupt={() => {}}
        onCyclePolicy={() => {}}
        nowMs={0}
        historyPath={historyPath()}
      />,
    );
    await wait();
    stdin.write("bc");
    await wait();
    stdin.write("\x1b[H"); // Home (xterm) — cursor to 0
    await wait();
    stdin.write("a");
    await wait();
    stdin.write("\x05"); // ctrl+e — End
    await wait();
    stdin.write("d");
    await wait();
    stdin.write("\r");
    await wait();

    expect(submitted).toEqual(["abcd"]);
  });

  test("(i2) raw End sequences (ESC [F xterm, ESC [4~ vt220) move the cursor to the end", async () => {
    const submitted: string[] = [];
    const { stdin } = render(
      <Composer
        running={false}
        policy="ask"
        onSubmit={(text) => submitted.push(text)}
        onSteer={() => {}}
        onInterrupt={() => {}}
        onCyclePolicy={() => {}}
        nowMs={0}
        historyPath={historyPath()}
      />,
    );
    await wait();
    stdin.write("ab");
    await wait();
    stdin.write("\x1b[H"); // Home — cursor to 0
    await wait();
    stdin.write("\x1b[F"); // End (xterm) — cursor to end
    await wait();
    stdin.write("c");
    await wait();
    stdin.write("\x01"); // ctrl+a — Home again
    await wait();
    stdin.write("\x1b[4~"); // End (vt220) — cursor to end again
    await wait();
    stdin.write("d");
    await wait();
    stdin.write("\r");
    await wait();

    expect(submitted).toEqual(["abcd"]);
  });

  test("(j) history: ↑ recalls the newest entry, ↓ restores the in-progress draft", async () => {
    const path = historyPath();
    appendHistory(path, { display: "older prompt", ts: 1, sessionId: "s1" });
    appendHistory(path, { display: "newest prompt", ts: 2, sessionId: "s1" });

    const submitted: string[] = [];
    const { stdin } = render(
      <Composer
        running={false}
        policy="ask"
        onSubmit={(text) => submitted.push(text)}
        onSteer={() => {}}
        onInterrupt={() => {}}
        onCyclePolicy={() => {}}
        nowMs={0}
        historyPath={path}
        sessionId="s1"
      />,
    );
    await wait();
    stdin.write("my draft");
    await wait();
    stdin.write("\x1b[A"); // up — recalls "newest prompt", saving the draft
    await wait();
    stdin.write("\x1b[A"); // up again — walks to "older prompt"
    await wait();
    stdin.write("\x1b[B"); // down — back to "newest prompt"
    await wait();
    stdin.write("\x1b[B"); // down again — past the newest, restores the draft
    await wait();
    stdin.write("\r");
    await wait();

    expect(submitted).toEqual(["my draft"]);
  });

  test("(k) history: ↑ alone recalls and submits the newest entry verbatim", async () => {
    const path = historyPath();
    appendHistory(path, { display: "recall me", ts: 1, sessionId: "s1" });

    const submitted: string[] = [];
    const { stdin } = render(
      <Composer
        running={false}
        policy="ask"
        onSubmit={(text) => submitted.push(text)}
        onSteer={() => {}}
        onInterrupt={() => {}}
        onCyclePolicy={() => {}}
        nowMs={0}
        historyPath={path}
        sessionId="s1"
      />,
    );
    await wait();
    stdin.write("\x1b[A"); // up
    await wait();
    stdin.write("\r");
    await wait();

    expect(submitted).toEqual(["recall me"]);
  });

  test("(l) double-esc clears the buffer within the window; a single esc only hints", async () => {
    const hints: string[] = [];
    const path = historyPath();
    const { stdin, lastFrame, rerender } = render(
      <Composer
        running={false}
        policy="ask"
        onSubmit={() => {}}
        onSteer={() => {}}
        onInterrupt={() => {}}
        onCyclePolicy={() => {}}
        nowMs={1000}
        historyPath={path}
        onHint={(h) => hints.push(h)}
      />,
    );
    await wait();
    stdin.write("clear me");
    await wait();
    stdin.write("\x1b"); // first esc — hints, does NOT clear
    await wait();

    expect(hints).toEqual(["Esc again to clear"]);
    expect(stripAnsi(lastFrame() ?? "")).toContain("clear me");

    rerender(
      <Composer
        running={false}
        policy="ask"
        onSubmit={() => {}}
        onSteer={() => {}}
        onInterrupt={() => {}}
        onCyclePolicy={() => {}}
        nowMs={1700} // 700ms later — within the 800ms window
        historyPath={path}
        onHint={(h) => hints.push(h)}
      />,
    );
    await wait();
    stdin.write("\x1b"); // second esc within the window — clears
    await wait();

    expect(stripAnsi(lastFrame() ?? "")).toContain("❯  ");
    expect(stripAnsi(lastFrame() ?? "")).not.toContain("clear me");
  });

  test("(m) esc outside the double-esc window does not clear (treated as a fresh first press)", async () => {
    const hints: string[] = [];
    const path = historyPath();
    const { stdin, lastFrame, rerender } = render(
      <Composer
        running={false}
        policy="ask"
        onSubmit={() => {}}
        onSteer={() => {}}
        onInterrupt={() => {}}
        onCyclePolicy={() => {}}
        nowMs={1000}
        historyPath={path}
        onHint={(h) => hints.push(h)}
      />,
    );
    await wait();
    stdin.write("still here");
    await wait();
    stdin.write("\x1b"); // first esc at t=1000
    await wait();

    rerender(
      <Composer
        running={false}
        policy="ask"
        onSubmit={() => {}}
        onSteer={() => {}}
        onInterrupt={() => {}}
        onCyclePolicy={() => {}}
        nowMs={2000} // 1000ms later — OUTSIDE the 800ms window
        historyPath={path}
        onHint={(h) => hints.push(h)}
      />,
    );
    await wait();
    stdin.write("\x1b"); // second esc, but too late — treated as a new first press
    await wait();

    expect(hints).toEqual(["Esc again to clear", "Esc again to clear"]);
    expect(stripAnsi(lastFrame() ?? "")).toContain("still here");
  });

  test("(n) running: only the prompt glyph dims — buffer text carries no dim code, and the FIRST content frame after empty is well-formed", async () => {
    const { stdin, lastFrame } = render(
      <Composer
        running
        policy="ask"
        onSubmit={() => {}}
        onSteer={() => {}}
        onInterrupt={() => {}}
        onCyclePolicy={() => {}}
        nowMs={0}
        historyPath={historyPath()}
      />,
    );
    await wait();
    stdin.write("a"); // ONE char, asserted immediately — the Ink layout bug's trigger case is the
    await wait(); //     first content-growing render after empty (see composer.tsx render comment)

    const frame = lastFrame() ?? "";
    // Glyph dimmed, dim CLOSED before the buffer text, then the un-dimmed "a" and the inverse
    // cursor — the exact byte layout, so a whole-line dim (or a dim leak into the buffer) fails.
    expect(frame).toContain("\x1b[2m❯ \x1b[22ma\x1b[7m");
    // Well-formed frame: the prompt line is intact between the two border rules (the bug's failure
    // mode garbles the text across the border rows).
    const lines = (frame ?? "").split("\n").map(stripAnsi);
    expect(lines).toHaveLength(3);
    expect(lines[1]).toBe("❯ a ");
  });

  test("(o) onStateChange mirrors state on mount and on every edit (T5 — App's layout/exit-eligibility seam)", async () => {
    const seen: { text: string; cursor: number }[] = [];
    const { stdin } = render(
      <Composer
        running={false}
        policy="ask"
        onSubmit={() => {}}
        onSteer={() => {}}
        onInterrupt={() => {}}
        onCyclePolicy={() => {}}
        nowMs={0}
        historyPath={historyPath()}
        onStateChange={(s) => seen.push({ ...s })}
      />,
    );
    await wait();
    expect(seen.at(0)).toEqual({ text: "", cursor: 0 }); // fired on mount

    stdin.write("hi");
    await wait();
    expect(seen.at(-1)).toEqual({ text: "hi", cursor: 2 });

    stdin.write("\r");
    await wait();
    expect(seen.at(-1)).toEqual({ text: "", cursor: 0 }); // cleared after submit
  });

  test("(p) Home/End on EMPTY text route to onScrollTop/onScrollBottom instead of the cursor ops (3c review item 2)", async () => {
    let tops = 0;
    let bottoms = 0;
    const { stdin } = render(
      <Composer
        running={false}
        policy="ask"
        onSubmit={() => {}}
        onSteer={() => {}}
        onInterrupt={() => {}}
        onCyclePolicy={() => {}}
        nowMs={0}
        historyPath={historyPath()}
        onScrollTop={() => { tops += 1; }}
        onScrollBottom={() => { bottoms += 1; }}
      />,
    );
    await wait();
    stdin.write("\x1b[H"); // Home on empty -> scroll callback, not the (no-op) cursor op
    await wait();
    stdin.write("\x1b[4~"); // End (vt220 variant) on empty -> scroll callback too
    await wait();

    expect(tops).toBe(1);
    expect(bottoms).toBe(1);
  });

  test("(p2) Home/End with TEXT keep cursor semantics and NEVER fire the scroll callbacks", async () => {
    let scrolls = 0;
    const submitted: string[] = [];
    const { stdin } = render(
      <Composer
        running={false}
        policy="ask"
        onSubmit={(text) => submitted.push(text)}
        onSteer={() => {}}
        onInterrupt={() => {}}
        onCyclePolicy={() => {}}
        nowMs={0}
        historyPath={historyPath()}
        onScrollTop={() => { scrolls += 1; }}
        onScrollBottom={() => { scrolls += 1; }}
      />,
    );
    await wait();
    stdin.write("bc");
    await wait();
    stdin.write("\x1b[H"); // Home with text -> cursor to 0 (NOT a scroll)
    await wait();
    stdin.write("a");
    await wait();
    stdin.write("\x1b[F"); // End with text -> cursor to end (NOT a scroll)
    await wait();
    stdin.write("d");
    await wait();
    stdin.write("\r");
    await wait();

    expect(scrolls).toBe(0);
    expect(submitted).toEqual(["abcd"]); // both edits landed at the cursor edges — ops still work
  });
});

describe("Composer — '?' on empty runs /help (Phase 3d T4)", () => {
  test("'?' on an EMPTY buffer calls onRunCommand('/help') instead of inserting", async () => {
    const ran: string[] = [];
    const { stdin, lastFrame } = render(
      <Composer
        running={false}
        policy="ask"
        onSubmit={() => {}}
        onSteer={() => {}}
        onInterrupt={() => {}}
        onCyclePolicy={() => {}}
        nowMs={0}
        historyPath={historyPath()}
        onRunCommand={(t) => ran.push(t)}
      />,
    );
    await wait();
    stdin.write("?");
    await wait();

    expect(ran).toEqual(["/help"]);
    expect(stripAnsi(lastFrame() ?? "")).toContain("❯  "); // buffer stayed empty — "?" never inserted
  });

  test("'?' with a NON-empty buffer types normally — never calls onRunCommand", async () => {
    const ran: string[] = [];
    const { stdin, lastFrame } = render(
      <Composer
        running={false}
        policy="ask"
        onSubmit={() => {}}
        onSteer={() => {}}
        onInterrupt={() => {}}
        onCyclePolicy={() => {}}
        nowMs={0}
        historyPath={historyPath()}
        onRunCommand={(t) => ran.push(t)}
      />,
    );
    await wait();
    stdin.write("a");
    await wait();
    stdin.write("?");
    await wait();

    expect(ran).toEqual([]);
    expect(stripAnsi(lastFrame() ?? "")).toContain("❯ a?");
  });

  test("a multi-char paste-like input containing '?' (e.g. 'a?b' delivered as ONE input event) types literally — never treated as the '?' shortcut", async () => {
    const ran: string[] = [];
    const { stdin, lastFrame } = render(
      <Composer
        running={false}
        policy="ask"
        onSubmit={() => {}}
        onSteer={() => {}}
        onInterrupt={() => {}}
        onCyclePolicy={() => {}}
        nowMs={0}
        historyPath={historyPath()}
        onRunCommand={(t) => ran.push(t)}
      />,
    );
    await wait();
    stdin.write("a?b"); // one write -> one Ink "input" event (paste-shaped), buffer starts EMPTY
    await wait();

    expect(ran).toEqual([]); // never mistaken for the single-"?"-keystroke shortcut
    expect(stripAnsi(lastFrame() ?? "")).toContain("❯ a?b");
  });

  test("no onRunCommand wired: '?' on empty simply no-ops (never inserted, no crash)", async () => {
    const { stdin, lastFrame } = render(
      <Composer
        running={false}
        policy="ask"
        onSubmit={() => {}}
        onSteer={() => {}}
        onInterrupt={() => {}}
        onCyclePolicy={() => {}}
        nowMs={0}
        historyPath={historyPath()}
      />,
    );
    await wait();
    stdin.write("?");
    await wait();

    expect(stripAnsi(lastFrame() ?? "")).toContain("❯  ");
  });
});

describe("computeSlashQuery (pure predicate)", () => {
  test("non-slash text -> null", () => {
    expect(computeSlashQuery({ text: "hello", cursor: 3 })).toBeNull();
    expect(computeSlashQuery({ text: "", cursor: 0 })).toBeNull();
  });

  test("cursor within the first token -> the in-progress query", () => {
    expect(computeSlashQuery({ text: "/mo", cursor: 3 })).toBe("mo");
    expect(computeSlashQuery({ text: "/mo", cursor: 1 })).toBe("");
  });

  test("a space after the command closes it once the cursor is past it", () => {
    // "/mo foo": '/'=0 'm'=1 'o'=2 ' '=3 'f'=4 ... — the space itself is at index 3.
    expect(computeSlashQuery({ text: "/mo foo", cursor: 3 })).toBe("mo"); // right before the space: still open
    expect(computeSlashQuery({ text: "/mo foo", cursor: 4 })).toBeNull(); // past the space: closed
  });

  test("cursor before the leading slash -> null", () => {
    expect(computeSlashQuery({ text: "/mo", cursor: 0 })).toBeNull();
  });
});

describe("Composer — slash-command completion menu (Phase 3d T2)", () => {
  test("(q) '/' opens the menu showing the registry; plain text never opens it", async () => {
    const { stdin, lastFrame } = render(
      <Composer
        running={false}
        policy="ask"
        onSubmit={() => {}}
        onSteer={() => {}}
        onInterrupt={() => {}}
        onCyclePolicy={() => {}}
        nowMs={0}
        historyPath={historyPath()}
      />,
    );
    await wait();
    stdin.write("hello");
    await wait();
    expect(stripAnsi(lastFrame() ?? "")).not.toContain("/help —");

    stdin.write("/");
    await wait();
    // "hello/" isn't slash mode either — the "/" landed mid/after plain text, not at the start.
    expect(stripAnsi(lastFrame() ?? "")).not.toContain("/help —");

    const { stdin: stdin2, lastFrame: lastFrame2 } = render(
      <Composer
        running={false}
        policy="ask"
        onSubmit={() => {}}
        onSteer={() => {}}
        onInterrupt={() => {}}
        onCyclePolicy={() => {}}
        nowMs={0}
        historyPath={historyPath()}
      />,
    );
    await wait();
    stdin2.write("/"); // a bare "/" at the very start of an empty buffer -> opens the menu
    await wait();

    const frame = stripAnsi(lastFrame2() ?? "");
    expect(frame).toContain("/help —");
    expect(frame).toContain("/compact —");
  });

  test("(r) the menu filters live as text changes", async () => {
    const { stdin, lastFrame } = render(
      <Composer
        running={false}
        policy="ask"
        onSubmit={() => {}}
        onSteer={() => {}}
        onInterrupt={() => {}}
        onCyclePolicy={() => {}}
        nowMs={0}
        historyPath={historyPath()}
      />,
    );
    await wait();
    stdin.write("/mo");
    await wait();

    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("/model ");
    expect(frame).not.toContain("/compact —");
    expect(frame).not.toContain("/status —");
  });

  test("(s) ↑/↓ move the bounded selection while the menu is open, never recalling history", async () => {
    const path = historyPath();
    appendHistory(path, { display: "unrelated history entry", ts: 1, sessionId: "s1" });

    const { stdin, lastFrame } = render(
      <Composer
        running={false}
        policy="ask"
        onSubmit={() => {}}
        onSteer={() => {}}
        onInterrupt={() => {}}
        onCyclePolicy={() => {}}
        nowMs={0}
        historyPath={path}
        sessionId="s1"
      />,
    );
    await wait();
    stdin.write("/s"); // matches exactly status, sessions, skills (in that registry order)
    await wait();

    let frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("/s"); // buffer unaffected by history so far
    let lines = frame.split("\n");
    let statusLine = lines.find((l) => l.includes("/status"))!;
    let sessionsLine = lines.find((l) => l.includes("/sessions"))!;
    expect((lastFrame() ?? "").split("\n")[lines.indexOf(statusLine)]).toContain("\x1b[7m"); // status selected first

    stdin.write("\x1b[B"); // down -> sessions
    await wait();
    frame = stripAnsi(lastFrame() ?? "");
    lines = frame.split("\n");
    statusLine = lines.find((l) => l.includes("/status"))!;
    sessionsLine = lines.find((l) => l.includes("/sessions"))!;
    expect((lastFrame() ?? "").split("\n")[lines.indexOf(sessionsLine)]).toContain("\x1b[7m");
    expect((lastFrame() ?? "").split("\n")[lines.indexOf(statusLine)]).not.toContain("\x1b[7m");

    stdin.write("\x1b[B"); // down -> skills
    await wait();
    stdin.write("\x1b[B"); // down -> routines (phase 5 T4: fuzzy-matches "s" — 4th/last of the "/s" set)
    await wait();
    stdin.write("\x1b[B"); // down again -> bounded, stays on routines (only 4 matches)
    await wait();
    let routinesLineIdx = stripAnsi(lastFrame() ?? "").split("\n").findIndex((l) => l.includes("/routines"));
    expect((lastFrame() ?? "").split("\n")[routinesLineIdx]).toContain("\x1b[7m");

    stdin.write("\x1b[A"); // up -> back to skills — never touched history (buffer still "/s")
    await wait();
    expect(stripAnsi(lastFrame() ?? "")).toContain("/s");
  });

  test("(t) Tab completes the selected command, adding a trailing space when it takes args", async () => {
    const { stdin, lastFrame } = render(
      <Composer
        running={false}
        policy="ask"
        onSubmit={() => {}}
        onSteer={() => {}}
        onInterrupt={() => {}}
        onCyclePolicy={() => {}}
        nowMs={0}
        historyPath={historyPath()}
      />,
    );
    await wait();
    stdin.write("/mo"); // uniquely matches "model", which takes args
    await wait();
    stdin.write("\t");
    await wait();

    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("❯ /model "); // trailing space added, cursor at the end
    // With a trailing space the cursor is now past the first token -> menu closes.
    expect(frame).not.toContain("Show or switch the active model/effort");
  });

  test("(t2) Tab-completing a no-arg command leaves the menu OPEN (cursor still inside the token)", async () => {
    const { stdin, lastFrame } = render(
      <Composer
        running={false}
        policy="ask"
        onSubmit={() => {}}
        onSteer={() => {}}
        onInterrupt={() => {}}
        onCyclePolicy={() => {}}
        nowMs={0}
        historyPath={historyPath()}
      />,
    );
    await wait();
    stdin.write("/comp"); // uniquely matches "compact", which takes no args
    await wait();
    stdin.write("\t");
    await wait();

    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("❯ /compact"); // no trailing space
    expect(frame).toContain("/compact —"); // menu still open, now showing just the exact match
  });

  test("(u) Enter runs a fully-typed known command (/compact) — never onSubmit/onSteer", async () => {
    const ran: string[] = [];
    const submitted: string[] = [];
    const { stdin } = render(
      <Composer
        running={false}
        policy="ask"
        onSubmit={(t) => submitted.push(t)}
        onSteer={() => {}}
        onInterrupt={() => {}}
        onCyclePolicy={() => {}}
        nowMs={0}
        historyPath={historyPath()}
        onRunCommand={(t) => ran.push(t)}
      />,
    );
    await wait();
    stdin.write("/compact");
    await wait();
    stdin.write("\r");
    await wait();

    expect(ran).toEqual(["/compact"]);
    expect(submitted).toEqual([]);
  });

  test("(v) Enter on a '/partial' matching the selected item completes it instead of running", async () => {
    const ran: string[] = [];
    const { stdin, lastFrame } = render(
      <Composer
        running={false}
        policy="ask"
        onSubmit={() => {}}
        onSteer={() => {}}
        onInterrupt={() => {}}
        onCyclePolicy={() => {}}
        nowMs={0}
        historyPath={historyPath()}
        onRunCommand={(t) => ran.push(t)}
      />,
    );
    await wait();
    stdin.write("/comp"); // uniquely matches "compact"
    await wait();
    stdin.write("\r");
    await wait();

    expect(ran).toEqual([]); // completed, not run
    expect(stripAnsi(lastFrame() ?? "")).toContain("❯ /compact");
  });

  test("(w) Enter on an unknown slash command with no matches runs it anyway (produces the note downstream)", async () => {
    const ran: string[] = [];
    const { stdin } = render(
      <Composer
        running={false}
        policy="ask"
        onSubmit={() => {}}
        onSteer={() => {}}
        onInterrupt={() => {}}
        onCyclePolicy={() => {}}
        nowMs={0}
        historyPath={historyPath()}
        onRunCommand={(t) => ran.push(t)}
      />,
    );
    await wait();
    stdin.write("/zzznotacommand");
    await wait();
    stdin.write("\r");
    await wait();

    expect(ran).toEqual(["/zzznotacommand"]);
  });

  test("(x) Esc closes the menu WITHOUT clearing the text and without arming the double-esc hint", async () => {
    const hints: string[] = [];
    const { stdin, lastFrame } = render(
      <Composer
        running={false}
        policy="ask"
        onSubmit={() => {}}
        onSteer={() => {}}
        onInterrupt={() => {}}
        onCyclePolicy={() => {}}
        nowMs={1000}
        historyPath={historyPath()}
        onHint={(h) => hints.push(h)}
      />,
    );
    await wait();
    stdin.write("/mo");
    await wait();
    expect(stripAnsi(lastFrame() ?? "")).toContain("Show or switch the active model/effort");

    stdin.write("\x1b"); // esc — closes the menu ONLY
    await wait();

    expect(hints).toEqual([]); // no double-esc bookkeeping armed
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("/mo"); // text untouched
    expect(frame).not.toContain("Show or switch the active model/effort"); // menu gone
  });

  test("(y) after an Esc-close, a SECOND Esc is a fresh first press (hints, does not clear) — double-esc requires the menu closed", async () => {
    const hints: string[] = [];
    const { stdin, lastFrame } = render(
      <Composer
        running={false}
        policy="ask"
        onSubmit={() => {}}
        onSteer={() => {}}
        onInterrupt={() => {}}
        onCyclePolicy={() => {}}
        nowMs={1000}
        historyPath={historyPath()}
        onHint={(h) => hints.push(h)}
      />,
    );
    await wait();
    stdin.write("/mo");
    await wait();
    stdin.write("\x1b"); // 1st esc — closes the menu only
    await wait();
    stdin.write("\x1b"); // 2nd esc — menu already closed: a FRESH first press of double-esc-clear
    await wait();

    expect(hints).toEqual(["Esc again to clear"]);
    expect(stripAnsi(lastFrame() ?? "")).toContain("/mo"); // not cleared
  });

  test("(z) history ↑ is inert while the menu is open, and works again once it's closed", async () => {
    const path = historyPath();
    appendHistory(path, { display: "recall me", ts: 1, sessionId: "s1" });

    const { stdin, lastFrame } = render(
      <Composer
        running={false}
        policy="ask"
        onSubmit={() => {}}
        onSteer={() => {}}
        onInterrupt={() => {}}
        onCyclePolicy={() => {}}
        nowMs={0}
        historyPath={path}
        sessionId="s1"
      />,
    );
    await wait();
    stdin.write("/mo");
    await wait();
    stdin.write("\x1b[A"); // up while the menu is open -> selection move, NOT history recall
    await wait();
    expect(stripAnsi(lastFrame() ?? "")).toContain("/mo"); // buffer unchanged by history

    stdin.write("\x1b"); // close the menu
    await wait();
    stdin.write("\x1b[A"); // up now that the menu is closed -> history recall works
    await wait();

    expect(stripAnsi(lastFrame() ?? "")).toContain("recall me");
  });

  test("(aa) onMenuRowsChange mirrors the visible row count: 0 on mount, min(6,count) while open, 0 once closed", async () => {
    const seen: number[] = [];
    const { stdin } = render(
      <Composer
        running={false}
        policy="ask"
        onSubmit={() => {}}
        onSteer={() => {}}
        onInterrupt={() => {}}
        onCyclePolicy={() => {}}
        nowMs={0}
        historyPath={historyPath()}
        onMenuRowsChange={(n) => seen.push(n)}
      />,
    );
    await wait();
    expect(seen.at(0)).toBe(0); // mount, no slash mode

    stdin.write("/s"); // matches exactly 6 (status, sessions, skills prefix; output-style, routines,
    // workflows fuzzy-match "s" — Task C4 added /workflows, itself an "s"-fuzzy hit)
    await wait();
    expect(seen.at(-1)).toBe(6);

    stdin.write("\x1b"); // esc-dismiss — no InputState change, but the row count must still drop
    await wait();
    expect(seen.at(-1)).toBe(0);
  });

  test("(ab) a space after the command closes the menu even without pressing Esc", async () => {
    const { stdin, lastFrame } = render(
      <Composer
        running={false}
        policy="ask"
        onSubmit={() => {}}
        onSteer={() => {}}
        onInterrupt={() => {}}
        onCyclePolicy={() => {}}
        nowMs={0}
        historyPath={historyPath()}
      />,
    );
    await wait();
    stdin.write("/mo");
    await wait();
    expect(stripAnsi(lastFrame() ?? "")).toContain("Show or switch the active model/effort");

    stdin.write(" extra");
    await wait();
    expect(stripAnsi(lastFrame() ?? "")).not.toContain("Show or switch the active model/effort");
  });

  test("(ac) Esc while RUNNING with the menu open interrupts on the FIRST press (precedence #1 outranks menu-close — T2 review item 1)", async () => {
    let interrupts = 0;
    const { stdin, lastFrame } = render(
      <Composer
        running
        policy="ask"
        onSubmit={() => {}}
        onSteer={() => {}}
        onInterrupt={() => { interrupts += 1; }}
        onCyclePolicy={() => {}}
        nowMs={0}
        historyPath={historyPath()}
      />,
    );
    await wait();
    stdin.write("/mo"); // menu open (matches /model)
    await wait();
    expect(stripAnsi(lastFrame() ?? "")).toContain("Show or switch the active model/effort");

    stdin.write("\x1b"); // FIRST esc while running — must interrupt, not just close the menu
    await wait();

    expect(interrupts).toBe(1);
  });

  test("(ad) a zero-match query ('/zzz') never gates keys: ↑ recalls history as if no menu existed (T2 review item 2)", async () => {
    const path = historyPath();
    appendHistory(path, { display: "recall me", ts: 1, sessionId: "s1" });

    const { stdin, lastFrame } = render(
      <Composer
        running={false}
        policy="ask"
        onSubmit={() => {}}
        onSteer={() => {}}
        onInterrupt={() => {}}
        onCyclePolicy={() => {}}
        nowMs={0}
        historyPath={path}
        sessionId="s1"
      />,
    );
    await wait();
    stdin.write("/zzz"); // zero matches — no menu rendered, and it must not swallow keys either
    await wait();
    stdin.write("\x1b[A"); // up -> history recall, NOT an (invisible) selection move
    await wait();

    expect(stripAnsi(lastFrame() ?? "")).toContain("recall me");
  });
});

describe("computeFileToken / computeFileQuery (pure predicates)", () => {
  test("no '@' anywhere -> null", () => {
    expect(computeFileToken({ text: "hello world", cursor: 5 })).toBeNull();
    expect(computeFileQuery({ text: "", cursor: 0 })).toBeNull();
  });

  test("'@' at the very start of the buffer, cursor inside -> the in-progress query", () => {
    expect(computeFileToken({ text: "@src", cursor: 4 })).toEqual({ start: 0, query: "src" });
    expect(computeFileQuery({ text: "@src", cursor: 1 })).toBe("");
  });

  test("cursor before/at the '@' itself -> null (not 'inside' the token yet)", () => {
    expect(computeFileToken({ text: "@src", cursor: 0 })).toBeNull();
  });

  test("'@' mid-text, after whitespace, still opens (this is the whole point of file mode)", () => {
    // "look at @src/tui/ap" — cursor at the very end, sitting right after "ap".
    const text = "look at @src/tui/ap";
    expect(computeFileToken({ text, cursor: text.length })).toEqual({ start: 8, query: "src/tui/ap" });
  });

  test("a token NOT starting with '@' never opens file mode, even if '@' appears later in it", () => {
    // "/foo@bar" starts with "/", not "@" — the token's FIRST character is what's checked (a token
    // can only start with one trigger character — see the doc comment's mutual-exclusion note).
    expect(computeFileToken({ text: "/foo@bar", cursor: 8 })).toBeNull();
  });

  test("a space after the '@token' closes it once the cursor is past it", () => {
    // "@src foo": '@'=0 's'=1 'r'=2 'c'=3 ' '=4 'f'=5 ... — the space itself is at index 4.
    expect(computeFileToken({ text: "@src foo", cursor: 4 })).toEqual({ start: 0, query: "src" }); // right before the space: still open
    expect(computeFileToken({ text: "@src foo", cursor: 5 })).toBeNull(); // past the space: closed
  });

  test("mutual exclusion: for any given state, computeSlashQuery and computeFileToken are never both non-null", () => {
    const samples: { text: string; cursor: number }[] = [
      { text: "/help", cursor: 3 },
      { text: "@src/tui", cursor: 5 },
      { text: "look at @composer", cursor: 18 },
      { text: "/model @weird", cursor: 13 },
      { text: "plain text", cursor: 4 },
      { text: "", cursor: 0 },
    ];
    for (const s of samples) {
      const slash = computeSlashQuery(s);
      const file = computeFileToken(s);
      expect(slash !== null && file !== null).toBe(false);
    }
  });
});

describe("Composer — @-file mention menu (Phase 3d T3)", () => {
  const FIXTURE_INDEX = ["src/tui/app.tsx", "src/tui/composer.tsx", "readme.md"];

  test("(a) '@' opens the menu over the given fileIndex (label = path, no hint); plain text never opens it", async () => {
    const { stdin, lastFrame } = render(
      <Composer
        running={false}
        policy="ask"
        onSubmit={() => {}}
        onSteer={() => {}}
        onInterrupt={() => {}}
        onCyclePolicy={() => {}}
        nowMs={0}
        historyPath={historyPath()}
        fileIndex={FIXTURE_INDEX}
      />,
    );
    await wait();
    stdin.write("hello");
    await wait();
    expect(stripAnsi(lastFrame() ?? "")).not.toContain("src/tui/composer.tsx");

    stdin.write(" @");
    await wait();

    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("src/tui/app.tsx");
    expect(frame).toContain("src/tui/composer.tsx");
    expect(frame).toContain("readme.md");
  });

  test("(b) the menu narrows via fuzzy matching as the query grows", async () => {
    const { stdin, lastFrame } = render(
      <Composer
        running={false}
        policy="ask"
        onSubmit={() => {}}
        onSteer={() => {}}
        onInterrupt={() => {}}
        onCyclePolicy={() => {}}
        nowMs={0}
        historyPath={historyPath()}
        fileIndex={FIXTURE_INDEX}
      />,
    );
    await wait();
    stdin.write("@comp");
    await wait();

    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("src/tui/composer.tsx");
    expect(frame).not.toContain("src/tui/app.tsx");
    expect(frame).not.toContain("readme.md");
  });

  test("(c) Tab inserts 'path ' replacing the '@query' token, cursor placed right after the space", async () => {
    const seen: { text: string; cursor: number }[] = [];
    const { stdin } = render(
      <Composer
        running={false}
        policy="ask"
        onSubmit={() => {}}
        onSteer={() => {}}
        onInterrupt={() => {}}
        onCyclePolicy={() => {}}
        nowMs={0}
        historyPath={historyPath()}
        fileIndex={FIXTURE_INDEX}
        onStateChange={(s) => seen.push({ ...s })}
      />,
    );
    await wait();
    stdin.write("@comp"); // uniquely matches "src/tui/composer.tsx"
    await wait();
    stdin.write("\t");
    await wait();

    expect(seen.at(-1)).toEqual({ text: "src/tui/composer.tsx ", cursor: "src/tui/composer.tsx ".length });
  });

  test("(d) mid-text '@' completes IN PLACE, preserving text before and after the token", async () => {
    const seen: { text: string; cursor: number }[] = [];
    const { stdin } = render(
      <Composer
        running={false}
        policy="ask"
        onSubmit={() => {}}
        onSteer={() => {}}
        onInterrupt={() => {}}
        onCyclePolicy={() => {}}
        nowMs={0}
        historyPath={historyPath()}
        fileIndex={FIXTURE_INDEX}
        onStateChange={(s) => seen.push({ ...s })}
      />,
    );
    await wait();
    stdin.write("look at @comp"); // "comp" uniquely matches "src/tui/composer.tsx"
    await wait();
    stdin.write("\t");
    await wait();

    expect(seen.at(-1)?.text).toBe("look at src/tui/composer.tsx ");
  });

  test("(e) mid-text '@' with trailing content preserves what's AFTER the cursor too", async () => {
    const seen: { text: string; cursor: number }[] = [];
    const { stdin } = render(
      <Composer
        running={false}
        policy="ask"
        onSubmit={() => {}}
        onSteer={() => {}}
        onInterrupt={() => {}}
        onCyclePolicy={() => {}}
        nowMs={0}
        historyPath={historyPath()}
        fileIndex={FIXTURE_INDEX}
        onStateChange={(s) => seen.push({ ...s })}
      />,
    );
    await wait();
    stdin.write("before @app after"); // "app" uniquely matches "src/tui/app.tsx"
    await wait();
    // Move the cursor back to sit right after "@app" (before the following space + "after") — 6
    // left-arrows walks back over " after" (6 chars).
    for (let i = 0; i < 6; i++) {
      stdin.write("\x1b[D");
      // eslint-disable-next-line no-await-in-loop
      await wait(3);
    }
    await wait();
    stdin.write("\t");
    await wait();

    // The inserted "src/tui/app.tsx " plus the untouched " after" (which already had its own
    // leading space) — nothing is stripped/collapsed on either side of the insertion point.
    expect(seen.at(-1)?.text).toBe("before src/tui/app.tsx  after");
  });

  test("(f) Enter completes the selection when a real match exists — never submits/steers", async () => {
    const submitted: string[] = [];
    const { stdin, lastFrame } = render(
      <Composer
        running={false}
        policy="ask"
        onSubmit={(t) => submitted.push(t)}
        onSteer={() => {}}
        onInterrupt={() => {}}
        onCyclePolicy={() => {}}
        nowMs={0}
        historyPath={historyPath()}
        fileIndex={FIXTURE_INDEX}
      />,
    );
    await wait();
    stdin.write("@comp"); // uniquely matches "src/tui/composer.tsx"
    await wait();
    stdin.write("\r");
    await wait();

    expect(submitted).toEqual([]);
    expect(stripAnsi(lastFrame() ?? "")).toContain("❯ src/tui/composer.tsx ");
  });

  test("(g) Enter with ZERO fuzzy matches submits the literal text (passthrough, same as slash's unknown-command rule)", async () => {
    const submitted: string[] = [];
    const { stdin, lastFrame } = render(
      <Composer
        running={false}
        policy="ask"
        onSubmit={(t) => submitted.push(t)}
        onSteer={() => {}}
        onInterrupt={() => {}}
        onCyclePolicy={() => {}}
        nowMs={0}
        historyPath={historyPath()}
        fileIndex={FIXTURE_INDEX}
      />,
    );
    await wait();
    stdin.write("@zzznomatch");
    await wait();
    expect(stripAnsi(lastFrame() ?? "")).not.toContain("indexing"); // index IS ready, just no matches
    stdin.write("\r");
    await wait();

    expect(submitted).toEqual(["@zzznomatch"]);
  });

  test("(h) while the index is still building (fileIndex undefined): a disabled 'indexing…' row renders, and every key passes through", async () => {
    const path = historyPath();
    appendHistory(path, { display: "recall me", ts: 1, sessionId: "s1" });
    const submitted: string[] = [];

    const { stdin, lastFrame } = render(
      <Composer
        running={false}
        policy="ask"
        onSubmit={(t) => submitted.push(t)}
        onSteer={() => {}}
        onInterrupt={() => {}}
        onCyclePolicy={() => {}}
        nowMs={0}
        historyPath={path}
        sessionId="s1"
        // fileIndex omitted -> still "building" from the composer's point of view
      />,
    );
    await wait();
    stdin.write("@zzz");
    await wait();

    expect(stripAnsi(lastFrame() ?? "")).toContain("indexing…");

    stdin.write("\x1b[A"); // up while "indexing" -> history recall (zero-matches passthrough), NOT a selection move
    await wait();
    expect(stripAnsi(lastFrame() ?? "")).toContain("recall me");

    stdin.write("\r"); // enter with no real match yet -> submits literally (passthrough)
    await wait();
    expect(submitted).toEqual(["recall me"]);
  });

  test("(i) onNeedFileIndex fires exactly ONCE per composer lifetime, on the first '@'-trigger", async () => {
    let calls = 0;
    const { stdin } = render(
      <Composer
        running={false}
        policy="ask"
        onSubmit={() => {}}
        onSteer={() => {}}
        onInterrupt={() => {}}
        onCyclePolicy={() => {}}
        nowMs={0}
        historyPath={historyPath()}
        onNeedFileIndex={() => { calls += 1; }}
      />,
    );
    await wait();
    expect(calls).toBe(0); // nothing triggered yet

    stdin.write("@a");
    await wait();
    expect(calls).toBe(1);

    stdin.write(" more @b"); // a SECOND "@"-trigger later in the same session
    await wait();
    expect(calls).toBe(1); // still just once
  });

  test("(j) Esc closes the file menu WITHOUT clearing the text and without arming the double-esc hint", async () => {
    const hints: string[] = [];
    const { stdin, lastFrame } = render(
      <Composer
        running={false}
        policy="ask"
        onSubmit={() => {}}
        onSteer={() => {}}
        onInterrupt={() => {}}
        onCyclePolicy={() => {}}
        nowMs={1000}
        historyPath={historyPath()}
        fileIndex={FIXTURE_INDEX}
        onHint={(h) => hints.push(h)}
      />,
    );
    await wait();
    stdin.write("@comp");
    await wait();
    expect(stripAnsi(lastFrame() ?? "")).toContain("src/tui/composer.tsx");

    stdin.write("\x1b"); // esc — closes the menu ONLY
    await wait();

    expect(hints).toEqual([]); // no double-esc bookkeeping armed
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("@comp"); // text untouched
    expect(frame).not.toContain("src/tui/composer.tsx"); // menu gone

    stdin.write("\x1b"); // a SECOND esc, menu already closed -> a fresh double-esc-clear first press
    await wait();
    expect(hints).toEqual(["Esc again to clear"]);
  });

  test("(k) Esc while RUNNING with the file menu open interrupts on the FIRST press (precedence #1 outranks menu-close)", async () => {
    let interrupts = 0;
    const { stdin, lastFrame } = render(
      <Composer
        running
        policy="ask"
        onSubmit={() => {}}
        onSteer={() => {}}
        onInterrupt={() => { interrupts += 1; }}
        onCyclePolicy={() => {}}
        nowMs={0}
        historyPath={historyPath()}
        fileIndex={FIXTURE_INDEX}
      />,
    );
    await wait();
    stdin.write("@comp");
    await wait();
    expect(stripAnsi(lastFrame() ?? "")).toContain("src/tui/composer.tsx");

    stdin.write("\x1b"); // FIRST esc while running — must interrupt, not just close the menu
    await wait();

    expect(interrupts).toBe(1);
  });

  test("(l) ↑/↓ move the bounded selection while the file menu is open, never recalling history", async () => {
    const path = historyPath();
    appendHistory(path, { display: "unrelated history entry", ts: 1, sessionId: "s1" });

    const { stdin, lastFrame } = render(
      <Composer
        running={false}
        policy="ask"
        onSubmit={() => {}}
        onSteer={() => {}}
        onInterrupt={() => {}}
        onCyclePolicy={() => {}}
        nowMs={0}
        historyPath={path}
        sessionId="s1"
        fileIndex={FIXTURE_INDEX}
      />,
    );
    await wait();
    stdin.write("@"); // empty query -> all 3 candidates, in fileIndex order
    await wait();

    let lines = stripAnsi(lastFrame() ?? "").split("\n");
    const appIdx = lines.findIndex((l) => l.includes("src/tui/app.tsx"));
    expect((lastFrame() ?? "").split("\n")[appIdx]).toContain("\x1b[7m"); // first candidate selected

    stdin.write("\x1b[B"); // down -> second candidate
    await wait();
    lines = stripAnsi(lastFrame() ?? "").split("\n");
    const composerIdx = lines.findIndex((l) => l.includes("src/tui/composer.tsx"));
    expect((lastFrame() ?? "").split("\n")[composerIdx]).toContain("\x1b[7m");
    expect((lastFrame() ?? "").split("\n")[appIdx]).not.toContain("\x1b[7m");

    expect(stripAnsi(lastFrame() ?? "")).not.toContain("unrelated history entry"); // never touched history
  });

  test("(m) slash-mode tests are unaffected: '/' still opens the slash menu, '@' never does for it", async () => {
    const { stdin, lastFrame } = render(
      <Composer
        running={false}
        policy="ask"
        onSubmit={() => {}}
        onSteer={() => {}}
        onInterrupt={() => {}}
        onCyclePolicy={() => {}}
        nowMs={0}
        historyPath={historyPath()}
        fileIndex={FIXTURE_INDEX}
      />,
    );
    await wait();
    stdin.write("/mo");
    await wait();

    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("/model ");
    expect(frame).not.toContain("src/tui/app.tsx"); // file menu never overlaps slash's
  });
});
