import ApplicationServices
import CoreGraphics
import XCTest
@testable import WinterCUCore

/// The continuous Focus Guardian: the one rule (`CUFocusGuardianCore.judge`) — its order, the invariants it keeps (§4.12),
/// repeat detection, the one exemption and Space handling — pure and tested — plus the live restore wired through
/// CUCore's fakes.
final class FocusGuardianTests: XCTestCase {
    // MARK: the pure core

    private func started(app: pid_t = 1, space: UInt64 = 100) -> CUFocusGuardianCore {
        var g = CUFocusGuardianCore()
        g.begin(view: CUGuardedView(app: app, space: space))
        return g
    }

    private func judge(_ g: inout CUFocusGuardianCore, _ app: pid_t?, _ space: UInt64? = 100, since: TimeInterval? = nil,
                       observable: Bool = true, clickAt: TimeInterval? = nil, now: TimeInterval) -> CUMoveOwner {
        g.judge(CUMoveQuery(app: app, space: space, since: since, inputObservable: observable, clickAt: clickAt), now: now)
    }

    /// The user's ⌘-Tab as the session tap sees it: ⌘ down, the Tab swallowed, ⌘ up.
    private func commandTab(_ g: inout CUFocusGuardianCore, at t: TimeInterval) {
        g.inputEvent(type: .flagsChanged, flags: .maskCommand, now: t - 0.1)
        g.inputEvent(type: .flagsChanged, flags: [], now: t)
    }

    func testAUserSwitchIsRespectedAndBecomesTheirPlace() {
        var g = started()
        g.noteCause(42, now: 0.5)  // touched: only their input makes it theirs
        commandTab(&g, at: 0.8)
        XCTAssertTrue(judge(&g, 42, 200, now: 1).isUsers)
        XCTAssertEqual(g.view, CUGuardedView(app: 42, space: 200), "their own switch moves their place")
        // A later theft is put back to 42/200 — their place now, never where the script began (I2).
        g.noteCause(99, now: 1.5)
        XCTAssertEqual(judge(&g, 99, 300, now: 2), .agent("the agent touched it, and no input of the user's that switches apps or desktops came after"))
        XCTAssertEqual(g.view, CUGuardedView(app: 42, space: 200))
    }

    /// I1 — review of round 7 (HIGH 1): a synthetic mark on the TARGET made the user's plain click into Mail a theft. Marks
    /// and causes are per app: an app the agent never touched coming forward is always the user's, whatever else it did.
    func testAnAppTheAgentNeverTouchedIsAlwaysTheUsersWhateverTheAgentDidElsewhere() {
        var g = started()
        g.noteCause(500, now: 10)   // the agent's synthetic activation of the target, just now
        XCTAssertEqual(judge(&g, 77, 100, now: 10.05), .user("the agent did not touch it — an app it never touched coming forward is always the user's"))
        XCTAssertEqual(g.view.app, 77)
        // A touched app with no input of theirs: the agent's — put back to Mail (77), their place now.
        XCTAssertFalse(judge(&g, 500, 100, now: 10.1).isUsers)
        XCTAssertEqual(g.view.app, 77)
        // Past the causal window the target is no longer touched: theirs.
        XCTAssertTrue(judge(&g, 500, 200, now: 10 + CUFocusGuardianCore.causalWindow + 0.1).isUsers)
    }

    /// I2 / item 5 — switch input counts only when it came AFTER the agent's last cause on that app, and explains one
    /// change only (review of round 7: it ignored which app came forward, was never used up, and outranked the mark).
    func testSwitchInputCountsOnlyAfterTheAgentsLastCauseOnThatAppAndOnlyOnce() {
        var g = started()
        commandTab(&g, at: 1.0)
        g.noteCause(500, now: 1.1)  // the agent's mark after their ⌘-Tab
        XCTAssertFalse(judge(&g, 500, now: 1.2).isUsers, "input before the mark does not outrank it")
        XCTAssertEqual(judge(&g, 1, now: 1.3), .theirPlace)  // put back
        commandTab(&g, at: 1.4)     // now after the mark
        XCTAssertTrue(judge(&g, 500, now: 1.5).isUsers)
        // Used up: the change it explained took it. Back in their app, the target's next self-activation is undone.
        XCTAssertTrue(judge(&g, 1, now: 1.6).isUsers, "their app: untouched")
        XCTAssertFalse(judge(&g, 500, now: 1.7).isUsers, "the ⌘-Tab explained one change only")
        // An app switch never explains a desktop change on its own, nor a desktop switch an app change on the same desktop.
        var h = started()
        h.noteCause(500, now: 0.9)
        h.inputEvent(type: CGEventType(rawValue: 31)!, flags: [], now: 1.0)  // a swipe
        XCTAssertFalse(judge(&h, 500, 100, now: 1.1).isUsers, "the target in front on the same desktop: no swipe explains that")
        XCTAssertTrue(judge(&h, 500, 200, now: 1.2).isUsers, "on another desktop: the swipe's")
    }

