import ApplicationServices
import CoreGraphics
import XCTest
@testable import WinterCUCore

/// The continuous Focus Guardian: its attribution (user vs agent), restore plan, repeat detection, the one
/// exemption and Space handling — pure and tested — plus the live restore wired through CUCore's fakes.
final class FocusGuardianTests: XCTestCase {
    // MARK: the pure core

    private func started(app: pid_t = 1, space: UInt64 = 100) -> CUFocusGuardianCore {
        var g = CUFocusGuardianCore()
        g.begin(view: CUGuardedView(app: app, space: space))
        return g
    }

    func testAUserSwitchIsRespectedAndBecomesTheNewUserView() {
        var g = started()
        let v = g.handle(CUActivation(app: 42, space: 200, switchInput: true), now: 1)
        XCTAssertEqual(v, .userSwitch)
        XCTAssertEqual(g.view, CUGuardedView(app: 42, space: 200), "the user's own switch updates the tracked view")
        // A later theft now restores to 42/200, the user's new app and desktop.
        let t = g.handle(CUActivation(app: 99, space: 300, switchInput: false), now: 2)
        XCTAssertEqual(t, .theft(restore: CUGuardedView(app: 42, space: 200), thief: 99, repeatOffender: false))
    }

    func testAnActivationWithNoRecentInputIsTheftWhateverTheApp() {
        var g = started()
        // Our own synthetic activation is never the user's by itself — typing in their own app is no switch.
        let synthetic = g.handle(CUActivation(app: 7, switchInput: false, fromSyntheticEvent: true), now: 1)
        XCTAssertEqual(synthetic, .theft(restore: CUGuardedView(app: 1, space: 100), thief: 7, repeatOffender: false))
        let t = g.handle(CUActivation(app: 8, switchInput: false), now: 2)
        if case .theft(let r, let thief, _) = t { XCTAssertEqual(r.app, 1); XCTAssertEqual(thief, 8) } else { XCTFail() }
    }

    /// Review of round 6 (MEDIUM): right after one of the helper's synthetic events (a click's preparation, a blip's
    /// deactivation), a ⌘-Tab of the user's into the target was still taken for a theft and undone. Switch input is
    /// ABOVE the synthetic mark in the one decision.
    func testSwitchInputWinsOverTheSyntheticMark() {
        var g = started()
        XCTAssertEqual(g.handle(CUActivation(app: 7, space: 100, switchInput: true, fromSyntheticEvent: true), now: 1), .userSwitch)
        XCTAssertEqual(g.view.app, 7)
    }

    /// The one decision, in its order: visit, claim, switch input, the consented foreground, "nothing the agent did",
    /// a click when no input source runs, else the agent's.
    func testWhoseMoveDecidesInItsOrder() {
        var g = started()
        func f(_ app: pid_t, switchInput: Bool = false, caused: Bool = true, observable: Bool = true, click: Bool = false,
               ignoreVisit: Bool = false) -> CUMoveFacts {
            CUMoveFacts(app: app, space: 100, switchInput: switchInput, agentCaused: caused, inputObservable: observable,
                        clickRecent: click, ignoreVisit: ignoreVisit)
        }
        XCTAssertEqual(g.whoseMove(f(9), now: 1), .agent("no input of the user's that switches apps or desktops"), "typing or nothing: the agent's")
        XCTAssertTrue(g.whoseMove(f(9, switchInput: true), now: 1).isUsers, "their ⌘-Tab")
        XCTAssertTrue(g.whoseMove(f(9, caused: false), now: 1).isUsers, "nothing the agent did could have caused it")
        XCTAssertTrue(g.whoseMove(f(9, observable: false, click: true), now: 1).isUsers, "no tap: a click of theirs")
        XCTAssertFalse(g.whoseMove(f(9, observable: false), now: 1).isUsers, "no tap, no click: the agent's")
        g.exempt(9, until: 5)
        XCTAssertEqual(g.whoseMove(f(9), now: 1), .consented)
        g.userMoved(app: 9, space: 100, now: 2)
        XCTAssertTrue(g.whoseMove(f(9), now: 2.5).isUsers, "a move a path judged theirs is claimed")
        XCTAssertEqual(g.view, CUGuardedView(app: 9, space: 100), "and the guardian follows them there")
        XCTAssertEqual(g.handle(CUActivation(app: 9, space: 100, switchInput: false, fromSyntheticEvent: true), now: 2.6), .userSwitch,
                       "its late activation notification is never restored over")
        g.beginVisit(app: 5, now: 3)
        XCTAssertEqual(g.whoseMove(f(5), now: 3.1), .visit)
        XCTAssertEqual(g.whoseMove(f(5, ignoreVisit: true), now: 3.1), .agent("no input of the user's that switches apps or desktops"))
    }

