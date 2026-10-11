import Foundation
import WinterComputerUseShell
import WinterCUCore
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

    func testTheCardsExpiresAtReachesThePanelAndTimeoutMsIsOnlyTheFallback() async throws {
        let prompter = FakePrompter()
        let rig = Rig(prompts: prompter)
        let p = try JSONDecoder().decode(JSONValue.self, from: Data("""
            {"promptId":"cu_e","callId":"cu_e","sessionId":"s_1","app":"Safari","bundleId":"com.apple.Safari","reason":"r",
             "expiresAt":1760000042000}
            """.utf8))
        let task = Task { try await rig.dispatcher.handle(method: "prompt.desktopVisit", params: p) }
        for _ in 0..<200 where prompter.shown.isEmpty { try await Task.sleep(nanoseconds: 5_000_000) }
        XCTAssertEqual(prompter.shown.first?.expiresAt, 1_760_000_042_000)
        prompter.answer("cu_e", .expired)
        let answered = try await task.value
        XCTAssertEqual(try encode(answered)["answer"]?.stringValue, "expired")
    }

    /// Every closed desktop visit reaches the daemon (`desktopVisited`), with the spine's keys.
    func testAClosedVisitIsAnnouncedToTheDaemon() {
        let rig = Rig()
        let report = CUVisitReport(visitId: "v7", targetId: "t1", app: "Safari", why: "live", actions: 2, ms: 1300, returned: true)
        rig.coordinator.desktopVisited(CUDesktopVisitEvent(sessionId: "s_1", callId: "c9", report: report))
        rig.coordinator.desktopVisited(CUDesktopVisitEvent(sessionId: "s_1", callId: nil,
                                                           report: CUVisitReport(visitId: "v8", targetId: "t2", app: "Notes", why: "act",
                                                                                 actions: 1, ms: 700, returned: false, userMoved: true)))
        XCTAssertEqual(rig.notifications.map(\.method), ["desktopVisited", "desktopVisited"])
        XCTAssertEqual(rig.notifications.first?.params, try! JSONDecoder().decode(JSONValue.self, from: Data("""
            {"visitId":"v7","sessionId":"s_1","callId":"c9","targetId":"t1","app":"Safari","why":"live","actions":2,"ms":1300,"returned":true}
            """.utf8)))
        XCTAssertEqual(rig.notifications.last?.params["userMoved"], .bool(true))
        XCTAssertNil(rig.notifications.last?.params["callId"])
    }

    /// Esc closes the open desktop visit at once, then tells the daemon.
    func testEscClosesTheOpenVisitBeforeTheDaemonHears() {
        let rig = Rig()
        var order: [String] = []
        rig.coordinator.onEscape = { order.append("visit closed") }
        rig.coordinator.notify = { order.append($0.method) }
        rig.coordinator.setScriptActive(sessionId: "s_1", active: true)
        rig.coordinator.escapePressed()
        XCTAssertEqual(order, ["visit closed", "escPressed"])
    }
}
