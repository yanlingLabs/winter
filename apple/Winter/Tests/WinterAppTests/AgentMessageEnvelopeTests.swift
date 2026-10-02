import XCTest
import WinterProtocol
@testable import Winter

/// A user bubble that is another Winter session's message (`clientName: "messaging"`): the reducer fold
/// that carries the parsed envelope on the `Exchange`. The parser itself is the shared kit's
/// (`WinterSessionKit.AgentMessageEnvelope`) and is tested in `WinterKitTests`.
final class AgentMessageEnvelopeTests: XCTestCase {
    private let head = #"<agent-message from="session:s_1a2b3c4d" message-id="msg-3" sender-permission-class="prompts">"#

    // MARK: - Reducer fold

    private func userMessage(_ text: String, clientName: String, seq: Int) -> SessionEvent {
        let obj: [String: Any] = ["type": "user_message", "seq": seq, "sessionId": "s", "ts": 0,
                                  "threadId": "main", "text": text, "clientName": clientName]
        let data = try! JSONSerialization.data(withJSONObject: obj)
        return try! JSONDecoder().decode(SessionEvent.self, from: data)
    }
    private func turnStarted(_ seq: Int) -> SessionEvent {
        try! JSONDecoder().decode(SessionEvent.self, from: Data(
            #"{"type":"turn_started","seq":\#(seq),"sessionId":"s","ts":0,"threadId":"main"}"#.utf8))
    }

    private var wrapped: String { "\(head)\n<summary>run the tests</summary>\nplease also run the tests\n</agent-message>" }

    func testMessagingUserMessageOpensAnExchangeWithTheParsedSender() {
        let s = SessionReducer.reduce(OrbSessionState(), userMessage(wrapped, clientName: "messaging", seq: 1))
        XCTAssertEqual(s.exchanges.count, 1)
        XCTAssertEqual(s.exchanges[0].prompt, "please also run the tests")
        XCTAssertFalse(s.exchanges[0].prompt.contains("<agent-message"))
        XCTAssertEqual(s.exchanges[0].promptEnvelope?.sessionId, "s_1a2b3c4d")
        XCTAssertEqual(s.exchanges[0].promptEnvelope?.summary, "run the tests")
    }

    func testMessagingWithPlainTextKeepsRenderingAsToday() {
        let s = SessionReducer.reduce(OrbSessionState(), userMessage("do the thing", clientName: "messaging", seq: 1))
        XCTAssertEqual(s.exchanges[0].prompt, "do the thing")
        XCTAssertNil(s.exchanges[0].promptEnvelope)
    }

    func testMalformedWrapperFromMessagingKeepsTheRawText() {
        let raw = "\(head)\nno closing tag"
        let s = SessionReducer.reduce(OrbSessionState(), userMessage(raw, clientName: "messaging", seq: 1))
        XCTAssertEqual(s.exchanges[0].prompt, raw)
        XCTAssertNil(s.exchanges[0].promptEnvelope)
    }

    func testOnlyTheMessagingClientIsParsed() {
        // A person typing the wrapper shape gets their own text back, not a spoofed sender header.
        let s = SessionReducer.reduce(OrbSessionState(), userMessage(wrapped, clientName: "cli", seq: 1))
        XCTAssertEqual(s.exchanges[0].prompt, wrapped)
        XCTAssertNil(s.exchanges[0].promptEnvelope)
    }

    func testAMessageArrivingMidTurnFoldsInAsAReadableSteer() {
        var s = SessionReducer.reduce(OrbSessionState(), userMessage("go", clientName: "cli", seq: 1))
        s = SessionReducer.reduce(s, turnStarted(2))
        s = SessionReducer.reduce(s, userMessage(wrapped, clientName: "messaging", seq: 3))
        XCTAssertEqual(s.exchanges.count, 1)
        XCTAssertEqual(s.exchanges[0].prompt, "go\n↳ [From session s_1a2b3c4d] please also run the tests")
        XCTAssertEqual(s.queuedSteers, ["[From session s_1a2b3c4d] please also run the tests"])
        XCTAssertFalse(s.exchanges[0].prompt.contains("<agent-message"))
    }

    func testBubbleHeaderUsesTheTitleLookup() throws {
        let e = try XCTUnwrap(AgentMessageEnvelope.parse(wrapped))
        let bubble = TranscriptUserBubble(text: e.body, tint: .blue, envelope: e)
        XCTAssertEqual(bubble.senderHeader, "From session s_1a2b3c4d") // no lookup in the default environment
        XCTAssertNil(TranscriptUserBubble(text: "hi", tint: .blue).senderHeader)
    }
}