    func testTheConsentedForegroundRungIsTheOnlyExemption() {
        var g = started()
        g.exempt(55, until: 10)
        XCTAssertEqual(g.handle(CUActivation(app: 55, switchInput: false), now: 5), .userSwitch, "exempt within the deadline")
        g = started()
        g.exempt(55, until: 10)
        XCTAssertEqual(g.handle(CUActivation(app: 55, switchInput: false), now: 11).isTheft, true, "past the deadline it is theft")
        g = started()
        g.exempt(55, until: 10)
        XCTAssertEqual(g.handle(CUActivation(app: 66, switchInput: false), now: 5).isTheft, true, "a different app is not exempt")
    }

    func testRepeatOffenderIsFlaggedAfterThreeInTenSeconds() {
        var g = started()
        XCTAssertEqual(g.handle(CUActivation(app: 9, switchInput: false), now: 0).repeatFlag, false)
        XCTAssertEqual(g.handle(CUActivation(app: 9, switchInput: false), now: 2).repeatFlag, false)
        XCTAssertEqual(g.handle(CUActivation(app: 9, switchInput: false), now: 4).repeatFlag, true, "third within 10 s")
        // Outside the window the count resets.
        var h = started()
        _ = h.handle(CUActivation(app: 9, switchInput: false), now: 0)
        _ = h.handle(CUActivation(app: 9, switchInput: false), now: 2)
        XCTAssertEqual(h.handle(CUActivation(app: 9, switchInput: false), now: 13).repeatFlag, false, "the first aged out")
    }

    func testTheSameAppStaysIgnoredAndAnIdleGuardianDoesNothing() {
        var g = started(app: 1, space: 100)
        XCTAssertEqual(g.handle(CUActivation(app: 1, space: 100, switchInput: false), now: 1), .ignore)
        var idle = CUFocusGuardianCore()
        XCTAssertEqual(idle.handle(CUActivation(app: 9, switchInput: false), now: 1), .ignore)
    }

    func testASpaceChangeWithoutInputIsRestoredAndWithInputIsTheUsers() {
        var g = started(space: 100)
        XCTAssertEqual(g.handleSpaceChange(to: 200, switchInput: false, now: 1), CUGuardedView(app: 1, space: 100))
        var h = started(space: 100)
        XCTAssertNil(h.handleSpaceChange(to: 200, switchInput: true, now: 1))
        XCTAssertEqual(h.view.space, 200, "the user's own space change is adopted")
    }

    // MARK: the live restore (window-targeted click → the app activates a second later → restored)

    func testAWindowTargetedClickThatActivatesTheAppASecondLaterRestoresTheUser() async throws {
        let ax = FakeAX()
        let window = fakeElement(95_501)
        ax.add(window, role: kAXWindowRole, title: "W", frame: CGRect(x: 0, y: 0, width: 400, height: 300))
        ax.windowIDs[AXIdentity(element: window)] = 77
        ax.put(ax.application(1), [kAXFocusedWindowAttribute: window])
        let sys = FakeSystem()
        sys.running = [1, 2203]
        sys.front = 1
        sys.space = 100
        sys.windows[77] = FakeSystem.window(77, pid: 1, CGRect(x: 0, y: 0, width: 400, height: 300))
        let core = CUCore(events: nil, clock: CUSystemClock(), skyLight: .none, poster: RecordingPoster(), ax: ax, sys: sys,
                          pasteboard: { PasteAndQueueTests.FakePasteboard([]) }, startMonitors: false)
        core.secondsSinceUserInputOverride = { 5 }  // no recent user input: an agent activation
        XCTAssertTrue(core.startGuardian(privatePath: true))
        defer { core.stopGuardian() }
        core.noteGuardianActed(2203)  // the agent just acted on it
        // VRoid/Preview comes to the front a second after a window-targeted click.
        sys.front = 2203
        sys.space = 150
        core.onActivation(pid: 2203)
        XCTAssertEqual(sys.activated.last, 1, "the user's app put back")
        let notes = core.takeGuardianNotes()
        XCTAssertTrue(notes.contains { $0.contains("tried to come to the front; you were put back") }, "\(notes)")
    }

    // MARK: the live gate 2026-10-10 — a delayed self-activation the window server "marks"

    /// A clock the test moves by hand.
    final class HandClock: CUClock, @unchecked Sendable {
        private let lock = NSLock()
        private var ms: Double
        init(_ start: Double = 100_000) { ms = start }
        func nowMs() -> Double { lock.withLock { ms } }
        func advance(ms d: Double) { lock.withLock { ms += d } }
        func sleep(ms d: Double) async throws { advance(ms: d) }
    }

