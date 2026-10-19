/** Host-only interfaces. None of these adapters or grant records may come from guest JSON. */
export interface PublicationRequest {
  requestId: string; workspaceId: string; sourceId: string;
  sourceRevision: number; publicationRevision: number;
  ref: string; oldOid: string | null; newOid: string; bundle: Uint8Array;
}
export interface Publisher { principalId: string; sessionId: string; taskId: string }
export interface PublicationGrant {
  repositoryId: string; destinationId: string; authorityId: string; authorityRevision: number;
  sourceRevision: number; publicationRevision: number;
  /** Host-owned scope. null explicitly grants workspace-wide access; cwd is not authority.
   * Revision must advance on every scope change, including restoring an earlier scope. */
  sourceScope: { revision: number; sourceIds: string[] | null };
  /** Canonical authority epochs plus normalized effective-capability digest. */
  capabilityState: { conversationRevision: number; policyRevision: number; digest: string };
}
/** Must recheck canonical source/policy, authenticated runtime/task restrictions and current account grants. */
export interface PublicationAuthority {
  authorize(publisher: Publisher, request: Readonly<PublicationRequest>): Promise<PublicationGrant>;
}
export interface RemoteObservation {
  repositoryId: string; destinationId: string; defaultRef: string;
  protection: "unprotected" | "protected" | "unknown"; currentOid: string | null;
}
export interface PushPlan {
  quarantine: string; ref: string; oldOid: string | null; newOid: string;
  /** Explicit single-ref CAS. Host graph validation must precede constructing this plan. */
  refspec: string; lease: string;
}
export interface PublicationTransport {
  observe(grant: Readonly<PublicationGrant>, ref: string, signal?: AbortSignal): Promise<RemoteObservation>;
  /** Credential-owning host implementation resolves canonical destination; never a guest URL. */
  push(grant: Readonly<PublicationGrant>, plan: Readonly<PushPlan>, signal?: AbortSignal): Promise<"applied" | "rejected" | "uncertain">;
}
export type PublicationStatus = "prepared" | "dispatched" | "applied" | "rejected" | "uncertain";
export interface PublicationReceipt {
  operationId: string; digest: string; status: PublicationStatus;
  repositoryId: string; ref: string; oldOid: string | null; newOid: string;
}
/** Atomic insert-if-absent and durable transition required; implement in protected host storage. */
export interface PublicationJournal {
  claim(key: string, receipt: PublicationReceipt): Promise<{ created: boolean; receipt: PublicationReceipt }>;
  transition(key: string, from: PublicationStatus, to: PublicationStatus): Promise<PublicationReceipt>;
}
export interface GitCommand { cwd: string; home: string; args: readonly string[]; signal?: AbortSignal; withinBudget?: () => boolean | Promise<boolean> }
export interface GitResult { code: number; stdout: string }
export interface GitExecutor { run(command: GitCommand): Promise<GitResult> }
export type GitPublicationErrorCode = "invalid_request" | "authority_denied" | "revision_conflict" | "ref_denied" | "remote_conflict" | "invalid_bundle" | "non_fast_forward" | "object_budget" | "command_failed" | "cancelled" | "request_conflict" | "integration_unavailable"
  /** Publish service only: the guest bundle could not be read intact, or this workspace is already publishing / over its budget. */
  | "bundle_unavailable" | "bundle_stale" | "publication_busy" | "publication_budget";
/** Deliberately excludes raw Git stderr, paths, credential values and adapter errors. */
export class GitPublicationError extends Error {
  constructor(readonly code: GitPublicationErrorCode) { super(code); this.name = "GitPublicationError"; }
}
