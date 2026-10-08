import XCTest
import WinterProtocol
@testable import Winter

/// The reviewing pill: while the bash safety reviewer judges a tool call (`tool_review_progress`), that
/// call's pill in the pill-themed window turns amber and breathes. These tests pin the fold (which calls
/// are under review, and every way that clears), and the pure decisions the pill makes from it.
///
/// **What this file does NOT cover: the drawn pill.** `PillToolRunHeader` and `PillReviewGlow` are
/// SwiftUI views; nothing here proves the amber is visible or the breathing is smooth — the live gate.
final class PillReviewTests: XCTestCase {
    // MARK: - Fixtures

    private func event(_ json: String, file: StaticString = #filePath, line: UInt = #line) -> SessionEvent {
        do {
            return try JSONDecoder().decode(SessionEvent.self, from: Data(json.utf8))
        } catch {
            XCTFail("undecodable SessionEvent fixture: \(error)\n\(json)", file: file, line: line)
            return .turnStarted(.init(seq: 0, sessionId: "s", ts: 0, threadId: "main"))
        }
    }

    private func review(_ callId: String, _ phase: String, thread: String = "main", seq: Int = 5) -> SessionEvent {
        event(#"{"type":"tool_review_progress","seq":\#(seq),"sessionId":"s","ts":0,"threadId":"\#(thread)","callId":"\#(callId)","phase":"\#(phase)"}"#)
    }

    private func openTurn() -> OrbSessionState {
        var s = OrbSessionState()
        s = SessionReducer.reduce(s, event(#"{"type":"user_message","seq":1,"sessionId":"s","ts":0,"threadId":"main","text":"hi","clientName":"cli"}"#))
        return SessionReducer.reduce(s, event(#"{"type":"turn_started","seq":2,"sessionId":"s","ts":0,"threadId":"main"}"#))
    }

    // MARK: - The fold, pure

    func testStartedMarksTheCallAndEndedClearsIt() {
        var s = OrbSessionState()
        SessionReducer.foldToolReviewProgress(&s, callId: "c1", phase: "started")
        XCTAssertEqual(s.reviewingCallIds, ["c1"])
        SessionReducer.foldToolReviewProgress(&s, callId: "c1", phase: "ended")
        XCTAssertTrue(s.reviewingCallIds.isEmpty)
    }

    func testCallsAreTrackedIndependently() {
        var s = OrbSessionState()
        SessionReducer.foldToolReviewProgress(&s, callId: "c1", phase: "started")
        SessionReducer.foldToolReviewProgress(&s, callId: "c2", phase: "started")
        SessionReducer.foldToolReviewProgress(&s, callId: "c1", phase: "ended")
        XCTAssertEqual(s.reviewingCallIds, ["c2"])
    }

    /// An `ended` with no `started` before it — it arrived first, or the `started` was missed — leaves
    /// nothing behind, and a repeated `started` is one entry, ended by one `ended`.
    func testAnEndedWithoutAStartedLeavesNothingAndARepeatedStartIsOneEntry() {
        var s = OrbSessionState()
        SessionReducer.foldToolReviewProgress(&s, callId: "c1", phase: "ended")
        XCTAssertTrue(s.reviewingCallIds.isEmpty)

        SessionReducer.foldToolReviewProgress(&s, callId: "c1", phase: "started")
        SessionReducer.foldToolReviewProgress(&s, callId: "c1", phase: "started")
        SessionReducer.foldToolReviewProgress(&s, callId: "c1", phase: "ended")
        XCTAssertTrue(s.reviewingCallIds.isEmpty)
    }

    func testAnUnknownPhaseIsIgnored() {
        var s = OrbSessionState()
        SessionReducer.foldToolReviewProgress(&s, callId: "c1", phase: "started")
        SessionReducer.foldToolReviewProgress(&s, callId: "c1", phase: "paused")
        SessionReducer.foldToolReviewProgress(&s, callId: "c2", phase: "")
        XCTAssertEqual(s.reviewingCallIds, ["c1"])
    }

    // MARK: - The fold, through the reducer

    func testTheReducerFoldsTheEvent() {
        var s = SessionReducer.reduce(openTurn(), review("c1", "started"))
        XCTAssertEqual(s.reviewingCallIds, ["c1"])
        s = SessionReducer.reduce(s, review("c1", "ended"))
        XCTAssertTrue(s.reviewingCallIds.isEmpty)
    }

    /// A subagent's call is reviewed too; its callId is as unique as any.
    func testASubagentThreadsReviewIsTracked() {
        let s = SessionReducer.reduce(openTurn(), review("c9", "started", thread: "toolu_agent_7"))
        XCTAssertEqual(s.reviewingCallIds, ["c9"])
    }

    /// A review always ends before the call runs, so a call's result proves it is over — even if the
    /// `ended` was lost.
    func testAToolResultClearsItsCall() {
        var s = SessionReducer.reduce(openTurn(), review("c1", "started"))
        s = SessionReducer.reduce(s, review("c2", "started"))
        s = SessionReducer.reduce(s, event(#"{"type":"tool_result","seq":6,"sessionId":"s","ts":0,"threadId":"main","callId":"c1","output":"ok","isError":false}"#))
        XCTAssertEqual(s.reviewingCallIds, ["c2"])
    }

    /// A callId that never ended is cleared when the turn ends, however it ends.
    func testATurnEndClearsACallThatNeverEnded() {
        var s = SessionReducer.reduce(openTurn(), review("c1", "started"))
        s = SessionReducer.reduce(s, event(#"{"type":"turn_completed","seq":9,"sessionId":"s","ts":0,"threadId":"main","stopReason":"end_turn","inputTokens":1,"outputTokens":1}"#))
        XCTAssertTrue(s.reviewingCallIds.isEmpty)

        var aborted = SessionReducer.reduce(openTurn(), review("c1", "started"))
        aborted = SessionReducer.reduce(aborted, event(#"{"type":"turn_completed","seq":9,"sessionId":"s","ts":0,"threadId":"main","stopReason":"aborted","inputTokens":1,"outputTokens":1}"#))
        XCTAssertTrue(aborted.reviewingCallIds.isEmpty, "an Esc'd turn clears it too")

        var errored = SessionReducer.reduce(openTurn(), review("c1", "started"))
        errored = SessionReducer.reduce(errored, event(#"{"type":"agent_error","seq":9,"sessionId":"s","ts":0,"threadId":"main","message":"boom"}"#))
        XCTAssertTrue(errored.reviewingCallIds.isEmpty)
    }

    /// Transients are not replayed: an `ended` sent while the connection was down is gone for good.
    func testADroppedConnectionClearsIt() {
        let s = SessionReducer.reduce(openTurn(), review("c1", "started"))
        XCTAssertTrue(SessionReducer.reduceConnection(s, .disconnected).reviewingCallIds.isEmpty)
        XCTAssertTrue(SessionReducer.reduceConnection(s, .reconnecting(attempt: 1)).reviewingCallIds.isEmpty)
        XCTAssertEqual(SessionReducer.reduceConnection(s, .connected).reviewingCallIds, ["c1"])
    }

    func testNothingElseTouchesTheSet() {
        var s = SessionReducer.reduce(openTurn(), review("c1", "started"))
        s = SessionReducer.reduce(s, event(#"{"type":"assistant_delta","seq":7,"sessionId":"s","ts":0,"threadId":"main","delta":"hi"}"#))
        s = SessionReducer.reduce(s, event(#"{"type":"tool_call","seq":8,"sessionId":"s","ts":0,"threadId":"main","callId":"c2","name":"bash","argsJson":"{}"}"#))
        XCTAssertEqual(s.reviewingCallIds, ["c1"])
    }

    // MARK: - The pill's decisions

    private func entry(_ ids: [String?]) -> ToolRunEntry {
        ToolRunEntry(name: "bash", calls: ids.map { ToolCallRecord(callId: $0, detail: nil, output: nil, isError: false) })
    }

    func testAPillIsReviewingWhenAnyOfItsCallsIs() {
        XCTAssertTrue(pillIsReviewing([entry(["a", "b"])], reviewing: ["b"]))
        XCTAssertFalse(pillIsReviewing([entry(["a", "b"])], reviewing: ["c"]))
        XCTAssertFalse(pillIsReviewing([entry(["a"])], reviewing: []))
        XCTAssertFalse(pillIsReviewing([entry([nil])], reviewing: ["a"]), "a call with no id cannot be matched")
        XCTAssertFalse(pillIsReviewing([], reviewing: ["a"]))
    }

    func testReviewTintsUnlessTheCallFailedAndReducedMotionKeepsTheTintWithoutTheBreathing() {
        XCTAssertEqual(pillReviewChrome(reviewing: false, failed: false, reduceMotion: false), PillReviewChrome(tinted: false, pulses: false))
        XCTAssertEqual(pillReviewChrome(reviewing: true, failed: false, reduceMotion: false), PillReviewChrome(tinted: true, pulses: true))
        XCTAssertEqual(pillReviewChrome(reviewing: true, failed: false, reduceMotion: true), PillReviewChrome(tinted: true, pulses: false))
        XCTAssertEqual(pillReviewChrome(reviewing: true, failed: true, reduceMotion: false), PillReviewChrome(tinted: false, pulses: false),
                       "red outranks amber")
    }

    func testThePulseBreathesOnceEveryTwelveTenths() {
        XCTAssertEqual(pillReviewPulsePeriod, 1.2)
        XCTAssertEqual(pillReviewPulseLevel(at: 0), 0.5, accuracy: 1e-9)
        XCTAssertEqual(pillReviewPulseLevel(at: pillReviewPulsePeriod / 4), 1, accuracy: 1e-9)
        XCTAssertEqual(pillReviewPulseLevel(at: pillReviewPulsePeriod * 3 / 4), 0, accuracy: 1e-9)
        XCTAssertEqual(pillReviewPulseLevel(at: 0.37), pillReviewPulseLevel(at: 0.37 + pillReviewPulsePeriod), accuracy: 1e-9)
        for step in 0..<50 {
            let level = pillReviewPulseLevel(at: Double(step) * 0.0731)
            XCTAssertTrue((0...1).contains(level))
        }
    }
}
