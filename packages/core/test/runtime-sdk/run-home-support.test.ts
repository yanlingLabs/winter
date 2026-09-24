// WS-21 L3.3 (spec §3.1, §3.8): feature detection of the run-home router, and the ONE disposal rule both
// legs apply when an incarnation ends.
import { describe, expect, test } from "bun:test";
import { disposeFailedRunHome, linkedRunHomeBuilder, routerSupportsRunHome, runHomeHandleOf, runHomeReportSummary, settleRunHome } from "../../src/runtime-sdk/run-home-support";
import type { RunHome } from "@yanlinglabs/winter-runtime-sdk";

const stub = (onDispose: () => void, failDispose = false): RunHome => ({
  runId: "r1", dir: "/h/cache/runs/r1", sdkHome: "/h/sdk",
  input: { home: "/h", mode: "code", dispatchChild: false, leg: "official", cwd: "/c", trustedProjectRoot: null, gitRoot: null, mcpDisabled: [], reservedMcpServerNames: [], memoryDir: "/m" },
  effectiveSettings: {},
  report: { skippedLinks: [], externalUserLinks: [], droppedMcpServers: [], unconditionalRules: [], droppedImports: [], skippedAgents: [], droppedRules: [] },
  dispose: async () => { onDispose(); if (failDispose) throw new Error("EBUSY"); },
});

describe("feature detection", () => {
  test("the linked router's builder agrees with the module's own export", async () => {
    const linked = routerSupportsRunHome(await import("@yanlinglabs/winter-runtime-sdk"));
    expect(linkedRunHomeBuilder() !== undefined).toBe(linked);
  });

  test("runHomeHandleOf needs BOTH run-home members of a router handle", () => {
    const h = { runHomeOutcome: () => "safe" as const, reconcileRootForRecovery: async () => ({ outcome: "clean" as const, transcripts: [] }) };
    expect(runHomeHandleOf(h)).toBe(h);
    expect(runHomeHandleOf({ runHomeOutcome: () => "safe" })).toBeUndefined();
    expect(runHomeHandleOf(undefined)).toBeUndefined();
  });
});

describe("settleRunHome — dispose ONLY when the router says safe (L2 fix round 1)", () => {
  // Both legs, one rule: `safe` is the router's word that the incarnation ended AND reconciled (the
  // Winter leg reports it once the query finished, closed or failed — `pending` while the child runs, and
  // for a query nobody iterated). Everything else keeps the folder for recovery.
  const cases: Array<[string | undefined, "disposed" | "kept"]> = [
    ["safe", "disposed"],
    ["quarantined", "kept"],   // kept, and recorded so the boot sweep never re-reconciles it
    ["pending", "kept"],       // not settled: recovery reconciles it
    [undefined, "kept"],       // no answer: never a guess, on either leg
  ];
  for (const [outcome, expected] of cases) {
    test(`${String(outcome)} → ${expected}`, async () => {
      let disposed = 0;
      const quarantined: string[] = [];
      expect(await settleRunHome(stub(() => { disposed++; }), outcome as never, { onQuarantined: (d) => quarantined.push(d) })).toBe(expected);
      expect(disposed).toBe(expected === "disposed" ? 1 : 0);
      expect(quarantined).toEqual(outcome === "quarantined" ? ["/h/cache/runs/r1"] : []);
    });
  }

  test("a dispose that fails is reported kept (the boot sweep retries), never thrown", async () => {
    const lines: string[] = [];
    expect(await settleRunHome(stub(() => {}, true), "safe", { log: (l) => lines.push(l) })).toBe("kept");
    expect(lines.join("\n")).toContain("r1");
  });

  test("disposeFailedRunHome disposes at once and never throws", async () => {
    let disposed = 0;
    await disposeFailedRunHome(stub(() => { disposed++; }, true));
    await disposeFailedRunHome(undefined);
    expect(disposed).toBe(1);
  });
});

describe("runHomeReportSummary — what the builder did not do, for the daemon log", () => {
  test("empty report: nothing to say", () => {
    expect(runHomeReportSummary(stub(() => {}))).toBeUndefined();
  });
  test("every field is named, skippedAgents (L2 fix round 1) and droppedRules (router 3279a1d) included", () => {
    const rh = stub(() => {});
    rh.report = {
      skippedLinks: [{ path: "/p/a", reason: "outside-root" }], externalUserLinks: ["/u/x"],
      droppedMcpServers: [{ name: "srv", reason: "reserved-name" }], unconditionalRules: ["r.md"], droppedImports: ["../x.md"],
      skippedAgents: [{ path: "/h/sdk/agents/bad.md", reason: "unparseable" }],
      droppedRules: [{ rule: "Edit(/out/**)", tier: "project", reason: "anchor holds ?" }],
    };
    const line = runHomeReportSummary(rh)!;
    expect(line).toContain("r1");
    for (const bit of ["/p/a (outside-root)", "/u/x", "srv (reserved-name)", "r.md", "../x.md", "/h/sdk/agents/bad.md (unparseable)", "Edit(/out/**) [project] (anchor holds ?)"]) expect(line).toContain(bit);
  });
});
