import XCTest
@testable import WinterCUCore

/// Round 19 — the review of round 18's leftovers.
final class Round19GuardianTests: XCTestCase {
    /// L8: the clicked app's own activation, heard once another app is in front, is judged as of ITS moment. With no switch
    /// input of theirs after the click, what is in front came from input before it and landed after T — T was in front at
    /// its own moment: the landing counts (an act in flight on T stops), and the mark is spent (no stale work later). With a
    /// switch input of theirs after the click, they may have moved on before T landed: nothing counts.
    func testTheClickedAppsActivationIsJudgedAsOfItsOwnMoment() {
        let u: pid_t = 1, t: pid_t = 5252, p: pid_t = 710
        for withClickInstant in [false, true] {
            func core() -> CUFocusGuardianCore {
                var g = CUFocusGuardianCore()
                g.begin(view: CUGuardedView(app: u, space: 100))
                g.noteSwitch(now: 9.9, .app)              // their Dock click on P, before…
                g.userInteracted(t, front: u, now: 10.0)  // …their click into T's window, U in front
                // (The click's OWN switch instant, at the same moment — as the engine notes it right after the work mark: the
                // review of round 19, LOW 5. It is no switch input AFTER the click.)
                if withClickInstant { g.noteSwitch(now: 10.0, .app, target: t) }
                return g
            }
            var a = core()
            let before = a.workMarks[t, default: 0]
            a.otherAppActivated(t, front: p, now: 10.03)  // T's own activation, heard with P (the earlier Dock click) in front
            XCTAssertEqual(a.workMarks[t, default: 0], before + 1, "T landed first: they worked in it at its moment (click instant: \(withClickInstant))")
            a.otherAppActivated(p, front: p, now: 10.03)
            XCTAssertFalse(a.userIsWorking(in: t, front: t, now: 10.5), "and moved on: the mark is spent, a return to T is no work")
            var b = core()
            b.noteSwitch(now: 10.01, .app)                // a switch input of theirs after the click
            b.otherAppActivated(t, front: p, now: 10.03)
            XCTAssertEqual(b.workMarks[t, default: 0], before, "they may have moved on before T landed: nothing counts")
            XCTAssertFalse(b.userIsWorking(in: t, front: t, now: 10.5))
        }
    }

    /// The helper's bring of the window the user clicked into (a bound target's background window, brought forward with its
    /// app at the button's release) is the CLICK's: landing late, after another app came forward from their EARLIER input
    /// (a Dock click before the click), it is theirs — never undone as the agent's (round 19, the mid-act survey's ordinary
    /// seed 31: the act on T went on after the click, the claim and the click's instant were used by T's first landing).
    /// A switch input of theirs after the click makes it no longer the click's.
    func testTheBringOfTheClickedWindowIsTheClicks() {
        let u: pid_t = 1, t: pid_t = 5252, s: pid_t = 710
        for laterInput in [false, true] {
            var g = CUFocusGuardianCore()
            g.begin(view: CUGuardedView(app: u, space: 100))
            g.noteSwitch(now: 9.9, .app, target: s)            // their click on S's Dock tile…
            g.noteCause(t, now: 9.95)                          // (the agent's act on T is running)
            g.noteSwitch(now: 10.0, .app, target: t)           // …then into T's window
            g.userClicked(app: t, space: 100, now: 10.0)
            g.noteClickBring(t, clickAt: 10.0, now: 10.001)    // the helper brings T's window forward at the release
            XCTAssertTrue(g.judge(CUMoveQuery(app: t, space: 100), now: 10.004).isUsers, "T's first landing: their click")
            g.noteCause(t, now: 10.006)                        // the agent's act on T goes on (in flight)
            if laterInput { g.noteSwitch(now: 10.007, .app, target: s) }  // a click on S's tile after the click into T
            XCTAssertTrue(g.judge(CUMoveQuery(app: s, space: 100), now: 10.01).isUsers, "S landed: their Dock click")
            g.noteCause(t, now: 10.012)
            let tLands = g.judge(CUMoveQuery(app: t, space: 100), now: 10.02)
            XCTAssertEqual(tLands.isUsers, !laterInput, "the bring of T landing after S (input after the click: \(laterInput)) — \(tLands)")
        }
    }
}
