// WS-16 §13's daemon startup recovery: twelve steps, run once at boot, over `runtime-state.db` and
// the product event store.
//
// THE ONE PROPERTY THIS FILE EXISTS FOR: "Recovery MUST be bounded. A corrupt or unavailable session
// must not block the daemon or every other session." So every per-session operation runs inside its
// own try/catch — a session that throws is recorded under `corrupt`, parked `unavailable` when that
// is still possible, and the sweep continues. `RecoveryReport.ok` therefore answers "did every step
// complete", NOT "was every session healthy": a handled per-session throw is this guarantee working,
// and a daemon that refused to boot over one unreadable row would be the outage the boundedness
// clause was written to prevent. `corrupt` is the orthogonal answer, and it is what an operator (and
// `norma doctor`) reads.
//
// WHAT IS AND IS NOT IMPLEMENTED IN 8a. Steps 3, 5 (reattach), 6 and 10 are seams whose real work
// belongs to 8b/8c — they are hooks with an explicit default of "nothing reattached / skipped",
// never a silent no-op. Steps 2, 4, 5 (lease breaking), 7, 8, 9, 11 and 12 are implemented here.
// Step 8 REPORTS and never deletes: §13 forbids selecting staging by recency, adopting temp data as
// a resume source, or reading staged credentials during cleanup, and the safest way to obey all
// three in 8a is to open nothing at all.
//
// DIAGNOSTICS CARRY COUNTS, IDS AND PATHS — NOTHING ELSE (§13 step 12, §17). Every `detail_json`
// this file writes is assembled from numbers, session/child ids and filesystem paths. Even a caught
// error contributes only its `name`: an error MESSAGE routinely quotes the payload it choked on
// (`JSON.parse` echoes the corrupt bytes verbatim), and that payload is exactly the content the
// runtime-state tables are trusted never to leak.
import type { Database } from "bun:sqlite";
import { readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionStore } from "../sessions/store";
import type { RuntimeStateDb } from "./db";
import { RuntimeSessionRecords, type GenerationRow, type RuntimeSessionRecord } from "./records";
import { RuntimeLeases, type LeaseProbe, type LeaseRow, type ProcessIdentity } from "./leases";
import { RuntimeChildren, type ChildRef, type PersistedWinterChild } from "./children";

/** The three states §13 step 2 calls "live": everything a previous daemon believed it was running.
 *  All three admit `unavailable` in `ALLOWED_TRANSITIONS`, which is what makes the park legal. */
const LIVE_STATES = ["running", "ready", "idle"] as const;

/** The shared temp tree's own subdirectory (§2's path contract): resume-staging and the binary
 *  cache, never a session root — so it is never a candidate orphan. */
const TEMP_RUNTIME_DIR = ".runtime";

export interface RecoveryHooks {
  /** step 3 — reconcile product-event and transcript tails; 8a: product log only (SessionStore.recoverAll). */
  reconcileTranscriptTail?: (record: RuntimeSessionRecord) => Promise<"ok" | "quarantined" | "skipped">;
  /** step 5 — 8b/8c: reattach live Winter channels / verify official processes. Default: none reattached. */
  reattach?: (record: RuntimeSessionRecord, generation: GenerationRow) => Promise<"reattached" | "gone" | "skipped">;
  /** step 6 — 8c: reconcile recorded official local-write roots. Default: skipped. */
  reconcileLocalWriteRoot?: (record: RuntimeSessionRecord) => Promise<"ok" | "repair-required" | "skipped">;
  /** step 8 — temp orphan scan. Receives the roots NAMED by authoritative generation/session rows
   *  and returns the ones on disk that nothing names. Default: the lease-safe scan below. */
  scanTempOrphans?: (roots: string[]) => Promise<{ orphans: string[] }>;
  /** step 10 — the router's directory.recover(); 8b wires it. */
  recoverDirectory?: () => Promise<unknown>;
  /** step 7 — the caller's PROOF that a `running` child's process/thread is gone (WS-16 §12). The
   *  default is `() => true`: after a daemon restart nothing this process owns survived. */
  isChildGone?: (child: PersistedWinterChild) => boolean;
}

