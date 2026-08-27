import Foundation
import Combine
import NormaKit

// MARK: - office-agent-tools Task 2: the document broker

/// **The single app-side door every agent office verb goes through.** Task 1 built the wire and a
/// routing shell that refuses every verb (`OfficeCommandConsumer`); this is what a real verb — task
/// 3's `sheets`, then `slides`, then `docs` — will stand on. Nothing after this task re-derives how a
/// document gets opened, fenced, saved, or protected: those five rules live HERE, once, and every
/// future verb calls `perform(...)` rather than reaching for `OfficeRuntime` directly.
///
/// **REUSES Stage B's own machinery — does not build a second path to LOK.** Staging
/// (`OfficeRuntime.stageDocument`), `placeAtomically`, the save waiters (`saveAndAwaitOutcome`),
/// `officeDocumentIsDirty`, the read-only-format predicate, and the request queue's no-nesting rule
/// are all `OfficeRuntime`'s own, called through its existing public doors (`open`/`close`/
/// `saveAndAwaitOutcome`/`$state`) — this file adds no new call into the helper and no new LOK call.
/// **Correction, coordinator review F2 (2026-08-22): "no change to `OfficeRuntime.swift` at all" was
/// true through the first fix round and is no longer true.** Closing the double-open race below
/// required a genuine reducer-state addition (`OfficeRuntimeState.opensInFlight`) — see that field's
/// own header in `OfficeRuntime.swift` for why the fix could not stay broker-side alone. Two genuinely
/// new pieces of machinery still live entirely in THIS file: `awaitOpen(_:path:)`, a bridge over
/// `open`'s existing fire-and-forget contract, and `drainDirty(_:path:)`, a bridge over the gap
/// between "the save landed" and "LOK's own bookkeeping caught up" — see each one's own header for why
/// it has to live here rather than as a new `OfficeRuntime` method.
///
/// **The five rules, briefly — each one's own reasoning lives at its call site in `runOnce` below:**
/// 1. Adopt or open (`runOnce`'s branch on `existingRuntime(sessionId)`) — INCLUDING joining a path
///    someone else's open already has in flight (coordinator review F2 fix round; see rule 2's own
///    line and `runOnce`'s own comment at that branch).
/// 2. Close only what you opened (`runOnce`'s `defer`, gated on `!adopted`, now also re-verifying the
///    docId it opened is still the one on record before closing by path — F2 fix round, cheap belt
///    behind rule 1's own fix, not a replacement for it).
/// 3. Dirty refusal, write-only, adopted-only (`runOnce`'s `officeDocumentIsDirty` check).
/// 4. Save-through with a real awaited outcome, AND a drain of LOK's own post-save bookkeeping before
///    returning or closing (`runOnce`'s `saveAndAwaitOutcome` switch, `.saved`'s own `drainDirty`
///    call) — the drain was added after this task's own live drills measured its absence killing the
///    shared office helper; see `drainDirty`'s own header for the full account.
/// 5. Fence (`officeAgentResolvedPathWithinFence`, checked before anything else runs) — v1 controller
///    ruling (coordinator review F4, 2026-08-22): agent office tools, read OR write, are limited to
///    the session's working directories; this is now a deliberate scope decision, not a disclosed
///    narrowing awaiting a follow-up. See that function's own header.
///
/// **A sixth check, not one of the five but load-bearing (coordinator review F3, 2026-08-22):
/// read-only-format refusal now runs BEFORE rule 1 even opens or adopts anything, write-access only.**
/// It used to be consulted only inside rule 4's `.noModel` arm — AFTER `action` had already mutated an
/// ADOPTED document that can never be saved, leaving the user's own tab holding an agent edit with no
/// way to persist it and no rollback. The predicate is pure (path-only), so checking it this early
/// costs nothing and never opens a document a write verb was always going to be refused on. See
/// `runOnce`'s own comment at that check.
///
/// ## The double-mutation story: option (a), an idempotency token — what it actually covers
///
/// **Corrected, coordinator review F1 (2026-08-22): read this before wiring a real verb's
/// `requestId` (task 3+). The paragraphs below originally presented this memo as the answer to "the
/// agent retries after a daemon timeout." It is not that, and cannot be, with today's wire — see the
/// plain statement two paragraphs down before relying on it for anything.**
///
/// What the memo genuinely does: a non-idempotent write (`insert_rows`, `append`, `add_slide`) must
/// never be double-applied on a DUPLICATE DELIVERY of one already-dispatched command inside this app
/// process — a re-broadcast landing twice, two consumers, a re-entrant route. This broker's answer is
/// a caller-supplied `requestId`: `perform(...)` memoizes its ENTIRE outcome — success or any
/// refusal — keyed by that token, and a repeat of the same token returns the FIRST attempt's outcome
/// without touching `OfficeRuntime` a second time. That mechanism is real and is proven below.
///
/// **Memoizing an in-flight `Task`, not a completed `Result`, is the load-bearing detail.** A retry
/// that arrives WHILE attempt 1 is still running must not find an empty cache and launch a second
/// `open`+action+save concurrently with the first — the exact double-apply this exists to prevent.
/// Caching the `Task` itself closes that: `perform` checks-and-inserts into `inFlight` in one
/// synchronous stretch (this class is `@MainActor`; nothing can observe the dictionary between the
/// check and the insert), so a same-token call arriving at any point — before, during, or after
/// attempt 1 — joins the SAME task and gets the SAME outcome. An already-finished `Task` resolves an
/// `await` immediately with its stored result, which is what makes "the whole outcome, refusals
/// included" fall out of this one structure for free, with no separate completed-outcome cache to
/// keep in sync with it. See `OfficeAgentBrokerTests.testReplayJoinsAnInFlightAttemptRatherThanRe
/// RunningTheAction` for the concurrent-replay proof — a sequential-only replay test would pass on
/// the broken (completed-outcome-only) design just as easily as on this one, which is why that test
/// gates attempt 1 mid-ACTION and starts attempt 2 while attempt 1 is still blocked there.
///
/// **The plain statement, against the case the task's own hard requirement actually names — "a
/// timeout can never honestly mean 'it did not happen,' so a non-idempotent write must never be
/// double-applied when the AGENT retries": this memo does NOT cover that case, and no token can, with
/// today's wire.** `PanelCommandRegistry.dispatch` mints `commandId` PER DISPATCH
/// (`packages/core/src/panel/commands.ts`, "never supplied by the caller"); the daemon does not
/// retry on its own; so "the agent retries after a timeout" means a fresh tool call → a fresh
/// dispatch → a fresh `commandId` → a fresh `panel_command`. Nothing on the wire carries continuity
/// from the first attempt to the second, so no `requestId` task 3 chooses to pass here can ever
/// repeat across that boundary, and this memo's check will never hit for it. **The real contract for
/// that case is task 3's own obligation, not this broker's: on a timeout, the tool must report
/// OUTCOME UNKNOWN and verify (re-read) before ever retrying, because the write may well have
/// already landed.** That requirement is recorded in this feature's own design spec, in its own
/// failure-handling section — which outlives this task's own SDD ledger, unlike a task brief — not
/// implemented here; this comment exists so whoever implements it does not mistake THIS memo for
/// having already solved it.
///
/// **The token's contract THIS memo does satisfy, for whoever wires a real verb's `requestId` (task
/// 3+): mint one per LOGICAL attempt, and reuse it ONLY across a blind retry of that exact same
/// attempt WITHIN one app process.** A token derived purely from the verb's own operands (a hash of
/// path+range+values, say) would make a REFUSAL sticky forever — a dirty-refusal replayed verbatim
/// even after the user saves the tab, because the memo never expires and never re-checks. The token
/// has to come from the CALL, not from what the call contains — but see the paragraph above for what
/// that buys you and what it does not.
@MainActor
final class OfficeAgentBroker {

