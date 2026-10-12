import ApplicationServices
import CoreGraphics
import XCTest
@testable import WinterCUCore

/// Round 14's queue item 1 (live, helper 1.10.0): after the agent's click in Chrome, another agent session's `open <url>`
/// (Safari) and its Terminal came forward and were undone as the agent's indirect effect. An opener act now says WHICH
/// apps it can open; an app outside every opener's scope coming forward is never clearly the agent's.
final class Round14Tests: XCTestCase {
    private func started() -> CUFocusGuardianCore {
        var g = CUFocusGuardianCore()
        g.begin(view: CUGuardedView(app: 1, space: 100))
        return g
    }

    private func judge(_ g: inout CUFocusGuardianCore, _ app: pid_t, bundle: String?, now: TimeInterval) -> CUMoveOwner {
        g.judge(CUMoveQuery(app: app, space: 100, appBundle: bundle), now: now)
    }

    /// A third party's activation right after a click in a browser — an app the click can't open — is left in front
    /// and said, never undone; the browser's own scope is the browser.
    func testAThirdPartysActivationRightAfterAClickInABrowserIsNeverUndone() {
        var g = started()
        g.noteCause(500, now: 10.0)
        g.noteOpenerCause(now: 10.0, scope: .apps(["com.google.Chrome"]))
        let terminal = judge(&g, 77, bundle: "com.apple.Terminal", now: 10.3)
        XCTAssertFalse(terminal.undoes, "\(terminal)")
        if case .unexplained = terminal {} else { XCTFail("left in front and said: \(terminal)") }
        var h = started()
        h.noteCause(500, now: 10.0)
        h.noteOpenerCause(now: 10.0, scope: .apps(["com.google.Chrome"]))
        XCTAssertFalse(judge(&h, 78, bundle: nil, now: 10.3).undoes, "an unknown app: only an act that opens any app covers it")
    }

    /// What the act CAN open — the default browser after a click in a non-browser app — is still its indirect effect.
    func testWhatTheActCanOpenIsStillItsIndirectEffect() {
        var g = started()
        g.noteCause(500, now: 10.0)
        g.noteOpenerCause(now: 10.0, scope: .apps(["com.example.editor", "com.apple.Safari"]))
        if case .indirect = judge(&g, 77, bundle: "com.apple.Safari", now: 10.3) {} else { XCTFail("the link it opened") }
        // An act that can open any app (Finder): as before.
        var h = started()
        h.noteCause(500, now: 10.0)
        h.noteOpenerCause(now: 10.0)
        if case .indirect = judge(&h, 77, bundle: nil, now: 10.3) {} else { XCTFail("Finder opens any app") }
    }

    /// The ruled launch attribution (round 16, §4.12): a cold launch right after an opener act, no input of the user's,
    /// OUT of the act's reach (another session's `open -a`, a dev server's Chrome): LEFT in front and said — never undone,
    /// never adopted (round 14's test, restored: the round-15 "any reach" undid third parties' launches).
    func testAColdLaunchOutOfReachRightAfterAnActIsLeftNeverUndone() {
        var g = started()
        g.noteCause(500, now: 10.0)
        g.noteOpenerCause(now: 10.0, scope: .apps(["com.apple.mail", "com.apple.Safari"]))
        g.appLaunched(88, startedAt: 10.2, bundle: "us.zoom.xos", now: 10.25)
        let v = judge(&g, 88, bundle: "us.zoom.xos", now: 11.0)
        if case .unexplained = v {} else { XCTFail("left in front and said: \(v)") }
        XCTAssertEqual(g.view.app, 1, "never adopted")
    }

    /// (2) WITHIN the act's reach, no input of the user's: clearly the agent's — undone.
    func testAColdLaunchWithinReachRightAfterAnActIsUndone() {
        var g = started()
        g.noteCause(500, now: 10.0)
        g.noteOpenerCause(now: 10.0, scope: .apps(["com.apple.mail", "com.apple.Safari"]))
        g.appLaunched(89, startedAt: 10.2, bundle: "com.apple.Safari", now: 10.25)
        let v = judge(&g, 89, bundle: "com.apple.Safari", now: 11.0)
        if case .indirect = v {} else { XCTFail("undone: \(v)") }
    }

