// Winter Phase 8c (Task 4.1, WS-13 §8.2), cut down by WS-23 — `session.setModel`'s pre-flight REVIEW.
//
// A model change is usually an in-runtime affair (the live child gets a new model, or a resumed one
// reads a new stored override) — that path is `session.setModel`'s own. What this module adds is the
// question a model change that crosses FAMILIES has to answer first (gpt -> deepseek, claude -> gpt):
// can the conversation's carried state survive the move? The router's `reviewSwitch` answers it from
// the transcript and the provider-state sidecar, and an unconfirmed lossy switch is refused typed
// (`confirmation_required`) rather than silently downgraded or silently executed.
//
// WS-23: THERE IS ONE RUNTIME. This module used to own a second, larger job — moving a session
// between the Winter runtime and the official `claude` leg through the router's handoff barrier
// (WS-05 §12's eight steps: drain, stage, validate, confirm the destination's init, defer past a
// running turn, re-select a zero-turn session). With the official leg retired every model runs on
// the Winter runtime, so a switch never changes runtime and all of that is gone. Two survivors:
//
//   - the SAME-RUNTIME review and its record patch (below), unchanged in behaviour;
//   - a session the official leg created is ADOPTED onto the Winter leg before anything else runs
//     (`WinterSessionDrivers.adoptLegacyRecord`, the same step `resume()` takes) — otherwise its record
//     would keep naming `claude-agent` and the 1c invariant in `ipc/server.ts` would refuse every
//     model change on it until the session happened to resume.
//
// `settings.runtimes.handoff.crossRuntime` fenced the cross-runtime move. It is still ACCEPTED in a
// settings file (so an existing one keeps loading) and reported once per settings change as inert
// (`settings.ts`'s `retiredRuntimeSettingKeys`), and nothing here reads it.
//
// Winter Phase 10b (D1 fix round 3, item 1a): the SAME address derivation `messaging.ts`'s attach door
// uses — a materialized directory row must land at the address a real incarnation would later
// overwrite, never a second one.
import { buildSessionAddress, serializeRuntimeAddress } from "@yanlinglabs/winter-agent-sdk/messaging";
import type { SessionKey } from "@yanlinglabs/winter-agent-sdk";
import type { RuntimeSelection, SelectionAlternative, SerializedRuntimeAddress } from "@yanlinglabs/winter-runtime-sdk";
import { runtimeSdkInternals } from "@yanlinglabs/winter-runtime-sdk";
// Winter Phase 10b (D1-6, W18-20): `SwitchReview` is `@yanlinglabs/winter-provider-runtime`'s own
// type — the router's `reviewSwitch` declares it by importing it from THAT package too (its own
// top-level barrel never re-exports it), so this is the one place the daemon can name the type
// without a structural `any`.
import type { SwitchReview } from "@yanlinglabs/winter-provider-runtime";
import type { WinterRuntimeSdk, SessionMode } from "./create";
import { RuntimeSessionRecords, type RuntimeSessionRecord } from "../runtime-state/records";
import type { Settings } from "../settings";
import { sessionLegOf } from "./leg";
import { credentialRefFor } from "./keychain";
import { refusalDetailCategoryFor } from "./refusal-copy";
import { rowForTag, testProviderNameFor } from "./provider-selection";
// Types only: `session-driver.ts` imports this module (`renderNoCredentialHint`), so the refusal below is
// recognised by its `code` rather than by `instanceof` — no value cycle between the two.
import type { WinterSessionDrivers } from "./session-driver";

/**
 * The one router door this module needs: `reviewSwitch(session, requested)`, reading the canonical
 * transcript, its provider-state sidecar and the session's runtime-directory row. Reached through
 * `runtimeSdkInternals(sdk).barrier` — the name survives from when it hung off the handoff barrier,
 * and a router of either vintage answers it there.
 */
export interface SwitchReviewer {
  reviewSwitch(session: SessionKey, requested: RuntimeSelection): Promise<SwitchReview>;
}

