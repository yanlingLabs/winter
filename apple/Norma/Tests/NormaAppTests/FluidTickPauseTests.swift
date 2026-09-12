import XCTest
@testable import Winter

/// Final-review Important-2 (D9 settled-tick freeze): direct unit coverage for the pure
/// `shouldPauseFluidTick` decision (`FieldKit/FluidOrbView.swift`) — no `TimelineView`, no
/// `@State`, no view lifecycle. See that function's own doc for the full contract.
final class FluidTickPauseTests: XCTestCase {
    private func settledSim(target: Double) -> FluidSim {
        var s = FluidSim.rest
        for _ in 0..<600 { s = s.step(dt: 1.0/60.0, acceleration: .zero, targetLevel: target) }
        return s
    }

    private func excitedSim(target: Double) -> FluidSim {
        var s = FluidSim.rest
        for _ in 0..<30 { s = s.step(dt: 1.0/60.0, acceleration: CGVector(dx: 800, dy: 0), targetLevel: target) }
        return s
    }

    func testPausesWhenHeldSettledAndCalm() {
        let sim = settledSim(target: 0.5)
        XCTAssertTrue(shouldPauseFluidTick(sim: sim, targetLevel: 0.5, isHeld: true, accelMagnitude: 0, actionNeeded: false))
    }

    /// `.unread`'s synthetic breathing must never freeze — `FieldStateAdapter.isHoldingWork` is
    /// always false while `.unread`, so `isHeld` is always false for it too. Even a sim that
    /// happens to look settled and a calm cursor must not pause.
    func testNeverPausesForUnread() {
        let sim = settledSim(target: 0.5)
        XCTAssertFalse(shouldPauseFluidTick(sim: sim, targetLevel: 0.5, isHeld: false, accelMagnitude: 0, actionNeeded: false))
    }

    /// A `turnRunning` working fill must never freeze even if the level target hasn't moved in a
    /// while — `isHeld` is false the entire time a turn is running.
    func testNeverPausesWhileTurnRunning() {
        let sim = settledSim(target: 0.5)
        XCTAssertFalse(shouldPauseFluidTick(sim: sim, targetLevel: 0.5, isHeld: false, accelMagnitude: 0, actionNeeded: false))
    }

    /// Held but still excited (a recent kick hasn't decayed out yet) — must not pause mid-motion.
    func testDoesNotPauseWhenHeldButExcited() {
        let sim = excitedSim(target: 0.5)
        XCTAssertFalse(shouldPauseFluidTick(sim: sim, targetLevel: 0.5, isHeld: true, accelMagnitude: 0, actionNeeded: false))
    }

    /// Held and settled, but the cursor itself is currently moving — pausing here would freeze a
    /// bubble that's about to get kicked again on the very next real tick.
    func testDoesNotPauseWhenHeldSettledButCursorMoving() {
        let sim = settledSim(target: 0.5)
        XCTAssertFalse(shouldPauseFluidTick(sim: sim, targetLevel: 0.5, isHeld: true, accelMagnitude: 800, actionNeeded: false))
    }

    /// Held but not yet converged to the target (mid task-count change) — must not pause early.
    func testDoesNotPauseWhenHeldButNotYetSettled() {
        var s = FluidSim.rest
        for _ in 0..<300 { s = s.step(dt: 1.0/60.0, acceleration: .zero, targetLevel: 1.0) }
        s = s.step(dt: 1.0/60.0, acceleration: .zero, targetLevel: 0.25) // target just moved
        XCTAssertFalse(shouldPauseFluidTick(sim: s, targetLevel: 0.25, isHeld: true, accelMagnitude: 0, actionNeeded: false))
    }
}
