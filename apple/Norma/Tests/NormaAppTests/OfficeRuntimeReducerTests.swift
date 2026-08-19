import XCTest
@testable import Norma

/// Office Stage A Task 5 — `OfficeRuntimeReducer`, PURE: no supervisor, no helper process, no
/// socket. Mirrors `EditorRuntimeReducerTests`' own shape (a `reduce(state, [events])` fold plus a
/// `ready()` convenience builder) — the same reason that file gives: every claim this task makes
/// about the runtime's lifecycle is a row here, drivable with nothing but the reducer itself.
@MainActor
final class OfficeRuntimeReducerTests: XCTestCase {

    private func reduce(_ state: OfficeRuntimeState,
                        _ events: [OfficeRuntimeEvent]) -> (OfficeRuntimeState, [OfficeRuntimeEffect]) {
        var current = state
        var effects: [OfficeRuntimeEffect] = []
        for event in events {
            let (next, produced) = OfficeRuntimeReducer.reduce(current, event)
            current = next
            effects.append(contentsOf: produced)
        }
        return (current, effects)
    }

    private let metadata = OfficeDocumentMetadata(
        type: .spreadsheet, parts: 3, sizeTwips: OfficeDocumentSize(widthTwips: 100, heightTwips: 200))

    /// A runtime that has the (shared) helper up and is holding nothing.
    private func ready() -> OfficeRuntimeState {
        reduce(OfficeRuntimeState(), [.openRequested(path: "/warm.xlsx"), .helperBecameReady,
                                       .opened(path: "/warm.xlsx", docId: "warm-doc", metadata: metadata),
                                       .closeRequested(path: "/warm.xlsx")]).0
    }

    // MARK: - openRequested: idle is its own "ask the helper to start"

    func testAnOpenFromIdleMovesToStartingQueuesThePathAndAsksForTheHelper() {
        let (state, effects) = reduce(OfficeRuntimeState(), [.openRequested(path: "/a.xlsx")])
        XCTAssertEqual(state.phase, .starting)
        XCTAssertEqual(state.pendingOpens, ["/a.xlsx"])
        XCTAssertEqual(effects, [.ensureHelperReady])
    }

    func testOpensRequestedWhileStartingAreQueuedInOrderDedupedAndFlushedOnReady() {
        let (starting, _) = reduce(OfficeRuntimeState(), [.openRequested(path: "/a.xlsx")])
        let (queued, queuedEffects) = reduce(starting, [
            .openRequested(path: "/b.xlsx"),
            .openRequested(path: "/a.xlsx")
        ])
        XCTAssertEqual(queuedEffects, [], "nothing may reach the helper before it is ready")
        XCTAssertEqual(queued.pendingOpens, ["/a.xlsx", "/b.xlsx"], "deduped, in the order asked")

        let (flushed, effects) = reduce(queued, [.helperBecameReady])
        XCTAssertEqual(flushed.phase, .ready)
        XCTAssertEqual(flushed.pendingOpens, [])
        XCTAssertEqual(effects, [.helperOpen(path: "/a.xlsx"), .helperOpen(path: "/b.xlsx")])
    }

    func testASecondHelperBecameReadyWhileAlreadyReadyChangesNothing() {
        let (state, effects) = reduce(ready(), [.helperBecameReady])
        XCTAssertEqual(state.phase, .ready)
        XCTAssertEqual(effects, [])
    }

    func testHelperBecameReadyWhileIdleIsANoOpNoOneAskedForAnything() {
        let (state, effects) = reduce(OfficeRuntimeState(), [.helperBecameReady])
        XCTAssertEqual(state, OfficeRuntimeState())
        XCTAssertEqual(effects, [])
    }

    /// T5 review M5(a): distinct from `testOpenRequestedFromFailedRetriesExactlyLikeIdle` (which is
    /// about a FRESH ask from `.failed`) — this is a `.helperBecameReady` fanned out because some
    /// OTHER session's demand restarted the shared helper, and it must NOT resurrect this one. A dead
    /// runtime leaves `.failed` only via its OWN `.openRequested`, never for free on someone else's
    /// success. This is exactly the behavior T6's re-open story and T9's SIGKILL-recovery drill
    /// depend on — nothing else in this file fails today if the reducer's `.starting`-only guard were
    /// relaxed to also admit `.failed`, which is why it needs its own pin.
    func testHelperBecameReadyWhileFailedStaysFailedNoFreeRecoveryFromAnotherSessionsRestart() {
        let (failed, _) = reduce(OfficeRuntimeState(), [.helperUnavailable])
        XCTAssertEqual(failed.phase, .failed)

        let (state, effects) = reduce(failed, [.helperBecameReady])
        XCTAssertEqual(state, failed, "a dead runtime does not self-recover just because some other "
                       + "session's demand brought the shared helper back")
        XCTAssertEqual(effects, [])
    }

    // MARK: - openRequested: ready opens directly, or no-ops on an already-open path

    func testAnOpenFromReadyAsksTheHelperDirectly() {
        let (state, effects) = reduce(ready(), [.openRequested(path: "/a.xlsx")])
        XCTAssertEqual(state.phase, .ready)
        XCTAssertEqual(effects, [.helperOpen(path: "/a.xlsx")])
    }

    func testAnOpenOfAPathAlreadyOpenAtReadyIsANoOp() {
        let (open, _) = reduce(ready(), [.openRequested(path: "/a.xlsx"),
                                         .opened(path: "/a.xlsx", docId: "doc-a", metadata: metadata)])
        let (again, effects) = reduce(open, [.openRequested(path: "/a.xlsx")])
        XCTAssertEqual(effects, [], "no per-runtime 'current'/'activate' concept — T6's tab layer "
                       + "owns dedupe/activate against its own already-open tab, mirroring "
                       + "openFileTab's contract; this runtime just keeps what it already has")
        XCTAssertEqual(again.documents, open.documents)
    }

    // MARK: - opened / openFailed