export interface HandoffDeps {
  runtime: WinterRuntimeSdk;
  winter: WinterSessionDrivers;
  records: RuntimeSessionRecords;
  store: {
    meta(sessionId: string): { mode?: string; cwd?: string | null; model?: string };
  };
  /** The LIVE settings holder — read hot, at call time, never a boot snapshot. Unread since WS-23
   *  retired the cross-runtime fence; kept on the deps so the daemon's wiring does not move. */
  settings: () => Settings | null | undefined;
  /**
   * Winter Phase 10b (D1-2, W18-7): the daemon's own `WINTER_HOME`, threaded through to
   * `credentialRefFor` so the same-runtime patch can name the destination's own credential locator
   * (`keychain:<account>`) the same way `session-driver.ts`'s `create()` does for a brand-new session —
   * never credential material, only which account it would be. Optional so a test double that never
   * exercises the patch needs no home at all; `credentialRefFor` itself is total over an absent `home`.
   */
  home?: string;
  log?: (line: string) => void;
  /**
   * Test seam: a fake reviewer in place of `runtimeSdkInternals(runtime.sdk)?.barrier`.
   * `runtimeSdkInternals` resolves a handle against a WeakMap the router's OWN factory populates — a
   * handle built any other way (a plain test double for `WinterRuntimeSdk.sdk`) answers `undefined`
   * there regardless of what it structurally looks like. Production never sets this.
   */
  barrier?: SwitchReviewer;
}

function reviewerFor(deps: HandoffDeps): SwitchReviewer | undefined {
  return deps.barrier ?? (runtimeSdkInternals(deps.runtime.sdk)?.barrier as SwitchReviewer | undefined);
}

