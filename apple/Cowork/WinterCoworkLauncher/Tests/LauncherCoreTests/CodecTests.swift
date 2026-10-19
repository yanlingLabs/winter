import XCTest
@testable import LauncherCore

final class CodecTests: XCTestCase {
    private func failure(_ block: () throws -> Void) -> WireFailure? {
        do { try block(); return nil } catch let error as WireFailure { return error } catch { XCTFail("unexpected \(error)"); return nil }
    }
    private func parse(_ text: String) -> WireFailure? { failure { _ = try LauncherLineCodec.parseToLauncher(Array(text.utf8)) } }

    // MARK: canonical JSON

    func testWriterEscapesExactlyLikeJSONStringify() {
        var w = JSONWriter()
        w.beginObject(); w.key("a"); w.string("q\"b\\s/\u{08}\u{0c}\n\r\t\u{01}\u{1f}é😀\u{7f}"); w.endObject()
        XCTAssertEqual(String(decoding: w.bytes, as: UTF8.self), "{\"a\":\"q\\\"b\\\\s/\\b\\f\\n\\r\\t\\u0001\\u001fé😀\u{7f}\"}")
    }
    func testWriterSeparatesAndNestsWithoutWhitespace() {
        var w = JSONWriter()
        w.beginObject(); w.key("n"); w.integer(-5); w.key("l"); w.beginArray(); w.integer(1); w.bool(true); w.null(); w.beginObject(); w.endObject(); w.endArray(); w.key("s"); w.string(""); w.endObject()
        XCTAssertEqual(String(decoding: w.bytes, as: UTF8.self), "{\"n\":-5,\"l\":[1,true,null,{}],\"s\":\"\"}")
    }
    func testParserRefusesWhatNoCanonicalTextContains() {
        let good = "{\"v\":2,\"t\":\"ping\",\"id\":\"req-1\"}\n"
        XCTAssertNil(parse(good))
        XCTAssertEqual(parse("{\"v\":2,\"t\":\"ping\",\"id\":\"req-1\"}"), .malformed, "no newline")
        XCTAssertEqual(parse("{\"v\":2, \"t\":\"ping\",\"id\":\"req-1\"}\n"), .malformed, "whitespace")
        XCTAssertEqual(parse("{\"v\":2,\"t\":\"ping\",\"id\":\"req-1\"}\n{\"v\":2}\n"), .malformed, "two lines")
        XCTAssertEqual(parse("{\"v\":2,\"t\":\"ping\",\"id\":\"req-1\",\"id\":\"req-2\"}\n"), .malformed, "duplicate key")
        XCTAssertEqual(parse("{\"v\":2,\"t\":\"ping\",\"id\":\"req\\u002d1\"}\n"), .malformed, "an escape where none is canonical")
        XCTAssertEqual(parse("{\"v\":2.0,\"t\":\"ping\",\"id\":\"req-1\"}\n"), .malformed, "float spelling")
        XCTAssertEqual(parse("{\"v\":2e0,\"t\":\"ping\",\"id\":\"req-1\"}\n"), .malformed, "exponent")
        XCTAssertEqual(parse("{\"v\":-0,\"t\":\"ping\",\"id\":\"req-1\"}\n"), .malformed, "negative zero")
        XCTAssertEqual(parse("{\"v\":01,\"t\":\"ping\",\"id\":\"req-1\"}\n"), .malformed, "leading zero")
        XCTAssertEqual(parse("{\"v\":2,\"t\":\"ping\",\"id\":\"\\ud800\"}\n"), .malformed, "lone surrogate")
        XCTAssertEqual(parse("{\"v\":2,\"t\":\"ping\",\"id\":\"a\tb\"}\n"), .malformed, "raw control character in a string")
        XCTAssertEqual(parse("{\"v\":2,\"__proto__\":1,\"t\":\"ping\",\"id\":\"req-1\"}\n"), .malformed, "prototype key")
        XCTAssertEqual(parse("[1]\n"), .malformed, "not an object")
        XCTAssertEqual(parse("{\"v\":2,\"t\":\"ping\",\"id\":[[[[[1]]]]]}\n"), .malformed, "nesting deeper than a launcher line allows")
        XCTAssertEqual(Array(repeating: UInt8(ascii: "x"), count: WireLimits.muxLineBytes + 1).count, WireLimits.muxLineBytes + 1)
        XCTAssertEqual(failure { _ = try LauncherLineCodec.parseToLauncher(Array(repeating: UInt8(ascii: "x"), count: WireLimits.muxLineBytes + 1)) }, .oversize)
        XCTAssertEqual(failure { _ = try LauncherLineCodec.parseToLauncher([0xff, 0xfe, 0x0a]) }, .malformed, "not UTF-8")
    }
    func testOrderOfRefusalsFollowsTheContract() {
        XCTAssertEqual(parse("{\"v\":1,\"t\":\"ping\",\"id\":\"req-1\"}\n"), .version)
        XCTAssertEqual(parse("{\"v\":2,\"t\":\"nope\"}\n"), .unknown_type)
        XCTAssertEqual(parse("{\"v\":2,\"t\":\"hello\",\"launcherInstanceId\":\"l\",\"hostBootId\":\"b\",\"parentVerified\":true}\n"), .bad_direction, "a launcher-only type from the daemon")
        XCTAssertEqual(parse("{\"v\":2,\"t\":\"ping\"}\n"), .bad_field, "missing key")
        XCTAssertEqual(parse("{\"v\":2,\"t\":\"ping\",\"id\":\"req-1\",\"x\":1}\n"), .bad_field, "extra key")
        XCTAssertEqual(parse("{\"t\":\"ping\",\"v\":2,\"id\":\"req-1\"}\n"), .malformed, "keys out of the schema's order fail the re-serialization compare")
        XCTAssertEqual(failure { _ = try LauncherLineCodec.parseToLauncher(Array("{\"v\":2,\"t\":\"ping\",\"id\":\"req-1\"}\n".utf8), rights: 1) }, .bad_rights)
    }

