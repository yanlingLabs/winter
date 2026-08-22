import AppKit
import NormaKit
import NormaProtocol
import XCTest
@testable import Norma

/// office-agent-tools T3 — live drills for `sheets info`/`sheets read` against the REAL helper, REAL
/// vendored LibreOffice, and REAL fixtures. Skips cleanly (never fails) when the vendor engine or the
/// built helper binary is not present in this run, the same discipline `OfficeAgentBrokerTests`' own
/// live drills and `OfficeRuntimeLiveTests` already establish.
///
/// **Driven through `OfficeCommandConsumer.handle(_:)` with WIRE-DECODED `PanelCommand` fixtures**,
/// never a memberwise initializer or a direct `OfficeAgentBroker.perform` call — the same discipline
/// `OfficeCommandConsumerTests`/`PanelCommandConsumerTests` already use, extended here to the REAL
/// broker/runtime/helper stack instead of a fake one. This is the actual end-to-end path an agent's
/// tool call takes once the daemon dispatches it: wire JSON -> `SessionEvent.PanelCommand` ->
/// `OfficeCommandConsumer` -> `OfficeAgentBroker` -> `OfficeRuntime` -> `OfficeHelperClient` -> the
/// wire to `NormaOfficeHelper` -> `LOKBridge` -> real LOK -> and all the way back.
@MainActor
final class OfficeSheetsCommandTests: XCTestCase {

    // MARK: - Fixtures/boilerplate (mirrors OfficeAgentBrokerTests' own established shape)

    private static var repoRoot: URL {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { url = url.deletingLastPathComponent() }
        return url
    }
    private static var vendorProductSetRoot: URL {
        repoRoot.appendingPathComponent("apple/Norma/vendor/libreoffice/product-set", isDirectory: true)
    }
    private static var fixturesRoot: URL {
        repoRoot.appendingPathComponent("apple/Norma/Tests/NormaAppTests/Fixtures/office", isDirectory: true)
    }
    private static var sandboxProfilePath: URL {
        repoRoot.appendingPathComponent("apple/Norma/Sources/OfficeHelper/office-helper.sb", isDirectory: false)
    }
    private static var helperURL: URL {
        Bundle.main.bundleURL.deletingLastPathComponent().appendingPathComponent("NormaOfficeHelper")
    }

    private var scratchDirs: [URL] = []

    override func tearDown() {
        for dir in scratchDirs { try? FileManager.default.removeItem(at: dir) }
        scratchDirs = []
        super.tearDown()
    }

