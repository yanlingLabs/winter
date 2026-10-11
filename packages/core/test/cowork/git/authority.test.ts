import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRuntimeStateDb, type RuntimeStateDb } from "../../../src/runtime-state/db";
import { CoworkRepository } from "../../../src/cowork/repository";
import { CoworkAuthority } from "../../../src/cowork/authority";
import { CurrentCoworkPublicationAuthority } from "../../../src/cowork/git/authority";
import type { PublicationRequest, Publisher } from "../../../src/cowork/git/types";

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
  records.bindConversation(context("bind"), made.workspaceId, { sessionId: "session-one", sourceId: source.sourceId });
  let writable = true, taskAllowed = true, beforeTask: (() => void) | undefined;
  const authority = new CoworkAuthority(records, { folder: () => undefined, repository: () => ({ readable: true, writable, revoked: false }) });
  const current = new CurrentCoworkPublicationAuthority(records, authority, { resolve: async (_publisher, _request, _source, capabilities) => {
    if (!taskAllowed || !capabilities.hostServices.includes("git.publish")) throw new Error("task publication denied");
    beforeTask?.(); return { repositoryId: "repository-one", destinationId: "destination-one", authorityId: "authority-one", authorityRevision: 1 };
  } });
  const actor: Publisher = { principalId: "fixture-user", sessionId: "session-one", taskId: "task-one" };
  const request: PublicationRequest = { requestId: "publish", workspaceId: made.workspaceId, sourceId: source.sourceId, sourceRevision: source.revision,
    publicationRevision: records.policy(made.workspaceId).publicationRevision, ref: "refs/heads/feature/task", oldOid: null, newOid: "a".repeat(40), bundle: new Uint8Array([1]) };
  return { records, current, actor, request, context, denyTask: () => taskAllowed = false, readOnly: () => writable = false, beforeTask: (fn: () => void) => beforeTask = fn };
}
test("publication resolves current canonical ready source and exact host task grant", async () => {
  const f = fixture(); expect(await f.current.authorize(f.actor, f.request)).toMatchObject({ repositoryId: "repository-one", sourceRevision: 1, publicationRevision: 1 });
  await expect(f.current.authorize({ ...f.actor, sessionId: "missing" }, f.request)).rejects.toThrow();
  f.denyTask(); await expect(f.current.authorize(f.actor, f.request)).rejects.toThrow();
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
