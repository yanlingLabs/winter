import XCTest
@testable import Winter

/// Coverage for the wave-3 gate item 2a/2b one-shot latches on `OrbWindowController`:
/// `collapseOnTurnStart` (armed by `GlassRootView.submit()` on an idle-at-submit-time success,
/// consumed by the turnRunning-flip handler to decide whether THIS turn-start auto-collapses the
/// field) and `expandForAnswerReveal` (armed right before an answer-reveal auto-expand, consumed
/// by the surface `.field` handler so the summon-home-state rule doesn't clobber it back to the
/// composer). Both must be one-shot: setting, then consuming, then consuming again must not
/// re-fire — otherwise a stale arm from one turn could wrongly affect a later, unrelated one.
@MainActor
final class TurnStartChoreographyTests: XCTestCase {
    func testCollapseOnTurnStartStartsUnarmed() {
        let controller = OrbWindowController(session: SessionModel())
        XCTAssertFalse(controller.consumeCollapseOnTurnStart())
    }

    func testCollapseOnTurnStartIsOneShot() {
        let controller = OrbWindowController(session: SessionModel())
        controller.collapseOnTurnStart = true

        XCTAssertTrue(controller.consumeCollapseOnTurnStart(), "first consume should see the armed flag")
        XCTAssertFalse(
            controller.consumeCollapseOnTurnStart(),
            "second consume (a later, unrelated turn-start) must not see it re-fire"
        )
    }

    func testCollapseOnTurnStartRearmsOnANewSubmit() {
        let controller = OrbWindowController(session: SessionModel())
        controller.collapseOnTurnStart = true
        XCTAssertTrue(controller.consumeCollapseOnTurnStart())

        // A fresh submit arms it again for the NEXT turn-start.
        controller.collapseOnTurnStart = true
        XCTAssertTrue(controller.consumeCollapseOnTurnStart())
    }

    func testExpandForAnswerRevealStartsUnarmed() {
        let controller = OrbWindowController(session: SessionModel())
        XCTAssertFalse(controller.consumeExpandForAnswerReveal())
    }

    func testExpandForAnswerRevealIsOneShot() {
        let controller = OrbWindowController(session: SessionModel())
        controller.expandForAnswerReveal = true

        XCTAssertTrue(controller.consumeExpandForAnswerReveal())
        XCTAssertFalse(controller.consumeExpandForAnswerReveal())
    }

    /// The two latches are independent — consuming one must not disturb the other.
    func testLatchesAreIndependent() {
        let controller = OrbWindowController(session: SessionModel())
        controller.collapseOnTurnStart = true

        XCTAssertFalse(controller.consumeExpandForAnswerReveal())
        XCTAssertTrue(controller.consumeCollapseOnTurnStart())
    }
}
