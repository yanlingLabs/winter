import XCTest
@testable import Norma

/// Office Stage A Task 4 — the exhaustive, pure table test for `TileMath`: unit conversions, the
/// zoomPPT=1000 identity that pins the Tile Core spec's "256pt tiles at 2x (512px)" line, floor
/// division (including negative twips), viewport->tile-set at every edge (aligned, overhanging,
/// zero-area, straddling zero), and `OfficeTwipsRect.intersects` (touching-but-not-overlapping,
/// zero-size, fully-contained). No LOK, no process spawn, no vendor gate — every test here runs on
/// every machine, every time.
final class TileMathTests: XCTestCase {

    // MARK: - The zoomPPT=1000 identity (Tile Core spec cross-check)

    /// "256pt tiles at 2x (512px)" — the Tile Core spec's own literal pin, re-derived here from
    /// first principles (20 twips/pt, 2x device scale) rather than merely asserting the constant
    /// back at itself: 256pt * 20 twips/pt = 5120 twips; at 2x, 1pt = 2px, so 1 twip = 0.1px =
    /// zoomPPT 1000. If either `TileMath.tilePixelSize` or the twips/pt relationship ever drifts,
    /// this is the test that catches the two going out of sync.
    func testZoomPPT1000MatchesTheTileCoreSpecExactly() {
        let expectedTileTwips: Int64 = 256 * TileMath.twipsPerPoint
        XCTAssertEqual(expectedTileTwips, 5120)
        XCTAssertEqual(TileMath.tileSpanTwips(zoomPPT: 1000), expectedTileTwips)
        XCTAssertEqual(TileMath.twipsToPixels(expectedTileTwips, zoomPPT: 1000), TileMath.tilePixelSize)
        XCTAssertEqual(TileMath.tilePixelSize, 512)
    }

    /// Pins the byte size every transport-decision number in task-4-report.md is computed from —
    /// 1 MiB, not the 256 KiB a 256x256-tile arithmetic slip would produce. See TileMath.swift's
    /// own header for the correction.
    func testBytesPerTileIsOneMebibyte() {
        XCTAssertEqual(TileMath.bytesPerTile, 1_048_576)
        XCTAssertEqual(TileMath.bytesPerTile, TileMath.tilePixelSize * TileMath.tilePixelSize * 4)
    }

    // MARK: - Straight unit conversion

    func testTwipsPointsRoundTrip() {
        XCTAssertEqual(TileMath.twipsToPoints(0), 0)
        XCTAssertEqual(TileMath.twipsToPoints(20), 1)
        XCTAssertEqual(TileMath.twipsToPoints(5120), 256)
        XCTAssertEqual(TileMath.pointsToTwips(0), 0)
        XCTAssertEqual(TileMath.pointsToTwips(1), 20)
        XCTAssertEqual(TileMath.pointsToTwips(256), 5120)
    }

    /// Fix round 1, discretionary: `pixelsToTwips` had zero test coverage (and zero callers) before
    /// this — it is `twipsToPixels`'s own exact inverse, at the SAME zoomPPT, so this pins that
    /// relationship directly rather than leaving the function entirely unexercised.
    func testPixelsToTwipsIsTheInverseOfTwipsToPixelsAndGuardsZeroZoom() {
        XCTAssertEqual(TileMath.pixelsToTwips(512, zoomPPT: 1000), 5120)
        XCTAssertEqual(TileMath.pixelsToTwips(0, zoomPPT: 1000), 0)
        // Round trip at the canonical zoomPPT: twipsToPixels(pixelsToTwips(p)) == p for an exact,
        // evenly-dividing case (both directions use `roundedDivide`, so this holds exactly rather
        // than merely approximately at 1000, where every factor divides cleanly).
        XCTAssertEqual(TileMath.twipsToPixels(TileMath.pixelsToTwips(512, zoomPPT: 1000), zoomPPT: 1000), 512)
        // zoomPPT == 0 is invalid input for BOTH directions -- already guarded before this fix
        // round for pixelsToTwips; twipsToPixels gained the identical guard this round (M2).
        XCTAssertEqual(TileMath.pixelsToTwips(512, zoomPPT: 0), 0)
        XCTAssertEqual(TileMath.twipsToPixels(5120, zoomPPT: 0), 0)
    }

