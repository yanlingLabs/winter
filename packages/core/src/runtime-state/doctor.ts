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
import { appendFileSync, copyFileSync, existsSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SessionStore, SYNCED_SESSION_ID_RE } from "../sessions/store";
import { openRuntimeStateDb, RuntimeStateUnavailableError, type RuntimeStateDb } from "./db";
import { ALLOWED_TRANSITIONS, RuntimeSessionRecords } from "./records";
import { processIsAlive } from "./leases";

export type FindingKind =
  | "db-missing"
  | "db-corrupt"
  | "db-newer-schema"
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
    for (const row of db.query<IndexRow, []>("SELECT session_id, scope, last_seq, cwd FROM sessions").all()) rows.set(row.session_id, row);
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

/** The last non-empty line of a session log, parsed only far enough to learn its `seq`. Never
 *  inspects a body: `undefined` means "there is no readable trailing frame", which is all the
 *  drift check and the tail repair need to know. */
function tailSeq(logPath: string): number | undefined {
  if (!existsSync(logPath)) return undefined;
  const lines = readFileSync(logPath, "utf8").split("\n").filter((l) => l.length > 0);
  const last = lines[lines.length - 1];
  if (last === undefined) return undefined;
  try {
    const seq = (JSON.parse(last) as { seq?: unknown }).seq;
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
    if (e.reason === "missing") return [{ kind: "db-missing", detail: `${e.path}: the authoritative runtime store is not there`, repairable: ["restore-backup"] }];
    return [{ kind: "db-corrupt", detail: `${e.path}: ${e.reason}`, repairable: ["restore-backup"] }];
  }

  try {
    const integrity = rs.integrity();
    if (!integrity.ok) {
      return [{ kind: "db-corrupt", detail: `${rs.path}: ${integrity.checks.join("; ")}`, repairable: ["restore-backup"] }];
    }

    const readIndexResult = readIndex(home);
    if (!readIndexResult) {
      findings.push({
        kind: "index-drift",
        detail: `${join(home, "sessions", "index.db")} cannot be opened; the daemon will refuse to start until it is rebuilt`,
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
    for (const row of rs.db
      .query<{ winter_session_id: string; generation: number; lease_holder_pid: number; lease_holder_started_at: string | null }, []>(
        `SELECT winter_session_id, generation, lease_holder_pid, lease_holder_started_at FROM runtime_generations
         WHERE lease_holder_pid IS NOT NULL AND lease_released_at IS NULL ORDER BY winter_session_id, generation`,
      )
      .all()) {
      if (processIsAlive(row.lease_holder_pid)) continue;
      findings.push({
        kind: "stale-live-registration",
        winterSessionId: row.winter_session_id,
        detail: `generation ${row.generation} still holds a lease for pid ${row.lease_holder_pid} (started ${row.lease_holder_started_at ?? "unknown"}), which is gone`,
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

export async function repairRuntimeState(home: string, op: RepairOp, deps: { store?: SessionStore } = {}): Promise<RepairResult> {
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

  const lines = readFileSync(logPath, "utf8").split("\n").filter((l) => l.length > 0);
  const last = lines[lines.length - 1];
  if (last === undefined) return { applied: false, detail: `no incomplete trailing frame in ${logPath}` };
  try {
    JSON.parse(last);
    return { applied: false, detail: `no incomplete trailing frame in ${logPath}` };
  } catch {
    /* torn tail: fall through and quarantine it */
  }

  // File surgery FIRST: constructing a `SessionStore` runs `recoverAll`, which would silently drop
  // the very line this repair exists to preserve.
  const quarantine = join(home, "sessions", row.scope, `${sessionId}.quarantine.jsonl`);
  appendFileSync(quarantine, `${last}\n`);
  const tmp = `${logPath}.repair`;
  writeFileSync(tmp, lines.slice(0, -1).map((l) => `${l}\n`).join(""));
  renameSync(tmp, logPath); // atomic: a crash never leaves a partial log

  const store = injected ?? new SessionStore(home);
  try {
    store.recoverAll();
  } finally {
    if (!injected) store.close();
  }
  // Bytes and a path — never the bytes themselves.
  return { applied: true, detail: `quarantined 1 trailing frame (${Buffer.byteLength(last)} bytes) to ${quarantine}` };
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
  const rs = openRuntimeStateDb(home);
  try {
    const records = new RuntimeSessionRecords(rs);
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
    rs.transaction(
      () => {
        const still = records.byBackendSessionId(backendSessionId);
        if (still && still.winterSessionId !== sessionId) throw new Error(`backend ${backendSessionId} is already mapped to ${still.winterSessionId}`);
        rs.db.run("UPDATE runtime_sessions SET backend_session_id = ?, updated_at = ? WHERE winter_session_id = ?", [
          backendSessionId,
          new Date().toISOString(),
          sessionId,
        ]);
      },
      { mode: "immediate" },
    );
    return { applied: true, detail: `${sessionId} now maps to backend ${backendSessionId}` };
  } catch (e) {
    return { applied: false, detail: e instanceof Error ? e.message : "relink failed" };
  } finally {
    rs.close();
  }
}

/** §14's "canonical compatibility transcript missing" row: show product history read-only, mark
 *  resume unavailable. The product log is never touched — that history is the whole point. */
function detachBackend(home: string, sessionId: string): RepairResult {
  const rs = openRuntimeStateDb(home);
  try {
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
  } finally {
    rs.close();
  }
}

/** §16's restore door. Three refusals before a single byte moves: the daemon must not be running,
 *  the source must live in THIS home's backup directory (realpath'd, so a symlink cannot point out
 *  of it), and the source must pass its own integrity check — restoring a corrupt backup over a
 *  corrupt database would be the one repair that cannot be undone. */
function restoreBackup(home: string, backupPath: string): RepairResult {
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
  copyFileSync(real, dest);
  // A leftover WAL from the REPLACED database would be replayed over the restored one on the next
  // open — the sidecars must go with the file they belonged to.
  for (const path of [`${dest}-wal`, `${dest}-shm`]) rmSync(path, { force: true });
  return { applied: true, detail: `restored ${dest} from ${backupPath} (${statSync(dest).size} bytes)` };
}