    /// What the session tap saw, measured on macOS 26 with nobody touching anything: when an app activates (and when
    /// the desktop changes) the window server puts these on the session with NO source process — mouse
    /// entered/exited, AppKit-defined, the gesture begin/end markers — plus the type-21 process notifications.
    static let windowServerMarks: [UInt32] = [8, 9, 13, 13, 19, 20]

    private func delayedStealWorld() -> (CUCore, FakeSystem, HandClock) {
        let clock = HandClock()
        let sys = FakeSystem()
        sys.running = [1, 500]; sys.front = 1; sys.space = 100
        let core = CUCore(events: nil, clock: clock, skyLight: .none, poster: RecordingPoster(), ax: FakeAX(), sys: sys,
                          pasteboard: { PasteAndQueueTests.FakePasteboard([]) }, startMonitors: false)
        core.registerForTesting(CUTarget(id: "t1", sessionId: "s", pid: 500, bundleId: "dev.cu-live.fixture", appName: "Winter CU Fixture",
                                         isChromium: false, mirror: false, windowID: 77, windowTitle: "Fixture Canvas"), windowElement: nil)
        core.secondsSinceUserInputOverride = { 5 }  // the HID counters stayed quiet (measured: nothing under 0.4 s)
        core.guardianTailSchedule = { _, _ in nil }
        core.noteGuardianPrivatePath(true)
        core.scriptActivity(sessionId: "s", active: true)
        return (core, sys, clock)
    }

    func testADelayedSelfActivationIsUndoneThoughTheWindowServerMarksIt() {
        let (core, sys, clock) = delayedStealWorld()
        defer { core.stopGuardian() }
        XCTAssertTrue(core.guardianRunning)
        core.noteGuardianActed(500)  // the agent's click on the canvas ended
        // 1.364 s later (the live run's timing) the fixture activates itself; the tap sees the window server's marks
        // at the same moment as the activation.
        clock.advance(ms: 1_364)
        for t in Self.windowServerMarks {
            core.noteTapEvent(type: CGEventType(rawValue: t)!, sourcePid: 0, userData: 0, now: clock.nowSeconds())
        }
        sys.front = 500
        core.onActivation(pid: 500)
        XCTAssertEqual(sys.activated.last, 1, "the user's app put back at once — not taken for the user's own switch")
        XCTAssertTrue(core.takeGuardianNotes().contains { $0.contains("tried to come to the front; you were put back") })
        XCTAssertEqual(core.guardianLock.withLock { core.guardianCore.view.app }, 1, "the thief never became the user's app")
    }

    func testTheUsersRealInputStillMakesItTheirs() {
        let (core, sys, clock) = delayedStealWorld()
        defer { core.stopGuardian() }
        core.switchInputObservableOverride = true
        core.noteGuardianActed(500)
        clock.advance(ms: 1_000)
        // A real ⌘-Tab (no source process; the switcher swallows the Tab — only ⌘'s press and release show) a moment
        // before the activation: the user's.
        core.noteTapEvent(type: .flagsChanged, sourcePid: 0, userData: 0, flags: .maskCommand, now: clock.nowSeconds())
        core.noteTapEvent(type: .flagsChanged, sourcePid: 0, userData: 0, flags: [], now: clock.nowSeconds() + 0.1)
        clock.advance(ms: 200)
        sys.front = 500
        core.onActivation(pid: 500)
        XCTAssertTrue(sys.activated.isEmpty, "the user's own switch is respected")
        // The helper's own stamped events, or another process's, are never the user's.
        let (core2, sys2, clock2) = delayedStealWorld()
        defer { core2.stopGuardian() }
        core2.switchInputObservableOverride = true
        core2.noteGuardianActed(500)
        clock2.advance(ms: 900)
        core2.noteTapEvent(type: .flagsChanged, sourcePid: 0, userData: CUEventStamp.value, flags: .maskCommand, now: clock2.nowSeconds())
        core2.noteTapEvent(type: .flagsChanged, sourcePid: 4242, userData: 0, flags: .maskCommand, now: clock2.nowSeconds())
        sys2.front = 500
        core2.onActivation(pid: 500)
        XCTAssertEqual(sys2.activated.last, 1)
    }

    /// Review of round 6 (HIGH, a regression): ordinary TYPING in the user's own app made a target's self-activation
    /// "the user's switch" — adopted as their place, their next keys going into it. Typing is no switch: undone.
    func testTypingInTheirOwnAppNeverMakesATheftTheirs() {
        let (core, sys, clock) = delayedStealWorld()
        defer { core.stopGuardian() }
        core.switchInputObservableOverride = true
        core.secondsSinceUserInputOverride = { 0.05 }  // the user typing all along
        core.noteGuardianActed(500)
        clock.advance(ms: 300)
        for i in 0..<5 { core.noteTapEvent(type: .keyDown, sourcePid: 0, userData: 0, keycode: Int64(i), now: clock.nowSeconds()) }
        core.noteTapEvent(type: .flagsChanged, sourcePid: 0, userData: 0, flags: .maskShift, now: clock.nowSeconds())  // a capital
        sys.front = 500
        core.onActivation(pid: 500)
        XCTAssertEqual(sys.activated.last, 1, "the target that activated itself is undone")
    }

