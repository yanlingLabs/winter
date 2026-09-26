// Winter Phase 8c (Task 4.1, WS-13 §8.2), cut down by WS-23: `planAndApplySwitch`'s decision
// matrix, against a FAKE reviewer (test seam — `runtimeSdkInternals` only resolves a REAL router-built
// handle, so this file never constructs one). No real winter binary; the RPC-level wiring
// (`session.setModel`'s case) is proved separately.
//
// WS-23: the official `claude` leg is retired, so no switch crosses runtimes — the cross-runtime half
// of this file (the handoff barrier's plan/execute, the deferred execution, `confirmInit`, the
// zero-turn re-selection, the `crossRuntime` fence) went with the code it tested. What stays is the
// pre-flight review and the same-runtime record patch, plus the two WS-23 additions: a record the
// retired leg wrote is adopted onto the Winter leg first, and `crossRuntime` is inert.
//
// Fix wave (M1): `planAndApplySwitch` reads the REAL pinned catalog (`rowForTag`, never faked) for
// its own bail-out #4 — so every case below that means to REACH the fake selector uses a real catalog
// row ("anthropic/claude-sonnet-5", "deepseek/deepseek-v4-pro"), never a fictional string.
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeDirectoryEntry, RuntimeSelection, SelectionAlternative, SessionKey } from "@yanlinglabs/winter-runtime-sdk";
import { modelLabelFor, planAndApplySwitch, renderNoCredentialHint, type HandoffDeps, type SwitchReviewer } from "../../src/runtime-sdk/handoff";
import { openRuntimeStateDb, RuntimeSessionRecords } from "../../src/runtime-state";
import type { WinterRuntimeSdk } from "../../src/runtime-sdk/create";
import { WinterLegRefusal, type LegSession, type WinterSessionDrivers } from "../../src/runtime-sdk/session-driver";
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

function seedRecord(records: RuntimeSessionRecords, sessionId: string, runtimeKind: "winter-agent" | "claude-agent" = "winter-agent"): void {
  records.create({
    winterSessionId: sessionId, runtimeKind, backendSessionId: "be-1",
    providerId: "p", modelRef: "m", backendRoot: "/x", transcriptProjectKey: "pk",
    memoryProjectKey: "pk", tempProjectKey: "pk", transcriptHealth: "clean",
    compatibilityLevel: "agent-state", conformanceCorpusVersion: "unverified",
    versionProvenance: "recorded", sdkVersion: "0.0.4", engineVersion: "0.0.4",
    providerCatalogVersion: "t", providerAdapterVersion: "t", capabilities: [],
    selection: SELECTION(runtimeKind),
  });
  records.transition(sessionId, "ready");
}

/**
 * Fix round 3 (item 1a): the runtime-directory facet `materializeDirectoryRow` writes through
 * (`runtime.sdk.directory.record`, the SAME door `messaging.ts`'s attach uses). An in-memory stand-in
 * for the real SQLite-backed store: a test that supplies one is a daemon that CAN rebuild a missing
 * row, and a test that omits it is one that cannot — the two branches item 1a and 1b split on.
 */
function fakeDirectory(): { facet: { record: (e: RuntimeDirectoryEntry) => Promise<void>; get: (a: string) => Promise<RuntimeDirectoryEntry | undefined> }; rows: RuntimeDirectoryEntry[] } {
  const rows: RuntimeDirectoryEntry[] = [];
  return {
    rows,
    facet: {
      record: async (entry) => {
        const at = rows.findIndex((r) => r.address === entry.address);
        if (at >= 0) rows[at] = entry; else rows.push(entry);
      },
      get: async (address) => rows.find((r) => r.address === address),
    },
  };
}

function fakeRuntime(opts: {
  selectRuntimeFor: WinterRuntimeSdk["selectRuntimeFor"];
  directory?: ReturnType<typeof fakeDirectory>["facet"];
}): WinterRuntimeSdk {
  const never = (): never => { throw new Error("not reached by this test"); };
  return {
    // The reviewer itself is injected directly (`HandoffDeps.barrier`); `directory` is the ONE part
    // of the router handle `planAndApplySwitch` reaches through `.sdk`, and only to materialize a
    // missing runtime-directory row. Absent (the default) = a daemon with no directory facet.
    sdk: (opts.directory === undefined ? {} : { directory: opts.directory }) as WinterRuntimeSdk["sdk"],
    spawnHookFor: never,
    selectRuntimeFor: opts.selectRuntimeFor,
    trackQuery: never, untrack: never,
    messaging: { releaseHeld: never },
    dispose: never,
  };
}

/**
 * Distinguishes a FRESH selection call (no `persisted`) from a review of the PERSISTED one: the
 * router's persisted-wins rule would echo the session's CURRENT row back, so the destination must be
 * decided fresh. Throws if `input.persisted` is set — a call shaped that way must never reach this fake.
 */
function freshOnlySelector(forModel: (model: string | undefined) => RuntimeSelection | { refused: true; reason: "runtime-unavailable"; detail: string }): WinterRuntimeSdk["selectRuntimeFor"] {
  return async (input) => {
    if (input.persisted !== undefined) throw new Error("planAndApplySwitch must decide the destination FRESH — it must never pass `persisted` to selectRuntimeFor");
    return forModel(input.model);
  };
}

function fakeWinter(opts: { live?: LegSession; adoptLegacyRecord?: WinterSessionDrivers["adoptLegacyRecord"] }): WinterSessionDrivers {
  const never = (): never => { throw new Error("not reached by this test"); };
  return {
    legForNewSession: () => "winter", legOf: never, assertAvailable: () => {},
    create: never, get: () => opts.live, runTurn: never, ensure: never,
    evict: async () => {}, list: () => [], endAll: never,
    ...(opts.adoptLegacyRecord === undefined ? {} : { adoptLegacyRecord: opts.adoptLegacyRecord }),
  };
}

