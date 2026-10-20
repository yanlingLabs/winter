import XCTest
import AppKit
import SwiftUI
@testable import Winter

/// The user's report (2026-10-20): the pill's answer card showed only 1–2 lines of Dispatch's reply — it should show
/// the FULL answer. A pinned turn now lays its whole reply out and grows to it, up to most of the screen
/// (`dispatchPillPreviewCeiling`); past that the reply scrolls inside the pill, never cut.
@MainActor
final class DispatchPillReplyPreviewTests: XCTestCase {
    private let visible = CGRect(x: 100, y: 80, width: 1440, height: 820)
    private var controllers: [DispatchPillController] = []
    private var suites: [String] = []

    override func tearDown() async throws {
        controllers.forEach { $0.hide() }
        controllers.removeAll()
        suites.forEach { UserDefaults().removePersistentDomain(forName: $0) }
        suites.removeAll()
        try await super.tearDown()
    }

    private func pinnedPill(reply: String) -> DispatchPillController {
        pinnedPill(replies: [reply])
    }

    /// A pill with one turn per reply, the newest pinned.
    private func pinnedPill(replies: [String]) -> DispatchPillController {
        let session = SessionModel()
        session.applyForTesting { s in
            s.exchanges = replies.enumerated().map { Exchange(prompt: "question \($0.offset + 1)", reply: $0.element) }
        }
        let suite = "WinterTests.DispatchPillReplyPreview.\(UUID().uuidString)"
        suites.append(suite)
        let pill = DispatchPillController(session: session,
                                          settings: DispatchPillSettings(defaults: UserDefaults(suiteName: suite)!))
        pill.visibleFrameOverrideForTesting = visible
        controllers.append(pill)
        pill.show()
        XCTAssertTrue(pill.handleSwipe(.right))
        let end = Date().addingTimeInterval(3)
        while Date() < end, !(pill.isSpringIdleForTesting && pill.previewReplyLaidOutHeightForTesting != nil) {
            RunLoop.main.run(until: Date().addingTimeInterval(0.01))
        }
        settle(pill)
        return pill
    }

    private func settle(_ pill: DispatchPillController) {
        let end = Date().addingTimeInterval(3)
        while Date() < end, !pill.isSpringIdleForTesting { RunLoop.main.run(until: Date().addingTimeInterval(0.01)) }
        RunLoop.main.run(until: Date().addingTimeInterval(0.15))
    }

