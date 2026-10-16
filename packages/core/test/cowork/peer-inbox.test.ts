import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { CoworkRepository } from "../../src/cowork/repository";
import { CoworkError } from "../../src/cowork/types";
import { CoworkPeerInbox, InMemoryPeerInboxStore, PEER_INBOX_LIMITS, createPeerInboxMemoryState, peerSendDigest, type CoworkPeerInboxOptions, type PeerEpoch, type PeerInboxCaps, type PeerSendRequest } from "../../src/cowork/peer-inbox";
import type { CoworkMessagingRecords } from "../../src/cowork/messaging-authority";
import * as peerInboxModule from "../../src/cowork/peer-inbox";
import { openRuntimeStateDb } from "../../src/runtime-state/db";
import { authorityFixtureSessions } from "./committed-sessions";
import { peerInboxStoreConformanceCases } from "./peer-inbox-conformance";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

function codeOf(operation: () => unknown): string | undefined {
  try { operation(); } catch (error) { return error instanceof CoworkError ? error.code : `non-cowork:${String(error)}`; }
  return undefined;
}

/** Real canonical records (so the real `mayContactCoworkPeer` runs), an in-memory store and a manual clock. */
function fixture(options: { limits?: CoworkPeerInboxOptions["limits"]; store?: InMemoryPeerInboxStore } = {}) {
  const home = mkdtempSync(join(tmpdir(), "winter-peer-inbox-"));
  const db = openRuntimeStateDb(home), records = new CoworkRepository(db);
  cleanups.push(() => { db.close(); rmSync(home, { recursive: true, force: true }); });
  let sequence = 0, clock = 1_000_000, receipts = 0;
  const store = options.store ?? new InMemoryPeerInboxStore();
  const context = () => ({ principalId: "fixture-user", requestId: `request-${++sequence}` });
  const project = () => {
    const created = records.create(context(), { ownership: "project", title: "Test", ceiling: { toolClasses: [], hostServices: [], connectors: [], network: "none" }, sources: [{ kind: "folder", label: "Fixture", access: "read-write", detail: { grantRef: "fixture-grant", rootIdentity: "fixture-root" } }] });
    const source = created.value.sources[0]!, epoch = records.beginIncarnation(created.workspaceId, `boot-${++sequence}`, created.revision);
    records.acknowledgeSource(epoch, source.sourceId, source.revision, "ready");
    return { workspaceId: created.workspaceId, sourceId: source.sourceId };
  };
  const bind = (workspace: ReturnType<typeof project>) => {
    const sessionId = `s_${++sequence}`;
    records.bindConversation({ ...context(), expectedRevision: records.get(workspace.workspaceId).configRevision }, workspace.workspaceId, { sessionId, sourceId: workspace.sourceId }, authorityFixtureSessions(sessionId));
    return sessionId;
  };
  const epochOf = (workspace: ReturnType<typeof project>): PeerEpoch => {
    const current = records.get(workspace.workspaceId);
    return { incarnationId: current.incarnationId!, leaseEpoch: current.leaseEpoch };
  };
  /** The guest stops and a new incarnation starts: the lease epoch advances and the old epoch is stale. */
  const bump = (workspace: ReturnType<typeof project>): PeerEpoch => {
    db.db.run("UPDATE cowork_workspaces SET power='stopped' WHERE workspace_id=?", [workspace.workspaceId]);
    records.beginIncarnation(workspace.workspaceId, `boot-${++sequence}`, records.get(workspace.workspaceId).configRevision);
    return epochOf(workspace);
  };
  const setBinding = (sessionId: string, state: "active" | "archived" | "deleted") => { db.db.run("UPDATE cowork_conversations SET state=? WHERE session_id=?", [state, sessionId]); };
  const make = (over: Partial<CoworkPeerInboxOptions> = {}) => new CoworkPeerInbox({ records, store, now: () => clock, newReceiptId: () => `receipt-${++receipts}`, limits: options.limits, ...over });
  const req = (from: string, to: string, text: string, sendId: string, senderIncarnation = "inc-1"): PeerSendRequest => ({ senderSessionId: from, senderIncarnation, sendId, recipientSessionId: to, text });
  const id = (from: string, sendId: string, senderIncarnation = "inc-1") => ({ senderSessionId: from, senderIncarnation, sendId });
  /** One delivery step: offer, then the recipient acknowledges. Undefined when nothing is owed. */
  const step = (inbox: CoworkPeerInbox, recipient: string, epoch: PeerEpoch): string | undefined => {
    const offer = inbox.offer(recipient, epoch);
    if (!offer) return undefined;
    inbox.ack({ receiptId: offer.receipt.receiptId, recipientSessionId: recipient, epoch });
    return offer.body;
  };
  const drain = (inbox: CoworkPeerInbox, recipient: string, epoch: PeerEpoch): string[] => {
    const bodies: string[] = [];
    for (let body = step(inbox, recipient, epoch); body !== undefined; body = step(inbox, recipient, epoch)) bodies.push(body);
    return bodies;
  };
  return { db, records, store, project, bind, epochOf, bump, setBinding, make, req, id, step, drain, advance: (ms: number) => { clock += ms; } };
}

// ---------------------------------------------------------------- durability and exactly-once

test("a store that throws on write fails accept: nothing is returned as success, nothing is persisted, no store text leaks", () => {
  class FaultyStore extends InMemoryPeerInboxStore {
    failWrites = false;
    override append(...args: Parameters<InMemoryPeerInboxStore["append"]>) {
      if (this.failWrites) throw new Error("disk full at /private/host/path");
      return super.append(...args);
    }
    override update(...args: Parameters<InMemoryPeerInboxStore["update"]>) {
      if (this.failWrites) throw new Error("disk full at /private/host/path");
      return super.update(...args);
    }
  }
  const store = new FaultyStore(), f = fixture({ store }), p = f.project(), a = f.bind(p), r = f.bind(p), inbox = f.make(), epoch = f.epochOf(p);
  store.failWrites = true;
  let thrown: unknown, result: unknown;
  try { result = inbox.accept(f.req(a, r, "hello", "m1")); } catch (error) { thrown = error; }
  expect(result).toBeUndefined();
  expect(thrown).toBeInstanceOf(CoworkError);
  expect((thrown as CoworkError).code).toBe("recovery_required");
  expect((thrown as CoworkError).message).toBe("recovery_required");
  expect(store.recipients()).toEqual([]);
  expect(inbox.lookup(f.id(a, "m1"))).toBeUndefined();

  // The failed attempt left nothing behind, so the retry is a fresh accept, and success means the record is already in the store.
  store.failWrites = false;
  const accepted = inbox.accept(f.req(a, r, "hello", "m1"));
  expect(accepted.outcome).toBe("accepted");
  if (accepted.outcome !== "accepted") throw new Error("unreachable");
  const record = store.get(accepted.receipt.receiptId)!;
  expect([record.state, record.sequence, record.size]).toEqual(["accepted", 1, 5]);
  expect(store.readBody(record.bodyHandle!)).toBe("hello");

  // Offer and ack are writes too: a failed write is reported and the record is unchanged.
  store.failWrites = true;
  expect(codeOf(() => inbox.offer(r, epoch))).toBe("recovery_required");
  expect(store.get(record.receiptId)).toEqual(record);
  store.failWrites = false;
  const offer = inbox.offer(r, epoch)!;
  store.failWrites = true;
  expect(codeOf(() => inbox.ack({ receiptId: offer.receipt.receiptId, recipientSessionId: r, epoch }))).toBe("recovery_required");
  expect(store.get(record.receiptId)!.state).toBe("accepted");
  store.failWrites = false;
  expect(inbox.ack({ receiptId: offer.receipt.receiptId, recipientSessionId: r, epoch }).state).toBe("delivered");
});

