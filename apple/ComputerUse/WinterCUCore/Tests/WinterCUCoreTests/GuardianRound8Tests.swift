import ApplicationServices
import CoreGraphics
import XCTest
@testable import WinterCUCore

/// Round 8: the review of round 7 (items 3–6) and what the model-based test (`GuardianModelTests`) found — one directed
/// test each, on the pure rule or on the live wiring over fakes.
final class GuardianRound8Tests: XCTestCase {
    private func started(app: pid_t = 1, space: UInt64 = 100) -> CUFocusGuardianCore {
        var g = CUFocusGuardianCore()
        g.begin(view: CUGuardedView(app: app, space: space))
        return g
    }

    private func judge(_ g: inout CUFocusGuardianCore, _ app: pid_t, _ space: UInt64 = 100, since: TimeInterval? = nil,
                       now: TimeInterval) -> CUMoveOwner {
        g.judge(CUMoveQuery(app: app, space: space, since: since), now: now)
    }

    /// The user ⌘-Tabbing, as the session tap sees it.
    private func commandTab(_ core: CUCore) {
        core.switchInputObservableOverride = true
        let now = core.clock.nowSeconds()
        core.noteTapEvent(type: .flagsChanged, sourcePid: 0, userData: 0, flags: .maskCommand, now: now)
        core.noteTapEvent(type: .flagsChanged, sourcePid: 0, userData: 0, flags: [], now: now)
    }

    /// The user (pid 1) in front on desktop 100; the agent's target 500 and a third app 77; the guardian running.
    private func world() -> (CUCore, FakeSystem) {
        let (core, sys, _) = worldAX()
        return (core, sys)
    }

    private func worldAX() -> (CUCore, FakeSystem, FakeAX) {
        let sys = FakeSystem()
        sys.running = [1, 77, 500]; sys.front = 1; sys.space = 100
        sys.windows[71] = FakeSystem.window(71, pid: 77, CGRect(x: 1000, y: 0, width: 400, height: 300))
        sys.windows[77] = FakeSystem.window(77, pid: 500, CGRect(x: 500, y: 0, width: 400, height: 300))
        sys.windows[31] = FakeSystem.window(31, pid: 1, CGRect(x: 0, y: 0, width: 400, height: 300))
        sys.stack = [sys.windows[31]!, sys.windows[77]!, sys.windows[71]!]
        let ax = FakeAX()
        let core = CUCore(events: nil, clock: CUSystemClock(), skyLight: .none, poster: RecordingPoster(), ax: ax, sys: sys,
                          pasteboard: { PasteAndQueueTests.FakePasteboard([]) }, startMonitors: false)
        core.registerForTesting(CUTarget(id: "t1", sessionId: "s", pid: 500, bundleId: "com.apple.finder", appName: "Finder",
                                         isChromium: false, mirror: false, windowID: 77, windowTitle: ""), windowElement: nil)
        core.switchInputObservableOverride = true
        XCTAssertTrue(core.startGuardian(privatePath: true))
        return (core, sys, ax)
    }

    // MARK: the review of round 7

    /// Item 3 (HIGH): an AppleScript's after-check restored from the app in front when it BEGAN — over whatever the user
    /// had done during it (up to 180 s). It is judged by the one rule, and put back to the user's place as it is now.
    func testAnAppleScriptPutsATheftBackToTheUsersPlaceAsItIsNow() async throws {
        let (core, sys) = world()
        defer { core.stopGuardian() }
        core.automationPermissionOverride = { _ in OSStatus(noErr) }
        core.appleScriptOverride = { _, _ in
            // During the run the user clicks into Mail (77) — their move…
            _ = core.onPhysicalClick(at: CGPoint(x: 1100, y: 100), userData: 0, now: core.clock.nowSeconds())
            sys.front = 77
            core.onActivation(pid: 77)
            // …then the script makes the target activate itself.
            sys.front = 500
            return "ok"
        }
        _ = try? await core.targetAppleScript(TargetAppleScriptParams(targetId: "t1", source: "tell application \"Finder\" to get name"))
        XCTAssertEqual(sys.activated.last, 77, "put back to Mail — where they went during the run, never to the app it began in")
    }

    /// Item 3 (HIGH): a launch was never a cause — an app the bind launched that activated itself during it was "an app the
    /// agent never touched", the user's. Its process starting after the launch began makes it the agent's.
    func testAnAppTheBindLaunchedThatActivatesItselfIsUndone() async throws {
        let (core, sys, ax) = worldAX()
        defer { core.stopGuardian() }
        let launched: pid_t = 4747
        let el = fakeElement(94_747)
        ax.add(el, role: kAXWindowRole, title: "New", frame: CGRect(x: 0, y: 500, width: 300, height: 200))
        ax.windowIDs[AXIdentity(element: el)] = 47
        ax.put(ax.application(launched), [kAXWindowsAttribute: [el]])
        sys.windows[47] = FakeSystem.window(47, pid: launched, CGRect(x: 0, y: 500, width: 300, height: 200))
        core.resolveBindApp = { _, core in
            core.noteGuardianLaunchBundle("com.example.new")
            sys.running.insert(launched)
            sys.bundles[launched] = "com.example.new"
            sys.ages[launched] = 0.01  // its process just started
            // It activates itself while the bind waits for its window.
            sys.front = launched
            core.onActivation(pid: launched)
            return CUCore.BindApp(pid: launched, bundleIdentifier: "com.example.new", name: "New", executableName: "New",
                                  isChromium: false, launched: true, running: nil)
        }
        _ = try? await core.targetBind(TargetBindParams(sessionId: "s", app: "New", mirror: false))
        XCTAssertEqual(sys.activated.first, 1, "the user's app put back")
    }

