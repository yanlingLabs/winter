import { createHash, randomUUID } from "node:crypto";
import { mayContactCoworkPeer, type CoworkMessagingRecords } from "./messaging-authority";
import { CoworkError, type GuestEpoch } from "./types";

/*
 * Same-Project peer-message receipt ledger (spec: "Same-Project SendMessage", "Persist acceptance and
 * assign a stable receipt before returning accepted/queued success").
 *
 * SOURCE ONLY. Nothing under src/ imports this module, it has no barrel export, there is no SQLite table and
 * no daemon/session wiring (an anti-wiring test pins all three). The ledger is a state machine over an
 * INJECTED, SYNCHRONOUS `PeerInboxStore`; a durable implementation of that port is a separate decision (see
 * docs/research/2026-10-16-cowork-peer-inbox.md). The only implementation here is the in-memory store, which
 * exists so the state machine can be proven; it is not durable.
 *
 * The ledger owns NO transport. It never imports a session table, a driver or a wake path, so it cannot wake a
 * workspace, resume a conversation or create one. `offer` hands the next owed message and its body to whoever
 * runs delivery; `ack` records that the recipient durably accepted it.
 *
 * Receipt states: accepted (the daemon owes delivery) -> delivered (recipient durably acknowledged the input,
 * not that a model read it) | blocked (retained, visible, retried by the next `offer`) | refused (terminal).
 * delivered and refused are TERMINAL: only they are ever pruned, and only they are dedupe-only records.
 * No exactly-once EXECUTION is promised: an offer that was never acked is offered again (at-least-once until
 * the ack), and a pruned send identity is forgotten.
 */

export type PeerReceiptState = "accepted" | "delivered" | "blocked" | "refused";
/** `authority` is set by the ledger itself; the rest are reported by the delivery owner through `block`. */
export type PeerBlockReason = "authority" | "grants" | "resources" | "recovery";
export type PeerRefusalReason = "not_found" | "recipient_archived" | "inbox_full" | "canceled";
/** The recipient workspace's current guest epoch, as the delivery owner/recipient channel holds it. */
export type PeerEpoch = Pick<GuestEpoch, "incarnationId" | "leaseEpoch">;

/** A send is identified by its authenticated sender, that sender's runtime incarnation and the runtime message
 * id: a restarted sender's `msg-1` is a NEW message (the same rule as agent/session-messaging.ts). Every field
 * is host-derived from the authenticated channel, never from tool arguments. */
export interface PeerSendIdentity { senderSessionId: string; senderIncarnation: string; sendId: string }
export interface PeerSendRequest extends PeerSendIdentity { recipientSessionId: string; text: string }

export interface PeerInboxRecord {
  readonly receiptId: string;
  readonly senderSessionId: string; readonly senderIncarnation: string; readonly sendId: string;
  readonly recipientSessionId: string;
  /** Versioned sha256 over (recipient, text). The conflict check compares this, never the text. */
  readonly digest: string;
  readonly size: number;
  /** Opaque store-issued handle to the body; null once the record is terminal (the body is released). */
  readonly bodyHandle: string | null;
  /** Store-assigned, strictly increasing per recipient and never reused, even after pruning. */
  readonly sequence: number;
  readonly state: PeerReceiptState;
  readonly reason: PeerBlockReason | PeerRefusalReason | null;
  readonly attempts: number;
  /** The epoch the current offer was made under; the only epoch an ack may present. */
  readonly offered: PeerEpoch | null;
  readonly deliveredUnder: PeerEpoch | null;
  readonly acceptedAt: number; readonly updatedAt: number;
  /** Compare-and-set token, bumped by every update. */
  readonly version: number;
}
/** What the ledger chooses at append; the store adds sequence, body handle, version and the initial state. */
export type PeerInboxEntry = Pick<PeerInboxRecord, "receiptId" | "senderSessionId" | "senderIncarnation" | "sendId" | "recipientSessionId" | "digest" | "size" | "acceptedAt">;
export type PeerInboxPatch = Partial<Pick<PeerInboxRecord, "state" | "reason" | "attempts" | "offered" | "deliveredUnder">> & { updatedAt: number };

