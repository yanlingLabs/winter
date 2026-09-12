import XCTest
@testable import Winter

final class StickinessPolicyTests: XCTestCase {
    let a = ClickableCandidate(center: CGPoint(x: 100, y: 100), frame: CGRect(x: 90, y: 90, width: 20, height: 20))
    let b = ClickableCandidate(center: CGPoint(x: 200, y: 100), frame: CGRect(x: 190, y: 90, width: 20, height: 20))

    func testCapturesNearestWithinCaptureRadius() {
        let t = stickyTarget(cursor: CGPoint(x: 130, y: 100), current: nil, candidates: [a, b])
        XCTAssertEqual(t, a.center) // 30pt vs 70pt — both within 80, nearest wins
    }

    func testNoCaptureBeyondRadius() {
        XCTAssertNil(stickyTarget(cursor: CGPoint(x: 400, y: 400), current: nil, candidates: [a, b]))
    }

    func testHysteresisHoldsCurrentInsideReleaseRadius() {
        // cursor at (100,190): 90pt from a — beyond capture (80) but inside release (96),
        // and no other candidate in range → a is HELD (no flap at the boundary)
        let held = stickyTarget(cursor: CGPoint(x: 100, y: 190), current: a.center, candidates: [a])
        XCTAssertEqual(held, a.center)
    }

    func testDeliberateSwitchToCandidateUnderCursor() {
        // cursor at (190,100): 90pt from held a (inside release), 10pt from b —
        // b is within switchRadius (40) → deliberate switch wins over the hold
        let t = stickyTarget(cursor: CGPoint(x: 190, y: 100), current: a.center, candidates: [a, b])
        XCTAssertEqual(t, b.center)
    }

    func testReleaseBeyondReleaseRadius() {
        XCTAssertNil(stickyTarget(cursor: CGPoint(x: 100, y: 200), current: a.center, candidates: [a])) // 100pt > 96
    }

    func testNoSwitchWhenOtherCandidateBeyondSwitchRadius() {
        // cursor at (100,185): 85pt from held a (inside release). c sits 45pt from the
        // cursor — inside captureRadius (80) but OUTSIDE switchRadius (40) → a stays held.
        let c = ClickableCandidate(center: CGPoint(x: 100, y: 140), frame: .zero)
        let t = stickyTarget(cursor: CGPoint(x: 100, y: 185), current: a.center, candidates: [a, c])
        XCTAssertEqual(t, a.center)
    }

    func testHeldAbsentFromCandidatesDoesNotSwitchToFartherCandidate() {
        // held at 30pt (inside release), NOT in the candidates array (AX re-layout blip);
        // another candidate at 38pt is inside switchRadius but FARTHER than held → keep held
        let held = CGPoint(x: 100, y: 130) // 30pt above cursor
        let far = ClickableCandidate(center: CGPoint(x: 100, y: 62), frame: .zero) // 38pt below cursor
        let t = stickyTarget(cursor: CGPoint(x: 100, y: 100), current: held, candidates: [far])
        XCTAssertEqual(t, held)
    }
}
