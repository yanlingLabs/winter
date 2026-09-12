import XCTest
@testable import Winter

final class SpringStepTests: XCTestCase {
    let cfg = SpringConfig.v1

    func testConvergesToTargetAndSettles() {
        var s = SpringState(position: .zero, velocity: .zero)
        let target = CGPoint(x: 300, y: 200)
        var tier = SpringTier.active
        for _ in 0..<2000 {
            (s, tier) = springStep(s, target: target, dt: 1.0 / 120.0, config: cfg)
            if tier == .settled { break }
        }
        XCTAssertEqual(tier, .settled)
        XCTAssertEqual(s.position, target) // snap is exact
        XCTAssertEqual(s.velocity, .zero)
    }

    func testSnapThresholdsMatchV1() {
        // just inside both thresholds → settles in one step
        let near = SpringState(position: CGPoint(x: 100.2, y: 100), velocity: CGPoint(x: 10, y: 0))
        let (s1, t1) = springStep(near, target: CGPoint(x: 100, y: 100), dt: 1.0 / 120.0, config: cfg)
        XCTAssertEqual(t1, .settled)
        XCTAssertEqual(s1.position, CGPoint(x: 100, y: 100))
        // inside distance but too fast → not settled
        let fast = SpringState(position: CGPoint(x: 100.2, y: 100), velocity: CGPoint(x: 30, y: 0))
        let (_, t2) = springStep(fast, target: CGPoint(x: 100, y: 100), dt: 1.0 / 120.0, config: cfg)
        XCTAssertNotEqual(t2, .settled)
    }

    func testGlideTier() {
        // within 8pt and slow-ish (<80) but not snap-close → glide (v1's 30fps tier)
        let s = SpringState(position: CGPoint(x: 105, y: 100), velocity: CGPoint(x: 40, y: 0))
        let (_, tier) = springStep(s, target: CGPoint(x: 100, y: 100), dt: 1.0 / 120.0, config: cfg)
        XCTAssertEqual(tier, .glide)
    }

    func testDtIsClamped() {
        // a huge dt (app slept) must not explode the integration: clamp to 1/30
        var s = SpringState(position: .zero, velocity: .zero)
        (s, _) = springStep(s, target: CGPoint(x: 100, y: 0), dt: 5.0, config: cfg)
        let unclamped = 120.0 * 100.0 * 5.0 * 5.0 // stiffness*dx*dt*dt if dt weren't clamped
        XCTAssertLessThan(abs(s.position.x), unclamped / 100) // sanity: nowhere near runaway
        XCTAssertLessThan(s.position.x, 20) // 120*100*(1/30)*(1/30) ≈ 13.3 max first-step travel
    }

    func testPerSpringDtClampMatchesV1Sources() {
        // v1 tunes the dt clamp ceiling per spring, not globally: the orb-following spring
        // (PointerFollower.swift:154) clamps to 1/30, while the field's window-origin
        // tracking spring (GlassFieldWindow.swift:1957) clamps to 1/20.
        XCTAssertEqual(SpringConfig.v1.dtClampMax, 1.0 / 30.0)
        XCTAssertEqual(SpringConfig.tracking.dtClampMax, 1.0 / 20.0)
    }

    func testCriticallyDampedNoWildOvershoot() {
        // v1 tuning overshoots slightly but never oscillates wildly: after crossing the
        // target once, the max overshoot stays under 15% of the initial distance.
        var s = SpringState(position: .zero, velocity: .zero)
        let target = CGPoint(x: 100, y: 0)
        var maxOvershoot: CGFloat = 0
        for _ in 0..<2000 {
            let r = springStep(s, target: target, dt: 1.0 / 120.0, config: cfg)
            s = r.state
            maxOvershoot = max(maxOvershoot, s.position.x - target.x)
            if r.tier == .settled { break }
        }
        XCTAssertLessThan(maxOvershoot, 15.0)
    }
}
