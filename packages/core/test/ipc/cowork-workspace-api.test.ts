import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COWORK_RPC, ConnWriter, LineDecoder, PROTOCOL_VERSION, encodeLine, type WritableSocket } from "@yanlinglabs/winter-protocol";
import { startDaemon, type RunningDaemon } from "../../src/daemon";
import { FileSecretStore } from "../../src/auth/secret-store";
import { CoworkRepository } from "../../src/cowork/repository";
import { runtimeStateOnline } from "../../src/runtime-state/wiring";
import type { CoworkHostPorts } from "../../src/cowork/service";
import { CoworkError, type SourceSelection } from "../../src/cowork/types";

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
const ceiling = { toolClasses: ["read", "write"], hostServices: [], connectors: [], network: "none" as const };
const folder: Extract<SourceSelection, { kind: "folder" }> = { kind: "folder", label: "Fixture Folder", access: "read-write", detail: { grantRef: "grant-local", rootIdentity: "private-root-identity" } };
const repo: Extract<SourceSelection, { kind: "githubRepository" }> = { kind: "githubRepository", label: "Fixture Repository", access: "read-write", detail: { repositoryId: "repo-fixture", authorityRef: "private-account-reference", initialRef: "main" } };
let daemon: RunningDaemon | undefined; const homes: string[] = [], clients: Client[] = [];
afterEach(async () => { clients.splice(0).forEach(client => client.close()); if (daemon) { await daemon.stop(); daemon = undefined; } homes.splice(0).forEach(home => rmSync(home, { recursive: true, force: true })); });
async function boot(fixture = true) {
  const home = mkdtempSync(join(tmpdir(), "winter-cowork-api-")); homes.push(home);
  const scopes = new Set<string>(), repos = new Set([repo.detail.authorityRef]); let revoked = false, admit = fixture;
  const ports: CoworkHostPorts = {
    principal: connection => connection.role === "remote" ? { kind: "paired-user", id: "paired-fixture", workspaceIds: new Set(scopes), repositoryAuthorities: new Set(repos) } : { kind: "local-user", id: "local-fixture" },
    grants: { folder: grant => grant === folder.detail.grantRef ? { rootIdentity: folder.detail.rootIdentity, writable: true, revoked } : undefined, repository: (authority, repository) => authority === repo.detail.authorityRef && repository === repo.detail.repositoryId ? { readable: true, writable: true, revoked } : undefined },
    selection: (_principal, selection) => selection === "folder-choice" ? folder : selection === "repo-choice" ? repo : undefined,
    creationCeiling: () => ceiling,
    requireProvisioning: () => { if (!admit) throw new CoworkError("unsupported_topology"); },
  };
  daemon = await startDaemon({ home, secrets: new FileSecretStore(join(home, "secrets")), agentProvider: null, ...(fixture ? { coworkHost: ports } : {}) });
  const records = new CoworkRepository(runtimeStateOnline(daemon.runtimeState)!.db);
  const local = await Client.connect(join(home, "run/core.sock"), daemon.tokens.harness), remote = await Client.connect(join(home, "run/core.sock"), daemon.tokens.remote, "remote");
  clients.push(local, remote);
  return { home, records, scopes, repos, ports, local, remote, revokeGrant: () => { revoked = true; }, disable: () => { admit = false; } };
}
async function create(client: Client, requestId: string, selections = [{ selectionId: "repo-choice", kind: "githubRepository" }]) {
  const reply = await client.request("workspace.create", { requestId, ownership: "project", title: "API Fixture", selections });
  expect(reply.error).toBeUndefined(); expect(COWORK_RPC["workspace.create"].result.safeParse(reply.result).success).toBe(true);
  return reply.result;
}

