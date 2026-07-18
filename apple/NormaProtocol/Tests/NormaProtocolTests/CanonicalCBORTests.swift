import Testing
import Foundation
@testable import NormaProtocol

/// SP2b Task 2: canonical CBOR (RFC 8949 §4.2.1 core deterministic encoding). Known-answer
/// vectors straight from the RFC, plus map-key sort order and decoder-rejects-garbage checks.
struct CanonicalCBORTests {

    @Test func encodesRFC8949Vectors() {
        #expect(CanonicalCBOR.encode(.uint(0)) == Data([0x00]))
        #expect(CanonicalCBOR.encode(.uint(23)) == Data([0x17]))
        #expect(CanonicalCBOR.encode(.uint(24)) == Data([0x18, 0x18]))
        #expect(CanonicalCBOR.encode(.uint(1000)) == Data([0x19, 0x03, 0xE8]))
        #expect(CanonicalCBOR.encode(.text("a")) == Data([0x61, 0x61]))
        #expect(CanonicalCBOR.encode(.bytes(Data([1, 2, 3]))) == Data([0x43, 1, 2, 3]))
        #expect(CanonicalCBOR.encode(.bool(true)) == Data([0xF5]))
        #expect(CanonicalCBOR.encode(.array([.uint(1), .uint(2)])) == Data([0x82, 0x01, 0x02]))
    }

    @Test func mapKeysAreSortedBytewise() {
        let m = CBORValue.map([("b", .uint(2)), ("a", .uint(1)), ("aa", .uint(3))])
        // RFC 8949 §4.2.1: bytewise lexicographic on the ENCODED key bytes (header included).
        // "a" = 61 61, "b" = 61 62, "aa" = 62 61 61 → order a, b, aa (length-first for text
        // keys, since the header byte embeds the length).
        #expect(CanonicalCBOR.encode(m) == Data([0xA3, 0x61, 0x61, 0x01, 0x61, 0x62, 0x02, 0x62, 0x61, 0x61, 0x03]))
    }

    @Test func mapKeySortIsLengthFirst() {
        // The clearest divergence from a raw-content sort: 'z' > 'a' as content, but
        // "z" (61 7A) < "aa" (62 61 61) on encoded bytes — the shorter key sorts first.
        let m = CBORValue.map([("aa", .uint(1)), ("z", .uint(2))])
        let encoded = CanonicalCBOR.encode(m)
        #expect(encoded == Data([0xA2, 0x61, 0x7A, 0x02, 0x62, 0x61, 0x61, 0x01]))
        // And the decoder accepts exactly this order (round trip preserves it).
        #expect(try! CanonicalCBOR.decode(encoded) == .map([("z", .uint(2)), ("aa", .uint(1))]))
    }

    @Test func roundTripsAndRejectsGarbage() throws {
        let v = CBORValue.map([("k", .array([.bytes(Data([9])), .text("x"), .bool(false)]))])
        #expect(try CanonicalCBOR.decode(CanonicalCBOR.encode(v)) == v)
        #expect(throws: CBORError.self) { try CanonicalCBOR.decode(Data([0xFF])) }          // stray break
        #expect(throws: CBORError.self) { try CanonicalCBOR.decode(Data([0x00, 0x00])) }    // trailing bytes
        #expect(throws: CBORError.self) { try CanonicalCBOR.decode(Data([0xFB, 0,0,0,0,0,0,0,0])) } // float
    }

    // MARK: - Additional coverage (beyond the brief's literal vectors — same spirit)

    @Test func rejectsIndefiniteLength() {
        // Indefinite-length byte string: major type 2, additional info 31 (0x5F), no length.
        #expect(throws: CBORError.self) { try CanonicalCBOR.decode(Data([0x5F])) }
    }

    @Test func rejectsNonCanonicalLength() {
        // uint 0 encoded as a 2-byte form (0x18 0x00) instead of the shortest form (0x00).
        #expect(throws: CBORError.self) { try CanonicalCBOR.decode(Data([0x18, 0x00])) }
    }

    @Test func rejectsDuplicateMapKeys() {
        // {"a": 1, "a": 2} hand-encoded — duplicate key "a".
        let bytes = Data([0xA2, 0x61, 0x61, 0x01, 0x61, 0x61, 0x02])
        #expect(throws: CBORError.self) { try CanonicalCBOR.decode(bytes) }
    }

