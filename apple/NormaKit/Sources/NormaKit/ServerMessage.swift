import Foundation
import NormaProtocol

public struct RpcError: Error, Equatable, Sendable {
    public let code: Int
    public let message: String
    /// The JSON-RPC envelope's OPTIONAL `error.data` — a structured payload a handler attaches so a
    /// client can branch programmatically instead of string-matching `message`.
    ///
    /// Chat Slice D whole-branch review, Critical WB-C1: this field used not to exist, and the
    /// gateway (the ONLY route a phone has to the daemon) therefore relayed every error as
    /// `{code, message}`. The one consumer that keys on it — `sync.push`'s `ERR.DIVERGED` (-32006),
    /// whose `data.lastSeq` is the branch point the phone's fork/re-push logic reads — saw the
    /// field vanish somewhere between two layers that each tested their own half correctly, so on
    /// the real wire divergence recovery could never run. Kept generic (`JSONValue?`) rather than
    /// DIVERGED-specific: this is the JSON-RPC envelope's own field, and the relay must forward
    /// whatever a handler put there, including from a NEWER daemon this kit knows nothing about.
    /// Defaulted in the initializer, so every existing construction site is unchanged.
    public let data: JSONValue?
    public init(code: Int, message: String, data: JSONValue? = nil) {
        self.code = code
        self.message = message
        self.data = data
    }
}

public enum ServerMessage: Sendable {
    case response(id: Int, result: Result<JSONValue, RpcError>)
    case event(SessionEvent)
    /// A well-formed "event" notification whose params failed SessionEvent decoding — a newer
    /// daemon's event type. Never a crash, never silently dropped (spec §4.2 forward-compat).
    case unknownEvent(raw: String)
    case unrecognized(raw: String)
}

private struct InboundLine: Decodable {
    struct ErrorPayload: Decodable { let code: Int; let message: String; let data: JSONValue? }
    let id: Int?
    let result: JSONValue?
    let error: ErrorPayload?
    let method: String?
    let params: JSONValue?
}

/// Route one NDJSON line from the daemon. Total: never throws — malformed input degrades to
/// `.unrecognized`, a decodable-envelope-but-unknown event to `.unknownEvent`.
public func parseServerLine(_ line: String) -> ServerMessage {
    guard let data = line.data(using: .utf8),
          let inbound = try? JSONDecoder().decode(InboundLine.self, from: data) else {
        return .unrecognized(raw: line)
    }
    if let id = inbound.id {
        if let err = inbound.error { return .response(id: id, result: .failure(RpcError(code: err.code, message: err.message, data: err.data))) }
        return .response(id: id, result: .success(inbound.result ?? .null))
    }
    if inbound.method == "event", let params = inbound.params {
        // Re-encode the params subtree and decode strictly via NormaProtocol (fail-loud there,
        // wrapped here). Double decode is fine at NDJSON line rates.
        if let paramsData = try? JSONEncoder().encode(params),
           let event = try? JSONDecoder().decode(SessionEvent.self, from: paramsData) {
            return .event(event)
        }
        return .unknownEvent(raw: line)
    }
    return .unrecognized(raw: line)
}
