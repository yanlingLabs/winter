import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { CommittedTranscript, formatArgsHead } from "../../src/tui/transcript";
import { ActiveTurn } from "../../src/tui/active-turn";
import { TaskList } from "../../src/tui/task-list";
import { AgentList } from "../../src/tui/agent-list";
import { ROSTER_STALL_MS } from "../../src/subagent-state";
import { pickVerb, TURN_VERBS } from "../../src/tui/spinner-verbs";
import type { Block, AgentRow } from "../../src/tui/state";
import type { TaskRow } from "../../src/task-display";

// Phase 3b Task 3 rewrites this describe block to the CC ⏺/⎿/❯ grammar (transcript study §2).
// MIGRATION NOTE (preserves 3a's coverage intents, doesn't just delete them):
//  - 3a's "› hello there" user-prefix assertion -> now "❯ hello there" (e) below.
//  - 3a's "⚙ name args ▸ output" one-liner -> now split into a bold-name/plain-args USE line +
//    a separate dim `⎿` RESULT line (d) below.
//  - 3a's "second output line must NOT leak" intent (guarding against unbounded output dumped onto
//    one line) is migrated to the NEW cap: up to 10 lines show, the 11th+ do not, with a
//    "… +N lines (ctrl+o to expand)" note — see the 25-line-output test in (d).
//  - 3a's "ERROR: " literal prefix is gone (error state is now conveyed by the gutter/text color,
//    not a literal string); the migrated error test asserts CONTENT only, matching the brief's
//    explicit "assert content, not ANSI" instruction for that case.
describe("CommittedTranscript — assistant block (c)", () => {
  test("renders the ⏺ gutter + a markdown-rendered body (bold applied, raw ** markers gone)", () => {
    const items: Block[] = [{ kind: "assistant", text: "hi **there**, friend" }];
    const { lastFrame } = render(<CommittedTranscript items={items} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("⏺");
    expect(frame).toContain("hi");
    expect(frame).toContain("there");
    expect(frame).toContain("friend");
    expect(frame).not.toContain("**there**"); // markdown was rendered (bolded), not left as literal text
  });
});

describe("CommittedTranscript — tool block (d)", () => {
  test("bold name + (args) + ⎿ result, capped at 10 lines with a '+N lines' truncation note", () => {
    const output = Array.from({ length: 25 }, (_, i) => `line${i}`).join("\n");
    const items: Block[] = [{ kind: "tool", name: "bash", argsJson: '{"command":"ls -la"}', output, isError: false }];
    const { lastFrame } = render(<CommittedTranscript items={items} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("bash");
    expect(frame).toContain('({"command":"ls -la"})');
    expect(frame).toContain("⎿");
    for (let i = 0; i < 10; i++) expect(frame).toContain(`line${i}`);
    for (let i = 10; i < 25; i++) expect(frame).not.toContain(`line${i}`);
    expect(frame).toContain("… +15 lines (ctrl+o to expand)");
  });

  test("an errored tool block still renders its output content (error state is color-only now, no 'ERROR:' literal)", () => {
    const items: Block[] = [{ kind: "tool", name: "bash", argsJson: "{}", output: "boom", isError: true }];
    const { lastFrame } = render(<CommittedTranscript items={items} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("boom");
    expect(frame).not.toContain("ERROR:");
  });

  test("empty argsJson renders the bare tool name with no parens", () => {
    const items: Block[] = [{ kind: "tool", name: "bash", argsJson: "", output: "ok" }];
    const { lastFrame } = render(<CommittedTranscript items={items} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("bash");
    expect(frame).not.toContain("()");
  });
});

describe("formatArgsHead — the shared 160-char/2-line args cap (T3 review fix)", () => {
  test("a 300-char single-line args string truncates to 160 chars + …", () => {
    const args = "x".repeat(300);
    const head = formatArgsHead(args);
    expect(head).toBe("x".repeat(160) + "…");
  });

  test("a 4-line args string shows only the first 2 lines + …", () => {
    const args = ["line-a", "line-b", "line-c", "line-d"].join("\n");
    const head = formatArgsHead(args);
    expect(head).toBe("line-a\nline-b…");
    expect(head).not.toContain("line-c");
    expect(head).not.toContain("line-d");
  });

  test("a short args string passes through unchanged (no …)", () => {
    expect(formatArgsHead('{"command":"ls"}')).toBe('{"command":"ls"}');
    expect(formatArgsHead("")).toBe("");
  });
});

describe("CommittedTranscript — user block (e)", () => {
  test("shows ❯ + text", () => {
    const items: Block[] = [{ kind: "user", text: "hello there" }];
    const { lastFrame } = render(<CommittedTranscript items={items} />);
    expect(lastFrame() ?? "").toContain("❯ hello there");
  });
});

describe("CommittedTranscript — note block", () => {
  test("dim ✻ prefix + text (agent-finish-note WORDING is untouched by this task — only the glyph prefix is added)", () => {
    const items: Block[] = [{ kind: "note", text: 'Agent "refactor widget" finished · 14s\n⎿ Ran 1 tool calls' }];
    const { lastFrame } = render(<CommittedTranscript items={items} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("✻");
    expect(frame).toContain('Agent "refactor widget" finished · 14s');
    expect(frame).toContain("Ran 1 tool calls");
  });
});

describe("CommittedTranscript — turn-summary block (f)", () => {
  test("renders ✻ + verb + 'for 12s' + ↑13.7k ↓149 tokens", () => {
    const items: Block[] = [{ kind: "turn-summary", durationMs: 12_000, inTokens: 13_700, outTokens: 149 }];
    const { lastFrame } = render(<CommittedTranscript items={items} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("✻");
    expect(frame).toContain(pickVerb(TURN_VERBS, 12_000));
    expect(frame).toContain("for 12s");
    expect(frame).toContain("↑13.7k");
    expect(frame).toContain("↓149");
    expect(frame).toContain("tokens");
  });
});

describe("CommittedTranscript — interrupted block (g)", () => {
  test("exact wording", () => {
    const items: Block[] = [{ kind: "interrupted" }];
    const { lastFrame } = render(<CommittedTranscript items={items} />);
    expect(lastFrame() ?? "").toContain("Interrupted · What should Norma do instead?");
  });
});

describe("CommittedTranscript — collapsed read/search groups (phase 3b T4)", () => {
  test("a lone read collapses to one dim ⏺ line with the summary + ctrl+o hint", () => {
    const items: Block[] = [{ kind: "tool", name: "read", argsJson: '{"path":"a.ts"}', output: "ok" }];
    const { lastFrame } = render(<CommittedTranscript items={items} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("⏺");
    expect(frame).toContain("Read 1 file");
    expect(frame).toContain("(ctrl+o to expand)");
    expect(frame).not.toContain('{"path":"a.ts"}'); // collapsed — no per-call args/output leaked
  });

  test("a non-collapsible tool (bash) still renders individually, unaffected by grouping", () => {
    const items: Block[] = [{ kind: "tool", name: "bash", argsJson: '{"command":"ls"}', output: "ok" }];
    const { lastFrame } = render(<CommittedTranscript items={items} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("bash");
    expect(frame).not.toContain("ctrl+o to expand");
  });

  // Regression test for Ink's <Static> write-once semantics (build/components/Static.js: it slices
  // `items.slice(index)` and permanently paints only that new tail — an already-painted index is
  // NEVER revisited). Feeding `<Static>` a naively recomputed `groupBlocks(committed)` array breaks
  // this: when a 2nd read arrives, the still-open run's DisplayItem[] length does not grow (it just
  // absorbs the new block into the SAME collapsed item) so Static would silently skip repainting it
  // and the summary would freeze stale at "Read 1 file" forever. CommittedTranscript instead holds
  // the still-open trailing run out of Static (rendered in a plain, always-fresh Box) until a
  // breaking block closes it — this test proves that split actually keeps the on-screen summary
  // live across the exact rerender sequence that would otherwise go stale.
  test("(regression) a run's summary updates correctly across rerenders as it grows, instead of freezing at the first count", () => {
    const read: Block = { kind: "tool", name: "read", argsJson: '{"path":"a.ts"}', output: "ok" };
    const grep: Block = { kind: "tool", name: "grep", argsJson: '{"pattern":"foo"}', output: "1 match" };
    const assistantBlock: Block = { kind: "assistant", text: "done investigating" };

    const { lastFrame, rerender } = render(<CommittedTranscript items={[read]} />);
    expect(lastFrame() ?? "").toContain("Read 1 file");

    rerender(<CommittedTranscript items={[read, grep]} />);
    const afterGrep = lastFrame() ?? "";
    expect(afterGrep).toContain("Read 1 file, searched 1 pattern"); // merged, NOT stuck at "Read 1 file"
    expect(afterGrep).not.toContain("Read 1 file\n"); // stale single-read summary must not linger alongside the merged one

    rerender(<CommittedTranscript items={[read, grep, assistantBlock]} />);
    const afterClose = lastFrame() ?? "";
    expect(afterClose).toContain("Read 1 file, searched 1 pattern"); // now-closed group renders correctly
    expect(afterClose).toContain("done investigating");
  });
});

describe("AgentList — tree rows (phase 3b Task 6, c)", () => {
  function agent(overrides: Partial<AgentRow>): AgentRow {
    return {
      threadId: "th_x",
      agentType: "general-purpose",
      label: "scout",
      status: "working",
      outputTokens: 0,
      liveOutputChars: 0,
      activeMs: 0,
      toolCalls: 0,
      ...overrides,
    };
  }

  test("a single agent renders as the LAST row: '└─ ' head + bold agentType + (label) + tool-use count", () => {
    const row = agent({ threadId: "th_1", agentType: "general-purpose", label: "scout", status: "working", toolCalls: 3 });
    const { lastFrame } = render(<AgentList agents={[row]} nowMs={999_999} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("└─");
    expect(frame).not.toContain("├─");
    expect(frame).toContain("general-purpose");
    expect(frame).toContain("(scout)");
    expect(frame).toContain("3 tool uses");
  });

  test("a DONE agent's continuation row reads 'Done'", () => {
    const row = agent({ status: "done", finish: "done", toolCalls: 1 });
    const { lastFrame } = render(<AgentList agents={[row]} nowMs={0} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("⎿");
    expect(frame).toContain("Done");
  });

  // Roster honesty (no-timeout task): failed/stopped terminal rows must NOT read "Done" — the
  // wire's thread_completed.stopReason (mapped to `finish` by subagent-state.ts) drives the verb.
  test("a FAILED agent's continuation row reads 'Failed', not 'Done'", () => {
    const row = agent({ status: "done", finish: "failed", toolCalls: 2 });
    const frame = render(<AgentList agents={[row]} nowMs={0} />).lastFrame() ?? "";
    expect(frame).toContain("Failed");
    expect(frame).not.toContain("Done");
  });

  test("a STOPPED agent's continuation row reads 'Stopped', not 'Done'", () => {
    const row = agent({ status: "done", finish: "stopped", toolCalls: 0 });
    const frame = render(<AgentList agents={[row]} nowMs={0} />).lastFrame() ?? "";
    expect(frame).toContain("Stopped");
    expect(frame).not.toContain("Done");
  });

  // task-16 (Stalled roster verb, CC-parity follow-up): a stall-killed agent gets its own
  // distinct continuation-row verb, never the generic "Failed" a real crash gets.
  test("a STALLED agent's continuation row reads 'Stalled', not 'Done' or 'Failed'", () => {
    const row = agent({ status: "done", finish: "stalled", toolCalls: 0 });
    const frame = render(<AgentList agents={[row]} nowMs={0} />).lastFrame() ?? "";
    expect(frame).toContain("Stalled");
    expect(frame).not.toContain("Done");
    expect(frame).not.toContain("Failed");
  });

  // task-5 (live stall hint): the "Stalled" verb above is a POST-MORTEM — it only exists once the
  // daemon's 600s stall watchdog has already killed the child. These pin the PRE-KILL half: a
  // working row that has gone silent past the roster threshold, with nothing in flight, swaps its
  // activity verb for a distinct "Stalled · no output for …" line, so the user can SEE it without
  // having to kill it first.
  test("a WORKING row silent past the threshold with nothing in flight reads 'Stalled · no output for …', not its activity", () => {
    const row = agent({ status: "working", activity: "reading src/app.ts", lastEventAt: 1_000 });
    const frame = render(<AgentList agents={[row]} nowMs={1_000 + ROSTER_STALL_MS + 1} />).lastFrame() ?? "";
    expect(frame).toContain("Stalled");
    expect(frame).toContain("no output for");
    expect(frame).not.toContain("reading src/app.ts");
    expect(frame).not.toContain("Working…");
  });

  test("the stalled line reports the REAL silence span, formatted like every other elapsed span", () => {
    const row = agent({ status: "working", lastEventAt: 0 });
    const frame = render(<AgentList agents={[row]} nowMs={125_000} />).lastFrame() ?? "";
    expect(frame).toContain("no output for 2m 5s");
  });

  test("under the threshold the row is untouched — the activity verb still shows", () => {
    const row = agent({ status: "working", activity: "reading src/app.ts", lastEventAt: 1_000 });
    const frame = render(<AgentList agents={[row]} nowMs={1_000 + ROSTER_STALL_MS} />).lastFrame() ?? "";
    expect(frame).toContain("reading src/app.ts");
    expect(frame).not.toContain("Stalled");
  });

  test("a long-running TOOL is never called stalled, however long it has been silent", () => {
    const row = agent({ status: "working", activity: "bun test", lastEventAt: 0, toolsInFlight: 1 });
    const frame = render(<AgentList agents={[row]} nowMs={9_999_999} />).lastFrame() ?? "";
    expect(frame).toContain("bun test");
    expect(frame).not.toContain("Stalled");
  });

  test("a row parked on an approval is never called stalled — it is waiting on a human", () => {
    const row = agent({ status: "working", lastEventAt: 0, approvalsPending: 1 });
    const frame = render(<AgentList agents={[row]} nowMs={9_999_999} />).lastFrame() ?? "";
    expect(frame).toContain("Working…");
    expect(frame).not.toContain("Stalled");
  });

  test("a DONE row keeps its finish verb — the live hint never overrides the post-mortem", () => {
    const row = agent({ status: "done", finish: "done", lastEventAt: 0 });
    const frame = render(<AgentList agents={[row]} nowMs={9_999_999} />).lastFrame() ?? "";
    expect(frame).toContain("Done");
    expect(frame).not.toContain("Stalled");
  });

  test("a terminal row with NO finish recorded (pre-change replay) falls back to 'Done'", () => {
    const row = agent({ status: "done", toolCalls: 1 }); // finish deliberately absent
    const frame = render(<AgentList agents={[row]} nowMs={0} />).lastFrame() ?? "";
    expect(frame).toContain("Done");
  });

  test("a working agent with no recorded activity yet shows 'Working…' on the continuation row", () => {
    const row = agent({ status: "working" });
    const { lastFrame } = render(<AgentList agents={[row]} nowMs={0} />);
    expect(lastFrame() ?? "").toContain("Working…");
  });

  test("a working agent WITH a recorded activity shows that activity string, not 'Working…'", () => {
    const row = agent({ status: "working", activity: "reading src/app.ts" });
    const { lastFrame } = render(<AgentList agents={[row]} nowMs={0} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("reading src/app.ts");
    expect(frame).not.toContain("Working…");
  });

  test("two agents: first row is '├─ ' with a '│  ⎿' continuation, last row is '└─ ' with a '   ⎿' continuation", () => {
    const first = agent({ threadId: "th_1", label: "first agent", status: "working" });
    const last = agent({ threadId: "th_2", label: "second agent", status: "done" });
    const { lastFrame } = render(<AgentList agents={[first, last]} nowMs={0} />);
    const frame = lastFrame() ?? "";
    const lines = frame.split("\n");
    expect(lines.some((l) => l.includes("├─") && l.includes("first agent"))).toBe(true);
    expect(lines.some((l) => l.includes("└─") && l.includes("second agent"))).toBe(true);
    expect(lines.some((l) => l.includes("│") && l.includes("⎿"))).toBe(true);
    expect(lines.some((l) => l.includes("   ⎿") && !l.includes("│"))).toBe(true);
  });

  test("hidden when there are no agents", () => {
    const { lastFrame } = render(<AgentList agents={[]} nowMs={0} />);
    expect((lastFrame() ?? "").trim()).toBe("");
  });

  // Phase 5a Task 3: a background child's `name` (recorded by state.ts's spawn_agent tool_call/
  // tool_result pairing) is a re-taskable handle, distinct from `.label`'s description-derived
  // display text — the row shape/layout is unchanged, this is a label swap only.
  test("a mapped `name` renders in place of the label", () => {
    const row = agent({ threadId: "th_1", label: "scout", name: "my-agent" });
    const { lastFrame } = render(<AgentList agents={[row]} nowMs={0} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("(my-agent)");
    expect(frame).not.toContain("(scout)");
  });

  test("no mapped name falls back to the label, unchanged from before this task", () => {
    const row = agent({ threadId: "th_1", label: "scout" });
    const { lastFrame } = render(<AgentList agents={[row]} nowMs={0} />);
    expect(lastFrame() ?? "").toContain("(scout)");
  });

  // child-transcript-view T3: App's roster select mode highlights ONE row via `selectedIndex` —
  // that row's head gutter swaps to a "▶" pointer; every other row keeps its tree gutter. Omitted
  // renders byte-identical to before (no pointer anywhere) — the tests above all pin that already.
  test("selectedIndex swaps the highlighted row's gutter to the ▶ pointer, others untouched", () => {
    const first = agent({ threadId: "th_1", label: "first agent", status: "working" });
    const last = agent({ threadId: "th_2", label: "second agent", status: "working" });
    const frame = render(<AgentList agents={[first, last]} nowMs={0} selectedIndex={1} />).lastFrame() ?? "";
    const lines = frame.split("\n");
    expect(lines.some((l) => l.includes("▶") && l.includes("second agent"))).toBe(true);
    expect(lines.some((l) => l.includes("├─") && l.includes("first agent"))).toBe(true); // unselected keeps its gutter
    expect(lines.some((l) => l.includes("▶") && l.includes("first agent"))).toBe(false);
  });

  test("selectedIndex undefined renders no pointer at all", () => {
    const rows = [agent({ threadId: "th_1", label: "a" }), agent({ threadId: "th_2", label: "b" })];
    const frame = render(<AgentList agents={rows} nowMs={0} />).lastFrame() ?? "";
    expect(frame).not.toContain("▶");
  });
});

// The Ink <StatusLine> component was removed in Phase 3b Task 7 — the Spinner (turn chrome) + Footer
// (mode/interrupt/agents hints) now own that surface, so there is nothing single-line-status left to
// test here. (The legacy TTY renderStatusLine/truncateStatusLine in task-block.ts are unrelated and
// still covered by test/task-block.test.ts.)

describe("TaskList — CC task rows (phase 3b Task 6, a+b)", () => {
  test("hidden when empty", () => {
    const { lastFrame } = render(<TaskList tasks={[]} nowMs={0} />);
    expect((lastFrame() ?? "").trim()).toBe("");
  });

  test("done task: ✔ glyph + strikethrough subject", () => {
    const tasks: TaskRow[] = [{ id: "1", subject: "Ship feature", status: "completed" }];
    const { lastFrame } = render(<TaskList tasks={tasks} nowMs={0} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("✔");
    expect(frame).toContain("Ship feature");
    expect(frame).toContain("[9m"); // strikethrough SGR code
  });

  test("in-progress task: filled square glyph + BOLD subject", () => {
    const tasks: TaskRow[] = [{ id: "1", subject: "Write tests", status: "in_progress" }];
    const { lastFrame } = render(<TaskList tasks={tasks} nowMs={0} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("◼");
    expect(frame).toContain("Write tests");
    expect(frame).toContain("[1m"); // bold SGR code
  });

  test("pending task: plain square glyph, no bold/strikethrough", () => {
    const tasks: TaskRow[] = [{ id: "1", subject: "Later task", status: "pending" }];
    const { lastFrame } = render(<TaskList tasks={tasks} nowMs={0} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("◻");
    expect(frame).toContain("Later task");
    expect(frame).not.toContain("[1m");
    expect(frame).not.toContain("[9m");
  });

  test("counts header line + overflow: a 4th completed task collapses behind a dim overflow line", () => {
    const tasks: TaskRow[] = [
      { id: "1", subject: "done1", status: "completed" },
      { id: "2", subject: "done2", status: "completed" },
      { id: "3", subject: "done3", status: "completed" },
      { id: "4", subject: "done4", status: "completed" },
      { id: "5", subject: "in progress task", status: "in_progress" },
    ];
    const { lastFrame } = render(<TaskList tasks={tasks} nowMs={0} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("5 tasks (4 done, 1 in progress, 0 open)");
    expect(frame).toContain("done1");
    expect(frame).toContain("done2");
    expect(frame).toContain("done3");
    expect(frame).not.toContain("done4"); // 4th completed collapsed away by collapseCompleted
    expect(frame).toContain("+1"); // dim overflow line surfaces the hidden count
  });
});

// Phase 3b Task 3 rewrite: streaming assistant text now goes through splitStableBoundary +
// renderMarkdown (migrating 3a's plain-cyan-text coverage), and in-flight tools render the
// CC-style `bold name(argsHead)` USE line instead of the 3a `⚙ name args` one-liner, with a
// blinking (nowMs-parity) gutter dot — (h) below is the brief's new required case.
describe("ActiveTurn — streaming assistant text (memoized stable prefix)", () => {
  test("renders a completed leading paragraph (stable, markdown-rendered) plus a growing partial tail", () => {
    const { lastFrame } = render(
      <ActiveTurn assistant={"First **para** complete.\n\nSecond para partial"} tools={[]} nowMs={0} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("First");
    expect(frame).toContain("para"); // bold marker rendered, not left literal
    expect(frame).not.toContain("**para**");
    expect(frame).toContain("complete.");
    expect(frame).toContain("Second para partial");
  });

  test("streaming text shares the ⏺ gutter layout (T3 review fix): the dot renders on the FIRST streamed line, so committing the block causes no indent jump", () => {
    const { lastFrame } = render(<ActiveTurn assistant="streaming reply text" tools={[]} nowMs={0} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("⏺");
    // the gutter and the text share one row: "⏺ streaming reply text" (2-col gutter → one space
    // between the dot and the flexGrow column), identical to the committed assistant block's layout
    const firstLine = frame.split("\n")[0] ?? "";
    expect(firstLine).toContain("⏺");
    expect(firstLine).toContain("streaming reply text");
  });

  test("hidden when idle (no assistant text, no in-flight tools)", () => {
    const { lastFrame } = render(<ActiveTurn assistant="" tools={[]} nowMs={0} />);
    expect((lastFrame() ?? "").trim()).toBe("");
  });
});

describe("ActiveTurn — in-flight tools (bold name(argsHead160) + blinking dot) (h)", () => {
  test("renders bold tool name + args head alongside the gutter dot", () => {
    const { lastFrame } = render(
      <ActiveTurn assistant="" tools={[{ name: "bash", argsJson: '{"command":"ls"}' }]} nowMs={0} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("⏺");
    expect(frame).toContain("bash");
    expect(frame).toContain('({"command":"ls"})');
  });

  test("(h) the gutter dot's dim/normal state flips across two nowMs values 500ms apart, and returns at 1000ms", () => {
    const tools = [{ name: "bash", argsJson: '{"command":"ls"}' }];
    const { lastFrame, rerender } = render(<ActiveTurn assistant="" tools={tools} nowMs={0} />);
    const frameAt0 = lastFrame() ?? "";

    rerender(<ActiveTurn assistant="" tools={tools} nowMs={500} />);
    const frameAt500 = lastFrame() ?? "";
    expect(frameAt500).not.toBe(frameAt0); // parity flipped -> different dim styling

    rerender(<ActiveTurn assistant="" tools={tools} nowMs={1000} />);
    expect(lastFrame() ?? "").toBe(frameAt0); // parity flipped back -> byte-identical to nowMs=0
  });
});
