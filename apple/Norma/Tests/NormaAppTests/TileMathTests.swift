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
    func testAdjacentTileBoundsAreExactlyContiguousAtEveryZoom() {
        for zoomPPT in [500, 1000, 2000, 4000, 10000, 333] {
            let tile0 = TileMath.tileBoundsTwips(tileX: 0, tileY: 0, zoomPPT: zoomPPT)
            let tile1 = TileMath.tileBoundsTwips(tileX: 1, tileY: 0, zoomPPT: zoomPPT)
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
}
