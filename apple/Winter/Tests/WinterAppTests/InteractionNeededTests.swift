import XCTest
@testable import Winter

/// Task 7: `FieldStateAdapter.interactionNeeded` — the daemon needs a human (a pending approval,
/// question, or plan; the reducer folds all three into `OrbStatus.approvalNeeded`, see that
/// property's own doc). Drives the chevron's amber pulse and the fluid's action pulse.
@MainActor
final class InteractionNeededTests: XCTestCase {
    func testApprovalNeededDerivesTrue() {
        let session = SessionModel()
        let adapter = FieldStateAdapter(session: session)
        session.applyForTesting { s in s.status = .approvalNeeded(count: 1) }
        XCTAssertTrue(adapter.interactionNeeded)
    }

    /// `.thinking` (the non-approval "running" status) + `turnRunning` must NOT read as
    /// interaction-needed — only `.approvalNeeded` does.
    func testWorkingDerivesFalse() {
        let session = SessionModel()
        let adapter = FieldStateAdapter(session: session)
        session.applyForTesting { s in
            s.status = .thinking
            s.turnRunning = true
        }
        XCTAssertFalse(adapter.interactionNeeded)
    }
}

/// Task 7: the fluid's action pulse (`actionNeededAccelBoost`) and `shouldPauseFluidTick`'s new
/// `actionNeeded` guard (`FieldKit/FluidOrbView.swift`).
final class ActionPulseTests: XCTestCase {
    func testPulseIsFasterAndStrongerThanUnreadBreathing() {
        // unread breathing = sin(t * 1.5) * 30 (FluidOrbView step). The action pulse must be
        // VISIBLY distinct (spec §3): ≥3× frequency, ≥2× amplitude.
        var maxAbs = 0.0
        for i in 0..<200 { maxAbs = max(maxAbs, abs(actionNeededAccelBoost(t: Double(i) * 0.01))) }
        XCTAssertGreaterThanOrEqual(maxAbs, 60.0)
    }
    func testNeverPausesWhileActionNeeded() {
        XCTAssertFalse(shouldPauseFluidTick(
            sim: .rest, targetLevel: 0.5, isHeld: true, accelMagnitude: 0.0, actionNeeded: true
        ))
    }
}
