import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authorityFixtureSessions } from "./committed-sessions";
import { SessionMessaging, type MessagingDriverHandle } from "../../src/agent/session-messaging";
import { CoworkPeerInbox, type PeerEpoch } from "../../src/cowork/peer-inbox";
import { coworkHoldToken, CoworkHeldInputRefusal, type CoworkHeldInputVerbs } from "../../src/cowork/held-input";
import { coworkHeldInputReconciler } from "../../src/cowork/held-input-reconcile";
import { CoworkError } from "../../src/cowork/types";
import { SqlitePeerInboxStore } from "../../src/cowork/peer-inbox-sqlite";
import { CoworkRepository } from "../../src/cowork/repository";
import { openRuntimeStateDb, type RuntimeStateDb } from "../../src/runtime-state/db";
import type { SessionRow } from "../../src/sessions/store";

/*
 * Host-side wiring of the durable peer inbox into SessionMessaging, with fakes. Behind the refusal: no Cowork session can
 * be created yet, the daemon supplies no `peerInbox`, and these tests do NOT show guest-to-guest delivery (the first guest
 * profile withholds the message tools); they show the host ledger + store + a recipient driver seam (`coworkEpoch`).
 * Every literal is synthetic.
 */
const MARKER = "PEER-WIRING-BODY-MARKER-91c";
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) { try { cleanup(); } catch { /* best effort */ } } });

function world(existingHome?: string) {
  const home = existingHome ?? mkdtempSync(join(tmpdir(), "winter-peer-wiring-"));
  const db: RuntimeStateDb = openRuntimeStateDb(home), records = new CoworkRepository(db);
  cleanups.push(() => { db.close(); if (existingHome === undefined) rmSync(home, { recursive: true, force: true }); });
  const rows = new Map<string, SessionRow>(), drivers = new Map<string, FakeDriver>();
  const log: string[] = [], lostNotes: string[] = [];
  let sequence = 0;
  const context = () => ({ principalId: "fixture-user", requestId: `request-${++sequence}` });
  const row = (sessionId: string, mode: string) => rows.set(sessionId, { sessionId, mode, approvalPolicy: "auto", scope: "test", createdAt: 1, lastSeq: 0, title: sessionId });
  const project = () => {
    const created = records.create(context(), { ownership: "project", title: "Test", ceiling: { toolClasses: [], hostServices: [], connectors: [], network: "none" }, sources: [{ kind: "folder", label: "Fixture", access: "read-write", detail: { grantRef: "fixture-grant", rootIdentity: "fixture-root" } }] });
    const source = created.value.sources[0]!, epoch = records.beginIncarnation(created.workspaceId, `boot-${++sequence}`, created.revision);
    records.acknowledgeSource(epoch, source.sourceId, source.revision, "ready");
    return { workspaceId: created.workspaceId, sourceId: source.sourceId };
  };
  const bind = (workspace: ReturnType<typeof project>, id = `s_${++sequence}`) => {
    row(id, "cowork");
    records.bindConversation({ ...context(), expectedRevision: records.get(workspace.workspaceId).configRevision }, workspace.workspaceId, { sessionId: id, sourceId: workspace.sourceId }, authorityFixtureSessions(id));
    return id;
  };
  const code = () => { const id = `s_${++sequence}`; row(id, "code"); return id; };
  const epochOf = (id: string): PeerEpoch | undefined => { const workspace = records.get(records.binding(id).workspaceId); return workspace.incarnationId === null ? undefined : { incarnationId: workspace.incarnationId, leaseEpoch: workspace.leaseEpoch }; };
  class FakeDriver implements MessagingDriverHandle {
    turnRunning = false; foldsQueuedInput = false; pendingSends: string[] = []; state: "live" | "resumable" | "ended" = "live";
    heldInput: CoworkHeldInputVerbs | undefined; sends: string[] = []; attempts = 0; failAlways: Error | undefined; steers: string[] = []; failNext: Error | undefined; epochOverride: PeerEpoch | null | undefined;
    constructor(readonly id: string) {}
    get coworkEpoch() { return this.epochOverride === null ? undefined : this.epochOverride ?? epochOf(this.id); }
    async send(text: string) { this.attempts++; if (this.failAlways) throw this.failAlways; if (this.failNext) { const error = this.failNext; this.failNext = undefined; throw error; } this.sends.push(text); return { seq: 1, queued: this.turnRunning }; }
    async steer(text: string) { this.steers.push(text); return { seq: 1, injected: true }; }
  }
  const driverOf = (id: string) => { let d = drivers.get(id); if (!d) { d = new FakeDriver(id); drivers.set(id, d); } return d; };
  const ensured: string[] = [], ensureFault = { on: false };
  const makeMessaging = (inboxOptions: ConstructorParameters<typeof CoworkPeerInbox>[0]["limits"] | null = {}, override: Record<string, unknown> = {}) => {
    const store = new SqlitePeerInboxStore(db);
    const peerInbox = inboxOptions === null ? undefined : new CoworkPeerInbox({ records, store, limits: inboxOptions });
    const spy = { accept: 0 };
    const wrapped = peerInbox && new Proxy(peerInbox, { get(target, prop, receiver) { if (typeof prop === "string" && prop in override) return override[prop]; if (prop === "accept") spy.accept++; const value = Reflect.get(target, prop, receiver); return typeof value === "function" ? value.bind(target) : value; } });
    const messaging = new SessionMessaging({
      cowork: records, ...(wrapped ? { peerInbox: wrapped } : {}),
      store: { meta: (id: string) => { const r = rows.get(id); if (!r) throw Error("missing"); return r; }, list: () => [...rows.values()] },
      derive: () => "active" as const, working: () => true,
      sessions: { get: (id: string) => { const d = drivers.get(id); return d && d.state === "live" ? d : d; }, ensure: async (id: string) => { ensured.push(id); if (ensureFault.on) throw new Error("cannot resume"); const d = driverOf(id); d.state = "live"; return d; } },
      log: (line) => log.push(line), noteLostPeerMessage: (recipient, receiptId) => { lostNotes.push(`${recipient}:${receiptId}`); },
    });
    return { messaging, store, spy };
  };
  const first = makeMessaging();
  const send = (messaging: SessionMessaging, from: string, to: string, over: { message?: string; messageId?: string; incarnation?: string; summary?: string; notifyWhenIdle?: boolean } = {}) =>
    messaging.handlerFor(from, over.incarnation ?? "inc-1").send({ to: `session:${to}`, message: over.message ?? `${MARKER} please coordinate`, messageId: over.messageId ?? `m-${++sequence}`, ...(over.summary !== undefined ? { summary: over.summary } : {}), ...(over.notifyWhenIdle !== undefined ? { notifyWhenIdle: over.notifyWhenIdle } : {}) }, { signal: new AbortController().signal });
  const raw = () => db.db.query<{ receipt_id: string; state: string; reason: string | null; nobody: number }, []>("SELECT receipt_id, state, reason, body IS NULL AS nobody FROM cowork_peer_inbox ORDER BY accepted_at, sequence").all();
  return { home, db, records, rows, drivers, driverOf, ensured, ensureFault, log, lostNotes, project, bind, code, send, raw, makeMessaging, ...first };
}

