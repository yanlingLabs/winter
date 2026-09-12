import XCTest
@testable import Winter
import WinterProtocol

/// Dispatch (Phase 7), Task 7: the reducer's `state.children: [ChildItem]` — child SESSIONS
/// mirrored via `child_update` events into the dispatch session's own stream. Sibling suite to
/// `SubagentReducerTests` (that one covers in-process child THREADS via `thread_started`/
/// `thread_completed`; this covers child SESSIONS via `child_update`), same `ev`/`reduce` idiom.
final class ChildSessionReducerTests: XCTestCase {
    private func ev(_ json: String) -> SessionEvent {
        try! JSONDecoder().decode(SessionEvent.self, from: Data(json.utf8))
    }
    private func reduce(_ s: OrbSessionState, _ jsons: [String]) -> OrbSessionState {
        jsons.reduce(s) { SessionReducer.reduce($0, ev($1)) }
    }
    private func childUpdate(childSessionId: String, status: String, title: String = "child task", seq: Int = 1) -> String {
        #"{"type":"child_update","seq":\#(seq),"sessionId":"s","ts":0,"threadId":"main","childSessionId":"\#(childSessionId)","status":"\#(status)","title":"\#(title)","resultSummary":null}"#
    }
    private func turnStarted(seq: Int = 1, thread: String = "main") -> String {
        #"{"type":"turn_started","seq":\#(seq),"sessionId":"s","ts":0,"threadId":"\#(thread)"}"#
    }

    func testChildUpdateAppendsNewChild() {
        let s = reduce(OrbSessionState(), [childUpdate(childSessionId: "c1", status: "working", title: "explore auth")])
        XCTAssertEqual(s.children, [ChildItem(sessionId: "c1", title: "explore auth", status: "working")])
    }

    func testChildUpdateUpsertsByChildSessionIdRatherThanDuplicating() {
        var s = reduce(OrbSessionState(), [childUpdate(childSessionId: "c1", status: "working", title: "explore auth", seq: 1)])
        XCTAssertEqual(s.children.count, 1)
        s = reduce(s, [childUpdate(childSessionId: "c1", status: "completed", title: "explore auth", seq: 2)])
        XCTAssertEqual(s.children.count, 1, "a second update for the SAME childSessionId replaces, never duplicates")
        XCTAssertEqual(s.children[0].status, "completed")
    }

    func testChildUpdateTracksMultipleChildrenIndependently() {
        let s = reduce(OrbSessionState(), [
            childUpdate(childSessionId: "c1", status: "working", title: "a", seq: 1),
            childUpdate(childSessionId: "c2", status: "queued", title: "b", seq: 2),
        ])
        XCTAssertEqual(s.children.map(\.sessionId), ["c1", "c2"])
    }

    /// Subagent-roster precedent (commit f49efed, phase-3a CLI TUI whole-branch review): a
    /// completed/error child is dropped from the live roster on the NEXT main `turn_started`, not
    /// immediately on its own `child_update` — so its final status is still visible for at least
    /// the rest of the turn it finished in.
    func testFinishedChildIsPrunedOnNextMainTurnStarted() {
        var s = reduce(OrbSessionState(), [
            childUpdate(childSessionId: "c1", status: "completed", title: "done child", seq: 1),
            childUpdate(childSessionId: "c2", status: "working", title: "still going", seq: 2),
        ])
        XCTAssertEqual(s.children.count, 2, "a finished child is not dropped the instant it finishes")

        s = reduce(s, [turnStarted(seq: 3)])
        XCTAssertEqual(s.children.map(\.sessionId), ["c2"], "completed child pruned; working child survives")
    }

    func testErrorStatusChildIsAlsoPrunedOnNextMainTurnStarted() {
        var s = reduce(OrbSessionState(), [childUpdate(childSessionId: "c1", status: "error", title: "blew up", seq: 1)])
        XCTAssertEqual(s.children.count, 1)
        s = reduce(s, [turnStarted(seq: 2)])
        XCTAssertTrue(s.children.isEmpty)
    }

    func testTurnStartedWithNoFinishedChildrenIsANoOp() {
        let s = reduce(OrbSessionState(), [
            childUpdate(childSessionId: "c1", status: "working", title: "a", seq: 1),
            turnStarted(seq: 2),
        ])
        XCTAssertEqual(s.children.map(\.sessionId), ["c1"])
    }
}
