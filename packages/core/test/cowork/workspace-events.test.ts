import { Database } from "bun:sqlite";
import { reapEmptySessions } from "../../src/sessions/reaper";
import { afterEach, expect, test as bunTest } from "bun:test";
import { mkdtempSync, rmSync, statfsSync, renameSync, readFileSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOST_WORKSPACE_EVENT_TYPES, SessionEvent, LineDecoder, ConnWriter, PROTOCOL_VERSION, encodeLine, type WritableSocket } from "@yanlinglabs/winter-protocol";
import { openRuntimeStateDb } from "../../src/runtime-state/db";
import { CoworkRepository } from "../../src/cowork/repository";
import { CoworkWorkspaceService, type CoworkHostPorts } from "../../src/cowork/service";
import { createCoworkSessionDeletionHook, CoworkWorkspaceEvents, workspaceEventInput } from "../../src/cowork/workspace-events";
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

// Actual reviewed Darwin file+directory flushes. Unsupported hosts are not success fixtures.
const test = process.platform === "darwin" && process.arch === "arm64" ? bunTest : bunTest.skip;
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
  for (const [i, sessionId] of sessions.entries()) records.bindConversation(context(`bind-${i}`, records.get(workspaceId).configRevision), workspaceId, { sessionId, sourceId }, store);
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
  expect(f.pump().drain()).toEqual({ delivered: 4, blocked: 0, deferred: 0, pruneBlocked: 0 });
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
  f.reopen(); expect(f.pump().drain()).toEqual({ delivered: 0, blocked: 0, deferred: 0, pruneBlocked: 0 });
});

