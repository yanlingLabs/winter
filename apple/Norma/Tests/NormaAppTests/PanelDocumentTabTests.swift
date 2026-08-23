import AppKit
import NormaKit
import XCTest
@testable import Norma

/// office-plumbing Task 6 — `PanelDocumentTabModel`/`PanelDocumentTabModels`: the registry, the pure
/// viewport-plan/part-strip/door decisions, and the model's own lifecycle (lazy open, the
/// failed-vs-idle gate). Mirrors `EditorTabTests`'/`PanelFilesTabTests`' own posture: every decision
/// is driven directly with no `NSWindow`, no `ShellPanel`, no real office helper — the canvas's own
/// LOOK is the live gate (`OfficeRuntimeLiveTests`), matching this house's standing rule for every
/// other viewport in the panel.
@MainActor
final class PanelDocumentTabTests: XCTestCase {
    /// **Office Stage B Task 2b test fallout**: `OfficeRuntime.open` now genuinely STAGES (copies)
    /// its argument before ever reaching a driver — every test below that opens through a REAL
    /// `OfficeRuntime` (via `makeHost`) needs a real, readable file, or the copy fails and the
    /// document never reaches `documents[path]` (the driver's own `open` closure is never even
    /// called). The many PURE `officeDocumentViewportPlan`/`documentState`-driven tests above never
    /// touch a runtime at all and are untouched by this — only the small set of tests that actually
    /// call `model.activate()`/`runtime.open(...)` through `makeHost` use these.
    private var scratchDir: URL!
    private var realAPath: String { scratchDir.appendingPathComponent("a.xlsx").path }
    private var realGatePath: String { scratchDir.appendingPathComponent("gate.xlsx").path }
    private var stateDir: URL!

    override func setUp() {
        super.setUp()
        doubles = []
        runtimes = []
        scratchDir = URL(fileURLWithPath: "/tmp/paneldocumenttab-\(UUID().uuidString.prefix(8))", isDirectory: true)
        try? FileManager.default.createDirectory(at: scratchDir, withIntermediateDirectories: true)
        try? Data().write(to: URL(fileURLWithPath: realAPath))
        try? Data().write(to: URL(fileURLWithPath: realGatePath))
        stateDir = URL(fileURLWithPath: "/tmp/paneldocumenttab-state-\(UUID().uuidString.prefix(8))", isDirectory: true)
        try? FileManager.default.createDirectory(at: stateDir, withIntermediateDirectories: true)
    }

    override func tearDown() {
        PanelDocumentTabModels.removeAllForTesting()
        try? FileManager.default.removeItem(at: scratchDir)
        try? FileManager.default.removeItem(at: stateDir)
        scratchDir = nil
        stateDir = nil
        super.tearDown()
    }

    // MARK: - Fixtures

    private func tileKey(_ x: Int, _ y: Int, part: Int = 0, zoomPPT: Int = 1000) -> TileKey {
        TileKey(part: part, zoomPPT: zoomPPT, tileX: x, tileY: y)
    }

    private let sizeTwips = OfficeDocumentSize(widthTwips: 100_000, heightTwips: 100_000)

    private func documentState(path: String, docId: String = "doc-1", type: OfficeDocumentKind = .text,
                               parts: Int = 1, activePart: Int = 0) -> OfficeRuntimeState {
        var state = OfficeRuntimeState()
        state.phase = .ready
        state.documents[path] = OfficeRuntimeState.DocumentEntry(
            docId: docId, stagedPath: "/staged/\(docId)", type: type, parts: parts, activePart: activePart,
            sizeTwips: sizeTwips)
        return state
    }

    private func failedState(reason: String? = "the office helper stopped unexpectedly.") -> OfficeRuntimeState {
        var state = OfficeRuntimeState()
        state.phase = .failed
        state.failureReason = reason
        return state
    }

    // MARK: - Pure: officeDocumentViewportPlan

    func testNoPathRendersNoFile() {
        XCTAssertEqual(officeDocumentViewportPlan(path: nil, state: OfficeRuntimeState(), hasRequestedOpen: false),
                       .renderState(.noFile))
        XCTAssertEqual(officeDocumentViewportPlan(path: "", state: OfficeRuntimeState(), hasRequestedOpen: false),
                       .renderState(.noFile))
    }

    func testNoRuntimeStateRendersBooting() {
        XCTAssertEqual(officeDocumentViewportPlan(path: "/a.xlsx", state: nil, hasRequestedOpen: false),
                       .renderState(.booting))
    }

    func testAnOpenDocumentShowsTheCanvasWithEveryFieldCarriedThrough() {
        let state = documentState(path: "/a.xlsx", docId: "d1", type: .spreadsheet, parts: 3, activePart: 2)
        XCTAssertEqual(officeDocumentViewportPlan(path: "/a.xlsx", state: state, hasRequestedOpen: true),
                       .showCanvas(path: "/a.xlsx", docId: "d1", type: .spreadsheet, parts: 3,
                                  sizeTwips: sizeTwips, activePart: 2))
    }

    /// A model wins over `.failed` even when (unreachable in practice — the reducer always wipes
    /// `documents` in the same transition it sets `.failed`) both are somehow present — the explicit
    /// precedence `officeDocumentViewportPlan`'s own doc states.
    func testADocumentWinsOverAFailedPhaseEvenIfBothWereSomehowPresent() {
        var state = documentState(path: "/a.xlsx")
        state.phase = .failed
        state.failureReason = "irrelevant"
        XCTAssertNotEqual(officeDocumentViewportPlan(path: "/a.xlsx", state: state, hasRequestedOpen: true),
                          .renderState(.failed(reason: "irrelevant")))
    }

    /// Obligation 5, the pristine over-delivery case: `.failed` arrives before THIS tab has ever
    /// asked anything — rendered as `.booting`, never a scary sentence for a tab that did not fail
    /// at anything (it never tried).
    func testFailedPhaseWithNoRequestedOpenYetRendersBootingNotFailed() {
        let state = failedState()
        XCTAssertEqual(officeDocumentViewportPlan(path: "/a.xlsx", state: state, hasRequestedOpen: false),
                       .renderState(.booting))
    }

    /// The genuine case: this tab DID ask, and the runtime is `.failed` — the Reopen affordance.
    func testFailedPhaseAfterThisTabAskedRendersFailedWithTheReason() {
        let state = failedState(reason: "the office helper stopped unexpectedly.")
        XCTAssertEqual(officeDocumentViewportPlan(path: "/a.xlsx", state: state, hasRequestedOpen: true),
                       .renderState(.failed(reason: "the office helper stopped unexpectedly.")))
    }

    /// Should be unreachable (the reducer always sets a reason) — the fallback sentence, never an
    /// empty one.
    func testFailedPhaseWithNoReasonUsesTheFallbackSentence() {
        let state = failedState(reason: nil)
        XCTAssertEqual(officeDocumentViewportPlan(path: "/a.xlsx", state: state, hasRequestedOpen: true),
                       .renderState(.failed(reason: officeDocumentUnknownFailureReason)))
    }

    func testAPerDocumentOpenFailureRendersOpenFailed() {
        var state = OfficeRuntimeState()
        state.phase = .ready
        state.openFailures["/bad.docx"] = "garbage file"
        XCTAssertEqual(officeDocumentViewportPlan(path: "/bad.docx", state: state, hasRequestedOpen: true),
                       .renderState(.openFailed(path: "/bad.docx", reason: "garbage file")))
    }

