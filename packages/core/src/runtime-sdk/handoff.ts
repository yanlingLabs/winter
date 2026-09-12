// Winter Phase 8c (Task 4.1, WS-13 §8.2) — `session.setModel`'s DEFER-AND-CONFIRM runtime switch.
//
// A model change is usually an in-runtime affair (the live child gets a new model, or a resumed one
// reads a new stored override) — that path is `session.setModel`'s own, unchanged. The NEW case this
// module owns is a model change whose resolved runtime differs from the session's RECORDED leg: that
// is a HANDOFF (WS-05 §12's eight steps, behind the router's own barrier), never a plain write, and
// three things distinguish it from an ordinary set-model:
//
//   1. IT MAY BE LOSSY. Moving a session between legs can drop provider-native state (reasoning
//      items, an in-flight tool round) the destination cannot represent — the barrier's own plan says
//      so per step, and an unconfirmed lossy switch is refused typed rather than silently downgraded
//      or silently executed.
//   2. IT MUST NOT RACE A RUNNING TURN. A handoff drains the source to an idle boundary as its own
//      first real step; a switch requested while a turn is running is recorded and applied AT the
//      next quiescent boundary instead of fighting the barrier's own drain.
//   3. IT NEEDS A DESTINATION. Unlike an in-runtime change, a handoff creates a live handle on the
//      OTHER leg — this module reuses `session-driver.ts`'s existing, tested assembly for that
//      (evict the table's entry for the record's OLD leg, patch the record to the NEW one, `ensure()`
//      it again) rather than re-implementing incarnation assembly here.
//
// PARTICIPANTS ARE REGISTERED ONCE (`registerHandoffParticipants`, called from `ipc/server.ts`'s
// server-setup body, not from any RPC case) through the hook lane 1 left for exactly this
// (`NormaRuntimeSdk.registerHandoffParticipants` — see `create.ts`'s own P8c-14 doc comment): the
// router's `handoff.participants`/`.selectionInputFor` are read LAZILY, at handoff time, so this
// module's closures reach the live driver table and record store without `create.ts` ever knowing
// they exist.
//
// `selectionInputFor` IS NOW REGISTERED (P8c handoff fix). It was left unregistered on the theory
// that `planAndApplySwitch`'s own `runtime.selectRuntimeFor` call already ran the real servability
// check before the barrier ever saw the session — but that call passed `persisted: record.selection`,
// and the router's OWN rule (`SELECTION_RULES.persisted`) returns a persisted selection BY IDENTITY,
// never re-decided. The "real servability check" was therefore always a no-op that handed back the
// CURRENT leg, `legOfRuntimeKind(decided.runtimeKind) === currentLeg` was always true, and the barrier
// was never consulted — measured by `test/e2e/handoff-cross-runtime-e2e.test.ts` against the real
// router. Two changes fix it: (1) the DESTINATION decision below is now a FRESH `selectRuntimeFor`
// call with NO `persisted` field, so it answers what today's catalog/credentials would pick for the
// requested model, independent of the recorded leg; (2) `selectionInputFor` is registered here so
// `barrier.plan()` reviews the DESTINATION's servability with this deployment's real catalog and
// credentials (via `NormaRuntimeSdk.buildSelectionInput`) instead of the router's own unreviewed
// default — `persisted` is still passed to IT, because reviewing "is the persisted family still
// servable on the destination" is exactly the barrier's job, not the initial leg decision's.
import type {
  HandoffBarrier,
  HandoffDestinationRuntime,
  HandoffOutcome,
  HandoffPlan,
  HandoffResumeTarget,
  HandoffSourceOwner,
  RuntimeKind,
  RuntimeSelection,
  SelectionInput,
  SessionKey,
} from "@yanlinglabs/winter-runtime-sdk";
import { runtimeSdkInternals } from "@yanlinglabs/winter-runtime-sdk";
import type { HandoffParticipants, NormaRuntimeSdk, SessionMode } from "./create";
import { RuntimeSessionRecords, type RuntimeSessionRecord } from "../runtime-state/records";
import { handoffCrossRuntimeEnabled, type Settings } from "../settings";
import { sessionLegOf } from "./leg";
import { catalogRowsFor, testProviderNameFor } from "./provider-selection";
import type { LegSession, WinterSessionDrivers } from "./session-driver";

