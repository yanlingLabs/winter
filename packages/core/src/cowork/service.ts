import { createHash } from "node:crypto";
import { COWORK_RPC, CoworkSource as SourceDto, CoworkCompleteWorkspace as WorkspaceDto, CoworkSummaryWorkspace as SummaryDto, CoworkWorkspacePolicy as PolicyDto, CoworkPolicySummary as PolicySummaryDto, CoworkWorkspaceRecord as WorkspaceRecordDto, type CoworkMethod, type CoworkResult } from "@yanlinglabs/winter-protocol";
import { CoworkAuthority, intersectCeilings, type CoworkGrantResolver, type CoworkPrincipal } from "./authority";
import { CoworkInstructions, type InstructionAgentApproval } from "./instructions";
import { CoworkSchedules } from "./schedules";
import { CoworkRepository } from "./repository";
import { CoworkError, type CapabilityCeiling, type MutationContext, type MutationReceipt, type SourceSelection, type WorkspaceSource, type WorkspacePolicy, type Workspace } from "./types";

import type { CoworkFolderSelections } from "./folder-selections";

export interface CoworkConnection { role: string; connectionId: number }
/** Host-only injection. Never construct from method parameters or clientName. A gateway token
 * alone does not identify a paired peer or its workspace scope. Resolve current grants each call. */