export interface RecoveryDeps {
  home: string;
  rs: RuntimeStateDb;
  store: SessionStore;
  self: ProcessIdentity;
  hooks?: RecoveryHooks;
  log?: (line: string) => void;
  now?: () => string;
  /**
   * Step 4's process probe. Injectable so a test can describe a dead or reused pid without spawning
   * one — and DELIBERATELY only half the story: it governs the VERDICT, while `breakStale` re-proves
   * staleness against the live machine before it releases anything (leases.ts keeps that probe
   * un-injectable on purpose). A probe that lies about a live holder therefore moves a count in this
   * report and takes nobody's lease away.
   */
  probe?: LeaseProbe;
  /** Step 8's scan root. Defaults to §2's canonical `/private/tmp/norma-<uid>`; a test MUST point it
   *  at a temp directory, because the default is a real path on the developer's machine. */
  tempScanRoot?: string;
  /** Step 8's SECOND scan root (P8d-12, WS-16 §10): the official leg's `claude-resume-*` staging
   *  sweep. Defaults to `os.tmpdir()` — ALSO a real path on the developer's machine — so a test
   *  MUST point this at a throwaway directory too, for the identical reason `tempScanRoot` must. */
  claudeResumeScanRoot?: string;
  /**
   * "The product index has ALREADY been rebuilt in this process, since the lock was taken."
   *
   * Step 1 reconciles the product tail by calling `SessionStore.recoverAll()` — which reads and
   * `JSON.parse`s every line of every session's JSONL and then `readdir`s the whole sessions tree.
   * `SessionStore`'s CONSTRUCTOR already does exactly that, and the daemon constructs its store
   * before it calls recovery (review r1, Important 1): between those two points the lock is held,
   * no socket exists and nothing writes a session log, so the second pass is provably redundant —
   * and it is the largest single synchronous cost on the boot path, doubled, for every user.
   *
   * Set it only when the caller can make that argument. The default is `false`: an out-of-band
   * recovery run (a test, a future maintenance verb) has no such guarantee, and step 1's job is to
   * reconcile the tail, not to assume somebody else did. The integrity check and the step's outcome
   * are unchanged either way; the detail says which happened.
   */
  indexAlreadyRecovered?: boolean;
}

export interface RecoveryStepReport {
  step: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12;
  outcome: "ok" | "partial" | "skipped" | "failed";
  detail: Record<string, number | string | string[]>;
}

export interface RecoveryReport {
  startedAt: string;
  finishedAt: string;
  steps: RecoveryStepReport[];
  sessionsSeen: number;
  markedUnavailable: number;
  /** The children step 7 moved `running → interrupted`, as `{parent, childId}` pairs — a bare id
   *  cannot say whose child it was (two parents may mint the same `childId`). */
  reclassified: ChildRef[];
  corrupt: string[];
  /** "Every step completed." Orthogonal to `corrupt` — see this file's header. */
  ok: boolean;
  /**
   * P8d-11: the `id` of the `runtime_recovery_attempts` row THIS sweep wrote for step 10 —
   * `undefined` only when the write itself failed (bounded, per this file's header). The daemon
   * calls `restampStep(rs.db, report.step10AttemptId, 10, …)` once `sdk.directory.recover()` has
   * actually run (still before `startIpcServer` — see 8b task-12's CONCERN 1), turning the honest
   * `"skipped"` row this sweep left behind into the real outcome, in place, rather than leaving
   * `norma doctor` reading a step that always says "skipped" on every boot.
   */
  step10AttemptId?: number;
}

/** §2's canonical ephemeral root. The numeric suffix is the ACTUAL uid, never a hard-coded value. */
export function canonicalTempScanRoot(): string {
  return `/private/tmp/norma-${process.getuid?.() ?? -1}`;
}

