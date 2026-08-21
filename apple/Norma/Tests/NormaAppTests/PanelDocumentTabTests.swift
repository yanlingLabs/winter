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
        XCTAssertNil(officeSaveMenuTarget(tabs: [document], activeTabId: nil))
        XCTAssertNil(officeSaveMenuTarget(tabs: [], activeTabId: "t1"))
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
