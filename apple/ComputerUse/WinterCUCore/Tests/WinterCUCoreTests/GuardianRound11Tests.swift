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

    /// Their own launch (a key 1 s before the start — Spotlight's Return) right after an opener act of the agent's: the
    /// engine can't tell it from the agent's own cold launch — left in front and said, NEVER adopted (review of round 14,
    /// HIGH #1; round 11 had it theirs).
    func testALaunchRightAfterAnOpenerActIsLeftAndSaid() {
        var g = CUFocusGuardianCore()
        g.begin(view: CUGuardedView(app: 1, space: 100))
        g.noteHardwareAction(now: 19.4)
        g.noteCause(500, now: 20)
        g.noteOpenerCause(now: 20)
        g.appLaunched(903, startedAt: 20.4, now: 20.45)
        let o = g.judge(CUMoveQuery(app: 903, space: 100, appStartedAt: 20.4, hardwareAt: 19.4), now: 23)
        if case .unexplained = o {} else { XCTFail("left in front and said: \(o)") }
        XCTAssertEqual(g.view.app, 1, "never adopted")
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
        g.otherAppActivated(7, front: 7, now: 31)
        XCTAssertTrue(g.userIsWorking(in: 7, front: 7, now: 31), "its own activation ends nothing")
        g.end()
        g.otherAppActivated(8, front: 8, now: 40)  // between scripts: they went to another app
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

    /// Round 10's MEDIUM #5 (the user's ruling), done in round 12: between scripts — no guardian — the work watcher sees
    /// the user's own key or click on a bound app in front, so the next script's act on it is refused; a synthetic event
    /// (another process's) is not theirs.
    func testTheWorkWatcherSeesWorkBetweenScripts() throws {
        let sys = FakeSystem()
        sys.running = [1, 500]; sys.front = 500; sys.space = 100
        sys.windows[77] = FakeSystem.window(77, pid: 500, CGRect(x: 500, y: 0, width: 400, height: 300))
        sys.stack = [sys.windows[77]!]
        let core = CUCore(events: nil, clock: CUSystemClock(), skyLight: .none, poster: RecordingPoster(), ax: FakeAX(), sys: sys,
                          pasteboard: { PasteAndQueueTests.FakePasteboard([]) }, startMonitors: false)
        let t = CUTarget(id: "t1", sessionId: "s", pid: 500, bundleId: "com.apple.finder", appName: "Finder",
                         isChromium: false, mirror: false, windowID: 77, windowTitle: "")
        core.registerForTesting(t, windowElement: nil)
        XCTAssertFalse(core.guardianRunning)
        core.noteWatchedEvent(type: .keyDown, sourcePid: 4242, userData: 0, flags: [], keycode: 0, location: .zero, targetPid: 500)
        XCTAssertNoThrow(try core.refuseWhileUserWorks(t), "another process's key is not theirs")
        core.noteWatchedEvent(type: .keyDown, sourcePid: 0, userData: 0, flags: [], keycode: 0, location: .zero, targetPid: 500)
        XCTAssertThrowsError(try core.refuseWhileUserWorks(t), "their key, between scripts")
        // Another app activates (the always-on observer): over.
        sys.front = 1
        core.appActivated(pid: 1)
        sys.front = 500
        XCTAssertNoThrow(try core.refuseWhileUserWorks(t))
        // Their click into the bound window, between scripts.
        core.noteWatchedEvent(type: .leftMouseDown, sourcePid: 0, userData: 0, flags: [], keycode: -1,
                              location: CGPoint(x: 600, y: 100), targetPid: 0)
        XCTAssertThrowsError(try core.refuseWhileUserWorks(t))
        XCTAssertEqual(CUCore.workWatcherMask & (CGEventMask(1) << CGEventMask(CGEventType.mouseMoved.rawValue)), 0, "no pointer moves")
    }

    /// Round 10's LOW #10: under Secure Event Input the tap sees no key — when the bound app in front holds it itself, the
    /// user is taken to be working in it; held by another app, nothing changes.
    func testSecureInputHeldByTheFrontBoundAppIsWork() throws {
        let sys = FakeSystem()
        sys.running = [1, 500]; sys.front = 500; sys.space = 100
        sys.windows[77] = FakeSystem.window(77, pid: 500, CGRect(x: 500, y: 0, width: 400, height: 300))
        let ax = FakeAX()
        let core = CUCore(events: nil, clock: CUSystemClock(), skyLight: .none, poster: RecordingPoster(), ax: ax, sys: sys,
                          pasteboard: { PasteAndQueueTests.FakePasteboard([]) }, startMonitors: false)
        let t = CUTarget(id: "t1", sessionId: "s", pid: 500, bundleId: "com.example.app", appName: "App",
                         isChromium: false, mirror: false, windowID: 77, windowTitle: "")
        core.registerForTesting(t, windowElement: nil)
        let text = fakeElement(97_500)
        ax.add(text, role: kAXTextAreaRole, extra: [kAXValueAttribute: "$ "])
        ax.focus(pid: 500, on: text)
        core.secureInputOverride = true
        core.secureInputOwnerOverride = 1
        XCTAssertNoThrow(try core.refuseWhileUserWorks(t), "another app holds it")
        core.secureInputOwnerOverride = 500
        // Review of round 12, MEDIUM #3: held by the app in front, but the user is only looking (Terminal's Secure
        // Keyboard Entry): nothing corroborates work — not refused.
        XCTAssertNoThrow(try core.refuseWhileUserWorks(t), "only looking")
        // Review of round 13, MEDIUM #6: hardware input a moment ago (the ⌘-Tab that brought it forward) is no work…
        core.noteHardwareInput(now: core.clock.nowSeconds(), move: false)
        XCTAssertNoThrow(try core.refuseWhileUserWorks(t), "a looker who just switched there")
        // …their TYPING is (the text changed since the agent last looked), and it holds while the app is in front.
        ax.put(text, [kAXValueAttribute: "$ ls -la"])
        XCTAssertThrowsError(try core.refuseWhileUserWorks(t))
        XCTAssertThrowsError(try core.refuseWhileUserWorks(t), "sticky")
        // What the agent's own act typed is never the user's: the base is refreshed at its end.
        sys.front = 1
        XCTAssertNoThrow(try core.refuseWhileUserWorks(t), "not in front")
    }

    /// The user's ruling (round 14): KEEP the safe side. Under Secure Keyboard Entry a bound front Terminal whose text
    /// changes — a command's streaming output as much as their typing — is the user working: the agent waits until
    /// Terminal leaves the front, and the refusal says why. A password field focused says so too.
    func testUnderSecureKeyboardEntryAChangingTerminalWaitsUntilItLeavesTheFront() throws {
        let sys = FakeSystem()
        sys.running = [1, 500]; sys.front = 500; sys.space = 100
        sys.windows[77] = FakeSystem.window(77, pid: 500, CGRect(x: 500, y: 0, width: 400, height: 300))
        let ax = FakeAX()
        let core = CUCore(events: nil, clock: CUSystemClock(), skyLight: .none, poster: RecordingPoster(), ax: ax, sys: sys,
                          pasteboard: { PasteAndQueueTests.FakePasteboard([]) }, startMonitors: false)
        let t = CUTarget(id: "t1", sessionId: "s", pid: 500, bundleId: "com.apple.Terminal", appName: "Terminal",
                         isChromium: false, mirror: false, windowID: 77, windowTitle: "")
        core.registerForTesting(t, windowElement: nil)
        let text = fakeElement(97_510)
        ax.add(text, role: kAXTextAreaRole, extra: [kAXValueAttribute: "$ make\n"])
        ax.focus(pid: 500, on: text)
        core.secureInputOverride = true
        core.secureInputOwnerOverride = 500
        XCTAssertNoThrow(try core.refuseWhileUserWorks(t), "only looking: nothing changed")
        // A command's output streams in, nobody typing: the same as their typing, by the ruling.
        ax.put(text, [kAXValueAttribute: "$ make\ncc -c main.c\n"])
        let sentence = "Terminal is in front with Secure Keyboard Entry on and its text is changing — Winter waits until you switch away"
        XCTAssertThrowsError(try core.refuseWhileUserWorks(t)) { e in
            XCTAssertEqual((e as? CUError)?.data?["reason"], .string("user_working"))
            XCTAssertEqual((e as? CUError)?.message, sentence)
        }
        // The output stops: it still waits while Terminal stays in front, with the same reason.
        ax.put(text, [kAXValueAttribute: "$ make\n"])
        XCTAssertThrowsError(try core.refuseWhileUserWorks(t)) { e in XCTAssertEqual((e as? CUError)?.message, sentence) }
        // Terminal leaves the front: the agent may act again; back in front with nothing changing, it does not wait.
        sys.front = 1
        XCTAssertNoThrow(try core.refuseWhileUserWorks(t))
        sys.front = 500
        XCTAssertNoThrow(try core.refuseWhileUserWorks(t), "back in front, nothing changed since")
        // A password field of it focused: its own sentence.
        let pw = fakeElement(97_511)
        ax.add(pw, role: kAXTextFieldRole, subrole: kAXSecureTextFieldSubrole)
        ax.focus(pid: 500, on: pw)
        XCTAssertThrowsError(try core.refuseWhileUserWorks(t)) { e in
            XCTAssertEqual((e as? CUError)?.message, "Terminal is in front with a password field focused (Secure Event Input) — Winter waits until you switch away")
        }
    }
}
