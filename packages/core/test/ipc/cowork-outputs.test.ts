import { afterEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { COWORK_RPC, COWORK_REMOTE_METHODS, ERR, ConnWriter, LineDecoder, PROTOCOL_VERSION, encodeLine, type WritableSocket } from "@yanlinglabs/winter-protocol";
import { FileSecretStore } from "../../src/auth/secret-store";
import { TokenAuthority } from "../../src/auth/tokens";
import { SessionHub } from "../../src/sessions/hub";
import { startIpcServer, REMOTE_ALLOWED_METHODS } from "../../src/ipc/server";
import { outputFixture } from "../cowork/output-fixture";
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const METHODS = ["workspace.output.list", "workspace.file.stat", "workspace.file.read", "workspace.file.readRange"] as const;
class Client {
 private decoder = new LineDecoder(); private next = 1; private pending = new Map<number, (reply: any) => void>(); private socket!: Awaited<ReturnType<typeof Bun.connect>>; private writer!: ConnWriter;
 static async open(path: string, token: string, role: "harness" | "remote") { const c = new Client(); c.socket = await Bun.connect({ unix: path, socket: { data: (_s, bytes) => { for (const line of c.decoder.push(bytes)) { const reply = JSON.parse(line); if (typeof reply.id === "number") { const callback = c.pending.get(reply.id); c.pending.delete(reply.id); callback?.(reply); } } }, drain: () => c.writer?.onDrain() } }); c.writer = new ConnWriter(c.socket as WritableSocket); cleanup.push(() => c.socket.end()); const hello = await c.request("protocol.hello", { role, token, protocolVersion: PROTOCOL_VERSION, clientName: "output-fixture" }); expect(hello.error).toBeUndefined(); return c; }
 request(method: string, params: unknown) { const id = this.next++; return new Promise<any>((resolve, reject) => { const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("fixture RPC timeout")); }, 5000); this.pending.set(id, r => { clearTimeout(timer); resolve(r); }); this.writer.enqueue(encodeLine({ jsonrpc: "2.0", id, method, params })); }); }
}
async function fixture() {
 const f = outputFixture(); cleanup.push(() => f.close());
 const tokens = new TokenAuthority(new FileSecretStore(join(f.home, "fixture-secrets.json"))), keys = await tokens.ensureTokens(), socketPath = join(f.home, "fixture.sock");
 const server = startIpcServer({ socketPath, serverVersion: "fixture", tokens, store: f.store, hub: new SessionHub(f.store), cowork: f.service }); cleanup.push(() => server.stop());
 return { ...f, client: await Client.open(socketPath, keys.harness, "harness"), remote: await Client.open(socketPath, keys.remote, "remote") };
}
test("real Unix RPC exposes only canonical inventory and refuses missing identity without seeding", async () => {
 const f = await fixture(); expect((await f.client.request("workspace.output.list", { workspaceId: f.workspaceId })).result).toEqual({ locations: [], nextCursor: null });
 const params = { workspaceId: f.workspaceId, locationId: "unknown", relativePath: "file.bin", expectedLocationRevision: 1 };
 expect((await f.client.request("workspace.file.stat", params)).error.data.code).toBe("authority_denied");
 expect((await f.client.request("workspace.file.stat", { ...params, path: "/host" })).error.data.code).toBe("invalid_request");
 expect((await f.client.request("workspace.output.initialize", { workspaceId: f.workspaceId, sessionId: f.sessionId })).error.code).toBe(ERR.METHOD_NOT_FOUND);
 expect(existsSync(f.root)).toBe(false);
 for (const method of METHODS) { expect((COWORK_REMOTE_METHODS as readonly string[]).includes(method)).toBe(false); expect(REMOTE_ALLOWED_METHODS.has(method)).toBe(false); expect((await f.remote.request(method, {})).error.code).toBe(ERR.UNAUTHORIZED); }
 const gateway = readFileSync(join(import.meta.dir, "../../../../apple/WinterKit/Sources/WinterKit/Gateway/Gateway.swift"), "utf8");
 for (const method of METHODS) expect(gateway).not.toContain(`"${method}"`);
 const gateTests = readFileSync(join(import.meta.dir, "../../../../apple/WinterKit/Tests/WinterKitTests/GatewayGateTests.swift"), "utf8"); expect(gateTests).toContain("Gateway.remoteAllowedMethods.count, 40");
});
const native = process.platform === "darwin" && process.arch === "arm64" && process.env.WINTER_COWORK_OUTPUT_FS_FIXTURE === "1" ? test : test.skip;
native("real Unix RPC stat/read/readRange returns bounded binary chunks and rejects stale generations", async () => {
 const f = await fixture(); f.service.outputs!.initialize(f.workspaceId, f.sessionId, f.store);
 const page = (await f.client.request("workspace.output.list", { workspaceId: f.workspaceId })).result, location = page.locations[0];
 COWORK_RPC["workspace.output.list"].result.parse(page); writeFileSync(join(f.root, "file.bin"), Buffer.alloc(262145, 255));
 const params = { workspaceId: f.workspaceId, locationId: location.locationId, relativePath: "file.bin", expectedLocationRevision: 1 };
 const stat = (await f.client.request("workspace.file.stat", params)).result; COWORK_RPC["workspace.file.stat"].result.parse(stat);
 const read = (await f.client.request("workspace.file.read", { ...params, expectedGeneration: stat.generation, maxBytes: 262144 })).result; COWORK_RPC["workspace.file.read"].result.parse(read);
 expect(Buffer.from(read.contentBase64, "base64").length).toBe(262144); expect(read.eof).toBe(false); expect(Buffer.byteLength(JSON.stringify(read))).toBeLessThan(384 * 1024);
 const tail = (await f.client.request("workspace.file.readRange", { ...params, expectedGeneration: stat.generation, offset: read.nextOffset, maxBytes: 262144 })).result; expect(Buffer.from(tail.contentBase64, "base64")).toEqual(Buffer.from([255])); expect(tail.eof).toBe(true);
 expect((await f.client.request("workspace.file.readRange", { ...params, expectedGeneration: stat.generation, offset: 0, maxBytes: 262145 })).error.data.code).toBe("invalid_request");
 writeFileSync(join(f.root, "file.bin"), "changed"); expect((await f.client.request("workspace.file.read", { ...params, expectedGeneration: stat.generation })).error.data.code).toBe("stale_file");
 expect(JSON.stringify(page)).not.toContain(f.home); expect(JSON.stringify(stat)).not.toContain(f.home);
});
