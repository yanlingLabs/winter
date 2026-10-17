import XCTest
@testable import Winter

/// The Winter island's queue: replace, hover-defer, click-swap, self-compact into the strip's count and the list (no
/// badge: nothing else is drawn for a compacted card, and nothing brings one back on top but a new arrival's turn).
final class IslandQueueTests: XCTestCase {
    func testANewCardReplacesTheCurrentOneWhichCompacts() {
        var q = IslandQueue()
        q.arrive("a", selfCompacts: true, now: 0)
        XCTAssertEqual(q.current?.id, "a")
        q.arrive("b", selfCompacts: true, now: 1)
        XCTAssertEqual(q.current?.id, "b")
        XCTAssertNil(q.waiting)
        XCTAssertEqual(q.compacted.map(\.id), ["a"])
    }

    func testWhileTheCurrentCardIsHoveredTheNewcomerWaitsBelow() {
        var q = IslandQueue()
        q.arrive("a", selfCompacts: true, now: 0)
        q.hoverCurrent(true, now: 1)
        q.arrive("b", selfCompacts: true, now: 2)
        XCTAssertEqual(q.current?.id, "a", "the hovered card is not replaced")
        XCTAssertEqual(q.waiting?.id, "b")
        // A third while still hovered: the newest waits, the one it displaced compacts.
        q.arrive("c", selfCompacts: true, now: 3)
        XCTAssertEqual(q.waiting?.id, "c")
        XCTAssertEqual(q.compacted.map(\.id), ["b"])
    }

    func testTheWaitingCardExpandsWhenTheCurrentOneClears() {
        var q = IslandQueue()
        q.arrive("a", selfCompacts: true, now: 0)
        q.hoverCurrent(true, now: 0)
        q.arrive("b", selfCompacts: true, now: 1)
        q.resolve("a", now: 2)
        XCTAssertEqual(q.current?.id, "b")
        XCTAssertNil(q.waiting)
        XCTAssertEqual(q.current?.compactAt, 2 + IslandQueue.selfCompactAfter, "a fresh clock for the promoted card")
    }

    func testClickingTheWaitingPillTucksTheCurrentOneAway() {
        var q = IslandQueue()
        q.arrive("a", selfCompacts: true, now: 0)
        q.hoverCurrent(true, now: 0)
        q.arrive("b", selfCompacts: true, now: 1)
        q.clickWaiting(now: 2)
        XCTAssertEqual(q.current?.id, "b")
        XCTAssertNil(q.waiting)
        XCTAssertEqual(q.compacted.map(\.id), ["a"])
        XCTAssertFalse(q.currentHovered)
    }

    func testAnUnhoveredCardSelfCompactsAfterItsTimeAndTheWaitingOneExpands() {
        var q = IslandQueue()
        q.arrive("a", selfCompacts: true, now: 0)
        XCTAssertEqual(q.nextDeadline, IslandQueue.selfCompactAfter)
        q.tick(now: IslandQueue.selfCompactAfter - 0.1)
        XCTAssertEqual(q.current?.id, "a")
        q.tick(now: IslandQueue.selfCompactAfter)
        XCTAssertNil(q.current)
        XCTAssertEqual(q.compacted.map(\.id), ["a"], "into the strip's count (and, being pending, the Needs-you list)")
        XCTAssertNil(q.nextDeadline, "nothing due: no wake-up")
    }

    func testAHoveredCardDoesNotSelfCompactAndGetsAGraceWhenThePointerLeaves() {
        var q = IslandQueue()
        q.arrive("a", selfCompacts: true, now: 0)
        q.hoverCurrent(true, now: 1)
        XCTAssertNil(q.nextDeadline)
        q.tick(now: 100)
        XCTAssertEqual(q.current?.id, "a")
        q.hoverCurrent(false, now: 100)
        XCTAssertEqual(q.nextDeadline, 100 + IslandQueue.hoverLeaveGrace)
        q.tick(now: 100 + IslandQueue.hoverLeaveGrace)
        XCTAssertNil(q.current)
        XCTAssertEqual(q.compacted.count, 1)
    }

    func testCompactedCardsStayCompactedWithNothingOnTopAndNoWakeUp() {
        var q = IslandQueue()
        for (i, id) in ["a", "b", "c"].enumerated() { q.arrive(id, selfCompacts: true, now: Double(i)) }
        q.tick(now: 100)
        XCTAssertEqual(q.compacted.map(\.id), ["a", "b", "c"])
        XCTAssertNil(q.current, "nothing expanded: only the strip's count (and Needs you) says they wait")
        XCTAssertNil(q.waiting)
        XCTAssertNil(q.nextDeadline, "nothing due while only compacted cards are held: an idle island runs no timer")
        q.tick(now: 10_000)
        XCTAssertEqual(q.compacted.map(\.id), ["a", "b", "c"], "the clock never brings one back")
        // A new card is born on top as usual; the compacted ones stay where they are.
        q.arrive("d", selfCompacts: true, now: 10_001)
        XCTAssertEqual(q.current?.id, "d")
        XCTAssertEqual(q.compacted.map(\.id), ["a", "b", "c"])
    }