    func testBeginCarriesTheHomeIdAfterIdAndNothingElseDoes() throws {
        let line = try LauncherLineCodec.serialize(LineToLauncher.begin(id: "req-1", homeId: "home_x", scope: Fixture.scope, receiptKey: Fixture.receiptKey))
        XCTAssertTrue(String(decoding: line, as: UTF8.self).hasPrefix(#"{"v":2,"t":"begin","id":"req-1","homeId":"home_x","workspaceId":"#))
        guard case .begin(_, let homeId, let scope, _) = try LauncherLineCodec.parseToLauncher(line) else { return XCTFail() }
        XCTAssertEqual(homeId, "home_x"); XCTAssertEqual(scope, Fixture.scope)
        // The old shape (no homeId) and a begin with homeId out of order are not begins.
        let old = String(decoding: line, as: UTF8.self).replacingOccurrences(of: #","homeId":"home_x""#, with: "")
        XCTAssertEqual(failure { _ = try LauncherLineCodec.parseToLauncher(Array(old.utf8)) }, .bad_field)
        let reordered = String(decoding: line, as: UTF8.self).replacingOccurrences(of: #""id":"req-1","homeId":"home_x""#, with: #""homeId":"home_x","id":"req-1""#)
        XCTAssertEqual(failure { _ = try LauncherLineCodec.parseToLauncher(Array(reordered.utf8)) }, .malformed)
        XCTAssertThrowsError(try LauncherLineCodec.serialize(LineToLauncher.begin(id: "req-1", homeId: "has space", scope: Fixture.scope, receiptKey: Fixture.receiptKey)))
    }
    func testTheMemoryFloorIs768() throws {
        var scope = Fixture.scope
        for (memory, ok) in [(767, false), (768, true), (1024, true), (1025, false), (256, false)] {
            scope.memoryMiB = memory
            XCTAssertEqual((try? LauncherLineCodec.serialize(LineToLauncher.begin(id: "req-1", homeId: "home_x", scope: scope, receiptKey: Fixture.receiptKey))) != nil, ok, "\(memory) MiB")
            XCTAssertEqual((try? EnvelopeFormat.encodeScopePayload(scope)) != nil, ok, "\(memory) MiB in the envelope")
        }
    }
    func testWorkerFaultCodeEightIsSecondDrain() throws {
        XCTAssertEqual(WorkerFault(rawValue: 8), .secondDrain)
        XCTAssertNil(WorkerFault(rawValue: 9)); XCTAssertNil(WorkerFault(rawValue: 0))
        let bytes = try EnvelopeFormat.serialize(.fault(seq: 1, code: .secondDrain))
        XCTAssertEqual(EnvelopeFormat.get32(bytes, 16), 8)
        XCTAssertEqual(try EnvelopeFormat.parse(bytes, rights: 0, direction: .toLauncher), .fault(seq: 1, code: .secondDrain))
    }

    // MARK: the L1 framer

    private func fd() throws -> OwnedFD { OwnedFD(open("/dev/null", O_RDONLY | O_CLOEXEC)) }

    func testFramerCutsLinesAcrossChunks() throws {
        var framer = LineFramer()
        XCTAssertTrue(try framer.feed(Array("ab".utf8), rights: []).isEmpty)
        let lines = try framer.feed(Array("c\nde\nf".utf8), rights: [])
        XCTAssertEqual(lines.map { String(decoding: $0.bytes, as: UTF8.self) }, ["abc\n", "de\n"])
        XCTAssertEqual(framer.bufferedBytes, 1)
    }
    func testDescriptorsBelongToTheLineThatStartsAtTheFirstByteOfTheirChunk() throws {
        var framer = LineFramer()
        let lines = try framer.feed(Array("first\nsecond\n".utf8), rights: [try fd(), try fd()])
        XCTAssertEqual(lines.map(\.rights.count), [2, 0], "the first line owns them; coalesced later lines do not")
    }
    func testDescriptorsSplitFromTheirLineWaitForItToComplete() throws {
        var framer = LineFramer()
        XCTAssertTrue(try framer.feed(Array("part".utf8), rights: [try fd(), try fd()]).isEmpty)
        let lines = try framer.feed(Array("ial\n".utf8), rights: [])
        XCTAssertEqual(lines.map(\.rights.count), [2])
    }
    func testDescriptorsMidLineAreAProtocolViolationAndAreClosed() throws {
        var framer = LineFramer()
        _ = try framer.feed(Array("par".utf8), rights: [])
        var number: Int32 = -1
        do {
            let descriptor = OwnedFD(open("/dev/null", O_RDONLY | O_CLOEXEC)); number = descriptor.raw
            XCTAssertThrowsError(try framer.feed(Array("tial\n".utf8), rights: [descriptor])) { XCTAssertEqual($0 as? FramingFailure, .rightsOffBoundary) }
        }
        XCTAssertEqual(fcntl(number, F_GETFD), -1, "dropped, therefore closed")
        var empty = LineFramer()
        XCTAssertThrowsError(try empty.feed([], rights: [try fd()]), "descriptors that arrive with no bytes at all") { XCTAssertEqual($0 as? FramingFailure, .rightsOffBoundary) }
    }
    func testFramerRefusesAnUnboundedLine() throws {
        var framer = LineFramer(maxLine: 16)
        XCTAssertThrowsError(try framer.feed(Array(repeating: 0x61, count: 17), rights: [])) { XCTAssertEqual($0 as? FramingFailure, .lineTooLong) }
    }

    // MARK: mux frames and their sequence

    func testStreamReaderCutsFramesAndValidatesTheHeaderBeforeBufferingAPayload() throws {
        var reader = MuxStreamReader()
        let one = MuxFormat.frame(.bootstrap, seq: 1, payload: Array("{\"a\":1}".utf8)), two = MuxFormat.frame(.runtime, seq: 1, payload: [1, 2, 3])
        let all = one + two
        XCTAssertTrue(try reader.feed(Array(all[0..<10])).isEmpty)
        let frames = try reader.feed(Array(all[10...]))
        XCTAssertEqual(frames.map(\.bytes), [one, two])
        XCTAssertEqual(frames.map(\.header.muxClass), [.bootstrap, .runtime])
    }
    func testStreamReaderRefusesTheReservedProviderClassAnOversizePayloadAndGarbage() throws {
        func feeds(_ bytes: [UInt8]) -> WireFailure? { var r = MuxStreamReader(); return failure { _ = try r.feed(bytes) } }
        XCTAssertEqual(feeds(MuxFormat.frame(.provider, seq: 1, payload: [])), .reserved_class)
        var big = MuxFormat.frame(.bootstrap, seq: 1, payload: [])
        EnvelopeFormat.put32(UInt32(WireLimits.muxBootstrapPayload + 1), &big, 12)
        XCTAssertEqual(feeds(Array(big[0..<16])), .oversize, "refused from the header alone, before the payload is buffered")
        XCTAssertEqual(feeds([UInt8](repeating: 0x41, count: 16)), .malformed)
        var seq0 = MuxFormat.frame(.runtime, seq: 1, payload: []); EnvelopeFormat.put32(0, &seq0, 8)
        XCTAssertEqual(feeds(seq0), .bad_sequence)
        var dead = MuxStreamReader()
        _ = failure { _ = try dead.feed([UInt8](repeating: 0x41, count: 16)) }
        XCTAssertEqual(failure { _ = try dead.feed([]) }, .malformed, "a desynchronised stream stays dead")
    }
    func testSequenceCheckIsPerClassAndRefusesGapsRepeatsAndRewinds() throws {
        var sequencer = MuxSequencer()
        func header(_ cls: MuxClass, _ seq: UInt32) -> MuxHeader { MuxHeader(muxClass: cls, seq: seq, payloadLength: 0) }
        try sequencer.accept(header(.bootstrap, 1)); try sequencer.accept(header(.runtime, 1)); try sequencer.accept(header(.bootstrap, 2))
        XCTAssertEqual(failure { try sequencer.accept(header(.bootstrap, 2)) }, .bad_sequence, "repeat")
        XCTAssertEqual(failure { try sequencer.accept(header(.bootstrap, 4)) }, .bad_sequence, "gap")
        XCTAssertEqual(failure { try sequencer.accept(header(.bootstrap, 1)) }, .bad_sequence, "rewind")
        try sequencer.accept(header(.bootstrap, 3)) // a refused frame did not advance the counter
    }
    func testRelayCarriesBootstrapAndRuntimeOnlyAndNeverLooksInsideThePayload() throws {
        XCTAssertNoThrow(try MuxFormat.parseRelayable(MuxFormat.frame(.bootstrap, seq: 1, payload: [0xff, 0xfe, 0x00])), "payload bytes are the endpoints' business")
        XCTAssertEqual(failure { _ = try MuxFormat.parseRelayable(MuxFormat.frame(.control, seq: 1, payload: Array("{}".utf8))) }, .bad_field)
        XCTAssertEqual(failure { _ = try MuxFormat.parseRelayable(MuxFormat.frame(.provider, seq: 1, payload: [])) }, .reserved_class)
        var padded = MuxFormat.frame(.runtime, seq: 1, payload: [1]); padded.append(0)
        XCTAssertEqual(failure { _ = try MuxFormat.parseRelayable(padded) }, .malformed)
    }

    // MARK: envelopes

    func testEnvelopeNamesAreRefusedWhenEmptyFullWidthOrDirty() throws {
        var payload = try EnvelopeFormat.encodeScopePayload(Fixture.scope)
        func parsed(_ p: [UInt8]) -> WireFailure? {
            var bytes = [UInt8](repeating: 0, count: 16) + p
            bytes.replaceSubrange(0..<4, with: EnvelopeFormat.magic); bytes[4] = 1; bytes[5] = 1; EnvelopeFormat.put32(1, &bytes, 8); EnvelopeFormat.put32(512, &bytes, 12)
            return failure { _ = try EnvelopeFormat.parse(bytes, rights: 0, direction: .toWorker) }
        }
        XCTAssertNil(parsed(payload))
        var empty = payload; empty.replaceSubrange(0..<64, with: [UInt8](repeating: 0, count: 64)); XCTAssertEqual(parsed(empty), .bad_field)
        var full = payload; full.replaceSubrange(0..<64, with: [UInt8](repeating: 0x61, count: 64)); XCTAssertEqual(parsed(full), .bad_field, "no NUL")
        var dirty = payload; dirty[63] = 0x41; XCTAssertEqual(parsed(dirty), .bad_field, "non-zero byte after the NUL")
        payload[500] = 1; XCTAssertEqual(parsed(payload), .bad_field, "reserved bytes are zero")
    }
    func testEnvelopeRightsAreExactlyTwoOnVolumesAndNoneElsewhere() throws {
        let volumes = try EnvelopeFormat.serialize(.volumes(seq: 2, scopeDigest: try EnvelopeFormat.scopeDigest(Fixture.scope), volumes: try DiskPair().identities))
        XCTAssertEqual(failure { _ = try EnvelopeFormat.parse(volumes, rights: 1, direction: .toWorker) }, .bad_rights)
        XCTAssertEqual(failure { _ = try EnvelopeFormat.parse(volumes, rights: 3, direction: .toWorker) }, .bad_rights)
        XCTAssertNoThrow(try EnvelopeFormat.parse(volumes, rights: 2, direction: .toWorker))
        let drain = try EnvelopeFormat.serialize(.drain(seq: 3, stopNonce: Fixture.nonce, budgetMs: 1000, origin: .hostStop))
        XCTAssertEqual(failure { _ = try EnvelopeFormat.parse(drain, rights: 2, direction: .toWorker) }, .bad_rights)
        XCTAssertEqual(failure { _ = try EnvelopeFormat.parse(drain, rights: 0, direction: .toLauncher) }, .bad_direction)
    }
}
