import XCTest
@testable import Norma

/// Office Stage A Task 2 — `OfficeWireFrame`/`OfficeWireCodec`: round-trip every frame, the
/// brief's literal unknown-type pin (`error{seq,reason:"unknown"}`), and `seq` echo. See
/// `OfficeWire.swift`'s header for the transport-deviation rationale (the app-role verbs the brief
/// specified as XPC are socket frames here).
final class OfficeWireCodecTests: XCTestCase {

    // MARK: - Round trip

    func testEveryFrameTypeRoundTrips() throws {
        let size = OfficeDocumentSize(widthTwips: 26593, heightTwips: 13005)
        let samples: [OfficeWireFrame] = [
            .hello(seq: 1, role: .app, token: "tok-app"),
            .hello(seq: 2, role: .agent, token: "tok-agent"),
            .ping(seq: 3),
            .open(seq: 4, docId: "doc-1", path: "/tmp/a spaced name.docx"),
            .close(seq: 5, docId: "doc-1"),
            .helloOk(seq: 6, lokVersion: officeWireStageALOKVersionPlaceholder),
            .refused(seq: 7, reason: "token mismatch"),
            .pong(seq: 8),
            .opened(seq: 9, docId: "doc-1", type: .spreadsheet, parts: 3, sizeTwips: size),
            .openFailed(seq: 10, docId: "doc-2", reason: "documentLoad failed: garbage input"),
            .closed(seq: 11, docId: "doc-1"),
            .error(seq: 12, reason: "unknown"),
            // Task 3 — documentEvent, one sample per OfficeDocumentEvent case (advisor's own
            // point: round-trip all five even though only invalidated/modifiedChanged are ever
            // actually emitted by LOKBridge in Stage A — T4 inherits this codec unchanged).
            .documentEvent(seq: 13, docId: "doc-1", event: .opened(type: .text, parts: 1, sizeTwips: size)),
            .documentEvent(seq: 14, docId: "doc-1", event: .openFailed(reason: "nope")),
            .documentEvent(seq: 15, docId: "doc-1", event: .invalidated(
                rectsTwips: [OfficeTwipsRect(x: 0, y: 0, width: 1000, height: 2000)], part: 0)),
            .documentEvent(seq: 16, docId: "doc-1", event: .invalidated(rectsTwips: [], part: 0)), // "EMPTY"
            .documentEvent(seq: 17, docId: "doc-1", event: .modifiedChanged(true)),
            .documentEvent(seq: 18, docId: "doc-1", event: .modifiedChanged(false)),
            .documentEvent(seq: 19, docId: "doc-1", event: .closed),
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
            "opened": #"{"type":"opened","seq":1,"docId":"d","docType":"text","parts":1,"widthTwips":100,"heightTwips":200}"#,
            "openFailed": #"{"type":"openFailed","seq":1,"docId":"d","reason":"r"}"#,
            "closed": #"{"type":"closed","seq":1,"docId":"d"}"#,
            "error": #"{"type":"error","seq":1,"reason":"r"}"#,
            "documentEvent": #"{"type":"documentEvent","seq":1,"docId":"d","kind":"closed"}"#,
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
        let size = OfficeDocumentSize(widthTwips: 1, heightTwips: 1)
        XCTAssertEqual(OfficeWireFrame.hello(seq: 100, role: .app, token: "t").seq, 100)
        XCTAssertEqual(OfficeWireFrame.ping(seq: 101).seq, 101)
        XCTAssertEqual(OfficeWireFrame.open(seq: 102, docId: "d", path: "/p").seq, 102)
        XCTAssertEqual(OfficeWireFrame.close(seq: 103, docId: "d").seq, 103)
        XCTAssertEqual(OfficeWireFrame.helloOk(seq: 104, lokVersion: "v").seq, 104)
        XCTAssertEqual(OfficeWireFrame.refused(seq: 105, reason: "r").seq, 105)
        XCTAssertEqual(OfficeWireFrame.pong(seq: 106).seq, 106)
        XCTAssertEqual(OfficeWireFrame.opened(seq: 107, docId: "d", type: .text, parts: 1, sizeTwips: size).seq, 107)
        XCTAssertEqual(OfficeWireFrame.openFailed(seq: 108, docId: "d", reason: "r").seq, 108)
        XCTAssertEqual(OfficeWireFrame.closed(seq: 109, docId: "d").seq, 109)
        XCTAssertEqual(OfficeWireFrame.error(seq: 110, reason: "r").seq, 110)
        XCTAssertEqual(OfficeWireFrame.documentEvent(seq: 111, docId: "d", event: .closed).seq, 111)
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

    /// Task 3 — `opened`'s three new fields (`docType`/`parts`/`widthTwips`/`heightTwips`) are each
    /// required; missing any one is "malformed", not a partially-decoded frame with defaults.
    func testOpenedMissingAnyNewFieldIsMalformed() {
        let base = #"{"type":"opened","seq":1,"docId":"d""#
        let missingDocType = base + #","parts":1,"widthTwips":1,"heightTwips":1}"#
        let missingParts = base + #","docType":"text","widthTwips":1,"heightTwips":1}"#
        let missingSize = base + #","docType":"text","parts":1}"#
        let unknownDocType = base + #","docType":"spreadsheat","parts":1,"widthTwips":1,"heightTwips":1}"# // typo on purpose
        for line in [missingDocType, missingParts, missingSize, unknownDocType] {
            switch OfficeWireCodec.decodeInbound(line) {
            case .rejected(let seq, let reason):
                XCTAssertEqual(seq, 1)
                XCTAssertEqual(reason, "malformed", "expected malformed for: \(line)")
            case .frame, .unreadable:
                XCTFail("expected .rejected(seq: 1, reason: \"malformed\") for: \(line)")
            }
        }
    }

    /// Task 3 — `documentEvent` with an unrecognized/missing `kind`, or a `kind` whose OWN fields
    /// don't decode, is "malformed" at the FRAME level (not a partially-decoded event).
    func testDocumentEventMalformedShapesAreRejected() {
        let lines = [
            #"{"type":"documentEvent","seq":1,"docId":"d"}"#,                        // missing kind
            #"{"type":"documentEvent","seq":1,"docId":"d","kind":"madeUp"}"#,         // unknown kind
            #"{"type":"documentEvent","seq":1,"docId":"d","kind":"modifiedChanged"}"#, // missing "modified"
            #"{"type":"documentEvent","seq":1,"docId":"d","kind":"modifiedChanged","modified":1}"#, // NSNumber-boolean trap, inverted
            #"{"type":"documentEvent","seq":1,"kind":"closed"}"#,                     // missing docId (frame-level)
        ]
        for line in lines {
            switch OfficeWireCodec.decodeInbound(line) {
            case .rejected(let seq, let reason):
                XCTAssertEqual(seq, 1)
                XCTAssertEqual(reason, "malformed", "expected malformed for: \(line)")
            case .frame, .unreadable:
                XCTFail("expected .rejected(seq: 1, reason: \"malformed\") for: \(line)")
            }
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

    // MARK: - LOK raw callback payload parsing (OfficeDocumentEvent.parseInvalidateTiles/parseModifiedStatus)
    //
    // These two parsers translate LibreOfficeKit's raw callback payload strings into
    // `OfficeDocumentEvent`. They live on `OfficeDocumentEvent` (not `LOKBridge`, their one real
    // caller) specifically so this table can reach them: `LOKBridge` is a `type: tool` Xcode
    // target no test bundle can import, and no Stage-A wire verb provokes a real LOK callback
    // (Stage A never paints a tile or edits a document), so this table is — as of Task 3 — the
    // ONLY exercise of this parsing logic anywhere. Every case below was read directly off the
    // implementation, not off a live LOK firing.

    func testParseInvalidateTilesRecognizedShapes() {
        let size4 = OfficeDocumentEvent.parseInvalidateTiles("10, 20, 300, 400")
        XCTAssertEqual(size4, .invalidated(rectsTwips: [OfficeTwipsRect(x: 10, y: 20, width: 300, height: 400)], part: 0),
                       "4-value payload: no part field means part defaults to 0")

        let size5 = OfficeDocumentEvent.parseInvalidateTiles("10, 20, 300, 400, 2")
        XCTAssertEqual(size5, .invalidated(rectsTwips: [OfficeTwipsRect(x: 10, y: 20, width: 300, height: 400)], part: 2),
                       "5-value payload: 5th field is the part")

        let tight = OfficeDocumentEvent.parseInvalidateTiles("10,20,300,400,2")
        XCTAssertEqual(tight, size5, "no space after commas parses identically to the spaced form")

        XCTAssertEqual(OfficeDocumentEvent.parseInvalidateTiles("EMPTY"), .invalidated(rectsTwips: [], part: 0),
                       "EMPTY means the whole document; part defaults to 0 — LOK's own EMPTY firing carries no part")
        XCTAssertEqual(OfficeDocumentEvent.parseInvalidateTiles("  EMPTY  "), .invalidated(rectsTwips: [], part: 0),
                       "surrounding whitespace is trimmed before the EMPTY comparison")
    }

    func testParseInvalidateTilesMalformedPayloadsAreRejected() {
        let malformed = ["", "10, 20, 300", "a, b, c, d", "not a payload at all"]
        for payload in malformed {
            XCTAssertNil(OfficeDocumentEvent.parseInvalidateTiles(payload), "expected nil for: \"\(payload)\"")
        }
    }

    func testParseInvalidateTilesUnparsablePartFallsBackToZeroRatherThanRejecting() {
        // Documents existing behavior precisely: `Int(fields[4]) ?? 0` — a 5th field present but
        // not itself a valid Int does NOT reject the whole payload, it silently defaults part to 0.
        let result = OfficeDocumentEvent.parseInvalidateTiles("10, 20, 300, 400, notanumber")
        XCTAssertEqual(result, .invalidated(rectsTwips: [OfficeTwipsRect(x: 10, y: 20, width: 300, height: 400)], part: 0))
    }

    func testParseModifiedStatusRecognizedShapes() {
        XCTAssertEqual(OfficeDocumentEvent.parseModifiedStatus(".uno:ModifiedStatus=true"), .modifiedChanged(true))
        XCTAssertEqual(OfficeDocumentEvent.parseModifiedStatus(".uno:ModifiedStatus=false"), .modifiedChanged(false))
    }

    func testParseModifiedStatusUnrecognizedUnoCommandIsRejected() {
        XCTAssertNil(OfficeDocumentEvent.parseModifiedStatus(".uno:Bold=true"), "a different .uno: state change is out of Stage A's vocabulary")
        XCTAssertNil(OfficeDocumentEvent.parseModifiedStatus(""), "empty payload has no prefix to match")
        XCTAssertNil(OfficeDocumentEvent.parseModifiedStatus("ModifiedStatus=true"), "missing the leading \".uno:\" does not match")
    }

    func testParseModifiedStatusAnyNonTrueSuffixIsTreatedAsFalseNotRejected() {
        // Documents existing behavior precisely: the suffix is compared with `== "true"`, so any
        // non-"true" suffix on an otherwise-matching prefix (including garbage, not just "false")
        // yields `.modifiedChanged(false)` rather than nil.
        XCTAssertEqual(OfficeDocumentEvent.parseModifiedStatus(".uno:ModifiedStatus=garbage"), .modifiedChanged(false))
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
