import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COWORK_RPC, COWORK_REMOTE_METHODS, ERR, ConnWriter, LineDecoder, PROTOCOL_VERSION, encodeLine, type WritableSocket } from "@yanlinglabs/winter-protocol";
import { CoworkRepository } from "../../src/cowork/repository";
import { CoworkWorkspaceService, type CoworkHostPorts } from "../../src/cowork/service";
import { openRuntimeStateDb } from "../../src/runtime-state/db";
import { SessionStore } from "../../src/sessions/store";
import { SessionHub } from "../../src/sessions/hub";
import { FileSecretStore } from "../../src/auth/secret-store";
import { TokenAuthority } from "../../src/auth/tokens";
import { startIpcServer } from "../../src/ipc/server";
import { startDaemon } from "../../src/daemon";
import { CoworkError } from "../../src/cowork/types";
const cleanup: Array<() => void> = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });
class Client {
 private decoder = new LineDecoder(); private next = 1; private pending = new Map<number, (reply: any) => void>(); private socket!: Awaited<ReturnType<typeof Bun.connect>>; private writer!: ConnWriter;
 static async open(socketPath: string, token: string, role: string) {
  const c = new Client(); c.socket = await Bun.connect({ unix: socketPath, socket: { data(_s, bytes) { for (const line of c.decoder.push(bytes)) { const r = JSON.parse(line); c.pending.get(r.id)?.(r); c.pending.delete(r.id); } }, drain() { c.writer.onDrain(); } } }); c.writer = new ConnWriter(c.socket as unknown as WritableSocket); cleanup.push(() => c.socket.end());
  expect((await c.request("protocol.hello", { protocolVersion: PROTOCOL_VERSION, token, role, clientName: "instruction-fixture" })).error).toBeUndefined(); return c;
 }
 request(method: string, params: unknown) { const id = this.next++; return new Promise<any>((resolve, reject) => { const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("fixture RPC timeout")); }, 5000); this.pending.set(id, r => { clearTimeout(timer); resolve(r); }); this.writer.enqueue(encodeLine({ jsonrpc: "2.0", id, method, params })); }); }
}
async function fixture() {
 const home = mkdtempSync(join(tmpdir(), "winter-instruction-rpc-")); cleanup.push(() => rmSync(home, { recursive: true, force: true }));
 const db = openRuntimeStateDb(home), records = new CoworkRepository(db), store = new SessionStore(home), hub = new SessionHub(store); cleanup.push(() => { store.close(); db.close(); });
 const workspaceId = records.create({ principalId: "local", requestId: "create" }, { ownership: "project", title: "Fixture", sources: [{ kind: "folder", label: "fixture", access: "read-write", detail: { grantRef: "grant", rootIdentity: "root" } }], ceiling: { toolClasses: ["read", "write"], hostServices: [], connectors: [], network: "none" } }).workspaceId;
 const host: CoworkHostPorts = { principal: connection => connection.role === "remote" ? { kind: "paired-user", id: "paired", workspaceIds: new Set([workspaceId]), repositoryAuthorities: new Set() } : { kind: "local-user", id: "local" }, grants: { folder: () => undefined, repository: () => undefined }, selection: () => undefined, creationCeiling: () => undefined, requireProvisioning: () => { throw new CoworkError("unsupported_topology"); } };
 const service = new CoworkWorkspaceService(records, host, undefined, home), tokens = new TokenAuthority(new FileSecretStore(join(home, "fixture-secrets.json"))), keys = await tokens.ensureTokens(), socketPath = join(home, "fixture.sock");
 const server = startIpcServer({ socketPath, serverVersion: "fixture", tokens, store, hub, cowork: service }); cleanup.push(() => server.stop());
 const client = await Client.open(socketPath, keys.harness, "harness"), remote = await Client.open(socketPath, keys.remote, "remote");
 return { home, workspaceId, records, service, client, remote };
}
test("real Unix RPC keeps missing backing unavailable and all guidance methods Mac-local", async () => {
 const f = await fixture(); expect((await f.client.request("workspace.instructions.get", { workspaceId: f.workspaceId })).error.data.code).toBe(process.platform === "darwin" && process.arch === "arm64" ? "recovery_required" : "unsupported_topology");
 for (const method of ["workspace.instructions.get", "workspace.instructions.provenance", "workspace.instructions.update"] as const) { expect((COWORK_REMOTE_METHODS as readonly string[]).includes(method)).toBe(false); const params = method === "workspace.instructions.update" ? { workspaceId: f.workspaceId, requestId: "remote-valid", expectedInstructionRevision: 1, expectedDigest: "a".repeat(64), content: "valid remote proposal" } : { workspaceId: f.workspaceId }; expect(COWORK_RPC[method].params.safeParse(params).success).toBe(true); expect((await f.remote.request(method, params)).error.code).toBe(ERR.UNAUTHORIZED); }
 expect((await f.client.request("workspace.instructions.get", { workspaceId: f.workspaceId, path: "/outside" })).error.data.code).toBe("invalid_request");
 const gateway = readFileSync(join(import.meta.dir, "../../../../apple/WinterKit/Sources/WinterKit/Gateway/Gateway.swift"), "utf8"); expect(gateway).not.toContain('"workspace.instructions.');
});
const native = process.platform === "darwin" && process.arch === "arm64" && process.env.WINTER_COWORK_INSTRUCTION_FS_FIXTURE === "1" ? test : test.skip;
native("real Unix RPC reads/updates content and enforces size/revision/digest/replay", async () => {
 const f = await fixture(); f.service.instructions!.initialize(f.workspaceId, "old");
 const read = (await f.client.request("workspace.instructions.get", { workspaceId: f.workspaceId })).result; expect(COWORK_RPC["workspace.instructions.get"].result.parse(read).contentBase64).toBe(Buffer.from("old").toString("base64"));
 const input = { workspaceId: f.workspaceId, requestId: "update", expectedInstructionRevision: read.instructionRevision, expectedDigest: read.digest, content: "real Unix update 😀" };
 const changed = await f.client.request("workspace.instructions.update", input); expect(changed.error).toBeUndefined(); expect(COWORK_RPC["workspace.instructions.update"].result.parse(changed.result).value.instructionRevision).toBe(2);
 expect((await f.client.request("workspace.instructions.update", input)).result).toEqual(changed.result);
 expect((await f.client.request("workspace.instructions.update", { ...input, requestId: "new-stale" })).error.data).toEqual({ code: "revision_conflict", currentRevision: 2 });
 expect((await f.client.request("workspace.instructions.update", { ...input, requestId: "bad", content: "x".repeat(65537) })).error.data.code).toBe("invalid_request");
 const provenance = (await f.client.request("workspace.instructions.provenance", { workspaceId: f.workspaceId })).result; expect(provenance.sourceDiscovery).toBe("unavailable"); expect(JSON.stringify(provenance)).not.toContain(f.home);
});

test("real daemon boots with unsupported symlinked runtime DB topology and gates guidance RPC", async () => {
 const parent = mkdtempSync(join(tmpdir(), "winter-instruction-boot-")), home = join(parent, "home"), elsewhere = join(parent, "db-backing");
 cleanup.push(() => rmSync(parent, { recursive: true, force: true })); mkdirSync(home, { mode: 0o700 }); mkdirSync(elsewhere, { mode: 0o700 }); symlinkSync(elsewhere, join(home, "runtimes"));
 const daemon = await startDaemon({ home, secrets: new FileSecretStore(join(parent, "fixture-secrets.json")), agentProvider: null });
 try { const client = await Client.open(daemon.socketPath, daemon.tokens.harness, "harness"); const reply = await client.request("workspace.instructions.get", { workspaceId: "workspace-valid" }); expect(reply.error.data.code).toBe("unsupported_topology"); expect("unavailable" in daemon.runtimeState).toBe(false); }
 finally { await daemon.stop(); }
}, 15000);
