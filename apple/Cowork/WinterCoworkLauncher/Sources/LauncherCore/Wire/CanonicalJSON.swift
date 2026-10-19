import Foundation

/*
 * Canonical JSON, the way the contract spells it (docs/cowork-native-worker.md, section 3): UTF-8, one line, no whitespace,
 * integers only, keys in the schema's order, the escapes of ECMAScript's JSON.stringify and nothing else. Foundation's
 * JSONEncoder cannot be used: it reorders keys and escapes "/".
 *
 * Parsing builds a tree that remembers member ORDER, refuses what no canonical text contains, and the caller then builds
 * the typed value and re-serializes it; the result must equal the input byte for byte. That one comparison is what refuses
 * reordered keys, alternate escapes and alternate number spellings (`strictLine` does it generically first, exactly where
 * protocol.ts does, so the failure codes come out in the same order).
 */

public struct JSONMember: Equatable, Sendable {
    public let key: String
    public let value: JSONValue
    public init(_ key: String, _ value: JSONValue) { self.key = key; self.value = value }
}

public indirect enum JSONValue: Equatable, Sendable {
    case object([JSONMember])
    case array([JSONValue])
    case string(String)
    case integer(Int64)
    case bool(Bool)
    case null
}

private let dangerousKeys: Set<String> = ["__proto__", "constructor", "prototype"]

struct StrictJSONParser {
    private let bytes: [UInt8]
    private var index = 0
    private let maxDepth: Int

    init(bytes: [UInt8], maxDepth: Int) { self.bytes = bytes; self.maxDepth = maxDepth }

    static func parse(_ bytes: [UInt8], maxDepth: Int) throws -> JSONValue {
        var parser = StrictJSONParser(bytes: bytes, maxDepth: maxDepth)
        let value = try parser.value(depth: 0)
        guard parser.index == bytes.count else { throw WireFailure.malformed }
        return value
    }

    private func peek() throws -> UInt8 {
        guard index < bytes.count else { throw WireFailure.malformed }
        return bytes[index]
    }
    private mutating func expect(_ byte: UInt8) throws {
        guard try peek() == byte else { throw WireFailure.malformed }
        index += 1
    }
    private mutating func literal(_ text: StaticString) throws {
        let count = text.utf8CodeUnitCount
        guard index + count <= bytes.count else { throw WireFailure.malformed }
        let matches = text.withUTF8Buffer { buffer in (0..<count).allSatisfy { buffer[$0] == bytes[index + $0] } }
        guard matches else { throw WireFailure.malformed }
        index += count
    }

    private mutating func value(depth: Int) throws -> JSONValue {
        switch try peek() {
        case UInt8(ascii: "{"):
            guard depth + 1 <= maxDepth else { throw WireFailure.malformed }
            index += 1
            var members: [JSONMember] = []
            var seen = Set<String>()
            if try peek() == UInt8(ascii: "}") { index += 1; return .object(members) }
            while true {
                let key = try string()
                // A duplicate key makes JSON.stringify(JSON.parse(text)) differ from the text: malformed, as in protocol.ts.
                guard seen.insert(key).inserted, !dangerousKeys.contains(key) else { throw WireFailure.malformed }
                try expect(UInt8(ascii: ":"))
                members.append(JSONMember(key, try value(depth: depth + 1)))
                let next = try peek(); index += 1
                if next == UInt8(ascii: "}") { return .object(members) }
                guard next == UInt8(ascii: ",") else { throw WireFailure.malformed }
            }
        case UInt8(ascii: "["):
            guard depth + 1 <= maxDepth else { throw WireFailure.malformed }
            index += 1
            var elements: [JSONValue] = []
            if try peek() == UInt8(ascii: "]") { index += 1; return .array(elements) }
            while true {
                elements.append(try value(depth: depth + 1))
                let next = try peek(); index += 1
                if next == UInt8(ascii: "]") { return .array(elements) }
                guard next == UInt8(ascii: ",") else { throw WireFailure.malformed }
            }
        case UInt8(ascii: "\""): return .string(try string())
        case UInt8(ascii: "t"): try literal("true"); return .bool(true)
        case UInt8(ascii: "f"): try literal("false"); return .bool(false)
        case UInt8(ascii: "n"): try literal("null"); return .null
        case UInt8(ascii: "-"), UInt8(ascii: "0")...UInt8(ascii: "9"): return .integer(try integer())
        default: throw WireFailure.malformed // whitespace anywhere outside a string lands here too
        }
    }

