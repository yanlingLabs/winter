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

    /// A cold launch is judged at its process start by the same scope.
    func testAColdLaunchOutsideTheScopeIsNotTheAgents() {
        var g = started()
        g.noteCause(500, now: 10.0)
        g.noteOpenerCause(now: 10.0, scope: .apps(["com.google.Chrome"]))
        g.appLaunched(88, startedAt: 10.2, bundle: "com.apple.Terminal", now: 10.25)
        XCTAssertFalse(judge(&g, 88, bundle: "com.apple.Terminal", now: 11.0).undoes)
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
        XCTAssertEqual(b.openerScope(click, chrome), .apps(["com.google.Chrome"]), "a browser's links stay in it")
        XCTAssertEqual(b.openerScope(.menu(CUMenuAction(path: ["Help", "Chrome Help"])), chrome),
                       .apps(["com.google.Chrome", "com.apple.Safari", "com.apple.helpviewer"]), "a Help menu item opens either")
        let (e, editor) = core(bundle: "com.example.editor", browser: false)
        XCTAssertEqual(e.openerScope(click, editor), .apps(["com.example.editor", "com.apple.Safari", "com.apple.mail"]),
                       "a link in it opens the default browser or mail app")
        let (f, finder) = core(bundle: "com.apple.finder", browser: false)
        XCTAssertEqual(f.openerScope(click, finder), .any, "Finder opens documents in any app")
        let (u, unknown) = core(bundle: nil, browser: false)
        XCTAssertEqual(u.openerScope(click, unknown), .any)
        XCTAssertFalse(CUOpenerScope.apps(["com.google.Chrome"]).covers("com.apple.Terminal"))
        XCTAssertFalse(CUOpenerScope.apps(["com.google.Chrome"]).covers(nil))
        XCTAssertTrue(CUOpenerScope.any.covers(nil))
    }
}
