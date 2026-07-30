import Foundation
import XCTest
import NormaProtocol
@testable import NormaChatKit

/// `ChatEngine` — the phone's chat turn-loop. Every test drives a SCRIPTED provider; the tool tests
/// drive a `ScriptedChatHTTP`. None touches the network or a real model.
final class ChatEngineTests: XCTestCase {
    private let t0 = Date(timeIntervalSince1970: 1_700_000_000)

    private func engine(_ provider: any ChatProvider, broker: QuestionBroker = QuestionBroker()) -> ChatEngine {
        let clock = t0
        return ChatEngine(provider: provider, broker: broker, now: { clock })
    }

    /// A toolset with no live tools wired past `http` — enough for turns whose tools are never called.
    private func toolset(http: ChatHTTP = ScriptedChatHTTP(), exaKey: String? = nil,
                         askTimeout: Duration = .seconds(300)) -> ChatToolset {
        let clock = t0
        let fetcher = PageFetcher(http: http, cache: PageCache(), now: { clock })
        return ChatToolset(http: http, fetcher: fetcher, exaKey: exaKey, askTimeout: askTimeout)
    }

    // MARK: - basic turn

    func testEmitsUserTurnStartedDeltasAssistantAndTurnCompleted() async {
        let provider = ScriptedChatProvider([[.textDelta("Hel"), .textDelta("lo"), .usage(inputTokens: 8, outputTokens: 3), .done(.endTurn)]])
        let collector = EventCollector()
        let session = ScriptedLocalSession(sessionId: "ses_1", lastSeq: 0)

        await engine(provider).runTurn(session: session, userText: "hi", model: "gpt-5.4",
                                       tools: toolset(), emit: collector.callback)

        XCTAssertEqual(collector.types, ["user_message", "turn_started", "assistant_delta", "assistant_delta",
                                         "assistant_message", "turn_completed"])
        // seq: persisted events are contiguous from lastSeq+1; the transient deltas ride the head.
        XCTAssertEqual(collector.all { if case .userMessage(let v) = $0 { return v.seq } else { return nil } }, [1])
        XCTAssertEqual(collector.all { if case .turnStarted(let v) = $0 { return v.seq } else { return nil } }, [2])
        XCTAssertEqual(collector.all { if case .assistantDelta(let v) = $0 { return v.seq } else { return nil } }, [2, 2])
        XCTAssertEqual(collector.all { if case .assistantMessage(let v) = $0 { return (v.seq, v.text) } else { return nil } }.map { $0.0 }, [3])
        guard case .assistantMessage(let msg) = collector.events[4] else { return XCTFail() }
        XCTAssertEqual(msg.text, "Hello")
        guard case .turnCompleted(let done) = collector.events[5] else { return XCTFail() }
        XCTAssertEqual(done.seq, 4)
        XCTAssertEqual(done.stopReason, "end_turn")
        XCTAssertEqual(done.inputTokens, 8)
        XCTAssertEqual(done.outputTokens, 3)
        // The sessionId is stamped on every event.
        XCTAssertTrue(collector.events.allSatisfy { eventSessionId($0) == "ses_1" })
    }

    func testDeltasEmittedInStreamOrder() async {
        let provider = ScriptedChatProvider([[.textDelta("a"), .textDelta("b"), .textDelta("c"), .done(.endTurn)]])
        let collector = EventCollector()
        await engine(provider).runTurn(session: ScriptedLocalSession(), userText: "x", model: "m",
                                       tools: toolset(), emit: collector.callback)
        let deltas = collector.all { if case .assistantDelta(let v) = $0 { return v.delta } else { return nil } }
        XCTAssertEqual(deltas, ["a", "b", "c"])
    }

    func testPriorInputIsPrependedBeforeTheNewUserMessage() async {
        let provider = ScriptedChatProvider([[.textDelta("ok"), .done(.endTurn)]])
        let session = ScriptedLocalSession(lastSeq: 5, prior: [.message(role: .user, content: "earlier"),
                                                               .message(role: .assistant, content: "reply")])
        await engine(provider).runTurn(session: session, userText: "now", model: "m",
                                       tools: toolset(), emit: { _ in })
        let input = provider.request(0).input
        XCTAssertEqual(input.count, 3)
        if case .message(_, let c0) = input[0] { XCTAssertEqual(c0, "earlier") } else { XCTFail() }
        if case .message(let role, let c2) = input[2] { XCTAssertEqual(c2, "now"); XCTAssertEqual(role, .user) } else { XCTFail() }
    }

