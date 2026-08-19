import XCTest
@testable import Norma

/// office-plumbing Task 6 — the canvas's own pure math: the two unit-chain conversions
/// (`officeViewportTwips`, `officeTileScreenRect`) and the zoom ladder, plus the one behavior worth
/// driving through the REAL view without a window (`setActivePart`'s resubscribe — a plain `NSView`
/// answers `bounds`/`frame` regardless of window membership, which is all `performSubscribe` needs
/// to actually fire). Everything else about the view's actual LOOK is live-gated (no XCTest harness
/// renders `ShellPanel`, matching `EditorTabTests`' own stated posture toward
/// `EditorViewportHostView`'s actual look) — this file pins every DECISION the view makes about
/// where things go, how zoom steps, and when it asks for tiles.
@MainActor
final class OfficeTileCanvasViewTests: XCTestCase {
    private func key(_ x: Int, _ y: Int, part: Int = 0, zoomPPT: Int = 1000) -> TileKey {
        TileKey(part: part, zoomPPT: zoomPPT, tileX: x, tileY: y)
    }

    // MARK: - officeViewportTwips (obligation: viewport -> request chunking math, pure, via TileMath)

    /// The advisor-requested pin: 512pt-wide at `zoomPPT == 1000` is exactly 1024px = 10240 twips —
    /// exactly `TileMath.tileSpanTwips(zoomPPT: 1000) == 5120` twips × 2, i.e. exactly 2 tile spans,
    /// with no scroll offset. Ties the whole unit chain (points -> the fixed 2x scale -> pixels ->
    /// twips) to `TileMath`'s own authoritative constants rather than to an independently-derived
    /// number.
    func testFiveTwelvePointWideViewportAtCanonicalZoomIsExactlyTwoTileSpans() {
        let viewport = officeViewportTwips(scrollOrigin: .zero, visibleSize: CGSize(width: 512, height: 512),
                                           zoomPPT: 1000)
        XCTAssertEqual(viewport.x, 0)
        XCTAssertEqual(viewport.y, 0)
        XCTAssertEqual(viewport.width, 10240)
        XCTAssertEqual(viewport.height, 10240)
        XCTAssertEqual(viewport.width, TileMath.tileSpanTwips(zoomPPT: 1000) * 2)
    }

    func testScrollOriginTranslatesToTheViewportsTwipsOrigin() {
        // 100pt of scroll, at 2x fixed scale, is 200px -> 2000 twips (zoomPPT 1000: 1 twip == 0.1px,
        // so 200px == 2000 twips exactly).
        let viewport = officeViewportTwips(scrollOrigin: CGPoint(x: 100, y: 50),
                                           visibleSize: CGSize(width: 256, height: 256), zoomPPT: 1000)
        XCTAssertEqual(viewport.x, 2000)
        XCTAssertEqual(viewport.y, 1000)
    }

    func testHalfZoomDoublesTheTwipsSpanForTheSamePointSize() {
        // 50% zoom (zoomPPT 500) means each point covers TWICE as many twips as at 100%.
        let full = officeViewportTwips(scrollOrigin: .zero, visibleSize: CGSize(width: 256, height: 256), zoomPPT: 1000)
        let half = officeViewportTwips(scrollOrigin: .zero, visibleSize: CGSize(width: 256, height: 256), zoomPPT: 500)
        XCTAssertEqual(half.width, full.width * 2)
        XCTAssertEqual(half.height, full.height * 2)
    }

    func testZeroSizeViewportIsAZeroAreaRect() {
        let viewport = officeViewportTwips(scrollOrigin: .zero, visibleSize: .zero, zoomPPT: 1000)
        XCTAssertEqual(viewport.width, 0)
        XCTAssertEqual(viewport.height, 0)
    }

    // MARK: - officeTileScreenRect (the inverse unit chain)

    func testTheOriginTileAtCanonicalZoomWithNoScrollIsAt256PointOrigin() {
        let rect = officeTileScreenRect(key: key(0, 0), zoomPPT: 1000, scrollOrigin: .zero)
        XCTAssertEqual(rect, CGRect(x: 0, y: 0, width: 256, height: 256))
    }

    func testTheNextTileOverIsExactlyOneTileWidthAway() {
        let origin = officeTileScreenRect(key: key(0, 0), zoomPPT: 1000, scrollOrigin: .zero)!
        let next = officeTileScreenRect(key: key(1, 0), zoomPPT: 1000, scrollOrigin: .zero)!
        XCTAssertEqual(next.origin.x, origin.origin.x + 256, accuracy: 0.001)
        XCTAssertEqual(next.origin.y, origin.origin.y, accuracy: 0.001)
    }