    private func makeScratchDirectory() -> URL {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("officesheetscommand-\(UUID().uuidString.prefix(8))", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        scratchDirs.append(dir)
        return dir
    }

    /// Skips the calling test (never fails it) when the real helper binary or the vendored LibreOffice
    /// product-set is absent from this run — the same two checks `OfficeAgentBrokerTests`'s and
    /// `OfficeRuntimeLiveTests`'s own live drills open with.
    private func requireLiveEngine() throws {
        try XCTSkipIf(!FileManager.default.fileExists(atPath: Self.helperURL.path),
                      "NormaOfficeHelper was not built into this run's BUILT_PRODUCTS_DIR "
                        + "(\(Self.helperURL.path)) — add it to the scheme's build list and re-run.")
        try XCTSkipIf(!FileManager.default.fileExists(atPath: Self.vendorProductSetRoot.appendingPathComponent("Frameworks").path),
                      "LibreOffice vendor tree not present at \(Self.vendorProductSetRoot.path) — run "
                        + "`bun run libreoffice:fetch` from the repo root.")
    }

    /// Copies `fixtureName` (from `Fixtures/office/`) into a fresh scratch directory (real fixtures are
    /// never themselves a write/staging target) and returns the writable copy's path.
    private func makeWritableCopy(of fixtureName: String, as destName: String? = nil) throws -> String {
        let fixturePath = Self.fixturesRoot.appendingPathComponent(fixtureName).path
        try XCTSkipIf(!FileManager.default.fileExists(atPath: fixturePath), "\(fixtureName) fixture missing")
        let scratch = makeScratchDirectory()
        let docPath = scratch.appendingPathComponent(destName ?? fixtureName).path
        try Data(contentsOf: URL(fileURLWithPath: fixturePath)).write(to: URL(fileURLWithPath: docPath))
        return docPath
    }

    private func codeRow(_ sessionId: String, dirs: [SessionDirEntry]?) -> SessionSummary {
        SessionSummary(sessionId: sessionId, title: nil, createdAt: 1, scope: "global",
                       cwd: dirs?.first?.path, mode: "code", dirs: dirs)
    }

    /// A REAL `ShellSessionHost`, wired to a REAL `OfficeHelperSupervisor` (never a fake driver) —
    /// `testLiveAdoptionEditsTheAlreadyOpenDocumentInPlaceAndNeverClosesIt`'s own construction, plus
    /// the session-directory wiring `OfficeAgentBrokerTests.makeHost` establishes, combined: this file
    /// needs BOTH the real engine (to exercise the actual LOK mechanism) AND a real broker/fence
    /// (working directories that actually gate `sheets`' own daemon-independent Swift fence).
    private func makeLiveHost(stateDir: URL, dirs: [SessionDirEntry], sessionId: String = "S1") -> ShellSessionHost {
        let directory = SessionDirectory(lister: { [self.codeRow(sessionId, dirs: dirs)] })
        let host = ShellSessionHost(directory: directory, makeFeed: { _ in nil })
        host.makeOfficeHelperSupervisor = {
            OfficeHelperSupervisor(configuration: OfficeHelperSupervisor.Configuration(
                helperExecutableURL: Self.helperURL,
                socketDirectory: stateDir,
                extraArguments: ["--lok-root", Self.vendorProductSetRoot.path,
                                 "--sandbox-profile", Self.sandboxProfilePath.path]))
        }
        return host
    }

    private func waitUntilLive(timeout: TimeInterval = 90, _ condition: () -> Bool) async -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition() {
            if Date() >= deadline { return false }
            try? await Task.sleep(nanoseconds: 20_000_000)
        }
        return true
    }

    // MARK: - Driving OfficeCommandConsumer with wire-decoded PanelCommand fixtures

    struct Sent: Equatable {
        var sessionId: String
        var commandId: String
        var ok: Bool
        var result: String?
    }

    /// Mirrors `OfficeCommandConsumerTests.command(_:...)`'s own discipline: built as WIRE JSON and
    /// decoded, never a memberwise initializer.
    private func command(_ action: String, args: [String: Any], sessionId: String,
                         commandId: String = "pcmd_1") -> SessionEvent.PanelCommand {
        let fields: [String: Any] = [
            "type": "panel_command", "seq": 1, "sessionId": sessionId, "ts": 0,
            "commandId": commandId, "action": action, "deadlineMs": 155_000, "args": args,
        ]
        let data = try! JSONSerialization.data(withJSONObject: fields) // swiftlint:disable:this force_try
        guard case .panelCommand(let decoded)? = try? JSONDecoder().decode(SessionEvent.self, from: data) else {
            fatalError("the fixture did not decode as a panel_command")
        }
        return decoded
    }

    private func send(_ command: SessionEvent.PanelCommand, through host: ShellSessionHost) async -> Sent {
        var sent: Sent?
        let consumer = OfficeCommandConsumer(
            sendResult: { sessionId, commandId, ok, result, _ in
                sent = Sent(sessionId: sessionId, commandId: commandId, ok: ok, result: result)
            },
            officeAgentBroker: { [weak host] _ in host?.officeAgentBroker })
        consumer.handle(command)
        let arrived = await waitUntilLive { sent != nil }
        guard arrived, let sent else {
            XCTFail("sheets \(command.action) never answered")
            return Sent(sessionId: command.sessionId, commandId: command.commandId, ok: false, result: nil)
        }
        return sent
    }

    // MARK: - Real, awaited keystrokes (mirrors OfficeRuntimeLiveTests.postRealEdit /
    // OfficeAgentBrokerTests.typeOneCharacter — the proven "click, then type, then Return" shape)

    private func click(client: OfficeHelperClient, docId: String, xTwips: Int64, yTwips: Int64) async throws {
        try await client.postMouse(docId: docId, part: 0, type: .buttonDown, xTwips: xTwips, yTwips: yTwips,
                                   count: 1, buttons: 1, modifiers: 0)
        try await client.postMouse(docId: docId, part: 0, type: .buttonUp, xTwips: xTwips, yTwips: yTwips,
                                   count: 1, buttons: 1, modifiers: 0)
    }

