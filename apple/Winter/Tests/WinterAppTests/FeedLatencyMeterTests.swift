import XCTest
import WinterProtocol
@testable import Winter

/// The feed's latency meter: the stamp read off any event, the spreads, the legs, and the one line per interval.
@MainActor
final class FeedLatencyMeterTests: XCTestCase {
    private func event(ts: Int, _ type: String = "turn_started") -> SessionEvent {
        ReplayBufferTests.event(["type": type, "seq": 1, "ts": ts, "threadId": "main"])
    }

    func testTheStampIsReadOffWhicheverEventItIs() {
        XCTAssertEqual(event(ts: 1_234).stampMs, 1_234)
        let delta = ReplayBufferTests.event(["type": "assistant_delta", "seq": 1, "ts": 99, "threadId": "main", "delta": "x"])
        XCTAssertEqual(delta.stampMs, 99)
        let result = ReplayBufferTests.event(["type": "tool_result", "seq": 2, "ts": 7, "threadId": "main", "callId": "c", "output": "o", "isError": false])
        XCTAssertEqual(result.stampMs, 7)
    }

    func testSpreadsAreP50P95AndMax() {
        let spread = FeedLatencyMeter.Spread((1...100).map(Double.init))
        XCTAssertEqual(spread.p50, 50)
        XCTAssertEqual(spread.p95, 95)
        XCTAssertEqual(spread.max, 100)
        XCTAssertEqual(FeedLatencyMeter.Spread([]), FeedLatencyMeter.Spread())
    }

    func testEachLegIsMeasuredAndTheWholeWayEndsAtTheCommit() {
        var now = 10_000.0
        var commits: [() -> Void] = []
        let meter = FeedLatencyMeter(label: { "window s_x" }, backlog: { 3 }, interval: 1e9, wall: { now },
                                     afterCommit: { commits.append($0) }, sink: { _ in })
        let e = event(ts: 9_000)
        now = 9_040                                   // it left the daemon at 9,000 and reached the stream at 9,040…
        now = 9_200                                   // …was taken off 160 ms later, 40 ms of which it had waited on the stream
        meter.noteConsumed(e, queueWait: 0.160)
        now = 9_500                                   // folded at 9,500
        meter.noteFolded([e])
        now = 9_800                                   // drawn at 9,800
        commits.forEach { $0() }
        let report = meter.takeReport()
        XCTAssertEqual(report.events, 1)
        XCTAssertEqual(report.queue.max, 160, accuracy: 0.001)
        XCTAssertEqual(report.wire.max, 40, accuracy: 0.001, "9,200 − 160 − 9,000")
        XCTAssertEqual(report.fold.max, 500, accuracy: 0.001)
        XCTAssertEqual(report.render.max, 300, accuracy: 0.001)
        XCTAssertEqual(report.endToEnd.max, 800, accuracy: 0.001)
        XCTAssertEqual(report.backlog, 3)
        XCTAssertEqual(meter.takeReport().events, 0, "taking the report clears it")
        XCTAssertTrue(FeedLatencyMeter.describe(report, label: "window s_x").contains("lag ms (daemon→drawn) p50 800"))
    }

    func testOneLineIsWrittenPerIntervalWhileEventsFlowAndNoneWhenTheyStop() async {
        var lines: [String] = []
        let meter = FeedLatencyMeter(label: { "orb s_y" }, backlog: { 0 }, interval: 0.05, afterCommit: { $0() }, sink: { lines.append($0) })
        let stamp = Int(Date().timeIntervalSince1970 * 1000)
        for _ in 0..<5 { meter.noteFolded([event(ts: stamp)]) }
        try? await Task.sleep(nanoseconds: 250_000_000)
        XCTAssertEqual(lines.count, 1, "\(lines)")
        XCTAssertTrue(lines[0].hasPrefix("orb s_y: 5 events"), lines[0])
        try? await Task.sleep(nanoseconds: 250_000_000)
        XCTAssertEqual(lines.count, 1, "and silence once nothing flows")
    }
}
