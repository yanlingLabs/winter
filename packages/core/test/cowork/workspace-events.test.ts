import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOST_WORKSPACE_EVENT_TYPES, SessionEvent, LineDecoder, ConnWriter, PROTOCOL_VERSION, encodeLine, type WritableSocket } from "@yanlinglabs/winter-protocol";
import { openRuntimeStateDb } from "../../src/runtime-state/db";
import { CoworkRepository } from "../../src/cowork/repository";
import { CoworkWorkspaceService, type CoworkHostPorts } from "../../src/cowork/service";
import { CoworkWorkspaceEvents, workspaceEventInput } from "../../src/cowork/workspace-events";
import { SessionStore } from "../../src/sessions/store";
import { SessionHub } from "../../src/sessions/hub";
import { readHistoryPage } from "../../src/sessions/history";
import { filterRemoteStreamEvent } from "../../src/sessions/remote-stream";
import { PROJECTED_EVENT_COVERAGE, SUBAGENT_TRANSCRIPT_INCLUDE } from "../../src/projector/event-coverage";
import { accept, makeProjector } from "../projector/harness";
import { syncPush, SyncPushBuffers } from "../../src/ipc/sync";
import { startIpcServer } from "../../src/ipc/server";
import { TokenAuthority } from "../../src/auth/tokens";
import { FileSecretStore } from "../../src/auth/secret-store";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const close of cleanups.splice(0).reverse()) close(); });
const ceiling = { toolClasses: ["read", "write"], hostServices: [], connectors: [], network: "none" as const };
const selection = { kind: "folder" as const, label: "private /Users/hidden/root bearer-secret", access: "read-write" as const,
  detail: { grantRef: "grant-one", rootIdentity: "private-host-path-token" } };
const context = (requestId: string, expectedRevision?: number) => ({ principalId: "user-one", requestId, expectedRevision });
function fixture(two = false) {
  const home = mkdtempSync(join(tmpdir(), "winter-workspace-events-"));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  let db = openRuntimeStateDb(home), store = new SessionStore(home), remaining = 1000;
  let records = new CoworkRepository(db, () => "2026-10-14T00:00:00.000Z", prefix => `${prefix}_${String(remaining--).padStart(4, "0")}`);
  const made = records.create(context("create"), { ownership: "project", title: "Fixture", sources: [selection], ceiling });
  const workspaceId = made.workspaceId, sourceId = made.value.sources[0]!.sourceId;
  // Controller authority records only, not a VM/mount/guest execution fixture.
  const epoch = records.beginIncarnation(workspaceId, "fixture-incarnation", 1);
  records.acknowledgeSource(epoch, sourceId, 1, "ready");
  const sessions = [store.createSession("global", { mode: "code" })];
  if (two) sessions.push(store.createSession("global", { mode: "code" }));
  for (const [i, sessionId] of sessions.entries()) records.bindConversation(context(`bind-${i}`, records.get(workspaceId).configRevision), workspaceId, { sessionId, sourceId });
  let hub = new SessionHub(store), scope = new Set([workspaceId]);
  const host: CoworkHostPorts = { principal: connection => connection.role === "remote"
    ? { kind: "paired-user", id: "phone", workspaceIds: scope, repositoryAuthorities: new Set() }
    : { kind: "local-user", id: "user-one" }, grants: { folder: () => undefined, repository: () => undefined },
    selection: () => undefined, creationCeiling: () => undefined, requireProvisioning: () => { throw new Error("unavailable"); } };
  const service = () => new CoworkWorkspaceService(records, host);
  const pump = () => new CoworkWorkspaceEvents(records, store, hub);
  cleanups.push(() => { store.close(); db.close(); });
  return { home, workspaceId, sourceId, sessions, host, scope, service, pump,
    get records() { return records; }, get store() { return store; }, get hub() { return hub; }, get db() { return db; },
    reopen(dropIndex = false) { store.close(); db.close(); if (dropIndex) rmSync(join(home, "sessions", "index.db"), { force: true }); db = openRuntimeStateDb(home); store = new SessionStore(home); records = new CoworkRepository(db); hub = new SessionHub(store); },
    update(requestId: string) { return service().call({ role: "harness", connectionId: 1 }, "workspace.update", { workspaceId, title: requestId, requestId, expectedRevision: records.get(workspaceId).configRevision }); },
  };
}
const changes = (store: SessionStore, sessionId: string) => store.read(sessionId).filter(event => HOST_WORKSPACE_EVENT_TYPES.has(event.type));