    /// Read vs write — governs exactly two things: whether the dirty check (rule 3) applies to an
    /// adopted document, and whether save-through (rule 4) runs at all. Everything else (fence,
    /// adopt-or-open, close-only-what-you-opened) applies identically to both.
    enum Access: Equatable {
        case read
        case write
    }

    /// The narrow doors this broker needs from `ShellSessionHost` — injected, not a stored
    /// `ShellSessionHost` reference, mirroring `OfficeRuntime.Driver`'s own reasoning (that type's
    /// own header: "nothing helper-shaped is safely constructible under XCTest"): a broker's own
    /// orchestration logic has to be testable without a real host, a real supervisor, or a real
    /// session directory.
    ///
    /// **`existingRuntime` is what makes "never mint a runtime just to read" possible.** `runOnce`
    /// below asks this door FIRST, always — the minting door (`runtime`) is reached only once the
    /// broker has already decided, from `existingRuntime`'s answer, that a genuine open is needed
    /// (rule 1's "otherwise" branch). A read verb for a path some OTHER part of the app already has
    /// open costs this file exactly one dictionary lookup; a read verb for a path nothing has
    /// touched yet still has to mint (there is no other way to read a document LOK has never loaded),
    /// but it does so having asked, not assumed.
    ///
    /// Both runtime doors return `OfficeRuntime?` — including `runtime`, which in production never
    /// actually answers `nil` (`ShellSessionHost.officeRuntime(for:)` always mints). The optional
    /// exists for the one pathological case a `[weak self]`-captured closure has to admit: the host
    /// deallocating between this broker being asked and the closure running. `.hostGone` is that
    /// case's honest answer, not a force-unwrap.
    struct Host {
        var existingRuntime: (_ sessionId: String) -> OfficeRuntime?
        var runtime: (_ sessionId: String) -> OfficeRuntime?
        /// The session's working directories, exactly as `SessionSummary.dirs` carries them —
        /// `nil` (no working-directory concept for this session) and `[]` (a genuinely
        /// workdir-less session) are both real, distinct answers, never conflated. See
        /// `officeAgentResolvedPathWithinFence`'s own header for what each means to the fence.
        var workingDirectories: (_ sessionId: String) -> [SessionDirEntry]?
    }

    private let host: Host

    /// Rule-owning cache: keyed by the CALLER's idempotency token, never by path or session — see
    /// this type's own header for why a `Task`, not a `Result`.
    private var inFlight: [String: Task<String, Error>] = [:]

    init(host: Host) {
        self.host = host
    }

    /// The one door. `action` is the verb's own mechanics (task 3+'s job) — whatever it does to
    /// `runtime`/`docId` between adoption/opening and save-through. It receives the ALREADY-RESOLVED
    /// absolute path's own runtime and docId, never a raw path to re-resolve: every fence/adopt
    /// decision has already been made by the time it runs.
    ///
    /// Returns the verb's own "smallest useful truth" (design spec §3.5) as a plain `String` — the
    /// shape the wire already speaks (`OfficeCommandConsumer`'s own `result: String?`) — rather than
    /// a generic `T`, so there is no type-erased cache to build and no unsafe downcast on replay.
    func perform(
        sessionId: String,
        path: String,
        access: Access,
        requestId: String,
        action: @escaping (_ runtime: OfficeRuntime, _ docId: String, _ adopted: Bool) async throws -> String
    ) async throws -> String {
        if let existing = inFlight[requestId] {
            return try await existing.value
        }
        let host = self.host
        let task = Task<String, Error> { @MainActor in
            try await OfficeAgentBroker.runOnce(host: host, sessionId: sessionId, path: path,
                                                access: access, action: action)
        }
        inFlight[requestId] = task
        return try await task.value
    }