    func testOpenedRecordsTheDocumentWithPartsAndSizeAndClearsAnyPriorFailure() {
        var failed = ready()
        failed.openFailures["/a.xlsx"] = "stale failure from a previous attempt"

        let (state, effects) = reduce(failed, [
            .opened(path: "/a.xlsx", docId: "doc-a", metadata: metadata)
        ])
        XCTAssertEqual(effects, [.watchFile(path: "/a.xlsx")], "office-plumbing Task 8: opening arms "
                       + "the watch, the instant the document exists")
        XCTAssertEqual(state.documents["/a.xlsx"], OfficeRuntimeState.DocumentEntry(
            docId: "doc-a", type: .spreadsheet, parts: 3, activePart: 0,
            sizeTwips: OfficeDocumentSize(widthTwips: 100, heightTwips: 200)))
        XCTAssertNil(state.openFailures["/a.xlsx"], "a document that opened cannot still be a path "
                     + "that could not be opened")
    }

    func testOpenedIsIgnoredOutsideReadySoAStaleReplyCannotResurrectATornDownRuntime() {
        let (state, effects) = reduce(OfficeRuntimeState(), [
            .opened(path: "/a.xlsx", docId: "doc-a", metadata: metadata)
        ])
        XCTAssertEqual(state, OfficeRuntimeState())
        XCTAssertEqual(effects, [])
    }

    /// T5 review M5(b): the asymmetric sibling of `testOpenedIsIgnoredOutsideReadySoAStaleReplyCannot
    /// ResurrectATornDownRuntime` — `opened`'s outside-`.ready` guard was tested, `openFailed`'s own
    /// identical guard was not. A stale failure reply must not resurrect a torn-down runtime any more
    /// than a stale success reply may.
    func testOpenFailedIsIgnoredOutsideReadyForTheSameReasonOpenedIs() {
        let (state, effects) = reduce(OfficeRuntimeState(), [
            .openFailed(path: "/a.xlsx", reason: "corrupt file")
        ])
        XCTAssertEqual(state, OfficeRuntimeState())
        XCTAssertEqual(effects, [])
    }

    func testOpenFailedRecordsTheReasonAndEmitsABanner() {
        let (state, effects) = reduce(ready(), [.openFailed(path: "/broken.xlsx", reason: "corrupt file")])
        XCTAssertEqual(state.openFailures["/broken.xlsx"], "corrupt file")
        XCTAssertEqual(effects, [.emitBanner(reason: "Couldn't open broken.xlsx: corrupt file")])
    }

    func testANewOpenRequestSupersedesThePriorFailureForThatPathBeforeAnyPhaseDecidesAnything() {
        let (failed, _) = reduce(ready(), [.openFailed(path: "/broken.xlsx", reason: "corrupt file")])
        XCTAssertEqual(failed.openFailures["/broken.xlsx"], "corrupt file")

        let (retried, _) = reduce(failed, [.openRequested(path: "/broken.xlsx")])
        XCTAssertNil(retried.openFailures["/broken.xlsx"], "a retry must not keep showing a stale "
                     + "failure while its own fresh attempt is in flight")
    }

    // MARK: - closeRequested

    func testClosingAnOpenDocumentRemovesItAndAsksTheHelperToClose() {
        let (open, _) = reduce(ready(), [.openRequested(path: "/a.xlsx"),
                                         .opened(path: "/a.xlsx", docId: "doc-a", metadata: metadata)])
        let (closed, effects) = reduce(open, [.closeRequested(path: "/a.xlsx")])
        XCTAssertEqual(effects, [.helperClose(docId: "doc-a"), .unwatchFile(path: "/a.xlsx")],
                       "office-plumbing Task 8: the watch goes with the document")
        XCTAssertNil(closed.documents["/a.xlsx"])
    }

    func testClosingAPathThatWasNeverOpenIsANoOp() {
        let (state, effects) = reduce(ready(), [.closeRequested(path: "/never.xlsx")])
        XCTAssertEqual(state, ready())
        XCTAssertEqual(effects, [])
    }

    func testClosingAQueuedOpenCancelsItRatherThanOpeningItLater() {
        let (starting, _) = reduce(OfficeRuntimeState(), [.openRequested(path: "/a.xlsx"),
                                                           .openRequested(path: "/b.xlsx")])
        let (afterClose, closeEffects) = reduce(starting, [.closeRequested(path: "/a.xlsx")])
        XCTAssertEqual(closeEffects, [])
        XCTAssertEqual(afterClose.pendingOpens, ["/b.xlsx"])

        let (flushed, effects) = reduce(afterClose, [.helperBecameReady])
        XCTAssertEqual(effects, [.helperOpen(path: "/b.xlsx")], "the cancelled path never reaches the helper")
    }

    func testClosingClearsAnyRecordedOpenFailureForThatPath() {
        let (failed, _) = reduce(ready(), [.openFailed(path: "/broken.xlsx", reason: "corrupt file")])
        let (closed, _) = reduce(failed, [.closeRequested(path: "/broken.xlsx")])
        XCTAssertNil(closed.openFailures["/broken.xlsx"])
    }

    // MARK: - subscribeRequested / unsubscribeRequested (T6's tile door, thin at T5)

    private let viewport = OfficeTwipsRect(x: 0, y: 0, width: 1000, height: 2000)

    func testSubscribingToAnOpenDocumentRecordsTheActivePartAndAsksTheHelper() {
        let (open, _) = reduce(ready(), [.openRequested(path: "/a.xlsx"),
                                         .opened(path: "/a.xlsx", docId: "doc-a", metadata: metadata)])
        let (subscribed, effects) = reduce(open, [
            .subscribeRequested(path: "/a.xlsx", part: 2, zoomPPT: 26214, viewportTwips: viewport)
        ])
        XCTAssertEqual(subscribed.documents["/a.xlsx"]?.activePart, 2)
        XCTAssertEqual(effects, [.subscribe(docId: "doc-a", part: 2, zoomPPT: 26214, viewportTwips: viewport)])
    }

    func testSubscribingToAPathThatIsNotOpenIsANoOp() {
        let (state, effects) = reduce(ready(), [
            .subscribeRequested(path: "/never.xlsx", part: 0, zoomPPT: 26214, viewportTwips: viewport)
        ])
        XCTAssertEqual(state, ready())
        XCTAssertEqual(effects, [])
    }