export interface HandoffDeps {
  runtime: NormaRuntimeSdk;
  winter: WinterSessionDrivers;
  records: RuntimeSessionRecords;
  store: {
    meta(sessionId: string): { mode?: string; cwd?: string | null };
    /**
     * m5 (whole-branch review): the DEFERRED branch's own model commit — `ipc/server.ts`'s
     * `session.setModel` handler must NOT write the model preference for a `"deferred"` outcome
     * (the switch has not happened yet, and the eventual barrier execution can still resolve to
     * `lossy_fork`/`blocked`, never having moved anything). `planAndApplySwitch` calls this itself,
     * from inside the deferred continuation, ONLY once the barrier has actually executed AND
     * resumed — see the deferred branch below. Optional so a caller/test that never exercises the
     * deferred path (every same-runtime/immediate case) needs no store write door at all.
     */
    setModel?(sessionId: string, model: string | null): void;
  };
  /** Fix wave (C2 / P8c-18): the LIVE settings holder — read hot, at call time, in
   *  `planAndApplySwitch`, never a boot snapshot (`winterOptionsFromSettings`'s own pattern). */
  settings: () => Settings | null | undefined;
  log?: (line: string) => void;
  /**
   * Test seam: a fake `{plan, execute}` in place of `runtimeSdkInternals(runtime.sdk)?.barrier`.
   * `runtimeSdkInternals` resolves a handle against a WeakMap the router's OWN factory populates —
   * a handle built any other way (a plain test double for `NormaRuntimeSdk.sdk`) answers `undefined`
   * there regardless of what it structurally looks like, so a unit test that wants to drive
   * `planAndApplySwitch`'s branches without a real router construction supplies one directly.
   * Production never sets this — see `barrierFor` below.
   */
  barrier?: HandoffBarrier;
}

function barrierFor(deps: HandoffDeps): HandoffBarrier | undefined {
  return deps.barrier ?? runtimeSdkInternals(deps.runtime.sdk)?.barrier;
}

const modeOf = (raw: string | undefined): SessionMode => (raw === "chat" || raw === "dispatch" ? raw : "code");

/** `SessionLeg` ("winter"|"official"|"engine") ↔ the router's own `RuntimeKind`
 *  ("winter-agent"|"claude-agent") — the two vocabularies this whole module has to bridge between. */
const legOfRuntimeKind = (kind: RuntimeKind): "winter" | "official" => (kind === "claude-agent" ? "official" : "winter");

function sessionKeyFor(record: RuntimeSessionRecord): SessionKey | undefined {
  if (record.backendSessionId === undefined) return undefined;
  return { projectKey: record.transcriptProjectKey, sessionId: record.backendSessionId };
}

// ── Participants (registered once; consulted lazily by the router at handoff time) ────────────────

/** The live session this handoff is draining FROM — `undefined` when nothing is live (a cold
 *  handoff: the barrier's own doc treats an absent owner as "nothing to drain", not a failure). */
function sourceOwnerFor(deps: HandoffDeps, session: SessionKey, from: RuntimeKind): HandoffSourceOwner | undefined {
  const record = deps.records.byBackendSessionId(session.sessionId);
  if (record === undefined) return undefined;
  const live = deps.winter.get(record.winterSessionId);
  if (live === undefined) return undefined;
  return {
    runtimeKind: from,
    drainToIdleBoundary: async () => {
      try {
        await live.idle();
        return { ok: true };
      } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.name : "unknown" };
      }
    },
    // `idle()` above already waits for the SAME "nothing in flight" boundary a stream-drain would —
    // `LegSession` has no separate stream handle to flush beyond it.
    drainStream: async () => ({ ok: true }),
    close: async () => {
      try {
        await live.end();
        return { ok: true };
      } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.name : "unknown" };
      }
    },
  };
}

/**
 * The leg this session is moving TO. `confirmInit` reuses `session-driver.ts`'s OWN resume dispatch
 * (`WinterSessionDrivers.ensure`, which already reads `sessionLegOf(record)` to pick the winter or
 * official assembly) rather than re-implementing incarnation assembly: patch the record to the
 * target leg FIRST (so `ensure()`'s own `sessionLegOf` read sees it), evict any stale table entry,
 * then `ensure()`. A confirmInit that fails RESTORES the record to what it was — the barrier's own
 * contract is "a refusal here keeps the source owner", which only holds if the record still agrees.
 */
