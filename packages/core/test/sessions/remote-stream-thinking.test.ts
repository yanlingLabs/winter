// The thinking pill on the phone's live stream (review r1, MEDIUM): the daemon puts the CURRENT title
// on every text-carrying `thinking_delta`, and the phone's view strips the text — so without a
// per-client dedupe, a long raw-reasoning block reached the phone as one identical title-only frame
// per delta. `createRemoteStreamFilter` forwards a block's `start`, the first title this client sees,
// each change of title, and the persisted block; nothing else.
import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "@yanlinglabs/winter-protocol";
import { ThinkingBlocks, type ReasoningProgressFrame } from "../../src/projector/thinking";
import { createRemoteStreamFilter, filterRemoteStreamEvent } from "../../src/sessions/remote-stream";

const frame = (phase: "start" | "delta" | "end", text?: string, blockId = "rb_1"): ReasoningProgressFrame =>
  ({ type: "system", subtype: "reasoning_progress", block_id: blockId, phase, kind: "exposed", provider: "deepseek", model: "deepseek-v4-pro", parent_tool_use_id: null, ...(text === undefined ? {} : { text }) });

let seq = 0;
const stamp = (events: unknown[]): SessionEvent[] => events.map((e) => ({ ...(e as object), seq: ++seq, ts: "2026-10-05T10:00:00.000Z" }) as unknown as SessionEvent);

/** A raw-reasoning block of `n` deltas whose title changes once (sentence 1, then sentence 2). */
function longBlock(n: number, blockId = "rb_1"): SessionEvent[] {
  const blocks = new ThinkingBlocks("s_phone", () => 0);
  const out: SessionEvent[] = stamp(blocks.start(frame("start", undefined, blockId)));
  const first = "Let me read all the files.\n";
  const second = "Let me run the test suite now.\n";
  const filler = "The value is fine. ";
  for (let i = 0; i < n; i++) {
    const text = i === 0 ? first : i === n / 2 ? second : filler;
    out.push(...stamp(blocks.delta(frame("delta", text, blockId))));
  }
  out.push(...stamp(blocks.end(frame("end", undefined, blockId))));
  return out;
}

describe("the remote stream's thinking-pill dedupe", () => {
  test("a 1,000-delta exposed block with one title change reaches the phone as at most 3 live frames plus its block", () => {
    const events = longBlock(1000);
    // The daemon itself emits a title on every one of them…
    expect(events.filter((e) => e.type === "thinking_delta" && (e as { title?: string }).title !== undefined).length).toBeGreaterThanOrEqual(999);
    const filter = createRemoteStreamFilter();
    const sent = events.map(filter).filter((e): e is SessionEvent => e !== null);
    const live = sent.filter((e) => e.type === "thinking_delta");
    expect(live.length).toBeLessThanOrEqual(3);
    expect(live.map((e) => (e as { phase: string; title?: string }).title)).toEqual([undefined, "Reading all the files", "Running the test suite"]);
    expect(sent.filter((e) => e.type === "thinking_block")).toHaveLength(1);
    // …and never the text.
    for (const e of sent) expect((e as { text?: string }).text ?? "").toBe("");
  });

  test("a client attaching mid-block gets the current title on the next delta", () => {
    const events = longBlock(100);
    const midway = events.findIndex((e) => e.type === "thinking_delta" && (e as { title?: string }).title === "Running the test suite") + 5;
    const joiner = createRemoteStreamFilter();
    const sent = events.slice(midway).map(joiner).filter((e): e is SessionEvent => e !== null);
    expect(sent[0]).toMatchObject({ type: "thinking_delta", phase: "delta", title: "Running the test suite" });
    expect(sent.filter((e) => e.type === "thinking_delta")).toHaveLength(1);
  });

  test("each client dedupes on its own; a block's end forgets it; a block id reused after a start is fresh", () => {
    const a = createRemoteStreamFilter();
    const b = createRemoteStreamFilter();
    const events = longBlock(10, "rb_x");
    expect(events.map(a).filter((e) => e !== null).length).toBe(events.map(b).filter((e) => e !== null).length);
    const again = longBlock(10, "rb_x");
    expect(again.map(a).filter((e) => e?.type === "thinking_delta").length).toBe(3);
  });

  test("the stateless policy still drops a title-less delta and every unrelated event passes unchanged", () => {
    const blocks = new ThinkingBlocks("s_phone", () => 0);
    const [delta] = stamp(blocks.delta(frame("delta", "no activity here, just raw thoughts")));
    expect(filterRemoteStreamEvent(delta!)).toBeNull();
    const msg = { type: "assistant_delta", seq: 1, sessionId: "s", ts: "2026-10-05T10:00:00.000Z", threadId: "main", text: "hi" } as unknown as SessionEvent;
    expect(createRemoteStreamFilter()(msg)).toBe(msg);
  });

  test("the per-client map stays bounded when blocks never end", () => {
    const filter = createRemoteStreamFilter();
    for (let i = 0; i < 500; i++) {
      for (const e of longBlock(2, `rb_${i}`).filter((x) => x.type !== "thinking_block")) filter(e);
    }
    // A block forgotten by the bound simply re-sends its title once — never a flood.
    const out = longBlock(4, "rb_0").map(filter).filter((e) => e?.type === "thinking_delta");
    expect(out.length).toBeLessThanOrEqual(3);
  });
});
