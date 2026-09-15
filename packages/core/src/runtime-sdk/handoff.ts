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
// (`WinterRuntimeSdk.registerHandoffParticipants` — see `create.ts`'s own P8c-14 doc comment): the
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
// credentials (via `WinterRuntimeSdk.buildSelectionInput`) instead of the router's own unreviewed
// default — `persisted` is still passed to IT, because reviewing "is the persisted family still
// servable on the destination" is exactly the barrier's job, not the initial leg decision's.
// Winter Phase 10b (D1 fix round 3, item 1a): the SAME address derivation `messaging.ts`'s two
// attach doors use — a materialized directory row must land at the address a real incarnation
// would later overwrite, never a second one.
import { buildSessionAddress, serializeRuntimeAddress } from "@yanlinglabs/winter-agent-sdk/messaging";
import type { SerializedRuntimeAddress } from "@yanlinglabs/winter-runtime-sdk";
import type {
  DetailedHandoffOutcome,
  HandoffBarrier,
  HandoffDestinationRuntime,
  HandoffOutcome,
  HandoffPlan,
  HandoffResumeTarget,
  HandoffSourceOwner,
  RuntimeKind,
  RuntimeSelection,
  SelectionAlternative,
  SelectionInput,
  SessionKey,
} from "@yanlinglabs/winter-runtime-sdk";
import { runtimeSdkInternals } from "@yanlinglabs/winter-runtime-sdk";
// Winter Phase 10b (D1-6, W18-20): `SwitchReview` is `@yanlinglabs/winter-provider-runtime`'s own
// type — the router's `HandoffBarrier.reviewSwitch`/`HandoffPlan.review` (from
// `@yanlinglabs/winter-runtime-sdk`) declare it by importing it from THAT package too (measured
// against the published 0.0.5 `.d.ts`: `winter-runtime-sdk`'s own top-level barrel never re-exports
// it), so this is the one place the daemon can name the type without a structural `any`.
import type { SwitchReview } from "@yanlinglabs/winter-provider-runtime";
import type { HandoffParticipants, WinterRuntimeSdk, SessionMode } from "./create";
import { RuntimeSessionRecords, type RuntimeSessionRecord } from "../runtime-state/records";
import { handoffCrossRuntimeEnabled, officialSubscriptionAuthEnabled, type Settings } from "../settings";
import { sessionLegOf } from "./leg";
import { credentialRefFor } from "./keychain";
import { catalogRowsFor, testProviderNameFor } from "./provider-selection";
import type { LegSession, WinterSessionDrivers } from "./session-driver";

export interface HandoffDeps {
  runtime: WinterRuntimeSdk;
  winter: WinterSessionDrivers;
  records: RuntimeSessionRecords;
  store: {
    // P10a-h: `model` is READ (never just written) by `confirmInit`'s own store-model commit/revert
    // below — the real `SessionStore.meta()` already returns it (`sessions/store.ts`), so widening
    // this duck-typed shape to name it costs nothing and lets `confirmInit` capture the PRIOR value
    // to restore on a failed handoff.
    meta(sessionId: string): { mode?: string; cwd?: string | null; model?: string };
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
  /**
   * Winter Phase 10b (D1-2, W18-7): the daemon's own `WINTER_HOME`, threaded through to
   * `credentialRefFor` so `confirmInit` can name the DESTINATION's own credential locator
   * (`keychain:<account>`) the same way `session-driver.ts`'s `create()`/`createOfficial()` already
   * do for a brand-new session — never credential material, only which account it would be. Optional
   * so a test double that never exercises the success patch (every existing `handoff.test.ts` case
   * that stubs `confirmInit` via a fake barrier) needs no home at all; `credentialRefFor` itself is
   * total over an absent `home`, and simply keeps the OLD, unconditional `anthropic:default` account
   * for the one provider whose account name depends on it.
   */
  home?: string;
  log?: (line: string) => void;
  /**
   * Test seam: a fake `{plan, execute}` in place of `runtimeSdkInternals(runtime.sdk)?.barrier`.
   * `runtimeSdkInternals` resolves a handle against a WeakMap the router's OWN factory populates —
   * a handle built any other way (a plain test double for `WinterRuntimeSdk.sdk`) answers `undefined`
   * there regardless of what it structurally looks like, so a unit test that wants to drive
   * `planAndApplySwitch`'s branches without a real router construction supplies one directly.
   * Production never sets this — see `barrierFor` below.
   */
  barrier?: HandoffBarrier;
  /**
   * P10a-h: how long `confirmInit` waits for the destination's `system/init` before treating a
   * bare `ensure()` success as unproven (see `awaitDestinationInit` below). A getter, not a value —
   * same "live, never a boot snapshot" posture as `settings` above. Defaults to
   * `DEFAULT_CONFIRM_INIT_TIMEOUT_MS`; tests that want a fast, deterministic "the child never inits"
   * case set this instead of waiting out the production bound.
   */
  confirmInitTimeoutMs?: () => number;
}

function barrierFor(deps: HandoffDeps): HandoffBarrier | undefined {
  return deps.barrier ?? runtimeSdkInternals(deps.runtime.sdk)?.barrier;
}

/**
 * Winter Phase 10b (D1-6, W18-4): DELETED as of 10b — `planAndApplySwitch` now calls
 * `barrier.plan(sessionKey, decided.runtimeKind, { requested: decided })`, and the router's own
 * `reviewSelectionFor` threads `requested` straight through to `plan.selection.selection` UNCHANGED
 * when one is supplied (measured against the published 0.0.5 source: `stamped2 = requested ?? …`,
 * and `execute()`'s `target.selection = plan.selection.selection`). So `confirmInit` below reads
 * `target.selection` directly and it is ALREADY the fresh `decided` selection — no side channel
 * needed for that half of what this map used to carry, and no more "confirmInit falls back to the
 * persisted selection" exposure from a second `setModel` racing a deferred one, because
 * `target.selection` is scoped to the PLAN THAT PRODUCED IT rather than to a mutable per-session slot.
 *
 * What still has no other pipe, and is why `pendingHandoffModelString` below survives: the RAW,
 * AS-TYPED model string (`session.setModel`'s own `model` parameter). It is NOT `decided.modelRef` —
 * the router's `RuntimeSelection.modelRef` is the CATALOG ROW KEY (`candidate.row.key` in the
 * published `selection/select-runtime.ts`, e.g. `"openai/gpt-5.6-sol"`), a provider-qualified
 * identity, never a wire/store value (see that field's own doc: "READ IT AS AN IDENTITY, NOT AS A
 * WIRE VALUE"). `confirmInit`'s P10a-h fix commits the model string to `store.meta(id).model`
 * BEFORE the destination spawns, and `session-driver.ts`'s own `create()`/`decideRuntime` re-read
 * that exact value on the destination's next incarnation — substituting `modelRef` there would
 * silently change what `session.list` shows and what a later incarnation re-resolves from.
 *
 * m2 (whole-branch review, fix round 2): keyed by `(sessionId, modelRef)`, never `sessionId` alone.
 * `confirmInit` (via `destinationRuntimeFor`) has no OTHER call-scoped correlator to the SPECIFIC
 * `planAndApplySwitch` invocation that set this entry — the router calls `HandoffParticipants
 * .destination(session, to)` fresh per plan, but hands it no plan id, so the only thing both ends
 * agree on is `session`/`to` plus whatever rides on `target.selection` (which IS `decided`,
 * unmerged — this file's own D1-6 doc above). A bare `sessionId` key meant TWO deferred cross-leg
 * `setModel` calls racing the SAME running turn (the second overwrites the first's entry before
 * either's `confirmInit` ever reads it) always committed the LATER call's model string for BOTH —
 * silently wrong for whichever settled first. `modelRef` travels on `target.selection` for free
 * and differs whenever the two calls actually named different models (the only case this file can
 * do anything about: two raw strings that happen to alias the SAME catalog row are, by definition,
 * requesting the identical destination, so sharing an entry is correct, not a collision).
 */
const PENDING_MODEL_KEY_SEP = "\u0000"; // never a legal byte in a session id or a catalog row key, so the join can never be ambiguous
const pendingModelKey = (sessionId: string, modelRef: string): string => `${sessionId}${PENDING_MODEL_KEY_SEP}${modelRef}`;
const pendingHandoffModelString = new Map<string, string>();

/** Production bound for `awaitDestinationInit` below. */
const DEFAULT_CONFIRM_INIT_TIMEOUT_MS = 10_000;

/**
 * P10a-h: `WinterSession.open()`/`OfficialSession.open()` resolving proves only that an incarnation
 * was KICKED OFF — the run loop that actually reads the child's stream keeps going in the
 * background, and `open()` returns before the first frame ever arrives (`winter-session.ts`'s own
 * doc comment on `open()`: "Options FIRST … `this.run(inc)`" is never awaited by `open()` itself).
 * So `confirmInit`'s prior "`ensure()` resolved to a defined driver ⇒ success" check proved nothing
 * about whether the destination actually reached init — measured live: the destination child can
 * exit "before init" (a bad provider/model pairing) milliseconds after `ensure()` already returned,
 * and the handoff had already been reported `applied`.
 *
 * `session.init` is set the instant the FIRST init frame lands on a driver `confirmInit` just froze
 * via `evict()`+`ensure()` — a brand-new `WinterSession`/`OfficialSession` instance every time (the
 * evict guarantees no STALE `init` from a prior generation ever survives to be misread here).
 * `session.done` settling before that happens is precisely the "exited before init" case both legs'
 * own run loops log. Bounded so a hung child (init frame never arrives, process never exits either)
 * cannot wedge a handoff forever.
 */
async function awaitDestinationInit(session: LegSession, timeoutMs: number): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (session.init !== undefined) return { ok: true };
  let dead = false;
  void session.done.then(() => { dead = true; }, () => { dead = true; });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (session.init !== undefined) return { ok: true };
    if (dead) return { ok: false, reason: "the destination runtime exited before it reached init" };
    if (Date.now() >= deadline) return { ok: false, reason: "the destination runtime did not report init within the handoff's confirmation window" };
    await Bun.sleep(20);
  }
}

