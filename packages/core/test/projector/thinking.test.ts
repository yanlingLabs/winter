// The thinking pill (2026-10-05): the agent SDK's `system/reasoning_progress` frames (start → delta* →
// end, one `block_id` per reasoning block, every provider family) reach the session as a TRANSIENT
// `thinking_delta` per start/delta and ONE persisted `thinking_block` per block — with the pill's title
// derived by the daemon. Synthetic frames in the pinned shape (agent SDK 0.0.47).
import { describe, expect, test } from "bun:test";
import { THINKING_TEXT_MAX_LENGTH, THINKING_TITLE_MAX_LENGTH, type SessionEvent } from "@yanlinglabs/winter-protocol";
import { MAIN_THREAD, deriveThinkingTitle, summarize } from "../../src/projector";
import { sliceUnits } from "../../src/projector/thinking";
import type { ProtocolSdkMessage } from "../../src/projector/types";
import { accept, acceptError, assistantToolUse, beginTurn, flat, init, makeProjector, result, toolResult } from "./harness";

type Any = Record<string, unknown>;

let uuid = 0;
const rp = (blockId: string, phase: "start" | "delta" | "end", kind: string, over: Record<string, unknown> = {}): ProtocolSdkMessage =>
  ({
    type: "system", subtype: "reasoning_progress", block_id: blockId, phase, kind,
    provider: "openai", model: "gpt-5.6-terra", parent_tool_use_id: null, uuid: `rp-${++uuid}`, session_id: "be-1", ...over,
  }) as unknown as ProtocolSdkMessage;

/** A clock the test moves: `now()` is ISO, like the driver's. */
function clock(start = Date.parse("2026-10-05T10:00:00.000Z")) {
  let t = start;
  return { now: () => new Date(t).toISOString(), advance: (ms: number) => { t += ms; } };
}

const of = (events: SessionEvent[], type: string): Any[] => (events as unknown as Any[]).filter((e) => e.type === type);

describe("deriveThinkingTitle (pure)", () => {
  test("summary: the latest part's leading complete **…** span", () => {
    expect(deriveThinkingTitle("summary", ["**Planning the migration**\n\nI will read the schema."])).toBe("Planning the migration");
    expect(deriveThinkingTitle("summary", ["**Planning**\n\nbody", "**Checking  the tests**\n\nmore"])).toBe("Checking the tests");
    // A heading must close on its own line.
    expect(deriveThinkingTitle("summary", ["**Checking the\ntests**"])).toBeUndefined();
    expect(deriveThinkingTitle("summary", ["  \n**Leading whitespace is fine**"])).toBe("Leading whitespace is fine");
  });

  test("summary: the LAST complete heading at the start of a line anywhere in the part (a part-less Gemini block)", () => {
    const gemini = "**Reading the schema**\n\nIt has three tables.\n\n**Planning the migration**\n\nTwo steps.";
    expect(deriveThinkingTitle("summary", [gemini])).toBe("Planning the migration");
    // A newer heading still missing its closing ** does not count; the one before it still does.
    expect(deriveThinkingTitle("summary", [`${gemini}\n\n**Writing the te`])).toBe("Planning the migration");
    // A bold word mid-line is not a heading, even after a heading.
    expect(deriveThinkingTitle("summary", [`${gemini}\n\nthe **users** table first`])).toBe("Planning the migration");
    expect(deriveThinkingTitle("summary", [`${gemini}\n  **Indented heading**`])).toBe("Indented heading");
  });

  test("summary: a partial opening ** yields nothing yet, nor does a part with no leading heading", () => {
    expect(deriveThinkingTitle("summary", ["**Planning the mig"])).toBeUndefined();
    expect(deriveThinkingTitle("summary", ["**"])).toBeUndefined();
    expect(deriveThinkingTitle("summary", ["Plain prose with a **bold** word later"])).toBeUndefined();
    expect(deriveThinkingTitle("summary", ["****"])).toBeUndefined();
    expect(deriveThinkingTitle("summary", ["**Done**", "**Next"])).toBeUndefined();   // the LATEST part decides
    expect(deriveThinkingTitle("summary", [])).toBeUndefined();
  });

  test("update: the update text itself, trimmed and whitespace-collapsed", () => {
    expect(deriveThinkingTitle("update", ["  Reading the schema\n before   changing it.  "])).toBe("Reading the schema before changing it.");
    expect(deriveThinkingTitle("update", ["   "])).toBeUndefined();
  });

  test("exposed and hidden have no title", () => {
    expect(deriveThinkingTitle("exposed", ["**Looks like a heading**"])).toBeUndefined();
    expect(deriveThinkingTitle("hidden", ["anything"])).toBeUndefined();
  });

  test("a title is capped with an ellipsis", () => {
    const long = "word ".repeat(100);
    const t = deriveThinkingTitle("update", [long])!;
    expect(t.length).toBeLessThanOrEqual(THINKING_TITLE_MAX_LENGTH);
    expect(t.endsWith("…")).toBe(true);
    const bold = deriveThinkingTitle("summary", [`**${"x".repeat(500)}**`])!;
    expect(bold.length).toBe(THINKING_TITLE_MAX_LENGTH);
  });

  test("sliceUnits never leaves half a surrogate pair", () => {
    expect(sliceUnits("ab😀", 3)).toBe("ab");
    expect(sliceUnits("ab😀", 4)).toBe("ab😀");
    expect(sliceUnits("abc", 10)).toBe("abc");
  });
});