    // MARK: - tileSpanTwips exhaustive table (the zoom ladder, 50%..400%, plus a non-dividing value)

    func testTileSpanTwipsAcrossTheZoomLadder() {
        let table: [(zoomPPT: Int, expectedSpanTwips: Int64)] = [
            (500, 10240),   // 50% zoom, 2x device
            (1000, 5120),   // 100% zoom, 2x device — the canonical/default
            (2000, 2560),   // 200% zoom
            (4000, 1280),   // 400% zoom
            (10000, 512),   // 1 px/twip exactly
            (333, 15375),   // does NOT divide evenly — exercises roundedDivide's rounding, not truncation
        ]
        for (zoomPPT, expected) in table {
            XCTAssertEqual(TileMath.tileSpanTwips(zoomPPT: zoomPPT), expected,
                            "tileSpanTwips(zoomPPT: \(zoomPPT))")
        }
    }

    func testTileSpanTwipsInvalidZoomFallsBackInertly() {
        XCTAssertEqual(TileMath.tileSpanTwips(zoomPPT: 0), Int64(TileMath.tilePixelSize))
        XCTAssertEqual(TileMath.tileSpanTwips(zoomPPT: -100), Int64(TileMath.tilePixelSize))
    }

    /// Every tile at a fixed zoom shares one span, so adjacent boundaries are always exactly
    /// contiguous — checked directly (not merely inferred from the formula) across every zoom in
    /// the ladder above, including the non-dividing 333 case.
    func testAdjacentTileBoundsAreExactlyContiguousAtEveryZoom() throws {
        for zoomPPT in [500, 1000, 2000, 4000, 10000, 333] {
            // Fix round 1: tileBoundsTwips is now Optional (nil only for out-of-range input); every
            // zoomPPT in this ladder is comfortably inside `TileMath.isZoomPPTValid`'s range, so
            // XCTUnwrap documents that assumption with a real failure if it's ever violated.
            let tile0 = try XCTUnwrap(TileMath.tileBoundsTwips(tileX: 0, tileY: 0, zoomPPT: zoomPPT))
            let tile1 = try XCTUnwrap(TileMath.tileBoundsTwips(tileX: 1, tileY: 0, zoomPPT: zoomPPT))
            XCTAssertEqual(tile0.x + tile0.width, tile1.x, "gap/overlap at zoomPPT \(zoomPPT)")
        }
    }

    // MARK: - tileIndex: floor division, including negative twips (the trap a naive `/` hits)

    func testTileIndexFloorDivisionTable() {
        // zoomPPT 1000 -> span 5120, per the identity test above.
        let table: [(twip: Int64, expectedIndex: Int)] = [
            (0, 0),
            (5119, 0),       // last twip still inside tile 0
            (5120, 1),       // first twip of tile 1
            (10239, 1),
            (10240, 2),
            (-1, -1),        // the trap: naive Int64 `/` truncation would give 0, not -1
            (-5120, -1),     // exact left edge of tile -1
            (-5121, -2),
        ]
        for (twip, expected) in table {
            XCTAssertEqual(TileMath.tileIndex(twip: twip, zoomPPT: 1000), expected,
                            "tileIndex(twip: \(twip))")
        }
    }

    func testFloorDivDirectly() {
        XCTAssertEqual(TileMath.floorDiv(0, 5120), 0)
        XCTAssertEqual(TileMath.floorDiv(5119, 5120), 0)
        XCTAssertEqual(TileMath.floorDiv(5120, 5120), 1)
        XCTAssertEqual(TileMath.floorDiv(-1, 5120), -1)
        XCTAssertEqual(TileMath.floorDiv(-5120, 5120), -1)
        XCTAssertEqual(TileMath.floorDiv(-5121, 5120), -2)
        XCTAssertEqual(TileMath.floorDiv(10, 5), 2)
        XCTAssertEqual(TileMath.floorDiv(-10, 5), -2)
    }

    // MARK: - viewport->tile-set (exhaustive edge table)

    func testViewportExactlyOneTileYieldsExactlyThatTile() {
        let viewport = OfficeTwipsRect(x: 0, y: 0, width: 5120, height: 5120)
        let keys = TileMath.viewportTileKeys(part: 7, zoomPPT: 1000, viewportTwips: viewport)
        XCTAssertEqual(keys, [TileKey(part: 7, zoomPPT: 1000, tileX: 0, tileY: 0)])
    }