    func testTheCausalWindowStillBoundsWhatIsTheAgents() {
        let (core, sys, clock) = delayedStealWorld()
        defer { core.stopGuardian() }
        core.noteGuardianActed(500)
        clock.advance(ms: CUCore.guardianCausalWindow * 1000 + 100)  // past it: nothing the agent did, the user's
        sys.front = 500
        core.onActivation(pid: 500)
        XCTAssertTrue(sys.activated.isEmpty)
    }

    func testTheWindowServersOwnEventsAreNotInput() {
        for t in Self.windowServerMarks {
            XCTAssertEqual(CUHardwareInput.classify(type: CGEventType(rawValue: t)!, sourcePid: 0, userData: 0), .none, "type \(t)")
        }
        // A person's input still is.
        for t: UInt32 in [1, 2, 3, 4, 6, 7, 10, 11, 12, 22, 25, 26, 27, 29, 30, 31] {
            XCTAssertEqual(CUHardwareInput.classify(type: CGEventType(rawValue: t)!, sourcePid: 0, userData: 0), .action, "type \(t)")
        }
        XCTAssertEqual(CUHardwareInput.classify(type: .mouseMoved, sourcePid: 0, userData: 0), .move)
        // The global gesture monitor sees only what real input delivers to other apps: a swipe's begin/end counts there.
        XCTAssertEqual(CUHardwareInput.classify(type: CGEventType(rawValue: 19)!, sourcePid: 0, userData: 0, markers: true), .action)
        XCTAssertEqual(CUHardwareInput.classify(type: CGEventType(rawValue: 13)!, sourcePid: 0, userData: 0, markers: true), .none)
    }

    func testAUserActivationIsLeftAloneLive() async throws {
        let sys = FakeSystem()
        sys.running = [1, 2203]; sys.front = 1; sys.space = 100
        let core = CUCore(events: nil, clock: CUSystemClock(), skyLight: .none, poster: RecordingPoster(), ax: FakeAX(), sys: sys,
                          pasteboard: { PasteAndQueueTests.FakePasteboard([]) }, startMonitors: false)
        core.secondsSinceUserInputOverride = { 0.1 }  // the user just clicked
        XCTAssertTrue(core.startGuardian(privatePath: true))
        defer { core.stopGuardian() }
        sys.front = 2203
        core.onActivation(pid: 2203)
        XCTAssertTrue(sys.activated.isEmpty, "the user's own switch is respected")
        XCTAssertTrue(core.takeGuardianNotes().isEmpty)
    }
    // MARK: only apps the agent touched, only while it acts

    func testAnAppTheAgentNeverTouchedComingForwardIsAlwaysTheUsersChoice() {
        var g = CUFocusGuardianCore()
        g.begin(view: CUGuardedView(app: 1, space: 100))
        // Terminal (pid 77) comes forward with no input on record: still the user's — the agent never touched it.
        XCTAssertEqual(g.handle(CUActivation(app: 77, space: 200, switchInput: false, suspect: false), now: 10), .userSwitch)
        XCTAssertEqual(g.view, CUGuardedView(app: 77, space: 200), "it is the user's app and Space now")
        // A touched app taking the front after that is put back to Terminal, never to the old app.
        guard case .theft(let restore, _, _) = g.handle(CUActivation(app: 500, space: 200, switchInput: false), now: 11)
        else { return XCTFail("expected a theft") }
        XCTAssertEqual(restore.app, 77)
    }

    private func guardWorld() -> (CUCore, FakeSystem, () -> Void) {
        let sys = FakeSystem()
        sys.running = [1, 77, 500]; sys.front = 1; sys.space = 100
        let core = CUCore(events: nil, clock: CUSystemClock(), skyLight: .none, poster: RecordingPoster(), ax: FakeAX(), sys: sys,
                          pasteboard: { PasteAndQueueTests.FakePasteboard([]) }, startMonitors: false)
        core.registerForTesting(CUTarget(id: "t1", sessionId: "s", pid: 500, bundleId: "x", appName: "Agent's app",
                                         isChromium: false, mirror: false, windowID: 77, windowTitle: ""), windowElement: nil)
        core.secondsSinceUserInputOverride = { 5 }
        var tail: (() -> Void)?
        core.guardianTailSchedule = { _, work in tail = work; return nil }
        return (core, sys, { tail?() })
    }

