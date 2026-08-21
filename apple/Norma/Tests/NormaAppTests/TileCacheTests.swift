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

    func testNonEmptyInvalidationOnlyBumpsIntersectingKeysOfTheMatchingPart() throws {
        var cache = TileCache(capacity: 32)
        cache.recordPaint(key: key(0, 0, part: 0), pixels: pixels(1)) // will intersect
        cache.recordPaint(key: key(5, 5, part: 0), pixels: pixels(2)) // will NOT intersect (far away)
        cache.recordPaint(key: key(0, 0, part: 1), pixels: pixels(3)) // same coords, DIFFERENT part

        // Fix round 1: tileBoundsTwips is now Optional (nil only for out-of-range input — see its
        // own doc comment); (0, 0, 1000) is always in range, so XCTUnwrap here documents that
        // assumption with a real, readable failure if it's ever violated, rather than a bare `!`.
        let dirtyRect = try XCTUnwrap(TileMath.tileBoundsTwips(tileX: 0, tileY: 0, zoomPPT: 1000))
        let bumped = cache.invalidate(rectsTwips: [dirtyRect], part: 0)

        XCTAssertEqual(Set(bumped), [key(0, 0, part: 0)])
        XCTAssertEqual(cache.lookup(key: key(0, 0, part: 0)), nil, "bumped key's stale pixels are evicted")
        XCTAssertNotNil(cache.lookup(key: key(5, 5, part: 0)), "non-intersecting key untouched")
        XCTAssertNotNil(cache.lookup(key: key(0, 0, part: 1)), "other-part key untouched despite same coords")
    }

    /// Fix round 1, F3 — LOK's own `-1` "all parts" sentinel (`desktop/inc/lib/init.hxx`'s
    /// `RectangleAndPart`; reachable on a NON-empty rect via `SfxLokHelper::notifyInvalidation`'s
    /// explicit-part overload, independent of whether the rect itself is empty) must bump every
    /// part's key that the rect geometrically intersects — NOT be treated as a literal part number
    /// no real cached key could ever equal (which is what the pre-fix `key.part == part` guard did:
    /// silently bump nothing, every time, for a real, reachable upstream shape). Deliberately reuses
    /// the SAME two-key setup as `testNonEmptyInvalidationOnlyBumpsIntersectingKeysOfTheMatchingPart`
    /// right above — the only variable changed is `part: -1` — so this test is provably the same
    /// scenario with the scoping guard bypassed, not a different geometry doing the work.
    func testNegativeOnePartOnANonEmptyRectBumpsTheIntersectingKeyAcrossEveryPart() throws {
        var cache = TileCache(capacity: 32)
        cache.recordPaint(key: key(0, 0, part: 0), pixels: pixels(1)) // intersects, part 0
        cache.recordPaint(key: key(0, 0, part: 1), pixels: pixels(2)) // intersects, part 1 -- same coords
        cache.recordPaint(key: key(5, 5, part: 0), pixels: pixels(3)) // does NOT intersect -- geometry still applies

        let dirtyRect = try XCTUnwrap(TileMath.tileBoundsTwips(tileX: 0, tileY: 0, zoomPPT: 1000))
        let bumped = cache.invalidate(rectsTwips: [dirtyRect], part: -1)

        XCTAssertEqual(Set(bumped), [key(0, 0, part: 0), key(0, 0, part: 1)],
                        "-1 matches every part at the intersecting coordinate, not a literal part number")
        XCTAssertNil(cache.lookup(key: key(0, 0, part: 0)))
        XCTAssertNil(cache.lookup(key: key(0, 0, part: 1)))
        XCTAssertNotNil(cache.lookup(key: key(5, 5, part: 0)), "non-intersecting key untouched -- -1 bypasses "
                        + "the PART guard only, geometry is still enforced")
    }

    /// Office Stage B Task 4, criterion 5 — DECIDED and pinned here, at the exact call site
    /// (`invalidate`'s own `rectsTwips.contains { $0.intersects(bounds) }`), not merely as a
    /// consequence of `OfficeTwipsRect.intersects`'s own unit tests: a genuinely DEGENERATE rect
    /// (zero width/height) INSIDE a non-empty `rectsTwips` array — distinct from the EMPTY-ARRAY
    /// "bump everything" sentinel this same file's own header explains at length, covered by the
    /// test right above via `testEmptyInvalidationBumpsEveryCachedKeyAcrossEveryPart` elsewhere in
    /// this file — must bump NOTHING. This is the semantically correct reading (a zero-area rect
    /// covers no pixels to invalidate), fails CLOSED, and is exercised here with a REAL cached key
    /// that a non-degenerate rect at the identical origin WOULD have bumped (proven by the second
    /// assertion), so this test cannot pass by vacuously matching nothing regardless of the rect.
    func testADegenerateZeroAreaRectInsideANonEmptyArrayBumpsNothing() throws {
        var cache = TileCache(capacity: 32)
        cache.recordPaint(key: key(0, 0), pixels: pixels(1))

        let zeroArea = OfficeTwipsRect(x: 0, y: 0, width: 0, height: 0)
        let bumpedByZeroArea = cache.invalidate(rectsTwips: [zeroArea], part: 0)
        XCTAssertEqual(bumpedByZeroArea, [], "a degenerate rect inside a non-empty array must bump nothing")
        XCTAssertNotNil(cache.lookup(key: key(0, 0)), "the cached entry must survive untouched")

        // Sanity, same origin: a REAL (non-degenerate) rect at (0,0) DOES bump this key — proves
        // the assertion above is discriminating on area, not merely on this cache never bumping
        // anything for this key at all.
        let realRect = try XCTUnwrap(TileMath.tileBoundsTwips(tileX: 0, tileY: 0, zoomPPT: 1000))
        let bumpedByRealRect = cache.invalidate(rectsTwips: [realRect], part: 0)
        XCTAssertEqual(bumpedByRealRect, [key(0, 0)], "setup check: a real rect at the same origin does bump this key")
    }

    /// Fix round 1, I1 trap #3's "poisoned cached key" half: `recordPaint` is a PURE, unvalidated
    /// API (by design — validation belongs at the wire boundary, `OfficeHelperServer`'s handlers;
    /// see `TileMath.swift`'s own "wire-input safety bounds" header) that accepts any `TileKey`,
    /// including one with an out-of-range `tileX` that could never legitimately reach here through
    /// today's (now-guarded) `tileRequest` handler. Once such a key is in the never-evicted
    /// `generations` ledger by ANY means, a later, otherwise-unrelated non-empty invalidation used
    /// to recompute `tileBoundsTwips` for it unconditionally and CRASH — killing the whole
    /// invalidation pass, including every OTHER, legitimate key it was also trying to check.
    /// `tileBoundsTwips` returning `nil` instead is necessary but not sufficient; this test proves
    /// `TileCache.invalidate`'s own consumption of that `nil` is correct: no crash, the poisoned key
    /// is excluded from the result (never bumped, never evicted — inert), AND a legitimate,
    /// genuinely-intersecting key in the SAME pass still gets bumped normally — proving the filter
    /// continues past the bad key rather than the whole pass silently aborting on it.
    ///
    /// Deliberately NOT attempted over the wire/live helper: the fixture's `FakeOfficeDocumentBridge`
    /// uses wrapping (`&*`/`&+`) arithmetic for its synthetic pixels and never calls
    /// `TileMath.tileBoundsTwips` at all, so it was never at risk and cannot be used to get a
    /// poisoned key into a REAL `TileCache` this way; the real `LOKBridge` path now refuses a
    /// hostile key at paint time (`TileRenderer.renderRaw`'s new `throw`), so it can no longer be
    /// used to plant one either. This pure API is the only reachable way to construct the scenario
    /// at all post-fix — which is itself evidence the wire-level guards are doing their job.
    func testInvalidationSkipsAPoisonedLedgerKeyRatherThanCrashingAndStillBumpsLegitimateKeys() throws {
        var cache = TileCache(capacity: 32)
        let poisoned = key(Int.max, 0, part: 0) // out of TileMath.isTileIndexValid's range
        cache.recordPaint(key: poisoned, pixels: pixels(1))
        cache.recordPaint(key: key(0, 0, part: 0), pixels: pixels(2)) // legitimate, WILL intersect
        cache.recordPaint(key: key(9, 9, part: 0), pixels: pixels(3)) // legitimate, will NOT intersect

        let dirtyRect = try XCTUnwrap(TileMath.tileBoundsTwips(tileX: 0, tileY: 0, zoomPPT: 1000))
        let bumped = cache.invalidate(rectsTwips: [dirtyRect], part: 0) // must not crash

        XCTAssertEqual(bumped, [key(0, 0, part: 0)],
                        "only the legitimate, intersecting key is bumped -- the poisoned key is excluded, "
                        + "not treated as a match, and does not abort the pass for the key after it")
        XCTAssertTrue(cache.knownKeysForTesting.contains(poisoned),
                       "the poisoned key is untouched, not removed -- it just sits inert, same as any "
                       + "other known key nobody has asked about since")
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
        // Micro-round 2: exact sorted-array equality, not Set(bumped) -- a Set comparison is
        // order-insensitive and left `invalidate`'s own sort-by-(part,zoomPPT,tileX,tileY) (fix
        // round 1, discretionary) completely untested despite this being the one test with enough
        // distinct keys to make an ordering assertion meaningful. All three keys share zoomPPT
        // 1000 (the `key()` helper's default), so the tie-broken order is by (part, tileX, tileY):
        // part 0 before part 1; within part 0, tileX 0 before tileX 9.
        XCTAssertEqual(bumped, [key(0, 0, part: 0), key(9, 9, part: 0), key(0, 0, part: 1)],
                        "EMPTY must bump every key ever painted, regardless of part, sorted by "
                        + "(part, zoomPPT, tileX, tileY)")
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

    func testInvalidationOnAnEmptyCacheBumpsNothing() throws {
        var cache = TileCache(capacity: 32)
        XCTAssertEqual(cache.invalidate(rectsTwips: [], part: 0), [])
        let rect = try XCTUnwrap(TileMath.tileBoundsTwips(tileX: 0, tileY: 0, zoomPPT: 1000))
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
