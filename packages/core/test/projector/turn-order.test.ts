import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "@yanlinglabs/winter-protocol";
import { accept, acceptError, assistantText, assistantToolUse, beginTurn, flat, init, makeProjector, result, toolResult, userTextFrame } from "./harness";

/**
 * 2026-09-22 (C2): TURN BOUNDARIES IN ORDER.
 *
 * On the Winter leg a push made while a turn is running is queued by the child as its OWN later turn
 * (agent SDK 0.0.17 `engine.ts`: a `user` frame goes to `userFrames`, which the turn loop drains one
 * envelope at a time) — P8b-38 measured it: two pushes, two `result`s. So the steered-in turn STARTS
 * when the running one ends, and that is where its `turn_started` belongs. Announcing it at push time
 * put it BEFORE the running turn's own `turn_completed` (s_5d314c81045e seq 24-30), which every client
 * folds as "the new turn ended" — the Mac's spinner then went idle while the steer's turn ran.
 */
const kinds = (events: SessionEvent[]) => events.map((e) => (e.type === "turn_completed" ? `turn_completed:${(e as { stopReason: string }).stopReason}` : e.type));

describe("projector: a push made while a turn runs is announced when that turn ends (C2)", () => {
  test("the s_5d314c81045e shape: the aborted turn's turn_completed precedes the steered turn's turn_started", () => {
    const { projector } = makeProjector();
    accept(projector, init());
    const log: SessionEvent[] = [];
    log.push(...beginTurn(projector, "fetch it"));
    log.push(...accept(projector, assistantToolUse("call_1", "Bash", { command: "curl x", dangerouslyDisableSandbox: true })));
    // the user steers while the approval is pending: nothing is announced yet
    const steered = beginTurn(projector, "sooo");
    expect(steered).toEqual([]);
    log.push(...steered);
    // the interrupt: the child pads the abandoned call and ends the turn
    log.push(...accept(projector, toolResult("call_1", "[interrupted]", { interrupted: true })));
    log.push(...accept(projector, result({ interrupted: true })));
    log.push(...accept(projector, assistantText("ok")));
    log.push(...accept(projector, result()));
    expect(kinds(log)).toEqual([
      "turn_started", "tool_call", "tool_result", "turn_completed:aborted",
      "turn_started", "assistant_message", "turn_completed:end_turn",
    ]);
  });

  test("two pushes queued behind one running turn are announced one per terminal, in push order", () => {
    const { projector } = makeProjector();
    accept(projector, init());
    const log: SessionEvent[] = [];
    log.push(...beginTurn(projector, "A"));
    log.push(...beginTurn(projector, "S1"));
    log.push(...beginTurn(projector, "S2"));
    log.push(...accept(projector, result()));
    log.push(...accept(projector, result()));
    log.push(...accept(projector, result()));
    expect(kinds(log)).toEqual([
      "turn_started", "turn_completed:end_turn", "turn_started", "turn_completed:end_turn", "turn_started", "turn_completed:end_turn",
    ]);
  });

  test("announceQueuedTurns announces a held turn_started NOW, and the terminal does not announce it twice", () => {
    // The driver calls this before appending any user_message while a push is still unannounced, so a
    // `turn_started` is never separated from its own message by a younger one (the adjacency pairing
    // `unconsumedUserMessages` rests on). Ordering then degrades to today's for that one push.
    const { projector } = makeProjector();
    accept(projector, init());
    const log: SessionEvent[] = [];
    log.push(...beginTurn(projector, "A"));
    expect(beginTurn(projector, "S")).toEqual([]);
    const announced = flat(projector.announceQueuedTurns());
    expect(kinds(announced)).toEqual(["turn_started"]);
    log.push(...announced);
    expect(flat(projector.announceQueuedTurns())).toEqual([]);   // idempotent
    log.push(...accept(projector, result()));
    log.push(...accept(projector, result()));
    expect(kinds(log)).toEqual(["turn_started", "turn_started", "turn_completed:end_turn", "turn_completed:end_turn"]);
  });

  test("with nothing running a push announces its turn at once, exactly as before", () => {
    const { projector } = makeProjector();
    accept(projector, init());
    expect(kinds(beginTurn(projector, "A"))).toEqual(["turn_started"]);
    accept(projector, result());
    expect(kinds(beginTurn(projector, "B"))).toEqual(["turn_started"]);
  });

  test("the steered turn's own terminal is still projected even when it emits no frame (M1 holds)", () => {
    const { projector } = makeProjector();
    accept(projector, init());
    beginTurn(projector, "A");
    beginTurn(projector, "S");
    expect(kinds(accept(projector, result({ interrupted: true })))).toEqual(["turn_completed:aborted", "turn_started"]);
    expect(kinds(accept(projector, result()))).toEqual(["turn_completed:end_turn"]);
  });

  test("a stream that dies drops the unannounced pushes — their texts stay owed by the log, and nothing is announced for a turn that never ran", () => {
    const { projector } = makeProjector();
    accept(projector, init());
    beginTurn(projector, "A");
    beginTurn(projector, "S");
    const out = acceptError(projector, Object.assign(new Error("boom"), { name: "ProcessError" }));
    expect(out.map((e) => e.type)).not.toContain("turn_started");
    expect(flat(projector.announceQueuedTurns())).toEqual([]);
  });

  test("the OFFICIAL leg is untouched: claude folds a mid-turn message into the running turn, so its turn_started stays at push time", () => {
    const { projector } = makeProjector({ runtimeKind: "claude-agent" });
    accept(projector, init());
    beginTurn(projector, "A");
    expect(kinds(beginTurn(projector, "S"))).toEqual(["turn_started"]);
  });
});

