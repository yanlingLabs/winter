import XCTest
@testable import Winter

final class TapRecognizerTests: XCTestCase {
    func four(_ base: Float, spread: Float = 0.1) -> [TouchSample] {
        (0..<4).map { TouchSample(id: $0, pos: SIMD2<Float>(base + Float($0) * spread, 0.5)) }
    }
    func moved(_ samples: [TouchSample], dx: Float) -> [TouchSample] {
        samples.map { TouchSample(id: $0.id, pos: SIMD2<Float>($0.pos.x + dx, $0.pos.y)) }
    }

    func testCleanTapFires() {
        var r = TapRecognizer()
        XCTAssertFalse(r.ingest(active: four(0.2), at: 0))
        XCTAssertFalse(r.ingest(active: four(0.2), at: 0.03))
        XCTAssertTrue(r.ingest(active: [], at: 0.08)) // lift inside [0.025, 0.18)
    }

    func testSpacesSwipeNeverFires() {
        var r = TapRecognizer()
        var touches = four(0.1)
        _ = r.ingest(active: touches, at: 0)
        for i in 1...8 { // fingers slide right — a Spaces swipe
            touches = moved(touches, dx: 0.03)
            XCTAssertFalse(r.ingest(active: touches, at: Double(i) * 0.012))
        }
        XCTAssertFalse(r.ingest(active: [], at: 0.12)) // lift within tap window but MOVED → no fire
    }

    func testSlowHoldDoesNotFire() {
        var r = TapRecognizer()
        _ = r.ingest(active: four(0.3), at: 0)
        _ = r.ingest(active: four(0.3), at: 0.1)
        XCTAssertFalse(r.ingest(active: [], at: 0.25)) // ≥ maxDuration
    }

    func testFiveFingersInvalidates() {
        var r = TapRecognizer()
        _ = r.ingest(active: four(0.2), at: 0)
        var five = four(0.2); five.append(TouchSample(id: 9, pos: SIMD2<Float>(0.9, 0.9)))
        _ = r.ingest(active: five, at: 0.02)
        _ = r.ingest(active: four(0.2), at: 0.04)
        XCTAssertFalse(r.ingest(active: [], at: 0.06))
    }

    func testThreeFingerStartNeverArms() {
        var r = TapRecognizer()
        _ = r.ingest(active: Array(four(0.2).prefix(3)), at: 0)
        XCTAssertFalse(r.ingest(active: [], at: 0.05))
    }

    func testFingerIdentityChurnInvalidates() {
        var r = TapRecognizer()
        _ = r.ingest(active: four(0.2), at: 0)
        let swapped = (0..<4).map { TouchSample(id: $0 + 10, pos: four(0.2)[$0].pos) } // new ids
        _ = r.ingest(active: swapped, at: 0.03)
        XCTAssertFalse(r.ingest(active: [], at: 0.06))
    }

    func testResetAfterInvalidatedGestureAllowsNextTap() {
        var r = TapRecognizer()
        var touches = four(0.1)
        _ = r.ingest(active: touches, at: 0)
        touches = moved(touches, dx: 0.2) // invalidate by travel
        _ = r.ingest(active: touches, at: 0.03)
        _ = r.ingest(active: [], at: 0.06) // lift, no fire, RESETS (v1's latch bug fix)
        _ = r.ingest(active: four(0.4), at: 1.0)
        _ = r.ingest(active: four(0.4), at: 1.03)
        XCTAssertTrue(r.ingest(active: [], at: 1.06)) // clean tap after reset fires
    }

    func testSingleFrameBlipDoesNotFire() {
        var r = TapRecognizer()
        _ = r.ingest(active: four(0.2), at: 0)      // ONE armed frame only
        XCTAssertFalse(r.ingest(active: [], at: 0.05)) // lift inside the duration window — must NOT fire
    }
}
