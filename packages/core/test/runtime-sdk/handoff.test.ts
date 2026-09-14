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
import type { HandoffBarrier, HandoffOutcome, HandoffPlan, HandoffResumeTarget, RuntimeKind, RuntimeSelection, SelectionAlternative, SelectionInput, SessionKey } from "@yanlinglabs/winter-runtime-sdk";
import { modelLabelFor, planAndApplySwitch, registerHandoffParticipants, renderNoCredentialHint, type HandoffDeps } from "../../src/runtime-sdk/handoff";
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
      const barrier: HandoffBarrier = { plan: async () => { planCalled = true; return null as unknown as HandoffPlan; }, reviewSwitch: async () => ({ prompt: false }), execute: async () => null as unknown as HandoffOutcome };
      // Hoisted (not called twice): `SELECTION()` stamps `decidedAt: new Date().toISOString()` at
      // CALL time, so two separate calls can disagree by a millisecond and flake this comparison.
      const sameLegSelection = SELECTION("winter-agent");
      const out = await planAndApplySwitch(
        deps({ records, barrier, runtime: fakeRuntime({ selectRuntimeFor: freshOnlySelector(() => sameLegSelection) }) }),
        "s1", "openai/gpt-5.4", false,
      );
      // C1 (fix round 2): `decided` now rides along on an applied same-leg change.
      expect(out).toEqual({ kind: "same-runtime", decided: sameLegSelection });
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
      const barrier: HandoffBarrier = { plan: async (_session, to) => { planCalled = to; return plan; }, reviewSwitch: async () => ({ prompt: false }), execute: async () => { executeCalled = true; return { kind: "resumed", selection: SELECTION("claude-agent") }; } };
      const out = await planAndApplySwitch(
        deps({ records, barrier, runtime: fakeRuntime({ selectRuntimeFor: freshOnlySelector(() => SELECTION("claude-agent")) }) }),
        "s1", "claude-sonnet-5", false,
      );
      expect(out).toEqual({ kind: "confirmation_required", warnings: ["reasoning state does not survive a move to the official leg"], portable: [] });
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
      const barrier: HandoffBarrier = { plan: async () => { planCalled = true; return plan; }, reviewSwitch: async () => ({ prompt: false }), execute: async (p) => { executedPlan = p; return { kind: "resumed", selection: SELECTION("claude-agent") }; } };
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
      const barrier: HandoffBarrier = { plan: async () => plan, reviewSwitch: async () => ({ prompt: false }), execute: async () => { executeCalled = true; return { kind: "resumed", selection: SELECTION("claude-agent") }; } };
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
          const barrier: HandoffBarrier = { plan: async () => plan, reviewSwitch: async () => ({ prompt: false }), execute: async () => outcome };
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
      const sameLegSelection = SELECTION("winter-agent"); // hoisted — see the earlier test's own note on why
      const runtime = fakeRuntime({
        selectRuntimeFor: freshOnlySelector(() => { selectorCalled = true; return sameLegSelection; }),
      });
      const out = await planAndApplySwitch(deps({ records, runtime }), "s1", "claude-sonnet-5", false);
      // same leg as recorded — but the selector DID run; C1 (fix round 2) carries its decision along.
      expect(out).toEqual({ kind: "same-runtime", decided: sameLegSelection });
      expect(selectorCalled).toBe(true);
    });
  });
});

