import XCTest
@testable import Norma

/// Office Stage A Task 2 — `OfficeWireFrame`/`OfficeWireCodec`: round-trip every frame, the
/// brief's literal unknown-type pin (`error{seq,reason:"unknown"}`), and `seq` echo. See
/// `OfficeWire.swift`'s header for the transport-deviation rationale (the app-role verbs the brief
/// specified as XPC are socket frames here).
final class OfficeWireCodecTests: XCTestCase {

    // MARK: - Round trip

    /// **Task 5.5: `.tile` is deliberately EXCLUDED from this array.** Every other frame's whole
    /// envelope is one NDJSON line, so `OfficeWireFrame.decode(line) == frame` is a meaningful
    /// round trip; `.tile`'s pixel bytes are no longer part of any line at all (see that case's own
    /// doc comment), so `decode(_:)` correctly — not a bug — returns `nil` for a `.tile` header
    /// line (it decodes to `.tilePending`, a DIFFERENT `OfficeWireCodec.decodeInbound` outcome, not
    /// a complete frame). Asserting `decode(tileLine) == tileFrame` here would be asserting
    /// something the type system no longer promises. `.tile`'s own two-phase round trip is
    /// `testTileHeaderRoundTripsAndPayloadSurvivesSeparately` right below.
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
            // Task 4 — tile pipeline frames.
            .subscribeTiles(seq: 20, docId: "doc-1", part: 0, zoomPPT: 1000,
                             viewportTwips: OfficeTwipsRect(x: 0, y: 0, width: 10240, height: 5120)),
            .unsubscribe(seq: 21, docId: "doc-1"),
            .tileRequest(seq: 22, docId: "doc-1", keys: [
                TileKey(part: 0, zoomPPT: 1000, tileX: 0, tileY: 0),
                TileKey(part: 0, zoomPPT: 1000, tileX: 1, tileY: 0),
            ]),
            .tileRequest(seq: 23, docId: "doc-1", keys: []), // an empty key list is a legal (if pointless) request
            .subscribed(seq: 24, docId: "doc-1", keys: [TileKey(part: 0, zoomPPT: 1000, tileX: 0, tileY: 0)]),
            .unsubscribed(seq: 25, docId: "doc-1"),
            .tileRequestAccepted(seq: 26, docId: "doc-1"),
            // .tile deliberately omitted — see this test's own header comment.
            .tileFailed(seq: 28, docId: "doc-1", key: TileKey(part: 0, zoomPPT: 1000, tileX: 0, tileY: 0),
                        reason: "docNotOpen"),
            .invalidated(seq: 29, docId: "doc-1", keys: [
                TileKey(part: 0, zoomPPT: 1000, tileX: 0, tileY: 0),
                TileKey(part: 1, zoomPPT: 2000, tileX: -3, tileY: 7), // negative index + a second part/zoom
            ]),
        ]
        for frame in samples {
            let line = try XCTUnwrap(String(data: frame.encodedLine(), encoding: .utf8))
            XCTAssertTrue(line.hasSuffix("\n"), "every encoded line must be newline-terminated: \(line)")
            XCTAssertEqual(OfficeWireFrame.decode(line), frame, "round trip failed for \(frame)")
        }
    }

    /// Task 5.5 — `.tile`'s own two-phase round trip: `encodedLine()` produces a HEADER line
    /// (byteCount, no pixel bytes) that decodes via `OfficeWireCodec.decodeInbound` to
    /// `.tilePending`, never `.frame`; `tilePayload` separately carries the exact pixel bytes the
    /// original frame was constructed with. Together these two checks are the honest equivalent of
    /// "round trips" for a frame whose envelope is no longer one self-contained line.
    func testTileHeaderRoundTripsAndPayloadSurvivesSeparately() throws {
        let key = TileKey(part: 0, zoomPPT: 1000, tileX: 0, tileY: 0)
        let pixels = Data([0x00, 0x01, 0x0A, 0xFF]) // deliberately includes a 0x0A byte
        let frame = OfficeWireFrame.tile(seq: 27, docId: "doc-1", key: key, generation: 3,
                                          width: 512, height: 512, pixels: pixels)

        XCTAssertEqual(frame.tilePayload, pixels, "tilePayload must be exactly the pixel bytes the frame was built with")

        let line = try XCTUnwrap(String(data: frame.encodedLine(), encoding: .utf8))
        XCTAssertTrue(line.hasSuffix("\n"), "the header line must still be newline-terminated")
        XCTAssertFalse(line.contains("pixelsBase64"), "rung 2 must never emit the rung-1 field name")
        XCTAssertTrue(line.contains("\"byteCount\":\(pixels.count)"), "the header must report the payload's exact byte count")

        XCTAssertNil(OfficeWireFrame.decode(line), "a bare tile header is not a complete frame — see decode(_:)'s own contract")

        guard case .tilePending(let header) = OfficeWireCodec.decodeInbound(line) else {
            return XCTFail("expected .tilePending for a tile header line, got \(OfficeWireCodec.decodeInbound(line))")
        }
        XCTAssertEqual(header, TileWireHeader(seq: 27, docId: "doc-1", key: key, generation: 3,
                                               width: 512, height: 512, byteCount: pixels.count))
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
            "subscribeTiles": #"{"type":"subscribeTiles","seq":1,"docId":"d","part":0,"zoomPPT":1000,"viewportTwips":{"x":0,"y":0,"width":1,"height":1}}"#,
            "unsubscribe": #"{"type":"unsubscribe","seq":1,"docId":"d"}"#,
            "tileRequest": #"{"type":"tileRequest","seq":1,"docId":"d","keys":[]}"#,
            "subscribed": #"{"type":"subscribed","seq":1,"docId":"d","keys":[]}"#,
            "unsubscribed": #"{"type":"unsubscribed","seq":1,"docId":"d"}"#,
            "tileRequestAccepted": #"{"type":"tileRequestAccepted","seq":1,"docId":"d"}"#,
            // Task 5.5: "byteCount", not "pixelsBase64" — see OfficeWireFrame.tile's own doc comment.
            // 0 is a perfectly fine STRUCTURAL fixture here (this test is about the envelope
            // decoding to the right CASE, not about the exact-size-or-refuse policy check, which is
            // `OfficeWireConnection.ingest`'s job — see this file's own byteCount-policy tests).
            "tile": #"{"type":"tile","seq":1,"docId":"d","key":{"part":0,"zoomPPT":1000,"tileX":0,"tileY":0},"generation":0,"width":512,"height":512,"byteCount":0}"#,
            "tileFailed": #"{"type":"tileFailed","seq":1,"docId":"d","key":{"part":0,"zoomPPT":1000,"tileX":0,"tileY":0},"reason":"r"}"#,
            "invalidated": #"{"type":"invalidated","seq":1,"docId":"d","keys":[]}"#,
        ]
        XCTAssertEqual(Set(fixtures.keys), Set(OfficeWireFrame.wireTypes),
                       "fixtures must cover exactly OfficeWireFrame.wireTypes, no more, no less")
        for type in OfficeWireFrame.wireTypes {
            let line = try XCTUnwrap(fixtures[type])
            if type == "tile" {
                // Task 5.5: "tile" is the one wireType that never decodes to `.frame` anymore — see
                // `OfficeWireInbound`'s own header. The parity claim this test makes for every other
                // type ("this fixture decodes to the case its own name says") becomes, for tile,
                // "this fixture decodes to `.tilePending`, never `.frame` or a rejection."
                guard case .tilePending = OfficeWireCodec.decodeInbound(line) else {
                    return XCTFail("\"tile\" fixture must decode to .tilePending, got \(OfficeWireCodec.decodeInbound(line))")
                }
                continue
            }
            let frame = try XCTUnwrap(OfficeWireFrame.decode(line), "\(type) fixture failed to decode")
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
        let rect = OfficeTwipsRect(x: 0, y: 0, width: 1, height: 1)
        let tileKey = TileKey(part: 0, zoomPPT: 1000, tileX: 0, tileY: 0)
        XCTAssertEqual(OfficeWireFrame.subscribeTiles(seq: 112, docId: "d", part: 0, zoomPPT: 1000, viewportTwips: rect).seq, 112)
        XCTAssertEqual(OfficeWireFrame.unsubscribe(seq: 113, docId: "d").seq, 113)
        XCTAssertEqual(OfficeWireFrame.tileRequest(seq: 114, docId: "d", keys: []).seq, 114)
        XCTAssertEqual(OfficeWireFrame.subscribed(seq: 115, docId: "d", keys: []).seq, 115)
        XCTAssertEqual(OfficeWireFrame.unsubscribed(seq: 116, docId: "d").seq, 116)
        XCTAssertEqual(OfficeWireFrame.tileRequestAccepted(seq: 117, docId: "d").seq, 117)
        XCTAssertEqual(OfficeWireFrame.tile(seq: 118, docId: "d", key: tileKey, generation: 0, width: 512, height: 512, pixels: Data()).seq, 118)
        XCTAssertEqual(OfficeWireFrame.tileFailed(seq: 119, docId: "d", key: tileKey, reason: "r").seq, 119)
        XCTAssertEqual(OfficeWireFrame.invalidated(seq: 120, docId: "d", keys: []).seq, 120)
    }

    // MARK: - The brief's literal pin: unknown type -> error{seq,reason:"unknown"}

    func testUnknownTypeIsRejectedWithSeqEchoedAndReasonUnknown() {
        switch OfficeWireCodec.decodeInbound(#"{"type":"totallyMadeUp","seq":42}"#) {
        case .rejected(let seq, let reason):
            XCTAssertEqual(seq, 42)
            XCTAssertEqual(reason, "unknown")
        case .frame, .tilePending, .unreadable:
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
        case .frame, .tilePending, .unreadable:
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
            case .frame, .tilePending, .unreadable:
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
            case .frame, .tilePending, .unreadable:
                XCTFail("expected .rejected(seq: 1, reason: \"malformed\") for: \(line)")
            }
        }
    }

    /// Task 4 — every new tile-frame shape rejects a missing/malformed field as "malformed" (never
    /// silently substitutes a default) with the real seq recovered, matching the existing frames'
    /// own discipline exactly.
    func testTileFrameMalformedShapesAreRejected() {
        let lines = [
            #"{"type":"subscribeTiles","seq":1,"docId":"d","part":0,"zoomPPT":1000}"#,           // missing viewportTwips
            #"{"type":"subscribeTiles","seq":1,"docId":"d","part":0,"zoomPPT":1000,"viewportTwips":{"x":0,"y":0,"width":1}}"#, // rect missing height
            #"{"type":"tileRequest","seq":1,"docId":"d"}"#,                                       // missing keys
            #"{"type":"tileRequest","seq":1,"docId":"d","keys":[{"part":0,"zoomPPT":1000,"tileX":0}]}"#, // key missing tileY
            // Task 5.5: "byteCount", not "pixelsBase64" — see OfficeWireFrame.tile's own doc comment.
            #"{"type":"tile","seq":1,"docId":"d","key":{"part":0,"zoomPPT":1000,"tileX":0,"tileY":0},"generation":0,"width":512,"byteCount":0}"#, // missing height
            #"{"type":"tile","seq":1,"docId":"d","key":{"part":0,"zoomPPT":1000,"tileX":0,"tileY":0},"generation":0,"width":512,"height":512}"#, // missing byteCount
            #"{"type":"tile","seq":1,"docId":"d","key":{"part":0,"zoomPPT":1000,"tileX":0,"tileY":0},"generation":0,"width":512,"height":512,"byteCount":-1}"#, // byteCount negative: structurally invalid (a count can't be negative), distinct from the exact-size POLICY refusal `OfficeWireConnection.ingest` decides for a structurally-valid-but-wrong-size byteCount
            #"{"type":"tileFailed","seq":1,"docId":"d","key":{"part":0,"zoomPPT":1000,"tileX":0,"tileY":0}}"#, // missing reason
            #"{"type":"invalidated","seq":1,"docId":"d"}"#,                                        // missing keys
        ]
        for line in lines {
            switch OfficeWireCodec.decodeInbound(line) {
            case .rejected(let seq, let reason):
                XCTAssertEqual(seq, 1)
                XCTAssertEqual(reason, "malformed", "expected malformed for: \(line)")
            case .frame, .tilePending, .unreadable:
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
    // target no test bundle can import.
    //
    // As of Task 3, no Stage-A wire verb provoked a real LOK callback (Stage A never painted a tile
    // or edited a document), so this table was the ONLY exercise of this parsing logic anywhere,
    // and every case below was read directly off the implementation, not off a live LOK firing.
    //
    // Task 4 changed that for ONE of the two parsers: `OfficeHelperLiveTests.testRealLOKCallback
    // ProbeCapturesRawPayloadsAndCrossChecksTheParsers` now spawns the real helper, opens a real
    // fixture, paints real tiles, and feeds whatever LOK actually fires through both parsers.
    // `parseModifiedStatus` WAS cross-checked there against a genuine `.uno:ModifiedStatus=false`
    // firing and parsed it correctly. `parseInvalidateTiles` was NOT — that same live probe observed
    // zero `LOK_CALLBACK_INVALIDATE_TILES` firings against a view-only document with no edit verb
    // available, so this table remains its only exercise, and every case below is still read
    // directly off the implementation rather than off live data. See that parser's own doc comment
    // in `OfficeWire.swift` for the full re-judgment of both parsers' lenient-default behaviors.

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
