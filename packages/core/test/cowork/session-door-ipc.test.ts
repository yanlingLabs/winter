// Session door D4b (docs/research/2026-10-18-cowork-session-door-d4.md): with a door, a stored Cowork row's send, steer and
// interrupt reach the door's drivers (and compaction refuses typed); without one nothing changes and the drivers are never
// asked. `session.list` carries the row's workspace reference from the host binding; remote never sees or reaches the row.
// Also: provisioning admission through S7B's port when a host supplies it, and truthful capabilities. No guest boots here.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConnWriter, ERR, LineDecoder, METHODS, PROTOCOL_VERSION, encodeLine, type WritableSocket } from "@yanlinglabs/winter-protocol";
import { FileSecretStore } from "../../src/auth/secret-store";
import { TokenAuthority } from "../../src/auth/tokens";
import { startIpcServer } from "../../src/ipc/server";
import { CoworkRepository } from "../../src/cowork/repository";
import { CoworkWorkspaceService, type CoworkHostPorts } from "../../src/cowork/service";
import type { CoworkLegSession, CoworkProvisioningPort, CoworkSessionDoor, CoworkSessionDrivers } from "../../src/cowork/session-ports";
import { CoworkError } from "../../src/cowork/types";
import { openRuntimeStateDb, type RuntimeStateDb } from "../../src/runtime-state/db";
import { SessionStore } from "../../src/sessions/store";

class Client {
  private decoder = new LineDecoder(); private next = 1;
  private pending = new Map<number, { resolve(value: any): void; timer: ReturnType<typeof setTimeout> }>();
  private socket!: Awaited<ReturnType<typeof Bun.connect>>; private writer!: ConnWriter;
  static async connect(path: string, token: string, role: string): Promise<Client> {
    const client = new Client();
    client.socket = await Bun.connect({ unix: path, socket: {
      data(_socket, bytes) {
        for (const line of client.decoder.push(bytes)) {
          const message = JSON.parse(line), pending = client.pending.get(message.id);
          if (pending) { clearTimeout(pending.timer); client.pending.delete(message.id); pending.resolve(message); }
        }
      },
      drain() { client.writer.onDrain(); },
    } });
    client.writer = new ConnWriter(client.socket as unknown as WritableSocket);
    expect((await client.request(METHODS.hello, { protocolVersion: PROTOCOL_VERSION, token, role, clientName: `fixture-${role}` })).error).toBeUndefined();
    return client;
  }
  request(method: string, params: unknown = {}): Promise<any> {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("RPC timeout")); }, 10_000);
      this.pending.set(id, { resolve, timer }); this.writer.enqueue(encodeLine({ jsonrpc: "2.0", id, method, params }));
    });
  }
  close(): void { this.socket.end(); }
}

const CEILING = { toolClasses: ["read", "write"], hostServices: [], connectors: [], network: "none" as const };
const FOLDER = { kind: "folder" as const, access: "read-write" as const, label: "fixture", detail: { grantRef: "grant", rootIdentity: "root" } };
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

/** Drivers that record every call; `live` decides whether `get` answers, `refuse` makes `ensure` refuse typed. */
function recordingDrivers(opts: { live?: boolean; refuse?: string; interrupt?: () => Promise<{ wasRunning: boolean }> } = {}) {
  const calls: string[] = [];
  const session = {
    async send(text: string, clientName?: string) { calls.push(`send:${text}:${clientName}`); return { seq: 7, queued: false }; },
    async steer(text: string) { calls.push(`steer:${text}`); return { injected: true }; },
    async interrupt() { calls.push("interrupt"); return opts.interrupt ? opts.interrupt() : { wasRunning: true }; },
  } as unknown as CoworkLegSession;
  const drivers: CoworkSessionDrivers = {
    get: id => { calls.push(`get:${id}`); return opts.live ? session : undefined; },
    ensure: async id => { calls.push(`ensure:${id}`); if (opts.refuse) throw new CoworkError(opts.refuse as never); return session; },
    runTurn: async () => { throw new Error("unused"); }, evict: async () => {}, list: () => [], beginShutdown: async () => {},
  };
  return { drivers, calls };
}

