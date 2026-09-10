import type {
  CursorStore, DeliveryOutcome, DeliveryRecord, DeliveryRecordStore, GlobalAgentMessage, HeldMessageRecord,
  IdleSubscriptionRecord, IdleSubscriptionStore, MailboxStore, NameLeaseRecord, NameLeaseStore, RuntimeKind,
  RuntimeDirectoryEntry, RuntimeDirectoryStore, SerializedRuntimeAddress,
} from "@yanlinglabs/winter-runtime-sdk";
import type { RuntimeStateDb } from "./db";

/**
 * R-7b-2's `RuntimeDirectoryStore`, backed by `runtime-state.db`.
 *
 * THIS IS A SINK, NOT A POLICY. Caps, expiry, dedupe windows, retry limits, loop guards, name-lease
 * arbitration — every one of those belongs to the router, and none of them is spelled here. The only
 * judgements this file makes are the two the seam's own documentation makes load-bearing:
 *
 *  1. A CLAIMED-BUT-UNRECEIPTED DELIVERY IS NEVER PRUNED, and a HELD NAME LEASE IS NEVER PRUNED — at
 *     any age. The pair (claimed, no receipt) is WS-15 §6.4 step 5's entire evidence for
 *     `delivery_uncertain`, and a held lease is the live answer to "who owns this name". Both
 *     `prune` doors therefore filter on the receipt/release column, never on age alone.
 *  2. JSON GOES IN AND OUT VERBATIM. `directory_entries.entry_json` is `JSON.stringify(entry)` and
 *     nothing else: a field a newer router writes must survive a round trip through an older daemon
 *     untouched, so this file must never re-shape an entry from named columns it happens to know.
 *
 * Every method is `async` because the seam is async; every method is SYNCHRONOUS inside, because
 * `bun:sqlite` is. That is what makes `takeHeld` atomic without a lock: the whole read-then-delete
 * runs before any other continuation can be scheduled, and it is wrapped in a transaction so a crash
 * between the two cannot lose the message either.
 */