    func testViewportSpanningExactlyTwoTilesTouchesBothNotThree() {
        let viewport = OfficeTwipsRect(x: 0, y: 0, width: 10240, height: 5120) // exactly 2 tiles wide
        let keys = TileMath.viewportTileKeys(part: 0, zoomPPT: 1000, viewportTwips: viewport)
        XCTAssertEqual(Set(keys), Set([
            TileKey(part: 0, zoomPPT: 1000, tileX: 0, tileY: 0),
            TileKey(part: 0, zoomPPT: 1000, tileX: 1, tileY: 0),
        ]))
    }

    func testViewportWithOneTwipOverhangTouchesTheNextTile() {
        let viewport = OfficeTwipsRect(x: 0, y: 0, width: 5121, height: 5120) // 1 twip into tile 1
        let keys = TileMath.viewportTileKeys(part: 0, zoomPPT: 1000, viewportTwips: viewport)
        XCTAssertEqual(Set(keys.map { $0.tileX }), Set([0, 1]))
    }

    func testViewportOfExactlyOneLessThanATileDoesNotOverhang() {
        let viewport = OfficeTwipsRect(x: 0, y: 0, width: 5119, height: 5120) // 1 twip short
        let keys = TileMath.viewportTileKeys(part: 0, zoomPPT: 1000, viewportTwips: viewport)
        XCTAssertEqual(Set(keys.map { $0.tileX }), Set([0]))
    }

    func testZeroAreaViewportYieldsNoTiles() {
        XCTAssertEqual(TileMath.viewportTileKeys(part: 0, zoomPPT: 1000,
                        viewportTwips: OfficeTwipsRect(x: 0, y: 0, width: 0, height: 5120)), [])
        XCTAssertEqual(TileMath.viewportTileKeys(part: 0, zoomPPT: 1000,
                        viewportTwips: OfficeTwipsRect(x: 0, y: 0, width: 5120, height: 0)), [])
    }

    func testViewportStraddlingZeroCoversTilesOnBothSides() {
        // x in [-100, 100): touches tile -1 ([-5120,0)) and tile 0 ([0,5120)).
        let viewport = OfficeTwipsRect(x: -100, y: 0, width: 200, height: 5120)
        let keys = TileMath.viewportTileKeys(part: 0, zoomPPT: 1000, viewportTwips: viewport)
        XCTAssertEqual(Set(keys.map { $0.tileX }), Set([-1, 0]))
    }

    func testViewportProducesARowMajorTwoByTwoGrid() {
        let viewport = OfficeTwipsRect(x: 0, y: 0, width: 10240, height: 10240) // 2x2 tiles
        let keys = TileMath.viewportTileKeys(part: 3, zoomPPT: 1000, viewportTwips: viewport)
        XCTAssertEqual(Set(keys), Set([
            TileKey(part: 3, zoomPPT: 1000, tileX: 0, tileY: 0),
            TileKey(part: 3, zoomPPT: 1000, tileX: 1, tileY: 0),
            TileKey(part: 3, zoomPPT: 1000, tileX: 0, tileY: 1),
            TileKey(part: 3, zoomPPT: 1000, tileX: 1, tileY: 1),
        ]))
        XCTAssertEqual(keys.count, 4, "no duplicate coordinates")
    }

    // MARK: - invalidation-rect->tile-keys (shares tileCoordinates with viewport, checked directly)

    func testInvalidationRectCoordinatesMatchViewportForTheSameRect() {
        let rect = OfficeTwipsRect(x: 5120, y: 0, width: 5120, height: 10240)
        let viaViewport = Set(TileMath.viewportTileKeys(part: 0, zoomPPT: 1000, viewportTwips: rect))
        let viaInvalidation = Set(TileMath.tileCoordinates(rectTwips: rect, zoomPPT: 1000)
            .map { TileKey(part: 0, zoomPPT: 1000, tileX: $0.tileX, tileY: $0.tileY) })
        XCTAssertEqual(viaViewport, viaInvalidation)
        XCTAssertEqual(viaViewport, Set([
            TileKey(part: 0, zoomPPT: 1000, tileX: 1, tileY: 0),
            TileKey(part: 0, zoomPPT: 1000, tileX: 1, tileY: 1),
        ]))
    }

