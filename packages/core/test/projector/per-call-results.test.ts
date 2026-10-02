// Agent SDK 0.0.40: a tool round's results reach the host ONE `user` frame PER CALL, each as its call
// finishes, instead of one frame after the round's last call. The projector folds each frame on its own,
// so every call's `tool_result` event is produced the moment its frame arrives — and it keeps "one
// `tool_result` per call" as its own rule, turn-scoped, against a runtime that repeats a result.
import { afterEach, describe, expect, test } from "bun:test";
import type { SessionEvent } from "@yanlinglabs/winter-protocol";
import { attachFileDiff, clearSession } from "../../src/runtime-sdk/diff-attach";
import type { ProtocolSdkMessage } from "../../src/projector";
import { accept, assistantText, beginTurn, makeProjector, result, toolResult } from "./harness";

afterEach(() => clearSession("s_test"));

/** One assistant frame carrying several calls — a parallel batch, as a model issues it. */
const batch = (...calls: Array<[id: string, name: string, input?: unknown]>): ProtocolSdkMessage => ({
  type: "assistant", message: { content: calls.map(([id, name, input]) => ({ type: "tool_use", id, name, input: input ?? {} })) },
} as unknown as ProtocolSdkMessage);

/** The pre-0.0.40 shape: the whole round's results in one frame. */
const roundFrame = (...results: Array<[id: string, content: string]>): ProtocolSdkMessage => ({
  type: "user", message: { content: results.map(([id, content]) => ({ type: "tool_result", tool_use_id: id, content })) },
} as unknown as ProtocolSdkMessage);

const results = (events: SessionEvent[]) => events.filter((e) => e.type === "tool_result") as Array<SessionEvent & { callId: string; output: string }>;

