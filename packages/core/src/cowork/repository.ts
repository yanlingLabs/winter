import { durableCoworkTransaction } from "./durable-transaction";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { ApprovalPolicy } from "@yanlinglabs/winter-protocol";
import type { RuntimeStateDb } from "../runtime-state/db";
import { CoworkError, isTerminalOperationStatus, type OperationStatus, type CapabilityCeiling, type ConversationBinding, type CoworkConversation, type GuestEpoch, type MutationContext, type MutationReceipt, type PublicationPolicy, type SourceSelection, type Workspace, type WorkspacePolicy, type WorkspaceSource } from "./types";

/** Host-owned index dependency. Never RPC/guest data; caller must commit the actual
 * session creation first and bind synchronously while that SessionStore remains open. */
export interface CoworkCommittedSessions { hasCommittedSession(sessionId: string): boolean }
export interface WorkspaceChange {
  changeId: string; workspaceId: string; operationId: string; revision: number; kind: string; payload: unknown;
}
type Row = Record<string, any>;
const SESSION_ID = /^s_[0-9a-f]{12}$/;
/** #92 N3: the first guest uid the allocator hands out (below it: the image's system and fixed ids). */
export const COWORK_GUEST_UID_FIRST = 2001;
const POLICIES = new Set(["plan", "dont-ask", "ask", "accept-edits", "auto", "bypass"]);
const id = (value: string) => { if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value)) throw new CoworkError("invalid_request"); return value; };
const text = (value: string, max = 512) => { if (typeof value !== "string" || !value.trim() || value.length > max || /[\0\r\n]/.test(value)) throw new CoworkError("invalid_request"); return value; };
const canonical = (value: any): string => JSON.stringify(value, function (_key, item) { return item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item; });
const digest = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
export function relativeCoworkPath(value: string): string {
  if (typeof value !== "string" || value.length > 4096 || value.startsWith("/") || /[\\\0]/.test(value) || value.split("/").includes("..")) throw new CoworkError("invalid_request");
  return value.split("/").filter(part => part && part !== ".").join("/") || ".";
}
function ceiling(value: CapabilityCeiling): CapabilityCeiling {
  const names = (values: string[]) => { if (!Array.isArray(values) || values.length > 256) throw new CoworkError("invalid_request"); return [...new Set(values.map(value => text(value, 200)))].sort(); };
  if (!value || !["none", "internet"].includes(value.network)) throw new CoworkError("invalid_request");
  return { toolClasses: names(value.toolClasses), hostServices: names(value.hostServices), connectors: names(value.connectors), network: value.network };
}
function selection(value: SourceSelection): SourceSelection {
  if (!value || !["read-only", "read-write"].includes(value.access)) throw new CoworkError("invalid_request");
  const label = text(value.label, 200), access = value.access;
  if (value.kind === "folder") return { kind: value.kind, label, access, detail: { grantRef: id(value.detail.grantRef), rootIdentity: text(value.detail.rootIdentity) } };
  if (value.kind === "githubRepository") return { kind: value.kind, label, access, detail: { repositoryId: id(value.detail.repositoryId), authorityRef: id(value.detail.authorityRef), initialRef: text(value.detail.initialRef) } };
  throw new CoworkError("invalid_request");
}
type CreationInput = { ownership: "standalone" | "project"; title: string; sources: SourceSelection[]; ceiling: CapabilityCeiling; defaultPolicy?: ApprovalPolicy };
function normalizedCreation(input: CreationInput) {
  if (!["standalone", "project"].includes(input.ownership) || !Array.isArray(input.sources) || input.sources.length < 1 || input.sources.length > 100) throw new CoworkError("invalid_request");
  const normalized = { ...input, title: text(input.title, 200), sources: input.sources.map(selection), ceiling: ceiling(input.ceiling), defaultPolicy: input.defaultPolicy ?? "auto" };
  if (!POLICIES.has(normalized.defaultPolicy)) throw new CoworkError("invalid_request");
  return normalized;
}
function requestDigest(context: MutationContext, input: unknown): string {
  const value = digest({ input: context.requestDigestInput ?? input, expectedRevision: context.expectedRevision ?? null });
  return context.requestDigestInput === undefined ? value : `v2:${value}`;
}
function workspace(row: Row): Workspace {
  return { workspaceId: row.workspace_id, ownership: row.ownership, ownerId: row.owner_id, title: row.title, state: row.state, configRevision: row.config_revision, grantRevision: row.grant_revision, instructionRevision: row.instruction_revision, incarnationId: row.incarnation_id, leaseEpoch: row.lease_epoch, power: row.power, createdAt: row.created_at, updatedAt: row.updated_at };
}
function source(row: Row): WorkspaceSource {
  return { sourceId: row.source_id, workspaceId: row.workspace_id, locationId: row.location_id, kind: row.kind, label: row.label, detail: JSON.parse(row.detail_json), desired: row.desired, state: row.state, access: row.access, revision: row.revision, ackRevision: row.ack_revision, ackIncarnationId: row.ack_incarnation_id, reason: row.reason, restartRequired: Boolean(row.restart_required), trust: row.trust, trustDigest: row.trust_digest, createdAt: row.created_at, updatedAt: row.updated_at };
}

/** Internal host repository, never an RPC/tool surface. Call authority checks before mutation.
 * All desired-state changes, idempotency receipts and event fanout commit together. No async
 * filesystem/VM/network effect occurs inside a transaction or on constructor invocation. */
