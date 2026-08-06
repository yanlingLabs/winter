/** Phase 3c Task 4 — <App>, the fullscreen alt-screen shell.
 *
 *  <App> is driven the way main.ts drives it in production: a real makeEventBridge() whose events
 *  the test pushes, and a FAKE client that only records callback args (App issues no RPC on its own,
 *  only in response to composer/card/key input). ink-testing-library renders in debug mode, so
 *  lastFrame() is the WHOLE frame — a root pinned to `height = rows - 1` (24-1 = 23 lines in the
 *  non-TTY test env, where process.stdout.rows is undefined → the App's 24 fallback).
 *
 *  The transcript is a JS-windowed line log now (no Ink <Static>): the flattened committed lines are
 *  sliced to the viewport height and rendered one <Text> per visible line, above a PINNED bottom bar
 *  (tasks · spinner · composer|card · agents · footer; the in-flight turn streams inside the transcript now, T3). Scroll keys / wheel move
 *  the window; "stick" auto-follows the tail until the user scrolls away. */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanup, render } from "ink-testing-library";
import { METHODS } from "@norma/protocol";
import { CORE_VERSION } from "@norma/core";
import { App, bottomBarRows } from "../../src/tui/app";
import { makeEventBridge } from "../../src/tui/event-bridge";
import type { AgentRow } from "../../src/tui/state";
import type { TaskRow } from "../../src/task-display";

// useInput / effects wire on the tick after render() returns — a short wait after render and after
// each push/keystroke keeps assertions deterministic.
const wait = (ms = 25) => new Promise((r) => setTimeout(r, ms));

afterEach(cleanup);

