import { describe, expect, test } from "bun:test";
import type { Task } from "@yanlinglabs/winter-protocol";
import { taskCountsLine, taskGlyph } from "../src/task-display";
import type { CliSubagent } from "../src/subagent-state";
import {
  BLUE,
  BOLD,
  DIM,
  GREEN,
  RESET,
  SPINNER_FRAMES,
  TASK_ICONS,
  physicalRows,
  renderAgentsFooter,
  renderModeBar,
  renderStatusLine,
  renderTaskBlock,
  trackLineStart,
  truncateStatusLine,
  upsertTask,
  type FooterSelection,
} from "../src/task-block";

function task(id: string, subject: string, status: Task["status"]): Task {
  return { id, subject, status };
}

describe("upsertTask", () => {
  test("appends a new task id, preserving arrival order", () => {
    const t1 = task("1", "write tests", "pending");
    const t2 = task("2", "ship it", "pending");
    expect(upsertTask([], t1)).toEqual([t1]);
    expect(upsertTask([t1], t2)).toEqual([t1, t2]);
  });

  test("replaces an existing id in place without reordering the list", () => {
    const t1 = task("1", "write tests", "pending");
    const t2 = task("2", "ship it", "pending");
    const t1Done: Task = { ...t1, status: "in_progress" };
    expect(upsertTask([t1, t2], t1Done)).toEqual([t1Done, t2]);
  });

  test("does not mutate the input array (pure)", () => {
    const t1 = task("1", "write tests", "pending");
    const original = [t1];
    upsertTask(original, task("2", "ship it", "pending"));
    expect(original).toEqual([t1]);
  });

  // T3 review fix wave 1: a task_updated carrying status "deleted" REMOVES the entry instead of
  // upserting it — otherwise the pinned block phantoms deleted tasks forever (the daemon never
  // sends a follow-up event once a task is actually gone from the store).
  describe("status: \"deleted\" removes instead of upserting (T3 review fix wave 1)", () => {
    test("removes an existing id from the list", () => {
      const t1 = task("1", "write tests", "pending");
      const t2 = task("2", "ship it", "pending");
      const deleted: Task = { ...t1, status: "deleted" };
      expect(upsertTask([t1, t2], deleted)).toEqual([t2]);
    });

    test("deleting an id not present is a no-op (list unchanged)", () => {
      const t1 = task("1", "write tests", "pending");
      const deleted: Task = { id: "999", subject: "ghost", status: "deleted" };
      expect(upsertTask([t1], deleted)).toEqual([t1]);
    });

    test("does not mutate the input array (pure)", () => {
      const t1 = task("1", "write tests", "pending");
      const original = [t1];
      upsertTask(original, { ...t1, status: "deleted" });
      expect(original).toEqual([t1]);
    });
  });
});