    /// Posts one character via the real `OfficeHelperClient`, awaited at every step. `appKitKeyCode`
    /// goes through `OfficeInputCodes.lokKeyCode` — the SAME conversion production input
    /// (`OfficeTileCanvasView.forwardKeyEvent`) uses — rather than a hand-guessed raw LOK code.
    private func type(client: OfficeHelperClient, docId: String, character: Character,
                      appKitKeyCode: UInt16, shift: Bool = false) async throws {
        let keyCode = OfficeInputCodes.lokKeyCode(appKitKeyCode: appKitKeyCode,
                                                  modifierFlags: shift ? [.shift] : [])
        let charCode = Int(character.asciiValue!)
        try await client.postKey(docId: docId, part: 0, type: .keyInput, charCode: charCode, keyCode: keyCode)
        try await client.postKey(docId: docId, part: 0, type: .keyUp, charCode: charCode, keyCode: keyCode)
    }

    private func pressReturn(client: OfficeHelperClient, docId: String) async throws {
        try await client.postKey(docId: docId, part: 0, type: .keyInput, charCode: 0, keyCode: 1280)
        try await client.postKey(docId: docId, part: 0, type: .keyUp, charCode: 0, keyCode: 1280)
    }

    /// Types the formula `=1+1` into whichever cell (100,100) twips resolves to — the SAME click
    /// coordinates `postRealEdit`/`typeOneCharacter` already prove land on a real, editable cell.
    /// Typing directly after a click REPLACES the cell's entire content (ordinary spreadsheet UX, and
    /// this task's own live drills do not need to know or preserve whatever was there before).
    private func typeFormulaOnePlusOne(client: OfficeHelperClient, docId: String) async throws {
        try await click(client: client, docId: docId, xTwips: 100, yTwips: 100)
        try await type(client: client, docId: docId, character: "=", appKitKeyCode: 24 /* kVK_ANSI_Equal */)
        try await type(client: client, docId: docId, character: "1", appKitKeyCode: 18 /* kVK_ANSI_1 */)
        try await type(client: client, docId: docId, character: "+", appKitKeyCode: 24, shift: true)
        try await type(client: client, docId: docId, character: "1", appKitKeyCode: 18)
        try await pressReturn(client: client, docId: docId)
    }

    // MARK: - Live drills

    /// `sheets info` on `two-sheet.ods` (real, known content: two sheets, columns A/B seeded, B1="42")
    /// — ADOPTED (opened directly first, simulating an already-open human tab), never reloaded.
    func testLiveSheetsInfoOnAnAdoptedOdsDocumentReportsRealSheetsAndUsedRange() async throws {
        try requireLiveEngine()
        let path = try makeWritableCopy(of: "two-sheet.ods")
        let stateDir = makeScratchDirectory()
        let host = makeLiveHost(stateDir: stateDir, dirs: [SessionDirEntry(path: (path as NSString).deletingLastPathComponent, locked: true)])
        await host.directory.refresh()

        let runtime = host.officeRuntime(for: "S1")
        runtime.open(path)
        let opened = await waitUntilLive { runtime.stateSnapshot.documents[path] != nil || runtime.stateSnapshot.phase == .failed }
        XCTAssertTrue(opened, "setup: two-sheet.ods never settled — phase \(runtime.stateSnapshot.phase)")
        let originalDocId = try XCTUnwrap(runtime.stateSnapshot.documents[path]?.docId,
                                          "setup: \(runtime.stateSnapshot.openFailures[path] ?? "no reason recorded")")

        let sent = await send(command("office.sheets.info", args: ["path": path], sessionId: "S1"), through: host)

        XCTAssertTrue(sent.ok, "\(sent)")
        let result = try XCTUnwrap(sent.result)
        print("[live sheets info] two-sheet.ods ->\n\(result)")
        XCTAssertTrue(result.contains("2 sheets"), result)
        XCTAssertTrue(result.contains("active"), result)

        // ADOPTED — never reloaded: the SAME docId a plain runtime.open already produced, still open
        // afterward (rule 2: a document this call did not open must never be closed).
        XCTAssertEqual(runtime.stateSnapshot.documents[path]?.docId, originalDocId,
                       "info on an already-open document must adopt it, never reload it")
    }

