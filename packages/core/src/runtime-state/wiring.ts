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
// calls it, so flipping `runtimes.migrations.memoryKeys` is ANSWERED on a RUNNING daemon (since
// P8b-17 that answer is the migration itself, plus the relocation map the live memory path reads —
// see the §17 phase 5 block below).
import type { RuntimeDirectoryStore } from "@yanlinglabs/winter-runtime-sdk";
import type { SessionStore } from "../sessions/store";
import type { Settings } from "../settings";
import { ProjectionCheckpoints } from "./checkpoints";
import { RuntimeChildren } from "./children";
import { openRuntimeStateDb, type RuntimeStateDb } from "./db";
import { createSqliteRuntimeDirectoryStore } from "./directory-store";
import { RuntimeLeases, processStartedAt, type LeaseProbe } from "./leases";
import { backfillNativeSessions, type BackfillReport } from "./migrations/backfill";
import { applyMemoryKeyMigration, memoryKeyRelocations, planMemoryKeyMigration, reconcileMemoryKeyManifest, type MemoryKeyFs } from "./migrations/memory-keys";
import { RuntimeSessionRecords } from "./records";
import { recoverRuntimeState, type RecoveryHooks, type RecoveryReport } from "./recovery";
import { deleteSessionRuntimeState, retentionFromSettings, sweepRetention } from "./retention";

/** WS-16 §16's housekeeping cadence. Hourly is deliberate: both windows are measured in DAYS, so a
 *  sweep is only ever removing rows that crossed a horizon since the last pass. */
export const RUNTIME_SWEEP_INTERVAL_MS = 60 * 60_000;

/**
 * How long teardown waits for queued §16 deletions before it closes the handle anyway.
 *
 * MUST STAY UNDER THE APP'S GRACE PERIOD. `DaemonSupervisor.gracefulExitTimeout` (2.0 s,
 * `apple/Norma/Sources/App/DaemonSupervisor.swift`) is how long the app waits after SIGTERM before
 * escalating to SIGKILL — so a drain budgeted above that would be force-killed mid-drain, losing the
 * deletion it was waiting for AND the `lock.release()` behind it, which is what unlinks the socket.
 * A stale socket sends the supervisor into `.connectOnly` on the next launch. 1500 ms leaves the
 * rest of teardown room inside the 2 s and still covers a drain that is, in practice, microtasks.
 */
export const RUNTIME_SHUTDOWN_DRAIN_MS = 1_500;

/** The `schema_meta` key that makes §17 phase 5 a ONE-TIME relocation (P8b-17 writes it, 8a only
 *  read it). Written when a run finishes with NOTHING LEFT TO DO — no collision to clear, no
 *  unresolved record whose cwd might come back — so that a home which has migrated never re-plans
 *  and never starts narrating about a flag whose work is already done, while a home that was only
 *  partly able to migrate still gets another attempt at the next boot. */
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
  /** §17 phase 5's filesystem seam (`MemoryKeyFs`). Injectable for ONE reason: the two failures this
   *  wiring has to survive — a repair that throws, and an apply that throws after a committed move —
   *  are both mid-`rename` failures, and a test cannot produce either by arranging files. */
  memoryKeyFs?: MemoryKeyFs;
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
  /**
   * P8b-17's live half: where a project key's memory ACTUALLY is, for a home that has run §17
   * phase 5. `undefined` for every key that was never relocated — which is every key in a home that
   * never turned the flag on, so this is inert by default.
   *
   * Wired straight into `agent/memory-dir.ts`'s `relocatedKey` at `daemon.ts`, because every live
   * memory read is keyed by cwd and would otherwise still derive the pre-migration key. Read live
   * (never snapshotted): flipping the flag on a RUNNING daemon relocates the trees and this answer
   * must change with them, in the same breath.
   */
  relocatedMemoryKey(todaysKey: string): string | undefined;
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

/**
 * An error's TYPE and nothing else — the rule `recovery.ts`'s header states and this file must not
 * disagree with (whole-branch review, M7).
 *
 * An error MESSAGE routinely quotes the payload that produced it: `JSON.parse` echoes the bytes it
 * choked on, and on these paths those bytes are session records, directory entries and message
 * envelopes. Nothing here is worth a line that could carry one, because every one of these failures
 * is already written to `runtime_recovery_attempts` or is a repeat-next-boot condition.
 */
const errName = (e: unknown): string => (e instanceof Error ? e.name : "unknown");

