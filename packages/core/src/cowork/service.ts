import { COWORK_RPC, CoworkSource as SourceDto, CoworkWorkspace as WorkspaceDto, CoworkWorkspaceRecord as WorkspaceRecordDto, type CoworkMethod, type CoworkResult } from "@yanlinglabs/winter-protocol";
import { CoworkAuthority, intersectCeilings, type CoworkGrantResolver, type CoworkPrincipal } from "./authority";
import { CoworkRepository } from "./repository";
import { CoworkError, type CapabilityCeiling, type MutationContext, type SourceSelection, type WorkspaceSource, type Workspace } from "./types";

export interface CoworkConnection { role: string; connectionId: number }
/** Host-only injection. Never construct from method parameters or clientName. A gateway token
 * alone does not identify a paired peer or its workspace scope. Resolve current grants each call. */
export interface CoworkHostPorts {
  principal(connection: CoworkConnection): CoworkPrincipal | undefined;
  grants: CoworkGrantResolver;
  selection(principal: CoworkPrincipal, selectionId: string): SourceSelection | undefined;
  creationCeiling(principal: CoworkPrincipal): CapabilityCeiling | undefined;
  /** Must fail closed until native, crypto and active resource-return gates pass. Fixture backend
   * permits isolated tests; this port does not launch a worker or mark any source ready. */
  requireProvisioning(principal: CoworkPrincipal): void;
}
const NO_GRANTS: CoworkGrantResolver = { folder: () => undefined, repository: () => undefined };
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
/** One per-record gate, also used by list filtering. Unknown ownership never becomes a grant. */
export function assertRemoteMayUseWorkspace(records: CoworkRepository, authority: CoworkAuthority, principal: CoworkPrincipal, workspaceId: string, operation: "read" | "narrow" | "admin" = "read") {
  const value = records.get(workspaceId);
  if (!["standalone", "project"].includes(value.ownership)) throw new CoworkError("authority_denied");
  authority.requireWorkspace(principal, workspaceId, operation);
  return value;
}
export class CoworkWorkspaceService {
  private readonly authority: CoworkAuthority;
  constructor(readonly records: CoworkRepository, private readonly host: CoworkHostPorts = disabledCoworkHost) { this.authority = new CoworkAuthority(records, host.grants); }
  private snapshot(principal: CoworkPrincipal, workspaceId: string) {
    const value = assertRemoteMayUseWorkspace(this.records, this.authority, principal, workspaceId);
    // Explicit projection: never rely on a schema stripping a future sensitive field.
    const safe = projectWorkspace(value);
    return WorkspaceDto.parse({ ...safe, sources: this.records.sources(workspaceId).filter(source => source.state !== "detached").map(projectSource), policy: this.records.policy(workspaceId), automaticPublication: this.records.policy(workspaceId).publication === "github-only-feature-branches" && this.records.githubOnly(workspaceId) });
  }
  private select(principal: CoworkPrincipal, selectionId: string, kind: SourceSelection["kind"]): SourceSelection {
    const selected = this.host.selection(principal, selectionId);
    if (!selected || selected.kind !== kind) throw new CoworkError("authority_denied");
    this.authority.requireSelection(principal, selected);
    return selected;
  }
  private context(principal: CoworkPrincipal, method: CoworkMethod, request: { requestId: string; expectedRevision?: number }): MutationContext {
    return { principalId: principal.id, method, requestId: request.requestId, expectedRevision: request.expectedRevision,
      validateReceipt: receipt => {
        // Check the fully projected response before COMMIT, so an oversized answer cannot leave
        // a successful mutation whose caller received only an error. No external effect here.
        const value = method === "workspace.create" || method === "project.create" ? this.snapshot(principal, receipt.workspaceId)
          : method.startsWith("workspace.source.") ? SourceDto.parse(receipt.value)
          : method === "workspace.update" || method === "project.update" ? WorkspaceRecordDto.parse(receipt.value) : receipt.value;
        this.checkedResponse(method, { ...receipt, value });
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
    const values: ReturnType<CoworkWorkspaceService["snapshot"]>[] = [];
    const response = (nextCursor: string | null) => projects ? { projects: values.map(workspace => ({ projectId: workspace.ownerId, workspace })), nextCursor } : { workspaces: values, nextCursor };
    for (const value of permitted.slice(index + 1, index + 1 + request.limit)) {
      values.push(this.snapshot(principal, value.workspaceId));
      if (Buffer.byteLength(JSON.stringify(response(value.workspaceId)), "utf8") > 128 * 1024) {
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
    const result = this.execute(principal, method, raw);
    this.checkedResponse(method, result);
    return result as CoworkResult<M>;
  }
  private checkedResponse(method: CoworkMethod, result: unknown): void {
    COWORK_RPC[method].result.parse(result);
    // Conservative inner budget leaves room for paired JSON escaping/base64 and outer envelope.
    if (Buffer.byteLength(JSON.stringify(result), "utf8") > 128 * 1024) throw new CoworkError("response_too_large");
  }
  private execute(principal: CoworkPrincipal, method: CoworkMethod, raw: unknown): unknown {
    switch (method) {
      case "workspace.list": return this.page(principal, COWORK_RPC[method].params.parse(raw), false);
      case "project.list": return this.page(principal, COWORK_RPC[method].params.parse(raw), true);
      case "workspace.get": return this.snapshot(principal, COWORK_RPC[method].params.parse(raw).workspaceId);
      case "project.get": {
        const p = COWORK_RPC[method].params.parse(raw), workspace = this.records.project(p.projectId);
        return { projectId: p.projectId, workspace: this.snapshot(principal, workspace.workspaceId) };
      }
      case "workspace.create": case "project.create": {
        const p = method === "workspace.create" ? COWORK_RPC[method].params.parse(raw) : { ...COWORK_RPC[method].params.parse(raw), ownership: "project" as const };
        this.host.requireProvisioning(principal);
        // Persisted peer ownership/creation admission is a later gate. Never create an inaccessible
        // workspace and retroactively mutate a connection's grant set after the DB commit.
        if (principal.kind !== "local-user") throw new CoworkError("unsupported_topology");
        const ceiling = this.host.creationCeiling(principal);
        if (!ceiling) throw new CoworkError("authority_denied");
        const sources = p.selections.map(value => this.select(principal, value.selectionId, value.kind));
        const receipt = this.records.create(this.context(principal, method, p), { ownership: p.ownership, title: p.title, sources, ceiling });
        return { ...receipt, value: WorkspaceDto.parse({ ...projectWorkspace(receipt.value.workspace), sources: receipt.value.sources.map(projectSource), policy: receipt.value.policy, automaticPublication: receipt.value.automaticPublication }) };
      }
      case "workspace.update": case "project.update": {
        const p = COWORK_RPC[method].params.parse(raw);
        const workspaceId = "workspaceId" in p ? p.workspaceId : this.records.project(p.projectId).workspaceId;
        assertRemoteMayUseWorkspace(this.records, this.authority, principal, workspaceId, "narrow");
        const receipt = this.records.updateTitle(this.context(principal, method, p), workspaceId, p.title);
        return { ...receipt, value: projectWorkspace(receipt.value) };
      }
      case "workspace.source.list": case "workspace.source.get": {
        const p = COWORK_RPC[method].params.parse(raw);
        assertRemoteMayUseWorkspace(this.records, this.authority, principal, p.workspaceId);
        return "sourceId" in p && typeof p.sourceId === "string" ? projectSource(this.records.source(p.workspaceId, p.sourceId)) : { sources: this.records.sources(p.workspaceId).filter(value => value.state !== "detached").map(projectSource) };
      }
      case "workspace.source.addFolder": case "workspace.source.addRepository": {
        const p = COWORK_RPC[method].params.parse(raw);
        // Paired additions require both current workspace membership and admitted repository authority.
        assertRemoteMayUseWorkspace(this.records, this.authority, principal, p.workspaceId, method === "workspace.source.addFolder" ? "admin" : "narrow");
        this.host.requireProvisioning(principal);
        const selected = this.select(principal, p.selectionId, method === "workspace.source.addFolder" ? "folder" : "githubRepository");
        const receipt = this.records.addSource(this.context(principal, method, p), p.workspaceId, selected);
        return { ...receipt, value: projectSource(receipt.value) };
      }
      case "workspace.source.remove": case "workspace.source.revoke": {
        const p = COWORK_RPC[method].params.parse(raw);
        assertRemoteMayUseWorkspace(this.records, this.authority, principal, p.workspaceId, "narrow");
        const receipt = this.records.removeSource(this.context(principal, method, p), p.workspaceId, p.sourceId, method === "workspace.source.revoke");
        return { ...receipt, value: projectSource(receipt.value) };
      }
      case "workspace.setDefaultPolicy": case "project.setDefaultPolicy": case "workspace.setCapabilityCeiling": case "workspace.setPublicationPolicy": {
        const p = COWORK_RPC[method].params.parse(raw);
        const workspaceId = "workspaceId" in p ? p.workspaceId : this.records.project(p.projectId).workspaceId;
        assertRemoteMayUseWorkspace(this.records, this.authority, principal, workspaceId, "admin");
        if ("ceiling" in p) {
          const allowed = this.host.creationCeiling(principal);
          if (!allowed || JSON.stringify(intersectCeilings(p.ceiling, allowed)) !== JSON.stringify(intersectCeilings(p.ceiling, p.ceiling))) throw new CoworkError("authority_denied");
        }
        const change = "defaultPolicy" in p ? { defaultPolicy: p.defaultPolicy } : "ceiling" in p ? { ceiling: p.ceiling } : { publication: p.publication };
        return this.records.updatePolicy(this.context(principal, method, p), workspaceId, change);
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
