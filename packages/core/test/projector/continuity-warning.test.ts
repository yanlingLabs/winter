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
  for (const kind of ["reasoning_state_unsaved", "model_switch_lossy", "switch_compaction", "provider_state_missing"]) {
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
});
