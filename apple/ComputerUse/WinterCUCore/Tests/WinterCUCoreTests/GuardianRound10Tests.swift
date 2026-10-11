import ApplicationServices
import CoreGraphics
import XCTest
@testable import WinterCUCore

/// Round 10: the user's rulings from the hands-on test and the reviewer's findings on round 9 — one directed test each.
final class GuardianRound10Tests: XCTestCase {
    /// The user WORKING in an app (a click, key or scroll in its window while it is in front) makes the agent hands-off it
    /// until it leaves the front; switching there to look does not; a click into a background window counts once its own
    /// activation lands (a drag out of one activates nothing).
    func testHandsOffWhileTheUserWorksInTheApp() {
        var g = CUFocusGuardianCore()
        g.begin(view: CUGuardedView(app: 1, space: 100))
        XCTAssertFalse(g.userIsWorking(in: 500, front: 500, now: 1), "only switched there")
        g.userInteracted(500, front: 500, now: 1.1)
        XCTAssertTrue(g.userIsWorking(in: 500, front: 500, now: 1.2))
        XCTAssertFalse(g.userIsWorking(in: 77, front: 500, now: 1.2), "another app")
        XCTAssertFalse(g.userIsWorking(in: 500, front: 1, now: 2), "they left it")
        XCTAssertFalse(g.userIsWorking(in: 500, front: 500, now: 3), "back to look: not until they interact anew")
        // A click into its window while another app is in front: theirs once it comes forward within the click's window.
        g.userInteracted(500, front: 1, now: 4)
        XCTAssertFalse(g.userIsWorking(in: 500, front: 1, now: 4.05))
        XCTAssertTrue(g.userIsWorking(in: 500, front: 500, now: 4.1))
        // A drag out of a background window: it never came forward — no work in it, even if they switch there later.
        var h = CUFocusGuardianCore()
        h.begin(view: CUGuardedView(app: 1, space: 100))
        h.userInteracted(500, front: 1, now: 5)
        XCTAssertFalse(h.userIsWorking(in: 500, front: 500, now: 6), "switched there 1 s after a drag: only looking")
    }

    /// The engine's wiring: a key the tap sees while the bound target is in front refuses the next act on it at once
    /// (typed `refused`, reason `user_working`); a ⌘-Tab's Tab is no work; once another app is in front, acts go again.
    func testAKeyInTheFrontTargetRefusesTheNextAct() async throws {
        let sys = FakeSystem()
        sys.running = [1, 500]; sys.front = 500; sys.space = 100
        sys.windows[77] = FakeSystem.window(77, pid: 500, CGRect(x: 500, y: 0, width: 400, height: 300))
        sys.stack = [sys.windows[77]!]
        let core = CUCore(events: nil, clock: CUSystemClock(), skyLight: .none, poster: RecordingPoster(), ax: FakeAX(), sys: sys,
                          pasteboard: { PasteAndQueueTests.FakePasteboard([]) }, startMonitors: false)
        let t = CUTarget(id: "t1", sessionId: "s", pid: 500, bundleId: "com.apple.finder", appName: "Finder",
                         isChromium: false, mirror: false, windowID: 77, windowTitle: "")
        core.registerForTesting(t, windowElement: nil)
        core.switchInputObservableOverride = true
        XCTAssertTrue(core.startGuardian(privatePath: true))
        defer { core.stopGuardian() }
        let now = core.clock.nowSeconds()
        core.noteTapEvent(type: .keyDown, sourcePid: 0, userData: 0, flags: .maskCommand, keycode: 48, now: now)  // ⌘-Tab's Tab
        core.noteTapEvent(type: .keyDown, sourcePid: 0, userData: 0, flags: .maskCommand, keycode: 49, now: now)  // ⌘-Space
        XCTAssertNoThrow(try core.refuseWhileUserWorks(t), "a ⌘ chord (a switch, Spotlight) is no work in the app")
        core.noteTapEvent(type: .keyDown, sourcePid: 0, userData: 0, keycode: 0, now: now)
        do {
            _ = try await core.targetAct(TargetActParams(targetId: "t1", sessionId: "s", callId: "c", action: .key(CUKeyAction(combo: "a")),
                                                         access: .full, allowForeground: false, privatePath: true))
            XCTFail("refused while the user works in it")
        } catch let e as CUError {
            XCTAssertEqual(e.code, "refused")
            XCTAssertEqual(e.data?["reason"], .string("user_working"))
            XCTAssertTrue(e.message.contains("the user is working in Finder right now"), e.message)
        }
        sys.front = 1
        XCTAssertNoThrow(try core.refuseWhileUserWorks(t), "they left it")
    }
}
