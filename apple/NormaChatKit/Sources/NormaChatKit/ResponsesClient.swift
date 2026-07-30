import Foundation

/// The phone's model client — a faithful Swift port of the daemon's `/responses` leg
/// (`packages/core/src/providers/{codex-oauth,openai-compatible,responses-sse}.ts`). It speaks the
/// SAME endpoint, builds the SAME request body, parses the SAME SSE dialect, and passes encrypted
/// reasoning through opaquely. It conforms to Task 7's `ChatProvider` seam, so `ChatEngine` and the
/// research runner both drive it — and every test drives a SCRIPTED transport, never the network.
///
/// TWO auth carry-forwards from the T5 review live here (see `TokenSource`):
///   - refresh is SINGLE-FLIGHT (an actor dedupes concurrent refreshes to one POST — a value-type
///     `TokenState` refreshed twice at the 60s margin would burn the rotating refresh token and get
///     the whole family revoked, hard-signing the phone out mid-conversation);
///   - the reactive refresh-once-on-401 stays the authority path, exactly as `codex-oauth.ts` does.

// MARK: - SSE transport seam

/// The `/responses` streaming seam — deliberately SEPARATE from `ChatHTTP`. SSE needs an INCREMENTAL
/// body (live token deltas), which `ChatHTTP.send` can't give (it buffers whole) and `sendCapped`
/// can't either (one hop, non-following, capped); and the reactive-401 refresh needs the status code
/// BEFORE the body is consumed. A scripted conformer is the only one any test constructs.
public protocol ResponsesTransport: Sendable {
    /// POSTs `request` and returns the response head (status + headers) plus an incremental body
    /// stream of raw SSE bytes. Cancelling the awaiting task must tear the underlying transfer down.
    func send(_ request: URLRequest) async throws -> ResponsesHead
}

/// One `/responses` response: the status/headers, then the SSE body as a chunk stream. The body is
/// pulled only on the 2xx path (mirroring `codex-oauth.ts`, which reads the stream only when `res.ok`
/// — a non-2xx has its small error body read once for the snippet, never streamed).
public struct ResponsesHead: Sendable {
    public let statusCode: Int
    public let headers: [String: String]
    public let body: AsyncThrowingStream<Data, Error>

    public init(statusCode: Int, headers: [String: String], body: AsyncThrowingStream<Data, Error>) {
        self.statusCode = statusCode
        self.headers = headers
        self.body = body
    }
}

/// The production transport. `URLSession.bytes(for:)` yields the response head first, then the body
/// bytes — exactly the ordering the reactive-401 refresh needs. Bytes are re-chunked on newlines so
/// the SSE parser sees frame-shaped `Data` without a per-byte `AsyncStream` hop per element.
public struct URLSessionResponsesTransport: ResponsesTransport {
    private let session: URLSession

    public init(session: URLSession = .shared) {
        self.session = session
    }