    /// (1) Input of the user's BETWEEN the act and the process start (their Spotlight Return): their own launch — adopted.
    func testAColdLaunchAfterTheUsersInputIsTheirs() {
        var g = started()
        g.noteCause(500, now: 10.0)
        g.noteOpenerCause(now: 10.0, scope: .apps(["com.apple.mail"]))
        g.noteHardwareAction(now: 10.1)
        g.appLaunched(90, startedAt: 10.2, bundle: "com.apple.Notes", now: 10.25)
        let v = judge(&g, 90, bundle: "com.apple.Notes", now: 11.0)
        XCTAssertTrue(v.isUsers, "\(v)")
        XCTAssertEqual(g.view.app, 90, "their place")
    }

    /// (3) A left app the user then types in: their place — a restore never pulls them out of it.
    func testTypingInALeftAppMakesItTheirPlace() {
        var g = started()
        g.noteCause(500, now: 10.0)
        g.noteOpenerCause(now: 10.0, scope: .apps(["com.apple.mail"]))
        g.appLaunched(91, startedAt: 10.2, bundle: "us.zoom.xos", now: 10.25)
        _ = judge(&g, 91, bundle: "us.zoom.xos", now: 11.0)
        XCTAssertEqual(g.view.app, 1)
        g.userInputInFront(91, now: 12.0)
        XCTAssertEqual(g.view.app, 91, "their place now")
    }

    /// …and, when not clearly so (input of the user's just before), left in front and said — NEVER adopted as the user's
    /// own launch (the round-14 code adopted it).
    func testAColdLaunchAfterAnActIsNeverAdopted() {
        var g = started()
        g.noteHardwareAction(now: 9.5)
        g.noteCause(500, now: 10.0)
        g.noteOpenerCause(now: 10.0, scope: .apps(["com.apple.mail", "com.apple.Safari"]))
        g.appLaunched(88, startedAt: 10.2, bundle: "us.zoom.xos", now: 10.25)
        let v = judge(&g, 88, bundle: "us.zoom.xos", now: 11.0)
        if case .unexplained = v {} else { XCTFail("left in front and said: \(v)") }
        XCTAssertEqual(g.view.app, 1, "never adopted")
    }

    /// Review of round 14, MEDIUM #4: a bind of a RUNNING app names its bundle — its pending launch reaches only it, never
    /// a third party's Terminal coming forward meanwhile.
    func testABindOfARunningAppReachesOnlyIt() {
        var g = started()
        let token = g.beginLaunch(now: 10)
        g.setLaunchBundle(token, "com.example.bound")
        g.noteOpenerCause(now: 10, scope: .apps(["com.example.bound"]))
        let v = judge(&g, 77, bundle: "com.apple.Terminal", now: 10.4)
        XCTAssertFalse(v.undoes, "\(v)")
        if case .unexplained = v {} else { XCTFail("left in front and said: \(v)") }
    }

    /// The same through the REAL bind path (review of round 15, LOW: the test above set the bundle by hand): the default
    /// `resolveBindApp` of a RUNNING app (Finder — a lookup only: nothing is launched, opened or activated) names its
    /// bundle on the bind's pending launch. A third party's Terminal coming forward meanwhile is left; Finder is in reach.
    func testABindOfARunningAppThroughTheRealResolverReachesOnlyIt() async throws {
        guard case .running = try CUApps.resolve("com.apple.finder") else { throw XCTSkip("Finder is not running") }
        let (c, _) = core(bundle: nil, browser: false)
        c.guardianLock.withLock { c.guardianCore.begin(view: CUGuardedView(app: 1, space: 100)) }
        let token = c.beginGuardianLaunch()
        let app = try await CUCore.$bindLaunchToken.withValue(token) { try await c.resolveBindApp("com.apple.finder", c) }
        XCTAssertFalse(app.launched, "a running app: nothing launched")
        let now = c.clock.nowSeconds() + 0.3
        let terminal = c.guardianLock.withLock {
            c.guardianCore.judge(CUMoveQuery(app: 77, space: 100, appBundle: "com.apple.Terminal"), now: now)
        }
        XCTAssertFalse(terminal.undoes, "\(terminal)")
        if case .unexplained = terminal {} else { XCTFail("left in front and said: \(terminal)") }
        let finder = c.guardianLock.withLock {
            c.guardianCore.judge(CUMoveQuery(app: 78, space: 100, appBundle: "com.apple.finder"), now: now + 0.1)
        }
        if case .indirect = finder {} else { XCTFail("the bound app is in the pending launch's reach: \(finder)") }
        c.endGuardianLaunch(token, pid: nil)
    }