    func testUnsubscribingFromAnOpenDocumentAsksTheHelperAndTouchesNoOtherState() {
        let (open, _) = reduce(ready(), [.openRequested(path: "/a.xlsx"),
                                         .opened(path: "/a.xlsx", docId: "doc-a", metadata: metadata)])
        let (state, effects) = reduce(open, [.unsubscribeRequested(path: "/a.xlsx")])
        XCTAssertEqual(effects, [.unsubscribe(docId: "doc-a")])
        XCTAssertEqual(state, open)
    }

    func testUnsubscribingFromAPathThatIsNotOpenIsANoOp() {
        let (state, effects) = reduce(ready(), [.unsubscribeRequested(path: "/never.xlsx")])
        XCTAssertEqual(state, ready())
        XCTAssertEqual(effects, [])
    }

    // MARK: - office-plumbing Task 8: externalChangeDetected / externalDeleted / reloadFailed

    func testExternalChangeDetectedOnAnOpenDocumentReloadsSilently() {
        let (open, _) = reduce(ready(), [.openRequested(path: "/a.xlsx"),
                                         .opened(path: "/a.xlsx", docId: "doc-a", metadata: metadata)])
        let (state, effects) = reduce(open, [.externalChangeDetected(path: "/a.xlsx")])
        XCTAssertEqual(effects, [.reloadDocument(path: "/a.xlsx", oldDocId: "doc-a")])
        // Stage A is view-only — no dirty buffer, no "keep mine" choice, no banner: this is ALWAYS
        // silent (T8 brief, verbatim). The document entry is UNTOUCHED through the gap — still the
        // OLD docId — which is what keeps `officeDocumentViewportPlan` on `.showCanvas` continuously
        // through the round trip (`.reloadDocument`'s own doc explains why that matters).
        XCTAssertEqual(state.documents["/a.xlsx"], open.documents["/a.xlsx"])
    }

    func testExternalChangeDetectedOnAPathThatIsNotOpenIsANoOp() {
        let (state, effects) = reduce(ready(), [.externalChangeDetected(path: "/never.xlsx")])
        XCTAssertEqual(state, ready())
        XCTAssertEqual(effects, [])
    }

    func testExternalChangeDetectedClearsAnyStandingDeletedBanner() {
        let (open, _) = reduce(ready(), [.openRequested(path: "/a.xlsx"),
                                         .opened(path: "/a.xlsx", docId: "doc-a", metadata: metadata)])
        let (deleted, _) = reduce(open, [.externalDeleted(path: "/a.xlsx")])
        XCTAssertEqual(deleted.documentBanners["/a.xlsx"], "File was deleted on disk")

        let (changed, _) = reduce(deleted, [.externalChangeDetected(path: "/a.xlsx")])
        XCTAssertNil(changed.documentBanners["/a.xlsx"], "the file proved it exists again — the "
                     + "deleted sentence cannot still be true")
    }

    func testExternalDeletedSetsAPersistentBannerAndLeavesTheDocumentEntryUntouched() {
        let (open, _) = reduce(ready(), [.openRequested(path: "/a.xlsx"),
                                         .opened(path: "/a.xlsx", docId: "doc-a", metadata: metadata)])
        let (state, effects) = reduce(open, [.externalDeleted(path: "/a.xlsx")])
        XCTAssertEqual(state.documentBanners["/a.xlsx"], "File was deleted on disk")
        XCTAssertEqual(effects, [.emitBanner(reason: "File was deleted on disk")])
        // **View-only, nothing to lose (T8 brief, verbatim)**: the document itself — every field —
        // is byte-for-byte what it was. Deletion bans nothing on screen; it only adds the sentence.
        XCTAssertEqual(state.documents["/a.xlsx"], open.documents["/a.xlsx"])
    }

    func testExternalDeletedOnAPathThatIsNotOpenIsANoOp() {
        let (state, effects) = reduce(ready(), [.externalDeleted(path: "/never.xlsx")])
        XCTAssertEqual(state, ready())
        XCTAssertEqual(effects, [])
    }

    /// T8 interface obligation 1 (activePart survives a reload): `.opened` is the SAME event a fresh
    /// open uses, and this is the row that proves it does double duty correctly — a reload's own
    /// `.opened` lands while the OLD entry (part 2 of 3) is still sitting in `documents[path]`
    /// (`.reloadDocument`'s own doc: never cleared first), and the new entry inherits it.
    func testAReloadsOpenedArmPreservesTheActivePartFromTheEntryItReplaces() {
        let (open, _) = reduce(ready(), [.openRequested(path: "/a.xlsx"),
                                         .opened(path: "/a.xlsx", docId: "doc-a", metadata: metadata)])
        let (switched, _) = reduce(open, [
            .subscribeRequested(path: "/a.xlsx", part: 2, zoomPPT: 1000, viewportTwips: viewport)
        ])
        XCTAssertEqual(switched.documents["/a.xlsx"]?.activePart, 2, "sanity")

        // The reload: same path, a freshly-minted docId, the SAME metadata (still 3 parts).
        let (reloaded, _) = reduce(switched, [
            .opened(path: "/a.xlsx", docId: "doc-a-reloaded", metadata: metadata)
        ])
        XCTAssertEqual(reloaded.documents["/a.xlsx"]?.docId, "doc-a-reloaded")
        XCTAssertEqual(reloaded.documents["/a.xlsx"]?.activePart, 2, "T8 obligation 1: the sheet the "
                       + "user was looking at survives the reload")
    }

