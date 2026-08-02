import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { AgentsView } from "../../src/tui/agents-view";
import {
  AGENTS_EMPTY_STATE, AGENTS_KEY_HINT, applyActivityEvent, applySessionList, emptyAgentsState,
  moveSelection, withNotice,
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

  test("a long title is truncated with an ellipsis rather than wrapping the row", () => {
    const s = applySessionList(emptyAgentsState(), [
      { sessionId: "s_long", activity: "background", title: "x".repeat(80) },
    ], T0);
    const frame = render(<AgentsView state={s} nowMs={T0} />).lastFrame() ?? "";
    expect(frame).toContain("…");
    expect(frame).not.toContain("x".repeat(41));
  });
});
