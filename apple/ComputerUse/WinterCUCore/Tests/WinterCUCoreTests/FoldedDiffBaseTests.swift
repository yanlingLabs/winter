import ApplicationServices
import CoreGraphics
import XCTest
@testable import WinterCUCore

/// Review of round 2 (MEDIUM): a bind prints the viewport-first FOLDED state, and that print is the diff base — but
/// the diff compared every element the read saw, so a scroll that brought folded rows into view answered
/// "(no changes)", and a change under a fold printed as a context-free `~ [ref]`. Driven through `targetSnapshot`:
/// a 600 pt window whose scroll area holds 400 rows of 20 pt (past the 300-line fold).
final class FoldedDiffBaseTests: XCTestCase {
    let pid: pid_t = 6262
    let window = fakeElement(97_001)
    var core: CUCore!
    var offset = 0.0
    var v7 = "a"

    private func tree() -> [CUNode] {
        let rows = (0..<400).map { i in
            CUNode(ref: 100 + i, role: "AXTextField", name: "Row \(i)", value: i == 7 ? v7 : "x",
                   frame: CGRect(x: 10, y: 150 + Double(i) * 20 - offset, width: 300, height: 18))
        }
        return [CUNode(ref: 1, role: "AXWindow", name: "Doc", frame: CGRect(x: 0, y: 100, width: 400, height: 600), children: [
            CUNode(ref: 2, role: "AXScrollArea", frame: CGRect(x: 0, y: 140, width: 400, height: 560), children: [
                CUNode(ref: 3, role: "AXGroup", name: "List", frame: CGRect(x: 0, y: 150 - offset, width: 400, height: 8000), children: rows),
            ]),
        ])]
    }

    override func setUp() {
        let ax = FakeAX()
        ax.put(ax.application(pid), [kAXWindowsAttribute: [window]])
        ax.add(window, role: kAXWindowRole, title: "Doc", frame: CGRect(x: 0, y: 100, width: 400, height: 600))
        ax.windowIDs[AXIdentity(element: window)] = 70
        let sys = FakeSystem()
        sys.running = [pid]
        sys.bundles[pid] = "com.example.doc"
        sys.windows[70] = FakeSystem.window(70, pid: pid, CGRect(x: 0, y: 100, width: 400, height: 600))
        sys.stack = [sys.windows[70]!]
        sys.front = 1
        core = CUCore(events: nil, clock: CUSystemClock(), skyLight: .none, poster: RecordingPoster(), ax: ax, sys: sys,
                      pasteboard: { PasteAndQueueTests.FakePasteboard([]) }, startMonitors: false)
        core.stateReadOverride = { [unowned self] _ in tree() }
        let t = CUTarget(id: "t1", sessionId: "s", pid: pid, bundleId: "com.example.doc", appName: "Doc", isChromium: false,
                         mirror: false, windowID: 70, windowTitle: "Doc")
        core.registerForTesting(t, windowElement: window)
    }

    private func state(since: String? = nil) async throws -> TargetSnapshotResult {
        try await core.targetSnapshot(TargetSnapshotParams(targetId: "t1", since: since))
    }

    func testContentScrolledIntoViewAfterAFoldedBindIsSurfaced() async throws {
        let bound = try await state()
        XCTAssertTrue(bound.text.contains("more out of view"), "the bind's print is folded: \(bound.text)")
        XCTAssertFalse(bound.text.contains("\"Row 60\""))
        offset = 1000  // scrolled: rows ~45… in view now
        let after = try await state(since: bound.snapshotId)
        XCTAssertTrue(after.isDiff, after.text)
        XCTAssertFalse(after.text.contains("(no changes)"), after.text)
        XCTAssertTrue(after.text.contains("+ [160] text field \"Row 60\" value=\"x\" — now shown, in [3] group \"List\""), after.text)
        // Nothing changed since: the same view again is "(no changes)".
        let again = try await state(since: after.snapshotId)
        XCTAssertTrue(again.text.contains("(no changes)"), again.text)
    }

    func testAChangeUnderAFoldPrintsWithItsContext() async throws {
        offset = 1000  // row 7 is out of view from the start
        let bound = try await state()
        XCTAssertFalse(bound.text.contains("\"Row 7\""))
        v7 = "b"
        let after = try await state(since: bound.snapshotId)
        XCTAssertTrue(after.isDiff, after.text)
        XCTAssertTrue(after.text.contains("~ [107] value \"a\" → \"b\" — [107] text field \"Row 7\" value=\"b\", in [3] group \"List\""), after.text)
    }
}
