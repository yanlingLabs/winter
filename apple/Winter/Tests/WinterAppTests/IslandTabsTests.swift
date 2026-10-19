import XCTest
@testable import Winter

/// The open island's tabs: the registry, the two-finger swipe between them, the dots.
final class IslandTabsTests: XCTestCase {
    private let tabs = [
        IslandTabRegistry.needsYou,
        IslandTab(id: "sessions", title: "Sessions", symbol: "rectangle.stack"),
        IslandTab(id: "usage", title: "Usage and limits", symbol: "gauge"),
    ]

    func testTheTabsAreNeedsYouFirstThenSessionsShelfUsageDevicesWatchesServers() {
        let state = IslandTabState()
        XCTAssertEqual(state.tabs.map(\.id), ["needs-you", "sessions", "shelf", "usage", "devices", "watches", "servers"])
        XCTAssertEqual(state.selected?.title, "Needs you", "Needs you is where the island opens")
        XCTAssertTrue(state.showsDots)
        var s = state
        XCTAssertFalse(s.swipe(.right), "nothing before Needs you")
        XCTAssertTrue(s.swipe(.left))
        XCTAssertEqual(s.selected?.id, "sessions")
    }

    func testOneTabShowsNoDots() {
        var state = IslandTabState(tabs: [IslandTabRegistry.needsYou])
        XCTAssertFalse(state.showsDots)
        XCTAssertFalse(state.swipe(.left), "nowhere to go with one tab")
        XCTAssertFalse(state.swipe(.right))
    }

    func testASwipeLeftShowsTheNextTabAndRightThePreviousWithoutWrapping() {
        var state = IslandTabState(tabs: tabs)
        XCTAssertTrue(state.showsDots)
        XCTAssertTrue(state.swipe(.left))
        XCTAssertEqual(state.selected?.id, "sessions")
        XCTAssertTrue(state.swipe(.left))
        XCTAssertEqual(state.selected?.id, "usage")
        XCTAssertFalse(state.swipe(.left), "no wrap at the end")
        XCTAssertEqual(state.selected?.id, "usage")
        XCTAssertTrue(state.swipe(.right))
        XCTAssertEqual(state.selected?.id, "sessions")
        XCTAssertTrue(state.swipe(.right))
        XCTAssertFalse(state.swipe(.right), "no wrap at the start")
        XCTAssertEqual(state.selected?.id, "needs-you")
    }

    func testADotSelectsItsTab() {
        var state = IslandTabState(tabs: tabs)
        XCTAssertTrue(state.select("usage"))
        XCTAssertEqual(state.selectedIndex, 2)
        XCTAssertFalse(state.select("usage"), "already there")
        XCTAssertFalse(state.select("nope"))
    }

    func testTheTrackpadRecognizerDrivesTheTabsLikeThePill() {
        // A horizontal two-finger swipe, fingers moving left, crosses the threshold once per gesture.
        let recognizer = TrackpadHorizontalSwipeRecognizer()
        var state = IslandTabState(tabs: tabs)
        var result = recognizer.handle(deltaX: 0, deltaY: 0, phase: .began, momentumPhase: .none, timestamp: 0)
        for i in 1...10 {
            result = recognizer.handle(deltaX: -12, deltaY: 1, phase: .changed, momentumPhase: .none, timestamp: Double(i) * 0.01)
            if case .swiped(let direction) = result { state.swipe(direction) }
        }
        XCTAssertEqual(state.selected?.id, "sessions", "one swipe, one tab")
    }

    // MARK: Scrolling a tab's list vs swiping tabs (one axis per gesture)

    /// Feeds a gesture through the lock and the recognizer exactly as the controller does; returns what reached the
    /// list (the events passed on) and the tab it ended on.
    private func run(_ samples: [(dx: CGFloat, dy: CGFloat, phase: TrackpadScrollEventPhase, momentum: TrackpadScrollEventPhase)],
                     lock: inout IslandScrollAxisLock, recognizer: TrackpadHorizontalSwipeRecognizer,
                     state: inout IslandTabState) -> (scrolled: Int, swallowed: Int) {
        // Only events that carry movement count (a zero-delta `began` reaching the list moves nothing).
        var scrolled = 0, swallowed = 0
        for (i, e) in samples.enumerated() {
            let moves = e.dx != 0 || e.dy != 0
            switch lock.route(deltaX: e.dx, deltaY: e.dy, phase: e.phase, momentumPhase: e.momentum) {
            case .scroll:
                if moves { scrolled += 1 }
            case .scrollAndForgetSwipe:
                recognizer.reset()
                if moves { scrolled += 1 }
            case .swallow:
                if moves { swallowed += 1 }
            case .swipe:
                let result = recognizer.handle(deltaX: e.dx, deltaY: e.dy, phase: e.phase, momentumPhase: e.momentum,
                                               timestamp: Double(i) * 0.01)
                if case .swiped(let direction) = result { state.swipe(direction) }
                if moves { if lock.passesOn(result) { scrolled += 1 } else { swallowed += 1 } }
            }
        }
        return (scrolled, swallowed)
    }

    func testAVerticalScrollThatDriftsSidewaysNeverChangesTab() {
        var lock = IslandScrollAxisLock()
        var state = IslandTabState(tabs: tabs)
        let recognizer = TrackpadHorizontalSwipeRecognizer()
        // Mostly down, then the hand drifts hard to the left for many samples (enough to swipe on its own), then momentum.
        var gesture: [(dx: CGFloat, dy: CGFloat, phase: TrackpadScrollEventPhase, momentum: TrackpadScrollEventPhase)] =
            [(0, 0, .began, .none), (1, -6, .changed, .none), (0, -8, .changed, .none)]
        gesture += Array(repeating: (-14, -1, .changed, .none), count: 10)
        gesture += [(0, 0, .ended, .none), (-10, -3, .none, .began), (-6, -2, .none, .changed), (0, 0, .none, .ended)]
        let r = run(gesture, lock: &lock, recognizer: recognizer, state: &state)
        XCTAssertEqual(lock.axis, .undecided, "the momentum's end closed the gesture")
        XCTAssertEqual(state.selected?.id, "needs-you", "a vertical gesture never swipes, however it drifts")
        XCTAssertEqual(r.swallowed, 0, "every event of it reached the list")
    }