    /// Item 4 (MEDIUM): a long act's after-check saw only the last second of input. While guarding, the observers judge a
    /// change as it comes — the user's ⌘-Tab into the target during a long run is their place by its end.
    func testAMoveOfTheirsDuringALongRunIsTheirPlaceAtItsEnd() async throws {
        let (core, sys) = world()
        defer { core.stopGuardian() }
        core.automationPermissionOverride = { _ in OSStatus(noErr) }
        core.appleScriptOverride = { _, _ in
            self.commandTab(core)
            sys.front = 500
            core.onActivation(pid: 500)
            Thread.sleep(forTimeInterval: 1.2)  // the run goes on, long past the second
            return "ok"
        }
        _ = try? await core.targetAppleScript(TargetAppleScriptParams(targetId: "t1", source: "tell application \"Finder\" to get name"))
        XCTAssertTrue(sys.activated.isEmpty, "never pulled back out of the app they switched into")
        XCTAssertEqual(core.guardianPlace()?.app, 500)
    }

    /// Item 6 (MEDIUM): a desktop change was the agent's whenever ANY app had been acted on — the user's swipe to Mail's
    /// desktop while the agent worked on the target was pulled back. Judged by the app in front: Mail, never touched.
    func testADesktopChangeIsJudgedByTheAppItBringsForward() {
        let (core, sys) = world()
        defer { core.stopGuardian() }
        core.noteGuardianActed(500)  // the agent acting on the target, just now
        sys.space = 200
        sys.front = 77
        core.onSpaceChange()
        XCTAssertTrue(sys.activated.isEmpty)
        XCTAssertEqual(core.guardianPlace(), CUGuardedView(app: 77, space: 200))
    }

    /// Item 6: a plain click on a window of an app that is not in front is input that can switch — for THAT app only.
    func testAClickOnAnotherAppsWindowCountsForThatAppOnly() {
        let (core, sys) = world()
        defer { core.stopGuardian() }
        core.noteGuardianActed(500)
        XCTAssertEqual(core.onPhysicalClick(at: CGPoint(x: 1100, y: 100), userData: 0, now: core.clock.nowSeconds()), 77)
        XCTAssertEqual(core.guardianPlace()?.app, 77, "their place at once")
        // The target coming forward right after is not explained by a click on Mail's window.
        sys.front = 500
        core.onActivation(pid: 500)
        XCTAssertEqual(sys.activated.last, 77, "undone — and put back to Mail, where their click took them")
        // A ⌘-click works a window in the background: no move.
        sys.front = 1
        let (core2, _) = world()
        defer { core2.stopGuardian() }
        XCTAssertNil(core2.onPhysicalClick(at: CGPoint(x: 1100, y: 100), userData: 0, flags: .maskCommand, now: core2.clock.nowSeconds()))
    }

    // MARK: what the model-based test found