describe("renderTaskBlock (CC tree: shared sort/collapse + colored glyphs)", () => {
  test("empty task list renders nothing", () => {
    expect(renderTaskBlock([])).toEqual([]);
  });

  test("all-completed task list renders nothing (CC parity: block disappears) — testAllCompletedEmpty", () => {
    const tasks = [task("1", "write tests", "completed"), task("2", "ship it", "completed")];
    expect(renderTaskBlock(tasks)).toEqual([]);
  });

  // Task 3 (2e-iii-b): brief's Step-1 contract test, verbatim modulo this file's 3-arg `task()`.
  test("renderTaskBlock prepends the dim count header", () => {
    const lines = renderTaskBlock([task("a", "do a thing", "in_progress")], 80);
    expect(lines[0]).toBe(`${DIM}1 tasks (0 done, 1 in progress, 0 open)${RESET}`);
  });

  test("in_progress row sorts first, is blue + bold; pending sorts after, dim, not bold", () => {
    const tasks = [task("1", "write tests", "pending"), task("2", "run tests", "in_progress")];
    const lines = renderTaskBlock(tasks);
    expect(lines).toEqual([
      `${DIM}${taskCountsLine(tasks)}${RESET}`,
      `${BLUE}${taskGlyph("in_progress")}${RESET}${BOLD} run tests${RESET}`,
      `${DIM}${taskGlyph("pending")}${RESET} write tests`,
    ]);
  });

  test("completed rows are green, not bold; pending still sorts ahead of completed", () => {
    const tasks = [task("1", "write tests", "completed"), task("2", "ship it", "pending")];
    const lines = renderTaskBlock(tasks);
    expect(lines).toEqual([
      `${DIM}${taskCountsLine(tasks)}${RESET}`,
      `${DIM}${taskGlyph("pending")}${RESET} ship it`,
      `${GREEN}${taskGlyph("completed")}${RESET} write tests`,
    ]);
  });

  test("testBlockSortsAndCollapses: 1 in_progress + 4 completed → count header, then in_progress row (■), '… +1 completed' present (cap 3)", () => {
    const tasks = [
      task("c1", "alpha", "completed"),
      task("c2", "beta", "completed"),
      task("ip", "active one", "in_progress"),
      task("c3", "gamma", "completed"),
      task("c4", "delta", "completed"),
    ];
    const lines = renderTaskBlock(tasks);
    expect(lines[0]).toBe(`${DIM}${taskCountsLine(tasks)}${RESET}`);
    expect(lines[1]).toBe(`${BLUE}■${RESET}${BOLD} active one${RESET}`);
    expect(lines).toContain(`${DIM}… +1 completed${RESET}`);
    expect(lines).toHaveLength(6); // count header + in_progress + 3 kept completed + 1 collapsed summary row
  });

  test("testBlockGlyphsBlueGreen: output contains the blue ANSI for ■ and the green ANSI for ✓", () => {
    const tasks = [task("ip", "working", "in_progress"), task("c1", "done", "completed")];
    const out = renderTaskBlock(tasks).join("\n");
    expect(out).toContain(`${BLUE}■`);
    expect(out).toContain(`${GREEN}✓`);
  });

  // T3 review fix wave 1: once upsertTask removes a deleted task (see the describe block above),
  // the count header — computed over renderTaskBlock's own `tasks` argument — must recount
  // correctly with the deleted task simply absent, same as any other list without it.
  test("count header recounts correctly after a deleted task is dropped via upsertTask", () => {
    const t1 = task("1", "write tests", "completed");
    const t2 = task("2", "ship it", "pending");
    const t3 = task("3", "throwaway", "pending");
    let tasks = upsertTask(upsertTask([t1], t2), t3);
    expect(renderTaskBlock(tasks)[0]).toBe(`${DIM}3 tasks (1 done, 0 in progress, 2 open)${RESET}`);
    tasks = upsertTask(tasks, { ...t3, status: "deleted" });
    expect(tasks).toEqual([t1, t2]);
    expect(renderTaskBlock(tasks)[0]).toBe(`${DIM}2 tasks (1 done, 0 in progress, 1 open)${RESET}`);
  });
});

describe("trackLineStart (safe-repaint-point rule)", () => {
  test("a write ending in a newline puts us at a safe fresh-line boundary", () => {
    expect(trackLineStart(false, "hello\n")).toBe(true);
    expect(trackLineStart(true, "hello\n")).toBe(true);
  });

  test("a non-empty write NOT ending in a newline leaves us mid-line (unsafe)", () => {
    expect(trackLineStart(true, "partial delta chunk")).toBe(false);
    expect(trackLineStart(false, "partial delta chunk")).toBe(false);
  });

  test("an empty write changes nothing — no bytes actually reached the terminal", () => {
    expect(trackLineStart(true, "")).toBe(true);
    expect(trackLineStart(false, "")).toBe(false);
  });
});

