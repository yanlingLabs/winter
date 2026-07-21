import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { Footer } from "../../src/tui/footer";
import type { AgentRow } from "../../src/tui/state";

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

describe("Footer (e, f, g)", () => {
  test("(e) plan policy shows the plan-mode segment", () => {
    const { lastFrame } = render(<Footer policy="plan" running={false} agents={[]} />);
    expect(lastFrame() ?? "").toContain("⏸ plan mode on (shift+tab to cycle)");
  });

  test("(e) auto policy shows the auto-accept segment", () => {
    const { lastFrame } = render(<Footer policy="auto" running={false} agents={[]} />);
    expect(lastFrame() ?? "").toContain("⏵⏵ auto mode on (shift+tab to cycle)");
  });

  test("(SP-policies T13) dont-ask policy shows the dont-ask segment", () => {
    const { lastFrame } = render(<Footer policy="dont-ask" running={false} agents={[]} />);
    expect(lastFrame() ?? "").toContain("✕ dont-ask — auto-declines prompts (shift+tab to cycle)");
  });

  test("(SP-policies T13) accept-edits policy shows the accept-edits segment", () => {
    const { lastFrame } = render(<Footer policy="accept-edits" running={false} agents={[]} />);
    expect(lastFrame() ?? "").toContain("✎ accept edits (shift+tab to cycle)");
  });

  test("(SP-policies T13) bypass policy shows the danger segment", () => {
    const { lastFrame } = render(<Footer policy="bypass" running={false} agents={[]} />);
    expect(lastFrame() ?? "").toContain("⚠ bypass — all actions auto-approved (shift+tab to cycle)");
  });

  test("(e) ask policy shows no mode segment", () => {
    const { lastFrame } = render(<Footer policy="ask" running={false} agents={[]} />);
    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("plan mode on");
    expect(frame).not.toContain("auto mode on");
    expect(frame).not.toContain("dont-ask");
    expect(frame).not.toContain("accept edits");
    expect(frame).not.toContain("bypass");
  });

  test("(f) running shows 'esc to interrupt'", () => {
    const { lastFrame } = render(<Footer policy="ask" running agents={[]} />);
    expect(lastFrame() ?? "").toContain("esc to interrupt");
  });

  test("(g) 2 agents shows '2 agents · ctrl+a'", () => {
    const { lastFrame } = render(
      <Footer policy="ask" running={false} agents={[agent("a"), agent("b")]} />,
    );
    expect(lastFrame() ?? "").toContain("2 agents · ctrl+a");
  });

  test("1 agent is singular: '1 agent · ctrl+a'", () => {
    const { lastFrame } = render(<Footer policy="ask" running={false} agents={[agent("a")]} />);
    expect(lastFrame() ?? "").toContain("1 agent · ctrl+a");
  });

  test("fallback: no mode/running/agents renders EXACTLY '? for shortcuts · shift+tab to cycle modes' (phase 3d T4)", () => {
    const { lastFrame } = render(<Footer policy="ask" running={false} agents={[]} />);
    expect(lastFrame() ?? "").toContain("? for shortcuts · shift+tab to cycle modes");
  });

  test("no fallback once any other segment renders", () => {
    const { lastFrame } = render(<Footer policy="ask" running agents={[]} />);
    expect(lastFrame() ?? "").not.toContain("shift+tab to cycle modes");
    expect(lastFrame() ?? "").not.toContain("? for shortcuts");
  });

  test("(T5) exitArmed replaces the whole line with the exact key-specific dim hint, even when other segments would apply", () => {
    const { lastFrame } = render(
      <Footer policy="plan" running agents={[agent("a")]} exitArmed="ctrl-c" />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Press Ctrl-C again to exit");
    expect(frame).not.toContain("plan mode on");
    expect(frame).not.toContain("esc to interrupt");
    expect(frame).not.toContain("agent");
  });

  test("(T5) exitArmed names the arming key: ctrl-d renders the Ctrl-D hint (3c whole-branch review item 3)", () => {
    const { lastFrame } = render(<Footer policy="ask" running={false} agents={[]} exitArmed="ctrl-d" />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Press Ctrl-D again to exit");
    expect(frame).not.toContain("Ctrl-C");
  });

  test("segments render in order (mode, interrupt, agents) when all three apply", () => {
    // Individual segments are wrapped in their own colored <Text>, so ANSI reset/set codes can sit
    // between them in the raw frame — assert relative ORDER via indexOf rather than one contiguous
    // literal (a literal match would be brittle against those interspersed escape codes).
    const { lastFrame } = render(<Footer policy="plan" running agents={[agent("a")]} />);
    const frame = lastFrame() ?? "";
    const modeIdx = frame.indexOf("plan mode on (shift+tab to cycle)");
    const interruptIdx = frame.indexOf("esc to interrupt");
    const agentsIdx = frame.indexOf("1 agent · ctrl+a");
    expect(modeIdx).toBeGreaterThanOrEqual(0);
    expect(interruptIdx).toBeGreaterThan(modeIdx);
    expect(agentsIdx).toBeGreaterThan(interruptIdx);
  });
});