    public func send(_ request: URLRequest) async throws -> ResponsesHead {
        let (bytes, response) = try await session.bytes(for: request)
        guard let http = response as? HTTPURLResponse else {
            bytes.task.cancel()
            throw ChatHTTPError.nonHTTPResponse
        }
        var headers: [String: String] = [:]
        for (k, v) in http.allHeaderFields {
            if let ks = k as? String, let vs = v as? String { headers[ks] = vs }
        }
        let stream = AsyncThrowingStream<Data, Error> { continuation in
            let task = Task {
                var buffer = Data()
                do {
                    for try await byte in bytes {
                        buffer.append(byte)
                        if byte == 0x0A { // flush on newline — keeps SSE frames intact, batches bytes
                            continuation.yield(buffer)
                            buffer.removeAll(keepingCapacity: true)
                        }
                    }
                    if !buffer.isEmpty { continuation.yield(buffer) }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel(); bytes.task.cancel() }
        }
        return ResponsesHead(statusCode: http.statusCode, headers: headers, body: stream)
    }
}

// MARK: - single-flight token source

/// Serializes ALL token refreshes through an actor so concurrent turns produce EXACTLY ONE refresh
/// POST (T5 review I1). Actor isolation alone is NOT enough — a refresh suspends on `await`, and a
/// second turn can slip in at that suspension point and start its own POST (actor reentrancy). The
/// fix is an in-flight `Task` that later callers JOIN instead of starting their own: it is installed
/// synchronously (before the first `await`), so any reentrant caller sees it and awaits the same
/// result. One POST, one rotation, no revoked family.
public actor TokenSource {
    private var state: TokenState
    private let http: any ChatHTTP
    private let config: CodexConfig
    private let now: @Sendable () -> Date
    private let margin: TimeInterval
    /// Called with each freshly-merged `TokenState` so the caller can persist the rotation (the
    /// phone writes it to the Keychain, mirroring `codex-oauth.ts`'s `authStore.save`). Absent → no
    /// persistence (tests observe via `current`).
    private let persist: (@Sendable (TokenState) -> Void)?
    private var inFlight: Task<TokenState, Error>?

    public init(state: TokenState, http: any ChatHTTP, config: CodexConfig = .codex,
                margin: TimeInterval = TokenState.refreshMargin,
                now: @escaping @Sendable () -> Date = { Date() },
                persist: (@Sendable (TokenState) -> Void)? = nil) {
        self.state = state
        self.http = http
        self.config = config
        self.margin = margin
        self.now = now
        self.persist = persist
    }

    public var current: TokenState { state }
    public var hasRefreshToken: Bool { state.refreshToken != nil }

    /// Proactive: refresh if within the 60s margin, else return the current token. BEST-EFFORT — a
    /// failed proactive refresh is swallowed and the (possibly stale) token is returned, because the
    /// reactive 401 path remains the authority (a Mac has no proactive margin at all).
    public func credentials() async -> (accessToken: String, accountId: String?) {
        if state.needsRefresh(now: now(), margin: margin), let fresh = try? await refresh(force: false) {
            return (fresh.accessToken, fresh.accountId)
        }
        return (state.accessToken, state.accountId)
    }

    /// Reactive (401): force a single refresh and return the fresh credentials. Throws on failure so
    /// the caller can surface `.error(auth)` — the daemon's "token refresh failed, run: norma login".
    public func refreshedCredentials() async throws -> (accessToken: String, accountId: String?) {
        let fresh = try await refresh(force: true)
        return (fresh.accessToken, fresh.accountId)
    }

    /// Returns the valid `TokenState` — freshly refreshed, or the current one if already fresh. The
    /// caller reads the token from the RETURN value, never by re-reading `state`: a joiner resumes
    /// from `inFlight.value` before the initiator writes `state`, so re-reading would hand back the
    /// pre-refresh token. Every caller (initiator OR joiner) gets the same fresh value here.
    private func refresh(force: Bool) async throws -> TokenState {
        if let inFlight { return try await inFlight.value } // join the in-flight refresh
        // A prior refresh may have already satisfied the proactive margin while we were scheduled.
        if !force, !state.needsRefresh(now: now(), margin: margin) { return state }
        guard state.refreshToken != nil else { throw CodexAuthError.missingRefreshToken }
        let base = state
        let http = self.http
        let config = self.config
        let now = self.now
        let task = Task { try await base.refreshed(http: http, config: config, now: now) }
        inFlight = task
        defer { inFlight = nil }
        let fresh = try await task.value
        state = fresh
        persist?(fresh)
        return fresh
    }
}

// MARK: - request body

/// Builds the `/responses` request body — the port of `openai-compatible.ts`'s
/// `buildRequestBody`/`mapInput`/`mapTools`. Uses `[String: Any]` + `JSONSerialization` because the
/// input array is heterogeneous (message / function_call / function_call_output / reasoning) and the
/// codex backend does not care about key order (unlike the auth endpoint, which IS byte-pinned).
enum ResponsesRequestBody {
    static func build(_ request: ProviderTurnRequest) throws -> Data {
        var body: [String: Any] = [
            "model": request.model,
            "instructions": request.instructions ?? "You are a helpful assistant.",
            "input": try mapInput(request.input),
            "tools": mapTools(request.tools),
            "tool_choice": "auto",
            "parallel_tool_calls": true,
            "store": false,
            "stream": true,
            // Codex parity: request encrypted reasoning state only when reasoning is configured, so
            // items stay replayable on later store:false requests. Effort unset → [] (byte-identical
            // to the pre-reasoning shape).
            "include": request.reasoningEffort != nil ? ["reasoning.encrypted_content"] : [],
        ]
        if let effort = request.reasoningEffort {
            body["reasoning"] = ["effort": effort]
        }
        return try JSONSerialization.data(withJSONObject: body)
    }