    /// T8 interface obligation 3's reducer-level half: a modified file can have FEWER parts than the
    /// one it replaced — carrying `activePart` forward VERBATIM could point at a sheet that no
    /// longer exists. Clamped to the new document's own last valid part.
    func testAReloadsOpenedArmClampsThePreservedActivePartToTheNewDocumentsPartCount() {
        let (open, _) = reduce(ready(), [.openRequested(path: "/a.xlsx"),
                                         .opened(path: "/a.xlsx", docId: "doc-a", metadata: metadata)])
        let (switched, _) = reduce(open, [
            .subscribeRequested(path: "/a.xlsx", part: 2, zoomPPT: 1000, viewportTwips: viewport)
        ])
        XCTAssertEqual(switched.documents["/a.xlsx"]?.activePart, 2, "sanity")

        let shrunk = OfficeDocumentMetadata(type: .spreadsheet, parts: 1, sizeTwips: metadata.sizeTwips)
        let (reloaded, _) = reduce(switched, [.opened(path: "/a.xlsx", docId: "doc-a-reloaded", metadata: shrunk)])
        XCTAssertEqual(reloaded.documents["/a.xlsx"]?.parts, 1)
        XCTAssertEqual(reloaded.documents["/a.xlsx"]?.activePart, 0, "sheet index 2 does not exist "
                       + "in a 1-part document — clamped to the last valid part, never left dangling")
    }

    /// T8's overwrite-orphan guard: two reloads for the SAME path racing each other (the debounce's
    /// own window, or any other source of two independent `.reloadDocument`s in flight at once) can
    /// both succeed. The second `.opened` to land must not silently leak the first's docId on the
    /// shared helper.
    func testASecondOpenedForTheSamePathClosesTheDocIdItReplaces() {
        let (open, _) = reduce(ready(), [.openRequested(path: "/a.xlsx"),
                                         .opened(path: "/a.xlsx", docId: "doc-a", metadata: metadata)])
        // A second, independent reload's own reopen resolves — same path, a DIFFERENT fresh docId.
        let (state, effects) = reduce(open, [.opened(path: "/a.xlsx", docId: "doc-a-2", metadata: metadata)])
        XCTAssertEqual(state.documents["/a.xlsx"]?.docId, "doc-a-2", "the later arrival wins the slot")
        XCTAssertEqual(effects, [.watchFile(path: "/a.xlsx"), .helperClose(docId: "doc-a")],
                       "the docId being REPLACED must be closed — otherwise it leaks on the shared "
                       + "helper forever, with no owner left to ever close it")
    }

    /// The ordinary, non-racing case must NOT pay a redundant close: a document opening for the
    /// FIRST time (no `previousEntry` at all) has nothing to compensate.
    func testAFreshOpenedWithNoPriorEntryNeverEmitsACompensatingClose() {
        let (state, effects) = reduce(ready(), [.opened(path: "/a.xlsx", docId: "doc-a", metadata: metadata)])
        XCTAssertEqual(state.documents["/a.xlsx"]?.docId, "doc-a")
        XCTAssertEqual(effects, [.watchFile(path: "/a.xlsx")], "nothing to compensate — this path had "
                       + "no document a moment ago")
    }

    func testReloadFailedClearsTheDocumentAndRecordsTheFailureWhenItStillMatchesTheDocIdBeingReplaced() {
        let (open, _) = reduce(ready(), [.openRequested(path: "/a.xlsx"),
                                         .opened(path: "/a.xlsx", docId: "doc-a", metadata: metadata)])
        let (state, effects) = reduce(open, [
            .reloadFailed(path: "/a.xlsx", oldDocId: "doc-a", reason: "corrupt file")
        ])
        XCTAssertNil(state.documents["/a.xlsx"], "no document left to strand on a dead docId — the "
                     + "honest failure sentence replaces it")
        XCTAssertEqual(state.openFailures["/a.xlsx"], "corrupt file")
        XCTAssertEqual(effects, [.emitBanner(reason: "Couldn't reload a.xlsx: corrupt file"),
                                 .unwatchFile(path: "/a.xlsx")])
    }

    /// **The stale-failure guard, the case it exists for.** Two independent reloads for the same
    /// path: the SECOND succeeds and replaces `documents[path]` with a newer docId BEFORE the FIRST's
    /// own failure lands. The stale failure must not clobber the genuinely-fine newer document.
    func testReloadFailedIsIgnoredWhenANewerReloadAlreadySucceededAndReplacedTheEntryItWasReplacing() {
        let (open, _) = reduce(ready(), [.openRequested(path: "/a.xlsx"),
                                         .opened(path: "/a.xlsx", docId: "doc-a", metadata: metadata)])
        // The newer reload's reopen (for the SAME original docId, "doc-a") already succeeded.
        let (succeeded, _) = reduce(open, [.opened(path: "/a.xlsx", docId: "doc-a-new", metadata: metadata)])
        XCTAssertEqual(succeeded.documents["/a.xlsx"]?.docId, "doc-a-new", "sanity")

        // The OLDER reload attempt's own failure — still carrying the ORIGINAL "doc-a" it was
        // trying to replace — lands after the fact.
        let (state, effects) = reduce(succeeded, [
            .reloadFailed(path: "/a.xlsx", oldDocId: "doc-a", reason: "transient error")
        ])
        XCTAssertEqual(state, succeeded, "a superseded failure has nothing left to say")
        XCTAssertEqual(effects, [])
    }

    func testReloadFailedOutsideReadyIsIgnoredForTheSameReasonOpenFailedIs() {
        let (state, effects) = reduce(OfficeRuntimeState(), [
            .reloadFailed(path: "/a.xlsx", oldDocId: "doc-a", reason: "corrupt file")
        ])
        XCTAssertEqual(state, OfficeRuntimeState())
        XCTAssertEqual(effects, [])
    }

    /// Matrix-style, mirroring `testHelperDiedFromEveryPhaseClearsEverythingFailsAndBanners`'s own
    /// shape: `externalChangeDetected`/`externalDeleted` must be a safe no-op from every phase where
    /// the path in question has no open document — the only phase where either does anything at all
    /// is "this path currently has one," proven above.
    func testExternalChangeAndDeletedEventsAreNoOpsFromEveryPhaseWithoutAMatchingOpenDocument() {
        let idle = OfficeRuntimeState()
        let (starting, _) = reduce(OfficeRuntimeState(), [.openRequested(path: "/a.xlsx")])
        let (failed, _) = reduce(idle, [.helperUnavailable])
        let openReady = ready()

        for (label, phase) in [("idle", idle), ("starting", starting), ("failed", failed),
                                ("ready-empty", openReady)] {
            for event in [OfficeRuntimeEvent.externalChangeDetected(path: "/a.xlsx"),
                          .externalDeleted(path: "/a.xlsx")] {
                let (state, effects) = reduce(phase, [event])
                XCTAssertEqual(state, phase, "\(label) + \(event)")
                XCTAssertEqual(effects, [], "\(label) + \(event)")
            }
        }
    }

