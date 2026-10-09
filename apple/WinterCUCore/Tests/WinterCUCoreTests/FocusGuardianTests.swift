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
        // The victim (500) is restored to the front.
        XCTAssertEqual(sys.activated.last, 500)
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
