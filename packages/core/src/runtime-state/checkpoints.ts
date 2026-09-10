import type { RuntimeKind } from "@yanlinglabs/winter-runtime-sdk";
import type { RuntimeStateDb } from "./db";

/**
 * WS-16 §7's projection checkpoints: where a runtime's backend transcript has been read up to, and
 * which of its sources have already been turned into product events.
 *
 * ── THE IDEMPOTENCY CONTRACT (consumed by 8b's projector) ────────────────────────────────────────
 *
 *     begin({ winterSessionId, generation, sourceId })   // 1. claim the source
 *     SessionStore.append(sessionId, …)                  // 2. write the PRODUCT event log
 *     complete(key, cursor, { first, last })             // 3. commit the mark + advance the cursor
 *
 * Step 1 answers whether the work should happen at all:
 *
 *   - `"begun"`             — the source is new here; project it.
 *   - `"already-committed"` — this exact source was fully applied before. This is REPLAY: the
 *                             backend transcript is being re-read (a resume, a mirror catch-up, a
 *                             recovery sweep) and re-appending would duplicate the product events.
 *                             Skip it.
 *   - `"pending-elsewhere"` — a mark is open for this source: another projector is mid-flight, or a
 *                             previous one died between steps 2 and 3. NOT a second projection.
 *
 * The crash window is step 2→3, and it is deliberately left open rather than papered over: the
 * append and the mark live in two different stores (the session JSONL, and this SQLite file), so no
 * transaction can span them. What CAN be made atomic is step 3 — the mark and the cursor advance
 * together or not at all — and that is what `complete` does.
 *
 * Recovery reads the leftover marks with `pending()` and resolves each with `resolvePending`, whose
 * `tailContains` predicate is 8b's: it inspects the PRODUCT log tail for the mark's `sourceId`
 * (`tool_call.callId`, `turn_completed` for a `result`, the message uuid otherwise). The tail is the
 * only witness that can tell "the append landed, the commit did not" from "neither ran", because it
 * is the thing the append actually wrote. A `true` commits the mark (the events are already there);
 * a `false` DELETES it, so the next `begin` returns `"begun"` and the projector re-applies.
 *
 * A `ProjectionMark` is a VALUE read at some earlier instant, so by the time it is resolved the row
 * may already have moved on. Both of `resolvePending`'s statements therefore require
 * `state = 'pending'` and report `"already-resolved"` when they change no row — see the method.
 *
 * ── NEVER A WALL-CLOCK CURSOR ───────────────────────────────────────────────────────────────────
 *
 * `backendCursor` is an OPAQUE string owned by the adapter that produced it — a JSONL line number, a
 * backend sequence, a file offset. This file never reads a clock to make one, and never interprets
 * one. The only clock reading in this module is the injectable `now` that stamps `updatedAt`, which
 * is metadata about the row, not a position in anyone's transcript. A cursor derived from time would
 * silently skip or replay events whenever two writes landed in the same millisecond, or whenever a
 * transcript was re-read out of order.
 */
export interface ProjectionCheckpoint {
  winterSessionId: string;
  generation: number;
  runtimeKind: RuntimeKind;
  backendSessionId?: string;
  /** Opaque to this module — the adapter's own position, never a timestamp this file invented. */
  backendCursor: string;
  lastWinterSeq: number;
  sourceDigest?: string;
  updatedAt: string;
}

/** One source's projection state: claimed (`pending`) or fully applied (`committed`). */
export interface ProjectionMark {
  winterSessionId: string;
  generation: number;
  sourceId: string;
  state: "pending" | "committed";
  firstWinterSeq?: number;
  lastWinterSeq?: number;
  updatedAt: string;
}

/** The (session, generation, source) triple every door here is keyed by. */
export interface ProjectionKey {
  winterSessionId: string;
  generation: number;
  sourceId: string;
}

/** What `complete` is told about the cursor — the checkpoint minus the parts the key already fixes. */
export type ProjectionCursorInput = Omit<ProjectionCheckpoint, "winterSessionId" | "generation" | "updatedAt">;

/**
 * `complete` was handed a cursor whose `lastWinterSeq` disagrees with the range that was actually
 * appended (`seqs.last`). Those are two statements of one fact, and a caller that disagrees with
 * itself is a bug in the projector — loud here beats a silently-preferred half, which would leave
 * the mark and the checkpoint describing different ends of the same append.
 */
