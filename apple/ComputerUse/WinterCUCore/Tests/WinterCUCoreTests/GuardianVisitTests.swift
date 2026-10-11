import XCTest
@testable import WinterCUCore

/// The guardian during a desktop visit (user ruling 2026-10-10): the switch to the window's desktop and the way
/// back are the agent's own — never undone mid-visit (that would yank the user back before the primitive runs),
/// never adopted as the user's place (so a failed return can still be put right); the user moving by themselves is
/// found by the one rule (item 10 of the review of round 7: never "any hardware action", typing included); and a visit
/// mode never outlives its safety deadline.
final class GuardianVisitTests: XCTestCase {
    private func started(app: pid_t = 1, space: UInt64 = 100) -> CUFocusGuardianCore {
        var g = CUFocusGuardianCore()
        g.begin(view: CUGuardedView(app: app, space: space))
        return g
    }

    private func judge(_ g: inout CUFocusGuardianCore, _ app: pid_t, _ space: UInt64, now: TimeInterval) -> CUMoveOwner {
        g.judge(CUMoveQuery(app: app, space: space), now: now)
    }

    func testNothingIsRestoredOrAdoptedMidVisit() {
        var g = started()
        g.beginVisit(app: 9, user: 1, now: 0)
        XCTAssertTrue(g.visiting(now: 1))
        // The target coming forward, on its own desktop: neither theft nor the user's.
        XCTAssertEqual(judge(&g, 9, 200, now: 1), .visit)
        // The user's app on the visited desktop (the arrival's Space change before the target is front): nothing either.
        XCTAssertEqual(judge(&g, 1, 200, now: 1.2), .visit)
        // The user's app coming back on the way home: their place.
        XCTAssertEqual(judge(&g, 1, 100, now: 2), .theirPlace)
        XCTAssertEqual(g.view, CUGuardedView(app: 1, space: 100), "the user's place is still the pre-visit one")
        XCTAssertFalse(g.visitSawUserInput)
        XCTAssertFalse(g.endVisit(now: 2))
        XCTAssertFalse(g.visiting(now: 2))
    }

    /// Item 10: during a visit the user's own move is the one rule's — an app the agent did not touch, or their input that
    /// switches after the visit's own causes. Typing on the visited desktop, or input from before the visit began (the
    /// click on "Switch now"), is not a move.
    func testTheUsersMoveDuringAVisitIsTheRulesNotAnyInput() {
        var g = started()
        g.inputEvent(type: .flagsChanged, flags: .maskCommand, now: 0.4)
        g.inputEvent(type: .flagsChanged, flags: [], now: 0.5)  // their ⌘-Tab just before they agreed: before the visit
        g.beginVisit(app: 9, user: 1, now: 1)
        g.inputEvent(type: .keyDown, flags: [], keycode: 0, now: 1.1)  // typing on the visited desktop
        XCTAssertEqual(judge(&g, 9, 200, now: 1.2), .visit, "neither the earlier ⌘-Tab nor typing is a move")
        XCTAssertFalse(g.visitSawUserInput)
        // Their click into the visited app's own window: the visit's end decides, nothing adopted.
        g.userClicked(app: 9, space: 200, now: 1.3)
        XCTAssertEqual(judge(&g, 9, 200, now: 1.4), .visit)
        XCTAssertEqual(g.view, CUGuardedView(app: 1, space: 100))
        // Mail coming forward with no input of theirs: during a visit the agent acts in front (a link its click opened
        // in another app) — the visit's, not a move of theirs.
        XCTAssertEqual(judge(&g, 43, 300, now: 1.8), .visit)
        // They ⌘-Tab to Mail: theirs — the visit closes, leaving them there.
        g.inputEvent(type: .flagsChanged, flags: .maskCommand, now: 1.85)
        g.inputEvent(type: .flagsChanged, flags: [], now: 1.9)
        XCTAssertTrue(judge(&g, 42, 300, now: 2).isUsers)
        XCTAssertTrue(g.visitSawUserInput)
        XCTAssertEqual(g.view, CUGuardedView(app: 42, space: 300))
        XCTAssertTrue(g.endVisit(now: 2), "the end reports it")
    }

    func testAfterAFailedReturnTheGuardianStillRestoresTheUser() {
        var g = started()
        g.beginVisit(app: 9, user: 1, now: 0)
        XCTAssertEqual(judge(&g, 9, 200, now: 1), .visit)
        g.endVisit(now: 1)
        // The user is still on the target's desktop: the next change the agent caused is put right (to their place).
        XCTAssertFalse(judge(&g, 9, 250, now: 2).isUsers)
        XCTAssertEqual(g.view, CUGuardedView(app: 1, space: 100))
    }

    func testAVisitModeNeverOutlivesItsDeadline() {
        var g = started()
        g.beginVisit(app: 9, user: 1, now: 0)
        let late = CUFocusGuardianCore.visitMaxSeconds + 1
        XCTAssertFalse(g.visiting(now: late))
        g.noteCause(9, now: late - 0.1)  // the agent acting on it
        XCTAssertFalse(judge(&g, 9, 200, now: late).isUsers, "an unended visit is no exemption past its deadline")
        XCTAssertNotEqual(judge(&g, 9, 201, now: late), .visit)
        XCTAssertFalse(g.isTouched(1, now: late), "nor does it keep the user's app touched")
    }

    func testStoppingTheGuardEndsAVisitMode() {
        var g = started()
        g.beginVisit(app: 9, user: 1, now: 0)
        g.end()
        XCTAssertFalse(g.visiting(now: 1))
    }

    func testAVisitModeLastsWhatItIsGivenAndFollowsTheCap() {
        var g = started()
        g.beginVisit(app: 9, user: 1, now: 0, maxSeconds: 200)
        XCTAssertTrue(g.visiting(now: 150), "a primitive's own deadline")
        g.extendVisit(until: 60)
        XCTAssertFalse(g.visiting(now: 61), "the cap re-armed shorter once it ended")
        XCTAssertTrue(g.visiting(now: 59))
        g.endVisit(now: 59)
        g.extendVisit(until: 500)
        XCTAssertFalse(g.visiting(now: 1), "no visit to extend")
    }
}
