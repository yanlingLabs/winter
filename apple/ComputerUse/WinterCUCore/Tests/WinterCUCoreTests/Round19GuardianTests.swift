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
            g.noteClickBring(t, clickAt: 10.0, space: 100, now: 10.001)    // the helper brings T's window forward at the release
            XCTAssertTrue(g.judge(CUMoveQuery(app: t, space: 100), now: 10.004).isUsers, "T's first landing: their click")
            g.noteCause(t, now: 10.006)                        // the agent's act on T goes on (in flight)
            if laterInput { g.noteSwitch(now: 10.007, .app, target: s) }  // a click on S's tile after the click into T
            XCTAssertTrue(g.judge(CUMoveQuery(app: s, space: 100), now: 10.01).isUsers, "S landed: their Dock click")
            g.noteCause(t, now: 10.012)
            let tLands = g.judge(CUMoveQuery(app: t, space: 100), now: 10.02)
            XCTAssertEqual(tLands.isUsers, !laterInput, "the bring of T landing after S (input after the click: \(laterInput)) — \(tLands)")
        }
    }

    /// The controller's ruling (round 19, the ordinary target's seed 49): a swipe the user makes into the visited desktop —
    /// after the visit's own way there — makes that desktop their place, and the visit's end does not return them to U.
    /// Judged once: the visit's end and a later key read the same verdict on the same instant. The visit's own way there
    /// is never taken for their switch (the survey's seed 1050).
    func testASwipeIntoTheVisitedDesktopIsTheirPlaceAndTheEndKeepsThemThere() {
        var g = CUFocusGuardianCore()
        g.begin(view: CUGuardedView(app: 1, space: 100))
        g.beginVisit(app: 6000, user: 1, now: 10.0)
        g.noteCause(6000, raise: true, now: 10.05)          // the visit's own way there…
        if case .user = g.judge(CUMoveQuery(app: 6000, space: 300), now: 10.3) { XCTFail("the way there is the visit's") }
        _ = g.judge(CUMoveQuery(app: 1, space: 100), now: 10.4)  // …then they are back on their own desktop
        g.noteSwitch(now: 10.5, .desktop)                    // their swipe into the visited desktop
        let during = g.judge(CUMoveQuery(app: 6000, space: 300), now: 10.6)
        XCTAssertTrue(during.isUsers, "their swipe into the visited desktop: their place — \(during)")
        XCTAssertEqual(g.view.app, 6000, "their place is the visited app on its desktop")
        XCTAssertTrue(g.endVisit(now: 10.8), "the visit's end: they moved — no return to where it began")
        let key = g.judge(CUMoveQuery(app: 6000, space: 300), now: 10.9)
        if case .agent = key { XCTFail("a key a moment later reads the same verdict — \(key)") }
        XCTAssertEqual(g.view.app, 6000)
    }

    /// The review of round 19, L1 (the survey's seed 1050): the visit's own way there is never their switch, even with
    /// input of theirs alive while it lands — a ⌘-Tab's release, a ⌃-arrow — until the visit has arrived AND they have
    /// left its desktop. The visit's end then returns them to where it began.
    func testTheVisitsOwnWayThereIsNeverTheirSwitchWithTheirInputAlive() {
        var g = CUFocusGuardianCore()
        g.begin(view: CUGuardedView(app: 1, space: 100))
        g.beginVisit(app: 6000, user: 1, now: 10.0)
        g.noteSwitch(now: 10.05, .app, target: 6000)         // input of theirs alive during the way there…
        g.noteSwitch(now: 10.08, .desktop)
        g.noteCause(6000, raise: true, now: 10.1)           // (the visit's switch)
        g.noteSwitch(now: 10.15, .desktop)                   // …and after the visit's last cause
        let arrival = g.judge(CUMoveQuery(app: 6000, space: 300), now: 10.3)
        guard case .visit = arrival else { return XCTFail("the visit's way there: the visit's — \(arrival)") }
        XCTAssertEqual(g.view, CUGuardedView(app: 1, space: 100), "their place is still where the visit began")
        XCTAssertFalse(g.endVisit(now: 10.5), "the visit's end: they did not move")
    }

    /// The review of round 19, M1 (a probe): the visit arrives at T@300, the agent opens S on 300, the user ⌘-Tabs back
    /// to T on 300 — they never left the visited DESKTOP, so it is no switch of theirs "into" it: the visit's.
    func testAnotherAppOnTheVisitedDesktopIsNoLeavingIt() {
        let t: pid_t = 6000, s: pid_t = 7000
        var g = CUFocusGuardianCore()
        g.begin(view: CUGuardedView(app: 1, space: 100))
        g.beginVisit(app: t, user: 1, now: 10.0)
        g.noteCause(t, raise: true, now: 10.05)
        if case .user = g.judge(CUMoveQuery(app: t, space: 300), now: 10.3) { XCTFail("the way there is the visit's") }
        g.noteCause(s, raise: true, now: 10.4)              // the agent opens S on the visited desktop
        _ = g.judge(CUMoveQuery(app: s, space: 300), now: 10.45)
        g.noteSwitch(now: 10.6, .app, target: t)             // their ⌘-Tab back to T, on the same desktop
        let back = g.judge(CUMoveQuery(app: t, space: 300), now: 10.65)
        guard case .visit = back else { return XCTFail("still on the visited desktop: the visit's — \(back)") }
        XCTAssertEqual(g.view, CUGuardedView(app: 1, space: 100), "their place is still where the visit began")
    }

    /// The review of round 19, H1 (an I1 violation, found by a probe): the user clicks T's background window on desktop
    /// 100, the helper brings it, and T@100 lands — theirs. 450 ms later the agent's act in flight on T raises T's window
    /// on desktop 300 and macOS moves there: the agent's, never "the window they clicked into" — the bring counts only on
    /// the clicked window's own desktop, only once, and never after a raise of the agent's on T since the click.
    func testTheBringNeverCoversTheAgentsRaiseOnAnotherDesktop() {
        let u: pid_t = 1, t: pid_t = 5252
        var g = CUFocusGuardianCore()
        g.begin(view: CUGuardedView(app: u, space: 100))
        g.noteCause(t, now: 9.9)                           // (the agent's act on T is running)
        g.noteSwitch(now: 10.0, .app, target: t)
        g.userClicked(app: t, space: 100, now: 10.0)
        g.noteClickBring(t, clickAt: 10.0, space: 100, now: 10.001)
        XCTAssertTrue(g.judge(CUMoveQuery(app: t, space: 100), now: 10.01).isUsers, "T@100 lands: their click")
        g.noteCause(t, raise: true, now: 10.45)            // the act raises T's window on desktop 300
        let raised = g.judge(CUMoveQuery(app: t, space: 300), now: 10.46)
        XCTAssertFalse(raised.isUsers, "the agent's raise on another desktop is never the click's — \(raised)")
        XCTAssertEqual(g.view, CUGuardedView(app: t, space: 100), "their place stays T@100")
    }

    /// The same timeline with T in front when the act raises its window (the act on the front app — an afterglow raise,
    /// not a cause): neither the click's bring nor "the desktop change that came with their own move into it" covers it.
    func testTheBringNeverCoversTheAgentsRaiseOfTheFrontAppOnAnotherDesktop() {
        let u: pid_t = 1, t: pid_t = 5252
        var g = CUFocusGuardianCore()
        g.begin(view: CUGuardedView(app: u, space: 100))
        g.noteCause(t, now: 9.9)
        g.noteSwitch(now: 10.0, .app, target: t)
        g.userClicked(app: t, space: 100, now: 10.0)
        g.noteClickBring(t, clickAt: 10.0, space: 100, now: 10.001)
        XCTAssertTrue(g.judge(CUMoveQuery(app: t, space: 100), now: 10.01).isUsers, "T@100 lands: their click")
        g.noteFrontAfterglow(t, raise: true, now: 10.45)  // the act on the front T raises its window on desktop 300
        let raised = g.judge(CUMoveQuery(app: t, space: 300), now: 10.46)
        XCTAssertFalse(raised.isUsers, "the agent's raise of the front app on another desktop is never theirs — \(raised)")
        XCTAssertEqual(g.view, CUGuardedView(app: t, space: 100), "their place stays T@100")
    }
}