function deps(overrides: Partial<HandoffDeps>): HandoffDeps {
  return {
    runtime: fakeRuntime({ selectRuntimeFor: freshOnlySelector(() => SELECTION("winter-agent")) }),
    winter: fakeWinter({}),
    records: {} as RuntimeSessionRecords,
    store: { meta: () => ({ mode: "code", cwd: "/x" }) },
    settings: () => null,
    ...overrides,
  };
}

function fakeReviewer(review: { prompt: boolean; skipped?: "same-family" | "no-source-turns" | "same-profile"; classification?: { lossClass: string; warnings: string[]; portable: string[] } }, opts?: { onReviewSwitch?: (session: SessionKey, requested: RuntimeSelection) => void }): SwitchReviewer {
  return {
    reviewSwitch: async (session, requested) => {
      opts?.onReviewSwitch?.(session, requested);
      return review as never;
    },
  };
}

describe("planAndApplySwitch", () => {
  test("model: null never triggers a decision", async () => {
    const out = await planAndApplySwitch(deps({}), "s1", null, false);
    expect(out).toEqual({ kind: "same-runtime" });
  });

  test("no runtime record: same-runtime (nothing to switch FROM)", async () => {
    await withRs(async (_rs, records) => {
      const out = await planAndApplySwitch(deps({ records }), "s-nope", "anthropic/claude-sonnet-5", false);
      expect(out).toEqual({ kind: "same-runtime" });
    });
  });

  test("the router refuses the selection: typed refusal, in the daemon's own words", async () => {
    await withRs(async (_rs, records) => {
      seedRecord(records, "s1");
      const out = await planAndApplySwitch(
        deps({ records, runtime: fakeRuntime({ selectRuntimeFor: freshOnlySelector(() => ({ refused: true, reason: "runtime-unavailable", detail: "no claude executable" })) }) }),
        "s1", "anthropic/claude-sonnet-5", false,
      );
      // Fix round 4 (item 5): the ROUTER's own detail never reaches the user.
      expect(out).toEqual({ kind: "refused", code: "runtime_selection_refused", detail: "Winter can't switch to anthropic/claude-sonnet-5 right now." });
    });
  });

  // WS-23: the router is told there is no official runtime, so it never answers `claude-agent`. An
  // answer naming it anyway is a router this daemon cannot serve: refused, never recorded.
  test("WS-23: a selection naming the retired official runtime is refused typed and the record is untouched", async () => {
    await withRs(async (_rs, records) => {
      seedRecord(records, "s1");
      const logs: string[] = [];
      const out = await planAndApplySwitch(
        deps({ records, log: (l) => logs.push(l), runtime: fakeRuntime({ selectRuntimeFor: freshOnlySelector(() => SELECTION("claude-agent")) }) }),
        "s1", "anthropic/claude-sonnet-5", true,
      );
      expect(out).toEqual({ kind: "refused", code: "runtime_selection_refused", detail: "Winter can't switch to anthropic/claude-sonnet-5 right now." });
      expect(records.get("s1")!.runtimeKind).toBe("winter-agent");
      expect(records.get("s1")!.selection.runtimeKind).toBe("winter-agent");
      expect(logs.some((l) => l.includes("claude-agent"))).toBe(true);
    });
  });

  // Fix wave M1: mirrors `session-driver.ts`'s `decideRuntime` bail-out #4.
  test("M1: a model with no row in the real catalog at all bails to same-runtime BEFORE the selector runs", async () => {
    await withRs(async (_rs, records) => {
      seedRecord(records, "s1");
      let selectorCalled = false;
      const runtime = fakeRuntime({
        selectRuntimeFor: async () => { selectorCalled = true; return SELECTION("winter-agent"); },
      });
      const out = await planAndApplySwitch(deps({ records, runtime }), "s1", "my-custom-finetune-id-nobody-published", false);
      expect(out).toEqual({ kind: "same-runtime" });
      expect(selectorCalled).toBe(false);
    });
  });

  test("M1: a CATALOG-KNOWN Claude model does NOT bail out — the selector runs and the Winter selection rides out", async () => {
    await withRs(async (_rs, records) => {
      seedRecord(records, "s1");
      let selectorCalled = false;
      // Hoisted: `SELECTION()` stamps `decidedAt` at call time, so two calls could disagree by a ms.
      const decided = { ...SELECTION("winter-agent"), providerId: "anthropic", modelRef: "anthropic/claude-sonnet-5", family: "claude" };
      const runtime = fakeRuntime({ selectRuntimeFor: freshOnlySelector(() => { selectorCalled = true; return decided; }) });
      const out = await planAndApplySwitch(deps({ records, runtime }), "s1", "anthropic/claude-sonnet-5", false);
      expect(out).toEqual({ kind: "same-runtime", decided });
      expect(selectorCalled).toBe(true);
      expect(records.get("s1")!.providerId).toBe("anthropic");
    });
  });
});

// WS-23: `runtimes.handoff.crossRuntime` fenced the cross-runtime move. It is still accepted in a
// settings file (reported inert by `retiredRuntimeSettingKeys`) and read by nothing here.
describe("WS-23: runtimes.handoff.crossRuntime is inert", () => {
  for (const crossRuntime of [false, true]) {
    test(`crossRuntime: ${crossRuntime} changes nothing — the review runs and the switch applies`, async () => {
      await withRs(async (_rs, records) => {
        seedRecord(records, "s1");
        let reviewed = false;
        const decided = { ...SELECTION("winter-agent"), providerId: "anthropic", modelRef: "anthropic/claude-sonnet-5" };
        const out = await planAndApplySwitch(
          deps({
            records,
            settings: () => ({ runtimes: { handoff: { crossRuntime } } }) as unknown as Settings,
            runtime: fakeRuntime({ selectRuntimeFor: freshOnlySelector(() => decided) }),
            barrier: fakeReviewer({ prompt: false }, { onReviewSwitch: () => { reviewed = true; } }),
          }),
          "s1", "anthropic/claude-sonnet-5", false,
        );
        expect(out).toEqual({ kind: "same-runtime", decided });
        expect(reviewed).toBe(true);
      });
    });
  }
});