export class ProjectionCursorMismatchError extends Error {
  constructor(public readonly key: ProjectionKey, public readonly cursorLastWinterSeq: number, public readonly appendedLast: number) {
    super(`projection cursor disagrees with the appended range for ${key.winterSessionId}/${key.generation}/${key.sourceId}: cursor.lastWinterSeq=${cursorLastWinterSeq}, seqs.last=${appendedLast}`);
    this.name = "ProjectionCursorMismatchError";
  }
}

interface CursorRow { winter_session_id: string; generation: number; runtime_kind: string; backend_session_id: string | null; backend_cursor: string; last_winter_seq: number; source_digest: string | null; updated_at: string }
interface MarkRow { winter_session_id: string; generation: number; source_id: string; state: string; first_winter_seq: number | null; last_winter_seq: number | null; updated_at: string }

const CURSOR_COLUMNS = "winter_session_id, generation, runtime_kind, backend_session_id, backend_cursor, last_winter_seq, source_digest, updated_at";
const MARK_COLUMNS = "winter_session_id, generation, source_id, state, first_winter_seq, last_winter_seq, updated_at";

const toCheckpoint = (r: CursorRow): ProjectionCheckpoint => ({
  winterSessionId: r.winter_session_id, generation: r.generation, runtimeKind: r.runtime_kind as RuntimeKind,
  ...(r.backend_session_id === null ? {} : { backendSessionId: r.backend_session_id }),
  backendCursor: r.backend_cursor, lastWinterSeq: r.last_winter_seq,
  ...(r.source_digest === null ? {} : { sourceDigest: r.source_digest }),
  updatedAt: r.updated_at,
});

const toMark = (r: MarkRow): ProjectionMark => ({
  winterSessionId: r.winter_session_id, generation: r.generation, sourceId: r.source_id,
  state: r.state as ProjectionMark["state"],
  ...(r.first_winter_seq === null ? {} : { firstWinterSeq: r.first_winter_seq }),
  ...(r.last_winter_seq === null ? {} : { lastWinterSeq: r.last_winter_seq }),
  updatedAt: r.updated_at,
});

export class ProjectionCheckpoints {
  constructor(private readonly rs: RuntimeStateDb, private readonly now: () => string = () => new Date().toISOString()) {}

  get(winterSessionId: string, generation: number): ProjectionCheckpoint | undefined {
    const row = this.rs.db.query<CursorRow, [string, number]>(`SELECT ${CURSOR_COLUMNS} FROM runtime_projection_cursors WHERE winter_session_id = ? AND generation = ?`).get(winterSessionId, generation);
    return row ? toCheckpoint(row) : undefined;
  }

  /** The newest incarnation's checkpoint — highest GENERATION, never latest `updated_at`. */
  latest(winterSessionId: string): ProjectionCheckpoint | undefined {
    const row = this.rs.db.query<CursorRow, [string]>(`SELECT ${CURSOR_COLUMNS} FROM runtime_projection_cursors WHERE winter_session_id = ? ORDER BY generation DESC LIMIT 1`).get(winterSessionId);
    return row ? toCheckpoint(row) : undefined;
  }

  /**
   * Step 1 of a projection: record the source as pending.
   *
   * Read-then-insert, so it is one transaction — otherwise two projectors could both see "no mark"
   * and both be told `"begun"`, which is exactly the double-append this class exists to prevent.
   */
  begin(key: ProjectionKey): "begun" | "already-committed" | "pending-elsewhere" {
    return this.rs.transaction(() => {
      const existing = this.rs.db.query<{ state: string }, [string, number, string]>("SELECT state FROM projection_applied WHERE winter_session_id = ? AND generation = ? AND source_id = ?")
        .get(key.winterSessionId, key.generation, key.sourceId);
      if (existing?.state === "committed") return "already-committed" as const;
      if (existing !== null && existing !== undefined) return "pending-elsewhere" as const;
      this.rs.db.run(`INSERT INTO projection_applied (${MARK_COLUMNS}) VALUES (?, ?, ?, 'pending', NULL, NULL, ?)`,
        [key.winterSessionId, key.generation, key.sourceId, this.now()]);
      return "begun" as const;
    });
  }

