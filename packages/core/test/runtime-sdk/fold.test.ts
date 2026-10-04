// `runtime-sdk/fold.ts`: what a session may assume of its runtime (agent SDK 0.0.44's mid-turn fold).
import { describe, expect, test } from "bun:test";
import { WinterRpcError } from "@yanlinglabs/winter-agent-sdk";
import { FOLD_SINCE, clearQueuedInput, hostInputFoldedCount, runtimeFolds } from "../../src/runtime-sdk/fold";

describe("runtimeFolds: only a runtime KNOWN to be ≥ 0.0.44 folds", () => {
  test("the boundary, newer releases, older ones and an unknown version", () => {
    expect(FOLD_SINCE).toBe("0.0.44");
    expect(runtimeFolds("0.0.44")).toBe(true);
    expect(runtimeFolds("0.0.45")).toBe(true);
    expect(runtimeFolds("0.1.0")).toBe(true);
    expect(runtimeFolds("1.0.0-beta.1")).toBe(true);
    expect(runtimeFolds("0.0.43")).toBe(false);
    expect(runtimeFolds("0.0.9")).toBe(false);
    expect(runtimeFolds(undefined)).toBe(false);
    expect(runtimeFolds("garbage")).toBe(false);
  });
});

describe("hostInputFoldedCount and clearQueuedInput", () => {
  test("the fold frame's count; anything else, a subagent's frame or a bad count is not one", () => {
    expect(hostInputFoldedCount({ type: "system", subtype: "host_input_folded", count: 2, uuid: "u", session_id: "s" })).toBe(2);
    expect(hostInputFoldedCount({ type: "system", subtype: "host_input_folded", count: 0, uuid: "u", session_id: "s" })).toBeUndefined();
    expect(hostInputFoldedCount({ type: "system", subtype: "host_input_folded", count: 1, parent_tool_use_id: "t", uuid: "u", session_id: "s" })).toBeUndefined();
    expect(hostInputFoldedCount({ type: "system", subtype: "init" })).toBeUndefined();
  });

  test("a rejecting clear (an older runtime's unknown_subtype) clears nothing and says why, never throws", async () => {
    const lines: string[] = [];
    const query = { clearQueuedInput: async () => { throw new WinterRpcError("unknown_subtype", "no such control"); } } as never;
    expect(await clearQueuedInput(query, (l) => lines.push(l))).toBe(0);
    expect(lines[0]).toContain("does not know clear_queued_input");
    expect(await clearQueuedInput({ clearQueuedInput: async () => ({ cleared: 3 }) } as never, () => {})).toBe(3);
  });
});