/** The durable-store port. Every method is ONE atomic step: when it throws, nothing it was doing is visible.
 * Synchronous on purpose (the repository's bun:sqlite style): "persisted before success" is then a property of
 * the call order, not of an await. `docs/research/2026-10-16-cowork-peer-inbox.md` states the full contract
 * and test/cowork/peer-inbox-conformance.ts enforces it. */
export interface PeerInboxStore {
  /** Atomically: if the send identity already has a record return it unchanged (`created: false`, the body is
   * NOT stored again); otherwise store the record and its body together, assigning the next per-recipient
   * sequence, a body handle and version 1. Validates the entry first; a rejected append leaves no trace. */
  append(entry: PeerInboxEntry, body: string): { created: boolean; record: PeerInboxRecord };
  find(identity: PeerSendIdentity): PeerInboxRecord | undefined;
  get(receiptId: string): PeerInboxRecord | undefined;
  /** Non-terminal records (accepted | blocked) of one recipient in sequence order. */
  unresolved(recipientSessionId: string): PeerInboxRecord[];
  /** Terminal records (delivered | refused) of one recipient in sequence order. */
  terminal(recipientSessionId: string): PeerInboxRecord[];
  recipients(): string[];
  /** Compare-and-set: a stale `expectedVersion` throws revision_conflict and changes nothing. Moving to a
   * terminal state releases the body in the same step (`bodyHandle` becomes null); a terminal record is final
   * (invalid_request). */
  update(receiptId: string, expectedVersion: number, patch: PeerInboxPatch): PeerInboxRecord;
  readBody(handle: string): string | undefined;
  /** Removes a TERMINAL record; a non-terminal one throws invalid_request and stays. The recipient's sequence
   * counter is untouched. */
  remove(receiptId: string): void;
}

export const isTerminalPeerState = (state: PeerReceiptState): boolean => state === "delivered" || state === "refused";

/** The sender-visible receipt: no body, no digest, no store handle, no queue position. */
export interface PeerReceipt {
  receiptId: string; sendId: string; senderSessionId: string; recipientSessionId: string;
  state: PeerReceiptState; reason: PeerBlockReason | PeerRefusalReason | null;
  attempts: number; size: number; acceptedAt: number; updatedAt: number;
}
export type PeerAcceptResult =
  | { outcome: "accepted"; receipt: PeerReceipt }
  /** The send identity already had a receipt (any state): returned as-is, nothing written. */
  | { outcome: "retained"; receipt: PeerReceipt }
  /** Not persisted and no receipt: a refused attempt creates no durable state and wakes nothing. */
  | { outcome: "refused"; reason: "not_found" | "recipient_archived" | "inbox_full" };
export interface PeerOffer { receipt: PeerReceipt; body: string; epoch: PeerEpoch }
export interface PeerAck { receiptId: string; recipientSessionId: string; epoch: PeerEpoch }

// DECISION: bounds. Terminal (dedupe-only) records keep the last 100 per recipient (the outbox correction's
// delivered-receipt figure) for at most a day; unresolved records are never pruned, so their growth is capped by
// refusing new sends at 256 unresolved per recipient instead. Pruning a terminal record forfeits dedupe for that
// send identity, which the spec allows ("bounded retention for terminal deduplication records").
export const PEER_INBOX_LIMITS = Object.freeze({ maxMessageBytes: 64 * 1024, maxUnresolvedPerRecipient: 256, terminalKeepPerRecipient: 100, terminalTtlMs: 24 * 3_600_000 });
export type PeerInboxLimits = { -readonly [K in keyof typeof PEER_INBOX_LIMITS]: number };

export interface CoworkPeerInboxOptions {
  /** Host records for `mayContactCoworkPeer`. Absent: every authority check is false (fail closed). */
  records: CoworkMessagingRecords | undefined;
  store: PeerInboxStore;
  now?: () => number;
  newReceiptId?: () => string;
  limits?: Partial<PeerInboxLimits>;
}