for (const phase of ["before-append", "after-append"] as const) test(`restart recovers crash ${phase} without duplicate event or reordered later change`, () => {
  const f = fixture(); f.pump().drain(); f.update("first"); f.update("second");
  const pending = f.records.pendingChanges(f.sessions[0]!);
  const broken = new CoworkWorkspaceEvents(f.records, f.store, f.hub, at => { if (at === phase) throw new Error("injected crash"); });
  expect(broken.drain()).toEqual({ delivered: 0, blocked: 1, deferred: 0, pruneBlocked: 0 });
  expect(f.records.pendingChanges(f.sessions[0]!)).toHaveLength(2);
  expect(changes(f.store, f.sessions[0]!).filter(event => "workspaceChangeId" in event && event.workspaceChangeId === pending[0]!.changeId)).toHaveLength(phase === "after-append" ? 1 : 0);
  f.reopen(); expect(f.pump().drain()).toEqual({ delivered: 2, blocked: 0, deferred: 0, pruneBlocked: 0 });
  expect(changes(f.store, f.sessions[0]!).slice(-2).map(event => "workspaceChangeId" in event && event.workspaceChangeId)).toEqual(pending.map(change => change.changeId));
  expect(f.pump().drain()).toEqual({ delivered: 0, blocked: 0, deferred: 0, pruneBlocked: 0 });
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

test("missing logical session is retired durably without deleting workspace data or growing new deliveries", () => {
  const f = fixture(); f.pump().drain(); f.update("missing");
  f.store.deleteSession(f.sessions[0]!);
  expect(f.pump().drain()).toEqual({ delivered: 0, blocked: 0, deferred: 0, pruneBlocked: 0 });
  expect(f.records.pendingChanges(f.sessions[0]!)).toEqual([]);
  expect(f.records.binding(f.sessions[0]!).state).toBe("deleted");
  f.update("after-deletion"); expect(f.records.pendingChanges(f.sessions[0]!)).toEqual([]);
  f.reopen(); expect(f.records.binding(f.sessions[0]!).state).toBe("deleted");
  expect(f.records.get(f.workspaceId).state).toBe("retained"); expect(f.records.sources(f.workspaceId)).toHaveLength(1);
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

test("a failing scope lookup skips that event for the phone and keeps it connected; events resume when the lookup recovers", async () => {
  const f = fixture(); f.pump().drain();
  const tokens = new TokenAuthority(new FileSecretStore(join(f.home, "fixture-secrets.json"))), keys = await tokens.ensureTokens();
  const socketPath = join(f.home, "fixture.sock"), service = f.service();
  let broken = false;
  const real = service.requireSessionRead.bind(service);
  (service as unknown as { requireSessionRead: typeof real }).requireSessionRead = ((...args: Parameters<typeof real>) => { if (broken) throw new Error("SQLITE_BUSY"); return real(...args); }) as typeof real;
  const server = startIpcServer({ socketPath, serverVersion: "fixture", tokens, store: f.store, hub: f.hub, cowork: service, coworkEvents: f.pump() });
  cleanups.push(() => server.stop());
  const client = await Client.open(socketPath, keys.remote);
  expect((await client.request("session.attach", { sessionId: f.sessions[0]!, fromSeq: 0 })).error).toBeUndefined();
  const count = () => client.events.filter(event => HOST_WORKSPACE_EVENT_TYPES.has(event.type)).length;
  broken = true; f.update("during-fault"); f.pump().drain();
  expect((await client.request("session.history", { sessionId: f.sessions[0]! }).catch(() => ({ error: "disconnected" }))).error ?? undefined).not.toBe("disconnected");
  const during = count();
  broken = false; f.update("after-fault"); f.pump().drain();
  await client.request("session.history", { sessionId: f.sessions[0]! });
  expect(count()).toBeGreaterThan(during); // still attached: the fault cost one event, not the connection
});

test("scope revoked mid-stream: no further frames reach the phone, but it stays attached and resumes when scope returns", async () => {
  const f = fixture(); f.pump().drain();
  const tokens = new TokenAuthority(new FileSecretStore(join(f.home, "fixture-secrets.json"))), keys = await tokens.ensureTokens();
  const socketPath = join(f.home, "fixture.sock"), service = f.service();
  const server = startIpcServer({ socketPath, serverVersion: "fixture", tokens, store: f.store, hub: f.hub, cowork: service, coworkEvents: f.pump() });
  cleanups.push(() => server.stop());
  const client = await Client.open(socketPath, keys.remote);
  const sid = f.sessions[0]!;
  const attached = () => (f.hub as unknown as { attachments: Map<string, Set<unknown>> }).attachments.get(sid)?.size ?? 0;
  const frames = () => client.events.filter(event => HOST_WORKSPACE_EVENT_TYPES.has(event.type)).length;
  expect((await client.request("session.attach", { sessionId: sid, fromSeq: 0 })).error).toBeUndefined();
  f.update("visible"); f.pump().drain(); await client.request("session.list", {});
  expect(frames()).toBeGreaterThan(0); expect(attached()).toBe(1);
  const before = frames();
  f.scope.clear(); f.update("revoked-1"); f.pump().drain(); f.update("revoked-2"); f.pump().drain();
  await client.request("session.list", {}); // barrier: every earlier frame has been written
  expect(frames()).toBe(before);            // nothing delivered while revoked (kills deliver-on-error)
  expect(attached()).toBe(1);               // and the phone was not dropped from the session (kills return-false)
  f.scope.add(f.workspaceId); f.update("restored"); f.pump().drain();
  await client.request("session.list", {});
  expect(frames()).toBeGreaterThan(before); // same connection, stream resumes
}, 15_000);

test("a phone attached to a daemon with no Cowork service gets no workspace frames and is not dropped", async () => {
  const f = fixture(); f.pump().drain();
  const tokens = new TokenAuthority(new FileSecretStore(join(f.home, "fixture-secrets.json"))), keys = await tokens.ensureTokens();
  const socketPath = join(f.home, "fixture.sock");
  const server = startIpcServer({ socketPath, serverVersion: "fixture", tokens, store: f.store, hub: f.hub });
  cleanups.push(() => server.stop());
  const client = await Client.open(socketPath, keys.remote);
  const sid = f.sessions[0]!;
  const attach = await client.request("session.attach", { sessionId: sid, fromSeq: 0 });
  if (attach.error) return; // this daemon shape refuses the attach outright: nothing to stream, nothing to drop
  const attached = () => (f.hub as unknown as { attachments: Map<string, Set<unknown>> }).attachments.get(sid)?.size ?? 0;
  f.update("no-service"); f.pump().drain(); await client.request("session.list", {});
  expect(client.events.filter(event => HOST_WORKSPACE_EVENT_TYPES.has(event.type))).toHaveLength(0);
  expect(attached()).toBe(1);
}, 15_000);

test("work that becomes pending after the outbox timer stopped re-arms it at the enqueue site; a daemon with nothing pending arms nothing", async () => {
  const f = fixture(); f.pump().drain();
  const timerOf = (p: unknown) => (p as { timer?: unknown }).timer;
  const idle = f.pump(); idle.start(); idle.rearm(); expect(timerOf(idle)).toBeUndefined(); // nothing pending, no host: still no timer
  const busy = f.pump(); let pending = true;
  (busy as unknown as { hasPending(): boolean }).hasPending = () => pending;
  busy.start(); expect(timerOf(busy)).toBeDefined();
  pending = false; await Bun.sleep(1300); expect(timerOf(busy)).toBeUndefined(); // stopped itself
  pending = true; busy.rearm(); expect(timerOf(busy)).toBeDefined();             // new work: re-armed
  busy.stop(); busy.rearm(); expect(timerOf(busy)).toBeUndefined();              // shutdown is final
  // The enqueue site: every Cowork RPC calls rearm() after its inline drain.
  const tokens = new TokenAuthority(new FileSecretStore(join(f.home, "fixture-secrets.json"))), keys = await tokens.ensureTokens();
  const socketPath = join(f.home, "fixture.sock");
  let rearms = 0;
  const fake = { drain: () => ({ delivered: 0, blocked: 0, deferred: 0, pruneBlocked: 0 }), rearm: () => { rearms++; } } as unknown as CoworkWorkspaceEvents;
  const server = startIpcServer({ socketPath, serverVersion: "fixture", tokens, store: f.store, hub: f.hub, cowork: f.service(), coworkEvents: fake });
  cleanups.push(() => server.stop());
  const client = await Client.open(socketPath, keys.remote);
  await client.request("workspace.list", { limit: 10 });
  expect(rearms).toBe(1);
}, 15_000);

test("session index rebuild replays display events without recreating or widening canonical bindings/policy", () => {
  const f = fixture(); f.pump().drain(); f.update("index-rebuild");
  const binding = f.records.binding(f.sessions[0]!), policy = f.records.policy(f.workspaceId);
  const pending = f.records.pendingChanges(f.sessions[0]!);
  new CoworkWorkspaceEvents(f.records, f.store, f.hub, phase => { if (phase === "after-append") throw new Error("crash"); }).drain();
  f.reopen(true);
  expect(f.records.binding(f.sessions[0]!)).toEqual(binding);
  expect(f.records.policy(f.workspaceId)).toEqual(policy);
  expect(f.pump().drain()).toEqual({ delivered: 1, blocked: 0, deferred: 0, pruneBlocked: 0 });
  expect(changes(f.store, f.sessions[0]!).filter(event => "workspaceChangeId" in event && event.workspaceChangeId === pending[0]!.changeId)).toHaveLength(1);
});

test("workspace with no logical conversations retains canonical changes without a synthetic session", () => {
  const f = fixture(); f.pump().drain();
  const made = f.records.create(context("unattached-workspace"), { ownership: "project", title: "Unattached", sources: [selection], ceiling });
  expect(f.db.db.query<{ n: number }, [string]>("SELECT count(*) AS n FROM cowork_outbox WHERE workspace_id=?").get(made.workspaceId)!.n).toBe(1);
  expect(f.records.pendingChangeSessions()).toEqual([]);
  expect(f.pump().drain()).toEqual({ delivered: 0, blocked: 0, deferred: 0, pruneBlocked: 0 });
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

/** The filesystem type name (`apfs`, `hfs`, …) of the mount holding `path`, from `/sbin/mount`: the longest mount
 *  point that is `path` or one of its parents. */
function filesystemName(path: string): string | undefined {
  const real = realpathSync(path);
  let best: { point: string; name: string } | undefined;
  for (const line of Bun.spawnSync(["/sbin/mount"]).stdout.toString().split("\n")) {
    const m = /^.+? on (.+) \(([^,)]+)/.exec(line);
    if (!m) continue;
    const point = m[1]!, name = m[2]!;
    const inside = real === point || real.startsWith(point === "/" ? "/" : point + "/");
    if (inside && (best === undefined || point.length > best.point.length)) best = { point, name };
  }
  return best?.name;
}

test("actual owned JSONL and held APFS-directory fullsync complete before delivery ACK", () => {
  const f = fixture(); f.pump().drain();
  expect(Bun.version).toBe("1.3.14"); expect(Bun.revision.startsWith("0d9b296a")).toBe(true);
  // APFS by NAME: `statfs` f_type is a vfs registration number that differs across macOS releases (26 on one
  // runner image, 25 on another), so the number alone failed on an APFS home.
  const fsType = statfsSync(f.home).type; expect(filesystemName(f.home)).toBe("apfs");
  f.update("fullsync-log"); const pending = f.records.pendingChanges(f.sessions[0]!)[0]!;
  expect(f.pump().drain()).toEqual({ delivered: 1, blocked: 0, deferred: 0, pruneBlocked: 0 });
  const acknowledged = f.db.db.query<{ event_seq: number }, [string, string]>("SELECT event_seq FROM cowork_outbox_deliveries WHERE session_id=? AND change_id=?").get(f.sessions[0]!, pending.changeId)!;
  expect(acknowledged.event_seq).toBe(changes(f.store, f.sessions[0]!).at(-1)!.seq);
  console.info(JSON.stringify({ fixture: "cowork-outbox-fullsync", bun: Bun.version, bunRevision: Bun.revision,
    filesystemType: fsType, logFileRequestCompleted: true, directoryRequestCompleted: true,
    exactAckSeq: acknowledged.event_seq, hardwarePowerCutProof: false }));
});

test("missing canonical JSONL refuses flush without recreation or acknowledgement", () => {
  const f = fixture(); f.pump().drain(); f.update("missing-log");
  const path = join(f.home, "sessions", "global", `${f.sessions[0]}.jsonl`);
  renameSync(path, path + ".retained");
  expect(() => f.store.flushLog(f.sessions[0]!)).toThrow();
  expect(f.pump().drain()).toEqual({ delivered: 0, blocked: 1, deferred: 0, pruneBlocked: 0 });
  expect(existsSync(path)).toBe(false);
  expect(f.records.pendingChanges(f.sessions[0]!)).toHaveLength(1);
  expect(f.records.binding(f.sessions[0]!).state).toBe("active");
});

test("more than 100 pending changes stay ordered across bounded passes and prune delivered ledger/journal rows", () => {
  const f = fixture(); f.pump().drain();
  for (let i = 0; i < 125; i++) f.update(`change-${i}`);
  const pending = f.records.pendingChanges(f.sessions[0]!);
  const pump = f.pump(); expect(pump.drain()).toEqual({ delivered: 100, blocked: 0, deferred: 0, pruneBlocked: 0 });
  expect(f.records.pendingChanges(f.sessions[0]!)).toHaveLength(25);
  expect(pump.drain()).toEqual({ delivered: 25, blocked: 0, deferred: 0, pruneBlocked: 0 });
  expect(changes(f.store, f.sessions[0]!).slice(-125).map(event => "workspaceChangeId" in event && event.workspaceChangeId)).toEqual(pending.map(change => change.changeId));
  expect(f.db.db.query<{ n: number }, [string]>("SELECT count(*) AS n FROM cowork_outbox_deliveries WHERE session_id=? AND state='delivered'").get(f.sessions[0]!)!.n).toBe(100);
  expect(f.db.db.query<{ n: number }, [string]>("SELECT count(*) AS n FROM cowork_outbox WHERE workspace_id=?").get(f.workspaceId)!.n).toBe(103); // unbound creation/source ACK/operation ACK + latest100 receipts
  f.reopen(); expect(f.pump().drain()).toEqual({ delivered: 0, blocked: 0, deferred: 0, pruneBlocked: 0 });
}, 60_000); // explicit timeout: seconds of real SQL work, which the 5 s default cannot bound under load

test("a failed live conversation backs off without appending duplicates or suppressing another conversation", () => {
  const f = fixture(true); f.pump().drain(); f.update("backoff");
  let attempts = 0;
  const pump = new CoworkWorkspaceEvents(f.records, f.store, f.hub, (_phase, sessionId) => { if (sessionId === f.sessions[0]!) { attempts++; throw new Error("injected crash"); } });
  expect(pump.drain()).toEqual({ delivered: 1, blocked: 1, deferred: 0, pruneBlocked: 0 });
  expect(pump.drain()).toEqual({ delivered: 0, blocked: 0, deferred: 1, pruneBlocked: 0 });
  expect(attempts).toBe(1);
  expect(f.records.pendingChanges(f.sessions[0]!)).toHaveLength(1);
  expect(f.records.pendingChanges(f.sessions[1]!)).toEqual([]);
});

test("structural restart reconciliation handles legacy optional fields and differently ordered JSONL keys", () => {
  const f = fixture(); f.pump().drain();
  f.records.updatePolicy(context("legacy-policy", f.records.get(f.workspaceId).configRevision), f.workspaceId, { defaultPolicy: "plan" });
  const change = f.records.pendingChanges(f.sessions[0]!)[0]!;
  f.db.db.run("UPDATE cowork_outbox SET payload_json='{}' WHERE change_id=?", [change.changeId]);
  const pump = new CoworkWorkspaceEvents(f.records, f.store, f.hub, phase => { if (phase === "after-append") throw new Error("injected crash"); });
  expect(pump.drain()).toEqual({ delivered: 0, blocked: 1, deferred: 0, pruneBlocked: 0 });
  const path = f.store.transcriptPath(f.sessions[0]!);
  const raw = readFileSync(path, "utf8").trimEnd().split("\n");
  raw[raw.length - 1] = JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(raw.at(-1)!)).reverse()));
  writeFileSync(path, raw.join("\n") + "\n");
  f.reopen(); expect(f.pump().drain()).toEqual({ delivered: 1, blocked: 0, deferred: 0, pruneBlocked: 0 });
  expect(changes(f.store, f.sessions[0]!).filter(event => "workspaceChangeId" in event && event.workspaceChangeId === change.changeId)).toHaveLength(1);
});

test("actual outbox mutations and delivery ACK restore the preexisting shared connection durability settings", () => {
  const f = fixture();
  const settings = () => ["synchronous", "fullfsync", "checkpoint_fullfsync"].map(name => f.db.db.query<Record<string, number>, []>(`PRAGMA main.${name}`).get()![name]);
  const prior = settings(); expect(prior[0]).toBe(1);
  f.pump().drain(); expect(settings()).toEqual(prior);
  f.update("scoped-fullsync"); expect(settings()).toEqual(prior);
  expect(f.pump().drain()).toEqual({ delivered: 1, blocked: 0, deferred: 0, pruneBlocked: 0 }); expect(settings()).toEqual(prior);
  f.records.abandonConversation(f.sessions[0]!); expect(settings()).toEqual(prior);
});

test("bind requires the actual committed session row before canonical admission, with no absent dependency fallback", () => {
  const f = fixture(), revision = f.records.get(f.workspaceId).configRevision;
  const bind = (sessionId: string, requestId: string, sessions = f.store) => f.records.bindConversation(context(requestId, revision), f.workspaceId, { sessionId, sourceId: f.sourceId }, sessions);
  expect(() => bind("missing-session", "absent")).toThrow("authority_denied");
  expect(() => f.records.bindConversation(context("no-port", revision), f.workspaceId, { sessionId: f.sessions[0]!, sourceId: f.sourceId }, undefined as any)).toThrow("authority_denied");
  const uuid = "11111111-2222-4333-8444-555555555555";
  f.store.createSynced(uuid, { scope: "global", mode: "chat" });
  expect(f.store.hasCommittedSession(uuid)).toBe(false);
  expect(() => bind(uuid, "empty-index-row")).toThrow("authority_denied");
  let pendingId = "";
  const index = (f.store as unknown as { db: Database }).db;
  index.transaction(() => {
    pendingId = f.store.createSession("global", { mode: "code" });
    expect(f.store.hasCommittedSession(pendingId)).toBe(false);
    expect(() => bind(pendingId, "index-transaction-open")).toThrow("authority_denied");
  })();
  expect(f.records.get(f.workspaceId).configRevision).toBe(revision);
  expect(f.store.hasCommittedSession(pendingId)).toBe(true);
  expect(bind(pendingId, "after-commit").value.sessionId).toBe(pendingId);
  expect(f.records.binding(pendingId).state).toBe("active");
});

test("monotonic retry expiry reports deferred work and successful retry resets backoff despite wall-clock changes", () => {
  const f = fixture(); f.pump().drain(); f.update("monotonic-retry");
  let monotonic = 0, crash = true;
  const pump = new CoworkWorkspaceEvents(f.records, f.store, f.hub, () => { if (crash) throw new Error("injected crash"); }, () => monotonic);
  expect(pump.drain()).toEqual({ delivered: 0, blocked: 1, deferred: 0, pruneBlocked: 0 });
  monotonic = 999;
  const wallNow = Date.now;
  try {
    Date.now = () => wallNow() + 10_000_000;
    expect(pump.drain()).toEqual({ delivered: 0, blocked: 0, deferred: 1, pruneBlocked: 0 });
    Date.now = () => wallNow() - 10_000_000;
    expect(pump.drain()).toEqual({ delivered: 0, blocked: 0, deferred: 1, pruneBlocked: 0 });
  } finally { Date.now = wallNow; }
  monotonic = 1000; crash = false;
  expect(pump.drain()).toEqual({ delivered: 1, blocked: 0, deferred: 0, pruneBlocked: 0 });
  f.update("after-recovery");
  expect(pump.drain()).toEqual({ delivered: 1, blocked: 0, deferred: 0, pruneBlocked: 0 });
});

test("shared boot/live deletion hook reaps an actual old session and retires its conversation fanout", () => {
  const f = fixture(); const runtimeDeletes: string[] = [];
  const hook = createCoworkSessionDeletionHook(f.records, id => runtimeDeletes.push(id));
  const now = f.store.list()[0]!.createdAt + 600_001;
  reapEmptySessions({ store: f.store, attachedCount: () => 0, home: f.home, now: () => now, onDelete: hook });
  expect(runtimeDeletes).toEqual(f.sessions);
  expect(f.store.hasSession(f.sessions[0]!)).toBe(false);
  expect(f.records.binding(f.sessions[0]!).state).toBe("deleted");
  expect(f.records.pendingChanges(f.sessions[0]!)).toEqual([]);
  f.update("after-boot-reap"); expect(f.records.pendingChangeSessions()).toEqual([]);
  expect(f.records.get(f.workspaceId).state).toBe("retained");
});

test("actual SQL pruning failure is separate from successful delivery and does not back off new pending events", () => {
  const f = fixture(); f.pump().drain();
  for (let i = 0; i < 100; i++) f.update(`retention-${i}`);
  f.pump().drain();
  f.db.db.run("CREATE TEMP TRIGGER fixture_prune_failure BEFORE DELETE ON cowork_outbox_deliveries WHEN OLD.state='delivered' BEGIN SELECT RAISE(FAIL,'fixture_prune_failure'); END");
  const pump = f.pump(); f.update("prune-failure");
  expect(pump.drain()).toEqual({ delivered: 1, blocked: 0, deferred: 0, pruneBlocked: 1 });
  expect(f.records.pendingChanges(f.sessions[0]!)).toEqual([]);
  f.update("next-delivery");
  expect(pump.drain()).toEqual({ delivered: 1, blocked: 0, deferred: 0, pruneBlocked: 1 });
  f.db.db.run("DROP TRIGGER fixture_prune_failure"); f.update("prune-recovered");
  expect(pump.drain()).toEqual({ delivered: 1, blocked: 0, deferred: 0, pruneBlocked: 0 });
}, 60_000); // explicit timeout: seconds of real SQL work, which the 5 s default cannot bound under load

bunTest.skipIf(process.platform === "darwin" && process.arch === "arm64")("unsupported host refuses Cowork log flush explicitly without a native flush fallback", () => {
  const f = fixture();
  expect(() => f.store.flushLog(f.sessions[0]!)).toThrow("unsupported_topology");
  expect(f.store.lastSeq(f.sessions[0]!)).toBe(1);
});

test("start() arms no timer without an injected host or pending work; keepAlive and pending work arm it, and it stops itself when idle", async () => {
  const f = fixture(); f.pump().drain();
  const timerOf = (p: unknown) => (p as { timer?: unknown }).timer;
  const quiet = f.pump(); quiet.start(); expect(timerOf(quiet)).toBeUndefined();
  const hosted = f.pump(); hosted.start({ keepAlive: true }); expect(timerOf(hosted)).toBeDefined(); hosted.stop(); expect(timerOf(hosted)).toBeUndefined();
  const busy = f.pump(); let pending = true;
  (busy as unknown as { hasPending(): boolean }).hasPending = () => pending;
  busy.start(); expect(timerOf(busy)).toBeDefined();
  pending = false; await Bun.sleep(1300); expect(timerOf(busy)).toBeUndefined(); // the tick found nothing owed and stopped itself
}, 15_000);

test("a failing delivery pass never throws out of start() or the timer tick", async () => {
  const f = fixture(); f.pump().drain();
  const errors: string[] = []; const real = console.error; console.error = (...a: unknown[]) => { errors.push(a.join(" ")); };
  try {
    f.db.db.run("BEGIN"); // drain refuses to run inside a caller transaction (recovery_required)
    const pump = f.pump();
    expect(() => pump.start({ keepAlive: true })).not.toThrow();
    await Bun.sleep(1300); // at least one timer tick under the same refusal: the process must survive it
    pump.stop();
    f.db.db.run("ROLLBACK");
  } finally { console.error = real; }
  expect(errors.filter(e => e.startsWith("cowork: workspace event delivery failed"))).toHaveLength(1); // logged once, not every second
}, 15_000);
