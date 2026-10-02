import XCTest
import WinterSessionKit

/// The shared reader of another Winter session's message (`clientName: "messaging"`) — used by the Mac
/// app's `SessionReducer` and the phone's transcript builder alike. Moved here from the Mac app's tests
/// with the parser itself (2026-10-02); the Mac keeps its reducer-fold tests.
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

    // MARK: - The clientName gate

    func testOnlyTheMessagingClientIsParsed() throws {
        let wrapped = "\(head)\nplease also run the tests\n</agent-message>"
        XCTAssertEqual(AgentMessageEnvelope.messagingClientName, "messaging")
        XCTAssertEqual(try XCTUnwrap(AgentMessageEnvelope.forUserMessage(text: wrapped, clientName: "messaging")).body, "please also run the tests")
        // A person typing the wrapper shape gets their own text back, not a spoofed sender header.
        XCTAssertNil(AgentMessageEnvelope.forUserMessage(text: wrapped, clientName: "cli"))
        XCTAssertNil(AgentMessageEnvelope.forUserMessage(text: wrapped, clientName: nil))
        // Dispatch's plain message to its own child rides the same clientName and is not an envelope.
        XCTAssertNil(AgentMessageEnvelope.forUserMessage(text: "do the thing", clientName: "messaging"))
    }
}