describe("projector: one frame per finished call (agent SDK 0.0.40)", () => {
  test("each call's frame yields its own tool_result AT ONCE, in completion order, each once", () => {
    const settled: string[][] = [];
    const { projector, checkpoints } = makeProjector({ onToolResults: (ids) => settled.push([...ids]) });
    beginTurn(projector, "go");
    expect(results(accept(projector, batch(["s1", "WebSearch"], ["s2", "WebSearch"], ["f1", "WebFetch"])))).toEqual([]);

    // The searches finish first; each is projected as its frame arrives, before the fetch is done.
    const first = accept(projector, toolResult("s1", "search one"));
    expect(results(first).map((e) => [e.callId, e.output])).toEqual([["s1", "search one"]]);
    const second = accept(projector, toolResult("s2", "search two"));
    expect(results(second).map((e) => [e.callId, e.output])).toEqual([["s2", "search two"]]);
    const third = accept(projector, toolResult("f1", "the page"));
    expect(results(third).map((e) => [e.callId, e.output])).toEqual([["f1", "the page"]]);

    // Each frame claimed its own key and settled its own call (the approval bridge's C2 hook).
    expect(checkpoints.begun.filter((k) => k.startsWith("tr:"))).toEqual(["tr:s1", "tr:s2", "tr:f1"]);
    expect(settled).toEqual([["s1"], ["s2"], ["f1"]]);
    // Strictly increasing seqs: a consumer folding by callId sees three separate completions.
    const seqs = [...first, ...second, ...third].map((e) => e.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
  });

  test("the pre-0.0.40 batched frame still projects every result (an older runtime)", () => {
    const { projector } = makeProjector();
    beginTurn(projector, "go");
    accept(projector, batch(["a", "Read"], ["b", "Read"]));
    expect(results(accept(projector, roundFrame(["a", "A"], ["b", "B"]))).map((e) => e.callId)).toEqual(["a", "b"]);
  });

  test("a frame repeating calls already reported this turn projects only the new ones — under the NEW call's key", () => {
    const { projector, checkpoints, warnings } = makeProjector();
    beginTurn(projector, "go");
    accept(projector, batch(["a", "Read"], ["b", "Read"], ["c", "Read"]));
    accept(projector, toolResult("a", "A"));
    accept(projector, toolResult("b", "B"));

    // A runtime that ALSO sent the round (or repeated itself): `a` and `b` must not be projected twice,
    // and `c` must not be lost — the frame's claim key is `c`'s, never the committed `tr:a`.
    const out = accept(projector, roundFrame(["a", "A"], ["b", "B"], ["c", "C"]));
    expect(results(out).map((e) => [e.callId, e.output])).toEqual([["c", "C"]]);
    expect(checkpoints.begun.filter((k) => k.startsWith("tr:"))).toEqual(["tr:a", "tr:b", "tr:c"]);
    expect(warnings.filter((w) => w.includes("already has one this turn"))).toHaveLength(1);

    // A frame that repeats ONLY reported calls projects nothing and claims nothing.
    expect(accept(projector, toolResult("a", "A"))).toEqual([]);
    expect(checkpoints.begun.filter((k) => k.startsWith("tr:"))).toEqual(["tr:a", "tr:b", "tr:c"]);
    expect(warnings.filter((w) => w.includes("already has one this turn"))).toHaveLength(1); // logged once
  });

  test("the guard is TURN-scoped: a later turn may report the same call id again", () => {
    const { projector } = makeProjector();
    beginTurn(projector, "one");
    accept(projector, batch(["x", "Read"]));
    expect(results(accept(projector, toolResult("x", "first")))).toHaveLength(1);
    accept(projector, assistantText("done"));
    accept(projector, result());

    beginTurn(projector, "two");
    // The guard was cleared at the terminal, so the repeat is projected. (The frame leads with a new call:
    // a frame whose FIRST id repeats a committed one is the checkpoint layer's business within one
    // generation.)
    expect(results(accept(projector, roundFrame(["y", "new"], ["x", "second"]))).map((e) => e.output)).toEqual(["new", "second"]);
  });

  test("the hooks lane's fileDiff and the runtime's site icons ride the per-call event", () => {
    const { projector } = makeProjector();
    beginTurn(projector, "go");
    accept(projector, batch(["w1", "Write", { file_path: "/tmp/x/a.txt", content: "A" }], ["f1", "WebFetch"]));
    // The PostToolUse producer runs inside the call's own iteration, before the runtime sends its frame.
    attachFileDiff("s_test", "w1", { path: "/tmp/x/a.txt", added: 1, removed: 0, diffId: "d_1" });
    const write = results(accept(projector, toolResult("w1", "wrote it")));
    expect(write).toHaveLength(1);
    expect(write[0]).toMatchObject({ callId: "w1", fileDiff: { path: "/tmp/x/a.txt", added: 1, removed: 0, diffId: "d_1" } });
    const fetch = results(accept(projector, toolResult("f1", "page", {
      winter_site_icons: [{ url: "https://docs.example.com/page", icon_url: "https://docs.example.com/icon.png" }],
    })));
    expect(fetch[0]).toMatchObject({ callId: "f1", siteIcons: [{ url: "https://docs.example.com/page", iconUrl: "https://docs.example.com/icon.png" }] });
    expect((fetch[0] as { fileDiff?: unknown }).fileDiff).toBeUndefined();
  });

  test("a spawn call's own frame closes its child thread while the round's other call is still running", () => {
    const { projector } = makeProjector();
    beginTurn(projector, "go");
    const opened = accept(projector, batch(["sp", "Agent", { description: "d", prompt: "p", subagent_type: "general-purpose" }], ["sl", "Bash", { command: "sleep 5" }]));
    expect(opened.map((e) => e.type)).toEqual(["tool_call", "tool_call", "thread_started"]);
    const spawnDone = accept(projector, toolResult("sp", "the child's answer"));
    expect(spawnDone.map((e) => e.type)).toEqual(["tool_result", "thread_completed"]);
    expect(spawnDone[1]).toMatchObject({ threadId: "sp" });
    expect(accept(projector, toolResult("sl", "slept")).map((e) => e.type)).toEqual(["tool_result"]);
  });

  test("a subagent's per-call frames land on its own thread", () => {
    const { projector } = makeProjector();
    beginTurn(projector, "go");
    accept(projector, batch(["sp", "Agent", { description: "d", prompt: "p", subagent_type: "general-purpose" }]));
    accept(projector, { type: "assistant", message: { content: [{ type: "tool_use", id: "c1", name: "Read", input: {} }, { type: "tool_use", id: "c2", name: "Read", input: {} }] }, parent_tool_use_id: "sp" } as unknown as ProtocolSdkMessage);
    const r1 = results(accept(projector, toolResult("c1", "one", {}, "sp")));
    const r2 = results(accept(projector, toolResult("c2", "two", {}, "sp")));
    expect([...r1, ...r2].map((e) => [e.callId, (e as { threadId: string }).threadId])).toEqual([["c1", "sp"], ["c2", "sp"]]);
  });
});