// WS-23 (ruling R2): a session the retired official leg created is adopted onto the Winter leg
// BEFORE the switch is decided — the same step its next resume takes — or the switch is refused with
// the adoption's own typed refusal and nothing written.
describe("WS-23: a legacy claude-agent record is adopted before the switch", () => {
  test("the record is adopted first, then reviewed and patched — and the 1c invariant holds (runtimeKind winter-agent)", async () => {
    await withRs(async (_rs, records) => {
      seedRecord(records, "s1", "claude-agent");
      const adopted: string[] = [];
      const adopt: WinterSessionDrivers["adoptLegacyRecord"] = (sessionId) => {
        adopted.push(sessionId);
        const current = records.get(sessionId)!;
        records.patch(sessionId, current.state, { runtimeKind: "winter-agent", selection: { ...current.selection, runtimeKind: "winter-agent" } });
        return records.get(sessionId);
      };
      const decided = { ...SELECTION("winter-agent"), providerId: "openai", modelRef: "openai/gpt-5.6-sol", family: "gpt" };
      const out = await planAndApplySwitch(
        deps({
          records,
          winter: fakeWinter({ adoptLegacyRecord: adopt }),
          runtime: fakeRuntime({ selectRuntimeFor: freshOnlySelector(() => decided) }),
          barrier: fakeReviewer({ prompt: false }),
        }),
        "s1", "openai/gpt-5.6-sol", false,
      );
      expect(adopted).toEqual(["s1"]);
      expect(out).toEqual({ kind: "same-runtime", decided });
      const after = records.get("s1")!;
      expect(after.runtimeKind).toBe("winter-agent");
      expect(after.selection).toEqual(decided);
      expect(after.providerId).toBe("openai");
    });
  });

  test("an adoption refusal is the switch's refusal — typed, with its reason, and nothing is decided or written", async () => {
    await withRs(async (_rs, records) => {
      seedRecord(records, "s1", "claude-agent");
      let selectorCalled = false;
      const out = await planAndApplySwitch(
        deps({
          records,
          winter: fakeWinter({ adoptLegacyRecord: () => { throw new WinterLegRefusal("legacy_session_migration_refused", "cannot move to Winter's runtime: collision", "transcript-collision"); } }),
          runtime: fakeRuntime({ selectRuntimeFor: async () => { selectorCalled = true; return SELECTION("winter-agent"); } }),
        }),
        "s1", "openai/gpt-5.6-sol", false,
      );
      expect(out).toEqual({ kind: "refused", code: "legacy_session_migration_refused", detail: "cannot move to Winter's runtime: collision", reason: "transcript-collision" });
      expect(selectorCalled).toBe(false);
      expect(records.get("s1")!.runtimeKind).toBe("claude-agent");
    });
  });

  test("any other throw from the adoption is not swallowed", async () => {
    await withRs(async (_rs, records) => {
      seedRecord(records, "s1", "claude-agent");
      await expect(planAndApplySwitch(
        deps({ records, winter: fakeWinter({ adoptLegacyRecord: () => { throw new Error("boom"); } }) }),
        "s1", "openai/gpt-5.6-sol", false,
      )).rejects.toThrow("boom");
    });
  });
});

