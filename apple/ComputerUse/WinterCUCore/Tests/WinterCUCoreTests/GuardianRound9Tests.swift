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
}
