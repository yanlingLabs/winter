import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authorityFixtureSessions } from "./committed-sessions";
import { SessionMessaging, type MessagingDriverHandle } from "../../src/agent/session-messaging";
import { CoworkPeerInbox, type PeerEpoch } from "../../src/cowork/peer-inbox";
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
  const log: string[] = [];
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
    sends: string[] = []; steers: string[] = []; failNext: Error | undefined; epochOverride: PeerEpoch | null | undefined;
    constructor(readonly id: string) {}
    get coworkEpoch() { return this.epochOverride === null ? undefined : this.epochOverride ?? epochOf(this.id); }
    async send(text: string) { if (this.failNext) { const error = this.failNext; this.failNext = undefined; throw error; } this.sends.push(text); return { seq: 1, queued: this.turnRunning }; }
    async steer(text: string) { this.steers.push(text); return { seq: 1, injected: true }; }
  }
  const driverOf = (id: string) => { let d = drivers.get(id); if (!d) { d = new FakeDriver(id); drivers.set(id, d); } return d; };
  const ensured: string[] = [], ensureFault = { on: false };
  const makeMessaging = (inboxOptions: ConstructorParameters<typeof CoworkPeerInbox>[0]["limits"] | null = {}) => {
    const store = new SqlitePeerInboxStore(db);
    const peerInbox = inboxOptions === null ? undefined : new CoworkPeerInbox({ records, store, limits: inboxOptions });
    const spy = { accept: 0 };
    const wrapped = peerInbox && new Proxy(peerInbox, { get(target, prop, receiver) { if (prop === "accept") spy.accept++; const value = Reflect.get(target, prop, receiver); return typeof value === "function" ? value.bind(target) : value; } });
    const messaging = new SessionMessaging({
      cowork: records, ...(wrapped ? { peerInbox: wrapped } : {}),
      store: { meta: (id: string) => { const r = rows.get(id); if (!r) throw Error("missing"); return r; }, list: () => [...rows.values()] },
      derive: () => "active" as const, working: () => true,
      sessions: { get: (id: string) => { const d = drivers.get(id); return d && d.state === "live" ? d : d; }, ensure: async (id: string) => { ensured.push(id); if (ensureFault.on) throw new Error("cannot resume"); const d = driverOf(id); d.state = "live"; return d; } },
      log: (line) => log.push(line),
    });
    return { messaging, store, spy };
  };
  const first = makeMessaging();
  const send = (messaging: SessionMessaging, from: string, to: string, over: { message?: string; messageId?: string; incarnation?: string; summary?: string; notifyWhenIdle?: boolean } = {}) =>
    messaging.handlerFor(from, over.incarnation ?? "inc-1").send({ to: `session:${to}`, message: over.message ?? `${MARKER} please coordinate`, messageId: over.messageId ?? `m-${++sequence}`, ...(over.summary !== undefined ? { summary: over.summary } : {}), ...(over.notifyWhenIdle !== undefined ? { notifyWhenIdle: over.notifyWhenIdle } : {}) }, { signal: new AbortController().signal });
  const raw = () => db.db.query<{ receipt_id: string; state: string; reason: string | null; nobody: number }, []>("SELECT receipt_id, state, reason, body IS NULL AS nobody FROM cowork_peer_inbox ORDER BY accepted_at, sequence").all();
  return { home, db, records, rows, drivers, driverOf, ensured, ensureFault, log, project, bind, code, send, raw, makeMessaging, ...first };
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
  expect((await w.send(w.messaging, a, b)).status).toBe("delivered");
  expect(folding.steers).toHaveLength(1); expect(folding.sends).toEqual([]);
  const busy = w.driverOf(c); busy.turnRunning = true; busy.foldsQueuedInput = true; busy.pendingSends = ["the user's queued send"];
  const queued = await w.send(w.messaging, a, c);
  expect(queued.status).toBe("queued");
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
