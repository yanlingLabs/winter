import { randomUUID } from "node:crypto";
import { query as agentQuery, type CanUseTool, type Options, type PermissionResult } from "@yanlinglabs/winter-agent-sdk";
import type { NewSessionEvent } from "@yanlinglabs/winter-protocol";
import { createProjector, type Projector } from "../projector";
import type { CheckpointStore } from "../projector/types";
import type { WinterRuntimeSdk } from "../runtime-sdk/create";
import { WinterLegRefusal } from "../runtime-sdk/session-driver";
import { mainTurnOpenInLog } from "../sessions/turn-origins";
import { startWinterSession, unconsumedUserMessages, type WinterIncarnation, type WinterSession, type WinterSessionDeps, type WinterSessionRecords } from "../runtime-sdk/winter-session";
import type { SessionHub } from "../sessions/hub";
import type { SessionStore } from "../sessions/store";
import { turnOriginIndexFor } from "../sessions/turn-origin-index";
import { coworkApprovalPortsFor, type CoworkHostApprovalPorts } from "./approval-ports";
import { coworkContinuationFor, coworkResumePlan, type CoworkResumePlan } from "./cold-resume";
import { coworkHeldInputsFrom, coworkHeldInputVerbs, coworkOffersHeldInput, coworkTapHeldInputs, type CoworkHeldInputRecord } from "./held-input";
import type { CoworkAuthority } from "./authority";
import { COWORK_GUEST_IDENTITIES, COWORK_GUEST_RUNTIME_MODES, coworkConversationCeiling, coworkConversationFor, coworkGuestToolsFromClasses } from "./conversation-set";
import { buildCoworkGuestQueryOptions } from "./guest-query";
import { CoworkGuestRuntimeSupervisor, coworkGuestOfferedTools } from "./guest-runtime";
import type { CoworkRepository } from "./repository";
import { coworkGuestRuntimeChannel } from "./runtime-channel";
import type {
  CoworkApprovalPort, CoworkGuestConversation, CoworkGuestConversationContext, CoworkGuestRun, CoworkGuestRuntimeOffer, CoworkGuestStarter,
  CoworkGuestStopOutcome, CoworkLegSession, CoworkMountedShare, CoworkProviderRoute, CoworkSessionDrivers,
} from "./session-ports";
import { CoworkError, type CapabilityCeiling, type CoworkConversation, type WorkspaceSource } from "./types";

/*
 * Cowork session door D3: the Cowork driver table. One SOURCE-located conversation per guest incarnation (N2), driven by
 * the ordinary `WinterSession` over the host agent SDK's `query()`, whose runtime process is the guest's: the supervisor
 * (`guest-runtime.ts`) admits the launch, and its channel (`runtime-channel.ts`) is the incarnation's runtime class.
 *
 * NOTHING HERE IS REACHABLE IN PRODUCTION. Every Cowork verb refuses `provider_unavailable` unless a provider route, a
 * native starter, the image's runtime offer and the approval port were all injected by code; production builds no driver
 * table at all (the session door is off until D6), the native environment is not activated, and the only route kind is
 * the stand-in beside the guest-side TEST image. Nothing here uses the provider class (mux class 3) or the network.
 *
 * What the driver decides, per conversation:
 *   - `ensure` refuses typed, never silently starting fresh: an outputs row (`unsupported_topology`, the outputs slice is
 *     D3b), a recorded backend identity with no live driver (`cold_resume_unavailable`: the guest store exists and cold
 *     resume, D10, is not built), an uncertain workspace (`recovery_required`), and a guest already running or another
 *     live conversation in the workspace (`conversation_limit`).
 *   - the guest starts at the conversation's first open: the native start asks for the conversation set once, at
 *     `mounted`; the set is built (`conversation-set.ts`) and only THEN is the backend identity recorded (write-once), so
 *     a guest that never received it leaves the conversation startable.
 *   - the host query's Options must agree with the set (cwd, tools, mode, model) or the incarnation is stopped.
 *   - one incarnation per driver: when it ends the driver closes, and the conversation answers `cold_resume_unavailable`.
 *   - the host-query guest accepts only user text without a leading `/`, `end_input`, an EMPTY `interrupt` and closed
 *     permission answers (agent SDK `linux-host-query-profile.ts` `checkLinuxHostQueryFrame`); anything else is a guest
 *     refusal that ends the runtime. So model, policy and compaction changes, an interrupt (the host SDK's carries
 *     `{scope: "turn"}`), images and files refuse typed HERE, and every permission answer is cut to the closed shape.
 *   - it never enters the router's directory (`WinterSession.attachMessaging` skips "cowork") and never idles out.
 */

