import XCTest
@testable import Norma

/// Office Stage B Task 5 — `OfficeCursorStore`: pure fold tests (mirrors `OfficeTileStoreTests`'
/// own shape for the sibling store), plus one integration test proving `OfficeRuntime.handle
/// (documentEvent:docId:)` resolves `activePart` from the SAME `DocumentEntry.activePart` the input
/// verbs read, rather than defaulting or guessing.
///
/// `@MainActor` — `OfficeRuntime` itself is main-actor-isolated (mirrors `OfficeRuntimeWatcherTests`'
/// own identical annotation, same file, for the same reason: the integration tests below construct
/// and drive a real one).
@MainActor
final class OfficeCursorStoreTests: XCTestCase {

    // MARK: - Pure fold tests

    func testCaretRectFoldsAndStampsThePassedInActivePart() {
        let store = OfficeCursorStore()
        var signaled: [String] = []
        let sink = store.cursorChanged.sink { signaled.append($0) }
        defer { sink.cancel() }

        let rect = OfficeTwipsRect(x: 100, y: 200, width: 0, height: 300)
        store.apply(docId: "doc-1", event: .caretRect(rect), activePart: 2)

        let state = store.state(docId: "doc-1")
        XCTAssertEqual(state.caretRectTwips, rect)
        XCTAssertEqual(state.caretPart, 2)
        XCTAssertEqual(signaled, ["doc-1"])
    }

    func testTextSelectionFoldsTheFullRectListAndEmptySelectionClearsIt() {
        let store = OfficeCursorStore()
        let rects = [OfficeTwipsRect(x: 0, y: 0, width: 10, height: 10), OfficeTwipsRect(x: 0, y: 20, width: 5, height: 10)]
        store.apply(docId: "doc-1", event: .textSelection(rects), activePart: 0)
        XCTAssertEqual(store.state(docId: "doc-1").selectionRectsTwips, rects)

        store.apply(docId: "doc-1", event: .textSelection([]), activePart: 0)
        XCTAssertEqual(store.state(docId: "doc-1").selectionRectsTwips, [], "an empty selection clears the previous rects")
    }

    func testTextSelectionStartAndEndFoldIndependentlyOfTextSelectionItself() {
        let store = OfficeCursorStore()
        let start = OfficeTwipsRect(x: 1, y: 2, width: 0, height: 3)
        let end = OfficeTwipsRect(x: 4, y: 5, width: 0, height: 6)
        store.apply(docId: "doc-1", event: .textSelectionStart(start), activePart: 0)
        store.apply(docId: "doc-1", event: .textSelectionEnd(end), activePart: 0)
        let state = store.state(docId: "doc-1")
        XCTAssertEqual(state.selectionStartRectTwips, start)
        XCTAssertEqual(state.selectionEndRectTwips, end)
    }

    func testCellCursorFoldsBothShapes() {
        let store = OfficeCursorStore()
        let rect = OfficeTwipsRect(x: 0, y: 0, width: 1265, height: 254)
        store.apply(docId: "doc-1", event: .cellCursor(.at(rectTwips: rect, column: 2, row: 7)), activePart: 0)
        XCTAssertEqual(store.state(docId: "doc-1").cellCursor, .at(rectTwips: rect, column: 2, row: 7))
        XCTAssertEqual(store.state(docId: "doc-1").cellCursorPart, 0)

        store.apply(docId: "doc-1", event: .cellCursor(.empty), activePart: 0)
        XCTAssertEqual(store.state(docId: "doc-1").cellCursor, .empty, "entering in-cell edit mode replaces the prior cell rect with .empty")
    }

    /// Task 8 — the formula bar's own content feed. Independent of `cellCursor`'s own fold (a
    /// SEPARATE field pair, not a derived one): the live probe found `CELL_FORMULA` fires with its
    /// own ordering relative to `CELL_CURSOR` (content before ref on a plain navigate, ref-goes-
    /// EMPTY before content on entering in-cell edit — see `OfficeHelperLiveTests
    /// .testProbeInvestigatesWhetherCellFormulaCallbacksExistForTheFormulaBarsContent`'s own
    /// header), so folding it into `cellCursor` itself would silently mix two independently-timed
    /// LOK callbacks into one field.
    func testCellFormulaFoldsAndStampsThePassedInActivePart() {
        let store = OfficeCursorStore()
        var signaled: [String] = []
        let sink = store.cursorChanged.sink { signaled.append($0) }
        defer { sink.cancel() }

        store.apply(docId: "doc-1", event: .cellFormula("NORMA GATE"), activePart: 1)
        var state = store.state(docId: "doc-1")
        XCTAssertEqual(state.cellFormulaText, "NORMA GATE")
        XCTAssertEqual(state.cellFormulaPart, 1)
        XCTAssertEqual(signaled, ["doc-1"])

        // A genuinely empty cell's own real shape — the empty string, not left stale from A1.
        store.apply(docId: "doc-1", event: .cellFormula(""), activePart: 1)
        state = store.state(docId: "doc-1")
        XCTAssertEqual(state.cellFormulaText, "", "an empty cell's own real payload must overwrite the previous cell's text, never linger")
    }

