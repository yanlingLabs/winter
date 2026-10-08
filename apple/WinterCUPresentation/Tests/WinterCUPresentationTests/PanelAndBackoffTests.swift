import XCTest
@testable import WinterCUPresentation

final class PanelAndBackoffTests: XCTestCase {
    /// Both panels let clicks through: a foreground click at the target's top-left must reach the target, not the
    /// mirror floating over its traffic lights.
    func testEveryPanelIsClickThrough() {
        for role in PanelRole.allCases {
            XCTAssertTrue(role.ignoresMouseEvents, "\(role) must be click-through")
        }
        // Both float: ordering relative to another app's window does not hold, so the overlay floats and hides its
        // cursor where the target is covered instead.
        XCTAssertTrue(PanelRole.mirror.floatsAboveWindows)
        XCTAssertTrue(PanelRole.cursorOverlay.floatsAboveWindows)
    }

    func testTheCursorHidesOnlyWhereAWindowAboveTheTargetCoversItsPoint() {
        let me: pid_t = 99
        let cover = StackWindow(id: 8, pid: 20, layer: 0, bounds: CGRect(x: 300, y: 200, width: 300, height: 200))
        XCTAssertTrue(CursorOcclusion.isVisible(at: CGPoint(x: 100, y: 100), above: [cover], ownPID: me))
        XCTAssertFalse(CursorOcclusion.isVisible(at: CGPoint(x: 400, y: 300), above: [cover], ownPID: me),
                       "another app's window covers the point")
        // The helper's own panels, other levels (menu bar, Dock, menus) and see-through windows never hide it.
        let mirror = StackWindow(id: 50, pid: me, layer: 3, bounds: CGRect(x: 0, y: 0, width: 400, height: 300))
        let ownOrdinary = StackWindow(id: 53, pid: me, layer: 0, bounds: CGRect(x: 0, y: 0, width: 800, height: 600))
        let dock = StackWindow(id: 51, pid: 30, layer: 20, bounds: CGRect(x: 0, y: 0, width: 800, height: 600))
        let glass = StackWindow(id: 52, pid: 40, layer: 0, bounds: CGRect(x: 0, y: 0, width: 800, height: 600), alpha: 0)
        XCTAssertTrue(CursorOcclusion.isVisible(at: CGPoint(x: 100, y: 100), above: [mirror, ownOrdinary, dock, glass],
                                                ownPID: me))
        // Nothing above at all: visible.
        XCTAssertTrue(CursorOcclusion.isVisible(at: CGPoint(x: 100, y: 100), above: [], ownPID: me))
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