    /// The same state judged by two paths gets the same verdict (I5), and input of theirs that arrives later re-judges it.
    func testAStateJudgedOnceIsTheSameForEveryPathUntilNewInputArrives() {
        var g = started()
        g.noteCause(500, now: 1)
        let first = judge(&g, 500, now: 1.1)
        XCTAssertFalse(first.isUsers)
        XCTAssertEqual(judge(&g, 500, now: 1.2), first, "the next path asking about the same state")
        XCTAssertFalse(g.lastFresh)
        g.userClicked(app: 500, space: 100, now: 1.3)  // they click into its window: new input
        XCTAssertTrue(g.view.app == 500)
        XCTAssertEqual(judge(&g, 500, now: 1.35), .theirPlace, "their place now")
    }

    /// The one rule, in its order.
    func testTheRuleDecidesInItsOrder() {
        var g = started()
        XCTAssertEqual(judge(&g, 1, now: 0), .theirPlace, "0. their place")
        g.noteCause(9, now: 1)
        XCTAssertEqual(judge(&g, 9, now: 1), .agent("the agent touched it, and no input of the user's that switches apps or desktops came after"))
        XCTAssertTrue(judge(&g, 8, now: 1.01).isUsers, "1. not touched")
        g.noteCause(9, now: 1.02)
        g.userClicked(app: 9, space: 100, now: 1.03)
        XCTAssertEqual(judge(&g, 9, 300, now: 1.05), .user("they clicked into its window"), "2. a claim (the desktop it was on)")
        // 3. the desktop change that follows their move into an app
        var f = started()
        f.noteCause(9, now: 0.5)
        commandTab(&f, at: 0.9)
        XCTAssertTrue(judge(&f, 9, 100, now: 1).isUsers, "their ⌘-Tab")
        XCTAssertEqual(judge(&f, 9, 200, now: 1.3), .user("the desktop change that came with their own move into it"))
        // 5. no input source: a click of theirs after the cause
        var n = started()
        n.noteCause(9, now: 1)
        XCTAssertTrue(judge(&n, 9, observable: false, clickAt: 1.1, now: 1.2).isUsers)
        var n2 = started()
        n2.noteCause(9, now: 1)
        XCTAssertFalse(judge(&n2, 9, observable: false, clickAt: 0.9, now: 1.2).isUsers, "a click before the cause")
        // 6. a visit in progress; 7. the consented foreground
        var v = started()
        v.beginVisit(app: 5, user: 1, now: 3)
        XCTAssertEqual(judge(&v, 5, 200, now: 3.1), .visit)
        var e = started()
        e.noteCause(9, now: 1)
        e.exempt(9, until: 5)
        XCTAssertEqual(judge(&e, 9, now: 2), .consented)
    }

    func testTheConsentedForegroundRungIsTheOnlyExemption() {
        var g = started()
        g.noteCause(55, now: 4)
        g.exempt(55, until: 10)
        XCTAssertEqual(judge(&g, 55, now: 5), .consented, "exempt within the deadline")
        g = started()
        g.noteCause(55, now: 10.5)
        g.exempt(55, until: 10)
        XCTAssertEqual(judge(&g, 55, now: 11), .agent("the agent touched it, and no input of the user's that switches apps or desktops came after"), "past the deadline it is the agent's")
        g = started()
        g.noteCause(66, now: 4.5)
        g.exempt(55, until: 10)
        XCTAssertFalse(judge(&g, 66, now: 5).isUsers, "a different app is not exempt")
    }

