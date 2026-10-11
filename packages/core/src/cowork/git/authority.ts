import { createHash } from "node:crypto";
import type { CoworkAuthority } from "../authority";
import type { CoworkRepository } from "../repository";
import type { CapabilityCeiling, WorkspaceSource } from "../types";
import { GitPublicationError, type PublicationAuthority, type PublicationGrant, type PublicationRequest, type Publisher } from "./types";

export interface TaskPublicationResolver {
  /** Canonical host conversation/task restriction, not guest JSON. A missing scope denies.
   * null means explicitly designated whole-workspace access, irrespective of starting cwd. */
  sourceScope(publisher: Readonly<Publisher>): Promise<PublicationGrant["sourceScope"]>;
  /** Host-authenticated task restriction/delegation and exact-ref destination resolution, no credential material. */
  resolve(publisher: Readonly<Publisher>, request: Readonly<PublicationRequest>, source: WorkspaceSource,
    capabilities: CapabilityCeiling): Promise<Pick<PublicationGrant, "repositoryId" | "destinationId" | "authorityId" | "authorityRevision">>;
}
/** Canonical records adapter. Account connection alone is insufficient; a task resolver is mandatory. */
export class CurrentCoworkPublicationAuthority implements PublicationAuthority {
  constructor(private readonly records: CoworkRepository, private readonly authority: CoworkAuthority, private readonly tasks: TaskPublicationResolver) {}
  async authorize(publisher: Publisher, request: Readonly<PublicationRequest>): Promise<PublicationGrant> {
    const source = this.check(publisher, request);
    const bindingRevision = this.records.binding(publisher.sessionId).revision;
    const policyRevision = this.records.policy(request.workspaceId).revision;
    const capabilities = this.authority.effectiveCapabilities(publisher.sessionId), capabilityDigest = JSON.stringify(capabilities);
    const sourceScope = await this.scope(publisher, request.sourceId);
    const task = await this.tasks.resolve(publisher, request, source, capabilities);
    // Narrowing may occur while the host task/account resolver awaits.
    if (JSON.stringify(await this.scope(publisher, request.sourceId)) !== JSON.stringify(sourceScope)) throw new GitPublicationError("authority_denied");
    const current = this.check(publisher, request);
    if (this.records.binding(publisher.sessionId).revision !== bindingRevision || this.records.policy(request.workspaceId).revision !== policyRevision || JSON.stringify(this.authority.effectiveCapabilities(publisher.sessionId)) !== capabilityDigest) throw new GitPublicationError("authority_denied");
    if (current.kind !== "githubRepository" || source.kind !== "githubRepository" || current.detail.repositoryId !== source.detail.repositoryId
      || current.detail.authorityRef !== source.detail.authorityRef || task.repositoryId !== current.detail.repositoryId || task.authorityId !== current.detail.authorityRef) throw new GitPublicationError("authority_denied");
    return { ...task, sourceScope, capabilityState: { conversationRevision: bindingRevision, policyRevision, digest: createHash("sha256").update(capabilityDigest).digest("hex") },
      sourceRevision: current.revision, publicationRevision: this.records.policy(request.workspaceId).publicationRevision };
  }
  private async scope(publisher: Publisher, sourceId: string): Promise<PublicationGrant["sourceScope"]> {
    const scope = await this.tasks.sourceScope(publisher);
    if (!scope || !Number.isSafeInteger(scope.revision) || scope.revision < 1 ||
      (scope.sourceIds !== null && (!Array.isArray(scope.sourceIds) || scope.sourceIds.length > 100 || !scope.sourceIds.every(id => typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id)) || !scope.sourceIds.includes(sourceId)))) throw new GitPublicationError("authority_denied");
    return { revision: scope.revision, sourceIds: scope.sourceIds === null ? null : [...new Set(scope.sourceIds)].sort() };
  }
  private check(publisher: Publisher, request: Readonly<PublicationRequest>): WorkspaceSource {
    const binding = this.records.binding(publisher.sessionId);
    if (binding.workspaceId !== request.workspaceId || binding.state !== "active" || binding.policy === "plan") throw new GitPublicationError("authority_denied");
    const capabilities = this.authority.effectiveCapabilities(publisher.sessionId);
    if (!capabilities.hostServices.includes("git.publish") || !capabilities.toolClasses.includes("write")) throw new GitPublicationError("authority_denied");
    const source = this.authority.requireAutomaticPublication(request.workspaceId, request.sourceId);
    if (source.revision !== request.sourceRevision || this.records.policy(request.workspaceId).publicationRevision !== request.publicationRevision) throw new GitPublicationError("revision_conflict");
    return source;
  }
}
