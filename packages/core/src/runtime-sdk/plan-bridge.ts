import type { PermissionResult } from "@yanlinglabs/winter-agent-sdk";
import type { NewSessionEvent } from "@norma/protocol";
import type { SessionApprovalPolicy } from "../agent/gate";
import type { BridgedApprovalRequest } from "./approval-bridge";
import { NO_PARK_TIMEOUT_MS, type BridgeLogger } from "./bridge-common";

/**
 * **The `ExitPlanMode` bridge** (P8c-11 / Task 2.3) — a Winter child's plan presentation over the
 * `plan_presented`/`plan_resolved` events and `plan.respond` RPC that PREDATE this phase
 * (`agent/plans.ts`'s `PlanBroker`, `ipc/server.ts`'s `case METHODS.planRespond`): both retired
 * with the engine (`event-coverage.ts` marked both variants `false`, "fate follows the tool that
 * raised them", `daemon.ts` wires `plans: undefined`) and get their producer back here.
 *
 * **Retired-engine precedent, carried forward verbatim** (`agent/engine.ts`'s `runPlanBridge`,
 * pre-8b): wait-before-emit (the broadcast is synchronous — a watcher answering the instant it
 * sees the event would race an unregistered wait); on APPROVAL, always leave plan mode — the new
 * policy is `"auto"` when the human picked auto-accept, `"ask"` otherwise (an approval never
 * leaves the session in `"plan"`, whichever button was pressed); on rejection, the model is told
 * to stay in plan mode and revise.
 *
 * **What changed for the Winter leg, and why `onExitPlanMode` answers a `PermissionResult` and not
 * a tool result.** The retired engine ran `exit_plan_mode` as one of its OWN registered tools, so
 * approval/rejection was reported as that tool's `{output, isError}`. Winter's `ExitPlanMode` is a
 * BUILT-IN the child calls through `canUseTool` (Task 2.3's brief: "ExitPlanMode arrives as a
 * canUseTool request") — the same shape `approval-bridge.ts`'s `canUseToolFor` answers everything
 * else with, so this bridge answers the same way: `allow`/`updatedInput` on approval, `deny`/
 * `message` on rejection or timeout. There is no tool result text to compose; the runtime turns a
 * `deny` into the model-visible outcome itself.
 *
 * **`BridgedPlanRequest` widens 8b's `BridgedApprovalRequest`.** The Interfaces block's own
 * `onExitPlanMode(request: BridgedApprovalRequest)` signature has no field for the plan TEXT —
 * `BridgedApprovalRequest.summary` is `approvalCardSummary`'s general-purpose args summary (see
 * `approval-bridge.ts`'s own doc comment on why it is deliberately NOT per-call description text),
 * never the verbatim plan markdown `plan_presented.plan` requires. So this file declares its own
 * `plan: string` extension; the caller (session-driver.ts, lane 1 — the `canUseTool` deps
 * composition the brief names as this bridge's wiring point) builds one from `ExitPlanMode`'s
 * `input.plan` alongside the same fields `raiseCard` already computes for every other call. A
 * contravariant parameter widening compiles at the call site with no cast: passing an object with
 * an EXTRA field where `BridgedApprovalRequest` is expected is exactly what TypeScript allows.
 */
export interface BridgedPlanRequest extends BridgedApprovalRequest {
  /** `ExitPlanMode`'s `input.plan`, verbatim — `plan_presented.plan`'s value. */
  plan: string;
}

type PlanDecision = { approved: boolean; feedback?: string; autoAccept: boolean };
type PlanOutcome = (PlanDecision & { by: string }) | { timedOut: true };

export interface PlanBridgeDeps {
  /** Appends + broadcasts one event on `sessionId` (mirrors `CanUseToolDeps.emit` /
   *  `AskUserQuestionDeps.emit` — nothing else in the deps can produce a `SessionEvent`). */
  emit: (event: NewSessionEvent) => void;
  /**
   * Persists the session's new approval policy AND reaches a live child (the retired engine's
   * `cfg.setPolicy` — `ipc/server.ts`'s `session.setPolicy` case composes the identical pair,
   * `store.setApprovalPolicy` + `winter.get(sessionId)?.setPolicy`). Called ONLY on approval,
   * never on rejection or timeout — leaving plan mode is what an approval MEANS.
   */
  setPolicy: (sessionId: string, policy: SessionApprovalPolicy) => Promise<void> | void;
  log?: BridgeLogger;
  /** Test seam; defaults to `Date.now`. */
  now?: () => number;
  /** Defaults to `NO_PARK_TIMEOUT_MS` (24.8 days) — the SAME park ceiling `approval-bridge.ts`/
   *  `question-bridge.ts` use, not the retired engine's 5-minute `NORMA_PLAN_TIMEOUT_MS`: a plan
   *  is exactly as human-paced as any other approval card, and a shorter park would silently auto-
   *  reject a plan a human is still reading. */
  parkTimeoutMs?: number;
}

export interface PlanBridge {
  onExitPlanMode(request: BridgedPlanRequest): Promise<PermissionResult>;
  respond(
    sessionId: string, callId: string,
    decision: PlanDecision,
    by: string,
  ): { ok: true; alreadyResolved: boolean };
}

