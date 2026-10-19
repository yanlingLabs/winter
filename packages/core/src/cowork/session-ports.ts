import type { CanUseTool } from "@yanlinglabs/winter-agent-sdk";
import type { NewSessionEvent } from "@yanlinglabs/winter-protocol";
import type { LegSession } from "../runtime-sdk/session-driver";
import type { CoworkHostApprovalPorts } from "./approval-ports";
import type { CoworkPrincipal } from "./authority";
import type { CoworkResumePlan } from "./cold-resume";
import type { CoworkHeldInputVerbs } from "./held-input";
import type { CoworkConnection } from "./service";
import type { CoworkConversation } from "./types";

/*
 * Cowork session door: the SPINE (D1). TYPES ONLY. Nothing here runs, and nothing in production constructs any of it:
 * `session.create {mode: "cowork"}` answers `unsupported_topology` for every role until a `CoworkSessionDoor` is passed to
 * `startIpcServer`, which no production caller does (the single activation switch,
 * docs/research/2026-10-18-cowork-session-door-design.md section 6). The other lanes build against these shapes:
 *
 *   - ipc/server.ts                 consumes `CoworkSessionDoor` (`IpcServerOptions.coworkSessions`);
 *   - S7B (native environment)      implements `CoworkGuestRuntimeOffer`, `CoworkGuestRun`/`CoworkGuestRuntimeLink` and
 *                                   `CoworkProvisioningPort`;
 *   - APPROVALS                     implements `CoworkApprovalPort`;
 *   - PEER-INBOX and the schedule   call `CoworkSessionDrivers`;
 *     dispatch port
 *   - the guest-image lane          accepts the stand-in `CoworkProviderRoute`'s selection, and only in its TEST image.
 *
 * WHY THE NATIVE-FACING TYPES ARE STRUCTURAL COPIES. The native anti-wiring pin lets exactly one module outside the native
 * worker directory import from it, type-only imports included, and this is not that module. So the conversation set, its
 * context, the stop outcome and the runtime link are declared here, and `test/cowork/session-ports.test.ts` proves each is
 * assignable BOTH ways to its native twin (`CoworkNativeConversationSet`, `CoworkNativeConversationContext`,
 * `CoworkNativeStopOutcome`), the readiness keys equal to the profile's own key type, and the provider route scope to the
 * broker's scope. A drift on either side fails that test (at typecheck), not a runtime.
 */

// ---------------------------------------------------------------------------------------------------- the door

/** `session.create`'s Cowork binding after the RPC-only checks (the protocol's `CoworkSessionCreate`). */
export interface CoworkSessionCreateInput {
  /** The session store scope the row is minted under (`session.create`'s own `scope`). */
  readonly scope: string;
  readonly workspaceId: string;
  readonly requestId: string;
  readonly location: { readonly kind: "source"; readonly sourceId: string; readonly relativeCwd?: string } | { readonly kind: "outputs" };
}

/** A Cowork conversation's live driver: the Code `LegSession` surface, with the one mode a Cowork driver can hold, and the
 *  incarnation it runs in (`PeerEpoch` for the peer inbox; undefined until its guest has started). Verbs the host-query
 *  guest cannot carry (model, policy, compaction, an interrupt) refuse typed on the host and never reach the guest. */
export type CoworkLegSession = Omit<LegSession, "mode"> & {
  readonly mode: "cowork";
  readonly coworkEpoch: { readonly incarnationId: string; readonly leaseEpoch: number } | undefined;
  /** #92 N4: the held-input verbs (PEER-INBOX's `drainOnce` drives them). Present only with the host's gate and a runtime
   *  that offered `held-input-v1`; absent everywhere in production. */
  readonly heldInput?: CoworkHeldInputVerbs;
};

/** The Cowork driver table, beside the Code one, keyed by stored mode. Same verbs ipc/server.ts and SessionMessaging call. */
export interface CoworkSessionDrivers {
  get(sessionId: string): CoworkLegSession | undefined;
  /** Refuses typed (`CoworkError`): `provider_unavailable`, `conversation_limit`, `cold_resume_unavailable`,
   *  `recovery_required`, `unsupported_topology`. Never resolves to a fresh conversation in place of a refused one. */
  ensure(sessionId: string): Promise<CoworkLegSession>;
  /** One headless turn (the CLI's `-p` path), awaited to its end. Same refusals as `ensure`. */
  runTurn(sessionId: string, text: string, clientName: string): Promise<void>;
  evict(sessionId: string): Promise<void>;
  list(): CoworkLegSession[];
  /** `daemon.stop()` calls it BEFORE the native wiring drains its guests. Never rejects. */
  beginShutdown(): Promise<void>;
}

/** THE single activation switch: ipc/server.ts routes `session.create {mode: "cowork"}` here only when one was passed. */
export interface CoworkSessionDoor {
  /** Refuses `provider_unavailable` before any row when no provider route exists; otherwise mints the row, then binds. */
  create(input: CoworkSessionCreateInput, caller: CoworkConnection): Promise<{ sessionId: string }>;
  readonly drivers: CoworkSessionDrivers;
}