describe("renderTaskBlock width truncation (final-review fix: erase math needs 1 logical line == 1 physical row)", () => {
  const long = { id: "1", subject: "a".repeat(200), status: "pending" } as Task;

  test("a subject longer than the terminal truncates to columns-2 visible chars with an ellipsis (never wraps)", () => {
    const lines = renderTaskBlock([long], 80);
    expect(lines).toHaveLength(2); // count header + the (truncated) task row
    expect(lines[0]).toBe(`${DIM}${taskCountsLine([long])}${RESET}`);
    const prefix = `${DIM}${taskGlyph("pending")}${RESET}`;
    expect(lines[1]!.startsWith(prefix)).toBe(true);
    const rest = lines[1]!.slice(prefix.length);
    expect(rest.length).toBe(77); // (columns - 2) visible chars total, minus the 1-char glyph
    expect(rest.endsWith("…")).toBe(true);
  });

  test("short subjects pass through untouched at any width", () => {
    const short = { id: "2", subject: "ship it", status: "pending" } as Task;
    expect(renderTaskBlock([short], 80)).toEqual([
      `${DIM}${taskCountsLine([short])}${RESET}`,
      `${DIM}${taskGlyph("pending")}${RESET} ship it`,
    ]);
  });

  test("undefined or tiny columns fall back to no truncation (pre-fix behavior)", () => {
    // index [1]: the task row, NOT [0] (the count header, which is short and never needs
    // truncation at this fixture size regardless of columns).
    expect(renderTaskBlock([long])[1]!.length).toBeGreaterThan(100);
    expect(renderTaskBlock([long], 0)[1]!.length).toBeGreaterThan(100);
    expect(renderTaskBlock([long], 2)[1]!.length).toBeGreaterThan(100);
  });
});

describe("renderStatusLine (live turn status: spinner · elapsed · tokens)", () => {
  test("testStatusLineFormat: contains the spinner frame, activeForm, '14s', '↑', '↓', '10.6k'", () => {
    const line = renderStatusLine({
      activeForm: "Reading files",
      elapsedMs: 14000,
      inTokens: 500,
      outTokens: 10600,
      spinnerFrame: SPINNER_FRAMES[2]!,
    });
    expect(line).toContain(SPINNER_FRAMES[2]!);
    expect(line).toContain("Reading files");
    expect(line).toContain("14s");
    expect(line).toContain("↑");
    expect(line).toContain("↓");
    expect(line).toContain("10.6k");
  });

  test("the whole line is wrapped in BLUE ... RESET", () => {
    const line = renderStatusLine({ activeForm: "Working", elapsedMs: 0, inTokens: 0, outTokens: 0, spinnerFrame: SPINNER_FRAMES[0]! });
    expect(line.startsWith(BLUE)).toBe(true);
    expect(line.endsWith(RESET)).toBe(true);
  });

  test("renders activeForm verbatim (fallback to 'Working' is the caller's job)", () => {
    const line = renderStatusLine({ activeForm: "Working", elapsedMs: 0, inTokens: 0, outTokens: 0, spinnerFrame: SPINNER_FRAMES[0]! });
    expect(line).toContain("Working…");
  });
});

describe("truncateStatusLine (ANSI-safe width truncation for the caller-rendered status line)", () => {
  const full = renderStatusLine({
    activeForm: "Doing a very long thing indeed for sure and then some",
    elapsedMs: 14000,
    inTokens: 500,
    outTokens: 10600,
    spinnerFrame: SPINNER_FRAMES[0]!,
  });

  test("undefined/tiny columns: unchanged", () => {
    expect(truncateStatusLine(full)).toBe(full);
    expect(truncateStatusLine(full, 2)).toBe(full);
  });

  test("line already within budget: unchanged", () => {
    expect(truncateStatusLine(full, 500)).toBe(full);
  });

  test("narrow columns: truncates the visible text but always preserves the leading color and trailing RESET", () => {
    const truncated = truncateStatusLine(full, 30);
    expect(truncated.startsWith(BLUE)).toBe(true);
    expect(truncated.endsWith(RESET)).toBe(true);
    expect(truncated.length).toBeLessThan(full.length);
  });
});

describe("TASK_ICONS (still used for the non-TTY one-line-per-update render)", () => {
  test("maps every status to its glyph", () => {
    expect(TASK_ICONS.pending).toBe("☐");
    expect(TASK_ICONS.in_progress).toBe("◐");
    expect(TASK_ICONS.completed).toBe("☑");
    // T3 review fix wave 1: "deleted" now reaches this non-TTY render too — without an entry the
    // line would print the literal string "undefined" for the glyph.
    expect(TASK_ICONS.deleted).toBe("✗");
  });
});