async function boot(door: CoworkSessionDoor | undefined) {
  const home = mkdtempSync(join(tmpdir(), "winter-door-d4b-")), store = new SessionStore(home), db: RuntimeStateDb = openRuntimeStateDb(home);
  const records = new CoworkRepository(db), cowork = new CoworkWorkspaceService(records);
  const made = records.create({ principalId: "fixture", requestId: "create" }, { ownership: "project", title: "fixture", ceiling: CEILING, sources: [FOLDER] });
  const sourceId = made.value.sources[0]!.sourceId, coworkId = "s_0123456789ab";
  store.ensureCoworkSession("global", coworkId, { approvalPolicy: "ask", model: "winter-test/standin", cowork: { workspaceId: made.workspaceId, projectId: made.value.workspace.ownerId, location: "source", sourceId, policyRevision: 1 } }, () => true);
  records.bindConversation({ principalId: "fixture", requestId: "bind", expectedRevision: records.get(made.workspaceId).configRevision }, made.workspaceId, { sessionId: coworkId, sourceId }, store);
  const codeId = store.createSession("global", { mode: "code" });
  const authority = new TokenAuthority(new FileSecretStore(join(home, "secrets.json"))), tokens = await authority.ensureTokens();
  const socketPath = join(home, "core.sock");
  const server = startIpcServer({ socketPath, serverVersion: "test", tokens: authority, store, cowork, ...(door ? { coworkSessions: door } : {}) });
  const harness = await Client.connect(socketPath, tokens.harness, "harness"), remote = await Client.connect(socketPath, tokens.remote, "remote");
  cleanups.push(() => { harness.close(); remote.close(); server.stop(); store.close(); db.close(); rmSync(home, { recursive: true, force: true }); });
  return { harness, remote, store, coworkId, codeId, workspaceId: made.workspaceId, projectId: made.value.workspace.ownerId };
}
const door = (drivers: CoworkSessionDrivers): CoworkSessionDoor => ({ drivers, create: async () => { throw new Error("unused"); } });

test("with a door, a Cowork row's send and steer run on the door's drivers; a Code row never touches them", async () => {
  const { drivers, calls } = recordingDrivers(), b = await boot(door(drivers));
  expect((await b.harness.request(METHODS.sessionAttach, { sessionId: b.coworkId })).error).toBeUndefined();
  expect((await b.harness.request(METHODS.sessionSend, { sessionId: b.coworkId, text: "hello" })).result).toEqual({ seq: 7 });
  expect((await b.harness.request(METHODS.sessionSteer, { sessionId: b.coworkId, text: "more" })).result).toEqual({ ok: true, injected: true });
  expect(calls).toEqual([`get:${b.coworkId}`, `ensure:${b.coworkId}`, "send:hello:fixture-harness", `get:${b.coworkId}`, `ensure:${b.coworkId}`, "steer:more"]);
  calls.length = 0;
  expect((await b.harness.request(METHODS.sessionAttach, { sessionId: b.codeId })).error).toBeUndefined();
  await b.harness.request(METHODS.sessionSend, { sessionId: b.codeId, text: "code" });
  expect(calls).toEqual([]);
});

test("with a door, a send from a client attached elsewhere is refused before the drivers; a driver refusal is the typed Cowork code", async () => {
  const { drivers, calls } = recordingDrivers({ refuse: "provider_unavailable" }), b = await boot(door(drivers));
  expect((await b.harness.request(METHODS.sessionSend, { sessionId: b.coworkId, text: "x" })).error.message).toContain("attach to the session first");
  expect((await b.harness.request(METHODS.sessionAttach, { sessionId: b.codeId })).error).toBeUndefined();
  expect((await b.harness.request(METHODS.sessionSend, { sessionId: b.coworkId, text: "x" })).error.message).toContain("not attached");
  expect(calls).toEqual([]);
  await b.harness.request(METHODS.sessionAttach, { sessionId: b.coworkId });
  expect((await b.harness.request(METHODS.sessionSend, { sessionId: b.coworkId, text: "x" })).error.data).toEqual({ code: "provider_unavailable" });
  // Images are Code-only, refused before any driver call.
  calls.length = 0;
  expect((await b.harness.request(METHODS.sessionSend, { sessionId: b.coworkId, text: "[Image #1]", images: [{ path: "/tmp/x.png" }] })).error).toBeDefined();
  expect(calls).toEqual([]);
});

test("with a door: interrupt asks only a live driver (whose typed refusal reaches the client); compaction refuses typed", async () => {
  const idle = recordingDrivers(), a = await boot(door(idle.drivers));
  expect((await a.harness.request(METHODS.sessionInterrupt, { sessionId: a.coworkId })).result).toEqual({ ok: true, wasRunning: false });
  expect(idle.calls).toEqual([`get:${a.coworkId}`]);
  const live = recordingDrivers({ live: true, interrupt: async () => { throw new CoworkError("unsupported_topology"); } }), b = await boot(door(live.drivers));
  expect((await b.harness.request(METHODS.sessionInterrupt, { sessionId: b.coworkId })).error.data).toEqual({ code: "unsupported_topology" });
  expect(live.calls).toEqual([`get:${b.coworkId}`, "interrupt"]);
  live.calls.length = 0;
  const compact = await b.harness.request(METHODS.sessionCompact, { sessionId: b.coworkId });
  expect(compact.error).toMatchObject({ code: ERR.INVALID_PARAMS, data: { code: "unsupported_topology" } });
  expect(live.calls).toEqual([]);
});