    // MARK: the scope of an act

    private func core(bundle: String?, browser: Bool) -> (CUCore, CUTarget) {
        let core = CUCore(events: nil, clock: CUSystemClock(), skyLight: .none, poster: RecordingPoster(), ax: FakeAX(),
                          sys: FakeSystem(), pasteboard: { PasteAndQueueTests.FakePasteboard([]) }, startMonitors: false)
        core.isWebBrowserOverride = { _ in browser }
        core.defaultHandlerOverride = { ["http": "com.apple.Safari", "https": "com.apple.Safari", "mailto": "com.apple.mail"][$0] }
        let t = CUTarget(id: "t1", sessionId: "s", pid: 4242, bundleId: bundle, appName: "App", isChromium: browser,
                         mirror: false, windowID: 77, windowTitle: "Docs")
        return (core, t)
    }

    func testTheScopeOfAnAct() {
        let click = CUAction.click(CUClickAction(ref: 1))
        let (b, chrome) = core(bundle: "com.google.Chrome", browser: true)
        XCTAssertEqual(b.openerScope(click, chrome), .apps(["com.google.Chrome", "com.apple.mail"]),
                       "a browser's web links stay in it; its mailto: opens the mail app; Reveal in Finder (review of round 14, MEDIUM #2)")
        XCTAssertEqual(b.openerScope(.menu(CUMenuAction(path: ["Help", "Chrome Help"])), chrome),
                       .apps(["com.google.Chrome", "com.apple.Safari", "com.apple.mail", "com.apple.helpviewer"]),
                       "a menu command: the same list as a click, the Help viewer too")
        let (e, editor) = core(bundle: "com.example.editor", browser: false)
        XCTAssertEqual(e.openerScope(click, editor), .apps(["com.example.editor", "com.apple.Safari", "com.apple.mail"]),
                       "a link in it opens the default browser or mail app")
        // Finder only for an act that can reveal in it (review of round 15, MEDIUM #3b).
        XCTAssertTrue(e.openerScope(.menu(CUMenuAction(path: ["File", "Show in Finder"])), editor).covers("com.apple.finder"))
        let (f, finder) = core(bundle: "com.apple.finder", browser: false)
        XCTAssertEqual(f.openerScope(click, finder), .any, "Finder opens documents in any app")
        let (u, unknown) = core(bundle: nil, browser: false)
        XCTAssertEqual(u.openerScope(click, unknown), .any)
        XCTAssertFalse(CUOpenerScope.apps(["com.google.Chrome"]).covers("com.apple.Terminal"))
        XCTAssertFalse(CUOpenerScope.apps(["com.google.Chrome"]).covers(nil))
        XCTAssertTrue(CUOpenerScope.any.covers(nil))
    }

    // MARK: review of round 13, MEDIUM #3 — the visit's exception