/** A bound conversation's durable backend identity (migration 18's `backend_session_id`, minted at bind). */
export interface CoworkConversationRuntimeIdentity { readonly backendSessionId: string; readonly model: string; readonly resume: boolean }

// ---------------------------------------------------------------------------------------------------- provider route

/** Public metadata only (the guest supervisor refuses `authref`, `url`, `header`, `secret`, `token`, `credential` keys too). */
export interface CoworkProviderSelection {
  readonly providerId: string; readonly modelKey: string; readonly providerModelId: string;
  readonly family: string; readonly protocol: string; readonly capabilities: readonly string[];
  readonly continuationDomain?: string;
}
/** The provider scope the conversation set carries: the host provider broker's scope fields, pinned equal by test. */
export interface CoworkProviderRouteScope {
  readonly homeId: string; readonly workspaceId: string; readonly sessionId: string; readonly backendSessionId: string; readonly taskId: string;
  readonly incarnationId: string; readonly bootId: string; readonly leaseEpoch: number; readonly grantRevision: number;
  readonly accountRevision: number; readonly modelRevision: number;
}
/** Injected only by code (never a setting, environment variable or RPC). Production supplies none: then every Cowork
 *  create and send refuses `provider_unavailable`. `scripted-standin` exists only beside the guest-side stand-in TEST image
 *  (owner decision O2, 2026-10-18), whose own digest the production image pin refuses. Nothing here uses the mux. */
export interface CoworkProviderRoute {
  readonly kind: "scripted-standin";
  readonly model: string;
  plan(input: { readonly scope: CoworkProviderRouteScope }): { readonly model: string; readonly provider: { readonly scope: CoworkProviderRouteScope; readonly selection: CoworkProviderSelection } };
}

// ---------------------------------------------------------------------------------------------------- approvals (APPROVALS lane)

/** One bridge per incarnation. Cards land on the conversation's own log, keyed by `callId`; it is never a `mode: "code"` bridge.
 *  `cowork` is the conversation's host ports (the approval bridge's injected `cowork` dependency, `approval-ports.ts`), and
 *  `turnOrigin` says who started the running turn (an unattended turn's card is bounded and times out to a deny). */
export interface CoworkApprovalPort {
  canUseToolFor(input: {
    readonly sessionId: string; /** Either location (D3b). */ readonly binding: Readonly<CoworkConversation>; readonly policyRevision: number;
    readonly cowork: CoworkHostApprovalPorts;
    /** The guest cwd (the conversation's root) a relative tool path resolves against. */
    readonly cwd: string;
    turnOrigin(): string | undefined;
    emit(event: NewSessionEvent): void;
  }): CanUseTool & { withdrawPending(callId: string): boolean };
}

// ---------------------------------------------------------------------------------------------------- provisioning (S7B)

/** Replaces `requireProvisioning`'s refusal once the production native environment exists. Admission is pure; the effects
 *  run after COMMIT. The native `CoworkVolumeAuthority` refuses `allocate`, so `provision` carries its own allocate authority. */
export interface CoworkProvisioningPort {
  /** True only when the native environment, the installed image pin and the allocate authority exist. */
  available(): boolean;
  /** Inside `workspace.create`/`project.create` and source additions. Throws `CoworkError("unsupported_topology")` when unavailable. */
  admit(principal: CoworkPrincipal): void;
  /** Allocate the data and environment images (backup excluded), pin the base and runtime digests, create the shared
   *  directories. Idempotent per operation. */
  provision(workspaceId: string, operationId: string): Promise<{ readonly status: "applied" | "failed"; readonly reason?: string }>;
}

// ---------------------------------------------------------------------------------------------------- native seams (structural; S7B implements)

/** Mirrors the Cowork tool profile's readiness keys (pinned equal by test; the profile module stays unimported here). */
export type CoworkGuestReadinessKey = "guest-compartment" | "guest-tool-families" | "linux-workflow" | "guest-lsp" | "skill-surface"
  | "plan-transition" | "scheduler-bridge" | "host-provider-transport" | "host-network-endpoint";

/** What the pinned guest image can carry, declared by the native environment from the verified pin, never by DOOR code. */
export interface CoworkGuestRuntimeOffer {
  readonly profile: "host-query-v1";
  /** The N2 image backs at most `guest-compartment`. Production declares nothing until its environment exists. */
  readonly readiness: readonly CoworkGuestReadinessKey[];
  readonly runtimeCapability: { readonly protocolVersion: 1; readonly capabilities: readonly string[]; readonly supportsConfinedGuestExecution: boolean };
}