    static func mapInput(_ items: [ProviderInputItem]) throws -> [[String: Any]] {
        try items.map { item in
            switch item {
            case .message(let role, let content):
                // assistant → output_text, user/system → input_text (Responses API content schema).
                let contentType = role == .assistant ? "output_text" : "input_text"
                return ["type": "message", "role": role.rawValue,
                        "content": [["type": contentType, "text": content]]]
            case .functionCall(let callId, let name, let argumentsJSON):
                return ["type": "function_call", "call_id": callId, "name": name, "arguments": argumentsJSON]
            case .toolResult(let callId, let output, _):
                return ["type": "function_call_output", "call_id": callId, "output": output]
            case .reasoning(let itemJSON):
                // Opaque passthrough — the whole reasoning item is `JSON.parse`d back into the input
                // (mapInput's reasoning case). Never inspected, never rendered.
                guard let data = itemJSON.data(using: .utf8),
                      let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                    throw ResponsesClientError.malformedReasoningItem
                }
                return object
            }
        }
    }

    static func mapTools(_ tools: [ProviderToolSpec]) -> [[String: Any]] {
        tools.map { tool in
            let parameters = (tool.parametersJSON.data(using: .utf8)
                .flatMap { try? JSONSerialization.jsonObject(with: $0) }) ?? [String: Any]()
            return ["type": "function", "name": tool.name, "description": tool.description,
                    "parameters": parameters, "strict": false]
        }
    }
}

public enum ResponsesClientError: Error, Equatable {
    case malformedReasoningItem
}

// MARK: - SSE parser

/// Incremental SSE frame splitter + Responses-API event mapper — the line-for-line Swift port of
/// `responses-sse.ts`'s `ResponsesSseParser`. One instance per turn; `sawToolCall` accumulates across
/// the whole stream (so `done`'s stopReason is `tool_calls` iff any tool call was seen).
final class ResponsesSSEParser {
    private var buf = ""
    private var sawToolCall = false

    /// Feed a chunk of raw SSE bytes; returns any complete frames' mapped events.
    func push(_ chunk: Data) -> [ProviderEvent] {
        // Normalize AFTER appending so a `\r\n` split across two chunks still collapses correctly.
        buf = (buf + String(decoding: chunk, as: UTF8.self)).replacingOccurrences(of: "\r\n", with: "\n")
        var out: [ProviderEvent] = []
        while let range = buf.range(of: "\n\n") {
            let frame = String(buf[buf.startIndex..<range.lowerBound])
            buf = String(buf[range.upperBound...])
            out.append(contentsOf: mapFrame(frame))
        }
        return out
    }

    /// Flush at stream end — handles a final frame with no trailing blank line.
    func finish() -> [ProviderEvent] {
        let rest = buf.trimmingCharacters(in: .whitespacesAndNewlines)
        buf = ""
        return rest.isEmpty ? [] : mapFrame(rest)
    }

