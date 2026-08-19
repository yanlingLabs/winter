import XCTest
@testable import Norma

/// Office Stage A Task 4 — the exhaustive, pure table test for `TileCache`: generation bookkeeping,
/// LRU eviction (the brief's own "pool-LRU eviction test"), and the EMPTY-invalidation inversion
/// trap (an empty rect list means "bump everything," not "intersects nothing so bump nothing").
final class TileCacheTests: XCTestCase {
    private func key(_ x: Int, _ y: Int, part: Int = 0, zoomPPT: Int = 1000) -> TileKey {
        TileKey(part: part, zoomPPT: zoomPPT, tileX: x, tileY: y)
    }
    private func pixels(_ tag: UInt8) -> Data { Data(repeating: tag, count: 16) }

    // MARK: - Basic paint/lookup

    func testFirstPaintOfANeverSeenKeyReportsGenerationZero() {
        var cache = TileCache(capacity: 32)
        let generation = cache.recordPaint(key: key(0, 0), pixels: pixels(1))
        XCTAssertEqual(generation, 0)
        XCTAssertEqual(cache.lookup(key: key(0, 0)), TileCache.Entry(generation: 0, pixels: pixels(1)))
    }

    func testLookupMissForAnUnpaintedKey() {
        var cache = TileCache(capacity: 32)
        XCTAssertNil(cache.lookup(key: key(9, 9)))
    }

    // MARK: - LRU eviction (the brief's own required test)

    func testLeastRecentlyUsedEntryIsEvictedWhenCapacityExceeded() {
        var cache = TileCache(capacity: 2)
        cache.recordPaint(key: key(0, 0), pixels: pixels(1))
        cache.recordPaint(key: key(1, 0), pixels: pixels(2))
        XCTAssertEqual(cache.cachedCount, 2)
        cache.recordPaint(key: key(2, 0), pixels: pixels(3)) // over capacity -> evicts (0,0), the LRU
        XCTAssertEqual(cache.cachedCount, 2)
        XCTAssertNil(cache.lookup(key: key(0, 0)), "the least-recently-used entry must be gone")
        XCTAssertNotNil(cache.lookup(key: key(1, 0)))
        XCTAssertNotNil(cache.lookup(key: key(2, 0)))
    }

    func testLookupHitCountsAsUseAndProtectsFromEviction() {
        var cache = TileCache(capacity: 2)
        cache.recordPaint(key: key(0, 0), pixels: pixels(1)) // LRU order: [(0,0)]
        cache.recordPaint(key: key(1, 0), pixels: pixels(2)) // LRU order: [(0,0),(1,0)]
        _ = cache.lookup(key: key(0, 0))                     // touch (0,0) -> LRU order: [(1,0),(0,0)]
        cache.recordPaint(key: key(2, 0), pixels: pixels(3)) // evicts (1,0), now the LRU
        XCTAssertNotNil(cache.lookup(key: key(0, 0)), "touched entry must survive")
        XCTAssertNil(cache.lookup(key: key(1, 0)), "the entry that was NOT touched must be evicted")
        XCTAssertNotNil(cache.lookup(key: key(2, 0)))
    }

    func testCapacityThirtyTwoMatchesTheBriefsPoolSizeAndTheThirtyThirdEvictsTheFirst() {
        var cache = TileCache(capacity: 32)
        // NOTE: deliberately no "setup" lookup() of key(0,0) here before the 33rd paint — lookup()
        // itself touches (MRU-promotes) whatever key it reads, so an interstitial "is it still
        // cached" check would itself change which key is actually least-recently-used, silently
        // invalidating this test's own premise (caught on first run: it evicted key(1,0) instead).
        for i in 0..<32 { cache.recordPaint(key: key(i, 0), pixels: pixels(UInt8(i))) }
        XCTAssertEqual(cache.cachedCount, 32)
        cache.recordPaint(key: key(32, 0), pixels: pixels(99)) // the 33rd distinct tile
        XCTAssertEqual(cache.cachedCount, 32, "pool never exceeds capacity")
        XCTAssertNil(cache.lookup(key: key(0, 0)), "the 33rd paint must evict the 1st (least-recently-used)")
        XCTAssertNotNil(cache.lookup(key: key(32, 0)))
    }

    func testCapacityIsClampedToAtLeastOne() {
        var cache = TileCache(capacity: 0)
        cache.recordPaint(key: key(0, 0), pixels: pixels(1))
        XCTAssertEqual(cache.cachedCount, 1)
    }

    func testRePaintingAnAlreadyCachedKeyDoesNotDoubleCount() {
        var cache = TileCache(capacity: 2)
        cache.recordPaint(key: key(0, 0), pixels: pixels(1))
        cache.recordPaint(key: key(0, 0), pixels: pixels(9)) // same key again
        XCTAssertEqual(cache.cachedCount, 1)
        XCTAssertEqual(cache.lookup(key: key(0, 0))?.pixels, pixels(9))
    }

    // MARK: - Generation bumping: the non-empty, part-scoped case

