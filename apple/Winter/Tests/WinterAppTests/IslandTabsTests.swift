import XCTest
@testable import Winter

/// The open island's tabs: the registry, the two-finger swipe between them, the dots.
final class IslandTabsTests: XCTestCase {
    private let tabs = [
        IslandTabRegistry.needsYou,
        IslandTab(id: "sessions", title: "Sessions", symbol: "rectangle.stack"),
        IslandTab(id: "usage", title: "Usage and limits", symbol: "gauge"),
    ]

    func testNeedsYouComesFirstWatchesIsRegisteredAndOneTabShowsNoDots() {
        let state = IslandTabState()
        XCTAssertEqual(state.tabs.first?.id, "needs-you")
        XCTAssertEqual(state.selected?.title, "Needs you")
        XCTAssertTrue(state.tabs.contains(IslandTabRegistry.watches), "phase 2: the Watches tab")
        XCTAssertTrue(state.showsDots)
        let one = IslandTabState(tabs: [IslandTabRegistry.needsYou])
        XCTAssertFalse(one.showsDots)
        var s = one
        XCTAssertFalse(s.swipe(.left), "nowhere to go with one tab")
        XCTAssertFalse(s.swipe(.right))
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
}
