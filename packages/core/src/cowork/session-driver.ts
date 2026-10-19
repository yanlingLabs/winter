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
import type { CoworkAuthority } from "./authority";
import { COWORK_GUEST_RUNTIME_MODES, coworkConversationFor, coworkGuestToolsFromClasses } from "./conversation-set";
import { buildCoworkGuestQueryOptions } from "./guest-query";
import { CoworkGuestRuntimeSupervisor, coworkGuestOfferedTools } from "./guest-runtime";
import type { CoworkRepository } from "./repository";
import { coworkGuestRuntimeChannel } from "./runtime-channel";
import type {
  CoworkApprovalPort, CoworkGuestConversation, CoworkGuestConversationContext, CoworkGuestRun, CoworkGuestRuntimeOffer, CoworkGuestStarter,
  CoworkGuestStopOutcome, CoworkLegSession, CoworkProviderRoute, CoworkSessionDrivers,
} from "./session-ports";
import { CoworkError, type CapabilityCeiling, type ConversationBinding, type WorkspaceSource } from "./types";

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

interface Admitted { readonly binding: ConversationBinding; readonly source: WorkspaceSource; readonly ceiling: CapabilityCeiling; readonly context: CoworkGuestConversationContext; readonly conversation: CoworkGuestConversation }

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

  const assemble = (sessionId: string, binding: ConversationBinding, route: CoworkProviderRoute, native: CoworkGuestStarter, offer: CoworkGuestRuntimeOffer, approvals: CoworkApprovalPort): Entry => {
    const backendSessionId = (deps.mintBackendSessionId ?? randomUUID)();
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
        if (!assigned) close(entry);
        throw error;
      }
    };
    const startOnce = async (abort: AbortController): Promise<Options> => {
      if (entry.consumed || entry.closed) throw new CoworkError("cold_resume_unavailable");
      entry.consumed = true;
      if (shuttingDown) throw shutdownRefusal();
      let admitted: Admitted | undefined, refusal: unknown;
      const conversations = (context: CoworkGuestConversationContext) => {
        try {
          if (admitted !== undefined) throw new CoworkError("recovery_required");
          if (context.workspaceId !== binding.workspaceId) throw new CoworkError("authority_denied");
          const current = deps.records.binding(sessionId);
          if (current.workspaceId !== binding.workspaceId || current.sourceId !== binding.sourceId || current.revision !== binding.revision) throw new CoworkError("stale_acknowledgment");
          const epoch = deps.records.refreshEpoch(context.workspaceId, context.incarnationId, context.leaseEpoch);
          const source = deps.authority.requireSource(current.workspaceId, current.sourceId);
          const ceiling = deps.authority.effectiveCapabilities(sessionId);
          const set = coworkConversationFor({
            binding: current, source, context, configRevision: epoch.configRevision, grantRevision: epoch.grantRevision,
            policyRevision: deps.records.policy(current.workspaceId).revision, homeId: deps.records.homeIdentity(), backendSessionId,
            offered: coworkGuestOfferedTools(current.policy, ceiling, offer.readiness), route,
          });
          // The guest creates its store when it receives this set: from here on the conversation can never start fresh.
          deps.records.assignConversationBackend(sessionId, backendSessionId);
          admitted = { binding: current, source, ceiling, context, conversation: set.conversations[0]! };
          return set;
        } catch (error) { refusal = error; throw error; }
      };
      let run: CoworkGuestRun;
      try { run = await native.start(binding.workspaceId, { conversations }); }
      catch (error) { throw refusal ?? error; }
      entry.run = run;
      void run.ended.then(() => { close(entry); void entry.session.end(); }, () => { close(entry); void entry.session.end(); });
      const refuse = async (code: ConstructorParameters<typeof CoworkError>[0]): Promise<never> => { await stopRun("user"); throw new CoworkError(code); };
      if (admitted === undefined) return refuse("recovery_required");
      if (run.workspaceId !== binding.workspaceId || run.incarnationId !== admitted.context.incarnationId || run.leaseEpoch !== admitted.context.leaseEpoch || run.guestBootId !== admitted.context.guestBootId) return refuse("authority_denied");
      const ports: CoworkHostApprovalPorts = coworkApprovalPortsFor({ binding: admitted.binding, source: admitted.source, ceiling: admitted.ceiling });
      bridge = approvals.canUseToolFor({ sessionId, binding: admitted.binding, policyRevision: deps.records.policy(binding.workspaceId).revision, cowork: ports,
        cwd: admitted.conversation.roots[0]!.guestPath, turnOrigin,
        emit: (event: NewSessionEvent) => { deps.hub.append(sessionId, event); } });
      const answer = bridge;
      const canUseTool: CanUseTool = async (toolName, input, ctx) => coworkGuestPermissionAnswer(await answer(toolName, input, ctx), input);
      const supervisor = new CoworkGuestRuntimeSupervisor({
        records: deps.records, authority: deps.authority,
        identity: () => ({ backendSessionId, model: route.model, resume: false }),
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
    // Only the agent SDK's own `query` (the runtime process is the guest's); no router selection, run home or messaging.
    const runtime = { sdk: { query: (input: Parameters<typeof agentQuery>[0]) => sdkQuery(input) }, trackQuery: () => {}, untrack: () => {} } as unknown as WinterRuntimeSdk;
    const sessionDeps: WinterSessionDeps = {
      sessionId, backendSessionId, mode: "cowork", runtime,
      options: ({ abort }) => start(abort),
      spawnRefusal: () => (shuttingDown ? shutdownRefusal() : undefined),
      endedWhileOpeningRefusal: () => new CoworkError("cold_resume_unavailable"),
      projector: projectorFor,
      append: event => { const stamped = deps.hub.append(sessionId, event); claimedInBatch = 0; return stamped; },
      broadcast: event => { deps.hub.broadcastTransient(sessionId, event); },
      messaging: { attach: unsupported as unknown as WinterSessionDeps["messaging"]["attach"] },
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
      get resumed() { return false; },
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
    if (deps.records.conversationLocation(sessionId) !== "source") throw new CoworkError("unsupported_topology");
    const binding = deps.records.binding(sessionId);
    if (binding.state !== "active") throw new CoworkError("authority_denied");
    if (deps.records.conversationBackend(sessionId) !== null) throw new CoworkError("cold_resume_unavailable");
    const workspace = deps.records.get(binding.workspaceId);
    if (workspace.power === "uncertain") throw new CoworkError("recovery_required");
    // N2: one host-query conversation per guest, and the guest's set is sent once per incarnation.
    if (workspace.power !== "stopped" || [...entries.values()].some(entry => !entry.closed && entry.workspaceId === binding.workspaceId)) throw new CoworkError("conversation_limit");
    const entry = assemble(sessionId, binding, route, native, offer, approvals);
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
