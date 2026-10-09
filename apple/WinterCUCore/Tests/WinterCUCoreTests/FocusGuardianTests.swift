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
        let v = g.handle(CUActivation(app: 42, space: 200, hadRecentUserInput: true), now: 1)
        XCTAssertEqual(v, .userSwitch)
        XCTAssertEqual(g.view, CUGuardedView(app: 42, space: 200), "the user's own switch updates the tracked view")
        // A later theft now restores to 42/200, the user's new app and desktop.
        let t = g.handle(CUActivation(app: 99, space: 300, hadRecentUserInput: false), now: 2)
        XCTAssertEqual(t, .theft(restore: CUGuardedView(app: 42, space: 200), thief: 99, repeatOffender: false))
    }

    func testAnActivationWithNoRecentInputIsTheftWhateverTheApp() {
        var g = started()
        // Our own synthetic activation is never the user, even if input looks recent.
        let synthetic = g.handle(CUActivation(app: 7, hadRecentUserInput: true, fromSyntheticEvent: true), now: 1)
        XCTAssertEqual(synthetic, .theft(restore: CUGuardedView(app: 1, space: 100), thief: 7, repeatOffender: false))
        let t = g.handle(CUActivation(app: 8, hadRecentUserInput: false), now: 2)
        if case .theft(let r, let thief, _) = t { XCTAssertEqual(r.app, 1); XCTAssertEqual(thief, 8) } else { XCTFail() }
    }

    func testTheConsentedForegroundRungIsTheOnlyExemption() {
        var g = started()
        g.exempt(55, until: 10)
        XCTAssertEqual(g.handle(CUActivation(app: 55, hadRecentUserInput: false), now: 5), .userSwitch, "exempt within the deadline")
        g = started()
        g.exempt(55, until: 10)
        XCTAssertEqual(g.handle(CUActivation(app: 55, hadRecentUserInput: false), now: 11).isTheft, true, "past the deadline it is theft")
        g = started()
        g.exempt(55, until: 10)
        XCTAssertEqual(g.handle(CUActivation(app: 66, hadRecentUserInput: false), now: 5).isTheft, true, "a different app is not exempt")
    }

    func testRepeatOffenderIsFlaggedAfterThreeInTenSeconds() {
        var g = started()
        XCTAssertEqual(g.handle(CUActivation(app: 9, hadRecentUserInput: false), now: 0).repeatFlag, false)
        XCTAssertEqual(g.handle(CUActivation(app: 9, hadRecentUserInput: false), now: 2).repeatFlag, false)
        XCTAssertEqual(g.handle(CUActivation(app: 9, hadRecentUserInput: false), now: 4).repeatFlag, true, "third within 10 s")
        // Outside the window the count resets.
        var h = started()
        _ = h.handle(CUActivation(app: 9, hadRecentUserInput: false), now: 0)
        _ = h.handle(CUActivation(app: 9, hadRecentUserInput: false), now: 2)
        XCTAssertEqual(h.handle(CUActivation(app: 9, hadRecentUserInput: false), now: 13).repeatFlag, false, "the first aged out")
    }

    func testTheSameAppStaysIgnoredAndAnIdleGuardianDoesNothing() {
        var g = started(app: 1, space: 100)
        XCTAssertEqual(g.handle(CUActivation(app: 1, space: 100, hadRecentUserInput: false), now: 1), .ignore)
        var idle = CUFocusGuardianCore()
        XCTAssertEqual(idle.handle(CUActivation(app: 9, hadRecentUserInput: false), now: 1), .ignore)
    }

    func testASpaceChangeWithoutInputIsRestoredAndWithInputIsTheUsers() {
        var g = started(space: 100)
        XCTAssertEqual(g.handleSpaceChange(to: 200, hadRecentUserInput: false, now: 1), CUGuardedView(app: 1, space: 100))
        var h = started(space: 100)
        XCTAssertNil(h.handleSpaceChange(to: 200, hadRecentUserInput: true, now: 1))
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
        // VRoid/Preview comes to the front a second after a window-targeted click.
        sys.front = 2203
        sys.space = 150
        core.onActivation(pid: 2203)
        XCTAssertEqual(sys.activated.last, 1, "the user's app put back")
        let notes = core.takeGuardianNotes()
        XCTAssertTrue(notes.contains { $0.contains("tried to come to the front; you were put back") }, "\(notes)")
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
    // MARK: the user's own click into the agent's app (ChatGPT's left-mouse-down observer)

    func testAClickClaimsTheActivationItCausesWhateverTheTiming() {
        var g = CUFocusGuardianCore()
        g.begin(view: CUGuardedView(app: 1, space: 100))
        g.userClicked(app: 500, space: 100, now: 10)
        XCTAssertEqual(g.view, CUGuardedView(app: 500, space: 100), "the user's app is the clicked one at once")
        // The app activates a second later — past the 0.4 s input window, with no recent input reported.
        XCTAssertEqual(g.handle(CUActivation(app: 500, space: 100, hadRecentUserInput: false), now: 11), .userSwitch)
        // After the claim, another app's activation is a theft that restores the CLICKED app, not the old one.
        guard case .theft(let restore, _, _) = g.handle(CUActivation(app: 7, hadRecentUserInput: false), now: 11.2)
        else { return XCTFail("expected a theft") }
        XCTAssertEqual(restore.app, 500)
    }

    func testAClicksClaimExpires() {
        var g = CUFocusGuardianCore()
        g.begin(view: CUGuardedView(app: 1, space: 100))
        g.userClicked(app: 500, space: 100, now: 10)
        g.end(); g.begin(view: CUGuardedView(app: 1, space: 100))  // a fresh guard: no claim
        XCTAssertNotEqual(g.handle(CUActivation(app: 500, hadRecentUserInput: false), now: 10.5), .userSwitch)
        var h = CUFocusGuardianCore()
        h.begin(view: CUGuardedView(app: 1, space: 100))
        h.userClicked(app: 500, space: 100, now: 10)
        _ = h.handle(CUActivation(app: 1, hadRecentUserInput: true), now: 10.2)  // the user went back to their app
        guard case .theft = h.handle(CUActivation(app: 500, hadRecentUserInput: false), now: 10 + CUFocusGuardianCore.clickClaimWindow + 0.1)
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
