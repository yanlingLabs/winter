import type { Settings } from "./settings";
import { memoryEnabledFrom } from "./settings";
import type { ToolRegistry } from "./agent/tools/registry";
import type { ComputerUseService } from "./agent/computer-use";
import type { LspManager } from "./agent/lsp/manager";

/** Error → message without assuming the thrown value is an Error (a `throw "str"` must not become
 *  `undefined`). Mirrors settings-watcher.ts's own `msg` helper — kept local rather than shared
 *  since the two files have no other coupling. */
const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export interface SettingsApplyDeps {
  /** THE atomic swap: `settings = s` in daemon.ts, a single synchronous assignment. Runs FIRST,
   *  before any await, so value-only reads go live immediately even while a drain awaits below. */
  setLiveSettings: (s: Settings) => void;
  registry: ToolRegistry;
  // computer-use:
  buildComputerService: (s: Settings) => ComputerUseService; // rebuild reading current screenshotMaxDim/peripheral
  registerComputer: (svc: ComputerUseService, s: Settings) => void; // registerComputerTool(registry, {screenshotMaxDim})
  teardownComputer: () => Promise<void> | void; // drain in-flight, then unregister "computer" + stop service
  computerInFlight: () => boolean; // is a `computer` call executing right now? (drain gate)
  // lsp:
  buildLspManager: (s: Settings) => LspManager;
  registerLsp: (mgr: LspManager) => void; // registerLspTools(registry, {...})
  teardownLsp: () => Promise<void> | void; // unregister the `lsp` tool + lspManager.stopAll()
  // File-based memory hot-toggle (T3, design doc follow-up / task-23): re-runs the T2 migration
  // importer (`migrateMemoryStore`, agent/memory-migrate.ts) the moment `memory.enabled` flips
  // false→true on an ALREADY-RUNNING daemon — closing the gap T2 left (boot-time-only migration,
  // per that task's own "Concerns carried forward" #3): without this, a mid-session flip makes the
  // RPCs/write-root hot immediately (daemon.ts's `memoryEnabledHot` closures) but leaves the OLD
  // 5b store's facts unmigrated until the next restart, which grates against the project's
  // no-daemon-restart-for-settings rule. Optional (default no-op) so every pre-T3 `SettingsApplyDeps`
  // literal (this file's own test helper included) keeps compiling unchanged. Called fire-and-forget
  // (see `applyMemoryMigrationDiff` below) — migration walks every trusted dir + spawns `git` per
  // dir (repoRootFor), never worth making the settings-watcher's single-flight apply() wait on it.
  migrateMemory?: () => void | Promise<void>;
  /** P8a Task 12: the runtime spine's opt-in migrations, re-checked against the NEW settings
   *  (`runtime-state/wiring.ts`'s `applySettings`). Not a flip diff like the two above — the wiring
   *  guards itself with a `schema_meta` marker, so "run it if the flag is on and it has never
   *  completed" is both the boot rule and the hot rule, and passing `next` unconditionally is what
   *  makes flipping `runtimes.migrations.memoryKeys` on a RUNNING daemon take effect with no
   *  restart. Synchronous and total by contract (it logs and returns rather than throwing), so it
   *  needs neither the `Promise.all` below nor a drain. Optional — every pre-8a caller (and this
   *  file's own test helper) keeps compiling unchanged. */
  applyRuntimeMigrations?: (next: Settings) => void;
  /**
   * P8b Task 15: the Winter runtime handle, for the ONE settings change it has to be told about.
   *
   * STRUCTURALLY TYPED, AND EVERY HOP OPTIONAL, deliberately. The handle is Task 5's
   * (`runtime-sdk/create.ts`) and its `messaging` is Task 12's; neither exists in this lane, and
   * importing the SDK's types here would couple the settings layer to a package it otherwise never
   * mentions. What this file needs is narrow enough to state inline: something that MIGHT carry a
   * `releaseHeld`. Until those tasks land, every daemon passes nothing and the call is a no-op —
   * which is exactly what the optional chain says.
   */
  runtimeSdk?: { messaging?: { releaseHeld?: () => void | Promise<void> } };
  drainTimeoutMs?: number; // default 10000 — cap on the CU-disable drain wait
  drainIntervalMs?: number; // default 50 — poll interval while draining
  sleep?: (ms: number) => Promise<void>; // injectable clock (default Bun.sleep) so the cap test never waits real seconds
  log?: (msg: string) => void;
}

