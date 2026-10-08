import XCTest
@testable import WinterCUPresentation

final class PanelAndBackoffTests: XCTestCase {
    /// Both panels let clicks through: a foreground click at the target's top-left must reach the target, not the
    /// mirror floating over its traffic lights.
    func testEveryPanelIsClickThrough() {
        for role in PanelRole.allCases {
            XCTAssertTrue(role.ignoresMouseEvents, "\(role) must be click-through")
        }
        XCTAssertTrue(PanelRole.mirror.floatsAboveWindows)
        XCTAssertFalse(PanelRole.cursorOverlay.floatsAboveWindows)
    }

    func testRestartBackoffDoublesCapsAndGivesUp() {
        var b = RestartBackoff()
        var delays: [TimeInterval] = []
        while let d = b.nextDelay() { delays.append(d) }
        XCTAssertEqual(delays, [1, 2, 4, 8, 16, 16])
        XCTAssertNil(b.nextDelay())
        b.reset()
        XCTAssertEqual(b.nextDelay(), 1, "a healthy frame starts the schedule over")
    }

    func testRestartBackoffIsConfigurable() {
        var b = RestartBackoff(first: 0.5, max: 3, attempts: 4)
        XCTAssertEqual([b.nextDelay(), b.nextDelay(), b.nextDelay(), b.nextDelay(), b.nextDelay()], [0.5, 1, 2, 3, nil])
    }
}
