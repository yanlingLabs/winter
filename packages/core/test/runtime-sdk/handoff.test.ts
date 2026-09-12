// Winter Phase 8c (Task 4.1, WS-13 §8.2): `planAndApplySwitch`'s decision matrix, against a FAKE
// barrier (test seam — `runtimeSdkInternals` only resolves a REAL router-built handle, so this file
// never constructs one). No real winter binary; the RPC-level wiring (`session.setModel`'s case) is
// proved separately.
//
// Fix wave (M1): `planAndApplySwitch` reads the REAL pinned catalog (`catalogRowsFor`, never
// faked) for its own bail-out #4 — so every case below that means to REACH the fake selector uses
// "claude-sonnet-5" (a real catalog row/alias), not a fictional string like the file's earlier
// "anthropic/sonnet" (zero catalog rows, which the new bail-out now short-circuits to
// `same-runtime` before the fake selector is ever called).
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HandoffBarrier, HandoffOutcome, HandoffPlan, HandoffResumeTarget, RuntimeKind, RuntimeSelection, SelectionInput } from "@yanlinglabs/winter-runtime-sdk";
import { planAndApplySwitch, registerHandoffParticipants, type HandoffDeps } from "../../src/runtime-sdk/handoff";
import { openRuntimeStateDb, RuntimeSessionRecords } from "../../src/runtime-state";
import type { WinterRuntimeSdk } from "../../src/runtime-sdk/create";
import type { LegSession, WinterSessionDrivers } from "../../src/runtime-sdk/session-driver";
import type { Settings } from "../../src/settings";

async function withRs<T>(fn: (rs: ReturnType<typeof openRuntimeStateDb>, records: RuntimeSessionRecords) => Promise<T> | T): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), "winter-handoff-"));
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

function fakeRuntime(opts: {
  selectRuntimeFor: WinterRuntimeSdk["selectRuntimeFor"];
  buildSelectionInput?: WinterRuntimeSdk["buildSelectionInput"];
}): WinterRuntimeSdk {
  const never = (): never => { throw new Error("not reached by this test"); };
  return {
    sdk: {} as WinterRuntimeSdk["sdk"], // never touched: the barrier is injected directly (HandoffDeps.barrier)
    spawnHookFor: never, officialPeer: never, officialPeerSync: never, claudeExecutableFor: never,
    selectRuntimeFor: opts.selectRuntimeFor,
    buildSelectionInput: opts.buildSelectionInput,
    registerHandoffParticipants: () => {},
    trackQuery: never, untrack: never,
    messaging: { releaseHeld: never },
    dispose: never,
  };
}

/**
 * Distinguishes a FRESH selection call (no `persisted`) from a review of the PERSISTED one, so a
 * test can assert `planAndApplySwitch`'s destination decision is never made by handing the router's
 * own persisted-wins rule the record it should instead be deciding fresh against (the P8c bug: a
 * `persisted` field on this call always echoed the current leg back, and the barrier was never
 * reached). Throws if `input.persisted` is set — a call shaped that way must never reach this fake.
 */