    @Test func rejectsUnsortedMapKeys() {
        // {"b": 1, "a": 2} — same-length keys out of content order.
        let bytes = Data([0xA2, 0x61, 0x62, 0x01, 0x61, 0x61, 0x02])
        #expect(throws: CBORError.self) { try CanonicalCBOR.decode(bytes) }
        // {"aa": 3, "b": 1} — sorted under a (wrong) raw-content rule, but NOT under the
        // RFC's encoded-bytes rule ("b" = 61 62 must precede "aa" = 62 61 61).
        let rawSortedOnly = Data([0xA2, 0x62, 0x61, 0x61, 0x03, 0x61, 0x62, 0x01])
        #expect(throws: CBORError.self) { try CanonicalCBOR.decode(rawSortedOnly) }
    }

    @Test func rejectsNegativeInts() {
        // Major type 1 (negative int), value -1 → 0x20.
        #expect(throws: CBORError.self) { try CanonicalCBOR.decode(Data([0x20])) }
    }

    @Test func rejectsTags() {
        // Major type 6 (tag), tag 0 → 0xC0 followed by a text string.
        #expect(throws: CBORError.self) { try CanonicalCBOR.decode(Data([0xC0, 0x61, 0x61])) }
    }

    @Test func bytesEqualityIsElementWise() {
        // CBORValue.Equatable sanity — maps compare element-wise (order matters, since map is
        // an ordered [(String, CBORValue)] not a Dictionary).
        let a = CBORValue.map([("a", .uint(1)), ("b", .uint(2))])
        let b = CBORValue.map([("b", .uint(2)), ("a", .uint(1))])
        #expect(a != b)
    }

    @Test func rejectsOversizedLengthWithoutTrapping() {
        // Major type 2 (bstr), additional info 27 (8-byte length), length = UInt64.max — bigger
        // than `Int.max` on any real platform. Must throw `CBORError`, never crash the process
        // by trapping on an `Int(UInt64)` conversion that doesn't fit.
        let bytes = Data([0x5B, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF])
        #expect(throws: CBORError.self) { try CanonicalCBOR.decode(bytes) }
    }

    @Test func rejectsHugeButInRangeArrayLengthCheaply() {
        // Major type 4 (array), additional info 26 (4-byte length), length = 0xFFFF_FFFE — well
        // within `Int`'s range, but the input is only 5 bytes total. Must throw `.truncated`
        // promptly rather than attempting to preallocate billions of elements first.
        let bytes = Data([0x9A, 0xFF, 0xFF, 0xFF, 0xFE])
        #expect(throws: CBORError.self) { try CanonicalCBOR.decode(bytes) }
    }

    /// One byte of 0x81 (1-element array) per nesting level, wrapping a `uint 0` — `levels`
    /// array levels put the innermost scalar at depth `levels + 1`.
    private func nestedArrays(_ levels: Int) -> Data {
        Data(repeating: 0x81, count: levels) + Data([0x00])
    }

    @Test func acceptsNestingAtDepthLimit() throws {
        // 31 array levels → innermost uint at depth 32 == CanonicalCBOR.maxDepth. Accepted.
        let decoded = try CanonicalCBOR.decode(nestedArrays(CanonicalCBOR.maxDepth - 1))
        var value = decoded
        var levels = 0
        while case .array(let items) = value {
            #expect(items.count == 1)
            value = items[0]
            levels += 1
        }
        #expect(levels == CanonicalCBOR.maxDepth - 1)
        #expect(value == .uint(0))
    }

    @Test func rejectsNestingBeyondDepthLimit() {
        // 32 array levels → innermost uint at depth 33 → .tooDeep.
        #expect(throws: CBORError.tooDeep) {
            try CanonicalCBOR.decode(nestedArrays(CanonicalCBOR.maxDepth))
        }
        // And the motivating attack: a ~1KB chain of array heads must throw (bounded
        // recursion), not exhaust the stack.
        #expect(throws: CBORError.tooDeep) {
            try CanonicalCBOR.decode(nestedArrays(1000))
        }
    }
}
