import Foundation
import XCTest
@testable import NormaChatKit

/// `ResponsesClient` — the phone's `/responses` leg. Every test drives a SCRIPTED transport (SSE) and,
/// where a refresh is involved, a `ScriptedChatHTTP`; none touches the network or a real model.
final class ResponsesClientTests: XCTestCase {
    private let t0 = Date(timeIntervalSince1970: 1_700_000_000)
    private let config = AuthFixture.testConfig

    private func freshTokens(_ http: ChatHTTP) -> TokenSource {
        let clock = t0
        return TokenSource(state: TokenState(accessToken: "at_1", refreshToken: "rt_1", accountId: "acct_1",
                                             expiresAt: clock.addingTimeInterval(3600)),
                           http: http, config: config, now: { clock })
    }

    private func collect(_ stream: AsyncStream<ProviderEvent>) async -> [ProviderEvent] {
        var out: [ProviderEvent] = []
        for await event in stream { out.append(event) }
        return out
    }

    private func request(_ input: [ProviderInputItem] = [.message(role: .user, content: "hi")],
                         tools: [ProviderToolSpec] = [], effort: String? = nil) -> ProviderTurnRequest {
        ProviderTurnRequest(model: "gpt-5.4", instructions: "sys", input: input, tools: tools, reasoningEffort: effort)
    }

    // MARK: - request body (buildRequestBody port)