function freshOnlySelector(forModel: (model: string | undefined) => RuntimeSelection | { refused: true; reason: "runtime-unavailable"; detail: string }): WinterRuntimeSdk["selectRuntimeFor"] {
  return async (input) => {
    if (input.persisted !== undefined) throw new Error("planAndApplySwitch must decide the destination FRESH — it must never pass `persisted` to selectRuntimeFor");
    return forModel(input.model);
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

/** Fix wave (C2 / P8c-18): every existing test in this file below is about the BARRIER's own
 *  decision matrix, not the fence — so the default here is `crossRuntime: true` (the fence would
 *  otherwise refuse every cross-runtime case before the barrier is ever reached, which is not what
 *  those tests are proving). The fence itself gets its OWN `describe` block further down, which
 *  overrides `settings` explicitly per case. */
function deps(overrides: Partial<HandoffDeps>): HandoffDeps {
  return {
    runtime: fakeRuntime({ selectRuntimeFor: freshOnlySelector(() => SELECTION("winter-agent")) }),
    winter: fakeWinter({}),
    records: {} as RuntimeSessionRecords,
    store: { meta: () => ({ mode: "code", cwd: "/x" }) },
    settings: () => ({ runtimes: { handoff: { crossRuntime: true } } }) as unknown as Settings,
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
      const out = await planAndApplySwitch(deps({ records }), "s-nope", "claude-sonnet-5", false);
      expect(out).toEqual({ kind: "same-runtime" });
    });
  });

  test("the resolved runtime equals the recorded leg: same-runtime, NO barrier call", async () => {
    await withRs(async (_rs, records) => {
      seedRecord(records, "s1");
      let planCalled = false;
      const barrier: HandoffBarrier = { plan: async () => { planCalled = true; return null as unknown as HandoffPlan; }, execute: async () => null as unknown as HandoffOutcome };
      const out = await planAndApplySwitch(
        deps({ records, barrier, runtime: fakeRuntime({ selectRuntimeFor: freshOnlySelector(() => SELECTION("winter-agent")) }) }),
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
        deps({ records, runtime: fakeRuntime({ selectRuntimeFor: freshOnlySelector(() => ({ refused: true, reason: "runtime-unavailable", detail: "no claude executable" })) }) }),
        "s1", "claude-sonnet-5", false,
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
      let planCalled: RuntimeKind | undefined;
      const barrier: HandoffBarrier = { plan: async (_session, to) => { planCalled = to; return plan; }, execute: async () => { executeCalled = true; return { kind: "resumed", selection: SELECTION("claude-agent") }; } };
      const out = await planAndApplySwitch(
        deps({ records, barrier, runtime: fakeRuntime({ selectRuntimeFor: freshOnlySelector(() => SELECTION("claude-agent")) }) }),
        "s1", "claude-sonnet-5", false,
      );
      expect(out).toEqual({ kind: "confirmation_required", warnings: ["reasoning state does not survive a move to the official leg"] });
      // A fresh selection landing on a DIFFERENT leg from the recorded one must reach the barrier's
      // own plan() -- the P8c bug was exactly that this call never happened.
      expect(planCalled).toBe("claude-agent");
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
      let planCalled = false;
      const barrier: HandoffBarrier = { plan: async () => { planCalled = true; return plan; }, execute: async (p) => { executedPlan = p; return { kind: "resumed", selection: SELECTION("claude-agent") }; } };
      const out = await planAndApplySwitch(
        deps({ records, barrier, runtime: fakeRuntime({ selectRuntimeFor: freshOnlySelector(() => SELECTION("claude-agent")) }) }),
        "s1", "claude-sonnet-5", true,
      );
      expect(out).toEqual({ kind: "resumed", selection: SELECTION("claude-agent") });
      expect(planCalled).toBe(true);
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
        deps({ records, barrier, winter: fakeWinter({ live }), runtime: fakeRuntime({ selectRuntimeFor: freshOnlySelector(() => SELECTION("claude-agent")) }) }),
        "s1", "claude-sonnet-5", true,
      );
      expect(out).toEqual({ kind: "deferred" });
      expect(executeCalled).toBe(false);
      resolveIdle!();
      await idlePromise;
      await Bun.sleep(10); // let the fire-and-forget .then() run
      expect(executeCalled).toBe(true);
    });
  });

  // m5 (whole-branch review): the deferred branch must commit the model ONLY once the barrier has
  // actually executed and RESUMED — never at defer time (`ipc/server.ts`'s own immediate store
  // write must skip the "deferred" outcome; this is the deferred path's own, later commit).
  describe("m5: the deferred handoff's model commit", () => {
    function deferredHarness(outcome: HandoffOutcome): {
      run(): Promise<{ out: Awaited<ReturnType<typeof planAndApplySwitch>>; setModelCalls: Array<[string, string | null]>; logLines: string[]; resolveIdle: () => void; idlePromise: Promise<void> }>;
    } {
      return {
        async run() {
          const setModelCalls: Array<[string, string | null]> = [];
          const logLines: string[] = [];
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
          const plan: HandoffPlan = {
            session: { projectKey: "pk", sessionId: "be-1" }, from: "winter-agent", to: "claude-agent",
            steps: [{ step: 1, name: "lease" }],
            decorationDoor: "fallback", tempContinuity: "clone-copy",
            selection: { kind: "servable", selection: SELECTION("claude-agent"), review: { checked: true } as never },
          };
          const barrier: HandoffBarrier = { plan: async () => plan, execute: async () => outcome };
          return await withRs(async (_rs, records) => {
            seedRecord(records, "s1");
            const out = await planAndApplySwitch(
              deps({
                records, barrier, winter: fakeWinter({ live }),
                runtime: fakeRuntime({ selectRuntimeFor: freshOnlySelector(() => SELECTION("claude-agent")) }),
                store: { meta: () => ({ mode: "code", cwd: "/x" }), setModel: (sid, model) => { setModelCalls.push([sid, model]); } },
                log: (line) => { logLines.push(line); },
              }),
              "s1", "claude-sonnet-5", true,
            );
            return { out, setModelCalls, logLines, resolveIdle: resolveIdle!, idlePromise };
          });
        },
      };
    }

    test("a `resumed` outcome commits the model, but only AFTER the barrier executes, and logs nothing", async () => {
      const { run } = deferredHarness({ kind: "resumed", selection: SELECTION("claude-agent") });
      const { out, setModelCalls, logLines, resolveIdle, idlePromise } = await run();
      expect(out).toEqual({ kind: "deferred" });
      expect(setModelCalls).toEqual([]); // never at defer time
      resolveIdle();
      await idlePromise;
      await Bun.sleep(10); // let the fire-and-forget continuation run
      expect(setModelCalls).toEqual([["s1", "claude-sonnet-5"]]);
      expect(logLines).toEqual([]); // Minor 3's log line is for the NON-resumed outcomes only
    });

    // Minor 3 (whole-branch review): a deferred handoff settling to `blocked` used to leave no
    // trace anywhere — the caller already got `{}` back at defer time, and `blocked` writes
    // nothing to the store either. Exactly one log line, naming kind + reason + session id, and
    // no store write.
    test("a `blocked` outcome never commits the model — the switch never actually happened — and logs exactly once", async () => {
      const { run } = deferredHarness({ kind: "blocked", reason: "lease-held" });
      const { setModelCalls, logLines, resolveIdle, idlePromise } = await run();
      resolveIdle();
      await idlePromise;
      await Bun.sleep(10);
      expect(setModelCalls).toEqual([]);
      expect(logLines).toHaveLength(1);
      expect(logLines[0]).toContain("s1");
      expect(logLines[0]).toContain("blocked");
      expect(logLines[0]).toContain("lease-held");
    });

    test("a `lossy-fork-offered` outcome never commits the model either, and logs exactly once", async () => {
      const { run } = deferredHarness({ kind: "lossy-fork-offered", reason: "provider-native state would be dropped", step: 8 });
      const { setModelCalls, logLines, resolveIdle, idlePromise } = await run();
      resolveIdle();
      await idlePromise;
      await Bun.sleep(10);
      expect(setModelCalls).toEqual([]);
      expect(logLines).toHaveLength(1);
      expect(logLines[0]).toContain("s1");
      expect(logLines[0]).toContain("lossy_fork");
      expect(logLines[0]).toContain("provider-native state would be dropped");
    });
  });

  // Fix wave M1: mirrors `session-driver.ts`'s `decideRuntime` bail-out #4 — a model with NO row
  // in the pinned catalog at all keeps today's plain in-runtime behaviour rather than reaching the
  // (fake) selector at all.
  test("M1: a model with no row in the real catalog at all bails to same-runtime BEFORE the selector runs", async () => {
    await withRs(async (_rs, records) => {
      seedRecord(records, "s1");
      let selectorCalled = false;
      const runtime = fakeRuntime({
        selectRuntimeFor: async () => { selectorCalled = true; return SELECTION("claude-agent"); },
      });
      const out = await planAndApplySwitch(deps({ records, runtime }), "s1", "my-custom-finetune-id-nobody-published", false);
      expect(out).toEqual({ kind: "same-runtime" });
      expect(selectorCalled).toBe(false);
    });
  });

  test("M1: a CATALOG-KNOWN model (claude-sonnet-5) does NOT bail out — the selector still runs", async () => {
    await withRs(async (_rs, records) => {
      seedRecord(records, "s1");
      let selectorCalled = false;
      const runtime = fakeRuntime({
        selectRuntimeFor: freshOnlySelector(() => { selectorCalled = true; return SELECTION("winter-agent"); }),
      });
      const out = await planAndApplySwitch(deps({ records, runtime }), "s1", "claude-sonnet-5", false);
      expect(out).toEqual({ kind: "same-runtime" }); // same leg as recorded — but the selector DID run
      expect(selectorCalled).toBe(true);
    });
  });
});

