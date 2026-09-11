import { describe, expect, test } from "bun:test";
import { HISTORY_EVENT_TYPES } from "../../src/sessions/history";
import { PROJECTED_EVENT_COVERAGE, SUBAGENT_TRANSCRIPT_INCLUDE } from "../../src/projector";

/**
 * The relocation's guard (C-5 / ruling P8b-9). The `satisfies Record<SessionEvent["type"], boolean>`
 * clause is the compile-time half and cannot be tested at runtime — it either builds or it does
 * not. What CAN be pinned here is that the move did not change the transcript's behaviour, that the
 * two maps cover the same variants, and that the three rows whose values must never flip have not.
 */
describe("projector/event-coverage: the relocated exhaustiveness maps", () => {
  test("both maps cover exactly the same variant set — one union, two answers", () => {
    expect(Object.keys(PROJECTED_EVENT_COVERAGE).sort()).toEqual(Object.keys(SUBAGENT_TRANSCRIPT_INCLUDE).sort());
  });

  test("the transcript map is a pure relocation: reasoning_item and every transient stay OUT", () => {
    // The security rule that outranks CC parity: `reasoning_item.itemJson` is opaque provider state
    // whose only sink is the session JSONL; a model-greppable transcript file would be a second one.
    expect(SUBAGENT_TRANSCRIPT_INCLUDE.reasoning_item).toBe(false);
    expect(SUBAGENT_TRANSCRIPT_INCLUDE.assistant_delta).toBe(false);
    expect(SUBAGENT_TRANSCRIPT_INCLUDE.lease_granted).toBe(false);
    expect(SUBAGENT_TRANSCRIPT_INCLUDE.lease_lost).toBe(false);
    expect(SUBAGENT_TRANSCRIPT_INCLUDE.peripheral_call_requested).toBe(false);
    // and the conversation flow a child produces stays IN
    expect(SUBAGENT_TRANSCRIPT_INCLUDE.tool_call).toBe(true);
    expect(SUBAGENT_TRANSCRIPT_INCLUDE.tool_result).toBe(true);
    expect(SUBAGENT_TRANSCRIPT_INCLUDE.thread_started).toBe(true);
  });

  test("the projector may NEVER produce a reasoning_item — the row that must never flip", () => {
    expect(PROJECTED_EVENT_COVERAGE.reasoning_item).toBe(false);
  });

  test("the two maps genuinely disagree — which is why they are two maps and not one", () => {
    // If these three ever agree, someone has collapsed the maps and one of the two meanings is
    // now a lie. `assistant_delta`: excluded from a model-greppable file, produced by the projector.
    // `child_update` / `tool_review`: written into a child's transcript, produced by
    // `agent/dispatch-children.ts` and `BashReviewer` — never by the projector.
    expect(PROJECTED_EVENT_COVERAGE.assistant_delta).not.toBe(SUBAGENT_TRANSCRIPT_INCLUDE.assistant_delta);
    expect(PROJECTED_EVENT_COVERAGE.child_update).not.toBe(SUBAGENT_TRANSCRIPT_INCLUDE.child_update);
    expect(PROJECTED_EVENT_COVERAGE.tool_review).not.toBe(SUBAGENT_TRANSCRIPT_INCLUDE.tool_review);
  });

  test("every HISTORY_EVENT_TYPE the phone folds has a projector producer — nothing silently drops off the phone", () => {
    // If a history type were `false` here with no other producer, the Winter leg would show the
    // phone a hole in the transcript with every unit test green.
    for (const type of HISTORY_EVENT_TYPES) {
      expect({ type, produced: PROJECTED_EVENT_COVERAGE[type] }).toEqual({ type, produced: true });
    }
  });

  test("turn_started is false HERE and is Task 16's obligation, not a dropped event", () => {
    // The projector cannot observe a push, so the host appends `turn_started` beside the
    // `user_message` it already appends (P8b-5). Recorded as a test so the obligation cannot be
    // read as "the Mac stopped needing it".
    expect(PROJECTED_EVENT_COVERAGE.turn_started).toBe(false);
    expect(SUBAGENT_TRANSCRIPT_INCLUDE.turn_started).toBe(true);
  });

  test("every panel_*, workflow_*, bg_task_* and plugin/peripheral transient stays off the projector", () => {
    for (const type of [
      "panel_tab_opened", "panel_tab_closed", "panel_tab_activated", "panel_tab_navigated", "panel_command",
      "workflow_started", "workflow_progress", "workflow_completed", "workflow_failed",
      "bg_task_started", "bg_task_output", "bg_task_exited",
      "lease_granted", "lease_lost", "peripheral_call_requested", "plugin_tool_invoke",
      "hardware_requested", "plugin_tile_updated", "session_activity",
    ] as const) {
      expect({ type, produced: PROJECTED_EVENT_COVERAGE[type] }).toEqual({ type, produced: false });
    }
  });
});
