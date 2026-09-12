import { describe, expect, test } from "bun:test";
import { TRANSIENT_EVENT_TYPES } from "@winter/protocol";
import { ProjectorRefusedError, createEchoWindow } from "../../src/projector";
import {
  FakeCheckpoints, accept, assistantText, assistantToolUse, init, makeProjector, result, run, textDelta, toolResult, userTextFrame,
} from "./harness";

/** P8b-14's literal list: replaying a prefix duplicates no `tool_call`/`tool_result`/approval/
 *  terminal. Transients are not on that list and cannot be — they are never persisted, so a backend
 *  transcript replay contains none of them and there is nothing for a second pass to duplicate. */
const persisted = (events: { type: string }[]) => events.filter((e) => !TRANSIENT_EVENT_TYPES.has(e.type as never));

const STREAM = [
  init(),
  assistantToolUse("toolu_01", "Read", { file_path: "note.txt" }),
  toolResult("toolu_01", "contents"),
  textDelta("summing up"),
  assistantText("summing up"),
  result({ result: "summing up" }),
];

describe("projector: idempotency (P8b-14)", () => {
  test("replaying the SAME prefix through a second projector on the same checkpoints yields nothing persisted", () => {
    const checkpoints = new FakeCheckpoints();
    const first = makeProjector({ checkpoint: checkpoints });
    const firstOut = run(first.projector, STREAM);
    expect(persisted(firstOut).map((e) => e.type)).toEqual(["tool_call", "tool_result", "assistant_message", "turn_completed"]);

    // A fresh projector over the SAME checkpoint store is what a recovery re-read looks like.
    const second = makeProjector({ checkpoint: checkpoints });
    const secondOut = run(second.projector, STREAM);
    expect(persisted(secondOut)).toEqual([]);
  });

  test("a PARTIAL replay resumes: the already-projected prefix yields nothing, the new tail projects once", () => {
    const checkpoints = new FakeCheckpoints();
    const first = makeProjector({ checkpoint: checkpoints });
    run(first.projector, STREAM.slice(0, 3));

    const second = makeProjector({ checkpoint: checkpoints });
    const out = persisted(run(second.projector, STREAM));
    expect(out.map((e) => e.type)).toEqual(["assistant_message", "turn_completed"]);
  });

  test("every claimed source is committed once the caller has had its chance to append", () => {
    const checkpoints = new FakeCheckpoints();
    const { projector } = makeProjector({ checkpoint: checkpoints });
    run(projector, STREAM);
    expect(checkpoints.begun).toEqual(["tu:toolu_01", "tr:toolu_01", "as:0:3", "rs:be-1:0"]);
    expect(checkpoints.completed).toEqual(checkpoints.begun);
    expect([...checkpoints.marks.values()].every((s) => s === "committed")).toBe(true);
  });

  test("a stream_event is NOT checkpointed — transients are outside the idempotency contract", () => {
    const checkpoints = new FakeCheckpoints();
    const { projector } = makeProjector({ checkpoint: checkpoints });
    run(projector, [init(), textDelta("a"), textDelta("b")]);
    expect(checkpoints.begun).toEqual([]);
  });

  test("flush() commits the last mark; without it the mark stays pending for 8a's recovery sweep", () => {
    const checkpoints = new FakeCheckpoints();
    const { projector } = makeProjector({ checkpoint: checkpoints });
    accept(projector, init());
    accept(projector, assistantText("hi"));
    expect(checkpoints.completed).toEqual([]);      // not yet — the caller may still be appending
    projector.flush();
    expect(checkpoints.completed).toEqual(["as:0:1"]);
  });

  test("a `pending-elsewhere` verdict THROWS a typed refusal — never a silent empty array", () => {
    // An empty array is indistinguishable from "this message produced nothing", which is how a
    // mis-wire stays invisible in the one component whose job is not to lose events. Only 8a's
    // recovery sweep can read the product log's tail and decide, so the projector refuses loudly.
    const checkpoints = new FakeCheckpoints();
    // Someone else claimed this exact source and never committed it.
    checkpoints.begin({ winterSessionId: "s_test", generation: 1, sourceId: "tu:toolu_01" });
    const { projector, warnings } = makeProjector({ checkpoint: checkpoints });
    accept(projector, init());
    let thrown: unknown;
    try { accept(projector, assistantToolUse("toolu_01", "Read", {})); } catch (err) { thrown = err; }
    expect((thrown as ProjectorRefusedError | undefined)?.name).toBe("ProjectorRefusedError");
    expect((thrown as ProjectorRefusedError).code).toBe("projector_refused");
    expect((thrown as ProjectorRefusedError).sourceId).toBe("tu:toolu_01");
    expect(projector.refusals.map((r) => r.reason)).toEqual(["pending-elsewhere"]);
    expect(warnings.join(" ")).toContain("pending elsewhere");
  });

  test("a message that produces NO persisted event claims no checkpoint row (m9)", () => {
    // A row for a source that can never appear in the product log sends recovery hunting for an
    // append that was never going to happen.
    const checkpoints = new FakeCheckpoints();
    const { projector } = makeProjector({ checkpoint: checkpoints });
    accept(projector, init());
    expect(accept(projector, { type: "assistant", message: { content: [] } } as never)).toEqual([]);
    expect(accept(projector, textDelta("only a transient"))).toHaveLength(1);
    expect(checkpoints.begun).toEqual([]);
  });

  test("a different GENERATION is a different key — a resumed session re-projects, it does not skip", () => {
    const checkpoints = new FakeCheckpoints();
    run(makeProjector({ checkpoint: checkpoints }).projector, STREAM);
    const resumed = makeProjector({ checkpoint: checkpoints, generation: 2 });
    expect(persisted(run(resumed.projector, STREAM)).map((e) => e.type))
      .toEqual(["tool_call", "tool_result", "assistant_message", "turn_completed"]);
  });

  test("a checkpoint commit that THROWS does not abort the stream — the mark is left for recovery", () => {
    const checkpoints = new FakeCheckpoints();
    const throwing = Object.assign(Object.create(Object.getPrototypeOf(checkpoints)), checkpoints, {
      complete(): never { throw new Error("db is locked"); },
    });
    const { projector, warnings } = makeProjector({ checkpoint: throwing });
    const out = persisted(run(projector, STREAM));
    expect(out.map((e) => e.type)).toEqual(["tool_call", "tool_result", "assistant_message", "turn_completed"]);
    expect(warnings.join(" ")).toContain("checkpoint commit failed");
  });

  test("turn source ids stay distinct across turns even when a replayed turn projects nothing", () => {
    const checkpoints = new FakeCheckpoints();
    const two = [init(), assistantText("one"), result(), assistantText("two"), result()];
    run(makeProjector({ checkpoint: checkpoints }).projector, two);
    expect(checkpoints.begun).toEqual(["as:0:1", "rs:be-1:0", "as:1:1", "rs:be-1:1"]);
    const replay = makeProjector({ checkpoint: checkpoints });
    expect(persisted(run(replay.projector, two))).toEqual([]);
  });
});