    func testCardsStayUntilAnsweredAnywhere() {
        var q = IslandQueue()
        q.arrive("a", selfCompacts: true, now: 0)
        q.arrive("b", selfCompacts: true, now: 1)
        q.tick(now: 100)
        XCTAssertEqual(Set(q.compacted.map(\.id)), ["a", "b"])
        q.resolve("a", now: 101)
        XCTAssertEqual(q.compacted.map(\.id), ["b"])
        q.resolve("b", now: 102)
        XCTAssertTrue(q.isEmpty)
    }

    func testAViewRequestKeepsItsCountdownAndIsNeverReplaced() {
        var q = IslandQueue()
        q.arrive("view", selfCompacts: false, now: 0)
        XCTAssertNil(q.nextDeadline, "no self-compaction: its own deadline is the answer")
        q.arrive("approval", selfCompacts: true, now: 1)
        XCTAssertEqual(q.current?.id, "view")
        XCTAssertEqual(q.waiting?.id, "approval")
        q.tick(now: 1000)
        XCTAssertEqual(q.current?.id, "view")
        // A view request arriving over an unhovered approval replaces it (always on top).
        var r = IslandQueue()
        r.arrive("approval", selfCompacts: true, now: 0)
        r.arrive("view", selfCompacts: false, now: 1)
        XCTAssertEqual(r.current?.id, "view")
        XCTAssertEqual(r.compacted.map(\.id), ["approval"])
        // A waiting view request is not displaced by an approval.
        var w = IslandQueue()
        w.arrive("a", selfCompacts: true, now: 0)
        w.hoverCurrent(true, now: 0)
        w.arrive("view", selfCompacts: false, now: 1)
        w.arrive("b", selfCompacts: true, now: 2)
        XCTAssertEqual(w.waiting?.id, "view")
        XCTAssertEqual(w.compacted.map(\.id), ["b"])
    }

    func testACardAlreadyHeldIsLeftWhereItIs() {
        var q = IslandQueue()
        q.arrive("a", selfCompacts: true, now: 0)
        q.arrive("b", selfCompacts: true, now: 1)
        q.arrive("a", selfCompacts: true, now: 2)
        XCTAssertEqual(q.current?.id, "b")
        XCTAssertEqual(q.compacted.map(\.id), ["a"])
        q.addCompacted("b", selfCompacts: true)
        XCTAssertEqual(q.compacted.map(\.id), ["a"], "the current card is not also compacted")
    }

    func testACardBeingTypedIntoIsNeverReplacedNewcomersWaitBelow() {
        var q = IslandQueue()
        q.arrive("a", selfCompacts: true, now: 0)
        q.typingCurrent(true, now: 1)
        q.arrive("b", selfCompacts: true, now: 2)
        XCTAssertEqual(q.current?.id, "a", "no replacement while typing")
        XCTAssertEqual(q.waiting?.id, "b")
        q.arrive("view", selfCompacts: false, now: 3)
        XCTAssertEqual(q.current?.id, "a", "not even by a view request")
        XCTAssertEqual(q.waiting?.id, "view")
    }

    func testACardBeingTypedIntoNeverCompactsEvenAfterThePointerLeaves() {
        var q = IslandQueue()
        q.arrive("a", selfCompacts: true, now: 0)
        q.hoverCurrent(true, now: 1)
        q.typingCurrent(true, now: 2)
        q.hoverCurrent(false, now: 3) // the pointer drifts off while the user types
        XCTAssertNil(q.nextDeadline, "no wake-up while typing")
        q.tick(now: 1_000)
        XCTAssertEqual(q.current?.id, "a")
        XCTAssertTrue(q.compacted.isEmpty)
        // The keyboard given back (Esc): the card compacts only after the grace.
        q.typingCurrent(false, now: 1_000)
        XCTAssertEqual(q.nextDeadline, 1_000 + IslandQueue.hoverLeaveGrace)
        q.tick(now: 1_000 + IslandQueue.hoverLeaveGrace)
        XCTAssertNil(q.current)
    }

    func testAnsweringTheTypedCardReleasesTheHoldForTheNextOne() {
        var q = IslandQueue()
        q.arrive("a", selfCompacts: true, now: 0)
        q.typingCurrent(true, now: 0)
        q.arrive("b", selfCompacts: true, now: 1)
        q.resolve("a", now: 2)
        XCTAssertEqual(q.current?.id, "b")
        XCTAssertFalse(q.currentTyping)
        XCTAssertEqual(q.nextDeadline, 2 + IslandQueue.selfCompactAfter)
    }
}
