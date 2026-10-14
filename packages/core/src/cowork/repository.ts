import { durableCoworkTransaction } from "./durable-transaction";
import { createHash, randomUUID } from "node:crypto";
import type { ApprovalPolicy } from "@yanlinglabs/winter-protocol";
import type { RuntimeStateDb } from "../runtime-state/db";
import { CoworkError, isTerminalOperationStatus, type OperationStatus, type CapabilityCeiling, type ConversationBinding, type GuestEpoch, type MutationContext, type MutationReceipt, type PublicationPolicy, type SourceSelection, type Workspace, type WorkspacePolicy, type WorkspaceSource } from "./types";

/** Host-owned index dependency. Never RPC/guest data; caller must commit the actual
 * session creation first and bind synchronously while that SessionStore remains open. */
export interface CoworkCommittedSessions { hasCommittedSession(sessionId: string): boolean }
export interface WorkspaceChange {
  changeId: string; workspaceId: string; operationId: string; revision: number; kind: string; payload: unknown;
}
type Row = Record<string, any>;
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
  constructor(readonly rs: RuntimeStateDb, private readonly now: () => string = () => new Date().toISOString(), private readonly mint: (prefix: string) => string = prefix => `${prefix}_${randomUUID()}`) {}
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
    return { sessionId, workspaceId: row.workspace_id, projectId: row.project_id, sourceId: row.source_id, relativeCwd: row.relative_cwd, policy: row.policy, restrictions: JSON.parse(row.restrictions_json), revision: row.revision, state: row.state, createdAt: row.created_at };
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
  private concludeOperation(workspaceId: string, operationId: string, status: "applied" | "superseded", supersededBy?: string): void {
    const changed = this.run("UPDATE cowork_operations SET status=?,updated_at=? WHERE workspace_id=? AND operation_id=? AND status='pending'", status, this.now(), workspaceId, operationId);
    if (changed.changes) this.publish(workspaceId, operationId, "workspace_operation_changed", { operationId, status, terminal: true, ...(supersededBy ? { supersededBy } : {}) });
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
      const workspaceId = this.mint("workspace"), ownerId = this.mint(input.ownership === "project" ? "project" : "session"), at = this.now();
      this.run("INSERT INTO cowork_workspaces VALUES(?,?,?,?,'retained',1,1,1,NULL,0,'stopped',?,?)", workspaceId, input.ownership, ownerId, normalized.title, at, at);
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
      if (current.ownership === "standalone" && current.ownerId !== normalized.sessionId) throw new CoworkError("authority_denied");
      if (selected.state !== "ready" || selected.desired !== "present") throw new CoworkError("source_unavailable");
      if (this.one("SELECT session_id FROM cowork_conversations WHERE session_id=?", normalized.sessionId)) throw new CoworkError("authority_denied");
      this.run("INSERT INTO cowork_conversations VALUES(?,?,?,?,?,?,?,1,'active',?)", normalized.sessionId, workspaceId, current.ownership === "project" ? current.ownerId : null, normalized.sourceId, normalized.relativeCwd, policy.defaultPolicy, canonical(policy.ceiling), this.now());
      this.advance(workspaceId);
      return { workspaceId, value: this.binding(normalized.sessionId), kind: "conversation_bound", payload: { sessionId: normalized.sessionId } };
    });
  }
  /** Controller/coordination service alone calls this after acquiring disk ownership. */
  beginIncarnation(workspaceId: string, incarnationId: string, expectedRevision: number): GuestEpoch {
    return durableCoworkTransaction(this.rs, () => {
      const current = this.get(workspaceId); id(incarnationId);
      if (current.configRevision !== expectedRevision) throw new CoworkError("revision_conflict", current.configRevision);
      if (current.state !== "retained" || current.power !== "stopped") throw new CoworkError("recovery_required");
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
    durableCoworkTransaction(this.rs, () => {
      const current = this.get(epoch.workspaceId), selected = this.source(epoch.workspaceId, sourceId);
      if (!["starting", "running"].includes(current.power) || current.incarnationId !== epoch.incarnationId || current.leaseEpoch !== epoch.leaseEpoch || current.configRevision !== epoch.configRevision || current.grantRevision !== epoch.grantRevision || selected.revision !== revision) throw new CoworkError("stale_acknowledgment");
      if (selected.state === state && selected.ackRevision === revision && selected.ackIncarnationId === epoch.incarnationId) return;
      if (state === "ready" ? selected.desired !== "present" || selected.state !== "preparing" : selected.desired !== "removed" || selected.state !== "removing") throw new CoworkError("stale_acknowledgment");
      const operationId = this.one("SELECT operation_id FROM cowork_sources WHERE source_id=?", sourceId)?.operation_id;
      if (!operationId) throw new CoworkError("recovery_required");
      this.run("UPDATE cowork_sources SET state=?,ack_revision=revision,ack_incarnation_id=?,restart_required=0,reason=NULL,updated_at=? WHERE source_id=?", state, epoch.incarnationId, this.now(), sourceId);
      this.publish(epoch.workspaceId, operationId, "workspace_sources_changed", { sourceId, sourceRevision: revision, state, incarnationId: epoch.incarnationId });
      if (!this.one("SELECT 1 FROM cowork_sources WHERE operation_id=? AND state NOT IN ('ready','detached') LIMIT 1", operationId)) this.concludeOperation(epoch.workspaceId, operationId, "applied");
    });
  }
  /** Membership predicate only; publication still requires current ready source/write authority. */
  githubOnly(workspaceId: string): boolean {
    const current = this.sources(workspaceId).filter(value => value.state !== "detached");
    return current.some(value => value.kind === "githubRepository" && value.desired === "present") && !current.some(value => value.kind === "folder");
  }
  /** Host logical-session deletion/missing-session retirement only. Keep workspace, sources,
   * operation receipts and guest data; tombstone prevents future notification fanout. */
  abandonConversation(sessionId: string): void {
    id(sessionId);
    if (!this.one("SELECT 1 FROM cowork_conversations WHERE session_id=?", sessionId)) return;
    durableCoworkTransaction(this.rs, () => {
      this.run("UPDATE cowork_conversations SET state='deleted' WHERE session_id=?", sessionId);
      const changes = this.all("SELECT change_id FROM cowork_outbox_deliveries WHERE session_id=?", sessionId);
      this.run("DELETE FROM cowork_outbox_deliveries WHERE session_id=?", sessionId);
      for (const change of changes) this.run("DELETE FROM cowork_outbox WHERE change_id=? AND NOT EXISTS (SELECT 1 FROM cowork_outbox_deliveries WHERE change_id=?)", change.change_id, change.change_id);
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
