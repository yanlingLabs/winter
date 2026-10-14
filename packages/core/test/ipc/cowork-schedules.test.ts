import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COWORK_RPC, COWORK_REMOTE_METHODS, ConnWriter, LineDecoder, PROTOCOL_VERSION, encodeLine, type WritableSocket } from "@yanlinglabs/winter-protocol";
import { startDaemon, type RunningDaemon } from "../../src/daemon";
import { FileSecretStore } from "../../src/auth/secret-store";
import { runtimeStateOnline } from "../../src/runtime-state/wiring";
import { CoworkRepository } from "../../src/cowork/repository";
import { CoworkWorkspaceService, type CoworkHostPorts } from "../../src/cowork/service";
import { REMOTE_ALLOWED_METHODS } from "../../src/ipc/server";
class Client {
  private decoder = new LineDecoder(); private next = 1;
  private pending = new Map<number, { resolve(value: any): void; timer: ReturnType<typeof setTimeout> }>();
  private socket!: Awaited<ReturnType<typeof Bun.connect>>; private writer!: ConnWriter;
  static async connect(path: string, token: string, role = "harness") {
    const client = new Client();
    client.socket = await Bun.connect({ unix: path, socket: {
      data(_socket, bytes) { for (const line of client.decoder.push(bytes)) { const reply = JSON.parse(line), pending = client.pending.get(reply.id); if (pending) { clearTimeout(pending.timer); client.pending.delete(reply.id); pending.resolve(reply); } } },
      drain() { client.writer.onDrain(); },
    } });
    client.writer = new ConnWriter(client.socket as unknown as WritableSocket);
    expect((await client.request("protocol.hello", { protocolVersion: PROTOCOL_VERSION, token, role, clientName: "fixture" })).error).toBeUndefined();
    return client;
  }
  request(method: string, params: unknown = {}): Promise<any> {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("RPC timeout")); }, 10_000);
      this.pending.set(id, { resolve, timer }); this.writer.enqueue(encodeLine({ jsonrpc: "2.0", id, method, params }));
    });
  }
  close() { this.socket.end(); }
}
const caps = { toolClasses: ["read"], hostServices: [], connectors: [], network: "none" as const };
let daemon: RunningDaemon | undefined, home: string | undefined; const clients: Client[] = [];
afterEach(async () => { clients.splice(0).forEach(client => client.close()); if (daemon) await daemon.stop(); daemon = undefined; if (home) rmSync(home, { recursive: true, force: true }); home = undefined; });
test("isolated daemon accepts canonical metadata, restarts missed timers and never creates Code sessions", async () => {
  home = mkdtempSync(join(tmpdir(), "winter-schedule-rpc-")); let time = 0;
  const host: CoworkHostPorts = { principal: connection => connection.role === "remote" ? { kind: "paired-user", id: "phone", workspaceIds: new Set(), repositoryAuthorities: new Set() } : { kind: "local-user", id: "fixture" }, grants: { folder: () => ({ rootIdentity: "fixture-root", writable: true, revoked: false }), repository: () => undefined }, selection: () => undefined, creationCeiling: () => caps, requireProvisioning: () => { throw new Error("native unavailable"); } };
  const boot = async () => { daemon = await startDaemon({ home: home!, secrets: new FileSecretStore(join(home!, "secrets")), agentProvider: null, coworkHost: host, coworkScheduleNow: () => time }); const client = await Client.connect(join(home!, "run/core.sock"), daemon.tokens.harness); clients.push(client); return client; };
  let local = await boot(); const records = new CoworkRepository(runtimeStateOnline(daemon!.runtimeState)!.db);
  const made = records.create({ principalId: "fixture", requestId: "workspace" }, { ownership: "project", title: "Fixture", ceiling: caps, sources: [{ kind: "folder", label: "Fixture", access: "read-write", detail: { grantRef: "fixture-grant", rootIdentity: "fixture-root" } }] });
  const definition = { target: { kind: "project", projectId: made.value.workspace.ownerId }, sourceId: made.value.sources[0]!.sourceId, prompt: "fixture prompt", timing: { kind: "recurring", spec: "every 1s" }, timezone: "UTC", savedCeiling: caps, policy: "auto", overlap: "one-active-one-pending" };
  const created = await local.request("workspace.schedule.create", { workspaceId: made.workspaceId, requestId: "schedule", definition }); expect(created.error).toBeUndefined(); expect(COWORK_RPC["workspace.schedule.create"].result.safeParse(created.result).success).toBe(true);
  const params = { workspaceId: made.workspaceId, scheduleId: created.result.scheduleId };
  expect((await local.request("workspace.schedule.create", { workspaceId: made.workspaceId, requestId: "schedule", definition })).result).toEqual(created.result);
  expect((await local.request("workspace.schedule.create", { workspaceId: made.workspaceId, requestId: "bad", definition: { ...definition, cwd: "/workspace/source" } })).error.data.code).toBe("invalid_request");
  const shutdownHandler = new CoworkWorkspaceService(records, host, () => time);
  shutdownHandler.beginShutdown();
  expect(() => shutdownHandler.call({ role: "harness", connectionId: 99 }, "workspace.schedule.create", { workspaceId: made.workspaceId, requestId: "during-shutdown", definition })).toThrow("authority_denied");
  const remote = await Client.connect(join(home!, "run/core.sock"), daemon!.tokens.remote, "remote"); clients.push(remote);
  for (const method of ["create", "cancel", "list", "status"]) expect((await remote.request(`workspace.schedule.${method}`, params)).error).toBeDefined();
  clients.splice(0).forEach(client => client.close()); await daemon!.stop(); daemon = undefined; time = 5000; local = await boot();
  const status = (await local.request("workspace.schedule.status", params)).result;
  expect(status.execution).toBe("unavailable"); expect(status.occurrences).toHaveLength(1); expect(status.occurrences[0].state).toBe("pending"); expect(status.occurrences[0].reason).toBe("execution_unavailable"); expect(status.occurrences[0].missedCount).toBe(4);
  expect((await local.request("workspace.schedule.list", { workspaceId: made.workspaceId })).result.schedules).toHaveLength(1);
  expect((await local.request("session.list", {})).result.sessions).toHaveLength(0);
  const cancelled = await local.request("workspace.schedule.cancel", { ...params, expectedRevision: 1 }); expect(cancelled.error).toBeUndefined(); expect(cancelled.result.state).toBe("cancelled");
  expect((await local.request("workspace.schedule.status", params)).result.occurrences[0].state).toBe("cancelled");
});
test("all four remote allowlist mirrors exclude schedule metadata", () => {
  // All remote routing mirrors retain their existing set. This metadata slice is local-only.
  for (const method of ["create", "cancel", "list", "status"].map(value => `workspace.schedule.${value}`)) {
    expect(REMOTE_ALLOWED_METHODS.has(method)).toBe(false); expect((COWORK_REMOTE_METHODS as readonly string[]).includes(method)).toBe(false);
    const root = join(import.meta.dir, "../../../..");
    const mirrors = ["apple/WinterKit/Sources/WinterKit/Gateway/Gateway.swift", "apple/WinterKit/Tests/WinterKitTests/GatewayGateTests.swift", "packages/core/test/ipc/remote-allowlist-parity.test.ts"];
    for (const path of mirrors) expect(readFileSync(join(root, path), "utf8").includes(`"${method}"`)).toBe(false);
  }
});