    /// The front-app refusals step aside only inside a visit that has ARRIVED, and only for the visit's own app and
    /// window — never while the switch is under way, never for another target of the session.
    func testTheVisitsExceptionNeedsAnArrivedVisitForThatTarget() {
        let sys = FakeSystem()
        let core = CUCore(events: nil, clock: CUSystemClock(), skyLight: .none, poster: RecordingPoster(), ax: FakeAX(),
                          sys: sys, pasteboard: { PasteAndQueueTests.FakePasteboard([]) }, startMonitors: false)
        var w = FakeSystem.window(77, pid: 4242, CGRect(x: 0, y: 0, width: 800, height: 600), owner: "Far")
        w.onScreen = true
        sys.windows[77] = w
        var o = FakeSystem.window(88, pid: 4343, CGRect(x: 0, y: 0, width: 800, height: 600), owner: "Other")
        o.onScreen = true
        sys.windows[88] = o
        sys.space = 2
        let t = CUTarget(id: "t1", sessionId: "s", pid: 4242, bundleId: "com.example.far", appName: "Far", isChromium: false,
                         mirror: false, windowID: 77, windowTitle: "Far")
        let other = CUTarget(id: "t2", sessionId: "s", pid: 4343, bundleId: "com.example.other", appName: "Other", isChromium: false,
                             mirror: false, windowID: 88, windowTitle: "Other")
        let base = CUCore.VisitBase(sessionId: "s", callId: "c", targetId: "t1", pid: 4242, windowID: 77, appName: "Far", why: .act,
                                    before: CUUserView(space: 1, front: 1), userWindow: nil, userWindowID: nil,
                                    privatePath: true, startedMs: 0, startedAt: 0)
        let v = CUOpenVisit(id: "v1", base: base)
        core.visitLock.withLock { core.openVisit = v }
        XCTAssertFalse(core.insideArrivedVisit(t), "not arrived yet")
        core.visitLock.withLock { v.arrived = CUUserView(space: 2, front: 4242) }
        XCTAssertTrue(core.insideArrivedVisit(t))
        XCTAssertFalse(core.insideArrivedVisit(other), "another target of the session")
        sys.space = 1
        XCTAssertFalse(core.insideArrivedVisit(t), "not on the visited desktop")
    }

    // MARK: review of round 13, the missing tests

    /// Round 13 (seed 1067): a click into the app already in front is a QUIET instant — it explains only that app's own
    /// change, and is no switch input by itself (`lastAt` stays).
    func testAQuietInstantExplainsOnlyItsOwnApp() {
        var input = CUSwitchInput()
        input.note(10, .app, target: 500, quiet: true)
        XCTAssertEqual(input.lastAt, -1, "no switch input by itself")
        XCTAssertNotNil(input.explanation(from: 9, after: -.infinity, raiseAfter: -.infinity, now: 10.1, front: 500), "its own app")
        XCTAssertNil(input.explanation(from: 9, after: -.infinity, raiseAfter: -.infinity, now: 10.1, front: 600), "never another app")
    }

    // MARK: item 1, finished

    /// Opens and launches reach the app they open (round 14): a pending launch of A, or its opener cause, never makes
    /// an untouched B "clearly the agent's".
    func testALaunchReachesOnlyTheAppItLaunches() {
        var g = started()
        let token = g.beginLaunch(now: 10)
        g.setLaunchBundle(token, "com.example.a")
        g.noteOpenerCause(now: 10, scope: .apps(["com.example.a"]))
        XCTAssertTrue(g.clearlyAt(10.5, hardwareAt: nil, bundle: "com.example.a"))
        XCTAssertFalse(g.clearlyAt(10.5, hardwareAt: nil, bundle: "com.example.b"), "another app")
        g.endLaunch(token, pid: 77, now: 11)
        XCTAssertFalse(g.clearlyAt(11.2, hardwareAt: nil, bundle: "com.example.b"))
    }

    /// The opt-in survey's seed 11: the user clicks into the app held in front (a consented foreground) while an app
    /// left in front sits between — their choice: the hold's end gives nothing back over it.
    func testTheUsersClickIntoTheHeldAppKeepsItAtTheHoldsEnd() {
        var g = started()
        g.noteCause(600, raise: true, now: 10)
        g.exempt(600, until: 40, now: 10)
        XCTAssertEqual(g.judge(CUMoveQuery(app: 600, space: 100), now: 10.1), .consented)
        // An untouched app comes forward around the agent's action: left in front, not their place.
        g.noteOpenerCause(now: 12)
        _ = g.judge(CUMoveQuery(app: 700, space: 100, appBundle: "com.example.other"), now: 12.2)
        // Their click into the held app's window brings it back.
        g.userClicked(app: 600, space: 100, now: 14)
        _ = g.judge(CUMoveQuery(app: 600, space: 100), now: 14.05)
        g.endExempt(600, now: 15)
        XCTAssertEqual(g.view.app, 600, "nothing given back over their click")
    }
}