    /// `-?(0|[1-9][0-9]*)` and nothing after it that makes it a float. "-0" and anything past 2^53 do not survive
    /// JSON.stringify(JSON.parse(x)) unchanged, so they are malformed. (2^53 itself round-trips in ECMAScript and is then refused by the
    /// field validators, which is why the cut is one past the largest safe integer: the same `bad_field` the vectors expect.)
    private mutating func integer() throws -> Int64 {
        var negative = false
        if try peek() == UInt8(ascii: "-") { negative = true; index += 1 }
        guard index < bytes.count, (UInt8(ascii: "0")...UInt8(ascii: "9")).contains(bytes[index]) else { throw WireFailure.malformed }
        if bytes[index] == UInt8(ascii: "0") {
            index += 1
            guard !negative else { throw WireFailure.malformed }
            if index < bytes.count, (UInt8(ascii: "0")...UInt8(ascii: "9")).contains(bytes[index]) { throw WireFailure.malformed }
        } else {
            var accumulated: Int64 = 0
            while index < bytes.count, (UInt8(ascii: "0")...UInt8(ascii: "9")).contains(bytes[index]) {
                let (product, overflow1) = accumulated.multipliedReportingOverflow(by: 10)
                let (sum, overflow2) = product.addingReportingOverflow(Int64(bytes[index] - UInt8(ascii: "0")))
                guard !overflow1, !overflow2, sum <= WireLimits.maxSafeInteger + 1 else { throw WireFailure.malformed }
                accumulated = sum; index += 1
            }
            if index < bytes.count, [UInt8(ascii: "."), UInt8(ascii: "e"), UInt8(ascii: "E")].contains(bytes[index]) { throw WireFailure.malformed }
            return negative ? -accumulated : accumulated
        }
        if index < bytes.count, [UInt8(ascii: "."), UInt8(ascii: "e"), UInt8(ascii: "E")].contains(bytes[index]) { throw WireFailure.malformed }
        return 0
    }

    private mutating func string() throws -> String {
        try expect(UInt8(ascii: "\""))
        var raw: [UInt8] = []
        while true {
            let byte = try peek(); index += 1
            switch byte {
            case UInt8(ascii: "\""):
                // The whole line was checked to be UTF-8 before parsing, so these bytes are too (escapes are ASCII).
                guard let text = String(validating: raw, as: UTF8.self) else { throw WireFailure.malformed }
                return text
            case 0x00..<0x20: throw WireFailure.malformed
            case UInt8(ascii: "\\"):
                let escape = try peek(); index += 1
                switch escape {
                case UInt8(ascii: "\""): raw.append(UInt8(ascii: "\""))
                case UInt8(ascii: "\\"): raw.append(UInt8(ascii: "\\"))
                case UInt8(ascii: "/"): raw.append(UInt8(ascii: "/"))
                case UInt8(ascii: "b"): raw.append(0x08)
                case UInt8(ascii: "f"): raw.append(0x0c)
                case UInt8(ascii: "n"): raw.append(0x0a)
                case UInt8(ascii: "r"): raw.append(0x0d)
                case UInt8(ascii: "t"): raw.append(0x09)
                case UInt8(ascii: "u"):
                    let unit = try hex4()
                    var scalarValue = UInt32(unit)
                    if (0xD800...0xDBFF).contains(unit) {
                        // A high surrogate must be followed by an escaped low one; a lone surrogate is not well-formed text.
                        guard try peek() == UInt8(ascii: "\\") else { throw WireFailure.malformed }
                        index += 1
                        try expect(UInt8(ascii: "u"))
                        let low = try hex4()
                        guard (0xDC00...0xDFFF).contains(low) else { throw WireFailure.malformed }
                        scalarValue = 0x10000 + ((UInt32(unit) - 0xD800) << 10) + (UInt32(low) - 0xDC00)
                    } else if (0xDC00...0xDFFF).contains(unit) { throw WireFailure.malformed }
                    guard let scalar = Unicode.Scalar(scalarValue) else { throw WireFailure.malformed }
                    raw.append(contentsOf: Array(String(Character(scalar)).utf8))
                default: throw WireFailure.malformed
                }
            default: raw.append(byte)
            }
        }
    }
    private mutating func hex4() throws -> UInt16 {
        guard index + 4 <= bytes.count else { throw WireFailure.malformed }
        var value: UInt16 = 0
        for _ in 0..<4 {
            let byte = bytes[index]; index += 1
            let digit: UInt16
            switch byte {
            case UInt8(ascii: "0")...UInt8(ascii: "9"): digit = UInt16(byte - UInt8(ascii: "0"))
            case UInt8(ascii: "a")...UInt8(ascii: "f"): digit = UInt16(byte - UInt8(ascii: "a")) + 10
            case UInt8(ascii: "A")...UInt8(ascii: "F"): digit = UInt16(byte - UInt8(ascii: "A")) + 10
            default: throw WireFailure.malformed
            }
            value = value << 4 | digit
        }
        return value
    }
}

