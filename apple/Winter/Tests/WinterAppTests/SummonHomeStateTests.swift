import XCTest
@testable import Winter

/// GATE-3 FIX (round 3, F4): the summon home-state rule — `summonShowsComposer` decides, at the
/// instant the surface flips orb→field, whether the COMPOSER takes the shell (v1's home-state
/// semantics: yes on every fresh summon) or the in-flight response keeps it (only when a turn is
/// actively streaming). See `GlassRootView.swift` for the wiring.
final class SummonHomeStateTests: XCTestCase {
    func testIdleSessionSummonsIntoComposer() {
        XCTAssertTrue(summonShowsComposer(turnRunning: false, streamingText: ""))
    }

    func testSessionWithFinishedReplySummonsIntoComposer() {
        // The regression this rule fixes: a finished turn leaves streamingText empty and
        // turnRunning false — the previous reply must NOT hold the shell on re-summon.
        XCTAssertTrue(summonShowsComposer(turnRunning: false, streamingText: ""))
    }

    func testThinkingOnlyTurnStillSummonsIntoComposer() {
        // Turn running but nothing streamed yet (shimmer-only state): nothing readable would
        // be yanked away — composer stays the home state.
        XCTAssertTrue(summonShowsComposer(turnRunning: true, streamingText: ""))
    }

    func testActivelyStreamingTurnKeepsTheResponse() {
        XCTAssertFalse(summonShowsComposer(turnRunning: true, streamingText: "partial reply…"))
    }

    func testStaleStreamTextWithoutRunningTurnSummonsIntoComposer() {
        // Defensive: streamingText should be cleared when a turn ends, but even if a stale
        // value lingered, a non-running turn must not hold the shell.
        XCTAssertTrue(summonShowsComposer(turnRunning: false, streamingText: "leftover"))
    }
}