    /// One real attempt — everything `perform` memoizes. `static` and given only what it needs
    /// (never `self`), so replaying it is provably just "run this again with the same inputs," not
    /// something that could accidentally read broker state a second attempt shouldn't see.
    ///
    /// **Second fix-round review (Important #2) — `action` now receives `adopted`, its own already-
    /// computed local below, unchanged.** `set`'s own tool description used to claim earlier cells in
    /// a partially-failed call "have already been written and saved" — false: `action` throws before
    /// rule 4's save switch below is ever reached, so nothing from ANY `set` call is ever saved once
    /// one cell fails, and what happens to the earlier, genuinely-written-but-unsaved cells differs by
    /// `adopted` (an adopted document is left dirty in the user's own tab; a document THIS call opened
    /// has those cells discarded when rule 2's own `defer` closes it below, unsaved). `action` needs
    /// this to compose an honest failure message — see `OfficeCommandConsumer.handleSheetsSet`'s own
    /// closure. Every OTHER `action` closure in `OfficeCommandConsumer.swift` ignores the new
    /// parameter; the compiler enforces the sweep (a call site missing it fails to build), which is
    /// why this is a signature change here rather than a narrower, verb-specific side channel.
    private static func runOnce(
        host: Host, sessionId: String, path: String, access: Access,
        action: @escaping (_ runtime: OfficeRuntime, _ docId: String, _ adopted: Bool) async throws -> String
    ) async throws -> String {
        // Rule 5 — fence, before anything opens. `resolvedPath` (never the raw `path`) is what every
        // later step acts on; `path` survives only to word the refusal the way `resolveWithinAny`
        // itself would (the original, possibly-relative argument, not what it would have resolved to).
        guard let resolvedPath = officeAgentResolvedPathWithinFence(
            path, dirs: host.workingDirectories(sessionId)) else {
            throw OfficeAgentBrokerError.outOfFence(path: path)
        }

        // Coordinator review F3 (2026-08-22) — read-only-format refusal, WRITE-only, before ANYTHING
        // opens or adopts. Previously this predicate (`officeDocumentIsReadOnlyFormat`) was consulted
        // only inside rule 4's `.noModel` arm, AFTER `action` had already mutated an ADOPTED document
        // that can never be saved — leaving the user's own open tab carrying an agent edit with no way
        // to persist it and no rollback, reported as a save failure rather than an up-front refusal.
        // The predicate is pure (path-only, no runtime needed), so checking it here costs nothing and
        // refuses before rule 1 even opens/adopts anything. Reads are unaffected — a read-only format
        // is still perfectly readable, and rule 3's own dirty check already never fires on one either
        // (`officeDocumentIsReadOnlyFormat`'s own header explains why: nothing can ever make such a
        // document dirty in the first place), same reasoning extended here. The `.noModel` arm below
        // keeps its own identical check as a second, defensive layer — believed unreachable for a
        // WRITE now that this runs first, but kept rather than deleted: this file's own posture
        // elsewhere is layered belts, not a single trusted gate (rule 2's own re-verify a few lines
        // down is the identical instinct).
        if access == .write, officeDocumentIsReadOnlyFormat(path: resolvedPath) {
            throw OfficeAgentBrokerError.saveFailed(path: resolvedPath, reason:
                "this format can't be saved by Norma's office tools — only ODF and Office Open XML "
                + "formats are writable.")
        }

        // Rule 1 — adopt or open. `existingRuntime` first, always (this type's own header, "never
        // mint just to read"); `runtime` (the minting door) is reached only in the `else`. Asked
        // exactly ONCE (fix-round F2 review — the first draft of the branch below called this door a
        // SECOND time in its own `else if`, breaking `testOpeningAskAsExistingFirstThenMints`'s call-
        // COUNT proof of the single-lookup design this comment already claimed).
        let existingRuntime = host.existingRuntime(sessionId)
        let runtime: OfficeRuntime
        let docId: String
        let adopted: Bool
        if let existing = existingRuntime,
           let entry = existing.stateSnapshot.documents[resolvedPath] {
            runtime = existing
            docId = entry.docId
            adopted = true
        } else if let existing = existingRuntime,
                  existing.stateSnapshot.opensInFlight.contains(resolvedPath)
                    || existing.stateSnapshot.pendingOpens.contains(resolvedPath) {
            // Coordinator review F2 (2026-08-22) — the other half of the double-open fix.
            // `OfficeRuntimeState.opensInFlight` (added this fix round) stops a SECOND `.helperOpen`
            // from ever being dispatched, but that alone does not make this call's OWN ownership
            // decision correct: without this branch, a path someone ELSE is already opening (a tab's
            // own open racing this call) would still fall to the `else` below, `adopted` would still
            // land `false`, and the `defer` below would still close the document THE OTHER CALLER
            // opened once this call finishes — rule 2's own failure mode, surviving the reducer fix
            // untouched. Joining an in-flight open counts as adoption: `awaitOpen`'s own `open(path)`
            // call is now a harmless no-op under the reducer's new guard (nothing dispatches a second
            // time), and its subscription rides whichever landing — this attempt's own or the one
            // already in flight — resolves `documents[resolvedPath]` first, exactly as it always has.
            //
            // **`|| pendingOpens.contains(...)`, added catching this same fix round — the BOOT-PATH
            // gap `opensInFlight` alone leaves open.** `opensInFlight` is written only from `.ready`
            // (the immediate-dispatch arm) or from `.helperBecameReady`'s flush — never from
            // `.starting` itself. `OfficeRuntime.perform`'s own `.ensureHelperReady` handler has a
            // documented "late-joiner" fast path: if the shared helper is ALREADY running, the WHOLE
            // idle→starting→ready→flush→helperOpen cascade folds SYNCHRONOUSLY, so `opensInFlight` is
            // in practice the only state a concurrent second caller ever observes — this is the
            // common case (the helper outlives any one document) and is what
            // `testBrokerJoinsAnAlreadyInFlightOpenAsAdoptionRatherThanMintingASecondOne` drills. But
            // on a genuine COLD BOOT — the app's very FIRST office call, helper not yet started —
            // `.starting` persists for real wall-clock time (an actual process spawn), and a path
            // sitting in `pendingOpens` during that window is invisible to `opensInFlight` alone:
            // without this clause, a broker call for that same path would still fall through to
            // "mint fresh," `adopted = false`, and close it once the flush eventually lands. Safe to
            // join the identical way: `awaitOpen`'s own redundant `open(path)` call is *already* a
            // no-op against `.starting`'s own pre-existing dedup (`if !pendingOpens.contains(path) {
            // append }`), so nothing new is needed there. **Not independently live-drilled**: this
            // file's fake driver reports `.ready` synchronously (the same shape as the common case
            // above), so no test here forces a real `.starting` window to observe — disclosed in
            // `task-2-report.md`'s fix-round section rather than built, given the added machinery a
            // driver with a genuinely-delayed readiness would cost for one narrow, structurally-
            // reasoned window.
            //
            // **Residual, HALF fixed as of Office Stage C — the two halves are different claims and
            // only one of them changed.** The MIRROR interleaving itself still exists: if THIS
            // call's own open is the one in flight and a tab's open joins IT instead, this call
            // still correctly believes `adopted == false` (it really did initiate the open) and its
            // own `defer` still correctly closes what it opened per rule 2's own contract — so the
            // tab that joined in the meantime still loses its view when that close fires. **That
            // half is unchanged and nothing below claims otherwise.**
            //
            // **What IS fixed is what the tab does about it.** Pre-Stage-C the tab was STUCK:
            // `documents[resolvedPath]` going nil from this close fell it through every named case
            // of `officeDocumentViewportPlan` to `.renderState(.booting)` — an indefinite spinner,
            // no error text, no Reopen affordance — and `requestOpenIfNeeded`'s own gate
            // (`openRequestedPaths`, `PanelDocumentTab.swift`) never fired again for that path, so
            // nothing self-healed; only closing the tab and reopening the file recovered it (a
            // fresh `PanelDocumentTabModel`, an empty gate). It now lands in
            // `OfficeDocumentViewportState.closedUnderTab` — a real state, an honest sentence, and
            // the Reopen affordance — and re-arms its own gate for ONE automatic re-open per
            // (runtime, path) for that pairing's whole lifetime
            // (`PanelDocumentTabModel.maxAutomaticReopensAfterVanish`, deliberately never reset by
            // a successful re-open, which is the structural half of why this cannot become an
            // open/close loop; the behavioural half is that once the tab owns the document again, a
            // later broker call ADOPTS it under rule 1 and there is no second close to lose). In
            // the ordinary case the user sees a flicker instead of a dead tab. Drilled end to end,
            // this broker included, by
            // `testTheMirrorInterleavingLeavesTheJoinedTabRecoverableRatherThanSpinning`.
            //
            // **The deliberate follow-up, named rather than silently dropped: multi-owner REFERENCE
            // COUNTING for one open document**, so this close never fires at all while another
            // owner still holds it. That changes this broker's core lifecycle (the same design gap
            // the `defer`'s own comment below names), which is why the recoverability half landed
            // on its own and this did not.
            runtime = existing
            docId = try await awaitOpen(existing, path: resolvedPath)
            adopted = true
        } else {
            guard let opened = host.runtime(sessionId) else {
                throw OfficeAgentBrokerError.hostGone
            }
            runtime = opened
            docId = try await awaitOpen(opened, path: resolvedPath)
            adopted = false
        }

        // Rule 2 — close only what you opened. Runs on EVERY exit from here down (action throws,
        // save fails, or plain success) because `defer` does not distinguish — which is exactly
        // right: whatever happened, a document this call opened must not be left dangling open with
        // no tab watching it, and a document this call merely adopted must never be closed out from
        // under the tab that owns it. Coordinator review F2 — also re-verifies the docId this call
        // actually opened is STILL the one `documents[resolvedPath]` names before closing it: cheap
        // belt behind rule 1's own in-flight-join fix above, for whatever THAT fix does not cover (a
        // reload/resurrection replacing the entry between this call's own open and this `defer`
        // running) — closing blindly BY PATH in that window would close a document this call never
        // touched. Does not close the residual named in rule 1's own comment above (a re-verify on a
        // docId that legitimately IS still this call's own does not stop rule 2 from correctly, and
        // now visibly, closing it out from under a caller who merely joined) — Office Stage C
        // changed what that JOINER does next, never whether this close fires. It still fires, and
        // `testTheMirrorInterleavingLeavesTheJoinedTabRecoverableRatherThanSpinning` asserts
        // `closeCalls == 1` on that very path to keep it that way.
        //
        // **Disclosed, not fixed (coordinator re-review, 2026-08-22): the mismatch branch — the docId
        // check above failing — leaks the REPLACEMENT document for the rest of the session.** On a
        // mismatch, this `defer` correctly skips closing (that is the whole point of the re-verify:
        // the entry at `resolvedPath` now belongs to whatever replaced this call's own open, most
        // likely a reload triggered by an external change to the file during `action`'s own window),
        // but nothing else closes the replacement either — this call never opened it, so it is not
        // this call's to close, and rule 1's own adopt-or-open logic only ever runs at the START of a
        // NEW broker call, never in reaction to a mismatch discovered here. The result: the
        // replacement's helper-side handle, its staged copy, and its armed file-watcher all stay
        // resident, and `documents[resolvedPath]` keeps a live entry pointing at it, until some LATER
        // call for the SAME path happens along and adopts it (rule 1's own `existingRuntime` branch)
        // — folding it back into ordinary lifecycle at that point, but only then. Bounded by the
        // session (it dies with the runtime at teardown) and never corrupting (the replacement is a
        // perfectly valid, live document the whole time) — but a real, silent resource hold with no
        // active cleanup path of its own. Pinned, not fixed, by
        // `testDocIdMismatchOnDeferSkipsTheCloseAndLeavesTheReplacementDocumentOpen` — a full fix
        // needs multi-owner reference counting for one open document (the same design gap rule 1's
        // own mirror-interleaving comment above already names), not a defer-site patch.
        defer {
            if !adopted, runtime.stateSnapshot.documents[resolvedPath]?.docId == docId {
                runtime.close(resolvedPath)
            }
        }

        // ⚠️ **AFTER rule 2's `defer`, and the placement is deliberate rather than incidental.**
        // A `defer` does nothing until the function exits, so moving these two below it changes no
        // ordering of actual work — but it does mean the pre-save's `throw` unwinds through an
        // ALREADY-INSTALLED defer. Today that is belt (the pre-save only throws when `adopted`, and
        // the defer is a no-op when `adopted`), but the trap it removes is real and quiet: anything
        // that later makes this leg throw on a NOT-adopted path would otherwise leak the document
        // this call had just opened, with no close anywhere.
        // ── office-live-ux Job 3 — MARK THE TAB, before anything else touches the document.
        //
        // Gated on `adopted` because that is exactly "a tab already has this open": a document THIS
        // call opened has no tab behind it and nothing to cover. Marked for a READ as well as a
        // write — the user's spec is that the overlay appears "as soon as Norma reads the document
        // open in that tab", so the user does not edit underneath a read the agent is about to act
        // on. Both adopted branches above reach here (the `documents[resolvedPath]` hit and the
        // in-flight-join), which is the whole set of ways `adopted` becomes true.
        //
        // Marked BEFORE the pre-save below, deliberately: a save is a full container rewrite plus a
        // LOK re-render, i.e. a visible repaint, and putting the overlay up first is what puts that
        // repaint behind a surface the user is already being told not to type into.
        //
        // Never unmarked here. `OfficeRuntime` clears engagement on the turn's own edges — see
        // `OfficeRuntime.setSessionTurnRunning` for why a derived conjunction, not a matched pair of
        // mark/unmark events, is what makes a stuck overlay impossible.
        if adopted { runtime.noteAgentEngaged(path: resolvedPath) }

        // ── office-live-ux Job 2, save point 1 (before an agent edit) and save point 5 (before an
        // agent read). **THIS REPLACES RULE 3'S REFUSAL, AND THAT IS A DELIBERATE CHANGE TO A
        // RATIFIED RULE — see `preSaveAdoptedDocument`'s own header for the argument and for what
        // still refuses.**
        try await OfficeAgentBroker.preSaveAdoptedDocument(runtime, path: resolvedPath,
                                                           access: access, adopted: adopted)


        // ── office-live-edit R3 — THE BRACKET. "One tool call = one undo step" is implemented by
        // measuring the engine's undo-stack depth on either side of the WHOLE edit closure and
        // remembering the difference, so a later ⌘Z can take back exactly that many actions in one
        // press. Read BEFORE `action`, never derived from how many edits the closure intended to
        // make: a verb's op count is not its undo-action count (four typed characters measured as
        // ONE action; a `paste` is one; a structural `.uno:` dispatch is its own number), and
        // counting ops would be the arc's own right-conclusion-wrong-supporting-fact shape.
        //
        // A `nil` depth (an engine that cannot answer) records NOTHING rather than guessing — which
        // leaves ⌘Z at its pre-existing one-action-per-press granularity for that call. Degrading to
        // less, never to a wrong number.
        //
        // ⚠️ **GATED ON `adopted`, and that gate is load-bearing twice over.** (1) Correctness: a
        // NOT-adopted document is closed by rule 2's `defer` at the end of this call, so its undo
        // stack dies with it and no later ⌘Z can ever reach the group — recording one would be cost
        // for an unreachable benefit. (2) Budget: these are two real R-bounded requests through the
        // app-wide FIFO, so an ungated bracket would put the counted worst case at H+5R on a path
        // whose deadline assumes fewer. With the gate the not-adopted path stays at 3 requests and
        // the adopted path is 4 (it pays no `open`). `office-commands.ts` §A item 4 carries the
        // argued deadline move that pays for it.
        //
        // ⚠️ **DISCLOSED RACE, bounded and accepted for v1.** The bracket spans several FIFO
        // requests, so a human keystroke landing between the two reads inflates the count, and one
        // ⌘Z would then also take back typing the human did while the agent was writing. It is
        // bounded (⌘⇧Z puts it back, whole), it needs the human to be typing into the very document
        // the agent is mid-write on, and the alternative — holding the FIFO across the whole edit —
        // is a worse trade. Named here rather than left for a reviewer to find.
        let depthBefore = access == .write && adopted ? await runtime.undoDepth(docId: docId) : nil

        let result = try await action(runtime, docId, adopted)

        guard access == .write else { return result }

        if let before = depthBefore, let after = await runtime.undoDepth(docId: docId) {
            // Only a RISE is a group. A fall (or no change) means the closure undid, cleared or
            // otherwise did not add to the stack, and there is nothing for one ⌘Z to collapse.
            runtime.noteAgentUndoGroup(path: resolvedPath, topDepth: after.undo,
                                       count: max(0, after.undo - before.undo))
        }

        // Rule 4 — save-through, and the outcome is AWAITED for real (`saveAndAwaitOutcome`, not the
        // fire-and-forget `save`) — Stage B's own C1 lesson, restated for an agent caller instead of
        // the close sheet: a failed place must surface as this verb's own failure, never as success,
        // and it must leave the document dirty for whoever looks next (`OfficeRuntime`'s own
        // `saveFailedPendingSave` already guarantees the second half; this is what makes the FIRST
        // half — the caller actually being told — true for the agent's own tool result too).
        switch await runtime.saveAndAwaitOutcome(resolvedPath) {
        case .saved:
            // Rule 4's own completion — see `drainDirty`'s own header for why this is load-bearing,
            // not belt-and-braces: this runs BEFORE `return`, so it also runs before the `defer`
            // above can close the document (a `defer` fires at the function's actual exit, after
            // every statement in its body, including this `await`).
            await drainDirty(runtime, path: resolvedPath)
            return result
        case .failed(let reason):
            // Dirty is held `true` here too (`OfficeRuntime`'s own `saveFailedPendingSave`), but no
            // drain is possible — LOK's own `ModifiedStatus=false` is never coming for a save that
            // never reached the real path (`OfficeRuntimeReducer.saveFailed`'s own header states
            // this), so there is nothing to wait FOR. The `defer` above closes immediately on this
            // path, exactly as before; whether that immediate close is itself ever lethal the way an
            // undrained SUCCESS close measured is remains undiagnosed — see `task-2-report.md`'s
            // concerns.
            throw OfficeAgentBrokerError.saveFailed(path: resolvedPath, reason: reason)
        case .noModel:
            // Defensive second layer, coordinator review F3 — believed unreachable for a WRITE now
            // that the identical check runs up front, before rule 1, before `action` ever gets a
            // chance to mutate an adopted document this could never save. Kept rather than deleted
            // (see the pre-check's own comment for why); if it DOES fire, the wording is identical to
            // what the pre-check would have said, so a caller sees the same sentence either way.
            if officeDocumentIsReadOnlyFormat(path: resolvedPath) {
                throw OfficeAgentBrokerError.saveFailed(path: resolvedPath, reason:
                    "this format can't be saved by Norma's office tools — only ODF and Office Open "
                    + "XML formats are writable.")
            }
            throw OfficeAgentBrokerError.saveFailed(path: resolvedPath, reason:
                "there was no open document to save.")
        }
    }

