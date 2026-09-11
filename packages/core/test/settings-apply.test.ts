import { describe, expect, mock, test } from "bun:test";
import { makeApply, type SettingsApplyDeps } from "../src/settings-apply";
import { Settings } from "../src/settings";
import { ToolRegistry } from "../src/agent/tools/registry";

const fakeReg = new ToolRegistry();

function baseDeps(overrides: Partial<SettingsApplyDeps> = {}): SettingsApplyDeps {
  return {
    setLiveSettings: () => {},
    registry: fakeReg,
    buildComputerService: () => ({}) as any,
    registerComputer: () => {},
    teardownComputer: () => {},
    computerInFlight: () => false,
    buildLspManager: () => ({}) as any,
    registerLsp: () => {},
    teardownLsp: () => {},
    ...overrides,
  };
}

/** Flushes the microtask queue past `applyMemoryMigrationDiff`'s `Promise.resolve().then(...)`
 *  chain — that diff is deliberately fire-and-forget (never awaited by `apply()` itself, see its
 *  own doc comment in settings-apply.ts), so a test asserting on `migrateMemory`'s call count must
 *  yield back to the microtask queue at least once after `await apply(...)` resolves before
 *  reading that count. */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("makeApply", () => {
  test("swap happens first, before any tool re-wire", async () => {
    const order: string[] = [];
    const apply = makeApply(
      baseDeps({
        setLiveSettings: () => order.push("swap"),
        buildComputerService: () => {
          order.push("build");
          return {} as any;
        },
        registerComputer: () => order.push("register"),
      }),
    );
    await apply({ computerUse: { enabled: false } } as any, { computerUse: { enabled: true } } as any);
    expect(order[0]).toBe("swap");
    expect(order).toContain("register");
  });

  test("computerUse false→true registers the computer tool + builds service", async () => {
    const build = mock(() => ({}) as any);
    const register = mock(() => {});
    const apply = makeApply(baseDeps({ buildComputerService: build, registerComputer: register }));
    await apply({ computerUse: { enabled: false } } as any, { computerUse: { enabled: true } } as any);
    expect(build).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledTimes(1);
  });

  test("computerUse true→false with an in-flight call drains before teardown", async () => {
    let inFlight = true;
    const teardown = mock(() => {});
    const apply = makeApply(
      baseDeps({ computerInFlight: () => inFlight, teardownComputer: teardown, drainIntervalMs: 5 }),
    );
    const p = apply({ computerUse: { enabled: true } } as any, { computerUse: { enabled: false } } as any);
    await Bun.sleep(30);
    expect(teardown).not.toHaveBeenCalled(); // still draining
    inFlight = false;
    await p;
    expect(teardown).toHaveBeenCalledTimes(1);
  });

  test("computerUse disable drain exceeds drainTimeoutMs: teardown still called once, a warning is logged, test completes fast", async () => {
    const teardown = mock(() => {});
    const warnings: string[] = [];
    const apply = makeApply(
      baseDeps({
        computerInFlight: () => true, // never clears
        teardownComputer: teardown,
        drainTimeoutMs: 40,
        drainIntervalMs: 5,
        sleep: (_ms: number) => Promise.resolve(), // fast injected clock — no real waiting
        log: (msg) => warnings.push(msg),
      }),
    );
    const start = Date.now();
    await apply({ computerUse: { enabled: true } } as any, { computerUse: { enabled: false } } as any);
    expect(teardown).toHaveBeenCalledTimes(1);
    expect(warnings.length).toBe(1);
    expect(Date.now() - start).toBeLessThan(100); // never actually waited real ms, despite drainTimeoutMs

    // Same assertion with the PRODUCTION default drainTimeoutMs (10000ms) — the cap is expressed
    // as an iteration count over the injected sleep, not a real-time deadline, so a fast sleep
    // keeps this near-instant even at the real default cap (proves the drain cap doesn't secretly
    // depend on wall-clock time).
    const teardown2 = mock(() => {});
    const apply2 = makeApply(
      baseDeps({
        computerInFlight: () => true,
        teardownComputer: teardown2,
        sleep: (_ms: number) => Promise.resolve(),
        log: () => {},
      }),
    );
    const start2 = Date.now();
    await apply2({ computerUse: { enabled: true } } as any, { computerUse: { enabled: false } } as any);
    expect(teardown2).toHaveBeenCalledTimes(1);
    expect(Date.now() - start2).toBeLessThan(500);
  });

  test("lsp false→true registers, true→false tears down + stopAll", async () => {
    const build = mock(() => ({}) as any);
    const register = mock(() => {});
    let apply = makeApply(baseDeps({ buildLspManager: build, registerLsp: register }));
    await apply({ lsp: { enabled: false } } as any, { lsp: { enabled: true } } as any);
    expect(build).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledTimes(1);

    const teardown = mock(() => {});
    apply = makeApply(baseDeps({ teardownLsp: teardown }));
    await apply({ lsp: { enabled: true } } as any, { lsp: { enabled: false } } as any);
    expect(teardown).toHaveBeenCalledTimes(1);
  });

  // lsp is default-ON / opt-out (absent block ⇒ enabled). These cross the absent-field boundary
  // the explicit-only tests above never touch — the exact class the `!!` polarity bug missed.
  test("lsp absent → {enabled:false} tears down", async () => {
    const build = mock(() => ({}) as any);
    const register = mock(() => {});
    const teardown = mock(() => {});
    const apply = makeApply(baseDeps({ buildLspManager: build, registerLsp: register, teardownLsp: teardown }));
    // prev has NO lsp block = enabled-by-default; next explicitly disables → this IS a flip.
    await apply({ provider: { model: "a" } } as any, { lsp: { enabled: false } } as any);
    expect(teardown).toHaveBeenCalledTimes(1);
    expect(register).not.toHaveBeenCalled();
    expect(build).not.toHaveBeenCalled();
  });

  test("lsp {enabled:false} → absent re-registers", async () => {
    const build = mock(() => ({}) as any);
    const register = mock(() => {});
    const teardown = mock(() => {});
    const apply = makeApply(baseDeps({ buildLspManager: build, registerLsp: register, teardownLsp: teardown }));
    // prev explicitly disabled; next drops the lsp block = re-enabled by default → flip.
    await apply({ lsp: { enabled: false } } as any, { provider: { model: "a" } } as any);
    expect(build).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledTimes(1);
    expect(teardown).not.toHaveBeenCalled();
  });

  test("lsp absent → absent is a no-op", async () => {
    const build = mock(() => ({}) as any);
    const register = mock(() => {});
    const teardown = mock(() => {});
    const apply = makeApply(baseDeps({ buildLspManager: build, registerLsp: register, teardownLsp: teardown }));
    // both default-enabled (no lsp block on either side) → no flip.
    await apply({ provider: { model: "a" } } as any, { provider: { model: "b" } } as any);
    expect(build).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
    expect(teardown).not.toHaveBeenCalled();
  });

  test("computerUse absent → absent touches nothing (opt-in polarity: both default-OFF)", async () => {
    const build = mock(() => ({}) as any);
    const register = mock(() => {});
    const teardown = mock(() => {});
    const apply = makeApply(
      baseDeps({ buildComputerService: build, registerComputer: register, teardownComputer: teardown }),
    );
    // No computerUse block on either side ⇒ both disabled ⇒ no flip (CU is opt-in, unlike lsp).
    await apply({ provider: { model: "a" } } as any, { provider: { model: "b" } } as any);
    expect(build).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
    expect(teardown).not.toHaveBeenCalled();
  });

  test("a value-only change (no flag flip) swaps but touches NO tools", async () => {
    const buildCu = mock(() => ({}) as any);
    const registerCu = mock(() => {});
    const teardownCu = mock(() => {});
    const buildLsp = mock(() => ({}) as any);
    const registerLsp = mock(() => {});
    const teardownLsp = mock(() => {});
    let swapped: any;
    const apply = makeApply(
      baseDeps({
        setLiveSettings: (s) => {
          swapped = s;
        },
        buildComputerService: buildCu,
        registerComputer: registerCu,
        teardownComputer: teardownCu,
        buildLspManager: buildLsp,
        registerLsp,
        teardownLsp,
      }),
    );
    const prev = { computerUse: { enabled: true }, lsp: { enabled: true }, provider: { model: "a" } } as any;
    const next = { computerUse: { enabled: true }, lsp: { enabled: true }, provider: { model: "b" } } as any;
    await apply(prev, next);
    expect(swapped).toBe(next);
    for (const fn of [buildCu, registerCu, teardownCu, buildLsp, registerLsp, teardownLsp]) {
      expect(fn).not.toHaveBeenCalled();
    }
  });

  test("CU and LSP flips are independent: a stalled CU drain does not block the LSP re-wire", async () => {
    const registerLsp = mock(() => {});
    const apply = makeApply(
      baseDeps({
        computerInFlight: () => true, // CU disable never clears within the drain window
        drainTimeoutMs: 30,
        drainIntervalMs: 5,
        registerLsp,
      }),
    );
    const start = Date.now();
    await apply(
      { computerUse: { enabled: true }, lsp: { enabled: false } } as any,
      { computerUse: { enabled: false }, lsp: { enabled: true } } as any,
    );
    expect(registerLsp).toHaveBeenCalledTimes(1);
    expect(Date.now() - start).toBeLessThan(500); // bounded by the small drainTimeoutMs, not a real hang
  });

  // Whole-branch review F1: one flag's diff throwing must NEITHER reject the aggregate apply NOR
  // abandon the other flag's diff — otherwise T3 keeps prevSnapshot, re-diffs the SAME flip next
  // reload, re-throws "duplicate tool", and hot-apply is wedged for the daemon's life. Both flips
  // fire in ONE apply: CU's registerComputer throws, LSP's registerLsp must still run, and the
  // atomic swap must still have happened.
  test("a throwing flag diff does not reject apply, wedge the other flag, or skip the swap", async () => {
    const registerComputer = mock(() => {
      throw new Error("boom: registerComputer");
    });
    const registerLsp = mock(() => {});
    const warnings: string[] = [];
    let swapped: any;
    const apply = makeApply(
      baseDeps({
        setLiveSettings: (s) => {
          swapped = s;
        },
        registerComputer, // CU false→true → this fires → throws
        registerLsp, // LSP false→true → this must still run despite the CU throw
        log: (msg) => warnings.push(msg),
      }),
    );
    const prev = { computerUse: { enabled: false }, lsp: { enabled: false } } as any;
    const next = { computerUse: { enabled: true }, lsp: { enabled: true } } as any;

    // (a) apply() resolves — it does NOT reject even though registerComputer threw.
    await expect(apply(prev, next)).resolves.toBeUndefined();
    // (b) the OTHER flag's diff still ran to completion.
    expect(registerLsp).toHaveBeenCalledTimes(1);
    // (c) the atomic swap still happened (it's outside both try/catches, first + unconditional).
    expect(swapped).toBe(next);
    // and the failure was logged (best-effort-until-next-change, not a silent swallow).
    expect(registerComputer).toHaveBeenCalledTimes(1);
    expect(warnings.some((w) => w.includes("computerUse diff-apply failed"))).toBe(true);
  });

  test("a throwing LSP teardown is likewise isolated — CU flip still applies", async () => {
    const teardownLsp = mock(() => {
      throw new Error("boom: teardownLsp");
    });
    const registerComputer = mock(() => {});
    const warnings: string[] = [];
    const apply = makeApply(
      baseDeps({
        teardownLsp, // LSP true→false → this fires → throws
        registerComputer, // CU false→true → must still run
        log: (msg) => warnings.push(msg),
      }),
    );
    await expect(
      apply(
        { computerUse: { enabled: false }, lsp: { enabled: true } } as any,
        { computerUse: { enabled: true }, lsp: { enabled: false } } as any,
      ),
    ).resolves.toBeUndefined();
    expect(registerComputer).toHaveBeenCalledTimes(1);
    expect(teardownLsp).toHaveBeenCalledTimes(1);
    expect(warnings.some((w) => w.includes("lsp diff-apply failed"))).toBe(true);
  });

  // File-based memory hot-toggle (T3, design doc follow-up / task-23): closes T2's "boot-time
  // only" migration gap — a `memory.enabled` false→true flip on an ALREADY-RUNNING daemon must
  // re-run the (idempotent) importer immediately, not wait for the next restart.
  describe("memory.enabled hot-toggle re-runs the migration importer", () => {
    test("false -> true triggers migrateMemory exactly once", async () => {
      const migrateMemory = mock(() => {});
      const apply = makeApply(baseDeps({ migrateMemory }));
      await apply({ memory: { enabled: false } } as any, { memory: { enabled: true } } as any);
      await flushMicrotasks();
      expect(migrateMemory).toHaveBeenCalledTimes(1);
    });

    test("true -> false does NOT trigger migrateMemory", async () => {
      const migrateMemory = mock(() => {});
      const apply = makeApply(baseDeps({ migrateMemory }));
      await apply({ memory: { enabled: true } } as any, { memory: { enabled: false } } as any);
      await flushMicrotasks();
      expect(migrateMemory).not.toHaveBeenCalled();
    });

    test("no flip (both enabled, incl. the default both-absent case) does NOT trigger migrateMemory", async () => {
      const migrateMemory = mock(() => {});
      const apply = makeApply(baseDeps({ migrateMemory }));
      // both explicitly enabled — a value-only change elsewhere.
      await apply({ memory: { enabled: true }, provider: { model: "a" } } as any, { memory: { enabled: true }, provider: { model: "b" } } as any);
      await flushMicrotasks();
      expect(migrateMemory).not.toHaveBeenCalled();

      // memory is default-ON (opt-out, same polarity as lsp) — absent on both sides is ALSO a
      // no-flip, the common real-world case (no memory block in settings.json at all).
      await apply({ provider: { model: "a" } } as any, { provider: { model: "b" } } as any);
      await flushMicrotasks();
      expect(migrateMemory).not.toHaveBeenCalled();
    });

    test("absent -> {enabled:false} does NOT trigger migrateMemory (true -> false crossing the absent-field boundary)", async () => {
      const migrateMemory = mock(() => {});
      const apply = makeApply(baseDeps({ migrateMemory }));
      await apply({ provider: { model: "a" } } as any, { memory: { enabled: false } } as any);
      await flushMicrotasks();
      expect(migrateMemory).not.toHaveBeenCalled();
    });

    test("{enabled:false} -> absent DOES trigger migrateMemory (false -> true crossing the absent-field boundary)", async () => {
      const migrateMemory = mock(() => {});
      const apply = makeApply(baseDeps({ migrateMemory }));
      await apply({ memory: { enabled: false } } as any, { provider: { model: "a" } } as any);
      await flushMicrotasks();
      expect(migrateMemory).toHaveBeenCalledTimes(1);
    });

    test("no migrateMemory dep wired (every pre-T3 caller/test): a false -> true flip is a silent no-op, never throws", async () => {
      const apply = makeApply(baseDeps());
      await expect(apply({ memory: { enabled: false } } as any, { memory: { enabled: true } } as any)).resolves.toBeUndefined();
    });

    test("apply() itself resolves without waiting for migrateMemory (fire-and-forget, never blocks)", async () => {
      let resolveMigrate!: () => void;
      const migrateMemory = mock(() => new Promise<void>((resolve) => { resolveMigrate = resolve; }));
      const apply = makeApply(baseDeps({ migrateMemory }));
      const start = Date.now();
      await apply({ memory: { enabled: false } } as any, { memory: { enabled: true } } as any);
      expect(Date.now() - start).toBeLessThan(100); // did not wait on migrateMemory's never-resolved promise
      expect(migrateMemory).toHaveBeenCalledTimes(1);
      resolveMigrate(); // let the still-pending promise settle so it doesn't leak into the next test
    });

    test("a throwing/rejecting migrateMemory is logged, never rejects apply() or the OTHER flags' diffs", async () => {
      const migrateMemory = mock(() => { throw new Error("boom: migrateMemory"); });
      const registerLsp = mock(() => {});
      const warnings: string[] = [];
      const apply = makeApply(baseDeps({ migrateMemory, registerLsp, log: (msg) => warnings.push(msg) }));
      await expect(
        apply(
          { memory: { enabled: false }, lsp: { enabled: false } } as any,
          { memory: { enabled: true }, lsp: { enabled: true } } as any,
        ),
      ).resolves.toBeUndefined();
      expect(registerLsp).toHaveBeenCalledTimes(1); // unrelated flag's diff still ran
      await flushMicrotasks();
      expect(warnings.some((w) => w.includes("memory migration on hot-toggle failed"))).toBe(true);
    });
  });
});