describe("projector: system/reasoning_progress → thinking_delta / thinking_block", () => {
  test("start and delta are TRANSIENT (broadcast only); end is the one PERSISTED block", () => {
    const c = clock();
    const { projector } = makeProjector({ now: c.now });
    accept(projector, init());
    beginTurn(projector, "go");

    const start = projector.accept(rp("rb_1", "start", "summary"));
    expect(start.persist).toEqual([]);
    expect(start.broadcast).toHaveLength(1);
    expect(start.broadcast[0]).toMatchObject({ type: "thinking_delta", threadId: MAIN_THREAD, blockId: "rb_1", kind: "summary", phase: "start" });
    expect((start.broadcast[0] as Any).text).toBeUndefined();
    expect((start.broadcast[0] as Any).title).toBeUndefined();

    const delta = projector.accept(rp("rb_1", "delta", "summary", { text: "**Planning**\n\nI will read it.", part: 0 }));
    expect(delta.persist).toEqual([]);
    expect(delta.broadcast[0]).toMatchObject({ type: "thinking_delta", phase: "delta", text: "**Planning**\n\nI will read it.", title: "Planning" });

    c.advance(1500);
    const end = projector.accept(rp("rb_1", "end", "summary"));
    expect(end.broadcast).toEqual([]);
    expect(end.persist).toHaveLength(1);
    expect(end.persist[0]).toMatchObject({
      type: "thinking_block", threadId: MAIN_THREAD, blockId: "rb_1", kind: "summary", title: "Planning",
      text: "**Planning**\n\nI will read it.", provider: "openai", model: "gpt-5.6-terra", durationMs: 1500,
    });
    expect((end.persist[0] as Any).truncated).toBeUndefined();
  });

  test("multi-part summaries: parts join with a blank line, the title follows the LATEST part's heading and is sticky meanwhile", () => {
    const { projector } = makeProjector();
    accept(projector, init());
    beginTurn(projector, "go");
    accept(projector, rp("rb_2", "start", "summary"));
    const d1 = accept(projector, rp("rb_2", "delta", "summary", { text: "**Plan", part: 0 }));
    expect(d1[0]).toMatchObject({ text: "**Plan" });
    expect((d1[0] as Any).title).toBeUndefined();                    // partial heading: no title yet
    const d2 = accept(projector, rp("rb_2", "delta", "summary", { text: "ning**\n\nread the schema", part: 0 }));
    expect(d2[0]).toMatchObject({ text: "ning**\n\nread the schema", title: "Planning" });
    const d3 = accept(projector, rp("rb_2", "delta", "summary", { text: "**Check", part: 1 }));
    expect(d3[0]).toMatchObject({ text: "\n\n**Check" });             // the separator rides the increment
    expect((d3[0] as Any).title).toBe("Planning");                   // the CURRENT title rides every text delta — kept, not cleared
    const d4 = accept(projector, rp("rb_2", "delta", "summary", { text: "ing the tests**", part: 1 }));
    expect(d4[0]).toMatchObject({ text: "ing the tests**", title: "Checking the tests" });
    const block = of(accept(projector, rp("rb_2", "end", "summary")), "thinking_block")[0]!;
    expect(block.text).toBe("**Planning**\n\nread the schema\n\n**Checking the tests**");
    expect(block.title).toBe("Checking the tests");
    // A client that concatenates every increment holds exactly the persisted text.
    expect([d1, d2, d3, d4].map((d) => (d[0] as Any).text).join("")).toBe(block.text as string);
  });

  test("a part-less block (Gemini) whose chunks each open with a heading follows the newest heading", () => {
    const { projector } = makeProjector();
    accept(projector, init());
    accept(projector, rp("rb_g", "start", "summary", { provider: "google", model: "gemini-3-pro" }));
    const d1 = accept(projector, rp("rb_g", "delta", "summary", { text: "**Reading the schema**\n\nThree tables." }));
    expect(d1[0]).toMatchObject({ title: "Reading the schema" });
    const d2 = accept(projector, rp("rb_g", "delta", "summary", { text: "\n\n**Planning the" }));
    expect(d2[0]).toMatchObject({ title: "Reading the schema" });           // partial: the current one rides on
    const d3 = accept(projector, rp("rb_g", "delta", "summary", { text: " migration**\n\nTwo steps." }));
    expect(d3[0]).toMatchObject({ title: "Planning the migration" });
    const block = of(accept(projector, rp("rb_g", "end", "summary")), "thinking_block")[0]!;
    expect(block.title).toBe("Planning the migration");
    expect(block.text).toBe("**Reading the schema**\n\nThree tables.\n\n**Planning the migration**\n\nTwo steps.");
  });

  test("the heading scan stays bounded: a heading far past the window start is still found, one before it is not re-read", () => {
    const { projector } = makeProjector();
    accept(projector, init());
    accept(projector, rp("rb_w", "delta", "summary", { text: "**First**\n\n" }));
    // 10,000 units of body, then a new heading — the window holds the tail only.
    accept(projector, rp("rb_w", "delta", "summary", { text: `${"word ".repeat(2000)}\n` }));
    const d = accept(projector, rp("rb_w", "delta", "summary", { text: "**Second**\n\nmore" }));
    expect(d[0]).toMatchObject({ title: "Second" });
    // A long line that scrolls the window past "**Second**" keeps it (sticky), and a "**" cut in half at
    // the window's edge is never read as a heading.
    const after = accept(projector, rp("rb_w", "delta", "summary", { text: "x".repeat(5000) }));
    expect(after[0]).toMatchObject({ title: "Second" });
  });

  test("a client joining mid-block learns the title from the next text delta", () => {
    const { projector } = makeProjector();
    accept(projector, init());
    accept(projector, rp("rb_j", "start", "summary"));
    accept(projector, rp("rb_j", "delta", "summary", { text: "**Planning**\n\nfirst", part: 0 }));
    // A client attaching NOW saw neither the start nor the title change — the next delta carries it.
    const joined = accept(projector, rp("rb_j", "delta", "summary", { text: " and more", part: 0 }));
    expect(joined[0]).toMatchObject({ phase: "delta", text: " and more", title: "Planning" });
    // A delta with no text and no change stays empty.
    expect(accept(projector, rp("rb_j", "delta", "summary", { text: "", part: 0 }))).toEqual([]);
  });

  test("a late frame after the result projects nothing and does not mark a turn running", () => {
    const { projector } = makeProjector();
    accept(projector, init());
    beginTurn(projector, "go");
    accept(projector, rp("rb_late", "start", "summary"));
    accept(projector, result());                                          // closes rb_late
    expect(projector.turnRunning).toBe(false);
    expect(accept(projector, rp("rb_late", "delta", "summary", { text: "late" }))).toEqual([]);
    expect(accept(projector, rp("rb_late", "end", "summary"))).toEqual([]);
    expect(projector.turnRunning).toBe(false);
    // An `end` never marks a turn running, even one that persists.
    expect(of(accept(projector, rp("rb_orphan", "end", "hidden")), "thinking_block")).toHaveLength(1);
    expect(projector.turnRunning).toBe(false);
  });

  test("agent SDK 0.0.47: a SUBAGENT's end arriving after the parent's result is ignored — no duplicate block, no turn marked running", () => {
    const { projector } = makeProjector();
    accept(projector, init());
    beginTurn(projector, "go");
    accept(projector, rp("rb_kid", "start", "summary", { parent_tool_use_id: "toolu_fg" }));
    accept(projector, rp("rb_kid", "delta", "summary", { text: "**Child**\n\nwork", parent_tool_use_id: "toolu_fg" }));
    const atResult = accept(projector, result());
    expect(of(atResult, "thinking_block").map((e) => e.blockId)).toEqual(["rb_kid"]);   // closed with the turn
    expect(accept(projector, rp("rb_kid", "end", "summary", { parent_tool_use_id: "toolu_fg" }))).toEqual([]);
    expect(projector.turnRunning).toBe(false);
  });

  test("agent SDK 0.0.47: hidden → summary and hidden → exposed promote the block (the last kind wins)", () => {
    const { projector } = makeProjector();
    accept(projector, init());
    accept(projector, rp("rb_s", "start", "hidden", { provider: "anthropic" }));
    accept(projector, rp("rb_s", "delta", "summary", { text: "I should read the schema first." }));
    expect(of(accept(projector, rp("rb_s", "end", "summary")), "thinking_block")[0]).toMatchObject({ kind: "summary", text: "I should read the schema first." });
    accept(projector, rp("rb_e", "start", "hidden"));
    accept(projector, rp("rb_e", "delta", "exposed", { text: "raw" }));
    expect(of(accept(projector, rp("rb_e", "end", "exposed")), "thinking_block")[0]).toMatchObject({ kind: "exposed", text: "raw" });
  });

  test("a part with no heading keeps the last title (the pill never regresses to 'Thinking' mid-block)", () => {
    const { projector } = makeProjector();
    accept(projector, init());
    accept(projector, rp("rb_3", "delta", "summary", { text: "**First**\n\nx", part: 0 }));
    accept(projector, rp("rb_3", "delta", "summary", { text: "no heading here", part: 1 }));
    const block = of(accept(projector, rp("rb_3", "end", "summary")), "thinking_block")[0]!;
    expect(block.title).toBe("First");
  });

  test("hidden → update: the kind changes on the first non-empty text; the update text is the title; the block takes the LAST kind", () => {
    const { projector } = makeProjector();
    accept(projector, init());
    const s = accept(projector, rp("rb_4", "start", "hidden", { provider: "anthropic", model: "claude-opus-5-5" }));
    expect(s[0]).toMatchObject({ kind: "hidden", phase: "start" });
    const d = accept(projector, rp("rb_4", "delta", "update", { text: "Reading the schema\nbefore changing it." }));
    expect(d[0]).toMatchObject({ kind: "update", phase: "delta", title: "Reading the schema before changing it." });
    const block = of(accept(projector, rp("rb_4", "end", "update")), "thinking_block")[0]!;
    expect(block).toMatchObject({ kind: "update", title: "Reading the schema before changing it.", text: "Reading the schema\nbefore changing it.", provider: "anthropic", model: "claude-opus-5-5" });
  });

  test("a kind change with no text still reaches the live pill", () => {
    const { projector } = makeProjector();
    accept(projector, init());
    accept(projector, rp("rb_k", "start", "hidden"));
    const d = accept(projector, rp("rb_k", "delta", "update", { text: "" }));
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ kind: "update", phase: "delta" });
    expect((d[0] as Any).text).toBeUndefined();
    // …and an empty delta that changes nothing produces nothing.
    expect(accept(projector, rp("rb_k", "delta", "update", { text: "" }))).toEqual([]);
  });

  test("exposed reasoning streams its text with no title; a hidden block persists empty text and no title", () => {
    const { projector } = makeProjector();
    accept(projector, init());
    accept(projector, rp("rb_5", "start", "exposed", { provider: "deepseek", model: "deepseek-v4-pro" }));
    const d = accept(projector, rp("rb_5", "delta", "exposed", { text: "**Not a heading** for raw CoT" }));
    expect((d[0] as Any).title).toBeUndefined();
    const exposed = of(accept(projector, rp("rb_5", "end", "exposed")), "thinking_block")[0]!;
    expect(exposed).toMatchObject({ kind: "exposed", text: "**Not a heading** for raw CoT" });
    expect(exposed.title).toBeUndefined();

    accept(projector, rp("rb_6", "start", "hidden"));
    const hidden = of(accept(projector, rp("rb_6", "end", "hidden")), "thinking_block")[0]!;
    expect(hidden).toMatchObject({ kind: "hidden", text: "" });
    expect(hidden.title).toBeUndefined();
  });

  test("a subagent's frames land on the subagent's thread and do not open the session's own turn", () => {
    const { projector } = makeProjector();
    accept(projector, init());
    const d = accept(projector, rp("rb_c", "delta", "summary", { text: "**Child plan**", parent_tool_use_id: "toolu_child" }));
    expect(d[0]).toMatchObject({ type: "thinking_delta", threadId: "toolu_child" });
    expect(projector.turnRunning).toBe(false);
    const block = of(accept(projector, rp("rb_c", "end", "summary", { parent_tool_use_id: "toolu_child" })), "thinking_block")[0]!;
    expect(block).toMatchObject({ threadId: "toolu_child", title: "Child plan" });
    // A main-thread frame does open it (evidence the turn runs).
    accept(projector, rp("rb_m", "start", "hidden"));
    expect(projector.turnRunning).toBe(true);
  });

  test("a delta or end for a block never started opens it implicitly (no duration); a second end is dropped quietly", () => {
    const { projector, warnings } = makeProjector();
    accept(projector, init());
    accept(projector, rp("rb_7", "delta", "update", { text: "Working." }));
    const first = accept(projector, rp("rb_7", "end", "update"));
    expect(of(first, "thinking_block")).toHaveLength(1);
    expect(of(first, "thinking_block")[0]!.durationMs).toBeUndefined();
    expect(accept(projector, rp("rb_7", "end", "update"))).toEqual([]);
    expect(accept(projector, rp("rb_7", "delta", "update", { text: "late" }))).toEqual([]);
    expect(accept(projector, rp("rb_7", "start", "update"))).toEqual([]);
    expect(of(accept(projector, rp("rb_8", "end", "hidden")), "thinking_block")).toHaveLength(1);
    expect(warnings).toEqual([]);
  });

  test("a replayed end (a fresh projector on the same generation) is claimed once", () => {
    const first = makeProjector();
    accept(first.projector, init());
    expect(of(accept(first.projector, rp("rb_r", "end", "hidden")), "thinking_block")).toHaveLength(1);
    first.projector.flush();
    expect(first.checkpoints.completed).toContain("tb:rb_r");
    const again = makeProjector({ checkpoint: first.checkpoints });
    accept(again.projector, init());
    expect(accept(again.projector, rp("rb_r", "end", "hidden"))).toEqual([]);
  });

  test("text is capped (head kept, truncated set); past the cap no text is forwarded, but the title still follows", () => {
    const { projector } = makeProjector();
    accept(projector, init());
    const big = "a".repeat(THINKING_TEXT_MAX_LENGTH - 5);
    accept(projector, rp("rb_t", "delta", "summary", { text: `**One**\n\n${big}`, part: 0 }));
    const capped = accept(projector, rp("rb_t", "delta", "summary", { text: "**Two**\n\nmore", part: 1 }));
    expect(capped[0]).toMatchObject({ title: "Two" });
    expect((capped[0] as Any).text).toBeUndefined();                   // no room left at all
    const block = of(accept(projector, rp("rb_t", "end", "summary")), "thinking_block")[0]!;
    expect((block.text as string).length).toBe(THINKING_TEXT_MAX_LENGTH);
    expect(block.truncated).toBe(true);
    expect(block.title).toBe("Two");
  });

  test("a cut that would split a surrogate pair drops the half, and nothing is appended after the cut", () => {
    const { projector } = makeProjector();
    accept(projector, init());
    accept(projector, rp("rb_s", "delta", "exposed", { text: "a".repeat(THINKING_TEXT_MAX_LENGTH - 1) }));
    const cut = accept(projector, rp("rb_s", "delta", "exposed", { text: "😀tail" }));
    expect(cut).toEqual([]);                                            // nothing fit; truncated
    expect(accept(projector, rp("rb_s", "delta", "exposed", { text: "x" }))).toEqual([]);
    const block = of(accept(projector, rp("rb_s", "end", "exposed")), "thinking_block")[0]!;
    expect((block.text as string).length).toBe(THINKING_TEXT_MAX_LENGTH - 1);
    expect(block.truncated).toBe(true);
    expect(() => JSON.parse(JSON.stringify(block))).not.toThrow();
  });

  test("provider/model are bounded", () => {
    const { projector } = makeProjector();
    accept(projector, init());
    const block = of(accept(projector, rp("rb_b", "end", "hidden", { provider: "p".repeat(1000), model: "" })), "thinking_block")[0]!;
    expect((block.provider as string).length).toBe(256);
    expect(block.model).toBeUndefined();
  });

  test("a malformed frame projects nothing (an unknown kind, an empty block id)", () => {
    const { projector } = makeProjector();
    accept(projector, init());
    expect(accept(projector, rp("rb_x", "start", "musing"))).toEqual([]);
    expect(accept(projector, rp("", "start", "summary"))).toEqual([]);
    expect(accept(projector, { ...(rp("rb_y", "start", "summary") as unknown as Any), phase: "middle" } as unknown as ProtocolSdkMessage)).toEqual([]);
  });
});