    // MARK: - OfficeTwipsRect.intersects (the AABB overlap test the cache's invalidation depends on)

    func testIntersectsExhaustiveTable() {
        let a = OfficeTwipsRect(x: 0, y: 0, width: 100, height: 100)

        // Touching exactly at the right edge -- half-open, must NOT intersect.
        XCTAssertFalse(a.intersects(OfficeTwipsRect(x: 100, y: 0, width: 50, height: 50)))
        // Overlapping by 1 twip -- must intersect.
        XCTAssertTrue(a.intersects(OfficeTwipsRect(x: 99, y: 0, width: 50, height: 50)))
        // Touching exactly at the bottom edge -- must NOT intersect.
        XCTAssertFalse(a.intersects(OfficeTwipsRect(x: 0, y: 100, width: 50, height: 50)))
        // Fully contained.
        XCTAssertTrue(a.intersects(OfficeTwipsRect(x: 10, y: 10, width: 10, height: 10)))
        // Identical.
        XCTAssertTrue(a.intersects(a))
        // Fully disjoint.
        XCTAssertFalse(a.intersects(OfficeTwipsRect(x: 1000, y: 1000, width: 10, height: 10)))
        // Zero-size on either side intersects nothing, including itself.
        let zero = OfficeTwipsRect(x: 0, y: 0, width: 0, height: 0)
        XCTAssertFalse(zero.intersects(zero))
        XCTAssertFalse(a.intersects(OfficeTwipsRect(x: 50, y: 50, width: 0, height: 0)))
        // Symmetry.
        let b = OfficeTwipsRect(x: 50, y: 50, width: 200, height: 200)
        XCTAssertEqual(a.intersects(b), b.intersects(a))
    }

    // MARK: - TileKey wire round trip

    func testTileKeyJSONRoundTrips() throws {
        let key = TileKey(part: 2, zoomPPT: 1000, tileX: -3, tileY: 7)
        let object = key.jsonObject()
        let decoded = TileKey.decode(object)
        XCTAssertEqual(decoded, key)
        XCTAssertNil(TileKey.decode(["part": 1])) // missing fields
    }

    // MARK: - Fix round 1: wire-input safety (a reviewer transcribed and RAN these inputs against
    // the pre-fix code; all three trapped the helper, SIGTRAP, exit 133 — killing every open
    // document on every connection. Every case below is the SAME class of input, asserting it is
    // now safely refused (a `nil`/empty/clamped result) rather than crashing the test process
    // itself. A trapping test SIGTRAPs the whole xctest run, not a red assertion — these are the
    // fixed code exercised against the reviewer's own reproduction, not a red-then-green pair.

    /// Trap #1: `indexRange`'s old `origin + length - 1` overflows for a `subscribeTiles.viewportTwips`
    /// near `Int64`'s extremes.
    func testIndexRangeRefusesRatherThanOverflowingOnExtremeOriginAndLength() {
        // The reviewer's own reproduction shape: origin near Int64.max, length pushes it over.
        XCTAssertNil(TileMath.indexRange(origin: Int64.max - 5, length: 100, zoomPPT: 1000),
                      "origin + length overflows Int64.max — must refuse, not trap")
        XCTAssertNil(TileMath.indexRange(origin: Int64.max, length: 1, zoomPPT: 1000),
                      "the tightest possible overflow: origin already AT the max, any positive length overflows")
        // `length` is only ever reached here as a POSITIVE value (the `length > 0` guard above this
        // runs first) — verified directly, not just argued: `origin + length` with length > 0 can
        // only overflow past Int64.max, never underflow below Int64.min (adding a positive number
        // moves the sum toward positive, not further negative), so there is no symmetric
        // "negative-side" overflow case for this SPECIFIC addition to reproduce — confirmed against
        // the real `Int64.addingReportingOverflow` before writing this comment, not assumed. Sanity
        // check in the OTHER direction: origin at the opposite extreme with a small positive length
        // is fully representable and must NOT spuriously refuse.
        XCTAssertNotNil(TileMath.indexRange(origin: Int64.min, length: 100, zoomPPT: 1000))

        // The legitimate degenerate case (`length <= 0`) must still read as "nothing to cover",
        // unchanged by the new overflow guard sitting right next to it.
        XCTAssertNil(TileMath.indexRange(origin: 0, length: 0, zoomPPT: 1000))
        XCTAssertNil(TileMath.indexRange(origin: 0, length: -1, zoomPPT: 1000))
        // And a normal, comfortably-representable case still works exactly as before.
        XCTAssertEqual(TileMath.indexRange(origin: 0, length: 5120, zoomPPT: 1000), 0...0)
    }