    func testAHorizontalSwipeChangesOneTabAndNeverScrollsTheList() {
        var lock = IslandScrollAxisLock()
        var state = IslandTabState(tabs: tabs)
        let recognizer = TrackpadHorizontalSwipeRecognizer()
        var gesture: [(dx: CGFloat, dy: CGFloat, phase: TrackpadScrollEventPhase, momentum: TrackpadScrollEventPhase)] =
            [(0, 0, .began, .none)]
        gesture += Array(repeating: (-12, 2, .changed, .none), count: 6)
        // The fingers then wander down — still the same horizontal gesture.
        gesture += Array(repeating: (-2, -9, .changed, .none), count: 5)
        gesture += [(0, 0, .ended, .none), (-8, 0, .none, .began), (0, 0, .none, .ended)]
        let r = run(gesture, lock: &lock, recognizer: recognizer, state: &state)
        XCTAssertEqual(state.selected?.id, "sessions", "one swipe, one tab")
        XCTAssertEqual(r.scrolled, 0, "nothing of a horizontal gesture reaches the list")
    }

    func testTheAxisIsDecidedOncePerGestureAndAMouseWheelAlwaysScrolls() {
        var lock = IslandScrollAxisLock()
        XCTAssertEqual(lock.route(deltaX: 0, deltaY: 0, phase: .began, momentumPhase: .none), .swipe, "undecided: the recognizer looks")
        XCTAssertEqual(lock.route(deltaX: 0, deltaY: -6, phase: .changed, momentumPhase: .none), .swipe, "not far enough yet")
        XCTAssertEqual(lock.axis, .undecided)
        XCTAssertEqual(lock.route(deltaX: 1, deltaY: -7, phase: .changed, momentumPhase: .none), .scrollAndForgetSwipe)
        XCTAssertEqual(lock.axis, .vertical)
        XCTAssertEqual(lock.route(deltaX: -30, deltaY: 0, phase: .changed, momentumPhase: .none), .scroll, "held for the gesture")
        XCTAssertEqual(lock.route(deltaX: 0, deltaY: 0, phase: .ended, momentumPhase: .none), .scroll)
        // A new gesture decides afresh.
        XCTAssertEqual(lock.route(deltaX: 0, deltaY: 0, phase: .mayBegin, momentumPhase: .none), .swipe)
        XCTAssertEqual(lock.route(deltaX: -13, deltaY: 1, phase: .changed, momentumPhase: .none), .swipe)
        XCTAssertEqual(lock.axis, .horizontal)
        // A wheel without phases (a mouse) goes to the list, whatever the lock holds.
        XCTAssertEqual(lock.route(deltaX: 0, deltaY: -3, phase: .none, momentumPhase: .none), .scroll)
    }

    /// A swipe that starts on a diagonal — (3, −4), which a 4 pt decision used to latch as vertical for the whole gesture —
    /// stays undecided until one axis clearly leads, and then swipes.
    func testADiagonalStartIsNotLatchedVertical() {
        var lock = IslandScrollAxisLock()
        var state = IslandTabState(tabs: tabs)
        let recognizer = TrackpadHorizontalSwipeRecognizer()
        var gesture: [(dx: CGFloat, dy: CGFloat, phase: TrackpadScrollEventPhase, momentum: TrackpadScrollEventPhase)] =
            [(0, 0, .began, .none), (-3, -4, .changed, .none), (-6, -5, .changed, .none)]
        _ = run(gesture, lock: &lock, recognizer: recognizer, state: &state)
        XCTAssertEqual(lock.axis, .undecided, "9 × 9 pt so far: a diagonal, not yet an axis")
        gesture = Array(repeating: (-14, -1, .changed, .none), count: 8) + [(0, 0, .ended, .none)]
        _ = run(gesture, lock: &lock, recognizer: recognizer, state: &state)
        XCTAssertEqual(state.selected?.id, "sessions", "it swiped once the fingers clearly went sideways")
    }

    /// Once a gesture is horizontal, a vertical turn the recognizer ignores (it un-latches on a vertical-dominant sample
    /// before the swipe fires) is swallowed: the list never scrolls under a tab swipe.
    func testAVerticalTurnInAHorizontalGestureNeverScrollsTheList() {
        var lock = IslandScrollAxisLock()
        var state = IslandTabState(tabs: tabs)
        let recognizer = TrackpadHorizontalSwipeRecognizer()
        var gesture: [(dx: CGFloat, dy: CGFloat, phase: TrackpadScrollEventPhase, momentum: TrackpadScrollEventPhase)] =
            [(0, 0, .began, .none), (-14, 0, .changed, .none)]
        gesture += Array(repeating: (0, -10, .changed, .none), count: 4)
        gesture += [(0, 0, .ended, .none)]
        let r = run(gesture, lock: &lock, recognizer: recognizer, state: &state)
        XCTAssertEqual(lock.axis, .horizontal)
        XCTAssertEqual(r.scrolled, 0, "the vertical turn reached the list")
        XCTAssertEqual(r.swallowed, 5)
        XCTAssertEqual(state.selected?.id, "needs-you", "too short to swipe")
    }
}
