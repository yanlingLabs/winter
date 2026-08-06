/** `<Footer>` — TUI renderer T5: the footer is now a thin renderer over `statusChromeModel`'s
 *  output (state.ts — the pure chrome model carries ALL content decisions; its own matrix lives in
 *  state.test.ts). These tests pin the RENDERED side: wording survives the render, segment order,
 *  the two-row shape when work runs, exit-armed's whole-chrome replacement, and the T4 flicker pin
 *  (identical chrome ⇒ byte-identical frames ⇒ zero diff ops). */
import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { Footer } from "../../src/tui/footer";
import { statusChromeModel, type AgentRow, type StatusChromeInput } from "../../src/tui/state";
import { diffFrames } from "../../src/tui/frame-diff";

function agent(threadId: string): AgentRow {
  return {
    threadId,
    agentType: "general-purpose",
    label: "scout",
    status: "working",
    outputTokens: 0,
    liveOutputChars: 0,
    activeMs: 0,
    toolCalls: 0,
  };
}

const T0 = 1_700_000_000_000;

/** Renders `<Footer>` the way App does: statusChromeModel output straight into the `lines` prop. */
function renderChrome(over: Partial<StatusChromeInput> = {}) {
  const input: StatusChromeInput = {
    policy: "ask",
    running: false,
    agents: [],
    bgTasks: [],
    model: "",
    nowMs: T0,
    ...over,
  };
  return render(<Footer lines={statusChromeModel(input).lines} />);
}

describe("Footer (e, f, g) — status-line wording survives the render", () => {
  test("(e) plan policy shows the plan-mode segment", () => {
    const { lastFrame } = renderChrome({ policy: "plan" });
    expect(lastFrame() ?? "").toContain("⏸ plan mode on (shift+tab to cycle)");
  });

  test("(e) auto policy shows the auto-accept segment", () => {
    const { lastFrame } = renderChrome({ policy: "auto" });
    expect(lastFrame() ?? "").toContain("⏵⏵ auto mode on (shift+tab to cycle)");
  });

  test("(SP-policies T13) dont-ask policy shows the dont-ask segment", () => {
    const { lastFrame } = renderChrome({ policy: "dont-ask" });
    expect(lastFrame() ?? "").toContain("✕ dont-ask — auto-declines prompts (shift+tab to cycle)");
  });

  test("(SP-policies T13) accept-edits policy shows the accept-edits segment", () => {
    const { lastFrame } = renderChrome({ policy: "accept-edits" });
    expect(lastFrame() ?? "").toContain("✎ accept edits (shift+tab to cycle)");
  });

  test("(SP-policies T13) bypass policy shows the danger segment", () => {
    const { lastFrame } = renderChrome({ policy: "bypass" });
    expect(lastFrame() ?? "").toContain("⚠ bypass — all actions auto-approved (shift+tab to cycle)");
  });

  test("(e) ask policy shows no mode segment", () => {
    const frame = renderChrome().lastFrame() ?? "";
    expect(frame).not.toContain("plan mode on");
    expect(frame).not.toContain("auto mode on");
    expect(frame).not.toContain("dont-ask");
    expect(frame).not.toContain("accept edits");
    expect(frame).not.toContain("bypass");
  });

  test("(f) running shows 'esc to interrupt'", () => {
    const { lastFrame } = renderChrome({ running: true });
    expect(lastFrame() ?? "").toContain("esc to interrupt");
  });

  test("(g) 2 agents shows '2 agents · ctrl+a'", () => {
    const { lastFrame } = renderChrome({ agents: [agent("a"), agent("b")] });
    expect(lastFrame() ?? "").toContain("2 agents · ctrl+a");
  });

  test("1 agent is singular: '1 agent · ctrl+a'", () => {
    const { lastFrame } = renderChrome({ agents: [agent("a")] });
    expect(lastFrame() ?? "").toContain("1 agent · ctrl+a");
  });

  test("fallback: no mode/running/agents renders '? for shortcuts · shift+tab to cycle modes' (phase 3d T4)", () => {
    const { lastFrame } = renderChrome();
    expect(lastFrame() ?? "").toContain("? for shortcuts · shift+tab to cycle modes");
  });

  test("no fallback once any keybinding-bearing segment renders", () => {
    const { lastFrame } = renderChrome({ running: true });
    expect(lastFrame() ?? "").not.toContain("shift+tab to cycle modes");
    expect(lastFrame() ?? "").not.toContain("? for shortcuts");
  });

  test("(T5) exitArmed replaces the whole chrome with the exact key-specific dim hint, even mid-work", () => {
    const { lastFrame } = renderChrome({ policy: "plan", running: true, agents: [agent("a")], exitArmed: "ctrl-c" });
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Press Ctrl-C again to exit");
    expect(frame).not.toContain("plan mode on");
    expect(frame).not.toContain("esc to interrupt");
    expect(frame).not.toContain("agent");
    expect(frame).not.toContain("task"); // the work line is replaced too — ONE row total
  });

  test("(T5) exitArmed names the arming key: ctrl-d renders the Ctrl-D hint (3c whole-branch review item 3)", () => {
    const { lastFrame } = renderChrome({ exitArmed: "ctrl-d" });
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Press Ctrl-D again to exit");
    expect(frame).not.toContain("Ctrl-C");
  });

  test("segments render in order (mode, interrupt, agents, model) when all apply", () => {
    // Individual segments are wrapped in their own colored <Text>, so ANSI reset/set codes can sit
    // between them in the raw frame — assert relative ORDER via indexOf rather than one contiguous
    // literal (a literal match would be brittle against those interspersed escape codes).
    const { lastFrame } = renderChrome({ policy: "plan", running: true, agents: [agent("a")], model: "gpt-5.6-luna", effort: "high" });
    const frame = lastFrame() ?? "";
    const modeIdx = frame.indexOf("plan mode on (shift+tab to cycle)");
    const interruptIdx = frame.indexOf("esc to interrupt");
    const agentsIdx = frame.indexOf("1 agent · ctrl+a");
    const modelIdx = frame.indexOf("gpt-5.6-luna (high)");
    expect(modeIdx).toBeGreaterThanOrEqual(0);
    expect(interruptIdx).toBeGreaterThan(modeIdx);
    expect(agentsIdx).toBeGreaterThan(interruptIdx);
    expect(modelIdx).toBeGreaterThan(agentsIdx);
  });
});

