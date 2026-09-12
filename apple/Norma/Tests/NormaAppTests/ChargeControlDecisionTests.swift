import XCTest

/// Table test for `chargeControlDecision` (SMCController.swift) — the pure hysteresis core of
/// `ChargeManager`'s CHTE monitoring loop. Dual membership comes along for free: this file lives
/// in `Tests/WinterAppTests`, which project.yml already includes wholesale in `WinterAppTests`.
final class ChargeControlDecisionTests: XCTestCase {

    func test_socAboveTarget_inhibits() {
        XCTAssertTrue(chargeControlDecision(soc: 85, target: 80, currentlyInhibited: false, hysteresis: 3))
    }

    func test_socAtTarget_inhibits() {
        XCTAssertTrue(chargeControlDecision(soc: 80, target: 80, currentlyInhibited: false, hysteresis: 3))
    }

    func test_socAtHysteresisFloor_allows() {
        // target - hysteresis == 77: "comfortably below" starts exactly here.
        XCTAssertFalse(chargeControlDecision(soc: 77, target: 80, currentlyInhibited: true, hysteresis: 3))
    }

    func test_socInBand_holdsPriorState_whenPreviouslyInhibited() {
        XCTAssertTrue(chargeControlDecision(soc: 78, target: 80, currentlyInhibited: true, hysteresis: 3))
    }

    func test_socInBand_holdsPriorState_whenPreviouslyAllowed() {
        XCTAssertFalse(chargeControlDecision(soc: 78, target: 80, currentlyInhibited: false, hysteresis: 3))
    }

    func test_socFarBelowTarget_allows() {
        XCTAssertFalse(chargeControlDecision(soc: 50, target: 80, currentlyInhibited: true, hysteresis: 3))
    }
}