    /// `sheets read` VALUES against `two-sheet.ods`'s own KNOWN, documented content
    /// (`OfficeRuntimeLiveTests`' own live drill already established B1="42" there) — asserted
    /// against the REAL bytes, not "it returned something". Also the ADOPTED case's read half.
    func testLiveSheetsReadValuesMatchesTwoSheetOdsKnownContent() async throws {
        try requireLiveEngine()
        let path = try makeWritableCopy(of: "two-sheet.ods")
        let stateDir = makeScratchDirectory()
        let host = makeLiveHost(stateDir: stateDir, dirs: [SessionDirEntry(path: (path as NSString).deletingLastPathComponent, locked: true)])
        await host.directory.refresh()

        let runtime = host.officeRuntime(for: "S1")
        runtime.open(path)
        let opened = await waitUntilLive { runtime.stateSnapshot.documents[path] != nil || runtime.stateSnapshot.phase == .failed }
        XCTAssertTrue(opened, "setup: two-sheet.ods never settled")

        let sent = await send(command("office.sheets.read",
                                       args: ["path": path, "sheet": "Sheet1", "range": "A1:B2"],
                                       sessionId: "S1"), through: host)
        XCTAssertTrue(sent.ok, "\(sent)")
        let result = try XCTUnwrap(sent.result)
        XCTAssertTrue(result.contains("NORMA GATE\t42"), result)
        XCTAssertTrue(result.contains("office stage A embed probe"), result)
        XCTAssertTrue(result.contains("values"), result)
        XCTAssertFalse(result.contains("formulas"), result)
    }

    /// A range spanning PAST the used area (`two-sheet.ods`'s own Sheet1 is exactly A1:B2) does not
    /// crash, does not pad with fabricated cells, and returns exactly the real content — `getText
    /// Selection`'s own trimming behaviour (`task-3-report.md`'s account of replacing `getDataArea`)
    /// means asking for a much larger rectangle than the sheet actually uses still comes back sized to
    /// the REAL content, not the requested one.
    func testLiveARangeSpanningPastTheUsedAreaReturnsOnlyRealContent() async throws {
        try requireLiveEngine()
        let path = try makeWritableCopy(of: "two-sheet.ods")
        let stateDir = makeScratchDirectory()
        let host = makeLiveHost(stateDir: stateDir, dirs: [SessionDirEntry(path: (path as NSString).deletingLastPathComponent, locked: true)])
        await host.directory.refresh()

        let sent = await send(command("office.sheets.read",
                                       args: ["path": path, "sheet": "Sheet1", "range": "A1:J50"],
                                       sessionId: "S1"), through: host)
        XCTAssertTrue(sent.ok, "\(sent)")
        let result = try XCTUnwrap(sent.result)
        XCTAssertTrue(result.contains("NORMA GATE\t42"), result)
        // Never padded to the full 10x50 requested rectangle — only 2 real content rows.
        XCTAssertEqual(result.components(separatedBy: "\n").count, 3, // header line + 2 content rows
                       "a range past the used area must return only the REAL rows, not the requested rectangle: \(result)")
    }

    /// A sheet name that does not exist gets the MAPPED house-voice refusal — the real sheet list,
    /// composed entirely by `LOKBridge`'s own `SaveError.sheetNotFound` (never raw LibreOffice text —
    /// there is no LOK error text in this path at all, since the mismatch is caught before any LOK
    /// call that could produce one).
    func testLiveANonExistentSheetGetsTheMappedRefusalNamingTheRealSheets() async throws {
        try requireLiveEngine()
        let path = try makeWritableCopy(of: "two-sheet.ods")
        let stateDir = makeScratchDirectory()
        let host = makeLiveHost(stateDir: stateDir, dirs: [SessionDirEntry(path: (path as NSString).deletingLastPathComponent, locked: true)])
        await host.directory.refresh()

        let sent = await send(command("office.sheets.read",
                                       args: ["path": path, "sheet": "NoSuchSheet", "range": "A1"],
                                       sessionId: "S1"), through: host)
        XCTAssertFalse(sent.ok, "\(sent)")
        let result = try XCTUnwrap(sent.result)
        XCTAssertTrue(result.contains("NoSuchSheet"), result)
        XCTAssertTrue(result.contains("Sheet1"), result)
        XCTAssertTrue(result.contains("Sheet2"), result)
        // Never a raw LibreOffice/UNO error string.
        XCTAssertFalse(result.lowercased().contains("uno:"), result)
        XCTAssertFalse(result.lowercased().contains("exception"), result)
    }