const modeOf = (raw: string | undefined): SessionMode => (raw === "chat" || raw === "dispatch" ? raw : "code");

/** `SessionLeg` ("winter"|"official"|"engine") ↔ the router's own `RuntimeKind`
 *  ("winter-agent"|"claude-agent") — the two vocabularies this whole module has to bridge between. */
const legOfRuntimeKind = (kind: RuntimeKind): "winter" | "official" => (kind === "claude-agent" ? "official" : "winter");

function sessionKeyFor(record: RuntimeSessionRecord): SessionKey | undefined {
  if (record.backendSessionId === undefined) return undefined;
  return { projectKey: record.transcriptProjectKey, sessionId: record.backendSessionId };
}

/**
 * Fix round 2 (A-7 zero-turn, MEASURED): a session can have a `backendSessionId` allocated
 * (`sessionKeyFor` above answers a real key) while STILL never having had a live incarnation
 * register in the router's own runtime directory — a genuine "session.create then IMMEDIATELY
 * session.setModel, no turns at all" call, since the directory row is written only from inside a
 * live incarnation's own `attachMessaging()` (itself reached only once the child's first real
 * frame arrives). BOTH `barrier.reviewSwitch` AND `barrier.plan()` throw the router's own
 * `HandoffPlanError` for exactly this shape ("... it is not in the runtime directory, so there is
 * no record of which runtime owns it or which backend session it is" — MEASURED verbatim against
 * the real router) rather than treating it as "nothing recorded yet". `HandoffPlanError` itself is
 * NOT part of `@yanlinglabs/winter-runtime-sdk`'s declared public exports (only its TYPES are
 * re-exported from `store/handoff-barrier.js`; the class lives in an internal `store/index.js` this
 * package's own "exports" map does not expose — re-confirmed against router 0.0.7), so this checks
 * the message text instead of `instanceof` — read here ONLY to branch, never logged, matching this
 * file's own "names and error CLASS only" discipline elsewhere in this file.
 *
 * ⚠️ FIX ROUND 3 (the round-2 CRITICAL): THIS FACT IS NOT "NOTHING TO LOSE". Round 2 mapped it
 * straight onto `{prompt: false}` / `{kind: "same-runtime"}`, i.e. "apply silently, no prompt, no
 * handoff" — and `sessionKeyFor` is satisfied by `record.backendSessionId`, which is written
 * SYNCHRONOUSLY (`session-driver.ts`'s `create()`, and `import-legacy.ts`'s engine-era conversion
 * on the first `session.send`) while the directory row lands only on the first FRAME. That is a
 * real window in which a session WITH prior turns — an imported engine-era one above all — is
 * keyed but absent from the directory, and in that window a cross-leg move silently updated
 * `meta.model` while the record's `runtimeKind`/`selection` (what `resume()`/`ensure()` actually
 * route on) kept naming the OLD leg: `session.list` showed the new model and the next turn ran on
 * the old one, with no prompt and no error. What the shape actually means is "the ROUTER cannot
 * see this session yet", never "this session has nothing to lose" — so it is now a trigger to
 * MATERIALIZE the row from the durable record and retry once (`materializeDirectoryRow` below),
 * and, failing that, to fail SAFE (a prompt on the review, `blocked` on the apply).
 */
function isNotYetInRuntimeDirectory(err: unknown): boolean {
  return err instanceof Error && /not in the runtime directory/.test(err.message);
}

/**
 * Fix round 4 (MAJOR 2): the ONE barrier refusal a re-selection may answer.
 *
 * Round 3 triggered `reselectWithNothingToCarry` on ANY `lossy_fork` OR `blocked` whenever the
 * review had said "no source turns". `blocked` is the dangerous half: the router's own
 * `revert-pending`, `lease-held` and `repair-required` reasons all mean "there is UNFINISHED STATE
 * OWED on this session" — a revert the barrier could not complete, a writer lease another live
 * process holds, a transcript that needs repair. MEASURED: `no-source-turns` + `blocked
 * ("revert-pending")` produced `{kind:"same-runtime"}` and flipped `record.runtimeKind` to the
 * destination while the router's own `revertRecord` still named the source — and the server's
 * invariant check PASSED, because the record it re-reads had just been made to agree. Those must
 * keep round-2 semantics: the neutral copy, no store write, the record untouched.
 *
 * What a re-selection legitimately answers is exactly one thing: WS-05 §12 step 5 could not
 * validate a canonical transcript BECAUSE THERE IS NONE (`validateSessionTranscript`'s own ENOENT
 * arm, `handoff-barrier.ts:1442`, surfaced through `lossy(5, …)`). The router exposes no typed
 * reason code for it — `DetailedHandoffOutcome` carries a free-text `reason` plus the step number —
 * so this matches BOTH: the step (5, the validation step) and the narrowest stable fragment of that
 * one message. Every other step-5 reason (unterminated framing, a line that is not valid JSON, a
 * broken parent chain, unpaired tool_use/tool_result) describes a transcript that EXISTS and is
 * damaged, which is never "nothing to lose". Read here ONLY to branch — never logged.
 */
function isNoCanonicalTranscriptFork(outcome: { kind: string; reason?: string; step?: number }): boolean {
  if (outcome.kind !== "lossy_fork") return false;
  if (outcome.step !== undefined && outcome.step !== 5) return false;
  return typeof outcome.reason === "string" && /no canonical transcript at .* to validate/.test(outcome.reason);
}

/**
 * Fix round 3 (INVARIANT, tested): does the DURABLE record now route this session the way the
 * requested model's own fresh selection says it should?
 *
 * `session-driver.ts`'s `resume()` picks the leg from `sessionLegOf(record)` — i.e.
 * `record.runtimeKind` — and `resumeOfficial` then hands `record.selection` to `assembleOfficial`
 * BY IDENTITY (P8c-14's "the persisted selection wins"). `meta.model` is read only by the WINTER
 * leg's own `optionsFor`. So a `session.setModel` that reports success while the record still
 * names the source leg/selection has not switched anything — it has only made `meta.model` lie,
 * invisibly, until the next resume runs the OLD model. Every door that reports success (or writes
 * `meta.model`) checks this first; `ipc/server.ts`'s `same-runtime`/`resumed` arm is the one that
 * turns a mismatch into a typed `blocked`.
 *
 * Compared: the three fields those two routing reads consult. `family`/`reason`/`decidedAt` and
 * friends are deliberately NOT compared — `decidedAt` is a timestamp that differs on every
 * decision, and nothing resumes on it.
 */
export function recordNamesSelection(record: RuntimeSessionRecord | undefined, want: RuntimeSelection): boolean {
  if (record === undefined) return false;
  return record.runtimeKind === want.runtimeKind
    && record.selection.runtimeKind === want.runtimeKind
    && record.selection.providerId === want.providerId
    && record.selection.modelRef === want.modelRef;
}

