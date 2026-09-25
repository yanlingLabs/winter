// WS-23: the agent SDK's `system/informational` frame and a `hook_stopped` terminal reach the
// session log as `hook_notice` -- the reason a hook blocked a prompt or stopped a turn is visible to
// every client, instead of a user bubble with no reply and no reason.
import { describe, expect, test } from "bun:test";
import type { ProtocolSdkMessage } from "../../src/projector/types";
import { MAIN_THREAD } from "../../src/projector";
import { HOOK_NOTICE_MAX_CHARS } from "../../src/projector/terminal";
import { accept, assistantText, beginTurn, init, makeProjector, result } from "./harness";

const informational = (content: string, extra: Record<string, unknown> = {}): ProtocolSdkMessage =>
  ({ type: "system", subtype: "informational", content, level: "warning", uuid: `u-${content.length}-${String(extra["prevent_continuation"] ?? "")}`, session_id: "s", ...extra }) as unknown as ProtocolSdkMessage;

describe("projector: WS-23 hook notices", () => {
  test("a systemMessage notice is persisted as hook_notice on the main thread", () => {
    const { projector } = makeProjector();
    accept(projector, init());
    beginTurn(projector, "go");
    const out = accept(projector, informational("Using the staging database"));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ type: "hook_notice", threadId: MAIN_THREAD, text: "Using the staging database", level: "warning" });
    expect((out[0] as { stopsTurn?: boolean }).stopsTurn).toBeUndefined();
  });

  test("a blocked prompt: the stop notice is projected once, and the hook_stopped terminal adds no second one and ends the turn as end_turn", () => {
    const { projector } = makeProjector();
    accept(projector, init());
    beginTurn(projector, "paste my key");
    const notice = accept(projector, informational("UserPromptSubmit operation blocked by hook:\nprompt contains a secret", { prevent_continuation: true }));
    expect(notice[0]).toMatchObject({ type: "hook_notice", stopsTurn: true });
    const end = accept(projector, result({ result: "prompt contains a secret", terminal_reason: "hook_stopped" }));
    expect(end.map((e) => e.type)).toEqual(["turn_completed"]);
    expect((end[0] as { stopReason?: string }).stopReason).toBe("end_turn");
  });

  test("a hook_stopped terminal with NO preceding notice projects its own reason as the notice", () => {
    const { projector } = makeProjector();
    accept(projector, init());
    beginTurn(projector, "go");
    accept(projector, assistantText("working"));
    const end = accept(projector, result({ result: "budget review required", terminal_reason: "hook_stopped" }));
    expect(end.map((e) => e.type)).toEqual(["hook_notice", "turn_completed"]);
    expect(end[0]).toMatchObject({ text: "Stopped by a hook: budget review required", stopsTurn: true, level: "warning" });
    expect(end.some((e) => e.type === "agent_error")).toBe(false);
  });

  test("the stop flag is per turn: a later hook_stopped turn still gets its notice", () => {
    const { projector } = makeProjector();
    accept(projector, init());
    beginTurn(projector, "one");
    accept(projector, informational("stop one", { prevent_continuation: true }));
    accept(projector, result({ result: "one", terminal_reason: "hook_stopped" }));
    beginTurn(projector, "two");
    const end = accept(projector, result({ result: "two", terminal_reason: "hook_stopped" }));
    expect(end[0]).toMatchObject({ type: "hook_notice", text: "Stopped by a hook: two" });
  });

  test("an oversized notice is bounded to the schema's max with a visible marker; an empty one projects nothing", () => {
    const { projector } = makeProjector();
    accept(projector, init());
    beginTurn(projector, "go");
    const out = accept(projector, informational("A".repeat(50_000)));
    const text = (out[0] as { text: string }).text;
    expect(text.length).toBe(HOOK_NOTICE_MAX_CHARS);
    expect(text.endsWith("[…truncated]")).toBe(true);
    expect(accept(projector, informational("   "))).toEqual([]);
  });

  test("a replayed notice (same uuid) is appended once", () => {
    const { projector } = makeProjector();
    accept(projector, init());
    beginTurn(projector, "go");
    const frame = informational("once");
    expect(accept(projector, frame)).toHaveLength(1);
    expect(accept(projector, frame)).toHaveLength(0);
  });
});