test("a same-Project send is accepted, delivered to a stopped recipient (resumed), acknowledged, and the body is deleted", async () => {
  const w = world(), p = w.project(), a = w.bind(p), b = w.bind(p);
  const answer = await w.send(w.messaging, a, b, { summary: "sync", notifyWhenIdle: true });
  expect(answer.status).toBe("resumed_and_delivered");
  expect(w.ensured).toEqual([b]);
  const d = w.driverOf(b);
  expect(d.sends).toHaveLength(1); expect(d.sends[0]).toContain("<agent-message"); expect(d.sends[0]).toContain(`session:${a}`); expect(d.sends[0]).toContain(MARKER);
  expect(w.raw()).toEqual([expect.objectContaining({ state: "delivered", nobody: 1 })]); // purge at delivery
  expect(JSON.stringify([answer, w.log])).not.toContain(MARKER);
  expect((answer as { notify?: unknown }).notify).toBeDefined();
});

test("a running turn that folds takes the message by steer; one with its own queue ahead gets it queued behind, in order", async () => {
  const w = world(), p = w.project(), a = w.bind(p), b = w.bind(p), c = w.bind(p);
  const folding = w.driverOf(b); folding.turnRunning = true; folding.foldsQueuedInput = true;
  const steered = await w.send(w.messaging, a, b);
  expect(steered.status).toBe("delivered");
  expect((steered as { note: string }).note).toContain("after its current tool call, as part of the turn it is running"); // the steered note
  expect(folding.steers).toHaveLength(1); expect(folding.sends).toEqual([]);
  const busy = w.driverOf(c); busy.turnRunning = true; busy.foldsQueuedInput = true; busy.pendingSends = ["the user's queued send"];
  const queued = await w.send(w.messaging, a, c);
  expect(queued.status).toBe("queued");
  expect((queued as { note: string }).note).toContain("1 message queued ahead of yours");
  expect(busy.sends).toHaveLength(1); expect(busy.steers).toEqual([]);
  expect(w.raw().every(r => r.state === "delivered" && r.nobody === 1)).toBe(true);
});

test("a send to another Project is refused as not_found with no row, no wake and no effect", async () => {
  const w = world(), a = w.bind(w.project()), foreign = w.bind(w.project()), host = w.code();
  expect((await w.send(w.messaging, a, foreign)).status).toBe("not_found");
  expect((await w.send(w.messaging, a, host)).status).toBe("not_found");
  expect((await w.send(w.messaging, host, a)).status).toBe("not_found");
  expect(w.raw()).toEqual([]); expect(w.ensured).toEqual([]); expect(w.spy.accept).toBe(0);
});

test("a recipient driver with no epoch, or a stale one, leaves the message owed; the right epoch delivers it exactly once", async () => {
  const w = world(), p = w.project(), a = w.bind(p), b = w.bind(p);
  const d = w.driverOf(b); d.epochOverride = null;
  const first = await w.send(w.messaging, a, b);
  expect(first.status).toBe("queued"); expect((first as { note?: string }).note).toContain("pr_");
  expect(w.raw()).toEqual([expect.objectContaining({ state: "accepted", nobody: 0 })]);
  d.epochOverride = { incarnationId: "boot-from-the-past", leaseEpoch: 99 };
  await w.messaging.drainCoworkInbox(b);
  expect(d.sends).toEqual([]); expect(w.raw()[0]!.state).toBe("accepted");
  d.epochOverride = undefined;
  await w.messaging.drainCoworkInbox(b); await w.messaging.drainCoworkInbox(b);
  expect(d.sends).toHaveLength(1);
  expect(w.raw()).toEqual([expect.objectContaining({ state: "delivered", nobody: 1 })]);
});