/** Type AND message. Reserved for the two failures whose message is a REASON and a PATH that this
 *  daemon composed itself (`RuntimeStateUnavailableError`: `runtime-state.db corrupt: <path>`) —
 *  the operator cannot act on "the store did not open" without them, and no payload can reach it. */
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
        log(`runtime backfill failed (it retries at the next boot): ${errName(e)}`);
      }
    }

    // ── §17 phase 5: the opt-in memory-key relocation — LIVE IN THIS BUILD (P8b-17) ──────────────
    //
    // 8a shipped this REFUSED, for one reason: the live memory path still derived today's key, so a
    // relocation would have moved the user's `MEMORY.md` under a key nothing read. All four of
    // P8b-17's preconditions now hold (they are spelled out in `migrations/memory-keys.ts`'s
    // header), and the two halves commit together here: the relocation map below is what
    // `agent/memory-dir.ts` consults, and it is built from the very rows the re-key was committed
    // with. A daemon therefore never reads an empty memory directory because of a half-switch.
    //
    // REPAIRED AND BUILT AT EVERY BOOT, FLAG OR NO FLAG. The map describes what SOME PAST run
    // relocated; a home that migrated last month and has the flag off today must still find its own
    // memory. And the repair has to be unconditional for the same reason: a process lost inside the
    // rename/commit window leaves entries whose rows are still `planned` — invisible to `rollback`
    // and to this map — and turning the flag back off must not be what strands them.
    //
    // WRAPPED LIKE THE BACKFILL ABOVE IT, and for the identical reason (review r1, M-2): since this
    // runs on EVERY boot of EVERY home — including the overwhelming majority that never enabled the
    // flag and have an empty manifest — it is the one statement here that every user pays for. A
    // throw would fall to the outer catch, close the handle and cost the whole runtime spine for a
    // repair that had nothing to repair. The map defaults to empty, which is the honest answer when
    // the manifest could not be read: the live path then derives today's key, exactly as it does on
    // a home that never migrated.
    let relocations = new Map<string, string>();
    try {
      const torn = reconcileMemoryKeyManifest({ rs, home, records, fs: deps.memoryKeyFs });
      if (torn.length > 0) log(`memory-key migration: completed ${torn.length} relocation(s) a previous run left half-committed`);
      relocations = memoryKeyRelocations(rs);
    } catch (e) {
      log(`memory-key repair failed (it retries at the next boot): ${errName(e)}`);
    }

    const markerIsSet = (): boolean =>
      rs.db.query("SELECT value FROM schema_meta WHERE key = ?").get(MEMORY_KEYS_MIGRATED_MARKER) != null;

    /** A DECLINE IS NOT AN ATTEMPT: it costs nothing to re-check, so clearing `memory.directory` on
     *  a running daemon still gets the migration — no restart, per the hard rule. Only the narration
     *  is suppressed, or every unrelated settings edit would repeat it. */
    let declineLogged = false;
    /** Refusals are re-logged ONCE PER BOOT (P8b-29). A refused project is a fact about the user's
     *  disk that they have to act on, so it must be said — but `applySettings` runs on every
     *  settings change, and repeating the same list on each of them is how a line stops being read. */
    let refusalsLogged = false;

    /**
     * Answer `runtimes.migrations.memoryKeys`. Called at boot AND from `settings-apply.ts`'s diff
     * path, so a user who flips the flag on a running daemon gets the migration immediately rather
     * than at the next restart. A flag left off says nothing at all. NEVER THROWS — a migration that
     * cannot run costs the relocation and nothing else; the daemon is already serving.
     *
     * NO ONE-ATTEMPT-PER-PROCESS RULE (P8b-29, replacing review nit N-3). A project now refuses on
     * its own and the manifest records the state per entry, so re-running is idempotent and the
     * obstruction a user just cleared is picked up on their NEXT SETTINGS CHANGE rather than only on
     * a restart. The cost of a re-plan (a directory sweep plus a git spawn per distinct cwd) is paid
     * only while the flag is on AND the migration is unfinished — the marker short-circuits the
     * moment there is nothing left to do.
     */
    const runMemoryKeyMigration = (settings: Settings | null): void => {
      if (closing) return;
      if (settings?.runtimes?.migrations?.memoryKeys !== true) return;
      try {
        // INSIDE THE GUARD, every statement of it (re-review NEW-7). `markerIsSet` is a bare SELECT
        // over `schema_meta`, and sitting one line above the `try` it was the single path by which
        // this function could still throw — at boot, straight into `startRuntimeState`'s outer catch,
        // which closes the handle and costs the WHOLE runtime spine for a migration that had nothing
        // to migrate. The contract in the docstring is only a contract if nothing is outside this.
        if (markerIsSet()) return; // a home that DID migrate must not start narrating about it again
        const plan = planMemoryKeyMigration({ rs, home, records, store, memoryDirectory: settings?.memory?.directory, fs: deps.memoryKeyFs });
        // Declined, NOT done: no marker, so clearing `memory.directory` on THIS running daemon still
        // gets a migration. The decline refuses before the plan touches the disk or spawns git, so
        // re-entering it on every settings change is free.
        if (plan.declined === "memory-directory-override") {
          if (!declineLogged) {
            declineLogged = true;
            log("memory-key migration declined: settings.memory.directory pins this home's MEMDIR, so the project key decides nothing (clear it to migrate)");
          }
          return;
        }
        if (plan.reconciled && plan.reconciled.length > 0) {
          log(`memory-key migration: completed ${plan.reconciled.length} relocation(s) a previous run left half-committed`);
        }
        const { moved, movedEntries, refused } = applyMemoryKeyMigration({ rs, home, fs: deps.memoryKeyFs }, plan);
        // Everything that refused THIS RUN: the projects the plan found blocked, plus any that
        // became blocked between plan and apply. Each refused itself alone; the rest are relocated.
        const refusals = [...plan.collisions, ...refused];
        if (moved > 0 || refusals.length > 0 || plan.unresolved.length > 0) {
          log(
            `memory-key migration: ${moved} project(s) relocated (${movedEntries} entr(ies)), ${refusals.length} refused, ${plan.unresolved.length} skipped, ${plan.unchanged.length} already current`,
          );
        }
        if (refusals.length > 0 && !refusalsLogged) {
          refusalsLogged = true;
          for (const c of refusals) {
            log(
              `memory-key migration refused ${c.oldKeys.join(", ")} → ${c.newKey}: ${c.reason}` +
                (c.entries && c.entries.length > 0 ? ` (${c.entries.join(", ")})` : "") +
                `; clear it and change a setting or reboot to retry`,
            );
          }
        }
        // THE MARKER MEANS "NOTHING LEFT TO DO", not "we ran once". A refusal is an obstruction the
        // operator can clear, and an `unresolved` record's cwd can come back — both deserve another
        // attempt, and marking now would deny them one forever.
        if (refusals.length === 0 && plan.unresolved.length === 0) {
          rs.db.run("INSERT INTO schema_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [
            MEMORY_KEYS_MIGRATED_MARKER,
            new Date().toISOString(),
          ]);
        }
      } catch (e) {
        // The migration refuses rather than half-moves (its own header), so a throw here means
        // nothing was left torn that the next boot's plan cannot settle. The TYPE only: a message
        // could quote a path out of somebody's home.
        log(`memory-key migration failed (it retries at the next change or boot): ${errName(e)}`);
      } finally {
        // UNCONDITIONALLY, and this is the half-switch guard (review r1, M-1). `apply` commits PER
        // ENTRY and `plan` commits its reconciliations before apply is even called, so a throw from a
        // later entry leaves the manifest and the records correctly saying `old → new` while this
        // in-process map still does not — and for the rest of the daemon's life the live MEMDIR path
        // would resolve a directory that is no longer there and start a second `MEMORY.md` beside the
        // user's own. Rebuilt here, the map always describes what is actually committed.
        //
        // AND GUARDED, because a `finally` sits OUTSIDE the catch above it: an unguarded throw here
        // escapes `runMemoryKeyMigration` — whose contract two lines up is "never throws" — and at
        // boot lands in `startRuntimeState`'s outer catch, which closes the handle and costs the
        // whole runtime spine (re-review NEW-2, the same failure class M-2 was raised about). The
        // conditions that make the migration throw are exactly the ones that would make this
        // `SELECT` throw too.
        //
        // ON FAILURE THE PREVIOUS MAP IS KEPT, AND THAT IS A TRADE, NOT A SAVE. A rebuild that fails
        // BEFORE anything committed leaves a map that is simply still correct; one that fails AFTER
        // entries committed leaves a map that is wrong about a relocation that HAS happened — M-1's
        // harm, reached the other way round. It is still the better of the two available answers: the
        // alternative is an offline spine, which answers `undefined` for every key and therefore has
        // exactly the same effect on the memory path plus the loss of every other runtime feature.
        // The manifest is untouched either way, so the next boot rebuilds from the truth.
        try {
          relocations = memoryKeyRelocations(rs);
        } catch (e) {
          log(`memory-key map could not be rebuilt; the live memory path is using the last known map: ${errName(e)}`);
        }
      }
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
        log(`runtime retention sweep failed (it runs again at the next interval): ${errName(e)}`);
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
          const { removed, retainedUnreceipted } = await deleteSessionRuntimeState({ rs, records, leases, children, directory }, sessionId);
          if (removed.length > 0) log(`runtime state deleted for ${sessionId}: ${removed.join(", ")}`);
          // The delete stopped short ON PURPOSE: those rows are somebody else's `delivery_uncertain`
          // evidence (WS-15 §6.4), and an audit that did not say so would read as a missed delete.
          if (retainedUnreceipted.length > 0) {
            log(`runtime state delete for ${sessionId} retained ${retainedUnreceipted.length} claimed-unreceipted deliver(ies): ${retainedUnreceipted.join(", ")}`);
          }
        } catch (e) {
          log(`runtime state delete failed for ${sessionId}: ${errName(e)}`);
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
      relocatedMemoryKey: (todaysKey: string) => relocations.get(todaysKey),
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