test("actual host mutations deliver commit-ordered stable changes to two logical conversations and replay/history", () => {
  const f = fixture(true); f.pump().drain();
  const live: SessionEvent[] = [];
  const client = { clientName: "observer", deliver(event: SessionEvent) { live.push(event); return true; } };
  f.hub.attach(client, f.sessions[0]!, 0); live.length = 0;
  f.update("first"); f.update("second");
  const pending = f.records.pendingChanges(f.sessions[0]!);
  expect(pending[0]!.changeId > pending[1]!.changeId).toBe(true); // reverse IDs and tied timestamps
  expect(f.pump().drain()).toEqual({ delivered: 4, blocked: 0 });
  for (const sessionId of f.sessions) {
    const delivered = changes(f.store, sessionId).slice(-2);
    expect(delivered.map(event => "workspaceChangeId" in event && event.workspaceChangeId)).toEqual(pending.map(change => change.changeId));
    expect(delivered.every(event => event.sessionId === sessionId)).toBe(true);
    expect(f.records.pendingChanges(sessionId)).toEqual([]);
    expect(readHistoryPage(f.store, { sessionId }).events.slice(-2)).toEqual(delivered);
    for (const event of delivered) expect(filterRemoteStreamEvent(event)).toEqual(event);
    const ack = f.db.db.query<{ event_seq: number }, [string, string]>("SELECT event_seq FROM cowork_outbox_deliveries WHERE session_id=? AND change_id=?").get(sessionId, pending[1]!.changeId);
    expect(ack!.event_seq).toBe(delivered[1]!.seq);
    const replay: SessionEvent[] = [];
    f.hub.attach({ clientName: "replay", deliver(event) { replay.push(event); return true; } }, sessionId, 0);
    expect(replay.filter(event => HOST_WORKSPACE_EVENT_TYPES.has(event.type))).toEqual(changes(f.store, sessionId));
  }
  expect(live.filter(event => HOST_WORKSPACE_EVENT_TYPES.has(event.type))).toHaveLength(2);
  expect(f.store.list().some(row => row.sessionId === "$system")).toBe(false);
  f.reopen(); expect(f.pump().drain()).toEqual({ delivered: 0, blocked: 0 });
});

for (const phase of ["before-append", "after-append"] as const) test(`restart recovers crash ${phase} without duplicate event or reordered later change`, () => {
  const f = fixture(); f.pump().drain(); f.update("first"); f.update("second");
  const pending = f.records.pendingChanges(f.sessions[0]!);
  const broken = new CoworkWorkspaceEvents(f.records, f.store, f.hub, at => { if (at === phase) throw new Error("injected crash"); });
  expect(broken.drain()).toEqual({ delivered: 0, blocked: 1 });
  expect(f.records.pendingChanges(f.sessions[0]!)).toHaveLength(2);
  expect(changes(f.store, f.sessions[0]!).filter(event => "workspaceChangeId" in event && event.workspaceChangeId === pending[0]!.changeId)).toHaveLength(phase === "after-append" ? 1 : 0);
  f.reopen(); expect(f.pump().drain()).toEqual({ delivered: 2, blocked: 0 });
  expect(changes(f.store, f.sessions[0]!).slice(-2).map(event => "workspaceChangeId" in event && event.workspaceChangeId)).toEqual(pending.map(change => change.changeId));
  expect(f.pump().drain()).toEqual({ delivered: 0, blocked: 0 });
});

test("requested source revocation remains unavailable/restartRequired; exact controller ACK is separately attributed", () => {
  const f = fixture(); f.pump().drain();
  const added = f.records.addSource(context("add", f.records.get(f.workspaceId).configRevision), f.workspaceId, selection).value;
  f.records.acknowledgeSource(f.records.refreshEpoch(f.workspaceId, "fixture-incarnation", 1), added.sourceId, added.revision, "ready");
  f.records.removeSource(context("revoke", f.records.get(f.workspaceId).configRevision), f.workspaceId, f.sourceId, true);
  f.pump().drain();
  const events = changes(f.store, f.sessions[0]!);
  expect(events.at(-1)).toMatchObject({ type: "workspace_sources_changed", phase: "requested", sources: [{ sourceId: f.sourceId, state: "unavailable", ackRevision: null, restartRequired: true, reason: "access_revoked" }] });
  expect(events.some(event => event.type === "workspace_sources_changed" && event.phase === "acknowledged" && event.sources[0]?.sourceId === added.sourceId && event.sources[0]?.ackRevision === 1)).toBe(true);
  const serialized = JSON.stringify(events);
  for (const privateValue of [selection.label, selection.detail.rootIdentity, selection.detail.grantRef]) expect(serialized).not.toContain(privateValue);
});