export function createSqliteRuntimeDirectoryStore(rs: RuntimeStateDb): RuntimeDirectoryStore {
  const db = rs.db;

  // ── Directory entries ────────────────────────────────────────────────────────────────────────
  const load = async (): Promise<RuntimeDirectoryEntry[]> =>
    db.query<{ entry_json: string }, []>("SELECT entry_json FROM directory_entries ORDER BY address").all()
      .map((r) => JSON.parse(r.entry_json) as RuntimeDirectoryEntry);

  const upsert = async (entry: RuntimeDirectoryEntry): Promise<void> => {
    db.run("INSERT OR REPLACE INTO directory_entries (address, entry_json, updated_at) VALUES (?, ?, ?)",
      [entry.address, JSON.stringify(entry), entry.updatedAt]);
  };

  const remove = async (address: SerializedRuntimeAddress): Promise<void> => {
    db.run("DELETE FROM directory_entries WHERE address = ?", [address]);
  };

  // ── Cursors ──────────────────────────────────────────────────────────────────────────────────
  // A cursor is opaque to this seam: what it points at is the adapter's business, so it is stored
  // and returned as the exact string handed in — never parsed, never re-stamped.
  const cursors: CursorStore = {
    async get(address) {
      return db.query<{ cursor: string }, [string]>("SELECT cursor FROM directory_cursors WHERE address = ?").get(address)?.cursor;
    },
    async set(address, cursor) {
      db.run("INSERT OR REPLACE INTO directory_cursors (address, cursor) VALUES (?, ?)", [address, cursor]);
    },
    async remove(address) {
      db.run("DELETE FROM directory_cursors WHERE address = ?", [address]);
    },
    async all() {
      const out: Record<SerializedRuntimeAddress, string> = {};
      for (const r of db.query<{ address: string; cursor: string }, []>("SELECT address, cursor FROM directory_cursors ORDER BY rowid").all()) out[r.address] = r.cursor;
      return out;
    },
  };

  // ── Held mailbox ─────────────────────────────────────────────────────────────────────────────
  interface HeldRow { receiver: string; message_id: string; reason: string; kind: string; held_at: number; expires_at: number | null; message_json: string }
  const toHeld = (r: HeldRow): HeldMessageRecord => ({
    messageId: r.message_id, receiver: r.receiver, reason: r.reason, kind: r.kind as HeldMessageRecord["kind"],
    heldAt: r.held_at, ...(r.expires_at === null ? {} : { expiresAt: r.expires_at }),
    message: JSON.parse(r.message_json) as GlobalAgentMessage,
  });
  const HELD_COLUMNS = "receiver, message_id, reason, kind, held_at, expires_at, message_json";

  const mailboxes: MailboxStore = {
    async listHeld(receiver) {
      // rowid order is hold order, which is the order the reference (an array push) preserves and
      // the order a restart sweep wants: oldest hold first.
      return db.query<HeldRow, [string]>(`SELECT ${HELD_COLUMNS} FROM held_messages WHERE receiver = ? ORDER BY rowid`).all(receiver).map(toHeld);
    },
    async hold(record) {
      // DELIBERATE DIVERGENCE from the in-memory reference, which APPENDS: `PRIMARY KEY (receiver,
      // message_id)` dedupes here, so re-holding a message updates it in place instead of leaving
      // two copies of one envelope in a durable mailbox. Edge it changes: a second `hold` of the
      // same (receiver, messageId) overwrites reason/kind/expiry and moves the record to the end of
      // hold order, where the reference would have listed the message twice.
      db.run(`INSERT OR REPLACE INTO held_messages (${HELD_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [record.receiver, record.messageId, record.reason, record.kind, record.heldAt, record.expiresAt ?? null, JSON.stringify(record.message)]);
    },
    async takeHeld(receiver, messageId) {
      return rs.transaction(() => {
        const row = db.query<HeldRow, [string, string]>(`SELECT ${HELD_COLUMNS} FROM held_messages WHERE receiver = ? AND message_id = ?`).get(receiver, messageId);
        if (!row) return undefined;
        db.run("DELETE FROM held_messages WHERE receiver = ? AND message_id = ?", [receiver, messageId]);
        return toHeld(row);
      });
    },
    async clear(receiver) {
      db.run("DELETE FROM held_messages WHERE receiver = ?", [receiver]);
    },
    async receivers() {
      // `MIN(rowid)` per receiver: the sweep entry point lists receivers in the order they first
      // held something, which is what the reference's Map key order gives.
      return db.query<{ receiver: string }, []>("SELECT receiver FROM held_messages GROUP BY receiver ORDER BY MIN(rowid)").all().map((r) => r.receiver);
    },
  };

  // ── Delivery records ─────────────────────────────────────────────────────────────────────────
  interface DeliveryRow { message_id: string; message_json: string; to_generation: number; claimed_by: string | null; outcome_json: string | null; updated_at: string }
  const toDelivery = (r: DeliveryRow): DeliveryRecord => ({
    messageId: r.message_id, message: JSON.parse(r.message_json) as GlobalAgentMessage, toGeneration: r.to_generation,
    ...(r.claimed_by === null ? {} : { claimedBy: r.claimed_by as RuntimeKind }),
    ...(r.outcome_json === null ? {} : { outcome: JSON.parse(r.outcome_json) as DeliveryOutcome }),
    updatedAt: r.updated_at,
  });
  const DELIVERY_COLUMNS = "message_id, message_json, to_generation, claimed_by, outcome_json, updated_at";

  const deliveries: DeliveryRecordStore = {
    async get(messageId) {
      const row = db.query<DeliveryRow, [string]>(`SELECT ${DELIVERY_COLUMNS} FROM global_messages WHERE message_id = ?`).get(messageId);
      return row ? toDelivery(row) : undefined;
    },
    async put(record) {
      // `global_message_receipts` is an audit of OUTCOME TRANSITIONS, not of writes: a row is
      // appended when an outcome is first set or when the serialized outcome changes, and a `put`
      // that re-states the outcome it already had appends nothing. Read + write is two statements,
      // so the whole thing is one transaction — a receipt without its record, or a record whose
      // receipt never landed, would each be a lie about what was delivered.
      const outcomeJson = record.outcome === undefined ? null : JSON.stringify(record.outcome);
      rs.transaction(() => {
        const prior = db.query<{ outcome_json: string | null }, [string]>("SELECT outcome_json FROM global_messages WHERE message_id = ?").get(record.messageId)?.outcome_json ?? null;
        db.run(`INSERT OR REPLACE INTO global_messages (${DELIVERY_COLUMNS}, receipted_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [record.messageId, JSON.stringify(record.message), record.toGeneration, record.claimedBy ?? null, outcomeJson, record.updatedAt,
            // The receipt stamp IS the record's own `updatedAt` at the moment the outcome exists —
            // never a fresh clock reading, so `prune` and a caller reading `updatedAt` can never
            // disagree about when a delivery was receipted.
            outcomeJson === null ? null : record.updatedAt]);
        if (outcomeJson !== null && outcomeJson !== prior) {
          db.run("INSERT INTO global_message_receipts (message_id, outcome_json, receipted_at) VALUES (?, ?, ?)", [record.messageId, outcomeJson, record.updatedAt]);
        }
      });
    },
    async claimedWithoutReceipt() {
      return db.query<DeliveryRow, []>(`SELECT ${DELIVERY_COLUMNS} FROM global_messages WHERE claimed_by IS NOT NULL AND outcome_json IS NULL ORDER BY rowid`).all().map(toDelivery);
    },
    async prune(receiptedBefore) {
      // `outcome_json IS NOT NULL` is the whole safety property: an unreceipted record — claimed or
      // not — is invisible to this door at every age.
      return db.run("DELETE FROM global_messages WHERE outcome_json IS NOT NULL AND receipted_at < ?", [receiptedBefore]).changes;
    },
  };

  // ── Idle subscriptions ───────────────────────────────────────────────────────────────────────
  interface SubRow { message_id: string; subscriber: string; target: string; target_generation: number; created_at: number; expires_at: number }
  const subscriptions: IdleSubscriptionStore = {
    async list() {
      return db.query<SubRow, []>("SELECT message_id, subscriber, target, target_generation, created_at, expires_at FROM idle_subscriptions ORDER BY rowid").all()
        .map((r): IdleSubscriptionRecord => ({ messageId: r.message_id, subscriber: r.subscriber, target: r.target, targetGeneration: r.target_generation, createdAt: r.created_at, expiresAt: r.expires_at }));
    },
    async add(record) {
      db.run("INSERT OR REPLACE INTO idle_subscriptions (message_id, subscriber, target, target_generation, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
        [record.messageId, record.subscriber, record.target, record.targetGeneration, record.createdAt, record.expiresAt]);
    },
    async remove(messageId) {
      db.run("DELETE FROM idle_subscriptions WHERE message_id = ?", [messageId]);
    },
  };

  // ── Name leases ──────────────────────────────────────────────────────────────────────────────
  interface LeaseRow { name: string; address: string; generation: number; claimed_at: string; released_at: string | null }
  const toLease = (r: LeaseRow): NameLeaseRecord => ({
    name: r.name, address: r.address, generation: r.generation, claimedAt: r.claimed_at,
    ...(r.released_at === null ? {} : { releasedAt: r.released_at }),
  });
  const LEASE_COLUMNS = "name, address, generation, claimed_at, released_at";

  const names: NameLeaseStore = {
    async lookup(name) {
      // EVERY record for the name, held and released alike: WS-10 §11 rule 5 needs the released ones
      // to say "that name referred to something that has gone" instead of "no such agent".
      return db.query<LeaseRow, [string]>(`SELECT ${LEASE_COLUMNS} FROM name_leases WHERE name = ? ORDER BY rowid`).all(name).map(toLease);
    },
    async claim(record) {
      // DELIBERATE DIVERGENCE from the in-memory reference, which APPENDS: `PRIMARY KEY (name,
      // address, claimed_at)` dedupes here. A re-claim at a NEW `claimedAt` still appends a second
      // row, exactly like the reference. Edge it changes: a re-claim at a BYTE-IDENTICAL
      // `claimedAt` overwrites the existing row — including resurrecting one that had already been
      // released, since the incoming record's absent `releasedAt` is written as NULL.
      db.run(`INSERT OR REPLACE INTO name_leases (${LEASE_COLUMNS}) VALUES (?, ?, ?, ?, ?)`,
        [record.name, record.address, record.generation, record.claimedAt, record.releasedAt ?? null]);
    },
    async release(name, address, releasedAt) {
      db.run("UPDATE name_leases SET released_at = ? WHERE name = ? AND address = ? AND released_at IS NULL", [releasedAt, name, address]);
    },
    async held() {
      return db.query<LeaseRow, []>(`SELECT ${LEASE_COLUMNS} FROM name_leases WHERE released_at IS NULL ORDER BY rowid`).all().map(toLease);
    },
    async prune(releasedBefore) {
      return db.run("DELETE FROM name_leases WHERE released_at IS NOT NULL AND released_at < ?", [releasedBefore]).changes;
    },
  };

  return { load, upsert, remove, cursors, mailboxes, deliveries, subscriptions, names };
}
