import { createHash } from "node:crypto";
import type { ApprovalBroker } from "../agent/approvals";
import type { PermissionGate, SessionApprovalPolicy } from "../agent/gate";
import type { QuestionBroker } from "../agent/questions";
import { canUseToolFor, type BridgeLogger, type CanUseToolDeps } from "../runtime-sdk/approval-bridge";
import type { SessionStore } from "../sessions/store";
import type { CoworkAuthority, CoworkPrincipal } from "./authority";
import type { CoworkRepository } from "./repository";
import { relativeCoworkPath } from "./repository";
import type { CoworkSchedules } from "./schedules";
import type { CoworkConnection } from "./service";
import { createCoworkSessionDrivers, type CoworkSessionDriverDeps } from "./session-driver";
import type { CoworkApprovalPort, CoworkSessionCreateInput, CoworkSessionDoor } from "./session-ports";
import { CoworkError } from "./types";

/*
 * Cowork session door (D4): THE one implementation of `CoworkSessionDoor`, and the one module that names
 * `createCoworkSessionDoor`. Nothing in production calls it: `startIpcServer` routes `session.create {mode: "cowork"}` to a
 * door only when one is passed, and no production caller passes one (design section 6; the D6 flip is a one-line
 * `daemon.ts` change on the owner's word). With no provider route every create refuses `provider_unavailable` before
 * anything is written.
 *
 * CREATE, IN ORDER, EACH STEP RESUMABLE (docs/research/2026-10-18-cowork-session-door-d4.md):
 *   1. authorize the caller (a local user over harness/admin, or the host's own schedule caller, below);
 *   2. reserve: one runtime-state row per (principal, workspace, requestId) holds the session id and the request's digest.
 *      The same request again finds it; a different request under that id is `request_conflict`;
 *   3. the session store row and its seq-1 `session_created`, created or found (`SessionStore.ensureCoworkSession`);
 *   4. the binding, created or found (`CoworkRepository.bindConversation`); then the reservation is marked bound.
 * A crash between any two steps leaves a state the next attempt of the same request resumes from, so a retry never mints a
 * second conversation. A DEFINITE bind refusal (nothing bound) withdraws the store row and then the reservation, so the
 * request starts over cleanly. A race on one request resolves to one conversation: the body runs synchronously (no await,
 * so two creates in this process do not interleave), and even interleaved each step finds what the other wrote.
 */

/**
 * The host's own caller for an unattended scheduled create (the schedule dispatch port). Authority
 * is by REFERENCE IDENTITY only: this frozen object, never its fields. A wire connection is always a fresh object built by
 * the IPC server, so no client can present it, and `host.principal` is never consulted for it. It may create exactly one
 * thing: a Project conversation on a schedule's own source, for an occurrence that schedule is dispatching right now, with
 * `requestId` `schedule:<occurrenceId>` (scoped by `scheduleAuthority` below). Its fixed principal id keys its reservations.
 */
export const COWORK_SCHEDULE_CALLER: CoworkConnection = Object.freeze({ role: "host-schedule", connectionId: -1 });
const SCHEDULE_PRINCIPAL_ID = "host:schedule";
/** `schedule:` + an occurrence id: the repository's id grammar caps a request id at 200 characters, so an occurrence id at 191. */
const SCHEDULE_REQUEST = /^schedule:([A-Za-z0-9][A-Za-z0-9._:-]{0,190})$/;

/** What the schedule caller's authority needs from the schedule service: the dispatching occurrence, its schedule's state,
 *  target and source. Read through the service's public `list`/`status`, never its tables. */
export interface CoworkScheduleDispatchView {
  dispatching(workspaceId: string, occurrenceId: string): { readonly sourceId: string; readonly target: "project" | "conversation" } | undefined;
}
/** The view over `CoworkSchedules`: an enabled schedule of this workspace whose recent occurrences hold `occurrenceId` in
 *  `dispatching`. `status` lists a schedule's 100 newest occurrences; a dispatching one is its newest active occurrence. */
