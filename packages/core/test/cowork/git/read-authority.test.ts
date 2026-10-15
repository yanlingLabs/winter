import { authorityFixtureSessions } from "../committed-sessions";
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
  const resolver: GitHubReadGrantResolver = { repository: () => ({ ...account }), sourceScope: () => ({ revision: 1, sourceIds: [source.sourceId] }) };
  const authority = new CoworkAuthority(records, { folder: () => undefined, repository: () => ({ readable: true, writable: false, revoked: false }) });
  return { db, records, source, epoch, caller, request, resolver, readAuthority: new CurrentCoworkGitReadAuthority(records, authority, resolver) };
}
test("canonical preparation authority is revision/incarnation/repository-bound and leaves source preparing", async () => {
  const f = setup(), grant = await f.readAuthority.authorize(f.caller, f.request);
  expect(grant.repositoryId).toBe(account.repositoryId); expect(grant.credentialRef).toBe(account.credentialRef);
  expect(f.records.source(f.caller.workspaceId, f.source.sourceId).state).toBe("preparing");
  expect(f.records.source(f.caller.workspaceId, f.source.sourceId).ackRevision).toBeNull();
  for (const caller of [{ ...f.caller, workspaceId: "foreign" }, { ...f.caller, incarnationId: "old" }, { ...f.caller, leaseEpoch: 2 }]) await expect(Promise.resolve().then(() => f.readAuthority.authorize(caller, f.request))).rejects.toMatchObject({ code: "authority_denied" });
  for (const request of [{ ...f.request, sourceRevision: 2 }, { ...f.request, grantRevision: 2 }]) await expect(Promise.resolve().then(() => f.readAuthority.authorize(f.caller, request))).rejects.toMatchObject({ code: "revision_conflict" });
  f.resolver.repository = () => ({ ...account, repositoryId: "foreign" }); await expect(Promise.resolve().then(() => f.readAuthority.authorize(f.caller, f.request))).rejects.toMatchObject({ code: "authority_denied" });
});
test("account/source revocation during host resolution cannot revive readiness or accept late ACK", async () => {
  const f = setup(); f.resolver.repository = () => {
    f.records.removeSource({ principalId: "host", requestId: "revoke", expectedRevision: 1 }, f.caller.workspaceId, f.source.sourceId, true);
    return { ...account };
  };
  await expect(Promise.resolve().then(() => f.readAuthority.authorize(f.caller, f.request))).rejects.toBeDefined();
  expect(() => f.records.acknowledgeSource(f.epoch, f.source.sourceId, f.source.revision, "ready")).toThrow("stale_acknowledgment");
  expect(f.records.source(f.caller.workspaceId, f.source.sourceId).state).toBe("unavailable");
  const g = setup(); g.resolver.repository = () => ({ ...account, revoked: true }); await expect(Promise.resolve().then(() => g.readAuthority.authorize(g.caller, g.request))).rejects.toMatchObject({ code: "authority_denied" });
});
test("runtime reads require actual ready ACK, active binding, explicit source scope and effective capability", async () => {
  const f = setup(), runtime = { ...f.caller, sessionId: "session" };
  await expect(Promise.resolve().then(() => f.readAuthority.authorize(runtime, f.request))).rejects.toMatchObject({ code: "authority_denied" });
  f.records.acknowledgeSource(f.epoch, f.source.sourceId, f.source.revision, "ready");
  f.records.bindConversation({ principalId: "host", requestId: "bind", expectedRevision: 1 }, f.caller.workspaceId, { sessionId: runtime.sessionId, sourceId: f.source.sourceId }, authorityFixtureSessions(runtime.sessionId));
  expect((await f.readAuthority.authorize(runtime, f.request)).scopeDigest).not.toBe((await f.readAuthority.authorize(f.caller, f.request)).scopeDigest);
  f.resolver.sourceScope = () => undefined; await expect(Promise.resolve().then(() => f.readAuthority.authorize(runtime, f.request))).rejects.toMatchObject({ code: "authority_denied" });
  f.resolver.sourceScope = () => ({ revision: 1, sourceIds: ["foreign"] }); await expect(Promise.resolve().then(() => f.readAuthority.authorize(runtime, f.request))).rejects.toMatchObject({ code: "authority_denied" });
  f.resolver.sourceScope = () => ({ revision: 2, sourceIds: null }); await f.readAuthority.authorize(runtime, f.request);
  f.records.updatePolicy({ principalId: "host", requestId: "restrict", expectedRevision: 2 }, f.caller.workspaceId, { ceiling: { toolClasses: ["read"], hostServices: [], connectors: [], network: "internet" } });
  await expect(Promise.resolve().then(() => f.readAuthority.authorize(runtime, { ...f.request, grantRevision: f.records.get(f.caller.workspaceId).grantRevision }))).rejects.toMatchObject({ code: "authority_denied" });
});
test("restoring scope contents at a later revision does not restore prior read authority", async () => {
  const f = setup(); f.records.acknowledgeSource(f.epoch, f.source.sourceId, f.source.revision, "ready");
  f.records.bindConversation({ principalId: "host", requestId: "bind", expectedRevision: 1 }, f.caller.workspaceId, { sessionId: "session", sourceId: f.source.sourceId }, authorityFixtureSessions("session"));
  const caller = { ...f.caller, sessionId: "session" }; const before = await f.readAuthority.authorize(caller, f.request);
  f.resolver.sourceScope = () => ({ revision: 3, sourceIds: [f.source.sourceId] }); expect((await f.readAuthority.authorize(caller, f.request)).scopeDigest).not.toBe(before.scopeDigest);
});
test("read completion does not invent a guest ACK; SecretStore await rechecks canonical revocation", async () => {
  const f = setup(); let upstream = false;
  const t = new CoworkGitHubReadTransport(f.readAuthority, { get: async () => {
    f.records.removeSource({ principalId: "host", requestId: "revoke", expectedRevision: 1 }, f.caller.workspaceId, f.source.sourceId, true); return "fixture-token";
  } }, async () => { upstream = true; return new Response(); }, {}, { isolatedFixture: true });
  await expect(t.read(f.caller, f.request)).rejects.toMatchObject({ code: "authority_denied" }); expect(upstream).toBe(false);
  expect(f.records.source(f.caller.workspaceId, f.source.sourceId).ackRevision).toBeNull();
});

