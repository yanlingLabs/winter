import XCTest
@testable import Winter
import WinterProtocol
import WinterKit

/// ComputerV2 wake triggers (2026-10-12): the reducer's side — `wake_armed`/`wake_ended` keep `armedWakes` (the
/// "Waiting for you" pill), and the daemon's `computer-wake` message becomes a NOTICE built from the pair: a
/// prompt-less exchange when the session was idle, a note on the running exchange when it was folded in — never a
/// user bubble, never the model's `<computer-wake>` text. Plus the pill's words.
final class WakeTriggerReducerTests: XCTestCase {
    private func ev(_ json: String) -> SessionEvent {
        try! JSONDecoder().decode(SessionEvent.self, from: Data(json.utf8))
    }
    private func reduce(_ s: OrbSessionState, _ jsons: [String]) -> OrbSessionState {
        jsons.reduce(s) { SessionReducer.reduce($0, ev($1)) }
    }
    private func armed(_ id: String, condition: String = "clicked", element: String? = "“Submit for review”", seq: Int) -> String {
        let el = element.map { #","elementLabel":"\#($0)""# } ?? ""
        return #"{"type":"wake_armed","seq":\#(seq),"sessionId":"s","ts":0,"threadId":"main","wakeId":"\#(id)","condition":"\#(condition)","targetLabel":"Chrome — Dashboard"\#(el),"expiresAt":1781273600000}"#
    }
    private func ended(_ id: String, reason: String, woken: Bool, seq: Int) -> String {
        #"{"type":"wake_ended","seq":\#(seq),"sessionId":"s","ts":0,"threadId":"main","wakeId":"\#(id)","reason":"\#(reason)","at":1781270460000,"woken":\#(woken)}"#
    }
    private func userMessage(_ text: String, clientName: String, seq: Int) -> String {
        #"{"type":"user_message","seq":\#(seq),"sessionId":"s","ts":0,"threadId":"main","text":"\#(text)","clientName":"\#(clientName)"}"#
    }
    private func turnStarted(seq: Int) -> String { #"{"type":"turn_started","seq":\#(seq),"sessionId":"s","ts":0,"threadId":"main"}"# }
    private func turnCompleted(seq: Int) -> String {
        #"{"type":"turn_completed","seq":\#(seq),"sessionId":"s","ts":0,"threadId":"main","stopReason":"end_turn","inputTokens":0,"outputTokens":0}"#
    }

    func testArmedThenEndedKeepsThePillsList() {
        var s = reduce(OrbSessionState(), [armed("wk_000000000001", seq: 1), armed("wk_000000000002", condition: "appeared", element: "“Sent”", seq: 2)])
        XCTAssertEqual(s.armedWakes.map(\.wakeId), ["wk_000000000001", "wk_000000000002"])
        s = reduce(s, [ended("wk_000000000002", reason: "cancelled", woken: false, seq: 3)])
        XCTAssertEqual(s.armedWakes.map(\.wakeId), ["wk_000000000001"])
        XCTAssertTrue(s.pendingWakeNews.isEmpty, "a cancelled trigger wakes nobody")
    }

    func testAnIdleSessionsWakeOpensAPromptlessExchangeWithTheNotice() {
        let s = reduce(OrbSessionState(), [
            userMessage("get the listing ready", clientName: "orb", seq: 1),
            turnStarted(seq: 2), armed("wk_000000000001", seq: 3), turnCompleted(seq: 4),
            ended("wk_000000000001", reason: "fired", woken: true, seq: 5),
            userMessage("<computer-wake> … </computer-wake>", clientName: "computer-wake", seq: 6),
            turnStarted(seq: 7),
        ])
        XCTAssertEqual(s.exchanges.map(\.prompt), ["get the listing ready", ""])
        XCTAssertEqual(s.exchanges.last?.notice, "Winter continued: you clicked “Submit for review” in Chrome — Dashboard")
        XCTAssertFalse(s.exchanges.contains { $0.prompt.contains("computer-wake") }, "the model's text never becomes a prompt")
        XCTAssertTrue(s.armedWakes.isEmpty)
        XCTAssertTrue(s.pendingWakeNews.isEmpty)
        XCTAssertFalse(s.lastTurnWasOrbInitiated)
    }

    func testAWakeFoldedIntoARunningTurnNotesTheRunningExchange() {
        let s = reduce(OrbSessionState(), [
            userMessage("go", clientName: "orb", seq: 1), turnStarted(seq: 2), armed("wk_000000000001", condition: "titled", element: "“Sent”", seq: 3),
            ended("wk_000000000001", reason: "fired", woken: true, seq: 4),
            userMessage("<computer-wake/>", clientName: "computer-wake", seq: 5),
        ])
        XCTAssertEqual(s.exchanges.map(\.prompt), ["go"])
        XCTAssertEqual(s.exchanges.last?.notice, "Winter continued: Chrome — Dashboard's title now contains “Sent”")
        XCTAssertTrue(s.queuedSteers.isEmpty)
    }

    /// R-W3: a SILENT expiry (`woken: false`) is never news — B firing hours later says B alone, never "ran out" for A.
    func testASilentExpiryIsNeverGluedOntoALaterWakesNotice() {
        let s = reduce(OrbSessionState(), [
            userMessage("get the listing ready", clientName: "orb", seq: 1),
            turnStarted(seq: 2),
            armed("wk_00000000000a", condition: "appeared", element: "“Sent”", seq: 3),
            armed("wk_00000000000b", element: "“Submit”", seq: 4),
            turnCompleted(seq: 5),
            ended("wk_00000000000a", reason: "expired", woken: false, seq: 6),
            ended("wk_00000000000b", reason: "fired", woken: true, seq: 7),
            userMessage("<computer-wake> … </computer-wake>", clientName: "computer-wake", seq: 8),
            turnStarted(seq: 9),
        ])
        XCTAssertEqual(s.exchanges.last?.notice, "Winter continued: you clicked “Submit” in Chrome — Dashboard")
        XCTAssertFalse(s.exchanges.last?.notice?.contains("Sent") ?? true)
        XCTAssertTrue(s.pendingWakeNews.isEmpty)
        XCTAssertTrue(s.armedWakes.isEmpty)
    }

    /// An expiry the model asked to hear about (`woken: true`) IS the wake's news.
    func testAnExpiryThatWakesIsTheNotice() {
        let s = reduce(OrbSessionState(), [
            armed("wk_00000000000c", condition: "titled", element: "“Done”", seq: 1),
            ended("wk_00000000000c", reason: "expired", woken: true, seq: 2),
            userMessage("<computer-wake/>", clientName: "computer-wake", seq: 3),
        ])
        XCTAssertEqual(s.exchanges.last?.notice, "Winter continued: the wait ran out (Chrome — Dashboard's title to contain “Done”)")
    }

    /// L6: a failed [Stop waiting] shows the daemon's own sentence on the pill's line (else the system's).
    func testAFailedStopWaitingReadsTheDaemonsSentence() {
        XCTAssertEqual(wakeStopFailure(RpcError(code: -32001, message: "computerUse.wakes.cancel is available to local clients only")),
                       "computerUse.wakes.cancel is available to local clients only")
        struct Plain: LocalizedError { var errorDescription: String? { "The connection was lost." } }
        XCTAssertEqual(wakeStopFailure(Plain()), "The connection was lost.")
    }

    func testThePillsWords() {
        let wake = ArmedWake(wakeId: "wk_000000000001", condition: "clicked", targetLabel: "Chrome", elementLabel: "“Submit for review”",
                             expiresAt: Int(Date(timeIntervalSince1970: 10_000).timeIntervalSince1970 * 1000) + 52 * 60_000 - 1_000)
        XCTAssertEqual(WakeWords.pillLine(wake, now: Date(timeIntervalSince1970: 10_000)), "Waiting for you · click “Submit for review” in Chrome · 52 min left")
        XCTAssertEqual(WakeWords.timeLeft(wake, now: Date(timeIntervalSince1970: 10_000 + 52 * 60)), "under a minute left")
        let page = ArmedWake(wakeId: "wk_000000000002", condition: "navigated", targetLabel: "Safari — Checkout", elementLabel: nil, expiresAt: 0)
        XCTAssertEqual(WakeWords.waitingFor(page), "Safari — Checkout to move to another page")
        XCTAssertEqual(WakeWords.endedWords(page, reason: "lost"), "Safari — Checkout went away while Winter waited")
    }
}