// Winter Phase 10b (D1-6, W18-20/W18-21): the ONE pre-flight review runs for every provider/model
// change. The ROUTER decides every skip (same-profile/same-family/zero-source-turns); this file's
// fake reviewer plays the router's part.
describe("planAndApplySwitch: the pre-flight review (reviewSwitch)", () => {
  test("gpt -> deepseek WITH a prompt: confirmation_required (warnings + portable); confirmLossy applies it", async () => {
    await withRs(async (_rs, records) => {
      seedRecord(records, "s1");
      const review = { prompt: true, classification: { lossClass: "warned-lossy", warnings: ["reasoning state may be lost"], portable: ["the visible conversation"] } };
      const decided = SELECTION("winter-agent");
      const runtime = fakeRuntime({ selectRuntimeFor: freshOnlySelector(() => decided) });
      const refused = await planAndApplySwitch(deps({ records, runtime, barrier: fakeReviewer(review) }), "s1", "deepseek/deepseek-v4-pro", false);
      expect(refused).toEqual({ kind: "confirmation_required", warnings: ["reasoning state may be lost"], portable: ["the visible conversation"] });
      const confirmed = await planAndApplySwitch(deps({ records, runtime, barrier: fakeReviewer(review) }), "s1", "deepseek/deepseek-v4-pro", true);
      expect(confirmed).toEqual({ kind: "same-runtime", decided });
    });
  });

  // C1 (whole-branch review, belt-and-braces, fix round 2): an APPLIED family change must leave the 8a
  // record naming what the session ACTUALLY runs, not what it was created with.
  test("C1: GPT -> DeepSeek leaves the record on DeepSeek; DeepSeek -> GPT then leaves it on GPT", async () => {
    await withRs(async (_rs, records) => {
      seedRecord(records, "s1");
      const DEEPSEEK = { ...SELECTION("winter-agent"), providerId: "deepseek", modelRef: "deepseek/deepseek-v4-pro", family: "deepseek" };
      const GPT = { ...SELECTION("winter-agent"), providerId: "openai", modelRef: "openai/gpt-5.6-sol", family: "openai" };
      const runtime = fakeRuntime({ selectRuntimeFor: freshOnlySelector((model) => (model === "deepseek/deepseek-v4-pro" ? DEEPSEEK : GPT)) });
      const d = deps({ records, runtime, barrier: fakeReviewer({ prompt: false }) });

      expect(await planAndApplySwitch(d, "s1", "deepseek/deepseek-v4-pro", false)).toEqual({ kind: "same-runtime", decided: DEEPSEEK });
      expect(records.get("s1")!.providerId).toBe("deepseek");
      expect(records.get("s1")!.selection).toEqual(DEEPSEEK);

      expect(await planAndApplySwitch(d, "s1", "openai/gpt-5.6-sol", false)).toEqual({ kind: "same-runtime", decided: GPT });
      expect(records.get("s1")!.providerId).toBe("openai");
      expect(records.get("s1")!.modelRef).toBe("openai/gpt-5.6-sol");
      expect(records.get("s1")!.selection).toEqual(GPT);
    });
  });

  test("Sonnet -> Opus (same family): no prompt, and the router's own reviewSwitch decided skipped:\"same-family\" — the daemon never computes families itself", async () => {
    await withRs(async (_rs, records) => {
      seedRecord(records, "s1");
      let reviewedWith: RuntimeSelection | undefined;
      const decided = { ...SELECTION("winter-agent"), providerId: "anthropic", modelRef: "anthropic/claude-opus-5", family: "claude" };
      const out = await planAndApplySwitch(
        deps({
          records,
          runtime: fakeRuntime({ selectRuntimeFor: freshOnlySelector(() => decided) }),
          barrier: fakeReviewer({ prompt: false, skipped: "same-family" }, { onReviewSwitch: (_s, requested) => { reviewedWith = requested; } }),
        }),
        "s1", "anthropic/claude-opus-5", false,
      );
      expect(out).toEqual({ kind: "same-runtime", decided });
      expect(reviewedWith).toEqual(decided);
    });
  });

  // Fix round 1 (MINOR, P10b-2's zero-turn carve-out): a session with no backend transcript at all has
  // no source turns for the review to weigh — the review is skipped entirely.
  test("a session with no backendSessionId (no sessionKey): a family-crossing switch applies with NO prompt and reviewSwitch is never called", async () => {
    await withRs(async (_rs, records) => {
      records.create({
        winterSessionId: "s1", runtimeKind: "winter-agent",
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
          barrier: { reviewSwitch: async () => { reviewCalled = true; throw new Error("not reached — no sessionKey means reviewSwitch is never called"); } },
        }),
        "s1", "deepseek/deepseek-v4-pro", false,
      );
      // An engine-era-shaped record (no backend id) has no leg decision to make either.
      expect(out).toEqual({ kind: "same-runtime" });
      expect(reviewCalled).toBe(false);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // Fix round 3 — "NOT IN THE RUNTIME DIRECTORY" IS NOT "NOTHING TO LOSE". A session can have a real
  // `backendSessionId` while never having had a live incarnation register in the router's runtime
  // directory; `reviewSwitch` throws for that shape. The fix is to MATERIALIZE the row from the
  // durable record and retry ONCE — and, when that is impossible, to fail SAFE as a prompt.
  // ══════════════════════════════════════════════════════════════════════════════════════════════
  const NOT_IN_DIRECTORY = "winter-runtime-sdk: no handoff can be planned for pk/be-1 — it is not in the runtime directory, so there is no record of which runtime owns it or which backend session it is";

  test("item 1a: the row is materialized from the durable record and reviewSwitch is retried — the router's real answer decides", async () => {
    await withRs(async (_rs, records) => {
      seedRecord(records, "s1");
      const directory = fakeDirectory();
      let reviewCalls = 0;
      const decided = { ...SELECTION("winter-agent"), providerId: "anthropic", modelRef: "anthropic/claude-sonnet-5" };
      const out = await planAndApplySwitch(
        deps({
          records,
          runtime: fakeRuntime({ selectRuntimeFor: freshOnlySelector(() => decided), directory: directory.facet }),
          barrier: {
            reviewSwitch: async () => {
              reviewCalls += 1;
              if (directory.rows.length === 0) throw new Error(NOT_IN_DIRECTORY);
              return { prompt: false, skipped: "no-source-turns" };
            },
          },
        }),
        "s1", "anthropic/claude-sonnet-5", false,
      );
      expect(out).toEqual({ kind: "same-runtime", decided });
      expect(reviewCalls).toBe(2);
      // The materialized row is the PARKED shape, at the backend id's own address — never a
      // "running, with a backend id, no handle" row, which the router reads as cold-resumable.
      expect(directory.rows.length).toBe(1);
      expect(directory.rows[0]!.address).toBe("session:be-1");
      expect(directory.rows[0]!.status).toBe("exited");
      expect(directory.rows[0]!.transport).toBe("winter-session");
      expect(directory.rows[0]!.backendSessionId).toBeUndefined();
    });
  });

  test("item 1a: a row that already exists is never clobbered by a parked one — the retry just runs", async () => {
    await withRs(async (_rs, records) => {
      seedRecord(records, "s1");
      const directory = fakeDirectory();
      const live = { address: "session:be-1", status: "running", runtimeKind: "winter-agent" } as unknown as RuntimeDirectoryEntry;
      directory.rows.push(live);
      let reviewCalls = 0;
      const out = await planAndApplySwitch(
        deps({
          records,
          runtime: fakeRuntime({ selectRuntimeFor: freshOnlySelector(() => SELECTION("winter-agent")), directory: directory.facet }),
          barrier: { reviewSwitch: async () => { reviewCalls += 1; if (reviewCalls === 1) throw new Error(NOT_IN_DIRECTORY); return { prompt: true, classification: { lossClass: "warned-lossy", warnings: ["w"], portable: [] } }; } },
        }),
        "s1", "anthropic/claude-sonnet-5", false,
      );
      expect(out.kind).toBe("confirmation_required");
      expect(reviewCalls).toBe(2);
      expect(directory.rows).toEqual([live]);
    });
  });

  test("item 1b: with NO directory facet the review cannot be retried — it fails SAFE as a prompt, never a silent apply", async () => {
    await withRs(async (_rs, records) => {
      seedRecord(records, "s1");
      const out = await planAndApplySwitch(
        deps({ records, barrier: { reviewSwitch: async () => { throw new Error(NOT_IN_DIRECTORY); } } }),
        "s1", "anthropic/claude-sonnet-5", false,
      );
      expect(out.kind).toBe("confirmation_required");
      // Nothing was patched on the way to the prompt.
      expect(records.get("s1")!.selection.providerId).toBe("p");
    });
  });

  test("item 1b: the retry that STILL throws fails safe as a prompt", async () => {
    await withRs(async (_rs, records) => {
      seedRecord(records, "s1");
      const directory = fakeDirectory();
      const out = await planAndApplySwitch(
        deps({
          records,
          runtime: fakeRuntime({ selectRuntimeFor: freshOnlySelector(() => SELECTION("winter-agent")), directory: directory.facet }),
          barrier: { reviewSwitch: async () => { throw new Error(NOT_IN_DIRECTORY); } },
        }),
        "s1", "anthropic/claude-sonnet-5", false,
      );
      expect(out.kind).toBe("confirmation_required");
      expect(directory.rows.length).toBe(1);
    });
  });

  test("a DIFFERENT reviewSwitch throw (not the runtime-directory shape) still fails safe as a prompt, never same-runtime", async () => {
    await withRs(async (_rs, records) => {
      seedRecord(records, "s1");
      const out = await planAndApplySwitch(
        deps({ records, barrier: { reviewSwitch: async () => { throw new Error("ECONNRESET: transient sidecar read failure"); } } }),
        "s1", "anthropic/claude-sonnet-5", false,
      );
      expect(out.kind).toBe("confirmation_required");
    });
  });
});

// Fix round 1 (MAJOR, controller ruling): a throw from `reviewSwitch` must never reject
// `planAndApplySwitch` — it fails safe as a PROMPT instead.
describe("planAndApplySwitch: a throwing reviewSwitch fails safe as a prompt, never a rejection", () => {
  function fakeBarrierWhoseReviewThrows(err: unknown): SwitchReviewer {
    return { reviewSwitch: async () => { throw err; } };
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
          "s1", "deepseek/deepseek-v4-pro", false,
        );
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeUndefined(); // never a rejection
      expect(out).toEqual({
        kind: "confirmation_required",
        warnings: ["Winter couldn't check whether this conversation fits deepseek/deepseek-v4-pro, or holds anything it can't read. The conversation carries over as it is; if it is too large, the current model will summarize its older part first."],
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
        "s1", "deepseek/deepseek-v4-pro", true,
      );
      // The change proceeds as an ordinary same-runtime model change once "confirmed".
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
        "s1", "deepseek/deepseek-v4-pro", false,
      );
      expect(out.kind).toBe("confirmation_required");
      expect(logs[0]).toContain("unknown");
      expect(logs[0]).not.toContain("a bare string throw");
    });
  });
});

