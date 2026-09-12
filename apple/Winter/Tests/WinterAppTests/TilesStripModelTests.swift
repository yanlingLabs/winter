import XCTest
@testable import Winter

/// Phase 4d-cleanup Task 3 fix 3 — the PURE reconcile-eviction pieces only (per the task brief):
/// `shouldEvictSeedOnly`'s per-tile decision and `isReconcileTick`'s "every ~10th poll" cadence.
/// The actual wiring into `TilesStripModel.poll()` (a real `client.pluginsContrib()` RPC + a
/// 500ms `Task.sleep` loop) is glue, verified by the build + live gate, same posture as this
/// target's other Carbon/RPC-backed models (`ShortcutRegistryTests.swift`'s own doc comment).
final class ShouldEvictSeedOnlyTests: XCTestCase {
    /// Seed-only (never live-tracked) AND absent from a fresh `pluginsContrib()` snapshot — the
    /// plugin that seeded this tile has genuinely disconnected. Evict.
    func testSeedOnlyAndAbsentFromContribIsEvicted() {
        XCTAssertTrue(shouldEvictSeedOnly(id: "p1", liveTracked: [], contribIds: []))
    }

    /// Seed-only but STILL present in a fresh `pluginsContrib()` snapshot — a connected-but-quiet
    /// plugin that just hasn't pushed a live tile this session. Kept.
    func testSeedOnlyButPresentInContribIsKept() {
        XCTAssertFalse(shouldEvictSeedOnly(id: "p1", liveTracked: [], contribIds: ["p1"]))
    }

    /// A live-tracked id is NEVER evicted by this decision, regardless of contrib — `poll()`'s own
    /// live-removal branch already owns that id's lifecycle (a real `tile: nil` push).
    func testLiveTrackedIdIsNeverEvictedRegardlessOfContrib() {
        XCTAssertFalse(shouldEvictSeedOnly(id: "p1", liveTracked: ["p1"], contribIds: []))
        XCTAssertFalse(shouldEvictSeedOnly(id: "p1", liveTracked: ["p1"], contribIds: ["p1"]))
    }

    /// A different id being live-tracked or in contrib doesn't affect this id's own decision.
    func testDecisionIsPerIdNotGlobal() {
        XCTAssertTrue(shouldEvictSeedOnly(id: "p1", liveTracked: ["p2"], contribIds: ["p3"]))
        XCTAssertFalse(shouldEvictSeedOnly(id: "p1", liveTracked: ["p2"], contribIds: ["p1", "p3"]))
    }
}

/// `isReconcileTick(_:every:)` — the every-Nth-tick gate `poll()` uses to run the reconcile pass.
final class IsReconcileTickTests: XCTestCase {
    func testFiresOnTheNthTickAndItsMultiples() {
        XCTAssertTrue(isReconcileTick(10))
        XCTAssertTrue(isReconcileTick(20))
        XCTAssertTrue(isReconcileTick(30))
    }

    func testDoesNotFireOnTicksBetweenMultiplesOfN() {
        for tick in 1...9 {
            XCTAssertFalse(isReconcileTick(tick), "tick \(tick) must not fire")
        }
        for tick in 11...19 {
            XCTAssertFalse(isReconcileTick(tick), "tick \(tick) must not fire")
        }
    }

    /// Tick 0 (never polled yet) must not fire — `poll()` increments its counter before checking,
    /// so this is defensive rather than reachable in practice, but a bare `0 % every == 0` would
    /// otherwise wrongly read as "fires."
    func testTickZeroDoesNotFire() {
        XCTAssertFalse(isReconcileTick(0))
    }

    /// A custom `every` is honored (not hardcoded to 10 internally).
    func testCustomEveryIntervalIsHonored() {
        XCTAssertTrue(isReconcileTick(3, every: 3))
        XCTAssertFalse(isReconcileTick(4, every: 3))
        XCTAssertTrue(isReconcileTick(6, every: 3))
    }
}