function destinationRuntimeFor(deps: HandoffDeps, session: SessionKey, to: RuntimeKind): HandoffDestinationRuntime | undefined {
  const record = deps.records.byBackendSessionId(session.sessionId);
  if (record === undefined) return undefined;
  const winterSessionId = record.winterSessionId;
  // m4 (whole-branch review): captured at PLAN time — `destinationRuntimeFor` is called once, when
  // the barrier builds its plan, but `confirmInit` below runs at EXECUTE time, an arbitrary amount
  // later (the source's own drain, or the deferred-turn wait in `planAndApplySwitch`). Using the
  // stale `record.state` closed over here as the transition's FROM state would risk applying a
  // lifecycle transition against a state that is no longer true — the session could have been
  // archived, deleted, or otherwise moved by something else in between. `confirmInit` re-reads the
  // record fresh and refuses typed if it moved, rather than trusting this snapshot or guessing.
  const planState = record.state;
  return {
    runtimeKind: to,
    confirmInit: async (target: HandoffResumeTarget) => {
      const fresh = deps.records.get(winterSessionId);
      if (fresh === undefined) {
        return { ok: false, reason: "the session record no longer exists" };
      }
      if (fresh.state !== planState) {
        return { ok: false, reason: `the session moved from ${planState} to ${fresh.state} between plan and execute` };
      }
      const before = { runtimeKind: fresh.runtimeKind, selection: fresh.selection, backendSessionId: fresh.backendSessionId };
      try {
        // P8d-24: `patch`, never `transition` — this never changes the lifecycle `state`, only the
        // runtime/selection/backendSessionId fields, so it must not be spelled as a transition TO
        // the record's own current state (`ALLOWED_TRANSITIONS` has no self-loop for any state; see
        // `RuntimeSessionRecords.patch`'s own doc comment for why that made this always refuse).
        deps.records.patch(winterSessionId, fresh.state, {
          runtimeKind: to,
          selection: target.selection,
          backendSessionId: target.backendSessionId,
        });
      } catch (err) {
        return { ok: false, reason: `the record could not be patched to the target leg: ${err instanceof Error ? err.name : "unknown"}` };
      }
      try {
        await deps.winter.evict(winterSessionId);
        const opened = await deps.winter.ensure(winterSessionId);
        if (opened === undefined) throw new Error("no driver could be opened on the target leg");
        return { ok: true, producer: { sdkVersion: target.selection.sdkVersion, engineVersion: target.selection.engineVersion } };
      } catch (err) {
        try {
          // The lifecycle state was never touched above, so the revert targets the SAME
          // `fresh.state` the forward patch did.
          deps.records.patch(winterSessionId, fresh.state, before);
        } catch (revertErr) {
          deps.log?.(`handoff: confirmInit failed AND the record revert for ${winterSessionId} also failed (${revertErr instanceof Error ? revertErr.name : "unknown"}) — the record may now name a leg it cannot run on`);
        }
        return { ok: false, reason: err instanceof Error ? err.name : "unknown" };
      }
    },
  };
}

/**
 * WS-05 §12's Lane D door: builds the `SelectionInput` `barrier.plan()` reviews destination
 * servability against, using `NormaRuntimeSdk.buildSelectionInput` — the SAME real catalog/
 * credentials/official-peer facts `selectRuntimeFor` reads, never a synthesized view.
 *
 * `persisted: args.persisted` is where the router's OWN "the persisted selection wins" rule
 * (`SELECTION_RULES.persisted`) now belongs: `reviewPersistedSelection` (run inside the barrier's
 * `plan()`) compares a FRESH decision against it and reports `unchanged` / `handoff-required` /
 * `fresh-refused` — never a silent rewrite. `requested` is deliberately left empty: this door
 * answers "is the session's own persisted family still servable on the destination", not "does a
 * specific newly-requested model resolve there" — `planAndApplySwitch`'s own fresh `selectRuntimeFor`
 * call already decided THAT question before the barrier was ever reached.
 *
 * Absent when `deps.runtime.buildSelectionInput` is absent (a hand-built test double for
 * `NormaRuntimeSdk` that does not implement it) — `registerHandoffParticipants` below omits the key
 * entirely in that case, which is the router's own "unreviewed" default, not a crash.
 */
function selectionInputFor(deps: HandoffDeps): ((args: { session: SessionKey; from: RuntimeKind; to: RuntimeKind; persisted: RuntimeSelection }) => Promise<SelectionInput>) | undefined {
  const build = deps.runtime.buildSelectionInput;
  if (build === undefined) return undefined;
  return async (args) => {
    const record = deps.records.byBackendSessionId(args.session.sessionId);
    const mode = modeOf(record === undefined ? undefined : deps.store.meta(record.winterSessionId).mode);
    return build({ mode, persisted: args.persisted });
  };
}