    // MARK: - helperDied / helperUnavailable — carry 4: EVERY phase, and it is never terminal

    func testHelperDiedFromEveryPhaseClearsEverythingFailsAndBanners() {
        let idle = OfficeRuntimeState()
        let (starting, _) = reduce(OfficeRuntimeState(), [.openRequested(path: "/a.xlsx")])
        let openReady = ready()
        let (openWithDoc, _) = reduce(openReady, [.openRequested(path: "/a.xlsx"),
                                                   .opened(path: "/a.xlsx", docId: "doc-a", metadata: metadata)])
        let (alreadyFailed, _) = reduce(idle, [.helperDied])

        for (label, phase) in [("idle", idle), ("starting", starting), ("ready-empty", openReady),
                                ("ready-with-doc", openWithDoc), ("failed", alreadyFailed)] {
            let (state, effects) = reduce(phase, [.helperDied])
            XCTAssertEqual(state.phase, .failed, label)
            XCTAssertEqual(state.documents, [:], label)
            XCTAssertEqual(state.pendingOpens, [], label)
            XCTAssertEqual(state.openFailures, [:], label)
            XCTAssertEqual(state.failureReason, "The office helper stopped unexpectedly.", label)
            XCTAssertEqual(effects, [.emitBanner(reason: "The office helper stopped unexpectedly.")], label)
        }
    }

    func testHelperUnavailableFromEveryPhaseAlsoFailsWithItsOwnReason() {
        for phase in [OfficeRuntimeState(), reduce(OfficeRuntimeState(), [.openRequested(path: "/a.xlsx")]).0, ready()] {
            let (state, effects) = reduce(phase, [.helperUnavailable])
            XCTAssertEqual(state.phase, .failed)
            XCTAssertEqual(state.failureReason, "The office helper couldn't be started.")
            XCTAssertEqual(effects, [.emitBanner(reason: "The office helper couldn't be started.")])
        }
    }

    /// Carry 4's OTHER half: unlike `EditorRuntimeState.Phase.failed` (terminal — "recovery is a
    /// teardown and a fresh runtime, never a second prewarm"), Office's `.failed` is retryable — the
    /// shared helper's own contract is "relaunch on next demand only," and a demand is exactly a
    /// fresh `openRequested`. Documented deviation from the Editor precedent, deliberate: EditorRuntime
    /// owns a per-runtime CEF browser that failing once leaves nothing sane to retry against; Office's
    /// helper is an app-wide process the NEXT open is entitled to ask for again.
    func testOpenRequestedFromFailedRetriesExactlyLikeIdle() {
        let (failed, _) = reduce(OfficeRuntimeState(), [.helperUnavailable])
        XCTAssertEqual(failed.phase, .failed)

        let (state, effects) = reduce(failed, [.openRequested(path: "/a.xlsx")])
        XCTAssertEqual(state.phase, .starting)
        XCTAssertEqual(state.pendingOpens, ["/a.xlsx"])
        XCTAssertNil(state.failureReason, "a fresh attempt supersedes the last failure's reason too")
        XCTAssertEqual(effects, [.ensureHelperReady])
    }

    // MARK: - teardownRequested — legal from every phase, always returns to a fresh idle state

    func testTeardownIsLegalFromEveryPhaseAndAlwaysReturnsToAFreshIdleState() {
        let idle = OfficeRuntimeState()
        let (starting, _) = reduce(OfficeRuntimeState(), [.openRequested(path: "/a.xlsx")])
        let (withDocs, _) = reduce(ready(), [
            .openRequested(path: "/a.xlsx"), .opened(path: "/a.xlsx", docId: "doc-a", metadata: metadata),
            .openRequested(path: "/b.xlsx"), .opened(path: "/b.xlsx", docId: "doc-b", metadata: metadata)
        ])
        let (failed, _) = reduce(idle, [.helperUnavailable])

        let (idleState, idleEffects) = reduce(idle, [.teardownRequested])
        XCTAssertEqual(idleState, OfficeRuntimeState())
        XCTAssertEqual(idleEffects, [.teardown(docIds: [])])

        let (startingState, startingEffects) = reduce(starting, [.teardownRequested])
        XCTAssertEqual(startingState, OfficeRuntimeState())
        XCTAssertEqual(startingEffects, [.teardown(docIds: [])], "nothing ever reached the helper "
                       + "while queued — no docId exists yet to close")

        let (docsState, docsEffects) = reduce(withDocs, [.teardownRequested])
        XCTAssertEqual(docsState, OfficeRuntimeState())
        XCTAssertEqual(docsEffects.count, 1, "exactly one .teardown effect, carrying every open docId")
        if case .teardown(let docIds)? = docsEffects.first {
            XCTAssertEqual(Set(docIds), Set(["doc-a", "doc-b"]), "both open docIds are handed to the "
                           + "imperative half to close")
        } else {
            XCTFail("expected a .teardown effect, got \(docsEffects)")
        }

        let (failedState, failedEffects) = reduce(failed, [.teardownRequested])
        XCTAssertEqual(failedState, OfficeRuntimeState())
        XCTAssertEqual(failedEffects, [.teardown(docIds: [])])
    }

    func testASecondTeardownIsSafe() {
        let (once, _) = reduce(ready(), [.teardownRequested])
        let (twice, twiceEffects) = reduce(once, [.teardownRequested])
        XCTAssertEqual(twice, OfficeRuntimeState())
        XCTAssertEqual(twiceEffects, [.teardown(docIds: [])])
    }
}

// MARK: - OfficeHelperRequestQueue: the shared client's request funnel

