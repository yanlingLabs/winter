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
        func core() -> CUFocusGuardianCore {
            var g = CUFocusGuardianCore()
            g.begin(view: CUGuardedView(app: u, space: 100))
            g.noteSwitch(now: 9.9, .app)              // their Dock click on P, before…
            g.userInteracted(t, front: u, now: 10.0)  // …their click into T's window, U in front
            return g
        }
        var a = core()
        let before = a.workMarks[t, default: 0]
        a.otherAppActivated(t, front: p, now: 10.03)  // T's own activation, heard with P (the earlier Dock click) in front
        XCTAssertEqual(a.workMarks[t, default: 0], before + 1, "T landed first: they worked in it at its moment")
        a.otherAppActivated(p, front: p, now: 10.03)
        XCTAssertFalse(a.userIsWorking(in: t, front: t, now: 10.5), "and moved on: the mark is spent, a return to T is no work")
        var b = core()
        b.noteSwitch(now: 10.01, .app)                // a switch input of theirs after the click
        b.otherAppActivated(t, front: p, now: 10.03)
        XCTAssertEqual(b.workMarks[t, default: 0], before, "they may have moved on before T landed: nothing counts")
        XCTAssertFalse(b.userIsWorking(in: t, front: t, now: 10.5))
    }
}