export function registerHandoffParticipants(deps: HandoffDeps): void {
  const selectionInput = selectionInputFor(deps);
  const participants: HandoffParticipants = {
    source: (session, from) => sourceOwnerFor(deps, session, from),
    destination: (session, to) => destinationRuntimeFor(deps, session, to),
    ...(selectionInput === undefined ? {} : { selectionInputFor: selectionInput }),
  };
  deps.runtime.registerHandoffParticipants(participants);
}

// ── The RPC-facing door: plan, then (maybe) execute ────────────────────────────────────────────────

export type PlanSwitchOutcome =
  | { kind: "same-runtime" } // an ordinary in-runtime model change — the caller's existing path
  | { kind: "refused"; code: "runtime_selection_refused" | "session_predates_winter_leg" | "handoff_disabled"; detail: string }
  | { kind: "confirmation_required"; warnings: string[] }
  | { kind: "deferred" } // a turn is running; the switch is applied when it settles
  | { kind: "resumed"; selection: RuntimeSelection }
  | { kind: "lossy_fork"; reason: string }
  | { kind: "blocked"; reason: string };

/** WS-13 §8.2's warning list: a plan step the barrier already knows is unprovable (a lossy step) —
 *  the concrete case named there is a source carrying reasoning state moving to a foreign target,
 *  which surfaces as exactly this on the source's own drain/validation steps. */
function warningsOf(plan: HandoffPlan): string[] {
  return plan.steps.flatMap((s) => (s.knownUnprovable !== undefined ? [s.knownUnprovable] : []));
}

async function executePlan(deps: HandoffDeps, plan: HandoffPlan): Promise<PlanSwitchOutcome> {
  const barrier = barrierFor(deps);
  if (barrier === undefined) return { kind: "blocked", reason: "the handoff barrier is unavailable on this runtime handle" };
  const outcome: HandoffOutcome = await barrier.execute(plan);
  switch (outcome.kind) {
    case "resumed":
      return { kind: "resumed", selection: outcome.selection };
    case "lossy-fork-offered":
      return { kind: "lossy_fork", reason: outcome.reason };
    case "blocked":
      return { kind: "blocked", reason: outcome.reason };
  }
}

/**
 * The whole decision, up to (and including, when nothing defers it) execution.
 *
 * `model === null` (clearing an override) never triggers a leg decision — see this file's header:
 * nothing about clearing a stored preference asks for a specific runtime.
 */