    func testRepeatOffenderIsFlaggedAfterThreeInTenSeconds() {
        var g = started()
        for (i, t) in [0.0, 2, 4].enumerated() {
            g.noteCause(9, now: t)
            XCTAssertFalse(judge(&g, 9, now: t + 0.1).isUsers)
            XCTAssertEqual(g.lastRepeatOffender, i == 2, "third within 10 s")
            XCTAssertEqual(judge(&g, 1, now: t + 0.2), .theirPlace)  // put back
        }
        var h = started()
        for t in [0.0, 2, 13] {
            h.noteCause(9, now: t)
            _ = judge(&h, 9, now: t + 0.1)
            _ = judge(&h, 1, now: t + 0.2)
        }
        XCTAssertFalse(h.lastRepeatOffender, "the first aged out")
    }

    func testASpaceChangeOfATouchedAppWithoutInputIsTheAgentsWithAControlHoldTheUsers() {
        var g = started(space: 100)
        g.noteCause(9, now: 1)
        XCTAssertFalse(judge(&g, 9, 200, now: 1.1).isUsers)
        var h = started(space: 100)
        h.noteCause(9, now: 1)
        h.inputEvent(type: .flagsChanged, flags: .maskControl, now: 1.05)  // ⌃ held: the desktop switcher (⌃-→)
        XCTAssertTrue(judge(&h, 9, 200, now: 1.3).isUsers)
        XCTAssertEqual(h.view.space, 200, "their own desktop change is adopted")
        XCTAssertTrue(judge(&h, 9, 300, now: 1.6).isUsers, "a ⌃ hold that lasts explains every desktop it passes")
    }

    /// I1 for a launch — review of round 7 (HIGH 3): a launch was never a cause, so an app the agent launched that came
    /// forward during the bind was "never touched", the user's. Its process starting after the launch began makes it the
    /// agent's — only that bundle's, and only once the launch says what it launches.
    func testAnAppTheAgentIsLaunchingIsTouched() {
        var g = started()
        let launch = g.beginLaunch(now: 10)
        XCTAssertTrue(g.judge(CUMoveQuery(app: 800, space: 100, appStartedAt: 10.5, appBundle: "com.example.new"), now: 11).isUsers,
                      "nothing launched yet: theirs")
        g.setLaunchBundle(launch, "com.example.new")
        XCTAssertFalse(g.judge(CUMoveQuery(app: 801, space: 100, appStartedAt: 10.6, appBundle: "com.example.new"), now: 11.1).isUsers)
        XCTAssertTrue(g.judge(CUMoveQuery(app: 802, space: 100, appStartedAt: 10.7, appBundle: "com.other"), now: 11.2).isUsers,
                      "another app the user started meanwhile")
        XCTAssertTrue(g.judge(CUMoveQuery(app: 803, space: 100, appStartedAt: 2, appBundle: "com.example.new"), now: 11.3).isUsers,
                      "started before the launch")
        g.endLaunch(launch, pid: 801, now: 12)
        XCTAssertFalse(g.isTouched(801, now: 12 + CUFocusGuardianCore.causalWindow + 0.1))
        XCTAssertTrue(g.isTouched(801, now: 13))
    }

    /// An operation that runs long (an AppleScript) keeps its app touched throughout — review of round 7 (MEDIUM 4).
    func testAnAppIsTouchedWhileAnOperationOnItRuns() {
        var g = started()
        g.beginSpan(500, now: 0)
        XCTAssertTrue(g.isTouched(500, now: 100))
        g.endSpan(500, now: 120)
        XCTAssertTrue(g.isTouched(500, now: 121))
        XCTAssertFalse(g.isTouched(500, now: 122))
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
        XCTAssertFalse(core.guardianTouched(500, now: now), "a bound target's app with nothing done to it: not touched")
        core.noteGuardianActed(500)
        XCTAssertTrue(core.guardianTouched(500, now: now + 0.5), "0.5 s after an act on it")
        XCTAssertFalse(core.guardianTouched(500, now: now + 5), "5 s after: the user's")
        core.noteGuardianOpened(77)
        XCTAssertTrue(core.guardianTouched(77, now: now + 1), "a document opened in it a second ago")
        XCTAssertFalse(core.guardianTouched(1, now: now + 1), "never a cause for an app the agent did nothing to")
    }