/**
 * Fix round 3 (item 1a): write the runtime-directory row this session should already have had.
 *
 * The row is normally written from inside a live incarnation's own `attachMessaging()`
 * (`messaging.ts`'s `attachWinterSession`/`attachOfficialSession`), so a session that has a durable
 * 8a record but has never had a live child — or whose child was evicted before its first frame —
 * is invisible to the barrier even though every fact the barrier needs is sitting in
 * `runtime_sessions`. This re-derives the row FROM that record, through the SAME door those two
 * functions use (`runtime.sdk.directory.record`) and at the SAME address (`buildSessionAddress`
 * over the backend session id, which is what `findEntry` matches on — either as the row's own
 * `backendSessionId` or as `parsed.winterSessionId`).
 *
 * THE PARKED SHAPE, DELIBERATELY: `status: "exited"`, no `backendSessionId`, every capability
 * false — byte-for-byte what `attachWinterSession`'s own `entry(false)` writes. A row that says
 * "running, with a backend id, and no live handle" is exactly what the router's `deliverIntoSession`
 * reads as "cold-resume this transcript", spawning a second `winter` process the daemon never
 * tracked (that function's own ⚠️ note). Nothing is lost by omitting the id: the barrier's own
 * resume target falls back to `session.sessionId`, which IS that id.
 *
 * NEVER CLOBBERS A LIVE ROW: `directory.get` first. A real incarnation that raced this call (its
 * first frame landing between the barrier's throw and this write) owns the row, and overwriting it
 * with a parked one would un-attach a session that is genuinely live.
 *
 * Returns whether the barrier can now find the session — `false` when the daemon has no directory
 * facet at all (a hand-built `WinterRuntimeSdk` test double), when the record has no backend id
 * (nothing to address), or when the write itself failed. Every caller treats `false` as "fail
 * safe", never as "proceed".
 */
async function materializeDirectoryRow(deps: HandoffDeps, record: RuntimeSessionRecord): Promise<boolean> {
  const directory = deps.runtime.sdk?.directory;
  if (directory === undefined || typeof directory.record !== "function") return false;
  if (record.backendSessionId === undefined) return false;
  try {
    const parsed = buildSessionAddress(record.backendSessionId);
    const address = serializeRuntimeAddress(parsed) as SerializedRuntimeAddress;
    if (typeof directory.get === "function" && (await directory.get(address)) !== undefined) return true;
    const meta = deps.store.meta(record.winterSessionId);
    await directory.record({
      address,
      parsed,
      runtimeKind: record.runtimeKind,
      objectKind: "session",
      // `messaging.ts`'s own two values for the two legs — never guessed from the other one.
      transport: record.runtimeKind === "claude-agent" ? "claude-handle" : "winter-session",
      status: "exited",
      mode: modeOf(meta.mode),
      ...(meta.cwd === undefined || meta.cwd === null ? {} : { cwd: meta.cwd }),
      generation: record.generation,
      selection: record.selection,
      capabilities: { message: false, resume: false, notifyWhenIdle: false, reply: false },
      updatedAt: new Date().toISOString(),
    });
    return true;
  } catch (err) {
    // Names and the error CLASS only — a directory write's own message can quote the entry it
    // choked on, and an entry carries a selection (this file's own header rule).
    deps.log?.(`handoff: could not materialize the runtime-directory row for ${record.winterSessionId} (${err instanceof Error ? err.name : "unknown"}) — the switch will fail safe rather than apply silently`);
    return false;
  }
}

/**
 * Fix round 3: re-point an EXISTING runtime-directory row at the leg/selection the durable record
 * now names — the half of the barrier's own commit a zero-turn re-selection (which never reaches
 * the barrier) would otherwise leave undone.
 *
 * A PATCH, never a replace: only `runtimeKind`/`selection`/`updatedAt` move, so a row carrying a
 * title, a cwd, a parent address or a staging `configDir` keeps every one of them. Absent row ⇒
 * nothing to do (the next incarnation's own attach writes a fresh, correct one). Best-effort by
 * design: a failure here costs a stale `from` on a SECOND pre-turn switch, never correctness of the
 * switch itself, which rides on the durable record.
 */
