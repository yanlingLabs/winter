import Foundation
import WinterCUCore

/// The helper RPC's wire: NDJSON (one JSON object per line), JSON-RPC 2.0.
public enum RPCWire {
    /// One request line is at most 1 MiB; a longer one closes the connection.
    public static let maxRequestLineBytes = 1 << 20
    /// One response line is at most 16 MiB (screenshots); a longer result is answered with an error instead.
    public static let maxResponseLineBytes = 16 << 20
    /// The only protocol version this helper speaks (`hello.protocol`) — apple/ComputerUse/PROTOCOL.md's
    /// "Protocol version" (scripts/computer-helper-lib.test.ts holds every client to it).
    public static let protocolVersion = 1
}

/// A typed failure on the wire: `error.data.code` is `code`, one of the helper RPC's codes (`protocol_mismatch`,
/// `home_mismatch`, `permission_missing`, `target_lost`, `stale_ref`, `needs_foreground`, `not_allowed`,
/// `refused`, `wait_timeout`, `cancelled`, `invalid_params`, `unsupported`, `busy`, `window_elsewhere`,
/// `no_window`). `data` carries the code's own fields (`permission`, `ref`, `reason`, `seen`, …). The full
/// vocabulary is apple/ComputerUse/PROTOCOL.md's "Errors".
public struct RPCError: Error, Equatable, Sendable {
    public var code: String
    public var message: String
    public var data: [String: JSONValue]

    public init(code: String, message: String, data: [String: JSONValue] = [:]) {
        self.code = code
        self.message = message
        self.data = data
    }

    public static func invalidParams(_ message: String) -> RPCError { RPCError(code: "invalid_params", message: message) }
    public static func unsupported(_ message: String) -> RPCError { RPCError(code: "unsupported", message: message) }
    public static func cancelled(_ message: String = "the call was cancelled") -> RPCError { RPCError(code: "cancelled", message: message) }
    public static func busy(_ message: String) -> RPCError { RPCError(code: "busy", message: message) }
    public static func protocolMismatch(_ message: String) -> RPCError { RPCError(code: "protocol_mismatch", message: message) }
    public static func homeMismatch(_ message: String) -> RPCError { RPCError(code: "home_mismatch", message: message) }

    /// The numeric JSON-RPC `error.code`. Clients branch on `error.data.code`; this is only the JSON-RPC
    /// courtesy: the standard codes where one fits, the server-error range otherwise.
    public var rpcCode: Int {
        switch code {
        case "invalid_params": return -32602
        case "unsupported": return -32601
        default: return -32000
        }
    }

    /// `busy` is retryable unless the thrower said otherwise; nothing else is unless it says so.
    public var wireData: [String: JSONValue] {
        var out = data
        out["code"] = .string(code)
        if out["retryable"] == nil, code == "busy" { out["retryable"] = .bool(true) }
        return out
    }

    /// Maps anything a handler threw onto the wire's error shape. Messages never quote request content: a
    /// typed-text argument must not come back in an error or reach a log.
    public static func from(_ error: Error) -> RPCError {
        switch error {
        case let e as RPCError:
            return e
        case let e as CUError:
            // Through its own Codable form, so only the pinned keys (`code`, `message`, `data`) are relied on.
            guard let json = try? JSONValue.from(e), let code = json["code"]?.stringValue else {
                return .unsupported("the automation engine failed without a code")
            }
            return RPCError(code: code, message: json["message"]?.stringValue ?? code, data: json["data"]?.objectValue ?? [:])
        case is CancellationError:
            return .cancelled()
        case let e as DecodingError:
            return .invalidParams(describe(e))
        default:
            // There is no generic "internal" code in the helper RPC; `unsupported` is the nearest honest one.
            return .unsupported("internal helper error (\(String(describing: type(of: error))))")
        }
    }

