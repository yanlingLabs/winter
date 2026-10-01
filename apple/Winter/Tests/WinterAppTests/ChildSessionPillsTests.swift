import XCTest
@testable import Winter

/// The child row's width split — 1 child = the main pill's width, 2 = halves, 3 = thirds,
/// 4 = quarters, more than 4 = the first 3 plus a "+n" circle — and the status mapping.
final class ChildSessionPillsTests: XCTestCase {
    private let row: CGFloat = 360
    private let gap = DispatchPillMetrics.childPillGap
    private let circle = DispatchPillMetrics.childRowHeight

    func testNoChildrenNoPills() {
        XCTAssertEqual(childPillLayout(count: 0, rowWidth: row),
                       ChildPillLayout(visibleCount: 0, pillWidth: 0, overflowCount: 0))
    }

    func testOneChildTakesTheWholeWidth() {
        XCTAssertEqual(childPillLayout(count: 1, rowWidth: row),
                       ChildPillLayout(visibleCount: 1, pillWidth: row, overflowCount: 0))
    }

    func testTwoThreeAndFourSplitTheRowEvenly() {
        for count in 2...4 {
            let layout = childPillLayout(count: count, rowWidth: row)
            XCTAssertEqual(layout.visibleCount, count)
            XCTAssertEqual(layout.overflowCount, 0)
            XCTAssertEqual(layout.pillWidth * CGFloat(count) + gap * CGFloat(count - 1), row, accuracy: 0.001,
                           "\(count) pills and their gaps fill the row exactly")
        }
        XCTAssertEqual(childPillLayout(count: 2, rowWidth: row).pillWidth, (row - gap) / 2)
        XCTAssertEqual(childPillLayout(count: 4, rowWidth: row).pillWidth, (row - 3 * gap) / 4)
    }

    func testMoreThanFourShowsThreeAndAPlusNCircle() {
        for count in [5, 6, 12] {
            let layout = childPillLayout(count: count, rowWidth: row)
            XCTAssertEqual(layout.visibleCount, 3)
            XCTAssertEqual(layout.overflowCount, count - 3)
            XCTAssertEqual(layout.pillWidth * 3 + gap * 3 + circle, row, accuracy: 0.001,
                           "three pills, the circle, and their gaps fill the row exactly")
        }
    }

    func testTheRowFollowsTheMainPillsWidth() {
        let wide = childPillLayout(count: 2, rowWidth: DispatchPillMetrics.expandedWidth)
        let narrow = childPillLayout(count: 2, rowWidth: DispatchPillMetrics.compactWidth)
        XCTAssertGreaterThan(wide.pillWidth, narrow.pillWidth)
    }

    func testAWidthTooSmallNeverGoesNegative() {
        XCTAssertEqual(childPillLayout(count: 9, rowWidth: 10).pillWidth, 0)
    }

    func testStatusMapping() {
        XCTAssertEqual(ChildPillStatus(wireStatus: "running"), .working)
        XCTAssertEqual(ChildPillStatus(wireStatus: "queued"), .working, "unknown reads as working")
        XCTAssertEqual(ChildPillStatus(wireStatus: "awaiting_approval"), .needsYou)
        XCTAssertEqual(ChildPillStatus(wireStatus: "awaiting_input"), .needsYou)
        XCTAssertEqual(ChildPillStatus(wireStatus: "error"), .failed)
        XCTAssertEqual(ChildPillStatus(wireStatus: "completed"), .done)
    }

    func testOnlyALiveChildOffersStop() {
        XCTAssertTrue(ChildPillStatus.working.isStoppable)
        XCTAssertTrue(ChildPillStatus.needsYou.isStoppable)
        XCTAssertFalse(ChildPillStatus.failed.isStoppable)
        XCTAssertFalse(ChildPillStatus.done.isStoppable)
    }
}
