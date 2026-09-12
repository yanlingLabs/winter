import XCTest
@testable import Winter
import WinterProtocol

/// 2e-ii Task 3: the reducer's child-thread tracking — spec §2 table, Swift column (lifecycle +
/// active spans; NO token fields, tokens are CLI-only). All timestamps are event.ts.
final class SubagentReducerTests: XCTestCase {
    private func ev(_ json: String) -> SessionEvent {
        try! JSONDecoder().decode(SessionEvent.self, from: Data(json.utf8))
    }
    private func reduce(_ s: OrbSessionState, _ jsons: [String]) -> OrbSessionState {
        jsons.reduce(s) { SessionReducer.reduce($0, ev($1)) }
    }
    private let base = #""seq":1,"sessionId":"s""#

    func testSpawnInsertsQueuedWithLabel() {
        let s = reduce(OrbSessionState(), [
            #"{"type":"turn_started","seq":1,"sessionId":"s","ts":10,"threadId":"main"}"#,
            #"{"type":"thread_started","seq":2,"sessionId":"s","ts":20,"threadId":"th_a","parentThreadId":"main","agentType":"general-purpose","prompt":"go do it","description":"explore auth module"}"#,
        ])
        XCTAssertEqual(s.subagents.count, 1)
        XCTAssertEqual(s.subagents[0].threadId, "th_a")
        XCTAssertEqual(s.subagents[0].status, "queued")
        XCTAssertEqual(s.subagents[0].label, "explore auth module")
        XCTAssertNil(s.subagents[0].activeSince)
    }

    func testReplayDedupeSameThreadIdNoDuplicate() {
        let spawn = #"{"type":"thread_started","seq":2,"sessionId":"s","ts":20,"threadId":"th_a","parentThreadId":"main","agentType":"general-purpose","prompt":"go"}"#
        let s = reduce(OrbSessionState(), [spawn, spawn])
        XCTAssertEqual(s.subagents.count, 1)
    }

    func testChildTurnWindowBanksActiveSpan() {
        var s = reduce(OrbSessionState(), [
            #"{"type":"thread_started","seq":2,"sessionId":"s","ts":20,"threadId":"th_a","parentThreadId":"main","agentType":"general-purpose","prompt":"go"}"#,
            #"{"type":"turn_started","seq":3,"sessionId":"s","ts":1000,"threadId":"th_a"}"#,
        ])
        XCTAssertEqual(s.subagents[0].status, "working")
        XCTAssertEqual(s.subagents[0].activeSince, 1000)
        s = reduce(s, [#"{"type":"turn_completed","seq":4,"sessionId":"s","ts":4500,"threadId":"th_a","stopReason":"end_turn","inputTokens":10,"outputTokens":5}"#])
        XCTAssertEqual(s.subagents[0].activeMs, 3500)
        XCTAssertNil(s.subagents[0].activeSince)
        XCTAssertEqual(s.subagents[0].status, "working") // still alive until thread_completed
    }

    func testThreadCompletedMarksDoneAndDefensivelyClosesOpenSpan() {
        let s = reduce(OrbSessionState(), [
            #"{"type":"thread_started","seq":2,"sessionId":"s","ts":20,"threadId":"th_a","parentThreadId":"main","agentType":"general-purpose","prompt":"go"}"#,
            #"{"type":"turn_started","seq":3,"sessionId":"s","ts":1000,"threadId":"th_a"}"#,
            #"{"type":"thread_completed","seq":4,"sessionId":"s","ts":6000,"threadId":"th_a","stopReason":"aborted"}"#,
        ])
        XCTAssertEqual(s.subagents[0].status, "done")
        XCTAssertEqual(s.subagents[0].stopReason, "aborted")
        XCTAssertEqual(s.subagents[0].activeMs, 5000) // defensive close: no turn_completed arrived
        XCTAssertNil(s.subagents[0].activeSince)
    }

    func testUnknownChildEventsAreNoOps() {
        // mid-batch attach: turn events for a threadId never announced via thread_started
        let s = reduce(OrbSessionState(), [
            #"{"type":"turn_started","seq":3,"sessionId":"s","ts":1000,"threadId":"th_ghost"}"#,
            #"{"type":"turn_completed","seq":4,"sessionId":"s","ts":2000,"threadId":"th_ghost","stopReason":"end_turn","inputTokens":1,"outputTokens":1}"#,
        ])
        XCTAssertTrue(s.subagents.isEmpty)
    }

    func testMainTurnCompletedPrunes() {
        let s = reduce(OrbSessionState(), [
            #"{"type":"thread_started","seq":2,"sessionId":"s","ts":20,"threadId":"th_a","parentThreadId":"main","agentType":"general-purpose","prompt":"go"}"#,
            #"{"type":"thread_completed","seq":3,"sessionId":"s","ts":30,"threadId":"th_a","stopReason":"end_turn"}"#,
            #"{"type":"turn_completed","seq":4,"sessionId":"s","ts":40,"threadId":"main","stopReason":"end_turn","inputTokens":1,"outputTokens":1}"#,
        ])
        XCTAssertTrue(s.subagents.isEmpty)
    }

    func testAgentErrorPrunesDefensively() {
        let s = reduce(OrbSessionState(), [
            #"{"type":"thread_started","seq":2,"sessionId":"s","ts":20,"threadId":"th_a","parentThreadId":"main","agentType":"general-purpose","prompt":"go"}"#,
            #"{"type":"agent_error","seq":3,"sessionId":"s","ts":30,"threadId":"main","message":"boom"}"#,
        ])
        XCTAssertTrue(s.subagents.isEmpty)
    }
}
