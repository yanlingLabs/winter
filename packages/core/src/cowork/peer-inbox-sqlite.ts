import type { RuntimeStateDb } from "../runtime-state/db";
import { durableCoworkTransaction } from "./durable-transaction";
import { isTerminalPeerState } from "./peer-inbox";
import type { PeerCommitOutcome, PeerAppendResult, PeerInboxAudit, PeerInboxCaps, PeerInboxEntry, PeerInboxPatch, PeerInboxRecord, PeerInboxStore, PeerReceiptState, PeerSendIdentity } from "./peer-inbox";
import { CoworkError } from "./types";

/*
 * SQLite `PeerInboxStore` over the runtime-state database (schema 17, table `cowork_peer_inbox`). UNWIRED: nothing
 * under src/ imports this module, and nothing creates a store in a production path.
 *
 * Owner decisions (2026-10-16): a dedicated table, not the operations log; the body is kept only while the message
 * is owed; the table is excluded from backups (`RuntimeStateDb.backup()` empties it in the copy); no extra
 * encryption.
 *
 * The body is a BLOB column of the SAME row as the record. That makes the hard-crash leftovers of a separate body
 * store (an orphan body, a terminal record that still holds one) unrepresentable: a record and its body commit in
 * one transaction, and a CHECK constraint forbids a terminal row that holds a body, so reaching a terminal state
 * and releasing the body are one statement. Every mutating method runs in `durableCoworkTransaction` (an
 * IMMEDIATE transaction under synchronous=FULL with fullfsync on Darwin), so "returns means committed" and two
 * live connections serialize their appends and compare-and-set updates.
 *
 * No body is ever selected by a record query: records carry a derived handle (`pib_<receipt id>`, present only
 * while the row holds a body) and only `readBody` reads the column. Errors are CoworkError codes or SQLite's own
 * (which never contain parameter values); the ledger maps any non-CoworkError to `recovery_required`.
 */

const HANDLE_PREFIX = "pib_";
const CONTROL = /[\u0000-\u001f\u007f]/;
const COLUMNS = `receipt_id, sender_session_id, sender_incarnation, send_id, recipient_session_id, digest, size,
  body IS NOT NULL AS has_body, sequence, state, reason, attempts, offered_incarnation, offered_lease_epoch,
  delivered_incarnation, delivered_lease_epoch, discarded_by, offer_count, acked_hold_token, commit_confirmed_at, commit_outcome, accepted_at, updated_at, version`;
const STATES: readonly PeerReceiptState[] = ["accepted", "delivered", "blocked", "refused"];
const DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

interface Row {
  receipt_id: string; sender_session_id: string; sender_incarnation: string; send_id: string; recipient_session_id: string;
  digest: string; size: number; has_body: number; sequence: number; state: PeerReceiptState; reason: PeerInboxRecord["reason"];
  attempts: number; offered_incarnation: string | null; offered_lease_epoch: number | null;
  delivered_incarnation: string | null; delivered_lease_epoch: number | null; discarded_by: string | null;
  offer_count: number; acked_hold_token: string | null; commit_confirmed_at: number | null; commit_outcome: PeerCommitOutcome | null;
  accepted_at: number; updated_at: number; version: number;
}

function checkId(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256 || CONTROL.test(value)) throw new CoworkError("invalid_request");
}
function checkEpoch(epoch: unknown): void {
  const candidate = epoch as { incarnationId?: unknown; leaseEpoch?: unknown } | null;
  checkId(candidate?.incarnationId);
  if (!Number.isSafeInteger(candidate.leaseEpoch) || (candidate.leaseEpoch as number) < 0) throw new CoworkError("invalid_request");
}
const record = (row: Row): PeerInboxRecord => ({
  receiptId: row.receipt_id, senderSessionId: row.sender_session_id, senderIncarnation: row.sender_incarnation, sendId: row.send_id,
  recipientSessionId: row.recipient_session_id, digest: row.digest, size: row.size,
  bodyHandle: row.has_body ? `${HANDLE_PREFIX}${row.receipt_id}` : null, sequence: row.sequence, state: row.state, reason: row.reason,
  attempts: row.attempts,
  offered: row.offered_incarnation === null ? null : { incarnationId: row.offered_incarnation, leaseEpoch: row.offered_lease_epoch! },
  deliveredUnder: row.delivered_incarnation === null ? null : { incarnationId: row.delivered_incarnation, leaseEpoch: row.delivered_lease_epoch! },
  discardedBy: row.discarded_by, offerCount: row.offer_count, ackedHoldToken: row.acked_hold_token, commitConfirmedAt: row.commit_confirmed_at, commitOutcome: row.commit_outcome, acceptedAt: row.accepted_at, updatedAt: row.updated_at, version: row.version,
});

