import XCTest
@testable import Winter

final class FluidSimTests: XCTestCase {
    func testLevelConvergesToTarget() {
        var s = FluidSim.rest
        for _ in 0..<300 { s = s.step(dt: 1.0/60.0, acceleration: .zero, targetLevel: 0.8) }
        XCTAssertEqual(s.level, 0.8, accuracy: 0.02)
    }
    func testLateralAccelerationTiltsThenSettles() {
        var s = FluidSim.rest
        for _ in 0..<30 { s = s.step(dt: 1.0/60.0, acceleration: CGVector(dx: 800, dy: 0), targetLevel: 0.5) }
        XCTAssertLessThan(s.tilt, -0.01) // liquid lags opposite the push
        for _ in 0..<600 { s = s.step(dt: 1.0/60.0, acceleration: .zero, targetLevel: 0.5) }
        XCTAssertEqual(s.tilt, 0, accuracy: 0.005) // settles flat
    }
    func testWavesExciteAndDecay() {
        var s = FluidSim.rest
        for _ in 0..<30 { s = s.step(dt: 1.0/60.0, acceleration: CGVector(dx: 600, dy: 300), targetLevel: 0.5) }
        XCTAssertGreaterThan(s.waveAmplitude, 0.05)
        for _ in 0..<600 { s = s.step(dt: 1.0/60.0, acceleration: .zero, targetLevel: 0.5) }
        XCTAssertLessThan(s.waveAmplitude, 0.01)
    }
    func testSurfaceOffsetBoundedAndFlatAtRest() {
        var s = FluidSim.rest
        for _ in 0..<600 { s = s.step(dt: 1.0/60.0, acceleration: .zero, targetLevel: 0.5) }
        for x in stride(from: -1.0, through: 1.0, by: 0.25) {
            XCTAssertEqual(s.surfaceOffset(atX: x), 0, accuracy: 0.01)
        }
        for _ in 0..<10 { s = s.step(dt: 1.0/60.0, acceleration: CGVector(dx: 2000, dy: 0), targetLevel: 0.5) }
        for x in stride(from: -1.0, through: 1.0, by: 0.25) {
            XCTAssertLessThanOrEqual(abs(s.surfaceOffset(atX: x)), 0.45)
        }
    }
    func testDtClamped() {
        var s = FluidSim.rest
        s = s.step(dt: 5.0, acceleration: .zero, targetLevel: 1.0) // huge dt must not explode/teleport
        XCTAssertLessThan(s.level, 0.2)
    }
    func testTiltHardBoundUnderSustainedMotion() {
        var s = FluidSim.rest
        for _ in 0..<600 { s = s.step(dt: 1.0/60.0, acceleration: CGVector(dx: 5000, dy: 0), targetLevel: 0.5) }
        XCTAssertLessThanOrEqual(abs(s.tilt), 0.5 + 1e-9) // never past kMaxTilt, even mid-overshoot regime
    }

    // MARK: - Final-review Important-2 (D9 settled-tick freeze): `isSettled(targetLevel:)`

    func testSettlesFromMotionOnceCalm() {
        var s = FluidSim.rest
        for _ in 0..<30 { s = s.step(dt: 1.0/60.0, acceleration: CGVector(dx: 800, dy: 0), targetLevel: 0.5) }
        XCTAssertFalse(s.isSettled(targetLevel: 0.5), "excited motion must never read as settled")
        for _ in 0..<600 { s = s.step(dt: 1.0/60.0, acceleration: .zero, targetLevel: 0.5) }
        XCTAssertTrue(s.isSettled(targetLevel: 0.5), "calm + converged tilt/wave/level must read as settled")
    }

    func testNeverSettlesUnderSustainedExcitement() {
        var s = FluidSim.rest
        for _ in 0..<600 { s = s.step(dt: 1.0/60.0, acceleration: CGVector(dx: 600, dy: 300), targetLevel: 0.5) }
        XCTAssertFalse(s.isSettled(targetLevel: 0.5), "sustained motion (real drag/fill in flight) must never read as settled")
    }

    func testDrainToNewTargetEventuallySettles() {
        var s = FluidSim.rest
        for _ in 0..<300 { s = s.step(dt: 1.0/60.0, acceleration: .zero, targetLevel: 1.0) } // fill to 1.0 first
        XCTAssertTrue(s.isSettled(targetLevel: 1.0))
        for _ in 0..<600 { s = s.step(dt: 1.0/60.0, acceleration: .zero, targetLevel: 0.0) } // calm drain to 0
        XCTAssertTrue(s.isSettled(targetLevel: 0.0), "a calm drain must settle at its NEW target, not stay stuck reading the old one")
    }

    func testNotSettledMidwayThroughADrain() {
        var s = FluidSim.rest
        for _ in 0..<300 { s = s.step(dt: 1.0/60.0, acceleration: .zero, targetLevel: 1.0) }
        s = s.step(dt: 1.0/60.0, acceleration: .zero, targetLevel: 0.0) // one step into the drain
        XCTAssertFalse(s.isSettled(targetLevel: 0.0), "must not report settled while still most of the way from the target — no early freeze")
    }
}