    func testANonTargetAppActivatingDuringAScriptIsNeverRestored() {
        let (core, sys, _) = guardWorld()
        core.noteGuardianPrivatePath(true)
        core.scriptActivity(sessionId: "s", active: true)
        defer { core.stopGuardian() }
        XCTAssertTrue(core.guardianRunning)
        sys.front = 77
        core.onActivation(pid: 77)  // the user switched to Terminal
        XCTAssertTrue(sys.activated.isEmpty, "never pulled back")
        XCTAssertTrue(core.takeGuardianNotes().isEmpty)
        // The bound target's own activation right after an act on it is still caught.
        core.noteGuardianActed(500)
        sys.front = 500
        core.onActivation(pid: 500)
        XCTAssertEqual(sys.activated.last, 77, "put back to the user's CURRENT app")
    }

    func testAnIdleOrStoppedSessionHasNoGuardian() {
        let (core, sys, _) = guardWorld()
        core.noteGuardianPrivatePath(true)  // a target bound, no script running
        XCTAssertFalse(core.guardianRunning, "bound targets alone start nothing")
        sys.front = 500
        core.onActivation(pid: 500)
        XCTAssertTrue(sys.activated.isEmpty)
        // With the private path off, a script starts no guard either.
        core.noteGuardianPrivatePath(false)
        core.scriptActivity(sessionId: "s", active: true)
        XCTAssertFalse(core.guardianRunning)
    }

    func testTheGuardOutlivesTheScriptByItsTailOnly() {
        let (core, sys, fireTail) = guardWorld()
        core.noteGuardianPrivatePath(true)
        core.scriptActivity(sessionId: "s", active: true)
        core.scriptActivity(sessionId: "s", active: false)
        XCTAssertTrue(core.guardianRunning, "the tail: a late activation is still caught")
        core.noteGuardianActed(500)
        sys.front = 500
        core.onActivation(pid: 500)
        XCTAssertEqual(sys.activated.last, 1)
        fireTail()
        XCTAssertFalse(core.guardianRunning, "then nothing")
        // A script that starts within the tail keeps the guard.
        core.scriptActivity(sessionId: "s", active: true)
        core.scriptActivity(sessionId: "s", active: false)
        core.scriptActivity(sessionId: "s2", active: true)
        fireTail()
        XCTAssertTrue(core.guardianRunning)
        core.stopGuardian()
    }

    func testAGestureSpaceSwitchOrActivationWithHardwareInputIsTheUsers() {
        let (core, sys, _) = guardWorld()
        core.noteGuardianPrivatePath(true)
        core.scriptActivity(sessionId: "s", active: true)
        defer { core.stopGuardian() }
        // A three-finger swipe: gesture events (hardware), no click or key.
        core.noteHardwareInput(now: core.clock.nowSeconds())
        sys.space = 300
        core.onSpaceChange()
        sys.front = 500
        core.onActivation(pid: 500)
        XCTAssertTrue(sys.activated.isEmpty, "the user's own switch")
        XCTAssertTrue(core.takeGuardianNotes().isEmpty)
    }

    func testOnlyAChangeSoonAfterItsCauseIsTheAgents() {
        let (core, _, _) = guardWorld()
        let now = core.clock.nowSeconds()
        XCTAssertFalse(core.guardianSuspect(500, now: now), "a bound target's app with nothing done to it: not a suspect")
        core.noteGuardianActed(500)
        XCTAssertTrue(core.guardianSuspect(500, now: now + 0.5), "0.5 s after an act on it")
        XCTAssertFalse(core.guardianSuspect(500, now: now + 5), "5 s after: the user's")
        core.noteGuardianOpened(77)
        XCTAssertTrue(core.guardianSuspect(77, now: now + 1), "a document opened in it a second ago")
        XCTAssertTrue(core.guardianSpaceChangeCaused(now: now + 1))
        XCTAssertFalse(core.guardianSpaceChangeCaused(now: now + 3))
    }

    func testAnActivationLongAfterTheLastActIsTheUsersOneRightAfterItIsUndone() {
        let (core, sys, _) = guardWorld()
        core.noteGuardianPrivatePath(true)
        core.scriptActivity(sessionId: "s", active: true)
        defer { core.stopGuardian() }
        core.guardianCauses[500] = core.clock.nowSeconds() - 5  // the last act on it, 5 s ago
        sys.front = 500
        core.onActivation(pid: 500)
        XCTAssertTrue(sys.activated.isEmpty, "the user went there")
        sys.front = 1
        core.onActivation(pid: 1)
        core.noteGuardianActed(500)  // now an act on it, and it comes forward at once
        sys.front = 500
        core.onActivation(pid: 500)
        XCTAssertEqual(sys.activated.last, 1, "undone")
    }

