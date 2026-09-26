// WS-23: the agent SDK names four terminal reasons of its own -- `refusal`, `prompt_too_long`,
// `pause_turn_limit` (all `is_error: true`) and `hook_stopped` (`is_error: false`). Each must reach
// the session log VISIBLY with its reason text: an `agent_error` with a distinct code for the three
// errors, a `hook_notice` for the hook stop -- never a bare `turn_completed(end_turn)` that looks like
// a finished answer. The frames below are the exact shapes `packages/runtime/src/engine.ts` writes.
import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "@yanlinglabs/winter-protocol";
import { CLASS_MESSAGE } from "../../src/projector/errors";
import { accept, assistantText, beginTurn, init, makeProjector, result } from "./harness";

function endTurnWith(frame: Record<string, unknown>): SessionEvent[] {
  const { projector } = makeProjector();
  accept(projector, init());
  beginTurn(projector, "go");
  accept(projector, assistantText("partial answer"));
  return accept(projector, result(frame)) as SessionEvent[];
}

const agentErrorOf = (events: SessionEvent[]): { message: string; code?: string } => {
  const e = events.find((x) => x.type === "agent_error");
  if (e === undefined) throw new Error(`no agent_error in ${events.map((x) => x.type).join(",")}`);
  return e as unknown as { message: string; code?: string };
};

const stopReasonOf = (events: SessionEvent[]): string | undefined =>
  (events.find((x) => x.type === "turn_completed") as { stopReason?: string } | undefined)?.stopReason;

describe("projector: the runtime's own terminal reasons are visible (WS-23)", () => {
  test("refusal → agent_error(refusal) carrying the refusal text, then turn_completed(error)", () => {
    const events = endTurnWith({ is_error: true, result: "I can't help with that request.", terminal_reason: "refusal" });
    expect(events.map((e) => e.type)).toEqual(["agent_error", "turn_completed"]);
    const err = agentErrorOf(events);
    expect(err.code).toBe("refusal");
    expect(err.message).toBe(`${CLASS_MESSAGE.refusal}: I can't help with that request.`);
    expect(stopReasonOf(events)).toBe("error");
  });

  test("prompt_too_long WITH the vendor's 400 → context_overflow, never bad_request (the named verdict outranks the status)", () => {
    const events = endTurnWith({
      is_error: true,
      result: "The conversation no longer fits the model's context window: the reactive compaction did not run (x).",
      terminal_reason: "prompt_too_long",
      api_error_status: 400,
    });
    const err = agentErrorOf(events);
    expect(err.code).toBe("context_overflow");
    expect(err.message.startsWith(`${CLASS_MESSAGE.context_overflow}: The conversation no longer fits`)).toBe(true);
    expect(stopReasonOf(events)).toBe("error");
  });

  test("prompt_too_long with a null status (no HTTP exchange named) is the same class", () => {
    const err = agentErrorOf(endTurnWith({ is_error: true, result: "too long", terminal_reason: "prompt_too_long", api_error_status: null }));
    expect(err.code).toBe("context_overflow");
  });

  test("pause_turn_limit → agent_error(pause_turn_limit) carrying the paused turn's text", () => {
    const events = endTurnWith({ is_error: true, result: "Still searching the archive", terminal_reason: "pause_turn_limit" });
    const err = agentErrorOf(events);
    expect(err.code).toBe("pause_turn_limit");
    expect(err.message).toBe(`${CLASS_MESSAGE.pause_turn_limit}: Still searching the archive`);
    expect(stopReasonOf(events)).toBe("error");
  });

  test("hook_stopped → hook_notice with the hook's reason and turn_completed(end_turn) — not an error", () => {
    const events = endTurnWith({ is_error: false, result: "deploy freeze in effect", terminal_reason: "hook_stopped" });
    expect(events.map((e) => e.type)).toEqual(["hook_notice", "turn_completed"]);
    expect(events[0]).toMatchObject({ type: "hook_notice", text: "Stopped by a hook: deploy freeze in effect", stopsTurn: true });
    expect(stopReasonOf(events)).toBe("end_turn");
  });

  test("the refusal text reaches the message through the one bounded door (200 chars + an ellipsis)", () => {
    const err = agentErrorOf(endTurnWith({ is_error: true, result: "R".repeat(500), terminal_reason: "refusal" }));
    expect(err.message).toBe(`${CLASS_MESSAGE.refusal}: ${"R".repeat(200)}…`);
  });

  test("an empty refusal still says what happened, with no dangling separator", () => {
    const err = agentErrorOf(endTurnWith({ is_error: true, result: "", terminal_reason: "refusal" }));
    expect(err).toMatchObject({ code: "refusal", message: CLASS_MESSAGE.refusal });
  });
});
