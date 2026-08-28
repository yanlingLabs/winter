import Combine
import XCTest
@testable import Norma

/// office-plumbing Task 6 — `OfficeTileStore`: the app-side pixel pool. Mirrors `TileCacheTests`'
/// own shape (LRU, generation bookkeeping) wherever the two caches agree, and adds what is NEW here:
/// the `(docId, TileKey)` composite key, the in-flight ledger `keysNeedingRequest` filters against,
/// and the coalesced `tilesArrived` signal — none of which the helper-side `TileCache` has, because
/// none of them are that cache's problem (see `OfficeTileStore`'s own header for why).
@MainActor
final class OfficeTileStoreTests: XCTestCase {
    private var cancellables: Set<AnyCancellable> = []

    override func tearDown() {
        cancellables.removeAll()
        super.tearDown()
    }

    private func key(_ x: Int, _ y: Int, part: Int = 0, zoomPPT: Int = 1000) -> TileKey {
        TileKey(part: part, zoomPPT: zoomPPT, tileX: x, tileY: y)
    }
    private func pixels(_ tag: UInt8) -> Data { Data(repeating: tag, count: 16) }

    private func waitUntil(timeout: TimeInterval = 2, _ condition: () -> Bool) async -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition() {
            if Date() >= deadline { return false }
            try? await Task.sleep(nanoseconds: 5_000_000)
        }
        return true
    }

    // MARK: - Basic ingest/lookup

    func testFirstIngestOfANeverSeenKeyIsAccepted() {
        let store = OfficeTileStore()
        XCTAssertTrue(store.ingest(docId: "d1", key: key(0, 0), generation: 0, pixels: pixels(1)))
        XCTAssertEqual(store.tile(docId: "d1", key: key(0, 0))?.pixels, pixels(1))
        XCTAssertEqual(store.tile(docId: "d1", key: key(0, 0))?.generation, 0)
    }

    func testLookupMissForAnUnpaintedKey() {
        let store = OfficeTileStore()
        XCTAssertNil(store.tile(docId: "d1", key: key(9, 9)))
    }

    /// The composite key: the SAME `TileKey` under two different docIds is two independent entries —
    /// the whole reason this store is keyed by `(docId, TileKey)` and not `TileKey` alone (unlike the
    /// helper's per-document `TileCache`; see this type's own header).
    func testTheSameTileKeyUnderTwoDocIdsAreIndependentEntries() {
        let store = OfficeTileStore()
        store.ingest(docId: "docA", key: key(0, 0), generation: 0, pixels: pixels(1))
        store.ingest(docId: "docB", key: key(0, 0), generation: 0, pixels: pixels(2))
        XCTAssertEqual(store.tile(docId: "docA", key: key(0, 0))?.pixels, pixels(1))
        XCTAssertEqual(store.tile(docId: "docB", key: key(0, 0))?.pixels, pixels(2))
    }

    // MARK: - Generation-aware ingest

    /// A strictly-lower generation than what is already cached is a stale/out-of-order arrival —
    /// discarded, never regressing what is on screen. The single ordered wire connection should
    /// never actually produce this (see the type's own header); guarded anyway, for free.
    func testAStaleLowerGenerationIsRejectedAndDoesNotOverwrite() {
        let store = OfficeTileStore()
        store.ingest(docId: "d1", key: key(0, 0), generation: 5, pixels: pixels(9))
        let accepted = store.ingest(docId: "d1", key: key(0, 0), generation: 3, pixels: pixels(1))
        XCTAssertFalse(accepted)
        XCTAssertEqual(store.tile(docId: "d1", key: key(0, 0))?.pixels, pixels(9), "the newer paint survives")
        XCTAssertEqual(store.tile(docId: "d1", key: key(0, 0))?.generation, 5)
    }

    func testAnEqualOrHigherGenerationIsAcceptedAndOverwrites() {
        let store = OfficeTileStore()
        store.ingest(docId: "d1", key: key(0, 0), generation: 5, pixels: pixels(1))
        XCTAssertTrue(store.ingest(docId: "d1", key: key(0, 0), generation: 5, pixels: pixels(2)),
                     "an equal generation still overwrites — the freshest bytes for that generation win")
        XCTAssertEqual(store.tile(docId: "d1", key: key(0, 0))?.pixels, pixels(2))
        XCTAssertTrue(store.ingest(docId: "d1", key: key(0, 0), generation: 6, pixels: pixels(3)))
        XCTAssertEqual(store.tile(docId: "d1", key: key(0, 0))?.pixels, pixels(3))
    }

    // MARK: - LRU eviction (mirrors `TileCacheTests`' own required proof)

    func testLeastRecentlyUsedEntryIsEvictedWhenCapacityExceeded() {
        let store = OfficeTileStore(capacity: 2)
        store.ingest(docId: "d1", key: key(0, 0), generation: 0, pixels: pixels(1))
        store.ingest(docId: "d1", key: key(1, 0), generation: 0, pixels: pixels(2))
        XCTAssertEqual(store.cachedCountForTesting, 2)
        store.ingest(docId: "d1", key: key(2, 0), generation: 0, pixels: pixels(3)) // evicts (0,0)
        XCTAssertEqual(store.cachedCountForTesting, 2)
        XCTAssertNil(store.tile(docId: "d1", key: key(0, 0)))
        XCTAssertNotNil(store.tile(docId: "d1", key: key(1, 0)))
        XCTAssertNotNil(store.tile(docId: "d1", key: key(2, 0)))
    }

    func testLookupHitCountsAsUseAndProtectsFromEviction() {
        let store = OfficeTileStore(capacity: 2)
        store.ingest(docId: "d1", key: key(0, 0), generation: 0, pixels: pixels(1))
        store.ingest(docId: "d1", key: key(1, 0), generation: 0, pixels: pixels(2))
        _ = store.tile(docId: "d1", key: key(0, 0)) // touch (0,0) -> MRU
        store.ingest(docId: "d1", key: key(2, 0), generation: 0, pixels: pixels(3)) // evicts (1,0)
        XCTAssertNotNil(store.tile(docId: "d1", key: key(0, 0)), "touched entry survives")
        XCTAssertNil(store.tile(docId: "d1", key: key(1, 0)), "untouched entry is evicted")
    }

    /// office live-gate fix #3: the default capacity moved from a bare 64 to `residencyCapTiles +
    /// 32` headroom (see that constant's own doc) — this test still pins the DEFAULT's own eviction
    /// boundary, just against the new number, read from the constant rather than hardcoded a second
    /// time so it cannot silently drift from production again.
    func testDefaultCapacityMatchesResidencyCapPlusHeadroom() {
        let store = OfficeTileStore()
        let capacity = OfficeTileStore.defaultCapacity
        XCTAssertEqual(capacity, OfficeTileStore.residencyCapTiles + 32, "sanity: the constant's own documented relationship")
        for i in 0..<capacity { store.ingest(docId: "d1", key: key(i, 0), generation: 0, pixels: pixels(0)) }
        XCTAssertEqual(store.cachedCountForTesting, capacity)
        store.ingest(docId: "d1", key: key(capacity, 0), generation: 0, pixels: pixels(0))
        XCTAssertEqual(store.cachedCountForTesting, capacity, "one past capacity evicts, never grows past it")
    }

    func testCapacityIsClampedToAtLeastOne() {
        let store = OfficeTileStore(capacity: 0)
        store.ingest(docId: "d1", key: key(0, 0), generation: 0, pixels: pixels(1))
        XCTAssertEqual(store.cachedCountForTesting, 1)
    }

    // MARK: - The request-filtering door (obligation 3)

    func testKeysNeedingRequestExcludesAlreadyCachedKeys() {
        let store = OfficeTileStore()
        store.ingest(docId: "d1", key: key(0, 0), generation: 0, pixels: pixels(1))
        let needed = store.keysNeedingRequest(docId: "d1", candidates: [key(0, 0), key(1, 0)])
        XCTAssertEqual(needed, [key(1, 0)])
    }

    func testKeysNeedingRequestExcludesAlreadyInFlightKeys() {
        let store = OfficeTileStore()
        store.markRequested(docId: "d1", keys: [key(0, 0)])
        let needed = store.keysNeedingRequest(docId: "d1", candidates: [key(0, 0), key(1, 0)])
        XCTAssertEqual(needed, [key(1, 0)])
    }

    /// The SAME `TileKey` under a DIFFERENT docId is a different key entirely — an in-flight request
    /// for docA's (0,0) must not suppress a fresh request for docB's (0,0).
    func testInFlightTrackingIsScopedPerDocId() {
        let store = OfficeTileStore()
        store.markRequested(docId: "docA", keys: [key(0, 0)])
        let needed = store.keysNeedingRequest(docId: "docB", candidates: [key(0, 0)])
        XCTAssertEqual(needed, [key(0, 0)], "docB's identical-looking key is unrelated to docA's in-flight one")
    }

    func testIngestClearsTheKeysInFlightMarker() {
        let store = OfficeTileStore()
        store.markRequested(docId: "d1", keys: [key(0, 0)])
        XCTAssertEqual(store.inFlightCountForTesting, 1)
        store.ingest(docId: "d1", key: key(0, 0), generation: 0, pixels: pixels(1))
        XCTAssertEqual(store.inFlightCountForTesting, 0)
        XCTAssertEqual(store.keysNeedingRequest(docId: "d1", candidates: [key(0, 0)]), [],
                       "now cached — no longer worth requesting either")
    }

    func testMarkFailedClearsTheKeysInFlightMarkerWithoutCachingAnything() {
        let store = OfficeTileStore()
        store.markRequested(docId: "d1", keys: [key(0, 0)])
        store.markFailed(docId: "d1", key: key(0, 0))
        XCTAssertEqual(store.inFlightCountForTesting, 0)
        XCTAssertNil(store.tile(docId: "d1", key: key(0, 0)))
        XCTAssertEqual(store.keysNeedingRequest(docId: "d1", candidates: [key(0, 0)]), [key(0, 0)],
                       "a failed key is fair game to request again — refuse-never-ignore, not permanently poisoned")
    }

    // MARK: - Invalidation

    /// **office-responsive Job 2 — this test used to assert the DEFECT.** It was
    /// `testInvalidateEvictsTheMatchingEntriesAndLeavesOthersAlone` and its first assertion was
    /// `XCTAssertNil(store.tile(docId: "d1", key: key(0, 0)))` — the eviction that made every
    /// keystroke blank half the visible canvas. Inverted deliberately: the pixels must SURVIVE an
    /// invalidation, flagged as owing a repaint.
    func testInvalidateKeepsTheMatchingEntriesPixelsAndOnlyFlagsThemAsOwingAPaint() {
        let store = OfficeTileStore()
        store.ingest(docId: "d1", key: key(0, 0), generation: 0, pixels: pixels(1))
        store.ingest(docId: "d1", key: key(1, 0), generation: 0, pixels: pixels(2))

        store.invalidate(docId: "d1", keys: [key(0, 0)])

        XCTAssertEqual(store.tile(docId: "d1", key: key(0, 0))?.pixels, pixels(1),
                       "the last good frame must stay on screen — evicting it here IS the "
                        + "per-keystroke blank the user reported")
        XCTAssertTrue(store.needsFreshPaint(docId: "d1", key: key(0, 0)),
                      "…but it must still be known to owe a repaint, or nothing ever asks for one "
                       + "and the stale frame becomes permanent")
        // Control: an untouched key is neither disturbed nor spuriously marked.
        XCTAssertEqual(store.tile(docId: "d1", key: key(1, 0))?.pixels, pixels(2))
        XCTAssertFalse(store.needsFreshPaint(docId: "d1", key: key(1, 0)),
                       "control: invalidating one key must not make an unrelated one ask for a paint")
    }

    /// The other half of the contract: a key that owes a paint is asked for exactly like a key that
    /// has none. Without this, `keysNeedingRequest` would see a cached entry, exclude it, and the
    /// stale pixels would sit there forever with nothing scheduled to correct them.
    func testAStaleEntryIsRequestedAgainExactlyLikeAMissingOne() {
        let store = OfficeTileStore()
        store.ingest(docId: "d1", key: key(0, 0), generation: 0, pixels: pixels(1))
        XCTAssertEqual(store.keysNeedingRequest(docId: "d1", candidates: [key(0, 0)]), [],
                       "setup: a fresh cached key is not worth asking for")

        store.invalidate(docId: "d1", keys: [key(0, 0)])

        XCTAssertEqual(store.keysNeedingRequest(docId: "d1", candidates: [key(0, 0)]), [key(0, 0)])
    }

    /// The replacement lands: pixels swapped, flag cleared, nothing left owing.
    func testAFreshArrivalReplacesStalePixelsAndClearsTheFlag() {
        let store = OfficeTileStore()
        store.ingest(docId: "d1", key: key(0, 0), generation: 0, pixels: pixels(1))
        store.invalidate(docId: "d1", keys: [key(0, 0)])
        store.markRequested(docId: "d1", keys: [key(0, 0)])

        // The helper bumps the generation on every invalidation (`TileCache.invalidate`), so the
        // replacement always arrives with a strictly greater one.
        XCTAssertTrue(store.ingest(docId: "d1", key: key(0, 0), generation: 1, pixels: pixels(7)))

        XCTAssertEqual(store.tile(docId: "d1", key: key(0, 0))?.pixels, pixels(7))
        XCTAssertFalse(store.needsFreshPaint(docId: "d1", key: key(0, 0)))
        XCTAssertEqual(store.keysNeedingRequest(docId: "d1", candidates: [key(0, 0)]), [])
    }

    /// **The staleness BOUND.** A refresh that resolves as a failure must not leave known-stale
    /// pixels on screen indefinitely — that is a silent wrong answer, strictly worse than the blank
    /// this whole change removed, because a blank is obviously nothing while a stale tile looks like
    /// content. It drops to the placeholder instead: exactly the pre-change behaviour, for exactly
    /// the case where there is nothing better to show.
    func testAFailedRefreshOfAStaleTileDropsItRatherThanLeavingALieOnScreen() {
        let store = OfficeTileStore()
        store.ingest(docId: "d1", key: key(0, 0), generation: 0, pixels: pixels(1))
        store.invalidate(docId: "d1", keys: [key(0, 0)])
        store.markRequested(docId: "d1", keys: [key(0, 0)])
        XCTAssertNotNil(store.tile(docId: "d1", key: key(0, 0)), "setup: the stale pixels are on screen")

        store.markFailed(docId: "d1", key: key(0, 0))

        XCTAssertNil(store.tile(docId: "d1", key: key(0, 0)),
                     "a refresh that will never arrive must not leave stale pixels claiming to be "
                      + "the document")
        XCTAssertEqual(store.lruOrderForTesting.filter { $0.tileKey == key(0, 0) }.count, 0,
                       "and the LRU record goes with it, or the pool leaks a slot per failure")
    }

    /// **The other half of the bound: a refresh that keeps failing retries EXACTLY ONCE, then goes
    /// quiet.** Dropping a stale entry also signals `tilesArrived`, which is what makes the canvas
    /// re-ask — so without a terminating condition this would be ask → fail → signal → ask → fail →
    /// forever, the precise request storm the pre-existing `markFailed` storm guard exists to
    /// prevent. It terminates by construction: the first failure removes the entry, so the SECOND
    /// failure finds nothing stale, consumes no marker, and signals nothing. A negative proof — a
    /// bounded wait for silence, not a wait for an event.
    func testARepeatedlyFailingRefreshOfAStaleTileRetriesOnceAndThenGoesQuiet() async {
        let store = OfficeTileStore()
        store.ingest(docId: "d1", key: key(0, 0), generation: 0, pixels: pixels(1))
        store.invalidate(docId: "d1", keys: [key(0, 0)])
        store.markRequested(docId: "d1", keys: [key(0, 0)])
        store.markFailed(docId: "d1", key: key(0, 0)) // first failure: drops the stale entry, signals

        // **Let the FIRST failure's signal actually land before subscribing.** `scheduleFlush` hops
        // through `DispatchQueue.main.async`, so without this the pending flush from the line above
        // arrives after the sink is attached and the negative assertion below fails on the RIGHT
        // signal — which is exactly how this test failed on its first real run. The subject of this
        // test is the SECOND failure, so the first one's signal has to be out of the way first.
        try? await Task.sleep(nanoseconds: 30_000_000)

        var received: [(docId: String, keys: Set<TileKey>)] = []
        store.tilesArrived.sink { received.append($0) }.store(in: &cancellables)

        // The re-ask the signal above provokes, and its own failure.
        store.markRequested(docId: "d1", keys: [key(0, 0)])
        store.markFailed(docId: "d1", key: key(0, 0))

        try? await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertTrue(received.isEmpty,
                      "the second failure must not signal again — nothing stale is left to protect, "
                       + "and signaling would build an unbounded ask/fail loop")
        XCTAssertEqual(store.keysNeedingRequest(docId: "d1", candidates: [key(0, 0)]), [key(0, 0)],
                       "the key stays askable by anything that comes along on its own terms (a "
                        + "scroll, a zoom) — it is simply no longer chasing itself")
    }

    /// **Control for the bound**: an ordinary failure on a tile that is NOT stale (a bad key, a
    /// transient LOK error — nothing to do with an invalidation) must leave the good pixels exactly
    /// where they are. Without this arm, the test above would pass on a `markFailed` that simply
    /// dropped everything it touched.
    func testAFailedRequestForATileThatIsNotStaleLeavesItsPixelsAlone() {
        let store = OfficeTileStore()
        store.ingest(docId: "d1", key: key(0, 0), generation: 0, pixels: pixels(1))
        store.markRequested(docId: "d1", keys: [key(0, 0)])

        store.markFailed(docId: "d1", key: key(0, 0))

        XCTAssertEqual(store.tile(docId: "d1", key: key(0, 0))?.pixels, pixels(1))
        XCTAssertFalse(store.needsFreshPaint(docId: "d1", key: key(0, 0)))
    }

    /// **The document-identity guarantee, pinned rather than argued.** Staleness must never survive
    /// a change of what the document IS — a reload mints a fresh docId and `evictAll`s the old one
    /// synchronously before the reopen starts, so a stale tile can never be shown against a
    /// document it did not come from. `evictAll`/`evictEverything` therefore stay HARD evictions;
    /// only `invalidate` became a flag.
    func testEvictAllStillHardEvictsSoStalenessCannotOutliveADocumentIdentityChange() {
        let store = OfficeTileStore()
        store.ingest(docId: "d1", key: key(0, 0), generation: 0, pixels: pixels(1))
        store.invalidate(docId: "d1", keys: [key(0, 0)])
        XCTAssertNotNil(store.tile(docId: "d1", key: key(0, 0)), "setup: stale pixels are being held")

        store.evictAll(docId: "d1")

        XCTAssertNil(store.tile(docId: "d1", key: key(0, 0)),
                     "a reload/close must drop the pixels outright — holding a stale tile across a "
                      + "document identity change would put another document's content on screen")

        store.ingest(docId: "d2", key: key(0, 0), generation: 0, pixels: pixels(2))
        store.invalidate(docId: "d2", keys: [key(0, 0)])
        store.evictEverything()
        XCTAssertNil(store.tile(docId: "d2", key: key(0, 0)), "same for the helper-died sweep")
    }

    func testInvalidateOfAnUnknownKeyIsAHarmlessNoOp() {
        let store = OfficeTileStore()
        store.invalidate(docId: "d1", keys: [key(9, 9)])
        XCTAssertEqual(store.cachedCountForTesting, 0)
    }

    /// office-plumbing Task 8 (F5) ORIGIN, Office Stage B Task 4 RESOLUTION — the store's own header
    /// has the full account of both. Before T8's fix, `invalidate` left an in-flight key's marker
    /// untouched, wedging it forever. T8's own fix cleared it immediately, which this test used to
    /// pin as "askable again right after `invalidate`" — but that reopened a DIFFERENT hazard (two
    /// ambiguous in-flight replies for one key) that Task 4's `invalidatedWhileInFlight` now closes.
    /// This test pins the CURRENT, two-step contract: blocked immediately after `invalidate` (the
    /// one outstanding reply has not resolved yet), askable again only once it does.
    func testInvalidateOfAnInFlightKeyBlocksReRequestsUntilTheOneOutstandingReplyResolves() {
        let store = OfficeTileStore()
        store.markRequested(docId: "d1", keys: [key(0, 0)])
        XCTAssertEqual(store.keysNeedingRequest(docId: "d1", candidates: [key(0, 0)]), [],
                       "sanity: freshly marked, so not yet askable again")

        store.invalidate(docId: "d1", keys: [key(0, 0)])

        XCTAssertEqual(store.keysNeedingRequest(docId: "d1", candidates: [key(0, 0)]), [],
                       "STILL blocked immediately after invalidate — a second, ambiguous request must "
                       + "not go out before the one already-outstanding reply resolves")
        XCTAssertEqual(store.inFlightCountForTesting, 1, "deliberately NOT cleared yet")
        XCTAssertEqual(store.invalidatedWhileInFlightCountForTesting, 1)

        // The one outstanding reply finally resolves (as a rejection — see the sibling test below
        // for that half of the contract). ONLY NOW does the key become askable again.
        store.ingest(docId: "d1", key: key(0, 0), generation: 0, pixels: pixels(9))

        XCTAssertEqual(store.keysNeedingRequest(docId: "d1", candidates: [key(0, 0)]), [key(0, 0)],
                       "the one-shot marker's resolution is what unblocks re-asking, not invalidate itself")
        XCTAssertEqual(store.inFlightCountForTesting, 0)
        XCTAssertEqual(store.invalidatedWhileInFlightCountForTesting, 0, "one-shot: consumed by the resolution")
    }

    /// Office Stage B Task 4 — the residual `testALateArrivalForAnInvalidatedKeyIsStillAcceptedThis
    /// IsTheDisclosedResidual` used to pin (a stale, pre-invalidation reply still landing and still
    /// painting) is now CLOSED: the one-shot `invalidatedWhileInFlight` marker rejects it outright.
    func testALateArrivalForAnInvalidatedKeyIsNowRejectedNotCached() {
        let store = OfficeTileStore()
        store.markRequested(docId: "d1", keys: [key(0, 0)])
        store.invalidate(docId: "d1", keys: [key(0, 0)])

        let accepted = store.ingest(docId: "d1", key: key(0, 0), generation: 0, pixels: pixels(9))

        XCTAssertFalse(accepted, "a reply already in flight when the invalidation fired is now known-stale")
        XCTAssertNil(store.tile(docId: "d1", key: key(0, 0)), "the stale pixels must never be cached")
    }

    /// The other half of "one-shot": the rejection above must not poison the key permanently — a
    /// SECOND, genuinely fresh request-and-reply cycle for the same key (the one the previous test's
    /// sibling proves becomes askable again) is accepted completely normally.
    func testAfterTheOneShotRejectionASubsequentFreshArrivalForTheSameKeyIsAcceptedNormally() {
        let store = OfficeTileStore()
        store.markRequested(docId: "d1", keys: [key(0, 0)])
        store.invalidate(docId: "d1", keys: [key(0, 0)])
        XCTAssertFalse(store.ingest(docId: "d1", key: key(0, 0), generation: 0, pixels: pixels(9)),
                       "setup: the stale reply is rejected, exactly like the sibling test above")

        // A genuinely fresh ask, now that the key reads as askable again.
        store.markRequested(docId: "d1", keys: [key(0, 0)])
        let acceptedSecondTime = store.ingest(docId: "d1", key: key(0, 0), generation: 1, pixels: pixels(42))

        XCTAssertTrue(acceptedSecondTime, "the one-shot marker must not still be poisoning this key")
        XCTAssertEqual(store.tile(docId: "d1", key: key(0, 0))?.pixels, pixels(42))
        XCTAssertEqual(store.invalidatedWhileInFlightCountForTesting, 0)
    }

    /// Office Stage B Task 4 — `markFailed` must consume the one-shot marker exactly like `ingest`'s
    /// rejection path does: a request that resolves via failure (`.tileFailed`) is still A
    /// resolution, and must unblock the key the same way a resolved-but-rejected `.tile` does.
    func testMarkFailedAlsoConsumesTheOneShotMarkerAndUnblocksTheKey() {
        let store = OfficeTileStore()
        store.markRequested(docId: "d1", keys: [key(0, 0)])
        store.invalidate(docId: "d1", keys: [key(0, 0)])
        XCTAssertEqual(store.invalidatedWhileInFlightCountForTesting, 1, "setup")

        store.markFailed(docId: "d1", key: key(0, 0))

        XCTAssertEqual(store.invalidatedWhileInFlightCountForTesting, 0)
        XCTAssertEqual(store.keysNeedingRequest(docId: "d1", candidates: [key(0, 0)]), [key(0, 0)])
    }

    /// Fix round 1, F1 (CRITICAL) — the marker-consumption rejection branch used to clear `inFlight`
    /// (making the key askable again) WITHOUT ever signaling `tilesArrived` — so nothing downstream
    /// (`OfficeTileCanvasView.handleTilesArrived` -> `OfficeRuntime.refetchInvalidatedTiles`) ever
    /// learned the key was worth re-asking for; a static viewport (typing) would show a blank caret
    /// tile forever. This is the live proof at the store's own public surface: the stale-reply
    /// rejection itself is what unblocks AND signals, in the same call, which is the fix.
    func testIngestsMarkerConsumptionRejectionSignalsTilesArrivedSoTheKeyGetsReAsked() async {
        let store = OfficeTileStore()
        store.markRequested(docId: "d1", keys: [key(0, 0)])
        store.invalidate(docId: "d1", keys: [key(0, 0)]) // marks invalidatedWhileInFlight

        var received: [(docId: String, keys: Set<TileKey>)] = []
        store.tilesArrived.sink { received.append($0) }.store(in: &cancellables)

        let accepted = store.ingest(docId: "d1", key: key(0, 0), generation: 0, pixels: pixels(9))
        XCTAssertFalse(accepted, "setup: the stale reply is still rejected exactly as before this fix")

        let settled = await waitUntil { !received.isEmpty }
        XCTAssertTrue(settled, "the rejection itself must signal -- F1 found it silently didn't")
        XCTAssertEqual(received[0].docId, "d1")
        XCTAssertEqual(received[0].keys, [key(0, 0)])
        XCTAssertEqual(store.keysNeedingRequest(docId: "d1", candidates: [key(0, 0)]), [key(0, 0)],
                       "and the key really is askable again by the time the signal fires")
    }

    /// Fix round 1, F1 — `markFailed` must ALSO signal when it consumes a marker (a failed
    /// resolution is still a resolution, treated identically to `ingest`'s rejection branch for
    /// every OTHER purpose here — consuming the marker, clearing `inFlight`).
    func testMarkFailedWithAConsumedMarkerSignalsTilesArrived() async {
        let store = OfficeTileStore()
        store.markRequested(docId: "d1", keys: [key(0, 0)])
        store.invalidate(docId: "d1", keys: [key(0, 0)])

        var received: [(docId: String, keys: Set<TileKey>)] = []
        store.tilesArrived.sink { received.append($0) }.store(in: &cancellables)

        store.markFailed(docId: "d1", key: key(0, 0))

        let settled = await waitUntil { !received.isEmpty }
        XCTAssertTrue(settled)
        XCTAssertEqual(received[0].keys, [key(0, 0)])
    }

    /// Fix round 1, F1 — the storm guard the reviewer explicitly named: an ORDINARY `markFailed`
    /// (no invalidation racing it — a plain bad key, a transient LOK error) must NOT signal.
    /// Signaling unconditionally here would mean every ordinary failure re-triggers a re-ask, which
    /// re-fails, which re-signals, forever, for a key that has nothing to do with an invalidation at
    /// all. A negative proof — a bounded wait for "nothing arrived," not `waitUntil` for something.
    func testMarkFailedWithoutAConsumedMarkerDoesNotSignalTheStormGuard() async {
        let store = OfficeTileStore()
        store.markRequested(docId: "d1", keys: [key(0, 0)]) // no invalidate -- nothing to consume

        var received: [(docId: String, keys: Set<TileKey>)] = []
        store.tilesArrived.sink { received.append($0) }.store(in: &cancellables)

        store.markFailed(docId: "d1", key: key(0, 0))

        try? await Task.sleep(nanoseconds: 50_000_000) // give a wrong signal a generous beat to arrive
        XCTAssertTrue(received.isEmpty, "an ordinary failure with no marker consumed must not signal — "
                      + "the reviewer's own storm-guard requirement")
    }

    /// Office Stage B Task 4 — invalidating a key that was NEVER in flight (nothing outstanding to
    /// distrust) must not mark it at all; this is the ordinary "evict a cached, settled tile" path
    /// every earlier task's own live-invalidation reasoning already assumed.
    func testInvalidatingAKeyThatWasNotInFlightNeverMarksItOneShot() {
        let store = OfficeTileStore()
        store.ingest(docId: "d1", key: key(0, 0), generation: 0, pixels: pixels(1))

        store.invalidate(docId: "d1", keys: [key(0, 0)])

        XCTAssertEqual(store.invalidatedWhileInFlightCountForTesting, 0)
        // office-responsive Job 2 — this assertion used to be `XCTAssertNil(store.tile(...))`
        // ("still evicted"). The pixels are kept now; what this test is actually about is the
        // one-shot set, which is unaffected either way.
        XCTAssertTrue(store.needsFreshPaint(docId: "d1", key: key(0, 0)),
                      "still owes a repaint, unrelated to the one-shot set")
    }

    /// office-plumbing Task 8 (F5, the reload story): the OTHER half of the store header's
    /// correction — a reload never calls `invalidate`, it calls `evictAll` for the OLD docId (a
    /// document close in disguise) and mints a NEW docId for the reopen. A reply that was in flight
    /// for the OLD docId and resolves AFTER `evictAll` ran can still be `ingest`ed — this store keeps
    /// no notion of "which docIds are still open" — but the entry it creates is addressed under a
    /// `Key` nothing downstream ever reads again. This test is the airtight half of that story: it
    /// does NOT hide the phantom entry (asserting it away would be dishonest about what the code
    /// does); it proves the entry is INERT — a completely independent docId's own reads, writes and
    /// `keysNeedingRequest` accounting are untouched by it.
    func testALateArrivalForAClosedDocIdCannotContaminateAFreshDocIdsEntries() {
        let store = OfficeTileStore()
        store.ingest(docId: "old", key: key(0, 0), generation: 0, pixels: pixels(1))
        store.markRequested(docId: "old", keys: [key(1, 0)])

        // The reload: the old docId is closed exactly the way `OfficeRuntime.perform`'s
        // `.reloadDocument` case closes it — `evictAll`, synchronously, before the new open starts.
        store.evictAll(docId: "old")

        // A reply for the OLD docId, already in flight before the close, resolves late.
        let phantomAccepted = store.ingest(docId: "old", key: key(1, 0), generation: 0, pixels: pixels(2))
        XCTAssertTrue(phantomAccepted, "disclosed, not hidden: the store cannot tell a late arrival "
                      + "for a retired docId apart from a legitimate one on its own")

        // The NEW docId a reload's reopen mints is a value nothing before this line ever mentioned —
        // its own entries, in-flight bookkeeping and lookups must behave as if "old" never existed.
        store.ingest(docId: "new", key: key(0, 0), generation: 0, pixels: pixels(3))
        XCTAssertEqual(store.tile(docId: "new", key: key(0, 0))?.pixels, pixels(3))
        XCTAssertEqual(store.keysNeedingRequest(docId: "new", candidates: [key(1, 0)]), [key(1, 0)],
                       "the old docId's in-flight marker for key(1,0) must not leak into a same-keyed "
                       + "request against the unrelated new docId")
        XCTAssertNil(store.tile(docId: "new", key: key(1, 0)), "the phantom lives ONLY under the old, "
                     + "retired docId — never under the new one")
    }

    // MARK: - Hygiene sweeps

    func testEvictAllReleasesOnlyTheNamedDocIdsEntriesAndInFlightMarkers() {
        let store = OfficeTileStore()
        store.ingest(docId: "docA", key: key(0, 0), generation: 0, pixels: pixels(1))
        store.ingest(docId: "docB", key: key(0, 0), generation: 0, pixels: pixels(2))
        store.markRequested(docId: "docA", keys: [key(1, 0)])
        store.markRequested(docId: "docB", keys: [key(1, 0)])

        store.evictAll(docId: "docA")

        XCTAssertNil(store.tile(docId: "docA", key: key(0, 0)))
        XCTAssertNotNil(store.tile(docId: "docB", key: key(0, 0)), "an unrelated doc's cache is untouched")
        XCTAssertEqual(store.keysNeedingRequest(docId: "docA", candidates: [key(1, 0)]), [key(1, 0)],
                       "docA's in-flight marker is gone too — nothing will ever resolve it now")
        XCTAssertEqual(store.keysNeedingRequest(docId: "docB", candidates: [key(1, 0)]), [],
                       "docB's own in-flight marker survives")
    }

    func testEvictEverythingClearsEveryDocId() {
        let store = OfficeTileStore()
        store.ingest(docId: "docA", key: key(0, 0), generation: 0, pixels: pixels(1))
        store.ingest(docId: "docB", key: key(0, 0), generation: 0, pixels: pixels(2))
        store.markRequested(docId: "docA", keys: [key(1, 0)])

        store.evictEverything()

        XCTAssertEqual(store.cachedCountForTesting, 0)
        XCTAssertEqual(store.inFlightCountForTesting, 0)
    }

    // MARK: - Coalesced arrival signal

    /// Two ingests inside the same run-loop turn must coalesce into ONE `tilesArrived` event
    /// carrying both keys — the "drain fast, coalesce redraws" obligation, proven at the signal
    /// itself rather than only at the canvas that will eventually consume it.
    func testMultipleIngestsInOneTurnCoalesceIntoOneArrivalEvent() async {
        let store = OfficeTileStore()
        var received: [(docId: String, keys: Set<TileKey>)] = []
        store.tilesArrived.sink { received.append($0) }.store(in: &cancellables)

        store.ingest(docId: "d1", key: key(0, 0), generation: 0, pixels: pixels(1))
        store.ingest(docId: "d1", key: key(1, 0), generation: 0, pixels: pixels(2))

        let settled = await waitUntil { !received.isEmpty }
        XCTAssertTrue(settled)
        // Give any (incorrect) second flush a beat to arrive before asserting the count.
        try? await Task.sleep(nanoseconds: 20_000_000)
        XCTAssertEqual(received.count, 1, "both ingests in the same turn coalesce into one event")
        XCTAssertEqual(received[0].docId, "d1")
        XCTAssertEqual(received[0].keys, [key(0, 0), key(1, 0)])
    }

    /// Two ingests separated by a real run-loop turn (this test awaits the first flush before the
    /// second ingest) must NOT coalesce — each becomes its own event.
    func testIngestsInSeparateTurnsProduceSeparateArrivalEvents() async {
        let store = OfficeTileStore()
        var received: [(docId: String, keys: Set<TileKey>)] = []
        store.tilesArrived.sink { received.append($0) }.store(in: &cancellables)

        store.ingest(docId: "d1", key: key(0, 0), generation: 0, pixels: pixels(1))
        _ = await waitUntil { received.count == 1 }

        store.ingest(docId: "d1", key: key(1, 0), generation: 0, pixels: pixels(2))
        _ = await waitUntil { received.count == 2 }

        XCTAssertEqual(received.count, 2)
        XCTAssertEqual(received[0].keys, [key(0, 0)])
        XCTAssertEqual(received[1].keys, [key(1, 0)])
    }

    /// Arrivals for two different docIds in the same turn coalesce independently — one event per
    /// docId, never merged across documents.
    func testArrivalsForTwoDocIdsInOneTurnProduceTwoEventsScopedByDocId() async {
        let store = OfficeTileStore()
        var received: [(docId: String, keys: Set<TileKey>)] = []
        store.tilesArrived.sink { received.append($0) }.store(in: &cancellables)

        store.ingest(docId: "docA", key: key(0, 0), generation: 0, pixels: pixels(1))
        store.ingest(docId: "docB", key: key(0, 0), generation: 0, pixels: pixels(2))

        let settled = await waitUntil { received.count >= 2 }
        XCTAssertTrue(settled)
        XCTAssertEqual(Set(received.map(\.docId)), ["docA", "docB"])
    }

    /// Invalidation fires the same coalesced signal — a canvas subscribed once gets both kinds of
    /// change (arrival, invalidation) through the one publisher.
    func testInvalidateAlsoFiresTheCoalescedArrivalSignal() async {
        let store = OfficeTileStore()
        store.ingest(docId: "d1", key: key(0, 0), generation: 0, pixels: pixels(1))
        var received: [(docId: String, keys: Set<TileKey>)] = []
        store.tilesArrived.sink { received.append($0) }.store(in: &cancellables)

        store.invalidate(docId: "d1", keys: [key(0, 0)])

        let settled = await waitUntil { !received.isEmpty }
        XCTAssertTrue(settled)
        XCTAssertEqual(received[0].keys, [key(0, 0)])
    }
}
