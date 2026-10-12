import ApplicationServices
import CoreGraphics
import XCTest
@testable import WinterCUCore

/// Round 18's guardian work, the engine side: R17-d (the controller's ruling) wired through the session tap's own
/// events — (i) only input that can launch an app between the agent's act and the process start makes the launch the
/// user's, (ii) an interactive launcher's Return or click before the start does too.
final class Round18GuardianTests: XCTestCase {
    private func guardedCore(_ sys: FakeSystem) -> CUCore {
        let core = CUCore(events: nil, clock: CUSystemClock(), skyLight: .none, poster: RecordingPoster(), ax: FakeAX(), sys: sys,
                          pasteboard: { PasteAndQueueTests.FakePasteboard([]) }, startMonitors: false)
        core.secureInputOverride = false
        return core
    }

    /// The agent's opener act at 10.0, then `input` (around 10.1), the process starting at 10.2 and coming forward: the
    /// verdict the guardian gives it.
    private func launch(_ sys: FakeSystem = FakeSystem(), _ input: (CUCore) -> Void) -> CUMoveOwner {
        sys.running.formUnion([1, 88])
        sys.front = 1
        let core = guardedCore(sys)
        core.guardianLock.withLock {
            core.guardianCore.begin(view: CUGuardedView(app: 1, space: 100))
            core.guardianCore.noteCause(500, now: 10.0)
            core.guardianCore.noteOpenerCause(now: 10.0, scope: .apps(["com.apple.Safari"]))
        }
        input(core)
        return core.guardianLock.withLock { () -> CUMoveOwner in
            core.guardianCore.appLaunched(88, startedAt: 10.2, bundle: "us.zoom.xos", now: 10.25)
            return core.guardianCore.judge(CUMoveQuery(app: 88, space: 100, appBundle: "us.zoom.xos"), now: 11.0)
        }
    }

    /// R17-d (i): the launch rule's (1) reads LAUNCH-CAPABLE input of the user's between the act and the start (a click,
    /// Return/Enter, a chord with ⌘/⌃/⌥, a function key), never plain typing or a scroll — through the tap's own events.
    func testOnlyLaunchCapableInputBetweenTheActAndTheStartMakesALaunchTheirs() {
        let typed = launch { $0.noteTapEvent(type: .keyDown, sourcePid: 0, userData: 0, keycode: 0, now: 10.1) }
        XCTAssertFalse(typed.isUsers, "plain typing between is not their launch: \(typed)")
        let scrolled = launch { $0.noteTapEvent(type: .scrollWheel, sourcePid: 0, userData: 0, now: 10.1) }
        XCTAssertFalse(scrolled.isUsers, "nor a scroll: \(scrolled)")
        for (what, input) in [("a click", { (c: CUCore) in c.noteTapEvent(type: .leftMouseDown, sourcePid: 0, userData: 0, now: 10.1) }),
                              ("Return", { (c: CUCore) in c.noteTapEvent(type: .keyDown, sourcePid: 0, userData: 0, keycode: 36, now: 10.1) }),
                              ("a ⌘ chord", { (c: CUCore) in c.noteTapEvent(type: .keyDown, sourcePid: 0, userData: 0, flags: .maskCommand, keycode: 49, now: 10.1) }),
                              ("F5", { (c: CUCore) in c.noteTapEvent(type: .keyDown, sourcePid: 0, userData: 0, keycode: 96, now: 10.1) })] {
            let v = launch(FakeSystem(), input)
            XCTAssertTrue(v.isUsers, "\(what) between the act and the start: theirs — \(v)")
        }
        // (A synthetic event — the helper's, or another process's — is no input of the user's.)
        let posted = launch { $0.noteTapEvent(type: .leftMouseDown, sourcePid: 4242, userData: 0, now: 10.1) }
        XCTAssertFalse(posted.isUsers, "a posted click: \(posted)")
    }

    /// R17-d (ii): an INTERACTIVE LAUNCHER within the causal window before the start — Return into Spotlight's panel (the
    /// tap names the process it is delivered to), a click in the Dock that is not on a running app's tile (a tile that
    /// launches, Launchpad), a double-click in a Finder window — makes the launch theirs, even BEFORE the agent's act.
    func testAnInteractiveLaunchersInputBeforeTheStartMakesALaunchTheirs() {
        let spotlight: pid_t = 333, dock: pid_t = 99, finder: pid_t = 77
        // Return into Spotlight's panel at 9.95 — before the agent's act at 10.0, so (i) does not hold.
        let sys = FakeSystem()
        sys.bundles[spotlight] = "com.apple.Spotlight"
        let viaSpotlight = launch(sys) { _ in }  // (the baseline: no input, outside the act's reach — left and said)
        if case .unexplained = viaSpotlight {} else { XCTFail("no input at all: left and said — \(viaSpotlight)") }
        let s2 = FakeSystem()
        s2.bundles[spotlight] = "com.apple.Spotlight"
        let returned = launch(s2) { $0.noteTapEvent(type: .keyDown, sourcePid: 0, userData: 0, keycode: 36, targetPid: Int64(spotlight), now: 9.95) }
        XCTAssertTrue(returned.isUsers, "Return in Spotlight before the start: theirs — \(returned)")
        // The same Return into the app in front is no launcher (it is launch-capable, but before the act: not (i)).
        let s3 = FakeSystem()
        let inApp = launch(s3) { $0.noteTapEvent(type: .keyDown, sourcePid: 0, userData: 0, keycode: 36, targetPid: 1, now: 9.95) }
        XCTAssertFalse(inApp.isUsers, "Return into the app in front, before the act: not a launcher — \(inApp)")
        // A click in the Dock, not on a running app's tile.
        let s4 = FakeSystem()
        let bar = FakeSystem.window(900, pid: dock, CGRect(x: 0, y: 950, width: 1600, height: 50), owner: "Dock", layer: 20)
        s4.windows[900] = bar
        s4.stack = [bar]
        s4.dockTile = nil
        let docked = launch(s4) { c in
            c.guardianLock.withLock { c.guardianCore.noteHardwareAction(now: 7.0) }  // (long before: quiet stays as it was)
            _ = c.onPhysicalClick(at: CGPoint(x: 800, y: 975), userData: 0, now: 9.95)
        }
        XCTAssertTrue(docked.isUsers, "a click in the Dock that launches: theirs — \(docked)")
        // A double-click in a Finder window (and a single click is none).
        for count: Int64 in [1, 2] {
            let s5 = FakeSystem()
            s5.running.insert(finder)
            s5.bundles[finder] = "com.apple.finder"
            let w = FakeSystem.window(70, pid: finder, CGRect(x: 0, y: 40, width: 400, height: 300))
            s5.windows[70] = w
            s5.stack = [w]
            let v = launch(s5) { c in _ = c.onPhysicalClick(at: CGPoint(x: 100, y: 100), userData: 0, clickCount: count, now: 9.95) }
            XCTAssertEqual(v.isUsers, count == 2, "a \(count == 2 ? "double-" : "single ")click in Finder before the start — \(v)")
        }
    }
}