test("final synchronous scope cannot return stale workspace or mutable account authority", async () => {
  for (const mutation of ["workspace", "account"] as const) {
    const f = setup(); let calls = 0; const current = { ...account };
    f.records.acknowledgeSource(f.epoch, f.source.sourceId, f.source.revision, "ready");
    f.records.bindConversation({ principalId: "host", requestId: "bind", expectedRevision: 1 }, f.caller.workspaceId, { sessionId: "session", sourceId: f.source.sourceId }, authorityFixtureSessions("session"));
    f.resolver.repository = () => current;
    f.resolver.sourceScope = () => {
      if (++calls === 2) {
        if (mutation === "workspace") f.records.removeSource({ principalId: "host", requestId: "revoke", expectedRevision: 2 }, f.caller.workspaceId, f.source.sourceId, true);
        else { current.authorityRevision++; current.revoked = true; }
      }
      return { revision: 1, sourceIds: [f.source.sourceId] };
    };
    await expect(Promise.resolve().then(() => f.readAuthority.authorize({ ...f.caller, sessionId: "session" }, f.request))).rejects.toBeDefined();
  }
});

test("final scope resolution cannot return a stopped worker even with unchanged source revisions", async () => {
  const f = setup(); let calls = 0;
  f.records.acknowledgeSource(f.epoch, f.source.sourceId, f.source.revision, "ready");
  f.records.bindConversation({ principalId: "host", requestId: "bind", expectedRevision: 1 }, f.caller.workspaceId, { sessionId: "session", sourceId: f.source.sourceId }, authorityFixtureSessions("session"));
  f.resolver.sourceScope = () => {
    if (++calls === 2) f.db.db.run("UPDATE cowork_workspaces SET power='stopped' WHERE workspace_id=?", [f.caller.workspaceId]);
    return { revision: 1, sourceIds: [f.source.sourceId] };
  };
  await expect(Promise.resolve().then(() => f.readAuthority.authorize({ ...f.caller, sessionId: "session" }, f.request))).rejects.toMatchObject({ code: "authority_denied" });
});
test("task source scope changes at final snapshot cannot reuse its earlier grant", async () => {
  const f = setup(); let calls = 0;
  f.records.acknowledgeSource(f.epoch, f.source.sourceId, f.source.revision, "ready");
  f.records.bindConversation({ principalId: "host", requestId: "bind", expectedRevision: 1 }, f.caller.workspaceId, { sessionId: "session", sourceId: f.source.sourceId }, authorityFixtureSessions("session"));
  f.resolver.sourceScope = () => ++calls === 1 ? { revision: 1, sourceIds: [f.source.sourceId] } : { revision: 2, sourceIds: [] };
  await expect(Promise.resolve().then(() => f.readAuthority.authorize({ ...f.caller, sessionId: "session" }, f.request))).rejects.toMatchObject({ code: "authority_denied" });
});

test("final transport authority cut never releases bytes after the worker stops in final scope resolution", async () => {
  const f = setup(); let calls = 0;
  f.records.acknowledgeSource(f.epoch, f.source.sourceId, f.source.revision, "ready");
  f.records.bindConversation({ principalId: "host", requestId: "bind", expectedRevision: 1 }, f.caller.workspaceId, { sessionId: "session", sourceId: f.source.sourceId }, authorityFixtureSessions("session"));
  f.resolver.sourceScope = () => {
    if (++calls === 8) f.db.db.run("UPDATE cowork_workspaces SET power='stopped' WHERE workspace_id=?", [f.caller.workspaceId]);
    return { revision: 1, sourceIds: [f.source.sourceId] };
  };
  const pkt = (line: string) => Buffer.from((Buffer.byteLength(line) + 4).toString(16).padStart(4, "0") + line);
  const bytes = Buffer.concat([pkt("# service=git-upload-pack\n"), Buffer.from("0000"), pkt(`${"1".repeat(40)} HEAD\0multi_ack\n`), Buffer.from("0000")]);
  const t = new CoworkGitHubReadTransport(f.readAuthority, { get: async () => "fixture-token" }, async () => new Response(bytes, { headers: { "content-type": "application/x-git-upload-pack-advertisement" } }), {}, { isolatedFixture: true });
  await expect(t.read({ ...f.caller, sessionId: "session" }, f.request)).rejects.toMatchObject({ code: "authority_denied" });
  expect(f.records.get(f.caller.workspaceId).power).toBe("stopped");
});