// ── P8b Task 15: the router's PLAIN-VALUE options ─────────────────────────────────────────────────
//
// Surface map §8.3: `createRuntimeSdk` takes `brand`, `retention` and `advisor` as VALUES at
// construction, while the inbound-policy hooks are functions and hot by construction. Every
// value-shaped option a setting can change therefore needs a stated answer, and this diff is where
// those answers live. Only ONE of them is an action — the directory nudge after a retention/name
// change; the rest reach the next session through the live settings holder and are narrated so a
// user who flips a leg and sees their open chat unchanged can find out why.
//
// THE HANDLE ITSELF IS NOT IN THIS LANE (`runtimeSdk` is Task 5's, `messaging` is Task 12's), which
// is why every hop is optional and why these tests inject a fake: proving the optional chain calls
// through when something IS there, and does nothing when it is not, is exactly what this task can
// prove. Whether the REAL `releaseHeld` does the right thing is the messaging lane's assertion.
describe("makeApply: the runtime options diff (P8b Task 15)", () => {
  const withRuntimes = (runtimes: unknown) => ({ provider: { model: "a" }, runtimes }) as any;
  /** A COMPLETE settings object, so the block-presence tests exercise the real parsed shape (zod's
   *  per-key defaults included) rather than a hand-built partial that could not exist on disk. */
  const BASE_SETTINGS = { schemaVersion: 2 as const, provider: { type: "codex-oauth" as const, model: "gpt-5.4" } };

  test("a shortened name-lease window nudges the directory — a held message must not wait for the next event", async () => {
    const releaseHeld = mock(() => {});
    const apply = makeApply(baseDeps({ runtimeSdk: { messaging: { releaseHeld } } }));
    await apply(withRuntimes({ retention: { deliveriesDays: 30, nameLeasesDays: 7 } }), withRuntimes({ retention: { deliveriesDays: 30, nameLeasesDays: 1 } }));
    await flushMicrotasks();
    expect(releaseHeld).toHaveBeenCalledTimes(1);
  });

  test("a deliveries-window change nudges it too, and an unrelated settings change does not", async () => {
    const releaseHeld = mock(() => {});
    const apply = makeApply(baseDeps({ runtimeSdk: { messaging: { releaseHeld } } }));
    await apply(withRuntimes({ retention: { deliveriesDays: 30, nameLeasesDays: 7 } }), withRuntimes({ retention: { deliveriesDays: 90, nameLeasesDays: 7 } }));
    await flushMicrotasks();
    expect(releaseHeld).toHaveBeenCalledTimes(1);

    await apply(withRuntimes({ retention: { deliveriesDays: 90, nameLeasesDays: 7 } }), withRuntimes({ retention: { deliveriesDays: 90, nameLeasesDays: 7 }, winterLeg: { chat: true } }));
    await flushMicrotasks();
    expect(releaseHeld).toHaveBeenCalledTimes(1); // still one: a leg flip is not a directory event
  });

  test("no runtime handle, or a handle with no messaging: the diff is a silent no-op — never a throw", async () => {
    const apply = makeApply(baseDeps()); // today's daemon: nothing wired
    await expect(apply(withRuntimes({ retention: { nameLeasesDays: 7 } }), withRuntimes({ retention: { nameLeasesDays: 1 } }))).resolves.toBeUndefined();

    const half = makeApply(baseDeps({ runtimeSdk: {} }));
    await expect(half(withRuntimes({ retention: { nameLeasesDays: 7 } }), withRuntimes({ retention: { nameLeasesDays: 1 } }))).resolves.toBeUndefined();

    const emptyMessaging = makeApply(baseDeps({ runtimeSdk: { messaging: {} } }));
    await expect(emptyMessaging(withRuntimes({ retention: { nameLeasesDays: 7 } }), withRuntimes({ retention: { nameLeasesDays: 1 } }))).resolves.toBeUndefined();
  });

  test("a rejecting releaseHeld is logged, never rejects apply() or abandons the other diffs", async () => {
    const releaseHeld = mock(() => Promise.reject(new Error("boom: releaseHeld")));
    const registerLsp = mock(() => {});
    const warnings: string[] = [];
    const apply = makeApply(baseDeps({ runtimeSdk: { messaging: { releaseHeld } }, registerLsp, log: (m) => warnings.push(m) }));
    await expect(apply(
      { ...withRuntimes({ retention: { nameLeasesDays: 7 } }), lsp: { enabled: false } },
      { ...withRuntimes({ retention: { nameLeasesDays: 1 } }), lsp: { enabled: true } },
    )).resolves.toBeUndefined();
    expect(registerLsp).toHaveBeenCalledTimes(1);
    await flushMicrotasks();
    expect(warnings.some((w) => w.includes("releaseHeld after a retention change failed"))).toBe(true);
  });

  test("apply() does not wait on releaseHeld — a wedged directory must not stall a settings reload", async () => {
    // Asserted by the promise STILL BEING PENDING, not by a stopwatch: a wall-clock budget on a
    // synchronous path is the shape this repo has had CI flakes from.
    let release!: () => void;
    let settled = false;
    const releaseHeld = mock(() => new Promise<void>((r) => { release = () => { settled = true; r(); }; }));
    const apply = makeApply(baseDeps({ runtimeSdk: { messaging: { releaseHeld } } }));
    await apply(withRuntimes({ retention: { nameLeasesDays: 7 } }), withRuntimes({ retention: { nameLeasesDays: 1 } }));
    await flushMicrotasks();
    expect(releaseHeld).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);   // apply() resolved with the call still outstanding
    release();                     // settle it so the pending promise does not leak into the next test
  });

  test("the construction-time options say where they take effect instead of pretending to re-wire a live session", async () => {
    const lines: string[] = [];
    const apply = makeApply(baseDeps({ log: (m) => lines.push(m) }));
    await apply(
      withRuntimes({ winterLeg: { chat: false, dispatch: false, code: false }, winterExecutable: "/a/winter", advisorModel: "m1", winterIdleTimeoutSec: 900 }),
      withRuntimes({ winterLeg: { chat: true, dispatch: false, code: false }, winterExecutable: "/b/winter", advisorModel: "m2", winterIdleTimeoutSec: 60 }),
    );
    expect(lines.filter((l) => l.includes("takes effect for new sessions"))).toHaveLength(3);   // Task 17: winterLeg no longer re-wires anything
    // Task 17: a `false` is accepted and reported as ignored — the engine leg no longer exists
    expect(lines.some((l) => l.includes("winterLeg") && l.includes("the engine leg no longer exists; ignored"))).toBe(true);
  });

  test("an absent runtimes block on both sides is not a change — a daemon that never configures this says nothing", async () => {
    const releaseHeld = mock(() => {});
    const lines: string[] = [];
    const apply = makeApply(baseDeps({ runtimeSdk: { messaging: { releaseHeld } }, log: (m) => lines.push(m) }));
    await apply({ provider: { model: "a" } } as any, { provider: { model: "b" } } as any);
    await flushMicrotasks();
    expect(releaseHeld).not.toHaveBeenCalled();
    expect(lines).toEqual([]);
  });

  test("the FIRST apply after boot (prev === null) narrates nothing, and nudges only for a value that differs from the default", async () => {
    // `prev` is null only when the daemon booted with no usable settings. Treating that as
    // "everything changed" would narrate flips nobody made; treating the DEFAULT windows as a change
    // would nudge a directory that has learned nothing.
    const releaseHeld = mock(() => {});
    const lines: string[] = [];
    const apply = makeApply(baseDeps({ runtimeSdk: { messaging: { releaseHeld } }, log: (m) => lines.push(m) }));

    await apply(null, withRuntimes({ retention: { deliveriesDays: 30, nameLeasesDays: 7 }, winterLeg: { chat: false, dispatch: false, code: false }, winterIdleTimeoutSec: 900 }));
    await flushMicrotasks();
    expect(releaseHeld).not.toHaveBeenCalled();
    expect(lines).toEqual([]);

    // A genuinely first-KNOWN value that is not the default: the nudge is an action, and the
    // directory should re-run a held delivery against it. Still no narration.
    await apply(null, withRuntimes({ retention: { deliveriesDays: 30, nameLeasesDays: 1 } }));
    await flushMicrotasks();
    expect(releaseHeld).toHaveBeenCalledTimes(1);
    expect(lines).toEqual([]);
  });

  // ── Block-presence transitions (review r1, F1) ───────────────────────────────────────────────────
  // The block is `.optional()`, so an absent one is not "unknown": the schema defines it as all legs
  // off, 900 seconds, 30/7. The first `runtimes` key a real user ever writes is usually an unrelated
  // one, and the daemon must not answer that with three flips they did not make.

  test("a runtimes block APPEARING with only an unrelated key narrates nothing and nudges nothing", async () => {
    const releaseHeld = mock(() => {});
    const lines: string[] = [];
    const apply = makeApply(baseDeps({ runtimeSdk: { messaging: { releaseHeld } }, log: (m) => lines.push(m) }));
    // Exactly what a user turning on the memory-key migration for the first time writes.
    await apply({ provider: { model: "a" } } as any, Settings.parse({ ...BASE_SETTINGS, runtimes: { migrations: { memoryKeys: true } } }));
    await flushMicrotasks();
    expect(releaseHeld).not.toHaveBeenCalled();
    expect(lines).toEqual([]);
  });

  test("a runtimes block DISAPPEARING with its values at the defaults narrates nothing and nudges nothing", async () => {
    const releaseHeld = mock(() => {});
    const lines: string[] = [];
    const apply = makeApply(baseDeps({ runtimeSdk: { messaging: { releaseHeld } }, log: (m) => lines.push(m) }));
    await apply(Settings.parse({ ...BASE_SETTINGS, runtimes: {} }), Settings.parse(BASE_SETTINGS));
    await flushMicrotasks();
    expect(releaseHeld).not.toHaveBeenCalled();
    expect(lines).toEqual([]);
  });

  test("a block appearing with a leg actually ON is a real change, and says so", async () => {
    const releaseHeld = mock(() => {});
    const lines: string[] = [];
    const apply = makeApply(baseDeps({ runtimeSdk: { messaging: { releaseHeld } }, log: (m) => lines.push(m) }));
    await apply(Settings.parse(BASE_SETTINGS), Settings.parse({ ...BASE_SETTINGS, runtimes: { winterLeg: { chat: true }, retention: { nameLeasesDays: 1 } } }));
    await flushMicrotasks();
    expect(releaseHeld).toHaveBeenCalledTimes(1);
    expect(lines.filter((l) => l.includes("winterLeg"))).toHaveLength(0);   // Task 17: nothing to report when no key is false
    expect(lines.filter((l) => l.includes("winterIdleTimeoutSec"))).toEqual([]); // unchanged at 900
  });

  test("a blank winterExecutable or advisorModel is the same as absent — not a change to narrate", async () => {
    const lines: string[] = [];
    const apply = makeApply(baseDeps({ log: (m) => lines.push(m) }));
    await apply(Settings.parse({ ...BASE_SETTINGS, runtimes: {} }), Settings.parse({ ...BASE_SETTINGS, runtimes: { winterExecutable: "   ", advisorModel: "" } }));
    expect(lines).toEqual([]);
  });

  test("the log lines carry no self-prefix — daemon.ts already prefixes this file's logger", async () => {
    const lines: string[] = [];
    const apply = makeApply(baseDeps({ log: (m) => lines.push(m) }));
    await apply(Settings.parse({ ...BASE_SETTINGS, runtimes: {} }), Settings.parse({ ...BASE_SETTINGS, runtimes: { winterIdleTimeoutSec: 60 } }));
    expect(lines).toEqual(["runtimes.winterIdleTimeoutSec changed — it takes effect for new sessions"]);
  });
});