test("per-recipient FIFO by the store's sequence, independent of timestamps, senders and other recipients", () => {
  const f = fixture(), p = f.project(), a = f.bind(p), b = f.bind(p), r1 = f.bind(p), r2 = f.bind(p), epoch = f.epochOf(p), inbox = f.make();
  // The manual clock never moves: acceptance order is the store's sequence, not a timestamp.
  for (const [from, to, text, id] of [[a, r1, "a1", "m1"], [b, r1, "b1", "m2"], [a, r2, "x1", "m3"], [a, r1, "a2", "m4"], [b, r1, "b2", "m5"]] as const)
    expect(inbox.accept(f.req(from, to, text, id)).outcome).toBe("accepted");
  expect(inbox.pending(r1).map(receipt => receipt.sendId)).toEqual(["m1", "m2", "m4", "m5"]);

  // One message in flight at a time: an unacked head is offered again, never skipped past.
  const first = inbox.offer(r1, epoch)!;
  expect([first.body, first.receipt.attempts]).toEqual(["a1", 1]);
  const repeat = inbox.offer(r1, epoch)!;
  expect([repeat.body, repeat.receipt.receiptId, repeat.receipt.attempts]).toEqual(["a1", first.receipt.receiptId, 2]);
  inbox.ack({ receiptId: first.receipt.receiptId, recipientSessionId: r1, epoch });
  expect(f.drain(inbox, r1, epoch)).toEqual(["b1", "a2", "b2"]);
  expect(f.drain(inbox, r2, epoch)).toEqual(["x1"]);
  expect(inbox.offer(r1, epoch)).toBeUndefined();
});

test("a restart (new ledger over the same store) delivers each message exactly once; an unacked offer is offered again", () => {
  const f = fixture(), p = f.project(), a = f.bind(p), b = f.bind(p), r = f.bind(p), epoch = f.epochOf(p), first = f.make();
  const texts = ["text-1", "text-2", "text-3", "text-4"];
  texts.forEach((text, index) => first.accept(f.req(index % 2 === 0 ? a : b, r, text, `m${index + 1}`)));
  const delivered: string[] = [];
  const one = first.offer(r, epoch)!;
  first.ack({ receiptId: one.receipt.receiptId, recipientSessionId: r, epoch }); delivered.push(one.body);
  const handedOut = first.offer(r, epoch)!; // the process dies here, before text-2 is acknowledged
  expect(handedOut.body).toBe("text-2");

  const second = f.make({ store: f.store.reopen() });
  expect(second.pending(r).map(receipt => receipt.receiptId)).toEqual(first.pending(r).map(receipt => receipt.receiptId));
  delivered.push(...f.drain(second, r, epoch));
  expect(delivered).toEqual(texts); // every message exactly once, in order
  expect(second.offer(r, epoch)).toBeUndefined();
  expect(first.offer(r, epoch)).toBeUndefined(); // the old instance holds no cursor of its own

  // A late ack from before the restart is idempotent and never delivers twice.
  expect(first.ack({ receiptId: one.receipt.receiptId, recipientSessionId: r, epoch }).state).toBe("delivered");
  expect(f.store.unresolved(r)).toEqual([]);
  expect(f.store.terminal(r).map(record => record.attempts)).toEqual([1, 2, 1, 1]);
  // And a sender retry after the restart gets the retained receipt, not a new delivery.
  const retry = second.accept(f.req(a, r, "text-1", "m1"));
  expect(retry.outcome).toBe("retained");
  expect(f.drain(second, r, epoch)).toEqual([]);
});

// ---------------------------------------------------------------- authority at accept, deliver and ack

test("revocation between accept and deliver parks the message, skips ahead for other senders, and resumes on restore", () => {
  const f = fixture(), p = f.project(), a = f.bind(p), b = f.bind(p), r = f.bind(p), epoch = f.epochOf(p), inbox = f.make();
  inbox.accept(f.req(a, r, "from-a", "m1"));
  inbox.accept(f.req(b, r, "from-b", "m2"));
  f.setBinding(a, "archived"); // A's authority is revoked after its message was accepted

  const offer = inbox.offer(r, epoch)!;
  expect(offer.body).toBe("from-b"); // A's message is not delivered, and does not stall B's
  const parked = inbox.lookup(f.id(a, "m1"))!;
  expect([parked.state, parked.reason, parked.attempts]).toEqual(["blocked", "authority", 0]);
  expect(f.store.readBody(f.store.get(parked.receiptId)!.bodyHandle!)).toBe("from-a"); // retained, not dropped
  inbox.ack({ receiptId: offer.receipt.receiptId, recipientSessionId: r, epoch });
  expect(inbox.offer(r, epoch)).toBeUndefined();
  expect(inbox.owed(r)).toEqual({ runnable: 0, blocked: 1 });

  // Authority restored: the parked message is the oldest owed one, so it goes next.
  f.setBinding(a, "active");
  const resumed = inbox.offer(r, epoch)!;
  expect([resumed.body, resumed.receipt.state, resumed.receipt.reason]).toEqual(["from-a", "accepted", null]);
  expect(inbox.ack({ receiptId: resumed.receipt.receiptId, recipientSessionId: r, epoch }).state).toBe("delivered");
});

test("revocation between offer and ack answers authority_denied, parks the message and delivers nothing", () => {
  const f = fixture(), p = f.project(), a = f.bind(p), r = f.bind(p), epoch = f.epochOf(p), inbox = f.make();
  inbox.accept(f.req(a, r, "hello", "m1"));
  const offer = inbox.offer(r, epoch)!;
  f.db.db.run("UPDATE cowork_workspaces SET owner_id='different-project' WHERE workspace_id=?", [p.workspaceId]);
  expect(codeOf(() => inbox.ack({ receiptId: offer.receipt.receiptId, recipientSessionId: r, epoch }))).toBe("authority_denied");
  const parked = inbox.lookup(f.id(a, "m1"))!;
  expect([parked.state, parked.reason]).toEqual(["blocked", "authority"]);
  expect(f.store.get(parked.receiptId)!.deliveredUnder).toBeNull();
  expect(inbox.offer(r, epoch)).toBeUndefined();
  f.db.db.run("UPDATE cowork_workspaces SET owner_id=? WHERE workspace_id=?", [f.records.binding(a).projectId, p.workspaceId]);
  expect(f.drain(inbox, r, epoch)).toEqual(["hello"]);
});

test("a recipient that is gone ends its queued messages terminally and releases their bodies; nothing is recreated", () => {
  const f = fixture(), p = f.project(), a = f.bind(p), r = f.bind(p), epoch = f.epochOf(p), inbox = f.make();
  inbox.accept(f.req(a, r, "one", "m1")); inbox.accept(f.req(a, r, "two", "m2"));
  const handle = f.store.find(f.id(a, "m1"))!.bodyHandle!;
  f.setBinding(r, "deleted");
  expect(inbox.offer(r, epoch)).toBeUndefined();
  for (const sendId of ["m1", "m2"]) {
    const receipt = inbox.lookup(f.id(a, sendId))!;
    expect([receipt.state, receipt.reason]).toEqual(["refused", "not_found"]);
    expect(f.store.get(receipt.receiptId)!.bodyHandle).toBeNull();
  }
  expect(f.store.readBody(handle)).toBeUndefined();
  expect(inbox.owed(r)).toEqual({ runnable: 0, blocked: 0 });
  expect(inbox.accept(f.req(a, r, "three", "m3"))).toEqual({ outcome: "refused", reason: "not_found" });
  expect(f.records.binding(r).state).toBe("deleted");
});