    func testAnActivationLongAfterTheLastActIsTheUsersOneRightAfterItIsUndone() {
        let (core, sys, _) = guardWorld()
        core.noteGuardianPrivatePath(true)
        core.scriptActivity(sessionId: "s", active: true)
        defer { core.stopGuardian() }
        core.guardianLock.withLock { core.guardianCore.noteCause(500, now: core.clock.nowSeconds() - 5) }  // the last act on it, 5 s ago
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
        core.guardianLock.withLock { core.guardianCore.noteCause(500, now: core.clock.nowSeconds() - 4) }
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
        core.switchInputObservableOverride = true
        core.noteGuardianActed(500)
        // A three-finger swipe to the target's desktop right after an act on it: the swipe's own events.
        core.noteTapEvent(type: CGEventType(rawValue: 31)!, sourcePid: 0, userData: 0, now: core.clock.nowSeconds())
        sys.space = 300
        sys.front = 500
        core.onSpaceChange()
        XCTAssertTrue(sys.activated.isEmpty)
        // Without it, the same change is the agent's: undone.
        let (core2, sys2, _) = guardWorld()
        core2.noteGuardianPrivatePath(true)
        core2.scriptActivity(sessionId: "s", active: true)
        defer { core2.stopGuardian() }
        core2.switchInputObservableOverride = true
        core2.noteGuardianActed(500)
        // A two-finger scroll in their own app (the generic gesture type comes with it): no switch.
        core2.noteTapEvent(type: CGEventType(rawValue: 29)!, sourcePid: 0, userData: 0, now: core2.clock.nowSeconds())
        core2.noteTapEvent(type: .scrollWheel, sourcePid: 0, userData: 0, now: core2.clock.nowSeconds())
        sys2.space = 300
        sys2.front = 500
        core2.onSpaceChange()
        XCTAssertEqual(sys2.activated.last, 1)
    }

    // MARK: the user's own click into the agent's app (a listen-only left-mouse-down observer)

    func testAClickClaimsTheActivationItCausesWhateverTheTiming() {
        var g = CUFocusGuardianCore()
        g.begin(view: CUGuardedView(app: 1, space: 100))
        g.noteCause(500, now: 9.9)
        g.userClicked(app: 500, space: 100, now: 10)
        XCTAssertEqual(g.view, CUGuardedView(app: 500, space: 100), "the user's app is the clicked one at once")
        // The app activates a second later — on the desktop the click took them to: theirs.
        XCTAssertTrue(g.judge(CUMoveQuery(app: 500, space: 200), now: 11).isUsers)
        // After that, a touched app's activation is undone back to the CLICKED app's place, not the old one.
        g.noteCause(7, now: 11.1)
        XCTAssertFalse(g.judge(CUMoveQuery(app: 7, space: 200), now: 11.2).isUsers)
        XCTAssertEqual(g.view.app, 500)
    }

    /// Item 7 — review of round 7: a claim outlived the user leaving: they clicked into the target, went back within
    /// 1.5 s, and the target activating itself was taken for their move. Their move elsewhere uses it up.
    func testAClicksClaimIsGoneOnceTheyMoveElsewhere() {
        var h = CUFocusGuardianCore()
        h.begin(view: CUGuardedView(app: 1, space: 100))
        h.userClicked(app: 500, space: 100, now: 10)
        h.noteCause(500, now: 10.1)
        XCTAssertTrue(h.judge(CUMoveQuery(app: 1, space: 100), now: 10.2).isUsers, "they went back to their app")
        XCTAssertFalse(h.judge(CUMoveQuery(app: 500, space: 100), now: 10.4).isUsers,
                       "within the claim's window, but they had moved elsewhere: the target activating itself is undone")
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
        core.guardianLock.withLock { core.guardianCore.noteCause(800, now: core.clock.nowSeconds()) }  // the thief: an app the agent touched
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
        core.guardianRestore(thief: 800, fallback: CUGuardedView(app: 500, space: 100), cause: "test")
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
        core.guardianRestore(thief: 800, fallback: CUGuardedView(app: 500, space: 100), cause: "test")
        XCTAssertEqual(sys.frontmostPid(), 500, "put back")
        XCTAssertTrue(ax.written.contains("500:\(kAXFrontmostAttribute)"))
        XCTAssertTrue(core.takeGuardianNotes().first?.hasSuffix("tried to come to the front; you were put back") ?? false)
    }

    func testTheRestoreGivesUpAtTheDeadline() {
        let (core, sys) = retryWorld(refusals: -1)
        let start = Date()
        core.guardianRestore(thief: 800, fallback: CUGuardedView(app: 500, space: 100), cause: "test")
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