    /// office-live-ux Job 2, save points **1 (before an agent edit)** and **5 (before an agent
    /// read)** — and the place where a ratified rule changed.
    ///
    /// ## What rule 3 used to be, and what it is now
    ///
    /// **Was:** a write to a document the user holds DIRTY was refused outright
    /// (`OfficeAgentBrokerError.documentDirty`), full stop. The rule protected the user's unsaved
    /// edits by declining to write over them, and it is listed as rule 3 in this type's own header.
    ///
    /// **Is:** the user's edits are SAVED first, and the agent then proceeds against a document
    /// whose on-disk state matches what the user can see. If the pre-save FAILS, the refusal fires
    /// exactly as before — because the thing rule 3 protected (unsaved user edits, about to be
    /// written over) is still true in precisely that case and in no other.
    ///
    /// **Why this is better and not merely different.** Rule 3's refusal was a dead end from the
    /// agent's side: the only cure was for a human to press ⌘S, and the agent could not ask for one
    /// mid-turn. The user's own ruling for this task is Xcode's model — commit on actions, and an
    /// agent about to edit is an action. Saving first makes the refusal rare instead of routine
    /// without making it weaker: it still fires whenever the document is genuinely dirty at the
    /// moment the agent would write, which after this change means "dirty AND unsavable".
    ///
    /// **What did NOT change:** the fence (rule 5), the read-only-format refusal, close-only-what-
    /// you-opened (rule 2), and rule 4's save-through afterwards. A read-only format never gets here
    /// with `access == .write` — the pre-check above throws first — and can never be dirty anyway.
    ///
    /// ## Reads and writes differ on what a FAILED pre-save means, and the asymmetry is the point
    ///
    /// * **write** → throw. The agent is about to overwrite edits it could not preserve. The thrown
    ///   sentence NAMES the attempted save, so a retry is not a walk into an identical wall with no
    ///   new information — the previous refusal said only "it's dirty", which reads as "wait and try
    ///   again" and would have been wrong here.
    /// * **read** → proceed. A read serves the runtime's IN-MEMORY state, which already contains the
    ///   user's unsaved edits — so a read is never wrong because a save failed, and refusing one
    ///   would remove a capability for no protection at all. The pre-save on a read exists to keep
    ///   disk in step with what the agent is about to report, not to make the read correct.
    ///
    /// ## Ordering, and why the drain is here too
    ///
    /// `saveAndAwaitOutcome` then `drainDirty`, the same pair rule 4 runs afterwards and for the
    /// same measured reason: `.saved` resolves when `placeAtomically` lands, which is EARLIER than
    /// LOK's own `ModifiedStatus=false`, and the gap is where a close kills the shared helper. This
    /// call is followed immediately by `action` (which puts more work on the same FIFO) and, on the
    /// not-adopted path, eventually by rule 2's close — so leaving the gap open here would widen the
    /// exact window `awaitCloseBarrier` and both drains exist for.
    ///
    /// Sequential awaits at the BROKER level, never nested inside another `queue.run` — constraint
    /// C1's "a nested call deadlocks all office I/O permanently". Rule 4 already has this shape.
    ///
    /// `adopted == false` returns immediately: a document this call just opened cannot be dirty
    /// (LOK loaded it a moment ago), which is the same reasoning rule 3's own adopted-only gate
    /// carried.
    ///
    /// ## ⛔ A DOCUMENT IN CONFLICT IS NEVER SAVED HERE — fix round, review CRITICAL-1
    ///
    /// A conflict means the file on disk ALSO changed outside Norma while this tab held it
    /// (`OfficeRuntimeReducer`'s `.externalChangeDetected`/`.externalDeleted` arms, both gated on
    /// `doc.dirty`). Saving it discards somebody else's write — **and this pre-save is the one
    /// caller for which nobody asked and nobody is watching.** It is worse than a plain overwrite
    /// because it is SELF-ERASING: `.saveSucceeded` unconditionally clears `documentConflicts`
    /// (`OfficeRuntime.swift`'s reducer arm, documented there as "pressing ⌘S with a banner up IS
    /// the 'mine wins' answer" — true of a HUMAN's ⌘S, false of a save the user never asked for),
    /// so the banner that would have told them deletes itself in the same operation. **No third
    /// party is needed to reach it**: the agent's own `git checkout`, or a script regenerating an
    /// xlsx, raises the conflict, and its own next `sheets.read` destroyed it in the same turn.
    ///
    /// The asymmetry is the SAME one the failed-save arm below already uses, for the same reason:
    ///
    /// * **read → skip the save and proceed.** By the read argument above, a read serves the
    ///   runtime's in-memory state and is never wrong because a save did not happen. Refusing it
    ///   would remove a capability and protect nothing.
    /// * **write → refuse, naming the conflict.** This is precisely what rule 3 was ratified to
    ///   protect, with a second party's bytes added to the stake.
    ///
    /// ⚠️ **Checked BEFORE the dirty guard, and that ordering is load-bearing rather than tidy.**
    /// "Conflicted but CLEAN" is a reachable state: `.modifiedStatusChanged(modified: false)` —
    /// the user pressing ⌘Z back to clean — leaves `documentConflicts[path]` standing (verified by
    /// reading that arm, and by enumerating the six that DO clear one: `.opened`, `.closeRequested`,
    /// `.saveSucceeded`, `.reloadFailed`, and the banner's own two answers
    /// `.conflictReloadRequested`/`.conflictKeepMineRequested`. None of them is an undo). With the
    /// conflict test
    /// *after* the dirty guard, a write on such a document returns early here, `action` dirties it,
    /// and **rule 4's own unconditional save-through then resolves the conflict anyway** — the
    /// identical defect through the back door. Ordering it first costs one dictionary read.
    ///
    /// **Deliberate widening, stated:** that clean-but-conflicted write was *allowed* at
    /// `f4b9e923` (rule 3 gated on dirty, so it never fired). It is refused now. The refusal is
    /// what the conflict banner is for, and the cure is one click the user already has.
    ///
    /// **A distinct error case, not `.documentDirty` with a new reason string.** `.documentDirty`'s
    /// own doc and its rendered sentence both promise a save was TRIED and failed ("Norma couldn't
    /// save them first … Save or discard the tab's edits, then try again"). Nothing is tried here,
    /// and "Save" is the one instruction that would complete the loss. Reusing that case would be
    /// this arc's own description-contradicting-the-code shape, planted inside the fix for it.
    private static func preSaveAdoptedDocument(_ runtime: OfficeRuntime, path: String,
                                               access: Access, adopted: Bool) async throws {
        guard adopted else { return }
        if runtime.stateSnapshot.documentConflicts[path] != nil {
            guard access == .write else { return }
            throw OfficeAgentBrokerError.documentConflicted(path: path)
        }
        guard officeDocumentIsDirty(state: runtime.stateSnapshot, path: path) else { return }
        switch await runtime.saveAndAwaitOutcome(path) {
        case .saved:
            await drainDirty(runtime, path: path)
        case .failed(let reason):
            guard access == .write else { return }
            throw OfficeAgentBrokerError.documentDirty(path: path, saveAttemptFailure: reason)
        case .noModel:
            // The document went away between the dirty read above and this call — nothing to save
            // and nothing left to protect. A write proceeding here will fail rule 4 on its own terms
            // a moment later with a truthful sentence; inventing a dirty refusal for a document that
            // no longer exists would be the less honest of the two.
            return
        }
    }

