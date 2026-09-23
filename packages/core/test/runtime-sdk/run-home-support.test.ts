// WS-21 L3.3 (spec §3.1, §3.8): feature detection of the run-home router, and the ONE disposal rule both
// legs apply when an incarnation ends.
import { describe, expect, test } from "bun:test";
import { disposeFailedRunHome, linkedRunHomeBuilder, routerSupportsRunHome, runHomeHandleOf, settleRunHome } from "../../src/runtime-sdk/run-home-support";
import type { RunHome } from "../../src/runtime-sdk/run-home-contract";

const stub = (onDispose: () => void, failDispose = false): RunHome => ({
  runId: "r1", dir: "/h/cache/runs/r1", sdkHome: "/h/sdk",
  input: { home: "/h", mode: "code", dispatchChild: false, leg: "official", cwd: "/c", trustedProjectRoot: null, gitRoot: null, mcpDisabled: [], reservedMcpServerNames: [], memoryDir: "/m" },
  effectiveSettings: {},
  report: { skippedLinks: [], externalUserLinks: [], droppedMcpServers: [], unconditionalRules: [], droppedImports: [] },
  dispose: async () => { onDispose(); if (failDispose) throw new Error("EBUSY"); },
});

describe("feature detection", () => {
  test("the linked router's builder agrees with the module's own export", async () => {
    const linked = routerSupportsRunHome(await import("@yanlinglabs/winter-runtime-sdk"));
    expect(linkedRunHomeBuilder() !== undefined).toBe(linked);
  });

  test("runHomeHandleOf needs BOTH run-home members of a router handle", () => {
    const h = { runHomeOutcome: () => "safe" as const, reconcileRootForRecovery: async () => "clean" as const };
    expect(runHomeHandleOf(h)).toBe(h);
    expect(runHomeHandleOf({ runHomeOutcome: () => "safe" })).toBeUndefined();
    expect(runHomeHandleOf(undefined)).toBeUndefined();
  });
});

describe("settleRunHome — dispose only on the router's say-so", () => {
  const cases: Array<[string | undefined, boolean, "disposed" | "kept"]> = [
    ["safe", false, "disposed"],
    ["quarantined", false, "disposed"],   // the working copy was already preserved
    ["pending", false, "kept"],           // not settled: recovery reconciles it
    [undefined, false, "kept"],           // the official leg never guesses
    [undefined, true, "disposed"],        // the Winter leg has no working copy: safe by construction
    ["pending", true, "kept"],            // …but the router's own answer still wins
  ];
  for (const [outcome, winterLegSafe, expected] of cases) {
    test(`${String(outcome)} (winterLegSafe=${winterLegSafe}) → ${expected}`, async () => {
      let disposed = 0;
      expect(await settleRunHome(stub(() => { disposed++; }), outcome as never, { winterLegSafe })).toBe(expected);
      expect(disposed).toBe(expected === "disposed" ? 1 : 0);
    });
  }

  test("a dispose that fails is reported kept (the boot sweep retries), never thrown", async () => {
    const lines: string[] = [];
    expect(await settleRunHome(stub(() => {}, true), "safe", { winterLegSafe: false, log: (l) => lines.push(l) })).toBe("kept");
    expect(lines.join("\n")).toContain("r1");
  });

  test("disposeFailedRunHome disposes at once and never throws", async () => {
    let disposed = 0;
    await disposeFailedRunHome(stub(() => { disposed++; }, true));
    await disposeFailedRunHome(undefined);
    expect(disposed).toBe(1);
  });
});
