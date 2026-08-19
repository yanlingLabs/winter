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
    override func tearDown() {
        PanelDocumentTabModels.removeAllForTesting()
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
            docId: docId, type: type, parts: parts, activePart: activePart, sizeTwips: sizeTwips)
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
        XCTAssertEqual(panelDocumentTabAction(tabs: [], path: "/repo/gate.xlsx", openFailures: []),
                       .mint(title: "gate.xlsx"))
    }

    func testAMatchingDocumentTabActivatesWithNoRetryWhenClean() {
        let tabs = [PanelTab(tabId: "t1", kind: .document, url: "/repo/gate.xlsx", title: "gate.xlsx")]
        XCTAssertEqual(panelDocumentTabAction(tabs: tabs, path: "/repo/gate.xlsx", openFailures: []),
                       .activate(tabId: "t1", retryOpen: false))
    }

    func testAMatchingDocumentTabActivatesWithRetryWhenItsPathIsInOpenFailures() {
        let tabs = [PanelTab(tabId: "t1", kind: .document, url: "/repo/gate.xlsx", title: "gate.xlsx")]
        XCTAssertEqual(panelDocumentTabAction(tabs: tabs, path: "/repo/gate.xlsx",
                                              openFailures: ["/repo/gate.xlsx"]),
                       .activate(tabId: "t1", retryOpen: true))
    }

    /// The kind filter is load-bearing — `url` is a field every tab kind carries, so a `.code` tab
    /// pointed at the identical string must never be mistaken for an open document tab.
    func testAMatchingUrlOnANonDocumentTabDoesNotCountAsAMatch() {
        let tabs = [PanelTab(tabId: "t1", kind: .code, url: "/repo/gate.xlsx", title: "gate.xlsx")]
        XCTAssertEqual(panelDocumentTabAction(tabs: tabs, path: "/repo/gate.xlsx", openFailures: []),
                       .mint(title: "gate.xlsx"))
    }

    // MARK: - The model's own copy of the Driver recorder (a per-file copy, mirroring
    // `PanelFilesTabTests`'/`EditorTabTests`' own convention — `ShellSessionHostTests
    // .OfficeDriverRecorder` is private to that file)

    private final class DocumentOfficeDriverRecorder: @unchecked Sendable {
        // T6 review F3: `open` runs off the main actor when driven concurrently (a nested type does
        // NOT inherit its enclosing `@MainActor` test class's isolation) — same lock-backed shape as
        // `ShellSessionHostTests.OfficeDriverRecorder` and this codebase's wider precedent
        // (`ShellScriptedTransport`/`ShellTransportFactory`/`MutableDisk`).
        private let lock = NSLock()
        private var _openCalls: [(docId: String, path: String)] = []
        var openCalls: [(docId: String, path: String)] { lock.lock(); defer { lock.unlock() }; return _openCalls }
        var openMetadata: [String: OfficeDocumentMetadata] = [:]
        var defaultMetadata = OfficeDocumentMetadata(
            type: .text, parts: 1, sizeTwips: OfficeDocumentSize(widthTwips: 100, heightTwips: 100))
        var state: OfficeHelperSupervisor.State = .ready

        var driver: OfficeRuntime.Driver {
            OfficeRuntime.Driver(
                helperState: { [unowned self] in self.state },
                startHelper: { },
                open: { [unowned self] docId, path in
                    self.lock.lock(); self._openCalls.append((docId, path)); self.lock.unlock()
                    return self.openMetadata[path] ?? self.defaultMetadata
                },
                close: { _ in },
                subscribeTiles: { _, _, _, _ in [] },
                unsubscribeTiles: { _ in },
                requestTiles: { _, _ in })
        }
    }

    private var doubles: [AnyObject] = []
    private var runtimes: [OfficeRuntime] = []

    override func setUp() {
        super.setUp()
        doubles = []
        runtimes = []
    }

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
        let (office1, office2) = (DocumentOfficeDriverRecorder(), DocumentOfficeDriverRecorder())
        doubles.append(contentsOf: [office1, office2])
        let host = makeHost(office: office1, perSession: ["S1": office1, "S2": office2])

        host.panelStore.switchSession(to: "S1")
        let tab = PanelTab(tabId: "t1", kind: .document, url: "/a.xlsx", title: nil)
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
        let office = DocumentOfficeDriverRecorder()
        let host = makeHost(office: office)
        let model = PanelDocumentTabModel(tabId: "t1", path: "/a.xlsx")
        model.bind(host: host, sessionId: "S1")
        model.activate()

        let opened = await waitUntil { office.openCalls.count == 1 }
        XCTAssertTrue(opened)
        XCTAssertEqual(office.openCalls.first?.path, "/a.xlsx")

        // A second refresh must NOT re-open — the guard is per (runtime, path), not per call.
        model.refreshForTesting()
        model.refreshForTesting()
        try? await Task.sleep(nanoseconds: 30_000_000)
        XCTAssertEqual(office.openCalls.count, 1, "at most once per (runtime, path)")
    }

    /// The failed-vs-idle gate's own local proof, end to end through the model: `hasRequestedOpen`
    /// flips true only once the deferred open Task has actually fired.
    func testHasRequestedOpenBecomesTrueOnlyAfterTheDeferredOpenFires() async {
        let office = DocumentOfficeDriverRecorder()
        let host = makeHost(office: office)
        let model = PanelDocumentTabModel(tabId: "t1", path: "/a.xlsx")
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
        let office = DocumentOfficeDriverRecorder()
        let host = makeHost(office: office)
        let model = PanelDocumentTabModel(tabId: "t1", path: "/a.xlsx")
        model.bind(host: host, sessionId: "S1")
        model.activate()
        _ = await waitUntil { office.openCalls.count == 1 }

        // The shared helper dies — every runtime in the table (this one included) lands in .failed.
        host.broadcastOfficeHelperEvent(.helperDied)
        XCTAssertEqual(model.runtime?.stateSnapshot.phase, .failed)

        model.retryOpen()
        let retried = await waitUntil { office.openCalls.count == 2 }
        XCTAssertTrue(retried)
        XCTAssertEqual(office.openCalls.map(\.path), ["/a.xlsx", "/a.xlsx"])
    }

    // MARK: - The part-strip door

    private final class RecordingCanvasHost: OfficeDocumentCanvasHost {
        private(set) var requestedParts: [Int] = []
        func setActivePart(_ part: Int) { requestedParts.append(part) }
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
}
