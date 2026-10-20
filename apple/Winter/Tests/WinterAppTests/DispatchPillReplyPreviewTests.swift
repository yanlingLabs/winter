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
        let session = SessionModel()
        session.applyForTesting { s in s.exchanges = [Exchange(prompt: "how did it go?", reply: reply)] }
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
        RunLoop.main.run(until: Date().addingTimeInterval(0.1))
        return pill
    }

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
        if let scroll = replyScrollView(in: pill.hostingViewForTesting), let document = scroll.documentView {
            XCTAssertLessThanOrEqual(document.frame.height, scroll.contentView.bounds.height + 1,
                                     "it fits: nothing to scroll")
        }
    }

    func testAVeryLongReplyScrollsInsideTheCeiling() {
        let reply = (1...200).map { "Paragraph \($0): the long answer goes on." }.joined(separator: "\n")
        let pill = pinnedPill(reply: reply)
        XCTAssertEqual(pill.turnPreview?.reply, reply, "nothing cut from the text")
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
