import XCTest
@testable import Norma

/// Office Stage A Task 2 — `OfficeWireFrame`/`OfficeWireCodec`: round-trip every frame, the
/// brief's literal unknown-type pin (`error{seq,reason:"unknown"}`), and `seq` echo. See
/// `OfficeWire.swift`'s header for the transport-deviation rationale (the app-role verbs the brief
/// specified as XPC are socket frames here).
final class OfficeWireCodecTests: XCTestCase {

    // MARK: - Round trip

    func testEveryFrameTypeRoundTrips() throws {
        let samples: [OfficeWireFrame] = [
            .hello(seq: 1, role: .app, token: "tok-app"),
            .hello(seq: 2, role: .agent, token: "tok-agent"),
            .ping(seq: 3),
            .open(seq: 4, docId: "doc-1", path: "/tmp/a spaced name.docx"),
            .close(seq: 5, docId: "doc-1"),
            .helloOk(seq: 6, lokVersion: officeWireStageALOKVersionPlaceholder),
            .refused(seq: 7, reason: "token mismatch"),
            .pong(seq: 8),
            .opened(seq: 9, docId: "doc-1"),
            .closed(seq: 10, docId: "doc-1"),
            .error(seq: 11, reason: "unknown"),
        ]
        for frame in samples {
            let line = try XCTUnwrap(String(data: frame.encodedLine(), encoding: .utf8))
            XCTAssertTrue(line.hasSuffix("\n"), "every encoded line must be newline-terminated: \(line)")
            XCTAssertEqual(OfficeWireFrame.decode(line), frame, "round trip failed for \(frame)")
        }
    }

    /// Same parity discipline as `EditorBridgeInbound.wireTypes`'s own test: one minimal fixture
    /// per name in `wireTypes`, decode, assert the case that comes back names itself the same way
    /// — so `wireTypes`, `decode`, and `wireType` cannot drift apart unnoticed.
    func testWireTypesFixturesEachDecodeToTheCaseTheyName() throws {
        let fixtures: [String: String] = [
            "hello": #"{"type":"hello","seq":1,"role":"app","token":"t"}"#,
            "ping": #"{"type":"ping","seq":1}"#,
            "open": #"{"type":"open","seq":1,"docId":"d","path":"/p"}"#,
            "close": #"{"type":"close","seq":1,"docId":"d"}"#,
            "helloOk": #"{"type":"helloOk","seq":1,"lokVersion":"v"}"#,
            "refused": #"{"type":"refused","seq":1,"reason":"r"}"#,
            "pong": #"{"type":"pong","seq":1}"#,
            "opened": #"{"type":"opened","seq":1,"docId":"d"}"#,
            "closed": #"{"type":"closed","seq":1,"docId":"d"}"#,
            "error": #"{"type":"error","seq":1,"reason":"r"}"#,
        ]
        XCTAssertEqual(Set(fixtures.keys), Set(OfficeWireFrame.wireTypes),
                       "fixtures must cover exactly OfficeWireFrame.wireTypes, no more, no less")
        for type in OfficeWireFrame.wireTypes {
            let frame = try XCTUnwrap(OfficeWireFrame.decode(try XCTUnwrap(fixtures[type])),
                                       "\(type) fixture failed to decode")
            XCTAssertEqual(frame.wireType, type)
        }
    }

    // MARK: - seq echo

    func testSeqAccessorReturnsTheMintedValueForEveryCase() {
        XCTAssertEqual(OfficeWireFrame.hello(seq: 100, role: .app, token: "t").seq, 100)
        XCTAssertEqual(OfficeWireFrame.ping(seq: 101).seq, 101)
        XCTAssertEqual(OfficeWireFrame.open(seq: 102, docId: "d", path: "/p").seq, 102)
        XCTAssertEqual(OfficeWireFrame.close(seq: 103, docId: "d").seq, 103)
        XCTAssertEqual(OfficeWireFrame.helloOk(seq: 104, lokVersion: "v").seq, 104)
        XCTAssertEqual(OfficeWireFrame.refused(seq: 105, reason: "r").seq, 105)
        XCTAssertEqual(OfficeWireFrame.pong(seq: 106).seq, 106)
        XCTAssertEqual(OfficeWireFrame.opened(seq: 107, docId: "d").seq, 107)
        XCTAssertEqual(OfficeWireFrame.closed(seq: 108, docId: "d").seq, 108)
        XCTAssertEqual(OfficeWireFrame.error(seq: 109, reason: "r").seq, 109)
    }

