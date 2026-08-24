import Foundation
import NormaProtocol

/// office-agent-tools T1/T3/T4/T5/T6 (task-1/3/4/5/6-brief.md; design
/// `docs/superpowers/specs/2026-08-22-office-agent-tools-design.md` §1, §2, §3, §6) — the office half
/// of the `panel_command` bridge B2 built for the browser tool (`PanelCommandConsumer.swift`'s own
/// header). T1 shipped this as a ROUTING SHELL where every verb answered a synchronous "not
/// implemented yet" refusal; T3 gave `sheets`' two READ verbs (`info`/`read`) real behaviour — the
/// FIRST verbs this file ever actually performed. T4/T5 gave `sheets`' whole write half (`set`,
/// resize, manage-sheet, `format`) the same; T6 gives every `slides` verb (`info`/`read`/`set_text`/
/// `add_slide`/`delete_slide`/`reorder`) the same. `docs` is the ONLY kind still on T1's own
/// synchronous refusal shell — still routed to `Self.refusal(for:)`, still answered on this file's
/// own single `sendResult` call — see that function's own doc, below, for why nothing about its shape
/// needed to change for every other verb to stop using it.
///
/// ## Why T1's "no `Call` latch" reasoning still holds for two ASYNCHRONOUS verbs
///
/// T1's header argued no deadline/latch machinery was owed because every verb answered
/// synchronously. `info`/`read` are genuinely asynchronous now (`await officeAgentBroker(...)
/// .perform(...)`), and still need none of `PanelCommandConsumer`'s `Call`/timer machinery — the
/// exactly-once guarantee stays structural for a different reason than T1's: each async handler below
/// is a straight-line `async` function with exactly one `sendResult` call on every exit path (success,
/// every catch branch), and each is reached from exactly one `Task { }` spawned once per command,
/// never raced against a second attempt the way `PanelCommandConsumer`'s multi-round-trip CDP verbs
/// are. No CLIENT-side deadline timer is armed either — the DAEMON's own `OFFICE_DEADLINES_MS`
/// (`packages/core/src/panel/office-commands.ts`) is the one clock this file relies on; if it fires
/// first, the daemon reports `{kind:"timeout"}` and this file's own eventual `sendResult` call (if the
/// broker call ever completes) simply lands on a `commandId` the daemon no longer has a pending entry
/// for — a documented, harmless no-op on that side (`PanelCommandRegistry.resolve`'s own `"dropped"`
/// case), not a double-answer.
///
/// **Narrow, disclosed residual T3 does not close**: unlike `PanelCommandConsumer.handle`'s own quit
/// beat guard (checked again by NOTHING inside a still-running CDP chain either, as far as this file's
/// own reading of that machinery goes), a `sheets info`/`read` `Task` already in flight when
/// `BrowserRuntime.quiesce()` begins is not re-checked before its own eventual `sendResult` fires —
/// this file has no `BrowserRuntime` reference to ask. The window is the same ~150ms beat T1's own
/// header names, and a socket write landing inside it is the SAME class of risk `PanelCommandConsumer`
/// itself already carries for any CDP round trip in flight at that instant; not a NEW hazard T3
/// introduces, but not one T3 closes either.
///
/// ## No verb list is mirrored here — and this is the evidence for T1's no-kit-tag claim
///
/// `PanelCommand.action` is a plain `String` (`SessionEvent.swift`), not a Swift enum, precisely so
/// growth on the TS producer's side needs no Swift change — B2's own growth from one verb to nine
/// already proved this ("this type deliberately did not have to change for it", that file's own
/// comment). `isOfficeAction` below tests a PREFIX, not a membership list, for the identical reason:
/// the wire ships 22 verbs today (`OFFICE_COMMAND_ACTIONS`, events.ts), and a later task that gives
/// one of them real behaviour needs only a new `case` in this file's `handle` switch — never a change
/// to what COUNTS as an office action, and never a Swift protocol-type change either. T3's own two new
/// verbs proved this AGAIN: no `packages/protocol` change, no NormaProtocol/NormaKit change — see the
/// task's own report for the kit-tag verdict.
///
/// ## The refusal string is bounded on purpose
///
/// `PanelCommandConsumer.answer` caps its outgoing `result` at the wire's own limit as a LAST
/// resort, because an over-cap `result` is REFUSED WHOLE by the daemon at `parseParams`, this app's
/// `try?` on the RPC send swallows that rejection, and the command then expires on its deadline —
/// silence, on exactly the message a refusal exists to deliver (that file's `answer` doc carries the
/// full incident this guards against). This consumer bypasses `answer()` entirely (it has no `Call`
/// to answer through), so it owns the same guarantee itself. T1's own refusal path never echoed
/// `args` at all — `info`/`read`'s real answers now DO carry model-influenced content (a sheet name,
/// a value grid), which is exactly why T3 enforces its own bound (`sheetsResultMaxLength`, below,
/// mirroring `PanelCommandConsumer.resultMaxLength`/`PanelURLPolicy.wireLength`'s UTF-16-code-unit
/// discipline) on every string this file builds from real document content, checked BEFORE
/// `sendResult` is ever called with it — refused, not silently truncated, so a caller is told the
/// truth about what happened rather than shown a quietly-clipped grid.
@MainActor
struct OfficeCommandConsumer {

    /// Structurally identical to `PanelCommandConsumer.ResultSender` — not imported from there on
    /// purpose. The two files answer through the same RPC but otherwise share no state, and a type
    /// alias costs nothing to redeclare while a shared import would couple two files that have
    /// nothing else to say to each other.
    typealias ResultSender = (_ sessionId: String, _ commandId: String, _ ok: Bool,
                              _ result: String?, _ imageBase64: String?) -> Void

    private let sendResult: ResultSender

    /// office-agent-tools T3 — the one door onto real office behaviour: `ShellSessionHost
    /// .officeAgentBroker`, injected as a closure (mirroring `sendResult`'s own `[weak host]` capture
    /// at the `AppDelegate` construction site) rather than a stored `ShellSessionHost` reference, for
    /// the identical reason `OfficeAgentBroker.Host` itself is closures-based: nothing host-shaped is
    /// safely constructible under XCTest. `nil` is a real, honest answer (the host deallocated between
    /// being asked and this closure running — the same pathological case `OfficeAgentBroker.Host`'s
    /// own doc names), not a force-unwrap away from a crash.
    private let officeAgentBroker: (_ sessionId: String) -> OfficeAgentBroker?

    init(sendResult: @escaping ResultSender,
         officeAgentBroker: @escaping (_ sessionId: String) -> OfficeAgentBroker? = { _ in nil }) {
        self.sendResult = sendResult
        self.officeAgentBroker = officeAgentBroker
    }

    /// Is this an office verb? Called by `PanelCommandConsumer.handle` to decide whether to route
    /// here at all — a PREFIX test, not a membership list, for the reason this file's header gives.
    static func isOfficeAction(_ action: String) -> Bool {
        action.hasPrefix("office.")
    }

    /// Route one office command. The entry point, and the only one this type needs.
    ///
    /// `sheets.info`/`sheets.read` are real now — dispatched onto their own `Task`, one per command,
    /// so `handle` itself stays synchronous and non-blocking exactly as it always has (a caller that
    /// wanted an `await`able `handle` would have to change `PanelCommandConsumer.handle`'s own call
    /// site too, which T3 does not touch). Every OTHER action — T1's entire refusal surface — is
    /// UNCHANGED: answered here, synchronously, with the same structured refusal as before.
    func handle(_ command: SessionEvent.PanelCommand) {
        switch command.action {
        case "office.sheets.info":
            Task { await handleSheetsInfo(command) }
        case "office.sheets.read":
            Task { await handleSheetsRead(command) }
        case "office.sheets.set":
            Task { await handleSheetsSet(command) }
        case "office.sheets.insert_rows", "office.sheets.insert_cols",
             "office.sheets.delete_rows", "office.sheets.delete_cols":
            Task { await handleSheetsResize(command) }
        case "office.sheets.add_sheet", "office.sheets.delete_sheet", "office.sheets.rename_sheet":
            Task { await handleSheetsManageSheet(command) }
        case "office.sheets.format":
            Task { await handleSheetsFormat(command) }
        case "office.slides.info":
            Task { await handleSlidesInfo(command) }
        case "office.slides.read":
            Task { await handleSlidesRead(command) }
        case "office.slides.set_text":
            Task { await handleSlidesSetText(command) }
        case "office.slides.add_slide", "office.slides.delete_slide", "office.slides.reorder":
            Task { await handleSlidesManagePage(command) }
        default:
            sendResult(command.sessionId, command.commandId, false,
                       Self.refusal(for: command.action), nil)
        }
    }