// renderSubagentBlock (2e-ii) DELETED for 2e-iii-b Task 3 — the agents footer below supersedes it
// as the pinned area's "what's working now" surface (now a thread SELECTOR, not a status list).

describe("renderAgentsFooter (2e-iii-b: thread selector — supersedes renderSubagentBlock)", () => {
  const sub = (over: Partial<CliSubagent> = {}): CliSubagent => ({
    threadId: "th_a", agentType: "general-purpose", label: "explore auth",
    status: "working", activeMs: 60000, activeSince: undefined, toolCalls: 3,
    activity: "Reading main.ts", inputTokens: undefined, outputTokens: 75000, liveOutputChars: 0,
    ...over,
  });
  const mainSelected: FooterSelection = { selectedThreadId: "main", focusIndex: null };

  test("footer hidden when idle and no agents", () => {
    expect(renderAgentsFooter([], mainSelected, false, 0, 80)).toEqual([]);
  });

  test("footer visible (main row only) when a turn is running even with zero subagents", () => {
    expect(renderAgentsFooter([], mainSelected, true, 0, 80)).toEqual([`${BLUE}●${RESET} main`]);
  });

  test("footer visible when a subagent is alive even if turnRunning is false", () => {
    expect(renderAgentsFooter([sub()], mainSelected, false, 0, 80)).toHaveLength(2);
  });

  test("footer rows: selected dot, focus bold, right-aligned time+tokens — byte-exact", () => {
    const lines = renderAgentsFooter([sub()], mainSelected, true, 0, 80);
    expect(lines).toEqual([
      `${BLUE}●${RESET} main`,
      `${DIM}○${RESET} general-purpose  Reading main.ts${" ".repeat(29)}1m 0s · ↓ 75.0k`,
    ]);
  });

  test("selecting the subagent flips the dots: main dim ○, subagent blue ●", () => {
    const lines = renderAgentsFooter([sub()], { selectedThreadId: "th_a", focusIndex: null }, true, 0, 80);
    expect(lines[0]!.startsWith(`${DIM}○${RESET}`)).toBe(true);
    expect(lines[1]!.startsWith(`${BLUE}●${RESET}`)).toBe(true);
  });

  test("focusIndex bolds the whole body of that row only (keyboard cursor, distinct from the selection dot)", () => {
    const lines = renderAgentsFooter([sub()], { selectedThreadId: "main", focusIndex: 0 }, true, 0, 80);
    expect(lines[0]).toBe(`${BLUE}●${RESET}${BOLD} main${RESET}`);
    expect(lines[1]!.startsWith(`${DIM}○${RESET}`)).toBe(true); // not bold, focusIndex points at row 0
    expect(lines[1]).not.toContain(BOLD);
  });

  test("queued row: activity slot shows 'waiting', no time/tokens at all", () => {
    const queued = sub({ threadId: "th_b", status: "queued", activeMs: 0, activity: undefined, outputTokens: 0 });
    const lines = renderAgentsFooter([queued], { selectedThreadId: "th_b", focusIndex: null }, true, 0, 80);
    expect(lines[1]).toBe(`${BLUE}●${RESET} general-purpose  waiting`);
  });

  test("undefined activity on a working row falls back to 'working…'", () => {
    const working = sub({ activity: undefined });
    const lines = renderAgentsFooter([working], mainSelected, true, 0, 80);
    expect(lines[1]!.includes("working…")).toBe(true);
  });

  test("narrow width: drops the right-aligned time+tokens first, keeps the left (never wraps)", () => {
    const lines = renderAgentsFooter([sub()], mainSelected, true, 0, 30);
    expect(lines[1]).toBe(`${DIM}○${RESET} general-purp…ading main.ts`);
    expect(lines[1]!.includes("1m 0s")).toBe(false);
  });

  test("very narrow width: right already dropped, left middle-truncates (ellipsis mid-string, not at the end)", () => {
    const lines = renderAgentsFooter([sub()], mainSelected, true, 0, 15);
    expect(lines[1]).toBe(`${DIM}○${RESET} gener…in.ts`);
  });

  test("main row selected + a second subagent: main dot blue, subagent order preserved", () => {
    const a = sub();
    const b = sub({ threadId: "th_b", agentType: "researcher", activity: "grep foo" });
    const lines = renderAgentsFooter([a, b], mainSelected, true, 0, 80);
    expect(lines).toHaveLength(3);
    expect(lines[1]!.includes("general-purpose")).toBe(true);
    expect(lines[2]!.includes("researcher")).toBe(true);
  });

  test("footer filters out done subagents: [working, done, queued] renders 3 rows (main + working + queued only), done absent", () => {
    const working = sub({ threadId: "th_work", status: "working" });
    const done = sub({ threadId: "th_done", status: "done" });
    const queued = sub({ threadId: "th_queue", status: "queued" });
    const lines = renderAgentsFooter([working, done, queued], mainSelected, true, 0, 80);
    expect(lines).toHaveLength(3); // main + working + queued (done filtered out)
    expect(lines[0]!.includes("main")).toBe(true);
    expect(lines[1]!.includes("general-purpose")).toBe(true); // working row
    expect(lines[2]!.includes("waiting")).toBe(true); // queued row
    // Verify done is not in output
    const output = lines.join("\n");
    expect(output).not.toContain("th_done");
  });

  test("focus indexes stay consistent with filtered rows: focusIndex maps to visible subagents only", () => {
    const working = sub({ threadId: "th_work", status: "working" });
    const done = sub({ threadId: "th_done", status: "done" });
    const queued = sub({ threadId: "th_queue", status: "queued" });
    // Focus on the queued subagent (row index 2: main=0, working=1, queued=2)
    const lines = renderAgentsFooter([working, done, queued], { selectedThreadId: "main", focusIndex: 2 }, true, 0, 80);
    expect(lines).toHaveLength(3);
    expect(lines[2]!.includes(BOLD)).toBe(true); // queued row is focused (index 2)
    expect(lines[1]!.includes(BOLD)).toBe(false); // working row is not focused
  });
});