    /// A restore's retries went on toward the place captured when it began — 22 ms after the user's Dock click to another
    /// app, a retry pulled them back out. Another app in front while it waits is judged first; their move ends it.
    func testARestoreNeverRetriesOverAMoveOfTheirs() {
        let sys = FakeSystem()
        sys.running = [500, 800, 77]; sys.front = 800; sys.space = 100
        let core = CUCore(events: nil, clock: CUSystemClock(), skyLight: .none, poster: RecordingPoster(), ax: FakeAX(), sys: sys,
                          pasteboard: { PasteAndQueueTests.FakePasteboard([]) }, startMonitors: false)
        core.restoreDeadlineMs = 400
        core.restoreRetryMs = 40
        core.guardianLock.withLock { core.guardianCore.noteCause(800, now: core.clock.nowSeconds()) }
        let lock = NSLock()
        var moved = false
        var afterMove = 0
        sys.onActivate = { pid in
            guard pid == 500 else { return }
            if lock.withLock({ moved }) { lock.withLock { afterMove += 1 }; return }
            sys.front = 800  // the thief takes the front back each time…
        }
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.1) {
            lock.withLock { moved = true }
            sys.front = 77  // …until the user goes to Mail (never touched)
        }
        core.guardianRestore(thief: 800, fallback: CUGuardedView(app: 500, space: 100), cause: "test")
        XCTAssertEqual(sys.frontmostPid(), 77, "left in Mail")
        XCTAssertEqual(lock.withLock { afterMove }, 0, "no retry after their move")
    }

    /// An operation's END was a new cause: input of the user's during it (their Dock click into the target, a moment
    /// before an AppleScript ended) became "before the agent's last cause", and their move was undone.
    func testAnOperationsEndNeverOutranksInputDuringIt() {
        var g = started()
        g.beginSpan(500, now: 1)
        g.noteSwitch(now: 3.2)  // their Dock click
        g.endSpan(500, now: 3.3)
        XCTAssertTrue(judge(&g, 500, now: 3.35).isUsers)
        // And the end still keeps the app touched: a self-activation a moment later with no input is undone.
        var h = started()
        h.beginSpan(500, now: 1)
        h.endSpan(500, now: 3.3)
        XCTAssertFalse(judge(&h, 500, now: 4).isUsers)
    }

    /// A theft already seen, judged again when new input arrives: input that came after it was seen can't have caused it
    /// (the user's Dock click a moment after the target took the front made the theft "theirs").
    func testInputAfterAStateWasSeenNeverExplainsIt() {
        var g = started()
        g.noteCause(500, now: 1)
        XCTAssertFalse(judge(&g, 500, now: 1.1).isUsers)
        g.noteSwitch(now: 1.2)  // their Dock click, after
        XCTAssertFalse(judge(&g, 500, now: 1.25).isUsers, "still the agent's")
        // A click into ITS window does claim it (they chose it).
        g.userClicked(app: 500, space: 100, now: 1.3)
        XCTAssertEqual(judge(&g, 500, now: 1.35), .theirPlace)
    }

    /// What the agent does to an app while it is in front can't have brought it forward: an act begun 70 ms after the user's
    /// ⌘-Tab into the target, before the guardian heard of it, made their move the agent's.
    func testAnActOnTheFrontAppNeverMakesTheMoveThatPutItThereTheAgents() {
        let (core, sys) = world()
        defer { core.stopGuardian() }
        core.noteGuardianActed(500)  // the agent worked on the target in the background…
        Thread.sleep(forTimeInterval: 0.01)
        commandTab(core)             // …and the user ⌘-Tabs into it
        sys.front = 500
        core.noteGuardianActed(500)  // the act begins: the target is in front already
        core.onActivation(pid: 500)
        XCTAssertTrue(sys.activated.isEmpty, "their move")
        // Once it has left the front, what was done to it counts: it coming back by itself is undone.
        sys.front = 1
        core.onActivation(pid: 1)
        sys.front = 500
        core.onActivation(pid: 500)
        XCTAssertEqual(sys.activated.last, 1)
    }

    /// Bringing the user back to their place never touches their app: their own move back into it later needs no input
    /// (under Secure Event Input their ⌃-arrow back to it was undone).
    func testARestoreNeverTouchesTheUsersOwnApp() {
        let (core, sys) = world()
        defer { core.stopGuardian() }
        core.noteGuardianActed(500)
        sys.front = 500
        core.onActivation(pid: 500)
        XCTAssertEqual(sys.activated.last, 1, "put back")
        XCTAssertFalse(core.guardianTouched(1), "their own app is not the agent's to undo")
    }

    /// Each switch input fits what it can switch: a desktop switch never explains an app coming forward on the desktop that
    /// was already shown — judged against the state before the change, not a place the rule could not update.
    func testADesktopSwitchNeverExplainsAnAppChangeOnTheSameDesktop() {
        var g = started(app: 9, space: 200)
        _ = judge(&g, 9, 100, now: 1)  // a move of theirs the rule took as the agent's (9 untouched here: theirs)
        g.noteCause(500, now: 1.5)
        g.inputEvent(type: CGEventType(rawValue: 31)!, flags: [], now: 1.6)  // a swipe that has not landed yet
        XCTAssertFalse(judge(&g, 500, 100, now: 1.7).isUsers, "on the desktop already shown: no swipe explains it")
        XCTAssertTrue(judge(&g, 500, 300, now: 1.9).isUsers, "on the swipe's desktop: theirs")
    }

    /// An app the agent never touched came forward, and a touched one right after, before the guardian heard of either:
    /// the restore went to the place it knew before both (the model-based test). The first activation, heard of late, is
    /// still the user's — their place — and the theft is put back THERE.
    func testAnUntouchedActivationHeardLateIsStillTheirPlace() {
        let (core, sys) = world()
        defer { core.stopGuardian() }
        core.noteGuardianActed(500)
        sys.front = 77   // Mail comes forward (never touched)…
        sys.front = 500  // …and the target takes the front 5 ms later
        core.onActivation(pid: 77)
        XCTAssertEqual(sys.activated.last, 77, "put back to Mail, their place by then — not to the app before it")
        core.onActivation(pid: 500)
        XCTAssertEqual(core.guardianPlace()?.app, 77)
    }

    /// During a desktop visit the agent acts in front: an app its click brings up there is the visit's, never "the user
    /// moved" (the visit would have left them on that app's desktop).
    func testDuringAVisitAnAppTheAgentsActBroughtUpIsTheVisits() {
        var g = started()
        g.beginVisit(app: 500, user: 1, now: 1)
        XCTAssertEqual(judge(&g, 77, 300, now: 1.5), .visit)
        XCTAssertFalse(g.visitSawUserInput)
    }
}