    // MARK: - office-agent-tools T3: sheets info/read

    /// How much of a REAL result (one built from actual document content, never T1's own static
    /// refusal prose) this file will ever hand to `sendResult`. Mirrors
    /// `PanelCommandConsumer.resultMaxLength` (64 KiB) exactly — the SAME wire cap, checked here for
    /// the SAME reason that file's own header gives: an over-cap `result` is refused WHOLE at the
    /// daemon, silently, past this app's own `try?`. `PanelDocumentTab.swift`'s
    /// `officeReadRangeMaxCells` already keeps an ordinary `read` far under this in practice (that
    /// file's own test measures it); this is the SECOND belt — the one that catches a real LOK answer
    /// this file did not anticipate (a formula longer than the "worst realistic case" the cap's own
    /// comment assumed, or a mechanism this task's own live drills found returns more than requested)
    /// — refusing rather than truncating, so a caller is told the truth rather than shown a silently
    /// clipped grid.
    private static let sheetsResultMaxLength = PanelCommandConsumer.resultMaxLength

    /// `office.sheets.info` — sheet names, each one's used range, and the active sheet.
    ///
    /// **`info` is ALSO the drivability probe** (spec §1/§3, mirroring `browser tabs`) — but the
    /// "app not running" half of that lives on the DAEMON side, not here: `sheets.ts`'s own reach
    /// check (mirroring `browser.ts`'s `panelReach`) refuses BEFORE ever dispatching a `panel_command`
    /// when no usable harness is attached, so this function only ever runs at all once the app IS
    /// known to be reachable. **The fence still has to win when BOTH would fire** — spec §5's "a probe
    /// outside the working dirs answers with the fence refusal, not the app-not-running one" is why
    /// `sheets.ts` checks its OWN fence BEFORE its reach check (see that file's own header): the
    /// daemon already knows the session's working directories without needing the app at all, so
    /// refusing an out-of-fence path never has to wait to learn whether the app is even running.
    private func handleSheetsInfo(_ command: SessionEvent.PanelCommand) async {
        guard let path = Self.requiredPath(command.args) else {
            return sendResult(command.sessionId, command.commandId, false,
                               Self.requiredPathRefusal, nil)
        }
        guard let broker = officeAgentBroker(command.sessionId) else {
            return sendResult(command.sessionId, command.commandId, false, Self.hostGoneRefusal, nil)
        }
        do {
            let resultText = try await broker.perform(
                sessionId: command.sessionId, path: path, access: .read, requestId: command.commandId
            ) { runtime, docId, adopted in
                let (sheets, activeSheet) = try await runtime.sheetsInfo(docId: docId)
                return Self.formatSheetsInfo(path: path, sheets: sheets, activeSheet: activeSheet)
            }
            let (ok, text) = Self.capped(resultText)
            sendResult(command.sessionId, command.commandId, ok, text, nil)
        } catch {
            sendResult(command.sessionId, command.commandId, false, Self.message(for: error), nil)
        }
    }

    /// `office.sheets.read` — a value or formula grid over one A1 range on one named sheet.
    ///
    /// **Operand validation — INCLUDING the range's own cell-count cap — runs entirely BEFORE the
    /// broker is ever reached**, deliberately: `officeParseRange`'s cap check
    /// (`officeReadRangeMaxCells`) is a pure function of the `range` string alone, so refusing an
    /// oversized range here costs nothing and, critically, never pays for a cold helper boot or an
    /// open/adopt round trip on a request that was always going to be refused. Skipping this and
    /// letting an oversized range reach the broker would trade a sub-second refusal for the exact
    /// silent-155s-timeout failure mode `officeReadRangeMaxCells`'s own header exists to prevent (an
    /// over-cap RESULT still gets refused at the wire, but only after doing all the work to produce
    /// one).
    private func handleSheetsRead(_ command: SessionEvent.PanelCommand) async {
        guard let path = Self.requiredPath(command.args) else {
            return sendResult(command.sessionId, command.commandId, false,
                               Self.requiredPathRefusal, nil)
        }
        guard let sheet = Self.requiredSheet(command.args) else {
            return sendResult(command.sessionId, command.commandId, false, Self.requiredSheetRefusal, nil)
        }
        guard let rangeText = Self.requiredRangeText(command.args) else {
            return sendResult(command.sessionId, command.commandId, false, Self.requiredRangeRefusal, nil)
        }
        guard let range = officeParseRange(rangeText) else {
            return sendResult(command.sessionId, command.commandId, false,
                               "\"\(Self.brief(rangeText))\" is not a valid A1 range — examples: "
                                   + "\"A1\", \"A1:C10\".", nil)
        }
        guard range.cellCount <= officeReadRangeMaxCells else {
            return sendResult(command.sessionId, command.commandId, false,
                               "\"\(rangeText)\" spans \(range.cellCount) cells, past the "
                                   + "\(officeReadRangeMaxCells)-cell limit on one read — ask for a "
                                   + "smaller range.", nil)
        }
        let formulas = Self.optionalFormulas(command.args)
        let rangeString = "\(officeCellReference(column: range.startColumn, row: range.startRow)):"
            + officeCellReference(column: range.endColumn, row: range.endRow)
        guard let broker = officeAgentBroker(command.sessionId) else {
            return sendResult(command.sessionId, command.commandId, false, Self.hostGoneRefusal, nil)
        }
        do {
            let resultText = try await broker.perform(
                sessionId: command.sessionId, path: path, access: .read, requestId: command.commandId
            ) { runtime, docId, adopted in
                let rows = try await runtime.sheetsRead(docId: docId, sheet: sheet, range: rangeString, formulas: formulas)
                return Self.formatSheetsRead(sheet: sheet, range: rangeString, formulas: formulas, rows: rows)
            }
            let (ok, text) = Self.capped(resultText)
            sendResult(command.sessionId, command.commandId, ok, text, nil)
        } catch {
            sendResult(command.sessionId, command.commandId, false, Self.message(for: error), nil)
        }
    }

    // MARK: - office-agent-tools T4: sheets write verbs

