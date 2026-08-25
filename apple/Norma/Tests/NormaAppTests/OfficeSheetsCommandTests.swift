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
    /// office-agent-tools T4 — the SIMPLEST possible real, unsaved edit on the PRIMARY view (never
    /// the agent's), for the dirty-refusal drill: one character, no navigation beyond the document's
    /// own default open position (A1), committed with Return. Mirrors `typeFormulaOnePlusOne`'s own
    /// proven click-then-type-then-Return shape, reduced to what THIS drill actually needs — a real
    /// `dirty == true` transition a human's own tab would show, nothing about the edit's own content
    /// matters here.
    private func typeOneCharacterOnPrimaryView(client: OfficeHelperClient, docId: String) async throws {
        try await click(client: client, docId: docId, xTwips: 100, yTwips: 100)
        try await type(client: client, docId: docId, character: "Z", appKitKeyCode: 6 /* kVK_ANSI_Z */)
        try await pressReturn(client: client, docId: docId)
    }

    private func typeFormulaOnePlusOne(client: OfficeHelperClient, docId: String) async throws {
        try await click(client: client, docId: docId, xTwips: 100, yTwips: 100)
        try await type(client: client, docId: docId, character: "=", appKitKeyCode: 24 /* kVK_ANSI_Equal */)
        try await type(client: client, docId: docId, character: "1", appKitKeyCode: 18 /* kVK_ANSI_1 */)
        try await type(client: client, docId: docId, character: "+", appKitKeyCode: 24, shift: true)
        try await type(client: client, docId: docId, character: "1", appKitKeyCode: 18)
        try await pressReturn(client: client, docId: docId)
    }

    // MARK: - office-live-edit R3 — Calc's ⌘Z behaviour change, pinned

    /// **⛔ THE CALC DRILL. This pins a DELIBERATE CHANGE to behaviour the user already had, which
    /// the user ruled for explicitly.**
    ///
    /// Calc is the one app where a plain ⌘Z after an agent edit did not simply fail. Its undo
    /// manager has a **range-based independence escape** (`ScUndoManager::IsViewUndoActionIndependent`,
    /// `sc/source/ui/undo/undobase.cxx:649-715`): with an agent action on top of the shared stack,
    /// if that action's `ScRange` does not intersect the range of this view's own most recent
    /// action, Calc **skips the agent's action and undoes the user's own earlier one instead**
    /// (`sc/…/tabvwshb.cxx:798-803`, then `ScUndoRedoContext::SetUndoOffset`).
    ///
    /// So the old behaviour was not "⌘Z is blocked" — it was **"⌘Z silently does something other
    /// than what the user asked"**: they press undo expecting the last change back, and get their
    /// own older edit reverted while the agent's change stays. Silently wrong is worse than refused,
    /// and the ruling is that ⌘Z reverts the last thing that happened regardless of who did it.
    ///
    /// **This drill pins three things at once, and each would be a separate defect:**
    /// 1. the behaviour flip itself — the agent's cells come back, the user's cell does NOT;
    /// 2. **the multi-action collapse end to end** — `sheets.set` writes THREE cells, each its own
    ///    engine undo action, and ONE ⌘Z takes back all three. This is the only live coverage of
    ///    the bracket→ledger→multi-dispatch path with a K greater than one;
    /// 3. that the ranges are genuinely DISJOINT (the user in `A1`, the agent in `C3:E3`), which is
    ///    precisely the condition that triggered the old silent-skip. A drill using overlapping
    ///    ranges would pass without ever exercising the behaviour that changed.
    func testLiveCalcUndoNowRevertsTheAgentsEditInsteadOfSilentlySkippingIt() async throws {
        try requireLiveEngine()
        let path = try makeWritableCopy(of: "gate.ods", as: "calc-repair-undo.ods")
        let stateDir = makeScratchDirectory()
        let host = makeLiveHost(stateDir: stateDir,
                                dirs: [SessionDirEntry(path: (path as NSString).deletingLastPathComponent, locked: true)])
        await host.directory.refresh()
        let runtime = host.officeRuntime(for: "S1")

        // ADOPTED: the human has the document open in their own tab. That is the only path the
        // bracket runs on (see `OfficeAgentBroker.runOnce` — a broker-opened document is closed at
        // the end of the call, so its undo stack dies with it and no ⌘Z could ever reach it).
        runtime.open(path)
        let opened = await waitUntilLive { runtime.stateSnapshot.documents[path] != nil || runtime.stateSnapshot.phase == .failed }
        XCTAssertTrue(opened, "setup: the fixture must open cleanly")
        let doc = try XCTUnwrap(runtime.stateSnapshot.documents[path])
        let client = try XCTUnwrap(host.officeHelperSupervisor?.client)

        // ── The human's own edit, on the PRIMARY view: "Z" into A1, committed with Return.
        try await typeOneCharacterOnPrimaryView(client: client, docId: doc.docId)
        let afterUserEdit = await send(command("office.sheets.read",
                                               args: ["path": path, "sheet": "Sheet1", "range": "A1:A1"],
                                               sessionId: "S1", commandId: "pcmd-calc-read-user"), through: host)
        XCTAssertTrue(afterUserEdit.ok, "\(afterUserEdit)")
        XCTAssertTrue(try XCTUnwrap(afterUserEdit.result).contains("Z"),
                      "setup: the human's own edit must land in A1 before the agent writes: \(afterUserEdit)")

        // ── The human saves. **Required, and incidentally load-bearing evidence.**
        //
        // Required: broker rule 3 refuses every agent write to a document left dirty in a human's
        // tab, so without this the agent's write below is refused and the drill measures nothing.
        // (That refusal is correct and stays — this drill's job is the undo semantics, not rule 3.)
        //
        // 🔑 Evidence: **this save is what proves, live, that saving does NOT destroy undo history.**
        // The engine research could only establish that as a bounded negative read from source ("no
        // undo-clear was found on the SID_SAVEDOC path… a strong negative rather than an exhaustive
        // proof"), and it is the single biggest risk to requirements 1 and 3 coexisting: if a save
        // truncated the stack, an instant-save-after-every-edit design would silently destroy ⌘Z.
        // The final assertion below — that the human's pre-save edit is still on the stack and comes
        // back — is that proof, measured rather than argued.
        runtime.save(path)
        let saved = await waitUntilLive { runtime.stateSnapshot.documents[path]?.dirty == false }
        XCTAssertTrue(saved, "setup: the human's own save must land, or rule 3 refuses the agent's write")

        // ── The agent's edit, THREE cells, in a range DISJOINT from A1 — the exact shape that used
        // to make Calc silently step over it.
        let agentWrite = await send(command("office.sheets.set",
                                            args: ["path": path, "sheet": "Sheet1", "range": "C3:E3",
                                                   "values": [["AGENTX", "AGENTY", "AGENTZ"]]],
                                            sessionId: "S1", commandId: "pcmd-calc-agent-set"), through: host)
        XCTAssertTrue(agentWrite.ok, "the agent's write must succeed: \(agentWrite)")

        let afterAgent = await send(command("office.sheets.read",
                                            args: ["path": path, "sheet": "Sheet1", "range": "C3:E3"],
                                            sessionId: "S1", commandId: "pcmd-calc-read-agent"), through: host)
        XCTAssertTrue(afterAgent.ok, "\(afterAgent)")
        let agentText = try XCTUnwrap(afterAgent.result)
        for marker in ["AGENTX", "AGENTY", "AGENTZ"] {
            XCTAssertTrue(agentText.contains(marker),
                          "setup: all three agent cells must land before undo runs: \(agentText)")
        }

        // ── ONE ⌘Z. The literal user-facing door.
        runtime.postUndo(path: path)
        await runtime.drainInputChainForTesting()

        let afterUndo = await send(command("office.sheets.read",
                                           args: ["path": path, "sheet": "Sheet1", "range": "A1:E3"],
                                           sessionId: "S1", commandId: "pcmd-calc-read-undone"), through: host)
        XCTAssertTrue(afterUndo.ok, "\(afterUndo)")
        let undone = try XCTUnwrap(afterUndo.result)
        print("[calc repair-undo drill] after one ⌘Z:\n\(undone)")

        for marker in ["AGENTX", "AGENTY", "AGENTZ"] {
            XCTAssertFalse(undone.contains(marker),
                           "ONE ⌘Z must take back the agent's WHOLE write — \(marker) is still "
                             + "there, so either Repair was dropped (Calc silently skipped to the "
                             + "human's own edit, the old behaviour) or the ledger collapsed the "
                             + "three cells to fewer than three undo actions: \(undone)")
        }
        XCTAssertTrue(undone.contains("Z"),
                      "and the HUMAN's own edit in A1 must survive — repair-undo is strict LIFO over "
                        + "one shared stack, so the agent's actions come off first and the human's "
                        + "earlier edit is untouched. Losing it here would mean one ⌘Z took back "
                        + "more than the user asked for: \(undone)")

        // ── The save/undo-coexistence proof, made explicit rather than left implicit above: the
        // human's edit was SAVED before the agent ever wrote, and it is still undoable now. A
        // second ⌘Z must take it back, restoring the fixture's own original A1. If saving truncated
        // the undo stack, this is where that would show — and it is exactly the risk that decides
        // whether requirement 1 (save after every edit) can coexist with requirement 3 at all.
        runtime.postUndo(path: path)
        await runtime.drainInputChainForTesting()
        let afterSecondUndo = await send(command("office.sheets.read",
                                                 args: ["path": path, "sheet": "Sheet1", "range": "A1:A1"],
                                                 sessionId: "S1", commandId: "pcmd-calc-read-undone-2"), through: host)
        XCTAssertTrue(afterSecondUndo.ok, "\(afterSecondUndo)")
        let restored = try XCTUnwrap(afterSecondUndo.result)
        XCTAssertTrue(restored.contains("NORMA GATE"),
                      "a SAVED edit must still be undoable — the fixture's original A1 must come "
                        + "back. If it does not, saving truncated the undo stack, and instant-save "
                        + "would be silently destroying the user's ⌘Z history: \(restored)")

        _ = host.teardownAllOfficeRuntimesAndStopHelper()
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

        // **Used range asserted literally (review I2) — not eyeballed from a print() line.**
        // Sheet1's real content is "NORMA GATE"/"42" (row 1) and "office stage A embed probe"/""
        // (row 2), spanning A1:B2. Sheet2's real content ("SHEET TWO SEED"/84, "office stage B
        // sheet two probe"/"") spans A1:B2 too — checked directly against the fixture's own
        // content.xml, not assumed. Neither sheet exercises `sheetsInfoOnDedicatedThread`'s own
        // `(0, 0)` disambiguation fallback (see `testLiveASingleCellSheetAndAnEmptySheetBothReport
        // CorrectlyThroughTheZeroZeroFallback` for that path, which THIS fixture cannot reach).
        XCTAssertTrue(result.contains("\"Sheet1\" (active): A1:B2"), result)
        XCTAssertTrue(result.contains("\"Sheet2\": A1:B2"), result)

        // **The active sheet is a genuine, independently-verified fact, not "contains the word
        // active."** `two-sheet.ods`'s own `settings.xml` has NO `ActiveTable` config item at all
        // (checked directly against the fixture's own bytes, once, while diagnosing the bug below) —
        // so LOK's own default for a file with no saved preference applies: part 0, "Sheet1". This
        // is the regression pin for a REAL bug this task's own review caught:
        // `sheetsInfoOnDedicatedThread` originally read `getPart()` AFTER the per-sheet used-range
        // probe loop, which calls `setPart` once per sheet in order — so the reported "active" sheet
        // was always the LAST sheet probed, never the document's real active one. That bug's own
        // live output ("active: Sheet2") LOOKED plausible and this test's original assertion
        // (`contains("active")`) could not have caught it: for a 2-sheet document, "last sheet
        // probed" and "Sheet2" coincide by pure luck of there being exactly two sheets.
        XCTAssertTrue(result.contains("(active: \"Sheet1\")"), result)

        // ADOPTED — never reloaded: the SAME docId a plain runtime.open already produced, still open
        // afterward (rule 2: a document this call did not open must never be closed).
        XCTAssertEqual(runtime.stateSnapshot.documents[path]?.docId, originalDocId,
                       "info on an already-open document must adopt it, never reload it")

        // **`getPart()` is unchanged after BOTH verbs — proven, not assumed, by asking `info` again
        // after a `read` that names a DIFFERENT sheet.** Neither `sheetsInfoOnDedicatedThread`'s own
        // per-sheet probe loop nor `sheetsReadOnDedicatedThread`'s target-sheet switch may leave the
        // document parked away from where it started — an adopted tab's live view must never jump
        // to a different sheet just because the agent asked a read-only question about the
        // workbook. If EITHER restore were missing, this second `info` call would report "Sheet2"
        // (wherever the read above left it), not "Sheet1" again.
        let readOtherSheet = await send(command("office.sheets.read",
                                                 args: ["path": path, "sheet": "Sheet2", "range": "A1:A1"],
                                                 sessionId: "S1"), through: host)
        XCTAssertTrue(readOtherSheet.ok, "\(readOtherSheet)")

        let sentAgain = await send(command("office.sheets.info", args: ["path": path], sessionId: "S1"), through: host)
        XCTAssertTrue(sentAgain.ok, "\(sentAgain)")
        let resultAgain = try XCTUnwrap(sentAgain.result)
        XCTAssertTrue(resultAgain.contains("(active: \"Sheet1\")"),
                      "a read naming Sheet2, or info's own probe loop, left the document parked away from Sheet1: \(resultAgain)")
    }

    /// office-agent-tools T3 review (I2/C2) — `sheetsInfoOnDedicatedThread`'s own `(0, 0)`
    /// disambiguation fallback, exercised deliberately (`two-sheet.ods` cannot reach this path —
    /// both its sheets span A1:B2, confirmed live above). `sparse-sheets.ods` is a purpose-built
    /// fixture (authored by editing `two-sheet.ods`'s own `content.xml` via `zipfile`, same
    /// technique this task used to inspect the fixture's `settings.xml`): Sheet1 has real content
    /// confined to exactly cell A1 ("SOLO CELL", no other cell anywhere carries a value-type or
    /// text), Sheet2 is genuinely empty (no cell anywhere carries a value-type or text). Both
    /// report `getDataArea() == (0, 0)` — the fixture's whole point — so this is the regression
    /// pin for the single-cell-content-vs-A1 disambiguation itself, not merely for `getDataArea`'s
    /// ordinary case (already covered above).
    func testLiveASingleCellSheetAndAnEmptySheetBothReportCorrectlyThroughTheZeroZeroFallback() async throws {
        try requireLiveEngine()
        let path = try makeWritableCopy(of: "sparse-sheets.ods")
        let stateDir = makeScratchDirectory()
        let host = makeLiveHost(stateDir: stateDir, dirs: [SessionDirEntry(path: (path as NSString).deletingLastPathComponent, locked: true)])
        await host.directory.refresh()

        let sent = await send(command("office.sheets.info", args: ["path": path], sessionId: "S1",
                                       commandId: "pcmd-sparse-info"), through: host)
        XCTAssertTrue(sent.ok, "\(sent)")
        let result = try XCTUnwrap(sent.result)
        print("[live sheets info] sparse-sheets.ods ->\n\(result)")

        XCTAssertTrue(result.contains("\"Sheet1\" (active): A1:A1"),
                      "a sheet with real content confined to A1 alone must report A1:A1, not empty: \(result)")
        XCTAssertTrue(result.contains("\"Sheet2\": empty"),
                      "a genuinely empty sheet must report empty, not A1:A1 (the (0,0) ambiguity mapped the wrong way): \(result)")

        // The disambiguation fallback (`sheetHasA1ContentOnDedicatedThread`) reads on the AGENT
        // view — confirm it never perturbed the document's own real state: `read` against Sheet1's
        // real A1 content must still see it afterward. Distinct commandId — the broker's own
        // requestId-keyed memoization (Task 2's deliberate design) would otherwise return this
        // `info` call's own cached result verbatim for a second call sharing its default id.
        let read = await send(command("office.sheets.read",
                                       args: ["path": path, "sheet": "Sheet1", "range": "A1:A1"],
                                       sessionId: "S1", commandId: "pcmd-sparse-read"), through: host)
        XCTAssertTrue(read.ok, "\(read)")
        XCTAssertTrue(try XCTUnwrap(read.result).contains("SOLO CELL"), "\(read)")
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
        ) { _, docId, _ in
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

    /// office-agent-tools T3 re-review (Minor #5) — selection isolation, DRILLED directly rather
    /// than inferred from part isolation alone. The earlier info->read(Sheet2)->info regression pin
    /// (`testLiveSheetsInfoOnAnAdoptedOdsDocumentReportsRealSheetsAndUsedRange`) only ever proved
    /// the document's PART is restored — it says nothing about the primary view's own SELECTION,
    /// which is the actual claim I1's whole agent-view redesign rests on.
    ///
    /// Moves the PRIMARY view's own cursor to a known cell via a real click (the SAME "(100, 100)
    /// twips lands on a real, editable cell" coordinate this file's own `typeFormulaOnePlusOne`
    /// already proves), captures what's selected there via `clipboardCopy` — which does
    /// `setView(doc.viewId)` (the PRIMARY view, unconditionally) then `getTextSelection`, the exact
    /// mechanism a real adopted tab's own UI would show — runs a full agent `sheets read` through
    /// the real wire naming a DIFFERENT sheet and range, then captures the primary's own clipboard
    /// selection again. Byte-identical before and after is the whole claim.
    /// office-agent-tools T3 second re-review (MISS 2) — rewritten after this test's OWN first
    /// version was proven, by direct measurement, not to discriminate. That version clicked to
    /// Sheet1's A1, read Sheet2 through the agent, then observed the primary via
    /// `clipboardCopy(docId, part: 0)` — which itself calls `setPart(0)` before reading. Mutating
    /// `sheetsReadOnDedicatedThread` to read on `doc.viewId` (the primary view) still left this
    /// test GREEN: `clipboardCopy`'s own `setPart(0)` snaps the primary back to Sheet1 regardless
    /// of what the read did to it on Sheet2, and Calc's own PER-SHEET cursor memory then restores
    /// whatever was remembered as current on Sheet1 (still A1, untouched) — camouflaging exactly
    /// the corruption this test exists to catch. A cross-sheet probe was live-measured, in the same
    /// investigation, to show the primary genuinely left parked on Sheet2 despite this test's own
    /// "before == after" verdict staying green throughout.
    ///
    /// Fixed by reading the SAME sheet the primary is already on (`Sheet1!A2:B2`, not `Sheet2!...`)
    /// — no part switch ever happens in the observation, so Calc's memory-restore camouflage never
    /// engages. If the agent read genuinely runs on the agent view, the primary's own selection
    /// (still A1, "NORMA GATE") is untouched. If it mistakenly ran on the primary view instead,
    /// `.uno:GoToCell("A2:B2")` would have moved the primary's own selection there for real, and
    /// this observation reads "office stage A embed probe" (A2's real content) instead — a
    /// genuinely different string, not it silently reverting. **Proven to discriminate, not
    /// assumed**: this exact test, run against a deliberately reintroduced `doc.viewId` mutation in
    /// `sheetsReadOnDedicatedThread`, failed with exactly that mismatch — see this task's own
    /// report for the transcript — before being reverted.
    ///
    /// **Round 4 — the coordinator flagged this assertion as possibly polarity-inverted after a
    /// round-3 full-app-suite run failed here; re-derived from the fixture, confirmed NOT
    /// inverted.** `two-sheet.ods` Sheet1 A1 = "NORMA GATE", A2 = "office stage A embed probe"
    /// (confirmed by unzipping the fixture directly, not from memory). `beforeSelection` is pinned
    /// to "NORMA GATE" by the setup assertion below, so `XCTAssertEqual(beforeSelection,
    /// afterSelection)` already demands `afterSelection == "NORMA GATE"` — the CLEAN value —
    /// matching exactly what the coordinator's own cited reviewer measured ("clean -> NORMA GATE,
    /// mutant -> office stage A embed probe"). The apparent conflict was a misreading of
    /// `XCTAssertEqual`'s failure text, which prints arguments in call order (before, after), not
    /// expected-then-actual: the second-printed value is what was MEASURED that run, not what the
    /// assertion demanded. The two-way proof was rerun to confirm (task-3-report.md §10):
    /// unmutated -> PASS, `doc.viewId` mutant -> FAIL, matching the original round-3 finding.
    ///
    /// **The full-suite failure itself was real, not a false alarm** — this test genuinely saw the
    /// primary's selection move once, under full-suite load, on UNMUTATED code. See
    /// `LOKBridge.sheetsReadOnDedicatedThread` / `selectionTextOnDedicatedThread`'s own headers for
    /// the evidence chain: a raw LOK callback trace, `goToCellVerificationAttempts` hitting its
    /// 4-attempt ceiling, and a reading of the pinned engine source
    /// (`desktop/source/lib/init.cxx`'s `doc_postUnoCommand`) confirming `.uno:GoToCell` dispatches
    /// asynchronously in this build (`SynchronMode=false`, unipoll never enabled) and that the
    /// generic dispatch fallback which handles it does not thread the specific `pViewShell` that
    /// function resolves. This is the SAME disclosed, not-claimed-solved residual
    /// `selectionTextOnDedicatedThread`'s own header already named — now observed live for the
    /// first time. The two assertions below discriminate the two ways this can fail instead of
    /// leaving one ambiguous mismatch: a content check on the read's OWN returned value (fails
    /// first, with its own message, if the read itself came back stale — the straggler signature)
    /// and an absolute check that `afterSelection` literally still contains "NORMA GATE" (fails if
    /// the primary's own selection moved — the isolation signature, whether from a genuine
    /// cross-view read or a queued command landing late against whatever view a later call makes
    /// current).
    func testLiveAgentReadNeverTouchesThePrimaryViewsOwnSelection() async throws {
        try requireLiveEngine()
        let path = try makeWritableCopy(of: "two-sheet.ods")
        let stateDir = makeScratchDirectory()
        let host = makeLiveHost(stateDir: stateDir, dirs: [SessionDirEntry(path: (path as NSString).deletingLastPathComponent, locked: true)])
        await host.directory.refresh()

        let runtime = host.officeRuntime(for: "S1")
        runtime.open(path)
        let opened = await waitUntilLive { runtime.stateSnapshot.documents[path] != nil || runtime.stateSnapshot.phase == .failed }
        XCTAssertTrue(opened, "setup: two-sheet.ods never settled")
        let docId = try XCTUnwrap(runtime.stateSnapshot.documents[path]?.docId)

        guard let client = host.officeHelperSupervisor?.client else {
            return XCTFail("no live client to drive the primary cursor through")
        }

        // Primary cursor -> Sheet1's A1 ("NORMA GATE", the fixture's own known content).
        try await click(client: client, docId: docId, xTwips: 100, yTwips: 100)
        let beforeSelection = try await client.clipboardCopy(docId: docId, part: 0)
        XCTAssertTrue(beforeSelection.contains("NORMA GATE"), "setup: the primary click did not land on A1: \(beforeSelection)")

        // The agent read: the SAME sheet (Sheet1), a DIFFERENT range (A2:B2) — deliberately never
        // switching the primary's own part in the observation below, which is what makes this
        // drill discriminate (see this function's own header).
        let sent = await send(command("office.sheets.read",
                                       args: ["path": path, "sheet": "Sheet1", "range": "A2:B2"],
                                       sessionId: "S1"), through: host)
        XCTAssertTrue(sent.ok, "\(sent)")

        // Discriminates the read's OWN result from the primary's isolation — see this function's
        // own "Round 4" header. A stale read here (the straggler signature: GoToCell never landed
        // on the agent view within its poll budget) fails HERE, first, with its own diagnostic,
        // instead of surfacing only as a confusing isolation mismatch below.
        XCTAssertTrue(try XCTUnwrap(sent.result).contains("office stage A embed probe"),
                      "the agent's own read of Sheet1!A2:B2 did not return A2's real content — a straggler GoToCell may not have landed on the agent view within its poll budget: \(sent)")

        let afterSelection = try await client.clipboardCopy(docId: docId, part: 0)
        // Absolute, arg-order-proof insurance: independent of XCTAssertEqual's printed order below,
        // this fails specifically when the primary's own selection is no longer parked on A1.
        XCTAssertTrue(afterSelection.contains("NORMA GATE"),
                      "the PRIMARY view's own selection moved off A1 during an agent read — either the read ran on the primary view directly, or a queued GoToCell(A2:B2) landed late, after the read returned, against whatever view a later LOK call (here, this test's own clipboardCopy) made current next: \(afterSelection)")
        XCTAssertEqual(beforeSelection, afterSelection,
                       "an agent read moved the PRIMARY view's own selection to A2:B2 — the whole point of reading on the agent view instead")
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

    /// office-agent-tools T3 review (I3) — a cell containing BOTH an embedded tab and an embedded
    /// line break, read against real content, asserted literally against what live-characterization
    /// proved (`LOKBridge.parseTSVGrid`'s own header has the full account and citation of the raw
    /// bytes this test's own fixture produces). `embedded-delimiters.ods` (built the same way
    /// `sparse-sheets.ods` was) has A1 = `<text:tab/>`-and-two-`<text:p>`-paragraph content, B1 an
    /// ordinary cell — one REAL cell boundary for A1's own embedded delimiters to be confused with,
    /// if the fix were wrong.
    /// office-agent-tools T3 review — the "leading empties" cannot-verify, closed. Confirmed live,
    /// not assumed: `getTextSelection` trims a LEADING empty row/column exactly the way
    /// `testLiveARangeSpanningPastTheUsedAreaReturnsOnlyRealContent` already proved it trims a
    /// TRAILING one. `offset-content.ods`'s only real content is at B2 (A1, A2, B1 all genuinely
    /// empty); reading `A1:C3` — a range that fully contains that offset — returns bare
    /// `"OFFSETVALUE"`, with NO leading empty row or column at all, not even a single leading tab.
    ///
    /// **This is a REAL, disclosed positional-fidelity gap, not merely characterized and accepted.**
    /// A model asking for `A1:C3` expecting a 3x3 grid gets back a 1x1 one with no signal of WHERE
    /// within the requested range the value actually sits. It is not fixable by padding the grid
    /// back to the requested range's own shape: that would require knowing exactly how many leading
    /// rows/columns were trimmed, and no LOK mechanism this task found exposes that. `getDataArea`
    /// (`sheetsInfoOnDedicatedThread`'s own C2 mechanism) only ever answers the LAST used row/column
    /// (`ScTable::GetCellArea`'s own `nMaxX`/`nMaxY` — read directly at the pin) — it has no
    /// `nMinX`/`nMinY` counterpart, so there is no cheap way to recover the trimmed leading extent
    /// from information this bridge already has. The tool's own description (`sheets.ts`) warns
    /// callers explicitly rather than leaving this to be discovered by a silently-misaligned read.
    func testLiveARangeWithLeadingEmptyContentIsTrimmedNotPadded() async throws {
        try requireLiveEngine()
        let path = try makeWritableCopy(of: "offset-content.ods")
        let stateDir = makeScratchDirectory()
        let host = makeLiveHost(stateDir: stateDir, dirs: [SessionDirEntry(path: (path as NSString).deletingLastPathComponent, locked: true)])
        await host.directory.refresh()

        let sent = await send(command("office.sheets.read",
                                       args: ["path": path, "sheet": "Sheet1", "range": "A1:C3"],
                                       sessionId: "S1"), through: host)
        XCTAssertTrue(sent.ok, "\(sent)")
        let result = try XCTUnwrap(sent.result)
        XCTAssertTrue(result.contains("OFFSETVALUE"), result)
        XCTAssertEqual(result.components(separatedBy: "\n").count, 2, // header line + exactly one content row
                       "leading empty rows must trim away, not manufacture blank rows: \(result)")
        XCTAssertFalse(result.contains("\t"), "leading empty COLUMNS must trim away too — no tab-padded blank cell before the real value: \(result)")
    }

    func testLiveACellWithAnEmbeddedTabAndLineBreakRoundTripsTheTabAndQuotesTheCell() async throws {
        try requireLiveEngine()
        let path = try makeWritableCopy(of: "embedded-delimiters.ods")
        let stateDir = makeScratchDirectory()
        let host = makeLiveHost(stateDir: stateDir, dirs: [SessionDirEntry(path: (path as NSString).deletingLastPathComponent, locked: true)])
        await host.directory.refresh()

        let sent = await send(command("office.sheets.read",
                                       args: ["path": path, "sheet": "Sheet1", "range": "A1:C1"],
                                       sessionId: "S1"), through: host)
        XCTAssertTrue(sent.ok, "\(sent)")
        let result = try XCTUnwrap(sent.result)

        // The embedded tab round-trips to a REAL tab inside A1's own value, and — because that
        // would otherwise collide with the real column separator — A1 is quoted (RFC4180-style)
        // in the flattened wire text. B1, with no embedded delimiter, is never quoted.
        XCTAssertTrue(result.contains("\"lineone\ttabbed linetwo\"\tNEXTCELL"), result)

        // The embedded LINE BREAK is disclosed-lossy, not corrupting: Calc's own plain-text export
        // converts it to a plain space, genuinely indistinguishable after the fact from a space the
        // user actually typed — "tabbed" and "linetwo" (the two original paragraphs) are joined by
        // exactly one space, never a stray tab or a row split that would misalign B1.
        XCTAssertFalse(result.contains("tabbed\nlinetwo"), "an embedded line break must never surface as a real row split: \(result)")
        XCTAssertEqual(result.components(separatedBy: "\n").count, 2, // header line + exactly one content row
                       "A1's embedded delimiters must never manufacture an extra row: \(result)")

        // office-agent-tools T3 re-review (Important #3) — the quoting itself is an ENCODING, not
        // silent to the model: C1's real content is `say "hi"` (an ORDINARY cell, a literal quote
        // character a user typed, nothing to do with A1's own tab/newline mechanism). Calc's
        // plain-text export passes a literal `"` straight through unescaped — this bridge's own
        // `quotedIfNeededForTSV` (`OfficeCommandConsumer.swift`) is what wraps it, doubling the
        // inner quotes, exactly as it would for a tab. Pinned here against C1 specifically so a
        // regression in that quoting is caught by a cell that has NOTHING to do with A1's own
        // tab/newline fixture content.
        XCTAssertTrue(result.contains("\"say \"\"hi\"\"\""), result)
    }

    // MARK: - office-agent-tools T4: sheets write verbs — live drills

    /// `unzip -p` for a single entry inside a saved OOXML (zip-based) document — mirrors
    /// `OfficeHelperLiveTests.readOOXMLEntry`'s own shape (shell out to a well-understood system
    /// tool rather than reimplement zip reading), kept as a local copy per this suite's own
    /// established per-file-helper convention.
    private func readOOXMLEntry(atPath path: String, entry: String) throws -> String {
        let unzip = Process()
        unzip.executableURL = URL(fileURLWithPath: "/usr/bin/unzip")
        unzip.arguments = ["-p", path, entry]
        let pipe = Pipe()
        unzip.standardOutput = pipe
        try unzip.run()
        unzip.waitUntilExit()
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        return try XCTUnwrap(String(data: data, encoding: .utf8), "\(entry) was not valid UTF-8")
    }

    /// **The core `sheets set` proof — the house standard applied at its strictest: saved bytes, not
    /// a return code, AND the formula drill specifically asked for.** `gate.xlsx`'s own real content
    /// (ground-truthed directly against the fixture's own `xl/worksheets/sheet1.xml`, not assumed):
    /// one sheet, "Sheet1", used range exactly `A1:B2` — so `D1:E2` is real, safely EMPTY space to
    /// write into, on the SAME sheet, without touching or depending on the seed content at all.
    ///
    /// Four cells, four different claims:
    /// - D1 = `"42"` — a plain value, must land as a real NUMBER (reads back `"42"`, not the
    ///   literal string with quotes or any Calc-side reformatting surprise).
    /// - E1 = `"=SUM(D1:D1)"` — a REAL formula referencing the cell this same call just wrote,
    ///   proving order-within-one-call is D1-before-E1 (row-major, this file's own documented
    ///   contract) and that Calc recalculates: reads back `"42"` in values mode (SUM of a single 42),
    ///   `"=SUM(D1:D1)"` verbatim in formulas mode.
    /// - D2 = `"hello world"` — plain text, byte-identical round trip.
    /// - E2 = `"'=NOT A REAL FORMULA"` — the CALLER-supplied apostrophe-escape drill (`sheets.ts`'s
    ///   own documented convention: the caller types the apostrophe, exactly like a human would,
    ///   never auto-inserted server-side — see `OfficeCommandConsumer.handleSheetsSet`'s own header
    ///   for the real bug this drill caught in an earlier draft that DID auto-insert one). Must land
    ///   as LITERAL TEXT reading back WITHOUT the leading apostrophe (Calc's own force-text
    ///   convention strips it) — if Calc had instead tried to PARSE `NOT A REAL FORMULA` as a
    ///   formula expression, this would read back as an error token (`#NAME?` or similar), never the
    ///   original text — a genuinely discriminating assertion, not a vacuous one.
    ///
    /// **The formula proof obligation, satisfied at the strongest level available**: after saving,
    /// the raw `xl/worksheets/sheet1.xml` entry is unzipped directly and asserted to contain a real
    /// `<f>` (formula) XML element for E1 — proof the engine stored it AS a formula in the OOXML
    /// itself, independent of `formulas:true`'s own read-side display-mode toggle (which this same
    /// drill also exercises, but which proves only what LOK's own text-selection API reports, not
    /// what actually landed in the saved file).
    func testLiveSheetsSetWritesValuesAndAFormulaReadsBackCorrectlyAndPersistsInTheRealXML() async throws {
        try requireLiveEngine()
        let path = try makeWritableCopy(of: "gate.xlsx")
        let stateDir = makeScratchDirectory()
        let host = makeLiveHost(stateDir: stateDir, dirs: [SessionDirEntry(path: (path as NSString).deletingLastPathComponent, locked: true)])
        await host.directory.refresh()

        // Open directly first — the write must ADOPT, never reload, exactly like every other write
        // drill in this file.
        let runtime = host.officeRuntime(for: "S1")
        runtime.open(path)
        let opened = await waitUntilLive { runtime.stateSnapshot.documents[path] != nil || runtime.stateSnapshot.phase == .failed }
        XCTAssertTrue(opened, "setup: gate.xlsx never settled")
        let originalDocId = try XCTUnwrap(runtime.stateSnapshot.documents[path]?.docId)

        let setSent = await send(command("office.sheets.set", args: [
            "path": path, "sheet": "Sheet1", "range": "D1:E2",
            "values": [["42", "=SUM(D1:D1)"], ["hello world", "'=NOT A REAL FORMULA"]],
        ], sessionId: "S1", commandId: "pcmd-set-1"), through: host)
        XCTAssertTrue(setSent.ok, "\(setSent)")
        XCTAssertTrue(setSent.result?.contains("4 cells") == true, "\(setSent)")
        XCTAssertEqual(runtime.stateSnapshot.documents[path]?.docId, originalDocId,
                       "the write must have ADOPTED the already-open document, never reloaded it")
        XCTAssertEqual(runtime.stateSnapshot.documents[path]?.dirty, false,
                       "a write verb saves through — the document must be clean again by the time this returns")

        // Read back in VALUES mode.
        let valuesSent = await send(command("office.sheets.read",
                                            args: ["path": path, "sheet": "Sheet1", "range": "D1:E2"],
                                            sessionId: "S1", commandId: "pcmd-read-values"), through: host)
        XCTAssertTrue(valuesSent.ok, "\(valuesSent)")
        let valuesResult = try XCTUnwrap(valuesSent.result)
        XCTAssertTrue(valuesResult.contains("42\t42"), "D1=42, E1=SUM(D1:D1) must compute to 42: \(valuesResult)")
        XCTAssertTrue(valuesResult.contains("hello world"), valuesResult)
        XCTAssertTrue(valuesResult.contains("=NOT A REAL FORMULA"),
                      "the apostrophe-escaped cell must read back as the ORIGINAL literal text, proving "
                          + "it was never parsed as a formula: \(valuesResult)")
        XCTAssertFalse(valuesResult.contains("#NAME"), "a #NAME? error means the apostrophe escape did "
                       + "NOT fire and Calc tried to parse the literal text as a formula: \(valuesResult)")

        // Read back in FORMULAS mode.
        let formulasSent = await send(command("office.sheets.read",
                                              args: ["path": path, "sheet": "Sheet1", "range": "D1:E2", "formulas": true],
                                              sessionId: "S1", commandId: "pcmd-read-formulas"), through: host)
        XCTAssertTrue(formulasSent.ok, "\(formulasSent)")
        let formulasResult = try XCTUnwrap(formulasSent.result)
        XCTAssertTrue(formulasResult.contains("=SUM(D1:D1)"), "the formula TEXT must appear verbatim: \(formulasResult)")
        XCTAssertTrue(formulasResult.contains("=NOT A REAL FORMULA"),
                      "a literal string starting with = must read the same in formulas mode too — it "
                          + "was never a formula to begin with: \(formulasResult)")

        // The formula proof obligation — the SAVED FILE'S OWN XML, not LOK's own read-back API.
        // Live-observed (not assumed): Calc's own OOXML export normalizes a same-cell range
        // ("D1:D1") to a bare single-cell reference ("D1") inside the formula text — real, correct
        // Calc/Excel behaviour, not a bug in this mechanism — so the assertion checks for the real
        // `<f>` ELEMENT plus the SUM reference, not a byte-exact echo of what was typed.
        let sheetXML = try readOOXMLEntry(atPath: path, entry: "xl/worksheets/sheet1.xml")
        XCTAssertTrue(sheetXML.contains("<c r=\"E1\"") && sheetXML.contains("<f "),
                     "the saved OOXML itself must carry a real <f> formula element for E1, not just a "
                         + "computed value: \(sheetXML.prefix(4000))")
        XCTAssertTrue(sheetXML.contains("SUM(D1)"),
                     "the formula's own reference must survive (Calc normalizes D1:D1 -> D1): \(sheetXML.prefix(4000))")
        // ...and the CELL VALUE Calc cached alongside the formula must be the real computed result,
        // not a stale/zero placeholder — proof this was a genuinely LIVE, evaluated formula.
        XCTAssertTrue(sheetXML.contains("<f aca=\"false\">SUM(D1)</f><v>42</v>")
                       || sheetXML.contains("SUM(D1)</f><v>42</v>"),
                     "the formula's cached computed value must be 42: \(sheetXML.prefix(4000))")

        // Reopen through the raw helper client, under a SEPARATE docId — a genuinely independent
        // open, never the adopted runtime's own docId — confirming the write survived a real
        // close+reopen path, the round-trip step every write drill in this file's own house
        // standard requires. (The adopted runtime/tab is left exactly as the broker's own rule 2
        // leaves it — untouched, since this call never opened it.)
        guard let client = host.officeHelperSupervisor?.client else {
            return XCTFail("no live client to reopen through")
        }
        let reopenDocId = "sheets-set-reopen"
        let metadata = try await client.open(docId: reopenDocId, path: path)
        XCTAssertEqual(metadata.type, .spreadsheet)
        let reopenRows = try await client.sheetsRead(docId: reopenDocId, sheet: "Sheet1", range: "D1:E2", formulas: false)
        XCTAssertEqual(reopenRows, [["42", "42"], ["hello world", "=NOT A REAL FORMULA"]],
                       "the write must survive an independent close+reopen, exact values")
        try await client.close(docId: reopenDocId)
    }

    /// office-agent-tools T4 fix-round review (Important #2) — a formula character
    /// `formulaKeyEvent(for:)` cannot type (`café`'s own `é`, the reviewer's own example: real,
    /// non-ASCII, exactly the shape `character.asciiValue` refuses) must never leave a real,
    /// uncommitted, PARTIAL formula stranded in Calc's own edit mode. Two cells in ONE `set` call,
    /// D1 (a plain value, no problem) then D2 (the bad formula) — deliberately in THIS order, so a
    /// wrongly-still-atomic implementation could not hide the bug behind "nothing ran yet": D1 must
    /// land for real (this task's own write path is non-atomic ACROSS cells by design — a SEPARATE,
    /// disclosed property from THIS fix, which only closes the WITHIN-one-cell partial-typing gap —
    /// see the tool description disclosure this same review round adds) while D2 itself must come
    /// back COMPLETELY untouched, not a fragment of "=A1&"" (what the OLD code would have left: a
    /// dropped `é` character stops the keystroke loop mid-formula, but everything BEFORE it was
    /// already typed and left sitting, uncommitted, in Calc's own cell-edit mode).
    func testLiveSheetsSetPreValidatesEveryFormulaCharacterBeforeTypingAnyOfThem() async throws {
        try requireLiveEngine()
        let path = try makeWritableCopy(of: "gate.xlsx")
        let stateDir = makeScratchDirectory()
        let host = makeLiveHost(stateDir: stateDir, dirs: [SessionDirEntry(path: (path as NSString).deletingLastPathComponent, locked: true)])
        await host.directory.refresh()

        let runtime = host.officeRuntime(for: "S1")
        runtime.open(path)
        let opened = await waitUntilLive { runtime.stateSnapshot.documents[path] != nil || runtime.stateSnapshot.phase == .failed }
        XCTAssertTrue(opened, "setup: gate.xlsx never settled")

        let sent = await send(command("office.sheets.set", args: [
            "path": path, "sheet": "Sheet1", "range": "D1:D2",
            "values": [["ok value"], ["=A1&\"café\""]],
        ], sessionId: "S1", commandId: "pcmd-badformula-1"), through: host)
        XCTAssertFalse(sent.ok, "an unmapped formula character must refuse, not silently drop the character: \(sent)")
        let result = try XCTUnwrap(sent.result)
        XCTAssertTrue(result.contains("D2"), "the refusal must name the cell that actually failed: \(result)")
        XCTAssertFalse(result.lowercased().contains("uno:"), result)
        XCTAssertFalse(result.lowercased().contains("exception"), result)

        // D2 — the bad cell — must be COMPLETELY untouched: not "=A1&"" (a partial formula from the
        // OLD, mid-loop-throw code), not left in Calc's own uncommitted edit mode (which would make
        // the FOLLOWING read itself behave strangely), genuinely empty.
        let d2Read = await send(command("office.sheets.read",
                                        args: ["path": path, "sheet": "Sheet1", "range": "D2"],
                                        sessionId: "S1", commandId: "pcmd-badformula-read-d2"), through: host)
        XCTAssertTrue(d2Read.ok, "\(d2Read)")
        let d2Result = try XCTUnwrap(d2Read.result)
        XCTAssertFalse(d2Result.contains("A1"), "D2 must carry NO fragment of the never-committed formula: \(d2Result)")
        XCTAssertFalse(d2Result.contains("café"), d2Result)

        // D1 — written BEFORE the bad cell, in the SAME call — legitimately landed: this task's own
        // write path is non-atomic ACROSS cells (disclosed in the tool description, not hidden), a
        // different property from the WITHIN-one-cell fix this test targets.
        let d1Read = await send(command("office.sheets.read",
                                        args: ["path": path, "sheet": "Sheet1", "range": "D1"],
                                        sessionId: "S1", commandId: "pcmd-badformula-read-d1"), through: host)
        XCTAssertTrue(d1Read.ok, "\(d1Read)")
        XCTAssertTrue((d1Read.result ?? "").contains("ok value"),
                      "D1 (written before the bad cell) must have landed for real — non-atomicity is disclosed, not silently masked: \(String(describing: d1Read.result))")

        // Second fix-round review (Important #2) — the read directly above is an ADOPTED, IN-MEMORY
        // read: it can only ever show "written," never distinguish that from "written AND saved,"
        // which is EXACTLY the ambiguity that let `sheets.ts`'s own false "have already been written
        // and saved" claim go unnoticed through the first fix round. The coordinator's own
        // instruction: "the existing in-memory read showing D1 present can stay; the pair is the
        // cleanest possible demonstration of written-vs-saved." This is the other half of that pair
        // — a genuinely independent reopen straight from disk, the SAME mechanism every other
        // saved-bytes proof in this file already uses (`sheets-resize-reopen-midchain` etc.).
        XCTAssertEqual(runtime.stateSnapshot.documents[path]?.dirty, true,
                       "the tab must be left DIRTY by the failed call — `action` threw before rule "
                           + "4's save switch ever ran, so nothing from this call was ever saved")
        guard let independentClient = host.officeHelperSupervisor?.client else {
            return XCTFail("no live client for the independent reopen")
        }
        let independentDocId = "sheets-set-partial-failure-reopen"
        _ = try await independentClient.open(docId: independentDocId, path: path)
        let savedD1Rows = try await independentClient.sheetsRead(docId: independentDocId, sheet: "Sheet1",
                                                                   range: "D1", formulas: false)
        let savedD1 = savedD1Rows.map { $0.joined(separator: "\t") }.joined(separator: "\n")
        XCTAssertFalse(savedD1.contains("ok value"),
                       "D1 must be ABSENT from the SAVED FILE — it was written to the in-memory "
                           + "document only, never saved, since the call failed before rule 4's save "
                           + "switch ever ran: \(savedD1)")
        try await independentClient.close(docId: independentDocId)

        // The wedge, proven live, not merely asserted: rule 3's own dirty refusal must now fire for
        // ANY further write to this SAME document — the tab is dirty with edits the human never
        // asked for, and only the human (saving or discarding) can clear it. "Re-read before
        // retrying" (the per-cell failure text) is NOT a recovery path for this document anymore.
        let followUpSent = await send(command("office.sheets.set", args: [
            "path": path, "sheet": "Sheet1", "range": "E1", "values": [["should refuse"]],
        ], sessionId: "S1", commandId: "pcmd-badformula-followup"), through: host)
        XCTAssertFalse(followUpSent.ok, "a follow-up write to the now-dirty tab must be refused, "
                       + "proving the wedge rather than merely asserting it: \(followUpSent)")
        XCTAssertTrue((followUpSent.result ?? "").lowercased().contains("unsaved"),
                      "the refusal must be the rule-3 dirty refusal specifically: \(String(describing: followUpSent.result))")
    }

    /// Second fix-round review (Important #2) — the OPENED (not adopted) half of the same claim: a
    /// document this tool opens SOLELY for one `set` call, with no prior tab already showing it, has
    /// its earlier, in-call cells DISCARDED — not wedged — when the failure's `defer` closes it. Two
    /// things this proves that the adopted case above cannot: the file on disk is genuinely
    /// UNCHANGED (nothing this call did ever reached disk, not even transiently), and the VERY NEXT
    /// call for the SAME path does NOT refuse — no dirty tab exists to wedge it, unlike the adopted
    /// case's own proven wedge.
    func testLiveSheetsSetOnAnUnopenedDocumentDiscardsPartialWorkAndTheNextCallDoesNotWedge() async throws {
        try requireLiveEngine()
        let path = try makeWritableCopy(of: "gate.xlsx")
        let stateDir = makeScratchDirectory()
        let host = makeLiveHost(stateDir: stateDir, dirs: [SessionDirEntry(path: (path as NSString).deletingLastPathComponent, locked: true)])
        await host.directory.refresh()
        // Deliberately NO `runtime.open(path)` here — this call must MINT its own open, not adopt an
        // already-open tab, the opposite setup from the adopted test above.

        let originalBytes = try Data(contentsOf: URL(fileURLWithPath: path))

        let sent = await send(command("office.sheets.set", args: [
            "path": path, "sheet": "Sheet1", "range": "D1:D2",
            "values": [["ok value"], ["=A1&\"café\""]],
        ], sessionId: "S1", commandId: "pcmd-opened-badformula-1"), through: host)
        XCTAssertFalse(sent.ok, "\(sent)")
        XCTAssertTrue((sent.result ?? "").lowercased().contains("discarded"),
                      "the opened-not-adopted failure text must say DISCARDED, not the adopted "
                          + "case's unsaved/dirty wording: \(String(describing: sent.result))")

        let bytesAfterFailure = try Data(contentsOf: URL(fileURLWithPath: path))
        XCTAssertEqual(originalBytes, bytesAfterFailure,
                       "the file on disk must be BYTE-IDENTICAL to before this call — the broker-"
                           + "opened document's `defer` closes it unsaved on the throw, discarding "
                           + "D1's own in-memory write along with it, never touching disk at all")

        // No wedge: the NEXT call for this same path must NOT be refused — there is no dirty tab
        // left behind to refuse it, the behavioral difference from the adopted case above.
        let nextCallSent = await send(command("office.sheets.read",
                                              args: ["path": path, "sheet": "Sheet1", "range": "D1"],
                                              sessionId: "S1", commandId: "pcmd-opened-badformula-next"), through: host)
        XCTAssertTrue(nextCallSent.ok, "the NEXT call must succeed cleanly — no wedge left behind by "
                      + "a discarded (not dirty-adopted) partial failure: \(nextCallSent)")
        XCTAssertFalse((nextCallSent.result ?? "").contains("ok value"),
                       "and it must read the GENUINELY UNCHANGED file — D1 was never saved: \(String(describing: nextCallSent.result))")
    }

    /// office-agent-tools T4 fix-round review (Important #3) — DELETION-RED for the new position
    /// check itself (`writeOneCellOnDedicatedThread`'s `positionVerificationFailed` guard,
    /// `LOKBridge.swift`). `.uno:GoToCell` reliably lands within budget in this environment on every
    /// live run this task has ever observed — there is no NATURAL way to force a genuine mispositioned
    /// cursor to prove the refusal fires on a true mismatch, so this test proves the guard is real and
    /// load-bearing the same way this branch's own house standard already proves other refusals:
    /// temporarily invert the comparison in `writeOneCellOnDedicatedThread` (`==` to `!=`, both
    /// `column` and `row`), confirm this SAME live drill goes RED (every correctly-positioned write
    /// now wrongly refuses), then revert. Recorded here as PROSE, not a permanent mutant test (an
    /// inverted guard would make EVERY OTHER write test in this file fail too, which is the point,
    /// but leaving the inversion in the tree is not) — see task-4-fix-round-report.md for the actual
    /// before/after run this test produced under the temporary inversion.
    func testLiveSheetsSetWritesToTheCorrectCellNotABystanderOneOverOrOneOverOnAHappyPath() async throws {
        try requireLiveEngine()
        let path = try makeWritableCopy(of: "gate.xlsx")
        let stateDir = makeScratchDirectory()
        let host = makeLiveHost(stateDir: stateDir, dirs: [SessionDirEntry(path: (path as NSString).deletingLastPathComponent, locked: true)])
        await host.directory.refresh()

        let runtime = host.officeRuntime(for: "S1")
        runtime.open(path)
        let opened = await waitUntilLive { runtime.stateSnapshot.documents[path] != nil || runtime.stateSnapshot.phase == .failed }
        XCTAssertTrue(opened, "setup: gate.xlsx never settled")

        // A 3x3 block, each cell carrying its OWN address as its value — if position verification
        // ever let a write land on the WRONG cell, this is what would catch it: every cell's real,
        // saved content is compared against its OWN expected address, not just "is D1:F3 non-empty."
        let addresses = ["D1", "E1", "F1", "D2", "E2", "F2", "D3", "E3", "F3"]
        let values: [[String]] = [["D1", "E1", "F1"], ["D2", "E2", "F2"], ["D3", "E3", "F3"]]
        let sent = await send(command("office.sheets.set", args: [
            "path": path, "sheet": "Sheet1", "range": "D1:F3", "values": values,
        ], sessionId: "S1", commandId: "pcmd-grid-1"), through: host)
        XCTAssertTrue(sent.ok, "\(sent)")

        let readSent = await send(command("office.sheets.read",
                                          args: ["path": path, "sheet": "Sheet1", "range": "D1:F3"],
                                          sessionId: "S1", commandId: "pcmd-grid-read"), through: host)
        XCTAssertTrue(readSent.ok, "\(readSent)")
        let result = try XCTUnwrap(readSent.result)
        // Every one of the 9 cells' own address must appear — a bystander clobber would show a cell
        // holding a NEIGHBOR's address instead of its own, or a blank where a real one belongs.
        for address in addresses {
            XCTAssertTrue(result.contains(address), "cell \(address) must hold its OWN address, proving position verification did not misplace it: \(result)")
        }
    }

    /// office-agent-tools T4 fix-round review (item 6) — the tool description must disclose real
    /// behavior, never a guess: this test finds out, LIVE, whether writing an empty string `""` to a
    /// cell that already has content CLEARS it. `writeOneCellOnDedicatedThread`'s own code posts a
    /// REAL empty ext-text-input event plus a real Return keypress for `text == ""` — nothing skips
    /// the actual LOK calls; only the POST-write verification READ is skipped afterward (`guard
    /// !text.isEmpty else { return }` sits AFTER the typing block, not before it) — so the outcome is
    /// a genuinely open question this drill settles rather than assumes.
    func testLiveSheetsSetWithAnEmptyStringDetermineWhetherItClearsOrNoOps() async throws {
        try requireLiveEngine()
        let path = try makeWritableCopy(of: "gate.xlsx")
        let stateDir = makeScratchDirectory()
        let host = makeLiveHost(stateDir: stateDir, dirs: [SessionDirEntry(path: (path as NSString).deletingLastPathComponent, locked: true)])
        await host.directory.refresh()

        let runtime = host.officeRuntime(for: "S1")
        runtime.open(path)
        let opened = await waitUntilLive { runtime.stateSnapshot.documents[path] != nil || runtime.stateSnapshot.phase == .failed }
        XCTAssertTrue(opened, "setup: gate.xlsx never settled")

        // Seed D1 with known content first.
        let seedSent = await send(command("office.sheets.set",
                                          args: ["path": path, "sheet": "Sheet1", "range": "D1", "values": [["hello"]]],
                                          sessionId: "S1", commandId: "pcmd-empty-seed"), through: host)
        XCTAssertTrue(seedSent.ok, "\(seedSent)")
        let afterSeed = await send(command("office.sheets.read", args: ["path": path, "sheet": "Sheet1", "range": "D1"],
                                           sessionId: "S1", commandId: "pcmd-empty-read-seed"), through: host)
        XCTAssertTrue(afterSeed.result?.contains("hello") == true, "setup: D1 must carry the seed first: \(afterSeed)")

        // Now write an empty string to the SAME cell.
        let emptySent = await send(command("office.sheets.set",
                                           args: ["path": path, "sheet": "Sheet1", "range": "D1", "values": [[""]]],
                                           sessionId: "S1", commandId: "pcmd-empty-1"), through: host)
        XCTAssertTrue(emptySent.ok, "an empty-string write must not itself be refused: \(emptySent)")

        let afterEmpty = await send(command("office.sheets.read", args: ["path": path, "sheet": "Sheet1", "range": "D1"],
                                            sessionId: "S1", commandId: "pcmd-empty-read-after"), through: host)
        XCTAssertTrue(afterEmpty.ok, "\(afterEmpty)")
        // LIVE FINDING (recorded here, not assumed): an empty string DOES clear the cell — the real
        // ext-text-input("")+Return sequence commits an empty edit, the same way a human selecting a
        // cell and pressing Delete/Return would. Printed for visibility in case a future engine
        // version changes this; the tool description (`sheets.ts`) states this finding directly.
        print("[empty-string probe] D1 after writing \"\" -> \"\(afterEmpty.result ?? "<nil>")\"")
        XCTAssertFalse(afterEmpty.result?.contains("hello") == true,
                       "LIVE FINDING: an empty-string write clears the cell — \"hello\" must be gone: \(afterEmpty)")
    }

    /// office-agent-tools T4 fix-round review (item 6) — the tool description's apostrophe-escape
    /// convention says a caller writes a LEADING apostrophe to force text mode (`"'=NOT A FORMULA"`
    /// already proven live, `testLiveSheetsSetWritesValues...`). This drill settles the DOUBLED case
    /// LIVE: does a cell whose real content should legitimately START WITH an apostrophe character
    /// (`'twas the night...`) round-trip correctly if the caller escapes it as `''twas the night...`
    /// — one apostrophe consumed as the force-text marker, one surviving as real content — matching
    /// the same convention a human typing directly into Calc relies on?
    func testLiveSheetsSetADoubledLeadingApostropheRoundTripsToASingleLeadingApostrophe() async throws {
        try requireLiveEngine()
        let path = try makeWritableCopy(of: "gate.xlsx")
        let stateDir = makeScratchDirectory()
        let host = makeLiveHost(stateDir: stateDir, dirs: [SessionDirEntry(path: (path as NSString).deletingLastPathComponent, locked: true)])
        await host.directory.refresh()

        let runtime = host.officeRuntime(for: "S1")
        runtime.open(path)
        let opened = await waitUntilLive { runtime.stateSnapshot.documents[path] != nil || runtime.stateSnapshot.phase == .failed }
        XCTAssertTrue(opened, "setup: gate.xlsx never settled")

        let sent = await send(command("office.sheets.set",
                                      args: ["path": path, "sheet": "Sheet1", "range": "D1", "values": [["''twas the night"]]],
                                      sessionId: "S1", commandId: "pcmd-apos-1"), through: host)
        XCTAssertTrue(sent.ok, "\(sent)")

        let readSent = await send(command("office.sheets.read", args: ["path": path, "sheet": "Sheet1", "range": "D1"],
                                          sessionId: "S1", commandId: "pcmd-apos-read"), through: host)
        XCTAssertTrue(readSent.ok, "\(readSent)")
        let result = try XCTUnwrap(readSent.result)
        print("[apostrophe probe] D1 after writing \"''twas the night\" -> \"\(result)\"")
        // LIVE FINDING (recorded here, not assumed): the FIRST apostrophe is consumed as the
        // force-text marker (same as the single-apostrophe case already proven); the SECOND survives
        // as real content — the cell reads back with exactly ONE leading apostrophe.
        XCTAssertTrue(result.contains("'twas the night"), "the surviving apostrophe + text must be present: \(result)")
        XCTAssertFalse(result.contains("''twas the night"), "only ONE apostrophe should survive — the first is the escape marker, not real content: \(result)")
    }

    /// **`add_sheet`/`delete_sheet`/`rename_sheet`, chained on one document — including the ONE
    /// genuinely unverified unknown this task's own research flagged plainly rather than guessed
    /// at**: the JSON "type" string `.uno:Remove`'s numeric `Index` argument needs, which
    /// `postUnoCommand`'s own `comphelper::JsonToPropertyValues` machinery could not be confirmed
    /// from source alone (this task's research: "an honest gap, not a guess dressed up as fact") —
    /// AND the real headless-hang risk if it is wrong (`pReqArgs == nullptr`-shaped args opens a
    /// synchronous, undismissable confirmation dialog on the dedicated thread). Run in isolation,
    /// never batched with other live drills, for exactly that reason — `OfficeHelperClient`'s own
    /// bounded `requestTimeout` (30s) protects THIS test's own outcome even in the worst case, but a
    /// wedged dedicated thread would still strand the ONE helper process this test's own scratch
    /// state directory mints, never another test's.
    ///
    /// `gate.xlsx` starts with exactly one sheet ("Sheet1" — ground-truthed against the fixture's
    /// own `xl/workbook.xml`, not assumed). The chain: add "Q3" (2 sheets) -> rename "Q3" to
    /// "Revenue" (still 2, different name) -> delete "Revenue" (back to 1 — THIS dispatches
    /// `.uno:Remove`, the unverified door) -> delete "Sheet1", now the ONLY sheet, must REFUSE
    /// (`SaveError.lastSheet`) -> add "Sheet1" (a duplicate of the sheet that still exists) must
    /// REFUSE (`SaveError.duplicateSheetName`) — DELETION-RED for both refusals: each is preceded by
    /// a real, structurally identical call that SUCCEEDS, so an assertion that always passes
    /// regardless of the real refusal logic (e.g. a stale `ok` check) would be caught by the
    /// contrast, not merely trusted.
    func testLiveSheetsManageSheetAddRenameDeleteAndTheTwoPreDispatchRefusals() async throws {
        try requireLiveEngine()
        let path = try makeWritableCopy(of: "gate.xlsx")
        let stateDir = makeScratchDirectory()
        let host = makeLiveHost(stateDir: stateDir, dirs: [SessionDirEntry(path: (path as NSString).deletingLastPathComponent, locked: true)])
        await host.directory.refresh()

        let runtime = host.officeRuntime(for: "S1")
        runtime.open(path)
        let opened = await waitUntilLive { runtime.stateSnapshot.documents[path] != nil || runtime.stateSnapshot.phase == .failed }
        XCTAssertTrue(opened, "setup: gate.xlsx never settled")
        let originalDocId = try XCTUnwrap(runtime.stateSnapshot.documents[path]?.docId)

        // add_sheet
        let addSent = await send(command("office.sheets.add_sheet", args: ["path": path, "name": "Q3"],
                                         sessionId: "S1", commandId: "pcmd-add-1"), through: host)
        XCTAssertTrue(addSent.ok, "\(addSent)")
        XCTAssertTrue(addSent.result?.contains("Sheet1") == true && addSent.result?.contains("Q3") == true, "\(addSent)")
        XCTAssertEqual(runtime.stateSnapshot.documents[path]?.docId, originalDocId, "add_sheet must ADOPT, never reload")

        // rename_sheet
        let renameSent = await send(command("office.sheets.rename_sheet",
                                            args: ["path": path, "name": "Q3", "newName": "Revenue"],
                                            sessionId: "S1", commandId: "pcmd-rename-1"), through: host)
        XCTAssertTrue(renameSent.ok, "\(renameSent)")
        XCTAssertTrue(renameSent.result?.contains("Revenue") == true && renameSent.result?.contains("Q3") == false, "\(renameSent)")

        // Mid-chain SAVED-BYTES proof (coordinator review, the ❌ blocker) — every assertion above
        // reads the adopted runtime's own in-memory sheet list, which would read back correctly even
        // if NEITHER add_sheet NOR rename_sheet ever persisted a single byte to disk. Worse: this
        // chain's own END state (after delete_sheet removes "Revenue") is `["Sheet1"]` — IDENTICAL to
        // gate.xlsx's own pristine, untouched sheet list — so a reopen taken only at the end (the
        // ORIGINAL form of this test) would pass even if add/rename/delete were all silent no-ops.
        // Reopening HERE, mid-chain, at `["Sheet1", "Revenue"]` — a state that can ONLY exist if BOTH
        // add_sheet and rename_sheet genuinely persisted — closes that gap the same way `8d232cb9`
        // already closed it for the resize round trip.
        XCTAssertEqual(runtime.stateSnapshot.documents[path]?.dirty, false,
                       "must be saved-through before the mid-chain reopen below can prove anything")
        guard let midChainClient = host.officeHelperSupervisor?.client else {
            return XCTFail("no live client for the mid-chain reopen")
        }
        let midChainDocId = "sheets-manage-reopen-midchain"
        _ = try await midChainClient.open(docId: midChainDocId, path: path)
        let (midChainSheets, _) = try await midChainClient.sheetsInfo(docId: midChainDocId)
        XCTAssertEqual(midChainSheets.map(\.name), ["Sheet1", "Revenue"],
                       "add_sheet + rename_sheet must have actually PERSISTED to the saved file — "
                           + "read from a genuinely independent reopen, not the adopted runtime's "
                           + "in-memory model")
        // Closed BEFORE the delete step below, not left open — this task's own live-forced retreat
        // (this function's own header, and LOKBridge.sheetsManageSheetOnDedicatedThread's) found
        // `.uno:Remove` hangs whenever ANY agent view exists for this docId; closing this reopened
        // docId's own view here keeps that variable isolated from this test's own reopen addition.
        try await midChainClient.close(docId: midChainDocId)

        // delete_sheet — the unverified .uno:Remove numeric-Index door.
        let deleteSent = await send(command("office.sheets.delete_sheet", args: ["path": path, "name": "Revenue"],
                                            sessionId: "S1", commandId: "pcmd-delete-1"), through: host)
        XCTAssertTrue(deleteSent.ok, "\(deleteSent)")
        XCTAssertTrue(deleteSent.result?.contains("Sheet1") == true && deleteSent.result?.contains("Revenue") == false, "\(deleteSent)")

        // DELETION-RED #1 — the last sheet must be refused, right after a real delete just succeeded.
        let lastSheetSent = await send(command("office.sheets.delete_sheet", args: ["path": path, "name": "Sheet1"],
                                               sessionId: "S1", commandId: "pcmd-delete-last"), through: host)
        XCTAssertFalse(lastSheetSent.ok, "deleting the only remaining sheet must be refused: \(lastSheetSent)")
        XCTAssertTrue(lastSheetSent.result?.lowercased().contains("only") == true, "\(lastSheetSent)")

        // DELETION-RED #2 — a duplicate name must be refused, right after a real add just succeeded.
        let dupSent = await send(command("office.sheets.add_sheet", args: ["path": path, "name": "Sheet1"],
                                         sessionId: "S1", commandId: "pcmd-add-dup"), through: host)
        XCTAssertFalse(dupSent.ok, "adding a sheet with an already-existing name must be refused: \(dupSent)")
        XCTAssertTrue(dupSent.result?.lowercased().contains("already exists") == true, "\(dupSent)")

        // Persistence: reopen independently and confirm the real sheet list survived.
        guard let client = host.officeHelperSupervisor?.client else {
            return XCTFail("no live client to reopen through")
        }
        let reopenDocId = "sheets-manage-reopen"
        let metadata = try await client.open(docId: reopenDocId, path: path)
        XCTAssertEqual(metadata.type, .spreadsheet)
        let (reopenSheets, _) = try await client.sheetsInfo(docId: reopenDocId)
        XCTAssertEqual(reopenSheets.map(\.name), ["Sheet1"], "only the real, surviving sheet list must persist")
        try await client.close(docId: reopenDocId)
    }

    /// office-agent-tools T4 fix-round review (item 5) — the discriminating drill for moving the
    /// agent-view destroy to AFTER each case's own refusal guards
    /// (`LOKBridge.sheetsManageSheetOnDedicatedThread`'s own header has the full reasoning). Mints an
    /// agent view directly, THEN drives a refusal (`delete_sheet` naming the workbook's only sheet —
    /// `SaveError.lastSheet`, guaranteed to throw before any dispatch), then asks for a SECOND agent
    /// view on the SAME docId: `createAgentView` refuses with `agentViewAlreadyExists`
    /// (`OfficeWireFrame.createView`'s own documented refusal — Task 3's own invariant, "no second
    /// agent view for one docId") if, and ONLY if, the first one this test minted is STILL ALIVE.
    ///
    /// **Why this is genuinely discriminating, not merely plausible**: BEFORE this fix-round's own
    /// reorder, the refusal in the middle of this test would have destroyed the agent view
    /// UNCONDITIONALLY (the original code's own placement, before the `switch`) even though the call
    /// went on to throw and dispatch nothing — so the SECOND `createAgentView` below would have
    /// SUCCEEDED (minting a fresh one into the now-empty slot) instead of refusing. This test would
    /// have FAILED against the pre-fix code, which is exactly what makes it evidence for the fix now,
    /// not a restatement of it.
    func testLiveSheetsManageSheetRefusalDoesNotDestroyAnExistingAgentView() async throws {
        try requireLiveEngine()
        let path = try makeWritableCopy(of: "gate.xlsx")
        let stateDir = makeScratchDirectory()
        let host = makeLiveHost(stateDir: stateDir, dirs: [SessionDirEntry(path: (path as NSString).deletingLastPathComponent, locked: true)])
        await host.directory.refresh()

        let runtime = host.officeRuntime(for: "S1")
        runtime.open(path)
        let opened = await waitUntilLive { runtime.stateSnapshot.documents[path] != nil || runtime.stateSnapshot.phase == .failed }
        XCTAssertTrue(opened, "setup: gate.xlsx never settled")
        let docId = try XCTUnwrap(runtime.stateSnapshot.documents[path]?.docId)

        guard let client = host.officeHelperSupervisor?.client else {
            return XCTFail("no live client")
        }
        _ = try await client.createAgentView(docId: docId)

        // gate.xlsx has exactly one sheet ("Sheet1") — deleting it is a guaranteed, guard-only
        // refusal: `SaveError.lastSheet` throws before the switch's own `.delete` case ever reaches
        // its dispatch line.
        let refused = await send(command("office.sheets.delete_sheet", args: ["path": path, "name": "Sheet1"],
                                         sessionId: "S1", commandId: "pcmd-refuse-1"), through: host)
        XCTAssertFalse(refused.ok, "deleting the only sheet must refuse: \(refused)")

        do {
            _ = try await client.createAgentView(docId: docId)
            XCTFail("a second createAgentView must refuse — the refusal above must NOT have "
                   + "destroyed the first agent view this test minted")
        } catch let error as OfficeHelperClientError {
            guard case .serverError(let reason) = error else {
                return XCTFail("expected .serverError(agentViewAlreadyExists), got: \(error)")
            }
            XCTAssertTrue(reason.contains("already has an agent view"),
                          "the refusal must be agentViewAlreadyExists specifically, proving the "
                              + "FIRST view survived the delete_sheet refusal above: \(reason)")
        }
    }

    /// office-agent-tools T4 fix-round review (item 6) — the tool description must disclose which
    /// manage-sheet verbs move the active sheet. Task 4's own original report confirmed
    /// `rename_sheet` mechanically (its own `setPart` call — `LOKBridge.sheetsManageSheetOnDedicated
    /// Thread`'s `.rename` case) and called `add_sheet` merely "plausible" (standard Calc "new sheet
    /// becomes active" UX, never itself observed). `delete_sheet` was never addressed either way.
    /// This drill settles both LIVE rather than leaving the tool description to guess: does `info`'s
    /// own reported active sheet change after `add_sheet`, and after `delete_sheet` on a sheet that
    /// is NOT the active one?
    func testLiveWhichManageSheetVerbsActuallyMoveTheActiveSheet() async throws {
        try requireLiveEngine()
        let path = try makeWritableCopy(of: "gate.xlsx")
        let stateDir = makeScratchDirectory()
        let host = makeLiveHost(stateDir: stateDir, dirs: [SessionDirEntry(path: (path as NSString).deletingLastPathComponent, locked: true)])
        await host.directory.refresh()

        let runtime = host.officeRuntime(for: "S1")
        runtime.open(path)
        let opened = await waitUntilLive { runtime.stateSnapshot.documents[path] != nil || runtime.stateSnapshot.phase == .failed }
        XCTAssertTrue(opened, "setup: gate.xlsx never settled")

        func activeSheet() async throws -> String {
            let sent = await send(command("office.sheets.info", args: ["path": path], sessionId: "S1",
                                          commandId: "pcmd-active-\(UUID().uuidString.prefix(6))"), through: host)
            let result = try XCTUnwrap(sent.result)
            // "active" info formatting: `"Name" (active): ...` — extract the quoted name before it.
            guard let range = result.range(of: "\" (active)") else {
                XCTFail("no active sheet found in: \(result)")
                return ""
            }
            let beforeActive = result[result.startIndex..<range.lowerBound]
            guard let lastQuote = beforeActive.lastIndex(of: "\"") else { return "" }
            return String(beforeActive[beforeActive.index(after: lastQuote)...])
        }

        let initialActive = try await activeSheet()
        XCTAssertEqual(initialActive, "Sheet1", "setup: gate.xlsx's own default active sheet")

        let afterAdd = await send(command("office.sheets.add_sheet", args: ["path": path, "name": "Q3"],
                                          sessionId: "S1", commandId: "pcmd-active-add"), through: host)
        XCTAssertTrue(afterAdd.ok, "\(afterAdd)")
        let activeAfterAdd = try await activeSheet()
        print("[active-sheet probe] active after add_sheet(\"Q3\") -> \"\(activeAfterAdd)\"")

        let afterDelete = await send(command("office.sheets.delete_sheet", args: ["path": path, "name": "Q3"],
                                             sessionId: "S1", commandId: "pcmd-active-delete"), through: host)
        XCTAssertTrue(afterDelete.ok, "\(afterDelete)")
        let activeAfterDelete = try await activeSheet()
        print("[active-sheet probe] active after delete_sheet(\"Q3\", not the active one) -> \"\(activeAfterDelete)\"")

        // LIVE FINDING, pinned — stable across 3 separate isolated runs (this one plus 2 reruns
        // before this assertion was added), unlike `rename_sheet`'s OWN active-sheet effect, which
        // Task 4's original report found genuinely non-deterministic across otherwise-identical runs.
        // The tool description (`sheets.ts`) states this finding directly; if a future engine version
        // changes it, THIS assertion is what would catch that, not a silently-rotting print statement.
        XCTAssertEqual(activeAfterAdd, "Sheet1", "add_sheet must not move the active sheet")
        XCTAssertEqual(activeAfterDelete, "Sheet1", "delete_sheet on a non-active sheet must not move the active sheet")
    }

    /// `insert_rows`/`insert_cols`/`delete_rows`/`delete_cols`, round-tripped: shift real, known
    /// content (`gate.xlsx`'s own A1 = "NORMA GATE", ground-truthed via this file's own raw-callback
    /// trace on a prior run, not assumed) two rows down and one column right, then back — each step
    /// verified by READING the content at its new expected position, not merely by a dimension
    /// number. A structural verb that silently shifted the WRONG range, or shifted by the wrong
    /// count, would leave the content somewhere this drill does not look, which is exactly what a
    /// position-based (not count-based) assertion catches.
    ///
    /// **The saved-bytes proof lives MID-CHAIN, not just at the end.** Every `readCell()` call in
    /// this test reads through the ADOPTED runtime document — the in-memory LOK model — which would
    /// read back correctly even if the save-through to disk silently failed. And the chain's own
    /// final position is the fixture's OWN untouched A1, so a reopen taken only after the full
    /// round trip cannot discriminate "really persisted" from "never persisted at all" — both look
    /// identical from there. So after `insert_cols` (the maximally-shifted state this chain ever
    /// reaches, content at B3, never coinciding with the original), a SEPARATE docId opens the SAME
    /// path independently via the raw helper client — `testLiveSheetsSetWritesValues...`'s own
    /// reopen pattern, taken mid-chain instead of at the end — and reads from THAT copy, which can
    /// only reflect what the two prior writes actually put on disk.
    func testLiveSheetsResizeInsertAndDeleteRowsAndColumnsShiftRealContentAndRoundTrips() async throws {
        try requireLiveEngine()
        let path = try makeWritableCopy(of: "gate.xlsx")
        let stateDir = makeScratchDirectory()
        let host = makeLiveHost(stateDir: stateDir, dirs: [SessionDirEntry(path: (path as NSString).deletingLastPathComponent, locked: true)])
        await host.directory.refresh()

        let runtime = host.officeRuntime(for: "S1")
        runtime.open(path)
        let opened = await waitUntilLive { runtime.stateSnapshot.documents[path] != nil || runtime.stateSnapshot.phase == .failed }
        XCTAssertTrue(opened, "setup: gate.xlsx never settled")
        let originalDocId = try XCTUnwrap(runtime.stateSnapshot.documents[path]?.docId)

        func readCell(_ cell: String) async -> String {
            let sent = await send(command("office.sheets.read",
                                          args: ["path": path, "sheet": "Sheet1", "range": cell],
                                          sessionId: "S1", commandId: "pcmd-r-\(UUID().uuidString.prefix(6))"), through: host)
            return sent.result ?? "<no result: \(sent)>"
        }

        // Baseline — confirmed real, not assumed.
        let baseline = await readCell("A1")
        XCTAssertTrue(baseline.contains("NORMA GATE"), "setup: A1 must be the known seed text: \(baseline)")

        // insert_rows at=1 count=2 — shifts A1 down to A3.
        let insertRowsSent = await send(command("office.sheets.insert_rows",
                                                args: ["path": path, "sheet": "Sheet1", "at": 1, "count": 2],
                                                sessionId: "S1", commandId: "pcmd-ir-1"), through: host)
        XCTAssertTrue(insertRowsSent.ok, "\(insertRowsSent)")
        XCTAssertEqual(runtime.stateSnapshot.documents[path]?.docId, originalDocId, "insert_rows must ADOPT")
        let afterInsertRows = await readCell("A3")
        XCTAssertTrue(afterInsertRows.contains("NORMA GATE"), "content must shift DOWN by 2 rows: \(afterInsertRows)")
        let a1AfterInsert = await readCell("A1")
        XCTAssertFalse(a1AfterInsert.contains("NORMA GATE"), "A1 must be vacated by the insert: \(a1AfterInsert)")

        // insert_cols at="A" count=1 — shifts A3 right to B3.
        let insertColsSent = await send(command("office.sheets.insert_cols",
                                                args: ["path": path, "sheet": "Sheet1", "at": "A", "count": 1],
                                                sessionId: "S1", commandId: "pcmd-ic-1"), through: host)
        XCTAssertTrue(insertColsSent.ok, "\(insertColsSent)")
        let afterInsertCols = await readCell("B3")
        XCTAssertTrue(afterInsertCols.contains("NORMA GATE"), "content must shift RIGHT by 1 column: \(afterInsertCols)")

        // Mid-chain SAVED-BYTES proof (see the doc comment above for why this must happen HERE,
        // not only at the chain's end). `dirty == false` on the adopted runtime is the save-through
        // signal every other write drill in this file already trusts before reopening — confirm it
        // before treating a second open of the same path as meaningful.
        XCTAssertEqual(runtime.stateSnapshot.documents[path]?.dirty, false,
                       "must be saved-through before the mid-chain reopen below can prove anything")
        guard let midChainClient = host.officeHelperSupervisor?.client else {
            return XCTFail("no live client for the mid-chain reopen")
        }
        let midChainDocId = "sheets-resize-reopen-midchain"
        _ = try await midChainClient.open(docId: midChainDocId, path: path)
        func midChainCell(_ cell: String) async throws -> String {
            let rows = try await midChainClient.sheetsRead(docId: midChainDocId, sheet: "Sheet1", range: cell, formulas: false)
            return rows.map { $0.joined(separator: "\t") }.joined(separator: "\n")
        }
        let midChainB3 = try await midChainCell("B3")
        XCTAssertTrue(midChainB3.contains("NORMA GATE"),
                      "the insert_rows+insert_cols shift must have actually PERSISTED to the saved "
                          + "file — read from a genuinely independent reopen, not the adopted "
                          + "runtime's in-memory model: \(midChainB3)")
        let midChainA1 = try await midChainCell("A1")
        XCTAssertFalse(midChainA1.contains("NORMA GATE"),
                       "A1 must be vacated in the SAVED file too, not just the in-memory model: \(midChainA1)")
        try await midChainClient.close(docId: midChainDocId)

        // delete_cols at="A" count=1 — shifts B3 back to A3.
        let deleteColsSent = await send(command("office.sheets.delete_cols",
                                                args: ["path": path, "sheet": "Sheet1", "at": "A", "count": 1],
                                                sessionId: "S1", commandId: "pcmd-dc-1"), through: host)
        XCTAssertTrue(deleteColsSent.ok, "\(deleteColsSent)")
        let afterDeleteCols = await readCell("A3")
        XCTAssertTrue(afterDeleteCols.contains("NORMA GATE"), "content must shift back LEFT: \(afterDeleteCols)")

        // delete_rows at=1 count=2 — shifts A3 back to A1, the original position.
        let deleteRowsSent = await send(command("office.sheets.delete_rows",
                                                args: ["path": path, "sheet": "Sheet1", "at": 1, "count": 2],
                                                sessionId: "S1", commandId: "pcmd-dr-1"), through: host)
        XCTAssertTrue(deleteRowsSent.ok, "\(deleteRowsSent)")
        let backToOriginal = await readCell("A1")
        XCTAssertTrue(backToOriginal.contains("NORMA GATE"), "the full round trip must restore the "
                     + "original position exactly: \(backToOriginal)")
        XCTAssertEqual(runtime.stateSnapshot.documents[path]?.docId, originalDocId,
                       "every resize verb in this chain must have ADOPTED — never reloaded")
        XCTAssertEqual(runtime.stateSnapshot.documents[path]?.dirty, false,
                       "every write verb saves through — the document must be clean after the last one")

        // End-of-chain SAVED-BYTES proof (coordinator review, the ❌ blocker) —
        // `delete_rows`/`delete_cols` had NO saved-bytes proof of their own anywhere in this test:
        // the mid-chain reopen added by `8d232cb9` covers insert_rows+insert_cols only, and this
        // chain's own FINAL position is `gate.xlsx`'s own pristine, untouched A1 — a reopen here
        // would pass even if delete_rows/delete_cols silently did nothing at all, since the fixture's
        // OWN unwritten A1 already reads "NORMA GATE". **Checks B3, not B2** — the coordinator's own
        // review named B2, but B3 is the cell THIS chain's own insert_cols step actually shifted real
        // content into (line ~1119 above, `afterInsertCols`/the mid-chain reopen both target B3 for
        // the same reason) — B2 is never touched anywhere in this chain, so asserting it stays empty
        // would be true regardless of whether delete_rows/delete_cols worked at all, exactly the
        // vacuity this fix-round exists to close, not reproduce under a different cell letter. B3
        // genuinely discriminates: if EITHER delete verb failed to persist, a leftover fragment would
        // still be sitting there on the SAVED file, which this reopen would catch even though the
        // adopted runtime's own in-memory model already (correctly) shows a clean round trip.
        guard let endChainClient = host.officeHelperSupervisor?.client else {
            return XCTFail("no live client for the end-of-chain reopen")
        }
        let endChainDocId = "sheets-resize-reopen-endchain"
        _ = try await endChainClient.open(docId: endChainDocId, path: path)
        let endChainA1 = try await endChainClient.sheetsRead(docId: endChainDocId, sheet: "Sheet1", range: "A1", formulas: false)
        XCTAssertEqual(endChainA1, [["NORMA GATE"]],
                       "the full round trip must have actually PERSISTED A1's restoration to the "
                           + "saved file — read from a genuinely independent reopen, not the adopted "
                           + "runtime's in-memory model")
        let endChainB3 = try await endChainClient.sheetsRead(docId: endChainDocId, sheet: "Sheet1", range: "B3", formulas: false)
        XCTAssertNotEqual(endChainB3, [["NORMA GATE"]],
                          "B3 (the cell insert_cols shifted real content into, earlier in this same "
                              + "chain) must be vacated in the SAVED file too — no leftover fragment "
                              + "from delete_cols/delete_rows: \(endChainB3)")
        try await endChainClient.close(docId: endChainDocId)
    }

    /// **Rule 3 — the dirty refusal, live.** A document a human's own tab holds DIRTY (a real,
    /// unsaved keystroke edit through the PRIMARY view — never the agent's own view, which would be
    /// a different, less honest drill) must refuse a `sheets set` naming the tab, exactly as
    /// `OfficeAgentBroker`'s own rule 3 requires — proven here through the REAL `sheets` tool path,
    /// not the broker's own fake-driver unit tests.
    func testLiveSheetsSetRefusesADirtyAdoptedDocumentNamingTheTab() async throws {
        try requireLiveEngine()
        let path = try makeWritableCopy(of: "gate.xlsx")
        let stateDir = makeScratchDirectory()
        let host = makeLiveHost(stateDir: stateDir, dirs: [SessionDirEntry(path: (path as NSString).deletingLastPathComponent, locked: true)])
        await host.directory.refresh()

        let runtime = host.officeRuntime(for: "S1")
        runtime.open(path)
        let opened = await waitUntilLive { runtime.stateSnapshot.documents[path] != nil || runtime.stateSnapshot.phase == .failed }
        XCTAssertTrue(opened, "setup: gate.xlsx never settled")
        guard let client = host.officeHelperSupervisor?.client else {
            return XCTFail("no live client to dirty the primary view through")
        }
        let docId = try XCTUnwrap(runtime.stateSnapshot.documents[path]?.docId)

        // A real, unsaved edit on the PRIMARY view — the human's own tab, never the agent's.
        try await typeOneCharacterOnPrimaryView(client: client, docId: docId)
        let dirtied = await waitUntilLive(timeout: 15) { runtime.stateSnapshot.documents[path]?.dirty == true }
        XCTAssertTrue(dirtied, "setup: the primary-view edit never landed as dirty")
        let beforeStat = officeFileStat(atPath: path)

        let setSent = await send(command("office.sheets.set", args: [
            "path": path, "sheet": "Sheet1", "range": "H10", "values": [["should never land"]],
        ], sessionId: "S1", commandId: "pcmd-dirty-refuse"), through: host)
        XCTAssertFalse(setSent.ok, "a write on a dirty adopted document must refuse: \(setSent)")
        let name = (path as NSString).lastPathComponent
        XCTAssertTrue(setSent.result?.contains(name) == true, "the refusal must name the tab: \(setSent)")

        // No file changed — the strongest form of this drill's own claim.
        XCTAssertEqual(officeFileStat(atPath: path), beforeStat, "a refused write must never touch the "
                       + "file — the stat must be byte-identical to before the attempt")
        XCTAssertEqual(runtime.stateSnapshot.documents[path]?.dirty, true,
                       "the document must remain exactly as dirty as the human left it")

        // Confirm the refusal is real, not merely "any string with the filename" — the SAME range
        // read back must show NOTHING was written.
        let readBack = await send(command("office.sheets.read",
                                          args: ["path": path, "sheet": "Sheet1", "range": "H10"],
                                          sessionId: "S1", commandId: "pcmd-dirty-verify"), through: host)
        XCTAssertFalse(readBack.result?.contains("should never land") == true, "\(readBack)")
    }

    /// **The office fence, live, on a WRITE verb** — mirrors
    /// `testLiveAPathOutsideWorkingDirectoriesGetsTheFenceRefusal` (T3's own read-side drill)
    /// exactly, through `OfficeCommandConsumer` directly with a path outside every working
    /// directory. No document is ever opened — the fence in `handleSheetsSet` runs before the
    /// broker is ever reached, the identical ordering every read verb already has.
    func testLiveSheetsSetOutsideWorkingDirectoriesGetsTheFenceRefusalNeverOpeningAnything() async throws {
        try requireLiveEngine()
        let path = try makeWritableCopy(of: "gate.xlsx")
        let stateDir = makeScratchDirectory()
        // The fence's own working directories are a DIFFERENT, unrelated scratch dir — `path` is
        // real and readable, just outside the session's own fence.
        let fencedDir = makeScratchDirectory()
        let host = makeLiveHost(stateDir: stateDir, dirs: [SessionDirEntry(path: fencedDir.path, locked: true)])
        await host.directory.refresh()

        let sent = await send(command("office.sheets.set", args: [
            "path": path, "sheet": "Sheet1", "range": "A1", "values": [["nope"]],
        ], sessionId: "S1"), through: host)
        XCTAssertFalse(sent.ok, "\(sent)")
        XCTAssertTrue(sent.result?.contains("working directories") == true, "\(sent)")

        // Confirm nothing opened at all — the runtime's own document table must stay empty.
        let runtime = host.officeRuntime(for: "S1")
        XCTAssertTrue(runtime.stateSnapshot.documents.isEmpty, "the fence must refuse before ANY open: "
                     + "\(runtime.stateSnapshot.documents)")
    }

    // **Disclosed, deliberately NOT pinned by a test — see `sheetsManageSheetOnDedicatedThread`'s
    // own header for the full live-evidence story.** All three `manage_sheet` ops dispatch on the
    // PRIMARY view (unlike `sheets set`/`insert_rows`/`insert_cols`/`delete_rows`/`delete_cols`,
    // which ARE genuinely isolated to the agent view, proven live) after an agent-view isolation
    // attempt was itself reverted live: it broke `.uno:Remove` outright (a hang) and, once that was
    // fixed separately, left `.add`/`.rename`'s own post-dispatch verification unable to converge
    // across repeated isolated reruns. `rename_sheet`'s own `setPart` call runs on whichever view is
    // current — the primary one — so it CAN move an adopted tab's own visible active sheet.
    //
    // A first attempt at this comment's own regression test asserted that move as a deterministic
    // outcome (`active: "Renamed"` after renaming a different sheet) — live-measured to be WRONG:
    // across repeated runs the primary's own reported active sheet was inconsistent (`"Sheet1"` in
    // one full-class run, `"Renamed"` in an earlier isolated one, identical code, identical
    // sequence). The side effect itself is evidently racy, not a clean, always-reproducible one —
    // asserting either direction would be a flaky test, which this file's own house standard treats
    // as worse than no test. Left disclosed in prose, honestly, rather than pinned by an assertion
    // that could not be made reliable in the time this task had — see task-4-report.md's concerns.

    /// **Writing to a document the user has OPEN and CLEAN must repaint AND persist** — the proof
    /// obligation's own words. Mirrors `OfficeAgentBrokerTests.testLiveAdoptionEditsTheAlready
    /// OpenDocumentInPlaceAndNeverClosesIt`'s own repaint predicate exactly (paint BEFORE the write,
    /// compare pixels AFTER — a PRESENT tile that DIFFERS, never merely "the old tile is gone",
    /// which an eviction-timing artifact could satisfy too) — that task's own drill proved this for
    /// a raw keystroke edit; this one proves the identical claim for the real `sheets set` tool path.
    func testLiveSheetsSetOnAnOpenCleanDocumentRepaintsTheCanvasAndPersists() async throws {
        try requireLiveEngine()
        let path = try makeWritableCopy(of: "gate.xlsx")
        let stateDir = makeScratchDirectory()
        let host = makeLiveHost(stateDir: stateDir, dirs: [SessionDirEntry(path: (path as NSString).deletingLastPathComponent, locked: true)])
        await host.directory.refresh()

        let runtime = host.officeRuntime(for: "S1")
        runtime.open(path)
        let opened = await waitUntilLive { runtime.stateSnapshot.documents[path] != nil || runtime.stateSnapshot.phase == .failed }
        XCTAssertTrue(opened, "setup: gate.xlsx never settled")
        let originalDocId = try XCTUnwrap(runtime.stateSnapshot.documents[path]?.docId)
        XCTAssertEqual(runtime.stateSnapshot.documents[path]?.dirty, false, "setup: a freshly opened document must start clean")

        let beforeStat = officeFileStat(atPath: path)

        let zoomPPT = 1000
        let tileKey = TileKey(part: 0, zoomPPT: zoomPPT, tileX: 0, tileY: 0)
        let viewport = officeViewportTwips(scrollOrigin: .zero, visibleSize: CGSize(width: 256, height: 256), zoomPPT: zoomPPT)
        runtime.subscribeTiles(path: path, part: 0, zoomPPT: zoomPPT, viewportTwips: viewport)
        let paintedBefore = await waitUntilLive(timeout: 30) { runtime.tileStore.tile(docId: originalDocId, key: tileKey) != nil }
        XCTAssertTrue(paintedBefore, "the pre-write tile never arrived")
        let pixelsBefore = try XCTUnwrap(runtime.tileStore.tile(docId: originalDocId, key: tileKey)).pixels

        let setSent = await send(command("office.sheets.set", args: [
            "path": path, "sheet": "Sheet1", "range": "A1", "values": [["REPAINTED"]],
        ], sessionId: "S1", commandId: "pcmd-repaint-1"), through: host)
        XCTAssertTrue(setSent.ok, "\(setSent)")
        XCTAssertEqual(runtime.stateSnapshot.documents[path]?.docId, originalDocId, "the write must ADOPT, never reload")
        XCTAssertEqual(runtime.stateSnapshot.documents[path]?.dirty, false, "the write must save through and clean the dirty dot")
        XCTAssertNotEqual(officeFileStat(atPath: path), beforeStat, "the write must persist to the real path")

        runtime.subscribeTiles(path: path, part: 0, zoomPPT: zoomPPT, viewportTwips: viewport)
        let repainted = await waitUntilLive(timeout: 30) {
            guard let pixels = runtime.tileStore.tile(docId: originalDocId, key: tileKey)?.pixels else { return false }
            return pixels != pixelsBefore
        }
        XCTAssertTrue(repainted, "the canvas never repainted — a sheets set on an open, clean document "
                     + "must invalidate and repaint the tile the same way a human's own edit does")
    }
}
