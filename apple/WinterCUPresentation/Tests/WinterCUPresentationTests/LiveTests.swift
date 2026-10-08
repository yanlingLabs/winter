import CoreGraphics
import XCTest
@testable import WinterCUPresentation

/// Live checks against the real window server, ScreenCaptureKit and event tap. Skipped unless WINTER_CU_LIVE_TESTS=1:
/// they need the Accessibility and Screen Recording grants, install a real event tap and draw on screen. Run them only
/// by hand, on a machine whose user agreed.
@MainActor final class LiveTests: XCTestCase {
    override func setUp() async throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["WINTER_CU_LIVE_TESTS"] == "1",
                          "live presentation tests are opt-in (WINTER_CU_LIVE_TESTS=1)")
    }

    func testScreensAreReadInTopLeftSpace() {
        let screens = SystemWindowSource().screens()
        XCTAssertFalse(screens.isEmpty)
        XCTAssertEqual(screens.first?.frame.origin.y, 0, "the main screen's top edge is y = 0")
    }

    func testTheRealTapArmsAndDisarms() throws {
        let tap = EscapeTap(installer: CGEventTapInstaller(), clock: SystemClock())
        tap.setArmed(true)
        try XCTSkipUnless(tap.isActive, "no Accessibility grant: the tap could not be created")
        tap.setArmed(false)
        XCTAssertFalse(tap.isActive)
    }

    func testAMirrorOfTheFrontmostWindowAppearsAndCloses() throws {
        let infos = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
            as? [[String: Any]]) ?? []
        guard let info = infos.first(where: { ($0[kCGWindowLayer as String] as? NSNumber)?.intValue == 0 }),
              let id = (info[kCGWindowNumber as String] as? NSNumber)?.uint32Value,
              let pid = (info[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value
        else { throw XCTSkip("no normal window on screen") }
        let (presentation, _) = WinterCUPresentationFactory.make()
        let target = CUWindowRef(pid: pid, windowID: id, appName: info[kCGWindowOwnerName as String] as? String ?? "?")
        presentation.showMirror(sessionId: "live", target: target)
        RunLoop.main.run(until: Date().addingTimeInterval(2))
        presentation.sessionEnded(sessionId: "live")
        RunLoop.main.run(until: Date().addingTimeInterval(0.6))
    }
}