const DIGEST_VERSION = "winter.cowork.peer-send.v1";
export function peerSendDigest(recipientSessionId: string, text: string): string {
  return createHash("sha256").update(JSON.stringify([DIGEST_VERSION, recipientSessionId, text])).digest("hex");
}
const CONTROL = /[\u0000-\u001f\u007f]/;
function checkId(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256 || CONTROL.test(value)) throw new CoworkError("invalid_request");
}
function checkEpoch(epoch: PeerEpoch): void {
  checkId(epoch?.incarnationId);
  if (!Number.isSafeInteger(epoch.leaseEpoch) || epoch.leaseEpoch < 0) throw new CoworkError("invalid_request");
}
const sameEpoch = (a: PeerEpoch | null, b: PeerEpoch): boolean => a !== null && a.incarnationId === b.incarnationId && a.leaseEpoch === b.leaseEpoch;
/** Store failures surface as `recovery_required` with no store-supplied text (it can carry host paths). */
function durable<T>(operation: () => T): T {
  try { return operation(); } catch (error) { throw error instanceof CoworkError ? error : new CoworkError("recovery_required"); }
}
function view(record: PeerInboxRecord): PeerReceipt {
  return { receiptId: record.receiptId, sendId: record.sendId, senderSessionId: record.senderSessionId, recipientSessionId: record.recipientSessionId, state: record.state, reason: record.reason, attempts: record.attempts, size: record.size, acceptedAt: record.acceptedAt, updatedAt: record.updatedAt };
}

export class CoworkPeerInbox {
  private readonly records: CoworkMessagingRecords | undefined;
  private readonly store: PeerInboxStore;
  private readonly now: () => number;
  private readonly newReceiptId: () => string;
  private readonly limits: PeerInboxLimits;
  /** The ledger keeps NO delivery state of its own: a restart is a new instance over the same store. */
  constructor(options: CoworkPeerInboxOptions) {
    this.records = options.records; this.store = options.store;
    this.now = options.now ?? Date.now;
    this.newReceiptId = options.newReceiptId ?? (() => `pr_${randomUUID()}`);
    this.limits = { ...PEER_INBOX_LIMITS, ...options.limits };
  }

  /** Persist, then answer. Throws `invalid_request` (malformed), `request_conflict` (same identity, different
   * content) or `recovery_required` (the store failed: nothing was accepted). */
  accept(request: PeerSendRequest): PeerAcceptResult {
    checkId(request?.senderSessionId); checkId(request.senderIncarnation); checkId(request.sendId); checkId(request.recipientSessionId);
    if (typeof request.text !== "string" || request.text.length === 0) throw new CoworkError("invalid_request");
    const size = Buffer.byteLength(request.text, "utf8");
    if (size > this.limits.maxMessageBytes) throw new CoworkError("invalid_request");
    const digest = peerSendDigest(request.recipientSessionId, request.text);
    const identity = { senderSessionId: request.senderSessionId, senderIncarnation: request.senderIncarnation, sendId: request.sendId };

    const prior = durable(() => this.store.find(identity));
    if (prior) return this.retained(prior, digest);
    // The authority check precedes every write: an unauthorized caller creates no state and learns only the
    // uniform not_found, except that a CURRENT same-Project member is told the peer is archived (so the sender
    // can ask for an explicit restore). Archived/unknown recipients are never woken or recreated here.
    if (!mayContactCoworkPeer(this.records, request.senderSessionId, request.recipientSessionId, "send")) return { outcome: "refused", reason: this.refusalFor(request.senderSessionId, request.recipientSessionId) };
    if (durable(() => this.store.unresolved(request.recipientSessionId)).length >= this.limits.maxUnresolvedPerRecipient) return { outcome: "refused", reason: "inbox_full" };

    const entry: PeerInboxEntry = { ...identity, receiptId: this.newReceiptId(), recipientSessionId: request.recipientSessionId, digest, size, acceptedAt: this.now() };
    // DECISION: the spec is silent on persisting message text, but "accepted means the daemon owes delivery"
    // cannot survive a restart without it. The body therefore goes through the port, in the SAME atomic append,
    // as an opaque store-issued handle that is released when the record turns terminal. The record itself holds
    // only digest + size, and terminal dedupe records hold no body at all.
    const appended = durable(() => this.store.append(entry, request.text));
    if (!appended.created) return this.retained(appended.record, digest); // lost a same-identity race
    this.pruneQuietly(request.recipientSessionId);
    return { outcome: "accepted", receipt: view(appended.record) };
  }

  /** The receipt for a send identity, or undefined once it was never accepted or its dedupe record was pruned. */
  lookup(identity: PeerSendIdentity): PeerReceipt | undefined {
    const record = durable(() => this.store.find(identity));
    return record ? view(record) : undefined;
  }