    /// Trap #2: `tileCoordinates`'s old `reserveCapacity(xRange.count * yRange.count)` overflows
    /// Int for a huge-enough viewport, AND (the non-trapping variant the reviewer also measured) a
    /// representable-but-huge viewport would enumerate billions of keys — OOM/stall building one
    /// NDJSON line. Both are refused via the SAME `estimatedTileCount`/cap mechanism now.
    func testEstimatedTileCountAllFourOutcomes() {
        // (a) Legitimately empty — zero-area on either axis — is 0, not a refusal.
        XCTAssertEqual(TileMath.estimatedTileCount(
            rectTwips: OfficeTwipsRect(x: 0, y: 0, width: 0, height: 5120), zoomPPT: 1000), 0)
        XCTAssertEqual(TileMath.estimatedTileCount(
            rectTwips: OfficeTwipsRect(x: 0, y: 0, width: 5120, height: 0), zoomPPT: 1000), 0)

        // (b) A normal, small viewport is a real, small, non-nil count.
        XCTAssertEqual(TileMath.estimatedTileCount(
            rectTwips: OfficeTwipsRect(x: 0, y: 0, width: 10240, height: 10240), zoomPPT: 1000), 4)

        // (c) Representable-but-huge (NOT an overflow — both axis counts and their product are
        // valid, non-overflowing Int64 values) — 10,000,000 tiles/axis at zoomPPT 1000 is a real,
        // computable ~1e14-tile viewport, refused purely for exceeding `maxTilesPerRectEnumeration`.
        // This is the reviewer's own "38 billion keys" class, sized to stay clear of overflow so
        // this case is provably distinct from (d) below.
        let hugeButRepresentable = OfficeTwipsRect(x: 0, y: 0, width: 5120 * 10_000_000, height: 5120 * 10_000_000)
        XCTAssertNil(TileMath.estimatedTileCount(rectTwips: hugeButRepresentable, zoomPPT: 1000),
                      "~1e14 tiles is representable arithmetic but must still be refused as too large")

        // (d) Genuine overflow: at the finest allowed zoom (maxZoomPPT, span == 5 twips/tile — see
        // tileSpanTwips), a length just under Int64.max/2 (avoiding indexRange's OWN overflow
        // guard) produces a single-axis count around 9.2e17 — squaring that for a 2D viewport
        // overflows Int64 (~9.2e18) in the multiplication itself, not merely exceeding the cap.
        let overflowing = OfficeTwipsRect(x: 0, y: 0, width: Int64.max / 2 - 1, height: Int64.max / 2 - 1)
        XCTAssertNil(TileMath.estimatedTileCount(rectTwips: overflowing, zoomPPT: TileMath.maxZoomPPT),
                      "a genuinely overflowing tile count must also refuse, not trap")
    }

    /// `tileCoordinates`/`viewportTileKeys` must never attempt to build the reviewer's "38 billion
    /// keys" list — delegating to `estimatedTileCount` means the huge case above returns an EMPTY
    /// array (refused), never a multi-gigabyte allocation or a trapped multiplication. Runs in
    /// milliseconds if the guard is doing its job; a regression here would hang or OOM the test
    /// process, not fail an assertion cleanly — the guard's presence IS the correctness property.
    func testTileCoordinatesRefusesAHugeButRepresentableViewportInsteadOfEnumeratingIt() {
        let huge = OfficeTwipsRect(x: 0, y: 0, width: 5120 * 10_000_000, height: 5120 * 10_000_000)
        XCTAssertEqual(TileMath.tileCoordinates(rectTwips: huge, zoomPPT: 1000).count, 0)
        XCTAssertEqual(TileMath.viewportTileKeys(part: 0, zoomPPT: 1000, viewportTwips: huge), [])
    }