export function coworkScheduleDispatchView(schedules: Pick<CoworkSchedules, "list" | "status">): CoworkScheduleDispatchView {
  return {
    dispatching(workspaceId, occurrenceId) {
      let cursor: string | undefined;
      for (let page = 0; page < 100; page++) {
        const { schedules: values, nextCursor } = schedules.list(workspaceId, cursor);
        for (const value of values) {
          if (value.state !== "enabled") continue;
          const status = schedules.status(workspaceId, value.scheduleId);
          if (status.schedule.state !== "enabled") continue;
          if (!status.occurrences.some(occurrence => occurrence.occurrenceId === occurrenceId && occurrence.state === "dispatching")) continue;
          return { sourceId: status.schedule.definition.sourceId, target: status.schedule.definition.target.kind };
        }
        if (nextCursor === null) return undefined;
        cursor = nextCursor;
      }
      return undefined;
    },
  };
}

/**
 * The approval port a door composition supplies (APPROVALS #84's bridge, `mode: "cowork"`): one bridge per incarnation, the
 * conversation's host ports as its `cowork` dependency, so every decision but AskUserQuestion comes from the Cowork host
 * policy matrix. Built by nothing in production (the door is not constructed there).
 */
export function coworkApprovalPort(deps: { readonly approvals: ApprovalBroker; readonly questions: QuestionBroker; readonly gate: PermissionGate; readonly log?: BridgeLogger; readonly coworkBashReview?: CanUseToolDeps["coworkBashReview"] }): CoworkApprovalPort {
  return {
    canUseToolFor: input => canUseToolFor({
      sessionId: input.sessionId, mode: "cowork", policy: input.binding.policy as SessionApprovalPolicy, approvals: deps.approvals, questions: deps.questions, gate: deps.gate,
      cwd: input.cwd, emit: input.emit, turnOrigin: input.turnOrigin, cowork: input.cowork,
      ...(deps.log === undefined ? {} : { log: deps.log }), ...(deps.coworkBashReview === undefined ? {} : { coworkBashReview: deps.coworkBashReview }),
    }),
  };
}

export interface CoworkSessionDoorDeps extends CoworkSessionDriverDeps {
  /** The Cowork host's principal resolver (`CoworkHostPorts.principal`). Never consulted for `COWORK_SCHEDULE_CALLER`. */
  principal(connection: CoworkConnection): CoworkPrincipal | undefined;
  /** The schedule service's view. Absent: the schedule caller is refused like any other unknown caller. */
  readonly schedules?: CoworkScheduleDispatchView;
}

const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const SCOPE = /^[a-z0-9]([a-z0-9-]{0,39}[a-z0-9])?$/;