describe("Cowork workspace API through a real isolated daemon and Unix RPC", () => {
  test("host fixture create, effective acknowledgment, policy, source removal/revocation, operation and cold reload", async () => {
    const fixture = await boot(), made = await create(fixture.local, "create-one"), workspaceId = made.workspaceId, sourceId = made.value.sources[0].sourceId;
    expect(made.value.sources[0].state).toBe("preparing"); expect(made.value.power).toBe("stopped");
    expect(await create(fixture.local, "create-one")).toEqual(made);
    const wire = JSON.stringify(made); for (const privateValue of [repo.detail.authorityRef, repo.detail.repositoryId, "detail", "rootIdentity", "grantRef", "incarnationId"]) expect(wire.includes(privateValue)).toBe(false);
    const epoch = fixture.records.beginIncarnation(workspaceId, "fixture-boot", made.revision);
    fixture.records.acknowledgeSource(epoch, sourceId, 1, "ready");
    const op = await fixture.local.request("workspace.operation.get", { workspaceId, operationId: made.operationId }); expect(op.result.status).toBe("applied");
    const policy = await fixture.local.request("project.setDefaultPolicy", { projectId: made.value.ownerId, requestId: "policy", expectedRevision: 1, defaultPolicy: "plan" }); expect(policy.result.value.defaultPolicy).toBe("plan");
    expect(await create(fixture.local, "create-one")).toEqual(made);
    const added = await fixture.local.request("workspace.source.addFolder", { workspaceId, requestId: "add", expectedRevision: 2, selectionId: "folder-choice" }); expect(added.result.value.state).toBe("preparing");
    expect((await fixture.local.request("workspace.source.remove", { workspaceId, sourceId, requestId: "stale", expectedRevision: 2 })).error.data).toEqual({ code: "revision_conflict", currentRevision: 3 });
    const removed = await fixture.local.request("workspace.source.remove", { workspaceId, sourceId, requestId: "remove", expectedRevision: 3 }); expect(removed.result.value.state).toBe("removing");
    const last = added.result.value.sourceId;
    expect((await fixture.local.request("workspace.source.remove", { workspaceId, sourceId: last, requestId: "last", expectedRevision: 4 })).error.data.code).toBe("last_source_required");
    const revoked = await fixture.local.request("workspace.source.revoke", { workspaceId, sourceId: last, requestId: "revoke", expectedRevision: 4 }); expect(revoked.result.value.state).toBe("unavailable");
    expect(() => fixture.records.acknowledgeSource(epoch, sourceId, 1, "ready")).toThrow("stale_acknowledgment");
    fixture.disable(); fixture.revokeGrant();
    expect((await fixture.local.request("workspace.source.addFolder", { workspaceId, requestId: "disabled", expectedRevision: 5, selectionId: "folder-choice" })).error.data.code).toBe("unsupported_topology");
    const before = (await fixture.local.request("workspace.get", { workspaceId })).result;
    clients.splice(0).forEach(client => client.close()); await daemon!.stop();
    daemon = await startDaemon({ home: fixture.home, secrets: new FileSecretStore(join(fixture.home, "secrets")), agentProvider: null, coworkHost: fixture.ports });
    const reconnected = await Client.connect(join(fixture.home, "run/core.sock"), daemon.tokens.harness); clients.push(reconnected);
    expect((await reconnected.request("workspace.get", { workspaceId })).result).toEqual(before);
  });
  test("paired scope filters lists, checks every record and source parent, and rechecks revocation", async () => {
    const fixture = await boot(), first = await create(fixture.local, "first"), second = await create(fixture.local, "second");
    expect((await fixture.remote.request("workspace.list")).result.workspaces).toEqual([]);
    fixture.scopes.add(first.workspaceId);
    expect((await fixture.remote.request("workspace.list")).result.workspaces.map((value: any) => value.workspaceId)).toEqual([first.workspaceId]);
    expect((await fixture.remote.request("workspace.get", { workspaceId: second.workspaceId })).error.data.code).toBe("authority_denied");
    expect((await fixture.remote.request("workspace.source.get", { workspaceId: first.workspaceId, sourceId: second.value.sources[0].sourceId })).error.data.code).toBe("not_found");
    const update = await fixture.remote.request("project.update", { projectId: first.value.ownerId, requestId: "rename", expectedRevision: 1, title: "Renamed" }); expect(update.result.value.title).toBe("Renamed");
    expect((await fixture.remote.request("workspace.operation.get", { workspaceId: first.workspaceId, operationId: update.result.operationId })).result.status).toBe("applied");
    const added = await fixture.remote.request("workspace.source.addRepository", { workspaceId: first.workspaceId, requestId: "repo-add", expectedRevision: 2, selectionId: "repo-choice" }); expect(added.error).toBeUndefined();
    fixture.repos.clear();
    expect((await fixture.remote.request("workspace.source.addRepository", { workspaceId: first.workspaceId, requestId: "repo-refused", expectedRevision: 3, selectionId: "repo-choice" })).error.data.code).toBe("authority_denied");
    expect((await fixture.remote.request("workspace.setDefaultPolicy", { workspaceId: first.workspaceId, requestId: "policy", expectedRevision: 3, defaultPolicy: "bypass" })).error).toBeDefined();
    expect((await fixture.remote.request("workspace.source.addFolder", { workspaceId: first.workspaceId, requestId: "folder", expectedRevision: 3, selectionId: "folder-choice" })).error).toBeDefined();
    fixture.scopes.clear(); expect((await fixture.remote.request("project.get", { projectId: first.value.ownerId })).error.data.code).toBe("authority_denied");
    expect((await fixture.remote.request("workspace.operation.get", { workspaceId: first.workspaceId, operationId: first.operationId })).error.data.code).toBe("authority_denied");
  });
  test("typed canonical policy setters enforce the host ceiling and scope idempotency to the RPC method", async () => {
    const fixture = await boot(), made = await create(fixture.local, "policy-workspace"), workspaceId = made.workspaceId;
    expect((await fixture.local.request("project.get", { projectId: made.value.ownerId })).result.workspace.workspaceId).toBe(workspaceId);
    expect((await fixture.local.request("project.list")).result.projects[0].projectId).toBe(made.value.ownerId);
    expect((await fixture.local.request("workspace.source.list", { workspaceId })).result.sources[0].sourceId).toBe(made.value.sources[0].sourceId);
    const publication = await fixture.local.request("workspace.setPublicationPolicy", { workspaceId, requestId: "same-id", expectedRevision: 1, publication: "manual" }); expect(publication.result.value.publication).toBe("manual");
    expect((await fixture.local.request("workspace.get", { workspaceId })).result.automaticPublication).toBe(false);
    const widened = await fixture.local.request("workspace.setCapabilityCeiling", { workspaceId, requestId: "ceiling-wide", expectedRevision: 2, ceiling: { ...ceiling, toolClasses: ["execute"] } }); expect(widened.error.data.code).toBe("authority_denied");
    const narrowed = await fixture.local.request("workspace.setCapabilityCeiling", { workspaceId, requestId: "same-id", expectedRevision: 2, ceiling: { ...ceiling, toolClasses: ["read"] } }); expect(narrowed.result.value.ceiling.toolClasses).toEqual(["read"]);
    const changed = await fixture.local.request("workspace.setDefaultPolicy", { workspaceId, requestId: "same-id", expectedRevision: 3, defaultPolicy: "ask" }); expect(changed.result.value.defaultPolicy).toBe("ask");
    expect((await fixture.local.request("workspace.setDefaultPolicy", { workspaceId, requestId: "same-id", expectedRevision: 3, defaultPolicy: "plan" })).error.data.code).toBe("request_conflict");
    fixture.ports.principal = () => ({ kind: "runtime", id: "guest-fixture", workspaceId, sessionId: "guest-session" });
    expect((await fixture.local.request("workspace.get", { workspaceId })).error.data.code).toBe("authority_denied");
  });
  test("response budget rejects a mutation before commit and bounded pages preserve scoped cursors", async () => {
    const fixture = await boot();
    const many = Array.from({ length: 256 }, (_value, index) => `${index}-` + "x".repeat(190));
    fixture.ports.creationCeiling = () => ({ toolClasses: many, hostServices: many, connectors: many, network: "none" });
    const refused = await fixture.local.request("project.create", { requestId: "too-large", title: "Large", selections: [{ selectionId: "repo-choice", kind: "githubRepository" }] });
    expect(refused.error.data.code).toBe("response_too_large");
    expect(fixture.records.list()).toEqual([]);
    expect(fixture.records.rs.db.query("SELECT count(*) AS n FROM cowork_operations").get()).toEqual({ n: 0 });
    fixture.ports.creationCeiling = () => ceiling;
    const a = await create(fixture.local, "a"), b = await create(fixture.local, "b");
    fixture.scopes.add(a.workspaceId); fixture.scopes.add(b.workspaceId);
    const page = await fixture.remote.request("workspace.list", { limit: 1 }); expect(page.result.workspaces).toHaveLength(1);
    expect(page.result.nextCursor).toBe(a.workspaceId);
    expect((await fixture.remote.request("workspace.list", { limit: 1, cursor: page.result.nextCursor })).result.workspaces[0].workspaceId).toBe(b.workspaceId);
    fixture.scopes.delete(a.workspaceId);
    expect((await fixture.remote.request("workspace.list", { limit: 1, cursor: page.result.nextCursor })).error.data.code).toBe("invalid_request");
    const invalid = await fixture.local.request("workspace.get", { workspaceId: b.workspaceId, principalId: "forged-user" }); expect(invalid.error.data.code).toBe("invalid_request");
  });
  test("production create stays blocked and raw grant/path/authority inputs never become host selections", async () => {
    const production = await boot(false);
    expect((await production.local.request("workspace.create", { requestId: "create", ownership: "standalone", title: "Unavailable", selections: [{ selectionId: "repo-choice", kind: "githubRepository" }] })).error.data.code).toBe("unsupported_topology");
    expect((await production.remote.request("workspace.list")).error.data.code).toBe("authority_denied");
    expect(production.records.list()).toEqual([]);
    expect((await production.local.request("workspace.create", { requestId: "injected", ownership: "standalone", title: "Bad", selections: [{ selectionId: "folder-choice", kind: "folder", path: "/private", grantRef: "forged" }] })).error.data.code).toBe("invalid_request");
  });
});