    /// ─────────────────────────────────────────────────────────────────────────────────────────
    /// **THREE BARRIERS NOW EXIST FOR ONE BUG. READ THIS BEFORE CHANGING ANY OF THEM.**
    ///
    /// office-instant-save Job 1 added the third — `OfficeRuntime.awaitCloseBarrier`, reached from
    /// `.helperClose`'s own performer. It is the only UNCONDITIONAL one: it sits at the single site
    /// every real close funnels through, so it needs no call site to remember it, and it is what
    /// finally covers the clean-tab `×` route (`ShellSessionHost.requestCloseTab:1500-1502` →
    /// `closePanelTab:1739`), which had no barrier at all. That route's own in-code claim that it
    /// needed none was wrong and is corrected at `ShellSessionHost.swift`. The two below are now
    /// **redundant with it** on their own paths, and are kept because their regression tripwires are
    /// written against them; neither should be deleted without moving those first. Full account and
    /// measured counts: `.superpowers/research/office-close-race-report.md`.
    ///
    /// This is the **broker's** drain, guarding the AGENT write path (`runOnce`'s `.saved` arm).
    /// `OfficeRuntime.drainUntilClean` is the **dirty-close sheet's** drain, guarding the USER's
    /// `×`-then-Save path (`ShellSessionHost.resolveDirtyDocumentTabClose`). Same bug, same
    /// investigation (`task-2-report.md`), two implementations that landed 26 minutes apart on
    /// parallel branches and did not know about each other. They are NOT interchangeable:
    ///
    ///   * **this one** watches `runtime.$state` for LOK's own real `.uno:ModifiedStatus=false` —
    ///     a genuinely stronger barrier ON THE ORDINARY PATH, since it waits for the actual
    ///     completion signal rather than a proxy;
    ///   * **`drainUntilClean`** performs an unconditional awaited helper round trip
    ///     (`clipboardCopy`) and consults `dirty` for NOTHING — a sound entry, at an
    ///     `O(selection)` cost per call, with its own completeness explicitly unproven.
    ///
    /// **The unsound part of THIS function is the BARRIER, not the entry guard — do not "fix" it by
    /// deleting the guard.** `main`'s fix-round review (IMPORTANT-1) established that `dirty` is
    /// cleared SYNCHRONOUSLY by `OfficeRuntimeReducer.saveSucceeded` on the `restoredPendingSave`
    /// and `saveFailedPendingSave` paths, so a `dirty`-gated drain is inert exactly there. Deleting
    /// the `guard` below changes NOTHING: the barrier is a `$state` sink whose own `dirty != true`
    /// check resolves on `@Published`'s synchronous replay to a new subscriber (`awaitOpen`'s own
    /// header states and depends on that replay), so it resumes during `.sink(...)` itself. Measured,
    /// not argued — with the guard deleted, `OfficeAgentBrokerTests` ran 37/37 indistinguishable.
    /// The guard is only a fast path to a conclusion the sink reaches a microsecond later.
    ///
    /// Closing it for real needs a barrier that never consults `dirty`: either routing this arm
    /// through `drainUntilClean`, or the no-op/health-check verb `drainUntilClean`'s own header
    /// already files as the correct long-term fix. Both are behaviour changes on a live save path
    /// and are deliberately NOT taken here — the zero-wait close this leaves open is traced
    /// unreachable on every ordinary path (every route to either flag implies a tab owns the path,
    /// which makes a broker call `adopted` and disarms rule 2's `defer`). Current behaviour is pinned
    /// honestly by `testCharacterizationWriteVerbsDrainDoesNotWaitAtAllWhenDirtyIsAlreadyClearAtSaveTime`,
    /// against the waiting-leg test directly above it.
    /// ─────────────────────────────────────────────────────────────────────────────────────────
    /// **Rule 4's own completion, added after this task's own live drills measured its absence
    /// killing the shared office helper.** `saveAndAwaitOutcome`'s `.saved` resolves the instant
    /// `placeAtomically` lands on disk — but `OfficeRuntimeReducer.saveSucceeded`'s own header states
    /// plainly that an ORDINARY save leaves `dirty` untouched: `documents[path].dirty` stays `true`
    /// until LOK's own SEPARATE, later `.uno:ModifiedStatus=false` callback arrives (only the two
    /// app-held cases, `restoredPendingSave`/`saveFailedPendingSave`, clear it synchronously inside
    /// `.saveSucceeded` itself — see that reducer arm's own comment for exactly which two and why;
    /// this function's own fast-path guard below is what makes it a no-op for precisely those two).
    ///
    /// **This is not a cosmetic ordering nicety — it is the fix for a measured helper-kill.** This
    /// task's own diagnostic matrix (`task-2-report.md`'s evidence table) found that closing a
    /// document immediately after `.saved`, before that real LOK callback lands, kills
    /// `NormaOfficeHelper` roughly 4 times out of 5 — and every OTHER open document in the app rides
    /// on that SAME one process (`OfficeHelperRequestQueue` is app-wide, per this file's own header).
    /// The write itself is never in question by the time this runs (`saveAndAwaitOutcome` already
    /// confirmed the bytes landed) — this exists purely to keep the ONE shared helper alive for
    /// whatever opens next.
    ///
    /// **Bounded, and the timeout's own failure mode is deliberately silent.** 15s, this file's own
    /// live-wait convention; on timeout, proceeds to close/return anyway rather than report an error —
    /// the save already genuinely landed, and turning a landed write into a reported failure because
    /// the CLEANUP took too long would be a worse lie than the one this function exists to prevent.
    /// A helper that is still unstable 15s after a successful save is a real, undiagnosed condition
    /// this silently absorbs rather than solves — disclosed in `task-2-report.md`'s concerns, not
    /// solved here.
    ///
    /// Exits on `dirty != true`, not merely `dirty == false` — a document that DISAPPEARED entirely
    /// during the drain (a session tearing down mid-write) has just as little left to wait for as one
    /// that genuinely went clean, and treating only the latter as terminal would spin this function
    /// for the full 15s bound over a runtime that already moved on.
    ///
    /// Mirrors `awaitOpen`'s own Combine-sink shape (a `resolved` guard, `sink`, explicit cancel) —
    /// this file's own established pattern for bridging a fire-and-forget/eventually-consistent
    /// `OfficeRuntime` signal into something `async` code can wait on — with a second, parallel
    /// MainActor `Task` racing the timeout; both sites guard on the SAME `resolved` flag before
    /// acting, and since neither has an `await` between checking it and setting it, only one of them
    /// can ever actually resume the continuation.
    private static func drainDirty(_ runtime: OfficeRuntime, path: String) async {
        guard runtime.stateSnapshot.documents[path]?.dirty == true else { return }
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            var resolved = false
            var cancellable: AnyCancellable?
            let timeoutTask = Task { @MainActor in
                try? await Task.sleep(nanoseconds: 15_000_000_000)
                guard !resolved else { return }
                resolved = true
                cancellable?.cancel()
                continuation.resume()
            }
            cancellable = runtime.$state.sink { state in
                guard !resolved else { return }
                guard state.documents[path]?.dirty != true else { return }
                resolved = true
                timeoutTask.cancel()
                cancellable?.cancel()
                continuation.resume()
            }
        }
    }

    /// **The one genuinely new piece of machinery this task adds.** `OfficeRuntime.open(_:)` is
    /// documented fire-and-forget ("never sequence off this call returning — observe `state`/
    /// `stateSnapshot` instead"), which is right for its existing callers (a tab publishes `$state`
    /// and repaints whenever it changes) but wrong for a broker that needs a `docId` in hand before
    /// it can run a verb. This bridges the two without touching `OfficeRuntime.swift`: `open` and
    /// `$state` are both already externally readable (`PanelDocumentTabModel.refresh` sinks the
    /// identical publisher from a different file), so the bridge lives entirely on this side of that
    /// public surface.
    ///
    /// **Order is load-bearing: `open(path)` first, subscribe second.** `@Published` replays its
    /// CURRENT value to a new subscriber immediately, synchronously, on subscription. Subscribing
    /// FIRST would let that replay observe a STALE `openFailures[path]` left over from some earlier,
    /// unrelated attempt at this path, resolving this bridge as failed before this call's own `open`
    /// has even dispatched. Calling `open` first is race-free specifically because `.openRequested`'s
    /// reducer arm clears `openFailures[path]` as its very first line, SYNCHRONOUSLY, before this
    /// function ever subscribes — and the async half (the actual reply, success or failure) requires
    /// at least one task hop to land, which cannot happen inside this function's own synchronous
    /// open-then-subscribe stretch. So the first value this subscription ever sees already reflects
    /// the cleared state, never the stale one.
    ///
    /// **Every terminal condition, not just the two obvious ones.** `documents[path]` appearing and
    /// `openFailures[path]` appearing are the two paths `OfficeRuntimeReducer.openFailed`/`.opened`
    /// write for THIS path specifically — but two whole-runtime events drop a pending open WITHOUT
    /// ever writing either: `.helperDied`/`.helperUnavailable` reset to a fresh `OfficeRuntimeState`
    /// with `phase = .failed` and an EMPTY `openFailures` (the crash/never-came-up case has nothing
    /// per-path left to write into), and `teardown()` resets to a fresh state with `phase = .idle`.
    /// Without watching for both, a death or a teardown that lands while this bridge is waiting would
    /// hang it forever — and with `perform`'s in-flight `Task` cache, a same-token retry would then
    /// await that same permanently-hung task forever too. `phase == .idle` can only be a POST-call
    /// regression here (calling `open` synchronously advances `.idle`/`.failed` to `.starting` before
    /// this function ever subscribes), so seeing it again mid-wait is unambiguous.
    private static func awaitOpen(_ runtime: OfficeRuntime, path: String) async throws -> String {
        runtime.open(path)
        return try await withCheckedThrowingContinuation { continuation in
            var resolved = false
            var cancellable: AnyCancellable?
            cancellable = runtime.$state.sink { state in
                guard !resolved else { return }
                if let entry = state.documents[path] {
                    resolved = true
                    continuation.resume(returning: entry.docId)
                } else if let reason = state.openFailures[path] {
                    resolved = true
                    continuation.resume(throwing: OfficeAgentBrokerError.openFailed(path: path, reason: reason))
                } else if state.phase == .failed {
                    resolved = true
                    continuation.resume(throwing: OfficeAgentBrokerError.openFailed(
                        path: path, reason: state.failureReason ?? "The office helper is unavailable."))
                } else if state.phase == .idle {
                    resolved = true
                    continuation.resume(throwing: OfficeAgentBrokerError.openFailed(
                        path: path, reason: "the office runtime was torn down before the document could open."))
                } else {
                    return // .starting / .ready with no per-path answer yet: still genuinely in flight.
                }
                cancellable?.cancel()
            }
        }
    }
}

