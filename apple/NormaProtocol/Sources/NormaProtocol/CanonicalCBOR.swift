import Foundation

/// A CBOR value restricted to the subset SP2b's pairing ceremony needs: unsigned integers, byte
/// strings, text strings, arrays, maps (text-string keys only), and booleans. Nothing else —
/// no floats, no negative integers, no tags, no `null`/`undefined`. See `CanonicalCBOR` for the
/// encoder/decoder that pairs with this type.
public enum CBORValue {
    case uint(UInt64)
    case bytes(Data)
    case text(String)
    case array([CBORValue])
    case map([(String, CBORValue)])
    case bool(Bool)
}

extension CBORValue: Equatable {
    public static func == (lhs: CBORValue, rhs: CBORValue) -> Bool {
        switch (lhs, rhs) {
        case (.uint(let a), .uint(let b)): return a == b
        case (.bytes(let a), .bytes(let b)): return a == b
        case (.text(let a), .text(let b)): return a == b
        case (.bool(let a), .bool(let b)): return a == b
        case (.array(let a), .array(let b)): return a == b
        case (.map(let a), .map(let b)):
            guard a.count == b.count else { return false }
            for (l, r) in zip(a, b) {
                guard l.0 == r.0, l.1 == r.1 else { return false }
            }
            return true
        default:
            return false
        }
    }
}

/// Errors thrown by `CanonicalCBOR.decode` when the input isn't canonical CBOR in this
/// package's restricted sense — either it uses a feature outside the supported subset
/// (`.unsupported`), it's syntactically valid CBOR but not in the RFC 8949 §4.2.1 core
/// deterministic encoding (`.nonCanonical` — non-shortest-form lengths, unsorted or duplicate
/// map keys), there are bytes left over after a complete value was decoded (`.trailingBytes`),
/// or nesting exceeds the decoder's depth cap (`.tooDeep`).
public enum CBORError: Error, Equatable {
    case unsupported
    case nonCanonical
    case trailingBytes
    case truncated
    case tooDeep
}

/// RFC 8949 §4.2.1 core deterministic ("canonical") CBOR encoding, restricted to the six
/// `CBORValue` cases. Canonical form means: definite lengths only, shortest-form length
/// encoding (no non-minimal integers), and map entries sorted bytewise ascending by their
/// *encoded* key bytes (header included, per the RFC) with no duplicates. For text keys the
/// header byte embeds the length, so shorter keys always sort before longer ones regardless of
/// content — e.g. "a" < "b" < "aa", and "z" < "aa". `encode` always produces this form;
/// `decode` rejects anything that isn't already in it, and additionally caps nesting depth at
/// `maxDepth` (matching the gateway's JSON depth cap) so a small blob of nested array heads
/// can't exhaust the recursion stack.
public enum CanonicalCBOR {

    /// Maximum nesting depth `decode` accepts — the top-level value is depth 1, each
    /// array/map level below it adds 1. Chosen to match `WireFrame`'s JSON `maxDepth` (32).
    public static let maxDepth = 32

    // MARK: - Encode

    public static func encode(_ v: CBORValue) -> Data {
        switch v {
        case .uint(let n):
            return encodeHead(majorType: 0, length: n)
        case .bytes(let d):
            var out = encodeHead(majorType: 2, length: UInt64(d.count))
            out.append(d)
            return out
        case .text(let s):
            let utf8 = Data(s.utf8)
            var out = encodeHead(majorType: 3, length: UInt64(utf8.count))
            out.append(utf8)
            return out
        case .array(let items):
            var out = encodeHead(majorType: 4, length: UInt64(items.count))
            for item in items {
                out.append(encode(item))
            }
            return out
        case .map(let entries):
            // RFC 8949 §4.2.1: sort bytewise-ascending on the ENCODED key bytes (header
            // included). For definite-length text keys the header byte embeds the length,
            // so this is length-first: "a" (61 61) < "b" (61 62) < "aa" (62 61 61), and
            // "z" (61 7A) < "aa" (62 61 61) even though 'z' > 'a' as content.
            precondition(
                Set(entries.map(\.0)).count == entries.count,
                "CanonicalCBOR.encode(map:): duplicate key"
            )
            let withEncodedKeys = entries.map { (encodedKey: encode(.text($0.0)), value: $0.1) }
            let sorted = withEncodedKeys.sorted { lhs, rhs in
                lexicographicallyLess(lhs.encodedKey, rhs.encodedKey)
            }
            var out = encodeHead(majorType: 5, length: UInt64(sorted.count))
            for entry in sorted {
                out.append(entry.encodedKey)
                out.append(encode(entry.value))
            }
            return out
        case .bool(let b):
            return Data([b ? 0xF5 : 0xF4])
        }
    }

