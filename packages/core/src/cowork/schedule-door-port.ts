import type { CoworkScheduleDispatchPort, CoworkScheduleStartResult } from "./schedule-dispatch";
import type { CoworkConnection } from "./service";
import type { CoworkSessionCreateInput, CoworkSessionDrivers } from "./session-ports";
import { CoworkError, type CoworkErrorCode } from "./types";

/*
 * Schedule dispatch port over the Cowork session door (SOURCE ONLY).
 *
 * It asks the door for the least it needs, a structural slice (`CoworkScheduleDoor`): `create`, and the drivers' `get` and `ensure`.
 * The real door satisfies it; the door lane's source pin keeps that type's own name out of every module but its own.
 *
 * Nothing under src/ imports this module and no production code constructs it: CoworkSchedules is built without a port
 * (service.ts), so the host dispatch entry still refuses `unsupported_topology`, and `session.create {mode: "cowork"}` still answers
 * `unsupported_topology` because no session door is passed to startIpcServer. A test with a fake door proves the mapping;
 * it proves no guest ran. The door arrives by injection.
 *
 * One occurrence = one prompt delivered to one conversation:
 *   conversation target: drivers.get(sessionId) ?? drivers.ensure(sessionId), then send(prompt, "schedule");
 *   project target:      door.create({...requestId: "schedule:<occurrenceId>"}), then ensure, then send.
 * The send is accepted-not-awaited: this port never waits for the turn (the host keeps the occurrence `dispatching`).
 * `queued: true` (the conversation was mid-turn) still counts as accepted.
 *
 * OUTCOME MAP (the host treats a THROW as uncertain, so every answer is returned, never thrown):
 *   send accepted                                  -> started, runRef = the conversation's session id
 *   a DEFINITE refusal from create/get/ensure/send -> not-started (the prompt was never delivered, nothing to replay):
 *       provider_unavailable, conversation_limit, cold_resume_unavailable, unsupported_topology (the door's own refusals),
 *       authority_denied, source_unavailable, not_found
 *   anything else (recovery_required, a plain Error, a non-CoworkError, a malformed session) -> uncertain
 * A fresh Project conversation is minted under a requestId derived from the occurrence, so a retry after `not-started`
 * replays the same create and cannot mint a second conversation (the door's idempotency is its own contract).
 */

/** Refusals after which the prompt provably was not delivered. Everything outside this set is uncertain. */
export const COWORK_SCHEDULE_DEFINITE_REFUSALS: ReadonlySet<CoworkErrorCode> = new Set<CoworkErrorCode>([
  "provider_unavailable", "conversation_limit", "cold_resume_unavailable", "unsupported_topology", "authority_denied", "source_unavailable", "not_found",
]);
/** The host's run-reference shape (schedules.ts). A session id outside it cannot be acknowledged, so it is refused BEFORE the send. */
const RUN_REF = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

export interface CoworkScheduleDoor {
  create(input: CoworkSessionCreateInput, caller: CoworkConnection): Promise<{ sessionId: string }>;
  readonly drivers: Pick<CoworkSessionDrivers, "get" | "ensure">;
}
export interface CoworkScheduleDoorPortDeps {
  readonly door: CoworkScheduleDoor;
  /** The session-store scope fresh Project conversations are minted under. */
  readonly scope: string;
  /** Host-internal caller identity the door authorizes a create against. Injected; never built from a schedule's content. */
  readonly caller: CoworkConnection;
}

export function createCoworkScheduleDoorPort(deps: CoworkScheduleDoorPortDeps): CoworkScheduleDispatchPort {
  const refused = (error: unknown): CoworkScheduleStartResult => error instanceof CoworkError && COWORK_SCHEDULE_DEFINITE_REFUSALS.has(error.code) ? { kind: "not-started" } : { kind: "uncertain" };
  return {
    async start(input, token) {
      const { schedule, occurrence } = input, target = schedule.definition.target;
      let sessionId: string;
      let session: Awaited<ReturnType<CoworkScheduleDoor["drivers"]["ensure"]>>;
      try {
        if (target.kind === "conversation") sessionId = target.sessionId;
        else sessionId = (await deps.door.create({ scope: deps.scope, workspaceId: schedule.workspaceId, requestId: `schedule:${occurrence.occurrenceId}`, location: { kind: "source", sourceId: schedule.definition.sourceId } }, deps.caller)).sessionId;
        if (typeof sessionId !== "string" || !RUN_REF.test(sessionId)) return { kind: "not-started" }; // nothing sent yet, and no receipt could name it
        session = deps.door.drivers.get(sessionId) ?? await deps.door.drivers.ensure(sessionId);
      } catch (error) { return refused(error); }
      try {
        await session.send(schedule.definition.prompt, "schedule");
      } catch (error) { return refused(error); }
      return { kind: "started", receipt: { occurrenceId: occurrence.occurrenceId, token, runRef: sessionId } };
    },
  };
}