// MARK: - Rule 5: the fence

/// PURE: rule 5's containment check.
///
/// **v1 controller ruling (coordinator review F4, 2026-08-22): agent office tools — read or write —
/// are working-directories-only. This is a settled scope DECISION, not a disclosed narrowing pending
/// a follow-up.** The prior account below is kept because the mechanics it describes are unchanged;
/// what changed is the status: this used to be framed as "narrower than the daemon's own fence, a gap
/// to close later." A whole-branch review found that framing understated it — it does not merely
/// narrow spec §5 (which routes an office write outside the working dirs through the existing
/// approval flow, card → approved → proceed), it CONFLICTS with it, since a daemon-APPROVED write
/// into a tmp/outputs root or a persisted grant would still be refused here. The ruling resolves the
/// conflict in this direction, deliberately: the app has no wire visibility into daemon grants today,
/// and narrowing what a file-writing tool may touch is the safe direction to err in. **Task 3 must
/// not build a grants channel to widen this** — the spec is being amended to match this ruling, not
/// the other way around.
///
/// **Reads are fenced by this SAME check, for a different reason (settled alongside the ruling above,
/// coordinator re-review, 2026-08-22) — not swept in as an accident of write-side reasoning.** This
/// function has always run before `runOnce`'s own read/write branch (rule 5, the very first thing
/// checked), so a read was never actually exempt in practice; what the ruling adds is the WHY: an
/// office read is not an ordinary byte read the standing unrestricted-reads rule already governs
/// (`read`/`glob`/`grep`/`ls`, untouched by any of this) — it COPIES the target file into the
/// helper's own state directory and parses it with LibreOffice, an ingest, not an inspection, and the
/// same reasoning that keeps a write inside the session's own directories applies to it identically.
///
/// A Swift, app-side BACKSTOP behind the daemon's own fence (`resolveWithinAny`,
/// `packages/core/src/agent/paths.ts`) regardless — not a replacement for it. This checks exactly
/// `SessionSummary.dirs`, the session's working directories.
///
/// Mirrors `resolveWithinAny`'s semantics, not merely its message: a RELATIVE `path` resolves against
/// `dirs.first` (the primary), exactly as `resolveWithinAny` resolves against `roots[0]`; an ABSOLUTE
/// path is taken as-is. Containment is checked against EVERY entry in `dirs`, not just the primary —
/// a session's secondary/granted directories are equally in-fence, exactly as every one of TS's
/// `roots` is. Compared with a trailing separator (`root == target || target.hasPrefix(root + "/")`)
/// so `/x/proj-evil` can never match root `/x/proj`.
///
/// **THIS IS THE LOAD-BEARING FENCE, and it IS symlink-hardened (whole-branch review F4, CRITICAL).**
///
/// The prior text here said this was "not symlink-hardened … acceptable for a backstop behind the
/// daemon's own hardened check (`resolveWithinAny`)", and the daemon's three copies
/// (`sheets.ts`/`slides.ts`/`docs.ts`) said the mirror image — acceptable "behind the app's own
/// broker fence". **Both were wrong, and wrong in a way that hid the hole for three tools, nine task
/// reviews and two re-reviews: no office tool has ever called `resolveWithinAny`** (its only
/// consumers are `engine.ts` and `fs-read.ts`), so each layer deferred to a check the other never
/// performed. Running the same non-hardened check twice is not defence in depth against a symlink.
/// The old text also asserted a FALSE fact — `standardizingPath` does NOT resolve "the FIRST symlink
/// component"; it does no symlink resolution at all. Measured, not reasoned: with working directory
/// `<tmp>/proj` containing `link -> <tmp>/outside`, the pre-fix body RETURNED
/// `<tmp>/proj/link/secret.xlsx`, and `OfficeRuntime.placeAtomically`'s `rename()` then landed the
/// overwrite in `<tmp>/outside` — outside every declared working directory, reported as success.
///
/// **Why this side is load-bearing rather than the daemon's.** It runs in the process that performs
/// the write, immediately before `OfficeRuntime.open`/edit/save, so it is the narrowest gap between
/// check and effect; and the daemon is not the only possible caller — the identical reasoning that
/// made the app-side numeric ceilings load-bearing in T5's own sweep. The daemon's copies remain a
/// fast pre-dispatch refusal (better wording, no round trip) and are hardened too, but this one is
/// the gate.
///
/// **How.** Containment is judged on `resolvingSymlinksInPath` of BOTH the target and each root, so
/// the comparison is between where the path really lands and where the root really is. The RETURN
/// value is deliberately the UNRESOLVED, standardized `target` — the same contract
/// `resolveWithinAny` documents ("the RETURN value stays the caller's literal `target`"). That is
/// not tidiness: `runOnce` matches `documents[resolvedPath]` to decide whether to ADOPT the user's
/// already-open tab, so returning a link-resolved spelling would silently stop adopting and open a
/// second copy of a document the user already has on screen. A link that stays INSIDE the root still
/// passes and still returns the caller's spelling — pinned by its own control test, so the fix can
/// never degenerate into "symlinks are banned".
///
/// `dirs == nil` (no working-directory concept for this session) and `dirs == []` (a genuinely
/// workdir-less session) both mean "nothing to be within" — every path refuses, mirroring
/// `resolveWithinAny`'s own `roots.length === 0` guard ("no allowed directories configured").
///
/// Returns the resolved absolute path on success (what every later step must act on — the caller's
/// raw, possibly-relative `path` is never itself a valid `OfficeRuntime` key), `nil` on refusal.
func officeAgentResolvedPathWithinFence(_ path: String, dirs: [SessionDirEntry]?) -> String? {
    guard let dirs, !dirs.isEmpty else { return nil }
    // Order preserved, unfiltered — `roots.first` has to mean the PRIMARY (`dirs[0]`), exactly as
    // `resolvedFilePath`'s own `row?.dirs?.first?.path` does. Filtering empties out before indexing
    // would silently promote a SECONDARY to "primary" whenever `dirs[0]` happens to be degenerate —
    // `resolvedFilePath` refuses to resolve at all in that case, and this mirrors it, not a filtered
    // reordering of it.
    let roots = dirs.map { ($0.path as NSString).standardizingPath }

    let target: String
    if path.hasPrefix("/") {
        target = (path as NSString).standardizingPath
    } else {
        guard let primary = roots.first, !primary.isEmpty else { return nil }
        target = ((primary as NSString).appendingPathComponent(path) as NSString).standardizingPath
    }

    // F4: judge containment on where this path REALLY lands, never on its spelling. Both sides of
    // the comparison go through the same resolver so the platform's own normalizations (macOS maps
    // /tmp and /var through /private) can never make one side disagree with the other by accident.
    // A path with nothing on disk resolves to itself, so a not-yet-created file is judged exactly as
    // before — which is what keeps every fictional-root case in this file's own suite meaningful.
    let probe = (target as NSString).resolvingSymlinksInPath
    for root in roots where !root.isEmpty {
        let realRoot = (root as NSString).resolvingSymlinksInPath
        if probe == realRoot || probe.hasPrefix(realRoot + "/") { return target }
    }
    return nil
}