test("delivery survives a restart: a fresh messaging over a fresh store on the same home delivers the owed message once, with summary and notify intact", async () => {
  const w = world(), p = w.project(), a = w.bind(p), b = w.bind(p);
  w.driverOf(b).epochOverride = null;
  expect((await w.send(w.messaging, a, b, { messageId: "m-restart", summary: "the summary", notifyWhenIdle: true, message: `${MARKER} owed across restart` })).status).toBe("queued");
  w.db.close();
  const reopened = world(w.home); // the same database file, new connections, new objects
  for (const id of [a, b]) reopened.rows.set(id, w.rows.get(id)!);
  reopened.driverOf(b);
  await reopened.messaging.drainCoworkInbox(b);
  const d = reopened.driverOf(b);
  expect(d.sends).toHaveLength(1); expect(d.sends[0]).toContain("owed across restart"); expect(d.sends[0]).toContain("the summary");
  expect(reopened.raw()).toEqual([expect.objectContaining({ state: "delivered", nobody: 1 })]);
  await reopened.messaging.drainCoworkInbox(b);
  expect(d.sends).toHaveLength(1);
});

test("a retried send identity returns the retained receipt without a second delivery; reusing the id for other text is refused", async () => {
  const w = world(), p = w.project(), a = w.bind(p), b = w.bind(p);
  expect((await w.send(w.messaging, a, b, { messageId: "same" })).status).toBe("resumed_and_delivered");
  const other = w.makeMessaging(); // no process-local dedupe: only the ledger remembers
  const retried = await w.send(other.messaging, a, b, { messageId: "same" });
  expect(retried.status).toBe("delivered");
  expect(w.driverOf(b).sends).toHaveLength(1); expect(w.raw()).toHaveLength(1);
  expect((await w.send(other.messaging, a, b, { messageId: "same", message: "something else" })).status).toBe("refused");
  expect(w.driverOf(b).sends).toHaveLength(1);
  // a restarted sender (new incarnation) replaying `same` is a NEW message
  expect((await w.send(other.messaging, a, b, { messageId: "same", incarnation: "inc-2" })).status).toBe("delivered");
  expect(w.driverOf(b).sends).toHaveLength(2);
});

test("a sender with no runtime incarnation is refused and persists nothing", async () => {
  const w = world(), p = w.project(), a = w.bind(p), b = w.bind(p);
  const refusal = await w.send(w.messaging, a, b, { incarnation: "" });
  expect(refusal.status).toBe("refused"); expect((refusal as { reason: string }).reason).toContain("runtime identity");
  expect(w.raw()).toEqual([]); expect(w.ensured).toEqual([]);
});

test("without an injected peer inbox a Cowork pair fails closed: unavailable, nothing delivered, nothing woken", async () => {
  const w = world(), p = w.project(), a = w.bind(p), b = w.bind(p);
  const bare = w.makeMessaging(null);
  const answer = await w.send(bare.messaging, a, b);
  expect(answer).toMatchObject({ status: "unavailable", retryable: false }); // the explicit fail-closed answer, not a caught accept() fault
  expect(w.ensured).toEqual([]); expect(w.raw()).toEqual([]);
});

test("two concurrent sends to one recipient are each delivered exactly once, in acceptance order", async () => {
  const w = world(), p = w.project(), a = w.bind(p), b = w.bind(p), c = w.bind(p);
  const [x, y] = await Promise.all([w.send(w.messaging, a, b, { message: "first-from-a" }), w.send(w.messaging, c, b, { message: "second-from-c" })]);
  expect([x.status, y.status].every(s => s === "resumed_and_delivered" || s === "delivered")).toBe(true);
  const sends = w.driverOf(b).sends;
  expect(sends).toHaveLength(2);
  expect(sends[0]).toContain("first-from-a"); expect(sends[1]).toContain("second-from-c");
  expect(w.raw().every(r => r.state === "delivered")).toBe(true);
});

test("a delivery that throws leaves the message owed and unacknowledged; the next drain delivers it", async () => {
  const w = world(), p = w.project(), a = w.bind(p), b = w.bind(p);
  const d = w.driverOf(b); d.failNext = new Error(`boom ${MARKER}`);
  const answer = await w.send(w.messaging, a, b);
  expect(answer.status).toBe("queued");
  expect(w.raw()).toEqual([expect.objectContaining({ state: "accepted", nobody: 0 })]);
  expect(w.log.join("\n")).not.toContain(MARKER);
  await w.messaging.drainCoworkInbox(b);
  expect(d.sends).toHaveLength(1); expect(w.raw()[0]!.nobody).toBe(1);
});