    /// `.opened`/`.openFailed`/`.invalidated`/`.modifiedChanged`/`.closed` are not this store's
    /// concern (the reducer/`tileStore` own them) — `apply` must be a documented no-op for all five,
    /// never a mutation and never a signal.
    func testNonCursorEventsAreANoOp() {
        let store = OfficeCursorStore()
        var signaled = 0
        let sink = store.cursorChanged.sink { _ in signaled += 1 }
        defer { sink.cancel() }

        store.apply(docId: "doc-1", event: .modifiedChanged(true), activePart: 0)
        store.apply(docId: "doc-1", event: .closed, activePart: 0)
        store.apply(docId: "doc-1", event: .invalidated(rectsTwips: [], part: 0), activePart: 0)

        XCTAssertEqual(store.state(docId: "doc-1"), OfficeCursorStore.State(), "no mutation for any of the five reducer/tileStore-owned cases")
        XCTAssertEqual(signaled, 0, "no signal either — a subscriber must never wake up for nothing")
    }

    func testStateForAnUnknownDocIdIsTheEmptyDefaultNeverATrap() {
        let store = OfficeCursorStore()
        XCTAssertEqual(store.state(docId: "never-seen"), OfficeCursorStore.State())
    }

    func testEvictRemovesOnlyTheNamedDocIdLeavingOthersUntouched() {
        let store = OfficeCursorStore()
        store.apply(docId: "doc-1", event: .caretRect(OfficeTwipsRect(x: 1, y: 1, width: 0, height: 1)), activePart: 0)
        store.apply(docId: "doc-2", event: .caretRect(OfficeTwipsRect(x: 2, y: 2, width: 0, height: 2)), activePart: 0)

        store.evict(docId: "doc-1")

        XCTAssertEqual(store.state(docId: "doc-1"), OfficeCursorStore.State(), "doc-1's own state is gone")
        XCTAssertNotEqual(store.state(docId: "doc-2"), OfficeCursorStore.State(), "doc-2 is untouched")
    }

    func testEvictEverythingClearsEveryDocId() {
        let store = OfficeCursorStore()
        store.apply(docId: "doc-1", event: .caretRect(OfficeTwipsRect(x: 1, y: 1, width: 0, height: 1)), activePart: 0)
        store.apply(docId: "doc-2", event: .caretRect(OfficeTwipsRect(x: 2, y: 2, width: 0, height: 2)), activePart: 0)

        store.evictEverything()

        XCTAssertEqual(store.state(docId: "doc-1"), OfficeCursorStore.State())
        XCTAssertEqual(store.state(docId: "doc-2"), OfficeCursorStore.State())
    }

    // MARK: - Integration: OfficeRuntime.handle(documentEvent:docId:) resolves activePart, never guesses

    private var integrationScratchDirs: [URL] = []
    private var integrationRuntimes: [OfficeRuntime] = []

    override func tearDown() {
        for runtime in integrationRuntimes { runtime.teardown() }
        integrationRuntimes.removeAll()
        for dir in integrationScratchDirs { try? FileManager.default.removeItem(at: dir) }
        integrationScratchDirs.removeAll()
        super.tearDown()
    }

