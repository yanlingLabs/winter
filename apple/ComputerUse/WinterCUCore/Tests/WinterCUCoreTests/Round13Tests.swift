import ApplicationServices
import CoreGraphics
import XCTest
@testable import WinterCUCore

/// Round 13 — the store agent's dogfood on the real Chrome Web Store upload (helper 1.10.0).
final class Round13Tests: XCTestCase {
    private func axWindow(_ id: UInt32, _ title: String, standard: Bool = true) -> CUAXWindow {
        CUAXWindow(element: fakeElement(Int32(61_000 + Int(id))), id: id, title: title, frame: CGRect(x: 0, y: 0, width: 800, height: 600),
                   focused: false, main: false, standard: standard)
    }

    /// Item 4: a bind by the page's title takes the page's own window, never Chrome's find bar ("Find in page ⏎ <title>").
    func testATitleBindPrefersAnExactTitleOnAStandardWindow() {
        let findBar = axWindow(5, "Find in page\n Chrome Web Store Developer Dashboard", standard: false)
        let page = axWindow(6, "Chrome Web Store Developer Dashboard")
        XCTAssertEqual(CUAXWindows.titleMatch([findBar, page], "Chrome Web Store Developer Dashboard")?.id, 6)
        // Only partial matches: a standard window before a utility one.
        let longer = axWindow(7, "Chrome Web Store Developer Dashboard - Item")
        XCTAssertEqual(CUAXWindows.titleMatch([findBar, longer], "Developer Dashboard")?.id, 7)
    }

    /// Item 4, off this desktop: a window here whose title only CONTAINS the one asked for never beats the window
    /// elsewhere whose title IS it.
    func testAnOffDesktopExactTitleBeatsAPartialMatchHere() throws {
        let original = fakeElement(61_100)
        let fx = CUWindowResolver.Effects(
            remote: { ids in ids.contains(40) ? [40: original] : [:] },
            describe: { e, s in CUAXWindow(element: e, id: s.id, title: s.title, frame: s.frame, focused: false, main: false) },
            moveToActiveSpace: { _ in false }, axWindows: { [] }, wait: { $0() }, appElement: fakeElement(61_101))
        var there = CUWindowServerWindow(id: 40, pid: 9, ownerName: "Google Chrome", title: "Chrome Web Store Developer Dashboard",
                                         frame: CGRect(x: 0, y: 0, width: 1200, height: 900), layer: 0, onScreen: false, alpha: 1)
        there.onScreen = false
        let findBar = axWindow(5, "Find in page\n Chrome Web Store Developer Dashboard", standard: false)
        let out = try CUWindowResolver.resolve(appName: "Google Chrome", axWindows: [findBar], server: [there],
                                               selector: .title("Chrome Web Store Developer Dashboard"), privatePath: true, fx)
        XCTAssertEqual(out.window.id, 40)
    }
}