    /// `office.sheets.set` — a rectangular grid of values over one A1 range on one named sheet.
    ///
    /// **Every real A1/cell-count check runs BEFORE the broker is ever reached**, same discipline
    /// `handleSheetsRead` already established for its own cap: `values`' dimensions are computed and
    /// compared against `range`'s real dimensions here, and `officeWriteRangeMaxCells` is enforced
    /// here — both are real column math this file owns (never the daemon, never the helper — see
    /// `OfficeWireFrame.sheetsSet`'s own header for why the helper cannot do this arithmetic either).
    ///
    /// **No apostrophe-escaping happens here — the caller supplies one, in their OWN `values`
    /// string, exactly the way `sheets.ts`'s own tool description says**: a leading `=` becomes a
    /// formula; a caller who wants a LITERAL string starting with `=` types the apostrophe
    /// THEMSELVES (`"'=NOT A FORMULA"`), the identical convention a human uses typing into a real
    /// cell. A first draft of this function auto-inserted an apostrophe in front of EVERY `=`-
    /// prefixed cell regardless of the caller's own intent — caught live, by this exact drill: it
    /// made every formula impossible to write at all (`"=SUM(D1:D1)"` landed as the literal string
    /// `"=SUM(D1:D1)"`, never a real formula), directly contradicting the tool's own documented
    /// behaviour. `cellValues` is therefore the caller's grid, stringified, UNCHANGED — the helper
    /// (`LOKBridge.writeOneCellOnDedicatedThread`) is what decides, from the leading character
    /// alone, whether to type via real keystrokes (a genuine formula) or ext-text-input (everything
    /// else, apostrophe-escaped literal text included).
    private func handleSheetsSet(_ command: SessionEvent.PanelCommand) async {
        guard let path = Self.requiredPath(command.args) else {
            return sendResult(command.sessionId, command.commandId, false, Self.requiredPathRefusal, nil)
        }
        guard let sheet = Self.requiredSheet(command.args) else {
            return sendResult(command.sessionId, command.commandId, false, Self.requiredSheetRefusal, nil)
        }
        guard let rangeText = Self.requiredRangeText(command.args) else {
            return sendResult(command.sessionId, command.commandId, false, Self.requiredRangeRefusal, nil)
        }
        guard let range = officeParseRange(rangeText) else {
            return sendResult(command.sessionId, command.commandId, false,
                               "\"\(Self.brief(rangeText))\" is not a valid A1 range — examples: "
                                   + "\"A1\", \"A1:C10\".", nil)
        }
        guard range.cellCount <= officeWriteRangeMaxCells else {
            return sendResult(command.sessionId, command.commandId, false,
                               "\"\(rangeText)\" spans \(range.cellCount) cells, past the "
                                   + "\(officeWriteRangeMaxCells)-cell limit on one set call — write a "
                                   + "smaller grid, or split it across multiple calls.", nil)
        }
        guard let values = Self.requiredValuesGrid(command.args) else {
            return sendResult(command.sessionId, command.commandId, false, Self.requiredValuesRefusal, nil)
        }
        guard values.count == range.rowCount, values.allSatisfy({ $0.count == range.columnCount }) else {
            let actualWidth = values.first?.count ?? 0
            return sendResult(command.sessionId, command.commandId, false,
                               "`values` is \(values.count)×\(actualWidth) but range \"\(rangeText)\" is "
                                   + "\(range.rowCount)×\(range.columnCount) — they must match exactly.", nil)
        }

        var cellAddresses: [String] = []
        var cellValues: [String] = []
        cellAddresses.reserveCapacity(range.cellCount)
        cellValues.reserveCapacity(range.cellCount)
        for r in 0..<range.rowCount {
            for c in 0..<range.columnCount {
                cellAddresses.append(officeCellReference(column: range.startColumn + c, row: range.startRow + r))
                cellValues.append(values[r][c])
            }
        }
        let rangeString = "\(officeCellReference(column: range.startColumn, row: range.startRow)):"
            + officeCellReference(column: range.endColumn, row: range.endRow)

        guard let broker = officeAgentBroker(command.sessionId) else {
            return sendResult(command.sessionId, command.commandId, false, Self.hostGoneRefusal, nil)
        }
        do {
            let resultText = try await broker.perform(
                sessionId: command.sessionId, path: path, access: .write, requestId: command.commandId
            ) { runtime, docId, adopted in
                do {
                    let cellsWritten = try await runtime.sheetsSet(docId: docId, sheet: sheet, range: rangeString,
                                                                    cellAddresses: cellAddresses, cellValues: cellValues)
                    return Self.formatSheetsSet(path: path, sheet: sheet, range: rangeString, cellsWritten: cellsWritten)
                } catch {
                    // Second fix-round review (Important #2) — `set` is the ONE verb where an
                    // earlier, in-call cell can already have applied before a LATER cell's failure
                    // reaches here; only meaningful to disclose when this call ever had more than one
                    // cell to begin with (a single-cell call's own failure already means zero earlier
                    // cells, and the wrapped message says so). `adopted` decides which of the two real
                    // outcomes actually happened — see `OfficeAgentBroker.runOnce`'s own header for why
                    // this parameter exists at all: an adopted document is left dirty, wedging further
                    // writes (rule 3) until the human saves or discards; a document THIS call opened
                    // has those earlier cells DISCARDED, unsaved, when rule 2's own `defer` closes it.
                    // Never auto-saves the partial write to dodge this — a silent, unrequested partial
                    // save would be worse than a truthful refusal (coordinator review, explicit).
                    guard cellAddresses.count > 1 else { throw error }
                    let lifecycle = adopted
                        ? " If earlier cells in this call already applied before this failure, they "
                            + "are sitting unsaved in your own open tab right now — the tab is dirty, "
                            + "and Norma will refuse further writes to this document until you save "
                            + "or discard those changes yourself."
                        : " If earlier cells in this call already applied before this failure, they "
                            + "were discarded when Norma closed the document afterward — nothing from "
                            + "this call persisted, and the next call will start fresh."
                    throw OfficeAgentBrokerError.writeFailed(path: path, reason: Self.message(for: error) + lifecycle)
                }
            }
            let (ok, text) = Self.capped(resultText)
            sendResult(command.sessionId, command.commandId, ok, text, nil)
        } catch {
            sendResult(command.sessionId, command.commandId, false, Self.message(for: error), nil)
        }
    }

    /// `office.sheets.insert_rows`/`.insert_cols`/`.delete_rows`/`.delete_cols` — one handler for all
    /// four (`command.action` is what tells them apart; see `OfficeWireFrame.sheetsResize`'s own
    /// header for why the wire itself consolidates the same way).
    private func handleSheetsResize(_ command: SessionEvent.PanelCommand) async {
        guard let path = Self.requiredPath(command.args) else {
            return sendResult(command.sessionId, command.commandId, false, Self.requiredPathRefusal, nil)
        }
        guard let sheet = Self.requiredSheet(command.args) else {
            return sendResult(command.sessionId, command.commandId, false, Self.requiredSheetRefusal, nil)
        }
        guard let count = Self.requiredCount(command.args), count > 0 else {
            return sendResult(command.sessionId, command.commandId, false, Self.requiredCountRefusal, nil)
        }
        let dimension: OfficeSheetsResizeDimension
        let op: OfficeSheetsResizeOp
        switch command.action {
        case "office.sheets.insert_rows": dimension = .row; op = .insert
        case "office.sheets.insert_cols": dimension = .col; op = .insert
        case "office.sheets.delete_rows": dimension = .row; op = .delete
        case "office.sheets.delete_cols": dimension = .col; op = .delete
        default:
            // Unreachable — `handle`'s own switch routes only these four actions here — but this
            // file's own posture is "never crash on a wire value," so this still answers rather than
            // trapping.
            return sendResult(command.sessionId, command.commandId, false, Self.refusal(for: command.action), nil)
        }

        let selectionRange: String
        switch dimension {
        case .row:
            // Fix-round review (item 4) — `sheets.ts`'s own daemon-side validation
            // (`packages/core/src/agent/tools/sheets.ts`, the `rowVerbs` branch) accepts `at` as
            // EITHER a JSON number OR a digit-only JSON STRING for a row verb (`String(a.at)` against
            // `/^[1-9][0-9]*$/` — a check that passes identically whether `a.at` started as `3` or
            // `"3"`), so `at: "3"` is documented-legal and reaches this consumer verbatim. The
            // ORIGINAL code here accepted `.number` only, refusing a perfectly valid `"3"` outright —
            // a real gap between what the daemon promises and what the app actually honors.
            //
            // T5 fix round, Critical-1's sweep — BOTH arms are bounded by `officeResizeMaxAt` (see
            // `requiredCount`'s own header for the measured aborts): the `.number` arm because
            // `Int(1e30)` traps, the `.string` arm because `Int("9223372036854775807")` succeeds and
            // then overflows `startRow + count - 1` below.
            let atRow: Int?
            switch command.args?["at"] {
            case .number(let atNumber) where atNumber >= 1 && atNumber <= Double(Self.officeResizeMaxAt)
                && atNumber.truncatingRemainder(dividingBy: 1) == 0:
                atRow = Int(atNumber)
            case .string(let atString):
                atRow = Int(atString).flatMap { $0 >= 1 && $0 <= Self.officeResizeMaxAt ? $0 : nil }
            default:
                atRow = nil
            }
            guard let startRow = atRow else {
                return sendResult(command.sessionId, command.commandId, false,
                                   "`at` must be a positive 1-based row number, at most "
                                       + "\(Self.officeResizeMaxAt).", nil)
            }
            selectionRange = "\(startRow):\(startRow + count - 1)"
        case .col:
            guard case .string(let atLetters)? = command.args?["at"],
                  let startColumn = officeColumnIndex(fromLetters: atLetters) else {
                return sendResult(command.sessionId, command.commandId, false,
                                   "`at` must be column letters (e.g. \"C\").", nil)
            }
            selectionRange = "\(officeColumnLetters(startColumn)):\(officeColumnLetters(startColumn + count - 1))"
        }

        guard let broker = officeAgentBroker(command.sessionId) else {
            return sendResult(command.sessionId, command.commandId, false, Self.hostGoneRefusal, nil)
        }
        do {
            let resultText = try await broker.perform(
                sessionId: command.sessionId, path: path, access: .write, requestId: command.commandId
            ) { runtime, docId, adopted in
                let dims = try await runtime.sheetsResize(docId: docId, sheet: sheet, dimension: dimension,
                                                          op: op, selectionRange: selectionRange)
                return Self.formatSheetsResize(path: path, sheet: sheet, usedEndColumn: dims.usedEndColumn,
                                               usedEndRow: dims.usedEndRow)
            }
            let (ok, text) = Self.capped(resultText)
            sendResult(command.sessionId, command.commandId, ok, text, nil)
        } catch {
            sendResult(command.sessionId, command.commandId, false, Self.message(for: error), nil)
        }
    }

