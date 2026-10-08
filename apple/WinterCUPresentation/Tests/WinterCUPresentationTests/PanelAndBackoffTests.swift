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
        let me: pid_t = 99, app: pid_t = 70
        let target = CGRect(x: 0, y: 69, width: 1200, height: 800)
        func visible(_ p: CGPoint, _ above: [StackWindow]) -> Bool {
            CursorOcclusion.isVisible(at: p, above: above, ownPID: me, targetPID: app, targetFrame: target)
        }
        let cover = StackWindow(id: 8, pid: 20, layer: 0, bounds: CGRect(x: 300, y: 200, width: 300, height: 200))
        XCTAssertTrue(visible(CGPoint(x: 100, y: 100), [cover]))
        XCTAssertFalse(visible(CGPoint(x: 400, y: 300), [cover]), "another app's window covers the point")
        // The helper's own panels, other levels (menu bar, Dock, menus) and see-through windows never hide it.
        let mirror = StackWindow(id: 50, pid: me, layer: 3, bounds: CGRect(x: 0, y: 0, width: 400, height: 300))
        let ownOrdinary = StackWindow(id: 53, pid: me, layer: 0, bounds: CGRect(x: 0, y: 0, width: 800, height: 600))
        let menuBar = StackWindow(id: 54, pid: 31, layer: 24, bounds: CGRect(x: 0, y: 0, width: 1512, height: 33))
        let dock = StackWindow(id: 51, pid: 30, layer: 20, bounds: CGRect(x: 0, y: 0, width: 800, height: 600))
        let glass = StackWindow(id: 52, pid: 40, layer: 0, bounds: CGRect(x: 0, y: 0, width: 800, height: 600), alpha: 0)
        XCTAssertTrue(visible(CGPoint(x: 100, y: 100), [mirror, ownOrdinary, menuBar, dock, glass]))
        // Nothing above at all: visible.
        XCTAssertTrue(visible(CGPoint(x: 100, y: 100), []))
    }

    /// Apps draw parts of themselves as separate windows over their main one (Terminal's tab strip, a browser's status
    /// bar, a sheet); those are the target, not something in front of it. A second window of the same app is not.
    func testTheTargetAppsOwnAttachmentsNeverHideItsCursor() {
        let me: pid_t = 99, app: pid_t = 70
        let target = CGRect(x: 0, y: 69, width: 1512, height: 913)
        func covering(_ p: CGPoint, _ above: [StackWindow]) -> StackWindow? {
            CursorOcclusion.coveringWindow(at: p, above: above, ownPID: me, targetPID: app, targetFrame: target)
        }
        // Measured on this Mac: Terminal's tab strip, a layer-0 window of its own straddling the main window's top.
        let tabStrip = StackWindow(id: 74975, pid: app, layer: 0, bounds: CGRect(x: 0, y: 33, width: 1512, height: 68))
        let statusBar = StackWindow(id: 2, pid: app, layer: 0, bounds: CGRect(x: 0, y: 966, width: 653, height: 16))
        let sheet = StackWindow(id: 3, pid: app, layer: 0, bounds: CGRect(x: 456, y: 69, width: 600, height: 400))
        let popover = StackWindow(id: 4, pid: app, layer: 0, bounds: CGRect(x: 1300, y: 120, width: 240, height: 300))
        XCTAssertNil(covering(CGPoint(x: 300, y: 90), [tabStrip]), "the tab strip is part of the target")
        XCTAssertNil(covering(CGPoint(x: 100, y: 970), [statusBar]))
        XCTAssertNil(covering(CGPoint(x: 700, y: 200), [sheet]))
        XCTAssertNil(covering(CGPoint(x: 1400, y: 200), [popover]), "a popover may overhang the window a little")
        // A second window of the same app, in front of the target, does cover it.
        let sibling = StackWindow(id: 5, pid: app, layer: 0, bounds: CGRect(x: 30, y: 98, width: 1512, height: 913))
        XCTAssertEqual(covering(CGPoint(x: 700, y: 500), [tabStrip, sibling])?.id, 5)
        let offsetSibling = StackWindow(id: 6, pid: app, layer: 0, bounds: CGRect(x: 600, y: 300, width: 1211, height: 824))
        XCTAssertEqual(covering(CGPoint(x: 900, y: 600), [offsetSibling])?.id, 6)
        // Another app's strip still counts: only the target's own attachments are exempt.
        let otherStrip = StackWindow(id: 7, pid: 20, layer: 0, bounds: CGRect(x: 0, y: 33, width: 1512, height: 68))
        XCTAssertEqual(covering(CGPoint(x: 300, y: 90), [otherStrip])?.id, 7)
    }

    /// A window the batch description leaves out is asked about on its own, so it never reads as gone.
    func testDescribeFallsBackToOneWindowAtATime() {
        let a = StackWindow(id: 1, pid: 10, layer: 0, bounds: CGRect(x: 0, y: 0, width: 10, height: 10))
        let b = StackWindow(id: 2, pid: 10, layer: 0, bounds: CGRect(x: 5, y: 5, width: 10, height: 10))
        var singles: [CGWindowID] = []
        let found = SystemWindowServer.describe([1, 2, 3], batch: { _ in [a] }, single: { id in
            singles.append(id)
            return id == 2 ? b : nil
        })
        XCTAssertEqual(found, [a, b], "3 is really gone")
        XCTAssertEqual(singles, [2, 3])
        XCTAssertEqual(SystemWindowServer.describe([1], batch: { _ in [a] }, single: { _ in XCTFail(); return nil }), [a])
        XCTAssertEqual(SystemWindowServer.describe([], batch: { _ in XCTFail(); return [] }, single: { _ in nil }), [])
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
