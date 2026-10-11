import ApplicationServices
import CoreGraphics
import XCTest
@testable import WinterCUCore

/// Round 9: what the honest model-based test (`GuardianModelTests`) found once its oracle stopped reading the engine —
/// one directed test each, on the pure rule.
final class GuardianRound9Tests: XCTestCase {
    private func started(app: pid_t = 1, space: UInt64 = 100) -> CUFocusGuardianCore {
        var g = CUFocusGuardianCore()
        g.begin(view: CUGuardedView(app: app, space: space))
        return g
    }

    private func judge(_ g: inout CUFocusGuardianCore, _ app: pid_t, _ space: UInt64 = 100, now: TimeInterval) -> CUMoveOwner {
        g.judge(CUMoveQuery(app: app, space: space), now: now)
    }

    /// A ⌘-Tab switches at the RELEASE: while ⌘ is down its Tab explains nothing, and the switch counts from the release —
    /// so an act's main-window write between the user's Tab and their release never makes their ⌘-Tab the agent's.
    func testACommandTabCountsFromItsRelease() {
        var g = started()
        g.inputEvent(type: .flagsChanged, flags: .maskCommand, now: 10.0)
        g.inputEvent(type: .keyDown, flags: .maskCommand, keycode: 48, now: 10.05)
        g.noteCause(500, raise: true, now: 10.1)  // the agent's act writes the target's main window
        // Still held: the switcher has not switched — the target coming forward now is the agent's.
        XCTAssertTrue(judge(&g, 500, now: 10.15).undoes, "a ⌘-Tab still held explains nothing")
        var h = started()
        h.inputEvent(type: .flagsChanged, flags: .maskCommand, now: 10.0)
        h.inputEvent(type: .keyDown, flags: .maskCommand, keycode: 48, now: 10.05)
        h.noteCause(500, raise: true, now: 10.1)
        h.inputEvent(type: .flagsChanged, flags: [], now: 10.2)
        XCTAssertTrue(judge(&h, 500, now: 10.25).isUsers, "their ⌘-Tab, released after the agent's write")
        // Several Tabs in one hold are ONE switch.
        var k = started()
        k.inputEvent(type: .flagsChanged, flags: .maskCommand, now: 20.0)
        k.inputEvent(type: .keyDown, flags: .maskCommand, keycode: 48, now: 20.05)
        k.inputEvent(type: .keyDown, flags: .maskCommand, keycode: 48, now: 20.1)
        k.inputEvent(type: .flagsChanged, flags: [], now: 20.2)
        k.noteCause(500, raise: false, now: 20.15)
        k.noteCause(77, raise: false, now: 20.15)
        XCTAssertTrue(judge(&k, 500, now: 20.25).isUsers)
        XCTAssertTrue(judge(&k, 77, now: 20.3).undoes, "one ⌘-Tab, one switch: the second app's coming forward is the agent's")
    }

    /// A click into a window explains that window's app coming forward ONCE: the claim uses the click's instant, and what
    /// the agent did to the app while it was in front counts once it leaves — so its return after the user left it is the
    /// agent's, not "theirs by that click".
    func testAClaimUsesUpItsClickAndFrontTimeCausesCountOnceTheAppLeaves() {
        var g = started()
        g.noteSwitch(now: 30.0, .app, target: 500)
        g.userClicked(app: 500, space: 100, now: 30.0)
        XCTAssertTrue(judge(&g, 500, now: 30.01).isUsers, "they clicked into its window")
        g.noteFrontAfterglow(500, now: 30.3)  // the agent acts on the target while it is in front
        // The user goes back to their app (⌘-Tab).
        g.inputEvent(type: .flagsChanged, flags: .maskCommand, now: 30.5)
        g.inputEvent(type: .flagsChanged, flags: [], now: 30.6)
        XCTAssertTrue(judge(&g, 1, now: 30.65).isUsers)
        // The target comes back by itself.
        XCTAssertTrue(judge(&g, 500, now: 31.0).undoes, "the agent's: its act came after their click")
    }

    /// A past change heard late (an app's activation notification arriving after the next change was judged) takes
    /// nothing back from what is in front now when that is their place (I5).
    func testAPastChangeHeardLateNeverTakesBackTheirPlace() {
        var g = started()
        g.noteCause(900, raise: true, now: 39.9)  // the app the agent launched
        g.noteSwitch(now: 40.0, .app)              // the user's Dock click
        XCTAssertTrue(judge(&g, 900, now: 40.1).isUsers, "their Dock click explains what came forward")
        let owner = g.adoptPast(770, space: 400, live: CUGuardedView(app: 900, space: 100), hardwareAt: 40.0, now: 40.12)
        XCTAssertNil(owner, "what is in front is their place: nothing is taken back")
        XCTAssertEqual(g.view.app, 900)
        XCTAssertEqual(judge(&g, 900, now: 40.15), .theirPlace)
    }

    /// An app judged the agent's indirect effect a moment before a desktop visit, heard again during it, is the visit's:
    /// never undone over the visit's own switch (I5).
    func testAVisitNeverUndoesWhatWasJudgedBeforeIt() {
        var g = started()
        g.noteCause(500, now: 50.0)
        if case .indirect = judge(&g, 77, now: 50.2) {} else { XCTFail("an untouched app right after the agent's act: its indirect effect") }
        g.beginVisit(app: 600, user: 1, now: 50.25)
        XCTAssertEqual(judge(&g, 77, now: 50.3), .visit)
    }