// Fix wave C2 (whole-branch review / ruling P8c-18); Winter Phase 10b (D1-1, W18-10, R-10b-1): the
// cross-runtime handoff fence. Every case here reaches the point where a FRESH destination decision
// genuinely differs from the recorded leg — the fence must refuse BEFORE the barrier is ever
// consulted and BEFORE anything is written. As of 10b the fence defaults ON for Code sessions (the
// real round-trip against the live barrier is now measured end to end); an explicit setting always
// overrides that default, in every mode; chat/dispatch keep the pre-10b OFF default.
describe("planAndApplySwitch: the C2 cross-runtime fence (settings.runtimes.handoff.crossRuntime)", () => {
  test("an explicit false refuses typed, no barrier call, regardless of mode defaulting ON", async () => {
    await withRs(async (_rs, records) => {
      seedRecord(records, "s1");
      let planCalled = false;
      const barrier: HandoffBarrier = { plan: async () => { planCalled = true; return null as unknown as HandoffPlan; }, reviewSwitch: async () => ({ prompt: false }), execute: async () => null as unknown as HandoffOutcome };
      const out = await planAndApplySwitch(
        deps({
          records, barrier,
          runtime: fakeRuntime({ selectRuntimeFor: freshOnlySelector(() => SELECTION("claude-agent")) }),
          store: { meta: () => ({ mode: "code", cwd: "/x" }) }, // Code would default ON — the explicit false still wins
          settings: () => ({ runtimes: { handoff: { crossRuntime: false } } }) as unknown as Settings,
        }),
        "s1", "claude-sonnet-5", false,
      );
      // Carried Minor m1 (D1 review, W18-23): reworded to name the SETTING, never a runtime. The
      // setting's own key path ("crossRuntime") is allowed to contain the substring "runtime" — it
      // is excluded from the regex check below, per the resume note's own instruction — everything
      // ELSE in the detail must not match it.
      expect(out).toEqual({ kind: "refused", code: "handoff_disabled", detail: expect.stringContaining("turned off") });
      const detail = (out as { detail: string }).detail;
      expect(detail).toContain("settings.runtimes.handoff.crossRuntime");
      expect(detail.replace("settings.runtimes.handoff.crossRuntime", "")).not.toMatch(/\bSDK\b|runtime|Claude Agent|Winter Agent/i);
      expect(planCalled).toBe(false);
    });
  });

  // m1 (whole-branch review, fix round 2): the off switch must be checked BEFORE the pre-flight
  // review/prompt for a CROSS-LEG move — checking it after let a disabled deployment see "Switch
  // model?" (a real, reviewed prompt) and then get refused typed anyway once confirmLossy resent
  // it, a prompt that lied about what confirming would do.
  test("crossRuntime: false refuses a CROSS-LEG move before the review ever runs — reviewSwitch is never called", async () => {
    await withRs(async (_rs, records) => {
      seedRecord(records, "s1"); // recorded leg: winter-agent
      let reviewCalled = false;
      const barrier: HandoffBarrier = {
        plan: async () => { throw new Error("not reached — the off switch refuses before plan()"); },
        execute: async () => { throw new Error("not reached"); },
        reviewSwitch: async () => { reviewCalled = true; return { prompt: true, classification: { lossClass: "warned-lossy", warnings: ["would have prompted"], portable: [] } }; },
      };
      const out = await planAndApplySwitch(
        deps({
          records, barrier,
          runtime: fakeRuntime({ selectRuntimeFor: freshOnlySelector(() => SELECTION("claude-agent")) }), // a genuine cross-leg move
          settings: () => ({ runtimes: { handoff: { crossRuntime: false } } }) as unknown as Settings,
        }),
        "s1", "claude-sonnet-5", false,
      );
      expect(out).toEqual({ kind: "refused", code: "handoff_disabled", detail: expect.stringContaining("turned off") });
      expect(reviewCalled).toBe(false);
    });
  });

  test("crossRuntime: false still runs the review for a SAME-LEG move (the off switch never gates those)", async () => {
    await withRs(async (_rs, records) => {
      seedRecord(records, "s1"); // recorded leg: winter-agent
      let reviewCalled = false;
      const sameLegSelection = SELECTION("winter-agent"); // hoisted — see the earlier test's own note on why
      const barrier: HandoffBarrier = {
        plan: async () => { throw new Error("not reached — a same-leg move never reaches plan()/execute()"); },
        execute: async () => { throw new Error("not reached"); },
        reviewSwitch: async () => { reviewCalled = true; return { prompt: false }; },
      };
      const out = await planAndApplySwitch(
        deps({
          records, barrier,
          runtime: fakeRuntime({ selectRuntimeFor: freshOnlySelector(() => sameLegSelection) }), // deepseek stays on Winter — same leg
          settings: () => ({ runtimes: { handoff: { crossRuntime: false } } }) as unknown as Settings,
        }),
        "s1", "deepseek-chat", false,
      );
      expect(out).toEqual({ kind: "same-runtime", decided: sameLegSelection });
      expect(reviewCalled).toBe(true);
    });
  });

  test("no runtimes block at all, Code session (an absent settings.json): the fence steps ASIDE — 10b's default-ON", async () => {
    await withRs(async (_rs, records) => {
      seedRecord(records, "s1");
      let planCalled = false;
      const plan: HandoffPlan = {
        session: { projectKey: "pk", sessionId: "be-1" }, from: "winter-agent", to: "claude-agent",
        steps: [{ step: 1, name: "lease" }],
        decorationDoor: "fallback", tempContinuity: "clone-copy",
        selection: { kind: "servable", selection: SELECTION("claude-agent"), review: { checked: true } as never },
      };
      const barrier: HandoffBarrier = { plan: async () => { planCalled = true; return plan; }, reviewSwitch: async () => ({ prompt: false }), execute: async () => ({ kind: "resumed", selection: SELECTION("claude-agent") }) };
      const out = await planAndApplySwitch(
        deps({
          records, barrier,
          runtime: fakeRuntime({ selectRuntimeFor: freshOnlySelector(() => SELECTION("claude-agent")) }),
          store: { meta: () => ({ mode: "code", cwd: "/x" }) },
          settings: () => null,
        }),
        "s1", "claude-sonnet-5", true,
      );
      expect(planCalled).toBe(true);
      expect(out).toEqual({ kind: "resumed", selection: SELECTION("claude-agent") });
    });
  });

  test("no runtimes block at all, chat or dispatch session: the fence still refuses (unaffected by 10b)", async () => {
    for (const mode of ["chat", "dispatch"] as const) {
      await withRs(async (_rs, records) => {
        seedRecord(records, "s1"); // fresh records per mode — `seedRecord` pins one backendSessionId
        let planCalled = false;
        const barrier: HandoffBarrier = { plan: async () => { planCalled = true; return null as unknown as HandoffPlan; }, reviewSwitch: async () => ({ prompt: false }), execute: async () => null as unknown as HandoffOutcome };
        const out = await planAndApplySwitch(
          deps({
            records, barrier,
            runtime: fakeRuntime({ selectRuntimeFor: freshOnlySelector(() => SELECTION("claude-agent")) }),
            store: { meta: () => ({ mode, cwd: "/x" }) },
            settings: () => null,
          }),
          "s1", "claude-sonnet-5", false,
        );
        expect(out).toEqual({ kind: "refused", code: "handoff_disabled", detail: expect.any(String) });
        expect(planCalled).toBe(false);
      });
    }
  });

  test("a hot-reload flip takes effect on the very next call — no restart, no cached decision", async () => {
    await withRs(async (_rs, records) => {
      seedRecord(records, "s1");
      let live: Settings | null = null; // absent block, Code session: defaults ON
      const barrier: HandoffBarrier = { plan: async () => ({
        session: { projectKey: "pk", sessionId: "be-1" }, from: "winter-agent", to: "claude-agent",
        steps: [{ step: 1, name: "lease" }],
        decorationDoor: "fallback", tempContinuity: "clone-copy",
        selection: { kind: "servable", selection: SELECTION("claude-agent"), review: { checked: true } as never },
      }), reviewSwitch: async () => ({ prompt: false }), execute: async () => ({ kind: "resumed", selection: SELECTION("claude-agent") }) };
      const runtime = fakeRuntime({ selectRuntimeFor: freshOnlySelector(() => SELECTION("claude-agent")) });
      const out1 = await planAndApplySwitch(
        deps({ records, barrier, runtime, store: { meta: () => ({ mode: "code", cwd: "/x" }) }, settings: () => live }),
        "s1", "claude-sonnet-5", true,
      );
      expect(out1).toEqual({ kind: "resumed", selection: SELECTION("claude-agent") });
      // Flip the SAME getter to an explicit false — no daemon restart, no new `deps` object.
      live = { runtimes: { handoff: { crossRuntime: false } } } as unknown as Settings;
      const out2 = await planAndApplySwitch(
        deps({ records, barrier, runtime, store: { meta: () => ({ mode: "code", cwd: "/x" }) }, settings: () => live }),
        "s1", "claude-sonnet-5", false,
      );
      expect(out2).toEqual({ kind: "refused", code: "handoff_disabled", detail: expect.any(String) });
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
      const barrier: HandoffBarrier = { plan: async () => { planCalled = true; return plan; }, reviewSwitch: async () => ({ prompt: false }), execute: async () => ({ kind: "resumed", selection: SELECTION("claude-agent") }) };
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
      const sameLegSelection = SELECTION("winter-agent"); // hoisted — see the earlier test's own note on why
      for (const crossRuntime of [true, false]) {
        const out = await planAndApplySwitch(
          deps({
            records,
            runtime: fakeRuntime({ selectRuntimeFor: freshOnlySelector(() => sameLegSelection) }),
            settings: () => ({ runtimes: { handoff: { crossRuntime } } }) as unknown as Settings,
          }),
          "s1", "claude-sonnet-5", false,
        );
        expect(out).toEqual({ kind: "same-runtime", decided: sameLegSelection });
      }
    });
  });
});