    func testScrollingShiftsEveryTileScreenRectByTheScrollAmount() {
        let unscrolled = officeTileScreenRect(key: key(0, 0), zoomPPT: 1000, scrollOrigin: .zero)!
        let scrolled = officeTileScreenRect(key: key(0, 0), zoomPPT: 1000, scrollOrigin: CGPoint(x: 40, y: 20))!
        XCTAssertEqual(scrolled.origin.x, unscrolled.origin.x - 40, accuracy: 0.001)
        XCTAssertEqual(scrolled.origin.y, unscrolled.origin.y - 20, accuracy: 0.001)
    }

    func testTileScreenRectSizeIsAlwaysTheFixed256PointSideRegardlessOfZoom() {
        for zoomPPT in [500, 1000, 2000, 4000] {
            let rect = officeTileScreenRect(key: key(0, 0), zoomPPT: zoomPPT, scrollOrigin: .zero)!
            XCTAssertEqual(rect.width, 256, "zoom changes twips-per-tile-span, never the rendered pixel size")
            XCTAssertEqual(rect.height, 256)
        }
    }

    /// Obligation 8: a key `TileMath.tileBoundsTwips` itself refuses (out of `maxTileIndexMagnitude`)
    /// is `nil` here too — never a crash, never a guessed rectangle.
    func testAHostileTileIndexIsRefusedRatherThanPlacedAnywhere() {
        let hostile = key(TileMath.maxTileIndexMagnitude + 1, 0)
        XCTAssertNil(officeTileScreenRect(key: hostile, zoomPPT: 1000, scrollOrigin: .zero))
    }

    // MARK: - The zoom ladder (obligation 9: 50%..400%)

    func testTheLadderSpansFiftyToFourHundredPercent() {
        XCTAssertEqual(officeZoomLadder.first, 500)
        XCTAssertEqual(officeZoomLadder.last, 4000)
        XCTAssertEqual(officeZoomLadder, officeZoomLadder.sorted(), "the ladder must be ascending")
    }

    func testZoomInStepsToTheNextLadderValue() {
        XCTAssertEqual(officeZoomIn(current: 1000), 1250)
        XCTAssertEqual(officeZoomIn(current: 1250), 1500)
    }

    func testZoomInClampsAtTheCeiling() {
        XCTAssertEqual(officeZoomIn(current: 4000), 4000)
    }

    func testZoomOutStepsToThePreviousLadderValue() {
        XCTAssertEqual(officeZoomOut(current: 1000), 750)
        XCTAssertEqual(officeZoomOut(current: 750), 500)
    }

    func testZoomOutClampsAtTheFloor() {
        XCTAssertEqual(officeZoomOut(current: 500), 500)
    }

    /// A pinch-zoomed value that lands BETWEEN two ladder steps snaps to the step past it in the
    /// direction of travel, not to the nearest OFFICIAL stop — one real step from wherever the user
    /// actually is.
    func testZoomInFromAnOffLadderValueStepsPastTheNextLadderValueAbove() {
        XCTAssertEqual(officeZoomIn(current: 1180), 1250)
    }

    func testZoomOutFromAnOffLadderValueStepsPastTheNextLadderValueBelow() {
        XCTAssertEqual(officeZoomOut(current: 820), 750)
    }

    func testZoomInAndOutAreExactInversesAcrossTheWholeLadder() {
        for value in officeZoomLadder.dropLast() {
            XCTAssertEqual(officeZoomOut(current: officeZoomIn(current: value)), value)
        }
    }

    // MARK: - setActivePart resubscribes (driven through the REAL view, no window needed —
    // `bounds`/`frame` answer regardless of window membership, which is all `performSubscribe` reads)

    /// A per-file copy, mirroring `PanelDocumentTabTests.DocumentOfficeDriverRecorder`'s own
    /// convention (`ShellSessionHostTests.OfficeDriverRecorder` is private to that file) — captures
    /// the FULL `subscribeTiles` call, unlike the other files' recorders, since this is the one
    /// place a test needs to see the `part` argument itself.
    private final class SubscribeCapturingDriverRecorder: @unchecked Sendable {
        // T6 review F3: `subscribeTiles` runs off the main actor when driven concurrently (a nested
        // type does NOT inherit its enclosing `@MainActor` test class's isolation) — same lock-backed
        // shape as `ShellSessionHostTests.OfficeDriverRecorder`/`PanelDocumentTabTests
        // .DocumentOfficeDriverRecorder` and this codebase's wider precedent.
        private let lock = NSLock()
        private var _subscribeCalls: [(docId: String, part: Int, zoomPPT: Int, viewportTwips: OfficeTwipsRect)] = []
        var subscribeCalls: [(docId: String, part: Int, zoomPPT: Int, viewportTwips: OfficeTwipsRect)] {
            lock.lock(); defer { lock.unlock() }; return _subscribeCalls
        }
        var driver: OfficeRuntime.Driver {
            OfficeRuntime.Driver(
                helperState: { .ready }, startHelper: { },
                open: { docId, _ in OfficeDocumentMetadata(type: .text, parts: 1,
                                                            sizeTwips: OfficeDocumentSize(widthTwips: 100_000, heightTwips: 100_000)) },
                close: { _ in },
                subscribeTiles: { [unowned self] docId, part, zoomPPT, viewportTwips in
                    self.lock.lock(); self._subscribeCalls.append((docId, part, zoomPPT, viewportTwips)); self.lock.unlock()
                    return []
                },
                unsubscribeTiles: { _ in },
                requestTiles: { _, _ in })
        }
    }

