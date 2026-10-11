import type { CoworkAuthority } from "../authority";
import type { CoworkRepository } from "../repository";
import type { CapabilityCeiling, WorkspaceSource } from "../types";
import { GitPublicationError, type PublicationAuthority, type PublicationGrant, type PublicationRequest, type Publisher } from "./types";

export interface TaskPublicationResolver {
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
    const capabilities = this.authority.effectiveCapabilities(publisher.sessionId), capabilityDigest = JSON.stringify(capabilities);
    const task = await this.tasks.resolve(publisher, request, source, capabilities);
    // Narrowing may occur while the host task/account resolver awaits.
    const current = this.check(publisher, request);
    if (this.records.binding(publisher.sessionId).revision !== bindingRevision || JSON.stringify(this.authority.effectiveCapabilities(publisher.sessionId)) !== capabilityDigest) throw new GitPublicationError("authority_denied");
    if (current.kind !== "githubRepository" || source.kind !== "githubRepository" || current.detail.repositoryId !== source.detail.repositoryId
      || current.detail.authorityRef !== source.detail.authorityRef || task.repositoryId !== current.detail.repositoryId || task.authorityId !== current.detail.authorityRef) throw new GitPublicationError("authority_denied");
    return { ...task, sourceRevision: current.revision, publicationRevision: this.records.policy(request.workspaceId).publicationRevision };
  }
  private check(publisher: Publisher, request: Readonly<PublicationRequest>): WorkspaceSource {
    const binding = this.records.binding(publisher.sessionId);
    if (binding.workspaceId !== request.workspaceId || binding.state !== "active" || binding.policy === "plan") throw new GitPublicationError("authority_denied");
    const source = this.authority.requireAutomaticPublication(request.workspaceId, request.sourceId);
    if (source.revision !== request.sourceRevision || this.records.policy(request.workspaceId).publicationRevision !== request.publicationRevision) throw new GitPublicationError("revision_conflict");
    return source;
  }
}
