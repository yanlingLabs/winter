import XCTest
@testable import Winter

/// Coverage for `CursorCalmTracker` (Orb/CursorCalmTracker.swift) — the pure calm-gating seam
/// behind wave-3 gate item 2b's answer-arrival auto-expand: a finished reply only auto-expands
/// the field when the cursor has been under 300pt/s for the last 0.4s; otherwise the orb is
/// marked unread instead of snapping open under a moving cursor.
final class CursorCalmTrackerTests: XCTestCase {
    func testNeverFastIsCalm() {
        let tracker = CursorCalmTracker()
        XCTAssertTrue(tracker.isCalm(at: 0))
        XCTAssertTrue(tracker.isCalm(at: 1_000))
    }

    func testFastRecentlyIsNotCalm() {
        var tracker = CursorCalmTracker()
        tracker.record(speed: 400, at: 0)
        XCTAssertFalse(tracker.isCalm(at: 0.1))
    }

    func testFastThenQuietHalfSecondIsCalm() {
        var tracker = CursorCalmTracker()
        tracker.record(speed: 400, at: 0)
        XCTAssertTrue(tracker.isCalm(at: 0.5))
    }

    func testBoundaryJustUnderThresholdIsNotCalm() {
        var tracker = CursorCalmTracker()
        tracker.record(speed: 400, at: 0)
        // Exactly at 0.39s — strictly less than the 0.4s calmDuration, so still not calm.
        XCTAssertFalse(tracker.isCalm(at: 0.39))
    }

    /// A slow sample never resets the tracked "last fast" timestamp early.
    func testSlowSampleDoesNotClearFastTimestamp() {
        var tracker = CursorCalmTracker()
        tracker.record(speed: 400, at: 0)
        tracker.record(speed: 10, at: 0.1)
        XCTAssertFalse(tracker.isCalm(at: 0.2), "a slow sample must not erase the earlier fast one")
        XCTAssertTrue(tracker.isCalm(at: 0.5))
    }
}
