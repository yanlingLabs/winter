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
 * the ack), a pruned send identity is forgotten, and a restarted sender (a new runtime incarnation) that
 * replays a message is a NEW send.
 *
 * Two different "incarnations" appear here and must not be confused: `senderIncarnation` names the SENDER's
 * runtime child (part of the send identity, as in agent/session-messaging.ts); `PeerEpoch` is the RECIPIENT
 * workspace's guest incarnation and lease epoch (the fence on offer, ack and block).
 *
 * Callers of every method are host code that has already authenticated its own caller: `lookup` and `cancel`
 * are the sender's doors, `pending`, `owed`, `settle`, `offer`, `ack` and `block` the delivery owner's, and
 * `discard` a user's. The ledger authorizes SENDING (mayContactCoworkPeer), not who may call it.
 */

export type PeerReceiptState = "accepted" | "delivered" | "blocked" | "refused";
/** `authority` is set by the ledger itself; the rest are reported by the delivery owner through `block`. */
export type PeerBlockReason = "authority" | "grants" | "resources" | "recovery";
/** Caps enforced inside the store's atomic append. */
export type PeerCapReason = "inbox_full" | "sender_quota" | "inbox_bytes_full";
/** Why an attempt was turned away at accept (nothing is persisted). */
export type PeerAcceptRefusal = "not_found" | "recipient_archived" | PeerCapReason;
/** Why a retained record ended as `refused`. */
export type PeerEndReason = "not_found" | "sender_gone" | "canceled" | "discarded" | "unrecoverable";
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
  /** Store-assigned, strictly increasing per recipient and never reused, even after pruning and a restart. */
  readonly sequence: number;
  readonly state: PeerReceiptState;
  readonly reason: PeerBlockReason | PeerEndReason | null;
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
/** Exhaustion bounds, decided by the store INSIDE its atomic append. */
export interface PeerInboxCaps { maxUnresolvedPerRecipient: number; maxUnresolvedPerSenderRecipient: number; maxUnresolvedBytesPerRecipient: number }
export type PeerAppendResult =
  | { status: "created" | "existing"; record: PeerInboxRecord }
  | { status: "full"; reason: PeerCapReason };
/** Contract violations a store can detect about itself; every list is empty on a healthy store. */
export interface PeerInboxAudit {
  /** Unresolved records whose body handle is missing or does not resolve (a torn record). */
  unresolvedWithoutBody: string[];
  /** Terminal records that still hold a body handle (a leaked body). */
  terminalWithBody: string[];
  /** Bodies no record references (an orphan body, e.g. left by a failed append). */
  orphanBodies: number;
}

/** The durable-store port. Every method is ONE atomic step: when it throws, nothing it was doing is visible.
 *
 * DURABILITY CLASS. "Returns means committed": when a mutating method returns, its effect survives a process
 * kill AND an OS crash or power loss, which is the class CoworkRepository gets from `durableCoworkTransaction`
 * (SQLite `synchronous=FULL` with `fullfsync` and `checkpoint_fullfsync` ON on Darwin) or stronger. A method
 * that throws has no visible effect, and a crash mid-method leaves either all of it or none of it (no torn
 * record, no orphan body). A weaker store (the in-memory one, or a cache) may prove the state machine but
 * must never back a production ledger.
 *
 * Synchronous on purpose (the repository's SQLite style): "persisted before success" is then a property of
 * the call order, not of an await. docs/research/2026-10-16-cowork-peer-inbox.md states the full contract and
 * test/cowork/peer-inbox-conformance.ts enforces it. */