    /// A real click (down, up) on the reply's last line, as AppKit delivers it.
    private func clickTheReply(_ pill: DispatchPillController) {
        guard let window = pill.hostingViewForTesting?.window else { return XCTFail("no panel") }
        let main = dispatchPillMainRect(canvasSize: pill.canvas.size, mainSize: pill.morph.size)
        let point = CGPoint(x: main.minX + DispatchPillMetrics.leadingPadding + 24,
                            y: pill.canvas.size.height - (main.maxY - DispatchPillMetrics.previewVerticalInset - 8))
        for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
            guard let event = NSEvent.mouseEvent(with: type, location: point, modifierFlags: [],
                                                 timestamp: ProcessInfo.processInfo.systemUptime,
                                                 windowNumber: window.windowNumber, context: nil, eventNumber: 0,
                                                 clickCount: 1, pressure: type == .leftMouseDown ? 1 : 0) else {
                return XCTFail("no event")
            }
            // Through the app, as AppKit delivers it: the pill's local monitors see it, then the panel.
            NSApp.sendEvent(event)
            RunLoop.main.run(until: Date().addingTimeInterval(0.02))
        }
        RunLoop.main.run(until: Date().addingTimeInterval(0.1))
    }

    private let longReply = (1...200).map { "Paragraph \($0): the long answer goes on." }.joined(separator: "\n")

    /// The reply's scroll view (not the composer's text view).
    private func replyScrollView(in view: NSView?) -> NSScrollView? {
        guard let view else { return nil }
        if let scroll = view as? NSScrollView, !(scroll.documentView is NSTextView) { return scroll }
        for sub in view.subviews { if let found = replyScrollView(in: sub) { return found } }
        return nil
    }

    private var lineHeight: CGFloat {
        ceil(NSLayoutManager().defaultLineHeight(for: Typography.sansNS(ofSize: Typography.composerFieldSize)))
    }

    func testASixLineReplyIsShownWhole() {
        let reply = (1...6).map { "Line \($0) of the answer." }.joined(separator: "\n")
        let pill = pinnedPill(reply: reply)
        XCTAssertEqual(pill.turnPreview?.reply, reply, "nothing cut from the text")
        guard let laidOut = pill.previewReplyLaidOutHeightForTesting else { return XCTFail("the reply never laid out") }
        XCTAssertGreaterThanOrEqual(laidOut, 5.5 * lineHeight, "all six lines laid out, none truncated")
        let ceiling = dispatchPillPreviewCeiling(visibleFrame: visible)
        XCTAssertEqual(pill.morph.target.height,
                       dispatchPillPreviewHeight(replyHeight: laidOut, lineHeight: lineHeight, ceiling: ceiling),
                       accuracy: 1, "the pill grows to fit the whole reply")
        XCTAssertLessThan(pill.morph.target.height, ceiling)
        XCTAssertGreaterThan(pill.morph.target.height, DispatchPillMetrics.maxExpandedHeight - 100)
        XCTAssertNotNil(pill.hostingViewForTesting, "the pill's view is mounted")
        XCTAssertFalse(pill.previewReplyScrolls)
        XCTAssertNil(replyScrollView(in: pill.hostingViewForTesting), "it fits: no scroll view at all")
    }

    // MARK: - A click on the reply dismisses it

    func testAClickOnAShortReplyReturnsToTheComposer() {
        let pill = pinnedPill(reply: "One.\nTwo.\nThree.")
        XCTAssertNotNil(pill.historyIndex)
        clickTheReply(pill)
        XCTAssertNil(pill.historyIndex, "the click on the reply left the pinned turn")
    }

    func testAClickOnAScrollingReplyReturnsToTheComposer() {
        let pill = pinnedPill(reply: longReply)
        XCTAssertTrue(pill.previewReplyScrolls)
        XCTAssertNotNil(replyScrollView(in: pill.hostingViewForTesting))
        clickTheReply(pill)
        XCTAssertNil(pill.historyIndex, "a click (not a scroll) inside the scrolling reply left the pinned turn")
    }

    // MARK: - Each turn opens at its top

    /// A drag on the scrolling reply (its text, its scroller) is not a click: the turn stays pinned.
    func testADragOnAScrollingReplyIsNotAClick() {
        let pill = pinnedPill(reply: longReply)
        guard let window = pill.hostingViewForTesting?.window else { return XCTFail("no panel") }
        let main = dispatchPillMainRect(canvasSize: pill.canvas.size, mainSize: pill.morph.size)
        let y = pill.canvas.size.height - (main.maxY - 40)
        for (type, dy) in [(NSEvent.EventType.leftMouseDown, 0.0), (.leftMouseDragged, 30.0), (.leftMouseUp, 30.0)] {
            let event = NSEvent.mouseEvent(with: type, location: CGPoint(x: main.minX + 60, y: y + dy), modifierFlags: [],
                                           timestamp: ProcessInfo.processInfo.systemUptime,
                                           windowNumber: window.windowNumber, context: nil, eventNumber: 0,
                                           clickCount: 1, pressure: 1)!
            NSApp.sendEvent(event)
            RunLoop.main.run(until: Date().addingTimeInterval(0.02))
        }
        RunLoop.main.run(until: Date().addingTimeInterval(0.1))
        XCTAssertNotNil(pill.historyIndex)
    }

    func testATurnSwipedToOpensAtItsTop() {
        let pill = pinnedPill(replies: [longReply, longReply + "\nThe newest one."])
        guard let scroll = replyScrollView(in: pill.hostingViewForTesting) else { return XCTFail("no scroll view") }
        let top = scroll.contentView.bounds.origin.y
        scroll.contentView.scroll(to: NSPoint(x: 0, y: top + 600))
        scroll.reflectScrolledClipView(scroll.contentView)
        XCTAssertGreaterThan(scroll.contentView.bounds.origin.y, top + 300, "scrolled down")
        XCTAssertTrue(pill.handleSwipe(.right), "to the older turn")
        settle(pill)
        guard let next = replyScrollView(in: pill.hostingViewForTesting) else { return XCTFail("no scroll view") }
        XCTAssertLessThan(abs(next.contentView.bounds.origin.y), 10, "the older turn opens at its top, not where the last was")
    }

    func testAVeryLongReplyScrollsInsideTheCeiling() {
        let pill = pinnedPill(reply: longReply)
        XCTAssertEqual(pill.turnPreview?.reply, longReply, "nothing cut from the text")
        let ceiling = dispatchPillPreviewCeiling(visibleFrame: visible)
        XCTAssertEqual(pill.morph.target.height, ceiling, "grown to the ceiling, no further")
        guard let laidOut = pill.previewReplyLaidOutHeightForTesting else { return XCTFail("the reply never laid out") }
        XCTAssertGreaterThanOrEqual(laidOut, 190 * lineHeight, "every line laid out, none truncated")
        guard let scroll = replyScrollView(in: pill.hostingViewForTesting), let document = scroll.documentView else {
            return XCTFail("the reply is not in a scroll view")
        }
        XCTAssertGreaterThan(document.frame.height, scroll.contentView.bounds.height + 100, "the rest scrolls inside")
        XCTAssertLessThan(scroll.frame.height, ceiling)
    }
}
