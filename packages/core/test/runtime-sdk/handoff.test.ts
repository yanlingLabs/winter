// Winter Phase 8c (Task 4.1, WS-13 §8.2): `planAndApplySwitch`'s decision matrix, against a FAKE
// barrier (test seam — `runtimeSdkInternals` only resolves a REAL router-built handle, so this file
// never constructs one). No real winter binary; the RPC-level wiring (`session.setModel`'s case) is
// proved separately.
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HandoffBarrier, HandoffOutcome, HandoffPlan, RuntimeSelection } from "@yanlinglabs/winter-runtime-sdk";
import { planAndApplySwitch, type HandoffDeps } from "../../src/runtime-sdk/handoff";
import { openRuntimeStateDb, RuntimeSessionRecords } from "../../src/runtime-state";
import type { NormaRuntimeSdk } from "../../src/runtime-sdk/create";
import type { LegSession, WinterSessionDrivers } from "../../src/runtime-sdk/session-driver";

async function withRs<T>(fn: (rs: ReturnType<typeof openRuntimeStateDb>, records: RuntimeSessionRecords) => Promise<T> | T): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), "norma-handoff-"));
  const rs = openRuntimeStateDb(home);
  try {
    return await fn(rs, new RuntimeSessionRecords(rs));
  } finally {
    rs.close();
  }
}

const SELECTION = (kind: "winter-agent" | "claude-agent"): RuntimeSelection => ({
  runtimeKind: kind, providerId: "p", modelRef: "m", family: "f", authFamily: "api-key",
  sdkVersion: "0.0.4", reason: "test", decidedAt: new Date().toISOString(),
});

function seedRecord(records: RuntimeSessionRecords, sessionId: string): void {
  records.create({
    winterSessionId: sessionId, runtimeKind: "winter-agent", backendSessionId: "be-1",
    providerId: "p", modelRef: "m", backendRoot: "/x", transcriptProjectKey: "pk",
    memoryProjectKey: "pk", tempProjectKey: "pk", transcriptHealth: "clean",
    compatibilityLevel: "agent-state", conformanceCorpusVersion: "unverified",
    versionProvenance: "recorded", sdkVersion: "0.0.4", engineVersion: "0.0.4",
    providerCatalogVersion: "t", providerAdapterVersion: "t", capabilities: [],
    selection: SELECTION("winter-agent"),
  });
  records.transition(sessionId, "ready");
}

function fakeRuntime(opts: { selectRuntimeFor: NormaRuntimeSdk["selectRuntimeFor"] }): NormaRuntimeSdk {
  const never = (): never => { throw new Error("not reached by this test"); };
  return {
    sdk: {} as NormaRuntimeSdk["sdk"], // never touched: the barrier is injected directly (HandoffDeps.barrier)
    spawnHookFor: never, officialPeer: never, officialPeerSync: never, claudeExecutableFor: never,
    selectRuntimeFor: opts.selectRuntimeFor,
    registerHandoffParticipants: () => {},
    trackQuery: never, untrack: never,
    messaging: { releaseHeld: never },
    dispose: never,
  };
}

function fakeWinter(opts: { live?: LegSession }): WinterSessionDrivers {
  const never = (): never => { throw new Error("not reached by this test"); };
  return {
    legForNewSession: () => "winter", legOf: never, assertAvailable: () => {},
    create: never, get: () => opts.live, runTurn: never, ensure: never,
    evict: async () => {}, list: () => [], endAll: never,
  };
}

function deps(overrides: Partial<HandoffDeps>): HandoffDeps {
  return {
    runtime: fakeRuntime({ selectRuntimeFor: async () => SELECTION("winter-agent") }),
    winter: fakeWinter({}),
    records: {} as RuntimeSessionRecords,
    store: { meta: () => ({ mode: "code", cwd: "/x" }) },
    ...overrides,
  };
}

