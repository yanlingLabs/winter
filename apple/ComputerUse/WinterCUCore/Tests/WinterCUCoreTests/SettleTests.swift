import XCTest
@testable import WinterCUCore

/// The settle state machine and loop (spec §7) against a fake clock and a scripted notification source.
final class SettleTests: XCTestCase {
    /// A clock that only moves when the loop sleeps.
    final class FakeClock: CUClock, @unchecked Sendable {
        private let lock = NSLock()
        private var now: Double
        private(set) var sleeps: [Double] = []
        var onSleep: ((Double) -> Void)?
        init(_ start: Double = 1000) { now = start }
        func nowMs() -> Double { lock.lock(); defer { lock.unlock() }; return now }
        func sleep(ms: Double) async throws {
            let t: Double = lock.withLock { now += ms; sleeps.append(ms); return now }
            onSleep?(t)
        }
    }

    /// Notifications and window-list changes scheduled at clock times.
    final class FakeSource: CUActivitySource, @unchecked Sendable {
        let clock: FakeClock
        var notifications: [Double] = []
        var windowChanges: [Double] = []
        init(clock: FakeClock) { self.clock = clock }
        func lastNotificationMs(pid: pid_t) -> Double? {
            notifications.filter { $0 <= clock.nowMs() }.max()
        }
        func windowSignature(pid: pid_t) -> Int {
            windowChanges.filter { $0 <= clock.nowMs() }.count
        }
    }

    // MARK: machine

    func testMachineSettlesAfterQuietAndFloor() {
        var m = CUSettleMachine(startedAt: 0, quietMs: 150, timeoutMs: 3000, floorMs: 30, lastActivityAt: -500)
        XCTAssertEqual(m.evaluate(now: 10), .waiting(checkInMs: 20), "the 30 ms floor always applies")
        XCTAssertEqual(m.evaluate(now: 30), .settled(waitedMs: 30))
        m.activity(at: 40)
        XCTAssertEqual(m.evaluate(now: 100), .waiting(checkInMs: 90))
        XCTAssertEqual(m.evaluate(now: 190), .settled(waitedMs: 190))
        XCTAssertEqual(m.activityCount, 1)
    }

    func testMachineWithoutKnownActivityWaitsAFullQuietPeriod() {
        let m = CUSettleMachine(startedAt: 0, quietMs: 150, timeoutMs: 3000)
        XCTAssertEqual(m.evaluate(now: 100), .waiting(checkInMs: 50))
        XCTAssertEqual(m.evaluate(now: 150), .settled(waitedMs: 150))
    }

    func testMachineTimesOutUnderConstantActivity() {
        var m = CUSettleMachine(startedAt: 0, quietMs: 150, timeoutMs: 500)
        for t in stride(from: 0.0, through: 500, by: 50) { m.activity(at: t) }
        XCTAssertEqual(m.evaluate(now: 500), .timedOut(waitedMs: 500))
    }

    func testOldActivityDoesNotMoveTheClockBack() {
        var m = CUSettleMachine(startedAt: 0, quietMs: 100, timeoutMs: 1000, lastActivityAt: 50)
        m.activity(at: 10)
        XCTAssertEqual(m.lastActivityAt, 50)
    }

    // MARK: loop

    func testLoopSettlesAfterANotificationBurst() async throws {
        let clock = FakeClock(0)
        let source = FakeSource(clock: clock)
        source.notifications = [10, 40, 80, 120]
        let settler = CUSettler(clock: clock, source: source, pollMs: 25)
        let o = try await settler.waitIdle(pid: 1, quietMs: 150, timeoutMs: 3000)
        XCTAssertTrue(o.settled)
        XCTAssertEqual(o.exit, "quiet")
        // The last notification is at 120 → quiet from 270 (polled every ≤ 25 ms).
        XCTAssertGreaterThanOrEqual(o.waitedMs, 270)
        XCTAssertLessThan(o.waitedMs, 300)
    }

    func testWindowListChangeCountsAsActivity() async throws {
        let clock = FakeClock(0)
        let source = FakeSource(clock: clock)
        source.windowChanges = [200]  // a sheet appears
        let o = try await CUSettler(clock: clock, source: source).waitIdle(pid: 1, quietMs: 150, timeoutMs: 3000,
                                                                          lastActionMs: -1000)
        XCTAssertTrue(o.settled)
        XCTAssertLessThan(o.waitedMs, 60, "nothing happened before the floor... settles early")
        // Restart with the change landing inside the quiet window.
        let clock2 = FakeClock(0)
        let source2 = FakeSource(clock: clock2)
        source2.windowChanges = [100]
        let o2 = try await CUSettler(clock: clock2, source: source2).waitIdle(pid: 1, quietMs: 150, timeoutMs: 3000)
        XCTAssertGreaterThanOrEqual(o2.waitedMs, 250)
    }

    func testRecentActionHoldsTheWait() async throws {
        let clock = FakeClock(1000)
        let source = FakeSource(clock: clock)
        // The helper acted 20 ms ago and the app hasn't reacted yet: no settling before 170.
        let o = try await CUSettler(clock: clock, source: source).waitIdle(pid: 1, quietMs: 150, timeoutMs: 3000,
                                                                         lastActionMs: 980)
        XCTAssertTrue(o.settled)
        XCTAssertGreaterThanOrEqual(o.waitedMs, 130)
    }

    func testLoopCapsAtTimeout() async throws {
        let clock = FakeClock(0)
        let source = FakeSource(clock: clock)
        source.notifications = Array(stride(from: 0.0, through: 2000, by: 20))
        let o = try await CUSettler(clock: clock, source: source).waitIdle(pid: 1, quietMs: 150, timeoutMs: 1500)
        XCTAssertFalse(o.settled)
        XCTAssertEqual(o.exit, "cap")
        XCTAssertGreaterThanOrEqual(o.waitedMs, 1500)
        XCTAssertLessThan(o.waitedMs, 1530)
    }

    func testLoopStopsWhenCancelled() async {
        let clock = FakeClock(0)
        let source = FakeSource(clock: clock)
        source.notifications = Array(stride(from: 0.0, through: 5000, by: 20))
        let token = CUCancellation.Token()
        clock.onSleep = { t in if t > 300 { token.cancel() } }
        do {
            _ = try await CUSettler(clock: clock, source: source).waitIdle(pid: 1, quietMs: 150, timeoutMs: 5000,
                                                                          isCancelled: { token.isCancelled })
            XCTFail("expected cancellation")
        } catch {
            XCTAssertEqual((error as? CUError)?.code, "cancelled")
        }
    }

    // MARK: the user-input guard's arithmetic

    func testUserInputDeferral() {
        XCTAssertEqual(CUUserInputGuard.deferral(msSinceInput: 1000, alreadyWaitedMs: 0), 0)
        XCTAssertEqual(CUUserInputGuard.deferral(msSinceInput: 40, alreadyWaitedMs: 0), 110)
        XCTAssertEqual(CUUserInputGuard.deferral(msSinceInput: 0, alreadyWaitedMs: 950), 50, "never past 1 s in total")
        XCTAssertEqual(CUUserInputGuard.deferral(msSinceInput: 0, alreadyWaitedMs: 1000), 0)
    }
}
