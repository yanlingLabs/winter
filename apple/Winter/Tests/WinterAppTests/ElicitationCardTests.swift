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
    private let requested = #"{"type":"elicitation_requested","seq":3,"sessionId":"s","ts":0,"threadId":"main","elicitationId":"el_1","mode":"url","serverName":"linear","message":"Connect your workspace","host":"linear.app","origin":"https://linear.app","issuedAt":0,"expiresAt":600000}"#
    private let card = PendingInteraction.urlElicitation(callId: "el_1", serverName: "linear", message: "Connect your workspace", host: "linear.app", origin: "https://linear.app", expiresAt: 600000)
    private let ask = InteractionRecord.Ask.urlElicitation(serverName: "linear", message: "Connect your workspace", host: "linear.app", origin: "https://linear.app", expiresAt: 600000)
    /// Far in the future: a live card.
    private let live = Int(Date().timeIntervalSince1970 * 1000) + 3_600_000
    private func resolved(_ action: String, by: String = "orb") -> String {
        #"{"type":"elicitation_resolved","seq":4,"sessionId":"s","ts":0,"threadId":"main","elicitationId":"el_1","action":"\#(action)","by":"\#(by)"}"#
    }
    private func records(_ s: OrbSessionState) -> [InteractionRecord] {
        s.exchanges.flatMap { $0.activity.compactMap(\.interactionRecord) }
    }

    // MARK: Reducer

    func testARequestedElicitationIsAPendingCardInTheTranscript() {
        let s = SessionReducer.reduce(openTurn(), ev(requested))
        XCTAssertEqual(s.pendingInteractions, [card])
        XCTAssertEqual(s.status, .approvalNeeded(count: 1))
        XCTAssertEqual(records(s).first?.ask, ask)
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
        XCTAssertEqual(cardGlyphSymbol(ask), "link")
        XCTAssertEqual(cardTitle(ask), "linear asks you to open a link")
        XCTAssertEqual(interactionProvenance(.elicitation(action: "cancel", by: elicitationInactiveBy)), "this request is no longer active")
    }

    /// A stray keystroke must never open a browser: the card is mouse-only.
    func testNoKeystrokeAnswersAnElicitationCard() {
        for key in ["y", "n", "1"] {
            XCTAssertNil(cardKeyAction(keyCode: 0, chars: key, topmost: card, composerDraft: ""))
        }
    }

    // MARK: Resolving a stale card locally

    func testAnInactiveCardFreezesLocallyButTheDaemonsOwnOutcomeStands() {
        let pending = InteractionRecord(callId: "el_1", ask: ask)
        XCTAssertNil(elicitationLocalOutcome(pending, inactive: []))
        XCTAssertEqual(elicitationLocalOutcome(pending, inactive: ["el_1"]), .elicitation(action: "cancel", by: elicitationInactiveBy))
        let resolved = InteractionRecord(callId: "el_1", ask: ask, outcome: .elicitation(action: "accept", by: "orb"))
        XCTAssertNil(elicitationLocalOutcome(resolved, inactive: ["el_1"]))
        let approval = InteractionRecord(callId: "el_1", ask: .approval(toolName: "bash", summary: "x"))
        XCTAssertNil(elicitationLocalOutcome(approval, inactive: ["el_1"]))
    }

    func testAlreadyResolvedReadsAsNoLongerActive() {
        XCTAssertEqual(elicitationSendResult(alreadyResolved: false), .sent)
        XCTAssertEqual(elicitationSendResult(alreadyResolved: true), .inactive)
        XCTAssertEqual(elicitationSendResult(alreadyResolved: nil), .failed)
    }

    func testExpiryIsReadAgainstTheWallClock() {
        let at = Date(timeIntervalSince1970: 1000)
        XCTAssertFalse(elicitationIsExpired(expiresAt: 1_000_001, now: at))
        XCTAssertTrue(elicitationIsExpired(expiresAt: 1_000_000, now: at))
    }

    // MARK: The client's own check and the fetch-check-open-send order

    func testOnlyAnHttpsLinkToTheCardsOwnHostIsOpenable() {
        XCTAssertEqual(elicitationURLToOpen("https://linear.app/oauth?code=1", expectedHost: "linear.app")?.absoluteString, "https://linear.app/oauth?code=1")
        XCTAssertNotNil(elicitationURLToOpen("https://LINEAR.app/x", expectedHost: "linear.app"))
        XCTAssertNotNil(elicitationURLToOpen("https://linear.app:8443/x", expectedHost: "linear.app:8443"))
        for bad in ["https://evil.example/", "https://linear.app.evil.example/", "https://linear.app:8443/x", "http://linear.app/",
                    "javascript:alert(1)", "https://u:p@linear.app/", "https:///nohost", "not a url", ""] {
            XCTAssertNil(elicitationURLToOpen(bad, expectedHost: "linear.app"), bad)
        }
    }

    func testOpenLinkFetchesChecksOpensThenSendsAccept() async {
        var steps: [String] = []
        let result = await performElicitationAnswer(accept: true, host: "linear.app", expiresAt: live,
                                                    fetchURL: { steps.append("fetch"); return "https://linear.app/x?code=1" },
                                                    open: { steps.append("open \($0.host ?? "")"); return true },
                                                    send: { steps.append("send \($0)"); return .sent })
        XCTAssertEqual(result, .done)
        XCTAssertEqual(steps, ["fetch", "open linear.app", "send true"])
    }

    func testAFailedFetchOrAnAlreadyResolvedAnswerIsNoLongerActive() async {
        let gone = await performElicitationAnswer(accept: true, host: "linear.app", expiresAt: live,
                                                  fetchURL: { nil },
                                                  open: { _ in XCTFail("opened with no url"); return true },
                                                  send: { _ in XCTFail("sent with no url"); return .sent })
        XCTAssertEqual(gone, .inactive)
        let stale = await performElicitationAnswer(accept: false, host: "linear.app", expiresAt: live,
                                                   fetchURL: { XCTFail("decline fetched the url"); return nil },
                                                   open: { _ in XCTFail("decline opened the link"); return true },
                                                   send: { _ in .inactive })
        XCTAssertEqual(stale, .inactive)
    }

    func testAnExpiredCardNeverFetchesOrOpens() async {
        let result = await performElicitationAnswer(accept: true, host: "linear.app", expiresAt: 1,
                                                    fetchURL: { XCTFail("fetched after expiry"); return "https://linear.app/" },
                                                    open: { _ in XCTFail("opened after expiry"); return true },
                                                    send: { _ in .sent })
        XCTAssertEqual(result, .inactive)
    }

    func testALinkToAnotherHostOrThatWillNotOpenIsNeverReportedAccepted() async {
        var sent: [Bool] = []
        let elsewhere = await performElicitationAnswer(accept: true, host: "linear.app", expiresAt: live,
                                                       fetchURL: { "https://evil.example/?code=1" },
                                                       open: { _ in XCTFail("a link to another host was opened"); return true },
                                                       send: { sent.append($0); return .sent })
        XCTAssertEqual(elsewhere, .error("the link doesn't match linear.app — not opened"))
        let failed = await performElicitationAnswer(accept: true, host: "linear.app", expiresAt: live,
                                                    fetchURL: { "https://linear.app/x" },
                                                    open: { _ in false }, send: { sent.append($0); return .sent })
        XCTAssertEqual(failed, .error("couldn't open the link — try again"))
        XCTAssertEqual(sent, [], "nothing was told the daemon when nothing opened")
    }

    func testDeclineOpensNothing() async {
        var sent: [Bool] = []
        let result = await performElicitationAnswer(accept: false, host: "linear.app", expiresAt: live,
                                                    fetchURL: { XCTFail("decline fetched the url"); return nil },
                                                    open: { _ in XCTFail("decline opened the link"); return true },
                                                    send: { sent.append($0); return .failed })
        XCTAssertEqual(sent, [false])
        XCTAssertEqual(result, .error("couldn't send — try again"))
    }
}