test("an archived or unknown recipient is refused at accept: no record, no body, no wake, no recreate", () => {
  const f = fixture(), p = f.project(), a = f.bind(p), archived = f.bind(p), other = f.project(), foreign = f.bind(other), epoch = f.epochOf(p), inbox = f.make();
  const conversations = () => (f.db.db.query("SELECT count(*) AS n FROM cowork_conversations").get() as { n: number }).n;
  const before = conversations();
  f.setBinding(archived, "archived");

  expect(inbox.accept(f.req(a, archived, "wake up", "m1"))).toEqual({ outcome: "refused", reason: "recipient_archived" });
  // Only a CURRENT same-Project member is told "archived"; everyone else gets the uniform not_found.
  expect(inbox.accept(f.req(foreign, archived, "probe", "m2"))).toEqual({ outcome: "refused", reason: "not_found" });
  expect(inbox.accept(f.req("s_host_session", archived, "probe", "m3"))).toEqual({ outcome: "refused", reason: "not_found" });
  expect(inbox.accept(f.req(a, "s_does_not_exist", "hello", "m4"))).toEqual({ outcome: "refused", reason: "not_found" });
  expect(inbox.accept(f.req(a, a, "to myself", "m5"))).toEqual({ outcome: "refused", reason: "not_found" });
  expect(inbox.accept(f.req(a, foreign, "cross project", "m6"))).toEqual({ outcome: "refused", reason: "not_found" });
  f.setBinding(a, "archived");
  expect(inbox.accept(f.req(a, f.bind(p), "from an archived sender", "m7"))).toEqual({ outcome: "refused", reason: "not_found" });
  expect(inbox.accept(f.req(a, archived, "archived to archived", "m9"))).toEqual({ outcome: "refused", reason: "not_found" }); // only an ACTIVE member is told "archived"
  f.setBinding(a, "active");

  expect(f.store.recipients()).toEqual([]); // a refusal persists nothing: no record, no body, no receipt
  expect(inbox.offer(archived, epoch)).toBeUndefined();
  expect(inbox.pending(archived)).toEqual([]);
  expect(conversations()).toBe(before + 1); // only the one session this test bound afterwards; the ledger created none
  expect(() => f.records.binding("s_does_not_exist")).toThrow();

  // After an explicit restore the same send identity is accepted: a refusal is not sticky.
  f.setBinding(archived, "active");
  expect(inbox.accept(f.req(a, archived, "wake up", "m1")).outcome).toBe("accepted");
  // No repository means no authority: everything fails closed.
  expect(f.make({ records: undefined }).accept(f.req(a, archived, "x", "m8"))).toEqual({ outcome: "refused", reason: "not_found" });
});

// ---------------------------------------------------------------- incarnation and lease-epoch fence

test("an ack from a stale incarnation or lease epoch is refused and leaves the message owed", () => {
  const f = fixture(), p = f.project(), a = f.bind(p), r = f.bind(p), stranger = f.bind(p), old = f.epochOf(p), inbox = f.make();
  inbox.accept(f.req(a, r, "hello", "m1"));
  const offer = inbox.offer(r, old)!, receiptId = offer.receipt.receiptId;
  const ack = (epoch: PeerEpoch, recipientSessionId = r) => () => inbox.ack({ receiptId, recipientSessionId, epoch });
  const state = () => inbox.lookup(f.id(a, "m1"))!.state;

  const fresh = f.bump(p); // the guest restarted: a new incarnation and a higher lease epoch
  expect(fresh.leaseEpoch).toBeGreaterThan(old.leaseEpoch);
  expect(codeOf(ack(old))).toBe("stale_acknowledgment"); // offered under the old epoch, but that epoch is no longer current
  expect(codeOf(ack(fresh))).toBe("stale_acknowledgment"); // current, but never the epoch it was offered under
  expect(codeOf(ack({ incarnationId: fresh.incarnationId, leaseEpoch: fresh.leaseEpoch + 1 }))).toBe("stale_acknowledgment");
  expect(codeOf(ack({ incarnationId: "forged", leaseEpoch: old.leaseEpoch }))).toBe("stale_acknowledgment");
  expect(codeOf(() => inbox.offer(r, old))).toBe("stale_acknowledgment"); // a delivery owner holding the old epoch cannot offer either
  expect(state()).toBe("accepted");
  expect(f.store.get(receiptId)!.deliveredUnder).toBeNull();

  // Only the recipient itself can acknowledge, and only a known receipt.
  expect(codeOf(ack(fresh, stranger))).toBe("not_found");
  expect(codeOf(() => inbox.ack({ receiptId: "receipt-unknown", recipientSessionId: r, epoch: fresh }))).toBe("not_found");

  // Re-offered under the new epoch, the same message is acknowledged exactly once.
  const again = inbox.offer(r, fresh)!;
  expect([again.body, again.receipt.attempts]).toEqual(["hello", 2]);
  expect(codeOf(ack(old))).toBe("stale_acknowledgment");
  expect(inbox.ack({ receiptId, recipientSessionId: r, epoch: fresh }).state).toBe("delivered");
  expect(inbox.ack({ receiptId, recipientSessionId: r, epoch: fresh }).state).toBe("delivered"); // idempotent for the delivering epoch
  expect(codeOf(ack(old))).toBe("stale_acknowledgment"); // never for another epoch
  expect(inbox.offer(r, fresh)).toBeUndefined();
});

// ---------------------------------------------------------------- idempotency

test("the same send identity returns the retained receipt; the same id with different content is request_conflict", () => {
  const f = fixture(), p = f.project(), a = f.bind(p), b = f.bind(p), r = f.bind(p), other = f.bind(p), epoch = f.epochOf(p), inbox = f.make();
  const first = inbox.accept(f.req(a, r, "hello", "m1"));
  if (first.outcome !== "accepted") throw new Error("expected accepted");
  const again = inbox.accept(f.req(a, r, "hello", "m1"));
  expect(again).toEqual({ outcome: "retained", receipt: first.receipt });
  expect(f.store.unresolved(r)).toHaveLength(1);

  expect(codeOf(() => inbox.accept(f.req(a, r, "HELLO", "m1")))).toBe("request_conflict"); // different text
  expect(codeOf(() => inbox.accept(f.req(a, other, "hello", "m1")))).toBe("request_conflict"); // different recipient
  expect(f.store.unresolved(r)).toHaveLength(1);
  expect(f.store.unresolved(other)).toEqual([]);
  expect(f.store.readBody(f.store.get(first.receipt.receiptId)!.bodyHandle!)).toBe("hello");

  // Distinct identities do not collide: another sender, or the same sender's next incarnation, may reuse an id.
  const sibling = inbox.accept(f.req(b, r, "hello", "m1")), restarted = inbox.accept(f.req(a, r, "hello", "m1", "inc-2"));
  expect(sibling.outcome).toBe("accepted"); expect(restarted.outcome).toBe("accepted");
  expect(new Set([first, sibling, restarted].map(result => result.outcome === "refused" ? "" : result.receipt.receiptId)).size).toBe(3);

  // The retained receipt follows the message through delivery, and a retry never delivers it twice.
  expect(f.drain(inbox, r, epoch)).toEqual(["hello", "hello", "hello"]);
  const delivered = inbox.accept(f.req(a, r, "hello", "m1"));
  expect(delivered).toEqual({ outcome: "retained", receipt: expect.objectContaining({ receiptId: first.receipt.receiptId, state: "delivered" }) });
  expect(codeOf(() => inbox.accept(f.req(a, r, "changed", "m1")))).toBe("request_conflict");
  expect(f.drain(inbox, r, epoch)).toEqual([]);

  // A retry of an accepted message is answered from the retained receipt even if the sender has since lost authority.
  inbox.accept(f.req(a, r, "later", "m2"));
  f.setBinding(a, "archived");
  expect(inbox.accept(f.req(a, r, "later", "m2")).outcome).toBe("retained");
});

