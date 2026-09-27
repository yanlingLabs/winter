import XCTest
import WinterProtocol
@testable import Winter

/// WS-27: an MCP server's URL-mode elicitation card on the Mac — the reducer fold, the frozen
/// record's wording, the client's own https check, and the open-then-send order. Pixels and the
/// real browser hand-off are the live gate's; what is pinned here is the data and the decisions.
@MainActor
final class ElicitationCardTests: XCTestCase {

    private func ev(_ json: String, file: StaticString = #filePath, line: UInt = #line) -> SessionEvent {
        do {
            return try JSONDecoder().decode(SessionEvent.self, from: Data(json.utf8))
        } catch {
            XCTFail("undecodable SessionEvent fixture: \(error)\n\(json)", file: file, line: line)
            return .turnStarted(.init(seq: 0, sessionId: "s", ts: 0, threadId: "main"))
        }
    }
    private func openTurn() -> OrbSessionState {
        var s = OrbSessionState()
        s = SessionReducer.reduce(s, ev(#"{"type":"user_message","seq":1,"sessionId":"s","ts":0,"threadId":"main","text":"hi","clientName":"cli"}"#))
        s = SessionReducer.reduce(s, ev(#"{"type":"turn_started","seq":2,"sessionId":"s","ts":0,"threadId":"main"}"#))
        return s
    }
    private let requested = #"{"type":"elicitation_requested","seq":3,"sessionId":"s","ts":0,"threadId":"main","elicitationId":"el_1","mode":"url","serverName":"linear","message":"Connect your workspace","url":"https://linear.app/oauth?code=OTC","host":"linear.app","issuedAt":0,"expiresAt":600000}"#
    private func resolved(_ action: String, by: String = "orb") -> String {
        #"{"type":"elicitation_resolved","seq":4,"sessionId":"s","ts":0,"threadId":"main","elicitationId":"el_1","action":"\#(action)","by":"\#(by)"}"#
    }
    private func records(_ s: OrbSessionState) -> [InteractionRecord] {
        s.exchanges.flatMap { $0.activity.compactMap(\.interactionRecord) }
    }

    // MARK: Reducer

    func testARequestedElicitationIsAPendingCardInTheTranscript() {
        let s = SessionReducer.reduce(openTurn(), ev(requested))
        XCTAssertEqual(s.pendingInteractions, [.urlElicitation(callId: "el_1", serverName: "linear", message: "Connect your workspace", url: "https://linear.app/oauth?code=OTC", host: "linear.app")])
        XCTAssertEqual(s.status, .approvalNeeded(count: 1))
        XCTAssertEqual(records(s).first?.ask, .urlElicitation(serverName: "linear", message: "Connect your workspace", url: "https://linear.app/oauth?code=OTC", host: "linear.app"))
        XCTAssertTrue(records(s).first.map(interactionIsPending) ?? false)
    }

    func testAResolvedElicitationFreezesWithItsOutcome() {
        var s = SessionReducer.reduce(openTurn(), ev(requested))
        s = SessionReducer.reduce(s, ev(resolved("accept")))
        XCTAssertTrue(s.pendingInteractions.isEmpty)
        XCTAssertEqual(records(s).first?.outcome, .elicitation(action: "accept", by: "orb"))
        // A replayed duplicate request is not a second card.
        s = SessionReducer.reduce(s, ev(requested))
        XCTAssertEqual(records(s).count, 1)
    }

    func testTheTurnEndingFreezesAnUnansweredCardAndTheDaemonsCancelThenOutranksIt() {
        var s = SessionReducer.reduce(openTurn(), ev(requested))
        s = SessionReducer.reduce(s, ev(#"{"type":"turn_completed","seq":5,"sessionId":"s","ts":0,"threadId":"main","stopReason":"aborted","inputTokens":1,"outputTokens":1}"#))
        XCTAssertEqual(records(s).first?.outcome, .ended)
        s = SessionReducer.reduce(s, ev(resolved("cancel", by: "turn-ended")))
        XCTAssertEqual(records(s).first?.outcome, .elicitation(action: "cancel", by: "turn-ended"))
    }

    // MARK: Wording

    func testTheFrozenRecordSaysWhatHappenedAndWhoDidIt() {
        XCTAssertEqual(outcomeLabel(.elicitation(action: "accept", by: "orb")).text, "Link opened")
        XCTAssertTrue(outcomeLabel(.elicitation(action: "accept", by: "orb")).isAffirmative)
        XCTAssertEqual(outcomeLabel(.elicitation(action: "decline", by: "orb")).text, "Declined")
        XCTAssertEqual(outcomeLabel(.elicitation(action: "cancel", by: "timeout")).text, "Cancelled — timed out")
        XCTAssertEqual(interactionProvenance(.elicitation(action: "decline", by: "orb")), "answered by orb")
        // A daemon cancel names what ended it, never a person.
        XCTAssertEqual(interactionProvenance(.elicitation(action: "cancel", by: "turn-ended")), "cancelled — the turn ended before an answer")
        XCTAssertEqual(interactionProvenance(.elicitation(action: "cancel", by: "aborted")), "cancelled — the session ended before an answer")
        XCTAssertEqual(cardGlyphSymbol(.urlElicitation(serverName: "linear", message: "", url: "https://x.example", host: "x.example")), "link")
        XCTAssertEqual(cardTitle(.urlElicitation(serverName: "linear", message: "", url: "https://x.example", host: "x.example")), "linear asks you to open a link")
    }

    /// A stray keystroke must never open a browser: the card is mouse-only.
    func testNoKeystrokeAnswersAnElicitationCard() {
        let card = PendingInteraction.urlElicitation(callId: "el_1", serverName: "linear", message: "", url: "https://x.example", host: "x.example")
        for key in ["y", "n", "1"] {
            XCTAssertNil(cardKeyAction(keyCode: 0, chars: key, topmost: card, composerDraft: ""))
        }
    }

    // MARK: The client's own check and the open-then-send order

    func testOnlyAPlainHttpsLinkIsOpenable() {
        XCTAssertEqual(elicitationURLToOpen("https://linear.app/oauth?code=1")?.absoluteString, "https://linear.app/oauth?code=1")
        for bad in ["http://linear.app/", "javascript:alert(1)", "file:///etc/passwd", "https://u:p@linear.app/", "https:///nohost", "not a url", ""] {
            XCTAssertNil(elicitationURLToOpen(bad), bad)
        }
    }

    func testOpenLinkOpensFirstThenSendsAccept() async {
        var steps: [String] = []
        let error = await performElicitationAnswer(accept: true, url: "https://linear.app/x",
                                                   open: { steps.append("open \($0.host ?? "")"); return true },
                                                   send: { steps.append("send \($0)"); return true })
        XCTAssertNil(error)
        XCTAssertEqual(steps, ["open linear.app", "send true"])
    }

    func testALinkThatWillNotOpenIsNeverReportedAccepted() async {
        var sent: [Bool] = []
        let failed = await performElicitationAnswer(accept: true, url: "https://linear.app/x",
                                                    open: { _ in false }, send: { sent.append($0); return true })
        XCTAssertEqual(failed, "couldn't open the link — try again")
        let refused = await performElicitationAnswer(accept: true, url: "http://linear.app/x",
                                                     open: { _ in XCTFail("an http link was opened"); return true },
                                                     send: { sent.append($0); return true })
        XCTAssertNotNil(refused)
        XCTAssertEqual(sent, [], "nothing was told the daemon when nothing opened")
    }

    func testDeclineOpensNothing() async {
        var sent: [Bool] = []
        let error = await performElicitationAnswer(accept: false, url: "https://linear.app/x",
                                                   open: { _ in XCTFail("decline opened the link"); return true },
                                                   send: { sent.append($0); return false })
        XCTAssertEqual(sent, [false])
        XCTAssertEqual(error, "couldn't send — try again")
    }
}
