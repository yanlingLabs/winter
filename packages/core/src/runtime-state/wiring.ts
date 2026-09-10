// P8a Task 12: everything the daemon has to do with the runtime spine at boot, in one place.
//
// WHY THIS IS NOT IN `daemon.ts`. The boot sequence is a dozen steps — open, build six repositories,
// recover, backfill, migrate, sweep, schedule, and a deletion hook — and every one of them is
// bounded (a broken runtime store must cost runtime routing and nothing else). Spelling that out
// inline would add a hundred lines to a file that is already 1600, and it would put the boundedness
// argument somewhere no reader of this subsystem would look for it.
//
// THE ONE RULE THIS FILE ENFORCES ABOVE ALL: **BOOT NEVER FAILS HERE.** A corrupt, unreadable or
// newer-schema `runtime-state.db` returns `{ unavailable }`, the daemon starts, and every other
// feature is untouched — nothing else in the daemon depends on the runtime spine in 8a. So every
// door below is wrapped, and the whole construction is wrapped again.
//
// LIVE SETTINGS, NEVER A BOOT SNAPSHOT. `deps.settings()` is re-read on every sweep and every
// migration check, because `settings.json` is hot-swapped and no setting in this daemon may require
// a restart to take effect. That is also why `applySettings` exists: `settings-apply.ts`'s diff path
// calls it, so flipping `runtimes.migrations.memoryKeys` is ANSWERED on a RUNNING daemon (in 8a the
// answer is a refusal — see the §17 phase 5 block below).
import type { RuntimeDirectoryStore } from "@yanlinglabs/winter-runtime-sdk";
import type { SessionStore } from "../sessions/store";
import type { Settings } from "../settings";
import { ProjectionCheckpoints } from "./checkpoints";
import { RuntimeChildren } from "./children";
import { openRuntimeStateDb, type RuntimeStateDb } from "./db";
import { createSqliteRuntimeDirectoryStore } from "./directory-store";
import { RuntimeLeases, processStartedAt, type LeaseProbe } from "./leases";
import { backfillNativeSessions, type BackfillReport } from "./migrations/backfill";
import { RuntimeSessionRecords } from "./records";
import { recoverRuntimeState, type RecoveryHooks, type RecoveryReport } from "./recovery";
import { deleteSessionRuntimeState, retentionFromSettings, sweepRetention } from "./retention";

/** WS-16 §16's housekeeping cadence. Hourly is deliberate: both windows are measured in DAYS, so a
 *  sweep is only ever removing rows that crossed a horizon since the last pass. */
export const RUNTIME_SWEEP_INTERVAL_MS = 60 * 60_000;

/** How long teardown waits for queued §16 deletions before it closes the handle anyway. Bounded so
 *  a wedged chain costs a slow shutdown, never a daemon that will not exit. */
export const RUNTIME_SHUTDOWN_DRAIN_MS = 5_000;

/** The `schema_meta` key that makes §17 phase 5 a ONE-TIME relocation. NOTHING WRITES IT IN 8a — the
 *  migration is refused here (see `startRuntimeState`) — but it is read, so that the build which
 *  eventually performs the relocation never repeats it and never starts narrating about a flag whose
 *  work is already done. 8b owns the write. */
export const MEMORY_KEYS_MIGRATED_MARKER = "memory_keys_migrated";

export interface DaemonRuntimeStateDeps {
  home: string;
  store: SessionStore;
  /** THE LIVE settings holder, read on every call — never a boot snapshot (see the file header). */
  settings: () => Settings | null;
  log?: (line: string) => void;
  /** Default `RUNTIME_SWEEP_INTERVAL_MS`. Injectable so a test can prove the periodic pass runs
   *  without waiting an hour. */
  sweepIntervalMs?: number;
  /** Recovery's own test seams (`RecoveryDeps`): the 8b/8c step hooks, step 4's process probe and
   *  step 8's scan root, whose default is a REAL path on the developer's machine. */
  recovery?: { hooks?: RecoveryHooks; probe?: LeaseProbe; tempScanRoot?: string };
}