    /// The user's ⌘-Tab into the app being held in front (requestForeground), released after the hold was issued, is
    /// theirs — and the hold's end gives nothing back. With no input of theirs, the landing is the consent's and its end
    /// gives the place back.
    func testTheUsersSwitchIntoTheHeldAppIsTheirsAndNothingIsGivenBack() {
        var g = started()
        g.inputEvent(type: .flagsChanged, flags: .maskCommand, now: 69.95)
        g.noteCause(600, raise: true, now: 70.0)   // the hold's activation
        g.exempt(600, until: 100, now: 70.0)
        g.inputEvent(type: .flagsChanged, flags: [], now: 70.05)
        XCTAssertTrue(judge(&g, 600, now: 70.1).isUsers, "their ⌘-Tab, released after the hold was issued")
        g.endExempt(600)
        XCTAssertEqual(g.view.app, 600, "the hold's end gives nothing back")
        var h = started()
        h.noteCause(600, raise: true, now: 70.0)
        h.exempt(600, until: 100, now: 70.0)
        XCTAssertEqual(judge(&h, 600, now: 70.1), .consented)
        h.endExempt(600)
        XCTAssertEqual(h.view.app, 1, "the consent's own landing: its end gives the place back")
    }

    /// A click on another display's window of an app not in front: ONE input (an app switch takes the desktop along).
    func testAClickOnAnotherDisplaysWindowIsOneInput() {
        var g = started()
        g.noteSwitch(now: 60.0, .app, target: 77)
        g.userClicked(app: 77, space: 200, now: 60.0)
        XCTAssertTrue(judge(&g, 77, 200, now: 60.05).isUsers)
        g.inputEvent(type: .flagsChanged, flags: .maskCommand, now: 60.2)
        g.inputEvent(type: .flagsChanged, flags: [], now: 60.3)
        XCTAssertTrue(judge(&g, 1, now: 60.35).isUsers)
        g.noteCause(500, now: 60.4)
        XCTAssertTrue(judge(&g, 77, 200, now: 60.6).undoes, "the click was used: 77's own return is not theirs")
    }
    /// An app the agent never touched, the user's by their input since the agent's last cause with no instant of a
    /// fitting kind (a Dock click on the app already in front switched its desktop): that input is used up — never left
    /// to make the agent's indirect effect a moment later "theirs".
    func testAnUntouchedAppTheirsByTheirInputUsesItUp() {
        var g = started(app: 1, space: 100)
        g.noteCause(500, now: 80.0)
        g.noteHardwareAction(now: 80.1)
        g.noteSwitch(now: 80.1, .app)                       // the Dock click
        XCTAssertTrue(judge(&g, 1, 300, now: 80.2).isUsers) // their own app, on another desktop
        g.noteCause(500, now: 80.4)                         // the agent acts again
        XCTAssertTrue(judge(&g, 77, 300, now: 80.7).undoes, "the click was used: an app coming forward next is not theirs by it")
    }

    /// During a visit, an app coming forward that a switch of theirs since the visit began explains (heard after the visit
    /// arrived) is their move: the visit's end brings them back THERE.
    func testDuringAVisitTheirSwitchHeardLateIsTheirMove() {
        var g = started()
        g.beginVisit(app: 600, user: 1, now: 90.0)
        g.inputEvent(type: .flagsChanged, flags: .maskCommand, now: 90.1)
        g.inputEvent(type: .flagsChanged, flags: [], now: 90.2)
        let owner = g.adoptPast(77, space: 100, live: CUGuardedView(app: 600, space: 300), hardwareAt: 90.2, now: 90.4)
        XCTAssertTrue(owner?.isUsers == true)
        XCTAssertEqual(g.view.app, 77)
        XCTAssertTrue(g.visitSawUserInput)
    }

    /// The consented foreground's landing heard only after something else came forward over it: the held app is where
    /// that theft is put back, and the consent's end gives the place from before it back.
    func testAConsentedLandingHeardLateIsWhereATheftGoesBack() {
        var g = started()
        g.noteCause(600, raise: true, now: 100.0)
        g.exempt(600, until: 105, now: 100.0)
        g.noteCause(77, raise: true, now: 100.05)  // a late landing of another app (the agent's)
        let owner = g.adoptPast(600, space: 100, live: CUGuardedView(app: 77, space: 100), now: 100.1)
        XCTAssertEqual(owner, .consented)
        XCTAssertEqual(g.view.app, 600)
        XCTAssertTrue(judge(&g, 77, now: 100.12).undoes)
        g.endExempt(600)
        XCTAssertEqual(g.view.app, 1, "the consent's end gives the place back")
    }

    /// A state judged again after its verdict was cleared (a visit's end) counts only the facts from before it was first
    /// seen: the user's typing into a dialog the agent's action brought up does not make it their place.
    func testFactsAsOfFirstSeenSurviveAClearedVerdict() {
        var g = started()
        g.noteCause(500, now: 110.0)
        let q = CUMoveQuery(app: 880, space: 100, appIsSystemUI: true)
        if case .unexplained = g.judge(q, now: 110.2) {} else { XCTFail("a system dialog after the agent's action: left alone") }
        g.beginVisit(app: 600, user: 1, now: 110.3)
        _ = g.endVisit(now: 110.4)
        g.noteHardwareAction(now: 110.6)              // the user types into the dialog
        if case .unexplained = g.judge(q, now: 111.0) {} else { XCTFail("still not their place: their keys came after it was first seen") }
    }
}