    private static func describe(_ error: DecodingError) -> String {
        func path(_ keys: [CodingKey]) -> String {
            let p = keys.map { $0.intValue.map { "[\($0)]" } ?? ".\($0.stringValue)" }.joined()
            return p.isEmpty ? "params" : "params\(p)"
        }
        switch error {
        case .keyNotFound(let key, let ctx): return "\(path(ctx.codingPath + [key])) is required"
        case .typeMismatch(_, let ctx): return "\(path(ctx.codingPath)) has the wrong type"
        case .valueNotFound(_, let ctx): return "\(path(ctx.codingPath)) must not be null"
        case .dataCorrupted(let ctx): return "\(path(ctx.codingPath)): \(ctx.debugDescription)"
        @unknown default: return "params are invalid"
        }
    }
}

/// One parsed inbound line.
public enum RPCInbound: Equatable {
    case request(id: JSONValue, method: String, params: JSONValue?)
    /// A line with no `id`. Notifications only travel helper → daemon, so the helper ignores one.
    case notification(method: String)
    /// Unparseable or not a request; answered with `id` (null when none could be read).
    case invalid(id: JSONValue, error: RPCError)

    public static func parse(_ line: Data) -> RPCInbound {
        guard let value = try? JSONDecoder().decode(JSONValue.self, from: line), case .object(let object) = value else {
            return .invalid(id: .null, error: RPCError(code: "invalid_params", message: "the line is not a JSON object"))
        }
        let id = object["id"]
        guard object["jsonrpc"] == .string("2.0") else {
            return .invalid(id: id ?? .null, error: .invalidParams("jsonrpc must be \"2.0\""))
        }
        guard let method = object["method"]?.stringValue, !method.isEmpty else {
            return .invalid(id: id ?? .null, error: .invalidParams("method is required"))
        }
        guard let id, id != .null else { return .notification(method: method) }
        switch id {
        case .string, .number: break
        default: return .invalid(id: .null, error: .invalidParams("id must be a string or a number"))
        }
        if let params = object["params"], params != .null, params.objectValue == nil {
            return .invalid(id: id, error: .invalidParams("params must be an object"))
        }
        return .request(id: id, method: method, params: object["params"])
    }
}

/// Outbound lines, each ending in `\n`.
public enum RPCOutbound {
    private struct Response: Encodable {
        let jsonrpc = "2.0"
        let id: JSONValue
        let result: AnyEncodable
    }

    private struct ErrorBody: Encodable {
        let code: Int
        let message: String
        let data: [String: JSONValue]
    }

    private struct ErrorResponse: Encodable {
        let jsonrpc = "2.0"
        let id: JSONValue
        let error: ErrorBody
    }

    private struct Notification: Encodable {
        let jsonrpc = "2.0"
        let method: String
        let params: AnyEncodable
    }

    private static func encode<T: Encodable>(_ value: T) throws -> Data {
        let encoder = JSONEncoder()
        // Base64 image payloads are full of `/`; escaping each one would only grow the line.
        encoder.outputFormatting = [.withoutEscapingSlashes]
        var data = try encoder.encode(value)
        data.append(0x0A)
        return data
    }

    /// A result line, or — when the result cannot be encoded or exceeds the 16 MiB line cap — an error line.
    public static func response(id: JSONValue, result: AnyEncodable) -> Data {
        do {
            let line = try encode(Response(id: id, result: result))
            if line.count > RPCWire.maxResponseLineBytes {
                return error(id: id, .invalidParams("the result is larger than the 16 MiB line cap — ask for a smaller image budget or region"))
            }
            return line
        } catch {
            return self.error(id: id, .unsupported("the result could not be encoded"))
        }
    }

    public static func error(id: JSONValue, _ error: RPCError) -> Data {
        let body = ErrorResponse(id: id, error: ErrorBody(code: error.rpcCode, message: error.message, data: error.wireData))
        // Every field is a plain JSON value; this cannot fail.
        return (try? encode(body)) ?? Data("{\"jsonrpc\":\"2.0\",\"id\":null,\"error\":{\"code\":-32000,\"message\":\"encode failed\",\"data\":{\"code\":\"unsupported\"}}}\n".utf8)
    }

    public static func notification(method: String, params: AnyEncodable) -> Data? {
        try? encode(Notification(method: method, params: params))
    }
}