export function createCoworkSessionDoor(deps: CoworkSessionDoorDeps): CoworkSessionDoor {
  const drivers = createCoworkSessionDrivers(deps);
  const { records, authority, store } = deps;

  /** The schedule caller's whole authority: an enabled schedule of this workspace is dispatching this occurrence, it
   *  targets the Project (a conversation target needs no create), and the location is its own source at its root. */
  const scheduleAuthority = (input: CoworkSessionCreateInput): string => {
    const match = SCHEDULE_REQUEST.exec(input.requestId);
    if (!match || deps.schedules === undefined || input.location.kind !== "source" || input.location.relativeCwd !== undefined) throw new CoworkError("authority_denied");
    // Any failure to establish the window (an unknown workspace or schedule included) is the same refusal: no oracle.
    let dispatching: ReturnType<CoworkScheduleDispatchView["dispatching"]>, project: boolean;
    try { dispatching = deps.schedules.dispatching(input.workspaceId, match[1]!); project = records.get(input.workspaceId).ownership === "project"; }
    catch { throw new CoworkError("authority_denied"); }
    if (dispatching === undefined || !project || dispatching.target !== "project" || dispatching.sourceId !== input.location.sourceId) throw new CoworkError("authority_denied");
    return SCHEDULE_PRINCIPAL_ID;
  };
  /** Everyone else: a local user over a harness or admin connection with member authority. Remote, plugin and runtime
   *  principals cannot create a Cowork conversation (design 1.2: no remote set yet). */
  const userAuthority = (input: CoworkSessionCreateInput, caller: CoworkConnection): string => {
    if (!["harness", "admin"].includes(caller.role)) throw new CoworkError("authority_denied");
    const principal = deps.principal(caller);
    if (!principal || principal.kind !== "local-user") throw new CoworkError("authority_denied");
    authority.requireWorkspace(principal, input.workspaceId, "member");
    return principal.id;
  };

  const create = (input: CoworkSessionCreateInput, caller: CoworkConnection): { sessionId: string } => {
    const route = deps.route;
    if (route === undefined || deps.native === undefined || deps.offer === undefined || deps.approvals === undefined) throw new CoworkError("provider_unavailable");
    if (!SCOPE.test(input.scope) || !ID.test(input.workspaceId) || !ID.test(input.requestId)) throw new CoworkError("invalid_request");
    const principalId = caller === COWORK_SCHEDULE_CALLER ? scheduleAuthority(input) : userAuthority(input, caller);
    // Either location (D3b): a workspace source plus a relative cwd, or the conversation's OWN outputs folder (O1).
    const location: { kind: "source"; sourceId: string; relativeCwd: string } | { kind: "outputs" } = input.location.kind === "outputs"
      ? { kind: "outputs" } : { kind: "source", sourceId: input.location.sourceId, relativeCwd: relativeCoworkPath(input.location.relativeCwd ?? ".") };
    if (location.kind === "source" && !ID.test(location.sourceId)) throw new CoworkError("invalid_request");
    const requestDigest = createHash("sha256").update(canonical({ scope: input.scope, workspaceId: input.workspaceId, location })).digest("hex");

    // 2. Reserve (or find this request's reservation).
    const reservation = records.reserveConversation({ principalId, workspaceId: input.workspaceId, requestId: input.requestId, scope: input.scope, requestDigest }, sessionId => store.hasSession(sessionId));
    const sessionId = reservation.sessionId;
    const boundHere = (): boolean => {
      if (records.conversationWorkspace(sessionId) === undefined) return false;
      const found = records.conversation(sessionId);
      const same = found.location === "outputs" ? location.kind === "outputs"
        : location.kind === "source" && found.sourceId === location.sourceId && found.relativeCwd === location.relativeCwd;
      if (found.workspaceId !== input.workspaceId || !same) throw new CoworkError("request_conflict");
      return true;
    };
    if (boundHere()) { records.completeReservation(sessionId); return { sessionId }; }

    // 3. The store row and its session_created, created or found. Its facts are display only (the binding is authority),
    //    read here from the same workspace the reservation saw; a later policy change can leave them stale.
    const workspace = records.get(input.workspaceId), policy = records.policy(input.workspaceId);
    store.ensureCoworkSession(input.scope, sessionId, {
      approvalPolicy: policy.defaultPolicy as SessionApprovalPolicy, model: route.model,
      cowork: { workspaceId: input.workspaceId, projectId: workspace.ownership === "project" ? workspace.ownerId : null, location: location.kind, sourceId: location.kind === "source" ? location.sourceId : null, policyRevision: policy.revision },
    }, id => records.isReservedSession(id));

    // 4. The binding. Its own idempotency key would carry a revision a landed bind has since advanced, so a landed bind is
    //    found above (`boundHere`), never replayed through it.
    try {
      const context = { principalId, requestId: input.requestId, expectedRevision: workspace.configRevision };
      if (location.kind === "outputs") records.bindOutputsConversation(context, input.workspaceId, { sessionId }, store);
      else records.bindConversation(context, input.workspaceId, { sessionId, sourceId: location.sourceId, relativeCwd: location.relativeCwd }, store);
    } catch (error) {
      let bound: boolean;
      try { bound = boundHere(); } catch { throw error; }
      if (!bound) {
        // Definite: nothing bound. Withdraw the store row, THEN the reservation (a crash between leaves a pending
        // reservation, which the next attempt resumes).
        if (error instanceof CoworkError) { store.withdrawCoworkSession(sessionId, () => records.conversationWorkspace(sessionId) !== undefined); records.withdrawReservation(sessionId); }
        throw error;
      }
    }
    records.completeReservation(sessionId);
    return { sessionId };
  };

  return {
    // Synchronous: no await, so no interleaving with another create in this process.
    create: async (input, caller) => create(input, caller),
    drivers,
  };
}
