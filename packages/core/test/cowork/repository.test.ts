import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { downgradeRuntimeStateToV6, downgradeCoworkRuntimeStateToV7, openRuntimeStateDb, RUNTIME_STATE_SCHEMA_VERSION, type RuntimeStateDb } from "../../src/runtime-state/db";
import { CoworkRepository, relativeCoworkPath } from "../../src/cowork/repository";
import { CoworkAuthority } from "../../src/cowork/authority";
import { CoworkError, type CoworkErrorCode, type CapabilityCeiling, type SourceSelection } from "../../src/cowork/types";

const homes: string[] = [], handles: RuntimeStateDb[] = [];
const caps: CapabilityCeiling = { toolClasses: ["read", "write", "execute"], hostServices: [], connectors: [], network: "internet" };
const folder: SourceSelection = { kind: "folder", label: "Fixture", access: "read-write", detail: { grantRef: "grant-one", rootIdentity: "fixture-root" } };
const repo: SourceSelection = { kind: "githubRepository", label: "Repo", access: "read-write", detail: { repositoryId: "repo-one", authorityRef: "github-one", initialRef: "main" } };
const context = (requestId: string, expectedRevision?: number) => ({ principalId: "user-one", requestId, expectedRevision });
function open(home?: string) {
  if (!home) { home = mkdtempSync(join(tmpdir(), "winter-cowork-store-")); homes.push(home); }
  const db = openRuntimeStateDb(home); handles.push(db); return { home, db, store: new CoworkRepository(db) };
}
function create(store: CoworkRepository, sources = [folder], ownership: "standalone" | "project" = "project", request = "create") {
  return store.create(context(request), { ownership, title: "Fixture", sources, ceiling: caps });
}
function ready(store: CoworkRepository, workspaceId: string) {
  const workspace = store.get(workspaceId);
  const epoch = store.beginIncarnation(workspaceId, "incarnation-one", workspace.configRevision);
  for (const selected of store.sources(workspaceId)) store.acknowledgeSource(epoch, selected.sourceId, selected.revision, "ready");
  return epoch;
}
function code(fn: () => unknown, expected: CoworkErrorCode) { try { fn(); throw new Error("expected refusal"); } catch (error) { expect(error).toBeInstanceOf(CoworkError); expect((error as CoworkError).code).toBe(expected); } }
afterEach(() => { for (const db of handles.splice(0)) db.close(); for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

test("canonical identity, creation receipt and source authority persist across independent handles", () => {
  const a = open(), homeId = a.store.homeIdentity(), first = create(a.store);
  const b = open(a.home);
  expect(b.store.homeIdentity()).toBe(homeId);
  expect(create(b.store)).toEqual(first);
  expect(b.store.sources(first.workspaceId)[0]!.state).toBe("preparing");
  expect(b.store.sources(first.workspaceId)[0]!.trust).toBe("untrusted");
  expect(b.db.integrity().ok).toBe(true);
  code(() => b.store.create(context("create"), { ownership: "project", title: "Changed", sources: [folder], ceiling: caps }), "request_conflict");
  expect(b.store.list()).toHaveLength(1);
});
test("creation requires a source and rolls back the whole operation on invalid selection", () => {
  const { store, db } = open();
  code(() => create(store, []), "invalid_request");
  code(() => create(store, [folder, { ...folder, detail: { grantRef: "bad/path", rootIdentity: "x" } }]), "invalid_request");
  expect(store.list()).toEqual([]);
  expect(db.db.query("SELECT count(*) AS n FROM cowork_operations").get()).toEqual({ n: 0 });
});
test("concurrent revisions prevent two clients removing the final sources; revocation always narrows", () => {
  const a = open(), made = create(a.store, [folder, repo]), b = open(a.home);
  a.store.removeSource(context("remove-folder", 1), made.workspaceId, made.value.sources[0]!.sourceId);
  code(() => b.store.removeSource(context("remove-repo", 1), made.workspaceId, made.value.sources[1]!.sourceId), "revision_conflict");
  code(() => b.store.removeSource(context("remove-repo", 2), made.workspaceId, made.value.sources[1]!.sourceId), "last_source_required");
  const revoked = b.store.removeSource(context("revoke", 2), made.workspaceId, made.value.sources[1]!.sourceId, true);
  expect(revoked.value.state).toBe("unavailable"); expect(revoked.value.desired).toBe("present");
  expect(b.store.get(made.workspaceId).grantRevision).toBe(3);
});
test("temporary folder loss/removal never enables GitHub-only publication before confirmed detachment", () => {
  const { store } = open(), made = create(store, [repo, folder]);
  expect(store.githubOnly(made.workspaceId)).toBe(false);
  store.removeSource(context("revoke", 1), made.workspaceId, made.value.sources[1]!.sourceId, true);
  expect(store.githubOnly(made.workspaceId)).toBe(false);
  const removal = store.removeSource(context("remove", 2), made.workspaceId, made.value.sources[1]!.sourceId);
  expect(store.githubOnly(made.workspaceId)).toBe(false);
  const epoch = store.beginIncarnation(made.workspaceId, "boot", 3);
  store.acknowledgeSource(epoch, removal.value.sourceId, removal.value.revision, "detached");
  expect(store.githubOnly(made.workspaceId)).toBe(true);
  store.addSource(context("new-folder", 3), made.workspaceId, folder);
  expect(store.githubOnly(made.workspaceId)).toBe(false);
});
test("stale callback cannot resurrect a revoked source or cross workspace ownership", () => {
  const { store } = open(), made = create(store), epoch = ready(store, made.workspaceId), selected = made.value.sources[0]!;
  store.removeSource(context("revoke", 1), made.workspaceId, selected.sourceId, true);
  code(() => store.acknowledgeSource(epoch, selected.sourceId, selected.revision, "ready"), "stale_acknowledgment");
  expect(store.source(made.workspaceId, selected.sourceId).state).toBe("unavailable");
  const other = create(store, [repo], "project", "other");
  code(() => store.source(other.workspaceId, selected.sourceId), "not_found");
});
test("standalone reserves one immutable conversation identity; Project bindings share files but preserve policy", () => {
  const { store } = open(), one = create(store, [folder], "standalone"), selected = one.value.sources[0]!;
  code(() => store.bindConversation(context("early", 1), one.workspaceId, { sessionId: one.value.workspace.ownerId, sourceId: selected.sourceId }), "source_unavailable");
  ready(store, one.workspaceId);
  code(() => store.bindConversation(context("foreign", 1), one.workspaceId, { sessionId: "foreign", sourceId: selected.sourceId }), "authority_denied");
  store.bindConversation(context("own", 1), one.workspaceId, { sessionId: one.value.workspace.ownerId, sourceId: selected.sourceId });
  const project = create(store, [repo], "project", "project"); ready(store, project.workspaceId);
  const sourceId = project.value.sources[0]!.sourceId;
  store.bindConversation(context("a", 1), project.workspaceId, { sessionId: "session-a", sourceId });
  store.updatePolicy(context("default", 2), project.workspaceId, { defaultPolicy: "plan" });
  store.bindConversation(context("b", 3), project.workspaceId, { sessionId: "session-b", sourceId });
  expect(store.binding("session-a").policy).toBe("auto"); expect(store.binding("session-b").policy).toBe("plan");
  expect(store.binding("session-a").workspaceId).toBe(store.binding("session-b").workspaceId);
});
test("outbox fanout survives reopen; receipt retry neither duplicates change nor alters result", () => {
  const a = open(), made = create(a.store); ready(a.store, made.workspaceId);
  a.store.bindConversation(context("bind", 1), made.workspaceId, { sessionId: "session-a", sourceId: made.value.sources[0]!.sourceId });
  const change = a.store.updatePolicy(context("policy", 2), made.workspaceId, { publication: "manual" });
  const b = open(a.home), pending = b.store.pendingChanges("session-a");
  expect(pending).toHaveLength(2);
  expect(b.store.updatePolicy(context("policy", 2), made.workspaceId, { publication: "manual" })).toEqual(change);
  expect(b.store.pendingChanges("session-a")).toEqual(pending);
  b.store.acknowledgeChange("session-a", pending[0]!.changeId, 10);
  b.store.acknowledgeChange("session-a", pending[0]!.changeId, 10);
  code(() => b.store.acknowledgeChange("session-a", pending[0]!.changeId, 11), "request_conflict");
  expect(b.store.pendingChanges("session-a")).toHaveLength(1);
});
test("authority rechecks live grants, rejects paired folder grants and cross-workspace peer access", () => {
  const { store } = open(), made = create(store); ready(store, made.workspaceId);
  const sourceId = made.value.sources[0]!.sourceId;
  store.bindConversation(context("a", 1), made.workspaceId, { sessionId: "session-a", sourceId });
  store.bindConversation(context("b", 2), made.workspaceId, { sessionId: "session-b", sourceId });
  let revoked = false;
  const authority = new CoworkAuthority(store, { folder: () => ({ rootIdentity: "fixture-root", writable: true, revoked }), repository: () => undefined });
  authority.requirePeer({ kind: "runtime", id: "runtime-a", sessionId: "session-a", workspaceId: made.workspaceId }, "session-b");
  code(() => authority.requirePeer({ kind: "runtime", id: "runtime-a", sessionId: "session-a", workspaceId: "another" }, "session-b"), "authority_denied");
  code(() => authority.requireSelection({ kind: "paired-user", id: "phone", workspaceIds: new Set([made.workspaceId]), repositoryAuthorities: new Set() }, folder), "authority_denied");
  authority.requireSource(made.workspaceId, sourceId, true); revoked = true;
  code(() => authority.requireSource(made.workspaceId, sourceId, true), "authority_denied");
  store.updatePolicy(context("ceiling", 3), made.workspaceId, { ceiling: { ...caps, toolClasses: ["read"], network: "none" } });
  expect(authority.effectiveCapabilities("session-a").toolClasses).toEqual(["read"]);
  expect(authority.effectiveCapabilities("session-a").network).toBe("none");
});
test("relative cwd rejects absolute paths and traversal rather than normalizing them into authority", () => {
  for (const path of ["/Users/private", "../secret", "src/../secret", "src\\secret", "\0"]) code(() => relativeCoworkPath(path), "invalid_request");
  expect(relativeCoworkPath("src/./lib")).toBe("src/lib");
});

test("legacy rollback refuses any populated Cowork authority without deleting records", () => {
  const { store, home, db } = open(), made = create(store);
  expect(() => downgradeRuntimeStateToV6(home)).toThrow("Cowork authority");
  expect(store.get(made.workspaceId)).toEqual(made.value.workspace);
  expect(db.schemaVersion()).toBe(RUNTIME_STATE_SCHEMA_VERSION);
  expect(db.integrity().ok).toBe(true);
});

test("revocation cannot resurrect a source already selected for removal", () => {
  const { store } = open(), made = create(store, [folder, repo]);
  const sourceId = made.value.sources[0]!.sourceId;
  store.removeSource(context("remove", 1), made.workspaceId, sourceId);
  const revoked = store.removeSource(context("revoke", 2), made.workspaceId, sourceId, true);
  expect(revoked.value.desired).toBe("removed"); expect(revoked.value.state).toBe("removing");
  expect(revoked.value.reason).toBe("access_revoked");
  const epoch = store.beginIncarnation(made.workspaceId, "boot", 3);
  store.acknowledgeSource(epoch, sourceId, revoked.value.revision, "detached");
  expect(store.githubOnly(made.workspaceId)).toBe(true);
});

test("outbox preserves commit order when timestamps tie and random change IDs sort backward", () => {
  const { db } = open(); let sequence = 999;
  const store = new CoworkRepository(db, () => "2026-10-11T00:00:00.000Z", prefix => `${prefix}_${sequence--}`);
  const made = create(store); ready(store, made.workspaceId);
  store.bindConversation(context("bind", 1), made.workspaceId, { sessionId: "session-a", sourceId: made.value.sources[0]!.sourceId });
  store.updatePolicy(context("policy", 2), made.workspaceId, { publication: "manual" });
  expect(store.pendingChanges("session-a").map(value => value.revision)).toEqual([2, 3]);
  const authority = new CoworkAuthority(store, { folder: () => undefined, repository: () => undefined });
  db.db.run("UPDATE cowork_workspaces SET state='archived' WHERE workspace_id=?", [made.workspaceId]);
  code(() => authority.effectiveCapabilities("session-a"), "authority_denied");
});

test("source readiness commits a durable notification and duplicate acknowledgment is inert", () => {
  const { store, db } = open(), made = create(store); const initial = ready(store, made.workspaceId);
  store.bindConversation(context("bind", 1), made.workspaceId, { sessionId: "session-a", sourceId: made.value.sources[0]!.sourceId });
  const added = store.addSource(context("add", 2), made.workspaceId, repo);
  const epoch = store.refreshEpoch(made.workspaceId, initial.incarnationId, initial.leaseEpoch);
  const before = store.pendingChanges("session-a").length;
  store.acknowledgeSource(epoch, added.value.sourceId, 1, "ready");
  expect(store.pendingChanges("session-a")).toHaveLength(before + 2);
  store.acknowledgeSource(epoch, added.value.sourceId, 1, "ready");
  expect(store.pendingChanges("session-a")).toHaveLength(before + 2);
  expect(db.db.query("SELECT status FROM cowork_operations WHERE operation_id=?").get(added.operationId)).toEqual({ status: "applied" });
});

test("live controller refresh is explicit, while superseded callbacks and owners stay fenced", () => {
  const { store } = open(), made = create(store), old = store.beginIncarnation(made.workspaceId, "owner-one", 1);
  store.updatePolicy(context("policy", 1), made.workspaceId, { publication: "manual" });
  code(() => store.acknowledgeSource(old, made.value.sources[0]!.sourceId, 1, "ready"), "stale_acknowledgment");
  code(() => store.refreshEpoch(made.workspaceId, "wrong-owner", old.leaseEpoch), "stale_acknowledgment");
  code(() => store.refreshEpoch(made.workspaceId, old.incarnationId, old.leaseEpoch + 1), "stale_acknowledgment");
  const current = store.refreshEpoch(made.workspaceId, old.incarnationId, old.leaseEpoch);
  store.acknowledgeSource(current, made.value.sources[0]!.sourceId, 1, "ready");
});

test("revocation narrows archived workspaces and supersedes pending source operations", () => {
  const { store, db } = open(), made = create(store);
  db.db.run("UPDATE cowork_workspaces SET state='archived' WHERE workspace_id=?", [made.workspaceId]);
  store.removeSource(context("revoke", 1), made.workspaceId, made.value.sources[0]!.sourceId, true);
  expect(store.source(made.workspaceId, made.value.sources[0]!.sourceId).state).toBe("unavailable");
  expect(db.db.query("SELECT status FROM cowork_operations WHERE operation_id=?").get(made.operationId)).toEqual({ status: "superseded" });
});

test("a revoked source cannot justify removing the last usable or preparing replacement", () => {
  const { store } = open(), made = create(store, [folder, repo]);
  store.removeSource(context("revoke", 1), made.workspaceId, made.value.sources[0]!.sourceId, true);
  code(() => store.removeSource(context("remove", 2), made.workspaceId, made.value.sources[1]!.sourceId), "last_source_required");
});

test("GitHub-only membership alone never authorizes publication to a disconnected repository", () => {
  const { store } = open(), made = create(store, [repo]); ready(store, made.workspaceId);
  const authority = new CoworkAuthority(store, { folder: () => undefined, repository: () => ({ readable: true, writable: true, revoked: true }) });
  expect(store.githubOnly(made.workspaceId)).toBe(true);
  code(() => authority.requireAutomaticPublication(made.workspaceId, made.value.sources[0]!.sourceId), "authority_denied");
});

test("read-only GitHub credentials permit local checkout work but cannot authorize publication", () => {
  const { store } = open(), made = create(store, [repo]); ready(store, made.workspaceId);
  const authority = new CoworkAuthority(store, { folder: () => undefined, repository: () => ({ readable: true, writable: false, revoked: false }) });
  expect(authority.requireSource(made.workspaceId, made.value.sources[0]!.sourceId, true).access).toBe("read-write");
  code(() => authority.requireAutomaticPublication(made.workspaceId, made.value.sources[0]!.sourceId), "authority_denied");
});

test("empty current-schema rollback to v7 preserves run-home metadata and refuses populated Cowork state", () => {
  const { store, home, db } = open();
  db.db.run("INSERT INTO run_root_quarantine(root,recorded_at,detail_json) VALUES('/fixture/run','now','{}')");
  expect(downgradeCoworkRuntimeStateToV7(home)).toEqual({ from: RUNTIME_STATE_SCHEMA_VERSION, to: 7 });
  const raw = new Database(join(home, "runtimes/runtime-state.db"), { readonly: true });
  try {
    expect(raw.query("PRAGMA user_version").get()).toEqual({ user_version: 7 });
    expect(raw.query("SELECT root FROM run_root_quarantine").get()).toEqual({ root: "/fixture/run" });
    expect(raw.query("SELECT name FROM sqlite_master WHERE name='cowork_sources'").get()).toBeNull();
  } finally { raw.close(); }
  const reopened = open(home); create(reopened.store);
  expect(() => downgradeCoworkRuntimeStateToV7(home)).toThrow("Cowork authority");
  expect(reopened.store.list()).toHaveLength(1);
});

test("multi-source supersession emits one durable terminal receipt and later source readiness cannot revive it", () => {
  const { store, home, db } = open(), made = create(store, [folder, repo]);
  const epoch = store.beginIncarnation(made.workspaceId, "first", 1);
  const replaced = store.removeSource(context("revoke", 1), made.workspaceId, made.value.sources[0]!.sourceId, true);
  const current = store.refreshEpoch(made.workspaceId, epoch.incarnationId, epoch.leaseEpoch);
  store.acknowledgeSource(current, made.value.sources[1]!.sourceId, 1, "ready");
  store.acknowledgeSource(current, made.value.sources[1]!.sourceId, 1, "ready");
  const reopened = open(home).store;
  expect(reopened.operation(made.workspaceId, made.operationId)).toMatchObject({ status: "superseded", terminal: true, receipt: made });
  const changes = db.db.query<{payload_json: string}, [string]>("SELECT payload_json FROM cowork_outbox WHERE operation_id=? AND kind='workspace_operation_changed'").all(made.operationId);
  expect(changes).toHaveLength(1);
  expect(JSON.parse(changes[0]!.payload_json)).toEqual({ operationId: made.operationId, status: "superseded", terminal: true, supersededBy: replaced.operationId });
  expect(reopened.operation(made.workspaceId, replaced.operationId)).toMatchObject({ status: "pending", terminal: false });
  code(() => reopened.operation("other-workspace", made.operationId), "not_found");
});