describe("Footer — T5 status chrome: model/effort, activity chip, the work line", () => {
  test("model + effort render on the status line", () => {
    const { lastFrame } = renderChrome({ model: "gpt-5.6-luna", effort: "high" });
    expect(lastFrame() ?? "").toContain("gpt-5.6-luna (high)");
  });

  test("the backgrounded chip renders when the session's activity says so", () => {
    const { lastFrame } = renderChrome({ activity: "background" });
    expect(lastFrame() ?? "").toContain("● backgrounded");
    expect(renderChrome({ activity: "active" }).lastFrame() ?? "").not.toContain("●");
  });

  test("running work renders as a SECOND row above the status line — spinner glyph + summary", () => {
    const { lastFrame } = renderChrome({ agents: [agent("a")], model: "gpt-5.6-luna" });
    const frame = lastFrame() ?? "";
    const rows = frame.split("\n");
    expect(rows.length).toBe(2); // the two-line shape — never more (the model caps it)
    expect(rows[0]).toContain("1 running: scout");
    expect(rows[1]).toContain("gpt-5.6-luna");
  });

  test("no work -> exactly ONE rendered row", () => {
    const frame = renderChrome({ model: "gpt-5.6-luna" }).lastFrame() ?? "";
    expect(frame.split("\n").length).toBe(1);
  });
});

describe("Footer — flicker pin (T4 frame-diff): unchanged chrome produces ZERO diff ops", () => {
  test("idle chrome across two clock ticks renders byte-identical frames", () => {
    const at = (nowMs: number) =>
      renderChrome({ policy: "plan", agents: [], model: "gpt-5.6-luna", effort: "high", nowMs }).lastFrame() ?? "";
    const a = at(T0);
    const b = at(T0 + 100);
    expect(b).toBe(a);
    expect(diffFrames(a.split("\n"), b.split("\n"))).toEqual([]);
  });

  test("working chrome within one 120ms spinner bucket is also byte-identical", () => {
    const at = (nowMs: number) => renderChrome({ agents: [agent("a")], model: "m", nowMs }).lastFrame() ?? "";
    const a = at(1_200);
    const b = at(1_260);
    expect(diffFrames(a.split("\n"), b.split("\n"))).toEqual([]);
  });
});
