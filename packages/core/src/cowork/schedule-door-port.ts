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
 *   a DEFINITE refusal                             -> not-started (the prompt was never delivered, nothing to replay):
 *       from create/get/ensure: provider_unavailable, conversation_limit, cold_resume_unavailable, unsupported_topology (the door's
 *       own refusals), authority_denied, source_unavailable, not_found
 *       from send: ONLY the four door refusals (the others can race a queued prompt, so they are uncertain there)
 *   anything else (recovery_required, a plain Error, a non-CoworkError, a malformed session) -> uncertain
 *   the injected bound passing (a hung door)      -> uncertain, and a send not yet begun never begins
 * A fresh Project conversation is minted under a requestId derived from the occurrence, so a retry after `not-started`
 * replays the same create and cannot mint a second conversation (the door's idempotency is its own contract).
 */

/** Refusals after which the prompt provably was not delivered, when thrown by create, get or ensure. Everything outside this set is uncertain. */
export const COWORK_SCHEDULE_DEFINITE_REFUSALS: ReadonlySet<CoworkErrorCode> = new Set<CoworkErrorCode>([
  "provider_unavailable", "conversation_limit", "cold_resume_unavailable", "unsupported_topology", "authority_denied", "source_unavailable", "not_found",
]);
/**
 * The ONLY refusals a `send` may throw and still count as "not delivered": the door's four documented pre-delivery refusals. The wider set
 * above can also surface AFTER `send` queued the prompt (an eviction or revocation race: authority_denied, source_unavailable, not_found),
 * and mapping those to not-started would let a retry deliver twice, so at the send stage they are uncertain.
 */
export const COWORK_SCHEDULE_SEND_DEFINITE_REFUSALS: ReadonlySet<CoworkErrorCode> = new Set<CoworkErrorCode>(["provider_unavailable", "conversation_limit", "cold_resume_unavailable", "unsupported_topology"]);
/**
 * Default bound on the whole door interaction (create + ensure + send acceptance). A cold resume may boot a guest, so the bound is generous:
 * two minutes, far above the 30 s graceful-drain budget and any accept-not-await send, yet it frees the job's one active slot (as
 * `uncertain`, never a replay) if the door hangs. Past it the port answers `uncertain` and, if the send has not begun, never begins it.
 */
export const COWORK_SCHEDULE_DOOR_TIMEOUT_MS = 120_000;
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
  /** Injected bound on one `start` (default COWORK_SCHEDULE_DOOR_TIMEOUT_MS): a positive integer up to 2^31 - 1. */
  readonly timeoutMs?: number;
}

export function createCoworkScheduleDoorPort(deps: CoworkScheduleDoorPortDeps): CoworkScheduleDispatchPort {
  const timeoutMs = deps.timeoutMs ?? COWORK_SCHEDULE_DOOR_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2 ** 31 - 1) throw new CoworkError("invalid_request");
  const refused = (error: unknown, definite: ReadonlySet<CoworkErrorCode>): CoworkScheduleStartResult => error instanceof CoworkError && definite.has(error.code) ? { kind: "not-started" } : { kind: "uncertain" };
  return {
    async start(input, token) {
      const { schedule, occurrence } = input, target = schedule.definition.target;
      // Set once the bound has passed: a late-resolving create/ensure must not go on to deliver a prompt the host already recorded as uncertain.
      let abandoned = false, timer: ReturnType<typeof setTimeout> | undefined;
      const attempt = async (): Promise<CoworkScheduleStartResult> => {
        let sessionId: string;
        let session: Awaited<ReturnType<CoworkScheduleDoor["drivers"]["ensure"]>>;
        try {
          if (target.kind === "conversation") sessionId = target.sessionId;
          else sessionId = (await deps.door.create({ scope: deps.scope, workspaceId: schedule.workspaceId, requestId: `schedule:${occurrence.occurrenceId}`, location: { kind: "source", sourceId: schedule.definition.sourceId } }, deps.caller)).sessionId;
          if (typeof sessionId !== "string" || !RUN_REF.test(sessionId)) return { kind: "not-started" }; // nothing sent yet, and no receipt could name it
          session = deps.door.drivers.get(sessionId) ?? await deps.door.drivers.ensure(sessionId);
        } catch (error) { return refused(error, COWORK_SCHEDULE_DEFINITE_REFUSALS); }
        if (abandoned) return { kind: "uncertain" };
        try {
          await session.send(schedule.definition.prompt, "schedule");
        } catch (error) { return refused(error, COWORK_SCHEDULE_SEND_DEFINITE_REFUSALS); }
        return { kind: "started", receipt: { occurrenceId: occurrence.occurrenceId, token, runRef: sessionId } };
      };
      const expired = new Promise<CoworkScheduleStartResult>(resolve => { timer = setTimeout(() => { abandoned = true; resolve({ kind: "uncertain" }); }, timeoutMs); });
      try { return await Promise.race([attempt(), expired]); } finally { clearTimeout(timer); }
    },
  };
}