    private func waitUntil(timeout: TimeInterval = 2, _ condition: () -> Bool) async -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition() {
            if Date() >= deadline { return false }
            try? await Task.sleep(nanoseconds: 5_000_000)
        }
        return true
    }

    /// A real `OfficeRuntime`, a fake always-succeeding `Driver` — the same minimal shape
    /// `OfficeRuntimeWatcherTests.makeDriver`/`OfficeHelperRequestQueueTests` already establish for
    /// this exact purpose (proving `OfficeRuntime`'s own logic, never touching a real helper process).
    private func makeRuntime(parts: Int) -> OfficeRuntime {
        let stateDir = URL(fileURLWithPath: "/tmp/office-cursor-store-state-\(UUID().uuidString.prefix(8))", isDirectory: true)
        integrationScratchDirs.append(stateDir)
        let metadata = OfficeDocumentMetadata(type: .spreadsheet, parts: parts,
                                               sizeTwips: OfficeDocumentSize(widthTwips: 100_000, heightTwips: 100_000))
        let driver = OfficeRuntime.Driver(
            helperState: { .ready }, startHelper: { },
            open: { _, _ in metadata },
            close: { _ in },
            save: { _, _ in "/tmp/office-cursor-store-unused-save" },
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
            sheetsManageSheetBatch: { _, _ in throw OfficeHelperClientError.serverError(reason: "fake driver: sheets batch not implemented") },
            sheetsFormat: { _, _, _, _, _, _, _, _, _ in throw OfficeHelperClientError.serverError(reason: "fake driver: sheets not implemented") },
            slidesInfo: { _ in throw OfficeHelperClientError.serverError(reason: "fake driver: slides not implemented") },
            slidesRead: { _, _ in throw OfficeHelperClientError.serverError(reason: "fake driver: slides not implemented") },
            slidesSetText: { _, _, _, _ in throw OfficeHelperClientError.serverError(reason: "fake driver: slides not implemented") },
            slidesManagePage: { _, _, _, _, _, _ in throw OfficeHelperClientError.serverError(reason: "fake driver: slides not implemented") },
            slidesManagePageBatch: { _, _ in throw OfficeHelperClientError.serverError(reason: "fake driver: slides batch not implemented") },
            docsInfo: { _ in throw OfficeHelperClientError.serverError(reason: "fake driver: docs not implemented") },
            docsRead: { _ in throw OfficeHelperClientError.serverError(reason: "fake driver: docs not implemented") },
            docsReplace: { _, _, _ in throw OfficeHelperClientError.serverError(reason: "fake driver: docs not implemented") },
            docsInsert: { _, _, _, _ in throw OfficeHelperClientError.serverError(reason: "fake driver: docs not implemented") },
            stateDirectory: stateDir)
        let runtime = OfficeRuntime(sessionId: "S1", driver: driver)
        integrationRuntimes.append(runtime)
        return runtime
    }

    private func scratchFile() throws -> String {
        let dir = URL(fileURLWithPath: "/tmp/office-cursor-store-\(UUID().uuidString.prefix(8))", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        integrationScratchDirs.append(dir)
        let file = dir.appendingPathComponent("gate.ods")
        try "seed".write(to: file, atomically: true, encoding: .utf8)
        return file.path
    }

    /// **The load-bearing claim**: a caret/selection/cell-cursor event arriving AFTER a part switch
    /// is stamped with the NEW part, not 0 and not stale — `handle(documentEvent:docId:)` reads
    /// `state.documents[path]?.activePart` fresh, at fold time, exactly like `.modifiedStatusChanged`'s
    /// own docId->path resolution one arm over.
    func testCaretEventIsStampedWithTheDocumentsCurrentActivePartNotZero() async throws {
        let path = try scratchFile()
        let runtime = makeRuntime(parts: 3)
        runtime.open(path)
        let opened = await waitUntil { runtime.stateSnapshot.documents[path] != nil }
        XCTAssertTrue(opened, "setup: the document must open before this test can subscribe/fold anything")
        let docId = try XCTUnwrap(runtime.stateSnapshot.documents[path]?.docId)

        runtime.subscribeTiles(path: path, part: 2, zoomPPT: 1000, viewportTwips: OfficeTwipsRect(x: 0, y: 0, width: 100, height: 100))
        let partMoved = await waitUntil { runtime.stateSnapshot.documents[path]?.activePart == 2 }
        XCTAssertTrue(partMoved, "setup: activePart must actually move to 2 before this test means anything")

        runtime.handle(documentEvent: .caretRect(OfficeTwipsRect(x: 10, y: 20, width: 0, height: 30)), docId: docId)

        XCTAssertEqual(runtime.cursorStore.state(docId: docId).caretPart, 2,
                       "the caret event must be stamped with the CURRENT activePart (2), not 0 and not the part at open time")
    }

    /// The eviction half — proven directly against the runtime's own `cursorStore`, mirroring how
    /// `OfficeTileStore` eviction is proven at the `OfficeRuntime` level elsewhere in this suite
    /// (never merely at the bare-store level, which would miss a forgotten call site).
    func testClosingADocumentEvictsItsCursorState() async throws {
        let path = try scratchFile()
        let runtime = makeRuntime(parts: 1)
        runtime.open(path)
        let opened = await waitUntil { runtime.stateSnapshot.documents[path] != nil }
        XCTAssertTrue(opened)
        let docId = try XCTUnwrap(runtime.stateSnapshot.documents[path]?.docId)

        runtime.handle(documentEvent: .caretRect(OfficeTwipsRect(x: 1, y: 1, width: 0, height: 1)), docId: docId)
        XCTAssertNotEqual(runtime.cursorStore.state(docId: docId), OfficeCursorStore.State(), "setup: something is there to evict")

        runtime.close(path)
        let closed = await waitUntil { runtime.stateSnapshot.documents[path] == nil }
        XCTAssertTrue(closed)
        XCTAssertEqual(runtime.cursorStore.state(docId: docId), OfficeCursorStore.State(), "close must evict cursorStore, mirroring tileStore")
    }
}
