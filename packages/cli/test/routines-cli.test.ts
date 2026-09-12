import { describe, expect, test } from "bun:test";
import { formatRoutineDetail, formatRoutineLine, routinePromptHead, type RoutineLike } from "../src/routines-cli";

// Phase 5 routines T4 — pure formatting helpers shared by `winter routines` (main.ts) and
// `/routines` (tui/commands.ts). These are the ONLY unit-testable surface of the CLI/in-chat
// routines feature (main.ts's argv switch itself is verified by self-review + the gate suite,
// same precedent as every other subcommand there — see main.test.ts's header comment).

function routine(overrides: Partial<RoutineLike> = {}): RoutineLike {
  return {
    id: "r_abc123",
    spec: "every 30m",
    enabled: true,
    nextRunAt: Date.UTC(2026, 6, 13, 0, 0, 0), // 2026-07-13T00:00:00.000Z
    prompt: "check the inbox",
    ...overrides,
  };
}

describe("routinePromptHead", () => {
  test("short prompt round-trips unchanged, no ellipsis", () => {
    expect(routinePromptHead("check the inbox")).toBe("check the inbox");
  });

  test("leading/trailing whitespace on the first line is trimmed", () => {
    expect(routinePromptHead("  check the inbox  \nsecond line")).toBe("check the inbox");
  });

  test("only the FIRST line is considered — later lines never leak in", () => {
    expect(routinePromptHead("first line\nsecond line that is totally different")).toBe("first line");
  });

  test("a first line over 60 chars is truncated to 59 chars + an ellipsis marker", () => {
    const long = "a".repeat(80);
    const head = routinePromptHead(long);
    expect(head).toBe(`${"a".repeat(59)}…`);
    expect(head.length).toBe(60); // 59 chars + 1 ellipsis glyph
  });

  test("exactly 60 chars is NOT truncated (boundary — no ellipsis)", () => {
    const exact = "b".repeat(60);
    expect(routinePromptHead(exact)).toBe(exact);
  });

  test("61 chars IS truncated", () => {
    const over = "b".repeat(61);
    expect(routinePromptHead(over)).toBe(`${"b".repeat(59)}…`);
  });

  test("empty prompt -> empty string", () => {
    expect(routinePromptHead("")).toBe("");
  });
});

describe("formatRoutineDetail", () => {
  test("enabled routine: marker, spec, ISO next-run, prompt head, in that order", () => {
    const detail = formatRoutineDetail(routine());
    expect(detail).toBe("enabled · every 30m · next 2026-07-13T00:00:00.000Z — check the inbox");
  });

  test("disabled routine uses the disabled marker", () => {
    const detail = formatRoutineDetail(routine({ enabled: false }));
    expect(detail).toContain("disabled ·");
    expect(detail).not.toContain("enabled ·");
  });

  test("cron spec passes through verbatim", () => {
    const detail = formatRoutineDetail(routine({ spec: "0 9 * * 1-5" }));
    expect(detail).toContain("0 9 * * 1-5");
  });

  test("long prompt is truncated via routinePromptHead", () => {
    const detail = formatRoutineDetail(routine({ prompt: "x".repeat(90) }));
    expect(detail).toContain(`${"x".repeat(59)}…`);
    expect(detail).not.toContain("x".repeat(90));
  });
});

describe("formatRoutineLine", () => {
  test("id, two spaces, then formatRoutineDetail's exact content", () => {
    const r = routine();
    expect(formatRoutineLine(r)).toBe(`r_abc123  ${formatRoutineDetail(r)}`);
  });

  test("never emits ANSI escapes — plain text for /routines' no-color note convention", () => {
    const line = formatRoutineLine(routine());
    expect(line).not.toContain("\x1b[");
  });

  test("distinct routines produce distinct lines (id differentiates otherwise-identical routines)", () => {
    const a = formatRoutineLine(routine({ id: "r_1" }));
    const b = formatRoutineLine(routine({ id: "r_2" }));
    expect(a).not.toBe(b);
  });
});