test("an archived recipient is refused at accept (no row, no wake); a revoked sender is parked, never delivered", async () => {
  const w = world(), p = w.project(), a = w.bind(p), b = w.bind(p);
  w.db.db.run("UPDATE cowork_conversations SET state='archived' WHERE session_id=?", [b]);
  expect((await w.send(w.messaging, a, b)).status).toBe("not_found"); // resolveTarget already hides what the sender may not reach
  expect(w.raw()).toEqual([]); expect(w.ensured).toEqual([]);
  w.db.db.run("UPDATE cowork_conversations SET state='active' WHERE session_id=?", [b]);
  w.driverOf(b).epochOverride = null;
  expect((await w.send(w.messaging, a, b)).status).toBe("queued");
  w.db.db.run("UPDATE cowork_conversations SET state='archived' WHERE session_id=?", [a]);
  w.driverOf(b).epochOverride = undefined;
  await w.messaging.drainCoworkInbox(b);
  expect(w.driverOf(b).sends).toEqual([]);
  expect(w.raw()).toEqual([expect.objectContaining({ state: "blocked", reason: "authority", nobody: 0 })]);
});

test("the inbox caps refuse as retryable-unavailable and persist nothing", async () => {
  const w = world(), p = w.project(), a = w.bind(p), b = w.bind(p);
  const tight = w.makeMessaging({ maxUnresolvedPerSenderRecipient: 1 });
  w.driverOf(b).epochOverride = null;
  expect((await w.send(tight.messaging, a, b)).status).toBe("queued");
  const full = await w.send(tight.messaging, a, b);
  expect(full.status).toBe("unavailable");
  expect(w.raw()).toHaveLength(1);
});

test("Code and Dispatch messaging never touch the inbox", async () => {
  const w = world(), x = w.code(), y = w.code();
  const answer = await w.send(w.messaging, x, y);
  expect(answer.status).toBe("resumed_and_delivered");
  expect(w.driverOf(y).sends).toHaveLength(1);
  expect(w.spy.accept).toBe(0); expect(w.raw()).toEqual([]);
});

test("nothing is woken when nothing runnable is owed: a parked message does not resume a stopped recipient", async () => {
  const w = world(), p = w.project(), a = w.bind(p), b = w.bind(p);
  w.ensureFault.on = true; // the recipient cannot be resumed now, so the message stays owed
  expect((await w.send(w.messaging, a, b)).status).toBe("queued");
  w.db.db.run("UPDATE cowork_conversations SET state='archived' WHERE session_id=?", [a]); // the sender is revoked
  w.ensureFault.on = false; w.ensured.length = 0;
  await w.messaging.drainCoworkInbox(b);
  expect(w.ensured).toEqual([]); expect(w.driverOf(b).sends).toEqual([]);
  expect(w.raw()).toEqual([expect.objectContaining({ state: "blocked", reason: "authority" })]);
});

test("a stored body that is not a valid envelope is damage: parked blocked/recovery, never delivered as text", async () => {
  const w = world(), p = w.project(), a = w.bind(p), b = w.bind(p);
  const ledger = new CoworkPeerInbox({ records: w.records, store: new SqlitePeerInboxStore(w.db) });
  expect(ledger.accept({ senderSessionId: a, senderIncarnation: "inc-1", sendId: "raw", recipientSessionId: b, text: `${MARKER} plain text, not an envelope` }).outcome).toBe("accepted");
  await w.messaging.drainCoworkInbox(b);
  expect(w.driverOf(b).sends).toEqual([]); expect(w.driverOf(b).steers).toEqual([]);
  expect(w.raw()).toEqual([expect.objectContaining({ state: "blocked", reason: "recovery", nobody: 0 })]);
});

test("a runtime that is replaced on every push is retried exactly once under the successor, then the message stays owed (no endless loop)", async () => {
  const w = world(), p = w.project(), a = w.bind(p), b = w.bind(p);
  const d = w.driverOf(b); d.failAlways = Object.assign(new Error("replaced"), { code: "session_replaced" });
  const answer = await w.send(w.messaging, a, b);
  expect(d.attempts).toBe(2); // the push and ONE retry
  expect(answer.status).toBe("queued");
  expect(w.raw()).toEqual([expect.objectContaining({ state: "accepted", nobody: 0 })]);
  await w.messaging.drainCoworkInbox(b);
  expect(d.attempts).toBe(4); // each later drain makes the same bounded two attempts
});

test.each([
  ["a different envelope version", JSON.stringify({ v: 2, message: "from the future", notifyWhenIdle: false })],
  ["a non-boolean notifyWhenIdle", JSON.stringify({ v: 1, message: "damaged", notifyWhenIdle: "yes" })],
  ["a non-string summary", JSON.stringify({ v: 1, message: "damaged", summary: 7, notifyWhenIdle: false })],
  ["a blank message", JSON.stringify({ v: 1, message: "  ", notifyWhenIdle: false })],
])("%s is damage: parked blocked/recovery, nothing delivered, and nothing behind it is delivered past it", async (_name, body) => {
  const w = world(), p = w.project(), a = w.bind(p), b = w.bind(p), c = w.bind(p);
  const ledger = new CoworkPeerInbox({ records: w.records, store: new SqlitePeerInboxStore(w.db) });
  expect(ledger.accept({ senderSessionId: a, senderIncarnation: "inc-1", sendId: "bad", recipientSessionId: b, text: body }).outcome).toBe("accepted");
  const behind = await w.send(w.messaging, c, b, { message: "a good message behind the damaged head" });
  expect(behind.status).toBe("queued");
  const d = w.driverOf(b);
  expect(d.sends).toEqual([]); expect(d.steers).toEqual([]);
  expect(w.raw().map(r => [r.state, r.reason, r.nobody])).toEqual([["blocked", "recovery", 0], ["accepted", null, 0]]);
});