    // MARK: - The brief's literal pin: unknown type -> error{seq,reason:"unknown"}

    func testUnknownTypeIsRejectedWithSeqEchoedAndReasonUnknown() {
        switch OfficeWireCodec.decodeInbound(#"{"type":"totallyMadeUp","seq":42}"#) {
        case .rejected(let seq, let reason):
            XCTAssertEqual(seq, 42)
            XCTAssertEqual(reason, "unknown")
        case .frame, .unreadable:
            XCTFail("expected .rejected(seq: 42, reason: \"unknown\")")
        }
    }

    /// Distinguishes "type not recognized at all" (above, reason `"unknown"`) from "type IS
    /// recognized but this instance doesn't decode" (reason `"malformed"`) — both recover the real
    /// `seq`, only the reason differs, so a server can always tell a caller exactly what was wrong.
    func testKnownTypeWithMissingFieldIsRejectedAsMalformedNotUnknown() {
        switch OfficeWireCodec.decodeInbound(#"{"type":"open","seq":7}"#) { // missing docId/path
        case .rejected(let seq, let reason):
            XCTAssertEqual(seq, 7)
            XCTAssertEqual(reason, "malformed")
        case .frame, .unreadable:
            XCTFail("expected .rejected(seq: 7, reason: \"malformed\")")
        }
    }

    func testUnreadableLinesHaveNoRecoverableSeq() {
        let lines = [
            "not json at all",
            "[]",
            "{}",
            #"{"type":123,"seq":1}"#,
            #"{"type":"ping"}"#,               // seq missing entirely
            #"{"type":"ping","seq":-1}"#,       // negative
            #"{"type":"ping","seq":1.5}"#,      // non-integral
            #"{"type":"ping","seq":"nope"}"#,   // wrong JSON type
            #"{"type":"ping","seq":true}"#,     // boolean, not a number (NSNumber-boolean trap)
        ]
        for line in lines {
            XCTAssertEqual(OfficeWireCodec.decodeInbound(line), .unreadable, "expected .unreadable for: \(line)")
        }
    }

    func testPlainDecodeReturnsNilForAnythingNotAFullyDecodedFrame() {
        XCTAssertNil(OfficeWireFrame.decode("garbage"))
        XCTAssertNil(OfficeWireFrame.decode(#"{"type":"unknownThing","seq":1}"#))
        XCTAssertNil(OfficeWireFrame.decode(#"{"type":"open","seq":1}"#)) // known type, missing fields
    }

    // MARK: - Seq allocator

    func testSeqAllocatorStartsAtOneAndNeverRepeats() {
        let allocator = OfficeWireSeqAllocator()
        XCTAssertEqual(allocator.nextSeq(), 1) // never 0 — see unreadableSeqSentinel's own doc
        XCTAssertEqual(allocator.nextSeq(), 2)
        XCTAssertEqual(allocator.nextSeq(), 3)
    }

    func testUnreadableSeqSentinelIsZero() {
        // Pinned explicitly: OfficeWireSeqAllocator starting at 1 (above) is what makes 0
        // distinguishable as "the server could not recover a real seq," not a coincidence.
        XCTAssertEqual(OfficeWireCodec.unreadableSeqSentinel, 0)
    }

    // MARK: - Shared CLI arg parser (both main.swifts)

    func testArgsParserReadsFlagValuePairsAndIgnoresBareFlags() {
        let parsed = OfficeWireArgs.parse([
            "--socket-path", "/tmp/a.sock", "--token", "abc", "--bare-flag", "--mode", "silent",
        ])
        XCTAssertEqual(parsed["socket-path"], "/tmp/a.sock")
        XCTAssertEqual(parsed["token"], "abc")
        XCTAssertEqual(parsed["mode"], "silent")
        XCTAssertNil(parsed["bare-flag"])
    }

    func testArgsParserOnEmptyInput() {
        XCTAssertEqual(OfficeWireArgs.parse([]), [:])
    }
}