    /// `office.sheets.add_sheet`/`.delete_sheet`/`.rename_sheet` — one handler for all three, same
    /// consolidation reasoning as `handleSheetsResize` above.
    private func handleSheetsManageSheet(_ command: SessionEvent.PanelCommand) async {
        guard let path = Self.requiredPath(command.args) else {
            return sendResult(command.sessionId, command.commandId, false, Self.requiredPathRefusal, nil)
        }
        guard let name = Self.requiredName(command.args) else {
            return sendResult(command.sessionId, command.commandId, false, Self.requiredNameRefusal, nil)
        }
        let op: OfficeSheetsManageSheetOp
        var newName: String?
        switch command.action {
        case "office.sheets.add_sheet": op = .add
        case "office.sheets.delete_sheet": op = .delete
        case "office.sheets.rename_sheet":
            op = .rename
            guard let requestedNewName = Self.requiredNewName(command.args) else {
                return sendResult(command.sessionId, command.commandId, false, Self.requiredNewNameRefusal, nil)
            }
            newName = requestedNewName
        default:
            return sendResult(command.sessionId, command.commandId, false, Self.refusal(for: command.action), nil)
        }

        guard let broker = officeAgentBroker(command.sessionId) else {
            return sendResult(command.sessionId, command.commandId, false, Self.hostGoneRefusal, nil)
        }
        do {
            let resultText = try await broker.perform(
                sessionId: command.sessionId, path: path, access: .write, requestId: command.commandId
            ) { runtime, docId, adopted in
                let sheets = try await runtime.sheetsManageSheet(docId: docId, op: op, name: name, newName: newName)
                return Self.formatSheetsManageSheet(path: path, sheets: sheets)
            }
            let (ok, text) = Self.capped(resultText)
            sendResult(command.sessionId, command.commandId, ok, text, nil)
        } catch {
            sendResult(command.sessionId, command.commandId, false, Self.message(for: error), nil)
        }
    }

    /// `office.sheets.format` — `bold`/`italic`/`numberFormat`/`align`/`width` over one A1 `range` on
    /// one named sheet, every operand optional and independent (absent means "leave alone" — see
    /// `sheets.ts`'s own description and `OfficeWireFrame.sheetsFormat`'s own header for the full
    /// contract this rests on).
    ///
    /// **`width`'s own column-span selection is computed HERE, from the SAME already-parsed `range` —
    /// never re-derived by the helper.** `width` is a COLUMN property (task-5-brief.md's own words):
    /// it must widen every column `range` touches, in full, so its own selection is a Name-Box-style
    /// column span ("A:C"), built with the identical `officeColumnLetters` conversion
    /// `handleSheetsResize`'s own column verbs already use — never a second implementation.
    /// `columnSpan` is `nil` whenever `width` itself is `nil` (the wire's own paired-field guard —
    /// `OfficeWireFrame.sheetsFormat`'s decode refuses any OTHER combination).
    private func handleSheetsFormat(_ command: SessionEvent.PanelCommand) async {
        guard let path = Self.requiredPath(command.args) else {
            return sendResult(command.sessionId, command.commandId, false, Self.requiredPathRefusal, nil)
        }
        guard let sheet = Self.requiredSheet(command.args) else {
            return sendResult(command.sessionId, command.commandId, false, Self.requiredSheetRefusal, nil)
        }
        guard let rangeText = Self.requiredRangeText(command.args) else {
            return sendResult(command.sessionId, command.commandId, false, Self.requiredRangeRefusal, nil)
        }
        guard let range = officeParseRange(rangeText) else {
            return sendResult(command.sessionId, command.commandId, false,
                               "\"\(Self.brief(rangeText))\" is not a valid A1 range — examples: "
                                   + "\"A1\", \"A1:C10\".", nil)
        }
        // Mirrors `handleSheetsRead`'s own pre-broker cap check — `format` is single-dispatch over
        // the WHOLE selection, never per-cell (unlike `set`), so its cost shape matches `read`'s, not
        // `set`'s — this reuses `officeReadRangeMaxCells` rather than inventing a third number with
        // subtly different reasoning attached.
        guard range.cellCount <= officeReadRangeMaxCells else {
            return sendResult(command.sessionId, command.commandId, false,
                               "\"\(rangeText)\" spans \(range.cellCount) cells, past the "
                                   + "\(officeReadRangeMaxCells)-cell limit on one format call — ask for "
                                   + "a smaller range.", nil)
        }
        let bold = Self.optionalBool(command.args, "bold")
        let italic = Self.optionalBool(command.args, "italic")
        let numberFormat = Self.optionalNumberFormatPreset(command.args)
        let align = Self.optionalAlign(command.args)
        let width = Self.optionalWidth(command.args)
        // A PRESENT but out-of-range `width` gets its own refusal — `optionalWidth` collapses it to
        // `nil`, which the at-least-one guard below would otherwise report as "name an attribute."
        if case .number(let rawWidth)? = command.args?["width"], width == nil {
            return sendResult(command.sessionId, command.commandId, false,
                               "`width` must be between \(Int(Self.officeWidthMinPoints)) and "
                                   + "\(Int(Self.officeWidthMaxPoints)) points (got \(rawWidth)).", nil)
        }
        guard bold != nil || italic != nil || numberFormat != nil || align != nil || width != nil else {
            return sendResult(command.sessionId, command.commandId, false, Self.requiredFormatAttributeRefusal, nil)
        }
        // T5 fix-round review, Important-1 — the width phase's OWN cap, on COLUMNS, independent of
        // the cell-count cap above. `width` does not select `range`; it selects the WHOLE-COLUMN
        // Name-Box span `range`'s columns cover (`columnSpan` below), and that selection is realized
        // through `selectionTextOnDedicatedThread`, which serialises the entire selection to a UTF-8
        // string it then throws away — up to `goToCellVerificationAttempts` (4) times, plus the
        // sentinel park. The 2,000-CELL cap does not bound that at all: `range:"A1:BXW1"` is 2,000
        // cells and 2,000 ENTIRE COLUMNS, on the single dedicated LOK thread behind the one app-wide
        // helper FIFO whose supervisor has no kill on request timeout — a wedge that takes every
        // open document with it until the app restarts, for one mistyped range.
        //
        // 64 is chosen against the USE, not the machine: `width` exists so a report's columns fit
        // their content, and no human toolbar interaction — or agent imitating one — sets more than
        // a few dozen columns at once. Cell attributes keep the full 2,000-cell range; only the
        // width PHASE is bounded, which is the only phase whose cost is O(sheet), not O(range).
        if width != nil, range.columnCount > officeFormatWidthMaxColumns {
            return sendResult(command.sessionId, command.commandId, false,
                               "\"\(rangeText)\" spans \(range.columnCount) columns, past the "
                                   + "\(officeFormatWidthMaxColumns)-column limit on one `width` call — "
                                   + "`width` resizes every column the range touches IN FULL, so a wide "
                                   + "range is a much larger operation than its cell count suggests. "
                                   + "Widen fewer columns per call.", nil)
        }

        let rangeString = "\(officeCellReference(column: range.startColumn, row: range.startRow)):"
            + officeCellReference(column: range.endColumn, row: range.endRow)
        let columnSpan: String? = width != nil
            ? "\(officeColumnLetters(range.startColumn)):\(officeColumnLetters(range.endColumn))"
            : nil

        // Can a partial application actually happen on THIS call? Known entirely from this call's own
        // already-decoded operands — no error-parsing needed, the same simplification
        // `handleSheetsSet`'s own catch block already makes (it never asks LOKBridge's thrown message
        // "how many cells landed," it only asks itself "could anything plausibly have").
        //
        // **T5 fix-round review, Important-4 — this used to be `attributeCount > 1`, which was
        // over-broad, and the review was right.** Read `sheetsFormatOnDedicatedThread` structurally:
        // phase 1 does all of its throwing (sheet resolve, anchor parse, position verification)
        // BEFORE its first `postUnoCommand`, and there is no throwing statement anywhere between the
        // bold/italic/numberFormat/align dispatches. So `bold + italic` cannot half-apply — either
        // phase 1 threw before dispatching anything, or it dispatched all of them. The ONE seam where
        // an earlier attribute is already posted and a later one can still fail is phase 2's own
        // position verification, which runs after phase 1 has already dispatched. That makes the real
        // condition "at least one CELL attribute AND `width`," not "more than one attribute."
        //
        // Over-broad was not FALSE (the sentence is conditional) — but it is noise a model may act
        // on: telling it a document might be half-formatted after a `bold + italic` failure invites a
        // recovery step for a state that cannot exist.
        let cellAttributeNamed = bold != nil || italic != nil || numberFormat != nil || align != nil
        let partialApplicationPossible = cellAttributeNamed && width != nil

        guard let broker = officeAgentBroker(command.sessionId) else {
            return sendResult(command.sessionId, command.commandId, false, Self.hostGoneRefusal, nil)
        }
        do {
            let resultText = try await broker.perform(
                sessionId: command.sessionId, path: path, access: .write, requestId: command.commandId
            ) { runtime, docId, adopted in
                do {
                    let applied = try await runtime.sheetsFormat(
                        docId: docId, sheet: sheet, range: rangeString, columnSpan: columnSpan,
                        bold: bold, italic: italic, numberFormat: numberFormat, align: align, width: width)
                    return Self.formatSheetsFormat(path: path, sheet: sheet, range: rangeString, applied: applied)
                } catch {
                    // Same partial-application honesty `handleSheetsSet` already established (that
                    // function's own header): `format` dispatches its named attributes in SEQUENCE
                    // (cell attributes first, then — only if `width` was named — a SEPARATE
                    // column-span selection for it), and `OfficeAgentBroker.perform`'s own control
                    // flow throws BEFORE rule 4's save switch is ever reached — so a LATER attribute's
                    // failure does not undo whatever an EARLIER one in this SAME call already
                    // dispatched, and none of it is saved either way.
                    guard partialApplicationPossible else { throw error }
                    let lifecycle = adopted
                        ? " If an earlier attribute in this call already applied before this failure, "
                            + "it is sitting unsaved in your own open tab right now — the tab is dirty, "
                            + "and Norma will refuse further writes to this document until you save or "
                            + "discard those changes yourself."
                        : " If an earlier attribute in this call already applied before this failure, "
                            + "it was discarded when Norma closed the document afterward — nothing from "
                            + "this call persisted, and the next call will start fresh."
                    throw OfficeAgentBrokerError.writeFailed(path: path, reason: Self.message(for: error) + lifecycle)
                }
            }
            let (ok, text) = Self.capped(resultText)
            sendResult(command.sessionId, command.commandId, ok, text, nil)
        } catch {
            sendResult(command.sessionId, command.commandId, false, Self.message(for: error), nil)
        }
    }