    private func mapFrame(_ frame: String) -> [ProviderEvent] {
        var dataLine = ""
        for line in frame.split(separator: "\n", omittingEmptySubsequences: false) where line.hasPrefix("data:") {
            dataLine += line.dropFirst(5).trimmingCharacters(in: .whitespaces)
        }
        if dataLine.isEmpty || dataLine == "[DONE]" { return [] }
        guard let data = dataLine.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = json["type"] as? String else { return [] } // tolerate junk frames
        switch type {
        case "response.output_text.delta":
            return [.textDelta(stringValue(json["delta"]))]
        case "response.output_item.done":
            guard let item = json["item"] as? [String: Any], let itemType = item["type"] as? String else { return [] }
            // whole-branch #2: capture ONLY reasoning items carrying a non-empty encrypted_content
            // (the replayable ones); a summary-only reasoning item has nothing to replay.
            if itemType == "reasoning", let enc = item["encrypted_content"] as? String, !enc.isEmpty {
                // Codex parity: strip `id` (always cleared under store:false) and `status` (never
                // echoed back). encrypted_content is preserved VERBATIM — opaque, never logged.
                var stripped = item
                stripped.removeValue(forKey: "id")
                stripped.removeValue(forKey: "status")
                guard let json = try? JSONSerialization.data(withJSONObject: stripped) else { return [] }
                return [.reasoningItem(itemJSON: String(decoding: json, as: UTF8.self))]
            }
            if itemType == "function_call" {
                sawToolCall = true
                return [.toolCall(callId: stringValue(item["call_id"]),
                                  name: stringValue(item["name"]),
                                  argumentsJSON: stringValue(item["arguments"]))]
            }
            return []
        case "response.completed":
            var out: [ProviderEvent] = []
            if let response = json["response"] as? [String: Any], let usage = response["usage"] as? [String: Any] {
                out.append(.usage(inputTokens: intValue(usage["input_tokens"]),
                                  outputTokens: intValue(usage["output_tokens"])))
            }
            out.append(.done(sawToolCall ? .toolCalls : .endTurn))
            return out
        case "response.failed":
            let message = ((json["response"] as? [String: Any])?["error"] as? [String: Any])?["message"] as? String
            return [.error(ProviderError(code: .server, message: message ?? "response.failed"))]
        default:
            return [] // forward-compat: ignore unknown event types (incl. argument deltas)
        }
    }

    private func stringValue(_ any: Any?) -> String {
        if let s = any as? String { return s }
        if let n = any as? NSNumber { return n.stringValue }
        return ""
    }

    private func intValue(_ any: Any?) -> Int { (any as? NSNumber)?.intValue ?? 0 }
}

// MARK: - HTTP error mapping

/// The port of `openai-compatible.ts`'s `mapHttpError`: status → provider error code, with a bounded
/// body snippet and the 429 `Retry-After` (seconds only; an HTTP-date form is ignored, matching the
/// TS's `NaN` guard). The request body (which carries the bearer token) is NEVER in the snippet — the
/// snippet comes only from the RESPONSE body.
func mapResponsesHttpError(status: Int, retryAfter: String?, snippet: String) -> ProviderEvent {
    let suffix = snippet.isEmpty ? "" : " — \(snippet)"
    if status == 401 || status == 403 {
        return .error(ProviderError(code: .auth, message: "HTTP \(status)\(suffix)"))
    }
    if status == 429 {
        let secs = retryAfter.flatMap { Double($0) }
        let retryMs = (secs.map { $0 > 0 ? Int(($0 * 1000).rounded()) : nil } ?? nil)
        return .error(ProviderError(code: .rateLimit, message: "HTTP 429\(suffix)", retryAfterMs: retryMs))
    }
    if status >= 400 && status < 500 {
        return .error(ProviderError(code: .badRequest, message: "HTTP \(status)\(suffix)"))
    }
    return .error(ProviderError(code: .server, message: "HTTP \(status)\(suffix)"))
}

// MARK: - the client

public struct ResponsesClient: ChatProvider {
    private let transport: any ResponsesTransport
    private let tokens: TokenSource
    private let config: CodexConfig
    /// Ceiling on the error-snippet body we buffer from a non-2xx response — the snippet is capped at
    /// 200 chars anyway; this only bounds a hostile giant error body.
    private static let maxErrorBodyBytes = 64 * 1024

