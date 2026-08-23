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

    /// T3 gave `sheets.info`/`.read` real (async) behaviour; T4 gives `sheets.set`/`.insert_rows`/
    /// `.insert_cols`/`.delete_rows`/`.delete_cols`/`.add_sheet`/`.delete_sheet`/`.rename_sheet` the
    /// same — 10 of the 22 verbs are real now, leaving 12 STILL on T1's own synchronous refusal
    /// shell (every `slides`/`docs` verb, plus `sheets.format`, T5+'s own job). Every pre-existing
    /// test below that needs "an office verb that still answers synchronously with the
    /// not-implemented refusal, for ANY verb" picks from this list rather than hand-naming a real
    /// one, which would otherwise silently start asserting on ASYNC behaviour these tests were never
    /// built to await.
    static let stillStubOfficeVerbs = allOfficeVerbsAsOfT1.filter {
        ![
            "office.sheets.info", "office.sheets.read", "office.sheets.set",
            "office.sheets.insert_rows", "office.sheets.insert_cols",
            "office.sheets.delete_rows", "office.sheets.delete_cols",
            "office.sheets.add_sheet", "office.sheets.delete_sheet", "office.sheets.rename_sheet",
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
        // T4 correction: `office.sheets.set` is real now (`handleSheetsSet`) — `format` is the one
        // sheets verb still on T1's own refusal shell (T5+'s own job).
        consumer.handle(command("office.sheets.format"))
        XCTAssertEqual(sent.count, 1)
        XCTAssertEqual(sent.first?.ok, false)
        XCTAssertTrue(sent.first?.result?.contains("sheets") == true, "\(sent)")
        XCTAssertTrue(sent.first?.result?.contains("format") == true, "\(sent)")
        let lower = sent.first?.result?.lowercased() ?? ""
        XCTAssertTrue(lower.contains("not implemented") || lower.contains("not yet implement"), "\(sent)")
    }

    func testDifferentKindsAreWordedWithTheirOwnKindAndVerb() {
        let consumer = makeConsumer()
        consumer.handle(command("office.slides.add_slide", commandId: "c1"))
        consumer.handle(command("office.docs.replace", commandId: "c2"))
        XCTAssertTrue(sent[0].result?.contains("slides") == true, "\(sent[0])")
        XCTAssertTrue(sent[0].result?.contains("add_slide") == true, "\(sent[0])")
        XCTAssertTrue(sent[1].result?.contains("docs") == true, "\(sent[1])")
        XCTAssertTrue(sent[1].result?.contains("replace") == true, "\(sent[1])")
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
    /// merely by discipline. **T3 correction, T4 re-correction**: this test originally used
    /// `office.sheets.read` as its example, which read as "args is never read AT ALL" — no longer
    /// true once `sheets.read` went real; T3 switched to `office.sheets.set`, which T4 then made
    /// real too. Switched again, to `office.sheets.format` (the one sheets verb still a stub), to
    /// keep this test's own claim honest. The EQUIVALENT guarantee for every REAL verb — a
    /// huge/malicious operand still cannot grow the ANSWER past a bound, even though it genuinely
    /// gets read — is `testASheetsReadResultIsCappedNotAllowedToGrowUnbounded` below, a different
    /// mechanism (`sheetsResultMaxLength`, checked on the BUILT result) proving the equivalent
    /// property for a verb that must read `args` to do its job at all.
    func testTheRefusalNeverGrowsWithArgs() {
        let consumer = makeConsumer()
        let hugePath = String(repeating: "x", count: 100_000)
        consumer.handle(command("office.sheets.format", args: ["path": hugePath, "sheet": "S"]))
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
        // Fix-round review (item 4) — every EXISTING caller of this helper only ever exercises
        // sheetsInfo/sheetsRead (read-only, no save-through) or a refusal path (never reaches save
        // either), so the original hardcoded `"/tmp/unused-save"` — a path that does not exist —
        // never mattered before. A write verb's own happy path DOES reach the broker's save-through
        // step, which needs `save` to return a REAL file the broker can copy onto the target path;
        // the default here is UNCHANGED (same non-existent path, same behavior for every existing
        // call site) — only a test that overrides it can reach a write verb's happy path.
        save: @escaping (String, Int) async throws -> String = { _, _ in "/tmp/unused-save" }
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
            stateDirectory: FileManager.default.temporaryDirectory)
        let runtime = OfficeRuntime(sessionId: "s1", driver: driver)
        let broker = OfficeAgentBroker(host: .init(
            existingRuntime: { _ in nil },
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
}
