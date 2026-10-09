import CoreGraphics
import XCTest
@testable import WinterCUPresentation

/// The window cache behind the overlay and the mirror: no listing of every window, nothing on the main thread but the
/// first sight of a window, and a per-poll cost that does not grow with the number of windows on the system.
final class WindowTrackerTests: XCTestCase {
    /// A window server with `total` windows that counts what it is asked for.
    final class FakeServer: WindowServer, @unchecked Sendable {
        let lock = NSLock()
        var windows: [CGWindowID: StackWindow] = [:]
        /// What lies above each window, front to back.
        var aboveOf: [CGWindowID: [CGWindowID]] = [:]
        var describeCalls = 0
        var describedWindows = 0
        var aboveCalls = 0

        init(total: Int) {
            for i in 1...total {
                let id = CGWindowID(i)
                windows[id] = StackWindow(id: id, pid: pid_t(1000 + i), layer: 0,
                                          bounds: CGRect(x: Double(i % 50) * 10, y: Double(i % 30) * 10, width: 400, height: 300))
            }
        }

        func describe(_ ids: [CGWindowID]) -> [StackWindow] {
            lock.lock(); defer { lock.unlock() }
            describeCalls += 1
            describedWindows += ids.count
            return ids.compactMap { windows[$0] }
        }

        func windowsAbove(_ id: CGWindowID) -> [StackWindow] {
            lock.lock(); defer { lock.unlock() }
            aboveCalls += 1
            return (aboveOf[id] ?? []).compactMap { windows[$0] }
        }
    }

    final class Clock: @unchecked Sendable { var now: TimeInterval = 0 }

    func makeTracker(_ server: FakeServer, _ clock: Clock) -> WindowTracker {
        WindowTracker(server: server, queue: nil, now: { clock.now })
    }

    func testThePollSlowsToTheRateTheControllerReadsAtButNeverBelowItsBase() {
        let server = FakeServer(total: 10)
        let clock = Clock()
        let tracker = makeTracker(server, clock)
        XCTAssertEqual(tracker.pollInterval, 0.05)
        tracker.setPollInterval(0.5)
        XCTAssertEqual(tracker.pollInterval, 0.5)
        XCTAssertEqual(tracker.aboveTTL, 0.5, "the covered check's list is refreshed no faster either")
        tracker.setPollInterval(0.01)
        XCTAssertEqual(tracker.pollInterval, 0.05)
        XCTAssertEqual(tracker.aboveTTL, 0.15)
    }

    func testAtTheIdleRateTheAboveListIsFetchedNoMoreOftenThanItIsRead() {
        let server = FakeServer(total: 10)
        let clock = Clock()
        let tracker = makeTracker(server, clock)
        tracker.setPollInterval(0.5)
        _ = tracker.windowsAbove(3)
        tracker.pollNow()
        let calls = server.aboveCalls
        for _ in 0..<4 { // polls 0.2 s apart (a late fast poll) inside one idle period
            clock.now += 0.2
            _ = tracker.windowsAbove(3)
            tracker.pollNow()
        }
        XCTAssertEqual(server.aboveCalls - calls, 1, "once in 0.8 s, not every poll")
    }

    func testOnlyTheFirstSightIsDescribedOnTheSpotThenItIsACacheRead() {
        let server = FakeServer(total: 10)
        let clock = Clock()
        let tracker = makeTracker(server, clock)
        XCTAssertEqual(tracker.snapshot(of: 3)?.frame, server.windows[3]?.bounds)
        XCTAssertEqual(server.describeCalls, 1)
        for _ in 0..<100 { _ = tracker.snapshot(of: 3) }
        XCTAssertEqual(server.describeCalls, 1, "later reads never reach the window server")
    }

    func testAPollDescribesTheFollowedWindowsInOneCallWhateverTheSystemHolds() {
        for total in [10, 2000] {
            let server = FakeServer(total: total)
            let clock = Clock()
            let tracker = makeTracker(server, clock)
            _ = tracker.snapshot(of: 1)
            _ = tracker.snapshot(of: 2)
            let calls = server.describeCalls, described = server.describedWindows
            for _ in 0..<50 {
                clock.now += 0.05
                _ = tracker.snapshot(of: 1)
                _ = tracker.snapshot(of: 2)
                tracker.pollNow()
            }
            XCTAssertEqual(server.describeCalls - calls, 50, "one call per poll (total \(total))")
            XCTAssertEqual(server.describedWindows - described, 100, "two windows per poll, not \(total)")
        }
    }

