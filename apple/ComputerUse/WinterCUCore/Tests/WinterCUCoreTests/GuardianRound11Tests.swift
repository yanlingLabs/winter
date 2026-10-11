import CoreGraphics
import XCTest
@testable import WinterCUCore

/// Round 11 — the review of round 10: an app the agent's own action cold-launches is not the user's launch (HIGH #1),
/// a system dialog started on demand never is (MEDIUM #2), the user's work in an app does not survive a guard's stop
/// (MEDIUM #4), and "clearly the agent's" reads only the facts from before the moment it judges (MEDIUM #8).
final class GuardianRound11Tests: XCTestCase {
    /// The agent presses a link at 20 s; the browser it opens was not running: its process starts at 20.4 s and it comes
    /// forward at 23 s — past the causal window, with no key or click of the user's since: the agent's, sent back.
    func testAnAppTheAgentsActionColdLaunchesIsNotTheUsersLaunch() {
        var g = CUFocusGuardianCore()
        g.begin(view: CUGuardedView(app: 1, space: 100))
        g.noteCause(500, now: 20)
        g.noteOpenerCause(now: 20)
        g.appLaunched(900, startedAt: 20.4, now: 20.45)
        let o = g.judge(CUMoveQuery(app: 900, space: 100, appStartedAt: 20.4), now: 23)
        XCTAssertFalse(o.isUsers, "\(o)")
        XCTAssertTrue(o.undoes, "the agent's indirect effect: \(o)")
    }

    /// The same when the launch notice was never heard: judged from the process start the query reads.
    func testTheColdLaunchIsJudgedAtItsStartWithoutTheLaunchNoticeToo() {
        var g = CUFocusGuardianCore()
        g.begin(view: CUGuardedView(app: 1, space: 100))
        g.noteCause(500, now: 20)
        g.noteOpenerCause(now: 20)
        let o = g.judge(CUMoveQuery(app: 901, space: 100, appStartedAt: 20.4), now: 23)
        XCTAssertTrue(o.undoes, "\(o)")
    }

    /// A key of the user's after the start: no longer clearly the agent's — never sent back.
    func testInputOfTheUsersSinceTheStartLeavesIt() {
        var g = CUFocusGuardianCore()
        g.begin(view: CUGuardedView(app: 1, space: 100))
        g.noteCause(500, now: 20)
        g.noteOpenerCause(now: 20)
        g.appLaunched(902, startedAt: 20.4, now: 20.45)
        g.noteHardwareAction(now: 21)
        let o = g.judge(CUMoveQuery(app: 902, space: 100, appStartedAt: 20.4, hardwareAt: 21), now: 23)
        XCTAssertFalse(o.undoes, "\(o)")
    }

    /// Their own launch (a key 1 s before the start — Spotlight's Return), even right after an opener act: theirs.
    func testTheirOwnLaunchStaysTheirsAfterAnOpenerAct() {
        var g = CUFocusGuardianCore()
        g.begin(view: CUGuardedView(app: 1, space: 100))
        g.noteHardwareAction(now: 19.4)
        g.noteCause(500, now: 20)
        g.noteOpenerCause(now: 20)
        g.appLaunched(903, startedAt: 20.4, now: 20.45)
        let o = g.judge(CUMoveQuery(app: 903, space: 100, appStartedAt: 20.4, hardwareAt: 19.4), now: 23)
        XCTAssertTrue(o.isUsers, "\(o)")
    }

    /// A system dialog started on demand (SecurityAgent, CoreServicesUIAgent): never the user's own launch — left for
    /// them to answer, never adopted as their place.
    func testASystemDialogStartedOnDemandIsNeverTheUsersLaunch() {
        var g = CUFocusGuardianCore()
        g.begin(view: CUGuardedView(app: 1, space: 100))
        g.noteCause(500, now: 20)
        g.noteOpenerCause(now: 20)
        g.appLaunched(904, startedAt: 20.1, now: 20.15)
        let o = g.judge(CUMoveQuery(app: 904, space: 100, appStartedAt: 20.1, appIsSystemUI: true), now: 20.6)
        XCTAssertFalse(o.isUsers, "\(o)")
        XCTAssertFalse(o.undoes, "a system dialog is left for the user to answer: \(o)")
    }

    /// Review of round 11, MEDIUM #6: the user's work in an app OUTLASTS the guard (a user still typing in it when the next
    /// script begins is still working there); another app activating ends it, guarding or not.
    func testTheUsersWorkOutlastsTheGuardUntilAnotherAppActivates() {
        var g = CUFocusGuardianCore()
        g.begin(view: CUGuardedView(app: 7, space: 100))
        g.userInteracted(7, front: 7, now: 10)
        g.end()
        g.begin(view: CUGuardedView(app: 7, space: 100))
        XCTAssertTrue(g.userIsWorking(in: 7, front: 7, now: 30), "still in it, after a pause between scripts")
        g.otherAppActivated(7)
        XCTAssertTrue(g.userIsWorking(in: 7, front: 7, now: 31), "its own activation ends nothing")
        g.end()
        g.otherAppActivated(8)  // between scripts: they went to another app
        g.begin(view: CUGuardedView(app: 7, space: 100))
        XCTAssertFalse(g.userIsWorking(in: 7, front: 7, now: 60), "back to look: not until they interact anew")
    }

