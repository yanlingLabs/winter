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

    // MARK: - syncDocumentIdentity: the reload seam (office-plumbing Task 8, T6 review F4)

    /// **The F4 pin.** A docId change must (a) actually update `docId` — the property `applyContents`
    /// and the `tilesArrived` filter both compare against, the exact thing that was silently stale
    /// before this task — and (b) resubscribe, immediately, so the new docId's tiles are ever asked
    /// for at all. Without either half, every tile after a reload is a permanent placeholder.
    func testSyncDocumentIdentityWithANewDocIdUpdatesTheCanvasAndResubscribes() async {
        let (runtime, recorder) = await makeOpenedRuntime()
        let model = PanelDocumentTabModel(tabId: "t1", path: "/gate.xlsx")
        let sizeTwips = OfficeDocumentSize(widthTwips: 100_000, heightTwips: 100_000)
        let view = OfficeTileCanvasView(runtime: runtime, path: "/gate.xlsx", docId: "doc-1",
                                        sizeTwips: sizeTwips, initialPart: 0, model: model)
        view.frame = NSRect(x: 0, y: 0, width: 300, height: 300)
        view.mount()
        _ = await waitUntil { recorder.subscribeCalls.count == 1 }
        XCTAssertEqual(view.docId, "doc-1")

        let newSizeTwips = OfficeDocumentSize(widthTwips: 200_000, heightTwips: 200_000)
        view.syncDocumentIdentity(docId: "doc-2", sizeTwips: newSizeTwips, activePart: 0)

        XCTAssertEqual(view.docId, "doc-2", "T6 review F4: the canvas must track the reload's new "
                       + "docId — a stale copy is a permanent placeholder")
        let resubscribed = await waitUntil { recorder.subscribeCalls.count == 2 }
        XCTAssertTrue(resubscribed, "a docId change must resubscribe — the new docId's tiles are "
                      + "never asked for otherwise")

        view.unmount()
    }

    /// **The preservation half.** A `.id(docId)`-on-the-representable fix (the review's OTHER named
    /// option, deliberately not taken) would tear down and rebuild this view on every reload,
    /// resetting `scrollOrigin`/`zoomPPT` to their defaults — exactly what this task exists to
    /// PRESERVE. Proven at the observable level: the resubscribe's own viewport must still reflect
    /// the scrolled position established BEFORE the reload, not a reset-to-origin one.
    func testSyncDocumentIdentityWithANewDocIdPreservesTheScrollPosition() async {
        let (runtime, recorder) = await makeOpenedRuntime()
        let model = PanelDocumentTabModel(tabId: "t1", path: "/gate.xlsx")
        let sizeTwips = OfficeDocumentSize(widthTwips: 1_000_000, heightTwips: 1_000_000)
        let view = OfficeTileCanvasView(runtime: runtime, path: "/gate.xlsx", docId: "doc-1",
                                        sizeTwips: sizeTwips, initialPart: 0, model: model)
        view.frame = NSRect(x: 0, y: 0, width: 300, height: 300)
        view.mount()
        _ = await waitUntil { recorder.subscribeCalls.count == 1 }

        view.setScrollOriginForTesting(CGPoint(x: 400, y: 250))
        let scrolled = view.scrollOriginForTesting
        XCTAssertGreaterThan(scrolled.x, 0, "sanity: the scroll actually took effect and was not "
                             + "immediately clamped back to zero by the tiny document size")

        view.syncDocumentIdentity(docId: "doc-2", sizeTwips: sizeTwips, activePart: 0)

        XCTAssertEqual(view.scrollOriginForTesting, scrolled, "the same document size reloaded must "
                       + "not move the scroll position at all — it was never reset, only re-clamped")
        _ = await waitUntil { recorder.subscribeCalls.count == 2 }
        let secondViewport = recorder.subscribeCalls[1].viewportTwips
        XCTAssertGreaterThan(secondViewport.x, 0, "the RESUBSCRIBE after reload must ask for the "
                             + "scrolled viewport, not a reset-to-origin one — this is what `.id"
                             + "(docId)` would have broken")

        view.unmount()
    }

    /// The other third of `{activePart, scrollTwips, zoomPPT}`: `syncDocumentIdentity` never touches
    /// `zoomPPT` at all, so preservation is true by construction — pinned against a NON-default value
    /// so the claim is not vacuously true of the 100% starting point every other test leaves it at.
    func testSyncDocumentIdentityWithANewDocIdPreservesTheZoomLevel() async {
        let (runtime, recorder) = await makeOpenedRuntime()
        let model = PanelDocumentTabModel(tabId: "t1", path: "/gate.xlsx")
        let sizeTwips = OfficeDocumentSize(widthTwips: 1_000_000, heightTwips: 1_000_000)
        let view = OfficeTileCanvasView(runtime: runtime, path: "/gate.xlsx", docId: "doc-1",
                                        sizeTwips: sizeTwips, initialPart: 0, model: model)
        view.frame = NSRect(x: 0, y: 0, width: 300, height: 300)
        view.mount()
        _ = await waitUntil { recorder.subscribeCalls.count == 1 }

        XCTAssertTrue(view.setZoomForTesting(2000))
        XCTAssertEqual(view.zoomPPT, 2000, "sanity")
        _ = await waitUntil { recorder.subscribeCalls.count == 2 } // the zoom change's own resubscribe

        view.syncDocumentIdentity(docId: "doc-2", sizeTwips: sizeTwips, activePart: 0)

        XCTAssertEqual(view.zoomPPT, 2000, "a reload must not reset zoom back to the 100% default")
        let reloadResubscribed = await waitUntil { recorder.subscribeCalls.count == 3 }
        XCTAssertTrue(reloadResubscribed)
        XCTAssertEqual(recorder.subscribeCalls[2].zoomPPT, 2000, "the RESUBSCRIBE after reload must "
                       + "ask at the preserved zoom, not the 100% default")

        view.unmount()
    }

    /// T8 interface obligation 3: a reload's fresh `sizeTwips` must actually be consumed — the scroll
    /// clamp is a function of it, so a document that shrank must pull an out-of-bounds scroll back in.
    func testSyncDocumentIdentityReClampsScrollAgainstTheFreshSizeTwips() async {
        let (runtime, recorder) = await makeOpenedRuntime()
        let model = PanelDocumentTabModel(tabId: "t1", path: "/gate.xlsx")
        let largeSize = OfficeDocumentSize(widthTwips: 2_000_000, heightTwips: 2_000_000)
        let view = OfficeTileCanvasView(runtime: runtime, path: "/gate.xlsx", docId: "doc-1",
                                        sizeTwips: largeSize, initialPart: 0, model: model)
        view.frame = NSRect(x: 0, y: 0, width: 300, height: 300)
        view.mount()
        _ = await waitUntil { recorder.subscribeCalls.count == 1 }
        view.setScrollOriginForTesting(CGPoint(x: 5000, y: 5000)) // deep into the large document
        let deepScroll = view.scrollOriginForTesting
        XCTAssertGreaterThan(deepScroll.x, 100, "sanity: genuinely scrolled far from the origin")

        // The reload's own document is much smaller — the old scroll position is now out of bounds.
        let tinySize = OfficeDocumentSize(widthTwips: 100, heightTwips: 100)
        view.syncDocumentIdentity(docId: "doc-2", sizeTwips: tinySize, activePart: 0)

        XCTAssertLessThan(view.scrollOriginForTesting.x, deepScroll.x, "T8 obligation 3: the fresh, "
                          + "smaller sizeTwips must actually be consumed by the clamp, not the stale "
                          + "large one the view was constructed with")

        // Hygiene, not an assertion (task-6-report's own recipe note, repeated by every sibling test
        // in this file): `syncDocumentIdentity`'s own docId change fires a SECOND resubscribe —
        // settle it before `unmount()`/return lets `recorder` deallocate, or the still-in-flight
        // Task's `[unowned self]` closure crashes the whole process the moment it resumes.
        _ = await waitUntil { recorder.subscribeCalls.count == 2 }

        view.unmount()
    }

    /// The `else` branch — a `syncDocumentIdentity` call carrying the SAME docId (what `updateNSView`
    /// sends on every ordinary render, reload or not) must degrade to exactly the pre-Task-8 drift
    /// re-assert: idempotent, no extra resubscribe.
    func testSyncDocumentIdentityWithTheSameDocIdIsTheOrdinaryDriftReassertNotAReload() async {
        let (runtime, recorder) = await makeOpenedRuntime()
        let model = PanelDocumentTabModel(tabId: "t1", path: "/gate.xlsx")
        let sizeTwips = OfficeDocumentSize(widthTwips: 100_000, heightTwips: 100_000)
        let view = OfficeTileCanvasView(runtime: runtime, path: "/gate.xlsx", docId: "doc-1",
                                        sizeTwips: sizeTwips, initialPart: 0, model: model)
        view.frame = NSRect(x: 0, y: 0, width: 300, height: 300)
        view.mount()
        _ = await waitUntil { recorder.subscribeCalls.count == 1 }

        view.syncDocumentIdentity(docId: "doc-1", sizeTwips: sizeTwips, activePart: 0)

        try? await Task.sleep(nanoseconds: 30_000_000)
        XCTAssertEqual(recorder.subscribeCalls.count, 1, "the SAME docId, SAME part must not "
                       + "resubscribe — this is the ordinary re-render path, not a reload")
        XCTAssertEqual(view.docId, "doc-1")

        view.unmount()
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
