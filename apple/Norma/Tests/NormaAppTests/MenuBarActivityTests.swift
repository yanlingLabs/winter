import XCTest
import NormaProtocol
@testable import Norma

/// Task 5 (DD-T5): the menu-bar live icon's pure transition function + frame-name derivation.
/// Event construction mirrors `SessionModelTests.ev(_:)`'s mechanics exactly (JSON envelope ->
/// `JSONDecoder().decode(SessionEvent.self, from:)`) — the same wire-shaped-JSON factory pattern
/// used across this suite, so these tests stay honest to the real protocol rather than a
/// stand-in fixture.
final class MenuBarActivityTests: XCTestCase {
    private func ev(_ json: String) -> SessionEvent {
        try! JSONDecoder().decode(SessionEvent.self, from: Data(json.utf8))
    }

    private func assistantDelta(seq: Int = 2) -> SessionEvent {
        ev(#"{"type":"assistant_delta","seq":\#(seq),"sessionId":"s","ts":0,"threadId":"main","delta":"hi"}"#)
    }
    private func toolCall(seq: Int = 3) -> SessionEvent {
        ev(#"{"type":"tool_call","seq":\#(seq),"sessionId":"s","ts":0,"threadId":"main","callId":"c1","name":"bash","argsJson":"{}"}"#)
    }
    private func toolResult(seq: Int = 4) -> SessionEvent {
        ev(#"{"type":"tool_result","seq":\#(seq),"sessionId":"s","ts":0,"threadId":"main","callId":"c1","output":"ok","isError":false}"#)
    }
    private func turnCompleted(seq: Int = 5) -> SessionEvent {
        ev(#"{"type":"turn_completed","seq":\#(seq),"sessionId":"s","ts":0,"threadId":"main","stopReason":"end_turn","inputTokens":1,"outputTokens":1}"#)
    }
    private func agentError(seq: Int = 6) -> SessionEvent {
        ev(#"{"type":"agent_error","seq":\#(seq),"sessionId":"s","ts":0,"threadId":"main","message":"boom"}"#)
    }
    private func approvalRequested(seq: Int = 7) -> SessionEvent {
        ev(#"{"type":"approval_requested","seq":\#(seq),"sessionId":"s","ts":0,"threadId":"main","callId":"c1","toolName":"bash","summary":"rm x"}"#)
    }

    func testEventMapping() {
        // assistant streaming ⇒ thinking. NOTE (adaptation point 1): the brief's guessed
        // "reasoning_summary_delta" type string does not exist on the wire the app decodes —
        // NormaProtocol's SessionEvent has no dedicated reasoning-delta case at all (the daemon's
        // opaque `reasoning_item` deliberately decodes as `.unknownEvent`/`NormaEvent.unknown`,
        // never reaching `MenuBarActivity.next`, per CLAUDE.md's "reasoning_item is opaque"
        // contract) — so "reasoning streaming" collapses to `assistantDelta` alone here.
        XCTAssertEqual(MenuBarActivity.next(after: .idle, event: assistantDelta()), .thinking)
        // tool_call ⇒ working (even from thinking)
        XCTAssertEqual(MenuBarActivity.next(after: .thinking, event: toolCall()), .working)
        // tool_result alone does NOT idle — the turn continues (model may keep thinking)
        XCTAssertEqual(MenuBarActivity.next(after: .working, event: toolResult()), .thinking)
        // turn_completed ⇒ idle from anywhere
        XCTAssertEqual(MenuBarActivity.next(after: .working, event: turnCompleted()), .idle)
        XCTAssertEqual(MenuBarActivity.next(after: .thinking, event: turnCompleted()), .idle)
        // agent_error ⇒ idle from anywhere
        XCTAssertEqual(MenuBarActivity.next(after: .working, event: agentError()), .idle)
        // unrelated events never change state
        XCTAssertEqual(MenuBarActivity.next(after: .idle, event: approvalRequested()), .idle)
        XCTAssertEqual(MenuBarActivity.next(after: .thinking, event: approvalRequested()), .thinking)
    }

    func testImageNames() {
        XCTAssertEqual(MenuBarController.imageName(for: .idle, frame: 3, prefix: "mb"), "mb-idle")
        XCTAssertEqual(MenuBarController.imageName(for: .thinking, frame: 3, prefix: "mb"), "mb-thinking-3")
        XCTAssertEqual(MenuBarController.imageName(for: .working, frame: 13, prefix: "mb-dev"), "mb-dev-working-1") // frame wraps mod 12
    }

    // menubar-anim: per-state pulse cadence — thinking (whole-mark breathing) is slower than
    // working (rotating comet-tail), and idle runs no timer at all (nil ⇒ Global Constraint: idle
    // = zero timers, zero CPU — see `setActivity`'s `guard new != .idle` in MenuBarController).
    func testPulseInterval() {
        XCTAssertNil(MenuBarController.pulseInterval(for: .idle))
        XCTAssertEqual(MenuBarController.pulseInterval(for: .thinking), 0.15)
        XCTAssertEqual(MenuBarController.pulseInterval(for: .working), 0.10)
    }
}