    func testNonEmptyInvalidationOnlyBumpsIntersectingKeysOfTheMatchingPart() {
        var cache = TileCache(capacity: 32)
        cache.recordPaint(key: key(0, 0, part: 0), pixels: pixels(1)) // will intersect
        cache.recordPaint(key: key(5, 5, part: 0), pixels: pixels(2)) // will NOT intersect (far away)
        cache.recordPaint(key: key(0, 0, part: 1), pixels: pixels(3)) // same coords, DIFFERENT part

        let dirtyRect = TileMath.tileBoundsTwips(tileX: 0, tileY: 0, zoomPPT: 1000)
        let bumped = cache.invalidate(rectsTwips: [dirtyRect], part: 0)

        XCTAssertEqual(Set(bumped), [key(0, 0, part: 0)])
        XCTAssertEqual(cache.lookup(key: key(0, 0, part: 0)), nil, "bumped key's stale pixels are evicted")
        XCTAssertNotNil(cache.lookup(key: key(5, 5, part: 0)), "non-intersecting key untouched")
        XCTAssertNotNil(cache.lookup(key: key(0, 0, part: 1)), "other-part key untouched despite same coords")
    }

    /// The inversion trap the advisor flagged: an EMPTY rect list is LOK's "drop every tile"
    /// sentinel, not "no rectangles to intersect." A naive reading would bump zero keys here; the
    /// correct behavior bumps every key this cache has ever painted, across every part.
    func testEmptyInvalidationBumpsEveryCachedKeyAcrossEveryPart() {
        var cache = TileCache(capacity: 32)
        cache.recordPaint(key: key(0, 0, part: 0), pixels: pixels(1))
        cache.recordPaint(key: key(9, 9, part: 0), pixels: pixels(2))
        cache.recordPaint(key: key(0, 0, part: 1), pixels: pixels(3))

        let bumped = cache.invalidate(rectsTwips: [], part: 0) // EMPTY, part is a don't-care here
        XCTAssertEqual(Set(bumped), Set([key(0, 0, part: 0), key(9, 9, part: 0), key(0, 0, part: 1)]),
                        "EMPTY must bump every key ever painted, regardless of part")
        XCTAssertNil(cache.lookup(key: key(0, 0, part: 0)))
        XCTAssertNil(cache.lookup(key: key(9, 9, part: 0)))
        XCTAssertNil(cache.lookup(key: key(0, 0, part: 1)))
    }

    func testInvalidationNeverTouchesAKeyThatWasNeverPainted() {
        var cache = TileCache(capacity: 32)
        cache.recordPaint(key: key(0, 0), pixels: pixels(1))
        let bumped = cache.invalidate(rectsTwips: [], part: 0)
        XCTAssertEqual(bumped, [key(0, 0)], "only the one ever-painted key can be bumped")
    }

    func testInvalidationOnAnEmptyCacheBumpsNothing() {
        var cache = TileCache(capacity: 32)
        XCTAssertEqual(cache.invalidate(rectsTwips: [], part: 0), [])
        let rect = TileMath.tileBoundsTwips(tileX: 0, tileY: 0, zoomPPT: 1000)
        XCTAssertEqual(cache.invalidate(rectsTwips: [rect], part: 0), [])
    }

    // MARK: - Generation persists across eviction (never resets)

    func testGenerationNeverResetsAcrossEvictionAndRepaint() {
        var cache = TileCache(capacity: 1)
        XCTAssertEqual(cache.recordPaint(key: key(0, 0), pixels: pixels(1)), 0) // gen 0
        let bumped = cache.invalidate(rectsTwips: [], part: 0) // gen -> 1, evicted from the pixel pool
        XCTAssertEqual(bumped, [key(0, 0)])
        XCTAssertNil(cache.lookup(key: key(0, 0)), "evicted by the invalidation")

        // A capacity-1 cache holding a DIFFERENT key first, to prove eviction from the pixel pool
        // (via normal LRU, not invalidation) ALSO does not reset the generation ledger.
        cache.recordPaint(key: key(1, 1), pixels: pixels(2)) // LRU-evicts nothing new to check yet
        let repaintGeneration = cache.recordPaint(key: key(0, 0), pixels: pixels(9))
        XCTAssertEqual(repaintGeneration, 1, "generation must be 1 (post-invalidation), never reset to 0")
    }

    func testDoubleInvalidationBumpsTwice() {
        var cache = TileCache(capacity: 32)
        cache.recordPaint(key: key(0, 0), pixels: pixels(1))
        _ = cache.invalidate(rectsTwips: [], part: 0)
        cache.recordPaint(key: key(0, 0), pixels: pixels(2)) // back in the pool at generation 1
        _ = cache.invalidate(rectsTwips: [], part: 0)
        let generation = cache.recordPaint(key: key(0, 0), pixels: pixels(3))
        XCTAssertEqual(generation, 2)
    }

    // MARK: - knownKeysForTesting persistence

    func testKnownKeysPersistPastEviction() {
        var cache = TileCache(capacity: 1)
        cache.recordPaint(key: key(0, 0), pixels: pixels(1))
        cache.recordPaint(key: key(1, 0), pixels: pixels(2)) // evicts (0,0) from the pixel pool
        XCTAssertEqual(cache.knownKeysForTesting, Set([key(0, 0), key(1, 0)]),
                        "the generation ledger remembers a key even after its pixels are evicted")
    }
}