    // MARK: - turn-start snapshot (review I1): the user message is never doubled

    func testUserMessageAppearsExactlyOncePerTurnWithAPersistOnEmitSink() async {
        // A daemon-faithful sink persists on emit, so priorInput() is DYNAMIC. If the engine read
        // priorInput() AFTER emitting this turn's user_message, the manual append would double it.
        let provider = ScriptedChatProvider([
            [.textDelta("reply1"), .done(.endTurn)],
            [.textDelta("reply2"), .done(.endTurn)],
        ])
        let session = PersistingLocalSession()
        let eng = engine(provider)

        await eng.runTurn(session: session, userText: "first", model: "m", tools: toolset(), emit: session.callback)
        await eng.runTurn(session: session, userText: "second", model: "m", tools: toolset(), emit: session.callback)

        func userMessages(_ input: [ProviderInputItem]) -> [String] {
            input.compactMap { if case .message(.user, let c) = $0 { return c } else { return nil } }
        }
        // Turn 1's provider input holds "first" exactly once.
        XCTAssertEqual(userMessages(provider.request(0).input), ["first"])
        // Turn 2's provider input holds "first" AND "second", each exactly once (not doubled).
        XCTAssertEqual(userMessages(provider.request(1).input), ["first", "second"])
    }

    // MARK: - tool round-trip

