import XCTest
@testable import WinterKit

/// `KeychainToken.readWithBoundedRetry` — the daemon-boot ACL-refresh race fix. A hand-written
/// "fake token store" (a counting closure) drives every case; `sleep` is recorded instead of ever
/// blocking real wall-clock time, so this whole suite runs in milliseconds.
final class KeychainTokenRetryTests: XCTestCase {
    /// A success on the FIRST attempt never sleeps at all — the common case costs nothing.
    func testSucceedsImmediatelyWithNoSleepWhenTheFirstReadSucceeds() throws {
        var sleeps: [TimeInterval] = []
        let token = try KeychainToken.readWithBoundedRetry(sleep: { sleeps.append($0) }) {
            "tok_ok"
        }
        XCTAssertEqual(token, "tok_ok")
        XCTAssertTrue(sleeps.isEmpty)
    }

    /// The exact case named in the ask: "a fake token store that returns notFound once then the
    /// value." One retry, one sleep (the schedule's first delay), the eventual value returned.
    func testNotFoundOnceThenTheValueRetriesOnceAndSucceeds() throws {
        var attempt = 0
        var sleeps: [TimeInterval] = []
        let token = try KeychainToken.readWithBoundedRetry(sleep: { sleeps.append($0) }) {
            attempt += 1
            if attempt == 1 { throw KeychainError.notFound }
            return "tok_ok"
        }
        XCTAssertEqual(token, "tok_ok")
        XCTAssertEqual(attempt, 2)
        XCTAssertEqual(sleeps, [0.25])
    }

    /// The full default schedule sums to ~5 seconds across five backoffs (six reads total) — the
    /// item's own "a few times over ~5 s with backoff."
    func testDefaultScheduleIsFiveBackoffsSummingToAboutFiveSeconds() throws {
        var attempts = 0
        var sleeps: [TimeInterval] = []
        let token = try KeychainToken.readWithBoundedRetry(sleep: { sleeps.append($0) }) {
            attempts += 1
            if attempts <= 5 { throw KeychainError.notFound }
            return "tok_ok"
        }
        XCTAssertEqual(token, "tok_ok")
        XCTAssertEqual(attempts, 6)
        XCTAssertEqual(sleeps, [0.25, 0.5, 1.0, 1.5, 1.75])
        XCTAssertEqual(sleeps.reduce(0, +), 5.0, accuracy: 0.0001)
    }

    /// Exhausting every retry still `.notFound` rethrows `.notFound` — the caller's EXISTING
    /// "no token yet, daemon never ran" fallback (`tokenMissing`) applies exactly as before this
    /// fix, for a window that genuinely never closes.
    func testExhaustingAllRetriesRethrowsNotFound() {
        var attempts = 0
        var sleeps: [TimeInterval] = []
        XCTAssertThrowsError(
            try KeychainToken.readWithBoundedRetry(sleep: { sleeps.append($0) }) {
                attempts += 1
                throw KeychainError.notFound
            }
        ) { error in
            XCTAssertEqual(error as? KeychainError, .notFound)
        }
        XCTAssertEqual(attempts, 6, "one initial read plus all five scheduled retries")
        XCTAssertEqual(sleeps.count, 5)
    }

    /// `.unreadable` (a malformed item, a denied ACL) is a REAL problem — propagates on the FIRST
    /// attempt, unretried, with zero sleeps. Blind retrying would only delay a genuine failure.
    func testUnreadableNeverRetries() {
        var attempts = 0
        var sleeps: [TimeInterval] = []
        XCTAssertThrowsError(
            try KeychainToken.readWithBoundedRetry(sleep: { sleeps.append($0) }) {
                attempts += 1
                throw KeychainError.unreadable(-25300)
            }
        ) { error in
            XCTAssertEqual(error as? KeychainError, .unreadable(-25300))
        }
        XCTAssertEqual(attempts, 1)
        XCTAssertTrue(sleeps.isEmpty)
    }

    /// Any OTHER error (not a `KeychainError` at all) also propagates immediately, unretried — this
    /// helper widens nothing beyond the one documented case.
    func testAnUnrelatedErrorNeverRetries() {
        struct SomeOtherError: Error, Equatable {}
        var attempts = 0
        XCTAssertThrowsError(
            try KeychainToken.readWithBoundedRetry(sleep: { _ in }) {
                attempts += 1
                throw SomeOtherError()
            }
        )
        XCTAssertEqual(attempts, 1)
    }

    /// A custom, shorter schedule (as a caller with tighter latency needs might pass) is honored
    /// verbatim — the default is a default, not a hardcoded constant.
    func testACustomScheduleIsHonoredVerbatim() throws {
        var attempts = 0
        var sleeps: [TimeInterval] = []
        let token = try KeychainToken.readWithBoundedRetry(delays: [0.1, 0.2], sleep: { sleeps.append($0) }) {
            attempts += 1
            if attempts <= 2 { throw KeychainError.notFound }
            return "tok_ok"
        }
        XCTAssertEqual(token, "tok_ok")
        XCTAssertEqual(sleeps, [0.1, 0.2])
    }
}
