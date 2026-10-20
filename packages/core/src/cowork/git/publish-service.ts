import type { CoworkRepository } from "../repository";
import { pullPublishBundle, publishBundlePath, type PublishBundlePort } from "./publish-intake";
import { GitPublicationError, type PublicationReceipt, type PublicationRequest, type Publisher } from "./types";

/*
 * Cowork feature-branch publish SERVICE (content-out lane).
 *
 * It composes pieces that already exist and loosens none of them:
 *   claims, the journal, the outbox and the events  -> `CanonicalPublicationJournal` (one durable operation row per request,
 *                                                       status and outbox notification in one transaction);
 *   authority                                       -> `CurrentCoworkPublicationAuthority` (inside the broker, checked before
 *                                                       the bundle is accepted and again before dispatch);
 *   owned commands and budgets                      -> `IsolatedGitExecutor` (fixed argv, scrubbed environment) and
 *                                                       `checkPackBudget` / the broker's quarantine limits;
 *   the push itself                                 -> the injected `PublicationTransport`, which is HOST-side and holds the
 *                                                       credentials. The guest never sees a remote, a URL or a token.
 *
 * What this module adds: (1) the N2 transport, a host-initiated bundle PULL over the guest file channel, from a path the host
 * derives; (2) the host-derived request (workspace from the session's binding, revisions from canonical records, never from
 * guest JSON); (3) a per-workspace in-flight and rate budget; (4) a typed status read and a recovery entry.
 *
 * UNAVAILABLE BY CONSTRUCTION. `createCoworkPublishService(undefined)` is the only shape a production caller could build
 * today, and every verb of it refuses `integration_unavailable`. The ports object (broker per workspace, journal per
 * workspace, the guest bundle port, the canonical records) is never supplied by production. The broker keeps its own
 * `isolatedFixture` guard and `availability()` untouched, so even a hand-built broker refuses outside a fixture. Nothing
 * here adds a `CoworkErrorCode`, an RPC or a session-creation path: `session.create {mode:"cowork"}` is unchanged.
 */

/** The broker surface this service needs (`CoworkGitPublicationBroker` satisfies it). Built per workspace: its journal is. */
export interface PublishBroker { publish(publisher: Publisher, request: PublicationRequest, signal?: AbortSignal): Promise<PublicationReceipt> }
/** The recovery surface of `CanonicalPublicationJournal`. */
export interface PublishJournal {
  recoverPrepared(confirmPreviousOwnerTerminated: (candidate: Readonly<{ workspaceId: string; operationId: string; ownerId: string }>) => Promise<boolean>,
    onCandidateError?: (operationId: string, code: "record_invalid" | "proof_unavailable" | "persistence_unavailable") => void): Promise<number>;
}
/** Where the live guest keeps the session's repository. The host's own record of the running incarnation, never guest JSON. */
export interface PublishGuestLocator {
  locate(input: { readonly workspaceId: string; readonly sessionId: string; readonly sourceId: string }): { readonly incarnationId: string; readonly locationId: string } | null;
}
export interface PublishLimits {
  /** Largest bundle the host will pull; must not exceed the broker's own `bundleBytes`. */
  bundleBytes: number;
  /** Publish attempts admitted per workspace in one window. In-memory: a daemon restart resets it. */
  maxPerWindow: number; windowMs: number;
}
export interface CoworkPublishPorts {
  readonly records: CoworkRepository;
  readonly guest: PublishBundlePort & PublishGuestLocator;
  broker(workspaceId: string): PublishBroker;
  journal(workspaceId: string): PublishJournal;
  readonly limits?: Partial<PublishLimits>;
  readonly now?: () => number;
}

/** The host-authenticated caller. In production this is derived from the connection and the session, not from a request. */
export interface PublishCaller { readonly principalId: string; readonly sessionId: string; readonly taskId: string }
/** What the guest-side tool supplies: ids and the one ref update. The bundle itself is pulled, never pushed to the host. */
export interface PublishInput { readonly requestId: string; readonly sourceId: string; readonly ref: string; readonly oldOid: string | null; readonly newOid: string }

export const DEFAULT_PUBLISH_LIMITS: PublishLimits = Object.freeze({ bundleBytes: 8_388_608, maxPerWindow: 20, windowMs: 600_000 });
const ID = /^[a-zA-Z0-9_-]{1,128}$/;
const deny = (code: ConstructorParameters<typeof GitPublicationError>[0]): never => { throw new GitPublicationError(code); };

export interface CoworkPublishService {
  /** Always false from production wiring; true only for a service built from a ports object. */
  availability(): { available: boolean; reason?: "publication_ports_absent" };
  publish(caller: PublishCaller, input: PublishInput, signal?: AbortSignal): Promise<PublicationReceipt>;
  /** The separate status read path: a prior receipt, never a new effect. */
  status(caller: PublishCaller, requestId: string): PublicationReceipt | null;
  /** Retire unsent preparations of a dead host owner. Needs the host's proof that the previous owner terminated. */
  recover(workspaceId: string, confirmPreviousOwnerTerminated: Parameters<PublishJournal["recoverPrepared"]>[0]): Promise<number>;
}