    /// Trap #3: `tileBoundsTwips`'s old `Int64(tileX) * span` overflows for a hostile
    /// `tileRequest.keys` entry (or a poisoned key already sitting in `TileCache`'s never-evicted
    /// ledger, recomputed on a LATER, otherwise-unrelated invalidation — see `TileCache.invalidate`'s
    /// own test coverage in `TileCacheTests.swift` for that half).
    func testTileBoundsTwipsRefusesOutOfRangeTileIndicesRatherThanOverflowing() {
        XCTAssertNil(TileMath.tileBoundsTwips(tileX: Int.max, tileY: 0, zoomPPT: 1000),
                      "Int.max tileX must refuse, not overflow the multiplication")
        XCTAssertNil(TileMath.tileBoundsTwips(tileX: 0, tileY: Int.max, zoomPPT: 1000))
        // The `abs(Int.min)` class of bug this fix round exists to close: `Int.min` itself has no
        // positive `Int` representation, so any guard written as `abs(index) <= bound` TRAPS on
        // this exact input — `isTileIndexValid` uses a symmetric range comparison instead
        // (`index >= -bound && index <= bound`), which must handle `Int.min` without trapping.
        XCTAssertNil(TileMath.tileBoundsTwips(tileX: Int.min, tileY: 0, zoomPPT: 1000),
                      "Int.min tileX is the abs()-traps class of bug — must refuse cleanly")
        XCTAssertFalse(TileMath.isTileIndexValid(Int.min), "sanity: the predicate itself must not trap either")
        XCTAssertFalse(TileMath.isTileIndexValid(Int.max))
        // A normal, in-range key still works exactly as before, just wrapped in Optional now.
        XCTAssertEqual(TileMath.tileBoundsTwips(tileX: 0, tileY: 0, zoomPPT: 1000),
                        OfficeTwipsRect(x: 0, y: 0, width: 5120, height: 5120))
    }

    /// `isZoomPPTValid`/`isTileIndexValid` boundary table — one twip inside vs. one twip outside
    /// each edge, both directions.
    func testValidityPredicateBoundaries() {
        XCTAssertTrue(TileMath.isZoomPPTValid(TileMath.minZoomPPT))
        XCTAssertFalse(TileMath.isZoomPPTValid(TileMath.minZoomPPT - 1))
        XCTAssertTrue(TileMath.isZoomPPTValid(TileMath.maxZoomPPT))
        XCTAssertFalse(TileMath.isZoomPPTValid(TileMath.maxZoomPPT + 1))
        XCTAssertFalse(TileMath.isZoomPPTValid(0))

        XCTAssertTrue(TileMath.isTileIndexValid(TileMath.maxTileIndexMagnitude))
        XCTAssertTrue(TileMath.isTileIndexValid(-TileMath.maxTileIndexMagnitude))
        XCTAssertFalse(TileMath.isTileIndexValid(TileMath.maxTileIndexMagnitude + 1))
        XCTAssertFalse(TileMath.isTileIndexValid(-TileMath.maxTileIndexMagnitude - 1))
    }

    /// The root cause underneath trap #3's OWN guard, found while fixing it (not one of the
    /// reviewer's three named traps, but the same class): a large enough `zoomPPT` rounds
    /// `tileSpanTwips` down to 0, and `floorDiv`'s `a % b` traps on a zero divisor — reachable from
    /// `tileIndex`/`indexRange`/`tileCoordinates`, all exposed to `subscribeTiles.zoomPPT`.
    /// `isZoomPPTValid`'s handler-level bound keeps every validated caller far from this edge, but
    /// `tileSpanTwips` itself is now ALSO safe unconditionally (`max(span, 1)`) — checked directly
    /// here at a zoomPPT far past where the raw division would round to 0.
    func testTileSpanTwipsNeverUnderflowsToZeroEvenPastWhereTheDivisionWouldRoundDownToIt() {
        XCTAssertGreaterThanOrEqual(TileMath.tileSpanTwips(zoomPPT: 50_000_000), 1)
        XCTAssertGreaterThanOrEqual(TileMath.tileSpanTwips(zoomPPT: Int.max), 1)
        // And, given that guarantee, tileIndex/indexRange must not divide-by-zero at that same
        // extreme zoomPPT either — this is the actual downstream consumer the guard protects.
        XCTAssertEqual(TileMath.tileIndex(twip: 0, zoomPPT: Int.max), 0)
    }
}