// ---------------------------------------------------------------- what is stored

test("the record keeps digest and size; the body is an opaque handle released at the terminal state; the receipt exposes none of it", () => {
  const f = fixture(), p = f.project(), a = f.bind(p), r = f.bind(p), epoch = f.epochOf(p), inbox = f.make();
  const text = "a confidential plan";
  const result = inbox.accept(f.req(a, r, text, "m1"));
  if (result.outcome !== "accepted") throw new Error("expected accepted");
  const record = f.store.get(result.receipt.receiptId)!;
  expect(JSON.stringify(record)).not.toContain(text);
  expect([record.size, record.digest]).toEqual([Buffer.byteLength(text), peerSendDigest(r, text)]);
  expect(record.bodyHandle).not.toBeNull();
  expect(Object.keys(result.receipt).sort()).toEqual(["acceptedAt", "attempts", "reason", "receiptId", "recipientSessionId", "sendId", "senderSessionId", "size", "state", "updatedAt"]);
  expect(JSON.stringify(result.receipt)).not.toContain(record.digest);
  expect(JSON.stringify(result.receipt)).not.toContain(record.bodyHandle!);

  expect(f.drain(inbox, r, epoch)).toEqual([text]);
  const done = f.store.get(record.receiptId)!;
  expect([done.state, done.bodyHandle]).toEqual(["delivered", null]);
  expect(f.store.readBody(record.bodyHandle!)).toBeUndefined();
  expect(JSON.stringify(done)).not.toContain(text);
});

test("a damaged or missing HEAD body holds the queue, untouched after the first block, until the body heals or the host exit drops it", () => {
  class DamagedStore extends InMemoryPeerInboxStore {
    /** Handles whose body reads back damaged (`tampered`) or absent (`missing`). Other bodies stay healthy. */
    damaged = new Map<string, "tampered" | "missing">();
    override readBody(handle: string) { const mode = this.damaged.get(handle); return mode === "tampered" ? "tampered text" : mode === "missing" ? undefined : super.readBody(handle); }
  }
  const store = new DamagedStore(), f = fixture({ store }), p = f.project(), a = f.bind(p), r = f.bind(p), epoch = f.epochOf(p), inbox = f.make();
  inbox.accept(f.req(a, r, "first", "m1")); inbox.accept(f.req(a, r, "second", "m2"));
  const headHandle = store.find(f.id(a, "m1"))!.bodyHandle!;
  for (const mode of ["tampered", "missing"] as const) {
    store.damaged.set(headHandle, mode); // ONLY the head is damaged; the second message is healthy
    expect(inbox.offer(r, epoch)).toBeUndefined(); // the healthy second message is NOT offered past the damaged head
    const parked = inbox.lookup(f.id(a, "m1"))!;
    expect([parked.state, parked.reason, parked.attempts]).toEqual(["blocked", "recovery", 0]);
    expect(inbox.lookup(f.id(a, "m2"))!.attempts).toBe(0);
  }
  // Already parked as blocked/recovery: further offers do not rewrite the record (no version or timestamp churn).
  const before = store.get(inbox.lookup(f.id(a, "m1"))!.receiptId)!;
  f.advance(5_000);
  for (let i = 0; i < 3; i++) expect(inbox.offer(r, epoch)).toBeUndefined();
  expect(store.get(before.receiptId)).toEqual(before);

  // The host exit drops a provably damaged head only, then the queue moves on.
  expect(codeOf(() => inbox.discard(inbox.lookup(f.id(a, "m2"))!.receiptId, { kind: "host", reason: "unrecoverable_body" }))).toBe("invalid_request"); // a healthy record cannot be dropped this way
  expect(codeOf(() => inbox.discard(before.receiptId, { kind: "host", reason: "whatever" } as never))).toBe("invalid_request"); // only the named host reason
  expect(store.get(before.receiptId)).toEqual(before);
  const dropped = inbox.discard(before.receiptId, { kind: "host", reason: "unrecoverable_body" });
  expect([dropped.state, dropped.reason]).toEqual(["refused", "unrecoverable"]);
  expect(store.audit()).toEqual({ unresolvedWithoutBody: [], terminalWithBody: [], orphanBodies: 0 });
  expect(f.drain(inbox, r, epoch)).toEqual(["second"]);

  // And a head that heals is simply offered again.
  inbox.accept(f.req(a, r, "third", "m3"));
  const thirdHandle = store.find(f.id(a, "m3"))!.bodyHandle!;
  store.damaged.set(thirdHandle, "tampered");
  expect(inbox.offer(r, epoch)).toBeUndefined();
  store.damaged.delete(thirdHandle);
  expect(f.drain(inbox, r, epoch)).toEqual(["third"]);
});

// ---------------------------------------------------------------- blocked, cancel, bounded retention

test("block parks a message visibly (host-only, not runnable) until an offer retries it; cancel is the only other exit", () => {
  const f = fixture(), p = f.project(), a = f.bind(p), r = f.bind(p), epoch = f.epochOf(p), inbox = f.make();
  inbox.accept(f.req(a, r, "one", "m1")); inbox.accept(f.req(a, r, "two", "m2")); inbox.accept(f.req(a, r, "three", "m3"));
  const offer = inbox.offer(r, epoch)!;
  const parkedReceipt = inbox.block(offer.receipt.receiptId, epoch, "resources");
  expect([parkedReceipt.state, parkedReceipt.reason]).toEqual(["blocked", "resources"]);
  expect(f.store.get(parkedReceipt.receiptId)!.offered).toBeNull();
  expect(inbox.owed(r)).toEqual({ runnable: 2, blocked: 1 });
  expect(codeOf(() => inbox.ack({ receiptId: parkedReceipt.receiptId, recipientSessionId: r, epoch }))).toBe("stale_acknowledgment"); // nothing is offered while blocked
  expect(codeOf(() => inbox.block(parkedReceipt.receiptId, epoch, "authority" as never))).toBe("invalid_request");
  expect(inbox.block(parkedReceipt.receiptId, { incarnationId: "any-other", leaseEpoch: 99 }, "grants")).toEqual(parkedReceipt); // already blocked: a no-op for any caller

  // Strict FIFO: the blocked head is retried first and nothing is delivered past it.
  expect(f.drain(inbox, r, epoch)).toEqual(["one", "two", "three"]);
  expect(inbox.block(parkedReceipt.receiptId, epoch, "grants").state).toBe("delivered"); // a late block cannot undo a terminal state

  inbox.accept(f.req(a, r, "cancel me", "m4"));
  const canceled = inbox.cancel(f.id(a, "m4"));
  expect([canceled.state, canceled.reason]).toEqual(["refused", "canceled"]);
  expect(f.store.get(canceled.receiptId)!.bodyHandle).toBeNull();
  expect(inbox.cancel(f.id(a, "m1")).state).toBe("delivered"); // delivered stays delivered
  expect(codeOf(() => inbox.cancel(f.id(a, "never")))).toBe("not_found");
  expect(inbox.offer(r, epoch)).toBeUndefined();
});