    func testAPollFollowsMovesAndNoticesAWindowThatWentAway() {
        let server = FakeServer(total: 10)
        let clock = Clock()
        let tracker = makeTracker(server, clock)
        _ = tracker.snapshot(of: 4)
        server.windows[4]?.bounds = CGRect(x: 1, y: 2, width: 3, height: 4)
        tracker.pollNow()
        XCTAssertEqual(tracker.snapshot(of: 4)?.frame, CGRect(x: 1, y: 2, width: 3, height: 4))
        server.windows[4] = nil
        tracker.pollNow()
        // Gone: the cache says so (the next read describes it again, and finds nothing).
        XCTAssertNil(tracker.snapshot(of: 4))
    }

    func testWindowsNobodyAsksAboutAreForgotten() {
        let server = FakeServer(total: 10)
        let clock = Clock()
        let tracker = makeTracker(server, clock)
        _ = tracker.snapshot(of: 5)
        clock.now += tracker.forgetAfter + 0.1
        let before = server.describedWindows
        tracker.pollNow()
        XCTAssertEqual(server.describedWindows, before, "a forgotten window is no longer described")
    }

    func testWhatLiesAboveIsFetchedOnlyForAskedTargetsAndAtMostEvery150ms() {
        let server = FakeServer(total: 2000)
        server.aboveOf[7] = [8, 9]
        let clock = Clock()
        let tracker = makeTracker(server, clock)
        XCTAssertNil(tracker.windowsAbove(7), "nothing fetched yet: the caller treats it as unknown")
        tracker.pollNow()
        XCTAssertEqual(tracker.windowsAbove(7)?.map(\.id), [8, 9])
        XCTAssertEqual(server.aboveCalls, 1)
        clock.now += 0.1
        tracker.pollNow()
        XCTAssertEqual(server.aboveCalls, 1, "fresher than 150 ms: not fetched again")
        clock.now += 0.06
        tracker.pollNow()
        XCTAssertEqual(server.aboveCalls, 2)
    }

    /// Micro-benchmark: many polls against a system with 5,000 windows. The work per poll is counted, so the proof does
    /// not depend on this machine's speed: one describe of the followed windows plus one above-fetch per watched target.
    func testPerPollCostDoesNotScaleWithTheWindowCount() {
        var perPoll: [Int: Double] = [:]
        for total in [50, 5000] {
            let server = FakeServer(total: total)
            server.aboveOf[1] = [2, 3]
            let clock = Clock()
            let tracker = makeTracker(server, clock)
            let polls = 200
            let start = DispatchTime.now().uptimeNanoseconds
            for _ in 0..<polls {
                clock.now += 0.2
                _ = tracker.snapshot(of: 1)
                _ = tracker.windowsAbove(1)
                tracker.pollNow()
            }
            let elapsed = Double(DispatchTime.now().uptimeNanoseconds - start) / 1e6
            perPoll[total] = Double(server.describedWindows + server.aboveCalls) / Double(polls)
            print("WindowTracker: \(total) windows, \(polls) polls in \(String(format: "%.2f", elapsed)) ms")
        }
        XCTAssertEqual(perPoll[50], perPoll[5000], "work per poll is the same with 50 or 5,000 windows")
        XCTAssertLessThanOrEqual(perPoll[5000] ?? .infinity, 2.05)
    }

    func testTheFrameSourceResizesOnlyForARealChangeOfShape() {
        XCTAssertFalse(CUWindowFrameSource.shapeChanged(from: CGSize(width: 800, height: 600),
                                                        to: CGSize(width: 800.5, height: 600.4)))
        XCTAssertTrue(CUWindowFrameSource.shapeChanged(from: CGSize(width: 800, height: 600),
                                                       to: CGSize(width: 820, height: 600)))
    }
}