    // MARK: - office-agent-tools T6: slides

    /// `office.slides.info` — slide count, and each slide's own name and title. NEVER a layout
    /// (fix round 1, review F-9: this comment used to say "layout when known" — stale since ruling
    /// 1, which removed layout from `info` entirely; `OfficeSlideInfo` carries no layout field and
    /// `formatSlidesInfo` never emits one, live-pinned by
    /// `OfficeSlidesCommandTests.swift`'s own assertion that `info`'s output never contains the
    /// word "layout" — only this comment had drifted, never the actual output).
    ///
    /// **`info` is ALSO the drivability probe** (spec §1/§3) — same split `handleSheetsInfo`'s own
    /// header already establishes: the "app not running" half lives on the daemon side
    /// (`slides.ts`'s own reach check), so this function only ever runs once the app IS known
    /// reachable.
    private func handleSlidesInfo(_ command: SessionEvent.PanelCommand) async {
        guard let path = Self.requiredPath(command.args) else {
            return sendResult(command.sessionId, command.commandId, false, Self.requiredPathRefusal, nil)
        }
        guard let broker = officeAgentBroker(command.sessionId) else {
            return sendResult(command.sessionId, command.commandId, false, Self.hostGoneRefusal, nil)
        }
        do {
            let resultText = try await broker.perform(
                sessionId: command.sessionId, path: path, access: .read, requestId: command.commandId
            ) { runtime, docId, adopted in
                let slides = try await runtime.slidesInfo(docId: docId)
                return Self.formatSlidesInfo(path: path, slides: slides)
            }
            let (ok, text) = Self.capped(resultText)
            sendResult(command.sessionId, command.commandId, ok, text, nil)
        } catch {
            sendResult(command.sessionId, command.commandId, false, Self.message(for: error), nil)
        }
    }

    /// `office.slides.read` — one slide's title and body placeholder text. `slide` arrives 1-based
    /// (`slides.ts`'s own operand — spec: "1-based, everywhere"); this function is the ONE place that
    /// converts to the wire's 0-based part index, mirroring how `handleSheetsRead`'s own `range`
    /// conversion happens app-side, never daemon-side.
    private func handleSlidesRead(_ command: SessionEvent.PanelCommand) async {
        guard let path = Self.requiredPath(command.args) else {
            return sendResult(command.sessionId, command.commandId, false, Self.requiredPathRefusal, nil)
        }
        guard let oneBasedSlide = Self.oneBasedIndex(command.args, "slide") else {
            return sendResult(command.sessionId, command.commandId, false, Self.requiredSlideRefusal, nil)
        }
        guard let broker = officeAgentBroker(command.sessionId) else {
            return sendResult(command.sessionId, command.commandId, false, Self.hostGoneRefusal, nil)
        }
        do {
            let resultText = try await broker.perform(
                sessionId: command.sessionId, path: path, access: .read, requestId: command.commandId
            ) { runtime, docId, adopted in
                let result = try await runtime.slidesRead(docId: docId, slide: oneBasedSlide - 1)
                return Self.formatSlidesRead(slide: oneBasedSlide, title: result.title, body: result.body)
            }
            let (ok, text) = Self.capped(resultText)
            sendResult(command.sessionId, command.commandId, ok, text, nil)
        } catch {
            sendResult(command.sessionId, command.commandId, false, Self.message(for: error), nil)
        }
    }

    /// `office.slides.set_text` — title and/or body onto one slide's own placeholder(s), each
    /// independently optional (absent means "leave alone" — `sheetsFormat`'s identical contract,
    /// re-checked HERE the same way `handleSheetsFormat` re-checks its own five attributes, not
    /// merely trusted from the daemon's own validation).
    private func handleSlidesSetText(_ command: SessionEvent.PanelCommand) async {
        guard let path = Self.requiredPath(command.args) else {
            return sendResult(command.sessionId, command.commandId, false, Self.requiredPathRefusal, nil)
        }
        guard let oneBasedSlide = Self.oneBasedIndex(command.args, "slide") else {
            return sendResult(command.sessionId, command.commandId, false, Self.requiredSlideRefusal, nil)
        }
        let title = Self.optionalString(command.args, "title")
        let body = Self.optionalString(command.args, "body")
        guard title != nil || body != nil else {
            return sendResult(command.sessionId, command.commandId, false, Self.requiredSetTextAttributeRefusal, nil)
        }
        // How many independent attributes this call named — mirrors `handleSheetsFormat`'s own
        // `attributeCount` exactly, one layer up: a partial failure is only structurally possible
        // when more than one attribute was in flight.
        let attributeCount = [title != nil, body != nil].filter { $0 }.count

        guard let broker = officeAgentBroker(command.sessionId) else {
            return sendResult(command.sessionId, command.commandId, false, Self.hostGoneRefusal, nil)
        }
        do {
            let resultText = try await broker.perform(
                sessionId: command.sessionId, path: path, access: .write, requestId: command.commandId
            ) { runtime, docId, adopted in
                do {
                    let applied = try await runtime.slidesSetText(docId: docId, slide: oneBasedSlide - 1, title: title, body: body)
                    return Self.formatSlidesSetText(path: path, slide: oneBasedSlide, applied: applied)
                } catch {
                    // Same partial-application honesty `handleSheetsSet`/`handleSheetsFormat` already
                    // established — see either's own header for the full adopted-vs-opened account.
                    guard attributeCount > 1 else { throw error }
                    let lifecycle = adopted
                        ? " If an earlier attribute in this call already applied before this failure, "
                            + "it is sitting unsaved in your own open tab right now — the tab is dirty, "
                            + "and Norma will refuse further writes to this document until you save or "
                            + "discard those changes yourself."
                        : " If an earlier attribute in this call already applied before this failure, "
                            + "it was discarded when Norma closed the document afterward — nothing from "
                            + "this call persisted, and the next call will start fresh."
                    throw OfficeAgentBrokerError.writeFailed(path: path, reason: Self.message(for: error) + lifecycle)
                }
            }
            let (ok, text) = Self.capped(resultText)
            sendResult(command.sessionId, command.commandId, ok, text, nil)
        } catch {
            sendResult(command.sessionId, command.commandId, false, Self.message(for: error), nil)
        }
    }