export class CoworkRepository {
  constructor(readonly rs: RuntimeStateDb, private readonly now: () => string = () => new Date().toISOString(), private readonly mint: (prefix: string) => string = prefix => `${prefix}_${randomUUID()}`,
    /** A conversation's session id, in the session store's own `s_<12 hex>` shape (design G7): a standalone workspace's
     *  `owner_id` and a Project conversation's reservation are both minted here, so the store row and the binding agree. */
    private readonly mintSessionId: () => string = () => `s_${randomBytes(6).toString("hex")}`) {}
  private one(sql: string, ...args: any[]): Row | null { return this.rs.db.query<Row, any[]>(sql).get(...args); }
  private all(sql: string, ...args: any[]): Row[] { return this.rs.db.query<Row, any[]>(sql).all(...args); }
  private run(sql: string, ...args: any[]) { return this.rs.db.run(sql, args); }
  private homeIdentityWithinTransaction(): string {
    // Only our scoped durable entry points call this; never reuse a caller's
    // transaction or start a nested durability wrapper from a source binding.
    if (!this.rs.db.inTransaction) throw new CoworkError("authority_denied");
    const existing = this.one("SELECT home_id FROM cowork_home_identity WHERE singleton=1");
    if (existing) return existing.home_id;
    const homeId = this.mint("home"); this.run("INSERT INTO cowork_home_identity VALUES (1,?,?)", homeId, this.now()); return homeId;
  }
  /** Pure canonical lookup usable within a planner or mutation transaction.
   * Missing authority is refused; this method never provisions an identity. */
  recordedHomeIdentity(): string {
    const existing = this.one("SELECT home_id FROM cowork_home_identity WHERE singleton=1");
    if (!existing) throw new CoworkError("recovery_required");
    return existing.home_id;
  }
  homeIdentity(): string {
    return durableCoworkTransaction(this.rs, () => this.homeIdentityWithinTransaction());
  }
  get(workspaceId: string): Workspace {
    const row = this.one("SELECT * FROM cowork_workspaces WHERE workspace_id=?", id(workspaceId));
    if (!row) throw new CoworkError("not_found"); return workspace(row);
  }
  list(): Workspace[] { return this.all("SELECT * FROM cowork_workspaces WHERE state!='deleted' ORDER BY created_at,workspace_id").map(workspace); }
  project(projectId: string): Workspace {
    const row = this.one("SELECT workspace_id FROM cowork_projects WHERE project_id=?", id(projectId));
    if (!row) throw new CoworkError("not_found");
    const current = this.get(row.workspace_id);
    if (current.ownership !== "project" || current.ownerId !== projectId) throw new CoworkError("authority_denied");
    return current;
  }
  updateTitle(context: MutationContext, workspaceId: string, title: string): MutationReceipt<Workspace> {
    const normalized = text(title, 200);
    return this.mutate(context, "workspace.update", id(workspaceId), { title: normalized }, () => {
      this.run("UPDATE cowork_workspaces SET title=? WHERE workspace_id=?", normalized, workspaceId);
      this.advance(workspaceId);
      return { workspaceId, value: this.get(workspaceId), kind: "workspace_display_changed", applied: true };
    });
  }
  policy(workspaceId: string): WorkspacePolicy {
    const row = this.one("SELECT * FROM cowork_policies WHERE workspace_id=?", id(workspaceId));
    if (!row) throw new CoworkError("not_found");
    return { policyId: row.policy_id, workspaceId, defaultPolicy: row.default_policy, publication: row.publication, ceiling: JSON.parse(row.ceiling_json), revision: row.revision, defaultRevision: row.default_revision, publicationRevision: row.publication_revision };
  }
  sources(workspaceId: string): WorkspaceSource[] { this.get(workspaceId); return this.all("SELECT * FROM cowork_sources WHERE workspace_id=? ORDER BY created_at,source_id", workspaceId).map(source); }
  source(workspaceId: string, sourceId: string): WorkspaceSource {
    const row = this.one("SELECT * FROM cowork_sources WHERE workspace_id=? AND source_id=?", id(workspaceId), id(sourceId));
    if (!row) throw new CoworkError("not_found"); return source(row);
  }
  binding(sessionId: string): ConversationBinding {
    const row = this.one("SELECT * FROM cowork_conversations WHERE session_id=?", id(sessionId));
    if (!row) throw new CoworkError("not_found");
    // Migration 18's outputs location has no source. Every reader of ConversationBinding assumes one, so such a row is
    // refused here, typed, until the outputs slice (D3b) widens the type; it is never read with a null source id.
    if (row.location_kind !== "source" || row.source_id === null) throw new CoworkError("unsupported_topology");
    return { sessionId, workspaceId: row.workspace_id, projectId: row.project_id, sourceId: row.source_id, relativeCwd: row.relative_cwd, policy: row.policy, restrictions: JSON.parse(row.restrictions_json), revision: row.revision, state: row.state, createdAt: row.created_at };
  }
  /** Where a bound conversation works (migration 18). `outputs` rows exist only once the outputs slice binds them. */
  /** Session door D3b: a conversation of either location (the DOOR's run path only; see `CoworkConversation`). */
  conversation(sessionId: string): CoworkConversation {
    const row = this.one("SELECT * FROM cowork_conversations WHERE session_id=?", id(sessionId));
    if (!row) throw new CoworkError("not_found");
    const common = { sessionId, workspaceId: row.workspace_id, projectId: row.project_id, policy: row.policy, restrictions: JSON.parse(row.restrictions_json), revision: row.revision, state: row.state, createdAt: row.created_at };
    if (row.location_kind === "outputs" && row.source_id === null && row.relative_cwd === ".") return { location: "outputs", ...common };
    if (row.location_kind === "source" && typeof row.source_id === "string") return { location: "source", ...common, sourceId: row.source_id, relativeCwd: row.relative_cwd };
    throw new CoworkError("recovery_required");
  }
  conversationLocation(sessionId: string): "source" | "outputs" {
    const row = this.one("SELECT location_kind FROM cowork_conversations WHERE session_id=?", id(sessionId));
    if (!row) throw new CoworkError("not_found");
    if (row.location_kind !== "source" && row.location_kind !== "outputs") throw new CoworkError("recovery_required");
    return row.location_kind;
  }
  /** A bound conversation's safe workspace reference (`session.list`'s `cowork` field): ids only, never a path, label or grant. */
  conversationRef(sessionId: string): { workspaceId: string; projectId: string | null } | undefined {
    const row = this.one("SELECT workspace_id, project_id FROM cowork_conversations WHERE session_id=?", id(sessionId));
    return row ? { workspaceId: row.workspace_id, projectId: row.project_id } : undefined;
  }
  /** The guest runtime's durable backend identity for a conversation (G9), or null before its first guest start. */
  conversationBackend(sessionId: string): string | null {
    const row = this.one("SELECT backend_session_id FROM cowork_conversations WHERE session_id=?", id(sessionId));
    if (!row) throw new CoworkError("not_found");
    return row.backend_session_id ?? null;
  }
  /** Records the backend identity once, at the moment a guest receives the conversation (the conversation set at
   *  `mounted`). Write-once: the same value again is a no-op, any other value is `authority_denied`. A conversation with
   *  a recorded identity has had a guest store, so without cold resume (D10) it can never start fresh again. */
  assignConversationBackend(sessionId: string, backendSessionId: string, incarnationId?: string): void {
    const backend = id(backendSessionId);
    if (incarnationId !== undefined) id(incarnationId);
    durableCoworkTransaction(this.rs, () => {
      const row = this.one("SELECT backend_session_id, state FROM cowork_conversations WHERE session_id=?", id(sessionId));
      if (!row) throw new CoworkError("not_found");
      if (row.state !== "active") throw new CoworkError("authority_denied");
      if (row.backend_session_id !== null && row.backend_session_id !== undefined && row.backend_session_id !== backend) throw new CoworkError("authority_denied");
      this.run("UPDATE cowork_conversations SET backend_session_id=? WHERE session_id=? AND backend_session_id IS NULL", backend, sessionId);
      // #92 N3 (section 3.2): WRITE-AHEAD before the guest receives the set: `none` becomes `started`, so no later resume is
      // ever told "fresh" over a store that may exist. The incarnation that received it is recorded with it.
      this.run("UPDATE cowork_conversations SET store_state='started' WHERE session_id=? AND store_state='none'", sessionId);
      if (incarnationId !== undefined) this.run("UPDATE cowork_conversations SET last_incarnation_id=? WHERE session_id=?", incarnationId, sessionId);
    });
  }
  /** #92 N3: the conversation's guest store state (`none`, `started`, `created`, `lost`; section 3.2). */
  storeState(sessionId: string): { readonly storeState: "none" | "started" | "created" | "lost"; readonly lastIncarnationId: string | null; readonly runtimeUid: number | null; readonly toolUid: number | null } {
    const row = this.one("SELECT store_state, last_incarnation_id, runtime_uid, tool_uid FROM cowork_conversations WHERE session_id=?", id(sessionId));
    if (!row) throw new CoworkError("not_found");
    return { storeState: row.store_state, lastIncarnationId: row.last_incarnation_id ?? null, runtimeUid: row.runtime_uid ?? null, toolUid: row.tool_uid ?? null };
  }
  /** #92 N3: the guest completed a turn in a `started` store, so the store exists (`created`). Idempotent; never leaves `lost`. */
  markStoreCreated(sessionId: string): void {
    durableCoworkTransaction(this.rs, () => {
      const row = this.one("SELECT store_state FROM cowork_conversations WHERE session_id=?", id(sessionId));
      if (!row) throw new CoworkError("not_found");
      if (row.store_state === "none") throw new CoworkError("recovery_required"); // a turn without the write-ahead record
      this.run("UPDATE cowork_conversations SET store_state='created' WHERE session_id=? AND store_state='started'", sessionId);
    });
  }
  /** #92 N3 (CR4 step 9): the store is gone (a `filesystem_mismatch`, a `format-new` plan over a started store, a
   *  `resume_store_missing` fault). Terminal: such a conversation never resumes and never starts fresh under its identity. */
  markStoreLost(sessionId: string): void {
    durableCoworkTransaction(this.rs, () => {
      if (!this.one("SELECT 1 FROM cowork_conversations WHERE session_id=?", id(sessionId))) throw new CoworkError("not_found");
      this.run("UPDATE cowork_conversations SET store_state='lost' WHERE session_id=? AND store_state IN ('started','created')", sessionId);
    });
  }
  /**
   * #92 N3 (L7): the conversation's stable guest uids, allocated ONCE, and only through `cowork_guest_uids`, in the same
   * transaction that writes them to the conversation. The lowest free pair from `COWORK_GUEST_UID_FIRST` up, skipping every
   * uid the workspace's table still holds (retired ones included, until released) and the workspace gid. Idempotent.
   */
  allocateGuestUids(sessionId: string, workspaceGid: number): { readonly runtimeUid: number; readonly toolUid: number } {
    return durableCoworkTransaction(this.rs, () => {
      const row = this.one("SELECT workspace_id, runtime_uid, tool_uid, state FROM cowork_conversations WHERE session_id=?", id(sessionId));
      if (!row) throw new CoworkError("not_found");
      if (row.runtime_uid !== null && row.runtime_uid !== undefined && row.tool_uid !== null && row.tool_uid !== undefined) return { runtimeUid: row.runtime_uid, toolUid: row.tool_uid };
      if (row.state !== "active") throw new CoworkError("authority_denied");
      const held = new Set(this.all("SELECT uid FROM cowork_guest_uids WHERE workspace_id=?", row.workspace_id).map(value => value.uid as number));
      const picked: number[] = [];
      for (let uid = COWORK_GUEST_UID_FIRST; uid <= 65533 && picked.length < 2; uid++) if (uid !== workspaceGid && !held.has(uid)) picked.push(uid);
      if (picked.length < 2) throw new CoworkError("recovery_required");
      const [runtimeUid, toolUid] = picked as [number, number], at = this.now();
      this.run("INSERT INTO cowork_guest_uids(workspace_id,uid,role,session_id,allocated_at) VALUES(?,?,'runtime',?,?)", row.workspace_id, runtimeUid, sessionId, at);
      this.run("INSERT INTO cowork_guest_uids(workspace_id,uid,role,session_id,allocated_at) VALUES(?,?,'tool',?,?)", row.workspace_id, toolUid, sessionId, at);
      this.run("UPDATE cowork_conversations SET runtime_uid=?, tool_uid=? WHERE session_id=?", runtimeUid, toolUid, sessionId);
      return { runtimeUid, toolUid };
    });
  }
  /** #92 N3: the boot ids of `incarnationId` whose end the host PROVED (`ended_proof` set; D1 evidence), at most 4. */
  endedGuestBoots(workspaceId: string, incarnationId: string): string[] {
    return this.all("SELECT guest_boot_id FROM cowork_guest_boots WHERE workspace_id=? AND incarnation_id=? AND ended_proof IS NOT NULL ORDER BY recorded_at LIMIT 4", id(workspaceId), id(incarnationId)).map(value => value.guest_boot_id as string);
  }
  private insertSource(workspaceId: string, input: SourceSelection): WorkspaceSource {
    const normalized = selection(input), sourceId = this.mint("source"), locationId = this.mint("location"), at = this.now();
    this.run("INSERT INTO cowork_sources(source_id,workspace_id,location_id,kind,label,detail_json,desired,state,access,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,'present','preparing',?,1,?,?)", sourceId, workspaceId, locationId, normalized.kind, normalized.label, canonical(normalized.detail), normalized.access, at, at);
    return this.source(workspaceId, sourceId);
  }
  private publish(workspaceId: string, operationId: string, kind: string, payload: unknown): void {
    const changeId = this.mint("change"), current = this.get(workspaceId);
    // Capture safe metadata at COMMIT, never re-project a later source/policy state into an older change.
    const data = payload as Record<string, unknown>;
    if (kind === "workspace_sources_changed") {
      const selected = typeof data.sourceId === "string" ? [this.source(workspaceId, data.sourceId)] : this.sources(workspaceId);
      payload = { phase: data.incarnationId ? "acknowledged" : "requested", sources: selected.map(value => ({
        sourceId: value.sourceId, sourceRevision: value.revision, desired: value.desired, state: value.state,
        ackRevision: value.ackRevision, restartRequired: value.restartRequired,
        reason: value.reason === null ? null : value.reason === "access_revoked" ? "access_revoked" : "source_unavailable",
      })) };
    } else if (kind === "workspace_policy_changed") {
      const policy = this.policy(workspaceId);
      payload = { policyRevision: policy.revision, defaultRevision: policy.defaultRevision, publicationRevision: policy.publicationRevision,
        defaultPolicy: policy.defaultPolicy, publication: policy.publication, phase: "metadata" };
    }
    this.run("INSERT INTO cowork_outbox(change_id,workspace_id,operation_id,revision,kind,payload_json,created_at) VALUES(?,?,?,?,?,?,?)", changeId, workspaceId, operationId, current.configRevision, kind, canonical(payload), this.now());
    this.run("INSERT INTO cowork_outbox_deliveries(change_id,session_id,state) SELECT ?,session_id,'pending' FROM cowork_conversations WHERE workspace_id=? AND state!='deleted'", changeId, workspaceId);
  }
  operation(workspaceId: string, operationId: string): { operationId: string; status: OperationStatus; terminal: boolean; receipt: MutationReceipt<unknown> } {
    const row = this.one("SELECT status,result_json FROM cowork_operations WHERE workspace_id=? AND operation_id=?", id(workspaceId), id(operationId));
    if (!row) throw new CoworkError("not_found");
    return { operationId, status: row.status, terminal: isTerminalOperationStatus(row.status), receipt: JSON.parse(row.result_json) };
  }
  private concludeOperation(workspaceId: string, operationId: string, status: "applied" | "superseded" | "failed", supersededBy?: string): void {
    const changed = this.run("UPDATE cowork_operations SET status=?,updated_at=? WHERE workspace_id=? AND operation_id=? AND status='pending'", status, this.now(), workspaceId, operationId);
    if (changed.changes) this.publish(workspaceId, operationId, "workspace_operation_changed", { operationId, status, terminal: true, ...(supersededBy ? { supersededBy } : {}) });
  }
  /** Session door D4 fix: the workspace's creation concluded `failed` (S7B's provisioning answered `failed` before any
   *  guest booted). Such a workspace is terminal for execution: it reserves and binds no conversation and never boots. */
  private requireProvisioned(workspaceId: string): void {
    if (this.one("SELECT 1 FROM cowork_operations WHERE workspace_id=? AND method IN ('workspace.create','project.create') AND status='failed' LIMIT 1", workspaceId)) throw new CoworkError("recovery_required");
  }
  /** Session door D4c: workspace and Project creations whose operation is still pending, i.e. the ones whose post-COMMIT
   *  provisioning may never have run or finished (a crash between the commit and `provision`). Oldest first, bounded. */
  pendingCreations(limit = 1000, after?: { readonly createdAt: string; readonly operationId: string }): { workspaceId: string; operationId: string; createdAt: string }[] {
    const bounded = Math.max(1, Math.min(10_000, Math.floor(limit)));
    const where = "status='pending' AND method IN ('workspace.create','project.create') AND workspace_id IS NOT NULL";
    const rows = after === undefined
      ? this.all(`SELECT workspace_id, operation_id, created_at FROM cowork_operations WHERE ${where} ORDER BY created_at, operation_id LIMIT ?`, bounded)
      : this.all(`SELECT workspace_id, operation_id, created_at FROM cowork_operations WHERE ${where} AND (created_at > ? OR (created_at = ? AND operation_id > ?)) ORDER BY created_at, operation_id LIMIT ?`, after.createdAt, after.createdAt, after.operationId, bounded);
    return rows.map(row => ({ workspaceId: row.workspace_id, operationId: row.operation_id, createdAt: row.created_at }));
  }
  /** Session door D4c: the provisioning port answered `failed` for a creation: its operation concludes `failed` (terminal),
   *  durably, with a `workspace_operation_changed`. Only a pending creation operation; idempotent. The port's reason text is
   *  never kept. */
  failCreationProvisioning(workspaceId: string, operationId: string): void {
    durableCoworkTransaction(this.rs, () => {
      const row = this.one("SELECT method, status FROM cowork_operations WHERE workspace_id=? AND operation_id=?", id(workspaceId), id(operationId));
      if (!row || !["workspace.create", "project.create"].includes(row.method)) throw new CoworkError("not_found");
      if (row.status !== "pending") return;
      // `failed` concludes only for a workspace no guest has ever started (lease epoch 0, stopped): only then can no source
      // of it become ready. A booted workspace's late `failed` contradicts an earlier `applied` and stays UNCERTAIN (pending).
      // Once concluded, `beginIncarnation` refuses the workspace, so no source can become ready afterwards either.
      const workspace = this.get(workspaceId);
      if (workspace.leaseEpoch !== 0 || workspace.power !== "stopped") return;
      this.concludeOperation(workspaceId, operationId, "failed");
    });
  }
  /** Exact immutable receipt lookup only; caller must reauthorize live workspace/grants. */
  replay<T>(context: MutationContext, method: string, scope: string, legacyInput?: () => unknown): MutationReceipt<T> | undefined {
    if (context.requestDigestInput === undefined) throw new CoworkError("invalid_request");
    id(context.principalId); id(context.requestId); method = id(context.method ?? method); id(scope);
    const previous = this.one("SELECT request_digest,result_json FROM cowork_operations WHERE principal_id=? AND method=? AND scope=? AND request_id=?", context.principalId, method, scope, context.requestId);
    if (!previous) return undefined;
    // v2 binds the closed client request. Legacy receipts bind resolved, normalized host input;
    // verify that input only through a fresh selection/authority resolver, never infer opaque IDs.
    let expected: string;
    if (/^[a-f0-9]{64}$/.test(previous.request_digest)) {
      if (!legacyInput) throw new CoworkError("authority_denied");
      expected = digest({ input: legacyInput(), expectedRevision: context.expectedRevision ?? null });
    } else expected = requestDigest(context, context.requestDigestInput);
    if (previous.request_digest !== expected) throw new CoworkError("request_conflict");
    return JSON.parse(previous.result_json) as MutationReceipt<T>;
  }
  replayCreation(context: MutationContext, resolve: () => CreationInput): ReturnType<CoworkRepository["create"]> | undefined {
    return this.replay(context, "workspace.create", "new", () => normalizedCreation(resolve()));
  }
  replaySourceAddition(context: MutationContext, workspaceId: string, resolve: () => SourceSelection): MutationReceipt<WorkspaceSource> | undefined {
    return this.replay(context, "workspace.source.add", id(workspaceId), () => selection(resolve()));
  }
  private mutate<T>(context: MutationContext, method: string, scope: string, input: unknown, body: () => { workspaceId: string; value: T; kind: string; payload?: unknown; changedSources?: string[]; applied?: boolean }): MutationReceipt<T> {
    id(context.principalId); id(context.requestId); method = id(context.method ?? method);
    const currentDigest = requestDigest(context, input);
    return durableCoworkTransaction(this.rs, () => {
      const previous = this.one("SELECT request_digest,result_json FROM cowork_operations WHERE principal_id=? AND method=? AND scope=? AND request_id=?", context.principalId, method, scope, context.requestId);
      if (previous) {
        if (previous.request_digest !== currentDigest) throw new CoworkError("request_conflict");
        return JSON.parse(previous.result_json) as MutationReceipt<T>;
      }
      if (scope !== "new") {
        const current = this.get(scope);
        if (!Number.isSafeInteger(context.expectedRevision) || context.expectedRevision !== current.configRevision) throw new CoworkError("revision_conflict", current.configRevision);
        const narrowing = method === "workspace.source.revoke";
        if (current.state !== "retained" && !(narrowing && current.state !== "deleted")) throw new CoworkError("authority_denied");
      }
      context.admitMutation?.();
      this.homeIdentityWithinTransaction();
      const result = body(), current = this.get(result.workspaceId), operationId = this.mint("operation"), at = this.now();
      const receipt: MutationReceipt<T> = { operationId, workspaceId: current.workspaceId, revision: current.configRevision, value: result.value };
      context.validateReceipt?.(receipt);
      this.run("INSERT INTO cowork_operations VALUES(?,?,?,?,?,?,?,?,?,?,?)", operationId, context.principalId, method, scope, context.requestId, currentDigest, current.workspaceId, result.applied ? "applied" : "pending", canonical(receipt), at, at);
      for (const sourceId of result.changedSources ?? []) {
        const previousOperation = this.one("SELECT operation_id FROM cowork_sources WHERE workspace_id=? AND source_id=?", current.workspaceId, sourceId)?.operation_id;
        if (previousOperation) this.concludeOperation(current.workspaceId, previousOperation, "superseded", operationId);
        this.run("UPDATE cowork_sources SET operation_id=? WHERE workspace_id=? AND source_id=?", operationId, current.workspaceId, sourceId);
      }
      this.publish(current.workspaceId, operationId, result.kind, result.payload ?? {});
      return receipt;
    });
  }
  private advance(workspaceId: string, authority = false): void {
    this.run("UPDATE cowork_workspaces SET config_revision=config_revision+1,grant_revision=grant_revision+?,updated_at=? WHERE workspace_id=?", authority ? 1 : 0, this.now(), workspaceId);
  }
  create(context: MutationContext, input: CreationInput): MutationReceipt<{ workspace: Workspace; sources: WorkspaceSource[]; policy: WorkspacePolicy; automaticPublication: boolean }> {
    const normalized = normalizedCreation(input);
    return this.mutate(context, "workspace.create", "new", normalized, () => {
      const workspaceId = this.mint("workspace"), ownerId = input.ownership === "project" ? this.mint("project") : this.sessionIdOf(this.mintSessionId()), at = this.now();
      this.run("INSERT INTO cowork_workspaces(workspace_id,ownership,owner_id,title,state,config_revision,grant_revision,instruction_revision,incarnation_id,lease_epoch,power,created_at,updated_at) VALUES(?,?,?,?,'retained',1,1,1,NULL,0,'stopped',?,?)", workspaceId, input.ownership, ownerId, normalized.title, at, at);
      this.run("INSERT INTO cowork_policies VALUES(?,?,?,?,?,1,1,1)", workspaceId, this.mint("policy"), normalized.defaultPolicy, "github-only-feature-branches", canonical(normalized.ceiling));
      if (input.ownership === "project") this.run("INSERT INTO cowork_projects VALUES(?,?,?)", ownerId, workspaceId, at);
      const sources = normalized.sources.map(value => this.insertSource(workspaceId, value));
      context.bindSources?.(sources);
      return { workspaceId, value: { workspace: this.get(workspaceId), sources, policy: this.policy(workspaceId), automaticPublication: this.githubOnly(workspaceId) }, kind: "workspace_created", payload: { ownership: input.ownership }, changedSources: sources.map(value => value.sourceId) };
    });
  }
  addSource(context: MutationContext, workspaceId: string, input: SourceSelection): MutationReceipt<WorkspaceSource> {
    const normalized = selection(input);
    return this.mutate(context, "workspace.source.add", id(workspaceId), normalized, () => {
      if (this.sources(workspaceId).filter(value => value.state !== "detached").length >= 100) throw new CoworkError("invalid_request");
      const value = this.insertSource(workspaceId, normalized); context.bindSources?.([value]); this.advance(workspaceId, true);
      return { workspaceId, value, kind: "workspace_sources_changed", payload: { sourceId: value.sourceId, state: value.state }, changedSources: [value.sourceId] };
    });
  }
  removeSource(context: MutationContext, workspaceId: string, sourceId: string, revoke = false): MutationReceipt<WorkspaceSource> {
    return this.mutate(context, revoke ? "workspace.source.revoke" : "workspace.source.remove", id(workspaceId), { sourceId: id(sourceId) }, () => {
      const current = this.source(workspaceId, sourceId);
      if (current.state === "detached" || (!revoke && current.desired === "removed")) throw new CoworkError("invalid_request");
      if (!revoke) {
        const others = this.sources(workspaceId).filter(value => value.desired === "present" && value.sourceId !== sourceId);
        const targetUsableOrPreparing = current.state === "ready" || current.state === "preparing";
        if (others.length < 1 || (targetUsableOrPreparing && !others.some(value => value.state === "ready" || value.state === "preparing"))) throw new CoworkError("last_source_required");
      }
      const desired = revoke ? current.desired : "removed";
      // Narrow durable authority in the same transaction as desired source state/outbox.
      this.run("UPDATE cowork_folder_grants SET state='revoked',bookmark=X'',root_path='',revision=revision+1,updated_at=? WHERE workspace_id=? AND source_id=? AND state='active'", this.now(), workspaceId, sourceId);
      this.run("UPDATE cowork_sources SET desired=?,state=?,revision=revision+1,ack_revision=NULL,ack_incarnation_id=NULL,reason=?,restart_required=1,trust='revoked',updated_at=? WHERE source_id=?", desired, desired === "removed" ? "removing" : "unavailable", revoke ? "access_revoked" : null, this.now(), sourceId);
      this.advance(workspaceId, true);
      return { workspaceId, value: this.source(workspaceId, sourceId), kind: "workspace_sources_changed", payload: { sourceId, revoked: revoke }, changedSources: [sourceId] };
    });
  }
  updatePolicy(context: MutationContext, workspaceId: string, change: { defaultPolicy?: ApprovalPolicy; publication?: PublicationPolicy; ceiling?: CapabilityCeiling }): MutationReceipt<WorkspacePolicy> {
    if (!Object.keys(change).length || (change.defaultPolicy !== undefined && !POLICIES.has(change.defaultPolicy)) || (change.publication !== undefined && !["manual", "github-only-feature-branches"].includes(change.publication))) throw new CoworkError("invalid_request");
    const normalized = { ...change, ...(change.ceiling ? { ceiling: ceiling(change.ceiling) } : {}) };
    return this.mutate(context, "workspace.policy.update", id(workspaceId), normalized, () => {
      const current = this.policy(workspaceId);
      this.run("UPDATE cowork_policies SET default_policy=?,publication=?,ceiling_json=?,revision=revision+1,default_revision=default_revision+?,publication_revision=publication_revision+? WHERE workspace_id=?", normalized.defaultPolicy ?? current.defaultPolicy, normalized.publication ?? current.publication, canonical(normalized.ceiling ?? current.ceiling), normalized.defaultPolicy ? 1 : 0, normalized.publication ? 1 : 0, workspaceId);
      // Existing conversation policy is deliberately not rewritten by changing a default.
      this.advance(workspaceId, normalized.ceiling !== undefined || normalized.publication !== undefined);
      return { workspaceId, value: this.policy(workspaceId), kind: "workspace_policy_changed" };
    });
  }
  bindConversation(context: MutationContext, workspaceId: string, input: { sessionId: string; sourceId: string; relativeCwd?: string }, sessions: CoworkCommittedSessions): MutationReceipt<ConversationBinding> {
    const normalized = { sessionId: id(input.sessionId), sourceId: id(input.sourceId), relativeCwd: relativeCoworkPath(input.relativeCwd ?? ".") };
    // The two stores cannot share an atomic transaction. Require committed index creation
    // before entering canonical binding, with no await/reentrancy or permissive fallback.
    if (!sessions || typeof sessions.hasCommittedSession !== "function" || sessions.hasCommittedSession(normalized.sessionId) !== true) throw new CoworkError("authority_denied");
    return this.mutate(context, "conversation.bind", id(workspaceId), normalized, () => {
      if (sessions.hasCommittedSession(normalized.sessionId) !== true) throw new CoworkError("authority_denied");
      const current = this.get(workspaceId), selected = this.source(workspaceId, normalized.sourceId), policy = this.policy(workspaceId);
      this.requireProvisioned(workspaceId);
      if (current.ownership === "standalone" && current.ownerId !== normalized.sessionId) throw new CoworkError("authority_denied");
      // A conversation may bind a source no guest has acknowledged yet (`preparing`: a workspace is created stopped and its
      // sources become `ready` only when an incarnation acknowledges them), since creation precedes the first boot. This
      // grants nothing: at `mounted` the driver's `requireSource` demands `ready`, acknowledged at the source's current
      // revision by THAT incarnation, before any conversation set exists. A removed, revoked or unavailable source refuses.
      if (!(selected.state === "ready" || selected.state === "preparing") || selected.desired !== "present") throw new CoworkError("source_unavailable");
      if (this.one("SELECT session_id FROM cowork_conversations WHERE session_id=?", normalized.sessionId)) throw new CoworkError("authority_denied");
      this.run("INSERT INTO cowork_conversations(session_id,workspace_id,project_id,location_kind,source_id,relative_cwd,policy,restrictions_json,revision,state,created_at) VALUES(?,?,?,'source',?,?,?,?,1,'active',?)", normalized.sessionId, workspaceId, current.ownership === "project" ? current.ownerId : null, normalized.sourceId, normalized.relativeCwd, policy.defaultPolicy, canonical(policy.ceiling), this.now());
      this.advance(workspaceId);
      return { workspaceId, value: this.binding(normalized.sessionId), kind: "conversation_bound", payload: { sessionId: normalized.sessionId } };
    });
  }
  private sessionIdOf(value: string): string {
    if (typeof value !== "string" || !SESSION_ID.test(value)) throw new CoworkError("invalid_request");
    return value;
  }
  /**
   * Session door D4: the durable first step of a Cowork `session.create`, keyed by (principal, workspace, requestId).
   * A fresh request reserves its conversation's session id (`pending`): a standalone workspace's single conversation is its
   * `owner_id`, a Project conversation gets a fresh `s_<12 hex>` that neither another reservation, a binding nor `taken`
   * (the session store's own index) holds. The same request again answers the SAME reservation; a different request
   * under the same id is `request_conflict`. A standalone workspace whose one conversation is already reserved or bound
   * answers `conversation_limit` to any other request. Only `cowork/session-door.ts` calls it (pinned).
   */
  reserveConversation(input: { principalId: string; workspaceId: string; requestId: string; scope: string; requestDigest: string }, taken: (sessionId: string) => boolean): { sessionId: string; state: "pending" | "bound" } {
    id(input.principalId); id(input.workspaceId); id(input.requestId); id(input.scope);
    if (!/^[a-f0-9]{64}$/.test(input.requestDigest)) throw new CoworkError("invalid_request");
    return durableCoworkTransaction(this.rs, () => {
      const previous = this.one("SELECT * FROM cowork_session_reservations WHERE principal_id=? AND workspace_id=? AND request_id=?", input.principalId, input.workspaceId, input.requestId);
      if (previous) {
        if (previous.request_digest !== input.requestDigest || previous.scope !== input.scope) throw new CoworkError("request_conflict");
        return { sessionId: previous.session_id, state: previous.state };
      }
      const workspace = this.get(input.workspaceId);
      if (workspace.state !== "retained") throw new CoworkError("authority_denied");
      this.requireProvisioned(input.workspaceId);
      const held = (sessionId: string) => this.one("SELECT 1 FROM cowork_session_reservations WHERE session_id=? UNION ALL SELECT 1 FROM cowork_conversations WHERE session_id=?", sessionId, sessionId) !== null;
      let sessionId: string;
      if (workspace.ownership === "standalone") {
        sessionId = this.sessionIdOf(workspace.ownerId);
        if (held(sessionId)) throw new CoworkError("conversation_limit");
        if (taken(sessionId)) throw new CoworkError("authority_denied"); // a non-Cowork row holds the id: never adopted
      } else {
        let attempts = 0;
        do {
          if (++attempts > 8) throw new CoworkError("recovery_required");
          sessionId = this.sessionIdOf(this.mintSessionId());
        } while (held(sessionId) || taken(sessionId));
      }
      this.run("INSERT INTO cowork_session_reservations VALUES(?,?,?,?,?,?,'pending',?)", input.principalId, input.workspaceId, input.requestId, input.requestDigest, sessionId, input.scope, Date.now());
      return { sessionId, state: "pending" as const };
    });
  }
  /** The binding committed: the reservation is answered. Idempotent; only for a bound session of the same workspace. */
  completeReservation(sessionId: string): void {
    durableCoworkTransaction(this.rs, () => {
      const row = this.one("SELECT r.workspace_id AS reserved, c.workspace_id AS bound FROM cowork_session_reservations r LEFT JOIN cowork_conversations c USING(session_id) WHERE r.session_id=?", this.sessionIdOf(sessionId));
      if (!row || row.bound !== row.reserved) throw new CoworkError("authority_denied");
      this.run("UPDATE cowork_session_reservations SET state='bound' WHERE session_id=? AND state='pending'", sessionId);
    });
  }
  /** A definite refusal of the bind (nothing bound): the pending reservation is withdrawn, so the request starts over.
   *  The door deletes the session store row FIRST; a crash between the two leaves a pending reservation, which resumes. */
  withdrawReservation(sessionId: string): void {
    durableCoworkTransaction(this.rs, () => {
      if (this.one("SELECT 1 FROM cowork_conversations WHERE session_id=?", this.sessionIdOf(sessionId))) throw new CoworkError("authority_denied");
      this.run("DELETE FROM cowork_session_reservations WHERE session_id=? AND state='pending'", sessionId);
    });
  }
  /** Session door D4 fix: a STANDALONE workspace's pending reservation, unbound and created before `before` (epoch ms), that
   *  belongs to a request other than `except`. Its request abandoned it (a non-`CoworkError` throw, or a crash, never
   *  retried); the door withdraws it so the workspace's one conversation can be created again. Read only. */
  abandonedReservation(workspaceId: string, except: { principalId: string; requestId: string }, before: number): string | undefined {
    const row = this.one(`SELECT r.session_id FROM cowork_session_reservations r JOIN cowork_workspaces w USING(workspace_id)
      WHERE r.workspace_id=? AND w.ownership='standalone' AND r.state='pending' AND r.created_at<=?
        AND NOT (r.principal_id=? AND r.request_id=?)
        AND NOT EXISTS (SELECT 1 FROM cowork_conversations c WHERE c.session_id=r.session_id)
      ORDER BY r.created_at LIMIT 1`, workspaceId, before, except.principalId, except.requestId);
    return row?.session_id;
  }
  /** Whether a live reservation holds `sessionId` (the session store's admission for a Cowork row). */
  isReservedSession(sessionId: string): boolean {
    return SESSION_ID.test(sessionId) && this.one("SELECT 1 FROM cowork_session_reservations WHERE session_id=?", sessionId) !== null;
  }
  /**
   * Session door D3b: bind a conversation to its OWN outputs location (O1, owner decision 2026-10-18). No source is named;
   * the workspace's sources are untouched and may stay `preparing` (N2 has no shares). Same ownership rules as
   * `bindConversation`: a standalone workspace binds only its reserved id; the store row must be committed first.
   */
  bindOutputsConversation(context: MutationContext, workspaceId: string, input: { sessionId: string }, sessions: CoworkCommittedSessions): MutationReceipt<{ sessionId: string; location: "outputs" }> {
    const normalized = { sessionId: id(input.sessionId), location: "outputs" as const };
    if (!sessions || typeof sessions.hasCommittedSession !== "function" || sessions.hasCommittedSession(normalized.sessionId) !== true) throw new CoworkError("authority_denied");
    return this.mutate(context, "conversation.bind", id(workspaceId), normalized, () => {
      if (sessions.hasCommittedSession(normalized.sessionId) !== true) throw new CoworkError("authority_denied");
      const current = this.get(workspaceId), policy = this.policy(workspaceId);
      this.requireProvisioned(workspaceId);
      if (current.ownership === "standalone" && current.ownerId !== normalized.sessionId) throw new CoworkError("authority_denied");
      if (this.one("SELECT session_id FROM cowork_conversations WHERE session_id=?", normalized.sessionId)) throw new CoworkError("authority_denied");
      this.run("INSERT INTO cowork_conversations(session_id,workspace_id,project_id,location_kind,source_id,relative_cwd,policy,restrictions_json,revision,state,created_at) VALUES(?,?,?,'outputs',NULL,'.',?,?,1,'active',?)", normalized.sessionId, workspaceId, current.ownership === "project" ? current.ownerId : null, policy.defaultPolicy, canonical(policy.ceiling), this.now());
      this.advance(workspaceId);
      return { workspaceId, value: { sessionId: normalized.sessionId, location: "outputs" as const }, kind: "conversation_bound", payload: { sessionId: normalized.sessionId } };
    });
  }
  /** Controller/coordination service alone calls this after acquiring disk ownership. */
  beginIncarnation(workspaceId: string, incarnationId: string, expectedRevision: number): GuestEpoch {
    return durableCoworkTransaction(this.rs, () => {
      const current = this.get(workspaceId); id(incarnationId);
      if (current.configRevision !== expectedRevision) throw new CoworkError("revision_conflict", current.configRevision);
      if (current.state !== "retained" || current.power !== "stopped") throw new CoworkError("recovery_required");
      this.requireProvisioned(workspaceId);
      this.run("UPDATE cowork_workspaces SET incarnation_id=?,lease_epoch=lease_epoch+1,power='starting',updated_at=? WHERE workspace_id=?", incarnationId, this.now(), workspaceId);
      this.run("UPDATE cowork_sources SET state='preparing',ack_revision=NULL,ack_incarnation_id=NULL WHERE workspace_id=? AND desired='present' AND state='ready'", workspaceId);
      return { workspaceId, incarnationId, leaseEpoch: current.leaseEpoch + 1, configRevision: current.configRevision, grantRevision: current.grantRevision };
    });
  }
  /** Host controller refreshes authority before issuing a NEW effect; never rewrite an old
   * callback's captured epoch. Guest messages cannot call this internal ownership port. */
  refreshEpoch(workspaceId: string, incarnationId: string, leaseEpoch: number): GuestEpoch {
    const current = this.get(workspaceId);
    if (!["starting", "running"].includes(current.power) || current.incarnationId !== incarnationId || current.leaseEpoch !== leaseEpoch || current.state !== "retained") throw new CoworkError("stale_acknowledgment");
    return { workspaceId, incarnationId, leaseEpoch, configRevision: current.configRevision, grantRevision: current.grantRevision };
  }
  acknowledgeSource(epoch: GuestEpoch, sourceId: string, revision: number, state: "ready" | "detached"): void {
    durableCoworkTransaction(this.rs, () => this.acknowledgeWithin(epoch, sourceId, revision, state));
  }
  /**
   * #92 N2: the folder shares a guest reported at `shares_mounted`, acknowledged ALL OR NOTHING. Every entry is validated
   * first (a present folder source, `preparing`, at the reported revision), then all are acknowledged in ONE transaction:
   * a report with any bad entry leaves every source as it was, publishes nothing and concludes no operation.
   */
  acknowledgeMountedShares(epoch: GuestEpoch, shares: readonly { readonly sourceId: string; readonly revision: number }[]): void {
    durableCoworkTransaction(this.rs, () => {
      for (const share of shares) {
        const source = this.source(epoch.workspaceId, share.sourceId);
        if (source.kind !== "folder" || source.desired !== "present" || source.state !== "preparing" || source.revision !== share.revision) throw new CoworkError("stale_acknowledgment");
      }
      for (const share of shares) this.acknowledgeWithin(epoch, share.sourceId, share.revision, "ready");
    });
  }
  private acknowledgeWithin(epoch: GuestEpoch, sourceId: string, revision: number, state: "ready" | "detached"): void {
    {
      const current = this.get(epoch.workspaceId), selected = this.source(epoch.workspaceId, sourceId);
      if (!["starting", "running"].includes(current.power) || current.incarnationId !== epoch.incarnationId || current.leaseEpoch !== epoch.leaseEpoch || current.configRevision !== epoch.configRevision || current.grantRevision !== epoch.grantRevision || selected.revision !== revision) throw new CoworkError("stale_acknowledgment");
      if (selected.state === state && selected.ackRevision === revision && selected.ackIncarnationId === epoch.incarnationId) return;
      if (state === "ready" ? selected.desired !== "present" || selected.state !== "preparing" : selected.desired !== "removed" || selected.state !== "removing") throw new CoworkError("stale_acknowledgment");
      const operationId = this.one("SELECT operation_id FROM cowork_sources WHERE source_id=?", sourceId)?.operation_id;
      if (!operationId) throw new CoworkError("recovery_required");
      this.run("UPDATE cowork_sources SET state=?,ack_revision=revision,ack_incarnation_id=?,restart_required=0,reason=NULL,updated_at=? WHERE source_id=?", state, epoch.incarnationId, this.now(), sourceId);
      this.publish(epoch.workspaceId, operationId, "workspace_sources_changed", { sourceId, sourceRevision: revision, state, incarnationId: epoch.incarnationId });
      if (!this.one("SELECT 1 FROM cowork_sources WHERE operation_id=? AND state NOT IN ('ready','detached') LIMIT 1", operationId)) this.concludeOperation(epoch.workspaceId, operationId, "applied");
    }
  }
  /** Membership predicate only; publication still requires current ready source/write authority. */
  githubOnly(workspaceId: string): boolean {
    const current = this.sources(workspaceId).filter(value => value.state !== "detached");
    return current.some(value => value.kind === "githubRepository" && value.desired === "present") && !current.some(value => value.kind === "folder");
  }
  /** Internal change position only: never project raw outbox payloads or global sequence onto the wire. */
  watchPosition(workspaceId: string): number {
    this.get(workspaceId);
    return this.one("SELECT coalesce(max(sequence),0) AS n FROM cowork_outbox WHERE workspace_id=?", workspaceId)!.n;
  }
  /** Host logical-session deletion/missing-session retirement only. Keep workspace, sources,
   * operation receipts and guest data; tombstone prevents future notification fanout.
   * docs/cowork-execution-contracts.md: "Deleting a standalone conversation does not silently destroy its
   * workspace. Detach/archive its workspace for explicit later deletion/export". So the sole conversation
   * of a STOPPED, retained standalone workspace archives it in the same transaction (data untouched; wake is
   * refused until it is explicitly restored). A Project workspace is unaffected, and one that is not stopped
   * stays retained: nothing drains a running guest yet, so its state is not flipped beneath it. */
  abandonConversation(sessionId: string): void {
    id(sessionId);
    const binding = this.one("SELECT workspace_id FROM cowork_conversations WHERE session_id=?", sessionId);
    if (!binding) return;
    durableCoworkTransaction(this.rs, () => {
      this.run("UPDATE cowork_conversations SET state='deleted' WHERE session_id=?", sessionId);
      const changes = this.all("SELECT change_id FROM cowork_outbox_deliveries WHERE session_id=?", sessionId);
      this.run("DELETE FROM cowork_outbox_deliveries WHERE session_id=?", sessionId);
      for (const change of changes) this.run("DELETE FROM cowork_outbox WHERE change_id=? AND NOT EXISTS (SELECT 1 FROM cowork_outbox_deliveries WHERE change_id=?)", change.change_id, change.change_id);
      const detached = this.one("SELECT workspace_id FROM cowork_workspaces WHERE workspace_id=? AND ownership='standalone' AND owner_id=? AND state='retained' AND power='stopped'", binding.workspace_id, sessionId);
      if (detached) { this.run("UPDATE cowork_workspaces SET state='archived' WHERE workspace_id=?", detached.workspace_id); this.advance(detached.workspace_id); }
    });
  }
  /** Bounded delivery receipt retention; pending deliveries and other conversations' rows remain.
   * Unbound workspace journal entries are not pruned by this per-conversation operation. */
  pruneDeliveredChanges(sessionId: string, retain = 100): void {
    id(sessionId);
    durableCoworkTransaction(this.rs, () => {
      const stale = this.all("SELECT d.change_id FROM cowork_outbox_deliveries d JOIN cowork_outbox o USING(change_id) WHERE d.session_id=? AND d.state='delivered' ORDER BY o.sequence DESC LIMIT -1 OFFSET ?", sessionId, retain);
      for (const change of stale) {
        this.run("DELETE FROM cowork_outbox_deliveries WHERE session_id=? AND change_id=? AND state='delivered'", sessionId, change.change_id);
        this.run("DELETE FROM cowork_outbox WHERE change_id=? AND NOT EXISTS (SELECT 1 FROM cowork_outbox_deliveries WHERE change_id=?)", change.change_id, change.change_id);
      }
    });
  }
  /** Canonical bound logical conversations with outstanding work; no synthetic system session. */
  pendingChangeSessions(): string[] {
    return this.all("SELECT DISTINCT d.session_id FROM cowork_outbox_deliveries d JOIN cowork_conversations c USING(session_id) WHERE d.state='pending' AND c.state!='deleted' ORDER BY d.session_id").map(row => row.session_id);
  }
  conversationWorkspace(sessionId: string): string | undefined {
    return this.one("SELECT workspace_id FROM cowork_conversations WHERE session_id=?", id(sessionId))?.workspace_id;
  }
  pendingChanges(sessionId: string, limit = Number.MAX_SAFE_INTEGER): WorkspaceChange[] {
    return this.all("SELECT o.* FROM cowork_outbox o JOIN cowork_outbox_deliveries d USING(change_id) WHERE d.session_id=? AND d.state='pending' ORDER BY o.sequence LIMIT ?", id(sessionId), Math.max(1, Math.min(Number.MAX_SAFE_INTEGER, Math.floor(limit)))).map(row => ({ changeId: row.change_id, workspaceId: row.workspace_id, operationId: row.operation_id, revision: row.revision, kind: row.kind, payload: JSON.parse(row.payload_json) }));
  }
  acknowledgeChange(sessionId: string, changeId: string, eventSeq: number): void {
    if (!Number.isSafeInteger(eventSeq) || eventSeq < 1) throw new CoworkError("invalid_request");
    durableCoworkTransaction(this.rs, () => {
      const changed = this.run("UPDATE cowork_outbox_deliveries SET state='delivered',event_seq=? WHERE session_id=? AND change_id=? AND state='pending'", eventSeq, id(sessionId), id(changeId));
      if (!changed.changes && !this.one("SELECT 1 FROM cowork_outbox_deliveries WHERE session_id=? AND change_id=? AND state='delivered' AND event_seq=?", sessionId, changeId, eventSeq)) throw new CoworkError("request_conflict");
    });
  }
}