export interface PeerInboxStore {
  /** Atomically, as ONE step: if the send identity already has a record return it unchanged (`existing`, the
   * body is NOT stored again and no cap applies); otherwise check the caps against the unresolved records and,
   * if they hold, store the record and its body together, assigning the next per-recipient sequence, a body
   * handle and version 1. The cap check and the append are the same operation, so concurrent appends cannot
   * overshoot a cap. Caps are checked in this order: sender_quota (unresolved from this sender to this
   * recipient), inbox_full (unresolved to this recipient), inbox_bytes_full (their summed `size` plus this
   * one's). `full` leaves no trace. Validates the entry first (`size` must equal the body's UTF-8 length); a
   * rejected append leaves no record, body or sequence gap. The body round-trips byte-exactly: multibyte text,
   * NUL and 64 KiB included. */
  append(entry: PeerInboxEntry, body: string, caps: PeerInboxCaps): PeerAppendResult;
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
   * counter is untouched, including across a restart. */
  remove(receiptId: string): void;
  audit(): PeerInboxAudit;
}

export const isTerminalPeerState = (state: PeerReceiptState): boolean => state === "delivered" || state === "refused";

/** The sender-visible receipt: no body, no digest, no store handle, no queue position. */
export interface PeerReceipt {
  receiptId: string; sendId: string; senderSessionId: string; recipientSessionId: string;
  state: PeerReceiptState; reason: PeerBlockReason | PeerEndReason | null;
  attempts: number; size: number; acceptedAt: number; updatedAt: number;
}
export type PeerAcceptResult =
  | { outcome: "accepted"; receipt: PeerReceipt }
  /** The send identity already had a receipt (any state): returned as-is, nothing written. */
  | { outcome: "retained"; receipt: PeerReceipt }
  /** Not persisted and no receipt: a refused attempt creates no durable state and wakes nothing. */
  | { outcome: "refused"; reason: PeerAcceptRefusal };
export interface PeerOffer { receipt: PeerReceipt; body: string; epoch: PeerEpoch }
export interface PeerAck { receiptId: string; recipientSessionId: string; epoch: PeerEpoch }
/** The door out for a record that would otherwise sit forever. `user` must be an authenticated local user
 * client (the wired surface supplies the principal; peers and runtime principals must never reach it); `host`
 * drops only a head whose body is provably damaged. */
export type PeerDiscardAuthority = { kind: "user"; principalId: string } | { kind: "host"; reason: "unrecoverable_body" };