    /// `office.slides.add_slide`/`.delete_slide`/`.reorder` — one handler for all three, same
    /// consolidation reasoning as `handleSheetsResize`/`handleSheetsManageSheet`: `command.action` is
    /// what tells them apart, and the wire's own `slidesManagePage` frame already consolidates the
    /// three app<->helper calls into one pair (`OfficeWireFrame.slidesManagePage`'s own header has the
    /// per-op field contract this function builds).
    private func handleSlidesManagePage(_ command: SessionEvent.PanelCommand) async {
        guard let path = Self.requiredPath(command.args) else {
            return sendResult(command.sessionId, command.commandId, false, Self.requiredPathRefusal, nil)
        }
        let op: OfficeSlidesManagePageOp
        var slide: Int?
        var at: Int?
        var to: Int?
        switch command.action {
        case "office.slides.add_slide":
            op = .add
            at = Self.oneBasedIndex(command.args, "at").map { $0 - 1 }
        case "office.slides.delete_slide":
            op = .delete
            guard let oneBasedSlide = Self.oneBasedIndex(command.args, "slide") else {
                return sendResult(command.sessionId, command.commandId, false, Self.requiredSlideRefusal, nil)
            }
            slide = oneBasedSlide - 1
        case "office.slides.reorder":
            op = .reorder
            guard let oneBasedSlide = Self.oneBasedIndex(command.args, "slide") else {
                return sendResult(command.sessionId, command.commandId, false, Self.requiredSlideRefusal, nil)
            }
            guard let oneBasedTo = Self.oneBasedIndex(command.args, "to") else {
                return sendResult(command.sessionId, command.commandId, false, Self.requiredToRefusal, nil)
            }
            slide = oneBasedSlide - 1
            to = oneBasedTo - 1
        default:
            // Unreachable — `handle`'s own switch routes only these three actions here — but this
            // file's own posture is "never crash on a wire value," so this still answers.
            return sendResult(command.sessionId, command.commandId, false, Self.refusal(for: command.action), nil)
        }
        let layout = op == .add ? Self.optionalLayout(command.args) : nil

        guard let broker = officeAgentBroker(command.sessionId) else {
            return sendResult(command.sessionId, command.commandId, false, Self.hostGoneRefusal, nil)
        }
        do {
            let resultText = try await broker.perform(
                sessionId: command.sessionId, path: path, access: .write, requestId: command.commandId
            ) { runtime, docId, adopted in
                let slideCount = try await runtime.slidesManagePage(docId: docId, op: op, slide: slide, at: at,
                                                                     to: to, layout: layout)
                return Self.formatSlidesManagePage(path: path, slideCount: slideCount)
            }
            let (ok, text) = Self.capped(resultText)
            sendResult(command.sessionId, command.commandId, ok, text, nil)
        } catch {
            sendResult(command.sessionId, command.commandId, false, Self.message(for: error), nil)
        }
    }

    // MARK: - office-agent-tools T3: operands (wire strictness — missing required, never defaulted)

    private static let requiredPathRefusal = "this office verb needs a `path`."
    private static let requiredSheetRefusal = "`sheets read` needs a `sheet` naming which sheet to read."
    private static let requiredRangeRefusal = "`sheets read` needs a `range` in A1 notation (examples: \"A1\", \"A1:C10\")."
    private static let hostGoneRefusal = "Norma's office runtime is no longer available."
    // office-agent-tools T4
    private static let requiredValuesRefusal = "`sheets set` needs `values` — a rectangular grid of cell content."
    private static let requiredCountRefusal = "this office verb needs a positive `count`, at most "
        + "\(officeResizeMaxCount)."
    private static let requiredNameRefusal = "this office verb needs a `name`."
    private static let requiredNewNameRefusal = "`sheets rename_sheet` needs a `newName`."

    private static func requiredPath(_ args: [String: SessionEvent.JSONValue]?) -> String? {
        guard case .string(let raw)? = args?["path"], !raw.isEmpty else { return nil }
        return raw
    }
    private static func requiredSheet(_ args: [String: SessionEvent.JSONValue]?) -> String? {
        guard case .string(let raw)? = args?["sheet"], !raw.isEmpty else { return nil }
        return raw
    }
    private static func requiredRangeText(_ args: [String: SessionEvent.JSONValue]?) -> String? {
        guard case .string(let raw)? = args?["range"], !raw.isEmpty else { return nil }
        return raw
    }
    /// office-agent-tools T4 — `sheets set`'s own grid, decoded from the wire's generic `JSONValue`
    /// into plain strings: `sheets.ts`'s own zod schema already accepts string/number/boolean cells
    /// (never nested arrays/objects — those refuse at the daemon before this ever runs), so a cell
    /// that is not one of `.string`/`.number`/`.bool` here would only ever mean a decode mismatch
    /// between the two languages' own schemas, not real caller input — refused the same as any other
    /// malformed shape (`nil`), never coerced or skipped silently. `.number`'s own `Double` is
    /// formatted WITHOUT a trailing `.0` for a whole number (`42`, not `42.0`) — the form Calc's own
    /// cell-edit parser actually expects for an integer literal, matching what a human would type.
    private static func requiredValuesGrid(_ args: [String: SessionEvent.JSONValue]?) -> [[String]]? {
        guard case .array(let rows)? = args?["values"], !rows.isEmpty else { return nil }
        var grid: [[String]] = []
        grid.reserveCapacity(rows.count)
        for row in rows {
            guard case .array(let cells) = row, !cells.isEmpty else { return nil }
            var stringRow: [String] = []
            stringRow.reserveCapacity(cells.count)
            for cell in cells {
                switch cell {
                case .string(let s): stringRow.append(s)
                case .number(let n): stringRow.append(Self.formatNumberCell(n))
                case .bool(let b): stringRow.append(b ? "true" : "false")
                case .null, .object, .array: return nil
                }
            }
            grid.append(stringRow)
        }
        return grid
    }
    private static func formatNumberCell(_ value: Double) -> String {
        value.truncatingRemainder(dividingBy: 1) == 0 && abs(value) < 1e15
            ? String(Int64(value)) : String(value)
    }
    /// **T5 fix round, Critical-1's third and fourth doors** (swept out of the same class, not named
    /// by the review — see `task-5-fixround-report.md` §0). `Int(n)` on a `Double` TRAPS when `n` is
    /// outside `Int`'s range, and `sheets.ts` bounds `count`/`at` with nothing but
    /// `z.number().int().positive()` — which `1e30` satisfies (`Number.isInteger(1e30)` is `true`).
    /// So `sheets insert_rows at:1e30 count:1` aborted the app inside this one conversion, and
    /// `count: 9223372036854775807` aborted it one line later in `handleSheetsResize`'s own
    /// `startRow + count - 1`. Both measured as SIGTRAPs (`task-5-fixround-report.md` §2).
    ///
    /// `officeResizeMaxCount` is Calc's own row maximum: the largest number of rows — and far more
    /// than the largest number of columns — any real insert/delete could ever name, so this refuses
    /// nothing legitimate while making every `at + count` computation downstream total. Paired with
    /// `officeResizeMaxAt` (the same 9,999,999 ceiling `officeRowMaxDigits` already imposes on a
    /// parsed A1 row, so the two ways of naming a row agree).
    static let officeResizeMaxCount = 1_048_576
    static let officeResizeMaxAt = 9_999_999

