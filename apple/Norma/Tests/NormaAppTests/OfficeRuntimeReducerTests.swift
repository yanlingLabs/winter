import XCTest
@testable import Norma
#if canImport(Darwin)
import Darwin
#endif

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
                                       .opened(path: "/warm.xlsx", docId: "warm-doc", stagedPath: "/staged/warm-doc", metadata: metadata, pathGeneration: 0),
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
        XCTAssertEqual(effects, [.helperOpen(path: "/a.xlsx", pathGeneration: 0), .helperOpen(path: "/b.xlsx", pathGeneration: 0)])
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
        XCTAssertEqual(effects, [.helperOpen(path: "/a.xlsx", pathGeneration: 0)])
    }

    func testAnOpenOfAPathAlreadyOpenAtReadyIsANoOp() {
        let (open, _) = reduce(ready(), [.openRequested(path: "/a.xlsx"),
                                         .opened(path: "/a.xlsx", docId: "doc-a", stagedPath: "/staged/doc-a", metadata: metadata, pathGeneration: 0)])
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
            .opened(path: "/a.xlsx", docId: "doc-a", stagedPath: "/staged/doc-a", metadata: metadata, pathGeneration: 0)
        ])
        XCTAssertEqual(effects, [.watchFile(path: "/a.xlsx")], "office-plumbing Task 8: opening arms "
                       + "the watch, the instant the document exists")
        XCTAssertEqual(state.documents["/a.xlsx"], OfficeRuntimeState.DocumentEntry(
            docId: "doc-a", stagedPath: "/staged/doc-a", type: .spreadsheet, parts: 3, activePart: 0,
            sizeTwips: OfficeDocumentSize(widthTwips: 100, heightTwips: 200)))
        XCTAssertNil(state.openFailures["/a.xlsx"], "a document that opened cannot still be a path "
                     + "that could not be opened")
    }

    func testOpenedIsIgnoredOutsideReadySoAStaleReplyCannotResurrectATornDownRuntime() {
        let (state, effects) = reduce(OfficeRuntimeState(), [
            .opened(path: "/a.xlsx", docId: "doc-a", stagedPath: "/staged/doc-a", metadata: metadata, pathGeneration: 0)
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
            .openFailed(path: "/a.xlsx", reason: "corrupt file", pathGeneration: 0)
        ])
        XCTAssertEqual(state, OfficeRuntimeState())
        XCTAssertEqual(effects, [])
    }

    func testOpenFailedRecordsTheReasonAndEmitsABanner() {
        let (state, effects) = reduce(ready(), [.openFailed(path: "/broken.xlsx", reason: "corrupt file", pathGeneration: 0)])
        XCTAssertEqual(state.openFailures["/broken.xlsx"], "corrupt file")
        XCTAssertEqual(effects, [.emitBanner(reason: "Couldn't open broken.xlsx: corrupt file")])
    }

    func testANewOpenRequestSupersedesThePriorFailureForThatPathBeforeAnyPhaseDecidesAnything() {
        let (failed, _) = reduce(ready(), [.openFailed(path: "/broken.xlsx", reason: "corrupt file", pathGeneration: 0)])
        XCTAssertEqual(failed.openFailures["/broken.xlsx"], "corrupt file")

        let (retried, _) = reduce(failed, [.openRequested(path: "/broken.xlsx")])
        XCTAssertNil(retried.openFailures["/broken.xlsx"], "a retry must not keep showing a stale "
                     + "failure while its own fresh attempt is in flight")
    }

    // MARK: - closeRequested

    func testClosingAnOpenDocumentRemovesItAndAsksTheHelperToClose() {
        let (open, _) = reduce(ready(), [.openRequested(path: "/a.xlsx"),
                                         .opened(path: "/a.xlsx", docId: "doc-a", stagedPath: "/staged/doc-a", metadata: metadata, pathGeneration: 0)])
        let (closed, effects) = reduce(open, [.closeRequested(path: "/a.xlsx")])
        XCTAssertEqual(effects, [.helperClose(docId: "doc-a"), .unwatchFile(path: "/a.xlsx"),
                                 .deleteStagedCopy(docId: "doc-a"),
                                 .clearAutosave(path: "/a.xlsx", docId: "doc-a", alsoClearManifestOwner: false)],
                       "office-plumbing Task 8: the watch goes with the document; Task 2b: so does its "
                       + "staged copy; Task 7: so does any autosave sidecar THIS docId grew — but "
                       + "never a DIFFERENT, standing candidate's own (fix round 1, review I-2; see "
                       + "testCloseRequestedWithAStandingRecoveryCandidateNeverClaimsTheManifestOwner)")
        XCTAssertNil(closed.documents["/a.xlsx"])
    }

    /// **Task 9 narrows this test's own former title** ("...IsANoOp" — no longer true of `state` as a
    /// whole): a close now bumps `pathGenerations[path]` UNCONDITIONALLY, even for a path with no
    /// document to close, precisely so an in-flight open racing this close (no `documents[path]`
    /// entry yet to compare against) can still be told it was superseded when its own `.opened`
    /// lands later — see `OfficeRuntimeState.pathGenerations`'s own header. Every OTHER field stays
    /// untouched, and effects stay empty — that half of the old claim is still true.
    func testClosingAPathThatWasNeverOpenBumpsItsTicketButIsOtherwiseANoOp() {
        let (state, effects) = reduce(ready(), [.closeRequested(path: "/never.xlsx")])
        var expected = ready()
        expected.pathGenerations["/never.xlsx"] = 1
        XCTAssertEqual(state, expected)
        XCTAssertEqual(effects, [])
    }

    func testClosingAQueuedOpenCancelsItRatherThanOpeningItLater() {
        let (starting, _) = reduce(OfficeRuntimeState(), [.openRequested(path: "/a.xlsx"),
                                                           .openRequested(path: "/b.xlsx")])
        let (afterClose, closeEffects) = reduce(starting, [.closeRequested(path: "/a.xlsx")])
        XCTAssertEqual(closeEffects, [])
        XCTAssertEqual(afterClose.pendingOpens, ["/b.xlsx"])

        let (flushed, effects) = reduce(afterClose, [.helperBecameReady])
        XCTAssertEqual(effects, [.helperOpen(path: "/b.xlsx", pathGeneration: 0)], "the cancelled path never reaches the helper")
    }

    func testClosingClearsAnyRecordedOpenFailureForThatPath() {
        let (failed, _) = reduce(ready(), [.openFailed(path: "/broken.xlsx", reason: "corrupt file", pathGeneration: 0)])
        let (closed, _) = reduce(failed, [.closeRequested(path: "/broken.xlsx")])
        XCTAssertNil(closed.openFailures["/broken.xlsx"])
    }

    // MARK: - subscribeRequested / unsubscribeRequested (T6's tile door, thin at T5)

    private let viewport = OfficeTwipsRect(x: 0, y: 0, width: 1000, height: 2000)

    func testSubscribingToAnOpenDocumentRecordsTheActivePartAndAsksTheHelper() {
        let (open, _) = reduce(ready(), [.openRequested(path: "/a.xlsx"),
                                         .opened(path: "/a.xlsx", docId: "doc-a", stagedPath: "/staged/doc-a", metadata: metadata, pathGeneration: 0)])
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
                                         .opened(path: "/a.xlsx", docId: "doc-a", stagedPath: "/staged/doc-a", metadata: metadata, pathGeneration: 0)])
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
                                       .opened(path: path, docId: docId, stagedPath: "/staged/\(docId)", metadata: metadata,
                                               pathGeneration: 0)]).0
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
        XCTAssertEqual(effects, [.save(path: "/a.xlsx", docId: "doc-a", part: 0)])
    }

    /// Fix round 4 (NEW-2) — the save effect carries the USER's own active part, not a hardcoded 0.
    /// Discriminating on purpose: `readyWithOpenDocument` alone leaves `activePart` at its 0
    /// default, which would pass the assertion above no matter what the reducer read. Here a real
    /// `.subscribeRequested` moves the document to part 2 first (the same reducer-owned write the
    /// input verbs' own `part` is resolved from), so the save's part can only be right by actually
    /// reading it.
    func testSaveRequestedCarriesTheDocumentsOwnActivePartNotZero() {
        let open = readyWithOpenDocument(path: "/a.xlsx", docId: "doc-a")
        let (onPart2, _) = reduce(open, [.subscribeRequested(path: "/a.xlsx", part: 2, zoomPPT: 1000,
                                                              viewportTwips: OfficeTwipsRect(x: 0, y: 0, width: 1, height: 1))])
        XCTAssertEqual(onPart2.documents["/a.xlsx"]?.activePart, 2, "setup: the document is on part 2")
        let (_, effects) = reduce(onPart2, [.saveRequested(path: "/a.xlsx")])
        XCTAssertEqual(effects, [.save(path: "/a.xlsx", docId: "doc-a", part: 2)],
                       "a save must record where the USER is, not whatever part a tile paint last "
                        + "left LOK parked at — see LOKBridge.saveAsOnDedicatedThread's own header")
    }

    func testSaveSucceededClearsAStandingDeletedBanner() {
        var open = readyWithOpenDocument(path: "/a.xlsx", docId: "doc-a")
        open.documentBanners["/a.xlsx"] = "File was deleted on disk"

        let (state, effects) = reduce(open, [.saveSucceeded(path: "/a.xlsx", docId: "doc-a")])
        XCTAssertNil(state.documentBanners["/a.xlsx"], "a file just placed on disk cannot still be "
                     + "saying it was deleted")
        XCTAssertEqual(effects, [.clearAutosave(path: "/a.xlsx", docId: "doc-a", alsoClearManifestOwner: true)],
                       "Task 7: a successful save is the app's own proof the real path now carries "
                       + "this docId's content — any sidecar it may have been growing is redundant; "
                       + "alsoClearManifestOwner: true since a save IS an explicit resolution "
                       + "(fix round 1, review I-2)")
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
        let (reloaded, _) = reduce(open, [.opened(path: "/a.xlsx", docId: "doc-new", stagedPath: "/staged/doc-new", metadata: metadata, pathGeneration: 0)])

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
        let (reloaded, _) = reduce(open, [.opened(path: "/a.xlsx", docId: "doc-new", stagedPath: "/staged/doc-new", metadata: metadata, pathGeneration: 0)])

        let (state, effects) = reduce(reloaded, [.saveFailed(path: "/a.xlsx", docId: "doc-old", reason: "disk full")])
        XCTAssertEqual(state, reloaded, "a stale save's failure must not bannerize the newer, unrelated entry")
        XCTAssertEqual(effects, [])
    }

    func testSaveFailedForAPathWithNoDocumentIsANoOp() {
        let (state, effects) = reduce(ready(), [.saveFailed(path: "/never-opened.xlsx", docId: "doc-a", reason: "x")])
        XCTAssertEqual(state, ready())
        XCTAssertEqual(effects, [])
    }

    // MARK: - Whole-branch review C1: a failed save leaves the document DIRTY
    //
    // The seam no single-task reviewer could see. LOK clears `ModifiedStatus` helper-side the
    // instant the helper's OWN `saveAs` completes — BEFORE `performSave`'s `placeAtomically` runs on
    // the app side (`saveAndAwaitOutcome`'s own header states the mechanism). So by the time a place
    // failure reaches `.saveFailed`, `dirty` has ALREADY been driven false by a genuine
    // `.modifiedStatusChanged(false)`, while the buffer differs from disk. T3 closed this for the
    // close-sheet door it owned (`saveAndAwaitOutcome` resolves authoritatively inside `performSave`
    // rather than watching `dirty`) — but the quit gate (`officeDirtyFilePaths`) and the session
    // departure (`releaseOfficeRuntimeIfClean`) both read the flag raw, so the state itself has to be
    // right. The rows below drive the real interleavings; `openedSavedCleanThenSaveFailed` reproduces
    // the exact ordering rather than asserting against a hand-built entry.

    /// The C1 fixture — ONE of the two orderings, driven end to end rather than hand-built: open,
    /// type (LOK fires `modified=true`), the helper's own `saveAs` completes and its
    /// `modified=false` is applied, and only THEN the app's `placeAtomically` fails and
    /// `.saveFailed` lands.
    ///
    /// **Which of the two arrives first is racy and is deliberately not pinned anywhere.** The
    /// helper clears `ModifiedStatus` early, but its delivery to the app is a separate round trip;
    /// the live drill measured the OTHER order (clean landing after the failure), and this fixture
    /// drives clean-before-failure. Both are covered on purpose — this row and
    /// `testALateModifiedStatusFalseAfterAFailedSaveDoesNotClearDirty` are the same bug approached
    /// from the two sides, and the fix has to hold for either.
    private func openedSavedCleanThenSaveFailed(path: String = "/a.xlsx", docId: String = "doc-a",
                                                reason: String = "disk full") -> OfficeRuntimeState {
        let dirty = openedAndDirty(path: path, docId: docId)
        let (lokWentClean, _) = reduce(dirty, [.modifiedStatusChanged(docId: docId, modified: false)])
        XCTAssertEqual(lokWentClean.documents[path]?.dirty, false,
                       "fixture precondition: LOK's helper-side ModifiedStatus clear lands BEFORE the "
                       + "place — this false is exactly what makes C1 a silent-loss bug")
        return reduce(lokWentClean, [.saveFailed(path: path, docId: docId, reason: reason)]).0
    }

    func testSaveFailedRestoresDirtyBecauseTheBufferGenuinelyDiffersFromDisk() {
        let state = openedSavedCleanThenSaveFailed()
        XCTAssertEqual(state.documents["/a.xlsx"]?.dirty, true,
                       "the place never landed, so the buffer differs from disk — this is the honest "
                       + "state, not a workaround")
        XCTAssertEqual(state.documents["/a.xlsx"]?.saveFailedPendingSave, true,
                       "app-held, because LOK will never re-fire modified=true on its own")
    }

    /// **The straggler row.** LOK's own `modified=false` for the save that failed can land AFTER
    /// `.saveFailed` (two independent round trips: the callback comes over the document-event
    /// channel, the failure from `performSave`'s own `catch`). Without the hold, that late event
    /// re-clears `dirty` and reopens the hole a beat later.
    func testALateModifiedStatusFalseAfterAFailedSaveDoesNotClearDirty() {
        let dirty = openedAndDirty(path: "/a.xlsx", docId: "doc-a")
        let (failed, _) = reduce(dirty, [.saveFailed(path: "/a.xlsx", docId: "doc-a", reason: "disk full")])
        XCTAssertEqual(failed.documents["/a.xlsx"]?.dirty, true, "sanity")

        let (state, _) = reduce(failed, [.modifiedStatusChanged(docId: "doc-a", modified: false)])
        XCTAssertEqual(state.documents["/a.xlsx"]?.dirty, true,
                       "LOK's \"clean\" here means \"matches the save that never reached disk\" — only "
                       + "a successful place may clear this dot")
        XCTAssertEqual(state.documents["/a.xlsx"]?.saveFailedPendingSave, true, "still held")
    }

    /// Typing on after a failed save: `dirty` was already true, and the hold must NOT be released by
    /// LOK agreeing with it — only a save that actually lands resolves it.
    func testModifiedStatusTrueAfterAFailedSaveKeepsBothDirtyAndTheHold() {
        let failed = openedSavedCleanThenSaveFailed()
        let (state, _) = reduce(failed, [.modifiedStatusChanged(docId: "doc-a", modified: true)])
        XCTAssertEqual(state.documents["/a.xlsx"]?.dirty, true)
        XCTAssertEqual(state.documents["/a.xlsx"]?.saveFailedPendingSave, true)
    }

    /// **The retry.** LOK's `ModifiedStatus` is already `false` from the FIRST save's own helper-side
    /// clear, and STATE_CHANGED fires on transitions — so a successful retry produces no second
    /// `modified=false` callback. `.saveSucceeded` therefore has to clear the dot directly, exactly
    /// the treatment `restoredPendingSave` already gets.
    func testASuccessfulRetryAfterAFailedSaveClearsDirtyAndTheHold() {
        let failed = openedSavedCleanThenSaveFailed()
        let (state, effects) = reduce(failed, [.saveSucceeded(path: "/a.xlsx", docId: "doc-a")])
        XCTAssertEqual(state.documents["/a.xlsx"]?.dirty, false,
                       "the bytes are on disk now — and no LOK transition is coming to say so")
        XCTAssertEqual(state.documents["/a.xlsx"]?.saveFailedPendingSave, false)
        XCTAssertNil(state.documentBanners["/a.xlsx"], "the failure banner goes with the failure")
        XCTAssertEqual(effects, [.clearAutosave(path: "/a.xlsx", docId: "doc-a", alsoClearManifestOwner: true)])
    }

    /// A reload/re-stage mints a fresh `DocumentEntry` — the hold must not survive into a document
    /// whose buffer came straight off disk.
    func testAReloadAfterAFailedSaveStartsCleanWithNoHold() {
        let failed = openedSavedCleanThenSaveFailed()
        let (state, _) = reduce(failed, [.opened(path: "/a.xlsx", docId: "doc-new", stagedPath: "/staged/doc-new",
                                                 metadata: metadata, pathGeneration: 0)])
        XCTAssertEqual(state.documents["/a.xlsx"]?.dirty, false)
        XCTAssertEqual(state.documents["/a.xlsx"]?.saveFailedPendingSave, false)
    }

    /// **Every write to `dirty` is masked, no exceptions** — T9's F3 posture, applied to this new
    /// writer too. Unreachable through any shipped door (`save(_:)`/`saveAndAwaitOutcome` both refuse
    /// a read-only-format path before a `.save` effect can exist), so this is defense-in-depth in the
    /// same shape `.modifiedStatusChanged`'s own mask already takes.
    func testSaveFailedForAReadOnlyFormatPathLeavesDirtyFalse() {
        let open = readyWithOpenDocument(path: "/a.xlsm", docId: "doc-a")
        let (state, _) = reduce(open, [.saveFailed(path: "/a.xlsm", docId: "doc-a", reason: "disk full")])
        XCTAssertEqual(state.documents["/a.xlsm"]?.dirty, false)
        XCTAssertEqual(state.documents["/a.xlsm"]?.saveFailedPendingSave, false)
    }

    /// **C1's three consumers of the flag, driven off the real post-failure state.** Two of them
    /// read it raw and are the doors that discarded the buffer silently: the quit gate did not name
    /// the document, and a mere session hop tore the runtime down. The third is the dirty-close
    /// sheet's own predicate — T3 made the sheet's SAVE arm authoritative, but whether the sheet
    /// FIRES at all is still this masked read of `dirty`, so before C1 a second click on × after a
    /// failed save closed the tab with no prompt. All three inherit the fix for free, which is the
    /// whole argument for fixing the state rather than each consumer — pinned here so a regression
    /// in the reducer arm is caught at the level a user actually feels it.
    func testAFailedSaveIsNamedByTheQuitGateFiresTheCloseSheetAndRetainsTheRuntimeAcrossASessionHop() {
        let state = openedSavedCleanThenSaveFailed()
        XCTAssertEqual(officeDirtyFilePaths(runtimeStates: [state]), ["/a.xlsx"],
                       "the quit gate must name a document whose save never reached disk")

        XCTAssertTrue(officeDocumentIsDirty(state: state, path: "/a.xlsx"),
                      "and the dirty-close sheet must fire for it — this predicate is what decides "
                      + "whether the tab even asks before closing")

        let dirtyCount = state.documents.values.filter(\.dirty).count
        XCTAssertFalse(officeRuntimeReleasedOnDeparture(dirtyDocuments: dirtyCount),
                       "a session hop must RETAIN this runtime — releasing it discards the buffer "
                       + "with no prompt at all")
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
                                         .opened(path: "/a.xlsx", docId: "doc-a", stagedPath: "/staged/doc-a", metadata: metadata, pathGeneration: 0)])
        let (state, effects) = reduce(open, [.externalChangeDetected(path: "/a.xlsx")])
        // Task 9: this path's ticket was 0 (never bumped by the open above) and the reload bumps it
        // once, to 1 — see `OfficeRuntimeState.pathGenerations`'s own header.
        XCTAssertEqual(effects, [.reloadDocument(path: "/a.xlsx", oldDocId: "doc-a", pathGeneration: 1)])
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
                                         .opened(path: "/a.xlsx", docId: "doc-a", stagedPath: "/staged/doc-a", metadata: metadata, pathGeneration: 0)])
        let (deleted, _) = reduce(open, [.externalDeleted(path: "/a.xlsx")])
        XCTAssertEqual(deleted.documentBanners["/a.xlsx"], "File was deleted on disk")

        let (changed, _) = reduce(deleted, [.externalChangeDetected(path: "/a.xlsx")])
        XCTAssertNil(changed.documentBanners["/a.xlsx"], "the file proved it exists again — the "
                     + "deleted sentence cannot still be true")
    }

    func testExternalDeletedSetsAPersistentBannerAndLeavesTheDocumentEntryUntouched() {
        let (open, _) = reduce(ready(), [.openRequested(path: "/a.xlsx"),
                                         .opened(path: "/a.xlsx", docId: "doc-a", stagedPath: "/staged/doc-a", metadata: metadata, pathGeneration: 0)])
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

    // MARK: - Office Stage B Task 2b: the conflict matrix — dirty supersedes Stage A's "always silent"

    private func openedAndDirty(path: String = "/a.xlsx", docId: String = "doc-a") -> OfficeRuntimeState {
        let (open, _) = reduce(ready(), [.openRequested(path: path),
                                         .opened(path: path, docId: docId, stagedPath: "/staged/\(docId)", metadata: metadata,
                                                 pathGeneration: 0)])
        let (dirty, _) = reduce(open, [.modifiedStatusChanged(docId: docId, modified: true)])
        return dirty
    }

    /// The brief's own policy, at the reducer level, isolated from `OfficeRuntimeWatcherTests`' own
    /// end-to-end classifier proof of the identical claim: a dirty document's unsaved edits are
    /// never discarded silently — a conflict is raised instead of `.reloadDocument`.
    func testExternalChangeDetectedOnADirtyDocumentRaisesAConflictInsteadOfReloading() {
        let dirty = openedAndDirty()
        let (state, effects) = reduce(dirty, [.externalChangeDetected(path: "/a.xlsx")])
        XCTAssertEqual(state.documentConflicts["/a.xlsx"], .changed)
        XCTAssertEqual(effects, [.emitBanner(reason: officeConflictChangedMessage)])
        XCTAssertNil(state.documentBanners["/a.xlsx"], "the dirty path routes through documentConflicts, "
                     + "never the plain-text banner dict the clean path uses")
        XCTAssertEqual(state.documents["/a.xlsx"], dirty.documents["/a.xlsx"], "no silent reload — the "
                       + "in-memory edits are untouched, exactly as `.reloadDocument` never having "
                       + "been emitted implies")
    }

    /// The deletion half of the same fork: `officeConflictDeletedMessage`, never the plain
    /// "File was deleted on disk" `documentBanners` entry the clean path sets.
    func testExternalDeletedOnADirtyDocumentRaisesAConflictInsteadOfAPersistentBanner() {
        let dirty = openedAndDirty()
        let (state, effects) = reduce(dirty, [.externalDeleted(path: "/a.xlsx")])
        XCTAssertEqual(state.documentConflicts["/a.xlsx"], .deleted)
        XCTAssertEqual(effects, [.emitBanner(reason: officeConflictDeletedMessage)])
        XCTAssertNil(state.documentBanners["/a.xlsx"])
        XCTAssertEqual(state.documents["/a.xlsx"], dirty.documents["/a.xlsx"], "nothing to lose on "
                       + "screen either way — deletion never touches the document entry itself")
    }

    /// **"Reload from disk"**: discards the in-memory edits and re-stages, mirroring the SAME
    /// `.reloadDocument` effect a clean document's silent path already uses — the conflict banner's
    /// own left-hand button is not a new reload mechanism, only a gated door to the existing one.
    func testConflictReloadRequestedClearsTheConflictAndReloads() {
        let (conflicted, _) = reduce(openedAndDirty(), [.externalChangeDetected(path: "/a.xlsx")])
        XCTAssertEqual(conflicted.documentConflicts["/a.xlsx"], .changed, "sanity")

        let (state, effects) = reduce(conflicted, [.conflictReloadRequested(path: "/a.xlsx")])
        XCTAssertNil(state.documentConflicts["/a.xlsx"])
        XCTAssertNil(state.documentBanners["/a.xlsx"])
        // Task 9: the DIRTY branch `.externalChangeDetected` took above never bumped the ticket (only
        // the clean/silent-reload branch does), so it is still 0 here; this explicit reload bumps it
        // to 1 — see `OfficeRuntimeState.pathGenerations`'s own header.
        XCTAssertEqual(effects, [.reloadDocument(path: "/a.xlsx", oldDocId: "doc-a", pathGeneration: 1)])
    }

    /// **"Keep my version"**: dismisses the banner with NO other effect — the document stays exactly
    /// as it is, still dirty, still showing its in-memory edits; the brief's own words, "the next ⌘S
    /// overwrites."
    func testConflictKeepMineRequestedClearsTheConflictWithNoOtherEffect() {
        let (conflicted, _) = reduce(openedAndDirty(), [.externalChangeDetected(path: "/a.xlsx")])
        let (state, effects) = reduce(conflicted, [.conflictKeepMineRequested(path: "/a.xlsx")])
        XCTAssertNil(state.documentConflicts["/a.xlsx"])
        XCTAssertNil(state.documentBanners["/a.xlsx"])
        XCTAssertEqual(effects, [])
        XCTAssertEqual(state.documents["/a.xlsx"], conflicted.documents["/a.xlsx"], "still dirty, "
                       + "still showing the SAME in-memory edits — dismissing the banner changes "
                       + "nothing else")
    }

    func testConflictReloadAndKeepMineRequestedOnAPathThatIsNotOpenAreNoOps() {
        for event in [OfficeRuntimeEvent.conflictReloadRequested(path: "/never.xlsx"),
                      .conflictKeepMineRequested(path: "/never.xlsx")] {
            let (state, effects) = reduce(ready(), [event])
            XCTAssertEqual(state, ready())
            XCTAssertEqual(effects, [])
        }
    }

    /// **"Conflict, then save"**: pressing ⌘S over a standing conflict banner IS the "mine wins"
    /// answer — `.saveSucceeded`'s own arm resolves EITHER conflict kind unconditionally, the same
    /// rule that makes N1's own rare false-positive self-heal (`officeDiskChange`'s own doc has the
    /// full account).
    func testSaveSucceededClearsAnyStandingConflict() {
        let (conflicted, _) = reduce(openedAndDirty(), [.externalChangeDetected(path: "/a.xlsx")])
        XCTAssertEqual(conflicted.documentConflicts["/a.xlsx"], .changed, "sanity")

        let (state, _) = reduce(conflicted, [.saveSucceeded(path: "/a.xlsx", docId: "doc-a")])
        XCTAssertNil(state.documentConflicts["/a.xlsx"])
        XCTAssertEqual(state.documents["/a.xlsx"]?.docId, "doc-a", "sanity: the save's own stale-docId "
                       + "guard passed")
    }

    /// **"Conflict, then close"**: closing a tab with a standing conflict must not leave that
    /// conflict behind for the NEXT document that ever reuses this path's slot — mirrors
    /// `.closeRequested`'s own identical clear for `documentBanners` immediately above it.
    func testClosingADocumentWithAStandingConflictClearsIt() {
        let (conflicted, _) = reduce(openedAndDirty(), [.externalChangeDetected(path: "/a.xlsx")])
        let (state, effects) = reduce(conflicted, [.closeRequested(path: "/a.xlsx")])
        XCTAssertNil(state.documentConflicts["/a.xlsx"])
        XCTAssertEqual(effects, [.helperClose(docId: "doc-a"), .unwatchFile(path: "/a.xlsx"),
                                 .deleteStagedCopy(docId: "doc-a"),
                                 .clearAutosave(path: "/a.xlsx", docId: "doc-a", alsoClearManifestOwner: false)])
    }

    /// T8 interface obligation 1 (activePart survives a reload): `.opened` is the SAME event a fresh
    /// open uses, and this is the row that proves it does double duty correctly — a reload's own
    /// `.opened` lands while the OLD entry (part 2 of 3) is still sitting in `documents[path]`
    /// (`.reloadDocument`'s own doc: never cleared first), and the new entry inherits it.
    func testAReloadsOpenedArmPreservesTheActivePartFromTheEntryItReplaces() {
        let (open, _) = reduce(ready(), [.openRequested(path: "/a.xlsx"),
                                         .opened(path: "/a.xlsx", docId: "doc-a", stagedPath: "/staged/doc-a", metadata: metadata, pathGeneration: 0)])
        let (switched, _) = reduce(open, [
            .subscribeRequested(path: "/a.xlsx", part: 2, zoomPPT: 1000, viewportTwips: viewport)
        ])
        XCTAssertEqual(switched.documents["/a.xlsx"]?.activePart, 2, "sanity")

        // The reload: same path, a freshly-minted docId, the SAME metadata (still 3 parts).
        let (reloaded, _) = reduce(switched, [
            .opened(path: "/a.xlsx", docId: "doc-a-reloaded", stagedPath: "/staged/doc-a-reloaded", metadata: metadata, pathGeneration: 0)
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
                                         .opened(path: "/a.xlsx", docId: "doc-a", stagedPath: "/staged/doc-a", metadata: metadata, pathGeneration: 0)])
        let (switched, _) = reduce(open, [
            .subscribeRequested(path: "/a.xlsx", part: 2, zoomPPT: 1000, viewportTwips: viewport)
        ])
        XCTAssertEqual(switched.documents["/a.xlsx"]?.activePart, 2, "sanity")

        let shrunk = OfficeDocumentMetadata(type: .spreadsheet, parts: 1, sizeTwips: metadata.sizeTwips)
        let (reloaded, _) = reduce(switched, [.opened(path: "/a.xlsx", docId: "doc-a-reloaded", stagedPath: "/staged/doc-a-reloaded", metadata: shrunk, pathGeneration: 0)])
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
                                         .opened(path: "/a.xlsx", docId: "doc-a", stagedPath: "/staged/doc-a", metadata: metadata, pathGeneration: 0)])
        // A second, independent reload's own reopen resolves — same path, a DIFFERENT fresh docId.
        let (state, effects) = reduce(open, [.opened(path: "/a.xlsx", docId: "doc-a-2", stagedPath: "/staged/doc-a-2", metadata: metadata, pathGeneration: 0)])
        XCTAssertEqual(state.documents["/a.xlsx"]?.docId, "doc-a-2", "the later arrival wins the slot")
        XCTAssertEqual(effects, [.watchFile(path: "/a.xlsx"), .helperClose(docId: "doc-a"),
                                 .deleteStagedCopy(docId: "doc-a")],
                       "the docId being REPLACED must be closed — otherwise it leaks on the shared "
                       + "helper forever, with no owner left to ever close it; Task 2b: and ITS staged "
                       + "copy swept, same reasoning")
    }

    /// The ordinary, non-racing case must NOT pay a redundant close: a document opening for the
    /// FIRST time (no `previousEntry` at all) has nothing to compensate.
    func testAFreshOpenedWithNoPriorEntryNeverEmitsACompensatingClose() {
        let (state, effects) = reduce(ready(), [.opened(path: "/a.xlsx", docId: "doc-a", stagedPath: "/staged/doc-a", metadata: metadata, pathGeneration: 0)])
        XCTAssertEqual(state.documents["/a.xlsx"]?.docId, "doc-a")
        XCTAssertEqual(effects, [.watchFile(path: "/a.xlsx")], "nothing to compensate — this path had "
                       + "no document a moment ago")
    }

    func testReloadFailedClearsTheDocumentAndRecordsTheFailureWhenItStillMatchesTheDocIdBeingReplaced() {
        let (open, _) = reduce(ready(), [.openRequested(path: "/a.xlsx"),
                                         .opened(path: "/a.xlsx", docId: "doc-a", stagedPath: "/staged/doc-a", metadata: metadata, pathGeneration: 0)])
        let (state, effects) = reduce(open, [
            .reloadFailed(path: "/a.xlsx", oldDocId: "doc-a", reason: "corrupt file", pathGeneration: 0)
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
                                         .opened(path: "/a.xlsx", docId: "doc-a", stagedPath: "/staged/doc-a", metadata: metadata, pathGeneration: 0)])
        // The file vanished while some in-flight reload (for this same "doc-a") was still pending —
        // the document entry is untouched, so the delete's guard passes and the banner is set.
        let (deleted, _) = reduce(open, [.externalDeleted(path: "/a.xlsx")])
        XCTAssertEqual(deleted.documentBanners["/a.xlsx"], "File was deleted on disk", "sanity")

        let (state, effects) = reduce(deleted, [
            .reloadFailed(path: "/a.xlsx", oldDocId: "doc-a", reason: "corrupt file", pathGeneration: 0)
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
                                         .opened(path: "/a.xlsx", docId: "doc-a", stagedPath: "/staged/doc-a", metadata: metadata, pathGeneration: 0)])
        // The newer reload's reopen (for the SAME original docId, "doc-a") already succeeded.
        let (succeeded, _) = reduce(open, [.opened(path: "/a.xlsx", docId: "doc-a-new", stagedPath: "/staged/doc-a-new", metadata: metadata, pathGeneration: 0)])
        XCTAssertEqual(succeeded.documents["/a.xlsx"]?.docId, "doc-a-new", "sanity")

        // The OLDER reload attempt's own failure — still carrying the ORIGINAL "doc-a" it was
        // trying to replace — lands after the fact. `pathGeneration: 0` matches this test's own
        // hand-constructed sequence (nothing here ever dispatches through `.externalChangeDetected`/
        // `.conflictReloadRequested`, so nothing ever bumps the ticket) — deliberately, so this stays
        // a faithful, non-vacuous test of the PRE-EXISTING `oldDocId` guard in isolation, the one
        // named in this test's own title, rather than being accidentally dropped by Task 9's newer
        // ticket check for an unrelated reason. See `testTwoRacingReloadsTheFirstToFailIsDroppedByThe
        // TicketNotTheOldDocIdGuard` for the scenario where the ticket check is what actually fires.
        let (state, effects) = reduce(succeeded, [
            .reloadFailed(path: "/a.xlsx", oldDocId: "doc-a", reason: "transient error", pathGeneration: 0)
        ])
        XCTAssertEqual(state, succeeded, "a superseded failure has nothing left to say")
        XCTAssertEqual(effects, [])
    }

    func testReloadFailedOutsideReadyIsIgnoredForTheSameReasonOpenFailedIs() {
        let (state, effects) = reduce(OfficeRuntimeState(), [
            .reloadFailed(path: "/a.xlsx", oldDocId: "doc-a", reason: "corrupt file", pathGeneration: 0)
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
                                                   .opened(path: "/a.xlsx", docId: "doc-a", stagedPath: "/staged/doc-a", metadata: metadata, pathGeneration: 0)])
        let (openWithTwoDocs, _) = reduce(openReady, [.openRequested(path: "/a.xlsx"),
                                                       .opened(path: "/a.xlsx", docId: "doc-a", stagedPath: "/staged/doc-a", metadata: metadata, pathGeneration: 0),
                                                       .openRequested(path: "/b.xlsx"),
                                                       .opened(path: "/b.xlsx", docId: "doc-b", stagedPath: "/staged/doc-b", metadata: metadata, pathGeneration: 0)])
        let (alreadyFailed, _) = reduce(idle, [.helperDied])

        let banner = OfficeRuntimeEffect.emitBanner(reason: "The office helper stopped unexpectedly.")
        let cases: [(String, OfficeRuntimeState, [OfficeRuntimeEffect])] = [
            ("idle", idle, [banner]),
            ("starting", starting, [banner]),
            ("ready-empty", openReady, [banner]),
            ("ready-with-doc", openWithDoc, [banner, .unwatchFile(path: "/a.xlsx"),
                                             .deleteStagedCopy(docId: "doc-a")]),
            ("ready-with-two-docs", openWithTwoDocs, [banner, .unwatchFile(path: "/a.xlsx"), .unwatchFile(path: "/b.xlsx"),
                                                       .deleteStagedCopy(docId: "doc-a"), .deleteStagedCopy(docId: "doc-b")]),
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
                                                   .opened(path: "/a.xlsx", docId: "doc-a", stagedPath: "/staged/doc-a", metadata: metadata, pathGeneration: 0)])
        let banner = OfficeRuntimeEffect.emitBanner(reason: "The office helper couldn't be started.")
        let cases: [(OfficeRuntimeState, [OfficeRuntimeEffect])] = [
            (OfficeRuntimeState(), [banner]),
            (reduce(OfficeRuntimeState(), [.openRequested(path: "/a.xlsx")]).0, [banner]),
            (openReady, [banner]),
            (openWithDoc, [banner, .unwatchFile(path: "/a.xlsx"), .deleteStagedCopy(docId: "doc-a")]),
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
            .openRequested(path: "/a.xlsx"), .opened(path: "/a.xlsx", docId: "doc-a", stagedPath: "/staged/doc-a", metadata: metadata, pathGeneration: 0),
            .openRequested(path: "/b.xlsx"), .opened(path: "/b.xlsx", docId: "doc-b", stagedPath: "/staged/doc-b", metadata: metadata, pathGeneration: 0)
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
        // Task 9, fix round 1 (review F2) — NOT a literal fresh `OfficeRuntimeState()`, and no
        // longer a bare carry-forward either: `withDocs` descends from `ready()` (which opens-then-
        // closes "/warm.xlsx", landing its ticket at 1) and then freshly opens "/a.xlsx"/"/b.xlsx"
        // (each captured AND RECORDED at 0 — the capture-is-also-recorded fix, field header's own
        // account). Teardown now BUMPS every existing entry by one rather than carrying it forward
        // unchanged: 1->2 for "/warm.xlsx", 0->1 for each of the other two.
        var expectedDocsState = OfficeRuntimeState()
        expectedDocsState.pathGenerations = ["/warm.xlsx": 2, "/a.xlsx": 1, "/b.xlsx": 1]
        XCTAssertEqual(docsState, expectedDocsState)
        // Task 2b (I3): one `.teardown` (every open docId), PLUS one `.deleteStagedCopy` per docId —
        // teardown releases each document's staged copy exactly as it already releases the helper's
        // own open handle for it.
        XCTAssertEqual(docsEffects.count, 3, "one .teardown effect plus one .deleteStagedCopy per open docId")
        if case .teardown(let docIds)? = docsEffects.first {
            XCTAssertEqual(Set(docIds), Set(["doc-a", "doc-b"]), "both open docIds are handed to the "
                           + "imperative half to close")
        } else {
            XCTFail("expected a .teardown effect, got \(docsEffects)")
        }
        // `staleCopyEffects` sorts by PATH (`/a.xlsx` before `/b.xlsx"`), so the order below is exact,
        // not incidental — `OfficeRuntimeEffect` is only `Equatable`, not `Hashable`, so this compares
        // the tail directly rather than going through a `Set`.
        XCTAssertEqual(Array(docsEffects.dropFirst()),
                       [.deleteStagedCopy(docId: "doc-a"), .deleteStagedCopy(docId: "doc-b")],
                       "both open docIds' staged copies are swept too")

        let (failedState, failedEffects) = reduce(failed, [.teardownRequested])
        XCTAssertEqual(failedState, OfficeRuntimeState())
        XCTAssertEqual(failedEffects, [.teardown(docIds: [])])
    }

    func testASecondTeardownIsSafe() {
        let (once, _) = reduce(ready(), [.teardownRequested])
        let (twice, twiceEffects) = reduce(once, [.teardownRequested])
        // Task 9, fix round 1 (review F2) — `ready()`'s own "/warm.xlsx" close lands its ticket at 1;
        // EACH teardown bumps by one, so two in a row lands at 3 (1 -> 2 -> 3), never held constant
        // the way a bare carry-forward would. Still strictly monotonic either way — a second teardown
        // is still safe, just no longer a no-op on this dict specifically.
        var expected = OfficeRuntimeState()
        expected.pathGenerations["/warm.xlsx"] = 3
        XCTAssertEqual(twice, expected)
        XCTAssertEqual(twiceEffects, [.teardown(docIds: [])])
    }

    // MARK: - Office Stage B Task 7: autosave sidecars + crash recovery

    private let sampleCandidate = OfficeRecoveryCandidate(
        docId: "crashed-doc", sidecarPath: "/state/autosave/crashed-doc.odt",
        capturedAt: Date(timeIntervalSince1970: 1_000_000), isODFFallback: false)

    func testAutosavedResolvesDocIdToPathAndEmitsRecordAutosave() {
        let open = readyWithOpenDocument(path: "/a.xlsx", docId: "doc-a")
        let (state, effects) = reduce(open, [.autosaved(docId: "doc-a", ext: "ods", isODFFallback: true)])
        XCTAssertEqual(state, open, "no state changes here — the manifest write is entirely the "
                       + "imperative half's own job")
        XCTAssertEqual(effects, [.recordAutosave(path: "/a.xlsx", docId: "doc-a", ext: "ods", isODFFallback: true)])
    }

    func testAutosavedForADocIdThisRuntimeDoesNotKnowIsANoOp() {
        let (state, effects) = reduce(ready(), [.autosaved(docId: "ghost-doc", ext: "odt", isODFFallback: false)])
        XCTAssertEqual(state, ready())
        XCTAssertEqual(effects, [])
    }

    func testRecoveryCandidateFoundRecordsTheCandidateUnderThePath() {
        let open = readyWithOpenDocument(path: "/a.odt", docId: "doc-a")
        let (state, effects) = reduce(open, [.recoveryCandidateFound(path: "/a.odt", docId: "doc-a", candidate: sampleCandidate)])
        XCTAssertEqual(state.documentRecoveryCandidates["/a.odt"], sampleCandidate)
        XCTAssertEqual(effects, [])
    }

    /// The stale-open guard: a close or a faster second reload already moved `/a.odt` past the docId
    /// this (slower) async check was running for — mirrors `.saveSucceeded`'s own identical shape.
    func testRecoveryCandidateFoundForADocIdThePathHasMovedPastIsANoOp() {
        let open = readyWithOpenDocument(path: "/a.odt", docId: "doc-a")
        let (reloaded, _) = reduce(open, [.opened(path: "/a.odt", docId: "doc-a-2", stagedPath: "/staged/doc-a-2", metadata: metadata, pathGeneration: 0)])
        let (state, effects) = reduce(reloaded, [.recoveryCandidateFound(path: "/a.odt", docId: "doc-a", candidate: sampleCandidate)])
        XCTAssertNil(state.documentRecoveryCandidates["/a.odt"], "the stale check's own candidate "
                     + "must never attach to a document this path has already moved past")
        XCTAssertEqual(state, reloaded)
        XCTAssertEqual(effects, [])
    }

    /// `.opened` clears any standing candidate UNCONDITIONALLY — a fresh open has nothing to clear
    /// yet (the candidate, if any, is found by a LATER, separate dispatch), and a reload/restore
    /// lands here with a now-stale offer computed against a baseline this new content has replaced.
    func testOpenedClearsAnyStandingRecoveryCandidate() {
        let open = readyWithOpenDocument(path: "/a.odt", docId: "doc-a")
        let (withCandidate, _) = reduce(open, [.recoveryCandidateFound(path: "/a.odt", docId: "doc-a", candidate: sampleCandidate)])
        XCTAssertEqual(withCandidate.documentRecoveryCandidates["/a.odt"], sampleCandidate, "sanity")

        let (reloaded, _) = reduce(withCandidate, [.opened(path: "/a.odt", docId: "doc-a-2", stagedPath: "/staged/doc-a-2", metadata: metadata, pathGeneration: 0)])
        XCTAssertNil(reloaded.documentRecoveryCandidates["/a.odt"])
    }

    /// **Advisor review — the class of bug T3's own review flagged for a different banner**: a
    /// standing "Restore" offer left up over a document the user has since made genuinely dirty
    /// again is one click from clobbering LIVE new edits with the sidecar's older content.
    func testModifiedStatusChangedTrueClearsAStandingRecoveryCandidate() {
        let open = readyWithOpenDocument(path: "/a.odt", docId: "doc-a")
        let (withCandidate, _) = reduce(open, [.recoveryCandidateFound(path: "/a.odt", docId: "doc-a", candidate: sampleCandidate)])

        let (state, _) = reduce(withCandidate, [.modifiedStatusChanged(docId: "doc-a", modified: true)])
        XCTAssertNil(state.documentRecoveryCandidates["/a.odt"])
        XCTAssertEqual(state.documents["/a.odt"]?.dirty, true, "sanity — the ordinary dirty-tracking "
                       + "write still happens")
    }

    /// The `false` direction deliberately does NOT clear a standing candidate — an undo-back-to-
    /// clean does not retroactively invalidate an earlier recovery offer.
    func testModifiedStatusChangedFalseLeavesAStandingRecoveryCandidateInPlace() {
        let open = readyWithOpenDocument(path: "/a.odt", docId: "doc-a")
        let (withCandidate, _) = reduce(open, [.recoveryCandidateFound(path: "/a.odt", docId: "doc-a", candidate: sampleCandidate)])

        let (state, _) = reduce(withCandidate, [.modifiedStatusChanged(docId: "doc-a", modified: false)])
        XCTAssertEqual(state.documentRecoveryCandidates["/a.odt"], sampleCandidate)
    }

    func testRecoveryRestoreRequestedClearsTheCandidateAndEmitsRestoreFromSidecar() {
        let open = readyWithOpenDocument(path: "/a.odt", docId: "doc-a")
        let (withCandidate, _) = reduce(open, [.recoveryCandidateFound(path: "/a.odt", docId: "doc-a", candidate: sampleCandidate)])

        let (state, effects) = reduce(withCandidate, [.recoveryRestoreRequested(path: "/a.odt")])
        XCTAssertNil(state.documentRecoveryCandidates["/a.odt"], "optimistic clear, mirrors "
                     + ".conflictReloadRequested's identical posture")
        // Task 9: restore is reload-shaped and bumps this path's ticket from 0 (never touched by the
        // open/recoveryCandidateFound above) to 1.
        XCTAssertEqual(effects, [.restoreFromSidecar(path: "/a.odt", oldDocId: "doc-a",
                                                      sidecarPath: sampleCandidate.sidecarPath, pathGeneration: 1)])
    }

    func testRecoveryDiscardRequestedClearsTheCandidateAndEmitsDiscardRecoveryCandidate() {
        let open = readyWithOpenDocument(path: "/a.odt", docId: "doc-a")
        let (withCandidate, _) = reduce(open, [.recoveryCandidateFound(path: "/a.odt", docId: "doc-a", candidate: sampleCandidate)])

        let (state, effects) = reduce(withCandidate, [.recoveryDiscardRequested(path: "/a.odt")])
        XCTAssertNil(state.documentRecoveryCandidates["/a.odt"])
        // The candidate's OWN docId (the crashed session's), never the currently-open one — the
        // sidecar to delete is `<candidate.docId>.<ext>`, not `doc-a.<ext>`.
        XCTAssertEqual(effects, [.discardRecoveryCandidate(path: "/a.odt", docId: "crashed-doc")])
        XCTAssertEqual(state.documents["/a.odt"]?.docId, "doc-a", "Discard touches no document state "
                       + "— the tab is already showing the real file's own content, opened normally")
    }

    func testRecoveryRestoreAndDiscardRequestedWithNoStandingCandidateAreNoOps() {
        let open = readyWithOpenDocument(path: "/a.odt", docId: "doc-a")
        for event in [OfficeRuntimeEvent.recoveryRestoreRequested(path: "/a.odt"),
                      .recoveryDiscardRequested(path: "/a.odt")] {
            let (state, effects) = reduce(open, [event])
            XCTAssertEqual(state, open)
            XCTAssertEqual(effects, [])
        }
    }

    func testRecoveryRestoreAndDiscardRequestedForAPathThatIsNotOpenAreNoOps() {
        for event in [OfficeRuntimeEvent.recoveryRestoreRequested(path: "/never.odt"),
                      .recoveryDiscardRequested(path: "/never.odt")] {
            let (state, effects) = reduce(ready(), [event])
            XCTAssertEqual(state, ready())
            XCTAssertEqual(effects, [])
        }
    }

    /// **`DocumentEntry.restoredPendingSave`'s own header** — the ONE deliberate exception to
    /// "dirty mirrors LOK and nothing else." A fresh open from a sidecar was never actually
    /// "modified" from LOK's own point of view, so nothing will ever fire the real
    /// `.uno:ModifiedStatus=true` this dot ordinarily waits for; `.recoveryRestored` forces it.
    func testRecoveryRestoredForcesDirtyTrueAndSetsRestoredPendingSave() {
        let open = readyWithOpenDocument(path: "/a.odt", docId: "doc-a")
        XCTAssertEqual(open.documents["/a.odt"]?.dirty, false, "sanity — a fresh open starts clean")

        let (state, effects) = reduce(open, [.recoveryRestored(path: "/a.odt", docId: "doc-a")])
        XCTAssertEqual(state.documents["/a.odt"]?.dirty, true)
        XCTAssertEqual(state.documents["/a.odt"]?.restoredPendingSave, true)
        XCTAssertEqual(effects, [])
    }

    func testRecoveryRestoredForADocIdThePathHasMovedPastIsANoOp() {
        let open = readyWithOpenDocument(path: "/a.odt", docId: "doc-a")
        let (reloaded, _) = reduce(open, [.opened(path: "/a.odt", docId: "doc-a-2", stagedPath: "/staged/doc-a-2", metadata: metadata, pathGeneration: 0)])

        let (state, _) = reduce(reloaded, [.recoveryRestored(path: "/a.odt", docId: "doc-a")])
        XCTAssertEqual(state.documents["/a.odt"]?.dirty, false, "the stale restore must not force "
                       + "dirty onto whatever ELSE this path now shows")
        XCTAssertEqual(state.documents["/a.odt"]?.restoredPendingSave, false)
    }

    /// **`.saveSucceeded`'s own ONE allowed touch of `dirty` directly** — proven by actually driving
    /// a save through a restored, never-typed-into document: without this, the dot would stay stuck
    /// forever (LOK never transitions a document it always considered clean).
    func testSaveSucceededClearsDirtyAndRestoredPendingSaveWhenSetByARestore() {
        let open = readyWithOpenDocument(path: "/a.odt", docId: "doc-a")
        let (restored, _) = reduce(open, [.recoveryRestored(path: "/a.odt", docId: "doc-a")])
        XCTAssertEqual(restored.documents["/a.odt"]?.dirty, true, "sanity")

        let (state, effects) = reduce(restored, [.saveSucceeded(path: "/a.odt", docId: "doc-a")])
        XCTAssertEqual(state.documents["/a.odt"]?.dirty, false, "a save succeeding for a "
                       + "restore-pending document must clear the dot directly — LOK will never "
                       + "fire the real transition")
        XCTAssertEqual(state.documents["/a.odt"]?.restoredPendingSave, false)
        XCTAssertEqual(effects, [.clearAutosave(path: "/a.odt", docId: "doc-a", alsoClearManifestOwner: true)])
    }

    /// **The regression guard for the ORDINARY save path** — `restoredPendingSave` defaults `false`,
    /// so `.saveSucceeded` must NOT force `dirty=false` for a document that became dirty through a
    /// genuine edit; that dot still waits for LOK's own real `.uno:ModifiedStatus=false`, unchanged
    /// from every task before this one.
    func testSaveSucceededDoesNotForceDirtyFalseForAnOrdinaryEdit() {
        let dirty = openedAndDirty(path: "/a.odt", docId: "doc-a")
        XCTAssertEqual(dirty.documents["/a.odt"]?.restoredPendingSave, false, "sanity — never touched by a plain edit")

        let (state, _) = reduce(dirty, [.saveSucceeded(path: "/a.odt", docId: "doc-a")])
        XCTAssertEqual(state.documents["/a.odt"]?.dirty, true, "unchanged by this save — only a real "
                       + "LOK ModifiedStatus=false callback may clear it, exactly as before Task 7")
    }

    /// **The negative pin (advisor review) — a future site-mirroring sweep that adds `.clearAutosave`
    /// everywhere `.deleteStagedCopy` already is must trip THIS test, not silently delete the crash
    /// evidence recovery depends on.** All three abnormal-ending events, driven against a state that
    /// HAS an open, dirty document (so a positive-but-wrong emission would show up), asserting the
    /// full effects list never contains `.clearAutosave` for any docId.
    func testHelperDiedTeardownAndUnavailableNeverEmitAnAutosaveClear() {
        let dirty = openedAndDirty(path: "/a.xlsx", docId: "doc-a")
        for event in [OfficeRuntimeEvent.helperDied, .helperUnavailable, .teardownRequested] {
            let (_, effects) = reduce(dirty, [event])
            XCTAssertFalse(effects.contains { if case .clearAutosave = $0 { return true } else { return false } },
                           "\(event) must never emit .clearAutosave — this IS the abnormal-ending "
                           + "case autosave exists to survive; only .saveSucceeded/.closeRequested/"
                           + "explicit Discard may clear a sidecar")
        }
    }

    // MARK: - Fix round 1 (review I-2, at the Critical boundary) — closing must never claim the
    // manifest's own docId

    /// **The precise scenario the review names: a plain close of a tab with a STANDING, never-
    /// Restored/never-Discarded recovery candidate.** The document is fresh and clean (nothing typed
    /// in THIS session — `readyWithOpenDocument` never dirties it), so T3's own dirty-close sheet
    /// has nothing to gate on; `.closeRequested` reaches this reducer directly, with the offer still
    /// standing. The reducer-visible half of the fix: `alsoClearManifestOwner` must be `false`
    /// regardless — see `OfficeAutosaveManifestTests
    /// .testClearAutosaveWithAlsoClearManifestOwnerFalseLeavesAStandingCandidatesSidecarAndManifestFindableAfterwards`
    /// for the disk-level half (the file actually surviving, and being findable again on reopen).
    func testCloseRequestedWithAStandingRecoveryCandidateNeverClaimsTheManifestOwner() {
        let open = readyWithOpenDocument(path: "/a.odt", docId: "doc-a")
        let (withCandidate, _) = reduce(open, [.recoveryCandidateFound(path: "/a.odt", docId: "doc-a", candidate: sampleCandidate)])
        XCTAssertEqual(withCandidate.documentRecoveryCandidates["/a.odt"], sampleCandidate, "sanity")

        let (_, effects) = reduce(withCandidate, [.closeRequested(path: "/a.odt")])

        guard case .clearAutosave(let path, let docId, let alsoClearManifestOwner) =
            effects.first(where: { if case .clearAutosave = $0 { return true } else { return false } }) else {
            return XCTFail("expected a .clearAutosave effect")
        }
        XCTAssertEqual(path, "/a.odt")
        XCTAssertEqual(docId, "doc-a")
        XCTAssertFalse(alsoClearManifestOwner, "a plain close must never reach past its own literal "
                       + "docId into whatever a STANDING, untouched recovery candidate's manifest "
                       + "names — doing so would silently discard the one thing recovery exists to "
                       + "preserve, with no prompt (the current session is clean, so T3's dirty-close "
                       + "sheet never fires) and no way to see the banner again to undo it")
    }

    // MARK: - Office Stage B Task 9: per-path generation counter — in-flight-open cancellation
    //
    // The resurrection race, verbatim from the Stage A T8 wave note this task closes: "close-during-
    // reload can resurrect a closed document — a `.opened` landing for a superseded open re-creates
    // the entry and re-arms the watcher." Every row below is one named interleaving, driven with
    // nothing but the reducer — no helper process, no async scheduling, no timing to get lucky on.

    func testACloseRacingAnInFlightOpenDropsTheLateOpenedWithACompensatingClose() {
        // Open A never lands before the close: dispatch `.openRequested` (captures ticket 0 for
        // "/a.xlsx", a path `ready()` never touches) then `.closeRequested` for the SAME path —
        // T8's own resurrection shape, narrowed to its simplest form. Nothing was ever recorded in
        // `documents`, so `.closeRequested`'s own guard has nothing to actually close — but it still
        // bumps the ticket, which is this task's whole point.
        let (racedClose, _) = reduce(ready(), [.openRequested(path: "/a.xlsx"), .closeRequested(path: "/a.xlsx")])
        XCTAssertEqual(racedClose.pathGenerations["/a.xlsx"], 1, "sanity — the close bumped it")

        // The STALE open's own `.opened` now lands, carrying the ticket it captured BEFORE the
        // close (0 — `.openRequested`'s own `.ready` arm reads the current value, never bumps it).
        let (state, effects) = reduce(racedClose, [
            .opened(path: "/a.xlsx", docId: "doc-a", stagedPath: "/staged/doc-a", metadata: metadata, pathGeneration: 0)
        ])
        XCTAssertNil(state.documents["/a.xlsx"], "the resurrection this task exists to prevent — a "
                     + "closed path must stay closed")
        XCTAssertEqual(state, racedClose, "mutation-free drop: nothing else in state moved")
        XCTAssertEqual(effects, [.helperClose(docId: "doc-a"), .deleteStagedCopy(docId: "doc-a")],
                       "the helper-side document this attempt actually opened is compensated, not "
                       + "leaked — and NO `.watchFile`: a dropped attempt never reaches the "
                       + "watch-arming branch, so there is nothing standing to re-arm")
    }

    func testTwoRapidOpenCloseOpenCyclesTheSecondOpensOpenedIsNotDropped() {
        // First open (ticket 0) never lands. Close (bumps to 1). Second open (reads current, 1).
        let (afterSecondOpenRequested, _) = reduce(ready(), [
            .openRequested(path: "/a.xlsx"), .closeRequested(path: "/a.xlsx"), .openRequested(path: "/a.xlsx")
        ])
        XCTAssertEqual(afterSecondOpenRequested.pathGenerations["/a.xlsx"], 1, "still 1 — a fresh open "
                       + "reads the ticket, it never bumps it")

        // The FIRST (now-stale) attempt's `.opened` lands first, carrying the ticket it captured, 0.
        let (afterStaleLands, staleEffects) = reduce(afterSecondOpenRequested, [
            .opened(path: "/a.xlsx", docId: "doc-a-first", stagedPath: "/staged/doc-a-first", metadata: metadata, pathGeneration: 0)
        ])
        XCTAssertNil(afterStaleLands.documents["/a.xlsx"], "the first attempt's own opened is stale and dropped")
        XCTAssertEqual(staleEffects, [.helperClose(docId: "doc-a-first"), .deleteStagedCopy(docId: "doc-a-first")])

        // The SECOND attempt's own `.opened` lands next, carrying ITS OWN captured ticket, 1 —
        // matches the CURRENT generation, so it is NOT dropped: the discriminating case the brief's
        // own "two rapid open/close/open cycles" interleaving names by name.
        let (state, effects) = reduce(afterStaleLands, [
            .opened(path: "/a.xlsx", docId: "doc-a-second", stagedPath: "/staged/doc-a-second", metadata: metadata, pathGeneration: 1)
        ])
        XCTAssertEqual(state.documents["/a.xlsx"]?.docId, "doc-a-second", "the second, legitimate open "
                       + "lands normally")
        XCTAssertEqual(effects, [.watchFile(path: "/a.xlsx")], "an ordinary fresh-open effect list — "
                       + "no compensating close: nothing else was ever recorded for this path to replace")
    }

    /// **The reordered arrival — the shape that actually resurrects a document without this task's
    /// fix.** Identical setup to the test above, but the FRESH attempt's `.opened` lands FIRST and
    /// the STALE one arrives LATE — proving the fix holds regardless of wire/scheduling order, not
    /// only in the "stale always arrives first" case every OTHER row in this file happens to use.
    func testAStaleOpenedArrivingAfterTheFreshOneNeverOverwritesIt() {
        let (afterSecondOpenRequested, _) = reduce(ready(), [
            .openRequested(path: "/a.xlsx"), .closeRequested(path: "/a.xlsx"), .openRequested(path: "/a.xlsx")
        ])
        let (afterFreshLands, freshEffects) = reduce(afterSecondOpenRequested, [
            .opened(path: "/a.xlsx", docId: "doc-a-second", stagedPath: "/staged/doc-a-second", metadata: metadata, pathGeneration: 1)
        ])
        XCTAssertEqual(afterFreshLands.documents["/a.xlsx"]?.docId, "doc-a-second")
        XCTAssertEqual(freshEffects, [.watchFile(path: "/a.xlsx")])

        // The FIRST (stale) attempt's own `.opened` lands LATE, after the fresh one already won the
        // slot. Without this task's fix, this would silently OVERWRITE `doc-a-second` with the
        // stale `doc-a-first` — the exact resurrection shape T8's own wave note named, and the one
        // an unguarded `phase == .ready` check cannot tell apart from a legitimate write.
        let (state, effects) = reduce(afterFreshLands, [
            .opened(path: "/a.xlsx", docId: "doc-a-first", stagedPath: "/staged/doc-a-first", metadata: metadata, pathGeneration: 0)
        ])
        XCTAssertEqual(state.documents["/a.xlsx"]?.docId, "doc-a-second", "the fresh entry survives untouched")
        XCTAssertEqual(effects, [.helperClose(docId: "doc-a-first"), .deleteStagedCopy(docId: "doc-a-first")],
                       "the late-arriving stale attempt is compensated, not allowed to clobber")
    }

    // MARK: - T2 broker-review F2 (2026-08-22): opensInFlight, the per-path in-flight-open marker
    //
    // Reproduces, reducer-level and fully deterministic (no helper, no timing, no polling), the
    // double-open race `OfficeAgentBroker`'s own review found: two independent `.openRequested`s for
    // the SAME never-before-open path (a tab's own open racing the agent broker's) used to both
    // dispatch their own `.helperOpen` — see `OfficeRuntimeState.opensInFlight`'s own header for the
    // corruption that produces, and why it is `OfficeAgentBroker`-specific (a caller that snapshots a
    // docId once, unlike a tab that re-reads `$state` reactively). Confirmed RED against the
    // pre-fix reducer (both events dispatched their own `.helperOpen`, the second `secondEffects`
    // assertion below failed) before the fix landed — see task-2-report.md's fix-round section.

    func testTwoConcurrentOpenRequestsForTheSameNeverBeforeOpenPathDispatchOnlyOneHelperOpen() {
        let (afterFirst, firstEffects) = reduce(ready(), [.openRequested(path: "/concurrent.xlsx")])
        XCTAssertEqual(firstEffects, [.helperOpen(path: "/concurrent.xlsx", pathGeneration: 0)], "sanity")
        XCTAssertTrue(afterFirst.opensInFlight.contains("/concurrent.xlsx"), "sanity — marked in flight")

        let (afterSecond, secondEffects) = reduce(afterFirst, [.openRequested(path: "/concurrent.xlsx")])
        XCTAssertEqual(secondEffects, [], "a SECOND concurrent open for a path already being opened "
                       + "must not dispatch its own .helperOpen — exactly two independent opens racing "
                       + "is what produced the corruption (two docIds minted, the loser's docId "
                       + "compensating-closed out from under whichever caller is still holding it)")
        XCTAssertEqual(afterSecond, afterFirst, "mutation-free: the second, suppressed request changes "
                       + "nothing — not even the ticket, which the first request already captured")
    }

    /// **Fix-round F2, insertion site 2**: the SAME marker must be set for paths flushed out of
    /// `pendingOpens`, not only for an immediate `.ready`-phase open — otherwise the race survives
    /// through the boot path (the daemon's very first office call is exactly this queued-then-flushed
    /// shape: nothing was open yet, so a queued open racing a tab's own queued open for the identical
    /// path would still double-dispatch on flush without this).
    func testHelperBecameReadyFlushAlsoMarksEachFlushedPathInFlight() {
        let (starting, _) = reduce(OfficeRuntimeState(), [.openRequested(path: "/a.xlsx")])
        let (flushed, effects) = reduce(starting, [.helperBecameReady])
        XCTAssertEqual(effects, [.helperOpen(path: "/a.xlsx", pathGeneration: 0)], "sanity")
        XCTAssertTrue(flushed.opensInFlight.contains("/a.xlsx"), "a path flushed out of pendingOpens "
                      + "must be marked in-flight exactly like an immediate .ready-phase open")

        let (_, secondEffects) = reduce(flushed, [.openRequested(path: "/a.xlsx")])
        XCTAssertEqual(secondEffects, [], "the flushed open is still in flight — a concurrent second "
                       + "must join it, not double-dispatch")
    }

    /// **The discriminating test for "clear the marker only in `.closeRequested` and a NON-STALE
    /// landing, never in a stale-drop."** open₁ (ticket 0) → close (bumps to 1, clears the marker) →
    /// open₂ (ticket 1, sets the marker again) → open₁'s now-stale `.opened` lands. A design that
    /// ALSO cleared the marker on that stale drop would wrongly empty it WHILE open₂ is still
    /// genuinely in flight — reopening the exact guard this field exists to hold shut, one
    /// interleaving deeper. Every step's own effects are asserted, not just the final state, so a
    /// broken `.closeRequested` (fails to clear) and a broken stale-drop (wrongly clears) each fail a
    /// DIFFERENT assertion below rather than being indistinguishable from one another.
    func testAStaleOpenedLandingWhileAReplacementIsStillInFlightMustNotReopenTheGuard() {
        let (afterFirstOpen, _) = reduce(ready(), [.openRequested(path: "/a.xlsx")])
        let (afterClose, _) = reduce(afterFirstOpen, [.closeRequested(path: "/a.xlsx")])
        XCTAssertFalse(afterClose.opensInFlight.contains("/a.xlsx"), "sanity — close clears the marker "
                       + "even though open₁ (ticket 0) is still out there, unresolved")

        let (afterSecondOpen, secondOpenEffects) = reduce(afterClose, [.openRequested(path: "/a.xlsx")])
        XCTAssertEqual(secondOpenEffects, [.helperOpen(path: "/a.xlsx", pathGeneration: 1)],
                       "sanity — the close cleared the marker, so this fresh request must dispatch")
        XCTAssertTrue(afterSecondOpen.opensInFlight.contains("/a.xlsx"), "sanity — open₂ now in flight")

        // open₁'s stale `.opened` (ticket 0) lands late — dropped via the existing pathGeneration guard.
        let (afterStaleLands, staleEffects) = reduce(afterSecondOpen, [
            .opened(path: "/a.xlsx", docId: "doc-a-first", stagedPath: "/staged/doc-a-first",
                   metadata: metadata, pathGeneration: 0)
        ])
        XCTAssertEqual(staleEffects, [.helperClose(docId: "doc-a-first"), .deleteStagedCopy(docId: "doc-a-first")], "sanity")
        XCTAssertTrue(afterStaleLands.opensInFlight.contains("/a.xlsx"), "the stale drop must NOT clear "
                      + "the marker — open₂ (ticket 1) is still genuinely in flight")

        // The discriminating assertion: a THIRD open request, while open₂ is still outstanding, must
        // still be suppressed — proving the marker survived the stale landing intact.
        let (_, thirdEffects) = reduce(afterStaleLands, [.openRequested(path: "/a.xlsx")])
        XCTAssertEqual(thirdEffects, [], "open₂ is still in flight — a third request must still be "
                       + "joined, not double-dispatched")

        // Finally open₂'s own legitimate `.opened` (ticket 1) lands and the marker clears normally.
        let (final, finalEffects) = reduce(afterStaleLands, [
            .opened(path: "/a.xlsx", docId: "doc-a-second", stagedPath: "/staged/doc-a-second",
                   metadata: metadata, pathGeneration: 1)
        ])
        XCTAssertEqual(finalEffects, [.watchFile(path: "/a.xlsx")], "sanity")
        XCTAssertFalse(final.opensInFlight.contains("/a.xlsx"), "cleared once the CURRENT attempt resolves")
    }

    func testAnAcceptedOpenFailedClearsTheInFlightMarkerSoTheSamePathCanBeRetried() {
        let (afterOpen, _) = reduce(ready(), [.openRequested(path: "/fails.xlsx")])
        XCTAssertTrue(afterOpen.opensInFlight.contains("/fails.xlsx"), "sanity")

        let (state, _) = reduce(afterOpen, [
            .openFailed(path: "/fails.xlsx", reason: "disk full", pathGeneration: 0)
        ])
        XCTAssertFalse(state.opensInFlight.contains("/fails.xlsx"), "a failed open must not wedge the "
                       + "path shut forever")

        let (_, retryEffects) = reduce(state, [.openRequested(path: "/fails.xlsx")])
        XCTAssertEqual(retryEffects, [.helperOpen(path: "/fails.xlsx", pathGeneration: 0)],
                       "a retry after a failure must be free to dispatch, not silently swallowed")
    }

    /// **"open → reload → old .opened lands"** — the brief's own named interleaving: two external
    /// changes close enough together that BOTH mint their own reload before either's own reopen
    /// lands. `.externalChangeDetected` reads `doc.docId` from `documents[path]`, which NEITHER
    /// reload's own (still in-flight) `.opened` has touched yet, so both read the SAME `oldDocId`
    /// AND both bump the ticket once each.
    func testASecondReloadForTheSamePathDropsTheFirstsLateOpenedWithACompensatingClose() {
        let open = readyWithOpenDocument(path: "/a.xlsx", docId: "doc-a")
        let (afterFirstReload, firstEffects) = reduce(open, [.externalChangeDetected(path: "/a.xlsx")])
        guard case .reloadDocument(_, _, let firstTicket)? = firstEffects.first else {
            return XCTFail("expected a .reloadDocument effect, got \(firstEffects)")
        }
        XCTAssertEqual(firstTicket, 1)
        let (afterSecondReload, secondEffects) = reduce(afterFirstReload, [.externalChangeDetected(path: "/a.xlsx")])
        guard case .reloadDocument(_, _, let secondTicket)? = secondEffects.first else {
            return XCTFail("expected a .reloadDocument effect, got \(secondEffects)")
        }
        XCTAssertEqual(secondTicket, 2)

        // The FIRST reload's own `.opened` lands — stale, dropped, compensated.
        // `documents["/a.xlsx"]` is UNTOUCHED (still the ORIGINAL "doc-a" — neither racing reload
        // has landed yet, exactly like the ordinary open case one test up).
        let (state, effects) = reduce(afterSecondReload, [
            .opened(path: "/a.xlsx", docId: "doc-a-reload-1", stagedPath: "/staged/doc-a-reload-1", metadata: metadata,
                    pathGeneration: firstTicket)
        ])
        XCTAssertEqual(state.documents["/a.xlsx"]?.docId, "doc-a", "the original document is untouched "
                       + "— neither racing reload has landed yet")
        XCTAssertEqual(effects, [.helperClose(docId: "doc-a-reload-1"), .deleteStagedCopy(docId: "doc-a-reload-1")])
    }

    func testAStaleOpenFailedNeverOverwritesAFresherSuccess() {
        let (afterSecondOpenRequested, _) = reduce(ready(), [
            .openRequested(path: "/a.xlsx"), .closeRequested(path: "/a.xlsx"), .openRequested(path: "/a.xlsx")
        ])
        let (afterFreshLands, _) = reduce(afterSecondOpenRequested, [
            .opened(path: "/a.xlsx", docId: "doc-a-second", stagedPath: "/staged/doc-a-second", metadata: metadata, pathGeneration: 1)
        ])
        // The FIRST (stale) attempt failed instead of succeeding, and its failure lands LATE —
        // after the second attempt already opened the document successfully.
        let (state, effects) = reduce(afterFreshLands, [
            .openFailed(path: "/a.xlsx", reason: "corrupt file", pathGeneration: 0)
        ])
        XCTAssertEqual(state, afterFreshLands, "a stale failure has nothing left to say — the fresh "
                       + "success stands untouched, never clobbered by a phantom failure banner")
        XCTAssertEqual(effects, [])
    }

    /// **Why `.reloadFailed` needs BOTH guards, proven rather than merely asserted in a comment**:
    /// two racing reloads share the SAME `oldDocId` (neither's reopen has landed, so
    /// `documents[path]` never moved) — the PRE-EXISTING guard alone cannot distinguish them, and
    /// would destroy the still-standing entry the second, still-in-flight reload is about to
    /// legitimately replace. The per-path ticket is the ONLY thing that tells them apart here.
    func testTwoRacingReloadsTheFirstToFailIsDroppedByTheTicketNotTheOldDocIdGuard() {
        let open = readyWithOpenDocument(path: "/a.xlsx", docId: "doc-a")
        let (afterFirstReload, _) = reduce(open, [.externalChangeDetected(path: "/a.xlsx")]) // ticket -> 1
        let (afterSecondReload, _) = reduce(afterFirstReload, [.externalChangeDetected(path: "/a.xlsx")]) // ticket -> 2
        XCTAssertEqual(afterSecondReload.documents["/a.xlsx"]?.docId, "doc-a", "sanity — neither "
                       + "reopen has landed, so the entry is still the pre-reload original")

        // The FIRST reload's own failure lands, still carrying oldDocId "doc-a" (MATCHES the
        // pre-existing guard!) but its OWN stale ticket, 1 — current is now 2, the second reload's
        // own initiation having moved it.
        let (state, effects) = reduce(afterSecondReload, [
            .reloadFailed(path: "/a.xlsx", oldDocId: "doc-a", reason: "transient error", pathGeneration: 1)
        ])
        XCTAssertEqual(state, afterSecondReload, "the entry survives untouched — the OLD oldDocId "
                       + "guard alone would have destroyed it here (it still matches), which is "
                       + "exactly why the ticket check is a SECOND, independent guard, not a "
                       + "replacement for it")
        XCTAssertEqual(effects, [], "no failure banner, no unwatch — the second reload is still "
                       + "legitimately in flight and must be left alone")
    }

    func testClosingOnePathNeverBumpsAnothersTicket() {
        let (state, _) = reduce(ready(), [.closeRequested(path: "/a.xlsx")])
        XCTAssertEqual(state.pathGenerations["/a.xlsx"], 1)
        XCTAssertNil(state.pathGenerations["/b.xlsx"], "an unrelated path's ticket is untouched — "
                     + "this dict is keyed by PATH, never a single runtime-wide counter (docIds are "
                     + "always fresh UUIDs, so a per-docId key could never even collide in the first "
                     + "place — the race this task closes is about WHICH ATTEMPT for a given PATH is "
                     + "still authoritative)")
    }

    func testHelperBecameReadyFlushUsesEachQueuedPathsOwnCurrentTicketNotAStaleOneFromQueueTime() {
        // "/a.xlsx" queues, is closed (bumping its ticket to 1) while still `.starting`, then
        // re-queues — legal: `.closeRequested`'s own `pendingOpens.removeAll` lets a fresh
        // `.openRequested` re-append it (that arm's own `if !next.pendingOpens.contains(path)` guard).
        let (starting, _) = reduce(OfficeRuntimeState(), [
            .openRequested(path: "/a.xlsx"), .closeRequested(path: "/a.xlsx"), .openRequested(path: "/a.xlsx")
        ])
        XCTAssertEqual(starting.pendingOpens, ["/a.xlsx"], "sanity — re-queued after the close")
        XCTAssertEqual(starting.pathGenerations["/a.xlsx"], 1)

        let (_, effects) = reduce(starting, [.helperBecameReady])
        XCTAssertEqual(effects, [.helperOpen(path: "/a.xlsx", pathGeneration: 1)], "the flush reads "
                       + "each path's CURRENT ticket (1, post-close) — a hand-copied 0 from queue "
                       + "time would let the eventual `.opened` be misjudged as stale against itself")
    }

    /// Fix round 1 (review F2) — this test's own former title ("...CarriesPathGenerationsForward
    /// RatherThanResettingThem") pinned the INVERTED, buggy rationale: bare carry-forward-unchanged,
    /// which the review proved collides ALWAYS with a post-recovery retry's own capture (both read
    /// the identical surviving value). The fix is neither carry-forward nor a bare reset — every
    /// existing entry is BUMPED by one, so any ticket captured before this boundary is now provably
    /// stale against anything captured after it. See `OfficeRuntimeState.pathGenerations`'s own
    /// header for the full account, and the row immediately below for the actual race this closes.
    func testHelperDiedBumpsEveryPathGenerationRatherThanResettingOrCarryingForwardUnchanged() {
        let (afterClose, _) = reduce(ready(), [.closeRequested(path: "/a.xlsx")])
        XCTAssertEqual(afterClose.pathGenerations["/a.xlsx"], 1)
        let (state, _) = reduce(afterClose, [.helperDied])
        XCTAssertEqual(state.pathGenerations["/a.xlsx"], 2, "bumped by one — carried forward "
                       + "unchanged would read 1 (the review's own always-collides case), a bare "
                       + "reset would read 0 (collides only when the pre-death ticket happened to be "
                       + "0); bumping is the one operation neither alternative performs and the one "
                       + "that actually closes the window")
        XCTAssertEqual(state.phase, .failed)
    }

    /// **The review's own concrete counter-example, red-proven.** Path at ticket 0 (a fresh,
    /// never-before-touched path — the case the F2 fix's "capture is also recorded" half exists for,
    /// since a path that had never been closed/reloaded would otherwise have NO entry for the death
    /// bump below to reach). An open captures ticket 0 and is still in flight when `.helperDied`
    /// fires. The runtime recovers (a second `.openRequested` flushed through `.helperBecameReady`,
    /// exactly like a real relaunch-on-next-demand retry) and reaches `.ready` again BEFORE the
    /// pre-death attempt's own stale `.opened(0)` finally lands — the review's own point that the
    /// phase guard alone does NOT block this landing, phase really is back to `.ready` by then. Only
    /// the ticket can tell the two apart, and only because death bumped it.
    func testAStaleOpenSurvivingAHelperDeathIsDroppedOnceTheRuntimeRecoversNotResurrected() {
        let (afterFirstOpen, firstEffects) = reduce(ready(), [.openRequested(path: "/z.xlsx")])
        XCTAssertEqual(firstEffects, [.helperOpen(path: "/z.xlsx", pathGeneration: 0)], "sanity — a "
                       + "never-touched path captures ticket 0")
        XCTAssertEqual(afterFirstOpen.pathGenerations["/z.xlsx"], 0, "sanity — and the capture is "
                       + "RECORDED, not just read (fix round 1's other half) — nothing to bump below "
                       + "otherwise")

        // The helper dies with that open still outstanding.
        let (afterDeath, _) = reduce(afterFirstOpen, [.helperDied])
        XCTAssertEqual(afterDeath.pathGenerations["/z.xlsx"], 1, "sanity — bumped past the in-flight "
                       + "attempt's own captured 0")
        XCTAssertEqual(afterDeath.phase, .failed)

        // The runtime recovers: a fresh ask, restarted helper, flushed queue — an ordinary retry,
        // reaching `.ready` again with its OWN new ticket (1, the post-death current value).
        let (afterRetryRequested, _) = reduce(afterDeath, [.openRequested(path: "/z.xlsx")])
        let (afterRetryReady, retryEffects) = reduce(afterRetryRequested, [.helperBecameReady])
        XCTAssertEqual(retryEffects, [.helperOpen(path: "/z.xlsx", pathGeneration: 1)], "the retry "
                       + "reads the POST-death current ticket, strictly newer than what the zombie "
                       + "attempt captured")
        XCTAssertEqual(afterRetryReady.phase, .ready, "the review's own point: phase is back to "
                       + ".ready well before the pre-death reply below ever lands — the phase guard "
                       + "alone cannot be what protects this")

        // THE ZOMBIE: the pre-death attempt's own reply finally arrives, carrying the ticket it
        // captured before any of this happened — 0.
        let (afterZombieLands, zombieEffects) = reduce(afterRetryReady, [
            .opened(path: "/z.xlsx", docId: "zombie-doc", stagedPath: "/staged/zombie-doc", metadata: metadata, pathGeneration: 0)
        ])
        XCTAssertNil(afterZombieLands.documents["/z.xlsx"], "the zombie must not install itself — "
                     + "this is the exact resurrection the review's counter-example predicted the "
                     + "OLD carry-forward-unchanged rationale would allow (0 == 0 under carry-"
                     + "forward; here, 0 != 1)")
        XCTAssertEqual(afterZombieLands, afterRetryReady, "mutation-free drop — nothing else in state moved")
        XCTAssertEqual(zombieEffects, [.helperClose(docId: "zombie-doc"), .deleteStagedCopy(docId: "zombie-doc")],
                       "the zombie's own helper-side handle is compensated, not leaked")

        // The retry's OWN reply lands next, carrying ITS ticket, 1 — accepted normally.
        let (finalState, finalEffects) = reduce(afterZombieLands, [
            .opened(path: "/z.xlsx", docId: "retry-doc", stagedPath: "/staged/retry-doc", metadata: metadata, pathGeneration: 1)
        ])
        XCTAssertEqual(finalState.documents["/z.xlsx"]?.docId, "retry-doc", "the LEGITIMATE retry "
                       + "installs normally — the fix rejects only the zombie, not recovery itself")
        XCTAssertEqual(finalEffects, [.watchFile(path: "/z.xlsx")])
    }

    /// **The T7 closure this task's own dispatch note names**: "a stale open must NOT have consumed
    /// the recovery candidate... the fresh open must still find it." Proven directly: a dropped
    /// (stale-generation) open's own best-effort `checkRecoveryCandidate` follow-up still RUNS
    /// (`openAndDispatch` never gates that call on the generation — it is read-only and races
    /// nothing, see that function's own header) and still DISPATCHES `.recoveryCandidateFound`
    /// carrying the stale docId — this test shows that landing is rejected by the PRE-EXISTING
    /// docId-match guard `.recoveryCandidateFound` already carried before this task, needing no new
    /// guard of its own: nothing was ever "consumed" by the check in the first place, since
    /// `checkRecoveryCandidate` only ever reads.
    func testAStaleGenerationOpensRecoveryCandidateFoundNeverStealsTheOfferFromTheFreshOpen() {
        let (afterSecondOpenRequested, _) = reduce(ready(), [
            .openRequested(path: "/a.odt"), .closeRequested(path: "/a.odt"), .openRequested(path: "/a.odt")
        ])
        let (afterStaleDropped, _) = reduce(afterSecondOpenRequested, [
            .opened(path: "/a.odt", docId: "doc-a-first", stagedPath: "/staged/doc-a-first", metadata: metadata, pathGeneration: 0)
        ])
        let (afterFreshOpened, _) = reduce(afterStaleDropped, [
            .opened(path: "/a.odt", docId: "doc-a-second", stagedPath: "/staged/doc-a-second", metadata: metadata, pathGeneration: 1)
        ])

        // The fresh attempt's own recovery check found a candidate — the offer this test protects.
        let freshCandidate = OfficeRecoveryCandidate(docId: "crashed-fresh", sidecarPath: "/state/autosave/crashed-fresh.odt",
                                                     capturedAt: Date(timeIntervalSince1970: 2_000_000), isODFFallback: false)
        let (withOffer, _) = reduce(afterFreshOpened, [
            .recoveryCandidateFound(path: "/a.odt", docId: "doc-a-second", candidate: freshCandidate)
        ])
        XCTAssertEqual(withOffer.documentRecoveryCandidates["/a.odt"], freshCandidate, "sanity")

        // The STALE (dropped) attempt's OWN disk check lands too, carrying the stale docId.
        let staleCandidate = OfficeRecoveryCandidate(docId: "crashed-stale", sidecarPath: "/state/autosave/crashed-stale.odt",
                                                     capturedAt: Date(timeIntervalSince1970: 1_000_000), isODFFallback: false)
        let (state, effects) = reduce(withOffer, [
            .recoveryCandidateFound(path: "/a.odt", docId: "doc-a-first", candidate: staleCandidate)
        ])
        XCTAssertEqual(state.documentRecoveryCandidates["/a.odt"], freshCandidate, "the fresh offer "
                       + "stands, untouched by the stale attempt's own late-arriving check")
        XCTAssertEqual(effects, [])
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
        save: @escaping (String, Int) async throws -> String = { _, _ in "/tmp/office-watcher-unused-save" })
        -> OfficeRuntime.Driver {
        // Office Stage B Task 2b: every test in this class opens a REAL `scratchFile()` (the
        // watcher itself needs a real path to watch), so staging now genuinely runs for each of
        // them — a fresh scratch state dir per driver, never pre-created (`stageDocument`'s own
        // `createDirectory(withIntermediateDirectories: true)` brings it into existence), tracked
        // through the SAME `scratchDirs` teardown loop `scratchFile()` already uses.
        let stateDir = URL(fileURLWithPath: "/tmp/office-watcher-state-\(UUID().uuidString.prefix(8))",
                            isDirectory: true)
        scratchDirs.append(stateDir)
        return OfficeRuntime.Driver(
            helperState: { .ready }, startHelper: { },
            open: { _, _ in metadata },
            close: { _ in },
            save: save,
            subscribeTiles: { _, _, _, _ in [] },
            unsubscribeTiles: { _ in },
            requestTiles: { _, _ in },
            postKey: { _, _, _, _, _ in }, postMouse: { _, _, _, _, _, _, _, _ in },
            postExtTextInput: { _, _, _, _ in },
            clipboardCopy: { _, _ in nil },
            clipboardCut: { _, _ in nil },
            clipboardPaste: { _, _, _ in },
            undo: { _, _ in },
            redo: { _, _ in },
            // office-live-edit R3 — `nil` = "this stub cannot answer", which every caller reads as
            // "fall back to ONE action", i.e. exactly the pre-R3 granularity these tests were written
            // against. Never 0: a zero would mean "undo nothing".
            undoDepth: { _ in nil },
            sheetsInfo: { _ in throw OfficeHelperClientError.serverError(reason: "fake driver: sheets not implemented") },
            sheetsRead: { _, _, _, _ in throw OfficeHelperClientError.serverError(reason: "fake driver: sheets not implemented") },
            sheetsSet: { _, _, _, _, _ in throw OfficeHelperClientError.serverError(reason: "fake driver: sheets not implemented") },
            sheetsResize: { _, _, _, _, _ in throw OfficeHelperClientError.serverError(reason: "fake driver: sheets not implemented") },
            sheetsManageSheet: { _, _, _, _ in throw OfficeHelperClientError.serverError(reason: "fake driver: sheets not implemented") },
            sheetsFormat: { _, _, _, _, _, _, _, _, _ in throw OfficeHelperClientError.serverError(reason: "fake driver: sheets not implemented") },
            slidesInfo: { _ in throw OfficeHelperClientError.serverError(reason: "fake driver: slides not implemented") },
            slidesRead: { _, _ in throw OfficeHelperClientError.serverError(reason: "fake driver: slides not implemented") },
            slidesSetText: { _, _, _, _ in throw OfficeHelperClientError.serverError(reason: "fake driver: slides not implemented") },
            slidesManagePage: { _, _, _, _, _, _ in throw OfficeHelperClientError.serverError(reason: "fake driver: slides not implemented") },
            docsInfo: { _ in throw OfficeHelperClientError.serverError(reason: "fake driver: docs not implemented") },
            docsRead: { _ in throw OfficeHelperClientError.serverError(reason: "fake driver: docs not implemented") },
            docsReplace: { _, _, _ in throw OfficeHelperClientError.serverError(reason: "fake driver: docs not implemented") },
            docsInsert: { _, _, _, _ in throw OfficeHelperClientError.serverError(reason: "fake driver: docs not implemented") },
            stateDirectory: stateDir)
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
    /// never `.ours` — the bag's own job is the narrower race the two
    /// `testExternalWriteBetweenNoteExpectedWriteAndTheOwningSavesWithdraw...` tests below exercise
    /// directly. Both are "suppressed," just via different arms of `officeDiskChange`.
    func testASavesOwnWatcherFireIsSuppressedAndDoesNotReload() async throws {
        let path = try scratchFile(contents: "one")
        let tempDir = URL(fileURLWithPath: "/tmp/office-watcher-save-temp-\(UUID().uuidString.prefix(8))", isDirectory: true)
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        scratchDirs.append(tempDir)
        let tempPath = tempDir.appendingPathComponent("rendered.xlsx").path
        try "the helper's own rendered content".write(toFile: tempPath, atomically: true, encoding: .utf8)

        let watchers = OfficeWatcherRecorder()
        let runtime = OfficeRuntime(sessionId: "S1", driver: makeDriver(save: { _, _ in tempPath }),
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

    /// **The genuine race, provoked directly** (bypassing `performSave`'s own async round trip,
    /// which — per the test above — usually wins the race against a fire): note a write is about to
    /// happen, put NEW bytes on disk exactly as a landed rename would, then fire the watcher's
    /// callback BEFORE anything records the note's own identity. This is the ONE window
    /// `performSave`'s own comment names ("the rename has landed and this continuation has not run
    /// yet") — and, post-N1, the CLASSIFIER's own header discloses exactly what happens in it: this
    /// reads `.external`, not `.ours`, because nothing has been CONFIRMED yet (`officeDiskChange`'s
    /// own doc comment on why "merely pending" stopped being enough). Split into a clean/dirty pair,
    /// each driven through `fileChangedOnDisk` — the CLASSIFIER — never by dispatching
    /// `.externalChangeDetected` directly, matching N1's own review wording verbatim.
    ///
    /// **Superseded name, for anyone still searching for it**:
    /// `testAGenuineOursRaceStaysSuppressedButUntouchedUntilTheOwningSaveCatchesUp` asserted the
    /// PRE-N1 behavior (an unmatched fire left the bag untouched and never reloaded) — that claim is
    /// now FALSE by design; these two tests replace it. The surviving, still-true half of its old
    /// claim (a redundant `recordLandedIdentity` + `withdrawExpectedWrite` catch-up is always safe,
    /// whether or not any fire ever preceded it) is folded into each test below rather than kept
    /// as a separate proof.
    func testExternalWriteBetweenNoteExpectedWriteAndTheOwningSavesWithdrawOnACleanDocumentReloads() async throws {
        let path = try scratchFile(contents: "one")
        let runtime = OfficeRuntime(sessionId: "S1", driver: makeDriver())
        runtimes.append(runtime)
        runtime.open(path)
        _ = await waitUntil { runtime.stateSnapshot.documents[path] != nil }
        let originalDocId = try XCTUnwrap(runtime.stateSnapshot.documents[path]?.docId)
        XCTAssertEqual(runtime.stateSnapshot.documents[path]?.dirty, false, "setup: a freshly opened document starts clean")

        let token = runtime.noteExpectedWrite(path: path) // "a write is about to happen" — performSave's own first act
        try "new bytes landed before this save's own identity was recorded".write(
            toFile: path, atomically: true, encoding: .utf8)
        runtime.fileChangedOnDisk(path) // the CLASSIFIER — the fire arrives before performSave's own catch-up would have

        let reloaded = await waitUntil {
            runtime.stateSnapshot.documents[path] != nil && runtime.stateSnapshot.documents[path]?.docId != originalDocId
        }
        XCTAssertTrue(reloaded, "N1: an unconfirmed fire can no longer be silently swallowed as "
                      + ".ours — clean means exactly the silent reload an ordinary external change always gets")
        XCTAssertNil(runtime.stateSnapshot.documentConflicts[path], "clean never conflicts — the reload is the whole answer")

        // The superseded save's own (now redundant) catch-up must still be safe against the NEW
        // docId's own bag — a stale token from a save whose document has already been replaced.
        let landedStat = officeFileStat(atPath: path)
        runtime.recordLandedIdentity(path: path, token: token, stat: landedStat)
        runtime.withdrawExpectedWrite(path: path, token: token)
        XCTAssertEqual(runtime.expectedWriteCount(for: path), 0, "a redundant catch-up is always "
                       + "safe, whether or not any fire preceded it — the surviving half of the "
                       + "superseded test's own claim")
    }

    /// The dirty half of the pair immediately above: the SAME unconfirmed-fire race, but on a
    /// document already carrying unsaved edits — `officeDiskChange`'s own doc comment names this
    /// exact outcome as the "self-healing false positive" (a conflict banner that flashes up and is
    /// then immediately resolved by that same save's own `.saveSucceeded`, moments later, since a
    /// successful save unconditionally clears any standing conflict). This test proves the FIRST
    /// half only — the banner raised, no silent reload/data-loss — `.saveSucceeded`'s own clearing
    /// arm is proven separately (`OfficeRuntimeReducerTests`' `.saveSucceeded` rows).
    func testExternalWriteBetweenNoteExpectedWriteAndTheOwningSavesWithdrawOnADirtyDocumentRaisesAConflict() async throws {
        let path = try scratchFile(contents: "one")
        let runtime = OfficeRuntime(sessionId: "S1", driver: makeDriver())
        runtimes.append(runtime)
        runtime.open(path)
        _ = await waitUntil { runtime.stateSnapshot.documents[path] != nil }
        let originalDocId = try XCTUnwrap(runtime.stateSnapshot.documents[path]?.docId)
        runtime.handle(documentEvent: .modifiedChanged(true), docId: originalDocId)
        XCTAssertEqual(runtime.stateSnapshot.documents[path]?.dirty, true, "setup: this document now carries unsaved edits")

        let token = runtime.noteExpectedWrite(path: path)
        try "new bytes landed before this save's own identity was recorded".write(
            toFile: path, atomically: true, encoding: .utf8)
        runtime.fileChangedOnDisk(path)

        let conflicted = await waitUntil { runtime.stateSnapshot.documentConflicts[path] != nil }
        XCTAssertTrue(conflicted, "N1: an unconfirmed fire on a DIRTY document must not be swallowed "
                      + "either — a genuine external write racing an in-flight save is exactly what "
                      + "silently clobbered the next time this runtime saves, pre-fix")
        XCTAssertEqual(runtime.stateSnapshot.documentConflicts[path], .changed)
        XCTAssertEqual(runtime.stateSnapshot.documents[path]?.docId, originalDocId, "dirty never "
                       + "silently reloads — the in-memory edits are never discarded without a "
                       + "choice, conflict or not")

        let landedStat = officeFileStat(atPath: path)
        runtime.recordLandedIdentity(path: path, token: token, stat: landedStat)
        runtime.withdrawExpectedWrite(path: path, token: token)
        XCTAssertEqual(runtime.expectedWriteCount(for: path), 0, "a redundant catch-up is always "
                       + "safe, whether or not any fire preceded it")
    }

    /// **Task review fix round 1 (IMPORTANT-2) — the reviewer's own original scenario, re-proven
    /// under the round-2 identity-matching design.** Two saves are in flight on the SAME path; the
    /// FIRST save's own rename lands and is fully confirmed (recorded identity) before its own
    /// watcher fire is simulated. The claim: a fire that definitively matches the FIRST save's own
    /// identity must consume ONLY that note, never touching the SECOND save's still entirely
    /// unconfirmed one.
    ///
    /// **Fix round 3 (re-review) honesty note**: this manually calls `recordLandedIdentity` BEFORE
    /// simulating the fire — `performSave` itself can never produce this ordering, because it always
    /// calls `recordLandedIdentity` immediately followed by `withdrawExpectedWrite`, `await`-free, in
    /// the same `@MainActor` turn, so no fire ever gets a turn to observe a recorded-but-unwithdrawn
    /// identity in real usage (`pendingExpectedWrites`'s own header has the full account). This test
    /// proves the MATCHING PRIMITIVE is correct in isolation — a defensive backstop worth keeping —
    /// not that this exact race happens in production. The two
    /// `testExternalWriteBetweenNoteExpectedWriteAndTheOwningSavesWithdraw...` tests above drive the
    /// interleaving `performSave` can actually produce — post-N1, that interleaving no longer
    /// classifies `.ours` at all (see their own doc comments); this test's own claim is narrower and
    /// still holds unchanged: ONCE an identity is genuinely recorded, matching is exact, not FIFO.
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

        // The FIRST save's own rename lands, and its own continuation records what it produced —
        // `performSave`'s own real ordering (record BEFORE withdraw).
        try "the first save's own rendered content".write(toFile: path, atomically: true, encoding: .utf8)
        let firstLandedStat = officeFileStat(atPath: path)
        runtime.recordLandedIdentity(path: path, token: firstSaveToken, stat: firstLandedStat)

        // Its own fire arrives — now matchable with CERTAINTY against the identity just recorded.
        runtime.fileChangedOnDisk(path)
        XCTAssertEqual(runtime.stateSnapshot.documents[path]?.docId, originalDocId, "the first save's "
                       + "own fire must classify .ours — no reload")
        XCTAssertEqual(runtime.expectedWriteCount(for: path), 1, "the fire consumed EXACTLY the note "
                       + "whose recorded identity it matched (the first save's) — the second save's "
                       + "own, still entirely unconfirmed note must remain untouched")

        // The FIRST save's own continuation now runs its (now redundant) withdraw.
        runtime.withdrawExpectedWrite(path: path, token: firstSaveToken)
        XCTAssertEqual(runtime.expectedWriteCount(for: path), 1, "THE CORE CLAIM: the first save's "
                       + "own redundant withdraw must be a no-op — the second save's own note must "
                       + "survive it untouched, not get stolen")

        // The SECOND save's own rename lands later; its own fire must still correctly classify
        // `.ours` and consume the SURVIVING note once ITS OWN identity is recorded too.
        try "the second save's own rendered content".write(toFile: path, atomically: true, encoding: .utf8)
        let secondLandedStat = officeFileStat(atPath: path)
        runtime.recordLandedIdentity(path: path, token: secondSaveToken, stat: secondLandedStat)
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

    /// **Task review fix round 2 (IMPORTANT-2, re-review) — the reviewer's own counter-example to
    /// round 1's FIFO design, driven directly.** `placeAtomically` runs in an independent
    /// `Task.detached` PER save, so nothing guarantees the FIRST-noted save's rename lands first:
    /// here the SECOND save's rename lands and fires FIRST — the exact inverted-completion-order
    /// scenario the re-review named as breaking FIFO consumption ("FIFO consumeExpectedWrite
    /// retires tokenA (not really B's)"). Under identity matching, position is irrelevant: B's fire
    /// can only match B's own recorded identity, so A's note is untouched regardless of which save
    /// finishes first.
    ///
    /// **Fix round 3 (re-review) honesty note**: like the test above, this manually calls
    /// `recordLandedIdentity` before each simulated fire — an ordering `performSave` itself cannot
    /// produce in real usage (record and withdraw are atomic and `await`-free within one save's own
    /// continuation; see `pendingExpectedWrites`'s own header). This proves the MATCHING PRIMITIVE
    /// correctly rejects position as a signal, in isolation — the FIFO counter-example the re-review
    /// gave is exactly what this pins against ever regressing — not that this specific interleaving
    /// is what happens today.
    func testASecondSavesNoteSurvivesEvenWhenTheSecondSaveLandsAndFiresFirst() async throws {
        let path = try scratchFile(contents: "one")
        let runtime = OfficeRuntime(sessionId: "S1", driver: makeDriver())
        runtimes.append(runtime)
        runtime.open(path)
        _ = await waitUntil { runtime.stateSnapshot.documents[path] != nil }
        let originalDocId = try XCTUnwrap(runtime.stateSnapshot.documents[path]?.docId)

        // A noted FIRST, B noted SECOND — but nothing about note ORDER predicts landing order.
        let tokenA = runtime.noteExpectedWrite(path: path)
        let tokenB = runtime.noteExpectedWrite(path: path)
        XCTAssertEqual(runtime.expectedWriteCount(for: path), 2)

        // B's own rename lands and is confirmed FIRST, despite being noted second — the inverted
        // order a fast, small save can produce against a slow, large one noted moments earlier.
        try "B's own rendered content".write(toFile: path, atomically: true, encoding: .utf8)
        let bLandedStat = officeFileStat(atPath: path)
        runtime.recordLandedIdentity(path: path, token: tokenB, stat: bLandedStat)

        // B's own fire arrives first too.
        runtime.fileChangedOnDisk(path)
        XCTAssertEqual(runtime.stateSnapshot.documents[path]?.docId, originalDocId, "B's own fire "
                       + "must classify .ours — no reload")
        XCTAssertEqual(runtime.expectedWriteCount(for: path), 1, "THE CORE CLAIM: B's fire must "
                       + "match and consume EXACTLY tokenB by its recorded identity — under round "
                       + "1's FIFO design this would instead have removed tokenA, the OLDEST pending "
                       + "token, misattributing B's landing to A")
        runtime.withdrawExpectedWrite(path: path, token: tokenB) // B's own, now-redundant catch-up
        XCTAssertEqual(runtime.expectedWriteCount(for: path), 1, "tokenA must still be the ONE "
                       + "remaining note — not already gone via a stolen FIFO removal")

        // A's own rename lands SECOND (despite being noted first) and is confirmed.
        try "A's own rendered content".write(toFile: path, atomically: true, encoding: .utf8)
        let aLandedStat = officeFileStat(atPath: path)
        runtime.recordLandedIdentity(path: path, token: tokenA, stat: aLandedStat)
        runtime.fileChangedOnDisk(path)
        XCTAssertEqual(runtime.stateSnapshot.documents[path]?.docId, originalDocId, "A's own real, "
                       + "later rename must ALSO classify .ours — reading `.external` here (a fresh "
                       + "docId, a spurious reload of A's own just-saved content) is precisely the "
                       + "failure mode the re-review caught surviving round 1's FIFO fix")
        XCTAssertNil(runtime.stateSnapshot.documentBanners[path])
        XCTAssertEqual(runtime.expectedWriteCount(for: path), 0)
        runtime.withdrawExpectedWrite(path: path, token: tokenA)
        XCTAssertEqual(runtime.expectedWriteCount(for: path), 0)
    }

    /// `consumeExpectedWrite`'s own matching semantics, proven directly, no `OfficeRuntime` document
    /// lifecycle involved — mirrors `OfficePlaceAtomicallyTests`' own posture of testing a stateful
    /// primitive in isolation. Explicitly a backstop pin, not a production-race proof (fix round 3,
    /// re-review): `recordLandedIdentity` calls here are driven directly, an access `performSave`
    /// itself never exposes a fire to in real usage — see `pendingExpectedWrites`'s own header for
    /// why. Three claims: an EXACT match consumes precisely that note and no
    /// other, even with a second, different note also pending; a near-miss (one field of the
    /// inode/size/mtime-ns triple different) matches nothing and leaves both notes untouched; and a
    /// path with no pending notes at all returns `nil` without side effects — `officeDiskChange`'s
    /// own `expectedWrites == 0` check is what actually routes that last case to `.external`, but
    /// `consumeExpectedWrite` itself must still be inert against it (a defensive property, not
    /// merely an emergent one — `fileChangedOnDisk` calls it unconditionally inside `.ours`, which
    /// `officeDiskChange` already guarantees `expectedWrites > 0` for, but the primitive itself
    /// should not silently depend on that caller discipline to stay safe).
    func testConsumeExpectedWriteMatchesByIdentityNotPositionOrArrivalOrder() {
        let watchers = OfficeWatcherRecorder()
        let runtime = OfficeRuntime(sessionId: "S1", driver: makeDriver(), makeWatcher: watchers.factory)
        runtimes.append(runtime)
        let path = "/never-opened-identity-probe.xlsx"

        // No pending notes at all: inert.
        XCTAssertNil(runtime.consumeExpectedWrite(path: path, matching: nil))
        let someStat = OfficeFileStat(inode: 1, size: 10, modifiedSeconds: 100, modifiedNanoseconds: 0)
        XCTAssertNil(runtime.consumeExpectedWrite(path: path, matching: someStat))

        let tokenX = runtime.noteExpectedWrite(path: path)
        let tokenY = runtime.noteExpectedWrite(path: path)
        let identityX = OfficeFileStat(inode: 111, size: 2048, modifiedSeconds: 1_700_000_000, modifiedNanoseconds: 123)
        let identityY = OfficeFileStat(inode: 222, size: 4096, modifiedSeconds: 1_700_000_100, modifiedNanoseconds: 456)
        runtime.recordLandedIdentity(path: path, token: tokenX, stat: identityX)
        runtime.recordLandedIdentity(path: path, token: tokenY, stat: identityY)
        XCTAssertEqual(runtime.expectedWriteCount(for: path), 2)

        // A near-miss — one nanosecond off Y's own identity — matches NEITHER note.
        let nearMissY = OfficeFileStat(inode: 222, size: 4096, modifiedSeconds: 1_700_000_100, modifiedNanoseconds: 457)
        XCTAssertNil(runtime.consumeExpectedWrite(path: path, matching: nearMissY), "a near-miss must "
                     + "match nothing — this bag proves attribution by FACT, not by \"close enough\"")
        XCTAssertEqual(runtime.expectedWriteCount(for: path), 2, "the near-miss must not have touched "
                       + "either note")

        // An EXACT match for Y consumes precisely tokenY, leaving tokenX untouched — regardless of
        // X having been noted (and having its identity recorded) FIRST.
        let consumed = runtime.consumeExpectedWrite(path: path, matching: identityY)
        XCTAssertEqual(consumed, tokenY, "must return the SPECIFIC token that matched")
        XCTAssertEqual(runtime.expectedWriteCount(for: path), 1, "exactly one note consumed")

        // X's own identity is unaffected and still matchable.
        let consumedX = runtime.consumeExpectedWrite(path: path, matching: identityX)
        XCTAssertEqual(consumedX, tokenX)
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
        let runtime = OfficeRuntime(sessionId: "S1", driver: makeDriver(save: { _, _ in tempPath }))
        runtimes.append(runtime)
        runtime.open(path)
        _ = await waitUntil { runtime.stateSnapshot.documents[path] != nil }

        runtime.save(path)
        let saved = await waitUntil { (try? String(contentsOfFile: path, encoding: .utf8)) == "rendered" }
        XCTAssertTrue(saved)
        let settled = await waitUntil { runtime.expectedWriteCount(for: path) == 0 }
        XCTAssertTrue(settled, "no fire ever arrived, and the note must still not be left standing")
    }

    // MARK: - Office Stage B Task 3: saveAndAwaitOutcome — the dirty-close sheet's own awaitable door

    /// The ordinary success path: the outcome resolves `.saved` exactly once the write to the REAL
    /// path has genuinely landed — not merely once the driver's own `save` returned, which
    /// `testASaveWithNoWatcherFireAtAllStillLeavesNoLeakedNote` above already proves is not the same
    /// beat (the atomic place still has to run). No `runtime.handle(documentEvent:.modifiedChanged…)`
    /// anywhere in this test — this door's whole reason for existing (its own doc) is that it does
    /// NOT wait for LOK's separate, later `ModifiedStatus=false` callback.
    func testSaveAndAwaitOutcomeReturnsSavedOnceTheRealFileIsWritten() async throws {
        let path = try scratchFile(contents: "one")
        let tempPath = try scratchFile(name: "rendered.xlsx", contents: "rendered")
        let runtime = OfficeRuntime(sessionId: "S1", driver: makeDriver(save: { _, _ in tempPath }))
        runtimes.append(runtime)
        runtime.open(path)
        _ = await waitUntil { runtime.stateSnapshot.documents[path] != nil }

        let outcome = await runtime.saveAndAwaitOutcome(path)

        XCTAssertEqual(outcome, .saved)
        XCTAssertEqual(try String(contentsOfFile: path, encoding: .utf8), "rendered")
    }

    /// The helper's own `saveAs` fails (`OfficeHelperClientError.saveFailed`, the shape
    /// `OfficeDriverRecorder`'s identical seam in `ShellSessionHostTests` throws) — resolved from the
    /// OUTER catch in `performSave` (the driver's own `try await driver.save(docId)` never returns).
    func testSaveAndAwaitOutcomeReturnsFailedWhenTheDriversSaveThrows() async throws {
        let path = try scratchFile(contents: "one")
        let runtime = OfficeRuntime(sessionId: "S1", driver: makeDriver(save: { _, _ in
            throw OfficeHelperClientError.saveFailed(reason: "disk full")
        }))
        runtimes.append(runtime)
        runtime.open(path)
        _ = await waitUntil { runtime.stateSnapshot.documents[path] != nil }

        let outcome = await runtime.saveAndAwaitOutcome(path)

        guard case .failed(let reason) = outcome else {
            return XCTFail("expected .failed, got \(outcome)")
        }
        XCTAssertTrue(reason.contains("disk full"), "the driver's own reason must reach the caller: \(reason)")
        XCTAssertEqual(runtime.stateSnapshot.documentBanners[path]?.contains("disk full"), true,
                       "the ordinary banner machinery still fires — this door adds a SECOND way to "
                       + "learn the outcome, it does not replace the first")
    }

    /// **Fix round 1 (review F1) — this test's own sibling, the HIT branch neither the pinned
    /// "disk full" test above nor `ShellSessionHostTests`' own error-mapping test (which exercises
    /// `.openFailed` only) ever covers.** Without this, reverting the F1 fix (routing `.saveFailed`
    /// back to `default: clientError.description`) leaves every test in this suite green — exactly
    /// the un-pinned-hit-branch shape F4's own header warns about. A known LOK shape thrown from the
    /// driver's `save` closure (mirroring the test above's identical seam) must map to house voice in
    /// BOTH the outcome and the banner, and the raw needle text must NOT survive into either.
    func testSaveAndAwaitOutcomeMapsAKnownLOKShapeToHouseVoiceInBothTheOutcomeAndTheBanner() async throws {
        let path = try scratchFile(contents: "one")
        let runtime = OfficeRuntime(sessionId: "S1", driver: makeDriver(save: { _, _ in
            throw OfficeHelperClientError.saveFailed(reason: "Unspecified Application Error")
        }))
        runtimes.append(runtime)
        runtime.open(path)
        _ = await waitUntil { runtime.stateSnapshot.documents[path] != nil }

        let outcome = await runtime.saveAndAwaitOutcome(path)

        guard case .failed(let reason) = outcome else {
            return XCTFail("expected .failed, got \(outcome)")
        }
        XCTAssertTrue(reason.contains("couldn't make sense of this file"), "a known LOK shape must "
                      + "map to house voice in the outcome too: \(reason)")
        XCTAssertFalse(reason.contains("Unspecified"), "the raw LOK needle text must never survive "
                       + "into the outcome: \(reason)")
        let banner = runtime.stateSnapshot.documentBanners[path]
        XCTAssertEqual(banner?.contains("couldn't make sense of this file"), true,
                       "and in the banner — the same mapped sentence, not the raw shape")
        XCTAssertEqual(banner?.contains("Unspecified"), false, "the raw LOK needle text must never "
                       + "reach the banner either")
    }

    /// **Whole-branch review I1 — the SAVE-side needle, pinned on the exact raw text Task 11
    /// measured through the real helper.** The sibling above proves the mapping mechanism works for
    /// an open-side shape; this proves the one save-side shape a user can actually hit is IN the
    /// table. Before the needle existed, `houseErrorSentenceForSaveFailure`'s deliberate
    /// return-unrecognized-reasons-verbatim rule (which the `"disk full"` contract below requires)
    /// carried `SfxBaseModel::impl_store ... 0xc10(Error Area:Io Class:Write Code:16)` straight into
    /// the user's banner — exactly the class T9's F1 fix existed to eliminate.
    ///
    /// The raw string is the one `OfficeHelperLiveTests.testXlsxDocxPptxSaveRoundTripThroughTheReal
    /// HelperAfterTheR4VendorRecut` pins, reproduced here verbatim rather than reduced to the needle
    /// — a needle asserted against itself would pass no matter how the real text drifts.
    func testSaveAndAwaitOutcomeMapsTheRealLOKStoreWriteFailureToHouseVoiceRatherThanLeakingIt() async throws {
        let rawLOKText = "SfxBaseModel::impl_store <file:///tmp/x.docx> failed: "
                       + "0xc10(Error Area:Io Class:Write Code:16)"
        let path = try scratchFile(contents: "one")
        let runtime = OfficeRuntime(sessionId: "S1", driver: makeDriver(save: { _, _ in
            throw OfficeHelperClientError.saveFailed(reason: rawLOKText)
        }))
        runtimes.append(runtime)
        runtime.open(path)
        _ = await waitUntil { runtime.stateSnapshot.documents[path] != nil }

        let outcome = await runtime.saveAndAwaitOutcome(path)

        guard case .failed(let reason) = outcome else {
            return XCTFail("expected .failed, got \(outcome)")
        }
        XCTAssertTrue(reason.contains("the office engine failed while writing the file"),
                      "the observed store-write shape must map to house voice: \(reason)")
        for leak in ["SfxBaseModel", "impl_store", "0xc10", "Error Area"] {
            XCTAssertFalse(reason.contains(leak), "raw LO internals (\(leak)) must never survive into "
                           + "the outcome: \(reason)")
            XCTAssertEqual(runtime.stateSnapshot.documentBanners[path]?.contains(leak), false,
                           "nor into the banner (\(leak)) — the raw text belongs in the log only")
        }
        XCTAssertEqual(runtime.stateSnapshot.documentBanners[path]?
                        .contains("the office engine failed while writing the file"), true,
                       "and the banner carries the same mapped sentence")
    }

    /// The driver's own `save` succeeds (a real temp path comes back) but the ATOMIC PLACE fails —
    /// the inner catch, `performSave`'s own distinct exit from the driver-throws case above. A
    /// nonexistent temp path is enough: `placeAtomically`'s `copyItem` throws ENOENT before ever
    /// touching the real destination.
    func testSaveAndAwaitOutcomeReturnsFailedWhenThePlaceCannotFindTheHelpersTempFile() async throws {
        let path = try scratchFile(contents: "one")
        let runtime = OfficeRuntime(sessionId: "S1", driver: makeDriver(
            save: { _, _ in "/tmp/office-save-await-nonexistent-\(UUID().uuidString)" }))
        runtimes.append(runtime)
        runtime.open(path)
        _ = await waitUntil { runtime.stateSnapshot.documents[path] != nil }
        let before = try String(contentsOfFile: path, encoding: .utf8)

        let outcome = await runtime.saveAndAwaitOutcome(path)

        guard case .failed = outcome else {
            return XCTFail("expected .failed, got \(outcome)")
        }
        XCTAssertEqual(try String(contentsOfFile: path, encoding: .utf8), before,
                       "a failed place must never touch the real file")
    }

    /// `.noModel` — mirrors `EditorSaveCoordinator.performSave`'s own `hasModel` gate: a path this
    /// runtime holds no open document for, answered WITHOUT ever registering a waiter (read from
    /// `.saveRequested`'s own dispatched effects, never a hand-duplicated copy of the reducer's
    /// guard — this door's own doc explains why that matters).
    func testSaveAndAwaitOutcomeReturnsNoModelForAPathWithNoOpenDocument() async {
        let runtime = OfficeRuntime(sessionId: "S1", driver: makeDriver())
        runtimes.append(runtime)

        let outcome = await runtime.saveAndAwaitOutcome("/never-opened.xlsx")

        XCTAssertEqual(outcome, .noModel)
    }

    /// **Supersession, EXIT A of `performSave`: the driver's own save genuinely succeeds, but the
    /// document is closed before the place can run.** Provoked deterministically, with no suspend/
    /// resume continuation machinery: the driver's OWN `save` closure calls `runtime.close(path)` as
    /// a side effect before returning its (otherwise valid) temp path — since that closure runs
    /// synchronously to completion on the main actor with no `await` of its own inside it, the close
    /// is guaranteed to have already landed in `documents` by the time `performSave` re-checks
    /// `self.state.documents[path]?.docId == docId` immediately after the `await` returns. This is
    /// the exact race a genuine tab-close racing an in-flight save would produce, minus the timing
    /// uncertainty — the OUTCOME this door must report is what is under test, not the scheduler.
    func testSaveAndAwaitOutcomeReturnsFailedWhenACloseSupersedesTheSaveBeforeThePlaceCanRun() async throws {
        let path = try scratchFile(contents: "one")
        let tempPath = try scratchFile(name: "rendered.xlsx", contents: "rendered")
        final class RuntimeBox { weak var runtime: OfficeRuntime? }
        let box = RuntimeBox()
        let runtime = OfficeRuntime(sessionId: "S1", driver: makeDriver(save: { [box] _, _ in
            box.runtime?.close(path)
            return tempPath
        }))
        runtimes.append(runtime)
        box.runtime = runtime
        runtime.open(path)
        _ = await waitUntil { runtime.stateSnapshot.documents[path] != nil }

        let outcome = await runtime.saveAndAwaitOutcome(path)

        guard case .failed = outcome else {
            return XCTFail("expected .failed (the close superseded this docId), got \(outcome)")
        }
        XCTAssertNil(runtime.stateSnapshot.documents[path], "the close this test provoked must have landed")
        XCTAssertEqual(try String(contentsOfFile: path, encoding: .utf8), "one",
                       "a superseded save must never place its bytes onto a path the runtime no "
                       + "longer considers open")
    }

    // MARK: - Office Stage B Task 7 fix round 1 (review I-2, at the Critical boundary): a plain
    // close must never end a STANDING recovery offer it was never told to resolve

    /// **The reviewer's own literal pin, driven end to end through a real `OfficeRuntime`'s public
    /// `open`/`close` doors: "open-with-candidate → close without touching the banner → reopen →
    /// the banner returns."** Seeds a "crashed" sidecar + manifest directly on disk (the SAME
    /// `OfficeRuntime.recordAutosaveManifest` static call `OfficeAutosaveManifestTests` uses, real
    /// files, real `stateDirectory`), opens the real path (finds the candidate — proven), closes it
    /// WITHOUT ever calling `restoreFromRecovery`/`discardRecovery` (the plain-⌘W shape: the current
    /// session is clean, so T3's own dirty-close sheet never even appears), then reopens the SAME
    /// path under a fresh docId and asserts the candidate is found AGAIN. Complements
    /// `OfficeAutosaveManifestTests
    /// .testClearAutosaveWithAlsoClearManifestOwnerFalseLeavesAStandingCandidatesSidecarAndManifestFindableAfterwards`,
    /// which proves the identical claim at the disk-mechanism level directly — this test proves the
    /// REDUCER's own decision (`alsoClearManifestOwner: false` at `.closeRequested`) and that
    /// decision's disk-level performer are correctly wired together, through the runtime's real
    /// public surface, not merely each half in isolation.
    func testCloseRequestedWithAStandingRecoveryCandidateLeavesItFindableAfterAReopen() async throws {
        let path = try scratchFile(name: "gate.odt", contents: "the real file's own content")
        let driver = makeDriver()
        let autosaveDirectory = driver.stateDirectory.appendingPathComponent("autosave", isDirectory: true)
        try FileManager.default.createDirectory(at: autosaveDirectory, withIntermediateDirectories: true)
        try "recovered content from the crashed session".write(
            to: autosaveDirectory.appendingPathComponent("crashed-doc.odt"), atomically: true, encoding: .utf8)
        OfficeRuntime.recordAutosaveManifest(realPath: path, docId: "crashed-doc", ext: "odt",
                                             isODFFallback: false, autosaveDirectory: autosaveDirectory)
        XCTAssertNotNil(OfficeRuntime.checkRecoveryCandidate(realPath: path, autosaveDirectory: autosaveDirectory),
                        "sanity: a fresh open right now would find the seeded candidate")

        let runtime = OfficeRuntime(sessionId: "S1", driver: driver)
        runtimes.append(runtime)

        runtime.open(path)
        let foundOnFirstOpen = await waitUntil { runtime.stateSnapshot.documentRecoveryCandidates[path] != nil }
        XCTAssertTrue(foundOnFirstOpen, "setup: the candidate must surface on the first open")
        XCTAssertEqual(runtime.stateSnapshot.documentRecoveryCandidates[path]?.docId, "crashed-doc")
        let firstDocId = try XCTUnwrap(runtime.stateSnapshot.documents[path]?.docId)

        // Close WITHOUT touching the banner at all — no restoreFromRecovery, no discardRecovery.
        runtime.close(path)
        let closed = await waitUntil { runtime.stateSnapshot.documents[path] == nil }
        XCTAssertTrue(closed, "setup: the close landed")

        // Reopen the SAME real path — a fresh docId, never `firstDocId`.
        runtime.open(path)
        let reopened = await waitUntil { runtime.stateSnapshot.documents[path] != nil }
        XCTAssertTrue(reopened, "setup: the reopen landed")
        XCTAssertNotEqual(runtime.stateSnapshot.documents[path]?.docId, firstDocId, "sanity: a fresh "
                          + "open always mints a new docId, restore included")

        let bannerReturned = await waitUntil { runtime.stateSnapshot.documentRecoveryCandidates[path] != nil }
        XCTAssertTrue(bannerReturned, "the banner must return on this reopen — a plain close of an "
                      + "untouched candidate must never have deleted the sidecar or manifest entry "
                      + "recovery depends on")
        XCTAssertEqual(runtime.stateSnapshot.documentRecoveryCandidates[path]?.docId, "crashed-doc",
                       "still the CRASHED session's own docId — the evidence itself, not merely some "
                       + "candidate")
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

    /// Office Stage B Task 2b (N1) — the TOCTOU-free identity capture, proven directly: the
    /// returned stat must describe the file AS IT LANDED (the sibling, stat'd before the rename on
    /// this same detached thread), not whatever a caller might re-stat moments later. Compared
    /// against a fresh `officeFileStat` read immediately after — the two must agree, since nothing
    /// else touches `destination` in between.
    func testReturnsTheLandedStatOfWhatItJustPlaced() throws {
        let docDir = makeScratchDirectory()
        let destination = docDir.appendingPathComponent("gate.xlsx")
        try "original".write(to: destination, atomically: true, encoding: .utf8)
        let helperTemp = makeScratchDirectory().appendingPathComponent("rendered")
        try "rendered content, a different length than the original".write(to: helperTemp, atomically: true, encoding: .utf8)

        let landed = try OfficeRuntime.placeAtomically(tempPath: helperTemp.path, at: destination.path)
        let rereadAfterward = officeFileStat(atPath: destination.path)
        XCTAssertNotNil(landed)
        XCTAssertEqual(landed, rereadAfterward, "the returned stat already describes exactly what a "
                       + "fresh re-stat finds — nothing was in flight between them")
    }
}

// MARK: - Office Stage B Task 2b: stageDocument / deleteStagedCopy — the Collabora-jail staging pair

final class OfficeStageDocumentTests: XCTestCase {
    private var scratchDirs: [URL] = []

    override func tearDown() {
        for dir in scratchDirs { try? FileManager.default.removeItem(at: dir) }
        scratchDirs.removeAll()
        super.tearDown()
    }

    private func makeScratchDirectory() -> URL {
        let dir = URL(fileURLWithPath: "/tmp/office-stage-document-\(UUID().uuidString.prefix(8))", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        scratchDirs.append(dir)
        return dir
    }

    /// The ordinary case: a real path's bytes land, byte-for-byte, at the staged path — proving the
    /// wire `open` this feeds really is a copy, not a symlink or a reference to the original.
    func testCopiesTheRealPathsContentToTheStagedPath() throws {
        let realDir = makeScratchDirectory()
        let realPath = realDir.appendingPathComponent("gate.xlsx")
        try "the real document's own bytes".write(to: realPath, atomically: true, encoding: .utf8)
        let docsDir = makeScratchDirectory().appendingPathComponent("docs", isDirectory: true)
        let stagedPath = docsDir.appendingPathComponent("doc-1.xlsx")

        try OfficeRuntime.stageDocument(realPath: realPath.path, stagedPath: stagedPath.path)

        XCTAssertEqual(try String(contentsOf: stagedPath, encoding: .utf8), "the real document's own bytes")
        // Independent copies, not the same inode/symlink — editing the staged copy (exactly what
        // this task's whole point is) must never reach back to the user's real file.
        try "edited in place".write(to: stagedPath, atomically: true, encoding: .utf8)
        XCTAssertEqual(try String(contentsOf: realPath, encoding: .utf8), "the real document's own bytes",
                       "the real file must be untouched by an edit to its staged copy")
    }

    /// `docs/` does not exist yet the first time ANY document is ever staged under a fresh
    /// `--state-path` — `withIntermediateDirectories: true` is what makes that the ordinary case
    /// rather than a special one, mirroring `LOKBridge`'s own `saves/` directory creation.
    func testCreatesTheDocsDirectoryOnFirstUse() throws {
        let realDir = makeScratchDirectory()
        let realPath = realDir.appendingPathComponent("gate.ods")
        try "content".write(to: realPath, atomically: true, encoding: .utf8)
        let docsDir = makeScratchDirectory().appendingPathComponent("docs", isDirectory: true)
        XCTAssertFalse(FileManager.default.fileExists(atPath: docsDir.path), "setup: docs/ genuinely does not exist yet")
        let stagedPath = docsDir.appendingPathComponent("doc-1.ods")

        try OfficeRuntime.stageDocument(realPath: realPath.path, stagedPath: stagedPath.path)

        XCTAssertTrue(FileManager.default.fileExists(atPath: stagedPath.path))
    }

    /// The staging failure this task's own `openAndDispatch` catch block turns into `openFailures` —
    /// a missing/garbage real path must throw, never silently produce an empty staged file.
    func testThrowsWhenTheRealPathDoesNotExist() throws {
        let docsDir = makeScratchDirectory().appendingPathComponent("docs", isDirectory: true)
        let stagedPath = docsDir.appendingPathComponent("doc-1.xlsx")
        XCTAssertThrowsError(try OfficeRuntime.stageDocument(
            realPath: "/tmp/office-stage-document-genuinely-missing-\(UUID().uuidString)",
            stagedPath: stagedPath.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: stagedPath.path), "no half-written stub left behind")
    }

    /// A reload re-stages the SAME real path under a FRESH docId — never the same staged path twice
    /// in practice — but the pre-clear (`try? removeItem` ahead of the `copyfile`) must not itself
    /// throw or misbehave on the degenerate case where something is already sitting there.
    func testOverwritesWhateverAlreadySatAtTheStagedPath() throws {
        let realDir = makeScratchDirectory()
        let realPath = realDir.appendingPathComponent("gate.xlsx")
        try "fresh content".write(to: realPath, atomically: true, encoding: .utf8)
        let docsDir = makeScratchDirectory().appendingPathComponent("docs", isDirectory: true)
        try FileManager.default.createDirectory(at: docsDir, withIntermediateDirectories: true)
        let stagedPath = docsDir.appendingPathComponent("doc-1.xlsx")
        try "stale leftover from a previous stage".write(to: stagedPath, atomically: true, encoding: .utf8)

        try OfficeRuntime.stageDocument(realPath: realPath.path, stagedPath: stagedPath.path)

        XCTAssertEqual(try String(contentsOf: stagedPath, encoding: .utf8), "fresh content")
    }

    /// The sweep's own discrimination, pinned directly: `docId + "."` as the prefix means a docId
    /// that is a literal PREFIX of another's own name (`"doc-1"` inside `"doc-10"`) must not collide
    /// — `deleteStagedCopy(docId: "doc-1", ...)` must remove ONLY `doc-1.xlsx`, never `doc-10.xlsx`.
    func testDeleteStagedCopyRemovesOnlyItsOwnDocIdNeverAPrefixCollision() throws {
        let docsDir = makeScratchDirectory()
        let ownFile = docsDir.appendingPathComponent("doc-1.xlsx")
        let collisionCandidate = docsDir.appendingPathComponent("doc-10.xlsx")
        try "mine".write(to: ownFile, atomically: true, encoding: .utf8)
        try "not mine".write(to: collisionCandidate, atomically: true, encoding: .utf8)

        OfficeRuntime.deleteStagedCopy(docId: "doc-1", docsDirectory: docsDir)

        XCTAssertFalse(FileManager.default.fileExists(atPath: ownFile.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: collisionCandidate.path), "a prefix "
                      + "collision must never sweep a DIFFERENT docId's own staged copy")
    }

    /// Best-effort, mirroring every other sweep in this codebase (`sweepStaleProfileDirectories`'s
    /// own header states the identical posture): nothing here to remove, and no `docs/` directory at
    /// all, must never throw or crash — every close/teardown/helper-death path calls this
    /// unconditionally, including for a docId whose staging attempt itself already failed.
    func testDeleteStagedCopyIsASafeNoOpWhenNothingMatchesOrTheDirectoryDoesNotExistAtAll() {
        let docsDir = makeScratchDirectory().appendingPathComponent("never-created", isDirectory: true)
        OfficeRuntime.deleteStagedCopy(docId: "doc-1", docsDirectory: docsDir) // must not throw/crash
    }

    // MARK: - Task 2b fix round 1 (review IMPORTANT-1): the staged copy's own metadata is normalized

    /// **`copyfile` preserves the SOURCE's mode by design** — a real document opened read-only
    /// (`0444`, no owner-write bit) would otherwise stage into an identically read-only copy,
    /// silently reproducing the exact bug this task exists to fix. Proven by actually writing to the
    /// staged copy (stronger than only inspecting the permission bits) and by deleting it through
    /// the SAME door `close`/teardown/reload use — a staged copy that stages read-only but merely
    /// LOOKS deletable would still be the bug, just a different symptom.
    func testStagingA0444SourceProducesAWritableAndDeletableStagedCopy() throws {
        let realDir = makeScratchDirectory()
        let realPath = realDir.appendingPathComponent("readonly.xlsx")
        try "original content".write(to: realPath, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o444], ofItemAtPath: realPath.path)
        defer { try? FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: realPath.path) }
        let docsDir = makeScratchDirectory()
        let stagedPath = docsDir.appendingPathComponent("doc-1.xlsx")

        try OfficeRuntime.stageDocument(realPath: realPath.path, stagedPath: stagedPath.path)

        let mode = (try FileManager.default.attributesOfItem(atPath: stagedPath.path))[.posixPermissions] as? Int
        XCTAssertEqual(mode, 0o600, "the staged copy must be normalized to owner read-write, "
                       + "regardless of the real document's own read-only mode")
        XCTAssertNoThrow(try "edited by LOK".write(to: stagedPath, atomically: true, encoding: .utf8),
                         "a permission bit that merely LOOKS right is not the claim — the staged "
                         + "copy must genuinely accept a write")
        XCTAssertEqual(try String(contentsOf: stagedPath, encoding: .utf8), "edited by LOK")

        OfficeRuntime.deleteStagedCopy(docId: "doc-1", docsDirectory: docsDir)
        XCTAssertFalse(FileManager.default.fileExists(atPath: stagedPath.path), "the sweep must be "
                       + "able to remove a copy staged from a read-only source")
    }

    /// **The worse half of the same finding**: a Finder-Locked source (`UF_IMMUTABLE`) additionally
    /// defeats plain deletion, not just writes — `deleteStagedCopy` and the `docs/` boot sweep are
    /// both `try?`-wrapped best-effort removals that would fail SILENTLY against it, leaking the
    /// staged copy forever. `chflags` must run before the permissions fix — an immutable file
    /// refuses `chmod` too, so getting the order backwards would leave this exact scenario broken.
    func testStagingAFinderLockedSourceProducesAWritableAndDeletableStagedCopy() throws {
        let realDir = makeScratchDirectory()
        let realPath = realDir.appendingPathComponent("locked.xlsx")
        try "original content".write(to: realPath, atomically: true, encoding: .utf8)
        XCTAssertEqual(chflags(realPath.path, UInt32(UF_IMMUTABLE)), 0, "setup: the source is Finder-Locked")
        defer { chflags(realPath.path, 0) } // let tearDown's own scratchDirs sweep actually remove it
        let docsDir = makeScratchDirectory()
        let stagedPath = docsDir.appendingPathComponent("doc-1.xlsx")

        try OfficeRuntime.stageDocument(realPath: realPath.path, stagedPath: stagedPath.path)

        var info = stat()
        XCTAssertEqual(stat(stagedPath.path, &info), 0)
        XCTAssertEqual(info.st_flags & UInt32(UF_IMMUTABLE), 0, "the staged copy must not inherit "
                       + "the source's own immutable flag")
        XCTAssertNoThrow(try "edited by LOK".write(to: stagedPath, atomically: true, encoding: .utf8))
        XCTAssertEqual(try String(contentsOf: stagedPath, encoding: .utf8), "edited by LOK")

        OfficeRuntime.deleteStagedCopy(docId: "doc-1", docsDirectory: docsDir)
        XCTAssertFalse(FileManager.default.fileExists(atPath: stagedPath.path), "an immutable SOURCE "
                       + "must never leak an undeletable staged copy behind it")
    }
}

// MARK: - Office Stage B Task 7: the autosave manifest — PURE disk I/O, no reducer, no LOK, no
// socket. Mirrors OfficePlaceAtomicallyTests/OfficeStageDocumentTests' own per-class scratch-dir
// shape immediately above.

final class OfficeAutosaveManifestTests: XCTestCase {
    private var scratchDirs: [URL] = []

    override func tearDown() {
        for dir in scratchDirs { try? FileManager.default.removeItem(at: dir) }
        scratchDirs = []
        super.tearDown()
    }

    private func makeScratchDirectory() -> URL {
        let dir = URL(fileURLWithPath: "/tmp/office-autosave-manifest-\(UUID().uuidString.prefix(8))", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        scratchDirs.append(dir)
        return dir
    }

    /// Explicit — two rapid writes in the SAME test can legitimately land the same nanosecond-
    /// resolution mtime on a fast enough filesystem; every freshness-dependent test below sets both
    /// timestamps far enough apart that flakiness is not physically possible, rather than trusting
    /// wall-clock ordering between two `Data.write` calls.
    private func setModificationDate(_ date: Date, atPath path: String) {
        try? FileManager.default.setAttributes([.modificationDate: date], ofItemAtPath: path)
    }

    private func autosaveDirectoryContents(_ dir: URL) -> Set<String> {
        Set((try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? [])
    }

    // MARK: - recordAutosaveManifest + checkRecoveryCandidate round trip

    func testRecordThenCheckFindsACandidateWhenTheSidecarIsNewerThanTheRealFile() throws {
        let autosaveDir = makeScratchDirectory()
        let realDir = makeScratchDirectory()
        let realPath = realDir.appendingPathComponent("notes.odt")
        try "old content".write(to: realPath, atomically: true, encoding: .utf8)
        setModificationDate(Date(timeIntervalSince1970: 1_000_000), atPath: realPath.path)

        let sidecarPath = autosaveDir.appendingPathComponent("crashed-doc.odt")
        try "recovered content".write(to: sidecarPath, atomically: true, encoding: .utf8)
        setModificationDate(Date(timeIntervalSince1970: 1_000_060), atPath: sidecarPath.path) // +60s

        OfficeRuntime.recordAutosaveManifest(realPath: realPath.path, docId: "crashed-doc", ext: "odt",
                                             isODFFallback: false, autosaveDirectory: autosaveDir)

        let candidate = OfficeRuntime.checkRecoveryCandidate(realPath: realPath.path, autosaveDirectory: autosaveDir)
        let found = try XCTUnwrap(candidate)
        XCTAssertEqual(found.docId, "crashed-doc")
        XCTAssertEqual(found.sidecarPath, sidecarPath.path)
        XCTAssertEqual(found.isODFFallback, false)
        XCTAssertEqual(found.capturedAt.timeIntervalSince1970, 1_000_060, accuracy: 0.001)
    }

    func testCheckReturnsNilWhenTheSidecarIsNotNewerThanTheRealFile() throws {
        let autosaveDir = makeScratchDirectory()
        let realDir = makeScratchDirectory()
        let realPath = realDir.appendingPathComponent("notes.odt")
        try "later content".write(to: realPath, atomically: true, encoding: .utf8)
        setModificationDate(Date(timeIntervalSince1970: 1_000_060), atPath: realPath.path)

        let sidecarPath = autosaveDir.appendingPathComponent("crashed-doc.odt")
        try "older content".write(to: sidecarPath, atomically: true, encoding: .utf8)
        setModificationDate(Date(timeIntervalSince1970: 1_000_000), atPath: sidecarPath.path) // -60s

        OfficeRuntime.recordAutosaveManifest(realPath: realPath.path, docId: "crashed-doc", ext: "odt",
                                             isODFFallback: false, autosaveDirectory: autosaveDir)

        XCTAssertNil(OfficeRuntime.checkRecoveryCandidate(realPath: realPath.path, autosaveDirectory: autosaveDir),
                     "the real file was independently saved/touched AFTER the sidecar — nothing to recover")
    }

    func testCheckReturnsNilWhenNoManifestWasEverWritten() throws {
        let autosaveDir = makeScratchDirectory()
        let realPath = makeScratchDirectory().appendingPathComponent("never-recorded.odt")
        try "content".write(to: realPath, atomically: true, encoding: .utf8)
        XCTAssertNil(OfficeRuntime.checkRecoveryCandidate(realPath: realPath.path, autosaveDirectory: autosaveDir))
    }

    /// A manifest exists, but the sidecar it points at is already gone (cleared by a save that
    /// raced ahead of a stale, in-flight autosave push) — a stale bookkeeping entry, not a
    /// recoverable candidate.
    func testCheckReturnsNilWhenTheManifestsSidecarIsMissing() throws {
        let autosaveDir = makeScratchDirectory()
        let realPath = makeScratchDirectory().appendingPathComponent("notes.odt")
        try "content".write(to: realPath, atomically: true, encoding: .utf8)
        let sidecarPath = autosaveDir.appendingPathComponent("crashed-doc.odt")
        try "sidecar".write(to: sidecarPath, atomically: true, encoding: .utf8)
        OfficeRuntime.recordAutosaveManifest(realPath: realPath.path, docId: "crashed-doc", ext: "odt",
                                             isODFFallback: false, autosaveDirectory: autosaveDir)
        try FileManager.default.removeItem(at: sidecarPath) // simulate the race

        XCTAssertNil(OfficeRuntime.checkRecoveryCandidate(realPath: realPath.path, autosaveDirectory: autosaveDir))
    }

    /// `recordAutosaveManifest` itself never resurrects a manifest for a sidecar that does not (yet,
    /// or any longer) exist — guards the identical race from the WRITE side.
    func testRecordWritesNothingWhenTheSidecarDoesNotExist() throws {
        let autosaveDir = makeScratchDirectory()
        let realPath = makeScratchDirectory().appendingPathComponent("notes.odt")
        try "content".write(to: realPath, atomically: true, encoding: .utf8)

        OfficeRuntime.recordAutosaveManifest(realPath: realPath.path, docId: "never-written", ext: "odt",
                                             isODFFallback: false, autosaveDirectory: autosaveDir)

        XCTAssertEqual(autosaveDirectoryContents(autosaveDir), [], "no sidecar existed to stat — "
                       + "nothing should have been written")
    }

    // MARK: - clearAutosave

    func testClearAutosaveDeletesTheSidecarAndTheManifest() throws {
        let autosaveDir = makeScratchDirectory()
        let realPath = makeScratchDirectory().appendingPathComponent("notes.odt")
        try "content".write(to: realPath, atomically: true, encoding: .utf8)
        try "sidecar".write(to: autosaveDir.appendingPathComponent("doc-a.odt"), atomically: true, encoding: .utf8)
        OfficeRuntime.recordAutosaveManifest(realPath: realPath.path, docId: "doc-a", ext: "odt",
                                             isODFFallback: false, autosaveDirectory: autosaveDir)
        XCTAssertEqual(autosaveDirectoryContents(autosaveDir).count, 2, "sanity: sidecar + manifest both exist")

        OfficeRuntime.clearAutosave(realPath: realPath.path, docId: "doc-a", autosaveDirectory: autosaveDir,
                                    alsoClearManifestOwner: true)

        XCTAssertEqual(autosaveDirectoryContents(autosaveDir), [], "both the sidecar and the manifest are gone")
    }

    /// **Live-drill-caught regression pin (`alsoClearManifestOwner: true` — `.saveSucceeded`/Discard
    /// shape).** After a Restore, the currently-open docId is a FRESH one — completely different
    /// from the CRASHED session's own docId the manifest still names. `clearAutosave`, called the
    /// way `.saveSucceeded` calls it, must clear BOTH: the (here, never-created) current docId's own
    /// prefix, AND the manifest's own recorded docId's sidecar — not just whichever docId happened
    /// to be passed in literally.
    func testClearAutosaveAlsoClearsTheManifestsOwnDocIdWhenItDiffersFromTheOneAsked() throws {
        let autosaveDir = makeScratchDirectory()
        let realPath = makeScratchDirectory().appendingPathComponent("notes.odt")
        try "content".write(to: realPath, atomically: true, encoding: .utf8)
        let crashedSidecar = autosaveDir.appendingPathComponent("crashed-doc.odt")
        try "recovered content".write(to: crashedSidecar, atomically: true, encoding: .utf8)
        OfficeRuntime.recordAutosaveManifest(realPath: realPath.path, docId: "crashed-doc", ext: "odt",
                                             isODFFallback: false, autosaveDirectory: autosaveDir)
        XCTAssertEqual(autosaveDirectoryContents(autosaveDir).count, 2, "sanity: sidecar + manifest")

        // The currently-open document is a DIFFERENT, freshly-minted docId (the restored one) —
        // never `crashed-doc` — exactly the post-Restore, no-further-typing shape the drill hit.
        OfficeRuntime.clearAutosave(realPath: realPath.path, docId: "restored-doc-2", autosaveDirectory: autosaveDir,
                                    alsoClearManifestOwner: true)

        XCTAssertEqual(autosaveDirectoryContents(autosaveDir), [], "the crashed session's own "
                       + "sidecar must be cleared even though a DIFFERENT docId was asked for — "
                       + "sourced from the manifest, not the literal parameter alone")
    }

    /// **Fix round 1 (review I-2, at the Critical boundary) — the disk-level half of the pin.** The
    /// EXACT opposite call `.closeRequested` makes when a STANDING, never-Restored/never-Discarded
    /// recovery candidate exists for this path: a DIFFERENT (fresh, clean) docId is closing, and
    /// `alsoClearManifestOwner: false` must leave the crashed session's own sidecar AND its manifest
    /// entry fully intact — not merely "not immediately swept," but genuinely still findable by a
    /// FRESH `checkRecoveryCandidate` call, exactly as a real reopen would make. This is the
    /// reviewer's own "open-with-candidate → close without touching the banner → reopen → the
    /// banner returns" pin, driven directly at the mechanism `.closeRequested` actually calls — see
    /// `OfficeRuntimeWatcherTests
    /// .testCloseRequestedWithAStandingRecoveryCandidateLeavesItFindableAfterAReopen` for the SAME
    /// claim proven through a real `OfficeRuntime`'s own public `open`/`close` doors end to end.
    func testClearAutosaveWithAlsoClearManifestOwnerFalseLeavesAStandingCandidatesSidecarAndManifestFindableAfterwards() throws {
        let autosaveDir = makeScratchDirectory()
        let realPath = makeScratchDirectory().appendingPathComponent("notes.odt")
        try "content".write(to: realPath, atomically: true, encoding: .utf8)
        let crashedSidecar = autosaveDir.appendingPathComponent("crashed-doc.odt")
        try "recovered content".write(to: crashedSidecar, atomically: true, encoding: .utf8)
        OfficeRuntime.recordAutosaveManifest(realPath: realPath.path, docId: "crashed-doc", ext: "odt",
                                             isODFFallback: false, autosaveDirectory: autosaveDir)
        XCTAssertEqual(autosaveDirectoryContents(autosaveDir).count, 2, "sanity: sidecar + manifest")
        XCTAssertNotNil(OfficeRuntime.checkRecoveryCandidate(realPath: realPath.path, autosaveDirectory: autosaveDir),
                        "sanity: a fresh open right now WOULD find the candidate")

        // A plain close of the fresh, clean, un-restored tab this path is currently open under —
        // never `crashed-doc`, and the banner was never Restored or Discarded.
        OfficeRuntime.clearAutosave(realPath: realPath.path, docId: "fresh-clean-doc", autosaveDirectory: autosaveDir,
                                    alsoClearManifestOwner: false)

        XCTAssertEqual(autosaveDirectoryContents(autosaveDir).count, 2, "the standing candidate's own "
                       + "sidecar and manifest must survive a plain close untouched — closing "
                       + "\"fresh-clean-doc\" (which never had a sidecar of its own) must not reach "
                       + "into a DIFFERENT, unrelated candidate's evidence")
        let reopened = OfficeRuntime.checkRecoveryCandidate(realPath: realPath.path, autosaveDirectory: autosaveDir)
        XCTAssertEqual(reopened?.docId, "crashed-doc", "the banner returns on the next open — this IS "
                       + "the reviewer's own \"close without touching the banner → reopen → the "
                       + "banner returns\" claim, at the disk mechanism directly")
    }

    func testClearAutosaveIsASafeNoOpWhenNothingExists() {
        let autosaveDir = makeScratchDirectory()
        // must not throw/crash — value of `alsoClearManifestOwner` is immaterial when nothing exists
        OfficeRuntime.clearAutosave(realPath: "/never/opened.odt", docId: "doc-a", autosaveDirectory: autosaveDir,
                                    alsoClearManifestOwner: true)
    }

    /// The identical prefix-collision discrimination `deleteStagedCopy`'s own pin proves for
    /// `docs/` — `"doc-1."` must never match `"doc-10.odt"`.
    func testClearAutosaveRemovesOnlyItsOwnDocIdNeverAPrefixCollision() throws {
        let autosaveDir = makeScratchDirectory()
        let ownFile = autosaveDir.appendingPathComponent("doc-1.odt")
        let collisionCandidate = autosaveDir.appendingPathComponent("doc-10.odt")
        try "mine".write(to: ownFile, atomically: true, encoding: .utf8)
        try "not mine".write(to: collisionCandidate, atomically: true, encoding: .utf8)

        OfficeRuntime.clearAutosave(realPath: "/some/real/path.odt", docId: "doc-1", autosaveDirectory: autosaveDir,
                                    alsoClearManifestOwner: false)

        XCTAssertFalse(FileManager.default.fileExists(atPath: ownFile.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: collisionCandidate.path))
    }

    // MARK: - sweepAutosaveOrphans — manifest-aware, never wholesale (the load-bearing distinction
    // from LOKBridge.sweepStaleDocumentDirectories's own docs/saves wipe)

    func testSweepRemovesASidecarThatHasNoMatchingManifest() throws {
        let autosaveDir = makeScratchDirectory()
        let orphanSidecar = autosaveDir.appendingPathComponent("orphan-doc.odt")
        try "orphan".write(to: orphanSidecar, atomically: true, encoding: .utf8)

        OfficeRuntime.sweepAutosaveOrphans(autosaveDirectory: autosaveDir)

        XCTAssertEqual(autosaveDirectoryContents(autosaveDir), [])
    }

    func testSweepRemovesAManifestThatHasNoMatchingSidecar() throws {
        let autosaveDir = makeScratchDirectory()
        let realPath = makeScratchDirectory().appendingPathComponent("notes.odt")
        try "content".write(to: realPath, atomically: true, encoding: .utf8)
        let sidecarPath = autosaveDir.appendingPathComponent("doc-a.odt")
        try "sidecar".write(to: sidecarPath, atomically: true, encoding: .utf8)
        OfficeRuntime.recordAutosaveManifest(realPath: realPath.path, docId: "doc-a", ext: "odt",
                                             isODFFallback: false, autosaveDirectory: autosaveDir)
        try FileManager.default.removeItem(at: sidecarPath) // the sidecar's own clear raced ahead

        OfficeRuntime.sweepAutosaveOrphans(autosaveDirectory: autosaveDir)

        XCTAssertEqual(autosaveDirectoryContents(autosaveDir), [], "the now-pointless manifest must go too")
    }

    func testSweepRemovesTornTempFilesUnconditionally() throws {
        let autosaveDir = makeScratchDirectory()
        try "half-written by a SIGKILL mid-rename".write(
            to: autosaveDir.appendingPathComponent(".tmp-doc-a-\(UUID().uuidString).odt"),
            atomically: true, encoding: .utf8)

        OfficeRuntime.sweepAutosaveOrphans(autosaveDirectory: autosaveDir)

        XCTAssertEqual(autosaveDirectoryContents(autosaveDir), [], "dead by construction — nothing "
                       + "ever points at a temp-named file")
    }

    /// **The load-bearing negative case**: a genuinely live, recoverable pair (sidecar newer than
    /// the real file, both present) must survive the sweep untouched — this is the whole reason the
    /// sweep is manifest-AWARE rather than a wholesale wipe.
    func testSweepNeverTouchesALiveRecoverablePair() throws {
        let autosaveDir = makeScratchDirectory()
        let realPath = makeScratchDirectory().appendingPathComponent("notes.odt")
        try "old".write(to: realPath, atomically: true, encoding: .utf8)
        setModificationDate(Date(timeIntervalSince1970: 1_000_000), atPath: realPath.path)
        let sidecarPath = autosaveDir.appendingPathComponent("doc-a.odt")
        try "recovered".write(to: sidecarPath, atomically: true, encoding: .utf8)
        setModificationDate(Date(timeIntervalSince1970: 1_000_060), atPath: sidecarPath.path)
        OfficeRuntime.recordAutosaveManifest(realPath: realPath.path, docId: "doc-a", ext: "odt",
                                             isODFFallback: false, autosaveDirectory: autosaveDir)
        let before = autosaveDirectoryContents(autosaveDir)
        XCTAssertEqual(before.count, 2, "sanity")

        OfficeRuntime.sweepAutosaveOrphans(autosaveDirectory: autosaveDir)

        XCTAssertEqual(autosaveDirectoryContents(autosaveDir), before, "a live, recoverable pair is "
                       + "NEVER removed by the boot sweep")
        XCTAssertNotNil(OfficeRuntime.checkRecoveryCandidate(realPath: realPath.path, autosaveDirectory: autosaveDir),
                        "still genuinely recoverable after the sweep")
    }

    /// **The advisor's own refinement**: a VALID pair whose sidecar is no newer than the real file
    /// (the app crashed after a clean save/close should already have cleared this, or the real file
    /// was independently saved after the crash) has nothing left to recover — swept, not kept
    /// forever for a `checkRecoveryCandidate` that would refuse it anyway.
    func testSweepRemovesAValidPairWhoseSidecarIsNoNewerThanTheRealFile() throws {
        let autosaveDir = makeScratchDirectory()
        let realPath = makeScratchDirectory().appendingPathComponent("notes.odt")
        try "newer".write(to: realPath, atomically: true, encoding: .utf8)
        setModificationDate(Date(timeIntervalSince1970: 1_000_060), atPath: realPath.path)
        let sidecarPath = autosaveDir.appendingPathComponent("doc-a.odt")
        try "stale".write(to: sidecarPath, atomically: true, encoding: .utf8)
        setModificationDate(Date(timeIntervalSince1970: 1_000_000), atPath: sidecarPath.path)
        OfficeRuntime.recordAutosaveManifest(realPath: realPath.path, docId: "doc-a", ext: "odt",
                                             isODFFallback: false, autosaveDirectory: autosaveDir)

        OfficeRuntime.sweepAutosaveOrphans(autosaveDirectory: autosaveDir)

        XCTAssertEqual(autosaveDirectoryContents(autosaveDir), [], "a resolved pair — nothing left to recover")
    }

    /// A manifest whose own real path no longer exists AT ALL (the source document was deleted or
    /// moved and will never be reopened at this path again) is conservatively swept along with its
    /// sidecar, rather than kept forever — see `sweepAutosaveOrphans`'s own header.
    func testSweepRemovesAPairWhoseRealPathNoLongerExists() throws {
        let autosaveDir = makeScratchDirectory()
        let goneRealPath = makeScratchDirectory().appendingPathComponent("deleted-source.odt").path
        let sidecarPath = autosaveDir.appendingPathComponent("doc-a.odt")
        try "orphaned-by-a-deleted-source".write(to: sidecarPath, atomically: true, encoding: .utf8)
        OfficeRuntime.recordAutosaveManifest(realPath: goneRealPath, docId: "doc-a", ext: "odt",
                                             isODFFallback: false, autosaveDirectory: autosaveDir)

        OfficeRuntime.sweepAutosaveOrphans(autosaveDirectory: autosaveDir)

        XCTAssertEqual(autosaveDirectoryContents(autosaveDir), [])
    }

    /// A directory that does not exist at all (never autosaved to this boot) must never throw or
    /// crash — the identical best-effort posture every other sweep in this codebase states.
    func testSweepIsASafeNoOpWhenTheDirectoryDoesNotExist() {
        let autosaveDir = makeScratchDirectory().appendingPathComponent("never-created", isDirectory: true)
        OfficeRuntime.sweepAutosaveOrphans(autosaveDirectory: autosaveDir) // must not throw/crash
    }

    /// A composite scenario, closest to what a real crashed-then-relaunched boot actually looks
    /// like: one genuinely live pair, one orphan sidecar, one orphan manifest, and a torn temp file
    /// all in the SAME directory at once — only the live pair survives.
    func testSweepInAMixedDirectoryKeepsOnlyTheLivePair() throws {
        let autosaveDir = makeScratchDirectory()
        let liveRealPath = makeScratchDirectory().appendingPathComponent("live.odt")
        try "old".write(to: liveRealPath, atomically: true, encoding: .utf8)
        setModificationDate(Date(timeIntervalSince1970: 1_000_000), atPath: liveRealPath.path)
        let liveSidecar = autosaveDir.appendingPathComponent("live-doc.odt")
        try "recovered".write(to: liveSidecar, atomically: true, encoding: .utf8)
        setModificationDate(Date(timeIntervalSince1970: 1_000_060), atPath: liveSidecar.path)
        OfficeRuntime.recordAutosaveManifest(realPath: liveRealPath.path, docId: "live-doc", ext: "odt",
                                             isODFFallback: false, autosaveDirectory: autosaveDir)

        try "orphan sidecar, no manifest".write(to: autosaveDir.appendingPathComponent("orphan-doc.ods"),
                                                atomically: true, encoding: .utf8)
        try "torn".write(to: autosaveDir.appendingPathComponent(".tmp-dead-\(UUID().uuidString).odt"),
                         atomically: true, encoding: .utf8)
        let orphanRealPath = makeScratchDirectory().appendingPathComponent("orphan-manifest-source.odt")
        try "content".write(to: orphanRealPath, atomically: true, encoding: .utf8)
        let orphanManifestSidecar = autosaveDir.appendingPathComponent("orphan-manifest-doc.odt")
        try "sidecar".write(to: orphanManifestSidecar, atomically: true, encoding: .utf8)
        OfficeRuntime.recordAutosaveManifest(realPath: orphanRealPath.path, docId: "orphan-manifest-doc", ext: "odt",
                                             isODFFallback: false, autosaveDirectory: autosaveDir)
        try FileManager.default.removeItem(at: orphanManifestSidecar) // its own sidecar now gone

        OfficeRuntime.sweepAutosaveOrphans(autosaveDirectory: autosaveDir)

        let remaining = autosaveDirectoryContents(autosaveDir)
        XCTAssertEqual(remaining.count, 2, "exactly the live pair's own two files: \(remaining)")
        XCTAssertTrue(remaining.contains("live-doc.odt"))
        XCTAssertNotNil(OfficeRuntime.checkRecoveryCandidate(realPath: liveRealPath.path, autosaveDirectory: autosaveDir))
    }

}

// MARK: - office-live-edit R3 — OfficeUndoLedger
//
// The ledger is what makes "one tool call = one undo step" true. It is a pure value type on
// purpose: every rule below is a claim about arithmetic over the engine's own reported stack depth,
// with no LOK, no actor and no clock, so each one can be broken individually and watched go red.

final class OfficeUndoLedgerTests: XCTestCase {

    /// The baseline nobody should be able to regress silently: with nothing recorded, ⌘Z is exactly
    /// what it always was — one engine action per press.
    func testWithNothingRecordedOneUndoTakesBackOneAction() {
        var ledger = OfficeUndoLedger()
        XCTAssertEqual(ledger.undoStepSize(undoDepth: 5), 1)
        XCTAssertEqual(ledger.undoStepSize(undoDepth: 1), 1)
    }

    /// And it never asks the engine to undo something that is not there.
    func testAnEmptyStackAsksForNoUndoAtAll() {
        var ledger = OfficeUndoLedger()
        XCTAssertEqual(ledger.undoStepSize(undoDepth: 0), 0)
        XCTAssertEqual(ledger.redoStepSize(redoDepth: 0), 0)
    }

    /// The whole point: an agent call that made 3 engine actions collapses to ONE ⌘Z.
    func testAnAgentGroupCollapsesToOneUndoPress() {
        var ledger = OfficeUndoLedger()
        ledger.recordAgentEdit(topDepth: 4, count: 3)   // user had 1 action, agent added 3
        XCTAssertEqual(ledger.undoStepSize(undoDepth: 4), 3)
    }

    /// 🔑 **The invariant.** The user typed after the agent's call, so the agent's group is no longer
    /// the top of the stack — and ⌘Z must take back the USER's one action, not reach past it into
    /// the agent's group. This is the assertion that would go red if the ledger ever trusted a
    /// remembered count without checking the engine's depth against it.
    func testAUserEditAfterAnAgentCallPutsCMDZBackToOneAction() {
        var ledger = OfficeUndoLedger()
        ledger.recordAgentEdit(topDepth: 4, count: 3)
        XCTAssertEqual(ledger.undoStepSize(undoDepth: 5), 1,
                       "the stack is deeper than the agent's group, so the group is not on top")
    }

    /// The other half of that invariant, and the reason it is stated as "depth is the arbiter"
    /// rather than "invalidate on a user edit": once the user undoes their OWN edit, the agent's
    /// group IS the top again, and the group must come back into play. An implementation that
    /// invalidated on a user edit would get this wrong and would look correct while doing so.
    func testUndoingTheUsersOwnEditReExposesTheAgentGroupUnderneath() {
        var ledger = OfficeUndoLedger()
        ledger.recordAgentEdit(topDepth: 4, count: 3)
        XCTAssertEqual(ledger.undoStepSize(undoDepth: 5), 1)     // the user's own action
        XCTAssertEqual(ledger.undoStepSize(undoDepth: 4), 3,     // now the agent's group is on top
                       "the agent's group is on top again and one press must take all of it back")
    }

    /// Two agent calls come off one at a time, each whole, in reverse order.
    func testTwoAgentGroupsComeOffOneAtATimeInReverseOrder() {
        var ledger = OfficeUndoLedger()
        ledger.recordAgentEdit(topDepth: 2, count: 2)
        ledger.recordAgentEdit(topDepth: 5, count: 3)
        XCTAssertEqual(ledger.undoStepSize(undoDepth: 5), 3)
        ledger.didUndo(count: 3, undoDepth: 2, redoDepth: 3)
        XCTAssertEqual(ledger.undoStepSize(undoDepth: 2), 2)
    }

    /// A tool call that changed nothing must not leave a ⌘Z step behind it. Otherwise a user
    /// pressing ⌘Z after a no-op agent call would silently lose an edit of their own.
    func testACallThatChangedNothingRecordsNoStep() {
        var ledger = OfficeUndoLedger()
        ledger.recordAgentEdit(topDepth: 3, count: 0)
        XCTAssertTrue(ledger.pendingUndo.isEmpty)
        XCTAssertEqual(ledger.undoStepSize(undoDepth: 3), 1)
    }

    /// A group can never ask for more undos than the stack actually holds — that would send
    /// dispatches into an empty stack and, with Repair on, is exactly how a ⌘Z could eat an edit
    /// nobody asked it to.
    func testAStepIsClampedToWhatTheStackActuallyHolds() {
        var ledger = OfficeUndoLedger()
        ledger.recordAgentEdit(topDepth: 3, count: 3)
        XCTAssertEqual(ledger.undoStepSize(undoDepth: 3), 3)
        // The stack shrank underneath us (a reload, a truncation): the group no longer describes it.
        var other = OfficeUndoLedger()
        other.recordAgentEdit(topDepth: 9, count: 4)
        XCTAssertEqual(other.undoStepSize(undoDepth: 2), 1,
                       "a group recorded above the stack's real depth is pruned, not clamped-and-used")
    }

    /// Redo is the mirror, and it matters: without it a repair-undone group would be redone one
    /// action per press, so the user's ⌘⇧Z would not put back what their ⌘Z took away.
    func testRedoPutsTheWholeGroupBackInOnePress() {
        var ledger = OfficeUndoLedger()
        ledger.recordAgentEdit(topDepth: 4, count: 3)
        XCTAssertEqual(ledger.undoStepSize(undoDepth: 4), 3)
        ledger.didUndo(count: 3, undoDepth: 1, redoDepth: 3)
        XCTAssertEqual(ledger.redoStepSize(redoDepth: 3), 3)
        ledger.didRedo(count: 3, undoDepth: 4, redoDepth: 0)
        XCTAssertEqual(ledger.undoStepSize(undoDepth: 4), 3,
                       "and back again — the group survives a full undo/redo round trip")
    }

    /// A new edit clears the engine's redo stack, so anything remembered about it is void.
    func testANewAgentEditForgetsTheRedoSide() {
        var ledger = OfficeUndoLedger()
        ledger.recordAgentEdit(topDepth: 2, count: 2)
        ledger.didUndo(count: 2, undoDepth: 0, redoDepth: 2)
        XCTAssertFalse(ledger.pendingRedo.isEmpty)
        ledger.recordAgentEdit(topDepth: 1, count: 1)
        XCTAssertTrue(ledger.pendingRedo.isEmpty)
    }

    /// A stale redo group whose depth no longer matches is pruned rather than used — the same rule
    /// as the undo side, asserted separately because they are separate code paths.
    func testAStaleRedoGroupIsPrunedNotUsed() {
        var ledger = OfficeUndoLedger()
        ledger.recordAgentEdit(topDepth: 3, count: 3)
        _ = ledger.undoStepSize(undoDepth: 3)
        ledger.didUndo(count: 3, undoDepth: 0, redoDepth: 3)
        XCTAssertEqual(ledger.redoStepSize(redoDepth: 1), 1,
                       "the redo stack is shallower than the group — the group cannot be on top of it")
    }

    /// **Review F-5 — the pop is keyed on DEPTH as well as size.** A 1-action agent group must
    /// survive a ⌘Z that took back the USER's own later single edit. Matching on size alone popped
    /// it (the fallback returns 1, so `top.count == 1` matched) and silently discarded a group that
    /// had never been used. The outcome was identical for a 1-action group, so nothing was
    /// observably broken — which is exactly why it needs a test rather than a comment.
    func testAOneActionAgentGroupSurvivesAnUndoOfTheUsersOwnLaterEdit() {
        var ledger = OfficeUndoLedger()
        ledger.recordAgentEdit(topDepth: 3, count: 1)   // the agent's single-action group at depth 3
        // The user then types: depth 4. One ⌘Z takes back THEIR action, leaving depth 3.
        XCTAssertEqual(ledger.undoStepSize(undoDepth: 4), 1)
        ledger.didUndo(count: 1, undoDepth: 3, redoDepth: 1)
        XCTAssertEqual(ledger.pendingUndo.count, 1,
                       "the agent's group was NOT the thing undone — it must still be remembered")
        XCTAssertEqual(ledger.pendingUndo.last?.topDepth, 3)
        // And it is still usable: the next ⌘Z is now against the agent's group.
        XCTAssertEqual(ledger.undoStepSize(undoDepth: 3), 1)
    }

    /// Closing or reloading the document must void everything: a stale group would make one ⌘Z take
    /// back MORE than the user asked for, which is worse than taking back less.
    func testForgettingVoidsBothSides() {
        var ledger = OfficeUndoLedger()
        ledger.recordAgentEdit(topDepth: 3, count: 3)
        ledger.didUndo(count: 3, undoDepth: 0, redoDepth: 3)
        ledger.forgetEverything()
        XCTAssertTrue(ledger.pendingUndo.isEmpty)
        XCTAssertTrue(ledger.pendingRedo.isEmpty)
        XCTAssertEqual(ledger.undoStepSize(undoDepth: 3), 1)
    }
}
