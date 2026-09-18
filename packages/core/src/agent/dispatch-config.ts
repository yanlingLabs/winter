import type { Settings } from "../settings";
import { effortToSpendForRole, pinsFor, roleEffortFor } from "../settings";
import { implicitEffortFor } from "../runtime-sdk/provider-selection";

/** session-activity-hygiene task 1: dispatch's model and reasoning effort are a FIXED PIN, not a
 *  per-session choice — a user ruling, the same shape as `RESEARCH_MODEL`/`RESEARCH_EFFORT`
 *  (research.ts): dispatch is the user's ambient coordinator on this Mac, not a conversation
 *  someone tunes turn by turn, so there is no picker for it to answer to.
 *
 *  Enforced in TWO independent layers (the `ultra`-tier pattern, provider-correctness T5):
 *   1. The spawn boundary — `session-driver.ts`'s `optionsFor`, the `mode === "dispatch"` arm (the
 *      retired `AgentEngine.resolveSel`'s successor): a dispatch session resolves to the live pin
 *      and `dispatchEffortFor` below, never to the daemon's default model or default effort. A
 *      value already in the session's own `meta.model`/`meta.effort` still wins there — no RPC door
 *      can write one (layer 2), so that is reachable only by a harness driving the store directly.
 *   2. `session.setModel` / `session.setEffort` (ipc/server.ts) refuse a dispatch-mode target
 *      OUTRIGHT, before their own resolution/validation helpers (`resolveModelSelection`,
 *      `assertEffortSelectable`) even run — the door, so the daemon never even stores an override
 *      nobody will ever honor.
 *
 *  WS-20: the MODEL half is no longer a hardcoded constant — it is `pinsFor(settings).dispatch`,
 *  a tag that DEFAULTS from `settings.provider.model`'s own provider (see `pinsFor` in
 *  settings.ts) and is user-overridable per `settings.pins.dispatch`. 2026-09-18: the EFFORT half
 *  followed — `DISPATCH_EFFORT` is now the DEFAULT, overridable per `settings.roleEfforts` (see
 *  `dispatchEffortFor` below). It is still an ordinary `REASONING_EFFORTS` member, a real wire
 *  effort and not a client-side tier like `ultra`; it needs no translation. */
export const DISPATCH_EFFORT = "medium";

/**
 * 2026-09-18: the effort a DISPATCH-MODE session is spawned with — `settings.roleEfforts["pins.dispatch"]`
 * when the user stored one (the Roles pane), else `DISPATCH_EFFORT` exactly as before. Either way it is
 * mapped onto `model`'s own catalog row and is never a refusal: the default goes through
 * `implicitEffortFor` as it has since 2026-09-17, the stored one through `effortToSpendForRole`'s rules
 * (settings.ts — the ONE resolver; this function only supplies dispatch's default to it).
 *
 * `DISPATCH_EFFORT` therefore stopped being "the" effort and became the DEFAULT for it, the same move
 * WS-20 made for the model half above. What did NOT change is whose choice it is: still a setting of
 * the coordinator, not of a conversation — `session.setEffort` keeps refusing a dispatch target, and
 * this is read for `mode === "dispatch"` ONLY. The sessions dispatch SPAWNS are `mode: "code"` with
 * `origin: "dispatch-child"`; they never reach this function, and neither does any session of the
 * user's own — their effort is per-session, and this role must not leak onto them.
 *
 * `model` is the tag the session is about to run (normally the live pin; a harness-written
 * `meta.model` when a test drove the store directly), so the mapping is against the row actually
 * spawned. `settings` is the caller's LIVE read — `optionsFor` re-reads it at every incarnation, so a
 * change here applies at the coordinator's next spawn with no daemon restart.
 */
export function dispatchEffortFor(settings: Settings | null | undefined, model: string): string | undefined {
  return effortToSpendForRole(settings, "pins.dispatch", model, implicitEffortFor(model, DISPATCH_EFFORT));
}

/** The one refusal message both doors throw — extracted so the two surfaces cannot drift (same
 *  reasoning as `resolveModelSelection`/`assertEffortSelectable` being shared helpers rather than
 *  two copies). Built from the LIVE pin so it can never name a stale value. */
export function dispatchPinMessage(settings: Settings | null | undefined): string {
  const pin = pinsFor(settings).dispatch;
  // With nothing stored the message names `DISPATCH_EFFORT` verbatim, as it always has. With a stored
  // role effort it names what will actually be SPENT on the live pin (mapped, possibly nothing) — a
  // refusal that quoted "medium" while dispatch ran at the user's own "high" would send them looking
  // in the wrong place.
  const effort = roleEffortFor(settings, "pins.dispatch") === undefined
    ? DISPATCH_EFFORT
    : dispatchEffortFor(settings, pin) ?? "its provider's default effort";
  return `dispatch runs a fixed model: ${pin} at ${effort}`;
}
