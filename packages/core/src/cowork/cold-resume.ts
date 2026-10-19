import type { CoworkRepository } from "./repository";
import { CoworkError } from "./types";

/*
 * #92 N3, cold resume (design section 3.2, CR4): the HOST's decision about how a conversation whose guest store may exist
 * starts in a new incarnation. Records only decide it; the guest never does.
 *
 *   store_state   continuation   meaning
 *   none          fresh          no guest ever received the set: the store cannot exist
 *   started       either         the set was sent (write-ahead) but no turn completed: the store may or may not exist
 *   created       resume         a turn completed: the store exists and must be resumed, never replaced
 *   lost          (refused)      the store is gone: the conversation never resumes and never starts fresh under its identity
 *
 * GATED OFF. The driver takes this path only when a host supplies `CoworkSessionDriverDeps.coldResume`, and no production
 * composition does (pinned structurally, like the provisioning port). The unmodified native owner refuses a resume record
 * (it requires `freshOnly: true`) until the owner applies the cold-resume owner patch; the port may be supplied only after
 * that, by the D6 flip. Without the port a conversation with a recorded backend refuses `cold_resume_unavailable`, as before.
 */

export type CoworkContinuation = "fresh" | "resume" | "either";

/** The continuation for a store state; `lost` (or anything unknown) refuses. */
export function coworkContinuationFor(storeState: string): CoworkContinuation {
  switch (storeState) {
    case "none": return "fresh";
    case "started": return "either";
    case "created": return "resume";
    default: throw new CoworkError("cold_resume_unavailable");
  }
}

/** What a resumed start carries to the native host (S7B's contract text version 3 puts it on the conversation's runtime). */
export interface CoworkResumePlan {
  readonly continuation: CoworkContinuation;
  /** The previous incarnation's boot ids whose end the host proved (0 to 4); never this boot's. */
  readonly endedGuestBoots: readonly string[];
}

/** The host's plan for resuming `sessionId`: its store state's continuation, and the proven-ended boots of its last
 *  incarnation. Refuses `cold_resume_unavailable` for a lost store, and `recovery_required` for a started or created store
 *  with no recorded incarnation (the write-ahead record is incomplete). */
export function coworkResumePlan(records: Pick<CoworkRepository, "storeState" | "endedGuestBoots" | "conversationWorkspace">, sessionId: string): CoworkResumePlan {
  const state = records.storeState(sessionId), continuation = coworkContinuationFor(state.storeState);
  if (continuation === "fresh") return Object.freeze({ continuation, endedGuestBoots: Object.freeze([]) });
  if (state.lastIncarnationId === null) throw new CoworkError("recovery_required");
  const workspaceId = records.conversationWorkspace(sessionId);
  if (workspaceId === undefined) throw new CoworkError("not_found");
  return Object.freeze({ continuation, endedGuestBoots: Object.freeze(records.endedGuestBoots(workspaceId, state.lastIncarnationId)) });
}