// MARK: - The broker's own refusals

/// Every way `OfficeAgentBroker.perform` can refuse or fail, each carrying enough to build the
/// ready-to-show sentence itself (`.message`) — callers (task 3+'s verbs, `OfficeCommandConsumer`
/// eventually) surface `.message` verbatim, the same "never re-derive wording" posture
/// `OfficeCommandConsumer`'s own refusal table already takes.
enum OfficeAgentBrokerError: Error, Equatable {
    /// Rule 5. `.message`'s FIRST sentence mirrors `resolveWithinAny`'s own thrown message verbatim
    /// (`path is outside the allowed directories: <path>`) — the brief's own instruction ("the same
    /// language `write` uses") — and `path` here is the CALLER's original argument, exactly as TS's
    /// own `p` is. A second sentence, added coordinator review F4 (2026-08-22), states the v1 scope
    /// decision plainly: worded access-NEUTRAL ("office tools," not "writes") because this refusal
    /// fires on a read verb outside the fence exactly as it does on a write — see
    /// `officeAgentResolvedPathWithinFence`'s own header for the ruling this states.
    case outOfFence(path: String)
    /// Rule 3, as office-live-ux Job 2 left it: no longer "the document is dirty" but "the
    /// document is dirty AND could not be saved first". `saveAttemptFailure` is the pre-save's own
    /// already-mapped reason, carried so the sentence can say what was tried — a refusal that only
    /// said "it's dirty" would read as "wait and retry", which is exactly the wrong instruction now
    /// that a save is always attempted first.
    case documentDirty(path: String, saveAttemptFailure: String)
    /// Fix round, review CRITICAL-1 — a WRITE to a document whose file also changed on disk while a
    /// tab held it. **Deliberately NOT `.documentDirty` with a new reason string**: that case's own
    /// doc and sentence both promise a save was attempted and failed, and no save is attempted here.
    /// Its advice ("Save or discard the tab's edits, then try again") is also the wrong instruction
    /// for a conflict — a save is exactly what would complete the loss. See
    /// `preSaveAdoptedDocument`'s own header for the full argument.
    case documentConflicted(path: String)
    /// Rule 1's "otherwise" branch failing. `reason` is ALREADY a mapped house-voice sentence
    /// (`OfficeRuntimeState.openFailures`/`.failureReason` are never raw LOK text — Stage B T9's own
    /// error table guarantees that at the source) — this case never re-maps it, only carries it.
    case openFailed(path: String, reason: String)
    /// Rule 4. Same "already mapped, never re-derived" posture as `.openFailed` for `SaveOutcome
    /// .failed`'s own reason; the `.noModel` case builds its own explanatory text at the call site
    /// since `SaveOutcome` itself carries no reason for that case.
    case saveFailed(path: String, reason: String)
    /// Second fix-round review (Important #2) — distinct from `.saveFailed` on purpose: this fires
    /// from WITHIN `action`, before rule 4's save switch runs at all, so wording it "couldn't save"
    /// would repeat the exact conflation the review caught in `sheets.ts`'s own description (earlier
    /// cells were never saved to begin with — nothing here ever tried). `reason` is already a fully
    /// composed, house-voice sentence (`OfficeCommandConsumer.handleSheetsSet`'s own closure), never
    /// re-derived here.
    case writeFailed(path: String, reason: String)
    /// The host deallocated between being asked and the minting door running — see `Host`'s own doc.
    case hostGone

