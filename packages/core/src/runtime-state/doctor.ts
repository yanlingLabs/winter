// WS-16 §15's diagnostics and repair — what `norma doctor` runs.
//
// TWO RULES SHAPE EVERY LINE HERE.
//
// 1. "Never silently choose a damaged or duplicate transcript." Diagnosis DISTINGUISHES; it never
//    resolves. Every ambiguity (two rows disagreeing about one backend uuid, a mapped transcript
//    that is not on disk) becomes a named finding with the repairs that could address it, and the
//    choice stays the operator's. A `Finding` with an empty `repairable` is not an oversight — it
//    means no repair in this file can honestly fix it (a vanished workspace is the user's to
//    restore; a stale lease is startup recovery's to break).
//
// 2. Diagnosis is READ-ONLY, and that is enforced by construction: the runtime-state db is opened
//    `readonly`, and the product index is read through its own readonly handle rather than through
//    `SessionStore` — whose CONSTRUCTOR runs `recoverAll()` and would repair the very drift this
//    file is trying to report. Nothing under `projects/` is ever parsed: a transcript is checked for
//    EXISTENCE only (§15's "missing compatibility transcript"), never read.
//
// The read-only half may run while the daemon is live — `runtime-state.db` is WAL, so a readonly
// open is not a lock fight. Every REPAIR is the opposite: `restore-backup` refuses outright while
// the lock is held, and the CLI refuses every op on the same probe.
import { Database } from "bun:sqlite";
import { appendFileSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, rmSync, statSync, truncateSync } from "node:fs";
import { join } from "node:path";
import { SessionStore, SYNCED_SESSION_ID_RE } from "../sessions/store";
import { openRuntimeStateDb, RUNTIME_STATE_SCHEMA_VERSION, RuntimeStateUnavailableError, type RuntimeStateDb } from "./db";
import { ALLOWED_TRANSITIONS, RuntimeSessionRecords } from "./records";
import { RuntimeLeases, type LeaseRow } from "./leases";

export type FindingKind =
  | "db-missing"
  | "db-corrupt"
  | "db-newer-schema"
  /** A healthy store written by an OLDER build of this schema. Not a fault and not repairable by
   *  this tool: the next daemon boot migrates it in place (`db.ts`'s MIGRATIONS). It exists as its
   *  own kind because the alternative — folding it into `db-corrupt` — told operators to restore a
   *  backup that would itself be the older version (re-review NEW-1). */
  | "db-unmigrated"
  | "index-drift"
  | "transcript-missing"
  | "duplicate-backend-id"
  | "cursor-mismatch"
  | "stale-live-registration"
  | "missing-workspace"
  | "missing-child-resume-context"
  | "orphan-generation";

export interface Finding {
  kind: FindingKind;
  winterSessionId?: string;
  detail: string;
  /** The repairs that could address this finding. Empty means "nothing this tool can fix". */
  repairable: RepairOp["kind"][];
}

export type RepairOp =
  | { kind: "rebuild-index" }
  | { kind: "quarantine-tail"; winterSessionId: string }
  | { kind: "relink-backend"; winterSessionId: string; backendSessionId: string }
  | { kind: "detach-backend"; winterSessionId: string }
  | { kind: "restore-backup"; backupPath: string };

export interface RepairResult {
  applied: boolean;
  detail: string;
}

export const DAEMON_RUNNING_REFUSAL = "daemon is running; stop it first";

/**
 * Is the daemon lock held right now?
 *
 * The same probe `lock.ts` uses — file present, pid parseable, pid alive — deliberately including
 * its reading of a `kill` failure as "not held": an EPERM pid is one an unrelated process reused,
 * and `acquireLock` already treats that lock as stale. Two answers to "is the daemon running" would
 * be worse than either. The socket half of `acquireLock`'s check is skipped: it is async, and the
 * conservative direction for a repair gate is to refuse MORE often, not less.
 */