/// Office Stage A Task 5 — this queue is the addition beyond the brief's literal effect list,
/// justified by `OfficeHelperClient.expectReply`'s documented "single-outstanding-request"
/// contract (`OfficeHelperSupervisor`'s own header): two overlapping calls on the ONE shared
/// connection have no way to tell each other's replies apart. Every `ShellSessionHostTests` office
/// test bypasses this queue on purpose (its recorder-backed driver is used directly, never
/// `officeDriver(for:)`), so the queue's own correctness has no other test coverage — this is it.
@MainActor
final class OfficeHelperRequestQueueTests: XCTestCase {

    /// The whole point: a second operation enqueued WHILE the first is still running must not start
    /// until the first has fully finished. `async let` requests both "concurrently" from the
    /// caller's perspective — proving the queue itself, not merely the test's own sequencing, is
    /// what keeps them apart.
    func testTwoOverlappingOperationsRunStrictlySequentially() async throws {
        let queue = OfficeHelperRequestQueue()
        final class OrderBox { var events: [String] = [] }
        let box = OrderBox()

        async let first: Int = queue.run {
            box.events.append("first-start")
            try await Task.sleep(nanoseconds: 100_000_000) // 100ms — comfortably longer than "second" needs
            box.events.append("first-end")
            return 1
        }
        async let second: Int = queue.run {
            box.events.append("second-start")
            return 2
        }

        let results = try await (first, second)

        XCTAssertEqual(results.0, 1)
        XCTAssertEqual(results.1, 2)
        XCTAssertEqual(box.events, ["first-start", "first-end", "second-start"],
                       "the second operation must never start while the first is still outstanding")
    }

    /// A throw must not wedge the queue: the operation AFTER a failing one still runs, and gets its
    /// own answer.
    func testAThrowingOperationDoesNotBlockTheNextOne() async {
        let queue = OfficeHelperRequestQueue()
        struct Boom: Error, Equatable {}

        async let first: Int = queue.run { throw Boom() }
        async let second: Int = queue.run { 42 }

        do {
            _ = try await first
            XCTFail("expected the first operation's own error to propagate to ITS caller")
        } catch is Boom {
            // expected
        } catch {
            XCTFail("expected Boom, got \(error)")
        }
        let secondResult = try? await second
        XCTAssertEqual(secondResult, 42, "a throw in one operation must not block the next")
    }

    /// Three, in order, none of them overlapping — the queue is a real FIFO, not merely "two work."
    ///
    /// **T5.5 review: this test's original `async let a/b/c` shape was ~25% flaky (`[1, 3, 2]` etc.),
    /// and the fault was the test, not the queue.** `run` is `@MainActor`-isolated; three `async let`
    /// children race INDEPENDENTLY to reach it, and their arrival order at the actor is not
    /// guaranteed to match their SOURCE order — so the old hardcoded `[1, 2, 3]` assertion conflated
    /// "declared first" with "enqueued first." The queue's own FIFO-by-enqueue-order property held on
    /// every single run; only the test's premise (source order == enqueue order) was unsound.
    ///
    /// Fix: remove the race instead of trying to observe around it. All three `run` calls are
    /// enqueued SYNCHRONOUSLY, back to back, from this already-`@MainActor` test body — with no
    /// `await` between the three `Task { @MainActor in ... }` creations below, the actor cannot
    /// service any of them until this synchronous prefix itself suspends, so all three land on the
    /// SAME serial executor in exactly this creation order before any of them runs. Enqueue order is
    /// pinned to source order by construction, not by chance — verified flake-free across 20
    /// iterations (`-test-iterations 20`, 0 failures) before landing.
    func testThreeOperationsRunInEnqueueOrder() async throws {
        let queue = OfficeHelperRequestQueue()
        final class OrderBox { var events: [Int] = [] }
        let box = OrderBox()

        let first = Task { @MainActor in
            try await queue.run { box.events.append(1); try? await Task.sleep(nanoseconds: 30_000_000); return 1 }
        }
        let second = Task { @MainActor in
            try await queue.run { box.events.append(2); return 2 }
        }
        let third = Task { @MainActor in
            try await queue.run { box.events.append(3); return 3 }
        }

        _ = try await (first.value, second.value, third.value)

        XCTAssertEqual(box.events, [1, 2, 3])
    }
}

// MARK: - office-plumbing Task 8: the watcher, driven through a REAL OfficeRuntime

private final class OfficeFakeWatcher: FileTreeWatching {
    let path: String
    let onChange: () -> Void
    private(set) var isStopped = false

    init(path: String, onChange: @escaping () -> Void) {
        self.path = path
        self.onChange = onChange
    }

    func fire() { onChange() }
    func stop() { isStopped = true }
}

/// Mirrors `EditorConflictTests.EditorWatcherRecorder` exactly (same reasoning: `EditorFileWatcher
/// Factory` is `@MainActor`-typed, so nothing here ever runs off the main actor and no lock is
/// needed, unlike `ShellSessionHostTests.OfficeDriverRecorder`'s plain, non-`@MainActor` `Driver`
/// closures).
@MainActor
private final class OfficeWatcherRecorder {
    private(set) var created: [String] = []
    private(set) var watchers: [String: OfficeFakeWatcher] = [:]
    /// When true the factory answers `nil` — the "nothing could be watched" path.
    var refuse = false

    var factory: EditorFileWatcherFactory {
        { [unowned self] path, onChange in
            self.created.append(path)
            guard !self.refuse else { return nil }
            let watcher = OfficeFakeWatcher(path: path, onChange: onChange)
            self.watchers[path] = watcher
            return watcher
        }
    }
}

/// office-plumbing Task 8 — **the watcher and the reload, driven through a real `OfficeRuntime`.**
/// The watch itself is a double (mirrors `EditorWatcherTests`' identical choice: two kernel event
/// sources are not a unit test's to own — `DispatchSourceFileWatcher` is reused VERBATIM, unmodified,
/// and gets no test coverage here beyond what already exists for it), but everything downstream is
/// real: real scratch files, the real `officeFileStat`/`officeDiskChange` classifier, and the real
/// reducer via a real `OfficeRuntime` — only the DRIVER (the shared helper's own open/close/subscribe
/// surface) is a double, since this class is about the watcher, not the helper wire.
@MainActor
final class OfficeRuntimeWatcherTests: XCTestCase {
    private var scratchDirs: [URL] = []
    private var runtimes: [OfficeRuntime] = []