    private func waitUntil(timeout: TimeInterval = 2, _ condition: () -> Bool) async -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition() {
            if Date() >= deadline { return false }
            try? await Task.sleep(nanoseconds: 5_000_000)
        }
        return true
    }

    /// Both tests below need a runtime whose document is ALREADY OPEN before the canvas ever mounts
    /// — `OfficeRuntimeReducer.subscribeRequested`'s own guard is `phase == .ready && documents[path]
    /// != nil`; a `subscribeTiles` call against a runtime that never opened anything is a pure no-op
    /// (`(next, [])`, no effect at all), which is exactly what `PanelDocumentTabModel
    /// .requestOpenIfNeeded` would have already done for a real tab before its canvas ever mounts.
    private func makeOpenedRuntime(path: String = "/gate.xlsx") async
        -> (runtime: OfficeRuntime, recorder: SubscribeCapturingDriverRecorder) {
        let recorder = SubscribeCapturingDriverRecorder()
        let runtime = OfficeRuntime(sessionId: "S1", driver: recorder.driver)
        runtime.open(path)
        _ = await waitUntil { runtime.stateSnapshot.documents[path] != nil }
        return (runtime, recorder)
    }

    /// **The brief's own named test.** `mount()` alone (part 0) fires the first subscribe;
    /// `setActivePart(1)` must fire a SECOND one, immediately (obligation: bypasses the throttle —
    /// a part switch is discrete, not a continuation of a scroll burst), carrying the NEW part.
    func testSettingActivePartOnAMountedCanvasResubscribesImmediatelyWithTheNewPart() async {
        let (runtime, recorder) = await makeOpenedRuntime()
        let model = PanelDocumentTabModel(tabId: "t1", path: "/gate.xlsx")
        let sizeTwips = OfficeDocumentSize(widthTwips: 100_000, heightTwips: 100_000)
        let view = OfficeTileCanvasView(runtime: runtime, path: "/gate.xlsx", docId: "doc-1",
                                        sizeTwips: sizeTwips, initialPart: 0, model: model)
        view.frame = NSRect(x: 0, y: 0, width: 300, height: 300)

        view.mount()
        let firstSubscribed = await waitUntil { recorder.subscribeCalls.count == 1 }
        XCTAssertTrue(firstSubscribed)
        guard firstSubscribed else { return } // never index an array a failed wait left possibly empty
        XCTAssertEqual(recorder.subscribeCalls[0].part, 0)

        view.setActivePart(1)
        let secondSubscribed = await waitUntil { recorder.subscribeCalls.count == 2 }
        XCTAssertTrue(secondSubscribed, "the part switch must resubscribe, not merely change `part` locally")
        guard secondSubscribed else { return }
        XCTAssertEqual(recorder.subscribeCalls[1].part, 1)
        XCTAssertEqual(view.part, 1)

        // Idempotent: re-asking for the SAME part must not fire a redundant third subscribe.
        view.setActivePart(1)
        try? await Task.sleep(nanoseconds: 30_000_000)
        XCTAssertEqual(recorder.subscribeCalls.count, 2, "no-op when the part already matches")

        view.unmount() // hygiene — see the other files' identical comment on settling before teardown
    }

    /// The registered `OfficeDocumentCanvasHost` — proves the model's `selectPart` door
    /// (`PanelDocumentTabModel.selectPart`, `PanelDocumentTabTests` own its unit test) reaches a
    /// REAL mounted canvas end to end, not just a test double conforming to the protocol.
    func testMountRegistersTheViewAsTheModelsCanvasHostAndUnmountClearsIt() async {
        let (runtime, recorder) = await makeOpenedRuntime()
        let model = PanelDocumentTabModel(tabId: "t1", path: "/gate.xlsx")
        let sizeTwips = OfficeDocumentSize(widthTwips: 100_000, heightTwips: 100_000)
        let view = OfficeTileCanvasView(runtime: runtime, path: "/gate.xlsx", docId: "doc-1",
                                        sizeTwips: sizeTwips, initialPart: 0, model: model)
        view.frame = NSRect(x: 0, y: 0, width: 300, height: 300)

        view.mount()
        XCTAssertTrue(model.canvasHost === view)

        model.selectPart(2)
        let resubscribed = await waitUntil { recorder.subscribeCalls.contains { $0.part == 2 } }
        XCTAssertTrue(resubscribed, "the model's own door reaches the mounted canvas")

        view.unmount()
        XCTAssertNil(model.canvasHost, "unmount clears the registration")
    }
}
