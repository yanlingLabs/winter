import XCTest
import NormaProtocol
import NormaKit
@testable import Norma

/// Task 1 (2d-iii): the reducer's `pendingInteractions: [PendingInteraction]` replaces the old
/// `pendingApprovalIds: Set<String>` — same drives of `status = .approvalNeeded(count:)`, but now
/// carrying the payload (toolName/summary/questions/plan) that later tasks render as cards.
/// Drives the PURE reducer directly via the same wire-shaped-JSON `ev(_:)` idiom as
/// SessionModelTests/ActivityCaptureTests.
final class PendingInteractionTests: XCTestCase {
    func ev(_ json: String) -> SessionEvent {
        try! JSONDecoder().decode(SessionEvent.self, from: Data(json.utf8))
    }
    func turnStarted(seq: Int = 1, thread: String = "main") -> SessionEvent {
        ev(#"{"type":"turn_started","seq":\#(seq),"sessionId":"s","ts":0,"threadId":"\#(thread)"}"#)
    }
    func approvalRequested(callId: String, toolName: String = "bash", summary: String = "rm x", seq: Int = 4) -> SessionEvent {
        ev(#"{"type":"approval_requested","seq":\#(seq),"sessionId":"s","ts":0,"threadId":"main","callId":"\#(callId)","toolName":"\#(toolName)","summary":"\#(summary)"}"#)
    }
    /// Phase 5e T5: same wire shape, plus the additive `reviewerReason` field (T1's protocol
    /// addition) — used to test that the reducer threads it through into `PendingInteraction`.
    func approvalRequestedWithReviewerReason(callId: String, reviewerReason: String, toolName: String = "bash", summary: String = "rm x", seq: Int = 4) -> SessionEvent {
        ev(#"{"type":"approval_requested","seq":\#(seq),"sessionId":"s","ts":0,"threadId":"main","callId":"\#(callId)","toolName":"\#(toolName)","summary":"\#(summary)","reviewerReason":"\#(reviewerReason)"}"#)
    }
    func approvalResolved(callId: String, seq: Int = 5) -> SessionEvent {
        ev(#"{"type":"approval_resolved","seq":\#(seq),"sessionId":"s","ts":0,"threadId":"main","callId":"\#(callId)","approved":true,"by":"cli"}"#)
    }
    func questionAsked(callId: String, seq: Int = 6) -> SessionEvent {
        ev(#"{"type":"question_asked","seq":\#(seq),"sessionId":"s","ts":0,"threadId":"main","callId":"\#(callId)","questions":[{"question":"Which port?","header":"h","options":[{"label":"80","description":null},{"label":"443","description":"https"}],"multiSelect":true}]}"#)
    }
    func questionResolved(callId: String, seq: Int = 7) -> SessionEvent {
        ev(#"{"type":"question_resolved","seq":\#(seq),"sessionId":"s","ts":0,"threadId":"main","callId":"\#(callId)","answers":{},"by":"cli"}"#)
    }
    func planPresented(callId: String, plan: String = "the plan", seq: Int = 8) -> SessionEvent {
        ev(#"{"type":"plan_presented","seq":\#(seq),"sessionId":"s","ts":0,"threadId":"main","callId":"\#(callId)","plan":"\#(plan)"}"#)
    }
    func planResolved(callId: String, seq: Int = 9) -> SessionEvent {
        ev(#"{"type":"plan_resolved","seq":\#(seq),"sessionId":"s","ts":0,"threadId":"main","callId":"\#(callId)","approved":true,"autoAccept":false,"by":"cli"}"#)
    }
    func turnCompleted(seq: Int = 10, stopReason: String = "end_turn") -> SessionEvent {
        ev(#"{"type":"turn_completed","seq":\#(seq),"sessionId":"s","ts":0,"threadId":"main","stopReason":"\#(stopReason)","inputTokens":1,"outputTokens":1}"#)
    }
    func agentError(_ message: String = "boom", seq: Int = 10) -> SessionEvent {
        ev(#"{"type":"agent_error","seq":\#(seq),"sessionId":"s","ts":0,"threadId":"main","message":"\#(message)"}"#)
    }

    func testApprovalRequestAppendsTypedItem() {
        var s = OrbSessionState()
        s = SessionReducer.reduce(s, turnStarted())
        s = SessionReducer.reduce(s, approvalRequested(callId: "a1", toolName: "bash", summary: "rm -rf x"))
        XCTAssertEqual(s.pendingInteractions, [.approval(callId: "a1", toolName: "bash", summary: "rm -rf x")])
        // No reviewerReason on the wire event -> nil (default), matching a pre-5e-T5 event shape.
        guard case .approval(_, _, _, let reviewerReason, _, _) = s.pendingInteractions[0] else { return XCTFail("expected .approval") }
        XCTAssertNil(reviewerReason)
    }

    /// Phase 5e T5: the reducer threads `approval_requested.reviewerReason` through into
    /// `PendingInteraction.approval`'s 4th associated value — the app-side twin of the CLI's
    /// state.test.ts "approval_requested threads reviewerReason through" test.
    func testApprovalRequestThreadsReviewerReason() {
        var s = OrbSessionState()
        s = SessionReducer.reduce(s, turnStarted())
        s = SessionReducer.reduce(s, approvalRequestedWithReviewerReason(callId: "a1", reviewerReason: "recursive delete outside the session cwd"))
        XCTAssertEqual(
            s.pendingInteractions,
            [.approval(callId: "a1", toolName: "bash", summary: "rm x", reviewerReason: "recursive delete outside the session cwd")]
        )
    }

    func testQuestionAskedAppendsWithQuestions() {
        var s = OrbSessionState()
        s = SessionReducer.reduce(s, turnStarted())
        s = SessionReducer.reduce(s, questionAsked(callId: "q1"))
        // `SessionEvent.Question`/`QuestionOption` are cross-module `Codable` structs with no
        // public memberwise initializer — build the expected value the same wire-JSON way the
        // reducer itself decodes it, rather than reaching for a synthesized init that doesn't
        // exist outside NormaProtocol.
        let expectedQuestions = try! JSONDecoder().decode(
            [SessionEvent.Question].self,
            from: Data(#"[{"question":"Which port?","header":"h","options":[{"label":"80","description":null},{"label":"443","description":"https"}],"multiSelect":true}]"#.utf8)
        )
        XCTAssertEqual(s.pendingInteractions, [.question(callId: "q1", questions: expectedQuestions)])
    }

    func testPlanPresentedAppendsPlanText() {
        var s = OrbSessionState()
        s = SessionReducer.reduce(s, turnStarted())
        s = SessionReducer.reduce(s, planPresented(callId: "p1", plan: "the plan"))
        XCTAssertEqual(s.pendingInteractions, [.plan(callId: "p1", plan: "the plan")])
    }

    func testResolvedRemovesByCallId() {
        var s = OrbSessionState()
        s = SessionReducer.reduce(s, turnStarted())
        s = SessionReducer.reduce(s, approvalRequested(callId: "a1"))
        s = SessionReducer.reduce(s, questionAsked(callId: "q1"))
        s = SessionReducer.reduce(s, planPresented(callId: "p1"))
        XCTAssertEqual(s.pendingInteractions.count, 3)

        s = SessionReducer.reduce(s, approvalResolved(callId: "a1"))
        XCTAssertEqual(s.pendingInteractions.map(\.callId), ["q1", "p1"])

        s = SessionReducer.reduce(s, questionResolved(callId: "q1"))
        XCTAssertEqual(s.pendingInteractions.map(\.callId), ["p1"])

        s = SessionReducer.reduce(s, planResolved(callId: "p1"))
        XCTAssertTrue(s.pendingInteractions.isEmpty)
    }

    func testReplayDuplicateRequestDoesNotDoubleAppend() {
        var s = OrbSessionState()
        s = SessionReducer.reduce(s, turnStarted())
        s = SessionReducer.reduce(s, approvalRequested(callId: "a1", seq: 4))
        s = SessionReducer.reduce(s, approvalRequested(callId: "a1", seq: 4)) // replay of same event
        XCTAssertEqual(s.pendingInteractions.count, 1)
        XCTAssertEqual(s.pendingInteractions, [.approval(callId: "a1", toolName: "bash", summary: "rm x")])
    }

    func testTurnCompletedClearsAll() {
        var s = OrbSessionState()
        s = SessionReducer.reduce(s, turnStarted())
        s = SessionReducer.reduce(s, approvalRequested(callId: "a1"))
        s = SessionReducer.reduce(s, questionAsked(callId: "q1"))
        s = SessionReducer.reduce(s, turnCompleted())
        XCTAssertTrue(s.pendingInteractions.isEmpty)
        XCTAssertEqual(s.status, .idle)

        // agent_error also clears
        s = SessionReducer.reduce(s, turnStarted(seq: 11))
        s = SessionReducer.reduce(s, approvalRequested(callId: "a2", seq: 12))
        s = SessionReducer.reduce(s, agentError("boom", seq: 13))
        XCTAssertTrue(s.pendingInteractions.isEmpty)
    }

    func testStatusCountDerivesFromTypedList() {
        var s = OrbSessionState()
        s = SessionReducer.reduce(s, turnStarted())
        s = SessionReducer.reduce(s, approvalRequested(callId: "a1"))
        s = SessionReducer.reduce(s, questionAsked(callId: "q1"))
        XCTAssertEqual(s.pendingInteractions.count, 2)
        XCTAssertEqual(s.status, .approvalNeeded(count: 2))
    }

    func testCrossKindOrdering() {
        var s = OrbSessionState()
        s = SessionReducer.reduce(s, turnStarted())
        s = SessionReducer.reduce(s, approvalRequested(callId: "a1"))
        s = SessionReducer.reduce(s, questionAsked(callId: "q1"))
        XCTAssertEqual(s.pendingInteractions.map(\.callId), ["a1", "q1"])
    }
}