    func testToolRoundTripSearch() async {
        let searchHTTP = ScriptedChatHTTP([.json(["results": [["title": "T", "url": "https://ex.com", "text": "excerpt"]]])])
        let provider = ScriptedChatProvider([
            [.toolCall(callId: "c1", name: "Search", argumentsJSON: #"{"query":"weather"}"#), .done(.toolCalls)],
            [.textDelta("The weather is fine."), .done(.endTurn)],
        ])
        let collector = EventCollector()
        await engine(provider).runTurn(session: ScriptedLocalSession(), userText: "weather?", model: "m",
                                       tools: toolset(http: searchHTTP, exaKey: "exakey"), emit: collector.callback)

        XCTAssertEqual(collector.types, ["user_message", "turn_started", "tool_call", "tool_result",
                                         "assistant_delta", "assistant_message", "turn_completed"])
        guard case .toolCall(let call) = collector.events[2] else { return XCTFail() }
        XCTAssertEqual([call.callId, call.name], ["c1", "Search"])
        guard case .toolResult(let result) = collector.events[3] else { return XCTFail() }
        XCTAssertEqual(result.callId, "c1")
        XCTAssertFalse(result.isError)
        XCTAssertTrue(result.output.contains("https://ex.com"), "the Exa result rode into the tool_result")
        // Round 1's request carried the function_call + its output back to the model.
        let round1 = provider.request(1).input
        XCTAssertTrue(round1.contains { if case .functionCall(let id, _, _) = $0 { return id == "c1" } else { return false } })
        XCTAssertTrue(round1.contains { if case .toolResult(let id, _, _) = $0 { return id == "c1" } else { return false } })
    }

    func testUnknownToolIsAnErrorResultNotACrash() async {
        let provider = ScriptedChatProvider([
            [.toolCall(callId: "c1", name: "Nope", argumentsJSON: "{}"), .done(.toolCalls)],
            [.textDelta("done"), .done(.endTurn)],
        ])
        let collector = EventCollector()
        await engine(provider).runTurn(session: ScriptedLocalSession(), userText: "x", model: "m",
                                       tools: toolset(), emit: collector.callback)
        guard case .toolResult(let result) = collector.events[3] else { return XCTFail() }
        XCTAssertTrue(result.isError)
        XCTAssertTrue(result.output.contains("unknown tool: Nope"))
    }

    // MARK: - question round-trip mid-turn

    func testQuestionRoundTripMidTurn() async {
        let broker = QuestionBroker()
        let provider = ScriptedChatProvider([
            [.toolCall(callId: "q1", name: "AskQuestion",
                       argumentsJSON: #"{"question":"Which?","options":[{"label":"A"},{"label":"B"}]}"#), .done(.toolCalls)],
            [.textDelta("Great, A it is."), .done(.endTurn)],
        ])
        let collector = EventCollector()
        let eng = engine(provider, broker: broker)

        let turn = Task {
            await eng.runTurn(session: ScriptedLocalSession(), userText: "help me choose", model: "m",
                              tools: toolset(), emit: collector.callback)
        }
        // Answer the moment the question is asked.
        try? await TestGate.poll { collector.types.contains("question_asked") }
        await broker.answer(id: "q1", text: "A")
        await turn.value

        XCTAssertEqual(collector.types, ["user_message", "turn_started", "tool_call", "question_asked",
                                         "question_resolved", "tool_result", "assistant_delta",
                                         "assistant_message", "turn_completed"])
        guard case .questionAsked(let asked) = collector.events[3] else { return XCTFail() }
        XCTAssertEqual(asked.callId, "q1")
        XCTAssertEqual(asked.questions.first?.question, "Which?")
        XCTAssertNil(asked.questions.first?.header, "chat's simplified card has no header chip")
        XCTAssertEqual(asked.questions.first?.multiSelect, false)
        XCTAssertEqual(asked.questions.first?.options.map { $0.label }, ["A", "B"])
        guard case .questionResolved(let resolved) = collector.events[4] else { return XCTFail() }
        XCTAssertEqual(resolved.answers, ["Which?": "A"])
        XCTAssertEqual(resolved.by, "user")
        guard case .toolResult(let result) = collector.events[5] else { return XCTFail() }
        XCTAssertEqual(result.output, "User answered: A")
        guard case .turnCompleted(let done) = collector.events.last else { return XCTFail() }
        XCTAssertEqual(done.stopReason, "end_turn")
    }

    func testQuestionTimeoutTellsModelToProceed() async {
        let provider = ScriptedChatProvider([
            [.toolCall(callId: "q1", name: "AskQuestion",
                       argumentsJSON: #"{"question":"Which?","options":[{"label":"A"},{"label":"B"}]}"#), .done(.toolCalls)],
            [.textDelta("Proceeding."), .done(.endTurn)],
        ])
        let collector = EventCollector()
        await engine(provider).runTurn(session: ScriptedLocalSession(), userText: "x", model: "m",
                                       tools: toolset(askTimeout: .milliseconds(20)), emit: collector.callback)
        guard case .questionResolved(let resolved) = collector.events[4] else { return XCTFail() }
        XCTAssertEqual(resolved.by, "timeout")
        guard case .toolResult(let result) = collector.events[5] else { return XCTFail() }
        XCTAssertTrue(result.output.contains("No answer within"))
    }

    // MARK: - token counts across rounds

    func testTokenCountsAccumulateAcrossRounds() async {
        let searchHTTP = ScriptedChatHTTP([.json(["results": []])])
        let provider = ScriptedChatProvider([
            [.toolCall(callId: "c1", name: "Search", argumentsJSON: #"{"query":"x"}"#), .usage(inputTokens: 10, outputTokens: 5), .done(.toolCalls)],
            [.textDelta("done"), .usage(inputTokens: 3, outputTokens: 2), .done(.endTurn)],
        ])
        let collector = EventCollector()
        await engine(provider).runTurn(session: ScriptedLocalSession(), userText: "x", model: "m",
                                       tools: toolset(http: searchHTTP, exaKey: "k"), emit: collector.callback)
        guard case .turnCompleted(let done) = collector.events.last else { return XCTFail() }
        XCTAssertEqual(done.inputTokens, 13)
        XCTAssertEqual(done.outputTokens, 7)
    }

    // MARK: - reasoning: appended to the log, fed back, NEVER surfaced

    func testReasoningItemsAppendedAndFedBackButNeverEmitted() async {
        let searchHTTP = ScriptedChatHTTP([.json(["results": []])])
        let provider = ScriptedChatProvider([
            [.reasoningItem(itemJSON: #"{"type":"reasoning","encrypted_content":"SECRET"}"#),
             .toolCall(callId: "c1", name: "Search", argumentsJSON: #"{"query":"x"}"#), .done(.toolCalls)],
            [.textDelta("answer"), .done(.endTurn)],
        ])
        let collector = EventCollector()
        let session = ScriptedLocalSession()
        await engine(provider).runTurn(session: session, userText: "x", model: "m",
                                       tools: toolset(http: searchHTTP, exaKey: "k"), emit: collector.callback)

        // Never surfaced: no emitted event carries the opaque payload.
        XCTAssertFalse(collector.events.contains { encodedContains($0, "SECRET") },
                       "encrypted reasoning must never be surfaced through emit")
        // Its only sink is the session log.
        XCTAssertEqual(session.reasoningAppends.count, 1)
        XCTAssertTrue(session.reasoningAppends[0].itemJSON.contains("SECRET"))
        // Fed back to the provider for continuity on the next round.
        XCTAssertTrue(provider.request(1).input.contains {
            if case .reasoning(let j) = $0 { return j.contains("SECRET") } else { return false }
        })
    }

    // MARK: - error + fail-closed bare finish

    func testProviderErrorEmitsAgentErrorThenTurnCompletedError() async {
        let provider = ScriptedChatProvider([[.error(ProviderError(code: .server, message: "backend fell over"))]])
        let collector = EventCollector()
        await engine(provider).runTurn(session: ScriptedLocalSession(), userText: "x", model: "m",
                                       tools: toolset(), emit: collector.callback)
        XCTAssertEqual(collector.types, ["user_message", "turn_started", "agent_error", "turn_completed"])
        guard case .agentError(let err) = collector.events[2] else { return XCTFail() }
        XCTAssertEqual(err.message, "backend fell over")
        guard case .turnCompleted(let done) = collector.events.last else { return XCTFail() }
        XCTAssertEqual(done.stopReason, "error")
    }

    func testBareProviderFinishIsFailClosed() async {
        // A provider that finishes with no done/error and no abort → "stream ended unexpectedly".
        let provider = ScriptedChatProvider([[]])
        let collector = EventCollector()
        await engine(provider).runTurn(session: ScriptedLocalSession(), userText: "x", model: "m",
                                       tools: toolset(), emit: collector.callback)
        XCTAssertEqual(collector.types, ["user_message", "turn_started", "agent_error", "turn_completed"])
        guard case .agentError(let err) = collector.events[2] else { return XCTFail() }
        XCTAssertTrue(err.message.contains("ended unexpectedly"))
        guard case .turnCompleted(let done) = collector.events.last else { return XCTFail() }
        XCTAssertEqual(done.stopReason, "error")
    }

    // MARK: - interrupt / external cancellation

    func testInterruptMidStreamClosesWithAborted() async {
        let provider = HangingProvider(prefix: [.textDelta("thinking")])
        let collector = EventCollector()
        let eng = engine(provider)
        let turn = Task {
            await eng.runTurn(session: ScriptedLocalSession(), userText: "x", model: "m",
                              tools: toolset(), emit: collector.callback)
        }
        try? await TestGate.poll { provider.streaming.isOpen }
        eng.interrupt()
        await turn.value

        guard case .turnCompleted(let done) = collector.events.last else { return XCTFail("last: \(collector.types)") }
        XCTAssertEqual(done.stopReason, "aborted", "an interrupted turn closes on aborted")
        // The log ends on a COMPLETE event line — the last emitted event is a full turn_completed.
        XCTAssertEqual(collector.types.last, "turn_completed")
    }

    func testExternalCancellationClosesWithAborted() async {
        let provider = HangingProvider(prefix: [.textDelta("thinking")])
        let collector = EventCollector()
        let eng = engine(provider)
        let turn = Task {
            await eng.runTurn(session: ScriptedLocalSession(), userText: "x", model: "m",
                              tools: toolset(), emit: collector.callback)
        }
        try? await TestGate.poll { provider.streaming.isOpen }
        turn.cancel()
        await turn.value
        guard case .turnCompleted(let done) = collector.events.last else { return XCTFail() }
        XCTAssertEqual(done.stopReason, "aborted")
    }

    // MARK: - THE FIXTURE PROOF (spec §Component 1): the two engines share ONE event dialect

    func testEveryTsFixtureRoundTripsThroughNormaProtocolCoders() throws {
        let urls = EventFixtures.urls()
        XCTAssertGreaterThanOrEqual(urls.count, 40, "expected the TS-generated event fixtures — run `pnpm protocol:generate`")
        let decoder = JSONDecoder()
        let encoder = JSONEncoder()
        for url in urls {
            let data = try Data(contentsOf: url)
            let decoded = try decoder.decode(SessionEvent.self, from: data)
            let redecoded = try decoder.decode(SessionEvent.self, from: encoder.encode(decoded))
            XCTAssertEqual(decoded, redecoded, "round-trip mismatch for \(url.lastPathComponent)")
        }
    }

    func testEngineEmittedEventsAreValidInTheSharedDialect() async throws {
        // Run turns that emit every renderable variant the engine produces, then prove each one
        // survives an encode→decode through the SAME NormaProtocol coders the daemon's events use.
        let searchHTTP = ScriptedChatHTTP([.json(["results": [["title": "T", "url": "https://ex.com", "text": "x"]]])])
        let broker = QuestionBroker()
        let provider = ScriptedChatProvider([
            [.toolCall(callId: "c1", name: "Search", argumentsJSON: #"{"query":"x"}"#), .done(.toolCalls)],
            [.toolCall(callId: "q1", name: "AskQuestion",
                       argumentsJSON: #"{"question":"Which?","options":[{"label":"A"},{"label":"B"}]}"#), .done(.toolCalls)],
            [.textDelta("Done."), .usage(inputTokens: 4, outputTokens: 2), .done(.endTurn)],
        ])
        let collector = EventCollector()
        let eng = engine(provider, broker: broker)
        let turn = Task {
            await eng.runTurn(session: ScriptedLocalSession(), userText: "hello", model: "m",
                              tools: toolset(http: searchHTTP, exaKey: "k"), emit: collector.callback)
        }
        try? await TestGate.poll { collector.types.contains("question_asked") }
        await broker.answer(id: "q1", text: "A")
        await turn.value

        // Cover-all: user_message, turn_started, tool_call, tool_result, question_asked,
        // question_resolved, assistant_delta, assistant_message, turn_completed all emitted here.
        let seen = Set(collector.types)
        for expected in ["user_message", "turn_started", "tool_call", "tool_result", "question_asked",
                         "question_resolved", "assistant_delta", "assistant_message", "turn_completed"] {
            XCTAssertTrue(seen.contains(expected), "the cover-all turn should emit \(expected)")
        }
        let encoder = JSONEncoder()
        let decoder = JSONDecoder()
        for event in collector.events {
            let reencoded = try encoder.encode(event)
            let redecoded = try decoder.decode(SessionEvent.self, from: reencoded)
            XCTAssertEqual(event, redecoded, "engine event \(event.typeName) did not round-trip")
            // The type discriminator survives — the phone speaks the same wire dialect.
            let obj = try JSONSerialization.jsonObject(with: reencoded) as? [String: Any]
            XCTAssertNotNil(obj?["type"] as? String)
        }
    }

    // MARK: - continuation across turns

    func testNextTurnContinuesFromHeadSeq() async {
        let provider = ScriptedChatProvider([[.textDelta("ok"), .done(.endTurn)]])
        let collector = EventCollector()
        // A session whose log already has 10 events → this turn's user_message is seq 11.
        await engine(provider).runTurn(session: ScriptedLocalSession(lastSeq: 10), userText: "x", model: "m",
                                       tools: toolset(), emit: collector.callback)
        guard case .userMessage(let msg) = collector.events.first else { return XCTFail() }
        XCTAssertEqual(msg.seq, 11)
        guard case .turnCompleted(let done) = collector.events.last else { return XCTFail() }
        XCTAssertEqual(done.seq, 14) // user(11) turn_started(12) assistant(13) turn_completed(14)
    }
}

// MARK: - assertion helpers

private func eventSessionId(_ event: SessionEvent) -> String? {
    guard let data = try? JSONEncoder().encode(event),
          let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
    return obj["sessionId"] as? String
}

/// True if the event, once encoded through the protocol coders, contains `needle` anywhere — the
/// check that proves an opaque payload never leaked into a surfaced event.
private func encodedContains(_ event: SessionEvent, _ needle: String) -> Bool {
    guard let data = try? JSONEncoder().encode(event) else { return false }
    return String(decoding: data, as: UTF8.self).contains(needle)
}
