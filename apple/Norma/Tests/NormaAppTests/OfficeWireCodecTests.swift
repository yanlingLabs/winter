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
        // Office Stage B Task 4 — the DEBUG-only `debugEdit`/`debugEditOk` samples (which forced
        // the `var`-plus-conditional-append shape this comment used to explain) are gone — real
        // edit verbs replace them; back to a plain `let` array literal.
        let samples: [OfficeWireFrame] = [
            .hello(seq: 1, role: .app, token: "tok-app"),
            .hello(seq: 2, role: .agent, token: "tok-agent"),
            .ping(seq: 3),
            .open(seq: 4, docId: "doc-1", path: "/tmp/a spaced name.docx"),
            .close(seq: 5, docId: "doc-1"),
            // Office Stage B Task 2 — the save round trip.
            // Fix round 4 (NEW-2) — a NON-ZERO part, deliberately: a `save` sample pinned at
            // part 0 would round-trip identically whether the field were carried or silently
            // defaulted, which is exactly the drift this table exists to catch.
            .save(seq: 30, docId: "doc-1", part: 2),
            .saved(seq: 31, docId: "doc-1", tempPath: "/tmp/state/saves/doc-1-30.xlsx"),
            .saveFailed(seq: 32, docId: "doc-1", reason: "disk full"),
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
            // Task 5 — caret/selection/cell-cursor, one sample per new OfficeDocumentEvent case.
            .documentEvent(seq: 41, docId: "doc-1", event: .caretRect(OfficeTwipsRect(x: 100, y: 200, width: 0, height: 300))),
            .documentEvent(seq: 42, docId: "doc-1", event: .textSelection([
                OfficeTwipsRect(x: 10, y: 20, width: 30, height: 40),
                OfficeTwipsRect(x: 0, y: 60, width: 500, height: 40), // a second line — the multi-rect shape
            ])),
            .documentEvent(seq: 43, docId: "doc-1", event: .textSelection([])), // no selection
            .documentEvent(seq: 44, docId: "doc-1", event: .textSelectionStart(OfficeTwipsRect(x: 10, y: 20, width: 0, height: 40))),
            .documentEvent(seq: 45, docId: "doc-1", event: .textSelectionEnd(OfficeTwipsRect(x: 500, y: 60, width: 0, height: 40))),
            .documentEvent(seq: 46, docId: "doc-1", event: .cellCursor(
                .at(rectTwips: OfficeTwipsRect(x: 0, y: 0, width: 1265, height: 254), column: 2, row: 7))),
            .documentEvent(seq: 47, docId: "doc-1", event: .cellCursor(.empty)),
            // Task 8 — the formula bar's own content feed. A formula-shaped string (special
            // characters `=`, `(`, `)`, `:` — real content, not just a plain literal) and the
            // empty string (the real captured shape for an empty cell — see `parseCellFormula`'s
            // own header) — the SAME two-samples-per-case discipline `cellCursor`'s `.at`/`.empty`
            // pair above already uses.
            .documentEvent(seq: 66, docId: "doc-1", event: .cellFormula("=SUM(A1:A2)")),
            .documentEvent(seq: 67, docId: "doc-1", event: .cellFormula("")),
            // Task 7 — the autosave sidecar push. Both `isODFFallback` values, and an `ext` that
            // DIFFERS from what a bare boolean round-trip would still pass with a hardcoded value
            // — a sample pinned at, say, `ext: "odt"` for the fallback row would round-trip
            // identically whether `ext` were carried or silently defaulted to the document's own
            // native extension, exactly the drift class this table exists to catch (mirrors the
            // `save`/`part: 2` sample's own non-zero-on-purpose reasoning immediately above).
            .documentEvent(seq: 48, docId: "doc-1", event: .autosaved(ext: "odt", isODFFallback: false)),
            .documentEvent(seq: 49, docId: "doc-1", event: .autosaved(ext: "ods", isODFFallback: true)),
            // Task 4 — tile pipeline frames.
            .subscribeTiles(seq: 20, docId: "doc-1", part: 0, zoomPPT: 1000,
                             viewportTwips: OfficeTwipsRect(x: 0, y: 0, width: 10240, height: 5120)),
            .unsubscribe(seq: 21, docId: "doc-1"),
            .tileRequest(seq: 22, docId: "doc-1", keys: [
                TileKey(part: 0, zoomPPT: 1000, tileX: 0, tileY: 0),
                TileKey(part: 0, zoomPPT: 1000, tileX: 1, tileY: 0),
            ]),
            .tileRequest(seq: 23, docId: "doc-1", keys: []), // an empty key list is a legal (if pointless) request
            // Office Stage B Task 4 — the real edit verbs.
            .keyEvent(seq: 35, docId: "doc-1", part: 0, type: .keyInput, charCode: 65, keyCode: 512),
            .keyEvent(seq: 36, docId: "doc-1", part: 0, type: .keyUp, charCode: 0, keyCode: 1026),
            .keyEventOk(seq: 37, docId: "doc-1"),
            .mouseEvent(seq: 38, docId: "doc-1", part: 0, type: .buttonDown, xTwips: 100, yTwips: 200,
                        count: 1, buttons: 1, modifiers: 0),
            .mouseEvent(seq: 39, docId: "doc-1", part: 0, type: .move, xTwips: -50, yTwips: 0,
                        count: 0, buttons: 1, modifiers: 0x1000),
            .mouseEventOk(seq: 40, docId: "doc-1"),
            // Office Stage B Task 5 — the IME marked-text/commit verbs. `text: ""` on the `.end`
            // sample is deliberate, not a placeholder — see `OfficeWireFrame.extTextInputEvent`'s own
            // header: this bridge's own caller always sends `.end` with empty text (LOK's own
            // `LOK_EXT_TEXTINPUT_END` ignores whatever text it's given anyway).
            .extTextInputEvent(seq: 48, docId: "doc-1", part: 0, type: .input, text: "e"),
            .extTextInputEvent(seq: 49, docId: "doc-1", part: 2, type: .end, text: ""),
            .extTextInputEventOk(seq: 50, docId: "doc-1"),
            // Office Stage B Task 6 — clipboard, undo/redo, the second ("agent") view.
            .clipboardCopy(seq: 51, docId: "doc-1", part: 0),
            .clipboardCopyOk(seq: 52, docId: "doc-1", text: "selected text"),
            .clipboardCopyOk(seq: 53, docId: "doc-1", text: ""), // no selection
            .clipboardCut(seq: 54, docId: "doc-1", part: 1),
            .clipboardCutOk(seq: 55, docId: "doc-1", text: "cut text"),
            .clipboardPaste(seq: 56, docId: "doc-1", part: 0, text: "pasted text"),
            .clipboardPasteOk(seq: 57, docId: "doc-1"),
            .undo(seq: 58, docId: "doc-1"),
            .undoOk(seq: 59, docId: "doc-1"),
            .redo(seq: 60, docId: "doc-1"),
            .redoOk(seq: 61, docId: "doc-1"),
            // office-live-edit R3 — the `repair` arm of undo/redo. BOTH polarities ride this
            // round-trip: `repair: false` must encode to the SAME bytes the pre-repair frame did
            // (the encoder omits the key), and `repair: true` must survive encode→decode. A
            // round-trip that only carried `true` would pass even if the encoder had started
            // emitting `"repair":false` on every frame.
            .undo(seq: 158, docId: "doc-1", repair: true),
            .undo(seq: 159, docId: "doc-1", repair: false),
            .redo(seq: 160, docId: "doc-1", repair: true),
            .redo(seq: 161, docId: "doc-1", repair: false),
            .undoDepth(seq: 162, docId: "doc-1"),
            // `0` is a real, expected answer (a pristine document) and must round-trip as one —
            // this wire never uses 0 as an "unknown" sentinel; an unanswerable query is `.error`.
            .undoDepthOk(seq: 163, docId: "doc-1", undoCount: 0, redoCount: 0),
            .undoDepthOk(seq: 164, docId: "doc-1", undoCount: 12, redoCount: 4),
            .createView(seq: 62, docId: "doc-1"),
            .agentViewReady(seq: 63, docId: "doc-1", viewId: 2),
            .agentKeyEvent(seq: 64, docId: "doc-1", part: 0, type: .keyInput, charCode: 65, keyCode: 512),
            .agentKeyEventOk(seq: 65, docId: "doc-1"),
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
            // office-agent-tools T3 — sheets info/read.
            .sheetsInfo(seq: 68, docId: "doc-1"),
            .sheetsRead(seq: 69, docId: "doc-1", sheet: "Sheet1", range: "A1:C10", formulas: false),
            .sheetsRead(seq: 70, docId: "doc-1", sheet: "Q1 Recap", range: "B6", formulas: true), // one-cell range, formulas:true, a name with a space
            .sheetsInfoOk(seq: 71, docId: "doc-1", sheets: [
                OfficeSheetInfo(name: "Sheet1", usedEndColumn: 2, usedEndRow: 9),
                OfficeSheetInfo(name: "Empty Sheet", usedEndColumn: -1, usedEndRow: -1), // the wholly-empty sentinel
            ], activeSheet: "Sheet1"),
            .sheetsReadOk(seq: 72, docId: "doc-1", rows: [
                ["42", "Hello", ""],       // "" — a genuinely empty cell, never an absent element
                ["1", "=SUM(A1:B1)", "3"],
            ], displayRestoreVerified: true),
            // office-polish final check — BOTH values of `displayRestoreVerified` in this list, so
            // the round-trip covers the flag rather than only its default.
            .sheetsReadOk(seq: 73, docId: "doc-1", rows: [], displayRestoreVerified: false), // a range whose sheet turned out to have nothing there
            // office-agent-tools T5 — sheets format. Every optional field gets a nil AND a non-nil
            // sample somewhere in this list, including the columnSpan<->width pairing.
            .sheetsFormat(seq: 74, docId: "doc-1", sheet: "Sheet1", range: "A1:C10", columnSpan: nil,
                         bold: true, italic: nil, numberFormat: nil, align: nil, width: nil),
            .sheetsFormat(seq: 75, docId: "doc-1", sheet: "Sheet1", range: "B2", columnSpan: nil,
                         bold: nil, italic: false, numberFormat: .percent, align: .center, width: nil),
            .sheetsFormat(seq: 76, docId: "doc-1", sheet: "Q1 Recap", range: "B2:B5", columnSpan: "B:B",
                         bold: nil, italic: nil, numberFormat: nil, align: nil, width: 72.5),
            .sheetsFormatOk(seq: 77, docId: "doc-1", applied: ["bold", "align"]),
            .sheetsFormatOk(seq: 78, docId: "doc-1", applied: ["width"]),
            // office-agent-tools T6 — slides. Every optional field gets a nil AND a non-nil sample,
            // including slidesManagePage's three per-op field shapes (add/delete/reorder) and
            // slidesReadOk's load-bearing nil ("no such placeholder") vs "" ("empty placeholder")
            // distinction.
            .slidesInfo(seq: 79, docId: "doc-1"),
            .slidesRead(seq: 80, docId: "doc-1", slide: 0),
            .slidesRead(seq: 81, docId: "doc-1", slide: 2),
            .slidesInfoOk(seq: 82, docId: "doc-1", slides: [
                OfficeSlideInfo(name: "Slide1", title: "Q3 Revenue"),
                OfficeSlideInfo(name: "Slide2", title: nil), // no title placeholder on this slide at all
            ]),
            .slidesReadOk(seq: 83, docId: "doc-1", title: "Q3 Revenue", body: "bullet one"),
            .slidesReadOk(seq: 84, docId: "doc-1", title: nil, body: ""), // no title placeholder at all vs an empty body placeholder
            .slidesSetText(seq: 85, docId: "doc-1", slide: 1, title: "New Title", body: nil),
            .slidesSetText(seq: 86, docId: "doc-1", slide: 1, title: nil, body: "New body"),
            .slidesSetTextOk(seq: 87, docId: "doc-1", applied: ["title", "body"]),
            .slidesManagePage(seq: 88, docId: "doc-1", op: .add, slide: nil, at: nil, to: nil, layout: nil),
            .slidesManagePage(seq: 89, docId: "doc-1", op: .add, slide: nil, at: 1, to: nil, layout: .titleContent),
            .slidesManagePage(seq: 90, docId: "doc-1", op: .delete, slide: 2, at: nil, to: nil, layout: nil),
            .slidesManagePage(seq: 91, docId: "doc-1", op: .reorder, slide: 0, at: nil, to: 2, layout: nil),
            .slidesManagePageOk(seq: 92, docId: "doc-1", slideCount: 3),
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
            "save": #"{"type":"save","seq":1,"docId":"d","part":0}"#,
            "helloOk": #"{"type":"helloOk","seq":1,"lokVersion":"v"}"#,
            "refused": #"{"type":"refused","seq":1,"reason":"r"}"#,
            "pong": #"{"type":"pong","seq":1}"#,
            "opened": #"{"type":"opened","seq":1,"docId":"d","docType":"text","parts":1,"widthTwips":100,"heightTwips":200}"#,
            "openFailed": #"{"type":"openFailed","seq":1,"docId":"d","reason":"r"}"#,
            "closed": #"{"type":"closed","seq":1,"docId":"d"}"#,
            "saved": #"{"type":"saved","seq":1,"docId":"d","tempPath":"/tmp/p"}"#,
            "saveFailed": #"{"type":"saveFailed","seq":1,"docId":"d","reason":"r"}"#,
            "keyEvent": #"{"type":"keyEvent","seq":1,"docId":"d","part":0,"eventType":0,"charCode":65,"keyCode":512}"#,
            "mouseEvent": #"{"type":"mouseEvent","seq":1,"docId":"d","part":0,"eventType":0,"xTwips":0,"yTwips":0,"count":1,"buttons":1,"modifiers":0}"#,
            "extTextInputEvent": #"{"type":"extTextInputEvent","seq":1,"docId":"d","part":0,"eventType":0,"text":"e"}"#,
            "keyEventOk": #"{"type":"keyEventOk","seq":1,"docId":"d"}"#,
            "mouseEventOk": #"{"type":"mouseEventOk","seq":1,"docId":"d"}"#,
            "extTextInputEventOk": #"{"type":"extTextInputEventOk","seq":1,"docId":"d"}"#,
            // Office Stage B Task 6 — clipboard, undo/redo, the second ("agent") view.
            "clipboardCopy": #"{"type":"clipboardCopy","seq":1,"docId":"d","part":0}"#,
            "clipboardCut": #"{"type":"clipboardCut","seq":1,"docId":"d","part":0}"#,
            "clipboardPaste": #"{"type":"clipboardPaste","seq":1,"docId":"d","part":0,"text":"x"}"#,
            "undo": #"{"type":"undo","seq":1,"docId":"d"}"#,
            "redo": #"{"type":"redo","seq":1,"docId":"d"}"#,
            "createView": #"{"type":"createView","seq":1,"docId":"d"}"#,
            "agentKeyEvent": #"{"type":"agentKeyEvent","seq":1,"docId":"d","part":0,"eventType":0,"charCode":65,"keyCode":512}"#,
            "clipboardCopyOk": #"{"type":"clipboardCopyOk","seq":1,"docId":"d","text":"x"}"#,
            "clipboardCutOk": #"{"type":"clipboardCutOk","seq":1,"docId":"d","text":"x"}"#,
            "clipboardPasteOk": #"{"type":"clipboardPasteOk","seq":1,"docId":"d"}"#,
            "undoDepth": #"{"type":"undoDepth","seq":1,"docId":"d"}"#,
            "undoDepthOk": #"{"type":"undoDepthOk","seq":1,"docId":"d","undoCount":3,"redoCount":0}"#,
            "undoOk": #"{"type":"undoOk","seq":1,"docId":"d"}"#,
            "redoOk": #"{"type":"redoOk","seq":1,"docId":"d"}"#,
            "agentViewReady": #"{"type":"agentViewReady","seq":1,"docId":"d","viewId":2}"#,
            "agentKeyEventOk": #"{"type":"agentKeyEventOk","seq":1,"docId":"d"}"#,
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
            // office-agent-tools T3 — sheets info/read.
            "sheetsInfo": #"{"type":"sheetsInfo","seq":1,"docId":"d"}"#,
            "sheetsRead": #"{"type":"sheetsRead","seq":1,"docId":"d","sheet":"Sheet1","range":"A1","formulas":false}"#,
            "sheetsInfoOk": #"{"type":"sheetsInfoOk","seq":1,"docId":"d","sheets":[],"activeSheet":"Sheet1"}"#,
            "sheetsReadOk": #"{"type":"sheetsReadOk","seq":1,"docId":"d","rows":[]}"#,
            // office-agent-tools T4 — sheets write verbs.
            "sheetsSet": #"{"type":"sheetsSet","seq":1,"docId":"d","sheet":"Sheet1","range":"A1","cellAddresses":["A1"],"cellValues":["x"]}"#,
            "sheetsResize": #"{"type":"sheetsResize","seq":1,"docId":"d","sheet":"Sheet1","dimension":"row","op":"insert","selectionRange":"1:1"}"#,
            "sheetsManageSheet": #"{"type":"sheetsManageSheet","seq":1,"docId":"d","op":"add","name":"Q3"}"#,
            "sheetsManageSheetBatch": #"{"type":"sheetsManageSheetBatch","seq":1,"docId":"d","ops":[{"op":"add","name":"Q3"}]}"#,
            "sheetsSetOk": #"{"type":"sheetsSetOk","seq":1,"docId":"d","cellsWritten":1}"#,
            "sheetsResizeOk": #"{"type":"sheetsResizeOk","seq":1,"docId":"d","usedEndColumn":1,"usedEndRow":1}"#,
            "sheetsManageSheetOk": #"{"type":"sheetsManageSheetOk","seq":1,"docId":"d","sheets":["Sheet1","Q3"]}"#,
            "sheetsManageSheetBatchOk": #"{"type":"sheetsManageSheetBatchOk","seq":1,"docId":"d","sheets":["Sheet1","Q3"],"applied":1}"#,
            // office-agent-tools T5 — sheets format.
            "sheetsFormat": #"{"type":"sheetsFormat","seq":1,"docId":"d","sheet":"Sheet1","range":"A1:C10","bold":true}"#,
            "sheetsFormatOk": #"{"type":"sheetsFormatOk","seq":1,"docId":"d","applied":["bold"]}"#,
            // office-format — docs/slides format. `docsFormat`'s `find` is deliberately ABSENT here:
            // that is the whole-document scope, the shape a fixture should pin because it is the one
            // where an over-eager decode would silently widen the blast radius.
            "docsFormat": #"{"type":"docsFormat","seq":1,"docId":"d","bold":true,"align":"center"}"#,
            "docsFormatOk": #"{"type":"docsFormatOk","seq":1,"docId":"d","applied":["bold"],"verified":["bold"],"verifyAvailable":true,"occurrences":0}"#,
            "slidesFormat": #"{"type":"slidesFormat","seq":1,"docId":"d","slide":0,"placeholder":"title","bold":true}"#,
            "slidesFormatOk": #"{"type":"slidesFormatOk","seq":1,"docId":"d","applied":["bold"]}"#,
            // office-agent-tools T6 — slides.
            "slidesInfo": #"{"type":"slidesInfo","seq":1,"docId":"d"}"#,
            "slidesRead": #"{"type":"slidesRead","seq":1,"docId":"d","slide":0}"#,
            "slidesSetText": #"{"type":"slidesSetText","seq":1,"docId":"d","slide":0,"title":"T"}"#,
            // `.add`'s own legal minimal shape (slide/to absent) — see `slidesManagePage`'s own
            // header for the per-op field contract this fixture satisfies.
            "slidesManagePage": #"{"type":"slidesManagePage","seq":1,"docId":"d","op":"add"}"#,
            "slidesManagePageBatch": #"{"type":"slidesManagePageBatch","seq":1,"docId":"d","ops":[{"op":"delete","slide":0}]}"#,
            "slidesInfoOk": #"{"type":"slidesInfoOk","seq":1,"docId":"d","slides":[]}"#,
            "slidesReadOk": #"{"type":"slidesReadOk","seq":1,"docId":"d"}"#,
            "slidesSetTextOk": #"{"type":"slidesSetTextOk","seq":1,"docId":"d","applied":["title"]}"#,
            "slidesManagePageOk": #"{"type":"slidesManagePageOk","seq":1,"docId":"d","slideCount":1}"#,
            "slidesManagePageBatchOk": #"{"type":"slidesManagePageBatchOk","seq":1,"docId":"d","slideCount":1,"applied":1}"#,
            // office-agent-tools T7 — docs. `docsReplace`'s `find` is non-empty and newline-free and
            // `docsInsert`'s `text` is non-empty because the decoder REFUSES otherwise (see those
            // cases' own decode guards) — a fixture that skipped those fields would decode as
            // `.rejected` and this test would fail on the case name, which is the intended shape.
            "docsInfo": #"{"type":"docsInfo","seq":1,"docId":"d"}"#,
            "docsRead": #"{"type":"docsRead","seq":1,"docId":"d"}"#,
            "docsReplace": #"{"type":"docsReplace","seq":1,"docId":"d","find":"a","replaceWith":"b"}"#,
            "docsInsert": #"{"type":"docsInsert","seq":1,"docId":"d","text":"x","atStart":false,"asNewParagraph":true}"#,
            "docsInfoOk": #"{"type":"docsInfoOk","seq":1,"docId":"d","pages":1,"paragraphs":2,"characters":9}"#,
            "docsReadOk": #"{"type":"docsReadOk","seq":1,"docId":"d","text":"one\ntwo"}"#,
            "docsReplaceOk": #"{"type":"docsReplaceOk","seq":1,"docId":"d","replaced":2}"#,
            "docsInsertOk": #"{"type":"docsInsertOk","seq":1,"docId":"d","paragraphs":4}"#,
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
        XCTAssertEqual(OfficeWireFrame.save(seq: 121, docId: "d", part: 1).seq, 121)
        XCTAssertEqual(OfficeWireFrame.saved(seq: 122, docId: "d", tempPath: "/p").seq, 122)
        XCTAssertEqual(OfficeWireFrame.saveFailed(seq: 123, docId: "d", reason: "r").seq, 123)
        XCTAssertEqual(OfficeWireFrame.keyEvent(seq: 126, docId: "d", part: 0, type: .keyInput, charCode: 65, keyCode: 512).seq, 126)
        XCTAssertEqual(OfficeWireFrame.mouseEvent(seq: 127, docId: "d", part: 0, type: .buttonDown, xTwips: 0, yTwips: 0,
                                                   count: 1, buttons: 1, modifiers: 0).seq, 127)
        XCTAssertEqual(OfficeWireFrame.keyEventOk(seq: 128, docId: "d").seq, 128)
        XCTAssertEqual(OfficeWireFrame.mouseEventOk(seq: 129, docId: "d").seq, 129)
        XCTAssertEqual(OfficeWireFrame.extTextInputEvent(seq: 130, docId: "d", part: 0, type: .input, text: "x").seq, 130)
        XCTAssertEqual(OfficeWireFrame.extTextInputEventOk(seq: 131, docId: "d").seq, 131)
        XCTAssertEqual(OfficeWireFrame.clipboardCopy(seq: 132, docId: "d", part: 0).seq, 132)
        XCTAssertEqual(OfficeWireFrame.clipboardCopyOk(seq: 133, docId: "d", text: "x").seq, 133)
        XCTAssertEqual(OfficeWireFrame.clipboardCut(seq: 134, docId: "d", part: 0).seq, 134)
        XCTAssertEqual(OfficeWireFrame.clipboardCutOk(seq: 135, docId: "d", text: "x").seq, 135)
        XCTAssertEqual(OfficeWireFrame.clipboardPaste(seq: 136, docId: "d", part: 0, text: "x").seq, 136)
        XCTAssertEqual(OfficeWireFrame.clipboardPasteOk(seq: 137, docId: "d").seq, 137)
        XCTAssertEqual(OfficeWireFrame.undo(seq: 138, docId: "d").seq, 138)
        XCTAssertEqual(OfficeWireFrame.undoOk(seq: 139, docId: "d").seq, 139)
        XCTAssertEqual(OfficeWireFrame.redo(seq: 140, docId: "d").seq, 140)
        XCTAssertEqual(OfficeWireFrame.redoOk(seq: 141, docId: "d").seq, 141)
        XCTAssertEqual(OfficeWireFrame.createView(seq: 142, docId: "d").seq, 142)
        XCTAssertEqual(OfficeWireFrame.agentViewReady(seq: 143, docId: "d", viewId: 2).seq, 143)
        XCTAssertEqual(OfficeWireFrame.agentKeyEvent(seq: 144, docId: "d", part: 0, type: .keyInput, charCode: 65, keyCode: 512).seq, 144)
        XCTAssertEqual(OfficeWireFrame.agentKeyEventOk(seq: 145, docId: "d").seq, 145)
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
        XCTAssertEqual(OfficeWireFrame.sheetsInfo(seq: 146, docId: "d").seq, 146)
        XCTAssertEqual(OfficeWireFrame.sheetsRead(seq: 147, docId: "d", sheet: "Sheet1", range: "A1", formulas: false).seq, 147)
        XCTAssertEqual(OfficeWireFrame.sheetsInfoOk(seq: 148, docId: "d", sheets: [], activeSheet: "Sheet1").seq, 148)
        XCTAssertEqual(OfficeWireFrame.sheetsReadOk(seq: 149, docId: "d", rows: [], displayRestoreVerified: true).seq, 149)
        XCTAssertEqual(OfficeWireFrame.sheetsFormat(seq: 150, docId: "d", sheet: "Sheet1", range: "A1",
                                                     columnSpan: nil, bold: true, italic: nil,
                                                     numberFormat: nil, align: nil, width: nil).seq, 150)
        XCTAssertEqual(OfficeWireFrame.sheetsFormatOk(seq: 151, docId: "d", applied: ["bold"]).seq, 151)
        XCTAssertEqual(OfficeWireFrame.slidesInfo(seq: 152, docId: "d").seq, 152)
        XCTAssertEqual(OfficeWireFrame.slidesRead(seq: 153, docId: "d", slide: 0).seq, 153)
        XCTAssertEqual(OfficeWireFrame.slidesSetText(seq: 154, docId: "d", slide: 0, title: "T", body: nil).seq, 154)
        XCTAssertEqual(OfficeWireFrame.slidesManagePage(seq: 155, docId: "d", op: .add, slide: nil, at: nil,
                                                         to: nil, layout: nil).seq, 155)
        XCTAssertEqual(OfficeWireFrame.slidesInfoOk(seq: 156, docId: "d", slides: []).seq, 156)
        XCTAssertEqual(OfficeWireFrame.slidesReadOk(seq: 157, docId: "d", title: nil, body: nil).seq, 157)
        XCTAssertEqual(OfficeWireFrame.slidesSetTextOk(seq: 158, docId: "d", applied: ["title"]).seq, 158)
        XCTAssertEqual(OfficeWireFrame.slidesManagePageOk(seq: 159, docId: "d", slideCount: 1).seq, 159)
    }

    // MARK: - The brief's literal pin: unknown type -> error{seq,reason:"unknown"}

    func testUnknownTypeIsRejectedWithSeqEchoedAndReasonUnknown() {
        switch OfficeWireCodec.decodeInbound(#"{"type":"totallyMadeUp","seq":42}"#) {
        case .rejected(let seq, let reason):
            XCTAssertEqual(seq, 42)
            XCTAssertEqual(reason, "unknown")
        case .frame, .tilePending, .tileHeaderMalformed, .unreadable:
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
        case .frame, .tilePending, .tileHeaderMalformed, .unreadable:
            XCTFail("expected .rejected(seq: 7, reason: \"malformed\")")
        }
    }

    /// Fix round 1, F2 — `part` is now a REQUIRED field on `keyEvent`/`mouseEvent`, exactly like
    /// every other required field on this wire: missing it is "malformed," never a silent default.
    /// This is the wire-decode-level pin for F2's fix (the store/bridge/LOK-thread half is proven
    /// live by `OfficeRuntimeLiveTests`' two-part drill).
    func testKeyEventAndMouseEventMissingPartIsMalformed() {
        let missingPartKeyEvent = #"{"type":"keyEvent","seq":1,"docId":"d","eventType":0,"charCode":65,"keyCode":512}"#
        let missingPartMouseEvent = #"{"type":"mouseEvent","seq":1,"docId":"d","eventType":0,"xTwips":0,"yTwips":0,"count":1,"buttons":1,"modifiers":0}"#
        for line in [missingPartKeyEvent, missingPartMouseEvent] {
            switch OfficeWireCodec.decodeInbound(line) {
            case .rejected(let seq, let reason):
                XCTAssertEqual(seq, 1)
                XCTAssertEqual(reason, "malformed", "expected malformed for: \(line)")
            case .frame, .tilePending, .tileHeaderMalformed, .unreadable:
                XCTFail("expected .rejected(seq: 1, reason: \"malformed\") for: \(line)")
            }
        }
    }

    /// office-agent-tools T6 — `slidesManagePage`'s own per-op paired-field guard (its own case
    /// header states the contract this pins): each row is a shape that is malformed for the op it
    /// claims, and each is malformed for a DIFFERENT reason (an extra field the op forbids, or a
    /// missing field the op requires) — not just one representative case, since the guard is a
    /// three-way conditional, not a single boolean pairing like `sheetsManageSheet`'s `op == .rename
    /// <-> newName != nil`.
    func testSlidesManagePagePerOpFieldShapeIsRejectedAsMalformed() {
        let addWithSlide = #"{"type":"slidesManagePage","seq":1,"docId":"d","op":"add","slide":0}"#
        let addWithTo = #"{"type":"slidesManagePage","seq":1,"docId":"d","op":"add","to":1}"#
        let deleteMissingSlide = #"{"type":"slidesManagePage","seq":1,"docId":"d","op":"delete"}"#
        let deleteWithAt = #"{"type":"slidesManagePage","seq":1,"docId":"d","op":"delete","slide":0,"at":1}"#
        let deleteWithLayout = #"{"type":"slidesManagePage","seq":1,"docId":"d","op":"delete","slide":0,"layout":"blank"}"#
        let reorderMissingTo = #"{"type":"slidesManagePage","seq":1,"docId":"d","op":"reorder","slide":0}"#
        let reorderMissingSlide = #"{"type":"slidesManagePage","seq":1,"docId":"d","op":"reorder","to":1}"#
        let reorderWithAt = #"{"type":"slidesManagePage","seq":1,"docId":"d","op":"reorder","slide":0,"to":1,"at":2}"#
        let unrecognizedOp = #"{"type":"slidesManagePage","seq":1,"docId":"d","op":"duplicate","slide":0}"#
        for line in [addWithSlide, addWithTo, deleteMissingSlide, deleteWithAt, deleteWithLayout,
                     reorderMissingTo, reorderMissingSlide, reorderWithAt, unrecognizedOp] {
            switch OfficeWireCodec.decodeInbound(line) {
            case .rejected(let seq, let reason):
                XCTAssertEqual(seq, 1, "for: \(line)")
                XCTAssertEqual(reason, "malformed", "for: \(line)")
            case .frame, .tilePending, .tileHeaderMalformed, .unreadable:
                XCTFail("expected .rejected(seq: 1, reason: \"malformed\") for: \(line)")
            }
        }
        // The legal shape for every op, confirmed to decode — the deletion-red half of this pin:
        // without it, a guard that rejects EVERYTHING would also pass every case above vacuously.
        let legalAdd = #"{"type":"slidesManagePage","seq":2,"docId":"d","op":"add","at":1,"layout":"blank"}"#
        let legalDelete = #"{"type":"slidesManagePage","seq":3,"docId":"d","op":"delete","slide":0}"#
        let legalReorder = #"{"type":"slidesManagePage","seq":4,"docId":"d","op":"reorder","slide":0,"to":1}"#
        for line in [legalAdd, legalDelete, legalReorder] {
            guard case .frame(.slidesManagePage) = OfficeWireCodec.decodeInbound(line) else {
                return XCTFail("expected a legal .slidesManagePage frame for: \(line)")
            }
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
            case .frame, .tilePending, .tileHeaderMalformed, .unreadable:
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
            // Task 7 — autosaved: both fields required, wire-strictness house norm.
            #"{"type":"documentEvent","seq":1,"docId":"d","kind":"autosaved"}"#,                       // missing both
            #"{"type":"documentEvent","seq":1,"docId":"d","kind":"autosaved","ext":"odt"}"#,           // missing isODFFallback
            #"{"type":"documentEvent","seq":1,"docId":"d","kind":"autosaved","isODFFallback":true}"#,  // missing ext
            #"{"type":"documentEvent","seq":1,"docId":"d","kind":"autosaved","ext":"","isODFFallback":false}"#, // empty ext
            #"{"type":"documentEvent","seq":1,"docId":"d","kind":"autosaved","ext":"odt","isODFFallback":1}"#, // NSNumber-boolean trap
            // Task 8 — cellFormula: "text" required, wire-strictness (a missing field must never
            // silently default to "" — indistinguishable from a real empty cell's own genuine payload).
            #"{"type":"documentEvent","seq":1,"docId":"d","kind":"cellFormula"}"#, // missing text
        ]
        for line in lines {
            switch OfficeWireCodec.decodeInbound(line) {
            case .rejected(let seq, let reason):
                XCTAssertEqual(seq, 1)
                XCTAssertEqual(reason, "malformed", "expected malformed for: \(line)")
            case .frame, .tilePending, .tileHeaderMalformed, .unreadable:
                XCTFail("expected .rejected(seq: 1, reason: \"malformed\") for: \(line)")
            }
        }
    }

    /// Task 4 — every new tile-frame shape rejects a missing/malformed field as "malformed" (never
    /// silently substitutes a default) with the real seq recovered, matching the existing frames'
    /// own discipline exactly. **Wave fix (T5.5 review Minor-B)**: `"tile"`'s own three malformed
    /// shapes moved to `testTileHeaderMalformedShapesAreTileHeaderMalformedNotRejected` below — they
    /// now decode to the dedicated `.tileHeaderMalformed`, not `.rejected` (see `OfficeWireInbound`'s
    /// own header for why "tile" alone needs the distinction).
    func testTileFrameMalformedShapesAreRejected() {
        let lines = [
            #"{"type":"subscribeTiles","seq":1,"docId":"d","part":0,"zoomPPT":1000}"#,           // missing viewportTwips
            #"{"type":"subscribeTiles","seq":1,"docId":"d","part":0,"zoomPPT":1000,"viewportTwips":{"x":0,"y":0,"width":1}}"#, // rect missing height
            #"{"type":"tileRequest","seq":1,"docId":"d"}"#,                                       // missing keys
            #"{"type":"tileRequest","seq":1,"docId":"d","keys":[{"part":0,"zoomPPT":1000,"tileX":0}]}"#, // key missing tileY
            #"{"type":"tileFailed","seq":1,"docId":"d","key":{"part":0,"zoomPPT":1000,"tileX":0,"tileY":0}}"#, // missing reason
            #"{"type":"invalidated","seq":1,"docId":"d"}"#,                                        // missing keys
        ]
        for line in lines {
            switch OfficeWireCodec.decodeInbound(line) {
            case .rejected(let seq, let reason):
                XCTAssertEqual(seq, 1)
                XCTAssertEqual(reason, "malformed", "expected malformed for: \(line)")
            case .frame, .tilePending, .tileHeaderMalformed, .unreadable:
                XCTFail("expected .rejected(seq: 1, reason: \"malformed\") for: \(line)")
            }
        }
    }

    /// **Wave fix (T5.5 review Minor-B)**: split out of `testTileFrameMalformedShapesAreRejected`
    /// above — a `"tile"` line whose OWN structure fails to decode is `.tileHeaderMalformed`, a
    /// dedicated outcome `OfficeWireConnection.ingest` refuses the connection over (rather than
    /// `.rejected`'s "log and keep scanning," which would newline-scan into any raw payload bytes
    /// that follow — see `OfficeWireInbound.tileHeaderMalformed`'s own header).
    func testTileHeaderMalformedShapesAreTileHeaderMalformedNotRejected() {
        // Task 5.5: "byteCount", not "pixelsBase64" — see OfficeWireFrame.tile's own doc comment.
        let lines = [
            #"{"type":"tile","seq":1,"docId":"d","key":{"part":0,"zoomPPT":1000,"tileX":0,"tileY":0},"generation":0,"width":512,"byteCount":0}"#, // missing height
            #"{"type":"tile","seq":1,"docId":"d","key":{"part":0,"zoomPPT":1000,"tileX":0,"tileY":0},"generation":0,"width":512,"height":512}"#, // missing byteCount
            #"{"type":"tile","seq":1,"docId":"d","key":{"part":0,"zoomPPT":1000,"tileX":0,"tileY":0},"generation":0,"width":512,"height":512,"byteCount":-1}"#, // byteCount negative: structurally invalid (a count can't be negative), distinct from the exact-size POLICY refusal `OfficeWireConnection.ingest` decides for a structurally-valid-but-wrong-size byteCount
        ]
        for line in lines {
            switch OfficeWireCodec.decodeInbound(line) {
            case .tileHeaderMalformed(let seq, let reason):
                XCTAssertEqual(seq, 1)
                XCTAssertEqual(reason, "malformed", "expected malformed for: \(line)")
            case .frame, .tilePending, .rejected, .unreadable:
                XCTFail("expected .tileHeaderMalformed(seq: 1, reason: \"malformed\") for: \(line)")
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
                       "bare EMPTY (no part-in-invalidation feature) means the whole document; part defaults to 0")
        XCTAssertEqual(OfficeDocumentEvent.parseInvalidateTiles("  EMPTY  "), .invalidated(rectsTwips: [], part: 0),
                       "surrounding whitespace is trimmed before the EMPTY comparison")
    }

    /// Fix round 1, F3 (CRITICAL) — **the real wire shape, confirmed against LO core's own writer**
    /// (`RectangleAndPart::toString()`, `desktop/inc/lib/init.hxx`): with
    /// `LOK_FEATURE_PART_IN_INVALIDATION_CALLBACK` on (always, in `LOKBridge`), a whole-document
    /// invalidation is NEVER bare `"EMPTY"` — it is always `"EMPTY, <part>, <mode>"`. The OLD parser
    /// (`trimmed == "EMPTY"` exact match) rejected this outright: `parseInvalidateTiles` returned
    /// `nil`, and the callback was silently dropped — a genuine whole-document invalidation that
    /// never reached `TileCache.invalidate`, leaving stale pixels no scroll/zoom could ever correct.
    /// This test is the one that would have failed against the pre-fix parser; the previous version
    /// of `testParseInvalidateTilesRecognizedShapes` above only ever exercised bare `"EMPTY"`, which
    /// is why this bug shipped past that table uncaught.
    func testParseInvalidateTilesEmptyWithPartAndModeTheRealUpstreamShape() {
        XCTAssertEqual(OfficeDocumentEvent.parseInvalidateTiles("EMPTY, 0, 0"), .invalidated(rectsTwips: [], part: 0),
                       "the real shape RectangleAndPart::toString() emits for part 0 whole-document invalidation")
        XCTAssertEqual(OfficeDocumentEvent.parseInvalidateTiles("EMPTY, 3, 0"), .invalidated(rectsTwips: [], part: 3),
                       "part is fields[1]; mode (fields[2]) is parsed and discarded")
        XCTAssertEqual(OfficeDocumentEvent.parseInvalidateTiles("EMPTY,0,0"), .invalidated(rectsTwips: [], part: 0),
                       "no space after commas parses identically to the spaced form")
    }

    /// Fix round 1, F3 — LO's own READER (`RectangleAndPart::Create`, same file) tolerates mode
    /// being absent even when part is present (`bHasMode = nSeparatorPos > 0`) — mirrored here even
    /// though LO's own WRITER never actually emits this shape (`toString()` always appends both or
    /// neither), the same "accept more than we ever expect to receive" leniency this parser already
    /// takes for the numeric-rect branch's optional 5th field.
    func testParseInvalidateTilesEmptyWithPartButNoModeStillParses() {
        XCTAssertEqual(OfficeDocumentEvent.parseInvalidateTiles("EMPTY, 3"), .invalidated(rectsTwips: [], part: 3))
    }

    /// Fix round 1, F3 — LO reserves `-1` for "all parts" (`init.hxx`'s own `m_nPart(INT_MIN)`/
    /// "-1 is reserved to mean 'all parts'" comment; `RectangleAndPart::toString()` serializes any
    /// `m_nPart >= -1`, so `-1` legitimately reaches the wire on EITHER the EMPTY or the rect-
    /// bearing shape). The parser passes it through unchanged in both cases — `Int` parses a
    /// leading "-" the same as any other digit string; what actually HONORS `-1` is
    /// `TileCache.invalidate`'s own fix-round update (`TileCacheTests`' own pin), not this parser.
    func testParseInvalidateTilesPassesThroughLOKsAllPartsNegativeOneSentinelUnchanged() {
        XCTAssertEqual(OfficeDocumentEvent.parseInvalidateTiles("EMPTY, -1, 0"), .invalidated(rectsTwips: [], part: -1))
        XCTAssertEqual(OfficeDocumentEvent.parseInvalidateTiles("10, 20, 300, 400, -1"),
                       .invalidated(rectsTwips: [OfficeTwipsRect(x: 10, y: 20, width: 300, height: 400)], part: -1))
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

    // MARK: - Task 5: caret/selection/cell-cursor raw payload parsers, against REAL captured shapes
    //
    // Every literal string below is copied verbatim from
    // `testRealLOKCallbackProbeCapturesCaretSelectionAndCellCursorRawPayloads`'s own printed output
    // (a real, sandboxed, vendored-LOK run against gate.odt/gate.ods) — not hand-invented. See that
    // test's own header, and `OfficeDocumentEvent.parseCaretRect`/`.parseCellCursor`'s own headers,
    // for the full methodology and citations.

    func testParseCaretRectRealCapturedShapes() {
        // Writer body typing.
        XCTAssertEqual(OfficeDocumentEvent.parseCaretRect("1418, 1418, 0, 552"),
                       .caretRect(OfficeTwipsRect(x: 1418, y: 1418, width: 0, height: 552)))
        // Calc in-cell edit — the SAME shape, confirmed live from a structurally different emitter
        // (editeng, not vcl's document-window cursor) — see the parser's own header on why this
        // cross-app agreement was checked rather than assumed.
        XCTAssertEqual(OfficeDocumentEvent.parseCaretRect("2616, 1800, 0, 210"),
                       .caretRect(OfficeTwipsRect(x: 2616, y: 1800, width: 0, height: 210)))
    }

    /// The header-documented JSON alternative — never observed live (see the parser's own header for
    /// why), accepted defensively anyway. Uses the WELL-FORMED shape (`bControlEvent == true`'s own
    /// branch, which properly closes every JSON string) — the malformed branch's own output is not
    /// reproduced here since it is not valid JSON by construction and this parser makes no promise
    /// about recovering meaning from broken JSON.
    func testParseCaretRectAcceptsTheDocumentedJSONShapeAsAFallback() {
        let json = "{ \"viewId\": \"0\", \"rectangle\": \"100, 200, 0, 300\", \"controlEvent\": true, \"windowId\": \"5\" }"
        XCTAssertEqual(OfficeDocumentEvent.parseCaretRect(json),
                       .caretRect(OfficeTwipsRect(x: 100, y: 200, width: 0, height: 300)))
    }

    func testParseCaretRectMalformedPayloadsAreRejected() {
        for payload in ["", "not a rect", "1, 2, 3", "{ \"no rectangle field\": true }"] {
            XCTAssertNil(OfficeDocumentEvent.parseCaretRect(payload), "expected nil for: \"\(payload)\"")
        }
    }

    func testParseTextSelectionRealCapturedShapes() {
        XCTAssertEqual(OfficeDocumentEvent.parseTextSelection(""), .textSelection([]),
                       "LOK's documented empty-selection shape")
        XCTAssertEqual(OfficeDocumentEvent.parseTextSelection("1764, 1418, 320, 551"),
                       .textSelection([OfficeTwipsRect(x: 1764, y: 1418, width: 320, height: 551)]))
        XCTAssertEqual(OfficeDocumentEvent.parseTextSelection("1418, 1418, 666, 551"),
                       .textSelection([OfficeTwipsRect(x: 1418, y: 1418, width: 666, height: 551)]))
    }

    /// Calc's own undocumented divergence, found by reading `gridwin.cxx:7005` ahead of the probe —
    /// the parser folds it to the SAME "no selection" outcome as the documented `""`.
    func testParseTextSelectionCalcsBareEMPTYAlsoMeansNoSelection() {
        XCTAssertEqual(OfficeDocumentEvent.parseTextSelection("EMPTY"), .textSelection([]))
        XCTAssertEqual(OfficeDocumentEvent.parseTextSelection("  EMPTY  "), .textSelection([]),
                       "surrounding whitespace is trimmed before the EMPTY comparison, mirroring parseInvalidateTiles")
    }

    /// The documented multi-rect shape — a selection spanning more than one visual line. Not itself
    /// triggered by this task's own live probe (every real selection captured fit on one line — see
    /// the parser's own header) but structurally supported and pinned here as a pure fixture.
    func testParseTextSelectionMultiRectSemicolonJoinedShape() {
        let result = OfficeDocumentEvent.parseTextSelection("10, 20, 30, 40; 0, 60, 500, 40")
        XCTAssertEqual(result, .textSelection([
            OfficeTwipsRect(x: 10, y: 20, width: 30, height: 40),
            OfficeTwipsRect(x: 0, y: 60, width: 500, height: 40),
        ]))
    }

    func testParseTextSelectionMalformedPayloadsAreRejected() {
        for payload in ["10, 20, 30", "a, b, c, d", "10, 20, 30, 40; garbage"] {
            XCTAssertNil(OfficeDocumentEvent.parseTextSelection(payload), "expected nil for: \"\(payload)\"")
        }
    }

    func testParseTextSelectionStartAndEndRealCapturedShapes() {
        XCTAssertEqual(OfficeDocumentEvent.parseTextSelectionStart("1764, 1418, 0, 551"),
                       .textSelectionStart(OfficeTwipsRect(x: 1764, y: 1418, width: 0, height: 551)))
        XCTAssertEqual(OfficeDocumentEvent.parseTextSelectionEnd("2084, 1418, 0, 551"),
                       .textSelectionEnd(OfficeTwipsRect(x: 2084, y: 1418, width: 0, height: 551)))
    }

    func testParseTextSelectionStartAndEndMalformedPayloadsAreRejected() {
        // Unlike parseTextSelection, START/END never fire with an empty payload at all (LO's own
        // source returns no payload rather than ""), so "" is rejected here, not folded to anything.
        for payload in ["", "1, 2, 3", "not a rect"] {
            XCTAssertNil(OfficeDocumentEvent.parseTextSelectionStart(payload), "expected nil for: \"\(payload)\"")
            XCTAssertNil(OfficeDocumentEvent.parseTextSelectionEnd(payload), "expected nil for: \"\(payload)\"")
        }
    }

    func testParseCellCursorRealCapturedShapes() {
        // A1.
        XCTAssertEqual(OfficeDocumentEvent.parseCellCursor("0, 0, 1265, 254, 0, 0"),
                       .cellCursor(.at(rectTwips: OfficeTwipsRect(x: 0, y: 0, width: 1265, height: 254), column: 0, row: 0)))
        // A distant cell — column C (0-based index 2), row 8 (0-based index 7).
        XCTAssertEqual(OfficeDocumentEvent.parseCellCursor("2533, 1785, 1265, 254, 2, 7"),
                       .cellCursor(.at(rectTwips: OfficeTwipsRect(x: 2533, y: 1785, width: 1265, height: 254), column: 2, row: 7)))
        // In-cell edit mode — the grid's own "current cell" concept does not apply.
        XCTAssertEqual(OfficeDocumentEvent.parseCellCursor("EMPTY"), .cellCursor(.empty))
    }

    func testParseCellCursorMalformedPayloadsAreRejected() {
        for payload in ["", "0, 0, 1265, 254", "0, 0, 1265, 254, notanumber, 0", "a, b, c, d, e, f"] {
            XCTAssertNil(OfficeDocumentEvent.parseCellCursor(payload), "expected nil for: \"\(payload)\"")
        }
    }

    /// Task 8 — `LOK_CALLBACK_CELL_FORMULA`'s real captured payloads (live probe against
    /// `two-sheet.ods`, `OfficeHelperLiveTests
    /// .testProbeInvestigatesWhetherCellFormulaCallbacksExistForTheFormulaBarsContent`): clicking
    /// A1 ("NORMA GATE", a string cell) sent the literal string; clicking B2 (genuinely empty)
    /// sent the EMPTY STRING, not a sentinel and not silence; clicking B1 (the number 42) sent
    /// "42"; typing "X" without committing sent "X" — the live, in-progress edit-buffer text.
    /// Unlike `CELL_CURSOR`, there is no structure to malform: this callback's whole payload IS
    /// the formula-bar text, verbatim, so `parseCellFormula` never rejects anything — see its own
    /// header.
    func testParseCellFormulaRealCapturedShapes() {
        XCTAssertEqual(OfficeDocumentEvent.parseCellFormula("NORMA GATE"), .cellFormula("NORMA GATE"))
        XCTAssertEqual(OfficeDocumentEvent.parseCellFormula(""), .cellFormula(""), "a genuinely empty cell sends the empty string, not a sentinel")
        XCTAssertEqual(OfficeDocumentEvent.parseCellFormula("42"), .cellFormula("42"))
        XCTAssertEqual(OfficeDocumentEvent.parseCellFormula("X"), .cellFormula("X"), "the live, uncommitted in-progress edit-buffer text")
    }

    // MARK: - Office Stage B Task 5 — IME wire verb

    /// **The advisor-flagged trap, pinned.** LOK declares `LOK_EXT_TEXTINPUT = 0`,
    /// `LOK_EXT_TEXTINPUT_POS = 1`, `LOK_EXT_TEXTINPUT_END = 2` — `.end` MUST be `2`, not the naive
    /// sequential `1`, or this bridge silently posts the candidate-window-positioning event instead
    /// of a real commit and composition never lands. See `OfficeExtTextInputType`'s own header.
    func testExtTextInputTypeRawValuesSkipTheUnmodeledPOSCase() {
        XCTAssertEqual(OfficeExtTextInputType.input.rawValue, 0)
        XCTAssertEqual(OfficeExtTextInputType.end.rawValue, 2, "must skip LOK_EXT_TEXTINPUT_POS (1) — see this type's own header")
    }

    func testExtTextInputEventMalformedPayloadsAreRejected() {
        XCTAssertEqual(OfficeWireCodec.decodeInbound(
            "{\"type\":\"extTextInputEvent\",\"seq\":1,\"docId\":\"d\",\"part\":0,\"eventType\":0}"), // missing text
            .rejected(seq: 1, reason: "malformed"))
        XCTAssertEqual(OfficeWireCodec.decodeInbound(
            "{\"type\":\"extTextInputEvent\",\"seq\":2,\"docId\":\"d\",\"part\":0,\"text\":\"x\"}"), // missing eventType
            .rejected(seq: 2, reason: "malformed"))
        XCTAssertEqual(OfficeWireCodec.decodeInbound(
            "{\"type\":\"extTextInputEvent\",\"seq\":3,\"docId\":\"d\",\"eventType\":0,\"text\":\"x\"}"), // missing part
            .rejected(seq: 3, reason: "malformed"))
        XCTAssertEqual(OfficeWireCodec.decodeInbound(
            "{\"type\":\"extTextInputEvent\",\"seq\":4,\"docId\":\"d\",\"part\":0,\"eventType\":1,\"text\":\"x\"}"), // the unmodeled POS=1
            .rejected(seq: 4, reason: "malformed"))
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

    // MARK: - office-finish Job 2: the batch frames

    /// Both batch request frames and both batch reply frames survive encode → decode byte-for-byte in
    /// meaning, including a heterogeneous `ops` list and the OPTIONAL `failure`.
    func testBatchFramesRoundTrip() {
        let sheetOps = [
            OfficeSheetsManageSheetOperation(op: .add, name: "Q3", newName: nil),
            OfficeSheetsManageSheetOperation(op: .rename, name: "Sheet1", newName: "Summary"),
            OfficeSheetsManageSheetOperation(op: .delete, name: "Old", newName: nil),
        ]
        let slideOps = [
            OfficeSlidesManagePageOperation(op: .add, slide: nil, at: 2, to: nil, layout: .blank),
            OfficeSlidesManagePageOperation(op: .delete, slide: 0, at: nil, to: nil, layout: nil),
            OfficeSlidesManagePageOperation(op: .reorder, slide: 3, at: nil, to: 1, layout: nil),
        ]
        let frames: [OfficeWireFrame] = [
            .sheetsManageSheetBatch(seq: 7, docId: "d", ops: sheetOps),
            .slidesManagePageBatch(seq: 8, docId: "d", ops: slideOps),
            .sheetsManageSheetBatchOk(seq: 9, docId: "d", sheets: ["a", "b"], applied: 2, failure: nil),
            .sheetsManageSheetBatchOk(seq: 10, docId: "d", sheets: ["a"], applied: 1, failure: "no sheet named \"x\""),
            .slidesManagePageBatchOk(seq: 11, docId: "d", slideCount: 4, applied: 3, failure: nil),
            .slidesManagePageBatchOk(seq: 12, docId: "d", slideCount: 4, applied: 0, failure: "boom"),
        ]
        for frame in frames {
            guard let line = String(data: frame.encodedLine(), encoding: .utf8),
                  let decoded = OfficeWireFrame.decode(line.trimmingCharacters(in: .newlines)) else {
                return XCTFail("did not decode: \(frame)")
            }
            XCTAssertEqual(decoded, frame)
        }
    }

    /// A malformed batch is refused WHOLE — never trimmed, never partially accepted. Trimming a batch
    /// of position-based operations silently changes what was asked for, which is why every one of
    /// these is `.rejected` rather than a shorter `ops`.
    func testBatchFrameShapeIsRejectedAsMalformed() {
        let manyOps = (0..<(OfficeWireBatchLimits.maxOperationsPerBatch + 1))
            .map { #"{"op":"add","name":"s\#($0)"}"# }.joined(separator: ",")
        let lines = [
            // ops missing entirely, and ops empty — an empty batch is malformed, not a no-op.
            #"{"type":"sheetsManageSheetBatch","seq":1,"docId":"d"}"#,
            #"{"type":"sheetsManageSheetBatch","seq":1,"docId":"d","ops":[]}"#,
            // over the operation ceiling.
            #"{"type":"sheetsManageSheetBatch","seq":1,"docId":"d","ops":[\#(manyOps)]}"#,
            // an element that is not an object.
            #"{"type":"sheetsManageSheetBatch","seq":1,"docId":"d","ops":["add"]}"#,
            // the per-element rename<->newName pairing, both directions.
            #"{"type":"sheetsManageSheetBatch","seq":1,"docId":"d","ops":[{"op":"rename","name":"a"}]}"#,
            #"{"type":"sheetsManageSheetBatch","seq":1,"docId":"d","ops":[{"op":"add","name":"a","newName":"b"}]}"#,
            // an unrecognized op, refused rather than defaulted.
            #"{"type":"sheetsManageSheetBatch","seq":1,"docId":"d","ops":[{"op":"duplicate","name":"a"}]}"#,
            // slides: the per-element combination rules, one instance of each.
            #"{"type":"slidesManagePageBatch","seq":1,"docId":"d","ops":[{"op":"add","slide":0}]}"#,
            #"{"type":"slidesManagePageBatch","seq":1,"docId":"d","ops":[{"op":"delete"}]}"#,
            #"{"type":"slidesManagePageBatch","seq":1,"docId":"d","ops":[{"op":"reorder","slide":0}]}"#,
            // a present-but-wrong-TYPED index refuses; it is never folded into "absent".
            #"{"type":"slidesManagePageBatch","seq":1,"docId":"d","ops":[{"op":"delete","slide":"0"}]}"#,
            // and a present-but-out-of-range one refuses on magnitude (OfficeWireBatchLimits).
            #"{"type":"slidesManagePageBatch","seq":1,"docId":"d","ops":[{"op":"delete","slide":10000}]}"#,
            #"{"type":"slidesManagePageBatch","seq":1,"docId":"d","ops":[{"op":"delete","slide":-1}]}"#,
            // an unrecognized layout refuses rather than silently giving Impress's default.
            #"{"type":"slidesManagePageBatch","seq":1,"docId":"d","ops":[{"op":"add","layout":"spiral"}]}"#,
            // a NEGATIVE applied count on the reply is malformed — a ledger cannot describe -1 ops.
            #"{"type":"sheetsManageSheetBatchOk","seq":1,"docId":"d","sheets":[],"applied":-1}"#,
        ]
        for line in lines {
            switch OfficeWireCodec.decodeInbound(line) {
            case .rejected(let seq, let reason):
                XCTAssertEqual(seq, 1, "for: \(line)")
                XCTAssertEqual(reason, "malformed", "for: \(line)")
            case .frame, .tilePending, .tileHeaderMalformed, .unreadable:
                XCTFail("expected .rejected(seq: 1, reason: \"malformed\") for: \(line)")
            }
        }
        // The deletion-red half: the LEGAL shapes must still decode, so the refusals above are
        // discriminating rather than a decoder that rejects everything.
        let legal = [
            #"{"type":"sheetsManageSheetBatch","seq":1,"docId":"d","ops":[{"op":"add","name":"a"},{"op":"rename","name":"a","newName":"b"}]}"#,
            #"{"type":"slidesManagePageBatch","seq":1,"docId":"d","ops":[{"op":"add","at":1,"layout":"blank"},{"op":"reorder","slide":2,"to":0}]}"#,
            #"{"type":"sheetsManageSheetBatchOk","seq":1,"docId":"d","sheets":["a"],"applied":0}"#,
        ]
        for line in legal {
            guard case .frame = OfficeWireCodec.decodeInbound(line) else {
                return XCTFail("a legal batch frame must decode: \(line)")
            }
        }
    }

}