// DECISION: bounds. Terminal (dedupe-only) records keep the last 100 per recipient (the outbox correction's
// delivered-receipt figure) for at most a day. Unresolved records are never pruned; their growth is bounded by
// three caps the store enforces atomically: 32 per (sender, recipient), 256 per recipient and 4 MiB of body
// bytes per recipient. They bound exhaustion by one sender and by one recipient's total; many Project members
// can still fill one recipient's inbox together, which the user clears with `discard`. Pruning a terminal record
// forfeits dedupe for that send identity, which the spec allows ("bounded retention for terminal deduplication
// records").
export const PEER_INBOX_LIMITS = Object.freeze({
  maxMessageBytes: 64 * 1024, maxUnresolvedPerRecipient: 256, maxUnresolvedPerSenderRecipient: 32, maxUnresolvedBytesPerRecipient: 4 * 1024 * 1024,
  terminalKeepPerRecipient: 100, terminalTtlMs: 24 * 3_600_000,
});
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
/** The digest covers (recipient, text) only. When the SDK's optional `summary` and `notifyWhenIdle` fields are
 * wired through (agent/session-messaging.ts carries both), they are part of the message and MUST be added to
 * the payload and to this digest under a new version, or a retry that changes them would be silently deduped. */
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
    // Well-formedness first: a lone surrogate cannot survive a UTF-8 store, so it would poison the queue head at
    // delivery time. Blank text is refused the way agent/session-messaging.ts refuses it.
    if (typeof request.text !== "string" || !request.text.isWellFormed() || request.text.trim() === "") throw new CoworkError("invalid_request");
    const size = Buffer.byteLength(request.text, "utf8");
    if (size > this.limits.maxMessageBytes) throw new CoworkError("invalid_request");
    const digest = peerSendDigest(request.recipientSessionId, request.text);
    const identity = { senderSessionId: request.senderSessionId, senderIncarnation: request.senderIncarnation, sendId: request.sendId };

    const prior = durable(() => this.store.find(identity));
    if (prior) return this.retained(prior, digest);
    // The authority check precedes every write AND every cap: an unauthorized caller creates no state and
    // learns only the uniform not_found (never `inbox_full`), except that a CURRENT same-Project member is told
    // the peer is archived (so the sender can ask for an explicit restore). Archived/unknown recipients are
    // never woken or recreated here.
    if (!mayContactCoworkPeer(this.records, request.senderSessionId, request.recipientSessionId, "send")) return { outcome: "refused", reason: this.refusalFor(request.senderSessionId, request.recipientSessionId) };

    const entry: PeerInboxEntry = { ...identity, receiptId: this.newReceiptId(), recipientSessionId: request.recipientSessionId, digest, size, acceptedAt: this.now() };
    // DECISION: owed delivery must survive a stopped recipient and a daemon restart (docs/cowork-spec.md,
    // verification list: "peer delivery survives a stopped recipient and daemon restart"), and the sender does
    // not retransmit, so the text has to be durable while it is owed. The spec leaves open WHERE it lives, whether
    // it is encrypted at rest, how it is excluded from backups and how a stray body is cleaned up; the port keeps
    // all four with the store. The body goes through the port in the SAME atomic append as an opaque handle, is
    // released when the record turns terminal, and `audit()` finds a leaked or orphaned one. The record itself
    // holds only digest + size, and terminal dedupe records hold no body at all. The caps ride into that same
    // append so the check and the write are one operation.
    const appended = durable(() => this.store.append(entry, request.text, this.caps()));
    if (appended.status === "full") return { outcome: "refused", reason: appended.reason };
    if (appended.status === "existing") return this.retained(appended.record, digest); // lost a same-identity race
    this.pruneQuietly(request.recipientSessionId);
    return { outcome: "accepted", receipt: view(appended.record) };
  }

  /** The receipt for a send identity, or undefined once it was never accepted or its dedupe record was pruned.
   * The wired surface must authenticate the caller as that sender first. */
  lookup(identity: PeerSendIdentity): PeerReceipt | undefined {
    const record = durable(() => this.store.find(identity));
    return record ? view(record) : undefined;
  }

  /** Unresolved receipts (accepted | blocked) for a recipient, oldest first. The wired surface must restrict
   * this to the delivery owner and the recipient's user client. */
  pending(recipientSessionId: string): PeerReceipt[] {
    return durable(() => this.store.unresolved(recipientSessionId)).map(view);
  }

  /** Occupancy view: only `runnable` work needs a live guest. A record is runnable only while its sender may
   * still contact the recipient right now AND it is `accepted` (or parked for authority alone); an archived
   * recipient or sender, or a delivery-owner block, is `blocked` (host-only inbox state). Read-only: `settle`
   * and `offer` are what move the records. */
  owed(recipientSessionId: string): { runnable: number; blocked: number } {
    const verdicts = new Map<string, boolean>();
    const records = durable(() => this.store.unresolved(recipientSessionId));
    // A record parked only for authority is runnable again the moment its pair may send; one the delivery owner
    // blocked (grants, resources, recovery) is not, until that owner retries it.
    const runnable = records.filter(record => (record.state === "accepted" || (record.state === "blocked" && record.reason === "authority")) && this.verdict(record, verdicts)).length;
    return { runnable, blocked: records.length - runnable };
  }

  /** Epoch-free authority sweep: re-checks every unresolved record of a recipient against the host records and
   * parks (`blocked: authority`) or ends (`refused: not_found` for a gone recipient, `sender_gone` for a
   * deleted sender) the ones that may no longer be delivered. It needs no guest epoch, so it can run while the
   * workspace is stopped. `offer` runs it first. One authority verdict per (sender, recipient) pair per sweep,
   * so a transient failure cannot reorder one pair's messages. */
  settle(recipientSessionId: string): void {
    this.sweep(recipientSessionId);
  }

  /** The next message to deliver to a recipient whose workspace is at `epoch`, strictly in acceptance order,
   * or undefined. Settles first (see `settle`): a record whose sender lost authority (or whose recipient is
   * archived) is parked and skipped, because that denial applies to every message of that sender->recipient
   * pair, so per-pair order is preserved and one revoked sender cannot stall the others. Any other head holds
   * the queue: one the delivery owner blocked (grants, resources, recovery) or whose body is damaged is retried
   * first and nothing is offered past it. An unacked offer is offered again. */
  offer(recipientSessionId: string, epoch: PeerEpoch): PeerOffer | undefined {
    checkId(recipientSessionId); checkEpoch(epoch);
    const head = this.sweep(recipientSessionId)[0];
    if (!head) return undefined;
    if (!this.epochCurrent(recipientSessionId, epoch)) throw new CoworkError("stale_acknowledgment");
    const body = durable(() => head.bodyHandle === null ? undefined : this.store.readBody(head.bodyHandle));
    if (body === undefined || peerSendDigest(head.recipientSessionId, body) !== head.digest) {
      // Fail closed and stop: nothing later is delivered past a damaged record. An already-parked head is not
      // rewritten (no version or timestamp churn); `discard` with the host authority is its way out.
      if (!(head.state === "blocked" && head.reason === "recovery")) this.move(head, { state: "blocked", reason: "recovery", offered: null });
      return undefined;
    }
    const offered = this.move(head, { state: "accepted", reason: null, attempts: head.attempts + 1, offered: { incarnationId: epoch.incarnationId, leaseEpoch: epoch.leaseEpoch } });
    return { receipt: view(offered), body, epoch: { incarnationId: epoch.incarnationId, leaseEpoch: epoch.leaseEpoch } };
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

  /** The delivery owner cannot deliver now (grants, resources, recovery). Only the owner of the CURRENT offer
   * can say so: the record must be `accepted` and offered under `epoch`, and `epoch` must still be current,
   * otherwise `stale_acknowledgment` (a stale owner cannot un-offer what the current epoch holds). Retained and
   * visible until an `offer` retries it. A terminal or already-blocked record is returned unchanged. */
  block(receiptId: string, epoch: PeerEpoch, reason: Exclude<PeerBlockReason, "authority">): PeerReceipt {
    checkId(receiptId); checkEpoch(epoch);
    if (reason !== "grants" && reason !== "resources" && reason !== "recovery") throw new CoworkError("invalid_request");
    const record = durable(() => this.store.get(receiptId));
    if (!record) throw new CoworkError("not_found");
    if (isTerminalPeerState(record.state) || record.state === "blocked") return view(record);
    if (!sameEpoch(record.offered, epoch) || !this.epochCurrent(record.recipientSessionId, epoch)) throw new CoworkError("stale_acknowledgment");
    return view(this.move(record, { state: "blocked", reason, offered: null }));
  }

  /** Explicit cancel by the sender's own identity (the wired surface authenticates the sender). */
  cancel(identity: PeerSendIdentity): PeerReceipt {
    checkId(identity?.senderSessionId); checkId(identity.senderIncarnation); checkId(identity.sendId);
    const record = durable(() => this.store.find(identity));
    if (!record) throw new CoworkError("not_found");
    if (isTerminalPeerState(record.state)) return view(record);
    return view(this.move(record, { state: "refused", reason: "canceled", offered: null }));
  }

  /** Ends an unresolved record that nobody else can: a message from a sender that stays archived indefinitely
   * (`user`, an authenticated local user client), or a head whose body is provably damaged (`host`: the body
   * must be missing or fail its digest, otherwise invalid_request). The body is released. A terminal record is
   * returned unchanged. */
  discard(receiptId: string, by: PeerDiscardAuthority): PeerReceipt {
    checkId(receiptId);
    if (by?.kind === "user") checkId(by.principalId);
    else if (by?.kind !== "host" || by.reason !== "unrecoverable_body") throw new CoworkError("invalid_request");
    const record = durable(() => this.store.get(receiptId));
    if (!record) throw new CoworkError("not_found");
    if (isTerminalPeerState(record.state)) return view(record);
    if (by.kind === "user") return view(this.move(record, { state: "refused", reason: "discarded", offered: null }));
    const body = durable(() => record.bodyHandle === null ? undefined : this.store.readBody(record.bodyHandle));
    if (body !== undefined && peerSendDigest(record.recipientSessionId, body) === record.digest) throw new CoworkError("invalid_request");
    return view(this.move(record, { state: "refused", reason: "unrecoverable", offered: null }));
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

  private caps(): PeerInboxCaps {
    return { maxUnresolvedPerRecipient: this.limits.maxUnresolvedPerRecipient, maxUnresolvedPerSenderRecipient: this.limits.maxUnresolvedPerSenderRecipient, maxUnresolvedBytesPerRecipient: this.limits.maxUnresolvedBytesPerRecipient };
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
  /** One authority answer per (sender, recipient) pair per pass. */
  private verdict(record: PeerInboxRecord, verdicts: Map<string, boolean>): boolean {
    const key = JSON.stringify([record.senderSessionId, record.recipientSessionId]);
    let allowed = verdicts.get(key);
    if (allowed === undefined) { allowed = this.permitted(record); verdicts.set(key, allowed); }
    return allowed;
  }
  /** Re-checks authority for a recipient's unresolved records, parks/ends the denied ones and returns the rest in order. */
  private sweep(recipientSessionId: string): PeerInboxRecord[] {
    const verdicts = new Map<string, boolean>(), eligible: PeerInboxRecord[] = [];
    for (const record of durable(() => this.store.unresolved(recipientSessionId))) {
      if (this.verdict(record, verdicts)) eligible.push(record); else this.deny(record);
    }
    return eligible;
  }
  /** Authority lost for a retained record. A deleted/unknown recipient or sender ends it (nothing will ever be
   * delivered, a deleted sender can never cancel, and the conversation is never recreated); anything else
   * (archived, revoked, Project archived) parks it. Archived is not deleted. */
  private deny(record: PeerInboxRecord): void {
    if (this.gone(record.recipientSessionId)) { this.move(record, { state: "refused", reason: "not_found", offered: null }); return; }
    if (this.gone(record.senderSessionId)) { this.move(record, { state: "refused", reason: "sender_gone", offered: null }); return; }
    if (record.state === "blocked" && record.reason === "authority") return;
    this.move(record, { state: "blocked", reason: "authority", offered: null });
  }
  /** A binding that is deleted, or absent. Any other failure (a transient read error) is NOT "gone". */
  private gone(sessionId: string): boolean {
    if (!this.records) return false;
    try { return this.records.binding(sessionId).state === "deleted"; } catch (error) { return error instanceof CoworkError && error.code === "not_found"; }
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
export const createPeerInboxMemoryState = (): PeerInboxMemoryState => ({ records: new Map(), identities: new Map(), bodies: new Map(), sequences: new Map(), bodyCounter: 0 });
const identityKey = (identity: PeerSendIdentity): string => JSON.stringify([identity.senderSessionId, identity.senderIncarnation, identity.sendId]);

export class InMemoryPeerInboxStore implements PeerInboxStore {
  constructor(private readonly state: PeerInboxMemoryState = createPeerInboxMemoryState()) {}
  /** A new instance over the same state: what a process restart over a durable store looks like. Several live
   * instances over one state model several connections to one database. */
  reopen(): this { return new (this.constructor as new (state: PeerInboxMemoryState) => this)(this.state); }
  /** A seam before each individual write of an append, so a test can fail the append part-way and prove the
   * rollback. A real store gets the same property from its transaction. */
  protected beforeWrite(): void {}

  append(entry: PeerInboxEntry, body: string, caps: PeerInboxCaps): PeerAppendResult {
    for (const value of [entry.receiptId, entry.senderSessionId, entry.senderIncarnation, entry.sendId, entry.recipientSessionId, entry.digest]) checkId(value);
    if (typeof body !== "string" || !body.isWellFormed() || entry.size !== Buffer.byteLength(body, "utf8") || !Number.isFinite(entry.acceptedAt)) throw new CoworkError("invalid_request");
    for (const cap of [caps?.maxUnresolvedPerRecipient, caps?.maxUnresolvedPerSenderRecipient, caps?.maxUnresolvedBytesPerRecipient]) if (!Number.isSafeInteger(cap) || (cap as number) < 1) throw new CoworkError("invalid_request");
    const existing = this.state.identities.get(identityKey(entry));
    if (existing !== undefined) return { status: "existing", record: { ...this.state.records.get(existing)! } };
    if (this.state.records.has(entry.receiptId)) throw new CoworkError("request_conflict");
    const open = this.ordered(entry.recipientSessionId, false);
    if (open.filter(record => record.senderSessionId === entry.senderSessionId).length >= caps.maxUnresolvedPerSenderRecipient) return { status: "full", reason: "sender_quota" };
    if (open.length >= caps.maxUnresolvedPerRecipient) return { status: "full", reason: "inbox_full" };
    if (open.reduce((total, record) => total + record.size, 0) + entry.size > caps.maxUnresolvedBytesPerRecipient) return { status: "full", reason: "inbox_bytes_full" };

    const previous = this.state.sequences.get(entry.recipientSessionId) ?? 0, sequence = previous + 1, handle = `body_${this.state.bodyCounter + 1}`;
    const record: PeerInboxRecord = { ...entry, bodyHandle: handle, sequence, state: "accepted", reason: null, attempts: 0, offered: null, deliveredUnder: null, updatedAt: entry.acceptedAt, version: 1 };
    const undo: Array<() => void> = [];
    try {
      this.beforeWrite(); this.state.bodies.set(handle, body); undo.push(() => { this.state.bodies.delete(handle); });
      this.beforeWrite(); this.state.records.set(record.receiptId, record); undo.push(() => { this.state.records.delete(record.receiptId); });
      this.beforeWrite(); this.state.identities.set(identityKey(entry), record.receiptId); undo.push(() => { this.state.identities.delete(identityKey(entry)); });
      this.beforeWrite(); this.state.sequences.set(entry.recipientSessionId, sequence); undo.push(() => { if (previous === 0) this.state.sequences.delete(entry.recipientSessionId); else this.state.sequences.set(entry.recipientSessionId, previous); });
      this.beforeWrite(); this.state.bodyCounter++; undo.push(() => { this.state.bodyCounter--; });
    } catch (error) {
      for (const revert of undo.reverse()) revert();
      throw error;
    }
    return { status: "created", record: { ...record } };
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
  audit(): PeerInboxAudit {
    const referenced = new Set<string>(), report: PeerInboxAudit = { unresolvedWithoutBody: [], terminalWithBody: [], orphanBodies: 0 };
    for (const record of this.state.records.values()) {
      if (record.bodyHandle !== null) referenced.add(record.bodyHandle);
      if (isTerminalPeerState(record.state)) { if (record.bodyHandle !== null) report.terminalWithBody.push(record.receiptId); }
      else if (record.bodyHandle === null || !this.state.bodies.has(record.bodyHandle)) report.unresolvedWithoutBody.push(record.receiptId);
    }
    for (const handle of this.state.bodies.keys()) if (!referenced.has(handle)) report.orphanBodies++;
    return report;
  }
  private ordered(recipientSessionId: string, terminal: boolean): PeerInboxRecord[] {
    return [...this.state.records.values()].filter(record => record.recipientSessionId === recipientSessionId && isTerminalPeerState(record.state) === terminal)
      .sort((a, b) => a.sequence - b.sequence).map(record => ({ ...record }));
  }
}
