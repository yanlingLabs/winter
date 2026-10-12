/** Only the request is guest data; caller, grants and ports are host-owned. */
export interface GitReadRequest {
  sourceId: string; sourceRevision: number; grantRevision: number;
  operation: "advertise" | "upload-pack"; body?: Uint8Array;
}
export interface GitReadCaller {
  workspaceId: string; incarnationId: string; leaseEpoch: number;
  /** Omitted only for a host-owned source preparation operation. */
  sessionId?: string;
}
export interface GitHubReadRepository {
  repositoryId: string; authorityRef: string; authorityRevision: number;
  owner: string; name: string; credentialRef: string; readable: boolean; revoked: boolean;
}
export interface GitReadGrant extends GitHubReadRepository {
  workspaceId: string; incarnationId: string; leaseEpoch: number; sourceId: string;
  sourceRevision: number; grantRevision: number; configRevision: number;
  /** Includes canonical policy/binding/task scope epochs when invoked by a runtime. */
  scopeDigest: string;
}
export interface GitReadAuthority {
  authorize(caller: Readonly<GitReadCaller>, request: Readonly<GitReadRequest>): GitReadGrant;
}
export interface GitReadResponse { contentType: string; body: Uint8Array }
export interface GitReadLimits {
  requestBytes: number; responseBytes: number; advertisementBytes: number;
  concurrent: number; durationMs: number; recheckMs: number; objects: number; expandedObjectBytes: number;
}
export const DEFAULT_GIT_READ_LIMITS: Readonly<GitReadLimits> = Object.freeze({
  requestBytes: 1_048_576, responseBytes: 8_388_608, advertisementBytes: 1_048_576,
  concurrent: 4, durationMs: 30_000, recheckMs: 100, objects: 10_000, expandedObjectBytes: 67_108_864,
});
export type GitReadErrorCode = "invalid_request" | "authority_denied" | "revision_conflict" | "cancelled" | "upstream_failed" | "invalid_response" | "budget_exceeded" | "busy" | "integration_unavailable";
/** No upstream text, headers, URLs, credentials or Git stderr is included. */
export class GitReadError extends Error {
  constructor(readonly code: GitReadErrorCode) { super(code); this.name = "GitReadError"; }
}