    func testAUserSwipeToTheTargetsSpaceMidScriptIsNeverUndoneAndBecomesTheirPlace() {
        let (core, sys, _) = guardWorld()
        core.noteGuardianPrivatePath(true)
        core.scriptActivity(sessionId: "s", active: true)
        defer { core.stopGuardian() }
        core.guardianCauses[500] = core.clock.nowSeconds() - 4
        core.guardianLastCause = core.clock.nowSeconds() - 4
        // The user swipes to the target's desktop to watch: a Space change and the target in front, no input seen.
        sys.space = 300
        sys.front = 500
        core.onSpaceChange()
        core.onActivation(pid: 500)
        XCTAssertTrue(sys.activated.isEmpty, "never pulled back")
        XCTAssertEqual(sys.space, 300)
        // Later, an app the agent just acted on takes the front: the user is put back where THEY went.
        core.noteGuardianActed(77)
        sys.front = 77
        core.onActivation(pid: 77)
        XCTAssertEqual(sys.activated.last, 500, "to the user's new place, not where the script started")
    }

    func testASwipeRightAfterAnActIsStillTheUsersWithHardwareInput() {
        let (core, sys, _) = guardWorld()
        core.noteGuardianPrivatePath(true)
        core.scriptActivity(sessionId: "s", active: true)
        defer { core.stopGuardian() }
        core.noteGuardianActed(500)
        core.noteHardwareInput(now: core.clock.nowSeconds())  // the swipe's own gesture events
        sys.space = 300
        core.onSpaceChange()
        XCTAssertTrue(sys.activated.isEmpty)
    }

    // MARK: the user's own click into the agent's app (a listen-only left-mouse-down observer)

    func testAClickClaimsTheActivationItCausesWhateverTheTiming() {
        var g = CUFocusGuardianCore()
        g.begin(view: CUGuardedView(app: 1, space: 100))
        g.userClicked(app: 500, space: 100, now: 10)
        XCTAssertEqual(g.view, CUGuardedView(app: 500, space: 100), "the user's app is the clicked one at once")
        // The app activates a second later — past the 0.4 s input window, with no recent input reported.
        XCTAssertEqual(g.handle(CUActivation(app: 500, space: 100, switchInput: false), now: 11), .userSwitch)
        // After the claim, another app's activation is a theft that restores the CLICKED app, not the old one.
        guard case .theft(let restore, _, _) = g.handle(CUActivation(app: 7, switchInput: false), now: 11.2)
        else { return XCTFail("expected a theft") }
        XCTAssertEqual(restore.app, 500)
    }

    func testAClicksClaimExpires() {
        var g = CUFocusGuardianCore()
        g.begin(view: CUGuardedView(app: 1, space: 100))
        g.userClicked(app: 500, space: 100, now: 10)
        g.end(); g.begin(view: CUGuardedView(app: 1, space: 100))  // a fresh guard: no claim
        XCTAssertNotEqual(g.handle(CUActivation(app: 500, switchInput: false), now: 10.5), .userSwitch)
        var h = CUFocusGuardianCore()
        h.begin(view: CUGuardedView(app: 1, space: 100))
        h.userClicked(app: 500, space: 100, now: 10)
        _ = h.handle(CUActivation(app: 1, switchInput: true), now: 10.2)  // the user went back to their app
        guard case .theft = h.handle(CUActivation(app: 500, switchInput: false), now: 10 + CUFocusGuardianCore.clickClaimWindow + 0.1)
        else { return XCTFail("a click long ago claims nothing") }
    }

    /// A guarded core with a bound target (pid 500, window 77 at 0,0 400×300) and the user in app 1.
    private func clickWorld() -> (CUCore, FakeSystem) {
        let sys = FakeSystem()
        sys.running = [1, 500]; sys.front = 1; sys.space = 100
        sys.windows[77] = FakeSystem.window(77, pid: 500, CGRect(x: 0, y: 0, width: 400, height: 300))
        sys.stack = [FakeSystem.window(77, pid: 500, CGRect(x: 0, y: 0, width: 400, height: 300)),
                     FakeSystem.window(9, pid: 1, CGRect(x: 0, y: 0, width: 1600, height: 1000))]
        let core = CUCore(events: nil, clock: CUSystemClock(), skyLight: .none, poster: RecordingPoster(), ax: FakeAX(), sys: sys,
                          pasteboard: { PasteAndQueueTests.FakePasteboard([]) }, startMonitors: false)
        core.registerForTesting(CUTarget(id: "t1", sessionId: "s", pid: 500, bundleId: "x", appName: "Agent's app",
                                         isChromium: false, mirror: false, windowID: 77, windowTitle: ""), windowElement: nil)
        core.secondsSinceUserInputOverride = { 5 }  // the activation arrives long after the click
        XCTAssertTrue(core.startGuardian(privatePath: true))
        return (core, sys)
    }

