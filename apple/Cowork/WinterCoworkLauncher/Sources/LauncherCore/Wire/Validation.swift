import Foundation

/// The validators of protocol.ts, as functions of a parsed JSON value. Anything wrong is `bad_field`.
enum V {
    private static func isAlnum(_ b: UInt8) -> Bool {
        (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a)
    }
    /// `[A-Za-z0-9][A-Za-z0-9_-]{0,62}`
    static func isToken(_ text: String) -> Bool {
        let b = Array(text.utf8)
        guard (1...WireLimits.tokenChars).contains(b.count), isAlnum(b[0]) else { return false }
        return b.dropFirst().allSatisfy { isAlnum($0) || $0 == 0x5f || $0 == 0x2d }
    }
    /// `[A-Za-z0-9][A-Za-z0-9._:-]{0,62}`
    static func isLabel(_ text: String) -> Bool {
        let b = Array(text.utf8)
        guard (1...WireLimits.tokenChars).contains(b.count), isAlnum(b[0]) else { return false }
        return b.dropFirst().allSatisfy { isAlnum($0) || $0 == 0x5f || $0 == 0x2d || $0 == 0x2e || $0 == 0x3a }
    }
    static func isLowerHex(_ text: String, count: Int) -> Bool {
        let b = Array(text.utf8)
        return b.count == count && b.allSatisfy { ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x61 && $0 <= 0x66) }
    }
    /// `^(0|[1-9][0-9]{0,19})$` that fits an unsigned 64 bit integer.
    static func isDecimal64(_ text: String) -> Bool {
        let b = Array(text.utf8)
        guard (1...20).contains(b.count), b.allSatisfy({ $0 >= 0x30 && $0 <= 0x39 }) else { return false }
        if b.count > 1 && b[0] == 0x30 { return false }
        return UInt64(text) != nil
    }

    static func token(_ v: JSONValue) throws -> String { guard case .string(let s) = v, isToken(s) else { throw WireFailure.bad_field }; return s }
    static func label(_ v: JSONValue) throws -> String { guard case .string(let s) = v, isLabel(s) else { throw WireFailure.bad_field }; return s }
    static func digest(_ v: JSONValue) throws -> String { guard case .string(let s) = v, isLowerHex(s, count: 64) else { throw WireFailure.bad_field }; return s }
    static func nonce(_ v: JSONValue) throws -> String { guard case .string(let s) = v, isLowerHex(s, count: 32) else { throw WireFailure.bad_field }; return s }
    static func decimal64(_ v: JSONValue) throws -> String { guard case .string(let s) = v, isDecimal64(s) else { throw WireFailure.bad_field }; return s }
    static func bool(_ v: JSONValue) throws -> Bool { guard case .bool(let b) = v else { throw WireFailure.bad_field }; return b }
    static func uint(_ v: JSONValue, _ lo: Int64 = 0, _ hi: Int64 = WireLimits.maxSafeInteger) throws -> Int64 {
        guard case .integer(let n) = v, n >= lo, n <= hi else { throw WireFailure.bad_field }
        return n
    }
    /// The canonical padded base64 of exactly 32 bytes (44 characters): the only spelling of a receipt MAC.
    static func isCanonicalMac(_ s: String) -> Bool {
        Data(base64Encoded: s).map { $0.count == 32 && $0.base64EncodedString() == s } == true
    }
    static func macText(_ v: JSONValue) throws -> String { guard case .string(let s) = v, isCanonicalMac(s) else { throw WireFailure.bad_field }; return s }
    static func literal(_ v: JSONValue, _ expected: String) throws { guard case .string(let s) = v, s == expected else { throw WireFailure.bad_field } }
    static func literal(_ v: JSONValue, _ expected: Int64) throws { guard case .integer(let n) = v, n == expected else { throw WireFailure.bad_field } }
    static func literal(_ v: JSONValue, _ expected: Bool) throws { guard case .bool(let b) = v, b == expected else { throw WireFailure.bad_field } }
    static func oneOf(_ v: JSONValue, _ allowed: [String]) throws -> String {
        guard case .string(let s) = v, allowed.contains(s) else { throw WireFailure.bad_field }
        return s
    }
    static func epoch(_ v: JSONValue) throws -> Int { Int(try uint(v, 1, 0xffff_ffff)) }
    /// The capacity of a volume image: 16 MiB to 256 GiB, a multiple of 4096.
    static func capacity(_ v: JSONValue) throws -> UInt64 {
        let n = try uint(v, 16 * 1024 * 1024, 256 * 1024 * 1024 * 1024)
        guard n % 4096 == 0 else { throw WireFailure.bad_field }
        return UInt64(n)
    }
    static func object(_ v: JSONValue) throws -> [JSONMember] { guard case .object(let m) = v else { throw WireFailure.bad_field }; return m }
    static func array(_ v: JSONValue) throws -> [JSONValue] { guard case .array(let a) = v else { throw WireFailure.bad_field }; return a }
}

/// An object whose key SET is exactly the schema's (order is checked by the final re-serialization), with lookups by name.
struct Fields {
    private let table: [String: JSONValue]
    init(_ members: [JSONMember], keys: [String]) throws {
        guard members.count == keys.count else { throw WireFailure.bad_field }
        var table: [String: JSONValue] = [:]
        for member in members { table[member.key] = member.value }
        guard table.count == members.count, keys.allSatisfy({ table[$0] != nil }) else { throw WireFailure.bad_field }
        self.table = table
    }
    subscript(_ key: String) -> JSONValue { table[key]! }
}
