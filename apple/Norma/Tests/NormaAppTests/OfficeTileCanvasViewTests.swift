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
    /// **Office Stage B Task 2b test fallout**: `OfficeRuntime.open` now genuinely STAGES (copies)
    /// its argument before ever calling into a driver — every test in this file that opens
    /// `gatePath` needs a real, readable file there, or the copy fails and the document never
    /// reaches `documents[path]` at all. Content is irrelevant to every test here (each driver
    /// fabricates its own `OfficeDocumentMetadata`, never touching real bytes) — only existence
    /// does. `gatePath`'s own last path component is `"gate.xlsx"`, the exact literal every test in
    /// this file already used to key documents/views by, so nothing else needed to change.
    private var scratchDir: URL!
    private var gatePath: String { scratchDir.appendingPathComponent("gate.xlsx").path }
    /// The driver's own staging destination — a SEPARATE scratch directory, mirroring how a real
    /// `--state-path` is never the document's own directory.
    private var stateDir: URL!

    override func setUpWithError() throws {
        try super.setUpWithError()
        scratchDir = URL(fileURLWithPath: "/tmp/office-tilecanvas-\(UUID().uuidString.prefix(8))", isDirectory: true)
        try FileManager.default.createDirectory(at: scratchDir, withIntermediateDirectories: true)
        try Data().write(to: URL(fileURLWithPath: gatePath))
        stateDir = URL(fileURLWithPath: "/tmp/office-tilecanvas-state-\(UUID().uuidString.prefix(8))", isDirectory: true)
        try FileManager.default.createDirectory(at: stateDir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: scratchDir)
        try? FileManager.default.removeItem(at: stateDir)
        scratchDir = nil
        stateDir = nil
        try super.tearDownWithError()
    }

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

    // MARK: - officePointToTwips (Office Stage B Task 4 — the mouse-event unit chain)

    func testOriginPointAtZeroScrollIsTheDocumentOrigin() {
        let twips = officePointToTwips(viewPoint: .zero, scrollOrigin: .zero, zoomPPT: 1000)
        XCTAssertEqual(twips.x, 0)
        XCTAssertEqual(twips.y, 0)
    }

    /// Same 100pt-of-scroll fixture `testScrollOriginTranslatesToTheViewportsTwipsOrigin` uses for
    /// `officeViewportTwips` — a point at the view's own origin, once `scrollOrigin` is added in,
    /// must land on the IDENTICAL twips coordinate that function already reports as the viewport's
    /// own origin: both functions are the same unit chain, applied to different inputs (a whole
    /// viewport vs. one point), and must never disagree about where "the view's origin, scrolled by
    /// this much" sits in document space.
    func testAPointAtTheViewOriginAgreesWithOfficeViewportTwipsOwnOriginForTheSameScroll() {
        let scrollOrigin = CGPoint(x: 100, y: 50)
        let viewport = officeViewportTwips(scrollOrigin: scrollOrigin, visibleSize: CGSize(width: 256, height: 256), zoomPPT: 1000)
        let point = officePointToTwips(viewPoint: .zero, scrollOrigin: scrollOrigin, zoomPPT: 1000)
        XCTAssertEqual(point.x, viewport.x)
        XCTAssertEqual(point.y, viewport.y)
    }

    func testAPointOffsetFromTheOriginAddsItsOwnTwipsDistance() {
        // 10pt right/down from the origin, at 2x scale and zoomPPT 1000 (1 twip == 0.1px): 10pt ==
        // 20px == 200 twips.
        let twips = officePointToTwips(viewPoint: CGPoint(x: 10, y: 10), scrollOrigin: .zero, zoomPPT: 1000)
        XCTAssertEqual(twips.x, 200)
        XCTAssertEqual(twips.y, 200)
    }

    func testHalfZoomDoublesTheTwipsDistanceForTheSamePointOffset() {
        let full = officePointToTwips(viewPoint: CGPoint(x: 10, y: 10), scrollOrigin: .zero, zoomPPT: 1000)
        let half = officePointToTwips(viewPoint: CGPoint(x: 10, y: 10), scrollOrigin: .zero, zoomPPT: 500)
        XCTAssertEqual(half.x, full.x * 2)
        XCTAssertEqual(half.y, full.y * 2)
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
        /// Office Stage B Task 5 — the IME tests below need to see WHICH door a given
        /// `insertText`/`setMarkedText`/`unmarkText`/`keyDown` call actually reached: the already-
        /// proven per-scalar `postKey` door, or the new `postExtTextInput` door. Additive — every
        /// PRE-existing test in this file only ever reads `subscribeCalls`, never these two, so
        /// recording more here cannot change any of their outcomes.
        private var _postKeyCalls: [(docId: String, part: Int, type: OfficeKeyEventType, charCode: Int, keyCode: Int)] = []
        var postKeyCalls: [(docId: String, part: Int, type: OfficeKeyEventType, charCode: Int, keyCode: Int)] {
            lock.lock(); defer { lock.unlock() }; return _postKeyCalls
        }
        private var _postExtTextInputCalls: [(docId: String, part: Int, type: OfficeExtTextInputType, text: String)] = []
        var postExtTextInputCalls: [(docId: String, part: Int, type: OfficeExtTextInputType, text: String)] {
            lock.lock(); defer { lock.unlock() }; return _postExtTextInputCalls
        }
        /// Office Stage B Task 6 — the clipboard/undo/redo call sequences the canvas's own menu
        /// pins need to see. Same additive-only reasoning as `postExtTextInputCalls` above: every
        /// PRE-existing test in this file only reads the arrays it already knew about.
        private var _clipboardCopyCalls: [(docId: String, part: Int)] = []
        var clipboardCopyCalls: [(docId: String, part: Int)] {
            lock.lock(); defer { lock.unlock() }; return _clipboardCopyCalls
        }
        private var _clipboardCutCalls: [(docId: String, part: Int)] = []
        var clipboardCutCalls: [(docId: String, part: Int)] {
            lock.lock(); defer { lock.unlock() }; return _clipboardCutCalls
        }
        private var _clipboardPasteCalls: [(docId: String, part: Int, text: String)] = []
        var clipboardPasteCalls: [(docId: String, part: Int, text: String)] {
            lock.lock(); defer { lock.unlock() }; return _clipboardPasteCalls
        }
        private var _undoCalls: [String] = []
        var undoCalls: [String] {
            lock.lock(); defer { lock.unlock() }; return _undoCalls
        }
        private var _redoCalls: [String] = []
        var redoCalls: [String] {
            lock.lock(); defer { lock.unlock() }; return _redoCalls
        }
        /// The text `clipboardCopy`/`clipboardCut` answer with — configurable per test
        /// (`copyAndCutAnswer`), defaulting to a fixed, deterministic, non-empty string so the
        /// common "did a pasteboard write happen" pin does not need to configure anything.
        var copyAndCutAnswer: String? = "clipboard-recorder-text"
        /// office live-gate fix #4, FIX 2: `OfficeTileCanvasView.isSpreadsheet` reads this back via
        /// `runtime.stateSnapshot.documents[path]?.type` — every OTHER test in this file relies on
        /// the pre-existing `.text` default (the infinite-grid margin must stay INERT for them), so
        /// this is a constructor default, never a hardcoded literal inside `driver` below.
        private let documentType: OfficeDocumentKind
        /// Office Stage B Task 2b test fallout — `Driver.stateDirectory` is a required field now;
        /// the caller hands in a real scratch dir (`OfficeTileCanvasViewTests.stateDir`) since
        /// `OfficeRuntime.openAndDispatch` genuinely stages into it before ever calling `open` below.
        private let stateDirectory: URL
        init(documentType: OfficeDocumentKind = .text, stateDirectory: URL) {
            self.documentType = documentType
            self.stateDirectory = stateDirectory
        }
        var driver: OfficeRuntime.Driver {
            OfficeRuntime.Driver(
                helperState: { .ready }, startHelper: { },
                open: { [documentType] docId, _ in OfficeDocumentMetadata(
                    type: documentType, parts: 1,
                    sizeTwips: OfficeDocumentSize(widthTwips: 100_000, heightTwips: 100_000)) },
                close: { _ in },
                save: { _, _ in "/tmp/officetilecanvasviewtests-unused-save" },
                // crash-fix round 1 (Family B): same fire-and-forget-outlives-the-test mechanism as
                // `BrokerOfficeDriverRecorder` (broker-crash-investigation.md §2) — this recorder is
                // one of the "sibling recorders" the investigation names, reached by the same
                // `OfficeRuntime.perform` straggler-task shape. `[weak self]` + a straggler-safe
                // fallback (never observed by these tests, since the recorder is already gone)
                // replaces the host-killing `unowned` abort.
                subscribeTiles: { [weak self] docId, part, zoomPPT, viewportTwips in
                    guard let self else { return [] }
                    self.lock.lock(); self._subscribeCalls.append((docId, part, zoomPPT, viewportTwips)); self.lock.unlock()
                    return []
                },
                unsubscribeTiles: { _ in },
                requestTiles: { _, _ in },
                postKey: { [weak self] docId, part, type, charCode, keyCode in
                    guard let self else { return }
                    self.lock.lock(); self._postKeyCalls.append((docId, part, type, charCode, keyCode)); self.lock.unlock()
                },
                postMouse: { _, _, _, _, _, _, _, _ in },
                postExtTextInput: { [weak self] docId, part, type, text in
                    guard let self else { return }
                    self.lock.lock(); self._postExtTextInputCalls.append((docId, part, type, text)); self.lock.unlock()
                },
                clipboardCopy: { [weak self] docId, part in
                    guard let self else { return nil }
                    self.lock.lock(); self._clipboardCopyCalls.append((docId, part)); self.lock.unlock()
                    return self.copyAndCutAnswer
                },
                clipboardCut: { [weak self] docId, part in
                    guard let self else { return nil }
                    self.lock.lock(); self._clipboardCutCalls.append((docId, part)); self.lock.unlock()
                    return self.copyAndCutAnswer
                },
                clipboardPaste: { [weak self] docId, part, text in
                    guard let self else { return }
                    self.lock.lock(); self._clipboardPasteCalls.append((docId, part, text)); self.lock.unlock()
                },
                undo: { [weak self] docId in
                    guard let self else { return }
                    self.lock.lock(); self._undoCalls.append(docId); self.lock.unlock()
                },
                redo: { [weak self] docId in
                    guard let self else { return }
                    self.lock.lock(); self._redoCalls.append(docId); self.lock.unlock()
                },
                sheetsInfo: { _ in throw OfficeHelperClientError.serverError(reason: "fake driver: sheets not implemented") },
                sheetsRead: { _, _, _, _ in throw OfficeHelperClientError.serverError(reason: "fake driver: sheets not implemented") },
                stateDirectory: stateDirectory)
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
    private func makeOpenedRuntime(documentType: OfficeDocumentKind = .text) async
        -> (runtime: OfficeRuntime, recorder: SubscribeCapturingDriverRecorder) {
        let recorder = SubscribeCapturingDriverRecorder(documentType: documentType, stateDirectory: stateDir)
        let runtime = OfficeRuntime(sessionId: "S1", driver: recorder.driver)
        runtime.open(gatePath)
        _ = await waitUntil { runtime.stateSnapshot.documents[gatePath] != nil }
        return (runtime, recorder)
    }

    /// **The brief's own named test.** `mount()` alone (part 0) fires the first subscribe;
    /// `setActivePart(1)` must fire a SECOND one, immediately (obligation: bypasses the throttle —
    /// a part switch is discrete, not a continuation of a scroll burst), carrying the NEW part.
    func testSettingActivePartOnAMountedCanvasResubscribesImmediatelyWithTheNewPart() async {
        let (runtime, recorder) = await makeOpenedRuntime()
        let model = PanelDocumentTabModel(tabId: "t1", path: gatePath)
        let sizeTwips = OfficeDocumentSize(widthTwips: 100_000, heightTwips: 100_000)
        let view = OfficeTileCanvasView(runtime: runtime, path: gatePath, docId: "doc-1",
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
        // Never mounts, so `recorder`'s `[weak self]` driver closures are never actually called
        // (`init` touches neither the driver nor the runtime) — no retention hazard here the way the
        // NEXT test has (see that one's own comment). `_` would be fine; bound anyway for symmetry.
        let (runtime, _) = await makeOpenedRuntime()
        let model = PanelDocumentTabModel(tabId: "t1", path: gatePath)
        let sizeTwips = OfficeDocumentSize(widthTwips: 100_000, heightTwips: 100_000)
        let view = OfficeTileCanvasView(runtime: runtime, path: gatePath, docId: "doc-1",
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
        let model = PanelDocumentTabModel(tabId: "t1", path: gatePath)
        // Large enough that the 300pt viewport below sits nowhere near the DOCUMENT's own far edge —
        // this test is about the TILE GRID straddling the VIEWPORT's edge, not the document's.
        let sizeTwips = OfficeDocumentSize(widthTwips: 1_000_000, heightTwips: 1_000_000)
        let view = OfficeTileCanvasView(runtime: runtime, path: gatePath, docId: "doc-1",
                                        sizeTwips: sizeTwips, initialPart: 0, model: model)
        view.frame = NSRect(x: 0, y: 0, width: 300, height: 300)
        view.mount() // synchronously calls relayoutVisibleTiles() — see mount()'s own body

        // **Load-bearing, not hygiene**: `mount()` also fires `performSubscribe()`, which dispatches
        // a `.subscribe` effect that reaches `driver.subscribeTiles` from inside a detached `Task`
        // (`OfficeRuntime.perform`'s own `.subscribe` case) — fire-and-forget from `mount()`'s own
        // perspective. `SubscribeCapturingDriverRecorder`'s closures capture the recorder
        // `[weak self]` (crash-fix round 1: was `[unowned self]` — see broker-crash-investigation.md
        // §2 — so this raced a host-killing abort instead of the silent drop described below), so if
        // this function returned (and `recorder` fell out of scope) before that Task actually ran,
        // the Task would later find `self` already `nil` and silently no-op — measured directly, mid
        // fix-round: a dummy `_ = recorder` placed right after the `let` above does NOT fix this (it
        // is itself `recorder`'s last syntactic use at that point, so ARC is free to deallocate
        // immediately, no later than end of scope — and the Task can easily still be pending past
        // that), and the assertion below would then hang until `waitUntil`'s own timeout instead of
        // observing the call. Awaiting the subscribe here, the same way
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
        let model = PanelDocumentTabModel(tabId: "t1", path: gatePath)
        let sizeTwips = OfficeDocumentSize(widthTwips: 100_000, heightTwips: 100_000)
        let view = OfficeTileCanvasView(runtime: runtime, path: gatePath, docId: "doc-1",
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
        let model = PanelDocumentTabModel(tabId: "t1", path: gatePath)
        let sizeTwips = OfficeDocumentSize(widthTwips: 1_000_000, heightTwips: 1_000_000)
        let view = OfficeTileCanvasView(runtime: runtime, path: gatePath, docId: "doc-1",
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
        let model = PanelDocumentTabModel(tabId: "t1", path: gatePath)
        let sizeTwips = OfficeDocumentSize(widthTwips: 1_000_000, heightTwips: 1_000_000)
        let view = OfficeTileCanvasView(runtime: runtime, path: gatePath, docId: "doc-1",
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
        let model = PanelDocumentTabModel(tabId: "t1", path: gatePath)
        let largeSize = OfficeDocumentSize(widthTwips: 2_000_000, heightTwips: 2_000_000)
        let view = OfficeTileCanvasView(runtime: runtime, path: gatePath, docId: "doc-1",
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
        // Task's `[weak self]` closure (crash-fix round 1: was `[unowned self]`) silently no-ops
        // and the resubscribe this test is asserting on never gets recorded.
        _ = await waitUntil { recorder.subscribeCalls.count == 2 }

        view.unmount()
    }

    /// The `else` branch — a `syncDocumentIdentity` call carrying the SAME docId (what `updateNSView`
    /// sends on every ordinary render, reload or not) must degrade to exactly the pre-Task-8 drift
    /// re-assert: idempotent, no extra resubscribe.
    func testSyncDocumentIdentityWithTheSameDocIdIsTheOrdinaryDriftReassertNotAReload() async {
        let (runtime, recorder) = await makeOpenedRuntime()
        let model = PanelDocumentTabModel(tabId: "t1", path: gatePath)
        let sizeTwips = OfficeDocumentSize(widthTwips: 100_000, heightTwips: 100_000)
        let view = OfficeTileCanvasView(runtime: runtime, path: gatePath, docId: "doc-1",
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
        let model = PanelDocumentTabModel(tabId: "t1", path: gatePath)
        let sizeTwips = OfficeDocumentSize(widthTwips: 100_000, heightTwips: 100_000)
        let view = OfficeTileCanvasView(runtime: runtime, path: gatePath, docId: "doc-1",
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
        let model = PanelDocumentTabModel(tabId: "t1", path: gatePath)
        // Far larger than anything these tiny deltas could reach — this test is about the
        // ACCUMULATION, not the edge clamp (that is the next test's own job).
        let sizeTwips = OfficeDocumentSize(widthTwips: 2_000_000, heightTwips: 2_000_000)
        let view = OfficeTileCanvasView(runtime: runtime, path: gatePath, docId: "doc-1",
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
        let model = PanelDocumentTabModel(tabId: "t1", path: gatePath)
        let sizeTwips = OfficeDocumentSize(widthTwips: 100_000, heightTwips: 100_000) // small — an overshoot is cheap to reach
        let view = OfficeTileCanvasView(runtime: runtime, path: gatePath, docId: "doc-1",
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
        let model = PanelDocumentTabModel(tabId: "t1", path: gatePath)
        let sizeTwips = OfficeDocumentSize(widthTwips: 2_000_000, heightTwips: 2_000_000)
        let view = OfficeTileCanvasView(runtime: runtime, path: gatePath, docId: "doc-1",
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
        // `[weak self]` driver closure (crash-fix round 1: was `[unowned self]`) silently no-ops.
        try? await Task.sleep(nanoseconds: 30_000_000)
    }

    /// Near the document's own near edge, the margin must clamp toward the edge rather than ask for
    /// negative-twips content that cannot exist — `performSubscribe`'s own `max(0, ...)`.
    func testPerformSubscribeClampsTheMarginAtTheNearEdgeRatherThanAskingNegativeTwips() async {
        let (runtime, recorder) = await makeOpenedRuntime()
        let model = PanelDocumentTabModel(tabId: "t1", path: gatePath)
        let sizeTwips = OfficeDocumentSize(widthTwips: 2_000_000, heightTwips: 2_000_000)
        let view = OfficeTileCanvasView(runtime: runtime, path: gatePath, docId: "doc-1",
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
        /// Office Stage B Task 2b test fallout — see `SubscribeCapturingDriverRecorder
        /// .stateDirectory`'s own doc.
        private let stateDirectory: URL
        init(stateDirectory: URL) { self.stateDirectory = stateDirectory }
        var driver: OfficeRuntime.Driver {
            OfficeRuntime.Driver(
                helperState: { .ready }, startHelper: { },
                open: { docId, _ in OfficeDocumentMetadata(type: .spreadsheet, parts: 4,
                                                            sizeTwips: OfficeDocumentSize(widthTwips: 100_000, heightTwips: 100_000)) },
                close: { _ in },
                save: { _, _ in "/tmp/officetilecanvasviewtests-unused-save" },
                // crash-fix round 1 (Family B): NOT one of the investigation's named recorder
                // types, but found sharing the identical mechanism — this recorder's `driver` is
                // also assigned straight into a live `OfficeRuntime` (see
                // `makeOpenedResidencyRuntime` below), so it is equally reachable by
                // `OfficeRuntime.perform`'s fire-and-forget straggler `Task`s. Same `[weak self]`
                // fix, same reasoning as `SubscribeCapturingDriverRecorder` above.
                subscribeTiles: { [weak self] docId, part, zoomPPT, viewportTwips in
                    guard let self else { return [] }
                    self.lock.lock(); self._subscribeCalls.append((docId, part, zoomPPT, viewportTwips)); self.lock.unlock()
                    return [] // never relied on here — the canvas computes its own prefetch keys
                              // directly via TileMath, the same shared authority the server uses
                },
                unsubscribeTiles: { _ in },
                requestTiles: { [weak self] docId, keys in
                    guard let self else { return }
                    self.lock.lock(); self._requestCalls.append((docId, keys)); self.lock.unlock()
                },
                postKey: { _, _, _, _, _ in }, postMouse: { _, _, _, _, _, _, _, _ in },
                postExtTextInput: { _, _, _, _ in },
                clipboardCopy: { _, _ in nil },
                clipboardCut: { _, _ in nil },
                clipboardPaste: { _, _, _ in },
                undo: { _ in },
                redo: { _ in },
                sheetsInfo: { _ in throw OfficeHelperClientError.serverError(reason: "fake driver: sheets not implemented") },
                sheetsRead: { _, _, _, _ in throw OfficeHelperClientError.serverError(reason: "fake driver: sheets not implemented") },
                stateDirectory: stateDirectory)
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
    private func makeOpenedResidencyRuntime() async
        -> (runtime: OfficeRuntime, recorder: ResidencyCapturingDriverRecorder, docId: String) {
        let recorder = ResidencyCapturingDriverRecorder(stateDirectory: stateDir)
        let runtime = OfficeRuntime(sessionId: "S1", driver: recorder.driver)
        runtime.open(gatePath)
        _ = await waitUntil { runtime.stateSnapshot.documents[gatePath] != nil }
        return (runtime, recorder, runtime.stateSnapshot.documents[gatePath]!.docId)
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
        let model = PanelDocumentTabModel(tabId: "t1", path: gatePath)
        // 3x3 tiles at zoomPPT 1000 (tileSpanTwips 5120): 15360 twips per axis is exactly 3 tile spans.
        let sizeTwips = OfficeDocumentSize(widthTwips: 15360, heightTwips: 15360)
        let view = OfficeTileCanvasView(runtime: runtime, path: gatePath, docId: docId,
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
        let model = PanelDocumentTabModel(tabId: "t1", path: gatePath)
        // Same 3x3-at-zoomPPT-1000 document as the central proof, above — but in a panel/frame
        // LARGER than the document's own extent (900pt is 18000 twips at this zoom, vs. the
        // document's 15360) — the canonical "small doc, big panel" residency shape.
        let sizeTwips = OfficeDocumentSize(widthTwips: 15360, heightTwips: 15360)
        let view = OfficeTileCanvasView(runtime: runtime, path: gatePath, docId: docId,
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
        let model = PanelDocumentTabModel(tabId: "t1", path: gatePath)
        // Comfortably past the residency cap (128 tiles) at zoomPPT 1000.
        let sizeTwips = OfficeDocumentSize(widthTwips: 2_000_000, heightTwips: 2_000_000)
        let view = OfficeTileCanvasView(runtime: runtime, path: gatePath, docId: docId,
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
        let model = PanelDocumentTabModel(tabId: "t1", path: gatePath)
        let sizeTwips = OfficeDocumentSize(widthTwips: 15360, heightTwips: 15360) // 9 tiles at zoomPPT 1000
        let view = OfficeTileCanvasView(runtime: runtime, path: gatePath, docId: docId,
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
        let model = PanelDocumentTabModel(tabId: "t1", path: gatePath)
        let sizeTwips = OfficeDocumentSize(widthTwips: 15360, heightTwips: 15360) // 9 tiles, eligible
        let view = OfficeTileCanvasView(runtime: runtime, path: gatePath, docId: docId,
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
        let model = PanelDocumentTabModel(tabId: "t1", path: gatePath)
        let sizeTwips = OfficeDocumentSize(widthTwips: 2_000_000, heightTwips: 2_000_000)
        let view = OfficeTileCanvasView(runtime: runtime, path: gatePath, docId: "doc-1",
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
        let model = PanelDocumentTabModel(tabId: "t1", path: gatePath)
        let sizeTwips = OfficeDocumentSize(widthTwips: 100_000, heightTwips: 100_000)
        let view = OfficeTileCanvasView(runtime: runtime, path: gatePath, docId: "doc-1",
                                        sizeTwips: sizeTwips, initialPart: 0, model: model)
        view.frame = NSRect(x: 0, y: 0, width: 300, height: 300)
        view.mount() // relayoutVisibleTiles runs synchronously inside mount() — the layer itself needs no wait
        // `mount()` also fires `performSubscribe()`'s detached Task into `driver.subscribeTiles` —
        // `recorder`'s closures capture it `[weak self]`, so this MUST stay alive until that Task
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
        let model = PanelDocumentTabModel(tabId: "t1", path: gatePath)
        let sizeTwips = OfficeDocumentSize(widthTwips: 2_000_000, heightTwips: 2_000_000)
        let view = OfficeTileCanvasView(runtime: runtime, path: gatePath, docId: "doc-1",
                                        sizeTwips: sizeTwips, initialPart: 0, model: model)
        view.frame = NSRect(x: 0, y: 0, width: 300, height: 300)

        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 300, height: 300),
                              styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = view
        window.makeKeyAndOrderFront(nil)
        defer { window.close() }

        view.mount()
        // `recorder`'s closures capture it `[weak self]` (crash-fix round 1: was `[unowned self]`)
        // — MUST stay alive until `mount()`'s own detached subscribe Task has genuinely landed, or
        // that Task later finds `self` already `nil` and silently no-ops instead of recording the
        // call (see `testTileLayerNeverResolvesAnAnimatableAction
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
        let model = PanelDocumentTabModel(tabId: "t1", path: gatePath)
        let sizeTwips = OfficeDocumentSize(widthTwips: 100_000, heightTwips: 100_000)
        let view = OfficeTileCanvasView(runtime: runtime, path: gatePath, docId: "doc-1",
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
        let model = PanelDocumentTabModel(tabId: "t1", path: gatePath)
        let sizeTwips = OfficeDocumentSize(widthTwips: 100_000, heightTwips: 100_000)
        let view = OfficeTileCanvasView(runtime: runtime, path: gatePath, docId: "doc-1",
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
        let model = PanelDocumentTabModel(tabId: "t1", path: gatePath)
        // Large enough to stay residency-INELIGIBLE — no eager whole-document prefetch sweep to
        // interfere with this test's own subscribe-call counting (the same size several sibling
        // "large document" tests in this file already use for the identical reason).
        let sizeTwips = OfficeDocumentSize(widthTwips: 2_000_000, heightTwips: 2_000_000)
        let view = OfficeTileCanvasView(runtime: runtime, path: gatePath, docId: "doc-1",
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

    // MARK: - Office Stage B Task 5: caret/selection/cell-cursor overlay geometry + behavior

    /// Pure — `officeTwipsRectToScreenRect` at the canonical pin (`zoomPPT == 1000`, `TileMath`'s own
    /// "100% zoom, 2x device scale" configuration): 1 twip = 0.1px = 0.05pt, so a rect at
    /// (1418, 1418, 0, 552) twips (a REAL captured caret rect — `OfficeHelperLiveTests`' own probe)
    /// lands at (70.9, 70.9) points, zero width, 27.6pt tall.
    func testTwipsRectToScreenRectAtCanonicalZoomNoScroll() {
        let rect = officeTwipsRectToScreenRect(
            OfficeTwipsRect(x: 1418, y: 1418, width: 0, height: 552), zoomPPT: 1000, scrollOrigin: .zero)
        // 1418 twips -> roundedDivide(1418*1000, 10000) = 142px (ties-away-from-zero: 141.8 -> 142)
        // -> 142/2 = 71.0pt. 552 twips -> roundedDivide(552000, 10000) = 55px -> 55/2 = 27.5pt.
        // `TileMath.twipsToPixels`'s own rounding, not naive twips*0.05 — matching every OTHER
        // consumer of that function in this file (`officeTileScreenRect` above).
        XCTAssertEqual(rect.origin.x, 71.0, accuracy: 0.01)
        XCTAssertEqual(rect.origin.y, 71.0, accuracy: 0.01)
        XCTAssertEqual(rect.size.width, 0, accuracy: 0.01)
        XCTAssertEqual(rect.size.height, 27.5, accuracy: 0.01)
    }

    /// Scroll offset subtracts from the ORIGIN, matching `officeTileScreenRect`'s own identical
    /// scroll-handling — a rect fixed in document space must move OPPOSITE the scroll direction on
    /// screen, exactly like every tile already does.
    func testTwipsRectToScreenRectSubtractsScrollOrigin() {
        let rect = officeTwipsRectToScreenRect(
            OfficeTwipsRect(x: 1000, y: 1000, width: 1000, height: 1000), zoomPPT: 1000, scrollOrigin: CGPoint(x: 10, y: 20))
        let unscrolled = officeTwipsRectToScreenRect(
            OfficeTwipsRect(x: 1000, y: 1000, width: 1000, height: 1000), zoomPPT: 1000, scrollOrigin: .zero)
        XCTAssertEqual(rect.origin.x, unscrolled.origin.x - 10, accuracy: 0.01)
        XCTAssertEqual(rect.origin.y, unscrolled.origin.y - 20, accuracy: 0.01)
    }

    /// A degenerate (zero-width) rect must still produce a valid, non-`nil` `CGRect` — UNLIKE
    /// `officeTileScreenRect`, this function has no `TileMath.tileBoundsTwips` refusal gate at all
    /// (see its own header) — every REAL caret rect this task's own probe observed has `width == 0`.
    func testTwipsRectToScreenRectNeverRefusesADegenerateRect() {
        let rect = officeTwipsRectToScreenRect(
            OfficeTwipsRect(x: 0, y: 0, width: 0, height: 0), zoomPPT: 1000, scrollOrigin: .zero)
        XCTAssertEqual(rect, .zero)
    }

    /// A mounted canvas with NOTHING known yet (no click, no type, no cell click — `OfficeCursorStore`
    /// starts every docId at its own empty `.State()`) must show NO overlay at all: no caret, no
    /// selection, no cell-cursor box.
    func testFreshlyMountedCanvasShowsNoOverlaysUntilACursorEventArrives() async {
        let (runtime, recorder) = await makeOpenedRuntime()
        let model = PanelDocumentTabModel(tabId: "t1", path: gatePath)
        let sizeTwips = OfficeDocumentSize(widthTwips: 100_000, heightTwips: 100_000)
        let view = OfficeTileCanvasView(runtime: runtime, path: gatePath, docId: "doc-1",
                                        sizeTwips: sizeTwips, initialPart: 0, model: model)
        view.frame = NSRect(x: 0, y: 0, width: 300, height: 300)
        view.mount()
        // `recorder`'s driver closures capture it `[weak self]` (crash-fix round 1: was
        // `[unowned self]`) — this MUST stay alive until `performSubscribe()`'s own detached Task
        // has landed, or the Task finds `self` already `nil` and silently no-ops the moment this
        // test discards `recorder` early (see `makeOpenedRuntime`'s own callers, several lines up,
        // for the identical precedent and its own header comment on this hazard).
        _ = await waitUntil { recorder.subscribeCalls.count >= 1 }

        XCTAssertEqual(view.caretLayerForTesting?.isHidden, true)
        XCTAssertEqual(view.cellCursorLayerForTesting?.isHidden, true)
        XCTAssertEqual(view.selectionLayersForTesting.count, 0)

        view.unmount()
    }

    /// **The load-bearing overlay proof**: a caret event for the canvas's OWN current part shows the
    /// caret, positioned via the SAME `officeTwipsRectToScreenRect` transform tiles themselves use; a
    /// caret event stamped with a DIFFERENT part (the canvas navigated away, or the event raced a
    /// part switch — `OfficeCursorStore`'s own header names this exact window) hides it — the
    /// brief's own "must hide when their part ≠ the canvas's active part" requirement.
    func testCaretShowsForTheMatchingPartAndHidesForAMismatchedPart() async {
        let (runtime, recorder) = await makeOpenedRuntime()
        let model = PanelDocumentTabModel(tabId: "t1", path: gatePath)
        let sizeTwips = OfficeDocumentSize(widthTwips: 100_000, heightTwips: 100_000)
        let view = OfficeTileCanvasView(runtime: runtime, path: gatePath, docId: "doc-1",
                                        sizeTwips: sizeTwips, initialPart: 0, model: model)
        view.frame = NSRect(x: 0, y: 0, width: 300, height: 300)
        view.mount()
        _ = await waitUntil { recorder.subscribeCalls.count >= 1 } // see testFreshlyMounted...'s own comment

        let rect = OfficeTwipsRect(x: 1418, y: 1418, width: 0, height: 552)
        runtime.cursorStore.apply(docId: "doc-1", event: .caretRect(rect), activePart: 0)
        let shown = await waitUntil { view.caretLayerForTesting?.isHidden == false }
        XCTAssertTrue(shown, "a caret event for part 0 must show the caret on a canvas whose own part is 0")
        let expected = officeTwipsRectToScreenRect(rect, zoomPPT: 1000, scrollOrigin: .zero)
        if let screenRect = view.caretLayerForTesting?.frame {
            XCTAssertEqual(screenRect.origin.x, expected.origin.x, accuracy: 0.01)
            XCTAssertEqual(screenRect.origin.y, expected.origin.y, accuracy: 0.01)
            XCTAssertEqual(screenRect.size.width, officeCaretWidthPoints, accuracy: 0.01,
                           "a real caret rect's own twips width is always 0 — the rendered hairline is this constant, not 0pt")
        } else {
            XCTFail("caretLayerForTesting must be non-nil once mounted")
        }

        // A caret event stamped with a DIFFERENT part (a race, or simply the wrong page/sheet) hides it.
        runtime.cursorStore.apply(docId: "doc-1", event: .caretRect(rect), activePart: 1)
        let hidden = await waitUntil { view.caretLayerForTesting?.isHidden == true }
        XCTAssertTrue(hidden, "a caret rect stamped for a DIFFERENT part than the canvas's own must never be shown")

        view.unmount()
    }

    /// The blink timer's own test seam — `advanceCaretBlinkForTesting()` toggles visibility WITHOUT
    /// waiting `OfficeTileCanvasView`'s real ~530ms interval (the house "no arbitrary sleeps" rule).
    func testCaretBlinkTogglesVisibilityWithoutRealTime() async {
        let (runtime, recorder) = await makeOpenedRuntime()
        let model = PanelDocumentTabModel(tabId: "t1", path: gatePath)
        let sizeTwips = OfficeDocumentSize(widthTwips: 100_000, heightTwips: 100_000)
        let view = OfficeTileCanvasView(runtime: runtime, path: gatePath, docId: "doc-1",
                                        sizeTwips: sizeTwips, initialPart: 0, model: model)
        view.frame = NSRect(x: 0, y: 0, width: 300, height: 300)
        view.mount()
        _ = await waitUntil { recorder.subscribeCalls.count >= 1 } // see testFreshlyMounted...'s own comment
        runtime.cursorStore.apply(docId: "doc-1", event: .caretRect(OfficeTwipsRect(x: 1, y: 1, width: 0, height: 1)), activePart: 0)
        let shown = await waitUntil { view.caretLayerForTesting?.isHidden == false }
        XCTAssertTrue(shown, "setup: the caret must be visible before this test can prove blink toggles it off")

        view.advanceCaretBlinkForTesting()
        XCTAssertEqual(view.caretLayerForTesting?.isHidden, true, "one toggle from the visible phase must hide it")

        view.advanceCaretBlinkForTesting()
        XCTAssertEqual(view.caretLayerForTesting?.isHidden, false, "a second toggle returns to visible")

        view.unmount()
    }

    /// The selection pool grows to match the rect COUNT and hides exactly the surplus when the
    /// selection shrinks — never fewer real layers than rects, never a stale extra one left visible.
    func testSelectionLayerPoolGrowsToMatchRectCountAndHidesSurplusWhenItShrinks() async {
        let (runtime, recorder) = await makeOpenedRuntime()
        let model = PanelDocumentTabModel(tabId: "t1", path: gatePath)
        let sizeTwips = OfficeDocumentSize(widthTwips: 100_000, heightTwips: 100_000)
        let view = OfficeTileCanvasView(runtime: runtime, path: gatePath, docId: "doc-1",
                                        sizeTwips: sizeTwips, initialPart: 0, model: model)
        view.frame = NSRect(x: 0, y: 0, width: 300, height: 300)
        view.mount()
        _ = await waitUntil { recorder.subscribeCalls.count >= 1 } // see testFreshlyMounted...'s own comment

        let twoRects = [OfficeTwipsRect(x: 0, y: 0, width: 100, height: 20), OfficeTwipsRect(x: 0, y: 20, width: 200, height: 20)]
        runtime.cursorStore.apply(docId: "doc-1", event: .textSelection(twoRects), activePart: 0)
        let grew = await waitUntil {
            view.selectionLayersForTesting.count == 2 && view.selectionLayersForTesting.allSatisfy { !$0.isHidden }
        }
        XCTAssertTrue(grew, "two selection rects must produce two visible layers")

        runtime.cursorStore.apply(docId: "doc-1", event: .textSelection([]), activePart: 0)
        let shrank = await waitUntil { view.selectionLayersForTesting.allSatisfy(\.isHidden) }
        XCTAssertTrue(shrank, "an empty selection must hide every pooled layer")
        XCTAssertEqual(view.selectionLayersForTesting.count, 2, "the pool itself is kept, not torn down — see its own header")

        view.unmount()
    }

    /// `CELL_CURSOR`'s own two shapes, end to end through the canvas: a real cell shows the outline
    /// box at the right screen position; `.empty` (observed live during in-cell edit) hides it.
    func testCellCursorShowsForARealCellAndHidesForEmpty() async {
        let (runtime, recorder) = await makeOpenedRuntime(documentType: .spreadsheet)
        let model = PanelDocumentTabModel(tabId: "t1", path: gatePath)
        let sizeTwips = OfficeDocumentSize(widthTwips: 100_000, heightTwips: 100_000)
        let view = OfficeTileCanvasView(runtime: runtime, path: gatePath, docId: "doc-1",
                                        sizeTwips: sizeTwips, initialPart: 0, model: model)
        view.frame = NSRect(x: 0, y: 0, width: 300, height: 300)
        view.mount()
        _ = await waitUntil { recorder.subscribeCalls.count >= 1 } // see testFreshlyMounted...'s own comment

        let cellRect = OfficeTwipsRect(x: 0, y: 0, width: 1265, height: 254)
        runtime.cursorStore.apply(docId: "doc-1", event: .cellCursor(.at(rectTwips: cellRect, column: 0, row: 0)), activePart: 0)
        let shown = await waitUntil { view.cellCursorLayerForTesting?.isHidden == false }
        XCTAssertTrue(shown)
        let expected = officeTwipsRectToScreenRect(cellRect, zoomPPT: 1000, scrollOrigin: .zero)
        if let cellCursorFrame = view.cellCursorLayerForTesting?.frame {
            XCTAssertEqual(cellCursorFrame.origin.x, expected.origin.x, accuracy: 0.01)
        } else {
            XCTFail("cellCursorLayerForTesting must be non-nil once mounted")
        }

        runtime.cursorStore.apply(docId: "doc-1", event: .cellCursor(.empty), activePart: 0)
        let hidden = await waitUntil { view.cellCursorLayerForTesting?.isHidden == true }
        XCTAssertTrue(hidden, "EMPTY (in-cell edit mode) must hide the cell-cursor outline")

        view.unmount()
    }

    /// office live-gate fix #4's own null-action discipline, extended to Task 5's three new layer
    /// types — mirrors `testTileLayerNeverResolvesAnAnimatableActionForAnyKeyThisFileTouches` exactly
    /// (same keys, same assertion shape), against the REAL production caret/cell-cursor layers
    /// `mountCursorOverlays()` mints, not a hand-built `CALayer()`.
    func testCaretAndCellCursorLayersNeverResolveAnAnimatableAction() async {
        let (runtime, recorder) = await makeOpenedRuntime()
        let model = PanelDocumentTabModel(tabId: "t1", path: gatePath)
        let sizeTwips = OfficeDocumentSize(widthTwips: 100_000, heightTwips: 100_000)
        let view = OfficeTileCanvasView(runtime: runtime, path: gatePath, docId: "doc-1",
                                        sizeTwips: sizeTwips, initialPart: 0, model: model)
        view.frame = NSRect(x: 0, y: 0, width: 300, height: 300)
        view.mount()
        _ = await waitUntil { recorder.subscribeCalls.count >= 1 } // see testFreshlyMounted...'s own comment

        for layer in [view.caretLayerForTesting, view.cellCursorLayerForTesting].compactMap({ $0 }) {
            for actionKey in ["position", "bounds", "backgroundColor", "borderColor", "borderWidth", "hidden", "opacity"] {
                XCTAssertTrue(layer.action(forKey: actionKey) is NSNull,
                             "\(actionKey): expected the OfficeTileLayer null-action override")
            }
        }

        view.unmount()
    }

    /// `unmount()` must invalidate the blink timer and clear the sink — otherwise a repeating
    /// `Timer` fires into a freed view's `[weak self]` forever (see `caretBlinkTimer`'s own header).
    /// Proven indirectly: after `unmount()`, the overlay layers are gone (removed from their
    /// superlayer) and a stray `cursorChanged` push for this docId does nothing observable.
    func testUnmountTearsDownOverlayLayersAndTheBlinkTimer() async {
        let (runtime, recorder) = await makeOpenedRuntime()
        let model = PanelDocumentTabModel(tabId: "t1", path: gatePath)
        let sizeTwips = OfficeDocumentSize(widthTwips: 100_000, heightTwips: 100_000)
        let view = OfficeTileCanvasView(runtime: runtime, path: gatePath, docId: "doc-1",
                                        sizeTwips: sizeTwips, initialPart: 0, model: model)
        view.frame = NSRect(x: 0, y: 0, width: 300, height: 300)
        view.mount()
        _ = await waitUntil { recorder.subscribeCalls.count >= 1 } // see testFreshlyMounted...'s own comment
        XCTAssertNotNil(view.caretLayerForTesting, "setup: mount() must have minted the caret layer")

        view.unmount()

        XCTAssertNil(view.caretLayerForTesting, "unmount() must release the caret layer")
        XCTAssertNil(view.cellCursorLayerForTesting, "unmount() must release the cell-cursor layer")
        // A push after unmount must not crash or resurrect anything — the sink was cleared.
        runtime.cursorStore.apply(docId: "doc-1", event: .caretRect(OfficeTwipsRect(x: 1, y: 1, width: 0, height: 1)), activePart: 0)
        try? await Task.sleep(nanoseconds: 30_000_000)
        XCTAssertNil(view.caretLayerForTesting, "still nil — a post-unmount push must not resurrect the layer")
    }

    // MARK: - Office Stage B Task 5 — NSTextInputClient (IME)

    private func makeMountedView(runtime: OfficeRuntime, docId: String = "doc-1") -> OfficeTileCanvasView {
        let model = PanelDocumentTabModel(tabId: "t1", path: gatePath)
        let sizeTwips = OfficeDocumentSize(widthTwips: 100_000, heightTwips: 100_000)
        let view = OfficeTileCanvasView(runtime: runtime, path: gatePath, docId: docId,
                                        sizeTwips: sizeTwips, initialPart: 0, model: model)
        view.frame = NSRect(x: 0, y: 0, width: 300, height: 300)
        view.mount()
        return view
    }

    /// The plain-commit path (`markedText == nil` — no composition in progress): one `postKey
    /// (.keyInput)` per Unicode scalar, `keyCode: 0` for every one of them (no real physical key
    /// behind synthetic text — `insertText`'s own header explains why `0`, not a guess).
    func testInsertTextPlainCommitPostsOnePostKeyPerScalarWithKeyCodeZero() async {
        let (runtime, recorder) = await makeOpenedRuntime()
        let view = makeMountedView(runtime: runtime)

        view.insertText("ab", replacementRange: NSRange(location: NSNotFound, length: 0))
        await runtime.drainInputChainForTesting()

        XCTAssertEqual(recorder.postKeyCalls.count, 2)
        XCTAssertEqual(recorder.postKeyCalls.map(\.charCode), [97, 98])
        XCTAssertEqual(recorder.postKeyCalls.map(\.keyCode), [0, 0])
        XCTAssertEqual(recorder.postKeyCalls.map(\.type), [.keyInput, .keyInput])
        XCTAssertTrue(recorder.postExtTextInputCalls.isEmpty, "a plain commit must never touch the "
                      + "ext-text-input door at all")

        view.unmount()
    }

    func testInsertTextWithEmptyStringIsANoOp() async {
        let (runtime, recorder) = await makeOpenedRuntime()
        let view = makeMountedView(runtime: runtime)

        view.insertText("", replacementRange: NSRange(location: NSNotFound, length: 0))
        try? await Task.sleep(nanoseconds: 30_000_000)

        XCTAssertTrue(recorder.postKeyCalls.isEmpty)
        XCTAssertTrue(recorder.postExtTextInputCalls.isEmpty)
        view.unmount()
    }

    /// The composed-commit path: `setMarkedText` first (so `markedText != nil`), then `insertText`
    /// must post the FINAL text as `.input` immediately followed by `.end` — the exact two-frame
    /// sequence `OfficeRuntimeLiveTests.testExtTextInputMarksCommitsAndCancelsAgainstRealLOKThrough
    /// SaveAndReopen` already proved against real LOK. Never touches `postKey` at all.
    func testInsertTextWhenComposingPostsExtTextInputThenEndAndClearsMarkedText() async {
        let (runtime, recorder) = await makeOpenedRuntime()
        let view = makeMountedView(runtime: runtime)

        view.setMarkedText("e", selectedRange: NSRange(location: 1, length: 0), replacementRange: NSRange(location: NSNotFound, length: 0))
        XCTAssertTrue(view.hasMarkedText(), "setup: composition must be active before this test means anything")

        view.insertText("é", replacementRange: NSRange(location: NSNotFound, length: 0))
        await runtime.drainInputChainForTesting()

        // One call from setMarkedText, two from insertText's own commit sequence.
        XCTAssertEqual(recorder.postExtTextInputCalls.count, 3)
        XCTAssertEqual(recorder.postExtTextInputCalls[1].type, .input)
        XCTAssertEqual(recorder.postExtTextInputCalls[1].text, "é")
        XCTAssertEqual(recorder.postExtTextInputCalls[2].type, .end)
        XCTAssertEqual(recorder.postExtTextInputCalls[2].text, "", "`.end` must always carry empty "
                      + "text — LOK ignores it and commits whatever is currently marked instead")
        XCTAssertTrue(recorder.postKeyCalls.isEmpty, "a composed commit must never touch the postKey "
                      + "door at all")
        XCTAssertFalse(view.hasMarkedText(), "insertText must clear the local composing state on commit")

        view.unmount()
    }

    func testSetMarkedTextPostsInputAndReflectsComposingState() async {
        let (runtime, recorder) = await makeOpenedRuntime()
        let view = makeMountedView(runtime: runtime)

        XCTAssertFalse(view.hasMarkedText(), "setup: nothing composing yet")
        XCTAssertEqual(view.markedRange(), NSRange(location: NSNotFound, length: 0))

        view.setMarkedText("xyz", selectedRange: NSRange(location: 3, length: 0), replacementRange: NSRange(location: NSNotFound, length: 0))
        await runtime.drainInputChainForTesting()

        XCTAssertEqual(recorder.postExtTextInputCalls.count, 1)
        XCTAssertEqual(recorder.postExtTextInputCalls[0].type, .input)
        XCTAssertEqual(recorder.postExtTextInputCalls[0].text, "xyz")
        XCTAssertTrue(view.hasMarkedText())
        XCTAssertEqual(view.markedRange(), NSRange(location: 0, length: 3))
        XCTAssertEqual(view.selectedRange(), NSRange(location: 3, length: 0))

        view.unmount()
    }

    /// AppKit's OWN door for "the input method finished quietly" (a focus change mid-compose) —
    /// same commit mechanism as `insertText`'s own composed-commit arm, `.end` alone.
    func testUnmarkTextCommitsWhateverIsMarkedAndClearsComposingState() async {
        let (runtime, recorder) = await makeOpenedRuntime()
        let view = makeMountedView(runtime: runtime)
        view.setMarkedText("xyz", selectedRange: NSRange(location: 3, length: 0), replacementRange: NSRange(location: NSNotFound, length: 0))
        await runtime.drainInputChainForTesting()

        view.unmarkText()
        await runtime.drainInputChainForTesting()

        XCTAssertEqual(recorder.postExtTextInputCalls.count, 2)
        XCTAssertEqual(recorder.postExtTextInputCalls[1].type, .end)
        XCTAssertEqual(recorder.postExtTextInputCalls[1].text, "")
        XCTAssertFalse(view.hasMarkedText())

        view.unmount()
    }

    /// **Refuse-never-pointless**: `unmarkText` with nothing marked must not post anything — mirrors
    /// the "fire-and-forget, but never a pointless post" posture this codebase already holds
    /// `OfficeDocumentBridge.postKey` to elsewhere.
    func testUnmarkTextIsANoOpWhenNothingIsMarked() async {
        let (runtime, recorder) = await makeOpenedRuntime()
        let view = makeMountedView(runtime: runtime)

        view.unmarkText()
        try? await Task.sleep(nanoseconds: 30_000_000)

        XCTAssertTrue(recorder.postExtTextInputCalls.isEmpty)
        view.unmount()
    }

    func testFirstRectIsZeroWithNoWindow() async {
        // `recorder` kept alive (never `let (runtime, _)`) — `mount()` fires `performSubscribe()`'s
        // detached `Task` into `SubscribeCapturingDriverRecorder`'s own `[weak self]`-capturing
        // driver closures (crash-fix round 1: was `[unowned self]`); discarding the recorder lets
        // it deallocate before that `Task` runs, silently dropping the subscribe call — this file's
        // own documented hazard (see this class's own header on `driver`), hit and fixed here the
        // same way every other mounting test already is.
        let (runtime, recorder) = await makeOpenedRuntime()
        let view = makeMountedView(runtime: runtime)
        _ = await waitUntil { recorder.subscribeCalls.count >= 1 }
        // Deliberately never added to an NSWindow — mirrors this suite's own headless-by-default
        // posture (every OTHER test in this file mounts without a real window too).
        var actual = NSRange(location: NSNotFound, length: 0)
        let rect = view.firstRect(forCharacterRange: NSRange(location: 0, length: 0), actualRange: &actual)
        XCTAssertEqual(rect, .zero, "no window means no screen to report a rect in — must degrade to "
                      + ".zero, never crash or fabricate a coordinate")
        view.unmount()
    }

    func testFirstRectIsZeroWhenNoCaretRectIsTrackedYet() async {
        let (runtime, recorder) = await makeOpenedRuntime()
        let view = makeMountedView(runtime: runtime)
        _ = await waitUntil { recorder.subscribeCalls.count >= 1 }
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 300, height: 300),
                              styleMask: [.borderless], backing: .buffered, defer: true)
        window.isReleasedWhenClosed = false // this file's own precedent (line ~1269) — an AppKit
        // NSWindow defaults to releasing itself on close(); without this, close() below performs an
        // ADDITIONAL release on top of ARC's own, and repeated runs accumulate window state instead
        // of tearing down cleanly.
        defer { window.close() }
        window.contentView = view

        var actual = NSRange(location: NSNotFound, length: 0)
        let rect = view.firstRect(forCharacterRange: NSRange(location: 0, length: 0), actualRange: &actual)
        XCTAssertEqual(rect, .zero, "setup: nothing has stamped a caret rect for this docId yet")
        view.unmount()
    }

    /// The brief's own named door, proven positive: a REAL tracked caret rect (fed through the SAME
    /// `cursorStore.apply` fold `OfficeRuntime.handle(documentEvent:docId:)` uses in production)
    /// converts to a non-zero SCREEN rect once the view sits in a real window.
    func testFirstRectReflectsTheTrackedCaretRectWhenPartMatches() async {
        let (runtime, recorder) = await makeOpenedRuntime()
        let view = makeMountedView(runtime: runtime, docId: "doc-1")
        _ = await waitUntil { recorder.subscribeCalls.count >= 1 }
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 300, height: 300),
                              styleMask: [.borderless], backing: .buffered, defer: true)
        window.isReleasedWhenClosed = false // see testFirstRectIsZeroWhenNoCaretRectIsTrackedYet's own comment
        defer { window.close() }
        window.contentView = view

        runtime.cursorStore.apply(docId: "doc-1", event: .caretRect(OfficeTwipsRect(x: 1418, y: 1418, width: 0, height: 552)), activePart: 0)

        var actual = NSRange(location: NSNotFound, length: 0)
        let rect = view.firstRect(forCharacterRange: NSRange(location: 0, length: 0), actualRange: &actual)
        XCTAssertNotEqual(rect, .zero, "a real tracked caret rect, matching part, in a real window — "
                          + "must produce a real screen rect")
        view.unmount()
    }

    /// The SAME part-mismatch discipline `layoutOverlays()` already enforces for the caret overlay
    /// itself — a caret rect stamped against a part the canvas has since navigated away from must
    /// never be reported as "here," to LOK's own candidate-window positioning any more than to the
    /// overlay's own drawing.
    func testFirstRectIsZeroWhenTrackedCaretPartDoesNotMatchCanvasPart() async {
        let (runtime, recorder) = await makeOpenedRuntime()
        let view = makeMountedView(runtime: runtime, docId: "doc-1") // initialPart: 0
        _ = await waitUntil { recorder.subscribeCalls.count >= 1 }
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 300, height: 300),
                              styleMask: [.borderless], backing: .buffered, defer: true)
        window.isReleasedWhenClosed = false // see testFirstRectIsZeroWhenNoCaretRectIsTrackedYet's own comment
        defer { window.close() }
        window.contentView = view

        runtime.cursorStore.apply(docId: "doc-1", event: .caretRect(OfficeTwipsRect(x: 1418, y: 1418, width: 0, height: 552)), activePart: 1)

        var actual = NSRange(location: NSNotFound, length: 0)
        let rect = view.firstRect(forCharacterRange: NSRange(location: 0, length: 0), actualRange: &actual)
        XCTAssertEqual(rect, .zero, "the tracked rect belongs to part 1; this canvas is on part 0 — "
                      + "must not report a stale-part rect")
        view.unmount()
    }

    /// **The advisor-flagged regression this task's own classifier fix targets.** Before the
    /// `.control` exclusion, a Ctrl-held key reported a non-zero `charactersIgnoringModifiers`
    /// scalar (the base letter) and was misclassified text-generating — this pins the FIXED
    /// behavior directly against `forwardKeyEvent`'s own observable wire payload for a real Ctrl+A
    /// keyUp (the one call site `isTextGeneratingKeyEvent` still gates for every key, per that
    /// method's own header): charCode must be `0`, matching "this is not text to insert."
    func testControlHeldKeyUpPostsZeroCharCodeNotTheBaseLetter() async throws {
        let (runtime, recorder) = await makeOpenedRuntime()
        let view = makeMountedView(runtime: runtime)

        let event = try XCTUnwrap(NSEvent.keyEvent(with: .keyUp, location: .zero, modifierFlags: [.control],
                                                    timestamp: 0, windowNumber: 0, context: nil,
                                                    characters: "a", charactersIgnoringModifiers: "a",
                                                    isARepeat: false, keyCode: 0))
        view.keyUp(with: event)
        await runtime.drainInputChainForTesting()

        XCTAssertEqual(recorder.postKeyCalls.count, 1)
        XCTAssertEqual(recorder.postKeyCalls[0].charCode, 0, "Ctrl+A is a command, not text — charCode "
                      + "must be 0, never 97")
        view.unmount()
    }

    /// **The end-to-end routing proof** — not just that `insertText` posts the right thing when
    /// called directly (the tests above), but that a REAL plain-ASCII `keyDown` genuinely reaches it
    /// THROUGH `interpretKeyEvents`, never through the old direct `forwardKeyEvent` call `keyDown`'s
    /// own guard now withholds from every text-generating key. `keyCode: 0` is the discriminator:
    /// `insertText`'s own path always posts `0` (no real physical key behind synthetic text — see its
    /// own header); had this key WRONGLY fallen through to `forwardKeyEvent`'s direct path instead,
    /// physical keyCode `0` maps to `Key.a = 512` in `OfficeInputCodes`'s own table — a plainly
    /// DIFFERENT, nonzero value this assertion would catch.
    func testPlainAsciiKeyDownRoutesThroughInterpretKeyEventsNotDirectlyToForwardKeyEvent() async throws {
        let (runtime, recorder) = await makeOpenedRuntime()
        let view = makeMountedView(runtime: runtime)
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 300, height: 300),
                              styleMask: [.borderless], backing: .buffered, defer: true)
        window.isReleasedWhenClosed = false // see testFirstRectIsZeroWhenNoCaretRectIsTrackedYet's own comment
        defer { window.close() }
        window.contentView = view
        _ = window.makeFirstResponder(view)

        let event = try XCTUnwrap(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [],
                                                    timestamp: 0, windowNumber: window.windowNumber, context: nil,
                                                    characters: "a", charactersIgnoringModifiers: "a",
                                                    isARepeat: false, keyCode: 0))
        view.keyDown(with: event)
        await runtime.drainInputChainForTesting()

        let arrived = await waitUntil { recorder.postKeyCalls.count >= 1 }
        XCTAssertTrue(arrived, "interpretKeyEvents never resolved to insertText for a plain 'a' — "
                      + "routing regressed to something that produces no postKey call at all")
        guard arrived else { return }
        // Fix round 1, M-6: `>= 1` above only proves ARRIVAL, not the absence of a SECOND delivery —
        // a regressed double-post (this classifier's own `interpretKeyEvents` path AND the old direct
        // `forwardKeyEvent` path both firing) would still leave `postKeyCalls[0]` matching charCode 97
        // / keyCode 0 below and pass undetected. The input chain is already fully drained above, so
        // by this point the count is settled, not still arriving — a hard `== 1` is the direct pin.
        XCTAssertEqual(recorder.postKeyCalls.count, 1, "exactly one delivery — a second entry would "
                      + "mean the old direct forwardKeyEvent path ALSO fired: the double-delivery "
                      + "this task's whole seam exists to prevent (see this test's own header)")
        XCTAssertEqual(recorder.postKeyCalls[0].charCode, 97)
        XCTAssertEqual(recorder.postKeyCalls[0].keyCode, 0, "must be insertText's own 0, not "
                      + "forwardKeyEvent's physical-keyCode 512 (Key.a) — see this test's own header")

        view.unmount()
    }

    // MARK: - Office Stage B Task 6: clipboard, undo/redo, the menu pass

    /// `copy(_:)`/`cut(_:)` are direct method calls (this file's own established pattern —
    /// `setActivePart(1)` above does the identical thing) rather than a routed `NSApp` menu
    /// action: whether AppKit's own `performKeyEquivalent:`/menu validation actually reaches this
    /// view is disclosed as untestable under xctest at the call site's own header (`keyDown`'s
    /// policy comment) — what IS tested here is that these methods, once reached, do the right
    /// thing.
    func testCopyCallsRuntimePostClipboardCopyForTheOpenDocument() async {
        let (runtime, recorder) = await makeOpenedRuntime()
        let model = PanelDocumentTabModel(tabId: "t1", path: gatePath)
        let sizeTwips = OfficeDocumentSize(widthTwips: 100_000, heightTwips: 100_000)
        let view = OfficeTileCanvasView(runtime: runtime, path: gatePath, docId: "doc-1",
                                        sizeTwips: sizeTwips, initialPart: 0, model: model)
        view.copy(nil)
        await runtime.drainInputChainForTesting()
        XCTAssertEqual(recorder.clipboardCopyCalls.count, 1)
        view.unmount()
    }

    func testCutCallsRuntimePostClipboardCutForTheOpenDocument() async {
        let (runtime, recorder) = await makeOpenedRuntime()
        let model = PanelDocumentTabModel(tabId: "t1", path: gatePath)
        let sizeTwips = OfficeDocumentSize(widthTwips: 100_000, heightTwips: 100_000)
        let view = OfficeTileCanvasView(runtime: runtime, path: gatePath, docId: "doc-1",
                                        sizeTwips: sizeTwips, initialPart: 0, model: model)
        view.cut(nil)
        await runtime.drainInputChainForTesting()
        XCTAssertEqual(recorder.clipboardCutCalls.count, 1)
        view.unmount()
    }

    func testUndoAndRedoCallTheirRuntimeDoors() async {
        let (runtime, recorder) = await makeOpenedRuntime()
        let model = PanelDocumentTabModel(tabId: "t1", path: gatePath)
        let sizeTwips = OfficeDocumentSize(widthTwips: 100_000, heightTwips: 100_000)
        let view = OfficeTileCanvasView(runtime: runtime, path: gatePath, docId: "doc-1",
                                        sizeTwips: sizeTwips, initialPart: 0, model: model)
        view.undo(nil)
        view.redo(nil)
        await runtime.drainInputChainForTesting()
        XCTAssertEqual(recorder.undoCalls.count, 1)
        XCTAssertEqual(recorder.redoCalls.count, 1)
        view.unmount()
    }

    /// **Reads the REAL system pasteboard, save/restored around the test** — `paste(_:)` is
    /// deliberately gesture-time-synchronous (its own header: never re-read from inside the async
    /// chain), so there is no injected seam to substitute the way `OfficeRuntime`'s own
    /// `writeSystemPasteboard` lets `postClipboardCopy`/`Cut` avoid the real pasteboard. The prior
    /// contents are captured before this test writes anything and restored in every exit path.
    func testPasteReadsTheSystemPasteboardAndCallsRuntimePostClipboardPaste() async {
        let pasteboard = NSPasteboard.general
        let priorContents = pasteboard.string(forType: .string)
        defer {
            pasteboard.clearContents()
            if let priorContents { pasteboard.setString(priorContents, forType: .string) }
        }
        pasteboard.clearContents()
        pasteboard.setString("pasted-from-test", forType: .string)

        let (runtime, recorder) = await makeOpenedRuntime()
        let model = PanelDocumentTabModel(tabId: "t1", path: gatePath)
        let sizeTwips = OfficeDocumentSize(widthTwips: 100_000, heightTwips: 100_000)
        let view = OfficeTileCanvasView(runtime: runtime, path: gatePath, docId: "doc-1",
                                        sizeTwips: sizeTwips, initialPart: 0, model: model)
        view.paste(nil)
        await runtime.drainInputChainForTesting()
        XCTAssertEqual(recorder.clipboardPasteCalls.count, 1)
        XCTAssertEqual(recorder.clipboardPasteCalls.first?.text, "pasted-from-test")
        view.unmount()
    }

    /// An empty pasteboard (never `nil`-from-nothing on this system, but no STRING representation)
    /// must not post an empty/garbage paste — `paste(_:)`'s own `guard let text = ...` is the gate.
    func testPasteIsANoOpWhenThePasteboardHasNoStringRepresentation() async {
        let pasteboard = NSPasteboard.general
        let priorContents = pasteboard.string(forType: .string)
        defer {
            pasteboard.clearContents()
            if let priorContents { pasteboard.setString(priorContents, forType: .string) }
        }
        pasteboard.clearContents() // a cleared pasteboard has no .string representation at all

        let (runtime, recorder) = await makeOpenedRuntime()
        let model = PanelDocumentTabModel(tabId: "t1", path: gatePath)
        let sizeTwips = OfficeDocumentSize(widthTwips: 100_000, heightTwips: 100_000)
        let view = OfficeTileCanvasView(runtime: runtime, path: gatePath, docId: "doc-1",
                                        sizeTwips: sizeTwips, initialPart: 0, model: model)
        view.paste(nil)
        await runtime.drainInputChainForTesting()
        XCTAssertTrue(recorder.clipboardPasteCalls.isEmpty, "an empty pasteboard must never reach "
                      + "the driver — there is nothing to paste")
        view.unmount()
    }

    /// `validateMenuItem`'s Copy/Cut gate reads `runtime.cursorStore.state(docId:)` keyed by the
    /// VIEW's own `docId` property (`"doc-1"`, this file's own established construction literal —
    /// NOT the runtime's real internal docId, which `postClipboardCopy`/etc. resolve independently
    /// from `path`; see `OfficeCursorStore`'s own per-docId keying) — seeded directly here via
    /// `runtime.handle(documentEvent:docId:)`, the exact door `OfficeRuntime.handle(documentEvent:
    /// docId:)`'s own production callers use.
    func testValidateMenuItemGatesCopyAndCutOnNonEmptySelection() async {
        let (runtime, _) = await makeOpenedRuntime()
        let model = PanelDocumentTabModel(tabId: "t1", path: gatePath)
        let sizeTwips = OfficeDocumentSize(widthTwips: 100_000, heightTwips: 100_000)
        let view = OfficeTileCanvasView(runtime: runtime, path: gatePath, docId: "doc-1",
                                        sizeTwips: sizeTwips, initialPart: 0, model: model)
        let copyItem = NSMenuItem(title: "Copy", action: #selector(OfficeTileCanvasView.copy(_:)), keyEquivalent: "")
        let cutItem = NSMenuItem(title: "Cut", action: #selector(OfficeTileCanvasView.cut(_:)), keyEquivalent: "")

        XCTAssertFalse(view.validateMenuItem(copyItem), "no selection yet — Copy must start disabled")
        XCTAssertFalse(view.validateMenuItem(cutItem), "no selection yet — Cut must start disabled")

        runtime.handle(documentEvent: .textSelection([OfficeTwipsRect(x: 0, y: 0, width: 100, height: 100)]), docId: "doc-1")
        XCTAssertTrue(view.validateMenuItem(copyItem), "a real selection must enable Copy")
        XCTAssertTrue(view.validateMenuItem(cutItem), "a real selection must enable Cut")

        runtime.handle(documentEvent: .textSelection([]), docId: "doc-1")
        XCTAssertFalse(view.validateMenuItem(copyItem), "the selection collapsing back to empty must disable Copy again")

        view.unmount()
    }

    /// **Review fix round 1 (I-3) — the Calc case `selectionRectsTwips` alone misses.** A plain
    /// click on a Calc cell (no drag) never populates `TEXT_SELECTION` — T5's own probe found Calc
    /// fires the bare `"EMPTY"` sentinel for exactly this, folded to `[]` by the parser — while
    /// `CELL_CURSOR` is what actually carries the live cell state. Before this fix,
    /// `validateMenuItem` reported Copy/Cut DISABLED in precisely the state commit `73f89c9b`'s own
    /// live drill proves `clipboardCopy` genuinely works in (a plain click, no drag) — a real,
    /// reachable bug this test pins shut.
    func testValidateMenuItemGatesCopyAndCutOnALiveCellCursorToo() async {
        let (runtime, _) = await makeOpenedRuntime(documentType: .spreadsheet)
        let model = PanelDocumentTabModel(tabId: "t1", path: gatePath)
        let sizeTwips = OfficeDocumentSize(widthTwips: 100_000, heightTwips: 100_000)
        let view = OfficeTileCanvasView(runtime: runtime, path: gatePath, docId: "doc-1",
                                        sizeTwips: sizeTwips, initialPart: 0, model: model)
        let copyItem = NSMenuItem(title: "Copy", action: #selector(OfficeTileCanvasView.copy(_:)), keyEquivalent: "")
        let cutItem = NSMenuItem(title: "Cut", action: #selector(OfficeTileCanvasView.cut(_:)), keyEquivalent: "")

        XCTAssertFalse(view.validateMenuItem(copyItem), "no cell cursor yet — Copy must start disabled")

        runtime.handle(documentEvent: .cellCursor(.at(rectTwips: OfficeTwipsRect(x: 0, y: 0, width: 1265, height: 254),
                                                       column: 0, row: 0)),
                       docId: "doc-1")
        XCTAssertTrue(view.validateMenuItem(copyItem), "a live cell cursor (`.at`) must enable Copy "
                      + "even with `selectionRectsTwips` empty — the plain-click Calc case")
        XCTAssertTrue(view.validateMenuItem(cutItem), "same for Cut")

        view.unmount()
    }

    func testValidateMenuItemGatesPasteOnPasteboardContent() async {
        let pasteboard = NSPasteboard.general
        let priorContents = pasteboard.string(forType: .string)
        defer {
            pasteboard.clearContents()
            if let priorContents { pasteboard.setString(priorContents, forType: .string) }
        }
        let (runtime, _) = await makeOpenedRuntime()
        let model = PanelDocumentTabModel(tabId: "t1", path: gatePath)
        let sizeTwips = OfficeDocumentSize(widthTwips: 100_000, heightTwips: 100_000)
        let view = OfficeTileCanvasView(runtime: runtime, path: gatePath, docId: "doc-1",
                                        sizeTwips: sizeTwips, initialPart: 0, model: model)
        let pasteItem = NSMenuItem(title: "Paste", action: #selector(OfficeTileCanvasView.paste(_:)), keyEquivalent: "")

        pasteboard.clearContents()
        XCTAssertFalse(view.validateMenuItem(pasteItem), "an empty pasteboard must disable Paste")

        pasteboard.setString("something", forType: .string)
        XCTAssertTrue(view.validateMenuItem(pasteItem), "a real string on the pasteboard must enable Paste")

        view.unmount()
    }

    /// Undo/Redo/Zoom are reachability-gated only (this task's own disclosed scope, not a full
    /// LOK-backed canUndo/canRedo signal — `validateMenuItem`'s own header names the follow-up):
    /// `true` regardless of document/selection/pasteboard state, since being asked to validate AT
    /// ALL already answers the only question this gate currently asks.
    func testValidateMenuItemReturnsTrueForUndoRedoAndZoomRegardlessOfState() async {
        let (runtime, _) = await makeOpenedRuntime()
        let model = PanelDocumentTabModel(tabId: "t1", path: gatePath)
        let sizeTwips = OfficeDocumentSize(widthTwips: 100_000, heightTwips: 100_000)
        let view = OfficeTileCanvasView(runtime: runtime, path: gatePath, docId: "doc-1",
                                        sizeTwips: sizeTwips, initialPart: 0, model: model)
        let items: [NSMenuItem] = [
            NSMenuItem(title: "Undo", action: #selector(OfficeTileCanvasView.undo(_:)), keyEquivalent: ""),
            NSMenuItem(title: "Redo", action: #selector(OfficeTileCanvasView.redo(_:)), keyEquivalent: ""),
            NSMenuItem(title: "Zoom In", action: #selector(OfficeTileCanvasView.zoomIn(_:)), keyEquivalent: ""),
            NSMenuItem(title: "Zoom Out", action: #selector(OfficeTileCanvasView.zoomOut(_:)), keyEquivalent: ""),
            NSMenuItem(title: "Actual Size", action: #selector(OfficeTileCanvasView.actualSize(_:)), keyEquivalent: ""),
        ]
        for item in items {
            XCTAssertTrue(view.validateMenuItem(item), "\(item.title) must be reachability-gated only")
        }
        view.unmount()
    }

    /// The zoom actions' own effect — reuse of the SAME `zoomStep`/`officeZoomIn`/`officeZoomOut`
    /// machinery `keyDown`'s ⌘±/⌘0 switch already drives (Stage B Task 4), just called from a
    /// menu-shaped door instead of a key equivalent.
    func testZoomInZoomOutActualSizeActionsMoveZoomPPTAlongTheSameLadderTheKeysUse() async {
        let (runtime, _) = await makeOpenedRuntime()
        let model = PanelDocumentTabModel(tabId: "t1", path: gatePath)
        let sizeTwips = OfficeDocumentSize(widthTwips: 100_000, heightTwips: 100_000)
        let view = OfficeTileCanvasView(runtime: runtime, path: gatePath, docId: "doc-1",
                                        sizeTwips: sizeTwips, initialPart: 0, model: model)
        view.frame = NSRect(x: 0, y: 0, width: 300, height: 300)
        XCTAssertEqual(view.zoomPPT, 1000, "setup: starts at the 100% pin")

        view.zoomIn(nil)
        XCTAssertEqual(view.zoomPPT, 1250, "one ladder step up from 1000")

        view.zoomOut(nil)
        view.zoomOut(nil)
        XCTAssertEqual(view.zoomPPT, 750, "two ladder steps down from 1250")

        view.actualSize(nil)
        XCTAssertEqual(view.zoomPPT, 1000, "Actual Size returns exactly to the 100% pin")

        view.unmount()
    }
}