export interface CoworkSessionDriverDeps {
  readonly records: CoworkRepository;
  readonly authority: CoworkAuthority;
  readonly store: SessionStore;
  readonly hub: SessionHub;
  readonly checkpoints: CheckpointStore;
  /** Each absent in production: then every `ensure` and `runTurn` refuses `provider_unavailable`. */
  readonly route?: CoworkProviderRoute;
  readonly native?: CoworkGuestStarter;
  readonly offer?: CoworkGuestRuntimeOffer;
  readonly approvals?: CoworkApprovalPort;
  /** 8a's session records, when the session has a runtime row (D4). Absent: generations count in memory. */
  readonly sessionRecords?: WinterSessionRecords;
  /** The host agent SDK's `query` (test seam; the default is the SDK's own). */
  readonly query?: typeof agentQuery;
  /** Test seam for the backend identity minter (default: a UUID). */
  readonly mintBackendSessionId?: () => string;
  /** Test seam for `WINTER_SESSION_END_GRACE_MS`. */
  readonly endGraceMs?: number;
  readonly log?: (line: string) => void;
  /** #92 N3: cold resume. Absent (every production composition, pinned): a conversation with a recorded backend refuses
   *  `cold_resume_unavailable`. Supplied ONLY once the owner has applied the cold-resume owner patch (the unmodified native
   *  owner refuses a resume record) and S7B's v3 host carries `CoworkGuestStartRequest.resume` to the guest. */
  readonly coldResume?: { readonly ownerPatchApplied: true };
  /** #92 N4: held-input messaging. Absent (every production composition, pinned): no driver exposes `heldInput`. Present,
   *  a driver exposes it only to a runtime that offered `held-input-v1`. */
  readonly heldInput?: {
    readonly enabled: true;
    /** Design rule 1 (4.5): the verbs bind to the incarnation's epoch only AFTER the runtime's `system/held_inputs` was
     *  reconciled with the host's ledger. The driver calls this once with that list and the live epoch; the verbs stay
     *  refused until it resolves, and a throw (or a malformed list) leaves them refused for the incarnation. A gate without
     *  it is not a gate: PEER-INBOX supplies the ledger side. */
    readonly reconcile: (inputs: readonly CoworkHeldInputRecord[], epoch: { readonly incarnationId: string; readonly leaseEpoch: number }) => void | Promise<void>;
  };
}

/**
 * #92 N2: the guest mounted these folder shares for this incarnation. Each named source must be a present folder source of
 * the workspace, `preparing` (the incarnation reset it), at the revision the share was prepared from; it is then
 * acknowledged `ready` under the incarnation's CURRENT epoch. At most 12 (the contract's share limit), no repeats. Any
 * refusal throws typed and the host faults the boot, and nothing is acknowledged (all or nothing).
 */
export function coworkAcknowledgeMountedShares(records: Pick<CoworkRepository, "refreshEpoch" | "acknowledgeMountedShares">, context: CoworkGuestConversationContext, mounted: readonly CoworkMountedShare[]): void {
  if (!Array.isArray(mounted) || mounted.length < 1 || mounted.length > 12 || new Set(mounted.map(share => share?.sourceId)).size !== mounted.length) throw new CoworkError("invalid_request");
  for (const share of mounted) {
    if (!share || typeof share.sourceId !== "string" || !Number.isSafeInteger(share.revision) || share.revision < 1) throw new CoworkError("invalid_request");
  }
  // All or nothing: the repository validates every entry, then acknowledges them in one transaction.
  records.acknowledgeMountedShares(records.refreshEpoch(context.workspaceId, context.incarnationId, context.leaseEpoch), mounted.map(share => ({ sourceId: share.sourceId, revision: share.revision })));
}