/// Writes canonical JSON: no whitespace, keys exactly where the caller puts them, JSON.stringify's string escapes.
public struct JSONWriter {
    public private(set) var bytes: [UInt8] = []
    private var needsComma: [Bool] = []
    public init() {}

    private mutating func separate() {
        if let last = needsComma.last, last { bytes.append(UInt8(ascii: ",")) }
        if !needsComma.isEmpty { needsComma[needsComma.count - 1] = true }
    }
    public mutating func beginObject() { separate(); bytes.append(UInt8(ascii: "{")); needsComma.append(false) }
    public mutating func endObject() { needsComma.removeLast(); bytes.append(UInt8(ascii: "}")) }
    public mutating func beginArray() { separate(); bytes.append(UInt8(ascii: "[")); needsComma.append(false) }
    public mutating func endArray() { needsComma.removeLast(); bytes.append(UInt8(ascii: "]")) }
    /// A member name; the next call writes its value.
    public mutating func key(_ name: String) {
        separate(); writeString(name); bytes.append(UInt8(ascii: ":"))
        needsComma[needsComma.count - 1] = false
    }
    public mutating func string(_ text: String) { separate(); writeString(text) }
    public mutating func integer(_ value: Int64) { separate(); bytes.append(contentsOf: Array(String(value).utf8)) }
    public mutating func integer(_ value: Int) { integer(Int64(value)) }
    public mutating func integer(_ value: UInt64) { separate(); bytes.append(contentsOf: Array(String(value).utf8)) }
    public mutating func bool(_ value: Bool) { separate(); bytes.append(contentsOf: Array((value ? "true" : "false").utf8)) }
    public mutating func null() { separate(); bytes.append(contentsOf: Array("null".utf8)) }

    private mutating func writeString(_ text: String) {
        bytes.append(UInt8(ascii: "\""))
        for scalar in text.unicodeScalars {
            switch scalar.value {
            case 0x22: bytes.append(contentsOf: [0x5c, 0x22])
            case 0x5c: bytes.append(contentsOf: [0x5c, 0x5c])
            case 0x08: bytes.append(contentsOf: [0x5c, UInt8(ascii: "b")])
            case 0x0c: bytes.append(contentsOf: [0x5c, UInt8(ascii: "f")])
            case 0x0a: bytes.append(contentsOf: [0x5c, UInt8(ascii: "n")])
            case 0x0d: bytes.append(contentsOf: [0x5c, UInt8(ascii: "r")])
            case 0x09: bytes.append(contentsOf: [0x5c, UInt8(ascii: "t")])
            case 0x00..<0x20:
                let hex = String(scalar.value, radix: 16)
                bytes.append(contentsOf: Array(("\\u" + String(repeating: "0", count: 4 - hex.count) + hex).utf8))
            default: bytes.append(contentsOf: Array(String(Character(scalar)).utf8))
            }
        }
        bytes.append(UInt8(ascii: "\""))
    }

    /// The canonical text of a parsed tree, member order preserved: JSON.stringify(parsed).
    public static func canonical(_ value: JSONValue) -> [UInt8] {
        var writer = JSONWriter()
        writer.write(value)
        return writer.bytes
    }
    public mutating func write(_ value: JSONValue) {
        switch value {
        case .object(let members):
            beginObject()
            for member in members { key(member.key); write(member.value) }
            endObject()
        case .array(let elements):
            beginArray()
            for element in elements { write(element) }
            endArray()
        case .string(let text): string(text)
        case .integer(let number): integer(number)
        case .bool(let flag): bool(flag)
        case .null: null()
        }
    }
}

/// One bounded canonical line to its parsed members (`strictLine` in protocol.ts). The caller still owns key sets and values.
/// Order of refusals: oversize, then an unterminated or ill-formed text, then the parse, then the generic canonical compare.
func strictLine(_ raw: [UInt8], maxBytes: Int, depth: Int) throws -> (body: [UInt8], members: [JSONMember]) {
    guard raw.count <= maxBytes else { throw WireFailure.oversize }
    guard raw.last == 0x0a, String(validating: raw, as: UTF8.self) != nil else { throw WireFailure.malformed }
    let body = Array(raw.dropLast())
    guard case .object(let members) = try StrictJSONParser.parse(body, maxDepth: depth) else { throw WireFailure.malformed }
    guard JSONWriter.canonical(.object(members)) == body else { throw WireFailure.malformed }
    return (body, members)
}
