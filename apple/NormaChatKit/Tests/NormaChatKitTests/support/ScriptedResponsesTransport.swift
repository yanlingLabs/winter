import Foundation
@testable import NormaChatKit

/// The ONLY `/responses` transport any ResponsesClient/ChatEngine test speaks to. Hands back scripted
/// SSE responses in order and records every request verbatim (the `httpBody` survives because nothing
/// here goes near URLSession). A test that reaches the network is a bug in the test.
final class ScriptedResponsesTransport: ResponsesTransport, @unchecked Sendable {
    enum Step {
        /// A complete SSE response: status, headers, and the raw SSE text delivered as `chunks`
        /// (each an already-`\n\n`-terminated frame, or an arbitrary byte split to prove the parser
        /// reassembles across chunk boundaries).
        case sse(status: Int, headers: [String: String], chunks: [String])
        /// A transport-layer throw (URLSession-style) — drives the `.error(network)` mapping.
        case failure(Error)
        /// Streams `chunks`, then holds the body open until the CONSUMING task is cancelled, then
        /// finishes on a bare end (no `done`). Drives the interrupt / research-deadline path.
        case streamThenHang(status: Int, chunks: [String])
    }

    private let lock = NSLock()
    private var steps: [Step]
    private(set) var requests: [URLRequest] = []
    /// Signals (per step index) that a `streamThenHang` body actually started streaming — a test waits
    /// on it before interrupting, so the interrupt lands mid-stream, not before the request went out.
    let streaming = TestGate()

    init(_ steps: [Step]) { self.steps = steps }

    func send(_ request: URLRequest) async throws -> ResponsesHead {
        let step: Step = lock.withLock {
            requests.append(request)
            return steps.isEmpty ? .failure(ScriptedTransportMisuse.noStepsLeft) : steps.removeFirst()
        }
        switch step {
        case .failure(let error):
            throw error
        case .sse(let status, let headers, let chunks):
            let stream = AsyncThrowingStream<Data, Error> { continuation in
                for chunk in chunks { continuation.yield(Data(chunk.utf8)) }
                continuation.finish()
            }
            return ResponsesHead(statusCode: status, headers: headers, body: stream)
        case .streamThenHang(let status, let chunks):
            let gate = streaming
            let stream = AsyncThrowingStream<Data, Error> { continuation in
                let task = Task {
                    for chunk in chunks { continuation.yield(Data(chunk.utf8)) }
                    gate.open()
                    do { try await Task.sleep(for: .seconds(3600)) } catch {}
                    continuation.finish() // cancelled → bare finish (no done)
                }
                continuation.onTermination = { _ in task.cancel() }
            }
            return ResponsesHead(statusCode: status, headers: [:], body: stream)
        }
    }

    var requestCount: Int { lock.withLock { requests.count } }
    func request(_ index: Int) -> URLRequest { lock.withLock { requests[index] } }
    func bodyObject(_ index: Int = 0) -> [String: Any]? {
        guard let data = lock.withLock({ requests[index].httpBody }) else { return nil }
        return try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    }
    func authorization(_ index: Int = 0) -> String? {
        lock.withLock { requests[index].value(forHTTPHeaderField: "authorization") }
    }
}

enum ScriptedTransportMisuse: Error, Equatable { case noStepsLeft }

/// A transport-layer failure (URLSession-style) distinct from an HTTP error status.
struct FakeResponsesTransportError: Error, Equatable {}

// MARK: - SSE frame builders (the exact `/responses` wire shapes, from responses-sse.ts)

enum SSE {
    /// One `data: <json>\n\n` frame.
    static func frame(_ object: [String: Any]) -> String {
        let json = String(decoding: (try? JSONSerialization.data(withJSONObject: object)) ?? Data(), as: UTF8.self)
        return "data: \(json)\n\n"
    }

    static func textDelta(_ delta: String) -> String {
        frame(["type": "response.output_text.delta", "delta": delta])
    }

    static func toolCall(callId: String, name: String, arguments: String) -> String {
        frame(["type": "response.output_item.done",
               "item": ["type": "function_call", "call_id": callId, "name": name, "arguments": arguments]])
    }

    /// A reasoning item carrying encrypted_content (the replayable shape) plus id/status that must be
    /// stripped on capture.
    static func reasoningItem(encrypted: String, id: String = "rs_1", status: String = "completed",
                              extra: [String: Any] = [:]) -> String {
        var item: [String: Any] = ["type": "reasoning", "encrypted_content": encrypted, "id": id, "status": status]
        for (k, v) in extra { item[k] = v }
        return frame(["type": "response.output_item.done", "item": item])
    }

    static func completed(inputTokens: Int? = nil, outputTokens: Int? = nil) -> String {
        var response: [String: Any] = [:]
        if let inputTokens, let outputTokens {
            response["usage"] = ["input_tokens": inputTokens, "output_tokens": outputTokens]
        }
        return frame(["type": "response.completed", "response": response])
    }

    static func failed(_ message: String) -> String {
        frame(["type": "response.failed", "response": ["error": ["message": message]]])
    }
}
