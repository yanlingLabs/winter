import XCTest
import WinterProtocol
import WinterKit
@testable import Winter

/// Tools and replies draw in the order they happened (user, 2026-10-02: every tool call sat at the
/// top of the exchange, above every reply).
final class ExchangeTimelineTests: XCTestCase {
    private func ev(_ json: String) -> SessionEvent {
        try! JSONDecoder().decode(SessionEvent.self, from: Data(json.utf8))
    }
    private func user(_ seq: Int) -> SessionEvent {
        ev(#"{"type":"user_message","seq":\#(seq),"sessionId":"s","ts":0,"threadId":"main","text":"go","clientName":"cli"}"#)
    }
    private func started(_ seq: Int) -> SessionEvent {
        ev(#"{"type":"turn_started","seq":\#(seq),"sessionId":"s","ts":0,"threadId":"main"}"#)
    }
    private func message(_ text: String, _ seq: Int) -> SessionEvent {
        ev(#"{"type":"assistant_message","seq":\#(seq),"sessionId":"s","ts":0,"threadId":"main","text":"\#(text)"}"#)
    }
    private func tool(_ name: String, _ seq: Int) -> SessionEvent {
        ev(#"{"type":"tool_call","seq":\#(seq),"sessionId":"s","ts":0,"threadId":"main","callId":"c\#(seq)","name":"\#(name)","argsJson":"{}"}"#)
    }
    private func result(_ callSeq: Int, _ seq: Int) -> SessionEvent {
        ev(#"{"type":"tool_result","seq":\#(seq),"sessionId":"s","ts":0,"threadId":"main","callId":"c\#(callSeq)","output":"ok","isError":false}"#)
    }

    /// The shape the user saw: a message, then search → résumé, search → résumé.
    private func interleavedExchange() -> Exchange {
        var s = OrbSessionState()
        for e in [user(1), started(2), message("plan", 3), tool("web_search", 4), result(4, 5),
                  message("résumé 1", 6), tool("web_search", 7), result(7, 8), message("résumé 2", 9)] {
            s = SessionReducer.reduce(s, e)
        }
        return s.exchanges[0]
    }

    private func shape(_ segments: [ExchangeTimelineSegment]) -> [String] {
        segments.map {
            switch $0 {
            case .reply(let i): return "reply\(i)"
            case .activity(let items): return "tools\(items.count)"
            }
        }
    }

    func testRepliesAndToolsInterleaveInArrivalOrder() {
        let exchange = interleavedExchange()
        XCTAssertEqual(exchange.replies, ["plan", "résumé 1", "résumé 2"])
        XCTAssertEqual(shape(exchangeTimeline(exchange)), ["reply0", "tools1", "reply1", "tools1", "reply2"])
    }

    func testToolsAfterTheLastReplyStayAtTheEnd() {
        var s = OrbSessionState()
        for e in [user(1), started(2), message("looking", 3), tool("bash", 4), tool("read", 5)] {
            s = SessionReducer.reduce(s, e)
        }
        XCTAssertEqual(shape(exchangeTimeline(s.exchanges[0])), ["reply0", "tools2"])
    }

    func testAnExchangeBuiltWholeKeepsActivityFirst() {
        let item = ActivityItem(kind: .tool(name: "bash", detail: nil, callId: "c1"))
        let exchange = Exchange(prompt: "p", reply: "done", activity: [item])
        XCTAssertEqual(shape(exchangeTimeline(exchange)), ["tools1", "reply0"])
    }

    func testDroppedActivityKeepsTheRestInOrder() {
        var exchange = interleavedExchange()
        exchange.removeActivityItem(at: 0) // the drop-oldest cap took the first search
        XCTAssertEqual(shape(exchangeTimeline(exchange)), ["reply0", "reply1", "tools1", "reply2"])
    }

    func testOrderingDoesNotChangeEquality() {
        let built = Exchange(prompt: "go", reply: "x")
        var reduced = Exchange(prompt: "go", reply: "")
        reduced.appendReply("x")
        XCTAssertEqual(built, reduced)
    }

    func testStatusStaysOnAToolWhileAConcurrentCallIsStillOut() {
        var s = OrbSessionState()
        for e in [user(1), started(2), tool("web_search", 3), tool("web_search", 4), result(3, 5)] {
            s = SessionReducer.reduce(s, e)
        }
        XCTAssertEqual(s.status, .toolRunning(name: "web_search"), "one search came back, the other is still out")
        s = SessionReducer.reduce(s, result(4, 6))
        XCTAssertEqual(s.status, .thinking)
    }
}