// Winter Phase 10b (D1-6, W18-4/W18-20/W18-21; P10b-1/2): `barrier.reviewSwitch(sessionKey,
// decided)` fires for EVERY provider/model change, BEFORE the same-runtime shortcut — a same-LEG
// family crossing (gpt -> deepseek, both on Winter) never reaches `barrier.plan()`/`execute()` at
// all, so the review has to run earlier than that to ever see it. The ROUTER decides every skip
// (same-profile/same-family/zero-source-turns); this file's fake barrier plays the router's part.
describe("planAndApplySwitch: the pre-flight review (barrier.reviewSwitch) runs before the same-runtime shortcut", () => {
  function fakeBarrierWithReview(review: { prompt: boolean; skipped?: "same-family" | "no-source-turns" | "same-profile"; classification?: { lossClass: string; warnings: string[]; portable: string[] } }, opts?: { onReviewSwitch?: (session: SessionKey, requested: RuntimeSelection) => void }): HandoffBarrier {
    return {
      plan: async () => { throw new Error("this test's scenario never reaches plan() — it settles as same-runtime before that"); },
      execute: async () => { throw new Error("not reached"); },
      reviewSwitch: async (session, requested) => {
        opts?.onReviewSwitch?.(session, requested);
        return review as never;
      },
    };
  }

  test("same-leg gpt -> deepseek WITH a prompt: confirmation_required (warnings + portable); confirmLossy applies it", async () => {
    await withRs(async (_rs, records) => {
      seedRecord(records, "s1"); // recorded leg: winter-agent (seedRecord's own SELECTION)
      const review = { prompt: true, classification: { lossClass: "warned-lossy", warnings: ["reasoning state may be lost"], portable: ["the visible conversation"] } };
      // Hoisted (called from BOTH planAndApplySwitch calls below, not re-`SELECTION()`-ed per call):
      // `SELECTION()` stamps `decidedAt` at call time, so two separate calls could disagree by a
      // millisecond and flake the `decided` comparison below.
      const sameLegSelection = SELECTION("winter-agent");
      const runtime = fakeRuntime({ selectRuntimeFor: freshOnlySelector(() => sameLegSelection) }); // deepseek stays on Winter
      const refused = await planAndApplySwitch(
        deps({ records, runtime, barrier: fakeBarrierWithReview(review) }),
        "s1", "deepseek-chat", false,
      );
      expect(refused).toEqual({ kind: "confirmation_required", warnings: ["reasoning state may be lost"], portable: ["the visible conversation"] });

      // confirmLossy: true applies it — the SAME-LEG change proceeds as an ordinary same-runtime
      // model change (barrier.plan()/execute() are never reached for a same-leg switch at all).
      const confirmed = await planAndApplySwitch(
        deps({ records, runtime, barrier: fakeBarrierWithReview(review) }),
        "s1", "deepseek-chat", true,
      );
      expect(confirmed).toEqual({ kind: "same-runtime", decided: sameLegSelection });
    });
  });

  // C1 (whole-branch review, belt-and-braces, fix round 2): an APPLIED same-leg family change
  // must leave the 8a record naming what the session ACTUALLY runs, not what it was created with
  // — `confirmInit`'s own identical patch never fires here (this path never reaches it). A cold
  // resume reads `record.selection`/`providerId`/`modelRef` directly (`session-driver.ts`'s own
  // `decideRuntime`), so asserting the record's own final state after each switch IS the same
  // guarantee a real cold resume relies on — no separate resume simulation needed.
  test("C1: GPT -> DeepSeek (same leg, confirmed) leaves the record on DeepSeek; DeepSeek -> GPT then leaves it on GPT", async () => {
    await withRs(async (_rs, records) => {
      seedRecord(records, "s1"); // persisted: winter-agent, providerId "p", modelRef "m"
      const DEEPSEEK = { ...SELECTION("winter-agent"), providerId: "deepseek", modelRef: "deepseek/deepseek-chat", family: "deepseek" };
      const GPT = { ...SELECTION("winter-agent"), providerId: "openai", modelRef: "openai/gpt-5.6-sol", family: "openai" };
      const runtime = fakeRuntime({
        selectRuntimeFor: freshOnlySelector((model) => (model === "deepseek-chat" ? DEEPSEEK : GPT)),
      });
      const barrier = fakeBarrierWithReview({ prompt: false });
      const d = deps({ records, runtime, barrier });

      const toDeepseek = await planAndApplySwitch(d, "s1", "deepseek-chat", false);
      expect(toDeepseek).toEqual({ kind: "same-runtime", decided: DEEPSEEK });
      const afterDeepseek = records.get("s1")!;
      expect(afterDeepseek.providerId).toBe("deepseek");
      expect(afterDeepseek.modelRef).toBe("deepseek/deepseek-chat");
      expect(afterDeepseek.selection).toEqual(DEEPSEEK);

      const toGpt = await planAndApplySwitch(d, "s1", "openai/gpt-5.6-sol", false);
      expect(toGpt).toEqual({ kind: "same-runtime", decided: GPT });
      const afterGpt = records.get("s1")!;
      expect(afterGpt.providerId).toBe("openai");
      expect(afterGpt.modelRef).toBe("openai/gpt-5.6-sol");
      expect(afterGpt.selection).toEqual(GPT);
      // A cold resume after this reads exactly these columns (`session-driver.ts`'s own
      // `decideRuntime`) — the record no longer names the DeepSeek switch, let alone the original
      // "p"/"m" it was created with.
      expect(afterGpt.providerId).not.toBe("deepseek");
      expect(afterGpt.modelRef).not.toBe("m");
    });
  });

  test("deepseek -> GLM (both winter, complete exposed reasoning): no prompt", async () => {
    await withRs(async (_rs, records) => {
      seedRecord(records, "s1");
      const review = { prompt: false, classification: { lossClass: "lossless-portable", warnings: [], portable: ["the visible conversation", "DeepSeek's reasoning (carried as data)"] } };
      const out = await planAndApplySwitch(
        deps({
          records,
          runtime: fakeRuntime({ selectRuntimeFor: freshOnlySelector(() => SELECTION("winter-agent")) }),
          barrier: fakeBarrierWithReview(review),
        }),
        "s1", "glm-4.6", false,
      );
      expect(out).toEqual({ kind: "same-runtime" });
    });
  });

  test("Sonnet -> Opus (same family, both official): same-runtime with no prompt, and the router's own reviewSwitch decided skipped:\"same-family\" — the daemon never computes families itself", async () => {
    await withRs(async (_rs, records) => {
      // Recorded leg is winter-agent by default (seedRecord); this session's CURRENT leg must be
      // official for a same-leg (official <-> official) comparison, so patch it there first.
      seedRecord(records, "s1");
      records.patch("s1", "ready", { runtimeKind: "claude-agent", selection: SELECTION("claude-agent") });
      let reviewedWith: RuntimeSelection | undefined;
      const review = { prompt: false, skipped: "same-family" as const };
      // Hoisted — see the earlier "hoisted" tests' own note: two separate `SELECTION()` calls can
      // disagree on `decidedAt` by a millisecond and flake this comparison.
      const officialSelection = SELECTION("claude-agent");
      const out = await planAndApplySwitch(
        deps({
          records,
          runtime: fakeRuntime({ selectRuntimeFor: freshOnlySelector(() => officialSelection) }),
          barrier: fakeBarrierWithReview(review, { onReviewSwitch: (_s, requested) => { reviewedWith = requested; } }),
        }),
        "s1", "claude-opus-5", false,
      );
      expect(out).toEqual({ kind: "same-runtime", decided: officialSelection });
      // The review DID run (proving the daemon calls it on every change, same-leg or not) and the
      // ROUTER'S OWN answer was "same-family" — the daemon never inspected `requested.family` itself
      // to reach that same conclusion.
      expect(reviewedWith).toBeDefined();
      expect(reviewedWith?.runtimeKind).toBe("claude-agent");
    });
  });

  // Fix round 1 (MINOR, P10b-2's zero-turn carve-out): a session with no backend transcript at
  // all has no source turns for the review to weigh — `sessionKeyFor` answers `undefined` for
  // exactly this record shape, and the pre-flight review is skipped entirely rather than routed
  // through the throw-handling fail-safe below (this is a KNOWN "nothing to lose" case, not an
  // unreviewable one).
  test("a session with no backendSessionId (no sessionKey): a family-crossing switch applies with NO prompt and reviewSwitch is never called", async () => {
    await withRs(async (_rs, records) => {
      records.create({
        winterSessionId: "s1", runtimeKind: "winter-agent",
        // No `backendSessionId` at all — `sessionKeyFor` returns `undefined` for this record.
        providerId: "p", modelRef: "m", backendRoot: "/x", transcriptProjectKey: "pk",
        memoryProjectKey: "pk", tempProjectKey: "pk", transcriptHealth: "clean",
        compatibilityLevel: "agent-state", conformanceCorpusVersion: "unverified",
        versionProvenance: "recorded", sdkVersion: "0.0.4", engineVersion: "0.0.4",
        providerCatalogVersion: "t", providerAdapterVersion: "t", capabilities: [],
        selection: SELECTION("winter-agent"),
      });
      records.transition("s1", "ready");
      let reviewCalled = false;
      const out = await planAndApplySwitch(
        deps({
          records,
          runtime: fakeRuntime({ selectRuntimeFor: freshOnlySelector(() => SELECTION("winter-agent")) }), // deepseek: a genuine family crossing
          barrier: {
            plan: async () => { throw new Error("not reached — no sessionKey means no barrier call at all"); },
            execute: async () => { throw new Error("not reached"); },
            reviewSwitch: async () => { reviewCalled = true; throw new Error("not reached — no sessionKey means reviewSwitch is never called"); },
          },
        }),
        "s1", "deepseek-chat", false,
      );
      expect(out).toEqual({ kind: "same-runtime" });
      expect(reviewCalled).toBe(false);
    });
  });
});