describe("projector: the P8b-5 echo dedupe, and the measurement that made it a no-op", () => {
  test("MEASURED 2026-09-11 against dist/winter @ v0.0.3: the child does NOT echo host-pushed user frames", () => {
    // Two user turns were pushed through an AsyncIterable<string> prompt with
    // includePartialMessages:true, against both winter-test/echo and winter-test/tooluse. The
    // recorded type sequences were:
    //   echo:     system/init  assistant  result  assistant  result
    //   tooluse:  system/init  assistant  system/permission_denied  user(tool_result)
    //             assistant  result  result
    // Zero `user` frames attributable to either push; the only `user` frame anywhere is the
    // tool-result carrier. This test is that measurement, pinned: a stream shaped like the measured
    // one produces exactly one user-visible turn per push and no `user_message` from the projector.
    const { projector } = makeProjector();
    const out = run(projector, [init(), assistantText("reply one"), result(), assistantText("reply two"), result()]);
    expect(out.filter((e) => e.type === "user_message")).toEqual([]);
    expect(out.map((e) => e.type)).toEqual(["assistant_message", "turn_completed", "assistant_message", "turn_completed"]);
  });

  test("the window still WORKS, so a future echo would be dropped rather than double-appended", () => {
    const w = createEchoWindow();
    w.pushed("hello");
    expect(w.shouldDropEcho("hello")).toBe(true);
    expect(w.shouldDropEcho("hello")).toBe(false); // consumed once: a genuine repeat must survive
    expect(w.shouldDropEcho("never pushed")).toBe(false);
  });

  test("the window is bounded — an old push cannot swallow a much later identical message", () => {
    const w = createEchoWindow(2);
    w.pushed("a");
    w.pushed("b");
    w.pushed("c");
    expect(w.size).toBe(2);
    expect(w.shouldDropEcho("a")).toBe(false);
    expect(w.shouldDropEcho("c")).toBe(true);
  });

  test("a text-only user frame the host never pushed IS projected — an inbound delivery is not an echo", () => {
    const { projector } = makeProjector();
    const out = accept(projector, userTextFrame("<agent-message from=\"planner\">status?</agent-message>"));
    expect(out.map((e) => e.type)).toEqual(["user_message"]);
  });
});
