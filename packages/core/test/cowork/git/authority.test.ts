import { authorityFixtureSessions } from "../committed-sessions";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRuntimeStateDb, type RuntimeStateDb } from "../../../src/runtime-state/db";
import { CoworkRepository } from "../../../src/cowork/repository";
import { CoworkAuthority } from "../../../src/cowork/authority";
import { CurrentCoworkPublicationAuthority } from "../../../src/cowork/git/authority";
import type { PublicationGrant, PublicationRequest, Publisher } from "../../../src/cowork/git/types";

const homes: string[] = [], handles: RuntimeStateDb[] = [];
afterEach(() => { for (const db of handles.splice(0)) db.close(); for (const home of homes.splice(0)) rmSync(home, { force: true, recursive: true }); });
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "winter-cowork-git-authority-")); homes.push(home);
  const db = openRuntimeStateDb(home); handles.push(db); const records = new CoworkRepository(db);
  const context = (requestId: string) => ({ principalId: "fixture-user", requestId, expectedRevision: records.get(made.workspaceId).configRevision });
  const made = records.create({ principalId: "fixture-user", requestId: "create" }, { ownership: "project", title: "Fixture",
    sources: [{ kind: "githubRepository", label: "Fixture", access: "read-write", detail: { repositoryId: "repository-one", authorityRef: "authority-one", initialRef: "main" } }],
    ceiling: { toolClasses: ["read", "write"], hostServices: ["git.publish"], connectors: [], network: "internet" } });
  const source = made.value.sources[0]!, epoch = records.beginIncarnation(made.workspaceId, "incarnation-one", made.value.workspace.configRevision);
  records.acknowledgeSource(epoch, source.sourceId, source.revision, "ready");
  records.bindConversation(context("bind"), made.workspaceId, { sessionId: "session-one", sourceId: source.sourceId }, authorityFixtureSessions("session-one"));
  let writable = true, taskAllowed = true, beforeTask: (() => void) | undefined;
  let scope: PublicationGrant["sourceScope"] = { revision: 1, sourceIds: null };
  const authority = new CoworkAuthority(records, { folder: () => undefined, repository: () => ({ readable: true, writable, revoked: false }) });
  const tasks = { sourceScope: async () => scope, resolve: async (_publisher: Readonly<Publisher>, _request: Readonly<PublicationRequest>, _source: unknown, _capabilities: unknown) => {
    if (!taskAllowed) throw new Error("task publication denied");
    beforeTask?.(); return { repositoryId: "repository-one", destinationId: "destination-one", authorityId: "authority-one", authorityRevision: 1 };
  } };
  const current = new CurrentCoworkPublicationAuthority(records, authority, tasks);
  const actor: Publisher = { principalId: "fixture-user", sessionId: "session-one", taskId: "task-one" };
  const request: PublicationRequest = { requestId: "publish", workspaceId: made.workspaceId, sourceId: source.sourceId, sourceRevision: source.revision,
    publicationRevision: records.policy(made.workspaceId).publicationRevision, ref: "refs/heads/feature/task", oldOid: null, newOid: "a".repeat(40), bundle: new Uint8Array([1]) };
  return { records, current, actor, request, context, tasks, denyTask: () => taskAllowed = false, readOnly: () => writable = false,
    setScope: (value: PublicationGrant["sourceScope"]) => scope = value, beforeTask: (fn: () => void) => beforeTask = fn };
}
test("publication resolves current canonical ready source and exact host task grant", async () => {
  const f = fixture(); expect(await f.current.authorize(f.actor, f.request)).toMatchObject({ repositoryId: "repository-one", sourceRevision: 1, publicationRevision: 1 });
  await expect(f.current.authorize({ ...f.actor, sessionId: "missing" }, f.request)).rejects.toThrow();
  f.denyTask(); await expect(f.current.authorize(f.actor, f.request)).rejects.toThrow();
});
test("adapter independently enforces write and git.publish even when task resolver allows", async () => {
  for (const change of [{ toolClasses: ["read"], hostServices: ["git.publish"] }, { toolClasses: ["read", "write"], hostServices: [] }]) {
    const f = fixture(); f.records.updatePolicy(f.context("narrow"), f.request.workspaceId, { ceiling: { ...change, connectors: [], network: "internet" } });
    await expect(f.current.authorize(f.actor, f.request)).rejects.toMatchObject({ code: "authority_denied" });
  }
  const f = fixture();
  f.beforeTask(() => f.records.rs.db.run("UPDATE cowork_conversations SET restrictions_json=? WHERE session_id=?", [JSON.stringify({ toolClasses: ["read"], hostServices: ["git.publish"], connectors: [], network: "internet" }), f.actor.sessionId]));
  await expect(f.current.authorize(f.actor, f.request)).rejects.toMatchObject({ code: "authority_denied" });
});
test("explicit source scope bounds publication while designated workspace access spans source cwd", async () => {
  const f = fixture();
  const added = f.records.addSource(f.context("second"), f.request.workspaceId,
    { kind: "githubRepository", label: "Second", access: "read-write", detail: { repositoryId: "repository-one", authorityRef: "authority-one", initialRef: "main" } });
  const source = added.value;
  const epoch = f.records.refreshEpoch(f.request.workspaceId, "incarnation-one", 1);
  f.records.acknowledgeSource(epoch, source.sourceId, source.revision, "ready");
  const request = { ...f.request, sourceId: source.sourceId, sourceRevision: source.revision,
    publicationRevision: f.records.policy(f.request.workspaceId).publicationRevision };
  expect(f.records.binding(f.actor.sessionId).sourceId).not.toBe(source.sourceId);
  expect((await f.current.authorize(f.actor, request)).sourceScope).toEqual({ revision: 1, sourceIds: null });
  f.setScope({ revision: 2, sourceIds: [f.request.sourceId] });
  await expect(f.current.authorize(f.actor, request)).rejects.toMatchObject({ code: "authority_denied" });
  f.setScope({ revision: 3, sourceIds: [source.sourceId] });
  expect((await f.current.authorize(f.actor, request)).sourceScope.sourceIds).toEqual([source.sourceId]);
  f.beforeTask(() => f.setScope({ revision: 5, sourceIds: [source.sourceId] }));
  await expect(f.current.authorize(f.actor, request)).rejects.toMatchObject({ code: "authority_denied" });
});
test("missing host source scope and scope revocation during task resolution deny", async () => {
  const f = fixture(); f.tasks.sourceScope = async () => undefined as unknown as PublicationGrant["sourceScope"];
  await expect(f.current.authorize(f.actor, f.request)).rejects.toMatchObject({ code: "authority_denied" });
  const g = fixture(); g.beforeTask(() => g.setScope({ revision: 2, sourceIds: [] }));
  await expect(g.current.authorize(g.actor, g.request)).rejects.toMatchObject({ code: "authority_denied" });
});
test("narrowing and restoring capabilities still invalidates the captured canonical policy epoch", async () => {
  const f = fixture(), before = await f.current.authorize(f.actor, f.request), ceiling = f.records.policy(f.request.workspaceId).ceiling;
  expect(before.capabilityState).toMatchObject({ conversationRevision: 1, policyRevision: 1 });
  expect(before.capabilityState.digest).toMatch(/^[a-f0-9]{64}$/);
  f.beforeTask(() => {
    f.records.updatePolicy(f.context("narrow"), f.request.workspaceId, { ceiling: { ...ceiling, toolClasses: ["read"] } });
    f.records.updatePolicy(f.context("restore"), f.request.workspaceId, { ceiling });
  });
  await expect(f.current.authorize(f.actor, f.request)).rejects.toMatchObject({ code: "authority_denied" });
  f.beforeTask(() => {});
  const restored = await f.current.authorize(f.actor, f.request);
  expect(restored.capabilityState.digest).toBe(before.capabilityState.digest);
  expect(restored.capabilityState.policyRevision).toBe(3);
  expect(restored.publicationRevision).toBe(before.publicationRevision);
});
test("live read-only/revoked sources and policy narrowing block publication", async () => {
  const f = fixture(); f.readOnly(); await expect(f.current.authorize(f.actor, f.request)).rejects.toThrow();
  const g = fixture(); g.records.removeSource(g.context("revoke"), g.request.workspaceId, g.request.sourceId, true);
  await expect(g.current.authorize(g.actor, g.request)).rejects.toThrow();
  const h = fixture(); h.records.updatePolicy(h.context("manual"), h.request.workspaceId, { publication: "manual" });
  await expect(h.current.authorize(h.actor, h.request)).rejects.toThrow();
});
test("a pending host-folder addition disables auto publication and await-time narrowing is rechecked", async () => {
  const f = fixture(); f.records.addSource(f.context("folder"), f.request.workspaceId,
    { kind: "folder", label: "Pending", access: "read-write", detail: { grantRef: "folder-one", rootIdentity: "folder-root" } });
  await expect(f.current.authorize(f.actor, f.request)).rejects.toThrow();
  const g = fixture(); g.beforeTask(() => g.records.updatePolicy(g.context("manual"), g.request.workspaceId, { publication: "manual" }));
  await expect(g.current.authorize(g.actor, g.request)).rejects.toThrow();
});
test("capability set ordering does not change its normalized digest", async () => {
  const f = fixture(), before = await f.current.authorize(f.actor, f.request);
  const row = f.records.rs.db.query<{restrictions_json:string},[string]>("SELECT restrictions_json FROM cowork_conversations WHERE session_id=?").get(f.actor.sessionId)!;
  const value = JSON.parse(row.restrictions_json);
  for (const name of ["toolClasses", "hostServices", "connectors"]) value[name].reverse();
  f.records.rs.db.run("UPDATE cowork_conversations SET restrictions_json=? WHERE session_id=?", [JSON.stringify(value), f.actor.sessionId]);
  expect((await f.current.authorize(f.actor, f.request)).capabilityState.digest).toBe(before.capabilityState.digest);
});