    override func tearDown() {
        for runtime in runtimes { runtime.teardown() }
        runtimes.removeAll()
        for dir in scratchDirs { try? FileManager.default.removeItem(at: dir) }
        scratchDirs.removeAll()
        super.tearDown()
    }

    private func scratchFile(name: String = "gate.xlsx", contents: String = "one") throws -> String {
        let dir = URL(fileURLWithPath: "/tmp/office-watcher-\(UUID().uuidString.prefix(8))", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        scratchDirs.append(dir)
        let file = dir.appendingPathComponent(name)
        try contents.write(to: file, atomically: true, encoding: .utf8)
        return file.path
    }

    /// Minimal, always-succeeding driver — this class is about the WATCHER, not the helper's own
    /// open/close/subscribe surface (`OfficeRuntimeReducerTests`/`ShellSessionHostTests` own that).
    private func makeDriver(metadata: OfficeDocumentMetadata = OfficeDocumentMetadata(
        type: .spreadsheet, parts: 1, sizeTwips: OfficeDocumentSize(widthTwips: 100, heightTwips: 100)))
        -> OfficeRuntime.Driver {
        OfficeRuntime.Driver(
            helperState: { .ready }, startHelper: { },
            open: { _, _ in metadata },
            close: { _ in },
            subscribeTiles: { _, _, _, _ in [] },
            unsubscribeTiles: { _ in },
            requestTiles: { _, _ in })
    }

    private func waitUntil(timeout: TimeInterval = 2, _ condition: () -> Bool) async -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition() {
            if Date() >= deadline { return false }
            try? await Task.sleep(nanoseconds: 5_000_000)
        }
        return true
    }

    // MARK: - Lifecycle

    /// **Armed at the moment the document opens — before the first external change to it is even
    /// possible** (T8's own structural argument, the SAME one `EditorWatcherTests
    /// .testAModelIsWatchedFromTheMomentItOpensUntilItCloses` makes for the editor): `.opened`'s
    /// effect batch runs `.watchFile` SYNCHRONOUSLY (`OfficeRuntime.perform`'s for-loop, no
    /// suspension point between `dispatch` returning and `startWatching` running), so by the time
    /// `stateSnapshot` shows the document at all, the watch already exists — not "usually by now."
    func testAWatchIsArmedTheInstantTheDocumentOpens() async throws {
        let path = try scratchFile()
        let watchers = OfficeWatcherRecorder()
        let runtime = OfficeRuntime(sessionId: "S1", driver: makeDriver(), makeWatcher: watchers.factory)
        runtimes.append(runtime)

        XCTAssertEqual(watchers.created, [], "nothing is watched before anything is open")
        runtime.open(path)
        let opened = await waitUntil { runtime.stateSnapshot.documents[path] != nil }
        XCTAssertTrue(opened)
        XCTAssertEqual(watchers.created, [path])
        let watcher = try XCTUnwrap(watchers.watchers[path])
        XCTAssertFalse(watcher.isStopped)
    }

    func testClosingADocumentStopsItsWatch() async throws {
        let path = try scratchFile()
        let watchers = OfficeWatcherRecorder()
        let runtime = OfficeRuntime(sessionId: "S1", driver: makeDriver(), makeWatcher: watchers.factory)
        runtimes.append(runtime)
        runtime.open(path)
        _ = await waitUntil { runtime.stateSnapshot.documents[path] != nil }
        let watcher = try XCTUnwrap(watchers.watchers[path])

        runtime.close(path)

        XCTAssertTrue(watcher.isStopped, "the watch goes with the document it describes")
    }

    func testTeardownStopsEveryWatch() async throws {
        let pathA = try scratchFile(name: "a.xlsx")
        let pathB = try scratchFile(name: "b.xlsx")
        let watchers = OfficeWatcherRecorder()
        let runtime = OfficeRuntime(sessionId: "S1", driver: makeDriver(), makeWatcher: watchers.factory)
        runtimes.append(runtime)
        runtime.open(pathA)
        runtime.open(pathB)
        _ = await waitUntil { runtime.stateSnapshot.documents.count == 2 }

        runtime.teardown()

        XCTAssertEqual(watchers.watchers.count, 2)
        XCTAssertTrue(watchers.watchers.values.allSatisfy(\.isStopped))
    }

    /// A factory that cannot watch anything is not a failure: the document opens, the tab works, and
    /// the file simply does not track disk (mirrors `EditorWatcherTests
    /// .testAWatchThatCouldNotBeStartedLeavesTheModelWorking`).
    func testAWatchThatCouldNotBeStartedLeavesTheDocumentWorking() async throws {
        let path = try scratchFile()
        let watchers = OfficeWatcherRecorder()
        watchers.refuse = true
        let runtime = OfficeRuntime(sessionId: "S1", driver: makeDriver(), makeWatcher: watchers.factory)
        runtimes.append(runtime)
        runtime.open(path)
        let opened = await waitUntil { runtime.stateSnapshot.documents[path] != nil }
        XCTAssertTrue(opened, "a watch that could not start is not an open failure")
        XCTAssertEqual(runtime.stateSnapshot.documentBanners, [:])
    }

    /// **The wiring itself**: the closure the runtime handed the watcher really reaches
    /// `fileChangedOnDisk` (mirrors `EditorWatcherTests.testTheWatchersOwnCallbackReachesTheHandler`
    /// — every OTHER test in this class drives `fileChangedOnDisk` directly; this is the one proof
    /// that door is the one the watcher actually knocks on).
    func testTheWatchersOwnCallbackReachesTheHandler() async throws {
        let path = try scratchFile(contents: "one")
        let watchers = OfficeWatcherRecorder()
        let runtime = OfficeRuntime(sessionId: "S1", driver: makeDriver(), makeWatcher: watchers.factory)
        runtimes.append(runtime)
        runtime.open(path)
        _ = await waitUntil { runtime.stateSnapshot.documents[path] != nil }
        let originalDocId = runtime.stateSnapshot.documents[path]?.docId

        try "two, a genuinely different length".write(toFile: path, atomically: true, encoding: .utf8)
        try XCTUnwrap(watchers.watchers[path]).fire()

        let reloaded = await waitUntil {
            runtime.stateSnapshot.documents[path] != nil && runtime.stateSnapshot.documents[path]?.docId != originalDocId
        }
        XCTAssertTrue(reloaded, "the watcher's own callback must reach fileChangedOnDisk and trigger a reload")
    }

