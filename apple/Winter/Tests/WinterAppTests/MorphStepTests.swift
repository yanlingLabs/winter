import XCTest
@testable import Winter

final class MorphStepTests: XCTestCase {
    func testTrackingConstantsMatchV1() {
        XCTAssertEqual(SpringConfig.tracking.stiffness, 75)
        XCTAssertEqual(SpringConfig.tracking.damping, 18)
        XCTAssertEqual(SpringConfig.tracking.snapDistance, 0.35)
        XCTAssertEqual(SpringConfig.tracking.snapSpeed, 18)
        XCTAssertEqual(SpringConfig.tracking.glideDistance, 8)
        XCTAssertEqual(SpringConfig.tracking.glideSpeed, 80)
    }

    func testMorphConvergesToTarget() {
        var progress = 0.0
        var velocity = 0.0
        for _ in 0..<600 {
            (progress, velocity) = morphStep(progress: progress, velocity: velocity, target: 1, dt: 1.0 / 60.0)
        }
        XCTAssertEqual(progress, 1.0, accuracy: 0.001)
        XCTAssertEqual(velocity, 0.0, accuracy: 0.01)
    }

    /// Underdamped (stiffness 140 / damping 22 → damping ratio ≈0.93 < 1) — v1's morph
    /// deliberately overshoots progress above 1 on expand; that tiny bounce sells the "liquid
    /// merge" feel. The analytic overshoot at this damping ratio is small (~0.04%), and the
    /// production 60Hz tick (dt ≈ 1/60) discretizes it away entirely (verified: max progress at
    /// dt=1/60 tops out at 0.999999999999998, never crossing 1). Ticking at the integrator's own
    /// dt-clamp FLOOR (1/240 — reachable if two display/timer callbacks land close together)
    /// resolves the same continuous-time dynamics finely enough to expose the overshoot
    /// directly, without changing the stiffness/damping under test.
    func testMorphOvershootsAboveTargetOnExpand() {
        var progress = 0.0
        var velocity = 0.0
        var maxProgress = 0.0
        for _ in 0..<2000 {
            (progress, velocity) = morphStep(progress: progress, velocity: velocity, target: 1, dt: 1.0 / 240.0)
            maxProgress = max(maxProgress, progress)
        }
        XCTAssertGreaterThan(maxProgress, 1.0)
    }

    func testMorphSettlesAtTargetPerBriefThresholds() {
        // Fix A (anim-fidelity restore): the settle rule is v1's own epsilon
        // (GlassFieldWindow.swift:1841) — |target - progress| < 0.004 && |velocity| < 0.05 — not
        // the tighter 0.001/0.01 v2 had drifted to (see `OrbWindowController.morphTick()`'s guard).
        var progress = 0.0
        var velocity = 0.0
        var settledStep: Int?
        for step in 0..<1000 {
            (progress, velocity) = morphStep(progress: progress, velocity: velocity, target: 1, dt: 1.0 / 60.0)
            if abs(1 - progress) < 0.004, abs(velocity) < 0.05 {
                settledStep = step
                break
            }
        }
        XCTAssertNotNil(settledStep)
    }

    func testMorphDtIsClamped() {
        // v1's morph dt clamp is [1/240, 1/20] — wider on top than the position spring's 1/30.
        // A huge dt (app slept) must not explode the integration.
        let (progress, _) = morphStep(progress: 0, velocity: 0, target: 1, dt: 5.0)
        XCTAssertLessThan(progress, 1.0) // nowhere near a runaway overshoot from an unclamped 5s step
        XCTAssertGreaterThan(progress, 0)
    }

    func testMorphConvergesToZeroOnCollapse() {
        var progress = 1.0
        var velocity = 0.0
        for _ in 0..<600 {
            (progress, velocity) = morphStep(progress: progress, velocity: velocity, target: 0, dt: 1.0 / 60.0)
        }
        XCTAssertEqual(progress, 0.0, accuracy: 0.001)
        XCTAssertEqual(velocity, 0.0, accuracy: 0.01)
    }
}

final class FastFlickTests: XCTestCase {
    func testBelowBothThresholdsDoesNotCollapse() {
        XCTAssertFalse(shouldCollapseFastFlick(speed: 899, displacement: 199))
    }

    func testSpeedAboveThresholdCollapses() {
        XCTAssertTrue(shouldCollapseFastFlick(speed: 901, displacement: 0))
    }

    func testDisplacementAboveThresholdCollapses() {
        XCTAssertTrue(shouldCollapseFastFlick(speed: 0, displacement: 201))
    }

    func testExactlyAtThresholdsDoesNotCollapse() {
        // Both comparisons are strict (`>`), so sitting exactly on the boundary must not fire.
        XCTAssertFalse(shouldCollapseFastFlick(speed: 900, displacement: 200))
    }
}