const modeOf = (raw: string | undefined): SessionMode => (raw === "chat" || raw === "dispatch" ? raw : "code");

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
 * frame arrives). `reviewSwitch` throws the router's own `HandoffPlanError` for exactly this shape
 * ("... it is not in the runtime directory, so there is no record of which runtime owns it or which
 * backend session it is" — MEASURED verbatim against the real router). The class is not on the
 * router's declared exports, so this checks the message text instead of `instanceof` — read here
 * ONLY to branch, never logged.
 *
 * ⚠️ FIX ROUND 3: THIS FACT IS NOT "NOTHING TO LOSE". A session WITH prior turns — an imported
 * engine-era one above all — can be keyed but absent from the directory. What the shape actually
 * means is "the ROUTER cannot see this session yet", so it is a trigger to MATERIALIZE the row from
 * the durable record and retry once (`materializeDirectoryRow` below), and, failing that, to fail
 * SAFE (a prompt).
 */
function isNotYetInRuntimeDirectory(err: unknown): boolean {
  return err instanceof Error && /not in the runtime directory/.test(err.message);
}

/**
 * Fix round 3 (INVARIANT, tested): does the DURABLE record now route this session the way the
 * requested model's own fresh selection says it should?
 *
 * `session-driver.ts`'s `resume()` picks the leg from `sessionLegOf(record)` — i.e.
 * `record.runtimeKind` — and every door that reports success (or writes `meta.model`) checks this
 * first; `ipc/server.ts`'s `same-runtime` arm is the one that turns a mismatch into a typed `blocked`.
 *
 * Compared: the fields a resume and the credential eviction consult. `family`/`reason`/`decidedAt`
 * and friends are deliberately NOT compared — `decidedAt` is a timestamp that differs on every
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
 * (`messaging.ts`'s `attachWinterSession`), so a session that has a durable 8a record but has never had
 * a live child — or whose child was evicted before its first frame — is invisible to the router's
 * review even though every fact it needs is sitting in `runtime_sessions`. This re-derives the row FROM
 * that record, through the SAME door the attach uses (`runtime.sdk.directory.record`) and at the SAME
 * address (`buildSessionAddress` over the backend session id, which is what the review matches on).
 *
 * THE PARKED SHAPE, DELIBERATELY: `status: "exited"`, no `backendSessionId`, every capability false —
 * byte-for-byte what `attachWinterSession`'s own `entry(false)` writes. A row that says "running, with
 * a backend id, and no live handle" is what the router's `deliverIntoSession` reads as "cold-resume
 * this transcript", spawning a second `winter` process the daemon never tracked.
 *
 * NEVER CLOBBERS A LIVE ROW: `directory.get` first. A real incarnation that raced this call owns the
 * row, and overwriting it with a parked one would un-attach a session that is genuinely live.
 *
 * Returns whether the review can now find the session — `false` when the daemon has no directory
 * facet at all (a hand-built `WinterRuntimeSdk` test double), when the record has no backend id, or
 * when the write itself failed. The caller treats `false` as "fail safe", never as "proceed".
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
      transport: "winter-session",
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
    // Names and the error CLASS only — a directory write's own message can quote the entry it choked
    // on, and an entry carries a selection.
    deps.log?.(`handoff: could not materialize the runtime-directory row for ${record.winterSessionId} (${err instanceof Error ? err.name : "unknown"}) — the switch will fail safe rather than apply silently`);
    return false;
  }
}

// ── The RPC-facing door ─────────────────────────────────────────────────────────────────────────────

export type PlanSwitchOutcome =
  // Fix round 2 (C1, belt-and-braces): `decided` is the FRESH selection `planAndApplySwitch` chose
  // for this move — present ONLY when a real decision actually ran (the router's `selectRuntimeFor`/
  // review), never on the early bail-outs (`model === null`, no record, an engine-era row, a
  // `winter-test/*` double, an off-catalog model) that never touch the router at all. `ipc/server.ts`
  // uses it to hold the 8a record to the 1c invariant before it writes `meta.model`.
  | { kind: "same-runtime"; decided?: RuntimeSelection }
  // `reason` (WS-23): the refusal's own sub-classification, carried to `error.data.reason` — set for
  // `legacy_session_migration_refused`, whose `reason` says which of its refusals fired.
  | { kind: "refused"; code: "runtime_selection_refused" | "legacy_session_migration_refused"; detail: string; reason?: string }
  // Winter Phase 10b (D1-6, W18-22): `portable` names what the pre-flight review found still carries
  // (`SwitchClassification.portable`) — additive alongside `warnings`, `[]` when the review itself is
  // unreachable or found nothing portable to name.
  | { kind: "confirmation_required"; warnings: string[]; portable: string[] };

/** The console door's label — the router's own for the `anthropic`/`console-profile` alternative, used
 *  for a `console` row too (whose router label is its bare id) so the one door renders once. */
const CONSOLE_DOOR_LABEL = "Anthropic Console login";

/**
 * Winter Phase 10b (D1-7, W18-3): the no-credential refusal's hint, built FROM the router's own
 * `alternatives` — never a hardcoded provider list, so a catalog change (a new Claude-serving
 * gateway) widens the hint automatically. Each door names ITS OWN way in:
 *   - `anthropic`/`api-key` → `winter login --anthropic-key`;
 *   - `anthropic`/`console-profile`, and any alternative on the `console` catalog provider → the ONE
 *     console door, `winter login --anthropic-console`, rendered once. The router lists a `console`
 *     row under its bare id with whatever auth kind the host declared (none — `console-profile` has no
 *     spelling in presence), so it used to fall through to the generic branch below and tell a Console
 *     user to "add a credential" (the WS-23 live-gate report) — there is no key to add;
 *   - `anthropic`/`claude-oauth` (the claude.ai subscription door) → never rendered: WS-23 retired the
 *     only runtime that could have used it, and it never shipped;
 *   - every other alternative (OpenRouter, Bedrock, Vertex, …) → the app's Providers settings.
 * Never names an SDK or runtime (R-10b-4) — a test pins this with a regex that excludes only the
 * literal CLI flags/setting path this function itself prints.
 *
 * Fix round 4 (item 5, reviewer): a refusal's `detail` is the ROUTER's own sentence, written for a
 * developer, not for this product's user — it names runtimes and cites internal spec ids. So the raw
 * detail is logged as a CATEGORY and never as text, and the user gets copy this file owns. This hint
 * is the one refusal text that is actionable, built out of the router's structured `alternatives`.
 */
export function renderNoCredentialHint(alternatives: readonly SelectionAlternative[]): string {
  const doors: string[] = [];
  const push = (door: string): void => { if (!doors.includes(door)) doors.push(door); };
  for (const alt of alternatives) {
    if (alt.providerId === "anthropic" && alt.authKind === "api-key") {
      push(`${alt.label}: run \`winter login --anthropic-key\``);
    } else if ((alt.providerId === "anthropic" && alt.authKind === "console-profile") || alt.providerId === "console") {
      push(`${CONSOLE_DOOR_LABEL}: run \`winter login --anthropic-console\``);
    } else if (alt.providerId === "anthropic" && alt.authKind === "claude-oauth") {
      continue;
    } else {
      push(`${alt.label}: add a credential from the app's Providers settings`);
    }
  }
  if (doors.length === 0) return "no door is currently available for this model — add a credential from the app's Providers settings";
  return `add one of these to use this model — ${doors.join("; ")}`;
}

/**
 * m5 (whole-branch review, fix round 2): user-facing copy never interpolates a raw, possibly-empty
 * model string — `model: null` (clearing an override) never reaches a site that names the requested
 * model; this exists so a future refactor (or a caller passing `""` for the same intent) still renders
 * something a user can read, never a blank or a stray `null`.
 */
export function modelLabelFor(model: string): string {
  return model.length > 0 ? model : "the default model";
}

/**
 * The whole decision: adopt a legacy record, ask the router for the destination selection, run the
 * pre-flight review, and — when nothing needs confirming — patch the record to the destination.
 *
 * `model === null` (clearing an override) never triggers a decision: nothing about clearing a stored
 * preference asks for a specific selection.
 */
export async function planAndApplySwitch(deps: HandoffDeps, sessionId: string, model: string | null, confirmLossy: boolean): Promise<PlanSwitchOutcome> {
  if (model === null) return { kind: "same-runtime" };
  let record = deps.records.get(sessionId);
  // WS-23 (R2): a record the retired official leg wrote moves onto the Winter leg FIRST — transcript
  // re-keyed, runtime kind and selection rewritten — exactly as its next resume would do it. A refusal
  // there (a collision, a transcript already marked for repair) is this switch's refusal too: the
  // model preference is not written onto a session that cannot run.
  if (sessionLegOf(record) === "official" && deps.winter.adoptLegacyRecord !== undefined) {
    try {
      record = deps.winter.adoptLegacyRecord(sessionId);
    } catch (err) {
      const refusal = err as { code?: unknown; message?: unknown; reason?: unknown };
      if (refusal?.code === "legacy_session_migration_refused") {
        return {
          kind: "refused",
          code: "legacy_session_migration_refused",
          detail: String(refusal.message),
          ...(typeof refusal.reason === "string" ? { reason: refusal.reason } : {}),
        };
      }
      throw err;
    }
  }
  const currentLeg = sessionLegOf(record);
  if (record === undefined || currentLeg === "engine" || currentLeg === undefined) {
    // Nothing recorded, or an engine-era row: a decision has nothing to compare against.
    // `session.setModel`'s caller keeps its own ordinary (store-write-only) behaviour for this case.
    return { kind: "same-runtime" };
  }
  // Mirrors `session-driver.ts`'s OWN `decideRuntime` bail-out #2 for a NEW session: a
  // `winter-test/<double>` model is chosen by env var, never by the catalog, and the router's listing
  // has no row for it AT ALL — `selectRuntimeFor` refuses every such model outright (measured).
  if (testProviderNameFor(model) !== undefined) return { kind: "same-runtime" };
  // M1 (whole-branch review); WS-20: mirrors `decideRuntime` bail-out #4 — a tag with NO row in the
  // pinned catalog AT ALL has nothing for the selector to route on.
  if (rowForTag(model) === undefined) return { kind: "same-runtime" };
  const mode = modeOf(deps.store.meta(sessionId).mode);
  // FRESH — no `persisted`. `SELECTION_RULES.persisted` returns a persisted selection BY IDENTITY, so
  // passing `record.selection` here would always hand back the session's CURRENT row. What today's
  // catalog/credentials would pick for the REQUESTED model is the question this call answers.
  const decided = await deps.runtime.selectRuntimeFor({ mode, model });
  if ("refused" in decided) {
    // Winter Phase 10b (D1-7, W18-3): a `no-credential` refusal carries `alternatives` — the router's
    // own list of every catalog row able to serve the requested model, whichever door.
    //
    // Fix round 4 (item 5): `decided.detail` itself NEVER reaches the user — see
    // `refusalDetailCategoryFor` for the measured shapes that name a runtime or a spec id.
    deps.log?.(`handoff: selectRuntimeFor refused ${modelLabelFor(model)} for ${sessionId} (reason=${decided.reason}, detail=${refusalDetailCategoryFor(decided.detail)})`);
    if (decided.reason === "no-credential" && decided.alternatives !== undefined) {
      return {
        kind: "refused",
        code: "runtime_selection_refused",
        detail: `Winter can't switch to ${modelLabelFor(model)} yet — ${renderNoCredentialHint(decided.alternatives)}`,
      };
    }
    return { kind: "refused", code: "runtime_selection_refused", detail: `Winter can't switch to ${modelLabelFor(model)} right now.` };
  }
  // WS-23: the router routes every family to the Winter runtime (`hasClaudePeer: false`); a selection
  // naming any other runtime is one this daemon cannot serve, refused typed and never recorded.
  if (decided.runtimeKind !== "winter-agent") {
    deps.log?.(`handoff: selectRuntimeFor chose ${decided.runtimeKind} for ${modelLabelFor(model)}, which this daemon no longer hosts — refused`);
    return { kind: "refused", code: "runtime_selection_refused", detail: `Winter can't switch to ${modelLabelFor(model)} right now.` };
  }
  // Winter Phase 10b (D1-6, W18-4/W18-20/W18-21; P10b-1/2): the ONE pre-flight review, for EVERY
  // provider/model change. The ROUTER decides every skip (same-profile/same-family/zero-source-turns)
  // via its OWN `reviewSwitch` — this function never computes families itself.
  //
  // Skipped ENTIRELY (no review, no prompt) only when there is nothing to review against yet: no
  // backend transcript (`sessionKeyFor` — a session with no backend transcript has no source turns
  // for the review to weigh, a KNOWN "nothing to lose" case) or no reachable reviewer (a hand-built
  // `WinterRuntimeSdk` test double with no `.sdk` the router's own `runtimeSdkInternals` WeakMap
  // recognises, and no `deps.barrier` override).
  const sessionKey = sessionKeyFor(record);
  const reviewer = reviewerFor(deps);
  /** The generic fail-safe review (fix round 1's MAJOR): unreviewable ⇒ PROMPT, never silent. */
  const unreviewablePrompt = (): SwitchReview => ({
    prompt: true,
    classification: {
      lossClass: "warned-lossy",
      warnings: [`Winter couldn't check what carries over to ${modelLabelFor(model)}. The conversation carries over; reasoning private to the current model may not.`],
      portable: [],
    },
  });
  if (sessionKey !== undefined && reviewer !== undefined) {
    let review: SwitchReview;
    try {
      review = await reviewer.reviewSwitch(sessionKey, decided);
    } catch (err) {
      // Fix round 3 (the round-2 CRITICAL — see `isNotYetInRuntimeDirectory`'s own ⚠️): the "not in
      // the runtime directory" shape means the ROUTER cannot see this session, never that the session
      // has nothing to lose. MATERIALIZE the row from the durable record and ask the router again,
      // ONCE: a genuinely zero-turn session then gets the router's OWN `zero-source-turns` skip, and a
      // session with turns gets a real, honest review. If materializing is impossible or the retry
      // still throws, the switch is UNREVIEWABLE and falls into the generic fail-safe prompt below.
      if (isNotYetInRuntimeDirectory(err) && (await materializeDirectoryRow(deps, record))) {
        try {
          review = await reviewer.reviewSwitch(sessionKey, decided);
        } catch (retryErr) {
          deps.log?.(`handoff: reviewSwitch still threw for session ${sessionId} after its runtime-directory row was materialized (${retryErr instanceof Error ? retryErr.name : "unknown"}) — treating the switch as unreviewable and prompting`);
          review = unreviewablePrompt();
        }
      } else {
        // Fix round 1 (MAJOR, controller ruling): `reviewSwitch` can throw (a transient store or
        // sidecar read error) — an unreviewable switch must never be waved through silently NOR
        // refused outright (R-10b-0: a cross-family move MUST work), so this fails safe as a PROMPT.
        // Logged ONCE, names and the error CLASS only — never `err.message`, which could embed opaque
        // provider state.
        deps.log?.(`handoff: reviewSwitch threw for session ${sessionId} (${err instanceof Error ? err.name : "unknown"}) — treating the switch as unreviewable and prompting instead of refusing or applying it silently`);
        review = unreviewablePrompt();
      }
    }
    if (review.prompt && !confirmLossy) {
      return {
        kind: "confirmation_required",
        warnings: review.classification?.warnings ?? [],
        portable: review.classification?.portable ?? [],
      };
    }
  }
  // Fix round 2 (C1, belt-and-braces): keep the 8a record's identity columns in step with an APPLIED
  // family change (gpt -> deepseek) — without this a switch away from the family the session was
  // CREATED with left `selection`/`providerId`/`modelRef`/`authRef` naming the ORIGINAL family forever,
  // stale for `session.list`, a cold resume, `winter doctor` and the credential eviction.
  //
  // ⚠️ FIX ROUND 3 (the 1c INVARIANT): a failure here is logged rather than thrown, but it is not "the
  // switch still applied" — `decided` rides out on this outcome and `ipc/server.ts`'s `same-runtime`
  // arm REFUSES to write `meta.model` unless the record it re-reads actually names `decided`
  // (`recordNamesSelection`).
  //
  // Winter Phase 10b (D1 fix round 4, item 6 — Lane P's product finding). Captured BEFORE the C1
  // patch below overwrites it: the provider the LIVE child was actually spawned against.
  const providerBeforeSwitch = deps.records.get(sessionId)?.providerId;
  // D1 round-4 review N2: the evict below is gated on the record having ACTUALLY moved.
  let recordMoved = false;
  try {
    const current = deps.records.get(sessionId);
    if (current !== undefined) {
      const destinationAuthRef = credentialRefFor(decided.providerId, deps.home); // WS-20: the arm is the tag prefix
      const destinationAuthRefLocator = destinationAuthRef?.kind === "keychain" ? `keychain:${destinationAuthRef.account}` : undefined;
      deps.records.patch(sessionId, current.state, {
        selection: decided,
        providerId: decided.providerId,
        modelRef: decided.modelRef,
        authRef: destinationAuthRefLocator,
      });
      recordMoved = true;
    }
  } catch (err) {
    deps.log?.(`handoff: C1 record patch failed for ${sessionId} (${err instanceof Error ? err.name : "unknown"}) — the caller's own invariant check will refuse the switch rather than let meta.model and the record disagree`);
  }
  // ════════════════════════════════════════════════════════════════════════════════════════════════
  // Fix round 4, ITEM 6 — A SWITCH THAT CHANGES PROVIDER MUST REACH THE CHILD.
  //
  // A live Winter child's `Options.provider`/`connection` is FIXED AT SPAWN — `session-driver.ts`'s
  // `optionsFor` builds it once, per incarnation. A model change (`openai/gpt-4.1` ->
  // `openrouter/openai/gpt-4.1`, or gpt -> deepseek) lands in the store, `Query.setModel` tells the
  // child its new MODEL — and the child would keep posting to the OLD endpoint, with the OLD
  // credential, until an idle reap or a daemon restart happened to replace it.
  //
  // A MODEL change stays hot — `Query.setModel` is the whole mechanism for it. Only a PROVIDER change
  // needs a new incarnation, because only the provider is baked into the spawn.
  //
  // A RUNNING TURN IS NEVER INTERRUPTED: the evict waits for the idle boundary. The turn in flight
  // legitimately finishes on the old provider — it was issued there — and the NEXT one re-spawns.
  // Fire-and-forget: `session.setModel` never delays its reply. `evict()` ends the child RESUMABLY (it
  // is `end()`, not a kill) and never throws, so the next `send`/`ensure` re-assembles from the record
  // and the transcript.
  //
  // D1 round-4 review N2: GATED ON THE RECORD HAVING MOVED. When the patch above threw, the record
  // still names the OLD provider and `ipc/server.ts` refuses the whole switch; evicting anyway would
  // throw away a perfectly good child for a switch that never happened.
  if (recordMoved && providerBeforeSwitch !== undefined && providerBeforeSwitch !== decided.providerId) {
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
