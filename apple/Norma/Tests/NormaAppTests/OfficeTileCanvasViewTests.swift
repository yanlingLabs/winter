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

    // MARK: - office live-gate fix #3: whole-document tile residency — pure functions

    /// A document whose full extent is EXACTLY the cap is eligible — `<=`, not `<`.
    func testResidencyEligibleAtExactlyTheCap() {
        // 2x2 tiles at zoomPPT 1000 (tileSpanTwips 5120): a 10240x10240 twips document is exactly 4 tiles.
        let sizeTwips = OfficeDocumentSize(widthTwips: 10240, heightTwips: 10240)
        XCTAssertEqual(officeResidencyEligibleTileCount(sizeTwips: sizeTwips, zoomPPT: 1000, cap: 4), 4)
    }

    /// One tile past the cap is refused — the safe direction (never "try anyway").
    func testResidencyIneligibleOneTilePastTheCap() {
        // 3x2 = 6 tiles: one axis spans 3 tile widths (15360 twips), the other 2 (10240 twips).
        let sizeTwips = OfficeDocumentSize(widthTwips: 15360, heightTwips: 10240)
        XCTAssertNil(officeResidencyEligibleTileCount(sizeTwips: sizeTwips, zoomPPT: 1000, cap: 4))
    }

    /// A degenerate empty document is trivially eligible — `0`, not `nil`: there is nothing to
    /// prefetch, which is a valid (instant) answer, not a refusal.
    func testResidencyEligibleForAZeroSizeDocumentReturnsZero() {
        let sizeTwips = OfficeDocumentSize(widthTwips: 0, heightTwips: 0)
        XCTAssertEqual(officeResidencyEligibleTileCount(sizeTwips: sizeTwips, zoomPPT: 1000, cap: 128), 0)
    }

    /// A document `TileMath.estimatedTileCount` itself refuses to enumerate (past
    /// `maxTilesPerRectEnumeration`) reads as ineligible too, even against a huge `cap` — this
    /// function never attempts what TileMath itself would refuse.
    func testResidencyIneligibleWhenTileMathItselfRefusesToEnumerate() {
        let sizeTwips = OfficeDocumentSize(widthTwips: 2_000_000, heightTwips: 2_000_000)
        XCTAssertNil(officeResidencyEligibleTileCount(sizeTwips: sizeTwips, zoomPPT: 1000, cap: 1_000_000))
    }

    /// A cap of 0 makes every REAL document ineligible — the "before" toggle the live-gate MEASURE
    /// step uses to compare against "after" from the same instrumented binary (only a genuinely
    /// empty document, 0 tiles, is `<= 0`).
    func testResidencyCapZeroForcesEveryRealDocumentIneligible() {
        let sizeTwips = OfficeDocumentSize(widthTwips: 5120, heightTwips: 5120) // exactly 1 tile
        XCTAssertNil(officeResidencyEligibleTileCount(sizeTwips: sizeTwips, zoomPPT: 1000, cap: 0))
    }

    /// The ordering's own named contract: visible keys come first, in `TileMath.viewportTileKeys`'s
    /// own row-major order, and every OTHER key in the full extent follows — none dropped, none
    /// duplicated.
    func testResidencyPrefetchOrderPutsVisibleKeysFirstThenCoversEveryRemainingKeyExactlyOnce() {
        // A 4x4 tile extent (20480x20480 twips at zoomPPT 1000); the visible viewport is the top-left
        // 2x2 tiles (10240x10240).
        let fullExtent = OfficeTwipsRect(x: 0, y: 0, width: 20480, height: 20480)
        let visibleViewport = OfficeTwipsRect(x: 0, y: 0, width: 10240, height: 10240)
        let order = officeResidencyPrefetchOrder(part: 0, zoomPPT: 1000, fullExtentTwips: fullExtent,
                                                 visibleViewportTwips: visibleViewport)
        let visible = TileMath.viewportTileKeys(part: 0, zoomPPT: 1000, viewportTwips: visibleViewport)
        XCTAssertEqual(Array(order.prefix(visible.count)), visible, "visible keys lead, in TileMath's own order")

        let expectedAll = Set(TileMath.tileCoordinates(rectTwips: fullExtent, zoomPPT: 1000)
            .map { TileKey(part: 0, zoomPPT: 1000, tileX: $0.tileX, tileY: $0.tileY) })
        XCTAssertEqual(Set(order), expectedAll, "every tile in the full extent appears — none dropped")
        XCTAssertEqual(order.count, Set(order).count, "none duplicated")
        XCTAssertEqual(order.count, 16, "sanity: a 4x4 extent is 16 tiles")
    }

    /// The "rest" half is genuinely nearest-to-farthest from the visible viewport's own center —
    /// proven by hand against a small, fully-enumerable extent where the correct order is obvious by
    /// inspection.
    func testResidencyPrefetchOrderOrdersTheRestNearestToFarthestFromTheVisibleCenter() {
        // A 1x3 row of tiles; the visible viewport is tile (0,0) alone. The center of a single tile's
        // viewport is that tile's own coordinate, so the rest — (1,0) then (2,0) — must come out in
        // exactly that order: (1,0) is one step away, (2,0) is two.
        let fullExtent = OfficeTwipsRect(x: 0, y: 0, width: 5120 * 3, height: 5120)
        let visibleViewport = OfficeTwipsRect(x: 0, y: 0, width: 5120, height: 5120)
        let order = officeResidencyPrefetchOrder(part: 0, zoomPPT: 1000, fullExtentTwips: fullExtent,
                                                 visibleViewportTwips: visibleViewport)
        XCTAssertEqual(order, [
            TileKey(part: 0, zoomPPT: 1000, tileX: 0, tileY: 0),
            TileKey(part: 0, zoomPPT: 1000, tileX: 1, tileY: 0),
            TileKey(part: 0, zoomPPT: 1000, tileX: 2, tileY: 0),
        ])
    }

    /// A zero-area visible viewport (a canvas not yet laid out) degenerates gracefully: nothing is
    /// "visible first," but the full extent is still covered — TileMath itself never traps on this,
    /// and neither does this function.
    func testResidencyPrefetchOrderWithAnEmptyVisibleViewportStillCoversTheWholeExtent() {
        let fullExtent = OfficeTwipsRect(x: 0, y: 0, width: 10240, height: 10240)
        let order = officeResidencyPrefetchOrder(part: 0, zoomPPT: 1000, fullExtentTwips: fullExtent,
                                                 visibleViewportTwips: OfficeTwipsRect(x: 0, y: 0, width: 0, height: 0))
        XCTAssertEqual(order.count, 4, "a 2x2 extent is 4 tiles, all present even with nothing 'visible'")
    }

    // MARK: - office live-gate fix #3: officeChunked

    func testChunkedSplitsIntoEvenGroupsPreservingOrder() {
        let keys = (0..<9).map { key($0, 0) }
        let chunks = officeChunked(keys, size: 3)
        XCTAssertEqual(chunks, [
            Array(keys[0..<3]), Array(keys[3..<6]), Array(keys[6..<9]),
        ])
    }

    func testChunkedLastGroupCarriesTheRemainder() {
        let keys = (0..<7).map { key($0, 0) }
        let chunks = officeChunked(keys, size: 3)
        XCTAssertEqual(chunks.map(\.count), [3, 3, 1])
        XCTAssertEqual(chunks.flatMap { $0 }, keys, "no key dropped or reordered")
    }

    func testChunkedOnEmptyInputProducesNoChunks() {
        XCTAssertEqual(officeChunked([], size: 6), [])
    }

    func testChunkedWithNonPositiveSizeDegradesToOneChunkPerKeyRatherThanLoopingForeverOrTrapping() {
        let keys = [key(0, 0), key(1, 0)]
        XCTAssertEqual(officeChunked(keys, size: 0), [[key(0, 0)], [key(1, 0)]])
        XCTAssertEqual(officeChunked(keys, size: -3), [[key(0, 0)], [key(1, 0)]])
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
        /// office live-gate fix #4, FIX 2: `OfficeTileCanvasView.isSpreadsheet` reads this back via
        /// `runtime.stateSnapshot.documents[path]?.type` — every OTHER test in this file relies on
        /// the pre-existing `.text` default (the infinite-grid margin must stay INERT for them), so
        /// this is a constructor default, never a hardcoded literal inside `driver` below.
        private let documentType: OfficeDocumentKind
        init(documentType: OfficeDocumentKind = .text) { self.documentType = documentType }
        var driver: OfficeRuntime.Driver {
            OfficeRuntime.Driver(
                helperState: { .ready }, startHelper: { },
                open: { [documentType] docId, _ in OfficeDocumentMetadata(
                    type: documentType, parts: 1,
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
    private func makeOpenedRuntime(path: String = "/gate.xlsx", documentType: OfficeDocumentKind = .text) async
        -> (runtime: OfficeRuntime, recorder: SubscribeCapturingDriverRecorder) {
        let recorder = SubscribeCapturingDriverRecorder(documentType: documentType)
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

    // MARK: - the hosting layer clips (Bug 1, office live gate: tile overdraw outside the sidebar)

    /// **The fix itself.** Unconditional and set once, in `init`, before any tile is ever laid out —
    /// no window where a first relayout could paint before the clip is armed. A freshly-vended
    /// `CALayer` (including AppKit's own auto-backing layer for `wantsLayer = true`) defaults
    /// `masksToBounds` to `false` — see `init`'s own comment for why this view, unlike
    /// `PanelCEFContainerView`/`EditorViewportHostView`, actually needs it set explicitly.
    func testHostingLayerMasksSublayersToBounds() async {
        // Never mounts, so `recorder`'s `[unowned self]` driver closures are never actually called
        // (`init` touches neither the driver nor the runtime) — no retention hazard here the way the
        // NEXT test has (see that one's own comment). `_` would be fine; bound anyway for symmetry.
        let (runtime, _) = await makeOpenedRuntime()
        let model = PanelDocumentTabModel(tabId: "t1", path: "/gate.xlsx")
        let sizeTwips = OfficeDocumentSize(widthTwips: 100_000, heightTwips: 100_000)
        let view = OfficeTileCanvasView(runtime: runtime, path: "/gate.xlsx", docId: "doc-1",
                                        sizeTwips: sizeTwips, initialPart: 0, model: model)
        XCTAssertEqual(view.layer?.masksToBounds, true,
                       "without this, a tile straddling the viewport's edge (routine — see the next "
                       + "test) paints past this view's own frame into whatever the panel stacks "
                       + "beyond it, which is the live-gate's own \"leaks outside the sidebar border\" "
                       + "report")
    }

    /// **Proves the clip is load-bearing, not defensive-but-unreachable.** A 300pt-square viewport
    /// against the fixed 256pt tile grid, at zero scroll, ALWAYS needs a tile whose screen rect
    /// extends to 512pt on at least one axis — `TileMath.viewportTileKeys` has to ask for the tile
    /// covering screen-space [256,512) to paint the sliver of it inside [0,300), and nothing about
    /// that tile's own rect knows to stop at 300. Also pins the weaker, always-true invariant
    /// (`relayoutVisibleTiles` never keeps a layer the viewport doesn't even touch) — reads straight
    /// off `view.layer?.sublayers`, so no new production accessor was needed for either assertion.
    func testRelayoutRoutinelyPositionsATileLayerPastTheViewsOwnEdge() async {
        let (runtime, recorder) = await makeOpenedRuntime()
        let model = PanelDocumentTabModel(tabId: "t1", path: "/gate.xlsx")
        // Large enough that the 300pt viewport below sits nowhere near the DOCUMENT's own far edge —
        // this test is about the TILE GRID straddling the VIEWPORT's edge, not the document's.
        let sizeTwips = OfficeDocumentSize(widthTwips: 1_000_000, heightTwips: 1_000_000)
        let view = OfficeTileCanvasView(runtime: runtime, path: "/gate.xlsx", docId: "doc-1",
                                        sizeTwips: sizeTwips, initialPart: 0, model: model)
        view.frame = NSRect(x: 0, y: 0, width: 300, height: 300)
        view.mount() // synchronously calls relayoutVisibleTiles() — see mount()'s own body

        // **Load-bearing, not hygiene**: `mount()` also fires `performSubscribe()`, which dispatches
        // a `.subscribe` effect that reaches `driver.subscribeTiles` from inside a detached `Task`
        // (`OfficeRuntime.perform`'s own `.subscribe` case) — fire-and-forget from `mount()`'s own
        // perspective. `SubscribeCapturingDriverRecorder`'s closures capture the recorder
        // `[unowned self]` (mirroring every production Driver's own assumption that ITS owner
        // outlives it), so if this function returned (and `recorder` fell out of scope) before that
        // Task actually ran, the Task would later read a DANGLING `unowned self` and crash the whole
        // test host — measured directly, mid fix-round: a dummy `_ = recorder` placed right after the
        // `let` above does NOT fix this (it is itself `recorder`'s last syntactic use at that point,
        // so ARC is free to deallocate immediately, no later than end of scope — and the Task can
        // easily still be pending past that). Awaiting the subscribe here, the same way
        // `testSettingActivePartOnAMountedCanvasResubscribesImmediatelyWithTheNewPart` (above) already
        // does, is what actually closes the race: `recorder` stays alive for as long as this polling
        // closure keeps reading it, which is until the async call has genuinely landed.
        let subscribed = await waitUntil { recorder.subscribeCalls.count >= 1 }
        XCTAssertTrue(subscribed, "mount() must still ask for tiles — this test is about geometry, "
                      + "not about breaking the subscribe path")

        let sublayers = view.layer?.sublayers ?? []
        XCTAssertFalse(sublayers.isEmpty, "a 300x300 viewport over a large document must have tiles")
        for sublayer in sublayers {
            XCTAssertTrue(sublayer.frame.intersects(view.bounds),
                          "relayout must never keep a layer for a tile the viewport does not even "
                          + "touch — \(sublayer.frame) vs bounds \(view.bounds)")
        }
        XCTAssertTrue(sublayers.contains { !view.bounds.contains($0.frame) },
                      "at least one tile must genuinely extend past bounds — a 300pt viewport over a "
                      + "256pt tile grid always has one at zero scroll; if this ever stops being true "
                      + "the masksToBounds fix above would have nothing left to prove")

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

    // MARK: - office live-gate fix #2: free-scroll accumulation (Bug 2)
    //
    // Two hypotheses were investigated and falsified by direct measurement, not merely by reading,
    // before this fix was written: `scrollOrigin` never had any quantization to the 256pt tile grid
    // (the controller's own lead — `clampedOriginX/Y` clamp only, they never round), and
    // repositioning a tile's `CALayer` was never implicitly animated by CoreAnimation either (a
    // second, self-generated hypothesis — measured directly via `animationKeys()`, headless AND in
    // a real on-screen window: empty both times, because AppKit disables implicit layer actions by
    // default outside an explicit animation context, unlike bare Core Animation/UIKit — before being
    // discarded). The tests below pin the two claims that survive: accumulation is exact, and the
    // REAL fix (async tile-content latency, addressed by `performSubscribe`'s margin below) is what
    // a human live gate should now judge.

    /// **The task's own named pin**: a sequence of small, fractional deltas accumulates into
    /// `scrollOrigin` EXACTLY — no rounding, no snapping to the 256pt tile grid. Deltas are negative
    /// (see `applyScrollDelta`'s own `origin -= delta` convention) so the origin moves AWAY from the
    /// zero-clamp at the document's near edge, leaving room to accumulate instead of clamping away
    /// every call.
    func testFreeScrollAccumulatesRawDeltasExactlyNeverQuantizedToATileLine() async {
        let (runtime, _) = await makeOpenedRuntime()
        let model = PanelDocumentTabModel(tabId: "t1", path: "/gate.xlsx")
        // Far larger than anything these tiny deltas could reach — this test is about the
        // ACCUMULATION, not the edge clamp (that is the next test's own job).
        let sizeTwips = OfficeDocumentSize(widthTwips: 2_000_000, heightTwips: 2_000_000)
        let view = OfficeTileCanvasView(runtime: runtime, path: "/gate.xlsx", docId: "doc-1",
                                        sizeTwips: sizeTwips, initialPart: 0, model: model)
        view.frame = NSRect(x: 0, y: 0, width: 300, height: 300)

        let deltas: [(dx: CGFloat, dy: CGFloat)] = [
            (-1.3, -0.7), (-2.9, -5.1), (-0.4, -1.1), (-7.0, -3.3), (-0.05, -0.02)
        ]
        var expectedX: CGFloat = 0
        var expectedY: CGFloat = 0
        for delta in deltas {
            view.applyScrollDelta(dx: delta.dx, dy: delta.dy)
            expectedX -= delta.dx
            expectedY -= delta.dy
        }

        XCTAssertEqual(view.scrollOriginForTesting.x, expectedX, accuracy: 0.0001, "free scroll must "
                       + "accumulate the exact raw deltas — a snap to the 256pt tile grid would have "
                       + "landed on a multiple of 256, not \(expectedX)")
        XCTAssertEqual(view.scrollOriginForTesting.y, expectedY, accuracy: 0.0001)
    }

    /// The other half of the task's own pin: the ONLY thing that may stop free accumulation is the
    /// document edge — proven by showing the clamp is idempotent (a second, even larger overshoot
    /// lands at the exact same place as the first), which a tile-line snap could never produce
    /// (a further overshoot would snap to a DIFFERENT, further-along grid line instead).
    func testFreeScrollClampsOnlyAtTheDocumentEdgeIdempotentlyNotAtATileLine() async {
        let (runtime, _) = await makeOpenedRuntime()
        let model = PanelDocumentTabModel(tabId: "t1", path: "/gate.xlsx")
        let sizeTwips = OfficeDocumentSize(widthTwips: 100_000, heightTwips: 100_000) // small — an overshoot is cheap to reach
        let view = OfficeTileCanvasView(runtime: runtime, path: "/gate.xlsx", docId: "doc-1",
                                        sizeTwips: sizeTwips, initialPart: 0, model: model)
        view.frame = NSRect(x: 0, y: 0, width: 300, height: 300)

        view.applyScrollDelta(dx: -1_000_000, dy: -1_000_000) // wildly overshoots the far edge
        let firstOvershoot = view.scrollOriginForTesting
        XCTAssertGreaterThan(firstOvershoot.x, 0, "sanity: actually moved, not stuck at the near edge")

        view.applyScrollDelta(dx: -1_000_000, dy: -1_000_000) // an even larger overshoot
        XCTAssertEqual(view.scrollOriginForTesting, firstOvershoot, "clamped at the SAME document "
                       + "edge both times — a tile-line snap would instead have landed on a further, "
                       + "different grid line for the larger overshoot")
    }

    // MARK: - office live-gate fix #2: the actual root cause — tile-content latency (Bugs 1 & 2)

    /// **The real fix.** `performSubscribe` must ask the store for a viewport padded by one tile
    /// span beyond what is actually on screen — the mechanism traced to both bugs: with no margin,
    /// every scroll tick that crosses a 256pt tile line exposes a tile nobody has asked for yet,
    /// visible only as the placeholder tone until an async round trip lands.
    func testPerformSubscribePadsTheViewportByOneTileSpanBeyondWhatIsVisible() async {
        let (runtime, recorder) = await makeOpenedRuntime()
        let model = PanelDocumentTabModel(tabId: "t1", path: "/gate.xlsx")
        let sizeTwips = OfficeDocumentSize(widthTwips: 2_000_000, heightTwips: 2_000_000)
        let view = OfficeTileCanvasView(runtime: runtime, path: "/gate.xlsx", docId: "doc-1",
                                        sizeTwips: sizeTwips, initialPart: 0, model: model)
        view.frame = NSRect(x: 0, y: 0, width: 300, height: 300)
        // Comfortably clear of the near edge, so the margin below is never itself clamped away —
        // this test is about the padding amount, not the edge case (the next test owns that).
        view.setScrollOriginForTesting(CGPoint(x: 1000, y: 1000))

        view.mount()
        let subscribed = await waitUntil { recorder.subscribeCalls.count >= 1 }
        XCTAssertTrue(subscribed)
        guard subscribed else { return }

        // Hand-built against the SAME pure `officeViewportTwips` production uses, padded by hand —
        // pins the CONTRACT (exactly one tile span on every edge) without reaching into the view's
        // own private margin constant. One tile span in POINTS is 256 — `TileMath.tilePixelSize` is
        // in PIXELS (512), and `officeTileScreenRect`'s own `sidePoints` comment already states the
        // /2x-device-scale result directly: "256pt, fixed regardless of zoom".
        let margin: CGFloat = 256
        let tightViewport = officeViewportTwips(scrollOrigin: CGPoint(x: 1000, y: 1000),
                                                 visibleSize: CGSize(width: 300, height: 300), zoomPPT: 1000)
        let expectedPadded = officeViewportTwips(
            scrollOrigin: CGPoint(x: 1000 - margin, y: 1000 - margin),
            visibleSize: CGSize(width: 300 + margin * 2, height: 300 + margin * 2), zoomPPT: 1000)

        XCTAssertEqual(recorder.subscribeCalls[0].viewportTwips, expectedPadded, "the subscribe ask "
                       + "must be padded by a tile span beyond the visible area, so the next tile out "
                       + "is already warm before the user actually scrolls onto it")
        XCTAssertGreaterThan(expectedPadded.width, tightViewport.width, "sanity: the padding must "
                             + "actually widen the ask relative to the tight, exactly-visible viewport")
        XCTAssertGreaterThan(expectedPadded.height, tightViewport.height)

        view.unmount()
        // Hygiene, not an assertion (this file's own recipe note, repeated by every sibling test):
        // settle any still-in-flight subscribe Task before `recorder` deallocates at return, or its
        // `[unowned self]` driver closure crashes the whole test host the moment it resumes.
        try? await Task.sleep(nanoseconds: 30_000_000)
    }

    /// Near the document's own near edge, the margin must clamp toward the edge rather than ask for
    /// negative-twips content that cannot exist — `performSubscribe`'s own `max(0, ...)`.
    func testPerformSubscribeClampsTheMarginAtTheNearEdgeRatherThanAskingNegativeTwips() async {
        let (runtime, recorder) = await makeOpenedRuntime()
        let model = PanelDocumentTabModel(tabId: "t1", path: "/gate.xlsx")
        let sizeTwips = OfficeDocumentSize(widthTwips: 2_000_000, heightTwips: 2_000_000)
        let view = OfficeTileCanvasView(runtime: runtime, path: "/gate.xlsx", docId: "doc-1",
                                        sizeTwips: sizeTwips, initialPart: 0, model: model)
        view.frame = NSRect(x: 0, y: 0, width: 300, height: 300) // scrollOrigin stays .zero — the near edge

        view.mount()
        let subscribed = await waitUntil { recorder.subscribeCalls.count >= 1 }
        XCTAssertTrue(subscribed)
        guard subscribed else { return }

        XCTAssertEqual(recorder.subscribeCalls[0].viewportTwips.x, 0, "at the near edge the padded "
                       + "origin must clamp to 0, never go negative")
        XCTAssertEqual(recorder.subscribeCalls[0].viewportTwips.y, 0)

        view.unmount()
        try? await Task.sleep(nanoseconds: 30_000_000) // hygiene — see the sibling test's own comment
    }

    // MARK: - office live-gate fix #3: whole-document tile residency — integration (a REAL mounted
    // canvas + a REAL OfficeRuntime, no window needed — same posture as the setActivePart section)

    /// A per-file copy of `SubscribeCapturingDriverRecorder` that ALSO tracks `requestTiles` calls —
    /// this section's tests need to see WHICH keys were asked for, and in what batches, to prove
    /// chunking and the visible-first ordering against a real mounted canvas.
    private final class ResidencyCapturingDriverRecorder: @unchecked Sendable {
        private let lock = NSLock()
        private var _subscribeCalls: [(docId: String, part: Int, zoomPPT: Int, viewportTwips: OfficeTwipsRect)] = []
        private var _requestCalls: [(docId: String, keys: [TileKey])] = []
        var subscribeCalls: [(docId: String, part: Int, zoomPPT: Int, viewportTwips: OfficeTwipsRect)] {
            lock.lock(); defer { lock.unlock() }; return _subscribeCalls
        }
        var requestCalls: [(docId: String, keys: [TileKey])] {
            lock.lock(); defer { lock.unlock() }; return _requestCalls
        }
        var driver: OfficeRuntime.Driver {
            OfficeRuntime.Driver(
                helperState: { .ready }, startHelper: { },
                open: { docId, _ in OfficeDocumentMetadata(type: .spreadsheet, parts: 4,
                                                            sizeTwips: OfficeDocumentSize(widthTwips: 100_000, heightTwips: 100_000)) },
                close: { _ in },
                subscribeTiles: { [unowned self] docId, part, zoomPPT, viewportTwips in
                    self.lock.lock(); self._subscribeCalls.append((docId, part, zoomPPT, viewportTwips)); self.lock.unlock()
                    return [] // never relied on here — the canvas computes its own prefetch keys
                              // directly via TileMath, the same shared authority the server uses
                },
                unsubscribeTiles: { _ in },
                requestTiles: { [unowned self] docId, keys in
                    self.lock.lock(); self._requestCalls.append((docId, keys)); self.lock.unlock()
                })
        }
    }

    /// **Returns the REAL runtime-assigned docId, not a test placeholder.** Unlike
    /// `makeOpenedRuntime` above (whose tests only ever check `subscribeCalls`, never actual tile
    /// CONTENT, so its callers' hardcoded `docId: "doc-1"` canvas constructor argument never has to
    /// match anything real), this section's tests populate `tileStore` directly (simulating arrival)
    /// and then read it back through the churn-audit skip-check, which looks up the store under the
    /// CANVAS's own `docId` property — if that does not match the docId `OfficeRuntime` actually
    /// minted (`makeDocId`'s default is `UUID().uuidString`, never "doc-1"), every store lookup
    /// silently misses and the skip-check can never see anything as satisfied. Measured directly,
    /// mid fix-round: constructing the canvas with a hardcoded `docId: "doc-1"` here produced exactly
    /// that — a skip-check that never skipped, misread as a residency-logic bug before this mismatch
    /// was found.
    private func makeOpenedResidencyRuntime(path: String = "/gate.xlsx") async
        -> (runtime: OfficeRuntime, recorder: ResidencyCapturingDriverRecorder, docId: String) {
        let recorder = ResidencyCapturingDriverRecorder()
        let runtime = OfficeRuntime(sessionId: "S1", driver: recorder.driver)
        runtime.open(path)
        _ = await waitUntil { runtime.stateSnapshot.documents[path] != nil }
        return (runtime, recorder, runtime.stateSnapshot.documents[path]!.docId)
    }

    /// **The central proof.** A document small enough to qualify (9 tiles, well under the 128 cap) is
    /// prefetched WHOLE, in chunks of `OfficeTileCanvasView`'s own chunk size (6), visible-first; once
    /// every requested key is actually cached (simulating the helper's reply — the same technique
    /// `ShellSessionHostTests.testASecondSubscribeSkipsKeysAlreadyCachedOrStillInFlight` already uses
    /// for a real `onTile` push), a subsequent scroll issues ZERO further wire calls — "after the
    /// initial fill, scrolling issues zero requests," the live-gate brief's own bar.
    ///
    /// **Amended under office live-gate fix #4, FIX 2 — the boundary this proves moved, deliberately.**
    /// That "zero further requests" bar assumed past-`sizeTwips` tiles could NEVER be painted — true
    /// before the infinite grid, false for a spreadsheet now (this recorder's own `driver.open`
    /// reports `.spreadsheet`; `effectiveExtentTwips`'s own header has the mechanism). The FIXED
    /// `Self.subscribeMarginPoints` overscan the throttled skip-check always pads by genuinely
    /// reaches past this document's small 3x3 edge into real, never-prefetched margin territory —
    /// `evaluateResidencyIfNeeded`'s own sweep deliberately never covers it (extending the eager
    /// whole-document prefetch into the margin would blow the residency cap's budget for every
    /// spreadsheet). The new, honest boundary, proven in two phases below rather than asserted in
    /// one: PHASE 1, the margin's first touch costs exactly ONE subscribe (not the old zero, and not
    /// unbounded either); PHASE 2, once that touched slice is ALSO cached, a further scroll is back
    /// to genuinely zero chatter. The invariant's SPIRIT — no chatter for zero benefit — still holds;
    /// only its letter moved from "past `sizeTwips`" to "past `sizeTwips` AND the margin's leading
    /// edge already warmed."
    func testResidentDocumentIsPrefetchedWholeInVisibleFirstChunksAndPostFillScrollingIssuesNoFurtherRequests() async {
        let (runtime, recorder, docId) = await makeOpenedResidencyRuntime()
        let model = PanelDocumentTabModel(tabId: "t1", path: "/gate.xlsx")
        // 3x3 tiles at zoomPPT 1000 (tileSpanTwips 5120): 15360 twips per axis is exactly 3 tile spans.
        let sizeTwips = OfficeDocumentSize(widthTwips: 15360, heightTwips: 15360)
        let view = OfficeTileCanvasView(runtime: runtime, path: "/gate.xlsx", docId: docId,
                                        sizeTwips: sizeTwips, initialPart: 0, model: model)
        view.frame = NSRect(x: 0, y: 0, width: 300, height: 300)

        view.mount()

        let issued = await waitUntil(timeout: 3) { view.prefetchSweepIssuedForTesting }
        XCTAssertTrue(issued, "the whole-document prefetch sweep must complete")
        XCTAssertEqual(view.prefetchChunksIssuedForTesting, 2, "9 tiles at chunk size 6 is 2 chunks (6 + 3)")
        XCTAssertEqual(recorder.requestCalls.count, 2, "one wire requestTiles call per chunk")

        let allKeys = (0..<3).flatMap { y in (0..<3).map { x in TileKey(part: 0, zoomPPT: 1000, tileX: x, tileY: y) } }
        XCTAssertEqual(Set(recorder.requestCalls.flatMap { $0.keys }), Set(allKeys),
                       "every tile in the extent was asked for, none missed, none duplicated across chunks")
        XCTAssertEqual(recorder.requestCalls.map { $0.keys.count }.reduce(0, +), allKeys.count,
                       "no key requested twice across chunks")

        // The visible viewport (300x300pt at zero scroll -> tiles (0,0),(1,0),(0,1),(1,1)) must lead
        // the FIRST chunk — chunk size 6 comfortably holds all 4 visible keys plus 2 more.
        let visible = TileMath.viewportTileKeys(part: 0, zoomPPT: 1000,
                                                viewportTwips: officeViewportTwips(scrollOrigin: .zero, visibleSize: CGSize(width: 300, height: 300), zoomPPT: 1000))
        XCTAssertTrue(Set(visible).isSubset(of: Set(recorder.requestCalls[0].keys)),
                     "the visible tiles must all be in the FIRST chunk — the user is looking at them")

        // Simulate the helper's own reply for every requested key.
        for key in allKeys {
            runtime.tileStore.ingest(docId: docId, key: key, generation: 0,
                                     pixels: Data(repeating: 1, count: TileMath.bytesPerTile))
        }
        for key in allKeys {
            XCTAssertNotNil(runtime.tileStore.tile(docId: docId, key: key),
                           "every tile is genuinely cached, not merely requested")
        }

        // office live-gate fix #3 (churn audit) + fix #4 amendment (this test's own header): a
        // scroll near a resident spreadsheet's edge now costs exactly ONE margin-warming subscribe,
        // not zero — proven in two phases below.
        let subscribeCountBeforeScroll = recorder.subscribeCalls.count
        let requestCountBeforeScroll = recorder.requestCalls.count
        view.applyScrollDelta(dx: -20, dy: -20)
        try? await Task.sleep(nanoseconds: 60_000_000) // well past the 1/60s throttle interval

        // PHASE 1: the one-time margin warm. Hand-built against the SAME pure functions
        // `performSubscribe`'s own skip-check uses — scrollOrigin (20,20) pads (by the fixed 256pt
        // `Self.subscribeMarginPoints`) to origin (0,0), size 812x812 (the 20pt scroll is entirely
        // swallowed by the margin) — the L-shaped slice of never-prefetched tiles that padded
        // viewport now genuinely touches, past this document's own 3x3 edge.
        let paddedViewport = officeViewportTwips(scrollOrigin: .zero,
                                                 visibleSize: CGSize(width: 300 + 512, height: 300 + 512), zoomPPT: 1000)
        let touchedKeys = Set(TileMath.viewportTileKeys(part: 0, zoomPPT: 1000, viewportTwips: paddedViewport))
        let marginKeys = touchedKeys.subtracting(Set(allKeys))
        XCTAssertFalse(marginKeys.isEmpty, "sanity: the padded viewport must genuinely reach past "
                       + "the document's own 3x3 edge for this test to mean anything")
        XCTAssertEqual(recorder.subscribeCalls.count, subscribeCountBeforeScroll + 1, "the margin's "
                       + "first touch must cost exactly ONE subscribe — not zero (the pre-fix-#4 "
                       + "invariant this test amends), and not perpetual chatter either")
        XCTAssertEqual(recorder.requestCalls.count, requestCountBeforeScroll, "requestTiles is the "
                       + "whole-document prefetch sweep's own door, never the throttled scroll path's")

        // PHASE 2: once the touched margin slice is ALSO cached (simulating the helper's reply, the
        // same technique the whole-document fill above already used), a further scroll must be back
        // to genuinely zero further chatter — proving this is a ONE-TIME warm, not a standing leak.
        for key in marginKeys {
            runtime.tileStore.ingest(docId: docId, key: key, generation: 0,
                                     pixels: Data(repeating: 1, count: TileMath.bytesPerTile))
        }
        let subscribeCountAfterMarginWarm = recorder.subscribeCalls.count
        let requestCountAfterMarginWarm = recorder.requestCalls.count
        view.applyScrollDelta(dx: -1, dy: -1) // a further tick, comfortably inside the same margin
        try? await Task.sleep(nanoseconds: 60_000_000)
        XCTAssertEqual(recorder.subscribeCalls.count, subscribeCountAfterMarginWarm, "once the "
                       + "touched margin slice is ALSO resident, scrolling must settle back to zero "
                       + "further subscribes — the warm was one-time, not a standing leak")
        XCTAssertEqual(recorder.requestCalls.count, requestCountAfterMarginWarm, "and zero further requests")

        view.unmount()
        try? await Task.sleep(nanoseconds: 30_000_000) // hygiene — settle before recorder deallocates
    }

    /// office live-gate fix #3, caught by the pre-commit whole-diff review: a document small enough to be resident is
    /// routinely SMALLER than the panel showing it — that is the residency cap's whole point (a big
    /// panel, a small qualifying doc). `clampedOriginX/Y` pin `scrollOrigin` at 0 in that case, but
    /// the RAW viewport `evaluateResidencyIfNeeded` computes from `bounds.size` still spans the
    /// panel's full size in twips — bigger than the document's own true extent. Before this fix,
    /// `officeResidencyPrefetchOrder`'s unclamped `visible` set included tile indices past the real
    /// 3x3 grid (a panel-driven index 3 on each axis, at this document/zoom pairing), so the sweep
    /// asked the wire for phantom keys that can never be filled — 16 keys / 3 chunks instead of the
    /// document's real 9 keys / 2 chunks. This pins the fix: with a panel LARGER than the document,
    /// the sweep must still ask for exactly the document's own 9 keys, nothing past its true edge.
    func testResidencyPrefetchClampsToDocumentExtentWhenThePanelIsLargerThanTheDocument() async {
        let (runtime, recorder, docId) = await makeOpenedResidencyRuntime()
        let model = PanelDocumentTabModel(tabId: "t1", path: "/gate.xlsx")
        // Same 3x3-at-zoomPPT-1000 document as the central proof, above — but in a panel/frame
        // LARGER than the document's own extent (900pt is 18000 twips at this zoom, vs. the
        // document's 15360) — the canonical "small doc, big panel" residency shape.
        let sizeTwips = OfficeDocumentSize(widthTwips: 15360, heightTwips: 15360)
        let view = OfficeTileCanvasView(runtime: runtime, path: "/gate.xlsx", docId: docId,
                                        sizeTwips: sizeTwips, initialPart: 0, model: model)
        view.frame = NSRect(x: 0, y: 0, width: 900, height: 900)

        view.mount()

        let issued = await waitUntil(timeout: 3) { view.prefetchSweepIssuedForTesting }
        XCTAssertTrue(issued, "the whole-document prefetch sweep must complete")
        XCTAssertEqual(view.prefetchChunksIssuedForTesting, 2,
                       "9 real keys at chunk size 6 is 2 chunks (6 + 3) — a phantom-inflated 16 would be 3")

        let allKeys = (0..<3).flatMap { y in (0..<3).map { x in TileKey(part: 0, zoomPPT: 1000, tileX: x, tileY: y) } }
        XCTAssertEqual(Set(recorder.requestCalls.flatMap { $0.keys }), Set(allKeys),
                       "exactly the document's real 9 keys — no tileX/tileY == 3 phantom past the true edge")

        view.unmount()
        try? await Task.sleep(nanoseconds: 30_000_000) // hygiene — settle before recorder deallocates
    }

    /// The bounded half: a document past the residency cap never triggers a whole-document prefetch
    /// at all — it is left in today's viewport+margin lazy mode, unchanged.
    func testIneligibleDocumentNeverTriggersAWholeDocumentPrefetch() async {
        let (runtime, recorder, docId) = await makeOpenedResidencyRuntime()
        let model = PanelDocumentTabModel(tabId: "t1", path: "/gate.xlsx")
        // Comfortably past the residency cap (128 tiles) at zoomPPT 1000.
        let sizeTwips = OfficeDocumentSize(widthTwips: 2_000_000, heightTwips: 2_000_000)
        let view = OfficeTileCanvasView(runtime: runtime, path: "/gate.xlsx", docId: docId,
                                        sizeTwips: sizeTwips, initialPart: 0, model: model)
        view.frame = NSRect(x: 0, y: 0, width: 300, height: 300)

        view.mount()
        let subscribed = await waitUntil { !recorder.subscribeCalls.isEmpty }
        XCTAssertTrue(subscribed, "the ordinary margin ask must still fire — lazy mode is unchanged")
        try? await Task.sleep(nanoseconds: 60_000_000) // give a wrongly-triggered prefetch time to appear
        XCTAssertTrue(recorder.requestCalls.isEmpty, "an ineligible document must never issue a whole-document prefetch")
        XCTAssertFalse(view.prefetchSweepIssuedForTesting)
        XCTAssertEqual(view.prefetchChunksIssuedForTesting, 0)

        view.unmount()
    }

    /// The churn audit's OTHER half, stated as its own contract: the skip is scoped to the THROTTLED
    /// (scroll/resize/pinch) path only — a DISCRETE action (zoom, part switch) must resubscribe
    /// unconditionally even when its own target viewport happens to already be fully cached, because
    /// `unmount` always unsubscribes and a skipped discrete resubscribe would leave this connection
    /// unregistered as the helper's tile-push subscriber (`performSubscribe`'s own header, reason a).
    func testDiscreteZoomResubscribesEvenWhenTheTargetIsAlreadyFullyCachedUnlikeTheThrottledPath() async {
        let (runtime, recorder, docId) = await makeOpenedResidencyRuntime()
        let model = PanelDocumentTabModel(tabId: "t1", path: "/gate.xlsx")
        let sizeTwips = OfficeDocumentSize(widthTwips: 15360, heightTwips: 15360) // 9 tiles at zoomPPT 1000
        let view = OfficeTileCanvasView(runtime: runtime, path: "/gate.xlsx", docId: docId,
                                        sizeTwips: sizeTwips, initialPart: 0, model: model)
        view.frame = NSRect(x: 0, y: 0, width: 300, height: 300)
        view.mount()
        let issued = await waitUntil(timeout: 3) { view.prefetchSweepIssuedForTesting }
        XCTAssertTrue(issued)
        for y in 0..<3 { for x in 0..<3 {
            runtime.tileStore.ingest(docId: docId, key: TileKey(part: 0, zoomPPT: 1000, tileX: x, tileY: y),
                                     generation: 0, pixels: Data(repeating: 1, count: TileMath.bytesPerTile))
        } }

        // Zoom away, then back — the 1000-zoom keys stay fully cached in the store the whole time
        // (zooming clears only the VIEW's own CALayer pool via `clearVisibleTiles`, never the
        // store's cached pixels, which are keyed by TileKey — zoomPPT included).
        XCTAssertTrue(view.setZoomForTesting(1250))
        // `performSubscribe`'s own `runtime.subscribeTiles` call reaches the recorder from inside an
        // async Task (`OfficeRuntime.perform`'s `.subscribe` case) — `setZoomForTesting` itself
        // returns before that Task necessarily runs, so the count must be polled, never read
        // synchronously right after the call (this file's own established idiom everywhere else).
        let landedFirstZoom = await waitUntil { recorder.subscribeCalls.count == 2 }
        XCTAssertTrue(landedFirstZoom, "sanity: the zoom-to-1250 resubscribe must land before this test proceeds")
        let subscribeCountBeforeReturn = recorder.subscribeCalls.count
        XCTAssertTrue(view.setZoomForTesting(1000))

        let resubscribed = await waitUntil { recorder.subscribeCalls.count > subscribeCountBeforeReturn }
        XCTAssertTrue(resubscribed, "a discrete "
                             + "zoom change must resubscribe even though every key its own padded "
                             + "viewport touches is already cached — only the THROTTLED path may skip")

        view.unmount()
        try? await Task.sleep(nanoseconds: 30_000_000) // hygiene — settle before recorder deallocates
    }

    /// The deferred-evaluation contract (`lastResidencyEvaluation`'s own header): `mount()`'s direct
    /// call finds zero bounds (mirroring production, where SwiftUI has not sized the view yet at
    /// `makeNSView` return) and does nothing — it must NOT memoize that as "evaluated," or the throttle
    /// settle edge below would find `(part, zoomPPT)` unchanged and skip the real evaluation forever.
    func testResidencyDefersToTheThrottleSettleEdgeWhenBoundsAreStillZeroAtMountTime() async {
        // `recorder` MUST be kept in scope (never `_`) — its driver closures capture `[unowned
        // self]`, mirroring `SubscribeCapturingDriverRecorder`'s own precedent (see
        // `testRelayoutRoutinelyPositionsATileLayerPastTheViewsOwnEdge`'s comment above): this test's
        // whole point is that `mount()` defers real work to a LATER Task, so `recorder` must survive
        // at least until that Task actually reaches the driver, or it resumes into a dangling unowned
        // reference and crashes the whole test host — measured directly, mid fix-round, discarding it
        // with `_` here is exactly what did that.
        let (runtime, recorder, docId) = await makeOpenedResidencyRuntime()
        let model = PanelDocumentTabModel(tabId: "t1", path: "/gate.xlsx")
        let sizeTwips = OfficeDocumentSize(widthTwips: 15360, heightTwips: 15360) // 9 tiles, eligible
        let view = OfficeTileCanvasView(runtime: runtime, path: "/gate.xlsx", docId: docId,
                                        sizeTwips: sizeTwips, initialPart: 0, model: model)
        // Deliberately mount BEFORE the frame is set — the production ordering, unlike every other
        // test in this file (which sets `frame` first for convenience).
        view.mount()
        view.frame = NSRect(x: 0, y: 0, width: 300, height: 300) // bounds are real now, but nothing has re-evaluated yet
        XCTAssertEqual(view.prefetchChunksIssuedForTesting, 0, "sanity: a bare frame assignment alone must not trigger a sweep")

        // The scroll throttle's own trailing settle edge is what performs the deferred FIRST
        // evaluation — the same path a real trackpad tick, a window resize, or a pinch settling all
        // drive; see `evaluateResidencyIfNeeded`'s own header.
        view.applyScrollDelta(dx: 0, dy: 0)
        let issued = await waitUntil(timeout: 3) { view.prefetchSweepIssuedForTesting }
        XCTAssertTrue(issued, "the throttle's trailing settle edge must perform the residency "
                     + "evaluation mount() itself deferred at zero bounds")
        XCTAssertFalse(recorder.requestCalls.isEmpty, "the deferred sweep must have actually reached the wire")

        view.unmount()
        try? await Task.sleep(nanoseconds: 30_000_000) // hygiene — settle before recorder deallocates
    }

    // MARK: - office live-gate fix #2: no redundant repaint on a mere reposition (contributing cause)

    /// A scroll tick that keeps the SAME tile set visible (small delta, no tile line crossed) must
    /// reposition every layer WITHOUT re-touching its `contents`/`backgroundColor` — before this
    /// fix, `applyContents` ran unconditionally for every visible tile on every single tick.
    func testRepositioningAnExistingTileDoesNotReapplyContentsButANewlyExposedTileDoes() async {
        let (runtime, recorder) = await makeOpenedRuntime()
        let model = PanelDocumentTabModel(tabId: "t1", path: "/gate.xlsx")
        let sizeTwips = OfficeDocumentSize(widthTwips: 2_000_000, heightTwips: 2_000_000)
        let view = OfficeTileCanvasView(runtime: runtime, path: "/gate.xlsx", docId: "doc-1",
                                        sizeTwips: sizeTwips, initialPart: 0, model: model)
        view.frame = NSRect(x: 0, y: 0, width: 300, height: 300)
        view.mount() // the first relayout paints every initially-visible tile once each
        let subscribed = await waitUntil { recorder.subscribeCalls.count >= 1 }
        XCTAssertTrue(subscribed)
        guard subscribed else { return }
        let countAfterMount = view.applyContentsCallCountForTesting
        XCTAssertGreaterThan(countAfterMount, 0, "sanity: mount painted something")

        // 10pt, well inside a 256pt tile — the visible tile-key SET cannot change.
        view.applyScrollDelta(dx: -10, dy: 0)
        XCTAssertEqual(view.applyContentsCallCountForTesting, countAfterMount, "repositioning "
                       + "already-visible tiles must not re-touch contents/backgroundColor — that "
                       + "was the per-scroll-tick waste this fix removes (up to ~120x/sec/tile before)")

        // 400pt — comfortably crosses a 256pt tile line, so at least one genuinely new key enters
        // the visible set and its brand-new layer must still be painted once.
        view.applyScrollDelta(dx: -400, dy: 0)
        XCTAssertGreaterThan(view.applyContentsCallCountForTesting, countAfterMount, "a newly-exposed "
                             + "tile's layer must still be painted once, at creation")

        view.unmount()
        try? await Task.sleep(nanoseconds: 30_000_000) // hygiene — see the earlier sibling test's own comment
    }

    // MARK: - office live-gate fix #4: tile layers must never implicitly animate
    //
    // USER LIVE-GATE FIX #4's own diagnostic-grade report: "the table is rendered in columns and
    // when I swipe each moves INDIVIDUALLY and has a lot of SMOOTHING... vertically it sticks to
    // checkpoints." That is a textbook implicit CALayer animation firing on every reposition — and
    // it directly contradicts fix #2's own comment further up this file ("repositioning a tile's
    // CALayer was never implicitly animated by CoreAnimation either... measured directly via
    // animationKeys()... AppKit disables implicit layer actions by default outside an explicit
    // animation context"). That claim is FALSE for these particular layers, re-verified honestly
    // below rather than trusted a second time — and it was never backed by a committed test in this
    // file to begin with (searched; absent), only a narrative comment.
    //
    // The true mechanism: AppKit's implicit-action suppression is a `CALayerDelegate` relationship
    // (`-actionForLayer:forKey:`) AppKit establishes ONLY between an `NSView` and its OWN backing
    // layer (`view.layer`) — it is never propagated to a sublayer the app mints and adds by hand
    // (`hostLayer.addSublayer(tileLayer)`, `relayoutVisibleTiles`'s own `else` branch, below). A
    // tile layer's `delegate` was always `nil`, so `action(forKey:)` fell through to bare CALayer's
    // own default action table — which DOES supply an implicit ~0.25s `CABasicAnimation` for
    // "position"/"bounds" (exactly what `existing.frame = rect` touches on every reposition), the
    // same behavior "bare Core Animation" gives ANY unguarded layer, view-hosted or not.
    //
    // **CORRECTED A SECOND TIME, empirically, mid this very fix round.** The first draft of this
    // section pinned `action(forKey:)` as "deterministic — true regardless of window/presentation
    // state" and asserted `nil` was an ACCEPTABLE result alongside `NSNull`. Measured directly
    // (pre-fix, on a view never added to any window): every key returned `nil` — the pin PASSED,
    // on the totally unfixed code. `action(forKey:)`'s bare-CALayer default-action fallback has
    // nothing to offer a layer that has never been part of a genuinely PRESENTED tree (there is no
    // "from" value to animate from before a layer's first commit) — so a never-windowed layer reads
    // "safe" whether or not it actually is. This is almost certainly what happened to the ORIGINAL
    // "empty both times" claim too: not a wrong layer, but no presented window either time.
    //
    // The real behavior only shows up live: `testRepositioningInARealPresentedWindowLeavesNoSettle
    // GlideAfterInputStops`, below, in a real `NSWindow`, failed PRE-FIX with `animationKeys ==
    // ["position"]` still present 100ms after the last input — the honest, corrected re-verification,
    // and the direct confirmation of the user's own "sticks to checkpoints" report.
    //
    // Two tests, two tiers, kept for different reasons — NOT "mechanism is deterministic, behavior is
    // not": `action(forKey:)` pinned below now asserts `is NSNull` ONLY (`nil` is a FAILURE) — the
    // one answer only `OfficeTileLayer`'s own unconditional override can produce, in ANY context,
    // presented or not; that override is what makes the mechanism check finally presentation-
    // independent, by construction, not by accident of an unwindowed default. The behavior test stays
    // too: it is what actually caught this bug, it encodes the user's literal symptom, and post-fix it
    // is deterministic in the green direction (no animation is ever added, so there is nothing to race).

    /// **The pin.** A tile layer minted through the PRODUCTION path (`mount()` ->
    /// `relayoutVisibleTiles` -> `tileLayerForTesting`) must resolve every animatable key this file's
    /// mutation sites actually touch (`applyContents`'s "contents"/"backgroundColor",
    /// `relayoutVisibleTiles`'s "position"/"bounds" via `.frame`, plus "hidden"/"opacity" per the
    /// live-gate brief's own named set) to `NSNull` — NOT merely `nil`; see this section's own header
    /// for why accepting `nil` as a pass was the exact mistake that let this pin go green pre-fix.
    /// Deliberately checks `action(forKey:)` directly, not `animationKeys()`: this way the SAME
    /// assertion is meaningful whether or not the layer has ever had a presentation, because
    /// `OfficeTileLayer`'s override answers identically either way.
    func testTileLayerNeverResolvesAnAnimatableActionForAnyKeyThisFileTouches() async {
        let (runtime, recorder) = await makeOpenedRuntime()
        let model = PanelDocumentTabModel(tabId: "t1", path: "/gate.xlsx")
        let sizeTwips = OfficeDocumentSize(widthTwips: 100_000, heightTwips: 100_000)
        let view = OfficeTileCanvasView(runtime: runtime, path: "/gate.xlsx", docId: "doc-1",
                                        sizeTwips: sizeTwips, initialPart: 0, model: model)
        view.frame = NSRect(x: 0, y: 0, width: 300, height: 300)
        view.mount() // relayoutVisibleTiles runs synchronously inside mount() — the layer itself needs no wait
        // `mount()` also fires `performSubscribe()`'s detached Task into `driver.subscribeTiles` —
        // `recorder`'s closures capture it `[unowned self]`, so this MUST stay alive until that Task
        // has genuinely landed (`testRelayoutRoutinelyPositionsATileLayerPastTheViewsOwnEdge`'s own
        // header, above, documents this exact race and why a bare `_ = recorder` does not close it).
        let subscribed = await waitUntil { recorder.subscribeCalls.count >= 1 }
        XCTAssertTrue(subscribed)

        let originKey = TileKey(part: 0, zoomPPT: 1000, tileX: 0, tileY: 0)
        guard let tileLayer = view.tileLayerForTesting(originKey) else {
            XCTFail("mount() must have minted a layer for the origin tile in a 300x300 viewport")
            view.unmount()
            return
        }

        for actionKey in ["position", "bounds", "contents", "backgroundColor", "hidden", "opacity"] {
            let action = tileLayer.action(forKey: actionKey)
            XCTAssertTrue(action is NSNull,
                          "\(actionKey): expected NSNull (the override), got "
                            + "\(String(describing: action)) instead — `nil` is ALSO a failure here, "
                            + "not just a live CAAction: nil is what an UNGUARDED layer returns too, "
                            + "whenever it has never been part of a presented window — see this "
                            + "section's own header for why that used to pass on the unfixed code")
        }

        view.unmount()
    }

    /// **The honest re-verification of the prior "measured un-animated" claim — corrected
    /// methodology.** A real `NSWindow`, `makeKeyAndOrderFront` (a genuinely PRESENTED layer tree —
    /// the prior claim's own "real on-screen window" half, actually done and actually pinned this
    /// time), one run-loop turn after mount so the initial layers actually HAVE a presentation (an
    /// implicit action fired before a layer's first commit animates nothing to look at — the trap
    /// that could otherwise make even an honest measurement read clean by accident), then a
    /// REPOSITION-ONLY scroll delta (`applyScrollDelta`, same tile set — mirrors
    /// `testRepositioningAnExistingTileDoesNotReapplyContentsButANewlyExposedTileDoes`'s own 10pt
    /// delta) through the real free-scroll path. The observable that actually matches what the user
    /// reported ("a lot of SMOOTHING... sticks to checkpoints"): settle-glide — does the layer's
    /// PRESENTATION keep moving for a beat AFTER the input already stopped? Checked at t+100ms with
    /// NO further input, comfortably inside the ~0.25s default implicit-animation duration a real fix
    /// must never let start.
    func testRepositioningInARealPresentedWindowLeavesNoSettleGlideAfterInputStops() async {
        let (runtime, recorder) = await makeOpenedRuntime()
        let model = PanelDocumentTabModel(tabId: "t1", path: "/gate.xlsx")
        let sizeTwips = OfficeDocumentSize(widthTwips: 2_000_000, heightTwips: 2_000_000)
        let view = OfficeTileCanvasView(runtime: runtime, path: "/gate.xlsx", docId: "doc-1",
                                        sizeTwips: sizeTwips, initialPart: 0, model: model)
        view.frame = NSRect(x: 0, y: 0, width: 300, height: 300)

        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 300, height: 300),
                              styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = view
        window.makeKeyAndOrderFront(nil)
        defer { window.close() }

        view.mount()
        // `recorder`'s closures capture it `[unowned self]` — MUST stay alive until `mount()`'s own
        // detached subscribe Task has genuinely landed, or that Task later dereferences a deallocated
        // object and crashes the whole test host (see `testTileLayerNeverResolvesAnAnimatableAction
        // ForAnyKeyThisFileTouches`'s identical guard, immediately above, and
        // `testRelayoutRoutinelyPositionsATileLayerPastTheViewsOwnEdge`'s own header for the full
        // mechanism) — genuinely awaiting it here is also what gives the run-loop the turn it needs
        // below.
        let subscribed = await waitUntil { recorder.subscribeCalls.count >= 1 }
        XCTAssertTrue(subscribed)
        // One further beat so the freshly-minted layers actually have a PRESENTATION before the
        // measurement below — see this test's own header for why an unpresented layer's first
        // reposition could read clean by accident, not by fix.
        try? await Task.sleep(nanoseconds: 50_000_000)

        let originKey = TileKey(part: 0, zoomPPT: 1000, tileX: 0, tileY: 0)
        guard let tileLayer = view.tileLayerForTesting(originKey) else {
            XCTFail("mount() must have minted a layer for the origin tile")
            view.unmount()
            return
        }
        let modelPositionBefore = tileLayer.position

        view.applyScrollDelta(dx: -30, dy: 0) // reposition-only, well inside a 256pt tile
        let modelPositionRightAfter = tileLayer.position
        XCTAssertNotEqual(modelPositionBefore, modelPositionRightAfter,
                          "sanity: the delta must have actually moved the layer's MODEL position")

        try? await Task.sleep(nanoseconds: 100_000_000) // t+100ms, NO further input — see header
        let stillAnimating = !(tileLayer.animationKeys()?.isEmpty ?? true)
        XCTAssertFalse(stillAnimating, "a tile layer is still mid-animation 100ms after the LAST "
                       + "input, with animationKeys \(tileLayer.animationKeys() ?? []) — this is the "
                       + "settle-glide the user reported live")
        if let presentationPosition = tileLayer.presentation()?.position {
            XCTAssertEqual(presentationPosition, modelPositionRightAfter,
                           "the layer's PRESENTATION has not caught up to its own model position "
                             + "100ms after input stopped (presentation=\(presentationPosition), "
                             + "model=\(modelPositionRightAfter)) — exactly the reported drift/glide")
        }

        view.unmount()
    }

    // MARK: - office live-gate fix #4, FIX 2: the infinite grid (spreadsheets only)
    //
    // The empirical finding this section encodes: `paintPartTile` genuinely renders empty, gridded
    // cells for twips rects past `sizeTwips` (`OfficeHelperLiveTests.testGateXlsxTilesPastTheUsedRange
    // EmpiricalInfiniteGridProbe`'s own PNG dump against gate.xlsx, on our real vendored LOK pin — a
    // clean gridded canvas, not blank and not garbage, unchanged all the way out to ~4x the
    // document's own span beyond its edge) — so the canvas no longer needs to stop dead exactly at
    // the used range, FOR SPREADSHEETS. These three tests pin the shape that makes extending it safe:
    // scoped to `.spreadsheet` only (never probed for presentations/documents, which have genuine
    // fixed page bounds), and the subscribe skip-check's own clamp widens in EXACT lockstep with the
    // scroll clamp — both read the same `effectiveExtentTwips`, so they cannot disagree; see that
    // property's own header for the "placeholders forever, just moved past the margin instead of
    // past `sizeTwips`" trap a disagreement between the two would silently reintroduce.

    /// The scroll bound itself, hand-built against the SAME pure `TileMath` conversions production
    /// uses (`effectiveExtentTwips`'s own arithmetic, independently reconstructed here rather than
    /// reached into) — the exact margin `Self.infiniteGridExtraScreens` (2) adds for a 300x300
    /// viewport at 100% zoom.
    func testSpreadsheetScrollExtendsPastTheUsedRangeByTheDocumentedMargin() async {
        let (runtime, _) = await makeOpenedRuntime(documentType: .spreadsheet)
        let model = PanelDocumentTabModel(tabId: "t1", path: "/gate.xlsx")
        let sizeTwips = OfficeDocumentSize(widthTwips: 100_000, heightTwips: 100_000)
        let view = OfficeTileCanvasView(runtime: runtime, path: "/gate.xlsx", docId: "doc-1",
                                        sizeTwips: sizeTwips, initialPart: 0, model: model)
        view.frame = NSRect(x: 0, y: 0, width: 300, height: 300)

        let marginWidthPixels = Int(2 * 300 * officeFixedDeviceScale)
        let marginWidthTwips = TileMath.pixelsToTwips(marginWidthPixels, zoomPPT: 1000)
        let extendedWidthPixels = TileMath.twipsToPixels(sizeTwips.widthTwips + marginWidthTwips, zoomPPT: 1000)
        let expectedMaxOriginX = CGFloat(extendedWidthPixels) / officeFixedDeviceScale - 300

        let oldWidthPixels = TileMath.twipsToPixels(sizeTwips.widthTwips, zoomPPT: 1000)
        let oldMaxOriginX = CGFloat(oldWidthPixels) / officeFixedDeviceScale - 300
        XCTAssertGreaterThan(expectedMaxOriginX, oldMaxOriginX, "sanity: the margin must genuinely "
                             + "extend the old, un-widened bound — otherwise this test cannot tell "
                             + "the fix apart from no fix at all")

        view.applyScrollDelta(dx: -1_000_000, dy: 0) // wildly overshoots even the EXTENDED far edge
        XCTAssertEqual(view.scrollOriginForTesting.x, expectedMaxOriginX, accuracy: 0.01,
                       "a spreadsheet must be scrollable exactly `infiniteGridExtraScreens` screens "
                         + "past its own used range, not the bare used range alone")

        view.unmount()
    }

    /// The mirror case — the SAME setup, a non-spreadsheet type — must land at EXACTLY the old,
    /// un-widened bound. Protects the `.spreadsheet`-only scoping: nothing here was ever probed for
    /// presentations/documents (`isSpreadsheet`'s own header), so they must keep the pre-fix#2
    /// behavior byte-for-byte.
    func testNonSpreadsheetScrollStaysClampedExactlyAtTheUsedRangeUnextended() async {
        let (runtime, _) = await makeOpenedRuntime(documentType: .text)
        let model = PanelDocumentTabModel(tabId: "t1", path: "/gate.xlsx")
        let sizeTwips = OfficeDocumentSize(widthTwips: 100_000, heightTwips: 100_000)
        let view = OfficeTileCanvasView(runtime: runtime, path: "/gate.xlsx", docId: "doc-1",
                                        sizeTwips: sizeTwips, initialPart: 0, model: model)
        view.frame = NSRect(x: 0, y: 0, width: 300, height: 300)

        let oldWidthPixels = TileMath.twipsToPixels(sizeTwips.widthTwips, zoomPPT: 1000)
        let oldMaxOriginX = CGFloat(oldWidthPixels) / officeFixedDeviceScale - 300

        view.applyScrollDelta(dx: -1_000_000, dy: 0) // wildly overshoots the (un-widened) far edge
        XCTAssertEqual(view.scrollOriginForTesting.x, oldMaxOriginX, accuracy: 0.01,
                       "a non-spreadsheet document must NOT gain the infinite-grid margin — its "
                         + "clamp is untouched by office live-gate fix #4's FIX 2")

        view.unmount()
    }

    /// **The clamp-trap regression pin.** Scrolling a spreadsheet PAST its old used-range edge but
    /// still INSIDE the new margin must still genuinely ask the store for tiles there — proving the
    /// subscribe skip-check's own clamp widened in lockstep with the scroll clamp, not left behind
    /// at the bare `sizeTwips` bound (which would zero out the clamped viewport for every key out
    /// there, read as "nothing needs requesting," and skip forever — see `effectiveExtentTwips`'s
    /// own header for the full mechanism this pins against).
    func testScrollingIntoTheInfiniteGridMarginStillAsksForTilesNotSkippedForever() async {
        let (runtime, recorder) = await makeOpenedRuntime(documentType: .spreadsheet)
        let model = PanelDocumentTabModel(tabId: "t1", path: "/gate.xlsx")
        // Large enough to stay residency-INELIGIBLE — no eager whole-document prefetch sweep to
        // interfere with this test's own subscribe-call counting (the same size several sibling
        // "large document" tests in this file already use for the identical reason).
        let sizeTwips = OfficeDocumentSize(widthTwips: 2_000_000, heightTwips: 2_000_000)
        let view = OfficeTileCanvasView(runtime: runtime, path: "/gate.xlsx", docId: "doc-1",
                                        sizeTwips: sizeTwips, initialPart: 0, model: model)
        view.frame = NSRect(x: 0, y: 0, width: 300, height: 300)
        view.mount()
        let mounted = await waitUntil { recorder.subscribeCalls.count >= 1 }
        XCTAssertTrue(mounted)
        let countAfterMount = recorder.subscribeCalls.count

        let oldWidthPixels = TileMath.twipsToPixels(sizeTwips.widthTwips, zoomPPT: 1000)
        let oldMaxOriginX = CGFloat(oldWidthPixels) / officeFixedDeviceScale - view.bounds.width
        view.setScrollOriginForTesting(CGPoint(x: oldMaxOriginX, y: 0)) // establish at the OLD edge
        view.applyScrollDelta(dx: -300, dy: 0) // push 300pt further — past the old edge, inside the
                                                // 600pt margin (2 screens x 300pt), comfortably clear
                                                // of its own outer boundary too

        let resubscribedIntoMargin = await waitUntil { recorder.subscribeCalls.count > countAfterMount }
        XCTAssertTrue(resubscribedIntoMargin, "scrolling into the new infinite-grid margin must "
                      + "still genuinely ask for tiles there — the skip-check's own clamp must "
                      + "widen in lockstep with the scroll clamp, or this margin would be "
                      + "scrollable but its tiles would never be requested (placeholders forever, "
                      + "just moved)")

        view.unmount()
    }
}