  /** Unresolved receipts (accepted | blocked) for a recipient, oldest first. */
  pending(recipientSessionId: string): PeerReceipt[] {
    return durable(() => this.store.unresolved(recipientSessionId)).map(view);
  }

  /** Occupancy view: only `runnable` work needs a live guest; `blocked` records are host-only inbox state. */
  owed(recipientSessionId: string): { runnable: number; blocked: number } {
    const records = durable(() => this.store.unresolved(recipientSessionId));
    const blocked = records.filter(record => record.state === "blocked").length;
    return { runnable: records.length - blocked, blocked };
  }

  /** The next message to deliver to a recipient whose workspace is at `epoch`, strictly in acceptance order,
   * or undefined. Re-checks authority per candidate: a candidate whose sender lost authority (or whose
   * recipient is archived) is parked as `blocked: authority` and skipped, because that denial applies to every
   * message of that sender->recipient pair, so per-pair order is preserved and one revoked sender cannot stall
   * the others. A gone recipient refuses its candidate. An unacked offer is offered again. */
  offer(recipientSessionId: string, epoch: PeerEpoch): PeerOffer | undefined {
    checkId(recipientSessionId); checkEpoch(epoch);
    for (const candidate of durable(() => this.store.unresolved(recipientSessionId))) {
      if (!this.permitted(candidate)) { this.deny(candidate); continue; }
      if (!this.epochCurrent(recipientSessionId, epoch)) throw new CoworkError("stale_acknowledgment");
      const body = durable(() => candidate.bodyHandle === null ? undefined : this.store.readBody(candidate.bodyHandle));
      if (body === undefined || peerSendDigest(candidate.recipientSessionId, body) !== candidate.digest) {
        // Fail closed and stop: nothing later is delivered past a damaged record.
        this.move(candidate, { state: "blocked", reason: "recovery", offered: null });
        return undefined;
      }
      const offered = this.move(candidate, { state: "accepted", reason: null, attempts: candidate.attempts + 1, offered: { incarnationId: epoch.incarnationId, leaseEpoch: epoch.leaseEpoch } });
      return { receipt: view(offered), body, epoch: { incarnationId: epoch.incarnationId, leaseEpoch: epoch.leaseEpoch } };
    }
    return undefined;
  }

  /** The recipient durably acknowledged the input (not that a model read it). Refused unless the ack carries
   * the epoch this record was OFFERED under AND that epoch is still the workspace's current one; authority is
   * re-checked here too (a revoked pair is parked blocked and the ack answers authority_denied, so the
   * recipient runtime discards the input it was holding). Idempotent for the same epoch once delivered. */
  ack(request: PeerAck): PeerReceipt {
    checkId(request?.receiptId); checkId(request.recipientSessionId); checkEpoch(request.epoch);
    const record = durable(() => this.store.get(request.receiptId));
    if (!record || record.recipientSessionId !== request.recipientSessionId) throw new CoworkError("not_found");
    if (record.state === "delivered") {
      if (sameEpoch(record.deliveredUnder, request.epoch)) return view(record);
      throw new CoworkError("stale_acknowledgment");
    }
    if (record.state !== "accepted" || record.offered === null) throw new CoworkError("stale_acknowledgment");
    if (!sameEpoch(record.offered, request.epoch) || !this.epochCurrent(record.recipientSessionId, request.epoch)) throw new CoworkError("stale_acknowledgment");
    if (!this.permitted(record)) { this.deny(record); throw new CoworkError("authority_denied"); }
    return view(this.move(record, { state: "delivered", reason: null, offered: null, deliveredUnder: record.offered }));
  }

  /** The delivery owner cannot deliver now (grants, resources, recovery). Retained and visible until an
   * `offer` retries it; a terminal record is returned unchanged. */
  block(receiptId: string, reason: Exclude<PeerBlockReason, "authority">): PeerReceipt {
    checkId(receiptId);
    if (reason !== "grants" && reason !== "resources" && reason !== "recovery") throw new CoworkError("invalid_request");
    const record = durable(() => this.store.get(receiptId));
    if (!record) throw new CoworkError("not_found");
    if (isTerminalPeerState(record.state)) return view(record);
    return view(this.move(record, { state: "blocked", reason, offered: null }));
  }