// Fix round 1 (MAJOR, controller ruling): a throw from `barrier.reviewSwitch` must never reject
// `planAndApplySwitch` (an unreviewable switch silently refused via an RPC-level INTERNAL error is
// exactly the "silent refusal" R-10b-0 forbids) — it fails safe as a PROMPT instead.
describe("planAndApplySwitch: a throwing reviewSwitch fails safe as a prompt, never a rejection", () => {
  function fakeBarrierWhoseReviewThrows(err: unknown): HandoffBarrier {
    return {
      plan: async () => { throw new Error("not reached in the refused case"); },
      execute: async () => { throw new Error("not reached in the refused case"); },
      reviewSwitch: async () => { throw err; },
    };
  }

  test("a throwing review returns confirmation_required with the generic warning — never a rejection", async () => {
    await withRs(async (_rs, records) => {
      seedRecord(records, "s1");
      const err = new Error("sidecar read failed: ECONNRESET");
      err.name = "SidecarReadError";
      const logs: string[] = [];
      let caught: unknown;
      let out: unknown;
      try {
        out = await planAndApplySwitch(
          deps({
            records,
            runtime: fakeRuntime({ selectRuntimeFor: freshOnlySelector(() => SELECTION("winter-agent")) }),
            barrier: fakeBarrierWhoseReviewThrows(err),
            log: (line) => logs.push(line),
          }),
          "s1", "deepseek-chat", false,
        );
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeUndefined(); // never a rejection
      expect(out).toEqual({
        kind: "confirmation_required",
        warnings: ["Winter couldn't check what carries over to deepseek-chat. The conversation carries over; reasoning private to the current model may not."],
        portable: [],
      });
      // Logged ONCE, naming the error CLASS only — never `.message` (which could carry payload
      // text this file's own header forbids logging, e.g. "ECONNRESET" above never appears).
      expect(logs).toHaveLength(1);
      expect(logs[0]).toContain("SidecarReadError");
      expect(logs[0]).not.toContain("ECONNRESET");
      // Never names an SDK or runtime (R-10b-4).
      expect(logs[0]).not.toMatch(/\bSDK\b|Claude Agent|Winter Agent/i);
      expect((out as { warnings: string[] }).warnings[0]).not.toMatch(/\bSDK\b|\bruntime\b|Claude Agent|Winter Agent/i);
    });
  });

  test("a throwing review, with confirmLossy: true, applies the switch instead of prompting", async () => {
    await withRs(async (_rs, records) => {
      seedRecord(records, "s1");
      // Hoisted — see the earlier "hoisted" tests' own note: two separate `SELECTION()` calls can
      // disagree on `decidedAt` by a millisecond and flake this comparison.
      const sameLegSelection = SELECTION("winter-agent");
      const out = await planAndApplySwitch(
        deps({
          records,
          runtime: fakeRuntime({ selectRuntimeFor: freshOnlySelector(() => sameLegSelection) }),
          barrier: fakeBarrierWhoseReviewThrows(new Error("transient store error")),
        }),
        "s1", "deepseek-chat", true,
      );
      // A same-leg change proceeds as an ordinary same-runtime model change once "confirmed" —
      // barrier.plan()/execute() are never reached for a same-leg switch at all.
      expect(out).toEqual({ kind: "same-runtime", decided: sameLegSelection });
    });
  });

  test("a non-Error throw is still handled — the error class falls back to \"unknown\", never propagated raw", async () => {
    await withRs(async (_rs, records) => {
      seedRecord(records, "s1");
      const logs: string[] = [];
      const out = await planAndApplySwitch(
        deps({
          records,
          runtime: fakeRuntime({ selectRuntimeFor: freshOnlySelector(() => SELECTION("winter-agent")) }),
          barrier: fakeBarrierWhoseReviewThrows("a bare string throw"),
          log: (line) => logs.push(line),
        }),
        "s1", "deepseek-chat", false,
      );
      expect(out.kind).toBe("confirmation_required");
      expect(logs[0]).toContain("unknown");
      expect(logs[0]).not.toContain("a bare string throw");
    });
  });
});

// m5 (whole-branch review, fix round 2): the copy naming "the model this switch is about" must
// never show a raw, possibly-empty value — `session.setModel({model: null})` (resetting to the
// session's default) is intercepted by `planAndApplySwitch`'s own early return before either
// warning site that uses this helper is ever reached (see `modelLabelFor`'s own doc comment for
// why the guard exists anyway: a future refactor, or a caller passing `""` for the same "no
// override" intent, must still render something readable).
describe("modelLabelFor", () => {
  test("an ordinary model string passes through unchanged", () => {
    expect(modelLabelFor("claude-sonnet-5")).toBe("claude-sonnet-5");
  });

  test("an empty string renders as \"the default model\", never a blank or a literal null", () => {
    expect(modelLabelFor("")).toBe("the default model");
  });
});

// Winter Phase 10b (D1-7, W18-3): the no-credential hint — built FROM the router's own
// `alternatives`, never a hardcoded provider list.
describe("renderNoCredentialHint", () => {
  const NEVER_NAMES_SDK_OR_RUNTIME = /\bSDK\b|runtime|Claude Agent|Winter Agent/i;

  test("every alternative is listed, with winter login --anthropic-key, winter login --anthropic-console and the Providers settings", () => {
    const alternatives: SelectionAlternative[] = [
      { providerId: "anthropic", authKind: "api-key", label: "Anthropic API key" },
      { providerId: "anthropic", authKind: "console-profile", label: "Anthropic Console login" },
      { providerId: "openrouter", authKind: "api-key", label: "OpenRouter" },
      { providerId: "bedrock", authKind: "cloud-credential-chain", label: "Amazon Bedrock" },
      { providerId: "vertex", authKind: "cloud-credential-chain", label: "Google Vertex AI" },
    ];
    const hint = renderNoCredentialHint(alternatives, { subscriptionEnabled: false });
    expect(hint).toContain("winter login --anthropic-key");
    expect(hint).toContain("winter login --anthropic-console");
    expect(hint).toContain("Providers settings");
    expect(hint).toContain("Anthropic API key");
    expect(hint).toContain("Anthropic Console login");
    expect(hint).toContain("OpenRouter");
    expect(hint).toContain("Amazon Bedrock");
    expect(hint).toContain("Google Vertex AI");
  });

  test("the claude.ai subscription alternative appears ONLY when subscriptionEnabled is true", () => {
    const alternatives: SelectionAlternative[] = [
      { providerId: "anthropic", authKind: "api-key", label: "Anthropic API key" },
      { providerId: "anthropic", authKind: "claude-oauth", label: "claude.ai subscription" },
    ];
    const disabled = renderNoCredentialHint(alternatives, { subscriptionEnabled: false });
    expect(disabled).not.toContain("claude.ai subscription");
    const enabled = renderNoCredentialHint(alternatives, { subscriptionEnabled: true });
    expect(enabled).toContain("claude.ai subscription");
  });

  test("never matches /\\bSDK\\b|runtime|Claude Agent|Winter Agent/i, with every door present", () => {
    const alternatives: SelectionAlternative[] = [
      { providerId: "anthropic", authKind: "api-key", label: "Anthropic API key" },
      { providerId: "anthropic", authKind: "console-profile", label: "Anthropic Console login" },
      { providerId: "anthropic", authKind: "claude-oauth", label: "claude.ai subscription" },
      { providerId: "openrouter", authKind: "api-key", label: "OpenRouter" },
      { providerId: "bedrock", authKind: "cloud-credential-chain", label: "Amazon Bedrock" },
      { providerId: "vertex", authKind: "cloud-credential-chain", label: "Google Vertex AI" },
    ];
    for (const subscriptionEnabled of [true, false]) {
      const hint = renderNoCredentialHint(alternatives, { subscriptionEnabled });
      expect(hint).not.toMatch(NEVER_NAMES_SDK_OR_RUNTIME);
    }
  });

  test("an empty alternatives list still names the Providers settings, never a blank hint", () => {
    const hint = renderNoCredentialHint([], { subscriptionEnabled: false });
    expect(hint.length).toBeGreaterThan(0);
    expect(hint).toContain("Providers settings");
    expect(hint).not.toMatch(NEVER_NAMES_SDK_OR_RUNTIME);
  });
});

// Winter Phase 10b (D1-7, W18-3): end to end through `planAndApplySwitch` — the SAME hint reaches
// the refusal's `detail`, folded onto the router's own `decided.detail`.
describe("planAndApplySwitch: the no-credential refusal carries the hint", () => {
  test("a no-credential SelectionRefusal's alternatives are rendered into the refusal detail", async () => {
    await withRs(async (_rs, records) => {
      seedRecord(records, "s1");
      const alternatives: SelectionAlternative[] = [
        { providerId: "anthropic", authKind: "api-key", label: "Anthropic API key" },
        { providerId: "anthropic", authKind: "console-profile", label: "Anthropic Console login" },
      ];
      const out = await planAndApplySwitch(
        deps({
          records,
          runtime: fakeRuntime({
            selectRuntimeFor: async () => ({ refused: true, reason: "no-credential", detail: "no door can serve claude-opus-5", alternatives }),
          }),
        }),
        "s1", "claude-opus-5", false,
      );
      expect(out.kind).toBe("refused");
      const detail = (out as { detail: string }).detail;
      expect(detail).toContain("no door can serve claude-opus-5");
      expect(detail).toContain("winter login --anthropic-key");
      expect(detail).toContain("winter login --anthropic-console");
    });
  });

  test("a refusal with no `no-credential` reason is untouched — no hint appended", async () => {
    await withRs(async (_rs, records) => {
      seedRecord(records, "s1");
      const out = await planAndApplySwitch(
        deps({
          records,
          runtime: fakeRuntime({
            selectRuntimeFor: async () => ({ refused: true, reason: "mode-forbids-runtime", detail: "chat/dispatch never route to the official leg" }),
          }),
        }),
        "s1", "claude-opus-5", false,
      );
      expect(out).toEqual({ kind: "refused", code: "runtime_selection_refused", detail: "chat/dispatch never route to the official leg" });
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

  /** Unlike `fakeWinter`, `ensure` actually resolves — needed for the tests in this block that drive
   *  `confirmInit` past its own `ensure()` call. P10a-h: `confirmInit` now also awaits
   *  `awaitDestinationInit` (`session.init`/`session.done`), so the resolved driver must be a
   *  genuine (if minimal) `LegSession` shape — an already-inited one by default (`init: { tools: [] }`,
   *  `done` a promise that never settles, exactly like a healthy long-running session), or the
   *  "exited before init" shape a caller opts into via `opts.diesBeforeInit`. */
  function fakeWinterThatOpens(opts?: { diesBeforeInit?: boolean }): WinterSessionDrivers {
    const never = (): never => { throw new Error("not reached by this test"); };
    const session: LegSession = {
      sessionId: "s1", backendSessionId: "be-1-new", mode: "code", state: "live", generation: 1, resumed: true,
      init: opts?.diesBeforeInit === true ? undefined : { tools: [] },
      turnRunning: false, turnStartedAt: undefined,
      done: opts?.diesBeforeInit === true ? Promise.resolve() : new Promise<void>(() => { /* never settles — a healthy session */ }),
      pendingSends: [], heldDeliveries: [],
      send: never, steer: never, interrupt: never, compact: never, setModel: never, setPolicy: never,
      end: never, deliver: never, open: never, idle: never,
    };
    return {
      legForNewSession: () => "winter", legOf: never, assertAvailable: () => {},
      create: never, get: () => undefined, runTurn: never,
      ensure: async () => session,
      evict: async () => {}, list: () => [], endAll: never,
    };
  }

  /**
   * Winter Phase 10b (D1-2, W18-6): unlike `fakeWinterThatOpens` above (a bare function that hands
   * back a NEW driver object on every `ensure()` call, with no memory of what it already handed
   * out), this fake models the REAL driver table's own caching contract (`session-driver.ts`'s
   * `ensure`: "the live driver, if any" — a registered entry is returned AS-IS, never re-consulted
   * against the record) closely enough to prove the eviction fix: a destination attempt that dies
   * before init registers a dead entry, and only an actual `evict()` call removes it. Without D1-2's
   * fix, that dead entry would still answer the very next `ensure(winterSessionId)` — the measured
   * "exited before init" repeat this lane closes.
   */
  function fakeWinterTable(opts: { diesBeforeInit?: boolean }): WinterSessionDrivers & { evictCalls: string[] } {
    const never = (): never => { throw new Error("not reached by this test"); };
    const drivers = new Map<string, LegSession>();
    const evictCalls: string[] = [];
    let ensureCount = 0;
    const makeSession = (): LegSession => ({
      sessionId: "s1", backendSessionId: `be-1-new-${++ensureCount}`, mode: "code", state: "live", generation: ensureCount, resumed: true,
      init: opts.diesBeforeInit === true ? undefined : { tools: [] },
      turnRunning: false, turnStartedAt: undefined,
      done: opts.diesBeforeInit === true ? Promise.resolve() : new Promise<void>(() => { /* never settles */ }),
      pendingSends: [], heldDeliveries: [],
      send: never, steer: never, interrupt: never, compact: never, setModel: never, setPolicy: never,
      end: never, deliver: never, open: never, idle: never,
    });
    return {
      legForNewSession: () => "winter", legOf: never, assertAvailable: () => {},
      create: never,
      get: (id) => drivers.get(id),
      runTurn: never,
      ensure: async (id) => {
        const live = drivers.get(id);
        if (live !== undefined) return live;
        const fresh = makeSession();
        drivers.set(id, fresh);
        return fresh;
      },
      evict: async (id) => { evictCalls.push(id); drivers.delete(id); },
      list: () => [...drivers.values()],
      endAll: never,
      evictCalls,
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

  // Winter Phase 10b (D1-2, W18-7): a successful handoff must not leave the record still naming
  // the SOURCE's provider/model/credential — `seedRecord`'s own SELECTION is `providerId: "p"`,
  // `modelRef: "m"`, no `authRef`, so a destination selection naming a REAL inventory provider
  // (`openai`) proves both that the columns move AND that the credential locator is derived fresh,
  // never carried over from the source.
  test("W18-7: confirmInit patches providerId, modelRef and authRef from the DESTINATION selection", async () => {
    await withRs(async (_rs, records) => {
      seedRecord(records, "s1"); // providerId: "p", modelRef: "m", no authRef
      const destination = registerDestination(records, fakeWinterThatOpens());
      const built = destination({ projectKey: "pk", sessionId: "be-1" }, "winter-agent");
      const destinationSelection = { ...SELECTION("winter-agent"), providerId: "openai", modelRef: "gpt-5.6-sol" };
      const result = await built!.confirmInit({ backendSessionId: "be-1-new", selection: destinationSelection } as unknown as HandoffResumeTarget);
      expect(result).toMatchObject({ ok: true });
      const record = records.get("s1")!;
      expect(record.providerId).toBe("openai");
      expect(record.modelRef).toBe("gpt-5.6-sol");
      expect(record.authRef).toBe("keychain:openai:default");
    });
  });

  test("W18-7: a destination provider with no keychain slot CLEARS a stale authRef rather than carrying the source's", async () => {
    await withRs(async (_rs, records) => {
      seedRecord(records, "s1");
      records.patch("s1", "ready", { authRef: "keychain:openai:default" }); // the SOURCE had one
      const destination = registerDestination(records, fakeWinterThatOpens());
      const built = destination({ projectKey: "pk", sessionId: "be-1" }, "winter-agent");
      // "custom" (BYO endpoint) has no row in WINTER_CREDENTIAL_INVENTORY at all.
      const destinationSelection = { ...SELECTION("winter-agent"), providerId: "custom", modelRef: "byo-model" };
      const result = await built!.confirmInit({ backendSessionId: "be-1-new", selection: destinationSelection } as unknown as HandoffResumeTarget);
      expect(result).toMatchObject({ ok: true });
      expect(records.get("s1")!.authRef).toBeUndefined();
    });
  });

  // Winter Phase 10b (D1-6, W18-4): "a second `setModel` while one is deferred never falls back to
  // the persisted [selection]" — the P8c-era bug this guards was `pendingHandoffModel`'s own SHARED
  // map: a second overlapping deferred call's `.set()` clobbered the first's `{model, selection}`
  // entry, so when the FIRST plan's `confirmInit` finally ran it silently fell back to
  // `target.selection`, which pre-10b was ALWAYS the stale D13-stamped SOURCE selection ("a handoff
  // moves the runtime, not the model"). As of 10b `target.selection` is no longer read from any
  // shared map at all — it is `plan.selection.selection`, threaded straight from THIS plan's own
  // `requested: decided` (W18-4) — so this test drives `confirmInit` with NOTHING in the model-string
  // map for this session (exactly what a second, overlapping `setModel` would have left: cleared or
  // pointing at a DIFFERENT model), and proves the destination selection used is still the ONE this
  // specific plan/target carries, never a fallback to anything "persisted".
  test("W18-4: confirmInit uses target.selection even with no matching pending-model entry (a second overlapping setModel could have cleared it) — never a persisted fallback", async () => {
    await withRs(async (_rs, records) => {
      seedRecord(records, "s1"); // persisted/SOURCE selection: providerId "p", modelRef "m" (winter-agent)
      const destination = registerDestination(records, fakeWinterThatOpens());
      const built = destination({ projectKey: "pk", sessionId: "be-1" }, "claude-agent");
      // THIS plan's own fresh destination — deliberately named nothing like the persisted "p"/"m",
      // so a silent fallback to the persisted selection would be caught immediately.
      const thisPlansDestination = { ...SELECTION("claude-agent"), providerId: "anthropic", modelRef: "claude-opus-5" };
      const result = await built!.confirmInit({ backendSessionId: "be-1-new", selection: thisPlansDestination } as unknown as HandoffResumeTarget);
      expect(result).toMatchObject({ ok: true });
      const record = records.get("s1")!;
      expect(record.providerId).toBe("anthropic");
      expect(record.modelRef).toBe("claude-opus-5");
      // NOT the persisted/source values a fallback-to-`target.selection`-being-stale bug would leave.
      expect(record.providerId).not.toBe("p");
      expect(record.modelRef).not.toBe("m");
    });
  });

  // m2 (whole-branch review, fix round 2): the RAW as-typed model string `confirmInit` commits to
  // `store.meta(id).model` BEFORE the destination spawns (P10a-h) used to be keyed by `sessionId`
  // alone in `pendingHandoffModelString` — a SECOND, overlapping deferred `session.setModel` for
  // the SAME session (a turn still running when both are issued) clobbered the first call's entry
  // before either one's `confirmInit` ever read it, so BOTH committed the LATER call's raw string.
  // Keyed by `(sessionId, decided.modelRef)` as of this fix — two DIFFERENT destination models
  // never share a slot. Drives the REAL registered `destination` participant (never the module's
  // private map directly, which nothing outside this file can reach) for two overlapping deferred
  // plans on the SAME session, and reads each plan's own pre-spawn commit off a store spy.
  test("m2: two deferred cross-leg setModel calls racing the same running turn each commit their OWN raw model string", async () => {
    await withRs(async (_rs, records) => {
      seedRecord(records, "s1"); // persisted: winter-agent, providerId "p", modelRef "m"
      const SELECTION_SONNET = { ...SELECTION("claude-agent"), providerId: "anthropic", modelRef: "anthropic/claude-sonnet-5" };
      const SELECTION_OPUS = { ...SELECTION("claude-agent"), providerId: "anthropic", modelRef: "anthropic/claude-opus-5" };
      const runtime = fakeRuntime({
        selectRuntimeFor: freshOnlySelector((model) => (model === "claude-sonnet-5" ? SELECTION_SONNET : SELECTION_OPUS)),
      });
      const never = (): never => { throw new Error("not reached by this test"); };
      // Never resolves — both calls stay deferred for this test's whole life, exactly the window
      // during which the pre-fix bug let the second `.set()` clobber the first's entry.
      const idlePromise = new Promise<void>(() => { /* intentionally never settles */ });
      const live: LegSession = {
        sessionId: "s1", backendSessionId: "be-1", mode: "code", state: "live", generation: 1, resumed: true,
        init: undefined, turnRunning: true, turnStartedAt: Date.now(), done: Promise.resolve(),
        pendingSends: [], heldDeliveries: [],
        send: never, steer: never, interrupt: never, compact: never, setModel: never, setPolicy: never,
        end: never, deliver: never, open: never, idle: () => idlePromise,
      };
      const barrier: HandoffBarrier = {
        plan: async (session, to, opts) => ({
          session, from: "winter-agent", to,
          steps: [{ step: 1, name: "lease" }],
          decorationDoor: "fallback", tempContinuity: "clone-copy",
          selection: { kind: "servable", selection: opts!.requested!, review: { checked: true } as never },
          requested: opts?.requested,
        }),
        execute: async () => { throw new Error("not reached — this half only exercises planAndApplySwitch's own .set(), never barrier.execute()"); },
        reviewSwitch: async () => ({ prompt: false }),
      };
      const d = deps({ records, barrier, runtime, winter: fakeWinter({ live }) });

      // Call A defers, leaving ITS OWN pending entry set. Call B is a SECOND, overlapping deferred
      // call for the SAME session, issued before A's own confirmInit ever runs (idle() never
      // resolves here) — exactly the pre-fix collision window.
      expect(await planAndApplySwitch(d, "s1", "claude-sonnet-5", true)).toEqual({ kind: "deferred" });
      expect(await planAndApplySwitch(d, "s1", "claude-opus-5", true)).toEqual({ kind: "deferred" });

      // Read each plan's own pending entry through the REAL registered destination participant.
      // Both confirmInit attempts die before init (never patching the record's backendSessionId),
      // so BOTH can address the SAME original session key — a real race has both calls starting
      // from the identical pre-handoff sessionKey too.
      const committed: Array<{ sessionId: string; model: string | null }> = [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let registered: any;
      registerHandoffParticipants({
        ...d,
        runtime: { ...runtime, registerHandoffParticipants: (p) => { registered = p; } },
        winter: fakeWinterThatOpens({ diesBeforeInit: true }),
        store: { meta: () => ({ mode: "code", cwd: "/x" }), setModel: (sessionId, model) => { committed.push({ sessionId, model }); } },
      });
      const destination = registered.destination as (
        session: { projectKey: string; sessionId: string }, to: RuntimeKind,
      ) => { confirmInit(target: HandoffResumeTarget): Promise<{ ok: boolean }> } | undefined;

      const builtA = destination({ projectKey: "pk", sessionId: "be-1" }, "claude-agent");
      await builtA!.confirmInit({ backendSessionId: "be-1-new-a", selection: SELECTION_SONNET } as unknown as HandoffResumeTarget);
      const builtB = destination({ projectKey: "pk", sessionId: "be-1" }, "claude-agent");
      await builtB!.confirmInit({ backendSessionId: "be-1-new-b", selection: SELECTION_OPUS } as unknown as HandoffResumeTarget);

      // Each commits the raw string ITS OWN plan set — never the other's (the pre-m2 bug: a bare
      // sessionId key meant the SECOND .set() clobbered the first, so BOTH would show "claude-opus-5").
      expect(committed).toContainEqual({ sessionId: "s1", model: "claude-sonnet-5" });
      expect(committed).toContainEqual({ sessionId: "s1", model: "claude-opus-5" });
    });
  });

  // P10a-h (measured live 2026-09-13): `ensure()` resolving used to be treated as success even
  // though `open()` returns before the destination's first frame ever arrives — the destination
  // child can exit "before init" milliseconds later, and the handoff had already been reported
  // `applied`. `confirmInit` now awaits `awaitDestinationInit`; a driver whose `init` never becomes
  // defined before its `done` settles is a typed refusal, and the record reverts to what it was.
  test("P10a-h: the destination child exits before init — confirmInit refuses typed and reverts the record", async () => {
    await withRs(async (_rs, records) => {
      seedRecord(records, "s1"); // ready, recorded as winter-agent (seedRecord's own SELECTION)
      const destination = registerDestination(records, fakeWinterThatOpens({ diesBeforeInit: true }));
      const built = destination({ projectKey: "pk", sessionId: "be-1" }, "claude-agent");
      const result = await built!.confirmInit(targetFor("s1"));
      expect(result.ok).toBe(false);
      expect((result as { reason: string }).reason).toContain("exited before it reached init");
      // Reverted: the record still names the SOURCE leg/selection/backend id — a refusal here keeps
      // the source owner (the barrier's own contract), which only holds if the record still agrees.
      const record = records.get("s1")!;
      expect(record.runtimeKind).toBe("winter-agent");
      expect(record.backendSessionId).toBe("be-1");
      // W18-7: the revert restores providerId/modelRef too — `seedRecord`'s own SELECTION.
      expect(record.providerId).toBe("p");
      expect(record.modelRef).toBe("m");
    });
  });

  // Winter Phase 10b (D1-2, W18-6): the destination driver `confirmInit`'s own retry loop
  // registered must be gone by the time this function returns its refusal — otherwise the very
  // next `ensure(winterSessionId)` (session.send's own resume path) would hand back that same dead
  // entry instead of re-assembling the (reverted) SOURCE leg, reproducing the measured "exited
  // before init" / `process_death` defect this lane fixes.
  test("W18-6: confirmInit evicts the destination driver it created BEFORE reverting — no stale dead driver survives", async () => {
    await withRs(async (_rs, records) => {
      seedRecord(records, "s1"); // ready, recorded as winter-agent (seedRecord's own SELECTION)
      const winter = fakeWinterTable({ diesBeforeInit: true });
      const destination = registerDestination(records, winter);
      const built = destination({ projectKey: "pk", sessionId: "be-1" }, "claude-agent");
      const result = await built!.confirmInit(targetFor("s1"));
      expect(result.ok).toBe(false);
      // The dead destination attempt's own driver-table entry is gone — not merely reverted.
      expect(winter.get("s1")).toBeUndefined();
      expect(winter.evictCalls.length).toBeGreaterThan(0);
      expect(winter.evictCalls.at(-1)).toBe("s1");
      // The record itself reverted too (belt-and-suspenders with the test above).
      expect(records.get("s1")!.runtimeKind).toBe("winter-agent");
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