    func testReadyWithNoDocumentAndNoFailureRendersBooting() {
        var state = OfficeRuntimeState()
        state.phase = .ready
        XCTAssertEqual(officeDocumentViewportPlan(path: "/a.xlsx", state: state, hasRequestedOpen: false),
                       .renderState(.booting))
    }

    func testStartingPhaseRendersBooting() {
        var state = OfficeRuntimeState()
        state.phase = .starting
        state.pendingOpens = ["/a.xlsx"]
        XCTAssertEqual(officeDocumentViewportPlan(path: "/a.xlsx", state: state, hasRequestedOpen: true),
                       .renderState(.booting))
    }

    // MARK: - Pure: officeColumnLetters / officeCellReference (Task 8: the formula bar's own A1-style ref)

    /// Bijective base-26 — NOT ordinary base-26 (there is no digit for zero: column 26 is "AA",
    /// never "A0"). Every named boundary: single letters, the Z→AA rollover, the last two-letter
    /// column, the AZ→BA rollover, and the two-letter→three-letter rollover.
    func testOfficeColumnLettersCoversSingleDoubleAndTripleLetterBoundaries() {
        XCTAssertEqual(officeColumnLetters(0), "A")
        XCTAssertEqual(officeColumnLetters(1), "B")
        XCTAssertEqual(officeColumnLetters(25), "Z")
        XCTAssertEqual(officeColumnLetters(26), "AA")
        XCTAssertEqual(officeColumnLetters(27), "AB")
        XCTAssertEqual(officeColumnLetters(51), "AZ")
        XCTAssertEqual(officeColumnLetters(52), "BA")
        XCTAssertEqual(officeColumnLetters(701), "ZZ")
        XCTAssertEqual(officeColumnLetters(702), "AAA")
    }

    /// `officeCellReference` is `officeColumnLetters` plus the row, 1-based from the user's own
    /// point of view — CELL_CURSOR's `(column, row)` are both 0-based (`OfficeCellCursor.at`'s own
    /// doc), so A1 is `(column: 0, row: 0)`.
    func testOfficeCellReferenceJoinsColumnLettersAndOneBasedRow() {
        XCTAssertEqual(officeCellReference(column: 0, row: 0), "A1")
        XCTAssertEqual(officeCellReference(column: 1, row: 0), "B1")
        XCTAssertEqual(officeCellReference(column: 0, row: 9), "A10")
        XCTAssertEqual(officeCellReference(column: 26, row: 99), "AA100")
    }

    // MARK: - Pure: officeColumnIndex(fromLetters:) / officeParseCellReference / officeParseRange
    // (office-agent-tools T3 — the INVERSE of officeColumnLetters/officeCellReference above, needed
    // to turn `sheets read`'s own A1-string `range` operand into 0-based indices LOK can use.
    // "Reuse the A1 conversion Stage B T8 already built, do not write a second one" — this is that
    // reuse: every boundary pinned here is the identical bijective-base-26 boundary the forward
    // conversion already pins, walked backwards.)

    func testOfficeColumnIndexInvertsOfficeColumnLettersAtEveryBoundary() {
        XCTAssertEqual(officeColumnIndex(fromLetters: "A"), 0)
        XCTAssertEqual(officeColumnIndex(fromLetters: "B"), 1)
        XCTAssertEqual(officeColumnIndex(fromLetters: "Z"), 25)
        XCTAssertEqual(officeColumnIndex(fromLetters: "AA"), 26)
        XCTAssertEqual(officeColumnIndex(fromLetters: "AB"), 27)
        XCTAssertEqual(officeColumnIndex(fromLetters: "AZ"), 51)
        XCTAssertEqual(officeColumnIndex(fromLetters: "BA"), 52)
        XCTAssertEqual(officeColumnIndex(fromLetters: "ZZ"), 701)
        XCTAssertEqual(officeColumnIndex(fromLetters: "AAA"), 702)
    }

    /// Round-trips a wide sample through BOTH directions — the strongest single proof that the
    /// inverse actually inverts, not just that the two happen to agree at the hand-picked boundaries
    /// above.
    func testOfficeColumnIndexRoundTripsWithOfficeColumnLettersAcrossAWideRange() {
        for column in 0..<1500 {
            let letters = officeColumnLetters(column)
            XCTAssertEqual(officeColumnIndex(fromLetters: letters), column,
                           "officeColumnLetters(\(column)) = \"\(letters)\" must invert back to \(column)")
        }
    }

    func testOfficeColumnIndexIsCaseInsensitive() {
        XCTAssertEqual(officeColumnIndex(fromLetters: "aa"), 26)
        XCTAssertEqual(officeColumnIndex(fromLetters: "Az"), 51)
    }

    func testOfficeColumnIndexRejectsNonLetters() {
        XCTAssertNil(officeColumnIndex(fromLetters: ""))
        XCTAssertNil(officeColumnIndex(fromLetters: "1"))
        XCTAssertNil(officeColumnIndex(fromLetters: "A1"))
        XCTAssertNil(officeColumnIndex(fromLetters: "A-B"))
        XCTAssertNil(officeColumnIndex(fromLetters: "A "))
    }

    func testOfficeParseCellReferenceInvertsOfficeCellReference() {
        XCTAssertEqual(officeParseCellReference("A1")?.column, 0)
        XCTAssertEqual(officeParseCellReference("A1")?.row, 0)
        XCTAssertEqual(officeParseCellReference("B1")?.column, 1)
        XCTAssertEqual(officeParseCellReference("A10")?.row, 9)
        XCTAssertEqual(officeParseCellReference("AA100")?.column, 26)
        XCTAssertEqual(officeParseCellReference("AA100")?.row, 99)
    }

    func testOfficeParseCellReferenceIsCaseInsensitiveOnTheLetters() {
        let lower = officeParseCellReference("aa100")
        XCTAssertEqual(lower?.column, 26)
        XCTAssertEqual(lower?.row, 99)
    }

    /// Malformed shapes: wire strictness applied to the ONE place this file owns real A1 semantics
    /// (the daemon only validates the wire SHAPE of `range`, never defaults a bad one) — every one
    /// of these must refuse, never guess.
    func testOfficeParseCellReferenceRejectsMalformedInput() {
        XCTAssertNil(officeParseCellReference(""))
        XCTAssertNil(officeParseCellReference("1A"))          // digits before letters
        XCTAssertNil(officeParseCellReference("A"))            // no row at all
        XCTAssertNil(officeParseCellReference("1"))            // no column at all
        XCTAssertNil(officeParseCellReference("A0"))           // row 0 does not exist (rows are 1-based)
        XCTAssertNil(officeParseCellReference("A-1"))          // signed row
        XCTAssertNil(officeParseCellReference("A1B2"))         // letters resume after digits
        XCTAssertNil(officeParseCellReference(" A1"))          // leading whitespace
        XCTAssertNil(officeParseCellReference("A1 "))          // trailing whitespace
    }

    func testOfficeParseRangeAcceptsASingleCellAsAOneCellRange() {
        let range = officeParseRange("B2")
        XCTAssertEqual(range?.startColumn, 1)
        XCTAssertEqual(range?.startRow, 1)
        XCTAssertEqual(range?.endColumn, 1)
        XCTAssertEqual(range?.endRow, 1)
        XCTAssertEqual(range?.cellCount, 1)
    }