    private static func requiredCount(_ args: [String: SessionEvent.JSONValue]?) -> Int? {
        guard case .number(let n)? = args?["count"], n >= 1, n <= Double(officeResizeMaxCount),
              n.truncatingRemainder(dividingBy: 1) == 0 else { return nil }
        return Int(n)
    }
    private static func requiredName(_ args: [String: SessionEvent.JSONValue]?) -> String? {
        guard case .string(let raw)? = args?["name"], !raw.isEmpty else { return nil }
        return raw
    }
    private static func requiredNewName(_ args: [String: SessionEvent.JSONValue]?) -> String? {
        guard case .string(let raw)? = args?["newName"], !raw.isEmpty else { return nil }
        return raw
    }
    /// `formulas` is the ONE genuinely optional operand (spec §2's table: `formulas?`) — a missing or
    /// wrong-typed value defaults to `false` (values), never refused; this is the single deliberate
    /// exception to "missing required operand is malformed, never defaulted" because this operand was
    /// never required in the first place.
    private static func optionalFormulas(_ args: [String: SessionEvent.JSONValue]?) -> Bool {
        guard case .bool(let value)? = args?["formulas"] else { return false }
        return value
    }
    private static let requiredFormatAttributeRefusal =
        "`sheets format` needs at least one of `bold`, `italic`, `numberFormat`, `align`, `width` — "
        + "an absent key means \"leave alone,\" so a call naming none of them would do nothing."

    // MARK: - office-agent-tools T6: slides' own operands

    private static let requiredSlideRefusal = "this office verb needs a `slide` (1-based)."
    private static let requiredToRefusal = "`slides reorder` needs a `to` (1-based)."
    private static let requiredSetTextAttributeRefusal =
        "`slides set_text` needs at least one of `title`, `body` — an absent key means \"leave "
        + "alone,\" so a call naming neither would do nothing."

    /// A positive, whole 1-based index — `slide`/`at`/`to`, all sharing this SAME shape (the daemon's
    /// own zod schema already enforces `.int().positive()`; this is the app's own independent check,
    /// mirroring `requiredCount`'s identical discipline for `sheets`' resize verbs — never trusting
    /// the daemon's validation as the only gate).
    private static func oneBasedIndex(_ args: [String: SessionEvent.JSONValue]?, _ key: String) -> Int? {
        guard case .number(let n)? = args?[key], n >= 1, n.truncatingRemainder(dividingBy: 1) == 0 else { return nil }
        return Int(n)
    }
    private static func optionalString(_ args: [String: SessionEvent.JSONValue]?, _ key: String) -> String? {
        guard case .string(let raw)? = args?[key] else { return nil }
        return raw
    }
    private static func optionalLayout(_ args: [String: SessionEvent.JSONValue]?) -> OfficeSlidesLayoutPreset? {
        guard case .string(let raw)? = args?["layout"] else { return nil }
        return OfficeSlidesLayoutPreset(rawValue: raw)
    }

    // MARK: - office-agent-tools T5: format's own operands — every one OPTIONAL, absent-means-untouched

    /// `bold`/`italic` — `Bool?`, genuinely three-valued (present-true / present-false / absent),
    /// unlike `optionalFormulas` above (which collapses "absent" and "wrong type" into the SAME
    /// default): a wrong-typed value here is a decode mismatch between the two languages' own
    /// schemas (the daemon's zod already refused a non-boolean before dispatch), not real caller
    /// intent — folding it into `nil` ("untouched") is safe for the SAME reason `sheetsManageSheet`'s
    /// own `newName` decode already treats "absent or wrong type" as `nil` rather than refusing.
    private static func optionalBool(_ args: [String: SessionEvent.JSONValue]?, _ key: String) -> Bool? {
        guard case .bool(let value)? = args?[key] else { return nil }
        return value
    }
    private static func optionalAlign(_ args: [String: SessionEvent.JSONValue]?) -> OfficeSheetsAlign? {
        guard case .string(let raw)? = args?["align"] else { return nil }
        return OfficeSheetsAlign(rawValue: raw)
    }
    /// `numberFormat` — see `OfficeWireFrame.sheetsFormat`'s own header for why this is a closed
    /// PRESET enum, not an arbitrary format-code string (a disclosed, source-grounded v1 narrowing).
    private static func optionalNumberFormatPreset(_ args: [String: SessionEvent.JSONValue]?) -> OfficeSheetsNumberFormatPreset? {
        guard case .string(let raw)? = args?["numberFormat"] else { return nil }
        return OfficeSheetsNumberFormatPreset(rawValue: raw)
    }
    /// `width` — points (see `sheets.ts`'s own doc for why points, not the engine's raw 1/100mm
    /// storage unit). `.number` on the wire decodes as `Double` regardless of whether the daemon sent
    /// a whole number or a fraction — no separate int/double handling needed here.
    /// **T5 fix round, Critical-1's sweep (§0) — the app validates its OWN operands.** `width` used
    /// to be passed through unbounded, straight into `LOKBridge.officeWidthMm100`'s
    /// `Int((points * 2540/72).rounded())` — the same trapping `Int(Double)` conversion
    /// `requiredCount` above documents. `sheets.ts` does bound this one (`.min(1).max(1000)`), so
    /// this was reachable only from a non-`sheets` producer of `panel_command`; guarded anyway,
    /// because "the daemon happens to bound it" is exactly the reasoning that left the other three
    /// doors open. The bounds MIRROR the daemon's deliberately — see `width`'s own schema doc in
    /// `sheets.ts` for why 1 point is the floor (below it the 1/100mm conversion rounds to an
    /// unrepresentable zero) and 1000 the ceiling.
    ///
    /// `nil` for a present-but-out-of-range value, which `handleSheetsFormat` distinguishes from
    /// absent so the model gets "1 to 1000 points", not the misleading "name at least one attribute".
    /// NaN/infinity fall out for free: neither comparison holds.
    static let officeWidthMinPoints = 1.0
    static let officeWidthMaxPoints = 1000.0

    private static func optionalWidth(_ args: [String: SessionEvent.JSONValue]?) -> Double? {
        guard case .number(let value)? = args?["width"],
              value >= officeWidthMinPoints, value <= officeWidthMaxPoints else { return nil }
        return value
    }

    // MARK: - office-agent-tools T3: result formatting (the "smallest useful truth", spec §3.5)

    private static func formatSheetsInfo(path: String, sheets: [OfficeSheetInfo], activeSheet: String) -> String {
        let name = (path as NSString).lastPathComponent
        var lines = ["\(sheets.count) sheet\(sheets.count == 1 ? "" : "s") in \(name) (active: \"\(activeSheet)\"):"]
        for sheet in sheets {
            let usedRange: String
            if sheet.usedEndColumn < 0 || sheet.usedEndRow < 0 {
                usedRange = "empty"
            } else {
                usedRange = "A1:\(officeCellReference(column: sheet.usedEndColumn, row: sheet.usedEndRow))"
            }
            let activeMark = sheet.name == activeSheet ? " (active)" : ""
            lines.append("- \"\(sheet.name)\"\(activeMark): \(usedRange)")
        }
        return lines.joined(separator: "\n")
    }

    /// A plain TSV grid — `rows[r][c]` joined by tabs, rows joined by newlines — the SAME shape LOK's
    /// own `getTextSelection` speaks (`LOKBridge.selectionTextOnDedicatedThread`'s own header), passed
    /// through rather than re-encoded: a model reading this sees exactly the rectangle it asked for,
    /// row-major, with no reshaping this file could get wrong. An empty `rows` (the sheet had nothing
    /// in the requested range) still gets an honest header line, never a bare empty string a caller
    /// could mistake for a dropped result.
    private static func formatSheetsRead(sheet: String, range: String, formulas: Bool, rows: [[String]]) -> String {
        let header = "\(sheet)!\(range) (\(formulas ? "formulas" : "values")):"
        guard !rows.isEmpty else { return "\(header) (nothing in this range)" }
        let grid = rows.map { row in row.map(quotedIfNeededForTSV).joined(separator: "\t") }.joined(separator: "\n")
        return "\(header)\n\(grid)"
    }

