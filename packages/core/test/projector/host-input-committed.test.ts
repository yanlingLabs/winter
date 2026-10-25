// #92 4.5: the guest runtime's `system/host_input_committed` is shown on the Cowork conversation as a continuity_warning.
import { describe, expect, test } from "bun:test";
import type { ProtocolSdkMessage } from "../../src/projector/types";
import { MAIN_THREAD } from "../../src/projector";
import { coworkLostInputNotice } from "../../src/cowork/held-input";
import { accept, beginTurn, init, makeProjector } from "./harness";

const committed = (inputId: unknown, outcome: unknown): ProtocolSdkMessage =>
  ({ type: "system", subtype: "host_input_committed", inputId, outcome, uuid: "hic-1", session_id: "s" }) as unknown as ProtocolSdkMessage;

describe("projector: host_input_committed", () => {
  for (const [outcome, words] of [["folded", "into the turn that was running"], ["queued", "behind the turn that was running"], ["started", "as a new turn"]] as const) {
    test(`${outcome} is persisted once as peer_message_committed`, () => {
      const { projector } = makeProjector();
      accept(projector, init()); beginTurn(projector, "go");
      const out = accept(projector, committed("pr_abc", outcome));
      expect(out).toHaveLength(1);
      expect(out[0]).toMatchObject({ type: "continuity_warning", threadId: MAIN_THREAD, warning: "peer_message_committed", text: expect.stringContaining(words) });
      expect(accept(projector, committed("pr_abc", outcome))).toHaveLength(0); // a replay / re-sent commit appends nothing
    });
  }
  test("an `already` outcome, a malformed id or an unknown outcome project nothing", () => {
    const { projector } = makeProjector();
    accept(projector, init());
    for (const frame of [committed("pr_x", "already"), committed("bad id!", "folded"), committed(7, "folded"), committed("pr_y", "bogus")]) expect(accept(projector, frame)).toHaveLength(0);
  });
  test("the lost-input note is a continuity_warning's content, bounded and without a sender", () => {
    const note = coworkLostInputNotice();
    expect(note.warning).toBe("peer_message_lost");
    expect(note.text.length).toBeLessThan(4_000);
  });
});
