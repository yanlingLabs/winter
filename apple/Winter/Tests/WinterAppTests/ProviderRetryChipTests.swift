import XCTest
import WinterProtocol
@testable import Winter

/// provider_retry (WinterProtocol Swift mirror): the composer/turn chip's retry status.
/// `FieldStateAdapter.retryStatus` is fed directly from `SessionModel.events` (a raw pass-through
/// of every event `apply` sees) rather than from `OrbSessionState` — `provider_retry` is
/// TRANSIENT and never lands in state. Covers the pure label wording and the clear rule (the next
/// `assistant_delta`/`assistant_message`/`tool_call`/`turn_completed` on the same thread).
@MainActor
final class ProviderRetryChipTests: XCTestCase {
    // Event factory helpers — same shape as SessionModelTests' `ev` (decode wire JSON, stay
    // honest to the protocol rather than hand-building a struct that could drift from it).
    func ev(_ json: String) -> SessionEvent {
        try! JSONDecoder().decode(SessionEvent.self, from: Data(json.utf8))
    }
    func turnStarted(seq: Int = 1, thread: String = "main") -> SessionEvent {
        ev(#"{"type":"turn_started","seq":\#(seq),"sessionId":"s","ts":0,"threadId":"\#(thread)"}"#)
    }
    func providerRetry(
        attempt: Int, maxRetries: Int, retryDelayMs: Int, status: Int?, seq: Int = 2, thread: String = "main"
    ) -> SessionEvent {
        let statusJson = status.map(String.init) ?? "null"
        return ev(#"{"type":"provider_retry","seq":\#(seq),"sessionId":"s","ts":0,"threadId":"\#(thread)","attempt":\#(attempt),"maxRetries":\#(maxRetries),"retryDelayMs":\#(retryDelayMs),"status":\#(statusJson),"message":"rate_limit"}"#)
    }
    func delta(_ text: String = "hi", seq: Int = 3, thread: String = "main") -> SessionEvent {
        ev(#"{"type":"assistant_delta","seq":\#(seq),"sessionId":"s","ts":0,"threadId":"\#(thread)","delta":"\#(text)"}"#)
    }
    func assistantMessage(_ text: String = "done", seq: Int = 3, thread: String = "main") -> SessionEvent {
        ev(#"{"type":"assistant_message","seq":\#(seq),"sessionId":"s","ts":0,"threadId":"\#(thread)","text":"\#(text)"}"#)
    }
    func toolCall(seq: Int = 3, thread: String = "main") -> SessionEvent {
        ev(#"{"type":"tool_call","seq":\#(seq),"sessionId":"s","ts":0,"threadId":"\#(thread)","callId":"c\#(seq)","name":"bash","argsJson":"{}"}"#)
    }
    func turnCompleted(seq: Int = 9, thread: String = "main") -> SessionEvent {
        ev(#"{"type":"turn_completed","seq":\#(seq),"sessionId":"s","ts":0,"threadId":"\#(thread)","stopReason":"end_turn","inputTokens":1,"outputTokens":1}"#)
    }

    // MARK: - Label wording (pure)

    func testLabelWithStatusCode() {
        XCTAssertEqual(
            FieldStateAdapter.retryStatusLabel(attempt: 3, maxRetries: 10, retryDelayMs: 8000, status: 429),
            "Provider busy (HTTP 429) — retrying 3 of 10, next in 8 s"
        )
    }

    func testLabelOmitsHTTPParentheticalWhenStatusIsNil() {
        XCTAssertEqual(
            FieldStateAdapter.retryStatusLabel(attempt: 1, maxRetries: 5, retryDelayMs: 2000, status: nil),
            "Provider busy — retrying 1 of 5, next in 2 s"
        )
    }

    func testLabelRoundsRetryDelayMsToNearestWholeSecond() {
        // 8400ms rounds down to 8s, 8600ms rounds up to 9s — nearest, not floor/ceil.
        XCTAssertEqual(
            FieldStateAdapter.retryStatusLabel(attempt: 1, maxRetries: 3, retryDelayMs: 8400, status: nil),
            "Provider busy — retrying 1 of 3, next in 8 s"
        )
        XCTAssertEqual(
            FieldStateAdapter.retryStatusLabel(attempt: 1, maxRetries: 3, retryDelayMs: 8600, status: nil),
            "Provider busy — retrying 1 of 3, next in 9 s"
        )
    }

    func testLabelRoundsSubSecondDelayToZero() {
        XCTAssertEqual(
            FieldStateAdapter.retryStatusLabel(attempt: 1, maxRetries: 3, retryDelayMs: 200, status: 503),
            "Provider busy (HTTP 503) — retrying 1 of 3, next in 0 s"
        )
    }

    // MARK: - Set + composer chip surface

    func testProviderRetrySetsRetryStatusAndOverridesTheWorkingVerb() {
        let session = SessionModel()
        let adapter = FieldStateAdapter(session: session)

        session.apply(turnStarted())
        session.apply(providerRetry(attempt: 3, maxRetries: 10, retryDelayMs: 8000, status: 429))

        XCTAssertEqual(adapter.retryStatus, "Provider busy (HTTP 429) — retrying 3 of 10, next in 8 s")
        XCTAssertEqual(adapter.verbText, adapter.retryStatus)
        XCTAssertEqual(adapter.statusText, adapter.retryStatus)
    }

    func testProviderRetryOnAChildThreadDoesNotTouchTheComposerChip() {
        let session = SessionModel()
        let adapter = FieldStateAdapter(session: session)

        session.apply(turnStarted())
        session.apply(providerRetry(attempt: 1, maxRetries: 5, retryDelayMs: 1000, status: 500, thread: "child_1"))

        XCTAssertNil(adapter.retryStatus, "a subagent's own retry must never surface on the main composer chip")
    }

    // MARK: - Clear rule

    func testClearsOnAssistantDelta() {
        let session = SessionModel()
        let adapter = FieldStateAdapter(session: session)
        session.apply(turnStarted())
        session.apply(providerRetry(attempt: 1, maxRetries: 3, retryDelayMs: 1000, status: 429))
        XCTAssertNotNil(adapter.retryStatus)

        session.apply(delta())
        XCTAssertNil(adapter.retryStatus)
    }

    func testClearsOnAssistantMessage() {
        let session = SessionModel()
        let adapter = FieldStateAdapter(session: session)
        session.apply(turnStarted())
        session.apply(providerRetry(attempt: 1, maxRetries: 3, retryDelayMs: 1000, status: 429))
        XCTAssertNotNil(adapter.retryStatus)

        session.apply(assistantMessage())
        XCTAssertNil(adapter.retryStatus)
    }

    func testClearsOnToolCall() {
        let session = SessionModel()
        let adapter = FieldStateAdapter(session: session)
        session.apply(turnStarted())
        session.apply(providerRetry(attempt: 1, maxRetries: 3, retryDelayMs: 1000, status: 429))
        XCTAssertNotNil(adapter.retryStatus)

        session.apply(toolCall())
        XCTAssertNil(adapter.retryStatus)
    }

    func testClearsOnTurnCompleted() {
        let session = SessionModel()
        let adapter = FieldStateAdapter(session: session)
        session.apply(turnStarted())
        session.apply(providerRetry(attempt: 1, maxRetries: 3, retryDelayMs: 1000, status: 429))
        XCTAssertNotNil(adapter.retryStatus)

        session.apply(turnCompleted())
        XCTAssertNil(adapter.retryStatus)
    }

    func testClearingEventOnAChildThreadDoesNotClearTheMainChip() {
        let session = SessionModel()
        let adapter = FieldStateAdapter(session: session)
        session.apply(turnStarted())
        session.apply(providerRetry(attempt: 1, maxRetries: 3, retryDelayMs: 1000, status: 429))
        XCTAssertNotNil(adapter.retryStatus)

        session.apply(delta(thread: "child_1"))
        XCTAssertNotNil(adapter.retryStatus, "a subagent's own progress must not clear the main-thread retry chip")
    }
}
