/** Bugfix-pass B2 — `<ChoiceMenu>`: the bottom PICKER for choice-shaped command replies (`/model`
 *  with no args, `/output-style` with no args). A NEW component following `<CompletionMenu>`'s
 *  interaction grammar and render conventions (R4: completion-menu.tsx itself is byte-pinned and
 *  untouched) — purely presentational (key handling lives in the App, the single actor while the
 *  picker is open), ≤ maxRows option rows under a one-line dim title, JS truncation to `columns`
 *  (never Yoga wrap — the row count feeds `bottomBarLayout`'s accounting). The pure selection/
 *  navigation model (`initialChoiceSelection`/`moveChoice`/`choiceMenuRows`) is hoisted and
 *  unit-tested directly — the non-TTY harness can't reach real key handling. */

import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import {
  ChoiceMenu, MAX_CHOICE_ROWS, choiceMenuRows, initialChoiceSelection, moveChoice,
  type ChoiceOption,
} from "../../src/tui/choice-menu";

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

const opts = (n: number): ChoiceOption[] =>
  Array.from({ length: n }, (_, i) => ({ value: `v${i}`, label: `opt${i}`, hint: `desc ${i}` }));

describe("pure selection model", () => {
  test("initialChoiceSelection lands on the current option", () => {
    const options: ChoiceOption[] = [
      { value: "a", label: "a" },
      { value: "b", label: "b", current: true },
      { value: "c", label: "c" },
    ];
    expect(initialChoiceSelection(options)).toBe(1);
  });

  test("initialChoiceSelection defaults to 0 when nothing is current (or the list is empty)", () => {
    expect(initialChoiceSelection(opts(3))).toBe(0);
    expect(initialChoiceSelection([])).toBe(0);
  });

  test("moveChoice steps and clamps at both ends", () => {
    expect(moveChoice(0, -1, 3)).toBe(0); // top stays
    expect(moveChoice(0, 1, 3)).toBe(1);
    expect(moveChoice(2, 1, 3)).toBe(2); // bottom stays
    expect(moveChoice(1, -1, 3)).toBe(0);
  });

  test("moveChoice re-bounds a stale out-of-range selection before stepping", () => {
    expect(moveChoice(9, 1, 3)).toBe(2);
    expect(moveChoice(9, -1, 3)).toBe(1);
    expect(moveChoice(0, 1, 0)).toBe(0); // empty list is inert
  });

  test("choiceMenuRows = 1 title row + min(maxRows, count); 0 when empty", () => {
    expect(choiceMenuRows(0)).toBe(0);
    expect(choiceMenuRows(3)).toBe(4);
    expect(choiceMenuRows(20)).toBe(1 + MAX_CHOICE_ROWS);
    expect(choiceMenuRows(20, 3)).toBe(4);
  });
});

describe("ChoiceMenu (render)", () => {
  test("renders the dim title row first, then one row per option with ' — hint'", () => {
    const { lastFrame } = render(
      <ChoiceMenu title="output style" options={[{ value: "default", label: "default", hint: "Standard." }]} selected={0} />,
    );
    const lines = stripAnsi(lastFrame() ?? "").split("\n");
    expect(lines[0]).toContain("output style");
    expect(lines[1]).toContain("default — Standard.");
  });

  test("the current option carries the '*' marker; others an aligned blank", () => {
    const { lastFrame } = render(
      <ChoiceMenu
        title="model"
        options={[{ value: "a", label: "opt-a" }, { value: "b", label: "opt-b", current: true }]}
        selected={0}
      />,
    );
    const lines = stripAnsi(lastFrame() ?? "").split("\n");
    expect(lines[1]).toContain("opt-a");
    expect(lines[1]).not.toContain("*");
    expect(lines[2]).toContain("* opt-b");
  });

  test("empty options renders nothing at all (no stray title row)", () => {
    const { lastFrame } = render(<ChoiceMenu title="model" options={[]} selected={0} />);
    expect(lastFrame() ?? "").toBe("");
  });

  // NOTE: the selected row ALSO gets accent inverse-video (the completion menu's convention) —
  // deliberately unpinned here: ANSI emission is the 30-fail TTY class in this harness (the
  // CompletionMenu suite's own inverse pin is on that list). The `❯` pointer is the plain-text
  // selection signal this harness CAN reach.
  test("the selected row carries the '❯' pointer; the title and other rows do not", () => {
    const { lastFrame } = render(<ChoiceMenu title="t" options={opts(3)} selected={1} />);
    const lines = stripAnsi(lastFrame() ?? "").split("\n");
    expect(lines[0]).not.toContain("❯"); // title
    expect(lines[1]).not.toContain("❯");
    expect(lines[2]).toContain("❯");
    expect(lines[2]).toContain("opt1");
    expect(lines[3]).not.toContain("❯");
  });

  test("at most maxRows option rows render (plus the one title row)", () => {
    const { lastFrame } = render(<ChoiceMenu title="t" options={opts(20)} selected={0} />);
    const lines = (lastFrame() ?? "").split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBe(1 + MAX_CHOICE_ROWS);
    expect(lines.length).toBe(choiceMenuRows(20)); // render and layout accounting agree
  });

  test("the window slides so `selected` stays visible at the end of a long list", () => {
    const { lastFrame } = render(<ChoiceMenu title="t" options={opts(20)} selected={19} />);
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("opt19");
    expect(frame).not.toContain("opt0 "); // scrolled away (trailing space avoids matching opt1x)
  });

  test("a row longer than `columns` is hard-truncated with an ellipsis, never wrapped", () => {
    const { lastFrame } = render(
      <ChoiceMenu
        title="t"
        options={[{ value: "x", label: "some-style", hint: "a very long description that will not fit" }]}
        selected={0}
        columns={24}
      />,
    );
    const lines = stripAnsi(lastFrame() ?? "").split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(2); // title + ONE physical option row
    expect(lines[1]!.length).toBeLessThanOrEqual(24);
    expect(lines[1]).toContain("…");
  });

  test("the title itself is truncated to columns (stays one physical row)", () => {
    const { lastFrame } = render(
      <ChoiceMenu title={"model — a very long effort disclosure that cannot possibly fit"} options={opts(1)} selected={0} columns={20} />,
    );
    const lines = stripAnsi(lastFrame() ?? "").split("\n").filter((l) => l.length > 0);
    expect(lines[0]!.length).toBeLessThanOrEqual(20);
  });
});