  /** Explicit cancel by the sender's own identity: the only way an unresolved record ends besides delivery. */
  cancel(identity: PeerSendIdentity): PeerReceipt {
    checkId(identity?.senderSessionId); checkId(identity.senderIncarnation); checkId(identity.sendId);
    const record = durable(() => this.store.find(identity));
    if (!record) throw new CoworkError("not_found");
    if (isTerminalPeerState(record.state)) return view(record);
    return view(this.move(record, { state: "refused", reason: "canceled", offered: null }));
  }

  /** Drops TERMINAL records older than the TTL, then the oldest beyond the per-recipient keep. Never touches an
   * accepted or blocked record (the store also refuses to remove one). Returns how many were removed. */
  prune(recipientSessionId?: string): number {
    const at = this.now(), ttl = this.limits.terminalTtlMs, keep = this.limits.terminalKeepPerRecipient;
    let removed = 0;
    for (const recipient of recipientSessionId === undefined ? durable(() => this.store.recipients()) : [recipientSessionId]) {
      const terminal = durable(() => this.store.terminal(recipient));
      const live = terminal.filter(record => at - record.updatedAt <= ttl);
      const doomed = [...terminal.filter(record => at - record.updatedAt > ttl), ...live.slice(0, Math.max(0, live.length - keep))];
      for (const record of doomed) { durable(() => this.store.remove(record.receiptId)); removed++; }
    }
    return removed;
  }

  private retained(record: PeerInboxRecord, digest: string): PeerAcceptResult {
    if (record.digest !== digest) throw new CoworkError("request_conflict");
    return { outcome: "retained", receipt: view(record) };
  }
  private move(record: PeerInboxRecord, patch: Omit<PeerInboxPatch, "updatedAt">): PeerInboxRecord {
    return durable(() => this.store.update(record.receiptId, record.version, { ...patch, updatedAt: this.now() }));
  }
  private permitted(record: PeerInboxRecord): boolean {
    return mayContactCoworkPeer(this.records, record.senderSessionId, record.recipientSessionId, "send");
  }
  /** Authority lost for a retained record: a deleted/unknown recipient ends it (nothing will ever be delivered
   * and the conversation is never recreated); anything else (archived, revoked, Project archived) parks it. */
  private deny(record: PeerInboxRecord): void {
    if (this.recipientGone(record.recipientSessionId)) { this.move(record, { state: "refused", reason: "not_found", offered: null }); return; }
    if (record.state === "blocked" && record.reason === "authority") return;
    this.move(record, { state: "blocked", reason: "authority", offered: null });
  }
  private recipientGone(recipientSessionId: string): boolean {
    if (!this.records) return false;
    try { return this.records.binding(recipientSessionId).state === "deleted"; } catch (error) { return error instanceof CoworkError && error.code === "not_found"; }
  }
  /** The accept-time refusal. `recipient_archived` is disclosed only to a current active same-Project member. */
  private refusalFor(senderSessionId: string, recipientSessionId: string): "not_found" | "recipient_archived" {
    try {
      const sender = this.records!.binding(senderSessionId), recipient = this.records!.binding(recipientSessionId);
      if (recipient.state === "archived" && sender.state === "active" && sender.projectId !== null && sender.projectId === recipient.projectId && sender.workspaceId === recipient.workspaceId) return "recipient_archived";
    } catch { /* unknown or unreadable: the uniform answer */ }
    return "not_found";
  }
  /** Same predicate as CoworkRepository.refreshEpoch, over the read-only records. */
  private epochCurrent(recipientSessionId: string, epoch: PeerEpoch): boolean {
    if (!this.records) return false;
    try {
      const workspace = this.records.get(this.records.binding(recipientSessionId).workspaceId);
      return workspace.state === "retained" && (workspace.power === "starting" || workspace.power === "running")
        && workspace.incarnationId === epoch.incarnationId && workspace.leaseEpoch === epoch.leaseEpoch;
    } catch { return false; }
  }
  /** Housekeeping must never turn a durable accept into a failure; the next accept or prune retries it. */
  private pruneQuietly(recipientSessionId: string): void {
    try { this.prune(recipientSessionId); } catch { /* retried later */ }
  }
}

/* ---- In-memory store: proves the state machine and the port contract. NOT durable. ---- */

