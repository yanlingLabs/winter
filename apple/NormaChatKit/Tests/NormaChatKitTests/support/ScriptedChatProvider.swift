import Foundation
@testable import NormaChatKit

/// The ONLY model any research test ever speaks to. Returns a pre-scripted event list per
/// `streamTurn` call (one list per round) and records every `ProviderTurnRequest` verbatim, so a
/// test can assert on the model chosen, the reasoning effort, the tool list (the structural
/// FetchPage-only check), and the exact input items the loop built. No test hits the network or a
/// real model — `ChatProvider` is the seam and this double is its only test implementation.
final class ScriptedChatProvider: ChatProvider, @unchecked Sendable {
    private let lock = NSLock()
    private var rounds: [[ProviderEvent]]
    private(set) var requests: [ProviderTurnRequest] = []

    /// `rounds[i]` is the event list the i-th `streamTurn` call yields (then finishes). A call past
    /// the end of the script yields an empty, immediately-finished stream — the "stream ended
    /// unexpectedly" shape.
    init(_ rounds: [[ProviderEvent]]) { self.rounds = rounds }

    func streamTurn(_ request: ProviderTurnRequest) -> AsyncStream<ProviderEvent> {
        let events: [ProviderEvent] = lock.withLock {
            requests.append(request)
            return rounds.isEmpty ? [] : rounds.removeFirst()
        }
        return AsyncStream { continuation in
            for event in events { continuation.yield(event) }
            continuation.finish()
        }
    }

    var requestCount: Int { lock.withLock { requests.count } }
    func request(_ index: Int) -> ProviderTurnRequest { lock.withLock { requests[index] } }
}

extension ProviderTurnRequest {
    /// The concatenated text of every `message` input item — a convenient assertion surface for
    /// "the seed message reached the request".
    var messageText: String {
        input.compactMap { if case .message(_, let content) = $0 { return content } else { return nil } }.joined(separator: "\n")
    }

    /// The output of the first `tool_result` input item, if any — how a test inspects what a
    /// FetchPage batch fed back to the model.
    var firstToolResultOutput: String? {
        for item in input { if case .toolResult(_, let output, _) = item { return output } }
        return nil
    }
}

/// Builds a FetchPage tool-call event with a JSON `urls` array.
func fetchPageCall(_ callId: String, _ urls: [String]) -> ProviderEvent {
    let json = (try? JSONSerialization.data(withJSONObject: ["urls": urls])).map { String(decoding: $0, as: UTF8.self) } ?? "{}"
    return .toolCall(callId: callId, name: ResearchRunner.fetchPageToolName, argumentsJSON: json)
}