test("an acknowledgement that keeps failing stops the drain: the message is pushed once per drain, never re-pushed in a loop", async () => {
  const w = world(), p = w.project(), a = w.bind(p), b = w.bind(p);
  const failing = w.makeMessaging({}, { ack: () => { throw new CoworkError("stale_acknowledgment"); } });
  const answer = await w.send(failing.messaging, a, b);
  expect(answer.status).toBe("queued");
  expect(w.driverOf(b).sends).toHaveLength(1); // pushed once, ack failed, loop stopped
  expect(w.raw()).toEqual([expect.objectContaining({ state: "accepted", nobody: 0 })]);
  await failing.messaging.drainCoworkInbox(b);
  expect(w.driverOf(b).sends).toHaveLength(2); // one push per drain (at-least-once), never a loop inside one
});


// ------------------------------------------------------------------------------------------------ #92 4.5: held-input delivery
type Call = [verb: string, ...args: unknown[]];
/** A held-input guest, scripted: every verb is recorded, and each can be made to fail or answer otherwise. */
function heldGuest(calls: Call[], script: { hold?: () => unknown; commit?: (inputId: string) => unknown; discard?: () => unknown } = {}): CoworkHeldInputVerbs {
  return {
    async hold(input) { calls.push(["hold", input.inputId, input.holdToken, input.text]); return (script.hold?.() ?? { held: true }) as never; },
    async commit(inputId, token) { calls.push(["commit", inputId, token]); const r = script.commit?.(inputId); if (r instanceof Error) throw r; return (r ?? { outcome: "queued" }) as never; },
    async discard(inputId, token) { calls.push(["discard", inputId, token]); const r = script.discard?.(); if (r instanceof Error) throw r; return { discarded: true }; },
    async forget(inputId, token) { calls.push(["forget", inputId, token]); return { forgotten: true }; },
  };
}
const held = (w: ReturnType<typeof world>, id: string, calls: Call[], script?: Parameters<typeof heldGuest>[1]) => { const d = w.driverOf(id); d.heldInput = heldGuest(calls, script); return d; };
const row = (w: ReturnType<typeof world>, receiptId?: string) => w.db.db.query<Record<string, unknown>, []>(`SELECT receipt_id, state, reason, offer_count, acked_hold_token, commit_confirmed_at, commit_outcome, body IS NULL AS nobody FROM cowork_peer_inbox ${receiptId ? `WHERE receipt_id='${receiptId}'` : ""} ORDER BY sequence`).all();

test("held delivery: hold, then ack (stores the token), then commit (confirms the outcome); deliverInto is never used", async () => {
  const w = world(), p = w.project(), a = w.bind(p), b = w.bind(p), calls: Call[] = [];
  const d = held(w, b, calls);
  const answer = await w.send(w.messaging, a, b);
  expect(calls.map(c => c[0])).toEqual(["hold", "commit", "forget"]);
  const [record] = row(w) as Array<Record<string, any>>;
  const epoch = d.coworkEpoch!;
  const token = coworkHoldToken(record!.receipt_id, epoch.incarnationId, epoch.leaseEpoch, 1);
  expect(calls[0]).toEqual(["hold", record!.receipt_id, token, expect.stringContaining("<agent-message")]);
  expect(record).toMatchObject({ state: "delivered", offer_count: 1, acked_hold_token: token, commit_outcome: "queued", nobody: 1 });
  expect(record!.commit_confirmed_at).not.toBeNull();
  expect(d.sends).toEqual([]); expect(d.steers).toEqual([]);
  expect(answer.status).toBe("queued");
});

test("held delivery: a lost commit answer leaves the receipt delivered-unconfirmed; the next drain re-commits it FIRST, under the stored token, before anything newer is offered", async () => {
  const w = world(), p = w.project(), a = w.bind(p), b = w.bind(p), calls: Call[] = [];
  let failures = 1;
  held(w, b, calls, { commit: () => (failures-- > 0 ? new Error("transport lost") : undefined) });
  await w.send(w.messaging, a, b, { messageId: "m1" });
  const [first] = row(w) as Array<Record<string, any>>;
  expect(first).toMatchObject({ state: "delivered", commit_outcome: null, commit_confirmed_at: null });
  expect(w.records).toBeDefined();
  // A second message arrives: the drain repairs the first commit before it offers the second.
  calls.length = 0;
  await w.send(w.messaging, a, b, { messageId: "m2" });
  expect(calls.map(c => `${c[0]}:${c[1] === first!.receipt_id ? "first" : "second"}`)).toEqual(["commit:first", "forget:first", "hold:second", "commit:second", "forget:second"]);
  expect(calls[0]![2]).toBe(first!.acked_hold_token);
  expect((row(w) as Array<Record<string, any>>).map(r => r.commit_outcome)).toEqual(["queued", "queued"]);
});

test("held delivery: while a commit stays unconfirmed nothing newer is offered", async () => {
  const w = world(), p = w.project(), a = w.bind(p), b = w.bind(p), calls: Call[] = [];
  let down = true;
  held(w, b, calls, { commit: () => (down ? new Error("transport lost") : undefined) });
  await w.send(w.messaging, a, b, { messageId: "m1" });
  calls.length = 0;
  await w.send(w.messaging, a, b, { messageId: "m2" });
  expect(calls.map(c => c[0])).toEqual(["commit"]); // the repair failed, so no hold of the second
  expect((row(w) as Array<Record<string, any>>).map(r => r.state)).toEqual(["delivered", "accepted"]);
  down = false;
  await w.messaging.drainCoworkInbox(b);
  expect((row(w) as Array<Record<string, any>>).map(r => [r.state, r.commit_outcome])).toEqual([["delivered", "queued"], ["delivered", "queued"]]);
});

