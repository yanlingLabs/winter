import XCTest
@testable import WinterCUCore

/// Round 16's extended survey (seeds 1000–1079 on the launch rule's stricter oracle): two engine gaps it found.
final class Round16Tests: XCTestCase {
    private func started() -> CUFocusGuardianCore {
        var g = CUFocusGuardianCore()
        g.begin(view: CUGuardedView(app: 1, space: 100))
        return g
    }

    private func judge(_ g: inout CUFocusGuardianCore, _ app: pid_t, bundle: String?, now: TimeInterval,
                       secure: Bool = false) -> CUMoveOwner {
        g.judge(CUMoveQuery(app: app, space: 100, appBundle: bundle, secureInput: secure), now: now)
    }

    /// Seed 1051: the user typed in their Terminal under Secure Keyboard Entry (the tap saw none of it), then an app the
    /// agent's act could open came forward — Secure Event Input off by then, as the Terminal had left the front. Keys
    /// hidden within the quiet window: never clearly the agent's — left and said, never undone.
    func testHiddenKeysJustBeforeAnAppCameForwardAreNeverQuiet() {
        var g = started()
        _ = judge(&g, 2, bundle: "com.apple.Terminal", now: 9.0, secure: true)  // their Terminal in front, Secure Keyboard Entry on
        g.noteCause(500, now: 10.0)
        g.noteOpenerCause(now: 10.0, scope: .apps(["com.example.editor", "com.apple.Safari"]))
        let v = judge(&g, 77, bundle: "com.apple.Safari", now: 10.3)
        XCTAssertFalse(v.undoes, "\(v)")
        if case .unexplained = v {} else { XCTFail("left in front and said: \(v)") }
        // Secure Event Input on long before the window and never read since: still on, as far as anyone knows.
        var h = started()
        h.noteSecureInput(true, now: 1.0)
        h.noteCause(500, now: 10.0)
        h.noteOpenerCause(now: 10.0, scope: .apps(["com.apple.Safari"]))
        XCTAssertFalse(judge(&h, 77, bundle: "com.apple.Safari", now: 10.3).undoes)
        // The control: read OFF before the window, nothing hidden — the same coming forward is undone.
        var k = started()
        k.noteSecureInput(true, now: 1.0)
        k.noteSecureInput(false, now: 2.0)
        k.noteCause(500, now: 10.0)
        k.noteOpenerCause(now: 10.0, scope: .apps(["com.apple.Safari"]))
        if case .indirect = judge(&k, 77, bundle: "com.apple.Safari", now: 10.3) {} else { XCTFail("undone: nothing was hidden") }
    }

    /// Seed 1049: an app the agent's act cold-launched was LEFT in front (the launch rule's (3)); a later judgment of the
    /// same app (a visit's return brought it back) is no first activation — never adopted as 'an app the user launched'.
    func testALeftLaunchIsNeverAdoptedAsTheUsersLaunchLater() {
        var g = started()
        g.noteCause(500, now: 10.0)
        g.noteOpenerCause(now: 10.0, scope: .apps(["com.apple.Safari"]))
        g.appLaunched(88, startedAt: 10.2, bundle: "us.zoom.xos", now: 10.25)
        let first = judge(&g, 88, bundle: "us.zoom.xos", now: 11.0)
        if case .unexplained = first {} else { XCTFail("left in front and said: \(first)") }
        _ = judge(&g, 1, bundle: "com.example.user", now: 12.0)
        g.noteCause(500, now: 13.9)
        let again = judge(&g, 88, bundle: "us.zoom.xos", now: 14.0)
        XCTAssertFalse(again.isUsers, "a left launch is never adopted later: \(again)")
        XCTAssertNotEqual(g.view.app, 88)
    }
}