export function isDaemonLockHeld(home: string): boolean {
  const lockPath = join(home, "run", "core.lock");
  if (!existsSync(lockPath)) return false;
  let pid = -1;
  try {
    pid = JSON.parse(readFileSync(lockPath, "utf8")).pid;
  } catch {
    return false; // corrupt = stale, exactly as acquireLock reads it
  }
  if (!(pid > 0)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

interface IndexRow {
  session_id: string;
  scope: string;
  last_seq: number;
  cwd: string | null;
}

/**
 * The product index, read through its OWN readonly handle — never through `SessionStore`, whose
 * constructor would rebuild the drift we are here to report.
 *
 * THREE STATES, NOT TWO. An ABSENT index is an empty map and no finding: a home whose daemon has
 * never run has no index and no drift. An UNREADABLE one is `undefined` — and that distinction is
 * load-bearing, because it is exactly the state in which the daemon will not boot at all
 * (`SessionStore`'s constructor throws on a file that is not a database). Folding it into "empty"
 * would answer `no findings` to an operator whose daemon is refusing to start.
 */
function readIndex(home: string): Map<string, IndexRow> | undefined {
  const path = join(home, "sessions", "index.db");
  const rows = new Map<string, IndexRow>();
  if (!existsSync(path)) return rows;
  let db: Database | undefined;
  let readable = true;
  try {
    db = new Database(path, { readonly: true });
    // The three columns `sessions` has had since it existed. `cwd` is ALTER-added (store.ts's
    // migration loop), and a READONLY handle cannot run that migration — so an index written by a
    // pre-`cwd` build is perfectly readable, and folding it in with a genuinely unopenable file
    // would claim the daemon will not start when it would start and migrate. Asked for separately,
    // tolerantly (review r1, minor 5).
    for (const row of db.query<Omit<IndexRow, "cwd">, []>("SELECT session_id, scope, last_seq FROM sessions").all()) {
      rows.set(row.session_id, { ...row, cwd: null });
    }
    try {
      for (const row of db.query<{ session_id: string; cwd: string | null }, []>("SELECT session_id, cwd FROM sessions").all()) {
        const known = rows.get(row.session_id);
        if (known) known.cwd = row.cwd;
      }
    } catch {
      /* an index older than the `cwd` column: every workspace check simply has nothing to check */
    }
  } catch {
    readable = false;
  } finally {
    try {
      db?.close();
    } catch {
      /* best effort */
    }
  }
  return readable ? rows : undefined;
}

/** How much of a log's tail is read to find its last line. A session event is orders of magnitude
 *  smaller; the loop below widens for the pathological case rather than assuming. */
const TAIL_WINDOW_BYTES = 64 * 1024;

/**
 * The last line of a session log, read POSITIONALLY from the end.
 *
 * Never pulls the file into memory (review r1, minor 9): a long session is tens of megabytes, and
 * "this tool does not read bodies" should be true of the machine, not just of the intent. The scan
 * works on BYTES — the last 0x0A, then decode only what follows it — so a window boundary landing
 * mid-codepoint cannot corrupt the answer.
 *
 * `startOffset` is where that line begins, which is also the length the file would have without it:
 * `quarantineTail` truncates to exactly this.
 */
function readTrailingFrame(logPath: string): { line: string; startOffset: number } | undefined {
  if (!existsSync(logPath)) return undefined;
  const size = statSync(logPath).size;
  if (size === 0) return undefined;
  const fd = openSync(logPath, "r");
  try {
    let window = Math.min(TAIL_WINDOW_BYTES, size);
    for (;;) {
      const buf = Buffer.alloc(window);
      readSync(fd, buf, 0, window, size - window);
      // A complete final frame ends in a newline; a torn one does not. Either way the trailing
      // newlines are not part of the line.
      let end = buf.length;
      while (end > 0 && buf[end - 1] === 0x0a) end--;
      if (end === 0) {
        if (window === size) return undefined; // nothing but newlines
      } else {
        const nl = buf.lastIndexOf(0x0a, end - 1);
        if (nl !== -1) return { line: buf.subarray(nl + 1, end).toString("utf8"), startOffset: size - window + nl + 1 };
        if (window === size) return { line: buf.subarray(0, end).toString("utf8"), startOffset: 0 };
      }
      window = Math.min(window * 8, size); // one very long line, or a run of newlines: widen
    }
  } finally {
    closeSync(fd);
  }
}

/** The trailing frame's `seq`, parsed only that far. `undefined` means "no readable trailing
 *  frame", which is all the drift check and the tail repair need to know. */
function tailSeq(logPath: string): number | undefined {
  const frame = readTrailingFrame(logPath);
  if (frame === undefined) return undefined;
  try {
    const seq = (JSON.parse(frame.line) as { seq?: unknown }).seq;
    return typeof seq === "number" ? seq : undefined;
  } catch {
    return undefined;
  }
}

interface SessionDiagRow {
  winter_session_id: string;
  backend_session_id: string | null;
  transcript_project_key: string;
  transcript_health: string;
  state: string;
}

export async function diagnoseRuntimeState(home: string): Promise<Finding[]> {
  const findings: Finding[] = [];

  let rs: RuntimeStateDb;
  try {
    rs = openRuntimeStateDb(home, { readonly: true });
  } catch (e) {
    if (!(e instanceof RuntimeStateUnavailableError)) throw e;
    // §14: an authoritative store that is missing or corrupt refuses runtime resume/routing — and
    // NOTHING further is inferred from the rebuildable index, so this is the only finding returned.
    if (e.reason === "newer-schema") return [{ kind: "db-newer-schema", detail: `${e.path}: written by a newer Norma; this build will not open it`, repairable: [] }];
    if (e.reason === "missing") {
      // A home that has never run a daemon has no `runtimes/` at all, and therefore no backups
      // either — offering `restore-backup` there sends the operator hunting for a file that cannot
      // exist (review r1, minor 8). The finding is the same; the advice is not.
      const everRan = existsSync(join(home, "runtimes"));
      return [
        {
          kind: "db-missing",
          detail: everRan ? `${e.path}: the authoritative runtime store is not there` : `${e.path}: this home has never run a daemon (no runtimes/ directory)`,
          repairable: everRan ? ["restore-backup"] : [],
        },
      ];
    }
    return [{ kind: "db-corrupt", detail: `${e.path}: ${e.reason}`, repairable: ["restore-backup"] }];
  }

  try {
    const integrity = rs.integrity();
    if (!integrity.ok) {
      return [{ kind: "db-corrupt", detail: `${rs.path}: ${integrity.checks.join("; ")}`, repairable: ["restore-backup"] }];
    }

    // An older schema is REPORTED, not refused, and everything below still runs: every table this
    // diagnosis reads exists in every version of the schema, and the operator's real question ("is
    // my runtime state healthy?") has a useful answer either way. Explicitly NOT repairable — the
    // daemon fixes it by starting.
    const schemaVersion = rs.schemaVersion();
    if (schemaVersion < RUNTIME_STATE_SCHEMA_VERSION) {
      findings.push({
        kind: "db-unmigrated",
        detail: `${rs.path}: schema ${schemaVersion} < ${RUNTIME_STATE_SCHEMA_VERSION} — the next daemon boot migrates it in place`,
        repairable: [],
      });
    }

    const readIndexResult = readIndex(home);
    if (!readIndexResult) {
      findings.push({
        kind: "index-drift",
        detail: `${join(home, "sessions", "index.db")} cannot be opened at all (not an older schema — that reads fine); the daemon will refuse to start until it is rebuilt`,
        repairable: ["rebuild-index"],
      });
    }
    const index = readIndexResult ?? new Map<string, IndexRow>();
    const sessions = rs.db
      .query<SessionDiagRow, []>(
        "SELECT winter_session_id, backend_session_id, transcript_project_key, transcript_health, state FROM runtime_sessions ORDER BY winter_session_id",
      )
      .all();

    for (const row of sessions) {
      const id = row.winter_session_id;
      const indexRow = index.get(id);

      // §15 "missing compatibility transcript" / §14's read-only-history row. EXISTENCE only.
      if (row.backend_session_id !== null && row.transcript_health !== "unsupported") {
        const path = join(home, "projects", row.transcript_project_key, `${row.backend_session_id}.jsonl`);
        if (!existsSync(path)) {
          findings.push({
            kind: "transcript-missing",
            winterSessionId: id,
            detail: `mapped backend ${row.backend_session_id} has no transcript at ${path}`,
            repairable: ["relink-backend", "detach-backend"],
          });
        }
      }

      if (!indexRow) continue;

      // §14 "workspace disappears": history stays visible, but a tool turn must be refused. Nothing
      // a repair op can restore — only the user can.
      if (indexRow.cwd !== null && !existsSync(indexRow.cwd)) {
        findings.push({ kind: "missing-workspace", winterSessionId: id, detail: `working directory is gone: ${indexRow.cwd}`, repairable: [] });
      }

      // §15 "canonical index drift" — bounded to sessions the runtime spine actually names, so a
      // doctor run never walks every log in a large home.
      const logPath = join(home, "sessions", indexRow.scope, `${id}.jsonl`);
      const seq = tailSeq(logPath);
      if (seq === undefined) {
        if (indexRow.last_seq > 0) {
          findings.push({
            kind: "index-drift",
            winterSessionId: id,
            detail: `index says last_seq=${indexRow.last_seq} but the log's trailing frame is unreadable: ${logPath}`,
            repairable: ["quarantine-tail", "rebuild-index"],
          });
        }
      } else if (seq !== indexRow.last_seq) {
        findings.push({
          kind: "index-drift",
          winterSessionId: id,
          detail: `index says last_seq=${indexRow.last_seq}, the log tail says ${seq}: ${logPath}`,
          repairable: ["rebuild-index"],
        });
      }

      // §15 "projection cursor mismatch": a cursor claiming product events the log has never held.
      for (const cursor of rs.db
        .query<{ generation: number; last_winter_seq: number }, [string]>(
          "SELECT generation, last_winter_seq FROM runtime_projection_cursors WHERE winter_session_id = ? ORDER BY generation",
        )
        .all(id)) {
        if (cursor.last_winter_seq > indexRow.last_seq) {
          findings.push({
            kind: "cursor-mismatch",
            winterSessionId: id,
            detail: `generation ${cursor.generation} is checkpointed at winter seq ${cursor.last_winter_seq}, past the product log's ${indexRow.last_seq}`,
            repairable: [],
          });
        }
      }
    }

    // §15 "ambiguous duplicate backend ID". `runtime_sessions.backend_session_id` is UNIQUE, so the
    // ambiguity cannot live inside that column — it lives BETWEEN the mapping and the generation
    // history, where a previous incarnation's uuid can outlive the mapping that owned it.
    for (const row of rs.db
      .query<{ winter_session_id: string; generation: number; backend_session_id: string; owner: string }, []>(
        `SELECT g.winter_session_id, g.generation, g.backend_session_id, s.winter_session_id AS owner
         FROM runtime_generations g JOIN runtime_sessions s ON s.backend_session_id = g.backend_session_id
         WHERE g.backend_session_id IS NOT NULL AND s.winter_session_id <> g.winter_session_id
         ORDER BY g.winter_session_id, g.generation`,
      )
      .all()) {
      findings.push({
        kind: "duplicate-backend-id",
        winterSessionId: row.winter_session_id,
        detail: `generation ${row.generation} claims backend ${row.backend_session_id}, which is mapped to ${row.owner}`,
        // §4: "ambiguous backend-ID mappings are rejected, never resolved by picking a file." No op
        // here can honestly clear this — `detach-backend` only touches `runtime_sessions`, so
        // detaching the session NAMED by this finding would leave the generation's claim, and the
        // finding, exactly where they are. Which of the two rows is wrong is the operator's call.
        repairable: [],
      });
    }

    // §15 "stale live registration": a lease nothing is holding. Recovery's step 5 is what breaks
    // it (with proof) — a doctor only says so.
    // Through `RuntimeLeases.revalidate`, NOT a bare liveness check (review r1, minor 3): pid AND
    // start identity, so a lease held by a pid some unrelated process has since reused is stale here
    // exactly as it is to recovery's step 4. Two answers to "is this holder gone" — with the
    // operator-facing one the weaker — is how an operator and a boot sweep come to disagree. An
    // `"unknown"` verdict is deliberately NOT reported: §11 says a lease whose identity cannot be
    // established is neither proven live nor proven stale, and naming it here would invite exactly
    // the break that rule forbids.
    const leases = new RuntimeLeases(rs, { pid: process.pid, startedAt: "diagnostic" });
    for (const row of rs.db
      .query<{ winter_session_id: string; generation: number; lease_holder_pid: number; lease_holder_started_at: string | null; lease_renewed_at: string | null }, []>(
        `SELECT winter_session_id, generation, lease_holder_pid, lease_holder_started_at, lease_renewed_at FROM runtime_generations
         WHERE lease_holder_pid IS NOT NULL AND lease_released_at IS NULL ORDER BY winter_session_id, generation`,
      )
      .all()) {
      const lease: LeaseRow = {
        winterSessionId: row.winter_session_id,
        generation: row.generation,
        holder: { pid: row.lease_holder_pid, startedAt: row.lease_holder_started_at ?? "unknown" },
        renewedAt: row.lease_renewed_at ?? "",
      };
      if (leases.revalidate(lease) !== "stale") continue;
      findings.push({
        kind: "stale-live-registration",
        winterSessionId: row.winter_session_id,
        detail: `generation ${row.generation} still holds a lease for pid ${row.lease_holder_pid} (started ${row.lease_holder_started_at ?? "unknown"}), which no longer identifies that process`,
        repairable: [],
      });
    }

    // §15 "missing child resume context". Terminal children are evidence of what happened and are
    // never resumed, so a missing locator on one of those is not a defect.
    for (const row of rs.db
      .query<{ parent_winter_session_id: string; child_id: string; status: string; resume_context_ref: string }, []>(
        `SELECT parent_winter_session_id, child_id, status, resume_context_ref FROM runtime_children
         WHERE resume_context_ref IS NOT NULL AND status IN ('running', 'interrupted') ORDER BY parent_winter_session_id, child_id`,
      )
      .all()) {
      if (existsSync(row.resume_context_ref)) continue;
      findings.push({
        kind: "missing-child-resume-context",
        winterSessionId: row.parent_winter_session_id,
        detail: `child ${row.child_id} (${row.status}) points at a resume context that is gone: ${row.resume_context_ref}`,
        repairable: [],
      });
    }

    // A generation with no mapping behind it. The FK makes this unreachable through the typed doors,
    // so seeing one means the file arrived from somewhere else — a restore, or a hand edit.
    for (const row of rs.db
      .query<{ winter_session_id: string; generation: number }, []>(
        `SELECT g.winter_session_id, g.generation FROM runtime_generations g
         LEFT JOIN runtime_sessions s ON s.winter_session_id = g.winter_session_id
         WHERE s.winter_session_id IS NULL ORDER BY g.winter_session_id, g.generation`,
      )
      .all()) {
      findings.push({
        kind: "orphan-generation",
        winterSessionId: row.winter_session_id,
        detail: `generation ${row.generation} has no runtime session behind it`,
        repairable: [],
      });
    }

    return findings;
  } finally {
    rs.close();
  }
}

export interface RecoveryAttemptSummary {
  step: number;
  outcome: string;
  detail: Record<string, unknown>;
  finishedAt: string | null;
}

/**
 * P8d-11: `norma doctor`'s read of the daemon's own `runtime_recovery_attempts` audit trail — the
 * one boot-level (`winter_session_id IS NULL`) row per step from the MOST RECENT boot, so an
 * operator sees today's recovery rather than every boot this home has ever done. `restampStep`
 * (`recovery.ts`) updates step 10's row IN PLACE once the late `sdk.directory.recover()` call
 * completes, so this is also the door that proves the restamp actually landed — the row this
 * returns for step 10 is `"ok"`/`"partial"`/`"failed"`, never a permanent `"skipped"`, on any boot
 * where the router handle came up.
 *
 * Read-only, the same `readonly` convention every other door in this file uses; `[]` for a home with
 * no runtime spine at all (never a daemon boot) or one this build cannot open.
 */
export function latestRecoveryAttempts(home: string): RecoveryAttemptSummary[] {
  let rs: RuntimeStateDb;
  try {
    rs = openRuntimeStateDb(home, { readonly: true });
  } catch {
    return [];
  }
  try {
    const latestBoot = rs.db.query<{ daemon_started_at: string }, []>("SELECT daemon_started_at FROM runtime_recovery_attempts ORDER BY id DESC LIMIT 1").get();
    if (!latestBoot) return [];
    const rows = rs.db
      .query<{ step: number; outcome: string; detail_json: string; finished_at: string | null }, [string]>(
        "SELECT step, outcome, detail_json, finished_at FROM runtime_recovery_attempts WHERE daemon_started_at = ? AND winter_session_id IS NULL ORDER BY id",
      )
      .all(latestBoot.daemon_started_at);
    // `id` order means the LAST row for a given step wins — exactly what a restamp (an UPDATE on
    // the same row) already guarantees, and what would also cover a hypothetical future step that
    // legitimately wrote more than once per boot.
    const byStep = new Map<number, RecoveryAttemptSummary>();
    for (const row of rows) {
      let detail: Record<string, unknown> = {};
      try {
        detail = JSON.parse(row.detail_json) as Record<string, unknown>;
      } catch {
        /* an unparsable detail is reported empty, never thrown — this door is diagnostics only */
      }
      byStep.set(row.step, { step: row.step, outcome: row.outcome, detail, finishedAt: row.finished_at });
    }
    return [...byStep.values()].sort((a, b) => a.step - b.step);
  } catch {
    return [];
  } finally {
    rs.close();
  }
}

/**
 * Run one repair. TOTAL — it returns a result or it returns a result.
 *
 * Review r1 (Important 2): the type promised that and the code did not. `openRuntimeStateDb` refuses
 * a corrupt/newer/unmigrated store by THROWING, and the filesystem can refuse a write for a dozen
 * reasons (EACCES, ENOSPC, a read-only volume) — so `norma doctor --repair` printed a raw stack
 * trace in exactly the broken-home state the verb exists for. Unlike the recovery path, a message is
 * safe to carry here: nothing on this path ever touches a message body or a transcript body.
 */
export async function repairRuntimeState(home: string, op: RepairOp, deps: { store?: SessionStore } = {}): Promise<RepairResult> {
  try {
    // EVERY repair refuses while the daemon holds the lock, not just `restore-backup` (whole-branch
    // review, M3). This function is exported on the package barrel, so the CLI's own probe is not
    // the only way in: `rebuild-index` unlinks the index file a live daemon holds open, and
    // `relink`/`detach`/`quarantine-tail` write stores it is reading. The CLI's earlier check stays
    // — it is what prints the usage-level message — and this one is what makes the refusal a
    // property of the operation rather than of one caller.
    if (isDaemonLockHeld(home)) return { applied: false, detail: DAEMON_RUNNING_REFUSAL };
    switch (op.kind) {
      case "rebuild-index":
        return rebuildIndex(home);
      case "quarantine-tail":
        return quarantineTail(home, op.winterSessionId, deps.store);
      case "relink-backend":
        return relinkBackend(home, op.winterSessionId, op.backendSessionId);
      case "detach-backend":
        return detachBackend(home, op.winterSessionId);
      case "restore-backup":
        return restoreBackup(home, op.backupPath);
    }
  } catch (e) {
    return { applied: false, detail: e instanceof Error ? `${e.name}: ${e.message}` : "repair failed" };
  }
}

/** WS-17 row 11: rebuild the disposable product index from the SessionEvent JSONL. The authoritative
 *  `runtime-state.db` is not opened at all — a product-index repair must never be able to move a
 *  runtime mapping. */
function rebuildIndex(home: string): RepairResult {
  const index = join(home, "sessions", "index.db");
  // The rollback journal and the WAL sidecars go too: a hot journal left beside a fresh file can
  // roll its own garbage back in on the next open.
  for (const path of [index, `${index}-journal`, `${index}-wal`, `${index}-shm`]) rmSync(path, { force: true });
  // Always a FRESH store: a handle passed in by a caller is pinned to the inode just unlinked.
  const store = new SessionStore(home);
  try {
    store.recoverAll();
    return { applied: true, detail: `rebuilt ${index} from the event logs: ${store.list().length} session(s)` };
  } finally {
    store.close();
  }
}

/** §13 step 3 / §14's "during JSONL append" row: detect and repair ONLY the incomplete trailing
 *  frame, never an earlier valid event. The torn bytes are MOVED, not dropped — `SessionStore`'s own
 *  skip-bad-lines rewrite discards them, and a repair the operator invoked deliberately should leave
 *  the evidence behind. */
function quarantineTail(home: string, sessionId: string, injected?: SessionStore): RepairResult {
  const index = readIndex(home);
  if (!index) return { applied: false, detail: "the product index cannot be read; run --repair rebuild-index first" };
  const row = index.get(sessionId);
  if (!row) return { applied: false, detail: `unknown session: ${sessionId}` };
  const logPath = join(home, "sessions", row.scope, `${sessionId}.jsonl`);
  if (!existsSync(logPath)) return { applied: false, detail: `no event log at ${logPath}` };

  const frame = readTrailingFrame(logPath);
  if (frame === undefined) return { applied: false, detail: `no incomplete trailing frame in ${logPath}` };
  try {
    JSON.parse(frame.line);
    return { applied: false, detail: `no incomplete trailing frame in ${logPath}` };
  } catch {
    /* torn tail: fall through and quarantine it */
  }

  // File surgery FIRST: constructing a `SessionStore` runs `recoverAll`, which would silently drop
  // the very line this repair exists to preserve.
  //
  // TRUNCATE, not a temp+rename rewrite. Removing a SUFFIX is one syscall whose size change is
  // atomic, so a crash leaves either the old length or the new one — where a full rewrite puts every
  // earlier event through a copy it never needed to survive. (Concurrency is not the argument for
  // either: every repair refuses while the daemon lock is held.)
  // OUT OF THE SESSIONS TREE ENTIRELY (whole-branch review, M2). This used to be
  // `sessions/<scope>/<id>.quarantine.jsonl`, and `SessionStore.recoverAll`'s pass 2 enumerates
  // `*.jsonl` there and derives a session id from the filename — so `<id>.quarantine` was a
  // candidate SESSION, skipped only because the sidecar happens to hold nothing but unparseable
  // lines. That is a coincidence of what `quarantineTail` writes, not a boundary. Under
  // `runtimes/quarantine/<scope>/` nothing enumerates it, and it inherits the read-denial the model
  // already has on `runtimes/`.
  const quarantineDir = join(home, "runtimes", "quarantine", row.scope);
  mkdirSync(quarantineDir, { recursive: true });
  const quarantine = join(quarantineDir, `${sessionId}.jsonl`);
  appendFileSync(quarantine, `${frame.line}\n`);
  truncateSync(logPath, frame.startOffset);

  const store = injected ?? new SessionStore(home);
  try {
    store.recoverAll();
  } finally {
    if (!injected) store.close();
  }
  // Bytes and a path — never the bytes themselves.
  return { applied: true, detail: `quarantined 1 trailing frame (${Buffer.byteLength(frame.line)} bytes) to ${quarantine}` };
}

/**
 * §15: "relink a UNIQUELY verified backend UUID/project key."
 *
 * Two proofs, both required: no other record holds the uuid (the ambiguity §4 refuses to resolve by
 * picking a file), and the transcript for it EXISTS under this record's own project key — existence
 * only, never a parse. The uuid is validated against the product store's own session-id shape before
 * it is joined into a path: an operator-supplied string becomes a path component here, and `../`
 * would walk straight out of `projects/`.
 */
function relinkBackend(home: string, sessionId: string, backendSessionId: string): RepairResult {
  if (!SYNCED_SESSION_ID_RE.test(backendSessionId)) return { applied: false, detail: `not a backend session uuid: ${backendSessionId}` };
  // Inside the try: opening the store is itself a refusable operation (corrupt / newer-schema /
  // unmigrated all THROW), and this function's contract is to return a refusal, not to raise one.
  let rs: RuntimeStateDb | undefined;
  try {
    // Bound to a const as well as to `rs`: the transaction below is a CLOSURE, and TypeScript will
    // not carry a `let`'s narrowing into one.
    const opened = openRuntimeStateDb(home);
    rs = opened;
    const records = new RuntimeSessionRecords(opened);
    const record = records.get(sessionId);
    if (!record) return { applied: false, detail: `unknown session: ${sessionId}` };
    const owner = records.byBackendSessionId(backendSessionId);
    if (owner && owner.winterSessionId !== sessionId) {
      return { applied: false, detail: `backend ${backendSessionId} is already mapped to ${owner.winterSessionId}` };
    }
    const path = join(home, "projects", record.transcriptProjectKey, `${backendSessionId}.jsonl`);
    if (!existsSync(path)) return { applied: false, detail: `no transcript for ${backendSessionId} at ${path}` };
    // A raw, guarded UPDATE rather than `transition`: relinking changes the MAPPING and must leave
    // the lifecycle state exactly where it was, and `ALLOWED_TRANSITIONS` has no self-edge — there
    // is deliberately no "same state, new patch" door on the state machine for ordinary code to
    // reach. An out-of-band repair is exactly the case §15 carves out for that.
    opened.transaction(
      () => {
        const still = records.byBackendSessionId(backendSessionId);
        if (still && still.winterSessionId !== sessionId) throw new Error(`backend ${backendSessionId} is already mapped to ${still.winterSessionId}`);
        opened.db.run("UPDATE runtime_sessions SET backend_session_id = ?, updated_at = ? WHERE winter_session_id = ?", [
          backendSessionId,
          new Date().toISOString(),
          sessionId,
        ]);
      },
      { mode: "immediate" },
    );
    return { applied: true, detail: `${sessionId} now maps to backend ${backendSessionId}` };
  } catch (e) {
    return { applied: false, detail: e instanceof Error ? `${e.name}: ${e.message}` : "relink failed" };
  } finally {
    rs?.close();
  }
}

/** §14's "canonical compatibility transcript missing" row: show product history read-only, mark
 *  resume unavailable. The product log is never touched — that history is the whole point. */
function detachBackend(home: string, sessionId: string): RepairResult {
  // Opened inside the try for the same reason `relinkBackend` does it — see there.
  let rs: RuntimeStateDb | undefined;
  try {
    rs = openRuntimeStateDb(home);
    const records = new RuntimeSessionRecords(rs);
    const record = records.get(sessionId);
    if (!record) return { applied: false, detail: `unknown session: ${sessionId}` };
    if (ALLOWED_TRANSITIONS[record.state].includes("exited")) {
      records.transition(sessionId, "exited", { backendSessionId: undefined, transcriptHealth: "unsupported" });
      return { applied: true, detail: `${sessionId} detached from its backend; history is read-only` };
    }
    // `exited` is unreachable from here (`creating`, `exited`, `failed`), so the mapping is cleared
    // where it stands rather than forcing an illegal transition to tidy the report.
    rs.db.run("UPDATE runtime_sessions SET backend_session_id = NULL, transcript_health = 'unsupported', updated_at = ? WHERE winter_session_id = ?", [
      new Date().toISOString(),
      sessionId,
    ]);
    return { applied: true, detail: `${sessionId} detached from its backend; state left as ${record.state} (exited is unreachable from it)` };
  } catch (e) {
    return { applied: false, detail: e instanceof Error ? `${e.name}: ${e.message}` : "detach failed" };
  } finally {
    rs?.close();
  }
}

/** §16's restore door. Three refusals before a single byte moves: the daemon must not be running,
 *  the source must live in THIS home's backup directory (realpath'd, so a symlink cannot point out
 *  of it), and the source must pass its own integrity check — restoring a corrupt backup over a
 *  corrupt database would be the one repair that cannot be undone. */
function restoreBackup(home: string, backupPath: string): RepairResult {
  // The lock probe moved up to `repairRuntimeState`, which now gates EVERY op — it is kept here as
  // well because this is the one irreversible repair, and a future caller reaching it directly must
  // not be the exception (M3).
  if (isDaemonLockHeld(home)) return { applied: false, detail: DAEMON_RUNNING_REFUSAL };
  if (!existsSync(backupPath)) return { applied: false, detail: `no such backup: ${backupPath}` };
  const backupsDir = join(home, "runtimes", "backups");
  let real: string;
  let realBackups: string;
  try {
    real = realpathSync(backupPath);
    realBackups = realpathSync(backupsDir);
  } catch {
    return { applied: false, detail: `backup is outside ${backupsDir}` };
  }
  if (!real.startsWith(`${realBackups}/`)) return { applied: false, detail: `backup is outside ${backupsDir}: ${backupPath}` };

  let probe: Database | undefined;
  try {
    probe = new Database(real, { readonly: true });
    const quick = probe.query<{ quick_check: string }, []>("PRAGMA quick_check").get();
    if (quick?.quick_check !== "ok") return { applied: false, detail: `backup fails its own integrity check: ${backupPath}` };
    // A backup written by a newer build passes quick_check and then refuses to open afterwards
    // (`db.ts` rejects `newer-schema`), i.e. the restore would "succeed" into an unusable store.
    // Caught here, while the current file is still intact (review r1, minor 7).
    const version = probe.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0;
    if (version > RUNTIME_STATE_SCHEMA_VERSION)
      return { applied: false, detail: `backup was written by a newer Norma (schema ${version} > ${RUNTIME_STATE_SCHEMA_VERSION}): ${backupPath}` };
  } catch (e) {
    return { applied: false, detail: `backup is not a readable database: ${e instanceof Error ? e.name : "unknown"}` };
  } finally {
    try {
      probe?.close();
    } catch {
      /* best effort */
    }
  }

  const dest = join(home, "runtimes", "runtime-state.db");

  // THE ONE IRREVERSIBLE REPAIR, MADE REVERSIBLE — and it must never fail SILENTLY (re-review
  // NEW-1). The first cut swallowed every failure, so on a store this build could not open readonly
  // the repair overwrote a file with no copy of it anywhere and said so only in passing. Two doors,
  // in order:
  //
  //   1. a CONSISTENT snapshot (`VACUUM INTO`) when the current file opens — the best copy;
  //   2. a RAW BYTE COPY when it does not, because a file that will not open is the usual reason
  //      someone is restoring at all, and a corrupt file is still the only evidence of what went
  //      wrong. A byte copy needs nothing to be valid.
  //
  // Only when BOTH fail does the restore refuse, with the reason — better a repair the operator has
  // to finish by hand than a file destroyed by a tool that was meant to make it recoverable.
  let snapshot: string | undefined;
  /** Sidecars that are now represented in the snapshot, so removing them below loses nothing. A
   *  `VACUUM INTO` reads THROUGH the connection, so its output already contains every committed
   *  frame — that door represents them all. */
  let sidecarsCaptured = true;
  if (existsSync(dest)) {
    try {
      const current = openRuntimeStateDb(home, { readonly: true });
      try {
        snapshot = current.backup();
      } finally {
        current.close();
      }
    } catch {
      try {
        const dir = join(home, "runtimes", "backups");
        mkdirSync(dir, { recursive: true });
        snapshot = join(dir, `pre-restore-${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}.db`);
        copyFileSync(dest, snapshot);
      } catch (e) {
        return {
          applied: false,
          detail: `refusing to overwrite ${dest}: it could not be snapshotted first (${e instanceof Error ? e.name : "unknown"}). Move it aside by hand and re-run.`,
        };
      }
      // THE SIDECARS COME WITH IT (re-review NEW-9). A byte copy of a WAL-mode database without
      // its `-wal`/`-shm` cannot be opened read-only at all — which is exactly how the probe above
      // inspects a candidate — so the snapshot this repair names in its own success message was a
      // file the operator could not feed back through `--repair restore-backup`. And any committed
      // but un-checkpointed tail lived ONLY in that `-wal`, which the sidecar removal below then
      // deleted. Copying them beside the snapshot makes it both restorable and complete.
      //
      // ITS OWN TRY (re-review NEW-11): a sidecar that cannot be copied is a different refusal from
      // a main file that cannot be — the WAL-specific wording below is what the operator needs —
      // and it must not leave a main-only `pre-restore-*.db` behind, which is precisely the
      // sidecar-less file the probe refuses. So the partial snapshot is removed before refusing.
      try {
        for (const suffix of ["-wal", "-shm"]) {
          if (existsSync(`${dest}${suffix}`)) copyFileSync(`${dest}${suffix}`, `${snapshot}${suffix}`);
        }
      } catch {
        sidecarsCaptured = false;
        for (const suffix of ["", "-wal", "-shm"]) rmSync(`${snapshot}${suffix}`, { force: true });
        snapshot = undefined;
      }
    }
  }

  // SIDECARS FIRST, THEN THE COPY (review r1, minor 4). A leftover WAL from the REPLACED database
  // would be replayed over the restored one on the next open, so it must go — and it must go BEFORE
  // the copy, not after: in between lies a window where a crash (or a kill) would leave a RESTORED
  // database sitting beside the journal of the one it replaced, which is precisely the corruption
  // this clause exists to prevent. Removing them first can only ever leave the old file beside no
  // journal, and the old file is the one being thrown away.
  // NEVER A SIDECAR THAT IS NOT IN THE SNAPSHOT. The removal itself is not optional — a leftover WAL
  // from the REPLACED database would be replayed over the restored one on the next open — so a
  // sidecar this repair could not capture is a reason to refuse, not a reason to delete it anyway.
  if (!sidecarsCaptured) {
    return {
      applied: false,
      detail: `refusing to overwrite ${dest}: its write-ahead log could not be snapshotted, and restoring would discard it. Move the store and its -wal aside by hand and re-run.`,
    };
  }
  for (const path of [`${dest}-wal`, `${dest}-shm`]) rmSync(path, { force: true });
  copyFileSync(real, dest);
  // AND THE SOURCE'S OWN SIDECARS COME ALONG (re-review NEW-10). A byte-copy snapshot — the exact
  // file the success message below names for the reverse gesture — carries its committed tail in
  // `${real}-wal`; copying the main file alone restored the checkpointed PREFIX and reported
  // success. The `-shm` is a rebuildable index, copied so the restored pair opens exactly as the
  // source did; SQLite recovers a stale one. `VACUUM INTO` backups carry no sidecars and copy
  // nothing here.
  for (const suffix of ["-wal", "-shm"]) {
    if (existsSync(`${real}${suffix}`)) copyFileSync(`${real}${suffix}`, `${dest}${suffix}`);
  }
  return {
    applied: true,
    detail: `restored ${dest} from ${backupPath} (${statSync(dest).size} bytes); ${snapshot ? `the replaced file is at ${snapshot}` : "there was no file to replace"}`,
  };
}