test("retention is bounded: the inbox caps unresolved records, terminal ones are pruned by count and age, unresolved are never pruned", () => {
  const f = fixture({ limits: { maxUnresolvedPerRecipient: 3, terminalKeepPerRecipient: 2, terminalTtlMs: 1_000 } }), p = f.project(), a = f.bind(p), r = f.bind(p), epoch = f.epochOf(p), inbox = f.make();
  for (const n of [1, 2, 3]) expect(inbox.accept(f.req(a, r, `t${n}`, `m${n}`)).outcome).toBe("accepted");
  expect(inbox.accept(f.req(a, r, "t4", "m4"))).toEqual({ outcome: "refused", reason: "inbox_full" });
  expect(inbox.lookup(f.id(a, "m4"))).toBeUndefined();

  expect(f.drain(inbox, r, epoch)).toEqual(["t1", "t2", "t3"]);
  expect(f.store.terminal(r)).toHaveLength(3);
  expect(inbox.accept(f.req(a, r, "t4", "m4")).outcome).toBe("accepted"); // accepting prunes this recipient: keep the newest 2
  expect(inbox.lookup(f.id(a, "m1"))).toBeUndefined(); // pruned: its dedupe is forfeited, as the spec allows
  expect(inbox.lookup(f.id(a, "m2"))!.state).toBe("delivered");
  expect(inbox.lookup(f.id(a, "m3"))!.state).toBe("delivered");

  f.advance(1_001); // everything terminal is now older than the TTL; the unresolved record is older than that too
  expect(inbox.prune()).toBe(2);
  expect(f.store.terminal(r)).toEqual([]);
  expect(inbox.pending(r).map(receipt => receipt.sendId)).toEqual(["m4"]);
  expect(inbox.prune()).toBe(0);
  expect(codeOf(() => f.store.remove(inbox.pending(r)[0]!.receiptId))).toBe("invalid_request"); // the store itself refuses
  expect(f.drain(inbox, r, epoch)).toEqual(["t4"]);
  expect(PEER_INBOX_LIMITS).toEqual({ maxMessageBytes: 65_536, maxUnresolvedPerRecipient: 256, maxUnresolvedPerSenderRecipient: 32, maxUnresolvedBytesPerRecipient: 4_194_304, terminalKeepPerRecipient: 100, terminalTtlMs: 86_400_000 });
});

test("malformed requests are invalid_request and persist nothing", () => {
  const f = fixture(), p = f.project(), a = f.bind(p), r = f.bind(p), inbox = f.make();
  const bad: PeerSendRequest[] = [
    f.req(a, r, "", "m1"), f.req("", r, "x", "m1"), f.req(a, "", "x", "m1"), f.req(a, r, "x", ""), f.req(a, r, "x", "m1", ""),
    f.req(a, r, "x", "line\nbreak"), f.req(a, r, "x".repeat(PEER_INBOX_LIMITS.maxMessageBytes + 1), "m2"), f.req(a, r, "x", "i".repeat(257)),
    { ...f.req(a, r, "x", "m3"), text: 7 as unknown as string },
    f.req(a, r, "broken \ud83d tail", "m5"), f.req(a, r, "\udc00", "m6"), f.req(a, r, "   \n\t ", "m7"), f.req(a, r, "\u00a0", "m8"),
  ];
  for (const request of bad) expect(codeOf(() => inbox.accept(request))).toBe("invalid_request");
  expect(inbox.accept(f.req(a, r, "x".repeat(PEER_INBOX_LIMITS.maxMessageBytes), "m4")).outcome).toBe("accepted");
  expect(codeOf(() => inbox.offer(r, { incarnationId: "", leaseEpoch: 1 }))).toBe("invalid_request");
  expect(codeOf(() => inbox.offer(r, { incarnationId: "boot", leaseEpoch: -1 }))).toBe("invalid_request");
  expect(f.store.recipients()).toEqual([r]);
  expect(f.store.unresolved(r)).toHaveLength(1);
});

// ---------------------------------------------------------------- review round: gone senders, exhaustion, fences, sweeps

const CLEAN = { unresolvedWithoutBody: [], terminalWithBody: [], orphanBodies: 0 };
const setPower = (f: ReturnType<typeof fixture>, workspaceId: string, power: string) => { f.db.db.run("UPDATE cowork_workspaces SET power=? WHERE workspace_id=?", [power, workspaceId]); };

test("a deleted sender's records end as sender_gone, release their bodies and free the inbox; an archived sender is only parked", () => {
  const f = fixture({ limits: { maxUnresolvedPerRecipient: 3 } }), p = f.project(), a = f.bind(p), b = f.bind(p), c = f.bind(p), r = f.bind(p), epoch = f.epochOf(p), inbox = f.make();
  for (const n of [1, 2, 3]) inbox.accept(f.req(a, r, `t${n}`, `m${n}`));
  expect(inbox.accept(f.req(b, r, "blocked out", "x1"))).toEqual({ outcome: "refused", reason: "inbox_full" });

  f.setBinding(a, "archived"); // archived is NOT deleted: the records are parked and still hold their slots
  expect(inbox.offer(r, epoch)).toBeUndefined();
  for (const n of [1, 2, 3]) expect([inbox.lookup(f.id(a, `m${n}`))!.state, inbox.lookup(f.id(a, `m${n}`))!.reason]).toEqual(["blocked", "authority"]);
  expect(inbox.accept(f.req(b, r, "blocked out", "x1"))).toEqual({ outcome: "refused", reason: "inbox_full" });

  setPower(f, p.workspaceId, "stopped"); // the sweep needs no guest epoch, so it works while the workspace is stopped
  f.setBinding(a, "deleted");
  inbox.settle(r);
  setPower(f, p.workspaceId, "starting");
  for (const n of [1, 2, 3]) {
    const receipt = inbox.lookup(f.id(a, `m${n}`))!;
    expect([receipt.state, receipt.reason]).toEqual(["refused", "sender_gone"]);
    expect(f.store.get(receipt.receiptId)!.bodyHandle).toBeNull();
  }
  expect(f.store.audit()).toEqual(CLEAN);
  expect(inbox.pending(r)).toEqual([]);
  expect(inbox.cancel(f.id(a, "m1")).reason).toBe("sender_gone"); // a deleted sender can never cancel; the terminal record is returned unchanged
  expect(inbox.accept(f.req(b, r, "blocked out", "x1")).outcome).toBe("accepted"); // the slots are free again
  expect(f.drain(inbox, r, epoch)).toEqual(["blocked out"]);

  // `offer` sweeps too, and the recipient being gone wins when both are gone.
  inbox.accept(f.req(c, r, "from c", "c1"));
  f.setBinding(c, "deleted");
  expect(inbox.offer(r, epoch)).toBeUndefined();
  expect(inbox.lookup(f.id(c, "c1"))).toMatchObject({ state: "refused", reason: "sender_gone" });
  const d = f.bind(p), r2 = f.bind(p);
  inbox.accept(f.req(d, r2, "to nobody", "d1"));
  f.setBinding(d, "deleted"); f.setBinding(r2, "deleted");
  inbox.settle(r2);
  expect(inbox.lookup(f.id(d, "d1"))).toMatchObject({ state: "refused", reason: "not_found" });
  expect(f.store.audit()).toEqual(CLEAN);
});