    /// "Clearly" at a moment reads only the opener acts and launches from before it.
    func testClearlyReadsOnlyTheFactsFromBeforeTheMoment() {
        var g = CUFocusGuardianCore()
        g.noteOpenerCause(now: 10)
        g.noteOpenerCause(now: 30)
        XCTAssertTrue(g.clearlyAt(10.5, hardwareAt: nil))
        XCTAssertFalse(g.clearlyAt(29, hardwareAt: nil), "the act at 30 came after")
        _ = g.beginLaunch(now: 40)
        XCTAssertFalse(g.clearlyAt(39, hardwareAt: nil), "the launch began after")
        XCTAssertTrue(g.clearlyAt(40.5, hardwareAt: nil))
    }

    /// A key the window server delivers to ANOTHER process — Spotlight's or a launcher's panel, the emoji picker, a
    /// menu-bar item's popover — is no work in the bound app in front; nor ⌥-Space or Escape. A key it delivers to the
    /// bound app (or none named) is.
    func testOnlyAKeyTheBoundAppReceivesIsWorkInIt() throws {
        let sys = FakeSystem()
        sys.running = [1, 500, 610]; sys.front = 500; sys.space = 100
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
        core.noteTapEvent(type: .keyDown, sourcePid: 0, userData: 0, keycode: 0, targetPid: 610, now: now)  // into Spotlight's panel
        core.noteTapEvent(type: .keyDown, sourcePid: 0, userData: 0, flags: .maskAlternate, keycode: 49, now: now)  // ⌥-Space
        core.noteTapEvent(type: .keyDown, sourcePid: 0, userData: 0, keycode: 53, now: now)  // Escape
        XCTAssertNoThrow(try core.refuseWhileUserWorks(t))
        core.noteTapEvent(type: .keyDown, sourcePid: 0, userData: 0, keycode: 0, targetPid: 500, now: now)
        XCTAssertThrowsError(try core.refuseWhileUserWorks(t))
    }

    /// Review of round 11, HIGH #2: a process that is NOT part of the front app — Spotlight's or a launcher's panel, an
    /// accessory or agent process of its own — never counts as the app receiving the key; a true part of it does (its
    /// renderer, its WebContent). Decided like the live check, from the process facts.
    func testAKeyIntoAnAccessoryProcessIsNoWorkButOneIntoAPartOfTheAppIs() throws {
        let sys = FakeSystem()
        sys.running = [1, 500]; sys.front = 500; sys.space = 100
        sys.windows[77] = FakeSystem.window(77, pid: 500, CGRect(x: 500, y: 0, width: 400, height: 300))
        sys.stack = [sys.windows[77]!]
        sys.appBundles[500] = "/Applications/Google Chrome.app"
        sys.processFacts[811] = (responsible: 811, parent: nil, executable: "/System/Library/CoreServices/Spotlight.app/Contents/MacOS/Spotlight")
        sys.processFacts[900] = (responsible: 996, parent: 500, executable: "/Applications/Google Chrome.app/Contents/Frameworks/Helpers/Renderer")
        let core = CUCore(events: nil, clock: CUSystemClock(), skyLight: .none, poster: RecordingPoster(), ax: FakeAX(), sys: sys,
                          pasteboard: { PasteAndQueueTests.FakePasteboard([]) }, startMonitors: false)
        let t = CUTarget(id: "t1", sessionId: "s", pid: 500, bundleId: "com.google.Chrome", appName: "Google Chrome",
                         isChromium: true, mirror: false, windowID: 77, windowTitle: "")
        core.registerForTesting(t, windowElement: nil)
        core.switchInputObservableOverride = true
        XCTAssertTrue(core.startGuardian(privatePath: true))
        defer { core.stopGuardian() }
        let now = core.clock.nowSeconds()
        core.noteTapEvent(type: .keyDown, sourcePid: 0, userData: 0, keycode: 0, targetPid: 811, now: now)  // Spotlight's panel
        XCTAssertNoThrow(try core.refuseWhileUserWorks(t))
        core.noteTapEvent(type: .keyDown, sourcePid: 0, userData: 0, keycode: 0, targetPid: 900, now: now)  // its renderer
        XCTAssertThrowsError(try core.refuseWhileUserWorks(t))
        // The pure rule: a bundle path is a prefix only at a path boundary.
        XCTAssertFalse(CUProcessFacts.isPart(5, of: 4, responsible: 5, parent: nil, executable: "/Applications/Google Chrome.app2/x",
                                             appBundle: "/Applications/Google Chrome.app"))
        XCTAssertTrue(CUProcessFacts.isPart(5, of: 4, responsible: 5, parent: nil, executable: "/Applications/Google Chrome.app/Contents/x",
                                            appBundle: "/Applications/Google Chrome.app"))
    }

    /// Review of round 11, LOW #10: a launch notice heard long after the process started judges nothing clearly (the facts
    /// from then are gone) — the launch is not taken for the agent's.
    func testALateLaunchNoticeJudgesNothingClearly() {
        var g = CUFocusGuardianCore()
        g.begin(view: CUGuardedView(app: 1, space: 100))
        g.noteCause(500, now: 20)
        g.noteOpenerCause(now: 20)
        g.appLaunched(905, startedAt: 20.4, now: 40)  // heard 19.6 s after the start
        XCTAssertFalse(g.judge(CUMoveQuery(app: 905, space: 100, appStartedAt: 20.4), now: 41).undoes)
    }
}