// Fix wave C2 (whole-branch review / ruling P8c-18): the cross-runtime handoff fence. Every case
// here reaches the point where a FRESH destination decision genuinely differs from the recorded
// leg — the fence must refuse BEFORE the barrier is ever consulted and BEFORE anything is written.
describe("planAndApplySwitch: the C2 cross-runtime fence (settings.runtimes.handoff.crossRuntime)", () => {
  test("disabled (the schema default): a cross-runtime destination is refused typed, no barrier call", async () => {
    await withRs(async (_rs, records) => {
      seedRecord(records, "s1");
      let planCalled = false;
      const barrier: HandoffBarrier = { plan: async () => { planCalled = true; return null as unknown as HandoffPlan; }, execute: async () => null as unknown as HandoffOutcome };
      const out = await planAndApplySwitch(
        deps({
          records, barrier,
          runtime: fakeRuntime({ selectRuntimeFor: freshOnlySelector(() => SELECTION("claude-agent")) }),
          settings: () => ({ runtimes: { handoff: { crossRuntime: false } } }) as unknown as Settings,
        }),
        "s1", "claude-sonnet-5", false,
      );
      expect(out).toEqual({ kind: "refused", code: "handoff_disabled", detail: expect.stringContaining("disabled") });
      expect(planCalled).toBe(false);
    });
  });

  test("no runtimes block at all (an absent settings.json): the fence still refuses (absent means off)", async () => {
    await withRs(async (_rs, records) => {
      seedRecord(records, "s1");
      const out = await planAndApplySwitch(
        deps({
          records,
          runtime: fakeRuntime({ selectRuntimeFor: freshOnlySelector(() => SELECTION("claude-agent")) }),
          settings: () => null,
        }),
        "s1", "claude-sonnet-5", false,
      );
      expect(out).toEqual({ kind: "refused", code: "handoff_disabled", detail: expect.any(String) });
    });
  });

  test("enabled: the fence steps aside and the barrier is reached exactly as before", async () => {
    await withRs(async (_rs, records) => {
      seedRecord(records, "s1");
      let planCalled = false;
      const plan: HandoffPlan = {
        session: { projectKey: "pk", sessionId: "be-1" }, from: "winter-agent", to: "claude-agent",
        steps: [{ step: 1, name: "lease" }],
        decorationDoor: "fallback", tempContinuity: "clone-copy",
        selection: { kind: "servable", selection: SELECTION("claude-agent"), review: { checked: true } as never },
      };
      const barrier: HandoffBarrier = { plan: async () => { planCalled = true; return plan; }, execute: async () => ({ kind: "resumed", selection: SELECTION("claude-agent") }) };
      const out = await planAndApplySwitch(
        deps({
          records, barrier,
          runtime: fakeRuntime({ selectRuntimeFor: freshOnlySelector(() => SELECTION("claude-agent")) }),
          settings: () => ({ runtimes: { handoff: { crossRuntime: true } } }) as unknown as Settings,
        }),
        "s1", "claude-sonnet-5", true,
      );
      expect(planCalled).toBe(true);
      expect(out).toEqual({ kind: "resumed", selection: SELECTION("claude-agent") });
    });
  });

  test("a SAME-runtime model change is never fenced, flag on or off", async () => {
    await withRs(async (_rs, records) => {
      seedRecord(records, "s1"); // recorded leg: winter-agent
      for (const crossRuntime of [true, false]) {
        const out = await planAndApplySwitch(
          deps({
            records,
            runtime: fakeRuntime({ selectRuntimeFor: freshOnlySelector(() => SELECTION("winter-agent")) }),
            settings: () => ({ runtimes: { handoff: { crossRuntime } } }) as unknown as Settings,
          }),
          "s1", "claude-sonnet-5", false,
        );
        expect(out).toEqual({ kind: "same-runtime" });
      }
    });
  });
});