/** The runtime spine, open and recovered. 8b's `createRuntimeSdk({ directoryStore })` consumes
 *  `directory`; everything else here is what the daemon itself needs to own the lifecycle. */
export interface RuntimeStateWiring {
  db: RuntimeStateDb;
  records: RuntimeSessionRecords;
  directory: RuntimeDirectoryStore;
  checkpoints: ProjectionCheckpoints;
  leases: RuntimeLeases;
  children: RuntimeChildren;
  /** The twelve-step report from THIS boot. `ok` means every step completed, not that every session
   *  was healthy — read `corrupt` for that (recovery.ts's own header). */
  lastRecovery: RecoveryReport;
  /** §17 phase 4's report, or `null` when the backfill could not run (no provider in settings). */
  lastBackfill: BackfillReport | null;
  /** One retention pass, reading the windows LIVE. Also the door a test drives instead of waiting
   *  out the hourly interval. */
  sweepNow(): Promise<{ deliveriesPruned: number; leasesPruned: number }>;
  /** The reaper's/cleaner's `onDelete` hook. Synchronous by signature because both callers are, so
   *  the async §16 deletion is queued onto one chain and never interleaves with itself. */
  onSessionDeleted(sessionId: string): void;
  /** Resolves once every queued deletion has run. Teardown and tests only. */
  deletionsSettled(): Promise<void>;
  /** `settings-apply.ts`'s diff path: re-checks the opt-in migrations against the new settings. */
  applySettings(next: Settings | null): void;
  /** Stops the sweep timer, drains the queued deletions (bounded), and closes the database. Called
   *  from the daemon's teardown AFTER the ipc server has stopped — see daemon.ts's `stop()`. */
  close(timeoutMs?: number): Promise<void>;
}

/** The runtime spine could not be opened. The daemon starts anyway, with no runtime routing. */
export interface RuntimeStateOffline {
  unavailable: Error;
}

export type DaemonRuntimeState = RuntimeStateWiring | RuntimeStateOffline;

/** Narrowing helper so call sites do not each re-spell the `in` check. */
export function runtimeStateOnline(state: DaemonRuntimeState): RuntimeStateWiring | undefined {
  return "unavailable" in state ? undefined : state;
}

const errText = (e: unknown): string => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));

/**
 * Open the runtime spine, recover it, and leave it running.
 *
 * Called ONCE per daemon life, before the reaper and long before the socket exists: WS-16 §13's
 * recovery must have finished before any client can ask this daemon about a session.
 */