    public init(transport: any ResponsesTransport, tokens: TokenSource, config: CodexConfig = .codex) {
        self.transport = transport
        self.tokens = tokens
        self.config = config
    }

    /// A fresh stream per call. Errors arrive as `.error` events; the stream NEVER throws (Task 7's
    /// `ChatProvider` contract). T7 concern-2: EVERY transport failure maps to `.error`, and task
    /// cancellation ENDS the stream on a bare finish (no fake `done`) — the fail-closed shape a
    /// consumer reads as "stream ended unexpectedly". A bare finish is therefore reachable ONLY by
    /// cancellation; a truncated/failed transfer yields `.error(network)` first.
    public func streamTurn(_ request: ProviderTurnRequest) -> AsyncStream<ProviderEvent> {
        AsyncStream { continuation in
            let task = Task {
                do {
                    try await run(request) { continuation.yield($0) }
                } catch is CancellationError {
                    // bare finish — the consumer's deadline/interrupt cancelled us
                } catch {
                    if Task.isCancelled {
                        // A transport error surfaced BECAUSE we were cancelled (e.g. URLError.cancelled)
                        // — treat as cancellation, not a network failure. Bare finish.
                    } else {
                        continuation.yield(.error(ProviderError(code: .network, message: transportMessage(error))))
                    }
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    private func run(_ request: ProviderTurnRequest, yield: (ProviderEvent) -> Void) async throws {
        let body = try ResponsesRequestBody.build(request)

        var creds = await tokens.credentials()
        var head = try await transport.send(config.responsesRequest(
            accessToken: creds.accessToken, accountId: creds.accountId, body: body))

        if head.statusCode == 401, await tokens.hasRefreshToken {
            // Reactive refresh-once-on-401 — the authority path (codex-oauth.ts). Drain the stale
            // 401 body so its transfer is torn down before we retry.
            for try await _ in head.body { break }
            do {
                creds = try await tokens.refreshedCredentials()
            } catch {
                yield(.error(ProviderError(code: .auth, message: "HTTP 401 — token refresh failed, sign in again")))
                return
            }
            head = try await transport.send(config.responsesRequest(
                accessToken: creds.accessToken, accountId: creds.accountId, body: body))
        }

        guard (200 ..< 300).contains(head.statusCode) else {
            let snippet = await readSnippet(head.body)
            yield(mapResponsesHttpError(status: head.statusCode,
                                        retryAfter: head.headers["Retry-After"] ?? head.headers["retry-after"],
                                        snippet: snippet))
            return
        }

        let parser = ResponsesSSEParser()
        for try await chunk in head.body {
            try Task.checkCancellation()
            for event in parser.push(chunk) { yield(event) }
        }
        for event in parser.finish() { yield(event) }
    }

    /// Reads a bounded, char-capped snippet off a non-2xx body for the error message. Tolerant: a
    /// throwing/short body just yields what it has. Capped at 200 chars, like the TS's `.slice(0, 200)`.
    private func readSnippet(_ body: AsyncThrowingStream<Data, Error>) async -> String {
        var data = Data()
        do {
            for try await chunk in body {
                data.append(chunk)
                if data.count >= Self.maxErrorBodyBytes { break }
            }
        } catch {
            // partial snippet is fine
        }
        return String(decoding: data.prefix(Self.maxErrorBodyBytes), as: UTF8.self)
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .prefix(200).description
    }

    /// A bounded, header-free description of a transport error for `.error(network)`. URLSession's
    /// `URLError` describes the failure (timeout, cannot-connect) without ever echoing the request's
    /// bearer header, but we still cap it hard.
    private func transportMessage(_ error: Error) -> String {
        if let urlError = error as? URLError { return "network error: \(urlError.code.rawValue)" }
        return "network error"
    }
}