    /// Encodes a major-type/length pair using RFC 8949's shortest-form rule: the length rides
    /// in the low 5 bits of the initial byte when it's < 24; otherwise an 8/16/32/64-bit
    /// big-endian length follows, using the smallest of those four widths that fits.
    private static func encodeHead(majorType: UInt8, length: UInt64) -> Data {
        let high = majorType << 5
        if length < 24 {
            return Data([high | UInt8(length)])
        } else if length <= UInt64(UInt8.max) {
            return Data([high | 24, UInt8(length)])
        } else if length <= UInt64(UInt16.max) {
            let v = UInt16(length)
            return Data([high | 25, UInt8(v >> 8), UInt8(v & 0xFF)])
        } else if length <= UInt64(UInt32.max) {
            let v = UInt32(length)
            return Data([
                high | 26,
                UInt8((v >> 24) & 0xFF), UInt8((v >> 16) & 0xFF),
                UInt8((v >> 8) & 0xFF), UInt8(v & 0xFF),
            ])
        } else {
            return Data([
                high | 27,
                UInt8((length >> 56) & 0xFF), UInt8((length >> 48) & 0xFF),
                UInt8((length >> 40) & 0xFF), UInt8((length >> 32) & 0xFF),
                UInt8((length >> 24) & 0xFF), UInt8((length >> 16) & 0xFF),
                UInt8((length >> 8) & 0xFF), UInt8(length & 0xFF),
            ])
        }
    }

    private static func lexicographicallyLess(_ a: Data, _ b: Data) -> Bool {
        var ai = a.startIndex
        var bi = b.startIndex
        while ai < a.endIndex && bi < b.endIndex {
            if a[ai] != b[bi] { return a[ai] < b[bi] }
            ai = a.index(after: ai)
            bi = b.index(after: bi)
        }
        return a.count < b.count
    }

    // MARK: - Decode

    public static func decode(_ d: Data) throws -> CBORValue {
        var cursor = Cursor(data: d)
        let value = try decodeValue(&cursor, depth: 1)
        guard cursor.offset == d.endIndex else { throw CBORError.trailingBytes }
        return value
    }

    /// A simple byte cursor over `Data`, tracking an absolute `Data.Index` so slicing works
    /// correctly regardless of the input `Data`'s own index origin.
    private struct Cursor {
        let data: Data
        var offset: Data.Index

        init(data: Data) {
            self.data = data
            self.offset = data.startIndex
        }

        mutating func nextByte() throws -> UInt8 {
            guard offset < data.endIndex else { throw CBORError.truncated }
            let b = data[offset]
            offset = data.index(after: offset)
            return b
        }

        mutating func nextBytes(_ n: Int) throws -> Data {
            guard let end = data.index(offset, offsetBy: n, limitedBy: data.endIndex) else {
                throw CBORError.truncated
            }
            let slice = data.subdata(in: offset..<end)
            offset = end
            return slice
        }
    }

    /// Converts a decoded CBOR length to `Int`, throwing rather than trapping if it doesn't
    /// fit. An 8-byte length field can claim up to `UInt64.max` — comfortably outside `Int`'s
    /// range on any real platform — and this decoder must reject a hostile length, never crash
    /// on one.
    private static func intLength(_ length: UInt64) throws -> Int {
        guard length <= UInt64(Int.max) else { throw CBORError.truncated }
        return Int(length)
    }