describe("renderModeBar (2e-iii-b §7: interactive policy bar, two-span ANSI-safe truncation)", () => {
  test("mode bar renders and truncates ANSI-safely", () => {
    expect(renderModeBar("auto", 120)).toBe(`${BLUE}▶▶ auto mode${RESET}${DIM} (shift+tab to cycle) · esc to interrupt${RESET}`);
    expect(renderModeBar("auto", 16)!.endsWith(RESET)).toBe(true);
  });

  test("undefined/tiny columns: unchanged (full two-span string)", () => {
    const full = `${BLUE}▶▶ plan mode${RESET}${DIM} (shift+tab to cycle) · esc to interrupt${RESET}`;
    expect(renderModeBar("plan")).toBe(full);
    expect(renderModeBar("plan", 2)).toBe(full);
  });

  test("narrow width: the DIM tail truncates first, mid-string, keeping the BLUE span intact", () => {
    const bar = renderModeBar("auto", 16);
    expect(bar).toBe(`${BLUE}▶▶ auto mode${RESET}${DIM} …${RESET}`);
  });

  test("extremely narrow width: even the BLUE span truncates, no DIM span emitted at all", () => {
    const bar = renderModeBar("auto", 6);
    expect(bar.startsWith(BLUE)).toBe(true);
    expect(bar).not.toContain(DIM);
    expect(bar.endsWith(RESET)).toBe(true);
  });
});

describe("physicalRows (2e-iii-b §8: wrap-aware resize erase math)", () => {
  test("physicalRows wrap math", () => {
    expect(physicalRows([10, 80, 81], 80)).toBe(1 + 1 + 2);
    expect(physicalRows([0, 5], 80)).toBe(2);
    expect(physicalRows([200], undefined)).toBe(1);
  });

  test("columns 0 behaves like undefined — 1 row per line", () => {
    expect(physicalRows([10, 200, 0], 0)).toBe(3);
  });

  test("exact-fit boundary: len === columns is still exactly 1 row (not 2)", () => {
    expect(physicalRows([80], 80)).toBe(1);
    expect(physicalRows([160], 80)).toBe(2);
  });

  test("empty lengths array is 0 rows", () => {
    expect(physicalRows([], 80)).toBe(0);
  });
});
