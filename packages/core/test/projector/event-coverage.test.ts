import { describe, expect, test } from "bun:test";
import { HISTORY_EVENT_TYPES } from "../../src/sessions/history";
import { PROJECTED_EVENT_COVERAGE, SUBAGENT_TRANSCRIPT_INCLUDE } from "../../src/projector";
import { accept, assistantText, init, makeProjector, result } from "./harness";

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

  test("every HISTORY_EVENT_TYPE the phone folds has a NAMED producer on the Winter leg", () => {
    // The obligation is that nothing the phone's transcript folds silently loses its producer when
    // the engine retires — NOT that the projector produces all ten. Four of them belong to Task 8's
    // bridges by construction (they must be emitted from inside `canUseTool`, before any frame
    // about the call reaches the stream) and one to the host's push path. A history type that is
    // `false` here AND absent from this table is the failure this test exists to catch.
    const NON_PROJECTOR_PRODUCERS: Partial<Record<string, string>> = {
      user_message: "the host's push path (P8b-5) — ipc/server.ts's session.send / the Winter prompt queue",
      approval_requested: "runtime-sdk/approval-bridge.ts (Task 8), plus daemon.ts:143-213 for peripheral leases",
      approval_resolved: "runtime-sdk/approval-bridge.ts (Task 8), plus daemon.ts:143-213",
      question_asked: "runtime-sdk/question-bridge.ts (Task 8)",
      question_resolved: "runtime-sdk/question-bridge.ts (Task 8)",
    };
    for (const type of HISTORY_EVENT_TYPES) {
      const accounted = PROJECTED_EVENT_COVERAGE[type] === true || NON_PROJECTOR_PRODUCERS[type] !== undefined;
      expect({ type, accounted }).toEqual({ type, accounted: true });
    }
  });

  test("the four approval/question variants are the BRIDGES', not the projector's", () => {
    // Ordering decides ownership: both asks are answered inside `canUseTool`, a callback that runs
    // before any frame about the call reaches the message stream, and only the bridge holds the
    // answer. Flipping any of these to `true` means two producers for one event.
    expect(PROJECTED_EVENT_COVERAGE.approval_requested).toBe(false);
    expect(PROJECTED_EVENT_COVERAGE.approval_resolved).toBe(false);
    expect(PROJECTED_EVENT_COVERAGE.question_asked).toBe(false);
    expect(PROJECTED_EVENT_COVERAGE.question_resolved).toBe(false);
  });

  test("children and the task graph are the projector's", () => {
    expect(PROJECTED_EVENT_COVERAGE.thread_started).toBe(true);
    expect(PROJECTED_EVENT_COVERAGE.thread_completed).toBe(true);
    expect(PROJECTED_EVENT_COVERAGE.task_updated).toBe(true);
  });

  test("turn_started IS produced — by `beginTurn`, which is why the host must never synthesize one", () => {
    // This row said `false` for a review cycle while `beginTurn` produced exactly this event. Two
    // producers would write two rows per turn into the session JSONL — and since the transcript map
    // includes `turn_started`, into every child's model-greppable transcript as well.
    expect(PROJECTED_EVENT_COVERAGE.turn_started).toBe(true);
    expect(SUBAGENT_TRANSCRIPT_INCLUDE.turn_started).toBe(true);
  });

  test("`produce` means ANY door — a turn yields exactly ONE persisted turn_started", () => {
    const { projector } = makeProjector();
    const opened = projector.beginTurn({ text: "say hello" });
    expect(opened.persist.map((e) => e.type)).toEqual(["turn_started"]);
    expect(opened.broadcast).toEqual([]);
    // and no frame path emits a second one
    const rest = [
      accept(projector, init()), accept(projector, assistantText("hi")), accept(projector, result()),
    ].flat();
    expect(rest.filter((e) => e.type === "turn_started")).toEqual([]);
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