  /**
   * Step 3: mark the source committed AND advance the generation's cursor, in ONE transaction.
   *
   * If either write fails, neither lands — a committed mark whose cursor never moved would re-read
   * the same backend region forever, and an advanced cursor whose mark stayed pending would send
   * recovery hunting for events the projector had already decided not to re-apply.
   *
   * `seqs.last` — not `cursor.lastWinterSeq` — is what the cursor row records, so the checkpoint and
   * the mark can never disagree about where the appended range ended. The field is still on the
   * input type because the seam's checkpoint shape carries it; it is the RANGE that is authoritative.
   * The two are nonetheless required to AGREE: a caller that states both and states them
   * differently is throwing away one of its own facts, and `ProjectionCursorMismatchError` says so
   * before anything is written. (Fix round 1, minor 2 — silently discarding the field was the
   * previous behaviour, and it hid exactly this class of projector bug.)
   */
  complete(key: ProjectionKey, cursor: ProjectionCursorInput, seqs: { first: number; last: number }): ProjectionCheckpoint {
    if (cursor.lastWinterSeq !== seqs.last) throw new ProjectionCursorMismatchError(key, cursor.lastWinterSeq, seqs.last);
    const updatedAt = this.now();
    return this.rs.transaction(() => {
      this.rs.db.run(`INSERT OR REPLACE INTO projection_applied (${MARK_COLUMNS}) VALUES (?, ?, ?, 'committed', ?, ?, ?)`,
        [key.winterSessionId, key.generation, key.sourceId, seqs.first, seqs.last, updatedAt]);
      this.rs.db.run(`INSERT OR REPLACE INTO runtime_projection_cursors (${CURSOR_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [key.winterSessionId, key.generation, cursor.runtimeKind, cursor.backendSessionId ?? null, cursor.backendCursor, seqs.last, cursor.sourceDigest ?? null, updatedAt]);
      return {
        winterSessionId: key.winterSessionId, generation: key.generation, runtimeKind: cursor.runtimeKind,
        ...(cursor.backendSessionId === undefined ? {} : { backendSessionId: cursor.backendSessionId }),
        backendCursor: cursor.backendCursor, lastWinterSeq: seqs.last,
        ...(cursor.sourceDigest === undefined ? {} : { sourceDigest: cursor.sourceDigest }),
        updatedAt,
      };
    });
  }

  /** Every open mark — the recovery sweep's worklist. Scoped to one session when asked. */
  pending(winterSessionId?: string): ProjectionMark[] {
    const rows = winterSessionId === undefined
      ? this.rs.db.query<MarkRow, []>(`SELECT ${MARK_COLUMNS} FROM projection_applied WHERE state = 'pending' ORDER BY rowid`).all()
      : this.rs.db.query<MarkRow, [string]>(`SELECT ${MARK_COLUMNS} FROM projection_applied WHERE state = 'pending' AND winter_session_id = ? ORDER BY rowid`).all(winterSessionId);
    return rows.map(toMark);
  }

  /**
   * Recovery: resolve one pending mark against the product log.
   *
   * `tailContains` is the caller's witness (8b's inspects the log tail for the mark's `sourceId`).
   * `true` → the append landed and only the commit was lost: mark it committed, so the source is
   * never re-applied. `false` → nothing landed: DELETE the mark, so the next `begin` says `"begun"`
   * and the projector re-applies it. A reset is a deletion, not a state, because a third state would
   * be one more thing every reader of `projection_applied` has to know about.
   *
   * BOTH STATEMENTS REQUIRE `state = 'pending'`, and the outcome is derived from how many rows they
   * actually changed (fix round 1, important 1). The `mark` is a VALUE the caller read from
   * `pending()` at some earlier instant; if the source was `complete`d in between, keying only on
   * (session, generation, source) would let a `false` predicate ERASE THE COMMITTED MARK — after
   * which `begin` answers `"begun"` and the projector re-appends events that are already in the
   * product log. That is precisely the double-append this class exists to prevent, and it is why
   * the predicate's answer alone must not decide the outcome: a resolve that changed no row reports
   * `"already-resolved"` rather than claiming a transition it did not make.
   *
   * Each branch is still ONE statement, so the check and the write cannot be split by a racing
   * writer — there is no read-then-write window to lose.
   */
  resolvePending(mark: ProjectionMark, tailContains: (mark: ProjectionMark) => boolean): "committed" | "reset" | "already-resolved" {
    const landed = tailContains(mark);
    const changes = landed
      ? this.rs.db.run("UPDATE projection_applied SET state = 'committed', updated_at = ? WHERE winter_session_id = ? AND generation = ? AND source_id = ? AND state = 'pending'",
        [this.now(), mark.winterSessionId, mark.generation, mark.sourceId]).changes
      : this.rs.db.run("DELETE FROM projection_applied WHERE winter_session_id = ? AND generation = ? AND source_id = ? AND state = 'pending'",
        [mark.winterSessionId, mark.generation, mark.sourceId]).changes;
    if (changes === 0) return "already-resolved";
    return landed ? "committed" : "reset";
  }
}