// m5 (whole-branch review, fix round 2): the copy naming "the model this switch is about" must
// never show a raw, possibly-empty value.
describe("modelLabelFor", () => {
  test("an ordinary model string passes through unchanged", () => {
    expect(modelLabelFor("anthropic/claude-sonnet-5")).toBe("anthropic/claude-sonnet-5");
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
    const hint = renderNoCredentialHint(alternatives);
    expect(hint).toContain("winter login --anthropic-key");
    expect(hint).toContain("winter login --anthropic-console");
    expect(hint).toContain("Providers settings");
    for (const label of ["Anthropic API key", "Anthropic Console login", "OpenRouter", "Amazon Bedrock", "Google Vertex AI"]) expect(hint).toContain(label);
  });

  // WS-23 live-gate report: a `console/*` refusal listed the router's `console` row as "console: add a
  // credential from the app's Providers settings" — there is no key to add. The Console row renders as
  // the Console sign-in door, once, even beside the `anthropic`/`console-profile` alternative.
  test("a `console` row renders as the Console sign-in door — never 'add a credential' — and only once", () => {
    const alternatives: SelectionAlternative[] = [
      { providerId: "console", authKind: "unknown", label: "console" },
      { providerId: "anthropic", authKind: "console-profile", label: "Anthropic Console login" },
      { providerId: "openrouter", authKind: "api-key", label: "OpenRouter" },
    ];
    const hint = renderNoCredentialHint(alternatives);
    expect(hint).toContain("Anthropic Console login: run `winter login --anthropic-console`");
    expect(hint.split("winter login --anthropic-console").length - 1).toBe(1);
    expect(hint).not.toContain("console: add a credential");
    expect(hint).toContain("OpenRouter: add a credential from the app's Providers settings");
    expect(renderNoCredentialHint([{ providerId: "console", authKind: "console-profile", label: "console" }])).toBe("add one of these to use this model — Anthropic Console login: run `winter login --anthropic-console`");
  });

  // WS-23: the claude.ai subscription door is never rendered — the only runtime that could have used
  // it is retired, and it never shipped.
  test("the claude.ai subscription alternative is never rendered", () => {
    const alternatives: SelectionAlternative[] = [
      { providerId: "anthropic", authKind: "api-key", label: "Anthropic API key" },
      { providerId: "anthropic", authKind: "claude-oauth", label: "claude.ai subscription" },
    ];
    const hint = renderNoCredentialHint(alternatives);
    expect(hint).not.toContain("claude.ai subscription");
    expect(hint).toContain("Anthropic API key");
  });

  test("never matches /\\bSDK\\b|runtime|Claude Agent|Winter Agent/i, with every door present", () => {
    const alternatives: SelectionAlternative[] = [
      { providerId: "anthropic", authKind: "api-key", label: "Anthropic API key" },
      { providerId: "anthropic", authKind: "console-profile", label: "Anthropic Console login" },
      { providerId: "anthropic", authKind: "claude-oauth", label: "claude.ai subscription" },
      { providerId: "openrouter", authKind: "api-key", label: "OpenRouter" },
    ];
    expect(renderNoCredentialHint(alternatives)).not.toMatch(NEVER_NAMES_SDK_OR_RUNTIME);
  });

  test("an empty alternatives list still names the Providers settings, never a blank hint", () => {
    const hint = renderNoCredentialHint([]);
    expect(hint.length).toBeGreaterThan(0);
    expect(hint).toContain("Providers settings");
    expect(hint).not.toMatch(NEVER_NAMES_SDK_OR_RUNTIME);
  });
});