/** Mirrors `CoworkNativeConversationContext` (native/host.ts). */
export interface CoworkGuestConversationContext { readonly workspaceId: string; readonly incarnationId: string; readonly leaseEpoch: number; readonly guestBootId: string }
/** Mirrors `CoworkNativeConversation` (native/protocol.ts), field for field. */
export interface CoworkGuestConversation {
  readonly logicalSessionId: string;
  readonly authority: {
    readonly workspaceId: string; readonly sessionId: string; readonly incarnationId: string; readonly leaseEpoch: number;
    readonly configRevision: number; readonly grantRevision: number; readonly policyRevision: number;
  };
  readonly runtimeUid: number; readonly toolUid: number; readonly workspaceGid: number;
  readonly policy: "auto" | "plan" | "ask" | "accept-edits" | "dont-ask" | "bypass";
  readonly roots: readonly { readonly id: string; readonly guestPath: string; readonly source: string; readonly readOnly: boolean }[];
  readonly runtime: {
    readonly model: string; readonly timeoutMs: number; readonly toolClasses: readonly ("read" | "write" | "execute")[];
    readonly provider: Readonly<Record<string, unknown>>;
    readonly guided: Readonly<{ bindingId: string; generation: number }> | null;
  } | null;
}
/** Mirrors `CoworkNativeConversationSet` (native/host.ts). N2: a host-query profile carries exactly one conversation. */
export interface CoworkGuestConversationSet { readonly profile: "host-query-v1" | "host-query-guided-v1" | null; readonly conversations: readonly CoworkGuestConversation[] }
/** Mirrors `CoworkNativeStopOutcome` (native/host.ts). */
export type CoworkGuestStopOutcome =
  | { readonly released: true; readonly evidence: "orderly-receipt" | "new-boot" | "owner-recover" }
  | { readonly released: false; readonly reason: string };

/** One folder share the guest reports mounted (#92 section 2.5, `shares_mounted`): the source it backs, at the revision the
 *  host's `shares` records were prepared from. Host-mapped from the share tag; never a guest-supplied id. */
export interface CoworkMountedShare { readonly sourceId: string; readonly revision: number }
/** What a start is handed: the incarnation's conversation set, asked once at `mounted`. */
export interface CoworkGuestStartRequest {
  conversations(context: CoworkGuestConversationContext): CoworkGuestConversationSet | null;
  /** #92 N2: at the guest's `shares_mounted` (contract text version 3), BEFORE `conversations`. Each mounted folder source
   *  becomes honestly `ready` for THIS incarnation (`acknowledgeSource`). Throws typed to fault the boot. No native host
   *  calls it before the v3 contract exists (S7B), so today it is never invoked. */
  sharesMounted?(context: CoworkGuestConversationContext, mounted: readonly CoworkMountedShare[]): void;
  /** #92 N3: present only on a gated cold resume. S7B's v3 host puts it on the conversation's runtime record
   *  (`runtime.continuation`, `runtime.endedGuestBoots`) and checks the guest's `continuation` echo. */
  readonly resume?: CoworkResumePlan;
}
/** The runtime class (2) for one conversation. Today the native host drops runtime frames ("no consumer in this slice");
 *  S7B adds this link. */
export interface CoworkGuestRuntimeLink {
  /** IN bytes. At most 1 MiB unanswered in flight (`runtimeInFlightBytes`), chunks of at most 256 KiB; resolves when the
   *  frame is handed to the launcher channel. */
  send(bytes: Uint8Array, end?: boolean): Promise<void>;
  /** OUT and ERR bytes in order; `end` true once per stream. Returns an unsubscribe. */
  onData(handler: (stream: "out" | "err", bytes: Uint8Array, end: boolean) => void): () => void;
  /** Settles once the incarnation's stop outcome is known, released or not. */
  readonly ended: Promise<CoworkGuestStopOutcome>;
}
/** A running incarnation, as a start resolves it. */
export interface CoworkGuestRun {
  readonly workspaceId: string; readonly incarnationId: string; readonly leaseEpoch: number; readonly guestBootId: string;
  /** Conversation index 0 only (N2), available after `runtime_ready`. */
  runtime(conversation: 0): CoworkGuestRuntimeLink;
  stop(reason: "user" | "shutdown" | "restart" | "update"): Promise<CoworkGuestStopOutcome>;
  /** Settles once with the incarnation's stop outcome, whoever stopped it. */
  readonly ended: Promise<CoworkGuestStopOutcome>;
}
/** The native start the Cowork driver needs: the service's `CoworkGuestStartPort` (cowork/service.ts), narrowed to resolve the
 *  running incarnation. S7B's `CoworkNativeWiring.start(workspaceId, request?)` (#87) is this shape; the twin pin lands with
 *  whichever of #87 and the session door merges second. Injected only by code; production supplies none while
 *  `COWORK_NATIVE_ENVIRONMENT_ACTIVATED` is false. It begins the incarnation in the repository, asks `conversations` once at
 *  `mounted`, and resolves after `runtime_ready`. */
export interface CoworkGuestStarter {
  start(workspaceId: string, request?: CoworkGuestStartRequest): Promise<CoworkGuestRun>;
}
