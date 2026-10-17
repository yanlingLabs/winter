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
        q.addCompacted("b", selfCompacts: true, now: 3)
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

    // MARK: View requests are never compacted (their default-allow runs whether drawn or not)

    /// (A) A view request counts down on top, an approval waits below, the user clicks the waiting pill: the view
    /// request swaps into the waiting slot — still drawn — and expands again when the approval clears.
    func testClickingTheWaitingPillUnderAViewRequestSwapsItNeverCompactsIt() {
        var q = IslandQueue()
        q.arrive("view", selfCompacts: false, now: 0)
        q.arrive("approval", selfCompacts: true, now: 1)
        XCTAssertEqual(q.waiting?.id, "approval")
        q.clickWaiting(now: 2)
        XCTAssertEqual(q.current?.id, "approval")
        XCTAssertEqual(q.waiting?.id, "view", "still on screen, under the approval")
        XCTAssertTrue(q.compacted.isEmpty)
        // The approval self-compacts: the view request is back on top.
        q.tick(now: 2 + IslandQueue.selfCompactAfter)
        XCTAssertEqual(q.current?.id, "view")
        XCTAssertEqual(q.compacted.map(\.id), ["approval"])
        // Clicking twice swaps back and forth, never losing either.
        var r = IslandQueue()
        r.arrive("view", selfCompacts: false, now: 0)
        r.arrive("approval", selfCompacts: true, now: 1)
        r.clickWaiting(now: 2)
        r.clickWaiting(now: 3)
        XCTAssertEqual(r.current?.id, "view")
        XCTAssertEqual(r.compacted.map(\.id), ["approval"], "the approval tucked away; the view request never")
    }

    /// (B) A view request waits below and a second one arrives: the older keeps the waiting slot, the newer waits its
    /// turn in line (oldest first) — neither is compacted; each comes up as the one before it is answered.
    func testASecondViewRequestWaitsItsTurnInsteadOfDisplacingTheFirst() {
        var q = IslandQueue()
        q.arrive("a", selfCompacts: true, now: 0)
        q.hoverCurrent(true, now: 0)
        q.arrive("view1", selfCompacts: false, now: 1)
        q.arrive("view2", selfCompacts: false, now: 2)
        XCTAssertEqual(q.waiting?.id, "view1", "the older keeps the waiting slot")
        XCTAssertEqual(q.viewQueue.map(\.id), ["view2"])
        XCTAssertTrue(q.compacted.isEmpty)
        XCTAssertEqual(q.ids, ["a", "view1", "view2"])
        q.resolve("a", now: 3)
        XCTAssertEqual(q.current?.id, "view1")
        XCTAssertEqual(q.waiting?.id, "view2", "the next in line takes the waiting slot")
        q.resolve("view1", now: 4)
        XCTAssertEqual(q.current?.id, "view2")
        XCTAssertNil(q.waiting)
        // Two view requests over an unhovered approval: oldest first on top.
        var r = IslandQueue()
        r.arrive("a", selfCompacts: true, now: 0)
        r.hoverCurrent(true, now: 0)
        r.arrive("view1", selfCompacts: false, now: 1)
        r.hoverCurrent(false, now: 2)
        r.arrive("view2", selfCompacts: false, now: 3)
        XCTAssertEqual(r.current?.id, "view1")
        XCTAssertEqual(r.waiting?.id, "view2")
        XCTAssertEqual(r.compacted.map(\.id), ["a"])
        // A view request answered while it waits: the next in line moves up.
        var w = IslandQueue()
        w.arrive("view0", selfCompacts: false, now: 0)
        w.arrive("view1", selfCompacts: false, now: 1)
        w.arrive("view2", selfCompacts: false, now: 2)
        w.resolve("view1", now: 3)
        XCTAssertEqual(w.waiting?.id, "view2")
        XCTAssertTrue(w.viewQueue.isEmpty)
    }

    /// Whatever happens — arrivals, hovers, typing, clicks on the waiting pill, the clock, answers, a return after being
    /// hidden — a view request is never in the compacted set, and every one held is drawn or in line.
    func testAViewRequestIsNeverInTheCompactedSet() {
        // Seeded: a failure names its seed and replays exactly.
        for seed in UInt64(1)...300 {
            var rng = SeededGenerator(seed: seed)
            var q = IslandQueue()
            var now: TimeInterval = 0
            var next = 0
            var live: [String: Bool] = [:] // id → is a view request
            for _ in 0..<40 {
                now += Double(Int.random(in: 0...4, using: &rng))
                switch Int.random(in: 0..<8, using: &rng) {
                case 0, 1:
                    let view = Bool.random(using: &rng)
                    let id = (view ? "v" : "a") + "\(next)"
                    next += 1
                    live[id] = view
                    q.arrive(id, selfCompacts: !view, now: now)
                case 2: q.hoverCurrent(Bool.random(using: &rng), now: now)
                case 3: q.typingCurrent(Bool.random(using: &rng), now: now)
                case 4: q.clickWaiting(now: now)
                case 5: q.tick(now: now)
                case 6:
                    if let id = live.keys.sorted().randomElement(using: &rng) {
                        q.resolve(id, now: now)
                        live[id] = nil
                    }
                default:
                    let id = "r\(next)"
                    next += 1
                    let view = Bool.random(using: &rng)
                    live[id] = view
                    q.addCompacted(id, selfCompacts: !view, now: now)
                }
                XCTAssertFalse(q.compacted.contains { !$0.selfCompacts }, "seed \(seed): a view request was compacted: \(q)")
                XCTAssertEqual(q.ids, Set(live.keys), "seed \(seed): every pending card is held exactly once")
                let views = Set(live.filter(\.value).keys)
                let drawnOrInLine = Set([q.current?.id, q.waiting?.id].compactMap { $0 }).union(q.viewQueue.map(\.id))
                XCTAssertTrue(views.isSubset(of: drawnOrInLine), "seed \(seed): a view request out of sight: \(q)")
                if q.current == nil { XCTAssertTrue(q.viewQueue.isEmpty && q.waiting == nil, "seed \(seed): nothing on top while some wait: \(q)") }
            }
        }
    }

    /// A new view request queues behind those already in line — never ahead of them into the waiting slot.
    func testANewViewRequestQueuesBehindThoseAlreadyInLine() {
        var q = IslandQueue()
        q.arrive("a", selfCompacts: true, now: 0)
        q.hoverCurrent(true, now: 0)
        q.arrive("view1", selfCompacts: false, now: 1)
        q.arrive("view2", selfCompacts: false, now: 2)
        // The approval goes up and its time passes unhovered: the replace path must not jump view3 ahead of view2.
        q.hoverCurrent(false, now: 3)
        q.arrive("view3", selfCompacts: false, now: 4)
        XCTAssertEqual(q.current?.id, "a")
        XCTAssertEqual(q.waiting?.id, "view1")
        XCTAssertEqual(q.viewQueue.map(\.id), ["view2", "view3"])
        // A click on the waiting pill: view1 expands, the next in line (view2) takes the waiting slot.
        q.clickWaiting(now: 5)
        XCTAssertEqual(q.current?.id, "view1")
        XCTAssertEqual(q.waiting?.id, "view2")
        XCTAssertEqual(q.viewQueue.map(\.id), ["view3"])
        q.arrive("view4", selfCompacts: false, now: 6)
        XCTAssertEqual(q.viewQueue.map(\.id), ["view3", "view4"])
        var order: [String] = []
        while let cur = q.current {
            order.append(cur.id)
            q.resolve(cur.id, now: 7)
        }
        XCTAssertEqual(order, ["view1", "view2", "view3", "view4"], "first come, first shown")
    }
}

/// SplitMix64: a deterministic generator, so a randomised test's failure replays from its seed.
private struct SeededGenerator: RandomNumberGenerator {
    private var state: UInt64
    init(seed: UInt64) { state = seed }
    mutating func next() -> UInt64 {
        state &+= 0x9E37_79B9_7F4A_7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
        z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
        return z ^ (z >> 31)
    }
}
