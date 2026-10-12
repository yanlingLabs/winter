import { createHash } from "node:crypto";
import type { CoworkAuthority } from "../authority";
import type { CoworkRepository } from "../repository";
import { GitReadError, type GitHubReadRepository, type GitReadAuthority, type GitReadCaller, type GitReadGrant, type GitReadRequest } from "./read-types";

export interface GitHubReadGrantResolver {
  /** Synchronous protected current repository/account snapshot; refresh/network happens outside admission.
   * Never guest URLs or credential names. Every change advances authorityRevision, including restores. */
  repository(authorityRef: string, repositoryId: string): GitHubReadRepository | undefined;
  /** Synchronous protected runtime/task source scope, without network or refresh.
   * Explicit runtime/task source scope. Missing denies; null explicitly permits whole workspace. */
  sourceScope(caller: Readonly<GitReadCaller>): { revision: number; sourceIds: readonly string[] | null } | undefined;
}
const positive = (n: number) => Number.isSafeInteger(n) && n > 0;
export function validateGitHubReadRepository(grant: GitHubReadRepository): void {
  // GitHub repository path components are host metadata, never interpreted as URLs.
  if (!grant || !grant.readable || grant.revoked || !positive(grant.authorityRevision)
    || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(grant.owner)
    || !/^[A-Za-z0-9_.-]{1,100}$/.test(grant.name) || [".", ".."].includes(grant.name)
    || !grant.repositoryId || !grant.authorityRef || !grant.credentialRef) throw new GitReadError("authority_denied");
}
/** Canonical host records; preparing permits checkout, without fabricating a ready ACK. */
export class CurrentCoworkGitReadAuthority implements GitReadAuthority {
  constructor(private readonly records: CoworkRepository, private readonly authority: CoworkAuthority, private readonly grants: GitHubReadGrantResolver) {}
  async authorize(caller: Readonly<GitReadCaller>, request: Readonly<GitReadRequest>): Promise<GitReadGrant> {
    try {
      const before = this.check(caller, request);
      const selected = this.records.source(caller.workspaceId, request.sourceId);
      if (selected.kind !== "githubRepository") throw new GitReadError("authority_denied");
      const scope = this.scope(caller, request.sourceId);
      const resolved = this.grants.repository(selected.detail.authorityRef, selected.detail.repositoryId);
      const grant = resolved ? { ...resolved } : undefined;
      if (!grant) throw new GitReadError("authority_denied");
      validateGitHubReadRepository(grant);
      const finalScope = this.scope(caller, request.sourceId);
      // No awaits follow these canonical checks: a host scope resolver may change any
      // workspace, worker, binding, policy or account grant. Copy the first account
      // snapshot so mutation of a resolver-owned object cannot overwrite our epoch.
      const currentGrant = this.grants.repository(selected.detail.authorityRef, selected.detail.repositoryId);
      if (!currentGrant || JSON.stringify(currentGrant) !== JSON.stringify(grant)
        || grant.repositoryId !== selected.detail.repositoryId || grant.authorityRef !== selected.detail.authorityRef
        || this.check(caller, request) !== before || finalScope !== scope) throw new GitReadError("authority_denied");
      const workspace = this.records.get(caller.workspaceId);
      return { ...grant, ...caller, sourceId: request.sourceId, sourceRevision: request.sourceRevision,
        grantRevision: workspace.grantRevision, configRevision: workspace.configRevision,
        scopeDigest: createHash("sha256").update(before + scope).digest("hex") };
    } catch (error) { throw error instanceof GitReadError ? error : new GitReadError("authority_denied"); }
  }
  private check(caller: Readonly<GitReadCaller>, request: Readonly<GitReadRequest>): string {
    const w = this.records.get(caller.workspaceId), s = this.records.source(caller.workspaceId, request.sourceId);
    if (w.state !== "retained" || !["starting", "running"].includes(w.power) || w.incarnationId !== caller.incarnationId
      || w.leaseEpoch !== caller.leaseEpoch || !positive(caller.leaseEpoch)) throw new GitReadError("authority_denied");
    if (w.grantRevision !== request.grantRevision || s.revision !== request.sourceRevision) throw new GitReadError("revision_conflict");
    if (s.kind !== "githubRepository" || s.desired !== "present" || !["preparing", "ready"].includes(s.state) || s.trust === "revoked") throw new GitReadError("authority_denied");
    if (s.state === "ready" && (s.ackRevision !== s.revision || s.ackIncarnationId !== caller.incarnationId)) throw new GitReadError("authority_denied");
    let runtime: unknown = null;
    if (caller.sessionId) {
      const binding = this.records.binding(caller.sessionId), caps = this.authority.effectiveCapabilities(caller.sessionId);
      if (binding.state !== "active" || binding.workspaceId !== caller.workspaceId || s.state !== "ready"
        || !caps.toolClasses.includes("read") || !caps.hostServices.includes("git.read")) throw new GitReadError("authority_denied");
      runtime = { binding: binding.revision, policy: this.records.policy(w.workspaceId).revision,
        caps: { ...caps, toolClasses: [...caps.toolClasses].sort(), hostServices: [...caps.hostServices].sort(), connectors: [...caps.connectors].sort() } };
    }
    return JSON.stringify({ config: w.configRevision, grant: w.grantRevision, source: s.revision, detail: s.detail, runtime });
  }
  private scope(caller: Readonly<GitReadCaller>, sourceId: string): string {
    if (!caller.sessionId) return "host-preparation";
    const scope = this.grants.sourceScope(caller);
    if (!scope || !positive(scope.revision) || (scope.sourceIds !== null && (!Array.isArray(scope.sourceIds)
      || scope.sourceIds.length > 100 || !scope.sourceIds.every(value => /^[A-Za-z0-9_-]{1,128}$/.test(value)) || !scope.sourceIds.includes(sourceId)))) throw new GitReadError("authority_denied");
    return JSON.stringify({ revision: scope.revision, sourceIds: scope.sourceIds === null ? null : [...new Set(scope.sourceIds)].sort() });
  }
}
