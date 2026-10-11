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
    const wire = JSON.stringify(made); for (const privateValue of [repo.detail.authorityRef, repo.detail.repositoryId, '"detail":', "rootIdentity", "grantRef", "incarnationId"]) expect(wire.includes(privateValue)).toBe(false);
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
  test("small source receipts cannot commit an unreadable aggregate; admitted lifecycle changes stay readable", async () => {
    const fixture = await boot();
    const names = Array.from({ length: 200 }, (_value, index) => `${index}-` + "x".repeat(187));
    fixture.ports.creationCeiling = () => ({ toolClasses: names, hostServices: names, connectors: names, network: "none" });
    fixture.ports.selection = () => ({ ...repo, label: "r".repeat(200) });
    const made = await create(fixture.local, "aggregate"), workspaceId = made.workspaceId;
    fixture.scopes.add(workspaceId);
    let refused = false;
    for (let index = 0; index < 50; index++) {
      const revision = fixture.records.get(workspaceId).configRevision;
      const before = fixture.records.sources(workspaceId).length;
      const operations = fixture.records.rs.db.query("SELECT count(*) AS n FROM cowork_operations").get();
      const outbox = fixture.records.rs.db.query("SELECT count(*) AS n FROM cowork_outbox").get();
      const added = await fixture.remote.request("workspace.source.addRepository", { workspaceId, requestId: `aggregate-${index}`, expectedRevision: revision, selectionId: "repo-choice" });
      if (added.error) {
        expect(added.error.data.code).toBe("response_too_large");
        expect(fixture.records.get(workspaceId).configRevision).toBe(revision);
        expect(fixture.records.sources(workspaceId)).toHaveLength(before);
        expect(fixture.records.rs.db.query("SELECT count(*) AS n FROM cowork_operations").get()).toEqual(operations);
        expect(fixture.records.rs.db.query("SELECT count(*) AS n FROM cowork_outbox").get()).toEqual(outbox);
        refused = true; break;
      }
      expect(added.result.value.label).toHaveLength(200);
      for (const [method, params] of [["workspace.get", { workspaceId }], ["project.get", { projectId: made.value.ownerId }], ["workspace.list", {}], ["project.list", {}]] as const) {
        const reply = await fixture.remote.request(method, params); expect(reply.error).toBeUndefined();
        const snapshot = reply.result.workspace ?? reply.result.workspaces?.[0] ?? reply.result.projects?.[0]?.workspace ?? reply.result;
        expect(snapshot.detailState).toBe("complete");
      }
    }
    expect(refused).toBe(true);
    for (const source of fixture.records.sources(workspaceId)) {
      const revoked = await fixture.remote.request("workspace.source.revoke", { workspaceId, sourceId: source.sourceId, requestId: `revoke-${source.sourceId}`, expectedRevision: fixture.records.get(workspaceId).configRevision });
      expect(revoked.error).toBeUndefined();
    }
    for (const [method, params] of [["workspace.get", { workspaceId }], ["project.get", { projectId: made.value.ownerId }], ["workspace.list", {}], ["project.list", {}]] as const) {
        const reply = await fixture.remote.request(method, params); expect(reply.error).toBeUndefined();
        const snapshot = reply.result.workspace ?? reply.result.workspaces?.[0] ?? reply.result.projects?.[0]?.workspace ?? reply.result;
        expect(snapshot.detailState).toBe("complete");
      }
  });
  test("capability expansion reserves aggregate and list envelopes, not only its policy receipt", async () => {
    const fixture = await boot();
    fixture.ports.selection = () => ({ ...repo, label: "r".repeat(200) });
    const made = await create(fixture.local, "policy-aggregate", Array.from({ length: 40 }, () => ({ selectionId: "repo-choice", kind: "githubRepository" }))), workspaceId = made.workspaceId;
    const names = Array.from({ length: 200 }, (_value, index) => `${index}-` + "x".repeat(187));
    const large = { toolClasses: names, hostServices: names, connectors: names, network: "none" as const };
    fixture.ports.creationCeiling = () => large;
    // The policy-only response fits, but the 40 source aggregate does not.
    expect(Buffer.byteLength(JSON.stringify(large))).toBeLessThan(128 * 1024);
    const refused = await fixture.local.request("workspace.setCapabilityCeiling", { workspaceId, requestId: "policy-expansion", expectedRevision: 1, ceiling: large });
    expect(refused.error.data.code).toBe("response_too_large");
    expect(fixture.records.get(workspaceId).configRevision).toBe(1);
    expect(fixture.records.policy(workspaceId).ceiling).toEqual(ceiling);
    expect((await fixture.local.request("workspace.get", { workspaceId })).error).toBeUndefined();
  });
  test("legacy oversized records remain discoverable with explicit summaries and scoped paged recovery", async () => {
    const fixture = await boot();
    const names = Array.from({ length: 256 }, (_value, index) => `${index}-` + "界".repeat(187));
    // Simulate a record persisted by the internal repository before aggregate API admission.
    const made = fixture.records.create({ principalId: "migration-fixture", requestId: "legacy" }, { ownership: "project", title: "Legacy", sources: [repo], ceiling: { toolClasses: names, hostServices: names, connectors: names, network: "internet" } });
    const workspaceId = made.workspaceId, sourceId = made.value.sources[0]!.sourceId;
    fixture.scopes.add(workspaceId);
    const healthy = await create(fixture.local, "healthy-after-legacy"); fixture.scopes.add(healthy.workspaceId);
    const snapshot = (await fixture.remote.request("workspace.get", { workspaceId })).result;
    expect(snapshot.detailState).toBe("summary"); expect(snapshot.detailReason).toBe("response_limit");
    expect(snapshot.workspaceId).toBe(workspaceId); expect(snapshot.configRevision).toBe(1);
    expect(snapshot.sourceCount).toBe(1); expect(snapshot.policySummary.capabilityCounts.toolClasses).toBe(256);
    expect(snapshot.policy).toBeUndefined(); expect(snapshot.sources).toBeUndefined();
    expect(snapshot.detailMethods).toEqual({ sources: "workspace.source.list", policy: "workspace.policy.get" });
    expect(COWORK_RPC["workspace.get"].result.safeParse({ ...snapshot, policy: { ceiling: {} } }).success).toBe(false);
    expect((await fixture.remote.request("project.get", { projectId: made.value.workspace.ownerId })).result.workspace).toEqual(snapshot);
    const listed = (await fixture.remote.request("workspace.list")).result.workspaces;
    expect(listed.map((value: any) => [value.workspaceId, value.detailState])).toEqual([[workspaceId, "summary"], [healthy.workspaceId, "complete"]]);
    expect((await fixture.remote.request("project.list")).result.projects.map((value: any) => value.workspace.detailState)).toEqual(["summary", "complete"]);
    let cursor: string | undefined, firstPolicyCursor: string | undefined; const entries: { kind: string; name: string }[] = [];
    do {
      const page = await fixture.remote.request("workspace.policy.get", { workspaceId, cursor, limit: 100, expectedRevision: 1 });
      expect(page.error).toBeUndefined(); expect(Buffer.byteLength(JSON.stringify(page.result))).toBeLessThanOrEqual(128 * 1024);
      firstPolicyCursor ??= page.result.nextCursor ?? undefined;
      entries.push(...page.result.entries); cursor = page.result.nextCursor ?? undefined;
    } while (cursor);
    for (const kind of ["toolClasses", "hostServices", "connectors"] as const) expect(entries.filter(value => value.kind === kind).map(value => value.name)).toEqual(fixture.records.policy(workspaceId).ceiling[kind]);
    expect((await fixture.remote.request("workspace.policy.get", { workspaceId, cursor: "bad" })).error.data.code).toBe("invalid_request");
    expect((await fixture.remote.request("workspace.policy.get", { workspaceId, cursor: "1:768" })).error.data.code).toBe("invalid_request");
    expect((await fixture.remote.request("workspace.source.list", { workspaceId })).result.sources[0].sourceId).toBe(sourceId);
    const revoked = await fixture.remote.request("workspace.source.revoke", { workspaceId, sourceId, requestId: "legacy-revoke", expectedRevision: 1 });
    expect(revoked.error).toBeUndefined(); expect(revoked.result.value.state).toBe("unavailable");
    expect((await fixture.remote.request("workspace.source.revoke", { workspaceId, sourceId, requestId: "legacy-revoke", expectedRevision: 1 })).result).toEqual(revoked.result);
    const recovered = await fixture.local.request("workspace.setCapabilityCeiling", { workspaceId, requestId: "legacy-narrow", expectedRevision: 2, ceiling: { toolClasses: [], hostServices: [], connectors: [], network: "none" } });
    expect(recovered.error).toBeUndefined();
    expect((await fixture.remote.request("workspace.policy.get", { workspaceId, cursor: firstPolicyCursor })).error.data).toEqual({ code: "revision_conflict", currentRevision: 2 });
    expect((await fixture.remote.request("workspace.get", { workspaceId })).result.detailState).toBe("complete");
    for (const [method, params] of [["workspace.get", { workspaceId }], ["project.get", { projectId: made.value.workspace.ownerId }], ["workspace.list", {}], ["project.list", {}]] as const) expect((await fixture.remote.request(method, params)).error).toBeUndefined();
    expect(fixture.records.source(workspaceId, sourceId).state).toBe("unavailable");
    fixture.scopes.delete(workspaceId);
    expect((await fixture.remote.request("workspace.policy.get", { workspaceId })).error.data.code).toBe("authority_denied");
  });
  test("scoped source pages preserve complete details and refuse stale configuration cursors", async () => {
    const fixture = await boot(), made = await create(fixture.local, "source-pages", Array.from({ length: 3 }, () => ({ selectionId: "repo-choice", kind: "githubRepository" }))), workspaceId = made.workspaceId;
    fixture.scopes.add(workspaceId);
    const first = await fixture.remote.request("workspace.source.list", { workspaceId, limit: 1, expectedRevision: 1 });
    expect(first.result.sources).toHaveLength(1); expect(first.result.nextCursor).toMatch(/^sources:/); expect(first.result.nextCursor.length).toBeLessThanOrEqual(200);
    const second = await fixture.remote.request("workspace.source.list", { workspaceId, cursor: first.result.nextCursor, limit: 1 });
    expect(second.result.sources[0].sourceId).not.toBe(first.result.sources[0].sourceId);
    const third = await fixture.remote.request("workspace.source.list", { workspaceId, cursor: second.result.nextCursor, limit: 1 });
    expect(third.result.nextCursor).toBeNull();
    expect(new Set([first, second, third].map(reply => reply.result.sources[0].sourceId)).size).toBe(3);
    expect((await fixture.remote.request("workspace.source.revoke", { workspaceId, sourceId: first.result.sources[0].sourceId, requestId: "page-revoke", expectedRevision: 1 })).error).toBeUndefined();
    expect((await fixture.remote.request("workspace.source.list", { workspaceId, cursor: first.result.nextCursor })).error.data).toEqual({ code: "revision_conflict", currentRevision: 2 });
    fixture.scopes.clear();
    expect((await fixture.remote.request("workspace.source.list", { workspaceId })).error.data.code).toBe("authority_denied");
  });
  test("detach acknowledgment invalidates content cursors instead of silently skipping a remaining source", async () => {
    const fixture = await boot(), made = await create(fixture.local, "detach-cursor", Array.from({ length: 3 }, () => ({ selectionId: "repo-choice", kind: "githubRepository" }))), workspaceId = made.workspaceId;
    fixture.scopes.add(workspaceId);
    const [a, b, c] = fixture.records.sources(workspaceId);
    const removed = await fixture.local.request("workspace.source.remove", { workspaceId, sourceId: a!.sourceId, requestId: "remove-a", expectedRevision: 1 });
    expect(removed.error).toBeUndefined();
    const epoch = fixture.records.beginIncarnation(workspaceId, "detach-cursor-boot", 2);
    const first = await fixture.remote.request("workspace.source.list", { workspaceId, limit: 1, expectedRevision: 2 });
    expect(first.result.sources[0].sourceId).toBe(a!.sourceId);
    fixture.records.acknowledgeSource(epoch, a!.sourceId, removed.result.value.revision, "detached");
    expect(fixture.records.get(workspaceId).configRevision).toBe(2);
    const stale = await fixture.remote.request("workspace.source.list", { workspaceId, cursor: first.result.nextCursor, limit: 1 });
    expect(stale.error.data).toEqual({ code: "stale_cursor", currentRevision: 2 });
    const refreshed = await fixture.remote.request("workspace.source.list", { workspaceId, limit: 1, expectedRevision: 2 });
    const last = await fixture.remote.request("workspace.source.list", { workspaceId, cursor: refreshed.result.nextCursor, limit: 1 });
    expect([refreshed.result.sources[0].sourceId, last.result.sources[0].sourceId]).toEqual([b!.sourceId, c!.sourceId]);
    expect(last.result.nextCursor).toBeNull();
  });
  test("detail cursors are bound to their workspace and detail kind before offsets are interpreted", async () => {
    const fixture = await boot(), a = await create(fixture.local, "cursor-a", Array.from({ length: 3 }, () => ({ selectionId: "repo-choice", kind: "githubRepository" }))), b = await create(fixture.local, "cursor-b", Array.from({ length: 3 }, () => ({ selectionId: "repo-choice", kind: "githubRepository" })));
    fixture.scopes.add(a.workspaceId); fixture.scopes.add(b.workspaceId);
    const source = (await fixture.remote.request("workspace.source.list", { workspaceId: a.workspaceId, limit: 1 })).result.nextCursor;
    const policy = (await fixture.remote.request("workspace.policy.get", { workspaceId: a.workspaceId, limit: 1 })).result.nextCursor;
    expect(source).toBeString(); expect(policy).toBeString();
    for (const [method, workspaceId, cursor] of [["workspace.source.list", b.workspaceId, source], ["workspace.policy.get", b.workspaceId, policy], ["workspace.source.list", a.workspaceId, policy], ["workspace.policy.get", a.workspaceId, source]] as const) expect((await fixture.remote.request(method, { workspaceId, cursor })).error.data.code).toBe("invalid_request");
  });
  test("oversized legacy policies permit network and publication narrowing without discarding unrelated capabilities", async () => {
    const fixture = await boot();
    const names = Array.from({ length: 256 }, (_value, index) => `${index}-` + "x".repeat(187));
    const large = { toolClasses: names, hostServices: names, connectors: names, network: "internet" as const };
    const made = fixture.records.create({ principalId: "migration-fixture", requestId: "legacy-narrow" }, { ownership: "project", title: "Legacy", sources: [repo], ceiling: large }), workspaceId = made.workspaceId;
    const before = fixture.records.policy(workspaceId).ceiling;
    // Current host admission is the small fixture ceiling; it must not prevent removing access
    // from a legacy policy whose unrelated capability arrays remain larger than that ceiling.
    const request = { workspaceId, requestId: "network-off", expectedRevision: 1, ceiling: { ...before, network: "none" } };
    const network = await fixture.local.request("workspace.setCapabilityCeiling", request);
    expect(network.error).toBeUndefined(); expect(network.result.value.detailState).toBe("summary");
    expect(network.result.value.detailReason).toBe("response_limit"); expect(network.result.value.detailMethod).toBe("workspace.policy.get");
    expect(network.result.value.policySummary.network).toBe("none"); expect(network.result.value.policySummary.capabilityCounts).toEqual({ toolClasses: 256, hostServices: 256, connectors: 256 });
    expect(network.result.value.ceiling).toBeUndefined(); expect(Buffer.byteLength(JSON.stringify(network.result))).toBeLessThan(128 * 1024);
    expect(COWORK_RPC["workspace.setCapabilityCeiling"].result.safeParse(network.result).success).toBe(true);
    expect(COWORK_RPC["workspace.setCapabilityCeiling"].result.safeParse({ ...network.result, value: { ...network.result.value, ceiling: {} } }).success).toBe(false);
    const publicationRequest = { workspaceId, requestId: "publication-off", expectedRevision: 2, publication: "manual" };
    const publication = await fixture.local.request("workspace.setPublicationPolicy", publicationRequest);
    expect(publication.error).toBeUndefined(); expect(publication.result.value.detailState).toBe("summary"); expect(publication.result.value.policySummary.publication).toBe("manual");
    expect(fixture.records.policy(workspaceId).ceiling).toEqual({ ...before, network: "none" });
    expect(fixture.records.policy(workspaceId).publication).toBe("manual");
    expect((await fixture.local.request("workspace.get", { workspaceId })).result.automaticPublication).toBe(false);
    expect((await fixture.local.request("workspace.setCapabilityCeiling", request)).result).toEqual(network.result);
    expect((await fixture.local.request("workspace.setPublicationPolicy", publicationRequest)).result).toEqual(publication.result);
    const operation = await fixture.local.request("workspace.operation.get", { workspaceId, operationId: publication.result.operationId });
    expect(operation.result.revision).toBe(3); expect(operation.result.status).toBe("pending");
    fixture.ports.creationCeiling = () => large;
    const widenedNetwork = await fixture.local.request("workspace.setCapabilityCeiling", { workspaceId, requestId: "network-on", expectedRevision: 3, ceiling: before });
    expect(widenedNetwork.error.data.code).toBe("response_too_large");
    const widenedPublication = await fixture.local.request("workspace.setPublicationPolicy", { workspaceId, requestId: "publication-on", expectedRevision: 3, publication: "github-only-feature-branches" });
    expect(widenedPublication.error.data.code).toBe("response_too_large");
    expect(fixture.records.get(workspaceId).configRevision).toBe(3); expect(fixture.records.policy(workspaceId).ceiling.network).toBe("none"); expect(fixture.records.policy(workspaceId).publication).toBe("manual");
  });
  test("legacy maximum-width source details page by serialized bytes and every source remains recoverable", async () => {
    const fixture = await boot(); let nextId = 0;
    const legacy = new CoworkRepository(fixture.records.rs, () => "2026-10-11T00:00:00.000Z", prefix => `${prefix}_${nextId++}_`.padEnd(200, "x"));
    const made = legacy.create({ principalId: "migration-fixture", requestId: "wide-sources" }, { ownership: "project", title: "Legacy", sources: Array.from({ length: 100 }, () => ({ ...repo, label: "界".repeat(200) })), ceiling });
    const workspaceId = made.workspaceId; fixture.scopes.add(workspaceId);
    expect((await fixture.remote.request("workspace.get", { workspaceId })).result.detailState).toBe("summary");
    let cursor: string | undefined; const sources: string[] = [];
    do {
      const reply = await fixture.remote.request("workspace.source.list", { workspaceId, cursor, limit: 100, expectedRevision: 1 });
      expect(reply.error).toBeUndefined(); expect(reply.result.sources.length).toBeGreaterThan(0);
      expect(Buffer.byteLength(JSON.stringify(reply.result))).toBeLessThanOrEqual(128 * 1024);
      sources.push(...reply.result.sources.map((value: any) => value.sourceId)); cursor = reply.result.nextCursor ?? undefined;
    } while (cursor);
    expect(sources).toEqual(legacy.sources(workspaceId).map(value => value.sourceId)); expect(sources).toHaveLength(100);
    const revoked = await fixture.remote.request("workspace.source.revoke", { workspaceId, sourceId: sources.at(-1), requestId: "wide-revoke", expectedRevision: 1 });
    expect(revoked.error).toBeUndefined(); expect(revoked.result.value.state).toBe("unavailable");
  });
  test("a full workspace fitting by one byte still needs space for the single-entry Project list envelope", async () => {
    const fixture = await boot();
    fixture.ports.selection = () => ({ ...repo, label: "r".repeat(200) });
    const made = await create(fixture.local, "list-wrapper", Array.from({ length: 20 }, () => ({ selectionId: "repo-choice", kind: "githubRepository" }))), workspaceId = made.workspaceId;
    const large = { toolClasses: Array.from({ length: 200 }, (_value, index) => `${index}:`), hostServices: Array.from({ length: 200 }, (_value, index) => `${index}:`), connectors: Array.from({ length: 200 }, (_value, index) => `${index}:`), network: "none" as const };
    const candidate = { ...made.value, configRevision: 2, grantRevision: 2, policy: { ...made.value.policy, revision: 2, ceiling: large } };
    let needed = 128 * 1024 - 1 - Buffer.byteLength(JSON.stringify(candidate));
    for (const group of [large.toolClasses, large.hostServices, large.connectors]) for (let index = 0; index < group.length; index++) {
      const add = Math.min(needed, 200 - group[index]!.length); group[index] += "x".repeat(add); needed -= add;
    }
    expect(needed).toBe(0);
    expect(Buffer.byteLength(JSON.stringify(candidate))).toBe(128 * 1024 - 1);
    expect(Buffer.byteLength(JSON.stringify({ projects: [{ projectId: made.value.ownerId, workspace: candidate }], nextCursor: workspaceId }))).toBeGreaterThan(128 * 1024);
    fixture.ports.creationCeiling = () => large;
    const refused = await fixture.local.request("workspace.setCapabilityCeiling", { workspaceId, requestId: "list-wrapper-expansion", expectedRevision: 1, ceiling: large });
    expect(refused.error.data.code).toBe("response_too_large");
    expect(fixture.records.get(workspaceId).configRevision).toBe(1);
    expect((await fixture.local.request("project.list")).error).toBeUndefined();
  });
});