// Winter Phase 10b (D1-7, W18-3): end to end through `planAndApplySwitch` — the SAME hint reaches
// the refusal's `detail`.
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
        "s1", "anthropic/claude-opus-5", false,
      );
      expect(out.kind).toBe("refused");
      const detail = (out as { detail: string }).detail;
      // Fix round 4 (item 5): the router's OWN sentence is gone — it is logged as a category. The
      // HINT survives, and is the whole reason this arm is treated differently from every other
      // refusal: it is built HERE out of the router's structured `alternatives`, it is the only
      // refusal text that tells the user what to actually do, and the sweep below pins that it
      // never names an SDK or a runtime.
      expect(detail).not.toContain("no door can serve claude-opus-5");
      expect(detail).toContain("winter login --anthropic-key");
      expect(detail).toContain("winter login --anthropic-console");
      expect(detail).not.toMatch(/\bSDK\b|runtime|Claude Agent|Winter Agent/i);
    });
  });

  test("a refusal with no `no-credential` reason gets the neutral copy — never the router's own words", async () => {
    await withRs(async (_rs, records) => {
      seedRecord(records, "s1");
      const logLines: string[] = [];
      const out = await planAndApplySwitch(
        deps({
          records,
          log: (line) => { logLines.push(line); },
          runtime: fakeRuntime({
            // The MEASURED shape: a real `mode-forbids-runtime` detail names the leg outright.
            selectRuntimeFor: async () => ({ refused: true, reason: "mode-forbids-runtime", detail: "chat/dispatch never route to the official runtime (D28)" }),
          }),
        }),
        "s1", "anthropic/claude-opus-5", false,
      );
      expect(out).toEqual({ kind: "refused", code: "runtime_selection_refused", detail: "Winter can't switch to anthropic/claude-opus-5 right now." });
      // Logged as a CATEGORY, never as text — the router's own words leave no trace anywhere a user
      // or a log reader could reconstruct them from.
      expect(logLines).toHaveLength(1);
      expect(logLines[0]).toContain("reason=mode-forbids-runtime");
      expect(logLines[0]).toContain("detail=names-a-runtime");
      expect(logLines[0]).not.toContain("chat/dispatch never route");
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Fix round 4, ITEM 6 — a switch that changes PROVIDER replaces the child.
//
// A live Winter child's `Options.provider`/`connection` is fixed at spawn. A model change is told to
// it hot (`Query.setModel`); a PROVIDER change cannot be, so the child keeps posting to the old
// endpoint until something else replaces it.
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe("item 6: a same-leg PROVIDER change replaces the live child", () => {
  const winterSelection = (providerId: string, modelRef: string): RuntimeSelection => ({
    runtimeKind: "winter-agent", providerId, modelRef, family: "f", authFamily: "api-key",
    sdkVersion: "0.0.4", reason: "test", decidedAt: new Date().toISOString(),
  });
  function idleLive(turnRunning: boolean, idle: () => Promise<void>): LegSession {
    const never = (): never => { throw new Error("not reached by this test"); };
    return {
      sessionId: "s1", backendSessionId: "be-1", mode: "code", state: "live", generation: 1, resumed: true,
      init: undefined, turnRunning, turnStartedAt: Date.now(), done: Promise.resolve(),
      pendingSends: [], heldDeliveries: [],
      send: never, steer: never, interrupt: never, compact: never, setModel: never, setPolicy: never,
      end: never, deliver: never, open: never, idle,
    };
  }

  test("a different providerId with no turn running evicts immediately", async () => {
    await withRs(async (_rs, records) => {
      seedRecord(records, "s1"); // seeded providerId "p"
      const evicted: string[] = [];
      const winter = fakeWinter({ live: idleLive(false, async () => {}) });
      const out = await planAndApplySwitch(
        deps({
          records,
          winter: { ...winter, evict: async (id: string) => { evicted.push(id); } },
          runtime: fakeRuntime({ selectRuntimeFor: freshOnlySelector(() => winterSelection("deepseek", "deepseek/deepseek-v4-pro")) }),
          barrier: { reviewSwitch: async () => ({ prompt: false }) },
        }),
        "s1", "deepseek/deepseek-v4-pro", false,
      );
      expect(out.kind).toBe("same-runtime");
      expect(evicted).toEqual(["s1"]);
      // …and the record agrees with the destination, so the caller's invariant guard lets the store
      // write through — the next `ensure()` then spawns against the NEW provider.
      expect(records.get("s1")!.providerId).toBe("deepseek");
    });
  });

  test("the SAME providerId (an ordinary model change) stays hot — no evict", async () => {
    await withRs(async (_rs, records) => {
      seedRecord(records, "s1"); // seeded providerId "p"
      const evicted: string[] = [];
      const winter = fakeWinter({ live: idleLive(false, async () => {}) });
      const out = await planAndApplySwitch(
        deps({
          records,
          winter: { ...winter, evict: async (id: string) => { evicted.push(id); } },
          runtime: fakeRuntime({ selectRuntimeFor: freshOnlySelector(() => winterSelection("p", "p/other-model")) }),
          barrier: { reviewSwitch: async () => ({ prompt: false }) },
        }),
        "s1", "deepseek/deepseek-v4-pro", false,
      );
      expect(out.kind).toBe("same-runtime");
      expect(evicted).toEqual([]);
    });
  });

  // WS-23 (reasoning-state, decision 5): the review said the conversation does not fit the target, so the
  // child being replaced compacts FIRST, on its own (source) model -- the model being left pays -- and only
  // then is evicted; a conversation that fits is replaced at once, with no compaction.
  const compactingLive = (turnRunning: boolean, idle: () => Promise<void>, calls: string[], outcome: () => Promise<{ retainedCount: number }> = async () => ({ retainedCount: 4 })): LegSession => ({
    ...idleLive(turnRunning, idle),
    compact: async () => {
      calls.push("compact");
      return await outcome();
    },
  });
  const tooBig = { prompt: true, fits: false, estimatedTokens: 612_000, window: 128_000, classification: { lossClass: "warned-lossy" as const, warnings: ["too large"], portable: ["the recent conversation as it is, and a summary of the older part"] } };

  test("WS-23: a switch the target cannot hold -- the confirmation carries the fit, and once confirmed the source compacts BEFORE the evict", async () => {
    await withRs(async (_rs, records) => {
      seedRecord(records, "s1"); // seeded providerId "p"
      const calls: string[] = [];
      const winter = fakeWinter({ live: compactingLive(false, async () => {}, calls) });
      const run = (confirm: boolean) =>
        planAndApplySwitch(
          deps({
            records,
            winter: { ...winter, evict: async () => { calls.push("evict"); } },
            runtime: fakeRuntime({ selectRuntimeFor: freshOnlySelector(() => winterSelection("deepseek", "deepseek/deepseek-v4-pro")) }),
            barrier: { reviewSwitch: async () => tooBig },
          }),
          "s1", "deepseek/deepseek-v4-pro", confirm,
        );
      expect(await run(false)).toEqual({ kind: "confirmation_required", warnings: ["too large"], portable: ["the recent conversation as it is, and a summary of the older part"], fit: { fits: false, estimatedTokens: 612_000, window: 128_000 } });
      expect(calls).toEqual([]);
      expect((await run(true)).kind).toBe("same-runtime");
      // The reply does not wait for the compaction (callers time out long before one ends); it runs, then the evict.
      await Bun.sleep(20);
      expect(calls).toEqual(["compact", "evict"]);
    });
  });

  test("WS-23: a conversation that fits is replaced with no compaction; a compaction that fails still lets the switch through", async () => {
    await withRs(async (_rs, records) => {
      seedRecord(records, "s1");
      const calls: string[] = [];
      const fits = { prompt: false, fits: true, estimatedTokens: 20_000, window: 128_000 };
      const winter = fakeWinter({ live: compactingLive(false, async () => {}, calls) });
      await planAndApplySwitch(
        deps({ records, winter: { ...winter, evict: async () => { calls.push("evict"); } }, runtime: fakeRuntime({ selectRuntimeFor: freshOnlySelector(() => winterSelection("deepseek", "deepseek/deepseek-v4-pro")) }), barrier: { reviewSwitch: async () => fits } }),
        "s1", "deepseek/deepseek-v4-pro", false,
      );
      expect(calls).toEqual(["evict"]);
    });
    await withRs(async (_rs, records) => {
      seedRecord(records, "s1");
      const calls: string[] = [];
      const logs: string[] = [];
      const failing = fakeWinter({ live: compactingLive(false, async () => {}, calls, async () => { throw Object.assign(new Error("nothing to compact"), { name: "WinterRpcError" }); }) });
      const out = await planAndApplySwitch(
        deps({ records, log: (line: string) => logs.push(line), winter: { ...failing, evict: async () => { calls.push("evict"); } }, runtime: fakeRuntime({ selectRuntimeFor: freshOnlySelector(() => winterSelection("deepseek", "deepseek/deepseek-v4-pro")) }), barrier: { reviewSwitch: async () => tooBig } }),
        "s1", "deepseek/deepseek-v4-pro", true,
      );
      expect(out.kind).toBe("same-runtime");
      await Bun.sleep(20);
      expect(calls).toEqual(["compact", "evict"]);
      expect(logs.some((l) => l.includes("could not compact on its source model") && l.includes("WinterRpcError"))).toBe(true);
    });
  });

  test("WS-23: with a turn running, the source compacts at the idle boundary, then the child is replaced", async () => {
    await withRs(async (_rs, records) => {
      seedRecord(records, "s1");
      const calls: string[] = [];
      let resolveIdle: (() => void) | undefined;
      const idlePromise = new Promise<void>((resolve) => { resolveIdle = resolve; });
      const winter = fakeWinter({ live: compactingLive(true, () => idlePromise, calls) });
      await planAndApplySwitch(
        deps({ records, winter: { ...winter, evict: async () => { calls.push("evict"); } }, runtime: fakeRuntime({ selectRuntimeFor: freshOnlySelector(() => winterSelection("deepseek", "deepseek/deepseek-v4-pro")) }), barrier: { reviewSwitch: async () => tooBig } }),
        "s1", "deepseek/deepseek-v4-pro", true,
      );
      expect(calls).toEqual([]);
      resolveIdle!();
      await idlePromise;
      await Bun.sleep(20);
      expect(calls).toEqual(["compact", "evict"]);
    });
  });

  // Review r1 I-5: the handoff promise is kept per session -- a message sent while the source compacts is
  // held for the target (the live child's `beginHandoff`), and once the child is replaced the session is
  // resumed on the new provider at once (`ensure`) to answer it.
  test("WS-23 r1 I-5: messages held during the switch are answered by the TARGET -- the session is resumed right after the evict", async () => {
    await withRs(async (_rs, records) => {
      seedRecord(records, "s1");
      const calls: string[] = [];
      let release: (() => void) | undefined;
      const compacting = new Promise<void>((resolve) => { release = resolve; });
      let pending = false;
      const live: LegSession = {
        ...compactingLive(false, async () => {}, calls, async () => { await compacting; return { retainedCount: 3 }; }),
        get handoffPending() { return pending; },
        beginHandoff: async (work: () => Promise<void>) => { pending = true; await work(); pending = false; return { heldTurns: 1 }; },
      };
      const winter = fakeWinter({ live });
      await planAndApplySwitch(
        deps({ records, winter: { ...winter, evict: async () => { calls.push("evict"); }, ensure: async () => { calls.push("ensure"); return undefined; } }, runtime: fakeRuntime({ selectRuntimeFor: freshOnlySelector(() => winterSelection("deepseek", "deepseek/deepseek-v4-pro")) }), barrier: { reviewSwitch: async () => tooBig } }),
        "s1", "deepseek/deepseek-v4-pro", true,
      );
      expect(live.handoffPending).toBe(true);   // synchronously: server.ts reads it right after the switch returns
      await Bun.sleep(10);
      expect(calls).toEqual(["compact"]);
      release!();
      await Bun.sleep(20);
      expect(calls).toEqual(["compact", "evict", "ensure"]);
      expect(live.handoffPending).toBe(false);
    });
  });

  test("a running turn is never interrupted — the evict waits for the idle boundary", async () => {
    await withRs(async (_rs, records) => {
      seedRecord(records, "s1");
      const evicted: string[] = [];
      let resolveIdle: (() => void) | undefined;
      const idlePromise = new Promise<void>((resolve) => { resolveIdle = resolve; });
      const winter = fakeWinter({ live: idleLive(true, () => idlePromise) });
      const out = await planAndApplySwitch(
        deps({
          records,
          winter: { ...winter, evict: async (id: string) => { evicted.push(id); } },
          runtime: fakeRuntime({ selectRuntimeFor: freshOnlySelector(() => winterSelection("deepseek", "deepseek/deepseek-v4-pro")) }),
          barrier: { reviewSwitch: async () => ({ prompt: false }) },
        }),
        "s1", "deepseek/deepseek-v4-pro", false,
      );
      expect(out.kind).toBe("same-runtime");
      expect(evicted).toEqual([]);   // the reply never waited, and the turn was never cut short
      resolveIdle!();
      await idlePromise;
      await Bun.sleep(20);
      expect(evicted).toEqual(["s1"]); // …and the child WAS replaced, at the boundary
    });
  });

  // Fix round 4 review (N2): the evict fired even when the C1 record patch THREW. The record then
  // still names the OLD provider, `ipc/server.ts`'s 1c invariant check reads it, sees the
  // disagreement and refuses the whole switch — so the child was thrown away for a switch that never
  // happened, and the next send paid a cold start and a resume to reach the SAME provider.
  test("N2: a C1 patch that throws leaves the live child alone — nothing moved, so nothing is replaced", async () => {
    await withRs(async (_rs, records) => {
      seedRecord(records, "s1"); // seeded providerId "p"
      const evicted: string[] = [];
      const winter = fakeWinter({ live: idleLive(false, async () => {}) });
      const failingRecords = Object.assign(Object.create(Object.getPrototypeOf(records) as object), records, {
        get: (id: string) => records.get(id),
        patch: () => { throw new Error("RuntimeSessionStateMismatchError"); },
      }) as RuntimeSessionRecords;
      const out = await planAndApplySwitch(
        deps({
          records: failingRecords,
          winter: { ...winter, evict: async (id: string) => { evicted.push(id); } },
          runtime: fakeRuntime({ selectRuntimeFor: freshOnlySelector(() => winterSelection("deepseek", "deepseek/deepseek-v4-pro")) }),
          barrier: { reviewSwitch: async () => ({ prompt: false }) },
        }),
        "s1", "deepseek/deepseek-v4-pro", false,
      );
      expect(out.kind).toBe("same-runtime");
      expect(evicted).toEqual([]);
      // The record never moved, which is what the caller's own 1c guard will refuse on.
      expect(records.get("s1")!.providerId).toBe("p");
    });
  });

  test("no live child at all is a no-op — the next resume reads the record", async () => {
    await withRs(async (_rs, records) => {
      seedRecord(records, "s1");
      const evicted: string[] = [];
      const winter = fakeWinter({});
      const out = await planAndApplySwitch(
        deps({
          records,
          winter: { ...winter, evict: async (id: string) => { evicted.push(id); } },
          runtime: fakeRuntime({ selectRuntimeFor: freshOnlySelector(() => winterSelection("deepseek", "deepseek/deepseek-v4-pro")) }),
          barrier: { reviewSwitch: async () => ({ prompt: false }) },
        }),
        "s1", "deepseek/deepseek-v4-pro", false,
      );
      expect(out.kind).toBe("same-runtime");
      expect(evicted).toEqual([]);
    });
  });
});