    func testOfficeParseRangeParsesATwoCornerSpan() {
        let range = officeParseRange("A1:C10")
        XCTAssertEqual(range?.startColumn, 0)
        XCTAssertEqual(range?.startRow, 0)
        XCTAssertEqual(range?.endColumn, 2)
        XCTAssertEqual(range?.endRow, 9)
        XCTAssertEqual(range?.columnCount, 3)
        XCTAssertEqual(range?.rowCount, 10)
        XCTAssertEqual(range?.cellCount, 30)
    }

    /// A range given "backwards" (bottom-right : top-left) normalizes identically to the same span
    /// given the ordinary way — a caller (model-authored, not UI-driven) has no reason to always get
    /// reading order right, and LOK's own Name Box accepts either order.
    func testOfficeParseRangeNormalizesAReversedCornerOrder() {
        XCTAssertEqual(officeParseRange("C10:A1"), officeParseRange("A1:C10"))
    }

    func testOfficeParseRangeRejectsMalformedShapes() {
        XCTAssertNil(officeParseRange(""))
        XCTAssertNil(officeParseRange("A1:B2:C3"))     // more than one colon
        XCTAssertNil(officeParseRange("A1:"))           // empty second half
        XCTAssertNil(officeParseRange(":A1"))           // empty first half
        XCTAssertNil(officeParseRange("A1:B0"))         // a malformed corner poisons the whole range
        XCTAssertNil(officeParseRange("Sheet1!A1"))     // sheet-qualification is the `sheet` operand's job, not range's
    }

    /// office-agent-tools T3 — the cell-count ceiling `sheets read` enforces BEFORE any LOK work.
    /// Sized so a worst-realistic-case grid of moderately long text cells still lands comfortably
    /// under `PanelCommandConsumer.resultMaxLength` (64 KiB, mirroring the wire's own
    /// `PANEL_COMMAND_RESULT_MAX_LENGTH`) — measured here directly, not merely asserted, so a future
    /// change to either number is caught by arithmetic rather than trusted by comment.
    func testOfficeReadRangeMaxCellsKeepsAWorstRealisticGridUnderTheResultCap() {
        let cellsAtCap = officeReadRangeMaxCells
        let longestOrdinaryCellText = String(repeating: "x", count: 20) // a realistic "long-ish" text cell
        let syntheticGridBytes = (longestOrdinaryCellText.utf8.count + 1) * cellsAtCap // +1 per cell for its separator
        XCTAssertLessThan(syntheticGridBytes, PanelCommandConsumer.resultMaxLength,
                          "officeReadRangeMaxCells (\(cellsAtCap)) is too large: a grid of "
                          + "\(cellsAtCap) 20-character cells would already be \(syntheticGridBytes) "
                          + "bytes, at or past PanelCommandConsumer.resultMaxLength "
                          + "(\(PanelCommandConsumer.resultMaxLength))")
    }

    func testOfficeParseRangeRefusesARangeLargerThanTheCap() {
        let tooManyRows = officeReadRangeMaxCells + 1
        let range = officeParseRange("A1:A\(tooManyRows)")
        XCTAssertEqual(range?.cellCount, tooManyRows, "setup: this range's cell count must actually "
                       + "exceed the cap for this test to mean anything")
        XCTAssertGreaterThan(range!.cellCount, officeReadRangeMaxCells)
    }

    // MARK: - Pure: officeFormulaBarReference / officeFormulaBarContent (advisor review, Task 8:
    // the bar's own display-gating decisions, extracted out of the SwiftUI view so they can be
    // pinned directly)

    private let sampleCellRect = OfficeTwipsRect(x: 1275, y: 0, width: 1274, height: 254)

    func testFormulaBarReferenceShowsTheRefWhenPartsAgree() {
        XCTAssertEqual(officeFormulaBarReference(
            cellCursor: .at(rectTwips: sampleCellRect, column: 1, row: 0), part: 0, activePart: 0), "B1")
    }

    func testFormulaBarReferenceBlanksOnPartMismatch() {
        XCTAssertEqual(officeFormulaBarReference(
            cellCursor: .at(rectTwips: sampleCellRect, column: 1, row: 0), part: 1, activePart: 0), "",
            "a ref computed against a part the user has since switched away from must never display as current")
    }

    /// Task 5's own in-cell-edit sentinel — the deliberate choice (`OfficeFormulaBar.referenceText`'s
    /// own header): blank, not a retained stale ref, for consistency with the canvas's own
    /// cell-cursor-rect overlay vanishing at the same moment.
    func testFormulaBarReferenceBlanksDuringInCellEdit() {
        XCTAssertEqual(officeFormulaBarReference(cellCursor: .empty, part: 0, activePart: 0), "")
    }

    func testFormulaBarReferenceBlanksWhenNothingIsKnownYet() {
        XCTAssertEqual(officeFormulaBarReference(cellCursor: nil, part: nil, activePart: 0), "")
    }

    func testFormulaBarContentShowsTextWhenPartsAgree() {
        XCTAssertEqual(officeFormulaBarContent(text: "42", part: 0, activePart: 0), "42")
    }

    /// A real empty cell's own shape (this task's own live probe) — distinct from "nothing known
    /// yet" only in the CALLER's rendering (`officeFormulaBarEmptyPlaceholder`), not in this gate.
    func testFormulaBarContentPassesThroughARealEmptyString() {
        XCTAssertEqual(officeFormulaBarContent(text: "", part: 0, activePart: 0), "")
    }

    func testFormulaBarContentBlanksOnPartMismatchEvenWithRealText() {
        XCTAssertEqual(officeFormulaBarContent(text: "42", part: 1, activePart: 0), "",
                       "content from a part the user has since switched away from must never display as current")
    }

    func testFormulaBarContentBlanksWhenNothingIsKnownYet() {
        XCTAssertEqual(officeFormulaBarContent(text: nil, part: nil, activePart: 0), "")
    }

    // MARK: - Pure: officePartStripKind

    func testSpreadsheetsGetTheBottomSheetTabStrip() {
        XCTAssertEqual(officePartStripKind(for: .spreadsheet), .bottomSheetTabs)
    }

    func testPresentationsGetTheLeftSlideRail() {
        XCTAssertEqual(officePartStripKind(for: .presentation), .leftSlideRail)
    }

    func testTextDrawingAndOtherGetNoStrip() {
        XCTAssertEqual(officePartStripKind(for: .text), .none)
        XCTAssertEqual(officePartStripKind(for: .drawing), .none)
        XCTAssertEqual(officePartStripKind(for: .other), .none)
    }

    // MARK: - Pure: panelDocumentTabAction (mirrors panelFileTabAction's own table)

    func testNoMatchingTabMintsTitledWithTheBasename() {
        XCTAssertEqual(panelDocumentTabAction(tabs: [], path: realGatePath, openFailures: []),
                       .mint(title: "gate.xlsx"))
    }

    func testAMatchingDocumentTabActivatesWithNoRetryWhenClean() {
        let tabs = [PanelTab(tabId: "t1", kind: .document, url: realGatePath, title: "gate.xlsx")]
        XCTAssertEqual(panelDocumentTabAction(tabs: tabs, path: realGatePath, openFailures: []),
                       .activate(tabId: "t1", retryOpen: false))
    }

