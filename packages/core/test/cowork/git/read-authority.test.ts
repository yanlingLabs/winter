import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRuntimeStateDb, type RuntimeStateDb } from "../../../src/runtime-state/db";
import { CoworkRepository } from "../../../src/cowork/repository";
import { CoworkAuthority } from "../../../src/cowork/authority";
import { CurrentCoworkGitReadAuthority, type GitHubReadGrantResolver } from "../../../src/cowork/git/read-authority";
import { CoworkGitHubReadTransport } from "../../../src/cowork/git/read-transport";
import type { GitReadCaller, GitReadRequest, GitHubReadRepository } from "../../../src/cowork/git/read-types";
const homes: string[] = [], dbs: RuntimeStateDb[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
const account: GitHubReadRepository = { repositoryId: "repo-one", authorityRef: "github-one", authorityRevision: 1, owner: "fixture", name: "repo", credentialRef: "host-only-slot", readable: true, revoked: false };
function setup() {
  const home = mkdtempSync(join(tmpdir(), "winter-git-read-authority-")); homes.push(home); const db = openRuntimeStateDb(home); dbs.push(db);
  const records = new CoworkRepository(db), made = records.create({ principalId: "host", requestId: "create" }, { ownership: "project", title: "Fixture", sources: [{ kind: "githubRepository", label: "Repository", access: "read-write", detail: { repositoryId: account.repositoryId, authorityRef: account.authorityRef, initialRef: "main" } }], ceiling: { toolClasses: ["read"], hostServices: ["git.read"], connectors: [], network: "internet" } });
  const source = made.value.sources[0]!, epoch = records.beginIncarnation(made.workspaceId, "boot", 1);
  const caller: GitReadCaller = { workspaceId: made.workspaceId, incarnationId: epoch.incarnationId, leaseEpoch: epoch.leaseEpoch };
  const request: GitReadRequest = { sourceId: source.sourceId, sourceRevision: source.revision, grantRevision: epoch.grantRevision, operation: "advertise" };
  const resolver: GitHubReadGrantResolver = { repository: async () => ({ ...account }), sourceScope: async () => ({ revision: 1, sourceIds: [source.sourceId] }) };
  const authority = new CoworkAuthority(records, { folder: () => undefined, repository: () => ({ readable: true, writable: false, revoked: false }) });
  return { records, source, epoch, caller, request, resolver, readAuthority: new CurrentCoworkGitReadAuthority(records, authority, resolver) };
}
test("canonical preparation authority is revision/incarnation/repository-bound and leaves source preparing", async () => {
  const f = setup(), grant = await f.readAuthority.authorize(f.caller, f.request);
  expect(grant.repositoryId).toBe(account.repositoryId); expect(grant.credentialRef).toBe(account.credentialRef);
  expect(f.records.source(f.caller.workspaceId, f.source.sourceId).state).toBe("preparing");
  expect(f.records.source(f.caller.workspaceId, f.source.sourceId).ackRevision).toBeNull();
  for (const caller of [{ ...f.caller, workspaceId: "foreign" }, { ...f.caller, incarnationId: "old" }, { ...f.caller, leaseEpoch: 2 }]) await expect(f.readAuthority.authorize(caller, f.request)).rejects.toMatchObject({ code: "authority_denied" });
  for (const request of [{ ...f.request, sourceRevision: 2 }, { ...f.request, grantRevision: 2 }]) await expect(f.readAuthority.authorize(f.caller, request)).rejects.toMatchObject({ code: "revision_conflict" });
  f.resolver.repository = async () => ({ ...account, repositoryId: "foreign" }); await expect(f.readAuthority.authorize(f.caller, f.request)).rejects.toMatchObject({ code: "authority_denied" });
});
test("account/source revocation during async resolution cannot revive readiness or accept late ACK", async () => {
  const f = setup(); f.resolver.repository = async () => {
    f.records.removeSource({ principalId: "host", requestId: "revoke", expectedRevision: 1 }, f.caller.workspaceId, f.source.sourceId, true);
    return { ...account };
  };
  await expect(f.readAuthority.authorize(f.caller, f.request)).rejects.toBeDefined();
  expect(() => f.records.acknowledgeSource(f.epoch, f.source.sourceId, f.source.revision, "ready")).toThrow("stale_acknowledgment");
  expect(f.records.source(f.caller.workspaceId, f.source.sourceId).state).toBe("unavailable");
  const g = setup(); g.resolver.repository = async () => ({ ...account, revoked: true }); await expect(g.readAuthority.authorize(g.caller, g.request)).rejects.toMatchObject({ code: "authority_denied" });
});
test("runtime reads require actual ready ACK, active binding, explicit source scope and effective capability", async () => {
  const f = setup(), runtime = { ...f.caller, sessionId: "session" };
  await expect(f.readAuthority.authorize(runtime, f.request)).rejects.toMatchObject({ code: "authority_denied" });
  f.records.acknowledgeSource(f.epoch, f.source.sourceId, f.source.revision, "ready");
  f.records.bindConversation({ principalId: "host", requestId: "bind", expectedRevision: 1 }, f.caller.workspaceId, { sessionId: runtime.sessionId, sourceId: f.source.sourceId });
  expect((await f.readAuthority.authorize(runtime, f.request)).scopeDigest).not.toBe((await f.readAuthority.authorize(f.caller, f.request)).scopeDigest);
  f.resolver.sourceScope = async () => undefined; await expect(f.readAuthority.authorize(runtime, f.request)).rejects.toMatchObject({ code: "authority_denied" });
  f.resolver.sourceScope = async () => ({ revision: 1, sourceIds: ["foreign"] }); await expect(f.readAuthority.authorize(runtime, f.request)).rejects.toMatchObject({ code: "authority_denied" });
  f.resolver.sourceScope = async () => ({ revision: 2, sourceIds: null }); await f.readAuthority.authorize(runtime, f.request);
  f.records.updatePolicy({ principalId: "host", requestId: "restrict", expectedRevision: 2 }, f.caller.workspaceId, { ceiling: { toolClasses: ["read"], hostServices: [], connectors: [], network: "internet" } });
  await expect(f.readAuthority.authorize(runtime, { ...f.request, grantRevision: f.records.get(f.caller.workspaceId).grantRevision })).rejects.toMatchObject({ code: "authority_denied" });
});
test("restoring scope contents at a later revision does not restore prior read authority", async () => {
  const f = setup(); f.records.acknowledgeSource(f.epoch, f.source.sourceId, f.source.revision, "ready");
  f.records.bindConversation({ principalId: "host", requestId: "bind", expectedRevision: 1 }, f.caller.workspaceId, { sessionId: "session", sourceId: f.source.sourceId });
  const caller = { ...f.caller, sessionId: "session" }; const before = await f.readAuthority.authorize(caller, f.request);
  f.resolver.sourceScope = async () => ({ revision: 3, sourceIds: [f.source.sourceId] }); expect((await f.readAuthority.authorize(caller, f.request)).scopeDigest).not.toBe(before.scopeDigest);
});
test("read completion does not invent a guest ACK; SecretStore await rechecks canonical revocation", async () => {
  const f = setup(); let upstream = false;
  const t = new CoworkGitHubReadTransport(f.readAuthority, { get: async () => {
    f.records.removeSource({ principalId: "host", requestId: "revoke", expectedRevision: 1 }, f.caller.workspaceId, f.source.sourceId, true); return "fixture-token";
  } }, async () => { upstream = true; return new Response(); }, {}, { isolatedFixture: true });
  await expect(t.read(f.caller, f.request)).rejects.toMatchObject({ code: "authority_denied" }); expect(upstream).toBe(false);
  expect(f.records.source(f.caller.workspaceId, f.source.sourceId).ackRevision).toBeNull();
});
