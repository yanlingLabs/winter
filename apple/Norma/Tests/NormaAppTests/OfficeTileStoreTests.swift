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

    func testDefaultCapacityIsSixtyFour() {
        let store = OfficeTileStore()
        for i in 0..<64 { store.ingest(docId: "d1", key: key(i, 0), generation: 0, pixels: pixels(0)) }
        XCTAssertEqual(store.cachedCountForTesting, 64)
        store.ingest(docId: "d1", key: key(64, 0), generation: 0, pixels: pixels(0))
        XCTAssertEqual(store.cachedCountForTesting, 64, "the 65th paint evicts, never grows past capacity")
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

    func testInvalidateEvictsTheMatchingEntriesAndLeavesOthersAlone() {
        let store = OfficeTileStore()
        store.ingest(docId: "d1", key: key(0, 0), generation: 0, pixels: pixels(1))
        store.ingest(docId: "d1", key: key(1, 0), generation: 0, pixels: pixels(2))
        store.invalidate(docId: "d1", keys: [key(0, 0)])
        XCTAssertNil(store.tile(docId: "d1", key: key(0, 0)))
        XCTAssertNotNil(store.tile(docId: "d1", key: key(1, 0)))
    }

    func testInvalidateOfAnUnknownKeyIsAHarmlessNoOp() {
        let store = OfficeTileStore()
        store.invalidate(docId: "d1", keys: [key(9, 9)])
        XCTAssertEqual(store.cachedCountForTesting, 0)
    }

    /// office-plumbing Task 8 (F5): the bug the store's own header now documents at length. Before
    /// this fix, `invalidate` only touched `entries` — a key that was IN FLIGHT (requested, nothing
    /// cached yet) survived an invalidation untouched, so `keysNeedingRequest` kept believing an ask
    /// for it was still outstanding forever, and the eventual (stale, pre-invalidation) reply would
    /// be the last word on it.
    func testInvalidateOfAnInFlightKeyWithNoCachedEntryClearsItsInFlightMarker() {
        let store = OfficeTileStore()
        store.markRequested(docId: "d1", keys: [key(0, 0)])
        XCTAssertEqual(store.keysNeedingRequest(docId: "d1", candidates: [key(0, 0)]), [],
                       "sanity: freshly marked, so not yet askable again")

        store.invalidate(docId: "d1", keys: [key(0, 0)])

        XCTAssertEqual(store.keysNeedingRequest(docId: "d1", candidates: [key(0, 0)]), [key(0, 0)],
                       "an invalidated key must become askable again, not stay in flight forever")
        XCTAssertEqual(store.inFlightCountForTesting, 0)
    }

    /// The disclosed residual the store's header names: the STALE reply itself, already in flight
    /// before the invalidation, can still land and still paint — ONE frame, immediately correctable
    /// (the previous test proves a fresh ask follows). This test pins that the store does not go
    /// further than that — it does not (today) refuse the late arrival outright, which would require
    /// the per-key ledger the header explains was deliberately not built yet.
    func testALateArrivalForAnInvalidatedKeyIsStillAcceptedThisIsTheDisclosedResidual() {
        let store = OfficeTileStore()
        store.markRequested(docId: "d1", keys: [key(0, 0)])
        store.invalidate(docId: "d1", keys: [key(0, 0)])

        let accepted = store.ingest(docId: "d1", key: key(0, 0), generation: 0, pixels: pixels(9))

        XCTAssertTrue(accepted, "the disclosed residual: a reply already in flight when the "
                      + "invalidation fired still lands — see OfficeTileStore's own header")
        XCTAssertNotNil(store.tile(docId: "d1", key: key(0, 0)))
        // T8 fix-round review I1: the DEFAULT ordering (late reply lands before any viewport pass
        // re-requests the key — see the header's corrected claim) leaves the key excluded here, not
        // askable — the stale frame the assertions above just proved landed is not "superseded by the
        // next pass," it PERSISTS on a static viewport. This is the documented reality, not a gap.
        XCTAssertEqual(store.keysNeedingRequest(docId: "d1", candidates: [key(0, 0)]), [],
                       "the late-cached reply now reads as fresh, not stale — nothing re-asks for it")
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
