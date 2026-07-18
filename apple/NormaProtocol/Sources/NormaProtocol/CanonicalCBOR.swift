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
/// map keys), or there are bytes left over after a complete value was decoded
/// (`.trailingBytes`).
public enum CBORError: Error, Equatable {
    case unsupported
    case nonCanonical
    case trailingBytes
    case truncated
}

/// RFC 8949 §4.2.1 core deterministic ("canonical") CBOR encoding, restricted to the six
/// `CBORValue` cases. Canonical form means: definite lengths only, shortest-form length
/// encoding (no non-minimal integers), and map entries sorted bytewise ascending by their raw
/// UTF-8 key bytes with no duplicates (see the `.map` case below for why that's *raw* key
/// bytes, not the CBOR-encoded-with-header bytes). `encode` always produces this form;
/// `decode` rejects anything that isn't already in it.
public enum CanonicalCBOR {

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
            // Sort bytewise-ascending on the raw UTF-8 key bytes (shorter-is-prefix sorts
            // first, otherwise the first differing byte decides) — e.g. "a" < "aa" < "b".
            // All map keys are text strings by construction (`CBORValue.map`'s type), so this
            // is exactly RFC 8949's "bytewise lexicographic order" with no cross-type tie-break
            // to worry about.
            precondition(
                Set(entries.map(\.0)).count == entries.count,
                "CanonicalCBOR.encode(map:): duplicate key"
            )
            let sorted = entries.sorted { lhs, rhs in
                lexicographicallyLess(Data(lhs.0.utf8), Data(rhs.0.utf8))
            }
            var out = encodeHead(majorType: 5, length: UInt64(sorted.count))
            for (key, value) in sorted {
                out.append(encode(.text(key)))
                out.append(encode(value))
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
        let value = try decodeValue(&cursor)
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

    private static func decodeValue(_ c: inout Cursor) throws -> CBORValue {
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
                items.append(try decodeValue(&c))
            }
            return .array(items)
        case 5:
            // Same reasoning as the array case above — no `reserveCapacity`.
            var entries: [(String, CBORValue)] = []
            var previousKeyBytes: Data?
            for _ in 0..<length {
                guard case .text(let key) = try decodeValue(&c) else {
                    throw CBORError.unsupported // non-text-string map key
                }
                // Canonical order compares the raw UTF-8 key bytes (see the matching note in
                // `encode`'s `.map` case) — NOT the CBOR-encoded bytes (which would bake the
                // length into the leading byte and give a different order for keys of
                // different lengths).
                let keyBytes = Data(key.utf8)
                if let previous = previousKeyBytes {
                    guard lexicographicallyLess(previous, keyBytes) else {
                        // Not strictly ascending — either unsorted or a duplicate.
                        throw CBORError.nonCanonical
                    }
                }
                previousKeyBytes = keyBytes
                let value = try decodeValue(&c)
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