test("policy metadata cannot claim a mounted/effective tool view and mutable defaults do not rewrite conversation policy", () => {
  const f = fixture(); f.pump().drain();
  f.records.updatePolicy(context("policy", f.records.get(f.workspaceId).configRevision), f.workspaceId, { defaultPolicy: "plan", ceiling: { ...ceiling, toolClasses: ["read"] } });
  f.pump().drain();
  expect(changes(f.store, f.sessions[0]!).at(-1)).toMatchObject({ type: "workspace_policy_changed", phase: "metadata", defaultPolicy: "plan", policyRevision: 2 });
  expect(f.records.binding(f.sessions[0]!).policy).toBe("auto");
  expect(JSON.stringify(changes(f.store, f.sessions[0]!).at(-1))).not.toContain("effective");
});

test("legacy payloads become safe refetch hints; hostile nested payload extras do not enter logs", () => {
  const f = fixture(); f.pump().drain();
  const receipt = f.records.removeSource(context("revoke", f.records.get(f.workspaceId).configRevision), f.workspaceId, f.sourceId, true);
  const change = f.records.pendingChanges(f.sessions[0]!)[0]!;
  const payload = change.payload as any;
  payload.hostPath = "/Users/secret"; payload.token = "bearer-secret"; payload.sources[0].bookmark = "private-bookmark";
  f.db.db.run("UPDATE cowork_outbox SET payload_json=? WHERE change_id=?", [JSON.stringify(payload), change.changeId]);
  f.pump().drain(); expect(JSON.stringify(changes(f.store, f.sessions[0]!))).not.toMatch(/secret|private-bookmark/);
  expect(workspaceEventInput(f.sessions[0]!, { ...change, payload: { sourceId: f.sourceId, token: "bearer-secret" } })).toMatchObject({ phase: "refetch", sources: [] });
  expect(receipt.operationId).toBe(change.operationId);
});

test("missing logical session does not create a fake replacement or acknowledge pending notifications", () => {
  const f = fixture(); f.pump().drain(); f.update("missing");
  f.store.deleteSession(f.sessions[0]!);
  expect(f.pump().drain()).toEqual({ delivered: 0, blocked: 1 });
  expect(f.records.pendingChanges(f.sessions[0]!)).toHaveLength(1);
  expect(f.store.list()).toEqual([]);
});

test("runtime frames and sync imports cannot author host workspace authority events", () => {
  const f = fixture(); f.pump().drain(); f.update("import"); f.pump().drain();
  const event = changes(f.store, f.sessions[0]!).at(-1)!;
  for (const type of HOST_WORKSPACE_EVENT_TYPES) {
    expect(PROJECTED_EVENT_COVERAGE[type as keyof typeof PROJECTED_EVENT_COVERAGE]).toBe(false);
    expect(SUBAGENT_TRANSCRIPT_INCLUDE[type as keyof typeof SUBAGENT_TRANSCRIPT_INCLUDE]).toBe(false);
    const { projector } = makeProjector();
    expect(accept(projector, { ...event, type: "system", subtype: type } as any).some(value => HOST_WORKSPACE_EVENT_TYPES.has(value.type))).toBe(false);
  }
  const chat = f.store.createSession("global", { mode: "chat" });
  const forged = SessionEvent.parse({ ...event, sessionId: chat, seq: 2 });
  expect(() => f.store.appendSynced(chat, [{ raw: JSON.stringify(forged), event: forged }])).toThrow("host workspace");
  expect(() => syncPush({ store: f.store, buffers: new SyncPushBuffers(), connId: 1, broadcastCreated() {} }, { sessionId: chat, baseSeq: 1, data: Buffer.from(JSON.stringify(forged) + "\n").toString("base64"), complete: true })).toThrow("host workspace");
  const harmless = SessionEvent.parse({ type: "user_message", sessionId: chat, seq: 2, ts: 0, threadId: "main", text: "hello", clientName: "fixture" });
  expect(() => f.store.appendSynced(chat, [{ raw: JSON.stringify(forged), event: harmless }])).toThrow("host workspace");
  expect(f.store.lastSeq(chat)).toBe(1);
});

class Client {
  events: SessionEvent[] = []; private decoder = new LineDecoder(); private next = 1;
  private pending = new Map<number, (reply: any) => void>();
  private socket!: Awaited<ReturnType<typeof Bun.connect>>; private writer!: ConnWriter;
  static async open(socketPath: string, token: string) {
    const c = new Client();
    c.socket = await Bun.connect({ unix: socketPath, socket: { data(_socket, bytes) {
      for (const line of c.decoder.push(bytes)) { const reply = JSON.parse(line); if (reply.method === "event") c.events.push(reply.params); else { c.pending.get(reply.id)?.(reply); c.pending.delete(reply.id); } }
    }, drain() { c.writer.onDrain(); } } });
    c.writer = new ConnWriter(c.socket as unknown as WritableSocket);
    cleanups.push(() => c.socket.end());
    expect((await c.request("protocol.hello", { protocolVersion: PROTOCOL_VERSION, token, role: "remote", clientName: "fixture" })).error).toBeUndefined();
    return c;
  }
  request(method: string, params: unknown) { const id = this.next++; return new Promise<any>(resolve => { this.pending.set(id, resolve); this.writer.enqueue(encodeLine({ jsonrpc: "2.0", id, method, params })); }); }
}