export async function planAndApplySwitch(deps: HandoffDeps, sessionId: string, model: string | null, confirmLossy: boolean): Promise<PlanSwitchOutcome> {
  if (model === null) return { kind: "same-runtime" };
  const record = deps.records.get(sessionId);
  const currentLeg = sessionLegOf(record);
  if (record === undefined || currentLeg === "engine" || currentLeg === undefined) {
    // Nothing recorded, or an engine-era row: a leg DECISION has nothing to compare against, and a
    // handoff needs a live-or-resumable source to drain in the first place. `session.setModel`'s
    // caller keeps its own ordinary (store-write-only) behaviour for this case.
    return { kind: "same-runtime" };
  }
  // Mirrors `session-driver.ts`'s OWN `decideRuntime` bail-out #2 for a NEW session: a
  // `winter-test/<double>` model is chosen by env var, never by the catalog, and the router's
  // listing has no row for it AT ALL — `selectRuntimeFor` refuses every such model outright
  // (measured: `winter-chat-e2e.test.ts`'s `session.setModel` calls with `winter-test/<double>`
  // models on an EXISTING session, which must keep today's in-runtime behaviour, exactly as
  // `session.create` already does for the same models). Without this bail-out the fresh decision
  // below would hard-refuse a plain, same-leg model change that never asked to move anything.
  if (testProviderNameFor(model) !== undefined) return { kind: "same-runtime" };
  // M1 (whole-branch review): mirrors `session-driver.ts`'s `decideRuntime` bail-out #4 — a model
  // with NO row in the pinned catalog AT ALL (a BYO/custom `provider.baseUrl` endpoint's own model
  // id) has nothing for the selector to route on; without this bail-out a plain, off-catalog model
  // change on an EXISTING session would hard-refuse through the selector instead of keeping its
  // ordinary in-runtime behaviour, which is what `session.create` already does for the same models.
  if (catalogRowsFor(model).length === 0) return { kind: "same-runtime" };
  const mode = modeOf(deps.store.meta(sessionId).mode);
  // FRESH — no `persisted`. `SELECTION_RULES.persisted` returns a persisted selection BY IDENTITY,
  // so passing `record.selection` here (the pre-fix shape) made `decided.runtimeKind` always equal
  // the recorded leg and the barrier was never reached — see this file's header. What today's
  // catalog/credentials would pick for the REQUESTED model is the question this call answers; the
  // persisted-selection review happens later, inside the barrier's own plan (`selectionInputFor`).
  const decided = await deps.runtime.selectRuntimeFor({ mode, model });
  if ("refused" in decided) {
    return { kind: "refused", code: "runtime_selection_refused", detail: decided.detail };
  }
  if (legOfRuntimeKind(decided.runtimeKind) === currentLeg) {
    return { kind: "same-runtime" };
  }
  // C2 fence (whole-branch review / ruling P8c-18): a cross-runtime handoff's real behaviour
  // against the live barrier is unmeasured in production (this file's header + the e2e's own —
  // only a typed refusal has been proven end to end). Refuse BEFORE any barrier call and BEFORE
  // `session.setModel`'s own store write (this return short-circuits both), typed, so a deployment
  // that has not opted in never executes an unconfirmed cross-runtime switch. Read HOT, at call
  // time, per this file's own `HandoffDeps.settings` doc — never a boot snapshot. Same-runtime
  // model changes (the branch above) are entirely unaffected.
  if (!handoffCrossRuntimeEnabled(deps.settings())) {
    return {
      kind: "refused",
      code: "handoff_disabled",
      detail: `moving this session from the ${currentLeg} runtime to ${legOfRuntimeKind(decided.runtimeKind)} is disabled (settings.runtimes.handoff.crossRuntime is off)`,
    };
  }
  const sessionKey = sessionKeyFor(record);
  if (sessionKey === undefined) {
    return { kind: "refused", code: "session_predates_winter_leg", detail: "this session has no backend transcript to hand off from" };
  }
  const barrier = barrierFor(deps);
  if (barrier === undefined) return { kind: "blocked", reason: "the handoff barrier is unavailable on this runtime handle" };
  const plan = await barrier.plan(sessionKey, decided.runtimeKind);
  if (plan.selection.kind === "refused") {
    return { kind: "refused", code: "runtime_selection_refused", detail: plan.selection.detail };
  }
  const warnings = warningsOf(plan);
  if (warnings.length > 0 && !confirmLossy) {
    return { kind: "confirmation_required", warnings };
  }
  const live = deps.winter.get(sessionId);
  if (live?.turnRunning === true) {
    // Deferred, fire-and-forget: `session.setModel`'s own "best-effort, never delays the reply"
    // posture (mirrored from its existing live-driver notification) — the caller replies `{}` now,
    // and this fires once the boundary the barrier's own drain step would have waited for anyway.
    //
    // m5 (whole-branch review): the model preference commits HERE, from inside this continuation,
    // and ONLY on a `resumed` outcome — never at defer time, when the eventual result could still
    // be `lossy_fork`/`blocked` and the runtime never actually moves. `ipc/server.ts`'s own
    // unconditional store write covers `same-runtime`/`resumed` (the caller's ordinary, immediate
    // path); its `"deferred"` case must return without that write, which is why this function owns
    // the commit for exactly that one outcome instead.
    void live.idle().then(
      () =>
        executePlan(deps, plan).then(
          (outcome) => {
            if (outcome.kind === "resumed") {
              deps.store.setModel?.(sessionId, model);
              return;
            }
            // Minor 3 (whole-branch review): a deferred handoff that settles to `lossy_fork` or
            // `blocked` used to leave no trace at all — the caller already got `{}` back at defer
            // time (m5's own posture above), and neither of these outcomes writes to the store, so
            // without this the runtime silently never moved and nothing said why. Kind + reason +
            // session id ONLY — never the plan/selection itself, which can carry opaque provider
            // state (this file's own header rule). `executePlan`'s own return only ever produces
            // one of these three kinds, but its declared type is the full `PlanSwitchOutcome`, so
            // the other kind is narrowed explicitly rather than asserted.
            if (outcome.kind === "lossy_fork" || outcome.kind === "blocked") {
              deps.log?.(`deferred handoff for ${sessionId} settled ${outcome.kind}: ${outcome.reason}`);
            }
          },
          (err) => deps.log?.(`deferred handoff for ${sessionId} failed: ${err instanceof Error ? err.name : "unknown"}`),
        ),
      () => { /* the session ended before settling — nothing left to hand off */ },
    );
    return { kind: "deferred" };
  }
  return executePlan(deps, plan);
}