test("without a door nothing routes: the same requests answer as before and no driver exists to ask", async () => {
  const b = await boot(undefined);
  await b.harness.request(METHODS.sessionAttach, { sessionId: b.coworkId });
  // A bare server (no runtime driver table) keeps its old answers for every row.
  expect((await b.harness.request(METHODS.sessionInterrupt, { sessionId: b.coworkId })).result).toEqual({ ok: true, wasRunning: false });
  expect((await b.harness.request(METHODS.sessionCompact, { sessionId: b.coworkId })).result).toEqual({ ok: true, compacted: false, uptoSeq: 0, summaryChars: 0 });
  expect((await b.harness.request(METHODS.sessionCompact, { sessionId: b.codeId })).result).toEqual({ ok: true, compacted: false, uptoSeq: 0, summaryChars: 0 });
});

test("session.list carries a Cowork row's workspace reference from the binding; a Code row carries none; remote never sees or reaches the row", async () => {
  const { drivers, calls } = recordingDrivers(), b = await boot(door(drivers));
  const rows = (await b.harness.request(METHODS.sessionList)).result.sessions as { sessionId: string; mode?: string; cowork?: unknown; cwd?: unknown }[];
  expect(rows.find(row => row.sessionId === b.coworkId)).toMatchObject({ mode: "cowork", cowork: { workspaceId: b.workspaceId, projectId: b.projectId } });
  expect(rows.find(row => row.sessionId === b.coworkId)!.cwd).toBeUndefined();
  expect(rows.find(row => row.sessionId === b.codeId)!.cowork).toBeUndefined();
  expect(((await b.remote.request(METHODS.sessionList)).result.sessions as { sessionId: string }[]).map(row => row.sessionId)).not.toContain(b.coworkId);
  expect((await b.remote.request(METHODS.sessionSend, { sessionId: b.coworkId, text: "x" })).error).toBeDefined();
  expect((await b.remote.request(METHODS.sessionInterrupt, { sessionId: b.coworkId })).error).toBeDefined();
  expect(calls).toEqual([]);
});

// ------------------------------------------------------------------------------------------------ provisioning, capabilities
function service(over: Partial<CoworkHostPorts> = {}) {
  const home = mkdtempSync(join(tmpdir(), "winter-door-d4b-svc-")), db = openRuntimeStateDb(home), records = new CoworkRepository(db);
  cleanups.push(() => { db.close(); rmSync(home, { recursive: true, force: true }); });
  const host: CoworkHostPorts = {
    principal: () => ({ kind: "local-user", id: "local" }), grants: { folder: () => ({ rootIdentity: "root", writable: true, revoked: false }), repository: () => undefined },
    selection: () => FOLDER, creationCeiling: () => CEILING, requireProvisioning: () => { throw new CoworkError("unsupported_topology"); }, ...over,
  };
  return { svc: new CoworkWorkspaceService(records, host), records };
}
const HARNESS = { role: "harness", connectionId: 1 };
const create = (svc: CoworkWorkspaceService, requestId: string) => svc.call(HARNESS, "workspace.create", { requestId, ownership: "project", title: "t", selections: [{ selectionId: "folder-choice", kind: "folder" }] });

test("capabilities are the ports that exist: false/false for a production host, true only where a port says so", () => {
  expect(service().svc.call(HARNESS, "workspace.capabilities.get", {})).toMatchObject({ provisioning: false, execution: false });
  expect(service({ execution: () => false }).svc.call(HARNESS, "workspace.capabilities.get", {})).toMatchObject({ execution: false });
  let available = false;
  const provisioning: CoworkProvisioningPort = { available: () => available, admit: () => { if (!available) throw new CoworkError("unsupported_topology"); }, provision: async () => ({ status: "applied" }) };
  const { svc } = service({ provisioning, execution: () => true });
  expect(svc.call(HARNESS, "workspace.capabilities.get", {})).toMatchObject({ provisioning: false, execution: true });
  available = true;
  expect(svc.call(HARNESS, "workspace.capabilities.get", {})).toMatchObject({ provisioning: true, execution: true });
});

test("provisioning: with S7B's port, its admit is the gate (refusing while unavailable); without it the host's refusing gate stays", () => {
  let available = false, admitted = 0;
  const provisioning: CoworkProvisioningPort = { available: () => available, admit: () => { admitted++; if (!available) throw new CoworkError("unsupported_topology"); }, provision: async () => ({ status: "applied" }) };
  const ported = service({ provisioning });
  expect(() => create(ported.svc, "refused")).toThrow("unsupported_topology");
  expect(ported.records.list().length).toBe(0);
  available = true;
  expect(create(ported.svc, "admitted").workspaceId).toBeTruthy(); // the host's own gate still throws: the port replaced it
  expect(admitted).toBe(2);
  const production = service();
  expect(() => create(production.svc, "refused")).toThrow("unsupported_topology");
});