const unsupported = (): never => { throw new CoworkError("unsupported_topology"); };
const shutdownRefusal = (): WinterLegRefusal => new WinterLegRefusal("daemon_shutting_down", "Winter is shutting down; no session can start now");

/** A guest permission answer in the host-query profile's closed shape: `{behavior: "allow", updatedInput}` or
 *  `{behavior: "deny", message, interrupt?}`. Saved-rule updates and decision classifications never reach the guest. */
export function coworkGuestPermissionAnswer(result: PermissionResult | null | undefined, input: Record<string, unknown>): PermissionResult {
  if (result && result.behavior === "allow") {
    const updated = result.updatedInput;
    return { behavior: "allow", updatedInput: updated !== null && typeof updated === "object" && !Array.isArray(updated) ? updated : input };
  }
  const message = result && result.behavior === "deny" && typeof result.message === "string" ? result.message : "This action was not approved.";
  const interrupt = result && result.behavior === "deny" && typeof result.interrupt === "boolean" ? { interrupt: result.interrupt } : {};
  return { behavior: "deny", message, ...interrupt };
}

/** Refuses what the host-query guest would refuse by ending its runtime: a slash command, an image, a file. */
function guestText(text: string, images?: readonly unknown[], files?: readonly unknown[]): void {
  if (typeof text !== "string" || text.trimStart().startsWith("/") || (images?.length ?? 0) > 0 || (files?.length ?? 0) > 0) throw new CoworkError("invalid_request");
}

interface Admitted { readonly binding: CoworkConversation; readonly source: WorkspaceSource | undefined; readonly ceiling: CapabilityCeiling; readonly context: CoworkGuestConversationContext; readonly conversation: CoworkGuestConversation }

interface Entry {
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly session: WinterSession;
  readonly handle: CoworkLegSession;
  run: CoworkGuestRun | undefined;
  closed: boolean;
  /** The incarnation's one start was attempted (the options thunk ran). */
  consumed: boolean;
  stop(reason: "user" | "shutdown"): Promise<CoworkGuestStopOutcome | undefined>;
}