describe("projector: the child's tool_result settles whatever still waits on a human for that call (C2)", () => {
  test("onToolResults is told every call id in the frame BEFORE the tool_result is stamped", () => {
    const order: string[] = [];
    let seq = 0;
    const { projector } = makeProjector({
      nextSeq: () => { order.push("stamp"); return ++seq; },
      onToolResults: (ids) => { order.push(`settle:${ids.join(",")}`); },
    });
    accept(projector, init());
    beginTurn(projector, "go");
    accept(projector, assistantToolUse("call_1", "Bash", { command: "x" }));
    order.length = 0;
    const out = accept(projector, toolResult("call_1", "[interrupted]", { interrupted: true }));
    expect(out.map((e) => e.type)).toEqual(["tool_result"]);
    expect(order).toEqual(["settle:call_1", "stamp"]);
  });

  test("a hook that throws never breaks the fold", () => {
    const { projector } = makeProjector({ onToolResults: () => { throw new Error("driver bug"); } });
    accept(projector, init());
    beginTurn(projector, "go");
    accept(projector, assistantToolUse("call_1", "Bash", { command: "x" }));
    expect(accept(projector, toolResult("call_1", "done")).map((e) => e.type)).toEqual(["tool_result"]);
  });
});

/**
 * Agent SDK 0.0.44 (user ruling 2026-10-04: "lets fold the message into the running turn"). A push made
 * while a turn runs is folded into THAT turn at its next tool round, and the child says so with
 * `system/host_input_folded` (`count` = its N earliest pending pushes) before the next model request.
 * The folded pushes never get a `result`: the running turn's ONE terminal closes them.
 */
const folded = (count: number, extra: Record<string, unknown> = {}) =>
  ({ type: "system", subtype: "host_input_folded", count, uuid: `u-${count}`, session_id: "be-1", ...extra }) as never;

