import NormaKit
import NormaProtocol
import XCTest
@testable import Norma

/// office-agent-tools T1 — `OfficeCommandConsumer`, the routing shell that refuses every office verb.
///
/// **No `CEFRecorder`, no `FakeScheduler`** — unlike `PanelCommandConsumerTests`, which needs both:
/// this consumer touches neither `BrowserRuntime` nor any clock (`OfficeCommandConsumer.swift`'s own
/// header explains why — every verb here answers synchronously, with no async work to bound and
/// nothing to fake). The harness is correspondingly the simplest thing that can hold what
/// `sendResult` was called with.
///
/// What this file does NOT cover, named rather than left implicit: that `PanelCommandConsumer`
/// actually ROUTES an office action here instead of falling into its own unknown-verb branch is
/// `PanelCommandConsumerTests.testOfficeActionsRouteToTheOfficeConsumer...` — that file's job, since
/// it is the one that owns `handle`'s dispatch.
@MainActor
final class OfficeCommandConsumerTests: XCTestCase {

    // MARK: - Fixtures

    /// What the consumer sent back, in order. Mirrors `PanelCommandConsumerTests.Sent`.
    struct Sent: Equatable {
        var sessionId: String
        var commandId: String
        var ok: Bool
        var result: String?
        var imageBase64: String?
    }

    private var sent: [Sent] = []
    private var scratchDirs: [URL] = []

    override func setUp() {
        super.setUp()
        sent = []
    }

    override func tearDown() {
        for dir in scratchDirs { try? FileManager.default.removeItem(at: dir) }
        scratchDirs = []
        super.tearDown()
    }