test("discard is the user's door for a record nobody else can end; it is idempotent and never touches a delivered record", () => {
  const f = fixture(), p = f.project(), a = f.bind(p), r = f.bind(p), epoch = f.epochOf(p), inbox = f.make();
  inbox.accept(f.req(a, r, "kept", "m1")); inbox.accept(f.req(a, r, "other", "m2"));
  f.setBinding(a, "archived"); inbox.settle(r); // an indefinitely archived sender: it can never cancel
  const receiptId = inbox.lookup(f.id(a, "m1"))!.receiptId, user = { kind: "user", principalId: "local-user" } as const;

  for (const bad of [{ kind: "user", principalId: "" }, { kind: "peer" }, { kind: "host", reason: "anything" }, undefined] as const) expect(codeOf(() => inbox.discard(receiptId, bad as never))).toBe("invalid_request");
  expect(codeOf(() => inbox.discard("receipt-unknown", user))).toBe("not_found");
  expect(codeOf(() => inbox.discard(receiptId, { kind: "host", reason: "unrecoverable_body" }))).toBe("invalid_request"); // the host exit is for a damaged body only
  expect(inbox.lookup(f.id(a, "m1"))!.state).toBe("blocked");

  const discarded = inbox.discard(receiptId, user);
  expect([discarded.state, discarded.reason]).toEqual(["refused", "discarded"]);
  expect(f.store.get(receiptId)!.bodyHandle).toBeNull();
  expect(inbox.discard(receiptId, user)).toEqual(discarded);
  expect(inbox.lookup(f.id(a, "m2"))!.state).toBe("blocked"); // others untouched
  expect(f.store.audit()).toEqual(CLEAN);

  f.setBinding(a, "active");
  expect(f.drain(inbox, r, epoch)).toEqual(["other"]);
  expect(inbox.discard(inbox.lookup(f.id(a, "m2"))!.receiptId, user).state).toBe("delivered");
});

test("the caps ride into the store's atomic append: per-sender quota, recipient count and body bytes; authority is decided before any cap", () => {
  class SpyStore extends InMemoryPeerInboxStore {
    caps: PeerInboxCaps[] = []; unresolvedReads = 0;
    override append(...args: Parameters<InMemoryPeerInboxStore["append"]>) { this.caps.push(args[2]); return super.append(...args); }
    override unresolved(recipient: string) { this.unresolvedReads++; return super.unresolved(recipient); }
  }
  const store = new SpyStore(), limits = { maxUnresolvedPerRecipient: 3, maxUnresolvedPerSenderRecipient: 2, maxUnresolvedBytesPerRecipient: 25 };
  const f = fixture({ store, limits }), p = f.project(), a = f.bind(p), b = f.bind(p), c = f.bind(p), r = f.bind(p), r2 = f.bind(p), foreign = f.bind(f.project()), epoch = f.epochOf(p), inbox = f.make();
  const send = (from: string, to: string, text: string, id: string, incarnation?: string) => inbox.accept(f.req(from, to, text, id, incarnation));

  expect(send(a, r, "aaaaa", "m1").outcome).toBe("accepted"); expect(send(a, r, "aaaaa", "m2").outcome).toBe("accepted");
  expect(send(a, r, "aaaaa", "m3")).toEqual({ outcome: "refused", reason: "sender_quota" });
  expect(send(a, r, "aaaaa", "m3", "inc-2")).toEqual({ outcome: "refused", reason: "sender_quota" }); // a restarted sender does not escape its quota
  expect(send(b, r, "bbbbb", "m4").outcome).toBe("accepted"); // another sender is unaffected
  expect(send(c, r, "ccccc", "m5")).toEqual({ outcome: "refused", reason: "inbox_full" });
  expect(send(foreign, r, "x", "m6")).toEqual({ outcome: "refused", reason: "not_found" }); // authority first: never inbox_full for an outsider

  expect(send(a, r2, "a".repeat(20), "m7").outcome).toBe("accepted");
  expect(send(b, r2, "b".repeat(6), "m8")).toEqual({ outcome: "refused", reason: "inbox_bytes_full" });
  expect(send(foreign, r2, "x".repeat(6), "m9")).toEqual({ outcome: "refused", reason: "not_found" });
  expect(send(b, r2, "b".repeat(5), "m10").outcome).toBe("accepted"); // exactly at the byte budget

  // The cap decision is the store's single atomic step: the ledger never reads the queue first, and passes its limits in.
  expect(store.unresolvedReads).toBe(0);
  expect(store.caps.length).toBeGreaterThan(0);
  for (const caps of store.caps) expect(caps).toEqual(limits);
  expect(inbox.pending(r)).toHaveLength(3);
  expect(store.audit()).toEqual(CLEAN);
  for (const refused of [["m3", a], ["m5", c], ["m6", foreign], ["m8", b], ["m9", foreign]] as const) expect(inbox.lookup(f.id(refused[1], refused[0]))).toBeUndefined();

  // Delivering frees capacity.
  f.step(inbox, r, epoch);
  expect(send(a, r, "aaaaa", "m3").outcome).toBe("accepted");
});

test("block is fenced by the epoch the message was offered under: a stale owner cannot un-offer what the current epoch holds", () => {
  const f = fixture(), p = f.project(), a = f.bind(p), r = f.bind(p), old = f.epochOf(p), inbox = f.make();
  inbox.accept(f.req(a, r, "hello", "m1")); inbox.accept(f.req(a, r, "second", "m2"));
  const receiptId = inbox.lookup(f.id(a, "m1"))!.receiptId, secondId = inbox.lookup(f.id(a, "m2"))!.receiptId;
  inbox.offer(r, old);
  const fresh = f.bump(p); // the guest restarted
  const reoffer = inbox.offer(r, fresh)!;
  expect(reoffer.receipt.attempts).toBe(2);

  // The stale owner of the old incarnation tries to park the message the new epoch holds.
  expect(codeOf(() => inbox.block(receiptId, old, "resources"))).toBe("stale_acknowledgment");
  expect(codeOf(() => inbox.block(receiptId, { incarnationId: fresh.incarnationId, leaseEpoch: fresh.leaseEpoch + 1 }, "resources"))).toBe("stale_acknowledgment");
  expect(codeOf(() => inbox.block(receiptId, { incarnationId: "forged", leaseEpoch: fresh.leaseEpoch }, "resources"))).toBe("stale_acknowledgment");
  expect(f.store.get(receiptId)).toMatchObject({ state: "accepted", offered: fresh, attempts: 2 });
  expect(inbox.ack({ receiptId, recipientSessionId: r, epoch: fresh }).state).toBe("delivered"); // the current epoch's ack is not livelocked

  // Never offered, so there is nothing to un-offer: the fence needs state accepted AND the same offered epoch.
  expect(codeOf(() => inbox.block(secondId, fresh, "grants"))).toBe("stale_acknowledgment");
  expect(inbox.lookup(f.id(a, "m2"))!.state).toBe("accepted");
  // The owner of the current offer may block, and a stopped guest can no longer speak for it.
  inbox.offer(r, fresh);
  setPower(f, p.workspaceId, "stopped");
  expect(codeOf(() => inbox.block(secondId, fresh, "grants"))).toBe("stale_acknowledgment");
  setPower(f, p.workspaceId, "starting");
  expect(inbox.block(secondId, fresh, "grants")).toMatchObject({ state: "blocked", reason: "grants" });
  // Terminal and already-blocked records stay no-ops for any caller.
  expect(inbox.block(secondId, old, "resources")).toMatchObject({ state: "blocked", reason: "grants" });
  expect(inbox.block(receiptId, old, "resources").state).toBe("delivered");
});