describe("projector: a reasoning block left open is closed by the paths that close other dangling state", () => {
  test("the turn's result closes the main thread's open block BEFORE turn_completed, in the same persisted batch", () => {
    const c = clock();
    const { projector } = makeProjector({ now: c.now });
    accept(projector, init());
    beginTurn(projector, "go");
    accept(projector, rp("rb_d", "start", "summary"));
    accept(projector, rp("rb_d", "delta", "summary", { text: "**Half**\n\nwas" }));
    c.advance(300);
    const out = projector.accept(result());
    expect(out.broadcast).toEqual([]);
    expect(out.persist.map((e) => e.type)).toEqual(["thinking_block", "turn_completed"]);
    expect(out.persist[0]).toMatchObject({ blockId: "rb_d", title: "Half", text: "**Half**\n\nwas", durationMs: 300 });
    // Closed once: a late end for it appends nothing.
    expect(accept(projector, rp("rb_d", "end", "summary"))).toEqual([]);
  });

  test("a foreground child's open block closes at the main result; a BACKGROUND child's stays open past it", () => {
    const { projector } = makeProjector();
    accept(projector, init());
    beginTurn(projector, "go");
    accept(projector, assistantToolUse("call_bg", "Agent", { description: "d", prompt: "p", run_in_background: true }));
    accept(projector, toolResult("call_bg", JSON.stringify({ status: "async_launched", agentId: "a1", taskId: "t1" })));
    accept(projector, rp("rb_bg", "start", "summary", { parent_tool_use_id: "call_bg" }));
    accept(projector, rp("rb_fg", "start", "summary", { parent_tool_use_id: "toolu_fg" }));
    const out = accept(projector, result());
    expect(of(out, "thinking_block").map((e) => e.blockId)).toEqual(["rb_fg"]);
    // The background child's block closes later, at its own end…
    expect(of(accept(projector, rp("rb_bg", "end", "summary", { parent_tool_use_id: "call_bg" })), "thinking_block").map((e) => e.threadId)).toEqual(["call_bg"]);
  });

  test("a failed stream closes every open block, a background child's included — with no turn running too", () => {
    const { projector } = makeProjector();
    accept(projector, init());
    beginTurn(projector, "go");
    accept(projector, rp("rb_e1", "start", "update"));
    accept(projector, rp("rb_e2", "start", "summary", { parent_tool_use_id: "call_bg" }));
    const out = acceptError(projector, new Error("socket closed"));
    expect(out.map((e) => e.type)).toEqual(["thinking_block", "thinking_block", "agent_error", "turn_completed"]);

    const idle = makeProjector();
    accept(idle.projector, init());
    accept(idle.projector, rp("rb_e3", "start", "summary", { parent_tool_use_id: "call_bg" }));
    expect(idle.projector.turnRunning).toBe(false);
    const closed = flat(idle.projector.acceptError(new Error("gone")));
    expect(closed.map((e) => e.type)).toEqual(["thinking_block"]);
  });

  test("closeOpenThinking persists what a cleanly ended iteration left open, and is empty otherwise", () => {
    const { projector } = makeProjector();
    accept(projector, init());
    expect(flat(projector.closeOpenThinking())).toEqual([]);
    accept(projector, rp("rb_f", "start", "exposed"));
    accept(projector, rp("rb_f", "delta", "exposed", { text: "partial" }));
    const out = projector.closeOpenThinking();
    expect(out.broadcast).toEqual([]);
    expect(out.persist).toHaveLength(1);
    expect(out.persist[0]).toMatchObject({ type: "thinking_block", blockId: "rb_f", text: "partial" });
    expect(flat(projector.closeOpenThinking())).toEqual([]);
  });
});

describe("projector: reasoning text never reaches a log line", () => {
  test("the frame's log allowlist names the provider alone", () => {
    const frame = rp("rb_l", "delta", "summary", { text: "SECRET REASONING", part: 0 });
    expect(summarize(frame)).toEqual({ kind: "system/reasoning_progress", provider: "openai" });
  });

  test("projecting a whole block logs nothing at all", () => {
    const lines: string[] = [];
    const log = (m: string, fields?: Record<string, unknown>) => { lines.push(`${m} ${JSON.stringify(fields ?? {})}`); };
    const { projector } = makeProjector({ log: { warn: log, debug: log } });
    accept(projector, init());
    beginTurn(projector, "go");
    accept(projector, rp("rb_q", "start", "summary"));
    accept(projector, rp("rb_q", "delta", "summary", { text: "**SECRET TITLE**\n\nSECRET BODY" }));
    accept(projector, rp("rb_q", "end", "summary"));
    accept(projector, rp("rb_q2", "delta", "nonsense", { text: "SECRET MALFORMED" }));   // the logSkipped door
    accept(projector, result());
    projector.acceptError(new Error("x"));
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("\n")).not.toContain("SECRET");
  });
});
