import Foundation

/// Any JSON value. The shell keeps a request's `params` in this form so it can read the bookkeeping keys it
/// cares about (`sessionId`, `callId`) and still hand the engine the exact object to decode into its own
/// `<Name>Params` struct.
public enum JSONValue: Codable, Equatable, Sendable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let b = try? c.decode(Bool.self) { self = .bool(b) }
        else if let n = try? c.decode(Double.self) { self = .number(n) }
        else if let s = try? c.decode(String.self) { self = .string(s) }
        else if let a = try? c.decode([JSONValue].self) { self = .array(a) }
        else { self = .object(try c.decode([String: JSONValue].self)) }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .null: try c.encodeNil()
        case .bool(let b): try c.encode(b)
        case .number(let n): try c.encode(n)
        case .string(let s): try c.encode(s)
        case .array(let a): try c.encode(a)
        case .object(let o): try c.encode(o)
        }
    }

    public subscript(key: String) -> JSONValue? {
        if case .object(let o) = self { return o[key] }
        return nil
    }

    public var stringValue: String? {
        if case .string(let s) = self { return s }
        return nil
    }

    public var objectValue: [String: JSONValue]? {
        if case .object(let o) = self { return o }
        return nil
    }

    /// Any `Encodable` as a `JSONValue` (round-trips through `JSONEncoder`).
    public static func from<T: Encodable>(_ value: T) throws -> JSONValue {
        try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(value))
    }

    /// This value decoded as `T` — how a request's params reach the engine's `<Name>Params`.
    public func decode<T: Decodable>(_ type: T.Type) throws -> T {
        try JSONDecoder().decode(T.self, from: JSONEncoder().encode(self))
    }
}

/// A type-erased `Encodable`, so one handler table can return every method's own result type.
public struct AnyEncodable: Encodable {
    private let encodeValue: (Encoder) throws -> Void

    public init<T: Encodable>(_ value: T) {
        encodeValue = { try value.encode(to: $0) }
    }

    public func encode(to encoder: Encoder) throws {
        try encodeValue(encoder)
    }
}

/// An empty JSON object, `{}` — the result of the lifecycle methods the shell answers itself.
public struct EmptyResult: Codable, Equatable, Sendable {
    public init() {}
}
