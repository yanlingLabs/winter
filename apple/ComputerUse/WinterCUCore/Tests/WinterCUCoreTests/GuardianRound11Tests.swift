import CoreGraphics
import XCTest
@testable import WinterCUCore

/// Round 11 — the review of round 10: an app the agent's own action cold-launches is not the user's launch (HIGH #1),
/// a system dialog started on demand never is (MEDIUM #2), the user's work in an app does not survive a guard's stop
/// (MEDIUM #4), and "clearly the agent's" reads only the facts from before the moment it judges (MEDIUM #8).
final class GuardianRound11Tests: XCTestCase {
    /// The agent presses a link at 20 s; the browser it opens was not running: its process starts at 20.4 s and it comes
    /// forward at 23 s — past the causal window, with no key or click of the user's since: the agent's, sent back.
    func testAnAppTheAgentsActionColdLaunchesIsNotTheUsersLaunch() {
        var g = CUFocusGuardianCore()
        g.begin(view: CUGuardedView(app: 1, space: 100))
        g.noteCause(500, now: 20)
        g.noteOpenerCause(now: 20)
        g.appLaunched(900, startedAt: 20.4, now: 20.45)
        let o = g.judge(CUMoveQuery(app: 900, space: 100, appStartedAt: 20.4), now: 23)
        XCTAssertFalse(o.isUsers, "\(o)")
        XCTAssertTrue(o.undoes, "the agent's indirect effect: \(o)")
    }

    /// The same when the launch notice was never heard: judged from the process start the query reads.
    func testTheColdLaunchIsJudgedAtItsStartWithoutTheLaunchNoticeToo() {
        var g = CUFocusGuardianCore()
        g.begin(view: CUGuardedView(app: 1, space: 100))
        g.noteCause(500, now: 20)
        g.noteOpenerCause(now: 20)
        let o = g.judge(CUMoveQuery(app: 901, space: 100, appStartedAt: 20.4), now: 23)
        XCTAssertTrue(o.undoes, "\(o)")
    }

    /// A key of the user's after the start: no longer clearly the agent's — never sent back.
    func testInputOfTheUsersSinceTheStartLeavesIt() {
        var g = CUFocusGuardianCore()
        g.begin(view: CUGuardedView(app: 1, space: 100))
        g.noteCause(500, now: 20)
        g.noteOpenerCause(now: 20)
        g.appLaunched(902, startedAt: 20.4, now: 20.45)
        g.noteHardwareAction(now: 21)
        let o = g.judge(CUMoveQuery(app: 902, space: 100, appStartedAt: 20.4, hardwareAt: 21), now: 23)
        XCTAssertFalse(o.undoes, "\(o)")
    }

    /// Their own launch (a key 1 s before the start — Spotlight's Return), even right after an opener act: theirs.
    func testTheirOwnLaunchStaysTheirsAfterAnOpenerAct() {
        var g = CUFocusGuardianCore()
        g.begin(view: CUGuardedView(app: 1, space: 100))
        g.noteHardwareAction(now: 19.4)
        g.noteCause(500, now: 20)
        g.noteOpenerCause(now: 20)
        g.appLaunched(903, startedAt: 20.4, now: 20.45)
        let o = g.judge(CUMoveQuery(app: 903, space: 100, appStartedAt: 20.4, hardwareAt: 19.4), now: 23)
        XCTAssertTrue(o.isUsers, "\(o)")
    }

    /// A system dialog started on demand (SecurityAgent, CoreServicesUIAgent): never the user's own launch — left for
    /// them to answer, never adopted as their place.
    func testASystemDialogStartedOnDemandIsNeverTheUsersLaunch() {
        var g = CUFocusGuardianCore()
        g.begin(view: CUGuardedView(app: 1, space: 100))
        g.noteCause(500, now: 20)
        g.noteOpenerCause(now: 20)
        g.appLaunched(904, startedAt: 20.1, now: 20.15)
        let o = g.judge(CUMoveQuery(app: 904, space: 100, appStartedAt: 20.1, appIsSystemUI: true), now: 20.6)
        XCTAssertFalse(o.isUsers, "\(o)")
        XCTAssertFalse(o.undoes, "a system dialog is left for the user to answer: \(o)")
    }

    /// The user's work in an app ends with the guard: a later guard does not refuse acts on it.
    func testTheUsersWorkDoesNotSurviveTheGuardsStop() {
        var g = CUFocusGuardianCore()
        g.begin(view: CUGuardedView(app: 7, space: 100))
        g.userInteracted(7, front: 7, now: 10)
        XCTAssertTrue(g.userIsWorking(in: 7, front: 7, now: 10.5))
        g.end()
        g.begin(view: CUGuardedView(app: 7, space: 100))
        XCTAssertFalse(g.userIsWorking(in: 7, front: 7, now: 60))
        // A click pending its app's activation goes with it too.
        g.userInteracted(8, front: 7, now: 61)
        g.end()
        g.begin(view: CUGuardedView(app: 8, space: 100))
        XCTAssertFalse(g.userIsWorking(in: 8, front: 8, now: 61.2))
    }

    /// "Clearly" at a moment reads only the opener acts and launches from before it.
    func testClearlyReadsOnlyTheFactsFromBeforeTheMoment() {
        var g = CUFocusGuardianCore()
        g.noteOpenerCause(now: 10)
        g.noteOpenerCause(now: 30)
        XCTAssertTrue(g.clearlyAt(10.5, hardwareAt: nil))
        XCTAssertFalse(g.clearlyAt(29, hardwareAt: nil), "the act at 30 came after")
        _ = g.beginLaunch(now: 40)
        XCTAssertFalse(g.clearlyAt(39, hardwareAt: nil), "the launch began after")
        XCTAssertTrue(g.clearlyAt(40.5, hardwareAt: nil))
    }
}