/** `plan.respond` reaches this via `ipc/server.ts`'s EXISTING, unchanged `case
 *  METHODS.planRespond` — it already calls `opts.plans?.respond(sessionId, callId, {approved,
 *  feedback, autoAccept}, clientName)` generically, so wiring `planBridgeFor(deps)` in as
 *  `opts.plans` (replacing the retired `PlanBroker` instance daemon.ts wires today) needs no
 *  change to that case at all — only `daemon.ts`'s wiring line (a controller/lane-1 edit; see the
 *  brief's cross-lane note) and, since `opts.plans` is typed as the concrete `PlanBroker` class
 *  today, widening that field's TYPE to this file's `PlanBridge` interface (nominal-vs-structural:
 *  a plain object cannot satisfy a class type that carries private members). */
export function planBridgeFor(deps: PlanBridgeDeps): PlanBridge {
  const log = deps.log;
  const now = deps.now ?? (() => Date.now());
  const parkTimeoutMs = deps.parkTimeoutMs ?? NO_PARK_TIMEOUT_MS;
  const pending = new Map<string, { resolve: (o: PlanOutcome) => void; timer: ReturnType<typeof setTimeout> }>();
  const key = (sessionId: string, callId: string): string => `${sessionId}:${callId}`;

  function wait(sessionId: string, callId: string): Promise<PlanOutcome> {
    return new Promise((resolve) => {
      const k = key(sessionId, callId);
      const timer = setTimeout(() => { pending.delete(k); resolve({ timedOut: true }); }, parkTimeoutMs);
      pending.set(k, { resolve, timer });
    });
  }

  function respond(sessionId: string, callId: string, decision: PlanDecision, by: string): { ok: true; alreadyResolved: boolean } {
    const k = key(sessionId, callId);
    const entry = pending.get(k);
    if (!entry) return { ok: true, alreadyResolved: true };
    pending.delete(k);
    clearTimeout(entry.timer);
    entry.resolve({ ...decision, by });
    return { ok: true, alreadyResolved: false };
  }

  async function onExitPlanMode(request: BridgedPlanRequest): Promise<PermissionResult> {
    const { sessionId, callId, plan } = request;
    // ExitPlanMode is main-thread-only (event-coverage.ts: plan tools are excluded from every
    // child — `childExcludeTools` in the retired engine, the same exclusion Winter's own
    // descriptor availability enforces), so this bridge never learns a non-main threadId.
    const threadId = "main";

    // Wait-before-emit (the retired engine's own comment, carried forward): the broadcast is
    // synchronous, so a watcher answering the instant it observes `plan_presented` would otherwise
    // race an unregistered wait into a lost response.
    const waiting = wait(sessionId, callId);
    try {
      deps.emit({ type: "plan_presented", sessionId, threadId, callId, plan });
    } catch (err) {
      respond(sessionId, callId, { approved: false, autoAccept: false }, "emit-failure");
      await waiting;
      log?.error(`ExitPlanMode: failed to emit plan_presented session=${sessionId} call=${callId}: ${(err as Error).message}`);
      return { behavior: "deny", message: "ExitPlanMode was not presented — this session could not raise the plan." };
    }

    const outcome = await waiting;
    const approved = "timedOut" in outcome ? false : outcome.approved;
    const autoAccept = "timedOut" in outcome ? false : outcome.autoAccept;
    const feedback = "timedOut" in outcome ? undefined : outcome.feedback;
    const by = "timedOut" in outcome ? "timeout" : outcome.by;

    deps.emit({
      type: "plan_resolved", sessionId, threadId, callId, approved, autoAccept, by,
      ...(feedback ? { feedback } : {}),
    });

    if (approved) {
      // An approval ALWAYS leaves plan mode — "auto" (auto-accept edits) or "ask" (review each),
      // never back into "plan". Persisted BEFORE the allow is returned, matching the retired
      // engine's own ordering (`cfg.setPolicy` then the tool result), so a follow-up call in this
      // SAME turn is gated by the new policy rather than the stale "plan" one.
      const next: SessionApprovalPolicy = autoAccept ? "auto" : "ask";
      try {
        await deps.setPolicy(sessionId, next);
      } catch (err) {
        log?.error(`ExitPlanMode: setPolicy(${sessionId}, ${next}) failed after approval: ${(err as Error).message}`);
        // The plan WAS approved — a policy-persistence failure must not turn that into a deny (the
        // human already said yes); the session simply keeps re-evaluating under its prior policy
        // until a later mutation succeeds. Logged, never thrown.
      }
      log?.info(`ExitPlanMode: approved session=${sessionId} call=${callId} autoAccept=${autoAccept} by=${by}`);
      // `{ plan }` is ExitPlanMode's whole documented input shape (Task 2.3's brief: "tool
      // ExitPlanMode, input.plan") — there is no raw `input` object to echo onto here the way
      // `askUserQuestionBridge` merges `answers` onto `priorInput`, because the pinned
      // `onExitPlanMode(request: BridgedApprovalRequest)` signature carries no `input` field at
      // all (`BridgedApprovalRequest` has none — see this file's header doc comment).
      return { behavior: "allow", updatedInput: { plan } };
    }

    log?.info(`ExitPlanMode: rejected session=${sessionId} call=${callId} by=${by}`);
    const reason = feedback && feedback.trim().length > 0
      ? feedback
      : by === "timeout"
      ? "no response — the user did not respond within the time limit"
      : "the user rejected the plan without specific feedback";
    return {
      behavior: "deny",
      message: `Plan rejected: ${reason}. Stay in plan mode and revise your plan, then call ExitPlanMode again.`,
    };
  }

  return { onExitPlanMode, respond };
}
