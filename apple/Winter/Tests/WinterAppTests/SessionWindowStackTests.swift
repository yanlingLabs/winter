import XCTest
import AppKit
@testable import Winter

/// The session windows opened from the dispatch pill's child pills stand in a stack on the pill:
/// the newest at the bottom, the others shrinking up to make room, a new column once one is full —
/// and a window the user moves leaves it.
@MainActor
final class SessionWindowStackTests: XCTestCase {
    private let visible = CGRect(x: 0, y: 0, width: 1512, height: 944)
    private var geometry: SessionWindowStackGeometry { .standing(on: visible) }

    // MARK: - Layout (pure)

    func testOneWindowStandsOnThePillAtItsFullHeight() {
        let frames = sessionWindowStackFrames(count: 1, geometry: geometry)
        XCTAssertEqual(frames.count, 1)
        let f = frames[0]
        XCTAssertEqual(f.minY, geometry.bottomY.rounded(.down), accuracy: 1, "standing on the pill")
        XCTAssertEqual(f.height, geometry.maxHeight, accuracy: 1)
        XCTAssertEqual(f.midX, visible.midX, accuracy: 1, "centred on the pill")
        XCTAssertGreaterThan(geometry.bottomY,
                             visible.minY + DispatchPillMetrics.dockGap + DispatchPillMetrics.pillHeight + DispatchPillMetrics.childRowHeight,
                             "clear of the pill and its child row")
    }

    func testTheNewestStandsAtTheBottomAndTheOthersShrinkUp() {
        let one = sessionWindowStackFrames(count: 1, geometry: geometry)
        let two = sessionWindowStackFrames(count: 2, geometry: geometry)
        let three = sessionWindowStackFrames(count: 3, geometry: geometry)
        XCTAssertLessThan(two[1].minY, two[0].minY, "the newer window is below the older")
        XCTAssertEqual(two[1].minY, one[0].minY, accuracy: 1, "the newest takes the bottom slot")
        XCTAssertLessThan(two[0].height, one[0].height + 0.5, "the first shrank to make room")
        XCTAssertLessThanOrEqual(three[0].height, two[0].height + 0.5, "and again for a third")
        XCTAssertLessThan(three[1].minY, three[0].minY)
        XCTAssertLessThan(three[2].minY, three[1].minY)
        for frames in [two, three] {
            for (a, b) in zip(frames, frames.dropFirst()) {
                XCTAssertFalse(a.intersects(b), "stacked windows never overlap")
            }
            for f in frames { XCTAssertLessThanOrEqual(f.maxY, visible.maxY, "on screen") }
        }
    }

    func testAFullColumnStartsANewOneBesideIt() {
        let perColumn = geometry.perColumn
        let frames = sessionWindowStackFrames(count: perColumn + 1, geometry: geometry)
        XCTAssertEqual(frames.count, perColumn + 1)
        XCTAssertNotEqual(frames.last!.minX, frames.first!.minX, "the next window opens a second column")
        for f in frames { XCTAssertGreaterThanOrEqual(f.height, geometry.minHeight - 0.5, "never shorter than usable") }
        let xs = Set(frames.map(\.minX))
        XCTAssertEqual(xs.count, 2)
        let span = (xs.min()! + xs.max()! + geometry.width) / 2
        XCTAssertEqual(span, visible.midX, accuracy: 1, "the columns stay centred on the pill")
    }

    func testTheEaseSettlesExactly() {
        XCTAssertEqual(sessionWindowStackEase(0), 0)
        XCTAssertEqual(sessionWindowStackEase(1), 1)
        XCTAssertEqual(sessionWindowStackEase(4), 1, "clamped")
        XCTAssertGreaterThan(sessionWindowStackEase(0.5), 0.5, "ease-out: most of the way early")
    }

    // MARK: - Real windows

    private var controllers: [DetachedWindowController] = []

    override func tearDown() async throws {
        controllers.forEach { $0.close() }
        controllers.removeAll()
        try await super.tearDown()
    }

    private func window(_ stack: SessionWindowStack) -> DetachedWindowController {
        let t = DetachedScriptedTransport()
        let session = SessionModel()
        let feed = SessionFeed(makeTransport: { t }, token: "tok", clientName: "orb", mode: .pinned(sessionId: "S\(controllers.count)"), session: session)
        let c = DetachedWindowController(feed: feed, session: session, frame: stack.frameForNewMember(), title: "W")
        controllers.append(c)
        c.show()
        stack.add(c)
        stack.finishForTesting()
        return c
    }

    func testWindowsMakeRoomAndCloseTheGap() {
        let stack = SessionWindowStack()
        stack.visibleFrameOverride = visible
        let first = window(stack)
        XCTAssertEqual(first.currentFrame, sessionWindowStackFrames(count: 1, geometry: geometry)[0])
        let second = window(stack)
        let two = sessionWindowStackFrames(count: 2, geometry: geometry)
        XCTAssertEqual(first.currentFrame, two[0], "the first moved up and shrank")
        XCTAssertEqual(second.currentFrame, two[1], "the second stands at the bottom")
        XCTAssertEqual(second.windowForTesting?.alphaValue, 1, "fully faded in")
        stack.remove(second)
        stack.finishForTesting()
        XCTAssertEqual(first.currentFrame, sessionWindowStackFrames(count: 1, geometry: geometry)[0],
                       "the gap closes: the first grows back")
    }

    func testAWindowTheUserMovesLeavesTheStack() {
        let stack = SessionWindowStack()
        stack.visibleFrameOverride = visible
        let first = window(stack)
        _ = window(stack)
        XCTAssertEqual(stack.members.count, 2)
        // The user drags it (its drag band / grips move the window directly).
        first.windowForTesting?.setFrameOrigin(NSPoint(x: 40, y: 300))
        XCTAssertEqual(stack.members.count, 1, "moved by hand: no longer the stack's")
        XCTAssertNil(first.stackMembership)
        XCTAssertEqual(first.currentFrame.origin, NSPoint(x: 40, y: 300), "and it stays where it was put")
    }
}
