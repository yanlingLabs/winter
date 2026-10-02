import XCTest
@testable import Winter

/// The child row's width split — 1 child = the main pill's width, then halves, thirds, … for as long
/// as every pill keeps `minChildPillWidth`, then as many as fit plus a "+n" circle — and the status
/// mapping.
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

    func testTheRowKeepsSplittingWhileEveryPillStaysWideEnough() {
        let fitting = Int(((row + gap) / (DispatchPillMetrics.minChildPillWidth + gap)).rounded(.down))
        XCTAssertGreaterThanOrEqual(fitting, 4, "the compact pill's row holds at least four")
        for count in 2...fitting {
            let layout = childPillLayout(count: count, rowWidth: row)
            XCTAssertEqual(layout.visibleCount, count)
            XCTAssertEqual(layout.overflowCount, 0)
            XCTAssertEqual(layout.pillWidth * CGFloat(count) + gap * CGFloat(count - 1), row, accuracy: 0.001,
                           "\(count) pills and their gaps fill the row exactly")
            XCTAssertGreaterThanOrEqual(layout.pillWidth, DispatchPillMetrics.minChildPillWidth)
        }
        XCTAssertEqual(childPillLayout(count: 2, rowWidth: row).pillWidth, (row - gap) / 2)
    }

    func testOnceThePillsNoLongerFitTheRestBecomeAPlusNCircle() {
        let fitting = Int(((row + gap) / (DispatchPillMetrics.minChildPillWidth + gap)).rounded(.down))
        for count in [fitting + 1, fitting + 3, 30] {
            let layout = childPillLayout(count: count, rowWidth: row)
            XCTAssertGreaterThan(layout.overflowCount, 0)
            XCTAssertEqual(layout.visibleCount + layout.overflowCount, count, "every child is counted")
            XCTAssertGreaterThanOrEqual(layout.pillWidth, DispatchPillMetrics.minChildPillWidth)
            XCTAssertEqual(layout.pillWidth * CGFloat(layout.visibleCount) + gap * CGFloat(layout.visibleCount) + circle,
                           row, accuracy: 0.001, "the pills, the circle, and their gaps fill the row exactly")
        }
    }

    func testTheWiderTypingPillHoldsMoreChildren() {
        let compact = childPillLayout(count: 30, rowWidth: DispatchPillMetrics.compactWidth).visibleCount
        let expanded = childPillLayout(count: 30, rowWidth: DispatchPillMetrics.expandedWidth).visibleCount
        XCTAssertGreaterThan(expanded, compact)
    }

    func testAChildPillIsTheMainPillsHeight() {
        XCTAssertEqual(DispatchPillMetrics.childRowHeight, DispatchPillMetrics.pillHeight)
    }

    func testTheRowFollowsTheMainPillsWidth() {
        let wide = childPillLayout(count: 2, rowWidth: DispatchPillMetrics.expandedWidth)
        let narrow = childPillLayout(count: 2, rowWidth: DispatchPillMetrics.compactWidth)
        XCTAssertGreaterThan(wide.pillWidth, narrow.pillWidth)
    }

    func testAWidthTooSmallNeverGoesNegative() {
        XCTAssertEqual(childPillLayout(count: 9, rowWidth: 10).pillWidth, 0)
        XCTAssertEqual(childPillLayout(count: 1, rowWidth: 10).visibleCount, 1, "one child always shows")
    }

    // MARK: - Coming and going

    func testAChildPillRisesOutOfTheMainPillAndSinksBackIntoIt() {
        let hidden = ChildPillEntrance(progress: 0)
        let shown = ChildPillEntrance(progress: 1)
        XCTAssertEqual(shown, ChildPillEntrance(progress: 1))
        XCTAssertEqual(shown.scale, 1)
        XCTAssertEqual(shown.offsetY, 0)
        XCTAssertEqual(shown.opacity, 1)
        XCTAssertEqual(shown.blur, 0, "sharp once in place")
        XCTAssertLessThan(hidden.scale, 1, "starts smaller")
        XCTAssertGreaterThan(hidden.offsetY, 0, "starts lower — inside the main pill below")
        XCTAssertEqual(hidden.opacity, 0)
        XCTAssertGreaterThan(hidden.blur, 0)
        let mid = ChildPillEntrance(progress: 0.5)
        XCTAssertTrue(hidden.scale < mid.scale && mid.scale < shown.scale)
        XCTAssertTrue(hidden.offsetY > mid.offsetY && mid.offsetY > shown.offsetY)
        XCTAssertEqual(ChildPillEntrance(progress: 3), shown, "clamped")
    }

    func testTheCanvasWaitsForALeavingPillToFinishSinking() {
        XCTAssertGreaterThanOrEqual(DispatchPillController.accessoryShrinkDelay, 0.5,
                                    "the canvas never tightens while a pill is still on its way out")
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