async function repointDirectoryRow(deps: HandoffDeps, winterSessionId: string): Promise<void> {
  const directory = deps.runtime.sdk?.directory;
  if (directory === undefined || typeof directory.record !== "function" || typeof directory.get !== "function") return;
  const record = deps.records.get(winterSessionId);
  if (record?.backendSessionId === undefined) return;
  try {
    const address = serializeRuntimeAddress(buildSessionAddress(record.backendSessionId)) as SerializedRuntimeAddress;
    const existing = await directory.get(address);
    if (existing === undefined) return;
    await directory.record({ ...existing, runtimeKind: record.runtimeKind, selection: record.selection, updatedAt: new Date().toISOString() });
  } catch (err) {
    deps.log?.(`handoff: could not re-point the runtime-directory row for ${winterSessionId} (${err instanceof Error ? err.name : "unknown"}) — the next incarnation's own attach rewrites it`);
  }
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
      // Winter Phase 10b (D1-2, W18-7): `providerId`/`modelRef`/`authRef` join the snapshot — the
      // destination-side patch below now writes all three (alongside the four it already patched),
      // so a failed handoff's revert must be able to restore ALL of them, not just the leg triple.
      const before = {
        runtimeKind: fresh.runtimeKind,
        selection: fresh.selection,
        backendSessionId: fresh.backendSessionId,
        providerId: fresh.providerId,
        modelRef: fresh.modelRef,
        authRef: fresh.authRef,
      };
      // Winter Phase 10b (D1-6, W18-4): `target.selection` IS the fresh destination selection now
      // (see `pendingHandoffModelString`'s own doc comment above for why the old side channel for
      // this half is gone) — `barrier.plan(…, { requested: decided })` threads it straight through.
      const destinationSelection = target.selection;
      // `.get`, never `.delete`: `planAndApplySwitch` owns cleanup of the model-string map so a
      // fake-barrier test (which never calls this function at all) cannot leak an entry into a
      // later, unrelated test that reuses the same session id. m2 (fix round 2): keyed by
      // `(sessionId, modelRef)` — `destinationSelection` IS `decided` unmerged (the comment two
      // lines up), so its `modelRef` is guaranteed to match whatever `planAndApplySwitch` set this
      // entry under for THIS specific plan, never a DIFFERENT deferred plan racing the same session.
      const pendingModel = pendingHandoffModelString.get(pendingModelKey(winterSessionId, destinationSelection.modelRef));
      // Winter Phase 10b (D1-2, W18-7): the destination's OWN credential locator — never material,
      // just which account it names (`records.ts`'s own "opaque locator" rule) — mirroring the SAME
      // `credentialRefFor` call `session-driver.ts`'s `create()`/`createOfficial()` already make for
      // a brand-new session. `undefined` when the destination provider has no keychain-backed slot
      // at all (a `custom`/env-backed provider), which explicitly CLEARS the column below rather
      // than leaving the SOURCE's stale locator in place.
      const destinationAuthRef = credentialRefFor(destinationSelection.providerId, deps.home, deps.settings());
      const destinationAuthRefLocator = destinationAuthRef?.kind === "keychain" ? `keychain:${destinationAuthRef.account}` : undefined;
      try {
        // P8d-24: `patch`, never `transition` — this never changes the lifecycle `state`, only the
        // runtime/selection/backendSessionId fields, so it must not be spelled as a transition TO
        // the record's own current state (`ALLOWED_TRANSITIONS` has no self-loop for any state; see
        // `RuntimeSessionRecords.patch`'s own doc comment for why that made this always refuse).
        deps.records.patch(winterSessionId, fresh.state, {
          runtimeKind: to,
          selection: destinationSelection,
          backendSessionId: target.backendSessionId,
          // W18-7: the destination's own identity — a handoff that lands on a different
          // provider/model/credential must not leave the record still naming the SOURCE's.
          providerId: destinationSelection.providerId,
          modelRef: destinationSelection.modelRef,
          authRef: destinationAuthRefLocator,
        });
      } catch (err) {
        return { ok: false, reason: `the record could not be patched to the target leg: ${err instanceof Error ? err.name : "unknown"}` };
      }
      let priorModel: string | undefined;
      try {
        // P10a-h: commit the NEW model to the store BEFORE the destination spawns. The Winter leg's
        // own resume path (`session-driver.ts`'s `assemble()`/`optionsFor()`) reads
        // `store.meta(sessionId).model` FRESH at every incarnation — the exact door `create()` reads
        // for a brand-new session — so a destination child `ensure()`d after this write resolves its
        // OWN correct provider (`providerSelectionFor(model, credentials)`) instead of the SOURCE
        // session's stale, cross-provider one (measured live: an official-leg session's `anthropic`
        // model, still sitting in the store when the freshly-resumed Winter child asked for it,
        // which the Winter runtime cannot serve at all — "exited before init"). A no-op when nothing
        // is pending (no model actually changed — a same-model runtime move, or a unit test driving
        // `confirmInit` directly): `store.model` is left exactly as `target.selection` already
        // implies it should be.
        if (pendingModel !== undefined) {
          priorModel = deps.store.meta(winterSessionId).model;
          deps.store.setModel?.(winterSessionId, pendingModel);
        }
        // P10a-h (measured live against the real winter binary): the SDK's own barrier already
        // awaits the SOURCE owner's `close()` (WS-05 §12 step 6) before this step runs, but a
        // process's OWN lock release can lag its wrapper's belief that it is gone — measured as the
        // destination child dying "before init" with the winter runtime's own `ResumeTargetError:
        // session <id> is in use by another live process (pid …); refusing to resume it
        // concurrently". A bounded retry absorbs exactly that transient window; it does nothing for
        // a genuine, persistent refusal (a real provider/model mismatch fails identically on every
        // attempt and the loop still reports it, just slower).
        let initCheck: { ok: true } | { ok: false; reason: string } = { ok: false, reason: "no attempt was made" };
        for (let attempt = 1; attempt <= 3; attempt++) {
          await deps.winter.evict(winterSessionId);
          const opened = await deps.winter.ensure(winterSessionId);
          if (opened === undefined) { initCheck = { ok: false, reason: "no driver could be opened on the target leg" }; }
          else {
            initCheck = await awaitDestinationInit(opened, deps.confirmInitTimeoutMs?.() ?? DEFAULT_CONFIRM_INIT_TIMEOUT_MS);
          }
          if (initCheck.ok || attempt === 3) break;
          await Bun.sleep(150);
        }
        if (!initCheck.ok) throw new Error(initCheck.reason);
        return { ok: true, producer: { sdkVersion: destinationSelection.sdkVersion, engineVersion: destinationSelection.engineVersion } };
      } catch (err) {
        // Winter Phase 10b (D1-2, W18-6): evict the DESTINATION driver this very attempt just
        // registered (the retry loop above's own `evict()`+`ensure()` leaves a live — or freshly
        // dead — entry in the driver table under `winterSessionId`) BEFORE reverting the record.
        // `WinterSessionDrivers.ensure()` returns an already-registered table entry FIRST, without
        // ever consulting the record, so leaving a dead destination driver behind here would make
        // the very next `ensure()` call (against the record this catch is about to revert to the
        // SOURCE leg) hand back that same dead driver instead of re-assembling the source — exactly
        // the measured "exited before init" / stale `providerId` defect this lane fixes (see
        // `handoff-official-to-winter-e2e.test.ts`'s own header). `evict()` is documented to never
        // throw (`session-driver.ts`), so no extra try/catch is needed around it, unlike the record
        // and store reverts below, which touch state this catch does not control.
        await deps.winter.evict(winterSessionId);
        try {
          // P10a-h (measured against the real winter binary): a destination attempt that spawns and
          // then dies is not a no-op on the record — the dying incarnation ends its OWN generation,
          // which legitimately moves the record's lifecycle `state` (e.g. `ready` -> `exited`) as a
          // real side effect of the very attempt this catch is unwinding. Reverting against the
          // STALE `fresh.state` snapshot from before that attempt made `RuntimeSessionRecords.patch`
          // itself refuse the revert (`RuntimeSessionStateMismatchError`) — worse than the original
          // failure, since the record was then stuck naming a leg its own destination attempt had
          // already proven cannot run. Re-read fresh, right before reverting, exactly as the m4
          // window guard at the top of this function already does before the FORWARD patch.
          const current = deps.records.get(winterSessionId);
          if (current === undefined) {
            deps.log?.(`handoff: confirmInit failed AND the record for ${winterSessionId} no longer exists to revert`);
          } else {
            deps.records.patch(winterSessionId, current.state, before);
          }
        } catch (revertErr) {
          deps.log?.(`handoff: confirmInit failed AND the record revert for ${winterSessionId} also failed (${revertErr instanceof Error ? revertErr.name : "unknown"}) — the record may now name a leg it cannot run on`);
        }
        if (pendingModel !== undefined) {
          try {
            deps.store.setModel?.(winterSessionId, priorModel ?? null);
          } catch (revertErr) {
            deps.log?.(`handoff: confirmInit failed AND the store model revert for ${winterSessionId} also failed (${revertErr instanceof Error ? revertErr.name : "unknown"})`);
          }
        }
        // `.message` (never `.name`): a plain `new Error("…")` — this function's own two new throws,
        // plus the pre-existing "no driver could be opened" one — has an uninformative `name`
        // ("Error"); the descriptive text is only ever in `.message`. No existing caller/test reads
        // this `reason` looking for a bare class name.
        return { ok: false, reason: err instanceof Error ? err.message : "unknown" };
      }
    },
  };
}

/**
 * WS-05 §12's Lane D door: builds the `SelectionInput` `barrier.plan()` reviews destination
 * servability against, using `WinterRuntimeSdk.buildSelectionInput` — the SAME real catalog/
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
 * `WinterRuntimeSdk` that does not implement it) — `registerHandoffParticipants` below omits the key
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
  // Fix round 2 (C1, belt-and-braces): `decided` is the FRESH selection `planAndApplySwitch` chose
  // for this move — present ONLY when a real leg decision actually ran (the router's
  // `selectRuntimeFor`/review), never on the early bail-outs (`model === null`, no record, an
  // engine-era row, a `winter-test/*` double, an off-catalog model) that never touch the router at
  // all. `ipc/server.ts` uses it to keep the 8a record's `selection`/`providerId`/`modelRef`/
  // `authRef` in step with an applied SAME-LEG family change (gpt -> deepseek on Winter), which
  // never goes through `confirmInit`'s own record patch (that only fires on a cross-runtime move).
  | { kind: "same-runtime"; decided?: RuntimeSelection } // an ordinary in-runtime model change — the caller's existing path
  | { kind: "refused"; code: "runtime_selection_refused" | "session_predates_winter_leg" | "handoff_disabled"; detail: string }
  // Winter Phase 10b (D1-6, W18-22): `portable` names what the pre-flight review found still
  // carries (`SwitchClassification.portable`) — additive alongside `warnings`, `[]` when the review
  // itself is unreachable (no sessionKey/barrier) or found nothing portable to name.
  | { kind: "confirmation_required"; warnings: string[]; portable: string[] }
  | { kind: "deferred" } // a turn is running; the switch is applied when it settles
  | { kind: "resumed"; selection: RuntimeSelection }
  // Fix round 4 (MAJOR 2): `step` rides along — the router's own `HandoffStepNumber` for the step
  // that could not be proven. It is the TYPED half of `isNoCanonicalTranscriptFork`'s match (the
  // router exposes no reason code), so the one refusal a re-selection may answer — step 5's
  // "there is no transcript at all to validate" — can be told apart from every other fork,
  // including the other four step-5 reasons, which all describe a transcript that EXISTS and is
  // damaged. Optional so a test fake that omits it still type-checks; `undefined` is treated as
  // "unknown step", which the message match then has to carry alone.
  | { kind: "lossy_fork"; reason: string; step?: number }
  // Fix round 2 (M1, router 0.0.6): `detail` is the router's own OWN human-readable explanation
  // (`DetailedHandoffOutcome.detail` — the pinned `HandoffOutcome` union has no room for it, but the
  // concrete object the barrier hands back always carries it). NEVER surfaced to the user raw
  // (R-10b-4 also covers this: it may name router/SDK internals) — `ipc/server.ts` logs it (names
  // only) and renders its OWN generic copy instead.
  | { kind: "blocked"; reason: string; detail?: string };

/** WS-13 §8.2's warning list: a plan step the barrier already knows is unprovable (a lossy step) —
 *  the concrete case named there is a source carrying reasoning state moving to a foreign target,
 *  which surfaces as exactly this on the source's own drain/validation steps. */
function warningsOf(plan: HandoffPlan): string[] {
  return plan.steps.flatMap((s) => (s.knownUnprovable !== undefined ? [s.knownUnprovable] : []));
}