function fakeClient() {
  const calls: { method: string; args: unknown[] }[] = [];
  const rec = (method: string) => (...args: unknown[]) => {
    calls.push({ method, args });
    return Promise.resolve({});
  };
  return {
    calls,
    send: rec("send"),
    steer: rec("steer"),
    interrupt: rec("interrupt"),
    setPolicy: rec("setPolicy"),
    askUserRespond: rec("askUserRespond"),
    planRespond: rec("planRespond"),
    request: rec("request"),
    // child-transcript-view T3: typed results (AppClient reads `delivered`/`status` off these);
    // per-test overrides spread over this base for the resumed/rejected variants.
    sendToThread: (...args: unknown[]) => {
      calls.push({ method: "sendToThread", args });
      return Promise.resolve({ delivered: "queued" as const, agentId: "th_1" });
    },
    agentStop: (...args: unknown[]) => {
      calls.push({ method: "agentStop", args });
      return Promise.resolve({ status: "stopped" });
    },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ev = (o: Record<string, unknown>) => o as any;

const baseProps = { sessionId: "s1", cwd: "/tmp", initialPolicy: "ask" as const, version: "0.0.1", model: "gpt-5-codex" };

// The composer's real inverse-video cursor (`<Text inverse>`) — a unique fingerprint of "the
// composer is rendered" (nothing else in the TUI uses `inverse`).
const COMPOSER_CURSOR = "\x1b[7m";
const FOOTER_HINT = "? for shortcuts · shift+tab to cycle modes"; // Phase 3d T4 exact fallback text

// SGR mouse wheel-up report (mode 1006). Ink strips the leading ESC before useInput, but the App's
// emitter patch sees the raw chunk (ESC intact) — so mouse input is swallowed before the composer.
const WHEEL_UP = "\x1b[<64;10;5M";

const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

describe("App (fullscreen shell)", () => {
  test("(a) a full mini-turn (buffered before subscribe) commits the assistant text + returns to an idle composer", async () => {
    const bridge = makeEventBridge();
    // Push the whole turn BEFORE App renders/subscribes → exercises the bridge's pre-subscribe buffer.
    bridge.push(ev({ type: "user_message", threadId: "main", text: "hello" }));
    bridge.push(ev({ type: "turn_started", threadId: "main" }));
    bridge.push(ev({ type: "assistant_delta", threadId: "main", delta: "hi " }));
    bridge.push(ev({ type: "assistant_delta", threadId: "main", delta: "there" }));
    bridge.push(ev({ type: "assistant_message", threadId: "main", text: "hi there friend" }));
    bridge.push(ev({ type: "turn_completed", threadId: "main", inputTokens: 10, outputTokens: 5 }));

    const client = fakeClient();
    const { lastFrame } = render(<App client={client} bridge={bridge} {...baseProps} />);
    await wait();

    const frame = lastFrame() ?? "";
    expect(frame).toContain("hi there friend"); // committed assistant block, windowed into view
    expect(frame).toContain("❯ hello"); // committed user block (⏺/❯ grammar)
    expect(frame).toContain(COMPOSER_CURSOR); // idle composer prompt present
    expect(client.calls).toEqual([]); // App issued no RPCs on its own
  });

  test("(b) parity bug e2e: a bg child's finish line keeps its real label/elapsed and the composer is never overwritten", async () => {
    const bridge = makeEventBridge();
    const client = fakeClient();
    const { lastFrame } = render(<App client={client} bridge={bridge} {...baseProps} />);
    await wait();

    bridge.push(ev({ type: "thread_started", threadId: "th_1", agentType: "general-purpose", description: "scout", ts: 500 }));
    bridge.push(ev({ type: "turn_started", threadId: "th_1", ts: 1000 }));
    bridge.push(ev({ type: "thread_completed", threadId: "th_1", ts: 10000, stopReason: "end_turn" }));
    bridge.push(ev({ type: "turn_completed", threadId: "main", inputTokens: 20, outputTokens: 8 }));
    bridge.push(ev({ type: "assistant_message", threadId: "main", text: "all wrapped up" }));
    await wait();

    const frame = lastFrame() ?? "";
    expect(frame).toContain('Agent "scout": Done'); // real label, not "" (Task 6 wording)
    expect(frame).toContain("9s"); // banked span (10000-1000), not 0s
    expect(frame).toContain("(scout)"); // roster tree row survived the main turn_completed (not pruned)
    expect(frame).toContain("all wrapped up"); // the following main message rendered
    expect(frame).toContain(COMPOSER_CURSOR); // composer still present, never overwritten
  });

  test("(c) a bg_task_output chunk lands in the transcript and the composer stays present after it", async () => {
    const bridge = makeEventBridge();
    const client = fakeClient();
    const { lastFrame } = render(<App client={client} bridge={bridge} {...baseProps} />);
    await wait();

    bridge.push(ev({ type: "bg_task_output", taskId: "t1", chunk: "BUILD-LOG-XYZ" }));
    await wait();

    const frame = lastFrame() ?? "";
    expect(frame).toContain("BUILD-LOG-XYZ"); // committed to the transcript line log
    expect(frame).toContain(COMPOSER_CURSOR); // composer still rendered below it (invisible-prompt invariant)
  });

  test("(d) welcome banner is the first line: bold Norma + version, then model · cwd", async () => {
    const bridge = makeEventBridge();
    const { lastFrame } = render(
      <App client={fakeClient()} bridge={bridge} sessionId="s" cwd="/work/proj" initialPolicy="ask" version="0.0.1" model="gpt-5-codex" />,
    );
    await wait();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Norma");
    expect(frame).toContain("v0.0.1");
    expect(frame).toContain("gpt-5-codex · /work/proj");
  });

  test("(e) empty session: frame is exactly rows-1 lines, welcome at the top, composer + footer pinned at the bottom", async () => {
    const bridge = makeEventBridge();
    const { lastFrame } = render(<App client={fakeClient()} bridge={bridge} {...baseProps} />);
    await wait();
    const lines = (lastFrame() ?? "").split("\n");

    expect(lines).toHaveLength(23); // rows-1 (HARD CONSTRAINT 1: outputHeight < stdout.rows)
    expect(lines[0]).toContain("Norma"); // welcome header rides the top of the log
    expect(lines.at(-1)).toContain(FOOTER_HINT); // footer is the very last row

    // The composer sits at the frame BOTTOM (pushed down by the flexGrow transcript region), not
    // directly under the welcome.
    const cursorLine = lines.findIndex((l) => l.includes(COMPOSER_CURSOR));
    expect(cursorLine).toBeGreaterThanOrEqual(lines.length - 4);
  });

  test("(f) tasks auto-appear on task_updated (default visible) and ctrl+t toggles them", async () => {
    const bridge = makeEventBridge();
    const { stdin, lastFrame } = render(<App client={fakeClient()} bridge={bridge} {...baseProps} />);
    await wait();
    bridge.push(ev({ type: "task_updated", task: { id: "t1", subject: "ship the feature", status: "pending" } }));
    await wait();
    expect(lastFrame() ?? "").toContain("ship the feature"); // visible by DEFAULT (CC default)

    stdin.write("\x14"); // ctrl+t -> hide
    await wait();
    expect(lastFrame() ?? "").not.toContain("ship the feature");

    stdin.write("\x14"); // ctrl+t -> show again
    await wait();
    expect(lastFrame() ?? "").toContain("ship the feature");
  });

  test("(g) Footer shows the plan-mode indicator when initialPolicy is plan", async () => {
    const bridge = makeEventBridge();
    const { lastFrame } = render(
      <App client={fakeClient()} bridge={bridge} sessionId="s" cwd="/tmp" initialPolicy="plan" version="0.0.1" model="m" />,
    );
    await wait();
    expect(lastFrame() ?? "").toContain("⏸ plan mode on");
  });

  test("(h) long transcript sticks to the tail: newest lines visible, oldest scrolled off, bottom bar intact", async () => {
    const bridge = makeEventBridge();
    for (let i = 0; i < 40; i++) bridge.push(ev({ type: "bg_task_output", taskId: "t", chunk: `NOTE-${i}` }));
    const { lastFrame } = render(<App client={fakeClient()} bridge={bridge} {...baseProps} />);
    await wait();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("NOTE-39"); // tail follows growth (stick)
    expect(frame).not.toContain("NOTE-0"); // oldest scrolled off the top
    expect((frame).split("\n")).toHaveLength(23); // still exactly rows-1
    expect(frame).toContain(COMPOSER_CURSOR); // bottom bar still pinned
  });

  test("(i) scroll keys: PgUp unsticks (a new block does NOT move the view); PgDn back to the end re-sticks (follows)", async () => {
    const bridge = makeEventBridge();
    for (let i = 0; i < 40; i++) bridge.push(ev({ type: "bg_task_output", taskId: "t", chunk: `NOTE-${i}` }));
    const { stdin, lastFrame } = render(<App client={fakeClient()} bridge={bridge} {...baseProps} />);
    await wait();

    stdin.write("\x1b[5~"); // PgUp -> unstick
    await wait();
    bridge.push(ev({ type: "bg_task_output", taskId: "t", chunk: "UNSTUCK-MARKER" }));
    await wait();
    expect(lastFrame() ?? "").not.toContain("UNSTUCK-MARKER"); // unstuck: view held, new block not followed

    for (let k = 0; k < 6; k++) { stdin.write("\x1b[6~"); await wait(8); } // PgDn to the end -> re-stick
    bridge.push(ev({ type: "bg_task_output", taskId: "t", chunk: "RESTICK-MARKER" }));
    await wait();
    expect(lastFrame() ?? "").toContain("RESTICK-MARKER"); // re-stuck: tail follows again
  });

  test("(j) ctrl+o toggles verbose: a capped tool output expands in place (full lines, no '+N lines' hint)", async () => {
    const bridge = makeEventBridge();
    const out = Array.from({ length: 14 }, (_, i) => `oline${i}`).join("\n");
    bridge.push(ev({ type: "tool_call", threadId: "main", name: "bash", argsJson: "{}" }));
    bridge.push(ev({ type: "tool_result", threadId: "main", output: out }));
    const { stdin, lastFrame } = render(<App client={fakeClient()} bridge={bridge} {...baseProps} />);
    await wait();

    let frame = lastFrame() ?? "";
    expect(frame).toContain("… +4 lines (ctrl+o to expand)"); // non-verbose: capped at 10
    expect(frame).not.toContain("oline13");

    stdin.write("\x0f"); // ctrl+o -> verbose
    await wait();
    frame = lastFrame() ?? "";
    expect(frame).toContain("oline13"); // full output now shown in place
    expect(frame).not.toContain("+4 lines"); // no truncation hint in verbose
  });

  test("(k) wheel scroll: the SGR report scrolls the transcript (unsticks) and never reaches the composer buffer", async () => {
    const bridge = makeEventBridge();
    for (let i = 0; i < 40; i++) bridge.push(ev({ type: "bg_task_output", taskId: "t", chunk: `W-${i}` }));
    const client = fakeClient();
    const { stdin, lastFrame } = render(<App client={client} bridge={bridge} {...baseProps} />);
    await wait();

    stdin.write(WHEEL_UP); // wheel up -> scroll up + unstick
    await wait();
    const frame = lastFrame() ?? "";
    expect(count(frame, "64;10;5")).toBe(0); // the raw mouse bytes never landed anywhere (not the composer)

    // The composer buffer is empty (mouse was swallowed): Enter submits nothing.
    stdin.write("\r");
    await wait();
    expect(client.calls).toEqual([]);

    // The wheel actually scrolled: it unstuck the view, so a new block is no longer auto-followed.
    bridge.push(ev({ type: "bg_task_output", taskId: "t", chunk: "WHEEL-UNSTUCK" }));
    await wait();
    expect(lastFrame() ?? "").not.toContain("WHEEL-UNSTUCK");
  });

  // tui-mouse — rapid trackpad scroll batches many SGR reports into ONE `stdin.read()`/"input"
  // chunk. bottomBarRows(idle, no tasks/agents) = 4, so viewH = (24-1) - 4 = 19 at the 24-row
  // fallback; 40 pushed lines -> max scrollTop 21, stuck at the bottom (scrollTop 21, lines
  // W-21..W-39 visible) before any wheel input.
  test("(k2) batched SGR reports: 3 concatenated wheel-up reports in ONE chunk scroll exactly 3 steps, nothing leaks to the composer", async () => {
    const bridge = makeEventBridge();
    for (let i = 0; i < 40; i++) bridge.push(ev({ type: "bg_task_output", taskId: "t", chunk: `W-${i}` }));
    const client = fakeClient();
    const { stdin, lastFrame } = render(<App client={client} bridge={bridge} {...baseProps} />);
    await wait();

    stdin.write(WHEEL_UP.repeat(3)); // 3 batched reports in a single raw chunk
    await wait();
    const frame = lastFrame() ?? "";
    expect(count(frame, "64;10;5")).toBe(0); // no raw mouse bytes anywhere (not the composer)

    // Each of the 3 reports fired its own wheel step (-3 each = -9 total): scrollTop 21 -> 12, so
    // the top visible line is W-12 and W-31 (visible only at a shallower scroll) is NOT.
    expect(frame).toContain("W-12");
    expect(frame).not.toContain("W-31");

    // The composer buffer is empty (mouse was swallowed): Enter submits nothing.
    stdin.write("\r");
    await wait();
    expect(client.calls).toEqual([]);
  });

  test("(k3) a report split across two stdin chunks is swallowed and scrolls exactly one step, nothing leaks to the composer", async () => {
    const bridge = makeEventBridge();
    for (let i = 0; i < 40; i++) bridge.push(ev({ type: "bg_task_output", taskId: "t", chunk: `W-${i}` }));
    const client = fakeClient();
    const { stdin, lastFrame } = render(<App client={client} bridge={bridge} {...baseProps} />);
    await wait();

    stdin.write("\x1b[<64;10;5"); // report split before the terminating 'M'
    await wait();
    expect(lastFrame() ?? "").toContain("W-21"); // not yet scrolled — nothing fires on a partial report

    stdin.write("M"); // completes the report
    await wait();
    const frame = lastFrame() ?? "";
    expect(count(frame, "64;10;5")).toBe(0); // no raw mouse bytes anywhere (not the composer)
    expect(frame).toContain("W-18"); // scrolled exactly ONE step (21 -> 18), not zero and not double

    stdin.write("\r");
    await wait();
    expect(client.calls).toEqual([]);
  });

  // TUI renderer T2 — the scrolled-back honesty indicator. Geometry as (k2): viewH 19, 40 pushed
  // notes + 3 welcome lines = 43 log lines. PgUp scrolls wheel-shaped by viewH-1 = 18 → offset 18;
  // the indicator replaces the viewport's BOTTOM row (the top edge — where the user is reading —
  // stays put), so 18 content rows show and the count includes the displaced row: 43 - 24 = 19.
  test("(k4) scrolled back: a '↓ N newer lines' indicator discloses hidden content with a truthful count that tracks growth; re-sticking clears it", async () => {
    const bridge = makeEventBridge();
    for (let i = 0; i < 40; i++) bridge.push(ev({ type: "bg_task_output", taskId: "t", chunk: `IND-${i}` }));
    const { stdin, lastFrame } = render(<App client={fakeClient()} bridge={bridge} {...baseProps} />);
    await wait();
    expect(lastFrame() ?? "").not.toContain("newer line"); // followed bottom: nothing hidden, no indicator

    stdin.write("\x1b[5~"); // PgUp -> offset 18, unfollowed
    await wait();
    expect(lastFrame() ?? "").toContain("↓ 19 newer lines");

    // Growth while scrolled back: the view holds (see k5) and the count grows with the hidden tail.
    bridge.push(ev({ type: "bg_task_output", taskId: "t", chunk: "IND-NEW" }));
    await wait();
    expect(lastFrame() ?? "").toContain("↓ 20 newer lines");

    stdin.write("\x1b[F"); // End (empty composer) -> re-follow the bottom
    await wait();
    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("newer line"); // indicator gone
    expect(frame).toContain("IND-NEW"); // and the tail is visible again
  });

  test("(k5) growth while scrolled back does NOT move the view: the viewport's top line is byte-identical across appends", async () => {
    const bridge = makeEventBridge();
    for (let i = 0; i < 40; i++) bridge.push(ev({ type: "bg_task_output", taskId: "t", chunk: `G-${i}` }));
    const { stdin, lastFrame } = render(<App client={fakeClient()} bridge={bridge} {...baseProps} />);
    await wait();

    stdin.write("\x1b[5~"); // PgUp — scroll back
    await wait();
    const before = (lastFrame() ?? "").split("\n");

    for (let i = 0; i < 3; i++) bridge.push(ev({ type: "bg_task_output", taskId: "t", chunk: `G-LATE-${i}` }));
    await wait();
    const after = (lastFrame() ?? "").split("\n");

    expect(after[0]).toBe(before[0]!); // top edge pinned — growth compensated, the reader never moves
    expect(after.join("\n")).not.toContain("G-LATE-0"); // the new content stayed below the window
  });

  // T2 fix round 1 — growth compensation must be gated on the WRAP BASIS: a columns resize rewraps
  // existing content (row-count delta, ZERO new content), which must NOT shift a scrolled-back
  // offset the way genuine bottom-appended growth does. Geometry: cols 80 → welcome 3 + one long
  // note ("✻ " + 100 chars → 2 rows) + 40 one-row notes = 45 rows; viewH 19; PgUp → offset 18 →
  // content rows 8..25 (top = RW-3, the long note sits fully ABOVE the window) + indicator
  // "↓ 19 newer lines". Resizing to cols 40 rewraps ONLY the long note (2 → 3 rows, +1 above the
  // window): the same content must stay in view — top line still RW-3, indicator still 19. A raw
  // length-delta compensation instead bumps offset by the rewrap delta and shows RW-2 / 20.
  test("(k6) a columns-resize rewrap while scrolled back does NOT shift the view: offset ungrown, top line and indicator count unchanged", async () => {
    const stdoutShape = process.stdout as unknown as { columns?: number };
    const prevCols = stdoutShape.columns;
    stdoutShape.columns = 80;
    const bridge = makeEventBridge();
    bridge.push(ev({ type: "bg_task_output", taskId: "t", chunk: "x".repeat(100) })); // rewraps: 2 rows @80, 3 @40
    for (let i = 0; i < 40; i++) bridge.push(ev({ type: "bg_task_output", taskId: "t", chunk: `RW-${i}` }));
    const { stdin, lastFrame } = render(<App client={fakeClient()} bridge={bridge} {...baseProps} />);
    try {
      await wait();

      stdin.write("\x1b[5~"); // PgUp -> offset 18, unfollowed
      await wait();
      const before = lastFrame() ?? "";
      expect(before.split("\n")[0]).toContain("RW-3"); // window top — long note entirely above it
      expect(before).toContain("↓ 19 newer lines");

      stdoutShape.columns = 40;
      process.stdout.emit("resize");
      await wait();
      const after = lastFrame() ?? "";
      expect(after.split("\n")[0]).toContain("RW-3"); // same content on top — rewrap did not scroll the reader
      expect(after).toContain("↓ 19 newer lines"); // hidden-below count unchanged — offset was not "compensated"
    } finally {
      stdoutShape.columns = prevCols;
    }
  });

  test("(l) resize: the frame re-renders to the new terminal height", async () => {
    const prev = (process.stdout as unknown as { rows?: number }).rows;
    const { lastFrame } = render(<App client={fakeClient()} bridge={makeEventBridge()} {...baseProps} />);
    try {
      await wait();
      expect((lastFrame() ?? "").split("\n")).toHaveLength(23); // rows=24 fallback -> 23

      (process.stdout as unknown as { rows?: number }).rows = 30;
      process.stdout.emit("resize");
      await wait();
      expect((lastFrame() ?? "").split("\n")).toHaveLength(29); // rows=30 -> 29
    } finally {
      (process.stdout as unknown as { rows?: number }).rows = prev;
    }
  });
});

describe("App — double ctrl+C/ctrl+D exit flow (Phase 3c Task 5)", () => {
  test("(m) first ctrl+C interrupts a running turn AND arms the footer hint; second press within the window exits", async () => {
    const bridge = makeEventBridge();
    const client = fakeClient();
    const exits: number[] = [];
    const { stdin, lastFrame } = render(
      <App client={client} bridge={bridge} {...baseProps} onExitRequest={() => exits.push(1)} />,
    );
    await wait();
    bridge.push(ev({ type: "turn_started", threadId: "main" }));
    await wait();

    stdin.write("\x03"); // first ctrl+C
    await wait();
    expect(client.calls.map((c) => c.method)).toContain("interrupt");
    expect(lastFrame() ?? "").toContain("Press Ctrl-C again to exit");
    expect(exits).toEqual([]);

    stdin.write("\x03"); // second ctrl+C, well within the 800ms window in real time
    await wait();
    expect(exits).toEqual([1]);
  });

  test("(n) first ctrl+C while IDLE does not interrupt (nothing running) but still arms the window", async () => {
    const client = fakeClient();
    const { stdin, lastFrame } = render(<App client={client} bridge={makeEventBridge()} {...baseProps} />);
    await wait();
    stdin.write("\x03");
    await wait();
    expect(client.calls).toEqual([]); // idle — onInterrupt's own turnRunning guard no-ops
    expect(lastFrame() ?? "").toContain("Press Ctrl-C again to exit");
  });

  test("(o) window expiry re-arms instead of exiting (driven off the App's injected `now`, never Date.now)", async () => {
    let clock = 1_000_000;
    const now = () => clock;
    const exits: number[] = [];
    const { stdin, lastFrame } = render(
      <App client={fakeClient()} bridge={makeEventBridge()} {...baseProps} now={now} onExitRequest={() => exits.push(1)} />,
    );
    await wait();

    stdin.write("\x03"); // arm
    await wait();
    expect(lastFrame() ?? "").toContain("Press Ctrl-C again to exit");

    clock += 900; // past the 800ms exit window
    await wait(150); // let the ~100ms tick pick up the new clock value
    stdin.write("\x03"); // treated as a FRESH first press — re-arms, does not exit
    await wait();

    expect(exits).toEqual([]);
    expect(lastFrame() ?? "").toContain("Press Ctrl-C again to exit"); // re-armed, not cleared
  });

  test("(p) ctrl+C exits even while a pending approval card owns input (the T4 review regression)", async () => {
    const bridge = makeEventBridge();
    const exits: number[] = [];
    const { stdin, lastFrame } = render(
      <App client={fakeClient()} bridge={bridge} {...baseProps} onExitRequest={() => exits.push(1)} />,
    );
    await wait();
    bridge.push(ev({ type: "approval_requested", callId: "c1", toolName: "bash", summary: "rm -rf /" }));
    await wait();
    expect(lastFrame() ?? "").toContain("approve bash?"); // the card really did take over

    stdin.write("\x03");
    await wait();
    stdin.write("\x03");
    await wait();
    expect(exits).toEqual([1]);
  });

  test("(p2) picking a numbered allow-rule option sends approval.respond with that optionId (SP-approvals T7)", async () => {
    const client = fakeClient();
    const bridge = makeEventBridge();
    const { stdin, lastFrame } = render(<App client={client} bridge={bridge} {...baseProps} />);
    await wait();
    bridge.push(ev({
      type: "approval_requested", callId: "c9", toolName: "bash", summary: "git push origin main",
      options: [
        { id: "allow_once", label: "Allow once" },
        { id: "allow_project", label: 'Allow "Bash(git push:*)" in this project', rule: "Bash(git push:*)", scope: "project" },
        { id: "allow_global", label: 'Allow "Bash(git push:*)" everywhere', rule: "Bash(git push:*)", scope: "global" },
        { id: "deny", label: "Deny" },
      ],
    }));
    await wait();
    expect(lastFrame() ?? "").toContain('[1] Allow "Bash(git push:*)" in this project');

    stdin.write("1");
    await wait();
    stdin.write("\r");
    await wait();

    const req = client.calls.find((c) => c.method === "request" && c.args[0] === METHODS.approvalRespond);
    expect(req?.args[1]).toEqual({ sessionId: "s1", callId: "c9", approved: true, optionId: "allow_project" });
  });

  test("(q) ctrl+D on an empty composer drives the identical arm/exit flow", async () => {
    const exits: number[] = [];
    const { stdin } = render(
      <App client={fakeClient()} bridge={makeEventBridge()} {...baseProps} onExitRequest={() => exits.push(1)} />,
    );
    await wait();
    stdin.write("\x04"); // arm
    await wait();
    stdin.write("\x04"); // exit
    await wait();
    expect(exits).toEqual([1]);
  });

  test("(r) ctrl+D with composer text does NOT arm the exit flow (never steals from typing)", async () => {
    const exits: number[] = [];
    const { stdin, lastFrame } = render(
      <App client={fakeClient()} bridge={makeEventBridge()} {...baseProps} onExitRequest={() => exits.push(1)} />,
    );
    await wait();
    stdin.write("hello");
    await wait();
    stdin.write("\x04");
    await wait();
    stdin.write("\x04");
    await wait();
    expect(exits).toEqual([]);
    expect(lastFrame() ?? "").not.toContain("again to exit"); // not armed under EITHER key's hint
    expect(lastFrame() ?? "").toContain("hello"); // buffer untouched
  });

  test("(q2) ctrl+D arming names its OWN key in the footer hint (3c whole-branch review item 3)", async () => {
    const { stdin, lastFrame } = render(<App client={fakeClient()} bridge={makeEventBridge()} {...baseProps} />);
    await wait();
    stdin.write("\x04"); // arm via ctrl+D (empty composer)
    await wait();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Press Ctrl-D again to exit");
    expect(frame).not.toContain("Press Ctrl-C again to exit");
  });

  test("(v) ctrl+D's first press does NOT scroll the transcript (3c whole-branch review item 1 — the scroll hook ceded ctrl+d)", async () => {
    const bridge = makeEventBridge();
    for (let i = 0; i < 40; i++) bridge.push(ev({ type: "bg_task_output", taskId: "t", chunk: `SCROLL-${i}` }));
    const { stdin, lastFrame } = render(<App client={fakeClient()} bridge={bridge} {...baseProps} />);
    await wait();

    // Scroll UP first so a half-page-DOWN (the removed scroll binding) would visibly move the window.
    stdin.write("\x1b[5~"); // PgUp
    await wait();
    stdin.write("\x1b[5~"); // PgUp again — well away from the bottom
    await wait();
    const before = (lastFrame() ?? "").split("\n");

    stdin.write("\x04"); // ctrl+D (empty composer) — must ONLY arm exit, never scroll
    await wait();
    const after = (lastFrame() ?? "").split("\n");

    expect(after[0]).toBe(before[0]!); // viewport top line unmoved — no half-page-down fired
    expect(after.join("\n")).toContain("Press Ctrl-D again to exit"); // ... but the exit window armed
    // The frames are identical EXCEPT the armed footer line (the very last row).
    const diffs = before.map((line, i) => (line === after[i] ? null : i)).filter((i) => i !== null);
    expect(diffs).toEqual([before.length - 1]);
  });

  test("(w) running + empty composer: the first ctrl+D interrupts EXACTLY once (only the exit hook's armOrExit — no scroll-path double-fire)", async () => {
    const bridge = makeEventBridge();
    const client = fakeClient();
    const { stdin, lastFrame } = render(<App client={client} bridge={bridge} {...baseProps} />);
    await wait();
    bridge.push(ev({ type: "turn_started", threadId: "main" }));
    await wait();

    stdin.write("\x04"); // first ctrl+D while running
    await wait();
    expect(client.calls.filter((c) => c.method === "interrupt")).toHaveLength(1);
    expect(lastFrame() ?? "").toContain("Press Ctrl-D again to exit");
  });

  test("(x) a DIFFERENT eligible key inside the window re-arms under that key instead of exiting", async () => {
    const exits: number[] = [];
    const { stdin, lastFrame } = render(
      <App client={fakeClient()} bridge={makeEventBridge()} {...baseProps} onExitRequest={() => exits.push(1)} />,
    );
    await wait();
    stdin.write("\x03"); // arm via ctrl+C
    await wait();
    expect(lastFrame() ?? "").toContain("Press Ctrl-C again to exit");

    stdin.write("\x04"); // ctrl+D inside the window — re-arms as ctrl-d, does NOT exit
    await wait();
    expect(exits).toEqual([]);
    expect(lastFrame() ?? "").toContain("Press Ctrl-D again to exit");

    stdin.write("\x04"); // matching second press — exits
    await wait();
    expect(exits).toEqual([1]);
  });
});

describe("App — Home/End transcript jumps on an empty composer (3c whole-branch review item 2, spec §5)", () => {
  test("(y) Home on empty scrolls to the top (welcome/oldest visible, unstuck); End re-sticks to the bottom", async () => {
    const bridge = makeEventBridge();
    for (let i = 0; i < 40; i++) bridge.push(ev({ type: "bg_task_output", taskId: "t", chunk: `HE-${i}` }));
    const { stdin, lastFrame } = render(<App client={fakeClient()} bridge={bridge} {...baseProps} />);
    await wait();
    expect(lastFrame() ?? "").toContain("HE-39"); // starts stuck to the bottom

    stdin.write("\x1b[H"); // Home, empty composer -> transcript top
    await wait();
    const frame = lastFrame() ?? "";
    expect(frame.split("\n")[0]).toContain("Norma"); // the welcome header — the very first log line
    expect(frame).toContain("HE-1"); // oldest transcript lines in view
    expect(frame).not.toContain("HE-39");

    bridge.push(ev({ type: "bg_task_output", taskId: "t", chunk: "HE-NEW" }));
    await wait();
    expect(lastFrame() ?? "").not.toContain("HE-NEW"); // the top jump UNSTUCK the view — growth not followed

    stdin.write("\x1b[F"); // End, empty composer -> back to (and stuck to) the bottom
    await wait();
    expect(lastFrame() ?? "").toContain("HE-NEW");
    bridge.push(ev({ type: "bg_task_output", taskId: "t", chunk: "HE-STICKY" }));
    await wait();
    expect(lastFrame() ?? "").toContain("HE-STICKY"); // re-stuck: tail follows again
  });

  test("(z) Home/End with TEXT keep their cursor semantics and never scroll the transcript", async () => {
    const bridge = makeEventBridge();
    for (let i = 0; i < 40; i++) bridge.push(ev({ type: "bg_task_output", taskId: "t", chunk: `TX-${i}` }));
    const { stdin, lastFrame } = render(<App client={fakeClient()} bridge={bridge} {...baseProps} />);
    await wait();
    stdin.write("abc");
    await wait();

    stdin.write("\x1b[H"); // Home with text -> cursor to 0, NO scroll
    await wait();
    let frame = lastFrame() ?? "";
    expect(frame).toContain("\x1b[7ma\x1b[27m"); // inverse cursor sits ON "a" (cursor really moved to 0)
    expect(frame).toContain("TX-39"); // still at the bottom — did not jump to the top
    expect(frame.split("\n")[0]).not.toContain("Norma"); // top of the log NOT in view

    stdin.write("\x1b[F"); // End with text -> cursor back to the end, still no scroll
    await wait();
    stdin.write("d");
    await wait();
    frame = lastFrame() ?? "";
    expect(frame).toContain("abcd"); // insert landed at the END — End restored the cursor
    expect(frame).toContain("TX-39"); // view still at the bottom
  });
});

describe("App — resume replay (Phase 3c Task 5)", () => {
  test("(s) resumeTargetSeq: 'Resuming conversation…' shows from mount, survives mid-replay, clears once the target seq is processed — full transcript present, task_notification invisible, composer stuck at the bottom", async () => {
    const bridge = makeEventBridge();
    const client = fakeClient();
    // Mount FIRST (mirrors main.ts: `attach(sessionId, 0)` resolves with the daemon's tip BEFORE
    // mountTui/<App> render), THEN push the historical log through the bridge's LIVE subscribe path
    // (not the pre-subscribe buffer test (a) exercises) — matching how the daemon's replay actually
    // arrives relative to the App mounting.
    const { lastFrame } = render(<App client={client} bridge={bridge} {...baseProps} resumeTargetSeq={5} />);
    await wait();
    expect(lastFrame() ?? "").toContain("Resuming conversation…"); // shown immediately, before any event

    bridge.push(ev({ type: "user_message", threadId: "main", text: "hello again", seq: 1 }));
    await wait();
    expect(lastFrame() ?? "").toContain("Resuming conversation…"); // still mid-replay

    bridge.push(ev({ type: "turn_started", threadId: "main", seq: 2 }));
    bridge.push(ev({ type: "assistant_message", threadId: "main", text: "hi back", seq: 3 }));
    bridge.push(ev({ type: "task_notification", threadId: "main", content: "bg agent finished", seq: 4 }));
    bridge.push(ev({ type: "turn_completed", threadId: "main", inputTokens: 3, outputTokens: 2, seq: 5 }));
    await wait();

    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("Resuming conversation…"); // replay reached resumeTargetSeq -> cleared
    expect(frame).toContain("❯ hello again"); // full transcript present
    expect(frame).toContain("hi back");
    expect(frame).not.toContain("bg agent finished"); // task_notification: reducer no-op, invisible
    expect(frame).toContain(COMPOSER_CURSOR); // composer back — viewport starts stuck to the bottom
    expect(client.calls).toEqual([]); // App issued no RPCs on its own during replay
  });

  test("(t) resumeTargetSeq: 0 (a resumed session with no prior events) never shows the resuming line", async () => {
    const { lastFrame } = render(<App client={fakeClient()} bridge={makeEventBridge()} {...baseProps} resumeTargetSeq={0} />);
    await wait();
    expect(lastFrame() ?? "").not.toContain("Resuming conversation…");
  });

  test("(u) non-resume (default opts, no resumeTargetSeq): the resuming line never appears, even across a full turn", async () => {
    const bridge = makeEventBridge();
    const { lastFrame } = render(<App client={fakeClient()} bridge={bridge} {...baseProps} />);
    await wait();
    bridge.push(ev({ type: "user_message", threadId: "main", text: "hi", seq: 1 }));
    bridge.push(ev({ type: "turn_completed", threadId: "main", inputTokens: 1, outputTokens: 1, seq: 2 }));
    await wait();
    expect(lastFrame() ?? "").not.toContain("Resuming conversation…");
    expect(lastFrame() ?? "").toContain(COMPOSER_CURSOR);
  });
});

describe("App — slash-command wiring (Phase 3d T2: onRunCommand + local_note)", () => {
  test("(v1) '/help' typed into the composer runs through the registry and commits its note — never client.send", async () => {
    const bridge = makeEventBridge();
    const client = fakeClient();
    const { stdin, lastFrame } = render(<App client={client} bridge={bridge} {...baseProps} />);
    await wait();
    stdin.write("/help");
    await wait();
    stdin.write("\r");
    await wait();

    const frame = lastFrame() ?? "";
    // helpText() content: the registry has grown past the 23-line viewport (Task C4 added
    // /workflows, the 15th entry), so early lines like /help/compact have scrolled off under
    // "stick to bottom" — anchor on /workflows instead, the newest (last) registry entry and so
    // the most robust to future registry growth (a pre-existing viewport-height coupling, not
    // specific to /help — see the identical note on the '?'-on-empty test below).
    expect(frame).toContain("/workflows [run <name> [json]|stop <runId>] — List saved + running workflows");
    expect(frame).toContain("Keys:"); // the keybinding line
    expect(frame).toContain(COMPOSER_CURSOR); // composer back to idle, buffer cleared
    expect(client.calls).toEqual([]); // never reached the model
  });

  test("(v2) an unknown slash command commits the 'Unknown command' note", async () => {
    const bridge = makeEventBridge();
    const client = fakeClient();
    const { stdin, lastFrame } = render(<App client={client} bridge={bridge} {...baseProps} />);
    await wait();
    stdin.write("/nope");
    await wait();
    stdin.write("\r");
    await wait();

    expect(lastFrame() ?? "").toContain("Unknown command: /nope — /help lists commands");
    expect(client.calls).toEqual([]);
  });

  test("(v3) a command that DOES need the client (/compact) round-trips through CommandCtx.client", async () => {
    const bridge = makeEventBridge();
    const client = { ...fakeClient(), compact: async () => ({ compacted: true, uptoSeq: 5, summaryChars: 42 }) };
    const { stdin, lastFrame } = render(<App client={client} bridge={bridge} {...baseProps} />);
    await wait();
    stdin.write("/compact");
    await wait();
    stdin.write("\r");
    await wait();

    expect(lastFrame() ?? "").toContain("compacted (through seq 5, 42 char summary)");
  });

  test("(v4) the completion menu renders inside the full App tree while typing '/', and the composer stays present", async () => {
    const bridge = makeEventBridge();
    const client = fakeClient();
    const { stdin, lastFrame } = render(<App client={client} bridge={bridge} {...baseProps} />);
    await wait();
    stdin.write("/mo");
    await wait();

    const frame = lastFrame() ?? "";
    expect(frame).toContain("Show or switch the active model/effort"); // /model row visible
    expect(frame).toContain(COMPOSER_CURSOR); // composer (with its "/mo" buffer) still rendered below it
  });

  test("(v5) /cd propagates its daemon-confirmed cwd to later commands in the same session (T2 review item 3)", async () => {
    const bridge = makeEventBridge();
    const skillsCalls: unknown[][] = [];
    const client = {
      ...fakeClient(),
      setCwd: async (_sessionId: string, _path: string) => "/resolved/newdir",
      listSkills: async (...args: unknown[]) => { skillsCalls.push(args); return []; },
    };
    const { stdin, lastFrame } = render(<App client={client} bridge={bridge} {...baseProps} />);
    await wait();
    stdin.write("/cd ../x");
    await wait();
    stdin.write("\r");
    await wait();
    expect(lastFrame() ?? "").toContain("cwd → /resolved/newdir"); // runCd's note landed

    stdin.write("/skills");
    await wait();
    stdin.write("\r");
    await wait();

    // The DAEMON-CONFIRMED cwd from /cd — not baseProps' mount-time "/tmp" — reaches /skills.
    expect(skillsCalls).toEqual([["/resolved/newdir"]]);
  });
});

describe("App — @-file mention index lifecycle (Phase 3d T3)", () => {
  test("(x1) the first '@'-trigger builds the real file index against the session's cwd, and matches appear once it resolves", async () => {
    const root = mkdtempSync(join(tmpdir(), "norma-app-file-index-"));
    writeFileSync(join(root, "alpha.ts"), "");
    writeFileSync(join(root, "beta.md"), "");
    try {
      const bridge = makeEventBridge();
      const client = fakeClient();
      const { stdin, lastFrame } = render(<App client={client} bridge={bridge} {...baseProps} cwd={root} />);
      await wait();
      stdin.write("@alpha");
      await wait(100); // real fs readdir — give the buildFileIndex promise time to resolve

      const frame = lastFrame() ?? "";
      expect(frame).toContain("alpha.ts");
      expect(frame).not.toContain("beta.md"); // fuzzy-filtered out by the "alpha" query
      expect(frame).toContain(COMPOSER_CURSOR); // composer stays mounted/live underneath the menu
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("(x2) a '/cd' issued BEFORE the first '@' redirects the index build to the daemon-confirmed new cwd", async () => {
    const original = mkdtempSync(join(tmpdir(), "norma-app-file-index-orig-"));
    const redirected = mkdtempSync(join(tmpdir(), "norma-app-file-index-new-"));
    writeFileSync(join(original, "onlyinoriginal.ts"), "");
    writeFileSync(join(redirected, "onlyinredirected.ts"), "");
    try {
      const bridge = makeEventBridge();
      const client = { ...fakeClient(), setCwd: async () => redirected };
      const { stdin, lastFrame } = render(<App client={client} bridge={bridge} {...baseProps} cwd={original} />);
      await wait();
      stdin.write("/cd anywhere");
      await wait();
      stdin.write("\r");
      await wait();
      // The long tmpdir path can hard-wrap onto its own line at 80 columns, so check the note's
      // pieces independently rather than one contiguous "cwd → <path>" substring.
      const cdFrame = lastFrame() ?? "";
      expect(cdFrame).toContain("cwd → ");
      expect(cdFrame).toContain(redirected); // runCd's note landed first

      stdin.write("@onlyin"); // the FIRST "@"-trigger, AFTER the /cd
      await wait(100); // real fs readdir

      const frame = lastFrame() ?? "";
      expect(frame).toContain("onlyinredirected.ts"); // built against the NEW cwd (cwdRef.current)
      expect(frame).not.toContain("onlyinoriginal.ts"); // never scanned the original mount-time cwd
    } finally {
      rmSync(original, { recursive: true, force: true });
      rmSync(redirected, { recursive: true, force: true });
    }
  });
});

describe("App — help surfacing: '?' on empty runs /help (Phase 3d T4)", () => {
  test("'?' on an EMPTY composer commits the /help note — never inserted as text, never sent to the model", async () => {
    const bridge = makeEventBridge();
    const client = fakeClient();
    const { stdin, lastFrame } = render(<App client={client} bridge={bridge} {...baseProps} />);
    await wait();
    stdin.write("?");
    await wait();

    const frame = lastFrame() ?? "";
    // helpText() content: the registry has grown past the 23-line viewport, so early lines
    // (/help, /compact — the latter dropped in favor of /workflows by Task C4, which added the
    // registry's 15th entry) have scrolled off under "stick to bottom" — assert lines that are
    // still in view instead (this is a pre-existing viewport-height coupling, not specific to
    // /help). /workflows anchors the newest (last) entry, the most robust to future registry growth.
    expect(frame).toContain("/workflows [run <name> [json]|stop <runId>] — List saved + running workflows");
    expect(frame).toContain("/output-style [name] — Show or switch the output style");
    expect(frame).toContain("Keys:"); // the keybinding line (may hard-wrap at 80 cols; unchecked verbatim here)
    expect(frame).not.toContain("❯ ?"); // the "?" itself was never inserted into the buffer
    expect(frame).toContain(COMPOSER_CURSOR); // composer back to idle
    expect(client.calls).toEqual([]); // never reached the model
  });

  test("'?' with existing text in the buffer types normally — never runs /help", async () => {
    const bridge = makeEventBridge();
    const client = fakeClient();
    const { stdin, lastFrame } = render(<App client={client} bridge={bridge} {...baseProps} />);
    await wait();
    stdin.write("a");
    await wait();
    stdin.write("?");
    await wait();

    const frame = lastFrame() ?? "";
    expect(frame).toContain("❯ a?"); // typed literally, buffer intact
    expect(frame).not.toContain("Keys:"); // /help never ran
    expect(client.calls).toEqual([]);
  });
});

describe("App — command + mention e2e wiring (Phase 3d T4)", () => {
  test("(T4-a) '/compact' typed + entered through the real App wiring: note lands, buffer clears, and neither send nor steer ever fire", async () => {
    const bridge = makeEventBridge();
    const client = { ...fakeClient(), compact: async () => ({ compacted: true, uptoSeq: 7, summaryChars: 99 }) };
    const { stdin, lastFrame } = render(<App client={client} bridge={bridge} {...baseProps} />);
    await wait();
    stdin.write("/compact");
    await wait();
    stdin.write("\r");
    await wait();

    const frame = lastFrame() ?? "";
    expect(frame).toContain("compacted (through seq 7, 99 char summary)"); // the command note block
    expect(frame).toContain(COMPOSER_CURSOR); // composer back to idle
    expect(frame).not.toContain("❯ /compact"); // buffer cleared, not left holding the typed command
    expect(client.calls.filter((c) => c.method === "send")).toEqual([]); // never reached the model
    expect(client.calls.filter((c) => c.method === "steer")).toEqual([]);
  });

  test("(T4-b) '@' mention: type + Tab-complete + Enter composes the FULL text with the path inline and really sends it", async () => {
    const root = mkdtempSync(join(tmpdir(), "norma-app-help-e2e-"));
    writeFileSync(join(root, "target.ts"), "");
    try {
      const bridge = makeEventBridge();
      const client = fakeClient();
      const { stdin, lastFrame } = render(<App client={client} bridge={bridge} {...baseProps} cwd={root} />);
      await wait();
      stdin.write("look at @target");
      await wait(100); // real fs readdir — give buildFileIndex time to resolve
      expect(lastFrame() ?? "").toContain("target.ts"); // the real match is visible in the menu

      stdin.write("\t"); // Tab-complete the "@target" span in place
      await wait();
      stdin.write("\r"); // a normal Enter now — cursor sits past the (closed) file token

      await wait();
      expect(client.calls).toEqual([{ method: "send", args: ["s1", "look at target.ts "] }]);
      expect(lastFrame() ?? "").toContain(COMPOSER_CURSOR); // idle composer again, buffer cleared
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("App — child transcript view (child-transcript-view T3)", () => {
  // Seeds one WORKING roster row per (threadId, description): thread_started (queued) +
  // turn_started (working) — the same event pair test (b) above uses.
  const pushAgent = (bridge: ReturnType<typeof makeEventBridge>, threadId: string, description: string) => {
    bridge.push(ev({ type: "thread_started", threadId, agentType: "general-purpose", description, ts: 500 }));
    bridge.push(ev({ type: "turn_started", threadId, ts: 1000 }));
  };
  // The select-mode pointer glyph — AgentList's plain-text highlight fingerprint.
  const POINTER = "▶";
  const selectedLine = (frame: string) => frame.split("\n").find((l) => l.includes(POINTER)) ?? "";

  test("(t1) ctrl+a with NO agents never enters select mode — it stays the composer's cursor-Home", async () => {
    const client = fakeClient();
    const { stdin, lastFrame } = render(<App client={client} bridge={makeEventBridge()} {...baseProps} />);
    await wait();
    stdin.write("bc");
    await wait();
    stdin.write("\x01"); // ctrl+a — no roster: falls through to the composer (cursor to 0)
    await wait();
    expect(lastFrame() ?? "").not.toContain(POINTER); // no select mode
    stdin.write("a"); // inserts AT the cursor — proves the ctrl+a really reached the composer
    await wait();
    // Buffer is now "abc" with the inverse cursor sitting ON "b" (insert landed at 0, cursor 1) —
    // the same ANSI-fingerprint idiom test (z) above uses, since the cursor codes split the text.
    expect(lastFrame() ?? "").toContain("❯ a\x1b[7mb\x1b[27mc");
  });

  test("(t2) ctrl+a toggles select mode; ↑/↓ move with bounds; Esc exits; other keys still work", async () => {
    const bridge = makeEventBridge();
    const client = fakeClient();
    const { stdin, lastFrame } = render(<App client={client} bridge={bridge} {...baseProps} />);
    await wait();
    pushAgent(bridge, "th_1", "scout");
    pushAgent(bridge, "th_2", "helper");
    await wait();

    stdin.write("\x01"); // ctrl+a -> select mode, first row highlighted
    await wait();
    expect(selectedLine(lastFrame() ?? "")).toContain("(scout)");

    stdin.write("\x1b[B"); // down -> second row
    await wait();
    expect(selectedLine(lastFrame() ?? "")).toContain("(helper)");

    stdin.write("\x1b[B"); // down at the end -> stays (bound)
    await wait();
    expect(selectedLine(lastFrame() ?? "")).toContain("(helper)");

    stdin.write("\x1b[A"); // up -> back to first
    await wait();
    stdin.write("\x1b[A"); // up at the top -> stays (bound)
    await wait();
    expect(selectedLine(lastFrame() ?? "")).toContain("(scout)");

    stdin.write("\x14"); // ctrl+t (tasks toggle) passes through untouched mid-select — no crash, still selected
    await wait();
    expect(lastFrame() ?? "").toContain(POINTER);

    stdin.write("\x1b"); // Esc -> exit select mode
    await wait();
    expect(lastFrame() ?? "").not.toContain(POINTER);
    expect(client.calls).toEqual([]); // pure UI navigation — no RPC ever fired
  });

  test("(t3) Enter opens the child view: pinned header + childBlocks replace the main transcript, live-updating", async () => {
    const bridge = makeEventBridge();
    const client = fakeClient();
    const { stdin, lastFrame } = render(<App client={client} bridge={bridge} {...baseProps} />);
    await wait();
    bridge.push(ev({ type: "bg_task_output", taskId: "t", chunk: "MAIN-ONLY-MARKER" }));
    pushAgent(bridge, "th_1", "scout");
    bridge.push(ev({ type: "assistant_message", threadId: "th_1", text: "child says hi" }));
    await wait();
    expect(lastFrame() ?? "").toContain("MAIN-ONLY-MARKER"); // main view first

    stdin.write("\x01"); // select mode
    await wait();
    stdin.write("\r"); // Enter -> open th_1's child view
    await wait();

    let frame = lastFrame() ?? "";
    expect(frame).toContain("th_1"); // header identity (no name mapping -> threadId)
    expect(frame).toContain("working · esc back"); // header status + hint
    expect(frame).toContain("child says hi"); // childBlocks rendered
    expect(frame).not.toContain("MAIN-ONLY-MARKER"); // main committed log swapped out
    expect(frame).not.toContain(POINTER); // select mode exited on open

    bridge.push(ev({ type: "assistant_message", threadId: "th_1", text: "second child line" }));
    await wait();
    frame = lastFrame() ?? "";
    expect(frame).toContain("second child line"); // live-updates as the reducer appends
  });

  test("(t4) child-view input routing: text -> sendToThread(threadId) + queued feedback; slash -> MAIN runCommand; send/steer never fire", async () => {
    const bridge = makeEventBridge();
    const client = fakeClient();
    const { stdin, lastFrame } = render(<App client={client} bridge={bridge} {...baseProps} />);
    await wait();
    pushAgent(bridge, "th_1", "scout");
    await wait();
    stdin.write("\x01");
    await wait();
    stdin.write("\r"); // open child view
    await wait();

    stdin.write("hello agent");
    await wait();
    stdin.write("\r");
    await wait();
    expect(client.calls).toEqual([{ method: "sendToThread", args: ["s1", "th_1", "hello agent"] }]);
    expect(lastFrame() ?? "").toContain('message queued for agent "scout"'); // delivered:"queued" feedback, in the child view

    stdin.write("/help"); // built-in command: runs in the MAIN conversation (CC parity)
    await wait();
    stdin.write("\r");
    await wait();
    expect(client.calls).toHaveLength(1); // no send/steer/sendToThread for the slash input
    expect(lastFrame() ?? "").not.toContain("Keys:"); // its note landed in MAIN, not the open child view

    stdin.write("\x1b"); // Esc (empty composer) -> back to main
    await wait();
    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("working · esc back"); // header gone (the /help note's own "esc back" text may remain)
    expect(frame).toContain("Keys:"); // the /help note was committed to the MAIN transcript all along
  });

  test("(t5) delivered:'resumed' renders the resumed feedback note", async () => {
    const bridge = makeEventBridge();
    const client = { ...fakeClient(), sendToThread: async () => ({ delivered: "resumed" as const, agentId: "th_1" }) };
    const { stdin, lastFrame } = render(<App client={client} bridge={bridge} {...baseProps} />);
    await wait();
    pushAgent(bridge, "th_1", "scout");
    bridge.push(ev({ type: "thread_completed", threadId: "th_1", ts: 2000, stopReason: "end_turn" }));
    await wait();
    stdin.write("\x01");
    await wait();
    stdin.write("\r");
    await wait();
    stdin.write("try again with flag X");
    await wait();
    stdin.write("\r");
    await wait();
    expect(lastFrame() ?? "").toContain('agent "scout" resumed with your message');
  });

  test("(t6) a thread.send RPC error renders as a note in the child view — never a crash", async () => {
    const bridge = makeEventBridge();
    const client = { ...fakeClient(), sendToThread: async () => { throw new Error("cannot resume: no history (code invalid)"); } };
    const { stdin, lastFrame } = render(<App client={client} bridge={bridge} {...baseProps} />);
    await wait();
    pushAgent(bridge, "th_1", "scout");
    await wait();
    stdin.write("\x01");
    await wait();
    stdin.write("\r");
    await wait();
    stdin.write("hi");
    await wait();
    stdin.write("\r");
    await wait();
    const frame = lastFrame() ?? "";
    expect(frame).toContain('message to agent "scout" failed: cannot resume: no history (code invalid)');
    expect(frame).toContain("working · esc back"); // view intact, app alive
  });

  test("(t7) Esc on an empty composer closes the child view WITHOUT interrupting a running main turn", async () => {
    const bridge = makeEventBridge();
    const client = fakeClient();
    const { stdin, lastFrame } = render(<App client={client} bridge={bridge} {...baseProps} />);
    await wait();
    bridge.push(ev({ type: "turn_started", threadId: "main" })); // main turn RUNNING
    bridge.push(ev({ type: "bg_task_output", taskId: "t", chunk: "MAIN-ONLY-MARKER" }));
    pushAgent(bridge, "th_1", "scout");
    await wait();
    stdin.write("\x01");
    await wait();
    stdin.write("\r"); // open child view
    await wait();
    expect(lastFrame() ?? "").toContain("working · esc back");

    stdin.write("\x1b"); // Esc, empty composer -> close the view, do NOT interrupt
    await wait();
    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("working · esc back");
    expect(frame).toContain("MAIN-ONLY-MARKER"); // main transcript back
    expect(client.calls.filter((c) => c.method === "interrupt")).toEqual([]); // running turn untouched

    stdin.write("\x1b"); // next Esc (main view, running) -> the normal interrupt semantics resume
    await wait();
    expect(client.calls.filter((c) => c.method === "interrupt")).toHaveLength(1);
  });

  test("(t8) x on a RUNNING row calls agent.stop and notes the result; the row stays until events say otherwise", async () => {
    const bridge = makeEventBridge();
    const client = fakeClient();
    const { stdin, lastFrame } = render(<App client={client} bridge={bridge} {...baseProps} />);
    await wait();
    pushAgent(bridge, "th_1", "scout");
    await wait();
    stdin.write("\x01");
    await wait();
    stdin.write("x");
    await wait();
    expect(client.calls).toEqual([{ method: "agentStop", args: ["s1", "th_1"] }]);
    const frame = lastFrame() ?? "";
    expect(frame).toContain('agent "scout" stopped'); // the RPC result note (main transcript)
    expect(frame).toContain("(scout)"); // roster row NOT locally removed — status flips via events
  });

  test("(t9) x on a FINISHED row dismisses it locally (no RPC); footer count follows", async () => {
    const bridge = makeEventBridge();
    const client = fakeClient();
    const { stdin, lastFrame } = render(<App client={client} bridge={bridge} {...baseProps} />);
    await wait();
    pushAgent(bridge, "th_1", "scout");
    pushAgent(bridge, "th_2", "helper");
    bridge.push(ev({ type: "thread_completed", threadId: "th_1", ts: 2000, stopReason: "end_turn" }));
    await wait();
    expect(lastFrame() ?? "").toContain("2 agents · ctrl+a"); // the truthful pill (T3)

    stdin.write("\x01"); // select mode — first row (the finished scout) highlighted
    await wait();
    stdin.write("x"); // finished row -> local dismiss, never agent.stop
    await wait();
    const frame = lastFrame() ?? "";
    expect(client.calls).toEqual([]); // no RPC
    expect(frame).not.toContain("(scout)"); // roster row hidden (its finish NOTE may still mention scout)
    expect(frame).toContain("(helper)"); // the other row survives
    expect(frame).toContain("1 agent · ctrl+a"); // footer pill counts only visible rows
    expect(selectedLine(frame)).toContain("(helper)"); // highlight re-clamped, select mode still on
  });

  test("(t10) a pruned roster row auto-closes its open child view back to main", async () => {
    const bridge = makeEventBridge();
    const client = fakeClient();
    const { stdin, lastFrame } = render(<App client={client} bridge={bridge} {...baseProps} />);
    await wait();
    bridge.push(ev({ type: "bg_task_output", taskId: "t", chunk: "MAIN-ONLY-MARKER" }));
    pushAgent(bridge, "th_1", "scout");
    bridge.push(ev({ type: "thread_completed", threadId: "th_1", ts: 2000, stopReason: "end_turn" }));
    await wait();
    stdin.write("\x01");
    await wait();
    stdin.write("\r"); // open the DONE child's view
    await wait();
    expect(lastFrame() ?? "").toContain("Done · esc back");

    bridge.push(ev({ type: "turn_started", threadId: "main" })); // state.ts prunes done rows here
    await wait();
    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("Done · esc back"); // view auto-closed
    expect(frame).toContain("MAIN-ONLY-MARKER"); // main transcript restored
  });
});

describe("App — headless sanity (Phase 3d T4)", () => {
  test("(T4-d) `echo \"\" | bun src/main.ts --help` prints usage and exits 0 (never hangs on stdin, never crashes)", () => {
    const cliRoot = join(import.meta.dir, "..", ".."); // test/tui -> packages/cli
    const proc = Bun.spawnSync(["bun", "src/main.ts", "--help"], {
      cwd: cliRoot,
      stdin: new TextEncoder().encode("\n"),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(proc.exitCode).toBe(0);
    // Handoff Task 2: the header is now version-bearing (the Phase 1b-ii-d fossil is gone) —
    // main.test.ts pins the exact form; this test's job stays exit-0 + usage-not-hang.
    expect(proc.stdout.toString()).toContain(`norma ${CORE_VERSION} — commands:`);
  });
});

describe("bottomBarRows (pinned-bar line-count model)", () => {
  const task = (subject: string, status: TaskRow["status"]): TaskRow => ({ id: subject, subject, status });
  const agent = (threadId: string): AgentRow => ({
    threadId, agentType: "general-purpose", label: "a", status: "working",
    outputTokens: 0, liveOutputChars: 0, activeMs: 0, toolCalls: 0,
  });

  // Common fields every call needs post-T5 (columns/composerText/composerCursor/resuming) — 80
  // columns and an empty idle composer are wide/short enough that `composerRows` always comes out to
  // its old flat "3" (2 border rows + 1 unwrapped content row), so every pre-T5 expectation below is
  // unchanged; only the NEW "small columns" describe block below exercises actual wrapping.
  type Base = Parameters<typeof bottomBarRows>[0];
  const base = (overrides: Partial<Base>): Base => ({
    tasksVisible: true, tasks: [], agents: [], running: false, pending: null,
    columns: 80, composerText: "", composerCursor: 0, resuming: false, menuRows: 0,
    ...overrides,
  });

  test("empty: composer (3) + footer (1) = 4", () => {
    expect(bottomBarRows(base({}))).toBe(4);
  });

  test("spinner adds 1 while a turn runs", () => {
    expect(bottomBarRows(base({ running: true }))).toBe(5);
  });

  test("tasks add the count header + one row per task while visible; nothing when hidden", () => {
    const tasks = [task("a", "in_progress"), task("b", "pending")];
    expect(bottomBarRows(base({ tasks }))).toBe(4 + (1 + 2));
    expect(bottomBarRows(base({ tasks, tasksVisible: false }))).toBe(4);
  });

  test("each live agent adds two rows (head + continuation)", () => {
    expect(bottomBarRows(base({ agents: [agent("x"), agent("y")] }))).toBe(4 + 4);
  });

  test("a pending card replaces the composer's 3 (TUI renderer T3: the streaming turn no longer counts here — it lives in the transcript)", () => {
    const withCard = bottomBarRows(base({
      pending: { kind: "approval", callId: "c", toolName: "bash", summary: "x" },
    }));
    expect(withCard).toBe(1 + 1); // approval card (1) + footer (1), NOT the composer's 3
  });

  test("resuming adds 1 line", () => {
    expect(bottomBarRows(base({ resuming: true }))).toBe(5);
  });

  describe("composer wrap-awareness (T5 hard requirement — narrow columns)", () => {
    test("content longer than columns adds extra composer rows", () => {
      // Content = "❯ " (2) + 9 chars + a placeholder cursor cell (cursor at the end) = 12 visible
      // chars; at columns=10 that hard-wraps to ceil(12/10) = 2 rows, so the composer box grows from
      // 3 rows (2 border + 1 content) to 4 (2 border + 2 content).
      const text = "a".repeat(9);
      expect(bottomBarRows(base({ columns: 10, composerText: text, composerCursor: text.length })))
        .toBe(4 + 1); // composer(4) + footer(1); tasks/spinner/agents all 0
    });

    test("cursor AT the end costs one extra visible cell vs. cursor mid-text (same text)", () => {
      // Same 8-char text either way; visible length is 2("❯ ")+8+1(placeholder)=11 at the end vs.
      // 2+8+0=10 mid-text (the "at" character is already counted within the 8) — crossing the
      // columns=10 wrap boundary in exactly one of the two cases.
      const text = "a".repeat(8);
      const atEnd = bottomBarRows(base({ columns: 10, composerText: text, composerCursor: text.length }));
      const midText = bottomBarRows(base({ columns: 10, composerText: text, composerCursor: 4 }));
      expect(atEnd).toBe(4 + 1); // 11 visible chars -> 2 wrapped rows -> composer 4
      expect(midText).toBe(3 + 1); // 10 visible chars -> 1 wrapped row -> composer 3 (unchanged)
    });

    test("a pending card ignores composerText/composerCursor entirely (no wrap accounting needed)", () => {
      const huge = "x".repeat(500);
      const rows = bottomBarRows(base({
        columns: 10, composerText: huge, composerCursor: huge.length,
        pending: { kind: "approval", callId: "c", toolName: "bash", summary: "x" },
      }));
      expect(rows).toBe(1 + 1); // approval card (1) + footer (1) — the composer's wrap math never runs
    });
  });

  describe("completion menu row count (Phase 3d T2)", () => {
    test("menuRows adds directly to the bar when the composer is showing", () => {
      expect(bottomBarRows(base({ menuRows: 3 }))).toBe(4 + 3); // composer(3) + footer(1) + menu(3)
    });

    test("menuRows is ignored while a pending card owns the bottom bar", () => {
      const rows = bottomBarRows(base({
        menuRows: 6,
        pending: { kind: "approval", callId: "c", toolName: "bash", summary: "x" },
      }));
      expect(rows).toBe(1 + 1); // approval card (1) + footer (1) — menuRows never added
    });
  });
});

// ---------------------------------------------------------------------------------------------
// TUI renderer T3 — streaming inside the transcript, pinned PURE (no Ink): these compose the
// exact per-render derivation App runs — reduce → makeFlattenCache.lines(committed) ++
// makeStreamRenderer.lines(activeAssistant, activeTools) — so they hold in any environment,
// unlike the TTY-classed frame tests above.
// ---------------------------------------------------------------------------------------------

import { initialState, reduce } from "../../src/tui/state";
import { makeFlattenCache, makeStreamRenderer } from "../../src/tui/flatten-blocks";
import { applyWheel, followBottom, onContentGrown, visibleSlice } from "../../src/tui/scroll-model";

// BOUNDED EXCEPTIONS to this pin, disclosed here AT the pin (T3 fix round 1, reviewer item):
//  1. Mid-stream attach/resume: a client that missed earlier deltas (transients are never
//     persisted) holds only a SUFFIX of the text — the swap then renders the full committed text,
//     a real content difference (one honest reflow), not a glue artifact. This pin streams the
//     whole text, the only case where byte-equality is even claimable.
//  2. Cross-boundary reference-link definitions (`[ref]: url` settled before `[text][ref]`
//     streams): the settled prefix was lexed without the later definition, so the streamed frame
//     can show the literal form where the cold render resolves it — a one-row difference at the
//     swap, self-correcting. Same lex-composition assumption CC's monotonic boundary makes.
//  3. Degradation (createStreamingMarkdown's plain-tail mode past STREAM_OPEN_SEGMENT_MAX): the
//     dim plain overflow is deliberately NOT the cold render — the swap restyles it (pinned in
//     markdown.test.ts's degradation suite). This pin's texts stay under the threshold.
describe("T3 — the turn-end swap renders byte-identical rows (the no-glue pin)", () => {
  const FULL = "Streaming **works** now.\n\nSecond para with `code`.\n\n- item a\n- item b\n\nAll done here.";

  function streamedState(chunk: number) {
    let s = initialState();
    s = reduce(s, ev({ type: "turn_started", threadId: "main" }), 0);
    for (let i = chunk; i < FULL.length + chunk; i += chunk) {
      const upto = Math.min(i, FULL.length);
      const from = upto - Math.min(chunk, upto - (i - chunk));
      s = reduce(s, ev({ type: "assistant_delta", threadId: "main", delta: FULL.slice(i - chunk, upto), from }), 0);
    }
    return s;
  }

  test("lineLog before assistant_message === lineLog after, element-wise (arbitrary delta chunking)", () => {
    for (const chunk of [1, 5, FULL.length]) {
      const flatten = makeFlattenCache();
      const stream = makeStreamRenderer();
      const fopts = { columns: 80, verbose: false };
      const sopts = { columns: 80, dimToolDot: false };

      const s = streamedState(chunk);
      expect(s.activeAssistant).toBe(FULL); // wire property: deltas concat to the final text
      const before = [...flatten.lines(s.committed, fopts), ...stream.lines(s.activeAssistant, s.activeTools, sopts)];

      const s2 = reduce(s, ev({ type: "assistant_message", threadId: "main", text: FULL }), 0);
      // ONE state update: the block commits AND the stream clears in the same reduce.
      expect(s2.activeAssistant).toBe("");
      expect(s2.committed.length).toBe(s.committed.length + 1);
      const after = [...flatten.lines(s2.committed, fopts), ...stream.lines(s2.activeAssistant, s2.activeTools, sopts)];

      expect(after).toEqual(before); // byte-identical rows ⇒ the swap repaints nothing
    }
  });

  test("swap parity also holds when in-flight tool heads trail the streamed text", () => {
    const flatten = makeFlattenCache();
    const stream = makeStreamRenderer();
    const fopts = { columns: 80, verbose: false };
    const sopts = { columns: 80, dimToolDot: false };

    let s = streamedState(7);
    s = reduce(s, ev({ type: "tool_call", threadId: "main", name: "bash", argsJson: '{"command":"ls"}' }), 0);
    const before = [...flatten.lines(s.committed, fopts), ...stream.lines(s.activeAssistant, s.activeTools, sopts)];
    const s2 = reduce(s, ev({ type: "assistant_message", threadId: "main", text: FULL }), 0);
    const after = [...flatten.lines(s2.committed, fopts), ...stream.lines(s2.activeAssistant, s2.activeTools, sopts)];
    expect(after).toEqual(before); // tool head rows stay put after the assistant rows either way
  });
});

describe("T3 — streamed complete lines are scrollable transcript content mid-stream", () => {
  test("scroll back during a stream: streamed lines are readable, and further growth holds the view", () => {
    const stream = makeStreamRenderer();
    const sopts = { columns: 80, dimToolDot: false };
    const viewH = 5;

    // A stream tall enough to scroll: 12 complete plain lines + an open tail.
    const lines = Array.from({ length: 12 }, (_, i) => `streamed line ${i}`);
    const buf1 = lines.join("\n") + "\nopen tail";
    const log1 = stream.lines(buf1, [], sopts);
    expect(log1.length).toBeGreaterThan(viewH);

    // Wheel back far enough that the window sits over early streamed lines.
    let scroll = followBottom();
    scroll = applyWheel(scroll, { kind: "wheelUp", lines: 8 }, viewH, log1.length);
    const w1 = visibleSlice(log1, scroll, viewH, 0);
    const visible1 = log1.slice(w1.start, w1.end);
    expect(visible1.join("\n")).toContain("streamed line 2"); // an EARLY complete line, readable mid-stream

    // The stream grows (more complete lines land): compensation keeps the SAME rows in view.
    const buf2 = buf1 + " grows\nmore 1\nmore 2\nmore 3\n";
    const log2 = stream.lines(buf2, [], sopts);
    const grownBy = log2.length - log1.length;
    expect(grownBy).toBeGreaterThan(0);
    scroll = onContentGrown(scroll, grownBy);
    const w2 = visibleSlice(log2, scroll, viewH, 0);
    expect(log2.slice(w2.start, w2.end)).toEqual(visible1); // growth never moves a reader
  });
});

// ---------------------------------------------------------------------------------------------
// TUI renderer T3 — the 50% chrome cap, pinned AT THE LAYOUT MODEL: `bottomBarLayout` computes
// every piece's allotment and sheds (tasks → agents → input-slot content) until the bar fits
// `floor(rows/2)`. The render honors the allotments (JS-windowing, HARD CONSTRAINT 2), so the
// model's number IS the rendered height.
// ---------------------------------------------------------------------------------------------

import { bottomBarLayout, BAR_MAX_FRACTION } from "../../src/tui/app";

describe("bottomBarLayout — the composer+chrome slot never exceeds 50% of terminal rows (T3 pin)", () => {
  const task = (subject: string, status: TaskRow["status"]): TaskRow => ({ id: subject, subject, status });
  const agent = (threadId: string): AgentRow => ({
    threadId, agentType: "general-purpose", label: "a", status: "working",
    outputTokens: 0, liveOutputChars: 0, activeMs: 0, toolCalls: 0,
  });
  type LayoutBase = Parameters<typeof bottomBarLayout>[0];
  const base = (overrides: Partial<LayoutBase>): LayoutBase => ({
    tasksVisible: true, tasks: [], agents: [], running: false, pending: null,
    columns: 80, composerText: "", composerCursor: 0, resuming: false, menuRows: 0,
    ...overrides,
  });

  test("BAR_MAX_FRACTION is one half", () => {
    expect(BAR_MAX_FRACTION).toBe(0.5);
  });

  test("adversarial everything at rows=24 stays ≤ 12", () => {
    const layout = bottomBarLayout(base({
      tasks: Array.from({ length: 100 }, (_, i) => task(`t${i}`, "pending")),
      agents: Array.from({ length: 40 }, (_, i) => agent(`th_${i}`)),
      running: true, resuming: true, menuRows: 6,
      composerText: "x".repeat(2000), composerCursor: 2000, columns: 40,
    }), 24);
    expect(layout.rows).toBeLessThanOrEqual(12);
  });

  test("a huge pasted composer text is windowed, never overflows the cap", () => {
    const text = "y".repeat(5000);
    const layout = bottomBarLayout(base({ columns: 20, composerText: text, composerCursor: text.length }), 24);
    expect(layout.rows).toBeLessThanOrEqual(12);
    expect(layout.composerContentRows).toBeGreaterThanOrEqual(1);
    // content rows + 2 border rows + footer 1 = the whole bar here
    expect(layout.rows).toBe(layout.composerContentRows + 2 + 1);
  });

  test("a 200-line plan card is truncated to the cap with a disclosure line", () => {
    const layout = bottomBarLayout(base({
      pending: { kind: "plan", callId: "c", plan: Array.from({ length: 200 }, (_, i) => `step ${i}`).join("\n") },
    }), 24);
    expect(layout.rows).toBeLessThanOrEqual(12);
    expect(layout.planBodyRows).toBeGreaterThanOrEqual(1);
    expect(layout.planBodyRows).toBeLessThan(200);
  });

  test("shed order: tasks go before agents; agents window with an overflow line", () => {
    const layout = bottomBarLayout(base({
      tasks: Array.from({ length: 8 }, (_, i) => task(`t${i}`, "pending")),
      agents: Array.from({ length: 8 }, (_, i) => agent(`th_${i}`)),
    }), 24);
    expect(layout.rows).toBeLessThanOrEqual(12);
    expect(layout.showTasks).toBe(false); // tasks shed first (8 agents alone already fill the budget)
    expect(layout.agentsShown).toBeGreaterThan(0); // agents kept (windowed)
    expect(layout.agentsShown).toBeLessThan(8);
  });

  test("everything visible when it all fits (no shedding below the cap)", () => {
    const layout = bottomBarLayout(base({
      tasks: [task("a", "pending")], agents: [agent("x")], running: true,
    }), 40); // cap 20; tasks(2)+spinner(1)+composer(3)+agents(2)+footer(1) = 9
    expect(layout.showTasks).toBe(true);
    expect(layout.agentsShown).toBe(1);
    expect(layout.rows).toBe(9);
    expect(layout.rows).toBe(bottomBarRows(base({
      tasks: [task("a", "pending")], agents: [agent("x")], running: true,
    }), 40)); // bottomBarRows is the layout's total — one model, two views
  });

  test("tiny terminal: essentials (composer minimum + footer) may exceed the cap — floors win, and are bounded", () => {
    const layout = bottomBarLayout(base({}), 6); // cap 3, but composer(3)+footer(1) = 4 is the floor
    expect(layout.rows).toBe(4);
  });
});

// TUI renderer T4 — delta coalescing wired into App's bridge subscription (event-bridge.ts's
// makeDeltaCoalescer; strict window semantics live in delta-coalescer.test.ts on injected fake
// time). This is the WIRING pin, render-counted mechanism-appropriately: ink-testing-library's
// `frames` records one entry per Ink render, so counting the DISTINCT partial fold states that
// ever rendered counts the renders the burst caused (the ticking clock re-renders the SAME fold
// state, so it can't inflate the count; only a delta dispatch can mint a NEW state).
describe("App — delta coalescing (TUI renderer T4)", () => {
  test("a rapid delta burst folds to a handful of rendered states — never one render per delta", async () => {
    const bridge = makeEventBridge();
    const client = fakeClient();
    const { frames, lastFrame } = render(<App client={client} bridge={bridge} {...baseProps} />);
    await wait(); // subscribe effect
    bridge.push(ev({ type: "user_message", threadId: "main", text: "go" }));
    bridge.push(ev({ type: "turn_started", threadId: "main" }));
    await wait();
    const N = 12;
    for (let i = 0; i < N; i++) {
      bridge.push(ev({ type: "assistant_delta", threadId: "main", delta: `«${i}»` }));
      await wait(1); // macrotask spacing — each delta arrives as its own task, like the wire
    }
    await wait(40); // let the trailing-edge window(s) flush
    expect(lastFrame() ?? "").toContain(`«${N - 1}»`); // the full burst landed — nothing dropped
    // For each frame: the highest «i» visible = which fold state that render showed.
    const states = new Set<number>();
    for (const f of frames) {
      for (let i = N - 1; i >= 0; i--) {
        if (f.includes(`«${i}»`)) { states.add(i); break; }
      }
    }
    expect(states.size).toBeGreaterThan(0);
    expect(states.size).toBeLessThanOrEqual(3); // 12 deltas ⇒ ≤3 rendered fold states (≈1-2 windows)
  });
});

// ---------------------------------------------------------------------------------------------
// TUI renderer T5 — the bottom status chrome wired into the App: the chrome rows feed
// `bottomBarLayout`'s accounting (the 50% cap counts them), and the live sources flow end-to-end
// (bg_task events → work line; session_activity → chip; /model → the model segment).
// ---------------------------------------------------------------------------------------------

describe("bottomBarLayout — T5: the chrome rows are counted (the cap can't be lied to)", () => {
  type LayoutBase = Parameters<typeof bottomBarLayout>[0];
  const base = (overrides: Partial<LayoutBase>): LayoutBase => ({
    tasksVisible: true, tasks: [], agents: [], running: false, pending: null,
    columns: 80, composerText: "", composerCursor: 0, resuming: false, menuRows: 0,
    ...overrides,
  });

  test("chromeRows defaults to 1 (every pre-T5 expectation unchanged: empty = 4)", () => {
    expect(bottomBarLayout(base({})).rows).toBe(4);
  });

  test("the second chrome line adds exactly one row", () => {
    expect(bottomBarLayout(base({ chromeRows: 2 })).rows).toBe(5);
  });

  test("PIN: adding the second line doesn't break the 50% cap — content sheds instead", () => {
    const text = "x".repeat(200); // a fat wrapped composer that alone would fill the cap
    const one = bottomBarLayout(base({ columns: 20, composerText: text, composerCursor: text.length, chromeRows: 1 }), 24);
    const two = bottomBarLayout(base({ columns: 20, composerText: text, composerCursor: text.length, chromeRows: 2 }), 24);
    expect(one.rows).toBeLessThanOrEqual(12);
    expect(two.rows).toBeLessThanOrEqual(12); // the cap holds WITH the extra chrome row counted
    expect(two.composerContentRows).toBe(one.composerContentRows - 1); // the row came out of content
  });
});

describe("App — T5 status chrome end-to-end (live sources, zero daemon changes)", () => {
  test("(sc1) a bg_task_started shows the work line; its bg_task_exited clears it", async () => {
    const bridge = makeEventBridge();
    const client = fakeClient();
    const { lastFrame } = render(<App client={client} bridge={bridge} {...baseProps} />);
    await wait();
    expect(lastFrame() ?? "").not.toContain("1 task:");

    bridge.push(ev({ type: "bg_task_started", threadId: "main", taskId: "bg1", command: "bun test" }));
    await wait();
    expect(lastFrame() ?? "").toContain("1 task: bun test");

    bridge.push(ev({ type: "bg_task_exited", threadId: "main", taskId: "bg1", exitCode: 0, killed: false }));
    await wait();
    expect(lastFrame() ?? "").not.toContain("1 task:");
  });

  test("(sc2) a session_activity transient flips the chip on and off", async () => {
    const bridge = makeEventBridge();
    const client = fakeClient();
    const { lastFrame } = render(<App client={client} bridge={bridge} {...baseProps} />);
    await wait();
    expect(lastFrame() ?? "").not.toContain("● backgrounded");

    bridge.push(ev({ type: "session_activity", activity: "background" }));
    await wait();
    expect(lastFrame() ?? "").toContain("● backgrounded");

    bridge.push(ev({ type: "session_activity", activity: "active" }));
    await wait();
    expect(lastFrame() ?? "").not.toContain("● backgrounded");
  });

  test("(sc3) the footer shows the mount model; /model switches it IMMEDIATELY (live through the CommandCtx callback)", async () => {
    // Same temp-NORMA_HOME discipline as commands.test.ts's /model suite — never ~/.norma.
    const home = mkdtempSync(join(tmpdir(), "norma-tui-t5-model-"));
    writeFileSync(join(home, "settings.json"), JSON.stringify({ schemaVersion: 2, provider: { type: "codex-oauth", model: "gpt-5.6-sol" } }));
    const prevHome = process.env.NORMA_HOME;
    process.env.NORMA_HOME = home;
    try {
      const bridge = makeEventBridge();
      const client = fakeClient();
      const { stdin, lastFrame } = render(<App client={client} bridge={bridge} {...baseProps} />);
      await wait();
      // The mount-time model rides the footer's status line from the first frame (baseProps.model).
      expect(lastFrame() ?? "").toContain("gpt-5-codex");

      stdin.write("/model gpt-5.6-luna --effort high");
      await wait();
      stdin.write("\r");
      await wait();

      const frame = lastFrame() ?? "";
      expect(frame).toContain("model gpt-5.6-luna, effort high"); // the committed note (unchanged wording)
      expect(frame).toContain("gpt-5.6-luna (high)"); // THE PIN: the footer segment flipped, same frame
      expect(client.calls).toEqual([]); // /model never touches the client (settings.json route)
    } finally {
      if (prevHome === undefined) delete process.env.NORMA_HOME;
      else process.env.NORMA_HOME = prevHome;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("(sc4) the work line ALSO counts live agents — and the viewport gives up the row (layout honesty)", async () => {
    const bridge = makeEventBridge();
    const client = fakeClient();
    const { lastFrame } = render(<App client={client} bridge={bridge} {...baseProps} />);
    await wait();

    bridge.push(ev({ type: "thread_started", threadId: "th_1", agentType: "general-purpose", description: "scout run", ts: 500 }));
    bridge.push(ev({ type: "turn_started", threadId: "th_1", ts: 1000 }));
    await wait();

    const frame = lastFrame() ?? "";
    expect(frame).toContain("1 task: scout run"); // the work line
    expect(frame).toContain("1 agent · ctrl+a"); // the roster pill stays (the ctrl+a affordance)
    // The frame is still exactly rows-1 = 23 lines tall — the chrome row was paid for by the
    // viewport via bottomBarLayout, not stacked on top of the frame.
    expect((frame.split("\n").length)).toBeLessThanOrEqual(23);
  });
});