    func testAPhysicalClickIntoTheBoundTargetsWindowIsTheUsersAndActivatesIt() {
        let (core, sys) = clickWorld()
        defer { core.stopGuardian() }
        XCTAssertEqual(core.onPhysicalClick(at: CGPoint(x: 100, y: 100), userData: 0, now: 10), 500)
        XCTAssertEqual(sys.activated, [500], "activated so the user's click works normally")
        // The activation that follows is the user's: nothing put back, nothing said.
        core.onActivation(pid: 500)
        XCTAssertEqual(sys.activated, [500], "the guardian did not fight the user")
        XCTAssertTrue(core.takeGuardianNotes().isEmpty)
    }

    func testAHelperStampedClickIsIgnoredAndTheActivationIsStillPutBack() {
        let (core, sys) = clickWorld()
        defer { core.stopGuardian() }
        core.noteGuardianActed(500)  // the click was ours, just now
        XCTAssertNil(core.onPhysicalClick(at: CGPoint(x: 100, y: 100), userData: CUEventStamp.value, now: 10))
        sys.front = 500
        core.onActivation(pid: 500)
        XCTAssertEqual(sys.activated.last, 1, "our own click claims nothing: the user's app is put back")
    }

    func testAClickOnAnotherAppsWindowClaimsNothing() {
        let (core, sys) = clickWorld()
        defer { core.stopGuardian() }
        XCTAssertNil(core.onPhysicalClick(at: CGPoint(x: 900, y: 600), userData: 0, now: 10), "the user's own app, not a target")
        XCTAssertTrue(sys.activated.isEmpty)
        XCTAssertEqual(core.lastSwitchInputAt, -1, "a click in their own app switches nothing")
    }

    /// Review of round 3: what a visit's late-switch watch counts as the user's move — a click on a target's window or
    /// on the Dock (either can bring the target forward), never one in their own app.
    func testAClickOnATargetOrTheDockIsInputThatCanSwitch() {
        let (core, sys) = clickWorld()
        defer { core.stopGuardian() }
        _ = core.onPhysicalClick(at: CGPoint(x: 100, y: 100), userData: 0, now: 10)
        XCTAssertEqual(core.lastSwitchInputAt, 10)
        var dock = FakeSystem.window(3, pid: 77, CGRect(x: 500, y: 950, width: 600, height: 50), layer: 20)
        dock.ownerName = "Dock"
        sys.stack.insert(dock, at: 0)
        XCTAssertNil(core.onPhysicalClick(at: CGPoint(x: 800, y: 970), userData: 0, now: 12), "the Dock is no target")
        XCTAssertEqual(core.lastSwitchInputAt, 12, "but a click on it can switch apps")
    }

