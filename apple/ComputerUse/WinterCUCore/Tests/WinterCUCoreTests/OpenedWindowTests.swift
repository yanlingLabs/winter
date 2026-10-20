import ApplicationServices
import CoreGraphics
import XCTest
@testable import WinterCUCore

/// Live 2026-10-20: opening a URL in Chrome, Chrome made a window (187200) for a moment, then showed the URL as a tab of an
/// existing window (187195) and closed it — the open answered 187200 and the bind failed "this app has no window 187200",
/// though the URL had opened. The window an open finds is looked at again: gone or not a document window → the main one.
final class OpenedWindowTests: XCTestCase {
    let pid: pid_t = 6161
    let mainWindow = fakeElement(99_001)
    let newWindow = fakeElement(99_002)

    var ax: FakeAX!
    var sys: FakeSystem!
    var core: CUCore!

    private func world(newSubrole: String = kAXStandardWindowSubrole, newOnServer: Bool = true) {
        ax = FakeAX()
        let app = ax.application(pid)
        ax.put(app, [kAXWindowsAttribute: newOnServer ? [newWindow, mainWindow] : [mainWindow], kAXMainWindowAttribute: mainWindow])
        ax.add(mainWindow, role: kAXWindowRole, subrole: kAXStandardWindowSubrole, title: "Inbox", frame: CGRect(x: 0, y: 0, width: 1000, height: 700))
        ax.windowIDs[AXIdentity(element: mainWindow)] = 187_195
        ax.add(newWindow, role: kAXWindowRole, subrole: newSubrole, title: "New", frame: CGRect(x: 40, y: 40, width: 1000, height: 700))
        ax.windowIDs[AXIdentity(element: newWindow)] = 187_200
        sys = FakeSystem()
        sys.running = [pid, 1]
        sys.windows[187_195] = FakeSystem.window(187_195, pid: pid, CGRect(x: 0, y: 0, width: 1000, height: 700), owner: "Google Chrome")
        if newOnServer {
            sys.windows[187_200] = FakeSystem.window(187_200, pid: pid, CGRect(x: 40, y: 40, width: 1000, height: 700), owner: "Google Chrome")
        }
        core = CUCore(events: nil, clock: CUSystemClock(), skyLight: .none, poster: RecordingPoster(), ax: ax, sys: sys,
                      pasteboard: { PasteAndQueueTests.FakePasteboard([]) }, startMonitors: false)
    }

    func testANewDocumentWindowStillThereIsTheOne() {
        world()
        XCTAssertEqual(core.confirmOpenedWindow(187_200, pid: pid), 187_200)
    }

    func testANewWindowAlreadyGoneGivesTheMainWindow() {
        world(newOnServer: false)
        XCTAssertEqual(core.confirmOpenedWindow(187_200, pid: pid), 187_195)
    }

    func testANewWindowThatIsNoDocumentWindowGivesTheMainWindow() {
        world(newSubrole: kAXFloatingWindowSubrole)
        XCTAssertEqual(core.confirmOpenedWindow(187_200, pid: pid), 187_195)
    }

    func testNoNewWindowGivesTheMainWindow() {
        world()
        XCTAssertEqual(core.confirmOpenedWindow(nil, pid: pid), 187_195)
    }
}