export class SqlitePeerInboxStore implements PeerInboxStore {
  constructor(private readonly rs: RuntimeStateDb) {
    // The open-time sweep. With the body in the record's own row nothing can orphan, and the CHECK keeps a terminal
    // row from holding a body, so on a healthy store this changes nothing; it releases a body that damage (or a
    // constraint-ignoring writer) left on a terminal row. `unresolvedWithoutBody` is damage and is never swept.
    this.sweep();
  }

  /** A seam after each statement of an append, so a test can fail the append part-way and prove the rollback. */
  protected step(): void {}
  /** A seam before a body read, so a test can make one body unreadable. */
  protected beforeBodyRead(_handle: string): void {}

  private sweep(): void {
    this.erasing(() => durableCoworkTransaction(this.rs, () => { this.rs.db.run("UPDATE cowork_peer_inbox SET body=NULL WHERE state IN ('delivered','refused') AND body IS NOT NULL"); }));
  }

  /**
   * Runs a body-releasing operation with `secure_delete = ON` for this connection, then restores the previous value.
   * The pinned default (FAST) zeroes only what is cheap to zero and does NOT erase the overflow pages of a body larger
   * than a page (measured: the tail of a 20 KB body survived a delete), so every statement that releases a body (a
   * terminal move, the open-time sweep, a workspace purge) runs under ON, which zeroes every freed page. Scoped, not
   * global: no other table pays for it and the shared pin in db.ts is untouched. The WAL keeps older frames of the
   * body until the next checkpoint (see the research note); that is a checkpoint question, not a purge one.
   */
  private erasing<T>(operation: () => T): T {
    const db = this.rs.db;
    const previous = db.query<{ secure_delete: number }, []>("PRAGMA secure_delete").get()?.secure_delete ?? 2;
    db.run("PRAGMA secure_delete = ON");
    try { return operation(); } finally { db.run(`PRAGMA secure_delete = ${previous === 0 ? "OFF" : previous === 1 ? "ON" : "FAST"}`); }
  }

  append(entry: PeerInboxEntry, body: string, caps: PeerInboxCaps): PeerAppendResult {
    for (const value of [entry?.receiptId, entry?.senderSessionId, entry?.senderIncarnation, entry?.sendId, entry?.recipientSessionId, entry?.digest]) checkId(value);
    if (typeof body !== "string" || !body.isWellFormed() || entry.size !== Buffer.byteLength(body, "utf8") || !Number.isFinite(entry.acceptedAt)) throw new CoworkError("invalid_request");
    for (const cap of [caps?.maxUnresolvedPerRecipient, caps?.maxUnresolvedPerSenderRecipient, caps?.maxUnresolvedBytesPerRecipient]) if (!Number.isSafeInteger(cap) || (cap as number) < 1) throw new CoworkError("invalid_request");
    const payload = Buffer.from(body, "utf8");
    return durableCoworkTransaction(this.rs, (): PeerAppendResult => {
      const db = this.rs.db;
      const existing = db.query<Row, [string, string, string]>(`SELECT ${COLUMNS} FROM cowork_peer_inbox WHERE sender_session_id=? AND sender_incarnation=? AND send_id=?`).get(entry.senderSessionId, entry.senderIncarnation, entry.sendId);
      this.step();
      if (existing) return { status: "existing", record: record(existing) };
      if (db.query("SELECT 1 FROM cowork_peer_inbox WHERE receipt_id=?").get(entry.receiptId)) throw new CoworkError("request_conflict");
      this.step();
      const usage = db.query<{ total: number; sender: number; bytes: number }, [string, string]>(
        `SELECT count(*) AS total, coalesce(sum(sender_session_id=?),0) AS sender, coalesce(sum(size),0) AS bytes
         FROM cowork_peer_inbox WHERE recipient_session_id=? AND state IN ('accepted','blocked')`).get(entry.senderSessionId, entry.recipientSessionId)!;
      this.step();
      if (usage.sender >= caps.maxUnresolvedPerSenderRecipient) return { status: "full", reason: "sender_quota" };
      if (usage.total >= caps.maxUnresolvedPerRecipient) return { status: "full", reason: "inbox_full" };
      if (usage.bytes + entry.size > caps.maxUnresolvedBytesPerRecipient) return { status: "full", reason: "inbox_bytes_full" };
      const { last_sequence: sequence } = db.query<{ last_sequence: number }, [string]>(
        `INSERT INTO cowork_peer_inbox_sequences(recipient_session_id,last_sequence) VALUES(?,1)
         ON CONFLICT(recipient_session_id) DO UPDATE SET last_sequence=last_sequence+1 RETURNING last_sequence`).get(entry.recipientSessionId)!;
      this.step();
      db.run(`INSERT INTO cowork_peer_inbox(receipt_id,sender_session_id,sender_incarnation,send_id,recipient_session_id,digest,size,body,sequence,state,attempts,accepted_at,updated_at,version)
              VALUES(?,?,?,?,?,?,?,?,?,'accepted',0,?,?,1)`,
        [entry.receiptId, entry.senderSessionId, entry.senderIncarnation, entry.sendId, entry.recipientSessionId, entry.digest, entry.size, payload, sequence, entry.acceptedAt, entry.acceptedAt]);
      this.step();
      return { status: "created", record: record(this.row(entry.receiptId)!) };
    });
  }