    func testAMatchingDocumentTabActivatesWithRetryWhenItsPathIsInOpenFailures() {
        let tabs = [PanelTab(tabId: "t1", kind: .document, url: realGatePath, title: "gate.xlsx")]
        XCTAssertEqual(panelDocumentTabAction(tabs: tabs, path: realGatePath,
                                              openFailures: [realGatePath]),
                       .activate(tabId: "t1", retryOpen: true))
    }

    /// The kind filter is load-bearing — `url` is a field every tab kind carries, so a `.code` tab
    /// pointed at the identical string must never be mistaken for an open document tab.
    func testAMatchingUrlOnANonDocumentTabDoesNotCountAsAMatch() {
        let tabs = [PanelTab(tabId: "t1", kind: .code, url: realGatePath, title: "gate.xlsx")]
        XCTAssertEqual(panelDocumentTabAction(tabs: tabs, path: realGatePath, openFailures: []),
                       .mint(title: "gate.xlsx"))
    }

    // MARK: - office-plumbing Task 7: the open-with escape hatch — `officeOpenWithLabel` reads live
    // LaunchServices state, so only its deterministic branch is asserted here; which app it names on
    // a machine that DOES have one is the live gate's own judgment call, matching this house's
    // standing posture toward anything resting on installed-app state.

    /// The one branch that cannot depend on what apps happen to be installed on the machine running
    /// this test: no path at all reads the same as "no app found," rather than constructing an empty
    /// `URL` or crashing.
    func testOfficeOpenWithLabelFallsBackToAGenericSentenceForANilOrEmptyPath() {
        XCTAssertEqual(officeOpenWithLabel(forFileAt: nil), "Open in Default App")
        XCTAssertEqual(officeOpenWithLabel(forFileAt: ""), "Open in Default App")
    }

    /// The SF Symbol the chrome button draws is spelled correctly — an invalid name renders BLANK,
    /// not a compile error, so this converts what would otherwise be a live-gate surprise into a
    /// test failure.
    func testTheOpenWithButtonsSymbolNameIsValid() {
        XCTAssertNotNil(NSImage(systemSymbolName: "arrow.up.forward.app", accessibilityDescription: nil),
                        "arrow.up.forward.app must be a real SF Symbol on this OS")
    }

    // MARK: - The model's own copy of the Driver recorder (a per-file copy, mirroring
    // `PanelFilesTabTests`'/`EditorTabTests`' own convention — `ShellSessionHostTests
    // .OfficeDriverRecorder` is private to that file)

    private final class DocumentOfficeDriverRecorder: @unchecked Sendable {
        // T6 review F3 + re-review Minor: `open` runs off the main actor when driven concurrently (a
        // nested type does NOT inherit its enclosing `@MainActor` test class's isolation), and every
        // field a closure reads is also set directly by test code from MainActor — so every shared
        // mutable field is guarded, not just the call log. Same lock-backed shape as
        // `ShellSessionHostTests.OfficeDriverRecorder` and this codebase's wider precedent
        // (`ShellScriptedTransport`/`ShellTransportFactory`/`MutableDisk`).
        private let lock = NSLock()
        private var _openCalls: [(docId: String, path: String)] = []
        var openCalls: [(docId: String, path: String)] { lock.lock(); defer { lock.unlock() }; return _openCalls }
        /// Office Stage B Task 2 — every `save` call, in order.
        private var _saveCalls: [String] = []
        var saveCalls: [String] { lock.lock(); defer { lock.unlock() }; return _saveCalls }
        private var _saveTempPaths: [String: String] = [:]
        var saveTempPaths: [String: String] {
            get { lock.lock(); defer { lock.unlock() }; return _saveTempPaths }
            set { lock.lock(); _saveTempPaths = newValue; lock.unlock() }
        }

        private var _openMetadata: [String: OfficeDocumentMetadata] = [:]
        var openMetadata: [String: OfficeDocumentMetadata] {
            get { lock.lock(); defer { lock.unlock() }; return _openMetadata }
            set { lock.lock(); _openMetadata = newValue; lock.unlock() }
        }
        private var _defaultMetadata = OfficeDocumentMetadata(
            type: .text, parts: 1, sizeTwips: OfficeDocumentSize(widthTwips: 100, heightTwips: 100))
        var defaultMetadata: OfficeDocumentMetadata {
            get { lock.lock(); defer { lock.unlock() }; return _defaultMetadata }
            set { lock.lock(); _defaultMetadata = newValue; lock.unlock() }
        }
        private var _state: OfficeHelperSupervisor.State = .ready
        var state: OfficeHelperSupervisor.State {
            get { lock.lock(); defer { lock.unlock() }; return _state }
            set { lock.lock(); _state = newValue; lock.unlock() }
        }
        /// Office Stage B Task 2b test fallout — a real scratch dir `OfficeRuntime.openAndDispatch`
        /// genuinely stages into before ever calling `open` below.
        private let stateDirectory: URL
        init(stateDirectory: URL) { self.stateDirectory = stateDirectory }

        var driver: OfficeRuntime.Driver {
            OfficeRuntime.Driver(
                helperState: { [unowned self] in self.state },
                startHelper: { },
                open: { [unowned self] docId, path in
                    self.lock.lock(); self._openCalls.append((docId, path)); self.lock.unlock()
                    return self.openMetadata[path] ?? self.defaultMetadata
                },
                close: { _ in },
                save: { [unowned self] docId, _ in
                    self.lock.lock(); self._saveCalls.append(docId); self.lock.unlock()
                    return self.saveTempPaths[docId] ?? "/tmp/paneldocumenttabtests-\(docId).saved"
                },
                subscribeTiles: { _, _, _, _ in [] },
                unsubscribeTiles: { _ in },
                requestTiles: { _, _ in },
                postKey: { _, _, _, _, _ in }, postMouse: { _, _, _, _, _, _, _, _ in },
                postExtTextInput: { _, _, _, _ in },
                clipboardCopy: { _, _ in nil },
                clipboardCut: { _, _ in nil },
                clipboardPaste: { _, _, _ in },
                undo: { _ in },
                redo: { _ in },
                sheetsInfo: { _ in throw OfficeHelperClientError.serverError(reason: "fake driver: sheets not implemented") },
                sheetsRead: { _, _, _, _ in throw OfficeHelperClientError.serverError(reason: "fake driver: sheets not implemented") },
                sheetsSet: { _, _, _, _, _ in throw OfficeHelperClientError.serverError(reason: "fake driver: sheets not implemented") },
                sheetsResize: { _, _, _, _, _ in throw OfficeHelperClientError.serverError(reason: "fake driver: sheets not implemented") },
                sheetsManageSheet: { _, _, _, _ in throw OfficeHelperClientError.serverError(reason: "fake driver: sheets not implemented") },
                stateDirectory: stateDirectory)
        }
    }

    private var doubles: [AnyObject] = []
    private var runtimes: [OfficeRuntime] = []

    /// A host whose office runtimes are ALL backed by `office` (one recorder, mirroring
    /// `ShellSessionHostTests.OfficeDriverRecorder`'s own "one recorder per factory, shared across
    /// every session it mints" shape) unless `perSession` names a different recorder for a specific
    /// session id — the session-hop test needs two independent runtimes to prove departure released
    /// the RIGHT one.
    private func makeHost(office: DocumentOfficeDriverRecorder,
                          perSession: [String: DocumentOfficeDriverRecorder] = [:]) -> ShellSessionHost {
        let directory = SessionDirectory(lister: { [] })
        let host = ShellSessionHost(directory: directory, makeFeed: { _ in nil })
        host.makeOfficeRuntime = { [weak self] sid, _ in
            let recorder = perSession[sid] ?? office
            let runtime = OfficeRuntime(sessionId: sid, driver: recorder.driver)
            self?.runtimes.append(runtime)
            return runtime
        }
        return host
    }