export async function recoverRuntimeState(deps: RecoveryDeps): Promise<RecoveryReport> {
  const { rs, store, self } = deps;
  const now = deps.now ?? (() => new Date().toISOString());
  const hooks = deps.hooks ?? {};
  const log = deps.log ?? (() => {});
  const records = new RuntimeSessionRecords(rs, now);
  const leases = new RuntimeLeases(rs, self, now);
  const children = new RuntimeChildren(rs, now);

  const startedAt = now();
  const steps: RecoveryStepReport[] = [];
  const corrupt: string[] = [];
  const reclassified: ChildRef[] = [];
  const parked: string[] = [];
  let markedUnavailable = 0;

  /** Step 12, written as we go rather than at the end: a recovery that dies halfway must still leave
   *  the evidence of how far it got. Best-effort — a diagnostics write that fails is never allowed
   *  to take down the recovery it is describing. */
  const writeAttempt = (
    step: RecoveryStepReport["step"],
    outcome: string,
    detail: Record<string, number | string | string[]>,
    winterSessionId?: string,
  ): number | undefined => {
    try {
      const result = rs.db.run(
        `INSERT INTO runtime_recovery_attempts (started_at, finished_at, daemon_pid, daemon_started_at, step, winter_session_id, outcome, detail_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [startedAt, now(), self.pid, self.startedAt, step, winterSessionId ?? null, outcome, JSON.stringify(detail)],
      );
      return typeof result.lastInsertRowid === "bigint" ? Number(result.lastInsertRowid) : result.lastInsertRowid;
    } catch {
      /* bounded: diagnostics are evidence, never a dependency */
      return undefined;
    }
  };

  const finishStep = (step: RecoveryStepReport["step"], outcome: RecoveryStepReport["outcome"], detail: RecoveryStepReport["detail"]): number | undefined => {
    steps.push({ step, outcome, detail });
    const attemptId = writeAttempt(step, outcome, detail);
    // The sink is the CALLER's, and it is the last thing standing between a bad log target and a
    // daemon that will not boot. It is also called from inside the outer catch below, so an
    // unguarded throw here would escape the very guard that exists to contain it — a sink that
    // fails on EVERY line would reject the promise no matter how carefully the sweep behaved.
    // Recovery narrates; it does not depend on being heard.
    try {
      log(`recovery step ${step}: ${outcome}`);
    } catch {
      /* a logging sink must never take recovery down */
    }
    return attemptId;
  };

  /** The per-session bound. Records the id once, writes ONE attempt row naming the step and the
   *  error's TYPE (never its message — see this file's header), and returns so the caller continues. */
  const noteCorrupt = (winterSessionId: string, step: RecoveryStepReport["step"], e: unknown): void => {
    if (!corrupt.includes(winterSessionId)) corrupt.push(winterSessionId);
    writeAttempt(step, "failed", { step, errorName: e instanceof Error ? e.name : "unknown" }, winterSessionId);
  };

  /** Settle a session whose record cannot even be READ back (a corrupt `selection_json` makes every
   *  typed door throw). The `state IN (…)` guard names the same edges `ALLOWED_TRANSITIONS` allows,
   *  so this fallback can never make a transition the state machine forbids — it just does not need
   *  to parse the row to know that. */
  const forceRaw = (winterSessionId: string, to: "unavailable" | "failed", from: readonly string[]): void => {
    try {
      rs.db.run(
        `UPDATE runtime_sessions SET state = ?, updated_at = ? WHERE winter_session_id = ? AND state IN (${from.map(() => "?").join(", ")})`,
        [to, now(), winterSessionId, ...from],
      );
    } catch {
      /* bounded: a session we cannot settle must not stop the sweep */
    }
  };
  const parkRaw = (winterSessionId: string): void => forceRaw(winterSessionId, "unavailable", LIVE_STATES);

  const count = (sql: string): number => (rs.db.query<{ n: number }, []>(sql).get()?.n ?? 0);
  const ids = (sql: string): string[] =>
    rs.db.query<{ winter_session_id: string }, []>(sql).all().map((r) => r.winter_session_id);

  // Assigned INSIDE the outer try below, not here: this is a db read like any other, and a read
  // above the guard is a read whose failure rejects the promise. Zero until the sweep has counted.
  let sessionsSeen = 0;
  let step10AttemptId: number | undefined;
  const finish = (): RecoveryReport => ({
    startedAt,
    finishedAt: now(),
    steps,
    sessionsSeen,
    markedUnavailable,
    reclassified,
    corrupt,
    ok: steps.every((s) => s.outcome !== "failed"),
    ...(step10AttemptId === undefined ? {} : { step10AttemptId }),
  });

  // Review r1 (Minor 4): the boundedness claim has to be TOTAL. The per-session guards cover every
  // door that reads a session, but the bare counting helpers between them do not — and once 8b
  // wires this into boot, a rejected promise here is a daemon that does not start. A throw from
  // anywhere in the sweep therefore still leaves a step-12 row and a report that says `ok: false`.
  try {
    sessionsSeen = count("SELECT COUNT(*) AS n FROM runtime_sessions");

    // ── 1. Integrity-check both stores ───────────────────────────────────────────────────────────
    // Two stores with two different ownership rules: `runtime-state.db` is AUTHORITATIVE (§14: a
    // missing or corrupt one refuses runtime resume/routing — never infer a runtime kind or backend id
    // from the rebuildable index), while the product index is DISPOSABLE and rebuilds itself from the
    // SessionEvent JSONL. A failed authoritative check is the one condition that stops this sweep:
    // every later step would be reading and rewriting a store that cannot be trusted.
    {
      let integrityOk = false;
      let checks: string[] = ["unreadable"];
      try {
        const report = rs.integrity();
        integrityOk = report.ok;
        checks = report.checks;
      } catch (e) {
        checks = [e instanceof Error ? e.name : "unknown"];
      }
      if (!integrityOk) {
        finishStep(1, "failed", { integrity: checks });
        return finish();
      }
      if (deps.indexAlreadyRecovered) {
        // The caller has already rebuilt it in this process, under this lock — see the dep's own
        // doc comment for why re-reading every session log here would be pure duplicated work.
        finishStep(1, "ok", { integrity: checks, sessions: sessionsSeen, indexRecovery: "skipped-already-done" });
      } else {
        try {
          store.recoverAll();
          finishStep(1, "ok", { integrity: checks, sessions: sessionsSeen, indexRecovery: "recovered" });
        } catch (e) {
          finishStep(1, "failed", { integrity: checks, errorName: e instanceof Error ? e.name : "unknown" });
          return finish();
        }
      }
    }

    // ── 2. Park every live state pending revalidation ────────────────────────────────────────────
    // Enumerated as RAW IDS, deliberately: `records.list()` maps every row through `JSON.parse`, so a
    // single corrupt `selection_json` would throw before the first healthy session was even seen. One
    // id at a time is what makes the corruption bound per-session rather than per-sweep.
    {
      const live = ids(`SELECT winter_session_id FROM runtime_sessions WHERE state IN ('running', 'ready', 'idle') ORDER BY winter_session_id`);
      let failed = 0;
      for (const id of live) {
        try {
          records.transition(id, "unavailable");
          markedUnavailable++;
          parked.push(id);
        } catch (e) {
          failed++;
          noteCorrupt(id, 2, e);
          parkRaw(id);
        }
      }

      // …and settle what a torn CREATION left behind (§14 crash row (c)). A record still in
      // `creating` is one whose mapping commit never landed: after a restart nothing holds the
      // handle that could finish it, and recovery runs before the socket exists, so no live
      // creation can be misread as stranded. `creating` has exactly two exits and neither is live,
      // so this can never make a torn session visible — what it prevents is the opposite failure,
      // a record parked in `creating` forever, reported `alreadyPresent` by every later backfill
      // and repaired by nothing (see migrations/backfill.ts's own note on that shape).
      const stranded = ids(`SELECT winter_session_id FROM runtime_sessions WHERE state = 'creating' ORDER BY winter_session_id`);
      let settled = 0;
      for (const id of stranded) {
        try {
          records.transition(id, "failed");
          settled++;
        } catch (e) {
          failed++;
          noteCorrupt(id, 2, e);
          forceRaw(id, "failed", ["creating"]);
        }
      }
      finishStep(2, failed === 0 ? "ok" : "partial", { live: live.length, marked: markedUnavailable, stranded: stranded.length, settled, failed });
    }

    // ── 3. Reconcile the two tails ───────────────────────────────────────────────────────────────
    // The PRODUCT tail was already reconciled by step 1's `recoverAll` (skip-bad-lines + atomic
    // rewrite). The COMPATIBILITY transcript tail is 8b/8c's, and so is resolving the open projection
    // marks: `ProjectionCheckpoints.resolvePending` needs a witness predicate over the product log
    // tail, and inventing one here would be a guess with two bad answers — `false` DELETES marks (the
    // projector re-appends events that are already there), `true` COMMITS them (events that never
    // landed are never re-applied). So 8a REPORTS the open window and resolves nothing.
    {
      const pendingMarks = count("SELECT COUNT(*) AS n FROM projection_applied WHERE state = 'pending'");
      const hook = hooks.reconcileTranscriptTail;
      if (!hook) {
        finishStep(3, "skipped", { pendingMarks, productLog: "recovered-by-store", transcriptTail: "8b" });
      } else {
        const tally = { ok: 0, quarantined: 0, skipped: 0, failed: 0 };
        for (const id of ids("SELECT winter_session_id FROM runtime_sessions ORDER BY winter_session_id")) {
          try {
            const record = records.get(id);
            if (!record) continue;
            const verdict = await hook(record);
            tally[verdict]++;
          } catch (e) {
            tally.failed++;
            noteCorrupt(id, 3, e);
          }
        }
        finishStep(3, tally.failed === 0 ? "ok" : "partial", { ...tally, pendingMarks });
      }
    }

    // ── 4. Revalidate every unreleased lease by pid AND start identity ───────────────────────────
    // WS-16 §11: never adopt a reused PID. At most one lease per SESSION can be unreleased (acquire
    // refuses a live one and releases a stale other-generation one in the same transaction), so the
    // session list plus `holder()` is the whole worklist — `unreleasedRows` is carried alongside as a
    // tripwire: a count above `checked` would mean that invariant had broken.
    const verdicts: { lease: LeaseRow; verdict: "live" | "stale" | "unknown" }[] = [];
    {
      const unreleasedRows = count("SELECT COUNT(*) AS n FROM runtime_generations WHERE lease_holder_pid IS NOT NULL AND lease_released_at IS NULL");
      const held = ids(
        `SELECT DISTINCT winter_session_id FROM runtime_generations WHERE lease_holder_pid IS NOT NULL AND lease_released_at IS NULL ORDER BY winter_session_id`,
      );
      let failed = 0;
      for (const id of held) {
        try {
          const lease = leases.holder(id);
          if (!lease) continue;
          verdicts.push({ lease, verdict: leases.revalidate(lease, deps.probe) });
        } catch (e) {
          failed++;
          noteCorrupt(id, 4, e);
        }
      }
      finishStep(4, failed === 0 ? "ok" : "partial", {
        checked: verdicts.length,
        unreleasedRows,
        live: verdicts.filter((v) => v.verdict === "live").length,
        stale: verdicts.filter((v) => v.verdict === "stale").length,
        unknown: verdicts.filter((v) => v.verdict === "unknown").length,
        failed,
      });
    }

    // ── 5. Break the proven-stale leases; reattach what a live runtime still owns ─────────────────
    {
      let broken = 0;
      let breakRefused = 0;
      let unknownLeft = 0;
      let failed = 0;
      for (const { lease, verdict } of verdicts) {
        if (verdict === "unknown") {
          // §11's third answer: alive, but no identity. Neither proven live nor proven stale, so it is
          // left exactly as it is and reported. Breaking it is how two writers reach one transcript.
          unknownLeft++;
          continue;
        }
        if (verdict !== "stale") continue;
        try {
          if (leases.breakStale(lease.winterSessionId, lease.generation, "startup-recovery: holder revalidated as gone")) broken++;
          else breakRefused++;
        } catch (e) {
          failed++;
          noteCorrupt(lease.winterSessionId, 5, e);
        }
      }

      let reattached = 0;
      let gone = 0;
      let skipped = 0;
      const reattach = hooks.reattach;
      if (reattach) {
        for (const id of parked) {
          try {
            const record = records.get(id);
            if (!record) continue;
            const generations = records.generations(id);
            const generation = generations[generations.length - 1];
            // Nothing has ever attached to this session, so there is no live channel to reattach to.
            if (!generation) {
              skipped++;
              continue;
            }
            const outcome = await reattach(record, generation);
            if (outcome === "reattached") {
              records.transition(id, "ready");
              reattached++;
            } else if (outcome === "gone") gone++;
            else skipped++;
          } catch (e) {
            failed++;
            noteCorrupt(id, 5, e);
          }
        }
      } else {
        skipped = parked.length;
      }
      finishStep(5, failed === 0 ? "ok" : "partial", { broken, breakRefused, unknownLeft, reattached, gone, skipped, failed });
    }

    // ── 6. Reconcile recorded official local-write roots ─────────────────────────────────────────
    // §13 step 6 / §14's mirror row: a mismatch is marked `repair-required` BEFORE any handoff is
    // allowed. 8c owns the comparison; the marking is here so the verdict has one durable sink.
    {
      const hook = hooks.reconcileLocalWriteRoot;
      if (!hook) {
        finishStep(6, "skipped", { reason: "8c" });
      } else {
        const tally = { ok: 0, "repair-required": 0, skipped: 0, failed: 0 };
        for (const id of ids("SELECT winter_session_id FROM runtime_sessions ORDER BY winter_session_id")) {
          try {
            const record = records.get(id);
            if (!record) continue;
            const verdict = await hook(record);
            tally[verdict]++;
            if (verdict === "repair-required") records.setTranscriptHealth(id, "repair-required");
          } catch (e) {
            tally.failed++;
            noteCorrupt(id, 6, e);
          }
        }
        finishStep(6, tally.failed === 0 ? "ok" : "partial", { ...tally });
      }
    }

    // ── 7. Rebuild the child roster and mark interrupted work accurately ─────────────────────────
    // Review r1 (Important 1): PER PARENT, not one sweep. `reclassifyAfterRestart` is a single
    // transaction over everything it enumerates, so an unscoped call makes one bad row — or one
    // `isChildGone` proof that throws — cost every child of every session, at every boot, forever.
    // Same shape as step 2's: enumerate raw, act one at a time, record the failure, continue.
    {
      const parents = rs.db
        .query<{ parent_winter_session_id: string }, []>(
          `SELECT DISTINCT parent_winter_session_id FROM runtime_children WHERE status = 'running' ORDER BY parent_winter_session_id`,
        )
        .all()
        .map((r) => r.parent_winter_session_id);
      const isGone = hooks.isChildGone ?? (() => true);
      // A LOCAL tally, not the report-level `reclassified`: a step's detail must describe what THAT
      // step did. Reading the shared array happens to agree today only because nothing else writes
      // it — which is exactly the kind of coincidence that stops being true quietly.
      const interrupted: ChildRef[] = [];
      let kept = 0;
      let failed = 0;
      for (const parent of parents) {
        try {
          const result = children.reclassifyAfterRestart(isGone, { parent });
          interrupted.push(...result.interrupted);
          kept += result.kept.length;
        } catch (e) {
          failed++;
          noteCorrupt(parent, 7, e);
        }
      }
      reclassified.push(...interrupted);
      finishStep(7, failed === 0 ? "ok" : "partial", {
        parents: parents.length,
        interrupted: interrupted.length,
        kept,
        failed,
        children: interrupted.map((c) => `${c.parent}/${c.childId}`),
      });
    }

    // ── 8. Lease-safe temp orphan scan — REPORT ONLY, plus P8d-12's staging SWEEP ────────────────
    // The canonical tree is `<scanRoot>/<temp-project-key>/<backend-session-uuid>/`, so an
    // authoritative root sits BELOW a direct child of the scan root. A child is an orphan only when no
    // recorded root lives inside it — anything shallower would report a whole project key as abandoned
    // because one of its sessions ended. Names only: nothing under this root is opened, so a staged
    // credential cannot be read or logged even by accident (§13 step 8).
    {
      const known = new Set<string>(
        [
          ...rs.db.query<{ p: string }, []>("SELECT DISTINCT local_write_root AS p FROM runtime_generations WHERE local_write_root IS NOT NULL").all(),
          ...rs.db.query<{ p: string }, []>("SELECT DISTINCT effective_temp_dir AS p FROM runtime_sessions WHERE effective_temp_dir IS NOT NULL").all(),
          ...rs.db.query<{ p: string }, []>("SELECT DISTINCT active_local_write_root AS p FROM runtime_sessions WHERE active_local_write_root IS NOT NULL").all(),
        ].map((r) => r.p),
      );
      const scanRoot = deps.tempScanRoot ?? canonicalTempScanRoot();
      const scan = hooks.scanTempOrphans ?? (async (roots: string[]) => defaultTempScan(scanRoot, roots));
      // P8d-12 (WS-16 §10): the ONE deletion this normally report-only step performs — a documented,
      // narrow exception to this file's own header rule, bounded twice over (age AND unclaimed) and
      // logged by COUNT only, never a path. `known` is reused as-is: a live `sdk-resume-staging` root
      // is recorded in the SAME two columns the scan above already reads, under the SAME
      // `active_local_write_root`/`local_write_root` names — no second query needed.
      let claudeResumeRemoved = 0;
      try {
        claudeResumeRemoved = sweepClaudeResumeStaging(deps.claudeResumeScanRoot ?? tmpdir(), known);
      } catch {
        /* bounded: the staging sweep costs itself, never the rest of step 8 */
      }
      try {
        const { orphans } = await scan([...known]);
        finishStep(8, "ok", { root: scanRoot, known: known.size, orphans, deleted: 0, claudeResumeRemoved });
      } catch (e) {
        finishStep(8, "skipped", { root: scanRoot, known: known.size, errorName: e instanceof Error ? e.name : "unknown", claudeResumeRemoved });
      }
    }

    // ── 9. No auto-resume ────────────────────────────────────────────────────────────────────────
    // §13 step 9: resume only what an attached client, a queued accepted message, a routine or an
    // explicit product policy demands — none of which this sweep is. Stated as an assertion rather
    // than as a comment, so a future step that quietly resumed something would show up as a count.
    finishStep(9, "ok", { autoResumed: 0, running: count("SELECT COUNT(*) AS n FROM runtime_sessions WHERE state = 'running'") });

    // ── 10. Global messages and uncertain receipts ───────────────────────────────────────────────
    // Counts only. The rows this step looks at hold whole message envelopes; the pair (claimed, no
    // receipt) is the messaging spec's entire evidence for `delivery_uncertain`, and how MANY there
    // are is the only part of it that belongs in a diagnostic.
    {
      const detail = {
        heldMessages: count("SELECT COUNT(*) AS n FROM held_messages"),
        claimedWithoutReceipt: count("SELECT COUNT(*) AS n FROM global_messages WHERE claimed_by IS NOT NULL AND outcome_json IS NULL"),
        idleSubscriptions: count("SELECT COUNT(*) AS n FROM idle_subscriptions"),
      };
      if (!hooks.recoverDirectory) {
        // ⚠️ P8b Task 12, AND THE HONEST REASON. The hook is `sdk.directory.recover()`, and the
        // router handle is constructed in `daemon.ts` AFTER this sweep — it needs the directory
        // store this sweep's own `startRuntimeState` opened, and its `capabilities` come from the
        // tool-registry block later still. So on a real boot this step runs from the runtime-sdk
        // construction site instead (P8d-11 sanctions the late run) — the daemon calls
        // `restampStep` below once that construction has happened, so this "skipped" row is never
        // the FINAL word `norma doctor` reads on a real boot; it is here only until the restamp
        // lands. A caller that CAN supply the hook (every test, and any future two-phase boot)
        // takes the branch below and the whole step happens here instead.
        step10AttemptId = finishStep(10, "skipped", { ...detail, reason: "the router handle is built after §13; recovery runs at runtime-sdk construction" });
      } else {
        try {
          await hooks.recoverDirectory();
          step10AttemptId = finishStep(10, "ok", detail);
        } catch (e) {
          step10AttemptId = finishStep(10, "failed", { ...detail, errorName: e instanceof Error ? e.name : "unknown" });
        }
      }
    }

    // ── 11. Re-establish live directory entries with new generations ─────────────────────────────
    // 8b's, by construction: a live entry is minted when a runtime actually attaches, and nothing has
    // attached yet at this point in boot. Recovery must not invent one.
    finishStep(11, "skipped", { reason: "8b", directoryEntries: count("SELECT COUNT(*) AS n FROM directory_entries") });

    // ── 12. Emit recovery diagnostics ────────────────────────────────────────────────────────────
    // Every step above already wrote its own row as it finished (a recovery that dies halfway must
    // still leave evidence of how far it got), so this last one is the summary — and the twelfth row.
    finishStep(12, "ok", {
      sessionsSeen,
      markedUnavailable,
      corrupt,
      reclassified: reclassified.map((c) => `${c.parent}/${c.childId}`),
    });
  } catch (e) {
    finishStep(12, "failed", { errorName: e instanceof Error ? e.name : "unknown" });
  }
  return finish();
}

/** WS-16 §10's own literal — repeated (not imported) in `runtime-sdk/mode-options.ts`'s
 *  `controlPlaneDenyRules`, which names this constant right back; the two subsystems this phase
 *  does not bridge with a shared module. */
const CLAUDE_RESUME_PREFIX = "claude-resume-";

/** A resume genuinely in flight is never this old — every drain/timeout window the router or the
 *  official leg itself imposes is far shorter. Anything past this age under the staging root is
 *  leaked, not live. */
const CLAUDE_RESUME_STALE_MS = 24 * 60 * 60 * 1000;

/**
 * P8d-12 (WS-16 §10): sweep `claude-resume-*` staging directories — a DOCUMENTED, NARROW EXCEPTION
 * to this file's own header rule ("step 8 reports and never deletes"). Two bounds, BOTH required,
 * so this can never reach for a directory a live generation still needs:
 *
 *   - older than `CLAUDE_RESUME_STALE_MS` (mtime, real disk time — never the injectable `now()`
 *     this file uses for its own writes, because a directory's age has to be judged against the
 *     clock that actually wrote it), and
 *   - not named in `known` — the SAME `local_write_root`/`active_local_write_root` set the scan
 *     just above already built from `runtime_generations`/`runtime_sessions`, which is where a live
 *     `sdk-resume-staging` root is recorded.
 *
 * NAMES NEVER LEAVE THIS FUNCTION — the caller receives a bare count, matching this whole step's
 * "look and never open" discipline one deletion further: `readdirSync`/`statSync`/`rmSync` only,
 * never a read of what is INSIDE a candidate directory. A directory that cannot be stat'd or removed
 * is left for the next boot's pass rather than treated as a failure.
 */
function sweepClaudeResumeStaging(scanRoot: string, known: ReadonlySet<string>): number {
  let entries: string[];
  try {
    entries = readdirSync(scanRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith(CLAUDE_RESUME_PREFIX))
      .map((e) => e.name);
  } catch {
    return 0; // no temp root at all — nothing to sweep
  }
  let removed = 0;
  for (const name of entries) {
    const path = join(scanRoot, name);
    // PREFIX-AWARE, exactly like `defaultTempScan`'s own `claimed` predicate just below: a known
    // root is not always the candidate directory itself — a generation's `local_write_root` can
    // name a SUBDIRECTORY of a `claude-resume-<uuid>` dir (a nested working root inside the staged
    // payload), and an exact-match check would have swept the whole dir out from under it. `known`
    // protects `path` whenever some root equals it OR sits inside it.
    const claimed = [...known].some((root) => root === path || root.startsWith(`${path}/`));
    if (claimed) continue;
    let ageMs: number;
    try {
      ageMs = Date.now() - statSync(path).mtimeMs;
    } catch {
      continue; // gone already, or unreadable — leave it for the next pass
    }
    if (ageMs < CLAUDE_RESUME_STALE_MS) continue;
    try {
      rmSync(path, { recursive: true, force: true });
      removed++;
    } catch {
      /* best-effort: a directory that will not remove is left for the next pass */
    }
  }
  return removed;
}

/**
 * The default step-8 scan: one level under the canonical temp root, names only.
 *
 * Never `readFileSync`, never a symlink follow, never a delete — the whole point of §13 step 8 is
 * that a recovery sweep may look at what EXISTS and nothing else.
 */
function defaultTempScan(scanRoot: string, known: string[]): { orphans: string[] } {
  let entries: string[];
  try {
    entries = readdirSync(scanRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    // No temp root yet (a first boot, or a machine that cleared /private/tmp) — nothing to report.
    return { orphans: [] };
  }
  const orphans: string[] = [];
  for (const name of entries) {
    if (name === TEMP_RUNTIME_DIR) continue;
    const path = join(scanRoot, name);
    const claimed = known.some((root) => root === path || root.startsWith(`${path}/`));
    if (!claimed) orphans.push(path);
  }
  return { orphans };
}

/**
 * P8d-11: turn a `"skipped"` step 10 into the real outcome once the router handle actually exists.
 *
 * `recoverRuntimeState` runs long before `daemon.ts` can build the router (see the step 10 block's
 * own comment), so a real boot always leaves the `runtime_recovery_attempts` row for step 10 reading
 * `"skipped"` — accurate at the moment it was written, but a permanently dishonest answer to "did
 * §13 step 10 run" once the late `sdk.directory.recover()` call (8b task-12's own sanctioned
 * ordering) actually completes moments later, still before `startIpcServer`. This function
 * RE-STAMPS that SAME row — by `id`, matched against the step it names so a caller can never
 * clobber the wrong step's evidence — with the outcome the late call actually had, so `norma
 * doctor`'s attempt view (`latestRecoveryAttempts`, `runtime-state/doctor.ts`) reads one honest
 * step 10 per boot instead of a `"skipped"` that never changes.
 *
 * Bounded like every other write in this file: a restamp that cannot land (the db closed under a
 * fast shutdown race, say) costs the AUDIT ROW, never the boot — `sdk.directory.recover()` has
 * already run either way.
 */
export function restampStep(
  db: Database,
  attemptId: number,
  step: 10,
  outcome: "ok" | "partial" | "failed" | "skipped",
  detail: Record<string, unknown>,
): void {
  try {
    db.run(`UPDATE runtime_recovery_attempts SET outcome = ?, detail_json = ?, finished_at = ? WHERE id = ? AND step = ?`, [
      outcome,
      JSON.stringify(detail),
      new Date().toISOString(),
      attemptId,
      step,
    ]);
  } catch {
    /* bounded: diagnostics are evidence, never a dependency — see this file's header */
  }
}