  find(identity: PeerSendIdentity): PeerInboxRecord | undefined {
    const row = this.rs.db.query<Row, [string, string, string]>(`SELECT ${COLUMNS} FROM cowork_peer_inbox WHERE sender_session_id=? AND sender_incarnation=? AND send_id=?`).get(identity.senderSessionId, identity.senderIncarnation, identity.sendId);
    return row ? record(row) : undefined;
  }
  get(receiptId: string): PeerInboxRecord | undefined {
    const row = this.row(receiptId);
    return row ? record(row) : undefined;
  }
  unresolved(recipientSessionId: string): PeerInboxRecord[] { return this.ordered(recipientSessionId, false); }
  terminal(recipientSessionId: string): PeerInboxRecord[] { return this.ordered(recipientSessionId, true); }
  recipients(): string[] {
    return this.rs.db.query<{ recipient_session_id: string }, []>("SELECT DISTINCT recipient_session_id FROM cowork_peer_inbox ORDER BY recipient_session_id").all().map(row => row.recipient_session_id);
  }

  update(receiptId: string, expectedVersion: number, patch: PeerInboxPatch): PeerInboxRecord {
    const sets: string[] = [], args: Array<string | number | null> = [];
    const set = (column: string, value: string | number | null) => { sets.push(`${column}=?`); args.push(value); };
    if (patch.state !== undefined) { if (!STATES.includes(patch.state)) throw new CoworkError("invalid_request"); set("state", patch.state); }
    if (patch.reason !== undefined) { if (patch.reason !== null) checkId(patch.reason); set("reason", patch.reason); }
    if (patch.attempts !== undefined) { if (!Number.isSafeInteger(patch.attempts) || patch.attempts < 0) throw new CoworkError("invalid_request"); set("attempts", patch.attempts); }
    for (const [key, columns] of [["offered", ["offered_incarnation", "offered_lease_epoch"]], ["deliveredUnder", ["delivered_incarnation", "delivered_lease_epoch"]]] as const) {
      const epoch = patch[key];
      if (epoch === undefined) continue;
      if (epoch !== null) checkEpoch(epoch);
      set(columns[0], epoch === null ? null : epoch.incarnationId); set(columns[1], epoch === null ? null : epoch.leaseEpoch);
    }
    if (patch.discardedBy !== undefined) { if (patch.discardedBy !== null) checkId(patch.discardedBy); set("discarded_by", patch.discardedBy); }
    if (patch.offerCount !== undefined) { if (!Number.isSafeInteger(patch.offerCount) || patch.offerCount < 0) throw new CoworkError("invalid_request"); set("offer_count", patch.offerCount); }
    if (patch.ackedHoldToken !== undefined) { if (patch.ackedHoldToken !== null && !/^[0-9a-f]{64}$/.test(patch.ackedHoldToken)) throw new CoworkError("invalid_request"); set("acked_hold_token", patch.ackedHoldToken); }
    if (!Number.isFinite(patch.updatedAt)) throw new CoworkError("invalid_request");
    set("updated_at", patch.updatedAt);
    const run = () => durableCoworkTransaction(this.rs, () => {
      const current = this.row(receiptId);
      if (!current) throw new CoworkError("not_found");
      if (current.version !== expectedVersion) throw new CoworkError("revision_conflict", current.version);
      if (isTerminalPeerState(current.state)) throw new CoworkError("invalid_request");
      // A move to a terminal state releases the body in the same statement as the state change.
      const releases = patch.state !== undefined && isTerminalPeerState(patch.state) ? ", body=NULL" : "";
      this.rs.db.run(`UPDATE cowork_peer_inbox SET ${sets.join(", ")}${releases}, version=version+1 WHERE receipt_id=? AND version=?`, [...args, receiptId, expectedVersion]);
      return record(this.row(receiptId)!);
    });
    // Every update, not only the terminal one: an UPDATE rewrites the row, and a rewrite that changes its size frees the old
    // overflow chain of a large body (offer and block do exactly that), which must be zeroed too.
    return this.erasing(run);
  }