/**
 * Builds the `(prev, next) => Promise<void>` apply function the SettingsWatcher (T3) calls on
 * every settled settings.json change. T3 already single-flights (at most one apply in flight at
 * a time), so this function needs no internal locking of its own.
 *
 * Order matters: the atomic swap happens FIRST, synchronously, before either feature-flag diff —
 * so plain value reads (thresholds, models, etc.) go live immediately even while a CU-disable
 * drain below is still awaiting.
 */
export function makeApply(deps: SettingsApplyDeps): (prev: Settings | null, next: Settings) => Promise<void> {
  const drainTimeoutMs = deps.drainTimeoutMs ?? 10_000;
  const drainIntervalMs = deps.drainIntervalMs ?? 50;
  const sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms));
  const log = deps.log ?? (() => {});

  // Per-flag polarity — the two flags have OPPOSITE defaults, so a single `!!` form is wrong for
  // one of them. These mirror the exact boot gates in daemon.ts so `prev` (boot settings) yields
  // the true registered-at-boot state, INCLUDING the absent-block boundary:
  //   - computerUse: opt-in / default-OFF  (daemon.ts `if (settings?.computerUse?.enabled)`) —
  //     absent block ⇒ NOT registered. `cuEnabled(null)` ⇒ false.
  //   - lsp: opt-out / default-ON (daemon.ts `if (lspCfg?.enabled !== false)`, same `!== false`
  //     convention as hooks/reviewer) — absent block ⇒ registered. `lspEnabled(null)` ⇒ true.
  const cuEnabled = (s: Settings | null) => !!s?.computerUse?.enabled;
  const lspEnabled = (s: Settings | null) => s?.lsp?.enabled !== false;
  // memory: default-ON / opt-out, same polarity as lsp — mirrors daemon.ts's own
  // `memoryEnabledHot` (`settings ? memoryEnabledFrom(settings) : true`) rather than re-deriving
  // the `!== false` shape locally, so the two can never drift apart.
  const memoryEnabled = (s: Settings | null) => (s ? memoryEnabledFrom(s) : true);

  async function applyComputerUseDiff(prev: Settings | null, next: Settings): Promise<void> {
    const wasEnabled = cuEnabled(prev);
    const isEnabled = cuEnabled(next);
    if (wasEnabled === isEnabled) return; // no flip — value-only change already applied by the swap

    if (isEnabled) {
      const svc = deps.buildComputerService(next);
      deps.registerComputer(svc, next);
      return;
    }

    // disabling: never yank a live `computer` call — drain first, bounded by drainTimeoutMs.
    // The cap is expressed as an ITERATION count (drainTimeoutMs / drainIntervalMs) over the
    // injected `sleep`, not real Date.now() — so a fast injected sleep makes the whole drain
    // (cap included) resolve near-instantly in tests, regardless of how large drainTimeoutMs is.
    if (deps.computerInFlight()) {
      const maxTicks = Math.max(1, Math.ceil(drainTimeoutMs / drainIntervalMs));
      let ticks = 0;
      while (deps.computerInFlight() && ticks < maxTicks) {
        await sleep(drainIntervalMs);
        ticks++;
      }
      if (deps.computerInFlight()) {
        // cap exceeded — the user's disable intent wins; teardown anyway (never leave CU
        // registered-but-disabled). The in-flight promise will reject when torn down; the engine
        // treats that as a tool error, not a crash.
        log("settings-apply: computerUse disable drain exceeded drainTimeoutMs — tearing down with a call still in flight");
      }
    }
    await deps.teardownComputer();
  }

  async function applyLspDiff(prev: Settings | null, next: Settings): Promise<void> {
    const wasEnabled = lspEnabled(prev);
    const isEnabled = lspEnabled(next);
    if (wasEnabled === isEnabled) return; // no flip

    if (isEnabled) {
      const mgr = deps.buildLspManager(next);
      deps.registerLsp(mgr);
    } else {
      await deps.teardownLsp();
    }
  }

  /** Fires (never awaits) `deps.migrateMemory` on exactly a `memory.enabled` false→true flip —
   *  true→false and no-flip (incl. both-absent/both-true, the common case) are no-ops, and a
   *  missing `deps.migrateMemory` (every pre-T3 test/caller) is a no-op too. Deliberately NOT
   *  folded into the `Promise.all` below alongside the CU/LSP diffs: unlike those two (which the
   *  settings-watcher's single-flight `apply()` SHOULD wait on — they gate whether a tool is
   *  registered before the next turn), migration is a best-effort background catch-up with no
   *  caller waiting on its completion, so blocking `apply()` on it would only slow down every other
   *  hot-reload for no benefit. `Promise.resolve().then(...)` (rather than a bare call) also catches
   *  a SYNCHRONOUS throw from `migrateMemory` (today's `migrateMemoryStore` is sync), not just a
   *  rejected promise, so the one `.catch` below covers both call shapes. */
  function applyMemoryMigrationDiff(prev: Settings | null, next: Settings): void {
    const wasEnabled = memoryEnabled(prev);
    const isEnabled = memoryEnabled(next);
    if (wasEnabled || !isEnabled) return; // only a false→true flip re-runs the importer
    if (!deps.migrateMemory) return;
    Promise.resolve()
      .then(() => deps.migrateMemory!())
      .catch((err) => log(`memory migration on hot-toggle failed (best-effort, will retry next boot): ${errMsg(err)}`));
  }

  /**
   * P8b Task 15: the router's PLAIN-VALUE options, which a running daemon cannot simply re-read.
   *
   * Surface map §8.3 is the reason this diff exists at all. `createRuntimeSdk` takes `brand`,
   * `retention`, `advisor` and `official.env` as VALUES at construction, while the inbound-policy
   * hooks are functions and therefore hot by construction. A value that a setting can change has
   * only two honest answers: a getter the router calls, or a documented "this reaches new sessions".
   * This function is where that decision is stated for each key, once:
   *
   *   retention  — the daemon re-applies the windows itself on every sweep, off the LIVE settings
   *                (`runtime-state/retention.ts`'s `retentionFromSettings`), so nothing needs
   *                rebuilding. What DOES need telling is the directory: a shortened name-lease
   *                window can free a name a sender is holding a message for, and `releaseHeld` is
   *                what re-runs that delivery instead of leaving it parked until the next event.
   *   winterLeg  — governs NEW sessions only (P8b-13). A live session runs to completion on the leg
   *                it was created with, so there is nothing to re-wire; Task 9's `legForNewSession`
   *                reads the live holder at create time.
   *   winterExecutable / advisorModel / winterIdleTimeoutSec — read at the same live holder by
   *                Task 5's `spawnHookFor`/`create.ts` and Task 16's idle timer, so a change reaches
   *                the next session with no rebuild and no restart.
   *
   * So the ONLY action here is the directory nudge; everything else is narrated, because a user who
   * flips a leg and sees nothing happen to their open chat should be able to find out why from the
   * log rather than from this comment.
   *
   * SYNCHRONOUS AND NEVER THROWING for the same reason `applyRuntimeMigrations` is: it runs on the
   * single-flight apply path, and a throw here would leave `prevSnapshot` un-advanced and re-diff
   * the same change forever (the F1 argument below). `releaseHeld` may be async; it is fired, never
   * awaited — no caller on this path depends on a delivery having landed.
   */
  function applyRuntimeOptionsDiff(prev: Settings | null, next: Settings): void {
    const before = prev?.runtimes;
    const after = next.runtimes;
    const retentionChanged =
      before?.retention?.deliveriesDays !== after?.retention?.deliveriesDays ||
      before?.retention?.nameLeasesDays !== after?.retention?.nameLeasesDays;
    if (retentionChanged) {
      // OPTIONAL AT EVERY HOP: the handle is Task 5's and `messaging` is Task 12's, so on today's
      // daemon this resolves to `undefined` and does nothing. It is written now because the settings
      // change and the thing that has to hear about it belong together, not because it is reachable.
      const release = deps.runtimeSdk?.messaging?.releaseHeld;
      if (release) {
        Promise.resolve()
          .then(() => release())
          .catch((err) => log(`releaseHeld after a retention change failed (best-effort): ${errMsg(err)}`));
      }
    }
    // NO NARRATION ON THE FIRST APPLY (`prev === null`, a daemon that booted with no settings at
    // all). "It takes effect for new sessions" is a message about sessions that predate the change,
    // and at that point there are none — saying it anyway would train a reader to ignore the line
    // that matters. The retention nudge above is different: it is an action, not a message, and a
    // directory that has just learned its windows is exactly when it should re-run a held delivery.
    if (prev === null) return;
    const legChanged =
      before?.winterLeg?.chat !== after?.winterLeg?.chat ||
      before?.winterLeg?.dispatch !== after?.winterLeg?.dispatch ||
      before?.winterLeg?.code !== after?.winterLeg?.code;
    if (legChanged) log("settings-apply: runtimes.winterLeg changed — it takes effect for new sessions; open sessions finish on the leg they were created with");
    if (before?.winterExecutable !== after?.winterExecutable) log("settings-apply: runtimes.winterExecutable changed — it takes effect for new sessions");
    if (before?.advisorModel !== after?.advisorModel) log("settings-apply: runtimes.advisorModel changed — it takes effect for new sessions");
    if (before?.winterIdleTimeoutSec !== after?.winterIdleTimeoutSec) log("settings-apply: runtimes.winterIdleTimeoutSec changed — it takes effect for new sessions");
  }

  return async function apply(prev: Settings | null, next: Settings): Promise<void> {
    deps.setLiveSettings(next); // THE ATOMIC SWAP — first, synchronous, one statement.
    // Fire-and-forget, NOT awaited and NOT inside the Promise.all below — see the function's own
    // doc comment for why this diff is treated differently from CU/LSP.
    applyMemoryMigrationDiff(prev, next);
    // P8a Task 12: the runtime spine's own opt-in migrations. Wrapped even though the wiring never
    // throws — a settings apply that died here would leave `prevSnapshot` un-advanced and re-diff
    // the same change forever (the F1 argument below, applied to this call too).
    try {
      deps.applyRuntimeMigrations?.(next);
    } catch (err) {
      log(`runtime migrations apply failed (best-effort, retried at the next change): ${errMsg(err)}`);
    }
    // P8b Task 15: the router's plain-value options. Its own try/catch for the same reason.
    try {
      applyRuntimeOptionsDiff(prev, next);
    } catch (err) {
      log(`runtime options apply failed (best-effort, retried at the next change): ${errMsg(err)}`);
    }
    // Independent flips: a long CU-disable drain must not stall the LSP re-wire in the same
    // reload, so the two diffs run concurrently.
    //
    // Whole-branch review F1: each diff runs inside its OWN try/catch so a throw in one can NEITHER
    // reject the aggregate apply NOR abandon the other diff. Every register/teardown path is
    // throw-safe today (this is unreachable in practice), but the spec's "never half-applies"
    // guarantee must be STRUCTURAL, not luck: were a diff to throw and propagate, Promise.all would
    // reject → T3's watcher keeps prevSnapshot (no advance) → the NEXT reload re-diffs the SAME
    // flip → re-register throws "duplicate tool" → every subsequent apply throws → CU/LSP hot-apply
    // is dead for the daemon's life. Catching per-flag makes `apply` always resolve (so prevSnapshot
    // advances and there's no re-diff-of-same-flip wedge); a hypothetical single-flag failure
    // degrades to best-effort-until-the-next-change instead of a total permanent wedge. The atomic
    // swap above is deliberately OUTSIDE both try/catches — it's a single synchronous assignment
    // that cannot throw, and it must always win regardless of either diff's fate.
    await Promise.all([
      (async () => {
        try {
          await applyComputerUseDiff(prev, next);
        } catch (err) {
          log(`computerUse diff-apply failed (hot-apply left best-effort until the next change): ${errMsg(err)}`);
        }
      })(),
      (async () => {
        try {
          await applyLspDiff(prev, next);
        } catch (err) {
          log(`lsp diff-apply failed (hot-apply left best-effort until the next change): ${errMsg(err)}`);
        }
      })(),
    ]);
  };
}