/**
 * Winter Phase 10b (D1-7, W18-3): the no-credential refusal's hint, built FROM the router's own
 * `alternatives` — never a hardcoded provider list, so a catalog change (a new Claude-serving
 * gateway) widens the hint automatically. Each door names ITS OWN way in:
 *   - `anthropic`/`api-key` → `winter login --anthropic-key`;
 *   - `anthropic`/`console-profile` → `winter login --anthropic-console`;
 *   - `anthropic`/`claude-oauth` (the claude.ai subscription door) → only rendered when
 *     `opts.subscriptionEnabled` is true (the daemon's OWN `officialSubscriptionAuthEnabled` gate — a
 *     second, daemon-owned check independent of the router's own D14 compile-time approval that
 *     already governs whether this alternative is even IN the list at all);
 *   - every other alternative (OpenRouter, Bedrock, Vertex, …) → the app's Providers settings.
 * Never names an SDK or runtime (R-10b-4) — a test pins this with a regex that excludes only the
 * literal CLI flags/setting path this function itself prints.
 */
/**
 * Fix round 4 (item 5, reviewer): a refusal's `detail` is the ROUTER's own sentence, and the router
 * writes it for a developer, not for this product's user. Measured against the pinned selector:
 * `"… must run on the official runtime under a Claude OAuth credential, and this router holds no
 * official runtime; a Claude OAuth credential never routes to the Winter runtime (D28)"`, and
 * `reviewPersistedSelection`'s own `"this session is persisted on claude-agent (…) … (WS-00 §2,
 * D13)"`. Both name a RUNTIME, which R-10b-4 forbids outright ("never warn about which SDK serves a
 * Claude model"), and both cite internal spec ids. `session.setModel` was surfacing them verbatim.
 *
 * So the raw detail is logged as a CATEGORY and never as text (this file's own logging discipline),
 * and the user gets copy this file owns. The `no-credential` arm keeps its full hint, because that
 * hint is BUILT here (`renderNoCredentialHint`) out of the router's structured `alternatives` and is
 * already pinned by a test that forbids it naming an SDK or a runtime — it is the one refusal whose
 * text is actionable, and losing it would leave the user with no way to find the door.
 */
function refusalDetailCategoryFor(detail: string): "names-a-runtime" | "names-a-spec-id" | "opaque" {
  if (/\b(winter|official|claude)[- ]?(runtime|agent)\b/i.test(detail)) return "names-a-runtime";
  if (/\b(WS-\d|D\d{1,2}\b|R-\d)/.test(detail)) return "names-a-spec-id";
  return "opaque";
}

export function renderNoCredentialHint(alternatives: readonly SelectionAlternative[], opts: { subscriptionEnabled: boolean }): string {
  const doors: string[] = [];
  for (const alt of alternatives) {
    if (alt.providerId === "anthropic" && alt.authKind === "api-key") {
      doors.push(`${alt.label}: run \`winter login --anthropic-key\``);
    } else if (alt.providerId === "anthropic" && alt.authKind === "console-profile") {
      doors.push(`${alt.label}: run \`winter login --anthropic-console\``);
    } else if (alt.providerId === "anthropic" && alt.authKind === "claude-oauth") {
      if (opts.subscriptionEnabled) doors.push(`${alt.label}: sign in from the app's Providers settings`);
    } else {
      doors.push(`${alt.label}: add a credential from the app's Providers settings`);
    }
  }
  if (doors.length === 0) return "no door is currently available for this model — add a credential from the app's Providers settings";
  return `add one of these to use this model — ${doors.join("; ")}`;
}

async function executePlan(deps: HandoffDeps, plan: HandoffPlan): Promise<PlanSwitchOutcome> {
  const barrier = barrierFor(deps);
  if (barrier === undefined) return { kind: "blocked", reason: "the handoff barrier is unavailable on this runtime handle" };
  const outcome: HandoffOutcome = await barrier.execute(plan);
  switch (outcome.kind) {
    case "resumed":
      return { kind: "resumed", selection: outcome.selection };
    case "lossy-fork-offered":
      return { kind: "lossy_fork", reason: outcome.reason, step: outcome.step };
    case "blocked": {
      // Fix round 2 (M1, router 0.0.6): the pinned `HandoffOutcome` union has no room for `detail`,
      // but the concrete object the barrier hands back always carries it (`DetailedHandoffOutcome`
      // — that type's own doc: "widened with the detail the pinned union has no room for. Assignable
      // to it."). Read defensively (`typeof === "string"`) rather than assuming every barrier
      // implementation (including this file's own test fakes) populates it.
      const detail = (outcome as DetailedHandoffOutcome).detail;
      return { kind: "blocked", reason: outcome.reason, ...(typeof detail === "string" ? { detail } : {}) };
    }
  }
}

/**
 * m5 (whole-branch review, fix round 2): user-facing copy never interpolates a raw, possibly-empty
 * model string — `session.setModel({model: null})` (clearing an override, reverting to the
 * session's default) is intercepted by `planAndApplySwitch`'s own unconditional early return below
 * BEFORE either warning site that names the requested model is ever reached, so neither can print
 * a literal "null" today; this exists so a future refactor that loosens that early return (or a
 * caller that passes `""` rather than `null` for the identical "no override" intent) still renders
 * something a user can read, never a blank or a stray `null`.
 */