test("held delivery: unknown_input is terminal (lost, never retried) and later messages still flow", async () => {
  const w = world(), p = w.project(), a = w.bind(p), b = w.bind(p), calls: Call[] = [];
  let first = true;
  held(w, b, calls, { commit: () => { if (first) { first = false; return new CoworkHeldInputRefusal("unknown_input"); } return undefined; } });
  await w.send(w.messaging, a, b, { messageId: "m1" });
  await w.send(w.messaging, a, b, { messageId: "m2" });
  const rows = row(w) as Array<Record<string, any>>;
  expect(rows.map(r => [r.state, r.commit_outcome])).toEqual([["delivered", "lost"], ["delivered", "queued"]]);
  expect(calls.filter(c => c[0] === "commit")).toHaveLength(2); // the lost one was committed once, never again
  expect(w.lostNotes).toEqual([`${b}:${rows[0]!.receipt_id}`]); // surfaced once, through the composition's note port
});

test("held delivery: authority_denied at the ack discards the hold and delivers nothing; a re-grant would re-offer", async () => {
  const w = world(), p = w.project(), a = w.bind(p), b = w.bind(p), calls: Call[] = [];
  held(w, b, calls);
  const { messaging } = w.makeMessaging({}, { ack: () => { throw new CoworkError("authority_denied"); } });
  await w.send(messaging, a, b);
  expect(calls.map(c => c[0])).toEqual(["hold", "discard"]);
  expect(calls[1]![2]).toBe(calls[0]![2]); // the token of THAT hold
  expect(row(w)[0]).toMatchObject({ state: "accepted", acked_hold_token: null, commit_outcome: null, nobody: 0 });
});

test("held delivery: any other ack throw reads the verdict: not landed discards; landed commits under the stored token; an unreadable verdict decides nothing", async () => {
  // Not landed.
  const w = world(), p = w.project(), a = w.bind(p), b = w.bind(p), calls: Call[] = [];
  held(w, b, calls);
  await w.send(w.makeMessaging({}, { ack: () => { throw new Error("disk full"); } }).messaging, a, b);
  expect(calls.map(c => c[0])).toEqual(["hold", "discard"]);
  expect(row(w)[0]).toMatchObject({ state: "accepted", acked_hold_token: null });
  // Landed, but the answer was lost.
  const l = world(), lp = l.project(), la = l.bind(lp), lb = l.bind(lp), landed: Call[] = [];
  held(l, lb, landed);
  const real = new CoworkPeerInbox({ records: l.records, store: new SqlitePeerInboxStore(l.db) });
  await l.send(l.makeMessaging({}, { ack: (request: Parameters<CoworkPeerInbox["ack"]>[0]) => { real.ack(request); throw new Error("answer lost"); } }).messaging, la, lb);
  expect(landed.map(c => c[0])).toEqual(["hold", "commit", "forget"]);
  const [r] = row(l) as Array<Record<string, any>>;
  expect(landed[1]![2]).toBe(r!.acked_hold_token);
  expect(r).toMatchObject({ state: "delivered", commit_outcome: "queued" });
  // The verdict is unreadable too: nothing is decided (no commit, no discard).
  const u = world(), up = u.project(), ua = u.bind(up), ub = u.bind(up), undecided: Call[] = [];
  held(u, ub, undecided);
  await u.send(u.makeMessaging({}, { ack: () => { throw new Error("disk full"); }, verdict: () => { throw new Error("unreadable"); } }).messaging, ua, ub);
  expect(undecided.map(c => c[0])).toEqual(["hold"]);
});

test("held delivery: a hold answered {held: false} is acked and confirmed already (no commit), and never discarded even when the ack fails", async () => {
  const w = world(), p = w.project(), a = w.bind(p), b = w.bind(p), calls: Call[] = [];
  held(w, b, calls, { hold: () => ({ held: false, state: "committed" }) });
  await w.send(w.makeMessaging({}, { ack: () => { throw new CoworkError("authority_denied"); } }).messaging, a, b);
  expect(calls.map(c => c[0])).toEqual(["hold"]); // no discard of an input the guest already owns
  const ok = world(), op = ok.project(), oa = ok.bind(op), ob = ok.bind(op), okCalls: Call[] = [];
  held(ok, ob, okCalls, { hold: () => ({ held: false, state: "in_transcript" }), commit: () => ({ outcome: "already" }) });
  await ok.send(ok.messaging, oa, ob);
  expect(okCalls.map(c => c[0])).toEqual(["hold"]); // acked and confirmed `already`: NO commit under the new token
  expect(row(ok)[0]).toMatchObject({ state: "delivered", commit_outcome: "already", nobody: 1 });
  expect((row(ok)[0] as Record<string, any>).acked_hold_token).not.toBeNull();
});