describe("projector: a push FOLDED into the running turn (agent SDK 0.0.44)", () => {
  test("the folded push's held turn_started is announced at the fold, and the running turn's ONE terminal closes both", () => {
    const { projector } = makeProjector();
    accept(projector, init());
    const log: SessionEvent[] = [];
    log.push(...beginTurn(projector, "A"));
    log.push(...accept(projector, assistantToolUse("call_1", "Bash", { command: "ls" })));
    expect(beginTurn(projector, "steer me")).toEqual([]);
    log.push(...accept(projector, toolResult("call_1", "ok")));
    const atFold = accept(projector, folded(1));
    expect(kinds(atFold)).toEqual(["turn_started"]);
    log.push(...atFold);
    log.push(...accept(projector, assistantText("done, and steered")));
    log.push(...accept(projector, result()));
    expect(kinds(log)).toEqual([
      "turn_started", "tool_call", "tool_result", "turn_started", "assistant_message", "turn_completed:end_turn",
    ]);
    // nothing is owed any more: the next push announces at once (no phantom open turn)
    expect(projector.turnRunning).toBe(false);
    expect(kinds(beginTurn(projector, "B"))).toEqual(["turn_started"]);
  });

  test("a fold of two shifts two from the head; a third push still pending at the terminal is the next turn", () => {
    const { projector } = makeProjector();
    accept(projector, init());
    beginTurn(projector, "A");
    beginTurn(projector, "S1");
    beginTurn(projector, "S2");
    expect(kinds(accept(projector, folded(2)))).toEqual(["turn_started", "turn_started"]);
    beginTurn(projector, "S3");
    expect(kinds(accept(projector, result()))).toEqual(["turn_completed:end_turn", "turn_started"]);
    expect(kinds(accept(projector, result()))).toEqual(["turn_completed:end_turn"]);
    expect(projector.turnRunning).toBe(false);
  });

  test("a push already announced early (announceQueuedTurns) is not announced again by the fold", () => {
    const { projector } = makeProjector();
    accept(projector, init());
    beginTurn(projector, "A");
    beginTurn(projector, "S1");
    expect(kinds(flat(projector.announceQueuedTurns()))).toEqual(["turn_started"]);
    beginTurn(projector, "S2");
    expect(kinds(accept(projector, folded(2)))).toEqual(["turn_started"]);   // S2's only
    expect(kinds(accept(projector, result()))).toEqual(["turn_completed:end_turn"]);
  });

  test("a fold counting more than is pending is clamped (a replay, or a push never begun) — nothing invented", () => {
    const { projector, warnings } = makeProjector();
    accept(projector, init());
    beginTurn(projector, "A");
    expect(accept(projector, folded(3))).toEqual([]);
    expect(warnings.some((w) => w.includes("host_input_folded"))).toBe(true);
    // the running turn is still owed its terminal
    expect(kinds(accept(projector, result()))).toEqual(["turn_completed:end_turn"]);
  });

  test("a SUBAGENT's forwarded fold frame is not the session's — ignored", () => {
    const { projector } = makeProjector();
    accept(projector, init());
    beginTurn(projector, "A");
    beginTurn(projector, "S");
    expect(accept(projector, folded(1, { parent_tool_use_id: "toolu_child" }))).toEqual([]);
    expect(kinds(accept(projector, result()))).toEqual(["turn_completed:end_turn", "turn_started"]);
  });

  test("a folded text NEVER suppresses a later user_message — on the main thread or a subagent's — that merely contains it (the contract has no fold echo)", () => {
    const { projector } = makeProjector();
    accept(projector, init());
    beginTurn(projector, "A");
    beginTurn(projector, "run the tests");
    accept(projector, folded(1));
    expect(kinds(accept(projector, userTextFrame("run the tests in packages/core")))).toEqual(["user_message"]);
    const sub = { ...(userTextFrame("ok, run the tests") as Record<string, unknown>), parent_tool_use_id: "toolu_sub" } as never;
    expect(kinds(accept(projector, sub))).toEqual(["user_message"]);
  });

  test("clearQueued (TaskStop) drops pending pushes from the TAIL: the unannounced get their turn_started now, and none is owed a terminal", () => {
    const { projector } = makeProjector();
    accept(projector, init());
    beginTurn(projector, "A");
    beginTurn(projector, "S1");
    flat(projector.announceQueuedTurns());          // S1 announced early
    beginTurn(projector, "S2");
    const { batch, cleared } = projector.clearQueued(2);
    expect(cleared).toBe(2);
    expect(kinds(flat(batch))).toEqual(["turn_started"]);   // S2's; S1's is already out
    // the stopped turn's terminal announces nothing after it
    expect(kinds(accept(projector, result({ interrupted: true })))).toEqual(["turn_completed:aborted"]);
    expect(projector.turnRunning).toBe(false);
  });

  test("clearQueued after the head already started (the running turn ended while the clear was in flight) leaves the head's terminal owed", () => {
    const { projector } = makeProjector();
    accept(projector, init());
    beginTurn(projector, "A");
    beginTurn(projector, "S1");
    beginTurn(projector, "S2");
    expect(kinds(accept(projector, result()))).toEqual(["turn_completed:end_turn", "turn_started"]);   // S1 started
    const { cleared } = projector.clearQueued(1);                                                       // S2 dropped
    expect(cleared).toBe(1);
    expect(kinds(accept(projector, result({ interrupted: true })))).toEqual(["turn_completed:aborted"]);
    expect(projector.turnRunning).toBe(false);
  });
});
