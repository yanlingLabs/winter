import ApplicationServices
import CoreGraphics
import XCTest
@testable import WinterCUCore

/// Round 17's guardian rulings, the engine side: R17-a (Secure Event Input sampled on every tap event) and R17-b (a click
/// on the front app's Dock tile).
final class Round17GuardianTests: XCTestCase {
    private func guardedCore(_ sys: FakeSystem) -> CUCore {
        CUCore(events: nil, clock: CUSystemClock(), skyLight: .none, poster: RecordingPoster(), ax: FakeAX(), sys: sys,
               pasteboard: { PasteAndQueueTests.FakePasteboard([]) }, startMonitors: false)
    }

    /// R17-b (the controller's ruling; seed 1020): a click on the FRONT app's Dock tile makes it the user's place AT THE
    /// CLICK, as a click into its window does — no activation will come to claim it. A tile of an app NOT in front stays a
    /// claim (its activation decides).
    func testAClickOnTheFrontAppsDockTileIsTheirPlaceAtTheClick() {
        let user: pid_t = 1, t: pid_t = 5454, dock: pid_t = 99
        for frontIsTile in [true, false] {
            let sys = FakeSystem()
            sys.running = [user, t, dock]
            sys.front = frontIsTile ? t : user
            let bar = FakeSystem.window(900, pid: dock, CGRect(x: 0, y: 950, width: 1600, height: 50), owner: "Dock", layer: 20)
            sys.windows[900] = bar
            sys.stack = [bar]
            sys.dockTile = t
            let core = guardedCore(sys)
            core.guardianLock.withLock { core.guardianCore.begin(view: CUGuardedView(app: user, space: 1)) }
            XCTAssertEqual(core.onPhysicalClick(at: CGPoint(x: 800, y: 975), userData: 0, now: 100), t)
            XCTAssertEqual(core.guardianPlace()?.app, frontIsTile ? t : user,
                           frontIsTile ? "the front app's tile: their place at the click" : "another app's tile: claimed, not yet their place")
        }
    }

    /// R17-a (the user's ruling, the engine side): Secure Event Input is read on every session-tap event, so a password
    /// field's span with no change of the front app is known — on at any moment of the quiet window, never quiet.
    func testSecureEventInputIsSampledOnEveryTapEvent() {
        let sys = FakeSystem()
        sys.running = [1]
        sys.front = 1
        let core = guardedCore(sys)
        core.secureInputOverride = true
        core.noteTapEvent(type: .mouseMoved, sourcePid: 0, userData: 0, now: 100)
        core.secureInputOverride = false
        core.noteTapEvent(type: .mouseMoved, sourcePid: 0, userData: 0, now: 100.5)
        XCTAssertTrue(core.guardianLock.withLock { core.guardianCore.secureInputMaybeOn(from: 101 - 2.5, to: 101) },
                      "on within the window (no judgment read it)")
        XCTAssertFalse(core.guardianLock.withLock { core.guardianCore.secureInputMaybeOn(from: 104 - 2.5, to: 104) },
                       "off for the whole window later")
    }
}