export interface PeerInboxMemoryState {
  records: Map<string, PeerInboxRecord>;
  identities: Map<string, string>;
  bodies: Map<string, string>;
  sequences: Map<string, number>;
  bodyCounter: number;
}
const identityKey = (identity: PeerSendIdentity): string => JSON.stringify([identity.senderSessionId, identity.senderIncarnation, identity.sendId]);

export class InMemoryPeerInboxStore implements PeerInboxStore {
  constructor(private readonly state: PeerInboxMemoryState = { records: new Map(), identities: new Map(), bodies: new Map(), sequences: new Map(), bodyCounter: 0 }) {}
  /** A new instance over the same state: what a process restart over a durable store looks like. */
  reopen(): InMemoryPeerInboxStore { return new InMemoryPeerInboxStore(this.state); }

  append(entry: PeerInboxEntry, body: string): { created: boolean; record: PeerInboxRecord } {
    for (const value of [entry.receiptId, entry.senderSessionId, entry.senderIncarnation, entry.sendId, entry.recipientSessionId, entry.digest]) checkId(value);
    if (typeof body !== "string" || !Number.isSafeInteger(entry.size) || entry.size < 0 || !Number.isFinite(entry.acceptedAt)) throw new CoworkError("invalid_request");
    const existing = this.state.identities.get(identityKey(entry));
    if (existing !== undefined) return { created: false, record: { ...this.state.records.get(existing)! } };
    if (this.state.records.has(entry.receiptId)) throw new CoworkError("request_conflict");
    const sequence = (this.state.sequences.get(entry.recipientSessionId) ?? 0) + 1, handle = `body_${this.state.bodyCounter + 1}`;
    const record: PeerInboxRecord = { ...entry, bodyHandle: handle, sequence, state: "accepted", reason: null, attempts: 0, offered: null, deliveredUnder: null, updatedAt: entry.acceptedAt, version: 1 };
    this.state.bodyCounter++; this.state.sequences.set(entry.recipientSessionId, sequence);
    this.state.bodies.set(handle, body); this.state.records.set(record.receiptId, record); this.state.identities.set(identityKey(entry), record.receiptId);
    return { created: true, record: { ...record } };
  }
  find(identity: PeerSendIdentity): PeerInboxRecord | undefined {
    const id = this.state.identities.get(identityKey(identity));
    return id === undefined ? undefined : { ...this.state.records.get(id)! };
  }
  get(receiptId: string): PeerInboxRecord | undefined {
    const record = this.state.records.get(receiptId);
    return record && { ...record };
  }
  unresolved(recipientSessionId: string): PeerInboxRecord[] { return this.ordered(recipientSessionId, false); }
  terminal(recipientSessionId: string): PeerInboxRecord[] { return this.ordered(recipientSessionId, true); }
  recipients(): string[] { return [...new Set([...this.state.records.values()].map(record => record.recipientSessionId))]; }
  update(receiptId: string, expectedVersion: number, patch: PeerInboxPatch): PeerInboxRecord {
    const current = this.state.records.get(receiptId);
    if (!current) throw new CoworkError("not_found");
    if (current.version !== expectedVersion) throw new CoworkError("revision_conflict", current.version);
    if (isTerminalPeerState(current.state)) throw new CoworkError("invalid_request");
    const next: PeerInboxRecord = { ...current, ...patch, version: current.version + 1 };
    if (isTerminalPeerState(next.state)) {
      if (current.bodyHandle !== null) this.state.bodies.delete(current.bodyHandle);
      this.state.records.set(receiptId, { ...next, bodyHandle: null });
    } else this.state.records.set(receiptId, next);
    return { ...this.state.records.get(receiptId)! };
  }
  readBody(handle: string): string | undefined { return this.state.bodies.get(handle); }
  remove(receiptId: string): void {
    const current = this.state.records.get(receiptId);
    if (!current) throw new CoworkError("not_found");
    if (!isTerminalPeerState(current.state)) throw new CoworkError("invalid_request");
    this.state.records.delete(receiptId); this.state.identities.delete(identityKey(current));
    if (current.bodyHandle !== null) this.state.bodies.delete(current.bodyHandle);
  }
  private ordered(recipientSessionId: string, terminal: boolean): PeerInboxRecord[] {
    return [...this.state.records.values()].filter(record => record.recipientSessionId === recipientSessionId && isTerminalPeerState(record.state) === terminal)
      .sort((a, b) => a.sequence - b.sequence).map(record => ({ ...record }));
  }
}