export function createCoworkSessionDrivers(deps: CoworkSessionDriverDeps): CoworkSessionDrivers {
  const entries = new Map<string, Entry>();
  const log = deps.log ?? (() => {});
  const sdkQuery = deps.query ?? agentQuery;
  let shuttingDown = false;

  const close = (entry: Entry): void => {
    if (entry.closed) return;
    entry.closed = true;
    if (entries.get(entry.sessionId) === entry) entries.delete(entry.sessionId);
  };

  const assemble = (sessionId: string, binding: CoworkConversation, route: CoworkProviderRoute, native: CoworkGuestStarter, offer: CoworkGuestRuntimeOffer, approvals: CoworkApprovalPort,
    resume?: { readonly backendSessionId: string; readonly plan: CoworkResumePlan }): Entry => {
    // A resumed conversation keeps its recorded backend identity (its guest store is keyed by it); a fresh one mints one.
    const backendSessionId = resume?.backendSessionId ?? (deps.mintBackendSessionId ?? randomUUID)();
    let liveQuery: unknown;
    /** N4 rule 1: the verbs bind to the epoch only once `system/held_inputs` was reconciled (`heldInput.reconcile`). */
    let heldReconciled = false, heldReconciling = false;
    const turnOrigin = () => turnOriginIndexFor(deps.hub, deps.store).origin(sessionId);
    let bridge: (CanUseTool & { withdrawPending(callId: string): boolean }) | undefined;
    let stopping: Promise<CoworkGuestStopOutcome | undefined> | undefined;
    const stopRun = (reason: "user" | "shutdown"): Promise<CoworkGuestStopOutcome | undefined> => {
      const run = entry.run;
      if (run === undefined) return Promise.resolve(undefined);
      stopping ??= run.stop(reason).catch((error: unknown) => { log(`cowork ${sessionId}: stop failed (${error instanceof Error ? error.name : "unknown"})`); return undefined; });
      return stopping;
    };

    /** A start that failed before the guest received the set leaves the conversation startable: this driver closes, so a
     *  new `ensure` builds a fresh one. After the set was received (the backend identity is recorded) it never starts again. */
    const start = async (abort: AbortController): Promise<Options> => {
      try { return await startOnce(abort); }
      catch (error) {
        let assigned = true;
        try { assigned = deps.records.conversationBackend(sessionId) !== null; } catch { /* unreadable: keep it consumed */ }
        // A failed resume closes too: the next `ensure` plans the resume again from the records.
        if (!assigned || resume !== undefined) close(entry);
        throw error;
      }
    };
    const startOnce = async (abort: AbortController): Promise<Options> => {
      if (entry.consumed || entry.closed) throw new CoworkError("cold_resume_unavailable");
      entry.consumed = true;
      if (shuttingDown) throw shutdownRefusal();
      let admitted: Admitted | undefined, refusal: unknown;
      let resumeOption = false;
      const conversations = (context: CoworkGuestConversationContext) => {
        try {
          // A refused `shares_mounted` faulted this boot: no set follows it.
          if (refusal !== undefined) throw refusal;
          if (admitted !== undefined) throw new CoworkError("recovery_required");
          if (context.workspaceId !== binding.workspaceId) throw new CoworkError("authority_denied");
          // D3b: either location; the source facts are compared only for a source conversation.
          const current = deps.records.conversation(sessionId);
          if (current.workspaceId !== binding.workspaceId || current.location !== binding.location || current.revision !== binding.revision
            || (current.location === "source" && binding.location === "source" && current.sourceId !== binding.sourceId)) throw new CoworkError("stale_acknowledgment");
          // L8: `lost` is terminal. The store state may have changed since `ensure` planned this start (the host marks it
          // lost during the native start: a format-new plan over a started store); the plan must still hold at the set.
          const stateNow = deps.records.storeState(sessionId).storeState;
          if (stateNow === "lost") throw new CoworkError("cold_resume_unavailable");
          if (resume !== undefined && coworkContinuationFor(stateNow) !== resume.plan.continuation) throw new CoworkError("cold_resume_unavailable");
          const epoch = deps.records.refreshEpoch(context.workspaceId, context.incarnationId, context.leaseEpoch);
          const source = current.location === "source" ? deps.authority.requireSource(current.workspaceId, current.sourceId) : undefined;
          const ceiling = current.location === "source" ? deps.authority.effectiveCapabilities(sessionId) : coworkConversationCeiling(deps.records, sessionId);
          // L7: the conversation's stable uids, allocated once through the uid table (the same pair on every incarnation).
          const uids = deps.records.allocateGuestUids(sessionId, COWORK_GUEST_IDENTITIES.workspaceGid);
          const set = coworkConversationFor({
            binding: current, ...(source === undefined ? {} : { source }), context, configRevision: epoch.configRevision, grantRevision: epoch.grantRevision,
            policyRevision: deps.records.policy(current.workspaceId).revision, homeId: deps.records.homeIdentity(), backendSessionId,
            offered: coworkGuestOfferedTools(current.policy, ceiling, offer.readiness), route, uids,
          });
          // The guest creates its store when it receives this set: from here on the conversation can never start fresh.
          // Write-ahead (N3): the store state becomes `started`, with the incarnation that received it.
          deps.records.assignConversationBackend(sessionId, backendSessionId, context.incarnationId);
          admitted = { binding: current, source, ceiling, context, conversation: set.conversations[0]! };
          return set;
        } catch (error) { refusal = error; throw error; }
      };
      // #92 N2: shares are acknowledged at `shares_mounted`, which precedes the set; never after it.
      const sharesMounted = (context: CoworkGuestConversationContext, mounted: readonly CoworkMountedShare[]) => {
        try {
          if (admitted !== undefined) throw new CoworkError("recovery_required");
          if (context.workspaceId !== binding.workspaceId) throw new CoworkError("authority_denied");
          coworkAcknowledgeMountedShares(deps.records, context, mounted);
        } catch (error) { refusal = error; throw error; }
      };
      let run: CoworkGuestRun;
      try { run = await native.start(binding.workspaceId, { conversations, sharesMounted, ...(resume === undefined ? {} : { resume: resume.plan }) }); }
      catch (error) { throw refusal ?? error; }
      entry.run = run;
      void run.ended.then(() => { close(entry); void entry.session.end(); }, () => { close(entry); void entry.session.end(); });
      const refuse = async (code: ConstructorParameters<typeof CoworkError>[0]): Promise<never> => { await stopRun("user"); throw new CoworkError(code); };
      if (admitted === undefined) return refuse("recovery_required");
      if (run.workspaceId !== binding.workspaceId || run.incarnationId !== admitted.context.incarnationId || run.leaseEpoch !== admitted.context.leaseEpoch || run.guestBootId !== admitted.context.guestBootId) return refuse("authority_denied");
      // CR2: the query's `resume` follows what the guest actually took. `resume` is known to exist; `either` needs the
      // guest's echo (no echo is refused, never guessed); a fresh start never meets an existing store.
      const echo = run.continuation;
      if (echo !== undefined && echo !== "fresh" && echo !== "resume") return refuse("recovery_required");
      if (resume === undefined) { if (echo === "resume") return refuse("recovery_required"); }
      else if (resume.plan.continuation === "resume") { if (echo === "fresh") return refuse("recovery_required"); resumeOption = true; }
      else if (resume.plan.continuation === "either") { if (echo === undefined) return refuse("recovery_required"); resumeOption = echo === "resume"; }
      else if (echo === "resume") return refuse("recovery_required");
      const ports: CoworkHostApprovalPorts = coworkApprovalPortsFor({ binding: admitted.binding, ...(admitted.source === undefined ? {} : { source: admitted.source }), ceiling: admitted.ceiling });
      bridge = approvals.canUseToolFor({ sessionId, binding: admitted.binding, policyRevision: deps.records.policy(binding.workspaceId).revision, cowork: ports,
        cwd: admitted.conversation.roots[0]!.guestPath, turnOrigin,
        emit: (event: NewSessionEvent) => { deps.hub.append(sessionId, event); } });
      const answer = bridge;
      const canUseTool: CanUseTool = async (toolName, input, ctx) => coworkGuestPermissionAnswer(await answer(toolName, input, ctx), input);
      const supervisor = new CoworkGuestRuntimeSupervisor({
        records: deps.records, authority: deps.authority,
        // `resume` only when the store is known to exist; `either` lets the guest decide from its own store (CR2).
        identity: () => ({ backendSessionId, model: route.model, resume: resumeOption }),
        bootId: () => run.guestBootId,
        runtimeCapability: offer.runtimeCapability, readiness: offer.readiness,
        port: { open: launch => coworkGuestRuntimeChannel({ link: run.runtime(0), launch, stop: () => { void stopRun(shuttingDown ? "shutdown" : "user"); } }) },
      });
      let options: Options;
      try { options = buildCoworkGuestQueryOptions(supervisor, sessionId, { canUseTool, abortController: abort, stderr: () => {} }); }
      catch (error) { await stopRun("user"); throw error; }
      // The host launch and the guest's own config are two descriptions of one runtime: they must agree, or nothing runs.
      const conversation = admitted.conversation, runtime = conversation.runtime!;
      const tools = [...(options.tools as string[])].sort().join(), guestTools = coworkGuestToolsFromClasses(runtime.toolClasses).sort().join();
      if (options.cwd !== conversation.roots[0]!.guestPath || tools !== guestTools || options.model !== runtime.model
        || options.permissionMode !== COWORK_GUEST_RUNTIME_MODES[conversation.policy as keyof typeof COWORK_GUEST_RUNTIME_MODES]
        || options.allowDangerouslySkipPermissions !== false || options.permissions?.disableBypassPermissionsMode !== true) return refuse("stale_acknowledgment");
      return options;
    };

    let claimedInBatch = 0;
    const projectorFor = (inc: WinterIncarnation): Projector => createProjector({
      sessionId, mode: "cowork", generation: inc.generation, winterSessionId: sessionId, runtimeKind: "winter-agent",
      nextSeq: () => deps.store.lastSeq(sessionId) + (++claimedInBatch),
      onToolResults: callIds => { for (const callId of callIds) bridge?.withdrawPending(callId); },
      checkpoint: deps.checkpoints,
      now: () => new Date().toISOString(),
      log: { warn: (message, fields) => log(`${message} ${fields === undefined ? "" : JSON.stringify(fields)}`.trim()) },
    });
    const reconcileHeldInputs = (message: unknown): void => {
      const gate = deps.heldInput;
      if (gate === undefined || heldReconciling || heldReconciled) return; // emitted once; a repeat changes nothing
      heldReconciling = true;
      void (async () => {
        try {
          const inputs = coworkHeldInputsFrom(message);
          const epoch = handle.coworkEpoch;
          if (inputs === undefined || epoch === undefined) throw new CoworkError("recovery_required");
          await gate.reconcile(inputs, epoch);
          if (handle.coworkEpoch?.incarnationId === epoch.incarnationId && handle.coworkEpoch.leaseEpoch === epoch.leaseEpoch) heldReconciled = true;
        } catch (error) { log(`cowork ${sessionId}: held inputs not reconciled (${error instanceof Error ? error.name : "unknown"})`); }
      })();
    };
    // Only the agent SDK's own `query` (the runtime process is the guest's); no router selection, run home or messaging.
    const runtime = { sdk: { query: (input: Parameters<typeof agentQuery>[0]) => { const q = sdkQuery(input); liveQuery = q; return deps.heldInput?.enabled === true ? coworkTapHeldInputs(q, reconcileHeldInputs) : q; } }, trackQuery: () => {}, untrack: () => {} } as unknown as WinterRuntimeSdk;
    const sessionDeps: WinterSessionDeps = {
      sessionId, backendSessionId, mode: "cowork", runtime,
      options: ({ abort }) => start(abort),
      spawnRefusal: () => (shuttingDown ? shutdownRefusal() : undefined),
      endedWhileOpeningRefusal: () => new CoworkError("cold_resume_unavailable"),
      projector: projectorFor,
      append: event => {
        const stamped = deps.hub.append(sessionId, event); claimedInBatch = 0;
        // N3: the first completed turn proves the guest store exists (`started` -> `created`). Best effort: a failure leaves
        // `started`, whose continuation (`either`) is still safe.
        if (event.type === "turn_completed" && event.stopReason === "end_turn") { try { deps.records.markStoreCreated(sessionId); } catch (error) { log(`cowork ${sessionId}: store state not recorded (${error instanceof Error ? error.name : "unknown"})`); } }
        return stamped;
      },
      broadcast: event => { deps.hub.broadcastTransient(sessionId, event); },
      ...(deps.sessionRecords === undefined ? {} : { records: deps.sessionRecords }),
      hasTranscript: () => false,
      logFacts: () => { const events = deps.store.read(sessionId); return { unconsumed: unconsumedUserMessages(events), danglingTurn: mainTurnOpenInLog(events) }; },
      idleTimeoutMs: () => Number.POSITIVE_INFINITY,
      ...(deps.endGraceMs === undefined ? {} : { endGraceMs: deps.endGraceMs }),
      log,
    };
    const session = startWinterSession(sessionDeps);
    /** A conversation whose one incarnation was consumed and is not live has nothing to append to: refuse before the log. */
    const usable = (): void => {
      if (entry.closed || (entry.consumed && session.state !== "live")) throw new CoworkError("cold_resume_unavailable");
    };
    const handle: CoworkLegSession = {
      sessionId, backendSessionId, mode: "cowork",
      get coworkEpoch() { const run = entry.run; return run === undefined || entry.closed ? undefined : { incarnationId: run.incarnationId, leaseEpoch: run.leaseEpoch }; },
      get state() { return entry.closed ? "ended" : session.state; },
      get generation() { return session.generation; },
      get resumed() { return resume !== undefined; },
      get init() { return session.init; },
      get turnRunning() { return session.turnRunning; },
      get turnStartedAt() { return session.turnStartedAt; },
      get done() { return session.done; },
      get pendingSends() { return session.pendingSends; },
      get heldDeliveries() { return session.heldDeliveries; },
      foldsQueuedInput: false,
      async send(text, clientName, images, files) { guestText(text, images, files); usable(); return session.send(text, clientName); },
      async steer(text, clientName, images, files) { guestText(text, images, files); usable(); return session.steer(text, clientName); },
      // The host SDK's interrupt carries `{scope: "turn"}`, which the host-query guest refuses (it takes an empty payload).
      interrupt: async () => unsupported(),
      compact: async () => unsupported(),
      setModel: async () => unsupported(),
      // A policy change needs the transition machine's close/drain/install in the guest; no slice provides it yet.
      setPolicy: async () => unsupported(),
      async end() { await entry.stop("user"); },
      deliver(text) { guestText(text); usable(); session.deliver(text); },
      async open() { if (entry.closed) throw new CoworkError("cold_resume_unavailable"); await session.open(); },
      idle: () => session.idle(),
      // N4: only with the host's gate AND a runtime that offered `held-input-v1`; bound to the incarnation that is live.
      ...(deps.heldInput?.enabled === true && coworkOffersHeldInput(offer.runtimeCapability)
        ? { heldInput: coworkHeldInputVerbs(() => (entry.closed || session.state !== "live" ? undefined : liveQuery), () => (heldReconciled ? handle.coworkEpoch : undefined)) } : {}),
    };
    const entry: Entry = {
      sessionId, workspaceId: binding.workspaceId, session, handle, run: undefined, closed: false, consumed: false,
      async stop(reason) {
        try { await session.end(); } catch (error) { log(`cowork ${sessionId}: end failed (${error instanceof Error ? error.name : "unknown"})`); }
        const outcome = await stopRun(reason);
        close(entry);
        return outcome;
      },
    };
    return entry;
  };

  const ensure = async (sessionId: string): Promise<CoworkLegSession> => {
    const live = entries.get(sessionId);
    if (live !== undefined && !live.closed) return live.handle;
    if (shuttingDown) throw shutdownRefusal();
    const { route, native, offer, approvals } = deps;
    if (route === undefined || native === undefined || offer === undefined || approvals === undefined) throw new CoworkError("provider_unavailable");
    // D3b: either location (O1's outputs conversation included). Other lanes' readers keep `binding()`, which refuses outputs.
    const binding = deps.records.conversation(sessionId);
    if (binding.state !== "active") throw new CoworkError("authority_denied");
    // N3: a recorded backend means a guest store may exist. Without the cold-resume gate it never starts again; with it,
    // the records decide the continuation (a lost store refuses).
    const recorded = deps.records.conversationBackend(sessionId);
    let resume: { backendSessionId: string; plan: CoworkResumePlan } | undefined;
    if (recorded !== null) {
      if (deps.coldResume?.ownerPatchApplied !== true) throw new CoworkError("cold_resume_unavailable");
      resume = { backendSessionId: recorded, plan: coworkResumePlan(deps.records, sessionId) };
    }
    const workspace = deps.records.get(binding.workspaceId);
    if (workspace.power === "uncertain") throw new CoworkError("recovery_required");
    // N2: one host-query conversation per guest, and the guest's set is sent once per incarnation.
    if (workspace.power !== "stopped" || [...entries.values()].some(entry => !entry.closed && entry.workspaceId === binding.workspaceId)) throw new CoworkError("conversation_limit");
    const entry = assemble(sessionId, binding, route, native, offer, approvals, resume);
    entries.set(sessionId, entry);
    return entry.handle;
  };

  return {
    get: sessionId => { const entry = entries.get(sessionId); return entry === undefined || entry.closed ? undefined : entry.handle; },
    ensure,
    async runTurn(sessionId, text, clientName) {
      const session = await ensure(sessionId);
      await session.open();
      await session.send(text, clientName);
      await session.idle();
    },
    async evict(sessionId) {
      const entry = entries.get(sessionId);
      if (entry !== undefined) await entry.stop("user");
    },
    list: () => [...entries.values()].filter(entry => !entry.closed).map(entry => entry.handle),
    async beginShutdown() {
      shuttingDown = true;
      await Promise.all([...entries.values()].map(entry => entry.stop("shutdown").catch(() => undefined)));
    },
  };
}