test("owed() counts only accepted work its sender may still send; settle sweeps without an epoch and offer runs it first", () => {
  const f = fixture(), p = f.project(), a = f.bind(p), b = f.bind(p), r = f.bind(p), epoch = f.epochOf(p), inbox = f.make();
  inbox.accept(f.req(a, r, "one", "m1")); inbox.accept(f.req(b, r, "two", "m2"));
  expect(inbox.owed(r)).toEqual({ runnable: 2, blocked: 0 });

  f.setBinding(r, "archived"); // nothing has swept yet
  expect(inbox.owed(r)).toEqual({ runnable: 0, blocked: 2 }); // an archived recipient shows no runnable work
  expect(inbox.pending(r).map(receipt => receipt.state)).toEqual(["accepted", "accepted"]); // owed() is read-only
  setPower(f, p.workspaceId, "stopped"); // no guest, no epoch: settle does not need one
  inbox.settle(r);
  expect(inbox.pending(r).map(receipt => [receipt.state, receipt.reason])).toEqual([["blocked", "authority"], ["blocked", "authority"]]);
  expect(inbox.owed(r)).toEqual({ runnable: 0, blocked: 2 });
  setPower(f, p.workspaceId, "starting");

  // The recipient is back; one sender is archived. A parked record whose pair may send again is runnable work again.
  f.setBinding(r, "active"); f.setBinding(a, "archived");
  expect(inbox.owed(r)).toEqual({ runnable: 1, blocked: 1 });
  // A delivery owner's block is never runnable.
  f.setBinding(a, "active");
  const offer = inbox.offer(r, epoch)!;
  inbox.block(offer.receipt.receiptId, epoch, "grants");
  expect(inbox.owed(r)).toEqual({ runnable: 1, blocked: 1 });

  // With nothing eligible, offer sweeps and returns undefined even for an epoch that is not current.
  f.setBinding(r, "archived");
  expect(inbox.offer(r, { incarnationId: "bogus", leaseEpoch: 7 })).toBeUndefined();
  expect(inbox.pending(r).map(receipt => [receipt.state, receipt.reason])).toEqual([["blocked", "authority"], ["blocked", "authority"]]);
});

test("an archived recipient parks queued messages as blocked, never refused; they deliver after the explicit restore", () => {
  const f = fixture(), p = f.project(), a = f.bind(p), r = f.bind(p), epoch = f.epochOf(p), inbox = f.make();
  inbox.accept(f.req(a, r, "hello", "m1"));
  f.setBinding(r, "archived"); // archived MID-FLIGHT
  expect(inbox.offer(r, epoch)).toBeUndefined();
  const parked = inbox.lookup(f.id(a, "m1"))!;
  expect([parked.state, parked.reason]).toEqual(["blocked", "authority"]);
  expect(f.store.readBody(f.store.get(parked.receiptId)!.bodyHandle!)).toBe("hello");
  f.setBinding(r, "active");
  expect(f.drain(inbox, r, epoch)).toEqual(["hello"]);
});

test("the epoch fence also needs a live guest: the same incarnation and lease epoch is stale once the workspace stopped or left retained", () => {
  const f = fixture(), p = f.project(), a = f.bind(p), r = f.bind(p), epoch = f.epochOf(p), inbox = f.make();
  inbox.accept(f.req(a, r, "one", "m1")); inbox.accept(f.req(a, r, "two", "m2"));
  for (const power of ["stopped", "draining", "uncertain"]) {
    setPower(f, p.workspaceId, power);
    expect(codeOf(() => inbox.offer(r, epoch))).toBe("stale_acknowledgment");
  }
  setPower(f, p.workspaceId, "running");
  const offer = inbox.offer(r, epoch)!;
  setPower(f, p.workspaceId, "stopped");
  expect(codeOf(() => inbox.ack({ receiptId: offer.receipt.receiptId, recipientSessionId: r, epoch }))).toBe("stale_acknowledgment");
  setPower(f, p.workspaceId, "running");
  expect(inbox.ack({ receiptId: offer.receipt.receiptId, recipientSessionId: r, epoch }).state).toBe("delivered");

  // A workspace that is no longer retained: the fence answers first, ahead of the authority check that would also fail.
  const second = inbox.offer(r, epoch)!;
  f.db.db.run("UPDATE cowork_workspaces SET state='archived' WHERE workspace_id=?", [p.workspaceId]);
  expect(codeOf(() => inbox.ack({ receiptId: second.receipt.receiptId, recipientSessionId: r, epoch }))).toBe("stale_acknowledgment");
  expect(codeOf(() => inbox.block(second.receipt.receiptId, epoch, "grants"))).toBe("stale_acknowledgment");
  expect(inbox.lookup(f.id(a, "m2"))!.state).toBe("accepted");
});

test("one authority verdict per sender-recipient pair per pass: a transient read failure parks the pair, never reorders it", () => {
  const f = fixture(), p = f.project(), a = f.bind(p), r = f.bind(p), epoch = f.epochOf(p);
  let flaky = false, reads = 0;
  const records = new Proxy(f.records, { get(target, property, receiver) {
    const value = Reflect.get(target, property, receiver);
    if (property === "binding" && flaky) return (id: string) => { if (++reads === 1) throw new Error("SQLITE_BUSY"); return (value as CoworkRepository["binding"]).call(target, id); };
    return typeof value === "function" ? value.bind(target) : value;
  } });
  const inbox = f.make({ records: records as unknown as CoworkMessagingRecords });
  inbox.accept(f.req(a, r, "first", "m1")); inbox.accept(f.req(a, r, "second", "m2"));
  flaky = true;
  expect(inbox.offer(r, epoch)).toBeUndefined(); // the first candidate's check failed, so the whole pair is parked, not just it
  expect(inbox.pending(r).map(receipt => [receipt.sendId, receipt.state, receipt.reason])).toEqual([["m1", "blocked", "authority"], ["m2", "blocked", "authority"]]);
  flaky = false;
  expect(f.drain(inbox, r, epoch)).toEqual(["first", "second"]); // and the order survives
});

test("ill-formed and blank text is refused before anything is stored; NUL, astral and separator characters survive delivery intact", () => {
  const f = fixture(), p = f.project(), a = f.bind(p), r = f.bind(p), epoch = f.epochOf(p), inbox = f.make();
  for (const bad of ["broken \ud83d tail", "\udc00 first", " \n\t ", " "]) expect(codeOf(() => inbox.accept(f.req(a, r, bad, `bad-${bad.length}`)))).toBe("invalid_request");
  // The ledger rejects the text itself, before authority and before the store is asked: an outsider gets invalid_request, not a refusal.
  expect(codeOf(() => inbox.accept(f.req("s_outsider", r, "broken \ud83d tail", "bad-outsider")))).toBe("invalid_request");
  expect(f.store.recipients()).toEqual([]);
  const texts = ["a\u0000b", "emoji \u{1F600} café 日本語", "x y\r\nz", "  padded  "];
  texts.forEach((text, index) => expect(inbox.accept(f.req(a, r, text, `ok-${index}`)).outcome).toBe("accepted"));
  expect(f.drain(inbox, r, epoch)).toEqual(texts);
});