    var message: String {
        switch self {
        case .outOfFence(let path):
            return "path is outside the allowed directories: \(path). Norma's office tools are "
                + "limited to the session's working directories."
        case .documentDirty(let path, let saveAttemptFailure):
            let name = (path as NSString).lastPathComponent
            // Names the ATTEMPT, not just the state. Norma now saves an open tab's edits before
            // writing to it, so reaching this refusal means that save was tried and failed — and a
            // sentence that said only "it has unsaved changes" would read as "wait and retry",
            // which is the one instruction that cannot help here.
            return "\(name) has unsaved changes in an open tab and Norma couldn't save them first "
                + "(\(saveAttemptFailure)) — so it will not overwrite them. Save or discard the "
                + "tab's edits, then try again."
        case .documentConflicted(let path):
            let name = (path as NSString).lastPathComponent
            // Names the SECOND party, and never says "save" — a save here is what would complete
            // the loss, so the only honest instruction is the banner's own two answers.
            return "\(name) changed on disk outside Norma while it was open in a tab, so there are "
                + "two versions of it and Norma will not pick one. The tab is showing a conflict "
                + "banner: the human has to answer it (keep their version, or reload the file from "
                + "disk) before this can be written to."
        case .openFailed(let path, let reason):
            return "Couldn't open \((path as NSString).lastPathComponent): \(reason)"
        case .saveFailed(let path, let reason):
            return "Couldn't save \((path as NSString).lastPathComponent): \(reason)"
        case .writeFailed(let path, let reason):
            return "Couldn't finish writing to \((path as NSString).lastPathComponent): \(reason)"
        case .hostGone:
            return "Norma's office runtime is no longer available."
        }
    }
}