  confirm(receiptId: string, outcome: PeerCommitOutcome, at: number): PeerInboxRecord {
    if (!Number.isFinite(at)) throw new CoworkError("invalid_request");
    return durableCoworkTransaction(this.rs, () => {
      const current = this.row(receiptId);
      if (!current) throw new CoworkError("not_found");
      if (current.state !== "delivered" || current.acked_hold_token === null) throw new CoworkError("invalid_request");
      if (current.commit_confirmed_at !== null) return record(current);
      this.rs.db.run("UPDATE cowork_peer_inbox SET commit_confirmed_at=?, commit_outcome=?, version=version+1 WHERE receipt_id=?", [at, outcome, receiptId]);
      return record(this.row(receiptId)!);
    });
  }

  readBody(handle: string): string | undefined {
    if (typeof handle !== "string" || !handle.startsWith(HANDLE_PREFIX)) return undefined;
    this.beforeBodyRead(handle);
    const row = this.rs.db.query<{ body: Uint8Array | null }, [string]>("SELECT body FROM cowork_peer_inbox WHERE receipt_id=?").get(handle.slice(HANDLE_PREFIX.length));
    if (!row || row.body === null) return undefined; // definitive absence only; every read or decode error throws
    return DECODER.decode(row.body);
  }

  remove(receiptId: string): void {
    durableCoworkTransaction(this.rs, () => {
      const current = this.row(receiptId);
      if (!current) throw new CoworkError("not_found");
      if (!isTerminalPeerState(current.state)) throw new CoworkError("invalid_request");
      // The recipient's sequence counter lives in its own table and is untouched.
      this.rs.db.run("DELETE FROM cowork_peer_inbox WHERE receipt_id=?", [receiptId]);
    });
  }

  audit(): PeerInboxAudit {
    const ids = (sql: string) => this.rs.db.query<{ receipt_id: string }, []>(sql).all().map(row => row.receipt_id);
    return {
      unresolvedWithoutBody: ids("SELECT receipt_id FROM cowork_peer_inbox WHERE state IN ('accepted','blocked') AND body IS NULL ORDER BY receipt_id"),
      terminalWithBody: ids("SELECT receipt_id FROM cowork_peer_inbox WHERE state IN ('delivered','refused') AND body IS NOT NULL ORDER BY receipt_id"),
      orphanBodies: 0, // a body is a column of its record's row: it cannot outlive or precede the record
    };
  }

  /** Workspace deletion. Drops every row addressed TO a session of the workspace (it can never be delivered, and its
   * body must not outlive the workspace) together with those recipients' counters, and ends every row SENT by one of
   * its sessions to a live recipient as `refused: sender_gone` with the body released, which is the ledger's own
   * transition for a vanished sender. A session belongs to the workspace by its `cowork_conversations` row, whatever
   * that row's state. Returns the number of rows touched. Run it in the same transaction as the workspace's
   * deletion once a delete path exists; standalone it opens its own. */
  purgeWorkspace(workspaceId: string, now: number): number {
    checkId(workspaceId);
    if (!Number.isFinite(now)) throw new CoworkError("invalid_request");
    const run = () => {
      const members = "SELECT session_id FROM cowork_conversations WHERE workspace_id=?";
      const toRecipients = this.rs.db.query(`DELETE FROM cowork_peer_inbox WHERE recipient_session_id IN (${members})`).run(workspaceId).changes;
      this.rs.db.run(`DELETE FROM cowork_peer_inbox_sequences WHERE recipient_session_id IN (${members})`, [workspaceId]);
      const fromSenders = this.rs.db.query(
        `UPDATE cowork_peer_inbox SET state='refused', reason='sender_gone', body=NULL, offered_incarnation=NULL, offered_lease_epoch=NULL, updated_at=?, version=version+1
         WHERE state IN ('accepted','blocked') AND sender_session_id IN (${members})`).run(now, workspaceId).changes;
      return toRecipients + fromSenders;
    };
    return this.erasing(() => this.rs.db.inTransaction ? run() : durableCoworkTransaction(this.rs, run));
  }

  private row(receiptId: string): Row | null {
    return this.rs.db.query<Row, [string]>(`SELECT ${COLUMNS} FROM cowork_peer_inbox WHERE receipt_id=?`).get(receiptId);
  }
  private ordered(recipientSessionId: string, terminal: boolean): PeerInboxRecord[] {
    const states = terminal ? "('delivered','refused')" : "('accepted','blocked')";
    return this.rs.db.query<Row, [string]>(`SELECT ${COLUMNS} FROM cowork_peer_inbox WHERE recipient_session_id=? AND state IN ${states} ORDER BY sequence`).all(recipientSessionId).map(record);
  }
}
