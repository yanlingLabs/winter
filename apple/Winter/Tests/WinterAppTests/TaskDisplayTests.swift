import XCTest
@testable import Winter

/// Task 1: the shared pure task-display module — sort/collapse/glyph/elapsed/tokens. Lockstep
/// twin of `packages/cli/test/task-display.test.ts` — SAME fixtures/expectations on both sides
/// (see `TaskDisplay.swift` and `task-display.ts`). Tasks 3 (window) and 4 (CLI) consume this;
/// nothing renders here.
final class TaskDisplayTests: XCTestCase {
    private func row(_ id: String, _ status: String) -> TaskRow {
        TaskRow(id: id, subject: id, status: status, activeForm: nil, startedTs: nil)
    }

    func testSortInProgressPendingCompletedStable() {
        let r = sortTasksForDisplay([row("a", "completed"), row("b", "pending"), row("c", "in_progress"), row("d", "pending")])
        XCTAssertEqual(r.map(\.id), ["c", "b", "d", "a"])
    }

    func testCollapseAllIncompletePlusThreeCompletedAtCapShowsAllCountZero() {
        let sorted = sortTasksForDisplay([row("p1", "pending"), row("ip", "in_progress"), row("c1", "completed"), row("c2", "completed"), row("c3", "completed")])
        let r = collapseCompleted(sorted)
        XCTAssertEqual(r.rows.map(\.id), ["ip", "p1", "c1", "c2", "c3"])
        XCTAssertEqual(r.collapsedCompletedCount, 0)
    }

    func testCollapseAtMostThreeCompletedShowsAllCountZero() {
        let r = collapseCompleted(sortTasksForDisplay([row("c1", "completed"), row("c2", "completed"), row("c3", "completed")]))
        XCTAssertEqual(r.rows.map(\.id), ["c1", "c2", "c3"])
        XCTAssertEqual(r.collapsedCompletedCount, 0)
    }

    func testCollapseCapIsThreeCCParity() {
        let sorted = sortTasksForDisplay([row("ip", "in_progress"), row("c1", "completed"), row("c2", "completed"), row("c3", "completed"), row("c4", "completed"), row("c5", "completed")])
        let r = collapseCompleted(sorted)
        XCTAssertEqual(r.rows.map(\.id), ["ip", "c1", "c2", "c3"])
        XCTAssertEqual(r.collapsedCompletedCount, 2)
    }

    func testTaskCountsLine() {
        XCTAssertEqual(taskCountsLine([row("a", "completed"), row("b", "in_progress"), row("c", "pending"), row("d", "weird")]),
                        "4 tasks (1 done, 1 in progress, 2 open)")
        XCTAssertEqual(taskCountsLine([]), "0 tasks (0 done, 0 in progress, 0 open)")
    }

    func testGlyphs() {
        XCTAssertEqual(taskGlyph("in_progress"), "■")
        XCTAssertEqual(taskGlyph("completed"), "✓")
        XCTAssertEqual(taskGlyph("pending"), "☐")
        XCTAssertEqual(taskGlyph("weird"), "☐")
    }

    func testFormatElapsed() {
        XCTAssertEqual(formatElapsed(14000), "14s")
        XCTAssertEqual(formatElapsed(123000), "2m 3s")
        XCTAssertEqual(formatElapsed(3840000), "1h 4m")
    }

    func testFormatTokens() {
        XCTAssertEqual(formatTokens(842), "842")
        XCTAssertEqual(formatTokens(10600), "10.6k")
        XCTAssertEqual(formatTokens(1200000), "1.2M")
    }

    /// Task-1 review fix: the exact binary-tie cases (n mod 1000 == 250) must round half-UP and
    /// match the TS side byte-for-byte — %.1f (round-half-to-even) used to give 1.2k here.
    func testFormatTokensLockstepTieCases() {
        XCTAssertEqual(formatTokens(1250), "1.3k")
        XCTAssertEqual(formatTokens(2250), "2.3k")
        XCTAssertEqual(formatTokens(12250), "12.3k")
        XCTAssertEqual(formatTokens(100250), "100.3k")
        XCTAssertEqual(formatTokens(1250000), "1.3M")
        XCTAssertEqual(formatTokens(1000), "1.0k")
        XCTAssertEqual(formatTokens(1249), "1.2k")
    }
}
