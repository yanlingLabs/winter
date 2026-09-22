// The DEV-path half of `verify:runtime-state` (the compiled half boots `dist/winter-core`): the
// probe reports the two A2 facts the gate asserts — the router handle constructed, and the official
// peer loaded and declared.
import { describe, expect, test } from "bun:test";
import { runRuntimeStateProbe } from "../../src/runtime-state/probe";
import { withTempHome } from "./support";

describe("runRuntimeStateProbe", () => {
  test("reports runtimeSdk and officialPeer (both true in this dev tree, which installs the pinned peer)", async () => {
    await withTempHome(async (home) => {
      const result = await runRuntimeStateProbe({ home });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.runtimeSdk).toBe(true);
      expect(result.officialPeer).toBe(true);
    });
  });
  test("refuses without a home", async () => {
    expect(await runRuntimeStateProbe({ home: undefined })).toEqual({ ok: false, error: expect.stringContaining("WINTER_HOME") });
  });
});