test("prune ends expired terminal records without touching fresh ones, and never removes a record twice", () => {
  const f = fixture({ limits: { terminalKeepPerRecipient: 2, terminalTtlMs: 1_000 } }), p = f.project(), a = f.bind(p), r = f.bind(p), epoch = f.epochOf(p), inbox = f.make();
  for (const n of [1, 2, 3]) inbox.accept(f.req(a, r, `t${n}`, `m${n}`));
  f.step(inbox, r, epoch); f.step(inbox, r, epoch); // m1 and m2 are delivered now
  f.advance(1_500);
  f.step(inbox, r, epoch); // m3 is delivered 1.5 s later
  expect(inbox.prune()).toBe(2); // m1 and m2 are past the TTL; m3 is fresh and within the keep
  expect(inbox.lookup(f.id(a, "m1"))).toBeUndefined();
  expect(inbox.lookup(f.id(a, "m2"))).toBeUndefined();
  expect(inbox.lookup(f.id(a, "m3"))!.state).toBe("delivered");
  expect(inbox.prune()).toBe(0);
});

test("disclosure of `archived` needs the same Project AND workspace: a record whose workspace differs gets the uniform not_found", () => {
  const f = fixture(), p = f.project(), q = f.project(), a = f.bind(p), archived = f.bind(p), inbox = f.make();
  f.setBinding(archived, "archived");
  expect(inbox.accept(f.req(a, archived, "x", "m1"))).toEqual({ outcome: "refused", reason: "recipient_archived" });
  // An inconsistent row (same project id, another workspace) must not be disclosed to: foreign keys off only to forge it.
  f.db.db.run("PRAGMA foreign_keys=OFF");
  f.db.db.run("UPDATE cowork_conversations SET workspace_id=? WHERE session_id=?", [q.workspaceId, archived]);
  expect(inbox.accept(f.req(a, archived, "x", "m2"))).toEqual({ outcome: "refused", reason: "not_found" });
});

test("the in-memory audit sees a torn record, a leaked body and an orphan body", () => {
  const state = createPeerInboxMemoryState(), store = new InMemoryPeerInboxStore(state);
  expect(store.audit()).toEqual(CLEAN);
  state.bodies.set("body_orphan", "left behind"); // an orphan body
  expect(store.audit()).toEqual({ ...CLEAN, orphanBodies: 1 });
  const f = fixture({ store }), p = f.project(), a = f.bind(p), r = f.bind(p), inbox = f.make();
  inbox.accept(f.req(a, r, "one", "m1")); inbox.accept(f.req(a, r, "two", "m2"));
  const [first, second] = f.store.unresolved(r);
  state.bodies.delete(first!.bodyHandle!); // a torn record: unresolved with no body
  state.records.set(second!.receiptId, { ...second!, state: "delivered" }); // a leaked body: terminal that still holds its handle
  expect(store.audit()).toEqual({ unresolvedWithoutBody: [first!.receiptId], terminalWithBody: [second!.receiptId], orphanBodies: 1 });
});

// ---------------------------------------------------------------- the store port contract

/** The in-memory store with a failure seam inside append, so the failure-atomicity cases are not vacuous. */
class FaultyMemoryStore extends InMemoryPeerInboxStore {
  private failAt = 0; private writes = 0;
  arm(step: number) { this.failAt = step; this.writes = 0; }
  protected override beforeWrite() { if (this.failAt > 0 && ++this.writes === this.failAt) { this.failAt = 0; throw new Error("injected write failure"); } }
}
for (const conformance of peerInboxStoreConformanceCases()) {
  test(`conformance (in-memory): ${conformance.name}`, () => {
    const root = new FaultyMemoryStore(createPeerInboxMemoryState());
    let last: FaultyMemoryStore = root;
    conformance.run({ open: () => (last = root.reopen()), failAppendAtStep: step => last.arm(step) });
  });
}

// ---------------------------------------------------------------- anti-wiring

const sourceDirectory = (...parts: string[]) => join(import.meta.dir, "..", "..", "..", ...parts);
function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile() && /\.(ts|tsx|js|mjs|cjs)$/.test(entry.name)).map(entry => join(entry.parentPath, entry.name));
}
test("anti-wiring: no src file imports the ledger, it has no barrel export, no SQLite table, no transport, and the in-memory store is its only implementation", () => {
  const packages = sourceDirectory(), module = join(packages, "core", "src", "cowork", "peer-inbox.ts");
  expect(existsSync(module)).toBe(true);
  const sources = readdirSync(packages, { withFileTypes: true }).filter(entry => entry.isDirectory() && existsSync(join(packages, entry.name, "src"))).flatMap(entry => sourceFiles(join(packages, entry.name, "src")));
  expect(sources.length).toBeGreaterThan(100); expect(sources).toContain(module);
  for (const file of sources.filter(candidate => candidate !== module)) {
    const text = readFileSync(file, "utf8");
    for (const needle of ["peer-inbox", "CoworkPeerInbox", "PeerInboxStore", "InMemoryPeerInboxStore", "PeerInboxRecord", "peerSendDigest", "PEER_INBOX_LIMITS", "isTerminalPeerState", "createPeerInboxMemoryState", "PeerInboxCaps", "PeerInboxAudit"])
      expect(`${basename(file)}:${needle}:${text.includes(needle)}`).toBe(`${basename(file)}:${needle}:false`);
    expect(text).not.toMatch(/implements\s+PeerInboxStore/);
  }
  expect(existsSync(join(packages, "core", "src", "cowork", "index.ts"))).toBe(false);
  expect(readFileSync(join(packages, "core", "src", "index.ts"), "utf8")).not.toMatch(/peer-inbox|from "\.\/cowork/);
  const own = readFileSync(module, "utf8");
  expect([...own.matchAll(/implements\s+PeerInboxStore/g)]).toHaveLength(1);
  expect(own).toContain("class InMemoryPeerInboxStore implements PeerInboxStore");
  // Only these three imports: the authority predicate, the shared types/errors and node:crypto. No repository, session table, driver, SDK or SQLite.
  expect([...own.matchAll(/from "([^"]+)"/g)].map(match => match[1]!).sort()).toEqual(["./messaging-authority", "./types", "node:crypto"]);
  const code = own.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\s\/\/ .*$/gm, ""); // comments may name what the module is NOT
  for (const forbidden of ["bun:sqlite", "CREATE TABLE", "cowork_peer", "session-messaging", "SessionMessaging", "@yanlinglabs", "daemon", "ensure(", "wake(", "resume("]) expect(`${forbidden}:${code.includes(forbidden)}`).toBe(`${forbidden}:false`);
  expect(Object.keys(peerInboxModule).sort()).toEqual(["CoworkPeerInbox", "InMemoryPeerInboxStore", "PEER_INBOX_LIMITS", "createPeerInboxMemoryState", "isTerminalPeerState", "peerSendDigest"]);
  // No table: the schema and the runtime-state DB do not mention the inbox at all.
  for (const file of [join(packages, "core", "src", "cowork", "schema.ts"), join(packages, "core", "src", "runtime-state", "db.ts")])
    expect(readFileSync(file, "utf8")).not.toMatch(/peer_inbox|peer-inbox|cowork_peer|PeerInbox/i);
});
