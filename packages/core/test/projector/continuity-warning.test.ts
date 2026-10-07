// WS-23 review r1 I-3: the agent SDK's `system/continuity_warning` frame reaches the session log as
// `continuity_warning` -- what a model switch could not carry across, a summary before a switch to a
// smaller model, reasoning state that could not be saved -- instead of one debug log line the user
// never sees.
import { describe, expect, test } from "bun:test";
import type { ProtocolSdkMessage } from "../../src/projector/types";
import { MAIN_THREAD } from "../../src/projector";
import { CONTINUITY_WARNING_MAX_CHARS } from "../../src/projector/terminal";
import { accept, beginTurn, init, makeProjector } from "./harness";

const warning = (kind: string, detail: string, extra: Record<string, unknown> = {}): ProtocolSdkMessage =>
  ({ type: "system", subtype: "continuity_warning", warning: kind, detail, uuid: `cw-${kind}-${detail.length}`, session_id: "s", ...extra }) as unknown as ProtocolSdkMessage;

describe("projector: WS-23 continuity warnings are shown", () => {
  for (const kind of ["reasoning_state_unsaved", "model_switch_lossy", "switch_compaction", "cross_domain_replay_dropped", "child_provider_refused"]) {
    test(`${kind} is persisted as continuity_warning on the main thread`, () => {
      const { projector } = makeProjector();
      accept(projector, init());
      beginTurn(projector, "go");
      const out = accept(projector, warning(kind, "switching from a to b: 2 images cannot be read."));
      expect(out).toHaveLength(1);
      expect(out[0]).toMatchObject({ type: "continuity_warning", threadId: MAIN_THREAD, warning: kind, text: "switching from a to b: 2 images cannot be read." });
    });
  }

  test("a replayed frame (same uuid) is appended once", () => {
    const { projector } = makeProjector();
    accept(projector, init());
    const frame = warning("switch_compaction", "summarizing");
    expect(accept(projector, frame)).toHaveLength(1);
    expect(accept(projector, frame)).toEqual([]);
  });

  test("an over-long detail is bounded; an empty one shows nothing", () => {
    const { projector } = makeProjector();
    accept(projector, init());
    const out = accept(projector, warning("model_switch_lossy", "x".repeat(10_000)));
    expect((out[0] as { text: string }).text.length).toBe(CONTINUITY_WARNING_MAX_CHARS);
    expect(accept(projector, warning("model_switch_lossy", "   "))).toEqual([]);
  });

  test("review r2: the resume-time kinds stay log-only -- two incarnations of a session with a missing origin show nothing", () => {
    for (const kind of ["provider_state_missing", "provider_state_deleted", "sidecar_unreadable"]) {
      for (let generation = 1; generation <= 2; generation++) {
        const { projector } = makeProjector();
        accept(projector, init());
        // The runtime re-emits it on every resume, each time with a fresh uuid.
        expect(accept(projector, warning(kind, "1 anchor has no recorded origin", { uuid: `resume-${generation}` }))).toEqual([]);
      }
    }
  });
});

// 2026-10-07: a compaction is something Winter did to the conversation. The runtime's `compact_boundary`
// (and its `status` failure pair) used to be dropped, so a `/compact` or an auto-compaction left no trace
// the user could see.
describe("projector: compactions are shown as continuity warnings", () => {
  const boundary = (meta: Record<string, unknown>, uuid = "cb-1"): ProtocolSdkMessage =>
    ({ type: "system", subtype: "compact_boundary", compact_metadata: meta, uuid, session_id: "s" }) as unknown as ProtocolSdkMessage;

  test("a manual compaction that kept messages says so, with the size it started from", () => {
    const { projector } = makeProjector();
    accept(projector, init());
    beginTurn(projector, "/compact");
    const out = accept(projector, boundary({ trigger: "manual", pre_tokens: 329_439, duration_ms: 5_000, preserved_messages: { anchor_uuid: "a", uuids: ["1", "2", "3"] } }));
    expect(out).toEqual([
      expect.objectContaining({
        type: "continuity_warning", threadId: MAIN_THREAD, warning: "compacted",
        text: "Conversation compacted on request (it was about 329,439 tokens): the older part is now a summary, and the last 3 messages carry over as they are.",
      }),
    ]);
  });

  test("an auto compaction that kept nothing, with no measured size, states no number", () => {
    const { projector } = makeProjector();
    accept(projector, init());
    const out = accept(projector, boundary({ trigger: "auto", pre_tokens: 0 }));
    expect((out[0] as { text: string }).text).toBe("Conversation compacted: everything before this point is now a summary.");
  });

  test("one kept message reads in the singular; a replayed boundary (same uuid) is appended once", () => {
    const { projector } = makeProjector();
    accept(projector, init());
    const frame = boundary({ trigger: "auto", pre_tokens: 1200, preserved_messages: { anchor_uuid: "a", uuids: ["1"] } }, "cb-once");
    const out = accept(projector, frame);
    expect((out[0] as { text: string }).text).toBe("Conversation compacted (it was about 1,200 tokens): the older part is now a summary, and the last message carries over as it is.");
    expect(accept(projector, frame)).toEqual([]);
  });

  test("a failed compaction says the conversation continues as it was, with the runtime's reason scrubbed", () => {
    const { projector } = makeProjector();
    accept(projector, init());
    const out = accept(projector, ({ type: "system", subtype: "status", status: null, compact_result: "failed", compact_error: "there is nothing to compact: the whole conversation (2 message(s)) already fits", uuid: "cf-1", session_id: "s" }) as unknown as ProtocolSdkMessage);
    expect(out).toEqual([
      expect.objectContaining({ type: "continuity_warning", warning: "compaction_failed", text: "Compaction failed; the conversation continues as it was: there is nothing to compact: the whole conversation (2 message(s)) already fits" }),
    ]);
    const secret = accept(projector, ({ type: "system", subtype: "status", status: null, compact_result: "failed", compact_error: "provider said Bearer abcdefghijklmnopqrstuvwxyz0123456789 was bad", uuid: "cf-2", session_id: "s" }) as unknown as ProtocolSdkMessage);
    expect((secret[0] as { text: string }).text).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
  });

  test("a plain status frame (no failure) still projects nothing", () => {
    const { projector } = makeProjector();
    accept(projector, init());
    expect(accept(projector, ({ type: "system", subtype: "status", status: "compacting", uuid: "st", session_id: "s" }) as unknown as ProtocolSdkMessage)).toEqual([]);
  });
});