    /// Decodes one major-type/length pair, verifying shortest-form encoding along the way.
    /// Returns `(majorType, additionalInfo, length)` — `length` is meaningless for major type 7
    /// (simple/float), where `additionalInfo` carries the simple-value code instead.
    private static func decodeHead(_ c: inout Cursor) throws -> (major: UInt8, info: UInt8, length: UInt64) {
        let initial = try c.nextByte()
        let major = initial >> 5
        let info = initial & 0x1F

        switch info {
        case 0...23:
            return (major, info, UInt64(info))
        case 24:
            let b = try c.nextByte()
            guard b >= 24 else { throw CBORError.nonCanonical }
            return (major, info, UInt64(b))
        case 25:
            let bytes = try c.nextBytes(2)
            let v = UInt16(bytes[bytes.startIndex]) << 8 | UInt16(bytes[bytes.startIndex + 1])
            guard v > UInt16(UInt8.max) else { throw CBORError.nonCanonical }
            return (major, info, UInt64(v))
        case 26:
            let bytes = try c.nextBytes(4)
            var v: UInt32 = 0
            for byte in bytes { v = (v << 8) | UInt32(byte) }
            guard v > UInt32(UInt16.max) else { throw CBORError.nonCanonical }
            return (major, info, UInt64(v))
        case 27:
            let bytes = try c.nextBytes(8)
            var v: UInt64 = 0
            for byte in bytes { v = (v << 8) | UInt64(byte) }
            guard v > UInt64(UInt32.max) else { throw CBORError.nonCanonical }
            return (major, info, v)
        default:
            // 28-30 reserved, 31 = indefinite-length marker — neither is supported.
            throw CBORError.unsupported
        }
    }

    private static func decodeValue(_ c: inout Cursor, depth: Int) throws -> CBORValue {
        // Recursion guard: each array/map level recurses once, so a few KB of 0x81 (1-element
        // array) heads would otherwise walk the stack off a cliff. ≤ `maxDepth` accepted,
        // deeper rejected — the top-level value is depth 1.
        guard depth <= maxDepth else { throw CBORError.tooDeep }

        // Peek the initial byte to special-case major type 7 (bool) without misreading its
        // "additional info" as a length.
        let peekOffset = c.offset
        let initial = try c.nextByte()
        let major = initial >> 5
        let info = initial & 0x1F

        if major == 7 {
            switch info {
            case 20: return .bool(false)
            case 21: return .bool(true)
            default: throw CBORError.unsupported // floats, null, undefined, simple(x), break
            }
        }

        c.offset = peekOffset
        let (m, _, length) = try decodeHead(&c)

        switch m {
        case 0:
            return .uint(length)
        case 2:
            return .bytes(try c.nextBytes(intLength(length)))
        case 3:
            let bytes = try c.nextBytes(intLength(length))
            guard let s = String(data: bytes, encoding: .utf8) else { throw CBORError.unsupported }
            return .text(s)
        case 4:
            // Deliberately no `reserveCapacity` — `length` is attacker-controlled input read
            // before a single element has been validated, so preallocating it would let a
            // small malformed blob (claiming, say, a billion-element array) force a huge
            // allocation before the truncated-input check below ever runs. The array grows
            // organically instead; `decodeValue`'s per-item reads bound the real work to
            // however many bytes are actually present.
            var items: [CBORValue] = []
            for _ in 0..<length {
                items.append(try decodeValue(&c, depth: depth + 1))
            }
            return .array(items)
        case 5:
            // Same reasoning as the array case above — no `reserveCapacity`.
            var entries: [(String, CBORValue)] = []
            var previousKeyBytes: Data?
            for _ in 0..<length {
                guard case .text(let key) = try decodeValue(&c, depth: depth + 1) else {
                    throw CBORError.unsupported // non-text-string map key
                }
                // Canonical order compares the ENCODED key bytes (header included) — the same
                // RFC 8949 rule `encode`'s `.map` case sorts by, so decode accepts exactly
                // what encode produces and nothing else.
                let keyBytes = encode(.text(key))
                if let previous = previousKeyBytes {
                    guard lexicographicallyLess(previous, keyBytes) else {
                        // Not strictly ascending — either unsorted or a duplicate.
                        throw CBORError.nonCanonical
                    }
                }
                previousKeyBytes = keyBytes
                let value = try decodeValue(&c, depth: depth + 1)
                entries.append((key, value))
            }
            return .map(entries)
        case 1, 6:
            // Negative integers and tags are outside the supported subset.
            throw CBORError.unsupported
        default:
            throw CBORError.unsupported
        }
    }
}