test("the ledger: verdict, confirmCommitted and the prune guard", async () => {
  const w = world(), p = w.project(), a = w.bind(p), b = w.bind(p), c = w.bind(w.project()), calls: Call[] = [];
  let now = Date.now();
  const inbox = new CoworkPeerInbox({ records: w.records, store: new SqlitePeerInboxStore(w.db), now: () => now });
  held(w, b, calls, { commit: () => new Error("down") });
  const { messaging } = w.makeMessaging({}, {});
  await w.send(messaging, a, b);
  const [delivered] = row(w) as Array<Record<string, any>>;
  expect(inbox.verdict(delivered!.receipt_id, b)).toEqual({ action: "commit", ackedHoldToken: delivered!.acked_hold_token });
  expect(inbox.verdict(delivered!.receipt_id, c)).toEqual({ action: "discard" }); // another recipient's id
  expect(inbox.verdict("pr_unknown", b)).toEqual({ action: "discard" });
  expect(inbox.deliveredUnconfirmed(b)).toEqual([{ receiptId: delivered!.receipt_id, ackedHoldToken: delivered!.acked_hold_token }]);
  // Far past the retention: an unconfirmed delivered record is never pruned.
  now += 10 * 24 * 3_600_000;
  expect(inbox.prune(b)).toBe(0);
  expect(row(w)).toHaveLength(1);
  inbox.confirmCommitted(delivered!.receipt_id, "folded");
  inbox.confirmCommitted(delivered!.receipt_id, "queued"); // idempotent: the first outcome stays
  expect(row(w)[0]).toMatchObject({ commit_outcome: "folded" });
  expect(inbox.deliveredUnconfirmed(b)).toEqual([]);
  expect(inbox.prune(b)).toBe(1);
  expect(() => inbox.confirmCommitted("pr_unknown", "folded")).toThrow("not_found");
  expect(() => inbox.confirmCommitted(delivered!.receipt_id, "bogus" as never)).toThrow("invalid_request");
  // A delivery that recorded no hold token (the non-held path) is not a held input.
  const plain = world(), pp = plain.project(), pa = plain.bind(pp), pb = plain.bind(pp);
  await plain.send(plain.messaging, pa, pb);
  const ledger = new CoworkPeerInbox({ records: plain.records, store: new SqlitePeerInboxStore(plain.db) });
  const [done] = row(plain) as Array<Record<string, any>>;
  expect(() => ledger.confirmCommitted(done!.receipt_id, "folded")).toThrow("invalid_request");
  expect(ledger.verdict(done!.receipt_id, pb)).toEqual({ action: "discard" });
  expect(ledger.deliveredUnconfirmed(pb)).toEqual([]);
});

test("reconciliation before the epoch: held entries get the ledger's verdict, committed ones are only confirmed, a verdict that cannot be read throws", async () => {
  const w = world(), p = w.project(), a = w.bind(p), b = w.bind(p), calls: Call[] = [];
  held(w, b, calls, { commit: () => new Error("down") });
  await w.send(w.messaging, a, b);                       // delivered, unconfirmed (the commit never answered)
  const [delivered] = row(w) as Array<Record<string, any>>;
  const accepted = w.makeMessaging({}, { ack: () => { throw new Error("no ack") } });
  await w.send(accepted.messaging, a, b, { messageId: "m2" }); // accepted only: its hold was discarded, a stale one is reported
  const [, pending] = row(w) as Array<Record<string, any>>;
  const inbox = new CoworkPeerInbox({ records: w.records, store: new SqlitePeerInboxStore(w.db) });
  const guest: Call[] = [];
  const verbs = heldGuest(guest);
  const reconcile = coworkHeldInputReconciler(inbox);
  const entry = (inputId: string, holdToken: string, state: "held" | "committed" | "in_transcript") => ({ inputId, digest: "a".repeat(64), holdToken, state });
  await reconcile({ sessionId: b, epoch: { incarnationId: "i", leaseEpoch: 1 }, verbs, inputs: [entry(delivered!.receipt_id, "c".repeat(64), "held"), entry(pending!.receipt_id, "d".repeat(64), "held"), entry("pr_stranger", "e".repeat(64), "held")] });
  expect(guest).toEqual([
    ["commit", delivered!.receipt_id, delivered!.acked_hold_token], ["forget", delivered!.receipt_id, delivered!.acked_hold_token],
    ["discard", pending!.receipt_id, "d".repeat(64)], ["discard", "pr_stranger", "e".repeat(64)],
  ]);
  expect((row(w, delivered!.receipt_id)[0] as Record<string, unknown>).commit_outcome).toBe("queued");
  // A committed/in_transcript entry for a receipt the ledger lists unconfirmed is only confirmed.
  const again = world(), ap = again.project(), aa = again.bind(ap), ab = again.bind(ap);
  held(again, ab, [], { commit: () => new Error("down") });
  await again.send(again.messaging, aa, ab);
  const [d2] = row(again) as Array<Record<string, any>>;
  const inbox2 = new CoworkPeerInbox({ records: again.records, store: new SqlitePeerInboxStore(again.db) });
  const guest2: Call[] = [];
  await coworkHeldInputReconciler(inbox2)({ sessionId: ab, epoch: { incarnationId: "i", leaseEpoch: 1 }, verbs: heldGuest(guest2), inputs: [entry(d2!.receipt_id, d2!.acked_hold_token, "in_transcript")] });
  expect(guest2.map(c => c[0])).toEqual(["forget"]);
  expect(row(again)[0]).toMatchObject({ commit_outcome: "already" });
  // An unreadable verdict throws, so the driver never publishes the epoch.
  const broken = { deliveredUnconfirmed: () => [], confirmCommitted: () => undefined, verdict: () => { throw new Error("unreadable"); } };
  await expect(coworkHeldInputReconciler(broken as never)({ sessionId: b, epoch: { incarnationId: "i", leaseEpoch: 1 }, verbs, inputs: [entry("pr_x", "f".repeat(64), "held")] })).rejects.toThrow("unreadable");
});

