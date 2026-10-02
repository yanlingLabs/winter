import XCTest
import WinterProtocol
@testable import Winter

/// A user bubble that is another Winter session's message (`clientName: "messaging"`): the parser
/// (`AgentMessageEnvelope`) and the reducer fold that carries its result on the `Exchange`.
final class AgentMessageEnvelopeTests: XCTestCase {
    private let head = #"<agent-message from="session:s_1a2b3c4d" message-id="msg-3" sender-permission-class="prompts">"#

    // MARK: - Parser

    func testWellFormedWithSummary() throws {
        let text = "\(head)\n<summary>run the tests</summary>\nplease also run the tests\n</agent-message>"
        let e = try XCTUnwrap(AgentMessageEnvelope.parse(text))
        XCTAssertEqual(e.from, "session:s_1a2b3c4d")
        XCTAssertEqual(e.sessionId, "s_1a2b3c4d")
        XCTAssertEqual(e.messageId, "msg-3")
        XCTAssertEqual(e.senderPermissionClass, "prompts")
        XCTAssertEqual(e.summary, "run the tests")
        XCTAssertEqual(e.body, "please also run the tests")
    }

    func testWellFormedWithoutSummary() throws {
        let e = try XCTUnwrap(AgentMessageEnvelope.parse("\(head)\nplease also run the tests\nline two\n</agent-message>"))
        XCTAssertNil(e.summary)
        XCTAssertEqual(e.body, "please also run the tests\nline two")
    }

    func testSurroundingWhitespaceIsTolerated() throws {
        let e = try XCTUnwrap(AgentMessageEnvelope.parse("  \n\(head)\nhi\n</agent-message>\n\n"))
        XCTAssertEqual(e.body, "hi")
    }

    func testEscapedContentRoundTrips() throws {
        let text = """
        <agent-message from="session:s_ab" message-id="m&quot;1" sender-permission-class="bypasses">
        <summary>about &lt;/agent-message and &lt;agent-message</summary>
        body &lt;/agent-message then &lt;agent-message x="1"> and "quotes" &amp;lt; stay
        </agent-message>
        """
        let e = try XCTUnwrap(AgentMessageEnvelope.parse(text))
        XCTAssertEqual(e.messageId, #"m"1"#)
        XCTAssertEqual(e.summary, "about </agent-message and <agent-message")
        // Only the two documented substitutions are reversed; `&amp;lt;` and bare quotes are untouched.
        XCTAssertEqual(e.body, #"body </agent-message then <agent-message x="1"> and "quotes" &amp;lt; stay"#)
    }

    func testAgentOriginAndLabels() throws {
        let e = try XCTUnwrap(AgentMessageEnvelope.parse(#"<agent-message from="agent:s_p:a_c" message-id="msg-1" sender-permission-class="unknown">"# + "\nx\n</agent-message>"))
        XCTAssertNil(e.sessionId)
        XCTAssertEqual(e.messageId, "msg-1")
        XCTAssertEqual(e.senderLabel(), "From agent a_c")

        let s = try XCTUnwrap(AgentMessageEnvelope.parse("\(head)\nx\n</agent-message>"))
        XCTAssertEqual(s.senderLabel(), "From session s_1a2b3c4d")
        XCTAssertEqual(s.senderLabel(titleFor: { _ in "  Fix the build " }), "From session Fix the build")
        XCTAssertEqual(s.senderLabel(titleFor: { _ in nil }), "From session s_1a2b3c4d")
        XCTAssertEqual(s.senderLabel(titleFor: { _ in "   " }), "From session s_1a2b3c4d")
    }

    func testAGreaterThanInsideAnAttributeValueDoesNotEndTheTag() throws {
        let e = try XCTUnwrap(AgentMessageEnvelope.parse(#"<agent-message from="session:s_1" message-id="a>b" sender-permission-class="prompts">"# + "\nbody\n</agent-message>"))
        XCTAssertEqual(e.messageId, "a>b")
        XCTAssertEqual(e.body, "body")
    }

    func testMalformedFallsBack() {
        let bad: [String] = [
            "",
            "plain text from Dispatch to its child",
            "\(head)\nno closing tag",
            #"<agent-message from="session:s_1>"# + "\nunterminated attribute\n</agent-message>",
            "<agent-message>\nno from\n</agent-message>",
            #"<agent-message from="">"# + "\nempty from\n</agent-message>",
            #"<agent-message from="session:s_1" broken>"# + "\nx\n</agent-message>",
            "text before\n\(head)\nx\n</agent-message>",
            "\(head)\nx\n</agent-message>\ntrailing text",
            // Two envelopes concatenated: a raw closing tag inside is not the sender's escaping.
            "\(head)\na\n</agent-message>\n\(head)\nb\n</agent-message>",
            "\(head)\nunescaped </agent-message> inside\n</agent-message>",
            "</agent-message>",
        ]
        for text in bad {
            XCTAssertNil(AgentMessageEnvelope.parse(text), "should fall back: \(text)")
        }
    }

    /// Only the daemon's EXACT wrapping parses: these three attributes in this order, a canonical sender
    /// and a known class. (The daemon also escapes wrapper text inside Dispatch's plain messages to its
    /// own child, so a model cannot hand-write this shape into a `messaging` text.)
    func testOnlyTheDaemonsExactShapeParses() {
        let lookalikes: [String] = [
            #"<agent-message from="session:s_1">"# + "\nmissing attributes\n</agent-message>",
            #"<agent-message from="session:s_1" sender-permission-class="prompts" message-id="m">"# + "\nwrong order\n</agent-message>",
            #"<agent-message from="session:s_1" message-id="m" sender-permission-class="admin">"# + "\nunknown class\n</agent-message>",
            #"<agent-message from="dispatch" message-id="m" sender-permission-class="prompts">"# + "\nnot a canonical sender\n</agent-message>",
            #"<agent-message from="session:s_1" message-id="m" sender-permission-class="prompts" extra="1">"# + "\nextra attribute\n</agent-message>",
            #"<agent-message from="session:s_1" message-id="" sender-permission-class="prompts">"# + "\nempty id\n</agent-message>",
        ]
        for text in lookalikes { XCTAssertNil(AgentMessageEnvelope.parse(text), "must not parse: \(text)") }
        // What the daemon escapes inside Dispatch's plain text (`&lt;agent-message …`) never parses either.
        XCTAssertNil(AgentMessageEnvelope.parse("&lt;agent-message from=\"session:s_1\" message-id=\"m\" sender-permission-class=\"prompts\">\nhi\n&lt;/agent-message>"))
    }

    func testPlainTextIsUntouched() {
        XCTAssertNil(AgentMessageEnvelope.parse("run the tests please"))
        XCTAssertNil(AgentMessageEnvelope.parse("<summary>x</summary>"))
    }

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
