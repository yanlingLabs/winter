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
        // canonical order: "a" (0x61) < "aa" (0x61 61 — longer) — bytewise lexicographic on ENCODED keys
        #expect(CanonicalCBOR.encode(m) == Data([0xA3, 0x61, 0x61, 0x01, 0x62, 0x61, 0x61, 0x03, 0x61, 0x62, 0x02]))
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
        // {"b": 1, "a": 2} — keys present but out of canonical order.
        let bytes = Data([0xA2, 0x61, 0x62, 0x01, 0x61, 0x61, 0x02])
        #expect(throws: CBORError.self) { try CanonicalCBOR.decode(bytes) }
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
}
