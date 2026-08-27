import Foundation
import NormaProtocol

/// office-agent-tools T1/T3/T4/T5/T6 (task-1/3/4/5/6-brief.md; design
/// `docs/superpowers/specs/2026-08-22-office-agent-tools-design.md` §1, §2, §3, §6) — the office half
/// of the `panel_command` bridge B2 built for the browser tool (`PanelCommandConsumer.swift`'s own
/// header). T1 shipped this as a ROUTING SHELL where every verb answered a synchronous "not
/// implemented yet" refusal; T3 gave `sheets`' two READ verbs (`info`/`read`) real behaviour — the
/// FIRST verbs this file ever actually performed. T4/T5 gave `sheets`' whole write half (`set`,
/// resize, manage-sheet, `format`) the same; T6 gives every `slides` verb (`info`/`read`/`set_text`/
/// `add_slide`/`delete_slide`/`reorder`) the same; T7 closes the set with every `docs` verb
/// (`info`/`read`/`replace`/`insert`/`append`). **No office verb is on T1's refusal shell any more** —
/// `Self.refusal(for:)` now answers only an `office.`-prefixed action this file's switch does not
/// recognize at all, which the wire cannot produce today and which is answered rather than dropped
/// purely because this file never crashes on a wire value.
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
/// the wire ships 24 verbs today (`OFFICE_COMMAND_ACTIONS`, events.ts — 22 through Stage C, plus
/// office-finish's two `batch` verbs), and a later task that gives
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
        case "office.sheets.batch":
            Task { await handleSheetsBatch(command) }
        case "office.slides.batch":
            Task { await handleSlidesBatch(command) }
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
        case "office.docs.info":
            Task { await handleDocsInfo(command) }
        case "office.docs.read":
            Task { await handleDocsRead(command) }
        case "office.docs.replace":
            Task { await handleDocsReplace(command) }
        case "office.docs.insert", "office.docs.append":
            Task { await handleDocsInsert(command) }
        case "office.docs.format":
            Task { await handleDocsFormat(command) }
        case "office.slides.format":
            Task { await handleSlidesFormat(command) }
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
            // `OfficeAgentBroker.perform`'s closure can only hand back one `String`, and the warning
            // must survive `capped` separately from the body — so it comes out beside the result
            // rather than inside it. A reference box, not a sentinel inside the text: nothing then
            // has to guarantee the marker cannot occur in real cell content.
            let warningBox = SheetsReadWarning()
            let resultText = try await broker.perform(
                sessionId: command.sessionId, path: path, access: .read, requestId: command.commandId
            ) { runtime, docId, adopted in
                let read = try await runtime.sheetsRead(docId: docId, sheet: sheet, range: rangeString, formulas: formulas)
                let formatted = Self.formatSheetsRead(sheet: sheet, range: rangeString, formulas: formulas,
                                                      rows: read.rows,
                                                      displayRestoreVerified: read.displayRestoreVerified)
                warningBox.text = formatted.warning
                return formatted.body
            }
            // Cap the BODY, then re-attach the warning — never the other way round. `capped` replaces
            // its whole input with a refusal sentence when the grid is over the wire limit, so a
            // warning concatenated BEFORE this point is destroyed on exactly the path that needed it
            // most (office-polish blind check, Important). `reserving:` holds back room for the
            // warning so the composed result still lands inside the same wire limit the belt enforces.
            let warning = warningBox.text
            let (ok, cappedBody) = Self.capped(resultText, reserving: PanelURLPolicy.wireLength(warning))
            sendResult(command.sessionId, command.commandId, ok, cappedBody + warning, nil)
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

    // MARK: - office-finish Job 2: the two batch verbs

    /// `office.sheets.batch` — N of `add_sheet`/`delete_sheet`/`rename_sheet`, in order, in ONE call.
    ///
    /// **What this promises, and what it does not.**
    ///
    ///  * **One helper request, one save.** Every operation rides a single
    ///    `sheetsManageSheetBatch` wire request, and `OfficeAgentBroker` rule 4 saves ONCE after the
    ///    whole closure returns. That is what keeps the batch inside the daemon's existing write
    ///    deadline (`office-commands.ts` §A item 4 states the obligation outright), and it is also
    ///    what makes the recovery story simple: **on disk the batch is all-or-nothing.**
    ///  * **A partial batch NEVER saves.** If operation k fails, this throws — before rule 4's save
    ///    is ever reached — so the file on disk still holds its pre-call bytes. What happens to the
    ///    operations that DID apply is decided by `adopted`, exactly as it is for a partly-failed
    ///    `sheets set`: an adopted document is left dirty with changes the human never asked for and
    ///    refuses every later agent write until they resolve it; a document this call opened itself
    ///    is closed and its changes discarded. **This never saves the partial batch to dodge that** —
    ///    the ruling `handleSheetsSet` records ("a silent, unrequested partial save would be worse
    ///    than a truthful refusal") was made about cells and nothing about a batch changes it.
    ///  * **The refusal carries a per-operation ledger** (`formatBatchLedger`) so the model can act
    ///    on it without bisecting at one deadline per probe.
    ///  * **Verification is per operation, by re-read** — inherited, not re-implemented:
    ///    `LOKBridge.sheetsManageSheetBatch` calls the same `sheetsManageSheetOnDedicatedThread` the
    ///    single verb does, and "applied" in the ledger means that function's own before/after
    ///    sheet-list check passed. The engine lies (a delete swallows its own UNO exceptions), which
    ///    is why a dispatch's return value is not what any of this rests on.
    private func handleSheetsBatch(_ command: SessionEvent.PanelCommand) async {
        guard let path = Self.requiredPath(command.args) else {
            return sendResult(command.sessionId, command.commandId, false, Self.requiredPathRefusal, nil)
        }
        let ops: [OfficeSheetsManageSheetOperation]
        switch Self.decodeSheetsOps(command.args) {
        case .ok(let decoded): ops = decoded
        case .refuse(let refusal):
            return sendResult(command.sessionId, command.commandId, false, refusal, nil)
        }
        guard let broker = officeAgentBroker(command.sessionId) else {
            return sendResult(command.sessionId, command.commandId, false, Self.hostGoneRefusal, nil)
        }
        do {
            let resultText = try await broker.perform(
                sessionId: command.sessionId, path: path, access: .write, requestId: command.commandId
            ) { runtime, docId, adopted in
                let outcome = try await runtime.sheetsManageSheetBatch(docId: docId, ops: ops)
                let postState = Self.formatSheetsManageSheet(path: path, sheets: outcome.sheets)
                if let failure = outcome.failure {
                    throw OfficeBatchPartialFailure(message: Self.formatBatchLedger(
                        verb: "sheets batch", path: path, total: ops.count, applied: outcome.applied,
                        failure: failure, adopted: adopted, postState: postState))
                }
                return "applied \(ops.count) operation\(ops.count == 1 ? "" : "s") to \(path) — \(postState)"
            }
            let (ok, text) = Self.capped(resultText)
            sendResult(command.sessionId, command.commandId, ok, text, nil)
        } catch {
            sendResult(command.sessionId, command.commandId, false, Self.message(for: error), nil)
        }
    }

    /// `office.slides.batch` — N of `add_slide`/`delete_slide`/`reorder`, in order, in ONE call.
    /// Identical contract to `handleSheetsBatch` above; read that one's header, it is the same
    /// promise with a slide count in place of a sheet list.
    private func handleSlidesBatch(_ command: SessionEvent.PanelCommand) async {
        guard let path = Self.requiredPath(command.args) else {
            return sendResult(command.sessionId, command.commandId, false, Self.requiredPathRefusal, nil)
        }
        let ops: [OfficeSlidesManagePageOperation]
        switch Self.decodeSlidesOps(command.args) {
        case .ok(let decoded): ops = decoded
        case .refuse(let refusal):
            return sendResult(command.sessionId, command.commandId, false, refusal, nil)
        }
        guard let broker = officeAgentBroker(command.sessionId) else {
            return sendResult(command.sessionId, command.commandId, false, Self.hostGoneRefusal, nil)
        }
        do {
            let resultText = try await broker.perform(
                sessionId: command.sessionId, path: path, access: .write, requestId: command.commandId
            ) { runtime, docId, adopted in
                let outcome = try await runtime.slidesManagePageBatch(docId: docId, ops: ops)
                let postState = Self.formatSlidesManagePage(path: path, slideCount: outcome.slideCount)
                if let failure = outcome.failure {
                    throw OfficeBatchPartialFailure(message: Self.formatBatchLedger(
                        verb: "slides batch", path: path, total: ops.count, applied: outcome.applied,
                        failure: failure, adopted: adopted, postState: postState))
                }
                return "applied \(ops.count) operation\(ops.count == 1 ? "" : "s") to \(path) — \(postState)"
            }
            let (ok, text) = Self.capped(resultText)
            sendResult(command.sessionId, command.commandId, ok, text, nil)
        } catch {
            sendResult(command.sessionId, command.commandId, false, Self.message(for: error), nil)
        }
    }

    /// office-finish Job 2 — the per-operation ledger a partially-applied batch reports.
    ///
    /// It is three sentences rather than a per-operation array, because the execution model IS a
    /// strict prefix: operations run in order and stop at the first failure, so `applied` alone
    /// determines the state of all N. Saying it as a count also keeps the whole ledger a few hundred
    /// bytes whatever N is — an over-cap result (`sheetsResultMaxLength`, 64 KiB) is refused whole
    /// and the model gets SILENCE until the deadline instead of an error, so a ledger that could grow
    /// with N was never an option.
    ///
    /// The lifecycle sentence is gated on `total > 1` for the same reason `handleSheetsSet` gates its
    /// own on `cellAddresses.count > 1`: on a single-operation batch there is no applied prefix to
    /// describe, and describing one anyway would be a claim with nothing behind it.
    private static func formatBatchLedger(verb: String, path: String, total: Int, applied: Int,
                                          failure: String, adopted: Bool, postState: String) -> String {
        let failedIndex = applied + 1
        var lines: [String] = ["\(verb) stopped at operation \(failedIndex) of \(total): \(failure)"]

        // The prefix, spelled so every operation of the batch is accounted for and none is described
        // by a range that does not exist (there is no "operations 1-0", and no "not attempted" tail
        // when the LAST operation is the one that failed).
        var ledger = applied == 0
            ? "No operation applied; operation 1 failed"
            : (applied == 1
               ? "Operation 1 applied and was verified; operation 2 failed"
               : "Operations 1-\(applied) applied and were verified; operation \(failedIndex) failed")
        if failedIndex < total {
            ledger += failedIndex + 1 == total
                ? "; operation \(total) was not attempted."
                : "; operations \(failedIndex + 1)-\(total) were not attempted."
        } else {
            ledger += "."
        }
        lines.append(ledger)

        lines.append("NOTHING WAS SAVED — \(path) still holds its previous contents on disk. "
                     + (adopted
                        ? "This document was already open in the human's own tab, so that tab is now dirty with "
                          + "the operations that did apply, and every later write to it will be refused until the "
                          + "human saves or discards it. Re-reading and retrying cannot clear that; only they can."
                        : "This call opened the document itself, so the operations that applied were discarded "
                          + "when it closed and the next call starts from the file's saved contents."))
        lines.append("After the operations that applied: \(postState)")
        if total > 1 {
            lines.append("These operations are position-based, so do not re-send the whole batch: re-read the "
                         + "document first and send only what is still missing.")
        }
        return lines.joined(separator: " ")
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
        // **Whole-branch review F3 — the last two operands that never got the `isPresent` treatment
        // `at`/`layout`/`width` already have.** Both decode through a CLOSED enum's `init(rawValue:)`,
        // so a present-but-undecodable value — `align: "centre"`, `numberFormat: "pct"`, or either
        // one sent as a number/bool/array — collapsed to `nil`, which is indistinguishable from
        // "absent". Paired with any other attribute the at-least-one guard below was satisfied, so
        // `bold: true, align: "centre"` SUCCEEDED, reported `applied bold`, and dropped the
        // alignment silently: the model asked for something, was told it worked, and it did not
        // happen. Third ruling on this exact shape in this arc; same remedy, so all five of
        // `format`'s optional operands now answer a wrong value the same way.
        //
        // Checked for BOTH keys before any of them is read, so the refusal names the operand the
        // caller actually got wrong rather than whichever one happens to be decoded first.
        for key in ["align", "numberFormat"] where Self.isPresent(command.args, key) {
            let decoded: Bool = key == "align"
                ? Self.optionalAlign(command.args) != nil
                : Self.optionalNumberFormatPreset(command.args) != nil
            guard decoded else {
                return sendResult(command.sessionId, command.commandId, false,
                                   key == "align" ? Self.invalidAlignRefusal : Self.invalidNumberFormatRefusal, nil)
            }
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
        // the cell-count cap above, because the width phase selects whole columns rather than
        // `range`. See `officeFormatWidthMaxColumns`' own header for the LIVE MEASUREMENT behind the
        // number — including the part that falsifies the finding's stated severity: the whole-column
        // selection is bounded by the used data area, not the grid, so nothing here wedges. The cap
        // bounds an operand and catches an obvious model error early; it is not a wedge guard.
        // Cell attributes keep the full 2,000-cell range; only the width PHASE is bounded.
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
        // Round-2 re-review — the same present-but-undecodable close as `at`/`layout`. These two
        // DO disclose a survivor (`formatSlidesSetText` names which fields applied), so a wrong-typed
        // `title` was never fully silent; refused anyway, so all six slides operands answer a wrong
        // type the same way rather than three different ways.
        for key in ["title", "body"] where Self.isPresent(command.args, key)
            && Self.optionalString(command.args, key) == nil {
            return sendResult(command.sessionId, command.commandId, false,
                               "`slides set_text`'s `\(key)` must be a string.", nil)
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
            // `at` is the ONE genuinely optional index on this verb (absent = append at the end), so
            // a `nil` from `oneBasedIndex` is ambiguous here in a way it is nowhere else. **Caught
            // by this fix's own test, not reasoned about afterwards:** with the round-2 ceiling and
            // without this guard, `at:1e30` stopped aborting the app and started SILENTLY APPENDING
            // — the model asked for a specific position, got a different one, and was told it
            // succeeded, which is a worse failure than the crash it replaced. Same remedy, and the
            // same reasoning, as `handleSheetsFormat`'s present-but-out-of-range `width` refusal.
            //
            // Round-2 re-review: `isPresent`, not `if case .number?` — the original closed only the
            // numeric arm, so `at:"3"` walked past it into "absent" and appended silently. See
            // `isPresent`'s own header.
            if Self.isPresent(command.args, "at"), Self.oneBasedIndex(command.args, "at") == nil {
                return sendResult(command.sessionId, command.commandId, false, Self.requiredAtRefusal, nil)
            }
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
        // `layout` is the OTHER fully-silent operand on this verb (round-2 re-review): the success
        // text `formatSlidesManagePage` produces names no layout, so a misspelled or wrong-typed
        // one would silently give the model Impress's default slide and report success. Refused
        // instead — same shape as `at` above.
        let layout: OfficeSlidesLayoutPreset?
        if op == .add {
            if Self.isPresent(command.args, "layout"), Self.optionalLayout(command.args) == nil {
                return sendResult(command.sessionId, command.commandId, false, Self.invalidLayoutRefusal, nil)
            }
            layout = Self.optionalLayout(command.args)
        } else {
            layout = nil
        }

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

    // MARK: - office-agent-tools T7: docs

    /// `office.docs.info` — page, paragraph and character counts.
    ///
    /// **`info` is ALSO the drivability probe** (spec §1/§3) — same split `handleSheetsInfo`'s own
    /// header establishes: the "app not running" half lives on the daemon side (`docs.ts`'s own reach
    /// check), so this only ever runs once the app IS known reachable.
    private func handleDocsInfo(_ command: SessionEvent.PanelCommand) async {
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
                let info = try await runtime.docsInfo(docId: docId)
                return Self.formatDocsInfo(path: path, pages: info.pages, paragraphs: info.paragraphs,
                                           characters: info.characters)
            }
            let (ok, text) = Self.capped(resultText)
            sendResult(command.sessionId, command.commandId, ok, text, nil)
        } catch {
            sendResult(command.sessionId, command.commandId, false, Self.message(for: error), nil)
        }
    }

    /// `office.docs.read` — the whole body text, or a 1-based paragraph slice of it.
    ///
    /// **The slice is taken HERE, over the text the helper returned — it is not a range the engine
    /// was asked for, and the description says so.** LOK exposes no character- or paragraph-indexed
    /// addressing for Writer at all (`docs-lok-research.md` §3.5: `setTextSelection` takes twips, and
    /// there is no paragraph-indexed door), so a "paragraph range" can only be an honest slice of the
    /// SAME `\n`-separated text `read` returns and `info` counts. That self-consistency is the
    /// property that matters: the model sees one document, not two disagreeing measurements.
    ///
    /// `fromParagraph` past the end refuses rather than returning an empty result — an empty answer
    /// is indistinguishable from an empty document, and a model asking for paragraph 40 of a 3-
    /// paragraph document has made an error worth naming. `toParagraph` past the end CLAMPS, because
    /// "give me paragraphs 2 to 100" of a 5-paragraph document is a perfectly ordinary way to say
    /// "from 2 to the end."
    private func handleDocsRead(_ command: SessionEvent.PanelCommand) async {
        guard let path = Self.requiredPath(command.args) else {
            return sendResult(command.sessionId, command.commandId, false, Self.requiredPathRefusal, nil)
        }
        // Present-but-undecodable refuses, on EVERY type arm — the `isPresent` shape T5's round 3
        // landed. Without it, `fromParagraph: "2"` (a string, or a bool, or an out-of-range number)
        // would decode to `nil`, be treated as "absent", and silently return the WHOLE document while
        // reporting success — the model asked for a slice, got everything, and was told it worked.
        // That is the exact silent-wrong-answer class this arc has now shipped twice.
        for key in ["fromParagraph", "toParagraph"] where Self.isPresent(command.args, key)
            && Self.paragraphIndex(command.args, key) == nil {
            return sendResult(command.sessionId, command.commandId, false, Self.paragraphIndexRefusal(key), nil)
        }
        let fromParagraph = Self.paragraphIndex(command.args, "fromParagraph")
        let toParagraph = Self.paragraphIndex(command.args, "toParagraph")
        if let fromParagraph, let toParagraph, fromParagraph > toParagraph {
            return sendResult(command.sessionId, command.commandId, false,
                               "`fromParagraph` (\(fromParagraph)) is after `toParagraph` (\(toParagraph)) — "
                                   + "they are 1-based and inclusive, so `from` must be at most `to`.", nil)
        }
        guard let broker = officeAgentBroker(command.sessionId) else {
            return sendResult(command.sessionId, command.commandId, false, Self.hostGoneRefusal, nil)
        }
        do {
            let resultText = try await broker.perform(
                sessionId: command.sessionId, path: path, access: .read, requestId: command.commandId
            ) { runtime, docId, adopted in
                let text = try await runtime.docsRead(docId: docId)
                let paragraphs = Self.docsParagraphs(text)
                if let fromParagraph, fromParagraph > paragraphs.count {
                    throw OfficeAgentBrokerError.writeFailed(
                        path: path,
                        reason: "there is no paragraph \(fromParagraph) in this document — it has "
                            + "\(paragraphs.count) paragraph\(paragraphs.count == 1 ? "" : "s").")
                }
                let lower = (fromParagraph ?? 1) - 1
                let upper = min(toParagraph ?? paragraphs.count, paragraphs.count)
                let slice = Array(paragraphs[lower..<max(lower, upper)])
                // **The cap is OURS and it is DISCLOSED in the agent-visible result** (T3's I4
                // lesson, and `docs-lok-research.md` §3.6: `doc_getTextSelection` applies no length
                // cap of its own, so we cannot ask LOK for less — the cap can only be applied after
                // the read). Refused, never truncated: a silently clipped document body is
                // indistinguishable from a complete one to whatever reads it, and a model that
                // summarises a clipped document reports a conclusion about text it never saw.
                // Sits BELOW `capped()`'s own 64 KiB wire belt on purpose, so a `read` that is too
                // big gets an answer naming the operands that fix it rather than the wire's own
                // range-flavoured sentence.
                let sliceLength = slice.reduce(0) { $0 + $1.count + 1 }
                guard sliceLength <= Self.officeDocsReadMaxCharacters else {
                    throw OfficeAgentBrokerError.writeFailed(
                        path: path,
                        reason: "that would return \(sliceLength) characters, past the "
                            + "\(Self.officeDocsReadMaxCharacters)-character limit on one `docs read` — "
                            + "this document has \(paragraphs.count) paragraphs; ask for a range of them "
                            + "with `fromParagraph`/`toParagraph`.")
                }
                return Self.formatDocsRead(path: path, paragraphs: slice, firstParagraph: lower + 1,
                                           totalParagraphs: paragraphs.count,
                                           sliced: fromParagraph != nil || toParagraph != nil)
            }
            let (ok, text) = Self.capped(resultText)
            sendResult(command.sessionId, command.commandId, ok, text, nil)
        } catch {
            sendResult(command.sessionId, command.commandId, false, Self.message(for: error), nil)
        }
    }

    /// `office.docs.replace` — every literal, case-sensitive occurrence of `find`.
    ///
    /// **`all` is decoded and REFUSED when false, never silently ignored.** `panel_command.args` is
    /// `z.record(z.string(), z.unknown())` with only a byte cap, so an `all` this file did not look
    /// at would simply be dropped and the model would get a replace-everything it did not ask for,
    /// reported as success. The engine reason is real and not ours to paper over:
    /// `SvxSearchCmd::REPLACE` (2) is the UI Replace BUTTON — replace the current selection if it
    /// matches, then find the next (`sw/source/uibase/uiview/viewsrch.cxx:321-358`), and with no
    /// selection it replaces AT THE CURSOR — not "replace the first occurrence." v1 refuses rather
    /// than approximating it with a stateful, order-dependent command whose mistake lands in the
    /// user's saved file.
    private func handleDocsReplace(_ command: SessionEvent.PanelCommand) async {
        guard let path = Self.requiredPath(command.args) else {
            return sendResult(command.sessionId, command.commandId, false, Self.requiredPathRefusal, nil)
        }
        guard let find = Self.optionalString(command.args, "find"), !find.isEmpty else {
            return sendResult(command.sessionId, command.commandId, false, Self.requiredFindRefusal, nil)
        }
        guard find.rangeOfCharacter(from: Self.docsLineBreaks) == nil else {
            return sendResult(command.sessionId, command.commandId, false, Self.multilineFindRefusal, nil)
        }
        // `replaceWith` may legitimately be EMPTY (delete every occurrence) — but it must be present
        // and a string, because absent-means-nothing would silently become "delete", which is a very
        // different edit from the one a model that forgot the operand intended.
        guard let replaceWith = Self.optionalString(command.args, "replaceWith") else {
            return sendResult(command.sessionId, command.commandId, false, Self.requiredReplaceWithRefusal, nil)
        }
        guard replaceWith.rangeOfCharacter(from: Self.docsLineBreaks) == nil else {
            return sendResult(command.sessionId, command.commandId, false, Self.multilineReplaceWithRefusal, nil)
        }
        if Self.isPresent(command.args, "all") {
            guard case .bool(let all)? = command.args?["all"] else {
                return sendResult(command.sessionId, command.commandId, false, Self.allOperandRefusal, nil)
            }
            guard all else {
                return sendResult(command.sessionId, command.commandId, false, Self.allFalseRefusal, nil)
            }
        }
        guard let broker = officeAgentBroker(command.sessionId) else {
            return sendResult(command.sessionId, command.commandId, false, Self.hostGoneRefusal, nil)
        }
        do {
            let resultText = try await broker.perform(
                sessionId: command.sessionId, path: path, access: .write, requestId: command.commandId
            ) { runtime, docId, adopted in
                let replaced = try await runtime.docsReplace(docId: docId, find: find, replaceWith: replaceWith)
                return Self.formatDocsReplace(path: path, find: find, replaced: replaced)
            }
            let (ok, text) = Self.capped(resultText)
            sendResult(command.sessionId, command.commandId, ok, text, nil)
        } catch {
            sendResult(command.sessionId, command.commandId, false, Self.message(for: error), nil)
        }
    }

    /// `office.docs.insert` / `office.docs.append` — one handler for both, same consolidation
    /// reasoning `handleSheetsResize`/`handleSlidesManagePage` use: `command.action` is what tells
    /// them apart.
    ///
    /// `insert` puts EXACTLY `text` at `at` ("start"/"end", default "end") and nothing else;
    /// `append` always starts a new paragraph first. Two verbs rather than one flag because that is
    /// the distinction a caller actually has ("add a paragraph" vs "put this exactly here"), and
    /// because the spec's own table names both.
    private func handleDocsInsert(_ command: SessionEvent.PanelCommand) async {
        guard let path = Self.requiredPath(command.args) else {
            return sendResult(command.sessionId, command.commandId, false, Self.requiredPathRefusal, nil)
        }
        guard let text = Self.optionalString(command.args, "text"), !text.isEmpty else {
            return sendResult(command.sessionId, command.commandId, false, Self.requiredTextRefusal, nil)
        }
        let isAppend = command.action == "office.docs.append"
        var atStart = false
        if !isAppend {
            // Same present-but-undecodable close as `read`'s paragraph indices: without it,
            // `at: "beginning"` (or a number, or a bool) would fall through to the "end" default and
            // the text would land at the opposite end of the document from the one asked for, with
            // `ok: true`.
            if Self.isPresent(command.args, "at") {
                guard case .string(let raw)? = command.args?["at"], let position = OfficeDocsInsertAt(rawValue: raw) else {
                    return sendResult(command.sessionId, command.commandId, false, Self.invalidAtRefusal, nil)
                }
                atStart = position == .start
            }
        }
        guard let broker = officeAgentBroker(command.sessionId) else {
            return sendResult(command.sessionId, command.commandId, false, Self.hostGoneRefusal, nil)
        }
        do {
            let resultText = try await broker.perform(
                sessionId: command.sessionId, path: path, access: .write, requestId: command.commandId
            ) { runtime, docId, adopted in
                let paragraphs = try await runtime.docsInsert(docId: docId, text: text, atStart: atStart,
                                                               asNewParagraph: isAppend)
                return Self.formatDocsInsert(path: path, isAppend: isAppend, atStart: atStart,
                                             paragraphs: paragraphs)
            }
            let (ok, text) = Self.capped(resultText)
            sendResult(command.sessionId, command.commandId, ok, text, nil)
        } catch {
            sendResult(command.sessionId, command.commandId, false, Self.message(for: error), nil)
        }
    }

    // MARK: - office-agent-tools T7: docs' own operands

    /// `insert`'s `at` — a closed two-value enum, not a free-form position string. Anything finer
    /// than "start"/"end" would be promising an addressing scheme LOK does not have
    /// (`docs-lok-research.md` §3.5/§6.4: the only argument-less, non-async, dialog-free positioning
    /// commands Writer exposes are `.uno:GoToStartOfDoc` and `.uno:GoToEndOfDoc`).
    enum OfficeDocsInsertAt: String {
        case start
        case end
    }

    private static let requiredFindRefusal = "`docs replace` needs a non-empty `find` — the literal "
        + "text to search for."
    private static let requiredReplaceWithRefusal = "`docs replace` needs a `replaceWith` string — "
        + "pass \"\" explicitly to delete every occurrence."
    private static let requiredTextRefusal = "this office verb needs a non-empty `text` to insert."
    private static let invalidAtRefusal = "`docs insert`'s `at` must be \"start\" or \"end\" — omit it "
        + "entirely to insert at the end."
    private static let allOperandRefusal = "`docs replace`'s `all` must be a boolean."
    private static let allFalseRefusal =
        "`docs replace` cannot replace only the first occurrence — it replaces every one, or nothing. "
        + "The office engine has no \"replace the first match\" operation: its Replace command "
        + "replaces whatever is currently selected and then moves on, which depends on where the "
        + "cursor happens to be. Re-run without `all`, or make `find` specific enough to match only "
        + "the occurrence you mean."
    private static let multilineFindRefusal =
        "`docs replace`'s `find` cannot contain a line break — the engine's search never matches "
        + "across a paragraph boundary, so a multi-line search would silently find nothing. Replace "
        + "one paragraph's worth of text at a time."
    private static let multilineReplaceWithRefusal =
        "`docs replace`'s `replaceWith` cannot contain a line break — the engine inserts it as "
        + "literal characters, not as a new paragraph. Use `append` (or `insert`) to add paragraphs."

    private static let docsLineBreaks = CharacterSet(charactersIn: "\n\r")

    private static func paragraphIndexRefusal(_ key: String) -> String {
        "`docs read`'s `\(key)` must be a positive 1-based paragraph number, at most \(officeDocsMaxParagraphIndex)."
    }

    /// **Bounded at BOTH layers, deliberately** — `docs.ts` carries the same ceiling so the refusal is
    /// immediate and specific, and this one is what actually makes the arithmetic total, because the
    /// daemon is not the only possible producer of a `panel_command` (`args` is
    /// `z.record(z.string(), z.unknown())` with only a byte cap). `Int(Double)` TRAPS outside `Int`'s
    /// range — the class that aborted Norma.app from `sheets insert_rows at:1e30` and again from
    /// `slides read slide:1e30`, both measured as SIGTRAPs. `docs.ts` did not exist during that
    /// sweep, so these two decoders are outside it by construction and are bounded on arrival rather
    /// than after a review. 1,000,000 is orders of magnitude past any real document's paragraph
    /// count, and keeps every downstream `- 1`, `min`, and slice bound total.
    static let officeDocsMaxParagraphIndex = 1_000_000

    /// How much document text one `docs read` may return. Mirrors `officeReadRangeMaxCells`'
    /// discipline for `sheets`: a declared ceiling, enforced app-side (the engine has none — research
    /// §3.6), refused rather than truncated, and **named in the refusal along with the operands that
    /// work around it**. 40,000 characters is roughly 6,000-7,000 words — far more than any single
    /// reasoning step needs, and comfortably under `sheetsResultMaxLength`'s 64 KiB wire belt even
    /// once the per-paragraph numbering prefix is added.
    static let officeDocsReadMaxCharacters = 40_000

    private static func paragraphIndex(_ args: [String: SessionEvent.JSONValue]?, _ key: String) -> Int? {
        guard case .number(let n)? = args?[key], n >= 1, n <= Double(officeDocsMaxParagraphIndex),
              n.truncatingRemainder(dividingBy: 1) == 0 else { return nil }
        return Int(n)
    }

    /// The SAME `\n` split `LOKBridge.docsParagraphCount` uses, and for the same reason: what `read`
    /// returns and what `info` counts must be one measurement, not two.
    private static func docsParagraphs(_ text: String) -> [String] {
        text.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
    }

    // MARK: - office-agent-tools T7: docs result formatting

    private static func formatDocsInfo(path: String, pages: Int, paragraphs: Int, characters: Int) -> String {
        let name = (path as NSString).lastPathComponent
        return "\(name): \(pages) page\(pages == 1 ? "" : "s"), \(paragraphs) "
            + "paragraph\(paragraphs == 1 ? "" : "s"), \(characters) character\(characters == 1 ? "" : "s"). "
            + "(The page count comes from the engine's own layout and can under-report on a document "
            + "nothing has displayed yet; the paragraph count is the number of paragraphs `read` "
            + "returns.)"
    }

    /// Paragraph numbers are shown because every `read` is addressable by them — a model that read
    /// paragraphs 1-3 needs to know what to ask for next without recounting. `sliced` distinguishes
    /// "this is the whole document" from "this is part of it", so a model never mistakes a slice for
    /// the whole thing.
    private static func formatDocsRead(path: String, paragraphs: [String], firstParagraph: Int,
                                       totalParagraphs: Int, sliced: Bool) -> String {
        let name = (path as NSString).lastPathComponent
        let last = firstParagraph + paragraphs.count - 1
        let header = sliced
            ? "\(name), paragraphs \(firstParagraph)-\(last) of \(totalParagraphs):"
            : "\(name), all \(totalParagraphs) paragraph\(totalParagraphs == 1 ? "" : "s"):"
        guard !paragraphs.isEmpty else { return "\(header) (nothing here)" }
        let body = paragraphs.enumerated()
            .map { "\(firstParagraph + $0.offset). \($0.element)" }
            .joined(separator: "\n")
        return "\(header)\n\(body)"
    }

    private static func formatDocsReplace(path: String, find: String, replaced: Int) -> String {
        let name = (path as NSString).lastPathComponent
        guard replaced > 0 else {
            // **"its text is unchanged", not "the document was not changed" — the second overclaims.**
            // Every `docs` write verb saves through the broker unconditionally (`OfficeAgentBroker`
            // rule 4 has no only-if-dirty branch), so even a zero-match replace re-serializes the
            // whole ODF/OOXML package: the file's bytes and mtime DO change. What is true, and what
            // a caller actually needs, is that the document's own text is identical — which is
            // exactly what `testLiveDocsReplaceIsCaseSensitiveAndAWrongCaseSearchChangesNothing`
            // asserts (it originally asserted byte-equality and failed for this reason).
            return "nothing to replace in \(name) — \"\(brief(find))\" does not appear in it "
                + "(the search is literal and case-sensitive). The document's text is unchanged "
                + "(the file itself was still re-saved, as every write verb does)."
        }
        return "replaced \(replaced) occurrence\(replaced == 1 ? "" : "s") of \"\(brief(find))\" in \(name)"
    }

    private static func formatDocsInsert(path: String, isAppend: Bool, atStart: Bool, paragraphs: Int) -> String {
        let name = (path as NSString).lastPathComponent
        let where_ = isAppend ? "appended as a new paragraph at the end of" : (atStart ? "inserted at the start of" : "inserted at the end of")
        return "\(where_) \(name) — it now has \(paragraphs) paragraph\(paragraphs == 1 ? "" : "s")"
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

    private static let requiredSlideRefusal = "this office verb needs a `slide` (1-based, at most "
        + "\(officeSlideMaxIndex))."
    private static let requiredToRefusal = "`slides reorder` needs a `to` (1-based, at most "
        + "\(officeSlideMaxIndex))."
    private static let requiredAtRefusal = "`slides add_slide`'s `at` must be a positive 1-based "
        + "position, at most \(officeSlideMaxIndex) — omit it entirely to append at the end."
    private static let invalidLayoutRefusal = "`slides add_slide`'s `layout` must be one of the "
        + "documented layout presets (see the `slides` tool description) — omit it entirely to use "
        + "the default layout."
    private static let requiredSetTextAttributeRefusal =
        "`slides set_text` needs at least one of `title`, `body` — an absent key means \"leave "
        + "alone,\" so a call naming neither would do nothing."

    /// A positive, whole 1-based index — `slide`/`at`/`to`, all sharing this SAME shape.
    ///
    /// **T5 fix-round RE-REVIEW, new Critical — this was the fifth door of the class the fix round
    /// declared swept, and its own doc comment asserted the safety property it did not have.** The
    /// original said it was "mirroring `requiredCount`'s identical discipline … never trusting the
    /// daemon's validation as the only gate." That sentence became false the moment `requiredCount`
    /// four lines up gained a ceiling and this did not: `Int(Double)` TRAPS outside `Int`'s range,
    /// the daemon's `z.number().int().positive()` is not a bound (`Number.isInteger(1e30)` is
    /// `true`), and `slides read path:"<in-fence>.pptx" slide:1e30` therefore aborted Norma.app —
    /// from five live handlers (`read`/`set_text`/`delete_slide`/`reorder`/`add_slide`). A comment
    /// claiming a guard is not a guard; the ceiling below is.
    ///
    /// `officeSlideMaxIndex` mirrors `slides.ts`'s own `.max(10_000)` deliberately, the same
    /// two-sided arrangement `officeResizeMaxCount`/`officeResizeMaxAt` hold for `sheets`: the
    /// daemon's copy makes the refusal immediate and specific, this one is what actually makes the
    /// conversion total, because the daemon is not the only possible producer of a `panel_command`.
    /// 10,000 is orders of magnitude past any real deck, so it refuses nothing anyone wants, and it
    /// keeps every `slide`/`at`/`to` arithmetic downstream (`$0 - 1`, the helper's own
    /// `slide < partCount` bound) total by construction.
    static let officeSlideMaxIndex = 10_000

    /// office-finish Job 2 — the app-side mirror of `sheets.ts`'s own `name`/`newName` `.max(256)`.
    /// Same two-layer arrangement as `officeSlideMaxIndex` above and for the same stated reason: the
    /// daemon's copy makes the refusal immediate and specific, this one is what makes it TRUE, since
    /// the daemon is not the only possible producer of a `panel_command`. Unlike the numeric bounds
    /// nothing here traps — a long name is a byte-budget and result-cap concern, not a crash — which
    /// is exactly why it is worth writing down rather than assuming somebody upstream did it.
    static let officeSheetNameMaxLength = 256

    /// **T5 round-2 re-review (Important) — "present but undecodable" as a first-class case, for
    /// EVERY type arm rather than just the numeric one.**
    ///
    /// The round-2 fix for `add_slide`'s silent append was gated on `if case .number?`, which closed
    /// exactly one arm: `at:"3"` (a STRING) still walked past it into "absent" and appended
    /// silently — `ok=true`, no position, the model told it succeeded. The same collapse is
    /// structural for every OPTIONAL operand, because every decoder in this file answers a wrong
    /// TYPE and an ABSENT key with the same `nil`.
    ///
    /// It is daemon-unreachable — zod refuses a string `at` — **and that is precisely the reasoning
    /// this fix round has now condemned twice.** The app-side guard exists because the daemon is not
    /// the only possible producer of a `panel_command`: `args` is `z.record(z.string(),
    /// z.unknown())` with only a byte cap, so nothing between a tool's own schema and this file
    /// constrains a value at all. A guard whose stated threat model is "not only the daemon" that
    /// then only defends the daemon's own shapes is not a guard.
    ///
    /// `.null` counts as ABSENT, deliberately: an explicit JSON null is how a caller says "not
    /// provided," and refusing it would make `{"at": null}` behave differently from omitting `at`
    /// for no reason a caller could predict.
    private static func isPresent(_ args: [String: SessionEvent.JSONValue]?, _ key: String) -> Bool {
        guard let value = args?[key] else { return false }
        if case .null = value { return false }
        return true
    }

    private static func oneBasedIndex(_ args: [String: SessionEvent.JSONValue]?, _ key: String) -> Int? {
        guard case .number(let n)? = args?[key], n >= 1, n <= Double(officeSlideMaxIndex),
              n.truncatingRemainder(dividingBy: 1) == 0 else { return nil }
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
    /// F3. Names the legal set, the way every other closed-enum refusal in this file does — a model
    /// that sent `centre` needs to be told `center` exists, not merely that it was wrong.
    private static var invalidAlignRefusal: String {
        "`align` must be one of " + OfficeSheetsAlign.allCases.map { "`\($0.rawValue)`" }.joined(separator: ", ") + "."
    }
    /// F3, `numberFormat`'s half. The preset set is closed by ratified ruling (spec §2 — a free-form
    /// format code is a mini-language whose failure modes land in the user's saved file), so naming
    /// the members is the only way a caller can correct itself.
    private static var invalidNumberFormatRefusal: String {
        "`numberFormat` must be one of "
            + OfficeSheetsNumberFormatPreset.allCases.map { "`\($0.rawValue)`" }.joined(separator: ", ") + "."
    }
    // MARK: - office-format: operand decoders and refusals

    private static func optionalDocsAlign(_ args: [String: SessionEvent.JSONValue]?) -> OfficeDocsAlign? {
        guard case .string(let raw)? = args?["align"] else { return nil }
        return OfficeDocsAlign(rawValue: raw)
    }
    private static func optionalDocsLineSpacing(_ args: [String: SessionEvent.JSONValue]?) -> OfficeDocsLineSpacing? {
        guard case .string(let raw)? = args?["lineSpacing"] else { return nil }
        return OfficeDocsLineSpacing(rawValue: raw)
    }
    /// **`OfficeSlidesLineSpacing`, deliberately not `OfficeDocsLineSpacing`.** The slides set has
    /// three members; `1.15` is absent because Impress binds no such slot. Decoding a slide's
    /// spacing through the docs enum would accept `1.15` and then silently no-op.
    private static func optionalSlidesLineSpacing(_ args: [String: SessionEvent.JSONValue]?) -> OfficeSlidesLineSpacing? {
        guard case .string(let raw)? = args?["lineSpacing"] else { return nil }
        return OfficeSlidesLineSpacing(rawValue: raw)
    }
    private static func optionalDocsStyle(_ args: [String: SessionEvent.JSONValue]?) -> OfficeDocsParagraphStyle? {
        guard case .string(let raw)? = args?["style"] else { return nil }
        return OfficeDocsParagraphStyle(rawValue: raw)
    }

    /// Names the legal set — the same posture every other closed-enum refusal in this file takes. A
    /// caller that sent `centre` needs to learn `center` exists, not merely that it was wrong.
    private static func invalidDocsOperandRefusal(_ key: String) -> String {
        let members: [String]
        switch key {
        case "align": members = OfficeDocsAlign.allCases.map(\.rawValue)
        case "lineSpacing": members = OfficeDocsLineSpacing.allCases.map(\.rawValue)
        case "style": members = OfficeDocsParagraphStyle.allCases.map(\.rawValue)
        default:
            // The three booleans. **Their refusal spells out the consequence** rather than just the
            // type, because the engine's behaviour here is genuinely surprising: the underlying slot
            // never rejects a bad value, it coerces it — so a `"true"` STRING would not fail, it
            // would turn the attribute OFF while reporting success.
            return "`\(key)` must be true or false (a boolean, not a string) — a quoted \"true\" would "
                + "be read by the office engine as false and would turn \(key) OFF. Nothing was changed."
        }
        return "`\(key)` must be one of " + members.map { "`\($0)`" }.joined(separator: ", ") + "."
    }
    private static let invalidDocsFindRefusal =
        "`docs format`'s `find` must be a non-empty string — the literal text to format. Leave it out "
        + "entirely to format the whole document."
    private static let multilineFormatFindRefusal =
        "`docs format`'s `find` cannot contain a line break — the office engine's search never matches "
        + "across a paragraph boundary, so it would silently find nothing. Format one paragraph's "
        + "worth of text at a time."
    private static let requiredDocsFormatAttributeRefusal =
        "`docs format` needs at least one of `bold`, `italic`, `underline`, `align`, `lineSpacing`, "
        + "`style` — it has nothing to do otherwise. Nothing was changed."
    private static let requiredSlidesFormatAttributeRefusal =
        "`slides format` needs at least one of `bold`, `italic`, `underline`, `align`, `lineSpacing` — "
        + "it has nothing to do otherwise. Nothing was changed."
    private static let requiredPlaceholderRefusal =
        "`slides format` needs a `placeholder` — either `title` or `body`. Slides have no other "
        + "addressable text."
    /// `1.15` gets its own sentence because it is a LEGAL value on `docs` and simply does not exist
    /// on a slide — the engine binds no such slot for Impress. A model that just used it on a
    /// document needs the reason, not a generic list.
    private static let slidesLineSpacing115Refusal =
        "`slides format` has no `1.15` line spacing — LibreOffice's presentation editor only offers "
        + "`single`, `1.5` and `double`. (`docs format` does have `1.15`; this is a real difference "
        + "between the two editors, not a Norma limitation.)"
    private static let slidesStyleUnsupportedRefusal =
        "`slides format` has no `style` — paragraph styles like `heading1` are a text-document "
        + "feature. A presentation's own \"styles\" are outline levels, which are a different thing "
        + "and are not exposed here. Use `bold`/`italic`/`underline`/`align`/`lineSpacing` instead."

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
    /// office-polish final check, Critical — `displayRestoreVerified` is the ONE thing this
    /// formatter says that is not about the cells. A `formulas: true` read flips Calc's
    /// document-wide Show Formulas mode on and back; when the helper could not CONFIRM it put the
    /// mode back (see `LOKBridge.restoreFormulaDisplayOnDedicatedThread`), every LATER read of this
    /// document may answer formula SOURCE where a value was asked for. Being handed source as if it
    /// were a value, silently, is the whole defect — so the model is told, in the reply itself,
    /// rather than in a log nobody reads. The line is appended, never substituted for the data: the
    /// rows this read returned are still correct, and suppressing them would trade one wrong answer
    /// for another.
    ///
    /// **Returned as two pieces, and that split is the fix for a real defect** (office-polish blind
    /// check, Important). The warning used to be concatenated here, and `capped()` runs AFTER this
    /// function at the call site — so an OVERSIZED unverified read had its whole string, warning
    /// included, replaced by the refusal sentence: the one path where the model most needed telling
    /// was the one path where it was told nothing at all. Handing the caller the body and the
    /// warning separately lets it cap the BODY and then append the warning, so the refusal carries
    /// it too. The existing over-cap test pinned this path with `verified: true`, which is exactly
    /// why the interaction survived two rounds — a test that covers the path but not the case.
    ///
    /// The warning fires whenever the restore was not VERIFIED, which includes documents that have
    /// no formulas anywhere for the probe to see. On such a document its literal claim cannot come
    /// true (a workbook with no formulas cannot return formula source), so the warning errs toward
    /// noise, never toward silence — the correct direction for a check that cannot see.
    private static func formatSheetsRead(sheet: String, range: String, formulas: Bool, rows: [[String]],
                                         displayRestoreVerified: Bool) -> (body: String, warning: String) {
        let header = "\(sheet)!\(range) (\(formulas ? "formulas" : "values")):"
        let warning = displayRestoreVerified ? "" : "\n(Norma could not confirm it restored this "
            + "workbook's Show Formulas display mode after this read. These rows are correct, but a "
            + "later read of this workbook may return formula source where a value is expected — "
            + "reopen the file if a value ever comes back looking like \"=A1*2\".)"
        guard !rows.isEmpty else { return ("\(header) (nothing in this range)", warning) }
        let grid = rows.map { row in row.map(quotedIfNeededForTSV).joined(separator: "\t") }.joined(separator: "\n")
        return ("\(header)\n\(grid)", warning)
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

    // MARK: - office-finish Job 2: batch operand decoding

    /// office-finish Job 2 — decodes `args["ops"]`, the ONE nested operand these two batch verbs
    /// carry, into typed wire operations. `nil` means REFUSE THE WHOLE BATCH; the `String` is the
    /// refusal, and it **names the 1-based index of the offending operation** so the model does not
    /// have to bisect at 215 s a probe.
    ///
    /// ⚠️ **This function is a NEW INBOUND DECODE SURFACE, and it is invisible to the enumeration
    /// recipe that has kept this file's numeric operands safe.** That recipe (task-5-fixround-report
    /// §7.1 step 2) is "one grep, one file: `grep -nE 'args\?\[' OfficeCommandConsumer.swift`", and
    /// it is complete only while every operand is a TOP-LEVEL key. These operations' operands are
    /// read off the ELEMENT, so that grep finds `args?["ops"]` and nothing inside it. The re-scoped
    /// enumeration is recorded in `.superpowers/research/office-finish-report.md`; the rule it
    /// produces, stated here where the code is:
    ///
    ///  * every numeric element operand goes through `oneBasedElementIndex` below, which carries the
    ///    SAME `officeSlideMaxIndex` ceiling and the SAME integrality check `oneBasedIndex` applies
    ///    to a top-level key — never a bare `Int(...)`, which traps and aborts the app;
    ///  * a PRESENT-but-wrong-typed operand REFUSES, on every arm. It is never folded into "absent".
    ///    Folding is how `add_slide at:"3"` once silently appended and reported success — a wrong
    ///    answer the model was told to trust, which this project rates as worse than the crash it
    ///    replaced;
    ///  * an ABSENT operand is omitted from the constructed operation entirely, never carried
    ///    through as a null.
    private static func decodeSheetsOps(_ args: [String: SessionEvent.JSONValue]?)
        -> OfficeBatchDecode<[OfficeSheetsManageSheetOperation]> {
        return decodeOpsArray(args) { index, element in
            guard case .string(let opRaw)? = element["op"] else {
                return .refuse("operation \(index) needs an `op` of \"add_sheet\", \"delete_sheet\" or \"rename_sheet\".")
            }
            let op: OfficeSheetsManageSheetOp
            switch opRaw {
            case "add_sheet": op = .add
            case "delete_sheet": op = .delete
            case "rename_sheet": op = .rename
            default:
                return .refuse("operation \(index) has an unknown `op` \"\(opRaw)\" — use \"add_sheet\", "
                                + "\"delete_sheet\" or \"rename_sheet\".")
            }
            guard case .string(let name)? = element["name"], !name.isEmpty,
                  name.count <= officeSheetNameMaxLength else {
                return .refuse("operation \(index) needs a `name` — a non-empty string of at most "
                                + "\(officeSheetNameMaxLength) characters.")
            }
            var newName: String?
            if op == .rename {
                guard case .string(let raw)? = element["newName"], !raw.isEmpty,
                      raw.count <= officeSheetNameMaxLength else {
                    return .refuse("operation \(index) is a rename_sheet and needs a `newName` — a non-empty "
                                    + "string of at most \(officeSheetNameMaxLength) characters.")
                }
                newName = raw
            } else if element["newName"] != nil, !isNull(element["newName"]) {
                return .refuse("operation \(index) is a \(opRaw) and must not carry `newName` — only "
                                + "rename_sheet uses it.")
            }
            return .ok(OfficeSheetsManageSheetOperation(op: op, name: name, newName: newName))
        }
    }

    /// office-finish Job 2 — the slides counterpart. Same rules, same index-naming refusals; see
    /// `decodeSheetsOps` above for the enumeration warning that governs both.
    private static func decodeSlidesOps(_ args: [String: SessionEvent.JSONValue]?)
        -> OfficeBatchDecode<[OfficeSlidesManagePageOperation]> {
        return decodeOpsArray(args) { index, element in
            guard case .string(let opRaw)? = element["op"] else {
                return .refuse("operation \(index) needs an `op` of \"add_slide\", \"delete_slide\" or \"reorder\".")
            }
            let op: OfficeSlidesManagePageOp
            switch opRaw {
            case "add_slide": op = .add
            case "delete_slide": op = .delete
            case "reorder": op = .reorder
            default:
                return .refuse("operation \(index) has an unknown `op` \"\(opRaw)\" — use \"add_slide\", "
                                + "\"delete_slide\" or \"reorder\".")
            }
            // Every one of these is present-then-refuse: a key that is there but not a whole number in
            // 1...officeSlideMaxIndex refuses, and is never read as absent.
            var slide: Int?
            var at: Int?
            var to: Int?
            for (key, sink) in [("slide", 0), ("at", 1), ("to", 2)] {
                guard isPresentElement(element, key) else { continue }
                guard let value = oneBasedElementIndex(element, key) else {
                    return .refuse("operation \(index)'s `\(key)` must be a whole slide number from 1 to "
                                    + "\(officeSlideMaxIndex).")
                }
                if sink == 0 { slide = value } else if sink == 1 { at = value } else { to = value }
            }
            var layout: OfficeSlidesLayoutPreset?
            if isPresentElement(element, "layout") {
                guard case .string(let raw)? = element["layout"],
                      let parsed = OfficeSlidesLayoutPreset(rawValue: raw) else {
                    return .refuse("operation \(index)'s `layout` is not one of the layouts add_slide accepts.")
                }
                layout = parsed
            }
            switch op {
            case .add:
                guard slide == nil, to == nil else {
                    return .refuse("operation \(index) is an add_slide — it takes `at` and `layout`, never "
                                    + "`slide` or `to`.")
                }
                return .ok(OfficeSlidesManagePageOperation(op: .add, slide: nil, at: at.map { $0 - 1 },
                                                                to: nil, layout: layout))
            case .delete:
                guard let slide, at == nil, to == nil, layout == nil else {
                    return .refuse("operation \(index) is a delete_slide — it needs `slide` and takes nothing else.")
                }
                return .ok(OfficeSlidesManagePageOperation(op: .delete, slide: slide - 1, at: nil,
                                                                to: nil, layout: nil))
            case .reorder:
                guard let slide, let to, at == nil, layout == nil else {
                    return .refuse("operation \(index) is a reorder — it needs `slide` and `to`, and takes "
                                    + "nothing else.")
                }
                return .ok(OfficeSlidesManagePageOperation(op: .reorder, slide: slide - 1, at: nil,
                                                                to: to - 1, layout: nil))
            }
        }
    }

    /// The shared shape check both decoders above sit on: `ops` must be a non-empty array of objects,
    /// no longer than `OfficeWireBatchLimits.maxOperationsPerBatch`. Every failure refuses the whole
    /// batch — a trimmed or partially-accepted batch of position-based operations silently means
    /// something other than what was asked.
    private static func decodeOpsArray<T>(
        _ args: [String: SessionEvent.JSONValue]?,
        _ element: (Int, [String: SessionEvent.JSONValue]) -> OfficeBatchDecode<T>
    ) -> OfficeBatchDecode<[T]> {
        guard case .array(let raw)? = args?["ops"] else {
            return .refuse("this office batch verb needs `ops` — a list of operations to apply in order.")
        }
        guard !raw.isEmpty else {
            return .refuse("`ops` is empty — a batch with no operations would change nothing.")
        }
        guard raw.count <= OfficeWireBatchLimits.maxOperationsPerBatch else {
            return .refuse("`ops` has \(raw.count) operations — at most "
                            + "\(OfficeWireBatchLimits.maxOperationsPerBatch) fit in one call. Split it.")
        }
        var out: [T] = []
        out.reserveCapacity(raw.count)
        for (offset, entry) in raw.enumerated() {
            guard case .object(let object) = entry else {
                return .refuse("operation \(offset + 1) is not an object — every entry in `ops` must be "
                                + "an object with an `op`.")
            }
            switch element(offset + 1, object) {
            case .ok(let decoded): out.append(decoded)
            case .refuse(let reason): return .refuse(reason)
            }
        }
        return .ok(out)
    }

    private static func isNull(_ value: SessionEvent.JSONValue?) -> Bool {
        if case .null? = value { return true }
        return false
    }

    /// `isPresent`'s element-level twin — same "an explicit JSON `null` counts as ABSENT" rule, for
    /// the same reason (see `isPresent`'s own header).
    private static func isPresentElement(_ element: [String: SessionEvent.JSONValue], _ key: String) -> Bool {
        guard let value = element[key] else { return false }
        if case .null = value { return false }
        return true
    }

    /// `oneBasedIndex`'s element-level twin, and it must stay byte-for-byte the same predicate: a
    /// whole number in `1...officeSlideMaxIndex`. The ceiling is what stops `Int(n)` from trapping —
    /// `1e30` is an "integer" to `Double` and aborts the app plus every open document's unsaved edits
    /// on the way through `Int(...)`.
    private static func oneBasedElementIndex(_ element: [String: SessionEvent.JSONValue], _ key: String) -> Int? {
        guard case .number(let n)? = element[key], n >= 1, n <= Double(officeSlideMaxIndex),
              n.truncatingRemainder(dividingBy: 1) == 0 else { return nil }
        return Int(n)
    }

    private static func formatSheetsManageSheet(path: String, sheets: [String]) -> String {
        let name = (path as NSString).lastPathComponent
        return "\(sheets.count) sheet\(sheets.count == 1 ? "" : "s") in \(name): \(sheets.joined(separator: ", "))"
    }

    /// **Whole-branch review F1 addendum — this used to say "applied", over a helper contract that
    /// explicitly is not a claim of effect.** `sheetsFormatOnDedicatedThread` returns which attribute
    /// NAMES were reached, "posted", the same posture `keyEventOk`/`undoOk` hold to — no formatting
    /// attribute is read back anywhere on this path. Rendering that as "applied" told the model a
    /// stronger thing than the layer below it knows, which is the description-contradicting-code
    /// class this arc has now hit repeatedly. `set` may say "wrote" because it verifies position and
    /// re-reads; `format` may not.
    ///
    /// Deliberately still names the attributes and the range: the smallest useful truth is what was
    /// REQUESTED and where, plus an honest note that it was not confirmed — not a vaguer sentence
    /// that also drops the useful part. The word "saved" IS earned: rule 4's save-through awaits a
    /// real `.saved` outcome before this string is ever built.
    private static func formatSheetsFormat(path: String, sheet: String, range: String, applied: [String]) -> String {
        let name = (path as NSString).lastPathComponent
        return "set \(applied.joined(separator: ", ")) on \(sheet)!\(range) in \(name) and saved. "
            + "Norma posts formatting to LibreOffice without reading it back, so this reports what was "
            + "requested, not a confirmed result — re-read the range if you need to be sure."
    }

    // MARK: - office-format: the two formatting verbs

    /// `office.docs.format` — paragraph/character attributes over the whole document, or over every
    /// literal occurrence of `find`.
    ///
    /// **Every closed enum answers a PRESENT-but-undecodable value with a refusal that names the
    /// legal set, before any of them is read.** This is the third ruling on that shape in this arc:
    /// an enum that collapses a wrong value to `nil` is indistinguishable from "absent", so paired
    /// with any other attribute it SUCCEEDS, reports the others, and drops the one the caller asked
    /// for — the model is told its request worked and it did not happen. Checked for every key up
    /// front so the refusal names the operand actually got wrong, not whichever decodes first.
    private func handleDocsFormat(_ command: SessionEvent.PanelCommand) async {
        guard let path = Self.requiredPath(command.args) else {
            return sendResult(command.sessionId, command.commandId, false, Self.requiredPathRefusal, nil)
        }
        // **Every optional operand, not just the enums.** A decoder that collapses a wrong-typed
        // value to `nil` makes it indistinguishable from ABSENT, and paired with a valid attribute
        // the at-least-one guard below is satisfied: the call SUCCEEDS, applies the valid one, and
        // silently drops the one the caller got wrong. Third occurrence of that shape in this arc —
        // and the first version of THIS function reproduced it, covering the enums and leaving the
        // three booleans out (caught red by
        // `testLiveDocsFormatRefusesAMistypedBoldEvenWhenPairedWithAValidAttribute`, which returned
        // ok with "set align ... Confirmed" while bold vanished).
        //
        // Checked for every key BEFORE any of them is read, so the refusal names the operand the
        // caller actually got wrong rather than whichever one happens to decode first.
        for key in ["align", "lineSpacing", "style", "bold", "italic", "underline"]
        where Self.isPresent(command.args, key) {
            let decoded: Bool
            switch key {
            case "align": decoded = Self.optionalDocsAlign(command.args) != nil
            case "lineSpacing": decoded = Self.optionalDocsLineSpacing(command.args) != nil
            case "style": decoded = Self.optionalDocsStyle(command.args) != nil
            default: decoded = Self.optionalBool(command.args, key) != nil
            }
            guard decoded else {
                return sendResult(command.sessionId, command.commandId, false,
                                  Self.invalidDocsOperandRefusal(key), nil)
            }
        }
        // `find` present but not a string, or empty, is a REFUSAL — never silently "the whole
        // document". The difference between those two readings is one paragraph versus every
        // paragraph in the user's saved file.
        var find: String?
        if Self.isPresent(command.args, "find") {
            guard case .string(let raw)? = command.args?["find"], !raw.isEmpty else {
                return sendResult(command.sessionId, command.commandId, false, Self.invalidDocsFindRefusal, nil)
            }
            guard raw.rangeOfCharacter(from: Self.docsLineBreaks) == nil else {
                return sendResult(command.sessionId, command.commandId, false, Self.multilineFormatFindRefusal, nil)
            }
            find = raw
        }
        let align = Self.optionalDocsAlign(command.args)
        let lineSpacing = Self.optionalDocsLineSpacing(command.args)
        let style = Self.optionalDocsStyle(command.args)
        let bold = Self.optionalBool(command.args, "bold")
        let italic = Self.optionalBool(command.args, "italic")
        let underline = Self.optionalBool(command.args, "underline")
        guard align != nil || lineSpacing != nil || style != nil
                || bold != nil || italic != nil || underline != nil else {
            return sendResult(command.sessionId, command.commandId, false, Self.requiredDocsFormatAttributeRefusal, nil)
        }
        guard let broker = officeAgentBroker(command.sessionId) else {
            return sendResult(command.sessionId, command.commandId, false, Self.hostGoneRefusal, nil)
        }
        do {
            let resultText = try await broker.perform(
                sessionId: command.sessionId, path: path, access: .write, requestId: command.commandId
            ) { runtime, docId, _ in
                let outcome = try await runtime.docsFormat(docId: docId, find: find, align: align,
                                                            lineSpacing: lineSpacing, bold: bold, italic: italic,
                                                            underline: underline, style: style)
                return Self.formatDocsFormat(path: path, find: find, applied: outcome.applied,
                                             verified: outcome.verified, verifyAvailable: outcome.verifyAvailable,
                                             occurrences: outcome.occurrences)
            }
            let (ok, text) = Self.capped(resultText)
            sendResult(command.sessionId, command.commandId, ok, text, nil)
        } catch {
            sendResult(command.sessionId, command.commandId, false, Self.message(for: error), nil)
        }
    }

    /// `office.slides.format` — the same attributes on ONE slide's title or body placeholder.
    ///
    /// **`slide` is the numeric operand in the class that has aborted this app twice.** `Int(Double)`
    /// TRAPS outside `Int`'s range and a trap takes Norma.app down with every open document's unsaved
    /// edits; `sheets insert_rows at:1e30` and `slides read slide:1e30` were both measured as
    /// SIGTRAPs. `oneBasedIndex` bounds it on arrival — and it is bounded HERE as well as in
    /// `slides.ts` because the daemon is not the only possible producer of a `panel_command`.
    private func handleSlidesFormat(_ command: SessionEvent.PanelCommand) async {
        guard let path = Self.requiredPath(command.args) else {
            return sendResult(command.sessionId, command.commandId, false, Self.requiredPathRefusal, nil)
        }
        guard let slide = Self.oneBasedIndex(command.args, "slide") else {
            return sendResult(command.sessionId, command.commandId, false, Self.requiredSlideRefusal, nil)
        }
        guard let placeholderRaw = Self.optionalString(command.args, "placeholder"),
              let placeholder = OfficeSlidesPlaceholder(rawValue: placeholderRaw) else {
            return sendResult(command.sessionId, command.commandId, false, Self.requiredPlaceholderRefusal, nil)
        }
        // Same rule as `handleDocsFormat`, and for the same reason — see its own comment.
        for key in ["align", "lineSpacing", "bold", "italic", "underline"]
        where Self.isPresent(command.args, key) {
            let decoded: Bool
            switch key {
            case "align": decoded = Self.optionalDocsAlign(command.args) != nil
            case "lineSpacing": decoded = Self.optionalSlidesLineSpacing(command.args) != nil
            default: decoded = Self.optionalBool(command.args, key) != nil
            }
            guard decoded else {
                // `lineSpacing: "1.15"` gets its OWN sentence rather than the generic one: it is a
                // legal value on `docs` and simply does not exist on a slide, and a model that just
                // used it successfully on a document needs to be told WHY, not merely that it is
                // wrong. Impress binds no `SID_ATTR_PARA_LINESPACE_115` slot at all.
                if key == "lineSpacing",
                   Self.optionalString(command.args, "lineSpacing") == OfficeSlidesLineSpacing.unavailableOnSlides {
                    return sendResult(command.sessionId, command.commandId, false,
                                      Self.slidesLineSpacing115Refusal, nil)
                }
                return sendResult(command.sessionId, command.commandId, false,
                                  Self.invalidDocsOperandRefusal(key), nil)
            }
        }
        // `style` is not a slides operand at all — Impress's own SID_STYLE_APPLY is presentation
        // OUTLINE LEVELS, a different feature wearing the same name. Refused rather than ignored:
        // ignoring it would report success for a request that did nothing.
        if Self.isPresent(command.args, "style") {
            return sendResult(command.sessionId, command.commandId, false, Self.slidesStyleUnsupportedRefusal, nil)
        }
        let align = Self.optionalDocsAlign(command.args)
        let lineSpacing = Self.optionalSlidesLineSpacing(command.args)
        let bold = Self.optionalBool(command.args, "bold")
        let italic = Self.optionalBool(command.args, "italic")
        let underline = Self.optionalBool(command.args, "underline")
        guard align != nil || lineSpacing != nil || bold != nil || italic != nil || underline != nil else {
            return sendResult(command.sessionId, command.commandId, false,
                              Self.requiredSlidesFormatAttributeRefusal, nil)
        }
        guard let broker = officeAgentBroker(command.sessionId) else {
            return sendResult(command.sessionId, command.commandId, false, Self.hostGoneRefusal, nil)
        }
        do {
            let resultText = try await broker.perform(
                sessionId: command.sessionId, path: path, access: .write, requestId: command.commandId
            ) { runtime, docId, _ in
                // 0-based on the wire, 1-based to the model — the same conversion every other slides
                // verb performs at exactly this seam.
                let applied = try await runtime.slidesFormat(docId: docId, slide: slide - 1,
                                                              placeholder: placeholder, align: align,
                                                              lineSpacing: lineSpacing, bold: bold,
                                                              italic: italic, underline: underline)
                return Self.formatSlidesFormat(path: path, slide: slide, placeholder: placeholder, applied: applied)
            }
            let (ok, text) = Self.capped(resultText)
            sendResult(command.sessionId, command.commandId, ok, text, nil)
        } catch {
            sendResult(command.sessionId, command.commandId, false, Self.message(for: error), nil)
        }
    }

    // MARK: - office-format: result formatting

    /// **The sentence a model reads, and it must not overclaim.** Three distinguishable states, and
    /// collapsing them is exactly the overclaim this arc keeps shipping:
    ///  - some attributes CONFIRMED by re-reading the formatted range back out of the engine — the
    ///    house standard, and more than `sheets format` can offer;
    ///  - dispatched but NOT confirmed, because the read-back itself was unavailable — the outcome is
    ///    UNKNOWN, and the sentence says "could not check", never "failed";
    ///  - dispatched, read-back available, and an attribute did NOT show up — reported as not
    ///    confirmed, so the model can re-read rather than trust it.
    private static func formatDocsFormat(path: String, find: String?, applied: [String], verified: [String],
                                         verifyAvailable: Bool, occurrences: Int) -> String {
        let name = (path as NSString).lastPathComponent
        let target = find.map { "\(occurrences) occurrence\(occurrences == 1 ? "" : "s") of \"\(brief($0))\"" }
            ?? "the whole document"
        var sentence = "set \(applied.joined(separator: ", ")) on \(target) in \(name) and saved."
        if !verifyAvailable {
            sentence += " Norma could not read the formatting back afterwards, so this reports what was "
                + "requested rather than a confirmed result — the change may well have landed; re-read "
                + "the document if you need to be sure."
        } else {
            let unconfirmed = applied.filter { !verified.contains($0) }
            if verified.isEmpty {
                sentence += " Norma read the text back afterwards and could not confirm any of it — "
                    + "re-read the document before relying on this."
            } else {
                // **The claim is EXISTENTIAL and the sentence says so.** The check asks whether the
                // attribute appears in the re-read range, which over N matched occurrences means
                // "at least one of them" — never "all N". Saying a bare "Confirmed" for a format
                // that reached 1 of 3 occurrences would be a false universal claim, so the count is
                // named whenever there is more than one occurrence to be wrong about.
                // **Every path is hedged, including — especially — the whole-document one.**
                // The first version gated the hedge on `find != nil && occurrences > 1`, which got
                // it exactly backwards: `find` is optional, so `{verb:"format", bold:true}` selects
                // the WHOLE DOCUMENT, and that broadest possible operation was the one making the
                // unqualified claim. The check is existential over whatever was selected, so the
                // wider the selection the weaker the guarantee, never the stronger.
                let scope: String
                if find == nil {
                    scope = "somewhere in the document (Norma checks that the formatting is present "
                        + "in what it re-read, not that it reached every paragraph)"
                } else if occurrences > 1 {
                    scope = "in at least one of the \(occurrences) occurrences (Norma cannot check "
                        + "each one separately)"
                } else {
                    scope = "in the text it re-read"
                }
                sentence += " Confirmed \(verified.joined(separator: ", ")) \(scope)."
                if !unconfirmed.isEmpty {
                    sentence += " \(unconfirmed.joined(separator: ", ")) could not be confirmed the "
                        + "same way (some attributes leave no readable trace, so this is not the "
                        + "same as failure)."
                }
            }
        }
        return sentence
    }

    /// Slides say **posted**, never applied — and the reason is structural, not caution: Impress's
    /// clipboard transferable registers no RTF flavour, so there is no read-back to check against on
    /// this side at all. Also discloses the whole-shape effect alignment has here, which Writer has
    /// no analogue for.
    private static func formatSlidesFormat(path: String, slide: Int, placeholder: OfficeSlidesPlaceholder,
                                           applied: [String]) -> String {
        let name = (path as NSString).lastPathComponent
        var sentence = "set \(applied.joined(separator: ", ")) on slide \(slide)'s \(placeholder.rawValue) "
            + "in \(name) and saved. Norma cannot read formatting back out of a presentation, so this "
            + "reports what was requested, not a confirmed result — reopen the slide if you need to be sure."
        if applied.contains("align") {
            sentence += " Note that aligning a placeholder's text also re-anchors the text box itself, "
                + "which is a whole-shape change."
        }
        return sentence
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
    /// Carries `formatSheetsRead`'s warning out of the broker's closure alongside the body it must
    /// be capped independently of. `@unchecked Sendable` is honest rather than lax: it is written
    /// exactly once, inside the closure, and read only after that closure has been awaited to
    /// completion — there is no concurrent access to protect against.
    private final class SheetsReadWarning: @unchecked Sendable {
        var text = ""
    }

    /// `reserving` — office-polish blind check, Important. Room held back for text the CALLER will
    /// append after this returns (today: the unverified-display-mode warning), so that capping the
    /// body and then re-attaching the warning still lands inside the same wire limit this belt
    /// exists to enforce. `0`, the default, leaves every other call site byte-identical.
    private static func capped(_ text: String, reserving reserved: Int = 0) -> (ok: Bool, text: String) {
        let sheetsResultMaxLength = Self.sheetsResultMaxLength - max(0, reserved)
        guard PanelURLPolicy.wireLength(text) > sheetsResultMaxLength else { return (true, text) }
        // Wording is deliberately family-neutral (T7): this belt is shared by `sheets`, `slides`
        // and `docs`, and the original text named only `sheets`' own operands ("a smaller range or
        // narrower columns"), which would be advice a `docs read` caller cannot act on. `docs read`
        // has its own, lower, operand-naming cap that fires first (`officeDocsReadMaxCharacters`);
        // this remains the last resort for a result no verb anticipated.
        return (false, "this read's own result would be \(PanelURLPolicy.wireLength(text)) characters, past "
                + "the \(sheetsResultMaxLength)-character wire limit — ask for less of the document "
                + "(a smaller range, fewer columns, or a narrower paragraph range).")
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
        if let partial = error as? OfficeBatchPartialFailure { return partial.message }
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

/// office-finish Job 2 — thrown out of a batch's `broker.perform` closure when some operations
/// applied and one did not.
///
/// **A throw, deliberately, and this is the load-bearing part of the whole batch design.**
/// `OfficeAgentBroker.runOnce` runs the closure and only THEN saves; a throw propagates out before
/// the save is ever reached, so a partially-applied batch cannot reach the disk. Returning a
/// "successful" result carrying the ledger would have saved the partial batch — the outcome
/// `OfficeCommandConsumer.handleSheetsSet`'s own ruling calls worse than a truthful refusal.
///
/// It carries a pre-composed sentence rather than structured fields because the one channel back to
/// the model is a single string (`PanelCommandOutcome` has a `result` arm and a `timeout` arm and no
/// partial-progress arm at all), so composing it anywhere later would only move the same work.
struct OfficeBatchPartialFailure: Error {
    let message: String
}

/// office-finish Job 2 — a decoded batch, or the refusal explaining why it was rejected.
///
/// A purpose-built two-case enum rather than `Result<T, String>`: `String` does not conform to
/// `Error`, and making a refusal into an `Error` just to reuse `Result` would push it toward being
/// THROWN, which is exactly wrong here. These refusals are answered synchronously through
/// `sendResult(ok: false, …)` **before the broker is ever entered** — nothing is opened, nothing is
/// dirtied, and no document lifecycle is touched by a malformed batch.
enum OfficeBatchDecode<T> {
    case ok(T)
    case refuse(String)
}
