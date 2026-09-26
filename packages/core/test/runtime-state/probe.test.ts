// The DEV-path half of `verify:runtime-state` (the compiled half boots `dist/winter-core`): the
// probe reports the A2 fact the gate asserts — the router handle constructed. (WS-23: the second
// fact, the official peer loading, is gone with that leg.)
import { describe, expect, test } from "bun:test";
import { runRuntimeStateProbe } from "../../src/runtime-state/probe";
import { withTempHome } from "./support";

describe("runRuntimeStateProbe", () => {
  test("reports runtimeSdk (true in this dev tree), and nothing about the retired official peer", async () => {
    await withTempHome(async (home) => {
      const result = await runRuntimeStateProbe({ home });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.runtimeSdk).toBe(true);
      expect("officialPeer" in result).toBe(false);
    });
  });
  test("refuses without a home", async () => {
    expect(await runRuntimeStateProbe({ home: undefined })).toEqual({ ok: false, error: expect.stringContaining("WINTER_HOME") });
  });
});
