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
import { CoworkWorkspaceService, COWORK_PROVISION_CONCURRENCY, COWORK_PROVISION_PAGE, disabledCoworkHost, type CoworkHostPorts } from "../../src/cowork/service";
import { createMacCoworkHost } from "../../src/cowork/mac-host";
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

test("with a door, a Cowork row's send runs on the door's drivers and a steer reaches only a live one; a Code row never touches them", async () => {
  const { drivers, calls } = recordingDrivers(), b = await boot(door(drivers));
  expect((await b.harness.request(METHODS.sessionAttach, { sessionId: b.coworkId })).error).toBeUndefined();
  expect((await b.harness.request(METHODS.sessionSend, { sessionId: b.coworkId, text: "hello" })).result).toEqual({ seq: 7 });
  // Nothing live: a steer starts nothing (send is the one door that boots a guest).
  expect((await b.harness.request(METHODS.sessionSteer, { sessionId: b.coworkId, text: "more" })).result).toEqual({ ok: true, injected: false });
  expect(calls).toEqual([`get:${b.coworkId}`, `ensure:${b.coworkId}`, "send:hello:fixture-harness", `get:${b.coworkId}`]);
  const live = recordingDrivers({ live: true }), l = await boot(door(live.drivers));
  expect((await l.harness.request(METHODS.sessionSteer, { sessionId: l.coworkId, text: "more" })).result).toEqual({ ok: true, injected: true });
  expect(live.calls).toEqual([`get:${l.coworkId}`, "steer:more"]);
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
  expect((await b.remote.request(METHODS.sessionSteer, { sessionId: b.coworkId, text: "x" })).error).toBeDefined();
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

test("a Cowork row whose reference cannot be read lists without it, and the list still answers", async () => {
  const { drivers } = recordingDrivers(), b = await boot(door(drivers));
  const original = CoworkRepository.prototype.conversationRef;
  CoworkRepository.prototype.conversationRef = () => { throw new CoworkError("invalid_request"); };
  try {
    const rows = (await b.harness.request(METHODS.sessionList)).result.sessions as { sessionId: string; cowork?: unknown }[];
    expect(rows.map(row => row.sessionId).sort()).toEqual([b.codeId, b.coworkId].sort());
    expect(rows.find(row => row.sessionId === b.coworkId)!.cowork).toBeUndefined();
  } finally { CoworkRepository.prototype.conversationRef = original; }
});

/** Every place a src module NAMES `provisioning` or `execution` as a property it writes, in any syntax the parser knows:
 *  an assignment (`provisioning: x`), a shorthand (`{ provisioning }`), a method or accessor (`execution() {}`), a class
 *  field, an interface member, an assignment through a property access (`host.provisioning = x`), and any string literal or
 *  template that is exactly the name (computed keys, `Reflect.set`, `defineProperty`). Reads (`this.host.provisioning`) are not writes. */
function portNameWrites(names: readonly string[] = ["provisioning", "execution"]): string[] {
  const { readdirSync, readFileSync, statSync } = require("node:fs") as typeof import("node:fs");
  const ts = require("typescript") as typeof import("typescript");
  const packages = join(import.meta.dir, "..", "..", "..");
  const files = readdirSync(packages).flatMap(name => { const src = join(packages, name, "src"); try { return statSync(src).isDirectory() ? readdirSync(src, { recursive: true }).map(String).map(file => join(src, file)).filter(file => /\.(ts|tsx|js|mjs|cjs)$/.test(file)) : []; } catch { return []; } });
  expect(files.length).toBeGreaterThan(100);
  const NAMES = new Set(names), found: string[] = [];
  for (const file of files) {
    const visit = (node: import("typescript").Node): void => {
      const named = (ts.isIdentifier(node) || ts.isPrivateIdentifier(node) || ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) && NAMES.has(node.text.replace(/^#/, ""));
      if (named) {
        const parent = node.parent;
        const read = ts.isPropertyAccessExpression(parent) && parent.name === node
          && !(ts.isBinaryExpression(parent.parent) && parent.parent.left === parent && parent.parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && parent.parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment);
        if (!read) found.push(`${file.slice(packages.length + 1).split(/[\\/]/).join("/")} ${ts.SyntaxKind[parent.kind]} ${parent.getText().replace(/\s+/g, " ").slice(0, 60)}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true));
  }
  return found.sort();
}

test("pins (structural): no src module supplies a host's execution port, and the one place that supplies provisioning is the daemon, behind an injected environment (production has none)", () => {
  // Declared in service.ts's host interface, reported in its capabilities, typed on the wire; the schedule status's own
  // `execution` field is a different value. Any other write of either name, in any syntax, fails here.
  expect(portNameWrites()).toEqual([
    // S7B (part 3): the daemon composes the provisioning port ONLY where an environment was injected (`coworkNativePort`, undefined in production: the activation seam
    // answers undefined), and only when the host has none. The behavioural pin below and native/anti-wiring's seam pin cover the other half.
    "core/src/daemon.ts PropertyAssignment provisioning: coworkProvisioning",
    "core/src/cowork/schedules.ts PropertyAssignment execution: \"unavailable\" as const",
    "core/src/cowork/service.ts PropertyAssignment execution: this.host.execution?.() === true",
    "core/src/cowork/service.ts PropertyAssignment provisioning: this.host.provisioning?.available() === true",
    "core/src/cowork/service.ts PropertySignature execution?: () => boolean;",
    "core/src/cowork/service.ts PropertySignature provisioning?: CoworkProvisioningPort;",
    "protocol/src/cowork.ts PropertyAssignment execution: z.boolean()",
    "protocol/src/cowork.ts PropertyAssignment execution: z.literal(\"unavailable\")",
    "protocol/src/cowork.ts PropertyAssignment provisioning: z.boolean()",
  ].sort());
  // The approvals adapter is defined in the door module and called by no src module (only a door composition will).
  const { readdirSync, readFileSync, statSync } = require("node:fs") as typeof import("node:fs");
  const packages = join(import.meta.dir, "..", "..", "..");
  const files = readdirSync(packages).flatMap(name => { const src = join(packages, name, "src"); try { return statSync(src).isDirectory() ? readdirSync(src, { recursive: true }).map(String).map(file => join(src, file)).filter(file => /\.(ts|tsx|js|mjs)$/.test(file)) : []; } catch { return []; } });
  const code = (file: string) => readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  expect(files.filter(file => /(?<!function )\bcoworkApprovalPort\(/.test(code(file)))).toEqual([]);
});

test("pins (behavioural): the production host composition carries neither port, and its service reports false/false", () => {
  const home = mkdtempSync(join(tmpdir(), "winter-door-prod-")), db = openRuntimeStateDb(home);
  cleanups.push(() => { db.close(); rmSync(home, { recursive: true, force: true }); });
  // daemon.ts: `opts.coworkHost ?? createMacCoworkHost(winterHome, undefined, runtime.db, coworkNativePort)`, plus `native`.
  const native = { start: async () => undefined };
  for (const host of [disabledCoworkHost, createMacCoworkHost(home, undefined, db), createMacCoworkHost(home, undefined, db, native), { ...createMacCoworkHost(home, undefined, db), native }]) {
    expect(["provisioning" in host, "execution" in host]).toEqual([false, false]);
    expect(new CoworkWorkspaceService(new CoworkRepository(db), host).call(HARNESS, "workspace.capabilities.get", {})).toMatchObject({ provisioning: false, execution: false });
  }
});

// ------------------------------------------------------------------------------------------------ D4c: provision after COMMIT
function provisioned(answer: (call: number) => Promise<{ status: "applied" | "failed"; reason?: string }>) {
  const calls: { workspaceId: string; operationId: string; committed: boolean }[] = [];
  let svc: CoworkWorkspaceService | undefined, records: CoworkRepository | undefined;
  const provisioning: CoworkProvisioningPort = {
    available: () => true, admit: () => {},
    provision: async (workspaceId, operationId) => {
      // Called after COMMIT: the operation is already durable and readable outside any transaction.
      calls.push({ workspaceId, operationId, committed: !records!.rs.db.inTransaction && records!.operation(workspaceId, operationId).status === "pending" });
      return answer(calls.length);
    },
  };
  const made = service({ provisioning });
  svc = made.svc; records = made.records;
  const status = (workspaceId: string, operationId: string) => records!.operation(workspaceId, operationId).status;
  return { svc, records, calls, status };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 5));

test("D4c: a creation with S7B's port runs provision once after COMMIT; `applied` leaves the operation pending for the guest's acknowledgment", async () => {
  const p = provisioned(async () => ({ status: "applied" }));
  const receipt = create(p.svc, "one");
  await settle();
  expect(p.calls).toEqual([{ workspaceId: receipt.workspaceId, operationId: receipt.operationId, committed: true }]);
  expect(p.status(receipt.workspaceId, receipt.operationId)).toBe("pending");
});

test("D4c: `failed` concludes the creation's operation failed, terminal and announced; the port's reason text is never kept", async () => {
  const p = provisioned(async () => ({ status: "failed", reason: "secret-detail-from-port" }));
  const receipt = create(p.svc, "one");
  await settle();
  expect(p.records.operation(receipt.workspaceId, receipt.operationId)).toMatchObject({ status: "failed", terminal: true });
  const outbox = p.records.rs.db.query("SELECT kind, payload_json FROM cowork_outbox WHERE operation_id=? AND kind='workspace_operation_changed'").all(receipt.operationId) as { payload_json: string }[];
  expect(outbox.map(row => JSON.parse(row.payload_json))).toEqual([{ operationId: receipt.operationId, status: "failed", terminal: true }]);
  const dump = JSON.stringify(p.records.rs.db.query("SELECT * FROM cowork_operations").all()) + JSON.stringify(p.records.rs.db.query("SELECT * FROM cowork_outbox").all());
  expect(dump.includes("secret-detail")).toBe(false);
  // Concluded: a replay of the same create does not drive it again.
  create(p.svc, "one"); await settle();
  expect(p.calls.length).toBe(1);
});

test("D4c: a throw or a malformed answer is uncertain (pending); resumeProvisioning and a replay drive it again, one drive at a time", async () => {
  let release!: () => void;
  const answers: (() => Promise<{ status: "applied" | "failed" }>)[] = [
    async () => { throw new Error("transport reset"); },
    async () => ({ status: "weird" as never }),
    () => new Promise(resolve => { release = () => resolve({ status: "applied" }); }),
  ];
  const p = provisioned(async call => answers[call - 1]!());
  const receipt = create(p.svc, "one");
  await settle();
  expect(p.status(receipt.workspaceId, receipt.operationId)).toBe("pending");
  await p.svc.resumeProvisioning();
  expect([p.calls.length, p.status(receipt.workspaceId, receipt.operationId)]).toEqual([2, "pending"]);
  // A third drive hangs; a replay and a resume during it join it instead of starting another.
  const resumed = p.svc.resumeProvisioning();
  await settle();
  create(p.svc, "one");
  void p.svc.resumeProvisioning();
  await settle();
  expect(p.calls.length).toBe(3);
  release(); await resumed;
  expect(p.status(receipt.workspaceId, receipt.operationId)).toBe("pending");
});

test("D4c: without the port nothing is provisioned and resumeProvisioning does nothing (every production host)", async () => {
  const { svc, records } = service();
  await svc.resumeProvisioning();
  expect(records.pendingCreations()).toEqual([]);
  const ported = service({ provisioning: { available: () => true, admit: () => {}, provision: async () => ({ status: "applied" }) } });
  const receipt = create(ported.svc, "x");
  expect(ported.records.pendingCreations()).toMatchObject([{ workspaceId: receipt.workspaceId, operationId: receipt.operationId }]);
});

test("D4c: a replay alone re-drives an uncertain creation; a concluded one leaves the pending list; only a creation can fail this way", async () => {
  let first = true;
  const p = provisioned(async () => { if (first) { first = false; throw new Error("uncertain"); } return { status: "failed" }; });
  const receipt = create(p.svc, "one");
  await settle();
  expect(p.records.pendingCreations()).toMatchObject([{ workspaceId: receipt.workspaceId, operationId: receipt.operationId }]);
  create(p.svc, "one"); await settle();
  expect(p.calls.length).toBe(2);
  expect(p.status(receipt.workspaceId, receipt.operationId)).toBe("failed");
  expect(p.records.pendingCreations()).toEqual([]);
  // A non-creation operation (a title update) is never concluded by a provisioning answer.
  const update = p.svc.call(HARNESS, "workspace.update", { workspaceId: receipt.workspaceId, requestId: "rename", expectedRevision: 1, title: "renamed" });
  expect(() => p.records.failCreationProvisioning(receipt.workspaceId, update.operationId)).toThrow("not_found");
});

// ------------------------------------------------------------------------------------------------ D4 review fixes
test("D4b fix: a source addition goes through the port's admit when present, refusing while unavailable", () => {
  let available = false, admitted = 0;
  const provisioning: CoworkProvisioningPort = { available: () => available, admit: () => { admitted++; if (!available) throw new CoworkError("unsupported_topology"); }, provision: async () => ({ status: "applied" }) };
  const { svc, records } = service({ provisioning });
  available = true;
  const receipt = create(svc, "made");
  available = false; admitted = 0;
  const add = (requestId: string) => svc.call(HARNESS, "workspace.source.addFolder", { workspaceId: receipt.workspaceId, requestId, expectedRevision: records.get(receipt.workspaceId).configRevision, selectionId: "folder-choice" });
  expect(() => add("refused")).toThrow("unsupported_topology");
  expect([admitted, records.sources(receipt.workspaceId).length]).toEqual([1, 1]);
  available = true;
  expect(add("admitted").value.sourceId).toBeTruthy();
  expect([admitted, records.sources(receipt.workspaceId).length]).toEqual([2, 2]);
});

test("D4b fix: a live driver's steer refusal reaches the client typed; an unknown session never routes to the door", async () => {
  const calls: string[] = [];
  const session = { async steer() { calls.push("steer"); throw new CoworkError("stale_acknowledgment"); } } as unknown as CoworkLegSession;
  const drivers: CoworkSessionDrivers = {
    get: id => { calls.push(`get:${id}`); return session; }, ensure: async id => { calls.push(`ensure:${id}`); return session; },
    runTurn: async () => { throw new Error("unused"); }, evict: async () => {}, list: () => [], beginShutdown: async () => {},
  };
  const b = await boot(door(drivers));
  expect((await b.harness.request(METHODS.sessionSteer, { sessionId: b.coworkId, text: "more" })).error.data).toEqual({ code: "stale_acknowledgment" });
  expect(calls).toEqual([`get:${b.coworkId}`, "steer"]);
  calls.length = 0;
  for (const method of [METHODS.sessionSend, METHODS.sessionSteer, METHODS.sessionInterrupt, METHODS.sessionCompact]) {
    expect((await b.harness.request(method, { sessionId: "s_ffffffffffff", text: "x" })).error?.data?.code).not.toBe("stale_acknowledgment");
  }
  expect(calls).toEqual([]);
});

test("D4c fix: a creation concluded failed is terminal for execution: no reservation, no bind, no boot", async () => {
  const p = provisioned(async () => ({ status: "failed" }));
  const receipt = create(p.svc, "one");
  await settle();
  expect(p.status(receipt.workspaceId, receipt.operationId)).toBe("failed");
  const sourceId = p.records.sources(receipt.workspaceId)[0]!.sourceId;
  expect(() => p.records.reserveConversation({ principalId: "local", workspaceId: receipt.workspaceId, requestId: "r", scope: "t", requestDigest: "a".repeat(64) }, () => false)).toThrow("recovery_required");
  const committed = { hasCommittedSession: () => true };
  const context = () => ({ principalId: "local", requestId: "bind", expectedRevision: p.records.get(receipt.workspaceId).configRevision });
  expect(() => p.records.bindConversation(context(), receipt.workspaceId, { sessionId: "s_0123456789ab", sourceId }, committed)).toThrow("recovery_required");
  expect(() => p.records.bindOutputsConversation(context(), receipt.workspaceId, { sessionId: "s_0123456789ab" }, committed)).toThrow("recovery_required");
  expect(() => p.records.beginIncarnation(receipt.workspaceId, "incarnation-1", p.records.get(receipt.workspaceId).configRevision)).toThrow("recovery_required");
  expect(p.records.rs.db.query("SELECT COUNT(*) AS n FROM cowork_conversations").get()).toEqual({ n: 0 });
  // An applied creation of another workspace is unaffected.
  const fine = service({ provisioning: { available: () => true, admit: () => {}, provision: async () => ({ status: "applied" }) } });
  const ok = create(fine.svc, "ok"); await settle();
  expect(fine.records.reserveConversation({ principalId: "local", workspaceId: ok.workspaceId, requestId: "r", scope: "t", requestDigest: "a".repeat(64) }, () => false).state).toBe("pending");
});

test("D4c fix: a late `failed` for a workspace a guest has started stays pending (uncertain); only a never-booted workspace fails", () => {
  const { records } = service();
  const made = (requestId: string) => records.create({ principalId: "fixture", requestId }, { ownership: "project", title: "t", ceiling: CEILING, sources: [FOLDER] });
  const receipt = made("booted"); // created directly: nothing drives it, the operation stays pending
  records.beginIncarnation(receipt.workspaceId, "incarnation-1", records.get(receipt.workspaceId).configRevision);
  records.failCreationProvisioning(receipt.workspaceId, receipt.operationId);
  expect(records.operation(receipt.workspaceId, receipt.operationId).status).toBe("pending");
  const never = made("never");
  records.failCreationProvisioning(never.workspaceId, never.operationId);
  expect(records.operation(never.workspaceId, never.operationId).status).toBe("failed");
});

test("D4c fix: resume drives EVERY pending creation once per boot, oldest first, in keyset pages, at most COWORK_PROVISION_CONCURRENCY at a time", async () => {
  const home = mkdtempSync(join(tmpdir(), "winter-door-d4c-bound-")), db = openRuntimeStateDb(home);
  cleanups.push(() => { db.close(); rmSync(home, { recursive: true, force: true }); });
  let clock = 0;
  const records = new CoworkRepository(db, () => new Date(Date.UTC(2026, 0, 1) + clock++ * 1000).toISOString());
  const total = COWORK_PROVISION_PAGE + 6, made: string[] = [];
  for (let i = 0; i < total; i++) made.push(records.create({ principalId: "fixture", requestId: `create-${i}` }, { ownership: "project", title: "t", ceiling: CEILING, sources: [FOLDER] }).operationId);
  let inFlight = 0, most = 0;
  const order: string[] = [];
  const port = (): CoworkProvisioningPort => ({
    available: () => true, admit: () => {},
    provision: async (_workspaceId, operationId) => { order.push(operationId); inFlight++; most = Math.max(most, inFlight); await Bun.sleep(1); inFlight--; return { status: "applied" }; },
  });
  const host: CoworkHostPorts = { ...disabledCoworkHost, provisioning: port() };
  const svc = new CoworkWorkspaceService(records, host);
  const first = svc.resumeProvisioning();
  expect(svc.resumeProvisioning()).toBe(first); // one resume at a time
  await first;
  expect(order).toEqual(made);
  expect(most).toBe(COWORK_PROVISION_CONCURRENCY);
  // Every one answered `applied` in this process: waiting on its guest, so a second resume drives nothing.
  await svc.resumeProvisioning();
  expect(order.length).toBe(total);
  // A new boot (a new service over the same records) drives every still-pending creation once more.
  order.length = 0; most = 0;
  await new CoworkWorkspaceService(records, { ...disabledCoworkHost, provisioning: port() }).resumeProvisioning();
  expect([order.length, most]).toEqual([total, COWORK_PROVISION_CONCURRENCY]);
});

test("D4c fix: resumeProvisioning never rejects, even when reading the pending list throws synchronously", async () => {
  const p = provisioned(async () => ({ status: "applied" }));
  const original = p.records.pendingCreations.bind(p.records);
  (p.records as unknown as { pendingCreations: unknown }).pendingCreations = () => { throw new Error("SQLITE_BUSY stand-in"); };
  await p.svc.resumeProvisioning();
  (p.records as unknown as { pendingCreations: unknown }).pendingCreations = original;
  const operation = p.records.operation.bind(p.records);
  create(p.svc, "one"); await settle();
  (p.records as unknown as { operation: unknown }).operation = () => { throw new Error("SQLITE_BUSY stand-in"); };
  const fresh = new CoworkWorkspaceService(p.records, { ...disabledCoworkHost, provisioning: { available: () => true, admit: () => {}, provision: async () => ({ status: "applied" }) } });
  await fresh.resumeProvisioning();
  (p.records as unknown as { operation: unknown }).operation = operation;
});

test("pins (structural): no src module supplies the N3 cold-resume or the N4 held-input gate (resume waits for the owner patch)", () => {
  // Declared on the driver's deps (and the leg session's verbs); the only value written is the driver's own gated verbs.
  // A composition that supplied either gate would add a line here: that is the D6 flip, and for cold resume only after the
  // owner applies the cold-resume owner patch (the unmodified native owner refuses a resume record).
  expect(portNameWrites(["coldResume", "heldInput", "ownerPatchApplied"])).toEqual([
    "core/src/agent/session-messaging.ts PropertySignature readonly heldInput?: CoworkHeldInputVerbs;",
    // b4: the gated composition seam NAMES the driver dep's type (a type reference, not a write); no production source imports it (peer-inbox-composition.test.ts pins that).
    "core/src/cowork/peer-inbox-composition.ts LiteralType \"heldInput\"",
    "core/src/cowork/session-driver.ts PropertyAssignment heldInput: coworkHeldInputVerbs(queryNow, () => handle.cowor",
    "core/src/cowork/session-driver.ts PropertySignature readonly coldResume?: { readonly ownerPatchApplied: true };",
    "core/src/cowork/session-driver.ts PropertySignature readonly heldInput?: { readonly enabled: true; /** Design ru",
    "core/src/cowork/session-driver.ts PropertySignature readonly ownerPatchApplied: true",
    "core/src/cowork/session-ports.ts PropertySignature readonly heldInput?: CoworkHeldInputVerbs;",
  ]);
});
