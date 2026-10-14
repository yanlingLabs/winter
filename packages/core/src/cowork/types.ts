import type { ApprovalPolicy } from "@yanlinglabs/winter-protocol";

export type WorkspaceState = "retained" | "archived" | "deleting" | "deleted";
export type SourceState = "preparing" | "ready" | "unavailable" | "removing" | "detached";
export type SourceAccess = "read-only" | "read-write";
export type PublicationPolicy = "github-only-feature-branches" | "manual";
export interface CapabilityCeiling { toolClasses: string[]; hostServices: string[]; connectors: string[]; network: "none" | "internet" }
export interface WorkspacePolicy {
  policyId: string; workspaceId: string; defaultPolicy: ApprovalPolicy; publication: PublicationPolicy;
  ceiling: CapabilityCeiling; revision: number; defaultRevision: number; publicationRevision: number;
}
export interface Workspace {
  workspaceId: string; ownership: "standalone" | "project"; ownerId: string; title: string; state: WorkspaceState;
  configRevision: number; grantRevision: number; instructionRevision: number;
  incarnationId: string | null; leaseEpoch: number; power: "stopped" | "starting" | "running" | "draining" | "uncertain";
  createdAt: string; updatedAt: string;
}
/** Local grant/root identities are opaque host records, never a caller-supplied mount path or token. */
export type SourceSelection =
  | { kind: "folder"; label: string; access: SourceAccess; detail: { grantRef: string; rootIdentity: string } }
  | { kind: "githubRepository"; label: string; access: SourceAccess; detail: { repositoryId: string; authorityRef: string; initialRef: string } };
export type WorkspaceSource = SourceSelection & {
  sourceId: string; workspaceId: string; locationId: string; desired: "present" | "removed"; state: SourceState;
  revision: number; ackRevision: number | null; ackIncarnationId: string | null; reason: string | null;
  restartRequired: boolean; trust: "untrusted" | "trusted" | "revoked"; trustDigest: string | null;
  createdAt: string; updatedAt: string;
};
export interface ConversationBinding {
  sessionId: string; workspaceId: string; projectId: string | null; sourceId: string; relativeCwd: string;
  policy: ApprovalPolicy; restrictions: CapabilityCeiling; revision: number; state: "active" | "archived" | "deleted"; createdAt: string;
}
export interface MutationContext {
  /** Host-derived RPC name for principal/method idempotency scope. */ method?: string;
  /** Pure host effect admission after content-bound replay and revision checks, before writes.
   * Never RPC data; current caller/workspace authorization must precede repository access. */
  admitMutation?: () => void;
  /** Pure host response validation inside the mutation transaction; never RPC data. */
  validateReceipt?: (receipt: MutationReceipt<unknown>) => void;
  /** Host-only closed request identity, allowing source replay after ephemeral selection expiry. */
  requestDigestInput?: unknown;
  /** Pure/descriptor-checked host binding inside the source transaction; never RPC parameters. */
  bindSources?: (sources: readonly WorkspaceSource[]) => void;
  principalId: string; requestId: string; expectedRevision?: number;
}
export interface MutationReceipt<T> { operationId: string; workspaceId: string; revision: number; value: T }
export type OperationStatus = "pending" | "applied" | "blocked" | "failed" | "superseded";
/** Superseded receipts never become applied later, including multi-source creation receipts. */
export const isTerminalOperationStatus = (status: OperationStatus): boolean => ["applied", "failed", "superseded"].includes(status);
export interface GuestEpoch { workspaceId: string; incarnationId: string; leaseEpoch: number; configRevision: number; grantRevision: number }
export type CoworkErrorCode = "not_found" | "revision_conflict" | "stale_cursor" | "request_conflict" | "last_source_required" | "source_unavailable" | "authority_denied" | "invalid_request" | "recovery_required" | "stale_acknowledgment" | "unsupported_topology" | "response_too_large" | "schedule_limit";
export class CoworkError extends Error {
  constructor(readonly code: CoworkErrorCode, readonly currentRevision?: number) { super(code); this.name = "CoworkError"; }
}