export async function startRuntimeState(deps: DaemonRuntimeStateDeps): Promise<DaemonRuntimeState> {
  const log = deps.log ?? (() => {});
  const { home, store } = deps;

  let rs: RuntimeStateDb;
  try {
    rs = openRuntimeStateDb(home);
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));
    log(`runtime state unavailable, starting without runtime routing: ${errText(error)}`);
    return { unavailable: error };
  }

  try {
    const records = new RuntimeSessionRecords(rs);
    const self = { pid: process.pid, startedAt: processStartedAt(process.pid) };
    const leases = new RuntimeLeases(rs, self);
    const children = new RuntimeChildren(rs);
    const checkpoints = new ProjectionCheckpoints(rs);
    const directory = createSqliteRuntimeDirectoryStore(rs);

    /** Teardown has begun: no new work is accepted, but what is already queued still runs. */
    let closing = false;
    /** The handle is gone. Only the drain's own tasks read this, and only to stop mid-flight. */
    let dbClosed = false;

    // ── §13's twelve steps, before anything else in this daemon can touch a session ──────────────
    // `indexAlreadyRecovered`: the caller built the `SessionStore` — whose constructor runs
    // `recoverAll()` — under this same lock, with no socket open and nothing writing a session log
    // since. Step 1 keeps its integrity check and skips the second full scan of every session's
    // JSONL (review r1, Important 1).
    //
    // NO PER-STEP SINK, deliberately (review r1, Minor 3). Recovery narrates every step, and a
    // healthy boot has twelve of them to narrate; the durable record is `runtime_recovery_attempts`,
    // which it writes regardless. So the daemon reports the SUMMARY plus only the steps that did not
    // complete cleanly — a healthy boot is one line, and a line that does appear means something.
    const lastRecovery = await recoverRuntimeState({
      home, rs, store, self,
      indexAlreadyRecovered: true,
      hooks: deps.recovery?.hooks,
      probe: deps.recovery?.probe,
      tempScanRoot: deps.recovery?.tempScanRoot,
    });
    for (const step of lastRecovery.steps) {
      if (step.outcome === "ok" || step.outcome === "skipped") continue;
      log(`runtime recovery step ${step.step}: ${step.outcome} — ${JSON.stringify(step.detail)}`);
    }
    log(
      `runtime recovery: ${lastRecovery.ok ? "ok" : "incomplete"}, ${lastRecovery.sessionsSeen} session(s), ` +
        `${lastRecovery.markedUnavailable} parked, ${lastRecovery.reclassified.length} child(ren) interrupted, ${lastRecovery.corrupt.length} corrupt`,
    );

    // ── §17 phase 4: every session this daemon already owns gets a record ────────────────────────
    // Idempotent by construction (a session that already has a record is `alreadyPresent`), so it
    // runs at EVERY boot rather than behind a marker — that is what makes it catch up after a
    // release, and after any boot where it could not run.
    let lastBackfill: BackfillReport | null = null;
    const providerId = deps.settings()?.provider?.type;
    if (!providerId) {
      log("runtime backfill skipped: settings.json names no provider (it re-runs at the next boot)");
    } else {
      try {
        lastBackfill = backfillNativeSessions({ rs, store, home, providerId });
        if (lastBackfill.created.length > 0 || lastBackfill.errors.length > 0) {
          log(`runtime backfill: ${lastBackfill.created.length} created, ${lastBackfill.skipped.length} phone-owned, ${lastBackfill.errors.length} failed`);
        }
      } catch (e) {
        log(`runtime backfill failed (it retries at the next boot): ${errText(e)}`);
      }
    }

    // ── §17 phase 5: the opt-in memory-key relocation — REFUSED IN THIS BUILD ────────────────────
    //
    // CONTROLLER RULING (review r1, Important 2). The migration itself works and is fully tested
    // (`migrations/memory-keys.ts` and its unit tests are 8b's to switch on), but the LIVE memory
    // path does not follow it yet: `agent/memory-dir.ts`'s `memoryDirFor` still derives
    // `sanitizeProjectKey(repoRootFor(cwd))`, the OLD key. Running the migration today would move
    // the user's `MEMORY.md` to the compatibility key, leave the agent reading an empty directory at
    // the old one, and start a fresh memory file there — one-way (the `schema_meta` marker makes it
    // one-shot), with `rollbackMemoryKeyMigration` unreachable from the CLI. So the flag is
    // ACKNOWLEDGED AND IGNORED here rather than half-honoured, and 8b re-enables it in one place the
    // day `memoryDirFor` reads the record's own key.
    const markerIsSet = (): boolean =>
      rs.db.query("SELECT value FROM schema_meta WHERE key = ?").get(MEMORY_KEYS_MIGRATED_MARKER) != null;

    /** Answer `runtimes.migrations.memoryKeys`. Called at boot AND from `settings-apply.ts`'s diff
     *  path, so a user who flips the flag on a running daemon gets the answer immediately rather
     *  than at the next restart. Nothing is planned, applied or marked; a flag left off says
     *  nothing at all. NEVER THROWS. */
    const runMemoryKeyMigration = (settings: Settings | null): void => {
      if (closing) return;
      if (settings?.runtimes?.migrations?.memoryKeys !== true) return;
      if (markerIsSet()) return; // a build that DID migrate must not start narrating about it again
      log(
        "memory-key migration is not enabled in this build: the live memory path moves in Phase 8b; the flag is ignored",
      );
    };
    runMemoryKeyMigration(deps.settings());

    // ── §16 retention: at boot, then hourly, always off the LIVE windows ─────────────────────────
    const sweepNow = async (): Promise<{ deliveriesPruned: number; leasesPruned: number }> => {
      if (closing) return { deliveriesPruned: 0, leasesPruned: 0 };
      return await sweepRetention(directory, retentionFromSettings(deps.settings() ?? undefined));
    };
    const sweep = async (): Promise<void> => {
      try {
        const swept = await sweepNow();
        if (swept.deliveriesPruned > 0 || swept.leasesPruned > 0) {
          log(`runtime retention: pruned ${swept.deliveriesPruned} receipted deliver(ies), ${swept.leasesPruned} released name lease(s)`);
        }
      } catch (e) {
        log(`runtime retention sweep failed (it runs again at the next interval): ${errText(e)}`);
      }
    };
    await sweep();
    // `unref` so an idle daemon is never held awake by housekeeping — the same shape the dreamer's
    // and the routine scheduler's timers use.
    const timer = setInterval(() => void sweep(), deps.sweepIntervalMs ?? RUNTIME_SWEEP_INTERVAL_MS);
    timer.unref?.();

    // ── §16 deletion: one chain, so two deletions can never interleave ──────────────────────────
    // The reaper and the cleaner are both synchronous, and `deleteSessionRuntimeState` is not (the
    // directory seam is async), so the hook queues rather than awaits. Nothing on either caller's
    // path depends on the outcome: the session is already gone, and this is its runtime metadata
    // catching up.
    let deletions: Promise<void> = Promise.resolve();
    const onSessionDeleted = (sessionId: string): void => {
      if (closing) return; // teardown has begun; the store is about to close under us
      deletions = deletions.then(async () => {
        if (dbClosed) return; // the bounded drain gave up on us — the handle is gone
        try {
          const { removed } = await deleteSessionRuntimeState({ rs, records, leases, children, directory }, sessionId);
          if (removed.length > 0) log(`runtime state deleted for ${sessionId}: ${removed.join(", ")}`);
        } catch (e) {
          log(`runtime state delete failed for ${sessionId}: ${errText(e)}`);
        }
      });
    };

    return {
      db: rs, records, directory, checkpoints, leases, children,
      lastRecovery, lastBackfill,
      sweepNow,
      onSessionDeleted,
      deletionsSettled: () => deletions,
      applySettings: runMemoryKeyMigration,
      /**
       * Stop the sweep, DRAIN the queued deletions, then close the database.
       *
       * The drain is why this is async (review r1, Minor 5). A deletion queued microseconds before
       * shutdown — the mint-time reap inside the ipc server is the one that can race it — has only
       * reached the microtask queue, and a synchronous teardown would close the handle out from
       * under it and lose the §16 delete for good: the residue is a runtime record whose product
       * session no longer exists, which nothing currently reports. BOUNDED, so a wedged chain
       * delays shutdown by at most `timeoutMs` and then loses the handle rather than the process.
       */
      async close(timeoutMs = RUNTIME_SHUTDOWN_DRAIN_MS) {
        if (closing) return;
        closing = true;
        clearInterval(timer);
        let cap: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            deletions,
            new Promise<void>((resolve) => {
              cap = setTimeout(resolve, timeoutMs);
            }),
          ]);
        } catch {
          /* the chain never rejects (each task has its own catch); belt only */
        } finally {
          if (cap) clearTimeout(cap);
        }
        dbClosed = true;
        rs.close();
      },
    };
  } catch (e) {
    // Construction itself failed (not the store's own refusal, which is caught above). The daemon
    // still starts; the handle we opened does not leak.
    const error = e instanceof Error ? e : new Error(String(e));
    log(`runtime state could not be wired, starting without runtime routing: ${errText(error)}`);
    try {
      rs.close();
    } catch {
      /* best effort */
    }
    return { unavailable: error };
  }
}
