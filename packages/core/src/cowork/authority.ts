import type { CoworkRepository } from "./repository";
import { CoworkError, type CapabilityCeiling, type SourceSelection, type WorkspaceSource } from "./types";

/** Created from the authenticated host connection/runtime, never deserialized from RPC params. */
export type CoworkPrincipal =
  | { kind: "local-user"; id: string }
  | { kind: "paired-user"; id: string; workspaceIds: ReadonlySet<string>; repositoryAuthorities: ReadonlySet<string> }
  | { kind: "runtime"; id: string; sessionId: string; workspaceId: string };
export interface CoworkGrantResolver {
  folder(grantRef: string): { rootIdentity: string; writable: boolean; revoked: boolean } | undefined;
  repository(authorityRef: string, repositoryId: string): { readable: boolean; writable: boolean; revoked: boolean } | undefined;
}
export function intersectCeilings(a: CapabilityCeiling, b: CapabilityCeiling): CapabilityCeiling {
  const common = (left: string[], right: string[]) => [...new Set(left.filter(value => right.includes(value)))].sort();
  return { toolClasses: common(a.toolClasses, b.toolClasses), hostServices: common(a.hostServices, b.hostServices), connectors: common(a.connectors, b.connectors), network: a.network === "internet" && b.network === "internet" ? "internet" : "none" };
}

/** Pure current-record authorization. No VM, local filesystem or credential fallback. */
export class CoworkAuthority {
  constructor(private readonly records: CoworkRepository, private readonly grants: CoworkGrantResolver) {}
  requireWorkspace(principal: CoworkPrincipal, workspaceId: string, operation: "read" | "narrow" | "admin"): void {
    const workspace = this.records.get(workspaceId);
    if (workspace.state === "deleted" || workspace.state === "deleting") throw new CoworkError("authority_denied");
    if (principal.kind === "local-user") return;
    if (principal.kind === "paired-user" && principal.workspaceIds.has(workspaceId) && operation !== "admin") return;
    // Agent runtime tools have their own bounded ports, never user workspace administration.
    throw new CoworkError("authority_denied");
  }
  requireSelection(principal: CoworkPrincipal, selected: SourceSelection): void {
    if (principal.kind !== "local-user" && principal.kind !== "paired-user") throw new CoworkError("authority_denied");
    if (selected.kind === "folder") {
      if (principal.kind !== "local-user") throw new CoworkError("authority_denied");
      const grant = this.grants.folder(selected.detail.grantRef);
      if (!grant || grant.revoked || grant.rootIdentity !== selected.detail.rootIdentity || (selected.access === "read-write" && !grant.writable)) throw new CoworkError("authority_denied");
    } else if (selected.kind === "githubRepository") {
      if (principal.kind === "paired-user" && !principal.repositoryAuthorities.has(selected.detail.authorityRef)) throw new CoworkError("authority_denied");
      const grant = this.grants.repository(selected.detail.authorityRef, selected.detail.repositoryId);
      // Local checkout edits do not require remote push authority. Publication is checked separately.
      if (!grant || grant.revoked || !grant.readable) throw new CoworkError("authority_denied");
    } else throw new CoworkError("authority_denied");
  }
  requireSource(workspaceId: string, sourceId: string, write = false): WorkspaceSource {
    const workspace = this.records.get(workspaceId), selected = this.records.source(workspaceId, sourceId);
    if (workspace.state !== "retained" || selected.state !== "ready" || selected.desired !== "present" || selected.ackRevision !== selected.revision || selected.ackIncarnationId !== workspace.incarnationId || (write && selected.access !== "read-write")) throw new CoworkError("source_unavailable");
    // Re-read live grants rather than trusting a previously acknowledged mount.
    this.requireSelection({ kind: "local-user", id: "host-grant-recheck" }, selected);
    return selected;
  }
  effectiveCapabilities(sessionId: string): CapabilityCeiling {
    const binding = this.records.binding(sessionId);
    if (binding.state !== "active" || this.records.get(binding.workspaceId).state !== "retained") throw new CoworkError("authority_denied");
    return intersectCeilings(binding.restrictions, this.records.policy(binding.workspaceId).ceiling);
  }
  requireAutomaticPublication(workspaceId: string, sourceId: string): WorkspaceSource {
    if (this.records.policy(workspaceId).publication !== "github-only-feature-branches" || !this.records.githubOnly(workspaceId)) throw new CoworkError("authority_denied");
    const selected = this.requireSource(workspaceId, sourceId, true);
    if (selected.kind !== "githubRepository") throw new CoworkError("authority_denied");
    const remote = this.grants.repository(selected.detail.authorityRef, selected.detail.repositoryId);
    if (!remote || remote.revoked || !remote.writable) throw new CoworkError("authority_denied");
    return selected; // Ref/protection/task restrictions remain the Git broker's mandatory check.
  }
  requirePeer(principal: CoworkPrincipal, targetSessionId: string): void {
    if (principal.kind !== "runtime") throw new CoworkError("authority_denied");
    const sender = this.records.binding(principal.sessionId), target = this.records.binding(targetSessionId);
    if (sender.workspaceId !== principal.workspaceId || sender.workspaceId !== target.workspaceId || !sender.projectId || sender.projectId !== target.projectId || sender.state !== "active" || target.state !== "active" || this.records.get(sender.workspaceId).state !== "retained") throw new CoworkError("authority_denied");
  }
}
