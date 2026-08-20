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

    // MARK: - Office Stage B Task 2: saveRequested / saveSucceeded / saveFailed / modifiedStatusChanged

    /// An open document at `.ready`, for the save tests below — mirrors `ready()`'s own shape one
    /// level up but LEAVES the document open (`ready()` itself opens then closes `/warm.xlsx`, so
    /// it is never useful here).
    private func readyWithOpenDocument(path: String = "/a.xlsx", docId: String = "doc-a") -> OfficeRuntimeState {
        reduce(OfficeRuntimeState(), [.openRequested(path: path), .helperBecameReady,
                                       .opened(path: path, docId: docId, metadata: metadata)]).0
    }

    func testSaveRequestedFromIdleIsANoOp() {
        let (state, effects) = reduce(OfficeRuntimeState(), [.saveRequested(path: "/a.xlsx")])
        XCTAssertEqual(state, OfficeRuntimeState())
        XCTAssertEqual(effects, [])
    }

    func testSaveRequestedFromStartingIsANoOp() {
        let (starting, _) = reduce(OfficeRuntimeState(), [.openRequested(path: "/a.xlsx")])
        let (state, effects) = reduce(starting, [.saveRequested(path: "/a.xlsx")])
        XCTAssertEqual(state, starting)
        XCTAssertEqual(effects, [])
    }

    func testSaveRequestedFromFailedIsANoOp() {
        let (failed, _) = reduce(OfficeRuntimeState(), [.helperUnavailable])
        let (state, effects) = reduce(failed, [.saveRequested(path: "/a.xlsx")])
        XCTAssertEqual(state, failed)
        XCTAssertEqual(effects, [])
    }

    func testSaveRequestedFromReadyWithNoOpenDocumentIsANoOp() {
        let (state, effects) = reduce(ready(), [.saveRequested(path: "/never-opened.xlsx")])
        XCTAssertEqual(state, ready())
        XCTAssertEqual(effects, [])
    }

    func testSaveRequestedFromReadyWithAnOpenDocumentEmitsSaveWithItsDocId() {
        let open = readyWithOpenDocument(path: "/a.xlsx", docId: "doc-a")
        let (state, effects) = reduce(open, [.saveRequested(path: "/a.xlsx")])
        XCTAssertEqual(state, open, "saveRequested alone touches no state — only the imperative half's own round trip does")
        XCTAssertEqual(effects, [.save(path: "/a.xlsx", docId: "doc-a")])
    }

    func testSaveSucceededClearsAStandingDeletedBanner() {
        var open = readyWithOpenDocument(path: "/a.xlsx", docId: "doc-a")
        open.documentBanners["/a.xlsx"] = "File was deleted on disk"

        let (state, effects) = reduce(open, [.saveSucceeded(path: "/a.xlsx", docId: "doc-a")])
        XCTAssertNil(state.documentBanners["/a.xlsx"], "a file just placed on disk cannot still be "
                     + "saying it was deleted")
        XCTAssertEqual(effects, [])
    }

    func testSaveSucceededForAPathWithNoDocumentIsANoOp() {
        let (state, effects) = reduce(ready(), [.saveSucceeded(path: "/never-opened.xlsx", docId: "doc-a")])
        XCTAssertEqual(state, ready())
        XCTAssertEqual(effects, [])
    }

    /// The stale-save guard: a RELOAD replaced `/a.xlsx`'s docId while this save's own round trip
    /// was still in flight (two independent async operations racing the same path) — the OLD
    /// docId's save landing here must not touch the NEW entry's banner.
    func testSaveSucceededForADocIdThatHasSinceBeenReplacedByAReloadIsANoOp() {
        var open = readyWithOpenDocument(path: "/a.xlsx", docId: "doc-old")
        open.documentBanners["/a.xlsx"] = "File was deleted on disk" // the reload's own banner-clear, simulated
        let (reloaded, _) = reduce(open, [.opened(path: "/a.xlsx", docId: "doc-new", metadata: metadata)])

        let (state, effects) = reduce(reloaded, [.saveSucceeded(path: "/a.xlsx", docId: "doc-old")])
        XCTAssertEqual(state, reloaded, "the stale save must not touch the newer entry's state at all")
        XCTAssertEqual(effects, [])
    }

    func testSaveSucceededOutsideReadyIsANoOp() {
        let (failed, _) = reduce(OfficeRuntimeState(), [.helperUnavailable])
        let (state, effects) = reduce(failed, [.saveSucceeded(path: "/a.xlsx", docId: "doc-a")])
        XCTAssertEqual(state, failed)
        XCTAssertEqual(effects, [])
    }

    func testSaveFailedSetsABannerReusingDocumentBannersAndEmitsIt() {
        let open = readyWithOpenDocument(path: "/a.xlsx", docId: "doc-a")
        let (state, effects) = reduce(open, [.saveFailed(path: "/a.xlsx", docId: "doc-a", reason: "disk full")])
        XCTAssertEqual(state.documentBanners["/a.xlsx"], "Couldn't save a.xlsx: disk full",
                       "reuses documentBanners verbatim — Task 8's own doc comment foretold this "
                       + "exact reuse rather than a second banner field")
        XCTAssertEqual(effects, [.emitBanner(reason: "Couldn't save a.xlsx: disk full")])
    }

    func testSaveFailedForADocIdThatHasSinceBeenReplacedIsANoOp() {
        let open = readyWithOpenDocument(path: "/a.xlsx", docId: "doc-old")
        let (reloaded, _) = reduce(open, [.opened(path: "/a.xlsx", docId: "doc-new", metadata: metadata)])

        let (state, effects) = reduce(reloaded, [.saveFailed(path: "/a.xlsx", docId: "doc-old", reason: "disk full")])
        XCTAssertEqual(state, reloaded, "a stale save's failure must not bannerize the newer, unrelated entry")
        XCTAssertEqual(effects, [])
    }

    func testSaveFailedForAPathWithNoDocumentIsANoOp() {
        let (state, effects) = reduce(ready(), [.saveFailed(path: "/never-opened.xlsx", docId: "doc-a", reason: "x")])
        XCTAssertEqual(state, ready())
        XCTAssertEqual(effects, [])
    }

    func testModifiedStatusChangedTrueSetsDirtyOnTheMatchingDocumentFoundByDocId() {
        let open = readyWithOpenDocument(path: "/a.xlsx", docId: "doc-a")
        let (state, effects) = reduce(open, [.modifiedStatusChanged(docId: "doc-a", modified: true)])
        XCTAssertEqual(state.documents["/a.xlsx"]?.dirty, true)
        XCTAssertEqual(effects, [])
    }

    func testModifiedStatusChangedFalseAfterTrueClearsDirty() {
        let open = readyWithOpenDocument(path: "/a.xlsx", docId: "doc-a")
        let (dirty, _) = reduce(open, [.modifiedStatusChanged(docId: "doc-a", modified: true)])
        XCTAssertEqual(dirty.documents["/a.xlsx"]?.dirty, true, "sanity")

        let (clean, _) = reduce(dirty, [.modifiedStatusChanged(docId: "doc-a", modified: false)])
        XCTAssertEqual(clean.documents["/a.xlsx"]?.dirty, false)
    }

    func testModifiedStatusChangedForAnUnknownDocIdIsANoOp() {
        let open = readyWithOpenDocument(path: "/a.xlsx", docId: "doc-a")
        let (state, effects) = reduce(open, [.modifiedStatusChanged(docId: "doc-that-does-not-exist", modified: true)])
        XCTAssertEqual(state, open)
        XCTAssertEqual(effects, [])
    }

    func testModifiedStatusChangedOutsideReadyIsANoOp() {
        let (failed, _) = reduce(OfficeRuntimeState(), [.helperUnavailable])
        let (state, effects) = reduce(failed, [.modifiedStatusChanged(docId: "doc-a", modified: true)])
        XCTAssertEqual(state, failed)
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

    /// **Review fix**: a delete that lands WHILE a reload is in flight sets `documentBanners` (the
    /// document entry is still present, so `.externalDeleted`'s guard passes); if that same reload
    /// then fails, `.reloadFailed` must not leave that banner standing over the `.openFailed` state
    /// it produces instead — `documentBanners` and `documents` must agree on whether there is a
    /// document to be a banner ABOUT (this state's own header names the invariant).
    func testReloadFailedClearsAnyDeletedBannerLeftBehindByAConcurrentExternalDelete() {
        let (open, _) = reduce(ready(), [.openRequested(path: "/a.xlsx"),
                                         .opened(path: "/a.xlsx", docId: "doc-a", metadata: metadata)])
        // The file vanished while some in-flight reload (for this same "doc-a") was still pending —
        // the document entry is untouched, so the delete's guard passes and the banner is set.
        let (deleted, _) = reduce(open, [.externalDeleted(path: "/a.xlsx")])
        XCTAssertEqual(deleted.documentBanners["/a.xlsx"], "File was deleted on disk", "sanity")

        let (state, effects) = reduce(deleted, [
            .reloadFailed(path: "/a.xlsx", oldDocId: "doc-a", reason: "corrupt file")
        ])
        XCTAssertNil(state.documentBanners["/a.xlsx"], "no document left behind for this banner to be "
                     + "about — the failure sentence below replaces it instead")
        XCTAssertNil(state.documents["/a.xlsx"])
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

    /// **Wave fix (T9 review M8)**: `.helperDied`/`.helperUnavailable` now ALSO emits `.unwatchFile`
    /// for every path that had an open document — see that reducer arm's own comment for why. Phases
    /// with no open documents keep the old, effects-are-just-the-banner shape; `"ready-with-doc"` and
    /// the new `"ready-with-two-docs"` prove the per-path emission (sorted, so two docs assert a
    /// stable order rather than depending on `Dictionary`'s own iteration order).
    func testHelperDiedFromEveryPhaseClearsEverythingFailsAndBannersAndUnwatchesEveryOpenDocument() {
        let idle = OfficeRuntimeState()
        let (starting, _) = reduce(OfficeRuntimeState(), [.openRequested(path: "/a.xlsx")])
        let openReady = ready()
        let (openWithDoc, _) = reduce(openReady, [.openRequested(path: "/a.xlsx"),
                                                   .opened(path: "/a.xlsx", docId: "doc-a", metadata: metadata)])
        let (openWithTwoDocs, _) = reduce(openReady, [.openRequested(path: "/a.xlsx"),
                                                       .opened(path: "/a.xlsx", docId: "doc-a", metadata: metadata),
                                                       .openRequested(path: "/b.xlsx"),
                                                       .opened(path: "/b.xlsx", docId: "doc-b", metadata: metadata)])
        let (alreadyFailed, _) = reduce(idle, [.helperDied])

        let banner = OfficeRuntimeEffect.emitBanner(reason: "The office helper stopped unexpectedly.")
        let cases: [(String, OfficeRuntimeState, [OfficeRuntimeEffect])] = [
            ("idle", idle, [banner]),
            ("starting", starting, [banner]),
            ("ready-empty", openReady, [banner]),
            ("ready-with-doc", openWithDoc, [banner, .unwatchFile(path: "/a.xlsx")]),
            ("ready-with-two-docs", openWithTwoDocs, [banner, .unwatchFile(path: "/a.xlsx"), .unwatchFile(path: "/b.xlsx")]),
            ("failed", alreadyFailed, [banner]),
        ]
        for (label, phase, expectedEffects) in cases {
            let (state, effects) = reduce(phase, [.helperDied])
            XCTAssertEqual(state.phase, .failed, label)
            XCTAssertEqual(state.documents, [:], label)
            XCTAssertEqual(state.pendingOpens, [], label)
            XCTAssertEqual(state.openFailures, [:], label)
            XCTAssertEqual(state.failureReason, "The office helper stopped unexpectedly.", label)
            XCTAssertEqual(effects, expectedEffects, label)
        }
    }

    func testHelperUnavailableFromEveryPhaseAlsoFailsWithItsOwnReasonAndUnwatchesEveryOpenDocument() {
        let openReady = ready()
        let (openWithDoc, _) = reduce(openReady, [.openRequested(path: "/a.xlsx"),
                                                   .opened(path: "/a.xlsx", docId: "doc-a", metadata: metadata)])
        let banner = OfficeRuntimeEffect.emitBanner(reason: "The office helper couldn't be started.")
        let cases: [(OfficeRuntimeState, [OfficeRuntimeEffect])] = [
            (OfficeRuntimeState(), [banner]),
            (reduce(OfficeRuntimeState(), [.openRequested(path: "/a.xlsx")]).0, [banner]),
            (openReady, [banner]),
            (openWithDoc, [banner, .unwatchFile(path: "/a.xlsx")]),
        ]
        for (phase, expectedEffects) in cases {
            let (state, effects) = reduce(phase, [.helperUnavailable])
            XCTAssertEqual(state.phase, .failed)
            XCTAssertEqual(state.failureReason, "The office helper couldn't be started.")
            XCTAssertEqual(effects, expectedEffects)
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

    // MARK: - prewarmRequested — office live-gate Bug 2: "have the helper ready," never an open

    /// The mirror of `testAnOpenFromIdleMovesToStartingQueuesThePathAndAsksForTheHelper` one door
    /// over: SAME effect (`.ensureHelperReady` — Bug 2's own "via the existing ensure path"), but
    /// `pendingOpens` stays EMPTY — nothing is ever opened by a pre-warm alone.
    func testPrewarmFromIdleMovesToStartingAndAsksForTheHelperWithNothingQueued() {
        let (state, effects) = reduce(OfficeRuntimeState(), [.prewarmRequested])
        XCTAssertEqual(state.phase, .starting)
        XCTAssertEqual(state.pendingOpens, [], "a pre-warm queues no document — only a real open does")
        XCTAssertEqual(effects, [.ensureHelperReady])
    }

    /// Prewarm-once: a second call while already `.starting` (another pre-warm, or a real open in
    /// flight) or already `.ready` changes nothing — mirrors `EditorRuntimeReducer.prewarmRequested`'s
    /// own "deliberately nothing at all, not a second [boot]" contract.
    func testPrewarmWhileStartingOrReadyIsANoOp() {
        let (starting, _) = reduce(OfficeRuntimeState(), [.prewarmRequested])
        let (stillStarting, startingEffects) = reduce(starting, [.prewarmRequested])
        XCTAssertEqual(stillStarting, starting)
        XCTAssertEqual(startingEffects, [])

        let (stillReady, readyEffects) = reduce(ready(), [.prewarmRequested])
        XCTAssertEqual(stillReady, ready())
        XCTAssertEqual(readyEffects, [])
    }

    /// **The deliberate divergence from `.openRequested`, pinned directly against the test just
    /// above.** `.openRequested` retries from `.failed` exactly like `.idle` (carry 4: the shared
    /// helper's contract is "relaunch on next demand," and a real open IS a demand). A pre-warm is
    /// NOT a demand — every tab-opening door reaches `panelDidReveal` on every click
    /// (`ShellSessionHost.panelDidReveal`'s own doc), so retrying a full supervisor boot cycle from
    /// `.failed` on a mere reveal would re-fight the crashy helper on every click into the session
    /// until a real open eventually does the same job anyway. `.failed` stays `.failed`, untouched,
    /// exactly like `EditorRuntimeReducer.prewarmRequested`'s own guard (`state.phase == .idle` only)
    /// — Office's pre-warm is narrower than its own `.openRequested`, on purpose, for this one phase.
    func testPrewarmFromFailedIsDeliberatelyANoOpUnlikeOpenRequested() {
        let (failed, _) = reduce(OfficeRuntimeState(), [.helperUnavailable])
        XCTAssertEqual(failed.phase, .failed)

        let (state, effects) = reduce(failed, [.prewarmRequested])
        XCTAssertEqual(state, failed, "no retry, no cleared failureReason — untouched, unlike a real "
                       + "openRequested's identical starting point")
        XCTAssertEqual(effects, [], "a pre-warm must never re-fight a crashy shared helper on every "
                       + "panel reveal — only a genuine open (a real demand) retries from .failed")
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
    /// until the first has fully finished.
    ///
    /// **Wave fix (T5.5 review flake-sibling — the reviewer's own named-but-not-yet-fixed twin of
    /// `testThreeOperationsRunInEnqueueOrder`'s fix below)**: this test originally used `async let
    /// first/second` to request both "concurrently" from the caller's perspective. That races two
    /// children independently onto this `@MainActor`-isolated queue, and their ARRIVAL order is not
    /// guaranteed to match SOURCE order — the identical unsound premise that made the sibling test
    /// ~25% flaky before its own fix (see that test's own header for the full reasoning); this one
    /// survived 20 iterations at review time but shares the exact same structural race and is
    /// fix-same-shape the moment it ever trips. `Task { @MainActor in ... }`, created back-to-back
    /// with no `await` between them, pins enqueue order to source order by construction instead —
    /// verified flake-free across 20 iterations (`-test-iterations 20`, 0 failures) before landing,
    /// the same bar the sibling fix used.
    func testTwoOverlappingOperationsRunStrictlySequentially() async throws {
        let queue = OfficeHelperRequestQueue()
        final class OrderBox { var events: [String] = [] }
        let box = OrderBox()

        let first = Task { @MainActor in
            try await queue.run {
                box.events.append("first-start")
                try await Task.sleep(nanoseconds: 100_000_000) // 100ms — comfortably longer than "second" needs
                box.events.append("first-end")
                return 1
            }
        }
        let second = Task { @MainActor in
            try await queue.run {
                box.events.append("second-start")
                return 2
            }
        }

        let results = try await (first.value, second.value)

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
    /// Office Stage B Task 2 — `save` defaults to an unused stub (nothing in the LIFECYCLE tests
    /// below calls `runtime.save`); the suppression-bag tests further down override it.
    private func makeDriver(metadata: OfficeDocumentMetadata = OfficeDocumentMetadata(
        type: .spreadsheet, parts: 1, sizeTwips: OfficeDocumentSize(widthTwips: 100, heightTwips: 100)),
        save: @escaping (String) async throws -> String = { _ in "/tmp/office-watcher-unused-save" })
        -> OfficeRuntime.Driver {
        OfficeRuntime.Driver(
            helperState: { .ready }, startHelper: { },
            open: { _, _ in metadata },
            close: { _ in },
            save: save,
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

    // MARK: - Wave fix (T9 review M8): watches on helper death

    /// **`open -> kill -> watchers empty`**: mirrors `testTeardownStopsEveryWatch` exactly, swapping
    /// `runtime.teardown()` for `runtime.handle(supervisorEvent: .helperDied)` — the SAME "every open
    /// document's watch must stop" claim, for the death path instead of the teardown path. Asserted
    /// synchronously right after the call: `handle(supervisorEvent:)` -> `dispatch` -> `perform`'s
    /// `.unwatchFile` case all run inline, no `Task { }`, no `await`.
    func testHelperDiedStopsEveryWatch() async throws {
        let pathA = try scratchFile(name: "a.xlsx")
        let pathB = try scratchFile(name: "b.xlsx")
        let watchers = OfficeWatcherRecorder()
        let runtime = OfficeRuntime(sessionId: "S1", driver: makeDriver(), makeWatcher: watchers.factory)
        runtimes.append(runtime)
        runtime.open(pathA)
        runtime.open(pathB)
        _ = await waitUntil { runtime.stateSnapshot.documents.count == 2 }

        runtime.handle(supervisorEvent: .helperDied)

        XCTAssertEqual(watchers.watchers.count, 2)
        XCTAssertTrue(watchers.watchers.values.allSatisfy(\.isStopped), "every watcher this runtime "
                      + "owned must stop the instant the helper dies — deferring to a later close can "
                      + "never happen once .helperDied has already wiped `documents`")
        XCTAssertEqual(runtime.stateSnapshot.phase, .failed)
    }

    /// **`close-after-death releases the fds`** — really: closing after death is a harmless no-op
    /// BECAUSE death already released them, not because the close itself does anything. Before this
    /// fix, `.closeRequested`'s own `.unwatchFile` was the ONLY door that ever stopped a watch, and
    /// it is gated on `state.documents[path]` existing — already wiped by `.helperDied` — so a close
    /// after death was a PERMANENT no-op and the fd never released for the runtime's remaining
    /// lifetime. This proves the release now happens at death, and that a subsequent close does not
    /// crash or double-stop anything.
    func testCloseAfterHelperDiedIsHarmlessSinceDeathAlreadyReleasedTheWatch() async throws {
        let path = try scratchFile()
        let watchers = OfficeWatcherRecorder()
        let runtime = OfficeRuntime(sessionId: "S1", driver: makeDriver(), makeWatcher: watchers.factory)
        runtimes.append(runtime)
        runtime.open(path)
        _ = await waitUntil { runtime.stateSnapshot.documents[path] != nil }
        let watcher = try XCTUnwrap(watchers.watchers[path])

        runtime.handle(supervisorEvent: .helperDied)
        XCTAssertTrue(watcher.isStopped, "the fd-owning watcher must already be released at death")

        runtime.close(path) // documents[path] is already nil post-death — must not crash or double-stop
        XCTAssertTrue(watcher.isStopped)
    }

    /// **`death -> reopen RE-SEEDS the baseline (no spurious reload of already-current content)`**:
    /// the file changes WHILE the helper is down (simulating an edit made during the outage, or
    /// simply time passing) — the watch for it was stopped at death, so nothing observes this. On
    /// reopen (the retry-affordance path — carry 4, `.failed` retries like `.idle`), a genuinely NEW
    /// watcher must be armed (proving the stale pre-death entry was really removed, not merely that
    /// `startWatching`'s own guard silently no-op'd), which is what lets the baseline re-seed to the
    /// file as reopen itself just read it. The very next fire — an ordinary lock-file-sibling churn,
    /// the ordinary case T3 already disclosed — must then be silent: a stale pre-death baseline would
    /// instead misread the mid-outage edit as happening NOW and spuriously reload content that is
    /// already exactly what is on screen.
    func testHelperDiedThenReopenReSeedsTheBaselineSoTheNextFireIsNotASpuriousReload() async throws {
        let path = try scratchFile(contents: "one")
        let watchers = OfficeWatcherRecorder()
        let runtime = OfficeRuntime(sessionId: "S1", driver: makeDriver(), makeWatcher: watchers.factory)
        runtimes.append(runtime)
        runtime.open(path)
        _ = await waitUntil { runtime.stateSnapshot.documents[path] != nil }

        runtime.handle(supervisorEvent: .helperDied)
        _ = await waitUntil { runtime.stateSnapshot.phase == .failed }

        try "two, a genuinely different length".write(toFile: path, atomically: true, encoding: .utf8)

        runtime.open(path) // the retry affordance path
        let reopened = await waitUntil { runtime.stateSnapshot.documents[path] != nil }
        XCTAssertTrue(reopened)
        let reopenedDocId = runtime.stateSnapshot.documents[path]?.docId

        XCTAssertEqual(watchers.created.filter { $0 == path }.count, 2, "the reopen must re-arm a "
                       + "genuinely new watcher — a leftover pre-death entry would make "
                       + "startWatching's own guard silently skip re-seeding the baseline")

        runtime.fileChangedOnDisk(path) // simulates the very next benign fire after the reopen
        try? await Task.sleep(nanoseconds: 30_000_000)
        XCTAssertEqual(runtime.stateSnapshot.documents[path]?.docId, reopenedDocId, "no genuine change "
                       + "since the reopen — a stale pre-death baseline would misread the mid-outage "
                       + "edit as happening NOW and trigger a spurious reload of content that is "
                       + "already current")
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

    // MARK: - Office Stage B Task 2: the save-suppression bag, driven through a real OfficeRuntime
    //
    // The bag Task 8's own comment predicted ("Stage B (once save exists) inherits that pattern
    // KNOWINGLY") arrives here. `officeDiskChange`'s `.ours` arm is not unit-tested on its own — it
    // never was, even pre-Task-2 (`officeDiskChange`'s two-way version had no dedicated pure test
    // either, only reducer-level `.externalChangeDetected`/`.externalDeleted` proofs) — the STRONGER
    // claim this section proves instead: a real save, through a real `OfficeRuntime`, leaves its own
    // watcher silent when it fires.

    /// **The load-bearing proof**: without the suppression bag, this fire would reload — a genuine
    /// content change (the temp file's own bytes) landed on `path` between the baseline `open` read
    /// and this fire, exactly the shape `testFileChangedOnDiskWithAGenuineRewriteReloadsWithANewDocId`
    /// above proves DOES reload for an unclaimed change. The docId staying put IS the suppression
    /// working — the tripwire the task's own brief names: "documents[path].docId unchanged across
    /// the save."
    ///
    /// **The bag is already empty by the time this fires** (a real finding, caught by this exact
    /// test before the fix — see `performSave`'s own `withdrawExpectedWrite` comment): the baseline
    /// re-seed lands, synchronously, in the SAME continuation, before this test ever calls
    /// `watcher.fire()`, so the fire below reads `.unchanged` (the baseline already matches),
    /// never `.ours` — the bag's own job is the narrower race
    /// `testAGenuineOursRaceIsConsumedWhenTheFireArrivesBeforeTheBaselineReSeeds` below exercises
    /// directly. Both are "suppressed," just via different arms of `officeDiskChange`.
    func testASavesOwnWatcherFireIsSuppressedAndDoesNotReload() async throws {
        let path = try scratchFile(contents: "one")
        let tempDir = URL(fileURLWithPath: "/tmp/office-watcher-save-temp-\(UUID().uuidString.prefix(8))", isDirectory: true)
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        scratchDirs.append(tempDir)
        let tempPath = tempDir.appendingPathComponent("rendered.xlsx").path
        try "the helper's own rendered content".write(toFile: tempPath, atomically: true, encoding: .utf8)

        let watchers = OfficeWatcherRecorder()
        let runtime = OfficeRuntime(sessionId: "S1", driver: makeDriver(save: { _ in tempPath }),
                                    makeWatcher: watchers.factory)
        runtimes.append(runtime)
        runtime.open(path)
        _ = await waitUntil { runtime.stateSnapshot.documents[path] != nil }
        let originalDocId = try XCTUnwrap(runtime.stateSnapshot.documents[path]?.docId)

        runtime.save(path)
        let saved = await waitUntil {
            (try? String(contentsOfFile: path, encoding: .utf8)) == "the helper's own rendered content"
        }
        XCTAssertTrue(saved, "the real file must hold the helper's rendered content once the save lands")
        XCTAssertFalse(FileManager.default.fileExists(atPath: tempPath), "the helper's own temp render "
                       + "must be cleaned up once placed, win or lose")
        let settled = await waitUntil { runtime.expectedWriteCount(for: path) == 0 }
        XCTAssertTrue(settled, "the save's own note is withdrawn by its own continuation, not left "
                      + "for a watcher to find")

        // The watcher's own fire — exactly what a real DispatchSource would deliver for this save's
        // own rename, simulated directly (the watcher mechanism itself is `OfficeWatcherRecorder`'s
        // double, unmodified — see this file's own header on why that is never re-tested here).
        let watcher = try XCTUnwrap(watchers.watchers[path])
        watcher.fire()

        try? await Task.sleep(nanoseconds: 30_000_000) // give a wrongly-reloading version time to act
        XCTAssertEqual(runtime.stateSnapshot.documents[path]?.docId, originalDocId, "a real reload "
                       + "here would mint a fresh docId — the task's own tripwire")
        XCTAssertNil(runtime.stateSnapshot.documentBanners[path], "no banner — a silent reload was "
                     + "never even attempted")
    }

    /// **The genuine `.ours` race, provoked directly** (bypassing `performSave`'s own async round
    /// trip, which — per the test above — usually wins the race against a fire): note a write is
    /// about to happen, put NEW bytes on disk exactly as a landed rename would, then fire the
    /// watcher's callback BEFORE anything re-seeds the baseline. This is the ONE window
    /// `performSave`'s own comment names ("the rename has landed and this continuation has not run
    /// yet") — proving the bag itself does the right thing when it, rather than the re-seed, is
    /// what has to catch the fire.
    func testAGenuineOursRaceIsConsumedWhenTheFireArrivesBeforeTheBaselineReSeeds() async throws {
        let path = try scratchFile(contents: "one")
        let runtime = OfficeRuntime(sessionId: "S1", driver: makeDriver())
        runtimes.append(runtime)
        runtime.open(path)
        _ = await waitUntil { runtime.stateSnapshot.documents[path] != nil }
        let originalDocId = try XCTUnwrap(runtime.stateSnapshot.documents[path]?.docId)

        runtime.noteExpectedWrite(path: path) // "a write is about to happen" — performSave's own first act
        try "the rename already landed".write(toFile: path, atomically: true, encoding: .utf8)
        runtime.fileChangedOnDisk(path) // the fire arrives before performSave's own re-seed would have

        XCTAssertEqual(runtime.stateSnapshot.documents[path]?.docId, originalDocId, "classified "
                       + ".ours — must not reload")
        XCTAssertNil(runtime.stateSnapshot.documentBanners[path])
        XCTAssertEqual(runtime.expectedWriteCount(for: path), 0, "the fire consumed the note; "
                       + "performSave's own later `withdrawExpectedWrite(path:token:)` (a no-op once "
                       + "its own token is already gone) must not double-decrement or crash")
    }

    /// **Task review fix round 1 (IMPORTANT-2) — the reviewer's own scenario, driven directly.**
    /// Two saves are in flight on the SAME path (two independent `.save` effects, exactly as a
    /// second ⌘S while the first is still saving would produce); a watcher fire lands between them,
    /// causally attributable to the FIRST save's own rename; the first save's own continuation then
    /// withdraws, exactly per `performSave`'s own sequence.
    ///
    /// **Before the fix** this test would have failed at the THIRD assertion below: `withdrawExpected
    /// Write` took a bare path and decremented an anonymous per-path COUNT — the fire's own consume
    /// and the first save's own withdraw both decremented the SAME integer, over-consuming by one
    /// and stealing the SECOND save's still-genuinely-outstanding note. That save's own later fire
    /// would then find the bag empty, read `.external` in `officeDiskChange`, and dispatch a
    /// spurious reload — the exact "its own rename reads external" failure the review named.
    ///
    /// **After the fix**, each note has its own identity (`ExpectedWriteToken`): a fire consumes the
    /// OLDEST still-pending token (FIFO — see the bag's own header on `pendingExpectedWrites` for
    /// why), and a save's own withdraw removes ONLY the exact token it was handed, a no-op once that
    /// token is already gone. The second save's own note survives the first save's redundant
    /// withdraw untouched, and the second save's own later fire correctly classifies `.ours`.
    func testASecondSavesNoteSurvivesAFireLandingBetweenTwoOverlappingSaves() async throws {
        let path = try scratchFile(contents: "one")
        let runtime = OfficeRuntime(sessionId: "S1", driver: makeDriver())
        runtimes.append(runtime)
        runtime.open(path)
        _ = await waitUntil { runtime.stateSnapshot.documents[path] != nil }
        let originalDocId = try XCTUnwrap(runtime.stateSnapshot.documents[path]?.docId)

        // Two saves' own notes, minted in order — `performSave`'s own first act, twice, for two
        // independent, overlapping `.save` effects on the SAME path.
        let firstSaveToken = runtime.noteExpectedWrite(path: path)
        let secondSaveToken = runtime.noteExpectedWrite(path: path)
        XCTAssertEqual(runtime.expectedWriteCount(for: path), 2, "setup: two notes genuinely outstanding")

        // The FIRST save's own rename lands, and its own watcher fire arrives BEFORE its own
        // continuation gets to withdraw — `testAGenuineOursRaceIsConsumedWhenTheFireArrivesBefore
        // TheBaselineReSeeds`'s own race, now with a SECOND save's note also outstanding.
        try "the first save's own rendered content".write(toFile: path, atomically: true, encoding: .utf8)
        runtime.fileChangedOnDisk(path)
        XCTAssertEqual(runtime.stateSnapshot.documents[path]?.docId, originalDocId, "the first save's "
                       + "own fire must classify .ours — no reload")
        XCTAssertEqual(runtime.expectedWriteCount(for: path), 1, "the fire consumed exactly ONE note "
                       + "(FIFO: the OLDEST, i.e. the first save's own) — the second save's own note "
                       + "must still be outstanding")

        // The FIRST save's own continuation now runs its withdraw, exactly as `performSave` always
        // does regardless of whether a fire already got there first.
        runtime.withdrawExpectedWrite(path: path, token: firstSaveToken)
        XCTAssertEqual(runtime.expectedWriteCount(for: path), 1, "THE CORE CLAIM: the first save's "
                       + "own (now redundant) withdraw must be a no-op — the second save's own note "
                       + "must survive it untouched, not get stolen")

        // The SECOND save's own rename lands later; its own fire must still correctly classify
        // `.ours` and consume the SURVIVING note — the reviewer's own "its own rename reads "
        // "`.external`" failure, proven NOT to happen.
        try "the second save's own rendered content".write(toFile: path, atomically: true, encoding: .utf8)
        runtime.fileChangedOnDisk(path)
        XCTAssertEqual(runtime.stateSnapshot.documents[path]?.docId, originalDocId, "the second "
                       + "save's own fire must ALSO classify .ours — a spurious reload here IS the "
                       + "bug this fix closes")
        XCTAssertNil(runtime.stateSnapshot.documentBanners[path], "no banner — no reload was attempted")
        XCTAssertEqual(runtime.expectedWriteCount(for: path), 0, "both notes now correctly retired, "
                       + "none leaked")

        // The second save's own (also now redundant) withdraw must likewise be a safe no-op.
        runtime.withdrawExpectedWrite(path: path, token: secondSaveToken)
        XCTAssertEqual(runtime.expectedWriteCount(for: path), 0)
    }

    /// A save that never gets a watcher fire at all (the debounce coalesced it away, or nothing in
    /// this test triggers one) still leaves the real content correct AND leaves no leaked note —
    /// `performSave`'s own `withdrawExpectedWrite` runs unconditionally on success, never waiting
    /// for a fire that may not come (the exact leak this test would have caught pre-fix: the bag
    /// stuck at 1 forever, ready to misclassify the NEXT genuine external edit as `.ours`).
    func testASaveWithNoWatcherFireAtAllStillLeavesNoLeakedNote() async throws {
        let path = try scratchFile(contents: "one")
        let tempPath = try scratchFile(name: "rendered.xlsx", contents: "rendered")
        let runtime = OfficeRuntime(sessionId: "S1", driver: makeDriver(save: { _ in tempPath }))
        runtimes.append(runtime)
        runtime.open(path)
        _ = await waitUntil { runtime.stateSnapshot.documents[path] != nil }

        runtime.save(path)
        let saved = await waitUntil { (try? String(contentsOfFile: path, encoding: .utf8)) == "rendered" }
        XCTAssertTrue(saved)
        let settled = await waitUntil { runtime.expectedWriteCount(for: path) == 0 }
        XCTAssertTrue(settled, "no fire ever arrived, and the note must still not be left standing")
    }
}

// MARK: - Office Stage B Task 2: OfficeRuntime.placeAtomically, driven directly

/// The atomic-place primitive on its own — no `OfficeRuntime`, no driver, just real scratch files.
/// Mirrors `EditorSaveTests`' own `testTheAtomicWrite*` block in spirit (same claims: replaces the
/// destination, creates one that was not there, keeps the original's permissions, leaves no
/// leftover temp on failure) — adapted for a source that is already bytes ON DISK rather than an
/// in-memory `String`.
final class OfficePlaceAtomicallyTests: XCTestCase {
    private var scratchDirs: [URL] = []

    override func tearDown() {
        for dir in scratchDirs { try? FileManager.default.removeItem(at: dir) }
        scratchDirs.removeAll()
        super.tearDown()
    }

    private func makeScratchDirectory() -> URL {
        let dir = URL(fileURLWithPath: "/tmp/office-place-atomically-\(UUID().uuidString.prefix(8))", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        scratchDirs.append(dir)
        return dir
    }

    func testReplacesAnExistingDestinationWithTheTempsContentAndLeavesNoLeftoverTemp() throws {
        let docDir = makeScratchDirectory()
        let destination = docDir.appendingPathComponent("gate.xlsx")
        try "original".write(to: destination, atomically: true, encoding: .utf8)
        let helperTempDir = makeScratchDirectory() // a DIFFERENT directory — the whole point being proven
        let helperTemp = helperTempDir.appendingPathComponent("rendered")
        try "rendered content".write(to: helperTemp, atomically: true, encoding: .utf8)

        try OfficeRuntime.placeAtomically(tempPath: helperTemp.path, at: destination.path)

        XCTAssertEqual(try String(contentsOf: destination, encoding: .utf8), "rendered content")
        let siblings = try FileManager.default.contentsOfDirectory(atPath: docDir.path)
        XCTAssertEqual(siblings, ["gate.xlsx"], "no `.norma-save-…` sibling left behind")
    }

    func testCreatesADestinationThatWasNotThere() throws {
        let docDir = makeScratchDirectory()
        let destination = docDir.appendingPathComponent("new.xlsx")
        let helperTemp = makeScratchDirectory().appendingPathComponent("rendered")
        try "brand new".write(to: helperTemp, atomically: true, encoding: .utf8)

        try OfficeRuntime.placeAtomically(tempPath: helperTemp.path, at: destination.path)

        XCTAssertEqual(try String(contentsOf: destination, encoding: .utf8), "brand new")
    }

    func testKeepsTheOriginalsPosixPermissions() throws {
        let docDir = makeScratchDirectory()
        let destination = docDir.appendingPathComponent("gate.xlsx")
        try "original".write(to: destination, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: destination.path)
        let helperTemp = makeScratchDirectory().appendingPathComponent("rendered")
        try "rendered".write(to: helperTemp, atomically: true, encoding: .utf8)

        try OfficeRuntime.placeAtomically(tempPath: helperTemp.path, at: destination.path)

        let mode = (try FileManager.default.attributesOfItem(atPath: destination.path))[.posixPermissions] as? Int
        XCTAssertEqual(mode, 0o600)
    }

    func testThrowsAndLeavesNoSiblingWhenTheDestinationDirectoryIsNotThere() throws {
        let missingDir = URL(fileURLWithPath: "/tmp/office-place-atomically-missing-\(UUID().uuidString.prefix(8))")
        let destination = missingDir.appendingPathComponent("gate.xlsx")
        let helperTemp = makeScratchDirectory().appendingPathComponent("rendered")
        try "rendered".write(to: helperTemp, atomically: true, encoding: .utf8)

        XCTAssertThrowsError(try OfficeRuntime.placeAtomically(tempPath: helperTemp.path, at: destination.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: missingDir.path), "never even creates "
                       + "the missing directory, let alone a leftover sibling in it")
    }

    /// The EXDEV-safety argument, made concrete rather than only argued in the doc comment: the
    /// helper's own temp lives in a WHOLLY UNRELATED directory tree from the document's — proving
    /// the source and the final rename target never need to share a directory, which is what makes
    /// the design safe against them not sharing a FILESYSTEM either (`FileManager.copyItem` handles
    /// a cross-volume source; the actual `rename(2)` is always same-directory, by construction, no
    /// matter where `tempPath` started out — see `placeAtomically`'s own doc for the full argument).
    func testSourceAndDestinationNeedNoRelationshipAtAll() throws {
        let unrelatedRoot = makeScratchDirectory()
        let helperTemp = unrelatedRoot
            .appendingPathComponent("deeply/nested/state/path/saves", isDirectory: true)
        try FileManager.default.createDirectory(at: helperTemp, withIntermediateDirectories: true)
        let renderedFile = helperTemp.appendingPathComponent("doc-1-7.xlsx")
        try "far away content".write(to: renderedFile, atomically: true, encoding: .utf8)

        let docDir = makeScratchDirectory()
        let destination = docDir.appendingPathComponent("gate.xlsx")
        try "original".write(to: destination, atomically: true, encoding: .utf8)

        try OfficeRuntime.placeAtomically(tempPath: renderedFile.path, at: destination.path)
        XCTAssertEqual(try String(contentsOf: destination, encoding: .utf8), "far away content")
    }
}
