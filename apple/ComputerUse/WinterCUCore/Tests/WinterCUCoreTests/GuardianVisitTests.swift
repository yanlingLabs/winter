import XCTest
@testable import WinterCUCore

/// The guardian during a desktop visit (user ruling 2026-10-10): the switch to the window's desktop and the way
/// back are the agent's own — never undone mid-visit (that would yank the user back before the primitive runs),
/// never adopted as the user's place (so a failed return can still be put right); user input is only noted; and
/// a visit mode never outlives its safety deadline.
final class GuardianVisitTests: XCTestCase {
    private func started(app: pid_t = 1, space: UInt64 = 100) -> CUFocusGuardianCore {
        var g = CUFocusGuardianCore()
        g.begin(view: CUGuardedView(app: app, space: space))
        return g
    }

    func testNothingIsRestoredOrAdoptedMidVisit() {
        var g = started()
        g.beginVisit(app: 9, now: 0)
        XCTAssertTrue(g.visiting(now: 1))
        // The target coming forward, on its own desktop: neither theft nor the user's.
        XCTAssertEqual(g.handle(CUActivation(app: 9, space: 200, switchInput: false), now: 1), .ignore)
        // The Space change the agent caused: not restored (today it would be, at once).
        XCTAssertNil(g.handleSpaceChange(to: 200, front: 9, switchInput: false, caused: true, now: 1))
        // The user's app coming back on the way home: nothing either.
        XCTAssertEqual(g.handle(CUActivation(app: 1, space: 100, switchInput: false), now: 2), .ignore)
        XCTAssertEqual(g.view, CUGuardedView(app: 1, space: 100), "the user's place is still the pre-visit one")
        XCTAssertFalse(g.visitSawUserInput)
        XCTAssertFalse(g.endVisit())
        XCTAssertFalse(g.visiting(now: 2))
    }

    func testUserInputDuringAVisitIsNotedNotAdopted() {
        var g = started()
        g.beginVisit(app: 9, now: 0)
        XCTAssertEqual(g.handle(CUActivation(app: 42, space: 300, switchInput: true), now: 1), .ignore)
        XCTAssertNil(g.handleSpaceChange(to: 300, front: 42, switchInput: true, now: 1))
        g.userClicked(app: 9, space: 200, now: 1)
        XCTAssertEqual(g.view, CUGuardedView(app: 1, space: 100), "decided at the visit's end, by where the user is then")
        XCTAssertTrue(g.endVisit(), "the end reports the input")
        // The caller found the user somewhere of their own: that is now their place.
        g.adoptUserView(CUGuardedView(app: 42, space: 300))
        XCTAssertEqual(g.view, CUGuardedView(app: 42, space: 300))
    }

    func testAfterAFailedReturnTheGuardianStillRestoresTheUser() {
        var g = started()
        g.beginVisit(app: 9, now: 0)
        _ = g.handleSpaceChange(to: 200, front: 9, switchInput: false, caused: true, now: 1)
        g.endVisit()
        // The user is still on the target's desktop: the next change the agent caused is put right.
        XCTAssertEqual(g.handleSpaceChange(to: 250, front: 9, switchInput: false, caused: true, now: 2),
                       CUGuardedView(app: 1, space: 100))
        XCTAssertEqual(g.handle(CUActivation(app: 9, space: 200, switchInput: false), now: 3),
                       .theft(restore: CUGuardedView(app: 1, space: 100), thief: 9, repeatOffender: false))
    }

    func testAVisitModeNeverOutlivesItsDeadline() {
        var g = started()
        g.beginVisit(app: 9, now: 0)
        let late = CUFocusGuardianCore.visitMaxSeconds + 1
        XCTAssertFalse(g.visiting(now: late))
        XCTAssertEqual(g.handle(CUActivation(app: 9, space: 200, switchInput: false), now: late),
                       .theft(restore: CUGuardedView(app: 1, space: 100), thief: 9, repeatOffender: false),
                       "an unended visit is no exemption past its deadline")
    }

    func testStoppingTheGuardEndsAVisitMode() {
        var g = started()
        g.beginVisit(app: 9, now: 0)
        g.end()
        XCTAssertFalse(g.visiting(now: 1))
    }

    func testAVisitModeLastsWhatItIsGivenAndFollowsTheCap() {
        var g = started()
        g.beginVisit(app: 9, now: 0, maxSeconds: 200)
        XCTAssertTrue(g.visiting(now: 150), "a primitive's own deadline")
        g.extendVisit(until: 60)
        XCTAssertFalse(g.visiting(now: 61), "the cap re-armed shorter once it ended")
        XCTAssertTrue(g.visiting(now: 59))
        g.endVisit()
        g.extendVisit(until: 500)
        XCTAssertFalse(g.visiting(now: 1), "no visit to extend")
    }
}
