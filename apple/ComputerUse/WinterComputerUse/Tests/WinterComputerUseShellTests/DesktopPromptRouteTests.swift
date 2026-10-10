import Foundation
import WinterComputerUseShell
import WinterCUPresentation
import XCTest

/// `prompt.desktopVisit` (helper 1.7.0): the daemon's desktop-switch prompt, drawn on the user's current desktop.
/// It answers when the user clicks — `switch` / `refuse` — or `expired` when the countdown runs out; cancelling the
/// request (the daemon's `cancel {callId}` after its card was answered first) closes the panel and answers nothing.
@MainActor final class DesktopPromptRouteTests: XCTestCase {
    private func params(_ id: String = "cu_ab12", callId: String? = nil, timeoutMs: Int = 60_000) -> JSONValue {
        try! JSONDecoder().decode(JSONValue.self, from: Data("""
            {"promptId":"\(id)","callId":"\(callId ?? id)","sessionId":"s_1","app":"Safari","bundleId":"com.apple.Safari",
             "reason":"to read the chart on screen","timeoutMs":\(timeoutMs)}
            """.utf8))
    }

    private func encode(_ value: AnyEncodable) throws -> JSONValue {
        try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(value))
    }

    /// Starts the request and waits until the prompt is on screen.
    private func ask(_ rig: Rig, _ prompter: FakePrompter, _ id: String = "cu_ab12") async throws -> Task<AnyEncodable, Error> {
        let p = params(id)
        let task = Task { try await rig.dispatcher.handle(method: "prompt.desktopVisit", params: p) }
        for _ in 0..<200 where !prompter.shown.contains(where: { $0.promptId == id }) { try await Task.sleep(nanoseconds: 5_000_000) }
        XCTAssertTrue(prompter.shown.contains { $0.promptId == id }, "the prompt is on screen")
        return task
    }

    func testTheUsersAnswerIsTheResult() async throws {
        for (answer, wire) in [(CUDesktopPromptAnswer.switchNow, "switch"), (.refuse, "refuse"), (.expired, "expired")] {
            let prompter = FakePrompter()
            let rig = Rig(prompts: prompter)
            let task = try await ask(rig, prompter)
            let shown = try XCTUnwrap(prompter.shown.first)
            XCTAssertEqual(shown, CUDesktopPromptRequest(promptId: "cu_ab12", sessionId: "s_1", app: "Safari", bundleId: "com.apple.Safari",
                                                         reason: "to read the chart on screen", timeoutMs: 60_000))
            XCTAssertEqual(rig.coordinator.openPromptIds, ["cu_ab12"])
            prompter.answer("cu_ab12", answer)
            let result = try encode(try await task.value)
            XCTAssertEqual(result["answer"]?.stringValue, wire)
            XCTAssertTrue(rig.coordinator.openPromptIds.isEmpty)
            XCTAssertTrue(prompter.closed.isEmpty, "answered on the panel: nothing to close")
        }
    }

    func testCancellingTheRequestClosesThePanelAndAnswersNothing() async throws {
        let prompter = FakePrompter()
        let rig = Rig(prompts: prompter)
        let task = try await ask(rig, prompter)
        task.cancel()
        do {
            _ = try await task.value
            XCTFail("a cancelled prompt answers nothing")
        } catch {
            XCTAssertTrue(error is CancellationError, "\(error)")
        }
        XCTAssertEqual(prompter.closed, ["cu_ab12"], "the panel closed at once")
        XCTAssertTrue(rig.coordinator.openPromptIds.isEmpty)
        prompter.answer("cu_ab12", .switchNow)  // a click that raced the close goes nowhere
    }

    func testAnAlreadyCancelledRequestShowsNothing() async throws {
        let prompter = FakePrompter()
        let rig = Rig(prompts: prompter)
        let p = params()
        let task = Task { () -> AnyEncodable in
            withUnsafeCurrentTask { $0?.cancel() }
            return try await rig.dispatcher.handle(method: "prompt.desktopVisit", params: p)
        }
        do { _ = try await task.value; XCTFail("cancelled") } catch {}
        XCTAssertTrue(prompter.shown.isEmpty)
    }

    func testTwoPromptsAnswerEachTheirOwn() async throws {
        let prompter = FakePrompter()
        let rig = Rig(prompts: prompter)
        let a = try await ask(rig, prompter, "cu_a")
        let b = try await ask(rig, prompter, "cu_b")
        prompter.answer("cu_b", .refuse)
        prompter.answer("cu_a", .switchNow)
        let ra = try await a.value, rb = try await b.value
        XCTAssertEqual(try encode(ra)["answer"]?.stringValue, "switch")
        XCTAssertEqual(try encode(rb)["answer"]?.stringValue, "refuse")
    }

    func testASecondPromptWithAnOpenIdIsInvalidParams() async throws {
        let prompter = FakePrompter()
        let rig = Rig(prompts: prompter)
        let first = try await ask(rig, prompter)
        do {
            _ = try await rig.dispatcher.handle(method: "prompt.desktopVisit", params: params())
            XCTFail("expected invalid_params")
        } catch {
            XCTAssertEqual(RPCError.from(error).code, "invalid_params")
        }
        prompter.answer("cu_ab12", .refuse)
        _ = try await first.value
    }

    func testBadParamsAreInvalidParams() async {
        let rig = Rig(prompts: FakePrompter())
        for bad in [params(callId: "other"), params(timeoutMs: 0),
                    try! JSONDecoder().decode(JSONValue.self, from: Data(#"{"promptId":"x","callId":"x"}"#.utf8))] {
            do {
                _ = try await rig.dispatcher.handle(method: "prompt.desktopVisit", params: bad)
                XCTFail("expected invalid_params for \(bad)")
            } catch {
                XCTAssertEqual(RPCError.from(error).code, "invalid_params", "\(bad)")
            }
        }
    }
}
