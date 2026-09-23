// Lane B (2026-09-23): the ONE wording both policy cyclers (the Ink app and main.ts's raw cycler)
// print for a `session.setPolicy` result's `replaced`/`warning` — one line each, none otherwise.
import { describe, expect, test } from "bun:test";
import { policySwitchNotes } from "../../src/tui/policy-switch-notes";

describe("policySwitchNotes", () => {
  test("replaced now / at-idle → one line naming the mode and when it lands", () => {
    expect(policySwitchNotes("bypass", { ok: true, replaced: "now" })).toEqual([
      "bypass mode is in force — the session's runtime restarted to apply it",
    ]);
    expect(policySwitchNotes("plan", { ok: true, replaced: "at-idle" })).toEqual([
      "plan mode applies when the running turn ends — the session's runtime restarts then",
    ]);
  });

  test("a warning → its own line, after the replaced line", () => {
    expect(policySwitchNotes("ask", { ok: true, replaced: "at-idle", warning: "still bypassing" })).toEqual([
      "ask mode applies when the running turn ends — the session's runtime restarts then",
      "warning: still bypassing",
    ]);
  });

  test("an ordinary switch, or anything malformed → nothing", () => {
    expect(policySwitchNotes("ask", { ok: true })).toEqual([]);
    expect(policySwitchNotes("ask", undefined)).toEqual([]);
    expect(policySwitchNotes("ask", {})).toEqual([]);
    expect(policySwitchNotes("ask", { replaced: "later", warning: 3 })).toEqual([]);
    expect(policySwitchNotes("ask", { warning: "" })).toEqual([]);
  });
});