    // MARK: - fileChangedOnDisk: the stat-based classifier (no suppression bag — see its own header)

    /// **The noise-filtering claim, pinned directly**: a fire that carries no real change to THIS
    /// file's own stat (a sibling in the same watched directory, a LOK lock file churning beside it
    /// — T3's disclosed concern, independently confirmed present in this very fixtures directory —
    /// or a directory-source fire this test simulates by simply calling the handler with nothing
    /// having moved) must not reload. This is the test that would have failed under the naive "any
    /// fire reloads" design the advisor caught before it landed.
    func testFileChangedOnDiskWithNoRealChangeToThisFilesOwnStatIsSilent() async throws {
        let path = try scratchFile(contents: "one")
        let watchers = OfficeWatcherRecorder()
        let runtime = OfficeRuntime(sessionId: "S1", driver: makeDriver(), makeWatcher: watchers.factory)
        runtimes.append(runtime)
        runtime.open(path)
        _ = await waitUntil { runtime.stateSnapshot.documents[path] != nil }
        let originalDocId = runtime.stateSnapshot.documents[path]?.docId

        runtime.fileChangedOnDisk(path) // nothing touched `path` itself since it opened

        try? await Task.sleep(nanoseconds: 30_000_000)
        XCTAssertEqual(runtime.stateSnapshot.documents[path]?.docId, originalDocId, "no genuine "
                       + "change to this file's own stat — must not reload")
    }

    func testFileChangedOnDiskWithAGenuineRewriteReloadsWithANewDocId() async throws {
        let path = try scratchFile(contents: "one")
        let watchers = OfficeWatcherRecorder()
        let runtime = OfficeRuntime(sessionId: "S1", driver: makeDriver(), makeWatcher: watchers.factory)
        runtimes.append(runtime)
        runtime.open(path)
        _ = await waitUntil { runtime.stateSnapshot.documents[path] != nil }
        let originalDocId = try XCTUnwrap(runtime.stateSnapshot.documents[path]?.docId)

        try "two, a genuinely different length".write(toFile: path, atomically: true, encoding: .utf8)
        runtime.fileChangedOnDisk(path)

        let reloaded = await waitUntil {
            runtime.stateSnapshot.documents[path] != nil && runtime.stateSnapshot.documents[path]?.docId != originalDocId
        }
        XCTAssertTrue(reloaded)
    }

    func testFileChangedOnDiskWithTheFileGoneBannersAndLeavesTheDocumentEntryAlone() async throws {
        let path = try scratchFile(contents: "one")
        let watchers = OfficeWatcherRecorder()
        let runtime = OfficeRuntime(sessionId: "S1", driver: makeDriver(), makeWatcher: watchers.factory)
        runtimes.append(runtime)
        runtime.open(path)
        _ = await waitUntil { runtime.stateSnapshot.documents[path] != nil }
        let before = runtime.stateSnapshot.documents[path]

        try FileManager.default.removeItem(atPath: path)
        runtime.fileChangedOnDisk(path)

        let bannered = await waitUntil { runtime.stateSnapshot.documentBanners[path] != nil }
        XCTAssertTrue(bannered)
        XCTAssertEqual(runtime.stateSnapshot.documentBanners[path], "File was deleted on disk")
        XCTAssertEqual(runtime.stateSnapshot.documents[path], before, "nothing to lose — the last "
                       + "rendered document stays exactly as it was")
    }

    /// The file coming back — even byte-for-byte identical to what was last known — is itself a
    /// change (mirrors `EditorRuntime.fileChangedOnDisk`'s identical "a `git checkout` of a deleted
    /// file must clear the banner it raised"): the baseline is CLEARED on deletion, not merely stale,
    /// so `officeDiskChange` cannot compare the file's return against a "baseline" that describes a
    /// file which, as far as this runtime is concerned, no longer exists.
    func testTheFileComingBackAfterADeletionIsTreatedAsAChangeAndClearsTheBanner() async throws {
        let path = try scratchFile(contents: "one")
        let watchers = OfficeWatcherRecorder()
        let runtime = OfficeRuntime(sessionId: "S1", driver: makeDriver(), makeWatcher: watchers.factory)
        runtimes.append(runtime)
        runtime.open(path)
        _ = await waitUntil { runtime.stateSnapshot.documents[path] != nil }
        let originalDocId = try XCTUnwrap(runtime.stateSnapshot.documents[path]?.docId)

        try FileManager.default.removeItem(atPath: path)
        runtime.fileChangedOnDisk(path)
        _ = await waitUntil { runtime.stateSnapshot.documentBanners[path] != nil }

        try "one".write(toFile: path, atomically: true, encoding: .utf8)
        runtime.fileChangedOnDisk(path)

        let reloaded = await waitUntil {
            runtime.stateSnapshot.documents[path] != nil && runtime.stateSnapshot.documents[path]?.docId != originalDocId
        }
        XCTAssertTrue(reloaded, "the file's return must be treated as a change even though its "
                      + "bytes are back to exactly what they were")
        XCTAssertNil(runtime.stateSnapshot.documentBanners[path], "a document that just reopened "
                     + "cannot still be saying it was deleted")
    }

    func testFileChangedOnDiskForAPathThisRuntimeDoesNotHoldIsIgnored() {
        let watchers = OfficeWatcherRecorder()
        let runtime = OfficeRuntime(sessionId: "S1", driver: makeDriver(), makeWatcher: watchers.factory)
        runtimes.append(runtime)
        runtime.fileChangedOnDisk("/never-opened.xlsx") // must not crash, must not dispatch anything
        XCTAssertEqual(runtime.stateSnapshot, OfficeRuntimeState())
    }
}