    /// `info` on a document NOT already open — broker-MINTED, and (rule 2) closed again afterward.
    /// Real `.xlsx` this time (`gate.xlsx`), covering the second required format.
    func testLiveSheetsInfoOnANotYetOpenXlsxDocumentMintsAndClosesAfterward() async throws {
        try requireLiveEngine()
        let path = try makeWritableCopy(of: "gate.xlsx")
        let stateDir = makeScratchDirectory()
        let host = makeLiveHost(stateDir: stateDir, dirs: [SessionDirEntry(path: (path as NSString).deletingLastPathComponent, locked: true)])
        await host.directory.refresh()

        let runtime = host.officeRuntime(for: "S1")
        XCTAssertNil(runtime.stateSnapshot.documents[path], "setup: gate.xlsx must not already be open")

        let sent = await send(command("office.sheets.info", args: ["path": path], sessionId: "S1"), through: host)
        XCTAssertTrue(sent.ok, "\(sent)")
        let result = try XCTUnwrap(sent.result)
        print("[live sheets info] gate.xlsx ->\n\(result)")
        XCTAssertTrue(result.contains("1 sheet"), result) // gate.xlsx is single-part (OfficeHelperLiveTests' own pin)

        // MINTED, not adopted — rule 2 closes what this call opened.
        let closedAfter = await waitUntilLive(timeout: 20) { runtime.stateSnapshot.documents[path] == nil }
        XCTAssertTrue(closedAfter, "a broker-minted read must close the document afterward")

        // The shared helper must have survived the close — the SAME liveness proof
        // OfficeAgentBrokerTests' own M4 drill uses: open something else afterward.
        let secondPath = try makeWritableCopy(of: "gate.ods", as: "second.ods")
        runtime.open(secondPath)
        let secondOpened = await waitUntilLive(timeout: 30) {
            runtime.stateSnapshot.documents[secondPath] != nil || runtime.stateSnapshot.phase == .failed
        }
        XCTAssertTrue(secondOpened, "the shared helper did not survive the self-opened read's own close")
        XCTAssertNotNil(runtime.stateSnapshot.documents[secondPath], "a second, different document must open cleanly afterward")
    }