test("a Cowork caller's host-messaging answers go through the DOOR validators; a malformed one is delivery_uncertain, a malformed list is empty", async () => {
  const w = world(), p = w.project(), a = w.bind(p), b = w.bind(p), host = w.code();
  const messaging = w.messaging as unknown as { send: unknown; list: unknown };
  const realSend = messaging.send, realList = messaging.list;
  messaging.send = async () => ({ status: "bogus" });
  messaging.list = () => ({ sessions: [{ address: "", status: "idle", mode: "cowork" }] });
  expect(await w.messaging.handlerFor(a, "inc-1").send({ to: `session:${b}`, message: "x", messageId: "m" } as never, {} as never)).toMatchObject({ status: "delivery_uncertain", retryable: false });
  expect(await w.messaging.handlerFor(a, "inc-1").list({} as never, {} as never)).toEqual({ sessions: [] });
  // A Code caller's answers are passed through untouched.
  expect(await w.messaging.handlerFor(host, "inc-1").send({ to: `session:${b}`, message: "x", messageId: "m" } as never, {} as never)).toEqual({ status: "bogus" } as never);
  messaging.send = realSend; messaging.list = realList;
  expect((await w.messaging.handlerFor(a, "inc-1").list({} as never, {} as never)).sessions.length).toBeGreaterThanOrEqual(0);
});

test("held delivery: a commit the guest keeps refusing (superseded) ends as lost after a bounded count, is surfaced once, and the queue flows", async () => {
  const w = world(), p = w.project(), a = w.bind(p), b = w.bind(p), calls: Call[] = [];
  let refuse = true;
  held(w, b, calls, { commit: id => (refuse && calls.filter(c => c[0] === "commit" && c[1] === id).length <= 3 ? new CoworkHeldInputRefusal("superseded") : undefined) });
  await w.send(w.messaging, a, b, { messageId: "m1" });
  const [first] = row(w) as Array<Record<string, any>>;
  expect(first).toMatchObject({ state: "delivered", commit_outcome: null });
  await w.messaging.drainCoworkInbox(b);
  expect((row(w)[0] as Record<string, any>).commit_outcome).toBeNull();
  await w.messaging.drainCoworkInbox(b);     // the third refusal
  expect(row(w)[0]).toMatchObject({ commit_outcome: "lost" });
  expect(w.lostNotes).toEqual([`${b}:${first!.receipt_id}`]);
  const commitsBefore = calls.filter(c => c[0] === "commit").length;
  refuse = false;
  await w.send(w.messaging, a, b, { messageId: "m2" });
  expect((row(w) as Array<Record<string, any>>).map(r => r.commit_outcome)).toEqual(["lost", "queued"]);
  expect(calls.filter(c => c[0] === "commit" && c[1] === first!.receipt_id)).toHaveLength(commitsBefore); // never retried
  // A transport error is not a refusal: it retries without ever ending the receipt.
  const t = world(), tp = t.project(), ta = t.bind(tp), tb = t.bind(tp);
  held(t, tb, [], { commit: () => new Error("down") });
  await t.send(t.messaging, ta, tb);
  for (let i = 0; i < 6; i++) await t.messaging.drainCoworkInbox(tb);
  expect(row(t)[0]).toMatchObject({ commit_outcome: null });
  expect(t.lostNotes).toEqual([]);
});

test("the reconcile confirms only entries the ledger lists as unconfirmed", async () => {
  const w = world(), p = w.project(), a = w.bind(p), b = w.bind(p), c = w.bind(p);
  held(w, b, [], { commit: () => new Error("down") });
  await w.send(w.messaging, a, b, { messageId: "m1" });             // delivered, unconfirmed
  held(w, c, []);
  await w.send(w.messaging, a, c, { messageId: "m2" });             // delivered AND confirmed (another recipient)
  const inbox = new CoworkPeerInbox({ records: w.records, store: new SqlitePeerInboxStore(w.db) });
  const [unconfirmed, confirmed] = row(w) as Array<Record<string, any>>;
  const guest: Call[] = [];
  const entry = (inputId: string, holdToken: string, state: "committed" | "in_transcript") => ({ inputId, digest: "a".repeat(64), holdToken, state });
  await coworkHeldInputReconciler(inbox)({ sessionId: b, epoch: { incarnationId: "i", leaseEpoch: 1 }, verbs: heldGuest(guest),
    inputs: [entry(confirmed!.receipt_id, "c".repeat(64), "in_transcript"), entry("pr_stranger", "d".repeat(64), "in_transcript"), entry(unconfirmed!.receipt_id, unconfirmed!.acked_hold_token, "committed")] });
  expect(guest).toEqual([]);                                         // nothing forgotten: only the unconfirmed one was confirmed
  expect(row(w, unconfirmed!.receipt_id)[0]).toMatchObject({ commit_outcome: "already" });
  expect(row(w, confirmed!.receipt_id)[0]).toMatchObject({ commit_outcome: "queued" }); // untouched
});