    /// `OfficeRuntime.open` genuinely stages (copies) its argument onto disk before a `Driver` — even
    /// a FAKE one — is ever reached (`OfficeAgentBrokerTests.writeDummyFile`'s own header makes the
    /// identical point). Every path a test below routes through a real broker/runtime needs a real,
    /// readable file on disk first, and that file must sit inside `makeSheetsWorld`'s own
    /// `workingDirs` for the fence to pass.
    private func makeScratchFile(named name: String = "budget.xlsx") -> String {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("officecommandconsumer-\(UUID().uuidString.prefix(8))", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        scratchDirs.append(dir)
        let path = dir.appendingPathComponent(name).path
        try? Data().write(to: URL(fileURLWithPath: path))
        return path
    }

    private func makeConsumer() -> OfficeCommandConsumer {
        OfficeCommandConsumer(sendResult: { [unowned self] sessionId, commandId, ok, result, imageBase64 in
            self.sent.append(Sent(sessionId: sessionId, commandId: commandId, ok: ok,
                                  result: result, imageBase64: imageBase64))
        })
    }

    /// Built as WIRE JSON and decoded, never with a memberwise initialiser — `PanelCommand`'s own
    /// init is internal to NormaProtocol, and going through the real decode is the honest shape
    /// anyway: it is exactly what `parseServerLine` hands the pump, and it keeps a fixture from
    /// describing a payload the daemon could not emit. (`PanelCommandConsumerTests.command(_:...)`'s
    /// own doc makes the identical argument; duplicated here rather than shared because the two test
    /// targets have nothing else in common to justify a shared helper file for one function.)
    private func command(_ action: String, args: [String: Any]? = nil, tabId: String? = nil,
                         commandId: String = "pcmd_1", sessionId: String = "s1",
                         deadlineMs: Int = 35_000) -> SessionEvent.PanelCommand {
        var fields: [String: Any] = [
            "type": "panel_command", "seq": 1, "sessionId": sessionId, "ts": 0,
            "commandId": commandId, "action": action, "deadlineMs": deadlineMs,
        ]
        if let tabId { fields["tabId"] = tabId }
        if let args { fields["args"] = args }
        // swiftlint:disable:next force_try — a dictionary of literals; a throw here is a broken test.
        let data = try! JSONSerialization.data(withJSONObject: fields)
        guard case .panelCommand(let decoded)? = try? JSONDecoder().decode(SessionEvent.self, from: data)
        else {
            XCTFail("the fixture did not decode as a panel_command")
            fatalError("unreachable — XCTFail above")
        }
        return decoded
    }

    /// All 22 verbs `OFFICE_COMMAND_ACTIONS` (events.ts) names as of T1 — hand-spelled here rather
    /// than imported, since there is deliberately NO Swift mirror of that list to import FROM (this
    /// file's own header, and `OfficeCommandConsumer.swift`'s). If the TS list drifts from this one,
    /// `office-commands.test.ts`'s own count assertion (11 sheets + 6 slides + 5 docs = 22) is the
    /// tripwire that catches it on the TS side; this array exists only to drive the SAME 22 through
    /// the Swift consumer in one test, not to be a second source of truth.
    static let allOfficeVerbsAsOfT1 = [
        "office.sheets.info", "office.sheets.read", "office.sheets.set",
        "office.sheets.insert_rows", "office.sheets.insert_cols",
        "office.sheets.delete_rows", "office.sheets.delete_cols",
        "office.sheets.add_sheet", "office.sheets.delete_sheet", "office.sheets.rename_sheet",
        "office.sheets.format",
        "office.slides.info", "office.slides.read", "office.slides.set_text",
        "office.slides.add_slide", "office.slides.delete_slide", "office.slides.reorder",
        "office.docs.info", "office.docs.read", "office.docs.replace",
        "office.docs.insert", "office.docs.append",
    ]

    /// T3 gave `sheets.info`/`.read` real (async) behaviour; T4 gave `sheets.set`/`.insert_rows`/
    /// `.insert_cols`/`.delete_rows`/`.delete_cols`/`.add_sheet`/`.delete_sheet`/`.rename_sheet` the
    /// same; T5 adds `sheets.format`; T6 adds every `slides` verb (`info`/`read`/`set_text`/
    /// `add_slide`/`delete_slide`/`reorder`) — 17 of the 22 verbs are real now, leaving 5 STILL on
    /// T1's own synchronous refusal shell (every `docs` verb — Stage C's last remaining stage's own
    /// job). Every pre-existing test below that needs "an office verb that still answers
    /// synchronously with the not-implemented refusal, for ANY verb" picks from this list rather than
    /// hand-naming a real one, which would otherwise silently start asserting on ASYNC behaviour these
    /// tests were never built to await.
    static let stillStubOfficeVerbs = allOfficeVerbsAsOfT1.filter {
        ![
            "office.sheets.info", "office.sheets.read", "office.sheets.set",
            "office.sheets.insert_rows", "office.sheets.insert_cols",
            "office.sheets.delete_rows", "office.sheets.delete_cols",
            "office.sheets.add_sheet", "office.sheets.delete_sheet", "office.sheets.rename_sheet",
            "office.sheets.format",
            "office.slides.info", "office.slides.read", "office.slides.set_text",
            "office.slides.add_slide", "office.slides.delete_slide", "office.slides.reorder",
        ].contains($0)
    }

    // MARK: - isOfficeAction

    func testIsOfficeActionIsAPrefixTestNotAMembershipList() {
        XCTAssertTrue(OfficeCommandConsumer.isOfficeAction("office.sheets.read"))
        XCTAssertTrue(OfficeCommandConsumer.isOfficeAction("office.docs.append"))
        // A verb from a THIRD task, invented for this test and never listed anywhere — still counts
        // as an office action, because the test is the prefix, not a list. This is the point.
        XCTAssertTrue(OfficeCommandConsumer.isOfficeAction("office.spreadsheets.explode"))
        XCTAssertFalse(OfficeCommandConsumer.isOfficeAction("navigate"))
        XCTAssertFalse(OfficeCommandConsumer.isOfficeAction("click"))
        XCTAssertFalse(OfficeCommandConsumer.isOfficeAction(""))
        XCTAssertFalse(OfficeCommandConsumer.isOfficeAction("office"), "no trailing dot, no match")
    }

    // MARK: - Every verb refuses, structured, never silence — the brief's own words

    func testEveryOfficeVerbAnswersNotImplementedRatherThanSilence() {
        let consumer = makeConsumer()
        for (index, action) in Self.stillStubOfficeVerbs.enumerated() {
            consumer.handle(command(action, commandId: "pcmd_\(index)"))
        }
        XCTAssertEqual(sent.count, Self.stillStubOfficeVerbs.count, "every still-stub verb must answer exactly once")
        XCTAssertTrue(sent.allSatisfy { $0.ok == false }, "\(sent)")
        XCTAssertTrue(sent.allSatisfy { $0.imageBase64 == nil })
        XCTAssertTrue(sent.allSatisfy { ($0.result?.isEmpty ?? true) == false }, "\(sent)")
        // Reaching this assertion at all — rather than a trap inside `handle` — is half the "never a
        // throw" proof; every result actually saying something is the other half, checked above.
    }

    func testTheRefusalNamesTheToolAndVerbSeparately() {
        let consumer = makeConsumer()
        // T6 correction: every `slides` verb is real now (`handleSlidesInfo`/etc.) — `docs` is the
        // ONLY kind left on T1's own stub shell, so this moves to `office.docs.info`, the last
        // remaining stub kind's own first verb.
        consumer.handle(command("office.docs.info"))
        XCTAssertEqual(sent.count, 1)
        XCTAssertEqual(sent.first?.ok, false)
        XCTAssertTrue(sent.first?.result?.contains("docs") == true, "\(sent)")
        XCTAssertTrue(sent.first?.result?.contains("info") == true, "\(sent)")
        let lower = sent.first?.result?.lowercased() ?? ""
        XCTAssertTrue(lower.contains("not implemented") || lower.contains("not yet implement"), "\(sent)")
    }

    /// T6 correction: `slides` is real now too (every verb, all six) — `docs` is the ONLY kind left
    /// on T1's own stub shell, so this test can no longer demonstrate two DIFFERENT KINDS both
    /// refusing (there is only one kind left to pick from). Renamed in spirit, not just body: now
    /// proves two DIFFERENT VERBS of the same (last remaining stub) kind are each worded with their
    /// own verb name — the kind-naming half of the same claim is already covered by
    /// `testTheRefusalNamesTheToolAndVerbSeparately` (which asserts "docs" appears) and does not need
    /// re-proving here.
    func testDifferentVerbsOfTheSameStubKindAreWordedWithTheirOwnVerb() {
        let consumer = makeConsumer()
        consumer.handle(command("office.docs.replace", commandId: "c1"))
        consumer.handle(command("office.docs.append", commandId: "c2"))
        XCTAssertTrue(sent[0].result?.contains("docs") == true, "\(sent[0])")
        XCTAssertTrue(sent[0].result?.contains("replace") == true, "\(sent[0])")
        XCTAssertTrue(sent[1].result?.contains("docs") == true, "\(sent[1])")
        XCTAssertTrue(sent[1].result?.contains("append") == true, "\(sent[1])")
    }

    func testTheAnswerCarriesTheCommandsOwnSessionAndId() {
        let consumer = makeConsumer()
        consumer.handle(command("office.docs.info", commandId: "pcmd_xyz", sessionId: "s-office-1"))
        XCTAssertEqual(sent.first?.sessionId, "s-office-1")
        XCTAssertEqual(sent.first?.commandId, "pcmd_xyz")
    }

    /// No `tabId` on the command at all — the ordinary shape for an office verb (design doc §3: a
    /// document is addressed by path, not by an existing panel tab). Must still answer cleanly; this
    /// consumer never reads `tabId` in the first place, so there is nothing here TO trip on it, but
    /// the test pins the observable behaviour rather than the implementation detail.
    func testAnOfficeCommandWithNoTabIdStillAnswers() {
        let consumer = makeConsumer()
        consumer.handle(command("office.docs.info", tabId: nil))
        XCTAssertEqual(sent.count, 1)
        XCTAssertEqual(sent.first?.ok, false)
    }

    /// A verb this file cannot even parse into (kind, verb) — still answered, never a crash. Nothing
    /// TODAY sends this (the daemon only ever emits `office.<kind>.<verb>`, all 22 well-formed), but
    /// `action` decodes as a plain `String` with no shape guarantee (`SessionEvent.swift`), so this
    /// file must not assume its own parser succeeds — the same posture
    /// `testUnknownPanelCommandVerbStillDecodes` (NormaProtocol) takes for the wire layer beneath it.
    func testAMalformedOfficeActionStillAnswersRatherThanCrashing() {
        let consumer = makeConsumer()
        consumer.handle(command("office.onlyonepart"))
        XCTAssertEqual(sent.count, 1)
        XCTAssertEqual(sent.first?.ok, false)
        XCTAssertTrue(sent.first?.result?.contains("office.onlyonepart") == true, "\(sent)")
    }

    // MARK: - The bounded-message guarantees (this file's own header, "the refusal string is
    // bounded on purpose") — the one way a "not implemented" shell could silently regress into the
    // exact silent-timeout bug its own answer path exists to avoid.

    /// `args` is never read by this consumer's STUB verbs at all (`OfficeCommandConsumer.handle`'s
    /// synchronous `default:` branch only ever touches `command.sessionId`/`command.commandId`/
    /// `command.action`) — so a huge `args.path` cannot reach a STUB verb's message, structurally, not
    /// merely by discipline. **T3 correction, T4 re-correction, T5 re-correction**: this test
    /// originally used `office.sheets.read` as its example, which read as "args is never read AT
    /// ALL" — no longer true once `sheets.read` went real; T3 switched to `office.sheets.set`, T4
    /// switched again to `office.sheets.format` once `set` went real too, and T5 makes `format` real
    /// — every `sheets` verb now is. Switched a third time, to `office.slides.info` (the first
    /// still-stub verb of Stage C's next kind), to keep this test's own claim honest. The EQUIVALENT
    /// guarantee for every REAL verb — a huge/malicious operand still cannot grow the ANSWER past a
    /// bound, even though it genuinely gets read — is
    /// `testASheetsReadResultIsCappedNotAllowedToGrowUnbounded` below, a different mechanism
    /// (`sheetsResultMaxLength`, checked on the BUILT result) proving the equivalent property for a
    /// verb that must read `args` to do its job at all.
    ///
    /// T6 correction: `slides` is real now too — moved to `office.docs.info`, the last remaining
    /// stub kind, same reasoning as this file's other T6-corrected tests above.
    func testTheRefusalNeverGrowsWithArgs() {
        let consumer = makeConsumer()
        let hugePath = String(repeating: "x", count: 100_000)
        consumer.handle(command("office.docs.info", args: ["path": hugePath, "sheet": "S"]))
        XCTAssertEqual(sent.count, 1)
        XCTAssertFalse(sent.first?.result?.contains(hugePath) == true)
        XCTAssertLessThan(sent.first?.result?.count ?? Int.max, 1_000,
                          "an office refusal must be static-length prose, not args-length prose")
    }

    /// The wire's own action-length pressure valve — briefed at ~120 chars (mirrors
    /// `PanelCommandConsumer.quotedIdentifierMaxLength`), so even an absurd `action` string (nothing
    /// on the wire bounds this field's length — `SessionEvent.swift`'s `action: String`) cannot grow
    /// this consumer's answer past a small, fixed bound. Without this guard an over-cap `result`
    /// would be REFUSED WHOLE by the daemon and the command would expire on its deadline — this
    /// file's header names that exact failure mode.
    func testAnAbsurdlyLongActionIsBriefedNotEchoedInFull() {
        let consumer = makeConsumer()
        let hugeAction = "office." + String(repeating: "y", count: 100_000)
        consumer.handle(command(hugeAction))
        XCTAssertEqual(sent.count, 1)
        XCTAssertLessThan(sent.first?.result?.count ?? Int.max, 1_000)
    }

    // MARK: - office-agent-tools T3: sheets.info / sheets.read — the first two verbs with real behaviour

    /// A fake `Driver`, wired into a REAL `OfficeRuntime` and a REAL `OfficeAgentBroker` — no real
    /// helper, no real LOK (mirrors `OfficeAgentBrokerTests.BrokerOfficeDriverRecorder`'s own
    /// established shape; that one is `private` to its own file, so this is its own minimal copy
    /// rather than a cross-file reuse). `open` always "succeeds" with spreadsheet metadata; `sheets
    /// Info`/`sheetsRead` are the two knobs each test sets.
    @MainActor
    private func makeSheetsWorld(
        workingDirs: [SessionDirEntry]? = [SessionDirEntry(path: "/tmp", locked: true)],
        sheetsInfo: @escaping (String) async throws -> (sheets: [OfficeSheetInfo], activeSheet: String) = { _ in
            throw OfficeHelperClientError.serverError(reason: "sheetsInfo not stubbed for this test")
        },
        sheetsRead: @escaping (String, String, String, Bool) async throws -> [[String]] = { _, _, _, _ in
            throw OfficeHelperClientError.serverError(reason: "sheetsRead not stubbed for this test")
        },
        // office-agent-tools T4 — same "explicit stub per test, throw if unstubbed" shape as
        // sheetsInfo/sheetsRead above.
        sheetsSet: @escaping (String, String, String, [String], [String]) async throws -> Int = { _, _, _, _, _ in
            throw OfficeHelperClientError.serverError(reason: "sheetsSet not stubbed for this test")
        },
        sheetsResize: @escaping (String, String, OfficeSheetsResizeDimension, OfficeSheetsResizeOp, String) async throws
            -> (usedEndColumn: Int, usedEndRow: Int) = { _, _, _, _, _ in
            throw OfficeHelperClientError.serverError(reason: "sheetsResize not stubbed for this test")
        },
        sheetsManageSheet: @escaping (String, OfficeSheetsManageSheetOp, String, String?) async throws -> [String] = { _, _, _, _ in
            throw OfficeHelperClientError.serverError(reason: "sheetsManageSheet not stubbed for this test")
        },
        // office-agent-tools T5 — same "explicit stub per test, throw if unstubbed" shape as every
        // sibling above.
        sheetsFormat: @escaping (String, String, String, String?, Bool?, Bool?, OfficeSheetsNumberFormatPreset?,
                                 OfficeSheetsAlign?, Double?) async throws -> [String] = { _, _, _, _, _, _, _, _, _ in
            throw OfficeHelperClientError.serverError(reason: "sheetsFormat not stubbed for this test")
        },
        // office-agent-tools T6 — same "explicit stub per test, throw if unstubbed" shape as every
        // sheets sibling above.
        slidesInfo: @escaping (String) async throws -> [OfficeSlideInfo] = { _ in
            throw OfficeHelperClientError.serverError(reason: "slidesInfo not stubbed for this test")
        },
        slidesRead: @escaping (String, Int) async throws -> (title: String?, body: String?) = { _, _ in
            throw OfficeHelperClientError.serverError(reason: "slidesRead not stubbed for this test")
        },
        slidesSetText: @escaping (String, Int, String?, String?) async throws -> [String] = { _, _, _, _ in
            throw OfficeHelperClientError.serverError(reason: "slidesSetText not stubbed for this test")
        },
        slidesManagePage: @escaping (String, OfficeSlidesManagePageOp, Int?, Int?, Int?, OfficeSlidesLayoutPreset?) async throws -> Int = { _, _, _, _, _, _ in
            throw OfficeHelperClientError.serverError(reason: "slidesManagePage not stubbed for this test")
        },
        // Fix-round review (item 4) — every EXISTING caller of this helper only ever exercises
        // sheetsInfo/sheetsRead (read-only, no save-through) or a refusal path (never reaches save
        // either), so the original hardcoded `"/tmp/unused-save"` — a path that does not exist —
        // never mattered before. A write verb's own happy path DOES reach the broker's save-through
        // step, which needs `save` to return a REAL file the broker can copy onto the target path;
        // the default here is UNCHANGED (same non-existent path, same behavior for every existing
        // call site) — only a test that overrides it can reach a write verb's happy path.
        save: @escaping (String, Int) async throws -> String = { _, _ in "/tmp/unused-save" },
        // T5 fix-round review, Important-4 — the ADOPTED branch. `existingRuntime` was hardcoded to
        // `nil`, so every test through this helper produced `adopted == false` and the broker's
        // opened-branch lifecycle: the adopted branch's own disclosure sentence was reachable by no
        // test at all. Setting this to `true` hands the broker the SAME runtime back as an existing
        // one, which is exactly what a real already-open human tab looks like to it — the caller
        // still has to `open` the document on the returned runtime for the broker's rule-1 lookup
        // (`stateSnapshot.documents[path]`) to find it.
        adoptExistingRuntime: Bool = false
    ) -> (consumer: OfficeCommandConsumer, runtime: OfficeRuntime) {
        let driver = OfficeRuntime.Driver(
            helperState: { .ready }, startHelper: { },
            open: { _, _ in OfficeDocumentMetadata(
                type: .spreadsheet, parts: 1, sizeTwips: OfficeDocumentSize(widthTwips: 100, heightTwips: 100)) },
            close: { _ in },
            save: save,
            subscribeTiles: { _, _, _, _ in [] }, unsubscribeTiles: { _ in }, requestTiles: { _, _ in },
            postKey: { _, _, _, _, _ in }, postMouse: { _, _, _, _, _, _, _, _ in },
            postExtTextInput: { _, _, _, _ in },
            clipboardCopy: { _, _ in nil }, clipboardCut: { _, _ in nil }, clipboardPaste: { _, _, _ in },
            undo: { _ in }, redo: { _ in },
            sheetsInfo: sheetsInfo, sheetsRead: sheetsRead,
            sheetsSet: sheetsSet, sheetsResize: sheetsResize, sheetsManageSheet: sheetsManageSheet,
            sheetsFormat: sheetsFormat,
            slidesInfo: slidesInfo, slidesRead: slidesRead, slidesSetText: slidesSetText,
            slidesManagePage: slidesManagePage,
            stateDirectory: FileManager.default.temporaryDirectory)
        let runtime = OfficeRuntime(sessionId: "s1", driver: driver)
        let broker = OfficeAgentBroker(host: .init(
            existingRuntime: { _ in adoptExistingRuntime ? runtime : nil },
            runtime: { _ in runtime },
            workingDirectories: { _ in workingDirs }))
        let consumer = OfficeCommandConsumer(
            sendResult: { [unowned self] sessionId, commandId, ok, result, imageBase64 in
                self.sent.append(Sent(sessionId: sessionId, commandId: commandId, ok: ok,
                                      result: result, imageBase64: imageBase64))
            },
            officeAgentBroker: { _ in broker })
        return (consumer, runtime)
    }

    // MARK: Operand validation — malformed/missing, never defaulted, and the broker never reached

    func testSheetsInfoRefusesAMissingPathWithoutTouchingTheBroker() async {
        var driverCalled = false
        let world = makeSheetsWorld(sheetsInfo: { _ in driverCalled = true; return ([], "") })
        world.consumer.handle(command("office.sheets.info"))
        await waitUntil { !self.sent.isEmpty }
        XCTAssertEqual(sent.count, 1)
        XCTAssertEqual(sent.first?.ok, false)
        XCTAssertTrue(sent.first?.result?.contains("path") == true, "\(sent)")
        XCTAssertFalse(driverCalled, "a missing path must refuse before the broker/driver is ever reached")
    }

    func testSheetsReadRefusesAMissingSheet() async {
        let world = makeSheetsWorld()
        world.consumer.handle(command("office.sheets.read", args: ["path": "/tmp/a.xlsx", "range": "A1"]))
        await waitUntil { !self.sent.isEmpty }
        XCTAssertEqual(sent.first?.ok, false)
        XCTAssertTrue(sent.first?.result?.contains("sheet") == true, "\(sent)")
    }

    func testSheetsReadRefusesAMissingRange() async {
        let world = makeSheetsWorld()
        world.consumer.handle(command("office.sheets.read", args: ["path": "/tmp/a.xlsx", "sheet": "Sheet1"]))
        await waitUntil { !self.sent.isEmpty }
        XCTAssertEqual(sent.first?.ok, false)
        XCTAssertTrue(sent.first?.result?.contains("range") == true, "\(sent)")
    }

    func testSheetsReadRefusesAMalformedRangeWithoutTouchingTheBroker() async {
        var driverCalled = false
        let world = makeSheetsWorld(sheetsRead: { _, _, _, _ in driverCalled = true; return [] })
        world.consumer.handle(command("office.sheets.read",
                                       args: ["path": "/tmp/a.xlsx", "sheet": "Sheet1", "range": "not-a-range"]))
        await waitUntil { !self.sent.isEmpty }
        XCTAssertEqual(sent.first?.ok, false)
        XCTAssertTrue(sent.first?.result?.contains("not-a-range") == true, "\(sent)")
        XCTAssertFalse(driverCalled, "a malformed range must refuse before the broker/driver is ever reached")
    }

    /// The cell-count cap (`officeReadRangeMaxCells`) is checked BEFORE the broker is ever reached —
    /// `OfficeCommandConsumer.handleSheetsRead`'s own header explains why (a request that was always
    /// going to be refused must not pay for a cold helper boot). Proven the same way the malformed-
    /// range test proves it: the driver would throw if it were ever asked.
    func testSheetsReadRefusesAnOversizedRangeWithoutTouchingTheBroker() async {
        var driverCalled = false
        let world = makeSheetsWorld(sheetsRead: { _, _, _, _ in driverCalled = true; return [] })
        let tooManyRows = officeReadRangeMaxCells + 1
        world.consumer.handle(command("office.sheets.read",
                                       args: ["path": "/tmp/a.xlsx", "sheet": "Sheet1", "range": "A1:A\(tooManyRows)"]))
        await waitUntil { !self.sent.isEmpty }
        XCTAssertEqual(sent.first?.ok, false)
        XCTAssertTrue(sent.first?.result?.contains("cells") == true, "\(sent)")
        XCTAssertFalse(driverCalled, "an oversized range must refuse before the broker/driver is ever reached")
    }

    /// Fix-round review (item 4) — `sheets.ts`'s own daemon-side validation for a row verb's `at`
    /// coerces via `String(a.at)` against a digit-only regex, accepting EITHER a JSON number OR a
    /// JSON string, and passes the value through UNCHANGED (never normalized to a number) — so
    /// `at: "3"` reaches this consumer as a real `.string("3")`, not a `.number(3)`. The ORIGINAL
    /// `handleSheetsResize` row arm accepted `.number` only, refusing this documented-legal shape
    /// outright. Built through the REAL wire decode (`command(_:args:)`), not a memberwise
    /// initializer — `["at": "3"]` is a Swift `String`, which `JSONSerialization` encodes as a JSON
    /// string, decoding to `.string`, exactly the wire shape a real caller sending `at: "3"` produces.
    func testSheetsInsertRowsAcceptsADigitOnlyStringAtSameAsANumber() async {
        let path = makeScratchFile()
        let savedPath = makeScratchFile(named: "saved.xlsx")
        var capturedRange: String?
        let world = makeSheetsWorld(
            workingDirs: [SessionDirEntry(path: (path as NSString).deletingLastPathComponent, locked: true)],
            sheetsResize: { _, _, _, _, selectionRange in
                capturedRange = selectionRange
                return (usedEndColumn: 0, usedEndRow: 0)
            },
            save: { _, _ in savedPath })
        world.consumer.handle(command("office.sheets.insert_rows",
                                      args: ["path": path, "sheet": "Sheet1", "at": "3", "count": 2]))
        await waitUntil { !self.sent.isEmpty }
        XCTAssertEqual(sent.first?.ok, true, "\(sent)")
        XCTAssertEqual(capturedRange, "3:4", "at: \"3\" (string) must resolve identically to at: 3 (number)")
    }

    /// The number path, alongside the string one above — both must resolve to the IDENTICAL
    /// selection range, proving the fix did not merely swap which type is accepted.
    func testSheetsInsertRowsAcceptsANumberAtTheSameAsADigitOnlyString() async {
        let path = makeScratchFile()
        let savedPath = makeScratchFile(named: "saved.xlsx")
        var capturedRange: String?
        let world = makeSheetsWorld(
            workingDirs: [SessionDirEntry(path: (path as NSString).deletingLastPathComponent, locked: true)],
            sheetsResize: { _, _, _, _, selectionRange in
                capturedRange = selectionRange
                return (usedEndColumn: 0, usedEndRow: 0)
            },
            save: { _, _ in savedPath })
        world.consumer.handle(command("office.sheets.insert_rows",
                                      args: ["path": path, "sheet": "Sheet1", "at": 3, "count": 2]))
        await waitUntil { !self.sent.isEmpty }
        XCTAssertEqual(sent.first?.ok, true, "\(sent)")
        XCTAssertEqual(capturedRange, "3:4")
    }

    /// A non-digit string must still refuse — the fix widens WHICH TYPE is accepted, not what VALUE.
    func testSheetsInsertRowsStillRefusesANonDigitString() async {
        var driverCalled = false
        let world = makeSheetsWorld(sheetsResize: { _, _, _, _, _ in driverCalled = true; return (0, 0) })
        world.consumer.handle(command("office.sheets.insert_rows",
                                      args: ["path": "/tmp/a.xlsx", "sheet": "Sheet1", "at": "C", "count": 1]))
        await waitUntil { !self.sent.isEmpty }
        XCTAssertEqual(sent.first?.ok, false, "\(sent)")
        XCTAssertTrue(sent.first?.result?.contains("row number") == true, "\(sent)")
        XCTAssertFalse(driverCalled)
    }

    // MARK: The fence and drivability — mirroring the two refusal shapes the brief names

    /// spec §5: "a probe outside the working dirs answers with the fence refusal, not the
    /// app-not-running one." `info` (the drivability probe) still refuses with the FENCE's own wording
    /// here, even though this test's fake broker/runtime IS reachable — the fence runs before rule 1
    /// ever asks whether a runtime exists.
    func testSheetsInfoOutsideWorkingDirsGetsTheFenceRefusalNotAppNotRunning() async {
        let world = makeSheetsWorld(workingDirs: [SessionDirEntry(path: "/repo", locked: true)])
        world.consumer.handle(command("office.sheets.info", args: ["path": "/etc/passwd"]))
        await waitUntil { !self.sent.isEmpty }
        XCTAssertEqual(sent.first?.ok, false)
        XCTAssertTrue(sent.first?.result?.contains("working directories") == true, "\(sent)")
    }

    func testSheetsInfoWithNoBrokerAtAllRefusesRatherThanCrashing() async {
        let consumer = OfficeCommandConsumer(
            sendResult: { [unowned self] sessionId, commandId, ok, result, imageBase64 in
                self.sent.append(Sent(sessionId: sessionId, commandId: commandId, ok: ok,
                                      result: result, imageBase64: imageBase64))
            }) // officeAgentBroker defaults to `{ _ in nil }` — the host-gone case
        consumer.handle(command("office.sheets.info", args: ["path": "/tmp/a.xlsx"]))
        await waitUntil { !self.sent.isEmpty }
        XCTAssertEqual(sent.first?.ok, false)
        XCTAssertFalse(sent.isEmpty)
    }

    // MARK: The happy path — real content flows through, formatted, capped, sent ok:true

    func testSheetsInfoHappyPathReportsSheetsAndActiveSheet() async {
        let path = makeScratchFile()
        let world = makeSheetsWorld(
            workingDirs: [SessionDirEntry(path: (path as NSString).deletingLastPathComponent, locked: true)],
            sheetsInfo: { _ in
                ([OfficeSheetInfo(name: "Summary", usedEndColumn: 5, usedEndRow: 19),
                  OfficeSheetInfo(name: "Empty", usedEndColumn: -1, usedEndRow: -1)], "Summary")
            })
        world.consumer.handle(command("office.sheets.info", args: ["path": path]))
        await waitUntil { !self.sent.isEmpty }
        XCTAssertEqual(sent.first?.ok, true, "\(sent)")
        let result = sent.first?.result ?? ""
        XCTAssertTrue(result.contains("Summary"), result)
        XCTAssertTrue(result.contains("A1:F20"), result) // column 5 -> F, row 19 -> 20 (1-based)
        XCTAssertTrue(result.contains("Empty"), result)
        XCTAssertTrue(result.lowercased().contains("empty"), result) // the -1/-1 sentinel renders as "empty"
        XCTAssertTrue(result.contains("active"), result)
    }

    func testSheetsReadHappyPathReturnsTheValueGridAsTSV() async {
        let path = makeScratchFile()
        let world = makeSheetsWorld(
            workingDirs: [SessionDirEntry(path: (path as NSString).deletingLastPathComponent, locked: true)],
            sheetsRead: { docId, sheet, range, formulas in
                XCTAssertEqual(sheet, "Sheet1")
                XCTAssertEqual(range, "A1:B2")
                XCTAssertFalse(formulas)
                return [["42", "Hello"], ["1", ""]]
            })
        world.consumer.handle(command("office.sheets.read",
                                       args: ["path": path, "sheet": "Sheet1", "range": "A1:B2"]))
        await waitUntil { !self.sent.isEmpty }
        XCTAssertEqual(sent.first?.ok, true, "\(sent)")
        let result = sent.first?.result ?? ""
        XCTAssertTrue(result.contains("42\tHello"), result)
        XCTAssertTrue(result.contains("values"), result)
        XCTAssertFalse(result.contains("formulas"), result)
    }

    func testSheetsReadHappyPathThreadsFormulasTrue() async {
        let path = makeScratchFile()
        let world = makeSheetsWorld(
            workingDirs: [SessionDirEntry(path: (path as NSString).deletingLastPathComponent, locked: true)],
            sheetsRead: { _, _, _, formulas in
                XCTAssertTrue(formulas)
                return [["=SUM(A1:A2)"]]
            })
        world.consumer.handle(command("office.sheets.read",
                                       args: ["path": path, "sheet": "Sheet1", "range": "A1",
                                              "formulas": true]))
        await waitUntil { !self.sent.isEmpty }
        XCTAssertEqual(sent.first?.ok, true, "\(sent)")
        let result = sent.first?.result ?? ""
        XCTAssertTrue(result.contains("=SUM(A1:A2)"), result)
        XCTAssertTrue(result.contains("formulas"), result)
    }

    /// A sheet-not-found refusal reaches the agent as clean, composed-by-LOKBridge house voice, never
    /// wrapped in this app's own "office helper refused:" framing — `OfficeCommandConsumer.message
    /// (for:)`'s own doc explains why `OfficeHelperClientError.serverError`'s bare `reason` is used
    /// rather than its `.description`.
    func testSheetsReadSheetNotFoundSurfacesTheBridgesOwnMessageCleanly() async {
        let path = makeScratchFile()
        let world = makeSheetsWorld(
            workingDirs: [SessionDirEntry(path: (path as NSString).deletingLastPathComponent, locked: true)],
            sheetsRead: { _, _, _, _ in
                throw OfficeHelperClientError.serverError(
                    reason: "no sheet named \"Nope\" in doc-1 — this workbook has: Sheet1, Sheet2")
            })
        world.consumer.handle(command("office.sheets.read",
                                       args: ["path": path, "sheet": "Nope", "range": "A1"]))
        await waitUntil { !self.sent.isEmpty }
        XCTAssertEqual(sent.first?.ok, false)
        let result = sent.first?.result ?? ""
        XCTAssertTrue(result.contains("Sheet1, Sheet2"), result)
        XCTAssertFalse(result.contains("office helper refused"), result)
    }

    /// The final belt: even though the requested range was well within `officeReadRangeMaxCells`, a
    /// LOK answer this file did not anticipate (more/longer cells than the request implied) must not
    /// grow the sent result unbounded — refused, not silently truncated.
    func testASheetsReadResultIsCappedNotAllowedToGrowUnbounded() async {
        let path = makeScratchFile()
        let hugeRow = (0..<5_000).map { "cell-\($0)-" + String(repeating: "x", count: 20) }
        let world = makeSheetsWorld(
            workingDirs: [SessionDirEntry(path: (path as NSString).deletingLastPathComponent, locked: true)],
            sheetsRead: { _, _, _, _ in [hugeRow] })
        world.consumer.handle(command("office.sheets.read",
                                       args: ["path": path, "sheet": "Sheet1", "range": "A1:A1"]))
        await waitUntil { !self.sent.isEmpty }
        XCTAssertEqual(sent.first?.ok, false, "an oversized answer must be refused, not sent as ok:true")
        let result = sent.first?.result ?? ""
        XCTAssertLessThan(result.utf16.count, PanelCommandConsumer.resultMaxLength)
        XCTAssertFalse(result.contains("cell-0-"), "a capped refusal must not still carry the oversized content")
    }

    // ============================================================================================
    // office-agent-tools T5: sheets format — pre-broker refusals (fast, no live engine needed) and
    // the happy path through a fake driver. The saved-bytes proof obligations (position verification,
    // toggle-vs-absolute, the numberFormat display/value triangle, width-as-a-column-property) are
    // OfficeSheetsFormatTests.swift's own live drills — this file only proves the operand plumbing.
    // ============================================================================================

    func testSheetsFormatRefusesAMissingSheet() async {
        let world = makeSheetsWorld()
        world.consumer.handle(command("office.sheets.format", args: ["path": "/tmp/a.xlsx", "range": "A1", "bold": true]))
        await waitUntil { !self.sent.isEmpty }
        XCTAssertEqual(sent.first?.ok, false)
        XCTAssertTrue(sent.first?.result?.contains("sheet") == true, "\(sent)")
    }

    func testSheetsFormatRefusesAMissingRange() async {
        let world = makeSheetsWorld()
        world.consumer.handle(command("office.sheets.format", args: ["path": "/tmp/a.xlsx", "sheet": "Sheet1", "bold": true]))
        await waitUntil { !self.sent.isEmpty }
        XCTAssertEqual(sent.first?.ok, false)
        XCTAssertTrue(sent.first?.result?.contains("range") == true, "\(sent)")
    }

    func testSheetsFormatRefusesAMalformedRangeWithoutTouchingTheBroker() async {
        var driverCalled = false
        let world = makeSheetsWorld(sheetsFormat: { _, _, _, _, _, _, _, _, _ in driverCalled = true; return [] })
        world.consumer.handle(command("office.sheets.format",
                                       args: ["path": "/tmp/a.xlsx", "sheet": "Sheet1", "range": "not-a-range", "bold": true]))
        await waitUntil { !self.sent.isEmpty }
        XCTAssertEqual(sent.first?.ok, false)
        XCTAssertFalse(driverCalled, "a malformed range must refuse before the broker/driver is ever reached")
    }

    /// Mirrors `testSheetsReadRefusesAnOversizedRangeWithoutTouchingTheBroker` — `format` reuses
    /// `officeReadRangeMaxCells` rather than a verb-specific number (`handleSheetsFormat`'s own doc:
    /// single-dispatch cost shape, same as `read`, unlike `set`'s per-cell one).
    func testSheetsFormatRefusesAnOversizedRangeWithoutTouchingTheBroker() async {
        var driverCalled = false
        let world = makeSheetsWorld(sheetsFormat: { _, _, _, _, _, _, _, _, _ in driverCalled = true; return [] })
        let tooManyRows = officeReadRangeMaxCells + 1
        world.consumer.handle(command("office.sheets.format",
                                       args: ["path": "/tmp/a.xlsx", "sheet": "Sheet1", "range": "A1:A\(tooManyRows)", "bold": true]))
        await waitUntil { !self.sent.isEmpty }
        XCTAssertEqual(sent.first?.ok, false)
        XCTAssertTrue(sent.first?.result?.contains("cells") == true, "\(sent)")
        XCTAssertFalse(driverCalled, "an oversized range must refuse before the broker/driver is ever reached")
    }

    /// The verb's own central contract, checked at the wire-decode boundary this file owns: naming
    /// NONE of the five attributes is refused before the broker is ever reached — never silently
    /// "succeeds" having done nothing.
    func testSheetsFormatRefusesWhenNoAttributeIsNamedWithoutTouchingTheBroker() async {
        var driverCalled = false
        let world = makeSheetsWorld(sheetsFormat: { _, _, _, _, _, _, _, _, _ in driverCalled = true; return [] })
        world.consumer.handle(command("office.sheets.format", args: ["path": "/tmp/a.xlsx", "sheet": "Sheet1", "range": "A1"]))
        await waitUntil { !self.sent.isEmpty }
        XCTAssertEqual(sent.first?.ok, false)
        XCTAssertTrue(sent.first?.result?.contains("at least one") == true, "\(sent)")
        XCTAssertFalse(driverCalled, "a call naming no attribute must refuse before the broker/driver is ever reached")
    }

    /// The happy path, and the absent-vs-present distinction at the Swift decode boundary
    /// specifically (the daemon's own zod schema already enforces "absent means omitted from args" —
    /// this proves THIS layer decodes that shape correctly too, never defaulting a missing key to
    /// `false`/some other value the way `optionalFormulas` deliberately does for a DIFFERENT field).
    func testSheetsFormatHappyPathThreadsOnlyTheNamedAttributesAndBuildsTheColumnSpanForWidth() async {
        let path = makeScratchFile()
        let savedPath = makeScratchFile(named: "saved-output.xlsx")
        let world = makeSheetsWorld(
            workingDirs: [SessionDirEntry(path: (path as NSString).deletingLastPathComponent, locked: true)],
            sheetsFormat: { docId, sheet, range, columnSpan, bold, italic, numberFormat, align, width in
                XCTAssertEqual(sheet, "Sheet1")
                XCTAssertEqual(range, "A1:C2")
                XCTAssertEqual(columnSpan, "A:C", "width's own column span must cover every column the range touches")
                XCTAssertEqual(bold, true)
                XCTAssertNil(italic, "italic was never named — must decode as nil, not false")
                XCTAssertNil(numberFormat)
                XCTAssertNil(align)
                XCTAssertEqual(width, 72)
                return ["bold", "width"]
            },
            save: { _, _ in savedPath })
        world.consumer.handle(command("office.sheets.format",
                                       args: ["path": path, "sheet": "Sheet1", "range": "A1:C2", "bold": true, "width": 72]))
        await waitUntil { !self.sent.isEmpty }
        XCTAssertEqual(sent.first?.ok, true, "\(sent)")
        let result = sent.first?.result ?? ""
        XCTAssertTrue(result.contains("bold, width"), result)
    }

    /// `columnSpan` must be `nil` when `width` is never named — the wire's own paired-field
    /// discipline (`OfficeWireFrame.sheetsFormat`'s decode guard) only matters if THIS side never
    /// builds a mismatched pair to begin with.
    func testSheetsFormatOmitsColumnSpanWhenWidthIsNotNamed() async {
        let path = makeScratchFile()
        let savedPath = makeScratchFile(named: "saved-output.xlsx")
        let world = makeSheetsWorld(
            workingDirs: [SessionDirEntry(path: (path as NSString).deletingLastPathComponent, locked: true)],
            sheetsFormat: { _, _, _, columnSpan, _, _, _, _, _ in
                XCTAssertNil(columnSpan)
                return ["italic"]
            },
            save: { _, _ in savedPath })
        world.consumer.handle(command("office.sheets.format",
                                       args: ["path": path, "sheet": "Sheet1", "range": "B2:D9", "italic": true]))
        await waitUntil { !self.sent.isEmpty }
        XCTAssertEqual(sent.first?.ok, true, "\(sent)")
    }

    /// **T5 fix-round review, Important-1 — the width phase's own COLUMN cap.** `width` does not
    /// select `range`; it selects the whole-column span `range`'s columns cover, which LOK serialises
    /// in full (and discards) once per GoToCell verification attempt. `A1:BXW1` is 2,000 cells — it
    /// passes the cell cap — and 2,000 ENTIRE COLUMNS, on the one dedicated LOK thread behind the one
    /// app-wide helper FIFO with no kill on request timeout. Refused before the broker is reached,
    /// and the driver must never see it.
    func testSheetsFormatRefusesAWidthCallSpanningTooManyColumnsBeforeTheBroker() async {
        let path = makeScratchFile()
        var driverCalled = false
        let world = makeSheetsWorld(
            workingDirs: [SessionDirEntry(path: (path as NSString).deletingLastPathComponent, locked: true)],
            sheetsFormat: { _, _, _, _, _, _, _, _, _ in driverCalled = true; return ["width"] })
        world.consumer.handle(command("office.sheets.format",
                                       args: ["path": path, "sheet": "Sheet1", "range": "A1:BXW1", "width": 72]))
        await waitUntil { !self.sent.isEmpty }
        XCTAssertEqual(sent.first?.ok, false)
        // 1999, not 2000 — the review's own `A1:BXW1` example is off by one (BXW is column index
        // 1998). Immaterial to the finding, and asserted at the real number rather than rounded to
        // the one the prose used.
        XCTAssertTrue(sent.first?.result?.contains("1999 columns") == true, "\(sent)")
        XCTAssertTrue(sent.first?.result?.contains("\(officeFormatWidthMaxColumns)-column limit") == true, "\(sent)")
        XCTAssertFalse(driverCalled, "the cap must refuse before the broker/LOK are ever reached")
    }

    /// The cap is on the WIDTH phase only — the same 2,000-cell range is perfectly fine for cell
    /// attributes, which are one dispatch over the selection regardless of how wide it is. A cap that
    /// also shrank `bold` would be a silent regression of `format`'s documented reach.
    func testSheetsFormatStillAcceptsAWideRangeWhenNoWidthIsNamed() async {
        let path = makeScratchFile()
        let savedPath = makeScratchFile()
        var seenRange: String?
        let world = makeSheetsWorld(
            workingDirs: [SessionDirEntry(path: (path as NSString).deletingLastPathComponent, locked: true)],
            sheetsFormat: { _, _, range, _, _, _, _, _, _ in seenRange = range; return ["bold"] },
            save: { _, _ in savedPath })
        world.consumer.handle(command("office.sheets.format",
                                       args: ["path": path, "sheet": "Sheet1", "range": "A1:BXW1", "bold": true]))
        await waitUntil { !self.sent.isEmpty }
        XCTAssertEqual(sent.first?.ok, true, "\(sent)")
        XCTAssertEqual(seenRange, "A1:BXW1")
    }

    /// Exactly at the cap is allowed; one past it is not — the boundary itself, not just a value far
    /// on either side of it.
    func testSheetsFormatWidthColumnCapIsInclusiveAtItsOwnBoundary() async {
        let path = makeScratchFile()
        let savedPath = makeScratchFile()
        // Both computed FROM the constant, never from its value — the comments that used to name
        // "64"/"65" here went stale the moment the cap was re-sized from V-1's measurement
        // (re-review, Minor). Named relatively so they cannot go stale again.
        let atCap = "A1:\(officeColumnLetters(officeFormatWidthMaxColumns - 1))1"     // exactly at the cap
        let pastCap = "A1:\(officeColumnLetters(officeFormatWidthMaxColumns))1"       // one past it
        let world = makeSheetsWorld(
            workingDirs: [SessionDirEntry(path: (path as NSString).deletingLastPathComponent, locked: true)],
            sheetsFormat: { _, _, _, _, _, _, _, _, _ in ["width"] },
            save: { _, _ in savedPath })
        world.consumer.handle(command("office.sheets.format",
                                       args: ["path": path, "sheet": "Sheet1", "range": atCap, "width": 72]))
        await waitUntil { !self.sent.isEmpty }
        XCTAssertEqual(sent.first?.ok, true, "exactly \(officeFormatWidthMaxColumns) columns must pass: \(sent)")

        sent.removeAll()
        world.consumer.handle(command("office.sheets.format",
                                       args: ["path": path, "sheet": "Sheet1", "range": pastCap, "width": 72],
                                       commandId: "pcmd-past"))
        await waitUntil { !self.sent.isEmpty }
        XCTAssertEqual(sent.first?.ok, false, "one column past the cap must refuse: \(sent)")
    }

    /// **T5 fix round, Critical-1's sweep** — a present-but-out-of-range `width` gets its OWN
    /// refusal, never the misleading "name at least one attribute" the at-least-one guard would
    /// otherwise produce once `optionalWidth` collapsed it to `nil`. The bound itself is what stops
    /// `officeWidthMm100`'s `Int(Double)` from trapping the app.
    func testSheetsFormatRefusesAnOutOfRangeWidthWithItsOwnMessage() async {
        let path = makeScratchFile()
        var driverCalled = false
        let world = makeSheetsWorld(
            workingDirs: [SessionDirEntry(path: (path as NSString).deletingLastPathComponent, locked: true)],
            sheetsFormat: { _, _, _, _, _, _, _, _, _ in driverCalled = true; return ["width"] })
        for bad in [1e30, 0.5, -3.0, 1001.0] {
            sent.removeAll()
            world.consumer.handle(command("office.sheets.format",
                                           args: ["path": path, "sheet": "Sheet1", "range": "A1", "width": bad],
                                           commandId: "pcmd-\(bad)"))
            await waitUntil { !self.sent.isEmpty }
            XCTAssertEqual(sent.first?.ok, false, "width \(bad): \(sent)")
            XCTAssertTrue(sent.first?.result?.contains("`width` must be between 1 and 1000 points") == true,
                          "width \(bad) must get the width refusal, not the at-least-one-attribute one: \(sent)")
        }
        XCTAssertFalse(driverCalled)
    }

    /// The partial-failure lifecycle sentence — `handleSheetsFormat`'s own catch block, mirroring
    /// `handleSheetsSet`'s established shape: appended only when more than one attribute could
    /// plausibly have been in flight, phrased conditionally ("if an earlier attribute already
    /// applied"), never asserting a specific one landed (this function's own local `attributeCount`
    /// check has no visibility into which attribute the driver actually reached before throwing).
    func testSheetsFormatMultiAttributeFailureAppendsThePartialApplicationLifecycleSentence() async {
        let path = makeScratchFile()
        let world = makeSheetsWorld(
            workingDirs: [SessionDirEntry(path: (path as NSString).deletingLastPathComponent, locked: true)],
            sheetsFormat: { _, _, _, _, _, _, _, _, _ in
                throw OfficeHelperClientError.serverError(reason: "the width phase failed")
            })
        world.consumer.handle(command("office.sheets.format",
                                       args: ["path": path, "sheet": "Sheet1", "range": "A1", "bold": true, "width": 72]))
        await waitUntil { !self.sent.isEmpty }
        XCTAssertEqual(sent.first?.ok, false)
        let result = sent.first?.result ?? ""
        XCTAssertTrue(result.contains("the width phase failed"), result)
        XCTAssertTrue(result.contains("already applied"), "a two-attribute call's failure must carry the "
                      + "conditional partial-application sentence: \(result)")
    }

    /// **T5 fix-round review, Important-4 — the OPENED branch's own DISTINGUISHING sentence.** The
    /// pre-fix pair of tests asserted only the substring `"already applied"`, which is common to both
    /// lifecycle branches — so neither branch was actually pinned, and swapping the two texts would
    /// have kept both green. This asserts the clause only the opened branch can produce, and asserts
    /// the adopted branch's own clause is ABSENT, which is what makes it a discriminator.
    func testSheetsFormatPartialFailureOnADocumentNormaOpenedSaysNothingPersisted() async {
        let path = makeScratchFile()
        let world = makeSheetsWorld(
            workingDirs: [SessionDirEntry(path: (path as NSString).deletingLastPathComponent, locked: true)],
            sheetsFormat: { _, _, _, _, _, _, _, _, _ in
                throw OfficeHelperClientError.serverError(reason: "the width phase failed")
            })
        world.consumer.handle(command("office.sheets.format",
                                       args: ["path": path, "sheet": "Sheet1", "range": "A1", "bold": true, "width": 72]))
        await waitUntil { !self.sent.isEmpty }
        XCTAssertEqual(sent.first?.ok, false)
        let result = sent.first?.result ?? ""
        XCTAssertTrue(result.contains("discarded when Norma closed the document afterward"),
                      "a document THIS call opened is closed on the way out, so nothing survives: \(result)")
        XCTAssertTrue(result.contains("nothing from this call persisted"), result)
        XCTAssertFalse(result.contains("your own open tab"),
                       "the ADOPTED branch's own sentence must not appear on a document Norma opened "
                           + "itself — that would tell the model to go look at a tab that does not "
                           + "exist: \(result)")
    }

    /// **The ADOPTED branch — produced by no test before this one.** The broker keeps an adopted
    /// document OPEN on failure (its `defer` closes only what this call itself opened), so the
    /// in-memory changes survive in the user's own tab and rule 3's dirty check then refuses further
    /// writes. That is a materially different instruction to the model than the opened branch's
    /// "nothing persisted," and it is the half T4 spent three rounds proving for `set`.
    func testSheetsFormatPartialFailureOnAnADOPTEDDocumentSaysItIsSittingUnsavedInTheOpenTab() async {
        let path = makeScratchFile()
        let world = makeSheetsWorld(
            workingDirs: [SessionDirEntry(path: (path as NSString).deletingLastPathComponent, locked: true)],
            sheetsFormat: { _, _, _, _, _, _, _, _, _ in
                throw OfficeHelperClientError.serverError(reason: "the width phase failed")
            },
            adoptExistingRuntime: true)
        // What an already-open human tab looks like to the broker: the document present in the
        // runtime's own state BEFORE the verb runs, so rule 1 adopts instead of opening.
        world.runtime.open(path)
        await waitUntil { world.runtime.stateSnapshot.documents[path] != nil }

        world.consumer.handle(command("office.sheets.format",
                                       args: ["path": path, "sheet": "Sheet1", "range": "A1", "bold": true, "width": 72]))
        await waitUntil { !self.sent.isEmpty }
        XCTAssertEqual(sent.first?.ok, false)
        let result = sent.first?.result ?? ""
        XCTAssertTrue(result.contains("sitting unsaved in your own open tab right now"),
                      "an ADOPTED document is not closed on failure — its changes are still in the "
                          + "user's tab: \(result)")
        XCTAssertTrue(result.contains("refuse further writes"), result)
        XCTAssertFalse(result.contains("discarded when Norma closed the document"),
                       "the OPENED branch's own sentence must not appear on an adopted document — it "
                           + "would tell the model its changes are gone when they are sitting dirty "
                           + "in front of the user: \(result)")
    }

    /// **T5 fix-round review, Important-4's over-broad trigger.** `bold + italic` is two attributes,
    /// so the old `attributeCount > 1` test appended the partial-application sentence — but both are
    /// dispatched inside phase 1 with no throwing statement between them, so a partial application
    /// there is STRUCTURALLY IMPOSSIBLE. The trigger is now "a cell attribute AND `width`", the only
    /// seam where phase 2 can fail after phase 1 has already posted.
    func testSheetsFormatTwoCellAttributesWithoutWidthNeverAppendsTheLifecycleSentence() async {
        let path = makeScratchFile()
        let world = makeSheetsWorld(
            workingDirs: [SessionDirEntry(path: (path as NSString).deletingLastPathComponent, locked: true)],
            sheetsFormat: { _, _, _, _, _, _, _, _, _ in
                throw OfficeHelperClientError.serverError(reason: "phase 1 never positioned")
            })
        world.consumer.handle(command("office.sheets.format",
                                       args: ["path": path, "sheet": "Sheet1", "range": "A1",
                                              "bold": true, "italic": true, "align": "center"]))
        await waitUntil { !self.sent.isEmpty }
        XCTAssertEqual(sent.first?.ok, false)
        let result = sent.first?.result ?? ""
        XCTAssertTrue(result.contains("phase 1 never positioned"), result)
        XCTAssertFalse(result.contains("already applied"),
                       "three CELL attributes and no `width` cannot half-apply — phase 1 dispatches "
                           + "them with no throwing statement in between: \(result)")
    }

    /// The single-attribute counterpart — no lifecycle sentence, since only one attribute was ever
    /// in flight and a failure on it cannot leave anything "earlier" behind.
    func testSheetsFormatSingleAttributeFailureNeverAppendsTheLifecycleSentence() async {
        let path = makeScratchFile()
        let world = makeSheetsWorld(
            workingDirs: [SessionDirEntry(path: (path as NSString).deletingLastPathComponent, locked: true)],
            sheetsFormat: { _, _, _, _, _, _, _, _, _ in
                throw OfficeHelperClientError.serverError(reason: "bold failed")
            })
        world.consumer.handle(command("office.sheets.format",
                                       args: ["path": path, "sheet": "Sheet1", "range": "A1", "bold": true]))
        await waitUntil { !self.sent.isEmpty }
        XCTAssertEqual(sent.first?.ok, false)
        let result = sent.first?.result ?? ""
        XCTAssertTrue(result.contains("bold failed"), result)
        XCTAssertFalse(result.contains("already applied"), "a single-attribute call has nothing earlier "
                       + "in the same call to have already applied: \(result)")
    }

    // ============================================================================================
    // office-agent-tools T6: slides — pre-broker refusals (fast, no live engine needed) and the
    // happy path through a fake driver. The saved-bytes/two-part-discriminator proof obligations are
    // OfficeSlidesCommandTests.swift's own live drills — this file only proves the operand plumbing,
    // the SAME split `sheets`' own unit-test/live-test files already hold to.
    // ============================================================================================

    /// **T5 fix-round RE-REVIEW, the NEW Critical — the fifth door.** Every value below used to
    /// reach `oneBasedIndex`'s unbounded `Int(Double)` and ABORT NORMA.APP, from five live slides
    /// handlers, because `z.number().int().positive()` is not a bound (`Number.isInteger(1e30)` is
    /// `true`). Same shape, same blast radius, and same test posture as the `sheets` vectors in
    /// `PanelDocumentTabTests`: a trap is not catchable by XCTest, so if the ceiling is ever removed
    /// these do not fail — they take the whole runner down. That is the loudest red available.
    func testSlidesRefusesAnAppAbortingIndexOnEveryVerbThatTakesOne() async {
        let path = makeScratchFile()
        var driverCalled = false
        let world = makeSheetsWorld(
            workingDirs: [SessionDirEntry(path: (path as NSString).deletingLastPathComponent, locked: true)],
            slidesInfo: { _ in driverCalled = true; return [] },
            slidesRead: { _, _ in driverCalled = true; return (nil, nil) },
            slidesSetText: { _, _, _, _ in driverCalled = true; return [] },
            slidesManagePage: { _, _, _, _, _, _ in driverCalled = true; return 1 })
        // (action, the key carrying the index, any other operands the verb needs first)
        let cases: [(String, String, [String: Any])] = [
            ("office.slides.read", "slide", [:]),
            ("office.slides.set_text", "slide", ["title": "x"]),
            ("office.slides.delete_slide", "slide", [:]),
            ("office.slides.reorder", "slide", ["to": 2]),
            ("office.slides.reorder", "to", ["slide": 1]),
            ("office.slides.add_slide", "at", [:]),
        ]
        for bad in [1e30, 9_223_372_036_854_775_807.0, Double(OfficeCommandConsumer.officeSlideMaxIndex + 1)] {
            for (action, key, extra) in cases {
                sent.removeAll()
                var args: [String: Any] = ["path": path, key: bad]
                for (k, v) in extra { args[k] = v }
                world.consumer.handle(command(action, args: args, commandId: "pcmd-\(action)-\(key)-\(bad)"))
                await waitUntil { !self.sent.isEmpty }
                XCTAssertEqual(sent.first?.ok, false, "\(action) \(key):\(bad) must refuse: \(sent)")
                XCTAssertTrue(sent.first?.result?.contains("1-based") == true,
                              "\(action) \(key):\(bad) must get the INDEX refusal — for `add_slide`'s "
                                  + "optional `at` in particular, a nil from the decoder must not be "
                                  + "read as \"omitted\" and silently appended: \(sent)")
            }
        }
        XCTAssertFalse(driverCalled, "an out-of-range index must refuse before the broker/driver is reached")
    }

    /// **T5 round-2 re-review (Important) — a wrong TYPE must refuse, on every optional slides
    /// operand, not just a wrong number.** The round-2 silent-append fix was gated on
    /// `if case .number?`, so it closed exactly one type arm; the re-review measured `at:"3"` still
    /// giving `ok=true`, `seenAt=nil`, "now has 1 slide" — the model asks for position 3 and is told
    /// it succeeded, having appended at the end.
    ///
    /// Daemon-unreachable (zod refuses a string `at`) and fixed anyway: `panel_command.args` is
    /// `z.record(z.string(), z.unknown())` with only a byte cap, so NOTHING between a tool's own
    /// schema and this file bounds or types a value — which is exactly why the app-side guard exists,
    /// and a guard that only defends the daemon's own shapes fails its own stated threat model.
    func testSlidesRefusesAWrongTypedOptionalOperandOnEveryTypeArm() async {
        var driverCalled = false
        // Per-operand, because "wrong type" is per-operand: a STRING is wrong for `at` (the
        // reviewer's own measured vector) and right for `title`/`body`. The last row is `layout`'s
        // other failure mode — the right type carrying a value the enum does not know, which is the
        // realistic one for a model that invents a preset name.
        let cases: [(action: String, key: String, bad: Any, label: String, extra: [String: Any])] = [
            ("office.slides.add_slide", "at", "3", "string", [:]),
            ("office.slides.add_slide", "at", true, "bool", [:]),
            ("office.slides.add_slide", "at", [1, 2], "array", [:]),
            ("office.slides.add_slide", "at", ["n": 3], "object", [:]),
            ("office.slides.add_slide", "layout", 3, "number", [:]),
            ("office.slides.add_slide", "layout", true, "bool", [:]),
            ("office.slides.add_slide", "layout", ["a"], "array", [:]),
            ("office.slides.add_slide", "layout", "tytle_slide", "unknown preset", [:]),
            ("office.slides.set_text", "title", 3, "number", ["slide": 1]),
            ("office.slides.set_text", "title", true, "bool", ["slide": 1]),
            ("office.slides.set_text", "body", 3, "number", ["slide": 1]),
            ("office.slides.set_text", "body", ["a"], "array", ["slide": 1]),
        ]
        for c in cases {
            let path = makeScratchFile()
            let world = makeSheetsWorld(
                workingDirs: [SessionDirEntry(path: (path as NSString).deletingLastPathComponent, locked: true)],
                slidesSetText: { _, _, _, _ in driverCalled = true; return [] },
                slidesManagePage: { _, _, _, _, _, _ in driverCalled = true; return 1 },
                save: { [self] _, _ in self.makeScratchFile() })
            var args: [String: Any] = ["path": path, c.key: c.bad]
            for (k, v) in c.extra { args[k] = v }
            sent.removeAll()
            world.consumer.handle(command(c.action, args: args, commandId: "pcmd-\(c.key)-\(c.label)"))
            await waitUntil { !self.sent.isEmpty }
            XCTAssertEqual(sent.first?.ok, false,
                           "\(c.action) \(c.key) as \(c.label) must REFUSE, never collapse to "
                               + "\"absent\" and silently do something else: \(sent)")
            XCTAssertTrue(sent.first?.result?.contains(c.key) == true,
                          "the refusal must name the operand at fault: \(sent)")
        }
        XCTAssertFalse(driverCalled, "a wrong-typed operand must refuse before the broker/driver is reached")
    }

    /// The counterpart that stops the guard from over-refusing: the RIGHT type on each of these
    /// still works, so "refuse a wrong type" cannot quietly become "refuse the operand".
    func testSlidesStillAcceptsEveryOptionalOperandAtItsRightType() async {
        let path = makeScratchFile()
        var seenLayout: OfficeSlidesLayoutPreset?
        var seenTitle: String?
        let world = makeSheetsWorld(
            workingDirs: [SessionDirEntry(path: (path as NSString).deletingLastPathComponent, locked: true)],
            slidesSetText: { _, _, title, _ in seenTitle = title; return ["title"] },
            slidesManagePage: { _, _, _, _, _, layout in seenLayout = layout; return 1 },
            save: { [self] _, _ in self.makeScratchFile() })
        world.consumer.handle(command("office.slides.add_slide",
                                       args: ["path": path, "at": 2, "layout": "title_only"]))
        await waitUntil { !self.sent.isEmpty }
        XCTAssertEqual(sent.first?.ok, true, "\(sent)")
        XCTAssertEqual(seenLayout, .titleOnly)

        sent.removeAll()
        world.consumer.handle(command("office.slides.set_text",
                                       args: ["path": path, "slide": 1, "title": "Hello"],
                                       commandId: "pcmd-title-ok"))
        await waitUntil { !self.sent.isEmpty }
        XCTAssertEqual(sent.first?.ok, true, "\(sent)")
        XCTAssertEqual(seenTitle, "Hello")
    }

    /// An explicit JSON `null` is ABSENT, not "present but undecodable" — otherwise `{"at": null}`
    /// would behave differently from omitting `at`, for no reason a caller could predict.
    func testSlidesTreatsAnExplicitNullOptionalAsAbsent() async {
        let path = makeScratchFile()
        var seenAt: Int?
        let world = makeSheetsWorld(
            workingDirs: [SessionDirEntry(path: (path as NSString).deletingLastPathComponent, locked: true)],
            slidesManagePage: { _, _, _, at, _, _ in seenAt = at; return 1 },
            save: { [self] _, _ in self.makeScratchFile() })
        world.consumer.handle(command("office.slides.add_slide",
                                       args: ["path": path, "at": NSNull(), "layout": NSNull()]))
        await waitUntil { !self.sent.isEmpty }
        XCTAssertEqual(sent.first?.ok, true, "an explicit null must mean append, exactly as omitted does: \(sent)")
        XCTAssertNil(seenAt)
    }

    /// The ceiling is inclusive at its own boundary, and `add_slide`'s `at` is genuinely optional —
    /// so the guard cannot have quietly turned "omitted" into "refused" for the one verb that
    /// appends when `at` is absent.
    func testSlidesIndexCeilingIsInclusiveAndStillAllowsAnOmittedAt() async {
        // A fresh save source per call — the broker's save-through consumes the file `save` names,
        // so a single stub path cannot serve two calls (learned here, not assumed).
        var seenAt: Int?
        func runAddSlide(_ args: [String: Any], _ commandId: String) async -> Sent? {
            let path = makeScratchFile()
            var args = args
            args["path"] = path
            let world = makeSheetsWorld(
                workingDirs: [SessionDirEntry(path: (path as NSString).deletingLastPathComponent, locked: true)],
                slidesManagePage: { _, _, _, at, _, _ in seenAt = at; return 1 },
                save: { [self] _, _ in self.makeScratchFile() })
            sent.removeAll(); seenAt = nil
            world.consumer.handle(command("office.slides.add_slide", args: args, commandId: commandId))
            await waitUntil { !self.sent.isEmpty }
            return sent.first
        }

        let atCeiling = await runAddSlide(["at": OfficeCommandConsumer.officeSlideMaxIndex], "pcmd-ceiling")
        XCTAssertEqual(atCeiling?.ok, true, "exactly the ceiling must pass: \(String(describing: atCeiling))")
        XCTAssertEqual(seenAt, OfficeCommandConsumer.officeSlideMaxIndex - 1, "0-based on the wire")

        let omitted = await runAddSlide([:], "pcmd-no-at")
        XCTAssertEqual(omitted?.ok, true, "an OMITTED `at` still means append — the new "
                           + "present-but-invalid refusal must not have swallowed the absent case: "
                           + "\(String(describing: omitted))")
        XCTAssertNil(seenAt, "omitted must stay nil, never collapse to a bounded default")
    }

    func testSlidesInfoRefusesAMissingPathWithoutTouchingTheBroker() async {
        var driverCalled = false
        let world = makeSheetsWorld(slidesInfo: { _ in driverCalled = true; return [] })
        world.consumer.handle(command("office.slides.info"))
        await waitUntil { !self.sent.isEmpty }
        XCTAssertEqual(sent.first?.ok, false)
        XCTAssertTrue(sent.first?.result?.contains("path") == true, "\(sent)")
        XCTAssertFalse(driverCalled, "a missing path must refuse before the broker/driver is ever reached")
    }

    /// Controller ruling 2 (slides-lok-research.md §7): `name` is a POSITIONAL fallback for a
    /// never-renamed slide, never a title — `info` must report BOTH, distinctly, never present `name`
    /// as if it were a title. Controller ruling 1 (research §3): `info` reports NO layout at all — LOK
    /// gives no read-back for it, ever.
    func testSlidesInfoHappyPathReportsNameAndTitleDistinctlyAndNeverMentionsLayout() async {
        let path = makeScratchFile()
        let world = makeSheetsWorld(
            workingDirs: [SessionDirEntry(path: (path as NSString).deletingLastPathComponent, locked: true)],
            slidesInfo: { _ in
                [OfficeSlideInfo(name: "Slide 1", title: "Q3 Revenue"),
                 OfficeSlideInfo(name: "Slide 2", title: nil)]
            })
        world.consumer.handle(command("office.slides.info", args: ["path": path]))
        await waitUntil { !self.sent.isEmpty }
        XCTAssertEqual(sent.first?.ok, true, "\(sent)")
        let result = sent.first?.result ?? ""
        XCTAssertTrue(result.contains("Slide 1"), result)
        XCTAssertTrue(result.contains("Q3 Revenue"), result)
        XCTAssertTrue(result.contains("Slide 2"), result)
        XCTAssertFalse(result.lowercased().contains("layout"), "info must never mention layout — LOK "
                       + "gives no read-back for it at all: \(result)")
    }

    func testSlidesReadRefusesAMissingSlideWithoutTouchingTheBroker() async {
        var driverCalled = false
        let world = makeSheetsWorld(slidesRead: { _, _ in driverCalled = true; return (nil, nil) })
        world.consumer.handle(command("office.slides.read", args: ["path": "/tmp/a.pptx"]))
        await waitUntil { !self.sent.isEmpty }
        XCTAssertEqual(sent.first?.ok, false)
        XCTAssertTrue(sent.first?.result?.contains("slide") == true, "\(sent)")
        XCTAssertFalse(driverCalled, "a missing slide must refuse before the broker/driver is ever reached")
    }

    /// 1-based on the wire in, 1-based in the echoed result, 0-based to the driver — the ONE place
    /// this conversion happens (`handleSlidesRead`'s own header). Also proves the nil-vs-empty-string
    /// placeholder distinction renders as two DIFFERENT sentences, never the same text for both.
    func testSlidesReadHappyPathConvertsToZeroBasedAndDistinguishesMissingFromEmptyPlaceholder() async {
        let path = makeScratchFile()
        let world = makeSheetsWorld(
            workingDirs: [SessionDirEntry(path: (path as NSString).deletingLastPathComponent, locked: true)],
            slidesRead: { _, slide in
                XCTAssertEqual(slide, 1, "slide:2 (1-based) must reach the driver as 1 (0-based)")
                return (title: "Q3 Revenue", body: nil)
            })
        world.consumer.handle(command("office.slides.read", args: ["path": path, "slide": 2]))
        await waitUntil { !self.sent.isEmpty }
        XCTAssertEqual(sent.first?.ok, true, "\(sent)")
        let result = sent.first?.result ?? ""
        XCTAssertTrue(result.contains("Q3 Revenue"), result)
        XCTAssertTrue(result.contains("Slide 2"), "the echoed slide number must be 1-based again: \(result)")
        XCTAssertFalse(result.contains("(empty)"), "a nil body must not be worded as if it were present-but-empty: \(result)")
    }

    func testSlidesSetTextRefusesAMissingSlideWithoutTouchingTheBroker() async {
        var driverCalled = false
        let world = makeSheetsWorld(slidesSetText: { _, _, _, _ in driverCalled = true; return [] })
        world.consumer.handle(command("office.slides.set_text", args: ["path": "/tmp/a.pptx", "title": "Hi"]))
        await waitUntil { !self.sent.isEmpty }
        XCTAssertEqual(sent.first?.ok, false)
        XCTAssertTrue(sent.first?.result?.contains("slide") == true, "\(sent)")
        XCTAssertFalse(driverCalled)
    }

    /// Re-checked HERE, not merely trusted from the daemon's own validation — mirrors
    /// `handleSheetsFormat`'s identical re-check of its own five attributes (this file's own
    /// established belt-and-braces posture).
    func testSlidesSetTextRefusesNamingNeitherTitleNorBodyWithoutTouchingTheBroker() async {
        var driverCalled = false
        let world = makeSheetsWorld(slidesSetText: { _, _, _, _ in driverCalled = true; return [] })
        world.consumer.handle(command("office.slides.set_text", args: ["path": "/tmp/a.pptx", "slide": 1]))
        await waitUntil { !self.sent.isEmpty }
        XCTAssertEqual(sent.first?.ok, false)
        XCTAssertTrue(sent.first?.result?.contains("at least one") == true, "\(sent)")
        XCTAssertFalse(driverCalled)
    }

    func testSlidesSetTextHappyPathThreadsTitleAndBodyAndConvertsToZeroBased() async {
        let path = makeScratchFile()
        let savedPath = makeScratchFile(named: "saved.pptx")
        let world = makeSheetsWorld(
            workingDirs: [SessionDirEntry(path: (path as NSString).deletingLastPathComponent, locked: true)],
            slidesSetText: { _, slide, title, body in
                XCTAssertEqual(slide, 0, "slide:1 (1-based) must reach the driver as 0 (0-based)")
                XCTAssertEqual(title, "New Title")
                XCTAssertEqual(body, "New Body")
                return ["title", "body"]
            },
            save: { _, _ in savedPath })
        world.consumer.handle(command("office.slides.set_text",
                                       args: ["path": path, "slide": 1, "title": "New Title", "body": "New Body"]))
        await waitUntil { !self.sent.isEmpty }
        XCTAssertEqual(sent.first?.ok, true, "\(sent)")
    }

    /// The partial-failure lifecycle sentence — mirrors `testSheetsFormatMultiAttributeFailure
    /// AppendsThePartialApplicationLifecycleSentence` exactly, `handleSlidesSetText`'s own catch block.
    func testSlidesSetTextMultiAttributeFailureAppendsThePartialApplicationLifecycleSentence() async {
        let path = makeScratchFile()
        let world = makeSheetsWorld(
            workingDirs: [SessionDirEntry(path: (path as NSString).deletingLastPathComponent, locked: true)],
            slidesSetText: { _, _, _, _ in
                throw OfficeHelperClientError.serverError(reason: "the body phase failed")
            })
        world.consumer.handle(command("office.slides.set_text",
                                       args: ["path": path, "slide": 1, "title": "T", "body": "B"]))
        await waitUntil { !self.sent.isEmpty }
        XCTAssertEqual(sent.first?.ok, false)
        let result = sent.first?.result ?? ""
        XCTAssertTrue(result.contains("the body phase failed"), result)
        XCTAssertTrue(result.contains("already applied"), "a two-attribute call's failure must carry the "
                      + "conditional partial-application sentence: \(result)")
    }

    func testSlidesSetTextSingleAttributeFailureNeverAppendsTheLifecycleSentence() async {
        let path = makeScratchFile()
        let world = makeSheetsWorld(
            workingDirs: [SessionDirEntry(path: (path as NSString).deletingLastPathComponent, locked: true)],
            slidesSetText: { _, _, _, _ in
                throw OfficeHelperClientError.serverError(reason: "title failed")
            })
        world.consumer.handle(command("office.slides.set_text", args: ["path": path, "slide": 1, "title": "T"]))
        await waitUntil { !self.sent.isEmpty }
        XCTAssertEqual(sent.first?.ok, false)
        let result = sent.first?.result ?? ""
        XCTAssertTrue(result.contains("title failed"), result)
        XCTAssertFalse(result.contains("already applied"), "a single-attribute call has nothing earlier "
                       + "in the same call to have already applied: \(result)")
    }

    // MARK: add_slide / delete_slide / reorder — one consumer method, `slidesManagePage`

    func testAddSlideHappyPathThreadsOptionalAtAndLayoutConvertedToZeroBased() async {
        let path = makeScratchFile()
        let savedPath = makeScratchFile(named: "saved.pptx")
        let world = makeSheetsWorld(
            workingDirs: [SessionDirEntry(path: (path as NSString).deletingLastPathComponent, locked: true)],
            slidesManagePage: { _, op, slide, at, to, layout in
                XCTAssertEqual(op, .add)
                XCTAssertNil(slide)
                XCTAssertEqual(at, 1, "at:2 (1-based) must reach the driver as 1 (0-based)")
                XCTAssertNil(to)
                XCTAssertEqual(layout, .titleContent)
                return 3
            },
            save: { _, _ in savedPath })
        world.consumer.handle(command("office.slides.add_slide",
                                       args: ["path": path, "at": 2, "layout": "title_content"]))
        await waitUntil { !self.sent.isEmpty }
        XCTAssertEqual(sent.first?.ok, true, "\(sent)")
        XCTAssertTrue(sent.first?.result?.contains("3") == true, "\(sent)")
    }

    func testAddSlideWithNeitherAtNorLayoutThreadsBothNil() async {
        let path = makeScratchFile()
        let savedPath = makeScratchFile(named: "saved.pptx")
        let world = makeSheetsWorld(
            workingDirs: [SessionDirEntry(path: (path as NSString).deletingLastPathComponent, locked: true)],
            slidesManagePage: { _, op, slide, at, to, layout in
                XCTAssertEqual(op, .add)
                XCTAssertNil(slide)
                XCTAssertNil(at)
                XCTAssertNil(to)
                XCTAssertNil(layout)
                return 2
            },
            save: { _, _ in savedPath })
        world.consumer.handle(command("office.slides.add_slide", args: ["path": path]))
        await waitUntil { !self.sent.isEmpty }
        XCTAssertEqual(sent.first?.ok, true, "\(sent)")
    }

    func testDeleteSlideRefusesAMissingSlideWithoutTouchingTheBroker() async {
        var driverCalled = false
        let world = makeSheetsWorld(slidesManagePage: { _, _, _, _, _, _ in driverCalled = true; return 1 })
        world.consumer.handle(command("office.slides.delete_slide", args: ["path": "/tmp/a.pptx"]))
        await waitUntil { !self.sent.isEmpty }
        XCTAssertEqual(sent.first?.ok, false)
        XCTAssertTrue(sent.first?.result?.contains("slide") == true, "\(sent)")
        XCTAssertFalse(driverCalled)
    }

    func testDeleteSlideHappyPathConvertsToZeroBasedAndNamesNeitherAtNorToNorLayout() async {
        let path = makeScratchFile()
        let savedPath = makeScratchFile(named: "saved.pptx")
        let world = makeSheetsWorld(
            workingDirs: [SessionDirEntry(path: (path as NSString).deletingLastPathComponent, locked: true)],
            slidesManagePage: { _, op, slide, at, to, layout in
                XCTAssertEqual(op, .delete)
                XCTAssertEqual(slide, 2, "slide:3 (1-based) must reach the driver as 2 (0-based)")
                XCTAssertNil(at)
                XCTAssertNil(to)
                XCTAssertNil(layout)
                return 1
            },
            save: { _, _ in savedPath })
        world.consumer.handle(command("office.slides.delete_slide", args: ["path": path, "slide": 3]))
        await waitUntil { !self.sent.isEmpty }
        XCTAssertEqual(sent.first?.ok, true, "\(sent)")
    }

    func testReorderRefusesAMissingToWithoutTouchingTheBroker() async {
        var driverCalled = false
        let world = makeSheetsWorld(slidesManagePage: { _, _, _, _, _, _ in driverCalled = true; return 1 })
        world.consumer.handle(command("office.slides.reorder", args: ["path": "/tmp/a.pptx", "slide": 1]))
        await waitUntil { !self.sent.isEmpty }
        XCTAssertEqual(sent.first?.ok, false)
        XCTAssertTrue(sent.first?.result?.contains("`to`") == true, "\(sent)")
        XCTAssertFalse(driverCalled)
    }

    func testReorderRefusesAMissingSlideWithoutTouchingTheBroker() async {
        var driverCalled = false
        let world = makeSheetsWorld(slidesManagePage: { _, _, _, _, _, _ in driverCalled = true; return 1 })
        world.consumer.handle(command("office.slides.reorder", args: ["path": "/tmp/a.pptx", "to": 1]))
        await waitUntil { !self.sent.isEmpty }
        XCTAssertEqual(sent.first?.ok, false)
        XCTAssertFalse(driverCalled)
    }

    func testReorderHappyPathConvertsBothSlideAndToToZeroBased() async {
        let path = makeScratchFile()
        let savedPath = makeScratchFile(named: "saved.pptx")
        let world = makeSheetsWorld(
            workingDirs: [SessionDirEntry(path: (path as NSString).deletingLastPathComponent, locked: true)],
            slidesManagePage: { _, op, slide, at, to, layout in
                XCTAssertEqual(op, .reorder)
                XCTAssertEqual(slide, 2, "slide:3 (1-based) must reach the driver as 2 (0-based)")
                XCTAssertEqual(to, 0, "to:1 (1-based) must reach the driver as 0 (0-based)")
                XCTAssertNil(at)
                XCTAssertNil(layout)
                return 3
            },
            save: { _, _ in savedPath })
        world.consumer.handle(command("office.slides.reorder", args: ["path": path, "slide": 3, "to": 1]))
        await waitUntil { !self.sent.isEmpty }
        XCTAssertEqual(sent.first?.ok, true, "\(sent)")
    }
}
