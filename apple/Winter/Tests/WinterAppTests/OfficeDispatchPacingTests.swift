import XCTest
@testable import Winter

/// `OfficeDispatchPacing` — the yielding, time-bounded wait every async `.uno:` dispatch in the
/// office helper now uses, and the view switches that pin an agent dispatch to the agent view.
/// Driven with a fake clock: `sleep` advances it, `attempt` stands in for "LibreOffice's own thread
/// has (or has not) run the dispatch yet".
final class OfficeDispatchPacingTests: XCTestCase {
    private final class FakeClock {
        var nanos: UInt64 = 1_000_000_000
        var sleeps: [UInt32] = []
        func sleep(_ micros: UInt32) {
            sleeps.append(micros)
            nanos += UInt64(micros) * 1_000
        }
    }

    func testAnImmediateSuccessNeverSleeps() {
        let clock = FakeClock()
        let outcome = OfficeDispatchPacing.poll(budgetNanos: 750_000_000, now: { clock.nanos },
                                                sleep: clock.sleep) { true }
        XCTAssertEqual(outcome, .init(satisfied: true, attempts: 1, elapsedNanos: 0))
        XCTAssertEqual(clock.sleeps, [])
    }

    func testRetriesBackOffExponentiallyFromOneMillisecond() {
        let clock = FakeClock()
        var calls = 0
        let outcome = OfficeDispatchPacing.poll(budgetNanos: 750_000_000, now: { clock.nanos },
                                                sleep: clock.sleep) {
            calls += 1
            return calls == 4
        }
        XCTAssertTrue(outcome.satisfied)
        XCTAssertEqual(outcome.attempts, 4)
        XCTAssertEqual(clock.sleeps, [1_000, 2_000, 4_000])
    }

    /// The defect this type exists for: what is waited on is ANOTHER thread, which only time can
    /// stand in for. Here the "dispatch" lands 30 ms after the post. The old fixed budget — five
    /// immediate attempts with no time between them — could never see it; the yielding wait does.
    func testADispatchThatLandsOnlyAfterRealTimeIsStillSeen() {
        let clock = FakeClock()
        let landsAt = clock.nanos + 30_000_000
        let outcome = OfficeDispatchPacing.poll(budgetNanos: 750_000_000, now: { clock.nanos },
                                                sleep: clock.sleep) { clock.nanos >= landsAt }
        XCTAssertTrue(outcome.satisfied, "the wait must outlast a 30 ms scheduling delay")
        XCTAssertGreaterThan(outcome.attempts, 5, "more than the old five immediate attempts were needed")
        XCTAssertGreaterThanOrEqual(outcome.elapsedNanos, 30_000_000)
    }

    func testNeverLandingStopsAtTheBudgetWithOneAttemptAfterTheLastSleep() {
        let clock = FakeClock()
        var attemptTimes: [UInt64] = []
        let start = clock.nanos
        let outcome = OfficeDispatchPacing.poll(budgetNanos: 200_000_000, now: { clock.nanos },
                                                sleep: clock.sleep) {
            attemptTimes.append(clock.nanos - start)
            return false
        }
        XCTAssertFalse(outcome.satisfied)
        XCTAssertEqual(outcome.elapsedNanos, 200_000_000, "sleeps are clamped to the budget, never past it")
        XCTAssertEqual(attemptTimes.last, 200_000_000, "the last sleep is followed by one more attempt")
        XCTAssertEqual(clock.sleeps.max(), 50_000, "pauses are capped at 50 ms")
        XCTAssertEqual(outcome.attempts, attemptTimes.count)
    }

    /// `SfxLokHelper::setView` only sets the desktop's active frame — which is what
    /// `postUnoCommand` dispatches to — on a REAL switch, so an agent dispatch goes through the
    /// primary view first and ends on the agent view.
    func testAnAgentDispatchSwitchesThroughThePrimaryViewAndEndsOnTheAgent() {
        XCTAssertEqual(OfficeDispatchPacing.viewSwitchesToTarget(3, primary: 0), [0, 3])
    }

    func testAPrimaryDispatchIsASingleSetView() {
        XCTAssertEqual(OfficeDispatchPacing.viewSwitchesToTarget(0, primary: 0), [0])
    }
}