test("real IPC replay/live and history enforce current remote workspace scope after revocation", async () => {
  const f = fixture(); f.pump().drain();
  const tokens = new TokenAuthority(new FileSecretStore(join(f.home, "fixture-secrets.json"))), keys = await tokens.ensureTokens();
  const socketPath = join(f.home, "fixture.sock"), service = f.service();
  const server = startIpcServer({ socketPath, serverVersion: "fixture", tokens, store: f.store, hub: f.hub, cowork: service, coworkEvents: f.pump() });
  cleanups.push(() => server.stop());
  const client = await Client.open(socketPath, keys.remote);
  expect((await client.request("session.attach", { sessionId: f.sessions[0]!, fromSeq: 0 })).error).toBeUndefined();
  f.update("visible"); f.pump().drain();
  await client.request("session.history", { sessionId: f.sessions[0]! }); // socket roundtrip barrier
  expect(client.events.some(event => HOST_WORKSPACE_EVENT_TYPES.has(event.type))).toBe(true);
  const before = client.events.filter(event => HOST_WORKSPACE_EVENT_TYPES.has(event.type)).length;
  f.scope.clear(); f.update("revoked"); f.pump().drain();
  expect((await client.request("session.list", {})).result.sessions).toEqual([]);
  expect((await client.request("session.history", { sessionId: f.sessions[0]! })).error).toBeDefined();
  expect((await client.request("session.attach", { sessionId: f.sessions[0]!, fromSeq: 0 })).error).toBeDefined();
  expect(client.events.filter(event => HOST_WORKSPACE_EVENT_TYPES.has(event.type))).toHaveLength(before);
});

test("session index rebuild replays display events without recreating or widening canonical bindings/policy", () => {
  const f = fixture(); f.pump().drain(); f.update("index-rebuild");
  const binding = f.records.binding(f.sessions[0]!), policy = f.records.policy(f.workspaceId);
  const pending = f.records.pendingChanges(f.sessions[0]!);
  new CoworkWorkspaceEvents(f.records, f.store, f.hub, phase => { if (phase === "after-append") throw new Error("crash"); }).drain();
  f.reopen(true);
  expect(f.records.binding(f.sessions[0]!)).toEqual(binding);
  expect(f.records.policy(f.workspaceId)).toEqual(policy);
  expect(f.pump().drain()).toEqual({ delivered: 1, blocked: 0 });
  expect(changes(f.store, f.sessions[0]!).filter(event => "workspaceChangeId" in event && event.workspaceChangeId === pending[0]!.changeId)).toHaveLength(1);
});

test("workspace with no logical conversations retains canonical changes without a synthetic session", () => {
  const f = fixture(); f.pump().drain();
  const made = f.records.create(context("unattached-workspace"), { ownership: "project", title: "Unattached", sources: [selection], ceiling });
  expect(f.db.db.query<{ n: number }, [string]>("SELECT count(*) AS n FROM cowork_outbox WHERE workspace_id=?").get(made.workspaceId)!.n).toBe(1);
  expect(f.records.pendingChangeSessions()).toEqual([]);
  expect(f.pump().drain()).toEqual({ delivered: 0, blocked: 0 });
  expect(f.store.list()).toHaveLength(1);
});

test("instruction change projection carries revision/digest/status without content or backing paths", () => {
  const event = workspaceEventInput("s_one", { changeId: "change_one", workspaceId: "workspace_one", operationId: "operation_one", revision: 4,
    kind: "workspace_instructions_changed", payload: { instructionRevision: 2, digest: "a".repeat(64), refreshState: "current", text: "private guidance", path: "/Users/private" } });
  expect(event).toMatchObject({ type: "workspace_instructions_changed", instructionRevision: 2, refreshState: "current" });
  expect(JSON.stringify(event)).not.toMatch(/private guidance|Users/);
  expect(() => workspaceEventInput("s_one", { changeId: "change_one", workspaceId: "workspace_one", operationId: "operation_one", revision: 4,
    kind: "workspace_instructions_changed", payload: { instructionRevision: 2, digest: "/Users/private", refreshState: "current" } })).toThrow("recovery_required");
});