    /// `sheets read` FORMULAS — seeds a real formula (`=1+1`) via the proven raw keystroke door on an
    /// ALREADY-OPEN document (so the write ADOPTS rather than mints, and — rule 2 — stays open
    /// afterward), saves through the broker's own drain-protected write path, then reads it back with
    /// `formulas:true` and asserts the FORMULA TEXT comes back, never the computed value "2".
    func testLiveSheetsReadFormulasReturnsFormulaTextNotTheComputedValue() async throws {
        try requireLiveEngine()
        let path = try makeWritableCopy(of: "gate.xlsx")
        let stateDir = makeScratchDirectory()
        let host = makeLiveHost(stateDir: stateDir, dirs: [SessionDirEntry(path: (path as NSString).deletingLastPathComponent, locked: true)])
        await host.directory.refresh()

        // Open directly first — establishes "already open," so the broker's own write ADOPTS rather
        // than mints, and (rule 2) never closes it.
        let runtime = host.officeRuntime(for: "S1")
        runtime.open(path)
        let opened = await waitUntilLive { runtime.stateSnapshot.documents[path] != nil || runtime.stateSnapshot.phase == .failed }
        XCTAssertTrue(opened, "setup: gate.xlsx never settled")
        let originalDocId = try XCTUnwrap(runtime.stateSnapshot.documents[path]?.docId)

        // The real sheet name, DISCOVERED through `info` rather than assumed — this drill never
        // hard-codes a guess at what the fixture's own sheet is called. Distinct commandIds across
        // this test's two `send()` calls, deliberately: `OfficeAgentBroker.perform` memoizes by
        // requestId (`OfficeCommandConsumer` passes `command.commandId` straight through), and a real
        // daemon always mints a fresh one per dispatch (`PanelCommandRegistry.dispatch`) — reusing the
        // default here would hit that memo and silently replay the FIRST call's own cached result
        // for the second, unrelated one (caught by this test on its first live run: the read call came
        // back holding the info call's own text, verbatim).
        let infoSent = await send(command("office.sheets.info", args: ["path": path], sessionId: "S1",
                                           commandId: "pcmd-formulas-info"), through: host)
        XCTAssertTrue(infoSent.ok, "\(infoSent)")
        let infoResult = try XCTUnwrap(infoSent.result)
        guard let sheetLine = infoResult.split(separator: "\n").first(where: { $0.hasPrefix("- \"") }),
              let closingQuote = sheetLine.dropFirst(3).firstIndex(of: "\"") else {
            return XCTFail("could not parse a sheet name out of info's own result: \(infoResult)")
        }
        let sheetName = String(sheetLine.dropFirst(3)[..<closingQuote])
        XCTAssertEqual(runtime.stateSnapshot.documents[path]?.docId, originalDocId,
                       "info on the already-open document must adopt it too, never reload it")

        guard let client = host.officeHelperSupervisor?.client else {
            return XCTFail("no live client to seed the formula through")
        }

        // The write, through the REAL broker (adopts — the document is already open — saves through
        // with the drain, per rule 4, and does not close since it adopted rather than minted).
        let seeded = try await host.officeAgentBroker.perform(
            sessionId: "S1", path: path, access: .write, requestId: UUID().uuidString
        ) { _, docId in
            try await self.typeFormulaOnePlusOne(client: client, docId: docId)
            return "seeded"
        }
        XCTAssertEqual(seeded, "seeded")
        XCTAssertEqual(runtime.stateSnapshot.documents[path]?.docId, originalDocId,
                       "the write must have ADOPTED the already-open document, never reloaded it")

        // The read, through the actual tool path — still adopts (the document is still open).
        let sent = await send(command("office.sheets.read",
                                       args: ["path": path, "sheet": sheetName,
                                              "range": "A1:E5", "formulas": true],
                                       sessionId: "S1", commandId: "pcmd-formulas-read"), through: host)
        XCTAssertTrue(sent.ok, "\(sent)")
        let result = try XCTUnwrap(sent.result)
        print("[live sheets read formulas] gate.xlsx ->\n\(result)")
        XCTAssertTrue(result.contains("=1+1") || result.contains("=1+1\n") || result.contains("\t=1+1"),
                     "the formula TEXT must appear verbatim: \(result)")
        XCTAssertFalse(result.contains("\t2\n") && !result.contains("=1+1"),
                       "must never silently report the COMPUTED value (2) instead of the formula")
        XCTAssertTrue(result.contains("formulas"), result)

        // Adopted throughout — never closed by either call.
        XCTAssertEqual(runtime.stateSnapshot.documents[path]?.docId, originalDocId)

        // `selectionTextOnDedicatedThread`'s own claim: the Show-Formulas toggle is a display-mode
        // flip, not a document mutation, so it must never leave the document dirty on its own — the
        // write above already saved (dirty cleared by the broker's own drain); the read that
        // followed, formulas:true included, must not have marked it dirty again.
        XCTAssertEqual(runtime.stateSnapshot.documents[path]?.dirty, false,
                       "the formulas toggle must never leave the document dirty on its own")
    }

    /// A path outside every working directory gets the FENCE refusal — live, through the real broker
    /// (not the fake-driver unit tests `OfficeCommandConsumerTests` already cover this with), proving
    /// the daemon-independent Swift fence refuses before ever reaching the real helper.
    func testLiveAPathOutsideWorkingDirectoriesGetsTheFenceRefusal() async throws {
        try requireLiveEngine()
        let path = try makeWritableCopy(of: "gate.ods")
        let outsideDir = makeScratchDirectory() // a DIFFERENT directory than the one `dirs` names
        let stateDir = makeScratchDirectory()
        let host = makeLiveHost(stateDir: stateDir, dirs: [SessionDirEntry(path: outsideDir.path, locked: true)])
        await host.directory.refresh()

        let sent = await send(command("office.sheets.info", args: ["path": path], sessionId: "S1"), through: host)
        XCTAssertFalse(sent.ok, "\(sent)")
        let result = try XCTUnwrap(sent.result)
        XCTAssertTrue(result.contains("working directories"), result)

        let runtime = host.officeRuntime(for: "S1")
        XCTAssertNil(runtime.stateSnapshot.documents[path], "a fenced-out path must never reach the helper at all")
    }
}