describe("planAndApplySwitch", () => {
  test("model: null never triggers a leg decision", async () => {
    const out = await planAndApplySwitch(deps({}), "s1", null, false);
    expect(out).toEqual({ kind: "same-runtime" });
  });

  test("no runtime record: same-runtime (nothing to switch FROM)", async () => {
    await withRs(async (_rs, records) => {
      const out = await planAndApplySwitch(deps({ records }), "s-nope", "anthropic/sonnet", false);
      expect(out).toEqual({ kind: "same-runtime" });
    });
  });

  test("the resolved runtime equals the recorded leg: same-runtime, NO barrier call", async () => {
    await withRs(async (_rs, records) => {
      seedRecord(records, "s1");
      let planCalled = false;
      const barrier: HandoffBarrier = { plan: async () => { planCalled = true; return null as unknown as HandoffPlan; }, execute: async () => null as unknown as HandoffOutcome };
      const out = await planAndApplySwitch(
        deps({ records, barrier, runtime: fakeRuntime({ selectRuntimeFor: async () => SELECTION("winter-agent") }) }),
        "s1", "openai/gpt-5.4", false,
      );
      expect(out).toEqual({ kind: "same-runtime" });
      expect(planCalled).toBe(false);
    });
  });

  test("the router refuses the selection: typed refusal", async () => {
    await withRs(async (_rs, records) => {
      seedRecord(records, "s1");
      const out = await planAndApplySwitch(
        deps({ records, runtime: fakeRuntime({ selectRuntimeFor: async () => ({ refused: true, reason: "runtime-unavailable", detail: "no claude executable" }) }) }),
        "s1", "anthropic/sonnet", false,
      );
      expect(out).toEqual({ kind: "refused", code: "runtime_selection_refused", detail: "no claude executable" });
    });
  });

  test("a different runtime with warnings and no confirmLossy: confirmation_required, execute never called", async () => {
    await withRs(async (_rs, records) => {
      seedRecord(records, "s1");
      const plan: HandoffPlan = {
        session: { projectKey: "pk", sessionId: "be-1" }, from: "winter-agent", to: "claude-agent",
        steps: [{ step: 1, name: "lease" }, { step: 4, name: "compare tails", knownUnprovable: "reasoning state does not survive a move to the official leg" }],
        decorationDoor: "fallback", tempContinuity: "clone-copy",
        selection: { kind: "servable", selection: SELECTION("claude-agent"), review: { checked: true } as never },
      };
      let executeCalled = false;
      const barrier: HandoffBarrier = { plan: async () => plan, execute: async () => { executeCalled = true; return { kind: "resumed", selection: SELECTION("claude-agent") }; } };
      const out = await planAndApplySwitch(
        deps({ records, barrier, runtime: fakeRuntime({ selectRuntimeFor: async () => SELECTION("claude-agent") }) }),
        "s1", "anthropic/sonnet", false,
      );
      expect(out).toEqual({ kind: "confirmation_required", warnings: ["reasoning state does not survive a move to the official leg"] });
      expect(executeCalled).toBe(false);
    });
  });

  test("the SAME plan, confirmed: execute runs and 'resumed' is reported", async () => {
    await withRs(async (_rs, records) => {
      seedRecord(records, "s1");
      const plan: HandoffPlan = {
        session: { projectKey: "pk", sessionId: "be-1" }, from: "winter-agent", to: "claude-agent",
        steps: [{ step: 1, name: "lease", knownUnprovable: "lossy" }],
        decorationDoor: "fallback", tempContinuity: "clone-copy",
        selection: { kind: "servable", selection: SELECTION("claude-agent"), review: { checked: true } as never },
      };
      let executedPlan: HandoffPlan | undefined;
      const barrier: HandoffBarrier = { plan: async () => plan, execute: async (p) => { executedPlan = p; return { kind: "resumed", selection: SELECTION("claude-agent") }; } };
      const out = await planAndApplySwitch(
        deps({ records, barrier, runtime: fakeRuntime({ selectRuntimeFor: async () => SELECTION("claude-agent") }) }),
        "s1", "anthropic/sonnet", true,
      );
      expect(out).toEqual({ kind: "resumed", selection: SELECTION("claude-agent") });
      expect(executedPlan).toBe(plan);
    });
  });

  test("a running turn defers execution until idle() settles", async () => {
    await withRs(async (_rs, records) => {
      seedRecord(records, "s1");
      const plan: HandoffPlan = {
        session: { projectKey: "pk", sessionId: "be-1" }, from: "winter-agent", to: "claude-agent",
        steps: [{ step: 1, name: "lease" }],
        decorationDoor: "fallback", tempContinuity: "clone-copy",
        selection: { kind: "servable", selection: SELECTION("claude-agent"), review: { checked: true } as never },
      };
      let executeCalled = false;
      let resolveIdle: (() => void) | undefined;
      const idlePromise = new Promise<void>((resolve) => { resolveIdle = resolve; });
      const never = (): never => { throw new Error("not reached by this test"); };
      const live: LegSession = {
        sessionId: "s1", backendSessionId: "be-1", mode: "code", state: "live", generation: 1, resumed: true,
        init: undefined, turnRunning: true, turnStartedAt: Date.now(), done: Promise.resolve(),
        pendingSends: [], heldDeliveries: [],
        send: never, steer: never, interrupt: never, compact: never, setModel: never, setPolicy: never,
        end: never, deliver: never, open: never, idle: () => idlePromise,
      };
      const barrier: HandoffBarrier = { plan: async () => plan, execute: async () => { executeCalled = true; return { kind: "resumed", selection: SELECTION("claude-agent") }; } };
      const out = await planAndApplySwitch(
        deps({ records, barrier, winter: fakeWinter({ live }), runtime: fakeRuntime({ selectRuntimeFor: async () => SELECTION("claude-agent") }) }),
        "s1", "anthropic/sonnet", true,
      );
      expect(out).toEqual({ kind: "deferred" });
      expect(executeCalled).toBe(false);
      resolveIdle!();
      await idlePromise;
      await Bun.sleep(10); // let the fire-and-forget .then() run
      expect(executeCalled).toBe(true);
    });
  });
});