    func testEveryEventTheHelperPostsCarriesTheStamp() {
        let seen = OrderLog()
        var poster = CULiveEventPoster(skyLight: .none)
        poster.postToPid = { e, _ in seen.add(String(e.getIntegerValueField(.eventSourceUserData))) }
        poster.postHID = { e in seen.add(String(e.getIntegerValueField(.eventSourceUserData))) }
        let e1 = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: .zero, mouseButton: .left)!
        let e2 = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true)!
        poster.post(e1, pid: 42, route: .publicPid, authenticate: false)
        poster.post(e2, pid: 42, route: .hid, authenticate: false)
        XCTAssertEqual(seen.items, [String(CUEventStamp.value), String(CUEventStamp.value)])
    }

    func testACPSKeyFocusTheftOfABoundTargetIsReleasedAndRestored() async throws {
        let sys = FakeSystem()
        sys.running = [500, 800]; sys.front = 500; sys.space = 100
        let core = CUCore(events: nil, clock: CUSystemClock(), skyLight: .none, poster: RecordingPoster(), ax: FakeAX(), sys: sys,
                          pasteboard: { PasteAndQueueTests.FakePasteboard([]) }, startMonitors: false)
        let t = CUTarget(id: "t1", sessionId: "s", pid: 500, bundleId: "x", appName: "Victim", isChromium: false,
                         mirror: false, windowID: 7, windowTitle: "")
        core.registerForTesting(t, windowElement: nil)
        var released: [Int32] = []
        core.cpsReleaseOverride = { released.append($0); return true }
        // 500 holds focus; then 800 steals it (a type-21 keyFocusTaken, no app activation).
        _ = core.onCPSNotification(recipientPID: 500, subtype: 0, subjectPID: 500, theftID: 0, now: 1)
        let v = core.onCPSNotification(recipientPID: 800, subtype: CUCPSSubtype.keyFocusTaken, subjectPID: 800, theftID: 0xBEEF, now: 2)
        XCTAssertEqual(v, .release(theftID: 0xBEEF))
        XCTAssertEqual(released, [0xBEEF], "the theft is released by its token")
        XCTAssertTrue(sys.activated.isEmpty, "the agent's target is never brought in front of the user")
    }

    /// A core whose restore retries for real (a short deadline), with a thief that takes the front back
    /// `refusals` times after each activation of the user's app (a negative count: it never yields).
    private func retryWorld(refusals: Int) -> (CUCore, FakeSystem) {
        let sys = FakeSystem()
        sys.running = [500, 800]; sys.front = 800; sys.space = 100
        let core = CUCore(events: nil, clock: CUSystemClock(), skyLight: .none, poster: RecordingPoster(), ax: FakeAX(), sys: sys,
                          pasteboard: { PasteAndQueueTests.FakePasteboard([]) }, startMonitors: false)
        core.restoreDeadlineMs = 400
        core.restoreRetryMs = 40
        var left = refusals
        sys.onActivate = { pid in
            guard pid == 500, left != 0 else { return }
            left -= 1
            sys.front = 800  // the thief comes back in front
        }
        return (core, sys)
    }

    func testTheRestoreRetriesTheUsersActivationUntilItIsFront() {
        let (core, sys) = retryWorld(refusals: 2)
        core.guardianRestore(CUGuardedView(app: 500, space: 100), thief: 800, repeatOffender: false, cause: "test")
        XCTAssertEqual(sys.activated.filter { $0 == 500 }.count, 3, "two refused activations, then the one that held")
        XCTAssertEqual(sys.frontmostPid(), 500)
        let notes = core.takeGuardianNotes()
        XCTAssertEqual(notes.count, 1)
        XCTAssertTrue(notes.first?.hasSuffix("tried to come to the front; you were put back") ?? false, notes.first ?? "")
    }

    func testARefusedActivationIsRetriedAsTheAppMadeFrontmost() {
        // macOS refuses the background helper's activation outright (cooperative activation); AXFrontmost holds.
        let sys = FakeSystem()
        sys.running = [500, 800]; sys.front = 800; sys.space = 100
        sys.activationRefused = [500]
        let ax = FakeAX()
        ax.onSet = { w in if w == "500:\(kAXFrontmostAttribute)" { sys.front = 500 } }
        let core = CUCore(events: nil, clock: CUSystemClock(), skyLight: .none, poster: RecordingPoster(), ax: ax, sys: sys,
                          pasteboard: { PasteAndQueueTests.FakePasteboard([]) }, startMonitors: false)
        core.restoreDeadlineMs = 400
        core.restoreRetryMs = 40
        core.guardianRestore(CUGuardedView(app: 500, space: 100), thief: 800, repeatOffender: false, cause: "test")
        XCTAssertEqual(sys.frontmostPid(), 500, "put back")
        XCTAssertTrue(ax.written.contains("500:\(kAXFrontmostAttribute)"))
        XCTAssertTrue(core.takeGuardianNotes().first?.hasSuffix("tried to come to the front; you were put back") ?? false)
    }

    func testTheRestoreGivesUpAtTheDeadline() {
        let (core, sys) = retryWorld(refusals: -1)
        let start = Date()
        core.guardianRestore(CUGuardedView(app: 500, space: 100), thief: 800, repeatOffender: false, cause: "test")
        let took = Date().timeIntervalSince(start)
        XCTAssertGreaterThan(sys.activated.filter { $0 == 500 }.count, 3, "kept retrying")
        XCTAssertLessThan(took, 1.5, "stopped at the deadline (400 ms here; 2 s live)")
        XCTAssertEqual(sys.frontmostPid(), 800)
    }

    func testAnUnprotectedCPSTheftIsPassedThrough() {
        let sys = FakeSystem()
        sys.running = [1]; sys.front = 1
        let core = CUCore(events: nil, clock: CUSystemClock(), skyLight: .none, poster: RecordingPoster(), ax: FakeAX(), sys: sys,
                          pasteboard: { PasteAndQueueTests.FakePasteboard([]) }, startMonitors: false)
        // No bound target: nothing is protected, so a theft passes.
        let v = core.onCPSNotification(recipientPID: 9, subtype: CUCPSSubtype.keyFocusTaken, subjectPID: 9, theftID: 1, now: 1)
        XCTAssertEqual(v, .pass)
    }
}

private extension CUGuardianVerdict {
    var isTheft: Bool { if case .theft = self { return true }; return false }
    var repeatFlag: Bool { if case .theft(_, _, let r) = self { return r }; return false }
}