describe("registerHandoffParticipants: selectionInputFor wiring", () => {
  test("selectionInputFor delegates to WinterRuntimeSdk.buildSelectionInput, with mode from the record's session and persisted from the barrier's own args", async () => {
    await withRs(async (_rs, records) => {
      seedRecord(records, "s1");
      const fakeSelectionInput: SelectionInput = {
        mode: "dispatch", requested: {}, families: { families: [] } as unknown as SelectionInput["families"],
        credentials: { byProvider: {} }, hasClaudePeer: true, claudeOauthApproved: false,
      };
      let captured: { mode: string; model?: string; persisted?: RuntimeSelection } | undefined;
      const runtime = fakeRuntime({
        selectRuntimeFor: freshOnlySelector(() => SELECTION("winter-agent")),
        buildSelectionInput: async (input) => { captured = input; return fakeSelectionInput; },
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let registered: any;
      registerHandoffParticipants({
        runtime: { ...runtime, registerHandoffParticipants: (p) => { registered = p; } },
        winter: fakeWinter({}), records,
        store: { meta: () => ({ mode: "dispatch", cwd: "/x" }) },
        settings: () => null,
      });
      expect(registered.selectionInputFor).toBeDefined();
      const persisted = SELECTION("winter-agent");
      const result = await registered.selectionInputFor({ session: { projectKey: "pk", sessionId: "be-1" }, from: "winter-agent" as RuntimeKind, to: "claude-agent" as RuntimeKind, persisted });
      expect(result).toBe(fakeSelectionInput);
      // No `model` in the call — this door reviews the PERSISTED family's servability on the
      // destination, never a specific newly-requested model (that decision already happened, fresh,
      // in `planAndApplySwitch` before the barrier was ever reached).
      expect(captured).toEqual({ mode: "dispatch", persisted });
    });
  });

  test("omits selectionInputFor when the runtime has no buildSelectionInput (a hand-built WinterRuntimeSdk test double)", () => {
    const runtime = fakeRuntime({ selectRuntimeFor: freshOnlySelector(() => SELECTION("winter-agent")) });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let registered: any;
    registerHandoffParticipants({
      runtime: { ...runtime, registerHandoffParticipants: (p) => { registered = p; } },
      winter: fakeWinter({}), records: {} as RuntimeSessionRecords,
      store: { meta: () => ({ mode: "code", cwd: "/x" }) },
      settings: () => null,
    });
    expect(registered.selectionInputFor).toBeUndefined();
  });
});

describe("registerHandoffParticipants: destination.confirmInit (m4 — the plan-time snapshot's own torn window)", () => {
  function targetFor(sessionId: string): HandoffResumeTarget {
    return {
      backendSessionId: `be-${sessionId}-new`,
      selection: SELECTION("claude-agent"),
    } as unknown as HandoffResumeTarget; // only these two fields are read by confirmInit
  }

  function registerDestination(
    records: RuntimeSessionRecords,
    winterOverride?: WinterSessionDrivers,
  ): (session: { projectKey: string; sessionId: string }, to: RuntimeKind) => { confirmInit(target: HandoffResumeTarget): Promise<{ ok: boolean; reason?: string }> } {
    const runtime = fakeRuntime({ selectRuntimeFor: freshOnlySelector(() => SELECTION("winter-agent")) });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let registered: any;
    registerHandoffParticipants({
      runtime: { ...runtime, registerHandoffParticipants: (p) => { registered = p; } },
      winter: winterOverride ?? fakeWinter({}), records,
      store: { meta: () => ({ mode: "code", cwd: "/x" }) },
      settings: () => null,
    });
    return registered.destination;
  }

  /** Unlike `fakeWinter`, `ensure` actually resolves — needed for the ONE test in this block that
   *  drives `confirmInit`'s SUCCESS path all the way through. */
  function fakeWinterThatOpens(): WinterSessionDrivers {
    const never = (): never => { throw new Error("not reached by this test"); };
    return {
      legForNewSession: () => "winter", legOf: never, assertAvailable: () => {},
      create: never, get: () => undefined, runTurn: never,
      ensure: async () => ({}) as LegSession,
      evict: async () => {}, list: () => [], endAll: never,
    };
  }

  test("the session's state at PLAN time is unchanged at execute time: confirmInit SUCCEEDS (P8d-24)", async () => {
    // Round 1 found that `destinationRuntimeFor`'s patch call went through `transition(id,
    // fresh.state, patch)` — a SELF-transition, which `ALLOWED_TRANSITIONS` refuses for every one
    // of the 8 states — so this exact case used to report `IllegalStateTransitionError` even though
    // nothing about the session had moved. P8d-24 (round 2) fixed it: `confirmInit` now uses
    // `RuntimeSessionRecords.patch` (a same-state patch door, never a transition). This test is the
    // round-2 ruling's own proof: the destination-side patch now SUCCEEDS where it previously threw.
    await withRs(async (_rs, records) => {
      seedRecord(records, "s1"); // ready
      const destination = registerDestination(records, fakeWinterThatOpens());
      const built = destination({ projectKey: "pk", sessionId: "be-1" }, "claude-agent");
      const result = await built!.confirmInit(targetFor("s1"));
      expect(result).toMatchObject({ ok: true });
      const record = records.get("s1")!;
      expect(record.runtimeKind).toBe("claude-agent");
      expect(record.state).toBe("ready"); // untouched — `patch` never writes `state`
      expect(record.backendSessionId).toBe(targetFor("s1").backendSessionId);
    });
  });

  test("m4: the session moved between plan and execute — confirmInit refuses typed and NEVER patches the record", async () => {
    await withRs(async (_rs, records) => {
      seedRecord(records, "s1"); // ready — the snapshot `destination(...)` takes below
      const destination = registerDestination(records);
      const built = destination({ projectKey: "pk", sessionId: "be-1" }, "claude-agent");

      // Something else moves the record AFTER the plan-time snapshot but BEFORE execute.
      records.transition("s1", "archived");

      const result = await built!.confirmInit(targetFor("s1"));
      expect(result.ok).toBe(false);
      expect((result as { reason: string }).reason).toContain("moved from ready to archived");
      // The record was NEVER patched to the target leg — the stale-state refusal happens before
      // any write, not after a write that then has to be reverted.
      expect(records.get("s1")!.runtimeKind).toBe("winter-agent");
      expect(records.get("s1")!.state).toBe("archived");
    });
  });

  test("the record vanishes entirely between plan and execute: confirmInit refuses typed rather than throwing", async () => {
    await withRs(async (_rs, records) => {
      seedRecord(records, "s1");
      const destination = registerDestination(records);
      const built = destination({ projectKey: "pk", sessionId: "be-1" }, "claude-agent");

      // No public delete door on RuntimeSessionRecords reaches this test — an OWN-property override
      // shadows the class's prototype method for one id only, which is enough to simulate "gone by
      // execute time" without a second `registerHandoffParticipants` construction (which would take
      // a FRESH plan-time snapshot and defeat the point).
      const realGet = records.get.bind(records);
      records.get = ((id: string) => (id === "s1" ? undefined : realGet(id))) as typeof records.get;

      const result = await built!.confirmInit(targetFor("s1"));
      expect(result).toEqual({ ok: false, reason: "the session record no longer exists" });
    });
  });
});