    func testRequestBodyMatchesResponsesShape() async {
        let transport = ScriptedResponsesTransport([.sse(status: 200, headers: [:], chunks: [SSE.completed()])])
        let client = ResponsesClient(transport: transport, tokens: freshTokens(ScriptedChatHTTP()), config: config)
        let tool = ProviderToolSpec(name: "Search", description: "d", parametersJSON: #"{"type":"object","properties":{"query":{"type":"string"}}}"#)
        _ = await collect(client.streamTurn(request(
            [.message(role: .user, content: "hi"),
             .reasoning(itemJSON: #"{"type":"reasoning","encrypted_content":"enc"}"#)],
            tools: [tool], effort: "low")))

        let body = transport.bodyObject()
        XCTAssertEqual(body?["model"] as? String, "gpt-5.4")
        XCTAssertEqual(body?["instructions"] as? String, "sys")
        XCTAssertEqual(body?["tool_choice"] as? String, "auto")
        XCTAssertEqual(body?["parallel_tool_calls"] as? Bool, true)
        XCTAssertEqual(body?["store"] as? Bool, false)
        XCTAssertEqual(body?["stream"] as? Bool, true)
        XCTAssertEqual(body?["include"] as? [String], ["reasoning.encrypted_content"])
        XCTAssertEqual((body?["reasoning"] as? [String: Any])?["effort"] as? String, "low")

        let input = body?["input"] as? [[String: Any]]
        XCTAssertEqual(input?.count, 2)
        XCTAssertEqual(input?[0]["type"] as? String, "message")
        XCTAssertEqual(input?[0]["role"] as? String, "user")
        XCTAssertEqual(((input?[0]["content"] as? [[String: Any]])?.first?["type"]) as? String, "input_text")
        // The reasoning item is spread back VERBATIM (parsed object), never wrapped.
        XCTAssertEqual(input?[1]["type"] as? String, "reasoning")
        XCTAssertEqual(input?[1]["encrypted_content"] as? String, "enc")

        let tools = body?["tools"] as? [[String: Any]]
        XCTAssertEqual(tools?.first?["name"] as? String, "Search")
        XCTAssertEqual(tools?.first?["type"] as? String, "function")
        XCTAssertEqual(tools?.first?["strict"] as? Bool, false)
    }

    func testNoReasoningEffortOmitsReasoningAndSendsEmptyInclude() async {
        let transport = ScriptedResponsesTransport([.sse(status: 200, headers: [:], chunks: [SSE.completed()])])
        let client = ResponsesClient(transport: transport, tokens: freshTokens(ScriptedChatHTTP()), config: config)
        _ = await collect(client.streamTurn(request(effort: nil)))
        let body = transport.bodyObject()
        XCTAssertNil(body?["reasoning"])
        XCTAssertEqual(body?["include"] as? [String], [])
    }

    func testRequestCarriesBearerAndAccountHeader() async {
        let transport = ScriptedResponsesTransport([.sse(status: 200, headers: [:], chunks: [SSE.completed()])])
        let client = ResponsesClient(transport: transport, tokens: freshTokens(ScriptedChatHTTP()), config: config)
        _ = await collect(client.streamTurn(request()))
        XCTAssertEqual(transport.authorization(), "Bearer at_1")
        XCTAssertEqual(transport.request(0).value(forHTTPHeaderField: "chatgpt-account-id"), "acct_1")
        XCTAssertEqual(transport.request(0).value(forHTTPHeaderField: "originator"), "norma")
    }

    // MARK: - SSE parsing (streaming order + shapes)

    func testStreamsDeltasThenToolCallThenUsageThenDone() async {
        let transport = ScriptedResponsesTransport([.sse(status: 200, headers: [:], chunks: [
            SSE.textDelta("Hel"), SSE.textDelta("lo"),
            SSE.toolCall(callId: "c1", name: "Search", arguments: #"{"query":"x"}"#),
            SSE.completed(inputTokens: 12, outputTokens: 7),
        ])])
        let client = ResponsesClient(transport: transport, tokens: freshTokens(ScriptedChatHTTP()), config: config)
        let events = await collect(client.streamTurn(request()))

        guard case .textDelta("Hel") = events[0], case .textDelta("lo") = events[1] else {
            return XCTFail("deltas out of order: \(events)")
        }
        guard case .toolCall(let id, let name, let args) = events[2] else { return XCTFail() }
        XCTAssertEqual([id, name, args], ["c1", "Search", #"{"query":"x"}"#])
        guard case .usage(12, 7) = events[3] else { return XCTFail("usage \(events[3])") }
        // sawToolCall → done(tool_calls)
        guard case .done(.toolCalls) = events[4] else { return XCTFail("stop \(events[4])") }
    }

    func testNoToolCallEndsWithEndTurn() async {
        let transport = ScriptedResponsesTransport([.sse(status: 200, headers: [:], chunks: [
            SSE.textDelta("done"), SSE.completed(inputTokens: 3, outputTokens: 4),
        ])])
        let client = ResponsesClient(transport: transport, tokens: freshTokens(ScriptedChatHTTP()), config: config)
        let events = await collect(client.streamTurn(request()))
        guard case .done(.endTurn) = events.last else { return XCTFail("expected end_turn, got \(events)") }
    }

    func testReasoningItemStripsIdAndStatusAndPreservesEncrypted() async {
        let transport = ScriptedResponsesTransport([.sse(status: 200, headers: [:], chunks: [
            SSE.reasoningItem(encrypted: "OPAQUE", id: "rs_9", status: "completed"),
            SSE.completed(),
        ])])
        let client = ResponsesClient(transport: transport, tokens: freshTokens(ScriptedChatHTTP()), config: config)
        let events = await collect(client.streamTurn(request()))
        guard case .reasoningItem(let itemJSON) = events.first else { return XCTFail("expected reasoning, got \(events)") }
        let obj = try? JSONSerialization.jsonObject(with: Data(itemJSON.utf8)) as? [String: Any]
        XCTAssertEqual(obj?["encrypted_content"] as? String, "OPAQUE")
        XCTAssertNil(obj?["id"], "id must be stripped under store:false")
        XCTAssertNil(obj?["status"], "status is never echoed back")
    }

    func testSummaryOnlyReasoningItemIsDropped() async {
        // No encrypted_content → nothing replayable → not captured (responses-sse.ts whole-branch #2).
        let transport = ScriptedResponsesTransport([.sse(status: 200, headers: [:], chunks: [
            SSE.frame(["type": "response.output_item.done", "item": ["type": "reasoning", "summary": "…"]]),
            SSE.completed(),
        ])])
        let client = ResponsesClient(transport: transport, tokens: freshTokens(ScriptedChatHTTP()), config: config)
        let events = await collect(client.streamTurn(request()))
        XCTAssertFalse(events.contains { if case .reasoningItem = $0 { return true } else { return false } })
    }

    func testResponseFailedMapsToServerError() async {
        let transport = ScriptedResponsesTransport([.sse(status: 200, headers: [:], chunks: [SSE.failed("boom")])])
        let client = ResponsesClient(transport: transport, tokens: freshTokens(ScriptedChatHTTP()), config: config)
        let events = await collect(client.streamTurn(request()))
        guard case .error(let e) = events.first, e.code == .server else { return XCTFail("\(events)") }
        XCTAssertEqual(e.message, "boom")
    }

    func testParserReassemblesAcrossChunkBoundaries() async {
        // One SSE frame delivered split across three chunks (incl. a \r\n split) — the parser must
        // still surface exactly one delta.
        let transport = ScriptedResponsesTransport([.sse(status: 200, headers: [:], chunks: [
            "data: {\"type\":\"response.output_text.delta\",\"del", "ta\":\"AB\"}\r", "\n\r\n", SSE.completed(),
        ])])
        let client = ResponsesClient(transport: transport, tokens: freshTokens(ScriptedChatHTTP()), config: config)
        let events = await collect(client.streamTurn(request()))
        guard case .textDelta("AB") = events.first else { return XCTFail("\(events)") }
    }

    // MARK: - HTTP errors

    func testRateLimitMapsWithRetryAfter() async {
        let transport = ScriptedResponsesTransport([.sse(status: 429, headers: ["Retry-After": "2"], chunks: ["slow down"])])
        let client = ResponsesClient(transport: transport, tokens: freshTokens(ScriptedChatHTTP()), config: config)
        let events = await collect(client.streamTurn(request()))
        guard case .error(let e) = events.first, e.code == .rateLimit else { return XCTFail("\(events)") }
        XCTAssertEqual(e.retryAfterMs, 2000)
        XCTAssertTrue(e.message.contains("slow down"))
    }

    func testServerErrorMaps() async {
        let transport = ScriptedResponsesTransport([.sse(status: 503, headers: [:], chunks: ["upstream down"])])
        let client = ResponsesClient(transport: transport, tokens: freshTokens(ScriptedChatHTTP()), config: config)
        let events = await collect(client.streamTurn(request()))
        guard case .error(let e) = events.first, e.code == .server else { return XCTFail("\(events)") }
    }

    // MARK: - reactive 401 refresh (the authority path)

    func test401RefreshesOnceAndRetriesWithNewBearer() async {
        let http = ScriptedChatHTTP([.json(["access_token": "at_2", "expires_in": 3600])])
        let tokens = freshTokens(http)
        let transport = ScriptedResponsesTransport([
            .sse(status: 401, headers: [:], chunks: []),
            .sse(status: 200, headers: [:], chunks: [SSE.textDelta("ok"), SSE.completed()]),
        ])
        let client = ResponsesClient(transport: transport, tokens: tokens, config: config)
        let events = await collect(client.streamTurn(request()))

        XCTAssertEqual(http.requestCount, 1, "exactly one refresh POST")
        XCTAssertEqual(transport.requestCount, 2, "the request is retried once")
        XCTAssertEqual(transport.authorization(0), "Bearer at_1")
        XCTAssertEqual(transport.authorization(1), "Bearer at_2", "the retry carries the refreshed token")
        guard case .textDelta("ok") = events.first else { return XCTFail("\(events)") }
    }

    func test401RefreshFailureYieldsAuthError() async {
        let http = ScriptedChatHTTP([.text(#"{"error":"invalid_grant"}"#, status: 401)])
        let transport = ScriptedResponsesTransport([.sse(status: 401, headers: [:], chunks: [])])
        let client = ResponsesClient(transport: transport, tokens: freshTokens(http), config: config)
        let events = await collect(client.streamTurn(request()))
        guard case .error(let e) = events.first, e.code == .auth else { return XCTFail("\(events)") }
        XCTAssertFalse(e.message.contains("rt_1"), "the refresh token must never appear in the error")
    }

    // MARK: - T7 concern-2: transport failure → .error; cancellation → bare finish

    func testTransportFailureMapsToNetworkError() async {
        let transport = ScriptedResponsesTransport([.failure(FakeResponsesTransportError())])
        let client = ResponsesClient(transport: transport, tokens: freshTokens(ScriptedChatHTTP()), config: config)
        let events = await collect(client.streamTurn(request()))
        guard case .error(let e) = events.first, e.code == .network else { return XCTFail("\(events)") }
    }

    func testCancellationEndsStreamOnBareFinish() async {
        let transport = ScriptedResponsesTransport([.streamThenHang(status: 200, chunks: [SSE.textDelta("partial")])])
        let client = ResponsesClient(transport: transport, tokens: freshTokens(ScriptedChatHTTP()), config: config)

        let collected = EventBox()
        let consume = Task {
            for await event in client.streamTurn(request()) { collected.append(event) }
        }
        try? await TestGate.poll { self.transportStreaming(transport) }
        consume.cancel()
        _ = await consume.value

        let events = collected.values
        // The partial delta may or may not have been observed before cancel; the load-bearing claim
        // is that the stream ENDED (finite) with NO done and NO error — the fail-closed bare finish.
        XCTAssertFalse(events.contains { if case .done = $0 { return true } else { return false } },
                       "cancellation must not fabricate a done event")
        XCTAssertFalse(events.contains { if case .error = $0 { return true } else { return false } },
                       "cancellation is not a transport error")
    }

    private func transportStreaming(_ t: ScriptedResponsesTransport) -> Bool { t.streaming.isOpen }

    // MARK: - single-flight refresh (T5 review I1)

    func testConcurrentProactiveRefreshesProduceExactlyOnePost() async {
        // Two turns hit the 60s margin at once. Without single-flight both POST the same refresh
        // token → rotation+reuse-detection revokes the family. The actor must produce ONE POST.
        let http = ScriptedChatHTTP([.json(["access_token": "at_2", "expires_in": 3600])])
        let clock = t0
        // Expired token → needsRefresh true for both callers.
        let tokens = TokenSource(state: TokenState(accessToken: "at_1", refreshToken: "rt_1",
                                                   expiresAt: clock.addingTimeInterval(-10)),
                                 http: http, config: config, now: { clock })
        async let a = tokens.credentials()
        async let b = tokens.credentials()
        let (ca, cb) = await (a, b)
        XCTAssertEqual(http.requestCount, 1, "concurrent refreshes must collapse to ONE POST")
        XCTAssertEqual(ca.accessToken, "at_2")
        XCTAssertEqual(cb.accessToken, "at_2")
    }

    func testProactiveRefreshIsBestEffortAndDoesNotThrow() async {
        // A failed proactive refresh must NOT surface — the reactive 401 path is the authority, so the
        // (stale) token is returned and the request proceeds.
        let http = ScriptedChatHTTP([.text("nope", status: 500)])
        let clock = t0
        let tokens = TokenSource(state: TokenState(accessToken: "at_1", refreshToken: "rt_1",
                                                   expiresAt: clock.addingTimeInterval(-10)),
                                 http: http, config: config, now: { clock })
        let creds = await tokens.credentials()
        XCTAssertEqual(creds.accessToken, "at_1", "stale token returned; 401 path will refresh")
    }
}

/// Small thread-safe box for the cancellation test.
final class EventBox: @unchecked Sendable {
    private let lock = NSLock()
    private var storage: [ProviderEvent] = []
    func append(_ e: ProviderEvent) { lock.withLock { storage.append(e) } }
    var values: [ProviderEvent] { lock.withLock { storage } }
}
