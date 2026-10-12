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

    /// The controller's round-18 ruling (the review of round 16's LOW, "used ignores scrolling"): a scroll in the window of
    /// an app LEFT in front is using it — their place, as typing in it is; a scroll over another app's window is not.
    func testAScrollInALeftAppsWindowMakesItTheirPlace() {
        for overItsWindow in [true, false] {
            let sys = FakeSystem()
            sys.running = [1, 88, 90]
            sys.front = 88
            let w88 = FakeSystem.window(880, pid: 88, CGRect(x: 0, y: 40, width: 400, height: 300))
            let w90 = FakeSystem.window(900, pid: 90, CGRect(x: 500, y: 40, width: 400, height: 300))
            sys.windows = [880: w88, 900: w90]
            sys.stack = [w88, w90]
            let core = guardedCore(sys)
            core.guardianLock.withLock {
                core.guardianCore.begin(view: CUGuardedView(app: 1, space: 100))
                core.guardianCore.noteCause(500, now: 10.0)
                core.guardianCore.noteOpenerCause(now: 10.0, scope: .apps(["com.apple.mail"]))
                core.guardianCore.appLaunched(88, startedAt: 10.2, bundle: "us.zoom.xos", now: 10.25)
                _ = core.guardianCore.judge(CUMoveQuery(app: 88, space: 100, appBundle: "us.zoom.xos"), now: 11.0)
            }
            XCTAssertEqual(core.guardianPlace()?.app, 1, "left in front, not adopted")
            XCTAssertTrue(core.guardianLock.withLock { core.guardianCore.isLeftInFront(88) })
            core.noteTapEvent(type: .scrollWheel, sourcePid: 0, userData: 0, location: overItsWindow ? CGPoint(x: 100, y: 100) : CGPoint(x: 600, y: 100), now: 12.0)
            XCTAssertEqual(core.guardianPlace()?.app, overItsWindow ? 88 : 1,
                           overItsWindow ? "a scroll in its window: their place" : "a scroll over another app's window: not")
        }
    }

    /// I6's pending click mark (round 18, found by the model-based test's mid-act click — round 17's H1 exercised): a click
    /// into T's window while another app is in front is work once T's own activation lands. Another app's activation heard
    /// before T's, with no switch input of theirs since the click, is the landing of input from BEFORE it — the mark
    /// stays; a switch input after the click ends it; and T's own activation heard once another app is in front spends it.
    func testAPendingClickMarkFollowsTheOrderOfTheUsersInput() {
        let u: pid_t = 1, t: pid_t = 5252, s: pid_t = 710
        func core() -> CUFocusGuardianCore {
            var g = CUFocusGuardianCore()
            g.begin(view: CUGuardedView(app: u, space: 100))
            g.userInteracted(t, front: u, now: 10.0)  // their click into T's window, U in front
            return g
        }
        var a = core()
        a.otherAppActivated(s, front: s, now: 10.005)  // S lands — their Dock click from before the click into T
        XCTAssertTrue(a.userIsWorking(in: t, front: t, now: 10.01), "T lands after: working in T")
        var b = core()
        b.noteSwitch(now: 10.003, .app)  // a switch input of theirs after the click
        b.otherAppActivated(s, front: s, now: 10.005)
        XCTAssertFalse(b.userIsWorking(in: t, front: t, now: 10.01), "they switched on after the click: no work in T")
        var c = core()
        c.otherAppActivated(t, front: s, now: 10.02)  // T's own activation, heard with S in front already
        XCTAssertFalse(c.userIsWorking(in: t, front: t, now: 10.5), "the click's mark is spent: a later return to T is no work")
    }

    /// R17-d (ii) as R18-a rules it (the review of round 18, H1 — this test asserted the over-approximation as correct): an
    /// INTERACTIVE LAUNCHER makes the launch theirs only when its destination LAUNCHES — Return into Spotlight's panel, a
    /// Dock tile of an app not running, a Finder double-click on an app or a document — and only AFTER the agent's act
    /// and before the start. The Trash, a folder, an unreadable tile, a single click, or a launcher before the act: none.
    func testOnlyALaunchingDestinationAfterTheActIsAnInteractiveLauncher() {
        let spotlight: pid_t = 333, dock: pid_t = 99, finder: pid_t = 77
        let base = launch(FakeSystem()) { _ in }  // no input, outside the act's reach: left and said
        if case .unexplained = base {} else { XCTFail("no input at all: left and said — \(base)") }
        // Spotlight's Return (not via the tap's launch-capable path: the launcher fact alone).
        for (at, theirs) in [(10.1, true), (9.95, false)] {
            let sys = FakeSystem()
            sys.bundles[spotlight] = "com.apple.Spotlight"
            let v = launch(sys) { c in c.guardianLock.withLock { c.guardianCore.noteLauncherInput(now: at) } }
            XCTAssertEqual(v.isUsers, theirs, "a launcher at \(at) (the act at 10.0): \(v)")
        }
        // The tap's Return into Spotlight's panel after the act: theirs.
        let s2 = FakeSystem()
        s2.bundles[spotlight] = "com.apple.Spotlight"
        XCTAssertTrue(launch(s2) { $0.noteTapEvent(type: .keyDown, sourcePid: 0, userData: 0, keycode: 36, targetPid: Int64(spotlight), now: 10.1) }.isUsers)
        // The Dock where no running app's tile is: a launching tile, the Trash, an unreadable tile.
        for (launches, theirs) in [(Optional(true), true), (Optional(false), false), (nil, false)] as [(Bool?, Bool)] {
            let s4 = FakeSystem()
            let bar = FakeSystem.window(900, pid: dock, CGRect(x: 0, y: 950, width: 1600, height: 50), owner: "Dock", layer: 20)
            s4.windows[900] = bar
            s4.stack = [bar]
            s4.dockTile = nil
            s4.dockLaunches = launches
            let v = launch(s4) { c in _ = c.onPhysicalClick(at: CGPoint(x: 800, y: 975), userData: 0, now: 10.1) }
            XCTAssertEqual(v.isUsers, theirs, "a Dock click (launches: \(String(describing: launches))): \(v)")
        }
        // Finder: a double-click on an app or document; on a folder; unreadable; a single click.
        for (count, launches, theirs) in [(Int64(2), Optional(true), true), (2, Optional(false), false), (2, nil, false), (1, Optional(true), false)] as [(Int64, Bool?, Bool)] {
            let s5 = FakeSystem()
            s5.running.insert(finder)
            s5.bundles[finder] = "com.apple.finder"
            s5.finderLaunches = launches
            let w = FakeSystem.window(70, pid: finder, CGRect(x: 0, y: 40, width: 400, height: 300))
            s5.windows[70] = w
            s5.stack = [w]
            let v = launch(s5) { c in _ = c.onPhysicalClick(at: CGPoint(x: 100, y: 100), userData: 0, clickCount: count, now: 10.1) }
            XCTAssertEqual(v.isUsers, theirs, "a \(count)-click in Finder (launches: \(String(describing: launches))): \(v)")
        }
    }
}
