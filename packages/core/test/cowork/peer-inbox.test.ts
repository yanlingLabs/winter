import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { CoworkRepository } from "../../src/cowork/repository";
import { CoworkError } from "../../src/cowork/types";
import { CoworkPeerInbox, InMemoryPeerInboxStore, PEER_INBOX_LIMITS, peerSendDigest, type CoworkPeerInboxOptions, type PeerEpoch, type PeerSendRequest } from "../../src/cowork/peer-inbox";
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

test("a damaged or missing body blocks fail-closed and nothing is delivered past it", () => {
  class DamagedStore extends InMemoryPeerInboxStore {
    mode: "ok" | "tampered" | "missing" = "ok";
    override readBody(handle: string) { return this.mode === "tampered" ? "tampered text" : this.mode === "missing" ? undefined : super.readBody(handle); }
  }
  const store = new DamagedStore(), f = fixture({ store }), p = f.project(), a = f.bind(p), r = f.bind(p), epoch = f.epochOf(p), inbox = f.make();
  inbox.accept(f.req(a, r, "first", "m1")); inbox.accept(f.req(a, r, "second", "m2"));
  for (const mode of ["tampered", "missing"] as const) {
    store.mode = mode;
    expect(inbox.offer(r, epoch)).toBeUndefined();
    const parked = inbox.lookup(f.id(a, "m1"))!;
    expect([parked.state, parked.reason, parked.attempts]).toEqual(["blocked", "recovery", 0]);
    expect(inbox.lookup(f.id(a, "m2"))!.attempts).toBe(0);
  }
  store.mode = "ok";
  expect(f.drain(inbox, r, epoch)).toEqual(["first", "second"]);
});

// ---------------------------------------------------------------- blocked, cancel, bounded retention

test("block parks a message visibly (host-only, not runnable) until an offer retries it; cancel is the only other exit", () => {
  const f = fixture(), p = f.project(), a = f.bind(p), r = f.bind(p), epoch = f.epochOf(p), inbox = f.make();
  inbox.accept(f.req(a, r, "one", "m1")); inbox.accept(f.req(a, r, "two", "m2")); inbox.accept(f.req(a, r, "three", "m3"));
  const offer = inbox.offer(r, epoch)!;
  const parked = inbox.block(offer.receipt.receiptId, "resources");
  expect([parked.state, parked.reason]).toEqual(["blocked", "resources"]);
  expect(f.store.get(parked.receiptId)!.offered).toBeNull();
  expect(inbox.owed(r)).toEqual({ runnable: 2, blocked: 1 });
  expect(codeOf(() => inbox.ack({ receiptId: parked.receiptId, recipientSessionId: r, epoch }))).toBe("stale_acknowledgment"); // nothing is offered while blocked
  expect(codeOf(() => inbox.block(parked.receiptId, "authority" as never))).toBe("invalid_request");

  // Strict FIFO: the blocked head is retried first and nothing is delivered past it.
  expect(f.drain(inbox, r, epoch)).toEqual(["one", "two", "three"]);
  expect(inbox.block(parked.receiptId, "grants").state).toBe("delivered"); // a late block cannot undo a terminal state

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
  expect(PEER_INBOX_LIMITS).toEqual({ maxMessageBytes: 65_536, maxUnresolvedPerRecipient: 256, terminalKeepPerRecipient: 100, terminalTtlMs: 86_400_000 });
});

test("malformed requests are invalid_request and persist nothing", () => {
  const f = fixture(), p = f.project(), a = f.bind(p), r = f.bind(p), inbox = f.make();
  const bad: PeerSendRequest[] = [
    f.req(a, r, "", "m1"), f.req("", r, "x", "m1"), f.req(a, "", "x", "m1"), f.req(a, r, "x", ""), f.req(a, r, "x", "m1", ""),
    f.req(a, r, "x", "line\nbreak"), f.req(a, r, "x".repeat(PEER_INBOX_LIMITS.maxMessageBytes + 1), "m2"), f.req(a, r, "x", "i".repeat(257)),
    { ...f.req(a, r, "x", "m3"), text: 7 as unknown as string },
  ];
  for (const request of bad) expect(codeOf(() => inbox.accept(request))).toBe("invalid_request");
  expect(inbox.accept(f.req(a, r, "x".repeat(PEER_INBOX_LIMITS.maxMessageBytes), "m4")).outcome).toBe("accepted");
  expect(codeOf(() => inbox.offer(r, { incarnationId: "", leaseEpoch: 1 }))).toBe("invalid_request");
  expect(codeOf(() => inbox.offer(r, { incarnationId: "boot", leaseEpoch: -1 }))).toBe("invalid_request");
  expect(f.store.recipients()).toEqual([r]);
  expect(f.store.unresolved(r)).toHaveLength(1);
});

// ---------------------------------------------------------------- the store port contract

for (const conformance of peerInboxStoreConformanceCases()) {
  test(`conformance (in-memory): ${conformance.name}`, () => {
    const base = new InMemoryPeerInboxStore();
    conformance.run({ open: () => base.reopen() });
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
    for (const needle of ["peer-inbox", "CoworkPeerInbox", "PeerInboxStore", "InMemoryPeerInboxStore", "PeerInboxRecord", "peerSendDigest", "PEER_INBOX_LIMITS", "isTerminalPeerState"])
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
  expect(Object.keys(peerInboxModule).sort()).toEqual(["CoworkPeerInbox", "InMemoryPeerInboxStore", "PEER_INBOX_LIMITS", "isTerminalPeerState", "peerSendDigest"]);
  // No table: the schema and the runtime-state DB do not mention the inbox at all.
  for (const file of [join(packages, "core", "src", "cowork", "schema.ts"), join(packages, "core", "src", "runtime-state", "db.ts")])
    expect(readFileSync(file, "utf8")).not.toMatch(/peer_inbox|peer-inbox|cowork_peer|PeerInbox/i);
});