    /// office-agent-tools T3 review (I3) — the wire-side half of the fix.
    /// `LOKBridge.parseTSVGrid`'s own header has the live-characterized evidence: an in-cell tab
    /// substitutes back to a REAL tab character in each cell's own VALUE (safe there — it never
    /// existed as a real delimiter at split time). Re-joining cells with `"\t"` HERE, unquoted,
    /// would reintroduce the exact ambiguity that substitution just resolved — this cell's own tab
    /// would again be indistinguishable from the real column separator. RFC4180-style quoting
    /// (double the cell in `"..."`, doubling any literal `"` inside it) applies ONLY to a cell that
    /// actually needs it — the overwhelming common case (no embedded tab, no literal quote) is
    /// passed through byte-identical, so this changes nothing for any read this task's own live
    /// drills already prove correct.
    private static func quotedIfNeededForTSV(_ cell: String) -> String {
        guard cell.contains("\t") || cell.contains("\"") else { return cell }
        return "\"\(cell.replacingOccurrences(of: "\"", with: "\"\""))\""
    }

    // MARK: - office-agent-tools T4: write-verb result formatting

    private static func formatSheetsSet(path: String, sheet: String, range: String, cellsWritten: Int) -> String {
        let name = (path as NSString).lastPathComponent
        return "wrote \(cellsWritten) cell\(cellsWritten == 1 ? "" : "s") to \(sheet)!\(range) in \(name)"
    }

    private static func formatSheetsResize(path: String, sheet: String, usedEndColumn: Int, usedEndRow: Int) -> String {
        let name = (path as NSString).lastPathComponent
        let usedRange = (usedEndColumn < 0 || usedEndRow < 0)
            ? "empty" : "A1:\(officeCellReference(column: usedEndColumn, row: usedEndRow))"
        return "\(sheet) in \(name) is now \(usedRange)"
    }

    private static func formatSheetsManageSheet(path: String, sheets: [String]) -> String {
        let name = (path as NSString).lastPathComponent
        return "\(sheets.count) sheet\(sheets.count == 1 ? "" : "s") in \(name): \(sheets.joined(separator: ", "))"
    }

    private static func formatSheetsFormat(path: String, sheet: String, range: String, applied: [String]) -> String {
        let name = (path as NSString).lastPathComponent
        return "applied \(applied.joined(separator: ", ")) to \(sheet)!\(range) in \(name)"
    }

    // MARK: - office-agent-tools T6: slides result formatting

    /// Controller ruling 2 (slides-lok-research.md §7) — `name` and `title` are reported as two
    /// DISTINCT fields, never conflated: `name` is `getPartName`'s own answer, a POSITIONAL fallback
    /// ("Slide 3") for any slide that was never explicitly renamed, recomputed fresh after every
    /// reorder — not a title, and not stable identity. The leading `\(index + 1).` is what every verb
    /// actually addresses this slide BY (1-based) — `name` is informational only, never a target a
    /// verb accepts. Ruling 1 (research §3) — no `layout` field anywhere here: LOK gives no read-back
    /// for it, for any slide, ever.
    private static func formatSlidesInfo(path: String, slides: [OfficeSlideInfo]) -> String {
        let name = (path as NSString).lastPathComponent
        var lines = ["\(slides.count) slide\(slides.count == 1 ? "" : "s") in \(name) (target by number, "
                     + "never by name):"]
        for (index, slide) in slides.enumerated() {
            let titleText = slide.title.map { $0.isEmpty ? "(empty title placeholder)" : "\"\($0)\"" }
                ?? "(no title placeholder)"
            lines.append("\(index + 1). name: \"\(slide.name)\", title: \(titleText)")
        }
        return lines.joined(separator: "\n")
    }

    /// `slide` is 1-based (the caller's own operand, echoed back — never the wire's 0-based index).
    /// `nil` and `""` are reported differently — `describePlaceholder`'s own doc.
    private static func formatSlidesRead(slide: Int, title: String?, body: String?) -> String {
        "Slide \(slide):\ntitle: \(describePlaceholder(title))\nbody: \(describePlaceholder(body))"
    }

    /// `nil` — "this slide has no such placeholder at all" — is worded distinctly from `""` — "the
    /// placeholder exists and is empty" — the exact distinction `OfficeWireFrame.slidesReadOk`'s own
    /// header says is load-bearing (a model deciding whether `set_text` on this slide is even
    /// possible needs to tell the two apart, not see the same string for both).
    private static func describePlaceholder(_ text: String?) -> String {
        guard let text else { return "(no such placeholder on this slide)" }
        return text.isEmpty ? "(empty)" : text
    }

    private static func formatSlidesSetText(path: String, slide: Int, applied: [String]) -> String {
        let name = (path as NSString).lastPathComponent
        return "applied \(applied.joined(separator: ", ")) to slide \(slide) in \(name)"
    }

    private static func formatSlidesManagePage(path: String, slideCount: Int) -> String {
        let name = (path as NSString).lastPathComponent
        return "\(name) now has \(slideCount) slide\(slideCount == 1 ? "" : "s")"
    }

    /// The final belt — `sheetsResultMaxLength`, checked in the wire's own UTF-16-code-unit unit
    /// (`PanelURLPolicy.wireLength`, the same measure `PanelCommandConsumer`'s own cap uses), never
    /// `String.count`. Returns `ok: false` when it fires — an over-cap answer is a REFUSAL, never sent
    /// as `ok: true` with swapped-in prose (that would tell the daemon a successful read produced this
    /// sentence as its own real content). Refuses rather than truncates: a silently clipped grid would
    /// be indistinguishable from a complete one to whatever reads this file's own result text.
    private static func capped(_ text: String) -> (ok: Bool, text: String) {
        guard PanelURLPolicy.wireLength(text) > sheetsResultMaxLength else { return (true, text) }
        return (false, "this read's own result would be \(PanelURLPolicy.wireLength(text)) characters, past "
                + "the \(sheetsResultMaxLength)-character wire limit — ask for a smaller range or narrower columns.")
    }

    /// One error, one sentence — never `"\(error)"` verbatim when a cleaner extraction exists.
    /// `OfficeAgentBrokerError.message` is already the ready-to-show sentence (fence refusal, dirty
    /// tab, open/save failure, all pre-mapped house voice per that enum's own doc).
    /// `OfficeHelperClientError.serverError`'s `reason` is unwrapped rather than using that enum's own
    /// `.description` — the description prepends "office helper refused: ", which is accurate but is
    /// this app's OWN internal framing, not something a model needs to see; the bare reason (composed
    /// entirely by `LOKBridge`'s own `SaveError` — never raw LibreOffice text, that enum's own header)
    /// is the whole sentence on its own. Anything else (a genuinely unexpected error shape) falls back
    /// to `"\(error)"` — still answered, never silence, matching this file's whole standing rule.
    private static func message(for error: Error) -> String {
        if let brokerError = error as? OfficeAgentBrokerError { return brokerError.message }
        if let clientError = error as? OfficeHelperClientError {
            switch clientError {
            case .serverError(let reason): return reason
            case .openFailed(let reason): return reason
            case .saveFailed(let reason): return reason
            case .timedOut, .unexpectedReply: return clientError.description
            }
        }
        return "\(error)"
    }

    // MARK: - Wording (T1's own refusal — every OTHER office verb still uses this, unchanged)

    private static func refusal(for action: String) -> String {
        let quoted = brief(action)
        guard let (kind, verb) = parse(action) else {
            // Any string with the `office.` prefix that does not otherwise parse — still answered,
            // never dropped (this file's whole point).
            return "the Mac app does not yet implement the office verb `\(quoted)` — Norma's office "
                + "tools (sheets/slides/docs) are still being built. Nothing was done."
        }
        return "the `\(brief(kind))` tool's `\(brief(verb))` verb is not implemented yet on this "
            + "build of Norma — Stage C's office tools (sheets/slides/docs) are still being built. "
            + "Nothing was read from or written to the document."
    }

    /// `office.<kind>.<verb>` → `(kind, verb)`. `verb` is everything after the second dot, joined
    /// back with `.` if it somehow contained one — deliberately tolerant, since this is wording, not
    /// validation (`isOfficeAction`'s prefix check is the only gate that matters here).
    private static func parse(_ action: String) -> (kind: String, verb: String)? {
        let parts = action.split(separator: ".", maxSplits: 2)
        guard parts.count == 3, parts[0] == "office" else { return nil }
        return (String(parts[1]), String(parts[2]))
    }

    /// How much of an identifier a refusal may quote. Mirrors
    /// `PanelCommandConsumer.quotedIdentifierMaxLength` (120) — this file has no `answer()`
    /// last-resort cap to fall back on if it guessed wrong, so this bound is the ONLY thing standing
    /// between an absurd `action` string and an over-cap `result`. `action` decodes as a plain
    /// `String` with no length bound of its own (`SessionEvent.swift`), so a well-behaved daemon
    /// sending one of the 22 known verbs never comes close to this limit — it exists for the case
    /// where the daemon is not well-behaved, the same defensive posture
    /// `PanelCommandConsumer.handle`'s own `default:` branch takes on `command.action`.
    private static func brief(_ value: String, max limit: Int = 120) -> String {
        guard value.count > limit else { return value }
        return String(value.prefix(limit)) + "…"
    }
}