class Unavailable implements CoworkPublishService {
  availability(): { available: false; reason: "publication_ports_absent" } { return { available: false, reason: "publication_ports_absent" }; }
  async publish(): Promise<never> { return deny("integration_unavailable"); }
  status(): never { return deny("integration_unavailable"); }
  async recover(): Promise<never> { return deny("integration_unavailable"); }
}

/** `undefined` is what production passes. */
export function createCoworkPublishService(ports: CoworkPublishPorts | undefined): CoworkPublishService {
  return ports ? new PublishService(ports) : new Unavailable();
}

class PublishService implements CoworkPublishService {
  private readonly limits: PublishLimits;
  private readonly inFlight = new Set<string>();
  private readonly admissions = new Map<string, number[]>();
  constructor(private readonly ports: CoworkPublishPorts) {
    this.limits = { ...DEFAULT_PUBLISH_LIMITS, ...ports.limits };
    if (![this.limits.bundleBytes, this.limits.maxPerWindow, this.limits.windowMs].every(n => Number.isSafeInteger(n) && n > 0)) deny("invalid_request");
  }
  availability(): { available: true } { return { available: true }; }

  async publish(caller: PublishCaller, input: PublishInput, signal?: AbortSignal): Promise<PublicationReceipt> {
    const publisher = this.publisher(caller);
    if (!input || typeof input !== "object" || ![input.requestId, input.sourceId].every(v => typeof v === "string" && ID.test(v))) return deny("invalid_request");
    const { records, guest } = this.ports;
    // Everything below comes from canonical host records, never from the guest: the workspace is the session's binding, the
    // revisions are the CURRENT ones. A change while the bundle is pulled makes the broker's authority see a conflict.
    let workspaceId: string, sourceRevision: number, publicationRevision: number;
    try {
      const binding = records.binding(publisher.sessionId);
      if (binding.state !== "active" || binding.policy === "plan") return deny("authority_denied");
      workspaceId = binding.workspaceId;
      // A source of another workspace, or none, throws here; the broker's authority then judges the repository grant itself.
      const source = records.source(workspaceId, input.sourceId);
      sourceRevision = source.revision; publicationRevision = records.policy(workspaceId).publicationRevision;
    } catch (error) { if (error instanceof GitPublicationError) throw error; return deny("authority_denied"); }
    const location = guest.locate({ workspaceId, sessionId: publisher.sessionId, sourceId: input.sourceId });
    if (!location) return deny("bundle_unavailable");
    const release = this.admit(workspaceId);
    try {
      const bundle = await pullPublishBundle(guest, { workspaceId, sessionId: publisher.sessionId, locationId: location.locationId,
        relativePath: publishBundlePath(input.requestId), incarnationId: location.incarnationId, sourceRevision },
      { maxBytes: this.limits.bundleBytes }, signal);
      return await this.ports.broker(workspaceId).publish(publisher, { requestId: input.requestId, workspaceId, sourceId: input.sourceId,
        sourceRevision, publicationRevision, ref: input.ref, oldOid: input.oldOid, newOid: input.newOid, bundle: bundle.bytes }, signal);
    } finally { release(); }
  }

  status(caller: PublishCaller, requestId: string): PublicationReceipt | null {
    const publisher = this.publisher(caller);
    if (typeof requestId !== "string" || !ID.test(requestId)) return deny("invalid_request");
    let workspaceId: string;
    try { workspaceId = this.ports.records.binding(publisher.sessionId).workspaceId; } catch { return deny("authority_denied"); }
    const row = this.ports.records.rs.db.query<{ operation_id: string; request_digest: string; result_json: string }, [string, string, string]>(
      "SELECT operation_id,request_digest,result_json FROM cowork_operations WHERE principal_id=? AND method='git.publish' AND scope=? AND request_id=?").get(publisher.principalId, workspaceId, requestId);
    if (!row) return null;
    try {
      const receipt = JSON.parse(row.result_json).value.publication as PublicationReceipt;
      if (receipt.operationId !== row.operation_id || receipt.digest !== row.request_digest) throw new Error();
      return receipt;
    } catch { return deny("command_failed"); }
  }

  async recover(workspaceId: string, confirm: Parameters<PublishJournal["recoverPrepared"]>[0]): Promise<number> {
    if (typeof workspaceId !== "string" || !ID.test(workspaceId)) return deny("invalid_request");
    return this.ports.journal(workspaceId).recoverPrepared(confirm);
  }

  private publisher(caller: PublishCaller): Publisher {
    if (!caller || ![caller.principalId, caller.sessionId, caller.taskId].every(v => typeof v === "string" && ID.test(v))) return deny("invalid_request");
    return Object.freeze({ principalId: caller.principalId, sessionId: caller.sessionId, taskId: caller.taskId });
  }

  /** One publish at a time per workspace, and a rolling cap on attempts. Both release/expire without leaving state behind. */
  private admit(workspaceId: string): () => void {
    if (this.inFlight.has(workspaceId)) return deny("publication_busy");
    const now = (this.ports.now ?? Date.now)(), recent = (this.admissions.get(workspaceId) ?? []).filter(at => now - at < this.limits.windowMs);
    if (recent.length >= this.limits.maxPerWindow) { this.admissions.set(workspaceId, recent); return deny("publication_budget"); }
    recent.push(now); this.admissions.set(workspaceId, recent); this.inFlight.add(workspaceId);
    let released = false;
    return () => { if (!released) { released = true; this.inFlight.delete(workspaceId); } };
  }
}