export function modelLabelFor(model: string): string {
  return model.length > 0 ? model : "the default model";
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
    // Winter Phase 10b (D1-7, W18-3): a `no-credential` refusal carries `alternatives` — the
    // router's own list of every catalog row able to serve the requested model, whichever door.
    // The hint is built FROM that list, never a hardcoded provider list, so a catalog change
    // widens it automatically; `officialSubscriptionAuthEnabled` is the daemon's OWN gate on the
    // claude.ai subscription door, independent of the router's own D14 compile-time approval that
    // already governs whether that alternative is even in the list at all.
    //
    // Fix round 4 (item 5): `decided.detail` itself NEVER reaches the user — see
    // `refusalDetailCategoryFor` for the two measured shapes that name a runtime or a spec id. The
    // no-credential hint DOES, because this file builds it out of the router's structured
    // `alternatives` and a test pins that it never names an SDK or a runtime.
    deps.log?.(`handoff: selectRuntimeFor refused ${modelLabelFor(model)} for ${sessionId} (reason=${decided.reason}, detail=${refusalDetailCategoryFor(decided.detail)})`);
    if (decided.reason === "no-credential" && decided.alternatives !== undefined) {
      return {
        kind: "refused",
        code: "runtime_selection_refused",
        detail: `Winter can't switch to ${modelLabelFor(model)} yet — ${renderNoCredentialHint(decided.alternatives, { subscriptionEnabled: officialSubscriptionAuthEnabled(deps.settings()) })}`,
      };
    }
    return { kind: "refused", code: "runtime_selection_refused", detail: `Winter can't switch to ${modelLabelFor(model)} right now.` };
  }
  // m1 (whole-branch review, fix round 2): the `crossRuntime` off switch gates CROSS-LEG moves
  // ONLY, and must be checked HERE — before the pre-flight review/prompt below — never after it.
  // Checking it after the review let a deployment with the switch OFF see "Switch model?" (a real,
  // reviewed prompt backed by `confirmLossy`) and then get refused typed anyway the moment it
  // resent with `confirmLossy: true`: a prompt that lied about what confirming would do. Same-leg
  // moves (gpt -> deepseek on Winter) are NEVER gated by this setting and always reach the review
  // below exactly as before — computed once, right here, since both `decided` and `currentLeg` are
  // already known and nothing below this point changes either.
  const isSameLeg = legOfRuntimeKind(decided.runtimeKind) === currentLeg;
  if (!isSameLeg && !handoffCrossRuntimeEnabled(deps.settings(), mode)) {
    // Never names a runtime (R-10b-4) — this is reached only for an actual cross-runtime refusal
    // (a same-leg change never reaches this branch at all, `isSameLeg` above already excludes it).
    return {
      kind: "refused",
      code: "handoff_disabled",
      detail: `switching this session to ${modelLabelFor(model)} is turned off (settings.runtimes.handoff.crossRuntime)`,
    };
  }
  // Winter Phase 10b (D1-6, W18-4/W18-20/W18-21; P10b-1/2): the ONE pre-flight review, for EVERY
  // provider/model change, BEFORE the same-runtime shortcut below — a same-LEG family crossing
  // (gpt -> deepseek, both on Winter) never reaches the barrier's `plan()`/`execute()` at all (it
  // settles as `same-runtime`, the caller's own ordinary store write), so if the review ran only
  // AFTER that shortcut it would never see same-leg switches, and W18-21 prompts for exactly those
  // too ("every move away from GPT, Claude or Gemini to a different family"). The ROUTER decides
  // every skip (same-profile/same-family/zero-source-turns) via its OWN `reviewSwitch` — this
  // function never computes families itself, per the Interfaces block's own words.
  //
  // Skipped ENTIRELY (no review, no prompt) only when there is nothing to review against yet: no
  // backend transcript (`sessionKeyFor` — the same "session_predates_winter_leg" shape the barrier
  // call below already refuses on) or no reachable barrier (a hand-built `WinterRuntimeSdk` test
  // double with no `.sdk` the router's own `runtimeSdkInternals` WeakMap recognises, and no
  // `deps.barrier` override — `barrierFor`'s own two-source doc). Neither case is new: a same-leg
  // change with no sessionKey already fell through to `same-runtime` pre-10b (nothing to hand off
  // from), and a cross-runtime change with no sessionKey/barrier still refuses typed below exactly
  // as it always has — this review is simply reached first when both ARE available.
  const sessionKey = sessionKeyFor(record);
  const barrier = barrierFor(deps);
  // P10b-2's own zero-turn carve-out: a session with no backend transcript at all has no source
  // turns for the review to weigh (`sessionKeyFor` returning `undefined` is exactly "this session
  // has no backend transcript to hand off from" — the same fact the `session_predates_winter_leg`
  // refusal below is about). Skipped ENTIRELY (no review, no prompt) rather than routed through the
  // fail-safe catch below: this is a KNOWN, provable "nothing to lose" case, not an unreviewable one.
  /**
   * Fix round 3 (item 1a): at most ONE materialize attempt per `planAndApplySwitch` call, shared by
   * the review's catch and `plan()`'s. `undefined` = not tried yet; a boolean = the answer, so the
   * plan catch never re-attempts a write the review already made (or already failed to make).
   */
  let materialized: boolean | undefined;
  const materializeOnce = async (): Promise<boolean> => {
    if (materialized === undefined) materialized = await materializeDirectoryRow(deps, record);
    return materialized;
  };
  /**
   * A ZERO-TURN SESSION IS RE-SELECTED, NOT HANDED OFF — and re-selection is a REAL write, not
   * round 2's no-op.
   *
   * The real router VALIDATES the canonical transcript at WS-05 §12 step 5, and a session that has
   * never run a turn has no file to validate — `validateSessionTranscript` answers
   * `there is no canonical transcript at <path> to validate` and the barrier turns that into
   * `lossy(5, …)` (MEASURED; the router builds the fork's own `reason` by interpolating that path,
   * which `session.setModel` was surfacing to the user verbatim). A "fork" that would lose nothing
   * is not a fork, and R-10b-8/P10b-2 say that switch must still land, silently. What it needs is
   * not a handoff but a change of which leg the NEXT incarnation opens on — exactly the two fields
   * `session-driver.ts`'s `resume()`/`resumeOfficial()` route by. So: patch the record to `decided`,
   * EVICT the driver (without it `ensure()` hands back the already-registered table entry for the
   * OLD leg without ever consulting the record), re-point the directory row.
   *
   * ⚠️ FIX ROUND 4, MAJOR 1 — RECOMPUTED HERE, NEVER SNAPSHOT. Round 3 read the router's
   * `skipped === "no-source-turns"` once, at review time, and carried it down. That verdict goes
   * stale in two measured ways: (a) on the DEFERRED path the review runs while the first turn is
   * still streaming, and by the time `idle()` resolves the turn is real — re-selecting then commits
   * `meta.model` over a transcript the barrier never staged; (b) `switchFactsFor` counts assistant
   * entries SINCE THE LAST COMPACTION BOUNDARY, so every compacted session reports 0 until its next
   * assistant reply, and a long conversation would have been silently re-selected past its staging.
   * So the verdict is re-asked HERE, at execution time (the directory row exists by now, which is
   * why this can ask at all), and anything but a FRESH `no-source-turns` refuses: a throw, a
   * `same-family`/`same-profile` skip, or a real classification all mean "do not re-select".
   *
   * ⚠️ FIX ROUND 4, NIT 5 — PATCH FIRST, EVICT ONLY ON SUCCESS. A patch that throws used to be
   * logged and the driver evicted anyway, so the caller's invariant check then told the user "the
   * session stays on <model>" after its live incarnation had already been killed.
   *
   * `undefined` = "not re-selectable"; every caller then takes its own fail-safe branch. A returned
   * outcome is `same-runtime` with `decided`, so the caller's 1c invariant check re-reads the record
   * and turns a patch that did not land into a typed `blocked` rather than a false success.
   */
  const tryReselectWithNothingToCarry = async (
    barrier: HandoffBarrier,
    sessionKey: SessionKey,
  ): Promise<PlanSwitchOutcome | undefined> => {
    let fresh: SwitchReview;
    try {
      fresh = await barrier.reviewSwitch(sessionKey, decided);
    } catch (err) {
      deps.log?.(`handoff: the execution-time re-review threw for session ${sessionId} (${err instanceof Error ? err.name : "unknown"}) — refusing to re-select`);
      return undefined;
    }
    if (fresh.skipped !== "no-source-turns") return undefined;
    try {
      const current = deps.records.get(sessionId);
      if (current === undefined) return undefined;
      const destinationAuthRef = credentialRefFor(decided.providerId, deps.home, deps.settings());
      const destinationAuthRefLocator = destinationAuthRef?.kind === "keychain" ? `keychain:${destinationAuthRef.account}` : undefined;
      deps.records.patch(sessionId, current.state, {
        runtimeKind: decided.runtimeKind,
        selection: decided,
        providerId: decided.providerId,
        modelRef: decided.modelRef,
        authRef: destinationAuthRefLocator,
      });
    } catch (err) {
      // Nit 5: the live incarnation is left ALONE — nothing moved, so nothing is killed.
      deps.log?.(`handoff: the zero-turn re-selection patch failed for ${sessionId} (${err instanceof Error ? err.name : "unknown"}) — the live incarnation is left running and the switch is refused`);
      return undefined;
    }
    await deps.winter.evict(sessionId);
    // The barrier's own commit would have flipped the directory row's `runtimeKind` too; a
    // re-selection skipped the barrier, so this does that half by hand. It matters for exactly one
    // case: a SECOND pre-turn switch, whose review reads `entry.runtimeKind` as its `from` — a
    // stale one would name a leg this session no longer runs on. Ordered AFTER the evict, so no
    // live child on the source leg is still attached to the row being re-pointed, and best-effort
    // throughout (a park landing after it simply rewrites the row, and the very next incarnation's
    // own attach rewrites it again).
    await repointDirectoryRow(deps, sessionId);
    return { kind: "same-runtime", decided };
  };
  /** The generic fail-safe review (fix round 1's MAJOR): unreviewable ⇒ PROMPT, never silent. */
  const unreviewablePrompt = (): SwitchReview => ({
    prompt: true,
    classification: {
      lossClass: "warned-lossy",
      warnings: [`Winter couldn't check what carries over to ${modelLabelFor(model)}. The conversation carries over; reasoning private to the current model may not.`],
      portable: [],
    },
  });
  if (sessionKey !== undefined && barrier !== undefined) {
    let review: SwitchReview;
    try {
      review = await barrier.reviewSwitch(sessionKey, decided);
    } catch (err) {
      // Fix round 3 (the round-2 CRITICAL — see `isNotYetInRuntimeDirectory`'s own ⚠️): the
      // "not in the runtime directory" shape means the ROUTER cannot see this session, never that
      // the session has nothing to lose. `sessionKeyFor` is satisfied by `record.backendSessionId`,
      // written synchronously long before the first frame ever writes the directory row, so this
      // shape is reachable by a session WITH turns (an engine-era import above all) — mapping it to
      // `{prompt: false}` is what made a cross-leg move in that window apply silently onto a record
      // that still routed to the OLD leg. So: MATERIALIZE the row from the durable record (every
      // fact the barrier needs is already in `runtime_sessions`) and ask the router again, ONCE. A
      // genuinely zero-turn session then gets the router's OWN `zero-source-turns` skip — the real
      // P10b-2 carve-out, decided by the component that can actually count the turns — and an
      // imported session with turns gets a real, honest review. If materializing is impossible (no
      // directory facet, no backend id) or the retry still throws, the switch is UNREVIEWABLE and
      // falls into fix round 1's generic fail-safe prompt below; it is never waved through.
      if (isNotYetInRuntimeDirectory(err) && (await materializeOnce())) {
        try {
          review = await barrier.reviewSwitch(sessionKey, decided);
        } catch (retryErr) {
          deps.log?.(`handoff: reviewSwitch still threw for session ${sessionId} after its runtime-directory row was materialized (${retryErr instanceof Error ? retryErr.name : "unknown"}) — treating the switch as unreviewable and prompting`);
          review = unreviewablePrompt();
        }
      } else {
        // Fix round 1 (MAJOR, controller ruling): `reviewSwitch` can throw (a transient store or
        // sidecar read error) — an unreviewable switch must never be waved through silently NOR
        // refused outright (R-10b-0: a cross-family move MUST work), so this fails safe as a PROMPT
        // rather than propagating the rejection into an RPC-level INTERNAL error. `confirmLossy: true`
        // still applies it, exactly like any other prompt. Logged ONCE, names and the error CLASS
        // only — never `err.message`, which could embed opaque provider state or other payload text
        // this file's own header forbids logging.
        deps.log?.(`handoff: reviewSwitch threw for session ${sessionId} (${err instanceof Error ? err.name : "unknown"}) — treating the switch as unreviewable and prompting instead of refusing or applying it silently`);
        review = unreviewablePrompt();
      }
    }
    // Fix round 4 (MAJOR 1): this review's verdict is used for THIS decision only — whether to
    // prompt — and is deliberately NOT carried down to the execution path. Round 3 kept
    // `review.skipped === "no-source-turns"` in a `zeroSourceTurns` field and read it after the
    // barrier ran; that snapshot goes stale on the deferred path (the turn that was streaming when
    // this ran has completed by then) and is wrong for every compacted session (`switchFactsFor`
    // counts assistant entries only SINCE THE LAST BOUNDARY, so a long conversation reports 0 until
    // its next reply). `tryReselectWithNothingToCarry` re-asks the router instead.
    if (review.prompt && !confirmLossy) {
      return {
        kind: "confirmation_required",
        warnings: review.classification?.warnings ?? [],
        portable: review.classification?.portable ?? [],
      };
    }
  }
  if (isSameLeg) {
    // Fix round 2 (C1, belt-and-braces): keep the 8a record's identity columns in step with an
    // APPLIED same-leg family change (gpt -> deepseek on Winter) — `confirmInit`'s OWN identical
    // patch (this file's own doc on it, above) only fires on a CROSS-runtime move, so without this
    // a same-leg switch away from the family the session was CREATED with left `selection`/
    // `providerId`/`modelRef`/`authRef` naming the ORIGINAL family forever, even though the session
    // actually runs `decided`'s — stale for `session.list`, a cold resume, `winter doctor`, and
    // anything else that reads the record. Router 0.0.6 already fixed `reviewSwitch`'s OWN read
    // (the live tip's identity, never the stale persisted selection) — this is belt-and-braces for
    // everything ELSE.
    //
    // ⚠️ FIX ROUND 3 (the 1c INVARIANT): this patch is no longer cosmetic. A failure here is still
    // logged rather than thrown, but it is no longer "the switch still applied" — `decided` rides
    // out on this outcome and `ipc/server.ts`'s `same-runtime` arm now REFUSES to write
    // `meta.model` unless the record it re-reads actually names `decided` (`recordNamesSelection`).
    // A patch that failed therefore surfaces as a typed `blocked` there, never as a success over a
    // record that disagrees.
    // Winter Phase 10b (D1 fix round 4, item 6 — Lane P's product finding). Captured BEFORE the C1
    // patch below overwrites it: the provider the LIVE child was actually spawned against.
    const providerBeforeSwitch = deps.records.get(sessionId)?.providerId;
    try {
      const current = deps.records.get(sessionId);
      if (current !== undefined) {
        const destinationAuthRef = credentialRefFor(decided.providerId, deps.home, deps.settings());
        const destinationAuthRefLocator = destinationAuthRef?.kind === "keychain" ? `keychain:${destinationAuthRef.account}` : undefined;
        deps.records.patch(sessionId, current.state, {
          selection: decided,
          providerId: decided.providerId,
          modelRef: decided.modelRef,
          authRef: destinationAuthRefLocator,
        });
      }
    } catch (err) {
      deps.log?.(`handoff: C1 same-leg record patch failed for ${sessionId} (${err instanceof Error ? err.name : "unknown"}) — the caller's own invariant check will refuse the switch rather than let meta.model and the record disagree`);
    }
    // ══════════════════════════════════════════════════════════════════════════════════════════
    // Fix round 4, ITEM 6 — A SAME-LEG SWITCH THAT CHANGES PROVIDER MUST REACH THE CHILD.
    //
    // Lane P's product finding, newly reachable now that a second provider is actually routable
    // (W19-1's derived inventory + W19-6's per-provider `baseUrl` seam): a live Winter child's
    // `Options.provider`/`connection` is FIXED AT SPAWN — `session-driver.ts`'s `optionsFor` builds
    // it once, per incarnation. A same-leg model change (`openai/gpt-4.1` ->
    // `openrouter/openai/gpt-4.1`, or gpt -> deepseek) is answered `same-runtime`, the store write
    // lands, `Query.setModel` tells the child its new MODEL — and the child keeps posting to the
    // OLD endpoint, with the OLD credential, until an idle reap or a daemon restart happens to
    // replace it. Silently: nothing errors, and the model name in `session.list` is already right.
    //
    // A MODEL change stays hot, exactly as before — `Query.setModel` is the whole mechanism for it,
    // and evicting for every model change would throw away a warm child for nothing. Only a
    // PROVIDER change needs a new incarnation, because only the provider is baked into the spawn.
    //
    // A RUNNING TURN IS NEVER INTERRUPTED: the evict waits for the same idle boundary the barrier's
    // own drain step would have waited for. The turn in flight legitimately finishes on the old
    // provider — it was issued there — and the NEXT one re-spawns. Fire-and-forget for the same
    // reason the deferred handoff below is: `session.setModel` never delays its reply.
    //
    // `evict()` ends the child RESUMABLY (it is `end()`, not a kill) and is documented never to
    // throw, so the next `send`/`ensure` re-assembles from the record and the transcript — the same
    // mechanism `tryReselectWithNothingToCarry` relies on, and the same one an idle reap uses.
    if (providerBeforeSwitch !== undefined && providerBeforeSwitch !== decided.providerId) {
      const liveChild = deps.winter.get(sessionId);
      if (liveChild !== undefined) {
        if (liveChild.turnRunning === true) {
          deps.log?.(`handoff: ${sessionId} changed provider (${providerBeforeSwitch} -> ${decided.providerId}) while a turn was running — the child will be replaced at the next idle boundary`);
          void liveChild.idle().then(
            () => deps.winter.evict(sessionId),
            () => { /* the session ended before settling — nothing left to replace */ },
          );
        } else {
          deps.log?.(`handoff: ${sessionId} changed provider (${providerBeforeSwitch} -> ${decided.providerId}) — replacing its child so the next turn spawns against the new endpoint`);
          await deps.winter.evict(sessionId);
        }
      }
    }
    return { kind: "same-runtime", decided };
  }
  // C2 fence (whole-branch review / ruling P8c-18); Winter Phase 10b (D1-1, W18-10): the
  // `crossRuntime` off-switch check itself now lives ABOVE the review (m1, fix round 2) — this
  // point is reached only when a cross-leg move already passed that gate, so nothing more to
  // refuse here on that account. Same-runtime model changes (the branch above) were never gated by
  // it at all.
  if (sessionKey === undefined) {
    return { kind: "refused", code: "session_predates_winter_leg", detail: "this session has no backend transcript to hand off from" };
  }
  if (barrier === undefined) return { kind: "blocked", reason: "the handoff barrier is unavailable on this runtime handle" };
  // W18-4: `requested: decided` carries the FRESH selection straight through to
  // `plan.selection.selection` (and from there to `confirmInit`'s `target.selection`) — see
  // `pendingHandoffModelString`'s own doc comment for what this replaces and why one piece of the
  // old side channel still has no other pipe.
  let plan: HandoffPlan;
  try {
    plan = await barrier.plan(sessionKey, decided.runtimeKind, { requested: decided });
  } catch (err) {
    // Fix round 3 (the round-2 CRITICAL): the SAME "not in the runtime directory" shape
    // `reviewSwitch` can throw can ALSO throw here, from `plan()`. Round 2 answered it with
    // `{kind: "same-runtime", decided}` — which `ipc/server.ts` treats exactly like `resumed` and
    // follows with the ordinary `store.setModel` write. That was the CRITICAL: no handoff ran, so
    // the record's `runtimeKind`/`selection` still named the SOURCE leg while `meta.model` named
    // the destination's model, and `session-driver.ts`'s `resume()` (which routes on
    // `record.runtimeKind` and never re-reads `meta.model` for the leg) kept running the OLD leg
    // forever. Silent, invisible, and strictly worse than the pre-fix refusal.
    //
    // Now: materialize the row from the durable record and plan ONCE more. The retry gives a real
    // handoff — `confirmInit` patches the record, so the invariant actually holds afterwards. If
    // materializing is impossible or the retry still throws, this is a `blocked`, which
    // `ipc/server.ts` renders with its neutral "couldn't finish switching models; the session
    // stays on <current model>" copy and NO store write. Never a silent success.
    //
    // Fix round 4 (MAJOR 2): NONE of these arms re-selects any more. A `plan()` that throws says
    // nothing about whether the session has anything to lose — round 3 answered three of them with
    // a re-selection gated on a stale review-time snapshot, which is exactly the class the review
    // rejected. The ONE refusal a re-selection may answer is the barrier's own step-5
    // "there is no canonical transcript at all" fork, handled where `execute` returns it, below.
    if (isNotYetInRuntimeDirectory(err)) {
      if (!(await materializeOnce())) {
        return { kind: "blocked", reason: "the session is not in the runtime directory and its row could not be rebuilt from the durable record" };
      }
      try {
        plan = await barrier.plan(sessionKey, decided.runtimeKind, { requested: decided });
      } catch (retryErr) {
        deps.log?.(`handoff: plan() still threw for session ${sessionId} after its runtime-directory row was materialized (${retryErr instanceof Error ? retryErr.name : "unknown"})`);
        return { kind: "blocked", reason: "the session could not be planned for a handoff even after its runtime-directory row was rebuilt" };
      }
    } else {
      throw err;
    }
  }
  if (plan.selection.kind === "refused") {
    // Fix round 4 (item 5): the barrier's own persisted-selection review writes this detail, and its
    // measured text names both runtime kinds and cites `WS-00 §2, D13` — R-10b-4 forbids every word
    // of that reaching the user. Category only in the log, neutral copy out.
    deps.log?.(`handoff: the barrier refused the destination selection for ${sessionId} (detail=${refusalDetailCategoryFor(plan.selection.detail)})`);
    return { kind: "refused", code: "runtime_selection_refused", detail: `Winter can't switch to ${modelLabelFor(model)} right now.` };
  }
  const warnings = warningsOf(plan);
  if (warnings.length > 0 && !confirmLossy) {
    // W18-21's OTHER prompt trigger — the barrier's own step-level fork markers (unchanged meaning
    // from pre-10b) — carries no loss-review `portable` list of its own.
    return { kind: "confirmation_required", warnings, portable: [] };
  }
  // Winter Phase 10b (D1-6): the RAW, as-typed model string — never `decided.modelRef` — is the one
  // thing `confirmInit` still has no other pipe for (`pendingHandoffModelString`'s own doc comment).
  // Set immediately before driving the barrier (never earlier: every early `return` above this line
  // — refused, handoff_disabled, confirmation_required — must leave nothing pending) and always
  // cleared by THIS call, never left for `confirmInit` to clean up, so a fake-barrier test that
  // never reaches `confirmInit` at all cannot leak an entry into a later, unrelated test reusing
  // the same id. m2 (fix round 2): keyed by `(sessionId, decided.modelRef)`, not `sessionId` alone —
  // see the map's own doc comment for why a bare session key let two deferred cross-leg calls
  // racing the same running turn clobber each other's pending string.
  const pendingKey = pendingModelKey(sessionId, decided.modelRef);
  pendingHandoffModelString.set(pendingKey, model);
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
              // Fix round 3 (the 1c INVARIANT, this path's own half): `ipc/server.ts`'s guard
              // cannot cover this write — the RPC returned `{}` at defer time, long before this
              // continuation ran — so the identical check lives here, over the SAME
              // `recordNamesSelection` predicate. A `resumed` whose record does not name the
              // destination means `confirmInit` did not actually land it; writing `meta.model`
              // anyway would leave exactly the disagreement this invariant exists to forbid, and
              // silently. Log-only, because there is no longer a caller to refuse to.
              if (!recordNamesSelection(deps.records.get(sessionId), outcome.selection)) {
                deps.log?.(`deferred handoff for ${sessionId} reported resumed but the durable record does not name the destination leg/selection — the model preference is NOT committed`);
                return;
              }
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
              // Fix round 4 (MAJOR 1 + MAJOR 2): the deferred half of the immediate path's own
              // zero-turn re-selection, and THE path the review measured as a regression. Two
              // narrowings, both load-bearing here:
              //   MAJOR 2 — only the step-5 "there is no canonical transcript at all" fork, never a
              //     `blocked` (revert-pending / lease-held / repair-required all mean unfinished
              //     state is owed) and never another fork reason.
              //   MAJOR 1 — the zero-turn verdict is RE-ASKED inside `tryReselectWithNothingToCarry`.
              //     This continuation runs after `idle()`, i.e. after the very turn that was
              //     streaming when the review ran: the review-time snapshot said "no source turns"
              //     and by now there IS one, so the snapshot would have committed `meta.model` over
              //     a transcript the barrier never staged. A fresh review refuses, and this falls
              //     through to the log line above — round-2 semantics, no write.
              if (isNoCanonicalTranscriptFork(outcome)) {
                return void tryReselectWithNothingToCarry(barrier, sessionKey).then((reselected) => {
                  if (reselected === undefined) return;
                  if (recordNamesSelection(deps.records.get(sessionId), decided)) deps.store.setModel?.(sessionId, model);
                });
              }
            }
          },
          // Fix round 4 (MAJOR 2): a THROWING `barrier.execute` reaches here on the deferred path.
          // Round 3 re-selected on it for a "zero-turn" session; a throw is not the step-5
          // no-transcript fork and says nothing about what the session has to lose, so it is now
          // log-only — round-2 semantics, no store write, the record untouched.
          (err: unknown) => deps.log?.(`deferred handoff for ${sessionId} failed: ${err instanceof Error ? err.name : "unknown"}`),
        ).finally(() => pendingHandoffModelString.delete(pendingKey)),
      () => { pendingHandoffModelString.delete(pendingKey); /* the session ended before settling — nothing left to hand off */ },
    );
    return { kind: "deferred" };
  }
  try {
    const outcome = await executePlan(deps, plan);
    // MEASURED against the real router: a session that has never run a turn PLANS fine (all eight
    // steps) and then loses at step 5, whose transcript validation has no file to validate — the
    // barrier answers `lossy-fork-offered` carrying that absolute path as its reason, which
    // `session.setModel` was surfacing to the user verbatim as a refusal of a switch that loses
    // nothing. THE ONE refusal a re-selection may answer (fix round 4, MAJOR 2 —
    // `isNoCanonicalTranscriptFork`'s own doc for why `blocked` and every other fork reason are
    // excluded), and even then only if a FRESH review still says no source turns (MAJOR 1). A
    // refusal to re-select falls through to the barrier's own outcome, unweakened.
    if (isNoCanonicalTranscriptFork(outcome)) {
      const reselected = await tryReselectWithNothingToCarry(barrier, sessionKey);
      if (reselected !== undefined) return reselected;
    }
    return outcome;
  } catch (err) {
    // Fix round 3 (item 1b): `barrier.execute` can THROW rather than answer `blocked` — MEASURED
    // against the real router for a session that has never run a turn: `plan()` builds all eight
    // steps happily, and step 5's own transcript validation then throws ("there is no canonical
    // transcript at … to validate") from inside `execute`. Before this, that rejection propagated
    // out of `session.setModel` as a raw RPC error carrying a filesystem path — both a leak and,
    // for a zero-turn session, flatly wrong: P10b-2 says that switch is silent.
    //
    // Fix round 4 (MAJOR 2): a throw is NOT the step-5 no-transcript fork — it carries no step and
    // no reason this file may interpret — so it never re-selects. It fails SAFE as `blocked`, whose
    // neutral copy `ipc/server.ts` already owns, with NO store write.
    deps.log?.(`handoff: barrier.execute threw for session ${sessionId} (${err instanceof Error ? err.name : "unknown"}) — reporting blocked rather than surfacing it raw`);
    return { kind: "blocked", reason: "the handoff barrier could not execute the plan" };
  } finally {
    pendingHandoffModelString.delete(pendingKey);
  }
}