    private func waitUntil(timeout: TimeInterval = 2, _ condition: () -> Bool) async -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition() {
            if Date() >= deadline { return false }
            try? await Task.sleep(nanoseconds: 5_000_000)
        }
        return true
    }

    // MARK: - The registry

    func testTheRegistryCachesBySameTabIdAndAFreshModelReplacesADiscardedOne() {
        let tab = PanelTab(tabId: "t1", kind: .document, url: "/a.xlsx", title: nil)
        let first = PanelDocumentTabModels.model(for: tab, host: nil, sessionId: nil)
        let again = PanelDocumentTabModels.model(for: tab, host: nil, sessionId: nil)
        XCTAssertTrue(first === again, "the SAME model for the SAME tabId, across render passes")

        PanelDocumentTabModels.discard(tabId: "t1")
        let afterDiscard = PanelDocumentTabModels.model(for: tab, host: nil, sessionId: nil)
        XCTAssertFalse(afterDiscard === first, "a discarded tab's model is never reused")
    }

    func testDiscardAllExceptKeepsOnlyTheNamedTabIds() {
        let tabA = PanelTab(tabId: "a", kind: .document, url: "/a.xlsx", title: nil)
        let tabB = PanelTab(tabId: "b", kind: .document, url: "/b.xlsx", title: nil)
        let modelA = PanelDocumentTabModels.model(for: tabA, host: nil, sessionId: nil)
        let modelB = PanelDocumentTabModels.model(for: tabB, host: nil, sessionId: nil)

        PanelDocumentTabModels.discardAll(except: ["a"])

        XCTAssertTrue(PanelDocumentTabModels.model(for: tabA, host: nil, sessionId: nil) === modelA,
                     "kept — its tabId was in the exception set")
        XCTAssertFalse(PanelDocumentTabModels.model(for: tabB, host: nil, sessionId: nil) === modelB,
                      "dropped — a fresh model replaces it")
    }

    /// **The real session-hop door**, mirroring `PanelFilesTabTests
    /// .testASessionHopReleasesADepartedSessionsFilesTreeEvenThoughItsTabStaysOpen`'s own shape:
    /// departure driven through `PanelStore.switchSession`, which is what
    /// `prunePanelTabModelsOnSessionChange` actually reacts to — proving the JOIN, not merely that
    /// `discardAll` itself works when called directly (already covered above).
    func testASessionHopPrunesADepartedSessionsDocumentModelEvenThoughItsTabStaysOpen() async {
        let (office1, office2) = (DocumentOfficeDriverRecorder(stateDirectory: stateDir), DocumentOfficeDriverRecorder(stateDirectory: stateDir))
        doubles.append(contentsOf: [office1, office2])
        let host = makeHost(office: office1, perSession: ["S1": office1, "S2": office2])

        host.panelStore.switchSession(to: "S1")
        let tab = PanelTab(tabId: "t1", kind: .document, url: realAPath, title: nil)
        let model = PanelDocumentTabModels.model(for: tab, host: host, sessionId: "S1")
        model.activate()
        XCTAssertTrue(model.runtime === host.existingOfficeRuntime(for: "S1"))
        // Hygiene, not an assertion (mirrors `ShellSessionHostTests`' own established pattern): let
        // `activate`'s deferred open settle on `office1` before this test does anything else, so a
        // later test's `setUp()` reassigning `doubles`/`runtimes` cannot release a recorder a still
        // in-flight `[unowned self]` closure is about to touch.
        _ = await waitUntil { office1.openCalls.count == 1 }

        // The hop: S1 -> S2. The document tab is NOT closed (`discard` is never called) — only the
        // session changes, which is what `prunePanelTabModelsOnSessionChange` reacts to.
        host.panelStore.switchSession(to: "S2")

        let returned = PanelDocumentTabModels.model(for: tab, host: host, sessionId: "S1")
        XCTAssertFalse(returned === model, "a fresh model for the genuine return — the departed one left the registry")
    }

    // MARK: - Model lifecycle: the lazy open, at most once per (runtime, path)

    func testActivatingResolvesTheRuntimeAndOpensThePathExactlyOnce() async {
        let office = DocumentOfficeDriverRecorder(stateDirectory: stateDir)
        let host = makeHost(office: office)
        let model = PanelDocumentTabModel(tabId: "t1", path: realAPath)
        model.bind(host: host, sessionId: "S1")
        model.activate()

        let opened = await waitUntil { office.openCalls.count == 1 }
        XCTAssertTrue(opened)
        // Office Stage B Task 2b — the wire NEVER sees the real path: `driver.open` receives the
        // STAGED copy `openAndDispatch` made under the shared helper's own `--state-path`, keeping
        // the real path's own extension (`OfficeSaveFormat` capture depends on it).
        let stagedCallPath = try? XCTUnwrap(office.openCalls.first?.path)
        XCTAssertNotEqual(stagedCallPath, realAPath, "the real path must never cross the wire")
        XCTAssertEqual((stagedCallPath as NSString?)?.pathExtension, "xlsx")
        XCTAssertTrue(stagedCallPath?.hasPrefix(stateDir.path) == true, "staged under the driver's own state directory")

        // A second refresh must NOT re-open — the guard is per (runtime, path), not per call.
        model.refreshForTesting()
        model.refreshForTesting()
        try? await Task.sleep(nanoseconds: 30_000_000)
        XCTAssertEqual(office.openCalls.count, 1, "at most once per (runtime, path)")
    }

    /// office-plumbing Task 8: `model.banner` is the tab's own door onto `OfficeRuntimeState
    /// .documentBanners` — proven end to end through a real `OfficeRuntime`/`ShellSessionHost` pair,
    /// not just the pure dictionary lookup, so a future change to how `documentBanners` gets wired to
    /// the model cannot silently stop reaching this door. `fileChangedOnDisk` is driven directly
    /// (internal, not private, for exactly this reason — `OfficeRuntimeWatcherTests`' own header
    /// states it) rather than through a real filesystem watcher, which `OfficeRuntimeWatcherTests`
    /// already owns proving the wiring for; that same file's `OfficeRuntimeReducerTests` section owns
    /// the reducer-level proof that the banner CLEARS on a successful reopen — this test's job is
    /// only the model's own door, not re-proving the reducer.
    func testBannerSurfacesFromRuntimeStateThroughTheModelsOwnDoor() async {
        let office = DocumentOfficeDriverRecorder(stateDirectory: stateDir)
        let host = makeHost(office: office)
        let model = PanelDocumentTabModel(tabId: "t1", path: realAPath)
        model.bind(host: host, sessionId: "S1")
        model.activate()
        _ = await waitUntil { office.openCalls.count == 1 }
        _ = await waitUntil { model.runtime?.stateSnapshot.documents[realAPath] != nil }
        XCTAssertNil(model.banner, "no banner before anything has happened to the file")

        // Office Stage B Task 2b — `realAPath` is now a genuinely real scratch file (staging needs
        // one to copy); delete it here instead of relying on it having never existed. Once gone,
        // `officeFileStat` reports `nil` for it, which `fileChangedOnDisk` treats as deleted
        // regardless of what baseline preceded it.
        try? FileManager.default.removeItem(atPath: realAPath)
        model.runtime?.fileChangedOnDisk(realAPath)

        let bannered = await waitUntil { model.banner != nil }
        XCTAssertTrue(bannered)
        XCTAssertEqual(model.banner, "File was deleted on disk")
    }

    /// `model.banner` is `nil` for a tab with no path at all — unreachable through any shipped door
    /// (`PanelDocumentTabModel.path`'s own doc), but a guard worth pinning rather than force-unwrapping.
    func testBannerIsNilForATabWithNoPath() {
        let model = PanelDocumentTabModel(tabId: "t1", path: nil)
        XCTAssertNil(model.banner)
    }

    /// Office Stage B Task 2b — `model.conflict`'s own door, end to end through a REAL runtime (not
    /// the pure reducer `OfficeRuntimeReducerTests` already covers): a dirty document's external
    /// change surfaces as `.conflict`, never `.banner` — mirrors
    /// `testBannerSurfacesFromRuntimeStateThroughTheModelsOwnDoor` immediately above in shape, dirty
    /// instead of clean.
    func testConflictSurfacesFromRuntimeStateThroughTheModelsOwnDoorOnADirtyDocument() async throws {
        let office = DocumentOfficeDriverRecorder(stateDirectory: stateDir)
        let host = makeHost(office: office)
        let model = PanelDocumentTabModel(tabId: "t1", path: realAPath)
        model.bind(host: host, sessionId: "S1")
        model.activate()
        _ = await waitUntil { office.openCalls.count == 1 }
        _ = await waitUntil { model.runtime?.stateSnapshot.documents[realAPath] != nil }
        XCTAssertNil(model.conflict, "no conflict before anything has happened to the file")
        let docId = try XCTUnwrap(model.runtime?.stateSnapshot.documents[realAPath]?.docId)
        model.runtime?.handle(documentEvent: .modifiedChanged(true), docId: docId)

        try? "changed externally".write(toFile: realAPath, atomically: true, encoding: .utf8)
        model.runtime?.fileChangedOnDisk(realAPath)

        let conflicted = await waitUntil { model.conflict != nil }
        XCTAssertTrue(conflicted)
        XCTAssertEqual(model.conflict, .changed)
        XCTAssertNil(model.banner, "the dirty path routes through conflict, never the plain banner")
    }

    /// **"Reload from disk"**, through the model's own door: discards the standing conflict and
    /// re-stages, minting a fresh docId — the visible proof nothing stale survived the choice.
    func testReloadFromDiskClearsTheConflictAndMintsAFreshDocId() async throws {
        let office = DocumentOfficeDriverRecorder(stateDirectory: stateDir)
        let host = makeHost(office: office)
        let model = PanelDocumentTabModel(tabId: "t1", path: realAPath)
        model.bind(host: host, sessionId: "S1")
        model.activate()
        _ = await waitUntil { office.openCalls.count == 1 }
        _ = await waitUntil { model.runtime?.stateSnapshot.documents[realAPath] != nil }
        let originalDocId = try XCTUnwrap(model.runtime?.stateSnapshot.documents[realAPath]?.docId)
        model.runtime?.handle(documentEvent: .modifiedChanged(true), docId: originalDocId)
        try? "changed externally".write(toFile: realAPath, atomically: true, encoding: .utf8)
        model.runtime?.fileChangedOnDisk(realAPath)
        _ = await waitUntil { model.conflict != nil }

        model.reloadFromDisk()

        let reloaded = await waitUntil {
            model.conflict == nil && model.runtime?.stateSnapshot.documents[realAPath]?.docId != originalDocId
        }
        XCTAssertTrue(reloaded, "reloadFromDisk must clear the conflict and mint a fresh docId, not "
                      + "merely dismiss the banner")
    }

    /// **"Keep my version"**, through the model's own door: dismisses the conflict with the document
    /// entry completely untouched — no reload, same docId, still dirty.
    func testKeepMyVersionClearsTheConflictWithoutTouchingTheDocument() async throws {
        let office = DocumentOfficeDriverRecorder(stateDirectory: stateDir)
        let host = makeHost(office: office)
        let model = PanelDocumentTabModel(tabId: "t1", path: realAPath)
        model.bind(host: host, sessionId: "S1")
        model.activate()
        _ = await waitUntil { office.openCalls.count == 1 }
        _ = await waitUntil { model.runtime?.stateSnapshot.documents[realAPath] != nil }
        let originalDocId = try XCTUnwrap(model.runtime?.stateSnapshot.documents[realAPath]?.docId)
        model.runtime?.handle(documentEvent: .modifiedChanged(true), docId: originalDocId)
        try? "changed externally".write(toFile: realAPath, atomically: true, encoding: .utf8)
        model.runtime?.fileChangedOnDisk(realAPath)
        _ = await waitUntil { model.conflict != nil }

        model.keepMyVersion()

        let dismissed = await waitUntil { model.conflict == nil }
        XCTAssertTrue(dismissed)
        XCTAssertEqual(model.runtime?.stateSnapshot.documents[realAPath]?.docId, originalDocId,
                       "still the SAME document — keep mine touches nothing else")
    }

    /// The failed-vs-idle gate's own local proof, end to end through the model: `hasRequestedOpen`
    /// flips true only once the deferred open Task has actually fired.
    func testHasRequestedOpenBecomesTrueOnlyAfterTheDeferredOpenFires() async {
        let office = DocumentOfficeDriverRecorder(stateDirectory: stateDir)
        let host = makeHost(office: office)
        let model = PanelDocumentTabModel(tabId: "t1", path: realAPath)
        model.bind(host: host, sessionId: "S1")
        XCTAssertFalse(model.hasRequestedOpen, "nothing has happened yet — bind alone asks nothing")

        model.activate()
        let flipped = await waitUntil { model.hasRequestedOpen }
        XCTAssertTrue(flipped)
        // Hygiene, not an assertion: `hasRequestedOpen` flips true INSIDE the same deferred Task
        // that then calls `runtime.open(path)`, which itself spawns a further Task for the actual
        // `driver.open` round trip — settle that inner one too before returning (see the session-hop
        // test's identical comment for why).
        _ = await waitUntil { office.openCalls.count == 1 }
    }

    /// obligation 5's Reopen door: a genuine retry re-issues `open()` on the runtime — carry 4's own
    /// "`.failed` retries like `.idle`" is the reducer's job; this proves the MODEL'S door reaches it.
    ///
    /// **Must simulate a GENUINE failure, not an already-open document** — `OfficeRuntimeReducer
    /// .openRequested` from `.ready` is a no-op when `documents[path] != nil` ("an already-open path
    /// is simply left alone", the reducer's own comment), so calling `retryOpen()` right after a
    /// successful open would prove nothing: the interesting case is `phase == .failed`, the ONE
    /// phase carry 4 says retries exactly like `.idle`.
    func testRetryOpenReIssuesOpenOnTheResolvedRuntime() async {
        let office = DocumentOfficeDriverRecorder(stateDirectory: stateDir)
        let host = makeHost(office: office)
        let model = PanelDocumentTabModel(tabId: "t1", path: realAPath)
        model.bind(host: host, sessionId: "S1")
        model.activate()
        _ = await waitUntil { office.openCalls.count == 1 }

        // The shared helper dies — every runtime in the table (this one included) lands in .failed.
        host.broadcastOfficeHelperEvent(.helperDied)
        XCTAssertEqual(model.runtime?.stateSnapshot.phase, .failed)

        model.retryOpen()
        let retried = await waitUntil { office.openCalls.count == 2 }
        XCTAssertTrue(retried)
        // Office Stage B Task 2b — both calls carry a STAGED path (never the real one), and — since
        // each open mints a fresh docId — the two staged paths are themselves distinct even though
        // both stage the SAME real file.
        XCTAssertEqual(office.openCalls.count, 2)
        XCTAssertTrue(office.openCalls.allSatisfy { $0.path != realAPath })
        XCTAssertNotEqual(office.openCalls[0].path, office.openCalls[1].path,
                          "a retry is a fresh open under a fresh docId, staged fresh")
    }

    // MARK: - The part-strip door

    private final class RecordingCanvasHost: OfficeDocumentCanvasHost {
        private(set) var requestedParts: [Int] = []
        private(set) var focusCount = 0
        func setActivePart(_ part: Int) { requestedParts.append(part) }
        func focusCanvas() { focusCount += 1 }
    }

    func testSelectPartRoutesToTheRegisteredCanvasHost() {
        let model = PanelDocumentTabModel(tabId: "t1", path: "/a.xlsx")
        let canvasHost = RecordingCanvasHost()
        model.canvasHost = canvasHost

        model.selectPart(2)

        XCTAssertEqual(canvasHost.requestedParts, [2])
    }

    func testSelectPartIsAHarmlessNoOpWithNoCanvasMounted() {
        let model = PanelDocumentTabModel(tabId: "t1", path: "/a.xlsx")
        model.selectPart(2) // must not crash
    }

    // MARK: - Task 8: the formula bar's own "focus-the-cell-on-click" door

    /// Mirrors `testSelectPartRoutesToTheRegisteredCanvasHost` exactly — the formula bar's click
    /// target is not editable (v1's own scope: in-cell editing on the canvas IS the edit path), so
    /// a click routes focus back to whichever canvas is mounted instead.
    func testFocusCanvasRoutesToTheRegisteredCanvasHost() {
        let model = PanelDocumentTabModel(tabId: "t1", path: "/a.xlsx")
        let canvasHost = RecordingCanvasHost()
        model.canvasHost = canvasHost

        model.focusCanvas()

        XCTAssertEqual(canvasHost.focusCount, 1)
    }

    func testFocusCanvasIsAHarmlessNoOpWithNoCanvasMounted() {
        let model = PanelDocumentTabModel(tabId: "t1", path: "/a.xlsx")
        model.focusCanvas() // must not crash
    }

    // MARK: - Office Stage B Task 2: saving

    /// PURE: ⌘S's document-tab leg saves the tab the user is LOOKING at, and only if it is a
    /// document — mirrors `EditorSaveTests.testTheMenuTargetIsTheActiveCodeTabAndNothingElse`'s
    /// exact shape, filtered to `.document` instead of `.code`.
    func testOfficeSaveMenuTargetIsTheActiveDocumentTabAndNothingElse() {
        let document = PanelTab(tabId: "t1", kind: .document, url: realGatePath, title: "gate.xlsx")
        let code = PanelTab(tabId: "t2", kind: .code, url: "/repo/engine.ts", title: "engine.ts")
        let pathless = PanelTab(tabId: "t3", kind: .document, url: nil, title: nil)

        XCTAssertEqual(officeSaveMenuTarget(tabs: [document, code], activeTabId: "t1")?.tabId, "t1")
        XCTAssertNil(officeSaveMenuTarget(tabs: [document, code], activeTabId: "t2"),
                     "a code tab in front is not a document to save — never reach past it")
        XCTAssertNil(officeSaveMenuTarget(tabs: [document, pathless], activeTabId: "t3"))
        XCTAssertNil(officeSaveMenuTarget(tabs: [], activeTabId: "t1"))
    }

    /// **The live-gate ⌘S bug, pinned in the direction that was actually reported.**
    ///
    /// This assertion previously read `XCTAssertNil(… activeTabId: nil)` — it pinned the defect as
    /// correct. A nil `activeTabId` does not mean "no tab is in front"; it means the id is absent,
    /// which `panelShownTab` (what `ShellPanel` renders and the strip highlights) resolves to the
    /// first tab. Its own doc names the two ways that happens, and the first is permanent: a
    /// session whose log predates the daemon's `panel.openTab` fix carries `panel_tab_opened` with
    /// no `panel_tab_activated`, and sessions are user-delete-only. The user hit exactly that — the
    /// document rendered, its dirty dot showed, the close button offered to save it, and ⌘S alone
    /// did nothing, because the menu item's target resolved `nil` and the item stayed disabled.
    func testOfficeSaveMenuTargetFollowsTheSHOWNTabWhenNoActiveIdWasEverRecorded() {
        let document = PanelTab(tabId: "t1", kind: .document, url: realGatePath, title: "gate.xlsx")
        let web = PanelTab(tabId: "t2", kind: .web, url: "https://example.com", title: "Example")

        XCTAssertEqual(officeSaveMenuTarget(tabs: [document], activeTabId: nil)?.tabId, "t1",
                       "the only tab is the shown tab — ⌘S must save it")
        XCTAssertEqual(officeSaveMenuTarget(tabs: [document, web], activeTabId: nil)?.tabId, "t1",
                       "the fallback is the FIRST tab, which is what the panel renders")
        XCTAssertNil(officeSaveMenuTarget(tabs: [web, document], activeTabId: nil),
                     "when the shown tab is a web tab, ⌘S still reaches past nothing")
        XCTAssertNil(officeSaveMenuTarget(tabs: [], activeTabId: nil))
    }

    /// PURE: the chrome's dirty dot — driven purely from `documents[path].dirty`, mirroring
    /// `editorTabIsDirty`'s own table of cases exactly (no state, no path, a closed document, a
    /// clean one, a dirty one).
    func testOfficeDocumentIsDirtyReadsPurelyFromTheMatchingDocumentEntry() {
        XCTAssertFalse(officeDocumentIsDirty(state: nil, path: "/a.xlsx"), "no runtime state")
        XCTAssertFalse(officeDocumentIsDirty(state: OfficeRuntimeState(), path: nil), "no path")

        var clean = documentState(path: "/a.xlsx")
        XCTAssertFalse(officeDocumentIsDirty(state: clean, path: "/a.xlsx"), "a document defaults clean")

        clean.documents["/a.xlsx"]?.dirty = true
        XCTAssertTrue(officeDocumentIsDirty(state: clean, path: "/a.xlsx"))

        XCTAssertFalse(officeDocumentIsDirty(state: clean, path: "/never-opened.xlsx"),
                       "a path with no document entry at all is never dirty")
    }

    // MARK: - Office Stage B Task 9: the read-only-viewer decision

    /// PURE: exactly the eight extensions `officeFileExtensions` recognizes split two ways — the
    /// six this build can genuinely write, and the two it can open but not write — plus the
    /// boundary cases (`nil`, an extension outside either set, case sensitivity).
    ///
    /// **One route into read-only, again, as of the r4 vendor re-cut**: `xlsm`/`odg` have no
    /// `OfficeSaveFormat` case at all (Task 9's widening). Whole-branch review I2 had briefly added
    /// a second route — `docx`, which HAS a case that the r3 vendor tree's missing DOCX export
    /// service failed behind — and this test pinned it here. r4 supplies that service
    /// (`libmswordlo.dylib`; `officeReadWriteExtensions`' own header has the account), so `docx`
    /// moves back into the read-write loop below and its live proof is the docx leg of
    /// `OfficeHelperLiveTests.testXlsxDocxPptxSaveRoundTripThroughTheRealHelperAfterTheR4VendorRecut`.
    func testOfficeDocumentIsReadOnlyFormatIsTrueOnlyForTheFormatsThisBuildCannotWrite() {
        for ext in ["xlsx", "ods", "pptx", "odp", "odt", "docx"] {
            XCTAssertFalse(officeDocumentIsReadOnlyFormat(path: "/a.\(ext)"), "\(ext): a genuine "
                           + "OfficeSaveFormat case AND a save this build actually lands — read-write")
        }
        for ext in ["xlsm", "odg"] {
            XCTAssertTrue(officeDocumentIsReadOnlyFormat(path: "/a.\(ext)"), "\(ext): widened in with "
                          + "no native save story")
        }
        XCTAssertTrue(officeDocumentIsReadOnlyFormat(path: "/a.XLSM"), "case-insensitive, mirroring "
                      + "panelTabKind(forFilePath:)'s own NSString.pathExtension read")
        XCTAssertFalse(officeDocumentIsReadOnlyFormat(path: "/a.txt"), "outside officeFileExtensions "
                       + "entirely — not an office document at all, so not read-only ABOUT one either")
        XCTAssertFalse(officeDocumentIsReadOnlyFormat(path: nil), "nothing to be read-only about")
    }

    /// **`.docx` is a full read-WRITE document tab at every door — the reversal of whole-branch
    /// review I2's demotion, asserted at the same three doors that used to carry it.** This test has
    /// now flipped twice, and that history is the point of keeping it as one named test rather than
    /// folding it into the loop above: it asserted read-write originally, read-ONLY after I2 (when
    /// the r3 vendor tree could not export docx at all), and read-write again now that the r4 re-cut
    /// supplies the missing DOCX export service. Each flip is a real product decision, and this is
    /// where a reviewer can see which one is currently in force. `.docx` routing to a document tab
    /// at all was never in question through any of it (a Word document must not fall through to a
    /// Monaco code tab and render as binary mojibake) and is pinned here as well as by
    /// `panelTabKind(forFilePath:)`'s own round.
    func testDocxIsAFullReadWriteDocumentTabAtEveryDoorAfterTheR4VendorRecut() {
        XCTAssertEqual(panelTabKind(forFilePath: "/report.docx"), .document,
                       "an office document, unchanged through both flips of the save decision")

        XCTAssertFalse(officeDocumentIsReadOnlyFormat(path: "/report.docx"),
                       "the predicate every other door reads — docx is writable again")

        let docx = PanelTab(tabId: "t1", kind: .document, url: "/report.docx", title: "report.docx")
        XCTAssertNotNil(officeSaveMenuTarget(tabs: [docx], activeTabId: "t1"),
                        "⌘S resolves a real target — the menu item is live for a Word document")

        var state = documentState(path: "/report.docx")
        state.documents["/report.docx"]?.dirty = true
        XCTAssertTrue(officeDocumentIsDirty(state: state, path: "/report.docx"),
                      "the dirty dot shows for real — the mask that used to suppress it unconditionally "
                      + "for docx is gone, and OfficeRuntime's input verbs forward keystrokes again")
    }

    /// PURE: ⌘S is unreachable for a widened-format tab even though it is otherwise the active
    /// document tab with a real path — `officeSaveMenuTarget`'s own read-only gate.
    func testOfficeSaveMenuTargetIsNilForAWidenedReadOnlyFormatEvenWhenOtherwiseEligible() {
        let readOnly = PanelTab(tabId: "t1", kind: .document, url: "/a.xlsm", title: "a.xlsm")
        XCTAssertNil(officeSaveMenuTarget(tabs: [readOnly], activeTabId: "t1"), "xlsm has no "
                     + "OfficeSaveFormat case — ⌘S must never reach a saveRequested for it")

        let readWrite = PanelTab(tabId: "t2", kind: .document, url: realGatePath, title: "gate.xlsx")
        XCTAssertNotNil(officeSaveMenuTarget(tabs: [readWrite], activeTabId: "t2"), "sanity — an "
                        + "ordinary read-write document tab is unaffected")
    }

    /// PURE: even a document LOK itself reports as modified never shows dirty when its own path is
    /// a widened, read-only format — the predicate's own header explains why this must be true, not
    /// merely cosmetically hidden: `OfficeRuntime`'s input-verb guards mean this state is actually
    /// unreachable in practice, but the VIEW-LAYER predicate must hold regardless of how `dirty`
    /// got set, since it is the one thing standing between a stray `true` and a shown dot.
    func testOfficeDocumentIsDirtyIsAlwaysFalseForAWidenedReadOnlyFormatEvenIfDirtyIsSomehowTrue() {
        var state = documentState(path: "/a.xlsm")
        state.documents["/a.xlsm"]?.dirty = true
        XCTAssertFalse(officeDocumentIsDirty(state: state, path: "/a.xlsm"), "xlsm never shows dirty, "
                       + "regardless of what the underlying DocumentEntry says")
    }

    /// The host half of the menu door: it reads the panel it is showing NOW, and it never mints an
    /// office runtime just to ask whether there is something to save — mirrors `EditorSaveTests
    /// .testTheHostResolvesTheActiveCodeTabAndSavesThroughTheExistingRuntimeOnly`'s exact shape.
    func testTheHostResolvesTheActiveDocumentTabAndSavesThroughTheExistingRuntimeOnly() async {
        let office = DocumentOfficeDriverRecorder(stateDirectory: stateDir)
        doubles.append(office)
        let host = makeHost(office: office)
        host.panelStore.switchSession(to: "S1")
        host.panelStore.applyFetchedSnapshot(
            sessionId: "S1",
            tabs: [PanelTab(tabId: "t1", kind: .document, url: realGatePath, title: "gate.xlsx")],
            activeTabId: "t1")

        XCTAssertEqual(host.activeDocumentTabPath, realGatePath)
        host.saveActiveDocumentTab()
        try? await Task.sleep(nanoseconds: 30_000_000) // a wrongly-minting version time to act
        XCTAssertEqual(office.saveCalls, [], "no runtime exists for this session yet, and a save "
                       + "must not mint one")
        XCTAssertEqual(host.officeRuntimes.count, 0)

        // With a runtime actually standing (and the document actually open), the same door saves
        // through it.
        let runtime = host.officeRuntime(for: "S1")
        runtime.open(realGatePath)
        let opened = await waitUntil { office.openCalls.count == 1 }
        XCTAssertTrue(opened)
        _ = await waitUntil { runtime.stateSnapshot.documents[realGatePath] != nil }

        host.saveActiveDocumentTab()
        let saved = await waitUntil { office.saveCalls.count == 1 }
        XCTAssertTrue(saved)
        XCTAssertEqual(office.saveCalls.first, runtime.stateSnapshot.documents[realGatePath]?.docId)
    }
}