export interface CoworkHostPorts {
  principal(connection: CoworkConnection): CoworkPrincipal | undefined;
  grants: CoworkGrantResolver;
  selections?: CoworkFolderSelections;
  selection(principal: CoworkPrincipal, selectionId: string, connection: CoworkConnection): SourceSelection | undefined;
  creationCeiling(principal: CoworkPrincipal): CapabilityCeiling | undefined;
  /** Must fail closed until native isolation, storage and active resource-return gates pass. Fixture backend
   * permits isolated tests; this port does not launch a worker or mark any source ready. */
  requireProvisioning(principal: CoworkPrincipal): void;
}
const NO_GRANTS: CoworkGrantResolver = { folder: () => undefined, repository: () => undefined };
const RESPONSE_BUDGET = 128 * 1024;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export const disabledCoworkHost: CoworkHostPorts = {
  principal: connection => connection.role === "harness" || connection.role === "admin" ? { kind: "local-user", id: `local-${connection.role}` } : undefined,
  grants: NO_GRANTS, selection: () => undefined, creationCeiling: () => undefined,
  requireProvisioning: () => { throw new CoworkError("unsupported_topology"); },
};
function projectSource(value: WorkspaceSource) {
  const { sourceId, workspaceId, locationId, kind, label, access, desired, state, revision, ackRevision, reason, restartRequired, trust, createdAt, updatedAt } = value;
  return SourceDto.parse({ sourceId, workspaceId, locationId, kind, label, access, desired, state, revision, ackRevision, reason, restartRequired, trust, createdAt, updatedAt });
}
function projectWorkspace(value: Workspace) {
  const { workspaceId, ownership, ownerId, title, state, configRevision, grantRevision, instructionRevision, leaseEpoch, power, createdAt, updatedAt } = value;
  return WorkspaceRecordDto.parse({ workspaceId, ownership, ownerId, title, state, configRevision, grantRevision, instructionRevision, leaseEpoch, power, createdAt, updatedAt });
}
function projectPolicySummary(value: WorkspacePolicy) {
  const { ceiling, ...policy } = value;
  return PolicySummaryDto.parse({ ...policy, network: ceiling.network, capabilityCounts: { toolClasses: ceiling.toolClasses.length, hostServices: ceiling.hostServices.length, connectors: ceiling.connectors.length } });
}
function projectPolicyReceipt(receipt: MutationReceipt<WorkspacePolicy>) {
  const complete = { ...receipt, value: { ...PolicyDto.parse(receipt.value), detailState: "complete" as const } };
  if (Buffer.byteLength(JSON.stringify(complete), "utf8") <= RESPONSE_BUDGET) return complete;
  // Project the recorded policy, not the current DB state, so retries retain their original
  // revision and summary even after later mutations. The real policy remains canonical.
  return { ...receipt, value: { detailState: "summary" as const, detailReason: "response_limit" as const, policySummary: projectPolicySummary(receipt.value), detailMethod: "workspace.policy.get" as const } };
}
/** One per-record gate, also used by list filtering. Unknown ownership never becomes a grant. */
export function assertRemoteMayUseWorkspace(records: CoworkRepository, authority: CoworkAuthority, principal: CoworkPrincipal, workspaceId: string, operation: "read" | "member" | "admin" = "read") {
  const value = records.get(workspaceId);
  if (!["standalone", "project"].includes(value.ownership)) throw new CoworkError("authority_denied");
  authority.requireWorkspace(principal, workspaceId, operation);
  return value;
}
export class CoworkWorkspaceService {
  private readonly authority: CoworkAuthority;
  readonly schedules: CoworkSchedules;
  readonly instructions?: CoworkInstructions;
  constructor(readonly records: CoworkRepository, private readonly host: CoworkHostPorts = disabledCoworkHost, scheduleNow?: () => number, instructionHome?: string, instructionApproval?: InstructionAgentApproval) {
    this.authority = new CoworkAuthority(records, host.grants);
    this.schedules = new CoworkSchedules(records, host.grants, scheduleNow);
    if (instructionHome) this.instructions = new CoworkInstructions(records, instructionHome, host.grants, instructionApproval);
  }
  beginShutdown(): void { this.schedules.beginShutdown(); }
  private snapshot(principal: CoworkPrincipal, workspaceId: string) {
    const value = assertRemoteMayUseWorkspace(this.records, this.authority, principal, workspaceId);
    // Explicit projection: never rely on a schema stripping a future sensitive field.
    const safe = projectWorkspace(value);
    return WorkspaceDto.parse({ ...safe, detailState: "complete", sources: this.records.sources(workspaceId).filter(source => source.state !== "detached").map(projectSource), policy: this.records.policy(workspaceId), automaticPublication: this.records.policy(workspaceId).publication === "github-only-feature-branches" && this.records.githubOnly(workspaceId) });
  }
  private policySummary(workspaceId: string) {
    return projectPolicySummary(this.records.policy(workspaceId));
  }
  private detailPage(request: { cursor?: string; expectedRevision?: number }, workspaceId: string, kind: "sources" | "policy", revision: number, content: unknown[]) {
    if (request.expectedRevision !== undefined && request.expectedRevision !== revision) throw new CoworkError("revision_conflict", revision);
    // Content includes visible lifecycle state. In particular a detach ACK changes this
    // generation without advancing desired configRevision, so positional pages cannot skip.
    const scope = hash(workspaceId), generation = hash(JSON.stringify(content)), prefix = `${kind}:${scope}:${revision}:${generation}:`;
    let offset = 0;
    if (request.cursor) {
      const match = /^(sources|policy):([a-f0-9]{64}):([1-9][0-9]*):([a-f0-9]{64}):([1-9][0-9]*)$/.exec(request.cursor);
      if (!match || match[1] !== kind || match[2] !== scope) throw new CoworkError("invalid_request");
      if (Number(match[3]) !== revision) throw new CoworkError("revision_conflict", revision);
      if (match[4] !== generation) throw new CoworkError("stale_cursor", revision);
      offset = Number(match[5]);
      if (!Number.isSafeInteger(offset) || offset >= content.length) throw new CoworkError("invalid_request");
    }
    return { offset, cursor: (end: number) => end < content.length ? `${prefix}${end}` : null };
  }
  private readSnapshot(principal: CoworkPrincipal, workspaceId: string) {
    const complete = this.snapshot(principal, workspaceId);
    // Use the largest read wrapper even for get, so a legacy record remains discoverable in
    // either list. Explicit summaries never pretend that omitted capabilities are empty.
    const wrapped = { projects: [{ projectId: complete.ownerId, workspace: complete }], nextCursor: workspaceId };
    if (Buffer.byteLength(JSON.stringify(wrapped), "utf8") <= RESPONSE_BUDGET) return complete;
    return SummaryDto.parse({ ...projectWorkspace(this.records.get(workspaceId)), detailState: "summary", detailReason: "response_limit", policySummary: this.policySummary(workspaceId), sourceCount: complete.sources.length, automaticPublication: complete.automaticPublication, detailMethods: { sources: "workspace.source.list", policy: "workspace.policy.get" } });
  }
  /** Admission includes later lifecycle/revision growth and the largest single-entry read
   * wrapper. A small mutation receipt must not commit an unreadable aggregate. */
  private requireReadable(principal: CoworkPrincipal, workspaceId: string) {
    const value = this.snapshot(principal, workspaceId), revision = Number.MAX_SAFE_INTEGER;
    const reserved = { ...value, configRevision: revision, grantRevision: revision, instructionRevision: revision, leaseEpoch: revision, power: "uncertain", automaticPublication: false,
      policy: { ...value.policy, revision, defaultRevision: revision, publicationRevision: revision, defaultPolicy: "accept-edits", publication: "github-only-feature-branches" },
      sources: value.sources.map(source => ({ ...source, state: "unavailable", revision, ackRevision: revision, reason: "access_revoked", restartRequired: false, trust: "untrusted" })),
    };
    this.checkedResponse("workspace.list", { workspaces: [reserved], nextCursor: value.workspaceId });
    this.checkedResponse("project.list", { projects: [{ projectId: value.ownerId, workspace: reserved }], nextCursor: value.workspaceId });
  }
  private select(principal: CoworkPrincipal, selectionId: string, kind: SourceSelection["kind"], connection: CoworkConnection): SourceSelection {
    const selected = this.host.selection(principal, selectionId, connection);
    if (!selected || selected.kind !== kind) throw new CoworkError("authority_denied");
    this.authority.requireSelection(principal, selected);
    return selected;
  }
  private requireReplaySources(principal: CoworkPrincipal, workspaceId: string, sources: readonly WorkspaceSource[]): void {
    assertRemoteMayUseWorkspace(this.records, this.authority, principal, workspaceId);
    for (const recorded of sources) {
      const current = this.records.source(workspaceId, recorded.sourceId);
      if (current.desired !== "present" || current.trust === "revoked" || ["removing", "detached"].includes(current.state)) throw new CoworkError("authority_denied");
      this.authority.requireSelection(principal, current);
    }
  }
  private consumption(principal: CoworkPrincipal, connection: CoworkConnection, ids: readonly { selectionId: string; kind: string }[]) {
    // Ephemeral cleanup is after COMMIT: nested caller transactions cannot own this boundary.
    if (this.records.rs.db.inTransaction) throw new CoworkError("authority_denied");
    const pending = ids.map(value => value.kind === "folder" && this.host.selections
      ? this.host.selections.prepareConsumption(principal, connection.connectionId, value.selectionId) : undefined);
    return {
      bind: (sources: readonly WorkspaceSource[]) => { if (sources.length !== pending.length) throw new CoworkError("authority_denied"); sources.forEach((source, index) => pending[index]?.bind(source)); },
      committed: () => pending.forEach(value => value?.committed()),
    };
  }
  private context(principal: CoworkPrincipal, method: CoworkMethod, request: { requestId: string; expectedRevision?: number }, allowOversizedRecovery = false, admitMutation?: MutationContext["admitMutation"]): MutationContext {
    return { principalId: principal.id, method, requestId: request.requestId, expectedRevision: request.expectedRevision, admitMutation,
      validateReceipt: receipt => {
        // Check the fully projected response before COMMIT, so an oversized answer cannot leave
        // a successful mutation whose caller received only an error. No external effect here.
        const value = method === "workspace.create" || method === "project.create" ? this.snapshot(principal, receipt.workspaceId)
          : method.startsWith("workspace.source.") ? SourceDto.parse(receipt.value)
          : method === "workspace.update" || method === "project.update" ? WorkspaceRecordDto.parse(receipt.value) : receipt.value;
        const response = method === "workspace.setDefaultPolicy" || method === "project.setDefaultPolicy" || method === "workspace.setCapabilityCeiling" || method === "workspace.setPublicationPolicy"
          ? projectPolicyReceipt(receipt as MutationReceipt<WorkspacePolicy>) : { ...receipt, value };
        this.checkedResponse(method, response);
        // Security revocation and other explicit narrowing remain possible for older oversized
        // records. New expansion always requires complete read/list admission before COMMIT.
        if (!allowOversizedRecovery) this.requireReadable(principal, receipt.workspaceId);
      },
    };
  }
  private page(principal: CoworkPrincipal, request: { cursor?: string; limit: number }, projects: boolean) {
    const permitted = this.records.list().filter(value => {
      if (projects && value.ownership !== "project") return false;
      try { assertRemoteMayUseWorkspace(this.records, this.authority, principal, value.workspaceId); return true; }
      catch (error) { if (error instanceof CoworkError && ["authority_denied", "not_found"].includes(error.code)) return false; throw error; }
    });
    const index = request.cursor ? permitted.findIndex(value => value.workspaceId === request.cursor) : -1;
    if (request.cursor && index < 0) throw new CoworkError("invalid_request");
    const values: ReturnType<CoworkWorkspaceService["readSnapshot"]>[] = [];
    const response = (nextCursor: string | null) => projects ? { projects: values.map(workspace => ({ projectId: workspace.ownerId, workspace })), nextCursor } : { workspaces: values, nextCursor };
    for (const value of permitted.slice(index + 1, index + 1 + request.limit)) {
      values.push(this.readSnapshot(principal, value.workspaceId));
      if (Buffer.byteLength(JSON.stringify(response(value.workspaceId)), "utf8") > RESPONSE_BUDGET) {
        values.pop();
        if (!values.length) throw new CoworkError("response_too_large");
        break;
      }
    }
    const nextCursor = permitted.length > index + 1 + values.length ? values.at(-1)!.workspaceId : null;
    return response(nextCursor);
  }
  call<M extends CoworkMethod>(connection: CoworkConnection, method: M, raw: unknown): CoworkResult<M> {
    const principal = this.host.principal(connection);
    if (!principal || principal.kind === "runtime" || !["harness", "admin", "remote"].includes(connection.role) || (connection.role === "remote" ? principal.kind !== "paired-user" : principal.kind !== "local-user")) throw new CoworkError("authority_denied");
    if (this.records.rs.db.inTransaction && ["workspace.create", "project.create", "workspace.source.addFolder", "workspace.source.addRepository"].includes(method)) throw new CoworkError("authority_denied");
    try {
      const result = this.execute(principal, method, raw, connection);
      this.checkedResponse(method, result);
      return result as CoworkResult<M>;
    } catch (error) {
      // Paired callers must not distinguish unknown identifiers from records
      // outside their current scope, including project/source/operation lookups.
      if (principal.kind === "paired-user" && error instanceof CoworkError && error.code === "not_found") throw new CoworkError("authority_denied");
      throw error;
    }
  }
  private checkedResponse(method: CoworkMethod, result: unknown): void {
    COWORK_RPC[method].result.parse(result);
    // Conservative inner budget leaves room for paired JSON escaping/base64 and outer envelope.
    if (Buffer.byteLength(JSON.stringify(result), "utf8") > RESPONSE_BUDGET) throw new CoworkError("response_too_large");
  }
  /** Revalidated at every remote read/replay/live delivery; pairing alone is not workspace scope. */
  requireSessionRead(connection: CoworkConnection, sessionId: string, eventWorkspaceId?: string): void {
    const workspaceId = this.records.conversationWorkspace(sessionId);
    if (!workspaceId && !eventWorkspaceId) return;
    if (!workspaceId || (eventWorkspaceId && workspaceId !== eventWorkspaceId)) throw new CoworkError("authority_denied");
    const principal = this.host.principal(connection);
    if (connection.role !== "remote" || principal?.kind !== "paired-user") throw new CoworkError("authority_denied");
    assertRemoteMayUseWorkspace(this.records, this.authority, principal, workspaceId);
  }
  closeConnection(connectionId: number): void { this.host.selections?.closeConnection(connectionId); }
  close(): void { this.beginShutdown(); this.host.selections?.close(); }
  private execute(principal: CoworkPrincipal, method: CoworkMethod, raw: unknown, connection: CoworkConnection): unknown {
    switch (method) {
      case "workspace.instructions.get": case "workspace.instructions.provenance": case "workspace.instructions.update": {
        // Initially Mac-local. Paired reads require explicit four-mirror admission;
        // guest edits have a distinct authenticated content-bound approval port.
        if (principal.kind !== "local-user" || connection.role === "remote") throw new CoworkError("authority_denied");
        if (!this.instructions) throw new CoworkError("unsupported_topology");
        if (method === "workspace.instructions.update") return this.instructions.update(principal, COWORK_RPC[method].params.parse(raw));
        const p = COWORK_RPC[method].params.parse(raw);
        return method === "workspace.instructions.get" ? this.instructions.get(principal, p.workspaceId) : this.instructions.provenance(principal, p.workspaceId);
      }
      case "workspace.schedule.create": case "workspace.schedule.cancel": case "workspace.schedule.list": case "workspace.schedule.status": {
        // Local metadata surface only until paired ownership and saved remote scope are admitted.
        if (principal.kind !== "local-user" || connection.role === "remote") throw new CoworkError("authority_denied");
        if (method === "workspace.schedule.create") {
          const p = COWORK_RPC[method].params.parse(raw);
          assertRemoteMayUseWorkspace(this.records, this.authority, principal, p.workspaceId, "member");
          return this.schedules.create(principal.id, p.workspaceId, p.requestId, p.definition);
        }
        if (method === "workspace.schedule.cancel") {
          const p = COWORK_RPC[method].params.parse(raw);
          assertRemoteMayUseWorkspace(this.records, this.authority, principal, p.workspaceId, "member");
          return this.schedules.cancel(p.workspaceId, p.scheduleId, p.expectedRevision);
        }
        if (method === "workspace.schedule.list") {
          const p = COWORK_RPC[method].params.parse(raw);
          assertRemoteMayUseWorkspace(this.records, this.authority, principal, p.workspaceId);
          return this.schedules.list(p.workspaceId, p.cursor, p.limit);
        }
        const p = COWORK_RPC[method].params.parse(raw);
        assertRemoteMayUseWorkspace(this.records, this.authority, principal, p.workspaceId);
        return this.schedules.status(p.workspaceId, p.scheduleId);
      }
      case "workspace.capabilities.get": {
        COWORK_RPC[method].params.parse(raw);
        if (principal.kind !== "local-user" || connection.role === "remote") throw new CoworkError("authority_denied");
        return { folderPreparation: !!this.host.selections, repositoryPreparation: false, provisioning: false, execution: false };
      }
      case "workspace.selection.prepareFolder": {
        const p = COWORK_RPC[method].params.parse(raw);
        if (principal.kind !== "local-user" || connection.role === "remote") throw new CoworkError("authority_denied");
        if (!this.host.selections) throw new CoworkError("unsupported_topology");
        return this.host.selections.prepare(principal, connection.connectionId, p.bookmarkBase64, p.label, p.access, p.requestId);
      }
      case "workspace.selection.revoke": {
        const p = COWORK_RPC[method].params.parse(raw);
        if (principal.kind !== "local-user" || connection.role === "remote") throw new CoworkError("authority_denied");
        if (!this.host.selections) throw new CoworkError("unsupported_topology");
        this.host.selections.revoke(principal, connection.connectionId, p.selectionId); return { revoked: true };
      }
      case "workspace.list": return this.page(principal, COWORK_RPC[method].params.parse(raw), false);
      case "project.list": return this.page(principal, COWORK_RPC[method].params.parse(raw), true);
      case "workspace.get": return this.readSnapshot(principal, COWORK_RPC[method].params.parse(raw).workspaceId);
      case "project.get": {
        const p = COWORK_RPC[method].params.parse(raw), workspace = this.records.project(p.projectId);
        return { projectId: p.projectId, workspace: this.readSnapshot(principal, workspace.workspaceId) };
      }
      case "workspace.create": case "project.create": {
        const p = method === "workspace.create" ? COWORK_RPC[method].params.parse(raw) : { ...COWORK_RPC[method].params.parse(raw), ownership: "project" as const };
        const context = this.context(principal, method, p); context.requestDigestInput = p;
        const previous = this.records.replayCreation(context, () => {
          const ceiling = this.host.creationCeiling(principal);
          if (!ceiling) throw new CoworkError("authority_denied");
          return { ownership: p.ownership, title: p.title, sources: p.selections.map(value => this.select(principal, value.selectionId, value.kind, connection)), ceiling };
        });
        if (previous) {
          this.requireReplaySources(principal, previous.workspaceId, previous.value.sources);
          return { ...previous, value: WorkspaceDto.parse({ ...projectWorkspace(previous.value.workspace), detailState: "complete", sources: previous.value.sources.map(projectSource), policy: previous.value.policy, automaticPublication: previous.value.automaticPublication }) };
        }
        this.host.requireProvisioning(principal);
        // Persisted peer ownership/creation admission is a later gate. Never create an inaccessible
        // workspace and retroactively mutate a connection's grant set after the DB commit.
        if (principal.kind !== "local-user") throw new CoworkError("unsupported_topology");
        const ceiling = this.host.creationCeiling(principal);
        if (!ceiling) throw new CoworkError("authority_denied");
        const sources = p.selections.map(value => this.select(principal, value.selectionId, value.kind, connection));
        const consumption = this.consumption(principal, connection, p.selections); context.bindSources = consumption.bind;
        const receipt = this.records.create(context, { ownership: p.ownership, title: p.title, sources, ceiling });
        consumption.committed();
        return { ...receipt, value: WorkspaceDto.parse({ ...projectWorkspace(receipt.value.workspace), detailState: "complete", sources: receipt.value.sources.map(projectSource), policy: receipt.value.policy, automaticPublication: receipt.value.automaticPublication }) };
      }
      case "workspace.update": case "project.update": {
        const p = COWORK_RPC[method].params.parse(raw);
        const workspaceId = "workspaceId" in p ? p.workspaceId : this.records.project(p.projectId).workspaceId;
        assertRemoteMayUseWorkspace(this.records, this.authority, principal, workspaceId, "member");
        const receipt = this.records.updateTitle(this.context(principal, method, p), workspaceId, p.title);
        return { ...receipt, value: projectWorkspace(receipt.value) };
      }
      case "workspace.source.get": {
        const p = COWORK_RPC[method].params.parse(raw);
        assertRemoteMayUseWorkspace(this.records, this.authority, principal, p.workspaceId);
        return projectSource(this.records.source(p.workspaceId, p.sourceId));
      }
      case "workspace.source.list": {
        const p = COWORK_RPC[method].params.parse(raw);
        const workspace = assertRemoteMayUseWorkspace(this.records, this.authority, principal, p.workspaceId);
        const all = this.records.sources(p.workspaceId).filter(value => value.state !== "detached").map(projectSource);
        const { offset, cursor } = this.detailPage(p, p.workspaceId, "sources", workspace.configRevision, all), sources = all.slice(offset, offset + p.limit);
        const response = () => ({ sources, nextCursor: cursor(offset + sources.length) });
        while (Buffer.byteLength(JSON.stringify(response()), "utf8") > RESPONSE_BUDGET) {
          sources.pop(); if (!sources.length) throw new CoworkError("response_too_large");
        }
        return response();
      }
      case "workspace.policy.get": {
        const p = COWORK_RPC[method].params.parse(raw);
        assertRemoteMayUseWorkspace(this.records, this.authority, principal, p.workspaceId);
        const policy = this.records.policy(p.workspaceId);
        const entries = (["toolClasses", "hostServices", "connectors"] as const).flatMap(kind => policy.ceiling[kind].map(name => ({ kind, name })));
        const { offset, cursor } = this.detailPage(p, p.workspaceId, "policy", policy.revision, entries);
        const page = entries.slice(offset, offset + p.limit), end = offset + page.length;
        return { policy: this.policySummary(p.workspaceId), entries: page, nextCursor: cursor(end) };
      }
      case "workspace.source.addFolder": case "workspace.source.addRepository": {
        const p = COWORK_RPC[method].params.parse(raw);
        // Paired additions require both current workspace membership and admitted repository authority.
        assertRemoteMayUseWorkspace(this.records, this.authority, principal, p.workspaceId, method === "workspace.source.addFolder" ? "admin" : "member");
        const context = this.context(principal, method, p); context.requestDigestInput = p;
        const previous = this.records.replaySourceAddition(context, p.workspaceId, () => this.select(principal, p.selectionId, method === "workspace.source.addFolder" ? "folder" : "githubRepository", connection));
        if (previous) { this.requireReplaySources(principal, p.workspaceId, [previous.value]); return { ...previous, value: projectSource(previous.value) }; }
        this.host.requireProvisioning(principal);
        const selected = this.select(principal, p.selectionId, method === "workspace.source.addFolder" ? "folder" : "githubRepository", connection);
        const consumption = this.consumption(principal, connection, [{ selectionId: p.selectionId, kind: selected.kind }]); context.bindSources = consumption.bind;
        const receipt = this.records.addSource(context, p.workspaceId, selected);
        consumption.committed();
        return { ...receipt, value: projectSource(receipt.value) };
      }
      case "workspace.source.remove": case "workspace.source.revoke": {
        const p = COWORK_RPC[method].params.parse(raw);
        assertRemoteMayUseWorkspace(this.records, this.authority, principal, p.workspaceId, "member");
        const receipt = this.records.removeSource(this.context(principal, method, p, true), p.workspaceId, p.sourceId, method === "workspace.source.revoke");
        return { ...receipt, value: projectSource(receipt.value) };
      }
      case "workspace.setDefaultPolicy": case "project.setDefaultPolicy": case "workspace.setCapabilityCeiling": case "workspace.setPublicationPolicy": {
        const p = COWORK_RPC[method].params.parse(raw);
        const workspaceId = "workspaceId" in p ? p.workspaceId : this.records.project(p.projectId).workspaceId;
        assertRemoteMayUseWorkspace(this.records, this.authority, principal, workspaceId, "admin");
        const current = this.records.policy(workspaceId).ceiling;
        const narrowsCeiling = "ceiling" in p && JSON.stringify(intersectCeilings(p.ceiling, current)) === JSON.stringify(intersectCeilings(p.ceiling, p.ceiling));
        const change = "defaultPolicy" in p ? { defaultPolicy: p.defaultPolicy } : "ceiling" in p ? { ceiling: p.ceiling } : { publication: p.publication };
        const narrowsPublication = "publication" in p && p.publication === "manual";
        const receipt = this.records.updatePolicy(this.context(principal, method, p, narrowsCeiling || narrowsPublication, () => {
          // Only a new effect needs expansion admission. An exact recorded request may now
          // look like widening after later narrowing, but replay never reapplies its policy.
          if ("ceiling" in p && !narrowsCeiling) {
            const allowed = this.host.creationCeiling(principal);
            if (!allowed || JSON.stringify(intersectCeilings(p.ceiling, allowed)) !== JSON.stringify(intersectCeilings(p.ceiling, p.ceiling))) throw new CoworkError("authority_denied");
          }
        }), workspaceId, change);
        return projectPolicyReceipt(receipt);
      }
      case "workspace.operation.get": {
        const p = COWORK_RPC[method].params.parse(raw);
        assertRemoteMayUseWorkspace(this.records, this.authority, principal, p.workspaceId);
        const value = this.records.operation(p.workspaceId, p.operationId);
        return { operationId: value.operationId, workspaceId: p.workspaceId, revision: value.receipt.revision, status: value.status, terminal: value.terminal };
      }
    }
    const unhandled: never = method;
    throw new CoworkError("unsupported_topology");
  }
}
