import XCTest
import NormaProtocol
import NormaSessionKit
@testable import NormaKit

final class ResumePlannerTests: XCTestCase {
    // MARK: - verdict

    func testVerdictUpToDateWhenFromSeqEqualsHighWatermark() {
        let v = ResumePlanner.verdict(fromSeq: 5, highWatermark: 5, sessionID: "s1")
        XCTAssertEqual(v, .upToDate(sessionID: "s1", highWatermark: 5))
    }

    func testVerdictReplayBeginWhenFromSeqBelowHighWatermark() {
        let v = ResumePlanner.verdict(fromSeq: 2, highWatermark: 9, sessionID: "s1")
        XCTAssertEqual(v, .replayBegin(sessionID: "s1", fromSeq: 2, highWatermark: 9))
    }

    func testVerdictSnapshotRequiredWhenFromSeqAheadOfHighWatermark() {
        let v = ResumePlanner.verdict(fromSeq: 12, highWatermark: 9, sessionID: "s1")
        XCTAssertEqual(
            v,
            .snapshotRequired(sessionID: "s1", reason: "cursor-ahead", oldestAvailableSeq: 0)
        )
    }

    func testVerdictUpToDateAtZero() {
        let v = ResumePlanner.verdict(fromSeq: 0, highWatermark: 0, sessionID: "s1")
        XCTAssertEqual(v, .upToDate(sessionID: "s1", highWatermark: 0))
    }

    // MARK: - replaySlice

    func testReplaySliceMidRange() {
        let events = [1, 2, 3, 4, 5]
        let slice = ResumePlanner.replaySlice(events: events, fromSeq: 2, seqOf: { $0 })
        XCTAssertEqual(slice, [3, 4, 5])
    }

    func testReplaySliceAtHighWatermarkIsEmpty() {
        let events = [1, 2, 3, 4, 5]
        let slice = ResumePlanner.replaySlice(events: events, fromSeq: 5, seqOf: { $0 })
        XCTAssertEqual(slice, [])
    }

    func testReplaySliceFromZeroIsAll() {
        let events = [1, 2, 3, 4, 5]
        let slice = ResumePlanner.replaySlice(events: events, fromSeq: 0, seqOf: { $0 })
        XCTAssertEqual(slice, [1, 2, 3, 4, 5])
    }

    func testReplaySliceNonContiguousSeqStrictlyGreaterThan() {
        let events = [10, 20, 30]
        let slice = ResumePlanner.replaySlice(events: events, fromSeq: 15, seqOf: { $0 })
        XCTAssertEqual(slice, [20, 30])
    }
}
